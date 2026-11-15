package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"elainachat/server/internal/plugin"
)

// 手机端页面固定从这个源发出请求（Capacitor Android）。安卓的 127.0.0.1 是整机共享的，
// 同机别的 App 连过来时 RemoteAddr 同样是回环 —— 所以桌面那套「本机即可信」在手机上
// 不成立，真正的边界是这道 Origin 白名单（与旧 Node bootstrap 的 ALLOWED_ORIGIN 同值）。
const serviceOrigin = "https://localhost"

func serviceOriginAllowed(r *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("Origin")), serviceOrigin)
}

// applyServiceCORS 回显 Origin 而不是写死 *（页面只有一个来源），并声明预检允许的方法与头。
func applyServiceCORS(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	origin := r.Header.Get("Origin")
	if origin == "" {
		origin = serviceOrigin
	}
	h.Set("Access-Control-Allow-Origin", origin)
	// 方法表与插件路由白名单（plugin/jsapi.go 的方法校验）对齐：插件面板会发跨源 DELETE，
	// 预检表里缺了哪个方法，APK 上对应的请求就会在预检一步被浏览器拦死。
	h.Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
	// Authorization 给 Bearer 凭据用：登录响应体里会回 token，插件面板与脚本走这个头。
	// X-Elaina-Secrets 是导出备份时携带密钥表的头（页面从 Keystore 读出）；漏了它预检会直接拦下导出。
	h.Set("Access-Control-Allow-Headers", "Content-Type, X-Store-Client, Authorization, X-Elaina-Secrets")
	h.Set("Vary", "Origin")
}

// handleServicePing 是手机端等待「插件装载结论」的探针：字段与旧 bootstrap 对齐，
// 前端靠 modRoutes / modStatic 决定哪些 /api 前缀转发到本服务。
func (s *Server) handleServicePing(w http.ResponseWriter) {
	routes := []string{}
	statics := []map[string]any{}
	if s.plugins != nil {
		status := s.plugins.Status()
		seen := map[string]bool{}
		for _, mod := range status.Mods {
			if !mod.OK {
				continue
			}
			for _, route := range mod.Routes {
				if !seen[route] {
					seen[route] = true
					routes = append(routes, route)
				}
			}
		}
		filesRoot := filepath.Dir(s.cfg.DataDir)
		for _, st := range s.plugins.Statics() {
			rel, err := filepath.Rel(filesRoot, st.Dir)
			if err != nil {
				continue
			}
			statics = append(statics, map[string]any{
				"url": st.URL, "relPath": filepath.ToSlash(rel),
			})
		}
	}
	arch := runtime.GOARCH
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"runtime":       "go",
		"platform":      "android",
		"arch":          arch,
		"pid":           os.Getpid(),
		"port":          s.Port(),
		"uptimeSeconds": int(time.Since(s.startedAt).Seconds()),
		"dataDirectory": s.cfg.DataDir,
		"modsLoaded":    true,
		"modRoutes":     routes,
		"modStatic":     statics,
	}, nil)
}

// handleServiceModsStatus 只给排障用：不塞进 /api/plugins（那是手机端原生实现的地盘），
// 也不塞进 ping（明细太大，200ms 级探针不该变胖）。
func (s *Server) handleServiceModsStatus(w http.ResponseWriter) {
	status := plugin.Status{Mods: []plugin.LoadResult{}}
	if s.plugins != nil {
		status = s.plugins.Status()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"modsLoaded": true,
		"loadedAt":   status.LoadedAt,
		"mods":       status.Mods,
	}, nil)
}

// handleServiceShutdown 先回包再退出：Java 服务进程看到 /api/shutdown 成功后会等进程结束；
// 直接杀进程会让正在写的日志与上传落盘缺一截。
func (s *Server) handleServiceShutdown(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "stopping": true}, nil)
	if s.shutdown == nil {
		return
	}
	go func() {
		time.Sleep(50 * time.Millisecond)
		s.shutdown()
	}()
}
