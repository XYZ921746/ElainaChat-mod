package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// 会话凭据是自包含的签名 token，而不是「服务端记住一张表」。
//
// 为什么必须无状态：同一台机器可以同时跑多个实例（不同端口 / 不同数据目录），
// 浏览器对 cookie 的隔离维度是「名字 + 域」，端口不参与。若凭据只是服务端内存表里的一串随机数，
// 两个实例会共用同一个 cookie 名而互相覆盖，表现为「登了 A 就掉 B」。
// 签名 token 让每个实例只认自己密钥签出的凭据，浏览器里可以同时存在多个互不干扰的会话。
//
// 为什么不是纯 JWT 那样不可吊销：改密码必须让所有设备立刻失效。
// 所以 payload 里带 epoch，改密时 epoch+1，旧 token 全部作废——
// 这比「换签名密钥」精确，也比「删除会话表」省掉一份磁盘状态。
const (
	// tokenPrefix 是格式版本。改 payload 结构时递增，旧 token 自然失效而不是被误解析。
	tokenPrefix = "elaina1"

	// SessionCookie 是无实例后缀的 cookie 名。它只用于下发清理指令：
	// 无后缀的名字会被同一域下的所有实例共用，多实例并存时必须让它失效。
	SessionCookie = "elaina_session"
	// SessionCookiePrefix 是当前 cookie 名的前缀，完整名字 = 前缀 + 实例 ID。
	// 实例后缀让同一域下的多个实例各自持有一份 cookie，互不覆盖。
	SessionCookiePrefix = "elaina_session_"
)

// ErrTokenInvalid 覆盖签名不符、格式错误、实例不匹配三种情况：
// 对调用方来说它们是同一个结论（这个凭据不能用），分开报只会泄漏是哪一步失败。
var ErrTokenInvalid = errors.New("会话凭据无效")

// tokenPayload 是签名覆盖的内容。字段名取短名以压缩 cookie 体积（浏览器对单 cookie 有 4KB 上限）。
type tokenPayload struct {
	Inst  string `json:"i"` // 签发实例：跨实例的 token 必须被拒，否则多实例又变成一套凭据
	Epoch int64  `json:"e"` // 吊销代数：改密码时递增，旧 token 随之失效
	Exp   int64  `json:"x"` // 过期时间（Unix 毫秒）
}

// instanceState 是随数据目录走的实例身份：实例 ID 与签名密钥。
// 跟着 DATA_DIR 而不是端口或监听地址，因为端口会被用户改，改了不该让所有人重登。
type instanceState struct {
	ID     string
	Secret []byte
}

const (
	instanceIDFile = "instance-id"
	secretFile     = "session-key"
	epochFile      = "session-epoch"
)

// loadOrCreateInstance 读取实例身份；缺失时生成并落盘。
// 读失败不阻断启动：内存里现生成一份仍能工作，只是重启后旧会话失效——
// 把用户锁在门外比要求重新登录更糟，但直接崩掉更糟。
func loadOrCreateInstance(dataDir string) instanceState {
	return instanceState{
		ID:     loadOrCreateHex(dataDir, instanceIDFile, 8),
		Secret: loadOrCreateSecret(dataDir),
	}
}

func loadOrCreateHex(dir, name string, bytes int) string {
	path := filepath.Join(dir, name)
	if raw, err := os.ReadFile(path); err == nil {
		if v := strings.TrimSpace(string(raw)); v != "" {
			return v
		}
	}
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		// 熵源不可用时退回时间派生：实例 ID 只用于区分实例，不是安全边界（安全由 Secret 承担）。
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))[:bytes*2]
	}
	v := hex.EncodeToString(buf)
	writeInstanceFile(path, v)
	return v
}

func loadOrCreateSecret(dir string) []byte {
	path := filepath.Join(dir, secretFile)
	if raw, err := os.ReadFile(path); err == nil {
		if v := strings.TrimSpace(string(raw)); v != "" {
			if decoded, decErr := hex.DecodeString(v); decErr == nil && len(decoded) >= 16 {
				return decoded
			}
		}
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return []byte(time.Now().Format(time.RFC3339Nano))
	}
	writeInstanceFile(path, hex.EncodeToString(buf))
	return buf
}

// writeInstanceFile 用 0600 落盘：签名密钥泄漏等于任何人可伪造会话。
func writeInstanceFile(path, value string) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(path, []byte(value), 0o600)
}

func (s *Store) signToken(exp time.Time) (string, error) {
	payload := tokenPayload{Inst: s.inst.ID, Epoch: s.Epoch(), Exp: exp.UnixMilli()}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encoded := hex.EncodeToString(body)
	return tokenPrefix + "." + encoded + "." + hex.EncodeToString(s.mac(encoded)), nil
}

// mac 对 payload 的 hex 文本签名：签名覆盖编码后的字节，避免「解码歧义」导致的验签绕过。
func (s *Store) mac(encoded string) []byte {
	h := hmac.New(sha256.New, s.inst.Secret)
	h.Write([]byte(tokenPrefix))
	h.Write([]byte("."))
	h.Write([]byte(encoded))
	return h.Sum(nil)
}

// verifyToken 校验签名、实例归属、吊销代数与过期时间。
func (s *Store) verifyToken(token string) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != tokenPrefix {
		return ErrTokenInvalid
	}
	want := s.mac(parts[1])
	got, err := hex.DecodeString(parts[2])
	if err != nil || len(got) != len(want) {
		return ErrTokenInvalid
	}
	// 定长比较：长度已在上面确认，这里只防「逐字节提前返回」泄漏签名前缀。
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return ErrTokenInvalid
	}
	body, err := hex.DecodeString(parts[1])
	if err != nil {
		return ErrTokenInvalid
	}
	var payload tokenPayload
	if json.Unmarshal(body, &payload) != nil {
		return ErrTokenInvalid
	}
	// 实例不匹配必须拒：否则同一份密钥被两个实例共用时（用户手工拷贝 data/），
	// 一个实例的登录会在另一个实例上生效，与「每实例独立会话」的语义相反。
	if payload.Inst != s.inst.ID {
		return ErrTokenInvalid
	}
	if payload.Epoch != s.Epoch() {
		return ErrTokenInvalid
	}
	if time.Now().UnixMilli() > payload.Exp {
		return ErrTokenInvalid
	}
	return nil
}

// SessionCookieName 返回本实例的 cookie 名。带实例后缀是关键：
// 浏览器对 cookie 的隔离不含端口，同名 cookie 在同一域下会互相覆盖。
func (s *Store) SessionCookieName() string {
	return SessionCookiePrefix + s.inst.ID
}

// InstanceID 供日志与状态接口使用。
func (s *Store) InstanceID() string { return s.inst.ID }

// Epoch 返回当前吊销代数。
func (s *Store) Epoch() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.epoch
}

// loadEpoch 读取持久化的吊销代数。缺失按 0 处理：全新数据目录没有旧 token 需要作废。
func (s *Store) loadEpoch() int64 {
	raw, err := os.ReadFile(filepath.Join(s.dataDir, epochFile))
	if err != nil {
		return 0
	}
	var v int64
	parsed, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil || parsed < 0 {
		return 0
	}
	v = parsed
	return v
}

// bumpEpoch 递增吊销代数并落盘：落盘失败也要让内存里的值生效，
// 否则改密码后旧 token 在本进程内仍然可用（这是安全语义，不能因为磁盘问题让步）。
func (s *Store) bumpEpoch() error {
	s.mu.Lock()
	s.epoch++
	next := s.epoch
	s.mu.Unlock()
	if err := os.MkdirAll(s.dataDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.dataDir, epochFile), []byte(strconv.FormatInt(next, 10)), 0o600)
}
