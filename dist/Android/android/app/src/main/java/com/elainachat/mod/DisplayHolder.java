package com.elainachat.mod;

import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.SystemClock;
import android.view.Surface;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 后台副屏的公共引擎 —— Shizuku 的 UserService 与 Root 的 app_process holder 共用。
 *
 * <p>为什么必须是一个**常驻进程**：虚拟屏属于创建它的进程，进程一退屏就没了。
 * 所以建屏不能是一次性命令（{@code am} 那种），必须由 holder 持有，直到 {@link #destroy()}。
 *
 * <p>为什么用 {@link ImageReader} 抓帧而不是 {@code screencap -d}：
 * {@code screencap} 认的是 SurfaceFlinger 的**物理** display id，虚拟屏没有物理 id，
 * 传逻辑 id 过去只会抓到主屏或什么都抓不到。唯一能读虚拟屏像素的进程是持有它 Surface 的进程。
 *
 * <p>为什么所有动作用 {@code input -d <id>} / {@code am start --display <id>}：
 * 这两条是 shell 与 root 都有、且实测能定向到虚拟屏的路径；直接调 InputManager 的隐藏 API
 * 也能做，但要多一层反射且随版本漂移，收益只有几十毫秒。
 */
final class DisplayHolder {

    private static final String TAG = "ElainaDisplayHolder";
    /** 虚拟屏名字前缀：用来在 dumpsys 里认出哪些屏是自己建的。 */
    static final String NAME_PREFIX = "elaina-vd-";

    // 虚拟屏 flags
    //
    // 只有 PUBLIC / PRESENTATION / SECURE / OWN_CONTENT_ONLY / AUTO_MIRROR 是公开常量；
    // 下面这些在 AOSP 里是 @hide，SDK 桩里没有，写 DisplayManager.VIRTUAL_DISPLAY_FLAG_XXX 会编译失败。
    // 值取自 AOSP core/java/android/hardware/display/DisplayManager.java，逐位写死。
    // 用不到的版本位上这些位不会被系统识别，多传无害。
    private static final int FLAG_SUPPORTS_TOUCH = 1 << 6;
    private static final int FLAG_ROTATES_WITH_CONTENT = 1 << 7;
    private static final int FLAG_DESTROY_CONTENT_ON_REMOVAL = 1 << 8;
    /** Android 13 起：可信屏 —— 没有它系统会静默去掉 IME / 独立焦点 / 系统装饰。 */
    private static final int FLAG_TRUSTED = 1 << 10;
    private static final int FLAG_OWN_DISPLAY_GROUP = 1 << 11;
    private static final int FLAG_ALWAYS_UNLOCKED = 1 << 12;
    private static final int FLAG_TOUCH_FEEDBACK_DISABLED = 1 << 13;
    /** Android 14 起：独立焦点栈，配合下面那位才能真正不抢主屏焦点。 */
    private static final int FLAG_OWN_FOCUS = 1 << 14;
    private static final int FLAG_STEAL_TOP_FOCUS_DISABLED = 1 << 16;

    private final Object lock = new Object();
    /** Shizuku v13 会把 UserService 的 Context 传进来；Root 的 app_process 没有，走反射兜底。 */
    private final Context providedContext;
    private Context shellContext;
    private DisplayManager displayManager;
    private VirtualDisplay display;
    private ImageReader reader;
    private Thread drainThread;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private int displayId = -1;
    private int width = 0;
    private int height = 0;
    private int dpi = 0;

    /** 最近一帧的 PNG（drain 线程持续更新）；截图直接取它。 */
    private final AtomicReference<byte[]> pendingCapture = new AtomicReference<>(null);
    /** 最近一帧的时间戳（uptimeMillis）；0 表示还没收到过帧。 */
    private volatile long latestFrameAt = 0L;

    DisplayHolder(Context context) {
        this.providedContext = context;
    }

    /**
     * 准备一个**包名真实为 com.android.shell** 的上下文。
     *
     * <p>为什么不能只靠 ContextWrapper 改 getPackageName：{@code getSystemService(DISPLAY_SERVICE)}
     * 返回的 {@code DisplayManagerImpl} 在**创建它的那个 ContextImpl** 上缓存了包名，
     * {@code createVirtualDisplay} 把它传给系统做 {@code validatePackageName(callingUid, packageName)}。
     * 复用传入的 context（包名 com.elainachat.mod）时，uid 2000 下就会抛
     * {@code packageName must match the calling uid} —— uid 0 有专门放行（"Root doesn't have
     * a package name"），所以 root holder 不踩这个坑，Shizuku 的 shell uid 会。
     *
     * <p>修法：{@code createPackageContext} 是公开 API，为系统包 com.android.shell 造一个
     * **新的 ContextImpl**，它缓存的就是合法包名（带 IGNORE_SECURITY，shell 是系统包无需验签）。
     */
    private Context shellContext() throws Exception {
        if (shellContext != null) return shellContext;
        Context source = providedContext != null ? providedContext : systemContext();
        Context base;
        try {
            base = source.createPackageContext("com.android.shell", Context.CONTEXT_IGNORE_SECURITY);
        } catch (Throwable error) {
            // 拿不到 shell 包的 context 就退回：uid 0 下反正放行，uid 2000 会在建屏时报错
            base = source;
        }
        final String pkg = "com.android.shell";
        shellContext = new ContextWrapper(base) {
            @Override
            public String getPackageName() {
                return pkg;
            }

            @Override
            public String getOpPackageName() {
                return pkg;
            }
        };
        return shellContext;
    }

    /** app_process 里没有 Activity，只能借 ActivityThread 的系统上下文（隐藏 API，反射取）。 */
    private static Context systemContext() throws Exception {
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Method systemMain = activityThread.getDeclaredMethod("systemMain");
        systemMain.setAccessible(true);
        Object thread = systemMain.invoke(null);
        Method getSystemContext = activityThread.getDeclaredMethod("getSystemContext");
        getSystemContext.setAccessible(true);
        Object context = getSystemContext.invoke(thread);
        if (!(context instanceof Context)) throw new IllegalStateException("拿不到系统上下文");
        return (Context) context;
    }

    /** Root holder 进程内复用同一份系统上下文（它还要拿去调 Provider）。 */
    static Context systemContextForHolder() throws Exception {
        return systemContext();
    }

    /**
     * 建屏（或复用）。返回 displayId。
     *
     * <p>flags 按 SDK 分层：{@code TRUSTED} 与独立焦点组是 Android 13 起才有的概念，
     * 而 {@code OWN_FOCUS / STEAL_TOP_FOCUS_DISABLED} 是 Android 14 起 —— 缺后者时
     * 在副屏启动 Activity 可能短暂抢走物理屏焦点。低版本只能算"尽力后台"。
     *
     * <p>能否建 **trusted** 屏随版本与 ROM 变化（shell 身份时尤其如此），不按版本写死；
     * 建屏失败由调用方翻译成可执行的下一步。
     */
    int createDisplay(int w, int h, int density, String name) throws Exception {
        synchronized (lock) {
            if (display != null && displayId >= 0) return displayId;
            width = Math.max(200, Math.min(4096, w));
            height = Math.max(200, Math.min(4096, h));
            dpi = Math.max(120, Math.min(640, density));
            Context context = shellContext();
            displayManager = (DisplayManager) context.getSystemService(Context.DISPLAY_SERVICE);
            if (displayManager == null) throw new IllegalStateException("拿不到 DisplayManager");

            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
            Surface surface = reader.getSurface();

            int flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC
                | DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
                | FLAG_SUPPORTS_TOUCH
                | FLAG_ROTATES_WITH_CONTENT
                | FLAG_DESTROY_CONTENT_ON_REMOVAL;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                flags |= FLAG_TRUSTED
                    | FLAG_OWN_DISPLAY_GROUP
                    | FLAG_ALWAYS_UNLOCKED
                    | FLAG_TOUCH_FEEDBACK_DISABLED;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                flags |= FLAG_OWN_FOCUS
                    | FLAG_STEAL_TOP_FOCUS_DISABLED;
            }

            String label = NAME_PREFIX + (name == null || name.isEmpty() ? "1" : name);
            VirtualDisplay created;
            try {
                created = displayManager.createVirtualDisplay(label, width, height, dpi, surface, flags);
            } catch (Throwable error) {
                closeFailedReader();
                throw error;
            }
            if (created == null) {
                closeFailedReader();
                throw new IllegalStateException("createVirtualDisplay 返回 null");
            }
            display = created;
            // VirtualDisplay.getDisplayId() 是 @hide，公开路径是先取 Display 再问 id
            displayId = display.getDisplay().getDisplayId();
            requestPowerOn(displayId);
            startDrain();
            return displayId;
        }
    }

    /**
     * 让副屏处于 ON。
     *
     * <p>不请求的话创建能成功但 state 是 OFF，{@code acquireLatestImage()} 永远拿不到帧 ——
     * 表现为"截图一直是黑的"，很容易误判成建屏失败。
     */
    private void requestPowerOn(int id) {
        try {
            Class<?> global = Class.forName("android.hardware.display.DisplayManagerGlobal");
            Method getInstance = global.getDeclaredMethod("getInstance");
            getInstance.setAccessible(true);
            Object instance = getInstance.invoke(null);
            Method request = global.getDeclaredMethod("requestDisplayPower", int.class, int.class);
            request.setAccessible(true);
            request.invoke(instance, id, 2);   // Display.STATE_ON
        } catch (Throwable ignored) {
            // 老系统 / OEM 裁剪了这个方法：屏照样能渲染，只是没有主动点亮这一步
        }
    }

    /**
     * 持续排空 ImageReader，并把**最新一帧**留在 {@link #latestFrame}。
     *
     * <p>为什么要留最新帧：虚拟屏只在内容变化时才产帧。界面静止时
     * {@code acquireLatestImage()} 一直返回 null —— 只在"要截图的那一刻"去取，
     * 就会得到"副屏没有产出画面"，而屏幕上明明有内容（实测：设置界面静止后截图必失败）。
     * 所以 drain 线程每收到一帧就转 PNG 存起来，截图直接拿缓存。
     *
     * <p>同时必须排空：不取帧生产者会停、副屏冻结。
     */
    private void startDrain() {
        if (running.getAndSet(true)) return;
        drainThread = new Thread(() -> {
            while (running.get()) {
                Image image = null;
                try {
                    image = reader.acquireLatestImage();
                    if (image == null) {
                        Thread.sleep(24);
                        continue;
                    }
                    byte[] png = toPng(image);
                    latestFrameAt = SystemClock.uptimeMillis();
                    pendingCapture.set(png);
                } catch (Throwable ignored) {
                    // 屏幕销毁 / 被系统回收：下一轮会退出
                } finally {
                    if (image != null) {
                        try { image.close(); } catch (Throwable ignored) { }
                    }
                }
            }
        }, "elaina-vd-drain");
        drainThread.setDaemon(true);
        drainThread.start();
    }

    private static byte[] toPng(Image image) {
        int w = image.getWidth();
        int h = image.getHeight();
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        int pixelStride = plane.getPixelStride();
        int rowStride = plane.getRowStride();
        int rowPadding = rowStride - pixelStride * w;
        int bitmapWidth = w + rowPadding / pixelStride;
        Bitmap padded = Bitmap.createBitmap(bitmapWidth, h, Bitmap.Config.ARGB_8888);
        padded.copyPixelsFromBuffer(buffer);
        Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, w, h);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        cropped.compress(Bitmap.CompressFormat.PNG, 100, out);
        padded.recycle();
        cropped.recycle();
        return out.toByteArray();
    }

    int displayId() {
        return displayId;
    }

    /**
     * 取最新一帧（PNG）。
     *
     * <p>优先用 drain 线程缓存的帧：虚拟屏静止时不产帧，现取会一直 null。
     * 缓存也没有（刚建屏、还没渲染过）才等一会儿，等不到就如实报错。
     *
     * @param freshMs 只接受这么新的帧；传 0 表示接受任意缓存帧
     */
    byte[] capture(int timeoutMs) throws Exception {
        if (display == null) throw new IllegalStateException("副屏还没有创建");
        byte[] cached = pendingCapture.get();
        if (cached != null && cached.length > 0) return cached;
        long deadline = SystemClock.uptimeMillis() + Math.max(500, timeoutMs);
        while (SystemClock.uptimeMillis() < deadline) {
            cached = pendingCapture.get();
            if (cached != null && cached.length > 0) return cached;
            Thread.sleep(40);
        }
        throw new IllegalStateException(latestFrameAt == 0L
            ? "副屏还没有渲染出任何画面（应用可能还没启动到副屏，或该界面禁止截图）。"
            : "副屏画面取不到（可能处于息屏）。");
    }

    // 动作：全部走 shell 命令

    // 包名 / 组件最终会拼进 sh -c：调用方绕过前端解析器时，这里必须自己能识别出非法字符。
    // 组件里的 $ 是合法类名（如 Settings$DisplayActivity），用单引号包住执行，避免被 shell 当变量展开。
    private static final Pattern SAFE_PACKAGE = Pattern.compile("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)*");
    private static final Pattern SAFE_COMPONENT = Pattern.compile("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)*/[A-Za-z0-9_.$]+");

    void launch(String pkg, String component) throws Exception {
        if (displayId < 0) throw new IllegalStateException("副屏还没有创建");
        if (pkg == null || pkg.isEmpty()) throw new IllegalArgumentException("缺少包名");
        if (!SAFE_PACKAGE.matcher(pkg).matches()) {
            throw new IllegalArgumentException("包名格式不合法：" + pkg);
        }
        // 一个应用只有一个任务：把它启动到副屏 = 把任务**搬**过去，主屏那份会消失。
        // 所以先查它是不是已经在别的屏上，是就拒绝，不静默搬走用户正在用的应用。
        String other = displayOfPackage(pkg);
        if (!other.isEmpty() && !other.equals(String.valueOf(displayId))) {
            throw new IllegalStateException(pkg + " 已经在显示 " + other + " 上运行；"
                + "一个应用只能在一个屏，搬到副屏会让你那边的窗口消失。请先关闭它，或换一个应用。");
        }
        String target = (component == null || component.trim().isEmpty()) ? resolveComponent(pkg) : component.trim();
        if (target.isEmpty()) throw new IllegalStateException("解析不到 " + pkg + " 的启动 Activity");
        if (!target.startsWith(pkg + "/")) {
            throw new IllegalArgumentException("启动组件与包名不一致：" + target);
        }
        if (!SAFE_COMPONENT.matcher(target).matches()) {
            throw new IllegalArgumentException("启动组件格式不合法：" + target);
        }
        ShellProcess.Result result = exec("am start --display " + displayId + " -n '" + target + "'");
        if (!result.ok()) {
            throw new IllegalStateException("启动失败：" + firstLine(result));
        }
    }

    private String resolveComponent(String pkg) {
        ShellProcess.Result result = exec("cmd package resolve-activity --brief " + pkg);
        if (!result.ok()) return "";
        // 输出最后一行是 pkg/Activity
        String[] lines = result.stdout.trim().split("\n");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (line.contains("/")) return line;
        }
        return "";
    }

    /**
     * 某个包**正在前台**的 display；不在任何 display 前台返回空串。
     *
     * <p>只看 ResumedActivity，不看所有 ActivityRecord：设置这类系统应用常年挂在
     * display 0 的任务栈里（后台），把它当成"用户正在用"会误拦所有正常启动 ——
     * 真机实测就是「打开设置」被自己的保护逻辑挡住。
     * 真正要保护的是"用户正看着这个应用"：把前台任务搬到副屏，他那边的窗口会消失。
     */
    private String displayOfPackage(String pkg) {
        ShellProcess.Result result = exec("dumpsys activity activities");
        if (!result.ok()) return "";
        String currentDisplay = "";
        for (String line : result.stdout.split("\n")) {
            Matcher displayMatcher = DISPLAY_LINE.matcher(line);
            if (displayMatcher.find()) {
                currentDisplay = displayMatcher.group(1);
                continue;
            }
            if (!line.contains("ResumedActivity") && !line.contains("topResumedActivity")) continue;
            if (line.contains(pkg + "/")) return currentDisplay;
        }
        return "";
    }

    private static final Pattern DISPLAY_LINE = Pattern.compile("Display #(\\d+)");

    String foreground() {
        if (displayId < 0) return "";
        ShellProcess.Result result = exec("dumpsys activity activities");
        if (!result.ok()) return "";
        String currentDisplay = "";
        for (String line : result.stdout.split("\n")) {
            Matcher displayMatcher = DISPLAY_LINE.matcher(line);
            if (displayMatcher.find()) {
                currentDisplay = displayMatcher.group(1);
                continue;
            }
            if (!currentDisplay.equals(String.valueOf(displayId))) continue;
            Matcher resumed = RESUMED.matcher(line);
            if (resumed.find()) return resumed.group(1);
        }
        return "";
    }

    private static final Pattern RESUMED = Pattern.compile(
        "(?:topResumedActivity|mResumedActivity|ResumedActivity)[^\\n]*?\\s([A-Za-z0-9_.]+)/[A-Za-z0-9_.$]+");

    void tap(int x, int y, int durationMs) throws Exception {
        if (durationMs >= 400) {
            // input swipe 同点同点是长按：input 没有独立的长按子命令
            ShellProcess.Result result = exec("input -d " + displayId + " swipe " + x + " " + y + " " + x + " " + y + " "
                + Math.min(3000, Math.max(400, durationMs)));
            if (!result.ok()) throw new IllegalStateException("长按失败：" + firstLine(result));
            return;
        }
        ShellProcess.Result result = exec("input -d " + displayId + " tap " + x + " " + y);
        if (!result.ok()) throw new IllegalStateException("点击失败：" + firstLine(result));
    }

    void swipe(int x1, int y1, int x2, int y2, int durationMs) throws Exception {
        int duration = Math.max(40, Math.min(8000, durationMs));
        ShellProcess.Result result = exec("input -d " + displayId + " swipe " + x1 + " " + y1 + " " + x2 + " " + y2 + " " + duration);
        if (!result.ok()) throw new IllegalStateException("滑动失败：" + firstLine(result));
    }

    void key(int keyCode) throws Exception {
        ShellProcess.Result result = exec("input -d " + displayId + " keyevent " + keyCode);
        if (!result.ok()) throw new IllegalStateException("按键失败：" + firstLine(result));
    }

    /**
     * 输入文本。
     *
     * <p>{@code input text} 走的是虚拟键盘映射，只认 ASCII —— 中文、emoji 都映射不出按键事件。
     * 所以非 ASCII 走"写剪贴板 + 粘贴"：shell/root 都能设剪贴板，粘贴键是系统级的。
     * 两条都失败时如实抛错，让上层提示用户开无障碍（那边能用 ACTION_SET_TEXT）。
     */
    void inputText(String text) throws Exception {
        if (text == null || text.isEmpty()) throw new IllegalArgumentException("没有要输入的内容");
        if (isAscii(text)) {
            ShellProcess.Result result = exec("input -d " + displayId + " text '" + text.replace("'", "'\\''").replace(" ", "%s") + "'");
            if (!result.ok()) throw new IllegalStateException("输入失败：" + firstLine(result));
            return;
        }
        // cmd clipboard 在部分系统上不存在，失败就换 service call；都失败再报错
        ShellProcess.Result clip = exec("cmd clipboard set-text '" + text.replace("'", "'\\''") + "'");
        if (!clip.ok()) {
            clip = exec("service call clipboard 2 i32 1 i32 0 s16 '" + text.replace("'", "'\\''") + "'");
        }
        if (!clip.ok()) {
            throw new IllegalStateException("这段文字不是纯 ASCII，需要剪贴板粘贴，但本机没有可用的剪贴板命令。"
                + "请在设置里开启「无障碍」后再输入中文。");
        }
        ShellProcess.Result paste = exec("input -d " + displayId + " keyevent 279");   // KEYCODE_PASTE
        if (!paste.ok()) throw new IllegalStateException("粘贴失败：" + firstLine(paste));
    }

    /**
     * 读副屏控件树。
     *
     * <p>{@code --windows} 会返回**所有**屏的窗口（本机实测是 {@code <displays><display id="N">…}），
     * 不按 id 过滤就会把主屏（用户自己正在看的界面）也交给模型 —— 它会以为目标应用没打开。
     * 所以按 {@code <display id="N">} 段切出目标屏，再压成扁平文本。
     */
    String dumpUi() throws Exception {
        if (displayId < 0) throw new IllegalStateException("副屏还没有创建");
        // /data/local/tmp 是共享目录：固定文件名可被其他进程预测、抢先占位或提前建好链接，
        // 而控件树里是用户界面内容。每次用随机名，落点不可预测。
        String token = UUID.randomUUID().toString().replace("-", "");
        File out = new File("/data/local/tmp/elaina-vd-" + displayId + "-" + token + ".xml");
        ShellProcess.Result result = exec("uiautomator dump --windows --compressed " + out.getAbsolutePath());
        if (!result.ok()) throw new IllegalStateException("读取界面失败：" + firstLine(result));
        ShellProcess.Result cat = exec("cat " + out.getAbsolutePath());
        exec("rm -f " + out.getAbsolutePath());
        if (!cat.ok()) throw new IllegalStateException("读取界面失败：拿不到 dump 文件");
        String section = filterDisplaySection(cat.stdout);
        return DeviceArtifacts.flattenUiXmlText(section);
    }

    /**
     * 从 {@code --windows} 的整份 dump 里切出目标 display 的段。
     *
     * <p>格式（本机实测）：{@code <displays><display id="0">…</display><display id="2">…</display></displays>}。
     * 找不到目标段时退回整份 —— 宁可多给，也不要因为格式差异而报"读不到界面"。
     */
    private String filterDisplaySection(String xml) {
        String open = "<display id=\"" + displayId + "\"";
        int start = xml.indexOf(open);
        if (start < 0) {
            // 老版本没有 <display> 包裹时，退回按 display-id 属性找窗口
            return xml;
        }
        int end = xml.indexOf("</display>", start);
        if (end < 0) return xml.substring(start);
        return xml.substring(start, end);
    }

    private static boolean isAscii(String text) {
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) > 0x7F) return false;
        }
        return true;
    }

    private static String firstLine(ShellProcess.Result result) {
        String text = result.stderr.trim().isEmpty() ? result.stdout.trim() : result.stderr.trim();
        int nl = text.indexOf('\n');
        return nl > 0 ? text.substring(0, nl) : text;
    }

    private static ShellProcess.Result exec(String command) {
        return ShellProcess.runShell(command, 20_000);
    }

    /**
     * 建屏失败时收回 reader：它已占着一份整屏 ×2 的图形缓冲，失败后调用方必然重试
     * （displayId 仍是 -1），不关的话每次重试都再多泄一份，只能等进程结束才回收。
     */
    private void closeFailedReader() {
        try { reader.close(); } catch (Throwable ignored) { }
        reader = null;
    }

    /** 释放副屏并停掉 drain 线程。 */
    void destroy() {
        synchronized (lock) {
            running.set(false);
            Thread thread = drainThread;
            drainThread = null;
            if (thread != null) {
                try { thread.join(500); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            }
            if (display != null) {
                try { display.release(); } catch (Throwable ignored) { }
                display = null;
            }
            if (reader != null) {
                try { reader.close(); } catch (Throwable ignored) { }
                reader = null;
            }
            displayId = -1;
        }
    }

    int width() { return width; }
    int height() { return height; }
    int dpi() { return dpi; }
}
