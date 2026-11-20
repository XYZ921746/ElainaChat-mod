package com.elainachat.mod;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 手机操作的执行后端。
 *
 * <p>三条后台路径，能力来源不同：
 * <ul>
 *   <li>{@link ShizukuExecutor} —— Shizuku / Sui 授权，shell 或 root uid 的常驻 holder；</li>
 *   <li>{@link RootExecutor} —— {@code su} 起出来的 uid 0 holder；</li>
 *   <li>{@link ModuleExecutor} —— agent-mobile-use 模块的本机 HTTP 网关。</li>
 * </ul>
 * 无障碍后端不走这里（它直接调系统 API，见 {@link ElainaAccessibilityService}）。
 *
 * <p>为什么 Shizuku / Root 的 {@code run} 不执行命令：它们的能力是**语义动作**
 * （启动应用 / 点击 / 截图），命令通道不开放 —— 那等于把 root 执行权交给模型。
 * 动作走 {@link HolderExecutor} 的专用方法，见 {@code ElainaShellPlugin} 的 runOnHolder。
 */
final class ShellBackends {

    private ShellBackends() {}

    /** 能执行命令的后端。 */
    interface Executor {
        /** 与前端 AGENT_BACKENDS 里的 id 一致 */
        String id();

        /** 给用户看的中文名 */
        String label();

        /** 能不能用（不代表已授权，只代表"这条路存在"） */
        boolean available(Context context);

        /** 一句话说明当前状态，会显示在设置页的卡片上 */
        String detail(Context context);

        /** 真正执行。不允许抛异常，失败也要包成 Result 返回。 */
        ShellProcess.Result run(Context context, String command, int timeoutMs);
    }

    /** 后台 holder 后端（Shizuku / Root）的公共面：动作是语义的，不是命令字符串。 */
    abstract static class HolderExecutor implements Executor {
        @Override
        public ShellProcess.Result run(Context context, String command, int timeoutMs) {
            // 命令通道不开放：模型能发任意命令等于把 root 交出去。
            // 动作请走 ElainaShellPlugin.runOnHolder（启动 / 点击 / 截图 / 读界面）。
            return new ShellProcess.Result(-1, "", "这条后台方式不执行任意命令；"
                + "需要操作手机请用「手机打开 / 手机点击 / 手机滑动 / 手机输入 / 手机按键」。", false);
        }
    }

    // Shizuku

    /**
     * Shizuku / Sui：授权后由 UserService 在 shell 或 root uid 里持有副屏。
     *
     * <p>能否建 **trusted** 副屏取决于系统是否给 {@code com.android.shell} 留了
     * {@code ADD_TRUSTED_DISPLAY} 权限 —— 随 Android 版本与 ROM 变化，不能按版本写死。
     * 所以这里不做任何版本判断，可用性一律以运行时探测（{@code probeBackground} /
     * {@link DisplayHolder#createDisplay}）的结果为准，失败时把原因翻译成可执行的下一步。
     * root 启动（uid 0）与 Sui 不受 shell 权限这条限制。
     */
    static final class ShizukuExecutor extends HolderExecutor {
        private final ShizukuBridge bridge;

        ShizukuExecutor(Context context) {
            this.bridge = ShizukuBridge.get(context);
        }

        @Override
        public String id() {
            return "shizuku";
        }

        @Override
        public String label() {
            return "Shizuku";
        }

        @Override
        public boolean available(Context context) {
            // 只「服务在」不算可用：没授权时选它，每个动作都会在 holder 那一步失败。
            // 状态卡片的 detail 仍会说明「已运行但未授权」，用户知道下一步点哪。
            return bridge.serviceAlive() && bridge.granted();
        }

        @Override
        public String detail(Context context) {
            return bridge.describe(context);
        }

        ShizukuBridge bridge() {
            return bridge;
        }
    }

    // Root

    /**
     * Root：{@code su} 起一个 uid 0 的 holder。
     *
     * <p>与 Shizuku 的区别只有授权来源：不走 Shizuku 的 Binder，也不需要装任何管理器之外的东西。
     * 它不受 Android 15 QPR2 移除 shell 权限的影响（uid 0 直接过校验）。
     */
    static final class RootExecutor extends HolderExecutor {
        private final RootBridge bridge;

        RootExecutor(Context context) {
            this.bridge = RootBridge.get(context);
        }

        @Override
        public String id() {
            return "root";
        }

        @Override
        public String label() {
            return "Root";
        }

        @Override
        public boolean available(Context context) {
            return bridge.available(context);
        }

        @Override
        public String detail(Context context) {
            return bridge.detail(context);
        }

        RootBridge bridge() {
            return bridge;
        }
    }

    // KernelSU 模块网关

    /**
     * 走 KernelSU 模块提供的本机 HTTP 网关。
     *
     * <p>地址做成可配置的（存本地设置），因为模块作者随时可能改端口。
     * 默认 {@code http://127.0.0.1:3070}。
     */
    static final class ModuleExecutor implements Executor {
        private static final String PREFS = "elainachat_open_shell";
        private static final String KEY_GATEWAY = "module_gateway";
        static final String DEFAULT_GATEWAY = "http://127.0.0.1:3070";

        private static final String PATH_STATUS = "/api/status";
        /** 模块的截图接口：直接返回当前目标屏的 JPEG（比 vd screenshot 可靠得多） */
        static final String PATH_SCREENSHOT = "/api/screenshot";
        /** 模块的结构化控件树接口 */
        static final String PATH_DUMP_UI = "/api/dump_ui";
        /** 运行模式：idle / background / foreground。见 {@link #ensureMode} 的说明 */
        static final String PATH_MODE = "/api/mode";

        // 模块的复合动作端点
        //
        // 为什么用 JSON 端点而不是 vd 命令族（`vd tap` / `vd set_value` …）：
        //   · 参数是 JSON，**不需要拼 shell 字符串** —— 中文、引号、$ 等特殊字符
        //     不会因为转义出错；
        //   · 返回 {success, message, data} 结构化结果，能区分"执行了但没生效"与"没执行"；
        //   · 动作之后模块自己会回传一份新的控件树（data 字段），省掉一次往返。
        //
        // 模块 0.6.0 起把这些动作合并成了一个 POST /api/action（字段 action 区分），
        // 逐个动作的老端点（/api/click、/api/swipe、/api/type、/api/key、/api/launch）
        // **已经被删掉**，不再是可选路径 —— 继续打过去只会 404。
        static final String PATH_ACTION = "/api/action";

        // 复合动作的名称。模块侧是小写下划线，与 HTTP 端点名不同。
        static final String ACTION_CLICK = "click";
        static final String ACTION_SWIPE = "swipe";
        static final String ACTION_SET_VALUE = "set_value";
        static final String ACTION_KEY = "key";
        static final String ACTION_LAUNCH = "launch_app";
        static final String ACTION_WAIT = "wait";
        static final String ACTION_OBSERVE = "observe";

        /** POST 一个 JSON 到模块并返回解析后的 JSONObject；失败返回 null。 */
        static JSONObject post(Context context, String path, JSONObject body, int timeoutMs) {
            String raw = http(context, "POST", path, body == null ? "{}" : body.toString(), timeoutMs);
            if (raw == null) return null;
            try {
                return new JSONObject(raw.trim());
            } catch (Exception error) {
                return null;
            }
        }

        /**
         * POST 并返回原始文本（不解析 JSON）。
         *
         * <p>用于 {@code /api/start} / {@code /api/stop} 这类返回体不固定的端点 ——
         * 有的版本回 JSON，有的回状态对象；只要能发出请求、拿到响应即可，
         * 状态一律以随后的 {@link #probe} 为准（那才是权威）。
         */
        static String postRaw(Context context, String path, String jsonBody, int timeoutMs) {
            return http(context, "POST", path, jsonBody == null ? "{}" : jsonBody, timeoutMs);
        }

        /** 模块的 {success, message, data} 统一响应里，判断是否成功 */
        static boolean isSuccess(JSONObject json) {
            return json != null && json.optBoolean("success", false);
        }

        /** 取模块响应里的可读文本（message 优先，其次 data） */
        static String describe(JSONObject json) {
            if (json == null) return "";
            String message = json.optString("message", "");
            if (!message.isEmpty()) return message;
            Object data = json.opt("data");
            return data == null ? "" : String.valueOf(data);
        }

        @Override
        public String id() {
            return "module";
        }

        @Override
        public String label() {
            return "模块";
        }

        static String gateway(Context context) {
            String value = prefs(context).getString(KEY_GATEWAY, "");
            return (value == null || value.trim().isEmpty()) ? DEFAULT_GATEWAY : value.trim();
        }

        static void setGateway(Context context, String value) {
            prefs(context).edit().putString(KEY_GATEWAY, value == null ? "" : value.trim()).apply();
        }

        @Override
        public boolean available(Context context) {
            return probe(context) != null;
        }

        @Override
        public String detail(Context context) {
            JSONObject status = probe(context);
            if (status == null) return "未检测到（" + gateway(context) + "）";
            String name = status.optString("name", "");
            return name.isEmpty() ? "已就绪" : ("已就绪：" + name);
        }

        /** 探测网关在不在。返回 null 表示连不上。 */
        static JSONObject probe(Context context) {
            try {
                String body = http(context, "GET", PATH_STATUS, null, 2500);
                if (body == null) return null;
                String trimmed = body.trim();
                if (trimmed.startsWith("{")) {
                    try {
                        return new JSONObject(trimmed);
                    } catch (Exception ignored) {
                        // 不是合法 JSON 也算连上了
                    }
                }
                return new JSONObject();
            } catch (Exception error) {
                return null;
            }
        }

        @Override
        public ShellProcess.Result run(Context context, String command, int timeoutMs) {
            // 模块 0.6.0 起删掉了 /api/shell（上游把「root shell 直通」当成安全面收掉了：
            // 那个端点等于把整台设备的 root 执行权交给任何一个能发本地 HTTP 请求的人）。
            // 0.8.7 没有留下等价端点，所以这里**不能**假装成功、也不能偷偷换成
            // `vd` 之类的命令族 —— 那会执行一条与用户要求不同的命令。
            //
            // 如实报错，并指出真正还能用的路：模块的复合动作端点（/api/action）。
            return new ShellProcess.Result(-1, "",
                "模块新版已移除 shell 直通端点（/api/shell）。"
                    + "需要操作手机请用「手机点击 / 手机滑动 / 手机输入 / 手机按键 / 手机打开」这些动作，"
                    + "它们走模块的 /api/action，能力等价且不会把 root 执行权暴露成本地 HTTP 接口。",
                false);
        }

        /**
         * 确保模块当前**不是 idle**，并在需要时把副屏拉起来。
         *
         * <p>为什么每个动作前都要问一次：模块 0.8.0 引入了三态模式
         * （idle / background / foreground），**默认就是 idle**，而 idle 下
         * {@code /api/action}、{@code /api/dump_ui}、{@code /api/screenshot}
         * 一律 404 并回一句 "Agent is currently in idle mode (no focused display, display -1)"。
         * 更麻烦的是它不是一次性状态：模块在收到 {@code /api/session/watch} 的
         * 心跳归零时会把模式**自动退回 idle**（键盘闲置、通知胶囊销毁都走这条）。
         *
         * <p>所以"启动时设一次"是不够的 —— 每一次动作前都要确认，否则表现为
         * "一开始能用，过一会儿每个动作都报 no focused display"。
         *
         * <p>选 background 而不是 foreground：这个后端存在的意义就是**不抢用户正在用的屏幕**，
         * 而 foreground 会把操作打到物理主屏上（display 0），那就不是"后台静默"了。
         *
         * @return null 表示已就绪；否则是给用户看的中文原因
         */
        static String ensureMode(Context context, int timeoutMs) {
            JSONObject mode = queryMode(context, timeoutMs);
            if (mode == null) return "连不上模块网关（" + gateway(context) + "）";
            String current = mode.optString("mode", "");
            if ("background".equals(current) || "foreground".equals(current)) return null;

            JSONObject switched = post(context, PATH_MODE + "?mode=background", null, timeoutMs);
            if (switched == null) return "模块在 idle 模式下，切到「后台副屏」失败（/api/mode 没有响应）";
            // 切模式本身可能失败（比如副屏起不来），以它回的 success 为准，
            // 而不是"请求发出去了就当成功" —— 否则后面每个动作都会报一个更难懂的错。
            if (!switched.optBoolean("success", true)) {
                String why = switched.optString("message", "");
                return "模块切到「后台副屏」失败" + (why.isEmpty() ? "" : "：" + why);
            }
            return null;
        }

        /** 读当前模式；连不上返回 null（与"模式是空字符串"区分开） */
        static JSONObject queryMode(Context context, int timeoutMs) {
            String body = http(context, "GET", PATH_MODE, null, timeoutMs);
            if (body == null) return null;
            try {
                return new JSONObject(body.trim());
            } catch (Exception error) {
                return null;
            }
        }


        private static String http(Context context, String method, String path, String jsonBody, int timeoutMs) {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(gateway(context) + path);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod(method);
                connection.setConnectTimeout(Math.min(timeoutMs, 3000));
                connection.setReadTimeout(Math.max(1500, timeoutMs));
                connection.setRequestProperty("Accept", "application/json");
                if (jsonBody != null) {
                    byte[] bytes = jsonBody.getBytes(StandardCharsets.UTF_8);
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(bytes.length);
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    try (OutputStream output = connection.getOutputStream()) {
                        output.write(bytes);
                    }
                }
                int status = connection.getResponseCode();
                InputStream stream = status >= 200 && status < 400
                    ? connection.getInputStream()
                    : connection.getErrorStream();
                if (stream == null) return null;
                return readAll(stream);
            } catch (Exception error) {
                return null;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }

        private static String readAll(InputStream stream) {
            try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16 * 1024];
                int total = 0;
                int read;
                while ((read = input.read(buffer)) != -1) {
                    total += read;
                    if (total > 4 * 1024 * 1024) break;
                    output.write(buffer, 0, read);
                }
                return new String(output.toByteArray(), StandardCharsets.UTF_8);
            } catch (Exception error) {
                return null;
            }
        }

        /**
         * 取二进制响应（截图用）。
         *
         * <p>模块的 {@code GET /api/screenshot} 直接返回**副屏当前帧的 JPEG**
         * （守护进程本来就持有那个 Surface，编 JPEG 只要 ~18ms/270KB），
         * 而 {@code vd screenshot} 那条路走 {@code screencap} 且实测报
         * {@code Status: -2} 失败。所以截图必须走这个 HTTP 接口。
         */
        static byte[] httpBytes(Context context, String path, int timeoutMs) {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(gateway(context) + path);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(Math.min(timeoutMs, 3000));
                connection.setReadTimeout(Math.max(1500, timeoutMs));
                connection.setRequestProperty("Accept", "image/*");
                int status = connection.getResponseCode();
                if (status < 200 || status >= 400) return null;
                try (InputStream input = connection.getInputStream();
                     ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[32 * 1024];
                    int total = 0;
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        total += read;
                        if (total > 12 * 1024 * 1024) break;
                        output.write(buffer, 0, read);
                    }
                    return output.toByteArray();
                }
            } catch (Exception error) {
                return null;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }

        /** 模块后端的结构化控件树（GET /api/dump_ui）—— 比 vd tree 更稳，且是模块的正式接口 */
        static String dumpUi(Context context, int timeoutMs) {
            return http(context, "GET", PATH_DUMP_UI, null, timeoutMs);
        }

        private static SharedPreferences prefs(Context context) {
            return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        }
    }
}
