/* ========================================================================
 * 初始化与绑定：启动流程 / 分栏 / Live2D 设置
 *
 * 本文件由 web/index.html 的主脚本按分区拆分而来（保持原始加载顺序）。
 * 拆分前提：主脚本是全局作用域，拆分后各文件共享同一全局词法环境，
 * 因此顶层 function / const / let 互相可见，调用点无需修改。
 *
 * 包含分区：
 *   · 初始化
 *   · 设置分栏 Tab 切换
 *   · Live2D 设置：模型列表 / 上传 / 测试
 *   · Live2D 背景设置（通话界面，带操作反馈）
 *   · 鼠标跟随幅度
 * ======================================================================== */

// ==================== 初始化====================

/**
 * 多设备实时同步：订阅服务端的 store 变更广播（SSE）。
 *
 * 场景：一个服务连电脑 + 手机 + 平板。手机改了设置或发了消息，
 * 电脑这边应当**自动**看到，而不是手动刷新。
 *
 * 收到远端改动后按类型重新渲染：
 *   · 聊天记录 → 重载会话列表；当前正在看的会话保持滚动位置
 *   · 人设卡 / 记忆 / 收藏 / 定时任务 → 重载对应 state
 *   · 设置 → 只更新内存值，**不重渲染设置面板**
 *     （对方正在他的设备上输入，我们这边不该被他的中间状态打断）
 *   · 主题 → 立即应用（最直观的"同步生效"反馈）
 *   · 插件开关 → 重新加载插件列表
 *
 * 任何一步出错都只记日志：最坏情况是"对面改的还没显示"，刷新即可 ——
 * 绝不能让同步逻辑影响本地使用。
 */
function startMultiDeviceSync() {
    if (!window.Store || typeof window.Store.subscribeRemote !== 'function') return;
    try {
        window.Store.subscribeRemote((keys) => {
            const has = (k) => keys.indexOf(k) >= 0;
            try {
                if (has('elaina_open_conversations') || has('elaina_open_categories')) {
                    const keepId = state.currentConversationId;
                    loadConversations();
                    // 保持当前选中的会话：不能因为别人改了别的会话就把用户
                    // 从正在看的对话里踢走（那是很突兀的体验）
                    state.currentConversationId = keepId;
                    if (typeof renderFolderList === 'function') renderFolderList();
                    const conv = state.conversations.find((c) => c.id === state.currentConversationId);
                    if (conv && typeof loadConversation === 'function') {
                        const scroller = elements.conversationHistory;
                        const keepTop = scroller ? scroller.scrollTop : 0;
                        loadConversation(conv.id);
                        if (scroller) scroller.scrollTop = keepTop;
                    }
                }
                if (has('elaina_open_character_cards') || has('elaina_open_current_card') || has('elaina_open_character_card')) {
                    if (typeof loadCharacterCards === 'function') loadCharacterCards();
                    if (typeof loadCharacterCard === 'function') loadCharacterCard();
                    if (typeof renderCardSelect === 'function') renderCardSelect();
                }
                if (has('elaina_open_memory_core') && typeof loadMemoryCore === 'function') loadMemoryCore();
                if (has('elaina_open_favorites') && typeof loadFavorites === 'function') loadFavorites();
                if (has('elaina_open_liked_quotes') && typeof loadLikedQuotes === 'function') loadLikedQuotes();
                if (has('elaina_open_tasks') && typeof renderScheduledTaskList === 'function') renderScheduledTaskList();
                if (has('elaina_open_settings')) loadSettings();
                if ((has('elaina_theme_template') || has('elaina_theme') || has('elaina_theme_custom'))
                    && window.ElainaTheme && typeof window.ElainaTheme.applyStored === 'function') {
                    window.ElainaTheme.applyStored();
                }
                if (keys.some((k) => k.indexOf('elaina_plugin') === 0 || k === 'elaina_plugins_enabled')
                    && window.ElainaMods && typeof window.ElainaMods.loadAll === 'function') {
                    window.ElainaMods.loadAll().catch(() => { /* 插件失败不影响其它同步 */ });
                }
            } catch (e) {
                console.warn('[Store] 应用远端改动时出错（不影响本地）', e);
            }
        });
    } catch (e) {
        console.warn('[Store] 多设备同步启动失败（不影响使用）', e);
    }
}

async function init() {
    syncViewportHeight();
    // ★ 先把 data/ 里的数据读进内存缓存 —— **必须在任何读取之前**。
    //
    //   Web：内部是同步 XHR，这一步实际上立即完成（零闪烁，与旧行为一致）。
    //   APK：Capacitor Filesystem 是异步的，这里 await 一次读完。
    //   两条路都不让业务代码写平台判断 —— 差异全在 store.js 里。
    await Store.bootstrap();
    // 主题在脚本求值阶段就应用过一次（那时缓存还可能是空的），
    // 这里读完真实数据后重刷一次 —— APK 上尤其必要，否则会停在默认主题。
    try { if (window.ElainaTheme) window.ElainaTheme.applyStored(); } catch (e) { /* 忽略 */ }
    loadSettings();
    await loadApiSecrets();
    loadCharacterCard();
    loadConversations();
    loadFavorites();
    loadLikedQuotes();
    loadMemoryCore();
    // ★ 多设备实时同步：订阅服务端的 store 变更广播（SSE）。
    //
    //   场景：一个服务连电脑 + 手机 + 平板。手机改了设置或发了消息，
    //   电脑这边应当**自动**看到，而不是要手动刷新。
    //   只在 Web 生效（APK 没有服务端，单设备不存在"别的设备改了"）。
    startMultiDeviceSync();
    elements.textInput.value = '';
    document.getElementById('initialTextInput').value = '';
    elements.sidebarSearchInput.value = '';
    elements.notesSearch.value = '';
    syncThinkingModeControls();
    updateComposerSendVisibility();

    initSpeechRecognition();

    loadDailyQuote();

    startGreetingTyping();

    elements.micBtn.addEventListener('click', handleMicClick);
    elements.floatingMicBtn.addEventListener('click', handleMicClick);
    elements.floatingEndBtn.addEventListener('click', endListening);
    elements.floatingCancelBtn.addEventListener('click', cancelListening);

    elements.railSettingsBtn.addEventListener('click', openSettings);
    elements.closeSettings.addEventListener('click', closeSettingsPanel);
    elements.settingsOverlay.addEventListener('click', (e) => {
        if (e.target === elements.settingsOverlay) closeSettingsPanel();
    });
    // ★ 2026-10：底部「取消 / 保存设置」按钮已删除 —— 设置改成**改完即生效**：
    //   任何控件一变就自动落盘（bindSettingsAutoSave），关闭直接点 ✕。
    //   原来的两条绑定（cancelSettings / saveSettings）随之删除；
    //   saveSettings() 函数保留（自动保存仍在用），只是不再由按钮触发、
    //   且以 silent 模式调用。
    //   「恢复默认设置」按钮与 restoreDefaultSettings() 也已按要求彻底删除
    //   （用户明确"直接删了不用留"），所以这里不再有它的绑定。
    bindSettingsAutoSave();
    // 插件：重新扫描 + 全局开关
    //
    // ★★ 2026-10 修正：两个平台的"扫描"含义不同，提示语要分开。
    //   电脑版：服务端会扫 web/mods/ 目录，把**手工丢进去的 zip** 自动解压安装。
    //   APK：没有服务端，插件一律住应用私有目录，只能靠「上传安装」装进来 ——
    //        这里点一下只是**重读一遍列表**（例如刚装完/刚删完想确认）。
    //   原来两端共用一句"扫描中…"，在 APK 上会让用户以为"把 zip 拷进某个目录"
    //   是可行的（安卓上根本碰不到那个目录），是误导。
    document.getElementById('modsRefreshBtn')?.addEventListener('click', () => {
        const hint = document.getElementById('modsHint');
        if (hint) {
            hint.textContent = IS_NATIVE_APP ? '正在重新读取插件列表…' : '扫描中…';
            hint.className = 'text-[11px] text-indigo-400';
        }
        void refreshModsList();
    });
    // 插件：＋添加分栏。
    //
    // ★ 必须绑在这里（app-07-init 只执行一次）—— 之前绑在 refreshModsList 里，
    //   而它每次刷新列表都会重跑一遍：点一次按钮触发 N 个 handler，
    //   连续弹出 5-6 次输入框（实测踩到：刷新 N 次就弹 N 次）。
    document.getElementById('modsAddGroupBtn')?.addEventListener('click', async () => {
        const name = window.prompt('新分栏的名称：', '');
        if (name === null) return;
        const n = String(name).trim();
        if (!n) return;
        // readGroups/saveGroups 是 refreshModsList 闭包里的，这里拿不到 ——
        // 直接读写同一对 Store 键（键名约定见 app-06-settings.js）。
        const KEY = 'elaina_mods_groups';
        let gs = [];
        try {
            const v = JSON.parse(Store.getItem(KEY) || '[]');
            gs = Array.isArray(v) ? v.filter((g) => g && g.id) : [];
        } catch (e) { /* 忽略 */ }
        if (!gs.some((g) => g.id === '__ungrouped__')) {
            gs.unshift({ id: '__ungrouped__', name: '未分类', collapsed: false, fixed: true });
        }
        if (gs.some((g) => g.name === n)) {
            window.alert('已经有叫「' + n + '」的分栏了。');
            return;
        }
        gs.push({ id: 'g' + Date.now().toString(36), name: n, collapsed: false });
        Store.setItem(KEY, JSON.stringify(gs));
        // ★ 新分栏插到**顶层混排的最前面**（用户要求：新建的应在最上面）。
        //   top_order 是渲染时的项顺序（卡片与分栏混排），不写的话渲染兜底
        //   会把新分栏追加到末尾。
        try {
            const TOP_KEY = 'elaina_mods_top_order';
            let top = [];
            try { top = JSON.parse(Store.getItem(TOP_KEY) || '[]'); } catch (e) { /* 忽略 */ }
            if (!Array.isArray(top)) top = [];
            top.unshift({ t: 'group', id: gs[gs.length - 1].id });
            Store.setItem(TOP_KEY, JSON.stringify(top));
        } catch (e) { /* 忽略 */ }
        if (typeof Store._flush === 'function') Store._flush();
        void refreshModsList();
    });
    // 插件：上传安装。
    //
    // 为什么要有这条路：原先只能"把 zip 拷进 web/mods/ 目录"，电脑上可行，
    // 但手机/平板用户碰不到文件系统（APK 更是连服务端都没有）。所以补一个
    // 应用内上传入口 —— 与"丢文件进目录"等价，只是换了个方式把 zip 交给服务端。
    //
    // 传输方式：请求体直接是 zip 的原始字节（不是 multipart）。这样服务端
    // 不用写 multipart 解析、也不引依赖；前端用 fetch 把 File 当 body 发即可。
    document.getElementById('modsInstallBtn')?.addEventListener('click', () => {
        document.getElementById('modsFileInput')?.click();
    });
    document.getElementById('modsFileInput')?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        const hint = document.getElementById('modsHint');
        if (!file) return;
        const setHint = (text, cls) => {
            if (hint) { hint.textContent = text; hint.className = 'text-[11px] ' + (cls || 'text-indigo-500'); }
        };
        setHint('上传中…（' + Math.round(file.size / 1024) + ' KB）', 'text-indigo-500');
        try {
            const res = await fetch('/api/plugins/install?name=' + encodeURIComponent(file.name), {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: file,
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.ok) {
                setHint('安装失败：' + ((data && data.message) || ('HTTP ' + res.status)), 'text-red-500');
            } else {
                setHint('✅ ' + (data.message || '已安装') + '（到上面打开开关即可启用）', 'text-emerald-600');
                void refreshModsList();
            }
        } catch (err) {
            setHint('安装失败：' + String((err && err.message) || err), 'text-red-500');
        } finally {
            // 清空 input，否则同一个文件再选一次不会触发 change
            e.target.value = '';
        }
    });
    // 顶栏「外观模式」三段开关（跟随设备 / 浅色 / 深色）——见 index.html 的
    // .header-theme-switch。它取代了原「外观 → 深色模式」下拉：
    //   · 点某一段 → ElainaTheme.setDarkMode(该段的 data-mode)
    //   · 选中的那段加 .is-active（填充圆底）；「跟随设备」= 原来的「跟随系统」
    //   · 主题被别处改动（系统深浅色变化等）时靠 MutationObserver 同步选中态
    const themeSwitch = document.getElementById('headerThemeBtn');
    const markThemeSeg = () => {
        if (!themeSwitch || !window.ElainaTheme) return;
        let mode = 'light';
        try { mode = window.ElainaTheme.darkMode(); } catch (e) { /* 忽略 */ }
        themeSwitch.querySelectorAll('.theme-seg').forEach((b) => {
            b.classList.toggle('is-active', b.dataset.mode === mode);
        });
    };
    themeSwitch?.addEventListener('click', (ev) => {
        const seg = ev.target && ev.target.closest ? ev.target.closest('.theme-seg') : null;
        if (!seg || !window.ElainaTheme) return;
        window.ElainaTheme.setDarkMode(seg.dataset.mode);
        markThemeSeg();
    });
    markThemeSeg();
    if (document.documentElement && typeof MutationObserver === 'function') {
        new MutationObserver(markThemeSeg)
            .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    document.getElementById('authChangeBtn')?.addEventListener('click', changeAccessPassword);
    document.getElementById('authLogoutBtn')?.addEventListener('click', logoutAccess);
    // 日志级别 / 追踪开关的界面已移除（见 index.html 里的说明）：级别回默认、追踪固定开，
    // 所以这里不再有"改完立即生效"的监听。运行期仍可用 /api/logs/settings 调。
    // 我的数据：导出直接下载备份，导入选文件后合并进 data/
    document.getElementById('dataExportBtn')?.addEventListener('click', exportDataBackup);
    // 操作悬浮窗：跳系统设置授权 / 重新检测
    document.getElementById('overlayEnableBtn')?.addEventListener('click', enableOverlay);
    document.getElementById('overlayCheckBtn')?.addEventListener('click', () => { void refreshOverlayStatus(); });
    // 副屏监视窗：入口在**运行状态条**上（AI 跑任务时才出现），
    // 不放在设置里 —— 那是"用的时候才需要"的东西，放设置里得先翻两层。
    document.getElementById('agentWatchBtn')?.addEventListener('click', () => { openScreenWatch(); });
    // 插件 README 弹窗：关闭按钮 + 点遮罩关闭（点面板内部不关）
    (function bindModReadmeModal() {
        const overlay = document.getElementById('modReadmeOverlay');
        if (!overlay) return;
        const close = () => { overlay.classList.add('hidden'); overlay.classList.remove('flex'); };
        document.getElementById('modReadmeClose')?.addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        // Esc 关闭（与其它弹窗一致的习惯）
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
        });
    })();
    // 副屏监视窗
    document.getElementById('closeScreenWatch')?.addEventListener('click', closeScreenWatch);
    document.getElementById('screenWatchPanel')?.addEventListener('click', (e) => {
        // 点遮罩关闭（点面板内部不关）
        if (e.target && e.target.id === 'screenWatchPanel') closeScreenWatch();
    });
    document.getElementById('screenWatchRefreshBtn')?.addEventListener('click', () => { void screenWatchRefresh(); });
    document.getElementById('screenWatchAutoBtn')?.addEventListener('click', (e) => {
        screenWatchAuto = !screenWatchAuto;
        e.currentTarget.textContent = '自动刷新：' + (screenWatchAuto ? '开' : '关');
        if (screenWatchAuto) screenWatchStartAuto(); else screenWatchStopAuto();
    });
    document.getElementById('screenWatchPowerBtn')?.addEventListener('click', async (e) => {
        const plugin = deviceBridge();
        if (!plugin || typeof plugin.moduleDisplay !== 'function') return;
        const btn = e.currentTarget;
        const wasRunning = /关闭/.test(btn.textContent || '');
        btn.disabled = true;
        try {
            const res = await plugin.moduleDisplay({ op: wasRunning ? 'stop' : 'start' });
            screenWatchNote(wasRunning ? '已请求关闭副屏' : '已请求启动副屏');
            if (res && res.text) console.log('[ScreenWatch] ' + res.text);
        } catch (err) {
            screenWatchNote('副屏开关失败：' + (err.message || err));
        } finally {
            btn.disabled = false;
            // 副屏启停需要几秒，稍等再刷新
            setTimeout(() => { void screenWatchRefresh(); }, 2500);
        }
    });
    document.getElementById('dataImportBtn')?.addEventListener('click', () => {
        // APK 优先让用户从**已经导出到文档目录的备份**里挑（纯 Filesystem，不依赖 WebView 的文件选择器）；
        // 挑不到（没有备份 / 插件不可用）再退回系统文件选择器。
        if (IS_NATIVE_APP && nativeFs()) { void importFromDocumentsOrPicker(); return; }
        document.getElementById('dataImportFile')?.click();
    });
    document.getElementById('dataImportFile')?.addEventListener('change', (ev) => {
        const input = ev.target;
        const file = input.files && input.files[0];
        // 先清空 value：同一个文件连选两次也要能触发 change
        input.value = '';
        void importDataBackup(file);
    });
    // 获取模型列表。**三种格式都支持** —— Anthropic 也有 Models API（`GET /v1/models`），
    // 返回 `{ data: [{ id, display_name, … }] }`，和 OpenAI 的 `{ data: [{ id }] }` 同构，
    // 所以解析逻辑可以共用，差别只在**地址**和**认证头**。
    // 以前这里写着"Anthropic 不可用"，其实不是它没这个接口，是地址拼错了（见 modelsEndpointFor）。

    /**
     * 模型列表接口的地址。
     *
     * 版本段是唯一的坑：OpenAI 系的 Base URL 惯例上**就带** `/v1`
     * （默认值就是 `https://api.openai.com/v1`），所以和发对话一样直接拼 `/models`；
     * Anthropic 的惯例是**不带**（默认 `https://api.anthropic.com`），而它的 Models API 在
     * `/v1/models` —— 直接拼 `/models` 会 404。
     *
     * 这条规则必须和 `web/js/chat-providers.js` 里 `callAnthropicChat` 拼 `/messages` 的规则保持一致，
     * 否则会出现"对话能通、获取模型 404"这种最费解的现象。
     */
    function modelsEndpointFor(baseUrl, apiFormat) {
        let base = String(baseUrl || '').trim().replace(/\/+$/, '');
        if (!base) throw new Error('请先填写 API Base URL');
        // 用户可能把完整的功能地址整条粘进来（chat/completions、responses、messages），先剥掉再拼
        base = base.replace(/\/(?:chat\/completions|responses|messages)$/i, '');
        if (/\/models$/i.test(base)) return base;
        if (apiFormat === 'anthropic' && !/\/v\d+$/i.test(base)) return base + '/v1/models';
        return base + '/models';
    }

    /** 从模型列表响应里取模型名（OpenAI 与 Anthropic 的 `data[].id` 同构） */
    function parseModelList(payload) {
        const raw = Array.isArray(payload?.data) ? payload.data : [];
        return raw
            .map(item => (typeof item === 'string' ? item : item?.id))
            .filter(Boolean)
            .map(String)
            .sort((a, b) => a.localeCompare(b));
    }

    async function fetchModelList(baseUrl, apiKey, apiFormat) {
        const endpoint = modelsEndpointFor(baseUrl, apiFormat);
        const key = String(apiKey || '').trim();
        // Anthropic 的认证头是 x-api-key，不是 Authorization: Bearer —— 用错了会 401，
        // 而它只回 authentication_error，看不出是头用错了。
        // 但第三方中转（new-api 系）的 /v1/models 常常只认 Bearer，所以失败后**退一步再试**。
        // `limit=1000` 是 Anthropic 的上限（默认只回 20 条，不指定会静默截断）。
        const attempts = apiFormat === 'anthropic'
            ? [
                { url: endpoint + '?limit=1000', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
                { url: endpoint, headers: { Authorization: 'Bearer ' + key } }
            ]
            : [{ url: endpoint, headers: { Authorization: 'Bearer ' + key } }];
        let failure = null;
        for (const attempt of attempts) {
            let result;
            try {
                // 关键：走设备层，不要裸 fetch。
                // APK 的 WebView 里裸 fetch 会撞 CORS，而服务商并不都发 CORS 头 ——
                // 这正是「获取模型」在手机上一直失败的原因。
                result = await getJsonFromDevice(attempt.url, attempt.headers, 20000);
            } catch (error) {
                // 连不上 / 被中断：换一条路也一样，别白打第二次
                if (!failure) failure = error;
                break;
            }
            const models = result.ok ? parseModelList(result.payload) : [];
            if (models.length) return models;
            if (!failure) {
                const fromPayload = result.payload?.error?.message || result.payload?.message || '';
                // 200 却拿回 HTML —— 这是"地址少了版本段"最典型的症状：请求打到了
                // 站点首页/网关页，而不是 API。原来的文案说"可能该服务不支持 /models"，
                // 会把人引到完全错误的方向。
                // 实测：`https://newapi.gay/models` → text/html 首页；
                //       `https://newapi.gay/v1/models` 才是真接口。
                const looksHtml = /^\s*<(!doctype|html|head|body)/i.test(String(result.rawText || ''));
                const baseNoModels = endpoint.replace(/\/models$/, '');
                if (!result.ok) {
                    failure = new Error(fromPayload || ('HTTP ' + result.status));
                } else if (looksHtml) {
                    failure = new Error('接口返回的是网页（HTML），不是 API 响应'
                        + '\n· 实际请求：' + attempt.url
                        + '\n· 多半是 Base URL 少了版本段，试试：' + baseNoModels + '/v1'
                        + '\n  （OpenAI 兼容的 Base URL 惯例上就带 /v1，例如 https://api.deepseek.com/v1）');
                } else if (result.payload === null) {
                    failure = new Error('接口返回的不是有效 JSON'
                        + '\n· 实际请求：' + attempt.url
                        + '\n· 原文开头：' + String(result.rawText || '(空)').slice(0, 120));
                } else {
                    failure = new Error('接口返回的 JSON 里没有模型列表（data 为空）'
                        + '\n· 实际请求：' + attempt.url
                        + '\n· 如果这个服务确实有模型，可能是它的 /models 路径不同，或该账号下没有可用模型。');
                }
            }
            // 只有"这条路明显走不通"才换下一条。5xx / 超时换一条也一样失败。
            if (![401, 403, 404].includes(Number(result.status))) break;
        }
        throw failure || new Error('获取模型列表失败');
    }
    /**
     * 渲染组合框的候选列表（★ 2026-10 新增）。
     *
     * 用户要求（原话）："点右边三角显示模型列表，点击对应的模型直接替换模型上去。
     * 如果获取到的模型里有与填写的一样的，列表里就不显示名称，避免显示两个一模一样的。"
     *
     * ★ 所以这里有一条**刻意**的规则：**当前输入框里的值不列进候选**。
     *   理由（用户明确说的）：那是"已经用着的那个"，再列一遍会看到两个一样的名字；
     *   而且点了也没有任何变化（值本来就等于它）。列表只为"换成别的"服务。
     *
     * @param {HTMLElement} listEl  浮层列表容器
     * @param {string[]} models     全部候选
     * @param {string} current      输入框当前值（会被排除）
     * @param {(m:string)=>void} onPick 选中回调
     */
    function renderModelComboList(listEl, models, current, onPick) {
        if (!listEl) return;
        const cur = String(current || '').trim();
        // 排除与当前值相同的项（用户要求：避免显示两个一模一样的）
        const shown = models.filter((m) => m !== cur);
        listEl.innerHTML = '';
        if (!shown.length) {
            // 全部候选都等于当前值（或本来就没有）→ 给一句说明，
            // 否则用户点了三角看到一个空框，会以为功能坏了。
            const empty = document.createElement('div');
            empty.className = 'model-combo-empty';
            empty.textContent = models.length
                ? '列表里只有当前这个模型。'
                : '还没有拉到模型列表 —— 先点「获取模型」。';
            listEl.appendChild(empty);
            return;
        }
        for (const m of shown) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'model-combo-item';
            item.setAttribute('role', 'option');
            item.textContent = m;
            item.addEventListener('click', () => {
                onPick(m);
                closeModelCombo(listEl);
            });
            listEl.appendChild(item);
        }
    }

    /** 收起某个组合框的浮层 */
    function closeModelCombo(listEl) {
        if (!listEl) return;
        listEl.classList.add('hidden');
        const combo = listEl.closest('.model-combo');
        if (combo) combo.classList.remove('is-open');
        const btn = combo && combo.querySelector('.model-combo-toggle');
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    /**
     * 给一组「输入框 + 三角按钮 + 浮层列表 + 隐藏的 select」接上组合框行为。
     *
     * @param {object} cfg
     * @param {HTMLInputElement} cfg.input   真正取值的输入框
     * @param {HTMLButtonElement} cfg.toggle 右侧三角
     * @param {HTMLElement} cfg.list         浮层列表
     * @param {HTMLSelectElement} cfg.select 候选数据源（隐藏，沿用既有 id）
     */
    function bindModelCombo({ input, toggle, list, select }) {
        if (!input || !toggle || !list || !select) return;

        /** 当前 select 里有哪些候选 */
        const candidates = () => [...select.options].map((o) => o.value);

        /** 用输入框的当前值刷新列表内容（排除同名项） */
        const refresh = () => renderModelComboList(list, candidates(), input.value, (m) => {
            input.value = m;
            select.value = m;
            // 改完要让宿主知道值变了（自动保存靠 change/input 事件）
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });

        toggle.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const willOpen = list.classList.contains('hidden');
            // 先关掉**其它**组合框（只允许一个展开）
            document.querySelectorAll('.model-combo-list').forEach((el) => {
                if (el !== list) closeModelCombo(el);
            });
            if (willOpen) {
                // ★ 每次展开都重新渲染：输入框的值可能已经改了，
                //   而"排除同名项"依赖它 —— 不重渲染就会漏掉"刚刚变成同名"的那一项。
                refresh();
                list.classList.remove('hidden');
                const combo = list.closest('.model-combo');
                if (combo) combo.classList.add('is-open');
                toggle.setAttribute('aria-expanded', 'true');
            } else {
                closeModelCombo(list);
            }
        });

        // 点别处 / 按 Esc 收起
        document.addEventListener('click', (ev) => {
            if (list.classList.contains('hidden')) return;
            const combo = list.closest('.model-combo');
            if (combo && !combo.contains(ev.target)) closeModelCombo(list);
        });
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') closeModelCombo(list);
        });
        // 输入框的值变了 → 若列表正开着，同步刷新（"排除同名项"要跟着变）
        input.addEventListener('input', () => {
            if (!list.classList.contains('hidden')) refresh();
        });

        // 暴露给 populateModelSelect 用：拉到列表后立刻刷新浮层内容
        input.__modelComboRefresh = refresh;
    }

    async function populateModelSelect({ btn, input, select, baseUrl, apiKey, apiFormat, defaultModels }) {
        const old = btn.textContent;
        btn.textContent = '⏳ 获取中…';
        try {
            const models = await fetchModelList(baseUrl, apiKey, apiFormat);
            if (!models.length) throw new Error('接口未返回模型列表（data 为空），可能该服务不支持 /models');
            select.innerHTML = '';
            for (const m of models) {
                const o = document.createElement('option');
                o.value = m; o.textContent = m;
                select.appendChild(o);
            }
            // ★ 2026-10 组合框：select **保持隐藏**（它是候选数据源，不再是可见控件）。
            //
            //   旧行为是 `select.classList.remove('hidden')` —— 把下拉框显示在输入框
            //   下方。用户要求"下拉框和输入的地方二合一"，所以可见的那个改成了
            //   右三角展开的浮层（见 bindModelCombo / renderModelComboList），
            //   select 退回纯数据源。这里刻意**不再**取消 hidden。
            //   （check-model-list 里对应的断言已同步改成"候选进了浮层列表"。）
            select.onchange = () => { input.value = select.value; };            // 必须把模型名**填进输入框** —— 真正发给服务商的是 input 的值
            // （见 readProviderSettingsForm），只填下拉框等于这个功能没生效。
            //
            // 真实故障：Anthropic 下切格式时会自动填预设名 `claude-sonnet-4-20250514`，
            // 而它通常不在服务端真实返回的列表里。原来的代码只在"输入框的值恰好
            // 在列表里"时才回写下拉框选中项，从不写 input —— 于是列表拉出来了，
            // 发出去的还是那个不存在的预设名，一对话就 404。
            //
            // 四种情况分开处理（**顺序很重要**）：
            //   ① 输入框的值在列表里          → 原样保留。这一条必须放最前：
            //      预设名恰好有效时也该保留，否则会把用户当前用的模型
            //      悄悄换成列表里字母序第一个（如 claude-haiku），属于越权改动。
            //   ② 输入框为空                  → 填列表第一项（否则"拉到了但没选"，等于没用）
            //   ③ 输入框里是**预设默认值**     → 覆盖成列表第一项。那是切格式时应用自动填的，
            //                                   已证明不在真实列表里，留着必然 404。
            //   ④ 其它手填的值不在列表里       → **不覆盖**（可能是中转站的私有别名，
            //                                   用户是故意填的），但下拉框选中第一项，
            //                                   用户点一下即可换过去。
            const current = String(input.value || '').trim();
            const isStalePreset = Array.isArray(defaultModels) && defaultModels.includes(current);
            if (current && models.includes(current)) {
                select.value = current;
            } else if (!current || isStalePreset) {
                input.value = models[0];
                select.value = models[0];
            } else {
                select.value = models[0];
            }
            // ★ 2026-10 组合框：候选刚换了一批，立刻刷新浮层内容。
            //   注意**这里不需要展开列表** —— 用户点的是「获取模型」，
            //   他的意图是"把列表拉下来备用"，不是"现在就要选"。
            //   展开由右三角负责（见 bindModelCombo）。这也是用户要的分工：
            //   "点右边三角显示模型列表"。
            if (typeof input.__modelComboRefresh === 'function') input.__modelComboRefresh();
        } catch (err) {
            // 上面各分支已经给出**具体**原因（HTML 首页 / 非 JSON / data 为空 / HTTP 码）。
            // 这里只兜底浏览器层失败 —— 那种情况错误信息里只有一句 "Failed to fetch"，
            // 不说清的话用户会以为是地址或 Key 写错了。
            const detail = String(err?.message || err);
            const isNetwork = /Failed to fetch|NetworkError|Load failed/i.test(detail);
            showCustomAlert(
                '获取模型列表失败：' + detail
                + (isNetwork
                    ? '\n\n这是**浏览器层面**的失败，不是地址或 Key 错。最常见的原因是服务商没发 CORS 响应头；'
                      + '\n用 启动.bat 打开页面会自动走本机中转绕开它，直接双击 index.html 则不走中转。'
                    : '')
                + '\n\n拉不到列表不影响使用 —— 把模型名直接手填进上面的输入框即可。',
                '获取模型'
            );
        } finally {
            btn.textContent = old;
        }
    }
    document.getElementById('fetchChatModelsBtn')?.addEventListener('click', () => {
        void populateModelSelect({
            btn: document.getElementById('fetchChatModelsBtn'),
            input: document.getElementById('settingChatModel'),
            select: document.getElementById('chatModelsSelect'),
            baseUrl: elements.settingBaseUrl.value,
            apiKey: elements.settingApiKey.value,
            apiFormat: elements.settingApiFormat.value,
            // 各格式的预设模型名：用来识别"输入框里是切格式时自动填的、并非用户手填"
            defaultModels: Object.values(CHAT_API_FORMATS).map(f => f.defaultModel)
        });
    });
    document.getElementById('fetchVisionModelsBtn')?.addEventListener('click', () => {
        void populateModelSelect({
            btn: document.getElementById('fetchVisionModelsBtn'),
            input: document.getElementById('settingVisionModel'),
            select: document.getElementById('visionModelsSelect'),
            baseUrl: document.getElementById('settingVisionBaseUrl')?.value,
            apiKey: document.getElementById('settingVisionApiKey')?.value
        });
    });

    // ===== 模型名组合框：接上"点右三角展开列表"的行为（★ 2026-10）=====
    // 两处（对话模型 / 视觉模型）结构相同，用同一段绑定逻辑。
    bindModelCombo({
        input: document.getElementById('settingChatModel'),
        toggle: document.getElementById('chatModelsToggle'),
        list: document.getElementById('chatModelsList'),
        select: document.getElementById('chatModelsSelect'),
    });
    bindModelCombo({
        input: document.getElementById('settingVisionModel'),
        toggle: document.getElementById('visionModelsToggle'),
        list: document.getElementById('visionModelsList'),
        select: document.getElementById('visionModelsSelect'),
    });
    // ★ 设置里的所有下拉（深色模式 / API 格式 / 语音输出 / 思考强度 / 日志筛选…）
    //   改用自绘弹出面板（见文件末尾 initSettingsDropdowns 的说明）。
    initSettingsDropdowns();
    elements.settingApiFormat.addEventListener('change', () => {
        const apiFormat = elements.settingApiFormat.value || 'openai-compatible';
        const preset = CHAT_API_FORMATS[apiFormat] || CHAT_API_FORMATS['openai-compatible'];
        const currentBaseUrl = elements.settingBaseUrl.value.trim();
        const usesDefault = !currentBaseUrl || Object.values(CHAT_API_FORMATS).some(format => format.defaultBaseUrl === currentBaseUrl);
        if (usesDefault) {
            elements.settingBaseUrl.value = preset.defaultBaseUrl;
        }
        // 切换格式时必须同步换掉模型名。
        // 否则切到 Anthropic 后框里还留着 deepseek-chat，会被原样发过去 → 404，
        // 而界面上完全看不出是这个原因（用户以为改格式就够了）—— 这就是"换了格式就连不上"。
        // 只替换"空"或"恰好等于某个预设默认值"的情况；用户自己填过的名字不动。
        const currentModel = String(elements.settingChatModel.value || '').trim();
        const isPresetDefault = Object.values(CHAT_API_FORMATS).some(format => format.defaultModel === currentModel);
        if (!currentModel || isPresetDefault) elements.settingChatModel.value = preset.defaultModel;
        updateChatFormatUI();
    });
    elements.settingTtsProvider.addEventListener('change', updateTtsProviderUI);
    // MiMo TTS 模型下拉切换子字段（预置音色 / 音色描述 / 参考音频样本）
    document.getElementById('settingMimoTtsModel')?.addEventListener('change', updateMimoTtsModelUI);
    // 参考音频样本：文件框不触发自动保存（见 bindSettingsAutoSave），这里自己落盘
    document.getElementById('settingMimoTtsCloneSample')?.addEventListener('change', handleMimoTtsCloneSampleFileChange);
    document.getElementById('mimoTtsCloneSampleClear')?.addEventListener('click', clearMimoTtsCloneSample);
    elements.testChatConnectionBtn.addEventListener('click', testChatConnection);
    elements.testTtsConnectionBtn.addEventListener('click', testTtsConnection);
    elements.clearApiKeysBtn.addEventListener('click', clearApiKeys);
    elements.announcementConfirmBtn.addEventListener('click', closeAnnouncement);
    elements.announcementOverlay.addEventListener('click', (event) => {
        if (event.target === elements.announcementOverlay) closeAnnouncement();
    });

    document.querySelectorAll('input[name="asrProvider"]').forEach(r => {
        r.addEventListener('change', updateAsrProviderUI);
    });
    // 阿里云 ASR 连接测试：发 0.5s 静音验证 Key 与模型开通状态（Key 为**独立的 ASR Key**，不再复用 TTS 的）
    document.getElementById('settingAsrTest')?.addEventListener('click', async () => {
        const key = document.getElementById('settingAsrApiKey')?.value.trim();
        const asrUrl = document.getElementById('settingDashscopeAsrBaseUrl')?.value.trim() || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
        const asrModel = document.getElementById('settingDashscopeAsrModel')?.value.trim() || 'qwen3-asr-flash';
        const statusEl = document.getElementById('settingAsrTestStatus');
        if (!statusEl) return;
        if (!key) {
            statusEl.textContent = '请先填写 API Key（语音输入 → 阿里百炼）';
            statusEl.className = 'text-[11px] text-red-400';
            return;
        }
        statusEl.textContent = '测试中…';
        statusEl.className = 'text-[11px] text-indigo-300';
        try {
            const samples = new Float32Array(ASR_TARGET_SAMPLE_RATE * 0.5); // 0.5s 静音
            const result = await postJsonFromDevice(asrUrl, {
                model: asrModel,
                input: { messages: [{ role: 'user', content: [{ audio: `data:audio/wav;base64,${float32ToWavBase64(samples, ASR_TARGET_SAMPLE_RATE)}` }] }] },
                parameters: { asr_options: { language: 'zh', enable_itn: true } }
            }, { Authorization: `Bearer ${key}`, 'X-DashScope-DataInspection': 'enable' }, 20000);
            if (result.ok) {
                statusEl.textContent = '✅ 连接成功（HTTP ' + (result.status || 200) + '）：Key 有效、' + asrModel + ' 已开通';
                statusEl.className = 'text-[11px] text-green-500';
            } else {
                const msg = String(
                    result.payload?.base_resp?.status_msg ||
                    result.payload?.message ||
                    result.payload?.error?.message ||
                    result.payload?.error ||
                    ('HTTP ' + result.status)
                );
                statusEl.textContent = '❌ ' + msg + '（HTTP ' + (result.status || '?') + '）';
                statusEl.className = 'text-[11px] text-red-400';
            }
        } catch (err) {
            statusEl.textContent = '❌ ' + (err.message || err);
            statusEl.className = 'text-[11px] text-red-400';
        }
    });
    // 小米 MiMo ASR 连接测试（OpenAI 兼容 /v1/chat/completions + input_audio）
    document.getElementById('settingMimoAsrTest')?.addEventListener('click', async () => {
        const key = document.getElementById('settingMimoAsrApiKey')?.value.trim();
        const baseUrl = (document.getElementById('settingMimoAsrBaseUrl')?.value.trim() || 'https://api.xiaomimimo.com').replace(/\/+$/, '');
        const model = document.getElementById('settingMimoAsrModel')?.value.trim() || 'mimo-v2.5-asr';
        const statusEl = document.getElementById('settingMimoAsrTestStatus');
        if (!statusEl) return;
        if (!key) {
            statusEl.textContent = '请先填写 MiMo API Key';
            statusEl.className = 'text-[11px] text-red-400';
            return;
        }
        statusEl.textContent = '测试中…';
        statusEl.className = 'text-[11px] text-indigo-300';
        try {
            const samples = new Float32Array(ASR_TARGET_SAMPLE_RATE * 0.5); // 0.5s 静音
            const result = await postJsonFromDevice(baseUrl + '/v1/chat/completions', {
                model,
                messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${float32ToWavBase64(samples, ASR_TARGET_SAMPLE_RATE)}`, format: 'wav' } }] }],
                asr_options: { language: 'zh' },
                stream: false
            }, { 'api-key': key, 'Content-Type': 'application/json' }, 20000);
            if (result.ok) {
                statusEl.textContent = '✅ 连接成功（HTTP ' + (result.status || 200) + '）：MiMo ASR 可用';
                statusEl.className = 'text-[11px] text-green-500';
            } else {
                const msg = String(
                    result.payload?.message ||
                    result.payload?.error?.message ||
                    result.payload?.error ||
                    ('HTTP ' + result.status)
                );
                statusEl.textContent = '❌ ' + msg + '（HTTP ' + (result.status || '?') + '）';
                statusEl.className = 'text-[11px] text-red-400';
            }
        } catch (err) {
            statusEl.textContent = '❌ ' + (err.message || err);
            statusEl.className = 'text-[11px] text-red-400';
        }
    });
    elements.settingTtsSpeed.addEventListener('input', () => {
        elements.ttsSpeedLabel.textContent = parseFloat(elements.settingTtsSpeed.value).toFixed(1) + 'x';
        updateSliderFill(elements.settingTtsSpeed);
    });
    elements.settingTtsVolume.addEventListener('input', () => {
        elements.ttsVolumeLabel.textContent = Math.round(parseFloat(elements.settingTtsVolume.value) * 100) + '%';
        updateSliderFill(elements.settingTtsVolume);
    });
    document.getElementById('previewPromptBtn').addEventListener('click', previewPrompt);
    document.getElementById('resetCharacterBtn').addEventListener('click', resetCharacterCard);
// 多人设：切换 / 新建 / 复制 / 改名 / 删除
document.getElementById('ccPresetSelect')?.addEventListener('change', (e) => switchCard(e.target.value));
document.getElementById('ccPresetNew')?.addEventListener('click', () => { void addCard(false); });
document.getElementById('ccPresetDup')?.addEventListener('click', () => { void addCard(true); });
document.getElementById('ccPresetRename')?.addEventListener('click', () => { void renameCard(); });
document.getElementById('ccPresetDelete')?.addEventListener('click', () => { void deleteCard(); });

    elements.newConversationBtn.addEventListener('click', () => {
        createConversation(state.activeCategoryId);
        closeSidebarDrawer();
    });
    elements.newCategoryBtn.addEventListener('click', () => {
        promptCreateCategory();
    });

    elements.initialTextInput.addEventListener('input', updateComposerSendVisibility);
    elements.textInput.addEventListener('input', updateComposerSendVisibility);
    [elements.initialTextInput, elements.textInput].forEach(input => {
        input.addEventListener('focus', () => keepFocusedComposerVisible(input));
    });
    elements.initialComposerMoreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleComposerToolsMenu(elements.initialComposerMoreBtn, elements.initialComposerMoreMenu);
    });
    elements.composerMoreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleComposerToolsMenu(elements.composerMoreBtn, elements.composerMoreMenu);
    });
    elements.initialComposerImageBtn.addEventListener('click', openComposerImagePicker);
    elements.composerImageBtn.addEventListener('click', openComposerImagePicker);
    elements.composerImageInput.addEventListener('change', async () => {
        const file = elements.composerImageInput.files?.[0];
        if (!file) return;
        composerImageProcessing = true;
        elements.initialComposerImageBtn.disabled = true;
        elements.composerImageBtn.disabled = true;
        updateComposerSendVisibility();
        try {
            pendingComposerImage = await compressComposerImage(file);
            renderPendingComposerImage();
        } catch (error) {
            removePendingComposerImage();
            showCustomAlert(error?.message || '图片处理失败，请更换一张图片。', '无法添加图片');
        } finally {
            composerImageProcessing = false;
            elements.initialComposerImageBtn.disabled = false;
            elements.composerImageBtn.disabled = false;
            updateComposerSendVisibility();
        }
    });
    // 思考开关与强度：现在住在「设置 → 模型」里，不在输入框的 ⊕ 菜单里。
    // 直接写进 state 并持久化 —— 这两个是**模型参数**，改了立刻对下一次请求生效，
    // 不需要点「保存设置」才生效（用户不会想到"改个开关还要再点保存"）。
    elements.settingThinkingMode.addEventListener('change', () => {
        state.settings.thinkingMode = elements.settingThinkingMode.checked;
        updateThinkingModeHint();
        persistSettings();
    });
    elements.settingThinkingEffort.addEventListener('change', () => {
        state.settings.thinkingEffort = THINKING_EFFORTS.includes(elements.settingThinkingEffort.value)
            ? elements.settingThinkingEffort.value
            : 'medium';
        updateThinkingModeHint();
        persistSettings();
    });
    // 第三人称（两段式生成）：与思考开关同属「对话优化」块，同样是"改了立刻生效 + 持久化"。
    elements.settingThirdPerson.addEventListener('change', () => {
        state.settings.thirdPerson = elements.settingThirdPerson.checked;
        persistSettings();
    });
    elements.initialComposerMemoryBtn.addEventListener('click', runManualMemorySummary);
    elements.composerMemoryBtn.addEventListener('click', runManualMemorySummary);
    elements.composerPromptBtn.addEventListener('click', openConversationPromptEditor);
    elements.initialComposerPromptBtn.addEventListener('click', openConversationPromptEditor);
    elements.conversationPromptCancelBtn.addEventListener('click', closeConversationPromptEditor);
    elements.conversationPromptSaveBtn.addEventListener('click', saveConversationPrompt);
    elements.conversationWorldInput.addEventListener('input', updateConversationPromptCount);
    elements.conversationCharacterInput.addEventListener('input', updateConversationPromptCount);
    elements.conversationPromptOverlay.addEventListener('click', (event) => {
        if (event.target === elements.conversationPromptOverlay) closeConversationPromptEditor();
    });
    document.addEventListener('click', (event) => {
        const anyMenuOpen = !elements.initialComposerMoreMenu.classList.contains('hidden') || !elements.composerMoreMenu.classList.contains('hidden');
        if (anyMenuOpen && !event.target.closest('.composer-tools')) {
            closeComposerToolsMenu();
        }
    });

    elements.sidebarSearchInput.addEventListener('input', renderFolderList);
    elements.sidebarSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && elements.sidebarSearchInput.value) {
            elements.sidebarSearchInput.value = '';
            renderFolderList();
        }
    });
    elements.sidebarSearchClear.addEventListener('click', () => {
        elements.sidebarSearchInput.value = '';
        elements.sidebarSearchClear.classList.add('hidden');
        renderFolderList();
        elements.sidebarSearchInput.focus();
    });
    elements.sidebarSearchInput.addEventListener('input', () => {
        elements.sidebarSearchClear.classList.toggle('hidden', !elements.sidebarSearchInput.value);
    });

    elements.railChatBtn.addEventListener('click', () => {
        if (state.notesMode) exitNotesMode();
        else if (state.diaryMode) exitDiaryMode();
        else syncRailActive();
    });
    elements.notesBtn.addEventListener('click', () => {
        if (state.notesMode) {
            exitNotesMode();
        } else {
            enterNotesMode();
        }
    });
    elements.railDiaryBtn.addEventListener('click', () => {
        if (state.diaryMode) exitDiaryMode();
        else enterDiaryMode();
    });
    elements.exitDiaryBtn.addEventListener('click', exitDiaryMode);

    // 日志现在是「设置」里的一个**独立分栏**（#tab-log），
    // 由 switchSettingsTab() 在切栏时调用 window.LogViewer.open() / close()。
    // ★ 这里原先绑的 #openLogPageBtn 与 #exitLogBtn 已随"独立全屏页"方案一起删除 ——
    //   那两个元素不存在了（分栏不需要"打开/返回"按钮）。
    elements.exitNotesBtn.addEventListener('click', () => {
        if (state.notesMode) exitNotesMode();
    });
    elements.notesSearch.addEventListener('input', (e) => renderNotesPage(e.target.value));

    document.querySelectorAll('.notes-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            state.notesTab = btn.dataset.tab;
            document.querySelectorAll('.notes-tab').forEach(b => {
                const active = b === btn;
                b.classList.toggle('tab-active', active);
                b.classList.toggle('text-indigo-500', !active);
                b.classList.toggle('bg-white/40', !active);
                b.classList.toggle('border', !active);
                b.classList.toggle('border-white/55', !active);
            });
            renderNotesPage(elements.notesSearch.value);
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeComposerToolsMenu();
        if (e.key === 'Escape' && state.selectedFavoriteId) {
            collapseFavorite();
        }
    });

    elements.detailClose.addEventListener('click', collapseFavorite);
    elements.notesOverlay.addEventListener('click', (e) => {
        if (e.target === elements.notesOverlay) collapseFavorite();
    });
    elements.detailRemoveBtn.addEventListener('click', () => {
        if (state.selectedFavoriteId) {
            removeFavoriteWithConfirm(state.selectedFavoriteId);
        }
    });
    elements.detailJumpBtn.addEventListener('click', () => {
        const fav = state.favorites.find(f => f.id === state.selectedFavoriteId);
        if (fav) jumpToOriginal(fav);
    });

    elements.manageCategoriesBtn.addEventListener('click', () => {
        openCategoriesModal();
    });
    elements.memoryBtn.addEventListener('click', runManualMemorySummary);
    elements.categoriesModalClose.addEventListener('click', closeCategoriesModal);
    elements.categoriesModalOverlay.addEventListener('click', (e) => {
        if (e.target === elements.categoriesModalOverlay) closeCategoriesModal();
    });
    elements.categoriesModalNew.addEventListener('click', async () => {
        await promptCreateCategory();
        renderCategoriesModalList();
    });
    elements.catSelectAllBtn.addEventListener('click', () => {
        const visible = [...elements.categoriesModalList.querySelectorAll('.cat-checkbox')];
        const allChecked = visible.every(cb => cb.checked);
        visible.forEach(cb => cb.checked = !allChecked);
        if (allChecked) {
            visible.forEach(cb => catSelected.delete(cb.dataset.convId));
        } else {
            visible.forEach(cb => catSelected.add(cb.dataset.convId));
        }
        renderCategoriesModalList();
        renderCatBatchBar();
    });
    elements.catInvertBtn.addEventListener('click', () => {
        const visible = [...elements.categoriesModalList.querySelectorAll('.cat-checkbox')];
        visible.forEach(cb => {
            if (cb.checked) catSelected.delete(cb.dataset.convId);
            else catSelected.add(cb.dataset.convId);
        });
        renderCategoriesModalList();
        renderCatBatchBar();
    });
    elements.catMoveSelect.addEventListener('change', catMoveSelected);
    elements.catDeleteSelectedBtn.addEventListener('click', catDeleteSelected);
    elements.conversationMoveClose.addEventListener('click', closeConversationMoveDialog);
    elements.conversationMoveCancel.addEventListener('click', closeConversationMoveDialog);
    elements.conversationMoveOverlay.addEventListener('click', (e) => {
        if (e.target === elements.conversationMoveOverlay) closeConversationMoveDialog();
    });

    document.getElementById('quoteLikeBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleQuoteLike();
    });
    document.getElementById('quoteFavBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleQuoteFavorite();
    });

    elements.showSidebar.addEventListener('click', showSidebarFunc);
    elements.mobileSidebarClose.addEventListener('click', closeSidebarDrawer);
    elements.sidebarOverlay.addEventListener('click', closeSidebarDrawer);
    elements.folderList.addEventListener('scroll', closeConversationContextMenu, { passive: true });
    window.addEventListener('resize', () => {
        syncViewportHeight();
        closeConversationContextMenu();
        requestAnimationFrame(alignFloatingMicToComposer);
    });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', syncViewportHeight);
        window.visualViewport.addEventListener('scroll', syncViewportHeight);
    }
    document.addEventListener('pointerdown', (e) => {
        if (!conversationContextMenu || conversationContextMenu.contains(e.target)) return;
        closeConversationContextMenu();
    });
    document.addEventListener('click', (e) => {
        if (window.innerWidth > 860 || !document.body.classList.contains('sidebar-open')) return;
        if (elements.sidebar.contains(e.target) || elements.showSidebar.contains(e.target)) return;
        closeSidebarDrawer();
    });
    elements.sidebar.addEventListener('click', (e) => {
        if (window.innerWidth > 860) return;
        if (e.target.closest('[data-conv-id], [data-rail-action]')) {
            closeSidebarDrawer();
        }
    });

    updateNotesBadge();
    const mobileFirstScreen = window.matchMedia('(max-width: 860px)').matches;
    if (mobileFirstScreen) {
        // 移动端每次进入先落在新对话欢迎页，不直接恢复上次聊天内容。
        state.currentConversationId = null;
    }
    renderFolderList();

    if (mobileFirstScreen) {
        showInitialState();
        loadAnnouncement().then(openAnnouncement);
        return;
    }
    const hasConversation = Boolean(state.currentConversationId);
    if (hasConversation) {
        const conv = state.conversations.find(c => c.id === state.currentConversationId);
        if (conv && conv.messages.length > 0) {
            loadConversation(conv.id);
        }
    }
    loadAnnouncement().then(openAnnouncement);
    // 启动 AI 定时任务调度（每 30s 检查到期任务）
    setInterval(checkScheduledTasks, 30000);
}

function showSidebarFunc() {
    if (window.innerWidth <= 860) {
        elements.initialState.classList.add('sidebar-underlay-hidden');
        elements.floatingMic.classList.add('sidebar-underlay-hidden');
    }
    document.body.classList.add('sidebar-open');
    elements.sidebarOverlay.classList.remove('hidden');
}

function syncViewportHeight() {
    const viewport = window.visualViewport;
    const viewportHeight = viewport?.height || window.innerHeight;
    const viewportTop = window.innerWidth <= 860 ? Math.max(0, viewport?.offsetTop || 0) : 0;
    if (viewportHeight) document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
    document.documentElement.style.setProperty('--viewport-offset-top', `${Math.round(viewportTop)}px`);
}

function keepFocusedComposerVisible(input) {
    if (!input || window.innerWidth > 860) return;
    const align = () => {
        if (document.activeElement !== input) return;
        syncViewportHeight();
        input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (input === elements.textInput && elements.conversationHistory) {
            elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
        }
    };
    requestAnimationFrame(align);
    setTimeout(align, 180);
    setTimeout(align, 360);
}

function closeSidebarDrawer() {
    if (window.innerWidth > 860) return;
    closeConversationContextMenu();
    document.body.classList.remove('sidebar-open');
    elements.sidebarOverlay.classList.add('hidden');
    elements.initialState.classList.remove('sidebar-underlay-hidden');
    elements.floatingMic.classList.remove('sidebar-underlay-hidden');
}



// ===== 设置分栏 Tab 切换 =====
function switchSettingsTab(name) {
    document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.settingsTab === name));
    document.querySelectorAll('.settings-tab-panel').forEach(p => p.classList.toggle('active-panel', p.id === name));
    // ★ 让选中的分栏**滚进可视区**（手机必需）。
    //
    //   手机上 9 个分栏放不下，导航是横向滚动的：靠后的「日志」「插件」初始时
    //   在屏幕外。如果用户是通过别的方式切过去的（程序化切栏、恢复上次分栏、
    //   插件注册的新分栏），导航还停在最左边 —— 看起来像"没有选中任何分栏"。
    //   点击切换时浏览器会自动滚（:focus），但**程序化切换不会**，所以这里显式做。
    //   behavior:'smooth' 在部分旧 WebView 上不支持 → 用 try 兜底成瞬时滚动。
    try {
        const nav = document.getElementById('settingsTabNav');
        const btn = nav && nav.querySelector(`.settings-tab-btn[data-settings-tab="${name}"]`);
        if (btn && typeof btn.scrollIntoView === 'function') {
            btn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        }
    } catch (e) {
        try {
            const nav = document.getElementById('settingsTabNav');
            const btn = nav && nav.querySelector(`.settings-tab-btn[data-settings-tab="${name}"]`);
            if (btn) btn.scrollIntoView();
        } catch (e2) { /* 滚不动也不影响切栏本身 */ }
    }
    // ★ 日志分栏：进来时开始拉取与轮询，离开时停掉。
    //   为什么必须停：它每 2 秒打一次 /api/logs/tail，不停的话"停在别的分栏"
    //   也在拉；而服务端若把它记进日志就是自噪音（log-buffer.mjs 的注释里有来龙去脉）。
    try {
        if (window.LogViewer) {
            if (name === 'tab-log') window.LogViewer.open();
            else window.LogViewer.close();
        }
    } catch (e) { /* 日志模块出问题不该影响切栏 */ }
    // 通知插件：某个分栏被显示了。
    // 为什么要广播：插件分栏的 render(container) 是**延迟调用**的 ——
    // 挂载时只建空壳，真被点开才渲染，没打开过的分栏不白做初始化。
    try {
        document.dispatchEvent(new CustomEvent('elaina:settings-tab', { detail: { name } }));
    } catch (e) { /* 环境不支持 CustomEvent 也不该影响切栏 */ }
}

// ★ 点击走**事件委托**，而不是"查一遍现有按钮再逐个绑"。
//
//   为什么必须这样（这是插件分栏能不能用的关键）：插件分栏的按钮是页面加载
//   **之后**才由 mods.js 插进来的（要等 /mods/index.json 拉回来再逐个注册）。
//   逐按钮绑定的写法对它们完全无效 —— 表现是"插件分栏出现了，点了没反应"，
//   而且刷新也未必复现（取决于清单回来的快慢），属于最难查的一类。
//   委托给容器就没有这个问题：此后无论何时插入按钮，点击都有人管。
(function bindSettingsTabNav() {
    const nav = document.getElementById('settingsTabNav');
    if (!nav) return;
    nav.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('.settings-tab-btn') : null;
        if (btn && nav.contains(btn)) switchSettingsTab(btn.dataset.settingsTab);
    });
})();

// ===== 宿主插槽已移到 web/js/host-slots.js =====
// 全部插槽（settings.tabs / header.actions / sidebar.footer / composer.actions /
// chat.message.actions）集中在那一个文件里 —— 那是插件作者唯一需要看的契约面。
// 本文件只负责分栏**行为**（切换函数与事件委托），不负责挖插槽。


// ===== Live2D 设置逻辑已搬进 web/mods/live2d/settings-panel.js =====
// 模型列表 / 上传 / 重命名 / 删除 / 背景 / 鼠标跟随都随插件走，
// 由 settings.tabs 插槽在被点开时渲染（见那个插件的 register）。

// ============================================================================
//  设置下拉：自绘弹出面板（★ 2026-10）
//
//  用户要求"改下拉"：把原生 <select> 的**弹出面板**换成主题化列表，
//  对齐「模型名」组合框。原生面板由系统绘制、CSS 选不中它，只能自己弹一个。
//
//  ── 与既有代码的关系（不动取值逻辑）─────────────────────────────────────
//  `select` 元素**原样保留**（它仍是取值来源、仍显示当前值），既有 `change`
//  监听器也不动 —— 只是拦截它的 `mousedown` 阻止原生面板，改弹自绘列表；
//  用户点选项时写回 `select.value` 并派发冒泡的 `change`，
//  所以 `settingApiFormat` 等既有处理逻辑照常触发。
// ============================================================================
let cselectPanel = null;
let cselectOwner = null;

function closeCselect() {
    if (cselectPanel) { cselectPanel.remove(); cselectPanel = null; }
    if (cselectOwner) { cselectOwner.classList.remove('cselect-open'); cselectOwner = null; }
}

function openCselect(select) {
    closeCselect();
    const rect = select.getBoundingClientRect();
    const panel = document.createElement('div');
    panel.className = 'cselect-panel';
    panel.setAttribute('role', 'listbox');
    panel.style.left = rect.left + 'px';
    panel.style.width = rect.width + 'px';
    let any = false;
    Array.prototype.forEach.call(select.options, (opt) => {
        if (opt.hidden || opt.disabled) return;
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'model-combo-item';
        item.setAttribute('role', 'option');
        item.textContent = opt.textContent;
        if (opt.value === select.value) item.classList.add('is-current');
        item.addEventListener('click', () => {
            if (select.value !== opt.value) {
                select.value = opt.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
            closeCselect();
        });
        panel.appendChild(item);
        any = true;
    });
    if (!any) {
        const empty = document.createElement('div');
        empty.className = 'model-combo-empty';
        empty.textContent = '没有可选项目';
        panel.appendChild(empty);
    }
    document.body.appendChild(panel);
    // 默认贴在 select 下沿；下方空间不够就翻到上沿
    const h = panel.offsetHeight;
    if (rect.bottom + h > window.innerHeight - 8 && rect.top - h > 8) {
        panel.classList.add('cselect-panel--up');
        panel.style.top = (rect.top - h) + 'px';
    } else {
        panel.style.top = rect.bottom + 'px';
    }
    select.classList.add('cselect-open');
    cselectPanel = panel;
    cselectOwner = select;
}

function initSettingsDropdowns() {
    document.querySelectorAll('#settingsPanel select.modal-input, #settingsPanel select.log-select').forEach((select) => {
        if (select.dataset.cselect) return;
        select.dataset.cselect = '1';
        select.addEventListener('mousedown', (ev) => {
            // 阻止原生面板（Chromium 上 mousedown 的 preventDefault 即可拦住）
            ev.preventDefault();
            if (cselectOwner === select) closeCselect();
            else openCselect(select);
        });
        select.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') closeCselect();
        });
    });
}

// 点击别处 / Esc / 滚动 / 缩放都收起面板
document.addEventListener('mousedown', (ev) => {
    if (!cselectPanel) return;
    const t = ev.target;
    if (t && t.closest && (t.closest('select') || cselectPanel.contains(t))) return;
    closeCselect();
}, true);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeCselect(); });
window.addEventListener('resize', closeCselect);
window.addEventListener('scroll', closeCselect, true);

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}