package com.elainachat.mod;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 手机操作的原生设备层。
 *
 * <p>前端把它当作 {@code window.ElainaDevice} 使用（Capacitor 会按插件名注入
 * {@code window.Capacitor.Plugins.ElainaDevice}，前端再做一层别名）。
 *
 * <p>★★ 2026-10 后端收敛为**两个**（原先四个）：
 * <ul>
 *   <li>{@code accessibility} —— 无障碍。免 root、门槛最低，中文输入只有它能可靠做到。</li>
 *   <li>{@code module} —— KernelSU 模块提供的本机 HTTP 网关。能力最强、不抢前台。</li>
 * </ul>
 * 删掉的是 <b>Shizuku 与 Root</b>：两者本质是同一件事（adb / su 级权限），
 * 共同代价是"每次重启要重新授权""授权即全局生效"。用户要的是两个端点 ——
 * 门槛最低（无障碍）与能力最强（模块），中间那两条路不值得各自维护一套。
 *
 * <p>选择规则：
 * <ul>
 *   <li>前端会把用户选的实现方式放进 {@code backend} 参数里。**用户选了什么就用什么**，
 *       选的那个不可用时明确报错，而不是偷偷换一个 —— 否则用户以为在用模块，
 *       实际走的是无障碍，出了问题无从排查。</li>
 *   <li>没传 {@code backend} 时按 无障碍 → 模块 的顺序自动挑。</li>
 *   <li>唯一的例外是**中文输入**：命令族的 {@code input text} 只认 ASCII，
 *       只要无障碍服务开着，中文输入一律走无障碍（并在结果里说明）。</li>
 * </ul>
 */
@CapacitorPlugin(
    name = "ElainaDevice",
    permissions = {
        // ★ 2026-10 新增的读取类权限。这里声明是为了让 Capacitor 的
        //   requestPermission / checkPermissions 能统一处理它们 ——
        //   **不会**在安装或启动时自动索取，只有用户点「读取信息」里那个状态标记才弹框
        //   （2026-10 起申请入口从"申请权限"按钮改成了可点的状态标记）。
        @Permission(alias = "sms", strings = { android.Manifest.permission.READ_SMS }),
        @Permission(alias = "contacts", strings = { android.Manifest.permission.READ_CONTACTS }),
        @Permission(alias = "calendar", strings = { android.Manifest.permission.READ_CALENDAR }),
    }
)
public class ElainaShellPlugin extends Plugin {

    private static final String TAG = "ElainaShell";

    private static final String ID_ACCESSIBILITY = "accessibility";
    private static final String ID_MODULE = "module";

    /** 单条命令的默认超时。截图和读控件树要久一些（uiautomator 首次启动很慢）。 */
    private static final int TIMEOUT_DEFAULT = 20_000;
    private static final int TIMEOUT_SCREENSHOT = 25_000;
    private static final int TIMEOUT_UI_DUMP = 30_000;
    private static final int TIMEOUT_SHELL = 40_000;

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final ShellBackends.ModuleExecutor moduleExecutor = new ShellBackends.ModuleExecutor();
    /** 读取类能力（应用列表 / 通知 / 设备 / 短信 / 通讯录 / 日历）与工作区文件访问 */
    private DeviceInfoReader infoReader;
    private AgentWorkspace workspace;

    @Override
    public void load() {
        infoReader = new DeviceInfoReader(getContext());
        workspace = new AgentWorkspace(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    // ==================== 状态 ====================

    /**
     * 两个后端的可用性。
     *
     * <p>返回结构：{@code { accessibility: {available, detail}, module: {...} }}，
     * 与前端 {@code AGENT_BACKENDS} 的 id 一一对应。
     */
    @PluginMethod
    public void status(PluginCall call) {
        executor.execute(() -> {
            Context context = getContext();
            JSObject result = new JSObject();
            try {
                result.put(ID_ACCESSIBILITY, accessibilityStatus());
                result.put(ID_MODULE, describe(moduleExecutor.available(context), moduleExecutor.detail(context)));
                result.put("model", Build.MODEL);
                result.put("android", Build.VERSION.RELEASE);
                result.put("sdk", Build.VERSION.SDK_INT);
                result.put("gateway", ShellBackends.ModuleExecutor.gateway(context));
                // ★ 读取类能力的系统权限现状，供设置页显示"哪一项还没授权"。
                //   应用层开关（设置里的隐私开关）由前端管，这里只报**系统层**的事实。
                if (infoReader != null) result.put("permissions", infoReader.permissionStatus());
            } catch (Exception error) {
                call.reject("读取设备状态失败：" + ShellProcess.describe(error), error);
                return;
            }
            call.resolve(result);
        });
    }

    private JSObject accessibilityStatus() {
        boolean running = ElainaAccessibilityService.isRunning();
        String detail;
        if (running) {
            detail = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? "已开启（可点击/输入/读界面/截图）"
                : "已开启（Android 11 以下不支持截图，其余可用）";
        } else {
            detail = "未开启，点「去开启无障碍」";
        }
        return describe(running, detail);
    }

    private static JSObject describe(boolean available, String detail) {
        JSObject item = new JSObject();
        item.put("available", available);
        item.put("detail", detail);
        return item;
    }

    // ==================== 执行 ====================

    /**
     * 执行一个手机动作。
     *
     * <p>参数：{@code action}（如「手机点击」）、{@code args}（如「500 800」）、
     * {@code backend}（可选，用户选的实现方式）。
     */
    @PluginMethod
    public void exec(PluginCall call) {
        String action = call.getString("action", "").trim();
        String args = call.getString("args", "");
        String backend = call.getString("backend", "").trim();
        // ★★ 2026-10（用户反馈"我选了前台，它还是走了模块"）：strict = 前端在
        //   「运行方式」弹窗里拿到了用户的**显式选择**。显式选择必须压过"互通自动换路"——
        //   否则用户选了"前台运行（看得见 AI 操作）"，遇到无障碍做不到的动作（启动应用 /
        //   执行命令 / 部分按键）就被静默改到副屏上去了，他那份选择等于白选。
        boolean strict = Boolean.TRUE.equals(call.getBoolean("strictBackend", false));
        if (action.isEmpty()) {
            call.reject("缺少 action 参数");
            return;
        }
        executor.execute(() -> {
            try {
                call.resolve(runAction(action, args, backend, strict));
            } catch (Exception error) {
                call.reject("执行「" + action + "」失败：" + ShellProcess.describe(error), error);
            }
        });
    }

    private JSObject runAction(String action, String args, String preferred, boolean strict) throws Exception {
        // 「等待」不需要任何后端，本地睡一下就完事
        if (PhoneCommand.isLocalOnly(action)) {
            int ms = 800;
            try {
                ms = Math.max(0, Math.min(60_000, Integer.parseInt(args.trim())));
            } catch (NumberFormatException ignored) {
                // 用默认值
            }
            Thread.sleep(ms);
            return success("已等待 " + ms + " 毫秒。", "local");
        }

        // ★★ 读取信息（应用列表 / 通知 / 设备 / 短信 / 通讯录 / 日历）与工作区文件访问
        //    走独立分支：它们**不经过任何执行后端** ——
        //    这些都是应用自己有系统权限就能直接做的事，跟"点击屏幕"是两类能力。
        //    所以放在挑后端之前，免得"没选实现方式"时连读应用列表都做不了。
        if (DeviceInfoReader.handles(action)) {
            if (infoReader == null) return failure("设备信息读取器没有初始化，请重启应用。");
            return infoReader.run(action, args);
        }
        if (AgentWorkspace.handles(action)) {
            if (workspace == null) return failure("工作区没有初始化，请重启应用。");
            return workspace.run(action, args);
        }

        // 中文输入：命令族的 input text 只认 ASCII，无障碍的 ACTION_SET_TEXT 才行。
        // 这是"按动作挑最优后端"，优先于用户选的实现方式。
        //
        // ★★ 2026-10 修：`!strict` 这个条件不能省 —— 用户在「运行方式」里显式选了
        //   "后台运行（模块）"时，这条"按动作挑最优后端"会把他**送去无障碍**，
        //   而他以为在副屏上静默操作。而且模块的 `vd type` 本来就支持中文
        //   （见 PhoneCommand.build 的 forModule 分支），这个兜底对模块根本不需要。
        if (!strict
            && "手机输入".equals(action)
            && !PhoneCommand.isAsciiOnly(args)
            && ElainaAccessibilityService.isRunning()) {
            return runOnAccessibility(action, args, true);
        }

        // ★★ 2026-10 修（真机反馈"我选了前台，它还是走了模块"）：
        //   strict = 用户在「运行方式」弹窗里做了**显式选择**。显式选择必须压过
        //   下面所有"自动挑一个 / 兜底走另一条"的逻辑 —— 否则用户的选择等于白选，
        //   而且失败时会指向一条他根本没选的路，排查方向全错。
        //
        //   为什么单独放在最前面、而不是只改原来那一处判断：
        //   原来 `strict` 只在 `ID_ACCESSIBILITY.equals(preferred)` 这一个分支里生效，
        //   而下面还有**第二个**换路点 —— `pickCommandExecutor` 在 preferred 不是
        //   "module" 时会**自动挑选**，而它的候选列表里只有模块。
        //   也就是说：preferred 只要不是 "module"，就一定会落到模块上，
        //   用户选的无障碍被整个绕过（真机上正是这条路径报出「启动失败（模块）」）。
        //   所以 strict 必须在**进入自动挑选之前**就分流掉。
        if (strict) {
            if (ID_ACCESSIBILITY.equals(preferred)) {
                // 无障碍做不到的动作（启动应用 / 任意命令 / 非三键按键）由
                // runOnAccessibility 如实地报"能力边界"，**绝不**换成模块。
                return runOnAccessibility(action, args, false);
            }
            if (ID_MODULE.equals(preferred)) {
                if (!moduleExecutor.available(getContext())) {
                    return failure(explainNoBackend(preferred)
                        + "\n（你选的是「后台运行（模块）」，所以这一步**不会**改用无障碍 —— "
                        + "要么把模块配置好，要么重新发起一次并改选「前台运行」。）");
                }
                return runOnCommandBackend(moduleExecutor, action, args);
            }
            // preferred 是个没见过的值：strict 的语义就是"照我说的做"，
            // 所以这里不猜、不兜底，如实报错让用户重新选一次。
            return failure("运行方式参数无法识别（" + (preferred.isEmpty() ? "空" : preferred) + "），这一步没有执行。"
                + "\n请重新发起一次操作，系统会再问你一次「前台运行 / 后台运行」。");
        }

        if (ID_ACCESSIBILITY.equals(preferred)) {
            // ★★ 2026-10（用户要求：「模块」与「无障碍」互通、由 AI 看情况使用）：
            //   用户选的仍是**首选**，但首选**做不到这个动作**时（能力边界 ——
            //   无障碍不能启动应用、不能执行命令，也只能发三个系统按键），
            //   只要另一种方式可用就自动换路，并把"换了路"写进结果里。
            //
            //   为什么只在"做不到"时换路：权限拒绝、参数写错、服务没开这类失败，
            //   换个后端也只是再失败一次，却会让"这次到底走的哪条路"变得不可解释 ——
            //   排查线索比多一次重试更值钱（这也是原先"选了什么就用什么"要保住的东西）。
            // ★ strict（用户在弹窗里明确选择）在上面已经**提前分流**了，走不到这里。
            //   所以这个分支只服务"没有显式选择"的场景：设置里的默认方式、
            //   或只有一条路可用时系统自动挑的那条。那种情况下"做不到就换"才是对的。
            if (accessibilityCannotDo(action, args) && moduleExecutor.available(getContext())) {
                return annotateBackendSwap(
                    runOnCommandBackend(moduleExecutor, action, args), "无障碍", moduleExecutor.label());
            }
            return runOnAccessibility(action, args, false);
        }

        ShellBackends.Executor chosen = pickCommandExecutor(preferred);
        if (chosen == null) {
            String reason = explainNoBackend(preferred);
            if (ElainaAccessibilityService.isRunning()) {
                // 命令族一个都用不了，但无障碍开着 —— 兜底走它，并说明换了路
                JSObject fallback = runOnAccessibility(action, args, false);
                fallback.put("text", reason + "\n已改用「无障碍」执行。\n" + fallback.optString("text", ""));
                return fallback;
            }
            return failure(reason);
        }

        return runOnCommandBackend(chosen, action, args);
    }

    /**
     * 按"用户选的优先，否则自动挑"选一个能执行命令的后端。
     *
     * <p>★ 2026-10 只剩两个后端。自动挑选的顺序是【无障碍 → 模块】——
     * 无障碍更安全：系统审计可见、随时可关、中文输入只有它能做，日常操作全覆盖；
     * 模块能力最强（独立副屏、后台静默）但要刷 KernelSU 模块，所以排后面。
     */
    private ShellBackends.Executor pickCommandExecutor(String preferred) {
        Context context = getContext();
        ShellBackends.Executor[] order = { moduleExecutor };
        if (!preferred.isEmpty()) {
            for (ShellBackends.Executor candidate : order) {
                if (candidate.id().equals(preferred)) {
                    return candidate.available(context) ? candidate : null;
                }
            }
            // preferred 是 accessibility 或未知值，落到自动挑选
        }
        for (ShellBackends.Executor candidate : order) {
            if (candidate.available(context)) return candidate;
        }
        return null;
    }

    private String explainNoBackend(String preferred) {
        Context context = getContext();
        if (!preferred.isEmpty()) {
            ShellBackends.Executor target = executorById(preferred);
            if (target != null) {
                return "你选的「" + target.label() + "」现在还不能用：" + target.detail(context)
                    + "\n可以点「实现方式」里的对应按钮完成配置，或换一种方式。";
            }
        }
        return "没有可用的执行后端。请在「设置 → 能力 → 手机操作」里选一种并完成配置：\n"
            + "· 无障碍：" + accessibilityStatus().optString("detail", "") + "\n"
            + "· 模块：" + moduleExecutor.detail(context);
    }

    private ShellBackends.Executor executorById(String id) {
        if (ID_MODULE.equals(id)) return moduleExecutor;
        return null;
    }

    // ---------- 命令族 ----------

    private JSObject runOnCommandBackend(ShellBackends.Executor backend, String action, String args) {
        Context context = getContext();
        File scratch = scratchDir();
        if (scratch == null) {
            return failure("拿不到可写的临时目录，没法执行需要落盘的动作（截图 / 读界面）。");
        }

        // 扩展名跟模块当前的输出格式走：`vd screenshot` / `GET /api/screenshot`
        // 现在产出的都是 JPEG。文件名只是给下游按后缀判格式用的，
        // 写成 .png 会让一段 JPEG 数据被当成 PNG 解析。
        File shot = new File(scratch, "shot.jpg");
        File dump = new File(scratch, "ui.xml");
        boolean forModuleEarly = "module".equals(backend.id());

        // 模块 0.8.0 起有三种运行模式，默认 idle；idle 下所有动作端点都 404。
        // 且模块会在会话心跳归零时自己退回 idle，所以每次动作前都要确认一次 ——
        // "启动时设一次"不够，那样的表现是"一开始能用、过一会儿全报 no focused display"。
        // 只有真要动屏幕/读界面的动作才需要；「手机状态」这类纯查询不必。
        if (forModuleEarly && phoneActionNeedsScreen(action)) {
            String modeProblem = ShellBackends.ModuleExecutor.ensureMode(context, 4000);
            if (modeProblem != null) return failure(modeProblem);
        }

        // 「手机命令」在模块后端已经没有实现：模块 0.6.0 删掉了 /api/shell，
        // 而它是这条路唯一的执行通道。不拦的话会落到下面的通用命令族，
        // 拿一句"模块网关不可用"回报 —— 用户看不出真正原因（端点没了，不是网断了）。
        if (forModuleEarly && "手机命令".equals(action)) {
            return failure("「手机命令」在模块后端已不可用：模块新版移除了 shell 直通端点（/api/shell），"
                + "这条路没有等价的替代接口。\n"
                + "需要操作手机请改用「手机点击 / 手机滑动 / 手机输入 / 手机按键 / 手机打开」，"
                + "它们走模块的 /api/action，能力等价；"
                + "确实要跑系统命令的话，只能用「无障碍」方式之外的其他手段（如电脑端命令）。");
        }

        // ── 模块后端的两条专用路径：走模块自己的 HTTP 接口，不走 vd / input 命令族 ──
        //
        // 为什么必须这样：
        //   · 截图：`vd screenshot` 实测报 `Status: -2` 失败；而模块的
        //     `GET /api/screenshot` 直接返回当前目标屏的 JPEG（守护进程持有 Surface，
        //     ~18ms / 270KB），README 明确说这条链路比 screencap 快约 40 倍。
        //   · 读界面：`GET /api/dump_ui` 是模块的正式结构化接口，语义比 vd tree 稳定。
        // 这两条都必须在**动命令之前**返回，否则会先跑一遍注定失败的命令。
        if (forModuleEarly && "手机截图".equals(action)) {
            byte[] jpeg = ShellBackends.ModuleExecutor.httpBytes(context, ShellBackends.ModuleExecutor.PATH_SCREENSHOT, timeoutFor(action));
            if (jpeg == null || jpeg.length == 0) {
                return failure("截图失败（模块）：/api/screenshot 没有返回图像。"
                    + "确认副屏在运行（设置 → 能力 → 手机操作 → 重新检测），或先执行一次「手机打开」把应用放到副屏上。");
            }
            try {
                // 写进 scratch 后复用既有的缩放/尺寸解析（它按 PNG/JPEG 自动识别）
                try (java.io.FileOutputStream out = new java.io.FileOutputStream(shot)) {
                    out.write(jpeg);
                }
                JSONObject meta = DeviceArtifacts.readScreenshot(shot);
                JSObject out = success(DeviceArtifacts.describeScreenshot(meta), backend.id());
                out.put("imageBase64", meta.optString("imageBase64", ""));
                out.put("imageMime", meta.optString("imageMime", "image/jpeg"));
                out.put("screenWidth", meta.optInt("screenWidth"));
                out.put("screenHeight", meta.optInt("screenHeight"));
                out.put("imageWidth", meta.optInt("imageWidth"));
                out.put("imageHeight", meta.optInt("imageHeight"));
                out.put("scaleX", meta.optDouble("scaleX", 1));
                out.put("scaleY", meta.optDouble("scaleY", 1));
                return out;
            } catch (Throwable error) {
                return failure("截图拿到了但处理失败：" + ShellProcess.describe(error));
            } finally {
                //noinspection ResultOfMethodCallIgnored
                shot.delete();
            }
        }
        if (forModuleEarly && "手机查看界面".equals(action)) {
            String tree = ShellBackends.ModuleExecutor.dumpUi(context, timeoutFor(action));
            if (tree == null || tree.trim().isEmpty()) {
                return failure("读取界面失败（模块）：/api/dump_ui 没有返回内容。确认副屏在运行。");
            }
            return success(tree.trim(), backend.id());
        }

        // ── 模块的动作端点：点击 / 滑动 / 输入 / 按键 / 打开 ──
        //
        // 走模块的 JSON 接口而不是 vd 命令族：参数不需要拼 shell（中文与特殊字符
        // 不会因转义出错），返回 {success,message} 能区分"执行了"与"没执行"，
        // 且能力更全（长按、精确定位输入框）。参考上游官方预设
        // AcidGr/dsp-preset-mobile-use 的做法。
        if (forModuleEarly) {
            JSObject routed = runModuleAction(context, backend, action, args, timeoutFor(action));
            if (routed != null) return routed;
        }

        // 先清掉上一次的产物：否则这次命令失败了，会读到上次的旧截图/旧界面，
        // 模型拿到的是过期界面，比直接报错还糟。
        if ("手机截图".equals(action)) {
            //noinspection ResultOfMethodCallIgnored
            shot.delete();
        }
        if ("手机查看界面".equals(action)) {
            //noinspection ResultOfMethodCallIgnored
            dump.delete();
        }

        // 模块后端要用**它自己的 vd 命令族**：模块的价值是独立虚拟副屏，
        // 通用命令族的裸 `input tap x y` 不带 -d <did> 会打到主屏，副屏收不到
        // —— 表现为"模块在跑但点了没反应"。详见 PhoneCommand.build 的 forModule 说明。
        boolean forModule = "module".equals(backend.id());
        String command = PhoneCommand.build(action, args, scratch.getAbsolutePath(), forModule);
        if (command == null) {
            return failure(explainUnbuildable(action, args));
        }

        ShellProcess.Result result = backend.run(context, command, timeoutFor(action));

        if ("手机截图".equals(action)) {
            if (!shot.isFile()) {
                return failure("截图失败（" + backend.label() + "）：" + PhoneCommand.describeResult(result, backend.label()));
            }
            try {
                JSONObject meta = DeviceArtifacts.readScreenshot(shot);
                JSObject out = success(DeviceArtifacts.describeScreenshot(meta), backend.id());
                out.put("imageBase64", meta.optString("imageBase64", ""));
                out.put("imageMime", meta.optString("imageMime", "image/jpeg"));
                out.put("screenWidth", meta.optInt("screenWidth"));
                out.put("screenHeight", meta.optInt("screenHeight"));
                out.put("imageWidth", meta.optInt("imageWidth"));
                out.put("imageHeight", meta.optInt("imageHeight"));
                out.put("scaleX", meta.optDouble("scaleX", 1));
                out.put("scaleY", meta.optDouble("scaleY", 1));
                return out;
            } catch (Throwable error) {
                return failure("截图拿到了但处理失败：" + ShellProcess.describe(error));
            } finally {
                //noinspection ResultOfMethodCallIgnored
                shot.delete();
            }
        }

        if ("手机查看界面".equals(action)) {
            // 模块后端：`vd tree` 已经把结构化控件树**直接打到 stdout**（不落盘），
            // 所以不需要 ui.xml 那一步 —— 直接用命令输出，否则会误报"读取界面失败"。
            if (forModule) {
                if (!result.ok() || result.stdout.trim().isEmpty()) {
                    return failure("读取界面失败（" + backend.label() + "）：" + PhoneCommand.describeResult(result, backend.label()));
                }
                return success(result.stdout.trim(), backend.id());
            }
            if (!dump.isFile()) {
                return failure("读取界面失败（" + backend.label() + "）：" + PhoneCommand.describeResult(result, backend.label())
                    + "\n（如果提示 uiautomator 不可用，可以改用「无障碍」后端读界面。）");
            }
            try {
                String text = DeviceArtifacts.flattenUiXml(dump);
                return success(text, backend.id());
            } finally {
                //noinspection ResultOfMethodCallIgnored
                dump.delete();
            }
        }

        String text = PhoneCommand.describeResult(result, backend.label());
        JSObject out = success(text, backend.id());
        out.put("ok", result.ok());
        return out;
    }

    /**
     * 模块后端的动作端点路由。
     *
     * <p>返回 null 表示"这个动作不归模块端点管"（调用方继续走通用命令族）。
     *
     * <p>为什么优先用端点：参数是 JSON，不用拼 shell 字符串 —— 中文、引号、{@code $}
     * 等特殊字符不会因转义出错；返回 {@code {success,message}} 能区分"执行了但没生效"
     * 与"根本没执行"；能力也更全（{@code duration_ms} 长按、{@code target} 精确定位输入框）。
     * 参考上游官方预设 AcidGr/dsh-preset-mobile-use。
     */
    private JSObject runModuleAction(Context context, ShellBackends.Executor backend, String action, String args, int timeoutMs) {
        String a = args == null ? "" : args.trim();
        try {
            switch (action) {
                case "手机点击": {
                    int[] p = PhoneCommand.parseInts(a, 2);
                    if (p == null) return null;   // 参数不对 → 交给通用分支报错
                    JSONObject body = new JSONObject();
                    body.put("action", ShellBackends.ModuleExecutor.ACTION_CLICK);
                    body.put("coordinate", new JSONArray().put(p[0]).put(p[1]));
                    // 第 3 个参数是可选长按毫秒（与「手机滑动」的第 5 参数约定一致）
                    String[] parts = a.split("\\s+");
                    if (parts.length >= 3) {
                        try {
                            int ms = Integer.parseInt(parts[2]);
                            if (ms > 0) body.put("duration_ms", Math.min(10_000, ms));
                        } catch (NumberFormatException ignored) { /* 没给就不长按 */ }
                    }
                    JSONObject json = ShellBackends.ModuleExecutor.post(context, ShellBackends.ModuleExecutor.PATH_ACTION, body, timeoutMs);
                    if (json == null) return null;   // 端点不通 → 兜底走命令族
                    if (!ShellBackends.ModuleExecutor.isSuccess(json)) {
                        return failure("点击失败（模块）：" + ShellBackends.ModuleExecutor.describe(json));
                    }
                    JSObject out = success("已在副屏点击 (" + p[0] + ", " + p[1] + ")。", backend.id());
                    out.put("ok", true);
                    return out;
                }
                case "手机滑动": {
                    int[] p = PhoneCommand.parseInts(a, 4);
                    if (p == null) return null;
                    JSONObject body = new JSONObject();
                    body.put("action", ShellBackends.ModuleExecutor.ACTION_SWIPE);
                    body.put("coordinate", new JSONArray().put(p[0]).put(p[1]));
                    body.put("end_coordinate", new JSONArray().put(p[2]).put(p[3]));
                    String[] parts = a.split("\\s+");
                    if (parts.length >= 5) {
                        try {
                            body.put("duration_ms", Math.max(40, Math.min(8000, Integer.parseInt(parts[4]))));
                        } catch (NumberFormatException ignored) { /* 用模块默认 */ }
                    }
                    JSONObject json = ShellBackends.ModuleExecutor.post(context, ShellBackends.ModuleExecutor.PATH_ACTION, body, timeoutMs);
                    if (json == null) return null;
                    if (!ShellBackends.ModuleExecutor.isSuccess(json)) {
                        return failure("滑动失败（模块）：" + ShellBackends.ModuleExecutor.describe(json));
                    }
                    JSObject out = success("已在副屏滑动 (" + p[0] + "," + p[1] + ") → (" + p[2] + "," + p[3] + ")。", backend.id());
                    out.put("ok", true);
                    return out;
                }
                case "手机输入": {
                    if (a.isEmpty()) return null;
                    JSONObject body = new JSONObject();
                    body.put("action", ShellBackends.ModuleExecutor.ACTION_SET_VALUE);
                    body.put("text", a);
                    // target=focused → 模块自己找当前聚焦的输入框，不猜坐标、不动剪贴板。
                    // 不自动回车（避免在聊天类应用里误发送）。
                    body.put("target", "focused");
                    JSONObject json = ShellBackends.ModuleExecutor.post(context, ShellBackends.ModuleExecutor.PATH_ACTION, body, timeoutMs);
                    if (json == null) return null;
                    if (!ShellBackends.ModuleExecutor.isSuccess(json)) {
                        // 模块的 set_value 有明确失败分类（no_focused_input / target_not_found …），原样透出
                        return failure("输入失败（模块）：" + ShellBackends.ModuleExecutor.describe(json)
                            + "\n（请先用「手机查看界面」确认有聚焦的输入框，或用「手机点击」先点中输入框。）");
                    }
                    JSObject out = success("已向副屏输入文字（" + a.length() + " 字）。", backend.id());
                    out.put("ok", true);
                    return out;
                }
                case "手机按键": {
                    Integer code = PhoneCommand.keyCodeFor(a);
                    if (code == null) return null;
                    JSONObject body = new JSONObject();
                    body.put("action", ShellBackends.ModuleExecutor.ACTION_KEY);
                    body.put("key", String.valueOf(code));
                    JSONObject json = ShellBackends.ModuleExecutor.post(context, ShellBackends.ModuleExecutor.PATH_ACTION, body, timeoutMs);
                    if (json == null) return null;
                    if (!ShellBackends.ModuleExecutor.isSuccess(json)) {
                        return failure("按键失败（模块）：" + ShellBackends.ModuleExecutor.describe(json));
                    }
                    JSObject out = success("已向副屏发送按键「" + a + "」。", backend.id());
                    out.put("ok", true);
                    return out;
                }
                case "手机打开": {
                    if (a.isEmpty()) return null;
                    JSONObject body = new JSONObject();
                    body.put("action", ShellBackends.ModuleExecutor.ACTION_LAUNCH);
                    if (a.contains("/")) {
                        // 形如 com.pkg/.Activity → 拆成 package + activity
                        int slash = a.indexOf('/');
                        body.put("package", a.substring(0, slash));
                        body.put("activity", a.substring(slash + 1));
                    } else {
                        body.put("package", a);
                    }
                    JSONObject json = ShellBackends.ModuleExecutor.post(context, ShellBackends.ModuleExecutor.PATH_ACTION, body, timeoutMs);
                    if (json == null) return null;
                    if (!ShellBackends.ModuleExecutor.isSuccess(json)) {
                        return failure("启动失败（模块）：" + ShellBackends.ModuleExecutor.describe(json));
                    }
                    JSObject out = success("已在副屏启动 " + a + "。", backend.id());
                    out.put("ok", true);
                    return out;
                }
                default:
                    return null;
            }
        } catch (Throwable error) {
            // 端点调用出任何意外都退回通用命令族 —— 不能因为一条路坏了就整个动作失败
            android.util.Log.w(TAG, "模块端点调用异常，回退命令族：" + ShellProcess.describe(error));
            return null;
        }
    }

    private String explainUnbuildable(String action, String args) {
        switch (action) {
            case "手机点击":
                return "「手机点击」需要两个坐标，写法是「手机点击 x y」。现在是：「" + args + "」";
            case "手机滑动":
                return "「手机滑动」需要四个坐标，写法是「手机滑动 x1 y1 x2 y2 [时长]」。现在是：「" + args + "」";
            case "手机按键":
                return "认不出这个键名：「" + args + "」。\n" + PhoneCommand.KEY_HELP;
            case "手机打开":
                return "「手机打开」需要包名，比如「手机打开 com.tencent.mm」。";
            case "手机输入":
                return "这条输入内容没法用命令方式发出去。命令族的 input text 只认 ASCII；"
                    + "要在任意输入框里输中文，需要开启「无障碍」方式（设置 → 无障碍 → ElainaChat Mod 手机操作）。";
            default:
                return "「" + action + "」的用法不正确。";
        }
    }

    private static int timeoutFor(String action) {
        switch (action) {
            case "手机截图": return TIMEOUT_SCREENSHOT;
            case "手机查看界面": return TIMEOUT_UI_DUMP;
            case "手机命令": return TIMEOUT_SHELL;
            default: return TIMEOUT_DEFAULT;
        }
    }

    /**
     * 这个动作是否**需要先让模块从 idle 醒过来**。
     *
     * <p>模块 0.8.0 的 idle 表示"没有聚焦的屏（display -1）"，此时
     * {@code /api/action}、{@code /api/dump_ui}、{@code /api/screenshot}
     * 一律拒绝。纯查询类动作（手机状态、读短信/通讯录/日历/文件）不经过副屏，
     * 不必为了它们去拉起一个副屏 —— 那会让"只想看一眼设备信息"变成一次开机。
     */
    private static boolean phoneActionNeedsScreen(String action) {
        switch (action) {
            case "手机查看界面":
            case "手机截图":
            case "手机点击":
            case "手机滑动":
            case "手机输入":
            case "手机按键":
            case "手机打开":
            case "手机等待":
                return true;
            default:
                return false;
        }
    }

    /**
     * 无障碍方式**做不到**的动作 —— 能力边界，与"没配置 / 没授权 / 参数错"是两回事。
     *
     * <p>这是「模块 ↔ 无障碍互通」的判据：只有这些动作才值得自动换到模块去。
     * 其它失败（权限被拒、服务没开、参数写错）换个后端同样做不成，
     * 换过去只会掩盖真正的原因。
     */
    private static boolean accessibilityCannotDo(String action, String args) {
        switch (action) {
            case "手机命令":   // 任意命令：无障碍后端根本不执行命令
                return true;
            case "手机按键":
                // 只有 返回(4) / 主页(3) / 最近任务(187) 能发，其余按键得走命令族
                if (args.trim().toLowerCase(java.util.Locale.ROOT).startsWith("id:")) return false;
                Integer code = PhoneCommand.keyCode(args);
                return code == null || !(code == 4 || code == 3 || code == 187);
            default:
                return false;
        }
    }

    /**
     * 换路后给结果加一句「这一步实际由谁完成」。
     *
     * <p>为什么必须写进返回值：用户选的是 A、实际走的是 B，结果里不标注的话，
     * 出问题根本没法判断走的是哪条路 —— 那正是原先「用户选了什么就用什么」
     * 想保住的可排查性。换路也失败时**不加这句**（如实报失败，不硬说"已改用"）。
     */
    private static JSObject annotateBackendSwap(JSObject out, String fromLabel, String toLabel) {
        if (!out.optBoolean("ok", false)) return out;
        out.put("text", "（「" + fromLabel + "」做不到这个动作，本次已自动改用「" + toLabel + "」完成。）\n"
            + out.optString("text", ""));
        return out;
    }

    // ---------- 无障碍 ----------

    private JSObject runOnAccessibility(String action, String args, boolean chineseInputOverride) {
        ElainaAccessibilityService service = ElainaAccessibilityService.get();
        if (service == null || !ElainaAccessibilityService.isRunning()) {
            return failure("无障碍服务没在运行。请到 系统设置 → 无障碍 → ElainaChat Mod 手机操作 里打开它。");
        }

        String note = chineseInputOverride ? "（中文输入走无障碍，命令族的 input text 不支持非 ASCII）\n" : "";
        try {
            switch (action) {
                case "手机查看界面":
                    return success(service.dumpUiTree(), ID_ACCESSIBILITY);
                case "手机状态": {
                    String text = "当前实现方式：无障碍\n"
                        + "设备：" + Build.MODEL + "（Android " + Build.VERSION.RELEASE + "，API " + Build.VERSION.SDK_INT + "）\n"
                        + "屏幕：" + screenSizeText() + "\n"
                        + "无障碍服务：运行中\n"
                        + "截图能力：" + (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? "可用" : "不可用（需要 Android 11+）");
                    return success(text, ID_ACCESSIBILITY);
                }
                case "手机截图": {
                    String[] failure = new String[1];
                    JSONObject meta = service.screenshot(failure);
                    if (meta == null) return failure(failure[0] == null ? "截图失败。" : failure[0]);
                    JSObject out = success(DeviceArtifacts.describeScreenshot(meta), ID_ACCESSIBILITY);
                    out.put("imageBase64", meta.optString("imageBase64", ""));
                    out.put("imageMime", meta.optString("imageMime", "image/jpeg"));
                    out.put("screenWidth", meta.optInt("screenWidth"));
                    out.put("screenHeight", meta.optInt("screenHeight"));
                    out.put("imageWidth", meta.optInt("imageWidth"));
                    out.put("imageHeight", meta.optInt("imageHeight"));
                    out.put("scaleX", meta.optDouble("scaleX", 1));
                    out.put("scaleY", meta.optDouble("scaleY", 1));
                    return out;
                }
                case "手机点击": {
                    int[] p = PhoneCommand.ints(args, 2);
                    if (p == null) return failure(explainUnbuildable(action, args));
                    return success(note + service.tap(p[0], p[1]), ID_ACCESSIBILITY);
                }
                case "手机滑动": {
                    int[] p = PhoneCommand.ints(args, 4);
                    if (p == null) return failure(explainUnbuildable(action, args));
                    int duration = 300;
                    String[] parts = args.trim().split("\\s+");
                    if (parts.length >= 5) {
                        try {
                            duration = Math.max(40, Math.min(8000, Integer.parseInt(parts[4])));
                        } catch (NumberFormatException ignored) {
                            // 用默认时长
                        }
                    }
                    return success(service.swipe(p[0], p[1], p[2], p[3], duration), ID_ACCESSIBILITY);
                }
                case "手机输入":
                    return success(note + service.type(args), ID_ACCESSIBILITY);
                case "手机按键": {
                    String key = args.trim().toLowerCase(java.util.Locale.ROOT);
                    if (key.startsWith("id:")) {
                        return success(service.clickById(args.trim().substring(3)), ID_ACCESSIBILITY);
                    }
                    Integer code = PhoneCommand.keyCode(args);
                    if (code == null) return failure(explainUnbuildable(action, args));
                    if (code == 4) return success(service.back(), ID_ACCESSIBILITY);
                    if (code == 3) return success(service.home(), ID_ACCESSIBILITY);
                    if (code == 187) return success(service.recents(), ID_ACCESSIBILITY);
                    // 其余按键无障碍不好模拟，交给命令族（只有模块后端能走）
                    return failure("无障碍方式只能发送「返回 / 主页 / 最近任务」三个系统按键。"
                        + "要发其它按键，请改用「模块」方式。");
                }
                // 无障碍点不了别人应用里的按钮，但「启动一个应用」不需要任何特殊权限 —— 系统的启动 intent 就够。
                // 以前这条判死，结果 AI 走偏到别的应用之后再也回不到目标应用，只能等用户在桌面上点图标救场。
                case "手机打开": {
                    String pkg = args == null ? "" : args.trim();
                    if (pkg.isEmpty()) return failure("「手机打开」需要包名，例如 [操作:手机打开 com.tencent.mm]。");
                    Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
                    if (launch == null) return failure("这个包名没有可启动的界面（没装，或者是系统组件）：" + pkg);
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
                    getContext().startActivity(launch);
                    return success("已启动 " + pkg + "。", ID_ACCESSIBILITY);
                }
                case "手机命令":
                    // 无障碍后端不能执行任意命令 —— 这是能力边界，不是 bug
                    return failure("无障碍（前台运行）不支持执行任意命令（这是它和「模块」方式的主要差别）。"
                        + "需要执行命令，就请用户重新选择「后台运行（模块）」。");
                default:
                    return failure("无障碍方式不支持「" + action + "」。");
            }
        } catch (Throwable error) {
            return failure("无障碍执行失败：" + ShellProcess.describe(error));
        }
    }

    private static String screenSizeText() {
        try {
            android.util.DisplayMetrics metrics = android.content.res.Resources.getSystem().getDisplayMetrics();
            return metrics.widthPixels + " × " + metrics.heightPixels + "（密度 " + metrics.densityDpi + "）";
        } catch (Throwable error) {
            return "未知";
        }
    }

    // ==================== 授权 / 跳转 ====================

    /** 跳到系统的无障碍设置页。 */
    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        JSObject out = new JSObject();
        try {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            out.put("ok", true);
            out.put("text", "已打开系统的无障碍设置。在列表里找到「ElainaChat Mod 手机操作」并打开开关。");
        } catch (Throwable error) {
            out.put("ok", false);
            out.put("text", "打不开无障碍设置页：" + ShellProcess.describe(error)
                + "\n可以手动进：设置 → 无障碍（部分机型叫「辅助功能」）。");
        }
        call.resolve(out);
    }

    /** 跳到本应用的详情页（权限设置兜底）。 */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        JSObject out = new JSObject();
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            out.put("ok", true);
            out.put("text", "已打开本应用的应用信息页。");
        } catch (Throwable error) {
            out.put("ok", false);
            out.put("text", "打不开应用信息页：" + ShellProcess.describe(error));
        }
        call.resolve(out);
    }

    /** 改模块网关地址（模块作者可能改端口）。 */
    @PluginMethod
    public void setGateway(PluginCall call) {
        String value = call.getString("url", "").trim();
        if (value.isEmpty()) {
            call.reject("缺少 url 参数");
            return;
        }
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            call.reject("网关地址要以 http:// 或 https:// 开头");
            return;
        }
        ShellBackends.ModuleExecutor.setGateway(getContext(), value);
        JSObject out = new JSObject();
        out.put("ok", true);
        out.put("text", "模块网关已改为 " + value);
        call.resolve(out);
    }

    /** 跳到指定应用（给"启动应用"的兜底用）。 */
    @PluginMethod
    public void launchApp(PluginCall call) {
        String pkg = call.getString("package", "").trim();
        JSObject out = new JSObject();
        if (pkg.isEmpty()) {
            call.reject("缺少 package 参数");
            return;
        }
        try {
            Intent intent = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
            if (intent == null) {
                out.put("ok", false);
                out.put("text", "没找到包名为 " + pkg + " 的应用。");
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                out.put("ok", true);
                out.put("text", "已启动 " + pkg);
            }
        } catch (Throwable error) {
            out.put("ok", false);
            out.put("text", "启动失败：" + ShellProcess.describe(error));
        }
        call.resolve(out);
    }

    // ==================== 悬浮窗（AI 操作手机时的系统级浮层） ====================

    /**
     * 悬浮窗权限是否已授予。
     *
     * <p>这个权限不是运行时权限对话框，而是系统设置里的开关（「显示在其他应用上层」），
     * 所以前端必须先查这个再决定要不要引导用户去开。
     */
    @PluginMethod
    public void overlayStatus(PluginCall call) {
        JSObject out = new JSObject();
        out.put("canDraw", ElainaOverlay.canDraw(getContext()));
        out.put("showing", ElainaOverlay.isShowing());
        call.resolve(out);
    }

    /** 跳到系统设置里的悬浮窗授权页（应用无法直接弹框索取这个权限） */
    @PluginMethod
    public void requestOverlay(PluginCall call) {
        ElainaOverlay.requestPermission(getContext());
        JSObject out = new JSObject();
        out.put("ok", true);
        out.put("text", "已打开系统设置，请打开「显示在其他应用上层」后返回。");
        call.resolve(out);
    }

    /**
     * 显示悬浮窗。AI 开始操作手机时调一次即可。
     *
     * <p>浮层上常驻「停止」按钮 —— 这是"不用切回应用就能停"的实现。
     */
    @PluginMethod
    public void showOverlay(PluginCall call) {
        String text = call.getString("text", "AI 正在操作手机");
        if (!ElainaOverlay.canDraw(getContext())) {
            JSObject out = new JSObject();
            out.put("ok", false);
            out.put("needPermission", true);
            out.put("text", "还没有悬浮窗权限，请在系统设置里打开「显示在其他应用上层」。");
            call.resolve(out);
            return;
        }
        // 用户点悬浮窗上的「停止」→ 通知前端（前端收到后中止后续步骤）
        ElainaOverlay.show(getContext(), text, () -> {
            JSObject data = new JSObject();
            data.put("reason", "overlay");
            notifyListeners("overlayStop", data);
        });
        JSObject out = new JSObject();
        out.put("ok", true);
        out.put("text", "悬浮窗已显示");
        call.resolve(out);
    }

    /** 更新浮层上的步骤文字 */
    @PluginMethod
    public void updateOverlay(PluginCall call) {
        ElainaOverlay.updateStep(call.getString("text", ""));
        JSObject out = new JSObject();
        out.put("ok", true);
        call.resolve(out);
    }

    /**
     * 在悬浮窗上就地请求确认 —— **这是打破"每步都要切回应用点允许"死循环的关键**。
     *
     * <p>浮层直接出现「允许 / 拒绝」，用户在**目标 App 的界面上**就能点，
     * 不需要切回 ElainaChat，也就不会把目标 App 切到后台导致那次点击失败。
     *
     * <p>返回值由 notifyListeners 异步送出：{@code overlayApproval { allowed: true/false }}。
     */
    @PluginMethod
    public void askOverlayApproval(PluginCall call) {
        String action = call.getString("action", "");
        if (!ElainaOverlay.isShowing()) {
            // 没浮层（没权限 / 已收起）→ 明确告诉前端"这条路走不通"，
            // 让它回退到应用内弹窗，而不是静默卡住。
            JSObject out = new JSObject();
            out.put("ok", false);
            out.put("fallback", true);
            out.put("text", "悬浮窗不可用");
            call.resolve(out);
            return;
        }
        ElainaOverlay.askApproval(action,
                () -> {
                    JSObject data = new JSObject();
                    data.put("allowed", true);
                    data.put("action", action);
                    notifyListeners("overlayApproval", data);
                },
                () -> {
                    JSObject data = new JSObject();
                    data.put("allowed", false);
                    data.put("action", action);
                    notifyListeners("overlayApproval", data);
                });
        JSObject out = new JSObject();
        out.put("ok", true);
        call.resolve(out);
    }

    /** 收起悬浮窗。一次运行结束、用户停止、或总开关关掉时调用。 */
    @PluginMethod
    public void hideOverlay(PluginCall call) {
        ElainaOverlay.hide();
        JSObject out = new JSObject();
        out.put("ok", true);
        call.resolve(out);
    }

    // ==================== 副屏监视（应用内查看 AI 在副屏做什么） ====================

    /**
     * 取模块副屏的当前帧（base64 JPEG）。
     *
     * <p>为什么需要它：模块自己有个 3070 网页面板，但要跳到浏览器才能看 ——
     * 用户在应用里指挥 AI 操作手机时，视线不该被切走。这个方法让前端能在
     * **应用内的监视窗**里实时看到副屏画面，知道 AI 正在点哪里、界面变成了什么样。
     *
     * <p>直接复用模块的 {@code GET /api/screenshot}（守护进程持有副屏 Surface，
     * 编 JPEG 约 18ms），不做二次缩放 —— 前端按需显示即可。
     */
    @PluginMethod
    public void liveFrame(PluginCall call) {
        JSObject out = new JSObject();
        Context context = getContext();
        // 用 probe() 判断网关在不在（available() 是实例方法，这里没有实例）
        if (ShellBackends.ModuleExecutor.probe(context) == null) {
            out.put("ok", false);
            out.put("reason", "module-unavailable");
            out.put("text", "模块副屏不可用（没刷模块，或 vd_server 没在跑）。");
            call.resolve(out);
            return;
        }
        int timeoutMs = 8000;
        byte[] jpeg = ShellBackends.ModuleExecutor.httpBytes(
            context, ShellBackends.ModuleExecutor.PATH_SCREENSHOT, timeoutMs);
        if (jpeg == null || jpeg.length == 0) {
            out.put("ok", false);
            out.put("reason", "no-frame");
            out.put("text", "副屏暂时没有画面（守护进程未运行或尚未出帧）。");
            call.resolve(out);
            return;
        }
        out.put("ok", true);
        out.put("imageBase64", android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP));
        out.put("mime", "image/jpeg");
        out.put("bytes", jpeg.length);
        // 说明：模块的 /api/screenshot 优先返回守护进程**缓存的帧**（用缓存换速度：
        // 271KB/18ms vs screencap 的 2.9MB/1.8s）。缓存只在画面变化时刷新，
        // 所以刚启动应用后的极短时间内可能仍是旧帧 —— 前端靠 1.5s 的自动刷新
        // 自然追上新画面即可，不必在这里读缓存时间戳
        //（/data/local/tmp 是 root 目录，应用读不到它的 mtime，读了也只会误报）。
        // 顺带带上副屏状态，前端可以显示「Display 3 · 900×1600」
        JSONObject status = ShellBackends.ModuleExecutor.probe(context);
        if (status != null) {
            out.put("displayId", status.optInt("display_id", -1));
            out.put("width", status.optInt("width", 0));
            out.put("height", status.optInt("height", 0));
            out.put("status", status.optString("status", ""));
        }
        call.resolve(out);
    }

    /** 模块自带的网页面板地址（想看得更全时的兜底入口） */
    @PluginMethod
    public void modulePanelUrl(PluginCall call) {
        JSObject out = new JSObject();
        out.put("ok", true);
        out.put("url", ShellBackends.ModuleExecutor.gateway(getContext()) + "/");
        call.resolve(out);
    }

    /** 副屏开关：供监视窗里的「启动副屏 / 关闭副屏」按钮用 */
    @PluginMethod
    public void moduleDisplay(PluginCall call) {
        String op = call.getString("op", "start");
        JSObject out = new JSObject();
        Context context = getContext();
        String path = "stop".equals(op) ? "/api/stop" : "/api/start";
        String raw = ShellBackends.ModuleExecutor.postRaw(context, path, null, 20_000);
        if (raw == null) {
            out.put("ok", false);
            out.put("text", "模块网关没有响应。");
            call.resolve(out);
            return;
        }
        out.put("ok", true);
        out.put("text", "已请求" + ("stop".equals(op) ? "关闭" : "启动") + "副屏。");
        JSONObject status = ShellBackends.ModuleExecutor.probe(context);
        if (status != null) out.put("status", status.optString("status", ""));
        call.resolve(out);
    }

    // ==================== 读取类权限与工作区（★ 2026-10 新增） ====================

    /**
     * 报告读取类能力的**系统层**权限现状。
     *
     * <p>与设置里的隐私开关是两回事：那是"应用层允不允许"，这是"系统层给没给"。
     * 两个都满足 AI 才真能读到东西，所以设置页要分别显示。
     */
    @PluginMethod
    public void readPermissionStatus(PluginCall call) {
        JSObject out = new JSObject();
        try {
            out.put("ok", true);
            out.put("permissions", infoReader == null ? new JSObject() : infoReader.permissionStatus());
            out.put("folderUri", AgentWorkspace.authorizedFolderUri(getContext()));
            out.put("folderName", AgentWorkspace.authorizedFolderName(getContext()));
            out.put("workspaceFiles", AgentWorkspace.workspaceFileCount(getContext()));
        } catch (Throwable error) {
            out.put("ok", false);
            out.put("text", "读取权限状态失败：" + ShellProcess.describe(error));
        }
        call.resolve(out);
    }

    /**
     * 申请读取类权限。
     *
     * <p>参数 {@code kind}: {@code sms} | {@code contacts} | {@code calendar}。
     * 短信/通讯录/日历都是 Android 的**危险权限**，必须由用户在系统弹框里同意。
     *
     * <p>为什么不让应用启动时就申请：用户还没用到那个功能时弹一堆权限框，
     * 只会让人反感并一律拒绝 —— 那时再想申请就难了（系统可能不再弹框）。
     * 所以一律由用户在设置页主动点。
     */
    @PluginMethod
    public void requestReadPermission(PluginCall call) {
        String kind = String.valueOf(call.getString("kind", "")).trim();
        if (!kind.equals("sms") && !kind.equals("contacts") && !kind.equals("calendar")) {
            call.reject("不支持的权限类型：" + kind);
            return;
        }
        // Capacitor 的 requestPermissionForAlias 会在回调里告诉我们结果
        requestPermissionForAlias(kind, call, "readPermissionCallback");
    }

    @PermissionCallback
    private void readPermissionCallback(PluginCall call) {
        JSObject out = new JSObject();
        try {
            out.put("ok", true);
            out.put("permissions", infoReader == null ? new JSObject() : infoReader.permissionStatus());
        } catch (Throwable error) {
            out.put("ok", false);
            out.put("text", "读取权限状态失败：" + ShellProcess.describe(error));
        }
        call.resolve(out);
    }

    /**
     * 跳到系统的「通知使用权」设置页。
     *
     * <p>通知读取**不是**运行时权限 —— 它是系统设置里的一个开关，应用无法弹框索取，
     * 只能把用户送到那一页让他自己打开。这是 Android 的设计。
     */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        JSObject out = new JSObject();
        try {
            Intent intent = new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            out.put("ok", true);
            out.put("text", "已打开「通知使用权」设置页。在列表里找到「ElainaChat Mod」并打开开关。");
        } catch (Throwable error) {
            out.put("ok", false);
            out.put("text", "打不开通知设置页：" + ShellProcess.describe(error)
                + "\n可以手动进：设置 → 通知 → 通知使用权（部分机型在「特殊应用权限」里）。");
        }
        call.resolve(out);
    }

    /**
     * 电池优化白名单现状。
     *
     * <p>为什么需要它：定时任务靠应用内的轮询触发，进程被省电策略掐掉就没人叫醒它。
     * 用户能看到"任务没来"，但看不到原因 —— 只有系统知道本应用在不在白名单里，
     * 所以这一项必须问原生，前端不能猜。
     *
     * <p>{@code batteryUnrestricted} 为 {@code true} 表示已豁免（系统不会因省电杀本应用）。
     * 查询本身在极老的系统上可能抛错，那种情况回 {@code ok:false} 让前端显示「无法检测」，
     * 而不是冒充"未授权"把用户引去一个改不了的开关。
     */
    @PluginMethod
    public void powerStatus(PluginCall call) {
        JSObject out = new JSObject();
        try {
            android.os.PowerManager pm =
                (android.os.PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            boolean exempt = pm != null
                && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
            out.put("ok", true);
            out.put("batteryUnrestricted", exempt);
        } catch (Throwable error) {
            out.put("ok", false);
            out.put("text", "读取电池优化状态失败：" + ShellProcess.describe(error));
        }
        call.resolve(out);
    }

    /**
     * 申请电池优化白名单。
     *
     * <p>这条走 {@code ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS}：系统会弹一个
     * 「允许应用在后台不受限制」的确认框，用户点允许即可。它要求清单里声明
     * {@code REQUEST_IGNORE_BATTERY_OPTIMIZATIONS}（已声明）。
     *
     * <p>弹框失败（部分厂商把它改成跳列表页）时回退到 {@code ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS}，
     * 让用户在列表里自己找 —— 直接报"打不开"会让人无从下手。
     */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        JSObject out = new JSObject();
        Context context = getContext();
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            out.put("ok", true);
            out.put("text", "已弹出「不受电池优化限制」的确认框，点「允许」即可。");
        } catch (Throwable error) {
            try {
                Intent fallback = new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(fallback);
                out.put("ok", true);
                out.put("text", "已打开「电池优化」列表。在「未优化 / 不限制」里找到「ElainaChat Mod」并加入白名单。");
            } catch (Throwable second) {
                out.put("ok", false);
                out.put("text", "打不开电池优化设置：" + ShellProcess.describe(second)
                    + "\n可以手动进：设置 → 电池 → 电池优化 → 找到本应用 → 不优化。");
            }
        }
        call.resolve(out);
    }

    /**
     * 跳到厂商的「自启动管理」页。
     *
     * <p>自启动**没有任何公开 API**：能不能被系统拉起由各厂商的自启动白名单决定，
     * 既无法查询也无法申请，只能把用户送到那一页。所以这里逐个尝试常见厂商的
     * 组件名，全失败就退到应用详情页并给出各家的手动路径。
     *
     * <p>跳过去时用 {@code FLAG_ACTIVITY_NEW_TASK}：这些页面属于别的应用（手机管家），
     * 从本应用的 Activity 上下文启动必须带这个标志。
     */
    @PluginMethod
    public void openAutostartSettings(PluginCall call) {
        JSObject out = new JSObject();
        Context context = getContext();
        String[][] candidates = {
            {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
            {"com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
            {"com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
            {"com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
            {"com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"},
            {"com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
            {"com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"},
            {"com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"},
            {"com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"},
            {"com.meizu.safe", "com.meizu.safe.security.SHOW_APPSEC"},
        };
        for (String[] pair : candidates) {
            try {
                Intent intent = new Intent();
                intent.setComponent(new android.content.ComponentName(pair[0], pair[1]));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
                out.put("ok", true);
                out.put("text", "已打开本机「自启动管理」页。在列表里找到「ElainaChat Mod」并允许自启动。");
                call.resolve(out);
                return;
            } catch (Throwable ignored) {
                // 不是这个厂商 / 该机型没这个页面：继续试下一个
            }
        }
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            out.put("ok", false);
            out.put("text", "没找到本机的自启动管理页，已打开应用信息页。\n"
                + "自启动一般在手机管家里：小米「应用管理 → 自启动」、华为「应用启动管理」、"
                + "OPPO / vivo「自启动管理」、三星「电池 → 后台使用限制」。");
        } catch (Throwable error) {
            out.put("ok", false);
            out.put("text", "打不开自启动设置页：" + ShellProcess.describe(error)
                + "\n请在手机管家里找到「自启动管理」，允许「ElainaChat Mod」自启动。");
        }
        call.resolve(out);
    }

    /**
     * 让用户选一个文件夹授权给 AI（系统文件选择器）。
     *
     * <p>用 {@code ACTION_OPEN_DOCUMENT_TREE}：它返回一个"目录树"URI，
     * 配合 {@code takePersistableUriPermission} 就能**持久**访问
     * （重启应用仍有效），这是 SAF 的标准做法。
     */
    @PluginMethod
    public void pickAgentFolder(PluginCall call) {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            startActivityForResult(call, intent, "pickAgentFolderResult");
        } catch (Throwable error) {
            JSObject out = new JSObject();
            out.put("ok", false);
            out.put("text", "打不开文件选择器：" + ShellProcess.describe(error));
            call.resolve(out);
        }
    }

    @ActivityCallback
    private void pickAgentFolderResult(PluginCall call, ActivityResult result) {
        JSObject out = new JSObject();
        if (call == null) return;
        try {
            if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
                out.put("ok", false);
                out.put("cancelled", true);
                out.put("text", "没有选择文件夹。");
                call.resolve(out);
                return;
            }
            Uri uri = result.getData().getData();
            if (uri == null) {
                out.put("ok", false);
                out.put("text", "系统没有返回文件夹地址。");
                call.resolve(out);
                return;
            }
            // ★ 这一步是关键：不取持久化授权的话，重启应用后这个 URI 就失效了，
            //   用户会看到"明明授权过却读不到"。
            try {
                getContext().getContentResolver().takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Throwable error) {
                // 某些 ROM 上不支持持久化，此时仍可用（只是重启后失效）—— 如实说明
                out.put("persistent", false);
            }
            String name = folderDisplayName(uri);
            AgentWorkspace.saveAuthorizedFolder(getContext(), uri, name);
            out.put("ok", true);
            out.put("folderUri", uri.toString());
            out.put("folderName", name);
            out.put("text", "已授权文件夹：" + name + "。AI 现在可以读写这个文件夹里的文件了。");
        } catch (Throwable error) {
            out.put("ok", false);
            out.put("text", "保存文件夹授权失败：" + ShellProcess.describe(error));
        }
        call.resolve(out);
    }

    /** 取消文件夹授权。取消后 AI 立刻读不到那个文件夹。 */
    @PluginMethod
    public void clearAgentFolder(PluginCall call) {
        JSObject out = new JSObject();
        try {
            String raw = AgentWorkspace.authorizedFolderUri(getContext());
            if (raw != null && !raw.isEmpty()) {
                try {
                    getContext().getContentResolver().releasePersistableUriPermission(
                        Uri.parse(raw),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                } catch (Throwable error) {
                    // 释放失败不影响清除本地记录
                }
            }
            AgentWorkspace.clearAuthorizedFolder(getContext());
            out.put("ok", true);
            out.put("text", "已取消文件夹授权。");
        } catch (Throwable error) {
            out.put("ok", false);
            out.put("text", "取消授权失败：" + ShellProcess.describe(error));
        }
        call.resolve(out);
    }

    /** 从 SAF 的树 URI 里取一个能显示的名字 */
    private String folderDisplayName(Uri uri) {
        try {
            String docId = android.provider.DocumentsContract.getTreeDocumentId(uri);
            // docId 形如 "primary:Download/子目录"，取最后一段当地名
            int colon = docId.indexOf(':');
            String tail = colon >= 0 ? docId.substring(colon + 1) : docId;
            int slash = tail.lastIndexOf('/');
            String name = slash >= 0 ? tail.substring(slash + 1) : tail;
            return name.isEmpty() ? "已授权文件夹" : name;
        } catch (Throwable error) {
            return "已授权文件夹";
        }
    }

    // ==================== 工具 ====================

    private File scratchDir() {
        try {
            File dir = getContext().getExternalFilesDir(null);
            if (dir == null) dir = getContext().getFilesDir();
            if (dir == null) return null;
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            return dir;
        } catch (Throwable error) {
            return null;
        }
    }

    private static JSObject success(String text, String backend) {
        JSObject out = new JSObject();
        out.put("ok", true);
        out.put("text", text);
        out.put("backend", backend);
        return out;
    }

    private static JSObject failure(String text) {
        JSObject out = new JSObject();
        out.put("ok", false);
        out.put("text", text);
        return out;
    }
}
