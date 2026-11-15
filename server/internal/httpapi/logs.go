package httpapi

import (
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"elainachat/server/internal/logx"
)

// handleLogsTail 是日志查看器的数据源：从内存缓冲按级别 / 模块 / 关键词过滤。
// 缓冲才是全量（不受落盘级别约束），切级别与模块即时生效。
func (s *Server) handleLogsTail(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	query := logx.Query{
		MinLevel: q.Get("level"),
		Search:   q.Get("search"),
	}
	if raw := q.Get("tags"); raw != "" {
		for _, tag := range strings.Split(raw, ",") {
			if tag = strings.TrimSpace(tag); tag != "" {
				query.Tags = append(query.Tags, tag)
			}
		}
	}
	if raw := q.Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			query.Limit = n
		}
	}
	if raw := q.Get("since"); raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
			query.Since = n
		}
	}
	if raw := q.Get("sinceSeq"); raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
			query.SinceSeq = &n
		}
	}
	result := s.log.Query(query)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"entries": result.Entries,
		"total":   result.Total,
		"dropped": result.Dropped,
		"tags":    s.log.Tags(),
	}, nil)
}

func (s *Server) handleLogsSettingsGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"level":        s.log.FileLevel().String(),
		"consoleLevel": s.log.ConsoleLevel().String(),
		"levels":       logx.LevelNames(),
		"trace":        s.log.TraceEnabled(),
		"fileEnabled":  s.log.FileEnabled(),
		"logDir":       s.relPath(s.log.LogDir()),
		"mainFile":     s.relPath(s.log.CurrentFile()),
		"traceFile":    "",
		"keep":         s.log.Keep(),
		"maxMb":        s.log.MaxMB(),
	}, nil)
}

func (s *Server) handleLogsSettingsPost(w http.ResponseWriter, r *http.Request) {
	body, err := readJSON(r, 8*1024)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "请求格式无效"}, nil)
		return
	}
	notes := []string{}
	if raw, ok := body["level"]; ok {
		name, _ := raw.(string)
		level, valid := logx.ParseLevel(name)
		if !valid {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok": false, "message": "级别无效，可选：" + strings.Join(logx.LevelNames(), " / "),
			}, nil)
			return
		}
		if s.log.SetFileLevel(level) {
			notes = append(notes, "落盘级别已改为 "+level.String())
		}
	}
	if raw, ok := body["consoleLevel"]; ok {
		name, _ := raw.(string)
		level, valid := logx.ParseLevel(name)
		if !valid {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok": false, "message": "级别无效，可选：" + strings.Join(logx.LevelNames(), " / "),
			}, nil)
			return
		}
		if s.log.SetConsoleLevel(level) {
			notes = append(notes, "控制台级别已改为 "+level.String())
		}
	}
	if raw, ok := body["trace"]; ok {
		if on, isBool := raw.(bool); isBool && s.log.SetTraceEnabled(on) {
			if on {
				notes = append(notes, "对话追踪已开启")
			} else {
				notes = append(notes, "对话追踪已关闭")
			}
		}
	}
	if len(notes) > 0 {
		s.log.Warnf("Log", "日志设置已更新：%s（操作者 %s）", strings.Join(notes, "；"), clientIP(r))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"level":        s.log.FileLevel().String(),
		"consoleLevel": s.log.ConsoleLevel().String(),
		"trace":        s.log.TraceEnabled(),
		"changed":      notes,
	}, nil)
}

func (s *Server) relPath(path string) string {
	if path == "" {
		return ""
	}
	rel, err := filepath.Rel(s.cfg.AppRoot, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		return path
	}
	return filepath.ToSlash(rel)
}
