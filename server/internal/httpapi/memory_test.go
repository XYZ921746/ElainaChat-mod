package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"elainachat/server/internal/memoryindex"
)

func newMemoryTestServer(t *testing.T) *Server {
	t.Helper()
	s, root := newTestServer(t)
	index, err := memoryindex.Open(filepath.Join(root, "data", "cache", "memory_index.db"), nil)
	if err != nil {
		t.Fatalf("打开记忆索引: %v", err)
	}
	t.Cleanup(index.Close)
	s.SetMemoryIndex(index)
	return s
}

func TestMemoryIndexHTTPRoundTrip(t *testing.T) {
	s := newMemoryTestServer(t)

	rec := doRequest(s, http.MethodGet, "/api/memory/index/status?fingerprint=fp-a", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var status map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &status)
	if status["count"].(float64) != 0 {
		t.Fatalf("初始 count 应为 0：%v", status)
	}

	vec := base64.StdEncoding.EncodeToString([]byte{129, 128, 127, 126})
	body := []byte(`{"fingerprint":"fp-a","dims":4,"items":[{"id":"diary:1","h":"h1","v":"` + vec + `"}]}`)
	rec = doRequest(s, http.MethodPost, "/api/memory/index/upsert", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("upsert = %d: %s", rec.Code, rec.Body.String())
	}

	rec = doRequest(s, http.MethodGet, "/api/memory/index/status?fingerprint=fp-a", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &status)
	if status["count"].(float64) != 1 || status["dims"].(float64) != 4 {
		t.Fatalf("upsert 后 status 不对：%v", status)
	}

	rec = doRequest(s, http.MethodGet, "/api/memory/index?fingerprint=fp-a", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("load = %d: %s", rec.Code, rec.Body.String())
	}
	var loaded struct {
		Items map[string]struct {
			H string `json:"h"`
			V string `json:"v"`
		} `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &loaded)
	if loaded.Items["diary:1"].H != "h1" || loaded.Items["diary:1"].V != vec {
		t.Fatalf("load 内容不对：%+v", loaded.Items)
	}

	rec = doRequest(s, http.MethodPost, "/api/memory/index/delete", []byte(`{"ids":["diary:1"]}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete = %d: %s", rec.Code, rec.Body.String())
	}
	rec = doRequest(s, http.MethodGet, "/api/memory/index/status?fingerprint=fp-a", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &status)
	if status["count"].(float64) != 0 {
		t.Fatalf("delete 后 count 应为 0：%v", status)
	}

	if rec := doRequest(s, http.MethodPost, "/api/memory/index/reset", []byte(`{}`)); rec.Code != http.StatusOK {
		t.Fatalf("reset = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestMemoryIndexUnavailableAndBadPayload(t *testing.T) {
	// 没有注入索引：页面探测必须拿到 501，才能回退 Store 键。
	plain, _ := newTestServer(t)
	if rec := doRequest(plain, http.MethodGet, "/api/memory/index/status?fingerprint=fp", nil); rec.Code != http.StatusNotImplemented {
		t.Fatalf("无索引应 501，实得 %d", rec.Code)
	}

	s := newMemoryTestServer(t)
	cases := []struct {
		name string
		body []byte
	}{
		{"空体", nil},
		{"坏 JSON", []byte(`{`)},
		{"维度不符", []byte(`{"fingerprint":"fp","dims":3,"items":[{"id":"a","h":"h","v":"AAA="}]}`)},
		{"坏 base64", []byte(`{"fingerprint":"fp","dims":2,"items":[{"id":"a","h":"h","v":"!!!"}]}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doRequest(s, http.MethodPost, "/api/memory/index/upsert", tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("应 400，实得 %d：%s", rec.Code, rec.Body.String())
			}
		})
	}
	if rec := doRequest(s, http.MethodGet, "/api/memory/index", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("缺 fingerprint 应 400，实得 %d", rec.Code)
	}
	if rec := doRequest(s, http.MethodGet, "/api/memory/nope", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("未知接口应 404，实得 %d", rec.Code)
	}
}

type memoryItemJSON struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	ScopeType   string  `json:"scopeType"`
	ScopeID     string  `json:"scopeId"`
	Content     string  `json:"content"`
	Summary     string  `json:"summary"`
	ContentHash string  `json:"contentHash"`
	ValidFrom   int64   `json:"validFrom"`
	Importance  float64 `json:"importance"`
}

func TestMemoryItemsHTTPRoundTrip(t *testing.T) {
	s := newMemoryTestServer(t)

	payload := map[string]any{
		"reason": "smoke",
		"items": []memoryItemJSON{
			{ID: "diary:c1|2026年11月9日", Kind: "diary", ScopeType: "conversation", ScopeID: "c1",
				Content: "今天和用户在咖啡店聊了很远的旅行计划", Summary: "咖啡店 旅行计划",
				ContentHash: "h1", ValidFrom: 1762646400000, Importance: 0.6},
			{ID: "preference:1", Kind: "preference", Content: "用户喜欢手冲咖啡，不加糖",
				ContentHash: "h2", Importance: 0.9},
		},
	}
	body, _ := json.Marshal(payload)
	rec := doRequest(s, http.MethodPost, "/api/memory/items/upsert", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("upsert = %d: %s", rec.Code, rec.Body.String())
	}
	var upsert struct {
		OK       bool   `json:"ok"`
		Upserted int    `json:"upserted"`
		FTS      string `json:"fts"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &upsert)
	if !upsert.OK || upsert.Upserted != 2 {
		t.Fatalf("upsert 结果不对：%s", rec.Body.String())
	}
	if upsert.FTS != "elaina_bigram" {
		t.Fatalf("FTS 分词器应为 elaina_bigram，实得 %q", upsert.FTS)
	}

	rec = doRequest(s, http.MethodGet, "/api/memory/items/ids", nil)
	var ids struct {
		IDs []string `json:"ids"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &ids)
	if rec.Code != http.StatusOK || len(ids.IDs) != 2 {
		t.Fatalf("ids = %d %v: %s", rec.Code, ids.IDs, rec.Body.String())
	}

	// 两字中文查询（unicode61 / trigram 都会落空）必须走 FTS 命中。
	rec = doRequest(s, http.MethodGet, "/api/memory/search?q=%E5%92%96%E5%95%A1", nil)
	var search struct {
		Mode  string           `json:"mode"`
		Items []memoryItemJSON `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &search)
	if rec.Code != http.StatusOK || search.Mode != "fts" || len(search.Items) != 2 {
		t.Fatalf("search = %d mode=%s items=%d: %s", rec.Code, search.Mode, len(search.Items), rec.Body.String())
	}

	rec = doRequest(s, http.MethodGet, "/api/memory/search?q=%E5%92%96%E5%95%A1&kind=preference&limit=5", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &search)
	if len(search.Items) != 1 || search.Items[0].Kind != "preference" {
		t.Fatalf("kind 过滤不对：%s", rec.Body.String())
	}

	rec = doRequest(s, http.MethodGet, "/api/memory/timeline?limit=10", nil)
	var timeline struct {
		Items []memoryItemJSON `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &timeline)
	if rec.Code != http.StatusOK || len(timeline.Items) != 2 {
		t.Fatalf("timeline = %d: %s", rec.Code, rec.Body.String())
	}

	rec = doRequest(s, http.MethodPost, "/api/memory/items/delete", []byte(`{"ids":["preference:1"],"reason":"prune"}`))
	var del struct {
		Deleted int `json:"deleted"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &del)
	if rec.Code != http.StatusOK || del.Deleted != 1 {
		t.Fatalf("delete = %d: %s", rec.Code, rec.Body.String())
	}
	rec = doRequest(s, http.MethodGet, "/api/memory/search?q=%E6%89%8B%E5%86%B2", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &search)
	if len(search.Items) != 0 {
		t.Fatalf("已删除条目不该被搜到：%s", rec.Body.String())
	}
}

func TestMemoryItemsHTTPRejectsBadPayload(t *testing.T) {
	plain, _ := newTestServer(t)
	if rec := doRequest(plain, http.MethodPost, "/api/memory/items/upsert", []byte(`{"items":[]}`)); rec.Code != http.StatusNotImplemented {
		t.Fatalf("索引关闭时应 501，实得 %d", rec.Code)
	}

	s := newMemoryTestServer(t)
	cases := []struct {
		name string
		path string
		body []byte
		want int
	}{
		{"空体", "/api/memory/items/upsert", nil, http.StatusBadRequest},
		{"坏 JSON", "/api/memory/items/upsert", []byte(`{`), http.StatusBadRequest},
		{"坏 kind", "/api/memory/items/upsert",
			[]byte(`{"items":[{"id":"a","kind":"Diary","content":"x"}]}`), http.StatusBadRequest},
		{"空 content", "/api/memory/items/upsert",
			[]byte(`{"items":[{"id":"a","kind":"diary","content":""}]}`), http.StatusBadRequest},
		{"limit 非法", "/api/memory/search?q=x&limit=abc", nil, http.StatusBadRequest},
		{"缺 q", "/api/memory/search", nil, http.StatusBadRequest},
		{"删除 id 非法", "/api/memory/items/delete", []byte(`{"ids":[""]}`), http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			method := http.MethodPost
			if strings.Contains(tc.path, "/search") {
				method = http.MethodGet
			}
			rec := doRequest(s, method, tc.path, tc.body)
			if rec.Code != tc.want {
				t.Fatalf("应 %d，实得 %d：%s", tc.want, rec.Code, rec.Body.String())
			}
		})
	}

	// 单批 > 256 条：400，不是 500。
	tooMany := make([]memoryItemJSON, 257)
	for i := range tooMany {
		tooMany[i] = memoryItemJSON{ID: "id-" + strconv.Itoa(i), Kind: "diary", Content: "x"}
	}
	body, _ := json.Marshal(map[string]any{"items": tooMany})
	if rec := doRequest(s, http.MethodPost, "/api/memory/items/upsert", body); rec.Code != http.StatusBadRequest {
		t.Fatalf("超批应 400，实得 %d：%s", rec.Code, rec.Body.String())
	}

	// 方法不对：405，而不是 404。
	if rec := doRequest(s, http.MethodGet, "/api/memory/items/upsert", nil); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET upsert 应 405，实得 %d", rec.Code)
	}
}

func TestMemoryCoreHTTPRoundTrip(t *testing.T) {
	s := newMemoryTestServer(t)

	core := map[string]any{
		"diary": []map[string]any{{
			"conversationId": "c1", "conversationTitle": "咖啡店",
			"date": "2026年11月9日", "content": "今天聊了旅行计划", "essences": []string{"咖啡店"},
		}},
		"promise":    []string{"每周日一起看一部电影"},
		"preference": []string{},
		"plan":       []map[string]any{{"date": "2026年11月20日", "content": "去看日出"}},
		"motivation": []string{},
	}
	body, _ := json.Marshal(map[string]any{"core": core, "reason": "smoke"})
	rec := doRequest(s, http.MethodPost, "/api/memory/core", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT core = %d: %s", rec.Code, rec.Body.String())
	}
	var put struct {
		Core memoryindex.Core `json:"core"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &put)
	if len(put.Core.Diary) != 1 || put.Core.Diary[0].ID != "diary:c1|2026年11月9日" {
		t.Fatalf("PUT 后 canonical core 缺 id：%+v", put.Core.Diary)
	}

	rec = doRequest(s, http.MethodGet, "/api/memory/core", nil)
	var get struct {
		Core memoryindex.Core `json:"core"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &get)
	if rec.Code != http.StatusOK || len(get.Core.Promise) != 1 || len(get.Core.Diary) != 1 {
		t.Fatalf("GET core = %d: %s", rec.Code, rec.Body.String())
	}
	// id 一致 + 附加字段无损
	if get.Core.Diary[0].ConversationTitle != "咖啡店" || get.Core.Plan[0].Date != "2026年11月20日" {
		t.Fatalf("GET core 附加字段丢失：%+v", get.Core)
	}

	// 二次 PUT：drop 掉约定与日记（模拟整类目替换后条目消失）。
	core["promise"] = []string{}
	core["diary"] = []map[string]any{}
	body, _ = json.Marshal(map[string]any{
		"core": core,
		"dropIds": []string{
			"promise:cdfa01cf",
			"diary:c1|2026年11月9日",
		},
	})
	rec = doRequest(s, http.MethodPost, "/api/memory/core", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT core(drop) = %d: %s", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &get)
	if len(get.Core.Promise) != 0 || len(get.Core.Diary) != 0 {
		t.Fatalf("drop 后应消失：%+v", get.Core)
	}
	rec = doRequest(s, http.MethodGet, "/api/memory/core", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &get)
	if len(get.Core.Plan) != 1 || len(get.Core.Preference) != 0 {
		t.Fatalf("未 drop 的类目应保留：%+v", get.Core)
	}

	// 坏 core：400
	if rec := doRequest(s, http.MethodPost, "/api/memory/core", []byte(`{"core":{"diary":"not-array"}}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("坏 core 应 400，实得 %d", rec.Code)
	}
}

func TestMemoryCoreUnavailableIs501(t *testing.T) {
	plain, _ := newTestServer(t)
	if rec := doRequest(plain, http.MethodGet, "/api/memory/core", nil); rec.Code != http.StatusNotImplemented {
		t.Fatalf("无库时应 501，实得 %d", rec.Code)
	}
	if rec := doRequest(plain, http.MethodPost, "/api/memory/core", []byte(`{"core":{}}`)); rec.Code != http.StatusNotImplemented {
		t.Fatalf("无库时应 501，实得 %d", rec.Code)
	}
}

func TestMemoryIndexBeginCommitHTTP(t *testing.T) {
	s := newMemoryTestServer(t)
	vec := base64.StdEncoding.EncodeToString([]byte{129, 128, 127, 126})

	rec := doRequest(s, http.MethodPost, "/api/memory/index/begin", []byte(`{"fingerprint":"fp-b","dims":4}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("begin = %d: %s", rec.Code, rec.Body.String())
	}
	var begin struct {
		BuildID string `json:"buildId"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &begin)
	if begin.BuildID == "" {
		t.Fatalf("begin 没返回 buildId：%s", rec.Body.String())
	}

	body := []byte(`{"fingerprint":"fp-b","dims":4,"buildId":"` + begin.BuildID + `","items":[{"id":"a","h":"h","v":"` + vec + `"}]}`)
	if rec := doRequest(s, http.MethodPost, "/api/memory/index/upsert", body); rec.Code != http.StatusOK {
		t.Fatalf("构建中 upsert = %d: %s", rec.Code, rec.Body.String())
	}
	var status map[string]any
	rec = doRequest(s, http.MethodGet, "/api/memory/index/status?fingerprint=fp-b", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &status)
	if status["ready"] != false || status["count"].(float64) != 0 {
		t.Fatalf("未 commit 的 status 应 ready=false/count=0：%v", status)
	}

	if rec := doRequest(s, http.MethodPost, "/api/memory/index/commit", []byte(`{"fingerprint":"fp-b","buildId":"`+begin.BuildID+`"}`)); rec.Code != http.StatusOK {
		t.Fatalf("commit = %d: %s", rec.Code, rec.Body.String())
	}
	rec = doRequest(s, http.MethodGet, "/api/memory/index/status?fingerprint=fp-b", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &status)
	if status["ready"] != true || status["count"].(float64) != 1 {
		t.Fatalf("commit 后 status 不对：%v", status)
	}

	// 再次 begin 无条件接管；旧 build 的提交必须 409。
	rec = doRequest(s, http.MethodPost, "/api/memory/index/begin", []byte(`{"fingerprint":"fp-b","dims":4}`))
	var begin2 struct {
		BuildID string `json:"buildId"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &begin2)
	if rec := doRequest(s, http.MethodPost, "/api/memory/index/commit", []byte(`{"fingerprint":"fp-b","buildId":"`+begin.BuildID+`"}`)); rec.Code != http.StatusConflict {
		t.Fatalf("旧 build commit 应 409，实得 %d：%s", rec.Code, rec.Body.String())
	}
	oldBody := []byte(`{"fingerprint":"fp-b","dims":4,"buildId":"` + begin.BuildID + `","items":[{"id":"stale","h":"h","v":"` + vec + `"}]}`)
	if rec := doRequest(s, http.MethodPost, "/api/memory/index/upsert", oldBody); rec.Code != http.StatusConflict {
		t.Fatalf("旧 build upsert 应 409，实得 %d：%s", rec.Code, rec.Body.String())
	}
	if rec := doRequest(s, http.MethodPost, "/api/memory/index/commit", []byte(`{"fingerprint":"fp-b","buildId":"`+begin2.BuildID+`"}`)); rec.Code != http.StatusOK {
		t.Fatalf("新 build commit = %d: %s", rec.Code, rec.Body.String())
	}

	// 按指纹删除：只删该桶。
	if rec := doRequest(s, http.MethodPost, "/api/memory/index/delete", []byte(`{"fingerprint":"fp-b","ids":["a"]}`)); rec.Code != http.StatusOK {
		t.Fatalf("按指纹 delete = %d: %s", rec.Code, rec.Body.String())
	}
}
