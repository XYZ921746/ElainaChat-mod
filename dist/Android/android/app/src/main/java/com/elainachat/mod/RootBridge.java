package com.elainachat.mod;

import android.content.Context;
import android.os.Binder;
import android.os.IBinder;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Root 后端的应用侧：用 {@code su} 拉起 holder，再通过**文件桥**与它通信。
 *
 * <p>为什么不用 Binder：{@code app_process} 起的 uid 0 进程不是已注册的应用进程，
 * {@code ContentResolver} 拿不到 Provider（报 "Unable to find app for caller ..."），
 * {@code getContentProviderExternal} 在国产 ROM 上也拿不到。root 读写应用的外部文件目录
 * 没有这些限制，所以用命令/结果文件通信，见 {@link RootHolderMain}。
 *
 * <p>为什么探测要缓存：{@link #available(Context)} 会跑一次 {@code su -c id}，
 * 首次授权时 root 管理器会弹窗。设置页刷新状态会连着问好几次，每次都弹一遍就成了骚扰；
 * 所以结果缓存到显式 {@link #invalidate()} 为止。
 */
final class RootBridge {

    private static final String TAG = "ElainaRoot";
    private static final long PROBE_TTL_MS = 30_000L;
    /** 单条动作等结果的上限；截图 / 读界面要久一些，由调用方传。 */
    private static final int DEFAULT_TIMEOUT_MS = 20_000;
    private static final String ATOMIC_SPECIAL_USE = "elaina-root";

    private static RootBridge instance;

    private final Context appContext;
    private final Object lock = new Object();

    private long probedAt = 0L;
    private boolean lastAvailable = false;
    private String lastDetail = "还没有检测";

    private Process holderProcess;
    private File bridgeDir;
    private String holderToken = "";
    private final AtomicLong seq = new AtomicLong(1);

    private RootBridge(Context context) {
        this.appContext = context.getApplicationContext();
    }

    static synchronized RootBridge get(Context context) {
        if (instance == null) instance = new RootBridge(context);
        return instance;
    }

    /** 强制下次重新探测（用户点了「重新检测」或刚授权完）。 */
    void invalidate() {
        synchronized (lock) {
            probedAt = 0L;
        }
    }

    /** 有没有 su、能不能拿到 uid 0。结果缓存 30 秒。 */
    boolean available(Context context) {
        probe();
        return lastAvailable;
    }

    String detail(Context context) {
        probe();
        return lastDetail;
    }

    private void probe() {
        synchronized (lock) {
            long now = System.currentTimeMillis();
            if (probedAt != 0L && now - probedAt < PROBE_TTL_MS) return;
            probedAt = now;
            ShellProcess.Result result = ShellProcess.runArgv(
                new String[]{"su", "-c", "id"}, 4000, 4096);
            String text = (result.stdout + result.stderr).trim();
            // 探测结果必须落日志：root 授权是静默的（尤其首次弹窗被系统吞掉时），
            // 没有这条就只能看到界面上一句"不可用"，分不清是没 su、被拒、还是超时。
            Log.i(TAG, "su probe: code=" + result.code + " timedOut=" + result.timedOut
                + " out=" + firstLine(text));
            if (result.timedOut) {
                lastAvailable = false;
                lastDetail = "等待 root 授权超时 —— 请在 root 管理器里允许本应用，然后点「重新检测」";
                return;
            }
            // 只认 "uid=0(" 这个精确形状：uid=10052 这类普通 uid 也包含 "uid=1"，
            // 但不会被误判；写成 contains("uid=0") 则会被 "uid=0..." 之外的串骗过。
            if (result.ok() && text.contains("uid=0(")) {
                lastAvailable = true;
                lastDetail = "已授权（root，后台可用）";
                return;
            }
            lastAvailable = false;
            if (!result.ok()) {
                lastDetail = "拿不到 root：设备可能没有 root，或本应用被拒绝授权"
                    + (text.isEmpty() ? "" : "（" + firstLine(text) + "）");
            } else {
                lastDetail = "su 可用但拿到的不是 uid 0（" + firstLine(text) + "）";
            }
        }
    }

    private static String firstLine(String text) {
        int nl = text.indexOf('\n');
        String line = nl > 0 ? text.substring(0, nl) : text;
        return line.length() > 120 ? line.substring(0, 120) + "…" : line;
    }

    /** 申请 root：跑一次 {@code su -c id}，让 root 管理器弹授权框。 */
    String requestPermission(Context context) {
        invalidate();
        ShellProcess.Result result = ShellProcess.runArgv(
            new String[]{"su", "-c", "id"}, 20_000, 4096);
        String text = (result.stdout + result.stderr).trim();
        if (result.ok() && text.contains("uid=0(")) {
            invalidate();
            return "已获得 root 权限。";
        }
        if (result.timedOut) {
            return "等待 root 授权超时：请在 root 管理器里找到本应用并允许，然后回来点「重新检测」。";
        }
        return "没能拿到 root 权限" + (text.isEmpty() ? "" : "：" + firstLine(text))
            + "\n请确认设备已 root（Magisk / KernelSU / APatch），并在管理器里允许本应用。";
    }

    /**
     * 拿 holder 句柄：没有就 {@code su} 起一个。
     *
     * <p>返回的对象实现 {@link IDisplayHolder}，方法体是"写命令文件 + 等结果文件"，
     * 所以上层（runOnHolder）不需要知道通信方式是 Binder 还是文件。
     */
    IDisplayHolder holder(int timeoutMs) throws Exception {
        synchronized (lock) {
            if (holderAlive()) {
                return new FileHolder(bridgeDir, DEFAULT_TIMEOUT_MS);
            }
            probe();
            if (!lastAvailable) throw new IllegalStateException(lastDetail);
            startHolderLocked();
            long deadline = System.currentTimeMillis() + Math.max(3000, timeoutMs);
            File ready = new File(bridgeDir, "ready");
            while (System.currentTimeMillis() < deadline) {
                if (ready.isFile()) {
                    String token = readSmall(ready);
                    if (!holderToken.equals(token)) {
                        throw new IllegalStateException("holder 的 token 不匹配（可能是上一次进程残留）");
                    }
                    return new FileHolder(bridgeDir, DEFAULT_TIMEOUT_MS);
                }
                if (holderProcess != null && !holderProcess.isAlive()) break;
                Thread.sleep(100);
            }
            throw new IllegalStateException("root 副屏进程没有起来（超时）。"
                + "可能的原因：root 管理器拒绝了 su、系统限制了 app_process，或本应用被冻结。"
                + "可以改用「模块」方式。");
        }
    }

    /**
     * holder 是否真的还在干活。
     *
     * <p>三个判据缺一不可：ready 文件在（启动完成）、token 对得上（是本次的 holder）、
     * 心跳是新的（进程没被冻结）。只看 pid 会把被冻结的 holder 当成可用，
     * 结果每条动作都要等到超时才报错。
     */
    private boolean holderAlive() {
        if (bridgeDir == null) return false;
        File ready = new File(bridgeDir, "ready");
        if (!ready.isFile()) return false;
        if (!holderToken.equals(readSmall(ready))) return false;
        File beat = new File(bridgeDir, "heartbeat");
        if (!beat.isFile()) return false;
        try {
            long at = Long.parseLong(readSmall(beat));
            return System.currentTimeMillis() - at < 8000;
        } catch (Throwable error) {
            return false;
        }
    }

    private void startHolderLocked() throws Exception {
        holderToken = randomToken();
        bridgeDir = new File(appContext.getExternalFilesDir(null), "rootbridge");
        //noinspection ResultOfMethodCallIgnored
        bridgeDir.mkdirs();
        // 先杀掉上一次遗留的 holder：多个 holder 抢同一个通信目录会互相删掉对方的
        // 命令/结果文件（实测：三个 app_process 同时在跑，动作随机失败）。
        killStaleHolders();
        removeStaleDisplays();
        String classPath = appContext.getPackageCodePath();
        String command = "CLASSPATH=" + quote(classPath)
            + " app_process /system/bin " + RootHolderMain.class.getName()
            + " --token=" + quote(holderToken)
            + " --dir=" + quote(bridgeDir.getAbsolutePath());
        holderProcess = new ProcessBuilder("su", "-c", command).start();
    }

    /**
     * 杀掉所有旧的 RootHolderMain 进程。
     *
     * <p>为什么要主动清：应用被杀 / 升级 / 插件重建时，uid 0 的 holder 不会跟着退
     * （它不归应用进程管）。留下的 holder 仍在轮询同一个目录，会把新 holder 要处理的
     * 命令文件读走 —— 表现为"动作时好时坏、结果文件对不上"。
     */
    private void killStaleHolders() {
        try {
            // pkill -f 按命令行匹配：只杀本类的 holder，不碰别的 su 会话
            ShellProcess.runArgv(new String[]{"su", "-c",
                "pkill -f com.elainachat.mod.RootHolderMain"}, 4000, 4096);
            // 给内核一点时间回收（进程退出与目录句柄释放之间有窗口）
            Thread.sleep(200);
        } catch (Throwable ignored) {
            // 杀不掉就继续：新 holder 仍会尝试启动，只是可能和旧的抢目录
        }
    }

    /**
     * 清掉上一次留下的空副屏。
     *
     * <p>holder 被强杀时来不及 {@code release()}，display 记录会留在系统里
     * （实测：跑几轮后 {@code Display #3} 这类空屏会积下来，每次新建都拿到更大的 id）。
     * 系统的 {@code cmd display} 没有 remove 子命令（实测只有 brightness / notification），
     * 所以这里**不试图从外部删屏** —— 只能靠 holder 正常退出时 {@link DisplayHolder#destroy()} 释放。
     * 真留下空屏时不影响功能，只是 displayId 会继续增大。
     */
    private void removeStaleDisplays() {
        // 保留方法是为了把"为什么不做"写清楚；调用点仍在，方便以后系统提供删除接口时补实现。
    }

    /** 文件桥客户端：每条命令写一个文件，等对应结果文件。 */
    private final class FileHolder implements IDisplayHolder {
        private final File dir;
        private final int timeoutMs;
        /** 本地 Binder 只用于让 {@code asBinder().isBinderAlive()} 这类判据成立。 */
        private final IBinder binder = new Binder();

        FileHolder(File dir, int timeoutMs) {
            this.dir = dir;
            this.timeoutMs = timeoutMs;
        }

        @Override
        public IBinder asBinder() {
            return binder;
        }

        private JSONObject call(JSONObject request, int timeout) throws Exception {
            long id = seq.getAndIncrement();
            String name = String.format("%013d-%06d", System.currentTimeMillis(), id);
            File cmd = new File(dir, "cmd-" + name + ".json");
            File res = new File(dir, "res-" + name + ".json");
            write(cmd, request.toString());
            long deadline = System.currentTimeMillis() + Math.max(1000, timeout);
            try {
                while (System.currentTimeMillis() < deadline) {
                    if (res.isFile()) {
                        String text = read(res);
                        //noinspection ResultOfMethodCallIgnored
                        res.delete();
                        return new JSONObject(text);
                    }
                    if (holderProcess != null && !holderProcess.isAlive()) {
                        throw new IllegalStateException("root holder 进程已退出");
                    }
                    Thread.sleep(30);
                }
                throw new IllegalStateException("root holder 没有响应（超时）");
            } finally {
                // 无论成功、超时还是异常，命令文件都必须清掉：
                // 留着的话 holder 下次启动会重放一条早已过期的动作。
                //noinspection ResultOfMethodCallIgnored
                cmd.delete();
            }
        }

        private void ensureOk(JSONObject reply) {
            if (reply == null || !reply.optBoolean("ok", false)) {
                String error = reply == null ? "没有响应" : reply.optString("error", "未知错误");
                throw new IllegalStateException(error);
            }
        }

        @Override
        public int createDisplay(int width, int height, int dpi, String name) {
            try {
                JSONObject request = new JSONObject();
                request.put("op", "create");
                request.put("width", width);
                request.put("height", height);
                request.put("dpi", dpi);
                request.put("name", name);
                JSONObject reply = call(request, timeoutMs + 4000);
                ensureOk(reply);
                return reply.optInt("displayId", -1);
            } catch (Exception error) {
                throw new IllegalStateException(ShellProcess.describe(error));
            }
        }

        @Override
        public int displayId() {
            try {
                JSONObject request = new JSONObject();
                request.put("op", "displayId");
                JSONObject reply = call(request, timeoutMs);
                ensureOk(reply);
                return reply.optInt("displayId", -1);
            } catch (Exception error) {
                throw new IllegalStateException(ShellProcess.describe(error));
            }
        }

        @Override
        public void launch(String pkg, String component) {
            try {
                JSONObject request = new JSONObject();
                request.put("op", "launch");
                request.put("pkg", pkg);
                request.put("component", component == null ? "" : component);
                ensureOk(call(request, timeoutMs));
            } catch (Exception error) {
                throw new IllegalStateException(ShellProcess.describe(error));
            }
        }

        @Override
        public String foreground() {
            try {
                JSONObject request = new JSONObject();
                request.put("op", "foreground");
                JSONObject reply = call(request, timeoutMs);
                ensureOk(reply);
                return reply.optString("pkg", "");
            } catch (Exception error) {
                return "";
            }
        }

        @Override
        public void tap(int x, int y, int durationMs) {
            try {
                JSONObject request = new JSONObject();
                request.put("op", "tap");
                request.put("x", x);
                request.put("y", y);
                request.put("duration", durationMs);
                ensureOk(call(request, timeoutMs));
            } catch (Exception error) {
                throw new IllegalStateException(ShellProcess.describe(error));
            }
        }

        @Override
        public void swipe(int x1, int y1, int x2, int y2, int durationMs) {
            try {
                JSONObject request = new JSONObject();
                request.put("op", "swipe");
                request.put("x1", x1);
                request.put("y1", y1);
                request.put("x2", x2);
                request.put("y2", y2);
                request.put("duration", durationMs);
                ensureOk(call(request, timeoutMs));
            } catch (Exception error) {
                throw new IllegalStateException(ShellProcess.describe(error));
            }
        }

        @Override
        public void key(int keyCode) {
            try {
                JSONObject request = new JSONObject();
                request.put("op", "key");
                request.put("key", keyCode);
                ensureOk(call(request, timeoutMs));
            } catch (Exception error) {
                throw new IllegalStateException(ShellProcess.describe(error));
            }
        }

        @Override
        public void inputText(String text) {
            try {
                JSONObject request = new JSONObject();
                request.put("op", "inputText");
                request.put("text", text);
                ensureOk(call(request, timeoutMs));
            } catch (Exception error) {
                throw new IllegalStateException(ShellProcess.describe(error));
            }
        }

        @Override
        public String dumpUi() {
            try {
                JSONObject request = new JSONObject();
                request.put("op", "dumpUi");
                JSONObject reply = call(request, timeoutMs + 10_000);
                ensureOk(reply);
                return reply.optString("text", "");
            } catch (Exception error) {
                throw new IllegalStateException(ShellProcess.describe(error));
            }
        }

        @Override
        public byte[] capture() {
            try {
                JSONObject request = new JSONObject();
                request.put("op", "capture");
                JSONObject reply = call(request, timeoutMs + 6000);
                ensureOk(reply);
                return Base64.decode(reply.optString("png", ""), Base64.DEFAULT);
            } catch (Exception error) {
                throw new IllegalStateException(ShellProcess.describe(error));
            }
        }

        @Override
        public void destroy() {
            try {
                JSONObject request = new JSONObject();
                request.put("op", "destroy");
                call(request, 2000);
            } catch (Throwable ignored) {
                // holder 可能已经退出
            }
        }
    }

    private static String readSmall(File file) {
        try {
            return read(file).trim();
        } catch (Exception error) {
            return "";
        }
    }

    private static String read(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static void write(File file, String text) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(text.getBytes(StandardCharsets.UTF_8));
            output.flush();
        }
    }

    private static String randomToken() {
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format("%02x", b));
        return out.toString();
    }

    private static String quote(String value) {
        return "'" + String.valueOf(value).replace("'", "'\\''") + "'";
    }

    /** 释放副屏、关掉 holder 进程。插件销毁时调用。 */
    void release() {
        synchronized (lock) {
            try {
                if (bridgeDir != null) {
                    new FileHolder(bridgeDir, 2000).destroy();
                }
            } catch (Throwable ignored) {
                // holder 可能已退出
            }
            if (holderProcess != null) {
                try { holderProcess.destroy(); } catch (Throwable ignored) { }
                holderProcess = null;
            }
            if (bridgeDir != null) {
                File[] files = bridgeDir.listFiles();
                if (files != null) {
                    for (File file : files) {
                        //noinspection ResultOfMethodCallIgnored
                        file.delete();
                    }
                }
            }
            holderToken = "";
        }
    }
}