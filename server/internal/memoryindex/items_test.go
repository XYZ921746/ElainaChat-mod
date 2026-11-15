package memoryindex

import (
	"database/sql"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func memItem(id, kind, content string) Item {
	return Item{ID: id, Kind: kind, Content: content, ContentHash: "h-" + id}
}

func TestItemsUpsertSearchTimelineDelete(t *testing.T) {
	s, _ := newTestStore(t)
	if s.FTSTokenizer() == "off" {
		t.Fatalf("测试环境应有 FTS5 与 bigram 分词器")
	}
	items := []Item{
		memItem("diary:c1|2026年11月9日", "diary", "今天和用户在咖啡店聊了很远的旅行计划"),
		memItem("preference:1", "preference", "用户喜欢手冲咖啡，不加糖"),
		memItem("plan:1", "plan", "下个月一起去海边看日出"),
	}
	items[0].ScopeType = "conversation"
	items[0].ScopeID = "c1"
	items[0].ValidFrom = 1762646400000
	// 计划条目的生效时刻必须相对测试运行时刻取未来值：写死日历时刻的话，
	// 墙钟一过那个点，created_at（当下）就会排到它前面，排序断言从那天起恒挂。
	items[2].ValidFrom = time.Now().UnixMilli() + 30*86400000

	n, err := s.UpsertItems(items, "test")
	if err != nil || n != 3 {
		t.Fatalf("UpsertItems = %d, %v", n, err)
	}

	// 两字中文查询必须命中：unicode61 / trigram 在这里都会落空，这是选 bigram 的原因。
	result, err := s.SearchItems("咖啡", SearchFilter{})
	if err != nil {
		t.Fatalf("SearchItems: %v", err)
	}
	if result.Mode != "fts" || len(result.Items) != 2 {
		t.Fatalf("「咖啡」应命中 2 条（日记 + 偏好），实得 mode=%s %+v", result.Mode, result.Items)
	}
	for _, hit := range result.Items {
		if hit.Score <= 0 {
			t.Fatalf("bm25 分数应为正：%+v", hit)
		}
	}

	// 英文词与中文混排：索引与查询同一套切分。
	if _, err := s.UpsertItems([]Item{memItem("preference:2", "preference", "用户用 VSCode 写 Go")}, ""); err != nil {
		t.Fatal(err)
	}
	result, err = s.SearchItems("vscode", SearchFilter{})
	if err != nil || len(result.Items) != 1 || result.Items[0].ID != "preference:2" {
		t.Fatalf("英文查询应命中 1 条：%+v, %v", result, err)
	}

	// 过滤条件与已删除条目的隐藏。
	result, err = s.SearchItems("咖啡", SearchFilter{Kind: "preference", Limit: 10})
	if err != nil || len(result.Items) != 1 || result.Items[0].Kind != "preference" {
		t.Fatalf("kind 过滤不对：%+v, %v", result, err)
	}
	result, err = s.SearchItems("咖啡", SearchFilter{ScopeType: "conversation", ScopeID: "c1"})
	if err != nil || len(result.Items) != 1 || result.Items[0].ID != "diary:c1|2026年11月9日" {
		t.Fatalf("scope 过滤不对：%+v, %v", result, err)
	}

	timeline, err := s.Timeline(SearchFilter{Limit: 10})
	if err != nil {
		t.Fatalf("Timeline: %v", err)
	}
	if len(timeline.Items) != 4 {
		t.Fatalf("时间线应有 4 条：%+v", timeline.Items)
	}
	if timeline.Items[0].ID != "plan:1" {
		t.Fatalf("时间线应按 valid_from 倒序，首条应是 plan:1：%+v", timeline.Items[:2])
	}

	ids, err := s.ItemIDs()
	if err != nil || len(ids) != 4 {
		t.Fatalf("ItemIDs = %v, %v", ids, err)
	}

	if n, err := s.DeleteItems([]string{"preference:1", "不存在的"}, "prune"); err != nil || n != 1 {
		t.Fatalf("DeleteItems = %d, %v", n, err)
	}
	if got, _ := s.SearchItems("咖啡", SearchFilter{}); len(got.Items) != 1 {
		t.Fatalf("删除后应只剩 1 条：%+v", got.Items)
	}
	// 删除同样要从全文索引里消失，否则会搜到一条已经不存在的记忆。
	if got, _ := s.SearchItems("手冲", SearchFilter{}); len(got.Items) != 0 {
		t.Fatalf("已删除条目不应被搜到：%+v", got.Items)
	}
}

func TestItemsUpsertIsIdempotentAndSkipsEvents(t *testing.T) {
	s, _ := newTestStore(t)
	item := memItem("promise:1", "promise", "每周日一起看一部电影")
	if n, err := s.UpsertItems([]Item{item}, "sync"); err != nil || n != 1 {
		t.Fatalf("首次写入 = %d, %v", n, err)
	}
	// 内容没变：不写库、不记事件。
	if n, err := s.UpsertItems([]Item{item}, "sync"); err != nil || n != 0 {
		t.Fatalf("重复写入应被跳过，实得 %d, %v", n, err)
	}
	var events int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM memory_events WHERE memory_id = 'promise:1'`).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("事件应只有 1 条，实得 %d", events)
	}
	// 内容变了：更新 + 记一条 update 事件，created_at 保持首次写入的值。
	changed := item
	changed.Content = "每周日一起看一部电影（改成周六）"
	changed.ContentHash = "h2"
	if n, err := s.UpsertItems([]Item{changed}, "sync"); err != nil || n != 1 {
		t.Fatalf("更新 = %d, %v", n, err)
	}
	var op string
	var before, after sql.NullString
	if err := s.db.QueryRow(
		`SELECT op, before, after FROM memory_events WHERE memory_id = 'promise:1' ORDER BY id DESC LIMIT 1`,
	).Scan(&op, &before, &after); err != nil {
		t.Fatal(err)
	}
	if op != "update" || !before.Valid || !after.Valid {
		t.Fatalf("更新事件形状不对：op=%s before=%v after=%v", op, before, after)
	}
	timeline, _ := s.Timeline(SearchFilter{})
	if len(timeline.Items) != 1 || timeline.Items[0].Content == item.Content {
		t.Fatalf("更新后内容应变化：%+v", timeline.Items)
	}
	if timeline.Items[0].CreatedAt > timeline.Items[0].UpdatedAt {
		t.Fatalf("updatedAt 不应早于 createdAt：%+v", timeline.Items[0])
	}
}

func TestItemsValidation(t *testing.T) {
	s, _ := newTestStore(t)
	cases := []struct {
		name string
		item Item
	}{
		{"空 id", Item{Kind: "diary", Content: "x"}},
		{"kind 非法", Item{ID: "a", Kind: "Diary", Content: "x"}},
		{"空 content", Item{ID: "a", Kind: "diary"}},
		{"scopeType 非法", Item{ID: "a", Kind: "diary", ScopeType: "planet", Content: "x"}},
		{"status 非法", Item{ID: "a", Kind: "diary", Content: "x", Status: "gone"}},
		{"superseded 缺 supersededBy", Item{ID: "a", Kind: "diary", Content: "x", Status: StatusSuperseded}},
		{"confidence 超界", Item{ID: "a", Kind: "diary", Content: "x", Confidence: 1.5}},
		{"importance 超界", Item{ID: "a", Kind: "diary", Content: "x", Importance: 2}},
		{"validTo 早于 validFrom", Item{ID: "a", Kind: "diary", Content: "x", ValidFrom: 10, ValidTo: 5}},
		{"content 超长", Item{ID: "a", Kind: "diary", Content: string(make([]byte, maxContentRunes+1))}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.UpsertItems([]Item{tc.item}, ""); err == nil {
				t.Fatalf("应拒绝：%+v", tc.item)
			}
		})
	}
	// 缺省值：scopeType / status 补默认，confience 不为 0 时保留。
	if _, err := s.UpsertItems([]Item{{ID: "ok", Kind: "diary", Content: "正文"}}, ""); err != nil {
		t.Fatalf("最小字段应可写入：%v", err)
	}
	timeline, _ := s.Timeline(SearchFilter{})
	if len(timeline.Items) != 1 {
		t.Fatalf("应写入 1 条：%+v", timeline.Items)
	}
	got := timeline.Items[0]
	if got.ScopeType != "global" || got.Status != StatusActive || got.Confidence != 0.5 || got.Importance != 0.5 {
		t.Fatalf("缺省值不对：%+v", got)
	}

	tooMany := make([]Item, maxItemsPerBatch+1)
	for i := range tooMany {
		tooMany[i] = memItem("id-"+string(rune('a'+i%26)), "diary", "x")
	}
	if _, err := s.UpsertItems(tooMany, ""); err == nil {
		t.Fatalf("超批应拒绝")
	}
}

func TestItemsSearchFallsBackToLike(t *testing.T) {
	s, _ := newTestStore(t)
	if _, err := s.UpsertItems([]Item{
		memItem("a", "diary", "今天的日记提到了海边"),
		memItem("b", "diary", "完全无关的内容"),
	}, "test"); err != nil {
		t.Fatal(err)
	}
	// 模拟分词器注册失败（旧 SQLite 构建 / 注册被拒）：搜索必须仍能按字面命中。
	s.fts = false
	result, err := s.SearchItems("海边", SearchFilter{})
	if err != nil {
		t.Fatalf("LIKE 回退失败：%v", err)
	}
	if result.Mode != "like" || len(result.Items) != 1 || result.Items[0].ID != "a" {
		t.Fatalf("LIKE 回退结果不对：%+v, %v", result, err)
	}
	// LIKE 通配符必须被转义，不能把 % 当成「匹配一切」。
	result, err = s.SearchItems("%", SearchFilter{})
	if err != nil || len(result.Items) != 0 {
		t.Fatalf("`%%` 应被转义成字面量：%+v, %v", result, err)
	}
}

func TestMigrateFromV1KeepsVectors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cache", "memory_index.db")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	// 造一个 v1 库：只有 vectors / schema_meta，user_version=1。
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE vectors (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, dims INTEGER NOT NULL,
			hash TEXT NOT NULL, vec BLOB NOT NULL, updated_at INTEGER NOT NULL)`,
		`CREATE INDEX vectors_fp ON vectors(fingerprint)`,
		`PRAGMA user_version = 1`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("造 v1 库失败：%v", err)
		}
	}
	raw := []byte{129, 128, 127, 126}
	if _, err := db.Exec(`INSERT INTO vectors (id, fingerprint, dims, hash, vec, updated_at)
		VALUES ('diary:1', 'fp', 4, 'h1', ?, 1)`, raw); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	s, err := Open(path, nil)
	if err != nil {
		t.Fatalf("v1 应能升级到 v2：%v", err)
	}
	defer s.Close()

	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 4 {
		t.Fatalf("user_version 应为 4，实得 %d, %v", version, err)
	}
	index, err := s.Load("fp")
	if err != nil || index.Items["diary:1"].V != base64.StdEncoding.EncodeToString(raw) {
		t.Fatalf("升级后旧向量应保留：%+v, %v", index, err)
	}
	// 新表可用：写入后能搜到。
	if _, err := s.UpsertItems([]Item{memItem("m1", "diary", "升级后写入的日记")}, "test"); err != nil {
		t.Fatalf("升级后写入：%v", err)
	}
	if got, _ := s.SearchItems("日记", SearchFilter{}); len(got.Items) != 1 {
		t.Fatalf("升级后搜索应命中 1 条：%+v", got.Items)
	}

	// 再打开一次：迁移可重复执行，不应报错也不应丢数据。
	s.Close()
	s2, err := Open(path, nil)
	if err != nil {
		t.Fatalf("重复打开：%v", err)
	}
	defer s2.Close()
	if got, _ := s2.SearchItems("日记", SearchFilter{}); len(got.Items) != 1 {
		t.Fatalf("重复打开后数据应还在：%+v", got.Items)
	}
}

func TestResetAllClearsEverything(t *testing.T) {
	s, _ := newTestStore(t)
	if _, err := s.Upsert(Batch{Fingerprint: "fp", Dims: 2,
		Items: []Vector{{ID: "v1", Hash: "h", Vec: vec(2, 1)}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertItems([]Item{memItem("m1", "diary", "一条日记")}, "test"); err != nil {
		t.Fatal(err)
	}
	n, err := s.ResetAll()
	if err != nil || n != 2 {
		t.Fatalf("ResetAll = %d, %v", n, err)
	}
	if got, _ := s.Status(""); got.Count != 0 {
		t.Fatalf("向量应清空：%+v", got)
	}
	if got, _ := s.ItemIDs(); len(got) != 0 {
		t.Fatalf("条目应清空：%v", got)
	}
	if got, _ := s.SearchItems("日记", SearchFilter{}); len(got.Items) != 0 {
		t.Fatalf("全文索引应清空：%+v", got.Items)
	}
}
