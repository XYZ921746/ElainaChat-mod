// 对话 API：错误归一化、端点判定、思考参数（ClientApiError / 错误文案 / getChatBaseUrl / isDeepSeekOfficial / 思考四档与 buildThinkingParams）。纯函数与常量，无 DOM / 网络副作用。
'use strict';

class ClientApiError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = 'ClientApiError';
        this.code = code || 'UNKNOWN_ERROR';
        this.status = Number(options.status || 0);
        this.retryable = Boolean(options.retryable);
        // 本次请求是否真的带了图片，只用来决定报错时要不要提"图片转述"——无条件提会误导没发图的用户。
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
    // 「模型名不在这个服务上」是自建中转 / 新服务商最高频的问题：不单独给码的话它会落进 UNKNOWN_ERROR，用户只看到"请求失败"，无从下手。
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
            // 只有"本次真的带了图片"或"服务商的话本身就在说图片"才提图片原因：无条件拼上去会让任何 400 都甩一句"图片转述常见原因"，用户会来问"我没发图片为什么会这样"。
            const imageRelated = apiError.imageHint === true || /image|vision|multimodal|多模态|图片/i.test(detail);
            // 中转站（new-api 系）按模型名后缀替我们决定要不要开 Claude 的扩展思考：名字里带 -thinking 就会开，而扩展思考的预算要求 max_tokens 更大；提示必须说清"后缀是干什么的、不想要就删掉"。
            const thinkingBudgetIssue = /max_tokens/i.test(detail) && /thinking/i.test(detail);
            let hint;
            if (thinkingBudgetIssue) {
                hint = '\n\n这条报错来自模型名里的 -thinking 后缀：中转站看到它就会开启 Claude 的扩展思考，'
                    + '而扩展思考的预算要求 max_tokens 更大（应用已自动抬高到安全值，若仍报错说明该中转站限制更严）。'
                    + '\n· 不想要思考：把模型名里的 -thinking 去掉，例如 claude-sonnet-4-5-thinking → claude-sonnet-4-5；'
                    + '\n· 想要思考：可以用 -thinking-<数字> 指定预算，但数字越大越慢、也越贵。';
            } else if (imageRelated) {
                hint = '\n\n图片转述常见原因：视觉模型名不对、图片过大、或该模型不支持图片。请检查 设置 → 模型 → 对话模型 → 图片转述 的模型名，或换用 Qwen-VL 等支持图片的模型。';
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
    // 本机登录态失效：文案说"点确定会跳登录页"就必须真的跳，否则用户按提示刷新还是撞同一个 401；其它错误维持"只提示、不跳转"。
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

// 多提供商对话模型（配置见 settings.chatProviders，UI 在设置页「模型」分栏）

function chatProviderById(id) {
    const list = Array.isArray(state.settings.chatProviders) ? state.settings.chatProviders : [];
    return list.find(p => p && p.id === id) || null;
}

/** 一张卡映射成请求 settings；model 由**调用方给的对**决定（一张卡可勾选多个模型）。 */
function chatProviderToSettings(prov, model) {
    const s = state.settings;
    const keys = (s.chatProviderKeys && typeof s.chatProviderKeys === 'object') ? s.chatProviderKeys : {};
    return {
        ...s,
        apiFormat: CHAT_API_FORMATS[prov.apiFormat] ? prov.apiFormat : (s.apiFormat || 'openai-compatible'),
        baseUrl: String(prov.baseUrl || '').trim() || s.baseUrl,
        model: String(model || '').trim() || String(prov.model || '').trim() || s.model,
        apiKey: String(keys[prov.id] || '')
    };
}

/** 「提供商×模型」对的合法性：卡在、模型在其勾选列表里。 */
function validChatModelPair(pair) {
    const pid = String(pair && pair.providerId || '');
    const model = String(pair && pair.model || '').trim();
    if (!pid || !model) return null;
    const prov = chatProviderById(pid);
    if (!prov) return null;
    const selected = Array.isArray(prov.selectedModels) ? prov.selectedModels : [];
    // 模型不在勾选列表也放行（手填别名场景），只要卡存在 —— 勾选列表只约束 UI 呈现。
    return { providerId: pid, model };
}

// 默认模型对应的请求 settings，callChatAPI 的 settings 缺省值就是它 —— 主聊天、记忆摘要、用户印象、翻译、Agent 因此全部自动跟随「默认模型」；对失效时回落整份 state.settings，保证"永远拿得到一套可用凭据"。
function activeChatSettings() {
    const s = state.settings;
    const pair = validChatModelPair(s.defaultChatModel);
    if (!pair) return s;
    return chatProviderToSettings(chatProviderById(pair.providerId), pair.model);
}

// 会话级模型覆盖：「当前会话设定」里给这段对话指定的模型，经同一套合法性校验映射成请求 settings；
//   未设置或对已失效（提供商被删等）返回 null —— 调用方回落默认模型。
function conversationChatSettings(conv) {
    if (!conv || !conv.modelPair) return null;
    const pair = validChatModelPair(conv.modelPair);
    if (!pair) return null;
    return chatProviderToSettings(chatProviderById(pair.providerId), pair.model);
}

// 当前会话实际生效的模型名（顶栏胶囊显示用）：无覆盖或对失效返回 ''，由调用方回落默认模型名。
function effectiveConversationModel() {
    const conv = (typeof getCurrentConversation === 'function') ? getCurrentConversation() : null;
    if (!conv || !conv.modelPair) return '';
    const pair = validChatModelPair(conv.modelPair);
    return pair ? pair.model : '';
}

// 失败回退链：按用户排的先后顺序把回退对逐个映射成请求 settings，剔除失效对与「和默认同对」的项（同对回退等于把同一次失败再撞一遍）；数组顺序即回退顺序。
function fallbackChatChainSettings() {
    const s = state.settings;
    const list = Array.isArray(s.fallbackChatModels) ? s.fallbackChatModels : [];
    const defaultPair = validChatModelPair(s.defaultChatModel);
    const sameAsDefault = (pair) => {
        const v = validChatModelPair(pair);
        return v && defaultPair
            ? v.providerId === defaultPair.providerId && v.model === defaultPair.model
            : false;
    };
    const out = [];
    for (const pair of list) {
        if (sameAsDefault(pair)) continue;
        const v = validChatModelPair(pair);
        if (!v) continue;
        out.push(chatProviderToSettings(chatProviderById(v.providerId), v.model));
    }
    return out;
}

// 是不是 DeepSeek 官方端点：判据是地址而不是某个开关 —— 地址填官方域名（含其兼容网关）时成立，填别家中转时不成立。
function isDeepSeekOfficial(baseUrl) {
    try {
        return /(^|\.)deepseek\.com$/i.test(new URL(String(baseUrl || '')).hostname);
    } catch { return false; }
}


// 思考模式（各家参数差异很大，全部收在这里）：关掉思考开关时必须显式发 disabled，否则模型照样思考（还在等、还在扣 token，界面上什么都看不到）；同时保留「换模型名」一条路，供只认模型名的老中转站使用。

// 思考强度档位（对外只有这四档，映射到各家自己的取值）：off 不思考（默认，请求里显式发 disabled）、low 快速思考、high 均衡、max 深度思考。对外只给四档而不是把各家取值原样暴露：用户要表达的是「想多深」，off 就等于关思考。
const THINKING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);

// 把一个"思考强度"档位映射成某个服务商能接受的取值：effort 为内部档位 off / low / high / max，vendor 为 deepseek | anthropic | openai | generic；返回 null = 不发这个字段（off 或该服务商不认这一档）。
function mapThinkingEffort(effort, vendor) {
    const level = String(effort || '').trim().toLowerCase();
    // off（以及任何非法值/已废弃的档位 medium）→ 不发强度字段；"关掉思考"由调用方用 enabled 表达。
    if (level === 'off' || !THINKING_EFFORTS.includes(level)) return null;
    // OpenAI 的 reasoning_effort 只有 minimal/low/medium/high，没有 max —— 「极高」在它那边降到 high。
    if (vendor === 'openai' && level === 'max') return 'high';
    // deepseek（low/high/max）、anthropic（reasoning.effort: none/low/high/max）、generic（交给服务商自己判）都原样透传。
    return level;
}

// 判断一个端点/模型该按哪家的思考参数来发，判据是"地址优先、模型名兜底"：地址认得出（DeepSeek / Anthropic / OpenAI 官方）按那家发；认不出看模型名里的 claude / gpt / o1；都认不出 → 'generic'，只发最通用的 reasoning_effort。
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

// 造出「思考相关」的请求字段。三种格式共用，避免同一份判据抄三遍（抄三遍就会有一处忘记更新，而那种 bug 表现为"某个格式关不掉思考"）；enabled 是思考开关，effort 是强度档位，format 是 openai-compatible / anthropic / openai-responses。
function buildThinkingParams(enabled, effort, format, settings) {
    const vendor = detectThinkingVendor(settings);
    const level = mapThinkingEffort(effort, vendor);
    const on = Boolean(enabled);

    if (format === 'anthropic') {
        // Anthropic 原生格式：思考开关走 reasoning.effort（none = 关闭）。`thinking` 在 Anthropic 里是另一种东西（{type:'enabled', budget_tokens:N}，Claude 的 extended thinking），同名不同义，混用会让官方端点报参数错。
        const out = { reasoning: { effort: on ? (level || 'high') : 'none' } };
        if (on && level) out.output_config = { effort: level };
        return out;
    }

    if (format === 'openai-responses') {
        // Responses 格式只认 reasoning.effort 且没有"关闭"取值（官方只有 minimal/low/medium/high），关闭时不发字段 —— 由调用方换非思考模型。
        if (!on) return {};
        return { reasoning: { effort: level || 'medium' } };
    }

    // openai-compatible：thinking.type 开关 + reasoning_effort 强度。关闭时也显式发 disabled（DeepSeek 默认开启思考，不发就关不掉；包着 DeepSeek 的中转站也靠它传开关）；严格网关不认这个字段会回 400，那由 chat-providers.js 的兼容层剥掉重试。
    const out = { thinking: { type: on ? 'enabled' : 'disabled' } };
    if (on && level) out.reasoning_effort = level;
    return out;
}



