package plugin

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"time"

	"github.com/dop251/goja"

	"elainachat/server/internal/logx"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScanAndIndex(t *testing.T) {
	mods := t.TempDir()
	writeFile(t, filepath.Join(mods, "demo-1.0.0", "manifest.json"), `{
		"id": "demo", "name": "示例", "version": "1.0.0",
		"entry": "index.js", "scripts": ["extra.js"], "styles": [],
		"defaultEnabled": true, "after": ["base"], "capabilities": ["theme"],
		"server": {"entry": "server.mjs", "routes": ["/api/demo"], "capabilities": ["route-register"]}
	}`)
	writeFile(t, filepath.Join(mods, "no-manifest", "index.js"), "// x")
	writeFile(t, filepath.Join(mods, ".hidden", "manifest.json"), `{"id":"hidden"}`)

	modules, err := Scan(mods)
	if err != nil {
		t.Fatal(err)
	}
	if len(modules) != 2 {
		t.Fatalf("应扫描到 2 个插件目录，实际 %d：%+v", len(modules), modules)
	}
	var demo *Module
	for i := range modules {
		if modules[i].ID == "demo" {
			demo = &modules[i]
		}
	}
	if demo == nil {
		t.Fatalf("manifest.id 应作为身份，实际 %+v", modules)
	}
	if demo.Dir != "demo-1.0.0" || demo.Name != "示例" || !demo.DefaultEnabled || len(demo.Server) == 0 {
		t.Fatalf("字段未正确解析：%+v", demo)
	}

	raw, err := IndexJSON(modules)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Plugins []map[string]any `json:"plugins"`
	}
	if json.Unmarshal(raw, &doc) != nil || len(doc.Plugins) != 2 {
		t.Fatalf("清单形状不对：%s", raw)
	}
	for _, p := range doc.Plugins {
		if p["id"] == "demo" {
			if p["scripts"] == nil || p["server"] == nil || p["defaultEnabled"] != true {
				t.Fatalf("清单字段与 server/mods.mjs 不一致：%v", p)
			}
		}
	}

	if err := WriteIndex(mods, modules); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(mods, "index.json")); err != nil {
		t.Fatalf("index.json 未落盘：%v", err)
	}
}

func TestReadDeclarationValidation(t *testing.T) {
	cases := []struct {
		name   string
		server string
		want   string
	}{
		{"未知能力", `{"entry":"server.mjs","capabilities":["root"]}`, "未知能力"},
		{"声明路由但没有 routes", `{"entry":"server.mjs","capabilities":["route-register"]}`, "route-register"},
		{"声明静态但没有 static", `{"entry":"server.mjs","capabilities":["static-read"]}`, "static-read"},
		{"entry 越界", `{"entry":"../server.mjs"}`, "entry"},
		{"坏路由", `{"entry":"server.mjs","routes":["/api"]}`, "路由前缀"},
	}
	for _, tc := range cases {
		module := Module{ID: "m", Dir: "m", Server: json.RawMessage(tc.server)}
		if _, err := ReadDeclaration(module); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s：期望包含 %q 的错误，实际 %v", tc.name, tc.want, err)
		}
	}

	module := Module{ID: "ok", Dir: "ok", Server: json.RawMessage(`{
		"entry":"server.mjs","routes":["/api/ok"],
		"capabilities":["route-register","fs-read","fs-write","zip","exec"],
		"static":[{"url":"/ok","dir":"public","mime":"auto"}]
	}`)}
	decl, err := ReadDeclaration(module)
	if err != nil || decl == nil || len(decl.Statics) != 1 {
		t.Fatalf("合法声明应通过：%v %+v", err, decl)
	}
	if !strings.Contains(decl.Signature, "fs-read") {
		t.Fatalf("签名应包含能力清单：%s", decl.Signature)
	}
}

func TestPrepareSource(t *testing.T) {
	if _, err := prepareSource(`import fs from "node:fs"; export function register(){}`); err == nil {
		t.Fatal("import 必须被拒绝")
	}
	if _, err := prepareSource(`const x = require("fs"); export function register(){}`); err == nil {
		t.Fatal("require 必须被拒绝")
	}
	src, err := prepareSource("export async function register(ctx) {\n  ctx.log('x');\n}")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(src, "export ") || !strings.Contains(src, "async function register") {
		t.Fatalf("转换后应只剩 register 声明：%s", src)
	}
	if _, err := prepareSource(`export default function register(){}`); err == nil {
		t.Fatal("只允许 export function register")
	}
}

func newHost(t *testing.T, modsDir string) (*Host, []Module) {
	t.Helper()
	modules, err := Scan(modsDir)
	if err != nil {
		t.Fatal(err)
	}
	host := New(modsDir, logx.New("", false))
	host.LoadAll(modules, func(Module) bool { return true })
	return host, modules
}

func writeDemoPlugin(t *testing.T, modsDir, source string) {
	t.Helper()
	writeFile(t, filepath.Join(modsDir, "demo", "manifest.json"), `{
		"id": "demo", "entry": "index.js",
		"server": {"entry": "server.mjs", "routes": ["/api/demo"],
			"capabilities": ["route-register", "fs-read", "fs-write", "zip", "exec"]}
	}`)
	writeFile(t, filepath.Join(modsDir, "demo", "server.mjs"), source)
}

func doPlugin(host *Host, method, target string, body io.Reader) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, body)
	rec := httptest.NewRecorder()
	if !host.Handle(rec, req) {
		rec.Code = 404
	}
	return rec
}

func TestLoadAndDispatch(t *testing.T) {
	mods := t.TempDir()
	writeDemoPlugin(t, mods, `
		export function register(ctx) {
			ctx.route('GET', '/api/demo/ping', (req, res) => {
				ctx.json(res, 200, { ok: true, method: req.method, x: req.query.x });
			});
			ctx.route('POST', '/api/demo/echo', (req, res) => {
				const body = ctx.readJson(req);
				ctx.json(res, 200, body);
			});
		}
	`)
	host, _ := newHost(t, mods)
	status := host.Status()
	if len(status.Mods) != 1 || !status.Mods[0].OK {
		t.Fatalf("插件应装载成功：%+v", status.Mods)
	}

	rec := doPlugin(host, http.MethodGet, "/api/demo/ping?x=1", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"x":"1"`) {
		t.Fatalf("路由分发失败：%d %s", rec.Code, rec.Body.String())
	}

	rec = doPlugin(host, http.MethodPost, "/api/demo/echo", strings.NewReader(`{"hello":"世界"}`))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "世界") {
		t.Fatalf("请求体解析失败：%d %s", rec.Code, rec.Body.String())
	}

	if host.Handle(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/other", nil)) {
		t.Fatal("未声明的路径不应被插件接管")
	}
}

func TestCapabilityGate(t *testing.T) {
	mods := t.TempDir()
	writeDemoPlugin(t, mods, `
		export function register(ctx) {
			ctx.exec('whoami', []);
		}
	`)
	// 去掉 exec 能力，register 里调用必须当场失败。
	writeFile(t, filepath.Join(mods, "demo", "manifest.json"), `{
		"id":"demo","entry":"index.js",
		"server":{"entry":"server.mjs","routes":["/api/demo"],"capabilities":["route-register"]}
	}`)
	host, _ := newHost(t, mods)
	status := host.Status()
	if len(status.Mods) != 1 || status.Mods[0].OK {
		t.Fatalf("未声明 exec 时不应装载成功：%+v", status.Mods)
	}
	if !strings.Contains(status.Mods[0].Error, "没有声明能力 exec") {
		t.Fatalf("错误应说明缺少哪个能力：%s", status.Mods[0].Error)
	}
}

func TestFsPathEscapeRejected(t *testing.T) {
	mods := t.TempDir()
	writeDemoPlugin(t, mods, `
		export function register(ctx) {
			ctx.route('GET', '/api/demo/read', async (req, res) => {
				try {
					await ctx.fs.readFile('../../outside.txt');
					ctx.json(res, 200, { ok: true });
				} catch (err) {
					ctx.json(res, 400, { ok: false, message: String(err && err.message || err) });
				}
			});
		}
	`)
	host, _ := newHost(t, mods)
	rec := doPlugin(host, http.MethodGet, "/api/demo/read", nil)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "越出了插件目录") {
		t.Fatalf("越界读取应被拒绝：%d %s", rec.Code, rec.Body.String())
	}
}

// 真实插件的服务端半边必须在 goja 里装载成功：这是双宿主兼容的回归点。
func TestRealPluginsLoad(t *testing.T) {
	modsDir := filepath.Join("..", "..", "..", "mods")
	if _, err := os.Stat(modsDir); err != nil {
		t.Skip("仓库 mods/ 不存在，跳过")
	}
	modules, err := Scan(modsDir)
	if err != nil {
		t.Fatal(err)
	}
	host := New(modsDir, logx.New("", false))
	host.LoadAll(modules, func(m Module) bool {
		return m.ID == "pet" || m.ID == "live2d-models"
	})
	for _, result := range host.Status().Mods {
		if result.ID != "pet" && result.ID != "live2d-models" {
			continue
		}
		if !result.OK {
			t.Fatalf("%s 装载失败：%s", result.ID, result.Error)
		}
	}
}

// 同步死循环必须被强制中断，而不是把 goroutine 永久挂死；中断状态也不能残留
// ——残留的话，插件的下一次无辜调用会被立即杀掉。
func TestRunBoundedInterruptsInfiniteLoop(t *testing.T) {
	vm := goja.New()
	start := time.Now()
	_, err := runBounded(vm, 300*time.Millisecond, func() (goja.Value, error) {
		return vm.RunString("while (true) {}")
	})
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("中断耗时过长：%v", elapsed)
	}
	if err == nil {
		t.Fatal("同步死循环应被中断报错")
	}
	if _, err := runBounded(vm, time.Second, func() (goja.Value, error) {
		return vm.RunString("1 + 1")
	}); err != nil {
		t.Fatalf("中断残留把下一次调用杀掉了：%v", err)
	}
}

func TestHasRiskyCapability(t *testing.T) {
	if HasRiskyCapability(Module{ID: "a", Dir: "a"}) {
		t.Fatal("无 server 段不应被判高危")
	}
	if HasRiskyCapability(Module{ID: "b", Dir: "b", Server: json.RawMessage(`{"capabilities":["route-register","fs-read","fs-write"]}`)}) {
		t.Fatal("仅目录内能力不应判高危")
	}
	if !HasRiskyCapability(Module{ID: "c", Dir: "c", Server: json.RawMessage(`{"capabilities":["exec"]}`)}) {
		t.Fatal("声明 exec 应判高危")
	}
	if HasRiskyCapability(Module{ID: "d", Dir: "d", Server: json.RawMessage(`not json`)}) {
		t.Fatal("坏 JSON 应安全降级为不高危")
	}
}
