package auth

import (
	"encoding/hex"
	"os"
	"strings"
	"testing"

	"golang.org/x/crypto/scrypt"
)

// RFC 7914 §12 的公开向量用来钉住 scrypt 原语本身。
// 与 Node 的互通另有约束：salt 必须按 hex 字符串的 UTF-8 字节参与计算（见 hashPassword），
// 这条在跨语言联调时用 Node 的 crypto.scrypt 对同一 salt 校验过。
func TestScryptRFC7914Vector(t *testing.T) {
	want := "fdba be1c 9d34 7200 7856 e719 0d01 e9fe 7c6a d7cb c823 7830 e773 7663" +
		"4b37 3162 2eaf 30d9 2e22 a388 6ff1 0927 9d98 30da c727 afb9 4a83 ee6d" +
		"8360 cbdf a2cc 0640"
	key, err := scrypt.Key([]byte("password"), []byte("NaCl"), 1024, 8, 16, 64)
	if err != nil {
		t.Fatalf("scrypt.Key 失败：%v", err)
	}
	if got := hex.EncodeToString(key); got != normalizeHex(want) {
		t.Fatalf("scrypt 结果与 RFC 7914 不一致\n got=%s\nwant=%s", got, normalizeHex(want))
	}
}

func TestSetPasswordRoundTrip(t *testing.T) {
	// 测试口令在运行期拼出来，不在源码里放任何可被误认成真实密码的字面量。
	testPwd := strings.Repeat("Test", 2) + "9xQ"
	wrongPwd := testPwd + "Zz9"

	dir := t.TempDir()
	store := NewStore(dir, dir+"/legacy.json", nil)
	if _, err := store.Ensure(); err != nil {
		t.Fatalf("Ensure 失败：%v", err)
	}
	if store.HasAccessPassword() {
		t.Fatal("全新数据目录不应视为已设置密码")
	}
	if err := store.SetPassword(testPwd); err != nil {
		t.Fatalf("SetPassword 失败：%v", err)
	}
	if !store.HasAccessPassword() {
		t.Fatal("设置密码后应视为已配置")
	}
	if !store.VerifyPassword(testPwd) {
		t.Fatal("刚设置的密码应可校验")
	}
	if store.VerifyPassword(wrongPwd) {
		t.Fatal("错误密码不应通过")
	}

	// 重新加载一次：落盘格式必须能被自己读回，否则重启就会把用户锁在门外。
	reloaded := NewStore(dir, dir+"/legacy.json", nil)
	if _, err := reloaded.Ensure(); err != nil {
		t.Fatalf("重新加载失败：%v", err)
	}
	if !reloaded.VerifyPassword(testPwd) {
		t.Fatal("重启后密码应仍然有效")
	}
}

// 签名 token 的语义：自己能验、篡改必失效、改密后旧 token 作废、
// 换一个实例（不同数据目录 → 不同密钥）不认别人的 token。
func TestSessionTokenLifecycle(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir, dir+"/legacy.json", nil)
	if _, err := store.Ensure(); err != nil {
		t.Fatal(err)
	}
	if err := store.SetPassword(strings.Repeat("Pwd", 2) + "5tW"); err != nil {
		t.Fatal(err)
	}

	token, err := store.NewSession()
	if err != nil || token == "" {
		t.Fatalf("签发会话失败：%v", err)
	}
	if !store.HasValidSession(token) {
		t.Fatal("刚签发的 token 应有效")
	}

	// 篡改 payload 或签名都必须失效：签名覆盖整段内容。
	if store.HasValidSession(token + "0") {
		t.Fatal("追加字符的 token 不应通过")
	}
	tampered := "x" + token[1:]
	if store.HasValidSession(tampered) {
		t.Fatal("改动首字符的 token 不应通过")
	}

	// 换一个数据目录＝另一个实例：密钥与实例 ID 都不同，不能认别人的 token。
	other := NewStore(t.TempDir(), "", nil)
	if _, err := other.Ensure(); err != nil {
		t.Fatal(err)
	}
	if other.HasValidSession(token) {
		t.Fatal("另一个实例不应接受本实例签发的 token")
	}

	// 改密让所有已签发 token 失效。
	if err := store.ClearSessions(); err != nil {
		t.Fatal(err)
	}
	if store.HasValidSession(token) {
		t.Fatal("ClearSessions 后旧 token 应失效")
	}
	// 但新签发的仍可用：吊销靠代数，不靠永久锁死。
	fresh, err := store.NewSession()
	if err != nil || !store.HasValidSession(fresh) {
		t.Fatalf("改密后新签发的 token 应有效：%v", err)
	}
}

// 实例 ID 跟着数据目录走，重启后必须稳定，否则每次重启都让所有人重登。
func TestInstanceIDIsStable(t *testing.T) {
	dir := t.TempDir()
	first := NewStore(dir, "", nil)
	second := NewStore(dir, "", nil)
	if first.SessionCookieName() != second.SessionCookieName() {
		t.Fatalf("同一数据目录的 cookie 名必须稳定：%q vs %q",
			first.SessionCookieName(), second.SessionCookieName())
	}
	if first.SessionCookieName() == NewStore(t.TempDir(), "", nil).SessionCookieName() {
		t.Fatal("不同数据目录应有不同的 cookie 名（多实例互不覆盖）")
	}
}

func normalizeHex(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == ' ' || s[i] == '\n' || s[i] == '\t' {
			continue
		}
		out = append(out, s[i])
	}
	return string(out)
}

func TestSetPasswordInMemoryDropsPasswordFile(t *testing.T) {
	// 测试口令在运行期拼出来，不在源码里放任何可被误认成真实密码的字面量。
	testPwd := strings.Repeat("Pass", 2) + "7kR"
	dir := t.TempDir()
	legacy := dir + "/legacy.json"
	store := NewStore(dir, legacy, nil)
	if _, err := store.Ensure(); err != nil {
		t.Fatal(err)
	}
	// 先落一份旧文件，再走内存路径：旧文件必须被删掉。
	if err := store.SetPassword("FirstPass1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(store.AuthFile()); err != nil {
		t.Fatalf("前置：auth.json 应存在：%v", err)
	}

	if err := store.SetPasswordInMemory(testPwd); err != nil {
		t.Fatal(err)
	}
	if !store.HasAccessPassword() || !store.VerifyPassword(testPwd) {
		t.Fatal("内存凭据应立即生效")
	}
	if _, err := os.Stat(store.AuthFile()); !os.IsNotExist(err) {
		t.Fatalf("auth.json 应被删除：%v", err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("遗留密码文件也应被删除：%v", err)
	}

	// 会话不动是硬约束：启动路径在 LoadSessions 之前调用，清了会把已有会话全冲掉。
	// 这里只验证 NewSession 仍能正常签发（内存态完好），会话清空语义由 ClearSessions 用例覆盖。
	if token, err := store.NewSession(); err != nil || token == "" {
		t.Fatalf("内存态异常：签发会话失败：%v", err)
	}
}

func TestClearSessionsDropsAll(t *testing.T) {
	testPwd := strings.Repeat("Pwd", 2) + "5tW"
	dir := t.TempDir()
	store := NewStore(dir, dir+"/legacy.json", nil)
	if _, err := store.Ensure(); err != nil {
		t.Fatal(err)
	}
	if err := store.SetPassword(testPwd); err != nil {
		t.Fatal(err)
	}
	token, err := store.NewSession()
	if err != nil || token == "" {
		t.Fatalf("前置：签发会话失败：%v", err)
	}
	if !store.HasValidSession(token) {
		t.Fatal("前置：会话应有效")
	}
	if err := store.ClearSessions(); err != nil {
		t.Fatal(err)
	}
	if store.HasValidSession(token) {
		t.Fatal("ClearSessions 后会话应失效")
	}
}
