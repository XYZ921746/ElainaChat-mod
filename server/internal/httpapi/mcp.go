package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"elainachat/server/internal/mcp"
	"elainachat/server/internal/store"
)

// mcpServersFromSettings 只取显式启用的服务器，且必须有 url 或 command：
// 两者都没有的条目会建出一个必然失败的连接，不如在这里就挡掉。
func (s *Server) mcpServersFromSettings() []mcp.ServerDef {
	data, err := s.store.Load()
	if err != nil {
		return nil
	}
	var settings struct {
		Servers []map[string]any `json:"mcpServers"`
	}
	if json.Unmarshal([]byte(data[store.SettingsKey]), &settings) != nil {
		return nil
	}
	out := []mcp.ServerDef{}
	for _, raw := range settings.Servers {
		if raw == nil {
			continue
		}
		if enabled, ok := raw["enabled"].(bool); !ok || !enabled {
			continue
		}
		def := normalizeMCPServer(raw)
		if def.ID != "" && (def.URL != "" || def.Command != "") {
			out = append(out, def)
		}
	}
	return out
}

func normalizeMCPServer(raw map[string]any) mcp.ServerDef {
	text := func(key string) string {
		if v, ok := raw[key].(string); ok {
			return strings.TrimSpace(v)
		}
		return ""
	}
	def := mcp.ServerDef{
		ID:      text("id"),
		Name:    text("name"),
		URL:     text("url"),
		Command: text("command"),
		CWD:     text("cwd"),
		Args:    []string{},
		Env:     map[string]string{},
		Headers: map[string]string{},
	}
	if def.Name == "" {
		def.Name = def.ID
	}
	if args, ok := raw["args"].([]any); ok {
		for _, a := range args {
			if str, ok := a.(string); ok {
				def.Args = append(def.Args, str)
			}
		}
	}
	if env, ok := raw["env"].(map[string]any); ok {
		for k, v := range env {
			if str, ok := v.(string); ok {
				def.Env[k] = str
			}
		}
	}
	if headers, ok := raw["headers"].(map[string]any); ok {
		for k, v := range headers {
			switch typed := v.(type) {
			case string:
				def.Headers[k] = typed
			case float64:
				def.Headers[k] = fmt.Sprintf("%v", typed)
			}
		}
	}
	return def
}

// mcpAccess 复用 agent 的档位判定：off 时 MCP 工具整块不可用。
func (s *Server) mcpAccess(param string) string {
	if s.agent != nil {
		return s.agent.Access(param)
	}
	return "strict"
}

func (s *Server) handleMCPTools(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if s.mcpAccess(firstNonEmpty(q.Get("access"), q.Get("permission"))) == "off" {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "电脑操作已关闭，MCP 工具也不可用"}, nil)
		return
	}
	servers := s.mcpServersFromSettings()
	out := make([]map[string]any, 0, len(servers))
	for _, def := range servers {
		tools, errText, err := s.mcp.ListTools(def)
		entry := map[string]any{"id": def.ID, "name": def.Name, "ok": err == nil, "error": errText}
		rows := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			rows = append(rows, map[string]any{
				"name": t.Name, "description": t.Description, "inputSchema": t.InputSchema,
			})
		}
		entry["tools"] = rows
		out = append(out, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "servers": out}, nil)
}

func (s *Server) handleMCPCall(w http.ResponseWriter, r *http.Request) {
	body, err := readJSON(r, 256*1024)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "请求体无效"}, nil)
		return
	}
	accessParam, _ := body["access"].(string)
	if accessParam == "" {
		accessParam, _ = body["permission"].(string)
	}
	if s.mcpAccess(accessParam) == "off" {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "电脑操作已关闭，MCP 工具也不可用"}, nil)
		return
	}
	serverID, _ := body["server"].(string)
	toolName, _ := body["tool"].(string)
	serverID = strings.TrimSpace(serverID)
	toolName = strings.TrimSpace(toolName)
	if serverID == "" || toolName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "需要 server 与 tool"}, nil)
		return
	}
	var def *mcp.ServerDef
	for _, candidate := range s.mcpServersFromSettings() {
		if candidate.ID == serverID {
			copy := candidate
			def = &copy
			break
		}
	}
	// 不在「已启用」清单里的服务器一律拒绝：前端可以被绕过，
	// 「配置里没有却能调起来」等于绕过用户关掉的开关。
	if def == nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "没有这台 MCP 服务器，或它没有启用：" + serverID}, nil)
		return
	}
	args, _ := body["arguments"].(map[string]any)
	result := s.mcp.CallTool(*def, toolName, args)
	// 一律 200：ok 在 body 里。工具自身报错是正常结果，模型需要那条具体原因而不是「接口 500」。
	writeJSON(w, http.StatusOK, map[string]any{"ok": result.OK, "text": result.Text}, nil)
}

func (s *Server) handleMCPTest(w http.ResponseWriter, r *http.Request) {
	body, err := readJSON(r, 64*1024)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "请求体无效"}, nil)
		return
	}
	accessParam, _ := body["access"].(string)
	if accessParam == "" {
		accessParam, _ = body["permission"].(string)
	}
	if s.mcpAccess(accessParam) == "off" {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "电脑操作已关闭，MCP 工具也不可用"}, nil)
		return
	}
	raw, ok := body["server"].(map[string]any)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "需要 server 配置对象"}, nil)
		return
	}
	def := normalizeMCPServer(raw)
	if def.ID == "" {
		def.ID = "test"
	}
	if def.Name == "" {
		def.Name = def.ID
	}
	if def.URL == "" && def.Command == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "需要 url（远程）或 command（本地），否则连不上"}, nil)
		return
	}
	// 测试用的临时 id：不与设置里已保存的服务器共用连接，测完立刻停掉。
	def.ID = "__test__" + def.ID
	defer func() { s.mcp.Stop(def.ID) }()
	tools, errText, err := s.mcp.ListTools(def)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": firstNonEmpty(errText, err.Error(), "连接失败")}, nil)
		return
	}
	names := make([]string, 0, len(tools))
	for _, t := range tools {
		names = append(names, t.Name)
	}
	status := s.mcp.Status(def)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"message":    fmt.Sprintf("连接成功，发现 %d 个工具", len(names)),
		"serverInfo": status.ServerInfo,
		"tools":      names,
	}, nil)
}

func (s *Server) handleMCPStop(w http.ResponseWriter, r *http.Request) {
	body, err := readJSON(r, 16*1024)
	if err != nil {
		body = map[string]any{}
	}
	if serverID, ok := body["server"].(string); ok && strings.TrimSpace(serverID) != "" {
		stopped := s.mcp.Stop(serverID)
		if stopped == nil {
			stopped = []string{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "stopped": stopped}, nil)
		return
	}
	s.mcp.Stop("")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "stopped": "all"}, nil)
}

func (s *Server) handleMCPStatus(w http.ResponseWriter, r *http.Request) {
	servers := s.mcpServersFromSettings()
	out := make([]map[string]any, 0, len(servers))
	for _, def := range servers {
		status := s.mcp.Status(def)
		out = append(out, map[string]any{
			"id": def.ID, "name": def.Name,
			"state": status.State, "error": status.Error,
			"tools": status.Tools, "serverInfo": status.ServerInfo,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "servers": out}, nil)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
