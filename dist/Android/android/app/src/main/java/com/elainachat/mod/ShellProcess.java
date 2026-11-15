package com.elainachat.mod;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * 执行一个外部进程并把结果收回来。
 *
 * <p>★ 2026-10：原先有两个使用者（Root 的 {@code su -c} 与 Shizuku 的 UserService），
 * 两者都已删除。现在只有 {@link ShellBackends.ModuleExecutor} 的网关探测
 * 与本机的 {@code uiautomator} 兜底路径会用到它。
 *
 * <p>保持"只用 java.io / java.nio，不碰需要 Context 的 Android API"这条约束 ——
 * 它当初是为了让代码能在别的进程里跑（Shizuku 的 UserService），
 * 现在虽然那个场景没了，但这条约束让本类可以独立测试，继续守着。
 */
final class ShellProcess {

    private ShellProcess() {}

    static final class Result {
        final int code;
        final String stdout;
        final String stderr;
        final boolean timedOut;

        Result(int code, String stdout, String stderr, boolean timedOut) {
            this.code = code;
            this.stdout = stdout;
            this.stderr = stderr;
            this.timedOut = timedOut;
        }

        boolean ok() {
            return !timedOut && code == 0;
        }
    }

    /** 默认输出上限：单条命令最多回这么多字节，多的丢弃。 */
    static final int DEFAULT_MAX_OUTPUT = 512 * 1024;

    /** 用 {@code sh -c} 执行一条命令。 */
    static Result runShell(String command, int timeoutMs) {
        return runShell(command, timeoutMs, DEFAULT_MAX_OUTPUT);
    }

    static Result runShell(String command, int timeoutMs, int maxOutputBytes) {
        return runArgv(new String[]{"sh", "-c", command}, timeoutMs, maxOutputBytes);
    }

    static Result runArgv(String[] argv, int timeoutMs, int maxOutputBytes) {
        final int cap = Math.max(4096, maxOutputBytes);
        Process process;
        try {
            process = new ProcessBuilder(argv).start();
        } catch (Exception error) {
            return new Result(-1, "", "无法启动进程：" + describe(error), false);
        }

        final ByteArrayOutputStream outBuf = new ByteArrayOutputStream();
        final ByteArrayOutputStream errBuf = new ByteArrayOutputStream();
        // 必须并发读：只读一个流的话，另一个流的管道缓冲写满会把子进程卡死，
        // 然后 waitFor 一直等，表现为"命令卡住不动"。
        final Thread outThread = drain(process.getInputStream(), outBuf, cap);
        final Thread errThread = drain(process.getErrorStream(), errBuf, cap);

        boolean finished;
        try {
            finished = process.waitFor(Math.max(500, timeoutMs), TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            finished = false;
        }

        if (!finished) {
            process.destroy();
            try {
                if (!process.waitFor(150, TimeUnit.MILLISECONDS)) process.destroyForcibly();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            }
        }

        joinQuietly(outThread);
        joinQuietly(errThread);

        int code;
        try {
            code = process.exitValue();
        } catch (IllegalThreadStateException stillRunning) {
            code = -1;
        }

        return new Result(
            code,
            new String(outBuf.toByteArray(), StandardCharsets.UTF_8),
            new String(errBuf.toByteArray(), StandardCharsets.UTF_8),
            !finished
        );
    }

    /**
     * 把流读干，超过上限的部分只丢不存。
     *
     * <p>关键点：**超限后仍然继续读**。如果读到上限就停止读取，子进程会阻塞在写上，
     * 于是"输出太长"变成"命令永远不结束"。
     */
    private static Thread drain(final InputStream stream, final ByteArrayOutputStream sink, final int cap) {
        Thread thread = new Thread(() -> {
            byte[] buffer = new byte[16 * 1024];
            try (InputStream input = stream) {
                int read;
                while ((read = input.read(buffer)) != -1) {
                    int room = cap - sink.size();
                    if (room > 0) sink.write(buffer, 0, Math.min(room, read));
                }
            } catch (Exception ignored) {
                // 进程被销毁时流会报错，这里不需要处理
            }
        }, "elaina-shell-drain");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    private static void joinQuietly(Thread thread) {
        try {
            thread.join(1500);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    static String describe(Throwable error) {
        if (error == null) return "未知错误";
        String message = error.getMessage();
        return (message == null || message.isEmpty()) ? error.getClass().getSimpleName() : message;
    }
}
