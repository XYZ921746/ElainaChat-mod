/* ============================================================================
 * 本机中转与设备网络出口（从 core.js 拆出）
 *
 * detectLocalRelay / relayRequest / postJsonFromDevice / streamJsonFromDevice /
 * requestChatJson / getJsonFromDevice / getBinaryFromDevice / 错误响应处理。
 * 依赖 core-chat 的 ClientApiError，以及 core.js 的 getNativeByokHttpPlugin（运行时才调用）。
 * ========================================================================== */
'use strict';

// ===== 本机中转 =====
// 页面由 web/serve.mjs 提供时，同源的 /api/server-info 必定存在。
// 探测结果缓存成 Promise 而不是布尔量：首个请求可能比探测先到，用 await 接住它。
let localRelayProbe = null;
function detectLocalRelay() {
    if (localRelayProbe) return localRelayProbe;
    localRelayProbe = (async () => {
        // APK 走原生插件，没有也不需要这个服务；
        // file:// 打开时 Origin 是 null，服务端会按跨站请求拒掉，别白试一次。
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
        // 只有探测成功才缓存。探测失败（服务正在保存大文件、瞬时卡顿、超时）
        // 若也缓存下来，整个页面会话就会永久退回裸 fetch —— 于是撞 CORS 报
        // "Failed to fetch"，表现正是"时好时坏、刷新一下又好了"。
        // 所以失败时把缓存清掉，下次请求重新探。
        if (!ok) localRelayProbe = null;
        return ok;
    });
    return localRelayProbe;
}


/**
 * 经本机 Node 进程转发一个请求。
 *
 * 这是 Web 版绕开 CORS 的唯一办法：浏览器 → 同源的 /api/relay 不触发预检，
 * 由 Node 去请求真正的服务商（Node 没有 CORS 这回事）。
 * 很多中转站根本不发 Access-Control-Allow-Origin，OPTIONS 甚至返回 405，
 * 这时裸 fetch() 只会抛 "Failed to fetch" —— 这正是"获取模型/对话连不上"的病根。
 */
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
    // relayError 表示"连目标都没连上"，要和上游自己返回的错误分开报 ——
    // 否则用户看到 502 会去怪服务商，而实际是 DNS/TLS/超时。
    if (payload && payload.relayError) {
        throw new ClientApiError('UPSTREAM_UNAVAILABLE', String(payload.message || '本地中转请求失败'));
    }
    // ⚠️ 判据只能是 payload.needLogin，**不能**是 response.status === 401：
    //   这条路径是"本机 → /api/relay → 服务商"，服务商的 401（Key 无效/没权限）
    //   会原样透传回来。以前用 status===401 判断，于是**服务商的 Key 错**被报成
    //   "本机服务需要重新登录"，用户去重启服务、刷新页面、重设密码，全都没用 ——
    //   因为问题根本在自己的 API Key 上（实测被这个误判误导过）。
    //   本机鉴权失败时服务端一定会带 needLogin:true（见 serve.mjs 的鉴权闸），
    //   所以这个判据既准确又不会漏。
    if (payload?.needLogin === true) {
        throw new ClientApiError('LOCAL_SERVER_UNAUTHORIZED',
            String(payload?.message || '本机服务的登录状态已失效，需要重新输入访问密码'));
    }
    return { ok: response.ok, status: response.status, rawText, payload };
}

async function postJsonFromDevice(url, body, headers = {}, { timeoutMs = 120000, signal = null } = {}) {
    // signal 被中止时立刻抛 AbortError，不再等底层 HTTP 完成。
    // 原生那条路（ByokHttpPlugin.post）没有取消通道，只能"假取消"——
    // 但对用户来说效果一样：界面立刻停，HTTP 在后台自己走完/超时。
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

    // Web：能走本机中转就走。裸 fetch 撞上不发 CORS 头的服务商时，
    // 抛出的 "Failed to fetch" 既没状态码也没原因，排查成本极高。
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

/**
 * 流式请求一个对话接口，边收边回调，返回**与非流式同构**的结果。
 *
 * 与非流式的唯一区别是多了一个 onDelta 回调，返回值形状完全一样
 * （{ ok, status, rawText, payload }）—— 这样 chat-providers.js 里那三个解析函数
 * 一个字都不用改，流式和非流式共用同一段解析代码。
 * 如果这里返回一个不同形状的结果，就会出现"流式能显示、非流式显示不了"
 * 这种只在某一条路上才发作的 bug，非常难查。
 *
 * 三种情况会**静默退回非流式**（功能优先于观感）：
 *   ① APK：原生 ByokHttpPlugin.post 一次性返回整个 body，根本没有流通道；
 *   ② 上游不支持 stream：会立刻返回 400/404，这里当作普通错误响应交回调用方；
 *   ③ 中转站把 SSE 缓冲了：content-type 不是 event-stream，按普通响应处理。
 *
 * @param {string} url 目标地址
 * @param {object} body 请求体（本函数负责加 stream: true）
 * @param {object} headers 请求头
 * @param {object} options { format, timeoutMs, signal, onDelta }
 */
async function streamJsonFromDevice(url, body, headers = {}, options = {}) {
    const { format = 'openai-compatible', timeoutMs = 120000, signal = null, onDelta = null } = options;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // ① 原生层没有流通道 → 直接走非流式，不尝试（试了也是白试，还会多一次请求）
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
    // ② / ③ 不是 SSE 就按普通响应处理：上游的错误体（400/401/429…）都是普通 JSON，
    // 当成流去读会读不到任何 data 行，最后得到一个空回复 —— 那才是最糟的结果。
    if (!response.ok || !/text\/event-stream/i.test(contentType)) {
        const rawText = await response.text();
        let payload = null;
        if (rawText) {
            try { payload = JSON.parse(rawText); } catch {}
        }
        // 和中转同一条错误归一化路径：relayError 表示"连目标都没连上"
        if (payload && payload.relayError) {
            throw new ClientApiError('UPSTREAM_UNAVAILABLE', String(payload.message || '本地中转请求失败'));
        }
        // 同 relayRequest：只认 needLogin，别把服务商的 401 当成"本机要重新登录"
        if (payload?.needLogin === true) {
            throw new ClientApiError('LOCAL_SERVER_UNAUTHORIZED',
                String(payload?.message || '本机服务的登录状态已失效，需要重新输入访问密码'));
        }
        return { ok: response.ok, status: response.status, rawText, payload };
    }

    // 空闲超时贯穿整个读流阶段：headers 到达只代表「连上了」，之后逐块读取
    // 的间隙同样可能卡死 —— fetchWithTimeout 的计时在拿到 headers 后就结束，
    // 覆盖不到这里。每收到一块数据计时器自动续期（见 readChunkWithIdleTimeout）。
    const { payload } = await window.ChatStream.consumeStream(response, format, onDelta, timeoutMs);
    return { ok: true, status: response.status, rawText: JSON.stringify(payload), payload };
}

/**
 * 对话请求的统一出口：**优先流式，失败退回非流式**。
 *
 * 为什么把"要不要流式"这个决定收在这里，而不是让三个 provider 各自判断：
 * 三个 provider 各判一次就有三处会走样，而这类差异的表现是"某个格式不流式"，
 * 属于用户很难描述、我们很难复现的那种问题。判据只有一处，就不会有分歧。
 *
 * @param {object} options 至少含 { signal, onDelta }；`stream: false` 可强制非流式；
 *   `format` 是该 provider 对应的协议（决定增量事件的解析方式）
 */
async function requestChatJson(endpoint, body, headers, { format = 'openai-compatible', ...opts } = {}) {
    const wantStream = opts.stream !== false && typeof window.ChatStream !== 'undefined';
    if (!wantStream) {
        return await postJsonFromDevice(endpoint, body, headers, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    }

    // 记一下"流式有没有真的吐出过内容"。这决定了失败时能不能安全回退：
    //   · 一个字都还没吐 → 回退非流式是安全的（用户什么都没看到）；
    //   · 已经吐了半句   → 不能回退，否则那半句会被"从头再来"的完整回复顶掉，
    //                      界面上表现为内容闪一下、重复一段。
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
        // 用户主动点「停止」不算失败，绝不能重试 —— 否则停止按钮会立刻又发一次请求
        if (error?.name === 'AbortError') throw error;
        // 超时不走「流式失败退回非流式」：那条路是为「网关不支持流式」准备的
        // （对方立刻拒绝，回退是补救）；超时意味着等了很久都没有数据，
        // 再退回非流式只会让用户把同一个等待原样再经历一遍 ——
        // 原样上抛交给上层的重试链路更诚实。
        if (error?.code === 'REQUEST_TIMEOUT') throw error;
        // 已经吐出过内容就不回退，把错误原样抛给上层（半截回复留在界面上）
        if (sawDelta) throw error;
        console.warn(`[Chat] ${format} 流式不可用，退回非流式：${error?.message || error}`);
        return await postJsonFromDevice(endpoint, body, headers, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    }
}

/**
 * GET 一个 JSON 接口。和 postJsonFromDevice 一样必须走设备层：
 * APK 里 WebView 的 fetch 会撞 CORS，而服务商并不都发 CORS 头。
 * 「获取模型」之前就是因为直接用了裸 fetch()，在 APK 上永远失败。
 */
async function getJsonFromDevice(url, headers = {}, timeoutMs = 20000) {
    const nativePlugin = getNativeByokHttpPlugin();
    if (nativePlugin?.get) {
        const result = await nativePlugin.get({
            url,
            headers,
            // 让原生按文本返回。默认是 base64（那是给音频用的），拿回来还得再解一遍
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
    // Web：同上，优先走本机中转。
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

/**
 * 从各种"OpenAI 兼容"实现里把真正的错误文案挖出来。
 * 各家包法都不一样：标准 OpenAI 是 error.message，DashScope 是 base_resp.status_msg，
 * 而 FastAPI 系网关（自建中转站大量使用）会套一层 detail.error.message。
 * 漏掉最后这种时，用户只能看到兜底的"请求失败"，
 * 而真实原因是"模型名不在这个服务上"—— 完全无从下手。
 */
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
    // 429 = 上游限流（不是请求写错）。服务商通常只回一句 "Too many requests"，
    //   用户看到它无从下手，这里补一句可执行的提示。不改重试逻辑 —— 无退避的自动
    //   重试只会把 429 撞得更狠。
    if (Number(result?.status || 0) === 429 && !/稍后|重试|频率|限流/.test(message)) {
        message += '（上游限流：请等 1～2 分钟再试；若同一个 Key 同时在跑语音识别和语音输出，两者共享同一份调用配额）';
    }
    // 完整错误日志：状态码 + 服务商返回原文，方便排查"测试能通、实际报错"。
    // 压成一行、不重复：message / rawText / payload 三份内容基本是同一件事，
    //   一起打出去会让一条错误在日志里出现三遍，排查时反而更难扫。
    //   这里只留：状态码 + 挖出来的 message + 截断的原文。
    console.error(`[Provider] HTTP ${Number(result?.status || 0)}: ${message}`
        + (rawText && rawText !== message ? ' | raw: ' + rawText.slice(0, 300) : ''));
    const error = new ClientApiError(inferApiErrorCode(Number(result?.status || 0), payload, rawText), message, {
        status: Number(result?.status || 0)
    });
    // 标记"详情已记过"：外层 catch（如 handleUserInput）看到这个标记就不再
    // console.error 一遍 —— 之前同一次失败会在 [Page] 里出现两条 ERRO。
    error.providerLogged = true;
    throw error;
}


