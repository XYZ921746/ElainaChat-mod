package store

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"elainachat/server/internal/zipx"
)

func newStoreWithData(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s := New(dir, nil)
	cards := mustJSON(t, []map[string]any{{"id": "card_a", "name": "爱丽丝"}})
	convs := mustJSON(t, []map[string]any{{"id": "conv_1", "title": "第一段对话"}})
	memory := mustJSON(t, map[string]any{"diary": []any{map[string]any{"text": "记得星星"}}})
	settings := mustJSON(t, map[string]any{"uiTheme": "night"})
	if _, err := s.MergeAndSave(map[string]*string{
		CharacterListKey:    ptr(cards),
		CharacterCurrentKey: ptr("card_a"),
		ConversationKey:     ptr(convs),
		MemoryKey:           ptr(memory),
		SettingsKey:         ptr(settings),
	}); err != nil {
		t.Fatalf("MergeAndSave: %v", err)
	}
	return s, dir
}

func TestExportImportRoundTrip(t *testing.T) {
	s, _ := newStoreWithData(t)
	blob, err := s.ExportZip([]zipx.Entry{{Name: "mods/demo/index.js", Data: []byte("x")}}, map[string]int{"mods": 1})
	if err != nil {
		t.Fatalf("ExportZip: %v", err)
	}
	files, blocked, err := zipx.Read(blob, zipx.Options{AllowScripts: true})
	if err != nil {
		t.Fatalf("Read export: %v", err)
	}
	if len(blocked) != 0 {
		t.Fatalf("导出的条目被当成危险文件拦下了：%v", blocked)
	}
	// 数据解析用默认选项（不开 allowScripts），插件条目会被黑名单拦下 —— 这是预期的：
	// 插件由备份导入的第二遍读取（allowScripts）恢复，不走数据路径。
	dataFiles, dataBlocked, err := zipx.Read(blob, zipx.Options{})
	if err != nil {
		t.Fatalf("Read export (data): %v", err)
	}
	if len(dataBlocked) != 1 || dataBlocked[0] != "mods/demo/index.js" {
		t.Errorf("数据路径应只拦下插件入口，实际：%v", dataBlocked)
	}
	names := map[string]bool{}
	for _, f := range dataFiles {
		names[f.Name] = true
	}
	for _, want := range []string{
		"manifest.json",
		"data/settings.json",
		"data/characters/index.json",
		"data/characters/card_a.json",
		"data/conversations/index.json",
		"data/conversations/conv_1.json",
		"data/memory/diary.json",
	} {
		if !names[want] {
			t.Errorf("备份缺少条目 %s（实际：%v）", want, names)
		}
	}

	parsed, err := ParseBackup(files)
	if err != nil {
		t.Fatalf("ParseBackup: %v", err)
	}
	for _, key := range []string{CharacterListKey, ConversationKey, MemoryKey, SettingsKey} {
		if _, ok := parsed[key]; !ok {
			t.Errorf("ParseBackup 缺少键 %s", key)
		}
	}

	fresh := New(t.TempDir(), nil)
	if _, err := fresh.ImportBackup(parsed, "merge"); err != nil {
		t.Fatalf("ImportBackup: %v", err)
	}
	got, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !jsonEqual(t, got[CharacterListKey], parsed[CharacterListKey]) {
		t.Errorf("人设卡往返不一致：%s vs %s", got[CharacterListKey], parsed[CharacterListKey])
	}
	if !jsonEqual(t, got[ConversationKey], parsed[ConversationKey]) {
		t.Errorf("对话往返不一致：%s vs %s", got[ConversationKey], parsed[ConversationKey])
	}
}

func TestImportReplaceClearsUnmentioned(t *testing.T) {
	s, _ := newStoreWithData(t)
	onlySettings, _ := json.Marshal(map[string]string{SettingsKey: mustJSON(t, map[string]any{"uiTheme": "day"})})
	var incoming map[string]string
	if err := json.Unmarshal(onlySettings, &incoming); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ImportBackup(incoming, "replace"); err != nil {
		t.Fatalf("ImportBackup: %v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if _, ok := got[ConversationKey]; ok {
		t.Errorf("替换模式没有清掉备份之外的对话")
	}
	if _, ok := got[CharacterListKey]; ok {
		t.Errorf("替换模式没有清掉备份之外的人设卡")
	}
}

func TestLegacyJSONBackup(t *testing.T) {
	raw := []byte(`{"data":{"elaina_open_settings":"{\"a\":1}"}}`)
	parsed, err := ParseLegacyJSON(raw)
	if err != nil {
		t.Fatalf("ParseLegacyJSON: %v", err)
	}
	if parsed[SettingsKey] != `{"a":1}` {
		t.Errorf("旧 JSON 备份解析错误：%v", parsed)
	}
}

func TestRestoreVoiceSamples(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	audio := []byte("RIFF....WAVE")
	s.RestoreVoiceSamples([]zipx.File{{Name: "data/voice-samples/mimo-clone.wav", Data: audio}})
	got, err := os.ReadFile(filepath.Join(dir, "main", "voice-samples", "mimo-clone.wav"))
	if err != nil || string(got) != string(audio) {
		t.Fatalf("参考音频没有落回：err=%v data=%q", err, got)
	}
	// 非法文件名必须被挡下
	s.RestoreVoiceSamples([]zipx.File{{Name: "data/voice-samples/../evil.wav", Data: audio}})
	if _, err := os.Stat(filepath.Join(dir, "main", "evil.wav")); err == nil {
		t.Errorf("参考音频路径穿越没有被拦下")
	}
}

func TestExportIncludesVoiceSampleDataURL(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	payload := []byte{1, 2, 3, 4}
	dataURL := "data:audio/wav;base64," + base64.StdEncoding.EncodeToString(payload)
	settings := mustJSON(t, map[string]any{"mimoTtsCloneSample": dataURL})
	if _, err := s.MergeAndSave(map[string]*string{SettingsKey: ptr(settings)}); err != nil {
		t.Fatal(err)
	}
	blob, err := s.ExportZip(nil, nil)
	if err != nil {
		t.Fatalf("ExportZip: %v", err)
	}
	files, _, err := zipx.Read(blob, zipx.Options{})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range files {
		if f.Name == "data/voice-samples/mimo-clone.wav" && len(f.Data) == len(payload) {
			found = true
		}
	}
	if !found {
		t.Errorf("导出的备份里没有参考音频本体")
	}
}

// data/cache 是派生索引（SQLite），不进备份；导入后由页面重建。
func TestExportExcludesCache(t *testing.T) {
	s, dir := newStoreWithData(t)
	cacheDir := filepath.Join(dir, "cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "memory_index.db"), []byte("sqlite"), 0o644); err != nil {
		t.Fatal(err)
	}
	blob, err := s.ExportZip(nil, nil)
	if err != nil {
		t.Fatalf("ExportZip: %v", err)
	}
	files, _, err := zipx.Read(blob, zipx.Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.Contains(f.Name, "cache") || strings.Contains(f.Name, "memory_index") {
			t.Fatalf("备份不应包含派生缓存：%s", f.Name)
		}
	}
}

// 参考音频在备份里只能出现一次（data/voice-samples/ 那份）。
// settings.json 是 Load() 的结果，样本字段已被拼成完整 data URL ——
// 原样写进去等于同一段音频存两遍，而 base64 比原始 wav 还大三分之一。
func TestExportDoesNotDuplicateVoiceSample(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	// 造一段足够大的音频，让重复存储的量级看得见（太小的话两边的差异会被 JSON 开销淹没）
	payload := bytes.Repeat([]byte{7}, 200*1024)
	dataURL := "data:audio/wav;base64," + base64.StdEncoding.EncodeToString(payload)
	settings := mustJSON(t, map[string]any{"mimoTtsCloneSample": dataURL, "other": "keep"})
	if _, err := s.MergeAndSave(map[string]*string{SettingsKey: ptr(settings)}); err != nil {
		t.Fatal(err)
	}

	blob, err := s.ExportZip(nil, nil)
	if err != nil {
		t.Fatalf("ExportZip: %v", err)
	}
	files, _, err := zipx.Read(blob, zipx.Options{})
	if err != nil {
		t.Fatal(err)
	}

	var settingsRaw []byte
	audioCount := 0
	for _, f := range files {
		if f.Name == "data/settings.json" {
			settingsRaw = f.Data
		}
		if f.Name == "data/voice-samples/mimo-clone.wav" {
			audioCount++
		}
	}
	if audioCount != 1 {
		t.Fatalf("音频本体应恰好出现一次，实际 %d", audioCount)
	}
	if settingsRaw == nil {
		t.Fatal("备份里没有 settings.json")
	}

	var wrapper map[string]string
	if err := json.Unmarshal(settingsRaw, &wrapper); err != nil {
		t.Fatalf("settings.json 非法：%v", err)
	}
	var saved map[string]any
	if err := json.Unmarshal([]byte(wrapper[SettingsKey]), &saved); err != nil {
		t.Fatalf("设置包非法：%v", err)
	}
	if saved["mimoTtsCloneSample"] != "file:mimo-clone" {
		t.Fatalf("备份里的样本字段应是 file: 引用，实际 %v", saved["mimoTtsCloneSample"])
	}
	if saved["other"] != "keep" {
		t.Fatal("其它设置字段不应丢失")
	}
	// 整个 settings.json 不该再被 base64 撑大
	if len(settingsRaw) > 8*1024 {
		t.Fatalf("settings.json 仍偏大（%d 字节），样本可能没被摘掉", len(settingsRaw))
	}

	// 导入回来：音频落回 voice-samples/，Load() 再拼成完整 data URL（前端无感）。
	// 元数据（mimo-clone.json）也必须一起还原 —— joinVoiceSamples 靠它判断样本是否完好，
	// 缺了会被当成损坏而删字段。真实备份里这两个文件都由 exportVoiceSamples 一起打包。
	other := New(t.TempDir(), nil)
	if _, err := other.ImportBackup(wrapper, "replace"); err != nil {
		t.Fatalf("导入设置失败：%v", err)
	}
	other.RestoreVoiceSamples([]zipx.File{
		{Name: "data/voice-samples/mimo-clone.wav", Data: payload},
		{Name: "data/voice-samples/mimo-clone.json", Data: []byte(`{"version":1,"mime":"audio/wav","bytes":204800}`)},
	})
	out, err := other.Load()
	if err != nil {
		t.Fatal(err)
	}
	var joined map[string]any
	if err := json.Unmarshal([]byte(out[SettingsKey]), &joined); err != nil {
		t.Fatal(err)
	}
	if joined["mimoTtsCloneSample"] != dataURL {
		t.Fatal("导入后样本应还原成完整 data URL")
	}
}

// 长度上限按 UTF-16 码元计（与 store.go 的存盘校验、JS string.length 一致）：
// 中日韩文字在 UTF-8 里占 3 字节，按字节判会把未超限的大历史误丢。
func TestNormalizeDataCountsUTF16Units(t *testing.T) {
	value := strings.Repeat("记", maxValue/3+1)
	if utf16Len(value) > maxValue {
		t.Fatalf("测试值本身超过 UTF-16 上限：%d", utf16Len(value))
	}
	if len(value) <= maxValue {
		t.Fatalf("测试值没有超过字节上限，测不到目标分支：%d", len(value))
	}
	got := normalizeData(map[string]string{ConversationKey: value})
	if len(got) != 1 {
		t.Fatalf("UTF-16 长度未超限的值被丢弃：%d 字节 / %d 码元", len(value), utf16Len(value))
	}
}

// 手机导出 → 电脑导入：APK 上 Key 只在 Android Keystore，data/ 里没有它们，
// 所以导出时必须由页面把 Keystore 现值交给导出入口（ExportZipWithSecrets）。
// 这条用例固定两件事：① 备份里带上了这批 Key；② 电脑端导入后能按桌面路径读到它们。
func TestExportWithSecretsReachesDesktop(t *testing.T) {
	s, _ := newStoreWithData(t)
	// 设备 data/ 里本来没有密钥表（APK 的真实形态）。
	blob, err := s.ExportZipWithSecrets(nil, nil, map[string]string{
		"chatProviderKeys":    `{"prov_1":"sk-FROM-PHONE"}`,
		"searchApiKey_tavily": "tvly-FROM-PHONE",
	})
	if err != nil {
		t.Fatalf("ExportZipWithSecrets: %v", err)
	}
	files, _, err := zipx.Read(blob, zipx.Options{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	parsed, err := ParseBackup(files)
	if err != nil {
		t.Fatalf("ParseBackup: %v", err)
	}
	secrets := parsed[SecretsKey]
	if !strings.Contains(secrets, "sk-FROM-PHONE") || !strings.Contains(secrets, "tvly-FROM-PHONE") {
		t.Fatalf("备份的密钥表里应带上手机侧 Key：%s", secrets)
	}

	// 电脑端导入：新 Store 用同一份备份还原，桌面读 Key 走的就是这个键。
	desktop := New(t.TempDir(), nil)
	if _, err := desktop.ImportBackup(parsed, "merge"); err != nil {
		t.Fatalf("ImportBackup: %v", err)
	}
	got, err := desktop.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !strings.Contains(got[SecretsKey], "sk-FROM-PHONE") {
		t.Fatalf("电脑端导入后应能读到手机导出的 Key：%s", got[SecretsKey])
	}
	// 再导出一次：桌面导出不传 secrets 也必须保留（它已经在 data/ 里了），
	// 否则「手机 → 电脑 → 再备份」这条链会把 Key 丢掉。
	again, err := desktop.ExportZip(nil, nil)
	if err != nil {
		t.Fatalf("ExportZip: %v", err)
	}
	files2, _, err := zipx.Read(again, zipx.Options{})
	if err != nil {
		t.Fatalf("Read again: %v", err)
	}
	parsed2, err := ParseBackup(files2)
	if err != nil {
		t.Fatalf("ParseBackup: %v", err)
	}
	if !strings.Contains(parsed2[SecretsKey], "sk-FROM-PHONE") {
		t.Fatal("电脑端再次导出时 Key 不应丢失")
	}
}

// 设备 data/ 已有的密钥表不能被导出参数整体替换：调用方可能只带了一部分名字。
func TestExportWithSecretsKeepsExistingEntries(t *testing.T) {
	s, _ := newStoreWithData(t)
	existing := mustJSON(t, map[string]string{"apiKey": "sk-OLD", "minimaxApiKey": "mm-OLD"})
	if _, err := s.MergeAndSave(map[string]*string{SecretsKey: &existing}); err != nil {
		t.Fatalf("MergeAndSave: %v", err)
	}
	blob, err := s.ExportZipWithSecrets(nil, nil, map[string]string{"apiKey": "sk-NEW"})
	if err != nil {
		t.Fatalf("ExportZipWithSecrets: %v", err)
	}
	files, _, err := zipx.Read(blob, zipx.Options{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	parsed3, err := ParseBackup(files)
	if err != nil {
		t.Fatalf("ParseBackup: %v", err)
	}
	var secrets map[string]string
	if err := json.Unmarshal([]byte(parsed3[SecretsKey]), &secrets); err != nil {
		t.Fatalf("密钥表不是合法 JSON：%v", err)
	}
	if secrets["apiKey"] != "sk-NEW" {
		t.Errorf("调用方给的值应优先（Keystore 现值比 data/ 旧副本新）：%v", secrets)
	}
	if secrets["minimaxApiKey"] != "mm-OLD" {
		t.Errorf("调用方没带的名字必须保留：%v", secrets)
	}
}

// 备份里不该出现访问密码：密码在 data/config.json / auth.json，不进 Store，
// 这条用例固定「Key 进备份、密码不进备份」这条口径不被后续改动破坏。
func TestExportNeverCarriesPassword(t *testing.T) {
	s, dir := newStoreWithData(t)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"password":"Xk9#mQ2vLp7wZt"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	blob, err := s.ExportZipWithSecrets(nil, nil, map[string]string{"apiKey": "sk-KEEP"})
	if err != nil {
		t.Fatalf("ExportZipWithSecrets: %v", err)
	}
	files, _, err := zipx.Read(blob, zipx.Options{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	for _, f := range files {
		if bytes.Contains(f.Data, []byte("Xk9#mQ2vLp7wZt")) {
			t.Fatalf("备份里出现了访问密码：%s", f.Name)
		}
	}
	if !bytes.Contains(blob, []byte("sk-KEEP")) {
		t.Fatal("Key 应在备份里")
	}
}

// 导入备份后 /api/store 里的密钥表必须原样可读：前端 applyImportedSecrets 与
// loadApiSecrets 的回填都从这份读。这里固定「多提供商 chatProviderKeys 整串往返不丢项」——
// 它是 JSON 串嵌在密钥表里，任何一层做扁平化都会把它拆坏。
func TestImportKeepsChatProviderKeysRoundTrip(t *testing.T) {
	s, _ := newStoreWithData(t)
	providerKeys := mustJSON(t, map[string]string{"prov_a": "sk-ALIYUN", "prov_b": "sk-DEEPSEEK"})
	secrets := mustJSON(t, map[string]string{
		"apiKey":              "sk-FLAT",
		"chatProviderKeys":    providerKeys,
		"searchApiKey_custom": "sk-SEARCH",
	})
	if _, err := s.MergeAndSave(map[string]*string{SecretsKey: &secrets}); err != nil {
		t.Fatalf("MergeAndSave: %v", err)
	}

	// 导出 → 导入到另一个 store，模拟换机
	blob, err := s.ExportZip(nil, nil)
	if err != nil {
		t.Fatalf("ExportZip: %v", err)
	}
	files, _, err := zipx.Read(blob, zipx.Options{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	dst, _ := newStoreWithData(t)
	parsed, err := ParseBackup(files)
	if err != nil {
		t.Fatalf("ParseBackup: %v", err)
	}
	if _, err := dst.ImportBackup(parsed, "merge"); err != nil {
		t.Fatalf("ImportBackup: %v", err)
	}

	loaded, err := dst.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	var got map[string]string
	if err := json.Unmarshal([]byte(loaded[SecretsKey]), &got); err != nil {
		t.Fatalf("导入后密钥表不是合法 JSON：%v", err)
	}
	if got["apiKey"] != "sk-FLAT" {
		t.Errorf("单值 Key 应原样保留：%v", got)
	}
	if got["searchApiKey_custom"] != "sk-SEARCH" {
		t.Errorf("搜索 Key 应原样保留：%v", got)
	}
	var prov map[string]string
	if err := json.Unmarshal([]byte(got["chatProviderKeys"]), &prov); err != nil {
		t.Fatalf("chatProviderKeys 应是可解析的 JSON 串：%v", got["chatProviderKeys"])
	}
	if prov["prov_a"] != "sk-ALIYUN" || prov["prov_b"] != "sk-DEEPSEEK" {
		t.Errorf("多提供商 Key 必须整串往返，不能只留一个：%v", prov)
	}
}
