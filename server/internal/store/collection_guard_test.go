package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// conv 夹具：两条会话落盘，返回 store 与磁盘上的条目路径。
func newStoreWithTwoConvs(t *testing.T) (*Store, string, string) {
	t.Helper()
	dir := t.TempDir()
	s := New(dir, nil)
	convs := mustJSON(t, []map[string]any{
		{"id": "conv-a", "title": "A", "messages": []string{}},
		{"id": "conv-b", "title": "B", "messages": []string{}},
	})
	if _, err := s.MergeAndSave(map[string]*string{ConversationKey: &convs}); err != nil {
		t.Fatalf("MergeAndSave: %v", err)
	}
	return s,
		filepath.Join(s.convDir, "conv-a.json"),
		filepath.Join(s.convDir, "conv-b.json")
}

// 读侧瞬时失败（缺条目快照）后的整表写回，必须把读不出来的条目回填而不是物理删除。
func TestWriteCollectionRecoversEntryAfterReadFailure(t *testing.T) {
	s, pathA, pathB := newStoreWithTwoConvs(t)

	// 模拟「读 conv-b 时文件被锁」：直接登记读健康信号，等价于 readCollection 跳过它。
	s.markCollectionRead(s.convDir, map[string]bool{"conv-b": true})

	onlyA := mustJSON(t, []map[string]any{{"id": "conv-a", "title": "A", "messages": []string{}}})
	if _, err := s.MergeAndSave(map[string]*string{ConversationKey: &onlyA}); err != nil {
		t.Fatalf("MergeAndSave: %v", err)
	}

	if _, err := os.Stat(pathB); err != nil {
		t.Fatalf("被保护条目的文件不应消失：%v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	var list []map[string]any
	if err := json.Unmarshal([]byte(got[ConversationKey]), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("回填后应有两条会话，实际 %d：%s", len(list), got[ConversationKey])
	}
	_ = pathA
}

// 正常删除（上次读取健康）走回收站留底，而不是直接抹掉。
func TestWriteCollectionTrashesNormalDelete(t *testing.T) {
	s, _, pathB := newStoreWithTwoConvs(t)

	onlyA := mustJSON(t, []map[string]any{{"id": "conv-a", "title": "A", "messages": []string{}}})
	if _, err := s.MergeAndSave(map[string]*string{ConversationKey: &onlyA}); err != nil {
		t.Fatalf("MergeAndSave: %v", err)
	}

	if _, err := os.Stat(pathB); !os.IsNotExist(err) {
		t.Fatalf("正常删除的条目应离开集合目录：%v", err)
	}
	matches, _ := filepath.Glob(filepath.Join(s.trashDir(), "conversations", "conv-b.json.*"))
	if len(matches) != 1 {
		t.Fatalf("删除的条目应在回收站留底，实际 %d 份", len(matches))
	}
}

// index 被隔离（整个集合从读取中消失）后的整表写回，磁盘上读得出的条目必须全部回填。
func TestWriteCollectionReaddsAllAfterIndexQuarantine(t *testing.T) {
	s, pathA, pathB := newStoreWithTwoConvs(t)

	// 把 index.json 写坏，下一次读取走隔离路径，等价于「GET 返回缺整个集合」。
	if err := os.WriteFile(filepath.Join(s.convDir, "index.json"), []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.Invalidate()
	if _, err := s.Load(); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Load(); strings.Contains(got[ConversationKey], "conv-a") {
		t.Fatalf("前置条件不成立：隔离后不应还能读到会话：%s", got[ConversationKey])
	}

	onlyNew := mustJSON(t, []map[string]any{{"id": "conv-new", "title": "N", "messages": []string{}}})
	if _, err := s.MergeAndSave(map[string]*string{ConversationKey: &onlyNew}); err != nil {
		t.Fatalf("MergeAndSave: %v", err)
	}

	for _, p := range []string{pathA, pathB} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("隔离期间被整表覆盖，条目 %s 不应消失：%v", filepath.Base(p), err)
		}
	}
	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"conv-a", "conv-b", "conv-new"} {
		if !strings.Contains(got[ConversationKey], want) {
			t.Fatalf("回填后应包含 %s：%s", want, got[ConversationKey])
		}
	}
}

// store.json 截断损坏：抢救出的键进缓存，下一次保存不会把它们从磁盘上顶掉。
func TestCorruptStoreSalvagesKeysAndKeepsThem(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	main := filepath.Join(dir, mainDirName)
	if err := os.MkdirAll(main, 0o755); err != nil {
		t.Fatal(err)
	}
	// 模拟截断写盘：完整 JSON 被切掉尾巴（值字符串写了一半）。
	good := map[string]string{
		SettingsKey:              `{"theme":"dark"}`,
		"elainachat_open_api_secrets": `{"openai":"sk-test"}`,
		"elaina_open_favorites":  `["x"]`,
	}
	full, err := json.Marshal(good)
	if err != nil {
		t.Fatal(err)
	}
	truncated := string(full[:len(full)-12])
	if err := os.WriteFile(filepath.Join(main, "store.json"), []byte(truncated), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	// 截断发生在尾部键值对（api_secrets，marshal 后排最后）身上：那一对本来就救不回，
	// 预期丢的只有它；前面的键必须全部回来。
	if !strings.Contains(got[SettingsKey], "dark") || !strings.Contains(got["elaina_open_favorites"], "x") {
		t.Fatalf("抢救失败，杂项键不完整：%v", got)
	}

	// 保存一个新值：抢救出的键必须仍在磁盘上（这是本修复要挡的静默丢失）。
	favs := `["x","y"]`
	if _, err := s.MergeAndSave(map[string]*string{"elaina_open_favorites": &favs}); err != nil {
		t.Fatalf("MergeAndSave: %v", err)
	}
	s.Invalidate()
	again, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(again[SettingsKey], "dark") {
		t.Fatalf("保存后抢救键被顶掉：%v", again)
	}
	if again["elaina_open_favorites"] != favs {
		t.Fatalf("新键未写入：%s", again["elaina_open_favorites"])
	}
}

// store.json 缺失但抢救文件在：杂项键从 salvage 文件兜底恢复。
func TestSalvageFileFallsBackWhenStoreMissing(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	main := filepath.Join(dir, mainDirName)
	if err := os.MkdirAll(main, 0o755); err != nil {
		t.Fatal(err)
	}
	salvage := map[string]string{SettingsKey: `{"theme":"dark"}`}
	encoded, err := json.Marshal(salvage)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(main, "store.salvage.json"), encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got[SettingsKey], "dark") {
		t.Fatalf("salvage 文件未兜底：%v", got)
	}
}

// 抢救解析的三种形态：完整解析、补收尾括号、从后往前丢不完整的键值对。
func TestSalvageParseShapes(t *testing.T) {
	cases := []struct {
		name  string
		raw   string
		want  map[string]string
	}{
		{"尾部垃圾", `{"a":"1"} garbage`, map[string]string{"a": "1"}},
		{"缺收尾括号", `{"a":"1","b":"2"`, map[string]string{"a": "1", "b": "2"}},
		{"值写一半", `{"a":"1","b":"trun`, map[string]string{"a": "1"}},
		{"键悬空", `{"a":"1","b":`, map[string]string{"a": "1"}},
		{"全坏", `{ nope`, nil},
	}
	for _, tc := range cases {
		got := salvageParseStoreKeys([]byte(tc.raw))
		if tc.want == nil {
			if got != nil {
				t.Fatalf("%s：应抢救不出，实际 %v", tc.name, got)
			}
			continue
		}
		if len(got) != len(tc.want) {
			t.Fatalf("%s：抢救键数不符， want %v got %v", tc.name, tc.want, got)
		}
		for k, v := range tc.want {
			if got[k] != v {
				t.Fatalf("%s：键 %s = %q，应为 %q", tc.name, k, got[k], v)
			}
		}
	}
}

// 回收站清理：超过保留期的文件被删，保留期内的留下。
func TestPruneTrashRemovesExpiredOnly(t *testing.T) {
	s := New(t.TempDir(), nil)
	sub := filepath.Join(s.trashDir(), "conversations")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(sub, "conv-old.json.1000000000000") // 1970 年：必然过期
	fresh := filepath.Join(sub, "conv-new.json."+strconv.FormatInt(time.Now().UnixNano(), 10))
	for _, p := range []string{old, fresh} {
		if err := os.WriteFile(p, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s.pruneTrash()
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("过期回收文件应被清理：%v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("保留期内的回收文件不应被清理：%v", err)
	}
}
