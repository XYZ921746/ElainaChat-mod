// Package memoryindex 是记忆索引的 SQLite 落盘层。
//
// 它存两类东西：向量（`vectors`）是派生索引，可随时整库重建；
// 结构化记忆条目（`memory_items` + FTS5 全文索引 + 链接/事件表）是**记忆正文的唯一权威**，
// 打开失败绝不能无声重建，必须留证 + 尝试回灌（见 Open 与 cmd/elaina-server 的接线）。
package memoryindex

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	sqlite3 "github.com/ncruces/go-sqlite3"
	"github.com/ncruces/go-sqlite3/driver"
	"github.com/ncruces/go-sqlite3/ext/fts5"

	"elainachat/server/internal/logx"
)

const schemaVersion = 4

// bigramTokenizerName 是 SQL 里 `tokenize='…'` 用的名字，与 tokenizer.go 的实现绑定。
const bigramTokenizerName = "elaina_bigram"

const (
	// 一条索引的 id / 哈希 / 指纹都是宿主自己生成的短字符串；这里只挡住病态输入。
	maxIDChars         = 200
	maxHashChars       = 128
	maxFingerprintChar = 200
	maxDims            = 8192
	maxBatchItems      = 512
)

var (
	ErrBadFingerprint = errors.New("嵌入模型指纹无效")
	ErrBadDims        = errors.New("向量维度无效")
	ErrTooManyItems   = errors.New("单批条数过多")
	// ErrStaleBuild 表示写请求属于一个已被新的 begin 取代的旧构建：同指纹再次 begin 会清空旧行，
	// 旧构建后续的 upsert / commit 不能再把半成品写回来。
	ErrStaleBuild = errors.New("向量构建已被更新的一次 begin 取代")
	// ErrInvalid 标出调用方给的数据不合法；HTTP 层据此回 400，其余错误按 500 处理。
	ErrInvalid = errors.New("记忆条目参数错误")
	// ErrSchemaTooNew 标出「库版本比程序新」（程序被降级运行）。文件是健康的，
	// 绝不能走损坏重建那条路——那会把一份好库改名留证、留一个空库在原地。
	ErrSchemaTooNew = errors.New("记忆索引库的 schema 版本高于当前程序支持")
)

// isCorruptionError 判断打开失败是否为「库内容本身坏了」。只有这一类才允许
// 留证重建；锁竞争、权限、磁盘 IO 与网络盘错误重建不出好结果，还可能把健康库
// （或另一实例正在写的库）改名搬走。
func isCorruptionError(err error) bool {
	var sqliteErr *sqlite3.Error
	if errors.As(err, &sqliteErr) {
		switch sqliteErr.Code() {
		case sqlite3.CORRUPT, sqlite3.NOTADB:
			return true
		}
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "database disk image is malformed") ||
		strings.Contains(msg, "file is not a database")
}

// Store 只允许一个连接：SQLite 的写者本来就只能有一个，开多连接只会把
// busy 重试带进业务层；本应用只有 Go 服务端进程会碰这个文件。
type Store struct {
	db   *sql.DB
	log  *logx.Logger
	path string
	// fts 表示全文索引本次是否可用。不可用时搜索退化为 LIKE（仍能查到，只是没有词序与 bm25）。
	fts bool
	// degraded 表示打开时库损坏、留证重建后新库为空，且自动回灌没有成功。
	// 此时新库不是权威形状（页面本地数据更全），GET /core 要拒绝它，
	// 直到有一次成功写入让库重新有主。
	degraded        atomic.Bool
	quarantinedPath string
}

// Open 打开（必要时创建）索引库。这里重建的是「记忆正文的唯一权威」，失败路径必须分开：
// 版本比程序新 → 原样报错（文件健康，重建等于销毁数据）；
// 打开失败 → 先重试（可能是同数据目录另一实例的锁竞争），仍失败才改名留证重建，
// 并把新库标成 degraded（空库不能冒充权威），由调用方尝试从迁移备份回灌。
func Open(path string, log *logx.Logger) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("记忆索引路径为空")
	}
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("创建索引目录失败: %w", err)
		}
	}
	s, err := openAt(path, log)
	if err == nil {
		return s, nil
	}
	if errors.Is(err, ErrSchemaTooNew) {
		return nil, err
	}
	if log != nil {
		log.Warnf("Memory", "SQLite 记忆索引打开失败，先重试一次再考虑重建：%v", err)
	}
	time.Sleep(250 * time.Millisecond)
	if s, err = openAt(path, log); err == nil {
		return s, nil
	}
	// 只有「库内容本身坏了」才走留证重建：锁竞争、权限、磁盘 IO 重建不出好结果，
	// 还可能把另一实例正在写的健康库改名搬走。
	if !isCorruptionError(err) {
		return nil, fmt.Errorf("打开记忆索引失败: %w", err)
	}
	bad := ""
	if path != ":memory:" {
		bad = path + ".bad-" + time.Now().Format("20060102-150405")
		if renameErr := os.Rename(path, bad); renameErr == nil {
			_ = os.Remove(path + "-wal")
			_ = os.Remove(path + "-shm")
			if log != nil {
				log.Warnf("Memory", "记忆索引仍打不开，已把原库留证到 %s 并重建空库", bad)
			}
		} else {
			bad = ""
			if log != nil {
				log.Warnf("Memory", "记忆索引留证失败（%v），尝试直接重建", renameErr)
			}
		}
	}
	s, err = openAt(path, log)
	if err != nil {
		return nil, fmt.Errorf("打开记忆索引失败: %w", err)
	}
	s.degraded.Store(true)
	s.quarantinedPath = bad
	return s, nil
}

// Degraded 报告当前库是否是损坏重建后还没有数据主人的空库。
// degraded 的库不能当权威读：页面本地数据（或迁移备份）比它全。
func (s *Store) Degraded() bool {
	return s != nil && s.degraded.Load()
}

// QuarantinedPath 返回损坏库的留证路径（没有留证成功时为空串），给排障日志用。
func (s *Store) QuarantinedPath() string {
	if s == nil {
		return ""
	}
	return s.quarantinedPath
}

// connState 收集连接初始化时注册扩展的结果。fts5 是按连接注册的，
// 所以注册失败必须在建表前就知道，否则会拿着一个用不了的 tokenizer 去建虚拟表。
type connState struct {
	ftsReady bool
	ftsErr   error
}

func openAt(path string, log *logx.Logger) (*Store, error) {
	state := &connState{}
	db, err := driver.Open(path, func(conn *sqlite3.Conn) error {
		// 注册失败不在这里中断连接：索引仍要能开，搜索退化为 LIKE 即可。
		state.ftsErr = fts5.RegisterCustom(conn, func(api *fts5.API) error {
			return api.CreateTokenizer(bigramTokenizerName,
				func([]string) (fts5.Tokenizer, error) { return bigramTokenizer{}, nil })
		})
		state.ftsReady = state.ftsErr == nil
		return nil
	})
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	// WAL 让读不挡写；busy_timeout 给另一个进程留一点收尾时间。
	// 某些文件系统（例如部分网络盘）不支持 WAL，失败时保留默认日志模式即可。
	// synchronous 用 FULL 而不是 NORMAL：记忆正文已是唯一权威，WAL 下 NORMAL
	// 不逐提交 fsync，掉电会丢最近若干次提交；记忆写入频率低，FULL 的代价可以接受。
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=FULL",
		"PRAGMA busy_timeout=5000",
	} {
		if _, pragmaErr := db.Exec(pragma); pragmaErr != nil && log != nil {
			log.Warnf("Memory", "SQLite 设置 %s 失败：%v", pragma, pragmaErr)
		}
	}
	fts, err := migrate(db, state, log)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db, log: log, path: path, fts: fts}, nil
}

func migrate(db *sql.DB, state *connState, log *logx.Logger) (bool, error) {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return false, err
	}
	if version > schemaVersion {
		return false, fmt.Errorf("%w：%d > %d", ErrSchemaTooNew, version, schemaVersion)
	}
	tx, err := db.Begin()
	if err != nil {
		return false, err
	}
	// 全部 CREATE 都是 IF NOT EXISTS：每次打开都跑一遍，等价于幂等迁移，
	// v1（只有 vectors）与 v2 库走同一条路径，不需要按版本分叉。
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS schema_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS vectors (
			fingerprint TEXT NOT NULL,
			id TEXT NOT NULL,
			dims INTEGER NOT NULL,
			hash TEXT NOT NULL,
			vec BLOB NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (fingerprint, id)
		)`,
		`CREATE INDEX IF NOT EXISTS vectors_fp ON vectors(fingerprint)`,
		`CREATE INDEX IF NOT EXISTS vectors_id ON vectors(id)`,
		// 桶元数据：dims 是桶级约束（同指纹不允许混维度），ready=0 表示 build 未提交，
		// build_id 用来拒绝被新 begin 取代的旧构建继续写入/提交。
		`CREATE TABLE IF NOT EXISTS vector_buckets (
			fingerprint TEXT PRIMARY KEY,
			dims INTEGER NOT NULL,
			ready INTEGER NOT NULL DEFAULT 1,
			build_id TEXT NOT NULL DEFAULT '',
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS memory_items (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			scope_type TEXT NOT NULL,
			scope_id TEXT NOT NULL DEFAULT '',
			content TEXT NOT NULL,
			summary TEXT NOT NULL DEFAULT '',
			source_kind TEXT NOT NULL DEFAULT '',
			source_conversation_id TEXT NOT NULL DEFAULT '',
			source_message_id TEXT NOT NULL DEFAULT '',
			confidence REAL NOT NULL,
			importance REAL NOT NULL,
			valid_from INTEGER NOT NULL DEFAULT 0,
			valid_to INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL,
			superseded_by TEXT NOT NULL DEFAULT '',
			content_hash TEXT NOT NULL DEFAULT '',
			meta TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS memory_items_kind ON memory_items(kind, status)`,
		`CREATE INDEX IF NOT EXISTS memory_items_scope ON memory_items(scope_type, scope_id)`,
		`CREATE INDEX IF NOT EXISTS memory_items_valid ON memory_items(valid_from)`,
		`CREATE TABLE IF NOT EXISTS memory_links (
			from_id TEXT NOT NULL,
			to_id TEXT NOT NULL,
			relation TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (from_id, to_id, relation)
		)`,
		`CREATE INDEX IF NOT EXISTS memory_links_to ON memory_links(to_id)`,
		`CREATE TABLE IF NOT EXISTS memory_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			memory_id TEXT NOT NULL,
			op TEXT NOT NULL,
			before TEXT,
			after TEXT,
			reason TEXT NOT NULL DEFAULT '',
			at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS memory_events_memory ON memory_events(memory_id, at)`,
	} {
		if _, err := tx.Exec(stmt); err != nil {
			_ = tx.Rollback()
			return false, err
		}
	}

	// v3 → v4：旧 vectors 以 id 为单主键，同一记忆 id 在不同指纹下会互相顶掉；
	// 这里改成 (fingerprint, id) 复合主键，并把旧行原样搬过去。迁移写成可重入的：
	// 上次在 rename / copy 中间崩过，下次打开还要能接着把数据捞回来。
	if err := migrateVectorsV4(tx); err != nil {
		_ = tx.Rollback()
		return false, err
	}
	// 桶元数据从现有行回填：老库没有 vector_buckets，不能因为缺元数据就把已有向量判成不可用。
	if _, err := tx.Exec(`INSERT OR IGNORE INTO vector_buckets (fingerprint, dims, ready, build_id, updated_at)
		SELECT fingerprint, MAX(dims), 1, '', MAX(updated_at) FROM vectors GROUP BY fingerprint`); err != nil {
		_ = tx.Rollback()
		return false, err
	}

	// FTS5 表单独处理：tokenizer 没注册上时这条必然失败，此时保留其余表并退化为 LIKE，
	// 而不是让整个索引打不开。
	fts := state.ftsReady
	if fts {
		_, createErr := tx.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
			id UNINDEXED,
			content,
			summary,
			tokenize='` + bigramTokenizerName + `'
		)`)
		if createErr != nil {
			fts = false
			state.ftsErr = createErr
		}
	}
	if !fts && state.ftsErr != nil && log != nil {
		log.Warnf("Memory", "FTS5 不可用，记忆搜索退化为 LIKE：%v", state.ftsErr)
	}
	// v2 → v3：给已存在的 memory_items 补 meta 列。CREATE IF NOT EXISTS 不会改旧表，
	// 必须显式 ALTER；列已在时跳过，保证迁移可重复执行。
	if version < 3 {
		hasMeta := false
		colRows, colErr := tx.Query(`PRAGMA table_info(memory_items)`)
		if colErr == nil {
			for colRows.Next() {
				var cid, notnull, pk int
				var name, ctype string
				var dflt any
				if scanErr := colRows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); scanErr == nil && name == "meta" {
					hasMeta = true
				}
			}
			colRows.Close()
		}
		if !hasMeta {
			if _, err := tx.Exec(`ALTER TABLE memory_items ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'`); err != nil {
				_ = tx.Rollback()
				return false, err
			}
		}
	}

	ftsValue := "off"
	if fts {
		ftsValue = bigramTokenizerName
	}
	if _, err := tx.Exec(
		`INSERT INTO schema_meta (key, value) VALUES ('memory_fts', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, ftsValue); err != nil {
		_ = tx.Rollback()
		return false, err
	}
	// 全文索引可能与主表脱节（上次分词器不可用时写入过、或库被外部改过）。
	// 用「行数 + 最新更新时间」当签名，对不上就整表重建 —— 3000 行重建是毫秒级，
	// 比让用户搜不到东西划算。
	if fts {
		var live, stored string
		if err := tx.QueryRow(
			`SELECT COALESCE(COUNT(*), 0) || ':' || COALESCE(MAX(updated_at), 0) FROM memory_items`,
		).Scan(&live); err != nil {
			_ = tx.Rollback()
			return false, err
		}
		if err := tx.QueryRow(`SELECT value FROM schema_meta WHERE key = 'memory_fts_sync'`).Scan(&stored); err != nil &&
			err != sql.ErrNoRows {
			_ = tx.Rollback()
			return false, err
		}
		if stored != live {
			for _, stmt := range []string{
				`DELETE FROM memory_fts`,
				`INSERT INTO memory_fts (id, content, summary) SELECT id, content, summary FROM memory_items`,
			} {
				if _, err := tx.Exec(stmt); err != nil {
					_ = tx.Rollback()
					return false, err
				}
			}
			if _, err := tx.Exec(
				`INSERT INTO schema_meta (key, value) VALUES ('memory_fts_sync', ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, live); err != nil {
				_ = tx.Rollback()
				return false, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	if _, err := db.Exec(fmt.Sprintf("PRAGMA user_version = %d", schemaVersion)); err != nil {
		return false, err
	}
	return fts, nil
}

// migrateVectorsV4 把旧的 id 单主键表改成 (fingerprint, id) 复合主键。
// 可重入：上次若停在 rename 之后，先把 vectors_v3 恢复成 vectors 再重跑。
func migrateVectorsV4(tx *sql.Tx) error {
	if ok, err := tableExistsTx(tx, "vectors_v3"); err != nil {
		return err
	} else if ok {
		if _, err := tx.Exec(`DROP TABLE IF EXISTS vectors`); err != nil {
			return err
		}
		if _, err := tx.Exec(`ALTER TABLE vectors_v3 RENAME TO vectors`); err != nil {
			return err
		}
	}
	legacy, err := vectorsHasLegacyPrimaryKey(tx)
	if err != nil || !legacy {
		return err
	}
	if _, err := tx.Exec(`ALTER TABLE vectors RENAME TO vectors_v3`); err != nil {
		return err
	}
	if _, err := tx.Exec(`CREATE TABLE vectors (
		fingerprint TEXT NOT NULL,
		id TEXT NOT NULL,
		dims INTEGER NOT NULL,
		hash TEXT NOT NULL,
		vec BLOB NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (fingerprint, id)
	)`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO vectors (fingerprint, id, dims, hash, vec, updated_at)
		SELECT fingerprint, id, dims, hash, vec, updated_at FROM vectors_v3`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DROP TABLE vectors_v3`); err != nil {
		return err
	}
	for _, stmt := range []string{
		`CREATE INDEX IF NOT EXISTS vectors_fp ON vectors(fingerprint)`,
		`CREATE INDEX IF NOT EXISTS vectors_id ON vectors(id)`,
	} {
		if _, err := tx.Exec(stmt); err != nil {
			return err
		}
	}
	return nil
}

func tableExistsTx(tx *sql.Tx, name string) (bool, error) {
	var found string
	err := tx.QueryRow(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&found)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return found == name, nil
}

// vectorsHasLegacyPrimaryKey 读表信息判断主键形态：旧表 id 是唯一主键，新表 fingerprint 在 PK 第一位。
func vectorsHasLegacyPrimaryKey(tx *sql.Tx) (bool, error) {
	rows, err := tx.Query(`PRAGMA table_info(vectors)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	idPK, fpPK := 0, 0
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt any
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		switch name {
		case "id":
			idPK = pk
		case "fingerprint":
			fpPK = pk
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return idPK > 0 && fpPK == 0, nil
}

// Close 先 checkpoint 把 WAL 收回主库，再关连接；错误只影响收尾，不再向上抛。
func (s *Store) Close() {
	if s == nil || s.db == nil {
		return
	}
	_, _ = s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	_ = s.db.Close()
	s.db = nil
}

func (s *Store) available() bool {
	return s != nil && s.db != nil
}

// FTSTokenizer 返回全文索引当前使用的分词器名；"off" 表示退化为 LIKE。
func (s *Store) FTSTokenizer() string {
	if s == nil || !s.fts {
		return "off"
	}
	return bigramTokenizerName
}
