(function () {
    'use strict';

    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    const html = document.documentElement;
    const DATA = window.EL;

    const THEME_NAMES = DATA.themes.reduce((map, t) => { map[t.id] = t.name; return map; }, {});
    const PAGE_META = {
        chat: () => {
            const conv = getConv();
            return { title: conv.title, sub: conv.model + ' · 旅途第 37 天' };
        },
        notes: () => ({ title: '语笺', sub: '收藏的消息与金句' }),
        diary: () => ({ title: '旅行日记', sub: DATA.diary.length + ' 篇 · ' + totalWords() + ' 字' }),
        achievements: () => {
            const stat = achievementStat();
            return { title: '成就', sub: stat.unlocked + ' / ' + stat.total + ' 已解锁' };
        },
        market: () => {
            const installed = state.mods.filter(m => m.installed).length;
            return { title: '插件市场', sub: installed + ' 个已安装 · 按需装卸' };
        },
        settings: () => ({ title: '设置', sub: '外观、角色、模型与插件' })
    };

    const SUGGESTIONS = [
        '给我讲讲你旅行中最难忘的一天',
        '如果下一站由你决定，会去哪里？',
        '今天不太想出门，陪我聊会儿吧'
    ];

    const state = {
        page: 'chat',
        conversation: 'c1',
        convQuery: '',
        notesTab: 'message',
        notesQuery: '',
        marketFilter: 'all',
        marketQuery: '',
        settingsTab: 'appearance',
        logFilter: 'all',
        theme: 'majo',
        modePref: 'dark',
        texture: true,
        bubble: 'round',
        caps: { memory: true, autoMemory: true, voice: true, pc: false, command: false, skills: true },
        mods: DATA.mods.map(m => Object.assign({}, m)),
        starred: new Set(),
        typing: false,
        replyTimer: null,
        callInterval: null,
        callLineTimer: null,
        callSeconds: 0,
        callLines: [
            '“晚上好。今天想去哪里？”',
            '“雨好像要停了。要不要出去走走？”',
            '“红茶还热着。你可以慢一点说。”',
            '“嗯，我在听。”'
        ],
        callLineIndex: 0
    };

    Object.keys(DATA.messages).forEach(cid => {
        DATA.messages[cid].forEach((m, i) => {
            if (m.starred) state.starred.add(cid + ':' + i);
        });
    });

    const dom = {
        view: $('#view'),
        convList: $('#conversationList'),
        convSearch: $('#convSearch'),
        convCount: $('#convCount'),
        pageTitle: $('#pageTitle'),
        pageSub: $('#pageSub'),
        modelPillText: $('#modelPillText'),
        composerDock: $('#composerDock'),
        composerInput: $('#composerInput'),
        sendBtn: $('#sendBtn'),
        attachBtn: $('#attachBtn'),
        attachMenu: $('#attachMenu'),
        modalOverlay: $('#modalOverlay'),
        modalBox: $('#modalBox'),
        modalTitle: $('#modalTitle'),
        modalBody: $('#modalBody'),
        modalFoot: $('#modalFoot'),
        callScreen: $('#callScreen'),
        callTimer: $('#callTimer'),
        callStatus: $('#callStatus'),
        callText: $('#callText'),
        callMute: $('#callMute'),
        toasts: $('#toasts'),
        listPanel: $('#listPanel'),
        listScrim: $('#listScrim'),
        announcePop: $('#announcePop'),
        bellBtn: $('#bellBtn'),
        labFab: $('#labFab'),
        labPanel: $('#labPanel'),
        labThemes: $('#labThemes'),
        labMode: $('#labMode'),
        metaTheme: $('meta[name="theme-color"]')
    };

    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    /* ============================================================
       初始化
       ============================================================ */

    function init() {
        const savedTheme = readPref('theme');
        if (savedTheme && THEME_NAMES[savedTheme]) state.theme = savedTheme;

        const savedMode = readPref('mode');
        if (['system', 'light', 'dark'].indexOf(savedMode) >= 0) state.modePref = savedMode;

        state.texture = readPref('texture') !== 'off';
        state.bubble = readPref('bubble') === 'compact' ? 'compact' : 'round';

        const params = new URLSearchParams(window.location.search);
        const qTheme = params.get('theme');
        const qMode = params.get('mode');
        const qPage = params.get('page');
        const qConv = params.get('conv');
        const qTab = params.get('tab');
        if (qTheme && THEME_NAMES[qTheme]) state.theme = qTheme;
        if (['system', 'light', 'dark'].indexOf(qMode) >= 0) state.modePref = qMode;
        if (qPage && PAGE_META[qPage]) state.page = qPage;
        if (qConv && DATA.conversations.some(c => c.id === qConv)) state.conversation = qConv;
        if (qTab && ['appearance', 'character', 'model', 'capability', 'advanced', 'plugins', 'logs'].indexOf(qTab) >= 0) state.settingsTab = qTab;
        if (params.get('texture') === 'off') state.texture = false;

        buildLab();
        applyAppearance();
        bindEvents();
        renderAll();
        updateComposerState();
    }

    function readPref(key) {
        try { return localStorage.getItem('elaina-redesign-' + key); } catch (e) { return null; }
    }

    function writePref(key, value) {
        try { localStorage.setItem('elaina-redesign-' + key, value); } catch (e) { /* 原型允许无痕模式 */ }
    }

    /* ============================================================
       主题与外观
       ============================================================ */

    function resolvedMode() {
        if (state.modePref === 'system') return mq && mq.matches ? 'dark' : 'light';
        return state.modePref;
    }

    function applyAppearance() {
        html.dataset.theme = state.theme;
        html.dataset.mode = resolvedMode();
        html.dataset.texture = state.texture ? 'on' : 'off';
        html.dataset.bubble = state.bubble;

        if (dom.metaTheme) {
            const bg = getComputedStyle(html).getPropertyValue('--bg').trim();
            if (bg) dom.metaTheme.setAttribute('content', bg);
        }

        writePref('theme', state.theme);
        writePref('mode', state.modePref);
        writePref('texture', state.texture ? 'on' : 'off');
        writePref('bubble', state.bubble);

        syncChoiceGroup('[data-theme-choice]', 'themeChoice', state.theme);
        syncChoiceGroup('[data-mode-choice]', 'modeChoice', state.modePref);
    }

    function setTheme(id) {
        if (!THEME_NAMES[id] || state.theme === id) return;
        state.theme = id;
        applyAppearance();
        toast('已切换到「' + THEME_NAMES[id] + '」');
    }

    function setMode(pref) {
        if (['system', 'light', 'dark'].indexOf(pref) < 0) return;
        state.modePref = pref;
        applyAppearance();
    }

    function syncChoiceGroup(selector, dataKey, value) {
        $$(selector).forEach(btn => {
            const attr = btn.dataset[dataKey];
            btn.classList.toggle('active', attr === value);
        });
    }

    function resetAppearance() {
        state.theme = 'majo';
        state.modePref = 'dark';
        state.texture = true;
        state.bubble = 'round';
        applyAppearance();
        renderPage();
        toast('外观已恢复默认');
    }

    /* ============================================================
       渲染入口
       ============================================================ */

    function renderAll() {
        renderConversations();
        renderPage();
        renderLabState();
    }

    function renderPage() {
        dom.view.innerHTML = pageHTML(state.page);
        document.body.dataset.page = state.page;
        dom.composerDock.style.display = state.page === 'chat' ? '' : 'none';
        renderTopbar();
        renderNav();
        syncChoiceGroup('[data-theme-choice]', 'themeChoice', state.theme);
        syncChoiceGroup('[data-mode-choice]', 'modeChoice', state.modePref);
        if (state.page === 'chat') scrollChat();
        else dom.view.scrollTop = 0;
    }

    function renderTopbar() {
        const meta = PAGE_META[state.page]();
        dom.pageTitle.textContent = meta.title;
        dom.pageSub.textContent = meta.sub;
        if (state.page === 'chat') {
            dom.modelPillText.textContent = getConv().model;
        } else {
            dom.modelPillText.textContent = DATA.model.name;
        }
    }

    function renderNav() {
        $$('.rail-btn[data-page], .bottom-nav button[data-page]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.page === state.page);
        });
    }

    function renderConversations() {
        const q = state.convQuery.trim().toLowerCase();
        const all = DATA.conversations;
        const visible = all.filter(c => !q || (c.title + ' ' + c.preview).toLowerCase().indexOf(q) >= 0);
        dom.convCount.textContent = all.length + ' 段旅途 · ' + DATA.folders.length + ' 个分类';

        if (!visible.length) {
            dom.convList.innerHTML = '<div class="list-empty">没有找到对话。<br>换个关键词试试。</div>';
            return;
        }

        const blocks = [];
        DATA.folders.forEach(folder => {
            const items = visible.filter(c => c.folder === folder.id);
            if (!items.length) {
                if (!q) {
                    blocks.push('<div class="folder-label">' + icon('folder') + '<span>' + esc(folder.name) + '</span><span>0</span></div>');
                    blocks.push('<div class="list-empty-inline">还没有对话</div>');
                }
                return;
            }
            items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
            blocks.push('<div class="folder-label">' + icon('folder') + '<span>' + esc(folder.name) + '</span><span>' + items.length + '</span></div>');
            items.forEach(c => blocks.push(convHTML(c)));
        });

        const known = DATA.folders.map(f => f.id);
        const loose = visible.filter(c => known.indexOf(c.folder) < 0);
        if (loose.length) {
            blocks.push('<div class="folder-label">' + icon('folder') + '<span>其他</span><span>' + loose.length + '</span></div>');
            loose.forEach(c => blocks.push(convHTML(c)));
        }

        dom.convList.innerHTML = blocks.join('');
    }

    function convHTML(c) {
        return '<button class="conv ' + (c.id === state.conversation ? 'active' : '') + '" data-action="open-conv" data-id="' + c.id + '">' +
            '<span class="conv-title">' + (c.pinned ? icon('star') : '') + esc(c.title) + '</span>' +
            '<span class="conv-preview">' + esc(c.preview) + '</span>' +
            '<span class="conv-meta">' + (c.unread ? '<i class="conv-dot"></i>' : '') + '<span>' + esc(c.time) + '</span></span>' +
            '</button>';
    }

    /* ============================================================
       页面模板
       ============================================================ */

    function pageHTML(page) {
        if (page === 'notes') return notesPage();
        if (page === 'diary') return diaryPage();
        if (page === 'achievements') return achievementsPage();
        if (page === 'market') return marketPage();
        if (page === 'settings') return settingsPage();
        return chatPage();
    }

    /* ---------- 对话 ---------- */

    function chatPage() {
        const conv = getConv();
        const msgs = DATA.messages[conv.id] || [];

        if (!msgs.length) {
            return '<div class="chat-wrap"><section class="chat-intro">' +
                '<div class="intro-mark">E</div>' +
                '<div class="intro-eyebrow">灰之魔女 · 旅途第 37 天</div>' +
                '<h1 class="intro-title">' + greetingText() + '</h1>' +
                '<p class="intro-sub">' + esc(DATA.character.greeting) + '</p>' +
                '<div class="intro-rule"></div>' +
                '<div class="suggestions">' + SUGGESTIONS.map(s =>
                    '<button class="suggestion" data-action="suggest" data-text="' + esc(s) + '">' + esc(s) + '</button>'
                ).join('') + '</div>' +
                '</section></div>';
        }

        return '<div class="chat-wrap">' +
            '<div class="date-divider">' + (conv.id === 'c1' ? '今天 · 10 月 24 日' : '最近的一段旅途') + '</div>' +
            msgs.map((m, i) => messageHTML(conv.id, m, i)).join('') +
            (state.typing ? typingHTML() : '') +
            '<div class="notice">' + icon('sparkles') + '记忆已整理 · 3 条旅途片段</div>' +
            '</div>';
    }

    function messageHTML(convId, m, index) {
        const isUser = m.role === 'user';
        const key = convId + ':' + index;
        const starred = state.starred.has(key) || m.starred;
        return '<article class="msg ' + (isUser ? 'user' : 'ai') + '" data-msg-index="' + index + '">' +
            '<div class="avatar">' + (isUser ? '旅' : 'E') + '</div>' +
            '<div class="msg-col">' +
            '<div class="msg-meta"><b>' + (isUser ? '旅人' : '伊蕾娜') + '</b><span>' + esc(m.time) + '</span></div>' +
            '<div class="bubble">' + (isUser ? esc(m.text) : m.text) + '</div>' +
            '<div class="msg-actions">' +
            '<button data-action="copy-msg" data-index="' + index + '" title="复制" aria-label="复制">' + icon('copy') + '</button>' +
            (isUser ? '' : '<button class="' + (starred ? 'on' : '') + '" data-action="star-msg" data-index="' + index + '" title="收藏到语笺" aria-label="收藏">' + icon('star') + '</button>' +
                '<button data-action="regen" title="重新生成" aria-label="重新生成">' + icon('refresh') + '</button>') +
            '</div></div></article>';
    }

    function typingHTML() {
        return '<article class="msg ai"><div class="avatar">E</div><div class="msg-col">' +
            '<div class="msg-meta"><b>伊蕾娜</b><span>正在输入…</span></div>' +
            '<div class="bubble typing"><i></i><i></i><i></i></div></div></article>';
    }

    function greetingText() {
        const h = new Date().getHours();
        const hello = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
        return hello + '。<br>今天想去<em>哪里</em>？';
    }

    /* ---------- 语笺 ---------- */

    function notesPage() {
        const list = filteredNotes();
        return '<div class="page">' +
            '<div class="page-head"><div>' +
            '<div class="page-eyebrow">Keepsakes</div>' +
            '<h1 class="page-title">语笺</h1>' +
            '<p class="page-desc">收藏的消息与金句，会一直留在这里。</p>' +
            '</div><div class="spacer"></div>' +
            '<button class="btn btn-ghost" data-action="toast" data-toast="导出语笺：原型中未接入文件导出">' + icon('download') + '导出</button>' +
            '</div>' +
            '<div class="toolbar">' +
            '<div class="segmented">' +
            '<button class="' + (state.notesTab === 'message' ? 'active' : '') + '" data-notes-tab="message">消息收藏</button>' +
            '<button class="' + (state.notesTab === 'quote' ? 'active' : '') + '" data-notes-tab="quote">金句收藏</button>' +
            '</div>' +
            '<div class="search">' + icon('search') + '<input class="input" id="notesSearch" placeholder="搜索收藏…" value="' + esc(state.notesQuery) + '"></div>' +
            '<span class="count-label" id="notesCount">共 ' + list.length + ' 条</span>' +
            '</div>' +
            '<div class="notes-grid" id="notesGrid">' + notesGridHTML() + '</div>' +
            '</div>';
    }

    function filteredNotes() {
        const q = state.notesQuery.trim().toLowerCase();
        return DATA.notes.filter(n => n.type === state.notesTab && (!q || (n.text + ' ' + n.source + ' ' + n.tag).toLowerCase().indexOf(q) >= 0));
    }

    function notesGridHTML() {
        const list = filteredNotes();
        if (!list.length) {
            return '<div class="empty-state" style="grid-column:1/-1">' + icon('bookmark') +
                '<p>没有找到语笺</p><small>换个关键词，或者去对话里点一下星标。</small></div>';
        }
        return list.map(n => '<article class="note-card" data-action="note-open" data-id="' + n.id + '">' +
            '<div><span class="badge ' + (n.type === 'quote' ? '' : 'neutral') + '">' + (n.type === 'quote' ? '金句' : '消息') + '</span></div>' +
            '<p class="note-quote">' + esc(n.text) + '</p>' +
            '<div class="note-meta"><span class="source">' + esc(n.source) + '</span><span class="dot"></span><span>' + esc(n.date) + '</span>' +
            (n.liked ? '<span style="margin-left:auto;color:var(--accent)">♥</span>' : '') +
            '</div></article>').join('');
    }

    function renderNotesGrid() {
        const grid = $('#notesGrid');
        if (!grid) return;
        grid.innerHTML = notesGridHTML();
        const count = $('#notesCount');
        if (count) count.textContent = '共 ' + filteredNotes().length + ' 条';
    }

    /* ---------- 日记 ---------- */

    function diaryPage() {
        const wordCount = totalWords();
        const months = [];
        DATA.diary.forEach(d => {
            let group = months.find(m => m.name === d.month);
            if (!group) { group = { name: d.month, items: [] }; months.push(group); }
            group.items.push(d);
        });

        const timeline = months.map(group => '<div class="month-label">' + esc(group.name) + '</div>' +
            group.items.map(d => '<article class="diary-card" data-action="diary-open" data-id="' + d.id + '">' +
                '<div class="diary-date">' + esc(d.displayDate) + '</div>' +
                '<h3 class="diary-title">' + esc(d.title) + '</h3>' +
                '<p class="diary-excerpt">' + esc(d.excerpt) + '</p>' +
                '<div class="diary-foot">' + icon('map-pin') + '<span class="place">' + esc(d.place) + '</span>' +
                '<span class="tags">' + d.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</span>' +
                '</div></article>').join('')).join('');

        return '<div class="page">' +
            '<div class="page-head"><div>' +
            '<div class="page-eyebrow">Travel Journal</div>' +
            '<h1 class="page-title">旅行日记</h1>' +
            '<p class="page-desc">把值得记住的旅途片段按时间收好。</p>' +
            '</div><div class="spacer"></div>' +
            '<button class="btn btn-ghost" data-action="toast" data-toast="今日日记已生成（原型演示）">' + icon('sparkles') + '写今日日记</button>' +
            '</div>' +
            '<div class="stats-row">' +
            '<div class="stat"><b>' + DATA.diary.length + '</b><span>篇日记</span></div>' +
            '<div class="stat"><b>' + wordCount + '</b><span>累计字数</span></div>' +
            '<div class="stat"><b>37</b><span>旅途天数</span></div>' +
            '</div>' +
            '<div class="timeline">' + timeline + '</div>' +
            '</div>';
    }

    function totalWords() {
        return DATA.diary.reduce((sum, d) => sum + d.words, 0);
    }

    /* ---------- 成就 ---------- */

    function achievementStat() {
        const items = DATA.achievements.categories.reduce((arr, c) => arr.concat(c.items), []);
        return {
            items: items,
            total: items.length,
            unlocked: items.filter(i => i.unlocked).length
        };
    }

    function achievementsPage() {
        const stat = achievementStat();
        const pct = Math.round(stat.unlocked / stat.total * 100);
        const birthday = DATA.achievements.birthday;

        const sections = DATA.achievements.categories.map(cat =>
            '<section class="ach-section"><div class="ach-section-head">' + esc(cat.name) + '</div>' +
            '<div class="ach-grid">' + cat.items.map(achCardHTML).join('') + '</div></section>'
        ).join('');

        return '<div class="page">' +
            '<div class="page-head"><div>' +
            '<div class="page-eyebrow">Milestones</div>' +
            '<h1 class="page-title">成就</h1>' +
            '<p class="page-desc">旅途留下的证明。事件成就会停在解锁的那一天。</p>' +
            '</div><div class="spacer"></div>' +
            '<button class="btn btn-ghost" data-action="manage-folders">' + icon('folder') + '管理分类</button>' +
            '</div>' +
            '<div class="achievement-hero">' +
            '<div class="ring" style="--p:' + pct + '"><span>' + stat.unlocked + '/' + stat.total + '</span></div>' +
            '<div class="hero-copy">' +
            '<h3>' + (stat.unlocked === stat.total ? '旅途已经写满' : '下一枚徽章就在前面') + '</h3>' +
            '<p>已解锁 ' + stat.unlocked + ' 个成就，还有 ' + (stat.total - stat.unlocked) + ' 个等待遇见。</p>' +
            '<div class="hero-progress"><i style="width:' + pct + '%"></i></div>' +
            '</div></div>' +
            '<div class="birthday-card"><div class="gift">' + icon('gift') + '</div>' +
            '<div class="copy"><b>' + esc(birthday.title) + ' · ' + esc(birthday.date) + '</b><p>' + esc(birthday.desc) + '</p></div>' +
            (birthday.unlocked ? '<span class="badge">已解锁</span>' : '') +
            '</div>' +
            sections +
            '</div>';
    }

    function achCardHTML(item) {
        const locked = !item.unlocked;
        const prog = item.progress ? Math.round(item.progress[0] / item.progress[1] * 100) : 0;
        return '<article class="ach-card ' + (locked ? 'locked' : '') + '">' +
            '<div class="medal">' + icon(item.icon) + '</div>' +
            '<div class="ach-copy"><h4>' + esc(item.title) + '</h4>' +
            '<p>' + esc(item.desc) + (item.unlocked && item.date ? ' · ' + esc(item.date) : '') + '</p>' +
            (item.progress ? '<div class="ach-progress"><i style="width:' + prog + '%"></i></div><p style="margin-top:4px">' + item.progress[0] + ' / ' + item.progress[1] + '</p>' : '') +
            '</div>' +
            '<span class="ach-state ' + (locked ? '' : 'done') + '">' + (locked ? '未解锁' : '已解锁') + '</span>' +
            '</article>';
    }

    /* ---------- 插件市场 ---------- */

    function marketPage() {
        const installed = state.mods.filter(m => m.installed).length;
        const list = filteredMods();
        const live2d = state.mods.filter(m => m.id === 'live2d-models')[0];

        const filters = [
            ['all', '全部'], ['installed', '已安装'], ['available', '未安装'],
            ['resource', '资源'], ['ui', '界面'], ['theme', '主题'], ['new', '新上架']
        ];

        return '<div class="page">' +
            '<div class="page-head"><div>' +
            '<div class="page-eyebrow">Mod Market</div>' +
            '<h1 class="page-title">插件市场</h1>' +
            '<p class="page-desc">宿主只保留对话本体，其余能力按需装卸。</p>' +
            '</div><div class="spacer"></div>' +
            '<button class="btn btn-ghost" data-action="page" data-page="settings">' + icon('arrow-left') + '返回设置</button>' +
            '<button class="btn btn-ghost" data-action="toast" data-toast="已刷新插件市场（原型演示）">' + icon('refresh') + '刷新</button>' +
            '</div>' +
            '<div class="featured">' +
            '<div class="featured-icon">' + icon('video') + '</div>' +
            '<div class="featured-copy"><span class="badge">本周精选</span>' +
            '<h3>用 Live2D 和伊蕾娜视频通话</h3>' +
            '<p>引擎与模型都住在插件里，不装就不占空间。打开视频通话时才加载，787 KB 按需付出。</p></div>' +
            '<div class="featured-actions">' +
            (live2d && live2d.enabled
                ? '<span class="state-pill on"><i class="dot"></i>已启用</span>'
                : '<button class="btn btn-primary" data-action="' + (live2d && live2d.installed ? 'toggle-mod' : 'install-mod') + '" data-id="live2d-models">' + (live2d && live2d.installed ? '启用' : '安装') + '</button>') +
            '<button class="btn btn-ghost" data-action="toast" data-toast="模型管理：原型中未接入">' + icon('settings') + '管理</button>' +
            '</div></div>' +
            '<div class="market-toolbar">' +
            '<div class="chip-row">' + filters.map(f =>
                '<button class="chip ' + (state.marketFilter === f[0] ? 'active' : '') + '" data-market-filter="' + f[0] + '">' + f[1] + '</button>'
            ).join('') + '</div>' +
            '<div class="search">' + icon('search') + '<input class="input" id="marketSearch" placeholder="搜索插件…" value="' + esc(state.marketQuery) + '"></div>' +
            '</div>' +
            '<div class="market-grid" id="marketGrid">' + marketGridHTML() + '</div>' +
            '<p class="market-note">' + installed + ' / ' + state.mods.length + ' 个扩展已安装 · 安装状态只保存在当前页面，刷新后恢复演示数据。</p>' +
            '</div>';
    }

    function filteredMods() {
        const q = state.marketQuery.trim().toLowerCase();
        return state.mods.filter(m => {
            if (q && (m.name + ' ' + m.desc + ' ' + m.tags.join(' ')).toLowerCase().indexOf(q) < 0) return false;
            switch (state.marketFilter) {
                case 'installed': return m.installed;
                case 'available': return !m.installed;
                case 'resource': return m.tags.indexOf('资源') >= 0;
                case 'ui': return m.tags.indexOf('界面') >= 0;
                case 'theme': return m.tags.indexOf('主题') >= 0;
                case 'new': return m.tags.indexOf('新') >= 0;
                default: return true;
            }
        });
    }

    function marketGridHTML() {
        const list = filteredMods();
        if (!list.length) {
            return '<div class="empty-state" style="grid-column:1/-1">' + icon('puzzle') +
                '<p>没有找到插件</p><small>试试「资源」「界面」，或者清空搜索词。</small></div>';
        }
        return list.map(m => '<article class="mod-card">' +
            '<div class="mod-top"><div class="mod-icon" style="--mod-bg:' + m.bg + ';--mod-fg:' + m.fg + '">' + esc(m.glyph) + '</div>' +
            '<div class="mod-heading"><div class="mod-name">' + esc(m.name) +
            (m.tags.indexOf('新') >= 0 ? '<span class="badge">新</span>' : '') + '</div>' +
            '<div class="mod-author">' + esc(m.author) + ' · v' + esc(m.version) + ' · ' + esc(m.size) + '</div></div></div>' +
            '<p class="mod-desc">' + esc(m.desc) + '</p>' +
            '<div class="mod-tags">' + m.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' +
            '<div class="mod-foot">' +
            (m.installed
                ? '<button class="switch ' + (m.enabled ? 'on' : '') + '" data-action="toggle-mod" data-id="' + m.id + '" aria-label="' + (m.enabled ? '停用' : '启用') + ' ' + esc(m.name) + '"></button>' +
                  '<span class="state-pill ' + (m.enabled ? 'on' : '') + '"><i class="dot"></i>' + (m.enabled ? '已启用' : '已停用') + '</span>'
                : '<span class="state-pill">未安装</span>') +
            '<button class="btn btn-ghost btn-sm" style="margin-left:auto" data-action="' + (m.installed ? 'mod-detail' : 'install-mod') + '" data-id="' + m.id + '">' +
            (m.installed ? '详情' : '安装') + '</button>' +
            '</div></article>').join('');
    }

    function renderMarketGrid() {
        const grid = $('#marketGrid');
        if (!grid) return;
        grid.innerHTML = marketGridHTML();
        const note = $('.market-note');
        if (note) {
            const installed = state.mods.filter(m => m.installed).length;
            note.textContent = installed + ' / ' + state.mods.length + ' 个扩展已安装 · 安装状态只保存在当前页面，刷新后恢复演示数据。';
        }
    }

    /* ---------- 设置 ---------- */

    function settingsPage() {
        const tabs = [
            ['appearance', '外观', 'palette'],
            ['character', '角色', 'user'],
            ['model', '模型', 'cpu'],
            ['capability', '能力', 'shield'],
            ['advanced', '高级', 'terminal'],
            ['plugins', '插件', 'puzzle'],
            ['logs', '日志', 'list']
        ];

        return '<div class="page">' +
            '<div class="page-head"><div>' +
            '<div class="page-eyebrow">Preferences</div>' +
            '<h1 class="page-title">设置</h1>' +
            '<p class="page-desc">所有改动都留在本地。这里展示的是重构后的信息层级，未接入真实存储。</p>' +
            '</div><div class="spacer"></div>' +
            '<button class="btn btn-ghost" data-action="page" data-page="chat">' + icon('arrow-left') + '返回对话</button>' +
            '</div>' +
            '<div class="settings-page">' +
            '<nav class="settings-nav">' + tabs.map(t =>
                '<button class="' + (state.settingsTab === t[0] ? 'active' : '') + '" data-settings-tab="' + t[0] + '">' + icon(t[2]) + '<span>' + t[1] + '</span></button>'
            ).join('') + '</nav>' +
            '<div class="settings-body">' + settingsPanel(state.settingsTab) + '</div>' +
            '</div></div>';
    }

    function settingsPanel(tab) {
        if (tab === 'character') return settingsCharacter();
        if (tab === 'model') return settingsModel();
        if (tab === 'capability') return settingsCapability();
        if (tab === 'advanced') return settingsAdvanced();
        if (tab === 'plugins') return settingsPlugins();
        if (tab === 'logs') return settingsLogs();
        return settingsAppearance();
    }

    function settingsAppearance() {
        return '<section class="set-card">' +
            '<div class="set-card-head">' + icon('palette') + '<div><h3>视觉方向</h3><p>四套主题分别调校了字体、圆角、阴影与底色。</p></div></div>' +
            '<div class="theme-grid">' + DATA.themes.map(t =>
                '<button class="theme-card ' + (state.theme === t.id ? 'active' : '') + '" data-theme-choice="' + t.id + '">' +
                '<div class="theme-preview pv-' + t.id + '"><span class="pv-rail"></span><span class="pv-list"></span><span class="pv-main"><i></i><i></i><i></i></span></div>' +
                '<b>' + esc(t.name) + '</b><small>' + esc(t.desc) + '</small></button>'
            ).join('') + '</div></section>' +
            '<section class="set-card">' +
            '<div class="set-card-head">' + icon('monitor') + '<div><h3>显示</h3><p>深浅模式与气泡形状对所有主题生效。</p></div></div>' +
            '<div class="set-row"><div class="copy"><b>外观模式</b><span>跟随设备，或固定为浅色 / 深色</span></div>' +
            '<div class="segmented">' +
            '<button data-mode-choice="system">跟随</button>' +
            '<button data-mode-choice="light">浅色</button>' +
            '<button data-mode-choice="dark">深色</button>' +
            '</div></div>' +
            '<div class="set-row"><div class="copy"><b>气泡形状</b><span>圆润适合阅读，紧凑适合长对话</span></div>' +
            '<div class="segmented">' +
            '<button data-action="set-bubble" data-bubble="round" class="' + (state.bubble === 'round' ? 'active' : '') + '">圆润</button>' +
            '<button data-action="set-bubble" data-bubble="compact" class="' + (state.bubble === 'compact' ? 'active' : '') + '">紧凑</button>' +
            '</div></div>' +
            '<div class="set-row"><div class="copy"><b>背景光晕</b><span>关闭后使用纯色背景，减少视觉干扰</span></div>' +
            '<button class="switch ' + (state.texture ? 'on' : '') + '" data-action="toggle-texture" aria-label="背景光晕"></button></div>' +
            '<div class="set-actions"><button class="btn btn-ghost" data-action="reset-appearance">' + icon('refresh') + '恢复默认外观</button></div>' +
            '</section>';
    }

    function settingsCharacter() {
        const c = DATA.character;
        return '<section class="set-card">' +
            '<div class="set-card-head">' + icon('user') + '<div><h3>人设</h3><p>可以存多套，随时切换。角色卡会随所选方案一起保存。</p></div></div>' +
            '<div class="field"><label>人设方案</label><div class="key-row">' +
            '<select class="select"><option>' + esc(c.persona) + '</option><option>夏日旅行 · 短发</option><option>冬夜书斋 · 长外套</option></select>' +
            '<button class="btn btn-ghost" data-action="toast" data-toast="已新建人设方案（原型演示）">新建</button>' +
            '<button class="btn btn-ghost" data-action="toast" data-toast="已复制当前人设（原型演示）">复制</button>' +
            '</div></div>' +
            '<div class="field-row">' +
            '<div class="field"><label>角色名</label><input class="input" value="' + esc(c.name) + '"></div>' +
            '<div class="field"><label>称号</label><input class="input" value="' + esc(c.title) + '"></div>' +
            '</div>' +
            '<div class="field"><label>完整角色卡</label><textarea class="textarea" rows="7">' + esc(c.card) + '</textarea>' +
            '<span class="hint">直接填写身份、性格、表达方式与能力边界。发送时作为 system 提示词的一部分。</span></div>' +
            '<div class="field"><label>开场白</label><input class="input" value="' + esc(c.greeting) + '"></div>' +
            '</section>' +
            '<section class="set-card">' +
            '<div class="set-card-head">' + icon('globe') + '<div><h3>世界观卡</h3><p>世界规则与时代背景，和当前人设一起保存、一起切换。</p></div></div>' +
            '<div class="field"><label>世界观设定</label><textarea class="textarea" rows="5">' + esc(c.world) + '</textarea></div>' +
            '</section>' +
            '<div class="set-actions"><button class="btn btn-primary" data-action="toast" data-toast="角色设定已保存（原型演示）">' + icon('save') + '保存角色设定</button>' +
            '<button class="btn btn-ghost" data-action="toast" data-toast="已恢复默认伊蕾娜角色卡（原型演示）">恢复默认</button></div>';
    }

    function settingsModel() {
        const m = DATA.model;
        return '<section class="set-card">' +
            '<div class="set-card-head">' + icon('cpu') + '<div><h3>对话模型</h3><p>请求从当前设备直接发给服务商，不经过作者服务器。</p></div>' +
            '<span class="spacer"></span><span class="badge">BYOK</span></div>' +
            '<div class="field"><label>API 格式</label><select class="select"><option>' + esc(m.format) + '</option><option>OpenAI 官方（Responses）</option><option>Anthropic Claude</option></select>' +
            '<span class="hint">切换格式会自动填入对应的默认地址。</span></div>' +
            '<div class="field"><label>API Base URL</label><input class="input" value="' + esc(m.baseUrl) + '"></div>' +
            '<div class="field"><label>API Key</label><div class="key-row"><input class="input" type="password" value="sk-demo-key-not-real">' +
            '<button class="btn btn-ghost" data-action="toast" data-toast="Key 仅保存在当前设备（原型未接入加密存储）">' + icon('key') + '管理</button></div></div>' +
            '<div class="field-row">' +
            '<div class="field"><label>模型</label><select class="select"><option>' + esc(m.name) + '</option><option>deepseek-reasoner</option><option>gpt-4.1-mini</option></select></div>' +
            '<div class="field"><label>思考强度</label><select class="select"><option>标准</option><option>更快</option><option>更深入</option></select></div>' +
            '</div>' +
            '<div class="field"><label>温度</label><div class="range-row"><input type="range" min="0" max="2" step="0.1" value="' + m.temperature + '" oninput="this.nextElementSibling.value=this.value"><output>' + m.temperature + '</output></div>' +
            '<span class="hint">越高越活跃，越低越稳定。角色扮演通常 0.7–0.9。</span></div>' +
            '<div class="set-actions"><button class="btn btn-primary" id="testConnBtn" data-action="test-connection">' + icon('power') + '测试连接</button>' +
            '<button class="btn btn-ghost" data-action="toast" data-toast="模型设置已保存（原型演示）">保存</button></div>' +
            '</section>' +
            '<section class="set-card">' +
            '<div class="set-card-head">' + icon('volume') + '<div><h3>语音</h3><p>语音通话与语音输入分别使用不同的模型。</p></div></div>' +
            '<div class="field-row">' +
            '<div class="field"><label>TTS 语音合成</label><select class="select"><option>Mimo TTS · 伊蕾娜</option><option>系统语音</option></select></div>' +
            '<div class="field"><label>ASR 语音识别</label><select class="select"><option>浏览器语音识别</option><option>Whisper 本地</option></select></div>' +
            '</div>' +
            '<div class="set-row"><div class="copy"><b>自动朗读回复</b><span>收到回复后立即播放语音</span></div><button class="switch" data-action="flip-switch" aria-label="自动朗读回复"></button></div>' +
            '</section>' +
            '<section class="set-card">' +
            '<div class="set-card-head">' + icon('image') + '<div><h3>视觉</h3><p>图片转述与场景理解。</p></div></div>' +
            '<div class="field"><label>转述模型</label><select class="select"><option>deepseek-vl</option><option>gpt-4.1-mini</option></select></div>' +
            '<div class="field"><label>图片压缩</label><select class="select"><option>自动（长边 1024）</option><option>原图</option></select></div>' +
            '</section>';
    }

    function settingsCapability() {
        const caps = [
            ['memory', '长期记忆', '跨对话保留角色与旅途摘要', '记忆写入本地数据库', true, ''],
            ['autoMemory', '自动整理记忆', '对话过长时自动压缩成摘要', '可能产生额外模型调用', true, ''],
            ['voice', '语音输入', '按住麦克风说话，实时转成文字', '使用浏览器语音识别', true, ''],
            ['skills', '技能与 MCP', '允许 AI 使用已安装的技能与外部工具', '第三方内容，请只启用可信来源', true, ''],
            ['pc', '电脑控制', '允许 AI 读取前台窗口与进程', '高风险 · 仅在本机可用', false, 'warn'],
            ['command', '命令执行', '允许 AI 运行 PowerShell / cmd', '高风险 · 每条命令都需要确认', false, 'danger']
        ];

        return '<section class="set-card">' +
            '<div class="set-card-head">' + icon('shield') + '<div><h3>AI 能做什么</h3><p>关闭的能力不会出现在提示词与工具清单里。</p></div></div>' +
            caps.map(c => '<div class="set-row"><div class="copy"><b>' + c[1] +
                (c[5] ? '<span class="badge inline-badge" style="' + (c[5] === 'danger' ? 'border-color:var(--danger-border);background:var(--danger-soft);color:var(--danger-text)' : '') + '">' + (c[5] === 'danger' ? '高风险' : '需授权') + '</span>' : '') +
                '</b><span>' + c[2] + ' · ' + c[3] + '</span></div>' +
                '<button class="switch ' + (state.caps[c[0]] ? 'on' : '') + '" data-action="toggle-cap" data-id="' + c[0] + '" aria-label="' + c[1] + '"></button></div>'
            ).join('') +
            '</section>' +
            '<section class="set-card">' +
            '<div class="set-card-head">' + icon('terminal') + '<div><h3>危险能力</h3><p>桌宠、场景理解等插件会申请这些能力；拒绝后插件仍可运行，只是功能受限。</p></div></div>' +
            '<div class="set-row"><div class="copy"><b>插件申请时询问</b><span>每个新插件首次申请危险能力时弹窗确认</span></div><button class="switch on" data-action="flip-switch" aria-label="插件申请危险能力时询问"></button></div>' +
            '</section>';
    }

    function settingsAdvanced() {
        return '<section class="set-card">' +
            '<div class="set-card-head">' + icon('database') + '<div><h3>数据</h3><p>data/ 是唯一权威存储；Web 走本地服务，APK 走应用私有目录。</p></div></div>' +
            '<div class="field"><label>数据目录</label><input class="input" value="D:/ElainaChat-mod/data" readonly></div>' +
            '<div class="set-actions">' +
            '<button class="btn btn-ghost" data-action="export-data">' + icon('download') + '导出备份</button>' +
            '<button class="btn btn-ghost" data-action="import-data">' + icon('upload') + '导入备份</button>' +
            '<button class="btn btn-ghost" data-action="toast" data-toast="已打开日志查看器（原型演示）">' + icon('list') + '查看日志</button>' +
            '</div></section>' +
            '<section class="set-card">' +
            '<div class="set-card-head">' + icon('settings') + '<div><h3>程序</h3><p>诊断与更新。</p></div></div>' +
            '<div class="set-row"><div class="copy"><b>版本</b><span>v1.3.4 · 魔女之旅</span></div><button class="btn btn-ghost btn-sm" data-action="check-update">检查更新</button></div>' +
            '<div class="set-row"><div class="copy"><b>诊断包</b><span>收集环境、日志与插件状态，便于排查问题</span></div><button class="btn btn-ghost btn-sm" data-action="diagnostics">生成诊断包</button></div>' +
            '<div class="set-row"><div class="copy"><b>清理缓存</b><span>不会删除对话、语笺与记忆</span></div><button class="btn btn-ghost btn-sm" data-action="clear-cache">清理</button></div>' +
            '</section>' +
            '<section class="set-card">' +
            '<div class="set-card-head">' + icon('alert') + '<div><h3>危险操作</h3><p>这些操作不可撤销，请先导出备份。</p></div></div>' +
            '<div class="set-actions"><button class="btn btn-danger" data-action="toast" data-toast="清空全部数据需要二次确认（原型演示）">' + icon('trash') + '清空全部数据</button></div>' +
            '</section>';
    }

    function settingsPlugins() {
        const installed = state.mods.filter(m => m.installed);
        const galgame = state.mods.filter(m => m.id === 'galgame')[0];
        return '<section class="set-card">' +
            '<div class="set-card-head">' + icon('puzzle') + '<div><h3>已安装插件</h3><p>坏插件会被自动停用；错误只显示在对应卡片上。</p></div>' +
            '<span class="spacer"></span><button class="btn btn-ghost btn-sm" data-action="page" data-page="market">插件市场</button></div>' +
            installed.map(m => {
                const meta = DATA.installedMods.filter(x => x.id === m.id)[0];
                return '<div class="plugin-row">' +
                    '<div class="plugin-ico" style="--mod-bg:' + m.bg + ';--mod-fg:' + m.fg + '">' + esc(m.glyph) + '</div>' +
                    '<div class="copy"><b>' + esc(m.name) + '<span class="badge neutral">v' + esc(m.version) + '</span></b>' +
                    '<span>' + esc(meta ? meta.note : m.desc) + '</span></div>' +
                    '<button class="switch ' + (m.enabled ? 'on' : '') + '" data-action="toggle-installed" data-id="' + m.id + '" aria-label="' + (m.enabled ? '停用' : '启用') + ' ' + esc(m.name) + '"></button>' +
                    '</div>';
            }).join('') +
            (galgame && !galgame.enabled
                ? '<div class="plugin-error"><b>' + icon('alert') + 'Galgame 界面未能加载 · 已自动停用</b>' +
                  '原因：依赖 elaina-avatar 未就绪（register 超时 8s）。插件已写盘停用，重启不会重复报错。' +
                  '<br><code>elaina_plugin_failed_galgame = dependency_missing</code></div>'
                : '') +
            '<div class="set-actions"><button class="btn btn-ghost" data-action="toast" data-toast="已检查更新：全部插件均为最新（原型演示）">' + icon('refresh') + '检查更新</button></div>' +
            '</section>';
    }

    function settingsLogs() {
        const filters = [['all', '全部'], ['info', '信息'], ['warn', '警告'], ['error', '错误']];
        const logs = DATA.logs.filter(l => state.logFilter === 'all' || l.level === state.logFilter);
        return '<section class="set-card">' +
            '<div class="set-card-head">' + icon('list') + '<div><h3>运行日志</h3><p>只保留最近 500 条，敏感字段会自动脱敏。</p></div>' +
            '<span class="spacer"></span><button class="btn btn-ghost btn-sm" data-action="download-logs">' + icon('download') + '下载</button>' +
            '<button class="btn btn-ghost btn-sm" data-action="clear-logs">' + icon('trash') + '清空</button></div>' +
            '<div class="log-toolbar">' + filters.map(f =>
                '<button class="chip ' + (state.logFilter === f[0] ? 'active' : '') + '" data-log-filter="' + f[0] + '">' + f[1] + '</button>'
            ).join('') + '</div>' +
            '<div class="log-list" id="logList">' + logsHTML(logs) + '</div>' +
            '</section>';
    }

    function logsHTML(logs) {
        if (!logs.length) return '<div style="color:var(--text-3);padding:8px">没有匹配的日志。</div>';
        return logs.map(l => '<div class="log-line ' + l.level + '"><span class="log-time">' + esc(l.time) + '</span><span class="lvl">' + l.level + '</span><span>' + esc(l.text) + '</span></div>').join('');
    }

    function renderLogs() {
        const box = $('#logList');
        if (!box) return;
        const logs = DATA.logs.filter(l => state.logFilter === 'all' || l.level === state.logFilter);
        box.innerHTML = logsHTML(logs);
        syncChoiceGroup('[data-log-filter]', 'logFilter', state.logFilter);
    }

    /* ============================================================
       交互：导航 / 发送 / 收藏
       ============================================================ */

    function getConv() {
        return DATA.conversations.filter(c => c.id === state.conversation)[0] || DATA.conversations[0];
    }

    function goPage(page) {
        if (!page) return;
        state.page = page;
        closeDrawer();
        renderPage();
    }

    function selectConv(id) {
        const conv = DATA.conversations.filter(c => c.id === id)[0];
        if (!conv) return;
        state.conversation = id;
        state.page = 'chat';
        conv.unread = 0;
        closeDrawer();
        renderAll();
    }

    function newChat() {
        const id = 'c' + Date.now();
        DATA.conversations.unshift({
            id: id,
            title: '新的旅途',
            preview: '还没有消息',
            time: nowTime(),
            folder: 'inbox',
            pinned: false,
            unread: 0,
            model: DATA.model.name
        });
        DATA.messages[id] = [];
        state.conversation = id;
        state.page = 'chat';
        renderAll();
        if (dom.composerInput) dom.composerInput.focus();
        toast('已新建一段旅途');
    }

    function sendMessage(text) {
        const value = String(text || '').trim();
        if (!value) return;
        if (state.typing) return;

        const conv = getConv();
        const msgs = DATA.messages[conv.id] || (DATA.messages[conv.id] = []);
        if (conv.title === '新的旅途' && msgs.length === 0) {
            conv.title = value.slice(0, 14) + (value.length > 14 ? '…' : '');
        }
        msgs.push({ role: 'user', text: value, time: nowTime() });
        conv.preview = value;
        conv.time = nowTime();
        conv.unread = 0;

        if (state.page !== 'chat') state.page = 'chat';
        state.typing = true;
        clearTimeout(state.replyTimer);
        renderAll();
        updateComposerState();
        scheduleReply(conv.id);
    }

    function scheduleReply(convId) {
        clearTimeout(state.replyTimer);
        state.replyTimer = setTimeout(function () {
            const msgs = DATA.messages[convId] || (DATA.messages[convId] = []);
            const reply = DATA.replies[Math.floor(Math.random() * DATA.replies.length)];
            msgs.push({ role: 'assistant', text: reply, time: nowTime() });
            state.typing = false;

            const conv = DATA.conversations.filter(c => c.id === convId)[0];
            if (conv) {
                conv.preview = stripHTML(reply).slice(0, 42);
                conv.time = nowTime();
            }

            if (state.page === 'chat') renderPage();
            renderConversations();
            renderTopbar();
            updateComposerState();
        }, 1350);
    }

    function stopReply() {
        clearTimeout(state.replyTimer);
        state.typing = false;
        renderPage();
        updateComposerState();
    }

    function regen() {
        const conv = getConv();
        const msgs = DATA.messages[conv.id];
        if (!msgs || !msgs.length || state.typing) return;
        if (msgs[msgs.length - 1].role === 'assistant') msgs.pop();
        state.typing = true;
        renderPage();
        updateComposerState();
        scheduleReply(conv.id);
    }

    function toggleStar(btn) {
        const index = Number(btn.dataset.index);
        const conv = getConv();
        const key = conv.id + ':' + index;
        if (state.starred.has(key)) state.starred.delete(key);
        else state.starred.add(key);
        btn.classList.toggle('on', state.starred.has(key));
        toast(state.starred.has(key) ? '已收藏到语笺' : '已取消收藏');
    }

    function copyMessage(btn) {
        const index = Number(btn.dataset.index);
        const wrap = $('.msg[data-msg-index="' + index + '"]');
        if (!wrap) return;
        const bubble = $('.bubble', wrap);
        if (!bubble) return;
        copyText(bubble.innerText || bubble.textContent || '');
    }

    function copyText(text) {
        const done = function () { toast('已复制'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
        } else {
            fallbackCopy(text);
            done();
        }
    }

    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* 原型不强求 */ }
        ta.remove();
    }

    function updateComposerState() {
        if (!dom.sendBtn) return;
        const hasText = dom.composerInput && dom.composerInput.value.trim().length > 0;
        if (state.typing) {
            dom.sendBtn.disabled = false;
            dom.sendBtn.classList.add('stop');
            dom.sendBtn.innerHTML = icon('stop');
            dom.sendBtn.title = '停止生成';
            dom.sendBtn.setAttribute('aria-label', '停止生成');
        } else {
            dom.sendBtn.disabled = !hasText;
            dom.sendBtn.classList.remove('stop');
            dom.sendBtn.innerHTML = icon('send');
            dom.sendBtn.title = '发送';
            dom.sendBtn.setAttribute('aria-label', '发送');
        }
    }

    function autoGrow() {
        if (!dom.composerInput) return;
        dom.composerInput.style.height = 'auto';
        dom.composerInput.style.height = Math.min(dom.composerInput.scrollHeight, 160) + 'px';
    }

    function scrollChat() {
        requestAnimationFrame(function () {
            if (state.page === 'chat') dom.view.scrollTop = dom.view.scrollHeight;
        });
    }

    /* ============================================================
       弹窗
       ============================================================ */

    function openModal(options) {
        dom.modalTitle.textContent = options.title || '';
        dom.modalBody.innerHTML = options.body || '';
        dom.modalFoot.innerHTML = options.foot || '<button class="btn btn-ghost" data-action="close-modal">关闭</button>';
        dom.modalBox.classList.toggle('wide', !!options.wide);
        dom.modalOverlay.hidden = false;
        dom.modalBody.scrollTop = 0;
    }

    function closeModal() {
        dom.modalOverlay.hidden = true;
        dom.modalBody.innerHTML = '';
        dom.modalFoot.innerHTML = '';
    }

    function openNote(id) {
        const n = DATA.notes.filter(x => x.id === id)[0];
        if (!n) return;
        openModal({
            title: '语笺详情',
            body: '<div class="detail-quote">' + esc(n.text) + '</div>' +
                '<div class="detail-meta"><span class="badge">' + (n.type === 'quote' ? '金句' : '消息') + '</span>' +
                '<span>' + esc(n.role) + '</span><span>·</span><span>' + esc(n.source) + '</span><span>·</span><span>' + esc(n.date) + '</span>' +
                '<span class="tag">' + esc(n.tag) + '</span></div>',
            foot: '<button class="btn btn-ghost" data-action="copy-text" data-text="' + esc(n.text) + '">' + icon('copy') + '复制</button>' +
                '<button class="btn btn-ghost" data-action="unfavorite-note" data-id="' + n.id + '">取消收藏</button>' +
                '<button class="btn btn-primary" data-action="toast" data-toast="已跳转到原对话（原型演示）">跳转到对话</button>'
        });
    }

    function removeNote(id) {
        const index = DATA.notes.findIndex(n => n.id === id);
        if (index < 0) return;
        DATA.notes.splice(index, 1);
        closeModal();
        if (state.page === 'notes') renderPage();
        toast('已取消收藏');
    }

    function openDiary(id) {
        const d = DATA.diary.filter(x => x.id === id)[0];
        if (!d) return;
        const paragraphs = d.body.split('\n\n').map(p => '<p>' + esc(p) + '</p>').join('');
        openModal({
            title: d.title,
            wide: true,
            body: '<div class="detail-meta" style="margin-top:0;margin-bottom:14px"><span class="badge">' + esc(d.displayDate) + '</span>' +
                '<span>' + esc(d.place) + '</span><span>·</span><span>' + esc(d.mood) + ' · ' + d.words + ' 字</span></div>' +
                '<div style="font-size:13.5px;line-height:1.9;color:var(--text-2)">' + paragraphs + '</div>' +
                '<div class="detail-meta">' + d.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>',
            foot: '<button class="btn btn-ghost" data-action="copy-text" data-text="' + esc(d.body) + '">' + icon('copy') + '复制全文</button>' +
                '<button class="btn btn-primary" data-action="close-modal">关闭</button>'
        });
    }

    function openConvSettings() {
        const conv = getConv();
        openModal({
            title: '对话设置',
            body: '<div class="field"><label>对话标题</label><input class="input" id="convTitleInput" value="' + esc(conv.title) + '"></div>' +
                '<div class="field"><label>当前会话设定</label><textarea class="textarea" rows="5">独立世界观与人设，最多 400 字。留空则沿用全局角色卡。</textarea>' +
                '<span class="hint">会话设定只影响这一段对话，不会改动全局人设。</span></div>' +
                '<div class="set-row"><div class="copy"><b>自动整理记忆</b><span>这段对话单独开启</span></div><button class="switch on" data-action="flip-switch" aria-label="自动整理记忆"></button></div>',
            foot: '<button class="btn btn-ghost" data-action="close-modal">取消</button>' +
                '<button class="btn btn-primary" data-action="save-conv-settings" data-id="' + conv.id + '">保存</button>'
        });
    }

    function saveConvSettings(id) {
        const input = $('#convTitleInput');
        const conv = DATA.conversations.filter(c => c.id === id)[0];
        if (conv && input && input.value.trim()) conv.title = input.value.trim();
        closeModal();
        renderAll();
        toast('对话设置已保存');
    }

    function openFolderModal() {
        openModal({
            title: '新建文件夹',
            body: '<div class="field"><label>文件夹名称</label><input class="input" id="folderNameInput" placeholder="例如：北境" autofocus></div>' +
                '<p class="modal-hint">文件夹只影响对话列表的分组，不会移动存储位置。</p>',
            foot: '<button class="btn btn-ghost" data-action="close-modal">取消</button>' +
                '<button class="btn btn-primary" data-action="create-folder">新建</button>'
        });
        setTimeout(function () { const input = $('#folderNameInput'); if (input) input.focus(); }, 30);
    }

    function createFolder() {
        const input = $('#folderNameInput');
        const name = input ? input.value.trim() : '';
        if (!name) { toast('请先填写文件夹名称'); return; }
        DATA.folders.push({ id: 'f' + Date.now(), name: name });
        closeModal();
        renderConversations();
        toast('已新建文件夹「' + name + '」');
    }

    function openFoldersModal() {
        const rows = DATA.folders.map(f => {
            const count = DATA.conversations.filter(c => c.folder === f.id).length;
            return '<div class="set-row"><div class="copy"><b>' + esc(f.name) + '</b><span>' + count + ' 段对话</span></div>' +
                '<span class="badge neutral">' + count + '</span></div>';
        }).join('');
        openModal({
            title: '管理分类',
            body: rows + '<div class="field" style="margin-top:16px"><label>新建分类</label><div class="key-row">' +
                '<input class="input" id="inlineFolderInput" placeholder="分类名称">' +
                '<button class="btn btn-primary" data-action="create-folder-inline">添加</button></div></div>',
            foot: '<button class="btn btn-ghost" data-action="close-modal">关闭</button>'
        });
    }

    function createFolderInline() {
        const input = $('#inlineFolderInput');
        const name = input ? input.value.trim() : '';
        if (!name) { toast('请先填写分类名称'); return; }
        DATA.folders.push({ id: 'f' + Date.now(), name: name });
        closeModal();
        renderConversations();
        toast('已新建分类「' + name + '」');
    }

    function openMod(id) {
        const m = state.mods.filter(x => x.id === id)[0];
        if (!m) return;
        openModal({
            title: '插件详情',
            body: '<div class="mod-top" style="margin-bottom:14px"><div class="mod-icon" style="--mod-bg:' + m.bg + ';--mod-fg:' + m.fg + '">' + esc(m.glyph) + '</div>' +
                '<div class="mod-heading"><div class="mod-name">' + esc(m.name) + '</div><div class="mod-author">' + esc(m.author) + ' · v' + esc(m.version) + ' · ' + esc(m.size) + '</div></div></div>' +
                '<p style="font-size:12.5px;line-height:1.75;color:var(--text-2);margin-bottom:12px">' + esc(m.desc) + '</p>' +
                '<div class="mod-tags" style="margin-bottom:14px">' + m.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' +
                '<div class="set-row"><div class="copy"><b>状态</b><span>' + (m.installed ? (m.enabled ? '已安装并启用' : '已安装，当前停用') : '未安装') + '</span></div>' +
                '<span class="state-pill ' + (m.enabled ? 'on' : '') + '"><i class="dot"></i>' + (m.installed ? (m.enabled ? '已启用' : '已停用') : '未安装') + '</span></div>' +
                '<p class="modal-hint">插件只通过收窄的 host API 与插槽接入；坏插件会被自动停用，不会拖垮其它插件。</p>',
            foot: (m.installed
                ? '<button class="btn btn-ghost" data-action="toggle-mod" data-id="' + m.id + '" data-close="1">' + (m.enabled ? '停用' : '启用') + '</button>'
                : '<button class="btn btn-primary" data-action="install-mod" data-id="' + m.id + '" data-close="1">安装</button>') +
                '<button class="btn btn-primary" data-action="close-modal">关闭</button>'
        });
    }

    function installMod(id) {
        const m = state.mods.filter(x => x.id === id)[0];
        if (!m) return;
        m.installed = true;
        m.enabled = true;
        closeModal();
        if (state.page === 'market') renderMarketGrid();
        if (state.page === 'settings') renderPageKeepScroll();
        renderTopbar();
        toast('「' + m.name + '」已安装并启用');
    }

    function toggleMod(id) {
        const m = state.mods.filter(x => x.id === id)[0];
        if (!m || !m.installed) return;
        m.enabled = !m.enabled;
        closeModal();
        if (state.page === 'market') renderMarketGrid();
        if (state.page === 'settings') renderPageKeepScroll();
        renderTopbar();
        toast('「' + m.name + '」' + (m.enabled ? '已启用' : '已停用'));
    }

    function toggleCap(id) {
        if (!(id in state.caps)) return;
        state.caps[id] = !state.caps[id];
    }

    function renderPageKeepScroll() {
        const top = dom.view.scrollTop;
        renderPage();
        dom.view.scrollTop = top;
    }

    function testConnection(btn) {
        if (!btn || btn.disabled) return;
        const old = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = icon('refresh') + '测试中…';
        setTimeout(function () {
            if (btn.isConnected) {
                btn.disabled = false;
                btn.innerHTML = old;
            }
            toast('连接成功 · 延迟 182 ms · ' + DATA.model.name);
        }, 900);
    }

    function downloadLogs() {
        const text = DATA.logs.map(l => l.time + ' [' + l.level + '] ' + l.text).join('\n');
        try {
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'elainachat-logs-demo.txt';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            toast('日志已下载');
        } catch (e) {
            toast('当前环境不支持下载，已复制到剪贴板');
            copyText(text);
        }
    }

    /* ============================================================
       语音通话
       ============================================================ */

    function openCall() {
        state.callSeconds = 0;
        state.callLineIndex = 0;
        updateCallTimer();
        dom.callStatus.textContent = '正在聆听…';
        dom.callText.textContent = state.callLines[0];
        dom.callMute.classList.remove('muted');
        dom.callScreen.classList.add('open');
        dom.callScreen.setAttribute('aria-hidden', 'false');

        clearInterval(state.callInterval);
        state.callInterval = setInterval(function () {
            state.callSeconds += 1;
            updateCallTimer();
        }, 1000);

        clearInterval(state.callLineTimer);
        state.callLineTimer = setInterval(function () {
            state.callLineIndex = (state.callLineIndex + 1) % state.callLines.length;
            dom.callText.textContent = state.callLines[state.callLineIndex];
        }, 6500);
    }

    function closeCall(showToast) {
        clearInterval(state.callInterval);
        clearInterval(state.callLineTimer);
        dom.callScreen.classList.remove('open');
        dom.callScreen.setAttribute('aria-hidden', 'true');
        if (showToast) toast('通话已结束 · ' + formatDuration(state.callSeconds));
    }

    function updateCallTimer() {
        dom.callTimer.textContent = formatDuration(state.callSeconds);
    }

    function formatDuration(total) {
        const m = String(Math.floor(total / 60)).padStart(2, '0');
        const s = String(total % 60).padStart(2, '0');
        return m + ':' + s;
    }

    function toggleMute() {
        const muted = dom.callMute.classList.toggle('muted');
        dom.callStatus.textContent = muted ? '已静音' : '正在聆听…';
        dom.callMute.setAttribute('title', muted ? '取消静音' : '静音');
    }

    /* ============================================================
       抽屉 / 浮层 / Toast
       ============================================================ */

    function openDrawer() {
        closeLab();
        closeAttach();
        dom.announcePop.hidden = true;
        dom.listPanel.classList.add('open');
        dom.listScrim.classList.add('show');
    }

    function closeDrawer() {
        dom.listPanel.classList.remove('open');
        dom.listScrim.classList.remove('show');
    }

    function closeAttach() {
        dom.attachMenu.classList.remove('open');
        dom.attachBtn.setAttribute('aria-expanded', 'false');
    }

    function toggleAttach() {
        const open = dom.attachMenu.classList.toggle('open');
        dom.attachBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function closeLab() {
        dom.labPanel.classList.remove('open');
        dom.labFab.setAttribute('aria-expanded', 'false');
    }

    function toggleLab() {
        const open = dom.labPanel.classList.toggle('open');
        dom.labFab.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function toggleAnnounce() {
        const willOpen = dom.announcePop.hidden;
        if (!willOpen) { dom.announcePop.hidden = true; return; }
        const rect = dom.bellBtn.getBoundingClientRect();
        dom.announcePop.style.top = (rect.bottom + 8) + 'px';
        dom.announcePop.style.left = Math.max(12, rect.right - 330) + 'px';
        dom.announcePop.hidden = false;
        dom.bellBtn.classList.remove('has-dot');
    }

    function closeTransient(target) {
        if (!target.closest('#attachMenu') && !target.closest('#attachBtn')) closeAttach();
        if (!target.closest('#labPanel') && !target.closest('#labFab') && !target.closest('#labMobileBtn')) closeLab();
        if (!target.closest('#announcePop') && !target.closest('#bellBtn')) dom.announcePop.hidden = true;
    }

    function toast(message) {
        const node = document.createElement('div');
        node.className = 'toast';
        node.innerHTML = icon('check') + '<span>' + esc(message) + '</span>';
        dom.toasts.appendChild(node);
        setTimeout(function () {
            node.classList.add('out');
            setTimeout(function () { node.remove(); }, 240);
        }, 2400);
    }

    function buildLab() {
        dom.labThemes.innerHTML = DATA.themes.map(t =>
            '<button class="lab-theme" data-theme-choice="' + t.id + '">' +
            '<span class="swatch" style="background:' + t.swatches[0] + '">' +
            '<i style="background:' + t.swatches[1] + '"></i><i style="background:' + t.swatches[2] + '"></i></span>' +
            '<b>' + esc(t.name) + '</b><small>' + esc(t.desc) + '</small></button>'
        ).join('');
    }

    function renderLabState() {
        syncChoiceGroup('[data-theme-choice]', 'themeChoice', state.theme);
        syncChoiceGroup('[data-mode-choice]', 'modeChoice', state.modePref);
    }

    /* ============================================================
       事件绑定
       ============================================================ */

    function bindEvents() {
        document.addEventListener('click', function (e) {
            const themeBtn = e.target.closest('[data-theme-choice]');
            if (themeBtn) { setTheme(themeBtn.dataset.themeChoice); return; }

            const modeBtn = e.target.closest('[data-mode-choice]');
            if (modeBtn) { setMode(modeBtn.dataset.modeChoice); return; }

            const notesTab = e.target.closest('[data-notes-tab]');
            if (notesTab) {
                state.notesTab = notesTab.dataset.notesTab;
                renderPage();
                return;
            }

            const settingsTab = e.target.closest('[data-settings-tab]');
            if (settingsTab) {
                state.settingsTab = settingsTab.dataset.settingsTab;
                renderPage();
                return;
            }

            const marketFilter = e.target.closest('[data-market-filter]');
            if (marketFilter) {
                state.marketFilter = marketFilter.dataset.marketFilter;
                syncChoiceGroup('[data-market-filter]', 'marketFilter', state.marketFilter);
                renderMarketGrid();
                return;
            }

            const logFilter = e.target.closest('[data-log-filter]');
            if (logFilter) {
                state.logFilter = logFilter.dataset.logFilter;
                renderLogs();
                return;
            }

            const actionEl = e.target.closest('[data-action]');
            if (!actionEl) {
                closeTransient(e.target);
                return;
            }

            handleAction(actionEl);
        });

        dom.bellBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleAnnounce();
        });
        $('#announceClose').addEventListener('click', function () { dom.announcePop.hidden = true; });

        dom.labFab.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleLab();
        });
        const labMobileBtn = $('#labMobileBtn');
        if (labMobileBtn) {
            labMobileBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                toggleLab();
            });
        }
        $('#labClose').addEventListener('click', closeLab);

        dom.attachBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleAttach();
        });

        dom.sendBtn.addEventListener('click', function () {
            if (state.typing) { stopReply(); return; }
            sendMessage(dom.composerInput.value);
            dom.composerInput.value = '';
            autoGrow();
            updateComposerState();
        });

        dom.composerInput.addEventListener('input', function () {
            autoGrow();
            updateComposerState();
        });

        dom.composerInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (state.typing) return;
                const value = dom.composerInput.value;
                if (!value.trim()) return;
                dom.composerInput.value = '';
                autoGrow();
                updateComposerState();
                sendMessage(value);
            }
        });

        dom.callMute.addEventListener('click', toggleMute);

        dom.modalOverlay.addEventListener('click', function (e) {
            if (e.target === dom.modalOverlay) closeModal();
        });

        document.addEventListener('input', function (e) {
            const target = e.target;
            if (target.id === 'convSearch') {
                state.convQuery = target.value;
                renderConversations();
            } else if (target.id === 'notesSearch') {
                state.notesQuery = target.value;
                renderNotesGrid();
            } else if (target.id === 'marketSearch') {
                state.marketQuery = target.value;
                renderMarketGrid();
            }
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                if (!dom.modalOverlay.hidden) { closeModal(); return; }
                if (dom.callScreen.classList.contains('open')) { closeCall(false); return; }
                if (dom.labPanel.classList.contains('open')) { closeLab(); return; }
                if (!dom.announcePop.hidden) { dom.announcePop.hidden = true; return; }
                if (dom.attachMenu.classList.contains('open')) { closeAttach(); return; }
                closeDrawer();
            }

            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                if (window.innerWidth <= 980) openDrawer();
                dom.convSearch.focus();
                dom.convSearch.select();
            }
        });

        if (mq) {
            const onChange = function () {
                if (state.modePref === 'system') applyAppearance();
            };
            if (mq.addEventListener) mq.addEventListener('change', onChange);
            else if (mq.addListener) mq.addListener(onChange);
        }
    }

    function handleAction(el) {
        const action = el.dataset.action;
        const closeAfter = el.dataset.close === '1';

        switch (action) {
            case 'page': goPage(el.dataset.page); break;
            case 'open-conv': selectConv(el.dataset.id); break;
            case 'drawer-open': openDrawer(); break;
            case 'drawer-close': closeDrawer(); break;
            case 'new-chat': newChat(); break;
            case 'new-folder': openFolderModal(); break;
            case 'create-folder': createFolder(); break;
            case 'create-folder-inline': createFolderInline(); break;
            case 'manage-folders': openFoldersModal(); break;
            case 'toast': toast(el.dataset.toast || '原型演示'); break;
            case 'memory': toast('记忆整理已开始（原型演示）'); break;
            case 'call': openCall(); break;
            case 'end-call': closeCall(true); break;
            case 'call-video': toast('视频通话需要 Live2D 插件，原型中未接入'); break;
            case 'conversation-settings': openConvSettings(); break;
            case 'save-conv-settings': saveConvSettings(el.dataset.id); break;
            case 'open-settings-model': state.settingsTab = 'model'; goPage('settings'); break;
            case 'close-modal': closeModal(); break;
            case 'copy-msg': copyMessage(el); break;
            case 'star-msg': toggleStar(el); break;
            case 'regen': regen(); break;
            case 'suggest': sendMessage(el.dataset.text); break;
            case 'note-open': openNote(el.dataset.id); break;
            case 'unfavorite-note': removeNote(el.dataset.id); break;
            case 'diary-open': openDiary(el.dataset.id); break;
            case 'install-mod': installMod(el.dataset.id); break;
            case 'toggle-mod':
            case 'toggle-installed': toggleMod(el.dataset.id); break;
            case 'mod-detail': openMod(el.dataset.id); break;
            case 'copy-text': copyText(el.dataset.text); break;
            case 'set-bubble':
                state.bubble = el.dataset.bubble === 'compact' ? 'compact' : 'round';
                applyAppearance();
                $$('[data-action="set-bubble"]').forEach(b => b.classList.toggle('active', b.dataset.bubble === state.bubble));
                break;
            case 'toggle-texture':
                state.texture = !state.texture;
                applyAppearance();
                el.classList.toggle('on', state.texture);
                break;
            case 'reset-appearance': resetAppearance(); break;
            case 'toggle-cap':
                toggleCap(el.dataset.id);
                el.classList.toggle('on', !!state.caps[el.dataset.id]);
                break;
            case 'flip-switch': el.classList.toggle('on'); break;
            case 'test-connection': testConnection(el); break;
            case 'download-logs': downloadLogs(); break;
            case 'clear-logs': toast('日志已清空（原型演示）'); break;
            case 'export-data': toast('备份导出需要桌面端服务，原型中未接入'); break;
            case 'import-data': toast('备份导入需要桌面端服务，原型中未接入'); break;
            case 'diagnostics': toast('诊断包已生成（原型演示）'); break;
            case 'check-update': toast('已是最新版本 · v1.3.4'); break;
            case 'clear-cache': toast('缓存已清理（原型演示）'); break;
            default: break;
        }

        closeAttach();
        if (closeAfter) closeModal();
    }

    /* ============================================================
       工具
       ============================================================ */

    function icon(name) {
        return '<svg class="ic" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
    }

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function stripHTML(value) {
        return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    }

    function nowTime() {
        const d = new Date();
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    init();
})();
