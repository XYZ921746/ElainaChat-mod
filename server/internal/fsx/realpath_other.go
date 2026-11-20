//go:build !windows

package fsx

import "path/filepath"

// RealPath 解析符号链接。Windows 的目录联接走另一个实现：
// filepath.EvalSymlinks 在那里不会跟随 junction，安全判断会漏掉这类链接。
func RealPath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
