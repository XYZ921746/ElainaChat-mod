package com.elainachat.mod;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * AI 操作手机时的**系统级悬浮窗**。
 *
 * <p>为什么必须有它：手机操作的授权确认原本走应用内的弹窗，于是出现这个死循环 ——
 * <pre>
 *   AI 点击目标 App 的按钮
 *     → 弹授权框（在 ElainaChat 内部）
 *     → 用户切回 ElainaChat 点「允许」
 *     → 切回来这一步把目标 App 切到后台，那次点击落到错的位置或直接失败
 *     → AI 重试 → 又弹窗 …
 * </pre>
 * 悬浮窗是唯一能打破它的东西：它浮在**目标 App 之上**，用户不用离开当前界面
 * 就能看到 AI 在做什么、随时点「停止」，需要确认时也能就地确认。
 *
 * <p>权限：{@code SYSTEM_ALERT_WINDOW}（即系统设置里的「显示在其他应用上层」）。
 * 这是 Android 官方的悬浮窗权限，minSdk 29 起用 {@link WindowManager.LayoutParams#TYPE_APPLICATION_OVERLAY}。
 * 用户没授权时用 {@link #requestPermission} 跳到系统设置页。
 *
 * <p>本类**不持有 Activity**：窗口挂在 ApplicationContext 上，
 * 所以应用退到后台、甚至页面被回收，悬浮窗都还在（这正是"随时能停"的前提）。
 */
final class ElainaOverlay {

    private static final String TAG = "ElainaOverlay";

    /** 全局单例：同一时刻只该有一个悬浮窗（多个会互相盖住、也没意义） */
    private static ElainaOverlay instance;

    // show() 之前到达的调用在这里排队
    //
    // 为什么需要：show() 是 post 到主线程的，而 updateStep / askApproval 会**立刻**读
    // instance。真机实测（adb 连发 show + updateOverlay + askOverlayApproval）：
    // 那三个调用都先于主线程执行 show 的 task，instance 还是 null，
    // 更新被直接丢弃 —— 表现为"副标题停在初始文案、确认按钮不出现"。
    // 真实场景里 AI 的操作间隔长不容易撞上，但"点允许没反应"是不可接受的，所以必须修。
    private static String pendingStep;
    private static String pendingAction;
    private static Runnable pendingOnApprove;
    private static Runnable pendingOnDeny;
    private static Runnable pendingOnStop;

    private final Context context;
    private final WindowManager windowManager;
    private final Handler main = new Handler(Looper.getMainLooper());

    private View root;
    private TextView titleView;
    private TextView stepView;
    private TextView stopButton;
    private TextView approveButton;
    private TextView denyButton;

    private Runnable onStop;
    private Runnable onApprove;
    private Runnable onDeny;

    private ElainaOverlay(Context context) {
        this.context = context.getApplicationContext();
        this.windowManager = (WindowManager) this.context.getSystemService(Context.WINDOW_SERVICE);
    }

    // 权限

    /** 悬浮窗权限是否已授予。未授予时任何 show 调用都是无声失败，所以调用方要先查。 */
    static boolean canDraw(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;   // 6.0 以下默认允许
        try {
            return Settings.canDrawOverlays(context);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 跳到系统的悬浮窗授权页。
     *
     * <p>注意这是**系统设置页**，不是运行时权限对话框 —— 悬浮窗权限属于"特殊权限"，
     * 只能由用户在设置里手动打开，应用无法直接弹框索取。所以这里的做法是跳过去，
     * 用户回来后我们再重新检测（前端会重新调 status）。
     */
    static void requestPermission(Context context) {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Throwable t) {
            // 少数 ROM 没有这个页面，退回应用详情页
            try {
                Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + context.getPackageName()));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(fallback);
            } catch (Throwable ignored) { /* 真没办法了就静默失败，前端会提示用户手动去设置 */ }
        }
    }

    // 生命周期

    /**
     * 显示（或更新）悬浮窗。
     *
     * @param text         当前在做什么，例如「AI 正在操作：微信」
     * @param onStop       点「停止」时回调（在主线程）
     */
    static void show(Context context, String text, Runnable onStop) {
        if (!canDraw(context)) return;
        final Context app = context.getApplicationContext();
        final Runnable task = () -> {
            // 前端每开始一步都会再调一次 show()；若每次都**无条件** setStep(text)，
            //   已经显示着的浮层会被重置回初始文案（"AI 正在操作手机"），
            //   副标题来回跳 —— 用户看到的就是"一直在闪"。
            //   所以只在"这次才刚建出窗口"、或确实有排队的新文案时才写这一行。
            final boolean alreadyShown = instance != null && instance.root != null;
            if (instance == null) instance = new ElainaOverlay(app);
            instance.ensureShown();
            instance.setOnStop(pendingOnStop != null ? pendingOnStop : onStop);
            if (!alreadyShown || pendingStep != null) {
                instance.setStep(pendingStep != null ? pendingStep : text);
            }
            if (pendingAction != null) {
                instance.setOnApprove(pendingOnApprove);
                instance.setOnDeny(pendingOnDeny);
                instance.setPending(pendingAction);
            } else {
                instance.setPending(null);
            }
            // 排队的东西都应用完了，清掉（但保留 onStop —— 它是整个会话的回调）
            pendingStep = null;
            pendingAction = null;
            pendingOnApprove = null;
            pendingOnDeny = null;
        };
        pendingOnStop = onStop;
        if (pendingStep == null) pendingStep = text;   // updateStep 先到时保留它
        // WindowManager 必须在主线程操作
        if (Looper.myLooper() == Looper.getMainLooper()) task.run();
        else new Handler(Looper.getMainLooper()).post(task);
    }

    /** 更新"正在做什么"。悬浮窗还没显示时先记下来，show() 时一起应用。 */
    static void updateStep(String text) {
        pendingStep = text;
        final ElainaOverlay it = instance;
        if (it == null) return;
        it.main.post(() -> it.setStep(text));
    }

    /**
     * 请求用户就地确认某个操作（悬浮窗上直接出现「允许/拒绝」两个按钮）。
     *
     * <p>这是打破死循环的关键：用户在**当前这个 App 的界面上**就能点允许，
     * 不需要切回 ElainaChat —— 也就不会把目标 App 切到后台。
     *
     * <p>悬浮窗还没显示时先记下来，show() 时一起应用 ——
     * 不再直接 onDeny（那会让用户莫名其妙被拒绝一次）。
     */
    static void askApproval(String action, Runnable onApprove, Runnable onDeny) {
        pendingAction = action;
        pendingOnApprove = onApprove;
        pendingOnDeny = onDeny;
        final ElainaOverlay it = instance;
        if (it == null) return;   // show() 稍后会把这些应用上
        it.main.post(() -> {
            it.setOnApprove(onApprove);
            it.setOnDeny(onDeny);
            it.setPending(action);
        });
    }

    /** 收起悬浮窗。运行结束、用户停止、或总开关关掉时调用。 */
    static void hide() {
        // 排队中的更新一并作废 —— 否则 hide 之后 show 一个新会话，
        // 旧会话的 step/action 会"复活"到新浮层上
        pendingStep = null;
        pendingAction = null;
        pendingOnApprove = null;
        pendingOnDeny = null;
        pendingOnStop = null;
        final ElainaOverlay it = instance;
        if (it == null) return;
        it.main.post(it::tearDown);
    }

    /** 是否有悬浮窗正在显示 */
    static boolean isShowing() {
        return instance != null && instance.root != null;
    }

    // 内部实现

    private void ensureShown() {
        if (root != null) return;
        try {
            root = buildView();
            windowManager.addView(root, buildParams());
        } catch (Throwable t) {
            root = null;   // 加窗失败（权限被撤、ROM 限制）就当没显示，不抛给上层
        }
    }

    private WindowManager.LayoutParams buildParams() {
        final int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        final int flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS;
        WindowManager.LayoutParams p = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type, flags, PixelFormat.TRANSLUCENT);
        p.gravity = Gravity.TOP | Gravity.START;
        p.x = dp(12);
        p.y = dp(80);
        // 给一个最小宽度，否则 WRAP_CONTENT 会按文字固有宽度算得很窄，
        // 「停止」按钮再一挤，两者就重叠（真机实测总宽只有 268px）。
        // 用"屏幕宽度与 320dp 取小"而不是写死 px —— 横屏/平板上才不会超出屏幕。
        try {
            final int screenW = context.getResources().getDisplayMetrics().widthPixels;
            p.width = Math.min(dp(320), Math.max(dp(200), screenW - dp(24)));
        } catch (Throwable ignored) { /* 拿不到就交给 WRAP_CONTENT */ }
        return p;
    }

    private View buildView() {
        LinearLayout box = new LinearLayout(context);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(12), dp(10), dp(12), dp(10));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#EE1C192A"));            // 半透明深色，不挡视线
        bg.setCornerRadius(dp(16));
        bg.setStroke(dp(1), Color.parseColor("#33FFFFFF"));
        box.setBackground(bg);
        box.setElevation(dp(8));

        // 第一行：状态点 + 文字
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        View dot = new View(context);
        GradientDrawable dotBg = new GradientDrawable();
        dotBg.setShape(GradientDrawable.OVAL);
        dotBg.setColor(Color.parseColor("#34D399"));
        dot.setBackground(dotBg);
        LinearLayout.LayoutParams dotLp = new LinearLayout.LayoutParams(dp(8), dp(8));
        dotLp.rightMargin = dp(8);
        row.addView(dot, dotLp);

        LinearLayout texts = new LinearLayout(context);
        texts.setOrientation(LinearLayout.VERTICAL);
        // 让文字区可以真正压缩：不设 minWidth 的话，TextView 的固有宽度会把
        // 「停止」按钮挤出屏幕（实测悬浮窗总宽只有 268px，文字和按钮直接重叠）。
        texts.setMinimumWidth(0);

        titleView = new TextView(context);
        titleView.setText("AI 正在操作手机");
        titleView.setTextColor(Color.parseColor("#EDFFFFFF"));
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        titleView.setMaxLines(1);
        titleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        texts.addView(titleView);

        stepView = new TextView(context);
        stepView.setTextColor(Color.parseColor("#80FFFFFF"));
        stepView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        stepView.setMaxLines(2);
        stepView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        texts.addView(stepView);

        // weight=1 让文字占满剩余空间，按钮拿到它需要的固定宽度 —— 两者不再抢位置
        LinearLayout.LayoutParams textLp = new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        textLp.rightMargin = dp(8);   // 与「停止」之间留出呼吸，别贴在一起
        row.addView(texts, textLp);

        stopButton = makeButton("停止", "#F43F5E", "#FFFFFF");
        stopButton.setOnClickListener(v -> {
            Runnable cb = onStop;
            if (cb != null) cb.run();
        });
        row.addView(stopButton);

        box.addView(row);

        // 第二行：审批按钮（平时隐藏，需要确认时才出现）
        LinearLayout actions = new LinearLayout(context);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.END);
        actions.setVisibility(View.GONE);
        actions.setTag("actions");

        denyButton = makeButton("拒绝", "#3FFFFFFF", "#EDFFFFFF");
        denyButton.setOnClickListener(v -> {
            Runnable cb = onDeny;
            setPending(null);          // 先收起按钮，避免重复点
            if (cb != null) cb.run();
        });
        LinearLayout.LayoutParams denyLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        denyLp.rightMargin = dp(6);
        actions.addView(denyButton, denyLp);

        approveButton = makeButton("允许", "#34D399", "#0B1020");
        approveButton.setOnClickListener(v -> {
            Runnable cb = onApprove;
            setPending(null);
            if (cb != null) cb.run();
        });
        actions.addView(approveButton);

        box.addView(actions);

        // 拖动：整块可拖，避免挡住目标 App 的关键区域
        attachDrag(box);
        return box;
    }

    /**
     * 造一个按钮。
     *
     * <p>用 {@link TextView} 而不是 {@link Button}：Button 会套用主题里的
     * 最小宽度 / 背景 inset（app 主题的 buttonStyle 自带左右各 ~16dp 的 inset），
     * 即使 setBackground 换掉了外观，**布局阶段仍按主题的 minWidth 参与测量** ——
     * 结果就是它在 WRAP_CONTENT 的浮层里把文字区挤没，实测两者直接重叠。
     * TextView + 自己的背景 + clickable 完全没有这些包袱，尺寸可预期。
     */
    private TextView makeButton(String label, String bgColor, String textColor) {
        TextView b = new TextView(context);
        b.setText(label);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        b.setTextColor(Color.parseColor(textColor));
        b.setGravity(Gravity.CENTER);
        GradientDrawable g = new GradientDrawable();
        g.setColor(Color.parseColor(bgColor));
        g.setCornerRadius(dp(12));
        b.setBackground(g);
        // 内边距给足，点击区域不小于 40dp 高（手指点得中）
        b.setPadding(dp(14), dp(7), dp(14), dp(7));
        b.setClickable(true);
        b.setFocusable(true);
        return b;
    }

    /** 按住空白处拖动整个悬浮窗（按钮上的点击不受影响） */
    private void attachDrag(View view) {
        final int[] start = new int[2];
        view.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                WindowManager.LayoutParams lp = (WindowManager.LayoutParams) root.getLayoutParams();
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        start[0] = (int) event.getRawX() - lp.x;
                        start[1] = (int) event.getRawY() - lp.y;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        lp.x = (int) event.getRawX() - start[0];
                        lp.y = (int) event.getRawY() - start[1];
                        try { windowManager.updateViewLayout(root, lp); } catch (Throwable ignored) { }
                        return true;
                    default:
                        return false;
                }
            }
        });
    }

    private void setOnStop(Runnable cb) { onStop = cb; }
    private void setOnApprove(Runnable cb) { onApprove = cb; }
    private void setOnDeny(Runnable cb) { onDeny = cb; }

    private void setStep(String text) {
        if (stepView == null) return;
        stepView.setText(text == null || text.isEmpty() ? "" : text);
    }

    /** action 为 null → 收起审批按钮；非 null → 显示按钮并把待确认的操作写进第二行 */
    private void setPending(String action) {
        if (root == null) return;
        View actions = root.findViewWithTag("actions");
        if (actions == null) return;
        if (action == null) {
            actions.setVisibility(View.GONE);
            if (titleView != null) titleView.setText("AI 正在操作手机");
        } else {
            actions.setVisibility(View.VISIBLE);
            if (titleView != null) titleView.setText("需要你确认");
            if (stepView != null) stepView.setText(action);
        }
    }

    private void tearDown() {
        if (root != null) {
            try { windowManager.removeView(root); } catch (Throwable ignored) { }
            root = null;
        }
        onStop = null;
        onApprove = null;
        onDeny = null;
        instance = null;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                context.getResources().getDisplayMetrics()));
    }
}
