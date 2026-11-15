package store

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// 损坏的 store.json 不能静默当成「没有数据」：下一次 Save 会把空杂项表整份写回去，
// 设置与密钥就此消失。留证文件是唯一能手工恢复的出处。
func TestCorruptStoreFileIsQuarantined(t *testing.T) {
	dir := t.TempDir()
	mainDir := filepath.Join(dir, "main")
	if err := os.MkdirAll(mainDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mainDir, "store.json"), []byte("{not-json"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(dir, nil)
	if _, err := s.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	matches, _ := filepath.Glob(filepath.Join(mainDir, "store.json.bad-*"))
	if len(matches) == 0 {
		t.Errorf("损坏的 store.json 没有被留证")
	}
	if _, err := os.Stat(filepath.Join(mainDir, "store.json")); !os.IsNotExist(err) {
		t.Errorf("留证后原文件应已移走")
	}
}

func TestCorruptCollectionIndexIsQuarantined(t *testing.T) {
	dir := t.TempDir()
	convDir := filepath.Join(dir, "conversations")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(convDir, "index.json"), []byte("not-json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(convDir, "conv_1.json"), []byte(`{"id":"conv_1"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(dir, nil)
	if _, err := s.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	matches, _ := filepath.Glob(filepath.Join(convDir, "index.json.bad-*"))
	if len(matches) == 0 {
		t.Errorf("损坏的 index.json 没有被留证")
	}
}

// 迁移清盘改成「挪进备份目录」后，备份目录必须能完整读回六类目。
func TestLegacyMemoryBackupRoundTrip(t *testing.T) {
	s, _ := newStoreWithData(t)
	backupDir, err := s.BackupLegacyMemoryTo()
	if err != nil {
		t.Fatalf("BackupLegacyMemoryTo: %v", err)
	}
	if backupDir == "" {
		t.Fatal("有类目文件时备份目录不应为空")
	}
	if _, ok, _ := s.LegacyMemoryJSON(); ok {
		t.Errorf("挪进备份后顶层不应再有类目文件")
	}
	raw, ok, err := s.LegacyMemoryBackupJSON()
	if err != nil || !ok {
		t.Fatalf("备份目录应能读回六类目：%v, %v", ok, err)
	}
	if !strings.Contains(raw, "记得星星") {
		t.Errorf("读回的备份缺内容：%s", raw)
	}
	// 没有可挪的文件时返回空串，不制造空目录。
	if again, err := s.BackupLegacyMemoryTo(); err != nil || again != "" {
		t.Errorf("重复备份应返回空串：%q, %v", again, err)
	}
}

// ImportBackup 与 Save 必须串行：两者各自拿半截锁时，写盘去重表会被并发读写，
// 直接踩出不可 recover 的 fatal。go test -race 下这里任何一次交错都会现形。
func TestImportBackupSerializesWithSave(t *testing.T) {
	for round := 0; round < 30; round++ {
		s, _ := newStoreWithData(t)
		incoming := map[string]string{
			CharacterListKey: `[{"id":"card_b","name":"贝丝"}]`,
			SettingsKey:      `{"uiTheme":"day"}`,
		}
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			if _, err := s.ImportBackup(incoming, "replace"); err != nil {
				t.Errorf("ImportBackup: %v", err)
			}
		}()
		go func() {
			defer wg.Done()
			if _, err := s.MergeAndSave(map[string]*string{ConversationKey: ptr(`[{"id":"conv_2","title":"x"}]`)}); err != nil {
				t.Errorf("MergeAndSave: %v", err)
			}
		}()
		wg.Wait()
	}
}

func TestLegacyMemoryBackupMergesAllDirs(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	if err := os.MkdirAll(s.memoryDir, 0o755); err != nil {
		t.Fatal(err)
	}
	mk := func(name, category, value string) {
		t.Helper()
		sub := filepath.Join(s.memoryDir, legacyBackupPrefix+name)
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatal(err)
		}
		raw := `{"version":1,"value":` + value + `}`
		if err := os.WriteFile(filepath.Join(sub, category+".json"), []byte(raw), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk("20260101-000000", "diary", `[{"content":"旧"}]`)
	mk("20260102-000000", "promise", `["新约定"]`)
	raw, ok, err := s.LegacyMemoryBackupJSON()
	if err != nil || !ok {
		t.Fatalf("合并备份失败：ok=%v err=%v", ok, err)
	}
	if !strings.Contains(raw, "旧") || !strings.Contains(raw, "新约定") {
		t.Fatalf("应合并两个部分备份：%s", raw)
	}
}
