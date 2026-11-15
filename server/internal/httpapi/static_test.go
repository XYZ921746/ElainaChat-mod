package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"elainachat/server/internal/agent"
	"elainachat/server/internal/auth"
	"elainachat/server/internal/config"
	"elainachat/server/internal/logx"
	"elainachat/server/internal/plugin"
	"elainachat/server/internal/store"
)

// newStaticTestServer 起一个带真实 web/ 静态根的服务器：缓存头与条件请求都在 serveWeb 里，
// 必须走完整路由才能覆盖到。
func newStaticTestServer(t *testing.T, files map[string]string) *Server {
	t.Helper()
	root := t.TempDir()
	webRoot := filepath.Join(root, "web")
	for name, body := range files {
		full := filepath.Join(webRoot, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("建目录失败：%v", err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatalf("写文件失败：%v", err)
		}
	}
	cfg := &config.Config{
		AppRoot:   root,
		WebRoot:   webRoot,
		DataDir:   filepath.Join(root, "data"),
		ModsDir:   filepath.Join(root, "mods"),
		SkillsDir: filepath.Join(root, "skills"),
		Host:      "127.0.0.1",
		Port:      4199,
	}
	log := logx.Discard()
	authStore := auth.NewStore(cfg.DataDir, filepath.Join(cfg.WebRoot, ".local-auth.json"), log)
	if _, err := authStore.Ensure(); err != nil {
		t.Fatalf("初始化鉴权失败：%v", err)
	}
	dataStore := store.New(cfg.DataDir, log)
	s := New(cfg, log, authStore, auth.NewGuard(), nil, dataStore, plugin.New(cfg.ModsDir, log), nil,
		agent.New(cfg.AppRoot, cfg.DataDir, dataStore, log))
	s.SetPort(4199)
	return s
}

func staticRequest(s *Server, method, path, extraHeader, value string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	req.RemoteAddr = "127.0.0.1:45678"
	req.Host = "127.0.0.1:4199"
	if extraHeader != "" {
		req.Header.Set(extraHeader, value)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

// 静态资源必须允许缓存但每次校验：no-store 会让每次刷新重下整份前端（116 个脚本 / 2.6MB）。
func TestStaticAssetsAreRevalidatable(t *testing.T) {
	s := newStaticTestServer(t, map[string]string{
		"index.html": "<html></html>",
		"js/app.js":  "console.log(1)",
	})
	for _, path := range []string{"/", "/js/app.js"} {
		rec := staticRequest(s, http.MethodGet, path, "", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s 应 200，实际 %d", path, rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("%s 的 Cache-Control 应为 no-cache（可缓存 + 每次校验），实际 %q", path, cc)
		}
		if rec.Header().Get("ETag") == "" {
			t.Errorf("%s 应带 ETag，否则浏览器无法发条件请求", path)
		}
		if rec.Header().Get("Last-Modified") == "" {
			t.Errorf("%s 应带 Last-Modified（只认它的客户端也要能 304）", path)
		}
	}
}

// 内容没变时回 304 且不带正文；内容变了 ETag 必须变，否则用户刷新还是旧插件。
func TestStaticConditionalRequest(t *testing.T) {
	s := newStaticTestServer(t, map[string]string{"js/app.js": "v1"})

	first := staticRequest(s, http.MethodGet, "/js/app.js", "", "")
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("首次响应应带 ETag")
	}

	again := staticRequest(s, http.MethodGet, "/js/app.js", "If-None-Match", etag)
	if again.Code != http.StatusNotModified {
		t.Fatalf("ETag 未变时应回 304，实际 %d", again.Code)
	}
	if body := again.Body.String(); body != "" {
		t.Errorf("304 不应带正文，实际 %q", body)
	}

	// 改文件内容：mtime 与大小都会变，ETag 必须变。
	path := filepath.Join(s.cfg.WebRoot, "js", "app.js")
	if err := os.WriteFile(path, []byte("v2-longer"), 0o644); err != nil {
		t.Fatal(err)
	}
	changed := staticRequest(s, http.MethodGet, "/js/app.js", "If-None-Match", etag)
	if changed.Code != http.StatusOK {
		t.Fatalf("文件改动后应回 200（新内容），实际 %d", changed.Code)
	}
	if body := changed.Body.String(); body != "v2-longer" {
		t.Errorf("应拿到新内容，实际 %q", body)
	}
	if newTag := changed.Header().Get("ETag"); newTag == etag {
		t.Error("内容变了 ETag 必须变，否则客户端会一直用旧文件")
	}
}

// 只认 If-Modified-Since 的客户端也要能 304。
func TestStaticIfModifiedSince(t *testing.T) {
	s := newStaticTestServer(t, map[string]string{"js/app.js": "x"})
	first := staticRequest(s, http.MethodGet, "/js/app.js", "", "")
	lm := first.Header().Get("Last-Modified")
	if lm == "" {
		t.Fatal("应带 Last-Modified")
	}
	rec := staticRequest(s, http.MethodGet, "/js/app.js", "If-Modified-Since", lm)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("If-Modified-Since 命中应回 304，实际 %d", rec.Code)
	}
}

// 插件清单每次都要重算（目录改了名、插件装了新的），不能进缓存。
func TestModIndexStaysNoStore(t *testing.T) {
	s := newStaticTestServer(t, map[string]string{"index.html": "<html></html>"})
	rec := staticRequest(s, http.MethodGet, "/mods/index.json", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("插件清单应 200，实际 %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("插件清单必须 no-store（内容随时变），实际 %q", cc)
	}
	var doc map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("插件清单不是合法 JSON：%v", err)
	}
}

func TestEtagsMatchVariants(t *testing.T) {
	const etag = `W/"abc-123"`
	for _, header := range []string{
		`W/"abc-123"`,
		`"abc-123"`,
		`W/"zzz-1", W/"abc-123"`,
		`*`,
		"  W/\"abc-123\"  ",
	} {
		if !etagMatches(header, etag) {
			t.Errorf("应匹配：%q", header)
		}
	}
	for _, header := range []string{`W/"other-1"`, `"abc-124"`, ``} {
		if etagMatches(header, etag) {
			t.Errorf("不应匹配：%q", header)
		}
	}
}
