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

// exec 的批准必须用服务端签发的一次性令牌：请求体自证的 approved 布尔，
// 任何持会话的脚本都能替用户填，不构成确认。
func TestAgentExecApprovalTokenFlow(t *testing.T) {
	s, _ := newTestServer(t)

	fetchToken := func(command string) string {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"command": command, "access": "strict"})
		rec := doRequest(s, http.MethodPost, "/api/agent/exec", body)
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "needApproval") {
			t.Fatalf("strict 无令牌应拒绝：%d %s", rec.Code, rec.Body.String())
		}
		var denied struct {
			ApprovalToken string `json:"approvalToken"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &denied); err != nil || denied.ApprovalToken == "" {
			t.Fatalf("403 应携带 approvalToken：%s", rec.Body.String())
		}
		return denied.ApprovalToken
	}

	token := fetchToken("Write-Output ok")

	// 带令牌 + 同一命令 → 执行
	body, _ := json.Marshal(map[string]any{"command": "Write-Output ok", "access": "strict", "approvalToken": token})
	rec := doRequest(s, http.MethodPost, "/api/agent/exec", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("带令牌应执行：%d %s", rec.Code, rec.Body.String())
	}

	// 令牌一次性：复用 → 重新要令牌
	if rec := doRequest(s, http.MethodPost, "/api/agent/exec", body); rec.Code != http.StatusForbidden {
		t.Fatalf("令牌不得复用：%d", rec.Code)
	}

	// 换了命令文本的令牌即失效：必须重新确认
	token2 := fetchToken("Write-Output ok")
	body, _ = json.Marshal(map[string]any{"command": "Write-Output other", "access": "strict", "approvalToken": token2})
	if rec := doRequest(s, http.MethodPost, "/api/agent/exec", body); rec.Code != http.StatusForbidden {
		t.Fatalf("命令被改过的令牌应失效：%d", rec.Code)
	}

	// 自报 approved 布尔不再有效力
	body, _ = json.Marshal(map[string]any{"command": "Write-Output ok", "access": "strict", "approved": true})
	if rec := doRequest(s, http.MethodPost, "/api/agent/exec", body); rec.Code != http.StatusForbidden {
		t.Fatalf("approved 布尔不得再当批准：%d", rec.Code)
	}
}

// 读侧硬边界：data/（密钥与会话数据）与程序目录对任何档位不可读、不可列、不可作工作目录；
// 普通工作文件不受影响。
func TestAgentReadBoundaryBlocksDataDir(t *testing.T) {
	s, root := newTestServer(t)
	dataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(dataDir, "store.json")
	if err := os.WriteFile(secret, []byte(`{"k":"v"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	rec := doRequest(s, http.MethodGet, "/api/agent/read?access=full&path="+url.QueryEscape(secret), nil)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "保护范围") {
		t.Fatalf("data/ 文件任何档都不可读：%d %s", rec.Code, rec.Body.String())
	}
	rec = doRequest(s, http.MethodGet, "/api/agent/ls?access=full&path="+url.QueryEscape(dataDir), nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("data/ 目录不可列：%d %s", rec.Code, rec.Body.String())
	}

	body, _ := json.Marshal(map[string]any{"command": "Get-Location", "access": "full", "cwd": dataDir})
	rec = doRequest(s, http.MethodPost, "/api/agent/exec", body)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "工作目录无效") {
		t.Fatalf("data/ 不可作工作目录：%d %s", rec.Code, rec.Body.String())
	}

	note := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(note, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	rec = doRequest(s, http.MethodGet, "/api/agent/read?access=full&path="+url.QueryEscape(note), nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "hello") {
		t.Fatalf("普通文件应可读：%d %s", rec.Code, rec.Body.String())
	}
}
