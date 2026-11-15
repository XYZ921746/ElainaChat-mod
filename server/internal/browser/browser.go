// Package browser 让 AI 真的打开浏览器、看页面、点东西、填表单 —— 走 Chrome DevTools Protocol。
// 安全边界：只绑 127.0.0.1（HTTP 层还要再判本机）、独立临时 profile（不碰用户正在用的浏览器）、
// URL 只允许 http/https、空闲即关。
package browser

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"elainachat/server/internal/logx"
	"elainachat/server/internal/wsx"
)

// IDLE_CLOSE 是空闲多久自动关掉浏览器。
const IdleClose = 5 * time.Minute

const (
	cdpTimeout = 15 * time.Second
	navTimeout = 30 * time.Second
)

// MaxSnapshotItems 是页面快照里最多返回多少个可交互元素：太多会把提示词撑爆。
const MaxSnapshotItems = 120

// Candidates 的顺序有意义：Chrome 优先（CDP 行为最标准），Edge 次之（Windows 自带）。
func Candidates() []string {
	if env := strings.TrimSpace(os.Getenv("ELAINA_BROWSER")); env != "" {
		return []string{env}
	}
	switch runtime.GOOS {
	case "windows":
		pf := envOr("ProgramFiles", `C:\Program Files`)
		pf86 := envOr("ProgramFiles(x86)", `C:\Program Files (x86)`)
		local := os.Getenv("LOCALAPPDATA")
		out := []string{
			filepath.Join(pf, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
		}
		if local != "" {
			out = append(out, filepath.Join(local, "Google", "Chrome", "Application", "chrome.exe"))
		}
		out = append(out,
			filepath.Join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
		)
		return out
	case "darwin":
		return []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		}
	default:
		return []string{"/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"}
	}
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// FindExecutable 返回第一个存在的浏览器；找不到返回空串。
func FindExecutable() string {
	for _, p := range Candidates() {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p
		}
	}
	return ""
}

// NormalizeNavigationURL 只认 http/https：file:// 读本地文件、chrome:// 改浏览器设置、
// javascript: 在当前页执行任意代码；同时挡掉换行与空字符（那是在试探命令行注入）。
func NormalizeNavigationURL(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", errors.New("没有给出网址")
	}
	if strings.ContainsAny(text, "\r\n\x00") {
		return "", errors.New("网址里不能有换行或空字符")
	}
	u, err := url.Parse(text)
	if err != nil {
		return "", errors.New("网址格式不正确：" + text)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("只允许 http / https 网址（当前是 " + u.Scheme + "）")
	}
	return u.String(), nil
}

// Snapshot 是一页的可见状态。
type Snapshot struct {
	URL       string `json:"url"`
	Title     string `json:"title"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
	Items     []Item `json:"items"`
}

type Item struct {
	Ref      string `json:"ref"`
	Tag      string `json:"tag"`
	Type     string `json:"type"`
	Text     string `json:"text"`
	Value    string `json:"value"`
	Disabled bool   `json:"disabled"`
}

// snapshotScript 在页面上下文里用 getBoundingClientRect + innerText 算可见性，
// 给每个可交互元素打 data-elaina-ref；模型点时按 ref 找回元素（比坐标可靠）。
const snapshotScript = `(() => {
  const MAX_ITEMS = __MAX_ITEMS__;
  const SEL = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],[onclick]';
  const items = [];
  let n = 0;
  const seen = new Set();
  for (const el of document.querySelectorAll(SEL)) {
    if (items.length >= MAX_ITEMS) break;
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    const ref = String(++n);
    el.setAttribute('data-elaina-ref', ref);
    const isField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    const nameSource = isField
      ? (el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('title') || '')
      : (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '');
    const label = String(nameSource).replace(/\s+/g, ' ').trim().slice(0, 60);
    items.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      text: label,
      value: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? String(el.value || '').slice(0, 120) : '',
      disabled: Boolean(el.disabled),
    });
  }
  const bodyText = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
  return {
    url: location.href,
    title: document.title,
    text: bodyText.slice(0, __MAX_TEXT__),
    truncated: bodyText.length > __MAX_TEXT__,
    items,
  };
})()`

func snapshotExpression(maxItems, maxText int) string {
	return strings.NewReplacer(
		"__MAX_ITEMS__", fmt.Sprintf("%d", maxItems),
		"__MAX_TEXT__", fmt.Sprintf("%d", maxText),
	).Replace(snapshotScript)
}

// Session 是一次浏览器会话。并发调用 ensure 要合并：两个工具调用同时到达时不能起两个浏览器。
type Session struct {
	log      *logx.Logger
	headless bool
	idle     time.Duration

	mu         sync.Mutex
	startMu    sync.Mutex
	child      *exec.Cmd
	profileDir string
	httpBase   string
	page       *wsx.Conn
	browser    *wsx.Conn

	pendingMu sync.Mutex
	pending   map[int64]chan cdpReply

	msgID     int64
	idleTimer *time.Timer
	closed    bool
}

type cdpReply struct {
	ID     int64           `json:"id"`
	Error  *cdpError       `json:"error"`
	Result json.RawMessage `json:"result"`
}

type cdpError struct {
	Message string `json:"message"`
}

func New(log *logx.Logger, headless bool) *Session {
	return &Session{log: log, headless: headless, idle: IdleClose, pending: map[int64]chan cdpReply{}}
}

func (s *Session) logf(format string, args ...any) {
	if s.log != nil {
		s.log.Infof("Browser", format, args...)
	}
}

// IsRunning 的判据是连接而不是进程：Windows 上 Chrome 的启动器进程会先退出，
// 而浏览器仍在跑；把它当崩溃会清空刚连上的连接。
func (s *Session) IsRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.page != nil && !s.closed
}

func (s *Session) touchIdle() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.idleTimer != nil {
		s.idleTimer.Stop()
	}
	s.idleTimer = time.AfterFunc(s.idle, func() { s.Close() })
}

// Ensure 启动浏览器并连上页面 target。
func (s *Session) Ensure() error {
	s.mu.Lock()
	ready := s.page != nil && !s.closed
	s.mu.Unlock()
	if ready {
		s.touchIdle()
		return nil
	}
	// 并发调用排队：两个工具调用同时到达时不能起两个浏览器（第二个会因
	// profile 目录被占用而失败，报错还很难懂）。
	s.startMu.Lock()
	err := s.start()
	s.startMu.Unlock()
	if err != nil {
		s.Close()
		return err
	}
	s.touchIdle()
	return nil
}

// start 不持有 s.mu 做网络与握手：send() 需要拿 s.mu 读连接，
// 持锁调用会自死锁（表现为浏览器请求永远不返回）。
func (s *Session) start() error {
	s.mu.Lock()
	if s.page != nil && !s.closed {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()

	exe := FindExecutable()
	if exe == "" {
		return errors.New("没有找到 Chrome / Edge。装一个，或把浏览器路径写进环境变量 ELAINA_BROWSER。")
	}
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	profileDir, err := os.MkdirTemp("", "elaina-browser-"+hex.EncodeToString(suffix)+"-")
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.profileDir = profileDir
	s.closed = false
	s.mu.Unlock()

	args := []string{
		"--remote-debugging-port=0",
		"--remote-debugging-address=127.0.0.1",
		"--user-data-dir=" + profileDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-features=Translate,MediaRouter",
		"--disable-gpu",
		"--window-size=1280,900",
		"about:blank",
	}
	if s.headless {
		args = append([]string{"--headless=new"}, args...)
	}
	cmd := exec.Command(exe, args...)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(profileDir)
		return fmt.Errorf("启动浏览器失败：%v", err)
	}
	s.mu.Lock()
	s.child = cmd
	s.mu.Unlock()

	deadline := time.Now().Add(20 * time.Second)
	port := 0
	for {
		raw, err := os.ReadFile(filepath.Join(profileDir, "DevToolsActivePort"))
		if err == nil {
			lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
			if len(lines) > 0 {
				if _, scanErr := fmt.Sscanf(strings.TrimSpace(lines[0]), "%d", &port); scanErr == nil && port > 0 {
					break
				}
			}
		}
		if time.Now().After(deadline) {
			return errors.New("浏览器启动超时（DevToolsActivePort 没有出现）")
		}
		time.Sleep(120 * time.Millisecond)
	}
	httpBase := fmt.Sprintf("http://127.0.0.1:%d", port)
	s.mu.Lock()
	s.httpBase = httpBase
	s.mu.Unlock()

	browserWS, err := s.waitForBrowserEndpoint(port, deadline)
	if err != nil {
		return err
	}
	targetWS, err := s.createTarget(httpBase)
	if err != nil {
		return err
	}

	browserConn, err := wsx.Dial(browserWS, 8*time.Second)
	if err != nil {
		return fmt.Errorf("连接浏览器调试口失败：%v", err)
	}
	browserConn.OnClose(func() {
		s.mu.Lock()
		if s.browser == browserConn {
			s.browser = nil
		}
		s.mu.Unlock()
	})
	s.mu.Lock()
	s.browser = browserConn
	s.mu.Unlock()

	pageConn, err := wsx.Dial(targetWS, 8*time.Second)
	if err != nil {
		_ = browserConn.Close()
		return fmt.Errorf("连接页面调试口失败：%v", err)
	}
	go pageConn.ReadLoop(s.handleMessage)
	pageConn.OnClose(func() {
		s.mu.Lock()
		if s.page == pageConn {
			s.page = nil
		}
		s.mu.Unlock()
	})
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = pageConn.Close()
		_ = browserConn.Close()
		return errors.New("浏览器启动过程中被关闭")
	}
	s.page = pageConn
	s.mu.Unlock()

	if _, err := s.send("Page.enable", map[string]any{}, cdpTimeout); err != nil {
		return err
	}
	if _, err := s.send("Runtime.enable", map[string]any{}, cdpTimeout); err != nil {
		return err
	}
	s.logf("浏览器已启动（端口 %d）", port)
	return nil
}

func (s *Session) waitForBrowserEndpoint(port int, deadline time.Time) (string, error) {
	client := &http.Client{Timeout: 1 * time.Second}
	url := fmt.Sprintf("http://127.0.0.1:%d/json/version", port)
	for {
		resp, err := client.Get(url)
		if err == nil {
			var info struct {
				WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&info)
			_ = resp.Body.Close()
			if info.WebSocketDebuggerURL != "" {
				return info.WebSocketDebuggerURL, nil
			}
		}
		if time.Now().After(deadline) {
			return "", errors.New("浏览器启动超时（调试端口没有响应）")
		}
		time.Sleep(120 * time.Millisecond)
	}
}

func (s *Session) createTarget(httpBase string) (string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequest(http.MethodPut, httpBase+"/json/new?about:blank", nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		// 旧版 Chrome 只认 GET。
		resp, err = client.Get(httpBase + "/json/new?about:blank")
		if err != nil {
			return "", err
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("新建标签页失败（HTTP %d）", resp.StatusCode)
	}
	var target struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&target); err != nil {
		return "", err
	}
	if target.WebSocketDebuggerURL == "" {
		return "", errors.New("浏览器没有给出页面调试地址")
	}
	return target.WebSocketDebuggerURL, nil
}

func (s *Session) handleMessage(raw []byte) {
	var reply cdpReply
	if json.Unmarshal(raw, &reply) != nil || reply.ID == 0 {
		return
	}
	s.pendingMu.Lock()
	ch := s.pending[reply.ID]
	delete(s.pending, reply.ID)
	s.pendingMu.Unlock()
	if ch != nil {
		ch <- reply
	}
}

func (s *Session) send(method string, params any, timeout time.Duration) (json.RawMessage, error) {
	s.mu.Lock()
	conn := s.page
	s.mu.Unlock()
	if conn == nil {
		return nil, errors.New("浏览器没有连上（可能已被关闭）")
	}
	s.pendingMu.Lock()
	s.msgID++
	id := s.msgID
	ch := make(chan cdpReply, 1)
	s.pending[id] = ch
	s.pendingMu.Unlock()

	payload, _ := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err := conn.Send(string(payload)); err != nil {
		s.pendingMu.Lock()
		delete(s.pending, id)
		s.pendingMu.Unlock()
		return nil, err
	}
	select {
	case reply := <-ch:
		if reply.Error != nil && reply.Error.Message != "" {
			return nil, errors.New(reply.Error.Message)
		}
		return reply.Result, nil
	case <-time.After(timeout):
		s.pendingMu.Lock()
		delete(s.pending, id)
		s.pendingMu.Unlock()
		return nil, fmt.Errorf("浏览器命令超时：%s", method)
	}
}

// Evaluate 在页面里求值，返回它的值。
func (s *Session) Evaluate(expression string) (json.RawMessage, error) {
	res, err := s.send("Runtime.evaluate", map[string]any{
		"expression":    expression,
		"returnByValue": true,
		"awaitPromise":  true,
		"userGesture":   true,
	}, cdpTimeout)
	if err != nil {
		return nil, err
	}
	var payload struct {
		ExceptionDetails *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
		Result *struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
	}
	if json.Unmarshal(res, &payload) != nil {
		return nil, errors.New("页面求值结果无法解析")
	}
	if payload.ExceptionDetails != nil {
		text := payload.ExceptionDetails.Text
		if text == "" {
			text = "未知"
		}
		return nil, errors.New("页面脚本出错：" + text)
	}
	if payload.Result == nil {
		return nil, nil
	}
	return payload.Result.Value, nil
}

// Goto 打开一个 http(s) 地址，等页面加载完（或超时后照常返回）。
func (s *Session) Goto(rawURL string) (string, error) {
	if err := s.Ensure(); err != nil {
		return "", err
	}
	checked, err := NormalizeNavigationURL(rawURL)
	if err != nil {
		return "", err
	}
	res, err := s.send("Page.navigate", map[string]any{"url": checked}, navTimeout)
	if err != nil {
		return "", err
	}
	var nav struct {
		ErrorText string `json:"errorText"`
	}
	_ = json.Unmarshal(res, &nav)
	if nav.ErrorText != "" {
		return "", errors.New("打不开这个网址：" + nav.ErrorText)
	}
	s.waitForLoad(navTimeout)
	s.touchIdle()
	return checked, nil
}

func (s *Session) waitForLoad(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		raw, err := s.Evaluate("document.readyState")
		if err == nil {
			var state string
			if json.Unmarshal(raw, &state) == nil && (state == "complete" || state == "interactive") {
				return
			}
		}
		time.Sleep(120 * time.Millisecond)
	}
}

// Snapshot 取标题 / 正文 / 可交互元素（带 ref）。
func (s *Session) Snapshot() (*Snapshot, error) {
	if err := s.Ensure(); err != nil {
		return nil, err
	}
	raw, err := s.Evaluate(snapshotExpression(MaxSnapshotItems, 4000))
	if err != nil {
		return nil, err
	}
	var snap Snapshot
	if json.Unmarshal(raw, &snap) != nil {
		return nil, errors.New("页面快照失败")
	}
	if snap.Items == nil {
		snap.Items = []Item{}
	}
	s.touchIdle()
	return &snap, nil
}

func (s *Session) findByRef(ref, body string) (json.RawMessage, error) {
	target, _ := json.Marshal(ref)
	script := "(() => {" +
		"const want = " + string(target) + ";" +
		"const el = Array.from(document.querySelectorAll('[data-elaina-ref]')).find((n) => n.getAttribute('data-elaina-ref') === want);" +
		"if (!el) return null;" +
		"el.scrollIntoView({ block: 'center', inline: 'center' });" +
		"return (" + body + ")(el);" +
		"})()"
	return s.Evaluate(script)
}

// ClickRef 按 ref 真点一下。用 CDP 输入事件而不是 el.click()：后者不触发前置逻辑。
func (s *Session) ClickRef(ref string) error {
	if err := s.Ensure(); err != nil {
		return err
	}
	raw, err := s.findByRef(ref, "(el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }")
	if err != nil {
		return err
	}
	var box struct {
		X int `json:"x"`
		Y int `json:"y"`
	}
	if json.Unmarshal(raw, &box) != nil || string(raw) == "null" {
		return errors.New("页面上找不到编号 " + ref + " 的元素（可能页面已经变了，请重新看一次页面）")
	}
	for _, kind := range []string{"mousePressed", "mouseReleased"} {
		if _, err := s.send("Input.dispatchMouseEvent", map[string]any{
			"type": kind, "x": box.X, "y": box.Y, "button": "left", "clickCount": 1,
		}, cdpTimeout); err != nil {
			return err
		}
	}
	s.touchIdle()
	return nil
}

// TypeIntoRef 先聚焦再 insertText：逐字符敲太慢且中文打不出来。
func (s *Session) TypeIntoRef(ref, text string) error {
	if err := s.Ensure(); err != nil {
		return err
	}
	raw, err := s.findByRef(ref, "(el) => { el.focus(); return true; }")
	if err != nil {
		return err
	}
	if string(raw) != "true" {
		return errors.New("页面上找不到编号 " + ref + " 的输入框（可能页面已经变了，请重新看一次页面）")
	}
	_, err = s.send("Input.insertText", map[string]any{"text": text}, cdpTimeout)
	s.touchIdle()
	return err
}

// PressEnter 提交搜索框 / 确认对话框。
func (s *Session) PressEnter() error {
	if err := s.Ensure(); err != nil {
		return err
	}
	for _, kind := range []string{"keyDown", "keyUp"} {
		if _, err := s.send("Input.dispatchKeyEvent", map[string]any{
			"type": kind, "key": "Enter", "code": "Enter",
			"windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13,
		}, cdpTimeout); err != nil {
			return err
		}
	}
	s.touchIdle()
	return nil
}

// Screenshot 返回 PNG 的 base64。
func (s *Session) Screenshot() (string, error) {
	if err := s.Ensure(); err != nil {
		return "", err
	}
	res, err := s.send("Page.captureScreenshot", map[string]any{"format": "png"}, navTimeout)
	if err != nil {
		return "", err
	}
	var payload struct {
		Data string `json:"data"`
	}
	_ = json.Unmarshal(res, &payload)
	s.touchIdle()
	return payload.Data, nil
}

// Close 先请浏览器自己退出（Browser.close 会走正常关闭流程，profile 才能清干净），
// 不响应再退回杀进程。
func (s *Session) Close() {
	s.mu.Lock()
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
	}
	browserConn := s.browser
	pageConn := s.page
	child := s.child
	profileDir := s.profileDir
	s.browser = nil
	s.page = nil
	s.child = nil
	s.profileDir = ""
	s.closed = true
	s.mu.Unlock()

	if browserConn != nil {
		payload, _ := json.Marshal(map[string]any{"id": 1, "method": "Browser.close", "params": map[string]any{}})
		_ = browserConn.Send(string(payload))
		time.Sleep(300 * time.Millisecond)
		_ = browserConn.Close()
	}
	if pageConn != nil {
		_ = pageConn.Close()
	}
	s.pendingMu.Lock()
	s.pending = map[int64]chan cdpReply{}
	s.pendingMu.Unlock()
	if child != nil && child.Process != nil {
		_ = child.Process.Kill()
		_, _ = child.Process.Wait()
	}
	if profileDir != "" {
		_ = os.RemoveAll(profileDir)
	}
}

// FormatSnapshot 把快照整理成回灌给 AI 的一段话：在服务端拼，
// 让工具调用与标签降级两条通道拿到同一个字符串。
func FormatSnapshot(snap *Snapshot) string {
	lines := []string{}
	title := snap.Title
	if title == "" {
		title = "（无标题）"
	}
	lines = append(lines, "当前页面："+title, "网址："+snap.URL)
	if len(snap.Items) > 0 {
		lines = append(lines, "", "可交互元素（点它 / 往里打字时用编号）：")
		for _, it := range snap.Items {
			kind := "按钮"
			switch it.Tag {
			case "input", "textarea":
				kind = "输入框"
			case "select":
				kind = "下拉框"
			case "a":
				kind = "链接"
			}
			typ := ""
			if it.Type != "" {
				typ = "/" + it.Type
			}
			dis := ""
			if it.Disabled {
				dis = "（不可用）"
			}
			filled := ""
			if it.Value != "" {
				filled = "（当前内容：" + it.Value + "）"
			}
			text := it.Text
			if text == "" {
				text = "（没有文字）"
			}
			lines = append(lines, "  ["+it.Ref+"] "+kind+typ+dis+"："+text+filled)
		}
	} else {
		lines = append(lines, "", "这个页面上没有找到可点的东西。")
	}
	if snap.Text != "" {
		lines = append(lines, "", "正文（截取）：", snap.Text)
		if snap.Truncated {
			lines = append(lines, "…（正文更长，已截断）")
		}
	}
	return strings.Join(lines, "\n")
}

// ActionResult 是 /api/agent/browser 的返回形状。
type ActionResult struct {
	OK   bool      `json:"ok"`
	Text string    `json:"text"`
	Data *Snapshot `json:"data,omitempty"`
}

// RunAction 把一次浏览器操作派发到会话方法上。参数错了要报得清楚
// （模型靠这句话自我纠正），不能变成一句「操作失败」。
func RunAction(session *Session, action string, args map[string]any) ActionResult {
	name := strings.TrimSpace(action)
	str := func(key string) string {
		if v, ok := args[key].(string); ok {
			return v
		}
		return ""
	}
	fail := func(msg string) ActionResult { return ActionResult{OK: false, Text: msg} }

	switch name {
	case "open":
		if err := session.Ensure(); err != nil {
			return fail(err.Error())
		}
		return ActionResult{OK: true, Text: "浏览器已打开（当前是空白页）。用 goto 打开一个网址，或用 snapshot 看当前页面。"}
	case "goto":
		if err := session.Ensure(); err != nil {
			return fail(err.Error())
		}
		opened, err := session.Goto(str("url"))
		if err != nil {
			return fail(err.Error())
		}
		snap, err := session.Snapshot()
		if err != nil {
			return fail(err.Error())
		}
		return ActionResult{OK: true, Text: "已打开 " + opened + "\n\n" + FormatSnapshot(snap), Data: snap}
	case "snapshot":
		snap, err := session.Snapshot()
		if err != nil {
			return fail(err.Error())
		}
		return ActionResult{OK: true, Text: FormatSnapshot(snap), Data: snap}
	case "click":
		ref := strings.TrimSpace(str("ref"))
		if ref == "" {
			return fail("要给出要点的那一项的编号（先 snapshot 看一眼页面，编号在方括号里）")
		}
		if err := session.ClickRef(ref); err != nil {
			return fail(err.Error())
		}
		snap, err := session.Snapshot()
		if err != nil {
			return fail(err.Error())
		}
		return ActionResult{OK: true, Text: "已点击 [" + ref + "]。\n\n" + FormatSnapshot(snap), Data: snap}
	case "type":
		ref := strings.TrimSpace(str("ref"))
		if ref == "" {
			return fail("要给出输入框的编号（先 snapshot 看一眼页面）")
		}
		text, ok := args["text"]
		if !ok || text == nil {
			return fail("要给出要输入的文字")
		}
		value, _ := text.(string)
		if err := session.TypeIntoRef(ref, value); err != nil {
			return fail(err.Error())
		}
		shown := value
		if len(shown) > 200 {
			shown = shown[:200]
		}
		return ActionResult{OK: true, Text: "已在 [" + ref + "] 里输入：" + shown}
	case "press_enter":
		if err := session.PressEnter(); err != nil {
			return fail(err.Error())
		}
		snap, err := session.Snapshot()
		if err != nil {
			return fail(err.Error())
		}
		return ActionResult{OK: true, Text: "已按回车。\n\n" + FormatSnapshot(snap), Data: snap}
	case "close":
		session.Close()
		return ActionResult{OK: true, Text: "浏览器已关闭。"}
	default:
		label := name
		if label == "" {
			label = "（空）"
		}
		return fail("不认识的浏览器操作：" + label + "。可用的是 open / goto / snapshot / click / type / press_enter / close。")
	}
}
