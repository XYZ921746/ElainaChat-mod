package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentFileHTTP(t *testing.T) {
	s, root := newTestServer(t)
	note := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(note, []byte("hello agent"), 0o644); err != nil {
		t.Fatal(err)
	}

	rec := doRequest(s, http.MethodGet, "/api/agent/ls?access=strict&path="+url.QueryEscape(root), nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "notes.txt") {
		t.Fatalf("列目录失败：%d %s", rec.Code, rec.Body.String())
	}

	rec = doRequest(s, http.MethodGet, "/api/agent/read?access=strict&path="+url.QueryEscape(note), nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "hello agent") {
		t.Fatalf("读文件失败：%d %s", rec.Code, rec.Body.String())
	}

	// strict 新建要确认
	target := filepath.Join(root, "new.txt")
	body, _ := json.Marshal(map[string]any{"path": target, "content": "x", "access": "strict"})
	rec = doRequest(s, http.MethodPost, "/api/agent/write", body)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "needCreate") {
		t.Fatalf("strict 新建应要求确认：%d %s", rec.Code, rec.Body.String())
	}
	body, _ = json.Marshal(map[string]any{"path": target, "content": "x", "access": "strict", "overwrite": true})
	rec = doRequest(s, http.MethodPost, "/api/agent/write", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("确认后写入失败：%d %s", rec.Code, rec.Body.String())
	}
	if raw, _ := os.ReadFile(target); string(raw) != "x" {
		t.Fatalf("文件未写入：%q", raw)
	}

	// 关闭档整块不可用
	rec = doRequest(s, http.MethodGet, "/api/agent/ls?access=off&path="+url.QueryEscape(root), nil)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "agentDisabled") {
		t.Fatalf("off 档应拒绝：%d %s", rec.Code, rec.Body.String())
	}

	// auto 禁止删除
	body, _ = json.Marshal(map[string]any{"path": target, "access": "auto"})
	rec = doRequest(s, http.MethodPost, "/api/agent/delete", body)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "deleteForbidden") {
		t.Fatalf("auto 应禁止删除：%d %s", rec.Code, rec.Body.String())
	}
	// strict 删除要确认
	body, _ = json.Marshal(map[string]any{"path": target, "access": "strict"})
	rec = doRequest(s, http.MethodPost, "/api/agent/delete", body)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "needDelete") {
		t.Fatalf("strict 删除应要求确认：%d %s", rec.Code, rec.Body.String())
	}
	// 确认后删除
	body, _ = json.Marshal(map[string]any{"path": target, "access": "strict", "confirmed": true})
	rec = doRequest(s, http.MethodPost, "/api/agent/delete", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("确认后删除失败：%d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("文件应已删除")
	}

	// exec：full 档执行安全命令
	body, _ = json.Marshal(map[string]any{"command": "Write-Output ok", "access": "full"})
	rec = doRequest(s, http.MethodPost, "/api/agent/exec", body)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "ok") {
		t.Fatalf("exec(full) 失败：%d %s", rec.Code, rec.Body.String())
	}
	// strict 每条命令都要确认
	body, _ = json.Marshal(map[string]any{"command": "Write-Output ok", "access": "strict"})
	rec = doRequest(s, http.MethodPost, "/api/agent/exec", body)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "needApproval") {
		t.Fatalf("strict 未确认应拒绝：%d %s", rec.Code, rec.Body.String())
	}
	// auto 只拦危险命令
	body, _ = json.Marshal(map[string]any{"command": "del x", "access": "auto"})
	rec = doRequest(s, http.MethodPost, "/api/agent/exec", body)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "needApproval") {
		t.Fatalf("auto 危险命令应拒绝：%d %s", rec.Code, rec.Body.String())
	}
}

func TestAgentRootsHidePathsWhenOff(t *testing.T) {
	s, _ := newTestServer(t)
	rec := doRequest(s, http.MethodGet, "/api/agent/roots?access=off", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("roots 返回 %d", rec.Code)
	}
	var got struct {
		Roots []struct {
			Path string `json:"path"`
		} `json:"roots"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &got) != nil {
		t.Fatal("响应非法")
	}
	for _, root := range got.Roots {
		if root.Path != "" {
			t.Fatalf("off 档不应暴露真实路径：%+v", root)
		}
	}
}
