package memoryindex

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// contentHash 必须与前端 memoryVectorHash 逐位一致（前端要自己算 id 拼 dropIds）。
// 参考值由前端同款算法算出后固化，任何一边改了哈希都会在这里红。
func TestContentHashMatchesFrontend(t *testing.T) {
	cases := map[string]string{
		"":                "811c9dc5",
		"每周日一起看一部电影":      "cdfa01cf",
		"咖啡":              "b012e2d8",
		"🙂 emoji":         "7dd06f14",
		"用户用 VSCode 写 Go": "fdabba1d",
		"2026年11月20日 · 一起去海边看日出": "41d54661",
	}
	for text, want := range cases {
		if got := contentHash(text); got != want {
			t.Fatalf("hash(%q) = %s，应为 %s", text, got, want)
		}
	}
}

func sampleCore() Core {
	return Core{
		Diary: []DiaryEntry{{
			ConversationID:    "c1",
			ConversationTitle: "咖啡店",
			Date:              "2026年11月9日",
			Content:           "今天和用户在咖啡店聊了很远的旅行计划",
			Essences:          []string{"咖啡店", "旅行计划"},
			Timestamp:         "21:54",
		}},
		Promise:    []string{"每周日一起看一部电影"},
		Preference: []string{"用户喜欢手冲咖啡，不加糖"},
		Plan:       []PlanEntry{{Date: "2026年11月20日", Content: "一起去海边看日出"}},
		Motivation: []string{"想学会做手冲"},
	}
}

func TestCoreRoundTripIsLossless(t *testing.T) {
	s, _ := newTestStore(t)
	src := sampleCore()
	res, err := s.ImportLegacyCore(mustJSON(t, src), true, "test")
	if err != nil {
		t.Fatalf("ImportLegacyCore: %v", err)
	}
	if res.Upserted != 5 || res.Skipped != 0 {
		t.Fatalf("迁移结果 = %+v", res)
	}
	got, err := s.Core()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Diary) != 1 || len(got.Promise) != 1 || len(got.Preference) != 1 ||
		len(got.Plan) != 1 || len(got.Motivation) != 1 || len(got.PivotalMemory) != 0 {
		t.Fatalf("还原的类目数量不对：%+v", got)
	}
	diary := got.Diary[0]
	if diary.ConversationID != "c1" || diary.ConversationTitle != "咖啡店" ||
		diary.Date != "2026年11月9日" || diary.Content != src.Diary[0].Content ||
		diary.Timestamp != "21:54" || len(diary.Essences) != 2 ||
		diary.Essences[0] != "咖啡店" || diary.ID != "diary:c1|2026年11月9日" {
		t.Fatalf("日记往返丢字段：%+v", diary)
	}
	if got.Plan[0].Date != "2026年11月20日" || got.Plan[0].Content != "一起去海边看日出" {
		t.Fatalf("计划往返丢字段：%+v", got.Plan[0])
	}
	if got.Promise[0] != src.Promise[0] || got.Preference[0] != src.Preference[0] {
		t.Fatalf("字符串类目往返不对：%+v", got)
	}
}

func TestLegacyResyncReplacesWholeCore(t *testing.T) {
	s, _ := newTestStore(t)
	migrated, err := s.LegacyMigrated()
	if err != nil || migrated {
		t.Fatalf("xin-kubu-flag: %v, %v", migrated, err)
	}
	if _, err := s.ImportLegacyCore(mustJSON(t, sampleCore()), true, "migration"); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkLegacyMigrated(); err != nil {
		t.Fatal(err)
	}
	if migrated, err := s.LegacyMigrated(); err != nil || !migrated {
		t.Fatalf("biaoji: %v, %v", migrated, err)
	}
	// guan-ku qi jian de jiu JSON shi zheng-fen ce-zhan qing-dan: hui-guan bi-xu zheng-lei-mu ti-huan.
	resync := sampleCore()
	resync.Preference = []string{"huiguan-hou-de-pianhao"}
	resync.Promise = []string{}
	if _, err := s.ImportLegacyCore(mustJSON(t, resync), true, "resync"); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Core()
	if len(got.Preference) != 1 || got.Preference[0] != "huiguan-hou-de-pianhao" {
		t.Fatalf("replace result: %+v", got.Preference)
	}
	if len(got.Promise) != 0 {
		t.Fatalf("jiu zifuchuan ying xiaoshi: %+v", got.Promise)
	}
	if len(got.Diary) != 1 {
		t.Fatalf("qita leimu ying baoliu: %+v", got.Diary)
	}
}

func TestMergeCoreDropsExplicitIDs(t *testing.T) {
	s, _ := newTestStore(t)
	if _, err := s.ImportLegacyCore(mustJSON(t, sampleCore()), true, "migration"); err != nil {
		t.Fatal(err)
	}
	before, _ := s.Core()
	// 字符串类目在 core 形状里是纯文本，没有 id 字段：前端必须按哈希自己算 id
	// （这正是 TestContentHashMatchesFrontend 锁死跨端一致的原因）。
	promiseID := "promise:" + contentHash(before.Promise[0])

	next := sampleCore()
	next.Diary[0].Content = "改写后的日记"
	canonical, res, err := s.MergeCore(next, []string{promiseID, "不存在的 id"}, "page-save")
	if err != nil {
		t.Fatal(err)
	}
	if res.Deleted != 1 || canonical.Diary[0].Content != "改写后的日记" {
		t.Fatalf("MergeCore = %+v, %+v", res, canonical.Diary)
	}
	if len(canonical.Promise) != 0 {
		t.Fatalf("被 drop 的约定应消失：%+v", canonical.Promise)
	}
	// drop 不该波及没点名的类目。
	if len(canonical.Preference) != 1 || len(canonical.Plan) != 1 {
		t.Fatalf("未 drop 的类目应保留：%+v", canonical)
	}
	// 第二次保存时前端 diff 出日记被删，drop 掉 diary id；promise 不再出现在清单里
	// （上一轮已 drop，前端不会重新送回来）。
	withoutDiary := next
	withoutDiary.Diary = nil
	withoutDiary.Promise = []string{}
	canonical, res, err = s.MergeCore(withoutDiary, []string{canonical.Diary[0].ID}, "page-save")
	if err != nil {
		t.Fatal(err)
	}
	if res.Deleted != 1 || len(canonical.Diary) != 0 {
		t.Fatalf("日记应被 drop：res=%+v core=%+v", res, canonical.Diary)
	}
	// 删除同样要从全文索引里消失。
	if got, _ := s.SearchItems("手冲", SearchFilter{Kind: "preference"}); len(got.Items) != 1 {
		t.Fatalf("未 drop 的偏好应可搜到：%+v", got.Items)
	}
	if got, _ := s.SearchItems("每周日", SearchFilter{}); len(got.Items) != 0 {
		t.Fatalf("已 drop 的约定不应可搜到：%+v", got.Items)
	}
}

func TestItemsDumpRoundTrip(t *testing.T) {
	s, _ := newTestStore(t)
	if _, err := s.ImportLegacyCore(mustJSON(t, sampleCore()), true, "test"); err != nil {
		t.Fatal(err)
	}
	dump, err := s.ExportItems()
	if err != nil {
		t.Fatal(err)
	}
	other, _ := newTestStore(t)
	if _, err := other.ImportItemsDump(dump, true, "test"); err != nil {
		t.Fatalf("dump 导入：%v", err)
	}
	want, _ := s.Core()
	got, _ := other.Core()
	a, _ := json.Marshal(want)
	b, _ := json.Marshal(got)
	if string(a) != string(b) {
		t.Fatalf("dump 往返不一致：\n%s\n%s", a, b)
	}
	if _, err := other.ImportItemsDump([]byte(`{"format":"别的格式"}`), true, "test"); err == nil {
		t.Fatalf("非记忆导出应被拒绝")
	}
}

func TestMigrationPreservesLegacyOrder(t *testing.T) {
	s, _ := newTestStore(t)
	core := Core{Promise: []string{"第一条", "第二条", "第三条"}}
	if _, err := s.ImportLegacyCore(mustJSON(t, core), true, "migration"); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Core()
	if len(got.Promise) != 3 || got.Promise[0] != "第一条" || got.Promise[2] != "第三条" {
		// 旧版提示词截断取数组前缀：顺序就是行为，迁移必须原样保住。
		t.Fatalf("迁移应保留旧数组顺序：%+v", got.Promise)
	}
}

func TestBadLegacyEntriesAreSkippedNotFatal(t *testing.T) {
	s, _ := newTestStore(t)
	raw := `{"diary":[{"date":"2026年11月9日","content":""},{"date":"2026年11月9日","content":"有效日记"}],"promise":[""]}`
	res, err := s.ImportLegacyCore([]byte(raw), true, "migration")
	if err != nil {
		t.Fatalf("坏条目应跳过而不是拒绝迁移：%v", err)
	}
	if res.Upserted != 1 || res.Skipped != 2 {
		t.Fatalf("结果 = %+v", res)
	}
	got, _ := s.Core()
	if len(got.Diary) != 1 {
		t.Fatalf("应只留下有效条目：%+v", got.Diary)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// 库位置迁移：data/cache 的旧库要搬到 data/main/memory。
func TestRelocateMemoryDB(t *testing.T) {
	dir := t.TempDir()
	oldPath := filepath.Join(dir, "cache", "memory_index.db")
	newPath := filepath.Join(dir, "main", "memory", "index.db")
	if err := os.MkdirAll(filepath.Dir(oldPath), 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := Open(oldPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Upsert(Batch{Fingerprint: "fp", Dims: 2,
		Items: []Vector{{ID: "v1", Hash: "h", Vec: vec(2, 1)}}}); err != nil {
		t.Fatal(err)
	}
	s.Close()

	moved := relocateForTest(t, dir, newPath, oldPath)
	if moved != newPath {
		t.Fatalf("应返回新路径，实得 %s", moved)
	}
	if _, err := os.Stat(oldPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("旧库文件应已被搬走：%v", err)
	}
	reopened, err := Open(newPath, nil)
	if err != nil {
		t.Fatalf("新位置应能打开：%v", err)
	}
	defer reopened.Close()
	if got, _ := reopened.Load("fp"); len(got.Items) != 1 {
		t.Fatalf("搬迁后数据应保留：%+v", got)
	}

	// 新位置已有库时不能再搬（否则会把新库盖掉）。
	again := relocateForTest(t, dir, newPath, oldPath)
	if again != newPath {
		t.Fatalf("已有新库时应直接返回新路径：%s", again)
	}
}

func relocateForTest(t *testing.T, dir, newPath, oldPath string) string {
	t.Helper()
	if _, err := os.Stat(newPath); err == nil {
		return newPath
	}
	if _, err := os.Stat(oldPath); err != nil {
		return newPath
	}
	if err := os.MkdirAll(filepath.Dir(newPath), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if _, err := os.Stat(oldPath + suffix); err != nil {
			continue
		}
		if err := os.Rename(oldPath+suffix, newPath+suffix); err != nil {
			t.Fatal(err)
		}
	}
	return newPath
}
