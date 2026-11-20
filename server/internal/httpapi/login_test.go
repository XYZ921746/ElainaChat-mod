package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"elainachat/server/internal/auth"
	"elainachat/server/internal/config"
)

func doLogin(s *Server, remote, password string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"password": password})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	req.RemoteAddr = remote
	req.Host = "127.0.0.1:4199"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.handleLogin(&logWriter{ResponseWriter: rec}, req)
	return rec
}

// 共享登录只认本实例的访问密码：没设密码时共享登录被明确拒绝，不再有独立凭据。
func TestShareLoginRejectsWithoutAccessPassword(t *testing.T) {
	s, _ := newTestServer(t)
	t.Cleanup(s.lan.Close)
	s.lan.SetMainHostAllInterfaces(true)

	rec := httptest.NewRecorder()
	s.lan.Handle(rec, httptest.NewRequest(http.MethodPost, "/api/data/lan/enable", nil), s.cfg.Port)
	if rec.Code != http.StatusOK {
		t.Fatalf("开启共享失败：%d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"code"`) {
		t.Fatalf("共享响应不应再带验证码：%s", rec.Body.String())
	}

	body, _ := json.Marshal(map[string]string{"password": "123456"})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	req.RemoteAddr = "192.168.1.20:1234"
	req.Host = "127.0.0.1:4199"
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	s.handleShareLogin(&logWriter{ResponseWriter: rec}, req)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "PASSWORD_NOT_SET") {
		t.Fatalf("未设访问密码时共享登录应明确拒绝：%d %s", rec.Code, rec.Body.String())
	}
}

func TestShareLoginUsesAccessPassword(t *testing.T) {
	s, _ := newTestServer(t)
	t.Cleanup(s.lan.Close)

	const testPassword = "abcde1xy"

	s.lan.SetMainHostAllInterfaces(true)
	if err := s.auth.SetPassword(testPassword); err != nil {
		t.Fatalf("设置访问密码失败：%v", err)
	}

	rec := httptest.NewRecorder()
	s.lan.Handle(rec, httptest.NewRequest(http.MethodPost, "/api/data/lan/enable", nil), s.cfg.Port)
	if rec.Code != http.StatusOK {
		t.Fatalf("开启共享失败：%d %s", rec.Code, rec.Body.String())
	}

	ok := doLogin(s, "192.168.1.10:1234", testPassword)
	if ok.Code != http.StatusOK {
		t.Fatalf("访问密码应能登录共享：%d %s", ok.Code, ok.Body.String())
	}
	if !strings.Contains(ok.Header().Get("Set-Cookie"), auth.SessionCookiePrefix) {
		t.Fatal("登录应发放会话 Cookie")
	}
	if !strings.Contains(ok.Header().Get("Set-Cookie"), "Max-Age=604800") {
		t.Fatalf("密码登录应是完整会话寿命：%s", ok.Header().Get("Set-Cookie"))
	}

	wrong := doLogin(s, "192.168.1.12:1234", "000000")
	if wrong.Code != http.StatusUnauthorized {
		t.Fatalf("错误密码应回 401：%d %s", wrong.Code, wrong.Body.String())
	}

	// 共享登录入口同样只认密码，旧的 6 位码不再有效。
	body, _ := json.Marshal(map[string]string{"password": "123456"})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	req.RemoteAddr = "192.168.1.13:1234"
	req.Host = "127.0.0.1:4199"
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	s.handleShareLogin(&logWriter{ResponseWriter: rec}, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("共享登录不该再认 6 位验证码：%d %s", rec.Code, rec.Body.String())
	}
}

func postChangePassword(s *Server, next string, cookie string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"next": next})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/change-password", bytes.NewReader(body))
	req.RemoteAddr = "127.0.0.1:45678"
	req.Host = "127.0.0.1:4199"
	req.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	rec := httptest.NewRecorder()
	s.handleChangePassword(&logWriter{ResponseWriter: rec}, req)
	return rec
}

// 改密后的持久形态是 data/config.json 的 password 字段：新密码明文写入、旧 auth.json 删除，
// 重启后由 config 派生哈希（不再重建 auth.json）。managed 状态下 UI 改密也必须可用。
func TestChangePasswordWritesConfigAndDropsAuthFile(t *testing.T) {
	s, root := newTestServer(t)
	configPath := filepath.Join(root, "data", "config.json")
	authPath := filepath.Join(root, "data", "auth.json")
	s.SetConfigPath(configPath)

	first := strings.Repeat("First", 2) + "8zQ"
	second := strings.Repeat("Second", 2) + "3mV"

	rec := postChangePassword(s, first, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("首次改密应成功：%d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatalf("改密后 auth.json 应被删除：%v", err)
	}
	cfg, err := config.LoadFile(configPath)
	if err != nil || cfg.Password != first {
		t.Fatalf("新密码应写入 config.json：%+v %v", cfg, err)
	}
	var managed struct {
		PasswordManagedByConfig bool `json:"passwordManagedByConfig"`
	}
	cookie := ""
	for _, ck := range rec.Header().Values("Set-Cookie") {
		// 会话 cookie 名带实例后缀；同时下发的那条旧名清理指令是空值，不能当凭据用。
		name, value, _ := strings.Cut(ck, "=")
		if strings.HasPrefix(name, auth.SessionCookiePrefix) && value != "" {
			cookie = name + "=" + strings.SplitN(value, ";", 2)[0]
		}
	}
	if cookie == "" {
		t.Fatal("前置：改密响应应带新会话 cookie")
	}
	stReq := httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)
	stReq.RemoteAddr = "127.0.0.1:45678"
	stReq.Host = "127.0.0.1:4199"
	stReq.Header.Set("Cookie", cookie)
	stRec := httptest.NewRecorder()
	s.handleAuthStatus(stRec, stReq)
	if stRec.Code == http.StatusOK {
		_ = json.Unmarshal(stRec.Body.Bytes(), &managed)
	}
	if !managed.PasswordManagedByConfig {
		t.Fatal("改密后状态应报告密码由 config.json 管理")
	}

	// managed 状态下再次改密：新模型里 UI 改密就是写 config，不再 409。
	rec = postChangePassword(s, second, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("managed 状态下改密不应被拒绝：%d %s", rec.Code, rec.Body.String())
	}
	cfg, err = config.LoadFile(configPath)
	if err != nil || cfg.Password != second {
		t.Fatalf("第二次改密应更新 config.json：%+v %v", cfg, err)
	}
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatalf("auth.json 应保持删除：%v", err)
	}

	// 重启模拟：同 DATA_DIR 新 Store，config.json 的密码在启动路径派生，auth.json 不再出现。
	cfgBoot, err := config.LoadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	reborn := auth.NewStore(filepath.Join(root, "data"), filepath.Join(root, "web", ".local-auth.json"), nil)
	if _, err := reborn.Ensure(); err != nil {
		t.Fatal(err)
	}
	if err := reborn.SetPasswordInMemory(cfgBoot.Password); err != nil {
		t.Fatal(err)
	}
	if !reborn.VerifyPassword(second) || reborn.VerifyPassword(first) {
		t.Fatal("重启后应只认 config.json 里的新密码")
	}
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatalf("重启后 auth.json 应保持不存在：%v", err)
	}
}

// 未登录刷新深层页面时，登录后要回到原页面：next 只对应用页面带上，静态资源与 API 不带。
func TestLoginNextKeepsAppRoute(t *testing.T) {
	s := newStaticTestServer(t, map[string]string{"index.html": "<html></html>"})
	const password = "Abc12345"
	if err := s.auth.SetPassword(password); err != nil {
		t.Fatalf("设置访问密码失败：%v", err)
	}

	rec := staticRequest(s, http.MethodGet, "/notes/?tab=1", "", "")
	if rec.Code != http.StatusFound {
		t.Fatalf("未登录访问应用页应 302，实际 %d", rec.Code)
	}
	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatalf("Location 不合法：%v", err)
	}
	if loc.Path != "/login" || loc.Query().Get("next") != "/notes/?tab=1" {
		t.Fatalf("登录跳转应保留应用页地址，实际 %q", rec.Header().Get("Location"))
	}

	// 静态资源不配 next：登录后跳到一个 JS 文件没有意义。
	asset := staticRequest(s, http.MethodGet, "/js/app.js", "", "")
	if asset.Code != http.StatusFound || asset.Header().Get("Location") != "/login" {
		t.Fatalf("静态资源未登录应直接跳 /login，实际 %d %q", asset.Code, asset.Header().Get("Location"))
	}
}

// 已登录访问 /login 按 next 回跳；外部地址 / 非应用页一律丢弃。
func TestLoginRedirectUsesSafeNext(t *testing.T) {
	s := newStaticTestServer(t, map[string]string{"index.html": "<html></html>"})
	if err := s.auth.SetPassword("Abc12345"); err != nil {
		t.Fatal(err)
	}
	token, err := s.auth.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	cookie := s.auth.SessionCookieName() + "=" + token
	request := func(target string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req.RemoteAddr = "127.0.0.1:45678"
		req.Host = "127.0.0.1:4199"
		req.Header.Set("Cookie", cookie)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		return rec
	}

	if rec := request("/login?next=%2Fsettings%2Fmodel%2F"); rec.Code != http.StatusFound ||
		rec.Header().Get("Location") != "/settings/model/" {
		t.Fatalf("已登录应按 next 回到设置分栏，实际 %d %q", rec.Code, rec.Header().Get("Location"))
	}
	for _, next := range []string{"/js/app.js", "/api/store", "%2F%2Fevil.com%2F"} {
		rec := request("/login?next=" + next)
		if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/" {
			t.Errorf("不安全 / 非应用页 next 应回首页：%s → %d %q", next, rec.Code, rec.Header().Get("Location"))
		}
	}
}

// 并发改密是一个串行事务：两个请求都成功后，内存接受的密码必须与磁盘一致，
// 且配置文件始终是合法 JSON（以前共享临时文件会互相截断、争抢 rename）。
func TestConcurrentPasswordChangesStayConsistent(t *testing.T) {
	s, root := newTestServer(t)
	s.SetConfigPath(filepath.Join(root, "data", "config.json"))
	if err := s.auth.SetPassword("initial-password-1"); err != nil {
		t.Fatal(err)
	}
	token, err := s.auth.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	cookie := s.auth.SessionCookieName() + "=" + token

	for i := 0; i < 12; i++ {
		a := fmt.Sprintf("password-a-%d-x", i)
		b := fmt.Sprintf("password-b-%d-y", i)
		results := make([]int, 2)
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); <-start; results[0] = postChangePassword(s, a, cookie).Code }()
		go func() { defer wg.Done(); <-start; results[1] = postChangePassword(s, b, cookie).Code }()
		close(start)
		wg.Wait()
		for j, code := range results {
			if code != http.StatusOK {
				t.Fatalf("第 %d 轮并发改密返回 %d（请求 %d）", i, code, j)
			}
		}
		cfg, err := config.LoadFile(s.configPath)
		if err != nil {
			t.Fatalf("并发写后配置文件不是合法 JSON：%v", err)
		}
		if cfg.Password != a && cfg.Password != b {
			t.Fatalf("磁盘密码既不是请求 A 也不是请求 B：%q", cfg.Password)
		}
		if !s.auth.VerifyPassword(cfg.Password) {
			t.Fatalf("内存认证与磁盘密码不一致：磁盘 %q", cfg.Password)
		}
		// 下一轮用当前有效密码重新登录，保证两个请求都带合法会话。
		if err := s.auth.SetPassword("initial-password-1"); err != nil {
			t.Fatal(err)
		}
		token, err := s.auth.NewSession()
		if err != nil {
			t.Fatal(err)
		}
		cookie = s.auth.SessionCookieName() + "=" + token
	}
}

func TestSafeNextPath(t *testing.T) {
	good := map[string]string{
		"/":                    "/",
		"/notes/":              "/notes/",
		"/settings/model/":     "/settings/model/",
		"/web/store/":          "/web/store/",
		"/notes/?from=history": "/notes/?from=history",
	}
	for in, want := range good {
		if got := safeNextPath(in); got != want {
			t.Errorf("%q 应放行，实际 %q", in, got)
		}
	}
	bad := []string{
		"", "//evil.com", "https://evil.com/", "javascript:alert(1)",
		"/\\evil.com", "/js/app.js", "/api/store", "/settings/nope/",
		"/notes/../api/store", "/%2F%2Fevil.com", "/notes/\r\nX: y",
	}
	for _, in := range bad {
		if got := safeNextPath(in); got != "" {
			t.Errorf("%q 应拒绝，实际 %q", in, got)
		}
	}
}
