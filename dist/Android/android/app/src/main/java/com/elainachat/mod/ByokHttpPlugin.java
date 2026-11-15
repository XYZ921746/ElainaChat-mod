package com.elainachat.mod;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "ByokHttp")
public class ByokHttpPlugin extends Plugin {
    private static final int MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void post(PluginCall call) {
        String urlValue = call.getString("url", "").trim();
        String body = call.getString("body", "");
        JSObject headers = call.getObject("headers", new JSObject());
        int requestedTimeout = call.getInt("timeoutMs", 120_000);
        int timeoutMs = Math.max(5_000, Math.min(180_000, requestedTimeout));
        executor.execute(() -> executePost(call, urlValue, body, headers, timeoutMs));
    }

    @PluginMethod
    public void get(PluginCall call) {
        String urlValue = call.getString("url", "").trim();
        JSObject headers = call.getObject("headers", new JSObject());
        // asText：JSON 这类文本接口要原文；音频这类二进制接口要 base64。
        // 让调用方指定，而不是两种都塞回去 —— 否则下一个音频文件就要白做一次 UTF-8 解码。
        boolean asText = Boolean.TRUE.equals(call.getBoolean("asText", false));
        int requestedTimeout = call.getInt("timeoutMs", 120_000);
        int timeoutMs = Math.max(5_000, Math.min(180_000, requestedTimeout));
        executor.execute(() -> executeGet(call, urlValue, headers, asText, timeoutMs));
    }

    /**
     * 明文 HTTP 只对本机与局域网地址放行。
     * Ollama、LM Studio、KernelSU 模块网关、局域网 API 网关都在本机或同一张内网里；
     * 而 Android 9 起默认禁明文 —— network_security_config 同步放开这些地址。
     * 公网域名仍然强制 HTTPS，避免把用户的 API Key 明文发出去。
     */
    private static boolean isAllowedUrl(URL url) {
        if ("https".equalsIgnoreCase(url.getProtocol())) return true;
        if (!"http".equalsIgnoreCase(url.getProtocol())) return false;
        String host = url.getHost();
        if (host == null) return false;
        String normalized = host.toLowerCase(Locale.ROOT);
        if (normalized.startsWith("[") && normalized.endsWith("]")) {
            normalized = normalized.substring(1, normalized.length() - 1);
        }
        if (normalized.equals("127.0.0.1")
            || normalized.equals("localhost")
            || normalized.equals("::1")
            || normalized.equals("0:0:0:0:0:0:0:1")) {
            return true;
        }
        // 10.0.2.2 是 Android 模拟器访问宿主机的固定别名，也算本机网络。
        return isPrivateIpv4(normalized);
    }

    /** 只按字面量判断 RFC1918 / 链路本地 IPv4，不做 DNS：域名解析到内网也不能因此放行明文。 */
    private static boolean isPrivateIpv4(String host) {
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] n = new int[4];
        for (int i = 0; i < 4; i++) {
            try {
                n[i] = Integer.parseInt(parts[i]);
            } catch (NumberFormatException error) {
                return false;
            }
            if (n[i] < 0 || n[i] > 255) return false;
        }
        return n[0] == 10
            || (n[0] == 172 && n[1] >= 16 && n[1] <= 31)
            || (n[0] == 192 && n[1] == 168)
            || (n[0] == 169 && n[1] == 254);
    }

    /** 把调用方给的 header 逐个设上去。Host 必须跳过，否则部分服务端会拒绝。 */
    private static void applyHeaders(HttpURLConnection connection, JSObject headers) {
        Iterator<String> headerNames = headers.keys();
        while (headerNames.hasNext()) {
            String name = headerNames.next();
            String value = headers.optString(name, "");
            if (!name.isEmpty() && !value.isEmpty() && !"Host".equalsIgnoreCase(name)) {
                connection.setRequestProperty(name, value);
            }
        }
    }

    private void executePost(PluginCall call, String urlValue, String body, JSObject headers, int timeoutMs) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(urlValue);
            if (!isAllowedUrl(url)) {
                call.reject("Android direct requests require an HTTPS URL");
                return;
            }
            connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(Math.min(timeoutMs, 30_000));
            connection.setReadTimeout(timeoutMs);
            connection.setDoOutput(true);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            applyHeaders(connection, headers);

            byte[] bodyBytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bodyBytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bodyBytes);
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 400
                ? connection.getInputStream()
                : connection.getErrorStream();
            String responseBody = stream == null ? "" : readLimitedUtf8(stream);

            JSObject result = new JSObject();
            result.put("status", status);
            result.put("ok", status >= 200 && status < 300);
            result.put("body", responseBody);
            result.put("contentType", connection.getContentType() == null ? "" : connection.getContentType());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Direct provider request failed: " + error.getMessage(), error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void executeGet(PluginCall call, String urlValue, JSObject headers, boolean asText, int timeoutMs) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(urlValue);
            if (!isAllowedUrl(url)) {
                call.reject("Android direct requests require an HTTPS URL");
                return;
            }
            connection = (HttpURLConnection) url.openConnection();
            // 不跟随重定向：isAllowedUrl 只校验初始地址，跟随后的地址不再过一次
            // 明文/主机判定，而调用方给的请求头（x-api-key 等）会被带到新地址。
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(Math.min(timeoutMs, 30_000));
            connection.setReadTimeout(timeoutMs);
            connection.setDoInput(true);
            connection.setRequestProperty("Accept", asText ? "application/json" : "*/*");
            applyHeaders(connection, headers);

            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 400
                ? connection.getInputStream()
                : connection.getErrorStream();
            byte[] body = stream == null ? new byte[0] : readLimitedBinary(stream);

            JSObject result = new JSObject();
            result.put("status", status);
            result.put("ok", status >= 200 && status < 300);
            result.put("body", asText
                ? new String(body, StandardCharsets.UTF_8)
                : Base64.encodeToString(body, Base64.NO_WRAP));
            result.put("contentType", connection.getContentType() == null ? "" : connection.getContentType());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Direct provider request failed: " + error.getMessage(), error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String readLimitedUtf8(InputStream stream) throws Exception {
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_RESPONSE_BYTES) throw new IllegalStateException("Provider response is too large");
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private byte[] readLimitedBinary(InputStream stream) throws Exception {
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_RESPONSE_BYTES) throw new IllegalStateException("Provider response is too large");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }
}
