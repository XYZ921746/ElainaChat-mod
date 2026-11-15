//go:build !windows

package agent

// 非 Windows 没有 User Shell Folders 注册表： Roots 里跳过注册表候选，按目录名惯例猜。
func userShellFolders() map[string]string { return map[string]string{} }
