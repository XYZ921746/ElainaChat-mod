package agent

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// CheckMutable 的回归：写/删必须与读同一道边界。
//
// 只封读不封写时，data/ 里的访问密码、会话签名密钥、吊销代数都能被 AI 覆盖 ——
// 改密码与删库在效果上是同一件事（都能把用户锁在外面），而「禁止删除」档位
// 只挡住了后者。这组用例守着这条边界不被"某个档位需要写"重新放开。
func TestCheckMutableBlocksDataDir(t *testing.T) {
	appRoot := t.TempDir()
	dataDir := filepath.Join(appRoot, "data")
	if err := os.MkdirAll(filepath.Join(dataDir, "main"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := &Handler{appRoot: appRoot, dataDir: dataDir}

	protected := []string{
		filepath.Join(dataDir, "config.json"),   // 访问密码
		filepath.Join(dataDir, "session-key"),   // 会话签名密钥
		filepath.Join(dataDir, "session-epoch"), // 吊销代数
		filepath.Join(dataDir, "key.pem"),       // HTTPS 私钥
		filepath.Join(dataDir, "main", "store.json"),
		filepath.Join(dataDir, "main", "memory", "index.db"),
	}
	for _, target := range protected {
		if err := h.CheckMutable(target); err == nil {
			t.Errorf("应拒绝写入/删除 %s", target)
		}
		// 读侧的边界必须与写侧一致：两条边界不同步时，缺口会从较松的那侧漏出来。
		if err := h.CheckReadable(target); err == nil {
			t.Errorf("应拒绝读取 %s", target)
		}
	}

	// 数据目录之外的用户文件不受影响 —— AI 的正常工作面是用户的工作文件。
	outside := []string{
		filepath.Join(appRoot, "notes.txt"),
		filepath.Join(appRoot, "web", "index.html"),
		filepath.Join(filepath.Dir(appRoot), "elsewhere.json"),
	}
	for _, target := range outside {
		if err := h.CheckMutable(target); err != nil {
			t.Errorf("不应拦截数据目录外的 %s：%v", target, err)
		}
	}
}

// full 档同样不豁免：档位管的是"AI 能碰用户的哪些文件"，
// 而 data/ 是应用自己的运行数据，不属于用户工作面。
func TestCheckMutableHasNoAccessExemption(t *testing.T) {
	appRoot := t.TempDir()
	dataDir := filepath.Join(appRoot, "data")
	h := &Handler{appRoot: appRoot, dataDir: dataDir}
	target := filepath.Join(dataDir, "config.json")

	if _, _, err := h.Write(target, "pwned", "full", true); err == nil {
		t.Error("full 档也不应允许写 data/config.json")
	}
	if _, _, _, err := h.Delete(target, "full", true); err == nil {
		t.Error("full 档也不应允许删 data/config.json")
	}
}

// 写入必须真的没落盘：接口返回错误但文件已被改写，等于边界没生效。
func TestWriteToDataDirDoesNotTouchDisk(t *testing.T) {
	appRoot := t.TempDir()
	dataDir := filepath.Join(appRoot, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dataDir, "config.json")
	const original = `{"password":"ORIGINAL"}`
	if err := os.WriteFile(target, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	h := &Handler{appRoot: appRoot, dataDir: dataDir}

	if _, _, err := h.Write(target, "PWNED", "auto", true); err == nil {
		t.Fatal("写入应被拒绝")
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != original {
		t.Fatalf("文件内容被改写：%q", string(raw))
	}
}

// 目录链接把受保护文件包装成普通路径时，字符串比较看不出差别；读写两侧都必须解析真实位置。
func TestCheckProtectsThroughDirectoryLink(t *testing.T) {
	appRoot := t.TempDir()
	dataDir := filepath.Join(appRoot, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(dataDir, "config.json")
	if err := os.WriteFile(secret, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(appRoot, "work")
	makeDirLink(t, link, dataDir)
	h := &Handler{appRoot: appRoot, dataDir: dataDir}
	target := filepath.Join(link, "config.json")

	if err := h.CheckReadable(target); err == nil {
		t.Error("经目录链接读取 data/ 应被拒绝")
	}
	if err := h.CheckMutable(target); err == nil {
		t.Error("经目录链接写入 data/ 应被拒绝")
	}
	if _, _, err := h.Write(target, "changed", "full", true); err == nil {
		t.Error("full 档也不应经链接写 data/")
	}
	if got, _ := os.ReadFile(secret); string(got) != "original" {
		t.Errorf("受保护文件被改写：%q", got)
	}
}

func TestResolveWorkingDirRejectsLinkedDataDir(t *testing.T) {
	appRoot := t.TempDir()
	dataDir := filepath.Join(appRoot, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(appRoot, "work")
	makeDirLink(t, link, dataDir)
	h := &Handler{appRoot: appRoot, dataDir: dataDir}
	if _, err := h.ResolveWorkingDir(link); err == nil {
		t.Error("工作目录经链接落到 data/ 时应拒绝")
	}
}

// 8.3 短名与 dataDir 字符串前缀不相干（ZSHORT~1 ≠ 长目录名），却指向同一个目录 ——
// 写入目标在创建前不存在、RealPath 打不开文件本身，边界必须靠「最深现存祖先」的解析兜住。
// 卷禁用 8.3 名生成时（GetShortPathNameW 拿不到短名）跳过，不判红。
func TestCheckMutableBlocksShortNameDataDir(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("8.3 短名只在 Windows 上存在")
	}
	appRoot := t.TempDir()
	dataDir := filepath.Join(appRoot, "long-directory-name-for-alias-data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(dataDir, "config.json")
	if err := os.WriteFile(secret, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	short := shortPathName(t, dataDir)
	if short == "" || strings.EqualFold(short, dataDir) {
		t.Skip("该卷未启用 8.3 短名生成")
	}
	h := &Handler{appRoot: appRoot, dataDir: dataDir}
	// 已存在的受保护文件经短名读 / 写，都必须被拒。
	if err := h.CheckReadable(filepath.Join(short, "config.json")); err == nil {
		t.Error("经 8.3 短名读取 data/ 应被拒绝")
	}
	if err := h.CheckMutable(filepath.Join(short, "config.json")); err == nil {
		t.Error("经 8.3 短名覆盖 data/ 应被拒绝")
	}
	// 尚不存在的目标（写入发生在创建前）同样要被拒：这是当初字符串前缀比较漏掉的形态。
	if err := h.CheckMutable(filepath.Join(short, "config2.json")); err == nil {
		t.Error("经 8.3 短名向 data/ 新建文件应被拒绝")
	}
	if got, _ := os.ReadFile(secret); string(got) != "original" {
		t.Errorf("受保护文件被改写：%q", got)
	}
}

func shortPathName(t *testing.T, long string) string {
	t.Helper()
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	getShort := kernel32.NewProc("GetShortPathNameW")
	buf := make([]uint16, 1024)
	n, _, _ := getShort.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(long))), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf[:n])
}

func makeDirLink(t *testing.T, link, target string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err == nil {
			return
		} else if err := os.Symlink(target, link); err != nil {
			t.Skipf("无法创建目录链接：%v（%s）", err, out)
		}
		return
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("无法创建目录链接：%v", err)
	}
}
