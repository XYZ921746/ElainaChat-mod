package zipx

import "testing"

// 备份导入改成「AllowScripts 读一遍 + SplitDataFiles 筛一遍」后，
// 结果必须与按数据路径重新 Read 一遍完全一致，否则黑名单保护会出现两条口径。
func TestSplitDataFilesMatchesDataPass(t *testing.T) {
	entries := []Entry{
		{Name: "manifest.json", Data: []byte(`{}`)},
		{Name: "data/settings.json", Data: []byte(`{}`)},
		{Name: "data/memory/diary.json", Data: []byte(`{}`)},
		{Name: "data/blob.bin", Data: []byte{1, 2, 3}},
		{Name: "mods/demo/index.js", Data: []byte("x")},
		{Name: "mods/demo/panel.html", Data: []byte("<p>x</p>")},
	}
	blob, err := Write(entries)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	full, _, err := Read(blob, Options{AllowScripts: true})
	if err != nil {
		t.Fatalf("Read (allowScripts): %v", err)
	}
	data, blocked := SplitDataFiles(full)

	twice, twiceBlocked, err := Read(blob, Options{})
	if err != nil {
		t.Fatalf("Read (data pass): %v", err)
	}
	if len(data) != len(twice) {
		t.Fatalf("数据条数不一致：%d vs %d", len(data), len(twice))
	}
	twiceNames := map[string]bool{}
	for _, f := range twice {
		twiceNames[f.Name] = true
	}
	for _, f := range data {
		if !twiceNames[f.Name] {
			t.Errorf("单遍筛选多出条目 %s", f.Name)
		}
	}
	if len(blocked) != len(twiceBlocked) {
		t.Fatalf("拦下清单不一致：%v vs %v", blocked, twiceBlocked)
	}
	twiceBlockedSet := map[string]bool{}
	for _, name := range twiceBlocked {
		twiceBlockedSet[name] = true
	}
	for _, name := range blocked {
		if !twiceBlockedSet[name] {
			t.Errorf("单遍筛选的拦下清单多出 %s", name)
		}
	}
}

// 写入黑名单的判定必须看「最终落盘名」：Windows 尾点 / 尾空格 / ADS 流写法
// 落盘时都等于同一个危险扩展名，朴素 extname 判不出这些写法。
func TestEffectiveExtWriteBlacklist(t *testing.T) {
	mustBlock := []string{
		"x.html", "x.HTML", "x.htm", "x.xhtml", "x.shtml", "x.hta", "x.mhtml",
		"x.js", "x.mjs", "x.cjs", "x.jsx", "x.ts",
		"x.svg", "x.xml", "x.xsl",
		"x.exe", "x.dll", "x.com", "x.scr", "x.msi", "x.bat", "x.cmd",
		"x.ps1", "x.psm1", "x.vbs", "x.wsf", "x.jar", "x.sh",
		"x.html.", "x.html ", "x.html. ",
		"x.html::$DATA", "x.HTML::$DATA", "x.js::$DATA", "x.svg::$DATA",
		"x.html:ads.txt",
	}
	for _, n := range mustBlock {
		if !blockedExt[EffectiveExt(n)] {
			t.Errorf("%q 应判为危险类型（实测 %q）", n, EffectiveExt(n))
		}
	}
	for _, n := range []string{"note.txt", "a.md", "data.json", "x.csv", "readme", "中文名.txt", "a.b.txt"} {
		if blockedExt[EffectiveExt(n)] {
			t.Errorf("%q 不应被拦（正常文本）", n)
		}
	}
}
