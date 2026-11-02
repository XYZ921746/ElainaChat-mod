// 最小 WebSocket 客户端（RFC 6455）—— 只为连 Chrome DevTools Protocol 用。
// ── 为什么不直接用全局 WebSocket ───────────────────────────────────────
// 全局 `WebSocket` 在 Node 21 才出现、22 才稳定。本项目 README 写的是
//   「Node.js ≥ 20」，而 20 上没有这个全局量 —— 直接 `new WebSocket(...)`
//   会在 20 上抛 ReferenceError，表现是"浏览器功能在别人的机器上整个不可用"，
//   而作者本机（22+）一切正常。这类"只有别人机器上坏"的差异最难查。
// 所以这里自己实现握手与帧编解码。代价是 ~150 行，收益是这个能力不挑 Node 版本。
//   CDP 只用文本帧、单向请求/响应、服务端不回压缩（我们不发
//   Sec-WebSocket-Extensions，Chrome 也就不会启用 permessage-deflate），
//   所以协议子集足够小，实现风险可控。
// ── 实现范围（够用即止）────────────────────────────────────────────────
//   · 客户端→服务端：**必须掩码**（RFC 要求），只发文本帧；
//   · 服务端→客户端：不掩码，处理分片（continuation）、ping/pong、close；
//   · 不做：压缩、二进制帧、子协议协商。
// 帧格式与掩码逻辑抽成纯函数（encodeClientFrame / createFrameDecoder），
//   这样不连 Chrome 也能穷举断言 —— 掩码算错的表现是"连上但立刻断开"，
//   光看日志根本看不出是这里错了。
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 单条消息上限。CDP 的截图响应可以有几十 MB base64，给宽一点。 */
export const WS_MAX_MESSAGE = 64 * 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * 编一个客户端→服务端的帧。
 *
 * 客户端帧**必须**带掩码位与 4 字节掩码键（RFC 6455 §5.3）：
 *   Chrome 收到不带掩码的客户端帧会直接断开连接，且**不会**在 CDP 里报错 ——
 *   现象就是"握手成功、随后静默关闭"。所以这里无条件掩码。
 *
 * @param {number} opcode
 * @param {Buffer} payload
 */
export function encodeClientFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
    const len = data.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | (opcode & 0x0f);   // FIN=1
    const mask = randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
}

/**
 * 增量帧解码器：喂 Buffer，产出完整的**消息**（已合并分片）。
 *
 * 为什么按"消息"而不是"帧"交付：CDP 的一条响应可能被拆成多个 continuation 帧
 *   （大截图必然如此）。把合并交给调用方，等于让每个调用点都写一遍同样的
 *   "攒够没有"判断，漏一处就是"偶尔解析到半个 JSON"。
 *
 * @param {{onMessage:(text:string)=>void, onClose?:()=>void, onError?:(e:Error)=>void, onPing?:(payload:Buffer)=>void}} handlers
 * @returns {{push:(chunk:Buffer)=>void}}
 */
export function createFrameDecoder({ onMessage, onClose, onError, onPing }) {
    let buf = Buffer.alloc(0);
    let fragments = [];
    let fragOpcode = 0;

    const fail = (msg) => {
        if (onError) onError(new Error(msg));
        if (onClose) onClose();
    };

    function deliver(opcode, payload) {
        if (opcode === OP_CONT) {
            fragments.push(payload);
            // 分片消息没有"长度前缀"，只能等 FIN 位 —— 由调用方在 fin 时合并
            return;
        }
        fragments = [payload];
        fragOpcode = opcode;
    }

    function finish() {
        const whole = Buffer.concat(fragments);
        fragments = [];
        const op = fragOpcode;
        fragOpcode = 0;
        if (op === OP_TEXT) onMessage(whole.toString('utf8'));
        else if (op === OP_BINARY) onMessage(whole.toString('utf8'));   // CDP 不发二进制，容错处理
    }

    function push(chunk) {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
            if (buf.length < 2) return;
            const b0 = buf[0];
            const b1 = buf[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let offset = 2;
            if (len === 126) {
                if (buf.length < offset + 2) return;
                len = buf.readUInt16BE(offset);
                offset += 2;
            } else if (len === 127) {
                if (buf.length < offset + 8) return;
                const big = buf.readBigUInt64BE(offset);
                if (big > BigInt(WS_MAX_MESSAGE)) { fail('WebSocket 帧超过上限'); return; }
                len = Number(big);
                offset += 8;
            }
            let maskKey = null;
            if (masked) {
                if (buf.length < offset + 4) return;
                maskKey = buf.subarray(offset, offset + 4);
                offset += 4;
            }
            if (buf.length < offset + len) return;
            let payload = buf.subarray(offset, offset + len);
            if (maskKey) {
                const out = Buffer.allocUnsafe(len);
                for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
                payload = out;
            } else {
                payload = Buffer.from(payload);   // 复制：底层 buf 会被重新赋值
            }
            buf = buf.subarray(offset + len);

            if (opcode === OP_CLOSE) {
                if (onClose) onClose();
                return;
            }
            if (opcode === OP_PING) {
                // 必须回 pong，否则 Chrome 会在一段时间后判定连接死亡。
                // 回什么由调用方决定（connectWebSocket 会把它原样打回去）。
                if (typeof onPing === 'function') {
                    try { onPing(payload); } catch { /* 回包失败不该中断解码 */ }
                }
                continue;
            }
            if (opcode === OP_PONG) continue;

            if (opcode === OP_CONT) {
                fragments.push(payload);
            } else {
                fragments = [payload];
                fragOpcode = opcode;
            }
            if (fin) finish();
        }
    }

    return { push };
}

/**
 * 连一个 ws:// 地址，握手成功后返回一个"发对象、收对象"的通道。
 *
 * @param {string} rawUrl 形如 ws://127.0.0.1:9222/devtools/page/<id>
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{send:(obj:object)=>void, close:()=>void, onMessage:(fn:(obj:object)=>void)=>void, onClose:(fn:()=>void)=>void}>}
 */
export function connectWebSocket(rawUrl, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 10000;
    const url = new URL(rawUrl);
    if (url.protocol !== 'ws:') throw new Error('只支持 ws:// 地址：' + rawUrl);

    return new Promise((resolve, reject) => {
        const key = randomBytes(16).toString('base64');
        const socket = connect({ host: url.hostname, port: Number(url.port) || 80 });
        let settled = false;
        let messageHandler = null;
        let closeHandler = null;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch { /* 已断 */ }
            reject(new Error('WebSocket 握手超时（' + timeoutMs + 'ms）'));
        }, timeoutMs);

        const decoder = createFrameDecoder({
            onMessage: (text) => {
                if (!messageHandler) return;
                let obj;
                try { obj = JSON.parse(text); } catch { return; }   // CDP 只发 JSON；坏包直接丢
                try { messageHandler(obj); } catch { /* 消费方出错不该拖垮连接 */ }
            },
            onClose: () => {
                try { socket.end(); } catch { /* 已断 */ }
                if (closeHandler) closeHandler();
            },
            // 收到 PING 必须回 PONG（RFC 6455 §5.5.3）；否则对端会按超时断开。
            onPing: (payload) => {
                if (socket.destroyed) return;
                try { socket.write(encodeClientFrame(OP_PONG, payload)); } catch { /* 已断 */ }
            },
        });

        socket.setNoDelay(true);
        socket.on('error', (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(err);
                return;
            }
            if (closeHandler) closeHandler();
        });
        socket.on('close', () => {
            clearTimeout(timer);
            if (!settled) { settled = true; reject(new Error('WebSocket 连接被关闭')); return; }
            if (closeHandler) closeHandler();
        });

        let handshakeBuf = Buffer.alloc(0);
        const onHandshakeData = (chunk) => {
            handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
            const end = handshakeBuf.indexOf('\r\n\r\n');
            if (end < 0) {
                if (handshakeBuf.length > 64 * 1024) {
                    settled = true;
                    clearTimeout(timer);
                    socket.destroy();
                    reject(new Error('WebSocket 握手响应异常（过大）'));
                }
                return;
            }
            socket.removeListener('data', onHandshakeData);
            const head = handshakeBuf.subarray(0, end).toString('utf8');
            const rest = handshakeBuf.subarray(end + 4);
            const statusLine = head.split('\r\n')[0] || '';
            if (!/^HTTP\/1\.1 101\b/.test(statusLine)) {
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                reject(new Error('WebSocket 握手被拒绝：' + statusLine));
                return;
            }
            const headers = {};
            for (const line of head.split('\r\n').slice(1)) {
                const i = line.indexOf(':');
                if (i < 0) continue;
                headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            }
            const expected = createHash('sha1').update(key + WS_GUID).digest('base64');
            if (headers['sec-websocket-accept'] !== expected) {
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                reject(new Error('WebSocket 握手校验失败（Sec-WebSocket-Accept 不匹配）'));
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.on('data', (c) => decoder.push(c));
            if (rest.length) decoder.push(rest);
            resolve({
                send(obj) {
                    if (socket.destroyed) return;
                    try { socket.write(encodeClientFrame(OP_TEXT, JSON.stringify(obj))); } catch { /* 已断 */ }
                },
                close() {
                    try { socket.write(encodeClientFrame(OP_CLOSE, Buffer.alloc(0))); } catch { /* 已断 */ }
                    try { socket.end(); } catch { /* 已断 */ }
                },
                onMessage(fn) { messageHandler = fn; },
                onClose(fn) { closeHandler = fn; },
            });
        };
        socket.on('data', onHandshakeData);
        socket.on('connect', () => {
            const pathWithQuery = url.pathname + (url.search || '');
            socket.write(
                'GET ' + pathWithQuery + ' HTTP/1.1\r\n'
                + 'Host: ' + url.host + '\r\n'
                + 'Upgrade: websocket\r\n'
                + 'Connection: Upgrade\r\n'
                + 'Sec-WebSocket-Key: ' + key + '\r\n'
                + 'Sec-WebSocket-Version: 13\r\n'
                + '\r\n'
            );
        });
    });
}

export const __test__ = { WS_GUID, OP_TEXT, OP_CLOSE, OP_PING };
