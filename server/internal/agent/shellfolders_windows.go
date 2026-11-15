//go:build windows

// 外壳文件夹（桌面/文档/下载…）的真实位置：用户可把桌面移到任意位置、OneDrive 也会重定向，
// 按惯例猜必然猜错；权威答案在注册表 HKCU\...\User Shell Folders。REG_EXPAND_SZ 存的是
// 含 %变量% 的原文，要自己展开；值名与数据都可能非 ASCII（中文系统是「桌面」），
// 注册表 API 直接给 UTF-16 → Go string，不经代码页，不碎字。

package agent

import (
	"os"
	"strings"
	"sync"

	"golang.org/x/sys/windows/registry"
)

var userShellFolders = sync.OnceValue(func() map[string]string {
	out := map[string]string{}
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`, registry.QUERY_VALUE)
	if err != nil {
		return out
	}
	defer k.Close()
	names, err := k.ReadValueNames(-1)
	if err != nil {
		return out
	}
	for _, name := range names {
		v, _, err := k.GetStringValue(name)
		if err != nil {
			continue
		}
		out[name] = expandWindowsEnv(v)
	}
	return out
})

// expandWindowsEnv 大小写不敏感地展开 %VAR%：注册表里的原文是 %USERPROFILE% 这类，
// os.ExpandEnv 只认 $VAR，所以自己来。展开不了的占位符原样保留。
func expandWindowsEnv(value string) string {
	env := make(map[string]string)
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i > 0 {
			env[strings.ToLower(kv[:i])] = kv[i+1:]
		}
	}
	return os.Expand(value, func(name string) string {
		return env[strings.ToLower(name)]
	})
}
