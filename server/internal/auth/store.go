// Package auth 负责访问密码与登录会话。密码记录读 data/auth.json（旧形态）与
// data/config.json 的 password 字段（新形态）；会话凭据是 HMAC 签名的自包含 token，
// 不再落 sessions.json —— 原因见 token.go 顶部说明。
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"elainachat/server/internal/logx"

	"golang.org/x/crypto/scrypt"
)

const (
	SessionTTL = 7 * 24 * time.Hour
)

// 与 Node crypto.scrypt 的默认参数一致；salt 按 hex 字符串的 UTF-8 字节参与计算，
// 不是解码后的 16 字节，改错会导致已有密码全部失效。
const (
	scryptN = 16384
	scryptR = 8
	scryptP = 1
	scryptK = 64
)

type Auth struct {
	IsDefault bool   `json:"isDefault"`
	Password  string `json:"password,omitempty"`
	Salt      string `json:"salt,omitempty"`
	Hash      string `json:"hash,omitempty"`
	CreatedAt string `json:"createdAt,omitempty"`
	ChangedAt string `json:"changedAt,omitempty"`
}

type Store struct {
	mu sync.RWMutex

	dataDir    string
	authPath   string
	legacyPath string
	log        *logx.Logger

	inst instanceState
	// epoch 是吊销代数：改密码时递增，旧 token 因代数不匹配而失效。
	// 它替代了原先「清空会话表」的做法，且不需要在磁盘上维护一张会过期的表。
	epoch int64

	auth *Auth
}

func NewStore(dataDir, legacyAuthPath string, log *logx.Logger) *Store {
	s := &Store{
		dataDir:    dataDir,
		authPath:   filepath.Join(dataDir, "auth.json"),
		legacyPath: legacyAuthPath,
		log:        log,
		inst:       loadOrCreateInstance(dataDir),
	}
	s.epoch = s.loadEpoch()
	return s
}

func (s *Store) AuthFile() string { return s.authPath }

// Ensure 在启动时准备密码记录。默认状态是「尚未设置」：局域网设备只认用户主动设置的密码，
// 不生成随机默认密码——没人设置过的随机串只会在界面上误导用户。
func (s *Store) Ensure() (isDefault bool, err error) {
	a, err := s.loadAuth()
	if err != nil {
		return false, err
	}
	if a != nil && (!a.IsDefault || (a.Salt != "" && a.Hash != "")) {
		s.mu.Lock()
		s.auth = a
		s.mu.Unlock()
		return false, nil
	}
	createdAt := time.Now().UTC().Format(time.RFC3339Nano)
	if a != nil && a.CreatedAt != "" {
		createdAt = a.CreatedAt
	}
	if a == nil || !a.IsDefault || a.Password != "" {
		a = &Auth{IsDefault: true, CreatedAt: createdAt}
		if saveErr := s.saveAuth(a); saveErr != nil {
			return true, saveErr
		}
	}
	s.mu.Lock()
	s.auth = a
	s.mu.Unlock()
	return true, nil
}

func (s *Store) loadAuth() (*Auth, error) {
	raw, err := os.ReadFile(s.authPath)
	if err == nil {
		var a Auth
		if json.Unmarshal(raw, &a) == nil {
			return &a, nil
		}
	}
	// 一次性迁移：老位置有就搬到新位置；搬不动也不能让用户被锁在门外，退回用老内容继续跑。
	legacyRaw, legacyErr := os.ReadFile(s.legacyPath)
	if legacyErr != nil {
		return nil, nil
	}
	var legacy Auth
	if json.Unmarshal(legacyRaw, &legacy) != nil {
		return nil, nil
	}
	if mkErr := os.MkdirAll(s.dataDir, 0o755); mkErr == nil {
		if renameErr := os.Rename(s.legacyPath, s.authPath); renameErr == nil && s.log != nil {
			s.log.Infof("Auth", "访问密码文件已迁移：web/.local-auth.json → data/auth.json")
		}
	}
	return &legacy, nil
}

func (s *Store) saveAuth(a *Auth) error {
	if err := os.MkdirAll(s.dataDir, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.authPath, raw, 0o600)
}

// HasAccessPassword 判断用户是否主动设置过密码。缺少 isDefault 字段的老记录看 salt/hash。
func (s *Store) HasAccessPassword() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.auth == nil {
		return false
	}
	if !s.auth.IsDefault {
		return true
	}
	return s.auth.Salt != "" && s.auth.Hash != ""
}

// AuthStatus 是 /api/auth/status 的公开部分；真实路径只回给本机管理员。
func (s *Store) AuthStatus() (isDefault bool, hint string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.auth == nil {
		return true, ""
	}
	return s.auth.IsDefault, s.auth.Password
}

func (s *Store) VerifyPassword(password string) bool {
	s.mu.RLock()
	a := s.auth
	s.mu.RUnlock()
	if a == nil {
		return false
	}
	if a.IsDefault && a.Password != "" {
		return safeEqualText(password, a.Password)
	}
	if a.Salt != "" && a.Hash != "" {
		got, err := hashPassword(password, a.Salt)
		if err != nil {
			return false
		}
		return safeEqualHex(got, a.Hash)
	}
	return false
}

// SetPassword 会清空所有会话：改密码的语义就是让所有已登录设备重新登录。
// 哈希照旧落 auth.json —— 这是「密码文件」形态的写入路径。
func (s *Store) SetPassword(next string) error {
	a, err := newAuthRecord(next)
	if err != nil {
		return err
	}
	if err := s.saveAuth(a); err != nil {
		return err
	}
	s.adoptAuthRecord(a)
	return s.ClearSessions()
}

// SetPasswordInMemory 只更新内存凭据并删除 auth.json / 旧位置文件，不动会话：
// 密码的持久形态换成 data/config.json 的 password 字段（由调用方负责写入），
// 磁盘上不再保留哈希文件；会话的清理由调用方按语义决定（改密清、启动不清）。
func (s *Store) SetPasswordInMemory(next string) error {
	a, err := newAuthRecord(next)
	if err != nil {
		return err
	}
	s.adoptAuthRecord(a)
	for _, path := range []string{s.authPath, s.legacyPath} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// ClearSessions 让所有已签发凭据失效：改密码的语义就是让所有已登录设备重新登录。
// 实现是递增吊销代数，不是清一张表——token 是自包含的，服务端没有表可清。
func (s *Store) ClearSessions() error {
	return s.bumpEpoch()
}

func newAuthRecord(next string) (*Auth, error) {
	saltBytes := make([]byte, 16)
	if _, err := rand.Read(saltBytes); err != nil {
		return nil, err
	}
	salt := hex.EncodeToString(saltBytes)
	hash, err := hashPassword(next, salt)
	if err != nil {
		return nil, err
	}
	return &Auth{IsDefault: false, Salt: salt, Hash: hash, ChangedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
}

func (s *Store) adoptAuthRecord(a *Auth) {
	s.mu.Lock()
	s.auth = a
	s.mu.Unlock()
}

func hashPassword(password, salt string) (string, error) {
	key, err := scrypt.Key([]byte(password), []byte(salt), scryptN, scryptR, scryptP, scryptK)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(key), nil
}

// safeEqualText 先做定长摘要再比较：直接比长度会泄漏「前几位对了」的信息。
func safeEqualText(a, b string) bool {
	ha := sha256.Sum256([]byte(a))
	hb := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}

func safeEqualHex(a, b string) bool {
	ba, errA := hex.DecodeString(a)
	bb, errB := hex.DecodeString(b)
	if errA != nil || errB != nil || len(ba) == 0 || len(ba) != len(bb) {
		return false
	}
	return subtle.ConstantTimeCompare(ba, bb) == 1
}

func (s *Store) NewSession() (string, error) {
	return s.NewSessionWithTTL(SessionTTL)
}

// NewSessionWithTTL 按调用方给出的寿命发会话。
func (s *Store) NewSessionWithTTL(ttl time.Duration) (string, error) {
	return s.signToken(time.Now().Add(ttl))
}

// HasValidSession 校验签名、实例归属、吊销代数与过期时间。
// 全程不碰磁盘：这是无状态凭据的意义，多实例并发校验不会互相争一把文件锁。
func (s *Store) HasValidSession(token string) bool {
	return s.verifyToken(token) == nil
}

