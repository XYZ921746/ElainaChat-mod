package com.elainachat.mod;

import android.app.Notification;
import android.content.ComponentName;
import android.content.Context;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.text.TextUtils;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;

/**
 * 通知读取。
 *
 * <p>为什么需要一个 Service：Android 不允许应用"直接读通知" —— 唯一的合法途径是
 * 申请**通知使用权**（Notification Listener），系统会在用户授权后把通知投递进来。
 * 所以这个类本质是一个"接收 + 缓存"的服务，{@link DeviceInfoReader} 只负责把
 * 缓存里的内容交给 AI。
 *
 * <p>隐私边界（这是整个功能里最敏感的一项）：
 * <ul>
 *   <li>通知里可能是验证码、私聊内容、银行提醒 —— 它是本功能里隐私密度最高的一类。</li>
 *   <li>用户可以在「设置 → 能力 → 手机操作 → 读取信息」里单独关掉"通知内容"，
 *       关掉后前端不注入标签、执行时直接拒绝（两道闸）。</li>
 *   <li>系统层面用户可以在系统设置里撤销通知使用权，那样本服务根本收不到东西。</li>
 * </ul>
 *
 * <p>缓存策略：只留最近 {@link #MAX_KEEP} 条，且**只在内存里**（不落盘）——
 * 通知内容没必要持久化，重启即清空是更安全的默认。
 */
public class ElainaNotificationListener extends NotificationListenerService {

    /** 最多缓存多少条。够 AI 回答"我刚收到什么消息"，又不至于把一堆历史隐私堆在内存里。 */
    private static final int MAX_KEEP = 40;

    /** 内存缓存：新的在后。进程被杀就没了 —— 刻意的，通知不该落盘。 */
    private static final LinkedList<String> RECENT = new LinkedList<>();

    /** 最近一次收到通知的时刻（用于给用户看"读取是否真的在工作"） */
    private static volatile long lastEventAt = 0L;

    /** 服务当前连上了没有。系统绑定成功时会回调 onListenerConnected。 */
    private static volatile boolean connected = false;

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        connected = true;
    }

    @Override
    public void onListenerDisconnected() {
        super.onListenerDisconnected();
        connected = false;
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn == null) return;
        try {
            String pkg = String.valueOf(sbn.getPackageName());
            // 本应用自己的通知不入缓存：AI 看到自己发的通知只会自我循环。
            if (pkg.equals(getPackageName())) return;

            Bundle extras = sbn.getNotification() == null ? null : sbn.getNotification().extras;
            if (extras == null) return;

            String title = text(extras.getCharSequence(Notification.EXTRA_TITLE));
            String body = text(extras.getCharSequence(Notification.EXTRA_TEXT));
            if (title.isEmpty() && body.isEmpty()) return;   // 纯进度类通知没有内容，跳过

            String when = new SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())
                .format(new Date(sbn.getPostTime()));
            String label = appLabel(pkg);
            String line = "[" + when + "] " + label + "：" + title
                + (body.isEmpty() ? "" : " —— " + clip(body, 160));

            synchronized (RECENT) {
                RECENT.addLast(line);
                while (RECENT.size() > MAX_KEEP) RECENT.removeFirst();
            }
            lastEventAt = System.currentTimeMillis();
        } catch (Throwable error) {
            // 通知读取失败绝不能崩掉系统服务 —— 那会让整个通知栏出问题
        }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        // 用户划掉通知不做处理：缓存的是"来过什么"，不是"当前通知栏里有什么"。
    }

    // 给 DeviceInfoReader 用

    /** 最近的通知（新的在后）。 */
    static List<String> recentLines() {
        synchronized (RECENT) {
            return new ArrayList<>(RECENT);
        }
    }

    static long lastEventAt() {
        return lastEventAt;
    }

    /** 通知使用权是否已授予（这是系统设置里的开关，不是运行时权限）。 */
    static boolean isEnabled(Context context) {
        try {
            String flat = Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners");
            if (TextUtils.isEmpty(flat)) return false;
            String me = new ComponentName(context, ElainaNotificationListener.class).flattenToString();
            String meShort = new ComponentName(context, ElainaNotificationListener.class).flattenToShortString();
            return flat.contains(me) || flat.contains(meShort);
        } catch (Throwable error) {
            return false;
        }
    }

    private String appLabel(String pkg) {
        try {
            android.content.pm.PackageManager pm = getPackageManager();
            android.content.pm.ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            return String.valueOf(pm.getApplicationLabel(info));
        } catch (Throwable error) {
            return pkg;
        }
    }

    private static String text(CharSequence value) {
        return value == null ? "" : value.toString().trim();
    }

    private static String clip(String value, int max) {
        if (value == null) return "";
        String flat = value.replace('\n', ' ').trim();
        return flat.length() <= max ? flat : flat.substring(0, max) + "…";
    }
}
