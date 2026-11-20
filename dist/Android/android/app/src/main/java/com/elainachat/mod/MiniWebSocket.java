package com.elainachat.mod;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * 极简 WebSocket 客户端（客户端侧，RFC 6455 的最小可用子集）。
 *
 * <p><b>为什么不能用浏览器自带的 {@code WebSocket}</b>：Edge TTS 的端点会校验
 * 浏览器指纹（{@code User-Agent}）。WebView 里 JS 的 {@code new WebSocket(url)}
 * <b>不允许自定义任何请求头</b>，只能带 WebView 自己的 UA，于是握手被拒 ——
 * 实测：缺 UA 返回 <b>403</b>，补上完整浏览器头后立刻 <b>101 Switching Protocols</b>。
 *
 * <p><b>为什么不用 {@code HttpURLConnection}</b>：
 * JDK 把 {@code Connection} / {@code Upgrade} 列为**受限头**，
 * {@code setRequestProperty} 会被静默忽略 —— 而这两个正是 WebSocket 握手的核心。
 * 少了它们，服务端不把它当握手，返回 400/404。
 * 实测对照：完整头 → 101；去掉 Connection/Upgrade → 404。所以必须直接操作字节流。
 *
 * <p>因此这里用 {@link Socket} / {@link SSLSocket} 手写握手 —— 完全控制发出去的每一个头。
 * 本项目不加第三方依赖（没有 OkHttp）。
 */
final class MiniWebSocket implements AutoCloseable {

    private final Socket socket;
    private final InputStream in;
    private final OutputStream out;
    private final SecureRandom random = new SecureRandom();

    private MiniWebSocket(Socket socket) throws Exception {
        this.socket = socket;
        this.in = new BufferedInputStream(socket.getInputStream(), 64 * 1024);
        this.out = socket.getOutputStream();
    }

    /**
     * 建立连接（完成握手）。
     *
     * @param url     形如 {@code wss://host/path?query}
     * @param headers 额外请求头（这里是 Edge TTS 成败的关键：User-Agent / Origin / Pragma …）
     */
    static MiniWebSocket connect(String url, java.util.Map<String, String> headers, int timeoutMs) throws Exception {
        URI uri = URI.create(url);
        String scheme = uri.getScheme() == null ? "wss" : uri.getScheme().toLowerCase();
        boolean tls = "wss".equals(scheme) || "https".equals(scheme);
        String host = uri.getHost();
        int port = uri.getPort() > 0 ? uri.getPort() : (tls ? 443 : 80);
        String path = uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath();
        if (uri.getRawQuery() != null) path += "?" + uri.getRawQuery();

        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(host, port), Math.max(3000, Math.min(timeoutMs, 15000)));
        raw.setSoTimeout(timeoutMs);
        raw.setTcpNoDelay(true);
        Socket socket;
        if (tls) {
            // Android 的 SSLSocketFactory 没有 createSocket(Socket,String,int,boolean) 重载，
            // 用 (Socket, host, port, autoClose) 的四参形式。
            SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault())
                .createSocket(raw, host, port, true);
            ssl.setSoTimeout(timeoutMs);
            ssl.startHandshake();
            socket = ssl;
        } else {
            socket = raw;
        }

        byte[] nonce = new byte[16];
        new SecureRandom().nextBytes(nonce);
        String key = Base64.getEncoder().encodeToString(nonce);

        // 直接拼 HTTP 请求 —— 这样才能保证 Connection / Upgrade 真的发出去
        StringBuilder req = new StringBuilder();
        req.append("GET ").append(path).append(" HTTP/1.1\r\n");
        req.append("Host: ").append(host).append(port == 443 || port == 80 ? "" : ":" + port).append("\r\n");
        req.append("Connection: Upgrade\r\n");
        req.append("Upgrade: websocket\r\n");
        req.append("Sec-WebSocket-Key: ").append(key).append("\r\n");
        req.append("Sec-WebSocket-Version: 13\r\n");
        if (headers != null) {
            for (java.util.Map.Entry<String, String> e : headers.entrySet()) {
                if (e.getKey() == null || e.getValue() == null) continue;
                req.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
        }
        req.append("\r\n");

        OutputStream os = socket.getOutputStream();
        os.write(req.toString().getBytes(StandardCharsets.ISO_8859_1));
        os.flush();

        // 读响应头（到空行为止），只看状态行
        InputStream is = socket.getInputStream();
        String statusLine = readLine(is);
        if (statusLine == null) {
            closeQuietly(socket);
            throw new IllegalStateException("WebSocket 握手失败：连接被关闭（没有响应）");
        }
        int status = 0;
        try {
            String[] parts = statusLine.split(" ");
            if (parts.length >= 2) status = Integer.parseInt(parts[1]);
        } catch (NumberFormatException ignored) { /* 保持 0，下面按失败处理 */ }

        StringBuilder body = new StringBuilder();
        String line;
        while ((line = readLine(is)) != null && !line.isEmpty()) { /* 跳过响应头 */ }
        if (status != 101) {
            // 把响应体读一点出来当错误信息（400/403 时服务端会说明原因）
            try {
                int c;
                int n = 0;
                while (n < 400 && (c = is.read()) >= 0) { body.append((char) c); n++; }
            } catch (Exception ignored) { /* 读不到就算了 */ }
            closeQuietly(socket);
            String detail = body.toString().replaceAll("<[^>]+>", " ").replaceAll("\\s+", " ").trim();
            throw new IllegalStateException("WebSocket 握手失败：HTTP " + status
                + (detail.isEmpty() ? "" : "（" + detail.substring(0, Math.min(180, detail.length())) + "）"));
        }
        return new MiniWebSocket(socket);
    }

    /** 读一行（CRLF 结尾），返回不含 CRLF 的内容；流结束返回 null */
    private static String readLine(InputStream is) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(128);
        int c;
        while ((c = is.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') buf.write(c);
        }
        if (c < 0 && buf.size() == 0) return null;
        return new String(buf.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    private static void closeQuietly(Socket socket) {
        try { socket.close(); } catch (Exception ignored) { }
    }

    /** 发一个文本帧（客户端必须掩码 —— 这是 RFC 强制要求） */
    synchronized void sendText(String text) throws Exception {
        sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8));
    }

    private void sendFrame(int opcode, byte[] payload) throws Exception {
        ByteArrayOutputStream frame = new ByteArrayOutputStream(payload.length + 14);
        frame.write(0x80 | opcode);                      // FIN + opcode
        int len = payload.length;
        if (len < 126) {
            frame.write(0x80 | len);                     // MASK + 长度
        } else if (len < 65536) {
            frame.write(0x80 | 126);
            frame.write((len >>> 8) & 0xFF);
            frame.write(len & 0xFF);
        } else {
            frame.write(0x80 | 127);
            for (int i = 7; i >= 0; i--) frame.write((int) (((long) len >>> (8 * i)) & 0xFF));
        }
        byte[] mask = new byte[4];
        random.nextBytes(mask);
        frame.write(mask);
        byte[] masked = new byte[len];
        for (int i = 0; i < len; i++) masked[i] = (byte) (payload[i] ^ mask[i % 4]);
        frame.write(masked);
        out.write(frame.toByteArray());
        out.flush();
    }

    /** 收一帧。返回 null 表示连接已关闭。 */
    Frame receive() throws Exception {
        while (true) {
            int b0 = in.read();
            if (b0 < 0) return null;
            int b1 = in.read();
            if (b1 < 0) return null;

            int opcode = b0 & 0x0F;
            boolean masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7F;
            if (len == 126) {
                len = ((long) readByte() << 8) | readByte();
            } else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | readByte();
            }
            byte[] mask = null;
            if (masked) {
                mask = new byte[4];
                readFully(mask, 4);
            }
            byte[] payload = new byte[(int) len];
            readFully(payload, (int) len);
            if (masked) {
                for (int i = 0; i < payload.length; i++) payload[i] = (byte) (payload[i] ^ mask[i % 4]);
            }

            switch (opcode) {
                case 0x1:   // 文本
                case 0x2:   // 二进制
                    return new Frame(opcode, payload);
                case 0x8:   // close
                    return null;
                case 0x9:   // ping → 回 pong
                    sendFrame(0xA, payload);
                    break;
                case 0xA:   // pong，忽略
                default:    // 其它（含分片续帧）忽略 —— Edge TTS 不会发
                    break;
            }
        }
    }

    private int readByte() throws Exception {
        int v = in.read();
        if (v < 0) throw new IllegalStateException("连接已关闭");
        return v;
    }

    private void readFully(byte[] buf, int len) throws Exception {
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) throw new IllegalStateException("连接已关闭");
            off += n;
        }
    }

    @Override
    public void close() {
        try {
            // 正规关闭：发一个 close 帧（best-effort，失败也无所谓）
            sendFrame(0x8, new byte[0]);
        } catch (Exception ignored) { /* 已经断了 */ }
        try { in.close(); } catch (Exception ignored) { }
        try { out.close(); } catch (Exception ignored) { }
        closeQuietly(socket);
    }

    /** 收到的一帧 */
    static final class Frame {
        final int opcode;          // 0x1 = 文本，0x2 = 二进制
        final byte[] payload;
        Frame(int opcode, byte[] payload) {
            this.opcode = opcode;
            this.payload = payload;
        }
        boolean isText() { return opcode == 0x1; }
        String text() { return new String(payload, StandardCharsets.UTF_8); }
    }
}
