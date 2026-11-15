// Package pccmd 是 AI 执行本机命令的判定与执行层。
//
// 安全边界：危险命令必须先取得用户授权（由调用方强制），外部进程必须有超时与输出截断；
// 命令始终作为单个 argv 交给 shell，绝不拼进外层命令行 —— 拼接会让 `; rm -rf /`
// 逃出「这是一段脚本文本」的边界。
package pccmd

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const (
	Timeout   = 30 * time.Second
	MaxOutput = 20000
)

type Verdict struct {
	Risk    string   `json:"risk"`
	Reasons []string `json:"reasons"`
}

type Result struct {
	OK        bool   `json:"ok"`
	Code      *int   `json:"code"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	TimedOut  bool   `json:"timedOut"`
	Truncated bool   `json:"truncated"`
	Shell     string `json:"shell"`
}

type rule struct {
	re  *regexp.Regexp
	why string
}

var dangerousRules = []rule{
	{mustRe(`(?i)\b(rm|rmdir|del|erase|rd)\b`), "删除文件或目录"},
	{mustRe(`(?i)\bRemove-Item\b`), "删除文件或目录（PowerShell）"},
	{mustRe(`(?i)\b(Format-Volume|format)\b`), "格式化磁盘"},
	{mustRe(`(?i)\b(Clear-Content|Set-Content)\b`), "清空或覆盖文件内容"},
	{mustRe(`(?i)\b(truncate|shred|wipe)\b`), "销毁数据"},
	{mustRe(`(?i)\b(shutdown|Restart-Computer|Stop-Computer)\b`), "关机或重启电脑"},
	{mustRe(`(?i)\b(logoff|tsdiscon)\b`), "注销当前用户"},
	{mustRe(`(?i)\bStop-Process\b|\btaskkill\b|\bkill(all)?\b`), "强制结束进程"},
	{mustRe(`(?i)\b(runas|sudo|gsudo)\b`), "提权执行"},
	{mustRe(`(?i)\bnet\s+(user|localgroup)\b`), "增删用户或改用户组"},
	{mustRe(`(?i)\b(takeown|icacls|cacls|Set-Acl)\b`), "修改文件权限或所有权"},
	{mustRe(`(?i)\b(New-LocalUser|Add-LocalGroupMember|Set-LocalUser)\b`), "创建或修改本地账户"},
	{mustRe(`(?i)\breg\s+(add|delete|import|restore|copy|save)\b`), "修改注册表"},
	{mustRe(`(?i)\b(New-ItemProperty|Set-ItemProperty|Remove-ItemProperty)\b`), "修改注册表"},
	{mustRe(`(?i)\b(bcdedit|bootrec|diskpart)\b`), "修改启动配置或磁盘分区"},
	{mustRe(`(?i)\b(Set-ExecutionPolicy|sc\.exe|New-Service|Stop-Service|Start-Service)\b`), "修改执行策略或系统服务"},
	{mustRe(`(?i)\b(Invoke-WebRequest|Invoke-RestMethod|curl|wget|certutil|bitsadmin)\b`), "下载文件（可能被用于下载并执行）"},
	{mustRe(`(?i)\b(iex|Invoke-Expression|Start-Process)\b`), "动态执行代码或启动进程"},
	{mustRe(`(?i)\b(EncodedCommand|-enc\b|-e\s+[A-Za-z0-9+/=]{40,})`), "执行 Base64 编码的命令（常用于隐藏意图）"},
	{mustRe(`(?i)\|\s*(bash|sh|zsh|powershell|pwsh|cmd|iex|Invoke-Expression)\b`), "把内容通过管道直接交给解释器执行"},
	{mustRe(`(?i)\b(mkfs|fdisk|dd)\b`), "磁盘底层操作"},
	{mustRe(`(?i)\bchkdsk\b.*\/f`), "修复磁盘（会改动文件系统）"},
	{mustRe(`(?i)\b(netsh|ipconfig)\b.*\b(set|release|renew|reset)\b`), "修改网络配置"},
	{mustRe(`(?i)\broute\s+(add|delete)\b`), "修改路由表"},
}

// 重定向到系统关键路径不靠命令名判定：`echo x > C:\Windows\...` 用的全是无害命令。
var dangerousTarget = mustRe(`(?i)(?:>>?|Out-File|Set-Content|Add-Content)\s*['"]?([A-Za-z]:\\|\\\\|/(?:etc|bin|usr|boot|dev)/)`)

func mustRe(pattern string) *regexp.Regexp { return regexp.MustCompile(pattern) }

// Classify 返回风险级别与命中原因。safe 不等于「可以免确认」：
// strict 档每条都要确认，判风险只为 auto 档服务。
func Classify(command string) Verdict {
	text := strings.TrimSpace(command)
	if text == "" {
		return Verdict{Risk: "safe"}
	}
	reasons := []string{}
	seen := map[string]bool{}
	for _, r := range dangerousRules {
		if r.re.MatchString(text) && !seen[r.why] {
			seen[r.why] = true
			reasons = append(reasons, r.why)
		}
	}
	if dangerousTarget.MatchString(text) && !seen["把输出重定向到系统关键路径"] {
		reasons = append(reasons, "把输出重定向到系统关键路径")
	}
	risk := "safe"
	if len(reasons) > 0 {
		risk = "dangerous"
	}
	return Verdict{Risk: risk, Reasons: reasons}
}

func AvailableShells() []string {
	if runtime.GOOS == "windows" {
		return []string{"powershell", "cmd"}
	}
	return []string{"sh"}
}

func BuildArgv(shell, command string) (string, []string) {
	switch shell {
	case "cmd":
		return "cmd.exe", []string{"/d", "/s", "/c", "chcp 65001>nul & " + command}
	case "sh":
		return "sh", []string{"-c", command}
	default:
		// -NoProfile 避免加载用户 profile（里面可能有任意代码），-NonInteractive 避免等输入；
		// 编码设置包 try/catch，个别无控制台句柄的环境会抛异常，命令本身必须照常执行。
		return "powershell.exe", []string{
			"-NoProfile", "-NonInteractive", "-Command",
			`try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; ` + command,
		}
	}
}

func Run(command, shell, cwd string, timeout time.Duration) Result {
	shells := AvailableShells()
	selected := shells[0]
	for _, candidate := range shells {
		if candidate == shell {
			selected = candidate
			break
		}
	}
	if timeout <= 0 {
		timeout = Timeout
	}
	file, args := BuildArgv(selected, command)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, file, args...)
	cmd.Dir = cwd
	// 命令派生的后台孙进程会握住输出管道，进程退出后 Run 仍会等 io 拷贝结束；
	// WaitDelay 给这段等待一个上限，避免命令本身结束了却永不返回。
	cmd.WaitDelay = 5 * time.Second

	stdout := &limitedWriter{limit: MaxOutput}
	stderr := &limitedWriter{limit: MaxOutput}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	err := cmd.Run()
	result := Result{
		Shell:     selected,
		Stdout:    stdout.String(),
		Stderr:    stderr.String(),
		Truncated: stdout.truncated || stderr.truncated,
	}
	if ctx.Err() == context.DeadlineExceeded {
		result.TimedOut = true
		result.Stderr = strings.TrimSpace(result.Stderr)
		if result.Stderr == "" {
			result.Stderr = "命令超时，已被强制结束。"
		}
		return result
	}
	if err == nil {
		code := 0
		result.Code = &code
		result.OK = true
		return result
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		code := exitErr.ExitCode()
		result.Code = &code
		return result
	}
	result.Stderr = strings.TrimSpace(result.Stderr + "\n" + err.Error())
	return result
}

func FormatResult(result Result) string {
	lines := []string{"shell：" + result.Shell}
	if result.TimedOut {
		lines = append(lines, "⚠️ 命令超时，已被强制结束。")
	} else if result.Code == nil {
		lines = append(lines, "退出码：（无，进程被信号结束）")
	} else {
		lines = append(lines, fmt.Sprintf("退出码：%d", *result.Code))
	}
	if result.Stdout != "" {
		lines = append(lines, "", "--- 标准输出 ---", strings.TrimRight(result.Stdout, "\r\n"))
	}
	if result.Stderr != "" {
		lines = append(lines, "", "--- 标准错误 ---", strings.TrimRight(result.Stderr, "\r\n"))
	}
	if result.Stdout == "" && result.Stderr == "" {
		lines = append(lines, "", "（没有任何输出）")
	}
	return strings.Join(lines, "\n")
}

type limitedWriter struct {
	buf       strings.Builder
	limit     int
	truncated bool
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	remaining := w.limit - w.buf.Len()
	if remaining <= 0 {
		w.truncated = true
		return len(p), nil
	}
	if len(p) > remaining {
		w.buf.Write(p[:remaining])
		w.truncated = true
		return len(p), nil
	}
	w.buf.Write(p)
	return len(p), nil
}

func (w *limitedWriter) String() string {
	text := w.buf.String()
	if w.truncated {
		text += fmt.Sprintf("\n…（输出超过 %d 字符，已截断）", w.limit)
	}
	return text
}
