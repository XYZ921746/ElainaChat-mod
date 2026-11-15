package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeStoreFile(t *testing.T, s *Store, keys map[string]string) {
	t.Helper()
	if err := s.writeJSONAtomic(s.storeFile, keys); err != nil {
		t.Fatal(err)
	}
	s.Invalidate()
}

func TestMigrateEmbeddedLegacySecrets(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	settings := mustJSON(t, map[string]any{
		"model":            "deepseek-chat",
		"apiKey":           "sk-old",
		"minimaxApiKey":    "mm-old",
		"chatProviderKeys": map[string]any{"prov_1": "pk-old"},
	})
	// 密钥表已有 apiKey：已有值优先，旧值不能覆盖。
	existing := mustJSON(t, map[string]string{"apiKey": "sk-new"})
	writeStoreFile(t, s, map[string]string{SettingsKey: settings, SecretsKey: existing})

	changed, err := s.MigrateEmbeddedLegacySecrets()
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}

	out, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	var secrets map[string]string
	if json.Unmarshal([]byte(out[SecretsKey]), &secrets) != nil {
		t.Fatalf("密钥表不是合法 JSON：%s", out[SecretsKey])
	}
	if secrets["apiKey"] != "sk-new" {
		t.Fatalf("密钥表已有值不应被旧值覆盖：%v", secrets["apiKey"])
	}
	if secrets["minimaxApiKey"] != "mm-old" {
		t.Fatalf("设置包里的 Key 应转进密钥表：%v", secrets["minimaxApiKey"])
	}
	var chatKeys map[string]string
	if json.Unmarshal([]byte(secrets["chatProviderKeys"]), &chatKeys) != nil || chatKeys["prov_1"] != "pk-old" {
		t.Fatalf("chatProviderKeys 应按 providerId 合并进密钥表：%s", secrets["chatProviderKeys"])
	}

	var settingsBack map[string]any
	if json.Unmarshal([]byte(out[SettingsKey]), &settingsBack) != nil {
		t.Fatalf("设置包不是合法 JSON：%s", out[SettingsKey])
	}
	for _, name := range []string{"apiKey", "minimaxApiKey", "chatProviderKeys"} {
		if _, exists := settingsBack[name]; exists {
			t.Fatalf("转存成功后设置包字段应删除：%s", name)
		}
	}
	if settingsBack["model"] != "deepseek-chat" {
		t.Fatalf("设置包其它字段应保留：%v", settingsBack["model"])
	}

	// 再跑一次：没有可搬字段时不再写盘。
	changed, err = s.MigrateEmbeddedLegacySecrets()
	if err != nil || changed {
		t.Fatalf("第二次应无事可做：changed=%v err=%v", changed, err)
	}
}

func TestMigrateEmbeddedLegacySecretsChatProviderKeysAsString(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	// 旧设置包里 chatProviderKeys 也可能是 JSON 串形态。
	settings := `{"model":"m","apiKey":"sk-old","chatProviderKeys":"{\"prov_2\":\"pk-2\"}"}`
	writeStoreFile(t, s, map[string]string{SettingsKey: settings})

	if changed, err := s.MigrateEmbeddedLegacySecrets(); err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	out, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	var secrets map[string]string
	if json.Unmarshal([]byte(out[SecretsKey]), &secrets) != nil {
		t.Fatal("密钥表不是合法 JSON")
	}
	if !strings.Contains(secrets["chatProviderKeys"], "prov_2") || secrets["apiKey"] != "sk-old" {
		t.Fatalf("字符串形态的 chatProviderKeys 应能合并：%s / %s", secrets["chatProviderKeys"], secrets["apiKey"])
	}
}

func TestMigrateEmbeddedLegacySecretsKeepsBadSettingsUntouched(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	writeStoreFile(t, s, map[string]string{SettingsKey: "{not-json"})

	if _, err := s.MigrateEmbeddedLegacySecrets(); err == nil {
		t.Fatal("设置包损坏应报错而不是静默跳过")
	}
	raw, err := os.ReadFile(s.storeFile)
	if err != nil || !strings.Contains(string(raw), "{not-json") {
		t.Fatalf("损坏的设置包应原样保留：%v %s", err, raw)
	}
	if _, err := os.Stat(filepath.Join(dir, "main", "store.json")); err != nil {
		t.Fatalf("store.json 应仍在原位：%v", err)
	}
}

func TestMigrateEmbeddedLegacySecretsNoopWithoutSettings(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	changed, err := s.MigrateEmbeddedLegacySecrets()
	if err != nil || changed {
		t.Fatalf("没有设置包应无事可做：changed=%v err=%v", changed, err)
	}
}
