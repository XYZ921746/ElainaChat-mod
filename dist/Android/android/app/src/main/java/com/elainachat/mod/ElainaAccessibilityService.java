package com.elainachat.mod;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 手机操作的「无障碍」后端。
 *
 * <p>这个后端**不执行 shell 命令**，而是直接调系统无障碍 API。两个实际意义：
 * <ol>
 *   <li>免 root、免电脑、免装模块，门槛最低</li>
 *   <li>**中文输入只有它能可靠做到** —— {@code input text} 命令只认 ASCII，
 *       这里用 {@code ACTION_SET_TEXT} 不受这个限制</li>
 * </ol>
 *
 * <p>服务实例由系统创建，用静态引用共享给插件层。
 */
public class ElainaAccessibilityService extends AccessibilityService {

    /** 遍历深度上限。太深的树对模型没用，还会把 token 烧光。 */
    private static final int MAX_DEPTH = 18;
    /** 单次 dump 的元素上限。 */
    private static final int MAX_NODES = 400;
    /** dump 的字符预算，超过就截断。 */
    private static final int MAX_CHARS = 24000;
    /** 截图长边上限：前端网格按物理坐标绘制，缩放只省传输、不破坏读数。 */
    private static final int SCREENSHOT_MAX_SIDE = 1120;

    private static volatile ElainaAccessibilityService instance;

    /** 最近一次界面内容/窗口变化事件的时间（uptimeMillis），供“界面安静”判定使用。 */
    private static volatile long lastUiEventAt = 0;
    private static volatile long lastUiEventDispatchAt = 0;

    /** 界面变化回调（插件层注册，前端用它把观察快照标记为过期）；250ms 节流防事件风暴。 */
    public interface UiChangeListener {
        void onUiChanged();
    }

    private static volatile UiChangeListener uiChangeListener;

    static void setUiChangeListener(UiChangeListener listener) {
        uiChangeListener = listener;
    }

    /** 距上一次界面变化已超过 quietMs 视为“安静”；服务刚启动时按安静处理。 */
    static boolean isUiQuiet(long quietMs) {
        return android.os.SystemClock.uptimeMillis() - lastUiEventAt >= quietMs;
    }

    private static void dispatchUiChangedThrottled() {
        UiChangeListener listener = uiChangeListener;
        if (listener == null) return;
        long now = android.os.SystemClock.uptimeMillis();
        if (now - lastUiEventDispatchAt < 250) return;
        lastUiEventDispatchAt = now;
        try {
            listener.onUiChanged();
        } catch (Throwable ignored) {
            // 回调失败不能影响服务本身
        }
    }

    /**
     * 最近一次「窗口状态变化」的包名。
     *
     * <p>用途：{@code [操作:手机设备信息]} 要告诉 AI"用户现在开着哪个应用"。
     * 这是无障碍服务**顺带**就能知道的事（它本来就在监听窗口事件），
     * 不必再去申请"使用情况访问"（UsageStats）那份额外权限。
     *
     * <p>只记包名、不记窗口标题 —— 标题常常含聊天对象名、文件名这类隐私内容，
     * 而"用户在用哪个应用"已经够 AI 用了。少读一点隐私是刻意的。
     */
    private static volatile String foregroundPkg = "";

    static ElainaAccessibilityService get() {
        return instance;
    }

    static boolean isRunning() {
        ElainaAccessibilityService service = instance;
        if (service == null) return false;
        // 服务被系统回收后静态引用可能还指着旧对象，用一次实际调用确认它还活着。
        // 注意不能用 isEnabled()——AccessibilityService 上没有这个方法。
        try {
            return service.getServiceInfo() != null;
        } catch (Throwable error) {
            return false;
        }
    }

    /**
     * 当前前台应用的包名；读不到返回空串。
     *
     * <p>优先取**输入焦点窗口**的根节点包名，而不是直接信上面那份事件缓存：
     * 启动别的应用后，本应用 Activity 的退后台事件通常**晚于**目标应用的窗口事件到达，
     * 缓存会被写回本应用（悬浮窗也是本应用的窗口）。AI 核对「打开的是不是目标应用」
     * 恰好发生在那一刻，读缓存必然读到"ElainaChat 自己"。
     * 悬浮窗是 FLAG_NOT_FOCUSABLE 的，不会成为活动窗口，所以这里拿到的是目标应用。
     */
    static String foregroundPackage() {
        ElainaAccessibilityService service = instance;
        if (service != null) {
            try {
                AccessibilityNodeInfo root = service.getRootInActiveWindow();
                if (root != null) {
                    CharSequence pkg = root.getPackageName();
                    if (pkg != null && pkg.length() > 0) return pkg.toString();
                }
            } catch (Throwable error) {
                // 取活动窗口失败就退回事件缓存，绝不因为核对功能影响服务本身
            }
        }
        return foregroundPkg == null ? "" : foregroundPkg;
    }

    /**
     * 包名 → 「应用名（包名）」。每步读界面都要写进概况行，所以缓存：
     * PackageManager 查询在低端机上单次数毫秒，按步调用会摊进每一步的设备耗时里。
     */
    private static final java.util.Map<String, String> packageLabelCache = new java.util.concurrent.ConcurrentHashMap<>();

    static String describePackageCached(String pkg) {
        if (pkg == null || pkg.isEmpty()) return "";
        String cached = packageLabelCache.get(pkg);
        if (cached != null) return cached;
        String label = pkg;
        ElainaAccessibilityService service = instance;
        try {
            if (service != null) {
                android.content.pm.PackageManager pm = service.getPackageManager();
                android.content.pm.ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
                label = pm.getApplicationLabel(info) + "（" + pkg + "）";
            }
        } catch (Throwable error) {
            // 查不到就用包名兜底：模型仍然能据此判断当前在哪个应用
        }
        packageLabelCache.put(pkg, label);
        return label;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // 只挑「窗口状态变化」这一种事件来更新前台应用 ——
        // 内容变化（typeWindowContentChanged）触发极其频繁（打字、滚动都算），
        // 在里面做任何事都是在给系统添负担，而它对"现在开着哪个应用"毫无信息量。
        if (event == null) return;
        try {
            if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
                CharSequence pkg = event.getPackageName();
                if (pkg != null && pkg.length() > 0) foregroundPkg = pkg.toString();
                lastUiEventAt = android.os.SystemClock.uptimeMillis();
                dispatchUiChangedThrottled();
            } else if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
                // 内容变化只记时间戳 + 节流回调：settle 与快照过期都靠它，不做任何重活
                lastUiEventAt = android.os.SystemClock.uptimeMillis();
                dispatchUiChangedThrottled();
            }
        } catch (Throwable error) {
            // 读事件失败绝不能影响服务本身
        }
    }

    @Override
    public void onInterrupt() {
        // 系统要求实现，无操作
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    // 读取界面

    /** 把当前界面的控件树拍成扁平文本。 */
    String dumpUiTree() {
        return dumpUiTree(android.view.Display.DEFAULT_DISPLAY);
    }

    /**
     * 读指定显示器的控件树。
     *
     * <p>为什么需要按 displayId 读：后台方式在独立副屏上跑应用，默认屏上没有它 ——
     * 不指定就会读到用户自己的界面，模型据此判断"目标应用没打开"。
     *
     * <p>{@code getWindowsOnAllDisplays()} 是 API 30 起才有的；低版本只能读默认屏。
     * 副屏上纯 GL 画面（游戏、视频）仍然没有可读控件树，那种情况如实返回、让上层改用截图。
     */
    String dumpUiTree(int displayId) {
        AccessibilityNodeInfo root = null;
        try {
            root = pickReadableRoot(displayId);
        } catch (Throwable error) {
            return "读不到当前界面：" + ShellProcess.describe(error);
        }
        if (root == null) {
            return "当前界面没有可读的控件树。游戏、视频这类纯画面应用就是这样 —— "
                + "要看画面请用「手机截图」，按画面判断坐标再点击 / 滑动。";
        }

        StringBuilder builder = new StringBuilder();
        int[] counter = {0};
        boolean truncated = false;
        // 覆盖统计用 32×32 的粗网格：只回答“屏幕上有多大的区域完全没有可读控件”，
        // 不追求精确面积；精确的点击仍由节点的 bounds 决定。
        final int gridSize = 32;
        boolean[] coverage = new boolean[gridSize * gridSize];
        // 尺寸必须取**目标显示器**的：副屏分辨率通常与主屏不同，用系统默认屏的尺寸算覆盖与
        // 中心坐标，会整体偏到屏幕外。
        android.util.DisplayMetrics metrics = metricsOf(displayId);
        int screenW = Math.max(1, metrics.widthPixels);
        int screenH = Math.max(1, metrics.heightPixels);
        int textNodes = 0;
        int scrollableNodes = 0;
        java.util.Set<String> surfaceHints = new java.util.LinkedHashSet<>();

        // 包名要在入栈前取：root 作为首帧同样会在循环尾走 recycle，Android 12- 上 recycle
        // 会清空节点再还池（API 33 起才是空操作），循环结束后再读只会拿到空。
        String fgPkg = "";
        try {
            CharSequence rootPkg = root.getPackageName();
            if (rootPkg != null) fgPkg = rootPkg.toString();
        } catch (Throwable ignored) {
            // 取不到就不写概况里的前台项，不影响控件树本身
        }

        // 用显式栈做深度优先遍历，避免递归过深
        Deque<Object[]> stack = new ArrayDeque<>();
        stack.push(new Object[]{root, 0, ""});
        while (!stack.isEmpty()) {
            Object[] frame = stack.pop();
            AccessibilityNodeInfo node = (AccessibilityNodeInfo) frame[0];
            int depth = (int) frame[1];
            String parentLabel = String.valueOf(frame[2] == null ? "" : frame[2]);

            if (counter[0] >= MAX_NODES) {
                truncated = true;
                recycle(node);
                continue;
            }

            String line = describeNode(node, counter[0], parentLabel);
            if (line != null) {
                if (builder.length() + line.length() > MAX_CHARS) {
                    truncated = true;
                    recycle(node);
                    continue;
                }
                builder.append(line).append('\n');
                counter[0]++;

                Rect bounds = new Rect();
                try {
                    node.getBoundsInScreen(bounds);
                } catch (Throwable ignored) {
                    bounds.setEmpty();
                }
                boolean interactive = node.isClickable() || node.isEditable() || node.isScrollable();
                if (interactive) markCoverage(coverage, gridSize, bounds, screenW, screenH);
                if (node.isScrollable()) scrollableNodes++;
                if (hasLabel(node)) textNodes++;
                String cls = node.getClassName() == null ? "" : node.getClassName().toString();
                if (cls.contains("SurfaceView") || cls.contains("TextureView")
                    || cls.contains("GLSurfaceView") || cls.contains("VideoView")
                    || cls.contains("WebView")) {
                    surfaceHints.add(shortName(cls));
                }
            }

            if (depth < MAX_DEPTH) {
                String childParent = hasLabel(node) ? nodeLabel(node) : parentLabel;
                int childCount = node.getChildCount();
                for (int i = childCount - 1; i >= 0; i--) {
                    AccessibilityNodeInfo child = null;
                    try {
                        child = node.getChild(i);
                    } catch (Throwable ignored) {
                        // 节点在遍历中途消失是常态（界面正在刷新）
                    }
                    if (child != null) stack.push(new Object[]{child, depth + 1, childParent});
                }
            }
            recycle(node);
        }

        if (counter[0] == 0) return "当前界面没有任何可读元素。";
        if (truncated) {
            builder.append("…（界面元素过多，已截断。可先滑动或点击缩小范围再读）\n");
        }
        int marked = 0;
        for (boolean cell : coverage) if (cell) marked++;
        int percent = Math.round(marked * 100f / coverage.length);
        // 概况行同时给「这是哪个应用」和「屏幕多大」：模型每一步都要靠它确认自己在哪，
        // 不在这里给，它就会每步额外查一次设备信息（每次 0.5–1 秒，纯浪费）。
        // 取 root 的包名而不是事件缓存：root 就是本次 dump 的窗口，不会慢半拍（入栈前已读）。
        builder.append("# 概况");
        if (!fgPkg.isEmpty()) builder.append(" 前台=").append(describePackageCached(fgPkg));
        builder.append(" 屏幕=").append(screenW).append('x').append(screenH);
        builder.append(" 控件覆盖=").append(percent).append("% 文字=").append(textNodes)
            .append(" 可滑=").append(scrollableNodes);
        if (!surfaceHints.isEmpty()) {
            StringBuilder hints = new StringBuilder();
            for (String hint : surfaceHints) {
                if (hints.length() > 0) hints.append(',');
                hints.append(hint);
            }
            builder.append(" 画布提示=").append(hints);
        }
        builder.append('\n');
        builder.append("共 ").append(counter[0]).append(" 个元素。");
        return builder.toString();
    }

    private static boolean hasLabel(AccessibilityNodeInfo node) {
        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        return (text != null && text.length() > 0) || (desc != null && desc.length() > 0);
    }

    private static String nodeLabel(AccessibilityNodeInfo node) {
        CharSequence text = node.getText();
        if (text != null && text.length() > 0) return trim(text, 40);
        CharSequence desc = node.getContentDescription();
        if (desc != null && desc.length() > 0) return trim(desc, 40);
        return "";
    }

    /** 把节点占用的屏幕区域标进粗网格；用于“控件覆盖 / 无控件区域”的判断。 */
    private static void markCoverage(boolean[] coverage, int gridSize, Rect bounds,
                                     int screenW, int screenH) {
        if (bounds == null || bounds.isEmpty()) return;
        int left = Math.max(0, Math.min(screenW - 1, bounds.left));
        int top = Math.max(0, Math.min(screenH - 1, bounds.top));
        int right = Math.max(0, Math.min(screenW, bounds.right));
        int bottom = Math.max(0, Math.min(screenH, bounds.bottom));
        if (right <= left || bottom <= top) return;
        int gx1 = left * gridSize / screenW;
        int gy1 = top * gridSize / screenH;
        int gx2 = Math.min(gridSize - 1, right * gridSize / screenW);
        int gy2 = Math.min(gridSize - 1, bottom * gridSize / screenH);
        for (int gy = gy1; gy <= gy2; gy++) {
            for (int gx = gx1; gx <= gx2; gx++) {
                coverage[gy * gridSize + gx] = true;
            }
        }
    }

    /**
     * 选出「这次要读的那个窗口」的根节点。
     *
     * <p>为什么不能直接用 {@code getRootInActiveWindow()}：它给的是「当前无障碍焦点窗口」。
     * 游戏这类 GL / SurfaceView 界面没有可聚焦的控件，焦点会落到状态栏那类系统窗口上 ——
     * 读回来的是一屏与本意无关的东西，AI 会把它当成「界面上只有这一个控件」去点
     * （实测前台玩小游戏时读到的唯一控件坐标落在状态栏上，整轮任务因此卡死）。
     *
     * <p>判据：按窗口层级从高到低取第一个「应用窗口」（{@code TYPE_APPLICATION}）。
     * 本应用自己在前台时也算应用窗口，所以「看聊天界面」这类需求不受影响；
     * 悬浮窗是 {@code TYPE_ACCESSIBILITY_OVERLAY}，本来就不在候选里；系统界面用包名排除。
     *
     * <p>返回值 null 表示「这个界面没有可读的控件树」——纯 GL 画面的应用（游戏、视频）就是这样，
     * 此时把状态栏冒充成界面只会误导，不如如实说清楚，让上层改用截图。
     */
    private AccessibilityNodeInfo pickReadableRoot() {
        return pickReadableRoot(android.view.Display.DEFAULT_DISPLAY);
    }

    /**
     * 选出「这次要读的那个窗口」的根节点（指定显示器）。
     *
     * <p>为什么不能直接用 {@code getRootInActiveWindow()}：它给的是「当前无障碍焦点窗口」。
     * 游戏这类 GL / SurfaceView 界面没有可聚焦的控件，焦点会落到状态栏那类系统窗口上 ——
     * 读回来的是一屏与本意无关的东西，AI 会把它当成「界面上只有这一个控件」去点
     * （实测前台玩小游戏时读到的唯一控件坐标落在状态栏上，整轮任务因此卡死）。
     *
     * <p>判据：按窗口层级从高到低取第一个「应用窗口」（{@code TYPE_APPLICATION}）。
     * 本应用自己在前台时也算应用窗口，所以「看聊天界面」这类需求不受影响；
     * 悬浮窗是 {@code TYPE_ACCESSIBILITY_OVERLAY}，本来就不在候选里；系统界面用包名排除。
     *
     * <p>指定 displayId 时用 {@code getWindowsOnAllDisplays()}（API 30+）：副屏上的窗口
     * 不在默认屏的 {@code getWindows()} 里，不这样读就永远只能看到用户自己的界面。
     *
     * <p>返回值 null 表示「这个界面没有可读的控件树」——纯 GL 画面的应用（游戏、视频）就是这样，
     * 此时把状态栏冒充成界面只会误导，不如如实说清楚，让上层改用截图。
     */
    private AccessibilityNodeInfo pickReadableRoot(int displayId) {
        try {
            List<AccessibilityWindowInfo> windows = windowsOf(displayId);
            if (windows != null) {
                for (AccessibilityWindowInfo window : windows) {
                    if (window == null) continue;
                    if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
                    AccessibilityNodeInfo root;
                    try {
                        root = window.getRoot();
                    } catch (Throwable ignored) {
                        continue;
                    }
                    if (root == null) continue;
                    CharSequence name = root.getPackageName();
                    String pkg = name == null ? "" : name.toString();
                    if ("com.android.systemui".equals(pkg)) continue;
                    // 本应用自己的悬浮条也是本包，但它是「AI 正在操作手机」那一条，不是用户眼前的界面
                    if (isOwnStripWindow(root)) continue;
                    return root;
                }
            }
        } catch (Throwable ignored) {
            // 取窗口列表失败就继续往下走回落分支
        }
        // 焦点窗口只代表默认屏；查副屏时不能拿它顶替
        if (displayId != android.view.Display.DEFAULT_DISPLAY) return null;
        AccessibilityNodeInfo fallback = getRootInActiveWindow();
        if (fallback == null) return null;
        CharSequence name = fallback.getPackageName();
        String pkg = name == null ? "" : name.toString();
        // 焦点窗口是系统界面（状态栏 / 锁屏）或本应用的悬浮条时，不要拿来顶替：那不是用户眼前的界面
        if ("com.android.systemui".equals(pkg)) return null;
        if (isOwnStripWindow(fallback)) return null;
        return fallback;
    }

    /** 某个显示器的真实尺寸与密度；取不到时退回系统默认屏。 */
    private android.util.DisplayMetrics metricsOf(int displayId) {
        android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
        if (displayId == android.view.Display.DEFAULT_DISPLAY) {
            return android.content.res.Resources.getSystem().getDisplayMetrics();
        }
        try {
            android.hardware.display.DisplayManager dm =
                (android.hardware.display.DisplayManager) getSystemService(DISPLAY_SERVICE);
            android.view.Display display = dm == null ? null : dm.getDisplay(displayId);
            if (display != null) {
                display.getRealMetrics(metrics);
                if (metrics.widthPixels > 0 && metrics.heightPixels > 0) return metrics;
            }
        } catch (Throwable ignored) {
            // 显示器可能刚被销毁
        }
        return android.content.res.Resources.getSystem().getDisplayMetrics();
    }

    /** 某个显示器上的窗口列表；API 30 以下只有默认屏可读。 */
    private List<AccessibilityWindowInfo> windowsOf(int displayId) {
        if (displayId == android.view.Display.DEFAULT_DISPLAY) return getWindows();
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) return null;
        try {
            android.util.SparseArray<List<AccessibilityWindowInfo>> all = getWindowsOnAllDisplays();
            return all == null ? null : all.get(displayId);
        } catch (Throwable error) {
            return null;
        }
    }

    /**
     * 是不是本应用那条「悬浮条」窗口。
     *
     * <p>为什么不能只看包名：悬浮条与本应用主界面同包，只看包名会把「AI 正在操作手机」那一条
     * 当成整个界面 —— 实测读回的控件只有一条、坐标落在状态栏高度，模型据此以为界面上没别的东西。
     * 判据：本包 + 覆盖面积不足屏幕六成。主界面是全屏的，悬浮条只有一条。
     */
    private boolean isOwnStripWindow(AccessibilityNodeInfo root) {
        CharSequence name = root.getPackageName();
        String pkg = name == null ? "" : name.toString();
        if (!getPackageName().equals(pkg)) return false;
        Rect bounds = new Rect();
        try {
            root.getBoundsInScreen(bounds);
        } catch (Throwable ignored) {
            return false;
        }
        android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
        long screenArea = Math.max(1L, (long) metrics.widthPixels * metrics.heightPixels);
        long area = Math.max(0, bounds.width()) * (long) Math.max(0, bounds.height());
        return area * 5 < screenArea * 3;
    }

    /**
     * 单个节点压成一行。
     *
     * <p>返回 null 表示这个节点没信息量、不值得给模型看 —— 现实里一个界面几千个节点，
     * 绝大部分是不带文字也不可交互的布局容器，全发过去只会淹没重点。
     */
    private String describeNode(AccessibilityNodeInfo node, int index, String parentLabel) {
        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        String id = node.getViewIdResourceName();
        boolean clickable = node.isClickable();
        boolean scrollable = node.isScrollable();
        boolean editable = node.isEditable();
        boolean checkable = node.isCheckable();
        boolean checked = node.isChecked();
        boolean enabled = node.isEnabled();

        boolean hasText = (text != null && text.length() > 0) || (desc != null && desc.length() > 0);
        if (!hasText && TextUtils.isEmpty(id) && !clickable && !scrollable && !editable && !checkable) {
            return null;
        }
        // 不可见节点仍然会被无障碍树返回（列表复用的屏外行、隐藏弹层），它们不是用户眼前的界面。
        // 根节点的可见性在部分 ROM 上不可靠，索引 0 不据此过滤。
        try {
            if (index > 0 && !node.isVisibleToUser()) return null;
        } catch (Throwable ignored) {
            // 老系统偶发抛错时按可见处理，别把整棵界面丢掉
        }

        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        int[] tap = preferredTapPoint(node, bounds);
        String className = shortName(node.getClassName());

        StringBuilder line = new StringBuilder();
        line.append('#').append(index).append(' ');
        if (text != null && text.length() > 0) line.append('“').append(trim(text, 80)).append('”');
        else if (desc != null && desc.length() > 0) line.append("[描述]“").append(trim(desc, 80)).append('”');
        else line.append(className);

        if (!TextUtils.isEmpty(id)) line.append(" id=").append(shortId(id));
        line.append(" cls=").append(className);
        if (clickable) line.append(" 可点");
        if (scrollable) line.append(" 可滑");
        if (editable) line.append(" 可输入");
        if (checkable) line.append(checked ? " 已选" : " 未选");
        if (!enabled) line.append(" 禁用");
        if (node.isFocused()) line.append(" 有焦点");
        line.append(" bounds=").append(bounds.left).append(',').append(bounds.top)
            .append(',').append(bounds.right).append(',').append(bounds.bottom);
        if (parentLabel != null && !parentLabel.isEmpty()) {
            line.append(" parent=“").append(parentLabel).append('”');
        }
        line.append(" [").append(tap[0]).append(',').append(tap[1]).append(']');
        return line.toString();
    }

    /**
     * 可点容器的几何中心经常落在空白处（整行列表、整块卡片），
     * 优先取内部有文字 / 描述的子节点中心，点中的才是用户看到的那个目标。
     */
    private int[] preferredTapPoint(AccessibilityNodeInfo node, Rect bounds) {
        int cx = bounds.centerX();
        int cy = bounds.centerY();
        if (!node.isClickable() || node.getChildCount() <= 0) return new int[]{cx, cy};
        int bestX = cx;
        int bestY = cy;
        int bestArea = Integer.MAX_VALUE;
        int count = Math.min(node.getChildCount(), 16);
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = null;
            try {
                child = node.getChild(i);
                if (child == null || !child.isVisibleToUser()) continue;
                boolean labeled = hasLabel(child) || child.isClickable();
                if (!labeled) continue;
                Rect childBounds = new Rect();
                child.getBoundsInScreen(childBounds);
                if (childBounds.width() < 8 || childBounds.height() < 8) continue;
                if (!bounds.contains(childBounds)) continue;
                int area = childBounds.width() * childBounds.height();
                if (area < bestArea) {
                    bestArea = area;
                    bestX = childBounds.centerX();
                    bestY = childBounds.centerY();
                }
            } catch (Throwable ignored) {
                // 遍历中节点消失是常态
            } finally {
                recycle(child);
            }
        }
        return new int[]{bestX, bestY};
    }

    private static String trim(CharSequence value, int limit) {
        String text = value.toString().replace('\n', ' ').trim();
        return text.length() <= limit ? text : text.substring(0, limit) + "…";
    }

    private static String shortName(CharSequence className) {
        if (className == null) return "View";
        String name = className.toString();
        int dot = name.lastIndexOf('.');
        return dot >= 0 && dot < name.length() - 1 ? name.substring(dot + 1) : name;
    }

    private static String shortId(String id) {
        int slash = id.lastIndexOf('/');
        return slash >= 0 && slash < id.length() - 1 ? id.substring(slash + 1) : id;
    }

    private static void recycle(AccessibilityNodeInfo node) {
        if (node == null) return;
        try {
            node.recycle();
        } catch (Throwable ignored) {
            // API 33+ 起 recycle 已是空操作；旧系统上偶尔会因节点已被回收而抛，忽略即可
        }
    }

    // 操作

    String tap(int x, int y) {
        String blocker = obstructionAt(x, y);
        if (blocker != null) {
            return "点击 (" + x + ", " + y + ") 失败：落点被其他窗口遮挡（" + blocker + "）。"
                + "请先关闭遮挡层（弹窗 / 悬浮球 / 输入法），或换一个目标。";
        }
        return gesture(singlePointPath(x, y), 60, "点击 (" + x + ", " + y + ")");
    }

    String longPress(int x, int y, int durationMs) {
        String blocker = obstructionAt(x, y);
        if (blocker != null) {
            return "长按 (" + x + ", " + y + ") 失败：落点被其他窗口遮挡（" + blocker + "）。"
                + "请先关闭遮挡层（弹窗 / 悬浮球 / 输入法），或换一个目标。";
        }
        int duration = durationMs > 0 ? Math.max(300, Math.min(3000, durationMs)) : 800;
        return gesture(singlePointPath(x, y), duration, "长按 (" + x + ", " + y + ") " + duration + "ms");
    }

    /**
     * 点击遮挡检测：取包含落点的最高层窗口，若它不是应用窗口本身、也不是本应用的悬浮条，
     * 说明这次点击会被别的层吃掉（弹窗 / 悬浮球 / 通知面板）—— 如实报告而不是假装点了。
     */
    private String obstructionAt(int x, int y) {
        try {
            List<AccessibilityWindowInfo> windows = getWindows();
            if (windows == null) return null;
            String appPkg = null;
            int appLayer = Integer.MIN_VALUE;
            String topPkg = null;
            int topLayer = Integer.MIN_VALUE;
            for (AccessibilityWindowInfo window : windows) {
                if (window == null) continue;
                Rect bounds = new Rect();
                window.getBoundsInScreen(bounds);
                if (!bounds.contains(x, y)) continue;
                AccessibilityNodeInfo root = window.getRoot();
                String pkg = (root != null && root.getPackageName() != null)
                    ? root.getPackageName().toString() : "";
                recycle(root);
                if (getPackageName().equals(pkg)) continue;   // 自家悬浮条不算遮挡
                if (window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION
                    && window.getLayer() > appLayer) {
                    appLayer = window.getLayer();
                    appPkg = pkg;
                }
                if (window.getLayer() > topLayer) {
                    topLayer = window.getLayer();
                    topPkg = pkg;
                }
            }
            if (topPkg == null || topPkg.isEmpty()) return null;
            if (appPkg != null && topPkg.equals(appPkg)) return null;   // 同包对话框 / 菜单交给应用自己处理
            return topPkg;
        } catch (Throwable error) {
            return null;   // 检测失败按无遮挡处理，别因此拦住点击
        }
    }

    String swipe(int x1, int y1, int x2, int y2, int durationMs) {
        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);
        int duration = Math.max(40, Math.min(8000, durationMs));
        return gesture(path, duration, "滑动 (" + x1 + "," + y1 + ") → (" + x2 + "," + y2 + ") " + duration + "ms");
    }

    private static Path singlePointPath(int x, int y) {
        Path path = new Path();
        path.moveTo(x, y);
        return path;
    }

    /** 执行一次手势并等它落地，好把成功/失败如实回给模型。 */
    private String gesture(Path path, int durationMs, String label) {
        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] completed = {false};

        try {
            GestureDescription.StrokeDescription stroke =
                new GestureDescription.StrokeDescription(path, 0, Math.max(20, durationMs));
            GestureDescription description = new GestureDescription.Builder().addStroke(stroke).build();
            boolean dispatched = dispatchGesture(description, new GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription gestureDescription) {
                    completed[0] = true;
                    latch.countDown();
                }

                @Override
                public void onCancelled(GestureDescription gestureDescription) {
                    latch.countDown();
                }
            }, null);

            if (!dispatched) {
                return label + " 失败：系统拒绝了这次手势（应用可能不在前台）——不要重复同一坐标，先重读界面。";
            }
        } catch (Throwable error) {
            return label + " 失败：" + ShellProcess.describe(error);
        }

        try {
            latch.await(Math.max(1500, durationMs + 1200L), TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        if (completed[0]) return label + " 完成。";
        return label + " 失败：手势被系统取消（界面可能正在切换，或落点被遮挡/不可点）——"
            + "请先「手机查看界面」确认当前界面，不要按原坐标重试。";
    }

    // 截图

    /**
     * 用无障碍的 {@code takeScreenshot} 截屏。
     *
     * <p>需要 Android 11（API 30）起才有这个 API。Android 10 上无障碍后端拿不到截图，
     * 只能读控件树 —— 这是系统限制，不是实现偷懒。
     *
     * <p>返回 null 表示这次没截成，失败原因通过 {@code failure} 带出去。
     */
    JSONObject screenshot(String[] failure) {
        return screenshot(android.view.Display.DEFAULT_DISPLAY, failure);
    }

    /**
     * 截指定显示器的屏。
     *
     * <p>副屏上的应用不在默认屏上，截默认屏只会拿到用户自己的界面。
     * 虚拟屏能否被无障碍截图取决于系统实现：拿不到时如实报错，让上层改走后台 holder。
     */
    JSONObject screenshot(int displayId, String[] failure) {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) {
            failure[0] = "无障碍后端截图需要 Android 11 及以上（当前是 Android "
                + android.os.Build.VERSION.RELEASE + "）。请改用「模块」后端，"
                + "或者用「手机查看界面」读控件树。";
            return null;
        }
        // 错误码 3 = 「两次截图间隔太短」（系统限流，约 333ms）。AI 每步都要看图，连续取景必撞这条限制；
        // 它并不代表画面读不了，等一会儿再来就能截到 —— 直接把这条错误交给模型，它会以为看不清而改成盲点。
        final int[] failureCode = {0};
        final boolean[] retryable = {false};
        for (int attempt = 0; attempt < 4; attempt++) {
            JSONObject shot = takeScreenshotOnce(displayId, failure, failureCode, retryable);
            if (shot != null) return shot;
            // 3 = 系统限流（等一会儿就能截）；retryable = 黑帧（系统偶发，重截通常就好了）。
            // 其它错误重试也没用，直接把原因交给模型。
            if (failureCode[0] != 3 && !retryable[0]) return null;
            try {
                Thread.sleep(failureCode[0] == 3 ? 400 : 350);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return null;
            }
        }
        return null;
    }

    /** 只截动作附近的一块区域；整屏截图仍在原生侧完成，但传回前端的只有裁剪结果。 */
    JSONObject screenshotRegion(int x, int y, int w, int h, String[] failure) {
        JSONObject full = screenshot(failure);
        if (full == null) return null;
        try {
            byte[] jpeg = android.util.Base64.decode(full.optString("imageBase64", ""), android.util.Base64.DEFAULT);
            // screenshot() 回传的是缩放后的图：readRegion 内部按 imageWidth/screenWidth 把物理坐标
            // 换算到图内像素再裁剪，region 偏移仍以物理屏幕坐标回传（前端 regionPointToScreen 依赖它）。
            return DeviceArtifacts.readRegion(jpeg, x, y, w, h,
                full.optInt("screenWidth", 0), full.optInt("screenHeight", 0));
        } catch (Throwable error) {
            failure[0] = "裁剪截图失败：" + ShellProcess.describe(error);
            return null;
        }
    }

    /**
     * 是不是近乎全黑的帧。
     *
     * <p>判据：抽样网格里 98% 以上的点 RGB 都低于 12。真实界面（哪怕深色主题）总有状态栏、文字、
     * 图标这些亮一些的像素；GL 游戏偶发拿到的黑帧是真的全黑。抽样 32×32 就够判断，不用全图遍历。
     */
    private static boolean isMostlyBlack(Bitmap bitmap) {
        try {
            int w = bitmap.getWidth();
            int h = bitmap.getHeight();
            if (w <= 0 || h <= 0) return true;
            int steps = 32;
            int total = 0;
            int dark = 0;
            for (int i = 0; i < steps; i++) {
                int x = Math.min(w - 1, (int) ((i + 0.5) * w / steps));
                for (int j = 0; j < steps; j++) {
                    int y = Math.min(h - 1, (int) ((j + 0.5) * h / steps));
                    int pixel = bitmap.getPixel(x, y);
                    int r = (pixel >> 16) & 0xFF;
                    int g = (pixel >> 8) & 0xFF;
                    int b = pixel & 0xFF;
                    total++;
                    if (r < 12 && g < 12 && b < 12) dark++;
                }
            }
            return total > 0 && dark * 100 >= total * 98;
        } catch (Throwable ignored) {
            return false;   // 判不了就按正常帧走，别把能用的截图丢掉
        }
    }

    /** 截一次屏；失败原因写进 {@code failure}，系统错误码写进 {@code failureCode}（0 = 不是系统拒绝）。 */
    private JSONObject takeScreenshotOnce(int displayId, String[] failure, int[] failureCode, boolean[] retryable) {
        failureCode[0] = 0;
        retryable[0] = false;
        final CountDownLatch latch = new CountDownLatch(1);
        final JSONObject[] holder = new JSONObject[1];
        final String[] error = new String[1];

        try {
            takeScreenshot(displayId, getMainExecutor(), new TakeScreenshotCallback() {
                @Override
                public void onSuccess(ScreenshotResult result) {
                    android.hardware.HardwareBuffer buffer = null;
                    Bitmap bitmap = null;
                    try {
                        buffer = result.getHardwareBuffer();
                        bitmap = Bitmap.wrapHardwareBuffer(buffer, result.getColorSpace());
                        if (bitmap == null) {
                            error[0] = "系统给的截图没法解码。";
                            return;
                        }
                        // wrapHardwareBuffer 出来的是只读硬件位图，压缩前必须拷成普通位图
                        Bitmap readable = bitmap.copy(Bitmap.Config.ARGB_8888, false);
                        if (readable == null) {
                            error[0] = "系统给的截图没法读出像素。";
                            return;
                        }
                        int width = readable.getWidth();
                        int height = readable.getHeight();
                        // 黑帧检测：无障碍 takeScreenshot 偶发返回全黑（实测玩 GL 游戏时出现，
                        // 同一时刻 adb screencap 是正常的）。黑帧交给模型只会得到「屏幕一片黑，我再等等」，
                        // 白烧一轮还误导它。这里标成可重试错误，让外层隔一会儿重截。
                        if (isMostlyBlack(readable)) {
                            readable.recycle();
                            error[0] = "这次截图拿到的是黑帧（系统偶发），正在重截。";
                            retryable[0] = true;
                            return;
                        }
                        // 长边压到 SCREENSHOT_MAX_SIDE 再编码：网格与红点编号都在前端按**物理屏幕坐标**
                        // 绘制（meta 回传 screenWidth/Height 仍是物理尺寸），缩放不破坏读数；
                        // 全尺寸 base64 的上行代价（1080×2400 约 500KB）远超细节收益。
                        Bitmap out = readable;
                        int longSide = Math.max(width, height);
                        if (longSide > SCREENSHOT_MAX_SIDE) {
                            float scale = SCREENSHOT_MAX_SIDE / (float) longSide;
                            out = Bitmap.createScaledBitmap(readable,
                                Math.max(1, Math.round(width * scale)),
                                Math.max(1, Math.round(height * scale)), true);
                        }
                        ByteArrayOutputStream outBuffer = new ByteArrayOutputStream();
                        out.compress(Bitmap.CompressFormat.JPEG, 80, outBuffer);
                        if (out != readable) out.recycle();
                        readable.recycle();
                        byte[] jpeg = outBuffer.toByteArray();

                        JSONObject meta = new JSONObject();
                        meta.put("imageBase64", android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP));
                        meta.put("imageMime", "image/jpeg");
                        meta.put("imageBytes", jpeg.length);
                        meta.put("screenWidth", width);
                        meta.put("screenHeight", height);
                        meta.put("imageWidth", out.getWidth());
                        meta.put("imageHeight", out.getHeight());
                        meta.put("scaleX", Math.round(width / (double) out.getWidth() * 1000.0) / 1000.0);
                        meta.put("scaleY", Math.round(height / (double) out.getHeight() * 1000.0) / 1000.0);
                        holder[0] = meta;
                    } catch (Throwable throwable) {
                        error[0] = "处理截图时出错：" + ShellProcess.describe(throwable);
                    } finally {
                        if (buffer != null) {
                            try {
                                buffer.close();
                            } catch (Throwable ignored) {
                                // 关不掉就算了，不影响结果
                            }
                        }
                        if (bitmap != null) {
                            try {
                                bitmap.recycle();
                            } catch (Throwable ignored) {
                                // 忽略
                            }
                        }
                        latch.countDown();
                    }
                }

                @Override
                public void onFailure(int errorCode) {
                    failureCode[0] = errorCode;
                    error[0] = "系统拒绝了这次截图（错误码 " + errorCode + "）。"
                        + "常见原因：界面正在被其他应用覆盖，或者锁屏了。";
                    latch.countDown();
                }
            });
        } catch (Throwable throwable) {
            failure[0] = "调用截图失败：" + ShellProcess.describe(throwable);
            return null;
        }

        try {
            latch.await(6000, TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        if (holder[0] == null) {
            failure[0] = error[0] == null ? "截图没有返回结果（超时）。" : error[0];
            return null;
        }
        return holder[0];
    }

    String back() {
        return globalAction(GLOBAL_ACTION_BACK, "返回");
    }

    String home() {
        return globalAction(GLOBAL_ACTION_HOME, "回到桌面");
    }

    /** 打开最近任务。键名「任务」会走这里。 */
    String recents() {
        return globalAction(GLOBAL_ACTION_RECENTS, "打开最近任务");
    }

    private String globalAction(int action, String label) {
        try {
            boolean ok = performGlobalAction(action);
            return ok ? (label + " 完成。") : (label + " 失败：系统拒绝了这次操作。");
        } catch (Throwable error) {
            return label + " 失败：" + ShellProcess.describe(error);
        }
    }

    /**
     * 往当前输入框写文字。
     *
     * <p>用 {@code ACTION_SET_TEXT} 而不是模拟按键：中文、emoji、长文本都能一次写完，
     * 也不会弹输入法盖住界面。这是无障碍后端相对命令后端的关键优势。
     */
    String type(String text) {
        if (text == null || text.isEmpty()) return "没有要输入的内容。";
        AccessibilityNodeInfo target = findEditableNode();
        if (target == null) return "没找到可以输入的地方。请先点一下输入框，再让我输入。";
        try {
            Bundle arguments = new Bundle();
            arguments.putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                text
            );
            boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
            String via = "赋值";
            if (!ok) {
                // SET_TEXT 被拒（银行 / OTP 类输入框常见）→ 剪贴板粘贴兜底；
                // 会覆盖用户剪贴板，所以只在赋值失败这一条路上使用。
                ok = pasteInto(target, text);
                via = "粘贴";
            }
            if (!ok) {
                return "输入失败：输入框既不接受赋值也不接受粘贴（可能被安全键盘或输入法接管）。"
                    + "请先点击输入框获取焦点，再重试一次。";
            }
            String readback = readbackAfterInput(target);
            if (readback == null) {
                return "已通过" + via + "写入 " + text.length() + " 个字符，但无法读回确认（节点已失效）。";
            }
            boolean match = via.equals("粘贴") ? readback.contains(text) : readback.equals(text);
            if (match) {
                return "已输入 " + text.length() + " 个字符（读回一致）。";
            }
            if (readback.isEmpty()) {
                return "已写入 " + text.length() + " 个字符；输入框读回为空 —— 可能是密码框（内容不回显），"
                    + "请用「手机查看界面」或人工确认，不要盲目重输。";
            }
            return "输入可能未生效：读回内容为“" + trim(readback, 60) + "”，与预期不一致。"
                + "请先用「手机查看界面」确认，再决定是否重新输入。";
        } catch (Throwable error) {
            return "输入失败：" + ShellProcess.describe(error);
        } finally {
            recycle(target);
        }
    }

    /** SET_TEXT 被拒时的兜底：写剪贴板 + ACTION_PASTE。 */
    private boolean pasteInto(AccessibilityNodeInfo target, String text) {
        try {
            android.content.ClipboardManager cm = (android.content.ClipboardManager)
                getSystemService(android.content.Context.CLIPBOARD_SERVICE);
            if (cm == null) return false;
            cm.setPrimaryClip(android.content.ClipData.newPlainText(null, text));
            return target.performAction(AccessibilityNodeInfo.ACTION_PASTE);
        } catch (Throwable error) {
            return false;
        }
    }

    /** 输入后读回输入框内容；读不到（节点失效 / 不回显）返回 null。 */
    private String readbackAfterInput(AccessibilityNodeInfo target) {
        try {
            Thread.sleep(150);
            if (!target.refresh()) return null;
            CharSequence after = target.getText();
            return after == null ? "" : after.toString();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return null;
        } catch (Throwable error) {
            return null;
        }
    }

    /** 找当前有焦点的可编辑节点；没有焦点就退而找界面上第一个可编辑节点。 */
    private AccessibilityNodeInfo findEditableNode() {
        return findEditableNode(android.view.Display.DEFAULT_DISPLAY);
    }

    /** 在指定显示器上找可输入节点；副屏上的输入框不在默认屏的焦点树里。 */
    private AccessibilityNodeInfo findEditableNode(int displayId) {
        AccessibilityNodeInfo root = null;
        try {
            root = displayId == android.view.Display.DEFAULT_DISPLAY
                ? getRootInActiveWindow()
                : pickReadableRoot(displayId);
        } catch (Throwable ignored) {
            // 下面统一按"找不到"处理
        }
        if (root == null) return null;

        AccessibilityNodeInfo focused = null;
        try {
            focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        } catch (Throwable ignored) {
            // 忽略
        }
        if (focused != null && focused.isEditable()) return focused;
        recycle(focused);

        AccessibilityNodeInfo found = findFirstEditable(root, 0);
        recycle(root);
        return found;
    }

    /**
     * 往指定显示器的输入框写文字。
     *
     * <p>返回 {@code null} 表示写成功；否则是给上层看的原因。
     * 后台方式优先用它而不是剪贴板粘贴：副屏上的输入框只有无障碍能定向写，
     * 粘贴依赖剪贴板且会打断用户自己的复制内容。
     */
    String setTextOnDisplay(int displayId, String text) {
        if (text == null || text.isEmpty()) return "没有要输入的内容。";
        AccessibilityNodeInfo target = findEditableNode(displayId);
        if (target == null) return "副屏上没找到可输入的地方（请先点一下输入框）。";
        try {
            Bundle arguments = new Bundle();
            arguments.putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                text
            );
            boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
            if (!ok) ok = pasteInto(target, text);
            return ok ? null : "副屏输入框既不接受赋值也不接受粘贴。";
        } catch (Throwable error) {
            return "副屏输入失败：" + ShellProcess.describe(error);
        } finally {
            recycle(target);
        }
    }

    private AccessibilityNodeInfo findFirstEditable(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > MAX_DEPTH) return null;
        if (node.isEditable() && node.isEnabled()) return AccessibilityNodeInfo.obtain(node);
        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = null;
            try {
                child = node.getChild(i);
            } catch (Throwable ignored) {
                // 界面刷新中，跳过
            }
            if (child == null) continue;
            AccessibilityNodeInfo found = findFirstEditable(child, depth + 1);
            recycle(child);
            if (found != null) return found;
        }
        return null;
    }

    /**
     * 按资源 id 点击。
     *
     * <p>现实里大量应用把可点区域包在文字外层，目标节点本身 {@code isClickable()} 是 false，
     * 所以找不到就沿父链向上找最近的可点祖先 —— 不做这一步会有一半的 id 点不动。
     */
    String clickById(String id) {
        String raw = id == null ? "" : id.trim();
        if (raw.isEmpty()) return "没有给出控件 id。";
        String full = raw.contains(":id/") ? raw : null;

        AccessibilityNodeInfo root = null;
        try {
            root = getRootInActiveWindow();
        } catch (Throwable ignored) {
            // 下面按找不到处理
        }
        if (root == null) return "读不到当前界面，没法按 id 查找。";

        try {
            List<AccessibilityNodeInfo> matches = full != null
                ? root.findAccessibilityNodeInfosByViewId(full)
                : findByIdSuffix(root, raw);
            if (matches == null || matches.isEmpty()) {
                return "界面上没有 id 含「" + raw + "」的元素。可以先让我读一次界面看有哪些 id。";
            }
            AccessibilityNodeInfo node = matches.get(0);
            AccessibilityNodeInfo clickable = nearestClickable(node);
            boolean ok = clickable != null && clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            for (AccessibilityNodeInfo match : matches) recycle(match);
            if (clickable != null && clickable != node) recycle(clickable);
            return ok ? ("已点击 id 含「" + raw + "」的元素。") : "找到元素了，但它不接受点击。";
        } catch (Throwable error) {
            return "按 id 点击失败：" + ShellProcess.describe(error);
        } finally {
            recycle(root);
        }
    }

    private static AccessibilityNodeInfo nearestClickable(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node;
        int guard = 0;
        while (current != null && guard++ < 12) {
            if (current.isClickable() && current.isEnabled()) return current;
            AccessibilityNodeInfo parent = null;
            try {
                parent = current.getParent();
            } catch (Throwable ignored) {
                return null;
            }
            if (parent == null) return null;
            if (current != node) recycle(current);
            current = parent;
        }
        return null;
    }

    private List<AccessibilityNodeInfo> findByIdSuffix(AccessibilityNodeInfo root, String suffix) {
        List<AccessibilityNodeInfo> hits = new ArrayList<>();
        Deque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        int guard = 0;
        while (!queue.isEmpty() && hits.size() < 40 && guard++ < 4000) {
            AccessibilityNodeInfo node = queue.poll();
            String viewId = node.getViewIdResourceName();
            if (viewId != null && viewId.endsWith(suffix)) hits.add(AccessibilityNodeInfo.obtain(node));
            int count = node.getChildCount();
            for (int i = 0; i < count; i++) {
                AccessibilityNodeInfo child = null;
                try {
                    child = node.getChild(i);
                } catch (Throwable ignored) {
                    // 跳过
                }
                if (child != null) queue.add(child);
            }
            recycle(node);
        }
        return hits;
    }
}
