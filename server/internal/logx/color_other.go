//go:build !windows

package logx

import "os"

// consoleSupportsColor 用字符设备 + TERM 两个条件判断：管道/文件重定向时转义码只会变成噪音，
// TERM=dumb 则说明终端本身不认颜色。
func consoleSupportsColor() bool {
	info, err := os.Stdout.Stat()
	if err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	return os.Getenv("TERM") != "dumb"
}
