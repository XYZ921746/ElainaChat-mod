package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elainachat/server/internal/agent"
	"elainachat/server/internal/auth"
	"elainachat/server/internal/config"
	"elainachat/server/internal/logx"
	"elainachat/server/internal/mcp"
	"elainachat/server/internal/plugin"
	"elainachat/server/internal/store"
)

func newServiceTestServer(t *testing.T) *Server {
	t.Helper()
	root := t.TempDir()
	cfg := &config.Config{
		AppRoot:     root,
		WebRoot:     filepath.Join(root, "web"),
		DataDir:     filepath.Join(root, "data"),
		ModsDir:     filepath.Join(root, "mods"),
		SkillsDir:   filepath.Join(root, "skills"),
		Host:        "127.0.0.1",
		Port:        4199,
		ServiceMode: true,
	}
	log := logx.Discard()
	authStore := auth.NewStore(cfg.DataDir, filepath.Join(cfg.WebRoot, ".local-auth.json"), log)
	if _, err := authStore.Ensure(); err != nil {
		t.Fatalf("初始化鉴权失败：%v", err)
	}
	dataStore := store.New(cfg.DataDir, log)
	s := New(cfg, log, authStore, auth.NewGuard(), nil, dataStore, plugin.New(cfg.ModsDir, log), nil, agent.New(cfg.AppRoot, cfg.DataDir, dataStore, log))
	s.SetPort(4199)
	return s
}

func serviceRequest(s *Server, method, path, origin string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	req.RemoteAddr = "127.0.0.1:45678"
	req.Host = "127.0.0.1:4199"
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func TestServiceModeRejectsForeignOrigin(t *testing.T) {
	s := newServiceTestServer(t)
	if rec := serviceRequest(s, http.MethodGet, "/api/ping", ""); rec.Code != http.StatusForbidden {
		t.Errorf("缺少 Origin 应被拒绝：%d %s", rec.Code, rec.Body.String())
	}
	if rec := serviceRequest(s, http.MethodGet, "/api/ping", "https://evil.example"); rec.Code != http.StatusForbidden {
		t.Errorf("陌生 Origin 应被拒绝：%d", rec.Code)
	}
}

func TestServiceModePingAndCORS(t *testing.T) {
	s := newServiceTestServer(t)
	rec := serviceRequest(s, http.MethodGet, "/api/ping", "https://localhost")
	if rec.Code != http.StatusOK {
		t.Fatalf("ping 失败：%d %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://localhost" {
		t.Errorf("CORS 没有回显 Origin：%q", got)
	}
	var body struct {
		OK         bool     `json:"ok"`
		Runtime    string   `json:"runtime"`
		ModsLoaded bool     `json:"modsLoaded"`
		ModRoutes  []string `json:"modRoutes"`
		ModStatic  []any    `json:"modStatic"`
		Port       int      `json:"port"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &body) != nil {
		t.Fatalf("ping 响应不是 JSON：%s", rec.Body.String())
	}
	if !body.OK || body.Runtime != "go" || !body.ModsLoaded || body.Port != 4199 {
		t.Errorf("ping 字段不对：%+v", body)
	}
	if body.ModRoutes == nil || body.ModStatic == nil {
		t.Errorf("modRoutes / modStatic 必须是数组（前端直接读）：%+v", body)
	}

	options := serviceRequest(s, http.MethodOptions, "/api/ping", "https://localhost")
	if options.Code != http.StatusNoContent {
		t.Errorf("OPTIONS 预检应返回 204：%d", options.Code)
	}
	allowMethods := options.Header().Get("Access-Control-Allow-Methods")
	if allowMethods == "" {
		t.Errorf("预检缺少 Allow-Methods")
	}
	for _, method := range []string{"GET", "POST", "PUT", "DELETE"} {
		if !strings.Contains(allowMethods, method) {
			t.Errorf("Allow-Methods 缺少 %s（插件面板会跨源发 DELETE）：%q", method, allowMethods)
		}
	}
}

func TestServiceModeCORSAllowsStoreClientHeader(t *testing.T) {
	s := newServiceTestServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/api/store", nil)
	req.RemoteAddr = "127.0.0.1:45678"
	req.Host = "127.0.0.1:4199"
	req.Header.Set("Origin", serviceOrigin)
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type, x-store-client")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS 预检应返回 204：%d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(strings.ToLower(rec.Header().Get("Access-Control-Allow-Headers")), "x-store-client") {
		t.Fatalf("预检必须放行 X-Store-Client：%q", rec.Header().Get("Access-Control-Allow-Headers"))
	}
	// 导出备份时页面要带 Keystore 里的密钥表；预检不放行这个头，APK 上导出会被浏览器直接拦死。
	if !strings.Contains(strings.ToLower(rec.Header().Get("Access-Control-Allow-Headers")), "x-elaina-secrets") {
		t.Fatalf("预检必须放行 X-Elaina-Secrets：%q", rec.Header().Get("Access-Control-Allow-Headers"))
	}
}

func TestServiceModeStoreRoundTrip(t *testing.T) {
	s := newServiceTestServer(t)
	post := []byte(`{"data":{"elaina_open_theme":"dark"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/store", bytes.NewReader(post))
	req.RemoteAddr = "127.0.0.1:45678"
	req.Host = "127.0.0.1:4199"
	req.Header.Set("Origin", serviceOrigin)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Store-Client", "native-test")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("service mode POST /api/store 失败：%d %s", rec.Code, rec.Body.String())
	}

	get := serviceRequest(s, http.MethodGet, "/api/store", serviceOrigin)
	if get.Code != http.StatusOK {
		t.Fatalf("service mode GET /api/store 失败：%d %s", get.Code, get.Body.String())
	}
	var body struct {
		OK   bool              `json:"ok"`
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal(get.Body.Bytes(), &body); err != nil {
		t.Fatalf("GET /api/store 不是 JSON：%s", get.Body.String())
	}
	if !body.OK || body.Data["elaina_open_theme"] != "dark" {
		t.Fatalf("service mode Store 往返失败：%+v", body)
	}
}

func TestServiceModeShutdownInvokesCallback(t *testing.T) {
	s := newServiceTestServer(t)
	called := make(chan struct{}, 1)
	s.SetShutdown(func() {
		select {
		case called <- struct{}{}:
		default:
		}
	})
	rec := serviceRequest(s, http.MethodPost, "/api/shutdown", "https://localhost")
	if rec.Code != http.StatusOK {
		t.Fatalf("shutdown 失败：%d %s", rec.Code, rec.Body.String())
	}
	select {
	case <-called:
	case <-time.After(2 * time.Second):
		t.Fatalf("shutdown 没有触发退出回调")
	}
}

func TestServiceModeModsStatus(t *testing.T) {
	s := newServiceTestServer(t)
	rec := serviceRequest(s, http.MethodGet, "/api/mods/status", "https://localhost")
	if rec.Code != http.StatusOK {
		t.Fatalf("mods/status 失败：%d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &body) != nil || body["ok"] != true || body["modsLoaded"] != true {
		t.Errorf("mods/status 字段不对：%s", rec.Body.String())
	}
}

// 手机页面在 https://localhost、服务在 http://127.0.0.1:<port>，是跨源：
// SameSite=Strict 的会话 cookie 不会被发出去，页面也没有登录流程。
// 所以设了访问密码之后本机请求仍必须可用 —— 否则一设密码应用就全 401 且无法恢复。
func TestServiceModeStaysUsableWithAccessPassword(t *testing.T) {
	s := newServiceTestServer(t)
	if err := s.auth.SetPasswordInMemory("Mobil3Pass"); err != nil {
		t.Fatal(err)
	}
	if !s.auth.HasAccessPassword() {
		t.Fatal("前置条件：密码应已生效")
	}

	// 不带任何 cookie / Bearer，与安卓页面发出的请求一致。
	for _, path := range []string{"/api/ping", "/api/store", "/api/mods/status", "/api/auth/status"} {
		rec := serviceRequest(s, http.MethodGet, path, "https://localhost")
		if rec.Code != http.StatusOK {
			t.Errorf("%s 应可用（跨源页面拿不到会话 cookie）：%d %s", path, rec.Code, rec.Body.String())
		}
	}
}

// 访问密码在手机上仍要能当局域网共享的凭据：本机免会话，不等于密码失效。
func TestServiceModePasswordStillGuardsShareLogin(t *testing.T) {
	s := newServiceTestServer(t)
	if err := s.auth.SetPasswordInMemory("Mobil3Pass"); err != nil {
		t.Fatal(err)
	}
	body := func(pwd string) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(map[string]string{"password": pwd})
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(raw))
		req.RemoteAddr = "127.0.0.1:45678"
		req.Host = "127.0.0.1:4199"
		req.Header.Set("Origin", "https://localhost")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		return rec
	}
	if rec := body("Mobil3Pass"); rec.Code != http.StatusOK {
		t.Errorf("正确密码应能登录：%d %s", rec.Code, rec.Body.String())
	}
	if rec := body("wrongpass1"); rec.Code != http.StatusUnauthorized {
		t.Errorf("错误密码应被拒：%d", rec.Code)
	}
}

// 关停必须把浏览器会话一起收掉：它的空闲计时器最长 5 分钟，
// 进程退出不会等它，不主动关就会留下孤儿浏览器进程与 %TEMP% 里的 profile 目录。
func TestBeginShutdownClosesBrowser(t *testing.T) {
	s := newServiceTestServer(t)
	if s.browser == nil {
		t.Fatal("前置条件：browser 会话应已创建")
	}
	s.BeginShutdown()
	if s.browser.IsRunning() {
		t.Error("BeginShutdown 后浏览器会话应已关闭")
	}
}

// BeginShutdown 必须停掉全部 MCP 客户端：http.Server.Shutdown 不会取消仍在执行的
// handler，远程会话与 stdio 子进程不显式停就会遗留到进程退出之后。
func TestBeginShutdownStopsMCP(t *testing.T) {
	var deleted bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var msg map[string]any
		_ = json.NewDecoder(r.Body).Decode(&msg)
		if r.Method == http.MethodDelete {
			deleted = true
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if sid := r.Header.Get("Mcp-Session-Id"); sid == "" {
			w.Header().Set("Mcp-Session-Id", "sess-1")
		}
		_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%v,"result":{"serverInfo":{"name":"r"}}}`, msg["id"])
	}))
	defer server.Close()

	s := newServiceTestServer(t)
	def := mcp.ServerDef{ID: "remote", URL: server.URL}
	if _, _, err := s.mcp.ListTools(context.Background(), def); err != nil {
		t.Fatalf("建立 MCP 会话失败：%v", err)
	}
	s.BeginShutdown()
	if !deleted {
		t.Error("BeginShutdown 应向远程 MCP 会话发送 DELETE")
	}
	if got := s.mcp.Status(def); got.State != "idle" {
		t.Errorf("BeginShutdown 后 MCP 状态应回到 idle，实际 %+v", got)
	}
}
