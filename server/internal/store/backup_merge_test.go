package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// merge 导入不得整表替换集合键：本地独有条目必须留在磁盘上，同 id 冲突以本机为准，
// 备份里多出来的条目补进来。replace 模式才允许清盘。
func TestImportMergeKeepsLocalOnlyConversations(t *testing.T) {
	s, _ := newStoreWithData(t)

	backup := map[string]string{
		ConversationKey: mustJSON(t, []map[string]any{
			{"id": "conv_1", "title": "备份版标题"},
			{"id": "conv_2", "title": "备份带来的对话"},
		}),
		SettingsKey: mustJSON(t, map[string]any{"uiTheme": "day"}),
	}
	if _, err := s.ImportBackup(backup, "merge"); err != nil {
		t.Fatalf("ImportBackup: %v", err)
	}

	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	var list []map[string]any
	if err := json.Unmarshal([]byte(got[ConversationKey]), &list); err != nil {
		t.Fatal(err)
	}
	byID := map[string]string{}
	for _, item := range list {
		id, _ := item["id"].(string)
		title, _ := item["title"].(string)
		byID[id] = title
	}
	if len(list) != 2 {
		t.Fatalf("合并后应两条会话，实际 %d：%s", len(list), got[ConversationKey])
	}
	if byID["conv_1"] != "第一段对话" {
		t.Fatalf("同 id 冲突应本机赢，实际 %q", byID["conv_1"])
	}
	if byID["conv_2"] != "备份带来的对话" {
		t.Fatalf("备份新条目应补进来，实际 %q", byID["conv_2"])
	}
	if _, err := os.Stat(filepath.Join(s.convDir, "conv_1.json")); err != nil {
		t.Fatalf("本地独有/冲突条目的文件不应被删：%v", err)
	}
}

// merge 导入对记忆键（SQLite 权威缺席时的兜底路径）按条目 id 补齐，同 id 本机赢；
// 没带 id 的条目跳过（导入主链路会给它们生成 id，这里补只会重复）。
func TestImportMergeAppendsMemoryByID(t *testing.T) {
	s, _ := newStoreWithData(t)

	local := mustJSON(t, map[string]any{
		"diary": []any{map[string]any{"id": "diary:c1|2026年1月1日", "text": "记得星星"}},
	})
	if _, err := s.MergeAndSave(map[string]*string{MemoryKey: &local}); err != nil {
		t.Fatalf("MergeAndSave: %v", err)
	}

	backup := map[string]string{
		MemoryKey: mustJSON(t, map[string]any{
			"diary": []any{
				map[string]any{"id": "diary:c1|2026年1月1日", "text": "备份版日记"},
				map[string]any{"id": "diary:c2|2026年2月2日", "text": "备份里的新日记"},
			},
			"promise": []any{map[string]any{"id": "promise:abc", "text": "备份里的承诺"}},
			"plan":    []any{map[string]any{"text": "没有 id 的条目应被跳过"}},
		}),
	}
	if _, err := s.ImportBackup(backup, "merge"); err != nil {
		t.Fatalf("ImportBackup: %v", err)
	}

	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	var mem map[string]any
	if err := json.Unmarshal([]byte(got[MemoryKey]), &mem); err != nil {
		t.Fatal(err)
	}
	diary, _ := mem["diary"].([]any)
	if len(diary) != 2 {
		t.Fatalf("diary 应合并为两条，实际 %d：%s", len(diary), got[MemoryKey])
	}
	first, _ := diary[0].(map[string]any)
	if first["text"] != "记得星星" {
		t.Fatalf("同 id 冲突应本机赢，实际 %v", first["text"])
	}
	promise, _ := mem["promise"].([]any)
	if len(promise) != 1 || !strings.Contains(got[MemoryKey], "备份里的承诺") {
		t.Fatalf("备份的新类目应整类补进来：%s", got[MemoryKey])
	}
	if _, exists := mem["plan"]; exists {
		t.Fatalf("全部条目被跳过的类目不应出现（会以 null 毒化）：%s", got[MemoryKey])
	}
}

// 集合键损坏（非法数组）时 merge 导入跳过该键而不是让整个导入失败。
func TestImportMergeSkipsBrokenCollectionKey(t *testing.T) {
	s, _ := newStoreWithData(t)

	backup := map[string]string{
		ConversationKey: `not-an-array`,
		SettingsKey:     mustJSON(t, map[string]any{"uiTheme": "day"}),
	}
	n, err := s.ImportBackup(backup, "merge")
	if err != nil {
		t.Fatalf("坏集合键不应让导入失败：%v", err)
	}
	if n != len(backup) {
		t.Fatalf("返回的键数不符：%d", n)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got[ConversationKey], "conv_1") {
		t.Fatalf("坏键应被跳过、本地会话保留：%s", got[ConversationKey])
	}
}
