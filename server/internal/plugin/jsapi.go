package plugin

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"

	"elainachat/server/internal/fsx"

	"github.com/dop251/goja"
)

// maxExecOutput 是 ctx.exec 单条流的输出上限。没有上限时，一条输出很大的命令
// （dir /s、读大文件）会把服务端内存吃光；与 Node 宿主的 maxBuffer 对齐。
const maxExecOutput = 32 * 1024 * 1024

// cappedBuffer 只保留前 limit 字节，之后继续吞掉输出并记下"已截断"。
// 超限时必须返回 len(p)、不能返回错误：给 exec 的 copy goroutine 报错会连带杀掉子进程。
type cappedBuffer struct {
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	room := c.limit - c.buf.Len()
	if room >= len(p) {
		_, _ = c.buf.Write(p)
		return len(p), nil
	}
	if room > 0 {
		_, _ = c.buf.Write(p[:room])
	}
	c.truncated = true
	return len(p), nil
}

func (c *cappedBuffer) String() string { return c.buf.String() }

// vmBox 让一个插件的所有调用串行化：goja 的 Runtime 不是并发安全的，
// 而 HTTP 请求本来就并发；同一插件串行执行也与 Node 单线程的语义一致。
type vmBox struct {
	vm *goja.Runtime
	mu *syncMutex
}

// syncMutex 是 sync.Mutex 的薄封装，单独定义只是为了让 vmBox 不直接暴露 sync 类型。
type syncMutex struct {
	ch chan struct{}
}

func newSyncMutex() *syncMutex {
	m := &syncMutex{ch: make(chan struct{}, 1)}
	m.ch <- struct{}{}
	return m
}

func (m *syncMutex) lock()   { <-m.ch }
func (m *syncMutex) unlock() { m.ch <- struct{}{} }

type ctxBuilder struct {
	host   *Host
	module Module
	dir    string
	decl   *ServerDecl
	caps   map[string]bool
	box    *vmBox
	added  *[]contribution
}

type contribution struct {
	kind   string
	route  *routeRec
	static *staticRec
	upload string
}

func (b *ctxBuilder) need(cap, what string) {
	if b.caps[cap] {
		return
	}
	declared := make([]string, 0, len(b.caps))
	for name := range b.caps {
		declared = append(declared, name)
	}
	panic(b.box.vm.NewGoError(fmt.Errorf(
		"插件「%s」没有声明能力 %s，不能使用 %s。要使用它，请在 manifest.json 的 server.capabilities 里加上「%s」。（已声明：%s）",
		b.module.ID, cap, what, cap, strings.Join(declared, "、"))))
}

// safePath 把插件给的路径限制在插件目录内。这是 ctx.fs 的边界：
// 收窄 API 的意义就是插件摸不到别人的目录，路径校验不能只写在文档里。
func (b *ctxBuilder) safePath(raw string) (string, error) {
	return b.resolvePath(raw, false)
}

func (b *ctxBuilder) safeWritePath(raw string) (string, error) {
	return b.resolvePath(raw, true)
}

func (b *ctxBuilder) resolvePath(raw string, forWrite bool) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", errors.New("路径为空")
	}
	target := raw
	if !filepath.IsAbs(target) {
		target = filepath.Join(b.dir, target)
	}
	outside := func() error { return fmt.Errorf("路径越出了插件目录：%s", raw) }
	if !fsx.PathInside(target, b.dir) {
		return "", outside()
	}
	var err error
	if forWrite {
		err = fsx.WritablePathWithin(target, b.dir)
	} else {
		_, err = fsx.ExistingPathWithin(target, b.dir)
	}
	if err != nil {
		return "", outside()
	}
	return target, nil
}

// promiseSync 把同步结果包成 Promise：插件习惯 `await` / `.catch`，
// 直接抛错会让 `.catch(...)` 变成 "undefined is not a function"。
func promiseSync(vm *goja.Runtime, fn func() (any, error)) goja.Value {
	p, resolve, reject := vm.NewPromise()
	value, err := fn()
	if err != nil {
		_ = reject(vm.NewGoError(err))
	} else {
		_ = resolve(vm.ToValue(value))
	}
	return vm.ToValue(p)
}

func (b *ctxBuilder) contextObject() map[string]any {
	vm := b.box.vm
	return map[string]any{
		"modId": b.module.ID,
		"dir":   b.dir,
		"log": func(call goja.FunctionCall) goja.Value {
			parts := make([]string, 0, len(call.Arguments))
			for _, arg := range call.Arguments {
				parts = append(parts, arg.String())
			}
			b.host.logf("info", "[%s] %s", b.module.ID, strings.Join(parts, " "))
			return goja.Undefined()
		},
		"capabilities": func() []string {
			out := make([]string, 0, len(b.caps))
			for name := range b.caps {
				out = append(out, name)
			}
			return out
		},
		"hasCapability": func(name string) bool { return b.caps[name] },

		"json": func(call goja.FunctionCall) goja.Value {
			res, ok := call.Argument(0).Export().(*jsResponse)
			if !ok {
				panic(vm.NewTypeError("ctx.json 的第一个参数必须是宿主传入的 res"))
			}
			status := int(call.Argument(1).ToInteger())
			var payload []byte
			if obj := call.Argument(2); !goja.IsUndefined(obj) && !goja.IsNull(obj) {
				payload, _ = json.Marshal(obj.Export())
			}
			if payload == nil {
				payload = []byte("null")
			}
			res.setJSON(status, payload)
			return goja.Undefined()
		},
		"readJson": func(call goja.FunctionCall) goja.Value {
			req, ok := call.Argument(0).Export().(map[string]any)
			if !ok {
				panic(vm.NewTypeError("ctx.readJson 需要一个请求对象"))
			}
			body, _ := req["body"].([]byte)
			if len(body) == 0 {
				return vm.ToValue(map[string]any{})
			}
			var parsed any
			if err := json.Unmarshal(body, &parsed); err != nil {
				panic(vm.NewGoError(errors.New("请求体不是合法 JSON")))
			}
			return vm.ToValue(parsed)
		},

		"route":     b.routeFn,
		"staticDir": b.staticDirFn,
		"uploadDir": b.uploadDirFn,

		"fs":   b.fsObject(),
		"path": b.pathObject(),
		"zip":  b.zipObject(),
		"exec": func(call goja.FunctionCall) goja.Value {
			b.need("exec", "ctx.exec（执行本机命令）")
			return b.execFn(call)
		},
		"base64": map[string]any{
			"encodeUtf16LE": func(text string) string {
				units := utf16.Encode([]rune(text))
				raw := make([]byte, 0, len(units)*2)
				for _, u := range units {
					raw = append(raw, byte(u), byte(u>>8))
				}
				return base64.StdEncoding.EncodeToString(raw)
			},
		},
		"utils": b.utilsObject(),
	}
}

func (b *ctxBuilder) routeFn(call goja.FunctionCall) goja.Value {
	b.need("route-register", "ctx.route（注册 /api 路由）")
	method := strings.ToUpper(strings.TrimSpace(call.Argument(0).String()))
	if method == "UNDEFINED" || method == "" {
		method = "GET"
	}
	target := strings.TrimSpace(call.Argument(1).String())
	if method != "*" && method != "GET" && method != "POST" && method != "PUT" && method != "PATCH" && method != "DELETE" && method != "HEAD" {
		panic(b.box.vm.NewGoError(fmt.Errorf("不支持的方法：%s", method)))
	}
	within := false
	for _, prefix := range b.decl.Routes {
		if target == prefix || strings.HasPrefix(target, prefix+"/") {
			within = true
			break
		}
	}
	if !within {
		panic(b.box.vm.NewGoError(fmt.Errorf(
			"路由「%s」没有落在 manifest.json 的 server.routes 声明之内（已声明：%s）",
			target, strings.Join(b.decl.Routes, "、"))))
	}
	if !routeRe.MatchString(target) {
		panic(b.box.vm.NewGoError(fmt.Errorf("路由「%s」不是合法的接口路径", target)))
	}
	handler, ok := goja.AssertFunction(call.Argument(2))
	if !ok {
		panic(b.box.vm.NewTypeError("ctx.route 需要处理函数"))
	}
	rec := &routeRec{modID: b.module.ID, method: method, prefix: target, handler: handler, box: b.box}
	b.host.mu.Lock()
	b.host.routes = append(b.host.routes, rec)
	b.host.mu.Unlock()
	*b.added = append(*b.added, contribution{kind: "route", route: rec})

	vm := b.box.vm
	return vm.ToValue(func() {
		b.host.mu.Lock()
		defer b.host.mu.Unlock()
		for i, existing := range b.host.routes {
			if existing == rec {
				b.host.routes = append(b.host.routes[:i], b.host.routes[i+1:]...)
				break
			}
		}
	})
}

func (b *ctxBuilder) staticDirFn(url string) string {
	b.need("static-read", "ctx.staticDir（读静态目录）")
	u := strings.TrimSpace(url)
	var hit *StaticDecl
	for i := range b.decl.Statics {
		if b.decl.Statics[i].URL == u {
			hit = &b.decl.Statics[i]
			break
		}
	}
	if hit == nil {
		panic(b.box.vm.NewGoError(fmt.Errorf(
			"静态前缀「%s」没有在 manifest.json 的 server.static 里声明（已声明：%s）",
			u, staticURLs(b.decl.Statics))))
	}
	abs := filepath.Join(b.dir, filepath.FromSlash(hit.Dir))
	if rel, err := filepath.Rel(b.dir, abs); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		panic(b.box.vm.NewGoError(fmt.Errorf("静态目录越出了插件目录：%s", hit.Dir)))
	}
	rec := &staticRec{modID: b.module.ID, url: hit.URL, dir: abs, mime: hit.Mime}
	b.host.mu.Lock()
	b.host.statics = append(b.host.statics, rec)
	b.host.mu.Unlock()
	*b.added = append(*b.added, contribution{kind: "static", static: rec})
	return abs
}

func (b *ctxBuilder) uploadDirFn(rel string) string {
	b.need("upload-write", "ctx.uploadDir（读写上传目录）")
	r := filepath.ToSlash(strings.TrimSpace(rel))
	declared := false
	for _, u := range b.decl.Uploads {
		if u == r {
			declared = true
			break
		}
	}
	if !declared {
		panic(b.box.vm.NewGoError(fmt.Errorf(
			"上传目录「%s」没有在 manifest.json 的 server.uploads 里声明（已声明：%s）",
			r, strings.Join(b.decl.Uploads, "、"))))
	}
	abs := filepath.Join(b.dir, filepath.FromSlash(r))
	if relCheck, err := filepath.Rel(b.dir, abs); err != nil || relCheck == ".." || strings.HasPrefix(relCheck, ".."+string(filepath.Separator)) {
		panic(b.box.vm.NewGoError(fmt.Errorf("上传目录越出了插件目录：%s", r)))
	}
	b.host.mu.Lock()
	b.host.uploadRoots[abs] = struct{}{}
	b.host.mu.Unlock()
	*b.added = append(*b.added, contribution{kind: "upload", upload: abs})
	return abs
}

func (b *ctxBuilder) fsObject() map[string]any {
	vm := b.box.vm

	return map[string]any{
		"readFile": func(raw string) goja.Value {
			b.need("fs-read", "ctx.fs.readFile（读文件）")
			return promiseSync(vm, func() (any, error) {
				target, err := b.safePath(raw)
				if err != nil {
					return nil, err
				}
				data, err := os.ReadFile(target)
				if err != nil {
					return nil, err
				}
				return string(data), nil
			})
		},
		"readdir": func(raw string) goja.Value {
			b.need("fs-read", "ctx.fs.readdir（列目录）")
			return promiseSync(vm, func() (any, error) {
				target, err := b.safePath(raw)
				if err != nil {
					return nil, err
				}
				entries, err := os.ReadDir(target)
				if err != nil {
					return nil, err
				}
				out := make([]any, 0, len(entries))
				for _, entry := range entries {
					name := entry.Name()
					isDir := entry.IsDir()
					out = append(out, map[string]any{
						"name":        name,
						"isDirectory": func() bool { return isDir },
						"isFile":      func() bool { return !isDir },
					})
				}
				return out, nil
			})
		},
		"stat": func(raw string) goja.Value {
			b.need("fs-read", "ctx.fs.stat（文件信息）")
			return promiseSync(vm, func() (any, error) {
				target, err := b.safePath(raw)
				if err != nil {
					return nil, err
				}
				info, err := os.Stat(target)
				if err != nil {
					return nil, err
				}
				isDir := info.IsDir()
				return map[string]any{
					"size":        info.Size(),
					"isDirectory": func() bool { return isDir },
					"isFile":      func() bool { return !isDir },
				}, nil
			})
		},
		"writeFile": func(raw string, data goja.Value) goja.Value {
			b.need("fs-write", "ctx.fs.writeFile（写文件）")
			return promiseSync(vm, func() (any, error) {
				target, err := b.safeWritePath(raw)
				if err != nil {
					return nil, err
				}
				if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
					return nil, err
				}
				switch v := data.Export().(type) {
				case []byte:
					return nil, os.WriteFile(target, v, 0o644)
				case string:
					return nil, os.WriteFile(target, []byte(v), 0o644)
				default:
					return nil, fmt.Errorf("writeFile 只接受字符串或 Uint8Array")
				}
			})
		},
		"mkdir": func(raw string) goja.Value {
			b.need("fs-write", "ctx.fs.mkdir（建目录）")
			return promiseSync(vm, func() (any, error) {
				target, err := b.safeWritePath(raw)
				if err != nil {
					return nil, err
				}
				return nil, os.MkdirAll(target, 0o755)
			})
		},
		"rm": func(raw string) goja.Value {
			b.need("fs-write", "ctx.fs.rm（删除）")
			return promiseSync(vm, func() (any, error) {
				target, err := b.safePath(raw)
				if err != nil {
					return nil, err
				}
				if fsx.PathInside(b.dir, target) {
					return nil, errors.New("不能删除插件根目录")
				}
				return nil, os.RemoveAll(target)
			})
		},
		"rename": func(from, to string) goja.Value {
			b.need("fs-write", "ctx.fs.rename（重命名）")
			return promiseSync(vm, func() (any, error) {
				src, err := b.safePath(from)
				if err != nil {
					return nil, err
				}
				dst, err := b.safeWritePath(to)
				if err != nil {
					return nil, err
				}
				return nil, os.Rename(src, dst)
			})
		},
	}
}

func (b *ctxBuilder) pathObject() map[string]any {
	return map[string]any{
		"join":     func(parts ...string) string { return filepath.Join(parts...) },
		"basename": filepath.Base,
		"dirname":  filepath.Dir,
		"sep":      string(filepath.Separator),
		"posix": map[string]any{
			"basename": path.Base,
			"dirname":  path.Dir,
			"join":     func(parts ...string) string { return path.Join(parts...) },
		},
	}
}

func (b *ctxBuilder) zipObject() map[string]any {
	vm := b.box.vm
	return map[string]any{
		"maxUpload": MaxUpload,
		"unzip": func(data []byte) goja.Value {
			b.need("zip", "ctx.zip.unzip（解压）")
			return promiseSync(vm, func() (any, error) {
				files, blocked, err := readZip(data)
				if err != nil {
					return nil, err
				}
				out := make([]any, 0, len(files))
				for _, f := range files {
					out = append(out, map[string]any{"name": f.Name, "data": f.Data})
				}
				return map[string]any{"files": out, "blocked": blocked}, nil
			})
		},
		"isUnsafeEntryName": isUnsafeEntryName,
		"effectiveExt":      effectiveExt,
	}
}

// utils 是 host-utils 能力的成员，保留给旧插件写法；新插件应直接用 ctx.zip / ctx.fs。
func (b *ctxBuilder) utilsObject() map[string]any {
	vm := b.box.vm
	return map[string]any{
		"MAX_UPLOAD": MaxUpload,
		"readZip": func(data []byte) goja.Value {
			b.need("host-utils", "ctx.utils.readZip（宿主解压工具）")
			return promiseSync(vm, func() (any, error) {
				files, blocked, err := readZip(data)
				if err != nil {
					return nil, err
				}
				out := make([]any, 0, len(files))
				for _, f := range files {
					out = append(out, map[string]any{"name": f.Name, "data": f.Data})
				}
				return map[string]any{"files": out, "blocked": blocked}, nil
			})
		},
		"isUnsafeEntryName": isUnsafeEntryName,
		"effectiveExt":      effectiveExt,
	}
}

func (b *ctxBuilder) execFn(call goja.FunctionCall) goja.Value {
	vm := b.box.vm
	command := strings.TrimSpace(call.Argument(0).String())
	if command == "" {
		panic(vm.NewGoError(errors.New("ctx.exec 需要一个命令")))
	}
	var args []string
	if raw := call.Argument(1).Export(); raw != nil {
		if list, ok := raw.([]any); ok {
			for _, item := range list {
				args = append(args, fmt.Sprint(item))
			}
		}
	}
	timeout := 30 * time.Second
	if opts := call.Argument(2); !goja.IsUndefined(opts) && !goja.IsNull(opts) {
		obj := opts.ToObject(vm)
		if ms := obj.Get("timeoutMs"); !goja.IsUndefined(ms) && ms.ToInteger() > 0 {
			timeout = time.Duration(ms.ToInteger()) * time.Millisecond
		}
	}

	return promiseSync(vm, func() (any, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, command, args...)
		hideWindow(cmd)
		stdout := &cappedBuffer{limit: maxExecOutput}
		stderr := &cappedBuffer{limit: maxExecOutput}
		cmd.Stdout = stdout
		cmd.Stderr = stderr
		// WaitDelay 给「进程已退出/已被杀，但孙进程还握着输出管道」的 io 拷贝一个上限：
		// context 取消救不了这种阻塞，而 cmd.Run 挂死发生在插件路由锁内，
		// 一条派生后台进程的命令就能把该插件的全部路由永久挂住。
		cmd.WaitDelay = 5 * time.Second
		err := cmd.Run()
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("命令超时（%s）", timeout)
		}
		if err != nil {
			return nil, fmt.Errorf("命令失败：%v；stderr：%s", err, strings.TrimSpace(stderr.String()))
		}
		return map[string]any{
			"stdout":    stdout.String(),
			"stderr":    stderr.String(),
			"truncated": stdout.truncated || stderr.truncated,
		}, nil
	})
}

func staticURLs(list []StaticDecl) string {
	urls := make([]string, 0, len(list))
	for _, s := range list {
		urls = append(urls, s.URL)
	}
	if len(urls) == 0 {
		return "无"
	}
	return strings.Join(urls, "、")
}
