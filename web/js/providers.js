/* ============================================================================
 * 模型 / 搜索 / TTS / 视觉 Provider 设置（从 settings.js 拆分）
 *
 * Provider 表单填充、搜索源字段、连接测试、清空密钥。
 * ========================================================================== */
'use strict';

function updateAsrProviderUI() {
    const provider = document.querySelector('input[name="asrProvider"]:checked')?.value || 'browser';
    elements.dashscopeAsrFields.classList.toggle('hidden', provider !== 'aliyun');
    const mimoFields = document.getElementById('mimoAsrFields');
    if (mimoFields) mimoFields.classList.toggle('hidden', provider !== 'mimo');
    // 浏览器识别暂不可用提示
    const warn = document.getElementById('asrBrowserWarn');
    if (warn) warn.classList.toggle('hidden', provider !== 'browser');
    // 阿里云 ASR Key 现在是**独立**输入框（#settingAsrApiKey），状态由输入框本身体现，
    // 不再需要单独的状态提示（原 #settingAsrKeyStatus 已随共用 Key 一起移除）。
}

function updateTtsProviderUI() {
    const provider = elements.settingTtsProvider?.value || 'mimo';
    // MiMo TTS 的 Key / 接口地址是 TTS 专用的（与 ASR 独立），只在 TTS 选了 MiMo 时显示。
    elements.mimoTtsFields?.classList.toggle('hidden', provider !== 'mimo');
    elements.openaiTtsFields?.classList.toggle('hidden', provider !== 'openai-tts');
    elements.minimaxTtsFields?.classList.toggle('hidden', provider !== 'minimax');
    elements.dashscopeTtsFields?.classList.toggle('hidden', provider !== 'dashscope');
    // MiMo TTS 三个模型用的字段各不相同，随模型下拉一起切换
    updateMimoTtsModelUI();
}

// 依 MiMo TTS 模型切换子字段（三者互斥）：
//   mimo-v2.5-tts            → 预置音色（audio.voice = Voice ID）
//   mimo-v2.5-tts-voicedesign → 音色描述（user 消息，必填；该模型不支持 voice 字段）
//   mimo-v2.5-tts-voiceclone  → 参考音频样本（audio.voice = 样本 base64，必填；不支持预置音色）
function updateMimoTtsModelUI() {
    const model = document.getElementById('settingMimoTtsModel')?.value || 'mimo-v2.5-tts';
    document.getElementById('mimoTtsVoiceFields')?.classList.toggle('hidden', model !== 'mimo-v2.5-tts');
    document.getElementById('mimoTtsVoiceDesignFields')?.classList.toggle('hidden', model !== 'mimo-v2.5-tts-voicedesign');
    document.getElementById('mimoTtsVoiceCloneFields')?.classList.toggle('hidden', model !== 'mimo-v2.5-tts-voiceclone');
    // 切到 voiceclone 且还没有样本时，自动把**软件自带**的伊蕾娜日语
    //   样本补上（见 loadBuiltinMimoCloneSample 的说明）—— 这样开箱即用，不必让
    //   用户自己去找一段日语样本。
    if (model === 'mimo-v2.5-tts-voiceclone') void ensureBuiltinMimoCloneSample();
}

// 参考音频样本上限：官方示例只需数秒的 mp3/wav，本应用为免设置文件膨胀设 5 MB 硬上限
// ===== 多提供商对话模型：卡片渲染 / 读取 / 测试 =====
//   UI 形态：区块顶部「默认模型」「失败回退模型」两个下拉 + 下面每套配置一张卡。
//   卡片的增删改都直接改 DOM，保存时统一从 DOM 读回（readChatProvidersFromDom）——
//   与整页其它字段的"表单即真相"是同一套约定，自动保存（bindSettingsAutoSave 的
//   面板级委托）因此不用为动态卡片单独接事件。

function chatProviderLabel(p) {
    return ((p && (p.name || '').trim()) || '未命名') + ' · ' + ((p && p.model) || '未选模型');
}

function fillChatProviderSelect(select, providers, selectedId, emptyLabel) {
    if (!select) return;
    select.innerHTML = '';
    const option = (value, text) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        select.appendChild(o);
    };
    if (emptyLabel) option('', emptyLabel);
    if (!providers.length && !emptyLabel) option('', '尚未配置模型（点「＋ 新增」添加）');
    providers.forEach((p) => option(p.id, chatProviderLabel(p)));
    select.value = providers.some((p) => p.id === selectedId) ? selectedId : '';
    if (select.selectedIndex < 0 && select.options.length) select.selectedIndex = 0;
    return select.value;
}

function buildChatProviderCard(p) {
    const preset = CHAT_API_FORMATS[p.apiFormat] || CHAT_API_FORMATS['openai-compatible'];
    const card = document.createElement('div');
    card.className = 'chat-provider-card';
    card.setAttribute('data-provider-id', p.id || '');
    card.innerHTML = `
        <div class="flex items-center gap-2">
            <input class="cpc-name modal-input text-sm flex-1 min-w-0" value="${escapeHtml(p.name || '')}" placeholder="提供商名称（如 DeepSeek / 硅基流动）">
            <button type="button" class="cpc-test btn-secondary text-xs flex-none">测试</button>
            <button type="button" class="cpc-delete btn-secondary text-xs flex-none" title="删除这套配置">删除</button>
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
                <label class="text-xs text-indigo-500 mb-1 block">调用模型（发给服务商的模型名）</label>
                <div class="flex items-center gap-2">
                    <div class="model-combo flex-1 min-w-0">
                        <div class="model-combo-row">
                            <input class="cpc-model modal-input text-sm model-combo-input" type="text" value="${escapeHtml(p.model || '')}" placeholder="${escapeHtml(preset.defaultModel)}">
                            <button type="button" class="model-combo-toggle cpc-model-toggle" aria-label="展开模型列表" aria-expanded="false" title="展开/收起模型列表（先点「获取模型」拉取）">
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
                            </button>
                        </div>
                        <select class="cpc-models-select hidden" aria-hidden="true" tabindex="-1"></select>
                        <div class="model-combo-list hidden" role="listbox"></div>
                    </div>
                    <button type="button" class="cpc-fetch btn-secondary text-xs flex-none" title="从该配置的 API 地址拉取可用模型列表">获取模型</button>
                </div>
            </div>
            <div>
                <label class="text-xs text-indigo-500 mb-1 block">API Key（本地服务可留空）</label>
                <input class="cpc-key modal-input text-sm" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" value="${escapeHtml((state.settings.chatProviderKeys || {})[p.id] || '')}" placeholder="sk-...（只保存在本机）">
            </div>
        </div>`;
    // 候选模型列表回填（上一次「获取模型」的结果），组合框照单渲染
    const select = card.querySelector('.cpc-models-select');
    (Array.isArray(p.models) ? p.models : []).forEach((m) => {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        select.appendChild(o);
    });
    if (p.model) select.value = p.model;
    bindModelCombo({
        input: card.querySelector('.cpc-model'),
        toggle: card.querySelector('.cpc-model-toggle'),
        list: card.querySelector('.model-combo-list'),
        select
    });
    return card;
}

function renderChatProviderSettings() {
    const s = state.settings;
    const providers = Array.isArray(s.chatProviders) ? s.chatProviders : [];
    const defaultId = fillChatProviderSelect(document.getElementById('defaultChatProviderSelect'), providers, s.defaultChatProviderId);
    const fallbackId = fillChatProviderSelect(document.getElementById('fallbackChatProviderSelect'), providers, s.fallbackChatProviderId, '（不设置回退）');
    // 下拉的自动纠正（默认指向第一张卡等）要写回 state：请求链路读的是 state，
    //   只改下拉不改 state 的话，UI 显示与真正生效的模型会对不上。
    s.defaultChatProviderId = defaultId || '';
    s.fallbackChatProviderId = fallbackId || '';
    const box = document.getElementById('chatProviderList');
    if (!box) return;
    box.innerHTML = '';
    providers.forEach((p) => box.appendChild(buildChatProviderCard(p)));
}

function readChatProvidersFromDom() {
    const box = document.getElementById('chatProviderList');
    const providers = [];
    const keys = {};
    if (box) {
        box.querySelectorAll('.chat-provider-card').forEach((card) => {
            const id = card.getAttribute('data-provider-id') || '';
            if (!id) return;
            providers.push({
                id,
                name: card.querySelector('.cpc-name')?.value.trim() || '未命名',
                apiFormat: card.querySelector('.cpc-format')?.value || 'openai-compatible',
                baseUrl: card.querySelector('.cpc-baseurl')?.value.trim() || '',
                model: card.querySelector('.cpc-model')?.value.trim() || '',
                models: Array.from(card.querySelector('.cpc-models-select')?.options || []).map((o) => o.value)
            });
            keys[id] = card.querySelector('.cpc-key')?.value.trim() || '';
        });
    }
    return { providers, keys };
}

function readProviderSettingsForm() {
    // 对话模型的多卡与默认/回退从各自控件读；旧的单模型三件套（apiFormat/baseUrl/model/apiKey）
    //   已不是表单字段，从 ...state.settings 原样带过 —— 它们只作迁移源，请求链路不读。
    const chat = readChatProvidersFromDom();
    return {
        ...state.settings,
        apiProvider: DEFAULT_SETTINGS.apiProvider,
        chatProviders: chat.providers,
        chatProviderKeys: chat.keys,
        defaultChatProviderId: document.getElementById('defaultChatProviderSelect')?.value || '',
        fallbackChatProviderId: document.getElementById('fallbackChatProviderSelect')?.value || '',
        minimaxApiKey: document.getElementById('settingMinimaxApiKey')?.value.trim() || '',
        minimaxVoice: document.getElementById('settingMinimaxVoice')?.value.trim() || '',
        minimaxModel: document.getElementById('settingMinimaxModel')?.value || 'speech-2.8-hd',
        ttsProvider: elements.settingTtsProvider?.value || 'mimo',
        mimoTtsModel: document.getElementById('settingMimoTtsModel')?.value || 'mimo-v2.5-tts',
        mimoTtsVoice: document.getElementById('settingMimoTtsVoice')?.value.trim() || 'mimo_default',
        // 音色描述：voicedesign 模型的 user 消息文本
        mimoTtsVoiceDesignPrompt: document.getElementById('settingMimoVoiceDesignPrompt')?.value.trim() || '',
        // 参考音频样本不从这里读（文件框无法回填），直接保留 state.settings 里已存的值（见上方 ...state.settings）
        // MiMo TTS 凭据（独立于 ASR）：TTS 用自己的 Key / 接口地址
        mimoTtsApiKey: document.getElementById('settingMimoTtsApiKey')?.value.trim() || '',
        // MiMo TTS 的接口地址已不在界面上（固定用小米官方地址）：不读 DOM，
        // 保留 ...state.settings 里已有的值（DEFAULT_SETTINGS + 已存设置）
        openaiTtsBaseUrl: document.getElementById('settingOpenaiTtsBaseUrl')?.value.trim() || 'https://api.openai.com/v1',
        openaiTtsApiKey: document.getElementById('settingOpenaiTtsApiKey')?.value.trim() || '',
        openaiTtsModel: document.getElementById('settingOpenaiTtsModel')?.value.trim() || 'tts-1',
        openaiTtsVoice: document.getElementById('settingOpenaiTtsVoice')?.value.trim() || 'alloy',
        dashscopeTtsModel: document.getElementById('settingDashscopeTtsModel')?.value.trim() || 'qwen3-tts-flash',
        dashscopeTtsVoice: document.getElementById('settingDashscopeTtsVoice')?.value.trim() || 'Cherry',
        dashscopeApiKey: document.getElementById('settingDashscopeApiKey')?.value.trim() || '',
        // 阿里百炼 ASR 的 Key（独立于 TTS 的 dashscopeApiKey）
        asrApiKey: document.getElementById('settingAsrApiKey')?.value.trim() || '',
        dashscopeAsrBaseUrl: document.getElementById('settingDashscopeAsrBaseUrl')?.value.trim() || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        dashscopeAsrModel: document.getElementById('settingDashscopeAsrModel')?.value.trim() || 'qwen3-asr-flash',
        mimoApiKey: document.getElementById('settingMimoAsrApiKey')?.value.trim() || '',
        // 接口地址预填官方地址；留空时运行时也会回退到同一地址
        mimoBaseUrl: document.getElementById('settingMimoAsrBaseUrl')?.value.trim() || 'https://api.xiaomimimo.com',
        mimoAsrModel: document.getElementById('settingMimoAsrModel')?.value.trim() || 'mimo-v2.5-asr',
        // 图片转述：开关关着时**保留**已填的地址/Key/模型名（用户可能只是暂时关掉），
        //   但生效判据是开关本身 —— 见 data.js 里 hasVision 的注释。
        visionEnabled: document.getElementById('settingVisionEnabled')?.checked === true,
        visionBaseUrl: document.getElementById('settingVisionBaseUrl')?.value.trim() || '',
        visionApiKey: document.getElementById('settingVisionApiKey')?.value.trim() || '',
        visionModel: document.getElementById('settingVisionModel')?.value.trim() || ''
    };
}

/**
 * 把联网搜索那一块控件回填成当前设置。
 *
 * 为什么单独一个函数：设置面板每次打开都会跑一次回填（见 fillSettingsForm），
 *   把这一组散在几百行里会让"漏回填某一项"变得看不出来 —— 而漏回填的表现是
 *   "用户填的 Key 打开设置页就变成空的"，下一次保存就把空值写回去。
 */
function fillTavilySettings() {
    const enabled = state.settings.tavilySearchEnabled === true;
    if (elements.settingTavilyEnabled) elements.settingTavilyEnabled.checked = enabled;
    // 服务商下拉**由 SEARCH_PROVIDERS 生成**（不在这里手写第二份清单）：
    //   加一家只改 core.js 那张表，这里自动多一个选项。
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
    // 控件整块跟着开关淡出：关着的时候 Key 与条数都没有意义，摆在那里只会让人以为还能用。
    if (elements.tavilyFields) elements.tavilyFields.classList.toggle('hidden', !enabled);
    updateTavilyHint();
}

/**
 * 按**当前选中的服务商**刷新 Key 输入框：占位符、注册地址、以及那一格已经存着的 Key。
 *
 * 为什么每次切服务商都要重填：Key 是按服务商分开存的，切过去看到的必须是
 *   那一家的 Key —— 显示成上一家的会让用户以为"我填过了"，然后搜的时候 401。
 */
/**
 * 图片转述那一块的回填（开关 + 控件显隐）。
 *
 * 与联网搜索同一套做法：开关关着时把下面三个输入框淡出 —— 摆在那里会让人以为
 *   "填了就在用"，而实际生效的判据是开关（见 data.js 的 hasVision）。
 */
function fillVisionSettings() {
    const on = state.settings.visionEnabled === true;
    const toggle = document.getElementById('settingVisionEnabled');
    if (toggle) toggle.checked = on;
    const fields = document.getElementById('visionFields');
    if (fields) fields.classList.toggle('hidden', !on);
}

/**
 * 把输入框里**尚未保存**的 Key 收回到它所属服务商那一格。
 *
 * 为什么需要：切服务商时输入框要被重填成新服务商的 Key。不先收回的话，
 *   "在 A 家填了 Key → 手滑点了下服务商下拉 → 切回来"会发现 A 的 Key 消失了。
 *   这属于"我没点保存但也没说不要"的那类输入，不该丢。
 */
let lastSearchProviderId = '';
function stashCurrentSearchKey() {
    const input = elements.settingTavilyApiKey;
    if (!input) return;
    // ⚠️ 必须存到**切换前**那一家，不能用下拉的当前值。
    //   change 事件触发时 sel.value 已经是新服务商了 —— 用它会把这家的 Key
    //   写进新家那一格，把新家原来的 Key 覆盖掉（实测：切到博查后博查的 Key 变成了 Tavily 的）。
    const id = lastSearchProviderId || DEFAULT_SEARCH_PROVIDER;
    state.settings['searchApiKey_' + id] = String(input.value || '').trim();
}

function fillSearchProviderFields() {
    const id = elements.settingSearchProvider?.value || DEFAULT_SEARCH_PROVIDER;
    const def = SEARCH_PROVIDERS[id] || SEARCH_PROVIDERS[DEFAULT_SEARCH_PROVIDER];
    // 记下"现在展示的是哪一家"—— 下一次切换要把它输入框里的值存回**这一格**。
    lastSearchProviderId = SEARCH_PROVIDERS[id] ? id : DEFAULT_SEARCH_PROVIDER;
    if (elements.settingTavilyApiKey) {
        elements.settingTavilyApiKey.value = state.settings['searchApiKey_' + id] || '';
        elements.settingTavilyApiKey.placeholder = def.keyHint || '';
    }
    if (elements.searchKeyLabel) elements.searchKeyLabel.textContent = def.label + ' API Key';
    if (elements.searchKeyHint) {
        // keyUrl 为空（自定义源没有固定的注册地址）时不能硬拼"在 <空> 注册后…"——
        //   那会显示成"在  注册后可在控制台拿到 Key"，像是少了半句话。
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
        // 说清"这家免费额度够不够用" —— 用户问的正是"不是纯免费的吧"。
        //   额度数字写在 SEARCH_PROVIDERS 的 freeNote 里（唯一一份），这里只负责显示。
        elements.searchProviderHint.textContent = def.freeNote || '';
    }
    fillCustomSearchFields(id);
}

/**
 * 自定义搜索源那一组字段的回填与显隐。
 *
 * 只在选了「自定义」时显示：内置源用不到端点 / 鉴权头 / 请求体模板，
 *   摆在那里会让人以为"用 Tavily 还得填这些"。
 */
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

/** 只有"自定义头"这一档才需要填头名称；其余三档名字是固定的 */
function updateCustomAuthRow() {
    if (!elements.settingSearchCustomHeaderRow || !elements.settingSearchCustomAuth) return;
    elements.settingSearchCustomHeaderRow.classList.toggle('hidden', elements.settingSearchCustomAuth.value !== 'raw');
}

/** 开关/Key 变化后更新那句提示（它要如实说"现在到底能不能用"） */
function updateTavilyHint() {
    if (!elements.tavilyHint) return;
    const enabled = elements.settingTavilyEnabled ? elements.settingTavilyEnabled.checked : false;
    // Key 判据必须看**当前服务商那一格**，不能看输入框：输入框在切服务商时会被重填，
    //   而"这一家到底填过没有"只有 state 里那格说了算。
    const id = elements.settingSearchProvider?.value || DEFAULT_SEARCH_PROVIDER;
    const hasKey = Boolean(String(state.settings['searchApiKey_' + id] || '').trim());
    let text;
    if (!enabled) text = '关着的时候 AI 看不到这个能力，也不会发起任何搜索请求。';
    else if (!hasKey) text = '已打开，但还没填 Key —— 现在 AI 仍然搜不了，填上之后立刻可用。';
    else text = '已就绪：AI 觉得需要查最新信息时会自己搜一次，并把结果当作资料回答（会注明出处）。';
    elements.tavilyHint.textContent = text;
}

/**
 * 测一次当前选中的搜索服务商：用一个最小的查询确认 Key 与网络都通。
 *
 * 为什么用真搜索而不是某个 /health 端点：这几家都没有公开的健康检查接口，
 *   而且"Key 有效"和"这个 Key 还有额度"是两件事 —— 只有真发一次才知道。
 *   代价是花掉一次搜索额度，所以按钮上写明了是"测试"。
 *
 * 为什么不抛 ClientApiError 交给统一弹窗：那套文案是给**对话模型**用的
 *   （"请检查 Base URL、模型名和账号状态"），而搜索既没有 Base URL 也没有模型名。
 *   拿它报搜索的错，用户会去翻根本不需要改的地方 —— 所以这里自己组织话术。
 */
async function testTavilyConnection() {
    await withSettingsTestButton(elements.testTavilyBtn, '测试中…', async () => {
        const id = elements.settingSearchProvider?.value || DEFAULT_SEARCH_PROVIDER;
        const def = SEARCH_PROVIDERS[id] || SEARCH_PROVIDERS[DEFAULT_SEARCH_PROVIDER];
        const key = String(document.getElementById('settingTavilyApiKey')?.value || '').trim();
        if (!key) {
            showCustomAlert('请先填写 ' + def.label + ' 的 API Key。', '还没填 Key');
            return;
        }
        // 自定义源的端点是用户填的：先校验，再发 —— 报错要指向具体该补哪一项。
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
            // 连不上是最常见的一类（国内网络），直接说该做什么：换一家。
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

// 卡内「测试」：按**卡内当前值**拼草稿发一条极小的测试消息 —— 未保存也能测。
//   maxTokens 给 256：思考型模型给的太少会全花在 reasoning 上（正文一个不剩，
//   报"模型只返回了思考内容"），思考完还能留下可见的 "OK"，测试不会假红。
async function testChatProviderCard(card, btn) {
    const draft = {
        ...state.settings,
        apiFormat: card.querySelector('.cpc-format')?.value || 'openai-compatible',
        baseUrl: card.querySelector('.cpc-baseurl')?.value.trim() || '',
        model: card.querySelector('.cpc-model')?.value.trim() || '',
        apiKey: card.querySelector('.cpc-key')?.value.trim() || ''
    };
    await withSettingsTestButton(btn, '测试中…', async () => {
        if (!draft.baseUrl) throw new ClientApiError('APP_BAD_URL', '请先填写 API Base URL');
        if (!draft.model) throw new ClientApiError('APP_BAD_URL', '请先填写或「获取模型」选定调用模型');
        const reply = await callChatAPI([
            { role: 'system', content: '这是连接测试。' },
            { role: 'user', content: '只回复 OK' }
        ], { maxTokens: 256, temperature: 0 }, draft);
        if (!reply.trim()) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '对话接口返回了空内容');
        showCustomAlert(`连接成功，模型返回：${reply.trim()}`, '对话连接正常');
    });
}

/** 「＋ 新增」与卡片内的删除 / 测试 / 格式联动 / 获取模型：全部事件委托到列表容器，
 *   动态卡片因此不需要逐个绑事件。 */
function bindChatProviderSettingsUI() {
    document.getElementById('addChatProviderBtn')?.addEventListener('click', () => {
        const s = state.settings;
        if (!Array.isArray(s.chatProviders)) s.chatProviders = [];
        const id = 'prov_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const preset = CHAT_API_FORMATS['openai-compatible'];
        s.chatProviders.push({
            id,
            name: '新提供商 ' + (s.chatProviders.length + 1),
            apiFormat: 'openai-compatible',
            baseUrl: preset.defaultBaseUrl,
            model: preset.defaultModel,
            models: []
        });
        // 第一张卡自动成为默认模型：否则默认下拉是空的，请求没有落点
        if (!s.defaultChatProviderId || !s.chatProviders.some((p) => p.id === s.defaultChatProviderId)) {
            s.defaultChatProviderId = id;
        }
        renderChatProviderSettings();
        void saveSettings({ silent: true });
    });

    const list = document.getElementById('chatProviderList');
    if (!list) return;

    list.addEventListener('click', async (ev) => {
        const card = ev.target.closest('.chat-provider-card');
        if (!card) return;
        const id = card.getAttribute('data-provider-id');
        const s = state.settings;
        if (ev.target.closest('.cpc-delete')) {
            const prov = (s.chatProviders || []).find((p) => p.id === id);
            const ok = await showCustomConfirm('删除模型配置「' + ((prov && prov.name) || '未命名') + '」？\n\n它的 API Key 也会一并清掉。');
            if (!ok) return;
            s.chatProviders = (s.chatProviders || []).filter((p) => p.id !== id);
            if (s.chatProviderKeys && typeof s.chatProviderKeys === 'object') delete s.chatProviderKeys[id];
            // 默认 / 回退指向被删卡时顺延，避免下拉残留死 id
            if (s.defaultChatProviderId === id) s.defaultChatProviderId = (s.chatProviders[0] && s.chatProviders[0].id) || '';
            if (s.fallbackChatProviderId === id) s.fallbackChatProviderId = '';
            renderChatProviderSettings();
            await saveSettings({ silent: true });
            return;
        }
        if (ev.target.closest('.cpc-test')) {
            await testChatProviderCard(card, ev.target.closest('.cpc-test'));
        }
    });

    // 卡内格式切换联动：地址仍是"某格式的预设地址"、模型名空着或是预设名时跟着换
    //   （沿用旧区块级 API 格式下拉的判据，只是落点变成卡内字段）。
    list.addEventListener('change', (ev) => {
        if (!ev.target.classList.contains('cpc-format')) return;
        const card = ev.target.closest('.chat-provider-card');
        if (!card) return;
        const apiFormat = ev.target.value || 'openai-compatible';
        const preset = CHAT_API_FORMATS[apiFormat] || CHAT_API_FORMATS['openai-compatible'];
        const baseUrlInput = card.querySelector('.cpc-baseurl');
        const modelInput = card.querySelector('.cpc-model');
        const currentBaseUrl = baseUrlInput.value.trim();
        const usesDefault = !currentBaseUrl || Object.values(CHAT_API_FORMATS).some((f) => f.defaultBaseUrl === currentBaseUrl);
        if (usesDefault) baseUrlInput.value = preset.defaultBaseUrl;
        const currentModel = String(modelInput.value || '').trim();
        const isPresetDefault = Object.values(CHAT_API_FORMATS).some((f) => f.defaultModel === currentModel);
        if (!currentModel || isPresetDefault) modelInput.value = preset.defaultModel;
        // 手动派发 change 让面板级自动保存把改动收走
        baseUrlInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // 获取模型：按卡内当前值拉候选列表（复用 models.js 的整条链路）
    list.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.cpc-fetch');
        if (!btn) return;
        const card = btn.closest('.chat-provider-card');
        void populateModelSelect({
            btn,
            input: card.querySelector('.cpc-model'),
            select: card.querySelector('.cpc-models-select'),
            baseUrl: card.querySelector('.cpc-baseurl').value,
            apiKey: card.querySelector('.cpc-key').value,
            apiFormat: card.querySelector('.cpc-format').value,
            defaultModels: Object.values(CHAT_API_FORMATS).map((f) => f.defaultModel)
        });
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
    const confirmed = await showCustomConfirm('确认清除这台设备上保存的 DeepSeek、MiniMax、DashScope、MiMo、通用 OpenAI、多提供商模型与搜索（Exa / Tavily）API Key？');
    if (!confirmed) return;
    await clearStoredApiSecrets();
    document.getElementById('settingMinimaxApiKey').value = '';
    document.getElementById('settingDashscopeApiKey').value = '';
    document.getElementById('settingAsrApiKey').value = '';
    document.getElementById('settingMimoAsrApiKey').value = '';
    document.getElementById('settingMimoTtsApiKey').value = '';
    document.getElementById('settingOpenaiTtsApiKey').value = '';
    // 多提供商模型的 Key 也走密钥库（chatProviderKeys），界面上的卡内输入框要一起清空
    document.querySelectorAll('#chatProviderList .cpc-key').forEach((input) => { input.value = ''; });
    // 搜索 Key 也是 API_SECRET_NAMES 里的项，必须一起清 ——
    //   漏了它的话"清除全部 Key"之后搜索仍然能用，用户会以为没清干净。
    //   注意是**四家全清**：只清当前那家会让另外三家的 Key 留在库里。
    for (const id of Object.keys(SEARCH_PROVIDERS)) state.settings['searchApiKey_' + id] = '';
    const tavilyKeyInput = document.getElementById('settingTavilyApiKey');
    if (tavilyKeyInput) tavilyKeyInput.value = '';
    if (typeof updateTavilyHint === 'function') updateTavilyHint();
    showCustomAlert('API Key 已从当前设备清除。', '已清除');
}


