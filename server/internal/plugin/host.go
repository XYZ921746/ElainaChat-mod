package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"elainachat/server/internal/logx"

	"github.com/dop251/goja"
)

const (
	registerTimeout = 20 * time.Second
	handlerTimeout  = 30 * time.Second
)

type routeRec struct {
	modID   string
	method  string
	prefix  string
	handler goja.Callable
	box     *vmBox
}

type staticRec struct {
	modID string
	url   string
	dir   string
	mime  string
}

// LoadResult 是一个插件的装载结论。失败、未启用、成功要分开报：
// 用户看到接口 404 时，需要知道是「没开」还是「坏了」。
type LoadResult struct {
	ID        string   `json:"id"`
	OK        bool     `json:"ok"`
	Enabled   bool     `json:"enabled"`
	Error     string   `json:"error,omitempty"`
	Entry     string   `json:"entry,omitempty"`
	Routes    []string `json:"routes,omitempty"`
	Uploads   []string `json:"uploads,omitempty"`
	Signature string   `json:"signature,omitempty"`
}

type Status struct {
	LoadedAt time.Time    `json:"loadedAt"`
	Mods     []LoadResult `json:"mods"`
}

type Host struct {
	modsDir string
	log     *logx.Logger

	mu          sync.Mutex
	routes      []*routeRec
	statics     []*staticRec
	uploadRoots map[string]struct{}
	loaded      map[string]*LoadResult
	loadedAt    time.Time
}

func New(modsDir string, log *logx.Logger) *Host {
	return &Host{
		modsDir:     modsDir,
		log:         log,
		uploadRoots: make(map[string]struct{}),
		loaded:      make(map[string]*LoadResult),
	}
}

func (h *Host) logf(level, format string, args ...any) {
	if h.log == nil {
		return
	}
	switch level {
	case "warn":
		h.log.Warnf("Mod", format, args...)
	case "error":
		h.log.Errorf("Mod", format, args...)
	default:
		h.log.Infof("Mod", format, args...)
	}
}

// LoadAll 只在服务启动时调用一次：路由是常驻注册表，运行中热加载会让
// 「哪些接口存在」随运行状态漂移，出问题时无法复现。
func (h *Host) LoadAll(modules []Module, isEnabled func(Module) bool) Status {
	h.loadedAt = time.Now()
	for _, module := range modules {
		decl, err := ReadDeclaration(module)
		if err != nil {
			h.loaded[module.ID] = &LoadResult{ID: module.ID, OK: false, Enabled: true, Error: err.Error()}
			h.logf("warn", "[%s] 服务端半边未装载：%v", module.ID, err)
			continue
		}
		if decl == nil {
			continue
		}
		if isEnabled != nil && !isEnabled(module) {
			h.loaded[module.ID] = &LoadResult{
				ID: module.ID, OK: false, Enabled: false,
				Error: "插件未启用（到「设置 → 插件」打开开关，然后重启服务）",
			}
			h.logf("info", "[%s] 服务端半边未装载：插件未启用", module.ID)
			continue
		}
		h.loadOne(module, decl)
	}
	return h.Status()
}

func (h *Host) loadOne(module Module, decl *ServerDecl) {
	dir := filepath.Join(h.modsDir, module.Dir)

	if err := h.checkCollision(module, decl); err != nil {
		h.loaded[module.ID] = &LoadResult{ID: module.ID, OK: false, Enabled: true, Error: err.Error()}
		h.logf("warn", "[%s] 服务端半边未装载：%v", module.ID, err)
		return
	}

	entryPath := filepath.Join(dir, filepath.FromSlash(decl.Entry))
	if rel, err := filepath.Rel(dir, entryPath); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		h.loaded[module.ID] = &LoadResult{ID: module.ID, OK: false, Enabled: true, Error: "server.entry 解析后越出了插件目录：" + decl.Entry}
		return
	}
	info, err := os.Stat(entryPath)
	if err != nil || !info.Mode().IsRegular() {
		h.loaded[module.ID] = &LoadResult{ID: module.ID, OK: false, Enabled: true, Error: "server.entry 不存在：" + decl.Entry}
		h.logf("warn", "[%s] 服务端半边未装载：server.entry 不存在：%s", module.ID, decl.Entry)
		return
	}
	raw, err := os.ReadFile(entryPath)
	if err != nil {
		h.loaded[module.ID] = &LoadResult{ID: module.ID, OK: false, Enabled: true, Error: "读取 server.entry 失败：" + err.Error()}
		return
	}
	source, err := prepareSource(string(raw))
	if err != nil {
		h.loaded[module.ID] = &LoadResult{ID: module.ID, OK: false, Enabled: true, Error: err.Error()}
		h.logf("warn", "[%s] 服务端半边未装载：%v", module.ID, err)
		return
	}

	vm := goja.New()
	box := &vmBox{vm: vm, mu: newSyncMutex()}
	caps := make(map[string]bool, len(decl.Capabilities))
	for _, c := range decl.Capabilities {
		caps[c] = true
	}
	added := []contribution{}
	builder := &ctxBuilder{host: h, module: module, dir: dir, decl: decl, caps: caps, box: box, added: &added}
	// 插件在 register 里 panic（宿主 Go 代码的缺陷或病态输入）时不能把装载流程带走：
	// 回滚已登记的贡献并记成"装载失败"，与错误返回走同一条路。
	defer func() {
		if r := recover(); r != nil {
			h.failLoad(module, &added, fmt.Sprintf("装载时 panic：%v", r))
		}
	}()

	if _, err := runBounded(vm, registerTimeout, func() (goja.Value, error) {
		return vm.RunString(source)
	}); err != nil {
		h.failLoad(module, &added, "装载 server.entry 失败："+err.Error())
		return
	}
	register, ok := goja.AssertFunction(vm.Get("register"))
	if !ok {
		h.failLoad(module, &added, "服务端入口没有导出 register(ctx) 函数")
		return
	}
	ctxValue := vm.ToValue(builder.contextObject())
	if _, err := h.call(box, register, registerTimeout, ctxValue); err != nil {
		h.failLoad(module, &added, "调用 register(ctx) 失败："+err.Error())
		return
	}

	result := &LoadResult{
		ID: module.ID, OK: true, Enabled: true, Entry: decl.Entry,
		Routes:    append([]string{}, decl.Routes...),
		Uploads:   append([]string{}, decl.Uploads...),
		Signature: decl.Signature,
	}
	h.loaded[module.ID] = result
	h.logf("info", "[%s] 服务端半边已装载%s", module.ID,
		suffixRoutes(decl.Routes, decl.Statics, decl.Uploads))
}

// failLoad 回滚本次登记：半个装载（注册了一个路由、第二个抛错）比完全没装更难理解 ——
// 接口一半能用一半 404，而清单上写着「已装载」。
func (h *Host) failLoad(module Module, added *[]contribution, message string) {
	h.mu.Lock()
	for _, a := range *added {
		switch a.kind {
		case "route":
			h.removeRouteLocked(a.route)
		case "static":
			for i, s := range h.statics {
				if s == a.static {
					h.statics = append(h.statics[:i], h.statics[i+1:]...)
					break
				}
			}
		case "upload":
			delete(h.uploadRoots, a.upload)
		}
	}
	h.mu.Unlock()
	h.loaded[module.ID] = &LoadResult{ID: module.ID, OK: false, Enabled: true, Error: message}
	h.logf("warn", "[%s] 服务端半边装载失败（已隔离，不影响其它插件与服务本身）：%s", module.ID, message)
}

func (h *Host) removeRouteLocked(rec *routeRec) {
	for i, r := range h.routes {
		if r == rec {
			h.routes = append(h.routes[:i], h.routes[i+1:]...)
			return
		}
	}
}

func (h *Host) checkCollision(module Module, decl *ServerDecl) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, route := range decl.Routes {
		for _, host := range HostRoutes {
			if prefixesOverlap(route, host) {
				return fmt.Errorf("路由「%s」与宿主占用的「%s」重叠", route, host)
			}
		}
		for _, existing := range h.routes {
			if prefixesOverlap(route, existing.prefix) {
				return fmt.Errorf("路由「%s」与插件 %s 的「%s」重叠", route, existing.modID, existing.prefix)
			}
		}
	}
	for _, st := range decl.Statics {
		for _, host := range HostStatics {
			if prefixesOverlap(st.URL, host) {
				return fmt.Errorf("静态前缀「%s」与宿主占用的「%s」重叠", st.URL, host)
			}
		}
		for _, existing := range h.statics {
			if prefixesOverlap(st.URL, existing.url) {
				return fmt.Errorf("静态前缀「%s」与插件 %s 的「%s」重叠", st.URL, existing.modID, existing.url)
			}
		}
	}
	return nil
}

func suffixRoutes(routes []string, statics []StaticDecl, uploads []string) string {
	var parts []string
	if len(routes) > 0 {
		parts = append(parts, "路由 "+strings.Join(routes, "、"))
	}
	if len(statics) > 0 {
		parts = append(parts, "静态 "+staticURLs(statics))
	}
	if len(uploads) > 0 {
		parts = append(parts, "上传目录 "+strings.Join(uploads, "、"))
	}
	if len(parts) == 0 {
		return ""
	}
	return "：" + strings.Join(parts, "；")
}

// prepareSource 只允许 `export function register(ctx)`：
// goja 不认 ESM，且收窄契约本来就不允许插件 import 任何东西。
func prepareSource(src string) (string, error) {
	if regexp.MustCompile(`(?m)^\s*import\s`).MatchString(src) || regexp.MustCompile(`\bimport\s*\(`).MatchString(src) {
		return "", errors.New("禁止 import：插件只能使用 ctx 提供的能力")
	}
	if regexp.MustCompile(`\brequire\s*\(`).MatchString(src) {
		return "", errors.New("禁止 require：插件只能使用 ctx 提供的能力")
	}
	transformed := regexp.MustCompile(`(?m)^(\s*)export\s+((?:async\s+)?function\s+register\s*\()`).
		ReplaceAllString(src, "$1$2")
	if regexp.MustCompile(`(?m)^\s*export\s`).MatchString(transformed) {
		return "", errors.New("只允许 `export function register(ctx)` 这一种导出")
	}
	return transformed, nil
}

func (h *Host) call(box *vmBox, fn goja.Callable, timeout time.Duration, args ...goja.Value) (goja.Value, error) {
	value, err := runBounded(box.vm, timeout, func() (goja.Value, error) {
		return fn(goja.Undefined(), args...)
	})
	if err != nil {
		return nil, err
	}
	promise, ok := value.Export().(*goja.Promise)
	if !ok {
		return value, nil
	}
	deadline := time.Now().Add(timeout)
	for {
		switch promise.State() {
		case goja.PromiseStateFulfilled:
			return promise.Result(), nil
		case goja.PromiseStateRejected:
			return nil, promiseError(promise.Result())
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("执行超时（%s）", timeout)
		}
		if _, err := box.vm.RunString(""); err != nil {
			return nil, err
		}
		time.Sleep(time.Millisecond)
	}
}

// runBounded 给一段 VM 同步执行套上超时。超时机制如果只轮询 Promise，同步死循环
// （插件 register 或路由处理器里一个写坏的 while）会把启动或请求 goroutine 永久挂死；
// 到点用 vm.Interrupt 把执行强制掐断，插件被记成装载/处理失败，服务照常活着。
type interruptGuard struct {
	mu    sync.Mutex
	vm    *goja.Runtime
	fired bool
}

func (g *interruptGuard) fire() {
	g.mu.Lock()
	g.fired = true
	g.vm.Interrupt(errors.New("插件同步代码执行超时"))
	g.mu.Unlock()
}

// clear 必须在返回前调用：Interrupt 可能落在本次调用已经结束之后（定时器晚触发），
// 残留的中断会把插件的下一次无辜调用立即杀掉。
func (g *interruptGuard) clear() {
	g.mu.Lock()
	if g.fired {
		g.vm.ClearInterrupt()
		g.fired = false
	}
	g.mu.Unlock()
}

func (g *interruptGuard) wasFired() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.fired
}

func runBounded(vm *goja.Runtime, timeout time.Duration, fn func() (goja.Value, error)) (goja.Value, error) {
	guard := &interruptGuard{vm: vm}
	timer := time.AfterFunc(timeout, guard.fire)
	defer func() {
		timer.Stop()
		guard.clear()
	}()
	value, err := fn()
	if err == nil {
		return value, nil
	}
	var interrupted *goja.InterruptedError
	if errors.As(err, &interrupted) && guard.wasFired() {
		return nil, fmt.Errorf("同步执行超时（>%s），已强制中断", timeout)
	}
	return nil, err
}

func promiseError(value goja.Value) error {
	if value == nil {
		return errors.New("插件 Promise 被拒绝")
	}
	if exported := value.Export(); exported != nil {
		if err, ok := exported.(error); ok {
			return err
		}
	}
	return errors.New(value.String())
}

// Handle 分发一条插件路由，返回 true 表示已处理（响应也写出去了）。
// 必须排在宿主路由之后、静态文件之前：宿主永远优先。
func (h *Host) Handle(w http.ResponseWriter, r *http.Request) bool {
	pathname := r.URL.Path
	h.mu.Lock()
	candidates := make([]*routeRec, 0, len(h.routes))
	for _, rec := range h.routes {
		if rec.method != "*" && rec.method != r.Method {
			continue
		}
		if pathname != rec.prefix && !strings.HasPrefix(pathname, rec.prefix+"/") {
			continue
		}
		candidates = append(candidates, rec)
	}
	h.mu.Unlock()
	if len(candidates) == 0 {
		return false
	}

	body, tooLarge, err := readPluginBody(r)
	if err != nil {
		writePluginJSON(w, 400, map[string]any{"ok": false, "message": "读取请求体失败：" + err.Error()})
		return true
	}
	if tooLarge {
		writePluginJSON(w, 413, map[string]any{"ok": false, "message": fmt.Sprintf("请求体超过 %dMB 上限", MaxUpload/1024/1024)})
		return true
	}

	for _, rec := range candidates {
		rest := strings.TrimPrefix(pathname, rec.prefix)
		reqObj := map[string]any{
			"method":  r.Method,
			"path":    pathname,
			"query":   queryMap(r.URL.Query()),
			"headers": headerMap(r.Header),
			"body":    body,
		}
		infoObj := map[string]any{"pathname": pathname, "rest": rest, "modId": rec.modID}
		res := &jsResponse{}

		rec.box.mu.lock()
		result, callErr := h.callSafely(rec.modID, pathname, func() (goja.Value, error) {
			return h.call(rec.box, rec.handler, handlerTimeout,
				rec.box.vm.ToValue(reqObj), rec.box.vm.ToValue(res), rec.box.vm.ToValue(infoObj))
		})
		rec.box.mu.unlock()

		if callErr != nil {
			h.logf("error", "[%s] 处理 %s 时出错：%v", rec.modID, pathname, callErr)
			writePluginJSON(w, 500, map[string]any{
				"ok": false, "message": "插件 " + rec.modID + " 处理请求失败：" + callErr.Error(),
			})
			return true
		}
		if result != nil && !goja.IsUndefined(result) && !goja.IsNull(result) && result.ToBoolean() == false && !res.started() {
			continue // 明确不处理，看看后面的路由
		}
		res.writeTo(w)
		return true
	}
	return false
}

// callSafely 把插件处理函数里的 panic 收成错误：goja 的 JS 异常会以 error 返回，
// 但宿主 Go 代码在插件回调里 panic 时没有这层兜底 —— 它会一路冒到 net/http 的连接级
// recover，表现为连接被断、没有 500、插件卡片上也看不到原因。
func (h *Host) callSafely(modID, pathname string, fn func() (goja.Value, error)) (result goja.Value, err error) {
	defer func() {
		if r := recover(); r != nil {
			h.logf("error", "[%s] 处理 %s 时 panic：%v", modID, pathname, r)
			result = nil
			err = fmt.Errorf("插件内部错误（panic）：%v", r)
		}
	}()
	return fn()
}

// readPluginBody 只在真的要交给插件时才读：没有匹配路由的请求不该被缓冲。
func readPluginBody(r *http.Request) ([]byte, bool, error) {
	if r.Body == nil {
		return nil, false, nil
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, MaxUpload+1))
	if err != nil {
		return nil, false, err
	}
	if len(data) > MaxUpload {
		return nil, true, nil
	}
	return data, false, nil
}

type jsResponse struct {
	status  int
	headers map[string]string
	body    []byte
	written bool
}

func (r *jsResponse) started() bool { return r.written }

func (r *jsResponse) setJSON(status int, payload []byte) {
	if status <= 0 {
		status = 200
	}
	if r.headers == nil {
		r.headers = make(map[string]string)
	}
	r.headers["Content-Type"] = "application/json; charset=utf-8"
	r.status = status
	r.body = payload
	r.written = true
}

func (r *jsResponse) writeTo(w http.ResponseWriter) {
	status := r.status
	if status <= 0 {
		status = http.StatusOK
	}
	for key, value := range r.headers {
		w.Header().Set(key, value)
	}
	if w.Header().Get("Content-Type") == "" && len(r.body) > 0 {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(r.body)
}

func writePluginJSON(w http.ResponseWriter, status int, payload any) {
	raw, _ := json.Marshal(payload)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func queryMap(values url.Values) map[string]string {
	out := make(map[string]string, len(values))
	for key, list := range values {
		if len(list) > 0 {
			out[key] = list[0]
		}
	}
	return out
}

func headerMap(headers http.Header) map[string]string {
	out := make(map[string]string, len(headers))
	for key, list := range headers {
		out[strings.ToLower(key)] = strings.Join(list, ", ")
	}
	return out
}

// ResolveStatic 把 URL 解析成插件静态目录里的真实文件。
// 段边界、解码后再解析、解析后仍在目录内——三道都要，少一道就是路径穿越。
func (h *Host) ResolveStatic(pathname string) (abs, mimeMode, modID string, ok bool) {
	h.mu.Lock()
	statics := append([]*staticRec{}, h.statics...)
	h.mu.Unlock()

	for _, s := range statics {
		if pathname != s.url && !strings.HasPrefix(pathname, s.url+"/") {
			continue
		}
		rel := strings.TrimPrefix(pathname, s.url)
		rel = strings.TrimLeft(rel, "/")
		decoded, err := url.PathUnescape(rel)
		if err != nil {
			return "", "", "", false
		}
		segs := strings.FieldsFunc(decoded, func(r rune) bool { return r == '/' || r == '\\' })
		for _, seg := range segs {
			if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, ".") {
				return "", "", "", false
			}
		}
		target := filepath.Join(s.dir, filepath.FromSlash(strings.Join(segs, "/")))
		if relCheck, err := filepath.Rel(s.dir, target); err != nil || relCheck == ".." || strings.HasPrefix(relCheck, ".."+string(filepath.Separator)) {
			return "", "", "", false
		}
		// 中间目录组件也可能是符号链接：Lstat 只拒末级链接，
		// dir/link/x 里的 link 指向目录外时 Lstat 会跟着走进去。把整条真实路径
		// 解析出来再对真实根做前缀比对，穿越才算封死。
		realRoot, rootErr := filepath.EvalSymlinks(s.dir)
		realTarget, targetErr := filepath.EvalSymlinks(target)
		if rootErr != nil || targetErr != nil {
			return "", "", "", false
		}
		realPrefix := realRoot + string(filepath.Separator)
		if len(realTarget) <= len(realRoot) || !strings.EqualFold(realTarget[:len(realPrefix)], realPrefix) {
			return "", "", "", false
		}
		info, err := os.Lstat(target)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return "", "", "", false
		}
		return target, s.mime, s.modID, true
	}
	return "", "", "", false
}

func (h *Host) UploadRoots() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.uploadRoots))
	for root := range h.uploadRoots {
		out = append(out, root)
	}
	return out
}

func (h *Host) IsUploadPath(abs string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for root := range h.uploadRoots {
		prefix := root + string(filepath.Separator)
		if len(abs) <= len(root) {
			continue
		}
		// 大小写不敏感比较：Windows 文件系统不区分大小写，URL 里换一种写法
		// （/mods/Gallery/ → gallery）就能让 octet-stream 强制落空。
		if strings.EqualFold(abs[:len(prefix)], prefix) {
			return true
		}
	}
	return false
}

func (h *Host) Status() Status {
	h.mu.Lock()
	defer h.mu.Unlock()
	mods := make([]LoadResult, 0, len(h.loaded))
	for _, result := range h.loaded {
		mods = append(mods, *result)
	}
	return Status{LoadedAt: h.loadedAt, Mods: mods}
}

// Statics 返回已装载的静态映射（URL 前缀 + 绝对目录）。手机端 /api/ping 要把
// relPath 报给前端：它决定模型文件在 filesDir 下的哪一段，前端据此拼 Capacitor 文件 URL。
func (h *Host) Statics() []StaticDecl {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]StaticDecl, 0, len(h.statics))
	for _, rec := range h.statics {
		out = append(out, StaticDecl{URL: rec.url, Dir: rec.dir, Mime: rec.mime})
	}
	return out
}

// StatusView 是 /api/plugins 的 serverRoutes 字段：装载结论之外还要区分
// 「需要重启」与「装载失败」——用户要做的动作完全不同。
type StatusView struct {
	LoadedAt     time.Time        `json:"loadedAt"`
	Mods         []LoadResult     `json:"mods"`
	NeedsRestart []map[string]any `json:"needsRestart"`
	Failed       []map[string]any `json:"failed"`
}

// StatusFor 按当前磁盘上的插件清单核对常驻注册表。路由只在启动时装载，
// 运行中新增或改了声明都必须如实报 needsRestart，而不是让用户面对静默 404。
func (h *Host) StatusFor(installed []Module) StatusView {
	h.mu.Lock()
	defer h.mu.Unlock()
	mods := make([]LoadResult, 0, len(h.loaded))
	for _, result := range h.loaded {
		mods = append(mods, *result)
	}
	view := StatusView{LoadedAt: h.loadedAt, Mods: mods, NeedsRestart: []map[string]any{}, Failed: []map[string]any{}}
	for _, module := range installed {
		decl, err := ReadDeclaration(module)
		if err != nil || decl == nil {
			continue
		}
		cur, ok := h.loaded[module.ID]
		if !ok {
			view.NeedsRestart = append(view.NeedsRestart, map[string]any{
				"id": module.ID, "why": "服务启动时还没有这个插件，重启服务后它的服务端接口才会生效",
			})
			continue
		}
		if !cur.OK && !cur.Enabled {
			continue
		}
		if !cur.OK {
			view.Failed = append(view.Failed, map[string]any{"id": module.ID, "error": cur.Error})
			continue
		}
		if cur.Signature != decl.Signature {
			view.NeedsRestart = append(view.NeedsRestart, map[string]any{
				"id": module.ID, "why": "该插件的服务端声明变了，重启服务后生效",
			})
		}
	}
	return view
}
