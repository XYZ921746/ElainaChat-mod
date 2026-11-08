/* 记忆向量索引：把记忆条目与对话原文嵌入成向量，落在 data/ 的 elaina_memory_vectors。
   为什么写进 Store：data/ 是宿主唯一权威存储，另起文件就绕开了同步与备份。
   为什么存 int8：向量是纯派生数据，定点量化足够 top-K 排序，体积只有 Float32 的四分之一。
   索引按嵌入模型指纹分桶；换模型后指纹不匹配会整表重建，避免不同模型的向量混算。 */
'use strict';

const MEMORY_VECTOR_STORE_KEY = 'elaina_memory_vectors';
const MEMORY_VECTOR_BATCH = 32;
const MEMORY_VECTOR_TOP_K = 24;
const MEMORY_VECTOR_RERANK_K = 12;
/* 语料上限：记忆条目优先，其后按时间倒序收对话原文。无界增长会把 data/、首次建索引的请求数
   和每次启动的等待都拖垮；超过上限的旧原文仍可用关键词检索。 */
const MEMORY_VECTOR_MAX_ITEMS = 3000;
const MEMORY_VECTOR_QUERY_CACHE_LIMIT = 8;
/* 首轮建索引可能要走几十批请求：拼提示词只等一小会儿，剩下的在后台继续。 */
const MEMORY_VECTOR_PREFETCH_TIMEOUT_MS = 1200;
const MEMORY_VECTOR_RECALL_TIMEOUT_MS = 8000;

let memoryVectorIndex = null;
let memoryVectorCorpus = null;
let memoryVectorEnsurePromise = null;
let memoryVectorLastEnsureAt = 0;
let memoryVectorQueryCache = [];
let memoryVectorLastPrefetch = null;

/* FNV-1a 32 位：只用来判断「这段文本的向量还在不在」，碰撞概率在万级语料里可以忽略。 */
function memoryVectorHash(text) {
    let h = 0x811c9dc5;
    const s = String(text || '');
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

function memoryVectorTextKey(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function memoryVectorBytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function memoryVectorBase64ToBytes(encoded) {
    const binary = atob(String(encoded || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/* 先归一化再定点量化：固定比例尺省掉每条向量的 scale，余弦只差舍入误差。 */
function memoryVectorQuantize(vector) {
    const source = Array.isArray(vector) ? vector : [];
    let norm = 0;
    for (let i = 0; i < source.length; i += 1) norm += source[i] * source[i];
    norm = Math.sqrt(norm);
    const bytes = new Uint8Array(source.length);
    for (let i = 0; i < source.length; i += 1) {
        const value = norm > 0 ? source[i] / norm : 0;
        const fixed = Math.max(-127, Math.min(127, Math.round(value * 127)));
        bytes[i] = fixed + 128;
    }
    return bytes;
}

function memoryVectorCosineInt8(a, b) {
    if (!a || !b || a.length !== b.length || !a.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
        const av = a[i] - 128;
        const bv = b[i] - 128;
        dot += av * bv;
        na += av * av;
        nb += bv * bv;
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function memoryVectorMemoryItems() {
    const items = [];
    const mc = state.memoryCore;
    if (!mc) return items;
    const push = (id, kind, text, meta = {}) => {
        const body = String(text || '').replace(/\s+/g, ' ').trim();
        if (body) items.push({ id, kind, text: body, ...meta });
    };
    (Array.isArray(mc.diary) ? mc.diary : []).forEach((entry) => {
        if (!entry) return;
        push(
            'diary:' + String(entry.conversationId || '') + '|' + String(entry.date || ''),
            'diary',
            String(entry.content || '') + ' ' + (Array.isArray(entry.essences) ? entry.essences.join(' ') : ''),
            {
                convId: entry.conversationId || '',
                date: entry.date || '',
                title: entry.conversationTitle || '',
                content: String(entry.content || '')
            }
        );
    });
    ['promise', 'preference', 'motivation', 'pivotal_memory'].forEach((kind) => {
        (Array.isArray(mc[kind]) ? mc[kind] : []).forEach((text) => {
            const body = String(text || '');
            push(kind + ':' + memoryVectorHash(body), kind, body);
        });
    });
    (Array.isArray(mc.plan) ? mc.plan : []).forEach((plan) => {
        if (!plan) return;
        const body = [plan.date, plan.content].filter(Boolean).join(' · ');
        push('plan:' + memoryVectorHash(body), 'plan', body, { date: plan.date || '' });
    });
    return items;
}

function memoryVectorMessageItems() {
    const out = [];
    const conversations = Array.isArray(state.conversations) ? state.conversations : [];
    conversations.forEach((conv) => {
        if (!conv) return;
        const title = String(conv.title || '');
        (Array.isArray(conv.messages) ? conv.messages : []).forEach((msg, index) => {
            if (!msg || msg.hidden === true) return;
            if (msg.role !== 'user' && msg.role !== 'ai' && msg.role !== 'assistant') return;
            const body = String(msg.text || '').replace(/\s+/g, ' ').trim();
            if (!body) return;
            const speaker = msg.role === 'user' ? '用户' : ((state.characterCard && state.characterCard.name) || '伊蕾娜');
            out.push({
                id: 'msg:' + String(conv.id || '') + ':' + index,
                kind: 'msg',
                text: (title ? '[' + title + '] ' : '') + speaker + '：' + body,
                convId: String(conv.id || ''),
                msgIndex: index,
                role: msg.role,
                title,
                date: String(msg.timestamp || '')
            });
        });
    });
    return out;
}

/* 语料顺序就是裁剪顺序：记忆条目永远保留，对话原文只留最近的，避免把老会话挤掉新记忆。 */
function memoryVectorBuildCorpus() {
    const messages = memoryVectorMessageItems().sort((left, right) => {
        const leftTs = Date.parse(left.date || '') || 0;
        const rightTs = Date.parse(right.date || '') || 0;
        return rightTs - leftTs;
    });
    const all = memoryVectorMemoryItems().concat(messages).slice(0, MEMORY_VECTOR_MAX_ITEMS);
    const corpus = new Map();
    all.forEach((item) => corpus.set(item.id, item));
    return corpus;
}

function loadMemoryVectorIndex() {
    if (memoryVectorIndex) return memoryVectorIndex;
    let parsed = null;
    try { parsed = JSON.parse(Store.getItem(MEMORY_VECTOR_STORE_KEY) || 'null'); } catch (e) { parsed = null; }
    memoryVectorIndex = (parsed && parsed.items && typeof parsed.items === 'object')
        ? { fingerprint: String(parsed.fingerprint || ''), dims: Number(parsed.dims) || 0, items: parsed.items }
        : { fingerprint: '', dims: 0, items: {} };
    return memoryVectorIndex;
}

function saveMemoryVectorIndex() {
    try {
        Store.setItem(MEMORY_VECTOR_STORE_KEY, JSON.stringify(memoryVectorIndex));
    } catch (e) {
        console.warn('[记忆] 向量索引落盘失败', e);
    }
}

function flushMemoryVectorIndex() {
    try {
        if (typeof Store._flush === 'function') Store._flush();
    } catch (e) { /* 落盘交给 Store 自己的重试 */ }
}

function memoryVectorEmbeddingFingerprint() {
    return (typeof resolveModelFingerprint === 'function') ? resolveModelFingerprint('embedding') : '';
}

/* 对话模型兜底时不能再走 callEmbeddingAPI：那条路每条文本都要一次 LLM 请求，建索引会把账单放大到不可接受。
   这里直接用同一套本地关键词向量，建索引与查询口径一致，也不产生网络请求。 */
function memoryVectorIsChatFallback() {
    const target = (typeof resolveModelProvider === 'function') ? resolveModelProvider('embedding') : null;
    return Boolean(target && target.isChat);
}

function memoryVectorEmbed(texts) {
    const list = Array.isArray(texts) ? texts.map((text) => String(text ?? '')) : [];
    if (memoryVectorIsChatFallback() && typeof chatKeywordVector === 'function') {
        return Promise.resolve({ embeddings: list.map((text) => chatKeywordVector(text)), dims: 256 });
    }
    return callEmbeddingAPI(list);
}

function memoryVectorRerankFingerprint() {
    return (typeof resolveModelFingerprint === 'function') ? resolveModelFingerprint('rerank') : '';
}

/* 增量重建：只嵌入新增/文本变了的条目，并剪掉语料里已不存在的 id。 */
async function ensureMemoryVectorIndex() {
    const fingerprint = memoryVectorEmbeddingFingerprint();
    if (!fingerprint) return null;
    if (memoryVectorEnsurePromise) return memoryVectorEnsurePromise;
    // 每轮都重算全部语料的哈希没必要：几秒内的新增消息晚一轮进索引不影响召回质量。
    // 指纹必须一起比：刚换了嵌入模型时，旧语料配新查询向量算出来的分数没有意义。
    if (memoryVectorCorpus && Date.now() - memoryVectorLastEnsureAt < 3000
        && loadMemoryVectorIndex().fingerprint === fingerprint) {
        return { index: loadMemoryVectorIndex(), corpus: memoryVectorCorpus };
    }
    memoryVectorEnsurePromise = (async () => {
        const index = loadMemoryVectorIndex();
        if (index.fingerprint !== fingerprint) {
            index.fingerprint = fingerprint;
            index.dims = 0;
            index.items = {};
        }
        const corpus = memoryVectorBuildCorpus();
        let changed = false;
        Object.keys(index.items).forEach((id) => {
            if (!corpus.has(id)) { delete index.items[id]; changed = true; }
        });
        const missing = [];
        corpus.forEach((item, id) => {
            const hash = memoryVectorHash(item.text);
            const stored = index.items[id];
            if (!stored || stored.h !== hash) missing.push({ id, item, hash });
        });
        for (let offset = 0; offset < missing.length; offset += MEMORY_VECTOR_BATCH) {
            // 建索引期间用户改了嵌入提供商：继续写会混进另一家模型的向量，整批作废重来。
            if (memoryVectorEmbeddingFingerprint() !== fingerprint) {
                throw new Error('嵌入配置在建索引过程中发生变化，已中止');
            }
            const batch = missing.slice(offset, offset + MEMORY_VECTOR_BATCH);
            const result = await memoryVectorEmbed(batch.map((entry) => entry.item.text));
            if (!result || !Array.isArray(result.embeddings) || result.embeddings.length !== batch.length) {
                throw new Error('嵌入返回的向量条数与输入不一致');
            }
            batch.forEach((entry, i) => {
                index.items[entry.id] = {
                    h: entry.hash,
                    v: memoryVectorBytesToBase64(memoryVectorQuantize(result.embeddings[i]))
                };
            });
            if (result.dims) index.dims = result.dims;
            changed = true;
            saveMemoryVectorIndex();
        }
        memoryVectorCorpus = corpus;
        if (changed) {
            saveMemoryVectorIndex();
            flushMemoryVectorIndex();
            // 索引变了，之前按同一句查询缓存的命中可能已经过时。
            memoryVectorQueryCache = [];
            memoryVectorLastPrefetch = null;
        }
        return { index, corpus };
    })().catch((error) => {
        console.warn('[记忆] 向量索引重建失败，召回回退关键词', error);
        return null;
    }).finally(() => {
        memoryVectorEnsurePromise = null;
        memoryVectorLastEnsureAt = Date.now();
    });
    return memoryVectorEnsurePromise;
}

/* 向量召回 →（可选）重排序。返回 null 表示没配嵌入，调用方应保持 keywords 路径。 */
async function recallMemoriesByVector(queryText, { topK = MEMORY_VECTOR_TOP_K } = {}) {
    const query = String(queryText || '').trim();
    if (!query || !memoryVectorEmbeddingFingerprint()) return null;
    try {
        const prepared = await ensureMemoryVectorIndex();
        if (!prepared) return null;
        if (!prepared.corpus.size) return [];
        const queryResult = await memoryVectorEmbed([query]);
        if (!queryResult || !queryResult.embeddings.length) return [];
        const queryVector = memoryVectorQuantize(queryResult.embeddings[0]);
        const hits = [];
        Object.keys(prepared.index.items).forEach((id) => {
            const item = prepared.corpus.get(id);
            if (!item) return;
            const stored = prepared.index.items[id];
            if (!stored || typeof stored.v !== 'string') return;
            hits.push({
                id,
                item,
                score: memoryVectorCosineInt8(queryVector, memoryVectorBase64ToBytes(stored.v))
            });
        });
        hits.sort((left, right) => right.score - left.score);
        let ranked = hits.slice(0, Math.max(topK, MEMORY_VECTOR_RERANK_K));
        if (memoryVectorRerankFingerprint() && ranked.length > 1) {
            try {
                const result = await callRerankAPI(query, ranked.map((hit) => hit.item.text), {
                    topN: Math.min(ranked.length, MEMORY_VECTOR_RERANK_K)
                });
                const scores = new Map();
                result.results.forEach((entry) => scores.set(entry.index, entry.relevanceScore));
                ranked = ranked.map((hit, index) => (
                    scores.has(index) ? { ...hit, score: scores.get(index) } : hit
                )).sort((left, right) => right.score - left.score);
            } catch (error) {
                console.warn('[记忆] 重排序失败，保留向量顺序', error);
            }
        }
        return ranked.slice(0, topK);
    } catch (error) {
        console.warn('[记忆] 向量召回失败，回退关键词', error);
        return null;
    }
}

/* 只配了重排序、没配嵌入时，用它给关键词召回的候选重排一次 —— 两个模型各自都有用武之地。 */
async function rerankMemoryTexts(queryText, texts, topN = 0) {
    const query = String(queryText || '').trim();
    const docs = (Array.isArray(texts) ? texts : []).map((text) => String(text || ''));
    if (!query || !memoryVectorRerankFingerprint() || docs.length < 2) return null;
    try {
        const result = await callRerankAPI(query, docs, { topN: topN || docs.length });
        return result.results;
    } catch (error) {
        console.warn('[记忆] 重排序失败，保留原顺序', error);
        return null;
    }
}

function cacheMemoryVectorRecall(query, hits) {
    memoryVectorQueryCache = memoryVectorQueryCache.filter((entry) => entry.query !== query);
    memoryVectorQueryCache.unshift({ query, hits });
    if (memoryVectorQueryCache.length > MEMORY_VECTOR_QUERY_CACHE_LIMIT) {
        memoryVectorQueryCache.length = MEMORY_VECTOR_QUERY_CACHE_LIMIT;
    }
    memoryVectorLastPrefetch = { query, hits };
}

/* 拼提示词是同步的：异步召回在对话发出前先跑一遍，结果放进缓存供同步读取。
   首轮建索引可以很慢，这里只等一小会儿；超时就先用关键词，索引在后台继续建。 */
function prefetchMemoryVectorRecall(queryText) {
    const query = String(queryText || '').trim();
    if (!query || !memoryVectorEmbeddingFingerprint()) return Promise.resolve([]);
    const cached = memoryVectorQueryCache.find((entry) => entry.query === query);
    if (cached) {
        memoryVectorLastPrefetch = cached;
        return Promise.resolve(cached.hits);
    }
    const recall = recallMemoriesByVector(query).then((hits) => {
        if (hits) cacheMemoryVectorRecall(query, hits);
        return hits || [];
    }).catch(() => []);
    const timeout = new Promise((resolve) => {
        setTimeout(() => resolve([]), MEMORY_VECTOR_PREFETCH_TIMEOUT_MS);
    });
    return Promise.race([recall, timeout]);
}

function getPrefetchedMemoryRecall(queryText) {
    const query = String(queryText || '').trim();
    if (!query) return null;
    const cached = memoryVectorQueryCache.find((entry) => entry.query === query);
    if (cached) return cached.hits;
    return memoryVectorLastPrefetch && memoryVectorLastPrefetch.query === query ? memoryVectorLastPrefetch.hits : null;
}

/* 结构化记忆（约定/偏好/…）按文本找自己的向量分：同一条目在复述时用同一份文本。 */
function getMemoryVectorScoreMap(queryText) {
    const hits = getPrefetchedMemoryRecall(queryText);
    if (!hits || !hits.length) return null;
    const map = new Map();
    hits.forEach((hit) => {
        if (!hit.item) return;
        const key = memoryVectorTextKey(hit.item.text);
        map.set(key, Math.max(map.get(key) || 0, hit.score));
    });
    return map;
}
