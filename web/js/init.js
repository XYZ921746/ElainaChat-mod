// 初始化与绑定：启动流程 / 分栏 / Live2D 设置。

// 行内提示元素（#modsHint / #skillsHint 等）的文案与配色写入。样式串必须跨流程保持一致；元素不存在时静默跳过。
function setHintText(el, text, cls) {
    if (el) { el.textContent = text; el.className = 'text-[11px] ' + (cls || 'text-dim'); }
}

// 多设备实时同步：订阅服务端 store 变更广播（SSE），按类型重渲染 —— 聊天记录重载会话列表（保留滚动位置与当前选中会话）、人设卡 / 记忆 / 收藏 / 定时任务重载对应 state、设置只更新内存值、主题立即应用、插件开关重载列表；任何一步出错只记日志，绝不影响本地使用。
function startMultiDeviceSync() {
    if (!window.Store || typeof window.Store.subscribeRemote !== 'function') return;
    try {
        window.Store.subscribeRemote((keys) => {
            const has = (k) => keys.indexOf(k) >= 0;
            try {
                if (has('elaina_open_conversations') || has('elaina_open_categories')) {
                    const keepId = state.currentConversationId;
                    loadConversations();
                    // 保持当前选中的会话：不能因为别人改了别的会话就把用户从正在看的对话里踢走。
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
                // 用户资料（称呼/头像/AI 印象）：名称变了消息行的称呼才对，其它设备也要跟着变。
                if (has('elaina_user_profile') && typeof loadUserProfile === 'function') loadUserProfile();
                if (has('elaina_open_tasks') && typeof renderScheduledTaskList === 'function') renderScheduledTaskList();
                if (has('elaina_open_settings')) loadSettings();
                if ((has('elaina_theme_template') || has('elaina_theme') || has('elaina_theme_custom'))
                    && window.ElainaTheme && typeof window.ElainaTheme.applyStored === 'function') {
                    window.ElainaTheme.applyStored();
                }
                if ((has('elaina_rd_bubble') || has('elaina_rd_texture'))
                    && window.ElainaRdVisual && typeof window.ElainaRdVisual.apply === 'function') {
                    window.ElainaRdVisual.apply();
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

// 把扩展子项挪出滚动容器（仅窄屏）：#settingsTabNav 与 #settingsTopBar 的 overflow:auto 在窄屏会裁掉绝对定位的子项，而放开 overflow 会让滚动失效，故挂到 overflow:hidden 的 #settingsPanel；宽屏导航是左侧竖排一列、不受影响。
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

// 模型列表接口的地址：OpenAI 系 Base URL 惯例带 /v1，故直接拼 /models；Anthropic 惯例不带，而它的 Models API 在 /v1/models，直接拼会 404。这条规则必须与 chat-providers.js 里 callAnthropicChat 拼 /messages 的规则一致，否则会出现"对话能通、获取模型 404"。
async function init() {
    syncViewportHeight();
    // 先把 data/ 里的数据读进内存缓存（必须在任何读取之前）：Web 用同步 XHR、APK 用异步 Filesystem，这里 await 一次读完；两条路都不让业务代码写平台判断，差异全在 store.js 里。
    await Store.bootstrap();
    // 首帧外观由 index.html 的内联脚本按启动快照回放；这里读完真实数据后再校准一次并更新快照（首次访问无快照、APK 上尤其必要）。
    try { if (window.ElainaTheme) window.ElainaTheme.applyStored(); } catch (e) { /* 忽略 */ }
    // 气泡/光晕偏好的处境与主题相同：求值阶段读到的可能是空缓存，这里必须重放。
    try { if (window.ElainaRdVisual) window.ElainaRdVisual.apply(); } catch (e) { /* 忽略 */ }
    loadSettings();
    await loadApiSecrets();
    // 预热「实现方式」的可用性探测：手机操作的能力注入与"运行方式"弹窗都读 backendStatus，而它只有 detectBackend / refreshBackendStatus 会写；不预热的话，用户打开设置面板前模型会收到"当前未启用"。异步、不阻塞启动。
    void refreshBackendStatus();
    // 把技能（/api/skills 扫出的 SKILL.md）同步进操作注册表作纯知识条目；必须在这里做一次而非等打开设置面板，模型在提示词里要看到"这台机器上有哪些资料"。异步、失败静默。
    void syncSkillKnowledge();
    // 保存失败要让用户看得见（见 store.js 的 Web 后端）：服务端虽会明确拒绝，但那是"数据还在内存、没落盘"，不提示的话用户关掉页面改动就真丢了。
    window.addEventListener('elaina:store-save-failed', (ev) => {
        const d = (ev && ev.detail) || {};
        if (typeof showStoreSaveAlert === 'function') showStoreSaveAlert(d);
    });
    // 把用户配置的 MCP 服务器工具注册进操作注册表：必须在第一次组装工具清单之前做，否则第一轮对话看不到它们，而"刚配好就说话"是最常见路径。异步、失败静默。
    if (window.ElainaMcp && typeof window.ElainaMcp.registerMcpOps === 'function') {
        void window.ElainaMcp.registerMcpOps();
    }
    loadCharacterCard();
    loadConversations();
    loadFavorites();
    loadMemoryCore();
    loadUserProfile();
    // 成就系统与「星屑之日」生日模式：必须排在 Store.bootstrap() 之后 refresh（见 ready 闸门）—— 其脚本在 bootstrap 之前求值，那时 Store 缓存为空，读到的成就表必空、生日状态必丢；生日模式住在 birthday 插件里，收到 app-ready 广播后自己读盘并启动看门狗。
    try { if (window.ElainaAchievements) window.ElainaAchievements.refresh(); } catch (e) { /* 忽略 */ }
    // 多设备实时同步。只在 Web 生效：APK 没有服务端，单设备不存在"别的设备改了"。
    startMultiDeviceSync();
    elements.textInput.value = '';
    document.getElementById('initialTextInput').value = '';
    elements.sidebarSearchInput.value = '';
    elements.notesSearch.value = '';
    syncThinkingModeControls();
    updateComposerSendVisibility();

    loadDailyQuote();

    startGreetingTyping();

    bindAppEvents();

    updateNotesBadge();
    // 首屏走哪套按设备本身（IS_MOBILE_DEVICE）而不是打开时的窗口宽度：设备属性不随窗口变，电脑把窗口拖窄仍是电脑；
    // 宽度只决定外壳形态（CSS @media 实时响应），不决定这是哪类设备 —— 与 auth.js / download.js 的取用同一原则。
    if (IS_MOBILE_DEVICE) {
        // 移动端每次进入先落在新对话欢迎页，不直接恢复上次聊天内容。
        state.currentConversationId = null;
    }
    renderFolderList();

    if (IS_MOBILE_DEVICE) {
        showInitialState();
        const announcementPending = openAnnouncementDeferred();
        startAnnouncements();
        // 提前 return 不能漏掉与电脑路径共用的启动收尾：定时任务轮询（漏了手机的定时任务永不触发）与 app-ready（漏了插件永远等不到启动信号）。
        setInterval(checkScheduledTasks, 30000);
        try { window.ElainaMods?.markAppReady?.({ announcementPending }); } catch (e) { /* 插件系统异常不影响启动 */ }
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
    startAnnouncements();
    setInterval(checkScheduledTasks, 30000);
    // 通知插件系统：应用初始化完成（Store 已读完、界面已就绪）。mod 在 DOMContentLoaded 就加载、早于本函数，拿不到信号就只能自己猜时机；announcementPending 一并带过去，晚注册的生日插件据此把开场彩蛋推迟到首次公告之后。
    try { window.ElainaMods?.markAppReady?.({ announcementPending }); } catch (e) { /* 插件系统异常不影响启动 */ }
}

// 公告与生日彩蛋的先后经广播协调（announcement-pending / announcement-closed），宿主不直接引用生日插件（AGENTS.md D3）。
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
