package zipx

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

// buildRawZip 用任意条目名打包一个 zip：恶意条目名（../x、x.html::$DATA）不会经过
// Write 的安全检查，必须绕过它直接构造，攻击者手里的包就是这样的。
func buildRawZip(t *testing.T, entries []Entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: e.Name, Method: zip.Deflate})
		if err != nil {
			t.Fatalf("打包 %s：%v", e.Name, err)
		}
		if _, err := w.Write(e.Data); err != nil {
			t.Fatalf("写入 %s：%v", e.Name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip：%v", err)
	}
	return buf.Bytes()
}

// 危险扩展名黑名单是解压落盘的安全底线：常规名字与"Windows 上看着不一样、落盘却一样"
// 的变体（大小写、尾随点/空格、NTFS 流）都必须拦下。
func TestReadBlocksDangerousExtensions(t *testing.T) {
	cases := []struct {
		name string
		why  string
	}{
		{"evil.html", "网页"},
		{"evil.exe", "可执行"},
		{"evil.bat", "批处理"},
		{"evil.cmd", "批处理"},
		{"evil.js", "脚本"},
		{"evil.sh", "脚本"},
		{"evil.svg", "可带脚本的图片"},
		{"EVIL.EXE", "大小写变体"},
		{"evil.Bat", "大小写变体"},
		{"evil.CmD", "大小写变体"},
		{"evil.exe.", "尾随点"},
		{"evil.bat ", "尾随空格"},
		{"evil.exe  ", "多个尾随空格"},
		{"evil.html::$DATA", "NTFS 交换数据流"},
		{"evil.js::$DATA", "NTFS 交换数据流"},
		{"a.b.c.exe", "多重点缀"},
	}
	for _, tc := range cases {
		blob := buildRawZip(t, []Entry{
			{Name: tc.name, Data: []byte("MZ")},
			{Name: "safe.txt", Data: []byte("ok")},
		})
		files, blocked, err := Read(blob, Options{})
		if err != nil {
			t.Fatalf("%s（%s）：Read 报错 %v", tc.name, tc.why, err)
		}
		if len(files) != 1 || files[0].Name != "safe.txt" {
			t.Errorf("%s（%s）应被拦下，只放行 safe.txt；实际 %v", tc.name, tc.why, names(files))
		}
		found := false
		for _, b := range blocked {
			if b == tc.name {
				found = true
			}
		}
		if !found {
			t.Errorf("%s（%s）应记入 blocked 清单，实际 %v", tc.name, tc.why, blocked)
		}
	}
}

func names(files []File) []string {
	out := make([]string, 0, len(files))
	for _, f := range files {
		out = append(out, f.Name)
	}
	return out
}

// 正常数据文件不能被误拦，否则备份导入会丢数据。
func TestReadAllowsNormalDataFiles(t *testing.T) {
	blob := buildRawZip(t, []Entry{
		{Name: "note.txt", Data: []byte("hi")},
		{Name: "model.model3.json", Data: []byte("{}")},
		{Name: "texture.png", Data: []byte("PNG")},
		{Name: "data/characters/card.json", Data: []byte("{}")},
	})
	files, blocked, err := Read(blob, Options{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(blocked) != 0 {
		t.Errorf("正常数据不应被拦：%v", blocked)
	}
	if len(files) != 4 {
		t.Fatalf("应解出 4 个文件，实际 %d：%v", len(files), names(files))
	}
}

// Windows 上 x.html::$DATA / x.html. / x.html␠ 落盘时都等于 x.html，
// 直接看 path.Ext 会绕过黑名单；多重点缀也要取到"真正生效"的那一段。
func TestEffectiveExtSeesThroughWindowsTricks(t *testing.T) {
	cases := []struct {
		name string
		want string
	}{
		{"x.html::$DATA", ".html"},
		{"x.js::$DATA", ".js"},
		{"x.html.", ".html"},
		{"x.html ", ".html"},
		{"x.html. .", ".html"},
		{"x.exe.", ".exe"},
		{"a.b.c.html", ".html"},
		{"x.Exe", ".exe"},
		{"x.EXE", ".exe"},
		{"note.txt", ".txt"},
		{"README", ""},
	}
	for _, tc := range cases {
		if got := EffectiveExt(tc.name); got != tc.want {
			t.Errorf("EffectiveExt(%q) = %q，应为 %q", tc.name, got, tc.want)
		}
	}
	// 黑名单判定的端到端一致性：Node 版断言 BLOCKED_EXT.has(effectiveExt(x))。
	for _, blocked := range []string{"x.html::$DATA", "x.html.", "x.html ", "x.js::$DATA", "X.EXE"} {
		if !blockedExt[EffectiveExt(blocked)] {
			t.Errorf("%s 应判为危险类型", blocked)
		}
	}
	if blockedExt[EffectiveExt("note.txt")] {
		t.Errorf("note.txt 不该被误判为危险类型")
	}
}

// 绝对路径与 .. 段是穿越；反斜杠也要按分隔符算（Windows 上 ..\x 就是真实穿越）。
func TestIsUnsafeEntryName(t *testing.T) {
	unsafe := []string{
		"", "",
		"../web/serve.mjs",
		"a/../b.json",
		"a/..",
		"..\\x.json",
		"..\\..\\evil",
		"/abs/path.json",
		"/evil",
		`C:\evil.json`,
		"C:/evil.json",
		"C:\\abs\\path",
	}
	for _, name := range unsafe[1:] {
		if !IsUnsafeEntryName(name) {
			t.Errorf("%q 应判为不安全条目名", name)
		}
	}
	safe := []string{
		"ok.json",
		"data/characters/card_a.json",
		"a..b/c.json",
		"./x.json",
		"mods/demo/index.js",
	}
	for _, name := range safe {
		if IsUnsafeEntryName(name) {
			t.Errorf("%q 不该被判为不安全", name)
		}
	}
}

// 穿越 / 绝对路径条目在解压时静默跳过（不写盘也不进 blocked），合法条目照常解出。
func TestReadRejectsTraversalAndAbsolutePaths(t *testing.T) {
	blob := buildRawZip(t, []Entry{
		{Name: "ok.json", Data: []byte("{}")},
		{Name: "../../web/serve.mjs", Data: []byte("HACKED")},
		{Name: "..\\evil.txt", Data: []byte("HACKED")},
		{Name: "/abs/path.json", Data: []byte("{}")},
		{Name: `C:\evil.json`, Data: []byte("HACKED")},
	})
	files, blocked, err := Read(blob, Options{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	for _, f := range files {
		if strings.Contains(f.Name, "..") || strings.HasPrefix(f.Name, "/") || f.Name[1] == ':' {
			t.Errorf("不安全条目 %s 不应落盘", f.Name)
		}
	}
	if len(files) != 1 || files[0].Name != "ok.json" {
		t.Fatalf("应只解出 ok.json，实际 %v", names(files))
	}
	if len(blocked) != 0 {
		t.Errorf("穿越条目是跳过不是拦下（blocked 语义只留给危险扩展名）：%v", blocked)
	}
}

// allowScripts 只给插件安装路径用：脚本与面板 HTML 放行，.exe/.dll/.bat 仍然拦；
// 数据导入（默认 Options）不开这个开关，.js 照拦。
func TestAllowScriptsSemantics(t *testing.T) {
	blob := buildRawZip(t, []Entry{
		{Name: "manifest.json", Data: []byte(`{"id":"x"}`)},
		{Name: "index.js", Data: []byte("console.log(1)")},
		{Name: "panel.html", Data: []byte("<p>x</p>")},
		{Name: "style.css", Data: []byte(".x{}")},
		{Name: "bad.exe", Data: []byte("MZ")},
		{Name: "bad.dll", Data: []byte("MZ")},
	})

	files, blocked, err := Read(blob, Options{})
	if err != nil {
		t.Fatalf("Read（默认）: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("默认（数据导入路径）应只解出 manifest.json 与 style.css，实际 %v", names(files))
	}
	for _, f := range files {
		if f.Name == "index.js" || f.Name == "panel.html" {
			t.Errorf("默认路径不应放行脚本/HTML：%s", f.Name)
		}
	}
	for _, want := range []string{"index.js", "panel.html", "bad.exe", "bad.dll"} {
		found := false
		for _, b := range blocked {
			if b == want {
				found = true
			}
		}
		if !found {
			t.Errorf("默认路径应拦下 %s，blocked=%v", want, blocked)
		}
	}

	files, blocked, err = Read(blob, Options{AllowScripts: true})
	if err != nil {
		t.Fatalf("Read（allowScripts）: %v", err)
	}
	if len(files) != 4 {
		t.Fatalf("allowScripts 应解出 4 个文件，实际 %v", names(files))
	}
	found := map[string]bool{}
	for _, f := range files {
		found[f.Name] = true
	}
	for _, want := range []string{"index.js", "panel.html"} {
		if !found[want] {
			t.Errorf("allowScripts 应放行 %s", want)
		}
	}
	if len(blocked) != 2 || blocked[0] != "bad.exe" || blocked[1] != "bad.dll" {
		t.Errorf("allowScripts 下 .exe/.dll 仍应被拦，blocked=%v", blocked)
	}
}

// 体积上限在实现内部生效：超过即报错，绝不落盘。
func TestReadSizeLimit(t *testing.T) {
	blob := buildRawZip(t, []Entry{
		{Name: "a.json", Data: []byte(`{"a":1}`)},
		{Name: "b.json", Data: []byte(`{"b":2}`)},
	})
	if _, _, err := Read(blob, Options{MaxTotal: 5}); err == nil {
		t.Fatalf("超过 MaxTotal 应报错")
	}
	if _, _, err := Read(blob, Options{MaxEntry: 3}); err == nil {
		t.Fatalf("超过 MaxEntry 应报错")
	}
}

// 子目录路径要保留（备份里的 data/characters/… 依赖它），内容按字节还原。
func TestReadPreservesSubdirectoryPaths(t *testing.T) {
	blob := buildRawZip(t, []Entry{
		{Name: "manifest.json", Data: []byte(`{"v":2}`)},
		{Name: "settings.json", Data: []byte(`{"a":1}`)},
		{Name: "characters/card_a.json", Data: []byte(`{"id":"a"}`)},
	})
	files, _, err := Read(blob, Options{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(files) != 3 {
		t.Fatalf("应解出 3 个条目，实际 %d", len(files))
	}
	found := false
	for _, f := range files {
		if f.Name == "characters/card_a.json" {
			found = true
			if string(f.Data) != `{"id":"a"}` {
				t.Errorf("内容还原不一致：%q", f.Data)
			}
		}
	}
	if !found {
		t.Errorf("子目录路径应保留，实际 %v", names(files))
	}
}
