package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"elainachat/server/internal/memoryindex"
)

// handleMemoryCore 是记忆的读写面：GET 还原六类目，PUT 整类目替换 + 显式删除。
// 权威在 SQLite；页面拿到的这份就是它投影出来的 canonical 形状（条目带 id，
// 前端据此算 dropIds 与逐条删除）。

func (s *Server) handleMemoryCoreGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 GET"}, nil)
		return
	}
	if s.memory == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{
			"ok": false, "available": false, "message": "记忆库不可用",
		}, nil)
		return
	}
	// 损坏重建后的空库不能当权威发给页面：前端把它采纳为本地状态，用户看到的记忆
	// 就「整体消失」了。拒绝读取让前端保留本地数据，等一次成功写入或重启恢复。
	if s.memory.Degraded() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"ok":       false,
			"degraded": true,
			"message":  "记忆库损坏后重建为空，暂不读取以免覆盖本地数据；可从备份导入恢复",
		}, nil)
		return
	}
	core, err := s.memory.Core()
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "core": core}, nil)
}

type memoryCorePutBody struct {
	Core    json.RawMessage `json:"core"`
	DropIDs []string        `json:"dropIds"`
	Client  string          `json:"client"`
	Reason  string          `json:"reason"`
}

func (s *Server) handleMemoryCorePut(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 POST"}, nil)
		return
	}
	if s.memory == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{
			"ok": false, "available": false, "message": "记忆库不可用",
		}, nil)
		return
	}
	var body memoryCorePutBody
	if err := readJSONInto(r, memoryItemsBodyMax, &body); err != nil {
		code := http.StatusBadRequest
		message := err.Error()
		if err == errBodyTooLarge {
			code = http.StatusRequestEntityTooLarge
			message = "记忆请求体过大"
		}
		writeJSON(w, code, map[string]any{"ok": false, "message": message}, nil)
		return
	}
	core, err := memoryindex.ParseCore(body.Core)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		reason = "page-save"
	}
	canonical, result, err := s.memory.MergeCore(core, body.DropIDs, reason)
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	// 其它设备要跟着刷新；发起方直接采纳响应里的 canonical core，不需要自己再拉一次。
	s.notifyMemoryChange(parseClientID(r, body.Client))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "core": canonical,
		"upserted": result.Upserted, "deleted": result.Deleted, "skipped": result.Skipped,
	}, nil)
}

// notifyMemoryChange 在既有的 store SSE 通道上广播一条记忆变更事件。
// 前端收到后重新拉 /api/memory/core；多设备同步靠它，不需要新的连接或协议。
func (s *Server) notifyMemoryChange(skipClient string) {
	if s.storeHub == nil {
		return
	}
	payload, err := json.Marshal(map[string]any{
		"type":    "memory-change",
		"version": time.Now().UnixMilli(),
	})
	if err != nil {
		return
	}
	s.storeHub.broadcast(payload, skipClient)
}

func parseClientID(r *http.Request, bodyClient string) string {
	if v := strings.TrimSpace(bodyClient); v != "" {
		return v
	}
	return strings.TrimSpace(r.URL.Query().Get("client"))
}
