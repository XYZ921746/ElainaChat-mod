// Package activity 读「电脑在干什么」：前台窗口标题/文本、正在运行的进程，供桌宠模式
// 让 AI 知道用户在做什么。走 PowerShell 调 .NET 的 UIAutomation（Windows 自带，不新增依赖）。
//
// 安全边界：只读（不写操作、不启动程序）；路由层必须限制本机/已登录设备 ——
// 这是「用户在看什么」的隐私数据，绝不能经局域网匿名泄露。
package activity

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

const (
	MaxWindowText = 8000
	cmdTimeout    = 8 * time.Second
)

const (
	cacheTTLOK   = 10 * time.Second
	cacheTTLFail = 3 * time.Second
)

// Foreground 是当前前台窗口。
type Foreground struct {
	OK     bool   `json:"ok"`
	Title  string `json:"title,omitempty"`
	Text   string `json:"text,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// Process 是内存占用较高的一条进程。刻意不返回命令行参数：那里常有密钥与路径，
// 而判断「在用什么程序」只需要进程名。
type Process struct {
	Name  string  `json:"name"`
	MemMB float64 `json:"memMB"`
	Title string  `json:"title"`
}

// ProcessList 是进程列表结果。
type ProcessList struct {
	OK        bool      `json:"ok"`
	Processes []Process `json:"processes,omitempty"`
	Reason    string    `json:"reason,omitempty"`
}

// Summary 是给 AI 的主入口。
type Summary struct {
	OK         bool           `json:"ok"`
	Summary    string         `json:"summary,omitempty"`
	Foreground map[string]any `json:"foreground"`
	Processes  []Process      `json:"processes,omitempty"`
	Reason     string         `json:"reason,omitempty"`
}

const foregroundScript = `
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

    $sig = @'
using System;
using System.Runtime.InteropServices;
public class FgWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
    if (-not ('FgWin' -as [type])) { Add-Type -TypeDefinition $sig }

    $hwnd = [FgWin]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"reason":"拿不到前台窗口"}'; exit 0 }

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $root) { Write-Output '{"ok":false,"reason":"无法访问该窗口（可能权限不足）"}'; exit 0 }

    $title = ''
    try { $title = $root.Current.Name } catch {}

    $sb = New-Object System.Text.StringBuilder
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $maxChars = __MAX_TEXT__
    $maxDepth = 12
    $maxSiblings = 800

    function Collect($el, $depth) {
        if ($null -eq $el -or $depth -gt $maxDepth -or $sb.Length -ge $maxChars) { return }
        $name = $null
        try { $name = $el.Current.Name } catch {}
        if ($name -and $name.Trim().Length -gt 0) {
            if ($seen.Add($name)) { [void]$sb.AppendLine($name.Trim()) }
        }
        try {
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            $child = $walker.GetFirstChild($el)
            $n = 0
            while ($null -ne $child -and $n -lt $maxSiblings -and $sb.Length -lt $maxChars) {
                Collect $child ($depth + 1)
                $child = $walker.GetNextSibling($child)
                $n++
            }
        } catch {}
    }
    Collect $root 0

    $text = $sb.ToString()
    if ($text.Length -gt $maxChars) { $text = $text.Substring(0, $maxChars) }

    $out = [ordered]@{ ok = $true; title = $title; text = $text }
    ConvertTo-Json -InputObject $out -Compress -Depth 3
} catch {
    Write-Output ('{"ok":false,"reason":"' + ($_.Exception.Message -replace '"', "'") + '"}')
}
`

const processScript = `
$ErrorActionPreference = 'SilentlyContinue'
$list = Get-Process | Where-Object { $_.WorkingSet64 -gt 0 } |
    Sort-Object WorkingSet64 -Descending | Select-Object -First __LIMIT__ |
    ForEach-Object {
        [ordered]@{
            name  = $_.ProcessName
            memMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
            title = $(if ($_.MainWindowTitle) { $_.MainWindowTitle } else { '' })
        }
    }
ConvertTo-Json -InputObject @($list) -Compress -Depth 3
`

// ReadForeground 读当前前台窗口标题与可见文本。
func ReadForeground() Foreground {
	if runtime.GOOS != "windows" {
		return Foreground{OK: false, Reason: "仅支持 Windows（本机是 " + runtime.GOOS + "）"}
	}
	script := strings.ReplaceAll(foregroundScript, "__MAX_TEXT__", itoa(MaxWindowText))
	out := runPowerShell(script)
	if strings.TrimSpace(out) == "" {
		return Foreground{OK: false, Reason: "PowerShell 无输出（可能被安全策略拦截）"}
	}
	var parsed struct {
		OK     bool   `json:"ok"`
		Title  string `json:"title"`
		Text   string `json:"text"`
		Reason string `json:"reason"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(out)), &parsed) != nil {
		return Foreground{OK: false, Reason: "输出解析失败：" + clip(out, 120)}
	}
	if !parsed.OK {
		reason := parsed.Reason
		if reason == "" {
			reason = "未知错误"
		}
		return Foreground{OK: false, Reason: reason}
	}
	text := parsed.Text
	if len(text) > MaxWindowText {
		text = text[:MaxWindowText]
	}
	return Foreground{OK: true, Title: parsed.Title, Text: text}
}

// ListProcesses 按内存占用降序列出进程。
func ListProcesses(limit int) ProcessList {
	if runtime.GOOS != "windows" {
		return ProcessList{OK: false, Reason: "仅支持 Windows（本机是 " + runtime.GOOS + "）"}
	}
	if limit <= 0 {
		limit = 30
	}
	if limit > 100 {
		limit = 100
	}
	script := strings.ReplaceAll(processScript, "__LIMIT__", itoa(limit))
	out := runPowerShell(script)
	if strings.TrimSpace(out) == "" {
		return ProcessList{OK: false, Reason: "PowerShell 无输出"}
	}
	var raw []struct {
		Name  string  `json:"name"`
		MemMB float64 `json:"memMB"`
		Title string  `json:"title"`
	}
	text := strings.TrimSpace(out)
	if strings.HasPrefix(text, "{") {
		text = "[" + text + "]"
	}
	if json.Unmarshal([]byte(text), &raw) != nil {
		return ProcessList{OK: false, Reason: "输出解析失败：" + clip(out, 120)}
	}
	list := make([]Process, 0, len(raw))
	for _, p := range raw {
		title := p.Title
		if len(title) > 120 {
			title = title[:120]
		}
		list = append(list, Process{Name: p.Name, MemMB: p.MemMB, Title: title})
	}
	return ProcessList{OK: true, Processes: list}
}

type cacheEntry struct {
	at      time.Time
	value   any
	healthy bool
}

var (
	cacheMu sync.Mutex
	cache   = map[string]cacheEntry{}
)

func cachedValue(key string, ttlOK time.Duration, produce func() (any, bool)) any {
	cacheMu.Lock()
	hit, ok := cache[key]
	cacheMu.Unlock()
	now := time.Now()
	if ok {
		ttl := cacheTTLFail
		if hit.healthy {
			ttl = ttlOK
		}
		if now.Sub(hit.at) < ttl {
			return hit.value
		}
	}
	value, healthy := produce()
	cacheMu.Lock()
	cache[key] = cacheEntry{at: now, value: value, healthy: healthy}
	cacheMu.Unlock()
	return value
}

// ForegroundCached 带缓存读前台窗口。
func ForegroundCached(force bool) Foreground {
	key := "fg"
	if force {
		cacheMu.Lock()
		delete(cache, key)
		cacheMu.Unlock()
	}
	value := cachedValue(key, cacheTTLOK, func() (any, bool) {
		fg := ReadForeground()
		return fg, fg.OK
	})
	return value.(Foreground)
}

// ProcessesCached 带缓存列进程。
func ProcessesCached(limit int, force bool) ProcessList {
	key := "ps:" + itoa(limit)
	if force {
		cacheMu.Lock()
		delete(cache, key)
		cacheMu.Unlock()
	}
	value := cachedValue(key, cacheTTLOK, func() (any, bool) {
		ps := ListProcesses(limit)
		return ps, ps.OK
	})
	return value.(ProcessList)
}

// SummaryCached 是给提示词用的主入口：内部走上面两个缓存，
// 一轮对话里多处调用不会重复付 4 秒的代价。
func SummaryCached(force bool) Summary {
	if force {
		cacheMu.Lock()
		delete(cache, "fg")
		delete(cache, "sum")
		cacheMu.Unlock()
	}
	value := cachedValue("sum", cacheTTLOK, func() (any, bool) {
		fg := ForegroundCached(false)
		ps := ProcessesCached(20, false)
		if !fg.OK && !ps.OK {
			reason := fg.Reason
			if reason == "" {
				reason = ps.Reason
			}
			if reason == "" {
				reason = "无法读取"
			}
			return Summary{OK: false, Reason: reason}, false
		}
		lines := []string{}
		var fgView map[string]any
		if fg.OK {
			title := fg.Title
			if title == "" {
				title = "(无标题)"
			}
			lines = append(lines, "当前前台窗口："+title)
			body := strings.TrimSpace(fg.Text)
			if body != "" {
				lines = append(lines, "窗口内可见文本（截断）：\n"+clipRunes(body, 1200))
			}
			fgView = map[string]any{"title": fg.Title, "textLength": len(fg.Text)}
		}
		var processes []Process
		if ps.OK {
			noisy := map[string]bool{
				"svchost": true, "conhost": true, "dllhost": true, "RuntimeBroker": true,
				"SearchIndexer": true, "ctfmon": true, "Taskmgr": true,
			}
			top := make([]Process, 0, 12)
			for _, p := range ps.Processes {
				if noisy[p.Name] {
					continue
				}
				top = append(top, p)
				if len(top) >= 12 {
					break
				}
			}
			parts := make([]string, 0, len(top))
			for _, p := range top {
				parts = append(parts, p.Name+"("+formatMem(p.MemMB)+"MB)")
			}
			lines = append(lines, "占用内存较高的进程："+strings.Join(parts, "、"))
			processes = ps.Processes
		}
		return Summary{OK: true, Summary: strings.Join(lines, "\n"), Foreground: fgView, Processes: processes}, true
	})
	return value.(Summary)
}

func runPowerShell(script string) string {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = os.Environ()
	// 脚本派生的后台进程会握住输出管道，让 Output 在进程退出后仍无限等待；
	// WaitDelay 给这段等待一个上限。
	cmd.WaitDelay = 5 * time.Second
	raw, err := cmd.Output()
	if err != nil && len(raw) == 0 {
		// 失败不抛：这是「锦上添花」的能力，拿不到就返回空，让上层决定怎么提示。
		return ""
	}
	return decodeOutput(raw)
}

// decodeOutput：中文系统上 powershell 的输出编码取决于控制台代码页（GBK/936），
// 直接按 UTF-8 读会得到乱码 —— 先试 UTF-8，出现替换字符再退回 GBK。
func decodeOutput(raw []byte) string {
	text := string(raw)
	if utf8.ValidString(text) && !strings.ContainsRune(text, '\uFFFD') {
		return text
	}
	if decoded, err := simplifiedchinese.GBK.NewDecoder().Bytes(raw); err == nil {
		return string(decoded)
	}
	return text
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func formatMem(v float64) string {
	if v == float64(int64(v)) {
		return itoa(int(v))
	}
	// 保留一位小数，避免 strconv 引入额外的格式差异。
	whole := int64(v)
	frac := int64((v - float64(whole)) * 10)
	if frac < 0 {
		frac = -frac
	}
	return itoa(int(whole)) + "." + itoa(int(frac))
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func clipRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}
