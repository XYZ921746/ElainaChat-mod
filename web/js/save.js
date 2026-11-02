/* ============================================================================
 * 设置保存 / 自动保存（从 settings.js 拆分）
 *
 * 表单落盘、防抖自动保存、提示词预览与角色卡重置。
 * ========================================================================== */
'use strict';

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
        thirdPerson: elements.settingThirdPerson.checked,
        // 对话模型能否收图片的探测缓存。这两个键不在表单里，必须从旧设置原样带过来 ——
        //   saveSettings 是整体替换 state.settings，不显式带上就会在保存时丢掉。
        chatModelVision: state.settings.chatModelVision === true ? true
            : (state.settings.chatModelVision === false ? false : null),
        chatModelVisionKey: String(state.settings.chatModelVisionKey || '')
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



