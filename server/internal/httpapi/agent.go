package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"elainachat/server/internal/agent"
	"elainachat/server/internal/pccmd"
)

const agentDisabledMessage = "AI 的电脑操作已在设置里关闭（「AI 权限 → 关闭」）。需要时请在「设置 → 能力 → AI 权限」里改回某一档。"

func (s *Server) agentDisabled(w http.ResponseWriter) {
	writeJSON(w, http.StatusForbidden, map[string]any{
		"ok": false, "agentDisabled": true, "message": agentDisabledMessage,
	}, nil)
}

func (s *Server) handleAgentRoots(w http.ResponseWriter, r *http.Request) {
	access := s.agent.Access(r.URL.Query().Get("access"))
	platform, roots := s.agent.Roots()
	if access == "off" {
		// 关闭档下不暴露真实路径：能力不存在，路径也不该被读到。
		for i := range roots {
			roots[i].Path = ""
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "platform": platform, "roots": roots}, nil)
}

func (s *Server) handleAgentLs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	access := s.agent.Access(q.Get("access"))
	if access == "off" {
		s.agentDisabled(w)
		return
	}
	target := strings.TrimSpace(q.Get("path"))
	if target == "" {
		target = s.cfg.AppRoot
	}
	resolved, entries, err := s.agent.List(target)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "目录不存在") {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "保护范围") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": resolved, "entries": entries}, nil)
}

func (s *Server) handleAgentRead(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	access := s.agent.Access(q.Get("access"))
	if access == "off" {
		s.agentDisabled(w)
		return
	}
	resolved, content, err := s.agent.Read(q.Get("path"))
	if err != nil {
		status := http.StatusInternalServerError
		msg := err.Error()
		if strings.Contains(msg, "文件不存在") {
			status = http.StatusNotFound
		} else if strings.Contains(msg, "过大") {
			status = http.StatusRequestEntityTooLarge
		} else if strings.Contains(msg, "保护范围") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]any{"ok": false, "message": msg}, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": resolved, "content": content}, nil)
}

func (s *Server) handleAgentWrite(w http.ResponseWriter, r *http.Request) {
	body, err := readJSON(r, agent.WriteLimit+64*1024)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "请求体无效或过大"}, nil)
		return
	}
	access := s.agent.Access(stringField(body, "access"))
	if access == "off" {
		s.agentDisabled(w)
		return
	}
	path := stringField(body, "path")
	content := stringField(body, "content")
	overwrite, _ := body["overwrite"].(bool)
	resolved, need, err := s.agent.Write(path, content, access, overwrite)
	if err != nil {
		if agent.IsNeedConfirm(err) {
			payload := map[string]any{"ok": false}
			for key, value := range need {
				payload[key] = value
			}
			writeJSON(w, http.StatusForbidden, payload, nil)
			return
		}
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "不允许写") {
			status = http.StatusBadRequest
		} else if strings.Contains(err.Error(), "保护范围") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]any{"ok": false, "path": resolved, "message": err.Error()}, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": resolved}, nil)
}

func (s *Server) handleAgentDelete(w http.ResponseWriter, r *http.Request) {
	body, err := readJSON(r, 256*1024)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "请求体无效"}, nil)
		return
	}
	access := s.agent.Access(stringField(body, "access"))
	if access == "off" {
		s.agentDisabled(w)
		return
	}
	if access == "auto" {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"ok": false, "deleteForbidden": true,
			"message": "当前是「自动通过（禁止删除）」模式，AI 不能删除文件。需要删除的话，请在「设置 → 能力 → AI 权限」里切到「完全访问」，或自己手动删除。",
		}, nil)
		return
	}
	confirmed, _ := body["confirmed"].(bool)
	resolved, isDir, need, err := s.agent.Delete(stringField(body, "path"), access, confirmed)
	if err != nil {
		if agent.IsNeedConfirm(err) {
			payload := map[string]any{"ok": false}
			for key, value := range need {
				payload[key] = value
			}
			writeJSON(w, http.StatusForbidden, payload, nil)
			return
		}
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "不存在") {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "不能删除") {
			status = http.StatusBadRequest
		} else if strings.Contains(err.Error(), "保护范围") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]any{"ok": false, "path": resolved, "message": err.Error()}, nil)
		return
	}
	kind := "文件"
	if isDir {
		kind = "目录"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "path": resolved, "wasDir": isDir, "message": "已删除" + kind + "：" + resolved,
	}, nil)
}

// handleAgentExec 执行本机命令。危险判定由服务端自己做，不信前端传来的 risk；
// strict 每条都要批准，auto 只拦危险命令，full 全放行。批准凭据是服务端签发的
// 一次性令牌（绑定命令全文），不是请求体里的布尔——后者任何持会话的脚本都能替用户填。
func (s *Server) handleAgentExec(w http.ResponseWriter, r *http.Request) {
	body, err := readJSON(r, 256*1024)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "请求体无效"}, nil)
		return
	}
	access := s.agent.Access(stringField(body, "access"))
	if access == "off" {
		s.agentDisabled(w)
		return
	}
	command := strings.TrimSpace(stringField(body, "command"))
	if command == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "命令为空"}, nil)
		return
	}
	if len([]rune(command)) > 8000 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "命令过长（上限 8000 字符）"}, nil)
		return
	}

	verdict := pccmd.Classify(command)
	needsApproval := access == "strict" || (access == "auto" && verdict.Risk == "dangerous")
	if needsApproval && !s.consumeExecApproval(stringField(body, "approvalToken"), command) {
		reasons := verdict.Reasons
		if access == "strict" && verdict.Risk != "dangerous" {
			reasons = []string{"当前是「逐条确认」模式，每条命令都需要你确认"}
		}
		writeJSON(w, http.StatusForbidden, map[string]any{
			"ok":            false,
			"needApproval":  true,
			"risk":          verdict.Risk,
			"reasons":       reasons,
			"approvalToken": s.issueExecApproval(command),
			"message":       "这条命令需要用户确认后才能执行。",
		}, nil)
		return
	}

	cwd, err := s.agent.ResolveWorkingDir(stringField(body, "cwd"))
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "工作目录无效：" + err.Error()}, nil)
		return
	}

	result := pccmd.Run(command, stringField(body, "shell"), cwd, pccmd.Timeout)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        result.OK,
		"risk":      verdict.Risk,
		"reasons":   verdict.Reasons,
		"shell":     result.Shell,
		"code":      result.Code,
		"timedOut":  result.TimedOut,
		"truncated": result.Truncated,
		"stdout":    result.Stdout,
		"stderr":    result.Stderr,
		"text":      pccmd.FormatResult(result),
	}, nil)
}

func stringField(body map[string]any, key string) string {
	value, _ := body[key].(string)
	return value
}

// issueExecApproval 为这条命令签发一次性批准令牌。签发时顺手清过期项并限收容数，
// 表不会随着拒绝次数无限膨胀。
func (s *Server) issueExecApproval(command string) string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		// 随机源失败时退化为时间派生值：令牌仍绑定命令与有效期，只是熵变差，
		// 这种退化只在极端环境下发生一次。
		raw = []byte(fmt.Sprintf("%d", time.Now().UnixNano()))
	}
	token := hex.EncodeToString(raw)
	s.execMu.Lock()
	defer s.execMu.Unlock()
	now := time.Now()
	for key, approval := range s.execApprovals {
		if approval.expiresAt.Before(now) {
			delete(s.execApprovals, key)
		}
	}
	for len(s.execApprovals) >= 64 {
		oldestKey := ""
		var oldest time.Time
		for key, approval := range s.execApprovals {
			if oldestKey == "" || approval.expiresAt.Before(oldest) {
				oldestKey, oldest = key, approval.expiresAt
			}
		}
		delete(s.execApprovals, oldestKey)
	}
	s.execApprovals[token] = execApproval{command: command, expiresAt: now.Add(execApprovalTTL)}
	return token
}

// consumeExecApproval 校验并消费令牌：未过期、命令逐字节一致才放行，且只能用一次。
// 用户改过命令文本后令牌即失效，必须重新确认。
func (s *Server) consumeExecApproval(token, command string) bool {
	if token == "" {
		return false
	}
	s.execMu.Lock()
	defer s.execMu.Unlock()
	approval, ok := s.execApprovals[token]
	if !ok {
		return false
	}
	delete(s.execApprovals, token)
	return approval.expiresAt.After(time.Now()) && approval.command == command
}
