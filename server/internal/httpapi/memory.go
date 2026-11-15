package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"elainachat/server/internal/memoryindex"
)

const (
	memoryUpsertBodyMax = 16 << 20
	memoryDeleteBodyMax = 4 << 20
	memoryResetBodyMax  = 64 << 10
	memoryItemsBodyMax  = 8 << 20
)

// handleMemory 是记忆索引的 HTTP 面。索引是派生数据：这里只负责存取，
// 建索引/裁剪/召回仍在页面侧（M2a 不改变现有召回链路）。
func (s *Server) handleMemory(w http.ResponseWriter, r *http.Request) {
	if s.memory == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{
			"ok": false, "available": false, "message": "记忆索引不可用",
		}, nil)
		return
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	switch {
	case path == "/api/memory/index/status":
		s.handleMemoryStatus(w, r)
	case path == "/api/memory/index":
		s.handleMemoryLoad(w, r)
	case path == "/api/memory/index/upsert":
		s.handleMemoryUpsert(w, r)
	case path == "/api/memory/index/begin":
		s.handleMemoryBegin(w, r)
	case path == "/api/memory/index/commit":
		s.handleMemoryCommit(w, r)
	case path == "/api/memory/index/delete":
		s.handleMemoryDelete(w, r)
	case path == "/api/memory/index/reset":
		s.handleMemoryReset(w, r)
	case path == "/api/memory/items/upsert":
		s.handleMemoryItemsUpsert(w, r)
	case path == "/api/memory/items/delete":
		s.handleMemoryItemsDelete(w, r)
	case path == "/api/memory/items/ids":
		s.handleMemoryItemsIDs(w, r)
	case path == "/api/memory/search":
		s.handleMemorySearch(w, r)
	case path == "/api/memory/timeline":
		s.handleMemoryTimeline(w, r)
	case path == "/api/memory/core":
		if r.Method == http.MethodGet {
			s.handleMemoryCoreGet(w, r)
		} else {
			s.handleMemoryCorePut(w, r)
		}
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": "未知的记忆索引接口"}, nil)
	}
}

// memoryStatus 把索引层的错误翻成 HTTP 码：参数/数据不合法是调用方的错（400），
// 其余是库本身的问题（500）。全都回 400 会让「磁盘满」看起来像「你传错了」。
func memoryStatus(err error) int {
	if errors.Is(err, memoryindex.ErrStaleBuild) {
		return http.StatusConflict
	}
	for _, target := range []error{
		memoryindex.ErrInvalid, memoryindex.ErrTooManyItems,
		memoryindex.ErrBadFingerprint, memoryindex.ErrBadDims,
	} {
		if errors.Is(err, target) {
			return http.StatusBadRequest
		}
	}
	return http.StatusInternalServerError
}

func writeMemoryError(w http.ResponseWriter, err error) {
	writeJSON(w, memoryStatus(err), map[string]any{"ok": false, "message": err.Error()}, nil)
}

func (s *Server) handleMemoryStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 GET"}, nil)
		return
	}
	fingerprint := strings.TrimSpace(r.URL.Query().Get("fingerprint"))
	status, err := s.memory.Status(fingerprint)
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "available": true,
		"fingerprint": status.Fingerprint, "dims": status.Dims, "count": status.Count,
		"ready": status.Ready, "buildId": status.BuildID,
		"fts": s.memory.FTSTokenizer(),
	}, nil)
}

func (s *Server) handleMemoryLoad(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 GET"}, nil)
		return
	}
	fingerprint := strings.TrimSpace(r.URL.Query().Get("fingerprint"))
	if fingerprint == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "缺少 fingerprint"}, nil)
		return
	}
	index, err := s.memory.Load(fingerprint)
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "fingerprint": index.Fingerprint, "dims": index.Dims, "items": index.Items,
	}, nil)
}

func (s *Server) handleMemoryUpsert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 POST"}, nil)
		return
	}
	var batch memoryindex.Batch
	if err := readJSONInto(r, memoryUpsertBodyMax, &batch); err != nil {
		code := http.StatusBadRequest
		message := err.Error()
		if err == errBodyTooLarge {
			code = http.StatusRequestEntityTooLarge
			message = "向量请求体过大"
		}
		writeJSON(w, code, map[string]any{"ok": false, "message": message}, nil)
		return
	}
	n, err := s.memory.Upsert(batch)
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upserted": n}, nil)
}

func (s *Server) handleMemoryBegin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 POST"}, nil)
		return
	}
	var body struct {
		Fingerprint string `json:"fingerprint"`
		Dims        int    `json:"dims"`
	}
	if err := readJSONInto(r, memoryResetBodyMax, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	buildID, err := s.memory.Begin(strings.TrimSpace(body.Fingerprint), body.Dims)
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "buildId": buildID}, nil)
}

func (s *Server) handleMemoryCommit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 POST"}, nil)
		return
	}
	var body struct {
		Fingerprint string `json:"fingerprint"`
		BuildID     string `json:"buildId"`
	}
	if err := readJSONInto(r, memoryResetBodyMax, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	if err := s.memory.Commit(strings.TrimSpace(body.Fingerprint), body.BuildID); err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true}, nil)
}

func (s *Server) handleMemoryDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 POST"}, nil)
		return
	}
	var body struct {
		Fingerprint string   `json:"fingerprint"`
		IDs         []string `json:"ids"`
	}
	if err := readJSONInto(r, memoryDeleteBodyMax, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	n, err := s.memory.Delete(strings.TrimSpace(body.Fingerprint), body.IDs)
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": n}, nil)
}

func (s *Server) handleMemoryReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 POST"}, nil)
		return
	}
	var body struct {
		Fingerprint string `json:"fingerprint"`
	}
	if err := readJSONInto(r, memoryResetBodyMax, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	n, err := s.memory.Reset(strings.TrimSpace(body.Fingerprint))
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": n}, nil)
}

// handleMemoryItemsUpsert 批量写结构化记忆条目（M2a 里它是 Store 的派生索引）。
func (s *Server) handleMemoryItemsUpsert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 POST"}, nil)
		return
	}
	var body struct {
		Items  []memoryindex.Item `json:"items"`
		Reason string             `json:"reason"`
	}
	if err := readJSONInto(r, memoryItemsBodyMax, &body); err != nil {
		code := http.StatusBadRequest
		message := err.Error()
		if err == errBodyTooLarge {
			code = http.StatusRequestEntityTooLarge
			message = "记忆条目请求体过大"
		}
		writeJSON(w, code, map[string]any{"ok": false, "message": message}, nil)
		return
	}
	n, err := s.memory.UpsertItems(body.Items, strings.TrimSpace(body.Reason))
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "upserted": n, "fts": s.memory.FTSTokenizer(),
	}, nil)
}

func (s *Server) handleMemoryItemsDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 POST"}, nil)
		return
	}
	var body struct {
		IDs    []string `json:"ids"`
		Reason string   `json:"reason"`
	}
	if err := readJSONInto(r, memoryDeleteBodyMax, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	n, err := s.memory.DeleteItems(body.IDs, strings.TrimSpace(body.Reason))
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": n}, nil)
}

// handleMemoryItemsIDs 返回索引里全部 id：页面据此判断哪些 id 已从语料消失。
func (s *Server) handleMemoryItemsIDs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 GET"}, nil)
		return
	}
	ids, err := s.memory.ItemIDs()
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ids": ids}, nil)
}

// readMemoryFilter 解析三个过滤参数与 limit。limit 非法时按参数错误处理，
// 而不是悄悄用默认值 —— 页面写错 limit 时应该一眼看出来。
func readMemoryFilter(r *http.Request) (memoryindex.SearchFilter, error) {
	q := r.URL.Query()
	filter := memoryindex.SearchFilter{
		Kind:      strings.TrimSpace(q.Get("kind")),
		ScopeType: strings.TrimSpace(q.Get("scopeType")),
		ScopeID:   strings.TrimSpace(q.Get("scopeId")),
	}
	if raw := strings.TrimSpace(q.Get("limit")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return filter, errors.New("limit 必须是正整数")
		}
		filter.Limit = n
	}
	return filter, nil
}

func (s *Server) handleMemorySearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 GET"}, nil)
		return
	}
	filter, err := readMemoryFilter(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	query := r.URL.Query().Get("q")
	if strings.TrimSpace(query) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "缺少 q"}, nil)
		return
	}
	result, err := s.memory.SearchItems(query, filter)
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "items": result.Items, "mode": result.Mode,
		"fts": s.memory.FTSTokenizer(),
	}, nil)
}

func (s *Server) handleMemoryTimeline(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "message": "只支持 GET"}, nil)
		return
	}
	filter, err := readMemoryFilter(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	result, err := s.memory.Timeline(filter)
	if err != nil {
		writeMemoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "items": result.Items}, nil)
}

func readJSONInto(r *http.Request, limit int64, out any) error {
	raw, err := readRawBody(r, limit)
	if err != nil {
		return err
	}
	if len(raw) == 0 {
		return errEmptyJSONBody
	}
	return json.Unmarshal(raw, out)
}

var errEmptyJSONBody = &jsonError{"请求体为空"}

type jsonError struct{ msg string }

func (e *jsonError) Error() string { return e.msg }
