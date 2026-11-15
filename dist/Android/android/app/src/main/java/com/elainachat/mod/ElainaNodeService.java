package com.elainachat.mod;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * 本地服务宿主 —— 跑在 {@code :node} 独立进程里（进程名沿用历史名字，实际运行的是 Go 服务端）。
 *
 * <p>服务端是静态编译的 Go 单文件（{@code jniLibs/<abi>/libelaina_server.so}）。
 * 之所以仍放在独立进程：它要长期跑、要能被 START_STICKY 重建；与 WebView 分进程后，
 * 服务重启不会把整个界面带走，崩溃也只影响这一半能力（页面会自动回落原生实现）。
 *
 * <p>★ 与主进程的边界：
 * <ul>
 *   <li>**控制面** = {@link Messenger}（本类 {@link #incoming}）：开始 / 停止 / 查状态。</li>
 *   <li>**数据面** = Go 服务自己监听的 {@code 127.0.0.1:<port>}，WebView 直接 fetch。
 *       本类**不转发**业务流量。</li>
 * </ul>
 *
 * <p>★ 端口：Go 侧以 0 号端口监听（内核分配），把真实端口写进
 * {@code cacheDir/elaina-server.port}；本类轮询这个文件后通过 Messenger 推给主进程。
 * 不用 SharedPreferences 传端口：MODE_MULTI_PROCESS 在 API 23+ 已废弃、各进程有独立缓存。
 */
public class ElainaNodeService extends Service {

    private static final String TAG = "ElainaNode";

    /** 随 APK 打包的 Go 服务端。名字必须是 lib*.so 才不会被 AGP 当成普通文件过滤掉。 */
    private static final String SERVER_LIB = "libelaina_server.so";
    /** 端口文件放在 cacheDir：同一个 :node 进程可读写，且不占用户数据目录。 */
    private static final String PORT_FILE_SUFFIX = ".port";
    private static final String DATA_DIR = "elaina-data";
    /** 启动等端口文件的上限。Go 是本地进程，正常几百毫秒内就能写完。 */
    private static final long READY_TIMEOUT_MS = 20000L;

    // ==================== 前台服务 ====================

    /**
     * 渠道 id。**一旦发布就不要改** —— 改了会多出一个新渠道，
     * 用户在系统设置里关过的旧渠道记录会失效。
     */
    private static final String CHANNEL_ID = "elaina_node_runtime";
    private static final int NOTIFICATION_ID = 0x4E4F4445;   // "NODE"

    /**
     * 通知文案。前台服务必须 startForeground（否则 5 秒内 ANR 崩溃），
     * 所以通知本身无法省略；本应用不声明 POST_NOTIFICATIONS，Android 13+ 默认不显示，
     * 8~12 上按 IMPORTANCE_MIN 折叠到抽屉最底部。
     */
    private static final String NOTIFICATION_TEXT = "ElainaChat 正在运行中，请勿关闭";

    // ==================== Messenger 协议 ====================

    /** client → service：启动本地服务（幂等）。 */
    public static final int MSG_START = 1;
    /** client → service：停止本地服务（请求 /api/shutdown，等进程自然退出）。 */
    public static final int MSG_STOP = 2;
    /** client → service：查询状态。回包形状与 {@link #MSG_STATE} 相同。 */
    public static final int MSG_STATUS = 3;

    /** service → client：状态快照。字段见 {@link #stateBundle()}。 */
    public static final int MSG_STATE = 10;
    /** service → client：服务已就绪，带端口。 */
    public static final int MSG_READY = 11;
    /** service → client：服务已退出。 */
    public static final int MSG_EXIT = 12;

    /** 当前客户端。单客户端模型：每次收到客户端消息就用它的 replyTo 刷新。 */
    private static volatile Messenger sClient = null;

    // ==================== 运行状态（仅本进程可见） ====================

    private static volatile int readyPort = -1;
    private static volatile long readyAt = 0L;
    private static volatile int exitCode = Integer.MIN_VALUE;
    private static volatile boolean started = false;
    private static volatile String lastError = "";

    /** Go 子进程。只有本进程（:node）持有它。 */
    private static volatile Process sProcess = null;

    /** 只有 static 回调需要 Context；这里保留 Application context（生命周期即进程）。 */
    private static volatile Context sAppContext = null;

    @Override
    public void onCreate() {
        super.onCreate();
        sAppContext = getApplicationContext();
        createChannel();
        // 必须先 startForeground 再干重活：Android 给 startForegroundService()
        // 之后的窗口只有几秒，超时会 ANR/崩。
        startForeground(NOTIFICATION_ID, buildNotification());
        Log.i(TAG, "[:node] 服务已创建，前台通知已挂");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 进程被系统回收后重建服务：新进程里 sProcess=null，可以安全重起。
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return incoming.getBinder();
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "[:node] 服务销毁");
        sClient = null;
        Process process = sProcess;
        sProcess = null;
        if (process != null && process.isAlive()) {
            process.destroy();
        }
        super.onDestroy();
    }

    // ==================== Messenger ====================

    private final Messenger incoming = new Messenger(new Handler(Looper.getMainLooper()) {
        @Override
        public void handleMessage(Message msg) {
            if (msg.replyTo != null) sClient = msg.replyTo;
            switch (msg.what) {
                case MSG_START:
                    handleStart();
                    break;
                case MSG_STOP:
                    handleStop();
                    break;
                case MSG_STATUS:
                    pushToClient(msg.replyTo, MSG_STATE, stateBundle());
                    break;
                default:
                    super.handleMessage(msg);
            }
        }
    });

    private void handleStart() {
        synchronized (ElainaNodeService.class) {
            if (started) {
                pushToClient(sClient, MSG_STATE, stateBundle());
                return;
            }
            started = true;
            lastError = "";
            readyPort = -1;
            exitCode = Integer.MIN_VALUE;
        }
        updateNotification("正在启动…");
        new Thread(this::runServer, "elaina-server").start();
        pushToClient(sClient, MSG_STATE, stateBundle());
    }

    private void handleStop() {
        final int port = readyPort;
        final Process process = sProcess;
        if (port <= 0) {
            // 还没报出端口：没法走 HTTP，只能结束子进程。
            if (process != null && process.isAlive()) process.destroy();
            pushToClient(sClient, MSG_STATE, stateBundle());
            return;
        }
        new Thread(() -> {
            try {
                HttpURLConnection connection = (HttpURLConnection) URI
                    .create("http://127.0.0.1:" + port + "/api/shutdown")
                    .toURL()
                    .openConnection();
                connection.setRequestMethod("POST");
                // 服务模式的 Origin 白名单只认这个源；原生侧不是浏览器，不会自动带上。
                connection.setRequestProperty("Origin", "https://localhost");
                connection.setConnectTimeout(1500);
                connection.setReadTimeout(1500);
                connection.getResponseCode();
                connection.disconnect();
            } catch (Exception error) {
                Log.w(TAG, "关闭请求失败：" + error.getMessage());
            }
            // 兜底：请求失败或进程没退，3 秒后强杀。
            try {
                if (process != null && process.isAlive()
                    && !process.waitFor(3, TimeUnit.SECONDS)) {
                    process.destroy();
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            pushToClient(sClient, MSG_STATE, stateBundle());
        }, "elaina-server-stop").start();
    }

    private static Bundle stateBundle() {
        Bundle b = new Bundle();
        b.putBoolean("started", started);
        b.putBoolean("ready", readyPort > 0);
        b.putInt("port", readyPort > 0 ? readyPort : 0);
        b.putLong("readyAt", readyAt);
        b.putInt("exitCode", exitCode);
        b.putString("lastError", lastError == null ? "" : lastError);
        Context ctx = sAppContext;
        if (ctx != null) {
            ApplicationInfo info = ctx.getApplicationInfo();
            b.putString("projectDir", info.nativeLibraryDir);
            b.putString("dataDir", dataDirOf(ctx).getAbsolutePath());
        } else {
            b.putString("projectDir", "");
            b.putString("dataDir", "");
        }
        return b;
    }

    /** 推一条消息给客户端。客户端已死时清掉引用，等下一次 bind 接管。 */
    private static void pushToClient(Messenger client, int what, Bundle data) {
        Messenger target = client != null ? client : sClient;
        if (target == null) {
            Log.w(TAG, "还没有客户端，消息 " + what + " 暂不推送");
            return;
        }
        Message m = Message.obtain(null, what);
        if (data != null) m.setData(data);
        try {
            target.send(m);
        } catch (RemoteException error) {
            Log.w(TAG, "推送失败（客户端进程已死），清掉引用：" + error.getMessage());
            if (sClient == target) sClient = null;
        }
    }

    // ==================== 前台通知 ====================

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "本地服务", NotificationManager.IMPORTANCE_MIN);
        channel.setDescription("本地 Go 服务（日志与插件接口）");
        channel.setShowBadge(false);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        return buildNotification(null);
    }

    private Notification buildNotification(String detail) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID);
        builder.setContentTitle(NOTIFICATION_TEXT)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, flags));
        if (detail != null) builder.setContentText(detail);
        return builder.build();
    }

    private void updateNotification(String detail) {
        try {
            NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            manager.notify(NOTIFICATION_ID, buildNotification(detail));
        } catch (Exception error) {
            Log.w(TAG, "更新通知失败：" + error.getMessage());
        }
    }

    // ==================== Go 服务启动 ====================

    private void runServer() {
        try {
            ApplicationInfo info = getApplicationInfo();
            File server = new File(info.nativeLibraryDir, SERVER_LIB);
            if (!server.isFile()) {
                throw new IOException("找不到服务端二进制：" + server
                    + "（构建时是否设置了 ELAINA_LOCAL_SERVER=true？）");
            }
            File data = dataDir();
            if (!data.exists() && !data.mkdirs()) {
                throw new IOException("数据目录创建失败：" + data);
            }
            File filesRoot = getFilesDir();
            File mods = new File(filesRoot, "mods");
            File skills = new File(filesRoot, "skills");
            // 每次启动用新文件名：上一次崩溃或强杀留下的端口文件不会被误读成
            // 本次端口（删旧文件也可能因占用失败，这个做法不依赖删除成功）。
            File portFile = new File(getCacheDir(),
                "elaina-server-" + System.currentTimeMillis() + PORT_FILE_SUFFIX);
            cleanOldPortFiles();

            ProcessBuilder builder = new ProcessBuilder(server.getAbsolutePath());
            builder.directory(filesRoot);
            builder.redirectErrorStream(true);
            Map<String, String> env = builder.environment();
            env.put("ELAINA_SERVICE_MODE", "1");
            env.put("ELAINA_APP_ROOT", filesRoot.getAbsolutePath());
            env.put("DATA_DIR", data.getAbsolutePath());
            env.put("LOG_DIR", new File(data, "logs").getAbsolutePath());
            env.put("MODS_DIR", mods.getAbsolutePath());
            env.put("SKILLS_DIR", skills.getAbsolutePath());
            // 手机端的插件启用状态由 Capacitor 写在 filesDir/store.json（不是 data/main/store.json）。
            env.put("ELAINA_PLUGIN_STATE_FILE", new File(filesRoot, "store.json").getAbsolutePath());
            env.put("ELAINA_PORT_FILE", portFile.getAbsolutePath());
            env.put("ELAINA_EDITION", "android");
            env.put("APP_VERSION", BuildConfig.VERSION_NAME);
            env.put("HOST", "127.0.0.1");
            env.put("OPEN_BROWSER", "0");
            env.put("LOG_TO_FILE", "1");
            // Go 的 os.TempDir 读 TMPDIR；安卓上没有可写的 /tmp。
            env.put("TMPDIR", getCacheDir().getAbsolutePath());

            updateNotification("正在启动…");
            Log.i(TAG, "[:node] 启动本地服务：" + server);
            Process process = builder.start();
            sProcess = process;
            pumpOutput(process);

            int port = waitForPort(portFile, process);
            if (port <= 0) {
                int code = process.waitFor();
                recordExit(code, "服务端没有写出端口就退出了");
                return;
            }
            JSONObject ready = new JSONObject();
            ready.put("port", port);
            ready.put("pid", pidOf(process));
            ready.put("node", "go");
            onNodeReadyLine(ready.toString());

            int code = process.waitFor();
            recordExit(code, "本地服务已退出");
        } catch (Throwable error) {
            Log.e(TAG, "[:node] 本地服务启动失败", error);
            synchronized (ElainaNodeService.class) {
                lastError = String.valueOf(error.getMessage());
                started = false;
                readyPort = -1;
            }
            pushToClient(null, MSG_STATE, stateBundle());
            updateNotification("启动失败");
        }
    }

    /** 把 Go 的 stdout/stderr 转发进 logcat —— 手机上唯一的观察窗口。 */
    private void pumpOutput(Process process) {
        new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    Log.i(TAG, line);
                }
            } catch (IOException error) {
                Log.w(TAG, "读取服务端输出失败：" + error.getMessage());
            }
        }, "elaina-server-log").start();
    }

    /** 轮询端口文件。进程先退出时立即返回 -1（不要干等 20 秒）。 */
    private int waitForPort(File portFile, Process process) throws InterruptedException {
        long deadline = System.currentTimeMillis() + READY_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (!process.isAlive()) return -1;
            String text = readText(portFile);
            if (text != null) {
                try {
                    int port = Integer.parseInt(text.trim());
                    if (port > 0) return port;
                } catch (NumberFormatException ignored) {
                    // 文件刚建、内容还没写完：下一轮再读。
                }
            }
            Thread.sleep(120);
        }
        return -1;
    }

    private static String readText(File file) {
        if (!file.isFile()) return null;
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] raw = new byte[(int) Math.min(file.length(), 32)];
            int read = input.read(raw);
            if (read <= 0) return null;
            return new String(raw, 0, read, StandardCharsets.UTF_8);
        } catch (IOException error) {
            return null;
        }
    }

    private static int pidOf(Process process) {
        try {
            return (int) Process.class.getMethod("pid").invoke(process);
        } catch (Exception ignored) {
            return 0;
        }
    }

    /** 清掉历史端口文件（只删我们自己前缀的，不碰 cache 里的其它东西）。 */
    private void cleanOldPortFiles() {
        File[] files = getCacheDir().listFiles();
        if (files == null) return;
        for (File file : files) {
            if (file.getName().startsWith("elaina-server-") && file.getName().endsWith(PORT_FILE_SUFFIX)) {
                if (!file.delete()) {
                    Log.w(TAG, "旧端口文件删不掉（不影响本次启动）：" + file);
                }
            }
        }
    }

    private void recordExit(int code, String message) {
        Log.i(TAG, "[:node] " + message + "，退出码 " + code);
        synchronized (ElainaNodeService.class) {
            exitCode = code;
            started = false;
            readyPort = -1;
        }
        Bundle b = new Bundle();
        b.putInt("exitCode", code);
        b.putString("message", message);
        pushToClient(null, MSG_EXIT, b);
        pushToClient(null, MSG_STATE, stateBundle());
        updateNotification("已停止");
    }

    /**
     * 服务报出端口时触发：推 MSG_READY 给主进程。
     *
     * <p>方法名与签名沿用历史约定（诊断页与旧 native 回调都按这个名字找）；
     * 现在由本类的启动线程直接调用。
     */
    @SuppressWarnings("unused")
    static void onNodeReadyLine(String payload) {
        try {
            JSONObject parsed = new JSONObject(payload);
            final int port = parsed.optInt("port", -1);
            readyPort = port;
            readyAt = System.currentTimeMillis();
            Log.i(TAG, "[:node] 本地服务已就绪，端口 " + port);

            Bundle b = new Bundle();
            b.putInt("port", port);
            b.putInt("pid", parsed.optInt("pid", 0));
            b.putString("node", parsed.optString("node", ""));
            pushToClient(null, MSG_READY, b);
            pushToClient(null, MSG_STATE, stateBundle());
        } catch (Exception error) {
            lastError = "就绪行解析失败：" + payload;
            Log.e(TAG, lastError, error);
            pushToClient(null, MSG_STATE, stateBundle());
        }
    }

    private File dataDir() {
        return dataDirOf(this);
    }

    private static File dataDirOf(Context context) {
        return new File(context.getFilesDir(), DATA_DIR);
    }
}
