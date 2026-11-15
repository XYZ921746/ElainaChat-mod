package memoryindex

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxItemsPerBatch = 256
	maxContentRunes  = 8000
	maxSummaryRunes  = 1000
	maxReasonChars   = 200
	// 事件表只留最近这么多条：它是排障用的，不是业务数据，无界增长会悄悄吃掉磁盘。
	maxEventsKept = 5000
)

const (
	StatusActive     = "active"
	StatusSuperseded = "superseded"
	StatusDeleted    = "deleted"
)

// knownKindPattern 只约束形状（小写标识符），不锁死词表：
// 记忆类目今后扩一类不必改服务端校验。
var knownKindPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)

// 时间戳统一用 Unix 毫秒，0 表示「未设」。
type Item struct {
	ID                   string  `json:"id"`
	Kind                 string  `json:"kind"`
	ScopeType            string  `json:"scopeType"`
	ScopeID              string  `json:"scopeId"`
	Content              string  `json:"content"`
	Summary              string  `json:"summary"`
	SourceKind           string  `json:"sourceKind"`
	SourceConversationID string  `json:"sourceConversationId"`
	SourceMessageID      string  `json:"sourceMessageId"`
	Confidence           float64 `json:"confidence"`
	Importance           float64 `json:"importance"`
	ValidFrom            int64   `json:"validFrom"`
	ValidTo              int64   `json:"validTo"`
	Status               string  `json:"status"`
	SupersededBy         string  `json:"supersededBy"`
	ContentHash          string  `json:"contentHash"`
	// Meta 是 kind 专属的附加字段（JSON 对象）：日记的 conversationTitle / essences / date /
	// timestamp、计划的 date。M2b 起它是权威数据的一部分，必须能原样还原六类目。
	Meta string `json:"meta,omitempty"`
}

// ItemOut 是读接口的形状：在写入字段上补宿主维护的创建/更新时间。
type ItemOut struct {
	Item
	CreatedAt int64 `json:"createdAt"`
	UpdatedAt int64 `json:"updatedAt"`
}

type SearchFilter struct {
	Kind      string
	ScopeType string
	ScopeID   string
	Limit     int
}

type Hit struct {
	ItemOut
	Score float64 `json:"score"`
}

type SearchResult struct {
	Items []Hit  `json:"items"`
	Mode  string `json:"mode"`
}

type TimelineResult struct {
	Items []ItemOut `json:"items"`
	Mode  string    `json:"mode"`
}

func runeCount(s string) int { return utf8.RuneCountInString(s) }

func checkText(field, value string, max int) error {
	if runeCount(value) > max {
		return fmt.Errorf("%s 超过 %d 字", field, max)
	}
	return nil
}

func checkRef(field, value string) error {
	if len(value) > maxIDChars {
		return fmt.Errorf("%s 超过 %d 字节", field, maxIDChars)
	}
	return nil
}

// normalizeItem 校验并补默认值。缺省值只在 0/空时补，不覆盖调用方明确给的值。
func normalizeItem(item *Item) error {
	item.ID = strings.TrimSpace(item.ID)
	if item.ID == "" {
		return fmt.Errorf("id 不能为空")
	}
	if err := checkRef("id", item.ID); err != nil {
		return err
	}
	item.Kind = strings.TrimSpace(item.Kind)
	if !knownKindPattern.MatchString(item.Kind) {
		return fmt.Errorf("kind 必须是小写标识符：%q", item.Kind)
	}
	item.ScopeType = strings.TrimSpace(item.ScopeType)
	if item.ScopeType == "" {
		item.ScopeType = "global"
	}
	switch item.ScopeType {
	case "global", "conversation", "character":
	default:
		return fmt.Errorf("scopeType 不支持：%q", item.ScopeType)
	}
	if err := checkRef("scopeId", item.ScopeID); err != nil {
		return err
	}
	if item.Content == "" {
		return fmt.Errorf("content 不能为空")
	}
	if err := checkText("content", item.Content, maxContentRunes); err != nil {
		return err
	}
	if err := checkText("summary", item.Summary, maxSummaryRunes); err != nil {
		return err
	}
	if item.SourceKind != "" && !knownKindPattern.MatchString(item.SourceKind) {
		return fmt.Errorf("sourceKind 必须是小写标识符：%q", item.SourceKind)
	}
	if err := checkRef("sourceConversationId", item.SourceConversationID); err != nil {
		return err
	}
	if err := checkRef("sourceMessageId", item.SourceMessageID); err != nil {
		return err
	}
	if err := checkRef("supersededBy", item.SupersededBy); err != nil {
		return err
	}
	if err := checkText("contentHash", item.ContentHash, maxHashChars); err != nil {
		return err
	}
	if err := checkMeta(item.Meta); err != nil {
		return err
	}
	if item.Confidence <= 0 {
		item.Confidence = 0.5
	}
	if item.Confidence > 1 {
		return fmt.Errorf("confidence 超出 [0,1]：%v", item.Confidence)
	}
	if item.Importance <= 0 {
		item.Importance = 0.5
	}
	if item.Importance > 1 {
		return fmt.Errorf("importance 超出 [0,1]：%v", item.Importance)
	}
	if item.ValidFrom < 0 || item.ValidTo < 0 {
		return fmt.Errorf("validFrom / validTo 不能为负")
	}
	if item.ValidFrom > 0 && item.ValidTo > 0 && item.ValidTo < item.ValidFrom {
		return fmt.Errorf("validTo 早于 validFrom")
	}
	item.Status = strings.TrimSpace(item.Status)
	if item.Status == "" {
		item.Status = StatusActive
	}
	switch item.Status {
	case StatusActive, StatusSuperseded, StatusDeleted:
	default:
		return fmt.Errorf("status 不支持：%q", item.Status)
	}
	if item.Status == StatusSuperseded && item.SupersededBy == "" {
		return fmt.Errorf("status=superseded 时必须给 supersededBy")
	}
	return nil
}

const itemColumns = `id, kind, scope_type, scope_id, content, summary,
	source_kind, source_conversation_id, source_message_id,
	confidence, importance, valid_from, valid_to, status, superseded_by,
	content_hash, meta, created_at, updated_at`

func scanItem(row interface{ Scan(...any) error }) (ItemOut, error) {
	var out ItemOut
	err := row.Scan(
		&out.ID, &out.Kind, &out.ScopeType, &out.ScopeID, &out.Content, &out.Summary,
		&out.SourceKind, &out.SourceConversationID, &out.SourceMessageID,
		&out.Confidence, &out.Importance, &out.ValidFrom, &out.ValidTo, &out.Status,
		&out.SupersededBy, &out.ContentHash, &out.Meta, &out.CreatedAt, &out.UpdatedAt,
	)
	return out, err
}

func sameItem(left, right Item) bool {
	return left.Kind == right.Kind &&
		left.ScopeType == right.ScopeType &&
		left.ScopeID == right.ScopeID &&
		left.Content == right.Content &&
		left.Summary == right.Summary &&
		left.SourceKind == right.SourceKind &&
		left.SourceConversationID == right.SourceConversationID &&
		left.SourceMessageID == right.SourceMessageID &&
		left.Confidence == right.Confidence &&
		left.Importance == right.Importance &&
		left.ValidFrom == right.ValidFrom &&
		left.ValidTo == right.ValidTo &&
		left.Status == right.Status &&
		left.SupersededBy == right.SupersededBy &&
		left.ContentHash == right.ContentHash &&
		left.Meta == right.Meta
}

// upsertItemsTx 是所有写路径共用的行写入：跳过完全相同的行、同步全文索引、记事件。
// createdAtFor 决定新行的 created_at（迁移要用它保住旧数组顺序，普通写入传 nil 取当前时间）。
func (s *Store) upsertItemsTx(tx *sql.Tx, items []Item, reason string, now int64,
	createdAtFor func(prev *ItemOut) int64) (int, error) {
	written := 0
	for i, item := range items {
		before, found, loadErr := loadItemTx(tx, item.ID)
		if loadErr != nil {
			return 0, loadErr
		}
		if found && sameItem(before.Item, item) {
			continue
		}
		createdAt := now
		if found {
			createdAt = before.CreatedAt
		} else if createdAtFor != nil {
			createdAt = createdAtFor(&before)
		}
		if _, err := tx.Exec(`INSERT INTO memory_items (`+itemColumns+`)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(id) DO UPDATE SET
				kind = excluded.kind,
				scope_type = excluded.scope_type,
				scope_id = excluded.scope_id,
				content = excluded.content,
				summary = excluded.summary,
				source_kind = excluded.source_kind,
				source_conversation_id = excluded.source_conversation_id,
				source_message_id = excluded.source_message_id,
				confidence = excluded.confidence,
				importance = excluded.importance,
				valid_from = excluded.valid_from,
				valid_to = excluded.valid_to,
				status = excluded.status,
				superseded_by = excluded.superseded_by,
				content_hash = excluded.content_hash,
				meta = excluded.meta,
				updated_at = excluded.updated_at`,
			item.ID, item.Kind, item.ScopeType, item.ScopeID, item.Content, item.Summary,
			item.SourceKind, item.SourceConversationID, item.SourceMessageID,
			item.Confidence, item.Importance, item.ValidFrom, item.ValidTo, item.Status,
			item.SupersededBy, item.ContentHash, item.Meta, createdAt, now,
		); err != nil {
			return 0, fmt.Errorf("写入第 %d 条记忆失败：%w", i+1, err)
		}
		if err := s.syncFTSRow(tx, item); err != nil {
			return 0, fmt.Errorf("同步第 %d 条记忆全文索引失败：%w", i+1, err)
		}
		op := "create"
		var beforeJSON []byte
		if found {
			op = "update"
			beforeJSON, _ = json.Marshal(before.Item)
		}
		afterJSON, _ := json.Marshal(item)
		if err := insertEvent(tx, item.ID, op, beforeJSON, afterJSON, reason, now); err != nil {
			return 0, err
		}
		written++
	}
	return written, nil
}

// UpsertItems 批量写入记忆条目，同一事务内同步全文索引并记一条事件。
// 完全相同（含 contentHash）的写入会被跳过：前端每轮都会把整份语料送过来，
// 不跳过的话事件表会被「什么都没变」刷满。
func (s *Store) UpsertItems(items []Item, reason string) (int, error) {
	if !s.available() {
		return 0, sql.ErrConnDone
	}
	if len(items) > maxItemsPerBatch {
		return 0, fmt.Errorf("%w（记忆条目单批最多 %d 条）", ErrInvalid, maxItemsPerBatch)
	}
	if len(items) == 0 {
		return 0, nil
	}
	if err := checkText("reason", reason, maxReasonChars); err != nil {
		return 0, fmt.Errorf("%w：%w", ErrInvalid, err)
	}
	normalized := make([]Item, len(items))
	copy(normalized, items)
	for i := range normalized {
		if err := normalizeItem(&normalized[i]); err != nil {
			return 0, fmt.Errorf("%w：第 %d 条记忆：%w", ErrInvalid, i+1, err)
		}
	}

	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	now := time.Now().UnixMilli()
	written, err := s.upsertItemsTx(tx, normalized, reason, now, nil)
	if err == nil {
		err = markFTSSynced(s.fts, tx)
	}
	if err == nil {
		err = pruneEvents(tx)
	}
	if err == nil {
		err = tx.Commit()
	} else {
		_ = tx.Rollback()
	}
	if err != nil {
		return 0, err
	}
	return written, nil
}

func loadItemTx(tx *sql.Tx, id string) (ItemOut, bool, error) {
	row := tx.QueryRow(`SELECT `+itemColumns+` FROM memory_items WHERE id = ?`, id)
	out, err := scanItem(row)
	if err == sql.ErrNoRows {
		return ItemOut{}, false, nil
	}
	if err != nil {
		return ItemOut{}, false, err
	}
	return out, true, nil
}

// syncFTSRow 让全文索引与主表保持一致：先删后插，避免 FTS5 的 rowid 追踪错位。
func (s *Store) syncFTSRow(tx *sql.Tx, item Item) error {
	if !s.fts {
		return nil
	}
	if _, err := tx.Exec(`DELETE FROM memory_fts WHERE id = ?`, item.ID); err != nil {
		return err
	}
	_, err := tx.Exec(`INSERT INTO memory_fts (id, content, summary) VALUES (?, ?, ?)`,
		item.ID, item.Content, item.Summary)
	return err
}

// markFTSSynced 记下「全文索引与主表对齐到哪一版」。FTS 不可用时签名写空，
// 这样下次分词器可用时 migrate 一定能看出差异并整表重建。
func markFTSSynced(fts bool, tx *sql.Tx) error {
	signature := ""
	if fts {
		if err := tx.QueryRow(
			`SELECT COALESCE(COUNT(*), 0) || ':' || COALESCE(MAX(updated_at), 0) FROM memory_items`,
		).Scan(&signature); err != nil {
			return err
		}
	}
	_, err := tx.Exec(`INSERT INTO schema_meta (key, value) VALUES ('memory_fts_sync', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, signature)
	return err
}

func insertEvent(tx *sql.Tx, memoryID, op string, before, after []byte, reason string, at int64) error {
	_, err := tx.Exec(
		`INSERT INTO memory_events (memory_id, op, before, after, reason, at) VALUES (?,?,?,?,?,?)`,
		memoryID, op, nullBytes(before), nullBytes(after), reason, at)
	return err
}

func nullBytes(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return string(b)
}

func pruneEvents(tx *sql.Tx) error {
	_, err := tx.Exec(`DELETE FROM memory_events WHERE id <= (
		SELECT id FROM memory_events ORDER BY id DESC LIMIT 1 OFFSET ?
	)`, maxEventsKept)
	return err
}

// ItemIDs 返回全部条目 id，供页面判断「哪些 id 已经从语料里消失」。
func (s *Store) ItemIDs() ([]string, error) {
	if !s.available() {
		return nil, sql.ErrConnDone
	}
	rows, err := s.db.Query(`SELECT id FROM memory_items ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, 64)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func clampLimit(limit int) int {
	if limit <= 0 {
		return 20
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func likePattern(q string) string {
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q)
	return "%" + escaped + "%"
}

func filterSQL(f SearchFilter, alias string) (string, []any) {
	clause := ""
	args := make([]any, 0, 3)
	if f.Kind != "" {
		clause += " AND " + alias + "kind = ?"
		args = append(args, f.Kind)
	}
	if f.ScopeType != "" {
		clause += " AND " + alias + "scope_type = ?"
		args = append(args, f.ScopeType)
	}
	if f.ScopeID != "" {
		clause += " AND " + alias + "scope_id = ?"
		args = append(args, f.ScopeID)
	}
	return clause, args
}

// SearchItems 按全文检索记忆条目。FTS5 可用时用 bm25 排序，否则退化为 LIKE + importance 排序。
func (s *Store) SearchItems(query string, f SearchFilter) (SearchResult, error) {
	result := SearchResult{Items: []Hit{}, Mode: "like"}
	if !s.available() {
		return result, sql.ErrConnDone
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return result, nil
	}
	limit := clampLimit(f.Limit)
	filter, filterArgs := filterSQL(f, "mi.")
	if s.fts {
		expr := buildMatchExpr(tokenizeQuery(query))
		if expr != "" {
			rows, err := s.db.Query(`SELECT `+prefixColumns("mi.", itemColumns)+`, -bm25(memory_fts) AS score
				FROM memory_fts JOIN memory_items mi ON mi.id = memory_fts.id
				WHERE memory_fts MATCH ? AND mi.status <> 'deleted'`+filter+`
				ORDER BY score DESC LIMIT ?`,
				append(append([]any{expr}, filterArgs...), limit)...)
			if err == nil {
				items, scanErr := scanHits(rows)
				rows.Close()
				if scanErr != nil {
					return result, scanErr
				}
				result.Items, result.Mode = items, "fts"
				return result, nil
			}
			// MATCH 语法出错时不该整页 500：退回 LIKE，用户至少还能搜到字面命中。
			if s.log != nil {
				s.log.Warnf("Memory", "FTS5 查询失败，本次退回 LIKE：%v", err)
			}
		}
	}
	rows, err := s.db.Query(`SELECT `+prefixColumns("mi.", itemColumns)+`, 0 AS score
		FROM memory_items mi
		WHERE mi.status <> 'deleted'
			AND (mi.content LIKE ? ESCAPE '\' OR mi.summary LIKE ? ESCAPE '\')`+filter+`
		ORDER BY mi.importance DESC, mi.updated_at DESC, mi.id LIMIT ?`,
		append(append([]any{likePattern(query), likePattern(query)}, filterArgs...), limit)...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	items, err := scanHits(rows)
	if err != nil {
		return result, err
	}
	result.Items = items
	return result, nil
}

// Timeline 按生效时间倒序列出条目；没有 valid_from 的用 created_at 兜底。
func (s *Store) Timeline(f SearchFilter) (TimelineResult, error) {
	result := TimelineResult{Items: []ItemOut{}, Mode: "timeline"}
	if !s.available() {
		return result, sql.ErrConnDone
	}
	limit := clampLimit(f.Limit)
	filter, filterArgs := filterSQL(f, "mi.")
	rows, err := s.db.Query(`SELECT `+prefixColumns("mi.", itemColumns)+`
		FROM memory_items mi
		WHERE mi.status <> 'deleted'`+filter+`
		ORDER BY CASE WHEN mi.valid_from > 0 THEN mi.valid_from ELSE mi.created_at END DESC,
			mi.created_at DESC, mi.id
		LIMIT ?`, append(filterArgs, limit)...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, item)
	}
	return result, rows.Err()
}

// prefixColumns 给逗号分隔的列名统一加表别名，省掉手写两遍列清单。
func prefixColumns(alias, columns string) string {
	parts := strings.Split(columns, ",")
	for i, part := range parts {
		parts[i] = alias + strings.TrimSpace(part)
	}
	return strings.Join(parts, ", ")
}

func scanHits(rows *sql.Rows) ([]Hit, error) {
	items := make([]Hit, 0, 16)
	for rows.Next() {
		var hit Hit
		err := rows.Scan(
			&hit.ID, &hit.Kind, &hit.ScopeType, &hit.ScopeID, &hit.Content, &hit.Summary,
			&hit.SourceKind, &hit.SourceConversationID, &hit.SourceMessageID,
			&hit.Confidence, &hit.Importance, &hit.ValidFrom, &hit.ValidTo, &hit.Status,
			&hit.SupersededBy, &hit.ContentHash, &hit.Meta, &hit.CreatedAt, &hit.UpdatedAt, &hit.Score,
		)
		if err != nil {
			return nil, err
		}
		items = append(items, hit)
	}
	return items, rows.Err()
}

// invalid 把「调用方数据不对」统一打上 ErrInvalid，HTTP 层才能按 400 处理，
// 而不是把参数错误混进 500。
func invalid(format string, args ...any) error {
	return fmt.Errorf("%w："+format, append([]any{ErrInvalid}, args...)...)
}
