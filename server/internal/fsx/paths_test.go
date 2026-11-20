package fsx

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// 目录联接是 Windows 上最容易被路径字符串检查漏掉的一种链接；没有权限建联接时
// 退到符号链接，仍不可用则只跳过链接子用例，纯词法判断始终运行。
func makeDirLink(t *testing.T, link, target string) {
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

func TestPathInsideUsesSegmentBoundary(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data")
	cases := []struct {
		target string
		want   bool
	}{
		{root, true},
		{filepath.Join(root, "config.json"), true},
		{filepath.Join(root, "..", "database", "x"), false},
		{root + "-other", false},
	}
	for _, tc := range cases {
		if got := PathInside(tc.target, root); got != tc.want {
			t.Errorf("PathInside(%q)=%v，应为 %v", tc.target, got, tc.want)
		}
	}
}

func TestExistingPathWithinRejectsIntermediateLink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	makeDirLink(t, filepath.Join(root, "linked"), outside)

	if _, err := ExistingPathWithin(filepath.Join(root, "linked", "secret.txt"), root); err == nil {
		t.Error("中间目录链接应被真实路径检查拒绝")
	}
}

func TestWritablePathWithinAllowsNewFileButNotLinkedParent(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := WritablePathWithin(filepath.Join(root, "new", "nested", "file.txt"), root); err != nil {
		t.Errorf("尚未存在的新文件应放行：%v", err)
	}
	makeDirLink(t, filepath.Join(root, "linked"), outside)
	if err := WritablePathWithin(filepath.Join(root, "linked", "new.txt"), root); err == nil {
		t.Error("经目录链接创建文件应被拒绝")
	}
}

func TestExistingDirectoryWithinRequiresDirectory(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ExistingDirectoryWithin(file, root); err == nil {
		t.Error("普通文件不应被当作工作目录")
	}
	if _, err := ExistingDirectoryWithin(root, root); err != nil {
		t.Errorf("根目录应放行：%v", err)
	}
}
