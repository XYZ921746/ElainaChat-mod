// Package wsx 是最小 WebSocket 客户端（RFC 6455），只为连 Chrome DevTools Protocol。
// 范围够用即止：客户端帧必须掩码、只发文本帧；服务端帧不掩码，处理分片、ping/pong、
// close；不做压缩与子协议协商。掩码算错的表现是「连上但立刻断开」，光看日志看不出
// 是这里错了，所以帧编解码单独成函数，便于不启浏览器也能断言。
package wsx

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// MaxMessage 是单条消息上限。CDP 的截图响应可以有几十 MB base64，给宽一点。
const MaxMessage = 64 * 1024 * 1024

const (
	opCont   = 0x0
	opText   = 0x1
	opBinary = 0x2
	opClose  = 0x8
	opPing   = 0x9
	opPong   = 0xa
)

// Conn 是一条已握手的 WebSocket。读循环把完整消息交给 Handler；Close 后 Handler 不再被调用。
type Conn struct {
	conn net.Conn

	writeMu sync.Mutex
	closeMu sync.Mutex
	closed  bool
	onClose func()
}

// Dial 完成 HTTP Upgrade 握手。timeout 只覆盖建连与握手，之后的消息按调用方自己的超时处理。
func Dial(rawURL string, timeout time.Duration) (*Conn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return nil, errors.New("只支持 ws/wss 地址")
	}
	host := u.Host
	if u.Port() == "" {
		if u.Scheme == "wss" {
			host = net.JoinHostPort(u.Hostname(), "443")
		} else {
			host = net.JoinHostPort(u.Hostname(), "80")
		}
	}
	var dialer net.Dialer
	dialer.Timeout = timeout
	conn, err := dialer.Dial("tcp", host)
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		_ = conn.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)
	path := u.RequestURI()
	if path == "" {
		path = "/"
	}
	request := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := io.WriteString(conn, request); err != nil {
		_ = conn.Close()
		return nil, err
	}

	reader := bufio.NewReader(conn)
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	fields := strings.Fields(strings.TrimSpace(statusLine))
	if len(fields) < 2 || fields[1] != "101" {
		_ = conn.Close()
		return nil, fmt.Errorf("WebSocket 握手失败：%s", strings.TrimSpace(statusLine))
	}
	accept := ""
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			_ = conn.Close()
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		if i := strings.Index(line, ":"); i > 0 {
			if strings.EqualFold(line[:i], "Sec-WebSocket-Accept") {
				accept = strings.TrimSpace(line[i+1:])
			}
		}
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	want := base64.StdEncoding.EncodeToString(sum[:])
	if accept == "" || accept != want {
		_ = conn.Close()
		return nil, errors.New("WebSocket 握手校验失败（Sec-WebSocket-Accept 不匹配）")
	}
	_ = conn.SetDeadline(time.Time{})
	return &Conn{conn: conn}, nil
}

// OnClose 在连接断开时回调一次。
func (c *Conn) OnClose(fn func()) { c.onClose = fn }

// Send 发一条文本消息（FIN=1，带掩码）。
func (c *Conn) Send(text string) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.closeMu.Lock()
	closed := c.closed
	c.closeMu.Unlock()
	if closed {
		return errors.New("WebSocket 已关闭")
	}
	_, err := c.conn.Write(encodeFrame(opText, []byte(text)))
	return err
}

// ReadLoop 持续读帧并分派完整文本消息。阻塞直到连接断开；调用方应放在 goroutine 里。
func (c *Conn) ReadLoop(onMessage func([]byte)) {
	defer c.closeWithCallback()
	reader := bufio.NewReader(c.conn)
	var fragments []byte
	fragmentOp := byte(0)
	for {
		fin, op, payload, err := readFrame(reader)
		if err != nil {
			return
		}
		switch op {
		case opPing:
			c.writeMu.Lock()
			_, _ = c.conn.Write(encodeFrame(opPong, payload))
			c.writeMu.Unlock()
			continue
		case opPong:
			continue
		case opClose:
			c.writeMu.Lock()
			_, _ = c.conn.Write(encodeFrame(opClose, nil))
			c.writeMu.Unlock()
			return
		case opCont:
			fragments = append(fragments, payload...)
			if len(fragments) > MaxMessage {
				return
			}
		case opText, opBinary:
			if fin {
				if len(payload) > MaxMessage {
					return
				}
				onMessage(payload)
				continue
			}
			fragments = append(fragments[:0], payload...)
			fragmentOp = op
			continue
		}
		if fin && len(fragments) > 0 && (fragmentOp == opText || fragmentOp == opBinary) {
			onMessage(fragments)
			fragments = nil
			fragmentOp = 0
		}
	}
}

// Close 主动断开。
func (c *Conn) Close() error {
	c.closeMu.Lock()
	if c.closed {
		c.closeMu.Unlock()
		return nil
	}
	c.closed = true
	c.closeMu.Unlock()
	_ = c.conn.Close()
	return nil
}

func (c *Conn) closeWithCallback() {
	c.closeMu.Lock()
	already := c.closed
	c.closed = true
	c.closeMu.Unlock()
	_ = c.conn.Close()
	if !already && c.onClose != nil {
		c.onClose()
	}
}

func encodeFrame(opcode byte, payload []byte) []byte {
	length := len(payload)
	var header []byte
	switch {
	case length < 126:
		header = make([]byte, 2)
		header[1] = 0x80 | byte(length)
	case length < 65536:
		header = make([]byte, 4)
		header[1] = 0x80 | 126
		binary.BigEndian.PutUint16(header[2:], uint16(length))
	default:
		header = make([]byte, 10)
		header[1] = 0x80 | 127
		binary.BigEndian.PutUint64(header[2:], uint64(length))
	}
	header[0] = 0x80 | (opcode & 0x0f) // FIN=1
	mask := make([]byte, 4)
	_, _ = rand.Read(mask)
	masked := make([]byte, length)
	for i := 0; i < length; i++ {
		masked[i] = payload[i] ^ mask[i&3]
	}
	return append(append(header, mask...), masked...)
}

func readFrame(reader *bufio.Reader) (fin bool, opcode byte, payload []byte, err error) {
	head := make([]byte, 2)
	if _, err = io.ReadFull(reader, head); err != nil {
		return
	}
	fin = head[0]&0x80 != 0
	opcode = head[0] & 0x0f
	masked := head[1]&0x80 != 0
	length := uint64(head[1] & 0x7f)
	switch length {
	case 126:
		ext := make([]byte, 2)
		if _, err = io.ReadFull(reader, ext); err != nil {
			return
		}
		length = uint64(binary.BigEndian.Uint16(ext))
	case 127:
		ext := make([]byte, 8)
		if _, err = io.ReadFull(reader, ext); err != nil {
			return
		}
		length = binary.BigEndian.Uint64(ext)
	}
	if length > MaxMessage {
		err = errors.New("WebSocket 帧超过上限")
		return
	}
	var maskKey []byte
	if masked {
		maskKey = make([]byte, 4)
		if _, err = io.ReadFull(reader, maskKey); err != nil {
			return
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(reader, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i&3]
		}
	}
	return
}
