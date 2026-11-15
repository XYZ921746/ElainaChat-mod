using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace MiniBrowser;

/// <summary>
/// 单实例机制：第二个进程通过全局唯一的窗口消息通知第一个实例显示窗口，
/// 然后自己退出（广播消息只有注册过该消息的壳窗口会响应）。
/// </summary>
internal static class SingleInstance
{
    public const string ShowMessageName = "MiniBrowserShell_ShowWindow";
    public static readonly int ShowMessage = RegisterWindowMessage(ShowMessageName);

    public static readonly IntPtr HwndBroadcast = new(0xffff);

    [DllImport("user32.dll")]
    private static extern int RegisterWindowMessage(string name);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}

/// <summary>
/// Electron 风格的“应用壳”宿主：
/// 1. 读取 exe 旁的 shell.json 配置；
/// 2. 启动随包携带的 Go 服务端二进制（stdout/stderr 记入 logs\server.log）；
/// 3. 把服务进程挂进 kill-on-close 作业对象 —— 壳进程无论正常关闭、
///    被任务管理器结束还是崩溃，Windows 内核都会连带终止服务；
/// 4. 轮询探测服务端口（应用会自动往后找空闲端口），就绪后窗口导航过去。
/// </summary>
public sealed class ShellHost
{
    internal sealed class Config
    {
        public string AppName = "App";
        public string Entry = "server\\elaina-server.exe";
        public int Port = 3999;
        public int PortSpan = 100;
        public string ProbePath = "/api/server-info";
        public string Icon = "app.ico";
    }

    public string AppName => _cfg.AppName;
    public string AppDir { get; }
    public string IconPath { get; }
    /// <summary>按安装位置区分的单实例互斥体名：同一份安装只允许一个实例，
    /// 不同位置（如便携版与安装版）互不影响。</summary>
    public string SingleInstanceMutex { get; }
    public bool ServerExited => _server is null || _server.HasExited;
    public int ServerExitCode => _server is null ? -1 : _server.ExitCode;

    private readonly Config _cfg;
    private readonly string _serverExe;
    private readonly string _logFile;
    private readonly StringBuilder _logTail = new();
    private Process? _server;
    private IntPtr _job = IntPtr.Zero;

    private ShellHost(Config cfg, string baseDir)
    {
        _cfg = cfg;
        AppDir = Path.Combine(baseDir, "app");
        IconPath = Path.Combine(baseDir, cfg.Icon);
        // Entry 是相对“壳 exe 所在目录”的路径：server\elaina-server.exe
        _serverExe = Path.Combine(baseDir, cfg.Entry);
        _logFile = Path.Combine(AppDir, "logs", "server.log");
        SingleInstanceMutex = "Local\\MiniBrowserShell_" + Fnv1a(baseDir);
    }

    private static string Fnv1a(string s)
    {
        unchecked
        {
            uint h = 2166136261;
            foreach (var c in s) { h ^= c; h *= 16777619; }
            return h.ToString("X8");
        }
    }

    /// <summary>exe 同目录存在 shell.json 则进入应用壳模式，返回宿主；否则返回 null（普通浏览器模式）。</summary>
    public static ShellHost? Detect()
    {
        try
        {
            var dir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            if (string.IsNullOrEmpty(dir)) return null;
            var cfgFile = Path.Combine(dir, "shell.json");
            if (!File.Exists(cfgFile)) return null;
            var cfg = ParseConfig(File.ReadAllText(cfgFile));
            return new ShellHost(cfg, dir);
        }
        catch
        {
            return null;
        }
    }

    private static Config ParseConfig(string json)
    {
        var cfg = new Config();
        var strRE = new Regex("\"(\\w+)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        foreach (Match m in strRE.Matches(json))
        {
            switch (m.Groups[1].Value)
            {
                case "appName": cfg.AppName = m.Groups[2].Value; break;
                case "entry": cfg.Entry = m.Groups[2].Value; break;
                case "probePath": cfg.ProbePath = m.Groups[2].Value; break;
                case "icon": cfg.Icon = m.Groups[2].Value; break;
            }
        }
        var numRE = new Regex("\"(\\w+)\"\\s*:\\s*(\\d+)");
        foreach (Match m in numRE.Matches(json))
        {
            switch (m.Groups[1].Value)
            {
                case "port": cfg.Port = int.Parse(m.Groups[2].Value); break;
                case "portSpan": cfg.PortSpan = int.Parse(m.Groups[2].Value); break;
            }
        }
        return cfg;
    }

    public void Start()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_logFile)!);
        File.AppendAllText(_logFile,
            "\r\n===== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " 启动 =====\r\n");

        _job = CreateJobObject(IntPtr.Zero, null);
        var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(_job, 9, ref ext, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));

        var psi = new ProcessStartInfo
        {
            FileName = _serverExe,
            WorkingDirectory = AppDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.EnvironmentVariables["OPEN_BROWSER"] = "0";
        // 端口固定成壳自己管的这一个：服务端只绑配置端口，绑不上会报错退出，
        // 壳的探测因此只看这一个端口
        psi.EnvironmentVariables["PORT"] = _cfg.Port.ToString();
        // 运行形态：服务端经 /api/server-info 转给前端，版本检测据此给出电脑版安装包
        psi.EnvironmentVariables["ELAINA_EDITION"] = "windows";

        _server = Process.Start(psi) ?? throw new InvalidOperationException("无法启动服务端二进制：" + _serverExe);
        AssignProcessToJobObject(_job, _server.Handle);

        // 服务端输出异步写日志，同时在内存里留一份尾部用于出错时展示
        Pump(_server.StandardOutput);
        Pump(_server.StandardError);
    }

    private void Pump(StreamReader reader)
    {
        Task.Run(() =>
        {
            string? line;
            while ((line = reader.ReadLine()) is not null)
            {
                lock (_logTail)
                {
                    _logTail.AppendLine(line);
                    if (_logTail.Length > 8000) _logTail.Remove(0, _logTail.Length - 8000);
                }
                try { File.AppendAllText(_logFile, line + Environment.NewLine); } catch { }
            }
        });
    }

    /// <summary>轮询探测固定端口直到服务就绪。返回端口；超时/进程退出返回 -1。</summary>
    public async Task<int> WaitForServerAsync(int timeoutMs)
    {
        var deadline = Environment.TickCount + timeoutMs;
        while (Environment.TickCount < deadline)
        {
            if (Probe(_cfg.Port)) return _cfg.Port;
            if (ServerExited && !Probe(_cfg.Port)) return -1;
            await Task.Delay(300);
        }
        return -1;
    }

    /// <summary>TCP 连上后发一个 HTTP/1.0 GET，返回是否收到 200。</summary>
    private bool Probe(int port)
    {
        try
        {
            using var tcp = new TcpClient();
            var iar = tcp.BeginConnect("127.0.0.1", port, null, null);
            if (!iar.AsyncWaitHandle.WaitOne(200)) return false;
            tcp.EndConnect(iar);
            tcp.ReceiveTimeout = 800;
            tcp.SendTimeout = 800;
            var req = "GET " + _cfg.ProbePath + " HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
            var bytes = Encoding.ASCII.GetBytes(req);
            tcp.GetStream().Write(bytes, 0, bytes.Length);
            var buf = new byte[256];
            int n = tcp.GetStream().Read(buf, 0, buf.Length);
            if (n <= 0) return false;
            var head = Encoding.ASCII.GetString(buf, 0, Math.Min(n, 12));
            if (!head.StartsWith("HTTP/1.")) return false;
            // 200-399 都算服务在线（302 重定向也是正常响应）
            var sp = head.IndexOf(' ');
            if (sp < 0 || sp + 3 > head.Length) return false;
            var code = head.Substring(sp + 1, 3);
            return code[0] == '2' || code[0] == '3';
        }
        catch
        {
            return false;
        }
    }

    public string LogTail()
    {
        lock (_logTail) return _logTail.ToString();
    }

    public void Shutdown()
    {
        try { if (_server is not null && !_server.HasExited) _server.Kill(); } catch { }
        // 不关闭 job 句柄：进程退出时句柄自动关闭，服务进程由内核保证陪葬
    }

    #region Win32 作业对象
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount,
            ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpJobName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, int cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    #endregion
}
