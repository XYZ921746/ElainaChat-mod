package httpapi

import (
	"encoding/json"
	"net/http"

	"elainachat/server/internal/activity"
	"elainachat/server/internal/browser"
	"elainachat/server/internal/store"
)

// browserDenyReason：调试端口能读到这台机器上所有登录态，所以只认本机；
// 档位 off 时整块关闭。返回空串表示放行。
func (s *Server) browserDenyReason(r *http.Request, access string) string {
	if !isLocal(r) {
		return "只有本机能用 AI 浏览器（调试端口能读到这台机器上所有登录态）"
	}
	if access == "off" {
		return "AI 的电脑操作已在设置里关闭（「AI 权限 → 关闭」）"
	}
	return ""
}

// browserEnabledByUser 服务端必须自己读设置（前端可被绕过），读不到一律当关闭。
func (s *Server) browserEnabledByUser() bool {
	data, err := s.store.Load()
	if err != nil {
		return false
	}
	var settings map[string]any
	if json.Unmarshal([]byte(data[store.SettingsKey]), &settings) != nil {
		return false
	}
	enabled, _ := settings["agentBrowserEnabled"].(bool)
	return enabled
}

func (s *Server) handleAgentBrowser(w http.ResponseWriter, r *http.Request) {
	body, err := readJSON(r, 64*1024)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "请求体无效"}, nil)
		return
	}
	accessParam, _ := body["access"].(string)
	if accessParam == "" {
		accessParam, _ = body["permission"].(string)
	}
	access := s.mcpAccess(accessParam)
	if deny := s.browserDenyReason(r, access); deny != "" {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": deny}, nil)
		return
	}
	if !s.browserEnabledByUser() {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"ok":      false,
			"message": "浏览器功能没有打开。请在「设置 → 能力 → 浏览器」里打开「允许 AI 用浏览器」。",
		}, nil)
		return
	}
	action, _ := body["action"].(string)
	args, _ := body["args"].(map[string]any)
	result := browser.RunAction(s.browser, action, args)
	// 一律 200：ok 在 body 里。浏览器「打不开这个网址」是正常结果，用 4xx/5xx
	// 会让前端当成服务端坏了，而模型需要那条具体原因。
	writeJSON(w, http.StatusOK, result, nil)
}

func (s *Server) handleAgentBrowserStatus(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	access := s.mcpAccess(firstNonEmpty(q.Get("access"), q.Get("permission")))
	if deny := s.browserDenyReason(r, access); deny != "" {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": deny}, nil)
		return
	}
	exe := browser.FindExecutable()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"available":  exe != "",
		"executable": exe,
		"running":    s.browser.IsRunning(),
	}, nil)
}

// handleAgentActivity 是只读的「电脑在干什么」。这是隐私数据，但路由已过鉴权闸门：
// 密码就是这道门（与 Node 版一致，已登录的局域网设备也能读）。
func (s *Server) handleAgentActivity(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	access := s.mcpAccess(firstNonEmpty(q.Get("access"), q.Get("permission")))
	if access == "off" {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"ok":            false,
			"agentDisabled": true,
			"message": "AI 的电脑操作已在设置里关闭（「AI 权限 → 关闭」）。" +
				"需要时请在「设置 → 能力 → AI 权限」里改回某一档。",
		}, nil)
		return
	}
	force := q.Get("force") == "1"
	writeJSON(w, http.StatusOK, activity.SummaryCached(force), nil)
}
