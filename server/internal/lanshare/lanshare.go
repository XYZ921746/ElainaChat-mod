// Package lanshare 是局域网共享数据：① 本机标记为「可被局域网设备拉取备份」，
// 5 分钟后自动失效；② 服务端代登录对方、取回对方的备份交给导入流程。
//
// 凭据统一用访问密码：共享不是第二套登录体系，它就是「把这个实例临时暴露给局域网」，
// 谁能访问由实例自己的访问密码决定。临时监听只放行「登录 + 导出」两个接口。
// 不让浏览器直接跨源去拉：会撞 CORS，且访问密码产生的会话是 SameSite=Strict。
// 安全：接收端只允许私网/回环地址（域名解析后逐个校验，挡 SSRF）。
package lanshare

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	stdlog "log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"elainachat/server/internal/logx"
	"elainachat/server/internal/security"
)

const (
	shareTTL    = 5 * time.Minute
	pullTimeout = 120 * time.Second
	loginTimout = 15 * time.Second
)

// Handler 只有内存里的共享开关，重启即关闭。
type Handler struct {
	collect   func(secrets map[string]string) ([]byte, error)
	maxUpload int64
	log       *logx.Logger

	shareHandler          http.Handler
	mainHostAllInterfaces bool

	mu         sync.Mutex
	shareUntil time.Time
	sharePort  int
	listener   net.Listener
	httpSrv    *http.Server
	timer      *time.Timer
	// secrets 是开启共享时页面交上来的密钥表（手机端 Key 只住 Keystore，data/ 里没有）。
	// 只活在内存里、随共享窗口一起失效：共享结束即清空，不写盘。
	secrets map[string]string
}

// New 的 collect 接收密钥表参数：手机端 Key 在 Keystore 里，data/ 中没有，
// 共享导出必须把页面交上来的那批值合并进备份，否则对方拿到的备份缺 Key。
func New(collect func(secrets map[string]string) ([]byte, error), maxUpload int64, log *logx.Logger) *Handler {
	if maxUpload <= 0 {
		maxUpload = 200 * 1024 * 1024
	}
	return &Handler{collect: collect, maxUpload: maxUpload, log: log}
}

// secretsHeader 与 httpapi 的导出头同名：页面读 Keystore 后经这个头交上来。
// 两处各写一份常量容易漂移，但 lanshare 不能反向依赖 httpapi（会成环），
// 所以这里固定同一个字面量，并由 check-security 的局域网用例核对两端一致。
const secretsHeader = "X-Elaina-Secrets"

// readSecrets 解析开启共享请求携带的密钥表。解析不了就当作没带：
// 少几个 Key 的备份仍可用，因解析失败让整个共享开不起来则不可接受。
func readSecrets(r *http.Request) map[string]string {
	raw := strings.TrimSpace(r.Header.Get(secretsHeader))
	if raw == "" {
		return nil
	}
	var parsed map[string]string
	if json.Unmarshal([]byte(raw), &parsed) != nil || len(parsed) == 0 {
		return nil
	}
	out := map[string]string{}
	for name, value := range parsed {
		if strings.TrimSpace(name) == "" || strings.TrimSpace(value) == "" {
			continue
		}
		out[name] = value
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// SetShareHandler 注入只服务「登录 + 导出」的临时局域网 handler。
// 没有注入时（单元测试）共享端口退回主端口，不额外起监听。
func (h *Handler) SetShareHandler(handler http.Handler) {
	h.mu.Lock()
	h.shareHandler = handler
	h.mu.Unlock()
}

// SetMainHostAllInterfaces 标记主服务是否已经监听 0.0.0.0/::。
// 是的话共享直接走主端口；否则临时起一个只暴露共享接口的监听，避免为了传一次备份把整个应用绑到局域网。
func (h *Handler) SetMainHostAllInterfaces(v bool) {
	h.mu.Lock()
	h.mainHostAllInterfaces = v
	h.mu.Unlock()
}

func (h *Handler) IsSharing() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return !h.shareUntil.IsZero() && time.Now().Before(h.shareUntil)
}

// Close 在进程收尾时关掉临时监听；共享本身也在内存里，进程退出即失效。
func (h *Handler) Close() {
	h.mu.Lock()
	h.stopShareLocked()
	h.mu.Unlock()
}

// Handle 返回 true 表示这条请求已处理。
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request, port int) bool {
	switch {
	case r.URL.Path == "/api/data/lan/enable" && r.Method == http.MethodPost:
		h.enable(w, r, port)
	case r.URL.Path == "/api/data/lan/export" && r.Method == http.MethodGet:
		h.Export(w)
	case r.URL.Path == "/api/data/lan/pull" && r.Method == http.MethodPost:
		h.pull(w, r)
	default:
		return false
	}
	return true
}

func (h *Handler) enable(w http.ResponseWriter, r *http.Request, port int) {
	// 页面可随开启请求交来密钥表（手机端 Key 只住 Keystore，data/ 里没有）。
	// 只认一次：共享已开着时再点只用来查地址，不替换已存的那批值。
	secrets := readSecrets(r)
	h.mu.Lock()
	if !h.shareUntil.IsZero() && time.Now().Before(h.shareUntil) {
		// 共享还在：再点一次只用来查看当前地址与端口，不重新计时。
		info := h.shareInfoLocked()
		h.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "share": info})
		return
	}
	h.stopShareLocked()
	h.secrets = secrets
	if err := h.startShareListenerLocked(port); err != nil {
		h.mu.Unlock()
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "开启局域网共享失败：" + err.Error()})
		return
	}
	h.shareUntil = time.Now().Add(shareTTL)
	h.timer = time.AfterFunc(shareTTL, h.expire)
	info := h.shareInfoLocked()
	h.mu.Unlock()
	if h.log != nil {
		h.log.Infof("LAN", "已开启局域网共享，%d 分钟后自动关闭", int(shareTTL.Minutes()))
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "share": info})
}

func (h *Handler) shareInfoLocked() map[string]any {
	return map[string]any{
		"addresses": lanAddresses(h.sharePort),
		"port":      h.sharePort,
		"expiresAt": h.shareUntil.UnixMilli(),
	}
}

// startShareListenerLocked 决定共享端口：主服务已在 0.0.0.0/:: 就直接复用；
// 否则临时监听 0.0.0.0 的随机端口，只把「登录 + 导出」两个接口露出去。
func (h *Handler) startShareListenerLocked(mainPort int) error {
	h.sharePort = mainPort
	if h.shareHandler == nil || h.mainHostAllInterfaces {
		return nil
	}
	ln, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		return err
	}
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		_ = ln.Close()
		return fmt.Errorf("无法确定临时监听端口")
	}
	srv := &http.Server{
		Handler:           h.shareHandler,
		ErrorLog:          stdlog.New(io.Discard, "", 0),
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       5 * time.Minute,
		IdleTimeout:       120 * time.Second,
	}
	h.listener = ln
	h.httpSrv = srv
	h.sharePort = addr.Port
	go func() {
		if serveErr := srv.Serve(ln); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) && h.log != nil {
			h.log.Warnf("LAN", "临时局域网监听退出：%v", serveErr)
		}
	}()
	return nil
}

func (h *Handler) stopShareLocked() {
	if h.timer != nil {
		h.timer.Stop()
		h.timer = nil
	}
	if h.httpSrv != nil {
		_ = h.httpSrv.Close()
		h.httpSrv = nil
	}
	if h.listener != nil {
		_ = h.listener.Close()
		h.listener = nil
	}
	h.shareUntil = time.Time{}
	h.sharePort = 0
	// 密钥表随共享窗口一起失效：共享关掉后不该还留着一份明文 Key 在内存里等下次导出。
	h.secrets = nil
}

// shareSecrets 取当前共享期内的密钥表副本。调用方（collect）会把它合并进备份，
// 只读不写；返回副本是为了避免与 expire 并发清空时读到半张表。
func (h *Handler) shareSecrets() map[string]string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.secrets) == 0 {
		return nil
	}
	out := make(map[string]string, len(h.secrets))
	for k, v := range h.secrets {
		out[k] = v
	}
	return out
}

func (h *Handler) expire() {
	h.mu.Lock()
	had := !h.shareUntil.IsZero()
	h.stopShareLocked()
	h.mu.Unlock()
	if had && h.log != nil {
		h.log.Infof("LAN", "局域网共享已到期，自动关闭")
	}
}

func lanAddresses(port int) []map[string]any {
	out := []map[string]any{}
	for _, ip := range security.LocalIPv4List() {
		out = append(out, map[string]any{
			"label": "IPv4",
			"ip":    ip,
			"port":  port,
			"url":   fmt.Sprintf("http://%s:%d", ip, port),
		})
	}
	return out
}

// Export 是共享期内的备份导出：主服务与临时局域网监听共用同一份逻辑。
func (h *Handler) Export(w http.ResponseWriter) {
	if !h.IsSharing() {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"ok": false, "code": "SHARE_OFF",
			"message": "对方未开启局域网共享（或已过期），请让对方重新点「开启局域网共享」",
		})
		return
	}
	buf, err := h.collect(h.shareSecrets())
	if err != nil {
		if h.log != nil {
			h.log.Errorf("LAN", "导出失败：%v", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "导出失败：" + err.Error()})
		return
	}
	if len(buf) == 0 {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "导出失败：备份为空"})
		return
	}
	if int64(len(buf)) > h.maxUpload {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
			"ok": false, "message": fmt.Sprintf("备份超过 %d MB 上限", h.maxUpload/1024/1024),
		})
		return
	}
	writeZip(w, buf)
}

func (h *Handler) pull(w http.ResponseWriter, r *http.Request) {
	body, err := readJSONBody(r, 64*1024)
	if err != nil {
		body = map[string]any{}
	}
	source, _ := body["sourceUrl"].(string)
	base, ok := parseSource(source)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok": false, "message": "对方地址无效，例：192.168.1.5:3999 或 http://192.168.1.5:3999",
		})
		return
	}
	if !targetIsPrivate(base) {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "只允许从局域网内网地址导入（不支持公网地址）"})
		return
	}

	password, _ := body["password"].(string)
	cookie := ""
	if password != "" {
		status, detail, setCookie, loginErr := login(base, password)
		switch {
		case loginErr != nil:
			writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "message": "从对方拉取失败：" + loginErr.Error()})
			return
		case status == http.StatusUnauthorized:
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "message": "对方的访问密码不正确"})
			return
		case status == http.StatusTooManyRequests:
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"ok": false, "message": "对方登录尝试过多，请稍后再试"})
			return
		case status == http.StatusForbidden:
			if detail == "" {
				detail = "对方还没有设置访问密码，局域网设备暂时不能使用"
			}
			writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": detail})
			return
		case status < 200 || status >= 300:
			writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "message": fmt.Sprintf("登录对方失败（HTTP %d）", status)})
			return
		}
		cookie = setCookie
	}

	client := &http.Client{
		Timeout: pullTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	req, err := http.NewRequest(http.MethodGet, base+"/api/data/lan/export", nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "message": "从对方拉取失败：" + err.Error()})
		return
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "message": "从对方拉取失败：" + err.Error()})
		return
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "message": "对方要求访问密码（为空或不正确）"})
		return
	case resp.StatusCode == http.StatusForbidden:
		detail := readDetail(resp.Body)
		if detail == "" {
			detail = "对方未开启局域网共享"
		}
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": detail})
		return
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"ok": false, "message": fmt.Sprintf("对方返回了跳转（HTTP %d），请检查地址是否带了协议/端口", resp.StatusCode),
		})
		return
	case resp.StatusCode >= 400:
		detail := readDetail(resp.Body)
		if detail == "" {
			detail = fmt.Sprintf("对方返回 HTTP %d", resp.StatusCode)
		}
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "message": detail})
		return
	}
	if resp.ContentLength > h.maxUpload {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
			"ok": false, "message": fmt.Sprintf("对方备份超过 %d MB 上限", h.maxUpload/1024/1024),
		})
		return
	}
	buf, err := io.ReadAll(io.LimitReader(resp.Body, h.maxUpload+1))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "message": "从对方拉取失败：" + err.Error()})
		return
	}
	if len(buf) == 0 {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "message": "对方返回了空内容"})
		return
	}
	if int64(len(buf)) > h.maxUpload {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
			"ok": false, "message": fmt.Sprintf("对方备份超过 %d MB 上限", h.maxUpload/1024/1024),
		})
		return
	}
	writeZip(w, buf)
}

// login 换一次拉取用的凭据。返回值是 Cookie 头的内容。
// 优先用响应体里的 token 拼 Authorization 更省事，但调用方只接受 Cookie 头，
// 所以这里按名字挑出会话 cookie：登录响应会同时清掉旧的无后缀 cookie，
// 取 cookies[0] 会取到那条删除指令，凭据就丢了。
func login(base, password string) (status int, detail, cookie string, err error) {
	client := &http.Client{Timeout: loginTimout}
	payload, _ := json.Marshal(map[string]string{"password": password})
	resp, err := client.Post(base+"/api/auth/login", "application/json", bytes.NewReader(payload))
	if err != nil {
		return 0, "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusTooManyRequests {
		return resp.StatusCode, readDetail(resp.Body), "", nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, "", "", nil
	}
	// 会话 cookie 以 elaina_session 开头（新版本带实例后缀，旧版本无后缀），
	// 只认有值的那些：清旧 cookie 的那条 Max-Age=0、Value 为空。
	for _, c := range resp.Cookies() {
		if strings.HasPrefix(c.Name, "elaina_session") && c.Value != "" {
			cookie = c.Name + "=" + c.Value
			break
		}
	}
	return resp.StatusCode, "", cookie, nil
}

func readDetail(body io.Reader) string {
	raw, _ := io.ReadAll(io.LimitReader(body, 8*1024))
	var payload struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &payload) == nil {
		return payload.Message
	}
	return ""
}

// parseSource 接受 ip:port 或 http://ip:port，返回 origin。
func parseSource(raw string) (string, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", false
	}
	if !strings.Contains(text, "://") {
		text = "http://" + text
	}
	u, err := url.Parse(text)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", false
	}
	return u.Scheme + "://" + u.Host, true
}

func isIPv4(value string) bool {
	return net.ParseIP(value) != nil && strings.Count(value, ".") == 3
}

// isPrivateAddress 只允许私网/回环：这个接口由服务端代发请求，不设边界就会变成
// 任意 SSRF 跳板（能去打公网、甚至云厂商元数据地址）。
func isPrivateAddress(raw string) bool {
	ip := strings.ToLower(strings.TrimSpace(raw))
	ip = strings.TrimPrefix(ip, "::ffff:")
	if ip == "::1" || ip == "localhost" {
		return true
	}
	if isIPv4(ip) {
		parts := strings.Split(ip, ".")
		nums := make([]int, 4)
		for i, p := range parts {
			n := 0
			for _, ch := range p {
				if ch < '0' || ch > '9' {
					return false
				}
				n = n*10 + int(ch-'0')
			}
			if n > 255 {
				return false
			}
			nums[i] = n
		}
		switch {
		case nums[0] == 10 || nums[0] == 127:
			return true
		case nums[0] == 172 && nums[1] >= 16 && nums[1] <= 31:
			return true
		case nums[0] == 192 && nums[1] == 168:
			return true
		case nums[0] == 169 && nums[1] == 254:
			return ip != "169.254.169.254"
		case nums[0] == 100 && nums[1] >= 64 && nums[1] <= 127:
			return true
		default:
			return false
		}
	}
	if strings.HasPrefix(ip, "fc") || strings.HasPrefix(ip, "fd") {
		return true
	}
	if len(ip) >= 3 && ip[0] == 'f' && ip[1] == 'e' && strings.ContainsAny(ip[2:3], "89ab") {
		return true
	}
	return false
}

// targetIsPrivate 解析域名后每个地址都必须在内网，挡 DNS rebinding 到公网。
func targetIsPrivate(base string) bool {
	u, err := url.Parse(base)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return isPrivateAddress(host)
	}
	addrs, err := net.LookupIP(host)
	if err != nil || len(addrs) == 0 {
		return false
	}
	for _, addr := range addrs {
		if !isPrivateAddress(addr.String()) {
			return false
		}
	}
	return true
}

func stampName() string {
	return "elainachat-backup-" + time.Now().UTC().Format("2006-01-02-15-04-05") + ".zip"
}

func writeZip(w http.ResponseWriter, buf []byte) {
	h := w.Header()
	h.Set("Content-Type", "application/zip")
	h.Set("Content-Length", fmt.Sprintf("%d", len(buf)))
	h.Set("X-Backup-Filename", stampName())
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf)
}

func writeJSON(w http.ResponseWriter, code int, obj any) {
	body, err := json.Marshal(obj)
	if err != nil {
		body = []byte(`{"ok":false,"message":"响应序列化失败"}`)
		code = http.StatusInternalServerError
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	_, _ = w.Write(body)
}

func readJSONBody(r *http.Request, limit int64) (map[string]any, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("请求体过大")
	}
	var out map[string]any
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	if json.Unmarshal(raw, &out) != nil {
		return nil, fmt.Errorf("请求不是合法 JSON")
	}
	return out, nil
}
