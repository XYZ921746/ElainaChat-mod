'use strict';

/** 设置改完即生效，故不弹阻断式提示；silent（自动保存）跳过提示与关面板。 */
async function saveSettings(opts) {
    const silent = Boolean(opts && opts.silent);
    const asrProvider = document.querySelector('input[name="asrProvider"]:checked')?.value || '';
    const ttsLang = document.querySelector('input[name="ttsLang"]:checked')?.value || 'chinese';
    const replyDisplayMode = document.querySelector('input[name="replyDisplayMode"]:checked')?.value || DEFAULT_SETTINGS.replyDisplayMode;
    const providerSettings = readProviderSettingsForm();
    if (!providerSettings.baseUrl) {
        if (!silent) showCustomAlert('自定义模式下必须填写 API Base URL。', '设置未保存');
        return;
    }
    // 完全访问的后果只在这一处讲清（逐步询问会让人闭眼点允许）；只在真的发生切换时问，已是 full 再点保存不打扰。
    const nextAccess = document.querySelector('input[name="agentAccess"]:checked')?.value || 'strict';
    if (nextAccess === 'full' && currentAgentAccess() !== 'full') {
        // 自动保存也要问：不问等于静默开启完全访问；拒绝时单选钮拨回切换前的档，界面与实际才一致。
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
        memoryEvery: Math.max(3, Math.min(50, parseInt(elements.settingMemoryEvery.value, 10) || 15)),
        agentAccess: nextAccess,
        agentPhoneEnabled: document.getElementById('settingAgentPhoneEnabled')?.checked !== false,
        // 判据是 === true：控件不在页面上时按关闭处理，不能用 "!== false" 兜成默认开启。
        agentBrowserEnabled: document.getElementById('settingAgentBrowserEnabled')?.checked === true,
        tavilySearchEnabled: document.getElementById('settingTavilyEnabled')?.checked === true,
        searchProvider: SEARCH_PROVIDERS[document.getElementById('settingSearchProvider')?.value]
            ? document.getElementById('settingSearchProvider').value : DEFAULT_SEARCH_PROVIDER,
        // Key 写进当前服务商那一格，不覆盖别家的 —— 换回来时原来的 Key 还在。
        ['searchApiKey_' + (SEARCH_PROVIDERS[document.getElementById('settingSearchProvider')?.value]
            ? document.getElementById('settingSearchProvider').value : DEFAULT_SEARCH_PROVIDER)]:
            document.getElementById('settingTavilyApiKey')?.value.trim() || '',
        // 条数收敛到当前服务商的上限内；解析失败回落 5（0 条等于什么都没搜）
        tavilyMaxResults: Math.max(1, Math.min(
            (SEARCH_PROVIDERS[document.getElementById('settingSearchProvider')?.value] || SEARCH_PROVIDERS[DEFAULT_SEARCH_PROVIDER]).maxResultsLimit,
            parseInt(document.getElementById('settingTavilyMaxResults')?.value, 10) || 5
        )),
        // 端点是用户填的，保存时就校验 https，让用户当场知道填错（发请求时也校验）。
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
        // 深度只认两个合法值，其余回落 basic：非法值发给服务商也会被拒，不如当场收敛
        tavilySearchDepth: document.getElementById('settingTavilySearchDepth')?.value === 'advanced' ? 'advanced' : 'basic',
        ...readAgentReadToggles(),
        // thinkingMode 由思考强度档**派生**：请求层与折叠栏仍读这个布尔量，两处必须同一来源；这里再读一次以覆盖"改了控件没点保存又点保存"的路径。
        thinkingMode: elements.settingThinkingEffort.value !== 'off'
            && THINKING_EFFORTS.includes(elements.settingThinkingEffort.value),
        thinkingEffort: THINKING_EFFORTS.includes(elements.settingThinkingEffort.value)
            ? elements.settingThinkingEffort.value
            : 'off',
        thirdPerson: elements.settingThirdPerson.checked,
        // 采样参数：关着存 ''（请求不发该字段），开着存滑杆值；范围与解析只认 core-config.js 的 CHAT_SAMPLING_FIELDS 一份。
        ...Object.fromEntries(CHAT_SAMPLING_FIELDS.map((field) => [
            field.setting,
            (elements[field.enableElement] && !elements[field.enableElement].checked)
                ? ''
                : normalizeSamplingInput(elements[field.element]?.value, field),
        ])),
        // 这两个键不在表单里，必须从 state.settings 带过来：saveSettings 整体替换，不带上就丢。
        chatModelVision: state.settings.chatModelVision === true ? true
            : (state.settings.chatModelVision === false ? false : null),
        chatModelVisionKey: String(state.settings.chatModelVisionKey || '')
    };
    try {
        await saveApiSecrets(state.settings);
    } catch (error) {
        // 密钥存储失败不阻断设置保存；密钥另有 localStorage 兜底
        console.warn('[BYOK] 密钥存储失败（设置仍已保存，密钥可能下次失效）', error);
    }
    persistSettings();

    // 存回当前这套人设，并落盘整个列表 —— 多套之间互不覆盖
    syncFormToCurrentCard();
    state.characterCard = cardContent(currentCard());
    persistCharacterCards();
    saveCharacterCard();
    renderCardSelect();

    if (!silent) {
        closeSettingsPanel();
        showCustomAlert('设置已保存！', '保存成功');
    }
}

/** 防抖 300ms（每敲一字都触发 input，不防抖会反复过 Keystore）；只监听 #settingsPanel 内、排除 #tab-mods 的控件。 */
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

/** 用户改完最后一项马上点 ✕ 时，只排了 300ms 定时器的话最后一次修改会丢。 */
function flushAutoSave() {
    if (!autoSaveTimer) return;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    Promise.resolve(saveSettings({ silent: true })).catch((e) => {
        console.warn('[Settings] 关闭前保存失败', e);
    });
}

function bindSettingsAutoSave() {
    const panel = document.getElementById('settingsPanel');
    if (!panel) return;
    const onEdit = (ev) => {
        const t = ev.target;
        if (!t || !t.closest) return;
        // 插件页 #tab-mods 里的控件不归宿主管
        if (t.closest('#tab-mods')) return;
        if (t.matches('button, [type="button"], [type="submit"], [type="file"]')) return;
        scheduleAutoSave();
    };
    panel.addEventListener('change', onEdit, true);
    panel.addEventListener('input', onEdit, true);
}

// 不提供「恢复默认设置」：一键回退会连带清掉用户自己录的凭据；要回默认值就逐项改，或删掉 data/ 目录重来。

function previewPrompt() {
    const card = {
        name: document.getElementById('ccName').value.trim() || '伊蕾娜',
        title: document.getElementById('ccTitle').value.trim() || '灰之魔女',
        worldSetting: document.getElementById('ccWorldSetting').value.trim(),
        characterPrompt: document.getElementById('ccCharacterPrompt').value.trim(),
        greeting: document.getElementById('ccGreeting').value.trim()
    };
    // 只展示用户可编辑的部分（核心协议 + 世界观 + 角色卡），系统注入的内部提示不展示，避免误改。
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
