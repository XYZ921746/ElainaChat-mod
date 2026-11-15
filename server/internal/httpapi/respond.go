package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"

	"elainachat/server/internal/security"
)

// writeJSON 是接口的统一出口：Content-Type、nosniff、可选附加头都在这里，
// 各路由只关心状态码与对象。
func writeJSON(w http.ResponseWriter, code int, obj any, extra map[string]string) {
	writeJSONCookies(w, code, obj, extra, nil)
}

// writeJSONCookies 支持一次下发多条 Set-Cookie。用 Add 而不是 Set：
// 登录要同时写新 cookie 和清掉旧的无后缀 cookie，Set 会让后一条覆盖前一条。
func writeJSONCookies(w http.ResponseWriter, code int, obj any, extra map[string]string, cookies []string) {
	body, err := json.Marshal(obj)
	if err != nil {
		body = []byte(`{"ok":false,"message":"响应序列化失败"}`)
		code = http.StatusInternalServerError
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("X-Content-Type-Options", "nosniff")
	for k, v := range extra {
		h.Set(k, v)
	}
	for _, c := range cookies {
		h.Add("Set-Cookie", c)
	}
	w.WriteHeader(code)
	_, _ = w.Write(body)
}

var errBodyTooLarge = errors.New("请求体过大")

// readJSON 超过上限时先把剩余数据读掉再报错：立刻断开会表现为「连接被重置」，
// 客户端只会说请求失败，比明确的大小错误更难查。
func readJSON(r *http.Request, limit int64) (map[string]any, error) {
	if limit <= 0 {
		limit = 64 * 1024
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		_, _ = io.Copy(io.Discard, r.Body)
		return nil, errBodyTooLarge
	}
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if json.Unmarshal(raw, &out) != nil {
		return nil, errors.New("请求不是合法 JSON")
	}
	return out, nil
}

// readRawBody 收原始字节（zip / 备份），超限时把剩余数据读掉再报错：
// 立刻断开会表现为「连接被重置」，客户端只会说上传失败。
func readRawBody(r *http.Request, limit int64) ([]byte, error) {
	if limit <= 0 {
		limit = 64 * 1024
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		_, _ = io.Copy(io.Discard, r.Body)
		return nil, errBodyTooLarge
	}
	return raw, nil
}

func clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if host == "::1" {
		return "127.0.0.1"
	}
	if strings.HasPrefix(host, "::ffff:") {
		return strings.TrimPrefix(host, "::ffff:")
	}
	if host == "" {
		return "?"
	}
	return host
}

func isLocal(r *http.Request) bool {
	return security.IsLocalAddr(r.RemoteAddr)
}

func isHTTPS(r *http.Request) bool { return r.TLS != nil }

func parseCookies(r *http.Request) map[string]string {
	out := make(map[string]string)
	for _, part := range strings.Split(r.Header.Get("Cookie"), ";") {
		i := strings.Index(part, "=")
		if i < 0 {
			continue
		}
		key := strings.TrimSpace(part[:i])
		value := strings.TrimSpace(part[i+1:])
		if decoded, err := url.QueryUnescape(value); err == nil {
			value = decoded
		}
		out[key] = value
	}
	return out
}

// redirect 的 Location 来自请求路径，属于攻击者可控输入：过滤控制字符与引号，
// 防止响应分割或把引号带进头部。
func redirect(w http.ResponseWriter, location, setCookie string) {
	safe := strings.Map(func(r rune) rune {
		switch r {
		case '\r', '\n', '"', '\'', '<', '>', '\\':
			return -1
		}
		return r
	}, location)
	h := w.Header()
	h.Set("Location", safe)
	h.Set("Cache-Control", "no-store")
	if setCookie != "" {
		h.Set("Set-Cookie", setCookie)
	}
	w.WriteHeader(http.StatusFound)
}
