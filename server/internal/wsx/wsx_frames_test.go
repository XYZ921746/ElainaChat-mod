package wsx

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

// serverFrame 按 RFC 6455 手搓一个服务端→客户端的帧（不掩码）：解码器吃的就是这种帧。
func serverFrame(opcode byte, fin bool, payload string) []byte {
	data := []byte(payload)
	length := len(data)
	var header []byte
	switch {
	case length < 126:
		header = make([]byte, 2)
		header[1] = byte(length)
	case length < 65536:
		header = make([]byte, 4)
		header[1] = 126
		binary.BigEndian.PutUint16(header[2:], uint16(length))
	default:
		header = make([]byte, 10)
		header[1] = 127
		binary.BigEndian.PutUint64(header[2:], uint64(length))
	}
	finBit := byte(0)
	if fin {
		finBit = 0x80
	}
	header[0] = finBit | (opcode & 0x0f)
	return append(header, data...)
}

// 客户端帧头逐字段核对：掩码位（漏了会连上就断）、FIN、opcode、
// 以及 7 位 / 16 位 / 64 位三档长度编码的切换边界。
func TestEncodeFrameHeaderFields(t *testing.T) {
	small := encodeFrame(opText, []byte("hello"))
	if small[0]&0x80 == 0 {
		t.Errorf("客户端帧必须 FIN=1（单帧消息）")
	}
	if small[0]&0x0f != 0x1 {
		t.Errorf("客户端帧 opcode 应为 text，实际 0x%x", small[0]&0x0f)
	}
	if small[1]&0x80 == 0 {
		t.Errorf("客户端帧必须带掩码位（RFC 6455 要求）")
	}
	if small[1]&0x7f != 5 {
		t.Errorf("短消息用 7 位长度，实际 %d", small[1]&0x7f)
	}
	// 载荷用同一把掩码键能还原
	mask := small[2:6]
	body := small[6:]
	plain := make([]byte, len(body))
	for i := range body {
		plain[i] = body[i] ^ mask[i&3]
	}
	if string(plain) != "hello" {
		t.Errorf("掩码后的载荷应能用帧里的掩码键还原：%q", plain)
	}

	mid := encodeFrame(opText, bytes.Repeat([]byte("x"), 300))
	if mid[1]&0x7f != 126 {
		t.Errorf("300 字节应切换到 16 位长度标记，实际 7 位值 %d", mid[1]&0x7f)
	}
	if got := binary.BigEndian.Uint16(mid[2:4]); got != 300 {
		t.Errorf("16 位长度应填 300，实际 %d", got)
	}

	big := encodeFrame(opText, bytes.Repeat([]byte("x"), 70000))
	if big[1]&0x7f != 127 {
		t.Errorf("70KB 应切换到 64 位长度标记，实际 7 位值 %d", big[1]&0x7f)
	}
	if got := binary.BigEndian.Uint64(big[2:10]); got != 70000 {
		t.Errorf("64 位长度应填 70000，实际 %d", got)
	}
}

// 解码一条完整的服务端文本帧（不带掩码）。
func TestReadFrameDecodesServerTextFrame(t *testing.T) {
	fin, op, payload, err := readFrame(bufio.NewReader(bytes.NewReader(serverFrame(opText, true, `{"id":1}`))))
	if err != nil || !fin || op != opText {
		t.Fatalf("解码失败：err=%v fin=%v op=%d", err, fin, op)
	}
	if string(payload) != `{"id":1}` {
		t.Errorf("载荷不一致：%q", payload)
	}
}

// 服务端带掩码的帧也能解（对端实现不规范时读循环不至于断）。
func TestReadFrameDecodesMaskedFrame(t *testing.T) {
	frame := encodeFrame(opText, []byte("masked"))
	fin, op, payload, err := readFrame(bufio.NewReader(bytes.NewReader(frame)))
	if err != nil || !fin || op != opText || string(payload) != "masked" {
		t.Fatalf("掩码帧解码失败：err=%v fin=%v op=%d payload=%q", err, fin, op, payload)
	}
}

// TCP 不保证一条消息一次到：帧被任意切开（每 3 字节一片）也要能拼回来。
func TestReadFrameRecoversFromArbitrarySplits(t *testing.T) {
	whole := serverFrame(opText, true, `{"id":42,"result":{}}`)
	var pieces []byte
	pieces = append(pieces, whole...)
	reader := bufio.NewReader(bytes.NewReader(pieces))
	fin, op, payload, err := readFrame(reader)
	if err != nil || !fin || op != opText {
		t.Fatalf("分片帧解码失败：err=%v fin=%v op=%d", err, fin, op)
	}
	if string(payload) != `{"id":42,"result":{}}` {
		t.Errorf("分片后载荷不一致：%q", payload)
	}
}

// 一次 read 里粘着两条完整帧：各自交付，不串包。
func TestReadFrameHandlesCoalescedFrames(t *testing.T) {
	merged := append(serverFrame(opText, true, "a"), serverFrame(opText, true, "b")...)
	reader := bufio.NewReader(bytes.NewReader(merged))
	first, _, p1, err := readFrame(reader)
	if err != nil || !first || string(p1) != "a" {
		t.Fatalf("第一条失败：err=%v fin=%v payload=%q", err, first, p1)
	}
	_, _, p2, err := readFrame(reader)
	if err != nil || string(p2) != "b" {
		t.Fatalf("第二条失败：err=%v payload=%q", err, p2)
	}
	if _, _, _, err := readFrame(reader); err == nil {
		t.Errorf("读完两条后应遇到 EOF")
	}
}

// drainMessages 从 server 侧写帧、在 client 侧跑 ReadLoop；返回消息通道与 ReadLoop 结束信号。
func drainMessages(t *testing.T, writes [][]byte, expectEOF bool) (chan string, chan struct{}) {
	t.Helper()
	client, server := net.Pipe()
	deadline := time.Now().Add(5 * time.Second)
	_ = client.SetDeadline(deadline)
	_ = server.SetDeadline(deadline)

	conn := &Conn{conn: client}
	messages := make(chan string, 16)
	closed := make(chan struct{})
	conn.OnClose(func() { close(closed) })

	go func() {
		for _, w := range writes {
			_, _ = server.Write(w)
		}
		if expectEOF {
			_ = server.Close()
		}
	}()

	done := make(chan struct{})
	go func() {
		conn.ReadLoop(func(b []byte) { messages <- string(b) })
		close(done)
	}()
	return messages, done
}

func collectMessages(t *testing.T, messages chan string, want int) []string {
	t.Helper()
	got := make([]string, 0, want)
	deadline := time.After(3 * time.Second)
	for len(got) < want {
		select {
		case m := <-messages:
			got = append(got, m)
		case <-deadline:
			t.Fatalf("等消息超时：已收到 %d/%d 条 %v", len(got), want, got)
		}
	}
	return got
}

// 分片（FIN=0 + continuation）必须按 FIN 合并成一条；粘在一次写入里的两条完整帧各自交付。
func TestReadLoopAssemblesFragmentsAndCoalescedFrames(t *testing.T) {
	writes := [][]byte{
		serverFrame(opText, false, `{"a":`),
		serverFrame(opCont, false, "1"),
		serverFrame(opCont, true, "}"),
		// 两条完整帧粘在同一次写入
		concat(serverFrame(opText, true, "a"), serverFrame(opText, true, "b")),
	}
	// 一条完整帧被切成 3 字节一片喂进来
	writes = append(writes, sliceEvery3(serverFrame(opText, true, `{"id":42,"result":{}}`))...)
	messages, done := drainMessages(t, writes, true)

	got := collectMessages(t, messages, 4)
	want := []string{`{"a":1}`, "a", "b", `{"id":42,"result":{}}`}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("第 %d 条消息应为 %q，实际 %q", i+1, w, got[i])
		}
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("ReadLoop 没有随 EOF 结束")
	}
}

// PING 帧由连接层回 PONG（载荷原样带回），不冒充消息。
func TestReadLoopRepliesPong(t *testing.T) {
	client, server := net.Pipe()
	deadline := time.Now().Add(5 * time.Second)
	_ = client.SetDeadline(deadline)
	_ = server.SetDeadline(deadline)

	conn := &Conn{conn: client}
	messages := make(chan string, 4)
	go func() {
		conn.ReadLoop(func(b []byte) { messages <- string(b) })
	}()

	_, _ = server.Write(serverFrame(opPing, true, "hb"))
	buf := make([]byte, 64)
	n, err := server.Read(buf)
	if err != nil {
		t.Fatalf("没等到 PONG：%v", err)
	}
	if n < 2 || buf[0]&0x0f != opPong {
		t.Fatalf("应回 PONG 帧，实际帧头 0x%x", buf[0])
	}
	if buf[0]&0x80 == 0 {
		t.Errorf("PONG 帧 FIN 应置位")
	}
	// 回帧是客户端帧：带掩码位 + 4 字节掩码键，载荷要用同一把键还原。
	if buf[1]&0x80 == 0 {
		t.Errorf("PONG 是客户端帧，应带掩码位")
	}
	length := int(buf[1] & 0x7f)
	if length != 2 {
		t.Errorf("PONG 载荷长度应为 2，实际 %d", length)
	}
	if n != 2+4+length {
		t.Errorf("PONG 帧总长应为 %d，实际 %d", 2+4+length, n)
	}
	mask := buf[2:6]
	plain := make([]byte, length)
	for i := 0; i < length; i++ {
		plain[i] = buf[6+i] ^ mask[i&3]
	}
	if string(plain) != "hb" {
		t.Errorf("PONG 载荷应原样带回 hb，实际 %q", plain)
	}
	select {
	case m := <-messages:
		t.Errorf("PING 不应被当成消息交付：%q", m)
	default:
	}
	_ = client.Close()
	_ = server.Close()
}

// close 帧：回一个 close 帧、触发 onClose（调用方据此清掉在途请求）、读循环退出。
func TestReadLoopHandlesCloseFrame(t *testing.T) {
	client, server := net.Pipe()
	deadline := time.Now().Add(5 * time.Second)
	_ = client.SetDeadline(deadline)
	_ = server.SetDeadline(deadline)

	conn := &Conn{conn: client}
	closed := make(chan struct{})
	conn.OnClose(func() { close(closed) })

	go func() {
		conn.ReadLoop(func([]byte) {})
	}()

	_, _ = server.Write(serverFrame(opClose, true, ""))
	buf := make([]byte, 64)
	n, err := server.Read(buf)
	if err != nil {
		t.Fatalf("没等到 close 回帧：%v", err)
	}
	if buf[0]&0x0f != opClose {
		t.Fatalf("应回 close 帧，实际 opcode 0x%x", buf[0]&0x0f)
	}
	// 回帧是客户端帧：2 字节头 + 4 字节掩码键，载荷为空。
	if length := int(buf[1] & 0x7f); length != 0 || n != 2+4 {
		t.Errorf("close 回帧应为空载荷（总长 6），实际 length=%d n=%d", length, n)
	}
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatalf("close 帧应触发 onClose")
	}
	_ = server.Close()
}

// 帧声明长度超过上限：不读载荷直接拒绝，防止被一张"声明 100GB"的帧头吃光内存。
func TestReadFrameRejectsOversizedDeclaredLength(t *testing.T) {
	frame := make([]byte, 10)
	frame[0] = 0x80 | opBinary // FIN=1，不带掩码位
	frame[1] = 0x7f            // 64 位长度标记
	binary.BigEndian.PutUint64(frame[2:10], uint64(MaxMessage)+1)
	if _, _, _, err := readFrame(bufio.NewReader(bytes.NewReader(frame))); err == nil {
		t.Fatalf("声明超过上限的帧应被拒绝")
	}
	if _, _, _, err := readFrame(bufio.NewReader(io.MultiReader(
		bytes.NewReader(serverFrame(opText, true, "ok")),
	))); err != nil {
		t.Fatalf("正常帧不应受影响：%v", err)
	}
}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func sliceEvery3(data []byte) [][]byte {
	var chunks [][]byte
	for i := 0; i < len(data); i += 3 {
		end := i + 3
		if end > len(data) {
			end = len(data)
		}
		chunks = append(chunks, data[i:end])
	}
	return chunks
}
