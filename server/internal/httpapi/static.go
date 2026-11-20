package httpapi

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"elainachat/server/internal/fsx"
	"elainachat/server/internal/plugin"
)

// 固定 MIME 表而不是靠系统注册表：Windows 上 .js 可能被注册成 text/plain，
// 浏览器会因 nosniff 拒绝执行；打包到别的机器上不能听天由命。
var contentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".png":         "image/png",
	".jpg":         "image/jpeg",
	".jpeg":        "image/jpeg",
	".json":        "application/json",
	".moc3":        "application/octet-stream",
	".svg":         "image/svg+xml",
	".mp3":         "audio/mpeg",
	".m4a":         "audio/mp4",
}

// 应用页面的路径（前端 router.js 的同一份路由表）。
// 只有这些路径在文件不存在时才回退发 index.html —— 否则任意拼错的静态资源都会拿到一份 HTML，
// 浏览器会把它当脚本/样式解析，排查起来比 404 难得多。
var appRouteSettingsTabs = map[string]bool{
	"appearance": true,
	"character":  true,
	"model":      true,
	"capability": true,
	"timers":     true,
	"mods":       true,
	"advanced":   true,
	"log":        true,
}

// isAppRoute 判断是否前端页面地址。/web 前缀是站内别名：应用本身挂在根路径，
// 但从 /web/store/ 这类地址进来时整段会话都保留前缀，刷新与前进后退都要能回到同一页。
func isAppRoute(pathname string) bool {
	p := pathname
	switch {
	case p == "/web":
		p = "/"
	case strings.HasPrefix(p, "/web/"):
		p = strings.TrimPrefix(p, "/web")
	}
	p = strings.TrimSuffix(p, "/")
	switch p {
	case "", "/chat", "/notes", "/memory", "/diary", "/settings", "/achievements", "/store":
		return true
	}
	if tab, ok := strings.CutPrefix(p, "/settings/"); ok {
		return tab != "" && !strings.Contains(tab, "/") && appRouteSettingsTabs[tab]
	}
	return false
}

// serveWeb 只发 web/ 下的普通文件。符号链接不跟随：web/ 里的一条软链就能把任意文件读出去。
func (s *Server) serveWeb(w http.ResponseWriter, r *http.Request, pathname string) bool {
	relative := "index.html"
	if pathname != "/" {
		relative = strings.TrimPrefix(pathname, "/")
	}
	for _, seg := range strings.Split(strings.ReplaceAll(relative, "\\", "/"), "/") {
		if strings.HasPrefix(seg, ".") {
			writePlain(w, http.StatusForbidden, "Forbidden")
			return true
		}
		if seg == ".." {
			writePlain(w, http.StatusForbidden, "Forbidden")
			return true
		}
	}
	target := filepath.Join(s.cfg.WebRoot, filepath.FromSlash(relative))
	if !pathInside(target, s.cfg.WebRoot) {
		writePlain(w, http.StatusForbidden, "Forbidden")
		return true
	}
	info, err := os.Lstat(target)
	if err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 {
		_, err = fsx.ExistingPathWithin(target, s.cfg.WebRoot)
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		// 文件不存在是页面路由的正常输入；链接或权限错误不能借回退绕过真实路径检查。
		if err == nil || !os.IsNotExist(err) || !isAppRoute(pathname) || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
			if err != nil && !os.IsNotExist(err) {
				writePlain(w, http.StatusForbidden, "Forbidden")
				return true
			}
			return false
		}
		relative = "index.html"
		target = filepath.Join(s.cfg.WebRoot, filepath.FromSlash(relative))
		if !pathInside(target, s.cfg.WebRoot) {
			return false
		}
		info, err = os.Lstat(target)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return false
		}
	}

	ctype := contentTypes[strings.ToLower(filepath.Ext(target))]
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("X-Content-Type-Options", "nosniff")
	if strings.HasPrefix(ctype, "text/html") {
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
	}
	streamFile(w, r, target)
	return true
}

// serveMods 发插件目录里的文件。插件在 web/ 之外，没有这条路由时立绘、背景、模型全部 404。
func (s *Server) serveMods(w http.ResponseWriter, r *http.Request) bool {
	rel := strings.TrimPrefix(r.URL.Path, "/mods/")
	if rel == "" || strings.HasSuffix(rel, "/") {
		writePlain(w, http.StatusNotFound, "Not found")
		return true
	}
	target := filepath.Join(s.cfg.ModsDir, filepath.FromSlash(rel))
	if !pathInside(target, s.cfg.ModsDir) {
		writePlain(w, http.StatusForbidden, "Forbidden")
		return true
	}
	info, err := os.Lstat(target)
	if err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 {
		_, err = fsx.ExistingPathWithin(target, s.cfg.ModsDir)
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		writePlain(w, http.StatusNotFound, "Not found")
		return true
	}
	ctype := contentTypes[strings.ToLower(filepath.Ext(target))]
	if s.plugins != nil && s.plugins.IsUploadPath(target) {
		// 插件声明的「用户上传落地处」一律按二进制流发：混入的 .html/.svg 被同源渲染就是 XSS 执行点。
		ctype = "application/octet-stream"
	}
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("X-Content-Type-Options", "nosniff")
	if strings.HasPrefix(ctype, "text/html") {
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
	}
	streamFile(w, r, target)
	return true
}

// streamFile 发文件，并支持条件请求。
//
// 缓存策略是 no-cache 而不是 no-store：no-store 让浏览器每次刷新都把整份前端重下
// （实测 116 个脚本 / 2.6MB），手机与局域网访问时代价最大；no-cache 允许浏览器留下副本
// 但每次请求都带 If-None-Match 回服务端校验，内容没变只回 304 空响应。
// 内容一变（重新打包、插件更新、用户上传覆盖）mtime 与大小就变，ETag 随之变，
// 下一次请求必然拿到新文件 —— 不会出现「刷新页面还是旧插件」。
// Last-Modified / If-Modified-Since 照发：有些客户端只认它，两条腿走路。
func streamFile(w http.ResponseWriter, r *http.Request, path string) {
	f, err := os.Open(path)
	if err != nil {
		writePlain(w, http.StatusNotFound, "Not found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		writePlain(w, http.StatusNotFound, "Not found")
		return
	}
	etag := fmt.Sprintf(`W/"%x-%x"`, st.ModTime().UnixNano(), st.Size())
	h := w.Header()
	h.Set("ETag", etag)
	h.Set("Last-Modified", st.ModTime().UTC().Format(http.TimeFormat))
	// no-cache 的语义是「可以存，每次用之前必须校验」，不是「不要缓存」。
	h.Set("Cache-Control", "no-cache")
	if inm := r.Header.Get("If-None-Match"); inm != "" {
		// 客户端带了 ETag 就以它为准；弱比较按规范忽略 W/ 前缀。
		if etagMatches(inm, etag) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	} else if ims := r.Header.Get("If-Modified-Since"); ims != "" {
		if t, err := http.ParseTime(ims); err == nil && !st.ModTime().Truncate(time.Second).After(t) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	h.Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, f)
	}
}

// etagMatches 判断 If-None-Match 里是否包含当前 ETag。
// 头里可能是逗号分隔的多个值、可能带 W/ 前缀，也可能是 * —— 都要认。
func etagMatches(header, etag string) bool {
	header = strings.TrimSpace(header)
	if header == "*" {
		return true
	}
	normalize := func(s string) string {
		return strings.TrimPrefix(strings.TrimSpace(s), "W/")
	}
	target := normalize(etag)
	for _, part := range strings.Split(header, ",") {
		if normalize(part) == target {
			return true
		}
	}
	return false
}

func writePlain(w http.ResponseWriter, code int, text string) {
	h := w.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	_, _ = io.WriteString(w, text)
}

// serveModIndex 每次请求都重新扫描：前端加载插件读的就是这份清单，
// 只刷新页面时清单若还是旧的，目录改名后会去请求旧目录、插件加载失败。
func (s *Server) serveModIndex(w http.ResponseWriter, r *http.Request) {
	modules, _, err := s.packages.ScanMods()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "扫描插件目录失败"}, nil)
		return
	}
	raw, err := plugin.IndexJSON(modules)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "生成插件清单失败"}, nil)
		return
	}
	_ = plugin.WriteIndex(s.cfg.ModsDir, modules)
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// servePluginStatic 发插件声明的静态目录。mime 为 auto 时按真实扩展名发
// （插件自带代码被 nosniff 拒绝执行就是类型错了）；binary 一律 octet-stream。
func (s *Server) servePluginStatic(w http.ResponseWriter, r *http.Request, abs, mimeMode string) {
	ctype := "application/octet-stream"
	if mimeMode == "auto" {
		if mapped := contentTypes[strings.ToLower(filepath.Ext(abs))]; mapped != "" {
			ctype = mapped
		}
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("X-Content-Type-Options", "nosniff")
	if strings.HasPrefix(ctype, "text/html") {
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
	}
	streamFile(w, r, abs)
}

// pathInside 用相对路径判越界，而不是字符串前缀：前缀判断在 Windows 上会因大小写与分隔符放行。
func pathInside(target, root string) bool {
	return fsx.PathInside(target, root)
}
