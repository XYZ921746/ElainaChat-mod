// Package packages 管理两个「安装目录」：mods/（插件）与 skills/（技能）。
// 它们与 data/ 下的键值不是同一种东西——卸载插件是删目录，不是删键——所以安装、
// 扫描、收集与恢复都放在这里，store 只管聊天数据。
//
// 安全边界与 server/mods.mjs 一致：条目名先过路径穿越判定，目录名各自白名单，
// 危险类型由 zipx 统一拦截，先落临时目录、校验完整后再改名。
package packages

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"elainachat/server/internal/logx"
	"elainachat/server/internal/plugin"
	"elainachat/server/internal/zipx"
)

const (
	modsPrefix   = "mods/"
	skillsPrefix = "skills/"

	stagingPrefix    = ".restoring-"
	stagingStaleAge  = 10 * time.Minute
	maxPackageBytes  = 64 * 1024 * 1024
	maxPackageText   = 256 * 1024
	installReportTTL = 5 * time.Minute
)

// 插件 / 技能目录里绝不落盘的本机可执行类型（.js 是插件本体，不在此列）。
var blockedExt = map[string]bool{
	".exe": true, ".dll": true, ".com": true, ".scr": true, ".msi": true, ".bat": true, ".cmd": true,
	".ps1": true, ".psm1": true, ".vbs": true, ".wsf": true, ".jar": true, ".sh": true, ".app": true,
	".deb": true, ".rpm": true,
}

var (
	skillIDRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	skillDirRe = regexp.MustCompile(`^[^\\/:*?"<>|\x00-\x1f]{1,128}$`)
)

// InstallResult 是一次 zip 安装的结论：前端要能看到「哪些文件被拦下了」，
// 否则「我把 zip 放进去了但没反应」无从排查。
type InstallResult struct {
	Zip   string `json:"zip,omitempty"`
	ID    string `json:"id,omitempty"`
	OK    bool   `json:"ok"`
	Files int    `json:"files,omitempty"`
	Skip  int    `json:"skipped,omitempty"`
	Error string `json:"error,omitempty"`
}

// Skill 是 /api/skills 的一条。kind 永远是 knowledge：
// 技能是给 AI 的文本资料，不是同源执行的插件。
type Skill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Kind        string `json:"kind"`
	Owner       any    `json:"owner"`
	Source      string `json:"source"`
	Dir         string `json:"dir"`
}

// Manager 无状态地操作两个目录；只有安装结果缓存与写盘队列需要加锁。
type Manager struct {
	ModsDir   string
	SkillsDir string

	log *logx.Logger

	mu       sync.Mutex
	report   []InstallResult
	reportAt time.Time

	// 同一个插件目录的安装 / 卸载 / 恢复串行化：两边都是「删旧目录 + 重命名」，
	// 交错执行时第二个 rename 在 Windows 上直接 EPERM，或者互相删掉对方刚写好的文件。
	// 键是目标目录名（安装用 id，卸载用 manifest.id 反查出的真实目录名）。
	dirLocks sync.Map
}

// stagingSeq 保证同一个插件 id 的并发安装拿到不同的临时目录名。
// 只用 pid + 时间戳在高并发下可能撞名，而撞名的第一步就是 RemoveAll 掉对方正在写的目录。
var stagingSeq atomic.Int64

func stagingName(id string) string {
	return fmt.Sprintf(".installing-%s-%d-%d", id, os.Getpid(), stagingSeq.Add(1))
}

// lockDir 取某个插件目录的锁；返回的函数必须调用（defer）。
// 键用绝对路径：安装传「目标目录」、卸载传「反查出的真实目录」、恢复传「包里的目录」，
// 三者对同一个插件必须落到同一把锁上。
func (m *Manager) lockDir(target string) func() {
	key, err := filepath.Abs(target)
	if err != nil || key == "" {
		key = filepath.Clean(target)
	}
	value, _ := m.dirLocks.LoadOrStore(key, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func New(modsDir, skillsDir string, log *logx.Logger) *Manager {
	return &Manager{ModsDir: modsDir, SkillsDir: skillsDir, log: log}
}

func (m *Manager) logf(level, format string, args ...any) {
	if m.log == nil {
		return
	}
	switch level {
	case "warn":
		m.log.Warnf("Mod", format, args...)
	default:
		m.log.Infof("Mod", format, args...)
	}
}

func isSafeDirName(name string) bool {
	if name == "" || name == "." || name == ".." {
		return false
	}
	if strings.HasPrefix(name, ".") {
		return false
	}
	if name != strings.TrimSpace(name) {
		return false
	}
	if strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
		return false
	}
	if strings.Contains(name, "..") {
		return false
	}
	return skillDirRe.MatchString(name)
}

func isSafeSkillRel(rel string) bool {
	r := strings.ReplaceAll(rel, "\\", "/")
	if r == "" || strings.HasPrefix(r, "/") {
		return false
	}
	for _, seg := range strings.Split(r, "/") {
		if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, ".") {
			return false
		}
	}
	return true
}

// normalizeModID 只剥多段版本号尾（-1.0 / -1.0.0）；my-mod-2 这类名字很常见，
// 剥单段会误伤真实名字。
func normalizeModID(raw string) string {
	base := raw
	for _, ext := range []string{".zip", ".ZIP", ".Zip"} {
		base = strings.TrimSuffix(base, ext)
	}
	stripped := regexp.MustCompile(`-[0-9]+\.[0-9]+(?:\.[0-9]+)*$`).ReplaceAllString(base, "")
	if plugin.ValidModID(stripped) && plugin.ValidModID(base) {
		return stripped
	}
	return base
}

// ScanMods 扫 mods/：先清安装残留、装掉用户丢进来的 zip、再扫描目录。
// 每次请求都重新扫——用户可能在服务运行期间把 zip 拷进来。
func (m *Manager) ScanMods() ([]plugin.Module, []InstallResult, error) {
	if err := os.MkdirAll(m.ModsDir, 0o755); err != nil {
		return nil, nil, err
	}
	entries, err := os.ReadDir(m.ModsDir)
	if err != nil {
		return nil, nil, err
	}

	installed := make([]string, 0, len(entries))
	zips := make([]string, 0)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() {
			if !isSafeDirName(name) {
				m.logf("warn", "跳过目录 %s：名字含不安全字符或非法形式", name)
				continue
			}
			installed = append(installed, name)
		} else if strings.HasSuffix(strings.ToLower(name), ".zip") {
			zips = append(zips, name)
		}
	}

	results := make([]InstallResult, 0, len(zips))
	sort.Strings(zips)
	for _, zipName := range zips {
		id := normalizeModID(zipName)
		if !plugin.ValidModID(id) {
			results = append(results, InstallResult{Zip: zipName, OK: false, Error: "插件名不合法（只允许字母数字、- _ .）"})
			continue
		}
		exists := false
		for _, dir := range installed {
			if dir == id {
				exists = true
				break
			}
		}
		if exists {
			// 覆盖会把用户已有设置一并带走，所以明确报「已安装」并清掉包。
			results = append(results, InstallResult{Zip: zipName, OK: false, Error: fmt.Sprintf("插件 %s 已安装（如需更新请先卸载）", id)})
			_ = os.Remove(filepath.Join(m.ModsDir, zipName))
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(m.ModsDir, zipName))
		if readErr != nil {
			results = append(results, InstallResult{Zip: zipName, OK: false, Error: readErr.Error()})
			continue
		}
		res, installErr := m.InstallMod(data, id)
		if installErr != nil {
			// 失败的 zip 保留：用户要能看到它、修好再重试。
			results = append(results, InstallResult{Zip: zipName, OK: false, Error: installErr.Error()})
			m.logf("warn", "插件安装失败：%s —— %v", zipName, installErr)
			continue
		}
		installed = append(installed, id)
		_ = os.Remove(filepath.Join(m.ModsDir, zipName))
		res.Zip = zipName
		results = append(results, res)
		m.logf("info", "已安装插件：%s（%d 个文件，安装包已清理）", id, res.Files)
	}

	modules, scanErr := plugin.Scan(m.ModsDir)
	if scanErr != nil {
		return nil, results, scanErr
	}
	if err := plugin.WriteIndex(m.ModsDir, modules); err != nil {
		m.logf("warn", "插件清单写入失败：%v", err)
	}

	m.mu.Lock()
	if len(results) > 0 {
		m.report = results
		m.reportAt = time.Now()
	}
	fresh := time.Since(m.reportAt) < installReportTTL
	cached := m.report
	m.mu.Unlock()
	if len(results) == 0 && fresh {
		results = cached
	}
	return modules, results, nil
}

// InstallMod 从内存 zip 安装插件。staging 目录名以点开头，扫描器天然跳过，
// 因此不会出现「index.js 还没写完、前端先请求它」的中间态。
func (m *Manager) InstallMod(data []byte, id string) (InstallResult, error) {
	if !plugin.ValidModID(id) {
		return InstallResult{}, errors.New("插件名不合法：" + id)
	}
	files, _, err := zipx.Read(data, zipx.Options{AllowScripts: true})
	if err != nil {
		if err.Error() == "zip 内没有可用文件" {
			return InstallResult{}, errors.New("zip 内没有可用文件")
		}
		return InstallResult{}, err
	}

	if err := os.MkdirAll(m.ModsDir, 0o755); err != nil {
		return InstallResult{}, err
	}
	target := filepath.Join(m.ModsDir, id)
	unlock := m.lockDir(target)
	defer unlock()
	staging := filepath.Join(m.ModsDir, stagingName(id))
	if err := os.RemoveAll(staging); err != nil {
		return InstallResult{}, err
	}
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return InstallResult{}, err
	}

	stripTop := hasSingleTopDir(files)
	written, skipped, total := 0, 0, 0
	for _, f := range files {
		rel := f.Name
		if stripTop {
			if i := strings.Index(rel, "/"); i >= 0 {
				rel = rel[i+1:]
			}
		}
		if rel == "" || strings.HasSuffix(rel, "/") {
			continue
		}
		if zipx.IsUnsafeEntryName(rel) {
			skipped++
			continue
		}
		out := filepath.Join(staging, filepath.FromSlash(rel))
		if !within(out, staging) || blockedExt[zipx.EffectiveExt(filepath.Base(rel))] {
			skipped++
			continue
		}
		total += len(f.Data)
		if total > maxPackageBytes {
			_ = os.RemoveAll(staging)
			return InstallResult{}, fmt.Errorf("插件解压后超过 %dMB 上限", maxPackageBytes/1024/1024)
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			_ = os.RemoveAll(staging)
			return InstallResult{}, err
		}
		if err := os.WriteFile(out, f.Data, 0o644); err != nil {
			_ = os.RemoveAll(staging)
			return InstallResult{}, err
		}
		written++
	}
	if written == 0 {
		_ = os.RemoveAll(staging)
		return InstallResult{}, errors.New("zip 内没有可用文件")
	}
	if err := os.RemoveAll(target); err != nil {
		_ = os.RemoveAll(staging)
		return InstallResult{}, err
	}
	if err := os.Rename(staging, target); err != nil {
		_ = os.RemoveAll(staging)
		return InstallResult{}, err
	}
	if skipped > 0 {
		m.logf("warn", "插件 %s 跳过 %d 个不安全/不允许的条目", id, skipped)
	}
	return InstallResult{ID: id, OK: true, Files: written, Skip: skipped}, nil
}

// UninstallMod 按 manifest.id 反查真实目录再删（目录名可以与 id 不一致）。
// 只拼 id 会删不到，而 rm -f 的静默成功会变成一次谎报。
func (m *Manager) UninstallMod(id string) error {
	if !plugin.ValidModID(id) {
		return errors.New("插件名不合法")
	}
	dir, ok := m.FindModDirByID(id)
	if !ok {
		return fmt.Errorf("没有找到插件「%s」的目录（可能已经被删掉了）", id)
	}
	resolved, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	root, _ := filepath.Abs(m.ModsDir)
	if resolved != root && !within(resolved, root) {
		return errors.New("路径越界")
	}
	unlock := m.lockDir(resolved)
	defer unlock()
	if _, statErr := os.Stat(resolved); statErr != nil {
		return fmt.Errorf("插件「%s」的目录已经不在了（可能刚被卸载）", id)
	}
	if err := os.RemoveAll(resolved); err != nil {
		return err
	}
	if _, statErr := os.Stat(resolved); statErr == nil {
		return fmt.Errorf("插件目录没能删掉（可能有程序正在占用其中的文件）：%s", resolved)
	}
	// 连同安装包一起删：只删目录的话，下一次扫描会把 zip 重新装回来。
	entries, _ := os.ReadDir(m.ModsDir)
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(strings.ToLower(name), ".zip") {
			continue
		}
		if normalizeModID(name) != id && strings.TrimSuffix(name, filepath.Ext(name)) != id {
			continue
		}
		_ = os.Remove(filepath.Join(m.ModsDir, name))
	}
	_, _, _ = m.ScanMods()
	return nil
}

// FindModDirByID 先按目录名，再按 manifest.id 反查。两者可以不同（表 A9）。
func (m *Manager) FindModDirByID(id string) (string, bool) {
	entries, err := os.ReadDir(m.ModsDir)
	if err != nil {
		return "", false
	}
	for _, entry := range entries {
		if entry.IsDir() && entry.Name() == id {
			return filepath.Join(m.ModsDir, id), true
		}
	}
	for _, entry := range entries {
		if !entry.IsDir() || !isSafeDirName(entry.Name()) {
			continue
		}
		dir := filepath.Join(m.ModsDir, entry.Name())
		if manifestID(dir) == id {
			return dir, true
		}
	}
	return "", false
}

func manifestID(dir string) string {
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return ""
	}
	var mf struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &mf) != nil {
		return ""
	}
	return strings.TrimSpace(mf.ID)
}

var readmeNames = []string{"README.md", "readme.md", "README.txt", "readme.txt", "README", "说明.md"}

// ReadModReadme 只认白名单文件名：让前端传任意名字等于开放「读插件目录里任意文件」。
func (m *Manager) ReadModReadme(id string) (string, string, error) {
	if !plugin.ValidModID(id) {
		return "", "", errors.New("插件名不合法")
	}
	dir, ok := m.FindModDirByID(id)
	if !ok {
		return "", "", fmt.Errorf("没有找到插件「%s」的目录（可能已经被删掉了）", id)
	}
	for _, name := range readmeNames {
		p := filepath.Join(dir, name)
		info, err := os.Stat(p)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if info.Size() > maxPackageText {
			return "", "", errors.New("说明文件过大（超过 256KB），已拒绝读取")
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return "", "", fmt.Errorf("读取失败：%v", err)
		}
		return name, string(raw), nil
	}
	return "", "", errors.New("该插件没有 README 文件")
}

// ScanSkills 合并两个来源：skills/ 下的本地技能，与插件 manifest.skills 声明的随附技能。
// 插件随附技能 id 带 owner 前缀，避免与本地目录撞车。
func (m *Manager) ScanSkills() ([]Skill, error) {
	if err := os.MkdirAll(m.SkillsDir, 0o755); err != nil {
		return nil, err
	}
	skills := make([]Skill, 0, 8)

	entries, err := os.ReadDir(m.SkillsDir)
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if !entry.IsDir() || !isSafeDirName(entry.Name()) {
			continue
		}
		dir := filepath.Join(m.SkillsDir, entry.Name())
		text, ok := readSkillMD(dir)
		if !ok {
			continue
		}
		name, desc := parseFrontmatter(text)
		if name == "" {
			name = entry.Name()
		}
		skills = append(skills, Skill{
			ID: entry.Name(), Name: name, Description: desc,
			Kind: "knowledge", Owner: nil, Source: "local", Dir: dir,
		})
	}

	modEntries, err := os.ReadDir(m.ModsDir)
	if err == nil {
		sort.Slice(modEntries, func(i, j int) bool { return modEntries[i].Name() < modEntries[j].Name() })
		for _, entry := range modEntries {
			if !entry.IsDir() || !isSafeDirName(entry.Name()) {
				continue
			}
			pluginDir := filepath.Join(m.ModsDir, entry.Name())
			raw, err := os.ReadFile(filepath.Join(pluginDir, "manifest.json"))
			if err != nil {
				continue
			}
			var mf struct {
				ID     string   `json:"id"`
				Skills []string `json:"skills"`
			}
			if json.Unmarshal(raw, &mf) != nil || len(mf.Skills) == 0 {
				continue
			}
			owner := strings.TrimSpace(mf.ID)
			if owner == "" {
				owner = entry.Name()
			}
			for _, rel := range mf.Skills {
				if !isSafeSkillRel(rel) {
					m.logf("warn", "插件 %s 声明的技能路径不安全，已跳过：%s", owner, rel)
					continue
				}
				relNorm := strings.TrimPrefix(strings.ReplaceAll(rel, "\\", "/"), "/")
				dir := filepath.Join(pluginDir, filepath.FromSlash(relNorm))
				text, ok := readSkillMD(dir)
				if !ok {
					m.logf("warn", "插件 %s 声明的技能缺少 SKILL.md：%s", owner, relNorm)
					continue
				}
				name, desc := parseFrontmatter(text)
				if name == "" {
					parts := strings.Split(relNorm, "/")
					name = parts[len(parts)-1]
				}
				skills = append(skills, Skill{
					ID: owner + "/" + relNorm, Name: name, Description: desc,
					Kind: "knowledge", Owner: owner, Source: "mod", Dir: dir,
				})
			}
		}
	}
	return skills, nil
}

func readSkillMD(dir string) (string, bool) {
	info, err := os.Stat(filepath.Join(dir, "SKILL.md"))
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	raw, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
	if err != nil {
		return "", false
	}
	return string(raw), true
}

// parseFrontmatter 只认文件开头的 frontmatter 与 name/description 两个单行标量：
// 技能只是给 AI 看的一段文本，不值得为它引一套 YAML 解析器。
// 永不报错——一个坏 SKILL.md 不该让整次扫描挂掉。
func parseFrontmatter(text string) (name, description string) {
	src := strings.TrimPrefix(text, "\uFEFF")
	src = strings.TrimLeft(src, " \t\r\n")
	if !strings.HasPrefix(src, "---") {
		return "", ""
	}
	rest := src[3:]
	rest = strings.TrimLeft(rest, " \t")
	if !strings.HasPrefix(rest, "\n") && !strings.HasPrefix(rest, "\r\n") {
		return "", ""
	}
	rest = strings.TrimPrefix(rest, "\r\n")
	rest = strings.TrimPrefix(rest, "\n")
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return "", ""
	}
	for _, raw := range strings.Split(rest[:end], "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.Index(line, ":")
		if idx <= 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(line[:idx]))
		val := strings.TrimSpace(line[idx+1:])
		if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
			val = val[1 : len(val)-1]
		}
		switch key {
		case "name":
			name = val
		case "description":
			description = val
		}
	}
	return name, description
}

// InstallSkill 从内存 zip 安装技能；装完必须真含 SKILL.md，
// 否则用户会看到「安装成功，但列表里没有」。
func (m *Manager) InstallSkill(data []byte, id string) (InstallResult, error) {
	if !skillIDRe.MatchString(id) {
		return InstallResult{}, errors.New("技能名不合法：" + id)
	}
	files, _, err := zipx.Read(data, zipx.Options{AllowScripts: true})
	if err != nil {
		return InstallResult{}, err
	}
	if err := os.MkdirAll(m.SkillsDir, 0o755); err != nil {
		return InstallResult{}, err
	}
	target := filepath.Join(m.SkillsDir, id)
	staging := filepath.Join(m.SkillsDir, stagingName(id))
	if err := os.RemoveAll(staging); err != nil {
		return InstallResult{}, err
	}
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return InstallResult{}, err
	}

	stripTop := hasSingleTopDir(files)
	written, skipped, total := 0, 0, 0
	for _, f := range files {
		rel := f.Name
		if stripTop {
			if i := strings.Index(rel, "/"); i >= 0 {
				rel = rel[i+1:]
			}
		}
		if rel == "" || strings.HasSuffix(rel, "/") {
			continue
		}
		if zipx.IsUnsafeEntryName(rel) {
			skipped++
			continue
		}
		out := filepath.Join(staging, filepath.FromSlash(rel))
		if !within(out, staging) || blockedExt[zipx.EffectiveExt(filepath.Base(rel))] {
			skipped++
			continue
		}
		total += len(f.Data)
		if total > maxPackageBytes {
			_ = os.RemoveAll(staging)
			return InstallResult{}, fmt.Errorf("技能解压后超过 %dMB 上限", maxPackageBytes/1024/1024)
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			_ = os.RemoveAll(staging)
			return InstallResult{}, err
		}
		if err := os.WriteFile(out, f.Data, 0o644); err != nil {
			_ = os.RemoveAll(staging)
			return InstallResult{}, err
		}
		written++
	}
	if written == 0 {
		_ = os.RemoveAll(staging)
		return InstallResult{}, errors.New("zip 内没有可用文件")
	}
	if _, err := os.Stat(filepath.Join(staging, "SKILL.md")); err != nil {
		_ = os.RemoveAll(staging)
		return InstallResult{}, errors.New("这个 zip 里没有 SKILL.md（技能必须包含一个 SKILL.md）")
	}
	if err := os.RemoveAll(target); err != nil {
		_ = os.RemoveAll(staging)
		return InstallResult{}, err
	}
	if err := os.Rename(staging, target); err != nil {
		_ = os.RemoveAll(staging)
		return InstallResult{}, err
	}
	return InstallResult{ID: id, OK: true, Files: written, Skip: skipped}, nil
}

// UninstallSkill 只允许本地技能：插件随附技能住在插件目录里，没有独立生命周期。
func (m *Manager) UninstallSkill(id string) error {
	if id == "" {
		return errors.New("技能名不合法")
	}
	skills, err := m.ScanSkills()
	if err != nil {
		return err
	}
	var found *Skill
	for i := range skills {
		if skills[i].ID == id {
			found = &skills[i]
			break
		}
	}
	if found == nil {
		return errors.New("技能不存在：" + id)
	}
	if found.Source == "mod" {
		owner := ""
		if s, ok := found.Owner.(string); ok {
			owner = s
		}
		return fmt.Errorf("这是插件「%s」随附的技能，请连同该插件一起卸载（技能就住在插件目录里）", owner)
	}
	root, _ := filepath.Abs(m.SkillsDir)
	dir, _ := filepath.Abs(found.Dir)
	if dir != root && !within(dir, root) {
		return errors.New("路径越界")
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	for _, ext := range []string{".zip", ".ZIP"} {
		_ = os.Remove(filepath.Join(m.SkillsDir, id+ext))
	}
	return nil
}

// ReadSkill 一律经 ScanSkills 反查注册过的目录，前端传不进任意路径。
func (m *Manager) ReadSkill(id string) (string, error) {
	if id == "" {
		return "", errors.New("技能名不合法")
	}
	skills, err := m.ScanSkills()
	if err != nil {
		return "", err
	}
	for i := range skills {
		if skills[i].ID != id {
			continue
		}
		base := m.SkillsDir
		if skills[i].Source == "mod" {
			base = m.ModsDir
		}
		root, _ := filepath.Abs(base)
		dir, _ := filepath.Abs(skills[i].Dir)
		if dir != root && !within(dir, root) {
			return "", errors.New("路径越界")
		}
		p := filepath.Join(dir, "SKILL.md")
		info, err := os.Stat(p)
		if err != nil || !info.Mode().IsRegular() {
			return "", errors.New("该技能没有 SKILL.md")
		}
		if info.Size() > maxPackageText {
			return "", errors.New("技能文件过大（超过 256KB），已拒绝读取")
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return "", fmt.Errorf("读取失败：%v", err)
		}
		return string(raw), nil
	}
	return "", errors.New("技能不存在：" + id)
}

// Counts 只数数量，不读文件内容（/api/data/info 用）。
func (m *Manager) Counts() (int, int) {
	mods := 0
	if entries, err := os.ReadDir(m.ModsDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() && isSafeDirName(entry.Name()) {
				mods++
			}
		}
	}
	skills := 0
	if entries, err := os.ReadDir(m.SkillsDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() || !isSafeDirName(entry.Name()) {
				continue
			}
			if _, err := os.Stat(filepath.Join(m.SkillsDir, entry.Name(), "SKILL.md")); err == nil {
				skills++
			}
		}
	}
	return mods, skills
}

// Collect 把已安装的插件与本地技能按原样收进备份。只收「目录存在 = 已安装」的包：
// mods/index.json（扫描生成）与待安装的 *.zip 都不收。
func (m *Manager) Collect() ([]zipx.Entry, int, int, error) {
	mods, err := collectDir(m.ModsDir, modsPrefix, false, m.logf)
	if err != nil {
		return nil, 0, 0, err
	}
	skills, err := collectDir(m.SkillsDir, skillsPrefix, true, m.logf)
	if err != nil {
		return nil, 0, 0, err
	}
	return append(mods.entries, skills.entries...), mods.count, skills.count, nil
}

type collected struct {
	entries []zipx.Entry
	count   int
}

func collectDir(root, prefix string, requireSkillMD bool, logf func(string, string, ...any)) (collected, error) {
	out := collected{entries: []zipx.Entry{}}
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return out, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if !entry.IsDir() || !isSafeDirName(entry.Name()) {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		if requireSkillMD {
			if info, err := os.Stat(filepath.Join(dir, "SKILL.md")); err != nil || !info.Mode().IsRegular() {
				continue
			}
		}
		files, err := walkFiles(dir)
		if err != nil {
			return out, err
		}
		if len(files) == 0 {
			continue
		}
		out.count++
		for _, rel := range files {
			data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
			if err != nil {
				return out, err
			}
			out.entries = append(out.entries, zipx.Entry{Name: prefix + entry.Name() + "/" + rel, Data: data})
		}
	}
	return out, nil
}

func walkFiles(root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	sort.Strings(out)
	return out, err
}

// RestoreResult 是备份包里插件 / 技能的恢复结论。
type RestoreResult struct {
	Mods    int      `json:"mods"`
	Skills  int      `json:"skills"`
	Files   int      `json:"files"`
	Skipped int      `json:"skipped"`
	Errors  []string `json:"errors"`
	DryRun  bool     `json:"dryRun,omitempty"`
}

type group struct {
	kind  string
	name  string
	files []zipx.File
}

// Restore 从备份条目恢复插件与技能。按包替换：先写临时目录，校验后再改名，
// 单个包失败只记进 Errors，不影响其它包与数据导入。
func (m *Manager) Restore(files []zipx.File, dryRun bool) RestoreResult {
	groups, skipped := groupEntries(files)
	res := RestoreResult{Skipped: skipped, Errors: []string{}, DryRun: dryRun}
	if dryRun {
		for _, g := range groups {
			if g.kind == "mods" {
				res.Mods++
			} else {
				res.Skills++
			}
		}
		return res
	}
	cleanStaleStaging(m.ModsDir)
	cleanStaleStaging(m.SkillsDir)

	for _, g := range groups {
		n, err := m.restoreOne(g)
		if err != nil {
			res.Errors = append(res.Errors, g.kind+"/"+g.name+"："+err.Error())
			m.logf("warn", "恢复失败 %s/%s：%v", g.kind, g.name, err)
			continue
		}
		res.Files += n
		if g.kind == "mods" {
			res.Mods++
		} else {
			res.Skills++
		}
	}
	return res
}

func groupEntries(files []zipx.File) ([]group, int) {
	byKey := map[string]*group{}
	order := make([]string, 0)
	skipped := 0
	for _, f := range files {
		raw := strings.ReplaceAll(f.Name, "\\", "/")
		kind := ""
		rest := ""
		switch {
		case strings.HasPrefix(raw, modsPrefix):
			kind, rest = "mods", strings.TrimPrefix(raw, modsPrefix)
		case strings.HasPrefix(raw, skillsPrefix):
			kind, rest = "skills", strings.TrimPrefix(raw, skillsPrefix)
		default:
			continue
		}
		segs := strings.Split(rest, "/")
		if len(segs) < 2 {
			skipped++
			continue
		}
		name := segs[0]
		rel := strings.Join(segs[1:], "/")
		if !isSafeDirName(name) || rel == "" || zipx.IsUnsafeEntryName(rel) {
			skipped++
			continue
		}
		bad := false
		for _, seg := range strings.Split(rel, "/") {
			if seg == "" || seg == "." {
				bad = true
			}
		}
		if bad || blockedExt[zipx.EffectiveExt(filepath.Base(rel))] {
			skipped++
			continue
		}
		key := kind + "/" + name
		g, ok := byKey[key]
		if !ok {
			g = &group{kind: kind, name: name}
			byKey[key] = g
			order = append(order, key)
		}
		g.files = append(g.files, zipx.File{Name: rel, Data: f.Data})
	}
	out := make([]group, 0, len(order))
	for _, key := range order {
		out = append(out, *byKey[key])
	}
	return out, skipped
}

func (m *Manager) restoreOne(g group) (int, error) {
	root := m.ModsDir
	if g.kind == "skills" {
		root = m.SkillsDir
	}
	target := filepath.Join(root, g.name)
	unlock := m.lockDir(target)
	defer unlock()
	staging := filepath.Join(root, fmt.Sprintf("%s%d-%d", stagingPrefix, time.Now().UnixNano(), os.Getpid()))

	if err := os.MkdirAll(root, 0o755); err != nil {
		return 0, err
	}
	if err := os.RemoveAll(staging); err != nil {
		return 0, err
	}
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return 0, err
	}
	cleanup := func() { _ = os.RemoveAll(staging) }

	bytes := 0
	for _, f := range g.files {
		out := filepath.Join(staging, filepath.FromSlash(f.Name))
		if !within(out, staging) {
			cleanup()
			return 0, errors.New("条目路径越界：" + f.Name)
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			cleanup()
			return 0, err
		}
		if err := os.WriteFile(out, f.Data, 0o644); err != nil {
			cleanup()
			return 0, err
		}
		bytes += len(f.Data)
	}

	if g.kind == "skills" {
		if info, err := os.Stat(filepath.Join(staging, "SKILL.md")); err != nil || !info.Mode().IsRegular() {
			cleanup()
			return 0, errors.New("技能备份里没有 SKILL.md")
		}
		if err := os.RemoveAll(target); err != nil {
			cleanup()
			return 0, err
		}
	} else {
		incomingID := manifestID(staging)
		if incomingID == "" {
			incomingID = g.name
		}
		// 同一个 id 可能装在别的版本目录里：先清掉同 id 的旧目录，
		// 避免导入后出现两个身份相同的插件。
		entries, _ := os.ReadDir(m.ModsDir)
		for _, entry := range entries {
			if !entry.IsDir() || !isSafeDirName(entry.Name()) {
				continue
			}
			dir := filepath.Join(m.ModsDir, entry.Name())
			if filepath.Clean(dir) == filepath.Clean(target) {
				continue
			}
			if manifestID(dir) == incomingID {
				_ = os.RemoveAll(dir)
			}
		}
		if info, err := os.Stat(target); err == nil && info.IsDir() {
			existingID := manifestID(target)
			if existingID != "" && existingID != incomingID {
				cleanup()
				return 0, fmt.Errorf("目录 %s 已被插件 %s 占用", g.name, existingID)
			}
			if err := os.RemoveAll(target); err != nil {
				cleanup()
				return 0, err
			}
		}
	}
	if err := os.Rename(staging, target); err != nil {
		cleanup()
		return 0, err
	}
	return len(g.files), nil
}

func cleanStaleStaging(root string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	now := time.Now()
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), stagingPrefix) {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		info, err := entry.Info()
		if err != nil || now.Sub(info.ModTime()) < stagingStaleAge {
			continue
		}
		_ = os.RemoveAll(dir)
	}
}

func hasSingleTopDir(files []zipx.File) bool {
	if len(files) == 0 {
		return false
	}
	top := ""
	for _, f := range files {
		i := strings.Index(f.Name, "/")
		if i < 0 {
			return false
		}
		cur := f.Name[:i]
		if top == "" {
			top = cur
		} else if top != cur {
			return false
		}
	}
	return true
}

// within 判定 child 是否在 root 之内（含 root 本身）。
func within(child, root string) bool {
	childAbs, err := filepath.Abs(child)
	if err != nil {
		return false
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	if childAbs == rootAbs {
		return true
	}
	rel, err := filepath.Rel(rootAbs, childAbs)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
