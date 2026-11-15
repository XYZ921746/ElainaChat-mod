package com.elainachat.mod;

import android.content.Intent;
import android.net.Uri;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 导出的原生半边：拉起系统「创建文档」选择器（SAF，ACTION_CREATE_DOCUMENT），
 * 用户在系统文件管理器里**自选保存位置和文件名**，选中后把内容写进去。
 *
 * 为什么走 SAF 而不是直接写固定目录：用户明确要"打开系统文件夹选择导出位置"。
 * ACTION_CREATE_DOCUMENT 就是安卓的标准答案 —— 它天然自带"是否 + 存哪里"的确认
 * （用户不选就是取消），且无需任何存储权限：选中的 URI 由系统临时授权本应用写一次。
 *
 * WebView 里做不到这些：showSaveFilePicker（File System Access API）在
 * Android WebView 上不存在，a[download] 的 blob 会被 DownloadListener 静默丢掉
 * （实测：界面说"已导出"但全盘找不到文件）—— 都碰不到系统选择器。
 */
@CapacitorPlugin(name = "ElainaExport")
public class ElainaExportPlugin extends Plugin {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    /** 用户取消选择时回给 JS 的标记（JS 侧据此提示"已取消"而不是当失败） */
    private static final String REASON_CANCELLED = "cancelled";

    /** 备份 zip 的 MIME：给系统选择器看，决定默认文件名后缀提示 */
    private static final String MIME_ZIP = "application/zip";

    @PluginMethod
    public void saveText(PluginCall call) {
        String fileName = call.getString("fileName", "");
        if (!validFileName(fileName, call)) return;
        try {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("text/plain");
            intent.putExtra(Intent.EXTRA_TITLE, fileName);
            startActivityForResult(call, intent, "saveTextResult");
        } catch (Throwable error) {
            // 设备上没有任何文件选择器（极罕见的精简 ROM）→ 让 JS 走固定目录兜底
            resolveNoPicker(call, error);
        }
    }

    /**
     * 二进制导出（备份 zip），分两段走，因为备份有 20MB+：
     *   beginBinary → 弹 SAF 选择器，返回一个写入句柄 id；
     *   appendBinary（可多次）→ 按 base64 分块追加；
     *   finishBinary → 关流并回总字节数。
     *
     * 为什么要分块：Capacitor 的 bridge 对单次调用有大小上限，20MB 的备份
     * 序列化成 base64 是 27MB，一次性传过去会被截断或直接失败。
     * （Filesystem 插件写大文件也是同一套分块，见 web/js/core-native.js 的 nativeWriteFile。）
     *
     * 为什么不用 Filesystem 插件写 Documents：那条路写死目录，用户无法自选位置，
     * 且 Android 10+ 的 scoped storage 下写公共 Documents 需要额外适配。
     * 备份动辄 20MB+，用户更需要"存到哪自己定"（U 盘 / 网盘目录 / 电脑共享盘）。
     */
    @PluginMethod
    public void beginBinary(PluginCall call) {
        String fileName = call.getString("fileName", "");
        if (!validFileName(fileName, call)) return;
        try {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            // 系统按 MIME 决定默认后缀与"用什么应用打开"；zip 就报 application/zip。
            intent.setType(call.getString("mimeType", MIME_ZIP));
            intent.putExtra(Intent.EXTRA_TITLE, fileName);
            startActivityForResult(call, intent, "beginBinaryResult");
        } catch (Throwable error) {
            resolveNoPicker(call, error);
        }
    }

    /** 未关闭的写入句柄：key 由 JS 拿着，写完整份文件后必须调 finishBinary 关掉。 */
    private final Map<String, OutputStream> openStreams = new ConcurrentHashMap<>();

    @ActivityCallback
    private void beginBinaryResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject out = new JSObject();
        if (!resolveTarget(call, result, out)) return;
        final Uri target = result.getData().getData();
        executor.execute(() -> {
            JSObject done = new JSObject();
            try {
                OutputStream os = getContext().getContentResolver().openOutputStream(target, "wt");
                if (os == null) throw new IllegalStateException("打开输出流失败");
                String handle = UUID.randomUUID().toString();
                openStreams.put(handle, os);
                done.put("ok", true);
                done.put("handle", handle);
                done.put("uri", target.toString());
            } catch (Throwable error) {
                done.put("ok", false);
                done.put("reason", "write-failed");
                done.put("text", "打开目标文件失败：" + ShellProcess.describe(error));
            }
            call.resolve(done);
        });
    }

    /** 追加一块（base64）。JS 侧按 1MB 原文字节切块，避免 bridge 单次负载过大。 */
    @PluginMethod
    public void appendBinary(PluginCall call) {
        String handle = call.getString("handle", "");
        String base64 = call.getString("data", "");
        JSObject out = new JSObject();
        OutputStream os = handle == null ? null : openStreams.get(handle);
        if (os == null) {
            out.put("ok", false);
            out.put("reason", "no-handle");
            out.put("text", "写入句柄已失效（可能已被系统回收），请重新导出。");
            call.resolve(out);
            return;
        }
        final byte[] payload;
        try {
            payload = base64 == null || base64.isEmpty()
                ? new byte[0]
                : android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
        } catch (Throwable decodeError) {
            out.put("ok", false);
            out.put("reason", "bad-payload");
            out.put("text", "内容解码失败：" + ShellProcess.describe(decodeError));
            call.resolve(out);
            return;
        }
        executor.execute(() -> {
            JSObject done = new JSObject();
            try {
                os.write(payload);
                done.put("ok", true);
                done.put("bytes", payload.length);
            } catch (Throwable error) {
                // 写失败就把句柄放掉：留着只会让后续 append 继续往坏流里写。
                openStreams.remove(handle);
                try { os.close(); } catch (Throwable ignored) { /* 已坏 */ }
                done.put("ok", false);
                done.put("reason", "write-failed");
                done.put("text", "写入失败：" + ShellProcess.describe(error));
            }
            call.resolve(done);
        });
    }

    /** 收尾：flush + close。失败时也要把句柄摘掉，避免泄漏。 */
    @PluginMethod
    public void finishBinary(PluginCall call) {
        String handle = call.getString("handle", "");
        JSObject out = new JSObject();
        OutputStream os = handle == null ? null : openStreams.remove(handle);
        if (os == null) {
            out.put("ok", false);
            out.put("reason", "no-handle");
            out.put("text", "写入句柄已失效，请重新导出。");
            call.resolve(out);
            return;
        }
        executor.execute(() -> {
            JSObject done = new JSObject();
            try {
                os.flush();
                os.close();
                done.put("ok", true);
                done.put("text", "已保存到所选位置。");
            } catch (Throwable error) {
                try { os.close(); } catch (Throwable ignored) { /* 已经坏了 */ }
                done.put("ok", false);
                done.put("reason", "write-failed");
                done.put("text", "保存失败：" + ShellProcess.describe(error));
            }
            call.resolve(done);
        });
    }

    /** 用户中途取消或界面重载时，别把流挂在内存里。 */
    @PluginMethod
    public void abortBinary(PluginCall call) {
        String handle = call.getString("handle", "");
        OutputStream os = handle == null ? null : openStreams.remove(handle);
        if (os != null) {
            try { os.close(); } catch (Throwable ignored) { /* 尽力而为 */ }
        }
        JSObject out = new JSObject();
        out.put("ok", true);
        call.resolve(out);
    }

    /** 文件名由 JS 侧生成，这里再防一道：SAF 的 EXTRA_TITLE 不接受路径成分，带了系统直接报错。 */
    private boolean validFileName(String fileName, PluginCall call) {
        if (fileName == null || fileName.isEmpty()
                || fileName.contains("/") || fileName.contains("\\") || fileName.contains("..")) {
            JSObject out = new JSObject();
            out.put("ok", false);
            out.put("reason", "bad-name");
            out.put("text", "文件名不合法：" + fileName);
            call.resolve(out);
            return false;
        }
        return true;
    }

    private void resolveNoPicker(PluginCall call, Throwable error) {
        JSObject out = new JSObject();
        out.put("ok", false);
        out.put("reason", "no-picker");
        out.put("text", "打不开系统文件选择器：" + ShellProcess.describe(error));
        call.resolve(out);
    }

    /** 文本导出：负载按 UTF-8 原样写，不做任何编码转换。 */
    @ActivityCallback
    private void saveTextResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject out = new JSObject();
        if (!resolveTarget(call, result, out)) return;
        final Uri target = result.getData().getData();
        final String text = call.getString("data", "");
        writeAsync(call, target, (text == null ? "" : text).getBytes(StandardCharsets.UTF_8));
    }

    /** 校验选择器结果并取出目标 URI；返回 false 表示已经把失败回给 JS（含用户取消）。 */
    private boolean resolveTarget(PluginCall call, ActivityResult result, JSObject out) {
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            out.put("ok", false);
            out.put("reason", REASON_CANCELLED);
            out.put("text", "已取消导出。");
            call.resolve(out);
            return false;
        }
        if (result.getData().getData() == null) {
            out.put("ok", false);
            out.put("reason", "no-uri");
            out.put("text", "系统没有返回保存位置。");
            call.resolve(out);
            return false;
        }
        return true;
    }

    /** 写盘走后台线程：备份 zip 20MB+，在主线程写会把界面卡住（选择器关掉后那一下最明显）。 */
    private void writeAsync(PluginCall call, Uri target, byte[] payload) {
        executor.execute(() -> {
            JSObject done = new JSObject();
            try (OutputStream os = getContext().getContentResolver().openOutputStream(target, "wt")) {
                if (os == null) throw new IllegalStateException("打开输出流失败");
                os.write(payload);
                os.flush();
                done.put("ok", true);
                done.put("uri", target.toString());
                done.put("bytes", payload.length);
                done.put("text", "已保存到所选位置。");
            } catch (Throwable error) {
                done.put("ok", false);
                done.put("reason", "write-failed");
                done.put("text", "写入失败：" + ShellProcess.describe(error));
            }
            call.resolve(done);
        });
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
