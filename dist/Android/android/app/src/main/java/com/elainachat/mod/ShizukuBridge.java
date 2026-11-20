package com.elainachat.mod;

import android.content.ComponentName;
import android.content.Context;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.IBinder;
import android.os.RemoteException;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

import rikka.shizuku.Shizuku;

/**
 * Shizuku 授权层：探测、申请权限、绑定 holder 的 UserService。
 *
 * <p>只做"把 Binder 拿到手"这一件事 —— 建屏与动作都在 {@link ShizukuHolderService}
 * （也就是 {@link DisplayHolder}）里。应用侧不关心后端是 Shizuku 还是 Sui：
 * 两者共用同一套 API，{@code ShizukuProvider} 会自动把 Sui 的 Binder 接进来。
 *
 * <p>为什么 {@link #available(Context)} 只做轻量探测、不 bind：设置页刷新状态会连着问
 * 好几个后端，一次 bind 会拉起一个进程（几百毫秒 + 内存）。绑定只发生在真要建屏时。
 */
final class ShizukuBridge {

    private static final String TAG = "ElainaShizuku";
    /** 与 AIDL 一致：Shizuku 服务端用它区分同一个 UserService 的不同版本。 */
    private static final int USER_SERVICE_VERSION = 1;
    private static final String USER_SERVICE_TAG = "elaina-display-holder";

    private static ShizukuBridge instance;

    private final Context appContext;
    private volatile IBinder binder;
    private volatile IDisplayHolder holder;
    private volatile boolean connecting;
    private volatile String lastError = "";
    private final List<Runnable> waiters = new ArrayList<>();
    private boolean listenersRegistered;
    // 监听器必须存成字段：`this::onBinderChanged` 每次求值都是新对象，
    // 用方法引用注册、再用方法引用移除会移不掉，插件销毁后回调仍然打到已释放的 Bridge 上。
    private final Shizuku.OnBinderReceivedListener binderReceivedListener = this::onBinderChanged;
    private final Shizuku.OnBinderDeadListener binderDeadListener = this::onBinderDead;

    private ShizukuBridge(Context context) {
        this.appContext = context.getApplicationContext();
    }

    static synchronized ShizukuBridge get(Context context) {
        if (instance == null) instance = new ShizukuBridge(context);
        return instance;
    }

    /** Shizuku 服务在不在（不代表已授权）。 */
    boolean serviceAlive() {
        try {
            return Shizuku.pingBinder();
        } catch (Throwable error) {
            return false;
        }
    }

    /** 是否已授权；未授权但服务在，说明需要 requestPermission。 */
    boolean granted() {
        if (!serviceAlive()) return false;
        try {
            return Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable error) {
            return false;
        }
    }

    /** Shizuku 服务端 uid：0 = root 启动（或 Sui），2000 = ADB 启动。未连接返回 -1。 */
    int serverUid() {
        if (!serviceAlive()) return -1;
        try {
            return Shizuku.getUid();
        } catch (Throwable error) {
            return -1;
        }
    }

    String lastError() {
        return lastError;
    }

    /**
     * 给设置页卡片用的一句话状态。
     *
     * <p>能不能建 **trusted** 副屏取决于系统是否给 {@code com.android.shell} 留了
     * {@code ADD_TRUSTED_DISPLAY} 权限，随版本与 ROM 变化 —— 不写死"哪一版一定可用"，
     * 一律以运行时探测（{@code probeBackground}）的结果为准。
     * root 启动（uid 0）与 Sui 不受这条限制 —— uid 0 直接通过权限校验。
     */
    String describe(Context context) {
        if (!serviceAlive()) {
            return "没检测到 Shizuku（需要先安装并激活 Shizuku 或 Sui）";
        }
        if (!granted()) {
            return "Shizuku 已运行，但本应用还没授权，点「去授权 Shizuku」";
        }
        int uid = serverUid();
        if (uid == 0) {
            return "已授权（root 启动，后台可用）";
        }
        if (uid == 2000) {
            // 能否建 trusted 副屏随版本与 ROM 变化，不写死；可用性以「检测副屏」的探测结果为准。
            return "已授权（ADB 启动，uid 2000）。由于系统限制，只有部分系统能正常建副屏 —— 授权成功后点下方「检测副屏」确认";
        }
        return "已授权（uid " + uid + "）";
    }

    void registerListeners() {
        if (listenersRegistered) return;
        listenersRegistered = true;
        try {
            Shizuku.addBinderReceivedListenerSticky(binderReceivedListener);
            Shizuku.addBinderDeadListener(binderDeadListener);
        } catch (Throwable error) {
            Log.w(TAG, "注册 Shizuku 监听失败：" + ShellProcess.describe(error));
        }
    }

    private void onBinderChanged() {
        Log.i(TAG, "Shizuku binder 可用");
        binder = null;
        holder = null;
    }

    private void onBinderDead() {
        Log.w(TAG, "Shizuku binder 已断开");
        binder = null;
        holder = null;
        connecting = false;
    }

    /** 申请授权；结果通过 Shizuku 的全局回调异步返回，调用方随后重新探测即可。 */
    void requestPermission(int requestCode) {
        try {
            Shizuku.requestPermission(requestCode);
        } catch (Throwable error) {
            lastError = "申请 Shizuku 授权失败：" + ShellProcess.describe(error);
            Log.w(TAG, lastError);
        }
    }

    /**
     * 拿 holder。已连上直接返回；否则发起一次绑定并**阻塞等待**到超时。
     *
     * <p>为什么允许阻塞：调用方本来就在 {@link ElainaShellPlugin} 的线程池里，
     * 而每个动作都要等 holder 就绪；不阻塞就得把整个动作链改成异步回调，
     * 收益只有几百毫秒，代价是调用方全部重写。
     */
    IDisplayHolder holder(int timeoutMs) throws Exception {
        IDisplayHolder current = holder;
        if (current != null && current.asBinder().isBinderAlive()) return current;
        synchronized (waiters) {
            if (holder != null && holder.asBinder().isBinderAlive()) return holder;
            if (!serviceAlive()) throw new IllegalStateException("Shizuku 没在运行，请先激活 Shizuku 或 Sui");
            if (!granted()) throw new IllegalStateException("本应用还没有获得 Shizuku 授权，请先在设置里点「去授权 Shizuku」");
            if (!connecting) {
                connecting = true;
                bindLocked();
            }
            long deadline = System.currentTimeMillis() + Math.max(1500, timeoutMs);
            while (holder == null) {
                long left = deadline - System.currentTimeMillis();
                if (left <= 0) break;
                try {
                    waiters.wait(left);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            if (holder == null) {
                throw new IllegalStateException(lastError.isEmpty()
                    ? "Shizuku 的副屏进程没有起来（超时）"
                    : lastError);
            }
            return holder;
        }
    }

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            binder = service;
            holder = IDisplayHolder.Stub.asInterface(service);
            connecting = false;
            lastError = "";
            synchronized (waiters) {
                waiters.notifyAll();
            }
            Log.i(TAG, "副屏 holder 已连接");
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            binder = null;
            holder = null;
            connecting = false;
            lastError = "Shizuku 的副屏进程已断开";
            Log.w(TAG, lastError);
        }
    };

    private void bindLocked() {
        try {
            Shizuku.UserServiceArgs args = new Shizuku.UserServiceArgs(
                    new ComponentName(appContext.getPackageName(), ShizukuHolderService.class.getName()))
                // tag 必须显式给：不设时 Shizuku 用类名判断"是不是同一个 UserService"，
                // 而 R8 会重命名类名 —— release 包里会每次启动都起一个新进程。
                .tag(USER_SERVICE_TAG)
                .version(USER_SERVICE_VERSION)
                .processNameSuffix(":display")
                // daemon(false)：应用进程死掉时 holder 跟着退，不留孤儿 root 进程。
                .daemon(false)
                .debuggable(false);
            Shizuku.bindUserService(args, connection);
        } catch (Throwable error) {
            connecting = false;
            lastError = "绑定 Shizuku 副屏进程失败：" + ShellProcess.describe(error);
            synchronized (waiters) {
                waiters.notifyAll();
            }
        }
    }

    /** 解绑并让 holder 释放副屏。插件销毁时调用。 */
    void release() {
        try {
            IDisplayHolder current = holder;
            if (current != null) current.destroy();
        } catch (Throwable ignored) {
            // 进程可能已经退出
        }
        holder = null;
        binder = null;
        connecting = false;
        try {
            Shizuku.UserServiceArgs args = new Shizuku.UserServiceArgs(
                    new ComponentName(appContext.getPackageName(), ShizukuHolderService.class.getName()))
                .tag(USER_SERVICE_TAG)
                .version(USER_SERVICE_VERSION)
                .processNameSuffix(":display");
            Shizuku.unbindUserService(args, connection, true);
        } catch (Throwable ignored) {
            // 没绑过或服务已经不在
        }
        if (listenersRegistered) {
            listenersRegistered = false;
            try {
                Shizuku.removeBinderReceivedListener(binderReceivedListener);
                Shizuku.removeBinderDeadListener(binderDeadListener);
            } catch (Throwable ignored) {
                // 监听器移除失败不影响功能
            }
        }
    }
}
