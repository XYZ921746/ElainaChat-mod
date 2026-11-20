package plugin

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func makePluginDirLink(t *testing.T, link, target string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err == nil {
			return
		} else if err := os.Symlink(target, link); err != nil {
			t.Skipf("无法创建目录链接：%v（%s）", err, out)
		}
		return
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("无法创建目录链接：%v", err)
	}
}

// ctx.fs 的边界是「插件目录」，不是「字符串前缀」：中间目录链接指向目录外时，
// 读、写、建目录、重命名、删除都必须拒绝。
func TestSafePathRejectsDirectoryLinkEscape(t *testing.T) {
	pluginDir := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	makePluginDirLink(t, filepath.Join(pluginDir, "linked"), outside)
	b := &ctxBuilder{dir: pluginDir}

	if _, err := b.safePath(filepath.Join("linked", "secret.txt")); err == nil {
		t.Error("读取经链接越界应被拒绝")
	}
	if _, err := b.safeWritePath(filepath.Join("linked", "new.txt")); err == nil {
		t.Error("经链接创建文件应被拒绝")
	}
	if _, err := b.safeWritePath(filepath.Join("linked", "sub", "new.txt")); err == nil {
		t.Error("经链接创建子目录文件应被拒绝")
	}
}

func TestSafePathAllowsPluginFilesAndNewNestedPaths(t *testing.T) {
	pluginDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(pluginDir, "data.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	b := &ctxBuilder{dir: pluginDir}
	if _, err := b.safePath("data.json"); err != nil {
		t.Errorf("插件内文件应放行：%v", err)
	}
	if _, err := b.safeWritePath(filepath.Join("uploads", "nested", "x.bin")); err != nil {
		t.Errorf("插件内新建目录应放行：%v", err)
	}
}
