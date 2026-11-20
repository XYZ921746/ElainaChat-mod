//go:build windows

package fsx

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// RealPath 用句柄拿最终路径：Windows 的目录联接（junction）在 Lstat 里既不是
// 符号链接也不是目录链接，filepath.EvalSymlinks 不会跟随，只有句柄级解析可靠。
func RealPath(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	buf := make([]uint16, 1024)
	n, err := windows.GetFinalPathNameByHandle(windows.Handle(file.Fd()), &buf[0], uint32(len(buf)), 0)
	if err != nil {
		return "", err
	}
	resolved := windows.UTF16ToString(buf[:n])
	// 卷路径前缀 \\?\ 只用于绕过 MAX_PATH，不属于真实路径。UNC 形如 \\?\UNC\server\share：
	// 必须先去 UNC 前缀再加回 \\，否则先剥通用前缀会把 UNC 结果改写成相对路径 UNC\server\share。
	if strings.HasPrefix(resolved, `\\?\UNC\`) {
		resolved = `\\` + strings.TrimPrefix(resolved, `\\?\UNC\`)
	} else {
		resolved = strings.TrimPrefix(resolved, `\\?\`)
	}
	return filepath.Clean(resolved), nil
}
