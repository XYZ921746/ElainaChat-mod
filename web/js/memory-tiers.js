/* 记忆分层视图模型：把宿主现有数据（对话原文 + memoryCore 压缩记忆）映射成 热/温/冷 三层，
   分层语义与 memory-system 引擎对齐 —— 热=对话现场的完整原文、温=压缩后的记忆摘要、冷=长期归档（不进上下文）。
   容量以「模型上下文长度」为总标尺做三段分配（双点滑块：左点=空闲|温边界，右点=温|热边界）：
   左段是空闲预留（模型输出 / 工具调用结果 / 召回注入的空间，建议 ≥200k），不是冷区 ——
   冷记忆存在向量库里，不占上下文标尺。引擎接线后同一份配置直接换算成 MemoryConfig。 */
'use strict';

/** 容量默认值：总标尺默认按 1M 上下文；默认分配 空闲 20% / 温 25% / 热 55%（1M 下空闲正好 200k）。 */
const MEMORY_TIERS_DEFAULT = Object.freeze({
    model_context_tokens: 1000000,
    idle_tokens: 200000,
    warm_tokens: 250000
});

const MEMORY_TIERS_KEY = 'elaina_memory_tiers';

/** 模型上下文档位：宿主模型配置暂无上下文字段，先给常见档位 + 自定义；引擎/模型系统将来提供真值时可自动接管。 */
const MEMORY_CONTEXT_PRESETS = Object.freeze([
    { label: '128k', value: 128000 },
    { label: '200k', value: 200000 },
    { label: '256k', value: 256000 },
    { label: '500k', value: 500000 },
    { label: '1M', value: 1000000 }
]);

/** 空闲预留下限：用户建议 ≥200k；小窗口物理放不下 200k 时退化为总量的 40%。 */
const MEMORY_IDLE_FLOOR_TOKENS = 200000;

/** 与引擎 HeuristicTokenizer 同口径的轻量估算（CJK 逐字、英文按词长、其余按符号密度），保证界面数字与引擎判定一致。 */
function estimateTokens(text) {
    const s = String(text || '');
    if (!s) return 0;
    let tokens = 0;
    for (const ch of s) {
        if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(ch)) tokens += 1;
    }
    const words = s.match(/[A-Za-z0-9]+/g) || [];
    for (const w of words) tokens += Math.max(1, Math.ceil(w.length / 4));
    const rest = s.replace(/[\sA-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, '');
    tokens += Math.ceil(rest.length / 4);
    return tokens;
}

/**
 * 三段容量合法性：空闲 ≥ min(200k, 总量 40%)（给输出/工具/召回留足空间，防止上下文报错）；
 * 温、热各至少 1% 总量；各段约束冲突时以「空闲下限」优先。
 */
function normalizeMemoryTierConfig(raw) {
    const total = Math.max(1000, Math.floor(Number(raw && raw.model_context_tokens) || MEMORY_TIERS_DEFAULT.model_context_tokens));
    const minSeg = Math.max(100, Math.floor(total * 0.01));
    const idleFloor = Math.min(MEMORY_IDLE_FLOOR_TOKENS, Math.floor(total * 0.4));
    const idleCeiling = Math.floor(total * 0.45);
    let idle = Math.floor(Number(raw && raw.idle_tokens) || 0);
    idle = Math.min(idleCeiling, Math.max(Math.min(idleFloor, idleCeiling), idle));
    let warm = Math.floor(Number(raw && raw.warm_tokens) || 0);
    warm = Math.min(total - minSeg - idle, Math.max(minSeg, warm));
    return { model_context_tokens: total, idle_tokens: idle, warm_tokens: warm };
}

/** 读分层容量配置：兼容旧格式键（hot/warm_max_tokens、cold_max_items、cold_tokens），非法值回退默认。
    last_conv_id（上次选中的对话）随同一份配置持久化。 */
function loadMemoryTierConfig() {
    let saved = null;
    try { saved = JSON.parse(Store.getItem(MEMORY_TIERS_KEY) || 'null'); } catch (e) { saved = null; }
    let cfg;
    if (saved && Number.isFinite(Number(saved.model_context_tokens))) {
        cfg = normalizeMemoryTierConfig(saved);
    } else if (saved && Number.isFinite(Number(saved.hot_max_tokens))) {
        // 兼容独立容量旧格式：温沿用绝对值并按新总标尺收敛，空闲按下限取值
        const total = MEMORY_TIERS_DEFAULT.model_context_tokens;
        cfg = normalizeMemoryTierConfig({
            model_context_tokens: total,
            idle_tokens: Math.min(MEMORY_IDLE_FLOOR_TOKENS, total * 0.4),
            warm_tokens: Math.min(saved.warm_max_tokens, total * 0.6)
        });
    } else {
        cfg = { ...MEMORY_TIERS_DEFAULT };
    }
    cfg.last_conv_id = saved && typeof saved.last_conv_id === 'string' ? saved.last_conv_id : '';
    return cfg;
}

/** 写分层容量配置（Store 防抖落 data/store.json；页面上需要立即生效时手动调 flush）。
    last_conv_id 透传保存，其余字段走三段合法性归一。 */
function saveMemoryTierConfig(config) {
    const clean = normalizeMemoryTierConfig(config);
    if (config && typeof config.last_conv_id === 'string') clean.last_conv_id = config.last_conv_id;
    Store.setItem(MEMORY_TIERS_KEY, JSON.stringify(clean));
    if (typeof Store._flush === 'function') Store._flush();
    return clean;
}

/**
 * 记忆页的默认对话：优先上次选中的（持久化），失效（被删除/尚无记录）回退第一个对话。
 * 没有任何对话时返回空串（页面走空态）。
 */
function ensureMemoryConvFilter() {
    const convs = Array.isArray(state.conversations) ? state.conversations : [];
    const current = state.memoryFilterConvId || '';
    const exists = current && convs.some(c => (c.id || '') === current);
    if (exists) return current;
    const last = (loadMemoryTierConfig().last_conv_id || '');
    const lastOk = last && convs.some(c => (c.id || '') === last);
    state.memoryFilterConvId = lastOk ? last : ((convs[0] && convs[0].id) || '');
    return state.memoryFilterConvId;
}

/** 选中对话并持久化（记忆页组头与「选择对话」弹层共用的落点）。 */
function rememberMemoryConv(id) {
    state.memoryFilterConvId = id || '';
    const cfg = loadMemoryTierConfig();
    saveMemoryTierConfig({ ...cfg, last_conv_id: state.memoryFilterConvId });
}

/** 记忆日记开关是否开启（宿主设置；关 = 不做记忆压缩，温区不可用）。 */
function memoryCompressionEnabled() {
    try { return !!(state.settings && state.settings.autoMemory); } catch (e) { return false; }
}

/** 有效容量：未开启记忆日记时，温区不可用，分配的温记忆容量并入热区。 */
function memoryTierEffective(cfg) {
    const enabled = memoryCompressionEnabled();
    const warm = enabled ? cfg.warm_tokens : 0;
    return {
        ...cfg,
        warm_tokens: warm,
        hot_tokens: cfg.model_context_tokens - cfg.idle_tokens - warm,
        compressionEnabled: enabled
    };
}

/** token 数展示：中文习惯用「万」，128k 这类档位保留 k。 */
function memoryTierFormatTokens(n) {
    if (n >= 10000) return (Math.round(n / 1000) / 10) + '万';
    return String(n);
}

/** 记忆条目的 kind 分类：与 memoryCore 类目一一对应（diary 之外都是无对话归属的全局事实）。 */
const MEMORY_KIND_LABELS = Object.freeze({
    diary: '日记',
    promise: '约定',
    preference: '偏好',
    motivation: '在意的事',
    pivotal_memory: '关键时刻',
    plan: '计划'
});

/** 收集温/冷素材（压缩记忆池）：diary 带对话归属与时间，结构化类目是全局事实。 */
function collectMemoryEntries(core) {
    const entries = [];
    const diaryList = Array.isArray(core.diary) ? core.diary : [];
    for (const d of diaryList) {
        const text = cleanMemoryPromptText(d && d.content, 4000);
        if (!text) continue;
        const ts = diaryTimestamp(d);
        entries.push({
            kind: 'diary',
            label: MEMORY_KIND_LABELS.diary,
            convId: (d && d.conversationId) || '',
            text,
            essences: Array.isArray(d && d.essences) ? d.essences.filter(Boolean).slice(0, 6) : [],
            date: (d && d.date) || '',
            ts: Number.isFinite(ts) ? ts : 0,
            tokens: estimateTokens(text)
        });
    }
    for (const key of ['promise', 'preference', 'motivation', 'pivotal_memory']) {
        const list = Array.isArray(core[key]) ? core[key] : [];
        for (const raw of list) {
            const text = cleanMemoryPromptText(raw, 4000);
            if (!text) continue;
            entries.push({
                kind: key,
                label: MEMORY_KIND_LABELS[key],
                convId: '',
                text,
                essences: [],
                date: '',
                ts: 0,
                tokens: estimateTokens(text)
            });
        }
    }
    const planList = Array.isArray(core.plan) ? core.plan : [];
    for (const p of planList) {
        const content = cleanMemoryPromptText(p && p.content, 1000);
        if (!content) continue;
        const date = cleanMemoryPromptText(p && p.date, 40);
        const text = date ? date + ' · ' + content : content;
        entries.push({
            kind: 'plan',
            label: MEMORY_KIND_LABELS.plan,
            convId: '',
            text,
            essences: [],
            date,
            ts: 0,
            tokens: estimateTokens(text)
        });
    }
    return entries;
}

/**
 * 构建分层视图：三段容量以模型上下文为总标尺（冷 → 温 → 热各占一段）。
 * 温区填充（新→旧），装不下的下沉冷区；冷区再按自身段容量清理最旧；
 * 热区是每个对话各自的原文窗口（回到哪段对话，哪段就有自己的「现场」）。
 */
function buildMemoryTiers(config) {
    const cfg = memoryTierEffective(config || loadMemoryTierConfig());
    const hotCapacity = cfg.hot_tokens;
    const convs = Array.isArray(state.conversations) ? state.conversations : [];
    const entries = collectMemoryEntries(state.memoryCore || {});

    // 温区填充（新→旧），装不下的下沉冷区；冷区在向量库里，不设上下文口径的容量上限
    const sorted = entries.slice().sort((a, b) => (b.ts - a.ts));
    let warmBudget = cfg.warm_tokens;
    const warmEntries = [];
    const coldEntries = [];
    for (const entry of sorted) {
        if (entry.tokens <= warmBudget) {
            warmEntries.push(entry);
            warmBudget -= entry.tokens;
        } else {
            coldEntries.push(entry);
        }
    }
    const coldKept = coldEntries;

    // 热区窗口：每个对话从最新往回累计，超容量的最早原文留在对话记录里（不进热区）。
    // 消息字段兼容：宿主真实消息是 {role: 'user'|'ai', text, timestamp}，夹具/测试是 {role: 'assistant', content, time}。
    function hotWindow(conv) {
        const msgs = (Array.isArray(conv && conv.messages) ? conv.messages : [])
            .filter(m => m && (m.role === 'user' || m.role === 'ai' || m.role === 'assistant') && String(m.text ?? m.content ?? '').trim());
        const windowItems = [];
        let budget = hotCapacity;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            const text = cleanMemoryPromptText(m.text ?? m.content, 4000);
            if (!text) continue;
            const tokens = estimateTokens(text);
            if (budget < tokens && windowItems.length) break;
            windowItems.push({ role: m.role, text, tokens });
            budget -= tokens;
        }
        windowItems.reverse();
        return { items: windowItems, tokens: windowItems.reduce((s, it) => s + it.tokens, 0) };
    }

    function pickByConv(list, convId) {
        const mine = list.filter(e => e.convId === convId);
        return { items: mine, tokens: mine.reduce((s, e) => s + e.tokens, 0) };
    }

    const lastTs = (conv) => {
        const msgs = Array.isArray(conv && conv.messages) ? conv.messages : [];
        const last = msgs[msgs.length - 1];
        const t = Date.parse((last && (last.timestamp ?? last.time)) ?? '');
        return Number.isFinite(t) ? t : 0;
    };

    const groups = [];
    for (const conv of convs.slice().sort((a, b) => lastTs(b) - lastTs(a))) {
        const id = conv.id || '';
        groups.push({
            id,
            title: conv.title || '未命名对话',
            hot: hotWindow(conv),
            warm: pickByConv(warmEntries, id),
            cold: pickByConv(coldKept, id)
        });
    }
    // 无对话归属的结构化记忆 + 归属已删除对话的日记：各自成组，不硬塞进现存对话
    const knownIds = new Set(convs.map(c => c.id || ''));
    const globalWarm = warmEntries.filter(e => !e.convId);
    const globalCold = coldKept.filter(e => !e.convId);
    if (globalWarm.length || globalCold.length) {
        groups.push({
            id: '__global__',
            title: '全局记忆',
            hot: { items: [], tokens: 0 },
            warm: { items: globalWarm, tokens: globalWarm.reduce((s, e) => s + e.tokens, 0) },
            cold: { items: globalCold, tokens: globalCold.reduce((s, e) => s + e.tokens, 0) }
        });
    }
    const orphanWarm = warmEntries.filter(e => e.convId && !knownIds.has(e.convId));
    const orphanCold = coldKept.filter(e => e.convId && !knownIds.has(e.convId));
    if (orphanWarm.length || orphanCold.length) {
        groups.push({
            id: '__orphan__',
            title: '已删除的对话',
            hot: { items: [], tokens: 0 },
            warm: { items: orphanWarm, tokens: orphanWarm.reduce((s, e) => s + e.tokens, 0) },
            cold: { items: orphanCold, tokens: orphanCold.reduce((s, e) => s + e.tokens, 0) }
        });
    }
    return {
        groups,
        cfg,
        counts: { hot: groups.reduce((s, g) => s + g.hot.items.length, 0), warm: warmEntries.length, cold: coldKept.length }
    };
}
