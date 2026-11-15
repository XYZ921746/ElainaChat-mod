package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// blockedWriteTarget 的穷举表：应用文件夹内的可执行扩展名一律不许写（防同源代码注入）。
// 黑名单的形状与 zipx 的解压黑名单同源，但判定各自独立 —— 写入路径拦截必须自己有回归保护。
//
// 判定取「最终落盘名」的扩展名（zipx.EffectiveExt）：NTFS 流名与尾点/尾空格都绕不过去。
func TestBlockedWriteTargetExtensionTable(t *testing.T) {
	h := &Handler{appRoot: t.TempDir()}

	mustBlock := []string{
		"x.html", "x.HTML", "x.htm", "x.xhtml", "x.shtml", "x.hta", "x.mhtml",
		"x.js", "x.mjs", "x.cjs", "x.jsx", "x.ts",
		"x.svg", "x.xml", "x.xsl",
		"x.exe", "x.dll", "x.com", "x.scr", "x.msi", "x.bat", "x.cmd",
		"x.ps1", "x.psm1", "x.vbs", "x.wsf", "x.jar", "x.sh",
		// 最终落盘名仍是可执行类型的变体：尾点 / 尾空格 / NTFS 流名
		"x.html.", "x.html ", "x.html. ",
		"x.html::$DATA", "x.HTML::$DATA", "x.js::$DATA", "x.svg::$DATA",
		"x.html:ads.txt",
	}
	for _, name := range mustBlock {
		target := filepath.Join(h.appRoot, "web", name)
		if !h.blockedWriteTarget(target, "strict") {
			t.Errorf("应拦截 %q（access=strict）", name)
		}
	}

	mustPass := []string{"note.txt", "a.md", "data.json", "x.csv", "readme", "中文名.txt", "a.b.txt"}
	for _, name := range mustPass {
		target := filepath.Join(h.appRoot, "web", name)
		if h.blockedWriteTarget(target, "strict") {
			t.Errorf("应放行 %q（数据文件不在黑名单里）", name)
		}
	}
}

// 黑名单只管应用文件夹内：外面的 .html 是用户自己的磁盘，AI 本来就可以写（由权限档位管）；
// full 档连应用文件夹内都放行 —— 档位语义是"用户已知情并担责"。
func TestBlockedWriteTargetScope(t *testing.T) {
	h := &Handler{appRoot: t.TempDir()}

	outside := filepath.Join(filepath.Dir(h.appRoot), "outside.html")
	if h.blockedWriteTarget(outside, "strict") {
		t.Error("应用文件夹外的 .html 不应被写入黑名单拦截")
	}
	inside := filepath.Join(h.appRoot, "web", "x.html")
	if h.blockedWriteTarget(inside, "full") {
		t.Error("full 档不受写入黑名单约束")
	}
	if !h.blockedWriteTarget(filepath.Join(h.appRoot, "web", "x.html"), "auto") ||
		!h.blockedWriteTarget(filepath.Join(h.appRoot, "web", "x.html"), "off") {
		t.Error("strict / auto / off 档都应受写入黑名单约束")
	}
}

// 端到端走一遍 Write：拦截要有明确报错、合法文件要真的落盘。
// 相对路径的尾点 / 尾空格 / 尾点加空格经 Abs 归一成基础名后正好落进黑名单 ——
// 这条是 Windows 上"文件名改个写法绕过黑名单"的主要防线，单独钉住。
func TestWritePipelineBlocksExecutableNames(t *testing.T) {
	h := &Handler{appRoot: t.TempDir()}
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(h.appRoot); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(wd) })

	for _, name := range []string{"sec.html", "sec.HTML", "sec.htm", "sec.js", "sec.svg", "sec.exe",
		"sec.html.", "sec.html ", "sec.html. ", "sec.html::$DATA", "sec.js::$DATA", "sec.html:ads.txt"} {
		_, _, err := h.Write(name, "<p>pwned</p>", "strict", true)
		if err == nil || !strings.Contains(err.Error(), "不允许写") {
			t.Errorf("应拦截 %q，实得 err=%v", name, err)
		}
	}

	entries, err := os.ReadDir(h.appRoot)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "sec.") {
			t.Errorf("%q 在磁盘上留了下来 —— 拦截没有真的挡住落盘", entry.Name())
		}
	}

	if _, _, err := h.Write("note.txt", "ok", "strict", true); err != nil {
		t.Fatalf("合法文本文件应可写入，实得 err=%v", err)
	}
	if _, statErr := os.Stat(filepath.Join(h.appRoot, "note.txt")); statErr != nil {
		t.Fatalf("文件应已落盘：%v", statErr)
	}
}
