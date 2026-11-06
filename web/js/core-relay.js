// 设备网络出口：原生插件 → 本机中转 → 裸 fetch 三级降级，统一返回 { ok, status, rawText, payload }。
'use strict';

// 探测结果缓存成 Promise（首个请求可能比探测先到）；失败不缓存，否则整个页面会话会永久退回裸 fetch 撞 CORS。
let localRelayProbe = null;
function detectLocalRelay() {
    if (localRelayProbe) return localRelayProbe;
    localRelayProbe = (async () => {
        // APK 与 file://（Origin 是 null，服务端按跨站请求拒掉）都算没有中转，别白试。
        if (IS_NATIVE_APP) return false;
        if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
        try {
            const response = await fetchWithTimeout('/api/server-info', { method: 'GET' }, 5000);
            if (!response.ok) return false;
            const info = await response.json();
            return Boolean(info && info.ok);
        } catch {
            return false;
        }
    })().then((ok) => {
        if (!ok) localRelayProbe = null;
        return ok;
    });
    return localRelayProbe;
}


// Web 版绕开 CORS 的唯一办法：同源的 /api/relay 不触发预检，由 Node 去请求服务商；中转站常不发 CORS 头（OPTIONS 甚至回 405），裸 fetch() 只会抛 "Failed to fetch"。
async function relayRequest(url, { method = 'POST', headers = {}, body, timeoutMs = 120000 } = {}) {
    const response = await fetchWithTimeout('/api/relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method, headers, body, timeoutMs })
    }, timeoutMs + 10000);
    const rawText = await response.text();
    let payload = null;
    if (rawText) {
        try { payload = JSON.parse(rawText); } catch {}
    }
    // relayError 表示"连目标都没连上"，要与上游返回的错误分开报 —— 否则用户会去怪服务商。
    if (payload && payload.relayError) {
        throw new ClientApiError('UPSTREAM_UNAVAILABLE', String(payload.message || '本地中转请求失败'));
    }
    // 判据只能是 payload.needLogin：服务商的 401（Key 无效）会原样透传，按状态码判会把 Key 错报成本机登录失效。
    if (payload?.needLogin === true) {
        throw new ClientApiError('LOCAL_SERVER_UNAUTHORIZED',
            String(payload?.message || '本机服务的登录状态已失效，需要重新输入访问密码'));
    }
    return { ok: response.ok, status: response.status, rawText, payload };
}

async function postJsonFromDevice(url, body, headers = {}, { timeoutMs = 120000, signal = null } = {}) {
    // signal 中止立刻抛 AbortError：原生层没有取消通道，界面停而 HTTP 在后台走完或超时。
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const abortPromise = signal
        ? new Promise((_, reject) => {
            if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
            else signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        })
        : null;
    const run = (async () => {
    const nativePlugin = getNativeByokHttpPlugin();
    if (nativePlugin?.post) {
        const result = await nativePlugin.post({
            url,
            headers,
            body: JSON.stringify(body),
            timeoutMs
        });
        const rawText = String(result?.body || '');
        let payload = null;
        if (rawText) {
            try { payload = JSON.parse(rawText); } catch {}
        }
        return { ok: Boolean(result?.ok), status: Number(result?.status || 0), rawText, payload };
    }

    if (await detectLocalRelay()) {
        return await relayRequest(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
            timeoutMs
        });
    }

    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
    }, timeoutMs);
    const rawText = await response.text();
    let payload = null;
    if (rawText) {
        try { payload = JSON.parse(rawText); } catch {}
    }
    return { ok: response.ok, status: response.status, rawText, payload };
    })();
    return abortPromise ? Promise.race([run, abortPromise]) : run;
}

// 流式请求对话接口：结果与非流式同构（多一个 onDelta），三种情况静默退回非流式 —— 原生层无流通道 / 上游不支持 stream / 中转站缓冲 SSE。
async function streamJsonFromDevice(url, body, headers = {}, options = {}) {
    const { format = 'openai-compatible', timeoutMs = 120000, signal = null, onDelta = null } = options;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (getNativeByokHttpPlugin()?.post) {
        return await postJsonFromDevice(url, body, headers, { timeoutMs, signal });
    }

    const streamBody = window.ChatStream.withStreamFlag(body, format, true);
    const useRelay = await detectLocalRelay();
    let response;
    if (useRelay) {
        response = await fetchWithTimeout('/api/relay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url, method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify(streamBody),
                timeoutMs
            })
        }, timeoutMs + 10000, signal);
    } else {
        response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(streamBody)
        }, timeoutMs, signal);
    }

    const contentType = String(response.headers.get('content-type') || '');
    // 不是 SSE 就按普通响应处理：上游错误体（400/401/429…）是普通 JSON，当流读会读不到 data 行、得到空回复。
    if (!response.ok || !/text\/event-stream/i.test(contentType)) {
        const rawText = await response.text();
        let payload = null;
        if (rawText) {
            try { payload = JSON.parse(rawText); } catch {}
        }
        if (payload && payload.relayError) {
            throw new ClientApiError('UPSTREAM_UNAVAILABLE', String(payload.message || '本地中转请求失败'));
        }
        if (payload?.needLogin === true) {
            throw new ClientApiError('LOCAL_SERVER_UNAUTHORIZED',
                String(payload?.message || '本机服务的登录状态已失效，需要重新输入访问密码'));
        }
        return { ok: response.ok, status: response.status, rawText, payload };
    }

    // 空闲超时贯穿读流阶段：fetchWithTimeout 拿到 headers 就结束计时，覆盖不到逐块读取的间隙。
    const { payload } = await window.ChatStream.consumeStream(response, format, onDelta, timeoutMs);
    return { ok: true, status: response.status, rawText: JSON.stringify(payload), payload };
}

// 对话请求统一出口：优先流式、失败退回非流式；判断收在一处，三种 provider 各判一次就会走样。options 含 { signal, onDelta }，stream: false 强制非流式。
async function requestChatJson(endpoint, body, headers, { format = 'openai-compatible', ...opts } = {}) {
    const wantStream = opts.stream !== false && typeof window.ChatStream !== 'undefined';
    if (!wantStream) {
        return await postJsonFromDevice(endpoint, body, headers, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    }

    // sawDelta 决定能否安全回退非流式：已吐出半个字再回退，会被"从头再来"的完整回复顶掉。
    let sawDelta = false;
    const wrappedOnDelta = typeof opts.onDelta === 'function'
        ? (chunk) => { sawDelta = true; opts.onDelta(chunk); }
        : null;

    try {
        return await streamJsonFromDevice(endpoint, body, headers, {
            format,
            timeoutMs: opts.timeoutMs,
            signal: opts.signal,
            onDelta: wrappedOnDelta,
        });
    } catch (error) {
        // 用户点「停止」不算失败：重试会让停止按钮立刻又发一次请求
        if (error?.name === 'AbortError') throw error;
        // 超时不回退非流式：回退是给"网关立刻拒绝流式"的补救，超时再等一遍只是让用户重历等待。
        if (error?.code === 'REQUEST_TIMEOUT') throw error;
        if (sawDelta) throw error;
        console.warn(`[Chat] ${format} 流式不可用，退回非流式：${error?.message || error}`);
        return await postJsonFromDevice(endpoint, body, headers, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    }
}

// GET JSON 必须走设备层：APK 里 WebView 的 fetch 撞 CORS，而服务商并不都发 CORS 头。
async function getJsonFromDevice(url, headers = {}, timeoutMs = 20000) {
    const nativePlugin = getNativeByokHttpPlugin();
    if (nativePlugin?.get) {
        const result = await nativePlugin.get({
            url,
            headers,
            asText: true,
            timeoutMs
        });
        const rawText = String(result?.body || '');
        let payload = null;
        if (rawText) {
            try { payload = JSON.parse(rawText); } catch {}
        }
        return { ok: Boolean(result?.ok), status: Number(result?.status || 0), rawText, payload };
    }
    if (await detectLocalRelay()) {
        return await relayRequest(url, { method: 'GET', headers: { ...headers }, timeoutMs });
    }
    const response = await fetchWithTimeout(url, { method: 'GET', headers: { ...headers } }, timeoutMs);
    const rawText = await response.text();
    let payload = null;
    if (rawText) {
        try { payload = JSON.parse(rawText); } catch {}
    }
    return { ok: response.ok, status: response.status, rawText, payload };
}

function base64ToArrayBuffer(base64) {
    const binary = atob(String(base64 || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
}

async function getBinaryFromDevice(url, timeoutMs = 120000) {
    const rawUrl = String(url || '').trim();
    const nativePlugin = getNativeByokHttpPlugin();
    const safeUrl = nativePlugin?.get ? rawUrl.replace(/^http:\/\//i, 'https://') : rawUrl;
    if (nativePlugin?.get) {
        const result = await nativePlugin.get({ url: safeUrl, timeoutMs });
        const rawBase64 = String(result?.body || '');
        if (!result?.ok) {
            throw new ClientApiError(
                inferApiErrorCode(Number(result?.status || 0), null, 'audio download failed'),
                '音频文件下载失败',
                { status: Number(result?.status || 0) }
            );
        }
        if (!rawBase64) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '音频文件下载结果为空');
        return {
            ok: true,
            status: Number(result?.status || 200),
            bytes: base64ToArrayBuffer(rawBase64),
            contentType: String(result?.contentType || '')
        };
    }
    const response = await fetchWithTimeout(safeUrl, { method: 'GET' }, timeoutMs);
    const bytes = await response.arrayBuffer();
    if (!response.ok) {
        throw new ClientApiError(
            inferApiErrorCode(response.status, null, 'audio download failed'),
            `音频文件下载失败（HTTP ${response.status}）`,
            { status: response.status }
        );
    }
    return {
        ok: true,
        status: response.status,
        bytes,
        contentType: response.headers.get('content-type') || ''
    };
}

// 从各种"OpenAI 兼容"实现里挖错误文案：OpenAI 在 error.message、DashScope 在 base_resp.status_msg、FastAPI 网关套 detail.error.message，漏掉最后一种就只剩兜底文案。
function extractProviderErrorMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const candidates = [
        payload.base_resp?.status_msg,
        payload.error?.message,
        payload.error,
        payload.message,
        payload.detail?.error?.message,
        payload.detail?.message,
        payload.detail,
        payload.msg
    ];
    for (const item of candidates) {
        if (typeof item === 'string' && item.trim()) return item.trim();
    }
    return '';
}

async function throwProviderResponseError(result, fallbackMessage) {
    const payload = result?.payload;
    const rawText = String(result?.rawText || '');
    let message = String(extractProviderErrorMessage(payload) || fallbackMessage).trim();
    // 429 = 上游限流（不是请求写错）：补一句可执行提示，但不加重试 —— 无退避的自动重试只会撞得更狠。
    if (Number(result?.status || 0) === 429 && !/稍后|重试|频率|限流/.test(message)) {
        message += '（上游限流：请等 1～2 分钟再试；若同一个 Key 同时在跑语音识别和语音输出，两者共享同一份调用配额）';
    }
    // 状态码 + 截断原文压成一条日志（message / rawText / payload 基本是同一件事，一起打会记三遍）。
    console.error(`[Provider] HTTP ${Number(result?.status || 0)}: ${message}`
        + (rawText && rawText !== message ? ' | raw: ' + rawText.slice(0, 300) : ''));
    const error = new ClientApiError(inferApiErrorCode(Number(result?.status || 0), payload, rawText), message, {
        status: Number(result?.status || 0)
    });
    // 标记"详情已记过"：外层 catch 看到它就不再 console.error 一遍，同一次失败只留一条。
    error.providerLogged = true;
    throw error;
}


