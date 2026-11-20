// Package mcp 是 MCP 客户端：把外部 MCP 服务器提供的工具接进宿主。
// 只做客户端 —— 做服务端等于把本机的文件读写与命令执行开放给任何能连上它的
// MCP 客户端，与「BYOK、每个动作都要过权限闸」冲突。
//
// 两种传输：stdio（本地子进程，JSON-RPC 按行分隔）与 Streamable HTTP
// （远程地址，响应可能是 JSON 或 text/event-stream）。协议常量与「content 拍平成
// 一段文本」两边共用，避免同一份工具在两种传输下给出不同提示。
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"elainachat/server/internal/logx"
)

const (
	protocolVersion = "2025-06-18"
	initTimeout     = 45 * time.Second
	listTimeout     = 20 * time.Second
	callTimeout     = 120 * time.Second
	maxLineBytes    = 8 * 1024 * 1024
	// 工具结果进的是模型提示，不是日志：8MB 正文足够撑爆上下文，按更小的额度截断。
	maxToolTextBytes = 256 * 1024
	listCacheTTL     = 30 * time.Second
)

// ServerDef 是一台 MCP 服务器的配置（来自设置里的 mcpServers）。
type ServerDef struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	URL     string            `json:"url"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	CWD     string            `json:"cwd"`
	Headers map[string]string `json:"headers"`
}

// ServerInfo 是服务端自报的身份，用于「连接成功」提示。
type ServerInfo struct {
	Name    string `json:"name,omitempty"`
	Version string `json:"version,omitempty"`
}

// Tool 是宿主可注册的工具描述。MCP 的 inputSchema 与 JSON Schema 同源，
// 可以直接当 function calling 的 parameters。
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// ToolResult 是拍平后的工具结果：宿主的工具通道只接受一段文本，
// 图片与资源降级成一句说明，直接丢 JSON 会让模型对它做二次猜测。
type ToolResult struct {
	OK   bool   `json:"ok"`
	Text string `json:"text"`
}

// Transport 按配置选：填了 http(s) url 就是远程，否则看 command。
func (d ServerDef) Transport() string {
	if strings.TrimSpace(d.URL) != "" {
		return "http"
	}
	if strings.TrimSpace(d.Command) != "" {
		return "stdio"
	}
	return ""
}

type client interface {
	Start(ctx context.Context) (*ServerInfo, error)
	ListTools(ctx context.Context) ([]Tool, error)
	CallTool(ctx context.Context, name string, args map[string]any) (ToolResult, error)
	Close()
	Running() bool
	Info() *ServerInfo
}

func newClient(def ServerDef, log *logx.Logger, version string) client {
	if def.Transport() == "http" {
		return newHTTPClient(def, log, version)
	}
	return newStdioClient(def, log, version)
}

// JSON-RPC 公共类型

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func idOf(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var n int64
	if json.Unmarshal(raw, &n) == nil {
		return n, true
	}
	return 0, false
}

func buildInitializeParams(version string) map[string]any {
	if version == "" {
		version = "2.2.1"
	}
	return map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities": map[string]any{
			"roots": map[string]any{"listChanged": false},
		},
		"clientInfo": map[string]any{"name": "ElainaChat", "version": version},
	}
}

func normalizeTools(result json.RawMessage) ([]Tool, error) {
	var payload struct {
		Tools []struct {
			Name        string          `json:"name"`
			Description string          `json:"description"`
			InputSchema json.RawMessage `json:"inputSchema"`
		} `json:"tools"`
	}
	if len(result) > 0 {
		if err := json.Unmarshal(result, &payload); err != nil {
			return nil, err
		}
	}
	out := make([]Tool, 0, len(payload.Tools))
	for _, t := range payload.Tools {
		if t.Name == "" {
			continue
		}
		schema := t.InputSchema
		if len(schema) == 0 || string(schema) == "null" {
			schema = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		out = append(out, Tool{Name: t.Name, Description: t.Description, InputSchema: schema})
	}
	return out, nil
}

func flattenToolResult(result json.RawMessage) ToolResult {
	var payload struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Resource struct {
				URI string `json:"uri"`
			} `json:"resource"`
		} `json:"content"`
	}
	_ = json.Unmarshal(result, &payload)
	parts := make([]string, 0, len(payload.Content))
	for _, item := range payload.Content {
		switch item.Type {
		case "text":
			parts = append(parts, item.Text)
		case "image":
			parts = append(parts, "（该工具返回了一张图片，这里只能显示文字）")
		case "resource":
			uri := item.Resource.URI
			if uri == "" {
				uri = "无地址"
			}
			parts = append(parts, "（该工具返回了一个资源引用："+uri+"）")
		default:
			kind := item.Type
			if kind == "" {
				kind = "未知"
			}
			parts = append(parts, "（该工具返回了 "+kind+" 类型的内容）")
		}
	}
	text := strings.TrimSpace(strings.Join(parts, "\n"))
	if text == "" {
		text = "（工具没有返回内容）"
	}
	// 正文直接进模型提示：不截断的话一个 8MB 的工具输出就能撑爆上下文预算。
	text = clipRunes(text, maxToolTextBytes)
	return ToolResult{OK: !payload.IsError, Text: text}
}

// clipRunes 按字节上限截断，但保证不把多字节字符切一半（切成半个字会被下游当乱码）。
func clipRunes(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + fmt.Sprintf("\n…（已截断，原文 %d 字节，仅保留前 %d 字节）", len(text), cut)
}

// stdio 客户端

type stdioClient struct {
	def     ServerDef
	log     *logx.Logger
	version string

	mu       sync.Mutex
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	pending  map[int64]chan rpcMessage
	nextID   int64
	closed   bool
	initDone bool
	info     *ServerInfo
	done     chan struct{}
	// writeMu 只保护一次完整的 stdin 写：JSON-RPC 按行分帧，两条请求的字节
	// 交错会让对端解析出垃圾。持锁期间不做任何可能长时间阻塞的操作。
	writeMu sync.Mutex
	// startMu 单飞并发 Start：两个请求同时发现「没启动」时只允许一个真正拉起进程。
	startMu sync.Mutex
	// 生命周期 context 与请求 ctx 分开：/api/mcp/tools 的请求结束不能杀掉
	// 刚拉起的子进程，只有 Close 才取消它。
	lifeCtx    context.Context
	lifeCancel context.CancelFunc
}

func newStdioClient(def ServerDef, log *logx.Logger, version string) *stdioClient {
	ctx, cancel := context.WithCancel(context.Background())
	return &stdioClient{
		def: def, log: log, version: version,
		pending: map[int64]chan rpcMessage{}, done: make(chan struct{}),
		lifeCtx: ctx, lifeCancel: cancel,
	}
}

func (c *stdioClient) logf(format string, args ...any) {
	if c.log != nil {
		c.log.Infof("MCP", "[%s] "+format, append([]any{c.def.ID}, args...)...)
	}
}

// describeCommand 拼出可进日志的命令行。参数里常直接写 --api-key sk-…，
// 而日志会被用户导出贴到 issue，所以先过一遍脱敏再拼。
func describeCommand(command string, args []string) string {
	if len(args) == 0 {
		return command
	}
	return command + " " + logx.Redact(strings.Join(args, " "))
}

func (c *stdioClient) Running() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cmd != nil && !c.closed
}

func (c *stdioClient) Info() *ServerInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.info
}

// Start 按需拉起子进程。ctx 只控制本次初始化等待；子进程本身跟着 lifeCtx 走，
// 请求结束、客户端断开都不会杀掉它，只有 Close 才会。
func (c *stdioClient) Start(ctx context.Context) (*ServerInfo, error) {
	c.startMu.Lock()
	defer c.startMu.Unlock()

	c.mu.Lock()
	if c.cmd != nil && !c.closed && c.initDone {
		info := c.info
		c.mu.Unlock()
		return info, nil
	}
	command := strings.TrimSpace(c.def.Command)
	if command == "" {
		c.mu.Unlock()
		return nil, fmt.Errorf("MCP 服务器「%s」没有配置启动命令", c.def.ID)
	}
	// 上一次初始化失败留下的半启动进程：先清干净，让本次 Start 真正重试。
	if c.cmd != nil && c.stdin != nil {
		_ = c.stdin.Close()
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
	}
	c.pending = map[int64]chan rpcMessage{}
	c.nextID = 0
	c.initDone = false
	c.info = nil
	// Close 后重启：生命周期 ctx 已取消，必须换新的，否则所有请求立刻失败。
	if c.lifeCtx.Err() != nil {
		fresh, freshCancel := context.WithCancel(context.Background())
		c.lifeCtx, c.lifeCancel = fresh, freshCancel
	}
	args := append([]string{}, c.def.Args...)
	// Windows 上 .cmd/.bat 必须显式走 cmd.exe /c：用 shell 拼接 args 会在路径含空格时断掉。
	if runtime.GOOS == "windows" && (strings.HasSuffix(strings.ToLower(command), ".cmd") || strings.HasSuffix(strings.ToLower(command), ".bat")) {
		args = append([]string{"/d", "/s", "/c", command}, args...)
		command = "cmd.exe"
	}
	cmd := exec.Command(command, args...)
	cmd.Dir = c.def.CWD
	// 环境变量与宿主合并而不是替换：子进程往往依赖 PATH / HOME。
	env := os.Environ()
	for k, v := range c.def.Env {
		if k != "" {
			env = append(env, k+"="+v)
		}
	}
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		c.mu.Unlock()
		return nil, fmt.Errorf("MCP 服务器「%s」启动失败：%v", c.def.ID, err)
	}
	c.cmd = cmd
	c.stdin = stdin
	c.closed = false
	c.done = make(chan struct{})
	done := c.done
	cancel := c.lifeCancel
	c.logf("启动：%s", describeCommand(c.def.Command, c.def.Args))
	c.mu.Unlock()

	go c.readStdout(stdout)
	go c.drainStderr(stderr)
	go c.watchExit(cmd, done, cancel)
	return c.initialize(ctx)
}

func (c *stdioClient) readStdout(r io.Reader) {
	reader := bufio.NewReaderSize(r, 64*1024)
	for {
		line, tooLong, err := readLineLimited(reader, maxLineBytes)
		if tooLong {
			c.logf("忽略一条超长输出（超过 %d 字节）", maxLineBytes)
		} else if len(line) > 0 {
			c.handleLine(strings.TrimSpace(string(line)))
		}
		if err != nil {
			return
		}
	}
}

// readLineLimited 边读边判上限：整行读完再比长度的话，对端一直不发换行就能把内存吃满。
// 超长后继续丢弃到行尾，别让残余被当成下一行。
func readLineLimited(reader *bufio.Reader, limit int) (line []byte, tooLong bool, err error) {
	for {
		chunk, readErr := reader.ReadSlice('\n')
		if !tooLong {
			if len(line)+len(chunk) > limit {
				tooLong = true
				line = nil
			} else {
				line = append(line, chunk...)
			}
		}
		if readErr == bufio.ErrBufferFull {
			continue
		}
		return line, tooLong, readErr
	}
}

func (c *stdioClient) handleLine(line string) {
	if line == "" {
		return
	}
	var msg rpcMessage
	if json.Unmarshal([]byte(line), &msg) != nil {
		// 子进程往 stdout 打日志会污染这条流：跳过这一行，别让整个连接废掉。
		c.logf("忽略了一行非 JSON 输出：%s", clip(line, 200))
		return
	}
	// 服务器发来的请求（sampling / roots 之类）：不实现，按 JSON-RPC 规范回 -32601。
	if msg.Method != "" && len(msg.ID) > 0 {
		_ = c.send(map[string]any{
			"jsonrpc": "2.0", "id": json.RawMessage(msg.ID),
			"error": map[string]any{"code": -32601, "message": "本客户端不支持该方法：" + msg.Method},
		})
		return
	}
	if msg.Method != "" || len(msg.ID) == 0 {
		return
	}
	id, ok := idOf(msg.ID)
	if !ok {
		return
	}
	c.mu.Lock()
	ch := c.pending[id]
	delete(c.pending, id)
	c.mu.Unlock()
	if ch != nil {
		ch <- msg
	}
}

func (c *stdioClient) drainStderr(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 8*1024), 256*1024)
	for scanner.Scan() {
		text := strings.TrimSpace(scanner.Text())
		if text != "" {
			c.logf("stderr: %s", clip(text, 500))
		}
	}
}

// watchExit 等子进程退出并清理状态。done 与 cancel 是本次进程对应的代次资源：
// 捕获进参而不是读字段，防止旧进程的退出回调误清重启后的新状态、关掉新代次的 done。
func (c *stdioClient) watchExit(cmd *exec.Cmd, done chan struct{}, cancel context.CancelFunc) {
	err := cmd.Wait()
	c.mu.Lock()
	// 代次守卫：Start 可能已经拉起了新进程，旧回调只能收拾自己那一代。
	current := c.cmd == cmd
	var pending map[int64]chan rpcMessage
	if current {
		c.closed = true
		c.cmd = nil
		c.stdin = nil
		pending = c.pending
		c.pending = map[int64]chan rpcMessage{}
	}
	c.mu.Unlock()
	// 进程退出（含 Close 强杀）时同步取消生命周期：在途请求立刻醒来并报错，
	// 而不是各自等到超时。
	cancel()
	close(done)
	reason := "已退出"
	if err != nil {
		reason += "（" + err.Error() + "）"
	}
	for _, ch := range pending {
		ch <- rpcMessage{Error: &rpcError{Message: "MCP 服务器「" + c.def.ID + "」" + reason}}
	}
}

func (c *stdioClient) send(payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	c.mu.Lock()
	stdin := c.stdin
	closed := c.closed
	c.mu.Unlock()
	if stdin == nil || closed {
		return fmt.Errorf("MCP 服务器「%s」没有在运行", c.def.ID)
	}
	// 写入整体持锁：两条请求的字节交错会让按行分帧的对端解析出垃圾。
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = stdin.Write(append(raw, '\n'))
	return err
}

func (c *stdioClient) request(ctx context.Context, method string, params any, timeout time.Duration) (json.RawMessage, error) {
	c.mu.Lock()
	if c.closed || c.lifeCtx.Err() != nil {
		c.mu.Unlock()
		return nil, fmt.Errorf("MCP 服务器「%s」已关闭", c.def.ID)
	}
	c.nextID++
	id := c.nextID
	ch := make(chan rpcMessage, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	payload := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		payload["params"] = params
	}
	if err := c.send(payload); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}

	// 超时、调用方取消、客户端关闭三选一先到：都要清 pending，防止迟到响应
	// 占着表项。取消已发出的请求时尽力通知对端（通知不等待回应）。
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case msg := <-ch:
		if msg.Error != nil {
			return nil, fmt.Errorf("%s（code %d）", msg.Error.Message, msg.Error.Code)
		}
		return msg.Result, nil
	case <-ctx.Done():
		c.removePending(id)
		c.send(map[string]any{
			"jsonrpc": "2.0",
			"method":  "notifications/cancelled",
			"params":  map[string]any{"requestId": id},
		})
		return nil, fmt.Errorf("MCP 请求已取消：%s", method)
	case <-c.lifeCtx.Done():
		c.removePending(id)
		return nil, fmt.Errorf("MCP 服务器「%s」已关闭", c.def.ID)
	case <-timer.C:
		c.removePending(id)
		return nil, fmt.Errorf("MCP 服务器「%s」在 %d 秒内没有回应 %s", c.def.ID, int(timeout.Seconds()), method)
	}
}

func (c *stdioClient) removePending(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *stdioClient) initialize(ctx context.Context) (*ServerInfo, error) {
	result, err := c.request(ctx, "initialize", buildInitializeParams(c.version), initTimeout)
	if err != nil {
		// 初始化失败不能留下「进程活着但没握手」的半连接：关掉，让下一次 Start 重来。
		c.Close()
		return nil, err
	}
	var payload struct {
		ProtocolVersion string      `json:"protocolVersion"`
		ServerInfo      *ServerInfo `json:"serverInfo"`
	}
	_ = json.Unmarshal(result, &payload)
	if payload.ProtocolVersion != "" && payload.ProtocolVersion != protocolVersion {
		c.logf("协商到协议版本 %s（本客户端为 %s），按兼容处理", payload.ProtocolVersion, protocolVersion)
	}
	c.mu.Lock()
	c.info = payload.ServerInfo
	c.initDone = true
	c.mu.Unlock()
	_ = c.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	return payload.ServerInfo, nil
}

func (c *stdioClient) ListTools(ctx context.Context) ([]Tool, error) {
	if _, err := c.Start(ctx); err != nil {
		return nil, err
	}
	result, err := c.request(ctx, "tools/list", map[string]any{}, listTimeout)
	if err != nil {
		return nil, err
	}
	return normalizeTools(result)
}

func (c *stdioClient) CallTool(ctx context.Context, name string, args map[string]any) (ToolResult, error) {
	if _, err := c.Start(ctx); err != nil {
		return ToolResult{}, err
	}
	result, err := c.request(ctx, "tools/call", map[string]any{
		"name": name, "arguments": args,
	}, callTimeout)
	if err != nil {
		return ToolResult{}, err
	}
	return flattenToolResult(result), nil
}

// Close 先取消生命周期让在途请求立刻醒来，再关 stdin 让它自行退出，5 秒不退再强杀。
func (c *stdioClient) Close() {
	c.lifeCancel()
	c.mu.Lock()
	stdin := c.stdin
	done := c.done
	c.closed = true
	c.mu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		c.mu.Lock()
		cmd := c.cmd
		c.mu.Unlock()
		if cmd != nil && cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}
}

// Streamable HTTP 客户端

type httpClient struct {
	def     ServerDef
	log     *logx.Logger
	version string

	client *http.Client

	mu         sync.Mutex
	nextID     int64
	closed     bool
	initDone   bool
	info       *ServerInfo
	sessionID  string
	negotiated string
}

func newHTTPClient(def ServerDef, log *logx.Logger, version string) *httpClient {
	return &httpClient{
		def: def, log: log, version: version,
		negotiated: protocolVersion,
		client:     newHTTPDoer(),
	}
}

func (c *httpClient) logf(format string, args ...any) {
	if c.log != nil {
		c.log.Infof("MCP", "[%s] "+format, append([]any{c.def.ID}, args...)...)
	}
}

func (c *httpClient) Running() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.initDone && !c.closed
}

func (c *httpClient) Info() *ServerInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.info
}

func (c *httpClient) buildHeaders() http.Header {
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	h.Set("Accept", "application/json, text/event-stream")
	c.mu.Lock()
	h.Set("MCP-Protocol-Version", c.negotiated)
	if c.sessionID != "" {
		h.Set("Mcp-Session-Id", c.sessionID)
	}
	c.mu.Unlock()
	for k, v := range c.def.Headers {
		if k != "" {
			h.Set(k, v)
		}
	}
	return h
}

func (c *httpClient) request(ctx context.Context, method string, params any, timeout time.Duration) (json.RawMessage, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, fmt.Errorf("MCP 服务器「%s」已关闭", c.def.ID)
	}
	c.nextID++
	id := c.nextID
	c.mu.Unlock()

	payload := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		payload["params"] = params
	}
	body, _ := json.Marshal(payload)

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	resp, err := c.do(ctx, http.MethodPost, body)
	if err != nil {
		return nil, c.translateError(err, timeout, method)
	}
	defer resp.Body.Close()
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		c.mu.Lock()
		c.sessionID = sid
		c.mu.Unlock()
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		// 客户端已关掉自动跟随：3xx 说明服务器要我们改道，这里不猜目的地。
		return nil, fmt.Errorf("MCP 服务返回 HTTP %d（重定向已拒绝：地址由服务器决定，不能带着认证头跟过去）", resp.StatusCode)
	}
	if resp.StatusCode >= 400 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("MCP 服务返回 HTTP %d：%s", resp.StatusCode, clip(strings.TrimSpace(string(detail)), 300))
	}
	ctype := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.HasPrefix(strings.TrimSpace(ctype), "text/event-stream") {
		return c.readSSE(resp.Body, id, timeout)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxLineBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxLineBytes {
		return nil, fmt.Errorf("MCP 响应超过 %d 字节，已拒绝", maxLineBytes)
	}
	result, hit, unwrapErr := unwrapHTTPResult(raw, id)
	if unwrapErr != nil {
		return nil, unwrapErr
	}
	if !hit {
		return nil, fmt.Errorf("MCP 回应了别的请求")
	}
	return result, nil
}

func (c *httpClient) readSSE(r io.Reader, reqID int64, timeout time.Duration) (json.RawMessage, error) {
	deadline := time.Now().Add(timeout)
	reader := bufio.NewReaderSize(r, 32*1024)
	var block bytes.Buffer
	for {
		if time.Now().After(deadline) {
			return nil, errors.New("MCP 流式响应超时")
		}
		line, err := reader.ReadString('\n')
		if line != "" {
			// 单行与单块都要设上限：对端不发空行就能让 block 无限长。
			if block.Len()+len(line) > maxLineBytes {
				return nil, fmt.Errorf("MCP 流式响应超过 %d 字节，已拒绝", maxLineBytes)
			}
			trimmed := strings.TrimRight(line, "\r\n")
			if trimmed == "" {
				if block.Len() > 0 {
					if result, hit, sseErr := parseSSEBlock(block.String(), reqID); hit {
						return result, sseErr
					}
					block.Reset()
				}
			} else {
				block.WriteString(trimmed + "\n")
			}
		}
		if err != nil {
			if block.Len() > 0 {
				if result, hit, sseErr := parseSSEBlock(block.String(), reqID); hit {
					return result, sseErr
				}
			}
			return nil, errors.New("MCP 流式响应结束了但没有返回结果")
		}
	}
}

// parseSSEBlock 处理一条 SSE 事件。第二个返回值表示是否命中本次请求；
// 命中时第三个返回值是 JSON-RPC 的 error（成功则为 nil）。
func parseSSEBlock(block string, reqID int64) (json.RawMessage, bool, error) {
	var data []string
	for _, line := range strings.Split(block, "\n") {
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if len(data) == 0 {
		return nil, false, nil
	}
	msg := []byte(strings.Join(data, "\n"))
	return unwrapHTTPResult(msg, reqID)
}

// unwrapHTTPResult 从 JSON-RPC 回应里取 result。第二个返回值表示是否命中本次请求，
// 第三个返回值是服务端返回的 error（命中但失败）。
func unwrapHTTPResult(raw []byte, reqID int64) (json.RawMessage, bool, error) {
	if arr, isBatch := tryBatch(raw); isBatch {
		for _, item := range arr {
			if id, ok := idOf(item.ID); ok && id == reqID {
				if item.Error != nil {
					return nil, true, fmt.Errorf("%s（code %d）", item.Error.Message, item.Error.Code)
				}
				return item.Result, true, nil
			}
		}
		return nil, false, nil
	}
	var single rpcMessage
	if json.Unmarshal(raw, &single) != nil {
		return nil, false, nil
	}
	if single.Method != "" {
		// 服务端主动发来的通知/请求：不是我们要的回应。
		return nil, false, nil
	}
	if id, ok := idOf(single.ID); ok && id == reqID {
		if single.Error != nil {
			return nil, true, fmt.Errorf("%s（code %d）", single.Error.Message, single.Error.Code)
		}
		return single.Result, true, nil
	}
	return nil, false, nil
}

func tryBatch(raw []byte) ([]rpcMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, false
	}
	var out []rpcMessage
	if json.Unmarshal(trimmed, &out) != nil {
		return nil, false
	}
	return out, true
}

func (c *httpClient) do(ctx context.Context, method string, body []byte) (*http.Response, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if ctx.Err() != nil {
			break
		}
		var req *http.Request
		var err error
		if body != nil {
			req, err = http.NewRequestWithContext(ctx, method, c.def.URL, bytes.NewReader(body))
		} else {
			req, err = http.NewRequestWithContext(ctx, method, c.def.URL, nil)
		}
		if err != nil {
			return nil, err
		}
		req.Header = c.buildHeaders()
		client := c.client
		if attempt == 1 {
			// 第二次降级 TLS 1.2：某些网络会掐掉 1.3 的 ClientHello。
			client = newHTTPDoerTLS12()
		}
		resp, err := client.Do(req)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		// 只重试「请求还没发出去」的失败：tools/call 不是幂等操作（写文件、发消息），
		// 请求可能已被服务器执行，只是回包时连接断了 —— 重发就是二次执行。
		if !isPreSendFailure(err) {
			return nil, err
		}
		if attempt < 2 {
			select {
			case <-time.After(time.Duration(300*(attempt+1)) * time.Millisecond):
			case <-ctx.Done():
			}
		}
	}
	if lastErr == nil {
		lastErr = ctx.Err()
	}
	return nil, lastErr
}

func newHTTPDoer() *http.Client {
	return &http.Client{
		Timeout: 0,
		// 3xx 的 Location 由 MCP 服务器给出，跟着走等于让第三方把带认证头的 POST
		// 弹到任意地址（含内网）。把 3xx 原样交给调用方，由 request 报成错误。
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 8 * time.Second}).DialContext,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			IdleConnTimeout:       2 * time.Minute,
		},
	}
}

func newHTTPDoerTLS12() *http.Client {
	return &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 8 * time.Second}).DialContext,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			// 每次降级重试都新建一个 Transport：空闲连接必须到期自清，不能积在一次性池里。
			IdleConnTimeout: 30 * time.Second,
			TLSClientConfig: &tls.Config{MaxVersion: tls.VersionTLS12},
		},
	}
}

func isConnectFailure(err error) bool {
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	msg := strings.ToLower(err.Error())
	for _, token := range []string{
		"connection reset", "connection refused", "handshake", "tls", "ssl",
		"eof", "no such host", "network is unreachable", "connectex", "socket hang up",
	} {
		if strings.Contains(msg, token) {
			return true
		}
	}
	return false
}

// isPreSendFailure 判断失败是否发生在请求体发出之前：只有这类错误可以安全重试。
// "等响应头超时"、"connection reset"、"eof" 都可能发生在请求已生效之后，
// 重试会让非幂等的 tools/call 被执行两次。
func isPreSendFailure(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	// 连接阶段：DNS、拒绝连接、握手、建连超时 —— 请求体一定还没发。
	for _, token := range []string{
		"connection refused", "handshake", "tls", "ssl", "no such host",
		"network is unreachable", "connectex", "dial tcp",
	} {
		if strings.Contains(msg, token) {
			return true
		}
	}
	// 连上了但没等到响应头：请求体可能已被处理，不能重发。
	// 同样排除 reset / eof / socket hang up —— 这些都可能发生在服务端收下请求之后。
	return false
}

func (c *httpClient) translateError(err error, timeout time.Duration, method string) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("MCP 服务器「%s」在 %d 秒内没有回应 %s", c.def.ID, int(timeout.Seconds()), method)
	}
	if isConnectFailure(err) {
		// 只给协议 + 主机 + 端口：路径与查询串里可能带 token，
		// 而这段文案会进工具结果、被模型转述给上游 AI 服务商。
		return fmt.Errorf("连不上 %s：%s", logx.RedactURL(c.def.URL), describeConnectError(err))
	}
	// url.Error 的文案形如 `Post "https://host/mcp?token=…": 原因`：
	// 整串会进工具结果与状态接口，这里把地址换成不含路径/查询串的形式。
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		return fmt.Errorf("%s %s：%s", urlErr.Op, logx.RedactURL(urlErr.URL), urlErr.Err)
	}
	return err
}

func describeConnectError(err error) string {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "no such host"):
		return "域名解析失败 —— 检查地址拼写或 DNS"
	case strings.Contains(msg, "connection refused"):
		return "对方拒绝连接 —— 端口没开或被防火墙拦了"
	case strings.Contains(msg, "certificate") || strings.Contains(msg, "x509"):
		return "证书校验失败 —— 对方用了自签名或过期证书"
	case strings.Contains(msg, "connection reset") || strings.Contains(msg, "eof"):
		return "连接被重置 —— 对方中途断开"
	case strings.Contains(msg, "timeout"):
		return "连接超时 —— 常见于网络受限、需要代理，或该域名在本机被阻断"
	}
	// 兜底不能直接用 err.Error()：url.Error 的文案带着完整地址（含 ?token=…）。
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		return clip(urlErr.Err.Error(), 300)
	}
	return clip(logx.Redact(err.Error()), 300)
}

func (c *httpClient) postNotification(message map[string]any) {
	body, _ := json.Marshal(message)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.def.URL, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header = c.buildHeaders()
	resp, err := c.client.Do(req)
	if err == nil {
		_ = resp.Body.Close()
	}
}

func (c *httpClient) Start(ctx context.Context) (*ServerInfo, error) {
	c.mu.Lock()
	if c.initDone && !c.closed {
		info := c.info
		c.mu.Unlock()
		return info, nil
	}
	// Close 后重启：上一轮的会话已随 DELETE 结束，全部清掉重新握手。
	c.closed = false
	c.initDone = false
	c.info = nil
	c.sessionID = ""
	c.mu.Unlock()

	result, err := c.request(ctx, "initialize", buildInitializeParams(c.version), initTimeout)
	if err != nil {
		return nil, err
	}
	var payload struct {
		ProtocolVersion string      `json:"protocolVersion"`
		ServerInfo      *ServerInfo `json:"serverInfo"`
	}
	_ = json.Unmarshal(result, &payload)
	if payload.ProtocolVersion != "" && payload.ProtocolVersion != protocolVersion {
		c.mu.Lock()
		c.negotiated = payload.ProtocolVersion
		c.mu.Unlock()
		c.logf("协商到协议版本 %s（本客户端为 %s），按兼容处理", payload.ProtocolVersion, protocolVersion)
	}
	c.mu.Lock()
	c.info = payload.ServerInfo
	c.initDone = true
	c.mu.Unlock()
	c.postNotification(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	return payload.ServerInfo, nil
}

func (c *httpClient) ListTools(ctx context.Context) ([]Tool, error) {
	if _, err := c.Start(ctx); err != nil {
		return nil, err
	}
	result, err := c.request(ctx, "tools/list", map[string]any{}, listTimeout)
	if err != nil {
		return nil, err
	}
	return normalizeTools(result)
}

func (c *httpClient) CallTool(ctx context.Context, name string, args map[string]any) (ToolResult, error) {
	if _, err := c.Start(ctx); err != nil {
		return ToolResult{}, err
	}
	result, err := c.request(ctx, "tools/call", map[string]any{
		"name": name, "arguments": args,
	}, callTimeout)
	if err != nil {
		return ToolResult{}, err
	}
	return flattenToolResult(result), nil
}

func (c *httpClient) Close() {
	c.mu.Lock()
	session := c.sessionID
	c.closed = true
	c.initDone = false
	c.mu.Unlock()
	if session == "" {
		return
	}
	// 礼貌地结束会话：Streamable HTTP 用 DELETE。会话 ID 必须在状态清空前
	// 构造请求头——之前先清 sessionID 再 buildHeaders，DELETE 实际不带会话。
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	headers.Set("MCP-Protocol-Version", c.negotiated)
	headers.Set("Mcp-Session-Id", session)
	for k, v := range c.def.Headers {
		if k != "" {
			headers.Set(k, v)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.def.URL, nil)
	if err != nil {
		return
	}
	req.Header = headers
	if resp, err := c.client.Do(req); err == nil {
		_ = resp.Body.Close()
	}
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// 注册表

type entry struct {
	def       ServerDef
	signature string
	client    client
	state     string
	errText   string
	tools     []Tool
	toolsAt   time.Time
}

// Registry 管理多台服务器的生命周期与工具清单。服务器是长命子进程，
// 状态要能跨请求保留；只读的状态查询不该顺手拉起一个进程。
type Registry struct {
	log *logx.Logger

	mu      sync.Mutex
	entries map[string]*entry
}

func NewRegistry(log *logx.Logger) *Registry {
	return &Registry{log: log, entries: map[string]*entry{}}
}

func normID(raw string) string {
	id := strings.TrimSpace(raw)
	if len(id) > 64 {
		id = id[:64]
	}
	return id
}

func signatureOf(def ServerDef) string {
	raw, _ := json.Marshal([]any{
		def.Transport(), def.Command, def.Args, def.Env, def.CWD, def.URL, def.Headers,
	})
	return string(raw)
}

func (r *Registry) ensure(def ServerDef) (*entry, error) {
	id := normID(def.ID)
	if id == "" {
		return nil, errors.New("MCP 服务器必须有 id")
	}
	def.ID = id
	sig := signatureOf(def)
	r.mu.Lock()
	defer r.mu.Unlock()
	if prev, ok := r.entries[id]; ok && prev.signature == sig {
		prev.def = def
		return prev, nil
	} else if ok {
		// 配置变了 → 关掉旧进程，避免同时跑两份把同一个资源占两遍。
		go prev.client.Close()
	}
	var c client
	switch def.Transport() {
	case "http":
		c = newHTTPClient(def, r.log, "")
	case "stdio":
		c = newStdioClient(def, r.log, "")
	default:
		c = &unavailableClient{id: id}
	}
	e := &entry{def: def, signature: sig, client: c, state: "idle"}
	r.entries[id] = e
	return e, nil
}

type unavailableClient struct{ id string }

func (u *unavailableClient) Start(context.Context) (*ServerInfo, error) {
	return nil, errors.New("这台服务器既没有地址（url）也没有启动命令（command）")
}
func (u *unavailableClient) ListTools(context.Context) ([]Tool, error) { return nil, nil }
func (u *unavailableClient) CallTool(context.Context, string, map[string]any) (ToolResult, error) {
	return ToolResult{}, errors.New("没有可用的传输方式")
}
func (u *unavailableClient) Close()            {}
func (u *unavailableClient) Running() bool     { return false }
func (u *unavailableClient) Info() *ServerInfo { return nil }

func (r *Registry) start(ctx context.Context, e *entry) *entry {
	r.mu.Lock()
	if e.state == "ready" {
		r.mu.Unlock()
		return e
	}
	e.state = "starting"
	e.errText = ""
	r.mu.Unlock()

	if _, err := e.client.Start(ctx); err != nil {
		r.mu.Lock()
		e.state = "error"
		e.errText = err.Error()
		r.mu.Unlock()
		if r.log != nil {
			r.log.Warnf("MCP", "[%s] 启动失败：%v", e.def.ID, err)
		}
		return e
	}
	r.mu.Lock()
	e.state = "ready"
	e.errText = ""
	r.mu.Unlock()
	return e
}

// ListTools 拿某台服务器的工具清单（会按需启动）。ctx 只控制本次等待；
// 子进程的生命周期由客户端自己的关闭信号管理，不随请求结束。
func (r *Registry) ListTools(ctx context.Context, def ServerDef) ([]Tool, string, error) {
	e, err := r.ensure(def)
	if err != nil {
		return nil, "", err
	}
	r.mu.Lock()
	ready := e.state == "ready" && e.client.Running()
	r.mu.Unlock()
	if !ready {
		e = r.start(ctx, e)
		r.mu.Lock()
		ok := e.state == "ready"
		eErr := e.errText
		r.mu.Unlock()
		if !ok {
			return nil, eErr, errors.New(eErr)
		}
	}
	r.mu.Lock()
	if !e.toolsAt.IsZero() && time.Since(e.toolsAt) < listCacheTTL {
		tools := append([]Tool{}, e.tools...)
		r.mu.Unlock()
		return tools, "", nil
	}
	r.mu.Unlock()

	tools, listErr := e.client.ListTools(ctx)
	r.mu.Lock()
	defer r.mu.Unlock()
	if listErr != nil {
		if !e.client.Running() {
			e.state = "error"
			e.errText = listErr.Error()
		}
		return nil, listErr.Error(), listErr
	}
	e.tools = tools
	e.toolsAt = time.Now()
	return append([]Tool{}, tools...), "", nil
}

// CallTool 调一个工具；工具自身报错（isError / 超时）作为正常结果返回，
// 模型需要那条具体原因而不是「接口 500」。
func (r *Registry) CallTool(ctx context.Context, def ServerDef, name string, args map[string]any) ToolResult {
	e, err := r.ensure(def)
	if err != nil {
		return ToolResult{OK: false, Text: "MCP 服务器配置无效：" + err.Error()}
	}
	r.mu.Lock()
	ready := e.state == "ready" && e.client.Running()
	r.mu.Unlock()
	if !ready {
		e = r.start(ctx, e)
		r.mu.Lock()
		ok := e.state == "ready"
		eErr := e.errText
		r.mu.Unlock()
		if !ok {
			return ToolResult{OK: false, Text: "MCP 服务器没起来：" + eErr}
		}
	}
	result, callErr := e.client.CallTool(ctx, name, args)
	r.mu.Lock()
	if !e.client.Running() {
		e.state = "error"
		e.errText = "进程已退出"
	}
	r.mu.Unlock()
	if callErr != nil {
		return ToolResult{OK: false, Text: "MCP 工具调用失败：" + callErr.Error()}
	}
	return result
}

// Status 是某台服务器的运行状态（不启动它）。
type Status struct {
	State      string      `json:"state"`
	Error      string      `json:"error"`
	Tools      int         `json:"tools"`
	ServerInfo *ServerInfo `json:"serverInfo"`
}

func (r *Registry) Status(def ServerDef) Status {
	id := normID(def.ID)
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.entries[id]
	if !ok {
		return Status{State: "idle"}
	}
	return Status{State: e.state, Error: e.errText, Tools: len(e.tools), ServerInfo: e.client.Info()}
}

// Stop 停掉某台（id 为空则全部）。
func (r *Registry) Stop(id string) []string {
	r.mu.Lock()
	if id == "" {
		all := make([]*entry, 0, len(r.entries))
		ids := make([]string, 0, len(r.entries))
		for key, e := range r.entries {
			all = append(all, e)
			ids = append(ids, key)
		}
		r.entries = map[string]*entry{}
		r.mu.Unlock()
		for _, e := range all {
			e.client.Close()
		}
		return ids
	}
	key := normID(id)
	e, ok := r.entries[key]
	if ok {
		delete(r.entries, key)
	}
	r.mu.Unlock()
	if ok {
		e.client.Close()
		return []string{key}
	}
	return nil
}
