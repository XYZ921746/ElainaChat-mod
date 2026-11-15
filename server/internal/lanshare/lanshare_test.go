package lanshare

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIsPrivateAddress(t *testing.T) {
	priv := []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.5", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "localhost"}
	for _, ip := range priv {
		if !isPrivateAddress(ip) {
			t.Errorf("%s 应判为内网/回环", ip)
		}
	}
	pub := []string{"8.8.8.8", "1.1.1.1", "172.32.0.1", "169.254.169.254", "2001:4860::8888"}
	for _, ip := range pub {
		if isPrivateAddress(ip) {
			t.Errorf("%s 不应判为内网", ip)
		}
	}
}

func TestParseSource(t *testing.T) {
	cases := map[string]string{
		"192.168.1.5:3999":        "http://192.168.1.5:3999",
		"http://192.168.1.5:3999": "http://192.168.1.5:3999",
		"https://10.0.0.2":        "https://10.0.0.2",
	}
	for in, want := range cases {
		got, ok := parseSource(in)
		if !ok || got != want {
			t.Errorf("parseSource(%q)=%q,%v 期望 %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "ftp://x", "javascript:alert(1)"} {
		if _, ok := parseSource(bad); ok {
			t.Errorf("%q 不应被接受", bad)
		}
	}
}

// 共享只认访问密码：已设密码时能开启，未开启共享时导出应 403。
func TestEnableNeedsPasswordAndExportNeedsSharing(t *testing.T) {
	h := New(func(map[string]string) ([]byte, error) { return []byte("PK\x03\x04zip"), nil }, 0, nil)
	defer h.Close()

	rec := httptest.NewRecorder()
	h.Handle(rec, httptest.NewRequest(http.MethodGet, "/api/data/lan/export", nil), 3999)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "SHARE_OFF") {
		t.Fatalf("未开启共享时导出应 403：%d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.Handle(rec, httptest.NewRequest(http.MethodPost, "/api/data/lan/enable", nil), 3999)
	if rec.Code != http.StatusOK {
		t.Fatalf("已设访问密码时应能开启共享：%d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.Handle(rec, httptest.NewRequest(http.MethodGet, "/api/data/lan/export", nil), 3999)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("开启共享后应返回 zip：%d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
	if !strings.HasPrefix(rec.Header().Get("X-Backup-Filename"), "elainachat-backup-") {
		t.Errorf("缺少备份文件名头")
	}
}

func TestPullFromPrivatePeer(t *testing.T) {
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/login":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["password"] != "secret" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"ok":false}`))
				return
			}
			http.SetCookie(w, &http.Cookie{Name: "elaina_session", Value: "t"})
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/api/data/lan/export":
			if c, err := r.Cookie("elaina_session"); err != nil || c.Value != "t" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write([]byte("PK\x03\x04payload"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer peer.Close()

	h := New(func(map[string]string) ([]byte, error) { return nil, nil }, 0, nil)
	body, _ := json.Marshal(map[string]string{"sourceUrl": peer.URL, "password": "secret"})
	rec := httptest.NewRecorder()
	h.Handle(rec, httptest.NewRequest(http.MethodPost, "/api/data/lan/pull", bytes.NewReader(body)), 3999)
	if rec.Code != http.StatusOK {
		t.Fatalf("拉取失败：%d %s", rec.Code, rec.Body.String())
	}
	raw, _ := io.ReadAll(rec.Body)
	if string(raw) != "PK\x03\x04payload" {
		t.Errorf("返回内容不对：%q", raw)
	}
}

func TestPullRejectsPublicAddress(t *testing.T) {
	h := New(func(map[string]string) ([]byte, error) { return nil, nil }, 0, nil)
	body, _ := json.Marshal(map[string]string{"sourceUrl": "8.8.8.8:3999"})
	rec := httptest.NewRecorder()
	h.Handle(rec, httptest.NewRequest(http.MethodPost, "/api/data/lan/pull", bytes.NewReader(body)), 3999)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("公网地址应被拒绝：%d %s", rec.Code, rec.Body.String())
	}
}

type sharePayload struct {
	OK    bool `json:"ok"`
	Share struct {
		Port      int    `json:"port"`
		ExpiresAt int64  `json:"expiresAt"`
		Addresses []any  `json:"addresses"`
	} `json:"share"`
}

func enableShare(t *testing.T, h *Handler, port int) sharePayload {
	t.Helper()
	rec := httptest.NewRecorder()
	h.Handle(rec, httptest.NewRequest(http.MethodPost, "/api/data/lan/enable", nil), port)
	if rec.Code != http.StatusOK {
		t.Fatalf("开启共享失败：%d %s", rec.Code, rec.Body.String())
	}
	var payload sharePayload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil || !payload.OK {
		t.Fatalf("共享响应不合法：%s", rec.Body.String())
	}
	return payload
}

// 开启共享不再签发任何凭据：登录用的是本实例的访问密码，响应里不该再出现验证码字段。
func TestEnableIssuesNoShareCredential(t *testing.T) {
	h := New(func(map[string]string) ([]byte, error) { return nil, nil }, 0, nil)
	defer h.Close()

	rec := httptest.NewRecorder()
	h.Handle(rec, httptest.NewRequest(http.MethodPost, "/api/data/lan/enable", nil), 3999)
	if rec.Code != http.StatusOK {
		t.Fatalf("开启共享失败：%d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"code"`) {
		t.Fatalf("共享响应不应再带验证码字段：%s", rec.Body.String())
	}
	if !h.IsSharing() {
		t.Fatal("开启后应处于共享中")
	}
}

func TestShareWindowIsFiveMinutesAndIdempotent(t *testing.T) {
	h := New(func(map[string]string) ([]byte, error) { return []byte("PKzip"), nil }, 0, nil)
	defer h.Close()

	first := enableShare(t, h, 3999)
	remaining := time.Until(time.UnixMilli(first.Share.ExpiresAt))
	if remaining <= 0 || remaining > 5*time.Minute+2*time.Second {
		t.Fatalf("共享期应约为 5 分钟，实际剩余 %v", remaining)
	}

	// 共享未结束时再点一次不重新计时。
	second := enableShare(t, h, 3999)
	if second.Share.ExpiresAt != first.Share.ExpiresAt {
		t.Fatalf("重复开启不应延长共享期：%d vs %d", first.Share.ExpiresAt, second.Share.ExpiresAt)
	}

	// 过期后 IsSharing 为假，导出被拒。
	h.mu.Lock()
	h.shareUntil = time.Now().Add(-time.Second)
	h.mu.Unlock()
	if h.IsSharing() {
		t.Fatal("共享过期后 IsSharing 应为假")
	}
	rec := httptest.NewRecorder()
	h.Export(rec)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "SHARE_OFF") {
		t.Fatalf("共享过期后导出应被拒：%d %s", rec.Code, rec.Body.String())
	}
}

func TestShareListenerUsesTemporaryPort(t *testing.T) {
	h := New(func(map[string]string) ([]byte, error) { return nil, nil }, 0, nil)
	h.SetShareHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	h.SetMainHostAllInterfaces(false)
	defer h.Close()

	share := enableShare(t, h, 3999)
	if share.Share.Port == 3999 {
		t.Fatal("主监听在回环地址时，共享应使用临时端口")
	}
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", share.Share.Port))
	if err != nil {
		t.Fatalf("临时共享监听不可达：%v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("临时共享监听返回 %d", resp.StatusCode)
	}

	h.Close()
	if resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", share.Share.Port)); err == nil {
		_ = resp.Body.Close()
		t.Fatal("Close 后临时共享监听应关闭")
	}
}

// 开启共享时页面交上来的密钥表必须进备份：手机端 Key 只住 Keystore，data/ 里没有，
// 不合并这批值的话，对方通过共享拉到的备份天然缺 Key
// （表现为「局域网接收共享导入后只有 API Key 是空的」）。
func TestEnableCarriesSecretsIntoExport(t *testing.T) {
	var got map[string]string
	h := New(func(secrets map[string]string) ([]byte, error) {
		got = secrets
		return []byte("PKzip"), nil
	}, 0, nil)
	defer h.Close()

	body := `{}`
	req := httptest.NewRequest(http.MethodPost, "/api/data/lan/enable", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(secretsHeader, `{"apiKey":"sk-KEYSTORE","chatProviderKeys":"{\"p1\":\"sk-P\"}"}`)
	rec := httptest.NewRecorder()
	h.Handle(rec, req, 3999)
	if rec.Code != http.StatusOK {
		t.Fatalf("开启共享失败：%d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.Handle(rec, httptest.NewRequest(http.MethodGet, "/api/data/lan/export", nil), 3999)
	if rec.Code != http.StatusOK {
		t.Fatalf("导出失败：%d %s", rec.Code, rec.Body.String())
	}
	if got["apiKey"] != "sk-KEYSTORE" {
		t.Fatalf("共享导出没拿到页面交来的 Key：%v", got)
	}
	if got["chatProviderKeys"] != `{"p1":"sk-P"}` {
		t.Fatalf("供应商 Key 应原样带过来：%v", got)
	}
}

// 共享关闭后密钥表必须一起清掉：留着就是一份明文 Key 在内存里等下一次导出。
func TestShareSecretsClearedOnStop(t *testing.T) {
	h := New(func(map[string]string) ([]byte, error) {
		return []byte("PKzip"), nil
	}, 0, nil)
	defer h.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/data/lan/enable", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(secretsHeader, `{"apiKey":"sk-SECRET"}`)
	h.Handle(httptest.NewRecorder(), req, 3999)

	if h.shareSecrets() == nil {
		t.Fatal("前置条件：开启共享后应存着密钥表")
	}

	h.Close()   // 等价于共享到期

	if h.shareSecrets() != nil {
		t.Fatal("共享结束后密钥表必须清空")
	}
}

// 没交密钥表时导出照常（不能因为缺这批值让共享用不了）。
func TestExportWithoutSecretsStillWorks(t *testing.T) {
	h := New(func(secrets map[string]string) ([]byte, error) {
		if secrets != nil {
			t.Fatalf("没交密钥表时应传 nil，实得 %v", secrets)
		}
		return []byte("PKzip"), nil
	}, 0, nil)
	defer h.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/data/lan/enable", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.Handle(rec, req, 3999)
	if rec.Code != http.StatusOK {
		t.Fatalf("开启共享失败：%d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.Handle(rec, httptest.NewRequest(http.MethodGet, "/api/data/lan/export", nil), 3999)
	if rec.Code != http.StatusOK {
		t.Fatalf("无密钥表时导出应照常：%d %s", rec.Code, rec.Body.String())
	}
}
