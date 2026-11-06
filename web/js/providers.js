// 模型 / 搜索 / TTS / 视觉 Provider 设置：表单填充、搜索源字段、连接测试、清空密钥。
'use strict';

function updateAsrProviderUI() {
    const provider = document.querySelector('input[name="asrProvider"]:checked')?.value || '';
    elements.dashscopeAsrFields.classList.toggle('hidden', provider !== 'aliyun');
    const mimoFields = document.getElementById('mimoAsrFields');
    if (mimoFields) mimoFields.classList.toggle('hidden', provider !== 'mimo');
}

function updateTtsProviderUI() {
    const provider = elements.settingTtsProvider?.value || 'mimo';
    elements.mimoTtsFields?.classList.toggle('hidden', provider !== 'mimo');
    elements.openaiTtsFields?.classList.toggle('hidden', provider !== 'openai-tts');
    elements.minimaxTtsFields?.classList.toggle('hidden', provider !== 'minimax');
    elements.dashscopeTtsFields?.classList.toggle('hidden', provider !== 'dashscope');
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

let chatProviderEditorOpen = false;
// 二级页当前停在哪：'' = 供应商列表；某 id = 该供应商的详情页。
let chatProviderEditingId = '';

function resetChatProviderEditing() {
    chatProviderEditorOpen = false;
    chatProviderEditingId = '';
    if (settingsSubpageNode && settingsSubpageNode.id === 'chatProviderEditor') closeSettingsSubpage();
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
    block.innerHTML = `
        <div class="flex items-center gap-2">
            <input class="cpc-name modal-input text-sm flex-1 min-w-0" value="${escapeHtml(p.name || '')}" placeholder="提供商名称（如 DeepSeek / 硅基流动）">
            <button type="button" class="cpc-test btn-secondary text-xs flex-none">测试</button>
            <button type="button" class="cpc-delete btn-secondary text-xs flex-none" title="删除这个提供商">删除</button>
        </div>
        <div class="cpc-grid">
            <div>
                <label class="text-xs text-indigo-500 mb-1 block">API 格式</label>
                <select class="cpc-format modal-input text-sm">
                    <option value="openai-compatible">OpenAI 兼容（DeepSeek / 硅基流动 / OneAPI / Ollama…）</option>
                    <option value="openai-responses">OpenAI 官方（Responses 接口）</option>
                    <option value="anthropic">Anthropic Claude</option>
                </select>
            </div>
            <div>
                <label class="text-xs text-indigo-500 mb-1 block">API Base URL</label>
                <input class="cpc-baseurl modal-input text-sm" type="url" inputmode="url" value="${escapeHtml(p.baseUrl || '')}" placeholder="${escapeHtml(preset.defaultBaseUrl)}">
            </div>
            <div>
                <label class="text-xs text-indigo-500 mb-1 block">API Key（本地服务可留空）</label>
                <input class="cpc-key modal-input text-sm" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" value="${escapeHtml((state.settings.chatProviderKeys || {})[p.id] || '')}" placeholder="sk-...（只保存在本机）">
            </div>
        </div>
        <div>
            <label class="text-xs text-indigo-500 mb-1 block">模型（勾选需要的；勾选后才会出现在默认/回退选择里）</label>
            <div class="flex items-center gap-2 mb-1.5">
                <button type="button" class="cpc-fetch btn-secondary text-xs flex-none" title="从该提供商的 API 地址拉取可用模型列表">获取模型</button>
                <input class="cpc-manual-model modal-input text-sm flex-1 min-w-0" type="text" autocomplete="off" placeholder="输入即筛选模型；完整模型名可点「添加」加入">
                <button type="button" class="cpc-add-model btn-secondary text-xs flex-none">＋ 添加</button>
            </div>
            <div class="cpc-model-checks"></div>
        </div>`;
    const formatSelect = block.querySelector('.cpc-format');
    if (p.apiFormat) formatSelect.value = p.apiFormat;
    renderChatProviderModelChecks(block, p);
    // 手动输入框兼当搜索：输入就过滤下面的勾选列表，不必等"获取模型"后自己找。
    const manual = block.querySelector('.cpc-manual-model');
    if (manual) manual.addEventListener('input', () => filterChatProviderModels(block, manual.value));
    return block;
}

/** 按子串过滤模型勾选列表；只改显隐，不动勾选状态。 */
function filterChatProviderModels(block, query) {
    const box = block && block.querySelector('.cpc-model-checks');
    if (!box) return;
    const q = String(query || '').trim().toLowerCase();
    let shown = 0;
    box.querySelectorAll('.cpc-model-check').forEach((label) => {
        const name = String(label.getAttribute('data-model-name') || '').toLowerCase();
        const hit = !q || name.includes(q);
        label.style.display = hit ? '' : 'none';
        if (hit) shown += 1;
    });
    const empty = box.querySelector('.cpc-filter-empty');
    if (empty) empty.style.display = (q && shown === 0) ? '' : 'none';
}

// 已勾选但不在候选列表里的模型也要显示（迁移来的老勾选没有候选清单），否则保存时会被当成"没勾"清掉。
function renderChatProviderModelChecks(block, p) {
    const box = block.querySelector('.cpc-model-checks');
    if (!box) return;
    box.innerHTML = '';
    const selected = Array.isArray(p.selectedModels) ? p.selectedModels : [];
    const models = Array.from(new Set([
        ...(Array.isArray(p.models) ? p.models : []),
        ...selected
    ]));
    if (!models.length) {
        const empty = document.createElement('p');
        empty.className = 'text-[11px] text-indigo-300';
        empty.textContent = '还没有候选模型：点「获取模型」拉取，或手动输入添加。';
        box.appendChild(empty);
        return;
    }
    models.forEach((m) => {
        const label = document.createElement('label');
        label.className = 'cpc-model-check';
        // 供手动输入框的搜索用：比对用小写，显示仍用原大小写。
        label.setAttribute('data-model-name', String(m).toLowerCase());
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'cpc-model-check-box';
        input.setAttribute('data-model', m);
        input.checked = selected.includes(m);
        const text = document.createElement('span');
        text.textContent = m;
        label.appendChild(input);
        label.appendChild(text);
        box.appendChild(label);
    });
    // 「输入即筛选」筛空时的说明；平时不占位。
    const none = document.createElement('p');
    none.className = 'cpc-filter-empty text-[11px] text-indigo-300';
    none.textContent = '没有匹配的模型';
    none.style.display = 'none';
    box.appendChild(none);
}

function renderChatProviderSettings() {
    const s = state.settings;
    const providers = Array.isArray(s.chatProviders) ? s.chatProviders : [];
    if (!Array.isArray(s.fallbackChatModels)) s.fallbackChatModels = [];
    const home = document.getElementById('chatProviderHome');
    const editor = document.getElementById('chatProviderEditor');
    if (!home || !editor) return;
    home.classList.toggle('hidden', chatProviderEditorOpen);
    editor.classList.toggle('hidden', !chatProviderEditorOpen);
    if (chatProviderEditorOpen) {
        editor.innerHTML = '';
        // 列表 → 详情：空编辑目标 = 供应商列表；指向某个供应商 = 它的详情页
        //   （目标被删掉时退回列表，避免停在一个不存在的 id 上）。
        const editing = chatProviderEditingId ? findChatProviderById(chatProviderEditingId) : null;
        editor.appendChild(editing ? buildChatProviderDetailPage(editing) : buildChatProviderListPage(providers));
        return;
    }
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
        empty.className = 'text-[11px] text-indigo-300';
        empty.textContent = '未设置回退。默认模型失败时将直接报错。';
        chainBox.appendChild(empty);
    } else {
        chain.forEach((pair, i) => chainBox.appendChild(
            buildFallbackChainRow(chatModelKey(pair), chatModelLabel(chatProviderById(pair.providerId), pair.model), i, chain.length)
        ));
    }
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
    updateVisionMainModelHint();
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
        + '<span class="prov-chev" aria-hidden="true">›</span>';
    if (!opts.disabled && typeof opts.onPick === 'function') {
        row.addEventListener('click', () => opts.onPick(opts.id));
    }
    return row;
}

/** items: [{ id, name, active, disabled }]；newLabel 有值时在最后追加「新建」一行。 */
function fillProvList(box, items, onPick, newLabel, onNew) {
    if (!box) return;
    box.innerHTML = '';
    items.forEach((it) => box.appendChild(buildProvRow({ ...it, onPick })));
    if (newLabel) {
        box.appendChild(buildProvRow({ isNew: true, name: newLabel, onPick: () => onNew() }));
    }
}

// ---------- 语音输出 / 语音输入 / 图片转述：同一套「列表 → 详情」 ----------

const TTS_PROVIDER_OPTIONS = Object.freeze([
    { id: 'mimo', name: 'MiMo TTS（小米）' },
    { id: 'minimax', name: 'MiniMax（克隆音色）' },
    { id: 'dashscope', name: '阿里千问 Qwen-TTS' },
    { id: 'openai-tts', name: '通用 OpenAI TTS' }
]);

const ASR_PROVIDER_OPTIONS = Object.freeze([
    { id: 'aliyun', name: '阿里百炼' },
    { id: 'mimo', name: '小米 MiMo' }
]);

let ttsProviderDetailOpen = false;
let asrProviderDetailOpen = false;

function renderTtsProviderPage(resetView) {
    if (resetView) ttsProviderDetailOpen = false;
    const home = document.getElementById('ttsProviderHome');
    const detail = document.getElementById('ttsProviderDetail');
    const listBox = document.getElementById('ttsProviderList');
    if (!home || !detail || !listBox) return;
    const current = elements.settingTtsProvider?.value || 'mimo';
    home.classList.toggle('hidden', ttsProviderDetailOpen);
    detail.classList.toggle('hidden', !ttsProviderDetailOpen);
    if (ttsProviderDetailOpen) {
        const p = TTS_PROVIDER_OPTIONS.find((x) => x.id === current);
        const title = document.getElementById('ttsProviderDetailTitle');
        if (title) title.textContent = p ? p.name : '语音服务商';
        updateTtsProviderUI();
        return;
    }
    fillProvList(
        listBox,
        TTS_PROVIDER_OPTIONS.map((p) => ({ id: p.id, name: p.name, active: p.id === current })),
        (id) => openTtsProviderDetail(id)
    );
}

function openTtsProviderDetail(id) {
    const select = elements.settingTtsProvider;
    if (!select) return;
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    ttsProviderDetailOpen = true;
    renderTtsProviderPage(false);
    openSettingsSubpage(document.getElementById('ttsProviderDetail'));
}

function backToTtsProviderList() {
    ttsProviderDetailOpen = false;
    renderTtsProviderPage(false);
    closeSettingsSubpage();
}

function currentAsrProviderId() {
    return document.querySelector('input[name="asrProvider"]:checked')?.value || '';
}

function renderAsrProviderPage(resetView) {
    if (resetView) asrProviderDetailOpen = false;
    const home = document.getElementById('asrProviderHome');
    const detail = document.getElementById('asrProviderDetail');
    const listBox = document.getElementById('asrProviderList');
    if (!home || !detail || !listBox) return;
    const current = currentAsrProviderId();
    home.classList.toggle('hidden', asrProviderDetailOpen);
    detail.classList.toggle('hidden', !asrProviderDetailOpen);
    if (asrProviderDetailOpen) {
        const p = ASR_PROVIDER_OPTIONS.find((x) => x.id === current);
        const title = document.getElementById('asrProviderDetailTitle');
        if (title) title.textContent = p ? p.name : '语音输入';
        updateAsrProviderUI();
        return;
    }
    fillProvList(
        listBox,
        ASR_PROVIDER_OPTIONS.map((p) => ({ id: p.id, name: p.name, active: p.id === current })),
        (id) => openAsrProviderDetail(id)
    );
}

function openAsrProviderDetail(id) {
    const radio = document.querySelector('input[name="asrProvider"][value="' + id + '"]');
    if (!radio) return;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    asrProviderDetailOpen = true;
    renderAsrProviderPage(false);
    openSettingsSubpage(document.getElementById('asrProviderDetail'));
}

function backToAsrProviderList() {
    asrProviderDetailOpen = false;
    renderAsrProviderPage(false);
    closeSettingsSubpage();
}

/** 图片转述并进「对话模型」后不再走服务商列表：直接按当前对话模型库重建候选并刷新开关显隐。 */
function renderVisionProviderPage() {
    fillVisionModelPairOptions();
    syncVisionFieldsVisibility();
    updateVisionMainModelHint();
}

/** 视觉配置只在开关打开后可填；关闭时保留已选值，下次打开不用重选。 */
function syncVisionFieldsVisibility() {
    const on = document.getElementById('settingVisionEnabled')?.checked === true;
    const fields = document.getElementById('visionFields');
    if (fields) fields.classList.toggle('hidden', !on);
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
        ? '💡 当前默认模型「' + escapeHtml(model || '默认模型') + '」本来就支持查看图片（多模态），<b>建议不要打开这个开关</b> —— 图片直接交给它，细节更全、速度更快。只有主模型是纯文本时，才需要接一个视觉模型替它看。'
        : '💡 主模型本来就支持查看图片（多模态）时，<b>建议不要打开这个开关</b> —— 图片直接交给它，细节更全、速度更快。只有主模型是纯文本时，才需要在这里接一个视觉模型替它看。';
}

/** 打开设置时三处二级页都回到列表（与对话模型的"编辑状态不跨开关"一致）。 */
function resetModelProviderPages() {
    renderTtsProviderPage(true);
    renderAsrProviderPage(true);
    renderVisionProviderPage();
}

// ---------- 模型分栏：入口列表 → 各自的分页 ----------
// 一级只放一列入口，避免「对话模型 / 语音输出 / 语音输入 / 对话优化」
// 全摊在同一页；点进去的每一页里，服务商相关的内容再走上面的「列表 → 详情」。
// 图片转述属于对话模型的附赠能力，不单独占一个入口。

const MODEL_SECTION_ENTRIES = Object.freeze([
    { key: 'chat', name: '对话模型', desc: '默认模型、失败回退、图片转述与多套提供商' },
    { key: 'tts', name: '语音输出', desc: '朗读用哪家服务、什么音色' },
    { key: 'asr', name: '语音输入', desc: '把说的话转成文字' },
    { key: 'optimize', name: '对话优化', desc: '思考强度与采样参数' }
]);

const MODEL_SECTION_PAGE = Object.freeze({
    chat: 'modelChatPage',
    tts: 'modelTtsPage',
    asr: 'modelAsrPage',
    optimize: 'modelOptimizePage'
});

let modelSectionPage = '';

/** 每个分页顶上补一行「← 返回」；标题就用分页自己的小节名，不重复写。 */
function ensureModelPageHeads() {
    MODEL_SECTION_ENTRIES.forEach((entry) => {
        const page = document.getElementById(MODEL_SECTION_PAGE[entry.key]);
        if (!page || page.querySelector('.model-page-back')) return;
        const head = document.createElement('div');
        head.className = 'prov-detail-head';
        head.innerHTML = '<button type="button" class="model-page-back prov-back">← 返回</button>';
        head.querySelector('.model-page-back').addEventListener('click', () => showModelPage(''));
        page.insertBefore(head, page.firstChild);
    });
}

function renderModelEntryList() {
    const box = document.getElementById('modelEntryList');
    if (!box) return;
    const count = document.getElementById('modelEntryCount');
    if (count) count.textContent = MODEL_SECTION_ENTRIES.length + ' 个分类';
    fillProvList(box, MODEL_SECTION_ENTRIES.map((e) => ({ id: e.key, name: e.name, desc: e.desc })), (key) => showModelPage(key));
}

function isModelEntryListMode() {
    // 设置页无论宽窄都先给分类入口：一屏铺开五个区块会让"改哪一项"变成找字段。
    return true;
}

function syncModelPageVisibility() {
    ensureModelPageHeads();
    const home = document.getElementById('modelHomeSection');
    const panel = document.getElementById('tab-model');
    if (panel) panel.classList.toggle('model-page-open', Boolean(modelSectionPage));
    // 入口列表模式当前恒开（isModelEntryListMode 恒 true），此分支走不到；生效的是下面的按页显隐。
    if (!isModelEntryListMode()) {
        if (home) home.classList.add('hidden');
        MODEL_SECTION_ENTRIES.forEach((entry) => {
            const page = document.getElementById(MODEL_SECTION_PAGE[entry.key]);
            if (page) page.classList.remove('hidden');
        });
        return;
    }
    if (home) home.classList.toggle('hidden', Boolean(modelSectionPage));
    MODEL_SECTION_ENTRIES.forEach((entry) => {
        const page = document.getElementById(MODEL_SECTION_PAGE[entry.key]);
        if (page) page.classList.toggle('hidden', modelSectionPage !== entry.key);
    });
    if (!modelSectionPage) renderModelEntryList();
}

/** 切到某个分页；key 为空 = 回入口列表。每进一页都把该页里的二级页重置到它的列表。 */
function showModelPage(key) {
    modelSectionPage = MODEL_SECTION_PAGE[key] ? key : '';
    if (modelSectionPage === 'chat') {
        resetChatProviderEditing();
        renderChatProviderSettings();
        renderVisionProviderPage();
    } else if (modelSectionPage === 'tts') {
        renderTtsProviderPage(true);
    } else if (modelSectionPage === 'asr') {
        renderAsrProviderPage(true);
    }
    syncModelPageVisibility();
}

/** 切进「模型」分栏时回到入口列表（与各二级页"状态不跨次保留"一致）。 */
function resetModelSectionPage() {
    showModelPage('');
}

/** 「我的」里的深链落到某个设置项时，先把模型页切到它所在的分页。 */
function openModelPageForAnchor(anchorId) {
    const map = {
        settingChatModel: 'chat',
        defaultChatModelSelect: 'chat',
        settingTtsProvider: 'tts',
        ttsProviderHome: 'tts',
        settingAsrApiKey: 'asr',
        asrProviderHome: 'asr',
        settingVisionModelPair: 'chat',
        settingVisionEnabled: 'chat',
        settingThinkingEffort: 'optimize'
    };
    const key = map[anchorId];
    if (key) showModelPage(key);
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
        // 不是从页内「返回」离开的（切分栏 / 关设置）时，也要把卡片恢复成列表态。
        if (id === 'chatProviderEditor') {
            chatProviderEditorOpen = false;
            chatProviderEditingId = '';
            renderChatProviderSettings();
        } else if (id === 'ttsProviderDetail') {
            ttsProviderDetailOpen = false;
            renderTtsProviderPage(false);
        } else if (id === 'asrProviderDetail') {
            asrProviderDetailOpen = false;
            renderAsrProviderPage(false);
        }
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
    if (!chatProviderEditorOpen || !chatProviderEditingId) return;
    const editorBox = document.getElementById('chatProviderEditor');
    const block = editorBox && editorBox.querySelector('.chat-provider-card');
    const prov = findChatProviderById(chatProviderEditingId);
    if (!block || !prov) return;
    const checks = Array.from(block.querySelectorAll('.cpc-model-check-box'));
    const hasChecks = checks.length > 0;
    prov.name = block.querySelector('.cpc-name')?.value.trim() || '未命名';
    prov.apiFormat = block.querySelector('.cpc-format')?.value || 'openai-compatible';
    prov.baseUrl = block.querySelector('.cpc-baseurl')?.value.trim() || '';
    if (hasChecks) {
        prov.models = checks.map((c) => c.getAttribute('data-model')).filter(Boolean);
        prov.selectedModels = checks.filter((c) => c.checked).map((c) => c.getAttribute('data-model'));
    }
    if (!state.settings.chatProviderKeys || typeof state.settings.chatProviderKeys !== 'object') {
        state.settings.chatProviderKeys = {};
    }
    state.settings.chatProviderKeys[prov.id] = block.querySelector('.cpc-key')?.value.trim() || '';
}

function openChatProviderDetail(id) {
    commitChatProviderDetail();
    chatProviderEditingId = id || '';
    renderChatProviderSettings();
}

function backToChatProviderList() {
    commitChatProviderDetail();
    chatProviderEditingId = '';
    renderChatProviderSettings();
}

function addChatProvider() {
    commitChatProviderDetail();
    const s = state.settings;
    if (!Array.isArray(s.chatProviders)) s.chatProviders = [];
    const id = 'prov_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const preset = CHAT_API_FORMATS['openai-compatible'];
    s.chatProviders.push({
        id,
        name: '新供应商 ' + (s.chatProviders.length + 1),
        apiFormat: 'openai-compatible',
        baseUrl: preset.defaultBaseUrl,
        models: [],
        selectedModels: []
    });
    if (!s.chatProviderKeys || typeof s.chatProviderKeys !== 'object') s.chatProviderKeys = {};
    chatProviderEditingId = id;
    renderChatProviderSettings();
    void saveSettings({ silent: true });
    // 新供应商直接进详情页：焦点落到名称上，改完就能往下填地址 / Key。
    window.setTimeout(() => {
        const input = document.querySelector('#chatProviderEditor .chat-provider-card .cpc-name');
        if (!input) return;
        try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    }, 40);
}

function buildChatProviderListPage(providers) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-provider-edit';
    wrap.innerHTML = `
        <div class="flex items-center gap-2 mb-2">
            <button type="button" class="cpc-back-home btn-secondary text-xs flex-none" title="返回模型选择">← 返回</button>
            <span class="text-xs text-indigo-500 font-bold">提供商</span>
        </div>
        <div id="chatProviderList" class="prov-list"></div>`;
    fillProvList(
        wrap.querySelector('#chatProviderList'),
        providers.map((p) => ({ id: p.id, name: p.name || '未命名' })),
        (id) => openChatProviderDetail(id),
        '新建供应商',
        () => addChatProvider()
    );
    return wrap;
}

function buildChatProviderDetailPage(p) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-provider-edit';
    wrap.innerHTML = `
        <div class="prov-detail-head">
            <button type="button" class="cpc-back-list btn-secondary text-xs flex-none" title="返回提供商列表">← 返回</button>
            <span class="prov-detail-title"></span>
        </div>
        <div class="space-y-3"></div>`;
    const title = wrap.querySelector('.prov-detail-title');
    if (title) title.textContent = p.name || '未命名';
    wrap.querySelector('.space-y-3').appendChild(buildChatProviderBlock(p));
    return wrap;
}

function readChatProvidersFromDom() {
    // 二级编辑页同时只显示一个供应商的详情；把它先写回 state，再整体读出来。
    //   （刻意不再"逐个 DOM 块合并"：那里每多开一个页面就得同步一条，正是漏字段的来源。）
    if (chatProviderEditorOpen) commitChatProviderDetail();
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
    // 默认/回退的 DOM 是面板渲染出来的镜像：面板没开着时读到的是旧值，只在面板可见时以 DOM 为准。
    const settingsOverlay = document.getElementById('settingsOverlay');
    const panelOpen = !!settingsOverlay && !settingsOverlay.classList.contains('hidden');
    return {
        ...state.settings,
        apiProvider: DEFAULT_SETTINGS.apiProvider,
        chatProviders: chat.providers,
        chatProviderKeys: chat.keys,
        // 面板开着时以表单为真相，关着时保留 state。
        defaultChatModel: panelOpen
            ? parseChatModelKey(document.getElementById('defaultChatModelSelect')?.value)
            : (state.settings.defaultChatModel || { providerId: '', model: '' }),
        fallbackChatModels: panelOpen
            ? Array.from(document.querySelectorAll('#fallbackChainList .fbc-row'))
                .map((row) => parseChatModelKey(row.getAttribute('data-key')))
                .filter((p) => p.providerId && p.model)
            : (Array.isArray(state.settings.fallbackChatModels) ? state.settings.fallbackChatModels : []),
        minimaxApiKey: document.getElementById('settingMinimaxApiKey')?.value.trim() || '',
        minimaxVoice: document.getElementById('settingMinimaxVoice')?.value.trim() || '',
        minimaxModel: document.getElementById('settingMinimaxModel')?.value || 'speech-2.8-hd',
        ttsProvider: elements.settingTtsProvider?.value || 'mimo',
        mimoTtsModel: document.getElementById('settingMimoTtsModel')?.value || 'mimo-v2.5-tts',
        mimoTtsVoice: document.getElementById('settingMimoTtsVoice')?.value.trim() || 'mimo_default',
        mimoTtsVoiceDesignPrompt: document.getElementById('settingMimoVoiceDesignPrompt')?.value.trim() || '',
        mimoTtsApiKey: document.getElementById('settingMimoTtsApiKey')?.value.trim() || '',
        openaiTtsBaseUrl: document.getElementById('settingOpenaiTtsBaseUrl')?.value.trim() || 'https://api.openai.com/v1',
        openaiTtsApiKey: document.getElementById('settingOpenaiTtsApiKey')?.value.trim() || '',
        openaiTtsModel: document.getElementById('settingOpenaiTtsModel')?.value.trim() || 'tts-1',
        openaiTtsVoice: document.getElementById('settingOpenaiTtsVoice')?.value.trim() || 'alloy',
        dashscopeTtsModel: document.getElementById('settingDashscopeTtsModel')?.value.trim() || 'qwen3-tts-flash',
        dashscopeTtsVoice: document.getElementById('settingDashscopeTtsVoice')?.value.trim() || 'Cherry',
        dashscopeApiKey: document.getElementById('settingDashscopeApiKey')?.value.trim() || '',
        asrApiKey: document.getElementById('settingAsrApiKey')?.value.trim() || '',
        dashscopeAsrBaseUrl: document.getElementById('settingDashscopeAsrBaseUrl')?.value.trim() || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        dashscopeAsrModel: document.getElementById('settingDashscopeAsrModel')?.value.trim() || 'qwen3-asr-flash',
        mimoApiKey: document.getElementById('settingMimoAsrApiKey')?.value.trim() || '',
        mimoBaseUrl: document.getElementById('settingMimoAsrBaseUrl')?.value.trim() || 'https://api.xiaomimimo.com',
        mimoAsrModel: document.getElementById('settingMimoAsrModel')?.value.trim() || 'mimo-v2.5-asr',
        // 开关关着时保留已配置的模型，但生效判据是开关本身。
        visionEnabled: document.getElementById('settingVisionEnabled')?.checked === true,
        // 下拉选中了对话模型里的某一项就存提供商 + 模型名；没选（旧数据）时保留原来的单独配置。
        visionProviderId: (visionPair.providerId && visionPair.model)
            ? visionPair.providerId
            : String(state.settings.visionProviderId || ''),
        visionModel: (visionPair.providerId && visionPair.model)
            ? visionPair.model
            : String(state.settings.visionModel || ''),
        // 选了对话模型里的模型后，旧的单独地址/Key 就没有意义了，顺手清掉免得日后被兜底捡起来。
        visionBaseUrl: (visionPair.providerId && visionPair.model) ? '' : String(state.settings.visionBaseUrl || ''),
        visionApiKey: (visionPair.providerId && visionPair.model) ? '' : String(state.settings.visionApiKey || '')
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

/** 视觉模型下拉：候选与一级「默认模型」同一份（提供商 × 已勾选模型），不另配一套模型名。 */
function visionModelPairOptions() {
    return chatModelPairOptions(Array.isArray(state.settings.chatProviders) ? state.settings.chatProviders : []);
}

/** 当前视觉配置对应的下拉键；只存了模型名（旧数据）时按模型名在库里反查一家。 */
function currentVisionPairKey() {
    const s = state.settings;
    const model = String(s.visionModel || '').trim();
    if (!model) return '';
    const providerId = String(s.visionProviderId || '');
    if (providerId) return chatModelKey({ providerId, model });
    const hit = visionModelPairOptions().find((o) => o.model === model);
    return hit ? hit.key : '';
}

function fillVisionModelPairOptions() {
    const pairs = visionModelPairOptions();
    fillChatProviderSelect(
        document.getElementById('settingVisionModelPair'),
        pairs,
        currentVisionPairKey(),
        '从「对话模型」已勾选的模型里选一个'
    );
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
    const on = state.settings.visionEnabled === true;
    const toggle = document.getElementById('settingVisionEnabled');
    if (toggle) toggle.checked = on;
    fillVisionModelPairOptions();
    syncVisionFieldsVisibility();
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
            link.className = 'text-indigo-500';
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
async function testChatProviderBlock(block, btn) {
    const selected = Array.from(block.querySelectorAll('.cpc-model-check-box:checked'))
        .map((c) => c.getAttribute('data-model'));
    const draft = {
        ...state.settings,
        apiFormat: block.querySelector('.cpc-format')?.value || 'openai-compatible',
        baseUrl: block.querySelector('.cpc-baseurl')?.value.trim() || '',
        model: selected[0] || '',
        apiKey: block.querySelector('.cpc-key')?.value.trim() || ''
    };
    await withSettingsTestButton(btn, '测试中…', async () => {
        if (!draft.baseUrl) throw new ClientApiError('APP_BAD_URL', '请先填写 API Base URL');
        if (!draft.model) throw new ClientApiError('APP_BAD_URL', '请先获取或勾选至少一个模型');
        const reply = await callChatAPI([
            { role: 'system', content: '这是连接测试。' },
            { role: 'user', content: '只回复 OK' }
        ], { maxTokens: 256, temperature: 0 }, draft);
        if (!reply.trim()) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '对话接口返回了空内容');
        showCustomAlert(`连接成功，模型返回：${reply.trim()}`, '对话连接正常');
    });
}

function applyChatProviderEditorToState() {
    const chat = readChatProvidersFromDom();
    state.settings.chatProviders = chat.providers;
    state.settings.chatProviderKeys = chat.keys;
}

function bindChatProviderSettingsUI() {
    const home = document.getElementById('chatProviderHome');
    if (home) {
        home.addEventListener('click', async (ev) => {
            const s = state.settings;
            if (ev.target.closest('#editChatProvidersBtn')) {
                // 进二级页先落在供应商列表，不直接进某一家。
                chatProviderEditorOpen = true;
                chatProviderEditingId = '';
                renderChatProviderSettings();
                openSettingsSubpage(document.getElementById('chatProviderEditor'));
                return;
            }
            if (ev.target.closest('#fallbackAddBtn')) {
                const sel = document.getElementById('fallbackAddSelect');
                const key = sel.value;
                if (!key) return;
                const pair = parseChatModelKey(key);
                const already = (s.fallbackChatModels || []).some((c) => chatModelKey(c) === key);
                if (!pair.providerId || !pair.model || already) return;
                s.fallbackChatModels = [...(s.fallbackChatModels || []), pair];
                renderChatProviderSettings();
                await saveSettings({ silent: true });
                return;
            }
            const fRow = ev.target.closest('.fbc-row');
            if (fRow) {
                const key = fRow.getAttribute('data-key');
                const chain = [...(s.fallbackChatModels || [])];
                const i = chain.findIndex((c) => chatModelKey(c) === key);
                if (i < 0) return;
                if (ev.target.closest('.fbc-up') && i > 0) {
                    [chain[i - 1], chain[i]] = [chain[i], chain[i - 1]];
                } else if (ev.target.closest('.fbc-down') && i < chain.length - 1) {
                    [chain[i + 1], chain[i]] = [chain[i], chain[i + 1]];
                } else if (ev.target.closest('.fbc-remove')) {
                    chain.splice(i, 1);
                } else {
                    return;
                }
                s.fallbackChatModels = chain;
                renderChatProviderSettings();
                await saveSettings({ silent: true });
            }
        });
    }

    const editor = document.getElementById('chatProviderEditor');
    if (!editor) return;

    editor.addEventListener('click', async (ev) => {
        if (ev.target.closest('.cpc-back-list')) {
            // 详情 → 列表：先把这一家的字段写回 state，再回列表。
            backToChatProviderList();
            return;
        }
        if (ev.target.closest('.cpc-back-home')) {
            // 列表 → 对话模型卡片：回到一级视图前的最后一次提交由 readProviderSettingsForm 兜底。
            flushAutoSave();
            chatProviderEditorOpen = false;
            chatProviderEditingId = '';
            renderChatProviderSettings();
            closeSettingsSubpage();
            return;
        }
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
        if (ev.target.closest('.cpc-test')) {
            await testChatProviderBlock(block, ev.target.closest('.cpc-test'));
            return;
        }
        if (ev.target.closest('.cpc-delete')) {
            const prov = (s.chatProviders || []).find((p) => p.id === id);
            const ok = await showCustomConfirm('删除提供商「' + ((prov && prov.name) || '未命名') + '」？\n\n它的 API Key 与勾选的模型也会一并清掉。');
            if (!ok) return;
            applyChatProviderEditorToState();
            s.chatProviders = (s.chatProviders || []).filter((p) => p.id !== id);
            if (s.chatProviderKeys && typeof s.chatProviderKeys === 'object') delete s.chatProviderKeys[id];
            if (s.defaultChatModel && s.defaultChatModel.providerId === id) s.defaultChatModel = { providerId: '', model: '' };
            s.fallbackChatModels = (s.fallbackChatModels || []).filter((c) => c.providerId !== id);
            // 删掉的是当前详情页那一家：退回列表，别停在一个已不存在的 id 上。
            chatProviderEditingId = '';
            renderChatProviderSettings();
            await saveSettings({ silent: true });
        }
    });

    // 视口宽度变化时重跑模型页显隐同步（入口列表模式恒开，见 isModelEntryListMode；这里维持页头与各分页显隐一致）。
    try {
        const modelMq = window.matchMedia('(max-width: 980px)');
        if (modelMq && modelMq.addEventListener) modelMq.addEventListener('change', () => syncModelPageVisibility());
    } catch (e) { /* 老 WebView 没有 addEventListener 时只在切栏时同步 */ }

    // 语音输出 / 语音输入：详情页的「← 返回」回各自列表。
    document.getElementById('ttsProviderBack')?.addEventListener('click', () => backToTtsProviderList());
    document.getElementById('asrProviderBack')?.addEventListener('click', () => backToAsrProviderList());
    // 分区二级页（手机「我的」拆分栏用）的返回：还原分区到原分栏。
    document.getElementById('settingsSubpageBack')?.addEventListener('click', () => closeSettingsSubpage());
    // 默认模型换了，图片转述的候选与「原模型能识图」提示同步刷新。
    document.getElementById('defaultChatModelSelect')?.addEventListener('change', () => {
        fillVisionModelPairOptions();
        // 这里读 DOM 而不是 activeChatSettings()：自动保存有 300ms 防抖，state 此刻还是旧模型。
        const pair = parseChatModelKey(document.getElementById('defaultChatModelSelect')?.value);
        updateVisionMainModelHint(pair.model);
    });

    // 格式切换联动：地址仍是某格式的预设地址时跟着换。
    editor.addEventListener('change', (ev) => {
        if (!ev.target.classList.contains('cpc-format')) return;
        const block = ev.target.closest('.chat-provider-card');
        if (!block) return;
        const apiFormat = ev.target.value || 'openai-compatible';
        const preset = CHAT_API_FORMATS[apiFormat] || CHAT_API_FORMATS['openai-compatible'];
        const baseUrlInput = block.querySelector('.cpc-baseurl');
        const currentBaseUrl = baseUrlInput.value.trim();
        const usesDefault = !currentBaseUrl || Object.values(CHAT_API_FORMATS).some((f) => f.defaultBaseUrl === currentBaseUrl);
        if (usesDefault) baseUrlInput.value = preset.defaultBaseUrl;
        baseUrlInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

async function testTtsConnection() {
    await withSettingsTestButton(elements.testTtsConnectionBtn, '测试中…', async () => {
        const draft = readProviderSettingsForm();
        const provider = String(draft.ttsProvider || 'mimo');
        if (provider === 'mimo') {
            const audio = await generateMimoTtsAudio('你好，这是 MiMo 语音连接测试。', draft);
            if (!audio?.bytes?.byteLength) throw new ClientApiError('UPSTREAM_UNAVAILABLE', 'MiMo 返回了空音频');
            showCustomAlert('MiMo 已成功返回测试音频，Key、模型与音色可以使用。', '语音连接正常');
            return;
        }
        if (provider === 'openai-tts') {
            const audio = await generateOpenaiTtsAudio('你好，这是通用 OpenAI 语音连接测试。', draft);
            if (!audio?.bytes?.byteLength) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '通用 OpenAI TTS 返回了空音频');
            showCustomAlert('通用 OpenAI TTS 已成功返回测试音频，Key、模型与音色可以使用。', '语音连接正常');
            return;
        }
        if (provider === 'dashscope') {
            const audio = await generateDashscopeTtsAudio('你好，这是阿里千问语音连接测试。', draft);
            if (!audio?.bytes?.byteLength) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '阿里千问音频文件为空');
            showCustomAlert('阿里千问已成功返回测试音频，Key、模型与音色可以使用。', '语音连接正常');
            return;
        }
        if (!draft.minimaxApiKey) throw new ClientApiError('APP_KEY_MISSING', '请先填写 MiniMax API Key');
        if (!draft.minimaxVoice) throw new ClientApiError('BAD_REQUEST', '请先填写自己的 MiniMax 音色 ID');
        const result = await postJsonFromDevice(MINIMAX_TTS_HTTP, {
            model: draft.minimaxModel,
            text: 'こんにちは、接続テストです。',
            stream: false,
            language_boost: 'Japanese',
            voice_setting: { voice_id: draft.minimaxVoice, speed: 1, vol: 1, pitch: 0 },
            audio_setting: { sample_rate: 24000, bitrate: 128000, format: 'mp3', channel: 1 }
        }, { Authorization: `Bearer ${draft.minimaxApiKey}` });
        if (!result.ok || Number(result.payload?.base_resp?.status_code || 0) !== 0) {
            await throwProviderResponseError(result, 'MiniMax 语音连接测试失败');
        }
        if (!String(result.payload?.data?.audio || '')) throw new ClientApiError('UPSTREAM_UNAVAILABLE', 'MiniMax 返回了空音频');
        showCustomAlert('MiniMax 已成功返回测试音频，Key、模型与音色 ID 可以使用。', '语音连接正常');
    });
}

async function clearApiKeys() {
    const confirmed = await showCustomConfirm('确认清除这台设备上保存的 DeepSeek、MiniMax、DashScope、MiMo、通用 OpenAI、多提供商模型与搜索（Tavily）API Key？');
    if (!confirmed) return;
    await clearStoredApiSecrets();
    document.getElementById('settingMinimaxApiKey').value = '';
    document.getElementById('settingDashscopeApiKey').value = '';
    document.getElementById('settingAsrApiKey').value = '';
    document.getElementById('settingMimoAsrApiKey').value = '';
    document.getElementById('settingMimoTtsApiKey').value = '';
    document.getElementById('settingOpenaiTtsApiKey').value = '';
    document.querySelectorAll('#chatProviderList .cpc-key').forEach((input) => { input.value = ''; });
    // 搜索 Key 也是 API_SECRET_NAMES 里的项，必须挨家清空，否则"清除全部 Key"看起来没清干净。
    for (const id of Object.keys(SEARCH_PROVIDERS)) state.settings['searchApiKey_' + id] = '';
    const tavilyKeyInput = document.getElementById('settingTavilyApiKey');
    if (tavilyKeyInput) tavilyKeyInput.value = '';
    if (typeof updateTavilyHint === 'function') updateTavilyHint();
    showCustomAlert('API Key 已从当前设备清除。', '已清除');
}


