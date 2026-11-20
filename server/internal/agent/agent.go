// Package agent 是「AI 操作这台电脑」的文件侧接口：列目录、读文件、写文件、删除。
//
// 权限档位与 Node 版一致：off 能力不存在；strict 每次改动都要 overwrite/confirmed；
// auto 允许写但禁止删除；full 全放行。档位以服务端 store 里的设置为准，
// 请求参数只在设置缺失时兜底 —— 前端可被绕过，不能让它自己宣布自己是 full。
package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	"elainachat/server/internal/fsx"
	"elainachat/server/internal/logx"
	"elainachat/server/internal/store"
	"elainachat/server/internal/zipx"
)

const (
	ReadLimit  = 300 * 1024
	WriteLimit = 1024 * 1024
)

var accessLevels = map[string]bool{"off": true, "strict": true, "auto": true, "full": true}

type Handler struct {
	appRoot string
	dataDir string
	store   *store.Store
	log     *logx.Logger

	exeDirOnce sync.Once
	exeDir     string
}

func New(appRoot, dataDir string, dataStore *store.Store, log *logx.Logger) *Handler {
	return &Handler{appRoot: appRoot, dataDir: dataDir, store: dataStore, log: log}
}

// Access 返回本次请求的档位：store 里的设置为准，请求参数只在设置缺失时兜底。
func (h *Handler) Access(param string) string {
	if h.store != nil {
		if data, err := h.store.Load(); err == nil {
			var settings map[string]any
			if json.Unmarshal([]byte(data["elaina_open_settings"]), &settings) == nil {
				if value, ok := settings["agentAccess"].(string); ok && accessLevels[value] {
					return value
				}
			}
		}
	}
	if accessLevels[param] {
		return param
	}
	return "strict"
}

func (h *Handler) logf(format string, args ...any) {
	if h.log != nil {
		h.log.Infof("Agent", format, args...)
	}
}

// Root 是给前端展示的常用位置。用户可把桌面/文档移动到任意位置、OneDrive 也会重定向，
// 权威答案在注册表（HKCU User Shell Folders，见 shellfolders_windows.go）；注册表读不到时
// 才按目录名惯例猜。两处都没有就不列，而不是编一个不存在的路径。
type Root struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Path   string `json:"path,omitempty"`
	Exists bool   `json:"exists"`
}

type rootSpec struct {
	key   string
	label string
	names []string
	env   []string
	reg   []string
}

var rootSpecs = []rootSpec{
	{"home", "主目录", nil, nil, nil},
	{"desktop", "桌面", []string{"Desktop", "桌面"}, []string{"OneDrive"}, []string{"Desktop"}},
	{"documents", "文档", []string{"Documents", "文档"}, nil, []string{"Personal"}},
	{"downloads", "下载", []string{"Downloads", "下载"}, nil, []string{"{374DE290-123F-4565-9164-39C4925E467B}"}},
	{"pictures", "图片", []string{"Pictures", "图片"}, nil, []string{"My Pictures"}},
	{"music", "音乐", []string{"Music", "音乐"}, nil, []string{"My Music"}},
	{"videos", "视频", []string{"Videos", "视频"}, nil, []string{"My Video"}},
}

func (h *Handler) Roots() (string, []Root) {
	home, _ := os.UserHomeDir()
	roots := make([]Root, 0, len(rootSpecs))
	for _, spec := range rootSpecs {
		if spec.key == "home" {
			roots = append(roots, Root{Key: "home", Label: "主目录", Path: home, Exists: isDir(home)})
			continue
		}
		candidates := make([]string, 0, len(spec.names)*2)
		for _, name := range spec.names {
			candidates = append(candidates, filepath.Join(home, name))
			if oneDrive := os.Getenv("OneDrive"); oneDrive != "" {
				candidates = append(candidates, filepath.Join(oneDrive, name))
			}
		}
		picked := ""
		for _, regName := range spec.reg {
			if v := userShellFolders()[regName]; v != "" && isDir(v) {
				picked = v
				break
			}
		}
		if picked == "" {
			for _, candidate := range candidates {
				if isDir(candidate) {
					picked = candidate
					break
				}
			}
		}
		roots = append(roots, Root{Key: spec.key, Label: spec.label, Path: picked, Exists: picked != ""})
	}
	return runtime.GOOS, roots
}

func (h *Handler) aliasMap() map[string]string {
	home, _ := os.UserHomeDir()
	m := map[string]string{
		"home":        home,
		"userprofile": home,
		"~":           home,
	}
	for _, root := range h.mustRoots() {
		if root.Path != "" {
			m[root.Key] = root.Path
		}
	}
	return m
}

func (h *Handler) mustRoots() []Root {
	_, roots := h.Roots()
	return roots
}

// expandPath 支持 %DESKTOP% 这类别名与 ~ / ~desktop：AI 猜不到真实路径时，
// 别名的命中率比绝对路径高。~desktop 形态要求别名后紧跟结尾或路径分隔符，
// 查不到的别名原样保留 —— 别把 ~unknownfood 误展开成主目录。
func (h *Handler) expandPath(raw string) string {
	p := strings.TrimSpace(raw)
	if p == "" {
		return ""
	}
	aliases := h.aliasMap()
	if strings.HasPrefix(p, "~") {
		rest := p[1:]
		if rest == "" || rest[0] == '/' || rest[0] == '\\' {
			p = aliases["home"] + rest
		} else {
			i := 0
			for i < len(rest) && (rest[i] == '_' ||
				(rest[i] >= 'a' && rest[i] <= 'z') || (rest[i] >= 'A' && rest[i] <= 'Z') ||
				(rest[i] >= '0' && rest[i] <= '9')) {
				i++
			}
			if i > 0 {
				if hit, ok := aliases[strings.ToLower(rest[:i])]; ok {
					p = hit + rest[i:]
				}
			}
		}
	}
	var out strings.Builder
	for i := 0; i < len(p); {
		if p[i] == '%' {
			if end := strings.IndexByte(p[i+1:], '%'); end >= 0 {
				name := strings.ToLower(p[i+1 : i+1+end])
				if hit, ok := aliases[name]; ok {
					out.WriteString(hit)
					i += end + 2
					continue
				}
			}
		}
		out.WriteByte(p[i])
		i++
	}
	return out.String()
}

// Resolve 把用户给的路径规范化成绝对路径。这里不做根目录限制：
// 读侧的禁区在 CheckReadable（数据目录与程序目录），写/删的边界在各自档位逻辑里。
func (h *Handler) Resolve(raw string) (string, error) {
	expanded := h.expandPath(raw)
	if expanded == "" {
		return "", errors.New("路径为空")
	}
	abs, err := filepath.Abs(expanded)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

const blockedReadMessage = "该路径在保护范围内（存放访问密钥、会话数据或运行时文件），AI 不能读取"

// CheckReadable 是读侧的硬边界：数据目录（store.json / 密钥表 / session-key / 证书）
// 与服务端可执行文件本身对任何档位都不可读、不可列、不可作为工作目录。
// 不设档位豁免——拿到 session-key 就能离线自签任意会话，这与「AI 能读哪些工作文件」无关。
// 只封 exe 文件本身、不封整个所在目录：开发目录与安装目录里还有大量用户要 AI 读的
// 正常文件（项目代码、日志、插件），按目录封会把它们一起挡掉。
func (h *Handler) CheckReadable(target string) error {
	return h.checkProtected(target, false)
}

const blockedWriteMessage = "该路径在保护范围内（存放访问密钥、会话数据或运行时文件），AI 不能写入或删除"

// CheckMutable 是写/删侧的硬边界，与 CheckReadable 封同一批目标。
//
// 读被挡住、写却放行时，边界是假的：data/ 里的 config.json 是访问密码、session-key 是
// 会话签名密钥、session-epoch 是吊销代数。能写它们就等于能改整机访问权——「禁止删除」
// 档位只挡住了删，改密码和删库在效果上是同一件事（都能把用户锁在外面）。
// 所以这里同样不设档位豁免，full 也不例外：AI 的工作面是用户的工作文件，不是应用的运行数据。
// 与读侧一致，只封数据目录与可执行文件本身，不封它们所在的上级目录。
func (h *Handler) CheckMutable(target string) error {
	return h.checkProtected(target, true)
}

func (h *Handler) checkProtected(target string, forWrite bool) error {
	message := blockedReadMessage
	if forWrite {
		message = blockedWriteMessage
	}
	protected := func(candidate string) bool {
		if h.dataDir != "" && isPathInside(candidate, h.dataDir) {
			return true
		}
		if exe := h.executablePath(); exe != "" && samePath(candidate, exe) {
			return true
		}
		if h.dataDir != "" {
			if resolved, err := fsx.ExistingPathWithin(candidate, h.dataDir); err == nil && isPathInside(resolved, h.dataDir) {
				return true
			}
		}
		if exe := h.executablePath(); exe != "" {
			if resolved, err := fsx.RealPath(candidate); err == nil && samePath(resolved, exe) {
				return true
			}
		}
		return false
	}
	if protected(target) {
		return errors.New(message)
	}
	if h.dataDir != "" {
		if err := fsx.WritablePathWithin(target, h.dataDir); err == nil {
			return errors.New(message)
		}
	}
	return nil
}

// ResolveWorkingDir 只约束命令启动目录；命令本身仍由 Agent 权限档与确认流程约束。
func (h *Handler) ResolveWorkingDir(raw string) (string, error) {
	target := strings.TrimSpace(raw)
	if target == "" {
		wd, err := os.Getwd()
		if err != nil {
			return "", err
		}
		target = wd
	}
	resolved, err := h.Resolve(target)
	if err != nil {
		return "", err
	}
	if err := h.CheckReadable(resolved); err != nil {
		return "", err
	}
	if err := h.CheckMutable(resolved); err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", errors.New("工作目录不存在或不是目录")
	}
	return resolved, nil
}

func (h *Handler) executablePath() string {
	h.exeDirOnce.Do(func() {
		exe, err := os.Executable()
		if err != nil {
			return
		}
		h.exeDir = filepath.Clean(exe)
	})
	return h.exeDir
}

type Entry struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Link bool   `json:"link"`
}

func (h *Handler) List(raw string) (string, []Entry, error) {
	target, err := h.Resolve(raw)
	if err != nil {
		return "", nil, err
	}
	if err := h.CheckReadable(target); err != nil {
		return target, nil, err
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		return target, nil, fmt.Errorf("目录不存在：%s%s", target, h.hint())
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return target, nil, err
	}
	out := make([]Entry, 0, len(entries))
	for _, entry := range entries {
		kind := "file"
		link := false
		if entry.IsDir() {
			kind = "dir"
		} else if !entry.Type().IsRegular() {
			// Windows junction 在 Dirent 里既不是目录也不是普通文件；跟随一次按真实类型归类。
			if real, err := os.Stat(filepath.Join(target, entry.Name())); err == nil && real.IsDir() {
				kind = "dir"
			}
			link = true
		}
		out = append(out, Entry{Name: entry.Name(), Type: kind, Link: link})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type == "dir"
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return target, out, nil
}

func (h *Handler) Read(raw string) (string, string, error) {
	target, err := h.Resolve(raw)
	if err != nil {
		return "", "", err
	}
	if err := h.CheckReadable(target); err != nil {
		return target, "", err
	}
	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() {
		return target, "", fmt.Errorf("文件不存在：%s%s", target, h.hint())
	}
	if info.Size() > ReadLimit {
		return target, "", errors.New("文件过大（>300KB）")
	}
	raw2, err := os.ReadFile(target)
	if err != nil {
		return target, "", err
	}
	return target, string(raw2), nil
}

// Write 返回 (目标路径, needOverwrite 提示对象, 错误)。strict 档需要 overwrite:true。
func (h *Handler) Write(rawPath, content, access string, overwrite bool) (string, map[string]any, error) {
	target, err := h.Resolve(rawPath)
	if err != nil {
		return "", nil, err
	}
	if h.blockedWriteTarget(target, access) {
		return target, nil, errors.New("应用文件夹内不允许写 .html/.js/.svg 等可执行类型的文件（防止同源代码注入）")
	}
	if err := h.CheckMutable(target); err != nil {
		return target, nil, err
	}
	_, statErr := os.Stat(target)
	exists := statErr == nil
	if access == "strict" && !overwrite {
		if exists {
			return target, map[string]any{
				"needOverwrite": true,
				"message":       "目标文件已存在：这次写入会**覆盖**它原有的内容。需要你确认后才能继续。",
			}, errNeedConfirm
		}
		return target, map[string]any{
			"needCreate": true,
			"message":    "AI 想在你的电脑上新建一个文件：" + target + "。需要你确认后才能写入。",
		}, errNeedConfirm
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return target, nil, err
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return target, nil, err
	}
	h.logf("写入 %s（%s，%d 字节）", target, access, len(content))
	return target, nil, nil
}

var errNeedConfirm = errors.New("需要用户确认")

// ErrNeedConfirm 供 HTTP 层区分「确认提示」与真正失败。
func IsNeedConfirm(err error) bool { return errors.Is(err, errNeedConfirm) }

func (h *Handler) Delete(rawPath, access string, confirmed bool) (string, bool, map[string]any, error) {
	target, err := h.Resolve(rawPath)
	if err != nil {
		return "", false, nil, err
	}
	if access == "auto" {
		return target, false, nil, errors.New("当前是「自动通过（禁止删除）」模式，AI 不能删除文件")
	}
	if reason := h.deleteGuard(target); reason != "" {
		return target, false, nil, errors.New(reason)
	}
	if err := h.CheckMutable(target); err != nil {
		return target, false, nil, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return target, false, nil, fmt.Errorf("要删除的东西不存在：%s", target)
	}
	isDir := info.IsDir()
	if access == "strict" && !confirmed {
		return target, isDir, map[string]any{
			"needDelete": true,
			"isDir":      isDir,
			"message": "即将**永久删除**：" + target + "（" +
				choose(isDir, "目录及其全部内容", "文件") + "）。删除后无法恢复，需要你确认。",
		}, errNeedConfirm
	}
	if isDir {
		err = os.RemoveAll(target)
	} else {
		err = os.Remove(target)
	}
	if err != nil {
		return target, isDir, nil, fmt.Errorf("%s：%s", deleteFailureReason(err), target)
	}
	h.logf("删除 %s（%s）", target, access)
	return target, isDir, nil, nil
}

func (h *Handler) blockedWriteTarget(target, access string) bool {
	if access == "full" {
		return false
	}
	appRoot := filepath.Clean(h.appRoot)
	inAppRoot := isPathInside(target, appRoot)
	if !inAppRoot {
		if err := fsx.WritablePathWithin(target, appRoot); err == nil {
			inAppRoot = true
		}
	}
	if !inAppRoot {
		return false
	}
	// 判定必须看「最终落盘名」：NTFS 流名（x.html::$DATA、x.html:ads.txt）与尾点/尾空格
	// 都会让 filepath.Ext 看走眼，而落盘后仍是可执行类型 —— 与 zipx.EffectiveExt 同一语义。
	// EffectiveExt 只接受条目名/文件名，绝对路径要先取 Base，否则盘符的冒号会被当成流名切点。
	switch zipx.EffectiveExt(filepath.Base(target)) {
	case ".html", ".htm", ".xhtml", ".shtml", ".hta", ".mhtml",
		".js", ".mjs", ".cjs", ".jsx", ".ts",
		".svg", ".xml", ".xsl",
		".exe", ".dll", ".com", ".scr", ".msi", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".wsf", ".jar", ".sh":
		return true
	}
	return false
}

func (h *Handler) deleteGuard(target string) string {
	volume := filepath.VolumeName(target) + string(filepath.Separator)
	if samePath(target, filepath.Clean(volume)) {
		return "不能删除盘符根目录：" + target
	}
	projectRoot := filepath.Dir(h.appRoot)
	if samePath(target, projectRoot) {
		return "不能删除项目根目录本身：" + target + "\n（它里面的单个文件可以删，但整个目录不行 —— 那会把应用连根拔掉。）"
	}
	if samePath(target, h.appRoot) {
		return "不能删除应用自己的文件夹本身：" + target + "\n（它里面的单个文件可以删，但整个目录不行 —— 那会把应用连根拔掉。）"
	}
	// web/ 是应用本体（静态根）：它在项目根之下，不挡住的话「删 web/」就绕过了上面的守卫。
	if samePath(target, filepath.Join(h.appRoot, "web")) {
		return "不能删除应用自己的文件夹（web/）本身：" + target + "\n（它里面的单个文件可以删，但整个目录不行 —— 那会把应用连根拔掉。）"
	}
	for _, guard := range []struct{ path, why string }{
		{os.Getenv("SystemRoot"), "系统目录"},
		{os.Getenv("ProgramFiles"), "程序目录"},
	} {
		if guard.path != "" && isPathInside(target, guard.path) {
			return "不能删除" + guard.why + "：" + target
		}
	}
	return ""
}

func (h *Handler) hint() string {
	_, roots := h.Roots()
	parts := make([]string, 0, len(roots))
	for _, root := range roots {
		if root.Path != "" {
			parts = append(parts, root.Label+"="+root.Path)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "。这台电脑的真实位置：" + strings.Join(parts, "、") + "。路径不存在时请直接用上面的绝对路径"
}

func deleteFailureReason(err error) string {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "being used"), strings.Contains(msg, "busy"):
		return "这个文件或目录正被别的程序占用（先关掉它再试）"
	case strings.Contains(msg, "access is denied"), strings.Contains(msg, "permission"):
		return "没有权限删除它（可能是只读，或需要管理员权限）"
	case strings.Contains(msg, "not empty"):
		return "目录非空且其中有删不掉的内容"
	case strings.Contains(msg, "not exist"), strings.Contains(msg, "cannot find"):
		return "它已经不存在了（可能刚被别的程序删掉）"
	}
	return "删除失败（" + err.Error() + "）"
}

func isDir(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func isPathInside(target, dir string) bool {
	return fsx.PathInside(target, dir)
}

func samePath(a, b string) bool {
	ra := filepath.Clean(a)
	rb := filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(ra, rb)
	}
	return ra == rb
}

func choose(cond bool, yes, no string) string {
	if cond {
		return yes
	}
	return no
}
