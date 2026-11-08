/* 记忆页：按对话分组展示 热/温/冷 三层记忆（分层与容量逻辑在 memory-tiers.js），
   右上角设置按钮可调三层容量并带说明。与日记页同一套进出页面的状态切换。 */
'use strict';

/* kind 徽标的展示顺序（温/冷卡片上按此显示分类标签）。 */
const MEMORY_TIER_LAYERS = Object.freeze([
    { key: 'hot', label: '热区', sub: '完整原文', icon: '🔥' },
    { key: 'warm', label: '温区', sub: '压缩记忆', icon: '🌤️' },
    { key: 'cold', label: '冷区', sub: '长期归档', icon: '❄️' }
]);

function memoryTierRoleLabel(role) {
    return role === 'user' ? '用户' : '伊蕾娜';
}

let memoryView = 'tiers'; // 记忆页内页签：'tiers' = 分层记忆，'diary' = 日记分区

/* 三层分区的展开层（key = 'hot' | 'warm' | 'cold'）：同一层在各对话组里一起展开/收起，
   默认为空即全收起 —— 层头本身就是摘要行，铺开卡片是主动选择。 */
const memoryTierExpanded = new Set();

/** 点层头就地切类展开/收起该层（不整页重渲染：重渲染会丢列表滚动位置）。 */
function toggleMemoryTierExpand(layerKey) {
    const expanded = !memoryTierExpanded.has(layerKey);
    if (expanded) memoryTierExpanded.add(layerKey);
    else memoryTierExpanded.delete(layerKey);
    for (const block of elements.memoryBody.querySelectorAll('.memory-tier-block.is-' + layerKey)) {
        block.classList.toggle('is-collapsed', !expanded);
        const head = block.querySelector('.memory-tier-head');
        if (head) head.setAttribute('aria-expanded', String(expanded));
    }
}

function renderMemoryPage() {
    if (memoryView === 'diary') {
        ensureMemoryConvFilter();
        renderMemoryDiaryView();
        return;
    }
    ensureMemoryConvFilter();
    const view = buildMemoryTiers();
    const filterId = state.memoryFilterConvId || '';
    // 锁定对话时附带全局记忆组：约定/偏好/计划不属于任何对话，任何视图下都应可见
    const groups = filterId
        ? view.groups.filter(g => g.id === filterId || g.id === '__global__')
        : view.groups;

    const total = view.counts.hot + view.counts.warm + view.counts.cold;
    elements.memoryCount.textContent = filterId
        ? `${groups.reduce((s, g) => s + g.hot.items.length + g.warm.items.length + g.cold.items.length, 0)} / ${total} 条记忆`
        : `${total} 条记忆 · 🔥${view.counts.hot} 🌤️${view.counts.warm} ❄️${view.counts.cold}`;

    const emptyText = elements.memoryEmpty.querySelector('p');
    if (emptyText) {
        emptyText.textContent = filterId
            ? '这段对话还没有分层记忆。'
            : '还没有可分层的记忆，先和伊蕾娜聊一段旅途吧。';
    }
    elements.memoryEmpty.classList.toggle('hidden', groups.some(g => g.hot.items.length || g.warm.items.length || g.cold.items.length));
    elements.memoryEmpty.querySelector('div').textContent = '🧠';
    elements.memoryBody.innerHTML = '';

    for (const group of groups) {
        const groupHasAny = group.hot.items.length || group.warm.items.length || group.cold.items.length;
        if (!groupHasAny) continue;
        const section = document.createElement('section');
        section.className = 'memory-section animate-fade-in-up';

        // —— 对话组头：标题 + 三层分布徽标 ——
        const head = document.createElement('div');
        head.className = 'memory-conv-head';
        const title = document.createElement('span');
        title.className = 'memory-conv-title';
        title.textContent = group.title;
        head.appendChild(title);
        const badges = document.createElement('span');
        badges.className = 'memory-conv-badges';
        for (const layer of MEMORY_TIER_LAYERS) {
            const n = group[layer.key].items.length;
            if (!n) continue;
            const badge = document.createElement('span');
            badge.className = 'memory-conv-badge is-' + layer.key;
            badge.textContent = `${layer.icon}${layer.label} ${n}`;
            badges.appendChild(badge);
        }
        head.appendChild(badges);
        section.appendChild(head);

        // —— 组内三层分区（空层不渲染）——
        for (const layer of MEMORY_TIER_LAYERS) {
            const tier = group[layer.key];
            if (!tier.items.length) continue;
            section.appendChild(buildMemoryTierBlock(layer, tier, view));
        }
        elements.memoryBody.appendChild(section);
    }

    if (typeof syncConvFilterLabels === 'function') syncConvFilterLabels();
}

/** 一层分区：层头（图标 + 名称 + 统计/容量 + 展开箭头，可点收起/展开）+ 该层记忆卡片列表。 */
function buildMemoryTierBlock(layer, tier, view) {
    const collapsed = !memoryTierExpanded.has(layer.key);
    const block = document.createElement('div');
    block.className = 'memory-tier-block is-' + layer.key + (collapsed ? ' is-collapsed' : '');

    const tierHead = document.createElement('div');
    tierHead.className = 'memory-tier-head';
    tierHead.setAttribute('role', 'button');
    tierHead.tabIndex = 0;
    tierHead.title = '点一下收起 / 展开';
    tierHead.setAttribute('aria-expanded', String(!collapsed));
    const badge = document.createElement('span');
    badge.className = 'memory-tier-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = layer.icon;
    const name = document.createElement('span');
    name.className = 'memory-tier-name';
    name.textContent = layer.label + ' · ' + layer.sub;
    const stat = document.createElement('span');
    stat.className = 'memory-tier-stat';
    const capTokens = view.cfg[layer.key === 'hot' ? 'hot_tokens' : 'warm_tokens'];
    stat.textContent = layer.key === 'cold'
        ? `${tier.items.length} 条 · ${memoryTierFormatTokens(tier.tokens)} tokens（向量库归档）`
        : `${tier.items.length} 条 · ${memoryTierFormatTokens(tier.tokens)} / ${memoryTierFormatTokens(capTokens)} tokens`;
    tierHead.append(badge, name, stat);
    const chevron = document.createElement('span');
    chevron.className = 'memory-tier-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    tierHead.appendChild(chevron);
    tierHead.addEventListener('click', () => toggleMemoryTierExpand(layer.key));
    tierHead.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMemoryTierExpand(layer.key); }
    });
    block.appendChild(tierHead);

    const list = document.createElement('div');
    list.className = 'memory-list';
    for (const item of tier.items) {
        list.appendChild(buildMemoryTierCard(layer.key, item));
    }
    block.appendChild(list);
    return block;
}

/** 单条记忆卡片：分类徽标 + 文本 + meta（实体标签 / 日期 / token）。文本一律 textContent 防注入。 */
/** 日记分区：复用 diary.js 的卡片与详情弹窗，组头对接记忆页的对话筛选。 */
function renderMemoryDiaryView() {
    ensureMemoryConvFilter();
    const filterId = state.memoryFilterConvId || '';
    const diary = Array.isArray(state.memoryCore && state.memoryCore.diary) ? state.memoryCore.diary : [];
    const shown = (filterId ? diary.filter(e => ((e && e.conversationId) || '') === filterId) : diary)
        .slice()
        .sort((a, b) => diaryTimestamp(b) - diaryTimestamp(a));

    elements.memoryCount.textContent = filterId
        ? shown.length + ' / ' + diary.length + ' 篇日记'
        : diary.length + ' 篇日记';
    const emptyText = elements.memoryEmpty.querySelector('p');
    if (emptyText) {
        emptyText.textContent = filterId
            ? '这段对话还没有日记。'
            : '还没有日记，和伊蕾娜聊天或整理记忆后会出现在这里。';
    }
    elements.memoryEmpty.classList.toggle('hidden', shown.length > 0);
    elements.memoryEmpty.querySelector('div').textContent = '📖';
    elements.memoryBody.innerHTML = '';

    const groups = new Map();
    for (const entry of shown) {
        const id = (entry && entry.conversationId) || '';
        if (!groups.has(id)) groups.set(id, { id, entries: [] });
        groups.get(id).entries.push(entry);
    }
    for (const g of groups.values()) {
        const conv = g.id ? (state.conversations || []).find(c => c.id === g.id) : null;
        const title = conv ? (conv.title || '未命名对话') : ((g.entries[0] && g.entries[0].conversationTitle) || (g.id ? '已删除的对话' : '未归属的片段'));
        elements.memoryBody.appendChild(buildMemoryDiaryGroupHead(g.id, title, g.entries.length));
        for (const entry of g.entries) {
            elements.memoryBody.appendChild(createDiaryCard(entry, title));
        }
    }
    if (typeof syncConvFilterLabels === 'function') syncConvFilterLabels();
}

/** 日记分区的组头：点击按该对话筛选（对接 memoryFilterConvId，与分层视图共用同一筛选状态）。 */
function buildMemoryDiaryGroupHead(convId, title, count) {
    const head = document.createElement('div');
    head.className = 'memory-conv-head';
    const name = document.createElement('span');
    name.className = 'memory-conv-title';
    name.textContent = title;
    head.appendChild(name);
    const countBadge = document.createElement('span');
    countBadge.className = 'memory-conv-badge is-warm';
    countBadge.textContent = count + ' 条';
    head.appendChild(countBadge);
    if (convId) {
        head.tabIndex = 0;
        head.title = '只看这段对话的日记';
        head.addEventListener('click', () => {
            rememberMemoryConv(convId);
            renderMemoryPage();
            if (typeof renderFolderList === 'function') renderFolderList();
            if (typeof syncConvFilterLabels === 'function') syncConvFilterLabels();
        });
    }
    return head;
}

/** 页签切换：两个视图共用对话筛选状态与工具栏。 */
function setMemoryView(view) {
    if (memoryView === view) return;
    memoryView = view;
    const tiersBtn = document.getElementById('memoryViewTiers');
    const diaryBtn = document.getElementById('memoryViewDiary');
    if (tiersBtn) {
        tiersBtn.classList.toggle('is-active', view === 'tiers');
        tiersBtn.setAttribute('aria-selected', String(view === 'tiers'));
    }
    if (diaryBtn) {
        diaryBtn.classList.toggle('is-active', view === 'diary');
        diaryBtn.setAttribute('aria-selected', String(view === 'diary'));
    }
    renderMemoryPage();
}

function buildMemoryTierCard(tierKey, item) {
    const card = document.createElement('div');
    card.className = 'memory-item memory-tier-card is-' + tierKey;

    const meta = document.createElement('div');
    meta.className = 'memory-item-meta';
    const kind = document.createElement('span');
    kind.className = 'memory-kind-badge';
    kind.textContent = tierKey === 'hot' ? memoryTierRoleLabel(item.role) : (item.label || MEMORY_KIND_LABELS[item.kind] || '记忆');
    meta.appendChild(kind);
    if (tierKey === 'hot') {
        const scope = document.createElement('span');
        scope.className = 'memory-kind-scope';
        scope.textContent = '对话原文';
        meta.appendChild(scope);
    }
    if (item.date) {
        const date = document.createElement('span');
        date.className = 'memory-item-date';
        date.textContent = item.date;
        meta.appendChild(date);
    }
    if (Number.isFinite(item.tokens) && item.tokens > 0) {
        const tokens = document.createElement('span');
        tokens.className = 'memory-item-tokens';
        tokens.textContent = item.tokens + ' tok';
        meta.appendChild(tokens);
    }
    card.appendChild(meta);

    const text = document.createElement('div');
    text.className = 'memory-item-text';
    text.textContent = item.text;
    card.appendChild(text);

    if (Array.isArray(item.essences) && item.essences.length) {
        const tags = document.createElement('div');
        tags.className = 'memory-essence-tags';
        for (const tag of item.essences) {
            const chip = document.createElement('span');
            chip.className = 'memory-essence-tag';
            chip.textContent = tag;
            tags.appendChild(chip);
        }
        card.appendChild(tags);
    }

    // 日记并入记忆后，全文展开在这里：点卡片复用日记详情弹窗（diary.js 的 openDiaryDetail）
    if (item.kind === 'diary' && typeof openDiaryDetail === 'function') {
        card.classList.add('is-expandable');
        card.tabIndex = 0;
        card.title = '点击查看全文';
        const open = () => {
            const conv = item.convId ? (state.conversations || []).find(c => c.id === item.convId) : null;
            openDiaryDetail({
                content: item.text,
                essences: item.essences || [],
                date: item.date,
                timestamp: item.date,
                conversationId: item.convId || '',
                conversationTitle: conv ? (conv.title || '') : ''
            });
        };
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
    }
    return card;
}

/* —— 分层设置弹层：右上角按钮打开。容量以模型上下文为总标尺，双点滑块做三段分配 ——
   左点 = 空闲|温边界，右点 = 温|热边界；两点的 token 值持久化，保存后记忆页分区实时重排。 */

let memoryTierSettingsEl = null;
/** 滑块拖动中的草稿配置（拖动实时预览，pointerup 才落盘）。 */
let memoryTierDraft = null;

/** 层说明一行：bold 片段加粗（<b>），其余走文本节点 —— 说明区没有别的解释文字，重点要能扫出来。 */
function buildMemoryTierHint(segments) {
    const p = document.createElement('p');
    p.className = 'memory-tier-hint';
    for (const seg of segments) {
        if (seg.bold) {
            const b = document.createElement('b');
            b.textContent = seg.t;
            p.appendChild(b);
        } else {
            p.appendChild(document.createTextNode(seg.t));
        }
    }
    return p;
}

function openMemoryTierSettings() {
    if (!memoryTierSettingsEl) {
        memoryTierSettingsEl = document.createElement('div');
        memoryTierSettingsEl.id = 'memoryTierSettingsOverlay';
        memoryTierSettingsEl.className = 'fixed inset-0 z-50 hidden items-center justify-center p-4 modal-overlay';
        memoryTierSettingsEl.innerHTML =
            '<div class="modal-panel w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden animate-modal-pop">'
              + '<div class="flex items-center gap-3 px-6 py-4 border-b border-white/60 flex-shrink-0">'
                + '<div class="text-base font-bold text-ink">记忆分层设置</div>'
                + '<button id="memoryTierSettingsClose" class="ml-auto p-1.5 rounded-lg hover:bg-white/60 transition-colors" type="button" aria-label="关闭">'
                  + '<svg class="w-4 h-4 text-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>'
                + '</button>'
              + '</div>'
              + '<div id="memoryTierSettingsBody" class="flex-1 overflow-y-auto scroll-soft px-6 py-4"></div>'
              + '<div class="px-6 py-4 border-t border-white/60 flex items-center gap-3 flex-shrink-0">'
                + '<button type="button" id="memoryTierSettingsReset" class="memory-tier-btn is-ghost">恢复默认</button>'
                + '<button type="button" id="memoryTierSettingsSave" class="memory-tier-btn is-primary ml-auto">保存</button>'
              + '</div>'
            + '</div>';
        document.body.appendChild(memoryTierSettingsEl);
        memoryTierSettingsEl.querySelector('#memoryTierSettingsClose').addEventListener('click', closeMemoryTierSettings);
        memoryTierSettingsEl.addEventListener('click', (e) => {
            if (e.target === memoryTierSettingsEl) closeMemoryTierSettings();
        });
        memoryTierSettingsEl.querySelector('#memoryTierSettingsReset').addEventListener('click', () => {
            memoryTierDraft = { ...MEMORY_TIERS_DEFAULT };
            renderMemoryTierSlider();
        });
        memoryTierSettingsEl.querySelector('#memoryTierSettingsSave').addEventListener('click', saveMemoryTierSettings);
    }

    const body = memoryTierSettingsEl.querySelector('#memoryTierSettingsBody');
    body.innerHTML = '';
    const enabled = memoryCompressionEnabled();

    // —— 模型上下文档位 ——
    const ctxRow = document.createElement('div');
    ctxRow.className = 'memory-tier-ctx-row';
    const ctxLabel = document.createElement('span');
    ctxLabel.className = 'memory-tier-ctx-label';
    ctxLabel.textContent = '模型上下文';
    const ctxSelect = document.createElement('select');
    ctxSelect.id = 'memoryTierCtxSelect';
    ctxSelect.className = 'memory-tier-ctx-select';
    ctxSelect.setAttribute('aria-label', '模型上下文长度');
    const cfg = memoryTierDraft || loadMemoryTierConfig();
    const presetHit = MEMORY_CONTEXT_PRESETS.find(p => p.value === cfg.model_context_tokens);
    for (const p of MEMORY_CONTEXT_PRESETS) {
        const opt = document.createElement('option');
        opt.value = String(p.value);
        opt.textContent = p.label;
        ctxSelect.appendChild(opt);
    }
    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = '自定义';
    ctxSelect.appendChild(customOpt);
    const ctxCustom = document.createElement('input');
    ctxCustom.type = 'number';
    ctxCustom.id = 'memoryTierCtxCustom';
    ctxCustom.className = 'memory-tier-input';
    ctxCustom.min = '1000';
    ctxCustom.step = '1000';
    ctxCustom.inputMode = 'numeric';
    ctxCustom.style.display = presetHit ? 'none' : '';
    ctxCustom.value = String(cfg.model_context_tokens);
    ctxCustom.setAttribute('aria-label', '自定义上下文长度');
    if (!presetHit) ctxSelect.value = 'custom';
    const ctxUnit = document.createElement('span');
    ctxUnit.className = 'memory-tier-unit';
    ctxUnit.textContent = 'tokens';
    ctxSelect.addEventListener('change', () => {
        if (ctxSelect.value === 'custom') {
            ctxCustom.style.display = '';
            return;
        }
        ctxCustom.style.display = 'none';
        memoryTierDraft = rescaleMemoryTierDraft(Number(ctxSelect.value));
        renderMemoryTierSlider();
    });
    ctxCustom.addEventListener('change', () => {
        const n = Math.floor(Number(ctxCustom.value));
        if (!Number.isFinite(n) || n < 1000) return;
        memoryTierDraft = rescaleMemoryTierDraft(n);
        renderMemoryTierSlider();
    });
    ctxRow.append(ctxLabel, ctxSelect, ctxCustom, ctxUnit);
    body.appendChild(ctxRow);

    // —— 双点滑块 ——
    const slider = document.createElement('div');
    slider.className = 'memory-tier-slider';
    slider.id = 'memoryTierSlider';
    slider.innerHTML =
        '<div class="mts-track">'
          + '<div class="mts-seg is-idle"></div>'
          + '<div class="mts-seg is-warm"></div>'
          + '<div class="mts-seg is-hot"></div>'
          + '<div class="mts-handle is-idle" data-edge="idle" role="slider" tabindex="0" aria-label="空闲与温区分界"></div>'
          + '<div class="mts-handle is-hot" data-edge="warm" role="slider" tabindex="0" aria-label="温区与热区分界"></div>'
        + '</div>'
        + '<div class="mts-scale"><span>0</span><span class="mts-scale-total"></span></div>'
        + '<div class="mts-legend">'
          + '<span class="is-idle">🆓 空闲 <b></b></span>'
          + '<span class="is-warm">🌤️ 温区 <b></b></span>'
          + '<span class="is-hot">🔥 热区 <b></b></span>'
        + '</div>';
    body.appendChild(slider);

    const hints = document.createElement('div');
    hints.className = 'memory-tier-hints';
    // 说明区是弹层里唯一的解释文字：重点加粗便于扫读；未打开记忆日记时先给当前状态，再讲通用规则
    if (!enabled) {
        hints.appendChild(buildMemoryTierHint([
            { t: '当前未在「设置 → 能力 → 记忆」打开「记忆日记」：' },
            { t: '不做记忆压缩，温区不启用，分配的温记忆容量已并入热区', bold: true },
            { t: '。' }
        ]));
    }
    for (const segments of [
        [
            { t: '🆓 空闲（左段）：留给模型输出、工具调用结果和召回注入的空间；' },
            { t: '低于 200k 时，长回复或大工具结果可能撑爆上下文报错', bold: true },
            { t: '。' }
        ],
        [
            { t: '🌤️ 温区（中段）：整理出的压缩记忆（日记、约定、偏好等摘要），按相关度注入对话；超出的最旧摘要下沉到冷区。温区依赖记忆压缩 —— ' },
            { t: '要先在「设置 → 能力 → 记忆」打开「记忆日记」，没打开时温区不启用', bold: true },
            { t: '，分配的温记忆容量并入热区。' }
        ],
        [
            { t: '🔥 热区（右段）：对话现场的完整原文，' },
            { t: '每个对话保留不超过该容量的最近原文', bold: true },
            { t: '；容量随模型上下文等比伸缩。' }
        ]
    ]) {
        hints.appendChild(buildMemoryTierHint(segments));
    }
    body.appendChild(hints);

    bindMemoryTierSlider(slider);
    memoryTierDraft = { ...cfg };
    renderMemoryTierSlider();

    memoryTierSettingsEl.classList.remove('hidden');
    memoryTierSettingsEl.classList.add('flex');
}

/** 切换总标尺时保持三段比例。 */
function rescaleMemoryTierDraft(total) {
    const old = memoryTierDraft || loadMemoryTierConfig();
    const oldTotal = Math.max(1, old.model_context_tokens);
    return normalizeMemoryTierConfig({
        model_context_tokens: total,
        idle_tokens: Math.round(old.idle_tokens * total / oldTotal),
        warm_tokens: Math.round(old.warm_tokens * total / oldTotal)
    });
}

/** 把草稿配置画到滑块上：三段宽度、两个手柄位置、图例数字、标尺总数。 */
function renderMemoryTierSlider() {
    if (!memoryTierSettingsEl) return;
    const eff = memoryTierEffective(memoryTierDraft || loadMemoryTierConfig());
    const cfg = eff;
    const total = cfg.model_context_tokens;
    const warmEnd = cfg.idle_tokens + cfg.warm_tokens;
    const pct = (n) => (n / total) * 100;
    const segs = {
        idle: memoryTierSettingsEl.querySelector('.mts-seg.is-idle'),
        warm: memoryTierSettingsEl.querySelector('.mts-seg.is-warm'),
        hot: memoryTierSettingsEl.querySelector('.mts-seg.is-hot')
    };
    segs.idle.style.left = '0%';
    segs.idle.style.width = pct(cfg.idle_tokens) + '%';
    segs.warm.style.left = pct(cfg.idle_tokens) + '%';
    segs.warm.style.width = pct(cfg.warm_tokens) + '%';
    segs.hot.style.left = pct(warmEnd) + '%';
    segs.hot.style.width = pct(total - warmEnd) + '%';
    const idleHandle = memoryTierSettingsEl.querySelector('.mts-handle.is-idle');
    const hotHandle = memoryTierSettingsEl.querySelector('.mts-handle.is-hot');
    idleHandle.style.left = pct(cfg.idle_tokens) + '%';
    hotHandle.style.left = pct(warmEnd) + '%';
    idleHandle.setAttribute('aria-valuenow', String(cfg.idle_tokens));
    hotHandle.setAttribute('aria-valuenow', String(warmEnd));
    const legend = memoryTierSettingsEl.querySelectorAll('.mts-legend b');
    legend[0].textContent = memoryTierFormatTokens(cfg.idle_tokens);
    legend[1].textContent = cfg.compressionEnabled ? memoryTierFormatTokens(cfg.warm_tokens) : '已并入热区';
    legend[2].textContent = memoryTierFormatTokens(cfg.hot_tokens);
    // 未开启记忆日记：温区不可用，右手柄（温|热边界）随之隐藏
    const hotHandleEl = memoryTierSettingsEl.querySelector('.mts-handle.is-hot');
    if (hotHandleEl) hotHandleEl.style.display = cfg.compressionEnabled ? '' : 'none';
    memoryTierSettingsEl.querySelector('.mts-scale-total').textContent =
        memoryTierFormatTokens(total) + '（模型上下文 ' + total.toLocaleString('en-US') + ' tokens，其余为空闲预留）';
}

/** 拖动交互：手柄捕获指针，移动时更新草稿并实时重画；松手落盘并重排记忆页。 */
function bindMemoryTierSlider(slider) {
    const track = slider.querySelector('.mts-track');
    let dragging = null; // 'cold' | 'warm'

    function applyPointer(clientX) {
        const rect = track.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        const total = memoryTierDraft.model_context_tokens;
        const value = Math.round(ratio * total / 100) * 100; // 100-token 粒度，拖动手感顺滑
        if (dragging === 'idle') {
            memoryTierDraft = normalizeMemoryTierConfig({
                model_context_tokens: total,
                idle_tokens: value,
                warm_tokens: memoryTierDraft.warm_tokens
            });
        } else {
            const warmEnd = value;
            memoryTierDraft = normalizeMemoryTierConfig({
                model_context_tokens: total,
                idle_tokens: memoryTierDraft.idle_tokens,
                warm_tokens: Math.max(100, warmEnd - memoryTierDraft.idle_tokens)
            });
        }
        renderMemoryTierSlider();
    }

    for (const handle of track.querySelectorAll('.mts-handle')) {
        handle.addEventListener('pointerdown', (e) => {
            dragging = handle.dataset.edge === 'idle' ? 'idle' : 'warm';
            // 指针捕获失败（自动化事件/异常环境）不中断拖动，move 监听仍在本手柄上
            try {
                handle.setPointerCapture(e.pointerId);
            } catch (err) { /* 无有效指针时忽略 */ }
            e.preventDefault();
        });
        handle.addEventListener('pointermove', (e) => {
            if (dragging && e.buttons) applyPointer(e.clientX);
        });
        handle.addEventListener('pointerup', () => {
            if (!dragging) return;
            dragging = null;
            saveMemoryTierConfig(memoryTierDraft);
            renderMemoryPage();
        });
        handle.addEventListener('keydown', (e) => {
            // 键盘可达：左右箭头按 1% 总量微调
            const step = Math.round(memoryTierDraft.model_context_tokens * 0.01);
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const dir = e.key === 'ArrowLeft' ? -1 : 1;
            if (handle.dataset.edge === 'idle') {
                memoryTierDraft = normalizeMemoryTierConfig({
                    model_context_tokens: memoryTierDraft.model_context_tokens,
                    idle_tokens: memoryTierDraft.idle_tokens + dir * step,
                    warm_tokens: memoryTierDraft.warm_tokens
                });
            } else {
                memoryTierDraft = normalizeMemoryTierConfig({
                    model_context_tokens: memoryTierDraft.model_context_tokens,
                    idle_tokens: memoryTierDraft.idle_tokens,
                    warm_tokens: memoryTierDraft.warm_tokens + dir * step
                });
            }
            renderMemoryTierSlider();
            e.preventDefault();
        });
    }
}

function closeMemoryTierSettings() {
    if (!memoryTierSettingsEl) return;
    memoryTierSettingsEl.classList.add('hidden');
    memoryTierSettingsEl.classList.remove('flex');
    memoryTierDraft = null;
}

function saveMemoryTierSettings() {
    if (!memoryTierDraft) memoryTierDraft = loadMemoryTierConfig();
    saveMemoryTierConfig(memoryTierDraft);
    closeMemoryTierSettings();
    renderMemoryPage();
}

function enterMemoryPage() {
    memoryTierExpanded.clear(); // 每次进记忆页回到默认收起：三层是索引视图，展开态不跨访问保留
    state.memoryPageMode = true;
    state.notesMode = false;
    state.diaryMode = false;
    elements.initialState.classList.add('hidden');
    elements.conversationHistory.classList.add('hidden');
    elements.inputBar.classList.add('hidden');
    elements.notesPage.classList.add('hidden');
    elements.diaryPage.classList.add('hidden');
    elements.floatingMic.classList.add('hidden');
    elements.memoryPage.classList.remove('hidden');
    elements.currentConversationTitle.textContent = '记忆';
    renderMemoryPage();
    setRailActive('memory');
}

function exitMemoryPage() {
    state.memoryPageMode = false;
    closeMemoryTierSettings();
    elements.memoryPage.classList.add('hidden');
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    if (conv) {
        updateCurrentConversationTitle();
        elements.conversationHistory.classList.remove('hidden');
        elements.inputBar.classList.remove('hidden');
    } else {
        showInitialState();
    }
    syncRailActive();
}
