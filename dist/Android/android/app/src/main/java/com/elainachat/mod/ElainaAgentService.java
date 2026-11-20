package com.elainachat.mod;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * 后台会话的保活服务。
 *
 * <p>为什么需要它：后台方式下 agent 循环跑在 WebView 主进程里，用户切到别的应用后
 * 系统会冻结主进程 —— 副屏还在、holder 还活着，但"下一步"永远不会发出，
 * 表现为"点几步就不动了"。前台服务是唯一能合法让主进程继续跑的手段。
 *
 * <p>为什么类型用 specialUse 而不是 dataSync：Android 15（targetSdk 35）对 dataSync
 * 有"每天累计 6 小时"的硬上限，一次长任务就能撞上；specialUse 没有这个限制，
 * 与 :node 服务的取舍一致。
 *
 * <p>WakeLock 只拿 PARTIAL：屏幕不需要亮（副屏自己渲染），只要 CPU 不休眠。
 * 会话结束时必须释放 —— 一直持有等于把用户的电量当免费资源。
 */
public class ElainaAgentService extends Service {

    private static final String TAG = "ElainaAgent";
    private static final String CHANNEL_ID = "elaina_agent_session";
    private static final int NOTIFICATION_ID = 0x4147454e;   // "AGEN"

    /** 与 :node 的取舍一致：不声明 POST_NOTIFICATIONS，Android 13+ 默认不显示通知。 */
    private static final String NOTIFICATION_TEXT = "AI 正在后台操作手机";

    private static final long WAKELOCK_TIMEOUT_MS = 30 * 60 * 1000L;

    private PowerManager.WakeLock wakeLock;

    public static void start(Context context) {
        try {
            Intent intent = new Intent(context, ElainaAgentService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Throwable error) {
            // 后台启动前台服务在 Android 12+ 可能被拒（BAL 限制）：任务本身还能跑，只是没保活
            android.util.Log.w(TAG, "启动保活服务失败：" + ShellProcess.describe(error));
        }
    }

    public static void stop(Context context) {
        try {
            context.stopService(new Intent(context, ElainaAgentService.class));
        } catch (Throwable ignored) {
            // 服务本来就没起
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        // 必须先 startForeground 再干重活：startForegroundService 给的窗口只有几秒
        startForeground(NOTIFICATION_ID, buildNotification());
        acquireWakeLock();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ElainaChat:agent-session");
            wakeLock.setReferenceCounted(false);
            // 超时兜底：会话被异常打断（进程被杀）时，锁也会自己释放
            wakeLock.acquire(WAKELOCK_TIMEOUT_MS);
        } catch (Throwable error) {
            android.util.Log.w(TAG, "获取 WakeLock 失败：" + ShellProcess.describe(error));
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Throwable ignored) {
            // 已经被超时释放
        }
        wakeLock = null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "后台手机操作", NotificationManager.IMPORTANCE_MIN);
        channel.setShowBadge(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Notification.Builder builder = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, flags);
        return builder
            .setContentTitle("ElainaChat")
            .setContentText(NOTIFICATION_TEXT)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(pending)
            .setOngoing(true)
            .setPriority(Notification.PRIORITY_MIN)
            .build();
    }
}
