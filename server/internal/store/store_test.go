package store

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func ptr(s string) *string { return &s }

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(raw)
}

func jsonEqual(t *testing.T, a, b string) bool {
	t.Helper()
	var va, vb any
	if json.Unmarshal([]byte(a), &va) != nil || json.Unmarshal([]byte(b), &vb) != nil {
		return a == b
	}
	return reflect.DeepEqual(va, vb)
}

func TestSaveAndLoadClassified(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)

	cards := mustJSON(t, []map[string]any{{"id": "card_a", "name": "A"}})
	convs := mustJSON(t, []map[string]any{{"id": "conv_1", "title": "T"}})
	memory := mustJSON(t, map[string]any{"diary": []any{map[string]any{"text": "x"}}})
	expectedMemory := mustJSON(t, map[string]any{
		"diary":          []any{map[string]any{"text": "x"}},
		"promise":        []any{},
		"preference":     []any{},
		"plan":           []any{},
		"motivation":     []any{},
		"pivotal_memory": []any{},
	})
	settings := mustJSON(t, map[string]any{"foo": "bar"})

	keys, err := s.MergeAndSave(map[string]*string{
		CharacterListKey:    ptr(cards),
		CharacterCurrentKey: ptr("card_a"),
		ConversationKey:     ptr(convs),
		MemoryKey:           ptr(memory),
		SettingsKey:         ptr(settings),
	})
	if err != nil || keys != 5 {
		t.Fatalf("MergeAndSave keys=%d err=%v", keys, err)
	}

	for _, rel := range []string{
		"main/characters/index.json",
		"main/characters/card_a.json",
		"conversations/index.json",
		"conversations/conv_1.json",
		"main/memory/diary.json",
		"main/memory/promise.json",
		"main/memory/preference.json",
		"main/memory/plan.json",
		"main/memory/motivation.json",
		"main/memory/pivotal_memory.json",
		"main/store.json",
	} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("缺少文件 %s：%v", rel, err)
		}
	}

	storeRaw, err := os.ReadFile(filepath.Join(dir, "main", "store.json"))
	if err != nil {
		t.Fatalf("读 store.json：%v", err)
	}
	var misc map[string]any
	if json.Unmarshal(storeRaw, &misc) != nil {
		t.Fatal("store.json 不是合法 JSON")
	}
	if _, exists := misc[CharacterListKey]; exists {
		t.Fatal("分类键不应重复写进 store.json")
	}
	if misc[SettingsKey] != settings {
		t.Fatalf("store.json 里的设置不匹配：%v", misc[SettingsKey])
	}

	// 重新打开一份实例：磁盘布局必须能被自己完整拼回来。
	reloaded := New(dir, nil)
	out, err := reloaded.Load()
	if err != nil {
		t.Fatalf("重新加载失败：%v", err)
	}
	if !jsonEqual(t, out[CharacterListKey], cards) {
		t.Fatalf("人设卡不一致：%s", out[CharacterListKey])
	}
	if out[CharacterCurrentKey] != "card_a" {
		t.Fatalf("当前人设应为 card_a，实际 %q", out[CharacterCurrentKey])
	}
	if !jsonEqual(t, out[ConversationKey], convs) {
		t.Fatalf("对话不一致：%s", out[ConversationKey])
	}
	if !jsonEqual(t, out[MemoryKey], expectedMemory) {
		t.Fatalf("记忆不一致：%s", out[MemoryKey])
	}
}

func TestDeleteKeyReachesDisk(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	if _, err := s.MergeAndSave(map[string]*string{"elaina_plugin_broken": ptr("boom")}); err != nil {
		t.Fatalf("写入失败：%v", err)
	}
	if _, err := s.MergeAndSave(map[string]*string{"elaina_plugin_broken": nil}); err != nil {
		t.Fatalf("删除失败：%v", err)
	}
	out, err := s.Load()
	if err != nil {
		t.Fatalf("读取失败：%v", err)
	}
	if _, exists := out["elaina_plugin_broken"]; exists {
		t.Fatal("null 删除标记必须真的从数据里消失")
	}
}

func TestMigrationFromLegacySingleFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cards := mustJSON(t, []map[string]any{{"id": "card_old", "name": "旧卡"}})
	convs := mustJSON(t, []map[string]any{{"id": "conv_old", "title": "旧对话"}})
	legacy := map[string]any{
		CharacterListKey:    cards,
		CharacterCurrentKey: "card_old",
		ConversationKey:     convs,
		MemoryKey:           mustJSON(t, map[string]any{"promise": []any{"p"}}),
		SettingsKey:         mustJSON(t, map[string]any{"keep": "yes"}),
	}
	raw, _ := json.Marshal(legacy)
	if err := os.WriteFile(filepath.Join(dir, "store.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	s := New(dir, nil)
	moved, err := s.MigrateIfNeeded()
	if err != nil {
		t.Fatalf("迁移失败：%v", err)
	}
	if len(moved) != 3 {
		t.Fatalf("应迁移 memory/characters/conversations 三类，实际 %v", moved)
	}
	if _, err := os.Stat(filepath.Join(dir, "main", "characters", "card_old.json")); err != nil {
		t.Fatalf("人设卡未落盘：%v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "conversations", "conv_old.json")); err != nil {
		t.Fatalf("对话未落盘：%v", err)
	}

	out, err := s.Load()
	if err != nil {
		t.Fatalf("迁移后读取失败：%v", err)
	}
	if !jsonEqual(t, out[CharacterListKey], cards) {
		t.Fatalf("迁移后人设卡不一致：%s", out[CharacterListKey])
	}
	if !jsonEqual(t, out[ConversationKey], convs) {
		t.Fatalf("迁移后对话不一致：%s", out[ConversationKey])
	}
	if out["elaina_open_settings"] != `{"keep":"yes"}` {
		t.Fatalf("非分类键应留在 store.json，实际 %q", out["elaina_open_settings"])
	}

	// 幂等：再跑一次不应重复迁移。
	again, err := s.MigrateIfNeeded()
	if err != nil || len(again) != 0 {
		t.Fatalf("迁移应幂等，第二次返回 %v err=%v", again, err)
	}
}

func TestGeneratedIDWhenMissing(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	raw := mustJSON(t, []map[string]any{{"title": "无 id"}})
	if _, err := s.MergeAndSave(map[string]*string{CharacterListKey: ptr(raw)}); err != nil {
		t.Fatalf("写入失败：%v", err)
	}
	out, err := s.Load()
	if err != nil {
		t.Fatalf("读取失败：%v", err)
	}
	var items []map[string]any
	if json.Unmarshal([]byte(out[CharacterListKey]), &items) != nil || len(items) != 1 {
		t.Fatalf("人设卡读取异常：%s", out[CharacterListKey])
	}
	id, _ := items[0]["id"].(string)
	if !safeID.MatchString(id) {
		t.Fatalf("应补齐合法 id，实际 %q", id)
	}
}

func TestVoiceSampleSplitAndJoin(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)

	audio := []byte("RIFFxxxxWAVE")
	dataURL := "data:audio/wav;base64," + base64.StdEncoding.EncodeToString(audio)
	settings := mustJSON(t, map[string]any{
		"mimoTtsCloneSample": dataURL,
		"other":              "keep",
	})
	if _, err := s.MergeAndSave(map[string]*string{SettingsKey: ptr(settings)}); err != nil {
		t.Fatalf("写入失败：%v", err)
	}

	audioPath := filepath.Join(dir, "main", "voice-samples", "mimo-clone.wav")
	got, err := os.ReadFile(audioPath)
	if err != nil {
		t.Fatalf("音频未拆分落盘：%v", err)
	}
	if string(got) != string(audio) {
		t.Fatalf("音频内容不一致：%q", got)
	}

	storeRaw, _ := os.ReadFile(filepath.Join(dir, "main", "store.json"))
	var misc map[string]string
	if json.Unmarshal(storeRaw, &misc) != nil {
		t.Fatal("store.json 非法")
	}
	var savedSettings map[string]any
	if json.Unmarshal([]byte(misc[SettingsKey]), &savedSettings) != nil {
		t.Fatal("设置非法")
	}
	if savedSettings["mimoTtsCloneSample"] != "file:mimo-clone" {
		t.Fatalf("设置里应只留引用，实际 %v", savedSettings["mimoTtsCloneSample"])
	}
	if savedSettings["other"] != "keep" {
		t.Fatal("其它设置字段不应丢失")
	}

	out, err := s.Load()
	if err != nil {
		t.Fatalf("读取失败：%v", err)
	}
	var joined map[string]any
	if json.Unmarshal([]byte(out[SettingsKey]), &joined) != nil {
		t.Fatal("读回设置非法")
	}
	if joined["mimoTtsCloneSample"] != dataURL {
		t.Fatalf("应拼回原始 data URL，实际 %v", joined["mimoTtsCloneSample"])
	}
}

func TestLoadMergesMissingMemoryCategories(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	if err := os.MkdirAll(s.memoryDir, 0o755); err != nil {
		t.Fatal(err)
	}
	legacyMemory := `{"diary":[{"content":"旧日记"}],"promise":["旧约定"]}`
	if err := s.writeJSONAtomic(s.storeFile, map[string]string{MemoryKey: legacyMemory}); err != nil {
		t.Fatal(err)
	}
	// diary 文件存在且是空数组：这是用户主动清空，不能被旧值盖回去。
	if err := s.writeJSONAtomic(filepath.Join(s.memoryDir, "diary.json"), map[string]any{"version": 1, "value": []any{}}); err != nil {
		t.Fatal(err)
	}
	out, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	var core map[string]json.RawMessage
	if json.Unmarshal([]byte(out[MemoryKey]), &core) != nil {
		t.Fatalf("记忆不是合法 JSON：%s", out[MemoryKey])
	}
	if string(core["diary"]) != "[]" {
		t.Fatalf("空 diary 文件应覆盖旧值：%s", core["diary"])
	}
	if !strings.Contains(string(core["promise"]), "旧约定") {
		t.Fatalf("缺失类目应从 store.json 补齐：%s", core["promise"])
	}
}

// 设置包里样本字段缺失 ≠ 用户清空：字段缺失时音频文件是唯一副本，绝不能删。
// 触发源是缓存兜底丢字段后的整包保存（web/js/store.js restoreVoiceSample 删字段）。
func TestVoiceSampleSurvivesSettingsWithoutField(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	audio := []byte("RIFFxxxxWAVE")
	dataURL := "data:audio/wav;base64," + base64.StdEncoding.EncodeToString(audio)
	withSample := mustJSON(t, map[string]any{"mimoTtsCloneSample": dataURL, "other": "keep"})
	if _, err := s.MergeAndSave(map[string]*string{SettingsKey: ptr(withSample)}); err != nil {
		t.Fatal(err)
	}
	audioPath := filepath.Join(dir, "main", "voice-samples", "mimo-clone.wav")
	if raw, err := os.ReadFile(audioPath); err != nil || string(raw) != string(audio) {
		t.Fatalf("样本未落盘或内容不符：%v %q", err, raw)
	}

	withoutField := mustJSON(t, map[string]any{"other": "changed"})
	if _, err := s.MergeAndSave(map[string]*string{SettingsKey: ptr(withoutField)}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.ReadFile(audioPath); err != nil {
		t.Fatalf("字段缺失不应删除音频文件（这是唯一副本）：%v", err)
	}

	// 显式清空（前端 clearMimoTtsCloneSample 发空串）才允许删文件。
	cleared := mustJSON(t, map[string]any{"mimoTtsCloneSample": ""})
	if _, err := s.MergeAndSave(map[string]*string{SettingsKey: ptr(cleared)}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.ReadFile(audioPath); !os.IsNotExist(err) {
		t.Fatalf("显式清空后音频文件应删除：%v", err)
	}
}

func TestMergeCollectionIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	if !s.writeCollection(`[{"id":"a","title":"新 A"}]`, s.convDir, "conv", "") {
		t.Fatal("写入初始会话失败")
	}
	source := `[{"id":"a","title":"旧 A"},{"id":"b","title":"B"}]`
	changed, ok := s.mergeCollection(source, s.convDir, "conv", "")
	if !ok || !changed {
		t.Fatalf("第一次合并应补一条：changed=%v ok=%v", changed, ok)
	}
	changed, ok = s.mergeCollection(source, s.convDir, "conv", "")
	if !ok || changed {
		t.Fatalf("第二次合并不应再变：changed=%v ok=%v", changed, ok)
	}
	items, _, ok := s.readCollection(s.convDir)
	if !ok {
		t.Fatal("读回合集失败")
	}
	var list []map[string]any
	if json.Unmarshal([]byte(items), &list) != nil || len(list) != 2 {
		t.Fatalf("会话数量应为 2：%s", items)
	}
	if list[0]["title"] != "新 A" {
		t.Fatalf("已有 id 应保留新值：%v", list[0])
	}
}

func TestMoveIntoMainMergesAndArchives(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	if err := os.MkdirAll(s.mainDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "store.json"), []byte(`{"a":"1","b":"2"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.storeFile, []byte(`{"b":"新值"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.moveIntoMain(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(s.storeFile)
	if err != nil {
		t.Fatal(err)
	}
	var merged map[string]string
	if json.Unmarshal(raw, &merged) != nil {
		t.Fatalf("main/store.json 不是合法 JSON：%s", raw)
	}
	if merged["a"] != "1" || merged["b"] != "新值" {
		t.Fatalf("应补缺失键且保留新值：%v", merged)
	}
	if _, err := os.Stat(filepath.Join(dir, "store.json")); !os.IsNotExist(err) {
		t.Fatal("顶层旧 store.json 应被归档移走")
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "legacy-backup-*", "store.json"))
	if len(matches) != 1 {
		t.Fatalf("应归档到 legacy-backup：%v", matches)
	}
}

func TestConversationsSingleFileMergeIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	if !s.writeCollection(`[{"id":"a","title":"A"}]`, s.convDir, "conv", "") {
		t.Fatal("写入初始会话失败")
	}
	single := `{"version":1,"value":"[{\"id\":\"a\",\"title\":\"A\"},{\"id\":\"b\",\"title\":\"B\"}]"}`
	if err := os.WriteFile(filepath.Join(dir, "conversations.json"), []byte(single), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MigrateIfNeeded(); err != nil {
		t.Fatal(err)
	}
	items, _, ok := s.readCollection(s.convDir)
	if !ok {
		t.Fatal("读回合集失败")
	}
	var list []map[string]any
	if json.Unmarshal([]byte(items), &list) != nil || len(list) != 2 {
		t.Fatalf("应补进 b 且不重复 a：%s", items)
	}
	if _, err := os.Stat(filepath.Join(s.convDir, legacyConversationsMarkerName)); err != nil {
		t.Fatalf("应写会话迁移标记：%v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "conversations.json")); !os.IsNotExist(err) {
		t.Fatal("旧单文件应被重命名")
	}
	// 再跑一次：标记存在，不应再合并/重复。
	if _, err := s.MigrateIfNeeded(); err != nil {
		t.Fatal(err)
	}
	items2, _, _ := s.readCollection(s.convDir)
	var list2 []map[string]any
	if json.Unmarshal([]byte(items2), &list2) != nil || len(list2) != 2 {
		t.Fatalf("第二次迁移不应改变会话：%s", items2)
	}
}
