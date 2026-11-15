package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestLogsTailHTTP(t *testing.T) {
	s, _ := newTestServer(t)
	s.log.Infof("Store", "hello world")
	s.log.Warnf("Relay", "upstream boom")

	rec := doRequest(s, http.MethodGet, "/api/logs/tail?level=WARN", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d：%s", rec.Code, rec.Body.String())
	}
	var got struct {
		OK      bool `json:"ok"`
		Entries []struct {
			Level   string `json:"level"`
			Tag     string `json:"tag"`
			Message string `json:"message"`
		} `json:"entries"`
		Tags []string `json:"tags"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &got) != nil {
		t.Fatalf("响应非法：%s", rec.Body.String())
	}
	if !got.OK || len(got.Entries) != 1 || got.Entries[0].Level != "WARN" {
		t.Fatalf("级别过滤失败：%+v", got)
	}
	if len(got.Tags) != 2 {
		t.Fatalf("tags 应返回两个模块：%v", got.Tags)
	}

	rec = doRequest(s, http.MethodGet, "/api/logs/tail?search=HELLO", nil)
	if !strings.Contains(rec.Body.String(), "hello world") {
		t.Fatalf("关键词过滤失败：%s", rec.Body.String())
	}

	rec = doRequest(s, http.MethodGet, "/api/logs/tail?tags=Relay&limit=5", nil)
	if strings.Contains(rec.Body.String(), "hello world") || !strings.Contains(rec.Body.String(), "upstream boom") {
		t.Fatalf("模块过滤失败：%s", rec.Body.String())
	}
}

func TestLogsSettingsHTTP(t *testing.T) {
	s, _ := newTestServer(t)

	rec := doRequest(s, http.MethodGet, "/api/logs/settings", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"levels"`) {
		t.Fatalf("读取日志设置失败：%d %s", rec.Code, rec.Body.String())
	}

	rec = doRequest(s, http.MethodPost, "/api/logs/settings", []byte(`{"level":"WARN","trace":false}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("修改日志设置失败：%d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "落盘级别已改为 WARN") {
		t.Fatalf("响应缺少变更说明：%s", rec.Body.String())
	}
	if s.log.FileLevel().String() != "WARN" || s.log.TraceEnabled() {
		t.Fatal("设置未生效")
	}

	rec = doRequest(s, http.MethodPost, "/api/logs/settings", []byte(`{"level":"NOPE"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("非法级别应 400，实际 %d", rec.Code)
	}
}
