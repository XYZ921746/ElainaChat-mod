using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MiniBrowser;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        try
        {
            var shell = ShellHost.Detect();

            // 单实例：同一份安装已有实例在跑时，唤出它的窗口后直接退出
            Mutex? single = null;
            if (shell is not null)
            {
                single = new Mutex(true, shell.SingleInstanceMutex, out var firstInstance);
                if (!firstInstance)
                {
                    SingleInstance.PostMessage(SingleInstance.HwndBroadcast,
                        SingleInstance.ShowMessage, IntPtr.Zero, IntPtr.Zero);
                    return;
                }
            }

#if NETFRAMEWORK
            BootstrapSingleFile();
            if (shell is null) RegisterInWindows();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
#else
            ApplicationConfiguration.Initialize();
#endif
            Application.Run(shell is not null
                ? new Form1(null, shell)
                : new Form1(args.Length > 0 ? args[0] : null));
            GC.KeepAlive(single);
        }
        catch (Exception ex)
        {
            MessageBox.Show("启动失败：\r\n" + ex, "MiniBrowser",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

#if NETFRAMEWORK
    /// <summary>
    /// 把 MiniBrowser 注册为 Windows 认可的浏览器（HKCU，无需管理员权限）：
    /// 出现在“设置-默认应用-Web 浏览器”列表中，可被选为默认浏览器；
    /// 同时注册 App Paths，Win+R 输入 minibrowser 即可启动。
    /// 每次启动都会刷新注册，exe 移动位置后路径自动更新。
    /// </summary>
    private static void RegisterInWindows()
    {
        try
        {
            var exe = Assembly.GetExecutingAssembly().Location;

            using (var root = Registry.CurrentUser.CreateSubKey(@"Software\Clients\StartMenuInternet\MiniBrowser"))
            {
                root.SetValue(null, "MiniBrowser");
                root.SetValue("DefaultIcon", "\"" + exe + "\",0");
                using (var cmd = root.CreateSubKey(@"shell\open\command"))
                    cmd.SetValue(null, "\"" + exe + "\" \"%1\"");
                using (var cap = root.CreateSubKey("Capabilities"))
                {
                    cap.SetValue("ApplicationName", "MiniBrowser");
                    cap.SetValue("ApplicationIcon", "\"" + exe + "\",0");
                    using (var sm = cap.CreateSubKey("StartMenu"))
                        sm.SetValue("StartMenuInternet", "MiniBrowser");
                    using (var ua = cap.CreateSubKey("URLAssociations"))
                    {
                        ua.SetValue("http", "MiniBrowserHTML");
                        ua.SetValue("https", "MiniBrowserHTML");
                    }
                }
            }

            using (var ra = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications"))
                ra.SetValue("MiniBrowser", @"Software\Clients\StartMenuInternet\MiniBrowser\Capabilities");

            using (var prog = Registry.CurrentUser.CreateSubKey(@"Software\Classes\MiniBrowserHTML"))
            {
                prog.SetValue(null, "MiniBrowser HTML 文档");
                using (var icon = prog.CreateSubKey("DefaultIcon"))
                    icon.SetValue(null, "\"" + exe + "\",0");
                using (var cmd = prog.CreateSubKey(@"shell\open\command"))
                    cmd.SetValue(null, "\"" + exe + "\" \"%1\"");
            }

            using (var ap = Registry.CurrentUser.CreateSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\App Paths\MiniBrowser.exe"))
            {
                ap.SetValue(null, exe);
            }
        }
        catch
        {
            // 注册失败不影响浏览器本身的使用
        }
    }

    /// <summary>
    /// 单文件模式：从内嵌资源中加载 WebView2 托管程序集，
    /// 并把原生 WebView2Loader.dll 解压到临时目录预加载，
    /// 因此整个程序只需要这一个 exe，无需任何附带文件。
    /// </summary>
    private static void BootstrapSingleFile()
    {
        var asm = Assembly.GetExecutingAssembly();

        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            var name = new AssemblyName(e.Name).Name;
            using var st = asm.GetManifestResourceStream("MiniBrowser.Lib." + name + ".dll");
            if (st is null) return null;
            using var ms = new MemoryStream();
            st.CopyTo(ms);
            return Assembly.Load(ms.ToArray());
        };

        var dir = Path.Combine(Path.GetTempPath(), "MiniBrowser");
        Directory.CreateDirectory(dir);
        var loaderPath = Path.Combine(dir, "WebView2Loader.dll");

        using (var st = asm.GetManifestResourceStream("MiniBrowser.Lib.WebView2Loader.dll"))
        using (var ms = new MemoryStream())
        {
            st!.CopyTo(ms);
            // 先写临时文件再替换：若目标文件正被另一个运行中的实例加载锁定，
            // 就保留现有文件直接用（内容一致），避免 IOException 把启动打崩
            var tmp = loaderPath + ".tmp";
            File.WriteAllBytes(tmp, ms.ToArray());
            try { File.Copy(tmp, loaderPath, true); } catch (IOException) { }
            try { File.Delete(tmp); } catch (IOException) { }
        }
        LoadLibrary(loaderPath);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LoadLibrary(string fileName);
#endif
}

