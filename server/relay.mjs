// 本地中转 /api/relay —— **电脑端与手机端共用**的这一份实现。
//
// ★★ 2026-10 从 web/serve.mjs 抽成模块（手机端补后端的第一段）。
//
//   为什么抽：这台"中转"是把请求搬到 Node 侧发出（Node 没有 CORS 这回事），
//   而两端**都需要它** —— 电脑版是 BYOK 直连被 CORS 挡住时的唯一出路，
//   手机版更彻底：WebView 页面在 https://localhost，而内嵌服务在
//   http://127.0.0.1:<随机端口>，本来就跨源。复制两份实现意味着"同一个 Key、
//   同一个地址，在电脑上能通、在手机上通不了"这类问题要查两遍。
//
//   依赖注入而不是 import 宿主：唯一真正需要注入的是 `traceLine`
//   （电脑版把追踪日志写进 data/logs/<启动时刻>.trace.log，手机端另有落法），
//   以及三个**安全判定**（是否本机请求 / 是否回环主机名 / 是否内网地址）。
//   后三个电脑端定义在 serve.mjs 里（局域网里还有别的设备能打到它），
//   手机端只绑 127.0.0.1、由内嵌入口自己给出等价实现 —— 见 createRelay 的说明。
//
// 为什么需要它（原文保留）：BYOK 的"直连"是让浏览器自己去请求服务商，而浏览器会强制 CORS。
// 大量中转站（自建 OneAPI、厂商内测网关、Ollama 之类）根本不发 Access-Control-Allow-Origin，
// 预检 OPTIONS 甚至直接 405 —— 这时 fetch() 只会抛一句 "Failed to fetch"，
// 看不出任何原因。而 ChatBox / Cherry Studio 这些原生客户端不受 CORS 约束，
// 于是同一个 Key、同一个地址在它们那儿正常，在网页里就是连不上。
// Key 只经过本机进程内存，不落盘、不发给任何第三方 —— 与 BYOK 一致。

import dns from 'node:dns';
import { jsonResponse, readJsonBody } from './http-util.mjs';

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

// ===== 对话追踪 =====
//
// 为什么埋在中转这一层：`/api/relay` 是**所有对外 AI 请求的唯一出口**（三种对话格式、
// 获取模型、语音、视觉全走它），在这一层埋点就能覆盖全部，前端一行都不用改。
//
// 主日志只留一行摘要（提问 / 回复各截一段），完整内容进追踪日志。
// 旧日志只有「谁在什么时候调了哪个接口」—— 出问题时根本还原不出当时问了什么、答了什么、
// 上游到底为什么拒，这正是这次要补上的。

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
 * 流式响应里的报错，状态码常常是 200 —— 错在 `data:` 行里。
 * 这类"看起来成功、其实一个字都没回"的情况不特意挖一下，用户只会看到"AI 不回话"，
 * 而日志里一片祥和，完全无从下手。
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
 * 造一个中继处理器。
 *
 * @param {object} deps
 * @param {(text: string) => void} deps.traceLine
 *        写追踪日志。电脑版写进 `<启动时刻>.trace.log`；手机端写进内嵌服务的日志。
 *        不传则退化为只写主日志（会丢掉"问过什么/答了什么"的全文，不推荐）。
 * @param {(request) => boolean} deps.isLocalRequest
 *        这次请求是不是本机发起的。**决定 SSRF 那两道校验是否生效**，必须显式给。
 * @param {(hostname: string) => boolean} deps.isLoopbackHostname
 * @param {(address: string) => boolean} deps.isInternalAddress
 *
 * ★ 后三个刻意**不设默认值**：漏传等于把"非本机请求"一律当成"本机请求"放行，
 *   那不是"少一层可选优化"，而是把 SSRF 防护静默关掉。宁可在构造时就报出来。
 *   手机端只绑回环、这三条分支走不到，也要**显式**写出等价实现（见
 *   web/nodejs/bootstrap.mjs）—— 显式写出来，将来谁改了监听地址就会立刻看见问题。
 */
export function createRelay(deps) {
    const { traceLine = () => { }, isLocalRequest, isLoopbackHostname, isInternalAddress } = deps || {};
    for (const [name, fn] of [['isLocalRequest', isLocalRequest], ['isLoopbackHostname', isLoopbackHostname], ['isInternalAddress', isInternalAddress]]) {
        if (typeof fn !== 'function') throw new Error(`createRelay 缺少依赖 ${name}（它决定 SSRF 防护，不能省）`);
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
            // ★ 合成消息（桌宠"主动搭话"等 mod 注入的系统提示）不是人打的话 ——
            //   原样打印会把整段提示词+电脑状态快照灌进主日志，还长得像用户发了
            //   一句怪话（用户实测困惑："这个日志是你干的吗"）。
            //   识别特征：mod 们约定的开头「（系统提示：」。此时只记一行来源事实，
            //   提示词全文仍完整保留在追踪日志（上面逐条已记）。
            if (/^（系统提示：/.test(lastUser.text.trim())) {
                console.log('[chat] 提问来自自动功能（mod 注入的系统提示，全文见追踪日志）');
            } else {
                console.log('[chat] 提问：' + clip(lastUser.text.replace(/\s+/g, ' ').trim(), 200, '已截断'));
            }
        }
        return summary;
    }

    /**
     * 一次中转的完整记录：请求 + 响应。
     *
     * 主日志留一行（谁、哪家、什么状态、多久、为什么失败），追踪日志留全文。
     * 这是这次日志改造的核心 —— 旧日志只有「什么地址在什么时间调用了什么 API」，
     * 出问题时还原不出当时问了什么、答了什么、上游到底为什么拒。
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
            // 这些校验失败以前是完全静默的 —— 前端只会拿到一句中文提示，
            // 日志里连"发生过这件事"都没有，用户报"对话发不出去"时无从查起。
            console.warn('[relay] 请求体无效或过大，已拒绝');
            return jsonResponse(response, 400, { ok: false, relayError: true, message: '中转请求体无效或过大' });
        }

        let target;
        try { target = new URL(String(payload?.url || '')); }
        catch {
            console.warn('[relay] 目标地址无效：' + String(payload?.url || '(空)').slice(0, 200));
            return jsonResponse(response, 400, { ok: false, relayError: true, message: '中转目标地址无效' });
        }

        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            console.warn(`[relay] 不支持的协议 ${target.protocol}//${target.host}，只允许 http/https`);
            return jsonResponse(response, 400, { ok: false, relayError: true, message: '中转只支持 http/https' });
        }
        if (RELAY_DENY_HOSTS.has(target.hostname.toLowerCase())) {
            console.warn(`[relay] 拒绝访问云元数据地址 ${target.host}（防本机凭据泄露）`);
            return jsonResponse(response, 403, { ok: false, relayError: true, message: '该地址不允许通过中转访问' });
        }
        // 局域网设备不能把本机当中转跳板去打本机的其它服务（SSRF）。
        // 本机自己发起的请求放行 —— Ollama 这类就住在 127.0.0.1。
        if (!isLocalRequest(request) && isLoopbackHostname(target.hostname)) {
            console.warn(`[relay] 拒绝非本机请求访问本机地址 ${target.host}（防 SSRF）`);
            return jsonResponse(response, 403, { ok: false, relayError: true, message: '本机地址只能由本机发起中转' });
        }
        // 只拦字面回环主机名还不够：攻击者可以让自己的域名解析到 127.0.0.1（DNS rebinding），
        // 或直接填局域网地址、或用 ::ffff:127.0.0.1 这类 IPv4-mapped IPv6 写法绕开前缀比较。
        // 先解析成 IP 再判一遍 —— 解析不出来就放行（真连不上时 fetch 自己会报错）。
        if (!isLocalRequest(request)) {
            let targetIps = [];
            try { targetIps = await dns.promises.lookup(target.hostname, { all: true }); } catch { /* DNS 失败交给 fetch 报错 */ }
            const dangerous = targetIps.some(({ address }) => isInternalAddress(address));
            if (dangerous) {
                console.warn(`[relay] 拒绝非本机请求访问内网地址 ${target.host} -> ${targetIps.map(i => i.address).join(',')}（防 SSRF）`);
                return jsonResponse(response, 403, { ok: false, relayError: true, message: '本机与内网地址只能由本机发起中转' });
            }
        }

        const method = String(payload?.method || 'GET').toUpperCase();
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            console.warn(`[relay] 不支持的请求方法 ${method}`);
            return jsonResponse(response, 400, { ok: false, relayError: true, message: '中转不支持的请求方法' });
        }

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

        const timeoutMs = Math.min(Math.max(Number(payload?.timeoutMs) || 120000, 1000), RELAY_TIMEOUT_MAX);
        const controller = new AbortController();
        // ★★ 2026-10 修「流式被自己的超时腰斩」：这里的超时必须是**空闲**超时，
        //   不是从发起到结束的**总时长**。
        //
        //   旧实现是 `const timer = setTimeout(() => controller.abort(), timeoutMs)`
        //   一直挂到整条响应体转发完才 clearTimeout —— 于是语义变成"这次请求总共
        //   只能花 timeoutMs"，而这对流式**是错的**：
        //     · 长回复（几千字）正常说完就要好几分钟；
        //     · 高思考强度模型（thinkingEffort=high）首字节本身就常超过 120 秒。
        //   实测现场（data/logs/2026-10-13_20-23-53.trace.log）：
        //     `请求失败 POST …/messages — 超过 120 秒没有响应（120020ms）`
        //     → 前端 `[Chat] anthropic 流式不可用，退回非流式`
        //   用户看到的就是"AI 不能正常流式输出"：要么干等、要么整段蹦出来。
        //
        //   改成每收到一块数据就**续期**：只要上游还在吐数据就永不超时（流式长回复
        //   因此可以正常走完），只有真正卡死（连接在、但一个字节都不来）才按
        //   timeoutMs 砍。语义从"总共多久"变成"多久没动静"—— 这才是流式该有的超时。
        //
        //   ⚠️ 空闲续期必须配一条**总时长**硬顶，否则"上游一直发心跳、但永远不说正文"
        //     就能把这条连接永远占住（转发是逐块透传，没有上限就等于免费长连接）。
        //     硬顶取 RELAY_TIMEOUT_MAX（10 分钟）：正常对话（哪怕边想边说几分钟）
        //     都在其内，占用也被封住。
        const relayStartedAt = Date.now();
        const hardDeadline = relayStartedAt + RELAY_TIMEOUT_MAX;
        let timer = null;
        const armIdleTimer = (ms) => {
            if (timer) clearTimeout(timer);
            const remaining = hardDeadline - Date.now();
            if (remaining <= 0) { controller.abort(); return; }
            timer = setTimeout(() => controller.abort(), Math.min(ms, remaining));
        };
        armIdleTimer(timeoutMs);   // 第一段：等响应头（TTFB）
        let abortedByClient = false;
        response.on('close', () => {
            if (!response.writableEnded) { abortedByClient = true; controller.abort(); }
        });

        const sendBody = !(method === 'GET' || method === 'HEAD');
        const bodyValue = typeof payload?.body === 'string'
            ? payload.body
            : (payload?.body === undefined || payload?.body === null ? undefined : JSON.stringify(payload.body));
        const reqRaw = typeof bodyValue === 'string' ? bodyValue : '';
        // 解析请求体**只为了记日志**。超大请求（图片 / 语音 base64）跳过：JSON.parse 一个几十 MB 的
        // 对象要几百毫秒，为了日志给每次对话平白加延迟不划算 —— 那种情况只记大小。
        let reqJson = null;
        if (reqRaw && Buffer.byteLength(reqRaw) <= RELAY_TRACE_PARSE_MAX) {
            try { reqJson = JSON.parse(reqRaw); } catch { reqJson = null; }
        }

        let upstream;
        try {
            upstream = await fetch(target, {
                method,
                headers,
                body: sendBody ? bodyValue : undefined,
                signal: controller.signal,
                // 不跟随上游重定向：302 Location 是攻击者可控的，跟随它可以把"对公网 API 的请求"
                // 重定向到本机/内网地址，绕过上面的 SSRF 校验。3xx 原样透传给前端自己处理。
                redirect: 'manual',
            });
        } catch (err) {
            clearTimeout(timer);
            if (abortedByClient) return;                       // 客户端自己走了，不用回话
            const cause = err?.cause;
            // 这一句比浏览器那句 "Failed to fetch" 有用得多：能看出是 DNS、TLS 还是连接被拒。
            // 带上 cause.code（ENOTFOUND / ECONNREFUSED / UND_ERR_CONNECT_TIMEOUT …），方便直接 grep。
            const detail = err?.name === 'AbortError'
                ? `超过 ${Math.round(timeoutMs / 1000)} 秒没有响应`
                : String(cause?.message || err?.message || err) + (cause?.code ? ` [${cause.code}]` : '');
            // 连不上时把**请求内容**也写进追踪日志：否则只看到"连接被拒"，
            // 不知道当时问的是什么、模型名有没有写错 —— 而这恰恰是最常见的原因。
            traceRelayRequest({ method, target, reqJson, reqRaw });
            traceLine(`===== 请求失败 ${method} ${target.href} =====\n${detail}（${Date.now() - relayStartedAt}ms）`);
            console.error(`[relay] 请求失败 ${method} ${target.href} -> ${detail} (${Date.now() - relayStartedAt}ms)`);
            return jsonResponse(response, 502, { ok: false, relayError: true, message: `本地中转无法连接目标：${detail}` });
        }

        response.writeHead(upstream.status, {
            'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            // ★ SSE 必须**关掉缓冲**：否则中间层（Node 自己的 socket、以及某些
            //   反向代理）会攒够一块才发，增量就变成了"一批一批蹦"。identity 编码
            //   已在上面设过，这里再补一条代理侧的显式指令。
            ...(/text\/event-stream/i.test(upstream.headers.get('content-type') || '')
                ? { 'X-Accel-Buffering': 'no' } : {}),
        });
        // ★★ 立刻把头送出去。浏览器的 fetch() 是**收到响应头就 resolve**，之后才开始
        //    读 body；不 flush 的话头可能和第一块数据一起才发出，前端"开始流式"的时间
        //    就整体后移 —— 表现上就是"点发送后要愣一愣才开始出字"。
        if (typeof response.flushHeaders === 'function') {
            try { response.flushHeaders(); } catch { /* 已经发过头了 */ }
        }
        // 头已到 → 空闲计时器重新起算，进入"等正文"阶段（见上面 armIdleTimer 的说明）。
        armIdleTimer(timeoutMs);

        // 边透传边攒一份给日志用。攒到上限就停止记录（**继续透传**），
        // 免得一个长回答把内存吃掉；流式的正文稍后由 parseSseReply 从 data: 行拼回来。
        const traceChunks = [];
        let traceBytes = 0;
        if (upstream.body) {
            try {
                for await (const chunk of upstream.body) {
                    if (abortedByClient) break;
                    // ★ 每收到一块就续期：只要上游还在吐数据，长回复就永远不会被
                    //   自己的超时砍断；只有"连接还在但一个字节都不来"才会被 abort。
                    armIdleTimer(timeoutMs);
                    response.write(chunk);
                    if (traceBytes < TRACE_ACCUM_MAX) {
                        traceChunks.push(chunk);
                        traceBytes += chunk.length;
                    }
                }
            } catch (err) {
                if (!abortedByClient) console.error('[relay] 透传响应中断:', String(err?.message || err));
            }
        }
        clearTimeout(timer);
        response.end();

        if (abortedByClient) return;
        // 每个中转请求留一条完整记录：目标是哪家、什么状态、耗时多少、问了什么、答了什么 / 为什么失败。
        // 排查"偶发失败"时这是唯一能还原现场的东西 —— 旧日志只有一行状态码，看不出原因。
        const respRaw = traceChunks.length ? Buffer.concat(traceChunks).toString('utf8') : '';
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
