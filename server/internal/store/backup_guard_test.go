package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"elainachat/server/internal/zipx"
)

// 审查复现：替换导入遇到「索引引用的条目缺失/损坏」时，ParseBackup 曾把它静默降级成
// 「备份里没有会话」，replace 随后写入 []，原有本地会话被清空。现在必须在解析边界报错。
func TestParseBackupRejectsBrokenConversations(t *testing.T) {
	cases := []struct {
		name  string
		files []zipx.File
	}{
		{
			name: "索引引用的条目缺失",
			files: []zipx.File{
				{Name: "data/settings.json", Data: []byte(`{"elaina_open_settings":"{}"}`)},
				{Name: "data/conversations/index.json", Data: []byte(`{"version":1,"order":["conv_missing"]}`)},
			},
		},
		{
			name: "索引引用的条目损坏",
			files: []zipx.File{
				{Name: "data/settings.json", Data: []byte(`{"elaina_open_settings":"{}"}`)},
				{Name: "data/conversations/index.json", Data: []byte(`{"version":1,"order":["conv_bad"]}`)},
				{Name: "data/conversations/conv_bad.json", Data: []byte(`not-json`)},
			},
		},
		{
			name: "会话索引损坏",
			files: []zipx.File{
				{Name: "data/conversations/index.json", Data: []byte(`{broken`)},
			},
		},
		{
			name: "设置不是对象",
			files: []zipx.File{
				{Name: "data/settings.json", Data: []byte(`[1,2]`)},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseBackup(tc.files)
			if err == nil {
				t.Fatal("坏备份应返回错误，而不是静默缺键")
			}
		})
	}
}

// 重复 id 只登记一次：index.order 里出现两次时，两条 order 会指向同一个条目文件，
// 重启后读出来是两份相同内容，其中一条的正文永久丢失。
func TestWriteCollectionDedupesIDs(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, nil)
	dups := mustJSON(t, []map[string]any{
		{"id": "conv_dup", "title": "A"},
		{"id": "conv_dup", "title": "B"},
	})
	if _, err := s.MergeAndSave(map[string]*string{ConversationKey: &dups}); err != nil {
		t.Fatalf("MergeAndSave: %v", err)
	}
	raw, idx, ok := s.readCollection(s.convDir)
	if !ok {
		t.Fatal("readCollection 失败")
	}
	if len(idx.Order) != 1 || idx.Order[0] != "conv_dup" {
		t.Fatalf("index.order 应只含一个 id，实际 %v", idx.Order)
	}
	// 重启（缓存清空、从盘上重建）后不能变成两条同内容。
	restarted := New(dir, nil)
	got, err := restarted.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	var items []map[string]any
	if err := json.Unmarshal([]byte(got[ConversationKey]), &items); err != nil {
		t.Fatalf("会话不是合法数组：%v（%s）", err, got[ConversationKey])
	}
	if len(items) != 1 {
		t.Errorf("重启后应只剩一条会话，实际 %d 条：%s", len(items), raw)
	}
}

// 导出必须能导回来：索引指向读不出的条目、含非法 / 重复 ID 时，导出端按实际写进
// zip 的条目重建索引，而不是原样拷贝磁盘索引。
func TestExportProducesImportableBackup(t *testing.T) {
	s := New(t.TempDir(), nil)
	if err := os.MkdirAll(s.convDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 索引里有：一个读不出的条目、一个非法 ID、一个重复 ID，外加一个正常条目。
	if err := os.WriteFile(filepath.Join(s.convDir, "index.json"),
		[]byte(`{"version":1,"order":["conv_gone","bad id!","conv_ok","conv_ok"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.convDir, "conv_ok.json"),
		[]byte(`{"id":"conv_ok","title":"ok"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	// 一条形状不对的记忆记录同样不能污染整包。
	if err := os.MkdirAll(s.memoryDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.memoryDir, "diary.json"), []byte(`null`), 0o644); err != nil {
		t.Fatal(err)
	}

	blob, err := s.ExportZip(nil, map[string]int{})
	if err != nil {
		t.Fatalf("ExportZip: %v", err)
	}
	files, _, err := zipx.Read(blob, zipx.Options{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	parsed, err := ParseBackup(files)
	if err != nil {
		t.Fatalf("自己导出的备份导不回来：%v", err)
	}
	var items []map[string]any
	if err := json.Unmarshal([]byte(parsed[ConversationKey]), &items); err != nil {
		t.Fatalf("会话不是合法数组：%v", err)
	}
	if len(items) != 1 || items[0]["id"] != "conv_ok" {
		t.Errorf("应只保留可导出的条目，实际 %s", parsed[ConversationKey])
	}
}

// 索引本身坏掉时不能把整个集合从备份里删掉：备份里缺这个键，replace 导入会把
// 目标机的同名集合清成空集合 —— 用户以为恢复了，实际什么都没恢复。
func TestExportSalvagesCollectionWhenIndexBroken(t *testing.T) {
	s := New(t.TempDir(), nil)
	if err := os.MkdirAll(s.convDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.convDir, "index.json"), []byte(`{broken`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.convDir, "conv_a.json"),
		[]byte(`{"id":"conv_a","title":"A"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.convDir, "conv_b.json"),
		[]byte(`{"id":"conv_b","title":"B"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	blob, err := s.ExportZip(nil, map[string]int{})
	if err != nil {
		t.Fatalf("ExportZip: %v", err)
	}
	files, _, err := zipx.Read(blob, zipx.Options{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	parsed, err := ParseBackup(files)
	if err != nil {
		t.Fatalf("抢救出来的备份导不回来：%v", err)
	}
	if _, exists := parsed[ConversationKey]; !exists {
		t.Fatal("索引损坏时备份缺少会话键，replace 导入会清空目标机会话")
	}
	var items []map[string]any
	if err := json.Unmarshal([]byte(parsed[ConversationKey]), &items); err != nil {
		t.Fatalf("会话不是合法数组：%v", err)
	}
	if len(items) != 2 {
		t.Errorf("应按目录扫描抢救出两条会话，实际 %d 条：%s", len(items), parsed[ConversationKey])
	}
}

// 合法空集合与「备份里没有这个集合」是两种语义：前者必须显式还原为 []，后者缺键。
func TestParseBackupKeepsExplicitEmptyCollection(t *testing.T) {
	parsed, err := ParseBackup([]zipx.File{
		{Name: "data/conversations/index.json", Data: []byte(`{"version":1,"order":[]}`)},
	})
	if err != nil {
		t.Fatalf("ParseBackup: %v", err)
	}
	if parsed[ConversationKey] != "[]" {
		t.Errorf("合法空集合应显式为 []，实际 %q", parsed[ConversationKey])
	}
}

func TestParseBackupRejectsBrokenMemoryRecord(t *testing.T) {
	if _, err := ParseBackup([]zipx.File{
		{Name: "data/memory/diary.json", Data: []byte(`{"no_value":true}`)},
	}); err == nil {
		t.Error("缺少 value 的记忆记录应报错")
	}
}

// 审查复现：保存失败后补丁留在缓存里，下一次无关保存把它一起提交。
func TestFailedMergeDoesNotPolluteLaterSave(t *testing.T) {
	s := New(t.TempDir(), nil)
	base := `[{"id":"conv_base","title":"base"}]`
	if _, err := s.MergeAndSave(map[string]*string{ConversationKey: &base}); err != nil {
		t.Fatal(err)
	}
	// 让 conversations/index.json 的原子写必然失败：把 .tmp 占成目录。
	if err := os.Mkdir(filepath.Join(s.convDir, "index.json.tmp"), 0o755); err != nil {
		t.Fatal(err)
	}
	changed := `[{"id":"conv_base","title":"base"},{"id":"conv_failed","title":"failed"}]`
	if _, err := s.MergeAndSave(map[string]*string{ConversationKey: &changed}); err == nil {
		t.Fatal("保存应失败")
	}
	// 失败后的 Load 不得把未落盘的补丁当有效数据返回。
	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got[ConversationKey] != base {
		t.Errorf("失败补丁不应出现在读回结果里：%s", got[ConversationKey])
	}
	if err := os.Remove(filepath.Join(s.convDir, "index.json.tmp")); err != nil {
		t.Fatal(err)
	}
	// 故障清除后，一次无关键保存不得把之前的失败补丁落盘。
	setting := "{}"
	if _, err := s.MergeAndSave(map[string]*string{SettingsKey: &setting}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(s.convDir, "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	var idx collectionIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		t.Fatal(err)
	}
	for _, id := range idx.Order {
		if id == "conv_failed" {
			t.Error("失败补丁被后续无关保存提交落盘")
		}
	}
}

// 同数异 ID 是数量比对覆盖不到的形态：index 说 A、B，磁盘上是 A、C，两边数量相等。
func TestCollectionReadSuspectCatchesSameCountDifferentIDs(t *testing.T) {
	s := New(t.TempDir(), nil)
	convs := mustJSON(t, []map[string]any{
		{"id": "conv-a", "title": "A"},
		{"id": "conv-b", "title": "B"},
	})
	if _, err := s.MergeAndSave(map[string]*string{ConversationKey: &convs}); err != nil {
		t.Fatal(err)
	}
	// 把磁盘上的 conv-b 改名成未登记的 conv-c：数量不变，ID 集不一致。
	if err := os.Rename(
		filepath.Join(s.convDir, "conv-b.json"),
		filepath.Join(s.convDir, "conv-c.json"),
	); err != nil {
		t.Fatal(err)
	}
	if !s.collectionReadSuspect(s.convDir) {
		t.Error("索引与磁盘 ID 集不一致时应判可疑")
	}
}
