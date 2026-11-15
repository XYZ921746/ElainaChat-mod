// Package relay 是 /api/relay 的实现：把 AI 请求搬到服务端发出，绕开浏览器的 CORS。
//
// 它是所有对外 AI 请求的唯一出口（对话、模型列表、语音、视觉都走这里），
// 所以 SSRF 防护必须落在这一层：协议白名单、云元数据地址、公网来源不许打回环/内网，
// 并在拨号时按解析出的 IP 再判一次（防 DNS rebinding 的 TOCTOU）。
// 本机与局域网来源放行内网目标：手机通过局域网访问电脑端时，服务商（Ollama / LM Studio /
// 局域网网关）和桌面本机看到的是同一张内网；把它们当外人拦掉，等于手机端用不了自建服务商。
// 主服务监听 0.0.0.0 / :: 时（SetTrustAllClients）来源不再区分 —— 这是用户主动开放应用，
// 连上来的设备就是使用者；云元数据地址在任何模式下都拒绝。
package relay

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"elainachat/server/internal/logx"
	"elainachat/server/internal/security"
)

const (
	BodyLimit       = 32 * 1024 * 1024
	TimeoutMax      = 10 * time.Minute
	TraceParseMax   = 16 * 1024 * 1024
	TraceBodyMax    = 64 * 1024
	TraceAccumMax   = 256 * 1024
	traceMessageMax = 4000
	defaultTimeout  = 120 * time.Second
)

// 云厂商元数据服务：被中转当作跳板去读会泄露本机凭据，直接封掉。
// 这里列字面量，域名解析出来的 IP 由拨号阶段 IsMetadataAddress 再挡一次。
var denyHosts = map[string]bool{
	"169.254.169.254":           true,
	"169.254.170.2":             true,
	"100.100.100.200":           true,
	"fd00:ec2::254":             true,
	"metadata.google.internal":  true,
	"metadata.tencent.internal": true,
}

var stripHeaders = regexp.MustCompile(`(?i)^(host|content-length|cookie|origin|referer|connection|transfer-encoding)$`)

type Handler struct {
	log      *logx.Logger
	trustAll bool
}

func New(log *logx.Logger) *Handler { return &Handler{log: log} }

// SetTrustAllClients 标记主服务是否监听在所有网卡（0.0.0.0 / ::）。
// 用户显式把应用开到局域网或公网后，连上来的设备就是应用的使用者；中转不再按来源
// 拦内网目标（否则手机连电脑端时用不了 Ollama / LM Studio / 局域网网关）。
// 默认回环绑定仍只信本机与同一局域网来源。
func (h *Handler) SetTrustAllClients(v bool) { h.trustAll = v }

type payload struct {
	URL       string          `json:"url"`
	Method    string          `json:"method"`
	Headers   map[string]any  `json:"headers"`
	Body      json.RawMessage `json:"body"`
	TimeoutMs float64         `json:"timeoutMs"`
}

// Handle 处理一条中转请求。所有失败都回 JSON {ok:false, relayError:true}，
// 前端据此与「服务本身出错」区分开。
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, BodyLimit+1))
	if err != nil || len(raw) > BodyLimit {
		h.log.Warnf("Relay", "请求体无效或过大，已拒绝")
		writeError(w, http.StatusBadRequest, "中转请求体无效或过大")
		return
	}
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil {
		h.log.Warnf("Relay", "请求体无效或过大，已拒绝")
		writeError(w, http.StatusBadRequest, "中转请求体无效或过大")
		return
	}

	target, err := url.Parse(strings.TrimSpace(p.URL))
	if err != nil || target.Host == "" {
		h.log.Warnf("Relay", "目标地址无效：%s", clip(p.URL, 200))
		writeError(w, http.StatusBadRequest, "中转目标地址无效")
		return
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		h.log.Warnf("Relay", "不支持的协议 %s//%s，只允许 http/https", target.Scheme, target.Host)
		writeError(w, http.StatusBadRequest, "中转只支持 http/https")
		return
	}
	if denyHosts[strings.ToLower(target.Hostname())] {
		h.log.Warnf("Relay", "拒绝访问云元数据地址 %s（防本机凭据泄露）", target.Host)
		writeError(w, http.StatusForbidden, "该地址不允许通过中转访问")
		return
	}

	allowInternal := h.trustAll || security.IsLANAddr(r.RemoteAddr)
	// 本机与局域网设备放行 —— Ollama 这类就住在 127.0.0.1，局域网网关也常开在 192.168.x.x。
	if !allowInternal && security.IsLoopbackHostname(target.Hostname()) {
		h.log.Warnf("Relay", "拒绝公网来源访问本机地址 %s（防 SSRF）", target.Host)
		writeError(w, http.StatusForbidden, "本机地址只能由本机或局域网设备发起中转")
		return
	}
	if !allowInternal {
		if ips, err := net.DefaultResolver.LookupIPAddr(r.Context(), target.Hostname()); err == nil {
			for _, ip := range ips {
				if security.IsInternalAddress(ip.IP.String()) {
					h.log.Warnf("Relay", "拒绝公网来源访问内网地址 %s -> %s（防 SSRF）", target.Host, ip.IP)
					writeError(w, http.StatusForbidden, "本机与内网地址只能由本机或局域网设备发起中转")
					return
				}
			}
		}
		// DNS 失败不在这里拒绝：真连不上时拨号阶段自己会报错。
	}

	method := strings.ToUpper(strings.TrimSpace(p.Method))
	if method == "" {
		method = http.MethodGet
	}
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		h.log.Warnf("Relay", "不支持的请求方法 %s", method)
		writeError(w, http.StatusBadRequest, "中转不支持的请求方法")
		return
	}

	body, reqText := requestBody(p.Body, method)
	timeout := clampTimeout(p.TimeoutMs)
	started := time.Now()

	ctx, cancel := context.WithTimeout(r.Context(), TimeoutMax)
	defer cancel()
	// 客户端断开就别再等上游；5xx 与超时都会落到这里。
	stopClientWatch := watchDisconnect(r, cancel)
	defer stopClientWatch()

	headers := forwardHeaders(p.Headers)
	upstream, sent, err := h.do(ctx, target, method, headers, body, timeout, allowInternal, false)
	if err != nil && retryableTLS(err, sent) {
		upstream, _, err = h.do(ctx, target, method, headers, body, timeout, allowInternal, true)
		if err == nil {
			h.log.Infof("Relay", "TLS 握手失败，已用 TLS 1.2 重试成功 %s", target.Host)
		}
	}
	if err != nil {
		if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
			return // 客户端自己走了，不用回话
		}
		detail := relayFailure(err, timeout)
		h.traceRequest(method, target, reqText)
		h.log.Errorf("Relay", "请求失败 %s %s -> %s (%dms)", method, target.Redacted(), detail, time.Since(started).Milliseconds())
		writeError(w, http.StatusBadGateway, "本地中转无法连接目标："+detail)
		return
	}
	defer upstream.Body.Close()

	contentType := upstream.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json; charset=utf-8"
	}
	hw := w.Header()
	hw.Set("Content-Type", contentType)
	hw.Set("Cache-Control", "no-store")
	hw.Set("X-Content-Type-Options", "nosniff")
	if strings.Contains(strings.ToLower(contentType), "text/event-stream") {
		// SSE 必须关掉中间层缓冲，否则增量会一批一批蹦出来。
		hw.Set("X-Accel-Buffering", "no")
	}
	w.WriteHeader(upstream.StatusCode)
	flush(w)

	respText := streamBody(w, upstream.Body, timeout)
	elapsed := time.Since(started)
	h.traceExchange(method, target, reqText, upstream.StatusCode, elapsed, respText)
}

// do 返回 requestSent：请求（含请求体）是否已经完整写给上游。调用方据此判断能否安全重试 ——
// 已发出就意味着上游可能已经处理，重发会产生第二条相同的 POST（AI 请求重复计费、上游重复执行）。
func (h *Handler) do(ctx context.Context, target *url.URL, method string, headers map[string]string, body []byte, timeout time.Duration, allowInternal, tls12Only bool) (*http.Response, bool, error) {
	req, err := http.NewRequestWithContext(ctx, method, target.String(), bytes.NewReader(body))
	if err != nil {
		return nil, false, err
	}
	if body == nil {
		req.Body = nil
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	// 不让上游压缩：SSE 要逐块透传，省得再解一遍。
	req.Header.Set("Accept-Encoding", "identity")

	// 用 WroteRequest 的 Err 而不是错误文案判断：握手完成、等响应头超时、连接重置这些
	// 文案上"像连接失败"的错误，此时请求体其实已经发出去了。
	// 只有 Err 为 nil（整条请求确实写完了）才算已发出。
	var requestSent bool
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			if info.Err == nil {
				requestSent = true
			}
		},
	}))

	client := newClient(allowInternal, tls12Only, timeout)
	resp, err := client.Do(req)
	return resp, requestSent, err
}

// newClient 的拨号器自己解析并校验 IP 后再拨：只在请求前查一次 DNS 挡不住
// DNS rebinding —— 校验与真正连接之间域名可以换一个 IP。
func newClient(allowInternal, tls12Only bool, timeout time.Duration) *http.Client {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	dialer := &net.Dialer{Timeout: timeout}
	transport := &http.Transport{
		Proxy:               nil, // 不吃系统代理：走代理会绕开上面的内网判定
		ForceAttemptHTTP2:   true,
		TLSHandshakeTimeout: timeout,
		// 等响应头同样算空闲超时：长回复的首字节本来就可能很慢，
		// 但"一直不发头"必须被掐掉，否则这个参数形同虚设。
		ResponseHeaderTimeout: timeout,
		// 每个请求一个一次性 Transport：空闲连接没有共享池可回收，必须到期自清，
		// 否则用完的连接被钉在各自的池里，socket 句柄与读 goroutine 只增不减。
		IdleConnTimeout: 30 * time.Second,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			var lastErr error
			for _, ip := range ips {
				// 元数据地址先于内网放行判定：局域网来源能访问内网服务商，但不能借这台机器读云凭据。
				if security.IsMetadataAddress(ip.IP.String()) {
					return nil, fmt.Errorf("目标解析到云元数据地址 %s（已拒绝）", ip.IP)
				}
				if !allowInternal && security.IsInternalAddress(ip.IP.String()) {
					return nil, fmt.Errorf("目标解析到内网地址 %s（已拒绝）", ip.IP)
				}
				conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			if lastErr == nil {
				lastErr = fmt.Errorf("域名没有解析到任何地址")
			}
			return nil, lastErr
		},
	}
	if tls12Only {
		transport.TLSClientConfig = &tls.Config{MaxVersion: tls.VersionTLS12}
	}
	return &http.Client{
		Transport: transport,
		// 3xx 的 Location 是攻击者可控的，跟随它会绕过 SSRF 校验；把 3xx 原样交给调用方。
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func requestBody(raw json.RawMessage, method string) ([]byte, string) {
	if method == http.MethodGet || method == http.MethodHead {
		return nil, ""
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, ""
	}
	if raw[0] == '"' {
		var text string
		if json.Unmarshal(raw, &text) == nil {
			return []byte(text), text
		}
	}
	return raw, string(raw)
}

func forwardHeaders(raw map[string]any) map[string]string {
	out := make(map[string]string, len(raw)+1)
	for key, value := range raw {
		if stripHeaders.MatchString(key) || value == nil {
			continue
		}
		out[key] = fmt.Sprint(value)
	}
	return out
}

func clampTimeout(ms float64) time.Duration {
	if ms <= 0 {
		return defaultTimeout
	}
	d := time.Duration(ms) * time.Millisecond
	if d < time.Second {
		return time.Second
	}
	if d > TimeoutMax {
		return TimeoutMax
	}
	return d
}

// streamBody 边透传边攒一份日志用的副本；超过上限后继续透传但不再记录，
// 否则一张几十 MB 的图片响应就能把内存吃掉。
func streamBody(w http.ResponseWriter, body io.ReadCloser, idleTimeout time.Duration) string {
	var accum bytes.Buffer
	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	done := make(chan struct{})
	defer close(done)

	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if time.Since(time.Unix(0, last.Load())) > idleTimeout {
					_ = body.Close()
					return
				}
			}
		}
	}()

	buf := make([]byte, 32*1024)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			last.Store(time.Now().UnixNano())
			_, _ = w.Write(buf[:n])
			flush(w)
			if accum.Len() < TraceAccumMax {
				remaining := TraceAccumMax - accum.Len()
				if n > remaining {
					n = remaining
				}
				accum.Write(buf[:n])
			}
		}
		if err != nil {
			break
		}
	}
	return accum.String()
}

func watchDisconnect(r *http.Request, cancel context.CancelFunc) func() {
	done := make(chan struct{})
	go func() {
		select {
		case <-r.Context().Done():
			cancel()
		case <-done:
		}
	}()
	return func() { close(done) }
}

func flush(w http.ResponseWriter) {
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

// retryableTLS 决定是否值得用 TLS 1.2 回退重发一次。
// 第一判据是「请求是否已经发出」——这比猜错误文案可靠：等响应头超时、握手后重置、
// EOF 在文案上都像连接失败，但请求体其实已经进了上游，重发就是第二条相同的 POST。
// 只有在请求确定没发出去时，才按错误类型排除掉重试也没用的两类：用户取消与 DNS 失败。
// 无条件降级还会让所有上游都少掉 TLS 1.3 的前向保密。
func retryableTLS(err error, requestSent bool) bool {
	if err == nil || requestSent {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	return !strings.Contains(strings.ToLower(err.Error()), "no such host")
}

func relayFailure(err error, timeout time.Duration) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Sprintf("超过 %d 秒没有响应", int(timeout.Seconds()))
	}
	// url.Error 的文案会带完整 URL（含 ?key=…）：只回底层原因，
	// 别让密钥跟着错误信息再散一次。
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		err = urlErr.Err
	}
	msg := err.Error()
	if strings.Contains(strings.ToLower(msg), "timeout") {
		return fmt.Sprintf("超过 %d 秒没有响应", int(timeout.Seconds()))
	}
	return msg
}

func writeError(w http.ResponseWriter, status int, message string) {
	raw, _ := json.Marshal(map[string]any{"ok": false, "relayError": true, "message": message})
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func clip(text string, max int) string {
	if len([]rune(text)) <= max {
		return text
	}
	runes := []rune(text)
	return string(runes[:max]) + "…（已截断）"
}
