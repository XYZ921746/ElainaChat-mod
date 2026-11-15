package memoryindex

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Vector 是前端一条已经量化好的 int8 向量。v 是标准 base64，解码后长度必须等于 dims。
type Vector struct {
	ID   string `json:"id"`
	Hash string `json:"h"`
	Vec  string `json:"v"`
}

type Batch struct {
	Fingerprint string `json:"fingerprint"`
	Dims        int    `json:"dims"`
	// BuildID 是 Begin 返回的构建标识；旧客户端不传时保持空串，继续按“直接写入”兼容。
	BuildID string   `json:"buildId,omitempty"`
	Items   []Vector `json:"items"`
}

type VectorOut struct {
	H string `json:"h"`
	V string `json:"v"`
}

// Index 与前端原来存 Store 键的形状保持一致，迁移时不用改读取端。
type Index struct {
	Fingerprint string               `json:"fingerprint"`
	Dims        int                  `json:"dims"`
	Items       map[string]VectorOut `json:"items"`
}

type Status struct {
	Fingerprint string `json:"fingerprint"`
	Dims        int    `json:"dims"`
	Count       int    `json:"count"`
	Ready       bool   `json:"ready"`
	BuildID     string `json:"buildId,omitempty"`
}

type bucketState struct {
	Dims    int
	Ready   bool
	BuildID string
}

func validateFingerprint(fp string) error {
	if fp == "" || len(fp) > maxFingerprintChar {
		return ErrBadFingerprint
	}
	return nil
}

func validateBatch(b Batch) error {
	if err := validateFingerprint(b.Fingerprint); err != nil {
		return err
	}
	if b.Dims <= 0 || b.Dims > maxDims {
		return ErrBadDims
	}
	if len(b.Items) > maxBatchItems {
		return ErrTooManyItems
	}
	if b.BuildID != "" && len(b.BuildID) > maxIDChars {
		return invalid("构建标识过长")
	}
	for i, item := range b.Items {
		if item.ID == "" || len(item.ID) > maxIDChars {
			return invalid("第 %d 条向量 id 无效", i+1)
		}
		if item.Hash == "" || len(item.Hash) > maxHashChars {
			return invalid("第 %d 条向量 hash 无效", i+1)
		}
		raw, err := base64.StdEncoding.DecodeString(item.Vec)
		if err != nil {
			return invalid("第 %d 条向量不是合法 base64：%w", i+1, err)
		}
		if len(raw) != b.Dims {
			return invalid("第 %d 条向量长度 %d 与维度 %d 不一致", i+1, len(raw), b.Dims)
		}
	}
	return nil
}

type rowQuerier interface {
	QueryRow(query string, args ...any) *sql.Row
}

func readBucket(q rowQuerier, fingerprint string) (bucketState, bool, error) {
	var dims, ready int
	var buildID string
	err := q.QueryRow(
		`SELECT dims, ready, build_id FROM vector_buckets WHERE fingerprint = ?`, fingerprint,
	).Scan(&dims, &ready, &buildID)
	if errors.Is(err, sql.ErrNoRows) {
		return bucketState{}, false, nil
	}
	if err != nil {
		return bucketState{}, false, err
	}
	return bucketState{Dims: dims, Ready: ready != 0, BuildID: buildID}, true, nil
}

func newBuildID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err == nil {
		return hex.EncodeToString(buf[:])
	}
	return fmt.Sprintf("b%d", time.Now().UnixNano())
}

func (s *Store) Status(fingerprint string) (Status, error) {
	if !s.available() {
		return Status{}, sql.ErrConnDone
	}
	fp := strings.TrimSpace(fingerprint)
	if fp != "" {
		if err := validateFingerprint(fp); err != nil {
			return Status{}, err
		}
	}
	if fp == "" {
		var count, dims int
		if err := s.db.QueryRow(`SELECT COUNT(*), COALESCE(MAX(dims), 0) FROM vectors`).Scan(&count, &dims); err != nil {
			return Status{}, err
		}
		return Status{Dims: dims, Count: count, Ready: true}, nil
	}
	bucket, ok, err := readBucket(s.db, fp)
	if err != nil {
		return Status{}, err
	}
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM vectors WHERE fingerprint = ?`, fp).Scan(&count); err != nil {
		return Status{}, err
	}
	status := Status{Fingerprint: fp, Count: count, Ready: true}
	if ok {
		status.Dims = bucket.Dims
		status.Ready = bucket.Ready
		status.BuildID = bucket.BuildID
		if !bucket.Ready {
			status.Count = 0
		}
	} else if count > 0 {
		// 没有桶元数据的老库（迁移遗漏/外部写入）：仍按行里的维度回答，避免把已有向量判成不可用。
		if err := s.db.QueryRow(`SELECT COALESCE(MAX(dims), 0) FROM vectors WHERE fingerprint = ?`, fp).Scan(&status.Dims); err != nil {
			return Status{}, err
		}
	}
	return status, nil
}

func (s *Store) Load(fingerprint string) (Index, error) {
	empty := Index{Fingerprint: fingerprint, Dims: 0, Items: map[string]VectorOut{}}
	if !s.available() {
		return empty, sql.ErrConnDone
	}
	fp := strings.TrimSpace(fingerprint)
	if fp == "" {
		return empty, nil
	}
	if err := validateFingerprint(fp); err != nil {
		return empty, err
	}
	bucket, ok, err := readBucket(s.db, fp)
	if err != nil {
		return empty, err
	}
	// ready=0 是“build 进行到一半”：返回空桶，让页面下次重建；把半成品当完整索引会让召回永远少一截。
	if ok && !bucket.Ready {
		return Index{Fingerprint: fp, Dims: bucket.Dims, Items: map[string]VectorOut{}}, nil
	}
	rows, err := s.db.Query(
		`SELECT id, hash, vec, dims FROM vectors WHERE fingerprint = ? ORDER BY id`, fp)
	if err != nil {
		return empty, err
	}
	defer rows.Close()

	index := Index{Fingerprint: fp, Items: map[string]VectorOut{}}
	if ok {
		index.Dims = bucket.Dims
	}
	for rows.Next() {
		var id, hash string
		var vec []byte
		var dims int
		if err := rows.Scan(&id, &hash, &vec, &dims); err != nil {
			return empty, err
		}
		if index.Dims == 0 {
			index.Dims = dims
		}
		// 同一指纹下混进不同维度只可能是中途换过模型；跳过而不是把维度带偏。
		if dims != index.Dims || len(vec) != index.Dims {
			continue
		}
		index.Items[id] = VectorOut{H: hash, V: base64.StdEncoding.EncodeToString(vec)}
	}
	if err := rows.Err(); err != nil {
		return empty, err
	}
	if len(index.Items) == 0 {
		index.Dims = 0
	}
	return index, nil
}

func (s *Store) Upsert(batch Batch) (int, error) {
	if !s.available() {
		return 0, sql.ErrConnDone
	}
	if err := validateBatch(batch); err != nil {
		return 0, err
	}
	if len(batch.Items) == 0 {
		return 0, nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	bucket, ok, err := readBucket(tx, batch.Fingerprint)
	if err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	if ok {
		if bucket.Dims != batch.Dims {
			_ = tx.Rollback()
			return 0, fmt.Errorf("%w：现有桶维度 %d，本批 %d", ErrBadDims, bucket.Dims, batch.Dims)
		}
		if bucket.BuildID != "" && batch.BuildID != bucket.BuildID {
			_ = tx.Rollback()
			return 0, fmt.Errorf("%w：请重新 begin 后重建", ErrStaleBuild)
		}
	}
	now := time.Now().UnixMilli()
	if !ok {
		// 没有 begin 的旧客户端：直接按“已完成”建桶，别让一次升级把写入全卡死。
		if _, err := tx.Exec(
			`INSERT INTO vector_buckets (fingerprint, dims, ready, build_id, updated_at) VALUES (?, ?, 1, '', ?)`,
			batch.Fingerprint, batch.Dims, now); err != nil {
			_ = tx.Rollback()
			return 0, err
		}
	} else if _, err := tx.Exec(
		`UPDATE vector_buckets SET updated_at = ? WHERE fingerprint = ?`, now, batch.Fingerprint); err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	stmt, err := tx.Prepare(`
		INSERT INTO vectors (fingerprint, id, dims, hash, vec, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(fingerprint, id) DO UPDATE SET
			dims = excluded.dims,
			hash = excluded.hash,
			vec = excluded.vec,
			updated_at = excluded.updated_at`)
	if err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	written := 0
	for i, item := range batch.Items {
		raw, err := base64.StdEncoding.DecodeString(item.Vec)
		if err != nil {
			_ = stmt.Close()
			_ = tx.Rollback()
			return 0, invalid("第 %d 条向量不是合法 base64：%w", i+1, err)
		}
		if _, err := stmt.Exec(batch.Fingerprint, item.ID, batch.Dims, item.Hash, raw, now); err != nil {
			_ = stmt.Close()
			_ = tx.Rollback()
			return 0, fmt.Errorf("写入第 %d 条向量失败：%w", i+1, err)
		}
		written++
	}
	if err := stmt.Close(); err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return written, nil
}

// Begin 无条件接管同指纹的构建：清空旧行并换一个新的 build_id。旧的未 commit 构建
// 从此作废，它的 upsert / commit 会收到 ErrStaleBuild，不会把半成品和新构建混在一起。
func (s *Store) Begin(fingerprint string, dims int) (string, error) {
	if !s.available() {
		return "", sql.ErrConnDone
	}
	fp := strings.TrimSpace(fingerprint)
	if err := validateFingerprint(fp); err != nil {
		return "", err
	}
	if dims <= 0 || dims > maxDims {
		return "", ErrBadDims
	}
	buildID := newBuildID()
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	now := time.Now().UnixMilli()
	if _, err := tx.Exec(
		`INSERT INTO vector_buckets (fingerprint, dims, ready, build_id, updated_at)
		 VALUES (?, ?, 0, ?, ?)
		 ON CONFLICT(fingerprint) DO UPDATE SET
		 	dims = excluded.dims, ready = 0, build_id = excluded.build_id, updated_at = excluded.updated_at`,
		fp, dims, buildID, now); err != nil {
		_ = tx.Rollback()
		return "", err
	}
	if _, err := tx.Exec(`DELETE FROM vectors WHERE fingerprint = ?`, fp); err != nil {
		_ = tx.Rollback()
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return buildID, nil
}

func (s *Store) Commit(fingerprint, buildID string) error {
	if !s.available() {
		return sql.ErrConnDone
	}
	fp := strings.TrimSpace(fingerprint)
	if err := validateFingerprint(fp); err != nil {
		return err
	}
	buildID = strings.TrimSpace(buildID)
	if buildID == "" {
		return fmt.Errorf("%w：缺少构建标识", ErrStaleBuild)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	res, err := tx.Exec(
		`UPDATE vector_buckets SET ready = 1, updated_at = ? WHERE fingerprint = ? AND build_id = ?`,
		time.Now().UnixMilli(), fp, buildID)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		_ = tx.Rollback()
		return fmt.Errorf("%w：该构建已失效", ErrStaleBuild)
	}
	return tx.Commit()
}

func (s *Store) Delete(fingerprint string, ids []string) (int, error) {
	if !s.available() {
		return 0, sql.ErrConnDone
	}
	fp := strings.TrimSpace(fingerprint)
	if fp != "" {
		if err := validateFingerprint(fp); err != nil {
			return 0, err
		}
	}
	if len(ids) == 0 {
		return 0, nil
	}
	if len(ids) > maxBatchItems {
		return 0, ErrTooManyItems
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	query := `DELETE FROM vectors WHERE id = ?`
	if fp != "" {
		query = `DELETE FROM vectors WHERE fingerprint = ? AND id = ?`
	}
	stmt, err := tx.Prepare(query)
	if err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	deleted := 0
	for i, id := range ids {
		if id == "" || len(id) > maxIDChars {
			_ = stmt.Close()
			_ = tx.Rollback()
			return 0, invalid("第 %d 条删除 id 无效", i+1)
		}
		args := []any{id}
		if fp != "" {
			args = []any{fp, id}
		}
		res, err := stmt.Exec(args...)
		if err != nil {
			_ = stmt.Close()
			_ = tx.Rollback()
			return 0, fmt.Errorf("删除第 %d 条向量失败：%w", i+1, err)
		}
		if n, _ := res.RowsAffected(); n > 0 {
			deleted += int(n)
		}
	}
	if err := stmt.Close(); err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return deleted, nil
}

// Reset 清空索引；给 fingerprint 时只清该模型桶，便于换模型时丢掉旧向量。
func (s *Store) Reset(fingerprint string) (int, error) {
	if !s.available() {
		return 0, sql.ErrConnDone
	}
	fp := strings.TrimSpace(fingerprint)
	if fp != "" {
		if err := validateFingerprint(fp); err != nil {
			return 0, err
		}
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	var res sql.Result
	if fp == "" {
		res, err = tx.Exec(`DELETE FROM vectors`)
	} else {
		res, err = tx.Exec(`DELETE FROM vectors WHERE fingerprint = ?`, fp)
	}
	if err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	if fp == "" {
		_, err = tx.Exec(`DELETE FROM vector_buckets`)
	} else {
		_, err = tx.Exec(`DELETE FROM vector_buckets WHERE fingerprint = ?`, fp)
	}
	if err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	n, _ := res.RowsAffected()
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return int(n), nil
}
