package com.elainachat.mod;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Edge TTS 的原生实现。
 *
 * <p><b>为什么必须在原生层做</b>：Edge TTS 用 WebSocket 协议，而它的端点会校验
 * 浏览器指纹 —— 缺 {@code User-Agent} 等头就返回 <b>403</b>。WebView 里 JS 的
 * {@code new WebSocket(url)} <b>无法自定义请求头</b>，所以那条路必然失败
 * （实测：所有参数组合、所有 Origin 都 403；补上完整浏览器头后立刻 101）。
 * 原生层能设任意头，于是用 {@link MiniWebSocket} 手写握手与帧收发。
 *
 * <p>协议要点（独立实现，参考 rany2/edge-tts 的公开协议说明）：
 * <ol>
 *   <li>URL 带 {@code TrustedClientToken} + {@code Sec-MS-GEC} + {@code Sec-MS-GEC-Version}
 *       + {@code ConnectionId}</li>
 *   <li>{@code Sec-MS-GEC} = SHA256(Windows 文件时间取整到 5 分钟 + token) 的大写 hex。
 *       <b>ticks 约 1.34e17，超出 JS 的 Number 安全整数</b>，所以前端那份实现用 BigInt；
 *       这里用 long 也够（1.34e17 < 9.2e18）</li>
 *   <li>先发 {@code Path:speech.config} 文本帧，再发 {@code Path:ssml}</li>
 *   <li>二进制帧前 2 字节（大端）= header 长度，{@code Path:audio} 的 payload 是 MP3</li>
 *   <li>{@code Path:turn.end} 表示合成结束</li>
 * </ol>
 */
@CapacitorPlugin(name = "EdgeTts")
public class EdgeTtsPlugin extends Plugin {

    private static final String TAG = "EdgeTts";

    private static final String TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    /** 微软校验这个版本号；参考实现里跟着 Chromium 版本走 */
    private static final String GEC_VERSION = "1-143.0.3650.75";
    private static final String WSS_BASE =
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
    private static final String UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
            + "Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

    /**
     * 合成一段语音，返回 base64 的 MP3。
     *
     * <p>参数：{@code text}、{@code voice}、{@code rate}（如 {@code +0%}）、
     * {@code volume}（如 {@code +0%}）、{@code timeoutMs}。
     */
    @PluginMethod
    public void synthesize(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.reject("缺少 text");
            return;
        }
        String voice = call.getString("voice", "zh-CN-XiaoxiaoNeural");
        String rate = call.getString("rate", "+0%");
        String volume = call.getString("volume", "+0%");
        int timeoutMs = call.getInt("timeoutMs", 30_000);

        // 网络 IO 不能占主线程（Capacitor 的插件方法默认在主线程调用）
        new Thread(() -> {
            try {
                byte[] mp3 = doSynthesize(text, voice, rate, volume, timeoutMs);
                if (mp3 == null || mp3.length == 0) {
                    call.reject("Edge TTS 没有返回音频（端点可能改了协议或限流）");
                    return;
                }
                JSObject out = new JSObject();
                out.put("ok", true);
                out.put("mime", "audio/mpeg");
                out.put("bytes", mp3.length);
                out.put("audioBase64", Base64.encodeToString(mp3, Base64.NO_WRAP));
                call.resolve(out);
            } catch (Throwable error) {
                call.reject("Edge TTS 失败：" + describe(error));
            }
        }, "edge-tts").start();
    }

    /** 连通性自检：能否完成握手（不合成）。用于设置页的"测试"按钮与排查。 */
    @PluginMethod
    public void probe(PluginCall call) {
        new Thread(() -> {
            JSObject out = new JSObject();
            try (MiniWebSocket ws = openSocket(8000)) {
                out.put("ok", true);
                out.put("text", "Edge TTS 端点握手成功（101）。");
            } catch (Throwable error) {
                out.put("ok", false);
                out.put("text", describe(error));
            }
            call.resolve(out);
        }, "edge-tts-probe").start();
    }

    // 内部实现

    private static byte[] doSynthesize(String text, String voice, String rate, String volume, int timeoutMs)
        throws Exception {
        String connectId = UUID.randomUUID().toString().replace("-", "");
        try (MiniWebSocket ws = openSocket(timeoutMs)) {
            // ① speech.config
            ws.sendText("X-Timestamp:" + dateString() + "\r\n"
                + "Content-Type:application/json; charset=utf-8\r\n"
                + "Path:speech.config\r\n\r\n"
                + "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{"
                + "\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\""
                + "},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}\r\n");

            // ② ssml
            String escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
            String ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>"
                + "<voice name='" + voice + "'>"
                + "<prosody pitch='+0Hz' rate='" + rate + "' volume='" + volume + "'>" + escaped + "</prosody>"
                + "</voice></speak>";
            ws.sendText("X-RequestId:" + connectId + "\r\n"
                + "Content-Type:application/ssml+xml\r\n"
                + "X-Timestamp:" + dateString() + "Z\r\n"
                + "Path:ssml\r\n\r\n" + ssml);

            // ③ 收帧：文本帧看 Path，二进制帧拆 header 取音频
            ByteArrayOutputStream audio = new ByteArrayOutputStream();
            boolean ended = false;
            long deadline = System.currentTimeMillis() + Math.max(5000, timeoutMs);
            while (!ended && System.currentTimeMillis() < deadline) {
                MiniWebSocket.Frame frame = ws.receive();
                if (frame == null) break;   // 连接关闭
                if (frame.isText()) {
                    String head = frame.text();
                    if (head.contains("Path:turn.end")) ended = true;
                    continue;
                }
                byte[] data = frame.payload;
                if (data.length < 2) continue;
                int headerLen = ((data[0] & 0xFF) << 8) | (data[1] & 0xFF);
                if (headerLen + 2 > data.length) continue;
                String header = new String(data, 2, headerLen, StandardCharsets.UTF_8);
                if (!header.contains("Path:audio")) continue;
                int start = headerLen + 2;
                if (start < data.length) audio.write(data, start, data.length - start);
            }
            return audio.size() > 0 ? audio.toByteArray() : null;
        }
    }

    private static MiniWebSocket openSocket(int timeoutMs) throws Exception {
        Map<String, String> headers = new LinkedHashMap<>();
        // 这几个头就是成败关键：少了 User-Agent，服务端直接 403
        headers.put("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold");
        headers.put("User-Agent", UA);
        headers.put("Pragma", "no-cache");
        headers.put("Cache-Control", "no-cache");
        headers.put("Accept-Encoding", "gzip, deflate, br");
        headers.put("Accept-Language", "en-US,en;q=0.9");
        headers.put("Cookie", "muid=" + randomMuid() + ";");

        String url = WSS_BASE
            + "?TrustedClientToken=" + TOKEN
            + "&Sec-MS-GEC=" + secMsGec()
            + "&Sec-MS-GEC-Version=" + GEC_VERSION
            + "&ConnectionId=" + UUID.randomUUID().toString().replace("-", "");
        return MiniWebSocket.connect(url, headers, timeoutMs);
    }

    /**
     * 生成 Sec-MS-GEC。
     *
     * <p>算法：把当前时间转成 Windows 文件时间（1601 纪元，100ns 单位），
     * 向下取整到 5 分钟，拼上 token 做 SHA256，取大写 hex。
     * ticks 约 1.34e17，long（9.2e18）装得下。
     */
    private static String secMsGec() throws Exception {
        long ticks = System.currentTimeMillis() / 1000L + 11644473600L;
        ticks -= ticks % 300L;
        ticks *= 10000000L;
        String toHash = ticks + TOKEN;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(toHash.getBytes(StandardCharsets.US_ASCII));
        StringBuilder sb = new StringBuilder(hash.length * 2);
        for (byte b : hash) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString().toUpperCase();
    }

    /** 32 位十六进制随机串（参考实现里当作 muid） */
    private static String randomMuid() {
        return UUID.randomUUID().toString().replace("-", "").toUpperCase();
    }

    /** Javascript 风格的 UTC 时间串（服务端按这个格式解析） */
    private static String dateString() {
        java.text.SimpleDateFormat fmt =
            new java.text.SimpleDateFormat("EEE MMM dd yyyy HH:mm:ss 'GMT+0000 (Coordinated Universal Time)'",
                java.util.Locale.US);
        fmt.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return fmt.format(new java.util.Date());
    }

    private static String describe(Throwable error) {
        if (error == null) return "未知错误";
        String message = error.getMessage();
        if (message == null || message.isEmpty()) message = error.getClass().getSimpleName();
        return message;
    }
}
