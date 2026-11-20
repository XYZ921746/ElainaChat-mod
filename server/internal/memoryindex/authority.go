package memoryindex

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// 本文件是记忆的权威层：memory_items 是记忆的唯一落盘处。
// 六类目（Core）与行（Item）的转换在 core.go，这里只管存取与迁移标记。

type ImportResult struct {
	Upserted int `json:"upserted"`
	Deleted  int `json:"deleted"`
	Skipped  int `json:"skipped"`
}

// checkMeta 校验附加字段列：必须是 JSON 对象（或空，空按 '{}' 处理）。
func checkMeta(raw string) error {
	if raw == "" {
		return nil
	}
	if runeCount(raw) > maxMetaRunes {
		return fmt.Errorf("%w：meta 超过 %d 字", ErrInvalid, maxMetaRunes)
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return fmt.Errorf("%w：meta 必须是 JSON 对象", ErrInvalid)
	}
	return nil
}

// LoadItems 取全部条目（这就是「全部记忆」，量级由六类目自身封顶，不做分页）。
func (s *Store) LoadItems() ([]ItemOut, error) {
	if !s.available() {
		return nil, sql.ErrConnDone
	}
	rows, err := s.db.Query(`SELECT ` + itemColumns + ` FROM memory_items ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]ItemOut, 0, 64)
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// CountItems 条目总数，给 /api/data/info 的 memoryEntries 用。
func (s *Store) CountItems() (int, error) {
	if !s.available() {
		return 0, sql.ErrConnDone
	}
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM memory_items`).Scan(&n)
	return n, err
}

// Core 还原六类目视图。
func (s *Store) Core() (Core, error) {
	items, err := s.LoadItems()
	if err != nil {
		return Core{}, err
	}
	return itemsToCore(items), nil
}

// MergeCore 是页面写路径的唯一入口：整类目替换 + 显式删除。
//
// 语义来自前端整理器的现实行为——模型每次返回**整份**类目清单（还会按提示词丢掉已完成的
// 计划），所以「只增不删」的合并会漏掉刻意的删除；而「整份覆盖」又会把其它设备刚写入的
// 条目静默抹掉。折中：按 id upsert 本份 core，再删调用方显式给出的 dropIDs（前端 diff
// 上一份 canonical core 算出来的）。其它设备新写的条目不在 dropIDs 里，安然无恙。
func (s *Store) MergeCore(core Core, dropIDs []string, reason string) (Core, ImportResult, error) {
	result := ImportResult{}
	if !s.available() {
		return Core{}, result, sql.ErrConnDone
	}
	if err := checkText("reason", reason, maxReasonChars); err != nil {
		return Core{}, result, fmt.Errorf("%w：%w", ErrInvalid, err)
	}
	converted := coreToItems(core)
	result.Skipped = len(converted.skipped)
	// 不设条目总量上限：条目的生杀只在用户手里的 dropIDs，超量拒绝保存等于替用户丢数据。

	tx, err := s.db.Begin()
	if err != nil {
		return Core{}, result, err
	}
	now := time.Now().UnixMilli()
	result.Upserted, err = s.upsertItemsTx(tx, converted.items, reason, now, nil)
	if err == nil && len(dropIDs) > 0 {
		result.Deleted, err = deleteItemsTx(s, tx, dropIDs, reason, now)
	}
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
		return Core{}, result, err
	}
	s.markHealthy()
	canonical, err := s.Core()
	if err != nil {
		return Core{}, result, err
	}
	return canonical, result, nil
}

// markHealthy 在一次成功写入后解除 degraded：库重新有主，可以继续当权威读。
func (s *Store) markHealthy() {
	s.degraded.Store(false)
}

// ImportLegacyCore 解析 legacy 六类目 JSON 并写入。replace 与 ImportCore 相同：
// 迁移用 true（权威换代，整库重建），关库期间的回灌用 false（只增改、不删）。
func (s *Store) ImportLegacyCore(raw []byte, replace bool, reason string) (ImportResult, error) {
	core, err := ParseCore(raw)
	if err != nil {
		return ImportResult{}, err
	}
	return s.ImportCore(core, replace, reason)
}

// ImportCore 把一份 core 写进库。replace=true 先清空（迁移与 replace 备份导入用），
// false 只 upsert（merge 备份导入 / 关库期间攒下的旧 JSON 回灌）。
func (s *Store) ImportCore(core Core, replace bool, reason string) (ImportResult, error) {
	result := ImportResult{}
	if !s.available() {
		return result, sql.ErrConnDone
	}
	converted := coreToItems(core)
	result.Skipped = len(converted.skipped)

	tx, err := s.db.Begin()
	if err != nil {
		return result, err
	}
	now := time.Now().UnixMilli()
	if replace {
		if err := clearItemsTx(s, tx); err != nil {
			_ = tx.Rollback()
			return result, err
		}
		// 迁移按源 JSON 的数组顺序重建 created_at：读回的顺序才和原数组一致
		// （legacy promise/preference 的提示词截断取的是数组前缀，顺序就是行为）。
		base := now
		for i := range converted.items {
			converted.items[i].Status = StatusActive
		}
		result.Upserted, err = s.upsertItemsTx(tx, converted.items, reason, now,
			func(_ *ItemOut) int64 { base++; return base })
	} else {
		result.Upserted, err = s.upsertItemsTx(tx, converted.items, reason, now, nil)
	}
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
		return result, err
	}
	s.markHealthy()
	return result, nil
}

// deleteItemsTx 是 DeleteItems 的事务内核，供 MergeCore 复用（同一事务里删+写才原子）。
func deleteItemsTx(s *Store, tx *sql.Tx, ids []string, reason string, now int64) (int, error) {
	deleted := 0
	for i, id := range ids {
		id = trimID(id)
		if id == "" || len(id) > maxIDChars {
			return 0, fmt.Errorf("%w：第 %d 条删除 id 无效", ErrInvalid, i+1)
		}
		before, found, loadErr := loadItemTx(tx, id)
		if loadErr != nil {
			return 0, loadErr
		}
		if !found {
			continue
		}
		if err := removeItemTx(s, tx, id, before, reason, now); err != nil {
			return 0, err
		}
		deleted++
	}
	return deleted, nil
}

func trimID(id string) string {
	start := 0
	end := len(id)
	for start < end && (id[start] == ' ' || id[start] == '\t') {
		start++
	}
	for end > start && (id[end-1] == ' ' || id[end-1] == '\t') {
		end--
	}
	return id[start:end]
}

// DeleteItems 按 id 删除并记事件。不存在的 id 直接跳过，计数只报真正删掉的行。
func (s *Store) DeleteItems(ids []string, reason string) (int, error) {
	if !s.available() {
		return 0, sql.ErrConnDone
	}
	if len(ids) > maxBatchItems {
		return 0, fmt.Errorf("%w（删除单批最多 %d 条）", ErrInvalid, maxBatchItems)
	}
	if len(ids) == 0 {
		return 0, nil
	}
	if err := checkText("reason", reason, maxReasonChars); err != nil {
		return 0, fmt.Errorf("%w：%w", ErrInvalid, err)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	now := time.Now().UnixMilli()
	deleted, err := deleteItemsTx(s, tx, ids, reason, now)
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
	return deleted, nil
}

// removeItemTx 删主表行 + 全文索引行 + 悬空链接 + 记事件。
func removeItemTx(s *Store, tx *sql.Tx, id string, before ItemOut, reason string, now int64) error {
	if _, err := tx.Exec(`DELETE FROM memory_items WHERE id = ?`, id); err != nil {
		return fmt.Errorf("删除记忆失败：%w", err)
	}
	if s.fts {
		if _, err := tx.Exec(`DELETE FROM memory_fts WHERE id = ?`, id); err != nil {
			return err
		}
	}
	// 悬空链接一并清掉：留着只会让后续查询指向已经不存在的条目。
	if _, err := tx.Exec(`DELETE FROM memory_links WHERE from_id = ? OR to_id = ?`, id, id); err != nil {
		return err
	}
	beforeJSON, _ := json.Marshal(before.Item)
	return insertEvent(tx, id, "delete", beforeJSON, nil, reason, now)
}

// clearItemsTx 清空记忆相关表（向量表不动：它是另一套派生索引，有自己的生命周期）。
func clearItemsTx(s *Store, tx *sql.Tx) error {
	for _, stmt := range []string{
		`DELETE FROM memory_items`,
		`DELETE FROM memory_links`,
		`DELETE FROM memory_events`,
	} {
		if _, err := tx.Exec(stmt); err != nil {
			return err
		}
	}
	if s.fts {
		if _, err := tx.Exec(`DELETE FROM memory_fts`); err != nil {
			return err
		}
	}
	return nil
}

// 迁移标记（schema_meta）

func (s *Store) getMetaFlag(key string) (string, bool, error) {
	var value string
	err := s.db.QueryRow(`SELECT value FROM schema_meta WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

func (s *Store) setMetaFlag(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO schema_meta (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// LegacyMigrated 报告 Store → SQLite 的一次性迁移是否已经做过。
func (s *Store) LegacyMigrated() (bool, error) {
	if !s.available() {
		return false, sql.ErrConnDone
	}
	_, ok, err := s.getMetaFlag(legacyMarkerKey)
	return ok, err
}

// MarkLegacyMigrated 落迁移标记。时间值用于排障，不参与判断。
func (s *Store) MarkLegacyMigrated() error {
	if !s.available() {
		return sql.ErrConnDone
	}
	return s.setMetaFlag(legacyMarkerKey, time.Now().UTC().Format(time.RFC3339))
}

// 备份导出 / 导入

type itemsDump struct {
	Format  string    `json:"format"`
	Version int       `json:"version"`
	Items   []ItemOut `json:"items"`
}

// ExportItems 生成备份里的逻辑导出（data/memory-index/items.json）。
// 导出走查询而不是拷库文件：不需要一致快照机制，导出内容其他实现（含 Node 版）也读得懂。
func (s *Store) ExportItems() ([]byte, error) {
	items, err := s.LoadItems()
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []ItemOut{}
	}
	return json.MarshalIndent(itemsDump{
		Format:  dumpFormatString,
		Version: dumpVersion,
		Items:   items,
	}, "", "  ")
}

// ValidateItemsDump 只校验不写库：把「备份内容本身坏掉」挡在任何落盘动作之前，
// 记忆导入失败时 store 半边一个字节都没动过。
func ValidateItemsDump(raw []byte) error {
	_, err := parseItemsDump(raw)
	return err
}

// parseItemsDump 解析并逐条规范化逻辑导出，导入与预校验共用同一条解析规则。
func parseItemsDump(raw []byte) ([]Item, error) {
	var dump itemsDump
	if err := json.Unmarshal(raw, &dump); err != nil {
		return nil, fmt.Errorf("%w：记忆导出解析失败：%w", ErrInvalid, err)
	}
	if dump.Format != "" && dump.Format != dumpFormatString {
		return nil, fmt.Errorf("%w：不是记忆导出文件（format=%s）", ErrInvalid, dump.Format)
	}
	normalized := make([]Item, 0, len(dump.Items))
	for i := range dump.Items {
		item := dump.Items[i].Item
		if err := normalizeItem(&item); err != nil {
			return nil, fmt.Errorf("%w：第 %d 条记忆：%w", ErrInvalid, i+1, err)
		}
		normalized = append(normalized, item)
	}
	return normalized, nil
}

// ImportItemsDump 导入逻辑导出。replace 与备份导入的 replace 语义对齐：先清空再写入。
func (s *Store) ImportItemsDump(raw []byte, replace bool, reason string) (ImportResult, error) {
	result := ImportResult{}
	if !s.available() {
		return result, sql.ErrConnDone
	}
	normalized, err := parseItemsDump(raw)
	if err != nil {
		return result, err
	}
	// 导出里是行不是类目：直接按行 upsert，绕过 core 转换。
	tx, err := s.db.Begin()
	if err != nil {
		return result, err
	}
	now := time.Now().UnixMilli()
	if replace {
		if err := clearItemsTx(s, tx); err != nil {
			_ = tx.Rollback()
			return result, err
		}
	}
	result.Upserted, err = s.upsertItemsTx(tx, normalized, reason, now, nil)
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
		return result, err
	}
	s.markHealthy()
	return result, nil
}

// ResetAll 清空整个派生索引（向量 + 记忆条目 + 链接 + 事件）。
// 常规导入路径不经过这里（导入保留 items），保留给「整库重置」类操作。
func (s *Store) ResetAll() (int, error) {
	if !s.available() {
		return 0, sql.ErrConnDone
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	total := 0
	for _, stmt := range []string{
		`DELETE FROM vectors`,
		`DELETE FROM memory_items`,
		`DELETE FROM memory_links`,
		`DELETE FROM memory_events`,
	} {
		res, execErr := tx.Exec(stmt)
		if execErr != nil {
			_ = tx.Rollback()
			return 0, execErr
		}
		if n, _ := res.RowsAffected(); stmt != `DELETE FROM memory_events` {
			total += int(n)
		}
	}
	if s.fts {
		if _, err := tx.Exec(`DELETE FROM memory_fts`); err != nil {
			_ = tx.Rollback()
			return 0, err
		}
	}
	if err := markFTSSynced(s.fts, tx); err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return total, nil
}
