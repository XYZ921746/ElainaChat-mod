/* ========================================================================
 * 初始化与绑定：启动流程 / 分栏 / Live2D 设置
 * ======================================================================== */

// ==================== 初始化====================

/**
 * 行内提示元素（#modsHint / #skillsHint 等）的文案与配色写入。
 *
 * 这类提示分散在好几个上传/浏览流程里，样式串必须保持一致；集中一处，
 * 免得某一处单独变了颜色或字号。元素可能不存在（布局裁剪），此时静默跳过。
 */
function setHintText(el, text, cls) {
    if (el) { el.textContent = text; el.className = 'text-[11px] ' + (cls || 'text-indigo-500'); }
}

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
                // 用户资料（称呼/头像/AI 印象）：别改的设备也要跟着变；名称变了消息行的称呼才对
                if (has('elaina_user_profile') && typeof loadUserProfile === 'function') loadUserProfile();
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

// ===== 把扩展子项挪出滚动容器（**仅窄屏**） =====
//   #settingsTabNav 与 #settingsTopBar 都是 overflow:auto（横向滚动），
//   窄屏下绝对定位的子项落在里面会被裁掉；而放开它们的 overflow 会让滚动失效
//   （用户报过"展开后别的地方拖不动"）。
//   所以窄屏把子项挂到 #settingsPanel —— 它是弹窗本体，overflow:hidden 是圆角
//   必需、不能改，而子项完全落在弹窗内部，不会越过它。
//   ⚠️ **只在窄屏挪**。宽屏（≥981px）导航是左侧竖排一列，子项本来就缩进在
//   「扩展」下面、不受任何 overflow 影响；一并挪走会让它们脱离导航列，
//   桌面版直接消失（实测：display:none、宽高 0）。
const EXT_FLOAT_MQ = '(max-width: 980px)';
function syncExtMenuParent() {
    const menu = document.querySelector('.ext-nav-children');
    const group = document.getElementById('settingsExtNav');
    const panel = document.getElementById('settingsPanel');
    if (!menu || !group || !panel) return;
    const wantFloat = window.matchMedia(EXT_FLOAT_MQ).matches;
    if (wantFloat && menu.parentElement !== panel) {
        menu.classList.add('ext-menu-floating');
        panel.appendChild(menu);
    } else if (!wantFloat && menu.parentElement !== group) {
        menu.classList.remove('ext-menu-floating', 'is-open', 'is-closing');
        group.appendChild(menu);
    }
}

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
async function init() {
    syncViewportHeight();
    // 先把 data/ 里的数据读进内存缓存 —— **必须在任何读取之前**。
    //   Web：内部是同步 XHR，这一步实际上立即完成（零闪烁，与旧行为一致）。
    //   APK：Capacitor Filesystem 是异步的，这里 await 一次读完。
    //   两条路都不让业务代码写平台判断 —— 差异全在 store.js 里。
    await Store.bootstrap();
    // 主题在脚本求值阶段就应用过一次（那时缓存还可能是空的），
    // 这里读完真实数据后重刷一次 —— APK 上尤其必要，否则会停在默认主题。
    try { if (window.ElainaTheme) window.ElainaTheme.applyStored(); } catch (e) { /* 忽略 */ }
    loadSettings();
    await loadApiSecrets();
    // 预热「实现方式」的可用性探测。
    //   手机操作的能力注入（agentPhoneSkillText）与"运行方式"弹窗（pickPhoneRunMode）
    //   都读 backendStatus —— 那份数据只有 detectBackend / refreshBackendStatus 会写。
    //   不预热的话，用户没打开过设置面板之前它一直是空的：模型会被注入
    //   "当前未启用、不要输出手机标签"（明明设备上无障碍是可用的），
    //   运行方式弹窗也无从判断"两路是否都就绪"。
    //   这是异步的，不阻塞后面的启动步骤。
    void refreshBackendStatus();
    // 把技能（`/api/skills` 扫出来的 SKILL.md）同步进操作注册表，作为**纯知识**条目
    //   （见 agent.js 的 syncSkillKnowledge）。必须在这里做一次，而不是等用户打开设置
    //   面板：模型在提示词里要看到的是"这台机器上有哪些资料"，用户可能一次设置都没开过。
    //   异步、失败静默，不阻塞启动。
    void syncSkillKnowledge();
    // 保存失败要让用户看得见（见 store.js 的 Web 后端）：
    //   服务端已经会用 413 / 500 明确拒绝，但那是"数据还在内存、没落盘"——
    //   不提示的话，用户关掉页面的那一刻改动就真丢了。
    window.addEventListener('elaina:store-save-failed', (ev) => {
        const d = (ev && ev.detail) || {};
        if (typeof showStoreSaveAlert === 'function') showStoreSaveAlert(d);
    });
    // 把用户配置的 MCP 服务器工具注册进操作注册表（见 mcp.js）。
    //   必须**在第一次组装工具清单之前**做一次，否则第一轮对话看不到这些工具 ——
    //   而"刚配好就说话"是最常见的路径。异步、失败静默：一个 MCP 服务器起不来
    //   不该拖住整个启动（它的状态会显示在设置的 MCP 栏里）。
    if (window.ElainaMcp && typeof window.ElainaMcp.registerMcpOps === 'function') {
        void window.ElainaMcp.registerMcpOps();
    }
    loadCharacterCard();
    loadConversations();
    loadFavorites();
    loadLikedQuotes();
    loadMemoryCore();
    loadUserProfile();
    // 成就系统与「星屑之日」生日模式：必须排在 `Store.bootstrap()` **之后**
    //   才 refresh（见它们各自的 ready 闸门说明）。
    //   为什么不能靠脚本自己"在加载时就读"：那两个模块的脚本在 bootstrap
    //   之前就求值了，那时 Store 缓存是空的 —— 读到的成就表必然是空的、
    //   生日状态必然丢失。后果分别是"每次刷新成就都像没解锁过"与
    //   "每次刷新都把开场彩蛋重演一遍"。
    //   生日模式住在 birthday 插件里，宿主不在这里 refresh ——
    //     它收到 `app-ready` 广播后自己读盘并启动看门狗。
    try { if (window.ElainaAchievements) window.ElainaAchievements.refresh(); } catch (e) { /* 忽略 */ }
    // 多设备实时同步：订阅服务端的 store 变更广播（SSE）。
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

    bindAppEvents();

    updateNotesBadge();
    const mobileFirstScreen = window.matchMedia('(max-width: 980px)').matches;
    if (mobileFirstScreen) {
        // 移动端每次进入先落在新对话欢迎页，不直接恢复上次聊天内容。
        state.currentConversationId = null;
    }
    renderFolderList();

    if (mobileFirstScreen) {
        showInitialState();
        const announcementPending = openAnnouncementDeferred();
        startAnnouncements();
        // 移动端这条路径提前 return —— 也要发 app-ready，否则插件永远等不到启动信号
        try { window.ElainaMods?.markAppReady?.({ announcementPending }); } catch (e) { /* 忽略 */ }
        return;
    }
    const hasConversation = Boolean(state.currentConversationId);
    if (hasConversation) {
        const conv = state.conversations.find(c => c.id === state.currentConversationId);
        if (conv && conv.messages.length > 0) {
            loadConversation(conv.id);
        }
    }
    const announcementPending = openAnnouncementDeferred();
    // 公告：拉一次并刷新顶栏「每日金句 / 公告」合体胶囊（见 data.js）
    startAnnouncements();
    // 启动 AI 定时任务调度（每 30s 检查到期任务）
    setInterval(checkScheduledTasks, 30000);
    // 通知插件系统：应用初始化完成（Store.bootstrap 已读完、界面已就绪）。
    //   mod 在 DOMContentLoaded 就加载（早于本函数），拿不到这个信号就只能自己
    //   猜时机 —— 这正是"插件在加载时读 Store 拿到空缓存"的成因。
    //   `announcementPending` 一并带过去：晚注册的生日插件要据此把开场彩蛋推迟到
    //   首次公告之后（见 mods.js 的 host.on 补调与上面的 openAnnouncementDeferred）。
    try { window.ElainaMods?.markAppReady?.({ announcementPending }); } catch (e) { /* 插件系统异常不影响启动 */ }
}

/**
 * 打开「欢迎使用独立开源版」公告。
 *
 * 这里**不等生日彩蛋**：宿主一旦直接引用生日模块，插件缺失时宿主就报错
 *   （见 AGENTS.md D3）。所以改成**广播**，宿主不知道生日插件的存在：
 *     ① 本函数先广播 `announcement-pending`（"公告将要出现"）；
 *     ② 生日插件收到后把开场彩蛋**推迟**，等 `announcement-closed` 再演
 *        （关闭广播在 data.js 的 closeAnnouncement 里发）。
 *   这样两个弹层依旧不会打架，而宿主完全不知道生日插件的存在。
 *
 * 公告仍然**只在第一次弹**（用户要求："同意后即消失，后面都不再出现"）。
 *
 * @returns {boolean} 本次是否"将要弹公告"。调用方把它转给 markAppReady ——
 *   晚注册的插件（loadAll 是异步的）也要能知道这件事，见 mods.js 的 host.on 补调。
 */


if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
