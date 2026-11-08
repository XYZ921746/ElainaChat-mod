/* 设置面板开合与表单回填，以及语音态驱动的悬浮麦克风对齐。 */

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

    const dockVisible = listening && !state.notesMode && !state.diaryMode && !state.memoryPageMode;
    elements.floatingMic.classList.toggle('hidden', !dockVisible);
    if (dockVisible) requestAnimationFrame(alignFloatingMicToComposer);
}

function fillSettingsForm() {
    // 二级页不跨开关保留：先把移到 #settingsSubpage 的编辑节点移回卡片。
    closeSettingsSubpage();
    // 每次打开都回到一级列表：编辑状态不跨开关保留。
    resetChatProviderEditing();
    renderChatProviderSettings();
    // 回填只走 syncThinkingModeControls 一处 —— 分散写就有一天忘记同步新增档位。
    syncThinkingModeControls();
    // 采样参数同理：开关 / 滑杆 / 数值文案的同步只走 syncSamplingControls 一处。
    syncSamplingControls(null, true);
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

    // 模型分栏每次打开都回到对话分类页；四类语音/向量详情也回到各自列表（详情字段由渲染函数按提供商回填）。
    resetModelSectionPage();
    resetModelProviderPages();

    // MiMo 克隆样本仍是全局设置：文件框不能程序化回填，清空控件、已存样本用文件名展示。
    const cloneInput = document.getElementById('settingMimoTtsCloneSample');
    if (cloneInput) cloneInput.value = '';
    updateMimoTtsCloneSampleStatus();
    fillMemoryModelSelect();
    fillMemoryBindingSelects();
    elements.settingMemoryEvery.value = state.settings.memoryEvery || 15;
    document.querySelectorAll('input[name="agentAccess"]').forEach(r => {
        r.checked = (r.value === currentAgentAccess());
    });
    const phoneToggle = document.getElementById('settingAgentPhoneEnabled');
    if (phoneToggle) phoneToggle.checked = state.settings.agentPhoneEnabled !== false;
    const browserToggle = document.getElementById('settingAgentBrowserEnabled');
    if (browserToggle) browserToggle.checked = state.settings.agentBrowserEnabled === true;
    void refreshBrowserStatus();
    fillTavilySettings();
    renderChatBindings();
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
    // 日志查看器不在这里打开（入口是设置分区导航的「日志」项：data-settings-tab="tab-log" 经 shell.js 的 switchSettingsTab 打开）：调了会让"打开设置"顺带弹出日志页。
}


function openSettings() {
    fillSettingsForm();
    void refreshAuthStatus();
    // 每次打开设置都刷新插件列表：用户可能在服务运行期间往 mods/ 丢了新 zip。
    void refreshModsList();
    // MCP 状态取自只读接口（不启动进程），与插件页一起刷没有代价。
    if (typeof refreshMcpList === 'function') void refreshMcpList();
    // 深色切换归顶栏三段开关管（见 bindings.js 的 markThemeSeg），这里不碰 #themeDarkMode。
    if (window.ElainaTheme) {
        window.ElainaTheme.renderPicker();
        window.ElainaTheme.markPicker();
        // 「跟随设备」要取打开设置那一刻的系统状态，所以重新落一次深色 DOM
        window.ElainaTheme.setDarkMode(window.ElainaTheme.darkMode());
    }
    openOverlayPanel(elements.settingsOverlay);
    setRailActive('settings');
}

function closeSettingsPanel() {
    // 二级页的编辑节点先移回卡片，否则下次打开设置会停在别人家的页面上。
    closeSettingsSubpage();
    // 面板一关日志分栏就不可见，继续每 2 秒拉 /api/logs/tail 是纯自噪音
    try { if (window.LogViewer) window.LogViewer.close(); } catch (e) { /* 忽略 */ }
    // 用户改完最后一项马上点 ✕ 时，那次改动还排在 300ms 防抖里，不冲就会丢
    try { flushAutoSave(); } catch (e) { /* 忽略：关闭不该因为保存失败而卡住 */ }
    // 扩展子分栏是面板内的展开态，关设置时一并收起，下次进来不会停在半展开。
    try {
        if (typeof switchExtTab === 'function') {
            switchExtTab((typeof state !== 'undefined' && state && state._extTab) || 'ext-mod', { forceClose: true });
        }
    } catch (e) { /* 扩展模块不在时不挡住关闭 */ }
    closeOverlayPanel(elements.settingsOverlay, syncRailActive);
}

function updateSliderFill(slider) {
    if (!slider) return;
    const min = Number(slider.min || 0);
    const max = Number(slider.max || 100);
    const value = Number(slider.value || min);
    const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
    slider.style.setProperty('--slider-progress', `${Math.max(0, Math.min(100, percent))}%`);
}

/** 采样参数「开关 / 滑杆 / 数值文案」的同步只此一处（字段表见 core-config.js 的 CHAT_SAMPLING_FIELDS）：开关关着 = 该项不发送，滑杆停在默认值但禁用。 */
function syncSamplingControls(only, walkState) {
    for (const field of (only ? [only] : CHAT_SAMPLING_FIELDS)) {
        const slider = elements[field.element];
        const toggle = elements[field.enableElement];
        if (!slider) continue;
        if (walkState) {
            const raw = normalizeSamplingInput(state.settings[field.setting], field);
            const enabled = raw !== '';
            if (toggle) toggle.checked = enabled;
            slider.disabled = !enabled;
            slider.value = String(enabled ? Number(raw) : field.defaultValue);
            updateSamplingValueLabel(field, enabled ? Number(raw) : null);
        } else if (toggle) {
            slider.disabled = !toggle.checked;
            updateSamplingValueLabel(field, toggle.checked ? Number(slider.value) : null);
        }
        updateSliderFill(slider);
    }
}

function updateSamplingValueLabel(field, value) {
    const label = elements[field.valueElement];
    if (!label) return;
    label.textContent = value == null
        ? '服务商默认'
        : String(Number(Number(value).toFixed(field.decimals)));
    label.style.opacity = value == null ? '0.55' : '1';
}

let greetingTyping = false;
function startGreetingTyping() {
    if (greetingTyping) return;
    const el = document.getElementById('greetingText');
    const text = state.characterCard.greeting || DEFAULT_CHARACTER_CARD.greeting;
    // reduce-motion 用户不要逐字蹦字：整句直接落定（与主题切换、插件光晕同一口径）。
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.textContent = text;
        return;
    }
    greetingTyping = true;
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

