// Package httpapi 是 HTTP 入口：路由、鉴权闸门、静态资源与同端口双协议。
// 顺序是安全边界的一部分——Host 白名单必须排在「是否本机」之前，
// 否则 DNS rebinding 能让任意网页冒充本机管理员。
package httpapi

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"elainachat/server/internal/agent"
	"elainachat/server/internal/auth"
	"elainachat/server/internal/browser"
	"elainachat/server/internal/config"
	"elainachat/server/internal/lanshare"
	"elainachat/server/internal/logx"
	"elainachat/server/internal/mcp"
	"elainachat/server/internal/memoryindex"
	"elainachat/server/internal/packages"
	"elainachat/server/internal/plugin"
	"elainachat/server/internal/relay"
	"elainachat/server/internal/security"
	"elainachat/server/internal/store"
	"elainachat/server/internal/tlsutil"
	"elainachat/server/internal/updatecheck"
)

type Server struct {
	cfg      *config.Config
	log      *logx.Logger
	auth     *auth.Store
	guard    *auth.Guard
	cert     *tlsutil.Info
	store    *store.Store
	plugins  *plugin.Host
	packages *packages.Manager
	relay    *relay.Handler
	agent    *agent.Handler
	mcp      *mcp.Registry
	browser  *browser.Session
	lan      *lanshare.Handler
	update   *updatecheck.Checker
	storeHub *storeHub
	memory   *memoryindex.Store

	serviceMode bool
	shutdown    func()
	closing     chan struct{}
	closeOnce   sync.Once
	startedAt   time.Time

	configPasswordManaged bool
	configPath            string

	allowedHosts map[string]struct{}
	port         atomic.Int64

	execMu        sync.Mutex
	execApprovals map[string]execApproval
}

// execApproval 是危险命令的一次性批准凭据：服务端签发、绑定命令全文、过期作废。
// 请求体自证的 approved 布尔等于任何持会话的脚本都能替用户点头，所以批准状态必须
// 由服务端记录并只允许消费一次。
type execApproval struct {
	command   string
	expiresAt time.Time
}

const execApprovalTTL = 2 * time.Minute

func New(cfg *config.Config, log *logx.Logger, authStore *auth.Store, guard *auth.Guard, cert *tlsutil.Info, dataStore *store.Store, pluginHost *plugin.Host, relayHandler *relay.Handler, agentHandler *agent.Handler) *Server {
	s := &Server{
		cfg:          cfg,
		log:          log,
		auth:         authStore,
		guard:        guard,
		cert:         cert,
		store:        dataStore,
		plugins:      pluginHost,
		packages:     packages.New(cfg.ModsDir, cfg.SkillsDir, log),
		relay:        relayHandler,
		agent:        agentHandler,
		mcp:          mcp.NewRegistry(log),
		browser:      browser.New(log, os.Getenv("ELAINA_BROWSER_HEADLESS") == "1"),
		storeHub:     newStoreHub(),
		execApprovals: make(map[string]execApproval),
		update:       updatecheck.New(os.Getenv("ELAINA_UPDATE_REPO"), ""),
		closing:      make(chan struct{}),
		allowedHosts: buildAllowedHosts(cfg),
		serviceMode:  cfg.ServiceMode,
		startedAt:    time.Now(),
	}
	// 共享导出与普通导出共用 buildBackupWithSecrets：手机端 Key 只在 Keystore 里，
	// 开启共享时页面经 X-Elaina-Secrets 头交上来，lanshare 存在内存里再交给这里。
	s.lan = lanshare.New(s.buildBackupWithSecrets, maxBackupUpload, log)
	s.lan.SetMainHostAllInterfaces(hostAllInterfaces(cfg.Host))
	s.lan.SetShareHandler(s.lanShareHandler())
	return s
}

func (s *Server) SetPort(p int) { s.port.Store(int64(p)) }
func (s *Server) Port() int     { return int(s.port.Load()) }

// SetShutdown 由入口注入：手机端的 /api/shutdown 要能让进程自然退出
// （Java 服务进程靠这个把监听关掉，而不是强杀）。
func (s *Server) SetShutdown(fn func()) { s.shutdown = fn }

// SetConfigPasswordManaged 由入口注入：密码当前保存在 data/config.json
// （启动时带了 password，或界面改密后已写入）。状态接口据此回给设置页。
func (s *Server) SetConfigPasswordManaged(v bool) { s.configPasswordManaged = v }

// SetConfigPath 由入口注入：界面改密要把新密码写进 data/config.json，得知道它在哪。
func (s *Server) SetConfigPath(path string) { s.configPath = path }

// SetMemoryIndex 由入口注入。nil 表示索引没打开（库损坏 / 权限），
// /api/memory/* 返回 501，页面改动只留在页面内存。
func (s *Server) SetMemoryIndex(index *memoryindex.Store) { s.memory = index }

// BeginShutdown 通知长连接主动收尾。SSE（/api/store/stream）不会自己结束，
// 不先断开它，http.Server.Shutdown 只能干等到调用方给的超时（用户看到的就是关窗卡几秒）。
// 浏览器会话也在这里收：它的空闲计时器最长 5 分钟，进程退出不会等它，
// 不管的话每次带活跃会话退出都会留下孤儿 Chrome 进程与 %TEMP% 里的 profile 目录。
func (s *Server) BeginShutdown() {
	s.closeOnce.Do(func() {
		close(s.closing)
		if s.lan != nil {
			s.lan.Close()
		}
		if s.browser != nil {
			s.browser.Close()
		}
	})
}

// hostAllInterfaces 判断主监听是否已经覆盖所有网卡：覆盖时共享直接复用主端口，
// 否则共享需要一个临时监听，才能做到不受 host=127.0.0.1 限制。
func hostAllInterfaces(host string) bool {
	h := strings.TrimSpace(host)
	return h == "" || h == "0.0.0.0" || h == "::"
}

// lanShareHandler 是共享期临时监听的唯一入口：只放行密码登录与备份导出，
// 避免为了传一次备份把整个应用暴露到局域网。
func (s *Server) lanShareHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.lan == nil || !s.lan.IsSharing() {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"ok": false, "code": "SHARE_OFF", "message": "局域网共享已关闭或已过期",
			}, nil)
			return
		}
		switch {
		case r.URL.Path == "/api/auth/login" && r.Method == http.MethodPost:
			s.handleShareLogin(&logWriter{ResponseWriter: w}, r)
		case r.URL.Path == "/api/data/lan/export" && r.Method == http.MethodGet:
			if !s.hasValidSession(r) {
				writeJSON(w, http.StatusUnauthorized, map[string]any{
					"ok": false, "message": "需要访问密码登录",
				}, nil)
				return
			}
			s.lan.Export(w)
		default:
			writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": "共享接口不存在"}, nil)
		}
	})
}

func buildAllowedHosts(cfg *config.Config) map[string]struct{} {
	set := map[string]struct{}{
		"localhost": {}, "127.0.0.1": {}, "::1": {}, "[::1]": {},
	}
	if hostname, err := os.Hostname(); err == nil {
		set[strings.ToLower(hostname)] = struct{}{}
	}
	if ifaces, err := net.Interfaces(); err == nil {
		for _, iface := range ifaces {
			addrs, err := iface.Addrs()
			if err != nil {
				continue
			}
			for _, addr := range addrs {
				ipNet, ok := addr.(*net.IPNet)
				if !ok {
					continue
				}
				ip := ipNet.IP.String()
				if i := strings.Index(ip, "%"); i >= 0 {
					ip = ip[:i]
				}
				set[strings.ToLower(ip)] = struct{}{}
			}
		}
	}
	for _, h := range cfg.AllowedHosts {
		set[strings.ToLower(h)] = struct{}{}
	}
	return set
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	lw := &logWriter{ResponseWriter: w}
	started := time.Now()
	s.handle(lw, r)
	s.logRequest(r, lw.status, time.Since(started), lw.note)
}

func (s *Server) handle(w *logWriter, r *http.Request) {
	// 反斜杠先归一成斜杠：URL 解析不碰它，而 Windows 的 filepath.Join 会把它当分隔符，
	// 不归一的话 /..\..\data 这类路径会绕过段判定。
	pathname := strings.ReplaceAll(r.URL.Path, "\\", "/")

	// 手机端页面在 https://localhost，服务在 http://127.0.0.1:<port>：天生跨源。
	// 这一段把桌面那套「同源」判定换成 Capacitor 的固定 Origin 白名单，
	// 并给所有响应补 CORS；OPTIONS 预检必须排在鉴权之前。
	if s.serviceMode {
		applyServiceCORS(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if !serviceOriginAllowed(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"ok": false, "message": "只接受来自本应用页面的请求（缺少正确的 Origin）",
			}, nil)
			return
		}
	}

	if !s.isAllowedHost(r) {
		msg := "禁止访问：请求的 Host「" + r.Host + "」不在允许列表内。\n" +
			"如果你确实是通过主机名/域名访问，请用环境变量追加白名单后重启，例如：\n" +
			"  set ALLOWED_HOSTS=my-pc.local\n" +
			"（这是为了防止 DNS rebinding 让任意网页拿到本机管理员身份）"
		if strings.HasPrefix(pathname, "/api/") {
			writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": msg}, nil)
			return
		}
		writePlain(w, http.StatusForbidden, msg)
		return
	}

	if !s.serviceMode && s.cert != nil && r.TLS == nil {
		if done := s.maybeUpgradeToHTTPS(w, r, pathname); done {
			return
		}
	}

	// 非 GET 的跨站请求一律拒绝：浏览器会带 Origin，第三方页面不能悄悄 POST 改密码。
	// 服务模式的 Origin 已由上面的固定白名单处理，不能再按同源判（页面本来就在另一个源）。
	if !s.serviceMode && r.Method != http.MethodGet && r.Method != http.MethodHead && !s.sameOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "跨站请求被拒绝"}, nil)
		return
	}
	// 跨站 GET 也要拦：第三方页面可以不带 Origin，但会带 Sec-Fetch-Site: cross-site；
	// 不拦的话 /api/agent/read 能被任意网页借本机浏览器读取本地文件。
	if !s.serviceMode && strings.HasPrefix(pathname, "/api/") &&
		security.IsCrossSite(r.Header.Get("Sec-Fetch-Site"), r.Header.Get("Origin"), r.Host) {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "跨站请求被拒绝"}, nil)
		return
	}

	if pathname == "/api/server-info" && r.Method == http.MethodGet {
		httpsPort := 0
		if s.cert != nil {
			httpsPort = s.Port()
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":        true,
			"httpsPort": httpsPort,
			"httpPort":  s.Port(),
			"version":   s.cfg.Version,
			"edition":   s.cfg.Edition,
		}, nil)
		return
	}

	if pathname == "/login" {
		if s.isAuthenticated(r) || !s.auth.HasAccessPassword() {
			// 无密码态没有登录页：闸门未启用，回首页即可。
			redirect(w, "/", "")
			return
		}
		s.renderLogin(w)
		return
	}

	if pathname == "/api/auth/login" && r.Method == http.MethodPost {
		s.handleLogin(w, r)
		return
	}
	// 登出不需要鉴权：没登录也应当能清掉一个残留 cookie，且它不泄漏任何信息。
	if pathname == "/api/auth/logout" && r.Method == http.MethodPost {
		s.handleLogout(w, r)
		return
	}

	// 鉴权闸门：只在设置了访问密码后启用；无密码态谁都能过，
	// 可达范围由监听地址（config.json 的 host）管，不在这里管。
	if !s.isAuthenticated(r) {
		if strings.HasPrefix(pathname, "/api/") {
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"ok": false, "message": "需要访问密码", "needLogin": true,
			}, nil)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		redirect(w, "/login", "")
		return
	}

	// 手机端服务模式的三条专属路由：探针、插件状态、优雅退出。
	if s.serviceMode {
		switch {
		case pathname == "/api/ping" && r.Method == http.MethodGet:
			s.handleServicePing(w)
			return
		case pathname == "/api/mods/status" && r.Method == http.MethodGet:
			s.handleServiceModsStatus(w)
			return
		case pathname == "/api/shutdown" && r.Method == http.MethodPost:
			s.handleServiceShutdown(w)
			return
		}
	}

	// 记忆向量索引：派生数据，放在鉴权闸门之后、插件路由之前，避免插件抢占 /api/memory/。
	if strings.HasPrefix(pathname, "/api/memory/") {
		s.handleMemory(w, r)
		return
	}

	// 局域网共享与 /api/data/* 同属一段：开关与导出都在本机/已登录的前提下。
	if s.lan != nil && strings.HasPrefix(pathname, "/api/data/lan/") {
		if s.lan.Handle(w, r, s.Port()) {
			return
		}
	}

	switch {
	case pathname == "/api/ping" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true}, nil)
		return
	case pathname == "/api/auth/status" && r.Method == http.MethodGet:
		s.handleAuthStatus(w, r)
		return
	case pathname == "/api/auth/change-password" && r.Method == http.MethodPost:
		s.handleChangePassword(w, r)
		return
	case pathname == "/api/agent/roots" && r.Method == http.MethodGet:
		s.handleAgentRoots(w, r)
		return
	case pathname == "/api/agent/ls" && r.Method == http.MethodGet:
		s.handleAgentLs(w, r)
		return
	case pathname == "/api/agent/read" && r.Method == http.MethodGet:
		s.handleAgentRead(w, r)
		return
	case pathname == "/api/agent/write" && r.Method == http.MethodPost:
		s.handleAgentWrite(w, r)
		return
	case pathname == "/api/agent/delete" && r.Method == http.MethodPost:
		s.handleAgentDelete(w, r)
		return
	case pathname == "/api/agent/exec" && r.Method == http.MethodPost:
		s.handleAgentExec(w, r)
		return
	case pathname == "/api/logs/tail" && r.Method == http.MethodGet:
		s.handleLogsTail(w, r)
		return
	case pathname == "/api/logs/settings" && r.Method == http.MethodGet:
		s.handleLogsSettingsGet(w, r)
		return
	case pathname == "/api/logs/settings" && r.Method == http.MethodPost:
		s.handleLogsSettingsPost(w, r)
		return
	case pathname == "/api/relay" && r.Method == http.MethodPost:
		if s.relay == nil {
			writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "message": "中转未启用"}, nil)
			return
		}
		s.relay.Handle(w, r)
		return
	case pathname == "/api/client-log" && r.Method == http.MethodPost:
		s.handleClientLog(w, r)
		return
	case pathname == "/api/store" && r.Method == http.MethodGet:
		s.handleStoreGet(w, r)
		return
	case pathname == "/api/store" && r.Method == http.MethodPost:
		s.handleStorePost(w, r)
		return
	case pathname == "/api/store/stream" && r.Method == http.MethodGet:
		s.handleStoreStream(w, r)
		return
	case pathname == "/api/data/export" && r.Method == http.MethodGet:
		s.handleDataExport(w, r)
		return
	case pathname == "/api/data/import" && r.Method == http.MethodPost:
		s.handleDataImport(w, r)
		return
	case pathname == "/api/data/info" && r.Method == http.MethodGet:
		s.handleDataInfo(w, r)
		return
	case pathname == "/api/plugins" && r.Method == http.MethodGet:
		s.handlePluginsList(w, r)
		return
	case pathname == "/api/plugins/install" && r.Method == http.MethodPost:
		s.handlePluginInstall(w, r)
		return
	case pathname == "/api/plugins/open-folder" && r.Method == http.MethodPost:
		s.handlePluginOpenFolder(w, r)
		return
	case pathname == "/api/skills" && r.Method == http.MethodGet:
		s.handleSkillsList(w, r)
		return
	case pathname == "/api/skills/install" && r.Method == http.MethodPost:
		s.handleSkillInstall(w, r)
		return
	case pathname == "/api/mcp/tools" && r.Method == http.MethodGet:
		s.handleMCPTools(w, r)
		return
	case pathname == "/api/mcp/call" && r.Method == http.MethodPost:
		s.handleMCPCall(w, r)
		return
	case pathname == "/api/mcp/test" && r.Method == http.MethodPost:
		s.handleMCPTest(w, r)
		return
	case pathname == "/api/mcp/stop" && r.Method == http.MethodPost:
		s.handleMCPStop(w, r)
		return
	case pathname == "/api/mcp/status" && r.Method == http.MethodGet:
		s.handleMCPStatus(w, r)
		return
	case pathname == "/api/agent/browser" && r.Method == http.MethodPost:
		s.handleAgentBrowser(w, r)
		return
	case pathname == "/api/agent/browser/status" && r.Method == http.MethodGet:
		s.handleAgentBrowserStatus(w, r)
		return
	case pathname == "/api/agent/activity" && r.Method == http.MethodGet:
		s.handleAgentActivity(w, r)
		return
	case pathname == "/api/app/update" && r.Method == http.MethodGet:
		s.handleAppUpdate(w, r)
		return
	case pathname == "/favicon.ico":
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// 带路径参数的宿主路由：必须在插件路由之前，否则 /api/plugins/<id> 会被
	// 插件声明的 /api 前缀寄走。
	if id, rest, ok := splitPrefixed(pathname, "/api/plugins/"); ok {
		switch {
		case rest == "readme" && r.Method == http.MethodGet:
			s.handlePluginReadme(w, r, id)
			return
		case id != "" && r.Method == http.MethodDelete:
			s.handlePluginDelete(w, r, id)
			return
		}
	}
	if id, rest, ok := splitPrefixed(pathname, "/api/skills/"); ok {
		switch {
		case rest == "content" && r.Method == http.MethodGet:
			s.handleSkillContent(w, r, id)
			return
		case r.Method == http.MethodDelete:
			// 技能 id 可以带层级（插件随附技能是 <插件id>/<声明路径>），删除时整段都是 id；
			// splitPrefixed 按最后一个斜杠切 id/rest 是给 `<id>/content` 用的，这里要拼回去，
			// 否则 id 被截成 `<插件id>/skills`，既删不掉也拿不到「连同插件一起卸载」的提示。
			target := id
			if rest != "" {
				target = id + "/" + rest
			}
			s.handleSkillDelete(w, r, target)
			return
		}
	}

	// 插件路由排在宿主所有路由之后、静态文件之前：宿主永远优先，
	// 而插件声明的 /api 前缀不能被静态处理器当成「找不到的文件」。
	if s.plugins != nil && s.plugins.Handle(w, r) {
		return
	}

	if pathname == "/mods/index.json" && r.Method == http.MethodGet {
		s.serveModIndex(w, r)
		return
	}

	// 插件声明的静态目录（Live2D 模型 / 引擎）优先于宿主静态解析。
	if s.plugins != nil {
		if abs, mimeMode, _, ok := s.plugins.ResolveStatic(pathname); ok {
			s.servePluginStatic(w, r, abs, mimeMode)
			return
		}
	}

	if strings.HasPrefix(pathname, "/mods/") {
		s.serveMods(w, r)
		return
	}

	if s.serveWeb(w, r, pathname) {
		return
	}
	writePlain(w, http.StatusNotFound, "Not found")
}

// splitPrefixed 拆出「前缀之后的一段」：最后一段当动作（readme / content），
// 前面全部当 id。技能随附 id 形如 <owner>/<rel>，不能按第一段切。
func splitPrefixed(pathname, prefix string) (id, rest string, ok bool) {
	if !strings.HasPrefix(pathname, prefix) {
		return "", "", false
	}
	remainder := strings.TrimPrefix(pathname, prefix)
	if remainder == "" {
		return "", "", false
	}
	if i := strings.LastIndex(remainder, "/"); i >= 0 {
		return remainder[:i], remainder[i+1:], true
	}
	return remainder, "", true
}

func (s *Server) isAllowedHost(r *http.Request) bool {
	hostname := security.HostnameOfHostHeader(r.Host)
	if hostname == "" {
		return false
	}
	_, ok := s.allowedHosts[hostname]
	return ok
}

func (s *Server) sameOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return u.Host == r.Host
}

// maybeUpgradeToHTTPS 返回 true 表示已经发过响应。
// 只跳页面导航：接口一跳前端 fetch 就会失败，本机跳走反而多一次证书警告。
func (s *Server) maybeUpgradeToHTTPS(w *logWriter, r *http.Request, pathname string) bool {
	q := r.URL.Query()
	switch q.Get("stay") {
	case "http":
		next := *r.URL
		nq := next.Query()
		nq.Del("stay")
		next.RawQuery = nq.Encode()
		w.note = "=> " + next.Path
		redirect(w, next.Path+querySuffix(next.RawQuery),
			"elaina_stay_http=1; Path=/; Max-Age=31536000; SameSite=Lax")
		return true
	case "https":
		redirect(w, r.URL.Path, "elaina_stay_http=; Path=/; Max-Age=0; SameSite=Lax")
		return true
	}

	reqHostname := security.HostnameOfHostHeader(r.Host)
	cookies := parseCookies(r)
	canUpgrade := !strings.HasPrefix(pathname, "/api/") &&
		!security.IsLoopbackHostname(reqHostname) &&
		cookies["elaina_stay_http"] != "1" &&
		strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/html")
	if !canUpgrade {
		return false
	}
	port := "443"
	if _, p, err := net.SplitHostPort(r.Host); err == nil {
		port = p
	}
	target := "https://" + reqHostname + ":" + port + r.URL.RequestURI()
	if reqHostname == "localhost" || reqHostname == "127.0.0.1" {
		target = "https://" + r.Host + r.URL.RequestURI()
	}
	redirect(w, target, "")
	return true
}

func querySuffix(raw string) string {
	if raw == "" {
		return ""
	}
	return "?" + raw
}

func (s *Server) isAuthenticated(r *http.Request) bool {
	if s.serviceMode {
		// 手机端的边界是 Origin 白名单（handle 开头的 serviceOriginAllowed），不是会话：
		// 页面在 https://localhost、服务在 http://127.0.0.1:<port>，是跨源，SameSite=Strict
		// 的会话 cookie 不会被浏览器发出去，页面也没有登录流程。在这里再要求会话，
		// 结果就是「一设访问密码，应用立刻全部 401 且没有任何恢复路径」。
		// 访问密码在手机上只承担局域网共享的凭据（handleShareLogin），不参与本机鉴权。
		return true
	}
	if !s.auth.HasAccessPassword() {
		// 无密码态不设闸门：谁都能过。端口对谁可达由监听地址决定（config.json 的
		// host，默认只绑回环），在无密码时把监听开到外部是管理人员自己的选择，
		// 这里不再用登录页挡第二道——无密码态连登录页都不存在。
		return true
	}
	return s.hasValidSession(r)
}

// hasValidSession 接受两种携带方式：本实例专属的 cookie，或 Authorization: Bearer。
// cookie 给普通浏览器页面用（自动携带，前端零改动）；Bearer 给脚本、插件面板与
// 跨源场景用（EventSource 之外的自定义头通道）。
func (s *Server) hasValidSession(r *http.Request) bool {
	if token := bearerToken(r); token != "" {
		if s.auth.HasValidSession(token) {
			return true
		}
	}
	// cookie 名带实例后缀：同一域下多个实例各持一份，互不覆盖。
	return s.auth.HasValidSession(parseCookies(r)[s.auth.SessionCookieName()])
}

// bearerToken 取 Authorization 头里的 Bearer 凭据；没有或格式不符时返回空。
func bearerToken(r *http.Request) string {
	raw := strings.TrimSpace(r.Header.Get("Authorization"))
	const prefix = "Bearer "
	if len(raw) <= len(prefix) || !strings.EqualFold(raw[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(raw[len(prefix):])
}

func (s *Server) handleLogin(w *logWriter, r *http.Request) {
	ip := clientIP(r)
	// 无密码态没有可校验的密码，登录无意义（应用本来就谁都能进）。
	// 局域网共享也走访问密码：共享只是「临时把本机暴露给局域网」，凭据仍是本实例的密码。
	if !s.auth.HasAccessPassword() {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"ok":      false,
			"code":    "PASSWORD_NOT_SET",
			"message": "尚未设置访问密码：现在打开应用不需要登录。请先在「设置 → 高级 → 访问密码」里设置一个密码，再用它登录。",
		}, nil)
		return
	}
	if st := s.guard.Status(ip); st.Blocked {
		scopeMsg := "尝试次数过多"
		if st.Scope == "global" {
			scopeMsg = "失败次数过多，登录已临时冻结"
		}
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"ok":            false,
			"retryAfterSec": st.RetryAfterSec,
			"message":       scopeMsg + "，请 " + strconv.Itoa(st.RetryAfterSec) + " 秒后再试",
		}, map[string]string{"Retry-After": strconv.Itoa(st.RetryAfterSec)})
		return
	}

	body, err := readJSON(r, 64*1024)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "请求无效"}, nil)
		return
	}
	password, _ := body["password"].(string)
	if !s.auth.VerifyPassword(password) {
		res := s.guard.Fail(ip)
		note := fmt.Sprintf("（第 %d 次）", res.Count)
		if res.LockMs > 0 {
			note = fmt.Sprintf("，已锁定 %d 秒", (res.LockMs+999)/1000)
		}
		if res.GlobalLocked {
			note += " · 触发全局冻结"
		}
		s.log.Warnf("Auth", "密码错误 · %s%s", ip, note)
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "message": "密码不正确"}, nil)
		return
	}
	s.guard.Succeed(ip)

	sessionTTL := auth.SessionTTL
	token, err := s.auth.NewSessionWithTTL(sessionTTL)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "登录失败：无法创建会话"}, nil)
		return
	}
	// 同时把 token 放进响应体：脚本与插件面板可以直接用 Authorization: Bearer，
	// 不必解析 Set-Cookie（HttpOnly 的 cookie 读不到，这是它防 XSS 的代价）。
	writeJSONCookies(w, http.StatusOK, map[string]any{
		"ok":        true,
		"token":     token,
		"expiresIn": int(sessionTTL.Seconds()),
	}, nil, s.sessionCookie(token, r, sessionTTL))
}

// sessionCookie 用本实例专属的 cookie 名签发。同时清掉旧的无后缀 cookie：
// 它的 token 在新方案下已无法校验（没有实例归属），留着只会让浏览器反复带上一个废值。
func (s *Server) sessionCookie(token string, r *http.Request, ttl time.Duration) []string {
	attrs := "; Path=/; HttpOnly; SameSite=Strict"
	if isHTTPS(r) {
		attrs += "; Secure"
	}
	names := []string{
		s.auth.SessionCookieName() + "=" + token + attrs + "; Max-Age=" + strconv.Itoa(int(ttl.Seconds())),
		auth.SessionCookie + "=" + attrs + "; Max-Age=0",
	}
	return names
}

// handleLogout 清掉本实例的会话 cookie。token 是自包含的，服务端没有单条记录可删，
// 所以登出只影响当前浏览器；要让所有设备一起失效请改访问密码（递增吊销代数）。
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "已退出登录"},
		map[string]string{"Set-Cookie": s.sessionCookie("", r, 0)[0]})
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	admin := isLocal(r)
	isDefault, hint := s.auth.AuthStatus()
	authFile := ""
	if admin {
		authFile = s.auth.AuthFile()
	}
	if !admin {
		hint = ""
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                      true,
		"isAdmin":                 admin,
		"isDefaultPassword":       isDefault,
		"passwordHint":            hint,
		"authFile":                authFile,
		"passwordManagedByConfig": s.configPasswordManaged,
	}, nil)
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) || !s.isAuthenticated(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"ok": false, "message": "只有本机（已登录的管理员）可以修改访问密码",
		}, nil)
		return
	}
	body, err := readJSON(r, 64*1024)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "请求无效"}, nil)
		return
	}
	next, _ := body["next"].(string)
	if res := auth.ValidatePasswordStrength(next); !res.OK {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": res.Message}, nil)
		return
	}
	// 持久形态是 data/config.json 的 password 字段：先写文件再改内存，写失败就整体不动。
	// 成功后旧密码文件（auth.json / 遗留位置）由 SetPasswordInMemory 删除，config 成为唯一权威。
	if err := config.SetConfigPassword(s.configPath, next); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "写入 data/config.json 失败：" + err.Error()}, nil)
		return
	}
	if err := s.auth.SetPasswordInMemory(next); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "保存密码失败：" + err.Error()}, nil)
		return
	}
	if err := s.auth.ClearSessions(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "密码已更新，但旧会话清理失败，请重新登录"}, nil)
		return
	}
	s.SetConfigPasswordManaged(true)
	// 改密码后把失败记录一并清掉：旧密码攒下的锁定不该连累新密码。
	s.guard.Reset()
	token, err := s.auth.NewSession()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "密码已更新，但会话创建失败，请重新登录"}, nil)
		return
	}
	s.log.Infof("Auth", "访问密码已更新并写入 data/config.json（其它设备需重新登录）")
	writeJSONCookies(w, http.StatusOK, map[string]any{
		"ok":        true,
		"message":   "访问密码已更新，已写入 data/config.json；其它设备需要用新密码重新登录",
		"minLength": auth.PwdMinLen,
		"token":     token,
	}, nil, s.sessionCookie(token, r, auth.SessionTTL))
}

// handleShareLogin 只给共享临时监听用：校验本实例的访问密码。
// 共享没有独立的凭据体系——谁能拉备份由本实例的访问密码决定。
func (s *Server) handleShareLogin(w *logWriter, r *http.Request) {
	ip := clientIP(r)
	if st := s.guard.Status(ip); st.Blocked {
		scopeMsg := "尝试次数过多"
		if st.Scope == "global" {
			scopeMsg = "失败次数过多，登录已临时冻结"
		}
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"ok":            false,
			"retryAfterSec": st.RetryAfterSec,
			"message":       scopeMsg + "，请 " + strconv.Itoa(st.RetryAfterSec) + " 秒后再试",
		}, map[string]string{"Retry-After": strconv.Itoa(st.RetryAfterSec)})
		return
	}
	body, err := readJSON(r, 64*1024)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "请求无效"}, nil)
		return
	}
	password, _ := body["password"].(string)
	if !s.auth.HasAccessPassword() {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"ok":      false,
			"code":    "PASSWORD_NOT_SET",
			"message": "对方尚未设置访问密码，无法通过密码登录。请让对方先设置访问密码再开启共享。",
		}, nil)
		return
	}
	if !s.auth.VerifyPassword(password) {
		res := s.guard.Fail(ip)
		note := fmt.Sprintf("（第 %d 次）", res.Count)
		if res.LockMs > 0 {
			note = fmt.Sprintf("，已锁定 %d 秒", (res.LockMs+999)/1000)
		}
		if res.GlobalLocked {
			note += " · 触发全局冻结"
		}
		s.log.Warnf("Auth", "共享登录密码错误 · %s%s", ip, note)
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "message": "访问密码不正确"}, nil)
		return
	}
	s.guard.Succeed(ip)
	sessionTTL := auth.SessionTTL
	token, err := s.auth.NewSessionWithTTL(sessionTTL)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "登录失败：无法创建会话"}, nil)
		return
	}
	// 同时把 token 放进响应体：脚本与插件面板可以直接用 Authorization: Bearer，
	// 不必解析 Set-Cookie（HttpOnly 的 cookie 读不到，这是它防 XSS 的代价）。
	writeJSONCookies(w, http.StatusOK, map[string]any{
		"ok":        true,
		"token":     token,
		"expiresIn": int(sessionTTL.Seconds()),
	}, nil, s.sessionCookie(token, r, sessionTTL))
}

// handleClientLog 接收浏览器控制台的上报。只保留结构化字段并压成一行，
// 前端堆栈里的换行会把日志阅读器整页刷乱。
func (s *Server) handleClientLog(w http.ResponseWriter, r *http.Request) {
	body, err := readJSON(r, 64*1024)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false}, nil)
		return
	}
	items, _ := body["items"].([]any)
	if len(items) > 20 {
		items = items[:20]
	}
	ip := clientIP(r)
	for _, item := range items {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		level, _ := row["level"].(string)
		page, _ := row["page"].(string)
		text, _ := row["text"].(string)
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		if len(page) > 36 {
			page = page[:36]
		}
		if len(text) > 2000 {
			text = text[:2000] + " …（已截断）"
		}
		text = strings.Join(strings.Fields(text), " ")
		line := fmt.Sprintf("[page] %-15s %s%s", ip, page, text)
		switch strings.ToLower(level) {
		case "error":
			s.log.Errorf("Page", "%s", line)
		case "warn":
			s.log.Warnf("Page", "%s", line)
		case "debug":
			s.log.Debugf("Page", "%s", line)
		default:
			s.log.Infof("Page", "%s", line)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true}, nil)
}

// logRequest 只记有意义的事件：静态资源与高频轮询成功时不记，
// 否则日志查看器会被自己的刷新请求淹没。
func (s *Server) logRequest(r *http.Request, code int, elapsed time.Duration, note string) {
	pathOnly := r.URL.Path
	// /api/store/stream 是 SSE 长连接，成功连接的寿命以分钟计，按耗时判「慢」没有意义；
	// 只在它以 4xx/5xx 收场时才值得记。
	if code < 400 && (isQuietFile(pathOnly) || pathOnly == "/api/logs/tail" || pathOnly == "/api/client-log" || pathOnly == "/api/store/stream") {
		return
	}
	slow := elapsed > 3*time.Second
	line := fmt.Sprintf("%-15s %-5s %-52s %-4d %5dms%s%s",
		clientIP(r), r.Method, clip(pathOnly, 52), code, elapsed.Milliseconds(),
		suffixIf(slow, "  << SLOW"), suffixIf(note != "", "   "+note))
	switch {
	case code >= 500:
		s.log.Errorf("HTTP", "%s   << server error", line)
	case code >= 400:
		s.log.Warnf("HTTP", "%s   << request failed", line)
	case slow:
		// 慢但成功不是失败：中转、备份导入、市场下载这些请求本来就以分钟计。
		s.log.Infof("HTTP", "%s", line)
	default:
		s.log.Debugf("HTTP", "%s", line)
	}
}

func isQuietFile(path string) bool {
	lower := strings.ToLower(path)
	for _, ext := range []string{".js", ".mjs", ".css", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".map"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-3] + "..."
}

func suffixIf(ok bool, s string) string {
	if ok {
		return s
	}
	return ""
}

// logWriter 记录状态码与备注，供请求日志使用；同时保留 Flush 让流式响应可用。
type logWriter struct {
	http.ResponseWriter
	status int
	note   string
}

func (w *logWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *logWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

func (w *logWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
