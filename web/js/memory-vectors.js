/* 记忆索引：向量嵌入（本文件上半）与结构化条目（下半，memory_items + FTS5）。
   两者都优先落到 Go 服务端的 SQLite 索引（/api/memory/*），这样不再受 Store 单键 8MB 上限约束；
   服务端不可用（Node 版 / APK 没起本地服务 / 索引损坏）时，向量走原 Store 键回退，
   结构化条目则整段跳过 —— 它是纯补充候选，缺了不该改变任何既有召回结果。
   为什么存 int8：向量是纯派生数据，定点量化足够 top-K 排序，体积只有 Float32 的四分之一。
   索引按嵌入模型指纹分桶；换模型后指纹不匹配会整表重建，避免不同模型的向量混算。 */
'use strict';

const MEMORY_VECTOR_STORE_KEY = 'elaina_memory_vectors';
const MEMORY_VECTOR_API_BASE = '/api/memory/index';
const MEMORY_VECTOR_REMOTE_CHUNK = 256;
const MEMORY_VECTOR_REMOTE_TIMEOUT_MS = 15000;
const MEMORY_VECTOR_REMOTE_PROBE_TIMEOUT_MS = 3000;
const MEMORY_VECTOR_BATCH = 32;
const MEMORY_VECTOR_TOP_K = 24;
const MEMORY_VECTOR_RERANK_K = 12;
/* 语料上限：记忆条目优先，其后按时间倒序收对话原文。无界增长会把 data/、首次建索引的请求数
   和每次启动的等待都拖垮；超过上限的旧原文仍可用关键词检索。 */
const MEMORY_VECTOR_MAX_ITEMS = 3000;
/* 服务端 SQLite 索引没有单键上限；只有回退 Store 时仍按 6MB 预算反推条数。 */
const MEMORY_VECTOR_STORE_BUDGET = 6 * 1024 * 1024;
const MEMORY_VECTOR_ITEM_OVERHEAD = 128;
const MEMORY_VECTOR_SAVE_EVERY_BATCHES = 10;
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
/* 远端索引状态：unknown 时探测一次；unavailable 表示本次页面生命周期内走 Store 回退。 */
let memoryVectorRemoteState = 'unknown';
let memoryVectorRemoteFingerprint = '';
/* 远端待写：批内先攒着，按 10 批 / 结束时一次性发，避免每批一个请求。 */
let memoryVectorRemoteUpserts = new Map();
let memoryVectorRemoteDeletes = new Set();

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
                // 消息自带稳定 id：用数组下标做 id 时，删/改一条会让其后所有消息的 id 全部偏移，
                // 整段会话都要重新嵌入。旧数据没有 id 时才退回下标。
                id: 'msg:' + String(conv.id || '') + ':' + (msg.id ? String(msg.id) : String(index)),
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

/* 一条向量落盘后的字符数：int8 的 base64 约为维度的 4/3，另加 id / 哈希 / JSON 外壳。 */
function memoryVectorMaxItemsFor(dims) {
    const d = Number(dims) || 0;
    if (d <= 0) return MEMORY_VECTOR_MAX_ITEMS;
    const perItem = Math.ceil(d / 3) * 4 + MEMORY_VECTOR_ITEM_OVERHEAD;
    return Math.max(1, Math.min(MEMORY_VECTOR_MAX_ITEMS, Math.floor(MEMORY_VECTOR_STORE_BUDGET / perItem)));
}

/* 语料顺序即优先级（记忆条目在前、对话原文按新旧），截断只丢尾部。 */
function memoryVectorTrimCorpus(corpus, limit) {
    if (!(limit > 0) || corpus.size <= limit) return false;
    let kept = 0;
    const drop = [];
    corpus.forEach((item, id) => {
        if (kept < limit) kept += 1;
        else drop.push(id);
    });
    drop.forEach((id) => corpus.delete(id));
    return drop.length > 0;
}

function memoryVectorReadStoreIndex() {
    let parsed = null;
    try { parsed = JSON.parse(Store.getItem(MEMORY_VECTOR_STORE_KEY) || 'null'); } catch (e) { parsed = null; }
    return (parsed && parsed.items && typeof parsed.items === 'object')
        ? {
            fingerprint: String(parsed.fingerprint || ''),
            dims: Number(parsed.dims) || 0,
            items: parsed.items
        }
        : null;
}

/* 同源 JSON 请求：Node 版没有 /api/memory/*，会 404；APK 的 fetch 拦截只在 __nodeBase 就绪后
   才会把 /api/memory/ 转给 Go 服务。两种情况都按“不可用”回退，不把异常抛给调用方。 */
async function memoryVectorRemoteFetch(path, options = {}, timeoutMs = MEMORY_VECTOR_REMOTE_TIMEOUT_MS) {
    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = controller ? setTimeout(() => {
        try { controller.abort(); } catch (e) { /* 忽略 */ }
    }, timeoutMs) : null;
    const init = Object.assign({ method: 'GET' }, options);
    if (controller) init.signal = controller.signal;
    if (init.body && !init.headers) init.headers = { 'Content-Type': 'application/json' };
    try {
        const response = await fetch(MEMORY_VECTOR_API_BASE + path, init);
        let payload = null;
        try { payload = await response.json(); } catch (e) { payload = null; }
        if (!response.ok || !payload || payload.ok === false) {
            throw new Error((payload && payload.message) || ('HTTP ' + response.status));
        }
        return payload;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function memoryVectorProbeRemote(fingerprint) {
    if (!fingerprint) return 'unavailable';
    // APK 页面可能在 :node 服务就绪前就触发过一次探测；等 __nodeBase 出现后允许重试，
    // 否则一次过早的 404 会让整个页面生命周期都走 Store。
    if (memoryVectorRemoteState === 'unavailable' && typeof window !== 'undefined' && window.__nodeBase) {
        memoryVectorRemoteState = 'unknown';
    }
    if (memoryVectorRemoteFingerprint !== fingerprint) {
        memoryVectorRemoteFingerprint = fingerprint;
        memoryVectorRemoteState = 'unknown';
    }
    if (memoryVectorRemoteState !== 'unknown') return memoryVectorRemoteState;
    try {
        const payload = await memoryVectorRemoteFetch(
            '/status?fingerprint=' + encodeURIComponent(fingerprint), {},
            MEMORY_VECTOR_REMOTE_PROBE_TIMEOUT_MS
        );
        memoryVectorRemoteState = payload.available === false ? 'unavailable' : 'available';
    } catch (e) {
        memoryVectorRemoteState = 'unavailable';
    }
    return memoryVectorRemoteState;
}

async function memoryVectorRemoteReset(fingerprint) {
    if (memoryVectorRemoteState !== 'available') return false;
    try {
        await memoryVectorRemoteFetch('/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fingerprint ? { fingerprint } : {})
        });
        return true;
    } catch (error) {
        console.warn('[记忆] 清空 SQLite 向量桶失败，回退 Store', error);
        memoryVectorRemoteState = 'unavailable';
        return false;
    }
}

function memoryVectorQueueUpsert(id, item) {
    if (memoryVectorRemoteState !== 'available' || !item || !item.h || !item.v) return;
    memoryVectorRemoteUpserts.set(id, { id, h: String(item.h), v: String(item.v) });
    memoryVectorRemoteDeletes.delete(id);
}

function memoryVectorQueueDelete(id) {
    if (memoryVectorRemoteState !== 'available') return;
    memoryVectorRemoteUpserts.delete(id);
    memoryVectorRemoteDeletes.add(id);
}

async function memoryVectorFlushRemote() {
    if (memoryVectorRemoteState !== 'available') return false;
    const deletes = Array.from(memoryVectorRemoteDeletes);
    memoryVectorRemoteDeletes.clear();
    const upserts = Array.from(memoryVectorRemoteUpserts.values());
    memoryVectorRemoteUpserts.clear();
    if (!deletes.length && !upserts.length) return true;
    try {
        for (let i = 0; i < deletes.length; i += MEMORY_VECTOR_REMOTE_CHUNK) {
            await memoryVectorRemoteFetch('/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: deletes.slice(i, i + MEMORY_VECTOR_REMOTE_CHUNK) })
            });
        }
        const fingerprint = memoryVectorIndex ? memoryVectorIndex.fingerprint : '';
        const dims = memoryVectorIndex ? memoryVectorIndex.dims : 0;
        if (upserts.length && (!fingerprint || dims <= 0)) {
            throw new Error('远端索引缺少指纹或维度');
        }
        for (let i = 0; i < upserts.length; i += MEMORY_VECTOR_REMOTE_CHUNK) {
            await memoryVectorRemoteFetch('/upsert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fingerprint, dims,
                    items: upserts.slice(i, i + MEMORY_VECTOR_REMOTE_CHUNK)
                })
            });
        }
        return true;
    } catch (error) {
        console.warn('[记忆] SQLite 向量索引写入失败，回退 Store', error);
        memoryVectorRemoteState = 'unavailable';
        return false;
    }
}

/* 第一次启用 SQLite 时，把 Store 里的旧索引整批搬过去；成功后才删旧键，失败则继续用 Store。 */
async function adoptStoredMemoryVectorIndex(index, fingerprint) {
    if (memoryVectorRemoteState !== 'available' || !index) return false;
    if (Object.keys(index.items || {}).length) return false;
    const stored = memoryVectorReadStoreIndex();
    if (!stored) return false;
    if (stored.fingerprint !== fingerprint) {
        // 旧模型桶对当前模型没用，远端可用时直接释放 Store 的 6MB 配额。
        try { Store.removeItem(MEMORY_VECTOR_STORE_KEY); } catch (e) { /* 忽略 */ }
        return false;
    }
    const items = Object.keys(stored.items).map((id) => ({
        id,
        h: String((stored.items[id] && stored.items[id].h) || ''),
        v: String((stored.items[id] && stored.items[id].v) || '')
    })).filter((item) => item.h && item.v);
    if (!items.length || stored.dims <= 0) return false;
    index.fingerprint = fingerprint;
    index.dims = stored.dims;
    index.items = {};
    items.forEach((item) => {
        index.items[item.id] = { h: item.h, v: item.v };
        memoryVectorQueueUpsert(item.id, item);
    });
    const ok = await memoryVectorFlushRemote();
    if (ok) {
        try {
            Store.removeItem(MEMORY_VECTOR_STORE_KEY);
            if (typeof Store._flush === 'function') Store._flush();
        } catch (e) { /* 删除失败不影响索引本身 */ }
        console.info('[记忆] 向量索引已从 Store 迁移到 SQLite（' + items.length + ' 条）');
    }
    return ok;
}

async function loadMemoryVectorIndex() {
    if (memoryVectorIndex) return memoryVectorIndex;
    const fingerprint = (typeof memoryVectorEmbeddingFingerprint === 'function')
        ? memoryVectorEmbeddingFingerprint() : '';
    const state = await memoryVectorProbeRemote(fingerprint);
    if (state === 'available') {
        try {
            const payload = await memoryVectorRemoteFetch('?fingerprint=' + encodeURIComponent(fingerprint));
            const items = (payload.items && typeof payload.items === 'object') ? payload.items : {};
            memoryVectorIndex = {
                fingerprint: String(payload.fingerprint || fingerprint),
                dims: Number(payload.dims) || 0,
                items
            };
            return memoryVectorIndex;
        } catch (error) {
            console.warn('[记忆] 读取 SQLite 向量索引失败，回退 Store', error);
            memoryVectorRemoteState = 'unavailable';
        }
    }
    memoryVectorIndex = memoryVectorReadStoreIndex() || { fingerprint: '', dims: 0, items: {} };
    return memoryVectorIndex;
}

function saveMemoryVectorIndex() {
    // 远端可用时不再写整份 JSON；批内新增由 memoryVectorFlushRemote 增量上传。
    if (memoryVectorRemoteState === 'available') return;
    try {
        Store.setItem(MEMORY_VECTOR_STORE_KEY, JSON.stringify(memoryVectorIndex));
    } catch (e) {
        console.warn('[记忆] 向量索引落盘失败', e);
    }
}

async function flushMemoryVectorIndex() {
    if (memoryVectorRemoteState === 'available') {
        await memoryVectorFlushRemote();
        return;
    }
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

/* 增量重建：只嵌入新增/文本变了的条目，并剪掉语料里已不存在的 id。
   远端可用时向量增量写 SQLite；远端失败/不可用时整份回写 Store（旧行为）。 */
async function ensureMemoryVectorIndex() {
    const fingerprint = memoryVectorEmbeddingFingerprint();
    if (!fingerprint) return null;
    if (memoryVectorEnsurePromise) return memoryVectorEnsurePromise;
    // 每轮都重算全部语料的哈希没必要：几秒内的新增消息晚一轮进索引不影响召回质量。
    // 指纹必须一起比：刚换了嵌入模型时，旧语料配新查询向量算出来的分数没有意义。
    if (memoryVectorCorpus && Date.now() - memoryVectorLastEnsureAt < 3000
        && memoryVectorIndex && memoryVectorIndex.fingerprint === fingerprint) {
        return { index: memoryVectorIndex, corpus: memoryVectorCorpus };
    }
    memoryVectorEnsurePromise = (async () => {
        let index = await loadMemoryVectorIndex();
        if (index.fingerprint !== fingerprint) {
            // 换模型时先清掉远端旧桶；清不掉就整体回退 Store，避免两套向量混算。
            if (memoryVectorRemoteState === 'available' && index.fingerprint) {
                await memoryVectorRemoteReset(index.fingerprint);
            }
            index.fingerprint = fingerprint;
            index.dims = 0;
            index.items = {};
            memoryVectorIndex = index;
        }
        if (memoryVectorRemoteState === 'available') {
            await adoptStoredMemoryVectorIndex(index, fingerprint);
            // 迁移中途失败：远端不可用了，但 Store 里还有旧索引，直接接着用它，免去重新嵌入。
            if (memoryVectorRemoteState !== 'available' && !Object.keys(index.items || {}).length) {
                const stored = memoryVectorReadStoreIndex();
                if (stored && stored.fingerprint === fingerprint) {
                    index = stored;
                    memoryVectorIndex = index;
                }
            }
        }
        const corpus = memoryVectorBuildCorpus();
        // 维度已知时先截断，再算待嵌入清单：省掉注定装不下的条目的嵌入请求。
        if (index.dims) {
            memoryVectorTrimCorpus(corpus, memoryVectorRemoteState === 'available'
                ? MEMORY_VECTOR_MAX_ITEMS : memoryVectorMaxItemsFor(index.dims));
        }
        let changed = false;
        Object.keys(index.items).forEach((id) => {
            if (!corpus.has(id)) {
                delete index.items[id];
                memoryVectorQueueDelete(id);
                changed = true;
            }
        });
        let missing = [];
        corpus.forEach((item, id) => {
            const hash = memoryVectorHash(item.text);
            const stored = index.items[id];
            if (!stored || stored.h !== hash) missing.push({ id, item, hash });
        });
        let offset = 0;
        let batches = 0;
        while (offset < missing.length) {
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
                const item = {
                    h: entry.hash,
                    v: memoryVectorBytesToBase64(memoryVectorQuantize(result.embeddings[i]))
                };
                index.items[entry.id] = item;
                memoryVectorQueueUpsert(entry.id, item);
            });
            if (result.dims) index.dims = result.dims;
            changed = true;
            offset += batch.length;
            batches += 1;
            // 维度第一批才拿得到：拿到后立刻按预算截断剩下的待办，装不下的条目不再付嵌入费。
            // SQLite 路径没有 8MB 单键上限，只保留 3000 条的嵌入成本上限。
            const limit = memoryVectorRemoteState === 'available'
                ? MEMORY_VECTOR_MAX_ITEMS : memoryVectorMaxItemsFor(index.dims);
            if (corpus.size > limit) {
                memoryVectorTrimCorpus(corpus, limit);
                Object.keys(index.items).forEach((id) => {
                    if (!corpus.has(id)) {
                        delete index.items[id];
                        memoryVectorQueueDelete(id);
                    }
                });
                missing = missing.slice(0, offset).concat(missing.slice(offset).filter((entry) => corpus.has(entry.id)));
            }
            if (batches % MEMORY_VECTOR_SAVE_EVERY_BATCHES === 0) {
                saveMemoryVectorIndex();
                await flushMemoryVectorIndex();
            }
        }
        // 远端在批中途失败：向量已经付过费，回 Store 前必须按 6MB 预算裁一次，避免 413。
        if (memoryVectorRemoteState !== 'available' && index.dims) {
            const limit = memoryVectorMaxItemsFor(index.dims);
            if (corpus.size > limit) {
                memoryVectorTrimCorpus(corpus, limit);
                Object.keys(index.items).forEach((id) => {
                    if (!corpus.has(id)) delete index.items[id];
                });
            }
        }
        memoryVectorIndex = index;
        memoryVectorCorpus = corpus;
        if (changed) {
            saveMemoryVectorIndex();
            await flushMemoryVectorIndex();
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
    if (!query) return Promise.resolve([]);
    // 结构化记忆索引不依赖嵌入模型，没配嵌入时也要同步与检索，所以先起跑。
    const itemsReady = (typeof prefetchMemoryItemSearch === 'function')
        ? prefetchMemoryItemSearch(query) : Promise.resolve([]);
    return prefetchMemoryVectorOnly(query).then(async (hits) => {
        await itemsReady;
        return hits;
    });
}

function prefetchMemoryVectorOnly(query) {
    if (!memoryVectorEmbeddingFingerprint()) return Promise.resolve([]);
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

/* ── 结构化记忆索引 ─────────────────────────────────────────────────────
   M2b 起记忆正文以服务端 SQLite（memory_items）为权威，六类目的读写走
   /api/memory/core（见 memory.js）；这里只剩检索面：/api/memory/search 作为
   关键词召回的补充候选。任何失败都静默回退，不留新的 Store 键。 */
const MEMORY_ITEMS_API_BASE = '/api/memory';
const MEMORY_ITEMS_PROBE_TIMEOUT_MS = 3000;
const MEMORY_ITEMS_TIMEOUT_MS = 15000;
const MEMORY_ITEMS_QUERY_CACHE_LIMIT = 8;

let memoryItemsRemoteState = 'unknown';
let memoryItemsQueryCache = [];

/* 与 memoryVectorRemoteFetch 同构；单独一份是因为两条索引的可用性各自探测：
   没配嵌入模型时向量索引整段不跑，但结构化索引仍要工作。 */
async function memoryItemsFetch(path, options = {}, timeoutMs = MEMORY_ITEMS_TIMEOUT_MS) {
    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = controller ? setTimeout(() => {
        try { controller.abort(); } catch (e) { /* 忽略 */ }
    }, timeoutMs) : null;
    const init = Object.assign({ method: 'GET' }, options);
    if (controller) init.signal = controller.signal;
    if (init.body && !init.headers) init.headers = { 'Content-Type': 'application/json' };
    try {
        const response = await fetch(MEMORY_ITEMS_API_BASE + path, init);
        let payload = null;
        try { payload = await response.json(); } catch (e) { payload = null; }
        if (!response.ok || !payload || payload.ok === false) {
            const error = new Error((payload && payload.message) || ('HTTP ' + response.status));
            error.status = response.status;
            throw error;
        }
        return payload;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function memoryItemsProbe() {
    // APK 页面可能在 ':node' 服务就绪前就探测过一次；等 __nodeBase 出现后允许重试。
    if (memoryItemsRemoteState === 'unavailable' && typeof window !== 'undefined' && window.__nodeBase) {
        memoryItemsRemoteState = 'unknown';
    }
    if (memoryItemsRemoteState !== 'unknown') return memoryItemsRemoteState;
    try {
        await memoryItemsFetch('/index/status', {}, MEMORY_ITEMS_PROBE_TIMEOUT_MS);
        memoryItemsRemoteState = 'available';
    } catch (e) {
        memoryItemsRemoteState = 'unavailable';
    }
    return memoryItemsRemoteState;
}

/* 返回 null 表示「服务端没给结果」（不可用或失败），调用方保持原有关键词路径。
   返回 [] 表示服务端明确说「一条都没有」。 */
async function searchMemoryItems(queryText, { limit = 16, kind = '' } = {}) {
    const query = String(queryText || '').trim();
    if (!query) return null;
    if (await memoryItemsProbe() !== 'available') return null;
    try {
        let path = '/search?q=' + encodeURIComponent(query) + '&limit=' + encodeURIComponent(String(limit));
        if (kind) path += '&kind=' + encodeURIComponent(kind);
        const payload = await memoryItemsFetch(path);
        return Array.isArray(payload.items) ? payload.items : [];
    } catch (error) {
        console.warn('[记忆] 结构化检索失败，回退关键词', error);
        return null;
    }
}

function cacheMemoryItemHits(query, hits) {
    memoryItemsQueryCache = memoryItemsQueryCache.filter((entry) => entry.query !== query);
    memoryItemsQueryCache.unshift({ query, hits });
    if (memoryItemsQueryCache.length > MEMORY_ITEMS_QUERY_CACHE_LIMIT) {
        memoryItemsQueryCache.length = MEMORY_ITEMS_QUERY_CACHE_LIMIT;
    }
}

/* 拼提示词是同步的：异步检索在对话发出前先跑一遍，结果放进缓存供同步读取。
   首轮同步可能要拉全量 id，所以只等一小会儿，等不到就先用关键词。 */
function prefetchMemoryItemSearch(queryText) {
    const query = String(queryText || '').trim();
    if (!query) return Promise.resolve([]);
    const cached = memoryItemsQueryCache.find((entry) => entry.query === query);
    if (cached) return Promise.resolve(cached.hits);
    const run = (async () => {
        const hits = await searchMemoryItems(query);
        return hits || [];
    })().catch(() => []);
    const timeout = new Promise((resolve) => {
        setTimeout(() => resolve([]), MEMORY_VECTOR_PREFETCH_TIMEOUT_MS);
    });
    return Promise.race([run, timeout]).then((hits) => {
        const list = Array.isArray(hits) ? hits : [];
        if (list.length) cacheMemoryItemHits(query, list);
        return list;
    });
}

function getPrefetchedMemoryItemHits(queryText) {
    const query = String(queryText || '').trim();
    if (!query) return null;
    const cached = memoryItemsQueryCache.find((entry) => entry.query === query);
    return cached ? cached.hits : null;
}

/* 把搜索结果映射回记忆条目：正文和展示用日期以记忆权威（/api/memory/core 给出的
   state.memoryCore）为准，API 只负责告诉我们「哪几条相关」。 */
function memoryItemsDiaryLookup() {
    const map = new Map();
    const mc = (typeof state !== 'undefined' && state) ? state.memoryCore : null;
    const diary = (mc && Array.isArray(mc.diary)) ? mc.diary : [];
    diary.forEach((entry) => {
        if (!entry) return;
        const key = String(entry.id || '')
            || ('diary:' + String(entry.conversationId || '') + '|' + String(entry.date || ''));
        if (key && key !== 'diary:|') map.set(key, entry);
    });
    return map;
}
