package updatecheck

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// stubTransport 替换默认传输：记下请求形状，回固定响应（不碰真实网络）。
type stubTransport struct {
	mu      sync.Mutex
	calls   int
	lastReq *http.Request
	respond func(seq int, req *http.Request) (*http.Response, error)
}

func (s *stubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	s.mu.Lock()
	s.calls++
	seq := s.calls
	s.lastReq = req
	s.mu.Unlock()
	if s.respond != nil {
		return s.respond(seq, req)
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(`{"tag_name":"v2.1.0"}`)),
		Request:    req,
	}, nil
}

func (s *stubTransport) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

const sampleRelease = `{
	"tag_name":"v2.1.0","name":"v2.1.0","html_url":"https://github.com/x/y/releases/v2.1.0",
	"published_at":"2026-01-01T00:00:00Z","body":"notes","prerelease":false,
	"assets":[{"name":"a.apk","browser_download_url":"https://github.com/a.apk","size":5}]
}`

func stubResponse(status int, body string) (*http.Response, error) {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(body)),
	}, nil
}

// 请求形状：URL 按 owner/repo 拼对、带 UA 与 GitHub 媒体类型（缺 UA 会被 GitHub 403）。
func TestCheckRequestShapeAndHeaders(t *testing.T) {
	transport := &stubTransport{}
	checker := &Checker{Repo: "x/y", Timeout: 2 * time.Second, UA: "ElainaChat-test", Client: &http.Client{Transport: transport}}

	got := checker.Check(context.Background())
	if !got.OK || got.Release == nil || got.Release.Tag != "v2.1.0" {
		t.Fatalf("成功时应返回收敛后的 release：%+v", got)
	}
	if transport.lastReq.URL.String() != "https://api.github.com/repos/x/y/releases/latest" {
		t.Errorf("请求地址按 owner/repo 拼对，实际 %s", transport.lastReq.URL)
	}
	if transport.lastReq.Header.Get("User-Agent") == "" {
		t.Errorf("应带 User-Agent（GitHub 缺它会 403）")
	}
	if !strings.Contains(transport.lastReq.Header.Get("Accept"), "github") {
		t.Errorf("Accept 应走 GitHub 媒体类型：%s", transport.lastReq.Header.Get("Accept"))
	}
}

// 缓存语义：TTL 内复用成功结果不再发请求；过期后重新请求；失败结果不进缓存。
func TestCheckCacheExpiryAndOnlySuccessCached(t *testing.T) {
	transport := &stubTransport{}
	checker := &Checker{Repo: "x/y", TTL: 40 * time.Millisecond, Timeout: 2 * time.Second, UA: "t", Client: &http.Client{Transport: transport}}

	first := checker.Check(context.Background())
	if !first.OK {
		t.Fatalf("首次检测失败：%+v", first)
	}
	cached := checker.Check(context.Background())
	if !cached.Cached || transport.callCount() != 1 {
		t.Fatalf("缓存期内不重复请求：calls=%d cached=%v", transport.callCount(), cached.Cached)
	}
	time.Sleep(70 * time.Millisecond)
	fresh := checker.Check(context.Background())
	if fresh.Cached || transport.callCount() != 2 {
		t.Errorf("缓存过期后应重新请求：calls=%d cached=%v", transport.callCount(), fresh.Cached)
	}

	// 失败（404）不进缓存：连续两次检测都是真实请求。
	transport404 := &stubTransport{respond: func(int, *http.Request) (*http.Response, error) { return stubResponse(404, "{}") }}
	failing := &Checker{Repo: "x/y", Timeout: 2 * time.Second, UA: "t", Client: &http.Client{Transport: transport404}}
	for i := 0; i < 2; i++ {
		if got := failing.Check(context.Background()); got.OK || got.Code != "NO_RELEASE" {
			t.Fatalf("404 应报 NO_RELEASE：%+v", got)
		}
	}
	if transport404.callCount() != 2 {
		t.Errorf("失败结果不应进缓存（每次都要真实探测），实际请求 %d 次", transport404.callCount())
	}
}

// 404 / 403 限流 / 429 的分类。
func TestCheckHTTPStatusClassification(t *testing.T) {
	reset := strconv.FormatInt(time.Now().Add(120*time.Second).Unix(), 10)
	cases := []struct {
		name       string
		status     int
		header     map[string]string
		wantCode   string
		wantMinUrl string
	}{
		{"404 还没有 Release", 404, nil, "NO_RELEASE", ""},
		{"403 限流给出重试时间", 403, map[string]string{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset}, "RATE_LIMIT", "分钟"},
		{"429 也算限流", 429, nil, "RATE_LIMIT", ""},
		{"403 无限流头也归限流档", 403, nil, "RATE_LIMIT", ""},
		{"500 归 HTTP", 500, nil, "HTTP", ""},
	}
	for _, tc := range cases {
		transport := &stubTransport{respond: func(int, *http.Request) (*http.Response, error) {
			resp, _ := stubResponse(tc.status, "{}")
			for k, v := range tc.header {
				resp.Header.Set(k, v)
			}
			return resp, nil
		}}
		checker := &Checker{Repo: "x/y", Timeout: 2 * time.Second, UA: "t", Client: &http.Client{Transport: transport}}
		got := checker.Check(context.Background())
		if got.Code != tc.wantCode {
			t.Errorf("%s：code=%s，应为 %s", tc.name, got.Code, tc.wantCode)
		}
		if tc.wantMinUrl != "" && !strings.Contains(got.Message, tc.wantMinUrl) {
			t.Errorf("%s：限流提示应给出大约多久后重试：%s", tc.name, got.Message)
		}
	}
}

// 返回不是合法 release JSON：报 BAD_RESPONSE，而不是把半截数据交给前端。
func TestCheckBadResponse(t *testing.T) {
	transport := &stubTransport{respond: func(int, *http.Request) (*http.Response, error) {
		return stubResponse(200, "这不是 JSON")
	}}
	checker := &Checker{Repo: "x/y", Timeout: 2 * time.Second, UA: "t", Client: &http.Client{Transport: transport}}
	if got := checker.Check(context.Background()); got.Code != "BAD_RESPONSE" {
		t.Errorf("非 JSON 响应应报 BAD_RESPONSE：%+v", got)
	}
}

// 非法仓库名直接拒绝，一个请求都不发（一段 ../ 就能把请求带到别的接口上）。
func TestCheckInvalidRepoSendsNoRequest(t *testing.T) {
	transport := &stubTransport{}
	checker := &Checker{Repo: "x/../../evil", Timeout: 2 * time.Second, UA: "t", Client: &http.Client{Transport: transport}}
	got := checker.Check(context.Background())
	if got.Code != "CONFIG" {
		t.Errorf("非法 repo 应报 CONFIG：%+v", got)
	}
	if transport.callCount() != 0 {
		t.Errorf("非法 repo 不应发请求，实际发了 %d 次", transport.callCount())
	}
}

// 网络失败分类：超时 / DNS / 拒绝 / TLS（对照 Node 版 describeFetchError 的实测断言）。
func TestDescribeErrorClassification(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		wantCode string
		wantHint string
	}{
		{"超时（DeadlineExceeded）", fmt.Errorf("Get %q: %w", "https://api.github.com", context.DeadlineExceeded), "TIMEOUT", ""},
		{"超时（i/o timeout）", errors.New("dial tcp 140.82.112.3:443: i/o timeout"), "TIMEOUT", ""},
		{"DNS 失败提示查 hosts", errors.New("dial tcp: lookup api.github.com: no such host"), "DNS", "hosts"},
		{"连接被拒", errors.New("dial tcp 127.0.0.1:443: connect: connection refused"), "REFUSED", ""},
		{"TLS 握手失败", errors.New("tls: handshake failure"), "TLS", ""},
		{"证书校验失败", errors.New("tls: failed to verify certificate: x509: unknown authority"), "TLS", ""},
		{"其它网络错误归 NETWORK", errors.New("socks connect: unsupported scheme"), "NETWORK", ""},
	}
	for _, tc := range cases {
		info := describeError(tc.err)
		if info.Code != tc.wantCode {
			t.Errorf("%s：code=%s，应为 %s", tc.name, info.Code, tc.wantCode)
		}
		if tc.wantHint != "" && !strings.Contains(info.Message, tc.wantHint) {
			t.Errorf("%s：文案应提示 %s：%s", tc.name, tc.wantHint, info.Message)
		}
	}

	// 这几类失败才允许走「公共 DNS 直连」绕过；HTTP 层结论（404/限流）不算网络失败。
	for _, code := range []string{"TIMEOUT", "DNS", "REFUSED", "TLS", "NETWORK"} {
		if !bypassable[code] {
			t.Errorf("%s 应允许绕过重试", code)
		}
	}
}

// hosts 劫持诊断（对照 Node 版实测断言：认 ::1、忽略注释行、公网地址不算劫持）。
func TestFindHostsHijackNodeCases(t *testing.T) {
	hit := FindHostsHijack("# comment\n::1 api.github.com\n127.0.0.1 github.com   api.github.com\n", "api.github.com")
	if hit == nil || hit.Line != 2 || hit.IP != "::1" {
		t.Fatalf("应认 ::1 且忽略注释行，实际 %+v", hit)
	}
	if FindHostsHijack("8.8.8.8 api.github.com\n", "api.github.com") != nil {
		t.Errorf("把 GitHub 指到公网地址不算劫持")
	}
	multi := FindHostsHijack("127.0.0.1 github.com   api.github.com\n", "api.github.com")
	if multi == nil || multi.Line != 1 || multi.IP != "127.0.0.1" {
		t.Errorf("同一行多个主机名也应命中目标：%+v", multi)
	}
}

// 只接受公网 IPv4（挡掉污染成本机 / 内网地址）—— 补 Node 表里的 0.0.0.0。
func TestIsPublicIPv4ZeroAddress(t *testing.T) {
	if IsPublicIP("8.8.8.8") != true {
		t.Errorf("8.8.8.8 应判为公网")
	}
	for _, ip := range []string{"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "0.0.0.0"} {
		if IsPublicIP(ip) {
			t.Errorf("%s 不应判为公网", ip)
		}
	}
}

// 公共 DNS 有多台候选：一台被挡还有下一台。
func TestPublicDNSListHasMultipleServers(t *testing.T) {
	if len(PublicDNS) < 2 {
		t.Fatalf("公共 DNS 候选应不少于 2 台，实际 %d", len(PublicDNS))
	}
}

// 绕过路径成功时结果带 viaBypass 标记（前端据此提示"走了直连"）。
func TestHandleResponseViaBypassFlag(t *testing.T) {
	checker := &Checker{Repo: "x/y"}
	got := checker.handleResponse(200, http.Header{}, []byte(sampleRelease), time.Now().UnixMilli(), true)
	if !got.OK || !got.ViaBypass {
		t.Errorf("绕过成功的结果应标记 viaBypass：%+v", got)
	}
	direct := checker.handleResponse(200, http.Header{}, []byte(sampleRelease), time.Now().UnixMilli(), false)
	if direct.ViaBypass {
		t.Errorf("常规路径不应带 viaBypass：%+v", direct)
	}
}
