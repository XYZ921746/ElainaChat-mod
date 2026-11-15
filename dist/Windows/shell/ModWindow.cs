using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using WinForms = System.Windows.Forms;
using WpfPoint = System.Windows.Point;
using DrawingColor = System.Drawing.Color;

namespace MiniBrowser;

/// <summary>
/// 主窗口页面与壳之间的扁平 JSON 消息解析：消息只有 id/url/width/height 这类无嵌套字段，
/// 与 ShellHost.ParseConfig 同一思路用正则取值，不为此引入 JSON 库。
/// </summary>
internal static class ShellMsg
{
    public static string? Str(string json, string key)
    {
        if (string.IsNullOrEmpty(json)) return null;
        var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        if (!m.Success) return null;
        // 页面发来的 url/id 不含需要转义的字符，只展开最常见的 \" 与 \\ 两种，够用且不引 JSON 库
        return m.Groups[1].Value.Replace("\\\"", "\"").Replace("\\\\", "\\");
    }

    public static int Int(string json, string key, int fallback)
    {
        if (string.IsNullOrEmpty(json)) return fallback;
        var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?\\d+)");
        return m.Success && int.TryParse(m.Groups[1].Value, System.Globalization.NumberStyles.Integer,
            System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : fallback;
    }
}

/// <summary>
/// mod 透明置顶窗（WPF）。为什么不用 WinForms：窗体的 TransparencyKey 走「色键」合成，
/// 而 WebView2 的 DirectComposition 子表面在色键**之后**才合成到屏幕，键色像素拦不住它 ——
/// 实测整窗一块纯色盖在桌面上。WPF 的 AllowsTransparency 是逐像素 alpha 路径，
/// WebView2 的 DefaultBackgroundColor = Transparent 直接融入 WPF 合成树（官方支持的透明宿主形态），
/// 透明像素天然不参与命中测试：人物周围点击直接穿透到桌面，人物本体仍可交互。
/// WPF 窗必须活在自己的 STA 消息循环里，与主窗（WinForms Application.Run）互不抢线程；
/// 所有窗口共享同一条 WPF 线程，退出时随壳一起结束（IsBackground）。
/// 窗口本身不认识任何插件：id、url、尺寸全部由主窗口页面经 mod-window-open 消息发来；
/// 页面之间的数据同步走 BroadcastChannel（与主窗口共用同一 WebView2 用户目录，天然同源互通）。
/// </summary>
public static class ModWindows
{
    private static Thread? _thread;
    private static Dispatcher? _dispatcher;
    private static readonly Dictionary<string, ModWindow> Open = new();
    private static readonly object Gate = new();
    private static string? _diagFile;

    internal static void LogDiag(string what)
    {
        try
        {
            if (_diagFile == null) return;
            Directory.CreateDirectory(Path.GetDirectoryName(_diagFile)!);
            File.AppendAllText(_diagFile, DateTime.Now + " " + what + Environment.NewLine);
        }
        catch { }
    }

    private static void EnsureThread()
    {
        lock (Gate)
        {
            if (_thread != null) return;
            var ready = new ManualResetEventSlim(false);
            _thread = new Thread(() =>
            {
                _dispatcher = Dispatcher.CurrentDispatcher;
                // WPF 线程上的未处理异常会带崩整个进程（主窗跟着陪葬）：一律记日志并吞掉。
                // 单个窗口坏了由下一次 open 重置状态，不能拖死壳。
                _dispatcher.UnhandledException += (s, e) =>
                {
                    LogDiag("dispatcher exception: " + e.Exception);
                    e.Handled = true;
                };
                ready.Set();
                Dispatcher.Run();
            });
            _thread.SetApartmentState(ApartmentState.STA);
            _thread.IsBackground = true;
            _thread.Start();
            ready.Wait();
        }
    }

    /// <summary>开（或替换）一个透明置顶窗。onClosed/focusMain 在 WPF 线程回调，
    /// 调用方（Form1）负责自行 marshal 回主线程。udf/args 用于在 WPF 线程上自建 WebView2 环境
    /// （主窗环境绑在主线程 COM 单元上，跨线程复用会 RPC_E_WRONG_THREAD）；
    /// 同一 udf 仍会汇入同一浏览器进程，BroadcastChannel 照常互通。</summary>
    public static void OpenOrReplace(string udf, string additionalArgs, Action<string> onClosed, Action focusMain,
        string appName, string id, string url, int w, int h)
    {
        if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(url)) return;
        _diagFile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            appName, "mod-window-debug.log");
        EnsureThread();
        _dispatcher!.Invoke(() =>
        {
            if (Open.TryGetValue(id, out var old))
            {
                Open.Remove(id);
                old.ClosedByPage = true;   // 替换式重开：页面自己发的，不再回发 closed
                old.Close();
            }
            var win = new ModWindow(id, url, w, h, appName, udf, additionalArgs, onClosed, focusMain);
            Open[id] = win;
            win.Show();
        });
    }

    public static void CloseById(string id)
    {
        if (_dispatcher == null) return;
        _dispatcher.Invoke(() =>
        {
            if (!Open.TryGetValue(id, out var win)) return;
            Open.Remove(id);
            // 这里不静默：close 请求多半来自「透明窗里的 ✕」（经主页转发），真正需要复位状态的是主页面。
            // 主页面自己收起时已先退订 closed，随后的通知无人接收，不会成环。
            win.Close();
        });
    }

    /// <summary>主窗口真正退出时收掉全部窗并结束 WPF 线程。</summary>
    public static void CloseAll()
    {
        lock (Gate)
        {
            if (_dispatcher == null) return;
            var d = _dispatcher;
            _thread = null;
            _dispatcher = null;
            d.Invoke(() =>
            {
                foreach (var win in Open.Values.ToList()) win.Close();
                Open.Clear();
                d.BeginInvokeShutdown(DispatcherPriority.Background);
            });
        }
    }
}

public sealed class ModWindow : Window
{
    private WebView2 _web;   // 控制器创建失败时要整只换新（旧实例会带着失效句柄），所以不能 readonly
    private readonly string _id;
    private readonly string _persistFile;
    private readonly Action<string> _onClosed;
    private readonly Action _focusMain;
    private readonly DispatcherTimer _saveDefer;
    private readonly string _udf;
    private readonly string _additionalArgs;
    private bool _jsDragging;
    private WpfPoint _jsDragStart;

    /// <summary>页面主动关闭（close 请求 / 替换式重开）时不再回发 closed —— 页面自己知道结果；
    /// 只有用户/系统直接关窗（或 WebView2 初始化失败）才通知主页面复位状态。</summary>
    public bool ClosedByPage { get; set; }

    public ModWindow(string id, string url, int w, int h, string appName,
        string udf, string additionalArgs, Action<string> onClosed, Action focusMain)
    {
        _udf = udf;
        _additionalArgs = additionalArgs;
        _id = id;
        _onClosed = onClosed;
        _focusMain = focusMain;
        Title = appName + " · " + id;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        // 关键：底色用 alpha=1 的近透明黑，而不是纯 Transparent。分层窗的真实鼠标命中测试看的是
        // WPF 渲染面的 alpha——人物像素在 WebView2 自己的合成面上、不进这张位图，全 Transparent 时
        // 位图 alpha 处处为 0，整窗对真实鼠标完全穿透（点不出也拖不动）。alpha=1 视觉不可见（1/255），
        // 命中测试却能通过；「人物+菜单可点、其余穿透」的分区由 WM_NCHITTEST 钩子精确控制。
        Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromArgb(1, 0, 0, 0));
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;              // 浮出不抢焦点
        WindowStartupLocation = WindowStartupLocation.Manual;
        Width = Math.Max(80, w);
        Height = Math.Max(80, h);

        _persistFile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            appName, "mod-window-" + id + ".json");
        var p = RestoreOrDefaultLocation();
        Left = p.X;
        Top = p.Y;

        // 拖动优先由页面用 app-region: drag 声明（WebView2 自己挪窗）；这里只负责记住落点。
        // LocationChanged 拖动全程连发，直接写盘每步一次 IO，防抖 600ms 合并成一次。
        _saveDefer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(600) };
        _saveDefer.Tick += (s, e) =>
        {
            _saveDefer.Stop();
            SaveLocation();
        };
        LocationChanged += (s, e) => _saveDefer.Start();

        _web = new WebView2
        {
            DefaultBackgroundColor = DrawingColor.Transparent,   // 页面透明像素直接透出桌面
        };
        Content = _web;
        Loaded += async (s, e) =>
        {
            try
            {
                // 命中测试钩子：按页面报上来的「人物+菜单」矩形放行/穿透（见 WndProc）
                var src = (System.Windows.Interop.HwndSource)System.Windows.Interop.HwndSource.FromVisual(this);
                src?.AddHook(WndProc);
                // 环境必须在本线程现建（主窗的 env 绑主线程 COM 单元）；同一 udf → 同一浏览器进程。
                // 旧实例的浏览器进程关闭中时，建环境（E_ABORT）或建控制器（无效句柄）都会失败；
                // 控制器一旦失败，同一控件实例上的重试只会继续拿到失效句柄 —— 每次重试换全新控件。
                CoreWebView2Environment? env = null;
                for (int attempt = 0; attempt < 5 && env == null; attempt++)
                {
                    try
                    {
                        var opts = new CoreWebView2EnvironmentOptions();
                        if (!string.IsNullOrWhiteSpace(_additionalArgs))
                            opts.AdditionalBrowserArguments = _additionalArgs;
                        env = await CoreWebView2Environment.CreateAsync(null, _udf, opts);
                    }
                    catch (Exception ex) when (attempt < 4)
                    {
                        ModWindows.LogDiag("env create retry " + attempt + ": " + ex.Message);
                        await System.Threading.Tasks.Task.Delay(1200);
                    }
                }
                if (env == null) throw new InvalidOperationException("environment create failed after retries");
                for (int attempt = 0; ; attempt++)
                {
                    try
                    {
                        await _web.EnsureCoreWebView2Async(env);
                        break;
                    }
                    catch (Exception ex) when (attempt < 5)
                    {
                        ModWindows.LogDiag("controller create retry " + attempt + ": " + ex.Message);
                        await System.Threading.Tasks.Task.Delay(1200);
                        var fresh = new WebView2 { DefaultBackgroundColor = DrawingColor.Transparent };
                        Content = fresh;
                        _web = fresh;
                    }
                }
                var core = _web.CoreWebView2!;
                core.WebMessageReceived += OnMessage;
                core.Navigate(url);
            }
            catch (Exception ex)
            {
                // 初始化失败的窗会变成「全透明且点击穿透」的幽灵：看不见也关不掉，必须收掉。
                // 不标记 ClosedByPage —— 主页面并不知道开窗失败，需要 closed 通知来复位。
                ModWindows.LogDiag("window '" + _id + "' init failed: " + ex);
                Close();
            }
        };
    }

    /// <summary>页面报上来的可交互矩形（人物/菜单），页面 CSS 坐标 = DIP，摊平成 [x,y,w,h,…]。</summary>
    private double[] _hitRects = Array.Empty<double>();


    private void SetHitRects(string rectsJson)
    {
        try
        {
            var nums = new List<double>();
            foreach (Match m in Regex.Matches(rectsJson ?? "", "-?\\d+(?:\\.\\d+)?"))
                nums.Add(double.Parse(m.Value, System.Globalization.CultureInfo.InvariantCulture));
            _hitRects = (nums.Count / 4) * 4 == nums.Count ? nums.ToArray() : Array.Empty<double>();
        }
        catch { _hitRects = Array.Empty<double>(); }
    }

    /// <summary>WM_NCHITTEST：命中矩形内交给 WebView2（HTCLIENT），矩形外返回 HTTRANSPARENT
    /// 让点击穿透到桌面下层应用。没有矩形数据时不干预（整窗可点，安全默认）。</summary>
    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        const int WM_NCHITTEST = 0x0084;
        const int HTTRANSPARENT = -1;
        if (msg != WM_NCHITTEST || _hitRects.Length < 4) return IntPtr.Zero;
        try
        {
            int px = (short)(unchecked((int)lParam) & 0xFFFF);
            int py = (short)(((int)lParam >> 16) & 0xFFFF);
            var src = (System.Windows.Interop.HwndSource)System.Windows.Interop.HwndSource.FromVisual(this);
            var m = src?.CompositionTarget?.TransformToDevice;
            double scale = m.HasValue && m.Value.M11 > 0 ? m.Value.M11 : 1.0;
            double lx = px / scale - Left;
            double ly = py / scale - Top;
            for (int i = 0; i + 3 < _hitRects.Length; i += 4)
            {
                if (lx >= _hitRects[i] && ly >= _hitRects[i + 1]
                    && lx < _hitRects[i] + _hitRects[i + 2] && ly < _hitRects[i + 1] + _hitRects[i + 3])
                {
                    // 必须显式 handled=true + HTCLIENT：WPF 对透明像素自己的 NCHITTEST 判定是穿透，
                    // 返回 Zero 等于把决定权交回给它，真实鼠标永远进不来（实测就是这个坑）。
                    handled = true;
                    return new IntPtr(1);   // HTCLIENT
                }
            }
            handled = true;
            return new IntPtr(HTTRANSPARENT);
        }
        catch { return IntPtr.Zero; }
    }

    private void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var json = e.WebMessageAsJson ?? "";
        var type = ShellMsg.Str(json, "type");
        if (type == "mod-window-close") Close();
        else if (type == "mod-window-focus-main") _focusMain();
        else if (type == "mod-window-move-start")
        {
            _jsDragging = true;
            _jsDragStart = new WpfPoint(Left, Top);
        }
        else if (type == "mod-window-move" && _jsDragging)
        {
            // 页面 JS 拖动（app-region: drag 不可用的旧内核兜底）：消息带相对位移，窗口跟移
            Left = _jsDragStart.X + ShellMsg.Int(json, "x", 0);
            Top = _jsDragStart.Y + ShellMsg.Int(json, "y", 0);
        }
        else if (type == "mod-window-move-end") _jsDragging = false;
        else if (type == "mod-window-hit") SetHitRects(ShellMsg.Str(json, "rects"));
    }

    protected override void OnClosed(EventArgs e)
    {
        _saveDefer.Stop();
        if (!ClosedByPage) _onClosed(_id);
        base.OnClosed(e);
    }

    /// <summary>恢复上次拖动到的位置；文件缺失或落点不在任何屏幕上（拔了显示器）时回落到主屏右下角。
    /// 坐标用 WPF 的 DIP 记（与 Left/Top 同单位），存取自洽。</summary>
    private WpfPoint RestoreOrDefaultLocation()
    {
        try
        {
            if (File.Exists(_persistFile))
            {
                var json = File.ReadAllText(_persistFile);
                var x = ShellMsg.Int(json, "x", int.MinValue);
                var y = ShellMsg.Int(json, "y", int.MinValue);
                var vs = WinForms.SystemInformation.VirtualScreen;
                if (x > vs.Left - Width && y > vs.Top - Height && x < vs.Right && y < vs.Bottom)
                    return new WpfPoint(x, y);
            }
        }
        catch { }
        var wa = WinForms.Screen.PrimaryScreen!.WorkingArea;
        return new WpfPoint(wa.Right - (int)Width - 24, wa.Bottom - (int)Height - 24);
    }

    private void SaveLocation()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_persistFile)!);
            File.WriteAllText(_persistFile, "{\"x\":" + (int)Left + ",\"y\":" + (int)Top + "}");
        }
        catch { }
    }
}
