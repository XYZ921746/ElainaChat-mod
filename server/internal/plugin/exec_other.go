//go:build !windows

package plugin

import "os/exec"

// hideWindow 在非 Windows 上没有对应概念，保留空实现让调用点不用分平台。
func hideWindow(cmd *exec.Cmd) {}
