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
function updateChatFormatUI() {
    const apiFormat = elements.settingApiFormat.value || 'openai-compatible';
    const preset = CHAT_API_FORMATS[apiFormat] || CHAT_API_FORMATS['openai-compatible'];
    elements.settingBaseUrl.readOnly = false;
    elements.settingChatModel.placeholder = preset.defaultModel;
    const currentBase = String(elements.settingBaseUrl.value || '').trim();
    const looksLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(currentBase);
    elements.settingApiKey.placeholder = looksLocal
        ? '本地服务可留空；远程服务按需填写'
        : (/dashscope\.aliyuncs\.com/i.test(currentBase)
            ? 'sk-...（留空则复用语音里已填的 DashScope Key）'
            : 'sk-...（只保存在本机）');
    // 每个格式"什么时候该选它"直接写在旁边。
    // 选错格式报的错完全看不出是格式选错，这句话放在这里比放在文档里有用的多。
    const hintEl = document.getElementById('apiFormatHint');
    if (hintEl) hintEl.textContent = preset.hint || '';
    if (elements.chatFormatHint) {
        elements.chatFormatHint.textContent = `请求从当前设备直接发给 ${preset.label}，不经过作者服务器。Android Key 使用系统 Keystore 加密；Web Key 仅保存在当前标签页会话。`;
    }
}

function readProviderSettingsForm() {
    const apiFormat = elements.settingApiFormat.value || 'openai-compatible';
    const preset = CHAT_API_FORMATS[apiFormat] || CHAT_API_FORMATS['openai-compatible'];
    return {
        ...state.settings,
        apiProvider: DEFAULT_SETTINGS.apiProvider,
        apiFormat,
        baseUrl: elements.settingBaseUrl.value.trim() || preset.defaultBaseUrl,
        // 回落必须用"当前格式"的默认模型，不能用 DEFAULT_SETTINGS.model ——
        // 后者硬编码 deepseek-chat，选 Anthropic 时清空模型框就会把 deepseek-chat 发过去，
        // 而 placeholder 显示的却是 Claude 的模型名，界面上完全看不出来。
        model: elements.settingChatModel.value.trim() || preset.defaultModel,
        apiKey: elements.settingApiKey.value.trim(),
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
    // 打开设置时顺手把"当前对话模型能不能收图片"的缓存结论显示出来。
    try { if (typeof updateChatModelVisionHint === 'function') updateChatModelVisionHint(); } catch (e) { /* 提示刷新失败不该挡住设置 */ }
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

async function testChatConnection() {
    await withSettingsTestButton(elements.testChatConnectionBtn, '测试中…', async () => {
        const draft = readProviderSettingsForm();
        // 测试请求要给思考留余量，不能把 maxTokens 设得很小 —— 对**思考型模型**
        //   是个坑：例如 8 个 token 会全被模型花在 `reasoning` 上
        //   （日志里能看到 reasoning:"The user asked me to only…"），
        //   然后 finish_reason=length → 正文一个 token 都没剩 → 报"模型只返回了思考
        //   内容"。而且部分网关**不认** `thinking` 字段（它要求用 `reasoning_effort`），
        //   应用只能剥离后重试，模型于是走自己的默认（照样先思考）。
        //   给 256 个 token：思考完还能留下可见的 "OK"，测试不会假红。
        //   代价可忽略（一次测试最多几十~几百 token）。
        const reply = await callChatAPI([
            { role: 'system', content: '这是连接测试。' },
            { role: 'user', content: '只回复 OK' }
        ], { maxTokens: 256, temperature: 0 }, draft);
        if (!reply.trim()) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '对话接口返回了空内容');
        showCustomAlert(`连接成功，模型返回：${reply.trim()}`, '对话连接正常');
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
    const confirmed = await showCustomConfirm('确认清除这台设备上保存的 DeepSeek、MiniMax、DashScope、MiMo、通用 OpenAI 与搜索（Exa / Tavily）API Key？');
    if (!confirmed) return;
    await clearStoredApiSecrets();
    elements.settingApiKey.value = '';
    document.getElementById('settingMinimaxApiKey').value = '';
    document.getElementById('settingDashscopeApiKey').value = '';
    document.getElementById('settingAsrApiKey').value = '';
    document.getElementById('settingMimoAsrApiKey').value = '';
    document.getElementById('settingMimoTtsApiKey').value = '';
    document.getElementById('settingOpenaiTtsApiKey').value = '';
    // 搜索 Key 也是 API_SECRET_NAMES 里的项，必须一起清 ——
    //   漏了它的话"清除全部 Key"之后搜索仍然能用，用户会以为没清干净。
    //   注意是**四家全清**：只清当前那家会让另外三家的 Key 留在库里。
    for (const id of Object.keys(SEARCH_PROVIDERS)) state.settings['searchApiKey_' + id] = '';
    const tavilyKeyInput = document.getElementById('settingTavilyApiKey');
    if (tavilyKeyInput) tavilyKeyInput.value = '';
    if (typeof updateTavilyHint === 'function') updateTavilyHint();
    showCustomAlert('API Key 已从当前设备清除。', '已清除');
}


