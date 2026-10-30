/* ========================================================================
 * 设置与运维：状态机 / 设置 / 悬浮窗 / 副屏监视 / 日志 / 数据 / 密码
 * ======================================================================== */

// ==================== 状态机 UI ====================

function alignFloatingMicToComposer() {
    if (!elements.floatingMic || elements.floatingMic.classList.contains('hidden')) return;
    const conversationComposer = elements.inputBar && !elements.inputBar.classList.contains('hidden')
        ? elements.inputBar.querySelector('.conversation-composer')
        : null;
    const initialComposer = elements.initialState && !elements.initialState.classList.contains('hidden')
        ? elements.initialState.querySelector('.initial-composer-shell')
        : null;
    const target = conversationComposer || initialComposer;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    elements.floatingMic.style.left = `${Math.round(rect.left)}px`;
    elements.floatingMic.style.top = `${Math.round(rect.top)}px`;
    elements.floatingMic.style.width = `${Math.round(rect.width)}px`;
    elements.floatingMic.style.transform = 'none';
}

let lastVoiceStateDispatch = '';
function updateUI() {
    const { voiceState } = state;

    // 通知视频通话界面（Live2D）语音状态变化：🎤 说话按钮同步聆听状态
    if (voiceState !== lastVoiceStateDispatch) {
        lastVoiceStateDispatch = voiceState;
        window.dispatchEvent(new CustomEvent('voice-state', { detail: { state: voiceState } }));
    }

    const statusMap = {
        'idle': '点击麦克风开始说话',
        'listening': '正在聆听...',
        'paused': '⏸ 已暂停（可继续说话，或点麦克风结束）',
        'thinking': '伊蕾娜思考中...',
        'error': '发生错误'
    };
    elements.statusText.textContent = statusMap[voiceState] || '';

    const micClass = {
        'listening': 'mic-btn mic-listening relative w-32 h-32 rounded-full flex items-center justify-center',
        'paused': 'mic-btn mic-paused relative w-32 h-32 rounded-full flex items-center justify-center',
        'thinking': 'mic-btn mic-thinking relative w-32 h-32 rounded-full flex items-center justify-center',
        'error': 'mic-btn mic-error relative w-32 h-32 rounded-full flex items-center justify-center',
        'idle': 'mic-btn mic-idle relative w-32 h-32 rounded-full flex items-center justify-center'
    };
    elements.micBtn.className = micClass[voiceState] || micClass['idle'];

    const listening = voiceState === 'listening' || voiceState === 'paused';
    elements.pulseRing1.classList.toggle('hidden', !listening);
    elements.pulseRing2.classList.toggle('hidden', !listening);
    elements.floatingPulse1.classList.toggle('hidden', !listening);
    elements.floatingPulse2.classList.toggle('hidden', !listening);

    if (elements.floatingVoiceTitle) {
        elements.floatingVoiceTitle.textContent = voiceState === 'paused' ? '等待继续说话' : '正在聆听';
        elements.floatingVoiceHint.textContent = voiceState === 'paused'
            ? '继续说话，或点击绿色按钮发送'
            : '说完后点击麦克风发送';
    }

    const dockVisible = listening && !state.notesMode && !state.diaryMode;
    elements.floatingMic.classList.toggle('hidden', !dockVisible);
    if (dockVisible) requestAnimationFrame(alignFloatingMicToComposer);
}


// ==================== 设置 ====================

// 把 state.settings / state.characterCard 填充到设置表单（打开设置 / 恢复默认后调用）
function fillSettingsForm() {
    // 回落用"当前格式"的预设，不要用 DEFAULT_SETTINGS —— 后者写死 DeepSeek 的地址和模型，
    // 选 Anthropic 时清空输入框会回落到 DeepSeek 的 URL，看起来像"格式没生效"。
    const fillPreset = CHAT_API_FORMATS[state.settings.apiFormat] || CHAT_API_FORMATS['openai-compatible'];
    elements.settingApiFormat.value = state.settings.apiFormat || 'openai-compatible';
    elements.settingBaseUrl.value = state.settings.baseUrl || fillPreset.defaultBaseUrl;
    elements.settingChatModel.value = state.settings.model || fillPreset.defaultModel;
    elements.settingApiKey.value = state.settings.apiKey;
    // 思考模式：开关 + 强度。用 syncThinkingModeControls() 统一回填，
    // 不在这里各写一遍 —— 回填逻辑分散就会有一天忘记同步新增的档位。
    syncThinkingModeControls();
    elements.settingTtsProvider.value = state.settings.ttsProvider || 'mimo';
    document.getElementById('settingMinimaxApiKey').value = state.settings.minimaxApiKey || '';
    document.getElementById('settingMinimaxVoice').value = state.settings.minimaxVoice || '';
    document.getElementById('settingMinimaxModel').value = state.settings.minimaxModel || 'speech-2.8-hd';
    document.getElementById('settingDashscopeTtsModel').value = state.settings.dashscopeTtsModel || 'qwen3-tts-flash';
    document.getElementById('settingDashscopeTtsVoice').value = state.settings.dashscopeTtsVoice || 'Cherry';
    document.getElementById('settingVisionBaseUrl').value = state.settings.visionBaseUrl || '';
    document.getElementById('settingVisionApiKey').value = state.settings.visionApiKey || '';
    document.getElementById('settingVisionModel').value = state.settings.visionModel || '';
    elements.settingTtsSpeed.value = state.settings.ttsSpeed;
    elements.ttsSpeedLabel.textContent = state.settings.ttsSpeed.toFixed(1) + 'x';
    elements.settingTtsVolume.value = Number(state.settings.ttsVolume ?? 1);
    elements.ttsVolumeLabel.textContent = Math.round(Number(state.settings.ttsVolume ?? 1) * 100) + '%';
    updateSliderFill(elements.settingTtsSpeed);
    updateSliderFill(elements.settingTtsVolume);

    document.querySelectorAll('input[name="ttsLang"]').forEach(r => {
        r.checked = (r.value === (state.settings.ttsLang || 'japanese'));
    });
    document.querySelectorAll('input[name="replyDisplayMode"]').forEach(r => {
        r.checked = (r.value === (state.settings.replyDisplayMode || DEFAULT_SETTINGS.replyDisplayMode));
    });

    document.querySelectorAll('input[name="asrProvider"]').forEach(r => {
        r.checked = (r.value === (state.settings.asrProvider || 'browser'));
    });
    updateChatFormatUI();
    updateAsrProviderUI();
    updateTtsProviderUI();

    document.getElementById('settingDashscopeApiKey').value = state.settings.dashscopeApiKey || '';
    // 阿里百炼 ASR 的 Key：独立于语音输出（与 TTS 的 dashscopeApiKey 分开存）
    document.getElementById('settingAsrApiKey').value = state.settings.asrApiKey || '';
    document.getElementById('settingDashscopeAsrBaseUrl').value = state.settings.dashscopeAsrBaseUrl || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
    document.getElementById('settingDashscopeAsrModel').value = state.settings.dashscopeAsrModel || 'qwen3-asr-flash';
    // MiMo TTS 凭据（独立于 ASR）。Key 默认空；接口地址固定在默认值里（界面上已删除该输入框）。
    document.getElementById('settingMimoTtsApiKey').value = state.settings.mimoTtsApiKey || '';
    // MiMo ASR 凭据（内部键名仍为 mimoApiKey / mimoBaseUrl：为兼容已存数据不改键名）
    document.getElementById('settingMimoAsrApiKey').value = state.settings.mimoApiKey || '';
    document.getElementById('settingMimoAsrBaseUrl').value = state.settings.mimoBaseUrl || 'https://api.xiaomimimo.com';
    document.getElementById('settingMimoTtsModel').value = state.settings.mimoTtsModel || 'mimo-v2.5-tts';
    document.getElementById('settingMimoTtsVoice').value = state.settings.mimoTtsVoice || 'mimo_default';
    document.getElementById('settingMimoVoiceDesignPrompt').value = state.settings.mimoTtsVoiceDesignPrompt || '';
    // 文件框不能程序化回填：清空控件，改用状态里保存的文件名/数据展示已存样本
    const cloneInput = document.getElementById('settingMimoTtsCloneSample');
    if (cloneInput) cloneInput.value = '';
    updateMimoTtsCloneSampleStatus();
    updateMimoTtsModelUI();
    document.getElementById('settingOpenaiTtsBaseUrl').value = state.settings.openaiTtsBaseUrl || 'https://api.openai.com/v1';
    document.getElementById('settingOpenaiTtsApiKey').value = state.settings.openaiTtsApiKey || '';
    document.getElementById('settingOpenaiTtsModel').value = state.settings.openaiTtsModel || 'tts-1';
    document.getElementById('settingOpenaiTtsVoice').value = state.settings.openaiTtsVoice || 'alloy';
    document.getElementById('settingMimoAsrModel').value = state.settings.mimoAsrModel || 'mimo-v2.5-asr';
    elements.settingAutoMemory.checked = Boolean(state.settings.autoMemory);
    elements.settingMemoryEvery.value = state.settings.memoryEvery || 6;
    // 三档 AI 权限
    document.querySelectorAll('input[name="agentAccess"]').forEach(r => {
        r.checked = (r.value === currentAgentAccess());
    });
    const phoneToggle = document.getElementById('settingAgentPhoneEnabled');
    if (phoneToggle) phoneToggle.checked = state.settings.agentPhoneEnabled !== false;
    const browserToggle = document.getElementById('settingAgentBrowserEnabled');
    if (browserToggle) browserToggle.checked = state.settings.agentBrowserEnabled === true;
    void refreshBrowserStatus();
    // AI 联网搜索
    fillTavilySettings();
    // 图片转述：开关 + 整块控件的显隐（与联网搜索同一套做法）
    fillVisionSettings();
    fillAgentReadToggles();
    renderAgentFolderSummary();
    void refreshAgentReadPermStatus();
    syncAgentSectionsByDevice();

    renderCardSelect();
    fillCharacterCardForm();
    settingsContent.scrollTop = 0;
    renderScheduledTaskList();
    void refreshDataSettings();
    void refreshOverlayStatus();
    // 日志查看器**不从设置里打开**：它的显示入口是 railLogBtn →
    //   window.LogViewer.open()（见 init.js）。
    //   不要在设置里再调 open()：那会让"打开设置"顺带弹出日志页。
}


function openSettings() {
    fillSettingsForm();
    void refreshAuthStatus();
    // 每次打开设置都刷新插件列表：用户可能在服务运行期间往 mods/ 丢了新 zip，
    // 刷新一次就能看到（而不是要求他重启服务）
    void refreshModsList();
    // MCP 与插件同在一页的不同子分栏里，打开设置时一起刷 ——
    //   状态取自只读接口（不启动进程），所以刷它没有代价。
    if (typeof refreshMcpList === 'function') void refreshMcpList();
    // 外观主题：同步模板卡片选择态（深色切换已移到顶栏三段开关，
    // 由 init.js 的 markThemeSeg 自行同步 —— 这里不再碰 #themeDarkMode，
    // 否则会留下"HTML 里没有的 id"悬空引用）
    if (window.ElainaTheme) {
        window.ElainaTheme.renderPicker();
        window.ElainaTheme.markPicker();
        // 重新落一次深色模式 DOM：让「跟随设备」在打开设置时取到最新的系统状态
        window.ElainaTheme.setDarkMode(window.ElainaTheme.darkMode());
    }
    elements.settingsOverlay.classList.remove('hidden');
    elements.settingsOverlay.classList.add('flex');
    setRailActive('settings');
}

function closeSettingsPanel() {
    // 停掉日志轮询：面板一关，日志分栏就不可见了，
    //   继续每 2 秒拉 /api/logs/tail 是纯自噪音（服务端日志会被它刷屏）。
    try { if (window.LogViewer) window.LogViewer.close(); } catch (e) { /* 忽略 */ }
    // 关闭前把待保存的改动冲掉 —— 用户改完最后一项马上点 ✕ 时，
    //   那次改动还排在 300ms 防抖里，不冲就会丢（见 flushAutoSave 的说明）。
    try { flushAutoSave(); } catch (e) { /* 忽略：关闭不该因为保存失败而卡住 */ }
    elements.settingsOverlay.classList.add('hidden');
    elements.settingsOverlay.classList.remove('flex');
    syncRailActive();
}

function updateSliderFill(slider) {
    if (!slider) return;
    const min = Number(slider.min || 0);
    const max = Number(slider.max || 100);
    const value = Number(slider.value || min);
    const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
    slider.style.setProperty('--slider-progress', `${Math.max(0, Math.min(100, percent))}%`);
}

/**
 * 把设置表单的当前内容落盘。
 *
 * 设置是「改完即生效」——没有底部「保存设置」按钮，
 *   任何控件一变就自动调这个函数（见 init.js 的自动保存绑定）。
 *   所以它**不能弹提示、不能关面板**，否则用户每改一项都被弹窗打断。
 *
 * @param {{silent?: boolean}} [opts]
 *   silent=true 时：跳过「设置已保存！」提示与面板关闭（自动保存用）。
 *   无论哪种模式，落盘行为完全一致 —— 不存在"自动保存少存了什么"。
 */
async function saveSettings(opts) {
    const silent = Boolean(opts && opts.silent);
    const asrProvider = document.querySelector('input[name="asrProvider"]:checked')?.value || 'browser';
    const ttsLang = document.querySelector('input[name="ttsLang"]:checked')?.value || 'chinese';
    const replyDisplayMode = document.querySelector('input[name="replyDisplayMode"]:checked')?.value || DEFAULT_SETTINGS.replyDisplayMode;
    const providerSettings = readProviderSettingsForm();
    if (!providerSettings.baseUrl) {
        if (!silent) showCustomAlert('自定义模式下必须填写 API Base URL。', '设置未保存');
        return;
    }
    // 切到「完全访问」时，把后果在这里一次性讲清楚。
    // 为什么放在保存这一步、而不是每次操作都弹：
    // 完全访问下 AI 每一步都问，用户会从"看清内容再决定"退化成"闭眼点允许"，
    // 最后那道闸反而等于没有。所以判断前移到这个**一次性**的节点上。
    // 只在"真的发生切换"时问 —— 已经是 full 又点保存不该再打扰。
    const nextAccess = document.querySelector('input[name="agentAccess"]:checked')?.value || 'strict';
    if (nextAccess === 'full' && currentAgentAccess() !== 'full') {
        // 自动保存（silent）路径**也要问** —— 这是安全闸门，不能因为
        //   "弹窗会打断用户"就跳过：设置改完即生效，用户点一下单选钮
        //   就会落盘，如果这里不问，"完全访问"就被静默开启了。
        //   拒绝时把单选钮拨回切换前的档，让界面与实际状态一致
        //   （否则界面显示"完全访问"、实际仍是原档，用户会以为已经开了）。
        const agreed = await showCustomConfirm(
            '「完全访问」= AI 可以在这台电脑上做任何事，且**不再询问你**。\n\n'
            + '开启后，AI 可以：\n'
            + '· 读写这台电脑上任意路径的文件\n'
            + '· 执行 PowerShell / cmd 命令（含删除类命令）\n'
            + '· **删除文件与目录** —— 不进回收站、无法恢复\n'
            + '· 覆盖已有文件（原内容不会自动备份）\n'
            + '· 改注册表、关机、下载并执行网上的脚本\n\n'
            + '与另外两档的关键差别：**这些操作都不会再问你**。\n'
            + '发现问题只能事后补救，而删除这类操作是补救不了的。\n\n'
            + '请只在你自己可控、且信任当前对话内容时开启。确定吗？',
            '⚠️ 开启「完全访问」');
        if (!agreed) {
            const prev = currentAgentAccess();
            document.querySelectorAll('input[name="agentAccess"]').forEach((r) => {
                r.checked = (r.value === prev);
            });
            return;
        }
    }
    state.settings = {
        ...providerSettings,
        ttsSpeed: parseFloat(elements.settingTtsSpeed.value) || 1.0,
        ttsVolume: Math.max(0, Math.min(2, parseFloat(elements.settingTtsVolume.value) || 0)),
        ttsLang,
        replyDisplayMode,
        asrProvider,
        autoMemory: elements.settingAutoMemory.checked,
        memoryEvery: Math.max(3, Math.min(50, parseInt(elements.settingMemoryEvery.value, 10) || 6)),
        agentAccess: nextAccess,
        agentPhoneEnabled: document.getElementById('settingAgentPhoneEnabled')?.checked !== false,
        // 浏览器：判据是 === true（见 data.js 的说明）—— 控件不在页面上时按关闭处理，
        //   不能像上面那样用 "!== false" 兜成默认开启。
        agentBrowserEnabled: document.getElementById('settingAgentBrowserEnabled')?.checked === true,
        // AI 联网搜索。判据同样是 === true：控件缺失时按关闭处理。
        tavilySearchEnabled: document.getElementById('settingTavilyEnabled')?.checked === true,
        searchProvider: SEARCH_PROVIDERS[document.getElementById('settingSearchProvider')?.value]
            ? document.getElementById('settingSearchProvider').value : DEFAULT_SEARCH_PROVIDER,
        // Key 写进**当前服务商那一格**，不覆盖别家的 —— 用户换家只是想避开超时，
        //   换回来时原来的 Key 还应该在。
        ['searchApiKey_' + (SEARCH_PROVIDERS[document.getElementById('settingSearchProvider')?.value]
            ? document.getElementById('settingSearchProvider').value : DEFAULT_SEARCH_PROVIDER)]:
            document.getElementById('settingTavilyApiKey')?.value.trim() || '',
        // 条数收敛到**当前服务商**允许的上限内；解析失败回落到 5
        //   （默认值不能是 0 —— 0 条等于什么都没搜）
        tavilyMaxResults: Math.max(1, Math.min(
            (SEARCH_PROVIDERS[document.getElementById('settingSearchProvider')?.value] || SEARCH_PROVIDERS[DEFAULT_SEARCH_PROVIDER]).maxResultsLimit,
            parseInt(document.getElementById('settingTavilyMaxResults')?.value, 10) || 5
        )),
        // 自定义搜索源：端点是用户填的，保存时就校验 https（发请求时也校验，
        //   这里先拦一道是为了让用户在保存那一刻就知道填错了）。
        searchCustomEndpoint: (() => {
            const raw = String(document.getElementById('settingSearchCustomEndpoint')?.value || '').trim();
            if (!raw) return '';
            if (!/^https:\/\//i.test(raw)) {
                showCustomAlert('自定义搜索源的地址必须以 https:// 开头。\n\nKey 会随请求发出去，明文 http 不安全。', '地址不安全');
                throw new ClientApiError('APP_BAD_URL', '自定义搜索源地址不是 https');
            }
            return raw;
        })(),
        searchCustomAuth: ['bearer', 'raw', 'x-api-key', 'none'].includes(document.getElementById('settingSearchCustomAuth')?.value)
            ? document.getElementById('settingSearchCustomAuth').value : 'bearer',
        searchCustomAuthHeader: String(document.getElementById('settingSearchCustomAuthHeader')?.value || '').trim() || 'Authorization',
        searchCustomBody: String(document.getElementById('settingSearchCustomBody')?.value || '').trim(),
        searchCustomResultsPath: String(document.getElementById('settingSearchCustomResultsPath')?.value || '').trim(),
        // 深度只认两个合法值，其余一律回落 basic（非法值发给服务商会被拒，不如当场收敛）
        tavilySearchDepth: document.getElementById('settingTavilySearchDepth')?.value === 'advanced' ? 'advanced' : 'basic',
        ...readAgentReadToggles(),
        // 思考：UI 上只有一个"思考强度"四档下拉（off 就是"不思考"）。
        // `thinkingMode` 由它**派生** —— 请求层与「思考」折叠栏仍读这个布尔量，
        // 所以两处都要落到同一个来源，绝不能让它和档位脱节（见 core.js 的说明）。
        // 注意这个控件是"改了立刻生效 + 立刻持久化"的（见 init.js），
        // 这里再读一次是为了覆盖"用户改了控件但没点保存、又点了保存"的路径。
        thinkingMode: elements.settingThinkingEffort.value !== 'off'
            && THINKING_EFFORTS.includes(elements.settingThinkingEffort.value),
        thinkingEffort: THINKING_EFFORTS.includes(elements.settingThinkingEffort.value)
            ? elements.settingThinkingEffort.value
            : 'off',
        // 对话优化：第三人称两段式开关。与上面一样"改了立刻生效 + 立刻持久化"，
        // 这里再读一次是为了覆盖"改了控件但没点保存、又点了保存"的路径。
        thirdPerson: elements.settingThirdPerson.checked
    };
    try {
        await saveApiSecrets(state.settings);
    } catch (error) {
        // 密钥存储失败不阻断设置保存（其他设置仍生效；密钥兜底存 localStorage）
        console.warn('[BYOK] 密钥存储失败（设置仍已保存，密钥可能下次失效）', error);
    }
    persistSettings();

    // 存回「当前这套人设」，并落盘整个列表 —— 多套之间互不覆盖
    syncFormToCurrentCard();
    state.characterCard = cardContent(currentCard());
    persistCharacterCards();
    saveCharacterCard();
    renderCardSelect();

    // 自动保存（silent）时**不关面板、不弹提示** ——
    //   用户还在改，弹窗会打断；关面板更荒唐（改一项就被踢出去）。
    if (!silent) {
        closeSettingsPanel();
        showCustomAlert('设置已保存！', '保存成功');
    }
}

/**
 * 自动保存：设置改成「改完即生效」后的唯一入口。
 *
 * 设计要点：
 *  · **防抖 300ms** —— 文本输入框每敲一个字都会触发 input，
 *    不防抖就会每字符跑一遍 saveApiSecrets（Android 上要过 Keystore，很贵）。
 *  · 只监听 #settingsPanel 内的控件，且排除插件页（#tab-mods）——
 *    插件自己的控件归插件管，宿主不该替它们落盘。
 *  · change 事件覆盖 select / checkbox / radio；input 覆盖文本框与滑杆。
 *    两者都挂，靠防抖合并重复触发。
 */
let autoSaveTimer = null;
function scheduleAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        Promise.resolve(saveSettings({ silent: true })).catch((e) => {
            console.warn('[Settings] 自动保存失败', e);
        });
    }, 300);
}

/**
 * 立刻把待保存的改动落盘（不等防抖）。
 *
 * 为什么必须有：用户改完最后一项**马上点 ✕ 关闭**是很常见的操作 ——
 *   那次 change 只是排了一个 300ms 的定时器，如果关闭时不冲一下，
 *   定时器随后触发（或永远不触发）就会**丢掉最后一次修改**。
 */
function flushAutoSave() {
    if (!autoSaveTimer) return;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    Promise.resolve(saveSettings({ silent: true })).catch((e) => {
        console.warn('[Settings] 关闭前保存失败', e);
    });
}

/** 把自动保存挂到设置面板上（init.js 调用一次） */
function bindSettingsAutoSave() {
    const panel = document.getElementById('settingsPanel');
    if (!panel) return;
    const onEdit = (ev) => {
        const t = ev.target;
        if (!t || !t.closest) return;
        // 插件页里的控件不归宿主管
        if (t.closest('#tab-mods')) return;
        // 纯展示控件不触发保存
        if (t.matches('button, [type="button"], [type="submit"], [type="file"]')) return;
        scheduleAutoSave();
    };
    panel.addEventListener('change', onEdit, true);
    panel.addEventListener('input', onEdit, true);
}

// 不提供「恢复默认设置」（restoreDefaultSettings）这个一键回退入口：
//   设置改完即生效，一键回退会连带把用户自己录的凭据一起清掉。
//   需要回默认值就在界面上逐项改，或删掉 data/ 目录重来。

function previewPrompt() {
    const card = {
        name: document.getElementById('ccName').value.trim() || '伊蕾娜',
        title: document.getElementById('ccTitle').value.trim() || '灰之魔女',
        worldSetting: document.getElementById('ccWorldSetting').value.trim(),
        characterPrompt: document.getElementById('ccCharacterPrompt').value.trim(),
        greeting: document.getElementById('ccGreeting').value.trim()
    };
    // 只展示用户可编辑的部分（核心协议 + 世界观 + 角色卡），
    // 系统注入的 Live2D 表现标签、Agent 操作指令等内部提示不在此展示，避免用户误改。
    const name = card.name;
    const title = card.title;
    const prompt = `${ROLEPLAY_CORE_PROTOCOL}

# 世界观设定
${card.worldSetting}

# 角色卡
角色名：${name}
称号：${title}
${card.characterPrompt}

（说明：系统还会附加 Live2D 表现与 AI 操作等内部指令，不在此展示。）`;
    showCustomAlert(prompt, '角色卡生成的 System Prompt');
}

function resetCharacterCard() {
    document.getElementById('ccName').value = DEFAULT_CHARACTER_CARD.name;
    document.getElementById('ccTitle').value = DEFAULT_CHARACTER_CARD.title;
    document.getElementById('ccWorldSetting').value = DEFAULT_CHARACTER_CARD.worldSetting;
    document.getElementById('ccCharacterPrompt').value = DEFAULT_CHARACTER_CARD.characterPrompt;
    document.getElementById('ccGreeting').value = DEFAULT_CHARACTER_CARD.greeting;
}


// ==================== 问候打字机 ====================

let greetingTyping = false;
function startGreetingTyping() {
    if (greetingTyping) return;
    greetingTyping = true;
    const el = document.getElementById('greetingText');
    const text = state.characterCard.greeting || DEFAULT_CHARACTER_CARD.greeting;
    el.classList.add('typing-cursor');
    let i = 0;
    const timer = setInterval(() => {
        i++;
        el.textContent = text.substring(0, i);
        if (i >= text.length) {
            clearInterval(timer);
            el.classList.remove('typing-cursor');
            greetingTyping = false;
        }
    }, 45);
}

