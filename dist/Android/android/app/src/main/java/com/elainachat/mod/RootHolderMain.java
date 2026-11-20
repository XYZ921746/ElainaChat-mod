package com.elainachat.mod;

import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.Comparator;

/**
 * Root 后端的 holder 入口：由 {@code su -c app_process} 以 uid 0 启动。
 *
 * <p>为什么用 {@code app_process}：虚拟屏、InputManager、Bitmap 都要 Android 框架类，
 * 而 {@code app_process} 就是现成的"带框架的 JVM 启动器"。APK 的 dex 已在 CLASSPATH 里。
 *
 * <p>为什么用**文件桥**而不是 Binder：{@code app_process} 起的进程不是已注册的应用进程 ——
 * {@code ContentResolver.call} 会报 "Unable to find app for caller ... when getting content provider"，
 * {@code getContentProviderExternal} 在这类 ROM 上也拿不到 Provider。而 root 读写应用的外部
 * 文件目录（{@code /sdcard/Android/data/<pkg>/files/...}）不受这些限制，所以用一对
 * 命令/结果文件通信：应用写 {@code cmd-<seq>.json}，holder 执行后写 {@code res-<seq>.json}。
 *
 * <p>代价是每次动作多一次文件轮询（约 60ms 间隔），换来的是不依赖 Binder 注册、不依赖
 * SELinux 对自定义 service 的放行 —— 在国产 ROM 上更稳。
 */
public final class RootHolderMain {

    private static final String TAG = "ElainaRootHolder";
    /** 轮询间隔：太短空转耗电，太长动作明显变慢。60ms 与模块 HTTP 往返相当。 */
    private static final long POLL_MS = 60;
    /** 心跳间隔：应用侧据此判断 holder 还活着（进程被冻结时 pid 仍在，但已经不干活了）。 */
    private static final long HEARTBEAT_MS = 2000;
    private static final String CMD_PREFIX = "cmd-";
    private static final String RES_PREFIX = "res-";
    private static final String SUFFIX = ".json";
    private static final String HEARTBEAT = "heartbeat";

    private RootHolderMain() {}

    public static void main(String[] args) {
        String token = "";
        String dirPath = "";
        for (String arg : args) {
            if (arg == null) continue;
            if (arg.startsWith("--token=")) token = arg.substring("--token=".length());
            if (arg.startsWith("--dir=")) dirPath = arg.substring("--dir=".length());
        }
        if (token.isEmpty() || dirPath.isEmpty()) {
            Log.e(TAG, "缺少 --token / --dir，拒绝启动");
            System.exit(2);
            return;
        }
        File dir = new File(dirPath);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            Log.e(TAG, "建不了通信目录：" + dirPath);
            System.exit(2);
            return;
        }
        try {
            // 清掉上一次遗留的命令/结果文件：否则重启后可能执行上一次没消费完的旧动作。
            cleanup(dir);
            ensureLooper();
            DisplayHolder holder = new DisplayHolder(null);
            // ready 文件让应用知道 holder 起来了；token 写进去，应用据此确认不是别人的 holder。
            writeString(new File(dir, "ready"), token);
            Log.i(TAG, "holder 就绪，dir=" + dirPath + " uid=" + android.os.Process.myUid());
            loop(dir, holder);
        } catch (Throwable error) {
            Log.e(TAG, "holder 启动失败：" + ShellProcess.describe(error));
            System.exit(1);
        }
    }

    /** 文件桥只需要 Looper 供 ImageReader 回调使用；这里用一个后台线程足够。 */
    private static void ensureLooper() {
        try {
            if (android.os.Looper.myLooper() == null) android.os.Looper.prepareMainLooper();
        } catch (Throwable ignored) {
            // 已经在 looper 线程上
        }
    }

    private static void loop(File dir, DisplayHolder holder) throws Exception {
        long lastBeat = 0L;
        while (true) {
            // 心跳：应用侧据 ready + heartbeat 的更新时间判断 holder 是否还在干活。
            // 只靠 pid 不够 —— 被冻结的进程 pid 还在，但已经不再轮询了。
            long now = System.currentTimeMillis();
            if (now - lastBeat >= HEARTBEAT_MS) {
                lastBeat = now;
                try {
                    writeString(new File(dir, HEARTBEAT), String.valueOf(now));
                } catch (Throwable ignored) {
                    // 写不了心跳不影响执行，只是应用侧会认为 holder 已死
                }
            }
            File[] files = dir.listFiles((d, name) -> name.startsWith(CMD_PREFIX) && name.endsWith(SUFFIX));
            if (files != null && files.length > 0) {
                // 按名字排序：cmd-<时间戳>-<seq>，先来的先执行
                Arrays.sort(files, Comparator.comparing(File::getName));
                for (File cmd : files) {
                    String name = cmd.getName();
                    String seq = name.substring(CMD_PREFIX.length(), name.length() - SUFFIX.length());
                    JSONObject result = new JSONObject();
                    try {
                        JSONObject request = new JSONObject(readString(cmd));
                        result = handle(holder, request);
                    } catch (Throwable error) {
                        result.put("ok", false);
                        result.put("error", ShellProcess.describe(error));
                    }
                    File res = new File(dir, RES_PREFIX + seq + SUFFIX);
                    // 先写临时文件再改名：应用侧按"文件存在"判断结果就绪，
                    // 直接写目标文件会让它读到半截 JSON（解析失败 → 报未知错误）。
                    File tmp = new File(dir, RES_PREFIX + seq + ".tmp");
                    writeString(tmp, result.toString());
                    //noinspection ResultOfMethodCallIgnored
                    tmp.renameTo(res);
                    //noinspection ResultOfMethodCallIgnored
                    cmd.delete();
                    if (result.optBoolean("destroy", false)) {
                        holder.destroy();
                        System.exit(0);
                    }
                }
            }
            Thread.sleep(POLL_MS);
        }
    }

    /** 执行一条语义动作。参数都从 JSON 来，避免任何 shell 拼接。 */
    private static JSONObject handle(DisplayHolder holder, JSONObject request) throws Exception {
        String op = request.optString("op", "");
        JSONObject out = new JSONObject();
        switch (op) {
            case "create": {
                int id = holder.createDisplay(
                    request.optInt("width", 1080),
                    request.optInt("height", 2400),
                    request.optInt("dpi", 420),
                    request.optString("name", "1"));
                out.put("ok", true);
                out.put("displayId", id);
                return out;
            }
            case "displayId":
                out.put("ok", true);
                out.put("displayId", holder.displayId());
                return out;
            case "launch":
                holder.launch(request.optString("pkg", ""), request.optString("component", ""));
                out.put("ok", true);
                return out;
            case "foreground":
                out.put("ok", true);
                out.put("pkg", holder.foreground());
                return out;
            case "tap":
                holder.tap(request.optInt("x", 0), request.optInt("y", 0), request.optInt("duration", 0));
                out.put("ok", true);
                return out;
            case "swipe":
                holder.swipe(request.optInt("x1", 0), request.optInt("y1", 0),
                    request.optInt("x2", 0), request.optInt("y2", 0), request.optInt("duration", 300));
                out.put("ok", true);
                return out;
            case "key":
                holder.key(request.optInt("key", 0));
                out.put("ok", true);
                return out;
            case "inputText":
                holder.inputText(request.optString("text", ""));
                out.put("ok", true);
                return out;
            case "dumpUi":
                out.put("ok", true);
                out.put("text", holder.dumpUi());
                return out;
            case "capture": {
                byte[] png = holder.capture(6000);
                out.put("ok", true);
                out.put("png", Base64.getEncoder().encodeToString(png));
                return out;
            }
            case "destroy":
                out.put("ok", true);
                out.put("destroy", true);
                return out;
            default:
                out.put("ok", false);
                out.put("error", "未知动作：" + op);
                return out;
        }
    }

    private static void cleanup(File dir) {
        File[] files = dir.listFiles((d, name) ->
            (name.startsWith(CMD_PREFIX) && name.endsWith(SUFFIX))
                || (name.startsWith(RES_PREFIX) && (name.endsWith(SUFFIX) || name.endsWith(".tmp")))
                || "ready".equals(name)
                || HEARTBEAT.equals(name));
        if (files == null) return;
        for (File file : files) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    private static String readString(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static void writeString(File file, String text) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(text.getBytes(StandardCharsets.UTF_8));
            output.flush();
        }
    }
}