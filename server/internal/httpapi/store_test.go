package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elainachat/server/internal/agent"
	"elainachat/server/internal/auth"
	"elainachat/server/internal/config"
	"elainachat/server/internal/logx"
	"elainachat/server/internal/plugin"
	"elainachat/server/internal/store"
)

func newTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	cfg := &config.Config{
		AppRoot:   root,
		WebRoot:   filepath.Join(root, "web"),
		DataDir:   filepath.Join(root, "data"),
		ModsDir:   filepath.Join(root, "mods"),
		SkillsDir: filepath.Join(root, "skills"),
		Host:      "127.0.0.1",
		Port:      4199,
	}
	log := logx.Discard()
	authStore := auth.NewStore(cfg.DataDir, filepath.Join(cfg.WebRoot, ".local-auth.json"), log)
	if _, err := authStore.Ensure(); err != nil {
		t.Fatalf("初始化鉴权失败：%v", err)
	}
	dataStore := store.New(cfg.DataDir, log)
	return New(cfg, log, authStore, auth.NewGuard(), nil, dataStore, plugin.New(cfg.ModsDir, log), nil, agent.New(cfg.AppRoot, cfg.DataDir, dataStore, log)), root
}

func doRequest(s *Server, method, path string, body []byte) *httptest.ResponseRecorder {
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.RemoteAddr = "127.0.0.1:45678"
	req.Host = "127.0.0.1:4199"
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func TestStoreHTTPRoundTrip(t *testing.T) {
	s, root := newTestServer(t)

	post := map[string]any{"data": map[string]any{"elaina_demo": "hello"}}
	raw, _ := json.Marshal(post)
	rec := doRequest(s, http.MethodPost, "/api/store", raw)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/store 返回 %d：%s", rec.Code, rec.Body.String())
	}

	rec = doRequest(s, http.MethodGet, "/api/store", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/store 返回 %d", rec.Code)
	}
	var got struct {
		OK   bool              `json:"ok"`
		Data map[string]string `json:"data"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &got) != nil {
		t.Fatalf("响应不是合法 JSON：%s", rec.Body.String())
	}
	if got.Data["elaina_demo"] != "hello" {
		t.Fatalf("数据未保存：%v", got.Data)
	}
	if _, err := os.Stat(filepath.Join(root, "data", "main", "store.json")); err != nil {
		t.Fatalf("数据未落盘：%v", err)
	}

	// null 是删除标记。
	del := map[string]any{"data": map[string]any{"elaina_demo": nil}}
	raw, _ = json.Marshal(del)
	if rec := doRequest(s, http.MethodPost, "/api/store", raw); rec.Code != http.StatusOK {
		t.Fatalf("删除请求返回 %d", rec.Code)
	}
	rec = doRequest(s, http.MethodGet, "/api/store", nil)
	got = struct {
		OK   bool              `json:"ok"`
		Data map[string]string `json:"data"`
	}{}
	if json.Unmarshal(rec.Body.Bytes(), &got) != nil {
		t.Fatal("响应非法")
	}
	if _, exists := got.Data["elaina_demo"]; exists {
		t.Fatal("null 删除标记没有生效")
	}
}

func TestStoreHTTPRejectsOversizedKey(t *testing.T) {
	s, _ := newTestServer(t)
	huge := strings.Repeat("x", storeKeyMaxChars+1)
	body, _ := json.Marshal(map[string]any{"data": map[string]any{"elaina_open_conversations": huge}})
	rec := doRequest(s, http.MethodPost, "/api/store", body)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超限键应返回 413，实际 %d：%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "KEY_TOO_LARGE") {
		t.Fatalf("响应缺少 KEY_TOO_LARGE：%s", rec.Body.String())
	}
}

func TestModIndexHTTP(t *testing.T) {
	s, root := newTestServer(t)
	modDir := filepath.Join(root, "mods", "demo-1.0.0")
	if err := os.MkdirAll(modDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"id":"demo","name":"示例","version":"1.0.0","entry":"index.js"}`
	if err := os.WriteFile(filepath.Join(modDir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}

	rec := doRequest(s, http.MethodGet, "/mods/index.json", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("/mods/index.json 返回 %d：%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"id": "demo"`) {
		t.Fatalf("清单缺少插件：%s", rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "mods", "index.json")); err != nil {
		t.Fatalf("清单未落盘：%v", err)
	}
}

// SSE 是无限长的连接：关闭流程必须先让它返回，否则 Shutdown 只能等满超时。
func TestStoreStreamStopsOnBeginShutdown(t *testing.T) {
	s := &Server{storeHub: newStoreHub(), closing: make(chan struct{})}
	rec := httptest.NewRecorder()
	lw := &logWriter{ResponseWriter: rec}
	req := httptest.NewRequest(http.MethodGet, "/api/store/stream?client=test", nil)

	done := make(chan struct{})
	go func() {
		s.handleStoreStream(lw, req)
		close(done)
	}()

	s.BeginShutdown()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("BeginShutdown 后 SSE 处理函数仍不返回")
	}
	if !strings.Contains(rec.Body.String(), ": connected") {
		t.Fatalf("SSE 首包缺失：%q", rec.Body.String())
	}
}

// 广播载荷必须是完整的 SSE data 帧：浏览器只认 data: 前缀，裸 JSON 会被当未知字段静默忽略。
func TestStoreHubBroadcastFramesPayload(t *testing.T) {
	h := newStoreHub()
	sub := h.add("")
	h.broadcast([]byte(`{"type":"memory-change"}`), "")
	select {
	case got := <-sub.ch:
		if string(got) != "data: {\"type\":\"memory-change\"}\n\n" {
			t.Fatalf("广播载荷应为 SSE data 帧：%q", got)
		}
	default:
		t.Fatal("广播后订阅者通道为空")
	}
}

// 缓冲写满的订阅者被断开而不是丢事件：通道关闭让 SSE 处理函数返回，
// 浏览器 EventSource 自动重连后由前端全量对齐；静默丢帧对前端来说是永远不会再来的。
func TestStoreHubDisconnectsSlowSubscriberOnOverflow(t *testing.T) {
	h := newStoreHub()
	sub := h.add("client-a")
	other := h.add("client-b")
	for i := 0; i < storeSubBuffer; i++ {
		h.broadcast([]byte(`{"type":"store-change"}`), "")
	}
	// 缓冲已满：这一次广播触发断开，而不是挤掉事件
	h.broadcast([]byte(`{"type":"store-change"}`), "")
	for i := 0; i < storeSubBuffer; i++ {
		if _, ok := <-sub.ch; !ok {
			t.Fatalf("缓冲内第 %d 帧不应缺失", i)
		}
	}
	if _, ok := <-sub.ch; ok {
		t.Fatal("缓冲满后的广播应断开慢订阅者（通道应已关闭）")
	}
	// 已断开的订阅者不进新帧，后续广播也不能 panic；其它订阅者不受牵连
	h.broadcast([]byte(`{"type":"store-change"}`), "")
	if _, ok := <-sub.ch; ok {
		t.Fatal("已断开的订阅者不应再收到事件")
	}
	select {
	case got := <-other.ch:
		if !strings.HasPrefix(string(got), "data: ") {
			t.Fatalf("未溢出的订阅者应照常收到帧：%q", got)
		}
	default:
		t.Fatal("慢订阅者断开不应影响其它订阅者")
	}
}
