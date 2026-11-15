package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"elainachat/server/internal/memoryindex"
	"elainachat/server/internal/store"
	"elainachat/server/internal/zipx"
)

func TestDataExportImportHTTP(t *testing.T) {
	s, _ := newTestServer(t)

	settings := `{"uiTheme":"night"}`
	patch := map[string]any{"data": map[string]any{store.SettingsKey: settings}}
	raw, _ := json.Marshal(patch)
	if rec := doRequest(s, http.MethodPost, "/api/store", raw); rec.Code != http.StatusOK {
		t.Fatalf("写入设置失败：%d %s", rec.Code, rec.Body.String())
	}

	rec := doRequest(s, http.MethodGet, "/api/data/export", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("导出失败：%d %s", rec.Code, rec.Body.String())
	}
	if !strings.HasPrefix(rec.Header().Get("X-Backup-Filename"), "elainachat-backup-") {
		t.Errorf("缺少备份文件名头：%q", rec.Header().Get("X-Backup-Filename"))
	}
	body := rec.Body.Bytes()
	if !zipx.IsZip(body) {
		t.Fatalf("导出内容不是 zip")
	}

	importRec := doRequest(s, http.MethodPost, "/api/data/import?mode=merge", body)
	if importRec.Code != http.StatusOK {
		t.Fatalf("导入失败：%d %s", importRec.Code, importRec.Body.String())
	}
	var out map[string]any
	if json.Unmarshal(importRec.Body.Bytes(), &out) != nil || out["ok"] != true {
		t.Errorf("导入响应异常：%s", importRec.Body.String())
	}
}

func TestDataImportRestoresMemoryFromDump(t *testing.T) {
	s, root := newTestServer(t)
	index, err := memoryindex.Open(filepath.Join(root, "data", "main", "memory", "index.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(index.Close)
	s.SetMemoryIndex(index)

	// 备份里必须有用户数据，否则导入会按「空的备份」直接驳回。
	raw, _ := json.Marshal(map[string]any{"data": map[string]any{store.SettingsKey: `{"uiTheme":"night"}`}})
	if rec := doRequest(s, http.MethodPost, "/api/store", raw); rec.Code != http.StatusOK {
		t.Fatalf("写入设置失败：%d %s", rec.Code, rec.Body.String())
	}
	if _, err := index.ImportLegacyCore([]byte(`{"diary":[{"conversationId":"c1","date":"2026年11月9日","content":"导入前的一条日记","essences":["咖啡店"]}]}`), true, "test"); err != nil {
		t.Fatal(err)
	}

	rec := doRequest(s, http.MethodGet, "/api/data/export", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("导出失败：%d %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.Bytes()
	files, _, err := zipx.Read(body, zipx.Options{})
	if err != nil {
		t.Fatal(err)
	}
	// 派生缓存与 .db 不进备份；记忆以逻辑导出的形式出现。
	var dump []byte
	for _, f := range files {
		if strings.Contains(f.Name, "cache/") || strings.HasSuffix(f.Name, ".db") {
			t.Fatalf("备份里不应包含数据库文件：%s", f.Name)
		}
		if f.Name == store.MemoryDumpZipPath {
			dump = f.Data
		}
	}
	if dump == nil {
		t.Fatalf("v4 备份缺少记忆导出 %s", store.MemoryDumpZipPath)
	}

	// 换一个空库模拟新设备：replace 导入后记忆按行回来。
	other, err := memoryindex.Open(filepath.Join(root, "data", "main", "memory", "other.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(other.Close)
	if res, err := other.ImportItemsDump(dump, true, "test"); err != nil || res.Upserted != 1 {
		t.Fatalf("dump 导入 = %+v, %v", res, err)
	}
	core, err := other.Core()
	if err != nil || len(core.Diary) != 1 || core.Diary[0].Content != "导入前的一条日记" {
		t.Fatalf("导入后 core = %+v, %v", core, err)
	}
	if core.Diary[0].ConversationID != "c1" || core.Diary[0].Date != "2026年11月9日" || len(core.Diary[0].Essences) != 1 {
		t.Fatalf("附加字段没有无损往返：%+v", core.Diary[0])
	}

	// 导入 zip 本体：本机 items 被备份里的行替换（replace 语义）。
	badCore := `{"promise":["不应留下"]}`
	if _, err := index.ImportLegacyCore([]byte(badCore), true, "test"); err != nil {
		t.Fatal(err)
	}
	if rec := doRequest(s, http.MethodPost, "/api/data/import?mode=replace", body); rec.Code != http.StatusOK {
		t.Fatalf("导入失败：%d %s", rec.Code, rec.Body.String())
	}
	got, err := index.Core()
	if err != nil || len(got.Promise) != 0 || len(got.Diary) != 1 || got.Diary[0].Content != "导入前的一条日记" {
		t.Fatalf("replace 导入后 core = %+v, %v", got, err)
	}
}

func TestDataImportLegacyMemoryBackup(t *testing.T) {
	// 老版本兼容：v3 备份里记忆是 data/memory/<类目>.json，导入时转换成行，不再写回 Store。
	s, root := newTestServer(t)
	index, err := memoryindex.Open(filepath.Join(root, "data", "main", "memory", "index.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(index.Close)
	s.SetMemoryIndex(index)

	blob, err := zipx.Write([]zipx.Entry{
		{Name: "manifest.json", Data: []byte(`{"format":"elainachat-backup","version":3}`)},
		{Name: "data/settings.json", Data: []byte(`{"elaina_open_settings":"{}"}`)},
		{Name: "data/memory/diary.json",
			Data: []byte(`{"version":1,"value":[{"conversationId":"c1","conversationTitle":"咖啡店","date":"2026年11月9日","content":"老备份里的日记","essences":["咖啡店","旅行"]}]}`)},
		{Name: "data/memory/promise.json", Data: []byte(`{"version":1,"value":["每周日一起看一部电影"]}`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := doRequest(s, http.MethodPost, "/api/data/import?mode=merge", blob)
	if rec.Code != http.StatusOK {
		t.Fatalf("导入失败：%d %s", rec.Code, rec.Body.String())
	}
	core, err := index.Core()
	if err != nil || len(core.Diary) != 1 || core.Diary[0].Content != "老备份里的日记" {
		t.Fatalf("旧备份记忆应转换为条目：%+v, %v", core, err)
	}
	if len(core.Promise) != 1 || core.Promise[0] != "每周日一起看一部电影" {
		t.Fatalf("字符串类目转换不对：%+v", core.Promise)
	}
	if core.Diary[0].ConversationTitle != "咖啡店" || len(core.Diary[0].Essences) != 2 {
		t.Fatalf("附加字段转换丢失：%+v", core.Diary[0])
	}
	// 旧类目文件不应被写回磁盘（权威只在 SQLite）。
	entries, _ := os.ReadDir(filepath.Join(root, "data", "main", "memory"))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") {
			t.Fatalf("导入后不应残留旧记忆文件：%s", e.Name())
		}
	}
}

func TestDataInfoHTTP(t *testing.T) {
	s, _ := newTestServer(t)
	rec := doRequest(s, http.MethodGet, "/api/data/info", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("data/info 失败：%d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		OK     bool           `json:"ok"`
		Counts map[string]int `json:"counts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || !out.OK {
		t.Fatalf("data/info 响应异常：%s", rec.Body.String())
	}
	for _, key := range []string{"characters", "conversations", "memoryEntries", "mods", "skills"} {
		if _, ok := out.Counts[key]; !ok {
			t.Errorf("counts 缺少 %s", key)
		}
	}
}

func TestPluginsHTTPInstallListDelete(t *testing.T) {
	s, _ := newTestServer(t)
	blob, err := zipx.Write([]zipx.Entry{
		{Name: "manifest.json", Data: []byte(`{"id":"demo","name":"演示"}`)},
		{Name: "index.js", Data: []byte("console.log(1)")},
		{Name: "README.md", Data: []byte("# 演示")},
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := doRequest(s, http.MethodPost, "/api/plugins/install?name=demo-1.0.0.zip", blob)
	if rec.Code != http.StatusOK {
		t.Fatalf("安装插件失败：%d %s", rec.Code, rec.Body.String())
	}

	rec = doRequest(s, http.MethodGet, "/api/plugins", nil)
	var list struct {
		Plugins []map[string]any `json:"plugins"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &list) != nil || len(list.Plugins) != 1 {
		t.Fatalf("插件列表异常：%s", rec.Body.String())
	}
	if list.Plugins[0]["id"] != "demo" {
		t.Errorf("插件 id 解析错误：%v", list.Plugins[0]["id"])
	}

	rec = doRequest(s, http.MethodGet, "/api/plugins/demo/readme", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "演示") {
		t.Errorf("README 读取失败：%d %s", rec.Code, rec.Body.String())
	}

	rec = doRequest(s, http.MethodDelete, "/api/plugins/demo", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("卸载插件失败：%d %s", rec.Code, rec.Body.String())
	}
	rec = doRequest(s, http.MethodGet, "/api/plugins", nil)
	if json.Unmarshal(rec.Body.Bytes(), &list) != nil || len(list.Plugins) != 0 {
		t.Errorf("卸载后列表不为空：%s", rec.Body.String())
	}
}

func TestSkillsHTTPInstallContentDelete(t *testing.T) {
	s, _ := newTestServer(t)
	blob, err := zipx.Write([]zipx.Entry{
		{Name: "SKILL.md", Data: []byte("---\nname: 资料\n---\n正文")},
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := doRequest(s, http.MethodPost, "/api/skills/install?name=notes.zip", blob)
	if rec.Code != http.StatusOK {
		t.Fatalf("安装技能失败：%d %s", rec.Code, rec.Body.String())
	}

	rec = doRequest(s, http.MethodGet, "/api/skills", nil)
	var list struct {
		Skills []map[string]any `json:"skills"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &list) != nil || len(list.Skills) != 1 {
		t.Fatalf("技能列表异常：%s", rec.Body.String())
	}

	rec = doRequest(s, http.MethodGet, "/api/skills/notes/content", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "正文") {
		t.Errorf("技能内容读取失败：%d %s", rec.Code, rec.Body.String())
	}

	rec = doRequest(s, http.MethodDelete, "/api/skills/notes", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("卸载技能失败：%d %s", rec.Code, rec.Body.String())
	}
}

// 插件随附技能的 id 是 <插件id>/<声明路径>（带层级）：DELETE 必须整段当 id，
// 不能被 `<id>/content` 的切分规则截成 `<插件id>/skills` —— 截断后既删不掉，
// 也拿不到「请连同插件一起卸载」的提示，用户只会看到「技能不存在」。
func TestSkillDeleteKeepsNestedIDForPluginSkills(t *testing.T) {
	s, root := newTestServer(t)
	modDir := filepath.Join(root, "mods", "demo-plugin", "skills", "guide")
	if err := os.MkdirAll(modDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"id":"demo-plugin","name":"演示","version":"1.0.0","entry":"index.js","skills":["skills/guide"]}`
	if err := os.WriteFile(filepath.Join(root, "mods", "demo-plugin", "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(modDir, "SKILL.md"), []byte("---\nname: 插件指南\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rec := doRequest(s, http.MethodGet, "/api/skills", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "demo-plugin/skills/guide") {
		t.Fatalf("随附技能没进清单：%d %s", rec.Code, rec.Body.String())
	}

	rec = doRequest(s, http.MethodDelete, "/api/skills/demo-plugin/skills/guide", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("随附技能删除应被拒绝（400），got %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "一起卸载") {
		t.Fatalf("拒绝原因应指回插件本体，got %s", rec.Body.String())
	}

	// 正文读取的 `<id>/content` 后缀语义不受影响
	rec = doRequest(s, http.MethodGet, "/api/skills/demo-plugin/skills/guide/content", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("随附技能正文读取失败：%d %s", rec.Code, rec.Body.String())
	}
}
