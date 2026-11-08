// 嵌入 / 重排序的调用接口：模型区「嵌入」「重排序」两类的唯一请求出口，后续消费方（记忆召回等）也走这两个函数。
// 请求一律经 postJsonFromDevice（APK 原生 / 本机中转 / 直连三级出口），Key 缺失与上游错误抛 ClientApiError。
'use strict';

// 嵌入 / 重排序的绑定值允许两种形态：专用提供商 id，或对话模型兜底。
// 兜底又分两种：chat: 表示「沿用当前对话使用的模型」（跟着会话走），chat:<providerId>:<model> 是钉死某一对（既有配置继续可读）。
const CHAT_MODEL_BINDING_PREFIX = 'chat:';
const CHAT_CURRENT_BINDING = CHAT_MODEL_BINDING_PREFIX;

function isChatModelBinding(value) {
    return String(value || '').startsWith(CHAT_MODEL_BINDING_PREFIX);
}

function isChatCurrentBinding(value) {
    return String(value || '') === CHAT_CURRENT_BINDING;
}

function chatCurrentBindingValue() {
    return CHAT_CURRENT_BINDING;
}

function chatModelBindingValue(providerId, model) {
    return CHAT_MODEL_BINDING_PREFIX + String(providerId || '') + ':' + String(model || '');
}

// 当前对话实际要用的「提供商 × 模型」：会话级绑定有效时优先，否则回落默认模型。
function resolveCurrentChatPair() {
    const conv = (typeof getCurrentConversation === 'function') ? getCurrentConversation() : null;
    const convPair = conv && conv.modelPair && conv.modelPair.providerId ? conv.modelPair : null;
    const pair = convPair || (state.settings && state.settings.defaultChatModel) || null;
    if (!pair || !pair.providerId) return null;
    const provider = (Array.isArray(state.settings.chatProviders) ? state.settings.chatProviders : [])
        .find((p) => p.id === pair.providerId);
    if (!provider) return null;
    const model = String(pair.model || (Array.isArray(provider.selectedModels) ? provider.selectedModels[0] : '') || '');
    return model ? { provider, model } : null;
}

function parseChatModelBinding(value) {
    const raw = String(value || '');
    if (!raw.startsWith(CHAT_MODEL_BINDING_PREFIX)) return null;
    const rest = raw.slice(CHAT_MODEL_BINDING_PREFIX.length);
    const cut = rest.indexOf(':');
    if (cut <= 0) return null;
    const providerId = rest.slice(0, cut);
    const model = rest.slice(cut + 1);
    if (!providerId || !model) return null;
    return { providerId, model };
}

// 按类目解析实际要用的提供商 / 模型：绑定为空 = 该环节未启用，直接返回 null（不能因为池里有提供商就悄悄用第一家）；
// 显式 id 悬空时回落第一条，保证改过名的旧配置不至于整条链路失灵。
function resolveModelProvider(kind, providerId = '') {
    const fallbackDefault = kind === 'embedding'
        ? state.settings.defaultEmbeddingProviderId
        : state.settings.defaultRerankProviderId;
    const raw = String(providerId || fallbackDefault || '');
    if (!raw) return null;
    if (isChatCurrentBinding(raw)) {
        const pair = resolveCurrentChatPair();
        if (!pair) return null;
        return { isChat: true, kind, provider: pair.provider, model: pair.model, baseUrl: String(pair.provider.baseUrl || '').trim() };
    }
    if (isChatModelBinding(raw)) {
        const pair = parseChatModelBinding(raw);
        if (!pair) return null;
        const provider = (Array.isArray(state.settings.chatProviders) ? state.settings.chatProviders : [])
            .find((p) => p.id === pair.providerId);
        if (!provider) return null;
        const model = pair.model || (Array.isArray(provider.selectedModels) ? provider.selectedModels[0] : '') || '';
        if (!model) return null;
        return { isChat: true, kind, provider, model, baseUrl: String(provider.baseUrl || '').trim() };
    }
    const list = Array.isArray(state.settings[kind + 'Providers']) ? state.settings[kind + 'Providers'] : [];
    if (!list.length) return null;
    const provider = list.find((p) => p.id === raw) || list[0];
    return { isChat: false, kind, provider, model: String(provider.model || '').trim(), baseUrl: String(provider.baseUrl || '').trim() };
}

// 索引/缓存要按「谁产出的向量」分桶：同一条记忆换了模型，旧向量不能继续混用。
function resolveModelFingerprint(kind, providerId = '') {
    const target = resolveModelProvider(kind, providerId);
    if (!target) return '';
    return [target.isChat ? 'chat' : 'direct', target.provider.id, target.model, target.baseUrl].join('|');
}

function chatFallbackDraft(target, apiKey) {
    return {
        ...state.settings,
        apiFormat: target.provider.apiFormat || 'openai-compatible',
        baseUrl: target.baseUrl,
        model: target.model,
        apiKey
    };
}

/** 关键词哈希向量：对话模型没有 /embeddings，只能拿它提取的关键词做稀疏向量兜底。 */
function chatKeywordVector(text) {
    const dims = 256;
    const vec = new Array(dims).fill(0);
    const words = String(text || '').split(/[\s,，、。！？；：、"“”()（）]+/).map((w) => w.trim()).filter(Boolean);
    words.forEach((word) => {
        let h = 2166136261;
        for (let i = 0; i < word.length; i += 1) {
            h ^= word.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        vec[(h >>> 0) % dims] += 1;
    });
    let norm = 0;
    for (let i = 0; i < dims; i += 1) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < dims; i += 1) vec[i] /= norm;
    return vec;
}

async function chatEmbeddingFallback(texts, target, apiKey) {
    const draft = chatFallbackDraft(target, apiKey);
    const embeddings = [];
    for (const text of texts) {
        let keywords = '';
        try {
            keywords = await callChatAPI([
                { role: 'system', content: '你是检索助手。只输出关键词，不要解释。' },
                { role: 'user', content: '从下面的文本里提取最多 20 个用于语义检索的关键词，用中文逗号分隔：\n' + text }
            ], { maxTokens: 180, temperature: 0 }, draft);
        } catch (e) {
            keywords = '';
        }
        embeddings.push(chatKeywordVector(keywords || text));
    }
    return { embeddings, model: target.model, dims: 256, fallback: 'chat-keywords' };
}

function parseChatRerankScores(reply, count) {
    const raw = String(reply || '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let obj = null;
    try { obj = JSON.parse(raw.slice(start, end + 1)); } catch (e) { return null; }
    const list = obj && (Array.isArray(obj.scores) ? obj.scores : (Array.isArray(obj.results) ? obj.results : null));
    if (!list) return null;
    const scores = new Array(count).fill(0);
    let seen = false;
    list.forEach((item) => {
        const index = Number(item && (item.index ?? item.i ?? item.id));
        const score = Number(item && (item.score ?? item.relevance_score ?? item.relevanceScore));
        if (Number.isInteger(index) && index >= 0 && index < count && Number.isFinite(score)) {
            scores[index] = Math.max(0, Math.min(1, score));
            seen = true;
        }
    });
    return seen ? scores.map((score, index) => ({ index, relevanceScore: score })) : null;
}

function lexicalRerankScores(query, docs) {
    const tokenize = (text) => (String(text || '').toLowerCase().match(/[a-z0-9_]+|[一-鿿]/g) || []);
    const q = tokenize(query);
    return docs.map((doc, index) => {
        const set = new Set(tokenize(doc));
        let hit = 0;
        q.forEach((t) => { if (set.has(t)) hit += 1; });
        return { index, relevanceScore: q.length ? hit / q.length : 0 };
    }).sort((a, b) => b.relevanceScore - a.relevanceScore);
}

async function chatRerankFallback(query, docs, target, apiKey, topN) {
    const draft = chatFallbackDraft(target, apiKey);
    let scores = null;
    try {
        const reply = await callChatAPI([
            { role: 'system', content: '你是检索重排器。只输出 JSON，不要解释。' },
            {
                role: 'user',
                content: '根据问题给每个候选文档打 0-1 的相关度分数。只输出 JSON：{"scores":[{"index":0,"score":0.93}]}。\n'
                    + '问题：' + query + '\n'
                    + docs.map((doc, index) => '[' + index + '] ' + doc).join('\n')
            }
        ], { maxTokens: 600, temperature: 0 }, draft);
        scores = parseChatRerankScores(reply, docs.length);
    } catch (e) {
        scores = null;
    }
    // 模型不可用或输出无法解析时退到词面重合度，至少还能给出一个稳定顺序。
    if (!scores) scores = lexicalRerankScores(query, docs);
    const n = Math.floor(Number(topN) || 0);
    return { results: n > 0 ? scores.slice(0, n) : scores, model: target.model, fallback: 'chat-llm' };
}

// OpenAI 兼容 /embeddings：POST {base}/embeddings { model, input: [...] }，返回 data[].embedding 向量数组。
// baseUrl 统一含版本段（…/v1），端点直接在它后面拼 —— 与对话提供商的地址习惯一致。
async function callEmbeddingAPI(texts, { providerId = '' } = {}) {
    const target = resolveModelProvider('embedding', providerId);
    if (!target) throw new ClientApiError('APP_KEY_MISSING', '还没有嵌入服务：先在 设置 → 模型 → 嵌入 里点「＋新增」添加一家');
    const apiKey = String(getProviderSecret(target.provider.id) || '').trim();
    const input = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
    if (!input.length || input.some((t) => !t.trim())) throw new ClientApiError('BAD_REQUEST', '嵌入输入里有空文本');
    if (target.isChat) return chatEmbeddingFallback(input, target, apiKey);
    if (!apiKey) throw new ClientApiError('APP_KEY_MISSING', '请先在 设置 → 模型 → 嵌入 里给这家填好 API Key');
    const baseUrl = String(target.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new ClientApiError('APP_BAD_URL', '这家嵌入服务还没填接口地址');
    const model = String(target.model || '').trim();
    if (!model) throw new ClientApiError('APP_BAD_URL', '这家嵌入服务还没填模型名');
    const result = await postJsonFromDevice(baseUrl + '/embeddings', { model, input }, {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    }, { timeoutMs: 60000 });
    if (!result.ok) await throwProviderResponseError(result, '嵌入请求失败');
    const data = Array.isArray(result.payload?.data) ? result.payload.data : [];
    const embeddings = data
        .map((item) => (Array.isArray(item?.embedding) ? item.embedding : null))
        .filter(Boolean);
    if (!embeddings.length) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '嵌入接口没有返回向量（data.embedding 为空）');
    return { embeddings, model, dims: embeddings[0].length };
}

// 通用 /rerank（Jina / Cohere / 硅基流动同形状）：POST {base}/rerank { model, query, documents, top_n? }，
// 返回 results[{ index, relevance_score }]。归一化成按相关度降序的 [{ index, relevanceScore }]，index 指回传入的 documents。
async function callRerankAPI(query, documents, { topN = 0, providerId = '' } = {}) {
    const target = resolveModelProvider('rerank', providerId);
    if (!target) throw new ClientApiError('APP_KEY_MISSING', '还没有重排序服务：先在 设置 → 模型 → 重排序 里点「＋新增」添加一家');
    const apiKey = String(getProviderSecret(target.provider.id) || '').trim();
    const docs = (Array.isArray(documents) ? documents : [documents]).map((d) => String(d ?? ''));
    if (!docs.length || docs.some((d) => !d.trim())) throw new ClientApiError('BAD_REQUEST', '重排序的文档列表里有空文本');
    if (target.isChat) return chatRerankFallback(String(query ?? ''), docs, target, apiKey, topN);
    if (!apiKey) throw new ClientApiError('APP_KEY_MISSING', '请先在 设置 → 模型 → 重排序 里给这家填好 API Key');
    const baseUrl = String(target.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new ClientApiError('APP_BAD_URL', '这家重排序服务还没填接口地址');
    const model = String(target.model || '').trim();
    if (!model) throw new ClientApiError('APP_BAD_URL', '这家重排序服务还没填模型名');
    const body = { model, query: String(query ?? ''), documents: docs };
    const n = Math.floor(Number(topN) || 0);
    if (n > 0) body.top_n = n;
    const result = await postJsonFromDevice(baseUrl + '/rerank', body, {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    }, { timeoutMs: 60000 });
    if (!result.ok) await throwProviderResponseError(result, '重排序请求失败');
    const raw = Array.isArray(result.payload?.results) ? result.payload.results : [];
    const results = raw
        .map((r) => ({ index: Number(r?.index), relevanceScore: Number(r?.relevance_score ?? r?.score ?? 0) }))
        .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < docs.length)
        .sort((a, b) => b.relevanceScore - a.relevanceScore);
    if (!results.length) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '重排序接口没有返回结果（results 为空）');
    return { results, model };
}
