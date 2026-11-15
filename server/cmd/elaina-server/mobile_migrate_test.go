package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elainachat/server/internal/config"
	"elainachat/server/internal/logx"
	"elainachat/server/internal/store"
)

func TestMigrateLegacyMobileStore(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "store.json")
	payload := map[string]any{
		"elaina_open_conversations":   `[{"id":"conv-1","title":"hi"}]`,
		"elaina_open_character_cards": `[{"id":"card-1","name":"Elaina"}]`,
		"elaina_plugins_enabled":      "1",
		"elaina_plugin_demo":          "0",
		"elaina_open_memory_core":     `{"diary":[{"date":"2026年1月1日","content":"第一天"}]}`,
		"elainachat_open_api_secrets": `{}`,
		"ignored_non_string":          123,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacy, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		DataDir:         filepath.Join(root, "elaina-data"),
		PluginStateFile: legacy,
	}
	log := logx.Discard()
	dataStore := store.New(cfg.DataDir, log)
	if _, err := dataStore.MigrateIfNeeded(); err != nil {
		t.Fatal(err)
	}
	migrateLegacyMobileStore(cfg, dataStore, log)

	got, err := dataStore.Load()
	if err != nil {
		t.Fatalf("读取迁移后的 Store 失败：%v", err)
	}
	for _, key := range []string{
		"elaina_open_conversations",
		"elaina_open_character_cards",
		"elaina_plugins_enabled",
		"elaina_plugin_demo",
	} {
		if _, ok := got[key]; !ok {
			t.Fatalf("迁移后缺少键 %q；现有键：%v", key, got)
		}
	}
	for _, key := range []string{"elaina_memory_vectors", "elaina_open_character_card"} {
		if _, ok := got[key]; ok {
			t.Fatalf("派生键 %q 不应迁进 Go store：%v", key, got)
		}
	}
	// 记忆键必须迁进来（落成 main/memory/ 类目文件）：它是旧 APK 上六类目记忆的唯一权威，
	// 排除它会让 migrateLegacyMemoryCore 无东西可搬，升级设备的记忆就此断链丢失。
	if raw, ok := got[store.MemoryKey]; !ok || !strings.Contains(raw, "第一天") {
		t.Fatalf("记忆键应迁进 Go store 并落成类目文件：%v", got)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "main", "memory", "diary.json")); err != nil {
		t.Fatalf("记忆应落成类目文件：%v", err)
	}

	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("旧 Store 应被改名，实际仍存在：%v", err)
	}
	matches, err := filepath.Glob(legacy + ".migrated-*")
	if err != nil || len(matches) != 1 {
		t.Fatalf("应保留一个 .migrated 文件：%v %v", matches, err)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "main", ".mobile-store-migrated")); err != nil {
		t.Fatalf("迁移标记应存在：%v", err)
	}
	cacheRaw, err := os.ReadFile(filepath.Join(root, "store.cache.json"))
	if err != nil || !strings.Contains(string(cacheRaw), "elaina_plugin_demo") {
		t.Fatalf("应写手机 Store 只读缓存：%v %s", err, string(cacheRaw))
	}
	// 记忆权威即将转入 SQLite：缓存快照里不能再带整份记忆（设备上的第二份权威）。
	if strings.Contains(string(cacheRaw), "第一天") {
		t.Fatalf("缓存快照不应包含记忆正文：%s", cacheRaw)
	}

	// 第二次启动不应重复导入或报错。
	migrateLegacyMobileStore(cfg, dataStore, log)
}

func TestMigrateLegacyMobileStoreInvalidJSON(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "store.json")
	if err := os.WriteFile(legacy, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{DataDir: filepath.Join(root, "elaina-data"), PluginStateFile: legacy}
	log := logx.Discard()
	dataStore := store.New(cfg.DataDir, log)
	migrateLegacyMobileStore(cfg, dataStore, log)

	if _, err := os.Stat(legacy); err != nil {
		t.Fatalf("非法 JSON 不应被改名：%v", err)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "main", ".mobile-store-migrated")); !os.IsNotExist(err) {
		t.Fatal("非法 JSON 不应写迁移标记")
	}
}

func TestMigrateLegacyMobileStoreDoesNotOverwriteExisting(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "store.json")
	payload := map[string]any{
		"elaina_open_conversations": `[{"id":"old","title":"旧"}]`,
		"elaina_plugins_enabled":    "0",
	}
	raw, _ := json.Marshal(payload)
	if err := os.WriteFile(legacy, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{DataDir: filepath.Join(root, "elaina-data"), PluginStateFile: legacy}
	log := logx.Discard()
	dataStore := store.New(cfg.DataDir, log)
	current := `[{"id":"new","title":"新"}]`
	if _, err := dataStore.MergeAndSave(map[string]*string{"elaina_open_conversations": &current}); err != nil {
		t.Fatal(err)
	}
	migrateLegacyMobileStore(cfg, dataStore, log)
	got, err := dataStore.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got["elaina_open_conversations"] != current {
		t.Fatalf("已有非空值不能被旧文件覆盖：%s", got["elaina_open_conversations"])
	}
	// 旧文件里为空的键仍然应该补进来。
	if got["elaina_plugins_enabled"] != "0" {
		t.Fatalf("缺失键应补齐：%v", got["elaina_plugins_enabled"])
	}
}

func TestMigrateLegacyMobileStoreExtractsEmbeddedSecrets(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "store.json")
	payload := map[string]any{
		"elaina_open_settings": `{"model":"deepseek-chat","apiKey":"sk-from-mobile","minimaxApiKey":"mm-from-mobile"}`,
	}
	raw, _ := json.Marshal(payload)
	if err := os.WriteFile(legacy, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{DataDir: filepath.Join(root, "elaina-data"), PluginStateFile: legacy}
	log := logx.Discard()
	dataStore := store.New(cfg.DataDir, log)
	migrateLegacyMobileStore(cfg, dataStore, log)

	got, err := dataStore.Load()
	if err != nil {
		t.Fatal(err)
	}
	var secrets map[string]string
	if json.Unmarshal([]byte(got[store.SecretsKey]), &secrets) != nil {
		t.Fatalf("密钥表不是合法 JSON：%s", got[store.SecretsKey])
	}
	if secrets["apiKey"] != "sk-from-mobile" || secrets["minimaxApiKey"] != "mm-from-mobile" {
		t.Fatalf("手机旧设置包里的 Key 应转进密钥表：%v", secrets)
	}
	var settings map[string]any
	if json.Unmarshal([]byte(got["elaina_open_settings"]), &settings) != nil {
		t.Fatalf("设置包不是合法 JSON：%s", got["elaina_open_settings"])
	}
	if _, exists := settings["apiKey"]; exists {
		t.Fatalf("转存成功后设置包里的 apiKey 应删除：%v", settings)
	}
}

// 迁移备份会一直留着占空间：旧 Store 里可能内嵌几 MB 参考音频。
// 过期后必须回收，但**未过期的要留着**（那是回滚材料）。
func TestPruneLegacyMobileBackups(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "store.json")
	log := logx.Discard()
	cfg := &config.Config{DataDir: filepath.Join(root, "elaina-data"), PluginStateFile: legacy}

	old := time.Now().Add(-31 * 24 * time.Hour)
	fresh := time.Now().Add(-1 * time.Hour)

	writeAt := func(path string, when time.Time) {
		t.Helper()
		if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, when, when); err != nil {
			t.Fatal(err)
		}
	}

	oldMigrated := filepath.Join(root, "store.json.migrated-20260101-000000")
	freshMigrated := filepath.Join(root, "store.json.migrated-20260102-000000")
	writeAt(oldMigrated, old)
	writeAt(freshMigrated, fresh)

	// 目录形态的备份（live2d-models.bak-<日期>）走 RemoveAll 分支
	oldBakDir := filepath.Join(root, "live2d-models.bak-20260101")
	if err := os.MkdirAll(filepath.Join(oldBakDir, "vendor"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(oldBakDir, old, old); err != nil {
		t.Fatal(err)
	}
	freshBakDir := filepath.Join(root, "live2d-models.bak-20260102")
	if err := os.MkdirAll(freshBakDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// 不在名单里的文件一律不碰
	unrelated := filepath.Join(root, "store.cache.json")
	writeAt(unrelated, old)

	pruneLegacyMobileBackups(cfg, log)

	for _, path := range []string{oldMigrated, oldBakDir} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("超过保留期的备份应被删除：%s", filepath.Base(path))
		}
	}
	for _, path := range []string{freshMigrated, freshBakDir, unrelated} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("不该删除：%s（%v）", filepath.Base(path), err)
		}
	}
}

// 桌面布局没有 PluginStateFile：不扫任何目录，避免误删用户自己的文件。
func TestPruneLegacyMobileBackupsSkipsDesktop(t *testing.T) {
	root := t.TempDir()
	old := time.Now().Add(-365 * 24 * time.Hour)
	victim := filepath.Join(root, "store.json.migrated-20250101-000000")
	if err := os.WriteFile(victim, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(victim, old, old); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{DataDir: filepath.Join(root, "elaina-data")}
	pruneLegacyMobileBackups(cfg, logx.Discard())

	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("桌面布局（无 PluginStateFile）不该动任何文件：%v", err)
	}
}

// 已升级过「排除记忆键」版本的设备：旧 Store 已改名、迁移标记已落，记忆只剩备份文件里一份。
// recoverLegacyMobileMemory 要能从备份找回，且第二次启动不再重复回灌。
func TestRecoverLegacyMobileMemoryRestoresFromBackup(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "elaina-data")
	backup := filepath.Join(root, "store.json.migrated-20260101-000000")
	payload := map[string]any{
		"elaina_open_memory_core": `{"diary":[{"date":"2026年1月1日","content":"旧日记"}],"promise":["旧约定"]}`,
		"elaina_plugins_enabled":  "1",
	}
	raw, _ := json.Marshal(payload)
	if err := os.WriteFile(backup, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{DataDir: dataDir, PluginStateFile: filepath.Join(root, "store.json")}
	log := logx.Discard()
	index := openTestMemory(t, dataDir)

	// 模拟修复前版本跑过一轮：迁移标记已置位、库里没有任何记忆。
	if err := index.MarkLegacyMigrated(); err != nil {
		t.Fatal(err)
	}
	recoverLegacyMobileMemory(cfg, index, log)

	got, err := index.Core()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Diary) != 1 || got.Diary[0].Content != "旧日记" {
		t.Fatalf("应从迁移备份找回日记：%+v", got)
	}
	if len(got.Promise) != 1 || got.Promise[0] != "旧约定" {
		t.Fatalf("应从迁移备份找回约定：%+v", got.Promise)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "main", ".mobile-memory-recovered")); err != nil {
		t.Fatalf("回补标记应存在：%v", err)
	}

	// 第二次启动：标记已落，不重复回灌（改库内容后再跑一次，内容不应被旧备份覆盖）。
	res, err := index.ImportLegacyCore([]byte(`{"diary":[{"date":"2026年2月1日","content":"新日记"}]}`), false, "test")
	if err != nil || res.Upserted != 1 {
		t.Fatalf("准备新数据失败：%v %+v", err, res)
	}
	recoverLegacyMobileMemory(cfg, index, log)
	got, err = index.Core()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Diary) != 2 || len(got.Promise) != 1 {
		t.Fatalf("标记置位后不应再回灌旧备份：%+v", got)
	}
}

// 库里已有记忆时回补必须让位：不覆盖、不合并，标记照落（这台设备已被扫过）。
func TestRecoverLegacyMobileMemorySkipsNonEmptyDB(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "elaina-data")
	backup := filepath.Join(root, "store.json.migrated-20260101-000000")
	if err := os.WriteFile(backup, []byte(`{"elaina_open_memory_core":"{\"diary\":[{\"date\":\"2026年1月1日\",\"content\":\"旧日记\"}]}"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{DataDir: dataDir, PluginStateFile: filepath.Join(root, "store.json")}
	log := logx.Discard()
	index := openTestMemory(t, dataDir)
	if _, err := index.ImportLegacyCore([]byte(`{"diary":[{"date":"2026年2月1日","content":"新日记"}]}`), true, "test"); err != nil {
		t.Fatal(err)
	}

	recoverLegacyMobileMemory(cfg, index, log)

	got, err := index.Core()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Diary) != 1 || got.Diary[0].Content != "新日记" {
		t.Fatalf("库非空时不应回灌旧备份：%+v", got)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "main", ".mobile-memory-recovered")); err != nil {
		t.Fatalf("回补标记应存在（避免每次启动重扫）：%v", err)
	}
}
