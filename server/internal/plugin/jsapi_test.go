package plugin

import "testing"

// 输出上限必须真的生效，且超限后继续吞输出：给 exec 的 copy goroutine 返回错误会杀掉子进程。
func TestCappedBufferTruncates(t *testing.T) {
	buf := &cappedBuffer{limit: 4}
	n, err := buf.Write([]byte("abcdef"))
	if n != 6 || err != nil {
		t.Fatalf("Write 必须返回 len(p) 且不报错，得到 n=%d err=%v", n, err)
	}
	if got := buf.String(); got != "abcd" || !buf.truncated {
		t.Fatalf("截断结果 %q truncated=%v", got, buf.truncated)
	}
	if n, _ := buf.Write([]byte("z")); n != 1 || buf.String() != "abcd" {
		t.Fatalf("超限后的写入不应再增长：%q", buf.String())
	}
}
