package mcp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"unicode/utf8"
)

// chunkReader 每次 Read 只吐一块：模拟 TCP 的半包/粘包到达顺序。
type chunkReader struct {
	chunks [][]byte
	pos    int
	off    int
}

func (r *chunkReader) Read(p []byte) (int, error) {
	for r.pos < len(r.chunks) && r.off >= len(r.chunks[r.pos]) {
		r.pos++
		r.off = 0
	}
	if r.pos >= len(r.chunks) {
		return 0, io.EOF
	}
	n := copy(p, r.chunks[r.pos][r.off:])
	r.off += n
	return n, nil
}

// readStdout 是行切分的真实实现（bufio.ReadBytes('\n') + handleLine）：
// 跨 chunk 的半行要拼起来、粘包要逐行分派、非 JSON 行与空行跳过后消息照常解析。
func TestReadStdoutSplitsLinesAcrossDirtyChunks(t *testing.T) {
	ch1 := make(chan rpcMessage, 1)
	ch2 := make(chan rpcMessage, 1)
	ch3 := make(chan rpcMessage, 1)
	c := newStdioClient(ServerDef{ID: "t"}, nil, "")
	c.mu.Lock()
	c.pending[1] = ch1
	c.pending[2] = ch2
	c.pending[3] = ch3
	c.mu.Unlock()

	reader := &chunkReader{chunks: [][]byte{
		// 半行：一条回应跨 chunk 断开
		[]byte(`{"jsonrpc":"2.0","id":1,"result":{"n":`),
		[]byte(`1}}` + "\n" + `{"jsonrpc":"2.0","id":2,"resu`),
		[]byte(`lt":{"m":2}}` + "\n"),
		// 子进程日志污染 stdout：跳过，别让整个连接废掉
		[]byte("this is not json\n"),
		[]byte(`{"jsonrpc":"2.0","id":3,"result":{"ok":true}}` + "\n"),
		// 空行与纯空白行：跳过
		[]byte("\n   \n"),
		// 粘包：两条完整回应挤在同一次到达
		[]byte(`{"jsonrpc":"2.0","id":4,"result":{"a":1}}` + "\n" + `{"jsonrpc":"2.0","id":5,"result":{"a":2}}` + "\n"),
	}}
	c.readStdout(reader)

	assertPendingResult := func(t *testing.T, ch chan rpcMessage, id int64, want string) {
		t.Helper()
		select {
		case msg := <-ch:
			if string(msg.Result) != want {
				t.Errorf("id=%d 的 result 应为 %s，实际 %s", id, want, msg.Result)
			}
		default:
			t.Errorf("id=%d 的回应没有送达", id)
		}
	}
	assertPendingResult(t, ch1, 1, `{"n":1}`)
	assertPendingResult(t, ch2, 2, `{"m":2}`)
	assertPendingResult(t, ch3, 3, `{"ok":true}`)
}

// flattenToolResult 把 MCP 的 content 数组拍平成一段文本：宿主的工具通道只吃一段文本。
func TestFlattenToolResultFlattensContent(t *testing.T) {
	raw := []byte(`{"content":[
		{"type":"text","text":"echo: hi"},
		{"type":"image"},
		{"type":"resource","resource":{"uri":"file:///x"}}
	]}`)
	got := flattenToolResult(raw)
	if !got.OK {
		t.Errorf("普通结果应 ok=true：%+v", got)
	}
	if !strings.HasPrefix(got.Text, "echo: hi") {
		t.Errorf("文本内容应保留在最前：%q", got.Text)
	}
	if !strings.Contains(got.Text, "图片") {
		t.Errorf("图片类内容应降级成一句说明（不丢成空白）：%q", got.Text)
	}
	if !strings.Contains(got.Text, "资源引用") || !strings.Contains(got.Text, "file:///x") {
		t.Errorf("资源引用应带 uri：%q", got.Text)
	}
}

func TestFlattenToolResultIsErrorAndEmpty(t *testing.T) {
	if got := flattenToolResult([]byte(`{"isError":true,"content":[{"type":"text","text":"boom"}]}`)); got.OK || got.Text != "boom" {
		t.Errorf("isError 应映射成 ok=false 且保留原因：%+v", got)
	}
	if got := flattenToolResult([]byte(`{}`)); !got.OK || got.Text != "（工具没有返回内容）" {
		t.Errorf("空 content 应有兜底文案（isError 未置位则 ok=true）：%+v", got)
	}
	if got := flattenToolResult(nil); got.Text != "（工具没有返回内容）" {
		t.Errorf("无结果也应有兜底文案：%+v", got)
	}
	// 未知类型与缺 uri 的资源：给说明而不是丢弃
	got := flattenToolResult([]byte(`{"content":[{"type":"audio"},{"type":"resource","resource":{}}]}`))
	if !strings.Contains(got.Text, "audio") || !strings.Contains(got.Text, "无地址") {
		t.Errorf("未知类型/无 uri 资源应降级说明：%q", got.Text)
	}
}

// 拍平输入是 RawMessage：坏 JSON 不 panic（unmarshal 失败时按空 content 处理）。
func TestFlattenToolResultToleratesBadJSON(t *testing.T) {
	got := flattenToolResult(json.RawMessage("这不是 JSON"))
	if got.OK != true || got.Text == "" {
		t.Errorf("坏 JSON 不应 panic，且应有兜底文案：%+v", got)
	}
}

// 工具结果直接进模型提示：超大正文必须截断，且不能把多字节字符切成半个。
func TestFlattenToolResultTruncatesOversizedText(t *testing.T) {
	huge := strings.Repeat("工", maxToolTextBytes) // 每字 3 字节，远超上限
	raw, err := json.Marshal(map[string]any{
		"content": []map[string]any{{"type": "text", "text": huge}},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := flattenToolResult(raw)
	if len(got.Text) >= len(huge) {
		t.Fatalf("超长正文应被截断，实际长度 %d", len(got.Text))
	}
	if !strings.Contains(got.Text, "已截断") {
		t.Errorf("截断应带说明：%q", got.Text[len(got.Text)-80:])
	}
	if !utf8.ValidString(got.Text) {
		t.Errorf("截断不得把多字节字符切一半（下游会当乱码）")
	}
	// 未超限的正文必须原样保留。
	if got := flattenToolResult([]byte(`{"content":[{"type":"text","text":"短"}]}`)); got.Text != "短" {
		t.Errorf("未超限正文不应改动：%q", got.Text)
	}
}

// 超长行要边读边丢：整行读完再比长度的话，对端一直不发换行就能吃满内存。
// 超长行之后的正常行仍必须能解析（残余不能被当成下一行）。
func TestReadStdoutDropsOversizedLineAndKeepsFollowing(t *testing.T) {
	ch := make(chan rpcMessage, 1)
	c := newStdioClient(ServerDef{ID: "t"}, nil, "")
	c.mu.Lock()
	c.pending[7] = ch
	c.mu.Unlock()

	reader := &chunkReader{chunks: [][]byte{
		bytes.Repeat([]byte("x"), maxLineBytes+1024),
		[]byte("\n"),
		[]byte(`{"jsonrpc":"2.0","id":7,"result":{"ok":true}}` + "\n"),
	}}
	c.readStdout(reader)

	select {
	case msg := <-ch:
		if string(msg.Result) != `{"ok":true}` {
			t.Errorf("超长行之后的正常行应照常解析：%s", msg.Result)
		}
	default:
		t.Errorf("超长行之后的消息没有送达")
	}
}

// readLineLimited 的边界：整行（含换行符）正好等于上限算正常，超过一个字节算超长。
func TestReadLineLimitedBoundary(t *testing.T) {
	exact := strings.Repeat("a", maxLineBytes-1) // + '\n' 正好等于上限
	line, tooLong, err := readLineLimited(bufio.NewReader(strings.NewReader(exact+"\n")), maxLineBytes)
	if err != nil || tooLong {
		t.Fatalf("整行正好等于上限应放行：tooLong=%v err=%v", tooLong, err)
	}
	if len(line) != maxLineBytes {
		t.Errorf("整行（含换行）应完整返回，实际 %d 字节", len(line))
	}

	over := strings.Repeat("a", maxLineBytes)
	if _, tooLong, _ := readLineLimited(bufio.NewReader(strings.NewReader(over+"\n")), maxLineBytes); !tooLong {
		t.Errorf("超过上限一个字节应判超长")
	}
}
