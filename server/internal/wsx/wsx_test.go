package wsx

import (
	"bufio"
	"bytes"
	"testing"
)

func TestEncodeFrameIsMasked(t *testing.T) {
	frame := encodeFrame(opText, []byte("hello"))
	if len(frame) != 2+4+5 {
		t.Fatalf("帧长度不对：%d", len(frame))
	}
	if frame[0] != 0x81 {
		t.Errorf("FIN/opcode 不对：0x%x", frame[0])
	}
	if frame[1]&0x80 == 0 {
		t.Errorf("客户端帧必须带掩码位")
	}
	// 解回来应与原文一致
	reader := bufio.NewReader(bytes.NewReader(frame))
	fin, op, payload, err := readFrame(reader)
	if err != nil || !fin || op != opText {
		t.Fatalf("解码失败：err=%v fin=%v op=%d", err, fin, op)
	}
	if string(payload) != "hello" {
		t.Errorf("掩码还原失败：%q", payload)
	}
}

func TestEncodeLongFrame(t *testing.T) {
	payload := bytes.Repeat([]byte("a"), 70000)
	frame := encodeFrame(opText, payload)
	fin, op, got, err := readFrame(bufio.NewReader(bytes.NewReader(frame)))
	if err != nil || !fin || op != opText || !bytes.Equal(got, payload) {
		t.Fatalf("长帧往返失败：err=%v len=%d", err, len(got))
	}
}

func TestReadFrameRejectsOversized(t *testing.T) {
	// 手工构造一个声明超过上限的帧头：127 + 8 字节长度。
	header := []byte{0x81, 0x80 | 127, 0, 0, 0, 0, 0x10, 0, 0, 0}
	if _, _, _, err := readFrame(bufio.NewReader(bytes.NewReader(header))); err == nil {
		t.Fatalf("超大帧应被拒绝")
	}
}
