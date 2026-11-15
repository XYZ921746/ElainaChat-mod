package plugin

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 扫描会在每个 /api/plugins 与 /mods/index.json 请求上跑，而安装可能正在写 .installing-*。
// 只清「陈旧」的才是安全做法：删掉新鲜的等于替并发安装删掉半成品。
func TestScanOnlyRemovesStaleInstallingDirs(t *testing.T) {
	mods := t.TempDir()
	fresh := filepath.Join(mods, ".installing-fresh")
	stale := filepath.Join(mods, ".installing-stale")
	for _, dir := range []string{fresh, stale} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * installStagingStaleAge)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}

	if _, err := Scan(mods); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("新鲜的安装目录被删掉了（并发安装会因此失败）：%v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("陈旧的安装目录没有被清理：%v", err)
	}
}
