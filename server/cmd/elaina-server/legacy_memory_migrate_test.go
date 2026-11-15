package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"elainachat/server/internal/logx"
	"elainachat/server/internal/memoryindex"
	"elainachat/server/internal/store"
)

func openTestMemory(t *testing.T, dataDir string) *memoryindex.Store {
	t.Helper()
	index, err := memoryindex.Open(filepath.Join(dataDir, "main", "memory", "index.db"), logx.Discard())
	if err != nil {
		t.Fatalf("打开记忆库：%v", err)
	}
	t.Cleanup(index.Close)
	return index
}

func TestMigrateLegacyMemoryCoreImportsOnce(t *testing.T) {
	dataDir := t.TempDir()
	log := logx.Discard()
	dataStore := store.New(dataDir, log)
	core := `{"diary":[{"date":"2026年1月1日","content":"第一天"}],"promise":["约定"]}`
	value := core
	if _, err := dataStore.MergeAndSave(map[string]*string{store.MemoryKey: &value}); err != nil {
		t.Fatal(err)
	}
	index := openTestMemory(t, dataDir)
	migrateLegacyMemoryCore(dataStore, index, log)

	got, err := index.Core()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Diary) != 1 || len(got.Promise) != 1 {
		t.Fatalf("首次迁移应导入记忆：%+v", got)
	}
	if _, exists, _ := dataStore.LegacyMemoryJSON(); exists {
		t.Fatal("迁移成功后顶层类目文件应已归档")
	}
}

func TestMigrateLegacyMemoryCoreArchivesResidualWithoutReimport(t *testing.T) {
	dataDir := t.TempDir()
	log := logx.Discard()
	dataStore := store.New(dataDir, log)
	index := openTestMemory(t, dataDir)
	// 先导入一份权威数据并置标记，模拟已经迁移过的库。
	first := `{"diary":[{"date":"2026年1月1日","content":"权威日记"}],"promise":[]}`
	if _, err := index.ImportLegacyCore([]byte(first), true, "test"); err != nil {
		t.Fatal(err)
	}
	if err := index.MarkLegacyMigrated(); err != nil {
		t.Fatal(err)
	}
	// 再在 Store 里放一份“残留”旧值：内容不同，若被导入就会覆盖/复活。
	residual := `{"diary":[{"date":"2026年1月1日","content":"残留旧值"}],"promise":["不该复活"]}`
	value := residual
	if _, err := dataStore.MergeAndSave(map[string]*string{store.MemoryKey: &value}); err != nil {
		t.Fatal(err)
	}
	migrateLegacyMemoryCore(dataStore, index, log)

	got, err := index.Core()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Diary) != 1 || got.Diary[0].Content != "权威日记" {
		t.Fatalf("标记已置位后不应导入残留值：%+v", got)
	}
	if len(got.Promise) != 0 {
		t.Fatalf("残留的约定也不应复活：%+v", got.Promise)
	}
	if _, exists, _ := dataStore.LegacyMemoryJSON(); exists {
		t.Fatal("残留文件应被归档")
	}
	matches, _ := filepath.Glob(filepath.Join(dataDir, "main", "memory", "legacy-backup-*"))
	if len(matches) == 0 {
		t.Fatal("应留下 legacy-backup 归档")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "main", "store.json")); err != nil {
		t.Fatalf("store.json 应仍存在：%v", err)
	}
}

// 备份失败不能拦住迁移标记：标记不落的话，下次启动会拿旧 JSON 重灌 SQLite，
// 两次启动之间经 /api/memory 做过的编辑会被整份覆盖。
func TestFinishLegacyCoreImportMarksMigratedWhenBackupFails(t *testing.T) {
	dataDir := t.TempDir()
	log := logx.Discard()
	index := openTestMemory(t, dataDir)

	res, err := index.ImportLegacyCore([]byte(`{"diary":[{"date":"2026年1月1日","content":"已入库"}]}`), true, "test")
	if err != nil {
		t.Fatal(err)
	}
	finishLegacyCoreImport(index, func() (string, error) {
		return "", fmt.Errorf("rename: Access is denied")
	}, log, res)

	migrated, err := index.LegacyMigrated()
	if err != nil {
		t.Fatal(err)
	}
	if !migrated {
		t.Fatal("备份失败后迁移标记仍应置位，否则下次启动会重灌旧 JSON")
	}
}
