// Package updatecheck 查 GitHub 最新 Release，供「设置 → 高级 → 版本与更新」。
//
// 放在服务端是为了：带 User-Agent 发请求（浏览器不能设 UA，GitHub 缺 UA 会拒）；
// 十分钟缓存（未登录每小时只有 60 次）；把网络失败的英文错误翻成可操作的中文；
// 直连失败时用公共 DNS 解析真实 IP 后直连，绕开 hosts 劫持且不改系统设置。
// 只做检测、不做自我更新：三种运行形态的安装方式各不相同，由前端给出下载入口。
package updatecheck

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	apiRoot      = "https://api.github.com/repos/"
	apiHost      = "api.github.com"
	DefaultRepo  = "XYZ921746/ElainaChat-mod"
	defaultTTL   = 10 * time.Minute
	defaultLimit = 8 * time.Second
	maxBody      = 512 * 1024
)

// PublicDNS 只用来解析 api.github.com（hosts 被加速工具劫持时系统解析必失败）。
var PublicDNS = []string{"223.5.5.5", "119.29.29.29", "1.1.1.1"}

// Release 是收敛后的最小形状：GitHub 的 release JSON 有 40+ 字段与用户可控文本，
// 前端只渲染这里点名保留的字段，接口加字段也不会多出没审查过的渲染面。
type Release struct {
	Tag         string  `json:"tag"`
	Name        string  `json:"name"`
	URL         string  `json:"url"`
	PublishedAt string  `json:"publishedAt"`
	Notes       string  `json:"notes"`
	Prerelease  bool    `json:"prerelease"`
	SourceZip   string  `json:"sourceZip"`
	Assets      []Asset `json:"assets"`
}

type Asset struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

// Result 是 /api/app/update 的 body（current/edition 由路由补上）。
type Result struct {
	OK        bool     `json:"ok"`
	Code      string   `json:"code,omitempty"`
	Message   string   `json:"message,omitempty"`
	CheckedAt int64    `json:"checkedAt"`
	Repo      string   `json:"repo,omitempty"`
	ViaBypass bool     `json:"viaBypass,omitempty"`
	Cached    bool     `json:"cached,omitempty"`
	Release   *Release `json:"release,omitempty"`
	HostsFile string   `json:"hostsFile,omitempty"`
	HostsLine int      `json:"hostsLine,omitempty"`
}

var repoPart = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
var dotsOnly = regexp.MustCompile(`^\.+$`)

// IsValidRepo 校验 owner/repo 形状：它会成为请求 URL 的一部分，
// 不校验时一段 ../ 就能把请求带到别的接口上。
func IsValidRepo(repo string) bool {
	parts := strings.Split(strings.TrimSpace(repo), "/")
	if len(parts) != 2 {
		return false
	}
	for _, p := range parts {
		if !repoPart.MatchString(p) || dotsOnly.MatchString(p) {
			return false
		}
	}
	return true
}

// IsPublicIP 判定公网 IPv4：公共 DNS 也可能被污染成 127.0.0.1 / 内网地址，
// 那样直连就变成打本机服务，比「检测失败」更糟。
func IsPublicIP(ip string) bool {
	parsed := net.ParseIP(strings.TrimSpace(ip))
	if parsed == nil || parsed.To4() == nil {
		return false
	}
	v4 := parsed.To4()
	a, b := int(v4[0]), int(v4[1])
	switch {
	case a == 0 || a == 10 || a == 127 || a >= 224:
		return false
	case a == 169 && b == 254:
		return false
	case a == 172 && b >= 16 && b <= 31:
		return false
	case a == 192 && b == 168:
		return false
	}
	return true
}

// HostsHit 是 hosts 里把主机指到本机/黑洞的一行。
type HostsHit struct {
	Line int
	IP   string
	Text string
}

// FindHostsHijack 在 hosts 文本里找「把某个主机名指到本机/黑洞」的行。纯函数，便于断言。
func FindHostsHijack(text, host string) *HostsHit {
	wanted := strings.ToLower(strings.TrimSpace(host))
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		body := line
		if idx := strings.Index(body, "#"); idx >= 0 {
			body = body[:idx]
		}
		body = strings.TrimSpace(body)
		if body == "" {
			continue
		}
		parts := strings.Fields(body)
		if len(parts) < 2 {
			continue
		}
		ip := parts[0]
		if !(strings.HasPrefix(ip, "127.") || ip == "::1" || ip == "0.0.0.0") {
			continue
		}
		for _, h := range parts[1:] {
			if strings.ToLower(h) == wanted {
				return &HostsHit{Line: i + 1, IP: ip, Text: strings.TrimSpace(line)}
			}
		}
	}
	return nil
}

// ReadHostsFile 读系统 hosts；读不到返回空，不报错。
func ReadHostsFile() (path, text string) {
	candidates := []string{"/etc/hosts"}
	if os.PathSeparator == '\\' {
		root := os.Getenv("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		candidates = []string{filepath.Join(root, "System32", "drivers", "etc", "hosts")}
	}
	for _, p := range candidates {
		if raw, err := os.ReadFile(p); err == nil {
			return p, string(raw)
		}
	}
	return "", ""
}

// SanitizeRelease 把 GitHub 的 release 对象收敛成前端要用的最小形状。
func SanitizeRelease(raw []byte) *Release {
	var payload struct {
		TagName    string `json:"tag_name"`
		Name       string `json:"name"`
		HTMLURL    string `json:"html_url"`
		Published  string `json:"published_at"`
		Body       string `json:"body"`
		Prerelease bool   `json:"prerelease"`
		Zipball    string `json:"zipball_url"`
		Assets     []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
			Size int64  `json:"size"`
		} `json:"assets"`
	}
	if json.Unmarshal(raw, &payload) != nil || strings.TrimSpace(payload.TagName) == "" {
		return nil
	}
	release := &Release{
		Tag:         strings.TrimSpace(payload.TagName),
		Name:        clip(payload.Name, 200),
		URL:         payload.HTMLURL,
		PublishedAt: payload.Published,
		Notes:       clipRun(payload.Body, 20000),
		Prerelease:  payload.Prerelease,
		SourceZip:   payload.Zipball,
		Assets:      []Asset{},
	}
	if release.Name == "" {
		release.Name = release.Tag
	}
	for _, a := range payload.Assets {
		if len(release.Assets) >= 40 {
			break
		}
		name := clip(a.Name, 200)
		if name == "" || !strings.HasPrefix(strings.ToLower(a.URL), "https://") {
			continue
		}
		release.Assets = append(release.Assets, Asset{Name: name, URL: a.URL, Size: a.Size})
	}
	return release
}

// Checker 带缓存。缓存未过期时直接复用成功结果。
type Checker struct {
	Repo    string
	TTL     time.Duration
	Timeout time.Duration
	UA      string

	// 测试注入用：BaseURL 替换 api.github.com，Client 替换默认传输。
	BaseURL string
	Client  *http.Client

	mu     sync.Mutex
	cached *Result
}

func New(repo string, logUA string) *Checker {
	if strings.TrimSpace(repo) == "" {
		repo = os.Getenv("ELAINA_UPDATE_REPO")
	}
	if strings.TrimSpace(repo) == "" {
		repo = DefaultRepo
	}
	if logUA == "" {
		logUA = "ElainaChat-mod"
	}
	return &Checker{Repo: strings.TrimSpace(repo), TTL: defaultTTL, Timeout: defaultLimit, UA: logUA}
}

// Check 查最新 Release；成功结果在 TTL 内直接复用。
func (c *Checker) Check(ctx context.Context) Result {
	c.mu.Lock()
	if c.cached != nil {
		age := time.Since(time.UnixMilli(c.cached.CheckedAt))
		if age < c.ttl() {
			cached := *c.cached
			cached.Cached = true
			c.mu.Unlock()
			return cached
		}
	}
	c.mu.Unlock()

	result := c.fetchOnce(ctx)
	if result.OK {
		c.mu.Lock()
		stored := result
		c.cached = &stored
		c.mu.Unlock()
	}
	return result
}

func (c *Checker) ttl() time.Duration {
	if c.TTL > 0 {
		return c.TTL
	}
	return defaultTTL
}

func (c *Checker) timeout() time.Duration {
	if c.Timeout > 0 {
		return c.Timeout
	}
	return defaultLimit
}

func (c *Checker) fetchOnce(ctx context.Context) Result {
	checkedAt := time.Now().UnixMilli()
	if !IsValidRepo(c.Repo) {
		return Result{OK: false, Code: "CONFIG", Message: "更新检查的仓库名不合法：" + c.Repo, CheckedAt: checkedAt}
	}
	base := c.BaseURL
	if base == "" {
		base = apiRoot
	}
	url := strings.TrimSuffix(base, "/") + "/" + c.Repo + "/releases/latest"
	status, headers, body, err := c.request(ctx, url, false)
	if err == nil {
		return c.handleResponse(status, headers, body, checkedAt, false)
	}

	info := describeError(err)
	if !bypassable[info.Code] {
		return Result{OK: false, Code: info.Code, Message: info.Message, CheckedAt: checkedAt}
	}
	// 直连失败：换公共 DNS 解析真实 IP 再直连一次，只在网络层失败时做。
	ip := resolvePublicIPv4(ctx, apiHost)
	if ip != "" {
		if status, headers, body, bypassErr := c.request(ctx, url, true); bypassErr == nil {
			result := c.handleResponse(status, headers, body, checkedAt, true)
			if result.OK || result.Code == "NO_RELEASE" || result.Code == "RATE_LIMIT" || result.Code == "HTTP" || result.Code == "BAD_RESPONSE" {
				return result
			}
		}
	}
	return c.withHostsEvidence(Result{OK: false, Code: info.Code, Message: info.Message, CheckedAt: checkedAt})
}

func (c *Checker) request(ctx context.Context, target string, byIP bool) (int, http.Header, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout())
	defer cancel()
	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         (&net.Dialer{Timeout: c.timeout()}).DialContext,
		TLSHandshakeTimeout: 5 * time.Second,
		IdleConnTimeout:     30 * time.Second,
	}
	if byIP {
		ip := resolvePublicIPv4(ctx, apiHost)
		if ip == "" {
			return 0, nil, nil, &net.OpError{Op: "dial", Err: errDNS}
		}
		transport = &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				_, port, err := net.SplitHostPort(addr)
				if err != nil {
					port = "443"
				}
				// 证书仍按 api.github.com 校验：公共 DNS 返回假 IP 时 TLS 会失败，
				// 不会把假 IP 的响应当成 GitHub 的数据。
				return (&net.Dialer{Timeout: c.timeout()}).DialContext(ctx, network, net.JoinHostPort(ip, port))
			},
			TLSHandshakeTimeout: 5 * time.Second,
			IdleConnTimeout:     30 * time.Second,
		}
	}
	client := &http.Client{Transport: transport}
	if c.Client != nil {
		client = c.Client
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", c.UA)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return 0, nil, nil, err
	}
	if len(raw) > maxBody {
		return resp.StatusCode, resp.Header, nil, errBodyTooLarge
	}
	return resp.StatusCode, resp.Header, raw, nil
}

var errBodyTooLarge = errors.New("响应体过大")
var errDNS = &net.DNSError{Err: "no such host", Name: apiHost}

var bypassable = map[string]bool{"TIMEOUT": true, "DNS": true, "REFUSED": true, "TLS": true, "NETWORK": true}

type errorInfo struct {
	Code    string
	Message string
}

func (c *Checker) handleResponse(status int, headers http.Header, body []byte, checkedAt int64, viaBypass bool) Result {
	switch {
	case status == 404:
		return Result{OK: false, Code: "NO_RELEASE", Message: "这个仓库还没有发布 Release（或仓库不存在）", CheckedAt: checkedAt}
	case status == 403 || status == 429:
		if headers.Get("X-RateLimit-Remaining") == "0" || status == 429 {
			return Result{OK: false, Code: "RATE_LIMIT", Message: rateLimitMessage(headers, checkedAt), CheckedAt: checkedAt}
		}
		return Result{OK: false, Code: "RATE_LIMIT", Message: "GitHub 拒绝了这次请求（HTTP " + strconv.Itoa(status) + "，可能是网络出口被限制）", CheckedAt: checkedAt}
	case status < 200 || status >= 300:
		return Result{OK: false, Code: "HTTP", Message: "GitHub 返回 HTTP " + strconv.Itoa(status), CheckedAt: checkedAt}
	}
	release := SanitizeRelease(body)
	if release == nil {
		return Result{OK: false, Code: "BAD_RESPONSE", Message: "GitHub 返回的内容看不懂（可能接口变了）", CheckedAt: checkedAt}
	}
	return Result{OK: true, CheckedAt: checkedAt, Repo: c.Repo, ViaBypass: viaBypass, Release: release}
}

func rateLimitMessage(headers http.Header, nowMillis int64) string {
	reset, err := strconv.ParseInt(headers.Get("X-RateLimit-Reset"), 10, 64)
	if err != nil || reset <= 0 {
		return "GitHub 接口限流（未登录每小时 60 次），请稍后再试"
	}
	minutes := int((reset*1000 - nowMillis + 59999) / 60000)
	if minutes < 1 {
		minutes = 1
	}
	return "GitHub 接口限流（未登录每小时 60 次），约 " + strconv.Itoa(minutes) + " 分钟后可再试"
}

func (c *Checker) withHostsEvidence(result Result) Result {
	path, text := ReadHostsFile()
	if path == "" || text == "" {
		return result
	}
	hit := FindHostsHijack(text, apiHost)
	if hit == nil {
		return result
	}
	result.HostsFile = path
	result.HostsLine = hit.Line
	result.Message += "；检测到 " + path + " 第 " + strconv.Itoa(hit.Line) + " 行把 " + apiHost +
		" 指到了 " + hit.IP + "（加速工具常见），可在该工具里放行或删掉这一行"
	return result
}

func resolvePublicIPv4(ctx context.Context, host string) string {
	for _, server := range PublicDNS {
		resolver := &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "udp", net.JoinHostPort(server, "53"))
			},
		}
		lookupCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		addrs, err := resolver.LookupIP(lookupCtx, "ip4", host)
		cancel()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if IsPublicIP(a.String()) {
				return a.String()
			}
		}
	}
	return ""
}

func describeError(err error) errorInfo {
	text := strings.ToLower(err.Error())
	switch {
	case strings.Contains(text, "响应体过大"):
		return errorInfo{Code: "NETWORK", Message: "GitHub 返回内容过大"}
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(text, "timeout") || strings.Contains(text, "deadline exceeded"):
		return errorInfo{Code: "TIMEOUT", Message: "连接 GitHub 超时（网络不稳定或需要代理）"}
	case strings.Contains(text, "no such host") || strings.Contains(text, "server misbehaving"):
		return errorInfo{Code: "DNS", Message: "域名解析失败（api.github.com 解析不到，检查网络或 hosts）"}
	case strings.Contains(text, "connection refused"):
		return errorInfo{Code: "REFUSED", Message: "连接被拒绝（本地有代理或 hosts 把 GitHub 指到了本机？）"}
	case strings.Contains(text, "certificate") || strings.Contains(text, "tls") || strings.Contains(text, "cert"):
		return errorInfo{Code: "TLS", Message: "HTTPS 连接失败（证书校验或 TLS 握手被中断）"}
	}
	return errorInfo{Code: "NETWORK", Message: "网络请求失败：" + clip(err.Error(), 120)}
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func clipRun(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}
