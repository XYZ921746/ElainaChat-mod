package com.elainachat.mod;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 本地服务的**客户端**（跑在 App 主进程，即 WebView 所在进程）。
 *
 * <p>真正的服务宿主在 {@code :node} 独立进程（{@link ElainaNodeService}），本类只做三件事：
 * <ol>
 *   <li>bind {@code ElainaNodeService}，拿 {@link Messenger} 通道；</li>
 *   <li>把 {@link #start}/{@link #stop}/{@link #status} 转成消息发过去；</li>
 *   <li><b>保持对外返回的 {@link JSObject} 形状稳定</b> ——
 *       {@code web/js/core-native-mod.js} 的 {@code __nodeReadyPromise} 靠
 *       {@code ready}/{@code port}/{@code lastError} 判定，形状一变前端就静默回落。</li>
 * </ol>
 *
 * <p>端口为什么不能走 SharedPreferences：{@code MODE_MULTI_PROCESS} 在 API 23+
 *   已废弃且不可靠（各进程有独立缓存，读到旧端口是常态）。端口只能经
 *   Messenger 推送，见 {@link ElainaNodeService#onNodeReadyLine}。
 */
@CapacitorPlugin(name = "ElainaNode")
public class ElainaNodePlugin extends Plugin {

    private static final String TAG = "ElainaNode";

    /** 状态快照（由 :node 进程推送/回包填充）。 */
    private static volatile boolean started = false;
    private static volatile int readyPort = -1;
    private static volatile long readyAt = 0L;
    private static volatile int exitCode = Integer.MIN_VALUE;
    private static volatile String lastError = "";

    private Messenger remote = null;
    private boolean bound = false;

    // Messenger 客户端

    /** 收 :node 推送的状态与事件。同样跑在主线程（与 Capacitor 插件方法一致）。 */
    private final Messenger replyMessenger = new Messenger(new Handler(Looper.getMainLooper()) {
        @Override
        public void handleMessage(Message msg) {
            switch (msg.what) {
                case ElainaNodeService.MSG_STATE:
                    applyState(msg.getData());
                    break;
                case ElainaNodeService.MSG_READY:
                    applyReady(msg.getData());
                    break;
                case ElainaNodeService.MSG_EXIT:
                    applyExit(msg.getData());
                    break;
                default:
                    super.handleMessage(msg);
            }
        }
    });

    /** 待发送的消息（绑定是异步的，连接回来之前先攒着）。 */
    private final java.util.ArrayDeque<Message> pendingMessages = new java.util.ArrayDeque<>();

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            remote = new Messenger(service);
            bound = true;
            Log.i(TAG, "已连接到 :node 服务");
            // 先冲刷绑定期间攒下的命令，再查一次状态。
            //
            //   为什么必须攒：bindService 是**异步**的，start() 通常比
            //   onServiceConnected 先返回。此时 remote 还是 null，直接 send 会
            //   被静默丢掉 —— 表现是"服务起着、但从没收到过 start"，服务永远
            //   不启动而日志里一行报错都没有（实测就是这个现象）。
            flushPending();
            sendSimple(ElainaNodeService.MSG_STATUS);
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            // :node 进程死了（崩了/被系统回收）。这里**不能**让主进程跟着出事，
            // 只清状态、等下次调用时重绑。前端会在这期间走原生兜底。
            remote = null;
            bound = false;
            started = false;
            readyPort = -1;
            Log.w(TAG, ":node 服务已断开（本地服务不可用，前端将回落本地实现）");
        }
    };

    /** 把攒着的消息发出去（连接就绪时调用） */
    private void flushPending() {
        if (remote == null) return;
        while (!pendingMessages.isEmpty()) {
            Message msg = pendingMessages.poll();
            if (msg == null) continue;
            msg.replyTo = replyMessenger;
            try {
                remote.send(msg);
            } catch (RemoteException error) {
                Log.w(TAG, "冲刷待发消息失败：" + error.getMessage());
                remote = null;
                bound = false;
                return;
            }
        }
    }

    /**
     * 确保已发出绑定请求。返回 false 只代表"连发起都失败"。
     *
     * <p>注意返回值**不**表示通道已就绪：{@code bindService} 是异步的，
     *   {@link #remote} 要等 {@code onServiceConnected} 才有值。所以这里不因
     *   "remote 还是 null" 而重复 bind（那会绑多次、收到重复回调），
     *   真正的发送由 {@link #sendSimple} 负责攒队列。
     */
    private boolean ensureBound() {
        if (bound) return true;
        try {
            Intent intent = new Intent(getContext(), ElainaNodeService.class);
            // 必须 startForegroundService 而非 startService：服务在 onCreate 里
            //   就要 startForeground，Android 8+ 要求走前者才给那个窗口期。
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            boolean ok = getContext().bindService(intent, connection, Context.BIND_AUTO_CREATE);
            if (!ok) {
                lastError = "无法绑定内嵌服务进程";
                return false;
            }
            bound = true;   // 表示"绑定请求已发出"，通道就绪与否看 remote
            return true;
        } catch (Exception error) {
            lastError = "绑定内嵌服务失败：" + error.getMessage();
            Log.e(TAG, lastError, error);
            return false;
        }
    }

    private void sendSimple(int what) {
        Message msg = Message.obtain(null, what);
        msg.replyTo = replyMessenger;
        if (remote == null) {
            // 还连上（bindService 是异步的）→ 攒着，onServiceConnected 时冲刷。
            // 上界保护：页面反复调用也不该无界堆积。
            if (pendingMessages.size() < 16) pendingMessages.add(msg);
            return;
        }
        try {
            remote.send(msg);
        } catch (RemoteException error) {
            // 服务进程已死：清掉本地引用，下次调用重绑
            remote = null;
            bound = false;
            Log.w(TAG, "发送消息 " + what + " 失败：" + error.getMessage());
        }
    }

    private void applyState(Bundle data) {
        if (data == null) return;
        started = data.getBoolean("started", false);
        readyPort = data.getInt("port", 0) > 0 ? data.getInt("port") : -1;
        readyAt = data.getLong("readyAt", 0L);
        exitCode = data.getInt("exitCode", Integer.MIN_VALUE);
        String error = data.getString("lastError", "");
        lastError = error == null ? "" : error;
    }

    private void applyReady(Bundle data) {
        if (data == null) return;
        readyPort = data.getInt("port", -1);
        readyAt = System.currentTimeMillis();
        started = true;
        Log.i(TAG, "本地服务已就绪，端口 " + readyPort);
    }

    private void applyExit(Bundle data) {
        if (data == null) return;
        exitCode = data.getInt("exitCode", Integer.MIN_VALUE);
        started = false;
        readyPort = -1;
        Log.i(TAG, "本地服务已退出，退出码 " + exitCode);
    }

    // 对外方法

    /**
     * 启动本地服务。立刻 resolve（带 {@code ready:false}），前端轮询 status 等就绪。
     *
     * <p>服务宿主是 {@code :node} 进程里的 {@link ElainaNodeService}。
     */
    @PluginMethod
    public void start(PluginCall call) {
        if (!ensureBound()) {
            call.resolve(statusObject());
            return;
        }
        sendSimple(ElainaNodeService.MSG_START);
        call.resolve(statusObject());
    }

    /** 当前状态：前端靠它判断「起没起、就绪没、端口是多少、为什么失败」。 */
    @PluginMethod
    public void status(PluginCall call) {
        if (ensureBound()) sendSimple(ElainaNodeService.MSG_STATUS);
        call.resolve(statusObject());
    }

    /**
     * 停掉本地服务（请求 /api/shutdown，让进程自然退出）。
     *
     * <p>仍然不能用 {@code process.exit()}：那结束的是整个 App 进程。
     *   独立进程后即使真的想 exit 也只死 :node，但保持"优雅关监听"这条路径更干净。
     */
    @PluginMethod
    public void stop(PluginCall call) {
        if (ensureBound()) sendSimple(ElainaNodeService.MSG_STOP);
        call.resolve(statusObject());
    }

    private JSObject statusObject() {
        JSObject result = new JSObject();
        result.put("started", started);
        result.put("ready", readyPort > 0);
        result.put("port", readyPort > 0 ? readyPort : 0);
        result.put("readyAt", readyAt);
        result.put("exitCode", exitCode);
        result.put("lastError", lastError);
        // 这两个路径字段诊断页在用，保持原值不要变 ——
        // 注意它们指向的是**主进程**的 filesDir，与 :node 进程里的是同一个目录。
        result.put("projectDir", getContext().getApplicationInfo().nativeLibraryDir);
        result.put("dataDir", new java.io.File(getContext().getFilesDir(), "elaina-data").getAbsolutePath());
        return result;
    }

    // 生命周期

    @Override
    protected void handleOnDestroy() {
        // 解绑但**不**停止服务：:node 是常驻的，页面重建不该带走本地服务。
        if (bound) {
            try { getContext().unbindService(connection); } catch (Exception ignored) { /* 没绑上 */ }
            bound = false;
            remote = null;
        }
        super.handleOnDestroy();
    }
}
