package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"sync"
	"time"
	"unicode/utf16"

	"elainachat/server/internal/store"
)

const (
	storeMaxBytes    = 32 * 1024 * 1024
	storeKeyMaxChars = 8 * 1024 * 1024
)

// subscriber 的缓冲区不是越大越好：慢客户端积压到上限后断开它的连接，
// 靠 EventSource 自动重连 + 重连后的全量拉取补齐，比在内存里无限堆积安全，
// 也比静默丢中间事件可靠——丢掉的那条对前端来说是永远不会再来的。
const storeSubBuffer = 16

type storeHub struct {
	mu   sync.Mutex
	subs map[*storeSubscriber]struct{}
}

type storeSubscriber struct {
	ch       chan []byte
	clientID string
	dead     bool
}

func newStoreHub() *storeHub {
	return &storeHub{subs: make(map[*storeSubscriber]struct{})}
}

func (h *storeHub) add(clientID string) *storeSubscriber {
	sub := &storeSubscriber{ch: make(chan []byte, storeSubBuffer), clientID: clientID}
	h.mu.Lock()
	h.subs[sub] = struct{}{}
	h.mu.Unlock()
	return sub
}

func (h *storeHub) remove(sub *storeSubscriber) {
	h.mu.Lock()
	delete(h.subs, sub)
	h.mu.Unlock()
}

// broadcast 把事件封成 SSE data 帧后发给所有订阅者（跳过发起方：它刚写完盘，
// 再收一次同值只会制造一次无意义的整页重渲染）。
func (h *storeHub) broadcast(event []byte, from string) {
	frame := append(append([]byte("data: "), event...), '\n', '\n')
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.subs {
		if sub.dead {
			continue
		}
		if from != "" && sub.clientID == from {
			continue
		}
		select {
		case sub.ch <- frame:
		default:
			// 缓冲已满：这个订阅者跟不上写入速度。断开它而不是丢事件，
			// 关闭前先标记 dead，避免并发广播向已关通道发送。
			sub.dead = true
			close(sub.ch)
		}
	}
}

type storeChangePayload struct {
	Type string             `json:"type"`
	Keys []string           `json:"keys"`
	Data map[string]*string `json:"data"`
	From string             `json:"from"`
}

func (s *Server) handleStoreGet(w http.ResponseWriter, r *http.Request) {
	data, err := s.store.Load()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "读取数据失败：" + err.Error()}, nil)
		return
	}
	// SQLite 是记忆正文的权威：旧逻辑写进 store.json 的整份记忆不能再被页面读回去，
	// 否则页面会以为还有第二份权威，下一次保存又把它写回来。
	if s.memory != nil {
		delete(data, store.MemoryKey)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": data}, nil)
}

func (s *Server) handleStorePost(w *logWriter, r *http.Request) {
	body, err := readJSON(r, storeMaxBytes)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "提交内容过大或格式无效"}, nil)
		return
	}
	patch, oversized := normalizeStorePatch(body["data"])
	// 记忆权威在 SQLite 时，store 键不再是记忆的写入面：旧页面或备份暂存路径写来的
	// 记忆会在磁盘上造出一份类目副本，下次启动的迁移把它整份盖回库里（回到两份权威）。
	// 与数据导入的处理一致（见 handleDataImport），这里直接丢弃。
	if s.memory != nil {
		delete(patch, store.MemoryKey)
	}
	if len(oversized) > 0 {
		first := oversized[0]
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
			"ok":   false,
			"code": "KEY_TOO_LARGE",
			"message": "「" + first.Key + "」过大（约 " + fmt.Sprintf("%d", first.Size/1024/1024) + "M 字符），" +
				"本次未保存。请先在设置里导出备份并清理聊天记录，再继续。",
			"keys": oversized,
		}, nil)
		return
	}
	keys, err := s.store.MergeAndSave(patch)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok":      false,
			"code":    "STORE_WRITE_FAILED",
			"message": "保存失败（数据还在本机内存里，检查磁盘空间 / 文件权限后重试）：" + err.Error(),
		}, nil)
		return
	}

	if len(patch) > 0 {
		payload := storeChangePayload{
			Type: "store-change",
			Keys: sortedKeys(patch),
			Data: patch,
			From: r.Header.Get("X-Store-Client"),
		}
		if encoded, err := json.Marshal(payload); err == nil {
			s.storeHub.broadcast(encoded, payload.From)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "keys": keys}, nil)
}

// handleStoreStream 是 SSE 长连接。用 EventSource 而不是 WebSocket：
// 浏览器原生支持自动重连，服务端也不需要再实现一套帧协议。
func (s *Server) handleStoreStream(w *logWriter, r *http.Request) {
	flusher, ok := w.ResponseWriter.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "当前连接不支持流式响应"}, nil)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Connection", "keep-alive")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	// 立刻发一条注释行：有些浏览器要收到数据才触发 open。
	_, _ = io.WriteString(w, ": connected\n\n")
	flusher.Flush()

	sub := s.storeHub.add(r.URL.Query().Get("client"))
	defer s.storeHub.remove(sub)

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.closing:
			return
		case <-ticker.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case msg, ok := <-sub.ch:
			// 通道被 broadcast 关闭说明这个订阅者缓冲溢出已被断开：
			// 返回让连接结束，浏览器端 EventSource 会自动重连并全量对齐。
			if !ok {
				return
			}
			if _, err := w.Write(msg); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

type oversizedKey struct {
	Key  string `json:"key"`
	Size int    `json:"size"`
}

// normalizeStorePatch 只收字符串值（与 localStorage 语义一致）。
// null 是删除标记，必须保留到合并那一步真删——把它过滤掉会让「删除」永远到不了磁盘。
func normalizeStorePatch(raw any) (map[string]*string, []oversizedKey) {
	patch := make(map[string]*string)
	var oversized []oversizedKey
	obj, ok := raw.(map[string]any)
	if !ok {
		return patch, oversized
	}
	for key, value := range obj {
		if key == "" || utf16Len(key) > 120 {
			continue
		}
		if value == nil {
			patch[key] = nil
			continue
		}
		text, ok := value.(string)
		if !ok {
			continue
		}
		if utf16Len(text) > storeKeyMaxChars {
			oversized = append(oversized, oversizedKey{Key: key, Size: utf16Len(text)})
			continue
		}
		patch[key] = &text
	}
	return patch, oversized
}

func sortedKeys(patch map[string]*string) []string {
	keys := make([]string, 0, len(patch))
	for key := range patch {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}
