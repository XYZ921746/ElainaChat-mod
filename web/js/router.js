/* 路径路由：每个顶层页面一个真实 URL，刷新 / 前进 / 后退都停在该页面。
 *
 * 这里不改页面本身，只做「URL ↔ 现有入口函数」的翻译：
 *   /chat/  /notes/  /memory/  /diary/  /settings/[分栏]/  /achievements/  /store/
 * 带 /web 前缀进入时（/web/store/ 这类地址）整段会话都保留该前缀，后续链接不会掉回根路径。
 *
 * 入口函数仍是唯一实现（enterNotesMode / openSettings / ElainaMarket.open …），
 * 本文件只在它们执行完后同步 URL；浏览器历史变化时反向调用同一批函数。
 * 页面自身没有 URL 概念，所以包装必须按「最外层调用」记账：enterNotesMode 内部会调
 * setRailActive 顺带关闭成就，那一次关闭不是用户导航，不能改写历史。
 */
(function () {
    'use strict';

    var BRAND = 'ElainaChat Mod';

    var PAGES = {
        chat: { slug: 'chat/', title: '对话' },
        notes: { slug: 'notes/', title: '语笺' },
        memory: { slug: 'memory/', title: '记忆' },
        diary: { slug: 'diary/', title: '旅行日记' },
        settings: { slug: 'settings/', title: '设置' },
        achievements: { slug: 'achievements/', title: '成就' },
        store: { slug: 'store/', title: '插件市场' }
    };

    // 设置分栏与 URL 段的对应。分栏按钮的数据源是 data-settings-tab，两边必须同口径。
    var SETTINGS_SLUGS = {
        'tab-appearance': 'appearance',
        'tab-character': 'character',
        'tab-model': 'model',
        'tab-capability': 'capability',
        'tab-timers': 'timers',
        'tab-mods': 'mods',
        'tab-advanced': 'advanced',
        'tab-log': 'log'
    };
    var SETTINGS_TITLES = {
        'tab-appearance': '外观',
        'tab-character': '角色',
        'tab-model': '模型',
        'tab-capability': '能力',
        'tab-timers': '定时任务',
        'tab-mods': '扩展',
        'tab-advanced': '高级设置',
        'tab-log': '日志'
    };
    var SLUG_TO_TAB = {};
    Object.keys(SETTINGS_SLUGS).forEach(function (tabId) {
        SLUG_TO_TAB[SETTINGS_SLUGS[tabId]] = tabId;
    });

    // 从 /web/... 进入时保留前缀：应用本身挂在根路径，但用户可能把 /web 当作站点子目录。
    // 只认整段 /web（或 /web/…），避免把 /webstore/ 这类路径误当别名。
    var PREFIX = /^\/web(?:\/|$)/.test(location.pathname) ? '/web' : '';

    var started = false;     // applyInitial 之前，启动流程里的页面切换不该写历史
    var silentDepth = 0;     // 包装函数的嵌套深度：只有最外层那次调用才同步 URL
    var applying = false;    // 正在按 URL 打开页面，期间所有回写都要静默

    var raw = {};

    function byId(id) { return document.getElementById(id); }

    /** 浮层「开着」的判据与 mobile-shell 一致：退场淡出期间算已关，否则关掉后紧接着的切页会把退场动画再启动一次。 */
    function overlayOpen(id) {
        var el = byId(id);
        return Boolean(el && !el.classList.contains('hidden') && !el.classList.contains('animate-overlay-out'));
    }

    function settingsOpen() { return overlayOpen('settingsOverlay'); }
    function achievementsOpen() { return overlayOpen('achievementsOverlay'); }
    function marketOpen() { return overlayOpen('marketOverlay'); }

    function stateOf() {
        try { return typeof state !== 'undefined' ? state : null; } catch (e) { return null; }
    }

    /** 解析当前 URL。查询串 / 片段不参与路由；未知路径按对话处理（服务端只对已知路径发首页）。 */
    function parsePath(pathname) {
        var p = String(pathname || '/');
        if (PREFIX) {
            if (p === PREFIX) p = '/';
            else if (p.indexOf(PREFIX + '/') === 0) p = p.slice(PREFIX.length);
        }
        var parts = p.split('/').filter(Boolean);
        if (!parts.length) return { page: 'chat', tab: '' };
        var head = parts[0];
        if (head === 'settings') {
            var tab = (parts[1] && SLUG_TO_TAB[parts[1]]) || '';
            return { page: 'settings', tab: tab };
        }
        if (head === 'chat' || head === 'notes' || head === 'memory' || head === 'diary' ||
            head === 'achievements' || head === 'store') {
            return { page: head, tab: '' };
        }
        return { page: 'chat', tab: '', unknown: true };
    }

    function pathFor(page, tab) {
        var def = PAGES[page] || PAGES.chat;
        var path = PREFIX + '/' + def.slug;
        if (page === 'settings' && tab && SETTINGS_SLUGS[tab]) {
            path += SETTINGS_SLUGS[tab] + '/';
        }
        return path;
    }

    function currentRoute() { return parsePath(location.pathname); }

    function titleFor(route) {
        if (route.page === 'settings' && route.tab) {
            return (SETTINGS_TITLES[route.tab] || '设置') + ' · 设置 · ' + BRAND;
        }
        var def = PAGES[route.page] || PAGES.chat;
        return def.title + ' · ' + BRAND;
    }

    function updateTitle(route) {
        document.title = titleFor(route);
    }

    /** 当前设置分栏的 data-settings-tab；插件分栏没有固定 slug，落到 /settings/。 */
    function currentSettingsTab() {
        var btn = document.querySelector('#settingsTabNav .settings-tab-btn.active');
        var tab = btn && btn.dataset ? btn.dataset.settingsTab : '';
        return SETTINGS_SLUGS[tab] ? tab : '';
    }

    /**
     * 把 URL 同步到刚刚打开的页面。
     * mode=push：用户主动切页；replace：同一页面内的参数变化（设置分栏）。
     * 当前路径已经是目标路径时什么都不做，避免产生重复历史条目。
     */
    function setPage(page, tab, mode) {
        if (!started || applying || silentDepth > 0) return;
        var want = pathFor(page, tab);
        if (location.pathname === want) return;
        var now = currentRoute();
        // replace 是同一页面内的参数变化（设置分栏），历史里的「上一页」没有变；
        // 必须沿用原条目的 from，否则直接打开 /settings/ 后再切分栏，关闭时会误以为
        // 还有一条站内历史而 history.back() 退出应用。
        var prevEntry = history.state;
        var from = { page: now.page, tab: now.tab || '' };
        if (mode === 'replace') {
            from = (prevEntry && prevEntry.elaina && prevEntry.elaina.from) || null;
        } else if (prevEntry && prevEntry.elaina && prevEntry.elaina.from) {
            // 浮层套浮层时把「目标页自己的返程」也带上：设置里开市场，
            // 关市场要回设置、再关设置要回进设置前的那一页，而不是直接掉回首页。
            from.from = prevEntry.elaina.from;
        }
        var entry = {
            elaina: {
                page: page,
                tab: tab || '',
                from: from
            }
        };
        try {
            if (mode === 'replace') history.replaceState(entry, '', want);
            else history.pushState(entry, '', want);
        } catch (e) {
            return;   // 没有历史 API 时页面照常切，只是地址栏不跟着变
        }
        updateTitle({ page: page, tab: tab || '' });
    }

    /** 语笺 / 记忆 / 日记 / 插件页的「返回聊天」语义是回聊天，不能拿历史栈里的上一页当目标。 */
    function goChat() {
        if (!started || applying || silentDepth > 0) return;
        if (currentRoute().page === 'chat') return;
        var want = pathFor('chat', '');
        try {
            history.pushState({ elaina: { page: 'chat', tab: '', from: null } }, '', want);
        } catch (e) { /* 地址栏改不动也要把页面切回去 */ }
        applyRoute({ page: 'chat', tab: '' });
    }

    /**
     * 退出页面模式时的地址同步要延后一拍：同一个点击里可能紧接着就要进入另一页
     * （手机回忆分段条会先 exitMemoryPage 再 enterNotesMode）。立刻写历史会在中间
     * 多压一条 /chat/，甚至把用户刚点的目标页盖掉；下一拍发现地址已经是别的页面
     * 就说明这次退出只是切页的中间步骤，不该单独记一笔。
     */
    function scheduleChat(page) {
        if (!started || applying || silentDepth > 0) return;
        window.setTimeout(function () {
            if (!started || applying || silentDepth > 0) return;
            if (currentRoute().page !== page) return;
            goChat();
        }, 0);
    }

    /**
     * 关闭设置 / 成就 / 市场：回到打开它的那一页（state.from）。
     * 不能用 history.back()：侧栏点击会先在 capture 阶段关浮层，back 是异步的，
     * 等它落到历史里的上一页（例如之前去过的记忆）时，已经把用户刚点的目标页盖掉了。
     */
    function leaveOverlay(page) {
        if (!started || applying || silentDepth > 0) return;
        if (currentRoute().page !== page) return;
        var entry = history.state;
        var from = entry && entry.elaina && entry.elaina.from;
        var target = (from && PAGES[from.page])
            ? { page: from.page, tab: from.tab || '' }
            : { page: 'chat', tab: '' };
        // 目标页自己的返程（from.from）要留在替换后的条目里：
        // 设置（返程=语笺）里开市场 -> 关市场回到设置 -> 再关设置仍能回到语笺。
        var nextFrom = (from && from.from) ? from.from : null;
        var want = pathFor(target.page, target.tab);
        try {
            history.replaceState({
                elaina: { page: target.page, tab: target.tab, from: nextFrom }
            }, '', want);
        } catch (e) { /* 忽略：地址栏改不动也不影响页面 */ }
        applyRoute(target);
    }

    /** 当前主区是否已经是对话页（首页或会话）。设置 / 成就 / 市场只是浮层，关掉后下面的对话页仍在。 */
    function showingChat() {
        var initEl = byId('initialState');
        var hist = byId('conversationHistory');
        return Boolean((initEl && !initEl.classList.contains('hidden')) ||
            (hist && !hist.classList.contains('hidden')));
    }

    function closeOthers(route) {
        var st = stateOf();
        if (route.page !== 'notes' && st && st.notesMode && raw.exitNotes) raw.exitNotes();
        if (route.page !== 'diary' && st && st.diaryMode && raw.exitDiary) raw.exitDiary();
        if (route.page !== 'memory' && st && st.memoryPageMode && raw.exitMemory) raw.exitMemory();
        if (route.page !== 'settings' && settingsOpen() && raw.closeSettings) raw.closeSettings();
        if (route.page !== 'achievements' && achievementsOpen() && raw.achClose) raw.achClose();
        if (route.page !== 'store' && marketOpen() && raw.marketClose) raw.marketClose();
    }

    function openPage(route) {
        switch (route.page) {
            case 'notes':
                if (raw.enterNotes) raw.enterNotes();
                break;
            case 'diary':
                if (raw.enterDiary) raw.enterDiary();
                break;
            case 'memory':
                if (raw.enterMemory) raw.enterMemory();
                break;
            case 'settings':
                if (raw.openSettings) raw.openSettings();
                if (route.tab && raw.switchSettingsTab) raw.switchSettingsTab(route.tab);
                break;
            case 'achievements':
                if (raw.achOpen) raw.achOpen();
                break;
            case 'store':
                if (raw.marketOpen) raw.marketOpen();
                break;
            default:
                // 对话页不重新 showInitialState：关掉设置 / 市场后用户应回到原来的会话，
                // 而不是被踢回「新对话」首页。
                if (!showingChat() && raw.showInitial) raw.showInitial();
                break;
        }
    }

    /** 按 URL 打开页面：popstate 与首次加载都走这里。 */
    function applyRoute(route) {
        applying = true;
        try {
            closeOthers(route);
            openPage(route);
            updateTitle(route);
        } finally {
            applying = false;
        }
    }

    function warn(err) {
        try { console.warn('[Router] 同步页面地址失败（不影响页面切换）', err); } catch (e) { /* 忽略 */ }
    }

    /** 包装一个全局入口函数：原始函数照常执行，最外层调用结束后再同步 URL。 */
    function wrap(name, after) {
        var fn = window[name];
        if (typeof fn !== 'function') return;
        window[name] = function () {
            var prev = silentDepth;
            silentDepth++;
            try {
                return fn.apply(this, arguments);
            } finally {
                silentDepth = prev;
                if (prev === 0 && started && !applying) {
                    try { after.apply(this, arguments); } catch (e) { warn(e); }
                }
            }
        };
    }

    /** 包装对象上的方法（ElainaAchievements / ElainaMarket 这类 IIFE 暴露的接口）。 */
    function wrapMethod(owner, name, after) {
        if (!owner || typeof owner[name] !== 'function') return;
        var fn = owner[name];
        owner[name] = function () {
            var prev = silentDepth;
            silentDepth++;
            try {
                return fn.apply(this, arguments);
            } finally {
                silentDepth = prev;
                if (prev === 0 && started && !applying) {
                    try { after.apply(this, arguments); } catch (e) { warn(e); }
                }
            }
        };
    }

    function install() {
        raw = {
            enterNotes: window.enterNotesMode,
            exitNotes: window.exitNotesMode,
            enterDiary: window.enterDiaryMode,
            exitDiary: window.exitDiaryMode,
            enterMemory: window.enterMemoryPage,
            exitMemory: window.exitMemoryPage,
            openSettings: window.openSettings,
            closeSettings: window.closeSettingsPanel,
            switchSettingsTab: window.switchSettingsTab,
            showInitial: window.showInitialState,
            loadConversation: window.loadConversation,
            achOpen: window.ElainaAchievements && window.ElainaAchievements.open,
            achClose: window.ElainaAchievements && window.ElainaAchievements.close,
            marketOpen: window.ElainaMarket && window.ElainaMarket.open,
            marketClose: window.ElainaMarket && window.ElainaMarket.close
        };

        wrap('enterNotesMode', function () { setPage('notes', '', 'push'); });
        wrap('exitNotesMode', function () { scheduleChat('notes'); });
        wrap('enterDiaryMode', function () { setPage('diary', '', 'push'); });
        wrap('exitDiaryMode', function () { scheduleChat('diary'); });
        wrap('enterMemoryPage', function () { setPage('memory', '', 'push'); });
        wrap('exitMemoryPage', function () { scheduleChat('memory'); });
        wrap('openSettings', function () {
            var already = settingsOpen() && currentRoute().page === 'settings';
            setPage('settings', currentSettingsTab(), already ? 'replace' : 'push');
        });
        wrap('closeSettingsPanel', function () { leaveOverlay('settings'); });
        wrap('switchSettingsTab', function (name) {
            // 只在设置页里同步分栏地址；插件分栏没有固定 slug，退回 /settings/。
            if (!settingsOpen() || currentRoute().page !== 'settings') return;
            setPage('settings', SETTINGS_SLUGS[name] ? name : '', 'replace');
        });
        // 新建会话 / 删除当前会话都会走 showInitialState；它把界面切回对话页，地址也要跟过去。
        wrap('showInitialState', function () { setPage('chat', '', 'push'); });
        // 点侧栏里的会话：对话页，保留当前会话内容（不重新按 URL 打开，避免重绘）。
        // 设置 / 成就 / 市场开着时不动地址：多设备同步会在后台调 loadConversation，
        // 那时用户眼前的页面仍是浮层，改写地址会让刷新丢掉浮层所在的页面。
        wrap('loadConversation', function () {
            if (settingsOpen() || achievementsOpen() || marketOpen()) return;
            setPage('chat', '', 'push');
        });

        wrapMethod(window.ElainaAchievements, 'open', function () { setPage('achievements', '', 'push'); });
        wrapMethod(window.ElainaAchievements, 'close', function () { leaveOverlay('achievements'); });
        wrapMethod(window.ElainaMarket, 'open', function () { setPage('store', '', 'push'); });
        wrapMethod(window.ElainaMarket, 'close', function () { leaveOverlay('store'); });

        // 包装依赖入口脚本先于本文件加载。晚到或改名时函数不存在，wrap 会静默跳过，
        // 表现就是「页面能切、地址栏不动」；加载时一次性报出缺失项，别等用户发现。
        var missing = [
            'enterNotesMode', 'exitNotesMode', 'enterDiaryMode', 'exitDiaryMode',
            'enterMemoryPage', 'exitMemoryPage', 'openSettings', 'closeSettingsPanel',
            'switchSettingsTab', 'showInitialState', 'loadConversation'
        ].filter(function (name) { return typeof window[name] !== 'function'; });
        if (!(window.ElainaAchievements && typeof window.ElainaAchievements.open === 'function')) {
            missing.push('ElainaAchievements');
        }
        if (!(window.ElainaMarket && typeof window.ElainaMarket.open === 'function')) {
            missing.push('ElainaMarket');
        }
        if (missing.length) {
            try {
                console.warn('[Router] 这些入口在 router.js 加载时还不存在，相关页面切换不会同步地址：'
                    + missing.join('、'));
            } catch (e) { /* 控制台不可用不影响路由本身 */ }
        }
    }

    /** 启动末尾调用一次：按当前地址打开页面，并把这条历史记录登记成路由入口。 */
    function applyInitial() {
        if (started) return;
        var route = currentRoute();
        if (route.unknown) route = { page: 'chat', tab: '' };
        var want = pathFor(route.page, route.tab);
        try {
            history.replaceState({
                elaina: { page: route.page, tab: route.tab || '', from: null }
            }, '', want);
        } catch (e) { /* 没有历史 API 时 URL 保持原样 */ }
        started = true;
        applyRoute(route);
    }

    install();

    window.addEventListener('popstate', function () {
        if (!started) return;
        var route = currentRoute();
        if (route.unknown) route = { page: 'chat', tab: '' };
        applyRoute(route);
    });

    // 给插件 / 后续页面用的唯一导航出口：改地址并真正打开目标页。
    window.ElainaRouter = {
        applyInitial: applyInitial,
        navigate: function (page, tab, opts) {
            if (!PAGES[page] || !started) return false;
            var route = { page: page, tab: (page === 'settings' && tab) ? tab : '' };
            var want = pathFor(route.page, route.tab);
            if (location.pathname !== want) {
                var now = currentRoute();
                var replace = Boolean(opts && opts.replace);
                var prevEntry = history.state;
                var from = { page: now.page, tab: now.tab || '' };
                if (replace) {
                    from = (prevEntry && prevEntry.elaina && prevEntry.elaina.from) || null;
                } else if (prevEntry && prevEntry.elaina && prevEntry.elaina.from) {
                    from.from = prevEntry.elaina.from;
                }
                var entry = { elaina: { page: route.page, tab: route.tab, from: from } };
                try {
                    if (replace) history.replaceState(entry, '', want);
                    else history.pushState(entry, '', want);
                } catch (e) { /* 地址栏改不动时仍按目标页打开 */ }
            }
            applyRoute(route);
            return true;
        },
        current: currentRoute,
        pathFor: pathFor
    };
})();
