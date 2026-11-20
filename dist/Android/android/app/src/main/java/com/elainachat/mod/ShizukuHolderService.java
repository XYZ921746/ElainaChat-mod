package com.elainachat.mod;

import android.content.Context;
import android.util.Log;

import androidx.annotation.Keep;

/**
 * Shizuku 的 UserService：在 shell uid（2000）或 root uid（0）的独立进程里持有副屏。
 *
 * <p>为什么用 UserService 而不是 {@code Shizuku.newProcess}：虚拟屏属于创建它的进程，
 * 一次性命令建的屏在命令结束时就销毁了；而且 newProcess 只能传文本，拿不回 Binder。
 * UserService 是常驻的，且进程内**没有 hidden API 限制**，建屏、反射取系统上下文都能做。
 *
 * <p>⚠️ 这个进程不是普通的 Android 应用进程：{@code registerReceiver} / {@code getContentResolver}
 * 这类 API 不可靠。所以这里只碰系统服务（DisplayManager / 包管理器），不注册任何监听。
 */
public class ShizukuHolderService extends IDisplayHolder.Stub {

    private static final String TAG = "ElainaShizukuHolder";

    private final DisplayHolder holder;

    /** Shizuku 老版本只会用无参构造。 */
    @Keep
    public ShizukuHolderService() {
        this(null);
    }

    /**
     * Shizuku v13 会优先用带 Context 的构造；那个 Context 由
     * {@code createPackageContextAsUser} 造出来，包名仍然是本应用 —— 不能直接拿它建屏
     * （uid 2000 会触发 packageName 不匹配），所以只当作兜底来源，DisplayHolder 里再包装成 shell 包名。
     */
    @Keep
    public ShizukuHolderService(Context context) {
        this.holder = new DisplayHolder(context);
        Log.i(TAG, "holder service created");
    }

    @Override
    public int createDisplay(int width, int height, int dpi, String name) {
        try {
            return holder.createDisplay(width, height, dpi, name);
        } catch (Exception error) {
            throw new IllegalStateException(describe(error));
        }
    }

    @Override
    public int displayId() {
        return holder.displayId();
    }

    @Override
    public void launch(String pkg, String component) {
        try {
            holder.launch(pkg, component);
        } catch (Exception error) {
            throw new IllegalStateException(describe(error));
        }
    }

    @Override
    public String foreground() {
        return holder.foreground();
    }

    @Override
    public void tap(int x, int y, int durationMs) {
        try {
            holder.tap(x, y, durationMs);
        } catch (Exception error) {
            throw new IllegalStateException(describe(error));
        }
    }

    @Override
    public void swipe(int x1, int y1, int x2, int y2, int durationMs) {
        try {
            holder.swipe(x1, y1, x2, y2, durationMs);
        } catch (Exception error) {
            throw new IllegalStateException(describe(error));
        }
    }

    @Override
    public void key(int keyCode) {
        try {
            holder.key(keyCode);
        } catch (Exception error) {
            throw new IllegalStateException(describe(error));
        }
    }

    @Override
    public void inputText(String text) {
        try {
            holder.inputText(text);
        } catch (Exception error) {
            throw new IllegalStateException(describe(error));
        }
    }

    @Override
    public String dumpUi() {
        try {
            return holder.dumpUi();
        } catch (Exception error) {
            throw new IllegalStateException(describe(error));
        }
    }

    @Override
    public byte[] capture() {
        try {
            return holder.capture(4000);
        } catch (Exception error) {
            throw new IllegalStateException(describe(error));
        }
    }

    /**
     * Shizuku 在销毁 UserService 前会调这个方法（transaction 16777114）。
     *
     * <p>必须释放副屏再退出：进程被直接杀掉时 Surface 会被系统回收，但 display 记录可能残留，
     * 表现为"重建时拿到同一个 id、却什么都没有"。
     */
    @Override
    public void destroy() {
        try {
            holder.destroy();
        } catch (Throwable ignored) {
            // 已经退出中的进程，释放失败不值得再抛
        }
        System.exit(0);
    }

    private static String describe(Exception error) {
        String message = error.getMessage();
        return (message == null || message.isEmpty()) ? error.getClass().getSimpleName() : message;
    }
}
