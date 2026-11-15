package com.elainachat.mod;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.provider.CalendarContract;
import android.provider.ContactsContract;
import android.provider.Settings;

import com.getcapacitor.JSObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 手机的「读取信息」能力（★ 2026-10 新增）。
 *
 * <p>用户要求："添加文件访问…读取应用和读取通知的权限这些信息在对话中用的上"。
 * 于是把这几类信息变成 AI 能读的东西：
 * <ul>
 *   <li>{@code 手机应用列表} —— 装了哪些应用（包名 + 应用名）</li>
 *   <li>{@code 手机通知}     —— 最近收到的通知（由 {@link ElainaNotificationListener} 缓存）</li>
 *   <li>{@code 手机设备信息} —— 电量、网络、前台应用、屏幕</li>
 *   <li>{@code 手机短信}     —— 最近短信</li>
 *   <li>{@code 手机通讯录}   —— 联系人（可按关键词筛选）</li>
 *   <li>{@code 手机日历}     —— 近期日程</li>
 * </ul>
 *
 * <p>★★ 两条独立的安全边界，缺一不可 —— 这是本类最重要的设计点：
 * <ol>
 *   <li><b>应用层</b>：设置里的隐私开关（{@code agentReadSms} 等）。关掉后前端
 *       连标签都不注入给模型，且 {@code runAgentPhoneOperation} 会直接拒绝。</li>
 *   <li><b>系统层</b>：Android 运行时权限。短信/通讯录/日历/通知读取都必须由
 *       用户在系统弹窗里授权。**本类不主动申请权限**，只如实报告"没有权限" ——
 *       申请动作由用户点「读取信息」里对应条目右侧的状态标记触发
 *       （见 {@code requestReadPermission} 与前端 handleAgentPermBadgeAction），
 *       因为静默弹权限框会让用户莫名其妙。</li>
 * </ol>
 * 所以"没有权限"和"用户关了开关"是两种不同的失败，本类只负责前者。
 */
final class DeviceInfoReader {

    private final Context context;

    DeviceInfoReader(Context context) {
        this.context = context;
    }

    /** 这个动作归本类管吗 */
    static boolean handles(String action) {
        switch (action) {
            case "手机应用列表":
            case "手机通知":
            case "手机设备信息":
            case "手机短信":
            case "手机通讯录":
            case "手机日历":
                return true;
            default:
                return false;
        }
    }

    /** 该动作需要的系统权限（null = 不需要）。用于报告状态与引导申请。 */
    static String requiredPermission(String action) {
        switch (action) {
            case "手机短信": return Manifest.permission.READ_SMS;
            case "手机通讯录": return Manifest.permission.READ_CONTACTS;
            case "手机日历": return Manifest.permission.READ_CALENDAR;
            // 通知不走运行时权限，走"通知使用权"（系统设置里的开关），单独判断
            default: return null;
        }
    }

    /** 系统权限现状，供设置页显示"哪一项还没授权" */
    JSObject permissionStatus() {
        JSObject out = new JSObject();
        out.put("sms", granted(Manifest.permission.READ_SMS));
        out.put("contacts", granted(Manifest.permission.READ_CONTACTS));
        out.put("calendar", granted(Manifest.permission.READ_CALENDAR));
        // 通知读取不是运行时权限：它由"通知使用权"控制
        out.put("notifications", ElainaNotificationListener.isEnabled(context));
        // 已安装应用列表在 Android 11+ 需要 QUERY_ALL_PACKAGES（清单里已声明，属安装期权限）
        out.put("apps", true);
        return out;
    }

    private boolean granted(String permission) {
        if (permission == null) return true;
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** 统一的权限拒绝文案：告诉用户**去哪开**，而不是只说"没有权限" */
    private String permissionDenied(String action, String permission) {
        String where;
        switch (action) {
            case "手机短信": where = "「短信」"; break;
            case "手机通讯录": where = "「通讯录」"; break;
            case "手机日历": where = "「日历」"; break;
            default: where = "对应权限"; break;
        }
        // ★★ 2026-10 修：申请入口已从「申请权限」按钮改成**可点的状态标记**
        //   （见 index.html 的 .agent-perm-badge / app-03-agent.js 的
        //   handleAgentPermBadgeAction）。这段文案会作为失败原因回灌给模型，
        //   模型再复述给用户 —— 不跟着改，用户就被引去点一个**已经不存在的按钮**。
        return "没有权限读取" + where + "。请到「设置 → 能力 → 手机操作 → 读取信息」里，"
            + "点对应条目右侧那个写着「未授权」的小标记申请；如果系统不再弹框（拒绝过多次），"
            + "需要到系统的「设置 → 应用 → ElainaChat Mod → 权限」里手动打开。";
    }

    JSObject run(String action, String args) {
        try {
            switch (action) {
                case "手机应用列表": return success(listApps());
                case "手机通知": return success(listNotifications());
                case "手机设备信息": return success(deviceInfo());
                case "手机短信": return success(listSms(args));
                case "手机通讯录": return success(listContacts(args));
                case "手机日历": return success(listCalendar(args));
                default: return failure("不支持的读取动作：" + action);
            }
        } catch (SecurityException error) {
            String permission = requiredPermission(action);
            return failure(permissionDenied(action, permission));
        } catch (Throwable error) {
            return failure("读取「" + action + "」失败：" + ShellProcess.describe(error));
        }
    }

    // ==================== 已安装应用列表 ====================

    private String listApps() {
        PackageManager pm = context.getPackageManager();
        List<ApplicationInfo> apps = pm.getInstalledApplications(0);
        List<String> lines = new ArrayList<>();
        for (ApplicationInfo info : apps) {
            // 只列**用户能启动**的应用：系统里大量没有启动入口的组件列出来只是噪音，
            // 而 AI 要这个列表的目的是"知道该启动哪个包名"。
            Intent launch = pm.getLaunchIntentForPackage(info.packageName);
            if (launch == null) continue;
            String label = String.valueOf(pm.getApplicationLabel(info));
            lines.add(label + " | " + info.packageName);
        }
        lines.sort(String::compareTo);
        if (lines.isEmpty()) return "没有找到可启动的应用。";
        return "已安装应用（共 " + lines.size() + " 个，格式：应用名 | 包名）：\n" + String.join("\n", lines);
    }

    // ==================== 通知 ====================

    private String listNotifications() {
        if (!ElainaNotificationListener.isEnabled(context)) {
            return "没有「通知使用权」。请到「设置 → 能力 → 手机操作 → 读取信息」点「开启通知读取」，"
                + "在系统页面里找到本应用并打开开关。";
        }
        List<String> lines = ElainaNotificationListener.recentLines();
        if (lines.isEmpty()) {
            return "最近没有收到通知（或者通知读取刚开启，还没有新通知进来）。";
        }
        return "最近的通知（新的在下）：\n" + String.join("\n", lines);
    }

    // ==================== 设备与前台状态 ====================

    private String deviceInfo() {
        StringBuilder sb = new StringBuilder();
        sb.append("设备：").append(Build.MODEL)
            .append("（Android ").append(Build.VERSION.RELEASE)
            .append("，API ").append(Build.VERSION.SDK_INT).append("）\n");
        sb.append("屏幕：").append(screenSizeText()).append("\n");
        sb.append("电量：").append(batteryText()).append("\n");
        sb.append("网络：").append(networkText()).append("\n");
        // 前台应用：无障碍服务在运行就能拿到（它本来就在监听窗口变化）
        String foreground = ElainaAccessibilityService.isRunning()
            ? ElainaAccessibilityService.foregroundPackage()
            : "";
        if (foreground == null || foreground.isEmpty()) {
            sb.append("前台应用：读不到（需要开启无障碍服务）");
        } else {
            sb.append("前台应用：").append(describePackage(foreground));
        }
        return sb.toString();
    }

    private String screenSizeText() {
        try {
            android.util.DisplayMetrics metrics = android.content.res.Resources.getSystem().getDisplayMetrics();
            return metrics.widthPixels + " × " + metrics.heightPixels + "（密度 " + metrics.densityDpi + "）";
        } catch (Throwable error) {
            return "未知";
        }
    }

    private String batteryText() {
        try {
            IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
            Intent status = context.registerReceiver(null, filter);
            if (status == null) return "未知";
            int level = status.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = status.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level < 0 || scale <= 0) return "未知";
            int percent = Math.round(level * 100f / scale);
            int plugged = status.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
            return percent + "%" + (plugged != 0 ? "（充电中）" : "");
        } catch (Throwable error) {
            return "未知";
        }
    }

    private String networkText() {
        try {
            android.net.ConnectivityManager cm =
                (android.net.ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return "未知";
            android.net.Network active = cm.getActiveNetwork();
            if (active == null) return "未连接";
            android.net.NetworkCapabilities caps = cm.getNetworkCapabilities(active);
            if (caps == null) return "未连接";
            if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) return "Wi-Fi";
            if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)) return "移动数据";
            if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)) return "有线";
            return "已连接（其它类型）";
        } catch (Throwable error) {
            return "未知";
        }
    }

    /** 包名 → "应用名（包名）"，让模型和用户都看得懂 */
    private String describePackage(String pkg) {
        try {
            PackageManager pm = context.getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            return pm.getApplicationLabel(info) + "（" + pkg + "）";
        } catch (Throwable error) {
            return pkg;
        }
    }

    // ==================== 短信 ====================

    private String listSms(String args) {
        if (!granted(Manifest.permission.READ_SMS)) {
            return permissionDenied("手机短信", Manifest.permission.READ_SMS);
        }
        int limit = clamp(parseInt(args, 10), 1, 50);
        List<String> lines = new ArrayList<>();
        SimpleDateFormat fmt = new SimpleDateFormat("MM-dd HH:mm", Locale.getDefault());
        try (Cursor cursor = context.getContentResolver().query(
                Uri.parse("content://sms/inbox"),
                new String[]{"address", "body", "date"},
                null, null, "date DESC")) {
            if (cursor == null) return "读不到短信（系统返回空）。";
            while (cursor.moveToNext() && lines.size() < limit) {
                String address = cursor.getString(0);
                String body = cursor.getString(1);
                long date = cursor.getLong(2);
                lines.add("[" + fmt.format(new Date(date)) + "] " + safe(address) + "：" + clip(safe(body), 200));
            }
        }
        if (lines.isEmpty()) return "收件箱里没有短信。";
        return "最近 " + lines.size() + " 条短信（新的在前）：\n" + String.join("\n", lines);
    }

    // ==================== 通讯录 ====================

    private String listContacts(String args) {
        if (!granted(Manifest.permission.READ_CONTACTS)) {
            return permissionDenied("手机通讯录", Manifest.permission.READ_CONTACTS);
        }
        String keyword = String.valueOf(args == null ? "" : args).trim();
        List<String> lines = new ArrayList<>();
        String selection = null;
        String[] selectionArgs = null;
        if (!keyword.isEmpty()) {
            selection = ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?";
            selectionArgs = new String[]{"%" + keyword + "%"};
        }
        try (Cursor cursor = context.getContentResolver().query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                new String[]{
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER
                },
                selection, selectionArgs,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC")) {
            if (cursor == null) return "读不到通讯录（系统返回空）。";
            while (cursor.moveToNext() && lines.size() < 200) {
                String name = safe(cursor.getString(0));
                String number = safe(cursor.getString(1));
                lines.add(name + "：" + number);
            }
        }
        if (lines.isEmpty()) {
            return keyword.isEmpty() ? "通讯录里没有联系人。" : "没有找到名字含「" + keyword + "」的联系人。";
        }
        String head = keyword.isEmpty() ? "联系人（共 " + lines.size() + " 个）：" : "匹配「" + keyword + "」的联系人：";
        return head + "\n" + String.join("\n", lines);
    }

    // ==================== 日历 ====================

    private String listCalendar(String args) {
        if (!granted(Manifest.permission.READ_CALENDAR)) {
            return permissionDenied("手机日历", Manifest.permission.READ_CALENDAR);
        }
        int days = clamp(parseInt(args, 7), 1, 60);
        long now = System.currentTimeMillis();
        long until = now + days * 24L * 3600_000L;
        List<String> lines = new ArrayList<>();
        SimpleDateFormat fmt = new SimpleDateFormat("MM-dd HH:mm", Locale.getDefault());
        String selection = CalendarContract.Events.DTSTART + " >= ? AND " + CalendarContract.Events.DTSTART + " <= ?";
        String[] selectionArgs = new String[]{String.valueOf(now), String.valueOf(until)};
        try (Cursor cursor = context.getContentResolver().query(
                CalendarContract.Events.CONTENT_URI,
                new String[]{
                    CalendarContract.Events.TITLE,
                    CalendarContract.Events.DTSTART,
                    CalendarContract.Events.EVENT_LOCATION
                },
                selection, selectionArgs,
                CalendarContract.Events.DTSTART + " ASC")) {
            if (cursor == null) return "读不到日历（系统返回空）。";
            while (cursor.moveToNext() && lines.size() < 100) {
                String title = safe(cursor.getString(0));
                long start = cursor.getLong(1);
                String location = safe(cursor.getString(2));
                lines.add("[" + fmt.format(new Date(start)) + "] " + title
                    + (location.isEmpty() ? "" : "（" + location + "）"));
            }
        }
        if (lines.isEmpty()) return "接下来 " + days + " 天没有日程。";
        return "接下来 " + days + " 天的日程（共 " + lines.size() + " 项）：\n" + String.join("\n", lines);
    }

    // ==================== 工具 ====================

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private static String clip(String value, int max) {
        if (value == null) return "";
        return value.length() <= max ? value : value.substring(0, max) + "…";
    }

    private static int parseInt(String value, int fallback) {
        try {
            return Integer.parseInt(String.valueOf(value == null ? "" : value).trim());
        } catch (NumberFormatException error) {
            return fallback;
        }
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static JSObject success(String text) {
        JSObject out = new JSObject();
        out.put("ok", true);
        out.put("text", text);
        out.put("backend", "local");
        return out;
    }

    private static JSObject failure(String text) {
        JSObject out = new JSObject();
        out.put("ok", false);
        out.put("text", text);
        return out;
    }
}
