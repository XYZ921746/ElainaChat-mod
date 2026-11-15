package browser

import (
	"strings"
	"testing"
)

func TestNormalizeNavigationURL(t *testing.T) {
	okCases := []string{"http://example.com", "https://example.com/a?b=1"}
	for _, raw := range okCases {
		if _, err := NormalizeNavigationURL(raw); err != nil {
			t.Errorf("%s 应被接受：%v", raw, err)
		}
	}
	bad := map[string]string{
		"":                    "没有给出网址",
		"file:///etc/passwd":  "只允许 http / https",
		"javascript:alert(1)": "只允许 http / https",
		"http://x\nHost: y":   "换行",
	}
	for raw, want := range bad {
		_, err := NormalizeNavigationURL(raw)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q 的错误应包含 %q，实际：%v", raw, want, err)
		}
	}
}

func TestFormatSnapshot(t *testing.T) {
	snap := &Snapshot{
		URL:   "https://example.com",
		Title: "示例",
		Text:  "正文",
		Items: []Item{
			{Ref: "1", Tag: "a", Text: "链接"},
			{Ref: "2", Tag: "input", Type: "text", Text: "搜索", Value: "关键词"},
			{Ref: "3", Tag: "button", Disabled: true},
		},
	}
	out := FormatSnapshot(snap)
	for _, want := range []string{"当前页面：示例", "网址：https://example.com", "[1] 链接：链接", "[2] 输入框/text：搜索（当前内容：关键词）", "（不可用）", "正文（截取）"} {
		if !strings.Contains(out, want) {
			t.Errorf("快照文本缺少 %q：\n%s", want, out)
		}
	}
}

func TestRunActionUnknown(t *testing.T) {
	result := RunAction(New(nil, true), "dance", map[string]any{})
	if result.OK || !strings.Contains(result.Text, "不认识的浏览器操作") {
		t.Fatalf("未知动作应报出可用清单：%+v", result)
	}
}

func TestRunActionClickRequiresRef(t *testing.T) {
	result := RunAction(New(nil, true), "click", map[string]any{})
	if result.OK || !strings.Contains(result.Text, "编号") {
		t.Fatalf("缺少 ref 应给出可操作提示：%+v", result)
	}
}

func TestSnapshotExpression(t *testing.T) {
	expr := snapshotExpression(50, 1000)
	if strings.Contains(expr, "__MAX_ITEMS__") || strings.Contains(expr, "__MAX_TEXT__") {
		t.Errorf("快照脚本的占位符没有替换：%s", expr)
	}
	if !strings.Contains(expr, "50") || !strings.Contains(expr, "1000") {
		t.Errorf("快照脚本的上限没有写进去")
	}
}
