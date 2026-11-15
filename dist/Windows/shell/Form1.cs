using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MiniBrowser;

public class Form1 : Form
{
    private static readonly string StartHtml =
        """
        <!doctype html>
        <html><head><meta charset="utf-8"><title>起始页</title>
        <style>
          body{font-family:"Segoe UI",system-ui,sans-serif;height:100vh;margin:0;display:flex;
               align-items:center;justify-content:center;background:linear-gradient(135deg,#4f7cf0,#7a4ff0)}
          .wrap{width:min(560px,86vw);text-align:center;color:#fff}
          h1{font-size:34px;margin:0 0 26px;letter-spacing:2px;font-weight:600}
          input{width:100%;box-sizing:border-box;padding:13px 20px;font-size:16px;border:none;
                border-radius:25px;outline:none;box-shadow:0 6px 24px rgba(0,0,0,.25)}
          .links{margin-top:30px;display:flex;gap:14px;justify-content:center;flex-wrap:wrap}
          a{color:#fff;text-decoration:none;background:rgba(255,255,255,.18);padding:7px 16px;
            border-radius:15px;font-size:14px}
          a:hover{background:rgba(255,255,255,.32)}
          p{font-size:12px;opacity:.75;margin-top:26px}
        </style></head>
        <body>
          <div class="wrap">
            <h1>MiniBrowser</h1>
            <form onsubmit="location.href='https://www.bing.com/search?q='+encodeURIComponent(this.q.value);return false">
              <input name="q" placeholder="搜索或输入网址，回车前往" autofocus>
            </form>
            <div class="links">
              <a href="https://www.bing.com">必应</a>
              <a href="https://www.baidu.com">百度</a>
              <a href="https://github.com">GitHub</a>
              <a href="https://www.zhihu.com">知乎</a>
              <a href="https://www.bilibili.com">哔哩哔哩</a>
            </div>
            <p>基于系统 WebView2 · Ctrl+T 新标签 · Ctrl+W 关闭 · Ctrl+L 定位地址栏</p>
          </div>
        </body></html>
        """;

    private const string LoadingHtml =
        """
        <!doctype html>
        <html><head><meta charset="utf-8"><title>启动中</title>
        <style>
          body{font-family:"Segoe UI",system-ui,sans-serif;height:100vh;margin:0;display:flex;
               align-items:center;justify-content:center;background:linear-gradient(135deg,#4f7cf0,#7a4ff0)}
          .card{color:#fff;text-align:center}
          h1{font-size:26px;font-weight:600;margin:0 0 18px}
          .dot{width:10px;height:10px;border-radius:50%;background:#fff;display:inline-block;
               margin:0 5px;animation:b 1.2s infinite ease-in-out}
          .d2{animation-delay:.15s}.d3{animation-delay:.3s}
          @keyframes b{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
          p{font-size:13px;opacity:.8}
        </style></head>
        <body><div class="card">
          <h1>ElainaChat</h1>
          <span class="dot"></span><span class="dot d2"></span><span class="dot d3"></span>
          <p>正在启动本地服务，请稍候…</p>
        </div></body></html>
        """;

    private readonly TabControl _tabs = new() { Dock = DockStyle.Fill, Padding = new Point(0, 0) };

    private readonly ToolStrip _toolbar = new()
    {
        Dock = DockStyle.Top,
        GripStyle = ToolStripGripStyle.Hidden,
        Padding = new Padding(6, 3, 6, 2),
    };

    private readonly StatusStrip _statusBar = new() { Dock = DockStyle.Bottom, SizingGrip = false };
    private readonly ToolStripStatusLabel _status = new() { Spring = true, TextAlign = ContentAlignment.MiddleLeft };

    private readonly ToolStripButton _back = new() { Text = "← 后退", ToolTipText = "后退" };
    private readonly ToolStripButton _forward = new() { Text = "前进 →", ToolTipText = "前进" };
    private readonly ToolStripButton _reload = new() { Text = "⟳", ToolTipText = "刷新" };
    private readonly ToolStripButton _home = new() { Text = "⌂ 主页", ToolTipText = "回到起始页" };
    private readonly ToolStripButton _newTab = new() { Text = "＋", ToolTipText = "新标签页 (Ctrl+T)" };
    private readonly ToolStripButton _closeTab = new() { Text = "✕", ToolTipText = "关闭当前标签 (Ctrl+W)" };
    private readonly ToolStripTextBox _address = new() { AutoSize = false, Width = 640 };

    private readonly HotKeyFilter _hotKeys;
    private readonly string? _startupUrl;
    private readonly ShellHost? _shell;
    private CoreWebView2Environment? _env;
    private Panel? _shellPanel;
    private WebView2? _shellWeb;
    private NotifyIcon? _tray;
    private bool _reallyExit;
    private bool _trayTipShown;
    // 应用壳模式的导航握手：服务就绪（_readyPort）与 WebView2 就绪（_coreReady）
    // 是两件独立的事，谁先谁后不定 —— WebView2 环境冷启动要好几秒，而 node
    // 起服务只要一两秒。两边各自到齐后 TryNavigateApp() 补一次导航；只依赖
    // 其中一边会出竞态：服务先就绪时 CurrentCore 还是 null，`?.` 把导航静默
    // 吞掉，之后没有人再补 —— 窗口永远停在「正在启动本地服务」加载页
    // （实测概率性卡死就是这个机理，node 日志显示服务 2 秒就绪、一切正常）。
    private int _readyPort = -1;
    private bool _coreReady;
    private bool _appNavigated;
    private string? _debugBrowserArgs;

    public Form1(string? startupUrl = null, ShellHost? shell = null)
    {
        _startupUrl = startupUrl;
        _shell = shell;
        Text = _shell?.AppName ?? "MiniBrowser";
        Font = new Font("Segoe UI", 9F);
        ClientSize = new Size(1152, 720);
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(520, 360);

        _statusBar.Items.Add(_status);

        if (_shell is not null)
        {
            // 应用壳模式：用系统原生标题栏 —— 圆角、阴影、系统三键、悬停最大化出分屏、
            // 拖到屏幕边缘吸附都由 Windows 提供；自绘标题栏与边缘热区那套已移除。
            // 应用图标由 Icon 提供，原生标题栏左侧显示 app.ico。
            BackColor = PageBack;
            _shellPanel = new Panel { Dock = DockStyle.Fill, BackColor = PageBack };
            Controls.Add(_shellPanel);
            try
            {
                var iconPath = _shell.IconPath;
                if (File.Exists(iconPath)) Icon = new Icon(iconPath);
            }
            catch { }
            BuildTray();
        }
        else
        {
            _toolbar.Items.Add(_back);
            _toolbar.Items.Add(_forward);
            _toolbar.Items.Add(new ToolStripSeparator());
            _toolbar.Items.Add(_reload);
            _toolbar.Items.Add(_home);
            _toolbar.Items.Add(new ToolStripSeparator());
            _toolbar.Items.Add(_address);
            _toolbar.Items.Add(_newTab);
            _toolbar.Items.Add(_closeTab);

            // Fill 控件先加入，Top/Bottom 工具条后加入，才能正确分配剩余空间
            Controls.Add(_tabs);
            Controls.Add(_toolbar);
            Controls.Add(_statusBar);
        }

        _back.Click += (s, e) => CurrentCore?.GoBack();
        _forward.Click += (s, e) => CurrentCore?.GoForward();
        _reload.Click += (s, e) => CurrentWeb?.Reload();
        _home.Click += (s, e) => GoHome();
        _newTab.Click += (s, e) => NewTab();
        _closeTab.Click += (s, e) => CloseCurrentTab();
        _address.KeyDown += AddressKeyDown;
        _tabs.SelectedIndexChanged += (s, e) => SyncUi();

        _hotKeys = new HotKeyFilter(this);
        if (_shell is null) Application.AddMessageFilter(_hotKeys);

        if (_shell is null) Resize += (s, e) => LayoutAddress();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // 壳模式：点关闭 = 最小化到系统托盘（后台继续运行）；
        // 真正退出只能通过托盘右键菜单的「退出」。
        // 只放行系统关机 / Application.Exit 这类必须退出的场景
        if (_shell is not null && !_reallyExit
            && e.CloseReason != CloseReason.WindowsShutDown
            && e.CloseReason != CloseReason.ApplicationExitCall)
        {
            e.Cancel = true;
            Hide();
            if (!_trayTipShown && _tray is not null)
            {
                _trayTipShown = true;
                _tray.ShowBalloonTip(2500, _shell.AppName,
                    "程序已最小化到系统托盘，左键点击图标可重新打开，右键可退出。",
                    ToolTipIcon.Info);
            }
            return;
        }
        base.OnFormClosing(e);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        Application.RemoveMessageFilter(_hotKeys);
        _viewportSyncTimer?.Stop();
        _viewportSyncTimer?.Dispose();
        if (_tray is not null)
        {
            _tray.Visible = false;
            _tray.Dispose();
        }
        ModWindows.CloseAll();
        _shell?.Shutdown();
        base.OnFormClosed(e);
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);

            var appName = _shell?.AppName ?? "MiniBrowser";
            if (_shell is not null)
            {
                ApplyDarkTitleBar();
                StartViewportSync();
            try
            {
                _shell.Start();
            }
            catch (Exception ex)
            {
                MessageBox.Show("启动服务失败：\r\n" + ex.Message, appName,
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }
        }
        else
        {
            _status.Text = "正在初始化 WebView2…";
        }

        try
        {
            // 所有标签共用同一个环境（同一个浏览器进程），用户数据按应用名隔离存放
            var udf = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                appName, "WebView2");
            // 新版 WebView2 运行时出于安全不再认 COREWEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 环境变量，
            // 远程调试端口只能在应用代码里显式给：设了 ELAINA_SHELL_DEBUG_PORT 才开（默认不开），
            // 供壳的自动化端到端（CDP 驱动页面）使用，生产环境无此变量不受影响。
            var opts = new CoreWebView2EnvironmentOptions();
            var dbgPort = Environment.GetEnvironmentVariable("ELAINA_SHELL_DEBUG_PORT");
            if (!string.IsNullOrWhiteSpace(dbgPort))
            {
                _debugBrowserArgs = "--remote-debugging-port=" + dbgPort.Trim();
                opts.AdditionalBrowserArguments = _debugBrowserArgs;
            }
            _env = await CoreWebView2Environment.CreateAsync(null, udf, opts);

            if (_shell is not null)
            {
                NewTab(html: LoadingHtml);
                var port = await _shell.WaitForServerAsync(45000);
                if (IsDisposed) return;
                if (port < 0)
                {
                    var detail = _shell.ServerExited
                        ? "服务进程已退出（退出码 " + _shell.ServerExitCode + "）。"
                        : "等待服务端口就绪超时。";
                    MessageBox.Show(detail + "\r\n\r\n—— 日志尾部 ——" + Environment.NewLine + _shell.LogTail(),
                        appName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Close();
                    return;
                }
                Text = appName;
                _readyPort = port;          // 服务侧就绪 —— TryNavigateApp 等 WebView2 侧到齐
                TryNavigateApp();
            }
            else
            {
                LayoutAddress();
                NewTab(string.IsNullOrWhiteSpace(_startupUrl) ? null : NormalizeUrl(_startupUrl));
                _status.Text = "就绪 · WebView2 " + _env.BrowserVersionString;
            }
        }
        catch (Exception ex)
        {
            _status.Text = "初始化失败: " + ex.Message;
            MessageBox.Show("WebView2 初始化失败：\r\n" + ex.Message,
                appName, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private WebView2? CurrentWeb => _shell is not null ? _shellWeb : _tabs.SelectedTab?.Tag as WebView2;
    private CoreWebView2? CurrentCore => CurrentWeb?.CoreWebView2;

    private TabPage? NewTab(string? initialUrl = null, string? html = null)
    {
        var wv = new WebView2 { Dock = DockStyle.Fill };
        if (_shell is not null)
        {
            // resize 时未渲染的边缘区域显示此颜色（默认透明会在深色背景上呈黑边）
            wv.DefaultBackgroundColor = PageBack;
        }
        TabPage? page = null;

        if (_shell is not null)
        {
            _shellWeb = wv;
            _shellPanel!.Controls.Add(wv);
        }
        else
        {
            page = new TabPage("新标签页");
            page.Controls.Add(wv);
            page.Tag = wv;
        }

        wv.CoreWebView2InitializationCompleted += (s, e) =>
        {
            if (!e.IsSuccess)
            {
                _status.Text = "WebView2 初始化失败: " + e.InitializationException.Message;
                return;
            }
            var core = wv.CoreWebView2!;
            if (_shell is not null)
            {
                _coreReady = true;          // WebView2 侧就绪 —— TryNavigateApp 等服务侧到齐
            }
            HookCore(page, wv, core);
            if (initialUrl is not null) core.Navigate(initialUrl);
            else if (html is not null) core.NavigateToString(html);
            else core.NavigateToString(StartHtml);
            if (_shell is not null)
            {
                TryNavigateApp();           // 服务若已就绪，这里补上被竞态错过的导航
            }
        };
        wv.EnsureCoreWebView2Async(_env);

        if (page is not null)
        {
            _tabs.TabPages.Add(page);
            _tabs.SelectedTab = page;
        }
        return page;
    }

    private void HookCore(TabPage? page, WebView2 wv, CoreWebView2 core)
    {
        core.DocumentTitleChanged += (s, e) =>
        {
            var title = core.DocumentTitle;
            if (page is not null)
            {
                page.Text = Truncate(title, 18);
                if (_tabs.SelectedTab == page) Text = title + " - MiniBrowser";
            }
            // 应用壳模式不跟随页面标题：标题栏固定显示 shell.json 的 appName
        };
        wv.SourceChanged += (s, e) =>
        {
            if (_tabs.SelectedTab != page) return;
            SyncAddress(wv);
        };
        core.NavigationStarting += (s, e) =>
        {
            if (_tabs.SelectedTab == page) _status.Text = "正在加载…";
        };
        core.NavigationCompleted += (s, e) =>
        {
            if (_tabs.SelectedTab != page) return;
            _status.Text = e.IsSuccess ? "完成" : "加载失败: " + e.WebErrorStatus;
            SyncNavButtons();
        };
        core.NewWindowRequested += (s, e) =>
        {
            e.Handled = true;
            if (_shell is not null)
            {
                // 应用壳模式：本机地址在当前窗口打开，外部链接交给系统默认浏览器
                var external = true;
                try
                {
                    var host = new Uri(e.Uri!).Host;
                    if (host == "127.0.0.1" || host == "localhost" || host == "[::1]") external = false;
                }
                catch { }
                if (!external)
                {
                    core.Navigate(e.Uri);
                    return;
                }
                try { Process.Start(new ProcessStartInfo(e.Uri!) { UseShellExecute = true }); } catch { }
                return;
            }
            // 浏览器模式：弹出窗口一律转为新标签页
            NewTab(e.Uri);
        };
        if (_shell is not null)
        {
            // mod 窗口协议：页面决定开什么（id/url/尺寸），壳只当通用窗口宿主，不认识任何插件。
            // 弹窗不走 NewWindowRequested——那里本机地址会被并入当前窗口，正是要避免的。
            core.WebMessageReceived += OnShellWebMessage;
        }
    }

    /// <summary>主窗口页面发来的壳请求：开/关 mod 置顶窗。消息内容不可信：id/url 非空才动作，
    /// 尺寸异常由 ModWindow 内部夹紧。</summary>
    private void OnShellWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var json = e.WebMessageAsJson ?? "";
        switch (ShellMsg.Str(json, "type"))
        {
            case "mod-window-open":
                var url = ShellMsg.Str(json, "url");
                if (string.IsNullOrWhiteSpace(url)) return;
                // 页面可能发站点根相对路径（mod 的 assetUrl 就是这种）：按本机服务补全成绝对地址再校验
                if (url.StartsWith("/"))
                    url = "http://127.0.0.1:" + _readyPort + url;
                // 只接受本机服务的地址：mod 窗口与主窗口必须同源，BroadcastChannel 才能互通，
                // 也杜绝页面借壳把任意网页挂成置顶窗
                if (!url.StartsWith("http://127.0.0.1:" + _readyPort + "/", StringComparison.OrdinalIgnoreCase)
                    && !url.StartsWith("http://localhost:" + _readyPort + "/", StringComparison.OrdinalIgnoreCase))
                    return;
                // WPF 窗活在独立线程里：closed/唤起回调经 BeginInvoke 折回主线程再碰 WebView2
                var udf = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    _shell!.AppName, "WebView2");
                ModWindows.OpenOrReplace(udf, _debugBrowserArgs ?? "",
                    id2 => BeginInvoke(new Action(() => NotifyModWindowClosed(id2))),
                    () => BeginInvoke(new Action(ShowFromTray)),
                    _shell.AppName, ShellMsg.Str(json, "id") ?? "",
                    url, ShellMsg.Int(json, "width", 300), ShellMsg.Int(json, "height", 400));
                break;
            case "mod-window-close":
                var id = ShellMsg.Str(json, "id");
                if (!string.IsNullOrWhiteSpace(id)) ModWindows.CloseById(id);
                break;
            case "mod-window-focus-main":
                ShowFromTray();
                break;
        }
    }

    /// <summary>mod 窗口被用户/系统关闭时回发主页面：页面据此复位自己的按钮与开关状态。</summary>
    internal void NotifyModWindowClosed(string id)
    {
        try { CurrentCore?.PostWebMessageAsJson("{\"type\":\"mod-window-closed\",\"id\":\"" + id + "\"}"); }
        catch { }
    }

    /// <summary>ModWindow 构造需要（窗标题 = 应用名 · id）。</summary>
    internal string? ShellAppName => _shell?.AppName;


    private void CloseCurrentTab()
    {
        if (_tabs.SelectedTab is TabPage p) CloseTab(p);
    }

    private void CloseTab(TabPage page)
    {
        var wv = page.Tag as WebView2;
        _tabs.TabPages.Remove(page);
        try { wv?.Dispose(); } catch { }
        page.Dispose();
        if (_tabs.TabPages.Count == 0) NewTab();
    }

    private void GoHome()
    {
        var core = CurrentCore;
        if (core is null) return;
        core.NavigateToString(StartHtml);
        _address.Text = "";
    }

    /// <summary>应用壳模式：服务与 WebView2 两侧都就绪后导航到应用（幂等，谁后到谁触发）。
    /// 见 _readyPort/_coreReady 字段处关于启动竞态的说明。</summary>
    private void TryNavigateApp()
    {
        if (_appNavigated || _readyPort < 0 || !_coreReady) return;
        var core = CurrentCore;
        if (core is null) return;
        _appNavigated = true;
        core.Navigate("http://127.0.0.1:" + _readyPort + "/");
    }

    private void AddressKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode != Keys.Enter) return;
        e.SuppressKeyPress = true;
        var core = CurrentCore;
        if (core is null) return;
        core.Navigate(NormalizeUrl(_address.Text));
        CurrentWeb?.Focus();
    }

    private void SyncUi()
    {
        var wv = CurrentWeb;
        if (wv is not null) SyncAddress(wv);
        else _address.Text = "";
        SyncNavButtons();
        var t = _tabs.SelectedTab?.Text;
        Text = string.IsNullOrEmpty(t) || t == "新标签页" ? "MiniBrowser" : t + " - MiniBrowser";
    }

    private void SyncAddress(WebView2 wv)
    {
        var src = wv.Source?.ToString();
        _address.Text = src is null || src == "about:blank" ? "" : src;
    }

    private void SyncNavButtons()
    {
        var core = CurrentCore;
        _back.Enabled = core?.CanGoBack ?? false;
        _forward.Enabled = core?.CanGoForward ?? false;
    }

    private void FocusAddress()
    {
        _address.Focus();
        _address.TextBox.SelectAll();
    }

    private void LayoutAddress()
    {
        int others = _toolbar.Padding.Horizontal;
        foreach (ToolStripItem it in _toolbar.Items)
            if (it != _address) others += it.Width + it.Margin.Horizontal;
        _address.Width = Math.Max(200, _toolbar.Width - others - 8);
    }

    private static string Truncate(string s, int n) => s.Length <= n ? s : s.Substring(0, n) + "…";

    private static string NormalizeUrl(string input)
    {
        input = input.Trim();
        if (input.Length == 0) return "https://www.bing.com";
        if (input.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            input.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
            input.StartsWith("about:", StringComparison.OrdinalIgnoreCase) ||
            input.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
            return input;
        // 看起来像域名（无空格且含点）就当作网址，否则交给必应搜索
        if (input.IndexOf(' ') < 0 && input.IndexOf('.') >= 0 && !input.EndsWith(".", StringComparison.Ordinal))
            return "https://" + input;
        return "https://www.bing.com/search?q=" + Uri.EscapeDataString(input);
    }

    #region 应用壳模式的窗口外观

    // 放大窗口时新暴露区域短暂露出壳底色，用接近页面的米色避免黑影观感
    private static readonly Color PageBack = Color.FromArgb(245, 240, 232);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int value, int size);

    /// <summary>把系统标题栏切成深色，和页面配色一致（Win10 1809 用 19，20 起为通用值）。
    /// 失败不影响功能：浅色标题栏只是观感不同。</summary>
    private void ApplyDarkTitleBar()
    {
        try
        {
            var on = 1;
            if (DwmSetWindowAttribute(Handle, 20, ref on, sizeof(int)) != 0)
                DwmSetWindowAttribute(Handle, 19, ref on, sizeof(int));
        }
        catch { }
    }

    #endregion


    /// <summary>WebView2 已知问题：窗口 resize 后 Chromium 渲染视口可能比
    /// 控件小一圈，边缘露出一条背景色带。尺寸稳定后强制重算一次视口
    /// （高度收缩 1px 再恢复，触发两轮布局）。</summary>
    private System.Windows.Forms.Timer _viewportSyncTimer;
    private Size _lastSyncedSize;

    private void StartViewportSync()
    {
        _lastSyncedSize = ClientSize;
        _viewportSyncTimer = new System.Windows.Forms.Timer { Interval = 200 };
        _viewportSyncTimer.Tick += (s, e) =>
        {
            if (IsDisposed || _shellWeb is null) return;
            if (ClientSize == _lastSyncedSize) return;
            _lastSyncedSize = ClientSize;
            _shellWeb.Height -= 1;
            _shellWeb.Height += 1;
        };
        _viewportSyncTimer.Start();
    }

    /// <summary>系统托盘：左键图标显示窗口，右键菜单可退出。</summary>
    private void BuildTray()
    {
        var menu = new ContextMenuStrip();
        var miShow = new ToolStripMenuItem("显示 " + _shell!.AppName);
        var miExit = new ToolStripMenuItem("退出");
        miShow.Click += (s, e) => ShowFromTray();
        miExit.Click += (s, e) => { _reallyExit = true; Close(); };
        menu.Items.Add(miShow);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(miExit);

        _tray = new NotifyIcon
        {
            Icon = Icon is not null ? Icon : SystemIcons.Application,
            Text = _shell.AppName,
            ContextMenuStrip = menu,
            Visible = true,
        };
        _tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowFromTray(); };
    }

    internal void ShowFromTray()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        SetForegroundWindow(Handle);
    }

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);



    protected override void WndProc(ref Message m)
    {
        if (_shell is not null && m.Msg == SingleInstance.ShowMessage)
        {
            // 另一个进程被双击启动：唤出本实例的窗口
            ShowFromTray();
            return;
        }
        base.WndProc(ref m);
    }

    /// <summary>
    /// 应用级快捷键过滤：无论焦点在页面、地址栏还是工具条上，Ctrl+T/W/L 都能生效。
    /// </summary>
    private sealed class HotKeyFilter : IMessageFilter
    {
        private const int WM_KEYDOWN = 0x0100;
        private readonly Form1 _owner;

        public HotKeyFilter(Form1 owner) => _owner = owner;

        public bool PreFilterMessage(ref Message m)
        {
            if (m.Msg != WM_KEYDOWN || (Control.ModifierKeys & Keys.Control) == 0)
                return false;
            switch ((long)m.WParam)
            {
                case 'T': _owner.NewTab(); return true;
                case 'W': _owner.CloseCurrentTab(); return true;
                case 'L': _owner.FocusAddress(); return true;
                default: return false;
            }
        }
    }
}
