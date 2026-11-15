//go:build windows

package plugin

import (
	"os/exec"
	"syscall"
)

// hideWindow 让插件命令不弹控制台窗口：宿主可能以无窗口方式启动，
// 插件每执行一条命令闪一次黑框既干扰也暴露"后台在跑什么"。
func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
}
