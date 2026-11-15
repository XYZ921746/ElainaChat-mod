package activity

import (
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func TestDecodeOutputUTF8(t *testing.T) {
	if got := decodeOutput([]byte("你好，世界")); got != "你好，世界" {
		t.Errorf("UTF-8 输出被改坏了：%q", got)
	}
}

func TestDecodeOutputGBK(t *testing.T) {
	encoded, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte("记事本 文档"))
	if err != nil {
		t.Fatal(err)
	}
	if got := decodeOutput(encoded); got != "记事本 文档" {
		t.Errorf("GBK 输出没有正确解码：%q", got)
	}
}

func TestFormatMem(t *testing.T) {
	cases := map[float64]string{12: "12", 12.3: "12.3", 0: "0"}
	for in, want := range cases {
		if got := formatMem(in); got != want {
			t.Errorf("formatMem(%v)=%q，期望 %q", in, got, want)
		}
	}
}

func TestClipRunesKeepsUTF8(t *testing.T) {
	text := strings.Repeat("字", 20)
	got := clipRunes(text, 5)
	if len([]rune(got)) != 5 || !strings.HasPrefix(text, got) {
		t.Errorf("按字符截断失败：%q", got)
	}
}

func TestSummaryShape(t *testing.T) {
	// 缓存入口必须是可 JSON 序列化的稳定形状；这里只断言字段存在性，
	// 真实 PowerShell 结果依赖本机环境。
	s := SummaryCached(true)
	_ = s.OK
	_ = s.Summary
}
