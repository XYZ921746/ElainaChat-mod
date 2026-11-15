package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"elainachat/server/internal/store"
)

func ptr(s string) *string { return &s }

func storeForTest(t *testing.T, dataDir string) *store.Store {
	t.Helper()
	return store.New(dataDir, nil)
}

func TestListReadWriteDelete(t *testing.T) {
	root := t.TempDir()
	appRoot := filepath.Join(root, "app")
	if err := os.MkdirAll(appRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(root, "work")
	sub := filepath.Join(work, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	h := New(appRoot, "", nil, nil)
	resolved, entries, err := h.List(work)
	if err != nil || resolved != work {
		t.Fatalf("List 失败：%v %s", err, resolved)
	}
	if len(entries) != 2 || entries[0].Type != "dir" || entries[0].Name != "sub" {
		t.Fatalf("目录应排在前面：%+v", entries)
	}

	_, content, err := h.Read(filepath.Join(work, "a.txt"))
	if err != nil || content != "hello" {
		t.Fatalf("Read 失败：%v %q", err, content)
	}

	// strict 下新建要确认
	_, need, err := h.Write(filepath.Join(work, "b.txt"), "new", "strict", false)
	if !IsNeedConfirm(err) || need["needCreate"] != true {
		t.Fatalf("strict 新建应要求确认：%v %+v", err, need)
	}
	// 确认后写入
	if _, _, err := h.Write(filepath.Join(work, "b.txt"), "new", "strict", true); err != nil {
		t.Fatalf("确认后写入失败：%v", err)
	}
	if raw, _ := os.ReadFile(filepath.Join(work, "b.txt")); string(raw) != "new" {
		t.Fatalf("文件内容不对：%q", raw)
	}

	// 已存在文件在 strict 下覆盖要确认
	_, need, err = h.Write(filepath.Join(work, "b.txt"), "again", "strict", false)
	if !IsNeedConfirm(err) || need["needOverwrite"] != true {
		t.Fatalf("strict 覆盖应要求确认：%v %+v", err, need)
	}

	// auto 写不要求确认
	if _, _, err := h.Write(filepath.Join(work, "c.txt"), "auto", "auto", false); err != nil {
		t.Fatalf("auto 写入失败：%v", err)
	}

	// 应用目录内的可执行类型只有 full 能写
	if _, _, err := h.Write(filepath.Join(appRoot, "x.js"), "bad", "auto", false); err == nil ||
		!strings.Contains(err.Error(), "不允许写") {
		t.Fatalf("非 full 写 .js 应被拒绝：%v", err)
	}
	if _, _, err := h.Write(filepath.Join(appRoot, "x.js"), "ok", "full", false); err != nil {
		t.Fatalf("full 写 .js 失败：%v", err)
	}

	// strict 删除要确认
	if _, _, need, err := h.Delete(filepath.Join(work, "a.txt"), "strict", false); !IsNeedConfirm(err) || need["needDelete"] != true {
		t.Fatalf("strict 删除应要求确认：%v %+v", err, need)
	}
	if _, isDir, _, err := h.Delete(filepath.Join(work, "sub"), "strict", true); err != nil || !isDir {
		t.Fatalf("确认后删除目录失败：%v", err)
	}
	if _, _, _, err := h.Delete(filepath.Join(work, "a.txt"), "auto", true); err == nil {
		t.Fatal("auto 档不应允许删除")
	}
	if _, _, _, err := h.Delete(appRoot, "full", true); err == nil || !strings.Contains(err.Error(), "不能删除应用自己的文件夹") {
		t.Fatalf("应用目录本身应受保护：%v", err)
	}
}

func TestAccessComesFromStore(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	st := storeForTest(t, dataDir)
	settings, _ := json.Marshal(map[string]any{"agentAccess": "auto"})
	if _, err := st.MergeAndSave(map[string]*string{"elaina_open_settings": ptr(string(settings))}); err != nil {
		t.Fatal(err)
	}
	h := New(root, "", st, nil)
	if got := h.Access("full"); got != "auto" {
		t.Fatalf("设置应优先于请求参数，实际 %q", got)
	}
	if got := h.Access("off"); got != "auto" {
		t.Fatalf("请求参数不应覆盖设置，实际 %q", got)
	}
}

func TestRootsHaveHome(t *testing.T) {
	h := New(t.TempDir(), "", nil, nil)
	platform, roots := h.Roots()
	if platform == "" || len(roots) == 0 || roots[0].Key != "home" {
		t.Fatalf("roots 形状不对：%s %+v", platform, roots)
	}
}

func TestExpandAliases(t *testing.T) {
	h := New(t.TempDir(), "", nil, nil)
	home, _ := os.UserHomeDir()
	if got := h.expandPath("~"); got != home {
		t.Fatalf("~ 应展开为主目录：%q", got)
	}
	if got := h.expandPath("%USERPROFILE%/x"); !strings.HasPrefix(got, home) {
		t.Fatalf("%%USERPROFILE%% 应展开：%q", got)
	}
}
