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

    const listening = voiceState === 'listening' || voiceState === 'paused';
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

