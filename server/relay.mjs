// 本地中转 /api/relay —— 电脑端与手机端共用的这一份实现：把请求搬到 Node 侧发出（Node 没有 CORS），是 BYOK 直连被 CORS 挡住时的唯一出路，手机端 WebView 与内嵌服务本来就跨源。
// 依赖注入而不是 import 宿主：需要注入 traceLine 与三个安全判定（isLocalRequest / isLoopbackHostname / isInternalAddress），缺了它们等于静默关掉 SSRF 防护。Key 只经本机进程内存，不落盘、不发第三方。

import dns from 'node:dns';
import { jsonResponse, readJsonBody } from './http-util.mjs';

/** 有些网络只对 TLS 1.3 的 ClientHello 丢包、对 1.2 却放行：TCP 能建、握手必然卡到超时，fetch 只报 UND_ERR_CONNECT_TIMEOUT，看着像"连不上"（其实 TCP 早通了）；只在握手类失败时回退一次 —— 无条件降级等于让所有上游都少掉 1.3 的前向保密，undici 把底层错误包在 err.cause 里，业务 4xx/5xx 不会抛到这里 */
function isTlsHandshakeFailure(err) {
    const c = err && err.cause;
    const code = String((c && c.code) || '');
    const msg = String((c && c.message) || (err && err.message) || '');
    if (code === 'UND_ERR_CONNECT_TIMEOUT') return true;
    if (/ECONNRESET|EPROTO|SSL|TLS|HANDSHAKE/i.test(code)) return true;
    return /connect timeout|secure TLS|handshake|ssl/i.test(msg);
}

/** 限制到 TLS 1.2 的重试。拿不到 undici 就返回 null（调用方按原样报错） */
async function retryWithTls12(target, options, traceLine) {
    // Node 未导出 undici 的稳定入口，所以动态 import —— 只在**真要重试**时才付出这个开销。
    //   零依赖项目里 undici 是 Node 内置的，正常情况下 import 得到；被裁剪过的运行时才拿不到。
    const undici = await import('undici').catch(() => null);
    if (!undici || !undici.Agent) return null;
    if (!retryWithTls12._agent) {
        retryWithTls12._agent = new undici.Agent({
            connect: { maxVersion: 'TLSv1.2', timeout: 30000 },
            connectTimeout: 30000,
        });
    }
    try {
        const upstream = await fetch(target, { ...options, dispatcher: retryWithTls12._agent });
        traceLine(`===== TLS 握手失败，已用 TLS 1.2 重试成功 ${target.host} =====`);
        return upstream;
    } catch {
        // 重试也失败：交给调用方报**原始**错误 —— 第一个才是"为什么一开始不行"的事实。
        return null;
    }
}

// 对话历史、语音 base64、图片 base64 都会走这条通道，给宽一点（和端侧数据同一个量级）。
export const RELAY_BODY_LIMIT = 32 * 1024 * 1024;
export const RELAY_TIMEOUT_MAX = 10 * 60 * 1000;
// 超过这个大小的请求体不再解析内容（JSON.parse 一个 32MB 的图片请求要几百毫秒，
// 平白给对话加延迟）。此时只记大小，不记消息。
export const RELAY_TRACE_PARSE_MAX = 16 * 1024 * 1024;
// 这些地址是云厂商元数据服务，被中转当作跳板去读会泄露本机凭据，直接封掉。
export const RELAY_DENY_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.tencent.internal']);

const TRACE_MSG_MAX = 4000;                // 单条消息最多记多少字
const TRACE_BODY_MAX = 64 * 1024;          // 写进追踪日志的单次响应上限
// 内存里最多攒多少响应字节。比 TRACE_BODY_MAX 大，是因为非流式响应必须**完整**才能 JSON.parse
// 出内容 —— 但也不是无上限，图片/语音那种几十 MB 的响应只透传、不记录。
const TRACE_ACCUM_MAX = 256 * 1024;

// 追踪埋在中转这一层：/api/relay 是所有对外 AI 请求的唯一出口（三种对话格式、获取模型、语音、视觉全走它），埋在这里就覆盖全部，前端一行都不用改。
// 主日志只留一行摘要，完整内容进追踪日志 —— 出问题时必须能还原"问了什么、答了什么、上游为什么拒"。

/** 把消息内容拍平成可读文本；图片等二进制只记大小，绝不记 base64（否则日志瞬间膨胀） */
export function flattenContent(content) {
    if (typeof content === 'string') return content;
    if (content === null || content === undefined) return '';
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            const type = String(part.type || '');
            if (/image/i.test(type)) {
                const data = String(part.image_url?.url || part.source?.data || part.data || '');
                return data ? `[图片 约 ${Math.round(data.length * 3 / 4)} 字节]` : '[图片]';
            }
            if (part.text !== undefined) return String(part.text);
            if (part.content !== undefined) return flattenContent(part.content);
            return `[${type || '未知片段'}]`;
        }).filter(Boolean).join('\n');
    }
    if (typeof content === 'object') {
        if (content.text !== undefined) return String(content.text);
        return JSON.stringify(content);
    }
    return String(content);
}

/** 从请求体里抽「模型 + 消息列表」，兼容三种对话格式；不是对话请求就返回 null */
export function summarizeChatRequest(json) {
    if (!json || typeof json !== 'object') return null;
    const messages = [];
    // Anthropic 把系统提示放在顶层的 system 字段
    if (json.system !== undefined) messages.push({ role: 'system', text: flattenContent(json.system) });
    const list = Array.isArray(json.messages) ? json.messages
        : (Array.isArray(json.input) ? json.input : null);   // OpenAI Responses 用 input[]
    if (!list) return messages.length ? { model: String(json.model || ''), messages } : null;
    for (const m of list) {
        if (!m || typeof m !== 'object') continue;
        messages.push({
            role: String(m.role || (m.type === 'message' ? 'assistant' : 'user')),
            text: flattenContent(m.content !== undefined ? m.content : m),
        });
    }
    return { model: String(json.model || ''), messages };
}

/** 从响应体里抽回复正文（三种格式，含流式分片） */
export function extractReplyText(json) {
    if (!json || typeof json !== 'object' || json.error) return '';
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    if (choice) {
        const text = flattenContent((choice.message || choice.delta || {}).content);
        if (text) return text;
    }
    // Anthropic 流式：{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}
    if (json.delta && typeof json.delta === 'object' && typeof json.delta.text === 'string' && json.delta.text) {
        return json.delta.text;
    }
    // OpenAI Responses 流式：{"type":"response.output_text.delta","delta":"…"}
    if (typeof json.delta === 'string' && json.delta) return json.delta;
    if (typeof json.output_text === 'string' && json.output_text) return json.output_text;
    if (Array.isArray(json.output)) {
        const parts = [];
        for (const item of json.output) {
            for (const c of (item && Array.isArray(item.content) ? item.content : [])) {
                if (c && typeof c.text === 'string') parts.push(c.text);
            }
        }
        if (parts.length) return parts.join('\n');
    }
    if (Array.isArray(json.content)) {
        const parts = json.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text);
        if (parts.length) return parts.join('\n');
    }
    return '';
}

/** 抽错误原因。FastAPI 系网关会把真正的文案套在 detail.error.message 里，必须挖到底 */
export function extractErrorText(json, rawText) {
    if (json && typeof json === 'object') {
        const candidates = [
            json.error?.message, json.error?.error?.message,
            json.detail?.error?.message, json.detail?.message,
            typeof json.detail === 'string' ? json.detail : '', json.message,
        ];
        for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
        if (json.error && typeof json.error === 'object') return JSON.stringify(json.error);
    }
    return String(rawText || '').trim();
}

const clip = (text, max, label) => (text.length > max ? `${text.slice(0, max)}…（${label}，共 ${text.length} 字）` : text);

/** 从 SSE 文本里把分片拼回完整回复（流式对话的响应体不是 JSON，直接读会得到一坨 data: 行） */
export function parseSseReply(rawText) {
    const parts = [];
    for (const line of String(rawText).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;    // event: / id: / 心跳注释行直接跳过
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const piece = extractReplyText(JSON.parse(payload));
            if (piece) parts.push(piece);
        } catch { /* 被截断的最后一行、或非 JSON 的心跳，忽略 */ }
    }
    return parts.join('');
}

/**
 * 流式响应里的报错，状态码常常是 200 —— 错在 data: 行里，不特意挖一下，用户只看到"AI 不回话"而日志一片祥和。
 */
export function parseSseError(rawText) {
    for (const line of String(rawText).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const json = JSON.parse(payload);
            if (json && (json.error || json.type === 'error')) return extractErrorText(json, payload);
        } catch { /* 同上 */ }
    }
    return '';
}

/**
 * 空闲超时 + 客户端断开处理：每收到一块数据就续期，只有真正卡死才 abort。不能按总时长砍（长回复、高思考强度模型的首字节本身就常超 120s），但必须有 RELAY_TIMEOUT_MAX 硬顶，否则"一直发心跳、永远不说正文"能把连接永远占住。
 */
function createRelayAbort(response, timeoutMs) {
    const controller = new AbortController();
    const startedAt = Date.now();
    const hardDeadline = startedAt + RELAY_TIMEOUT_MAX;
    let timer = null;
    let abortedByClient = false;
    const armIdleTimer = (ms) => {
        if (timer) clearTimeout(timer);
        const remaining = hardDeadline - Date.now();
        if (remaining <= 0) { controller.abort(); return; }
        timer = setTimeout(() => controller.abort(), Math.min(ms, remaining));
    };
    armIdleTimer(timeoutMs);   // 第一段：等响应头（TTFB）
    // 客户端自己走了就别再等上游；writableEnded 为真说明是正常结束，不算中断。
    response.on('close', () => {
        if (!response.writableEnded) { abortedByClient = true; controller.abort(); }
    });
    return {
        controller,
        startedAt,
        armIdleTimer,
        stop() { if (timer) clearTimeout(timer); },
        get abortedByClient() { return abortedByClient; },
    };
}

/** 中转超时参数的上下界：默认 120s，最少 1s，最多 RELAY_TIMEOUT_MAX。 */
function relayTimeoutMs(payload) {
    return Math.min(Math.max(Number(payload?.timeoutMs) || 120000, 1000), RELAY_TIMEOUT_MAX);
}

/** 按方法与 payload.body 组装要发给上游的 body，并解析一份"只给日志用"的 JSON。 */
function readRelayBody(payload, method) {
    const sendBody = !(method === 'GET' || method === 'HEAD');
    const bodyValue = typeof payload?.body === 'string'
        ? payload.body
        : (payload?.body === undefined || payload?.body === null ? undefined : JSON.stringify(payload.body));
    const reqRaw = typeof bodyValue === 'string' ? bodyValue : '';
    // 解析请求体只为了记日志。超大请求（图片 / 语音 base64）跳过：JSON.parse 一个
    //   几十 MB 的对象要几百毫秒，为了日志给每次对话平白加延迟不划算。
    let reqJson = null;
    if (reqRaw && Buffer.byteLength(reqRaw) <= RELAY_TRACE_PARSE_MAX) {
        try { reqJson = JSON.parse(reqRaw); } catch { reqJson = null; }
    }
    return { sendBody, bodyValue, reqRaw, reqJson };
}

/** 组装 fetch 参数。redirect 必须 manual：3xx 的 Location 是攻击者可控的，跟随它可绕过 SSRF 校验。 */
function buildRelayFetchOptions({ method, headers, bodyValue, sendBody, signal }) {
    return {
        method,
        headers,
        body: sendBody ? bodyValue : undefined,
        signal,
        redirect: 'manual',
    };
}

/** 把一个失败翻译成能直接 grep 的文案；AbortError 单独说"超时"。 */
function formatRelayFailure(err, timeoutMs) {
    const cause = err?.cause;
    if (err?.name === 'AbortError') return `超过 ${Math.round(timeoutMs / 1000)} 秒没有响应`;
    return String(cause?.message || err?.message || err) + (cause?.code ? ` [${cause.code}]` : '');
}

/** 写上游响应头并立即 flush：fetch 收到头就 resolve，不 flush 会让"开始流式"整体后移。 */
function writeUpstreamHeaders(upstream, response) {
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    response.writeHead(upstream.status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        // SSE 必须关掉缓冲：否则中间层会攒够一块才发，增量变成"一批一批蹦"。
        ...(/text\/event-stream/i.test(upstream.headers.get('content-type') || '')
            ? { 'X-Accel-Buffering': 'no' } : {}),
    });
    if (typeof response.flushHeaders === 'function') {
        try { response.flushHeaders(); } catch { /* 已经发过头了 */ }
    }
}

/**
 * 边透传边攒一份日志用的响应文本：攒到 TRACE_ACCUM_MAX 就停止记录但继续透传，免得一个长回答把内存吃掉；流式正文稍后由 parseSseReply 从 data: 行拼回来。
 */
async function forwardUpstreamBody(upstream, response, armIdleTimer, timeoutMs, isAbortedByClient) {
    const traceChunks = [];
    let traceBytes = 0;
    if (upstream.body) {
        try {
            for await (const chunk of upstream.body) {
                if (isAbortedByClient()) break;
                // 每收到一块就续期：只要上游还在吐数据，长回复就永远不会被自己的超时砍断。
                armIdleTimer(timeoutMs);
                response.write(chunk);
                if (traceBytes < TRACE_ACCUM_MAX) {
                    traceChunks.push(chunk);
                    traceBytes += chunk.length;
                }
            }
        } catch (err) {
            if (!isAbortedByClient()) console.error('[relay] 透传响应中断:', String(err?.message || err));
        }
    }
    return traceChunks.length ? Buffer.concat(traceChunks).toString('utf8') : '';
}

/** 造一个中继处理器。deps 需显式给出 traceLine（不传则退化为只写主日志，会丢掉问答全文）与三个安全判定（isLocalRequest / isLoopbackHostname / isInternalAddress）：后三个刻意不设默认值，漏传等于把"非本机请求"一律当本机放行、把 SSRF 防护静默关掉；手机端只绑回环也要显式写等价实现（见 web/nodejs/bootstrap.mjs），将来谁改了监听地址就会立刻看见问题 */
export function createRelay(deps) {
    const { traceLine = () => { }, isLocalRequest, isLoopbackHostname, isInternalAddress } = deps || {};
    for (const [name, fn] of [['isLocalRequest', isLocalRequest], ['isLoopbackHostname', isLoopbackHostname], ['isInternalAddress', isInternalAddress]]) {
        if (typeof fn !== 'function') throw new Error(`createRelay 缺少依赖 ${name}（它决定 SSRF 防护，不能省）`);
    }

    /** 校验中转目标地址（协议 / 云元数据 / SSRF）：任一检查不通过就直接回错并返回 null；调用方见到 null 立即 return */
    async function resolveRelayTarget(request, response, payload) {
        let target;
        try { target = new URL(String(payload?.url || '')); }
        catch {
            console.warn('[relay] 目标地址无效：' + String(payload?.url || '(空)').slice(0, 200));
            jsonResponse(response, 400, { ok: false, relayError: true, message: '中转目标地址无效' });
            return null;
        }

        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            console.warn(`[relay] 不支持的协议 ${target.protocol}//${target.host}，只允许 http/https`);
            jsonResponse(response, 400, { ok: false, relayError: true, message: '中转只支持 http/https' });
            return null;
        }
        if (RELAY_DENY_HOSTS.has(target.hostname.toLowerCase())) {
            console.warn(`[relay] 拒绝访问云元数据地址 ${target.host}（防本机凭据泄露）`);
            jsonResponse(response, 403, { ok: false, relayError: true, message: '该地址不允许通过中转访问' });
            return null;
        }
        // 局域网设备不能把本机当中转跳板去打本机的其它服务（SSRF）。
        // 本机自己发起的请求放行 —— Ollama 这类就住在 127.0.0.1。
        if (!isLocalRequest(request) && isLoopbackHostname(target.hostname)) {
            console.warn(`[relay] 拒绝非本机请求访问本机地址 ${target.host}（防 SSRF）`);
            jsonResponse(response, 403, { ok: false, relayError: true, message: '本机地址只能由本机发起中转' });
            return null;
        }
        // 只拦字面回环主机名还不够：攻击者可以让自己的域名解析到 127.0.0.1（DNS rebinding）、直接填局域网地址、或用 ::ffff:127.0.0.1 这类 IPv4-mapped 写法绕开前缀比较。
        // 先解析成 IP 再判一遍 —— 解析不出来就放行（真连不上时 fetch 自己会报错）。
        if (!isLocalRequest(request)) {
            let targetIps = [];
            try { targetIps = await dns.promises.lookup(target.hostname, { all: true }); } catch { /* DNS 失败交给 fetch 报错 */ }
            const dangerous = targetIps.some(({ address }) => isInternalAddress(address));
            if (dangerous) {
                console.warn(`[relay] 拒绝非本机请求访问内网地址 ${target.host} -> ${targetIps.map(i => i.address).join(',')}（防 SSRF）`);
                jsonResponse(response, 403, { ok: false, relayError: true, message: '本机与内网地址只能由本机发起中转' });
                return null;
            }
        }
        return target;
    }

    /** 过滤浏览器身份头与逐跳头，返回要转发给上游的请求头。 */
    function buildForwardHeaders(payload) {
        const headers = {};
        const rawHeaders = payload?.headers;
        if (rawHeaders && typeof rawHeaders === 'object') {
            for (const [k, v] of Object.entries(rawHeaders)) {
                const key = String(k);
                // Host / Content-Length 交给 undici 自己算；Cookie、Origin 之类浏览器身份信息不该外发。
                if (/^(host|content-length|cookie|origin|referer|connection|transfer-encoding)$/i.test(key)) continue;
                if (v === null || v === undefined) continue;
                headers[key] = String(v);
            }
        }
        // 不让上游压缩：一是 SSE 要能逐块透传，二是省得再解一遍。
        headers['accept-encoding'] = 'identity';
        return headers;
    }


    /** 「问了什么」：请求全文进追踪日志，主日志只留最后一问（一眼看出这次聊了什么） */
    function traceRelayRequest({ method, target, reqJson, reqRaw }) {
        const where = `${target.host}${target.pathname}`;
        const summary = summarizeChatRequest(reqJson);
        if (!summary || !summary.messages.length) return null;
        const lines = [`===== 请求 ${method} ${where} =====`];
        lines.push(`模型 ${summary.model || '(未指定)'} · ${summary.messages.length} 条消息 · ${Buffer.byteLength(String(reqRaw || ''))} 字节`);
        summary.messages.forEach((m, i) => {
            lines.push(`[${i + 1}/${summary.messages.length}] ${m.role}（${m.text.length} 字）\n`
                + clip(m.text, TRACE_MSG_MAX, '本条已截断'));
        });
        traceLine(lines.join('\n'));
        const lastUser = [...summary.messages].reverse().find((m) => m.role === 'user');
        if (lastUser && lastUser.text.trim()) {
            // 合成消息（桌宠"主动搭话"等 mod 注入的系统提示）不是人打的话：原样打印会把整段提示词+电脑状态快照灌进主日志，还长得像用户发了句怪话。
            // 识别特征：mod 们约定的开头「（系统提示：」；提示词全文仍完整保留在追踪日志（上面逐条已记）。
            if (/^（系统提示：/.test(lastUser.text.trim())) {
                console.log('[chat] 提问来自自动功能（mod 注入的系统提示，全文见追踪日志）');
            } else {
                console.log('[chat] 提问：' + clip(lastUser.text.replace(/\s+/g, ' ').trim(), 200, '已截断'));
            }
        }
        return summary;
    }

    /**
     * 一次中转的完整记录：主日志留一行（哪家、什么状态、多久、为什么失败），追踪日志留全文 —— 排查"偶发失败"时这是唯一能还原现场的东西。
     */
    function traceRelayExchange({ method, target, reqJson, reqRaw, status, ms, respJson, respRaw }) {
        const where = `${target.host}${target.pathname}`;
        const isChat = /\/chat\/completions|\/responses|\/messages/i.test(target.pathname);
        const summary = traceRelayRequest({ method, target, reqJson, reqRaw });
        const raw = String(respRaw || '');
        const tail = `${method} ${where} -> ${status} 上游 ${ms}ms`;

        // 请求体没能解析（超大 / 非 JSON）时至少留个大小，
        // 否则追踪日志里会出现"只有响应、没有请求"，反而更难读
        if (!summary && isChat) {
            traceLine(`===== 请求 ${method} ${where} =====\n（请求体未解析或为空，${Buffer.byteLength(String(reqRaw || ''))} 字节）`);
        }

        // ① 上游报错：完整报错进追踪日志，主日志那一行直接带上原因，不用再翻文件
        if (status >= 400) {
            traceLine(`===== 响应 ${status} · ${ms}ms（上游报错）=====\n`
                + clip(raw || '(空响应)', TRACE_BODY_MAX, '响应过大已截断'));
            const reason = extractErrorText(respJson, raw) || '(上游没有给出原因)';
            console.error(`[relay] ${tail} << 上游报错：` + clip(reason.replace(/\s+/g, ' '), 400, '已截断'));
            return;
        }

        // ② 回复正文：非流式直接读 JSON，流式把 data: 分片拼回去
        let reply = extractReplyText(respJson);
        if (!reply && raw) reply = parseSseReply(raw);
        if (reply) {
            traceLine(`===== 响应 ${status} · ${ms}ms =====\n` + clip(reply, TRACE_MSG_MAX, '回复已截断'));
            console.log(`[relay] ${tail}`);
            console.log('[chat] 回复：' + clip(reply.replace(/\s+/g, ' ').trim(), 200, '已截断'));
            return;
        }

        // ③ 状态码 200、却一个字都没抽出来 —— 流式接口把报错塞在 data: 行里就是这种形态
        const sseError = raw ? parseSseError(raw) : '';
        if (sseError) {
            traceLine(`===== 响应 ${status} · ${ms}ms（流式响应内报错）=====\n`
                + clip(raw, TRACE_BODY_MAX, '响应过大已截断'));
            console.error(`[relay] ${tail} << 响应内报错：` + clip(sseError.replace(/\s+/g, ' '), 400, '已截断'));
            return;
        }

        // ④ 非对话接口（获取模型等）成功时不再把响应体倒进追踪日志，否则模型列表会把对话内容淹掉
        if (raw && isChat) traceLine(`===== 响应 ${status} · ${ms}ms =====\n` + clip(raw, TRACE_BODY_MAX, '响应过大已截断'));
        console.log(`[relay] ${tail}`);
    }

    async function handleRelay(request, response) {
        let payload;
        try { payload = await readJsonBody(request, RELAY_BODY_LIMIT); }
        catch {
            // 校验失败必须留一条日志：静默拒绝的话，前端只拿到一句中文提示，
            // 日志里连"发生过这件事"都没有，用户报"对话发不出去"时无从查起。
            console.warn('[relay] 请求体无效或过大，已拒绝');
            return jsonResponse(response, 400, { ok: false, relayError: true, message: '中转请求体无效或过大' });
        }

        const target = await resolveRelayTarget(request, response, payload);
        if (!target) return;

        const method = String(payload?.method || 'GET').toUpperCase();
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            console.warn(`[relay] 不支持的请求方法 ${method}`);
            return jsonResponse(response, 400, { ok: false, relayError: true, message: '中转不支持的请求方法' });
        }

        const headers = buildForwardHeaders(payload);

        const timeoutMs = relayTimeoutMs(payload);
        const relayAbort = createRelayAbort(response, timeoutMs);
        const { controller, startedAt: relayStartedAt, armIdleTimer } = relayAbort;

        const { sendBody, bodyValue, reqRaw, reqJson } = readRelayBody(payload, method);
        const fetchOptions = buildRelayFetchOptions({ method, headers, bodyValue, sendBody, signal: controller.signal });
        let upstream;
        try {
            upstream = await fetch(target, fetchOptions);
        } catch (err) {
            // 有些网络只对 TLS 1.3 的 ClientHello 丢包（TCP 通、握手必卡），fetch 报 UND_ERR_CONNECT_TIMEOUT，看着像"连不上"。
            // 用限制到 TLS 1.2 的策略重试一次；只在握手类失败时重试 —— 业务错误（4xx/5xx）根本不抛，不会走到这里。
            const retry = (!controller.signal.aborted && isTlsHandshakeFailure(err))
                ? await retryWithTls12(target, fetchOptions, traceLine)
                : null;
            if (retry) {
                upstream = retry;
            } else {
                relayAbort.stop();
                if (relayAbort.abortedByClient) return;       // 客户端自己走了，不用回话
                const detail = formatRelayFailure(err, timeoutMs);
                // 连不上时把**请求内容**也写进追踪日志：否则只看到"连接被拒"，
                // 不知道当时问的是什么、模型名有没有写错 —— 而这恰恰是最常见的原因。
                traceRelayRequest({ method, target, reqJson, reqRaw });
                traceLine(`===== 请求失败 ${method} ${target.href} =====\n${detail}（${Date.now() - relayStartedAt}ms）`);
                console.error(`[relay] 请求失败 ${method} ${target.href} -> ${detail} (${Date.now() - relayStartedAt}ms)`);
                return jsonResponse(response, 502, { ok: false, relayError: true, message: `本地中转无法连接目标：${detail}` });
            }
        }

        writeUpstreamHeaders(upstream, response);
        // 头已到 → 空闲计时器重新起算，进入"等正文"阶段。
        armIdleTimer(timeoutMs);

        const respRaw = await forwardUpstreamBody(upstream, response, armIdleTimer, timeoutMs, () => relayAbort.abortedByClient);
        relayAbort.stop();
        response.end();

        if (relayAbort.abortedByClient) return;
        // 每个中转请求留一条完整记录：目标是哪家、什么状态、耗时多少、问了什么、答了什么 / 为什么失败。
        // 排查"偶发失败"时这是唯一能还原现场的东西。
        let respJson = null;
        if (respRaw) {
            try { respJson = JSON.parse(respRaw); } catch { respJson = null; }
        }
        traceRelayExchange({
            method, target, reqJson, reqRaw,
            status: upstream.status,
            ms: Date.now() - relayStartedAt,
            respJson, respRaw,
        });
    }

    return { handleRelay, traceRelayRequest, traceRelayExchange };
}
