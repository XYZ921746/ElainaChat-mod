/* ========================================================================
 * 设置与运维：状态机 / 设置 / 悬浮窗 / 副屏监视 / 日志 / 数据 / 密码
 *
 * 本文件由 web/index.html 的主脚本按分区拆分而来（保持原始加载顺序）。
 * 拆分前提：主脚本是全局作用域，拆分后各文件共享同一全局词法环境，
 * 因此顶层 function / const / let 互相可见，调用点无需修改。
 *
 * 包含分区：
 *   · 状态机 UI
 *   · 设置
 *   · 操作悬浮窗（APK 独有）
 *   · 副屏监视窗
 *   · 日志设置（服务端）
 *   · 我的数据（导出 / 导入 / 位置）
 *   · 访问密码（局域网鉴权）
 *   · 问候打字机
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
    elements.settingTtsProvider.value = state.settings.ttsProvider || 'edge';
    document.getElementById('settingMinimaxApiKey').value = state.settings.minimaxApiKey || '';
    document.getElementById('settingMinimaxVoice').value = state.settings.minimaxVoice || '';
    document.getElementById('settingMinimaxModel').value = state.settings.minimaxModel || 'speech-2.8-hd';
    document.getElementById('settingDoubaoApiKey').value = state.settings.doubaoApiKey || '';
    document.getElementById('settingDoubaoAppId').value = state.settings.doubaoAppId || '';
    document.getElementById('settingDoubaoToken').value = state.settings.doubaoToken || '';
    document.getElementById('settingDoubaoCluster').value = state.settings.doubaoCluster || 'volcano_tts';
    document.getElementById('settingDoubaoVoice').value = state.settings.doubaoVoice || 'zh_female_shuangkuaisisi_uranus_bigtts';
    document.getElementById('settingDoubaoResourceId').value = state.settings.doubaoResourceId || 'seed-tts-2.0';
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
    document.getElementById('settingDashscopeAsrBaseUrl').value = state.settings.dashscopeAsrBaseUrl || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
    document.getElementById('settingDashscopeAsrModel').value = state.settings.dashscopeAsrModel || 'qwen3-asr-flash';
    document.getElementById('settingMimoApiKey').value = state.settings.mimoApiKey || '';
    document.getElementById('settingMimoBaseUrl').value = state.settings.mimoBaseUrl || 'https://api.xiaomimimo.com';
    document.getElementById('settingMimoAsrModel').value = state.settings.mimoAsrModel || 'mimo-v2.5-asr';
    elements.settingAutoMemory.checked = Boolean(state.settings.autoMemory);
    elements.settingMemoryEvery.value = state.settings.memoryEvery || 6;
    document.querySelectorAll('input[name="agentPermission"]').forEach(r => {
        r.checked = (r.value === (state.settings.agentPermission || 'app'));
    });
    document.querySelectorAll('input[name="agentApproval"]').forEach(r => {
        r.checked = (r.value === (state.settings.agentApproval || 'once'));
    });
    const phoneToggle = document.getElementById('settingAgentPhoneEnabled');
    if (phoneToggle) phoneToggle.checked = state.settings.agentPhoneEnabled !== false;
    syncAgentSectionsByDevice();

    renderCardSelect();
    fillCharacterCardForm();
    settingsContent.scrollTop = 0;
    renderScheduledTaskList();
    void refreshDataSettings();
    void refreshOverlayStatus();
    // 日志查看器：设置页打开时让它出现并开始首次全量拉取。
    // ★ 这一行不是死代码 —— 它是查看器的**显示入口**（删掉它查看器一行日志都
    //   渲染不出来，实测踩到：check-log-viewer 6 项失败、渲染 0 行）。
    //   之前引用的 logSettingsSection（日志设置块）已随那块 UI 删除，这里只留查看器本身。
    try { if (window.LogViewer) window.LogViewer.show(); }
    catch (e) { /* 查看器出问题不能影响设置页其它部分 */ }
}


// ==================== 操作悬浮窗（APK 独有） ====================
// AI 操作的是别的应用。没有悬浮窗时，每一步确认都要用户切回本应用来点，
// 而"切回来"会让被操作的应用退到后台，那一步操作就可能失败 → AI 重试 → 看起来像卡住。
// 悬浮窗是唯一能打破这个循环的东西：它浮在目标应用之上，不离开当前界面就能确认或停止。
//
// 注意这是 Android 的**特殊权限**（「显示在其他应用上层」），只能由用户
// 在系统设置里手动打开 —— 应用无法弹运行时权限框索取。所以这里只能"跳过去 + 回来复检"。
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


// ==================== 副屏监视窗 ====================
//
// AI 用「模块」后端操作手机时，它在**独立虚拟副屏**上跑，物理主屏看不到。
// 这个窗口把副屏画面搬进应用，让用户知道 AI 正在点什么、界面变成了什么样。
//
// 不做成 iframe 套模块的 3070 网页面板：那等于把浏览器塞进应用，风格割裂、
// 还有滚动/缩放两套坐标系。这里只从模块取「画面 + 状态」，UI 完全是我们自己的。
const SCREEN_WATCH_INTERVAL = 1500;   // 自动刷新间隔（模块出帧约 18ms，1.5s 足够跟手）
let screenWatchTimer = null;
let screenWatchAuto = true;
let screenWatchBusy = false;
let screenWatchLogs = [];

function screenWatchEl(id) { return document.getElementById(id); }

// setStep 在 agentRuntime 的 IIFE 里够不到这个函数，挂到 window 供它回调
window.__screenWatchNote = (text) => screenWatchNote(text);

/** 记录一条"AI 最近动作"，显示在监视窗里 */
function screenWatchNote(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    screenWatchLogs.push(stamp + '  ' + t);
    if (screenWatchLogs.length > 40) screenWatchLogs = screenWatchLogs.slice(-40);
    const box = screenWatchEl('screenWatchLog');
    if (box) {
        box.innerHTML = screenWatchLogs.slice(-12).map((line) =>
            '<div>' + line.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>').join('');
        box.scrollTop = box.scrollHeight;
    }
}

/** 拉一帧副屏画面 + 状态 */
async function screenWatchRefresh() {
    if (screenWatchBusy) return;
    const plugin = deviceBridge();
    const img = screenWatchEl('screenWatchImg');
    const empty = screenWatchEl('screenWatchEmpty');
    const meta = screenWatchEl('screenWatchMeta');
    const dot = screenWatchEl('screenWatchDot');
    const powerBtn = screenWatchEl('screenWatchPowerBtn');
    if (!plugin || typeof plugin.liveFrame !== 'function') {
        if (meta) meta.textContent = '电脑版没有副屏';
        return;
    }
    screenWatchBusy = true;
    try {
        const res = await plugin.liveFrame();
        if (!res || !res.ok) {
            // 明确区分"没有画面"和"模块不可用" —— 前者要引导启动副屏，后者要引导刷模块
            if (res && res.reason === 'no-frame') {
                if (meta) meta.textContent = '副屏无画面';
                if (dot) dot.style.background = '#fbbf24';
                if (empty) empty.classList.remove('hidden');
                if (img) img.classList.add('hidden');
                const hint = screenWatchEl('screenWatchEmptyHint');
                if (hint) hint.textContent = '副屏是空的（只有壁纸）。让 AI 先执行一次「手机打开 某应用」。';
            } else {
                if (meta) meta.textContent = '模块不可用';
                if (dot) dot.style.background = '#f87171';
                if (empty) empty.classList.remove('hidden');
                if (img) img.classList.add('hidden');
                const hint = screenWatchEl('screenWatchEmptyHint');
                if (hint) hint.textContent = String(res && res.text || '没刷 KernelSU 模块，或 vd_server 没在跑。');
            }
            if (powerBtn) powerBtn.textContent = '启动副屏';
            return;
        }
        if (img && res.imageBase64) {
            img.src = 'data:' + (res.mime || 'image/jpeg') + ';base64,' + res.imageBase64;
            img.classList.remove('hidden');
            if (empty) empty.classList.add('hidden');
            // 模块的截图优先返回**缓存的帧**（换速度），刚启动应用时可能还是旧的黑帧。
            // 判断依据：JPEG 极小时基本就是纯色（黑屏副屏约 9KB，有内容时几十~几百KB）。
            // 这里不弹提示打断，只把状态文字改掉，1.5s 后的自动刷新通常会追上新画面。
            const tiny = (res.bytes || 0) < 20000;
            if (tiny && meta && String(res.status || '') === 'running') {
                meta.textContent = '运行中 · Display ' + res.displayId + ' · 画面更新中…';
            }
        }
        const running = String(res.status || '') === 'running';
        if (dot) dot.style.background = running ? '#34d399' : '#fbbf24';
        if (meta) {
            meta.textContent = running
                ? ('运行中 · Display ' + res.displayId + ' · ' + res.width + '×' + res.height)
                : '已休眠';
        }
        if (powerBtn) powerBtn.textContent = running ? '关闭副屏' : '启动副屏';
    } catch (e) {
        if (meta) meta.textContent = '读取失败';
    } finally {
        screenWatchBusy = false;
    }
}

function screenWatchStartAuto() {
    screenWatchStopAuto();
    if (!screenWatchAuto) return;
    screenWatchTimer = setInterval(() => { void screenWatchRefresh(); }, SCREEN_WATCH_INTERVAL);
}
function screenWatchStopAuto() {
    if (screenWatchTimer) { clearInterval(screenWatchTimer); screenWatchTimer = null; }
}

function openScreenWatch() {
    const panel = screenWatchEl('screenWatchPanel');
    if (!panel) return;
    // 监视窗与设置面板同为 100002 层（见 CSS 里的分层说明）。两者若同时开着，
    // 谁在上面就由 DOM 顺序决定 —— 那正是注释里说要避免的事。
    // 所以打开监视窗前先把设置关掉（注释声称如此，实现以前漏了这一步）。
    if (typeof closeSettingsPanel === 'function') closeSettingsPanel();
    panel.classList.remove('hidden');
    panel.classList.add('flex');
    void screenWatchRefresh();
    screenWatchStartAuto();
}
function closeScreenWatch() {
    const panel = screenWatchEl('screenWatchPanel');
    if (panel) { panel.classList.add('hidden'); panel.classList.remove('flex'); }
    screenWatchStopAuto();
}




// ==================== 我的数据（导出 / 导入 / 位置） ====================
// 后端把数据分类落在 data/ 下（人设卡一卡一文件、聊天记录、记忆各自独立）。
// 这里只负责"让用户能看见、能备份、能恢复" —— 换机器和升级前的那道保险。
//
// 两种运行环境，两条路径：
//   Web：数据在服务端 data/ 下 → 走 /api/data/*
//   APK：没有本地服务 → 走 web/js/chat-backup.js，直接读写 localStorage
//
// **APK 侧以前是整块隐藏的**，但那恰恰是最需要备份的地方 ——
// 数据存在应用私有目录，卸载即丢，用户连手动拷出来都做不到。
// 现在两边都提供导入导出，而且备份格式同构，可以互相导入。
async function refreshDataSettings() {
    const box = document.getElementById('dataStatusBox');
    const section = document.getElementById('dataSettingsSection');
    if (!box) return;

    // ---- APK：本地统计，不发请求 ----
    if (IS_NATIVE_APP && window.ChatBackup) {
        try {
            let cards = 0;
            let convs = 0;
            let mem = 0;
            try { cards = JSON.parse(Store.getItem('elaina_open_character_cards') || '[]').length; } catch { /* 忽略 */ }
            try { convs = JSON.parse(Store.getItem('elaina_open_conversations') || '[]').length; } catch { /* 忽略 */ }
            try { mem = (JSON.parse(Store.getItem('elaina_open_memory_core') || '{}').diary || []).length; } catch { /* 忽略 */ }
            box.innerHTML = '数据位置：<code class="text-indigo-500">应用私有目录</code>'
                + '<span class="text-indigo-300">（安卓应用数据，卸载会一并删除）</span><br>'
                + '人设卡 <b>' + escapeHtml(String(cards)) + '</b> 张'
                + ' · 对话 <b>' + escapeHtml(String(convs)) + '</b> 个'
                + ' · 记忆 <b>' + escapeHtml(String(mem)) + '</b> 条';
        } catch (e) {
            box.textContent = '无法读取本地数据统计';
        }
        return;
    }

    // ---- Web：走后端 ----
    try {
        const res = await fetch('/api/data/info');
        if (!res.ok) { if (section) section.classList.add('hidden'); return; }
        const json = await res.json();
        if (!json.ok) { if (section) section.classList.add('hidden'); return; }
        const c = json.counts || {};
        box.innerHTML = '数据位置：<code class="text-indigo-500">' + escapeHtml(json.dir || 'data')
            + '</code><br>'
            + '人设卡 <b>' + escapeHtml(String(c.characters || 0)) + '</b> 张'
            + ' · 对话 <b>' + escapeHtml(String(c.conversations || 0)) + '</b> 个'
            + ' · 记忆 <b>' + escapeHtml(String(c.memoryEntries || 0)) + '</b> 条';
    } catch (e) {
        if (section) section.classList.add('hidden');
    }
}

function setDataHint(text, isError) {
    const hint = document.getElementById('dataActionHint');
    if (!hint) return;
    hint.textContent = text || '';
    hint.className = isError ? 'text-[11px] text-red-500' : 'text-[11px] text-indigo-300';
}

async function exportDataBackup() {
    setDataHint('导出中…');

    // ---- APK：本地生成 zip 并**写进应用文档目录**（没有后端可用）----
    //
    // 为什么不用 <a download> + blob URL：**安卓 WebView 不处理 blob: 下载**。
    // 桌面浏览器会把 blob 交给下载器，WebView 里点下去通常毫无反应
    //（这也是 Capacitor 社区反复提到的一点）。所以 APK 侧走 Capacitor Filesystem，
    // 把备份真正写到磁盘上，再把路径告诉用户。
    if (IS_NATIVE_APP && window.ChatBackup) {
        try {
            const fs = nativeFs();
            if (!fs) { setDataHint('导出失败：文件系统插件不可用', true); return; }
            const blob = await window.ChatBackup.buildBackupBlob();
            if (!blob.size) { setDataHint('导出失败：本地数据为空', true); return; }
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const t = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            const fileName = 'elainachat-backup-' + t + '.zip';
            // Documents 目录：用户能用系统文件管理器找到（比 Data 私有目录友好）
            const dir = (fs.Directory && fs.Directory.Documents) ? fs.Directory.Documents : 'DOCUMENTS';
            await nativeWriteFile(fileName, dir, bytes);
            // 同时取一个 WebView 能访问的 URL，方便用户直接点开/分享
            let where = '文档目录';
            try {
                const uri = await fs.getUri({ path: fileName, directory: dir });
                if (uri && uri.uri) where = uri.uri;
            } catch { /* 拿不到就只报目录名 */ }
            setDataHint('已导出：' + fileName + '（' + Math.round(bytes.length / 1024) + ' KB）');
            showCustomAlert(
                '备份已保存到手机的**文档目录**：\n\n' + fileName
                + '\n\n大小 ' + Math.round(bytes.length / 1024) + ' KB。'
                + '\n\n用系统「文件管理」进 文档 / Documents 就能看到它。'
                + '传到电脑后，在网页版的「我的数据 → 导入备份」里可以直接还原。',
                '导出完成');
        } catch (e) {
            setDataHint('导出失败：' + (e.message || e), true);
        }
        return;
    }

    // ---- Web：走后端 ----
    try {
        const res = await fetch('/api/data/export');
        if (!res.ok) { setDataHint('导出失败（HTTP ' + res.status + '）', true); return; }
        const blob = await res.blob();
        // 空响应要明确报错，而不是静默存下一个 0 字节文件。
        // 什么时候会空：装了迅雷/FDM 之类下载器的浏览器，其扩展会拦走带
        // attachment 的响应（后端已刻意不发那个头，但旧版服务或别的中间层
        // 仍可能造成空响应）。这种情况用户拿到的文件是坏的，必须说出来。
        if (!blob.size) {
            setDataHint('导出失败：服务端返回了空内容。若装了迅雷/FDM，请先关掉它的浏览器扩展再试。', true);
            return;
        }
        // 文件名走自定义头（后端不再发 Content-Disposition，避免被下载器识别成下载）
        let name = res.headers.get('X-Backup-Filename') || '';
        if (!name) {
            const cd = res.headers.get('Content-Disposition') || '';
            const m = cd.match(/filename="?([^";]+)"?/);
            if (m && m[1]) name = m[1];
        }
        if (!name) {
            const t = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            name = 'elainachat-backup-' + t + '.zip';
        }
        // blob: 是内存地址，外部下载器接管不了，也不会弹它的窗口
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setDataHint('已导出：' + name + '（' + Math.round(blob.size / 1024) + ' KB）');
    } catch (e) {
        setDataHint('导出失败：' + (e.message || e), true);
    }
}

/**
 * APK 侧导入入口：先看文档目录里有没有导出过的备份，有就让用户选；
 * 一个都没有（或插件不可用）时退回系统文件选择器。
 *
 * 为什么要有这条路径：安卓 WebView 的 <input type="file"> 行为在各厂商 ROM 上
 * 差异很大（有的能选、有的只能选图片）。而"自己导出的备份就在文档目录里"是
 * **最常见的使用场景**（导完想恢复），走 Filesystem 读取最可靠。
 */
async function importFromDocumentsOrPicker() {
    const fs = nativeFs();
    let names = [];
    try {
        const dir = (fs.Directory && fs.Directory.Documents) ? fs.Directory.Documents : 'DOCUMENTS';
        const res = await fs.readdir({ path: '', directory: dir });
        names = (res && res.files ? res.files : [])
            .filter((f) => /^elainachat-backup-.*\.(zip|json)$/i.test(f.name))
            .map((f) => f.name)
            .sort()
            .reverse();   // 最新的排前面
    } catch { /* 目录读不到就当没有 */ }

    if (!names.length) {
        // 没有备份 → 交给系统文件选择器（用户可能从微信/下载目录里选了传进来的）
        document.getElementById('dataImportFile')?.click();
        return;
    }

    const picked = await showCustomModal({
        title: '从手机里选择备份',
        message: '文档目录里找到 ' + names.length + ' 个备份（最新的在最前）：\n\n'
            + names.slice(0, 8).map((n, i) => (i + 1) + '. ' + n).join('\n')
            + (names.length > 8 ? '\n…还有 ' + (names.length - 8) + ' 个' : '')
            + '\n\n输入序号导入；留空则改用系统文件选择器。',
        input: true,
        defaultValue: '1',
        placeholder: '序号，如 1',
    });
    if (picked === null || picked === undefined || String(picked).trim() === '') {
        document.getElementById('dataImportFile')?.click();
        return;
    }
    const idx = Number(String(picked).trim()) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= names.length) {
        setDataHint('序号无效', true);
        return;
    }
    const fileName = names[idx];
    try {
        const dir = (fs.Directory && fs.Directory.Documents) ? fs.Directory.Documents : 'DOCUMENTS';
        const read = await fs.readFile({ path: fileName, directory: dir });
        // Capacitor 返回 base64（v7 起固定返回 data 字段）
        const b64 = String(read && read.data ? read.data : '');
        if (!b64) { setDataHint('读不到文件内容', true); return; }
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], fileName, { type: 'application/zip' });
        await importDataBackup(file);
    } catch (e) {
        setDataHint('读取备份失败：' + (e.message || e), true);
    }
}

async function importDataBackup(file) {
    if (!file) return;
    // 合并模式：只覆盖备份里有的数据，本机其它数据不动 —— 比"替换"安全得多，
    // 所以默认用它，且不做二次确认之外的额外询问。
    const okToGo = await showCustomConfirm(
        '导入备份会覆盖同名的数据（聊天记录 / 人设卡 / 记忆 / 设置），本机其它数据保留。\n\n'
        + '继续导入吗？', '导入备份');
    if (!okToGo) { setDataHint('已取消'); return; }
    setDataHint('导入中…');

    // ---- APK：本地写回 localStorage（没有后端可用）----
    if (IS_NATIVE_APP && window.ChatBackup) {
        try {
            const r = await window.ChatBackup.applyBackup(file);
            setDataHint('已导入 ' + r.keys + ' 项数据（' + (r.source === 'zip' ? 'zip' : '旧版 JSON') + '）');
            await refreshDataSettings();
            showCustomAlert('已导入 ' + r.keys + ' 项数据。\n\n刷新页面后即可看到导入的聊天记录与人设卡。', '导入完成');
        } catch (e) {
            setDataHint('导入失败：' + (e.message || e), true);
        }
        return;
    }

    // ---- Web：交给后端 ----
    try {
        // 直接把文件原样发上去：备份是 zip（二进制），不能走 JSON 包装。
        // 后端两种都认（zip 与 v1 的单 JSON 旧备份），所以这里不用判断类型。
        const res = await fetch('/api/data/import?mode=merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file
        });
        const json = await res.json().catch(() => ({ ok: false, message: '服务端返回了非 JSON 内容（HTTP ' + res.status + '）' }));
        if (!json.ok) { setDataHint(json.message || '导入失败', true); return; }
        setDataHint(json.message || '导入完成');
        await refreshDataSettings();
        showCustomAlert((json.message || '导入完成') + '。\n\n刷新页面后即可看到导入的聊天记录与人设卡。', '导入完成');
    } catch (e) {
        setDataHint('导入失败：' + (e.message || e), true);
    }
}


// ==================== 访问密码（局域网鉴权） ====================
// 本机（127.0.0.1）自动是管理员：免密、且可修改访问密码（也是忘记密码的找回入口）。
async function refreshAuthStatus() {
    const box = document.getElementById('authStatusBox');
    if (!box) return;
    try {
        const res = await fetch('/api/auth/status');
        if (!res.ok) { box.textContent = '无法获取鉴权状态（HTTP ' + res.status + '）'; return; }
        const json = await res.json();
        if (!json.ok) { box.textContent = '无法获取鉴权状态'; return; }
        if (json.isAdmin) {
            box.innerHTML = json.isDefaultPassword
                ? '当前是本机管理员（免密）。访问密码仍是初始随机密码：<code class="text-indigo-500">' + escapeHtml(json.passwordHint || '') + '</code>，建议改成自己的。'
                : '当前是本机管理员（免密）。访问密码已由你自行设置，控制台不再显示。';
        } else {
            box.textContent = '当前设备已登录（非本机）。如需修改访问密码，请在这台电脑上打开本应用操作。';
        }
    } catch (e) {
        // 安卓 App（Capacitor 本地文件）没有本地服务，此功能不适用
        box.textContent = '当前环境没有本地服务（如安卓 App），访问密码功能不适用。';
    }
}

async function changeAccessPassword() {
    const a = document.getElementById('authNewPwd');
    const b = document.getElementById('authNewPwd2');
    const next = (a && a.value ? a.value : '').trim();
    const again = (b && b.value ? b.value : '').trim();
    if (next.length < 6) { showCustomAlert('新密码至少 6 位。', '访问密码'); return; }
    if (next !== again) { showCustomAlert('两次输入的密码不一致，请重新输入。', '访问密码'); return; }
    try {
        const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ next })
        });
        const json = await res.json();
        if (!json.ok) { showCustomAlert(json.message || '修改失败', '访问密码'); return; }
        if (a) a.value = '';
        if (b) b.value = '';
        await refreshAuthStatus();
        showCustomAlert('访问密码已更新。\n\n· 手机/平板等局域网设备需要重新输入新密码\n· 本机仍然免密\n· 服务端控制台不再显示密码，请记牢', '访问密码');
    } catch (e) {
        showCustomAlert('修改失败：' + (e.message || e), '访问密码');
    }
}

async function logoutAccess() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) { /* 忽略：无论成功与否都跳登录页 */ }
    location.href = '/login';
}

// 「电脑操作权限」与「手机操作」两组设置按设备形态只显示一组：
// 电脑上给「允许操作电脑」，手机上给「手机操作」—— 混在一起用户看不懂。
// 用 IS_MOBILE_DEVICE（设备本身）而不是窗口宽度，电脑上把窗口拖窄不该变成"手机"。
function syncAgentSectionsByDevice() {
    const pcSection = document.getElementById('agentPermissionSection');
    const phoneSection = document.getElementById('agentPhoneSection');
    if (pcSection) pcSection.classList.toggle('hidden', IS_MOBILE_DEVICE);
    if (phoneSection) phoneSection.classList.toggle('hidden', !IS_MOBILE_DEVICE);
}

function openSettings() {
    fillSettingsForm();
    void refreshAuthStatus();
    // 每次打开设置都刷新插件列表：用户可能在服务运行期间往 web/mods/ 丢了新 zip，
    // 刷新一次就能看到（而不是要求他重启服务）
    void refreshModsList();
    // 外观主题：同步选择器状态（模板卡片 + 深色三态）
    if (window.ElainaTheme) {
        window.ElainaTheme.renderPicker();
        window.ElainaTheme.markPicker();
        const darkSel = document.getElementById('themeDarkMode');
        if (darkSel) darkSel.value = window.ElainaTheme.darkMode();
        // 让 theme.js 重新落一次 DOM —— 顺带刷新"跟随系统：当前为深色/浅色"的提示
        window.ElainaTheme.setDarkMode(window.ElainaTheme.darkMode());
    }
    elements.settingsOverlay.classList.remove('hidden');
    elements.settingsOverlay.classList.add('flex');
    setRailActive('settings');
}

// ==================== 插件（mod）设置栏 ====================

/**
 * 渲染「设置 → 插件」列表。
 *
 * 数据来源两条路，缺一不可：
 *   ① 服务端 /api/plugins —— 会扫描 web/mods/ 并把新丢进去的 zip 解压安装，
 *      然后返回清单。这是"装了哪些 mod"的权威来源。
 *   ② 前端 window.ElainaMods.list() —— 加载器**实际加载**的结果（含每个 mod 的
 *      运行状态：ready / disabled / error）。
 *
 * 为什么要合并两者：服务端知道"磁盘上有什么"，前端知道"跑起来没有"。
 * 只看服务端会把加载失败的 mod 显示成正常；只看前端则看不到"刚丢进去还没加载"的 mod。
 * 另外 APK 端没有服务端，此时只能靠前端那份（构建时打包进去的 mod）。
 */
async function refreshModsList() {
    const box = document.getElementById('modsList');
    if (!box) return;
    const hint = document.getElementById('modsHint');

    let fromServer = [];
    try {
        const res = await fetch('/api/plugins', { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            fromServer = Array.isArray(data && data.plugins) ? data.plugins : [];
            // 安装失败的 zip 要让用户看见原因，否则"我放进去了但没反应"无从排查
            const bad = (data && data.installResults || []).filter((r) => !r.ok);
            if (hint && bad.length) {
                hint.textContent = '有 ' + bad.length + ' 个 zip 安装失败：' + bad.map((b) => b.zip + '（' + b.error + '）').join('；');
                hint.className = 'text-[11px] text-red-500';
            }
        }
    } catch (e) { /* APK 端没有这个接口，走前端那份 */ }

    const fromLoader = (window.ElainaMods && typeof window.ElainaMods.list === 'function')
        ? window.ElainaMods.list() : [];

    // 以服务端清单为准，用加载器状态补充
    const stateOf = new Map(fromLoader.map((m) => [m.id, m]));
    const merged = fromServer.map((m) => Object.assign({}, m, stateOf.get(m.id) || {}, { _fromServer: true }));
    // 服务端没有但加载器有的（APK 端 / 手工放目录）也要显示
    for (const m of fromLoader) {
        if (!merged.some((x) => x.id === m.id)) merged.push(Object.assign({}, m, { _fromServer: false }));
    }

    // ==================== 分栏（分组）数据 ====================
    //
    // ★ 存储模型（跨设备同步；键都已在 store.js 的 DATA_KEYS 里）：
    //     elaina_mods_groups    = [{ id, name, collapsed, fixed? }]  分栏清单（有序）
    //     elaina_mods_group_of  = { <插件id>: <分栏id> }              插件 → 分栏 归属
    //     elaina_mods_order     = [插件id...]                          插件顺序（栏内/平铺共用）
    //     elaina_mods_top_order = [{t:'mod'|'group', id}...]           顶层混排顺序
    //   未分类不是一个"栏"：没归属的插件直接平铺在顶层（与旧版一致，用户要求）。
    const GROUPS_KEY = 'elaina_mods_groups';
    const GROUP_OF_KEY = 'elaina_mods_group_of';
    const UNGROUPED_ID = '__ungrouped__';
    const readGroups = () => {
        try {
            const v = JSON.parse(Store.getItem(GROUPS_KEY) || '[]');
            return Array.isArray(v) ? v.filter((g) => g && g.id && g.id !== UNGROUPED_ID) : [];
        } catch (e) { return []; }
    };
    const saveGroups = (gs) => {
        try {
            Store.setItem(GROUPS_KEY, JSON.stringify(gs));
            if (Store && typeof Store._flush === 'function') Store._flush();
        } catch (e) { /* 忽略 */ }
    };
    const groupOf = (() => {
        try { const v = JSON.parse(Store.getItem(GROUP_OF_KEY) || '{}'); return (v && typeof v === 'object') ? v : {}; }
        catch (e) { return {}; }
    })();

    // 旧版把顺序存进这些键；按用户存下的顺序排，没记过的保持清单原序
    const ORDER_KEY = 'elaina_mods_order';
    const readOrder = () => {
        try { const v = JSON.parse(Store.getItem(ORDER_KEY) || '[]'); return Array.isArray(v) ? v : []; }
        catch (e) { return []; }
    };

    const ICON = {
        grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
        doc: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/></svg>',
        // 齿轮：几何直齿画法（手写弧线命令极易写歪，实测一团毛刺）
        gear: '<svg fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.41 5.39L10.53 2.72L13.47 2.72L13.59 5.39L15.55 6.20L17.53 4.40L19.60 6.47L17.80 8.45L18.61 10.41L21.28 10.53L21.28 13.47L18.61 13.59L17.80 15.55L19.60 17.53L17.53 19.60L15.55 17.80L13.59 18.61L13.47 21.28L10.53 21.28L10.41 18.61L8.45 17.80L6.47 19.60L4.40 17.53L6.20 15.55L5.39 13.59L2.72 13.47L2.72 10.53L5.39 10.41L6.20 8.45L4.40 6.47L6.47 4.40L8.45 6.20ZM12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4z"/></svg>',
        folder: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>',
        refresh: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h5M20 20v-5h-5"/><path stroke-linecap="round" stroke-linejoin="round" d="M20 9A8 8 0 006 5.3M4 15a8 8 0 0014 3.7"/></svg>',
        trash: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0l1 13h8l1-13"/></svg>',
    };

    /** 单张插件卡片（AstrBot 式：把手 + 名称/状态/描述 + 底部操作排 + iOS 开关） */
    function renderModCard(m) {
        const id = escapeHtml(m.id);
        const name = escapeHtml(m.name || m.id);
        const desc = escapeHtml(m.description || '');
        const ver = m.version
            ? '<span class="text-[10px] text-indigo-400 ml-1">v' + escapeHtml(m.version) + '</span>' : '';

        // 状态角标（加载失败/前置不可用必须显眼）
        let badge = '';
        if (m.state === 'error') {
            badge = '<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 ml-1" title="'
                + escapeHtml(m.error || '') + '">加载失败</span>';
        } else if (m.state === 'blocked') {
            badge = '<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 ml-1" title="'
                + escapeHtml(m.error || '') + '">前置插件不可用</span>';
        } else if (m.state === 'ready') {
            badge = '<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600 ml-1">已加载</span>';
        } else if (m.state === 'disabled') {
            badge = '<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 ml-1">未启用</span>';
        }

        // 缺依赖：逐条给出原因 + 该做什么
        const missing = Array.isArray(m.missingDeps) ? m.missingDeps : [];
        let blockReason = '';
        if (missing.length) {
            const rows = missing.map((d) => {
                const dep = typeof d === 'string' ? { id: d, reason: '不可用' } : d;
                const what = '前置插件「' + escapeHtml(dep.id) + '」' + escapeHtml(dep.reason || '不可用');
                if (dep.reason === '未启用') return what + ' —— 把它的开关打开';
                if (dep.reason === '未安装') return what + ' —— 需要先安装它';
                if (dep.reason === '插件系统总开关已关闭') return what + ' —— 插件系统被关闭（旧版本设置残留），刷新页面即可恢复';
                return what;
            });
            blockReason = '<span class="block text-[11px] text-red-500 leading-relaxed mt-1">'
                + rows.join('<br>') + '</span>';
        }

        // hidden 的插件（公共依赖）仍给开关 —— 否则一旦被禁用就无法从界面恢复（实测踩过）
        const hiddenNote = m.hidden
            ? '<span class="text-[10px] text-indigo-300 ml-1">（公共依赖）</span>' : '';

        // iOS 风格开关
        const toggle = '<label class="mod-switch" title="' + (m.enabled ? '点击停用' : '点击启用') + '">'
            + '<input type="checkbox" class="mod-toggle" data-mod-id="' + id + '"'
            + (m.enabled ? ' checked' : '') + ' aria-label="启用 ' + name + '">'
            + '<span class="track"></span><span class="knob"></span></label>';

        // 底部那排按钮。只有本机（有服务端）才显示"打开文件夹"与"删除"。
        const canManage = m._fromServer === true;
        const openFolderBtn = canManage
            ? '<button type="button" class="mod-act mod-openfolder" data-mod-id="' + id + '"'
                + ' data-mod-name="' + name + '" title="在文件管理器里打开这个插件的目录">' + ICON.folder + '</button>'
            : '';
        const delBtn = canManage
            ? '<button type="button" class="mod-act mod-act-danger mod-del-btn" data-mod-id="' + id + '"'
                + ' data-mod-name="' + name + '" title="删除这个插件（含安装包）">' + ICON.trash + '</button>'
            : '';
        // 「设置」按钮：插件有独立设置窗（settings.modal）→ 打开；老插件占分栏 → 切分栏
        const hasModal = Boolean(window.__modSettingsOpeners && window.__modSettingsOpeners[m.id]);
        const hasTab = Boolean(document.querySelector('[data-settings-tab="tab-' + m.id + '"]'));
        const settingsBtn = (hasModal || hasTab)
            ? '<button type="button" class="mod-act mod-opensettings" data-mod-id="' + id + '"'
                + ' title="打开这个插件的设置">' + ICON.gear + '</button>'
            : '';

        return '<div class="mod-card" data-mod-id="' + id + '">'
            + '<button type="button" class="mod-grip" title="按住拖动可调整显示顺序" aria-label="拖动排序">' + ICON.grip + '</button>'
            + '<div class="min-w-0 flex-1">'
              + '<div class="flex items-start gap-2">'
                + '<div class="min-w-0 flex-1">'
                  + '<span class="text-xs font-semibold text-indigo-800">' + name + '</span>' + ver + hiddenNote + badge
                  + (desc ? '<div class="text-[11px] text-indigo-400 leading-relaxed mt-0.5">' + desc + '</div>' : '')
                  + blockReason
                + '</div>'
                + '<div class="flex-none pt-0.5">' + toggle + '</div>'
              + '</div>'
              + '<div class="flex items-center gap-1.5 mt-2">'
                + '<button type="button" class="mod-act mod-readme-btn" data-mod-id="' + id + '"'
                  + ' data-mod-name="' + name + '" title="查看插件自带的说明（README）">' + ICON.doc + '</button>'
                + settingsBtn
                + openFolderBtn
                + '<button type="button" class="mod-act mod-refresh-one" data-mod-id="' + id + '"'
                  + ' title="重新加载插件列表">' + ICON.refresh + '</button>'
                + delBtn
              + '</div>'
            + '</div>'
            + '</div>';
    }

    /** 一个分栏的 HTML（头部 + 可折叠体） */
    function renderGroupHtml(g, items) {
        const order = readOrder();
        items.sort((a, b) => {
            const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
            if (ia < 0 && ib < 0) return 0;
            if (ia < 0) return 1;
            if (ib < 0) return -1;
            return ia - ib;
        });
        const collapsed = g.collapsed === true;
        const gid = escAttr(g.id);
        // 折叠标记：disclosure triangle（▶ 收着 / ▼ 展开），展开时 rotate(90deg)
        // 左侧是专门的拖拽把手（三条竖线，与插件卡片同款）—— 拖拽与折叠不再抢手势
        return '<div class="mod-group' + (collapsed ? ' mod-group-collapsed' : '') + '" data-group-id="' + gid + '">'
            + '<div class="mod-group-head" data-group-id="' + gid + '" title="点击收纳/展开">'
            + '<span class="mod-grip mod-group-grip" title="按住拖动可调整位置" aria-label="拖动排序">'
            + '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span>'
            + '<button type="button" class="mod-group-toggle" data-group-id="' + gid + '"'
            + ' title="' + (collapsed ? '展开' : '收纳') + '" aria-label="' + (collapsed ? '展开分栏' : '收纳分栏') + '">'
            + '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 6l6 6-6 6z"/></svg></button>'
            + '<span class="mod-group-name text-xs font-semibold text-indigo-800" data-group-id="' + gid + '">'
            + escAttr(g.name) + '</span>'
            + '<span class="text-[10px] text-indigo-400">' + items.length + '</span>'
            + '<span class="mod-group-actions ml-auto flex items-center gap-1">'
            + '<button type="button" class="mod-act mod-group-rename" data-group-id="' + gid + '" title="重命名这个分栏">'
            + '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5h6M4 20h16M13.5 4.5l4 4L8 18H5v-3l8.5-10.5z"/></svg></button>'
            + '<button type="button" class="mod-act mod-act-danger mod-group-del" data-group-id="' + gid + '" title="删除这个分栏（里面的插件回到顶层）">'
            + '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0l1 13h8l1-13"/></svg></button>'
            + '</span>'
            + '</div>'
            + '<div class="mod-group-body' + (collapsed ? ' is-collapsed' : '') + '" data-group-body="' + gid + '">'
            + (items.length
                ? items.map(renderModCard).join('')
                : '<div class="text-[11px] text-indigo-300 py-3 text-center">把插件卡片拖到这里</div>')
            + '</div>'
            + '</div>';
    }

    // ★ groups 要在 renderGroupHtml **之前**声明 —— 它在函数体里被引用，
    //   const 无提升，放后面就是 TDZ（Cannot access before initialization，实测踩到）。
    const groups = readGroups();

    // ── 组装：**单一有序列表** —— 平铺插件与分栏同等级，混排（用户要求） ──
    const byGroup = new Map();
    const loose = [];
    for (const m of merged) {
        const gid = groupOf[m.id];
        if (gid && gid !== UNGROUPED_ID && groups.some((g) => g.id === gid)) {
            if (!byGroup.has(gid)) byGroup.set(gid, []);
            byGroup.get(gid).push(m);
        } else {
            loose.push(m);   // 没归属 / 归属的分栏已被删 → 顶层平铺
        }
    }
    const looseById = new Map(loose.map((m) => [m.id, m]));

    const escAttr = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // 顶层混排顺序（没提到的项按 插件在前、分栏在后 兜底追加）
    const TOP_KEY = 'elaina_mods_top_order';
    let topOrder = [];
    try {
        const v = JSON.parse(Store.getItem(TOP_KEY) || '[]');
        if (Array.isArray(v)) topOrder = v.filter((x) => x && x.t && x.id);
    } catch (e) { /* 忽略 */ }
    const seenTop = new Set(topOrder.map((x) => x.t + ':' + x.id));
    for (const m of loose) {
        if (!seenTop.has('mod:' + m.id)) topOrder.push({ t: 'mod', id: m.id });
    }
    for (const g of groups) {
        if (!seenTop.has('group:' + g.id)) topOrder.push({ t: 'group', id: g.id });
    }

    box.innerHTML = topOrder.map((entry) => {
        if (entry.t === 'group') {
            const g = groups.find((x) => x.id === entry.id);
            return g ? renderGroupHtml(g, byGroup.get(g.id) || []) : '';
        }
        const m = looseById.get(entry.id);
        return m ? renderModCard(m) : '';
    }).join('');

    // ---- 开关：走 mod 系统的 setEnabled（会持久化 + 通知 mod 自己）----
    box.querySelectorAll('.mod-toggle').forEach((el) => {
        el.addEventListener('change', async () => {
            const id = el.getAttribute('data-mod-id');
            // setEnabled 是 async 的：必须 await 之后再刷新，否则读到旧 state
            if (window.ElainaMods) await window.ElainaMods.setEnabled(id, el.checked);
            if (hint) {
                hint.textContent = '已' + (el.checked ? '启用' : '停用') + ' ' + id + '（立即生效）';
                hint.className = 'text-[11px] text-indigo-500';
            }
            void refreshModsList();
        });
    });

    // ---- 说明（README）：点开弹窗 ----
    box.querySelectorAll('.mod-readme-btn').forEach((el) => {
        el.addEventListener('click', async () => {
            const id = el.getAttribute('data-mod-id');
            const name = el.getAttribute('data-mod-name') || id;
            await openModReadme(id, name);
        });
    });

    // ---- 启用/停用后：重渲染保持状态一致（setModEnabled 会改 state）----
    box.querySelectorAll('.mod-opensettings').forEach((el) => {
        el.addEventListener('click', () => {
            const id = el.getAttribute('data-mod-id');
            const openers = window.__modSettingsOpeners || {};
            if (typeof openers[id] === 'function') {
                openers[id]();
                return;
            }
            if (typeof switchSettingsTab === 'function') switchSettingsTab('tab-' + id);
        });
    });

    // ---- 打开插件目录（POST /api/plugins/open-folder?id=…）----
    box.querySelectorAll('.mod-openfolder').forEach((el) => {
        el.addEventListener('click', async () => {
            const id = el.getAttribute('data-mod-id');
            el.disabled = true;
            try {
                const res = await fetch('/api/plugins/open-folder?id=' + encodeURIComponent(id), { method: 'POST' });
                const data = await res.json().catch(() => null);
                if (!res.ok || !data || data.ok === false) {
                    if (hint) {
                        hint.textContent = '打开失败：' + ((data && data.message) || ('HTTP ' + res.status));
                        hint.className = 'text-[11px] text-red-500';
                    }
                }
            } finally {
                el.disabled = false;
            }
        });
    });

    // ---- 单个刷新 ----
    box.querySelectorAll('.mod-refresh-one').forEach((el) => {
        el.addEventListener('click', () => { void refreshModsList(); });
    });

    // ---- 删除：调 DELETE /api/plugins/:id（删目录 + 安装包），带二次确认 ----
    box.querySelectorAll('.mod-del-btn').forEach((el) => {
        el.addEventListener('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const id = el.getAttribute('data-mod-id');
            const name = el.getAttribute('data-mod-name') || id;
            const okToGo = await showCustomConfirm(
                '删除插件「' + name + '」？\n\n'
                + '会把插件目录和安装包一起删掉（下次打开设置不会再出现）。\n'
                + '要重新安装，需要再上传一次 zip。',
                '删除插件');
            if (!okToGo) return;

            el.disabled = true;
            if (hint) { hint.textContent = '正在删除 ' + name + '…'; hint.className = 'text-[11px] text-indigo-500'; }
            try {
                const res = await fetch('/api/plugins/' + encodeURIComponent(id), { method: 'DELETE' });
                const data = await res.json().catch(() => null);
                if (!res.ok || !data || data.ok === false) {
                    if (hint) {
                        hint.textContent = '删除失败：' + ((data && data.message) || ('HTTP ' + res.status));
                        hint.className = 'text-[11px] text-red-500';
                    }
                } else {
                    // 同时清掉前端记录的启用状态 —— 插件都删了，那个键留着没意义
                    if (window.ElainaMods && typeof window.ElainaMods.forget === 'function') {
                        window.ElainaMods.forget(id);
                    }
                    if (hint) {
                        hint.textContent = '已删除 ' + name + '（刷新页面后彻底生效）';
                        hint.className = 'text-[11px] text-emerald-600';
                    }
                    void refreshModsList();
                }
            } catch (err) {
                if (hint) {
                    hint.textContent = '删除失败：' + String((err && err.message) || err);
                    hint.className = 'text-[11px] text-red-500';
                }
            } finally {
                el.disabled = false;
            }
        });
    });

    // ---- 分栏交互：重命名 / 删除 ----
    box.querySelectorAll('.mod-group-rename').forEach((el) => {
        el.addEventListener('click', () => {
            const gid = el.getAttribute('data-group-id');
            const gs = readGroups();
            const g = gs.find((x) => x.id === gid);
            const cur = g ? g.name : '';
            const next = window.prompt('分栏名称：', cur);
            if (next === null) return;
            const name2 = String(next).trim();
            if (!name2 || name2 === cur) return;
            if (g) { g.name = name2; saveGroups(gs); }
            void refreshModsList();
        });
    });

    box.querySelectorAll('.mod-group-del').forEach((el) => {
        el.addEventListener('click', async () => {
            const gid = el.getAttribute('data-group-id');
            const gs = readGroups();
            const g = gs.find((x) => x.id === gid);
            if (!g) return;
            const inside = merged.filter((m) => (groupOf[m.id] || UNGROUPED_ID) === gid);
            if (inside.length) {
                const names = inside.map((m) => m.name || m.id).join('、');
                const msg = '这个分栏里还有 ' + inside.length + ' 个插件：' + names
                    + '\n\n请先把它们拖出来（拖到列表任意位置），再删除分栏。';
                try {
                    if (typeof showCustomAlert === 'function') showCustomAlert(msg, '不能删除');
                    else window.alert(msg);
                } catch (e) { window.alert(msg); }
                return;
            }
            const okToGo = await showCustomConfirm('删除分栏「' + g.name + '」？', '删除分栏');
            if (!okToGo) return;
            saveGroups(gs.filter((x) => x.id !== gid));
            try {
                const top = JSON.parse(Store.getItem('elaina_mods_top_order') || '[]');
                Store.setItem('elaina_mods_top_order',
                    JSON.stringify(top.filter((x) => !(x.t === 'group' && x.id === gid))));
                if (typeof Store._flush === 'function') Store._flush();
            } catch (e) { /* 忽略 */ }
            void refreshModsList();
        });
    });

    // ---- 拖拽：栏内排序 / 拖进分栏归类 / 拖出分栏 / 顶层混排 / 分栏折叠 ----
    bindGroupDragSort(box, () => void refreshModsList(), { readGroups, saveGroups });
}

function closeSettingsPanel() {
    // ★ 关闭前把待保存的改动冲掉 —— 用户改完最后一项马上点 ✕ 时，
    //   那次改动还排在 300ms 防抖里，不冲就会丢（见 flushAutoSave 的说明）。
    try { flushAutoSave(); } catch (e) { /* 忽略：关闭不该因为保存失败而卡住 */ }
    elements.settingsOverlay.classList.add('hidden');
    elements.settingsOverlay.classList.remove('flex');
    syncRailActive();
}

function updateAsrProviderUI() {
    const provider = document.querySelector('input[name="asrProvider"]:checked')?.value || 'browser';
    elements.dashscopeAsrFields.classList.toggle('hidden', provider !== 'aliyun');
    const mimoFields = document.getElementById('mimoAsrFields');
    if (mimoFields) mimoFields.classList.toggle('hidden', provider !== 'mimo');
    // 浏览器识别暂不可用提示
    const warn = document.getElementById('asrBrowserWarn');
    if (warn) warn.classList.toggle('hidden', provider !== 'browser');
    // 阿里云 Key 状态（复用 TTS 的 DashScope Key）
    const statusEl = document.getElementById('settingAsrKeyStatus');
    if (statusEl) {
        const has = Boolean(String(state.settings.dashscopeApiKey || '').trim());
        statusEl.textContent = has ? '✓ 已配置' : '未配置（请到上方语音输出填写）';
        statusEl.className = 'text-[11px] ' + (has ? 'text-green-500' : 'text-amber-400');
    }
}

function updateTtsProviderUI() {
    const provider = elements.settingTtsProvider?.value || 'edge';
    elements.edgeTtsFields?.classList.toggle('hidden', provider !== 'edge');
    elements.minimaxTtsFields?.classList.toggle('hidden', provider !== 'minimax');
    elements.doubaoTtsFields?.classList.toggle('hidden', provider !== 'doubao');
    elements.dashscopeTtsFields?.classList.toggle('hidden', provider !== 'dashscope');
}

// 只负责"刷新提示文案 + 占位符"，不再改写 Base URL 的值。
// 以前这里会因为「请求模式 = 直接连接」把输入框锁成只读并强行覆盖成预设地址，
// 用户想用自建中转时根本没地方改 —— 那个下拉已删除。
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
        ttsProvider: elements.settingTtsProvider?.value || 'minimax',
        doubaoApiKey: document.getElementById('settingDoubaoApiKey')?.value.trim() || '',
        doubaoAppId: document.getElementById('settingDoubaoAppId')?.value.trim() || '',
        doubaoToken: document.getElementById('settingDoubaoToken')?.value.trim() || '',
        doubaoCluster: document.getElementById('settingDoubaoCluster')?.value.trim() || 'volcano_tts',
        doubaoVoice: document.getElementById('settingDoubaoVoice')?.value.trim() || 'zh_female_shuangkuaisisi_uranus_bigtts',
        doubaoResourceId: document.getElementById('settingDoubaoResourceId')?.value || 'seed-tts-2.0',
        dashscopeTtsModel: document.getElementById('settingDashscopeTtsModel')?.value.trim() || 'qwen3-tts-flash',
        dashscopeTtsVoice: document.getElementById('settingDashscopeTtsVoice')?.value.trim() || 'Cherry',
        dashscopeApiKey: document.getElementById('settingDashscopeApiKey')?.value.trim() || '',
        dashscopeAsrBaseUrl: document.getElementById('settingDashscopeAsrBaseUrl')?.value.trim() || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        dashscopeAsrModel: document.getElementById('settingDashscopeAsrModel')?.value.trim() || 'qwen3-asr-flash',
        mimoApiKey: document.getElementById('settingMimoApiKey')?.value.trim() || '',
        mimoBaseUrl: document.getElementById('settingMimoBaseUrl')?.value.trim() || 'https://api.xiaomimimo.com',
        mimoAsrModel: document.getElementById('settingMimoAsrModel')?.value.trim() || 'mimo-v2.5-asr',
        visionBaseUrl: document.getElementById('settingVisionBaseUrl')?.value.trim() || '',
        visionApiKey: document.getElementById('settingVisionApiKey')?.value.trim() || '',
        visionModel: document.getElementById('settingVisionModel')?.value.trim() || ''
    };
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
        const reply = await callChatAPI([
            { role: 'system', content: '这是连接测试。' },
            { role: 'user', content: '只回复 OK' }
        ], { maxTokens: 8, temperature: 0 }, draft);
        if (!reply.trim()) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '对话接口返回了空内容');
        showCustomAlert(`连接成功，模型返回：${reply.trim()}`, '对话连接正常');
    });
}

async function testTtsConnection() {
    await withSettingsTestButton(elements.testTtsConnectionBtn, '测试中…', async () => {
        const draft = readProviderSettingsForm();
        const provider = String(draft.ttsProvider || 'edge');
        if (provider === 'doubao') {
            const audio = await generateDoubaoTtsAudio('你好，这是豆包语音连接测试。', draft);
            if (!audio?.bytes?.byteLength) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '豆包返回了空音频');
            showCustomAlert('豆包已成功返回测试音频，凭据与音色可以使用。', '语音连接正常');
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
    const confirmed = await showCustomConfirm('确认清除这台设备上保存的 DeepSeek、MiniMax、豆包、DashScope 与 MiMo API Key？');
    if (!confirmed) return;
    await clearStoredApiSecrets();
    elements.settingApiKey.value = '';
    document.getElementById('settingMinimaxApiKey').value = '';
    document.getElementById('settingDoubaoApiKey').value = '';
    document.getElementById('settingDoubaoToken').value = '';
    document.getElementById('settingDashscopeApiKey').value = '';
    document.getElementById('settingMimoApiKey').value = '';
    showCustomAlert('API Key 已从当前设备清除。', '已清除');
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
 * ★ 2026-10 起设置改成「改完即生效」——底部「保存设置」按钮已删除，
 *   任何控件一变就自动调这个函数（见 app-07-init.js 的自动保存绑定）。
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
    // ★ 从「限制」切到「允许操作电脑」时，把后果在这里一次性讲清楚。
    //
    // 为什么放在保存这一步、而不是每次操作都弹：
    // 全权限下 AI 每一步都问，用户会从"看清内容再决定"退化成"闭眼点允许"，
    // 最后那道闸反而等于没有（这正是旧版"每步确认"被反馈太烦的原因）。
    // 所以判断前移到这个**一次性**的节点上：开了之后同类不可逆操作同一对话只问一次。
    //
    // 只在"真的发生切换"时问 —— 已经是 computer 又点保存不该再打扰。
    const nextPermission = document.querySelector('input[name="agentPermission"]:checked')?.value || 'app';
    if (nextPermission === 'computer' && (state.settings.agentPermission || 'app') !== 'computer') {
        // ★ 自动保存（silent）路径**也要问** —— 这是安全闸门，不能因为
        //   "弹窗会打断用户"就跳过：改成改完即生效后，用户点一下单选钮
        //   就会落盘，如果这里不问，"允许操作电脑"就被静默开启了。
        //   拒绝时把单选钮拨回原来的档，让界面与实际状态一致
        //   （否则界面显示"允许"、实际仍是"限制"，用户会以为已经开了）。
        const agreed = await showCustomConfirm(
            '「允许操作电脑」= 把 AI 的操作范围从应用文件夹扩到整台电脑。\n\n'
            + '开启后，AI 可以：\n'
            + '· 读写这台电脑上任意路径的文件\n'
            + '· 执行 PowerShell / cmd 命令\n'
            + '· 删除文件、改注册表、关机、下载并执行网上的脚本\n'
            + '· 覆盖已有文件（原内容不会自动备份）\n\n'
            + '其中「覆盖已有文件」和「删除/格式化这类危险命令」会在每个对话里首次询问你一次，'
            + '同意后该对话内不再重复询问；安全命令直接执行。\n\n'
            + '这些操作大多不可撤销，请只在你自己可控、且信任当前对话内容时开启。\n\n'
            + '确定开启吗？',
            '⚠️ 开启「允许操作电脑」');
        if (!agreed) {
            const prev = state.settings.agentPermission || 'app';
            document.querySelectorAll('input[name="agentPermission"]').forEach((r) => {
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
        agentPermission: nextPermission,
        agentApproval: document.querySelector('input[name="agentApproval"]:checked')?.value || 'once',
        agentPhoneEnabled: document.getElementById('settingAgentPhoneEnabled')?.checked !== false,
        // 思考模式：以设置面板当前状态为准。
        // 注意这两个控件是"改了立刻生效 + 立刻持久化"的（见 app-07-init.js），
        // 这里再读一次是为了覆盖"用户改了控件但没点保存、又点了保存"的路径 ——
        // 两条路径都要落到同一个值，否则会出现"保存后又变回旧值"。
        thinkingMode: elements.settingThinkingMode.checked,
        thinkingEffort: THINKING_EFFORTS.includes(elements.settingThinkingEffort.value)
            ? elements.settingThinkingEffort.value
            : 'medium'
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

    // ★ 自动保存（silent）时**不关面板、不弹提示** ——
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
 * ★ 为什么必须有：用户改完最后一项**马上点 ✕ 关闭**是很常见的操作 ——
 *   那次 change 只是排了一个 300ms 的定时器，如果关闭时不冲一下，
 *   定时器随后触发（或永远不触发）就会**丢掉最后一次修改**。
 *   （第一版写了"面板已关就跳过保存"，那正好会丢改动 —— 实测想到的坑。）
 */
function flushAutoSave() {
    if (!autoSaveTimer) return;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    Promise.resolve(saveSettings({ silent: true })).catch((e) => {
        console.warn('[Settings] 关闭前保存失败', e);
    });
}

/** 把自动保存挂到设置面板上（app-07-init.js 调用一次） */
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

// ★ 2026-10 用户要求：restoreDefaultSettings()（恢复默认设置）已**彻底删除**，
//   连同它的按钮与事件绑定。设置改成改完即生效后不再提供一键回退入口 ——
//   需要回默认值就在界面上逐项改回去（或删掉 data/ 目录重来）。

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
 * 绑定插件列表的拖拽排序。
 *
 * ★ 实现放在 mods.js 里（window.__elainaBindFlatDragSort），这里只是转发。
 *   本文件在 mods.js 之前加载，所以只能在使用时取（那时 mods.js 早已执行完）。
 */
function bindModsDragSort(box, onDone) {
    const impl = window.__elainaBindFlatDragSort;
    if (typeof impl !== 'function') {
        console.warn('[Mods] 拖拽实现未加载（mods.js 未就绪），插件列表拖动排序不可用');
        return () => {};
    }
    return impl(box, onDone);
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
            // ★ 逃逸容器：卡片拖出分栏体后落到顶层列表 —— "放进去的拿不出来"的解法
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

            // ★ 就地搬家 + FLIP（不整页重渲染）：重渲染会打断内核的飞行动画 ——
            //   卡片瞬移进/出分栏，观感"没有动画"（实测踩到）。
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
                });
            }
            // 更新计数徽标（就地改，避免重渲染打断上面的动画）
            const groupEl2 = body2.closest('.mod-group');
            if (groupEl2) {
                const cnt = groupEl2.querySelector('.mod-group-head > span:nth-last-child(2)')
                    || groupEl2.querySelector('.mod-group-head span.text-\\[10px\\]');
                if (cnt) cnt.textContent = String(body2.querySelectorAll('.mod-card').length);
            }
            // ★ 故意**不调 onDone**：它会 refreshModsList 整页重建，把刚播的
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
            // ★ 顶层混排：分栏与平铺卡片同等级，插入点候选包含两类项 ——
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

/**
 * 打开插件 README 弹窗。
 *
 * 走 /api/plugins/<id>/readme（服务端按白名单文件名读，见 server/mods.mjs）。
 * 没有 README 时服务端回 404，这里明确提示"该插件没有 README 文件"。
 */
async function openModReadme(id, name) {
    const overlay = document.getElementById('modReadmeOverlay');
    const body = document.getElementById('modReadmeBody');
    const title = document.getElementById('modReadmeTitle');
    const fileEl = document.getElementById('modReadmeFile');
    if (!overlay || !body) return;

    if (title) title.textContent = name + ' · 说明';
    if (fileEl) fileEl.textContent = '';
    body.textContent = '正在读取…';
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');

    try {
        const res = await fetch('/api/plugins/' + encodeURIComponent(id) + '/readme', { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.ok) {
            body.textContent = String(data.text || '（空文件）');
            if (fileEl) fileEl.textContent = data.name || 'README';
        } else {
            const msg = (data && data.message) || ('HTTP ' + res.status);
            body.textContent = msg;
            if (/没有 README/.test(msg)) {
                body.textContent = '该插件没有 README 文件。\n\n'
                    + '插件作者可以在插件目录里放一个 README.md 来提供说明。';
            }
        }
    } catch (err) {
        body.textContent = '读取失败：' + String((err && err.message) || err);
    }
}
