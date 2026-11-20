package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestMCPHelperProcess 是 stdio 客户端的对端：测试二进制用同一个可执行文件当子进程，
// 通过环境变量分叉出「MCP 服务器」行为，避免依赖本机装 Node/Python。
func TestMCPHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_MCP_HELPER") != "1" {
		return
	}
	reader := bufio.NewReader(os.Stdin)
	writer := os.Stdout
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var msg map[string]any
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		method, _ := msg["method"].(string)
		id, hasID := msg["id"]
		if !hasID || method == "" {
			continue
		}
		var result any
		switch method {
		case "initialize":
			result = map[string]any{
				"protocolVersion": protocolVersion,
				"serverInfo":      map[string]any{"name": "helper", "version": "1.0"},
			}
		case "tools/list":
			result = map[string]any{"tools": []any{
				map[string]any{"name": "echo", "description": "回显", "inputSchema": map[string]any{"type": "object"}},
			}}
		case "tools/call":
			result = map[string]any{"content": []any{
				map[string]any{"type": "text", "text": "你好"},
				map[string]any{"type": "image"},
			}}
		default:
			reply, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0", "id": id,
				"error": map[string]any{"code": -32601, "message": "未知方法"},
			})
			_, _ = writer.Write(append(reply, '\n'))
			continue
		}
		// tools/call 支持可配置延迟：取消路径的测试需要一个不会立刻回话的对端。
		if method == "tools/call" {
			if ms, _ := strconv.Atoi(os.Getenv("GO_MCP_HELPER_DELAY_MS")); ms > 0 {
				time.Sleep(time.Duration(ms) * time.Millisecond)
			}
		}
		reply, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
		_, _ = writer.Write(append(reply, '\n'))
	}
}

func TestStdioClientListAndCall(t *testing.T) {
	def := ServerDef{
		ID:      "helper",
		Command: os.Args[0],
		Args:    []string{"-test.run=TestMCPHelperProcess"},
		Env:     map[string]string{"GO_WANT_MCP_HELPER": "1"},
	}
	client := newStdioClient(def, nil, "test")
	defer client.Close()

	tools, err := client.ListTools(t.Context())
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(tools) != 1 || tools[0].Name != "echo" {
		t.Fatalf("工具清单不对：%+v", tools)
	}
	result, err := client.CallTool(t.Context(), "echo", map[string]any{})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if !result.OK || !strings.Contains(result.Text, "你好") || !strings.Contains(result.Text, "图片") {
		t.Fatalf("结果拍平不对：%+v", result)
	}
}

// TestHTTPClientSSE 覆盖远程传输的两条路径：SSE 响应里先来通知、再来结果。
func TestHTTPClientSSE(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var msg map[string]any
		_ = json.NewDecoder(r.Body).Decode(&msg)
		method, _ := msg["method"].(string)
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		switch method {
		case "initialize":
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%v,"result":{"protocolVersion":"%s","serverInfo":{"name":"remote"}}}`, msg["id"], protocolVersion)
		case "tools/list":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n")
			_, _ = fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":%v,\"result\":{\"tools\":[{\"name\":\"search\",\"description\":\"搜\"}]}}\n\n", msg["id"])
		case "tools/call":
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%v,"result":{"isError":true,"content":[{"type":"text","text":"失败了"}]}}`, msg["id"])
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()

	client := newHTTPClient(ServerDef{ID: "remote", URL: server.URL}, nil, "test")
	defer client.Close()

	tools, err := client.ListTools(t.Context())
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(tools) != 1 || tools[0].Name != "search" {
		t.Fatalf("工具清单不对：%+v", tools)
	}
	result, err := client.CallTool(t.Context(), "search", map[string]any{})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if result.OK || result.Text != "失败了" {
		t.Fatalf("isError 应映射成 ok=false：%+v", result)
	}
}

// 远程 MCP 服务器回 3xx 时不得跟随：Location 由对方决定，跟过去等于让它把带认证头的
// POST 弹到任意地址（含内网）。这里断言客户端把 3xx 当错误，且内网目标一次都没被访问。
func TestHTTPClientRefusesRedirect(t *testing.T) {
	var reached int32
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reached, 1)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`))
	}))
	defer inner.Close()

	outer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, inner.URL+"/victim", http.StatusTemporaryRedirect)
	}))
	defer outer.Close()

	client := newHTTPClient(ServerDef{ID: "evil", URL: outer.URL, Headers: map[string]string{"x-api-key": "sk-secret"}}, nil, "test")
	defer client.Close()

	if _, err := client.request(context.Background(), "tools/list", nil, 5*time.Second); err == nil {
		t.Fatalf("3xx 应作为错误返回，不得静默跟随")
	} else if !strings.Contains(err.Error(), "307") {
		t.Errorf("错误信息应说明收到的状态码：%v", err)
	}
	if got := atomic.LoadInt32(&reached); got != 0 {
		t.Fatalf("重定向目标不得被访问，实际访问 %d 次", got)
	}
}

// 只有「请求还没发出去」的失败才允许重试：等响应头超时说明请求已生效，
// 重发会让非幂等的 tools/call 被执行两次。
func TestIsPreSendFailureOnlyCoversConnectPhase(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"拒绝连接", errors.New("dial tcp 127.0.0.1:9: connect: connection refused"), true},
		{"DNS 失败", errors.New("dial tcp: lookup nope.invalid: no such host"), true},
		{"TLS 握手失败", errors.New("tls: handshake failure"), true},
		{"等响应头超时（请求已发出）", errors.New("net/http: timeout awaiting response headers"), false},
		{"连接被重置（可能已处理）", errors.New("read tcp 1.2.3.4:443: connection reset by peer"), false},
		{"EOF（可能已处理）", io.EOF, false},
	}
	for _, tc := range cases {
		if got := isPreSendFailure(tc.err); got != tc.want {
			t.Errorf("%s：isPreSendFailure=%v，应为 %v", tc.name, got, tc.want)
		}
	}
	if isPreSendFailure(nil) {
		t.Errorf("无错误不应判为可重试")
	}
}

// SSE 单块与单行都要有字节上限：对端不发空行就能让累积缓冲无限长。
func TestReadSSERejectsOversizedBlock(t *testing.T) {
	client := newHTTPClient(ServerDef{ID: "t"}, nil, "")
	// 一行超长、且从不发空行收尾。
	body := strings.NewReader("data: " + strings.Repeat("a", maxLineBytes) + "\n")
	_, err := client.readSSE(body, 1, 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "超过") {
		t.Fatalf("超长 SSE 块应被拒绝，实际 err=%v", err)
	}
}

func TestRegistryReusesConnectionAndStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var msg map[string]any
		_ = json.NewDecoder(r.Body).Decode(&msg)
		w.Header().Set("Content-Type", "application/json")
		switch msg["method"] {
		case "initialize":
			_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%v,"result":{"serverInfo":{"name":"r"}}}`, msg["id"])
		case "tools/list":
			_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%v,"result":{"tools":[{"name":"a"}]}}`, msg["id"])
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()

	reg := NewRegistry(nil)
	def := ServerDef{ID: "r", URL: server.URL}
	idle := reg.Status(def)
	if idle.State != "idle" {
		t.Errorf("查询状态不应启动服务器：%+v", idle)
	}
	tools, errText, err := reg.ListTools(t.Context(), def)
	if err != nil || len(tools) != 1 {
		t.Fatalf("ListTools: err=%v errText=%s tools=%v", err, errText, tools)
	}
	if got := reg.Status(def); got.State != "ready" || got.Tools != 1 {
		t.Errorf("状态不对：%+v", got)
	}
	reg.Stop("r")
	if got := reg.Status(def); got.State != "idle" {
		t.Errorf("停止后状态应回到 idle：%+v", got)
	}
}

// 请求取消只影响本次等待：子进程要继续活着（长命进程），取消时还应尽力发出
// notifications/cancelled，且 pending 表不留迟到响应。
func TestStdioRequestCancelKeepsProcessAlive(t *testing.T) {
	def := ServerDef{
		ID:      "helper",
		Command: os.Args[0],
		Args:    []string{"-test.run=TestMCPHelperProcess"},
		Env: map[string]string{
			"GO_WANT_MCP_HELPER":     "1",
			"GO_MCP_HELPER_DELAY_MS": "30000",
		},
	}
	client := newStdioClient(def, nil, "test")
	defer client.Close()

	if _, err := client.Start(t.Context()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		_, err := client.CallTool(ctx, "echo", map[string]any{})
		done <- err
	}()
	time.Sleep(200 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("取消后 request 应报错返回")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("取消没有解除 request 阻塞")
	}
	client.mu.Lock()
	alive := client.cmd != nil && client.cmd.Process != nil
	client.mu.Unlock()
	if !alive {
		t.Fatal("请求取消不应杀掉 MCP 子进程")
	}
}

// Close 的 DELETE 必须带上会话 ID：先清 sessionID 再构造请求头的写法会让
// 服务端收到一条匿名 DELETE，无法结束会话。
func TestHTTPCloseSendsSessionID(t *testing.T) {
	var gotSession string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			gotSession = r.Header.Get("Mcp-Session-Id")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var msg map[string]any
		_ = json.NewDecoder(r.Body).Decode(&msg)
		w.Header().Set("Content-Type", "application/json")
		if sid := r.Header.Get("Mcp-Session-Id"); sid == "" {
			w.Header().Set("Mcp-Session-Id", "sess-1")
		}
		_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%v,"result":{"serverInfo":{"name":"r"}}}`, msg["id"])
	}))
	defer server.Close()

	client := newHTTPClient(ServerDef{ID: "remote", URL: server.URL}, nil, "test")
	if _, err := client.Start(t.Context()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	client.Close()
	if gotSession != "sess-1" {
		t.Fatalf("DELETE 应携带会话 ID，实际 %q", gotSession)
	}
}

// Close 后允许重新 Start：远程会话状态要全部复位，不能拿旧的 initDone 直接成功。
func TestHTTPClientRestartAfterClose(t *testing.T) {
	var inits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var msg map[string]any
		_ = json.NewDecoder(r.Body).Decode(&msg)
		if msg["method"] == "initialize" {
			atomic.AddInt32(&inits, 1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%v,"result":{"serverInfo":{"name":"r"}}}`, msg["id"])
	}))
	defer server.Close()

	client := newHTTPClient(ServerDef{ID: "remote", URL: server.URL}, nil, "test")
	defer client.Close()
	if _, err := client.Start(t.Context()); err != nil {
		t.Fatalf("第一次 Start: %v", err)
	}
	client.Close()
	if _, err := client.Start(t.Context()); err != nil {
		t.Fatalf("Close 后 Start 应重新握手：%v", err)
	}
	if got := atomic.LoadInt32(&inits); got != 2 {
		t.Fatalf("重启应重新 initialize 一次，实际 %d 次", got)
	}
}

func TestUnavailableTransport(t *testing.T) {
	reg := NewRegistry(nil)
	_, errText, err := reg.ListTools(t.Context(), ServerDef{ID: "x"})
	if err == nil || !strings.Contains(errText, "既没有地址") {
		t.Fatalf("缺少传输方式时应报可操作错误：err=%v text=%s", err, errText)
	}
}

func TestStdioHelperCompiles(t *testing.T) {
	// 防止 helper 分支被误删导致上面两个用例变成「子进程直接退出」。
	cmd := exec.Command(os.Args[0], "-test.run=TestMCPHelperProcess")
	cmd.Env = append(os.Environ(), "GO_WANT_MCP_HELPER=1")
	cmd.Stdin = strings.NewReader("")
	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("helper 启动失败：%v", err)
		}
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("helper 没有退出")
	}
}

// MCP 地址常写成 https://host/mcp?token=…：连接失败文案会进工具结果、
// 被模型转述给上游 AI 服务商，因此错误信息里不得带路径与查询串。
func TestConnectErrorHidesTokenInURL(t *testing.T) {
	client := newHTTPClient(ServerDef{
		ID:  "remote",
		URL: "http://127.0.0.1:9/mcp/endpoint?token=supersecret123",
	}, nil, "test")
	defer client.Close()

	_, err := client.request(context.Background(), "tools/list", nil, 2*time.Second)
	if err == nil {
		t.Fatalf("连不上应报错")
	}
	msg := err.Error()
	if strings.Contains(msg, "supersecret123") {
		t.Fatalf("错误文案不得带查询串里的 token：%s", msg)
	}
	if strings.Contains(msg, "/mcp/endpoint") {
		t.Fatalf("错误文案不应带路径：%s", msg)
	}
	if !strings.Contains(msg, "127.0.0.1") {
		t.Errorf("主机要保留，否则用户没法排查：%s", msg)
	}
}

// 启动日志会把命令行原样记下来，而 MCP 配置常写成 --api-key sk-…：
// 日志可被导出贴到 issue，参数里的密钥必须先打码。
func TestDescribeCommandRedactsArgs(t *testing.T) {
	got := describeCommand("npx", []string{"-y", "@acme/mcp-server", "--api-key", "sk-abcdefghijklmn", "--port", "3000"})
	if strings.Contains(got, "sk-abcdefghijklmn") {
		t.Fatalf("启动日志不得带出参数里的密钥：%s", got)
	}
	// 命令名与普通参数必须留着，否则这行日志失去诊断价值。
	for _, keep := range []string{"npx", "@acme/mcp-server", "--port", "3000"} {
		if !strings.Contains(got, keep) {
			t.Errorf("应保留 %q：%s", keep, got)
		}
	}
	if got := describeCommand("node", nil); got != "node" {
		t.Errorf("无参数时只给命令名：%q", got)
	}
}
