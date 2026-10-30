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


// ==================== 操作悬浮窗（APK 独有） ====================
// AI 操作的是别的应用：没有悬浮窗时每步确认都要切回本应用，而切回来会把目标应用退到后台，那一步就可能失败
//   → AI 重试 → 看起来像卡住。悬浮窗浮在目标应用之上，就是打破这个循环的唯一办法。
// 它是 Android 的**特殊权限**（「显示在其他应用上层」），只能由用户在系统设置里手动打开 ——
//   应用无法弹运行时权限框索取，所以这里只能「跳过去 + 回来复检」。
async function refreshOverlayStatus() {
    const dot = document.getElementById('overlayStatusDot');
    const text = document.getElementById('overlayStatusText');
    const btn = document.getElementById('overlayEnableBtn');
    const wrap = document.getElementById('overlayStatusDot')?.closest('div')?.parentElement;
    if (!text) return;

    const plugin = deviceBridge();
    // 网页版没有原生层：整块隐藏（在那个环境里这个设置本来就不适用）
    if (!plugin || typeof plugin.overlayStatus !== 'function') {
        if (wrap) wrap.classList.add('hidden');
        return;
    }
    if (wrap) wrap.classList.remove('hidden');
    try {
        const res = await plugin.overlayStatus();
        const ok = Boolean(res && res.canDraw);
        if (dot) dot.className = 'w-2 h-2 rounded-full flex-none ' + (ok ? 'bg-emerald-400' : 'bg-amber-400');
        text.textContent = ok ? '已开启' : '未开启（AI 操作时会提示你开）';
        if (btn) btn.textContent = ok ? '去系统设置检查' : '开启悬浮窗';
    } catch (e) {
        text.textContent = '检测失败';
    }
}

/**
 * 跳到系统设置里的「显示在其他应用上层」，让用户开启悬浮窗权限。
 *
 * @param opts.quiet 静默模式：不弹"已打开系统设置"的说明框。
 *   AI 操作流程里要用它 —— 那时用户正要去看 AI 做了什么，
 *   再叠一个说明框会挡住视线（而且他刚从确认框点过来的，已经知道自己在干什么）。
 */
async function enableOverlay(opts) {
    const quiet = Boolean(opts && opts.quiet);
    const plugin = deviceBridge();
    if (!plugin || typeof plugin.requestOverlay !== 'function') {
        showCustomAlert('当前环境没有原生设备层（电脑版没有这个功能）。', '操作悬浮窗');
        return;
    }
    try {
        await plugin.requestOverlay();
        if (quiet) return;
        // 跳到系统设置后用户会切走再回来 —— 这时 fillSettingsForm 会重新跑一次，
        // 但用户也可能直接返回而没触发刷新，所以下面给一句明确的手动提示。
        showCustomAlert(
            '已打开系统设置。\n\n'
            + '请找到并打开「显示在其他应用上层」/「悬浮窗」权限，然后返回本应用。\n\n'
            + '回来后在设置里点「重新检测」确认状态变成「已开启」。',
            '操作悬浮窗');
    } catch (e) {
        showCustomAlert('打开系统设置失败：' + (e.message || e), '操作悬浮窗');
    }
}


// ===== 手机「读取信息」隐私开关 =====
// 六个开关各对应一类隐私数据，默认全开；关掉后 AI **连标签都看不到**（见 phoneReadAllowed）——
//   这是「根本没这个能力」，而不是「读了不说」，后者对用户毫无保障。
// 开关 id ↔ 设置字段 ↔ 手机操作名 的对应关系集中在下面这张表，避免在四处各写一遍字符串而漏掉一处。
const AGENT_READ_TOGGLES = [
    { id: 'settingAgentReadApps', key: 'agentReadApps', action: '手机应用列表', label: '已安装应用列表' },
    { id: 'settingAgentReadNotifications', key: 'agentReadNotifications', action: '手机通知', label: '通知内容' },
    { id: 'settingAgentReadDevice', key: 'agentReadDevice', action: '手机设备信息', label: '设备与前台状态' },
    { id: 'settingAgentReadSms', key: 'agentReadSms', action: '手机短信', label: '短信' },
    { id: 'settingAgentReadContacts', key: 'agentReadContacts', action: '手机通讯录', label: '通讯录' },
    { id: 'settingAgentReadCalendar', key: 'agentReadCalendar', action: '手机日历', label: '日历' },
];

/** 把设置里的值刷到界面开关上 */
function fillAgentReadToggles() {
    for (const t of AGENT_READ_TOGGLES) {
        const el = document.getElementById(t.id);
        // 默认**关**（与 core.js 的 DEFAULTS 保持一致）。
        //   已存过的值照旧尊重用户选择，只有"从没设过"的才落到关 ——
        //   这些是隐私数据，不能因为用户没表态就当同意。
        if (el) el.checked = state.settings[t.key] === true;
    }
}

/**
 * 从界面开关读回一份设置补丁。
 *
 * 元素不在时**保留原值**（而不是写 undefined / 漏掉键）：
 *   设置页在电脑上会把整块「手机操作」隐藏（syncAgentSectionsByDevice），
 *   将来若有人把这块 DOM 挪走或按需渲染，漏掉的键会让 state.settings
 *   丢掉那个字段 —— 而 saveSettings 是**整体替换** state.settings 的，
 *   丢一个键就等于把用户的开关重置回默认。所以这里显式兜底。
 */
function readAgentReadToggles() {
    const patch = {};
    for (const t of AGENT_READ_TOGGLES) {
        const el = document.getElementById(t.id);
        patch[t.key] = el ? el.checked : (state.settings[t.key] !== false);
    }
    return patch;
}

/**
 * 某个读取类操作现在允许吗（供 agent.js 的分发与提示词用）。
 *
 * 找不到对应开关的操作（例如手机状态）一律放行 —— 那张表只列**隐私数据**，
 * 界面/状态这类不涉及隐私的读取不该被这些开关误伤。
 */
function phoneReadAllowed(action) {
    const t = AGENT_READ_TOGGLES.find((x) => x.action === action);
    if (!t) return true;
    return state.settings[t.key] !== false;
}

// ===== Agent 工作区 / 用户授权文件夹=====

/** 把当前授权文件夹的状态刷到设置页文字上 */
function renderAgentFolderSummary() {
    const el = document.getElementById('agentFolderSummary');
    if (!el) return;
    const name = String(state.settings.agentFolderName || '').trim();
    const uri = String(state.settings.agentFolderUri || '').trim();
    if (uri) {
        el.textContent = '已授权文件夹：' + (name || '（未命名）')
            + ' —— AI 可以读写这个文件夹里的文件。';
        el.style.color = '#059669';
    } else {
        el.textContent = '还没有授权额外文件夹。AI 只能在 Agent 工作区里读写文件。';
        el.style.color = '#818cf8';
    }
}

/**
 * 扩展页的子分栏切换（插件 / 技能 / MCP）。
 *
 * 为什么不复用 switchSettingsTab：那个函数切换的是**主分栏**（外观/角色/模型…），
 *   它按 .settings-tab-panel 的 id 做事，还会去滚动左侧导航。子分栏是这一页内部的
 *   三个面板，用另一套选择器（.ext-panel / data-ext-tab），互不干扰 ——
 *   混用会让"点插件子栏"顺带把主分栏切走。
 */
/**
 * 保证「扩展」面板里**恰好有一个**子面板可见。
 *
 * 为什么需要：子面板的显隐靠 .active-panel，而 HTML 里只有一个（ext-mod）带这个类。
 *   如果某条路径把三个类都弄丢了（或插件/主题脚本重写了 innerHTML），
 *   用户会看到"扩展页整页空白"——而所有元素其实都在，只是都 display:none。
 *   这条兜底每次进入扩展页时跑一次，代价只有三次 classList 查询。
 */
function ensureExtTab() {
    const panels = [...document.querySelectorAll('#tab-mods .ext-panel')];
    if (!panels.length) return;
    if (panels.some((p) => p.classList.contains('active-panel'))) return;
    const want = (typeof state !== 'undefined' && state._extTab) || 'ext-mod';
    const target = panels.find((p) => p.id === want) || panels[0];
    // 走 switchExtTab 而不是自己补类：它同时管导航按钮的选中态、state._extTab，
    //   还负责把多余的 .active-panel 清掉（面板「恰好一个可见」是它的不变量）。
    switchExtTab(target.id, { noScroll: true });
}

/**
 * 切换扩展页的三个子面板（插件 / 技能 / MCP）。
 *
 * 两处控件会调用它，必须**同步状态**，否则会出现"导航显示插件、面板却是技能"：
 *   · 宽屏：导航栏里 #settingsExtNav 的子项（缩进在「扩展」下面）
 *   · 窄屏：导航栏「扩展」弹出的下拉（.ext-nav-btn，同一组节点）
 *   · 程序化：点父项「扩展」时恢复上次那一栏
 */
function switchExtTab(name, opts = {}) {
    const target = String(name || 'ext-mod');

    // ① 导航栏子项（宽屏可见）
    document.querySelectorAll('.ext-nav-btn').forEach((b) => {
        const on = b.dataset.extTab === target;
        // 独立类名（.is-active）：.settings-tab-btn 的 active 会被主分栏切换清掉
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // ③ 面板
    document.querySelectorAll('#tab-mods .ext-panel').forEach((p) => {
        p.classList.toggle('active-panel', p.id === target);
    });

    // 记住用户停在哪一栏：下次从别的分栏点回「扩展」时回到这一栏，
    //   而不是每次都跳回「插件」（那不是"记住我的位置"，是每次重置）。
    if (typeof state !== 'undefined') state._extTab = target;

    // 切到 MCP 时顺手刷一次状态：用户点进来多半就是想看"连上了吗"。
    //   状态接口**不启动进程**，所以刷它没有代价。
    if (target === 'ext-mcp') void refreshMcpList();

    // 展开态：**只由这里**决定，不依赖 CSS 的 :has()。
    //   为什么要独占：:has() 判的是"父项有没有 active"，而 active 由事件委托在
    //   另一个监听器里改，两者顺序不稳定 —— 实测会出现"类已清掉但 :has() 仍命中"，
    //   于是第一次点击看起来没反应、第二次才展开。
    //   opts.forceOpen 用于"点父项进来"这条路径：此时 active 还没设上，
    //   但意图明确是展开。
    const groupEl = document.getElementById('settingsExtNav');
    const menuEl = document.querySelector('.ext-nav-children.ext-menu-floating');
    // 当前是否已展开：以菜单自身的 .is-open 为准（它是唯一真相来源）。
    const wasOpen = Boolean(menuEl && menuEl.classList.contains('is-open'));
    const open = opts.forceClose === true ? false : (opts.forceOpen === true ? true : wasOpen);

    if (open && !wasOpen) {
        // 展开：先摆好位置再上类，否则第一帧会闪到错误位置
        positionExtMenu();
        if (groupEl) groupEl.classList.add('is-open');
        if (menuEl) {
            menuEl.classList.remove('is-closing');
            menuEl.classList.add('is-open');
        }
    } else if (!open && wasOpen) {
        // 收起：先播反向动画，播完再真正隐藏。
        //   直接摘 .is-open 会让菜单瞬间消失，动画根本看不到。
        if (groupEl) groupEl.classList.remove('is-open');
        if (menuEl) {
            menuEl.classList.remove('is-open');
            menuEl.classList.add('is-closing');
            clearTimeout(menuEl._extCloseTimer);
            menuEl._extCloseTimer = setTimeout(() => {
                menuEl.classList.remove('is-closing');
            }, 420);   // 400ms 动画 + 20ms 余量
        }
    }
    positionExtMenu();
}

/**
 * 让导航栏里的「扩展」分组完整落在可视区。
 *
 * 只在宽屏竖排导航里有意义（窄屏子项收起、分组就是一个小按钮，本来就在视野里）。
 * 为什么不用 scrollIntoView：它按"最近边"滚动，父项在左侧之外时会把父项贴到
 *   左边缘 —— 看起来像被裁掉的字。这里显式给两边的余量。
 */
/**
 * 摆放手机下拉分栏的位置（宽屏不用它：那里子项直接缩进在导航里）。
 *
 * 用户要的效果：**下拉与下面的插件卡片平齐** —— 左边缘贴内容区左边，
 *   宽度也跟内容区一样。所以坐标取自 #settingsContent，而不是窄窄的图标按钮。
 *
 * 用 fixed：绝对定位会被三层祖先的 overflow 裁掉
 *   （#settingsTabNav 的 overflow-x:auto、#settingsPanel 的 overflow:hidden、
 *    .rd-page-overlay-open 的 overflow:hidden），而 #settingsPanel 的
 *   overflow:hidden 是圆角必需的、去不掉。fixed 以视口为参照，一次绕开全部。
 */
/**
 * 摆放手机下拉分栏的位置。
 *
 * 形态：三个子项**竖着排在「扩展」正下方**，每个与「扩展」按钮同宽同高 ——
 *   看起来就是「扩展」这一项展开成了三项，而不是浮在别处的菜单。
 *
 * 所以坐标与尺寸全部取自**父按钮本身**，不取自卡片或内容区。
 *   · left  = 父按钮左边缘
 *   · width = 父按钮宽度（父按钮在导航末尾，左边还有空间，不会顶到屏幕外）
 *   · top   = 导航栏下边缘（紧接导航，不留缝）
 *
 * 用 fixed：绝对定位会被祖先的 overflow 裁掉（#settingsTabNav 的 overflow-x:auto、
 *   #settingsPanel 的 overflow:hidden），而后者是圆角必需的、去不掉。
 */
/**
 * 手机窄屏下把子项的高度对齐到「扩展」按钮。
 *
 * 子项在**正常流**里（见 pages-luxe.css），位置由布局引擎负责，不需要算坐标 ——
 *   这也是它能跟着导航一起滚动的原因。
 * 唯一要同步的是**高度**：不同宽度下「扩展」按钮高度会变（30 / 32px），
 *   而子项高度写成固定值就会比父项高出一截，"同一个控件"的观感就断了。
 */
/**
 * 摆放手机窄屏的子项浮层（宽屏不用：那里子项直接缩进在导航里）。
 *
 * 子项被挂到 #settingsPanel 下（见 init.js），用 absolute 定位，
 *   参照物是弹窗本体 —— 所以坐标要换算成"相对弹窗"的值。
 *
 * 位置与尺寸全部取自「扩展」按钮本身：用户要的是"竖排在扩展下面、
 *   和扩展一样大小"，取卡片或内容区宽度都会让子项比父项宽出一大截。
 */
/**
 * 摆放手机窄屏的子项（宽屏不用：那里子项直接缩进在导航里）。
 *
 * 位置与尺寸全部取自「扩展」按钮本身 —— 分支要"从这一项长出来"，
 *   取卡片或内容区宽度都会让分支和按钮对不上。
 * 两个微调量来自 demo 里拖出来的值：
 *   · --off-x：竖线相对按钮左边缘的水平偏移（0px）
 *   · --off-y：竖线上端相对按钮底部的垂直偏移（6px，让线更明显地穿进按钮）
 */
const EXT_BRANCH_OFF_X = 0;
const EXT_BRANCH_OFF_Y = 6;

function positionExtMenu() {
    const group = document.getElementById('settingsExtNav');
    const parentBtn = group && group.querySelector('.settings-tab-btn');
    const panel = document.getElementById('settingsPanel');
    if (!group || !parentBtn || !panel) return;

    // 子项可能已被挂到 panel 下，也可能还在原位（挂载失败时的兜底）
    const menu = document.querySelector('.ext-nav-children.ext-menu-floating')
        || group.querySelector('.ext-nav-children');
    if (!menu) return;

    const pr = parentBtn.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    // 相对弹窗的坐标：absolute 的包含块是 panel（它有 position: relative）
    const left = Math.round(pr.left - panelRect.left) + EXT_BRANCH_OFF_X;
    const top = Math.round(pr.bottom - panelRect.top) + EXT_BRANCH_OFF_Y;

    for (const el of [group, menu]) {
        el.style.setProperty('--ext-menu-left', left + 'px');
        el.style.setProperty('--ext-menu-top', top + 'px');
        el.style.setProperty('--ext-menu-width', Math.round(pr.width) + 'px');
        el.style.setProperty('--ext-menu-item-h', Math.round(pr.height) + 'px');
    }
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

/**
 * 分组版拖拽：统一列表模型 —— 平铺插件与分栏同等级，混排。
 *
 *   手势（全部复用内核，同一手感）：
 *     ① 卡片把手拖动：松手时指针落在分栏上 → 归入；落在顶层 → 拿出来
 *     ② 分栏把手拖动：调分栏在顶层混排里的位置
 *     顺序按松手时 DOM 的真实次序重建（所见即所得）。
 */
function bindGroupDragSort(box, onDone, hooks) {
    const { readGroups, saveGroups } = hooks || {};
    if (typeof window.__elainaBindFlatDragSort !== 'function') {
        console.warn('[Mods] 拖拽内核未加载，分栏拖拽不可用');
        return;
    }
    const TOP_KEY = 'elaina_mods_top_order';
    const GROUP_OF_KEY = 'elaina_mods_group_of';

    /** 保存顶层混排顺序（DOM 里卡片与分栏的真实次序，所见即所得） */
    function saveTopOrder() {
        const seq = [...box.children].map((el) => {
            if (el.classList.contains('mod-group')) {
                return { t: 'group', id: el.getAttribute('data-group-id') };
            }
            if (el.classList.contains('mod-card')) {
                return { t: 'mod', id: el.getAttribute('data-mod-id') };
            }
            return null;
        }).filter(Boolean);
        try {
            Store.setItem(TOP_KEY, JSON.stringify(seq));
            if (Store && typeof Store._flush === 'function') Store._flush();
        } catch (e) { /* 忽略 */ }
    }

    /** 保存栏内插件顺序 */
    function saveModOrder() {
        try {
            Store.setItem('elaina_mods_order',
                JSON.stringify([...box.querySelectorAll('.mod-card')].map((c) => c.getAttribute('data-mod-id'))));
            if (Store && typeof Store._flush === 'function') Store._flush();
        } catch (e) { /* 忽略 */ }
    }

    // 拖拽高亮（拖着卡片悬在分栏上时提示"松手放进这里"）
    let hoverTarget = null;
    function clearHover() {
        if (hoverTarget) { hoverTarget.classList.remove('mod-group-hover'); hoverTarget = null; }
    }
    document.addEventListener('pointermove', (e) => {
        if (!document.body.classList.contains('mod-dragging-active')) { clearHover(); return; }
        if (!document.querySelector('.mod-card.mod-dragging')) { clearHover(); return; }
        const zone = (e.target && e.target.closest && e.target.closest('.mod-group'))
            || document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.mod-group');
        const head = zone ? zone.querySelector('.mod-group-head') : null;
        if (!head) { clearHover(); return; }
        if (hoverTarget === head) return;
        clearHover();
        hoverTarget = head;
        head.classList.add('mod-group-hover');
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearHover(); }, true);

    // ① 卡片拖动（内核）：栏内排序 + 松手按落点归类/拿出来
    window.__elainaBindFlatDragSort(
        box,
        () => {
            saveModOrder();
            saveTopOrder();
            if (typeof onDone === 'function') onDone();
        },
        {
            itemSelector: '.mod-card',
            handleSelector: '.mod-grip',
            placeholderClass: 'mod-placeholder',
            draggingClass: 'mod-dragging',
            // 逃逸容器：卡片拖出分栏体后落到顶层列表 —— "放进去的拿不出来"的解法
            outerContainer: box,
        }
    );

    // ② 卡片松手在分栏上 → 归入；松手在顶层 → 拿出来（松手那一刻决定）
    document.addEventListener('pointerup', (e) => {
        const card = document.querySelector('.mod-card.mod-dragging');
        if (!card) { clearHover(); return; }
        const modId = card.getAttribute('data-mod-id');
        const zone = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.mod-group');
        const head = zone ? zone.querySelector('.mod-group-head') : null;
        try {
            const map = JSON.parse(Store.getItem(GROUP_OF_KEY) || '{}');
            const curGroup = map[modId] || null;
            const newGroup = head ? head.getAttribute('data-group-id') : null;
            // 归属没变（还在原分栏松手 / 还在顶层松手）→ 不动，让内核走自己的栏内排序
            if ((newGroup || null) === curGroup) { clearHover(); return; }
            if (newGroup) map[modId] = newGroup;
            else delete map[modId];
            Store.setItem(GROUP_OF_KEY, JSON.stringify(map));
            if (Store && typeof Store._flush === 'function') Store._flush();
            clearHover();

            // 就地搬家 + FLIP（不整页重渲染）：重渲染会打断内核的飞行动画 ——
            //   卡片瞬移进/出分栏，观感"没有动画"。
            //   做法：记卡片当前屏幕位置 → 移到目标容器（分栏体开头 / 顶层占位处）→
            //   从旧位置演到新位置。
            const oldRect = card.getBoundingClientRect();
            // 先让内核把卡片从"拖拽态"还原（它会把卡片放回拖前的容器）——
            // 通过触发它的 pointercancel 路径，我们随后再把卡片挪到正确的新家
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            // Escape 还原是同步的：现在卡片已回到拖拽前的位置
            const body2 = newGroup
                ? document.querySelector('.mod-group[data-group-id="' + newGroup + '"] .mod-group-body')
                : document.getElementById('modsList');
            if (!body2) { if (typeof onDone === 'function') onDone(); return; }
            // 新家开头插入
            const anchor = body2.querySelector('.mod-card');
            if (anchor && anchor !== card) body2.insertBefore(card, anchor);
            else body2.appendChild(card);
            // 顶层归属时保持 top_order 一致（插到当前指针位置附近 —— 简化为开头）
            // FLIP：从旧屏幕位置演到新位置
            const nowRect = card.getBoundingClientRect();
            const dy = oldRect.top - nowRect.top;
            const dx = oldRect.left - nowRect.left;
            if (dy || dx) {
                card.style.transition = 'none';
                card.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
                requestAnimationFrame(() => {
                    card.style.transition = 'transform .25s cubic-bezier(.2,.8,.3,1)';
                    card.style.transform = '';
                    // 动画结束后摘掉内联 transition，别让它盖住卡片自己的 hover 过渡。
                    setTimeout(() => { card.style.transition = ''; }, 300);
                });
            }
            // 更新计数徽标（就地改，避免重渲染打断上面的动画）
            const groupEl2 = body2.closest('.mod-group');
            if (groupEl2) {
                const cnt = groupEl2.querySelector('.mod-group-head > span:nth-last-child(2)')
                    || groupEl2.querySelector('.mod-group-head span.text-\\[10px\\]');
                if (cnt) cnt.textContent = String(body2.querySelectorAll('.mod-card').length);
            }
            // 故意**不调 onDone**：它会 refreshModsList 整页重建，把刚播的
            //   FLIP 动画打断（"放进去没动画"的成因）。归属/顺序已各自入 Store。
        } catch (err) { /* 忽略 */ }
    }, true);

    // ③ 分栏拖动（内核）：与卡片同一套手感
    window.__elainaBindFlatDragSort(
        box,
        () => {
            saveTopOrder();
            if (typeof onDone === 'function') onDone();
        },
        {
            itemSelector: '.mod-group',
            handleSelector: '.mod-group-grip',
            idAttr: 'data-group-id',
            placeholderClass: 'mod-placeholder',
            draggingClass: 'mod-dragging',
            // 顶层混排：分栏与平铺卡片同等级，插入点候选包含两类项 ——
            //   分栏因此可以拖到任何卡片之间（用户要求；之前候选只有分栏，
            //   分栏永远拖不到卡片上面）。
            topLevelMixed: true,
            outerItemSelector: '.mod-card, .mod-group',
            outerContainer: box,
            canStart(ev) {
                return !ev.target.closest('.mod-act') && !ev.target.closest('.mod-group-toggle');
            },
        }
    );

    // ── 折叠：就地切类，不整页重渲染（CSS grid-rows 过渡才能播完） ──
    box.querySelectorAll('.mod-group-head').forEach((head) => {
        head.addEventListener('click', (ev) => {
            if (ev.target.closest('.mod-group-grip')) return;
            if (ev.target.closest('.mod-act')) return;
            if (ev.target.closest('.mod-group-toggle')) return;
            toggleGroupCollapse(head.getAttribute('data-group-id'));
        });
    });
    box.querySelectorAll('.mod-group-toggle').forEach((el) => {
        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            toggleGroupCollapse(el.getAttribute('data-group-id'));
        });
    });

    function toggleGroupCollapse(gid) {
        const gs = readGroups();
        const g = gs.find((x) => x.id === gid);
        if (!g) return;
        g.collapsed = !(g.collapsed === true);
        saveGroups(gs);
        const groupEl = box.querySelector('.mod-group[data-group-id="' + gid + '"]');
        if (!groupEl) { void refreshModsList(); return; }
        groupEl.classList.toggle('mod-group-collapsed', g.collapsed);
        groupEl.querySelector('.mod-group-body')?.classList.toggle('is-collapsed', g.collapsed);
        groupEl.querySelector('.mod-group-toggle')?.setAttribute('title',
            g.collapsed ? '展开' : '收纳');
    }
}

