// Package plugin 是插件的服务端半边：扫描 mods/、生成清单、在宿主进程里执行插件的
// register(ctx)，并把插件注册的 /api 路由与静态目录接进 HTTP 层。
//
// 契约是收窄的（方案二）：插件不能 import node:*，所有副作用都必须经 ctx 且先通过
// manifest.server.capabilities 的能力校验。这样「插件能干什么」在清单里看得见，
// 而不是等它在运行时直接摸到文件系统。
package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"elainachat/server/internal/fsx"
)

// installStagingStaleAge 决定「安装中途留下的临时目录」多久算陈旧。
// 扫描在每个 /api/plugins 与 /mods/index.json 请求上都会跑；正在安装的 staging 目录还很新，
// 无条件删会让安装中途丢掉自己正在写的文件（随后 rename 直接失败）。
const installStagingStaleAge = 10 * time.Minute

var (
	modIDRe     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	modDirRe    = regexp.MustCompile(`^[^\\/:*?"<>|\x00-\x1f]{1,128}$`)
	routeRe     = regexp.MustCompile(`^/api/[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$`)
	winReserved = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])$`)
)

// Module 是扫描出来的一个插件。ID 是 manifest 声明的身份，Dir 是磁盘真实目录名。
// 两者可以不同（用户改目录名后仍应认得出来），资源 URL 必须用 Dir，身份与依赖必须用 ID。
type Module struct {
	ID             string
	Dir            string
	Name           string
	Version        string
	Description    string
	Entry          string
	Scripts        []string
	Styles         []string
	DefaultEnabled bool
	Hidden         bool
	After          []string
	Capabilities   []string
	Server         json.RawMessage
	HasManifest    bool
}

// ServerDecl 是 manifest.server 的校验结果。
type ServerDecl struct {
	Entry        string
	Routes       []string
	Uploads      []string
	Statics      []StaticDecl
	Capabilities []string
	Signature    string
}

type StaticDecl struct {
	URL  string `json:"url"`
	Dir  string `json:"dir"`
	Mime string `json:"mime,omitempty"`
}

type manifestFile struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Version        string          `json:"version"`
	Description    string          `json:"description"`
	Entry          string          `json:"entry"`
	Scripts        []string        `json:"scripts"`
	Styles         []string        `json:"styles"`
	DefaultEnabled bool            `json:"defaultEnabled"`
	Hidden         bool            `json:"hidden"`
	After          []string        `json:"after"`
	Capabilities   []string        `json:"capabilities"`
	Server         json.RawMessage `json:"server"`
}

// ValidModID 判定插件身份是否合法。id 要进 localStorage 键名、资源 URL 与依赖匹配，
// 比目录名收得紧；安装接口与备份恢复共用这一份判据。
func ValidModID(id string) bool { return modIDRe.MatchString(id) }

func isSafeModDirName(name string) bool {
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
	return modDirRe.MatchString(name)
}

// normalizeModID 只剥多段版本号尾（-1.0 / -1.0.0），不剥单段（-2）：
// my-mod-2 这类名字很常见，剥了会误伤真实名字。
func normalizeModID(raw string) string {
	base := strings.TrimSuffix(raw, ".zip")
	base = strings.TrimSuffix(strings.TrimSuffix(base, ".ZIP"), ".Zip")
	stripped := regexp.MustCompile(`-[0-9]+\.[0-9]+(?:\.[0-9]+)*$`).ReplaceAllString(base, "")
	if modIDRe.MatchString(stripped) && modIDRe.MatchString(base) {
		return stripped
	}
	return base
}

// Scan 只认目录；zip 安装不在本函数里做，避免扫描期间出现写了一半的插件目录。
func Scan(modsDir string) ([]Module, error) {
	if err := os.MkdirAll(modsDir, 0o755); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(modsDir)
	if err != nil {
		return nil, err
	}
	// 清掉安装中途留下的临时目录：隐藏目录不会被扫成插件，但会一直占磁盘。
	// 只清陈旧的——扫描可能在别人的安装请求进行中被调用，删掉新鲜的 staging 等于替对方删掉半成品。
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), ".installing-") {
			continue
		}
		info, statErr := entry.Info()
		if statErr != nil || time.Since(info.ModTime()) < installStagingStaleAge {
			continue
		}
		_ = os.RemoveAll(filepath.Join(modsDir, entry.Name()))
	}

	modules := make([]Module, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !isSafeModDirName(entry.Name()) {
			continue
		}
		dir := filepath.Join(modsDir, entry.Name())
		module := readManifest(dir, entry.Name())
		modules = append(modules, module)
	}
	sort.Slice(modules, func(i, j int) bool { return modules[i].Dir < modules[j].Dir })
	return modules, nil
}

func readManifest(dir, fallbackID string) Module {
	module := Module{
		ID:           normalizeModID(fallbackID),
		Dir:          filepath.Base(dir),
		Name:         fallbackID,
		Entry:        "index.js",
		Scripts:      []string{},
		Styles:       []string{},
		After:        []string{},
		Capabilities: []string{},
	}
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return module
	}
	module.HasManifest = true
	var mf manifestFile
	if json.Unmarshal(raw, &mf) != nil {
		return module
	}
	if declared := strings.TrimSpace(mf.ID); declared != "" && modIDRe.MatchString(declared) {
		module.ID = declared
	}
	if mf.Name != "" {
		module.Name = mf.Name
	}
	module.Version = mf.Version
	module.Description = mf.Description
	if mf.Entry != "" {
		module.Entry = mf.Entry
	}
	module.Scripts = nonEmptyStrings(mf.Scripts)
	module.Styles = nonEmptyStrings(mf.Styles)
	module.After = nonEmptyStrings(mf.After)
	module.Capabilities = nonEmptyStrings(mf.Capabilities)
	module.DefaultEnabled = mf.DefaultEnabled
	module.Hidden = mf.Hidden
	if len(mf.Server) > 0 && string(mf.Server) != "null" {
		module.Server = mf.Server
	}
	return module
}

func nonEmptyStrings(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

// IndexEntry 是 /mods/index.json 里的一条。字段与 server/mods.mjs 的 buildPluginList 一致：
// 前端按这份清单加载插件，少一个字段就会有一项功能静默失效。
func (m Module) IndexEntry() map[string]any {
	entry := map[string]any{
		"id":             m.ID,
		"dir":            m.Dir,
		"name":           m.Name,
		"version":        m.Version,
		"description":    m.Description,
		"entry":          m.Entry,
		"scripts":        m.Scripts,
		"styles":         m.Styles,
		"defaultEnabled": m.DefaultEnabled,
		"after":          m.After,
		"hidden":         m.Hidden,
		"hasManifest":    m.HasManifest,
	}
	if len(m.Capabilities) > 0 {
		entry["capabilities"] = m.Capabilities
	}
	if len(m.Server) > 0 {
		var server map[string]any
		if json.Unmarshal(m.Server, &server) == nil && server != nil {
			entry["server"] = server
		}
	}
	return entry
}

// IndexJSON 生成 mods/index.json 的内容。/mods/index.json 与磁盘上的清单必须同源，
// 否则「刷新页面还是旧插件」这类问题会反复出现。
func IndexJSON(modules []Module) ([]byte, error) {
	plugins := make([]map[string]any, 0, len(modules))
	for _, m := range modules {
		plugins = append(plugins, m.IndexEntry())
	}
	doc := map[string]any{
		"comment":     "本文件由服务端扫描 mods/ 自动生成（见 server/internal/plugin）。手工改动会在下次扫描时被覆盖。",
		"generatedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"plugins":     plugins,
	}
	return json.MarshalIndent(doc, "", "  ")
}

// WriteIndex 生成 mods/index.json。文件由服务端维护，手工改动会在下次扫描时被覆盖。
// indexWriteMu 串行化清单写入：所有调用方共用同一个临时文件（index.json.tmp），
// 并发写会互相截断，而 /mods/index.json 是每个请求都会重写一次的。
var indexWriteMu sync.Mutex

func WriteIndex(modsDir string, modules []Module) error {
	raw, err := IndexJSON(modules)
	if err != nil {
		return err
	}
	indexWriteMu.Lock()
	defer indexWriteMu.Unlock()
	return fsx.WriteFileAtomic(filepath.Join(modsDir, "index.json"), raw, 0o644)
}

// 服务端插件可声明的能力名。新增能力必须同时更新 开发文档.md 表 A23 与 Node 宿主的清单，
// 否则同一个 manifest 在两边会得到不同结论。
var capabilityNames = map[string]bool{
	"route-register": true,
	"upload-write":   true,
	"static-read":    true,
	"host-utils":     true,
	"net-outbound":   true,
	"fs-read":        true,
	"fs-write":       true,
	"exec":           true,
	"zip":            true,
}

func isSafeRelDir(rel string) bool {
	r := strings.TrimSpace(rel)
	if r == "" {
		return false
	}
	if strings.HasPrefix(r, "/") || strings.HasPrefix(r, "\\") {
		return false
	}
	if regexp.MustCompile(`^[A-Za-z]:`).MatchString(r) {
		return false
	}
	for _, seg := range regexp.MustCompile(`[\\/]+`).Split(r, -1) {
		if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, ".") {
			return false
		}
	}
	return true
}

func prefixesOverlap(a, b string) bool {
	return a == b || strings.HasPrefix(a, b+"/") || strings.HasPrefix(b, a+"/")
}

// ReadDeclaration 把 manifest.server 校验成可执行的结构。声明与实现分离：
// 声明说「我占哪些地址、碰哪些目录」，register(ctx) 里只能在这个范围内取用。
func ReadDeclaration(module Module) (*ServerDecl, error) {
	if len(module.Server) == 0 {
		return nil, nil
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(module.Server, &raw) != nil || raw == nil {
		return nil, errors.New("manifest.json 的 server 必须是对象（{ entry, routes, uploads }）")
	}

	decl := &ServerDecl{}
	if v, ok := raw["entry"]; ok {
		_ = json.Unmarshal(v, &decl.Entry)
	}
	decl.Entry = strings.TrimSpace(decl.Entry)
	if decl.Entry == "" {
		return nil, errors.New("manifest.json 的 server 缺少 entry（服务端入口文件名）")
	}
	if !strings.HasSuffix(strings.ToLower(decl.Entry), ".js") && !strings.HasSuffix(strings.ToLower(decl.Entry), ".mjs") {
		return nil, fmt.Errorf("server.entry 必须是 .js / .mjs 文件：%s", decl.Entry)
	}
	if !isSafeRelDir(decl.Entry) {
		return nil, errors.New("server.entry 不能含路径成分或 ..")
	}

	if v, ok := raw["routes"]; ok {
		var routes []string
		if json.Unmarshal(v, &routes) != nil {
			return nil, errors.New("server.routes 必须是字符串数组（路由前缀）")
		}
		seen := map[string]bool{}
		for _, item := range routes {
			p := strings.TrimSpace(item)
			if !routeRe.MatchString(p) {
				return nil, fmt.Errorf("server.routes 里的「%s」不是合法的路由前缀（应形如 /api/live2d）", p)
			}
			if seen[p] {
				return nil, fmt.Errorf("server.routes 里有重复的前缀：%s", p)
			}
			seen[p] = true
			decl.Routes = append(decl.Routes, p)
		}
	}

	if v, ok := raw["uploads"]; ok {
		var uploads []string
		if json.Unmarshal(v, &uploads) != nil {
			return nil, errors.New("server.uploads 必须是字符串数组（目录名）")
		}
		for _, item := range uploads {
			u := strings.TrimSpace(item)
			if !isSafeRelDir(u) {
				return nil, fmt.Errorf("server.uploads 里的「%s」不是安全的相对目录名", u)
			}
			decl.Uploads = append(decl.Uploads, filepath.ToSlash(u))
		}
	}

	if v, ok := raw["static"]; ok {
		statics, err := parseStatics(v)
		if err != nil {
			return nil, err
		}
		decl.Statics = statics
	}

	if v, ok := raw["capabilities"]; ok {
		var caps []string
		if json.Unmarshal(v, &caps) != nil {
			return nil, errors.New("server.capabilities 必须是字符串数组（能力名）")
		}
		seen := map[string]bool{}
		for _, cap := range caps {
			name := strings.TrimSpace(cap)
			if !capabilityNames[name] {
				return nil, fmt.Errorf("server.capabilities 里有未知能力：%s", name)
			}
			if seen[name] {
				return nil, fmt.Errorf("server.capabilities 里有重复的能力：%s", name)
			}
			seen[name] = true
			decl.Capabilities = append(decl.Capabilities, name)
		}
	}
	if contains(decl.Capabilities, "upload-write") && len(decl.Uploads) == 0 {
		return nil, errors.New("server.capabilities 声明了 upload-write，但 server.uploads 是空的 —— 没有可写的目录")
	}
	if contains(decl.Capabilities, "route-register") && len(decl.Routes) == 0 {
		return nil, errors.New("server.capabilities 声明了 route-register，但 server.routes 是空的 —— 没有可注册的地址")
	}
	if contains(decl.Capabilities, "static-read") && len(decl.Statics) == 0 {
		return nil, errors.New("server.capabilities 声明了 static-read，但 server.static 是空的 —— 没有可读的目录")
	}

	sig, _ := json.Marshal(decl)
	decl.Signature = string(sig)
	return decl, nil
}

func parseStatics(raw json.RawMessage) ([]StaticDecl, error) {
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil {
		var obj map[string]string
		if json.Unmarshal(raw, &obj) == nil && obj != nil {
			out := make([]StaticDecl, 0, len(obj))
			for url, dir := range obj {
				out = append(out, StaticDecl{URL: url, Dir: dir})
			}
			sort.Slice(out, func(i, j int) bool { return out[i].URL < out[j].URL })
			return validateStatics(out)
		}
		return nil, errors.New("server.static 必须是数组或对象（{ \"URL前缀\": \"目录名\" }）")
	}
	out := make([]StaticDecl, 0, len(list))
	for _, item := range list {
		var pair []string
		if json.Unmarshal(item, &pair) == nil && len(pair) == 2 {
			out = append(out, StaticDecl{URL: pair[0], Dir: pair[1]})
			continue
		}
		var decl StaticDecl
		if json.Unmarshal(item, &decl) == nil && decl.URL != "" {
			out = append(out, decl)
			continue
		}
		return nil, errors.New("server.static 的数组项必须是 [前缀, 目录] 或 { url, dir, mime }")
	}
	return validateStatics(out)
}

func validateStatics(in []StaticDecl) ([]StaticDecl, error) {
	out := make([]StaticDecl, 0, len(in))
	for _, s := range in {
		s.URL = strings.TrimSpace(s.URL)
		s.Dir = filepath.ToSlash(strings.TrimSpace(s.Dir))
		if !strings.HasPrefix(s.URL, "/") || strings.Contains(s.URL, "..") {
			return nil, fmt.Errorf("server.static 的前缀不合法：%s", s.URL)
		}
		if !isSafeRelDir(s.Dir) {
			return nil, fmt.Errorf("server.static 的目录不安全：%s", s.Dir)
		}
		if s.Mime != "" && s.Mime != "auto" && s.Mime != "binary" {
			return nil, fmt.Errorf("server.static 的 mime 只能是 auto / binary：%s", s.Mime)
		}
		out = append(out, s)
	}
	return out, nil
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

// HostRoutes / HostStatics 是宿主自己占用的前缀。插件撞名在装载期拒绝，
// 装载期报错好过运行期「接口没反应」。
var HostRoutes = []string{
	"/api/server-info", "/api/auth", "/api/relay", "/api/client-log",
	"/api/logs", "/api/store", "/api/data",
	"/api/plugins", "/api/skills", "/api/agent", "/api/memory",
}

var HostStatics = []string{"/vendor", "/js", "/css", "/mods", "/themes"}
