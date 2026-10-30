/* ============================================================================
 * 对话 API：错误归一化、端点判定、思考参数（从 core.js 拆出）
 *
 * ClientApiError / 错误文案 / getChatBaseUrl / isDeepSeekOfficial / 思考四档与
 * buildThinkingParams。纯函数与常量，无 DOM / 网络副作用。
 * ========================================================================== */
'use strict';

class ClientApiError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = 'ClientApiError';
        this.code = code || 'UNKNOWN_ERROR';
        this.status = Number(options.status || 0);
        this.retryable = Boolean(options.retryable);
        // 本次请求是否真的带了图片。只用来决定报错时要不要提"图片转述"——
        // 只在真的带过图时才提图片原因 —— 无条件提会误导没发图的用户。
        this.imageHint = Boolean(options.imageHint);
    }
}

function getApiErrorText(payload, rawText = '') {
    return [
        payload?.message,
        typeof payload?.error === 'string' ? payload.error : payload?.error?.message,
        payload?.error?.code,
        payload?.code,
        payload?.base_resp?.status_msg,
        payload?.base_resp?.status_code,
        // FastAPI 系网关把错误套在 detail 里（自建中转站大量如此）
        typeof payload?.detail === 'string' ? payload.detail : payload?.detail?.error?.message,
        payload?.detail?.error?.code,
        rawText
    ].filter(Boolean).join(' ');
}

function inferApiErrorCode(status, payload, rawText = '') {
    const explicitCode = String(payload?.code || '').trim();
    if (explicitCode) return explicitCode;
    const providerStatus = Number(payload?.base_resp?.status_code || 0);
    const text = getApiErrorText(payload, rawText).toLowerCase();
    // 「模型名不在这个服务上」是自建中转 / 新服务商最高频的问题。
    // 不单独给码的话它会落进 UNKNOWN_ERROR，用户只看到"请求失败"，完全无从下手。
    if (/model_not_found|model.{0,24}not.{0,12}(available|exist|found)|no such model|invalid model/.test(text)) return 'MODEL_NOT_FOUND';
    if (status === 401 || providerStatus === 1004 || /invalid.?api.?key|api.?key.?invalid|key.{0,8}(invalid|expired)|unauthori[sz]ed|authentication/.test(text)) return 'APP_KEY_INVALID';
    if (status === 402 || providerStatus === 1008 || /token[ _-]?plan|quota|insufficient|balance|credit|billing|payment|limit.?exceed|resource.?exhaust/.test(text)) return 'MINIMAX_QUOTA_EXHAUSTED';
    if (status === 429 || providerStatus === 1002 || /rate.?limit|too many requests|请求过于频繁/.test(text)) return 'RATE_LIMITED';
    if (status >= 500) return 'UPSTREAM_UNAVAILABLE';
    if (status === 400) return 'BAD_REQUEST';
    return 'REQUEST_FAILED';
}

function toClientApiError(error) {
    if (error instanceof ClientApiError) return error;
    const message = String(error?.message || error || '').trim();
    const lower = message.toLowerCase();
    if (error?.name === 'AbortError' || /timeout|timed out|请求超时/.test(lower)) {
        return new ClientApiError('REQUEST_TIMEOUT', message, { retryable: true });
    }
    if (error instanceof TypeError || /failed to fetch|networkerror|network request failed/.test(lower)) {
        return new ClientApiError('NETWORK_ERROR', message, { retryable: true });
    }
    if (/请先.*key|未.*key|key.*为空/.test(lower)) return new ClientApiError('APP_KEY_MISSING', message);
    const inferred = inferApiErrorCode(Number(error?.status || 0), null, message);
    return new ClientApiError(inferred === 'REQUEST_FAILED' ? 'UNKNOWN_ERROR' : inferred, message, { status: error?.status });
}

function getClientErrorPresentation(error) {
    const apiError = toClientApiError(error);
    switch (apiError.code) {
        case 'APP_KEY_MISSING':
            return { title: '需要填写 Key', message: apiError.message || '请先在设置中填写对应服务商的 API Key。' };
        case 'APP_KEY_INVALID':
            return { title: 'Key 无效', message: '当前 Key 错误或已失效，请在设置中更换新的 Key。' };
        case 'MINIMAX_QUOTA_EXHAUSTED':
            return { title: '服务额度已耗尽', message: '当前服务商账号余额或额度不足，请登录服务商控制台检查。' };
        case 'RATE_LIMITED':
        case 'UPSTREAM_RATE_LIMITED':
            return { title: '请求过于频繁', message: '请求过于频繁，请稍后再试。' };
        case 'NETWORK_ERROR':
            return {
                title: '网络连接失败',
                message: '请求没能发出去。Web 版最常见的原因是服务商没有返回 CORS 响应头 —— '
                    + '浏览器会直接丢掉响应，报错就是一句 "Failed to fetch"，看不出真实原因。'
                    + '\n\n· 用 启动.bat 启动、再从它打出的地址打开（默认 http://127.0.0.1:3999）：会自动走本机中转，可绕开这个限制；'
                    + '\n· 直接双击 index.html 打开时不走中转；'
                    + '\n· 也请确认地址没写错、电脑能上网。'
            };
        case 'LOCAL_SERVER_UNAUTHORIZED':
            return {
                title: '本机服务需要重新登录',
                message: '本机服务的登录状态已失效（服务重启后会话会清空，不一定是真的过期）。'
                    + '\n\n点确定会跳到登录页，重新输入访问密码即可。'
                    + '\n\n本机（127.0.0.1）访问通常是免密的；如果你确实是在本机操作却看到这条，'
                    + '说明这个 401 来自别处 —— 请把完整报错发出来。'
            };
        case 'MODEL_NOT_FOUND': {
            const detail = String(apiError.message || '').trim();
            return {
                title: '模型名不可用',
                message: '地址和 Key 都是通的，但这个服务商没有你要的模型。'
                    + (detail ? '\n\n接口返回：' + detail.slice(0, 200) : '')
                    + '\n\n点「获取模型」从列表里挑一个，或按服务商文档填写正确的模型名。'
            };
        }
        case 'REQUEST_TIMEOUT':
            return {
                title: '模型响应超时',
                message: (apiError.message ? apiError.message + '\n\n' : '')
                    + '等待太久没有收到模型数据，连接已自动断开。常见原因与对策：'
                    + '\n· 网络不稳或服务商繁忙：稍等片刻再发一次通常就好；'
                    + '\n· 开了思考的模型（尤其高强度）首字可能要等一两分钟，连续超时可先关思考或换更快的模型；'
                    + '\n· 换一个服务商地址（中转站拥堵时最容易这样）。'
            };
        case 'BAD_REQUEST': {
            const detail = String(apiError.message || '').trim();
            // 只有"本次真的带了图片"或"服务商的话本身就在说图片"，才提图片原因。
            // 无条件拼上去的话**任何** 400 都会甩一句"图片转述常见原因：…"。
            // 真实案例：服务商返回
            // "System message must be at the beginning."（其实是"system 消息只能有一条"），
            // 用户看到图片那行就来问"我没发图片为什么会这样"—— 提示把人带偏了。
            const imageRelated = apiError.imageHint === true || /image|vision|multimodal|多模态|图片/i.test(detail);
            // 中转站（new-api 系）会按**模型名的后缀**替我们决定要不要开 Claude 的扩展思考：
            // 名字里带 `-thinking` 就会开，而扩展思考的预算要求 max_tokens 更大。
            // 用户根本不知道模型名里那个后缀是什么意思，看到 "manual Claude thinking" 只会更迷惑
            // （他压根没开过思考）—— 所以这条提示必须直接说清"后缀是干什么的、不想要就删掉"。
            const thinkingBudgetIssue = /max_tokens/i.test(detail) && /thinking/i.test(detail);
            let hint;
            if (thinkingBudgetIssue) {
                hint = '\n\n这条报错来自模型名里的 -thinking 后缀：中转站看到它就会开启 Claude 的扩展思考，'
                    + '而扩展思考的预算要求 max_tokens 更大（应用已自动抬高到安全值，若仍报错说明该中转站限制更严）。'
                    + '\n· 不想要思考：把模型名里的 -thinking 去掉，例如 claude-sonnet-4-5-thinking → claude-sonnet-4-5；'
                    + '\n· 想要思考：可以用 -thinking-<数字> 指定预算，但数字越大越慢、也越贵。';
            } else if (imageRelated) {
                hint = '\n\n图片转述常见原因：视觉模型名不对、图片过大、或该模型不支持图片。请检查 设置 → 模型 → 视觉模型 的模型名，或换用 Qwen-VL 等支持图片的模型。';
            } else {
                hint = '\n\n常见原因：服务商对请求格式有额外要求（例如只接受一条 system 消息）、模型名与接口不匹配、'
                    + '或该模型不支持当前参数。上面「服务商返回」那行通常已经写明了真正的原因。';
            }
            return {
                title: '请求内容有误',
                message: '本次请求内容有误（HTTP 400）。'
                    + (detail ? '\n\n服务商返回：' + detail.slice(0, 200) : '')
                    + hint
            };
        }
        case 'EMPTY_MODEL_OUTPUT':
            return { title: '模型未生成回复', message: apiError.message || '模型返回了空内容或仅返回思考内容，请重试。' };
        case 'SERVER_MISCONFIGURED':
        case 'UPSTREAM_KEY_INVALID':
        case 'UPSTREAM_UNAVAILABLE': {
            const detail = String(apiError.message || '').trim();
            return {
                title: '服务暂时不可用',
                message: '服务商接口暂时不可用，请检查 Base URL、模型名和账号状态。'
                    + (detail ? '\n\n接口返回：' + detail.slice(0, 200) : '')
            };
        }
        default:
            return { title: '请求失败', message: apiError.message || '请求服务商失败，请检查设置后重试。' };
    }
}

function showClientApiError(error) {
    const presentation = getClientErrorPresentation(error);
    // 本机登录态失效：文案说"点确定会跳登录页"，那就必须真的跳 ——
    //   否则用户按提示刷新还是会撞同一个 401，找不到入口。
    //   其它错误维持"只提示、不跳转"（绝大多数是配置问题，跳走反而丢失上下文）。
    if (error && error.code === 'LOCAL_SERVER_UNAUTHORIZED') {
        showCustomAlert(presentation.message, presentation.title).then(() => {
            try { location.href = '/login'; } catch { /* 忽略 */ }
        });
        return;
    }
    showCustomAlert(presentation.message, presentation.title);
}

function getChatBaseUrl(settings = state.settings) {
    const raw = String(settings.baseUrl || '').trim().replace(/\/$/, '');
    if (!raw) throw new Error('请先在设置中填写 API Base URL');
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error('API Base URL 格式不正确'); }
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('API Base URL 必须使用 HTTP 或 HTTPS');
    return raw;
}

/**
 * 是不是 DeepSeek 官方端点。
 * 判据是**地址**而不是某个开关：地址填 DeepSeek 官方域名（含其兼容网关）时成立，
 * 填别家中转时不成立 —— 开关形式做不到这一点。
 */
function isDeepSeekOfficial(baseUrl) {
    try {
        return /(^|\.)deepseek\.com$/i.test(new URL(String(baseUrl || '')).hostname);
    } catch { return false; }
}


// ===== 思考模式（各家参数差异很大，全部收在这里） =====
// 早先只能靠「换模型名」（deepseek-chat → deepseek-reasoner），因为当时没有独立的思考开关字段；
//   后来接口改成了显式参数，且**思考默认开启** —— 用户关掉开关时必须**显式**发 disabled，
//   否则模型照样思考（还在等、还在扣思考 token，界面上什么都看不到）。
// 所以三件事都做：发新参数（对支持的服务商生效）+ 保留换名（对只认模型名的老中转站生效）。

/**
 * 思考强度档位（对外只有这四个，映射到各家自己的取值）：
 *   off  → 不思考，直接回答（**默认**；请求里显式发 disabled）
 *   low  → 快速思考
 *   high → 均衡
 *   max  → 深度思考，最慢但最准（也更贵）
 *
 * 对外只给四档而不是把各家取值原样暴露：用户要表达的是「想多深」，不是发 reasoning_effort 还是
 *   output_config.effort；各家合法取值也不一致（DeepSeek 认 low/high/max，OpenAI 没有 max）。
 * off 就等于关思考，所以不需要再单独一个「让模型先思考」的开关（两个开关会互相矛盾）。
 */
const THINKING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);

/**
 * 把一个"思考强度"档位映射成某个服务商能接受的取值。
 *
 * @param {string} effort 内部档位：off / low / high / max
 * @param {string} vendor 'deepseek' | 'anthropic' | 'openai' | 'generic'
 * @returns {string|null} null = 不发这个字段（off 或该服务商不认这一档）
 */
function mapThinkingEffort(effort, vendor) {
    const level = String(effort || '').trim().toLowerCase();
    // off（以及任何非法值/已废弃的老档位 medium）→ 不发强度字段；
    // "关掉思考"由调用方用 enabled 表达（见 buildThinkingParams）。
    if (level === 'off' || !THINKING_EFFORTS.includes(level)) return null;
    // OpenAI 的 reasoning_effort 只有 minimal/low/medium/high，没有 max ——
    // 「极高」在它那边降到 high。
    if (vendor === 'openai' && level === 'max') return 'high';
    // deepseek（官方取值就是 low/high/max）、anthropic（reasoning.effort: none/low/high/max）、
    // generic（交给服务商自己判）都原样透传。
    return level;
}

/**
 * 判断一个端点/模型该按哪家的思考参数来发。
 *
 * 判据是"地址优先、模型名兜底"：
 *   · 地址能认出来（DeepSeek 官方 / Anthropic 官方 / OpenAI 官方）→ 按那家发；
 *   · 认不出来（自建中转、硅基流动、OneAPI…）→ 看模型名里有没有 claude / gpt / o1 之类；
 *   · 都认不出来 → 'generic'，只发最通用的 reasoning_effort，让服务商自己决定认不认。
 *
 * 为什么不干脆全发一遍：请求体里塞满互不认识的字段，有些严格的网关会直接 400
 * （"unknown parameter"）。宁可少发，也不要让用户看到一个莫名其妙的报错。
 */
function detectThinkingVendor(settings) {
    const baseUrl = String(settings?.baseUrl || '');
    const model = String(settings?.model || '').toLowerCase();
    if (isDeepSeekOfficial(baseUrl)) return 'deepseek';
    try {
        const host = new URL(baseUrl).hostname.toLowerCase();
        if (/(^|\.)anthropic\.com$/.test(host)) return 'anthropic';
        if (/(^|\.)openai\.com$/.test(host)) return 'openai';
    } catch { /* 地址不合法就靠模型名判断 */ }
    if (/claude|anthropic/.test(model)) return 'anthropic';
    if (/gpt-5|gpt-4\.1|o1|o3|o4|codex/.test(model)) return 'openai';
    if (/deepseek|reasoner/.test(model)) return 'deepseek';
    return 'generic';
}

/**
 * 造出「思考相关」的请求字段。三种格式共用，避免同一份判据抄三遍
 * （抄三遍就会有一处忘记更新，而那种 bug 表现为"某个格式关不掉思考"）。
 *
 * @param {boolean} enabled 用户的思考模式开关
 * @param {string} effort 思考强度档位
 * @param {string} format 对话格式：openai-compatible / anthropic / openai-responses
 * @param {object} settings 当前设置（用来判厂商）
 * @returns {object} 要合并进请求体的字段
 */
function buildThinkingParams(enabled, effort, format, settings) {
    const vendor = detectThinkingVendor(settings);
    const level = mapThinkingEffort(effort, vendor);
    const on = Boolean(enabled);

    if (format === 'anthropic') {
        // Anthropic 原生格式：思考开关走 reasoning.effort（none = 关闭）。
        // 注意 `thinking` 这个字段在 Anthropic 里是**另一种东西**
        //   （{type:'enabled', budget_tokens:N}，是 Claude 官方的 extended thinking），
        //   两者同名但不同义，混用会让 Claude 官方端点报参数错，所以这里只发 reasoning。
        const out = { reasoning: { effort: on ? (level || 'high') : 'none' } };
        // 开了思考时再补一个强度（DeepSeek 的 Anthropic 兼容端点认这个字段）
        if (on && level) out.output_config = { effort: level };
        return out;
    }

    if (format === 'openai-responses') {
        // Responses 格式：只认 reasoning.effort。它没有"关闭"这个取值
        // （官方取值 minimal/low/medium/high），所以关闭时不发字段 ——
        // 靠调用方把模型换成非思考模型来表达"不要思考"。
        if (!on) return {};
        return { reasoning: { effort: level || 'medium' } };
    }

    // openai-compatible：thinking.type 开关 + reasoning_effort 强度
    // 兼容策略：
    //   这里**一律**带上 thinking 字段（关闭时显式 disabled —— DeepSeek 默认
    //   开启思考，不发就关不掉；包着 DeepSeek 的中转站也靠这个字段传开关）。
    //   严格网关（如 AMD Radeon 端点）不认这个字段会回 400 —— 那由
    //   chat-providers.js 的兼容层处理：报错点名某个思考参数时自动剥掉重试，
    //   用户无感。分层职责：
    //     · 这里负责"按厂商语义把思考意图表达全"（该发的字段都发）
    //     · chat-providers.js 负责"网关不认时自动降级"
    //   之前试过"generic 厂商不发 thinking"——那会让靠这个字段关思考的
    //   DeepSeek 中转用户失效（发出去总有可能被忽略，但收不到就一定失效）。
    const out = { thinking: { type: on ? 'enabled' : 'disabled' } };
    if (on && level) out.reasoning_effort = level;
    return out;
}



