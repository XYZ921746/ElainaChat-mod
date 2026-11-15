package packages

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"elainachat/server/internal/zipx"
)

func newManager(t *testing.T) *Manager {
	t.Helper()
	root := t.TempDir()
	return New(filepath.Join(root, "mods"), filepath.Join(root, "skills"), nil)
}

func makeZip(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	list := make([]zipx.Entry, 0, len(entries))
	for name, data := range entries {
		list = append(list, zipx.Entry{Name: name, Data: []byte(data)})
	}
	blob, err := zipx.Write(list)
	if err != nil {
		t.Fatalf("zipx.Write: %v", err)
	}
	return blob
}

func TestInstallModStripsTopDirAndBlocksExe(t *testing.T) {
	m := newManager(t)
	blob := makeZip(t, map[string]string{
		"demo/manifest.json": `{"id":"demo","name":"Demo"}`,
		"demo/index.js":      "console.log(1)",
		"demo/tool.exe":      "MZ",
	})
	res, err := m.InstallMod(blob, "demo")
	if err != nil {
		t.Fatalf("InstallMod: %v", err)
	}
	if res.Files != 2 || res.Skip != 0 {
		t.Errorf("安装结果 files=%d skip=%d（.exe 应在解压层就被拦下）", res.Files, res.Skip)
	}
	if _, err := os.Stat(filepath.Join(m.ModsDir, "demo", "manifest.json")); err != nil {
		t.Errorf("顶层目录没有剥掉或文件没落盘：%v", err)
	}
}

func TestScanModsInstallsDroppedZip(t *testing.T) {
	m := newManager(t)
	blob := makeZip(t, map[string]string{
		"manifest.json": `{"id":"demo","name":"Demo"}`,
		"index.js":      "console.log(1)",
	})
	if err := os.MkdirAll(m.ModsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.ModsDir, "demo-1.0.0.zip"), blob, 0o644); err != nil {
		t.Fatal(err)
	}
	modules, results, err := m.ScanMods()
	if err != nil {
		t.Fatalf("ScanMods: %v", err)
	}
	if len(modules) != 1 || modules[0].ID != "demo" {
		t.Fatalf("没有把 zip 装成插件：%+v", modules)
	}
	if len(results) != 1 || !results[0].OK {
		t.Errorf("安装结果没报成功：%+v", results)
	}
	if _, err := os.Stat(filepath.Join(m.ModsDir, "demo-1.0.0.zip")); err == nil {
		t.Errorf("安装成功后 zip 应被清理")
	}
	raw, err := os.ReadFile(filepath.Join(m.ModsDir, "index.json"))
	if err != nil {
		t.Fatalf("没有生成 index.json：%v", err)
	}
	var doc struct {
		Plugins []map[string]any `json:"plugins"`
	}
	if json.Unmarshal(raw, &doc) != nil || len(doc.Plugins) != 1 {
		t.Errorf("index.json 内容不对：%s", raw)
	}
}

func TestUninstallByManifestID(t *testing.T) {
	m := newManager(t)
	blob := makeZip(t, map[string]string{
		"manifest.json": `{"id":"demo","name":"Demo"}`,
		"index.js":      "console.log(1)",
	})
	if _, err := m.InstallMod(blob, "demo-1.0.0"); err != nil {
		t.Fatalf("InstallMod: %v", err)
	}
	// 目录名是 demo-1.0.0，身份是 manifest 里的 demo。
	if err := m.UninstallMod("demo"); err != nil {
		t.Fatalf("UninstallMod: %v", err)
	}
	if _, err := os.Stat(filepath.Join(m.ModsDir, "demo-1.0.0")); err == nil {
		t.Errorf("卸载后目录仍在")
	}
}

func TestCollectRestoreRoundTrip(t *testing.T) {
	m := newManager(t)
	blob := makeZip(t, map[string]string{
		"manifest.json": `{"id":"demo","name":"Demo"}`,
		"index.js":      "console.log(1)",
	})
	if _, err := m.InstallMod(blob, "demo"); err != nil {
		t.Fatal(err)
	}
	skillDir := filepath.Join(m.SkillsDir, "notes")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: 笔记\n---\n正文"), 0o644); err != nil {
		t.Fatal(err)
	}

	entries, mods, skills, err := m.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if mods != 1 || skills != 1 || len(entries) < 3 {
		t.Fatalf("收集结果 mods=%d skills=%d entries=%d", mods, skills, len(entries))
	}

	files := []zipx.File{}
	for _, e := range entries {
		files = append(files, zipx.File{Name: e.Name, Data: e.Data})
	}
	restored := m.Restore(files, false)
	if len(restored.Errors) != 0 || restored.Mods != 1 || restored.Skills != 1 {
		t.Fatalf("Restore: %+v", restored)
	}

	target := newManager(t)
	// 备份恢复到一个全新目录：目标目录的父目录可能还不存在。
	if err := os.MkdirAll(target.ModsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(target.SkillsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	restored = target.Restore(files, false)
	if len(restored.Errors) != 0 || restored.Mods != 1 || restored.Skills != 1 {
		t.Fatalf("目标机 Restore: %+v", restored)
	}
	if _, err := os.Stat(filepath.Join(target.ModsDir, "demo", "index.js")); err != nil {
		t.Errorf("插件没有恢复：%v", err)
	}
	if _, err := os.Stat(filepath.Join(target.SkillsDir, "notes", "SKILL.md")); err != nil {
		t.Errorf("技能没有恢复：%v", err)
	}
}

func TestRestoreDryRunCountsOnly(t *testing.T) {
	m := newManager(t)
	files := []zipx.File{
		{Name: "mods/demo/manifest.json", Data: []byte(`{"id":"demo"}`)},
		{Name: "mods/demo/index.js", Data: []byte("1")},
		{Name: "skills/notes/SKILL.md", Data: []byte("x")},
		{Name: "data/settings.json", Data: []byte("{}")},
	}
	res := m.Restore(files, true)
	if res.Mods != 1 || res.Skills != 1 || !res.DryRun {
		t.Fatalf("dryRun 计数不对：%+v", res)
	}
	if _, err := os.Stat(filepath.Join(m.ModsDir, "demo")); err == nil {
		t.Errorf("dryRun 不应落盘")
	}
}

func TestSkillInstallRequiresSKILLMD(t *testing.T) {
	m := newManager(t)
	bad := makeZip(t, map[string]string{"readme.txt": "x"})
	if _, err := m.InstallSkill(bad, "bad"); err == nil {
		t.Fatalf("没有 SKILL.md 的技能应被拒绝")
	}
	good := makeZip(t, map[string]string{
		"SKILL.md": "---\nname: 资料\ndescription: 一段说明\n---\n正文",
	})
	if _, err := m.InstallSkill(good, "good"); err != nil {
		t.Fatalf("InstallSkill: %v", err)
	}
	skills, err := m.ScanSkills()
	if err != nil {
		t.Fatal(err)
	}
	if len(skills) != 1 || skills[0].Name != "资料" || skills[0].Description != "一段说明" {
		t.Fatalf("技能扫描结果不对：%+v", skills)
	}
	if err := m.UninstallSkill("good"); err != nil {
		t.Fatalf("UninstallSkill: %v", err)
	}
}

func TestModAttachedSkillCannotBeUninstalled(t *testing.T) {
	m := newManager(t)
	blob := makeZip(t, map[string]string{
		"manifest.json":          `{"id":"demo","name":"Demo","skills":["skills/helper"]}`,
		"index.js":               "console.log(1)",
		"skills/helper/SKILL.md": "---\nname: 助手\n---\n",
	})
	if _, err := m.InstallMod(blob, "demo"); err != nil {
		t.Fatal(err)
	}
	skills, err := m.ScanSkills()
	if err != nil {
		t.Fatal(err)
	}
	if len(skills) != 1 || skills[0].ID != "demo/skills/helper" || skills[0].Source != "mod" {
		t.Fatalf("插件随附技能扫描结果不对：%+v", skills)
	}
	if err := m.UninstallSkill("demo/skills/helper"); err == nil {
		t.Fatalf("插件随附技能不应能单独卸载")
	}
}

// 并发安装同一个插件 id 必须串行完成：没有锁时两边各自「删目录 + 重命名」，
// 后一个 rename 会撞上非空目标（Windows 上是 EPERM），表现为安装随机失败。
func TestConcurrentInstallSameID(t *testing.T) {
	m := newManager(t)
	blob := makeZip(t, map[string]string{
		"manifest.json": `{"id":"race","name":"Race"}`,
		"index.js":      "console.log(1)",
	})
	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			_, errs[i] = m.InstallMod(blob, "race")
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("第 %d 个并发安装失败：%v", i, err)
		}
	}
	entries, err := os.ReadDir(filepath.Join(m.ModsDir, "race"))
	if err != nil {
		t.Fatalf("安装后目录不可读：%v", err)
	}
	names := map[string]bool{}
	for _, e := range entries {
		names[e.Name()] = true
	}
	if !names["manifest.json"] || !names["index.js"] {
		t.Fatalf("安装后不是完整的一份：%v", names)
	}
	if left, _ := os.ReadDir(m.ModsDir); len(left) != 1 {
		t.Fatalf("安装后残留了临时目录：%v", left)
	}
}
