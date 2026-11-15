package relay

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elainachat/server/internal/logx"
)

// TLS 回退判据的行为表：第一判据是「请求是否已经发出」，
// 其次排除重试也没用的两类（用户取消、DNS 失败）。
// 无条件降级等于让所有上游都丢掉 TLS 1.3 的前向保密；
// 而请求已发出后的失败若重发，会产生第二条相同的 POST（AI 请求重复计费）。
func TestRetryableTLSClassification(t *testing.T) {
	cases := []struct {
		name string
		err  error
		sent bool
		want bool
	}{
		{"TLS 握手失败（未发出）", errors.New("tls: handshake failure"), false, true},
		{"对端回 TLS alert（未发出）", errors.New("remote error: tls: bad record MAC"), false, true},
		// Node 版 UND_ERR_CONNECT_TIMEOUT：TCP 通了但握手卡死，请求体还没发。
		{"拨号超时（未发出）", errors.New("dial tcp 140.82.112.3:443: i/o timeout"), false, true},
		{"握手阶段 EOF（未发出）", io.EOF, false, true},
		// 请求已发出：上游可能已执行，任何重试都会产生第二条相同的 POST。
		{"等响应头超时（已发出，不得重试）", errors.New("net/http: timeout awaiting response headers"), true, false},
		{"连接被重置（已发出，不得重试）", errors.New("read tcp 140.82.112.3:443: connection reset by peer"), true, false},
		{"EOF（已发出，不得重试）", io.EOF, true, false},
		{"握手失败但已发出（不得重试）", errors.New("tls: handshake failure"), true, false},
		// Node 版 ENOTFOUND：DNS 失败不是 TLS 问题，回退也没用。
		{"DNS 解析失败", errors.New("dial tcp: lookup api.example.com: no such host"), false, false},
		// Node 版 AbortError：用户点了停止，重试只会拖慢停止。
		{"用户取消", context.Canceled, false, false},
		// 差异说明：Node 版把 ECONNREFUSED 判为「不是握手失败」（不重试）；
		// Go 侧把「拒绝连接」算作连接建立阶段失败，会多付一次回退重试。
		// 有界（只重试一次）、请求体尚未发出，故按 Go 实际行为锁定 —— 详见移植报告。
		{"连接被拒绝（Go 与 Node 判定不一致）", errors.New("dial tcp 127.0.0.1:443: connect: connection refused"), false, true},
	}
	for _, tc := range cases {
		if got := retryableTLS(tc.err, tc.sent); got != tc.want {
			t.Errorf("%s：retryableTLS=%v，应为 %v（err=%v）", tc.name, got, tc.want, tc.err)
		}
	}
	if retryableTLS(nil, false) {
		t.Errorf("无错误不应触发回退")
	}
}

// 回退时必须把上限收到 TLS 1.2；默认路径不得加限制（否则全站静默降级）。
func TestTLS12OnlyClientCapsMaxVersion(t *testing.T) {
	capped := newClient(true, true, time.Second).Transport.(*http.Transport)
	if capped.TLSClientConfig == nil || capped.TLSClientConfig.MaxVersion != tls.VersionTLS12 {
		t.Fatalf("tls12Only 客户端应把 MaxVersion 限到 TLS 1.2：%+v", capped.TLSClientConfig)
	}
	normal := newClient(true, false, time.Second).Transport.(*http.Transport)
	if normal.TLSClientConfig != nil && normal.TLSClientConfig.MaxVersion != 0 {
		t.Fatalf("默认客户端不应限制 TLS 版本：%+v", normal.TLSClientConfig)
	}
}

// 握手失败必须触发且只触发一次 TLS 1.2 回退：对端 accept 两次即证明重试发生过。
type closeOnAcceptListener struct {
	net.Listener
	accepts int32
}

func (l *closeOnAcceptListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err == nil {
		atomic.AddInt32(&l.accepts, 1)
		// 立刻断开：对 TLS 客户端表现为握手阶段 EOF。
		_ = c.Close()
	}
	return c, err
}

func TestHandleRetriesTLS12OnceOnHandshakeFailure(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败：%v", err)
	}
	defer ln.Close()
	counting := &closeOnAcceptListener{Listener: ln}
	go func() {
		for {
			if _, err := counting.Accept(); err != nil {
				return
			}
		}
	}()

	h := New(logx.Discard())
	rec := httptest.NewRecorder()
	req := localRequest(t, "https://"+ln.Addr().String(), "GET", nil, nil)
	h.Handle(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("握手失败应回 502，实际 %d：%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "relayError") {
		t.Fatalf("失败应带 relayError 标记：%s", rec.Body.String())
	}
	// 第一次失败 + 恰好一次回退重试；不重试是 1，重试不止一次会超过 2。
	if got := atomic.LoadInt32(&counting.accepts); got != 2 {
		t.Fatalf("握手失败应恰好回退重试一次（accept 2 次），实际 %d 次", got)
	}
}

// 请求已发出后失败不得重发：上游收下 POST 却迟迟不发响应头时，
// 重试会让同一条 AI 请求被计费/执行两次。
func TestHandleDoesNotResendRequestAfterItWasSent(t *testing.T) {
	var posts int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&posts, 1)
		_, _ = io.ReadAll(r.Body) // 完整读走请求体：上游确实收到了这条请求
		time.Sleep(1600 * time.Millisecond)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	h := New(logx.Discard())
	rec := httptest.NewRecorder()
	req := makeRequest(t, upstream.URL, "POST", map[string]any{"Content-Type": "application/json"},
		map[string]any{"model": "m"}, 100, "127.0.0.1:45678")
	h.Handle(rec, req)

	if got := atomic.LoadInt32(&posts); got != 1 {
		t.Fatalf("请求已发出后不得重发（上游应只收到 1 次 POST），实际 %d 次", got)
	}
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("等响应头超时应回 502，实际 %d：%s", rec.Code, rec.Body.String())
	}
}

// 中转超时按"空闲"续期：上游每吐一块就重置计时；上游停住后由空闲计时器掐断，
// 而不是按整条请求总时长（流式长回复会被总时长误杀）。
type stallBody struct {
	first     bool
	release   chan struct{}
	closeOnce sync.Once
	closed    chan struct{}
}

func newStallBody() *stallBody {
	return &stallBody{first: true, release: make(chan struct{}), closed: make(chan struct{})}
}

func (s *stallBody) Read(p []byte) (int, error) {
	if s.first {
		s.first = false
		const chunk = "data: first\n\n"
		copy(p, chunk)
		return len(chunk), nil
	}
	<-s.release // 一直停住：模拟上游断流但不挂断
	return 0, io.EOF
}

func (s *stallBody) Close() error {
	s.closeOnce.Do(func() {
		close(s.release)
		close(s.closed)
	})
	return nil
}

func TestStreamBodyClosesStalledUpstream(t *testing.T) {
	body := newStallBody()
	rec := httptest.NewRecorder()
	started := time.Now()
	streamBody(rec, body, 200*time.Millisecond)

	select {
	case <-body.closed:
	case <-time.After(5 * time.Second):
		t.Fatalf("上游停住后应被空闲计时器掐断")
	}
	if elapsed := time.Since(started); elapsed > 4*time.Second {
		t.Errorf("空闲掐断应在空闲超时后立刻发生，实际 %v", elapsed)
	}
	if !strings.Contains(rec.Body.String(), "data: first") {
		t.Errorf("停住前已读到的块应已透传：%q", rec.Body.String())
	}
}

// 停住前的空闲上限是每块重置的：只要上游持续吐数据就不掐。
func TestStreamBodyRenewsIdleDeadlineWhileStreaming(t *testing.T) {
	slow := &dribbleBody{ticks: 3}
	rec := httptest.NewRecorder()
	streamBody(rec, slow, 80*time.Millisecond)
	if got := strings.Count(rec.Body.String(), "tick"); got != 3 {
		t.Fatalf("应透传全部 3 块（每块间隔短于空闲上限），实际 %d：%q", got, rec.Body.String())
	}
}

// dribbleBody 每 60ms 吐一块（短于 80ms 的空闲上限），吐完 closes。
type dribbleBody struct {
	ticks int
}

func (d *dribbleBody) Read(p []byte) (int, error) {
	if d.ticks <= 0 {
		return 0, io.EOF
	}
	time.Sleep(60 * time.Millisecond)
	d.ticks--
	const chunk = "tick\n"
	copy(p, chunk)
	return len(chunk), nil
}

func (d *dribbleBody) Close() error { return nil }

// 超时预算的上下界：默认 120s、最少 1s、最多 10 分钟（Node 版 relayTimeoutMs 的语义）。
func TestClampTimeoutBounds(t *testing.T) {
	cases := []struct {
		ms   float64
		want time.Duration
	}{
		{0, defaultTimeout},
		{-100, defaultTimeout},
		{500, time.Second},
		{60000, time.Minute},
		{float64(TimeoutMax.Milliseconds()) * 10, TimeoutMax},
	}
	for _, tc := range cases {
		if got := clampTimeout(tc.ms); got != tc.want {
			t.Errorf("clampTimeout(%v) = %v，应为 %v", tc.ms, got, tc.want)
		}
	}
}

// SSE 响应必须关掉中间层缓冲（X-Accel-Buffering: no）并逐块 flush：
// 前端要等第一块才知道流已经开始，攒一批才发会让增量"一坨一坨蹦"。
func TestSSEResponseDisablesBufferingAndFlushesIncrementally(t *testing.T) {
	firstArrived := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: first\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		select {
		case <-firstArrived: // 客户端真收到第一块后才放行第二块
		case <-time.After(5 * time.Second):
		}
		_, _ = w.Write([]byte("data: second\n\n"))
	}))
	defer upstream.Close()

	relaySrv := httptest.NewServer(http.HandlerFunc(New(logx.Discard()).Handle))
	defer relaySrv.Close()

	payload := fmt.Sprintf(`{"url":%q,"method":"GET","timeoutMs":8000}`, upstream.URL)
	req, err := http.NewRequest(http.MethodPost, relaySrv.URL+"/api/relay", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("构造请求：%v", err)
	}

	resp, err := relaySrv.Client().Do(req)
	if err != nil {
		t.Fatalf("请求中转：%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 %d", resp.StatusCode)
	}
	if got := resp.Header.Get("X-Accel-Buffering"); got != "no" {
		t.Errorf("SSE 响应应带 X-Accel-Buffering: no，实际 %q", got)
	}

	// 读到第一块即放行上游发第二块：能读到就证明中转没有攒批。
	type readResult struct {
		line string
		err  error
	}
	reader := bufio.NewReader(resp.Body)
	readLine := func() readResult {
		ch := make(chan readResult, 1)
		go func() {
			line, err := reader.ReadString('\n')
			ch <- readResult{line, err}
		}()
		select {
		case r := <-ch:
			return r
		case <-time.After(8 * time.Second):
			return readResult{err: errors.New("读取超时：中转疑似攒批，没有逐块 flush")}
		}
	}

	first := readLine()
	if !strings.Contains(first.line, "data: first") {
		t.Fatalf("第一块应为 data: first，实际 %q（err=%v）", first.line, first.err)
	}
	close(firstArrived)

	second := readLine()
	if !strings.Contains(second.line, "data: second") {
		extra := readLine()
		if !strings.Contains(extra.line+second.line, "data: second") {
			t.Errorf("第二块应透传：got %q %q (err %v %v)", second.line, extra.line, second.err, extra.err)
		}
	}
}

// 非 SSE 响应不该带 X-Accel-Buffering（那个头只属于 SSE 的关缓冲约定）。
func TestJSONResponseHasNoBufferingHeader(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	h := New(logx.Discard())
	rec := httptest.NewRecorder()
	h.Handle(rec, localRequest(t, upstream.URL, "GET", nil, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d", rec.Code)
	}
	if got := rec.Header().Get("X-Accel-Buffering"); got != "" {
		t.Errorf("非 SSE 响应不应带 X-Accel-Buffering，实际 %q", got)
	}
}
