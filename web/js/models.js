/* 模型列表：模型端点解析 / 列表拉取。 */
'use strict';

function modelsEndpointFor(baseUrl, apiFormat) {
    let base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('请先填写 API Base URL');
    // 用户可能把完整的功能地址整条粘进来（chat/completions、responses、messages），先剥掉再拼
    base = base.replace(/\/(?:chat\/completions|responses|messages)$/i, '');
    if (/\/models$/i.test(base)) return base;
    if (apiFormat === 'anthropic' && !/\/v\d+$/i.test(base)) return base + '/v1/models';
    return base + '/models';
}

function parseModelList(payload) {
    const raw = Array.isArray(payload?.data) ? payload.data : [];
    return raw
        .map(item => (typeof item === 'string' ? item : item?.id))
        .filter(Boolean)
        .map(String)
        .sort((a, b) => a.localeCompare(b));
}

async function fetchModelList(baseUrl, apiKey, apiFormat) {
    const endpoint = modelsEndpointFor(baseUrl, apiFormat);
    const key = String(apiKey || '').trim();
    // Anthropic 用 x-api-key、第三方中转的 /v1/models 常只认 Bearer，失败后退一步再试；limit=1000 是 Anthropic 的上限（默认只回 20 条）。
    const attempts = apiFormat === 'anthropic'
        ? [
            { url: endpoint + '?limit=1000', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
            { url: endpoint, headers: { Authorization: 'Bearer ' + key } }
        ]
        : [{ url: endpoint, headers: { Authorization: 'Bearer ' + key } }];
    let failure = null;
    for (const attempt of attempts) {
        let result;
        try {
            // 必须走设备层而非裸 fetch：APK 的 WebView 里裸 fetch 会撞 CORS，而服务商并不都发 CORS 头。
            result = await getJsonFromDevice(attempt.url, attempt.headers, 20000);
        } catch (error) {
            if (!failure) failure = error;
            break;
        }
        const models = result.ok ? parseModelList(result.payload) : [];
        if (models.length) {
            return models;
        }
        if (!failure) {
            const fromPayload = result.payload?.error?.message || result.payload?.message || '';
            // 200 却拿回 HTML 是"地址少了版本段"最典型的症状：说成"该服务不支持 /models"会把用户引向错误方向 —— 要改的是地址。
            const looksHtml = /^\s*<(!doctype|html|head|body)/i.test(String(result.rawText || ''));
            const baseNoModels = endpoint.replace(/\/models$/, '');
            if (!result.ok) {
                failure = new Error(fromPayload || ('HTTP ' + result.status));
            } else if (looksHtml) {
                failure = new Error('接口返回的是网页（HTML），不是 API 响应'
                    + '\n· 实际请求：' + attempt.url
                    + '\n· 多半是 Base URL 少了版本段，试试：' + baseNoModels + '/v1'
                    + '\n  （OpenAI 兼容的 Base URL 惯例上就带 /v1，例如 https://api.deepseek.com/v1）');
            } else if (result.payload === null) {
                failure = new Error('接口返回的不是有效 JSON'
                    + '\n· 实际请求：' + attempt.url
                    + '\n· 原文开头：' + String(result.rawText || '(空)').slice(0, 120));
            } else {
                failure = new Error('接口返回的 JSON 里没有模型列表（data 为空）'
                    + '\n· 实际请求：' + attempt.url
                    + '\n· 如果这个服务确实有模型，可能是它的 /models 路径不同，或该账号下没有可用模型。');
            }
        }
        // 只有"这条路明显走不通"才换下一条。5xx / 超时换一条也一样失败。
        if (![401, 403, 404].includes(Number(result.status))) break;
    }
    throw failure || new Error('获取模型列表失败');
}
// 不能只看 /models 列表（OpenAI 兼容的通常只回 id、没有模态字段，名字规则又会被中转别名骗）：两种判据 —— ① 名字规则（只作提示）② 探针请求（发一张 1×1 小图，结论缓存到设置）。

/** 缓存键：同一个 baseUrl + 模型名才算同一次结论，换了任一个都作废。 */
function modelVisionCacheKey(baseUrl, model) {
    return String(baseUrl || '').trim().replace(/\/+$/, '') + '|' + String(model || '').trim();
}

/** 设置里缓存的"主模型能否收图"结论：true / false / null（未测或已过期）。 */
function cachedModelImageVerdict() {
    const eff = activeChatSettings();
    const key = modelVisionCacheKey(eff.baseUrl, eff.model);
    if (!state.settings.chatModelVisionKey || state.settings.chatModelVisionKey !== key) return null;
    if (state.settings.chatModelVision === true) return true;
    if (state.settings.chatModelVision === false) return false;
    return null;
}

function rememberModelImageVerdict(verdict, baseUrl, model) {
    state.settings.chatModelVision = verdict === true ? true : (verdict === false ? false : null);
    state.settings.chatModelVisionKey = verdict === null ? '' : modelVisionCacheKey(baseUrl, model);
    try { persistSettings(); } catch (e) { /* 缓存写不进不该挡住任何主流程 */ }
}
