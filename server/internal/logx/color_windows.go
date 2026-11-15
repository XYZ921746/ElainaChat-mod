//go:build windows

package logx

import (
	"os"
	"syscall"
)

// ENABLE_VIRTUAL_TERMINAL_PROCESSING：让 cmd.exe / conhost 解析 ANSI 转义码。
// 这个模式默认是关的，不开的话颜色码会以「←[32m」的形式糊在每一行前面。
const enableVirtualTerminalProcessing = 0x0004

var procSetConsoleMode = syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleMode")

// consoleSupportsColor 判断 stdout 是不是控制台；是控制台就顺手打开 VT 处理。
// 重定向到管道或文件时返回 false —— 那里的转义码只会变成噪音。
func consoleSupportsColor() bool {
	handle := syscall.Handle(os.Stdout.Fd())
	var mode uint32
	if err := syscall.GetConsoleMode(handle, &mode); err != nil {
		return false
	}
	if mode&enableVirtualTerminalProcessing != 0 {
		return true
	}
	ok, _, _ := procSetConsoleMode.Call(uintptr(handle), uintptr(mode|enableVirtualTerminalProcessing))
	return ok != 0
}
