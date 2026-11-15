package relay

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"elainachat/server/internal/logx"
)

func makeRequest(t *testing.T, target, method string, headers map[string]any, body any, timeoutMs float64, remote string) *http.Request {
	t.Helper()
	payload := map[string]any{
		"url":     target,
		"method":  method,
		"headers": headers,
	}
	if body != nil {
		payload["body"] = body
	}
	if timeoutMs > 0 {
		payload["timeoutMs"] = timeoutMs
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/relay", bytes.NewReader(raw))
	req.RemoteAddr = remote
	return req
}

func localRequest(t *testing.T, target, method string, headers map[string]any, body any) *http.Request {
	return makeRequest(t, target, method, headers, body, 0, "127.0.0.1:45678")
}

func TestForwardJSONAndHeaders(t *testing.T) {
	var gotMethod string
	var gotHeaders http.Header
	var gotBody []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotHeaders = r.Header.Clone()
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"ok":true,"answer":"你好"}`))
	}))
	defer upstream.Close()

	h := New(logx.Discard())
	req := localRequest(t, upstream.URL, "POST", map[string]any{
		"Content-Type":   "application/json",
		"X-Test":         "1",
		"Cookie":         "secret=1",
		"Origin":         "http://evil.example",
		"Host":           "evil.example",
		"Content-Length": "999",
	}, map[string]any{"hello": "world"})
	rec := httptest.NewRecorder()
	h.Handle(rec, req)

	if rec.Code != 200 {
		t.Fatalf("状态码 %d：%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "你好") {
		t.Fatalf("响应未透传：%s", rec.Body.String())
	}
	if gotMethod != "POST" {
		t.Fatalf("方法应转发为 POST，实际 %s", gotMethod)
	}
	if gotHeaders.Get("X-Test") != "1" {
		t.Fatalf("自定义头未转发：%v", gotHeaders)
	}
	if gotHeaders.Get("Cookie") != "" || gotHeaders.Get("Origin") != "" {
		t.Fatalf("浏览器身份头不应外发：%v", gotHeaders)
	}
	if gotHeaders.Get("Accept-Encoding") != "identity" {
		t.Fatalf("accept-encoding 应为 identity，实际 %q", gotHeaders.Get("Accept-Encoding"))
	}
	if string(gotBody) != `{"hello":"world"}` {
		t.Fatalf("请求体不一致：%s", gotBody)
	}
}

func TestSSRFBlockedForNonLocal(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("公网来源不应到达回环上游")
	}))
	defer upstream.Close()

	h := New(logx.Discard())
	req := makeRequest(t, upstream.URL, "GET", nil, nil, 0, "192.0.2.10:1234")
	rec := httptest.NewRecorder()
	h.Handle(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("应拒绝公网来源访问回环，实际 %d：%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "relayError") {
		t.Fatalf("错误响应应带 relayError：%s", rec.Body.String())
	}
}

// 手机通过局域网访问电脑端服务时，来源是 LAN 地址；本机/局域网自建服务商必须能走中转。
func TestInternalAllowedForLAN(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"local-model"}]}`))
	}))
	defer upstream.Close()

	h := New(logx.Discard())
	req := makeRequest(t, upstream.URL, "GET", nil, nil, 0, "192.168.1.50:45678")
	rec := httptest.NewRecorder()
	h.Handle(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("局域网来源访问内网服务商应放行，实际 %d：%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "local-model") {
		t.Fatalf("响应未透传：%s", rec.Body.String())
	}
}

// 监听 0.0.0.0 / :: 是用户主动开放应用：手机走公网地址或局域网 IPv6 时也不该被来源判定挡住。
func TestInternalAllowedWhenTrustAllClients(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"local-model"}]}`))
	}))
	defer upstream.Close()

	h := New(logx.Discard())
	h.SetTrustAllClients(true)
	req := makeRequest(t, upstream.URL, "GET", nil, nil, 0, "203.0.113.9:45678")
	rec := httptest.NewRecorder()
	h.Handle(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("开放监听时公网来源访问内网服务商也应放行，实际 %d：%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "local-model") {
		t.Fatalf("响应未透传：%s", rec.Body.String())
	}
}

func TestMetadataHostDenied(t *testing.T) {
	h := New(logx.Discard())
	req := localRequest(t, "http://169.254.169.254/latest/meta-data/", "GET", nil, nil)
	rec := httptest.NewRecorder()
	h.Handle(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("云元数据地址应被拒绝，实际 %d：%s", rec.Code, rec.Body.String())
	}

	// 开放监听也不放行元数据地址。
	h.SetTrustAllClients(true)
	req = makeRequest(t, "http://169.254.169.254/latest/meta-data/", "GET", nil, nil, 0, "203.0.113.9:45678")
	rec = httptest.NewRecorder()
	h.Handle(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("开放监听时云元数据地址仍应被拒绝，实际 %d：%s", rec.Code, rec.Body.String())
	}
}

func TestUnsupportedMethodAndScheme(t *testing.T) {
	h := New(logx.Discard())
	rec := httptest.NewRecorder()
	h.Handle(rec, localRequest(t, "http://127.0.0.1:1/", "CONNECT", nil, nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("CONNECT 应返回 400，实际 %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.Handle(rec, localRequest(t, "ftp://example.com/x", "GET", nil, nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("ftp 应返回 400，实际 %d", rec.Code)
	}
}

func TestUpstreamErrorForwarded(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	defer upstream.Close()

	h := New(logx.Discard())
	rec := httptest.NewRecorder()
	h.Handle(rec, localRequest(t, upstream.URL, "POST", nil, map[string]any{"model": "x"}))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("上游状态码应原样透传，实际 %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "rate limited") {
		t.Fatalf("上游错误体应透传：%s", rec.Body.String())
	}
}

func TestSSEForwarded(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer upstream.Close()

	h := New(logx.Discard())
	rec := httptest.NewRecorder()
	h.Handle(rec, localRequest(t, upstream.URL, "POST", nil, map[string]any{"stream": true}))
	if rec.Code != 200 {
		t.Fatalf("状态码 %d", rec.Code)
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("Content-Type 应保持 SSE：%s", rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), `"content":"你"`) {
		t.Fatalf("SSE 分片未透传：%s", rec.Body.String())
	}
}

func TestTimeoutWaitingHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(1500 * time.Millisecond)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	h := New(logx.Discard())
	rec := httptest.NewRecorder()
	h.Handle(rec, makeRequest(t, upstream.URL, "POST", nil, map[string]any{"x": 1}, 1000, "127.0.0.1:1"))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("等待响应头超时应回 502，实际 %d：%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "没有响应") {
		t.Fatalf("错误文案应说明超时：%s", rec.Body.String())
	}
}

func TestTraceHelpers(t *testing.T) {
	req := `{"model":"m1","system":"sys","messages":[{"role":"user","content":"你好"},{"role":"assistant","content":[{"type":"text","text":"在"}]}]}`
	summary := summarizeChat(req)
	if summary == nil || summary.Model != "m1" || len(summary.Messages) != 3 {
		t.Fatalf("请求摘要不对：%+v", summary)
	}
	if summary.Messages[2].Text != "在" {
		t.Fatalf("数组内容应拍平：%+v", summary.Messages[2])
	}

	if got := extractReplyText(map[string]any{
		"choices": []any{map[string]any{"delta": map[string]any{"content": "片段"}}},
	}); got != "片段" {
		t.Fatalf("应抽出 delta 文本，实际 %q", got)
	}
	if got := parseSSEReply("data: {\"delta\":{\"text\":\"A\"}}\ndata: {\"delta\":{\"text\":\"B\"}}\ndata: [DONE]\n"); got != "AB" {
		t.Fatalf("SSE 回复拼接失败：%q", got)
	}
	if got := parseSSEError("data: {\"type\":\"error\",\"error\":{\"message\":\"boom\"}}\n"); got != "boom" {
		t.Fatalf("SSE 内报错应被挖出，实际 %q", got)
	}
	if got := extractErrorText(`{"detail":{"error":{"message":"deep"}}}`); got != "deep" {
		t.Fatalf("错误原因挖掘失败：%q", got)
	}
	if got := flattenContent([]any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": "AAAA"}}}); !strings.Contains(got, "图片") {
		t.Fatalf("图片不应把 base64 记进日志：%q", got)
	}
}
