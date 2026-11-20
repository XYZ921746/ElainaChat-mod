package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
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

// 前端页面地址没有对应文件，必须回退发应用外壳：刷新 /notes/、/store/ 才不会掉回首页。
func TestAppRoutesServeAppShell(t *testing.T) {
	s := newStaticTestServer(t, map[string]string{"index.html": "<html>shell</html>"})
	for _, path := range []string{
		"/", "/chat/", "/notes/", "/memory/", "/diary/", "/settings/",
		"/settings/model/", "/achievements/", "/store/",
		// /web 前缀是站内别名：从这类地址进入时，后续页面与刷新都保留前缀。
		"/web", "/web/", "/web/chat/", "/web/store/", "/web/settings/model/",
	} {
		rec := staticRequest(s, http.MethodGet, path, "", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s 应 200，实际 %d", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "shell") {
			t.Errorf("%s 应返回 index.html，实际 %q", path, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("%s 的 Content-Type 应为 text/html，实际 %q", path, ct)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("%s 的 Cache-Control 应为 no-cache，实际 %q", path, cc)
		}
	}
}

// 回退只认页面路由：拼错的静态资源、未知分栏和未知目录仍要 404，不能被一份 HTML 掩盖。
func TestUnknownPathsStayNotFound(t *testing.T) {
	s := newStaticTestServer(t, map[string]string{"index.html": "<html>shell</html>"})
	for _, path := range []string{
		"/foo/", "/web/foo/", "/settings/unknown/", "/settings/unknown/extra/",
		"/notes/extra/", "/js/missing.js", "/store/missing.png",
	} {
		rec := staticRequest(s, http.MethodGet, path, "", "")
		// 403 也算合格：%2e%2e 解码后是 .. 段，被路径守卫先一步拦下（比 404 更严，同样没发首页）。
		if rec.Code != http.StatusNotFound && rec.Code != http.StatusForbidden {
			t.Errorf("%s 应 404（或路径守卫的 403），实际 %d（%q）", path, rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "shell") {
			t.Errorf("%s 不应拿到应用外壳，实际 %q", path, rec.Body.String())
		}
	}
}

func TestIsAppRoute(t *testing.T) {
	yes := []string{"/", "/chat", "/notes/", "/settings", "/settings/log/", "/store/", "/web/store/", "/web"}
	no := []string{"/foo", "/webfoo", "/settings/nope/", "/notes/x/", "/js/app.js"}
	for _, p := range yes {
		if !isAppRoute(p) {
			t.Errorf("%s 应识别为应用页面", p)
		}
	}
	for _, p := range no {
		if isAppRoute(p) {
			t.Errorf("%s 不应识别为应用页面", p)
		}
	}
}

// 中间目录是链接时，末级文件本身不是链接；只对末级 Lstat 的检查会放过目录外文件。
func TestStaticRejectsIntermediateDirectoryLink(t *testing.T) {
	s := newStaticTestServer(t, map[string]string{"index.html": "shell"})
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("outside secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	makeStaticDirLink(t, filepath.Join(s.cfg.WebRoot, "linked"), outside)
	if rec := staticRequest(s, http.MethodGet, "/linked/secret.txt", "", ""); rec.Code == http.StatusOK {
		t.Errorf("web/ 中间目录链接泄漏了外部文件：%q", rec.Body.String())
	}

	modDir := filepath.Join(s.cfg.ModsDir, "demo")
	if err := os.MkdirAll(modDir, 0o755); err != nil {
		t.Fatal(err)
	}
	makeStaticDirLink(t, filepath.Join(modDir, "linked"), outside)
	if rec := staticRequest(s, http.MethodGet, "/mods/demo/linked/secret.txt", "", ""); rec.Code == http.StatusOK {
		t.Errorf("/mods/ 中间目录链接泄漏了外部文件：%q", rec.Body.String())
	}
}

// HEAD 只发头部：流式文件必须保留 Content-Length，但不得写正文。
func TestStaticHeadHasNoBody(t *testing.T) {
	s := newStaticTestServer(t, map[string]string{"js/app.js": "console.log(1)"})
	rec := staticRequest(s, http.MethodHead, "/js/app.js", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD 应 200，实际 %d", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD 不应返回正文，实际 %q", rec.Body.String())
	}
	if rec.Header().Get("Content-Length") == "" {
		t.Error("HEAD 应保留 Content-Length")
	}
}

func makeStaticDirLink(t *testing.T, link, target string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err == nil {
			return
		} else if err := os.Symlink(target, link); err != nil {
			t.Skipf("无法创建目录链接：%v（%s）", err, out)
		}
		return
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("无法创建目录链接：%v", err)
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
