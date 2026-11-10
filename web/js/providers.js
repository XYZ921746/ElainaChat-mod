// 模型 / 搜索 / TTS / 视觉 Provider 设置：表单填充、搜索源字段、连接测试、清空密钥。
'use strict';

// 详情页里协议字段的显隐跟「当前编辑的提供商」的协议走；列表态没有详情，全部隐藏。
function updateAsrProviderUI() {
    const provider = (typeof asrProviderEditingId !== 'undefined' && asrProviderEditingId)
        ? findAsrProviderById(asrProviderEditingId) : null;
    const apiFormat = provider ? provider.apiFormat : '';
    const dashscope = document.getElementById('dashscopeAsrFields');
    const mimoFields = document.getElementById('mimoAsrFields');
    if (dashscope) dashscope.classList.toggle('hidden', apiFormat !== 'aliyun');
    if (mimoFields) mimoFields.classList.toggle('hidden', apiFormat !== 'mimo');
}

function updateTtsProviderUI() {
    const provider = (typeof ttsProviderEditingId !== 'undefined' && ttsProviderEditingId)
        ? findTtsProviderById(ttsProviderEditingId) : null;
    const apiFormat = provider ? provider.apiFormat : '';
    elements.mimoTtsFields?.classList.toggle('hidden', apiFormat !== 'mimo');
    elements.openaiTtsFields?.classList.toggle('hidden', apiFormat !== 'openai-tts');
    elements.minimaxTtsFields?.classList.toggle('hidden', apiFormat !== 'minimax');
    elements.dashscopeTtsFields?.classList.toggle('hidden', apiFormat !== 'dashscope');
    updateMimoTtsModelUI();
}

// MiMo TTS 三个模型用的字段互斥：预置音色 / 音色描述（必填）/ 参考音频样本（必填）。
function updateMimoTtsModelUI() {
    const model = document.getElementById('settingMimoTtsModel')?.value || 'mimo-v2.5-tts';
    document.getElementById('mimoTtsVoiceFields')?.classList.toggle('hidden', model !== 'mimo-v2.5-tts');
    document.getElementById('mimoTtsVoiceDesignFields')?.classList.toggle('hidden', model !== 'mimo-v2.5-tts-voicedesign');
    document.getElementById('mimoTtsVoiceCloneFields')?.classList.toggle('hidden', model !== 'mimo-v2.5-tts-voiceclone');
    // 切到 voiceclone 且没有样本时自动补上软件自带的日语样本，开箱即用。
    if (model === 'mimo-v2.5-tts-voiceclone') void ensureBuiltinMimoCloneSample();
}

// 对话提供商的编辑态：'' = 右栏显示「默认模型与回退」；某 id = 右栏显示该提供商的卡片。
let chatProviderEditingId = '';

function resetChatProviderEditing() {
    chatProviderEditingId = '';
}

function chatModelKey(pair) {
    return String(pair && pair.providerId || '') + '|' + String(pair && pair.model || '');
}

function parseChatModelKey(key) {
    const raw = String(key || '');
    const i = raw.indexOf('|');
    if (i < 0) return { providerId: '', model: '' };
    return { providerId: raw.slice(0, i), model: raw.slice(i + 1) };
}

function chatModelLabel(provider, model) {
    return ((provider && (provider.name || '').trim()) || '未命名') + ' · ' + String(model || '未选模型');
}

/** 一级两个下拉的选项清单：每个提供商 × 其勾选的模型。 */
function chatModelPairOptions(providers) {
    const out = [];
    providers.forEach((p) => {
        const selected = Array.isArray(p.selectedModels) ? p.selectedModels : [];
        selected.forEach((m) => out.push({ key: chatModelKey({ providerId: p.id, model: m }), providerId: p.id, model: m, label: chatModelLabel(p, m) }));
    });
    return out;
}

function fillChatProviderSelect(select, pairs, currentKey, emptyLabel) {
    if (!select) return;
    select.innerHTML = '';
    const option = (value, text) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        select.appendChild(o);
    };
    if (emptyLabel) option('', emptyLabel);
    if (!pairs.length && !emptyLabel) option('', '尚无可选模型（点「编辑」添加提供商并勾选模型）');
    pairs.forEach((p) => option(p.key, p.label));
    select.value = pairs.some((p) => p.key === currentKey) ? currentKey : '';
    if (select.selectedIndex < 0 && select.options.length) select.selectedIndex = 0;
    return select.value;
}

/** 回退链的一行：序号 + 「提供商 · 模型」 + 上移/下移/移除。数组顺序即回退顺序。 */
function buildFallbackChainRow(key, label, index, total) {
    const row = document.createElement('div');
    row.className = 'fbc-row';
    row.setAttribute('data-key', key);
    row.innerHTML = `
        <span class="fbc-order">${index + 1}</span>
        <span class="fbc-copy">${escapeHtml(label)}</span>
        <button type="button" class="fbc-up btn-secondary text-xs flex-none" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="fbc-down btn-secondary text-xs flex-none" title="下移" ${index === total - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="fbc-remove btn-secondary text-xs flex-none" title="从回退链移除">✕</button>`;
    return row;
}

function buildChatProviderBlock(p) {
    const preset = CHAT_API_FORMATS[p.apiFormat] || CHAT_API_FORMATS['openai-compatible'];
    const block = document.createElement('div');
    block.className = 'chat-provider-card';
    block.setAttribute('data-provider-id', p.id || '');
    const formatLabel = preset.label || 'OpenAI 兼容';
    const selectedCount = Array.isArray(p.selectedModels) ? p.selectedModels.length : 0;
    block.innerHTML = `
        <div class="model-provider-head">
            ${provIconHtml(p.id, p.name)}
            <div class="model-provider-head-copy">
                <div class="model-provider-name">${escapeHtml(p.name || '未命名')}</div>
                <div class="model-provider-chips">
                    <span class="model-provider-chip is-accent">对话</span>
                    <span class="model-provider-chip">${escapeHtml(formatLabel)}</span>
                    <span class="model-provider-chip">${selectedCount} 个模型</span>
                </div>
            </div>
        </div>
        <div class="cpc-grid">
            <div class="is-full">
                <label class="text-xs text-dim mb-1 block">名称</label>
                <input class="cpc-name modal-input text-sm" value="${escapeHtml(p.name || '')}" placeholder="提供商名称（如 DeepSeek / 硅基流动）">
            </div>
            <input class="cpc-format" type="hidden" value="${escapeHtml(p.apiFormat || 'openai-compatible')}">
            <div class="is-full">
                <label class="text-xs text-dim mb-1 block">API Base URL</label>
                <input class="cpc-baseurl modal-input text-sm" type="url" inputmode="url" value="${escapeHtml(p.baseUrl || '')}" placeholder="${escapeHtml(preset.defaultBaseUrl)}">
            </div>
            <div class="is-full">
                <label class="text-xs text-dim mb-1 block">API Key（本地服务可留空）</label>
                <input class="cpc-key modal-input text-sm" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" value="${escapeHtml((state.settings.chatProviderKeys || {})[p.id] || '')}" placeholder="sk-...（只保存在本机）">
            </div>
        </div>
        <div class="cpc-models">
            <div class="cpc-models-head">
                <div>
                    <b class="cpc-models-title">已配置模型</b>
                    <span class="cpc-models-sub">加入后会出现在默认模型与失败回退的选择里</span>
                </div>
            </div>
            <div class="cpc-configured-list"></div>
            <div class="cpc-available-head">
                <b class="cpc-available-title">可选模型</b>
                <div class="cpc-model-tools">
                    <button type="button" class="cpc-fetch btn-secondary text-xs flex-none" title="从该提供商的 API 地址拉取可用模型列表">获取模型</button>
                    <input class="cpc-manual-model modal-input text-sm flex-1 min-w-0" type="text" autocomplete="off" placeholder="输入即筛选模型；完整模型名可点「添加」加入">
                    <button type="button" class="cpc-add-model btn-secondary text-xs flex-none">＋ 添加</button>
                </div>
            </div>
            <div class="cpc-available-list"></div>
        </div>
        <div class="cpc-danger-zone">
            <button type="button" class="cpc-delete btn-secondary text-xs">删除此提供商</button>
        </div>`;
    renderChatProviderModels(block, p);
    // 手动输入框兼当搜索：输入就过滤下面的勾选列表，不必等"获取模型"后自己找。
    const manual = block.querySelector('.cpc-manual-model');
    if (manual) manual.addEventListener('input', () => filterChatProviderModels(block, manual.value));
    const nameInput = block.querySelector('.cpc-name');
    if (nameInput) nameInput.addEventListener('input', () => {
        const label = block.querySelector('.model-provider-name');
        if (label) label.textContent = nameInput.value.trim() || '未命名';
    });
    return block;
}

/** 按子串过滤可选模型列表；已配置模型不受搜索影响。 */
function filterChatProviderModels(block, query) {
    const box = block && block.querySelector('.cpc-available-list');
    if (!box) return;
    const q = String(query || '').trim().toLowerCase();
    let shown = 0;
    box.querySelectorAll('.cpc-available-row').forEach((row) => {
        const name = String(row.getAttribute('data-model-name') || '').toLowerCase();
        const hit = !q || name.includes(q);
        row.style.display = hit ? '' : 'none';
        if (hit) shown += 1;
    });
    const empty = box.querySelector('.cpc-filter-empty');
    if (empty) empty.style.display = (q && shown === 0) ? '' : 'none';
}

// 已配置与可选分两段：加入一个模型只是把它从下面搬到上面，不在同一串 chip 里既勾选又取消。
function renderChatProviderModels(block, p) {
    const configuredBox = block.querySelector('.cpc-configured-list');
    const availableBox = block.querySelector('.cpc-available-list');
    if (!configuredBox || !availableBox) return;
    const selected = Array.isArray(p.selectedModels) ? p.selectedModels.slice() : [];
    // 已配置但不在候选清单里的模型也要保留（迁移来的老勾选没有候选清单）。
    const models = Array.from(new Set([
        ...(Array.isArray(p.models) ? p.models : []),
        ...selected
    ]));
    configuredBox.innerHTML = selected.length ? selected.map((m) => '<div class="cpc-configured-row" data-model="' + escapeHtml(m) + '">'
        + '<span class="cpc-configured-name" title="' + escapeHtml(m) + '">' + escapeHtml(m) + '</span>'
        + '<div class="cpc-configured-actions">'
        + '<button type="button" class="btn-secondary text-xs cpc-test-model" data-cpc-model="' + escapeHtml(m) + '">检测</button>'
        + '<button type="button" class="btn-secondary text-xs cpc-remove-model" data-cpc-model="' + escapeHtml(m) + '">移除</button>'
        + '</div></div>').join('') : '<p class="cpc-models-empty">还没有已配置模型，从下方可选模型里点「＋」加入。</p>';

    const available = models.filter((m) => selected.indexOf(m) === -1);
    availableBox.innerHTML = available.length ? available.map((m) => '<div class="cpc-available-row" data-model-name="' + escapeHtml(String(m).toLowerCase()) + '">'
        + '<span class="cpc-available-name" title="' + escapeHtml(m) + '">' + escapeHtml(m) + '</span>'
        + '<button type="button" class="cpc-enable-model" data-cpc-model="' + escapeHtml(m) + '" title="加入已配置模型" aria-label="加入已配置模型">＋</button>'
        + '</div>').join('')
        : '<p class="cpc-models-empty">' + (models.length ? '所有模型都已加入。' : '还没有候选模型：点「获取模型」拉取，或手动输入添加。') + '</p>';
    // 「输入即筛选」筛空时的说明；平时不占位。
    const none = document.createElement('p');
    none.className = 'cpc-filter-empty cpc-models-empty';
    none.textContent = '没有匹配的模型';
    none.style.display = 'none';
    availableBox.appendChild(none);
}

/** 对话类渲染入口：提供商列表（左栏）+ 提供商卡片（右栏编辑态）。
 *  默认模型/回退/图片转述属于使用配置，在「模型 → 使用偏好」（renderChatBindings 渲染）。 */
function renderChatProviderSettings() {
    renderChatProviderList();
    renderChatProviderCard();
    renderChatBindings();
}

function renderChatProviderList() {
    const providers = Array.isArray(state.settings.chatProviders) ? state.settings.chatProviders : [];
    fillProvList(
        document.getElementById('chatProviderList'),
        providers.map((p) => {
            const format = CHAT_API_FORMATS[p.apiFormat] || CHAT_API_FORMATS['openai-compatible'];
            const firstModel = (Array.isArray(p.selectedModels) && p.selectedModels[0])
                || (Array.isArray(p.models) && p.models[0]) || '未选模型';
            const isDefault = (state.settings.defaultChatModel || {}).providerId === p.id;
            return {
                id: p.id,
                name: p.name || '未命名',
                desc: (isDefault ? '● 默认 · ' : '') + firstModel + ' · ' + (format.label || 'OpenAI 兼容'),
                active: p.id === chatProviderEditingId,
                onDelete: (id2) => { void deleteChatProviderById(id2); }
            };
        }),
        (id) => openChatProviderDetail(id)
    );
}

/** 「能力 → 对话模型选择」分区的回填：默认模型 / 失败回退 / 图片转述。下拉候选与链条里的失效对在这里收敛。 */
function renderChatBindings() {
    const s = state.settings;
    const providers = Array.isArray(s.chatProviders) ? s.chatProviders : [];
    if (!Array.isArray(s.fallbackChatModels)) s.fallbackChatModels = [];
    const pairs = chatModelPairOptions(providers);
    const defaultKey = fillChatProviderSelect(
        document.getElementById('defaultChatModelSelect'),
        pairs,
        chatModelKey(s.defaultChatModel)
    );
    const chosen = pairs.find((p) => p.key === defaultKey) || null;
    s.defaultChatModel = chosen
        ? { providerId: chosen.providerId, model: chosen.model }
        : { providerId: '', model: '' };
    const chain = (Array.isArray(s.fallbackChatModels) ? s.fallbackChatModels : [])
        .filter((pair) => pairs.some((p) => p.key === chatModelKey(pair)));
    s.fallbackChatModels = chain;
    const defaultKeyStr = chatModelKey(s.defaultChatModel);
    const chainBox = document.getElementById('fallbackChainList');
    chainBox.innerHTML = '';
    if (!chain.length) {
        const empty = document.createElement('p');
        empty.className = 'text-[11px] text-dim';
        empty.textContent = '未设置回退。默认模型失败时将直接报错。';
        chainBox.appendChild(empty);
    } else {
        chain.forEach((pair, i) => chainBox.appendChild(
            buildFallbackChainRow(chatModelKey(pair), chatModelLabel(chatProviderById(pair.providerId), pair.model), i, chain.length)
        ));
    }
    // 摘要只显示第一个回退模型；第 2 个及之后的在 details 编辑里看（与 AstrBot 的紧凑行一致）
    const firstEl = document.getElementById('fallbackChainFirst');
    if (firstEl) firstEl.textContent = chain.length ? chatModelLabel(chatProviderById(chain[0].providerId), chain[0].model) : '未设置回退';
    const moreEl = document.getElementById('fallbackChainMore');
    if (moreEl) moreEl.textContent = chain.length > 1 ? '＋' + (chain.length - 1) + ' 个' : '';
    const addSel = document.getElementById('fallbackAddSelect');
    const addBtn = document.getElementById('fallbackAddBtn');
    const candidates = pairs.filter((p) => p.key !== defaultKeyStr && !chain.some((c) => chatModelKey(c) === p.key));
    addSel.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = candidates.length ? '添加回退模型…' : '没有可添加的模型';
    addSel.appendChild(placeholder);
    candidates.forEach((p) => {
        const o = document.createElement('option');
        o.value = p.key;
        o.textContent = p.label;
        addSel.appendChild(o);
    });
    addSel.value = '';
    addSel.disabled = !candidates.length;
    addBtn.disabled = !candidates.length;
    fillVisionModelPairOptions();
    updateVisionMainModelHint();
}

/** 右栏编辑视图：当前编辑中的提供商卡片；没在编辑时保持容器为空（节点显隐由 syncModelPageVisibility 决定）。 */
function renderChatProviderCard() {
    const box = document.getElementById('chatProviderCard');
    const title = document.getElementById('chatCardTitle');
    if (!box) return;
    const prov = chatProviderEditingId ? findChatProviderById(chatProviderEditingId) : null;
    box.innerHTML = '';
    if (!prov) return;
    if (title) title.textContent = prov.name || '未命名';
    box.appendChild(buildChatProviderBlock(prov));
}

// ==================== 「列表 → 详情」通用外壳 ====================
// 对话 / 语音输出 / 语音输入 / 图片转述都是"先选一个服务商、再配置它"，
//   共用同一套列表行与详情页，免得每个分栏各长一套长得不一样的控件。

const PROV_TONES = ['tone-a', 'tone-b', 'tone-c', 'tone-d', 'tone-e', 'tone-f'];

/** 服务商图标：名称首字 + 按 id 稳定取一个色（没有品牌素材，用首字方块当图标）。 */
function provIconHtml(id, name) {
    const raw = String(name || '').trim();
    const m = raw.match(/[\p{L}\p{N}]/u);
    const ch = m ? m[0].toUpperCase() : '＋';
    const seed = String(id || raw || '?');
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 997;
    return '<span class="prov-icon ' + PROV_TONES[h % PROV_TONES.length] + '">' + escapeHtml(ch) + '</span>';
}

function buildProvRow(opts) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'prov-row'
        + (opts.active ? ' is-active' : '')
        + (opts.disabled ? ' is-disabled' : '')
        + (opts.isNew ? ' is-new' : '');
    row.disabled = !!opts.disabled;
    if (opts.id) row.setAttribute('data-provider-id', opts.id);
    row.innerHTML = provIconHtml(opts.id, opts.isNew ? '' : opts.name)
        + '<span class="prov-copy"><span class="prov-name">' + escapeHtml(opts.name) + '</span>'
        + (opts.desc ? '<span class="prov-desc">' + escapeHtml(opts.desc) + '</span>' : '')
        + '</span>'
        + '<span class="prov-chev" aria-hidden="true">›</span>'
        + (opts.onDelete
            ? '<span class="prov-del" role="button" tabindex="-1" title="删除这个提供商" aria-label="删除这个提供商">'
                + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2"/></svg>'
                + '</span>'
            : '');
    if (!opts.disabled && typeof opts.onPick === 'function') {
        row.addEventListener('click', () => opts.onPick(opts.id));
    }
    if (opts.onDelete) {
        // 行内删除不触发行选中：与 AstrBot 的 @click.stop 同一约定
        row.querySelector('.prov-del')?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            opts.onDelete(opts.id);
        });
    }
    return row;
}

/** items: [{ id, name, active, disabled }]；newLabel 有值时在最后追加「新建」一行。 */
function fillProvList(box, items, onPick, newLabel, onNew) {
    if (!box) return;
    box.innerHTML = '';
    if (!items.length && !newLabel) {
        const empty = document.createElement('p');
        empty.className = 'prov-empty';
        empty.textContent = '还没有添加';
        box.appendChild(empty);
    }
    items.forEach((it) => box.appendChild(buildProvRow({ ...it, onPick })));
    if (newLabel) {
        box.appendChild(buildProvRow({ isNew: true, name: newLabel, onPick: () => onNew() }));
    }
}

// ---------- 文字转语音 / 语音转文字 / 嵌入 / 重排序：动态提供商「列表 → 详情」 ----------
// 与对话模型同一套契约：每类一个提供商数组 + 默认指向；预设协议只在「＋新增」时作为模板出现，
// 列表本身只显示已添加的实例。Key 统一走 getProviderSecret / setProviderSecret（chatProviderKeys 通道）。

let ttsProviderDetailOpen = false;
let ttsProviderEditingId = '';
let asrProviderDetailOpen = false;
let asrProviderEditingId = '';
let embeddingProviderDetailOpen = false;
let embeddingProviderEditingId = '';
let rerankProviderDetailOpen = false;
let rerankProviderEditingId = '';

function findTtsProviderById(id) {
    return (Array.isArray(state.settings.ttsProviders) ? state.settings.ttsProviders : [])
        .find((p) => p.id === id) || null;
}

function findAsrProviderById(id) {
    return (Array.isArray(state.settings.asrProviders) ? state.settings.asrProviders : [])
        .find((p) => p.id === id) || null;
}

function findEmbeddingProviderById(id) {
    return (Array.isArray(state.settings.embeddingProviders) ? state.settings.embeddingProviders : [])
        .find((p) => p.id === id) || null;
}

function findRerankProviderById(id) {
    return (Array.isArray(state.settings.rerankProviders) ? state.settings.rerankProviders : [])
        .find((p) => p.id === id) || null;
}

function ttsPresetFor(provider) {
    return TTS_PROTOCOL_PRESETS.find((x) => x.id === (provider ? provider.apiFormat : '')) || null;
}

function asrPresetFor(provider) {
    return ASR_PROTOCOL_PRESETS.find((x) => x.id === (provider ? provider.apiFormat : '')) || null;
}

function newProviderId(prefix) {
    return 'prov_' + prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// ---------- 协议自动识别 ----------
// 用户只填地址 / Key / 模型，协议由探测结果决定：
//   对话类对 /chat/completions、/responses、/messages 逐一发一条 1 token 的探测请求，2xx 即命中（401/403 = 端点存在但 Key 不对）；
//   TTS/ASR 按地址域名即时识别（未知地址回落通用协议）；嵌入/重排序只有一种协议，无需检测。

// 对话类协议探测：按常见度排序逐个端点试；网络层失败与 404 都换下一个候选。
async function detectChatProtocolForCreate(baseUrl, apiKey, model) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    const key = String(apiKey || '').trim();
    const bearer = key ? { Authorization: 'Bearer ' + key } : {};
    const candidates = [
        { id: 'openai-compatible', label: 'OpenAI 兼容', url: base + '/chat/completions', headers: { ...bearer, 'Content-Type': 'application/json' }, body: { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 } },
        { id: 'openai-responses', label: 'OpenAI 官方', url: base + '/responses', headers: { ...bearer, 'Content-Type': 'application/json' }, body: { model, input: 'hi', max_output_tokens: 16 } },
        { id: 'anthropic', label: 'Anthropic Claude', url: base + '/messages', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] } }
    ];
    for (const c of candidates) {
        try {
            const result = await postJsonFromDevice(c.url, c.body, c.headers, { timeoutMs: 15000 });
            if (result.ok) return { id: c.id, label: c.label, keyOk: true };
            // 401/403 = 端点存在、协议可识别，只是 Key 不对：同样报告识别结果
            if (result.status === 401 || result.status === 403) return { id: c.id, label: c.label, keyOk: false };
        } catch (e) { /* 换下一个端点 */ }
    }
    return null;
}

function detectTtsProtocolByHost(baseUrl) {
    const h = String(baseUrl || '').toLowerCase();
    if (h.includes('xiaomimimo')) return 'mimo';
    if (h.includes('minimax')) return 'minimax';
    if (h.includes('dashscope.aliyuncs')) return 'dashscope';
    return 'openai-tts';
}

function detectAsrProtocolByHost(baseUrl) {
    const h = String(baseUrl || '').toLowerCase();
    if (h.includes('dashscope.aliyuncs')) return 'aliyun';
    return 'mimo';
}

/** 每类列表的公共渲染：● 标默认。详情节点的显隐不在这里做 —— 右栏显示什么由 syncModelPageVisibility 统一决定。 */
function renderProviderListPage(listBoxId, providers, defaultId, opts) {
    const listBox = document.getElementById(listBoxId);
    if (!listBox) return;
    const items = providers.map((p) => ({
        id: p.id,
        name: p.name || '未命名',
        desc: (p.id === defaultId ? '● 默认 · ' : '') + (opts.protocolName(p) || ''),
        active: p.id === (opts.activeId || ''),
        onDelete: opts.onDelete || null
    }));
    fillProvList(listBox, items, opts.onPick);
}

/** 栏头「＋ 新增」按钮统一为打开新建弹窗，无本地态要同步；保留函数作显式入口。 */
function syncModelAddButtons() {}

// ----- 文字转语音 -----

function renderTtsProviderPage(resetView) {
    if (resetView) { ttsProviderEditingId = ''; ttsProviderDetailOpen = false; }
    renderProviderListPage('ttsProviderList',
        Array.isArray(state.settings.ttsProviders) ? state.settings.ttsProviders : [],
        String(state.settings.defaultTtsProviderId || ''),
        {
            protocolName: (p) => String(p.model || '').trim() + ' · ' + ((ttsPresetFor(p) || {}).name || p.apiFormat || 'TTS'),
            activeId: ttsProviderEditingId,
            onPick: (id) => openTtsProviderDetail(id),
            onDelete: (id) => { void deleteTtsProvider(id); }
        });
    if (ttsProviderEditingId) {
        const prov = findTtsProviderById(ttsProviderEditingId);
        // 指向的提供商被删掉时退回列表，别停在一个不存在的 id 上。
        if (!prov) { ttsProviderEditingId = ''; ttsProviderDetailOpen = false; }
        else fillTtsProviderDetail(prov);
    }
}

function fillTtsProviderDetail(prov) {
    const preset = ttsPresetFor(prov);
    const nameInput = document.getElementById('settingTtsProviderName');
    if (nameInput) nameInput.value = prov.name || '';
    const baseRow = document.getElementById('ttsBaseUrlRow');
    const baseInput = document.getElementById('settingTtsBaseUrl');
    if (baseRow) baseRow.classList.toggle('hidden', !(preset && preset.editableBaseUrl));
    if (baseInput) baseInput.value = String(prov.baseUrl || '');
    if (baseInput && preset) baseInput.placeholder = preset.baseUrl || '';
    const keyInput = document.getElementById('settingTtsProviderKey');
    if (keyInput) keyInput.value = getProviderSecret(prov.id);
    const hint = document.getElementById('ttsProtocolHint');
    if (hint) hint.textContent = preset ? preset.hint : '';
    updateTtsProviderUI();
    // 各协议字段按当前协议回填；非当前协议的字段藏着，值随意（提交时只读当前协议的字段）。
    const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    val('settingMimoTtsModel', prov.apiFormat === 'mimo' ? (prov.model || 'mimo-v2.5-tts') : 'mimo-v2.5-tts');
    val('settingMimoTtsVoice', prov.apiFormat === 'mimo' ? (prov.voice || 'mimo_default') : '');
    val('settingMimoVoiceDesignPrompt', prov.apiFormat === 'mimo' ? (prov.voiceDesignPrompt || '') : '');
    val('settingOpenaiTtsModel', prov.apiFormat === 'openai-tts' ? (prov.model || 'tts-1') : '');
    val('settingOpenaiTtsVoice', prov.apiFormat === 'openai-tts' ? (prov.voice || 'alloy') : '');
    val('settingMinimaxModel', prov.apiFormat === 'minimax' ? (prov.model || 'speech-2.8-hd') : 'speech-2.8-hd');
    val('settingMinimaxVoice', prov.apiFormat === 'minimax' ? (prov.voice || '') : '');
    val('settingDashscopeTtsModel', prov.apiFormat === 'dashscope' ? (prov.model || 'qwen3-tts-flash') : '');
    val('settingDashscopeTtsVoice', prov.apiFormat === 'dashscope' ? (prov.voice || 'Cherry') : '');
    updateMimoTtsModelUI();
    const badge = document.getElementById('ttsDefaultBadge');
    if (badge) badge.textContent = prov.id === state.settings.defaultTtsProviderId ? '✓ 当前默认' : '';
}

/** 把详情页里那一个提供商的字段写回 state（切列表 / 返回 / 保存前都要先调它）。 */
function commitTtsProviderDetail() {
    if (!ttsProviderDetailOpen || !ttsProviderEditingId) return;
    const prov = findTtsProviderById(ttsProviderEditingId);
    if (!prov) return;
    const preset = ttsPresetFor(prov);
    const nameInput = document.getElementById('settingTtsProviderName');
    prov.name = (nameInput && nameInput.value.trim()) || (preset ? preset.name : '未命名');
    if (preset && preset.editableBaseUrl) {
        prov.baseUrl = document.getElementById('settingTtsBaseUrl')?.value.trim() || preset.baseUrl || '';
    }
    const keyInput = document.getElementById('settingTtsProviderKey');
    if (keyInput) setProviderSecret(prov.id, keyInput.value);
    const trim = (id, fallback) => (document.getElementById(id)?.value.trim()) || fallback;
    if (prov.apiFormat === 'mimo') {
        prov.model = trim('settingMimoTtsModel', 'mimo-v2.5-tts');
        prov.voice = trim('settingMimoTtsVoice', 'mimo_default');
        prov.voiceDesignPrompt = trim('settingMimoVoiceDesignPrompt', '');
    } else if (prov.apiFormat === 'openai-tts') {
        prov.model = trim('settingOpenaiTtsModel', 'tts-1');
        prov.voice = trim('settingOpenaiTtsVoice', 'alloy');
    } else if (prov.apiFormat === 'minimax') {
        prov.model = trim('settingMinimaxModel', 'speech-2.8-hd');
        prov.voice = trim('settingMinimaxVoice', '');
    } else if (prov.apiFormat === 'dashscope') {
        prov.model = trim('settingDashscopeTtsModel', 'qwen3-tts-flash');
        prov.voice = trim('settingDashscopeTtsVoice', 'Cherry');
    }
}

function openTtsProviderDetail(id) {
    commitTtsProviderDetail();
    ttsProviderEditingId = id;
    modelSectionPage = 'tts';
    ttsProviderDetailOpen = true;
    renderTtsProviderPage(false);
    syncModelPageVisibility();
}

function backToTtsProviderList() {
    commitTtsProviderDetail();
    ttsProviderEditingId = '';
    ttsProviderDetailOpen = false;
    renderTtsProviderPage(false);
    syncModelPageVisibility();
}

function addTtsProviderFromPreset(presetId, initial = {}) {
    commitTtsProviderDetail();
    const s = state.settings;
    const preset = TTS_PROTOCOL_PRESETS.find((x) => x.id === presetId);
    if (!preset) return;
    if (!Array.isArray(s.ttsProviders)) s.ttsProviders = [];
    const id = newProviderId('tts');
    s.ttsProviders.push({
        id,
        name: String(initial.name || '').trim() || preset.name,
        apiFormat: preset.id,
        baseUrl: String(initial.baseUrl || '').trim() || preset.baseUrl || '',
        model: String(initial.model || '').trim() || preset.model || '',
        voice: preset.voice || '',
        voiceDesignPrompt: ''
    });
    if (String(initial.apiKey || '').trim()) setProviderSecret(id, initial.apiKey);
    // 第一家自动成为默认；之后新增的不抢默认，由用户在总览切换。
    if (!s.defaultTtsProviderId) s.defaultTtsProviderId = id;
    ttsProviderEditingId = id;
    ttsProviderDetailOpen = true;
    renderTtsProviderPage(false);
    syncModelPageVisibility();
    void saveSettings({ silent: true });
}

async function deleteTtsProvider(id) {
    const s = state.settings;
    const prov = findTtsProviderById(id);
    const ok = await showCustomConfirm('删除「' + ((prov && prov.name) || '未命名') + '」？\n\n它的 API Key 也会一并清掉。');
    if (!ok) return;
    s.ttsProviders = (s.ttsProviders || []).filter((p) => p.id !== id);
    if (s.chatProviderKeys && typeof s.chatProviderKeys === 'object') delete s.chatProviderKeys[id];
    if (s.defaultTtsProviderId === id) s.defaultTtsProviderId = (s.ttsProviders[0] || {}).id || '';
    ttsProviderEditingId = '';
    ttsProviderDetailOpen = false;
    renderTtsProviderPage(false);
    syncModelPageVisibility();
    await saveSettings({ silent: true });
}

/** 详情页「测试连接」：先提交草稿再按这份草稿配置发一条极小请求（与对话提供商的块内测试同一思路）。 */
async function testTtsProviderDraft() {
    const btn = document.getElementById('ttsProviderTest');
    if (!ttsProviderDetailOpen || !ttsProviderEditingId) return;
    const prov = findTtsProviderById(ttsProviderEditingId);
    if (!prov) return;
    await withSettingsTestButton(btn, '测试中…', async () => {
        commitTtsProviderDetail();
        const cfg = ttsProviderSettings(prov);
        const name = prov.name || '这家服务';
        if (prov.apiFormat === 'mimo') {
            const audio = await generateMimoTtsAudio('你好，这是语音连接测试。', cfg);
            if (!audio?.bytes?.byteLength) throw new ClientApiError('UPSTREAM_UNAVAILABLE', 'MiMo 返回了空音频');
            showCustomAlert(name + ' 已成功返回测试音频，Key、模型与音色可以使用。', '语音连接正常');
            return;
        }
        if (prov.apiFormat === 'openai-tts') {
            const audio = await generateOpenaiTtsAudio('你好，这是语音连接测试。', cfg);
            if (!audio?.bytes?.byteLength) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '通用 OpenAI TTS 返回了空音频');
            showCustomAlert(name + ' 已成功返回测试音频，Key、模型与音色可以使用。', '语音连接正常');
            return;
        }
        if (prov.apiFormat === 'dashscope') {
            const audio = await generateDashscopeTtsAudio('你好，这是语音连接测试。', cfg);
            if (!audio?.bytes?.byteLength) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '阿里千问音频文件为空');
            showCustomAlert(name + ' 已成功返回测试音频，Key、模型与音色可以使用。', '语音连接正常');
            return;
        }
        if (!cfg.minimaxApiKey) throw new ClientApiError('APP_KEY_MISSING', '请先填写 MiniMax API Key');
        if (!cfg.minimaxVoice) throw new ClientApiError('BAD_REQUEST', '请先填写自己的 MiniMax 音色 ID');
        const result = await postJsonFromDevice(MINIMAX_TTS_HTTP, {
            model: cfg.minimaxModel,
            text: 'こんにちは、接続テストです。',
            stream: false,
            language_boost: 'Japanese',
            voice_setting: { voice_id: cfg.minimaxVoice, speed: 1, vol: 1, pitch: 0 },
            audio_setting: { sample_rate: 24000, bitrate: 128000, format: 'mp3', channel: 1 }
        }, { Authorization: `Bearer ${cfg.minimaxApiKey}` });
        if (!result.ok || Number(result.payload?.base_resp?.status_code || 0) !== 0) {
            await throwProviderResponseError(result, 'MiniMax 语音连接测试失败');
        }
        if (!String(result.payload?.data?.audio || '')) throw new ClientApiError('UPSTREAM_UNAVAILABLE', 'MiniMax 返回了空音频');
        showCustomAlert(name + ' 已成功返回测试音频，Key、模型与音色 ID 可以使用。', '语音连接正常');
    });
}

// ----- 语音转文字 -----

function renderAsrProviderPage(resetView) {
    if (resetView) { asrProviderEditingId = ''; asrProviderDetailOpen = false; }
    renderProviderListPage('asrProviderList',
        Array.isArray(state.settings.asrProviders) ? state.settings.asrProviders : [],
        String(state.settings.defaultAsrProviderId || ''),
        {
            protocolName: (p) => String(p.model || '').trim() + ' · ' + ((asrPresetFor(p) || {}).name || p.apiFormat || 'ASR'),
            activeId: asrProviderEditingId,
            onPick: (id) => openAsrProviderDetail(id),
            onDelete: (id) => { void deleteAsrProvider(id); }
        });
    if (asrProviderEditingId) {
        const prov = findAsrProviderById(asrProviderEditingId);
        if (!prov) { asrProviderEditingId = ''; asrProviderDetailOpen = false; }
        else fillAsrProviderDetail(prov);
    }
}

function fillAsrProviderDetail(prov) {
    const preset = asrPresetFor(prov);
    const nameInput = document.getElementById('settingAsrProviderName');
    if (nameInput) nameInput.value = prov.name || '';
    const baseInput = document.getElementById('settingAsrBaseUrl');
    if (baseInput) {
        baseInput.value = String(prov.baseUrl || '');
        if (preset) baseInput.placeholder = preset.baseUrl || '';
    }
    const keyInput = document.getElementById('settingAsrProviderKey');
    if (keyInput) keyInput.value = getProviderSecret(prov.id);
    const hint = document.getElementById('asrProtocolHint');
    if (hint) hint.textContent = preset ? preset.hint : '';
    updateAsrProviderUI();
    const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    val('settingDashscopeAsrModel', prov.apiFormat === 'aliyun' ? (prov.model || 'qwen3-asr-flash') : '');
    val('settingMimoAsrModel', prov.apiFormat === 'mimo' ? (prov.model || 'mimo-v2.5-asr') : '');
    const badge = document.getElementById('asrDefaultBadge');
    if (badge) badge.textContent = prov.id === state.settings.defaultAsrProviderId ? '✓ 当前默认' : '';
}

function commitAsrProviderDetail() {
    if (!asrProviderDetailOpen || !asrProviderEditingId) return;
    const prov = findAsrProviderById(asrProviderEditingId);
    if (!prov) return;
    const preset = asrPresetFor(prov);
    const nameInput = document.getElementById('settingAsrProviderName');
    prov.name = (nameInput && nameInput.value.trim()) || (preset ? preset.name : '未命名');
    prov.baseUrl = document.getElementById('settingAsrBaseUrl')?.value.trim() || (preset ? preset.baseUrl : '');
    const keyInput = document.getElementById('settingAsrProviderKey');
    if (keyInput) setProviderSecret(prov.id, keyInput.value);
    const trim = (id, fallback) => (document.getElementById(id)?.value.trim()) || fallback;
    if (prov.apiFormat === 'aliyun') {
        prov.model = trim('settingDashscopeAsrModel', 'qwen3-asr-flash');
    } else if (prov.apiFormat === 'mimo') {
        prov.model = trim('settingMimoAsrModel', 'mimo-v2.5-asr');
    }
}

function openAsrProviderDetail(id) {
    commitAsrProviderDetail();
    asrProviderEditingId = id;
    modelSectionPage = 'asr';
    asrProviderDetailOpen = true;
    renderAsrProviderPage(false);
    syncModelPageVisibility();
}

function backToAsrProviderList() {
    commitAsrProviderDetail();
    asrProviderEditingId = '';
    asrProviderDetailOpen = false;
    renderAsrProviderPage(false);
    syncModelPageVisibility();
}

function addAsrProviderFromPreset(presetId, initial = {}) {
    commitAsrProviderDetail();
    const s = state.settings;
    const preset = ASR_PROTOCOL_PRESETS.find((x) => x.id === presetId);
    if (!preset) return;
    if (!Array.isArray(s.asrProviders)) s.asrProviders = [];
    const id = newProviderId('asr');
    s.asrProviders.push({
        id,
        name: String(initial.name || '').trim() || preset.name,
        apiFormat: preset.id,
        baseUrl: String(initial.baseUrl || '').trim() || preset.baseUrl || '',
        model: String(initial.model || '').trim() || preset.model || ''
    });
    if (String(initial.apiKey || '').trim()) setProviderSecret(id, initial.apiKey);
    if (!s.defaultAsrProviderId) s.defaultAsrProviderId = id;
    asrProviderEditingId = id;
    asrProviderDetailOpen = true;
    renderAsrProviderPage(false);
    syncModelPageVisibility();
    void saveSettings({ silent: true });
}

async function deleteAsrProvider(id) {
    const s = state.settings;
    const prov = findAsrProviderById(id);
    const ok = await showCustomConfirm('删除「' + ((prov && prov.name) || '未命名') + '」？\n\n它的 API Key 也会一并清掉；删除后云端语音转文字随之关闭。');
    if (!ok) return;
    s.asrProviders = (s.asrProviders || []).filter((p) => p.id !== id);
    if (s.chatProviderKeys && typeof s.chatProviderKeys === 'object') delete s.chatProviderKeys[id];
    if (s.defaultAsrProviderId === id) s.defaultAsrProviderId = '';
    asrProviderEditingId = '';
    asrProviderDetailOpen = false;
    renderAsrProviderPage(false);
    syncModelPageVisibility();
    await saveSettings({ silent: true });
}

/** 详情页「测试」：发 0.5 秒静音走一遍真实识别请求；形状按协议拼（与各自请求层同一套请求体）。 */
async function testAsrProviderDraft() {
    const btn = document.getElementById('asrProviderTest');
    const statusEl = document.getElementById('asrProviderTestStatus');
    if (!asrProviderDetailOpen || !asrProviderEditingId) return;
    const prov = findAsrProviderById(asrProviderEditingId);
    if (!prov) return;
    await withSettingsTestButton(btn, '测试中…', async () => {
        commitAsrProviderDetail();
        const preset = asrPresetFor(prov);
        const key = getProviderSecret(prov.id);
        const baseUrl = String(prov.baseUrl || (preset ? preset.baseUrl : '')).trim();
        const model = String(prov.model || (preset ? preset.model : '')).trim();
        const show = (text, ok2) => {
            if (!statusEl) return;
            statusEl.textContent = text;
            statusEl.className = 'text-[11px] ' + (ok2 ? 'text-ok' : 'text-danger');
        };
        if (!key) throw new ClientApiError('APP_KEY_MISSING', '请先填写 API Key');
        const samples = new Float32Array(ASR_TARGET_SAMPLE_RATE * 0.5); // 0.5s 静音
        try {
            if (prov.apiFormat === 'aliyun') {
                if (/streaming/i.test(model)) {
                    show('❌ 「' + model + '」是实时流式模型（走 WebSocket），本应用调不了 —— 请改用非流式模型', false);
                    return;
                }
                const result = await postJsonFromDevice(baseUrl,
                    buildAliyunAsrRequestBody(model, float32ToWavBase64(samples, ASR_TARGET_SAMPLE_RATE)),
                    { Authorization: `Bearer ${key}`, 'X-DashScope-DataInspection': 'enable' }, { timeoutMs: 20000 });
                if (result.ok || isAsrNoWordsError(result)) {
                    show('✅ 连接成功（HTTP ' + (result.status || 200) + '）：Key 有效、' + model + ' 可调用'
                        + (result.ok ? '' : '（测试发的是 0.5 秒静音，模型如实回「没有听到词」—— 属正常，录真话就会出文字）'), true);
                } else {
                    show('❌ ' + String(result.payload?.base_resp?.status_msg || result.payload?.message
                        || result.payload?.error?.message || result.payload?.error || ('HTTP ' + result.status))
                        + '（HTTP ' + (result.status || '?') + '）', false);
                }
            } else {
                const result = await postJsonFromDevice(baseUrl.replace(/\/+$/, '') + '/v1/chat/completions', {
                    model,
                    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${float32ToWavBase64(samples, ASR_TARGET_SAMPLE_RATE)}`, format: 'wav' } }] }],
                    asr_options: { language: 'zh' },
                    stream: false
                }, { 'api-key': key, 'Content-Type': 'application/json' }, { timeoutMs: 20000 });
                show(result.ok
                    ? '✅ 连接成功（HTTP ' + (result.status || 200) + '）：' + model + ' 可用'
                    : '❌ ' + String(result.payload?.message || result.payload?.error?.message || result.payload?.error || ('HTTP ' + result.status))
                        + '（HTTP ' + (result.status || '?') + '）', result.ok);
            }
        } catch (err) {
            show('❌ ' + (err.message || err), false);
        }
    });
}

// ----- 嵌入 / 重排序（共用一套单协议列表：接口地址 / Key / 模型 + 获取模型 + 测试）-----

function renderSimpleProviderPage(kind, resetView) {
    const isEmbedding = kind === 'embedding';
    const listId = isEmbedding ? 'embeddingProviderList' : 'rerankProviderList';
    if (resetView) {
        if (isEmbedding) { embeddingProviderEditingId = ''; embeddingProviderDetailOpen = false; }
        else { rerankProviderEditingId = ''; rerankProviderDetailOpen = false; }
    }
    const editingId = isEmbedding ? embeddingProviderEditingId : rerankProviderEditingId;
    const defaultId = String(isEmbedding ? state.settings.defaultEmbeddingProviderId : state.settings.defaultRerankProviderId || '');
    renderProviderListPage(listId,
        Array.isArray(state.settings[kind + 'Providers']) ? state.settings[kind + 'Providers'] : [],
        defaultId,
        {
            protocolName: (p) => String(p.model || '').trim() + ' · ' + (isEmbedding ? 'OpenAI 兼容 /embeddings' : '通用 /rerank'),
            activeId: editingId,
            onPick: (id) => openSimpleProviderDetail(kind, id),
            onDelete: (id) => { void deleteSimpleProvider(kind, id); }
        });
    if (editingId) {
        const prov = (isEmbedding ? findEmbeddingProviderById(editingId) : findRerankProviderById(editingId));
        if (!prov) {
            if (isEmbedding) { embeddingProviderEditingId = ''; embeddingProviderDetailOpen = false; }
            else { rerankProviderEditingId = ''; rerankProviderDetailOpen = false; }
        } else {
            const title = document.getElementById(isEmbedding ? 'embeddingProviderDetailTitle' : 'rerankProviderDetailTitle');
            if (title) title.textContent = prov.name || (isEmbedding ? '嵌入' : '重排序');
            fillSimpleProviderDetail(kind, prov);
        }
    }
    // 增删 / 改默认都走这里：「能力 → 记忆与检索」那两个下拉必须跟着变，
    // 否则分栏切过去显示的还是旧绑定，用户以为改没生效。
    fillMemoryBindingSelects();
}

function fillSimpleProviderDetail(kind, prov) {
    const isEmbedding = kind === 'embedding';
    const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    val(isEmbedding ? 'settingEmbeddingProviderName' : 'settingRerankProviderName', prov.name || '');
    val(isEmbedding ? 'settingEmbeddingBaseUrl' : 'settingRerankBaseUrl', String(prov.baseUrl || ''));
    val(isEmbedding ? 'settingEmbeddingProviderKey' : 'settingRerankProviderKey', getProviderSecret(prov.id));
    val(isEmbedding ? 'settingEmbeddingModel' : 'settingRerankModel', String(prov.model || ''));
    const badge = document.getElementById(isEmbedding ? 'embeddingDefaultBadge' : 'rerankDefaultBadge');
    const currentDefault = String(isEmbedding ? state.settings.defaultEmbeddingProviderId : state.settings.defaultRerankProviderId || '');
    if (badge) badge.textContent = prov.id === currentDefault ? '✓ 当前默认' : '';
}

function commitSimpleProviderDetail(kind) {
    const isEmbedding = kind === 'embedding';
    const detailOpen = isEmbedding ? embeddingProviderDetailOpen : rerankProviderDetailOpen;
    const editingId = isEmbedding ? embeddingProviderEditingId : rerankProviderEditingId;
    if (!detailOpen || !editingId) return;
    const prov = isEmbedding ? findEmbeddingProviderById(editingId) : findRerankProviderById(editingId);
    if (!prov) return;
    const nameId = isEmbedding ? 'settingEmbeddingProviderName' : 'settingRerankProviderName';
    const baseId = isEmbedding ? 'settingEmbeddingBaseUrl' : 'settingRerankBaseUrl';
    const keyId = isEmbedding ? 'settingEmbeddingProviderKey' : 'settingRerankProviderKey';
    const modelId = isEmbedding ? 'settingEmbeddingModel' : 'settingRerankModel';
    const nameInput = document.getElementById(nameId);
    prov.name = (nameInput && nameInput.value.trim()) || '未命名';
    prov.baseUrl = document.getElementById(baseId)?.value.trim() || '';
    const keyInput = document.getElementById(keyId);
    if (keyInput) setProviderSecret(prov.id, keyInput.value);
    prov.model = document.getElementById(modelId)?.value.trim() || '';
}

function openSimpleProviderDetail(kind, id) {
    commitSimpleProviderDetail(kind);
    modelSectionPage = kind;
    if (kind === 'embedding') { embeddingProviderEditingId = id; embeddingProviderDetailOpen = true; }
    else { rerankProviderEditingId = id; rerankProviderDetailOpen = true; }
    renderSimpleProviderPage(kind, false);
    syncModelPageVisibility();
}

function backToSimpleProviderList(kind) {
    commitSimpleProviderDetail(kind);
    if (kind === 'embedding') { embeddingProviderEditingId = ''; embeddingProviderDetailOpen = false; }
    else { rerankProviderEditingId = ''; rerankProviderDetailOpen = false; }
    renderSimpleProviderPage(kind, false);
    syncModelPageVisibility();
}

function addSimpleProvider(kind, initial = {}) {
    commitSimpleProviderDetail(kind);
    const s = state.settings;
    const preset = kind === 'embedding' ? EMBEDDING_PROTOCOL_PRESETS[0] : RERANK_PROTOCOL_PRESETS[0];
    if (!preset) return;
    if (!Array.isArray(s[kind + 'Providers'])) s[kind + 'Providers'] = [];
    const id = newProviderId(kind === 'embedding' ? 'emb' : 'rrk');
    s[kind + 'Providers'].push({
        id,
        name: String(initial.name || '').trim() || preset.name,
        apiFormat: preset.id,
        baseUrl: String(initial.baseUrl || '').trim() || preset.baseUrl || '',
        model: String(initial.model || '').trim() || preset.model || ''
    });
    if (String(initial.apiKey || '').trim()) setProviderSecret(id, initial.apiKey);
    if (!(kind === 'embedding' ? s.defaultEmbeddingProviderId : s.defaultRerankProviderId)) {
        if (kind === 'embedding') s.defaultEmbeddingProviderId = id;
        else s.defaultRerankProviderId = id;
    }
    if (kind === 'embedding') { embeddingProviderEditingId = id; embeddingProviderDetailOpen = true; }
    else { rerankProviderEditingId = id; rerankProviderDetailOpen = true; }
    renderSimpleProviderPage(kind, false);
    syncModelPageVisibility();
    void saveSettings({ silent: true });
}

async function deleteSimpleProvider(kind, id) {
    const s = state.settings;
    const isEmbedding = kind === 'embedding';
    const prov = isEmbedding ? findEmbeddingProviderById(id) : findRerankProviderById(id);
    const ok = await showCustomConfirm('删除「' + ((prov && prov.name) || '未命名') + '」？\n\n它的 API Key 也会一并清掉。');
    if (!ok) return;
    s[kind + 'Providers'] = (s[kind + 'Providers'] || []).filter((p) => p.id !== id);
    if (s.chatProviderKeys && typeof s.chatProviderKeys === 'object') delete s.chatProviderKeys[id];
    if (isEmbedding && s.defaultEmbeddingProviderId === id) s.defaultEmbeddingProviderId = (s.embeddingProviders[0] || {}).id || '';
    if (!isEmbedding && s.defaultRerankProviderId === id) s.defaultRerankProviderId = (s.rerankProviders[0] || {}).id || '';
    if (isEmbedding) { embeddingProviderEditingId = ''; embeddingProviderDetailOpen = false; }
    else { rerankProviderEditingId = ''; rerankProviderDetailOpen = false; }
    renderSimpleProviderPage(kind, false);
    syncModelPageVisibility();
    await saveSettings({ silent: true });
}

function renderEmbeddingProviderPage(resetView) { renderSimpleProviderPage('embedding', resetView); }
function renderRerankProviderPage(resetView) { renderSimpleProviderPage('rerank', resetView); }

/** 「获取模型」：拉 OpenAI 兼容 /models；当前模型名为空时自动落第一个，否则弹列表让用户自己抄。 */
async function fetchSimpleProviderModels(kind) {
    const btn = document.getElementById(kind === 'embedding' ? 'embeddingFetchModelsBtn' : 'rerankFetchModelsBtn');
    commitSimpleProviderDetail(kind);
    const editingId = kind === 'embedding' ? embeddingProviderEditingId : rerankProviderEditingId;
    const prov = kind === 'embedding' ? findEmbeddingProviderById(editingId) : findRerankProviderById(editingId);
    if (!prov || !btn) return;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ 获取中…';
    try {
        const models = await fetchModelList(prov.baseUrl, getProviderSecret(prov.id), 'openai-compatible');
        if (!models.length) throw new Error('接口未返回模型列表（data 为空），可能该服务不支持 /models');
        const modelInput = document.getElementById(kind === 'embedding' ? 'settingEmbeddingModel' : 'settingRerankModel');
        if (modelInput && !String(modelInput.value || '').trim()) modelInput.value = models[0];
        showCustomAlert('可用模型（前 30 个）：\n' + models.slice(0, 30).join('\n')
            + (models.length > 30 ? '\n… 共 ' + models.length + ' 个' : ''), '获取模型');
    } catch (err) {
        const detail = String(err?.message || err);
        const isNetwork = /Failed to fetch|NetworkError|Load failed/i.test(detail);
        showCustomAlert('获取模型列表失败：' + detail
            + (isNetwork ? '\n\n（浏览器直连被跨域拦截且本机中转不可用）' : '')
            + '\n\n拉不到列表也可以直接手动填模型名。', '获取模型');
    } finally {
        btn.disabled = false;
        btn.textContent = old;
    }
}

async function testEmbeddingProviderDraft() {
    const btn = document.getElementById('embeddingProviderTest');
    if (!embeddingProviderDetailOpen || !embeddingProviderEditingId) return;
    const prov = findEmbeddingProviderById(embeddingProviderEditingId);
    if (!prov) return;
    await withSettingsTestButton(btn, '测试中…', async () => {
        commitSimpleProviderDetail('embedding');
        const res = await callEmbeddingAPI(['连接测试'], { providerId: prov.id });
        showCustomAlert('嵌入可用：返回 ' + res.embeddings.length + ' 条向量，维度 ' + res.dims + '（模型 ' + res.model + '）。', '嵌入连接正常');
    });
}

async function testRerankProviderDraft() {
    const btn = document.getElementById('rerankProviderTest');
    if (!rerankProviderDetailOpen || !rerankProviderEditingId) return;
    const prov = findRerankProviderById(rerankProviderEditingId);
    if (!prov) return;
    await withSettingsTestButton(btn, '测试中…', async () => {
        commitSimpleProviderDetail('rerank');
        const res = await callRerankAPI('魔女的旅行', [
            '伊蕾娜是《魔女之旅》中的灰之魔女。',
            '今天天气很好，适合出门散步。',
            '扫帚是魔女的常用交通工具。'
        ], { providerId: prov.id });
        showCustomAlert('重排序可用：返回 ' + res.results.length + ' 条结果，最高相关度 '
            + res.results[0].relevanceScore.toFixed(3) + '（模型 ' + res.model + '）。', '重排序连接正常');
    });
}

/** 图片转述候选按当前对话模型库重建；开不用开关——选中即用、选空即停。 */
function renderVisionProviderPage() {
    fillVisionModelPairOptions();
    updateVisionMainModelHint();
}

/** 只按名字做一个弱判断，用于把提示说具体；真正结论仍以模型实测缓存为准。 */
function visionModelLooksMultimodal(model) {
    const name = String(model || '').toLowerCase();
    if (!name) return false;
    return /(gpt-4o|gpt-4\.1|gpt-5|\bo[34]\b|gemini|claude-3|claude-4|qwen[^\s]*vl|qwen2\.5-vl|qwen3-vl|glm-4v|glm-4\.5v|pixtral|llava|internvl|minicpm-v|vision|multimodal)/.test(name);
}

/** 提示条跟着「默认模型」走：已知能识图时明确劝退，普通情况保留通用说明。 */
function updateVisionMainModelHint(modelOverride) {
    const el = document.getElementById('visionMainModelHint');
    if (!el) return;
    let model = modelOverride == null ? '' : String(modelOverride);
    if (modelOverride == null) {
        try { model = String(activeChatSettings().model || ''); } catch (e) { /* 模型层未就绪时保留通用文案 */ }
    }
    let verdict = null;
    try { if (typeof cachedModelImageVerdict === 'function') verdict = cachedModelImageVerdict(); } catch (e) { /* 缓存不可读时按未知处理 */ }
    const strong = verdict === true || visionModelLooksMultimodal(model);
    el.classList.toggle('set-note-warn', strong);
    el.innerHTML = strong
        ? '当前默认模型「' + escapeHtml(model || '默认模型') + '」本来就支持查看图片，建议不要打开这个开关。'
        : '主模型本来就支持查看图片时，建议不要打开这个开关；纯文本模型才需要接一个视觉模型。';
}

/** 进模型页时把全部二级编辑态清掉（编辑状态不跨访问、不跨分类保留）。 */
function resetModelProviderPages() {
    clearModelEditingState();
    renderTtsProviderPage(false);
    renderAsrProviderPage(false);
    renderEmbeddingProviderPage(false);
    renderRerankProviderPage(false);
}

// ---------- 模型页：五分类常驻导航 + 左列表右详情双栏 ----------
// 「模型」是设置面板之外的顶层页面（与记忆页同级）：顶部分类胶囊常驻（对话 / 语音转文字 /
// 文字转语音 / 嵌入 / 重排序）；宽屏左栏列表、右栏详情 —— 未选中时给占位符，
// 对话类的右栏默认是默认模型与回退设置。窄屏上下堆叠。

const MODEL_SECTION_ENTRIES = Object.freeze([
    { key: 'chat', name: '对话', desc: '默认模型、失败回退、图片转述与多套提供商' },
    { key: 'asr', name: '语音转文字', desc: '把说的话转成文字' },
    { key: 'tts', name: '文字转语音', desc: '朗读用哪家服务、什么音色' },
    { key: 'embedding', name: '嵌入', desc: '文本 → 向量（检索与记忆用）' },
    { key: 'rerank', name: '重排序', desc: '按相关度给候选文档排序' }
]);

const MODEL_SECTION_LIST_PANE = Object.freeze({
    chat: 'modelChatListPane',
    asr: 'modelAsrListPane',
    tts: 'modelTtsListPane',
    embedding: 'modelEmbeddingListPane',
    rerank: 'modelRerankListPane'
});

let modelSectionPage = 'chat';

function clearModelEditingState() {
    chatProviderEditingId = '';
    ttsProviderEditingId = '';
    ttsProviderDetailOpen = false;
    asrProviderEditingId = '';
    asrProviderDetailOpen = false;
    embeddingProviderEditingId = '';
    embeddingProviderDetailOpen = false;
    rerankProviderEditingId = '';
    rerankProviderDetailOpen = false;
}

/** 当前分类右栏该显示哪个节点：编辑中 → 它的详情；否则对话 → 默认与回退，其余 → 占位符。 */
function modelDetailNodeId() {
    switch (modelSectionPage) {
        case 'chat': return chatProviderEditingId ? 'chatCardPane' : 'modelDetailPlaceholder';
        case 'tts': return ttsProviderEditingId ? 'ttsProviderDetail' : 'modelDetailPlaceholder';
        case 'asr': return asrProviderEditingId ? 'asrProviderDetail' : 'modelDetailPlaceholder';
        case 'embedding': return embeddingProviderEditingId ? 'embeddingProviderDetail' : 'modelDetailPlaceholder';
        case 'rerank': return rerankProviderEditingId ? 'rerankProviderDetail' : 'modelDetailPlaceholder';
        default: return 'modelDetailPlaceholder';
    }
}

let lastModelDetailId = '';

function syncModelPageVisibility() {
    MODEL_SECTION_ENTRIES.forEach((entry) => {
        const pane = document.getElementById(MODEL_SECTION_LIST_PANE[entry.key]);
        if (!pane) return;
        const visible = modelSectionView === 'providers' && modelFilter === entry.key;
        pane.classList.toggle('hidden', !visible);
        const title = pane.querySelector('.model-pane-title');
        if (title) title.textContent = entry.name;
    });
    const modelTab = document.getElementById('tab-model');
    if (modelSectionView === 'providers') {
        const showId = modelDetailNodeId();
        ['modelDetailPlaceholder', 'chatCardPane', 'ttsProviderDetail', 'asrProviderDetail',
            'embeddingProviderDetail', 'rerankProviderDetail'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('hidden', id !== showId);
        });
        // 换一家提供商时右栏重新入场；同一家重复渲染（输入、保存）不重播，避免打字时整块表单闪。
        if (showId !== lastModelDetailId) {
            lastModelDetailId = showId;
            const detail = document.getElementById('modelPaneDetail');
            if (detail && detail.classList) {
                detail.classList.remove('model-detail-in');
                void detail.offsetWidth;
                detail.classList.add('model-detail-in');
            }
        }
        // 手机窄屏靠这个标记在「列表」与「详情」之间整屏切换：只占位符时不算进了详情，列表必须留原样。
        const body = document.getElementById('modelPageBody');
        if (body) {
            const detailShown = showId !== 'modelDetailPlaceholder';
            const wasDetail = body.classList.contains('is-detail');
            body.classList.toggle('is-detail', detailShown);
            if (modelTab) modelTab.classList.toggle('is-detail', detailShown);
            // 从列表下钻时把内容滚回顶部，否则详情会停在上一次列表的滚动位置。
            if (detailShown && !wasDetail && window.innerWidth <= 980) {
                const content = document.getElementById('settingsContent');
                if (content) content.scrollTop = 0;
            }
        }
    } else {
        document.getElementById('modelPageBody')?.classList.remove('is-detail');
        if (modelTab) modelTab.classList.remove('is-detail');
    }
    renderModelFilterNav();
    renderModelSectionTabs();
    if (modelSectionView === 'overview') renderModelOverview();
}

function renderModelPage() {
    renderModelSectionTabs();
    syncModelViewPanes();
    if (modelSectionView === 'overview') {
        renderModelOverview();
        return;
    }
    if (modelSectionView === 'prefs') {
        renderChatBindings();
        return;
    }
    if (modelSectionView === 'add') {
        renderModelAddPage();
        return;
    }
    ensureModelProviderSelection();
    // 五类一起渲染：函数本身幂等，详情只填当前编辑中的那一家；“全部”视图要靠它一次铺开五段列表。
    renderChatProviderList();
    renderChatProviderCard();
    renderTtsProviderPage(false);
    renderAsrProviderPage(false);
    renderEmbeddingProviderPage(false);
    renderRerankProviderPage(false);
    syncModelPageVisibility();
    syncModelAddButtons();
}

/** 切到某个分类：先提交当前草稿，再清编辑态 —— 编辑状态不跨分类保留。 */
function showModelPage(key) {
    commitChatProviderDetail();
    commitTtsProviderDetail();
    commitAsrProviderDetail();
    commitSimpleProviderDetail('embedding');
    commitSimpleProviderDetail('rerank');
    clearModelEditingState();
    modelSectionView = 'providers';
    modelFilter = MODEL_SECTION_LIST_PANE[key] ? key : 'chat';
    modelSectionPage = modelFilter;
    renderModelPage();
}

/** 切进「模型」分栏时回到对话分类（与各分类"编辑状态不跨开关保留"一致）。 */
function resetModelSectionPage() {
    // 每次切进「模型」都回到总览：先看当前用谁，再决定去我的模型或使用偏好。
    modelAddState = null;
    document.getElementById('tab-model')?.classList.remove('is-add');
    // 先把详情草稿写回 state，再清编辑态 —— 否则切走再回来，刚填的地址/Key 会丢。
    commitChatProviderDetail();
    commitTtsProviderDetail();
    commitAsrProviderDetail();
    commitSimpleProviderDetail('embedding');
    commitSimpleProviderDetail('rerank');
    clearModelEditingState();
    modelSectionView = 'overview';
    modelFilter = 'chat';
    modelSectionPage = 'chat';
    renderModelPage();
}

/** 手机「我的」深链落到某个设置项时，先把模型页切到它所在的分类。 */
function openModelPageForAnchor(anchorId) {
    const map = {
        chatProviderList: ['providers', 'chat'],
        ttsProviderHome: ['providers', 'tts'],
        asrProviderHome: ['providers', 'asr'],
        embeddingProviderHome: ['providers', 'embedding'],
        rerankProviderHome: ['providers', 'rerank'],
        settingChatModel: ['prefs', ''],
        settingThinkingEffort: ['prefs', ''],
        modelGenerationSection: ['prefs', ''],
        modelOverviewCards: ['overview', '']
    };
    const target = map[anchorId];
    if (!target) return;
    if (target[0] === 'providers') {
        showModelPage(target[1]);
        return;
    }
    modelSectionView = target[0];
    modelFilter = 'chat';
    modelSectionPage = 'chat';
    renderModelPage();
}

/**
 * 某类模型「当前用谁」的一句话摘要。手机「我的」每行直接显示它 ——
 * 不点进去就能知道全家现在用的是什么，这是入口不收起来的前提（收起来反而更难找）。
 */
function describeModelBinding(kind) {
    const s = state.settings;
    const listOf = (k) => (Array.isArray(s[k + 'Providers']) ? s[k + 'Providers'] : []);
    const providerName = (k, id) => {
        const p = listOf(k).find((x) => x.id === String(id || ''));
        return p ? String(p.name || '未命名') : '';
    };
    if (kind === 'chat') {
        const pair = s.defaultChatModel || {};
        const prov = listOf('chat').find((p) => p.id === pair.providerId);
        const n = listOf('chat').length;
        if (!n) return '还没有供应商';
        if (!prov || !pair.model) return n + ' 家供应商 · 未选默认模型';
        return pair.model + ' · ' + n + ' 家供应商';
    }
    if (kind === 'tts') {
        const p = typeof activeTtsProvider === 'function' ? activeTtsProvider() : null;
        return p ? String(p.name || '未命名') : '还没有供应商';
    }
    if (kind === 'asr') {
        const p = typeof activeAsrProvider === 'function' ? activeAsrProvider() : null;
        if (!p) return '不使用云端识别';
        return String(p.name || '未命名');
    }
    if (kind === 'embedding') {
        const raw = String(s.defaultEmbeddingProviderId || '');
        if (typeof isChatModelBinding === 'function' && isChatModelBinding(raw)) {
            const pair = typeof resolveCurrentChatPair === 'function' ? resolveCurrentChatPair() : null;
            return pair ? ('对话模型 · ' + pair.model) : '未启用 · 只按关键词召回';
        }
        const name = providerName('embedding', raw);
        return name || '未启用 · 只按关键词召回';
    }
    if (kind === 'rerank') {
        const raw = String(s.defaultRerankProviderId || '');
        if (typeof isChatModelBinding === 'function' && isChatModelBinding(raw)) {
            const pair = typeof resolveCurrentChatPair === 'function' ? resolveCurrentChatPair() : null;
            return pair ? ('对话模型 · ' + pair.model) : '未启用 · 保持召回顺序';
        }
        const name = providerName('rerank', raw);
        return name || '未启用 · 保持召回顺序';
    }
    return '';
}

/** 手机「我的」模型一行的摘要：与总览同一个口径，避免两处数字对不上。 */
function describeModelOverview() {
    const total = MODEL_SECTION_ENTRIES.reduce((n, entry) => n + modelProviderList(entry.key).length, 0);
    if (!total) return '还没有添加模型';
    const configured = MODEL_SECTION_ENTRIES.filter((entry) => modelCurrentProvider(entry.key)).length;
    return total + ' 个提供商 · ' + configured + ' / 5 类已配置';
}

// ---------- 模型三段式：总览 / 我的模型 / 使用偏好 ----------
// 总览只负责“用谁”，我的模型负责“连接与编辑”，添加是独立弹窗；三段共用一份 state，避免同一绑定出现两套入口各自为政。
let modelSectionView = 'overview';
let modelFilter = 'chat';
const MODEL_VIEW_PANES = Object.freeze({
    overview: 'modelOverviewPane',
    providers: 'modelProvidersPane',
    prefs: 'modelPrefsPane',
    add: 'modelAddPane'
});

function modelProviderList(kind) {
    const key = kind === 'chat' ? 'chatProviders' : kind + 'Providers';
    return Array.isArray(state.settings[key]) ? state.settings[key] : [];
}

function modelProtocolLabel(kind, provider) {
    if (!provider) return '';
    if (provider._chatFallback) return '对话模型 · 不建议';
    if (kind === 'chat') return (CHAT_API_FORMATS[provider.apiFormat] || {}).label || 'OpenAI 兼容';
    if (kind === 'tts') return (ttsPresetFor(provider) || {}).name || 'TTS';
    if (kind === 'asr') return (asrPresetFor(provider) || {}).name || 'ASR';
    if (kind === 'embedding') return 'OpenAI 兼容 /embeddings';
    return '通用 /rerank';
}

function modelCurrentProvider(kind) {
    const s = state.settings;
    const list = modelProviderList(kind);
    if (kind === 'chat') {
        const pair = s.defaultChatModel || {};
        return list.find((p) => p.id === pair.providerId) || null;
    }
    if (kind === 'tts') {
        // TTS 没有“关闭”语义：默认悬空时和 activeTtsProvider 一样回落第一家。
        return list.find((p) => p.id === String(s.defaultTtsProviderId || '')) || list[0] || null;
    }
    if (kind === 'asr') return list.find((p) => p.id === String(s.defaultAsrProviderId || '')) || null;
    if (kind === 'embedding' || kind === 'rerank') {
        const raw = String((kind === 'embedding' ? s.defaultEmbeddingProviderId : s.defaultRerankProviderId) || '');
        if (isChatCurrentBinding(raw)) {
            const pair = typeof resolveCurrentChatPair === 'function' ? resolveCurrentChatPair() : null;
            return pair ? { id: raw, name: pair.provider.name || '未命名', model: pair.model, _chatFallback: true } : null;
        }
        if (isChatModelBinding(raw)) {
            const pair = parseChatModelBinding(raw);
            if (!pair) return null;
            const cp = (Array.isArray(s.chatProviders) ? s.chatProviders : []).find((p) => p.id === pair.providerId);
            if (cp && pair.model) return { id: raw, name: cp.name || '未命名', model: pair.model, _chatFallback: true };
            return null;
        }
        return list.find((p) => p.id === raw) || null;
    }
    return list.find((p) => p.id === String(s.defaultRerankProviderId || '')) || null;
}

function modelBindingCurrentId(kind) {
    const s = state.settings;
    if (kind === 'chat') return chatModelKey(s.defaultChatModel);
    if (kind === 'tts') return String(s.defaultTtsProviderId || '') || (modelProviderList('tts')[0] || {}).id || '';
    if (kind === 'asr') return String(s.defaultAsrProviderId || '');
    if (kind === 'embedding') return String(s.defaultEmbeddingProviderId || '');
    return String(s.defaultRerankProviderId || '');
}

function renderModelSectionTabs() {
    const tabs = document.getElementById('modelSectionTabs');
    if (tabs) {
        tabs.querySelectorAll('[data-model-view]').forEach((btn) => {
            const on = btn.getAttribute('data-model-view') === modelSectionView;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
    }
    const count = MODEL_SECTION_ENTRIES.reduce((n, entry) => n + modelProviderList(entry.key).length, 0);
    const countEl = document.getElementById('modelProviderCount');
    if (countEl) countEl.textContent = String(count);
}

function syncModelViewPanes() {
    Object.keys(MODEL_VIEW_PANES).forEach((view) => {
        const pane = document.getElementById(MODEL_VIEW_PANES[view]);
        if (pane) {
            const on = view === modelSectionView;
            pane.classList.toggle('hidden', !on);
            pane.setAttribute('aria-hidden', on ? 'false' : 'true');
        }
    });
    // 添加只属于「我的模型」：总览只做绑定，使用偏好只调参数，页头不再常驻添加入口。
    const addBtn = document.getElementById('modelAddModelBtn');
    if (addBtn) addBtn.classList.toggle('hidden', modelSectionView !== 'providers');
    // 手机顶栏要跟着当前子页写标题；属性变化同时触发 mobile-shell 的观察者。
    const tab = document.getElementById('tab-model');
    if (tab) tab.setAttribute('data-model-view', modelSectionView);
}

function renderModelFilterNav() {
    const box = document.getElementById('modelFilterNav');
    if (!box) return;
    // 不再保留「全部」聚合视图：五类在同一张卡里各占一段，越加越长；一次只看一类更清楚。
    box.innerHTML = MODEL_SECTION_ENTRIES.map((entry) => {
        const count = modelProviderList(entry.key).length;
        return '<button type="button" class="model-filter-btn' + (modelFilter === entry.key ? ' is-active' : '') + '"'
            + ' data-model-filter="' + entry.key + '" role="tab" aria-selected="' + (modelFilter === entry.key ? 'true' : 'false') + '">'
            + escapeHtml(entry.name) + '<span class="model-filter-count">' + count + '</span></button>';
    }).join('');
}

function closeModelPickers() {
    document.querySelectorAll('.mo-picker-menu').forEach((m) => m.classList.add('hidden'));
    document.querySelectorAll('.mo-picker-btn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

/** 总览里的下拉：不用原生 select 弹层（它在深色主题里会掉回白底蓝高亮），用同主题的浮层列表。 */
function modelPickerHtml(kind, currentLabel, options, ariaLabel) {
    let lastGroup = '';
    const menu = options.map((o) => {
        const group = o.group || '';
        const head = group && group !== lastGroup
            ? '<div class="mo-picker-group-label">' + escapeHtml(o.groupLabel || group) + '</div>'
            : '';
        lastGroup = group;
        return head + '<button type="button" class="mo-picker-option' + (o.selected ? ' is-selected' : '') + '"'
            + ' role="option" aria-selected="' + (o.selected ? 'true' : 'false') + '" data-mo-value="' + escapeHtml(o.value) + '">'
            + '<span class="mo-picker-option-label">' + escapeHtml(o.label) + '</span>'
            + (o.selected ? '<span class="mo-picker-check" aria-hidden="true">✓</span>' : '')
            + '</button>';
    }).join('');
    return '<div class="mo-picker" data-mo-picker="' + kind + '">'
        + '<button type="button" class="mo-picker-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="' + escapeHtml(ariaLabel) + '">'
        + '<span class="mo-picker-value">' + escapeHtml(currentLabel) + '</span>'
        + '<span class="mo-picker-chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></span>'
        + '</button>'
        + '<div class="mo-picker-menu hidden" role="listbox">' + menu + '</div>'
        + '</div>';
}

function renderModelOverview() {
    const box = document.getElementById('modelOverviewCards');
    if (!box) return;
    const s = state.settings;
    const chatProviders = modelProviderList('chat');
    const pairs = chatModelPairOptions(chatProviders);
    const currentKey = chatModelKey(s.defaultChatModel);
    const chatPair = pairs.find((pair) => pair.key === currentKey) || null;
    const chatProvider = chatPair ? chatProviders.find((p) => p.id === chatPair.providerId) : null;

    const chatPickerOptions = pairs.length
        ? pairs.map((pair) => ({ value: pair.key, label: pair.label, selected: pair.key === currentKey }))
        : [{ value: '', label: '未启用', selected: true }];
    const chatPickerLabel = (chatPickerOptions.find((o) => o.selected) || chatPickerOptions[0]).label;

    const chain = (Array.isArray(s.fallbackChatModels) ? s.fallbackChatModels : [])
        .filter((pair) => pairs.some((p) => p.key === chatModelKey(pair)));
    const fallbackChips = chain.map((pair, index) => {
        const key = chatModelKey(pair);
        const provider = chatProviders.find((p) => p.id === pair.providerId);
        return '<span class="mo-fb-chip"><span class="mo-fb-num">' + (index + 1) + '</span>'
            + escapeHtml(chatModelLabel(provider, pair.model))
            + '<button type="button" class="mo-fb-x" data-mo-fallback-remove="' + escapeHtml(key) + '" aria-label="移除回退模型">×</button></span>';
    }).join('');
    const fallbackCandidates = pairs.filter((pair) => pair.key !== currentKey && !chain.some((c) => chatModelKey(c) === pair.key));
    const fallbackAdd = fallbackCandidates.length
        ? '<div class="mo-picker mo-picker-fb" data-mo-picker="fallback">'
            + '<button type="button" class="mo-picker-btn mo-picker-btn-sm" aria-haspopup="listbox" aria-expanded="false" aria-label="添加回退模型">'
            + '<span class="mo-picker-value">＋ 添加回退</span>'
            + '<span class="mo-picker-chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></span>'
            + '</button>'
            + '<div class="mo-picker-menu hidden" role="listbox">'
            + fallbackCandidates.map((pair) => '<button type="button" class="mo-picker-option" role="option" data-mo-value="' + escapeHtml(pair.key) + '">'
                + '<span class="mo-picker-option-label">' + escapeHtml(pair.label) + '</span></button>').join('')
            + '</div></div>'
        : '';

    const cards = MODEL_SECTION_ENTRIES.filter((entry) => entry.key !== 'chat').map((entry) => {
        const kind = entry.key;
        const list = modelProviderList(kind);
        const current = modelCurrentProvider(kind);
        const currentId = modelBindingCurrentId(kind);
        const emptyLabel = kind === 'asr' ? '不使用云端识别'
            : kind === 'embedding' ? '未启用（只按关键词召回）'
                : kind === 'rerank' ? '未启用（保持召回顺序）' : '';
        // 嵌入 / 重排序允许拿对话模型兜底：专用服务不是人人都有，但这条路的成本和效果都不如专用模型。
        // 只给一个「沿用当前对话使用的模型」：逐一列出全家对话模型会让选择器变成第二张模型表，还会在换默认模型后立刻过期。
        const hasChatModels = chatModelPairOptions(chatProviders).length > 0;
        const chatFallbackOptions = (kind === 'embedding' || kind === 'rerank') && hasChatModels
            ? [{
                value: chatCurrentBindingValue(),
                label: '沿用当前对话使用的模型',
                selected: currentId === chatCurrentBindingValue(),
                group: 'chat',
                groupLabel: ''
            }]
            : [];
        const pickerOptions = [];
        if (list.length) {
            if (emptyLabel) pickerOptions.push({ value: '', label: emptyLabel, selected: !currentId });
            list.forEach((p) => pickerOptions.push({
                value: p.id,
                label: (p.name || '未命名') + (p.model ? ' · ' + p.model : ''),
                selected: p.id === currentId
            }));
        } else if (chatFallbackOptions.length) {
            if (emptyLabel) pickerOptions.push({ value: '', label: emptyLabel, selected: !currentId });
        } else {
            pickerOptions.push({ value: '', label: '未启用', selected: true });
        }
        pickerOptions.push(...chatFallbackOptions);
        const pickerLabel = (pickerOptions.find((o) => o.selected) || pickerOptions[0]).label;
        // 不管有没有可选提供商，这一格都保留：空的时候它就是一条「未启用」，仍可点开。
        const control = modelPickerHtml(kind, pickerLabel, pickerOptions, '切换' + entry.name);
        // 一家都没有时状态交给下拉里的「未启用」，不再额外挂一枚「未配置」角标。
        const status = current ? '已配置' : (list.length || chatFallbackOptions.length ? '未启用' : '');
        const modelText = current ? escapeHtml(current.model || current.name || '未命名') : (list.length || chatFallbackOptions.length ? '未启用' : '');
        return '<div class="mo-card">'
            + '<div class="mo-card-head"><span class="mo-kind-dot" aria-hidden="true">' + escapeHtml(modelAddKindAvatar(kind)) + '</span><span class="mo-kind-label">' + escapeHtml(entry.name) + '</span>'
            + (status ? '<span class="mo-status' + (current ? '' : ' is-empty') + '">' + status + '</span>' : '')
            + '</div>'
            + '<div class="mo-card-body"><div class="mo-main">'
            + (modelText ? '<div class="mo-model">' + modelText + '</div>' : '')
            + '<div class="mo-sub">' + (current
                ? escapeHtml((current.name || '未命名') + ' · ' + modelProtocolLabel(kind, current))
                : ((list.length || chatFallbackOptions.length) ? '选择要使用的提供商' : '去「我的模型」添加')) + '</div>'
            + '</div><div class="mo-control">' + control + '</div></div></div>';
    }).join('');

    const configured = MODEL_SECTION_ENTRIES.filter((entry) => modelCurrentProvider(entry.key)).length;
    const total = MODEL_SECTION_ENTRIES.reduce((n, entry) => n + modelProviderList(entry.key).length, 0);

    box.innerHTML = '<div class="mo-overview-head"><span class="mo-overview-title">当前使用</span>'
        + '<span class="mo-overview-meta">' + total + ' 个提供商 · ' + configured + ' / 5 类已配置</span></div>'
        + '<div class="mo-grid">'
        + '<div class="mo-card mo-card-wide">'
        + '<div class="mo-card-head"><span class="mo-kind-dot" aria-hidden="true">' + escapeHtml(modelAddKindAvatar('chat')) + '</span><span class="mo-kind-label">对话</span>'
        + (chatPair ? '<span class="mo-status">已配置</span>' : (pairs.length ? '<span class="mo-status is-empty">未指定</span>' : '')) + '</div>'
        + '<div class="mo-card-body"><div class="mo-main">'
        + (chatPair ? '<div class="mo-model">' + escapeHtml(chatPair.model) + '</div>' : '')
        + '<div class="mo-sub">' + (chatProvider
            ? escapeHtml((chatProvider.name || '未命名') + ' · ' + modelProtocolLabel('chat', chatProvider) + ' · ' + (Array.isArray(chatProvider.selectedModels) ? chatProvider.selectedModels.length : 0) + ' 个可用模型')
            : '先到「我的模型」添加一家对话服务') + '</div>'
        + '</div><div class="mo-control">' + modelPickerHtml('chat', chatPickerLabel, chatPickerOptions, '切换对话模型') + '</div></div>'
        + '<div class="mo-fallback"><span class="mo-fb-label">失败回退</span>'
        + (fallbackChips || '<span class="mo-fb-empty">未设置，默认模型失败时不会自动切换</span>')
        + fallbackAdd + '</div></div>'
        + cards + '</div>';
    renderModelSectionTabs();
}

function modelEditingId(kind) {
    if (kind === 'chat') return chatProviderEditingId;
    if (kind === 'tts') return ttsProviderEditingId;
    if (kind === 'asr') return asrProviderEditingId;
    if (kind === 'embedding') return embeddingProviderEditingId;
    return rerankProviderEditingId;
}

function setModelEditingId(kind, id) {
    if (kind === 'chat') { chatProviderEditingId = id; return; }
    if (kind === 'tts') { ttsProviderEditingId = id; ttsProviderDetailOpen = Boolean(id); return; }
    if (kind === 'asr') { asrProviderEditingId = id; asrProviderDetailOpen = Boolean(id); return; }
    if (kind === 'embedding') { embeddingProviderEditingId = id; embeddingProviderDetailOpen = Boolean(id); return; }
    rerankProviderEditingId = id;
    rerankProviderDetailOpen = Boolean(id);
}

/** 切进“我的模型”时默认选中一家：右栏空着会像页面坏了，尤其是宽屏。 */
function ensureModelProviderSelection() {
    if (modelSectionView !== 'providers') return;
    // 窄屏是“一步一屏”：进「我的模型」先看列表，右栏详情只在点行之后出现；自动选中会把列表直接顶掉。
    if (window.innerWidth <= 980) return;
    const filterKind = modelFilter;
    if (filterKind) {
        modelSectionPage = filterKind;
        if (modelEditingId(filterKind)) return;
        const first = modelProviderList(filterKind)[0];
        if (first) setModelEditingId(filterKind, first.id);
        return;
    }
    if (modelEditingId(modelSectionPage)) return;
    for (const entry of MODEL_SECTION_ENTRIES) {
        const first = modelProviderList(entry.key)[0];
        if (first) {
            modelSectionPage = entry.key;
            setModelEditingId(entry.key, first.id);
            return;
        }
    }
    modelSectionPage = 'chat';
}

function setModelSectionView(view) {
    if (!MODEL_VIEW_PANES[view]) view = 'overview';
    if (view !== 'add') {
        modelAddState = null;
        document.getElementById('tab-model')?.classList.remove('is-add');
    }
    if (modelSectionView === 'providers' && view !== 'providers') {
        commitChatProviderDetail();
        commitTtsProviderDetail();
        commitAsrProviderDetail();
        commitSimpleProviderDetail('embedding');
        commitSimpleProviderDetail('rerank');
    }
    modelSectionView = view;
    if (view === 'providers' && window.innerWidth <= 980) {
        clearModelEditingState();
        modelSectionPage = modelFilter;
    }
    syncModelViewPanes();
    renderModelSectionTabs();
    if (view === 'providers') {
        renderModelPage();
    } else if (view === 'prefs') {
        renderChatBindings();
        if (typeof syncThinkingModeControls === 'function') syncThinkingModeControls();
        if (typeof syncSamplingControls === 'function') syncSamplingControls(null, true);
    } else {
        renderModelOverview();
    }
    const content = document.getElementById('settingsContent');
    if (content) content.scrollTop = 0;
}

function setModelFilter(filter) {
    commitChatProviderDetail();
    commitTtsProviderDetail();
    commitAsrProviderDetail();
    commitSimpleProviderDetail('embedding');
    commitSimpleProviderDetail('rerank');
    clearModelEditingState();
    modelFilter = MODEL_SECTION_LIST_PANE[filter] ? filter : 'chat';
    modelSectionPage = modelFilter;
    modelSectionView = 'providers';
    renderModelPage();
    const content = document.getElementById('settingsContent');
    if (content) content.scrollTop = 0;
}

async function applyModelBinding(kind, value) {
    const s = state.settings;
    if (kind === 'chat') {
        s.defaultChatModel = parseChatModelKey(value);
    } else if (kind === 'tts') {
        s.defaultTtsProviderId = String(value || '');
    } else if (kind === 'asr') {
        s.defaultAsrProviderId = String(value || '');
    } else if (kind === 'embedding') {
        s.defaultEmbeddingProviderId = String(value || '');
    } else if (kind === 'rerank') {
        s.defaultRerankProviderId = String(value || '');
    }
    // 先把旧控件同步到新值，再保存：saveSettings 会从这些 DOM 读回，晚一步就会把旧值写回去。
    renderChatBindings();
    if (kind === 'embedding' || kind === 'rerank') fillMemoryBindingSelects();
    renderModelOverview();
    await saveSettings({ silent: true });
}

async function addModelFallback(key) {
    const pair = parseChatModelKey(key);
    if (!pair.providerId || !pair.model) return;
    const s = state.settings;
    const chain = Array.isArray(s.fallbackChatModels) ? s.fallbackChatModels.slice() : [];
    if (chain.some((c) => chatModelKey(c) === key)) return;
    if (chatModelKey(s.defaultChatModel) === key) return;
    s.fallbackChatModels = chain.concat([pair]);
    renderChatBindings();
    renderModelOverview();
    await saveSettings({ silent: true });
}

async function removeModelFallback(key) {
    const s = state.settings;
    if (!Array.isArray(s.fallbackChatModels)) return;
    s.fallbackChatModels = s.fallbackChatModels.filter((c) => chatModelKey(c) !== key);
    renderChatBindings();
    renderModelOverview();
    await saveSettings({ silent: true });
}
// ---------- 添加模型：独立三步页 ----------
// 添加不再借“新建提供商”弹窗：类型 → 服务商 → 连接，三步各自只问一件事；协议在第三步自动识别。
const MODEL_ADD_CHAT_PRESETS = [
    { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'], protocol: 'openai-compatible' },
    { id: 'silicon', name: '硅基流动', url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct', models: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'], protocol: 'openai-compatible' },
    { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', models: ['gpt-4.1', 'gpt-4.1-mini', 'o4-mini'], protocol: 'openai-compatible' },
    { id: 'anthropic', name: 'Anthropic', url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'], protocol: 'anthropic' },
    { id: 'gemini', name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], protocol: 'openai-compatible' },
    { id: 'qwen', name: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'], protocol: 'openai-compatible' },
    { id: 'mimo', name: '小米 MiMo', url: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5', models: ['mimo-v2.5'], protocol: 'openai-compatible' }
];

let modelAddState = null;

function modelAddPresets(kind) {
    if (kind === 'chat') return MODEL_ADD_CHAT_PRESETS;
    if (kind === 'tts') {
        return TTS_PROTOCOL_PRESETS.map((p) => ({
            id: p.id,
            name: p.name,
            url: p.baseUrl || '',
            model: p.model || '',
            models: p.model ? [p.model] : [],
            protocol: p.id,
            fixed: !p.editableBaseUrl,
            hint: p.hint || ''
        }));
    }
    if (kind === 'asr') {
        return ASR_PROTOCOL_PRESETS.map((p) => ({
            id: p.id,
            name: p.name,
            url: p.baseUrl || '',
            model: p.model || '',
            models: p.model ? [p.model] : [],
            protocol: p.id,
            fixed: !p.editableBaseUrl,
            hint: p.hint || ''
        }));
    }
    if (kind === 'embedding') {
        return EMBEDDING_PROTOCOL_PRESETS.map((p) => ({
            id: p.id, name: p.name, url: p.baseUrl || '', model: p.model || '',
            models: p.model ? [p.model] : [], protocol: p.id, hint: p.hint || ''
        }));
    }
    return RERANK_PROTOCOL_PRESETS.map((p) => ({
        id: p.id, name: p.name, url: p.baseUrl || '', model: p.model || '',
        models: p.model ? [p.model] : [], protocol: p.id, hint: p.hint || ''
    }));
}

function modelAddKindAvatar(kind) {
    const meta = MODEL_SECTION_ENTRIES.find((entry) => entry.key === kind);
    return meta ? meta.name.slice(0, 1) : '＋';
}

function newModelAddState(kind) {
    return {
        step: kind ? 2 : 1,
        kind: kind || 'chat',
        presetId: '',
        name: '',
        url: '',
        key: '',
        model: '',
        models: [],
        detected: null,
        fixed: false,
        presetProtocol: '',
        setDefault: true,
        returnView: 'overview',
        returnFilter: 'chat'
    };
}

function openModelAddPage(kind) {
    commitChatProviderDetail();
    commitTtsProviderDetail();
    commitAsrProviderDetail();
    commitSimpleProviderDetail('embedding');
    commitSimpleProviderDetail('rerank');
    modelAddState = newModelAddState(kind);
    modelAddState.returnView = modelSectionView;
    modelAddState.returnFilter = modelFilter;
    modelSectionView = 'add';
    modelFilter = 'chat';
    modelSectionPage = 'chat';
    document.getElementById('tab-model')?.classList.add('is-add');
    syncModelViewPanes();
    renderModelAddPage();
    const content = document.getElementById('settingsContent');
    if (content) content.scrollTop = 0;
}

function closeModelAddPage() {
    const returnView = modelAddState ? modelAddState.returnView : 'overview';
    const returnFilter = modelAddState ? modelAddState.returnFilter : 'chat';
    modelAddState = null;
    document.getElementById('tab-model')?.classList.remove('is-add');
    modelSectionView = returnView === 'providers' ? 'providers' : 'overview';
    modelFilter = returnFilter;
    modelSectionPage = returnFilter;
    renderModelPage();
    const content = document.getElementById('settingsContent');
    if (content) content.scrollTop = 0;
}

function renderModelAddSteps() {
    const step = modelAddState.step;
    const labels = ['类型', '服务商', '连接'];
    let html = '<div class="model-add-steps">';
    for (let i = 1; i <= 3; i += 1) {
        if (i > 1) html += '<span class="model-add-step-line"></span>';
        const state = step === i ? ' is-on' : (step > i ? ' is-done' : '');
        html += '<span class="model-add-step' + state + '">'
            + '<span class="model-add-step-num">' + (step > i ? '✓' : i) + '</span>'
            + labels[i - 1] + '</span>';
    }
    return html + '</div>';
}

function renderModelAddKind() {
    return '<div class="model-add-section-title"><b>这属于哪类模型？</b><span>选完只需填连接信息</span></div>'
        + '<div class="model-add-kind-grid">'
        + MODEL_SECTION_ENTRIES.map((entry) => '<button type="button" class="model-add-kind-card" data-ma-kind="' + entry.key + '">'
            + '<span class="model-add-kind-avatar">' + escapeHtml(modelAddKindAvatar(entry.key)) + '</span>'
            + '<b>' + escapeHtml(entry.name) + '</b><span>' + escapeHtml(entry.desc || '') + '</span></button>').join('')
        + '</div>';
}

function renderModelAddPreset() {
    const kind = modelAddState.kind;
    const meta = MODEL_SECTION_ENTRIES.find((entry) => entry.key === kind);
    const list = modelAddPresets(kind);
    return '<div class="model-add-section-title"><b>选择' + escapeHtml((meta && meta.name) || '') + '服务商</b><span>内置地址与默认模型，之后仍可修改</span></div>'
        + '<div class="model-add-preset-grid">'
        + list.map((p) => '<button type="button" class="model-add-preset" data-ma-preset="' + escapeHtml(p.id) + '">'
            + '<span class="model-add-preset-logo">' + escapeHtml(p.name.slice(0, 1).toUpperCase()) + '</span>'
            + '<span class="model-add-preset-copy"><b>' + escapeHtml(p.name) + '</b><span>'
            + escapeHtml((p.model || p.hint || p.url || '固定端点')) + '</span></span></button>').join('')
        + '<button type="button" class="model-add-preset is-custom" data-ma-custom>'
        + '<span class="model-add-preset-logo">＋</span>'
        + '<span class="model-add-preset-copy"><b>自定义地址</b><span>任何兼容接口，协议自动识别</span></span></button>'
        + '</div>'
        + '<div class="model-add-foot"><button type="button" class="btn-secondary text-xs" data-ma-back>← 上一步</button></div>';
}

function renderModelAddModelChips() {
    const s = modelAddState;
    const preset = modelAddPresets(s.kind).find((p) => p.id === s.presetId);
    const models = s.models.length ? s.models : (preset && preset.models ? preset.models : []);
    if (!models.length) {
        return '<div class="model-add-chip-row"><span class="model-add-hint">保存后可在提供商详情里「获取模型」</span></div>';
    }
    return '<div class="model-add-chip-row">'
        + models.map((m) => '<button type="button" class="model-add-chip' + (m === s.model ? ' is-on' : '') + '" data-ma-model="' + escapeHtml(m) + '">'
            + (m === s.model ? '✓ ' : '') + escapeHtml(m) + '</button>').join('')
        + '</div>';
}

function renderModelAddForm() {
    const s = modelAddState;
    const meta = MODEL_SECTION_ENTRIES.find((entry) => entry.key === s.kind);
    return '<div class="model-add-card">'
        + '<div class="model-add-form-grid">'
        + '<div class="model-add-field"><label>名称</label>'
        + '<input class="modal-input" data-ma-name value="' + escapeHtml(s.name) + '" placeholder="如：DeepSeek / 中转 A"></div>'
        + '<div class="model-add-field"><label>模型</label>'
        + '<input class="modal-input" data-ma-model-input value="' + escapeHtml(s.model) + '" placeholder="如：deepseek-chat"></div>'
        + '<div class="model-add-field is-full"><label>接口地址</label>'
        + '<input class="modal-input" data-ma-url value="' + escapeHtml(s.url) + '" placeholder="https://api.deepseek.com/v1" ' + (s.fixed ? 'disabled' : '') + '>'
        + '<span class="model-add-hint">' + (s.fixed ? '官方固定端点，无需填写地址。' : '带版本段（如 /v1）。') + '</span></div>'
        + '<div class="model-add-field is-full"><label>API Key</label>'
        + '<input class="modal-input" data-ma-key type="password" autocomplete="new-password" value="' + escapeHtml(s.key) + '" placeholder="sk-...（只保存在本机）"></div>'
        + '</div>'
        + '<div class="model-add-field is-full"><label>可用模型</label>' + renderModelAddModelChips() + '</div>'
        + '<div class="model-add-foot">'
        + '<label class="model-add-check"><input type="checkbox" data-ma-default ' + (s.setDefault ? 'checked' : '') + '> 保存后设为「' + escapeHtml((meta && meta.name) || '') + '」默认</label>'
        + '<span class="model-add-spacer"></span>'
        + '<button type="button" class="btn-secondary text-xs" data-ma-back>← 上一步</button>'
        + '<button type="button" class="btn-primary text-xs" data-ma-submit>保存并打开</button>'
        + '</div></div>';
}

function renderModelAddPage() {
    const body = document.getElementById('modelAddBody');
    if (!body || !modelAddState) return;
    body.innerHTML = renderModelAddSteps()
        + (modelAddState.step === 1 ? renderModelAddKind()
            : modelAddState.step === 2 ? renderModelAddPreset()
                : renderModelAddForm());
}

function applyModelAddPreset(presetId) {
    const s = modelAddState;
    if (!s) return;
    const preset = modelAddPresets(s.kind).find((p) => p.id === presetId);
    if (!preset) return;
    s.presetId = preset.id;
    s.name = preset.name;
    s.url = preset.url || '';
    s.model = preset.model || '';
    s.models = Array.isArray(preset.models) ? preset.models.slice() : [];
    s.fixed = Boolean(preset.fixed);
    s.presetProtocol = preset.protocol || '';
    if (s.fixed) {
        s.detected = { id: preset.protocol, label: preset.name, keyOk: true };
    } else if (preset.protocol && s.kind === 'chat') {
        const format = CHAT_API_FORMATS[preset.protocol];
        s.detected = { id: preset.protocol, label: (format && format.label) || preset.protocol, keyOk: true };
    } else {
        s.detected = null;
    }
    s.step = 3;
    renderModelAddPage();
    if (!s.fixed) void runModelAddDetect();
}

function openModelAddCustom() {
    const s = modelAddState;
    if (!s) return;
    s.presetId = '';
    s.name = '';
    s.url = '';
    s.model = '';
    s.models = [];
    s.fixed = false;
    s.presetProtocol = '';
    s.detected = null;
    s.step = 3;
    renderModelAddPage();
}

let modelAddDetectTimer = null;

async function runModelAddDetect() {
    const s = modelAddState;
    if (!s || s.fixed) return;
    const base = String(s.url || '').trim().replace(/\/+$/, '');
    if (!base) {
        s.detected = null;
        return;
    }
    if (s.kind === 'chat' && !String(s.model || '').trim()) {
        s.detected = null;
        return;
    }
    if (s.kind === 'chat') {
        const hit = await detectChatProtocolForCreate(base, s.key, s.model.trim());
        if (hit) {
            s.detected = { id: hit.id, label: hit.label, keyOk: hit.keyOk };
        } else if (s.presetProtocol && CHAT_API_FORMATS[s.presetProtocol]) {
            s.detected = { id: s.presetProtocol, label: CHAT_API_FORMATS[s.presetProtocol].label, keyOk: false };
        } else {
            s.detected = null;
        }
    } else if (s.kind === 'tts') {
        const id = detectTtsProtocolByHost(base);
        const hit = TTS_PROTOCOL_PRESETS.find((p) => p.id === id);
        s.detected = { id, label: (hit && hit.name) || id, keyOk: true };
    } else if (s.kind === 'asr') {
        const id = detectAsrProtocolByHost(base);
        const hit = ASR_PROTOCOL_PRESETS.find((p) => p.id === id);
        s.detected = { id, label: (hit && hit.name) || id, keyOk: true };
    } else if (s.kind === 'embedding') {
        s.detected = { id: 'openai-compatible', label: 'OpenAI 兼容 /embeddings', keyOk: true };
    } else {
        s.detected = { id: 'rerank', label: '通用 /rerank', keyOk: true };
    }
}

function modelAddInput(attr, value, rerenderDetect) {
    const s = modelAddState;
    if (!s) return;
    if (attr === 'name') s.name = value;
    else if (attr === 'model') s.model = value;
    else if (attr === 'url') s.url = value;
    else if (attr === 'key') s.key = value;
    if (rerenderDetect) {
        clearTimeout(modelAddDetectTimer);
        modelAddDetectTimer = setTimeout(() => { void runModelAddDetect(); }, 420);
    }
}

async function createModelFromAdd() {
    const s = modelAddState;
    if (!s) return;
    if (!String(s.name || '').trim()) { showToast('请填写名称', { kind: 'warn' }); return; }
    if (!s.fixed && !String(s.url || '').trim()) { showToast('请填写接口地址', { kind: 'warn' }); return; }
    if (!String(s.model || '').trim()) { showToast('请填写模型名', { kind: 'warn' }); return; }
    let protocol = s.detected && s.detected.id ? s.detected.id : s.presetProtocol;
    if (!protocol && s.kind !== 'embedding' && s.kind !== 'rerank') {
        if (!s.fixed) await runModelAddDetect();
        protocol = (s.detected && s.detected.id) || s.presetProtocol;
    }
    if (!protocol && s.kind === 'chat') protocol = 'openai-compatible';
    if (!protocol && s.kind !== 'embedding' && s.kind !== 'rerank') {
        showToast('还没有识别出协议，请检查地址或模型名', { kind: 'warn' });
        return;
    }
    const initial = { name: s.name.trim(), baseUrl: s.url.trim(), apiKey: s.key.trim(), model: s.model.trim() };
    if (s.kind === 'chat') addChatProvider(protocol, initial);
    else if (s.kind === 'tts') addTtsProviderFromPreset(protocol, initial);
    else if (s.kind === 'asr') addAsrProviderFromPreset(protocol, initial);
    else addSimpleProvider(s.kind, initial);

    const newId = s.kind === 'chat' ? chatProviderEditingId
        : s.kind === 'tts' ? ttsProviderEditingId
            : s.kind === 'asr' ? asrProviderEditingId
                : s.kind === 'embedding' ? embeddingProviderEditingId : rerankProviderEditingId;
    if (newId && s.setDefault) {
        const settings = state.settings;
        if (s.kind === 'chat') {
            settings.defaultChatModel = { providerId: newId, model: String(s.model || '').trim() };
            renderChatBindings();
        } else if (s.kind === 'tts') settings.defaultTtsProviderId = newId;
        else if (s.kind === 'asr') settings.defaultAsrProviderId = newId;
        else if (s.kind === 'embedding') settings.defaultEmbeddingProviderId = newId;
        else settings.defaultRerankProviderId = newId;
        if (s.kind === 'embedding' || s.kind === 'rerank') fillMemoryBindingSelects();
        void saveSettings({ silent: true });
    }
    modelAddState = null;
    document.getElementById('tab-model')?.classList.remove('is-add');
    modelSectionView = 'providers';
    modelFilter = s.kind;
    modelSectionPage = s.kind;
    renderModelPage();
    const content = document.getElementById('settingsContent');
    if (content) content.scrollTop = 0;
    showToast('已添加「' + initial.name + '」', { kind: 'ok' });
}

// ---------- 设置二级页：整块替换分栏内容 ----------
// 供应商配置不再在卡片里原地展开，而是移到 #settingsSubpage 占满内容区；
// 返回时把节点移回它原来的位置，卡片恢复成列表。
let settingsSubpageNode = null;
let settingsSubpageOrigin = null;
// 当前二级页是不是「分区二级页」（手机「我的」把同一分栏的分区拆开用）：分区还原后必须保持可见，
// 不能像详情页那样补 hidden —— 否则分区会从分栏里消失。
let settingsSectionSubpageOpen = false;
// 分区二级页里跟在主分区后面的其余分区（如「人设与世界观」同页）：各记原位，关闭时按序还原。
let settingsSectionExtras = [];

function openSettingsSubpage(node) {
    const host = document.getElementById('settingsSubpage');
    const content = document.getElementById('settingsContent');
    if (!host || !content || !node) return;
    if (settingsSubpageNode && settingsSubpageNode !== node) closeSettingsSubpage();
    if (!settingsSubpageNode) {
        settingsSubpageOrigin = { parent: node.parentNode, next: node.nextSibling };
        settingsSubpageNode = node;
    }
    host.appendChild(node);
    node.classList.remove('hidden');
    host.classList.remove('hidden');
    content.classList.add('subpage-open');
    content.scrollTop = 0;
}

// 手机「我的」页把分栏分区装进独立二级页：只显示传入的分区（可多个，人设与世界观本是一起编辑的，同页），
// 返回时原位还原；桌面分区本来就铺开，不走这条。
function openSectionSubpage(sectionIds, title) {
    const ids = Array.isArray(sectionIds) ? sectionIds : [sectionIds];
    const nodes = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (!nodes.length) return false;
    openSettingsSubpage(nodes[0]);
    if (settingsSubpageNode !== nodes[0]) return false;
    settingsSectionExtras = nodes.slice(1).map((node) => ({
        node,
        parent: node.parentNode,
        next: node.nextSibling,
    }));
    const host = document.getElementById('settingsSubpage');
    settingsSectionExtras.forEach(({ node }) => host.appendChild(node));
    settingsSectionSubpageOpen = true;
    const titleEl = document.getElementById('settingsSubpageTitle');
    if (titleEl) titleEl.textContent = title || '';
    const head = document.getElementById('settingsSubpageHead');
    if (head) head.classList.remove('hidden');
    return true;
}

function closeSectionSubpageHead() {
    settingsSectionSubpageOpen = false;
    settingsSectionExtras.forEach(({ node, parent, next }) => {
        if (parent) parent.insertBefore(node, next && next.parentNode === parent ? next : null);
    });
    settingsSectionExtras = [];
    const head = document.getElementById('settingsSubpageHead');
    if (head) head.classList.add('hidden');
}

function closeSettingsSubpage() {
    const host = document.getElementById('settingsSubpage');
    const content = document.getElementById('settingsContent');
    const node = settingsSubpageNode;
    const isSectionPage = settingsSectionSubpageOpen;
    // 附加分区先还原：主分区的原位锚点可能就指向它（人设的下一个兄弟就是世界观），顺序反了主分区会被追加到分栏末尾。
    closeSectionSubpageHead();
    if (node) {
        const id = node.id;
        const origin = settingsSubpageOrigin;
        if (!isSectionPage) node.classList.add('hidden');
        if (origin && origin.parent) {
            origin.parent.insertBefore(node, origin.next && origin.next.parentNode === origin.parent ? origin.next : null);
        }
        settingsSubpageNode = null;
        settingsSubpageOrigin = null;

    }
    if (host) host.classList.add('hidden');
    if (content) content.classList.remove('subpage-open');
}

function findChatProviderById(id) {
    return (Array.isArray(state.settings.chatProviders) ? state.settings.chatProviders : [])
        .find((p) => p.id === id) || null;
}

/** 把详情页里那一个提供商的字段写回 state（切列表 / 返回 / 保存前都要先调它）。 */
function commitChatProviderDetail() {
    if (!chatProviderEditingId) return;
    const block = document.querySelector('#chatProviderCard .chat-provider-card');
    const prov = findChatProviderById(chatProviderEditingId);
    if (!block || !prov) return;
    prov.name = block.querySelector('.cpc-name')?.value.trim() || '未命名';
    prov.apiFormat = block.querySelector('.cpc-format')?.value || prov.apiFormat || 'openai-compatible';
    prov.baseUrl = block.querySelector('.cpc-baseurl')?.value.trim() || '';
    // 已配置模型由每行的加入/移除按钮直接写 state；这里只保证候选清单包含它们。
    prov.models = Array.from(new Set([
        ...(Array.isArray(prov.models) ? prov.models : []),
        ...(Array.isArray(prov.selectedModels) ? prov.selectedModels : [])
    ]));
    if (!state.settings.chatProviderKeys || typeof state.settings.chatProviderKeys !== 'object') {
        state.settings.chatProviderKeys = {};
    }
    state.settings.chatProviderKeys[prov.id] = block.querySelector('.cpc-key')?.value.trim() || '';
}

function openChatProviderDetail(id) {
    commitChatProviderDetail();
    chatProviderEditingId = id || '';
    modelSectionPage = 'chat';
    renderChatProviderCard();
    syncModelPageVisibility();
}

function backToChatProviderList() {
    commitChatProviderDetail();
    chatProviderEditingId = '';
    renderChatProviderCard();
    syncModelPageVisibility();
}

/** 手机顶栏返回键与详情内的「← 返回」走同一出口：回到当前类别的列表。 */
function backFromModelDetail() {
    if (modelSectionPage === 'tts') backToTtsProviderList();
    else if (modelSectionPage === 'asr') backToAsrProviderList();
    else if (modelSectionPage === 'embedding') backToSimpleProviderList('embedding');
    else if (modelSectionPage === 'rerank') backToSimpleProviderList('rerank');
    else backToChatProviderList();
}

function addChatProvider(formatId, initial = {}) {
    commitChatProviderDetail();
    const s = state.settings;
    if (!Array.isArray(s.chatProviders)) s.chatProviders = [];
    formatId = CHAT_API_FORMATS[formatId] ? formatId : 'openai-compatible';
    const preset = CHAT_API_FORMATS[formatId];
    const id = 'prov_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const model = String(initial.model || '').trim();
    s.chatProviders.push({
        id,
        name: String(initial.name || '').trim() || ('新供应商 ' + (s.chatProviders.length + 1)),
        apiFormat: formatId,
        baseUrl: String(initial.baseUrl || '').trim() || preset.defaultBaseUrl,
        models: model ? [model] : [],
        selectedModels: model ? [model] : []
    });
    if (String(initial.apiKey || '').trim()) setProviderSecret(id, initial.apiKey);
    if (!s.chatProviderKeys || typeof s.chatProviderKeys !== 'object') s.chatProviderKeys = {};
    chatProviderEditingId = id;
    renderChatProviderCard();
    syncModelPageVisibility();
    void saveSettings({ silent: true });
    // 新供应商直接进卡片：焦点落到名称上，改完就能往下填地址 / Key。
    window.setTimeout(() => {
        const input = document.querySelector('#chatProviderCard .chat-provider-card .cpc-name');
        if (!input) return;
        try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    }, 40);
}

function readChatProvidersFromDom() {
    // 右栏正显示某家的卡片时把它写回 state，再整体读出来。
    //   （刻意不再"逐个 DOM 块合并"：每多开一个页面就得同步一条，正是漏字段的来源。）
    commitChatProviderDetail();
    const s = state.settings;
    return {
        providers: (Array.isArray(s.chatProviders) ? s.chatProviders : []).map((p) => ({ ...p })),
        keys: { ...(s.chatProviderKeys && typeof s.chatProviderKeys === 'object' ? s.chatProviderKeys : {}) }
    };
}

function readProviderSettingsForm() {
    // 旧的单模型三件套（apiFormat/baseUrl/model/apiKey）已不是表单字段，只作迁移源，原样带过。
    const chat = readChatProvidersFromDom();
    const visionPairSelect = document.getElementById('settingVisionModelPair');
    const visionPair = visionPairSelect ? parseChatModelKey(visionPairSelect.value) : { providerId: '', model: '' };
    const isLegacyVision = Boolean(visionPairSelect && visionPair.providerId === LEGACY_VISION_PROVIDER);
    const memoryModelSelect = document.getElementById('settingMemoryModel');
    // 默认/回退的 DOM 现在在「模型」顶层页里：元素在就以 DOM 为准（比 state 新），
    // 元素不在（模型页没进出过）保留 state。
    // 语音四类的详情页正开着时，先把 DOM 草稿写回提供商对象；数组本体随下面的 ...state.settings 带过。
    commitTtsProviderDetail();
    commitAsrProviderDetail();
    commitSimpleProviderDetail('embedding');
    commitSimpleProviderDetail('rerank');
    return {
        ...state.settings,
        apiProvider: DEFAULT_SETTINGS.apiProvider,
        chatProviders: chat.providers,
        chatProviderKeys: chat.keys,
        defaultChatModel: document.getElementById('defaultChatModelSelect')
            ? parseChatModelKey(document.getElementById('defaultChatModelSelect')?.value)
            : (state.settings.defaultChatModel || { providerId: '', model: '' }),
        fallbackChatModels: document.getElementById('fallbackChainList')
            ? Array.from(document.querySelectorAll('#fallbackChainList .fbc-row'))
                .map((row) => parseChatModelKey(row.getAttribute('data-key')))
                .filter((p) => p.providerId && p.model)
            : (Array.isArray(state.settings.fallbackChatModels) ? state.settings.fallbackChatModels : []),
        // 不再是开关：下拉选了模型 = 开，选「不使用」= 关（显式清绑定）；下拉不在 DOM 里时保留 state。
        // 「独立地址」是下拉里的保留项：它没有 providerId，不能按"空 = 不使用"处理，否则升级后第一次保存就把它静默关掉。
        visionEnabled: visionPairSelect
            ? (isLegacyVision || Boolean(visionPair.providerId && visionPair.model))
            : (state.settings.visionEnabled === true),
        visionProviderId: isLegacyVision
            ? ''
            : (visionPairSelect ? visionPair.providerId : String(state.settings.visionProviderId || '')),
        visionModel: isLegacyVision
            ? String(state.settings.visionModel || '')
            : (visionPairSelect
                ? visionPair.model
                : String(state.settings.visionModel || '')),
        visionBaseUrl: String(state.settings.visionBaseUrl || ''),
        visionApiKey: String(state.settings.visionApiKey || ''),
        // 记忆整理三态：off = 关闭；'' = 沿用当前对话模型；具体键 = 单独指定的整理模型。控件缺失时保留 state，不误关记忆。
        autoMemory: memoryModelSelect ? memoryModelSelect.value !== 'off' : Boolean(state.settings.autoMemory),
        memoryModelPair: (memoryModelSelect && memoryModelSelect.value && memoryModelSelect.value !== 'off')
            ? parseChatModelKey(memoryModelSelect.value)
            : (memoryModelSelect ? null : (state.settings.memoryModelPair || null))
    };
}

// 联网搜索回填：漏回填的表现是"用户填的 Key 打开设置页就变成空的"，下一次保存就把空值写回去。
function fillTavilySettings() {
    const enabled = state.settings.tavilySearchEnabled === true;
    if (elements.settingTavilyEnabled) elements.settingTavilyEnabled.checked = enabled;
    if (elements.settingSearchProvider) {
        const sel = elements.settingSearchProvider;
        const current = SEARCH_PROVIDERS[state.settings.searchProvider] ? state.settings.searchProvider : DEFAULT_SEARCH_PROVIDER;
        const wanted = Object.keys(SEARCH_PROVIDERS).map((id) => [id, SEARCH_PROVIDERS[id].label]);
        const same = sel.options.length === wanted.length
            && wanted.every(([id, label], i) => sel.options[i] && sel.options[i].value === id && sel.options[i].textContent === label);
        if (!same) {
            sel.innerHTML = '';
            for (const [id, label] of wanted) {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = label;
                sel.appendChild(opt);
            }
        }
        sel.value = current;
    }
    if (elements.settingTavilyMaxResults) {
        elements.settingTavilyMaxResults.value = String(state.settings.tavilyMaxResults || 5);
    }
    if (elements.settingTavilySearchDepth) {
        elements.settingTavilySearchDepth.value = state.settings.tavilySearchDepth === 'advanced' ? 'advanced' : 'basic';
    }
    fillSearchProviderFields();
    if (elements.tavilyFields) elements.tavilyFields.classList.toggle('hidden', !enabled);
    updateTavilyHint();
}

/** 直接填「独立地址 + Key」的视觉配置在提供商池里没有对应项（visionProviderId 为空），
    下拉里用一个保留键代表它，否则升级后它既显示不出来、又会在保存时被当成"不使用"关掉。 */
const LEGACY_VISION_PROVIDER = '__legacy_vision__';

function legacyVisionModel() {
    const s = state.settings;
    if (!String(s.visionBaseUrl || '').trim() || !String(s.visionApiKey || '').trim()) return '';
    return String(s.visionModel || '').trim();
}

/** 视觉模型下拉：候选与一级「默认模型」同一份（提供商 × 已勾选模型），不另配一套模型名。 */
function visionModelPairOptions() {
    const out = chatModelPairOptions(Array.isArray(state.settings.chatProviders) ? state.settings.chatProviders : []);
    const legacy = legacyVisionModel();
    if (legacy) {
        out.push({
            key: chatModelKey({ providerId: LEGACY_VISION_PROVIDER, model: '' }),
            providerId: LEGACY_VISION_PROVIDER,
            model: '',
            label: '独立地址 · ' + legacy
        });
    }
    return out;
}

/** 当前视觉配置对应的下拉键；只存了模型名（旧数据）时按模型名在库里反查一家。 */
function currentVisionPairKey() {
    const s = state.settings;
    const model = String(s.visionModel || '').trim();
    if (!model) return '';
    const providerId = String(s.visionProviderId || '');
    if (providerId) return chatModelKey({ providerId, model });
    // 没有 providerId 但独立地址可用：只有开关确实开着才算"选中旧配置"，关着时仍显示「不使用」。
    if (legacyVisionModel() && s.visionEnabled === true) {
        return chatModelKey({ providerId: LEGACY_VISION_PROVIDER, model: '' });
    }
    const hit = visionModelPairOptions().find((o) => o.model === model);
    return hit ? hit.key : '';
}

function fillVisionModelPairOptions() {
    const pairs = visionModelPairOptions();
    fillChatProviderSelect(
        document.getElementById('settingVisionModelPair'),
        pairs,
        currentVisionPairKey(),
        '不使用图片转述'
    );
}

/** 记忆整理模型下拉：off = 关闭；'' = 沿用当前对话模型；其余 = 「对话模型」已勾选的提供商 × 模型。 */
function fillMemoryModelSelect() {
    const select = document.getElementById('settingMemoryModel');
    if (!select) return;
    select.innerHTML = '';
    const option = (value, text) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        select.appendChild(o);
    };
    option('off', '关闭');
    option('', '沿用当前对话模型');
    const s = state.settings;
    chatModelPairOptions(Array.isArray(s.chatProviders) ? s.chatProviders : []).forEach((p) => option(p.key, p.label));
    if (!s.autoMemory) {
        select.value = 'off';
        return;
    }
    // 存的对失效（提供商被删/模型取消勾选）时不强行选中：显示回落到「沿用当前对话模型」，
    // 请求侧 memoryChatSettings 也按同一口径回落，下次保存顺手把失效对清掉。
    const key = s.memoryModelPair ? chatModelKey(s.memoryModelPair) : '';
    select.value = Array.from(select.options).some((o) => o.value === key) ? key : '';
}

/** 记忆召回的嵌入 / 重排序绑定：选项来自各自分类的提供商池，写入的是总览绑定同一个键。
    空值 = 该环节不启用（与 defaultEmbeddingProviderId 的既有语义一致），不额外造开关。 */
function fillMemoryBindingSelects() {
    const s = state.settings;
    const fill = (selectId, hintId, kind, keyName) => {
        const select = document.getElementById(selectId);
        if (!select) return;
        const list = Array.isArray(s[kind + 'Providers']) ? s[kind + 'Providers'] : [];
        const head = select.querySelector('option[value=""]');
        const emptyText = head ? head.textContent : '不使用';
        select.innerHTML = '';
        const add = (value, text) => {
            const o = document.createElement('option');
            o.value = value;
            o.textContent = text;
            select.appendChild(o);
        };
        add('', emptyText);
        list.forEach((p) => add(p.id, (p.name || '未命名') + (p.model ? ' · ' + p.model : '')));
        // 对话模型兜底只留一个「沿用当前对话使用的模型」：具体是哪一对由会话绑定或默认模型在请求时解析，不再逐项钉死。
        const chatPairs = chatModelPairOptions(Array.isArray(s.chatProviders) ? s.chatProviders : []);
        if (chatPairs.length) add(chatCurrentBindingValue(), '沿用当前对话使用的模型');
        const current = String(s[keyName] || '');
        select.value = Array.from(select.options).some((o) => o.value === current) ? current : '';
        const hint = document.getElementById(hintId);
        if (hint) {
            hint.textContent = isChatModelBinding(current)
                ? '当前用对话模型代替，效果与成本都不如专用模型。'
                : (list.length
                    ? ''
                    : '还没有' + (kind === 'embedding' ? '嵌入' : '重排序') + '提供商 → 去「模型 → '
                        + (kind === 'embedding' ? '嵌入' : '重排序') + '」添加一个，或从下拉里选对话模型兜底');
        }
    };
    fill('settingMemoryEmbeddingProvider', 'memoryEmbeddingHint', 'embedding', 'defaultEmbeddingProviderId');
    fill('settingMemoryRerankProvider', 'memoryRerankHint', 'rerank', 'defaultRerankProviderId');
}

/** 图片转述实际用的地址 / Key / 模型：取选中的对话模型提供商；未选中（或缺模型）时走单独填写的地址与 Key。 */
function resolveVisionConfig() {
    const s = state.settings;
    const model = String(s.visionModel || '').trim();
    const providerId = String(s.visionProviderId || '');
    const providers = Array.isArray(s.chatProviders) ? s.chatProviders : [];
    const prov = providerId ? providers.find((p) => p.id === providerId) : null;
    if (prov && model) {
        const keys = s.chatProviderKeys && typeof s.chatProviderKeys === 'object' ? s.chatProviderKeys : {};
        return { baseUrl: String(prov.baseUrl || '').trim(), apiKey: String(keys[prov.id] || '').trim(), model };
    }
    return {
        baseUrl: String(s.visionBaseUrl || '').trim(),
        apiKey: String(s.visionApiKey || '').trim(),
        model
    };
}

function visionReady() {
    const cfg = resolveVisionConfig();
    return Boolean(cfg.baseUrl && cfg.model);
}

function visionConfigured() {
    return state.settings.visionEnabled === true && visionReady();
}

function fillVisionSettings() {
    fillVisionModelPairOptions();
    updateVisionMainModelHint();
}

// 切服务商前把输入框里尚未保存的 Key 收回它所属那一格，否则切回来时 A 家的 Key 就没了。
let lastSearchProviderId = '';
function stashCurrentSearchKey() {
    const input = elements.settingTavilyApiKey;
    if (!input) return;
    // 必须存到切换前那一家：change 事件触发时 sel.value 已是新服务商，用它会覆盖新家的 Key。
    const id = lastSearchProviderId || DEFAULT_SEARCH_PROVIDER;
    state.settings['searchApiKey_' + id] = String(input.value || '').trim();
}

function fillSearchProviderFields() {
    const id = elements.settingSearchProvider?.value || DEFAULT_SEARCH_PROVIDER;
    const def = SEARCH_PROVIDERS[id] || SEARCH_PROVIDERS[DEFAULT_SEARCH_PROVIDER];
    lastSearchProviderId = SEARCH_PROVIDERS[id] ? id : DEFAULT_SEARCH_PROVIDER;
    if (elements.settingTavilyApiKey) {
        elements.settingTavilyApiKey.value = state.settings['searchApiKey_' + id] || '';
        elements.settingTavilyApiKey.placeholder = def.keyHint || '';
    }
    if (elements.searchKeyLabel) elements.searchKeyLabel.textContent = def.label + ' API Key';
    if (elements.searchKeyHint) {
        elements.searchKeyHint.innerHTML = '';
        if (def.keyUrl) {
            elements.searchKeyHint.appendChild(document.createTextNode('在 '));
            const link = document.createElement('code');
            link.className = 'text-dim';
            link.textContent = def.keyUrl;
            elements.searchKeyHint.appendChild(link);
            elements.searchKeyHint.appendChild(document.createTextNode(' 注册后可在控制台拿到 Key。'));
        } else {
            elements.searchKeyHint.appendChild(document.createTextNode('填你自己的搜索服务提供的 Key。'));
        }
        elements.searchKeyHint.appendChild(document.createTextNode((def.freeNote || '') + 'Key 只存在本机。'));
    }
    if (elements.searchProviderHint) {
        elements.searchProviderHint.textContent = def.freeNote || '';
    }
    fillCustomSearchFields(id);
}

function fillCustomSearchFields(id) {
    const isCustom = id === 'custom';
    if (elements.searchCustomFields) elements.searchCustomFields.classList.toggle('hidden', !isCustom);
    if (!isCustom) return;
    if (elements.settingSearchCustomEndpoint) elements.settingSearchCustomEndpoint.value = state.settings.searchCustomEndpoint || '';
    if (elements.settingSearchCustomAuth) elements.settingSearchCustomAuth.value = state.settings.searchCustomAuth || 'bearer';
    if (elements.settingSearchCustomAuthHeader) {
        elements.settingSearchCustomAuthHeader.value = state.settings.searchCustomAuthHeader || 'Authorization';
    }
    if (elements.settingSearchCustomBody) elements.settingSearchCustomBody.value = state.settings.searchCustomBody || '';
    if (elements.settingSearchCustomResultsPath) {
        elements.settingSearchCustomResultsPath.value = state.settings.searchCustomResultsPath || '';
    }
    updateCustomAuthRow();
}

function updateCustomAuthRow() {
    if (!elements.settingSearchCustomHeaderRow || !elements.settingSearchCustomAuth) return;
    elements.settingSearchCustomHeaderRow.classList.toggle('hidden', elements.settingSearchCustomAuth.value !== 'raw');
}

function updateTavilyHint() {
    if (!elements.tavilyHint) return;
    const enabled = elements.settingTavilyEnabled ? elements.settingTavilyEnabled.checked : false;
    // Key 判据看当前服务商那一格（state），不能看输入框——输入框切服务商时会被重填。
    const id = elements.settingSearchProvider?.value || DEFAULT_SEARCH_PROVIDER;
    const hasKey = Boolean(String(state.settings['searchApiKey_' + id] || '').trim());
    let text;
    if (!enabled) text = '关着的时候 AI 看不到这个能力，也不会发起任何搜索请求。';
    else if (!hasKey) text = '已打开，但还没填 Key —— 现在 AI 仍然搜不了，填上之后立刻可用。';
    else text = '已就绪：AI 觉得需要查最新信息时会自己搜一次，并把结果当作资料回答（会注明出处）。';
    elements.tavilyHint.textContent = text;
}

// 测一次搜索服务商：必须真发一次查询（没有公开 /health，"Key 有效"与"还有额度"也是两件事）。
// 不抛 ClientApiError：那套文案是给对话模型用的（Base URL / 模型名），搜索既没有也不该去改。
async function testTavilyConnection() {
    await withSettingsTestButton(elements.testTavilyBtn, '测试中…', async () => {
        const id = elements.settingSearchProvider?.value || DEFAULT_SEARCH_PROVIDER;
        const def = SEARCH_PROVIDERS[id] || SEARCH_PROVIDERS[DEFAULT_SEARCH_PROVIDER];
        const key = String(document.getElementById('settingTavilyApiKey')?.value || '').trim();
        if (!key) {
            showCustomAlert('请先填写 ' + def.label + ' 的 API Key。', '还没填 Key');
            return;
        }
        const endpoint = resolveSearchEndpoint(def);
        if (!endpoint) {
            showCustomAlert('请先在下面填写自定义搜索源的地址（https:// 开头）。', '还没填地址');
            return;
        }
        if (!/^https:\/\//i.test(endpoint)) {
            showCustomAlert('自定义搜索源的地址必须以 https:// 开头。\n\nKey 会随请求发出去，明文 http 等于把 Key 交给链路上的任何人。', '地址不安全');
            return;
        }
        let result;
        try {
            result = await postJsonFromDevice(
                endpoint,
                def.buildBody('连接测试', { maxResults: 1, depth: 'basic' }),
                def.buildHeaders(key),
                { timeoutMs: 20000 }
            );
        } catch (err) {
            const altId = alternateSearchProviderId(id);
            showCustomAlert(
                def.label + ' 连不上：\n' + String((err && err.message) || err)
                + '\n\n' + (altId
                    ? '可以直接把「搜索服务商」换成 ' + SEARCH_PROVIDERS[altId].label + '（你已经填过它的 Key）。'
                    : '换个网络环境再试，或在下面换一家服务商并填上它的 Key。'),
                def.label + ' 连不上'
            );
            return;
        }
        const bizCode = String(result.payload?.code || '').trim();
        const status = result.status || Number(bizCode) || 0;
        if (!result.ok || /^[45]\d\d$/.test(bizCode)) {
            const detail = String(
                result.payload?.detail?.error || result.payload?.detail || result.payload?.error
                || result.payload?.message || result.rawText || ''
            ).slice(0, 300);
            const info = describeSearchFailure(status, detail, def);
            const altId = alternateSearchProviderId(id);
            const advice = info.switchable && altId
                ? '\n\n可以先把「搜索服务商」换成 ' + SEARCH_PROVIDERS[altId].label + '（你已经填过它的 Key），那边还有额度就能继续搜。'
                : (info.switchable ? '\n\n换一家服务商并填上它的 Key 就能继续搜。' : '');
            showCustomAlert(
                def.label + ' 返回 HTTP ' + status + (info.hint ? '\n\n' + info.hint : '')
                + (detail ? '\n\n服务商返回：' + detail : '') + advice,
                info.switchable ? '这一家暂时用不了' : '测试失败'
            );
            return;
        }
        const count = (def.parse(result.payload || {}).items || []).length;
        showCustomAlert(def.label + ' 可用，测试查询返回了 ' + count + ' 条结果。', '联网搜索正常');
    });
}

async function withSettingsTestButton(button, runningText, callback) {
    if (!button || button.disabled) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = runningText;
    try { await callback(); }
    catch (error) { showClientApiError(error); }
    finally { button.disabled = false; button.textContent = originalText; }
}

// 块内「测试」：按块内当前值拼草稿发一条极小消息（未保存也能测），maxTokens 给 256 ——
// 思考型模型给太少会全花在 reasoning 上，思考完还能留下可见的 "OK"，测试不会假红。
async function testChatProviderBlock(block, btn, model) {
    const target = String(model || '').trim();
    const draft = {
        ...state.settings,
        apiFormat: block.querySelector('.cpc-format')?.value || 'openai-compatible',
        baseUrl: block.querySelector('.cpc-baseurl')?.value.trim() || '',
        model: target,
        apiKey: block.querySelector('.cpc-key')?.value.trim() || ''
    };
    await withSettingsTestButton(btn, '测试中…', async () => {
        if (!draft.baseUrl) throw new ClientApiError('APP_BAD_URL', '请先填写 API Base URL');
        if (!draft.model) throw new ClientApiError('APP_BAD_URL', '没有可检测的模型');
        const reply = await callChatAPI([
            { role: 'system', content: '这是连接测试。' },
            { role: 'user', content: '只回复 OK' }
        ], { maxTokens: 256, temperature: 0 }, draft);
        if (!reply.trim()) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '对话接口返回了空内容');
        showCustomAlert(`模型「${target}」连接成功，返回：${reply.trim()}`, '对话连接正常');
    });
}

/** 从这家提供商里移除一个模型：默认指向 / 回退链 / 视觉与记忆绑定都要同步让位。 */
function removeChatProviderModelById(id, model) {
    const s = state.settings;
    const prov = (s.chatProviders || []).find((p) => p.id === id);
    if (!prov) return;
    prov.selectedModels = (Array.isArray(prov.selectedModels) ? prov.selectedModels : []).filter((m) => m !== model);
    if (s.defaultChatModel && s.defaultChatModel.providerId === id && s.defaultChatModel.model === model) {
        const next = prov.selectedModels[0] || '';
        s.defaultChatModel = next ? { providerId: id, model: next } : { providerId: '', model: '' };
    }
    s.fallbackChatModels = (s.fallbackChatModels || []).filter((c) => !(c.providerId === id && c.model === model));
    if (s.visionProviderId === id && s.visionModel === model) { s.visionProviderId = ''; s.visionModel = ''; }
    if (s.memoryModelPair && s.memoryModelPair.providerId === id && s.memoryModelPair.model === model) s.memoryModelPair = null;
}

/** 行内删除对话提供商：先提交编辑中的卡片草稿，再清这家（Key / 默认指向 / 回退链 / 视觉与记忆绑定一并清）。 */
async function deleteChatProviderById(id) {
    const s = state.settings;
    const prov = (s.chatProviders || []).find((p) => p.id === id);
    const ok = await showCustomConfirm('删除提供商「' + ((prov && prov.name) || '未命名') + '」？\n\n它的 API Key 与勾选的模型也会一并清掉。');
    if (!ok) return;
    commitChatProviderDetail();
    s.chatProviders = (s.chatProviders || []).filter((p) => p.id !== id);
    if (s.chatProviderKeys && typeof s.chatProviderKeys === 'object') delete s.chatProviderKeys[id];
    if (s.defaultChatModel && s.defaultChatModel.providerId === id) s.defaultChatModel = { providerId: '', model: '' };
    s.fallbackChatModels = (s.fallbackChatModels || []).filter((c) => c.providerId !== id);
    if (s.visionProviderId === id) { s.visionProviderId = ''; s.visionModel = ''; }
    if (s.memoryModelPair && s.memoryModelPair.providerId === id) s.memoryModelPair = null;
    // 删掉的是正在编辑的那一家：右栏退回默认视图
    if (chatProviderEditingId === id) chatProviderEditingId = '';
    renderChatProviderSettings();
    syncModelPageVisibility();
    await saveSettings({ silent: true });
}

function applyChatProviderEditorToState() {
    const chat = readChatProvidersFromDom();
    state.settings.chatProviders = chat.providers;
    state.settings.chatProviderKeys = chat.keys;
}

function bindChatProviderSettingsUI() {
    // 对话：右栏默认视图（默认模型 / 回退链）的操作。
    const bindings = document.getElementById('chatBindingSection');
    if (bindings) {
        bindings.addEventListener('click', async (ev) => {
            const s = state.settings;
            if (ev.target.closest('#fallbackAddBtn')) {
                const sel = document.getElementById('fallbackAddSelect');
                const key = sel.value;
                if (!key) return;
                const pair = parseChatModelKey(key);
                const already = (s.fallbackChatModels || []).some((c) => chatModelKey(c) === key);
                if (!pair.providerId || !pair.model || already) return;
                s.fallbackChatModels = [...(s.fallbackChatModels || []), pair];
                renderChatBindings();
                await saveSettings({ silent: true });
                return;
            }
            const fRow = ev.target.closest('.fbc-row');
            if (fRow) {
                const key = fRow.getAttribute('data-key');
                const chain = [...(s.fallbackChatModels || [])];
                const i2 = chain.findIndex((c) => chatModelKey(c) === key);
                if (i2 < 0) return;
                if (ev.target.closest('.fbc-up') && i2 > 0) {
                    [chain[i2 - 1], chain[i2]] = [chain[i2], chain[i2 - 1]];
                } else if (ev.target.closest('.fbc-down') && i2 < chain.length - 1) {
                    [chain[i2 + 1], chain[i2]] = [chain[i2], chain[i2 + 1]];
                } else if (ev.target.closest('.fbc-remove')) {
                    chain.splice(i2, 1);
                } else {
                    return;
                }
                s.fallbackChatModels = chain;
                renderChatBindings();
                await saveSettings({ silent: true });
            }
        });
    }

    // 对话：右栏卡片上的操作（获取模型 / 手动加模型 / 测试 / 删除）。
    const card = document.getElementById('chatProviderCard');
    if (card) {
        card.addEventListener('click', async (ev) => {
            const block = ev.target.closest('.chat-provider-card');
            if (!block) return;
            const id = block.getAttribute('data-provider-id');
            const s = state.settings;
            if (ev.target.closest('.cpc-fetch')) {
                const btn = ev.target.closest('.cpc-fetch');
                const old = btn.textContent;
                btn.disabled = true;
                btn.textContent = '⏳ 获取中…';
                try {
                    const models = await fetchModelList(
                        block.querySelector('.cpc-baseurl').value,
                        block.querySelector('.cpc-key').value,
                        block.querySelector('.cpc-format').value
                    );
                    if (!models.length) throw new Error('接口未返回模型列表（data 为空），可能该服务不支持 /models');
                    applyChatProviderEditorToState();
                    const prov = s.chatProviders.find((p) => p.id === id);
                    if (prov) prov.models = Array.from(new Set([...(prov.models || []), ...models]));
                    renderChatProviderSettings();
                } catch (err) {
                    const detail = String(err?.message || err);
                    const isNetwork = /Failed to fetch|NetworkError|Load failed/i.test(detail);
                    showCustomAlert(
                        '获取模型列表失败：' + detail
                        + (isNetwork ? '\n\n（浏览器直连被跨域拦截且本机中转不可用）' : '')
                        + '\n\n拉不到列表也可以在下方手动输入模型名添加。',
                        '获取模型');
                } finally {
                    btn.disabled = false;
                    btn.textContent = old;
                }
                return;
            }
            if (ev.target.closest('.cpc-add-model')) {
                const input = block.querySelector('.cpc-manual-model');
                const model = String(input.value || '').trim();
                if (!model) return;
                applyChatProviderEditorToState();
                const prov = s.chatProviders.find((p) => p.id === id);
                if (prov) {
                    prov.models = Array.from(new Set([...(prov.models || []), model]));
                    prov.selectedModels = Array.from(new Set([...(prov.selectedModels || []), model]));
                }
                renderChatProviderSettings();
                void saveSettings({ silent: true });
                return;
            }
            if (ev.target.closest('.cpc-enable-model')) {
                const model = ev.target.closest('.cpc-enable-model').getAttribute('data-cpc-model');
                if (!model) return;
                applyChatProviderEditorToState();
                const prov = s.chatProviders.find((p) => p.id === id);
                if (prov) {
                    prov.models = Array.from(new Set([...(prov.models || []), model]));
                    prov.selectedModels = Array.from(new Set([...(prov.selectedModels || []), model]));
                }
                renderChatProviderSettings();
                await saveSettings({ silent: true });
                return;
            }
            if (ev.target.closest('.cpc-remove-model')) {
                const model = ev.target.closest('.cpc-remove-model').getAttribute('data-cpc-model');
                if (!model) return;
                applyChatProviderEditorToState();
                removeChatProviderModelById(id, model);
                renderChatProviderSettings();
                await saveSettings({ silent: true });
                return;
            }
            if (ev.target.closest('.cpc-test-model')) {
                const model = ev.target.closest('.cpc-test-model').getAttribute('data-cpc-model');
                await testChatProviderBlock(block, ev.target.closest('.cpc-test-model'), model);
                return;
            }
            if (ev.target.closest('.cpc-delete')) {
                await deleteChatProviderById(id);
                return;
            }

        });
    }
    // 模型三段式：总览 / 我的模型 / 使用偏好。三段共用同一份 state，切段只换显隐，不重做一套读写。
    document.getElementById('modelSectionTabs')?.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-model-view]');
        if (btn) setModelSectionView(btn.getAttribute('data-model-view'));
    });
    document.getElementById('modelFilterNav')?.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-model-filter]');
        if (btn) setModelFilter(btn.getAttribute('data-model-filter'));
    });
    document.getElementById('modelAddModelBtn')?.addEventListener('click', () => {
        // 顶部「添加模型」从类型选择开始；分类里的「＋ 新增」才带着类型直接进服务商。
        openModelAddPage();
    });
    document.getElementById('modelOverviewCards')?.addEventListener('click', (ev) => {
        const rm = ev.target.closest('[data-mo-fallback-remove]');
        if (rm) { void removeModelFallback(rm.getAttribute('data-mo-fallback-remove')); return; }
        const toggle = ev.target.closest('.mo-picker-btn');
        if (toggle) {
            const picker = toggle.closest('.mo-picker');
            const menu = picker ? picker.querySelector('.mo-picker-menu') : null;
            if (!menu) return;
            const willOpen = menu.classList.contains('hidden');
            closeModelPickers();
            if (willOpen) {
                menu.classList.remove('hidden');
                toggle.setAttribute('aria-expanded', 'true');
            }
            return;
        }
        const opt = ev.target.closest('.mo-picker-option');
        if (opt) {
            const picker = opt.closest('.mo-picker');
            const kind = picker ? picker.getAttribute('data-mo-picker') : '';
            const value = opt.getAttribute('data-mo-value') || '';
            closeModelPickers();
            if (kind === 'fallback') { if (value) void addModelFallback(value); }
            else if (kind) void applyModelBinding(kind, value);
        }
    });
    // 浮层菜单不是原生 select，点击空白或按 Esc 要自己收。
    document.addEventListener('click', (ev) => {
        if (!ev.target.closest('.mo-picker')) closeModelPickers();
    });
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') closeModelPickers();
    });

    // 添加模型页：三步内的点击与表单输入。协议识别复用 detect* 函数，不再经过旧弹窗。
    document.getElementById('modelAddBackBtn')?.addEventListener('click', () => closeModelAddPage());
    document.getElementById('modelAddBody')?.addEventListener('click', (ev) => {
        const kindBtn = ev.target.closest('[data-ma-kind]');
        if (kindBtn && modelAddState) {
            modelAddState.kind = kindBtn.getAttribute('data-ma-kind');
            modelAddState.step = 2;
            renderModelAddPage();
            return;
        }
        const presetBtn = ev.target.closest('[data-ma-preset]');
        if (presetBtn) { applyModelAddPreset(presetBtn.getAttribute('data-ma-preset')); return; }
        if (ev.target.closest('[data-ma-custom]')) { openModelAddCustom(); return; }
        if (ev.target.closest('[data-ma-back]')) {
            if (!modelAddState) return;
            if (modelAddState.step > 1) {
                modelAddState.step -= 1;
                renderModelAddPage();
            } else {
                closeModelAddPage();
            }
            return;
        }
        if (ev.target.closest('[data-ma-submit]')) { void createModelFromAdd(); return; }
        const chip = ev.target.closest('[data-ma-model]');
        if (chip && modelAddState) {
            modelAddState.model = chip.getAttribute('data-ma-model');
            renderModelAddPage();
        }
    });
    document.getElementById('modelAddBody')?.addEventListener('input', (ev) => {
        const t = ev.target;
        if (!t || !t.matches || !modelAddState) return;
        if (t.matches('[data-ma-name]')) modelAddInput('name', t.value, false);
        else if (t.matches('[data-ma-model-input]')) modelAddInput('model', t.value, true);
        else if (t.matches('[data-ma-url]')) modelAddInput('url', t.value, true);
        else if (t.matches('[data-ma-key]')) modelAddInput('key', t.value, false);
    });
    document.getElementById('modelAddBody')?.addEventListener('change', (ev) => {
        if (ev.target && ev.target.matches && ev.target.matches('[data-ma-default]') && modelAddState) {
            modelAddState.setDefault = ev.target.checked;
        }
    });

    document.getElementById('chatCardBack')?.addEventListener('click', () => backToChatProviderList());

    // 栏头「＋ 新增」：五类统一进入独立的三步添加页。
    document.getElementById('modelPaneList')?.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.model-add-btn');
        if (!btn) return;
        openModelAddPage(btn.getAttribute('data-model-add') || '');
    });

    // 默认模型换了，图片转述的候选与「原模型能识图」提示同步刷新。
    document.getElementById('defaultChatModelSelect')?.addEventListener('change', () => {
        fillVisionModelPairOptions();
        // 这里读 DOM 而不是 activeChatSettings()：自动保存有 300ms 防抖，state 此刻还是旧模型。
        const pair = parseChatModelKey(document.getElementById('defaultChatModelSelect')?.value);
        updateVisionMainModelHint(pair.model);
    });

    // 文字转语音 / 语音转文字 / 嵌入 / 重排序：详情的返回与操作按钮。
    document.getElementById('ttsProviderBack')?.addEventListener('click', () => backToTtsProviderList());
    document.getElementById('asrProviderBack')?.addEventListener('click', () => backToAsrProviderList());
    document.getElementById('embeddingProviderBack')?.addEventListener('click', () => backToSimpleProviderList('embedding'));
    document.getElementById('rerankProviderBack')?.addEventListener('click', () => backToSimpleProviderList('rerank'));
    document.getElementById('ttsProviderTest')?.addEventListener('click', () => { void testTtsProviderDraft(); });
    document.getElementById('asrProviderTest')?.addEventListener('click', () => { void testAsrProviderDraft(); });
    document.getElementById('embeddingProviderTest')?.addEventListener('click', () => { void testEmbeddingProviderDraft(); });
    document.getElementById('embeddingFetchModelsBtn')?.addEventListener('click', () => { void fetchSimpleProviderModels('embedding'); });
    document.getElementById('rerankProviderTest')?.addEventListener('click', () => { void testRerankProviderDraft(); });
    document.getElementById('rerankFetchModelsBtn')?.addEventListener('click', () => { void fetchSimpleProviderModels('rerank'); });

    // 视口宽度变化时重跑双栏显隐同步（窄屏由 CSS 堆叠，这里维持分类导航与节点显隐一致）。
    try {
        const modelMq = window.matchMedia('(max-width: 980px)');
        if (modelMq && modelMq.addEventListener) modelMq.addEventListener('change', () => syncModelPageVisibility());
    } catch (e) { /* 老 WebView 没有 addEventListener 时只在切栏时同步 */ }

    // 分区二级页（手机「我的」拆分栏用）的返回：还原分区到原分栏。
    document.getElementById('settingsSubpageBack')?.addEventListener('click', () => closeSettingsSubpage());
}
