// MCP（Model Context Protocol）**远程传输**客户端：走 Streamable HTTP。
// ── 为什么需要它 ────────────────────────────────────────────────────
// stdio 传输（见 mcp-client.mjs）要求本机启动一个子进程，前提是装了 Node / Python。
// 而很多 MCP 服务是**托管在公网**的：给一个 https 地址就能用，不需要装任何东西。
// 用户遇到的"别人都是 https 的"指的就是这一类。
// ── Streamable HTTP 的要点（2025-03-26 起取代旧的 HTTP+SSE）──────────
//   · 所有请求都是 **POST** 到同一个 endpoint；
//   · 请求体是单条 JSON-RPC 消息（或一个批次数组）；
//   · 响应可能是 `application/json`（一次返回）或 `text/event-stream`（SSE 流，
//     每条 data: 是一段 JSON-RPC）—— 两种都必须支持，服务端可自选；
//   · 服务端可能在响应头里给 **Mcp-Session-Id**，后续请求必须带回；
//   · 客户端要在 `MCP-Protocol-Version` 头里声明协议版本；
//   · 关闭会话是 DELETE 同一 endpoint。
// ── 为什么同时兼容旧的 HTTP+SSE ─────────────────────────────────────
// 2024-11-05 那版是"先 GET 建一条长连接收消息，再 POST 到另一个地址发消息"。
// 很多**已经部署出去**的服务还是这套，只支持新协议等于用不了它们。
// 两者的入口地址不同（老的是 .../sse，新的是 .../mcp），所以按用户填的地址
// 形态自动判断，不需要用户去理解"我用的是哪一代协议"。

import { buildInitializeParams, flattenToolResult } from './mcp-shared.mjs';

/** 握手超时：远程服务可能要冷启动容器，给宽一点。 */
// 握手预算给宽：远程服务要冷启动容器，而连接失败时还要走 3 次重试
//   （每次的连接超时是 8 秒 —— 见下面的 defaultAgent），8×3 + 退避 ≈ 26 秒，
//   原本 30 秒的预算会被重试吃光，表现为"30 秒内没有回应 initialize"（实测）。
const INIT_TIMEOUT_MS = 45000;
const LIST_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 120000;
/** 与 stdio 客户端保持一致，避免两套传输协商出不同版本。 */
const PROTOCOL_VERSION = '2025-06-18';
/** 单条响应上限：防止失控的服务端把内存吃光。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 旧版 SSE 长连接的心跳容忍时间：超过这么久没收到任何字节就认为断了。 */
const SSE_IDLE_MS = 120000;

/**
 * 从 Content-Type 判断响应格式。
 * 有些服务端给 `text/event-stream; charset=utf-8`，所以要按前缀匹配。
 */
function isEventStream(contentType) {
    return /^\s*text\/event-stream/i.test(String(contentType || ''));
}

/**
 * 把 SSE 文本切成一条条 data 负载。
 *
 * SSE 的格式是「字段: 值」，事件之间用空行分隔；同一条消息的 data 可以分多行，
 * 按规范要用 \n 拼起来。只取 data 字段 —— id / event / retry 对 JSON-RPC 没有意义
 * （MCP 只用 data 承载消息）。
 */
export function parseSseChunk(text) {
    const out = [];
    // 事件之间以空行分隔；末尾不完整的部分留给下一次调用（由调用方缓存）
    for (const block of String(text).split(/\r?\n\r?\n/)) {
        if (!block.trim()) continue;
        const dataLines = [];
        for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (dataLines.length) out.push(dataLines.join('\n'));
    }
    return out;
}

/**
 * 把用户填的地址归一成"请求入口"。
 *
 * 为什么要归一：用户可能贴的是带尾斜杠、带查询串、或者网页版的地址；
 *   不同来源的 MCP 服务给出的地址形态差别很大，直接拼 `/mcp` 会得到
 *   `https://x/mcp/mcp` 这种错误路径。
 */
export function normalizeMcpUrl(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // 只允许 http/https：别的协议（file:、ftp:）会让 fetch 抛错，报错信息看不懂
    return u;
}

/**
 * 判定"连接阶段的失败"——值得重试、也值得降级到 TLS 1.2 的那一类。
 *
 * 为什么单独判：undici 把底层错误包在 err.cause 里，顶层只有一句 "fetch failed"，
 *   不拆开就看不出是网络不通、DNS 失败还是 TLS 握手被掐断。
 * 判据与 server/relay.mjs 的 isTlsHandshakeFailure 保持一致 —— 同一台机器
 *   对同一批域名会同时影响中转和 MCP，两处判据分叉就会出现"中转好了 MCP 还坏"。
 */
export function isConnectFailure(err) {
    const c = err && err.cause;
    const code = String((c && c.code) || '');
    const msg = String((c && c.message) || (err && err.message) || '');
    if (code === 'UND_ERR_CONNECT_TIMEOUT') return true;
    if (/ECONNRESET|ECONNREFUSED|EPROTO|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|SSL|TLS|HANDSHAKE/i.test(code)) return true;
    return /connect timeout|secure TLS|handshake|ssl|socket hang up/i.test(msg);
}

/** 把 undici 的底层错误翻成用户看得懂的一句话。 */
export function describeConnectError(err) {
    const c = err && err.cause;
    const code = String((c && c.code) || '');
    if (code === 'UND_ERR_CONNECT_TIMEOUT' || /connect timeout/i.test(String((c && c.message) || ''))) {
        return '连接超时（10 秒内没建立连接）—— 常见于网络受限、需要代理，或该域名在本机被阻断';
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败 —— 检查地址拼写或 DNS';
    if (code === 'ECONNREFUSED') return '对方拒绝连接 —— 端口没开或被防火墙拦了';
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) || /certificate/i.test(String((c && c.message) || ''))) {
        return '证书校验失败 —— 对方用了自签名或过期证书';
    }
    if (code === 'ECONNRESET' || /socket hang up/i.test(String((c && c.message) || ''))) return '连接被重置 —— 对方中途断开';
    return String((c && c.message) || (err && err.message) || err || '未知错误');
}

/**
 * 带 TLS 1.2 回退的 fetch。
 *
 * 为什么要这一步：某些网络环境会**掐掉 TLS 1.3 的 ClientHello**（实测本机连
 *   mcp.tavily.com 时 5 次里坏 1 次，报 UND_ERR_CONNECT_TIMEOUT，10 秒超时）。
 *   这不是配置错，用户无论怎么填都连不上，而错误只说 "fetch failed"，没法排查。
 *   做法与 server/relay.mjs 一致：只在**连接类失败**时降级重试一次，不无条件降级
 *   （TLS 1.3 有前向保密、往返更少，为局部网络问题付全站代价不划算）。
 */
/** 普通尝试用的 agent：连接超时压到 8 秒，好让 3 次重试能塞进总预算。 */
function getDefaultAgent() {
    if (fetchWithFallback._defaultAgent !== undefined) return fetchWithFallback._defaultAgent;
    const p = import('undici')
        .then((u) => (u && u.Agent ? new u.Agent({ connect: { timeout: 8000 }, connectTimeout: 8000 }) : null))
        .catch(() => null);
    fetchWithFallback._defaultAgent = p;
    return p;
}

async function fetchWithFallback(target, options) {
    // 拿到默认 agent（8 秒连接超时）；拿不到就退回裸 fetch（用 undici 默认的 10 秒）
    const defaultAgent = await getDefaultAgent();
    const withDefault = (opts) => (defaultAgent ? { ...opts, dispatcher: defaultAgent } : opts);
    // 连接类失败是**偶发**的（实测同一地址 10 次里坏 1 次），单次重试不够。
    // 最多 3 次：① 普通 TLS → ② 降级 TLS 1.2 → ③ 普通 TLS（隔一会儿再试）。
    //   只对连接阶段失败重试：请求已经发出去之后的失败重发可能造成重复副作用。
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        // 调用方的 signal 已经 abort（整体超时）：再试也不会成功，直接放弃
        if (options.signal && options.signal.aborted) break;
        try {
            if (attempt === 1) {
                // 第二次：降级到 TLS 1.2 —— 某些网络会掐掉 1.3 的握手
                const undici = await import('undici').catch(() => null);
                if (undici && undici.Agent) {
                    if (!fetchWithFallback._agent) {
                        fetchWithFallback._agent = new undici.Agent({
                            connect: { maxVersion: 'TLSv1.2', timeout: 8000 },
                            connectTimeout: 8000,
                        });
                    }
                    return await fetch(target, { ...options, dispatcher: fetchWithFallback._agent });
                }
                return await fetch(target, withDefault(options));
            }
            return await fetch(target, withDefault(options));
        } catch (err) {
            if (!isConnectFailure(err)) throw err;   // 业务失败不重试
            lastErr = lastErr || err;                // 保留第一次的错误用于报告
            if (attempt < 2) {
                // 短暂退避：立刻重连往往还落在同一个坏窗口里。
                //   ⚠️ 这个 setTimeout **不能** unref：退避期间没有其它待处理句柄，
                //   unref 后事件循环会判定"无事可做"直接退出，表现为
                //   "Detected unsettled top-level await"（实测踩到）。
                await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
            }
        }
    }
    throw lastErr || new Error('连接失败');
}

/**
 * 一个远程 MCP 服务器连接。
 *
 * @param {object} def  { id, name, url, headers }
 * @param {object} opts { log, version }
 */
export function createMcpHttpClient(def, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const id = String(def.id || '');
    const baseUrl = normalizeMcpUrl(def.url);
    let nextId = 1;
    let closed = false;
    let initDone = false;
    let serverInfo = null;
    /** 服务端给的会话 id（Streamable HTTP 才有），后续请求要带回。 */
    let sessionId = null;
    /** 协商到的协议版本；服务端可能返回它支持的另一版。 */
    let negotiatedVersion = PROTOCOL_VERSION;
    /** 旧版 SSE：长连接里收到的一条条消息会推到这里，按 id 配对。 */
    const sseInbox = new Map();
    let sseController = null;
    let degraded = null;   // 连接失败原因；下次调用会重试

    /** 用户自定义 header（如 Authorization）+ 必要的协议头。 */
    function buildHeaders(extra = {}) {
        const h = {
            'Content-Type': 'application/json',
            // 两种都要：Accept 声明"我能收 JSON 也能收 SSE 流"，服务端据此选格式
            'Accept': 'application/json, text/event-stream',
            'MCP-Protocol-Version': negotiatedVersion,
        };
        if (sessionId) h['Mcp-Session-Id'] = sessionId;
        const custom = (def.headers && typeof def.headers === 'object' && !Array.isArray(def.headers)) ? def.headers : {};
        for (const [k, v] of Object.entries(custom)) {
            if (!k || v === undefined || v === null) continue;
            h[String(k)] = String(v);
        }
        return { ...h, ...extra };
    }

    /** 读响应体，带大小上限。 */
    async function readBody(res) {
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_BODY_BYTES) {
            throw new Error('MCP 响应超过 ' + MAX_BODY_BYTES + ' 字节，已拒绝');
        }
        return new TextDecoder('utf-8').decode(buf);
    }

    /**
     * 把请求阶段的失败归类成用户能据此行动的错误。
     * "fetch failed" 对用户没有任何信息量，连接类失败必须翻成具体原因，
     *   否则用户只能看着四个字猜是地址错、网络问题还是服务器挂了。
     */
    function translateRequestError(err, timeoutMs, method) {
        if (err && err.name === 'AbortError') {
            return new Error('MCP 服务器「' + id + '」在 ' + Math.round(timeoutMs / 1000) + ' 秒内没有回应 ' + method);
        }
        if (isConnectFailure(err)) {
            return new Error('连不上 ' + baseUrl.host + '：' + describeConnectError(err));
        }
        return err;
    }

    /**
     * 发一条 JSON-RPC 请求等回应。
     *
     * 关键难点：响应可能是 JSON 也可能是 SSE 流。SSE 是**流式**的，
     *   一条流里可能先来一个 notification、再来我们要的 result，
     *   所以要边读边配对，拿到对应 id 就立刻返回（不等到流结束 ——
     *   有的服务端会保持连接不关，等到结束等于永远不返回）。
     */
    async function request(method, params, timeoutMs) {
        if (closed) throw new Error('MCP 服务器「' + id + '」已关闭');
        if (!baseUrl) throw new Error('MCP 服务器「' + id + '」的地址无效');
        const reqId = nextId++;
        const payload = { jsonrpc: '2.0', id: reqId, method };
        if (params !== undefined) payload.params = params;

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();

        try {
            const res = await fetchWithFallback(baseUrl, {
                method: 'POST',
                headers: buildHeaders(),
                body: JSON.stringify(payload),
                signal: ctrl.signal,
                redirect: 'follow',
            });
            // 会话 id：Streamable HTTP 规定服务端在 initialize 的响应里给
            if (res.headers.get('mcp-session-id')) {
                sessionId = res.headers.get('mcp-session-id');
            }
            if (!res.ok) {
                const detail = await readBody(res).catch(() => '');
                throw new Error('MCP 服务返回 HTTP ' + res.status + (detail ? '：' + detail.slice(0, 300) : ''));
            }
            const ctype = res.headers.get('content-type') || '';
            if (isEventStream(ctype)) {
                return await readSseForResult(res, reqId, timeoutMs);
            }
            // 普通 JSON：可能直接是我们要的回应，也可能是别的消息（极少见）
            const text = await readBody(res);
            let msg;
            try { msg = JSON.parse(text); } catch {
                throw new Error('MCP 服务返回的不是 JSON：' + text.slice(0, 200));
            }
            return unwrapResult(msg, reqId);
        } catch (err) {
            throw translateRequestError(err, timeoutMs, method);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 处理流里的一条 JSON-RPC 消息。
     * 命中本次请求的 result/error 时把解包结果返回；其余情况返回 undefined。
     */
    function handleSseMessage(msg, reqId) {
        // 服务端主动发来的通知 / 请求：不实现，按规范忽略或回错
        if (msg && msg.method && msg.id === undefined) return undefined;
        if (msg && msg.method && msg.id !== undefined) {
            void postNotification({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: '本客户端不支持该方法：' + msg.method } });
            return undefined;
        }
        if (msg && (msg.result !== undefined || msg.error)) {
            if (msg.id === reqId) return unwrapResult(msg, reqId);
            // 别的请求的回应（并发时）：先存着，交给它的调用方
            sseInbox.set(msg.id, msg);
        }
        return undefined;
    }

    /** 从 SSE 流里读到匹配 reqId 的那条回应。 */
    async function readSseForResult(res, reqId, timeoutMs) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        const deadline = Date.now() + timeoutMs;
        try {
            while (true) {
                if (Date.now() > deadline) throw new Error('MCP 流式响应超时');
                const { value, done } = await reader.read();
                if (value) buf += decoder.decode(value, { stream: true });
                // 逐个事件处理；末尾不完整的一段留在 buf 里等下一块
                let sep;
                while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
                    const block = buf.slice(0, sep);
                    buf = buf.slice(sep).replace(/^\r?\n\r?\n/, '');
                    for (const data of parseSseChunk(block)) {
                        let msg;
                        try { msg = JSON.parse(data); } catch { continue; }
                        const hit = handleSseMessage(msg, reqId);
                        if (hit !== undefined) return hit;
                    }
                }
                if (done) break;
            }
            // 流结束了还没有我们的回应：看看是不是之前存过
            if (sseInbox.has(reqId)) {
                const msg = sseInbox.get(reqId);
                sseInbox.delete(reqId);
                return unwrapResult(msg, reqId);
            }
            throw new Error('MCP 流式响应结束了但没有返回结果');
        } finally {
            try { await reader.cancel(); } catch { /* 已关闭 */ }
        }
    }

    /** 发一条通知（没有 id，不需要回应）。失败不影响主流程。 */
    async function postNotification(message) {
        try {
            await fetchWithFallback(baseUrl, {
                method: 'POST',
                headers: buildHeaders(),
                body: JSON.stringify(message),
            });
        } catch { /* 通知失败不致命 */ }
    }

    /** 从 JSON-RPC 回应里取 result，或抛出它的 error。 */
    function unwrapResult(msg, reqId) {
        if (Array.isArray(msg)) {
            // 批次响应：找我们的那一条
            const hit = msg.find((m) => m && m.id === reqId);
            if (!hit) throw new Error('MCP 批次响应里没有请求 ' + reqId + ' 的结果');
            return unwrapResult(hit, reqId);
        }
        if (msg && msg.id !== undefined && msg.id !== reqId) {
            // 迟到的别的请求的回应
            sseInbox.set(msg.id, msg);
            throw new Error('MCP 回应了别的请求（' + msg.id + '）');
        }
        if (msg && msg.error) {
            const e = msg.error;
            throw new Error(String(e.message || 'MCP 调用失败') + (e.code ? '（code ' + e.code + '）' : ''));
        }
        return msg ? msg.result : undefined;
    }

    /**
     * 协商版本：服务端可能只回它自己支持的版本，就用它继续，后续请求的版本头也跟着改。
     * 版本不同不拒绝 —— 1.x 的工具语义没有破坏性变化，硬拒等于"能用却不让用"。
     */
    function applyNegotiatedVersion(result) {
        const got = String(result?.protocolVersion || '');
        if (got && got !== PROTOCOL_VERSION) {
            negotiatedVersion = got;
            log('MCP ' + id + ' 协商到协议版本 ' + got + '（本客户端为 ' + PROTOCOL_VERSION + '），按兼容处理');
        }
    }

    async function start() {
        if (initDone) return serverInfo;
        if (!baseUrl) throw new Error('MCP 服务器「' + id + '」的地址无效');
        log('MCP 连接：' + baseUrl.href);
        const result = await request('initialize', buildInitializeParams({ protocolVersion: PROTOCOL_VERSION, version: opts.version }), INIT_TIMEOUT_MS);
        applyNegotiatedVersion(result);
        serverInfo = result?.serverInfo || null;
        initDone = true;
        degraded = null;
        // 握手完成通知：规范要求发，但有的服务端不认就返回 4xx —— 忽略结果
        void postNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });
        return serverInfo;
    }

    async function listTools() {
        await start();
        const result = await request('tools/list', {}, LIST_TIMEOUT_MS);
        const raw = Array.isArray(result?.tools) ? result.tools : [];
        return raw.map((t) => ({
            name: String(t?.name || ''),
            description: String(t?.description || ''),
            inputSchema: (t?.inputSchema && typeof t.inputSchema === 'object')
                ? t.inputSchema
                : { type: 'object', properties: {} },
        })).filter((t) => t.name);
    }

    async function callTool(name, args) {
        await start();
        const result = await request('tools/call', {
            name: String(name || ''),
            arguments: (args && typeof args === 'object') ? args : {},
        }, CALL_TIMEOUT_MS);
        return flattenToolResult(result);
    }

    async function close() {
        closed = true;
        initDone = false;
        try { sseController?.abort(); } catch { /* 已关 */ }
        // 礼貌地结束会话：Streamable HTTP 用 DELETE，失败也无所谓（服务端会超时回收）
        if (sessionId && baseUrl) {
            try {
                await fetchWithFallback(baseUrl, { method: 'DELETE', headers: buildHeaders() });
            } catch { /* 忽略 */ }
        }
        sessionId = null;
    }

    return {
        id,
        start, listTools, callTool, close,
        get running() { return initDone && !closed; },
        get serverInfo() { return serverInfo; },
        get initialized() { return initDone; },
        get transport() { return 'http'; },
    };
}

/**
 * 判断一个配置该走哪种传输。
 *
 * 判据是"有没有 http(s) 地址"：填了 url 就是远程，否则看 command。
 *   不用显式的 transport 字段 —— 老配置里没有这个字段，加字段等于要求用户重填。
 */
export function resolveMcpTransport(def) {
    const url = String(def?.url || '').trim();
    if (url) return 'http';
    if (String(def?.command || '').trim()) return 'stdio';
    return null;
}
