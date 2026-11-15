package updatecheck

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIsValidRepo(t *testing.T) {
	good := []string{"XYZ921746/ElainaChat-mod", "a/b", "owner/repo.name"}
	for _, repo := range good {
		if !IsValidRepo(repo) {
			t.Errorf("%s 应合法", repo)
		}
	}
	bad := []string{"", "only-one", "a/b/c", "../x", "a/..", "a/b c"}
	for _, repo := range bad {
		if IsValidRepo(repo) {
			t.Errorf("%s 不应合法", repo)
		}
	}
}

func TestIsPublicIP(t *testing.T) {
	good := []string{"8.8.8.8", "1.1.1.1", "140.82.112.5"}
	for _, ip := range good {
		if !IsPublicIP(ip) {
			t.Errorf("%s 应判为公网", ip)
		}
	}
	bad := []string{"127.0.0.1", "10.0.0.1", "192.168.1.5", "172.16.0.1", "169.254.1.1", "::1", "not-an-ip"}
	for _, ip := range bad {
		if IsPublicIP(ip) {
			t.Errorf("%s 不应判为公网", ip)
		}
	}
}

func TestFindHostsHijack(t *testing.T) {
	text := "# comment\n127.0.0.1 localhost\n0.0.0.0 api.github.com\n"
	hit := FindHostsHijack(text, "api.github.com")
	if hit == nil || hit.Line != 3 || hit.IP != "0.0.0.0" {
		t.Fatalf("没有识别 hosts 劫持：%+v", hit)
	}
	if FindHostsHijack(text, "example.com") != nil {
		t.Errorf("不该误报其它主机")
	}
}

func TestSanitizeRelease(t *testing.T) {
	raw := []byte(`{
		"tag_name":"v2.2.0","name":"Release","html_url":"https://x","published_at":"2026-01-01",
		"body":"notes","prerelease":false,"zipball_url":"https://x.zip",
		"assets":[
			{"name":"app.exe","browser_download_url":"https://x/app.exe","size":123},
			{"name":"bad","browser_download_url":"http://insecure","size":1}
		]
	}`)
	release := SanitizeRelease(raw)
	if release == nil || release.Tag != "v2.2.0" || len(release.Assets) != 1 || release.Assets[0].Name != "app.exe" {
		t.Fatalf("release 收敛结果不对：%+v", release)
	}
	if SanitizeRelease([]byte(`{"name":"no tag"}`)) != nil {
		t.Errorf("缺少 tag_name 应返回 nil")
	}
}

func TestCheckWithTestServerAndCache(t *testing.T) {
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Header.Get("User-Agent") == "" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tag_name":"v9.9.9","name":"latest","html_url":"https://x","assets":[]}`))
	}))
	defer server.Close()

	checker := &Checker{Repo: "owner/repo", TTL: time.Minute, Timeout: 2 * time.Second, UA: "test", BaseURL: server.URL}
	first := checker.Check(context.Background())
	if !first.OK || first.Release == nil || first.Release.Tag != "v9.9.9" {
		t.Fatalf("检测失败：%+v", first)
	}
	second := checker.Check(context.Background())
	if !second.Cached || second.Release.Tag != "v9.9.9" {
		t.Fatalf("第二次应命中缓存：%+v", second)
	}
	if hits != 1 {
		t.Errorf("缓存没有生效，请求了 %d 次", hits)
	}
}

func TestCheckRateLimitAnd404(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "missing") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "2000000000")
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()

	checker := &Checker{Repo: "missing/x", Timeout: 2 * time.Second, UA: "test", BaseURL: server.URL}
	if got := checker.Check(context.Background()); got.Code != "NO_RELEASE" {
		t.Errorf("404 应报 NO_RELEASE：%+v", got)
	}
	checker = &Checker{Repo: "rate/x", Timeout: 2 * time.Second, UA: "test", BaseURL: server.URL}
	if got := checker.Check(context.Background()); got.Code != "RATE_LIMIT" {
		t.Errorf("403 + remaining=0 应报 RATE_LIMIT：%+v", got)
	}
}

func TestCheckInvalidRepo(t *testing.T) {
	checker := &Checker{Repo: "../bad", Timeout: time.Second, UA: "test", BaseURL: "http://127.0.0.1:1"}
	if got := checker.Check(context.Background()); got.Code != "CONFIG" {
		t.Errorf("非法 repo 应报 CONFIG：%+v", got)
	}
}
