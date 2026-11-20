package httpapi

import (
	"html/template"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
)

// loginTemplate 是未登录时唯一能看到的页面。它不引用任何静态资源：
// 密码没填之前不该依赖 web/ 是否可读，出问题时至少还能登录或看到重置办法。
var loginTemplate = template.Must(template.New("login").Parse(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ElainaChat Mod · 需要访问密码</title>
<style>
  /* 配色取自应用实际渲染值：橄榄绿画布 / 白色面板 / 米色输入框 / 绿色药丸按钮 / 棕色文字 */
  * { box-sizing: border-box; }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px;
    background: #a8b974;
    color: #4c3123;
    font-family: "Outfit Variable", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width:100%; max-width:380px; padding:30px 28px;
    background: #ffffff;
    border: 1px solid #d9c7c0;
    border-radius: 26px;
    box-shadow: 0 26px 70px rgba(58, 39, 29, 0.24);
  }
  .eyebrow { font-size:11px; font-weight:700; letter-spacing:.08em; color:#ff7d4d; margin-bottom:8px; }
  h1 { margin:0 0 8px; font-size:21px; font-weight:700; color:#4c3123; }
  .sub { margin:0 0 20px; font-size:13px; line-height:1.7; color:#765e52; }
  input {
    width:100%; padding:12px 14px; border-radius:13px; outline:none;
    background: #f8f5f2;
    border: 1px solid #d9c7c0;
    color: #4c3123; font-size:14px; line-height:1.5; font-family:inherit;
    transition: all .18s ease;
  }
  input::placeholder { color: #a89a92; }
  input:focus { background:#ffffff; border-color:#a7bb6c; box-shadow:0 0 0 3px rgba(167,187,108,.25); }
  button {
    width:100%; margin-top:12px; padding:12px; cursor:pointer; font-family:inherit;
    border:none; border-radius:999px;
    background: #a7bb6c; color:#ffffff; font-size:15px; font-weight:600;
    transition: all .18s ease;
  }
  button:hover { background:#98ad5c; }
  button:active { transform: translateY(1px); }
  button.forgot { margin-top:10px; padding:9px; background:transparent; color:#738746; border:1px solid #d9c7c0; font-size:13px; font-weight:600; }
  button.forgot:hover { background:#f8f5f2; }
  .forgot-hint { margin-top:10px; padding:10px 12px; background:#f8f5f2; border:1px solid #e9ddda; border-radius:10px; text-align:left; }
  .err { min-height:18px; margin:10px 0 0; font-size:12px; color:#d9541f; }
  .divider { height:1px; background:#e9ddda; margin:18px 0 14px; }
  .hint { margin:0; font-size:11.5px; line-height:1.75; color:#765e52; }
  code { background:#f8f5f2; border:1px solid #e9ddda; color:#738746; padding:1px 6px; border-radius:6px; font-size:11px; }
  a { color:#738746; font-weight:600; text-decoration:underline; }
</style>
</head>
<body>
  <div class="card">
    <div class="eyebrow">ElainaChat Mod · 局域网访问</div>
    <h1>需要访问密码</h1>
    <p class="sub">这台设备需要访问密码，请输入后进入。</p>
    <form id="loginForm">
      <input id="pwd" type="password" placeholder="访问密码" autocomplete="current-password" autofocus>
      <button type="submit">进入</button>
    </form>
    <p class="err" id="err"></p>
    <button type="button" class="forgot" id="forgotBtn">忘记密码？</button>
    <p class="hint forgot-hint" id="forgotHint" style="display:none">
      忘记密码只能重置：<br>
      ① <code>{{.ConfigPath}}</code> 的 <code>password</code> 就是当前密码（界面改密后写在这里）：直接改成新密码后重启应用；<br>
      ② 那里没写 <code>password</code> 时，删除 <code>{{.AuthPath}}</code> 后重启应用，再回「设置 → 高级 → 访问密码」重新设置。
    </p>
    <div class="divider"></div>
    <p class="hint">
      还没设置密码时只有本机能用；设置之后，本机与局域网设备打开应用都需要输入这个密码。<br>
      首次设置请在本机的「设置 → 高级 → 访问密码」里完成。
    </p>
    <div class="divider" id="httpsDivider" style="display:none"></div>
    <p class="hint" id="httpsHint" style="display:none">
      要用语音输入？浏览器规定麦克风只能在 HTTPS 下调用，http 打开的页面一定用不了。<br>
      换成 <a id="httpsLink" href="#">这个 HTTPS 地址</a> 打开即可（首次会提示证书不受信任，
      点「高级」→「继续前往」）。只是聊天的话，现在这个地址就够了。
    </p>
  </div>
<script>
  // 手机通过「http + 局域网 IP」打开时，语音输入会被浏览器禁用；把可点的 HTTPS 地址摆出来，
  // 用户不用记端口号，也不用自己改协议。
  (function () {
    var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (location.protocol !== 'http:' || isLocal) return;
    fetch('/api/server-info')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var p = j && j.httpsPort;
        if (!p) return;
        var path = location.pathname === '/login' ? '/' : location.pathname;
        var url = 'https://' + location.hostname + ':' + p + path + location.search;
        var a = document.getElementById('httpsLink');
        if (a) a.href = url;
        var d = document.getElementById('httpsDivider');
        var h = document.getElementById('httpsHint');
        if (d) d.style.display = 'block';
        if (h) h.style.display = 'block';
      })
      .catch(function () { /* 拿不到就不显示，不影响登录 */ });
  })();

  document.getElementById('forgotBtn').addEventListener('click', function () {
    var h = document.getElementById('forgotHint');
    if (h) h.style.display = h.style.display === 'none' ? 'block' : 'none';
  });

  document.getElementById('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = document.getElementById('err');
    err.textContent = '';
    try {
      var res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('pwd').value })
      });
      var json = await res.json();
      // next 已由服务端过滤为站内应用页（单个 / 开头、非 //host）；没有就回首页。
      var next = {{.Next}};
      if (json.ok) { location.href = next || '/'; return; }
      err.textContent = json.message || '密码不正确';
    } catch (e2) {
      err.textContent = '网络错误：' + e2.message;
    }
  });
</script>
</body>
</html>`))

// safeNextPath 只放行站内应用页：登录后跳转的目标来自查询串，必须挡住 //host、
// 绝对 URL、反斜杠与控制字符，否则登录页会成为开放重定向的一环。
func safeNextPath(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw[0] != '/' || strings.HasPrefix(raw, "//") {
		return ""
	}
	if strings.ContainsAny(raw, "\\\r\n\"'<>") {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "" || u.Host != "" || u.Opaque != "" {
		return ""
	}
	// %2F 解码后可能变成 //host，必须按解码后的 Path 再判一次。
	if !strings.HasPrefix(u.Path, "/") || strings.HasPrefix(u.Path, "//") || !isAppRoute(u.Path) {
		return ""
	}
	return raw
}

func (s *Server) renderLogin(w http.ResponseWriter, next string) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	configPath := s.cfg.ConfigFile
	if configPath == "" {
		configPath = filepath.Join(s.cfg.DataDir, "config.json")
	}
	_ = loginTemplate.Execute(w, struct {
		AuthPath   string
		ConfigPath string
		Next       string
	}{AuthPath: s.auth.AuthFile(), ConfigPath: configPath, Next: next})
}
