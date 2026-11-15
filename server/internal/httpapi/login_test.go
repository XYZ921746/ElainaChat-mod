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
