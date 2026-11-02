/* ============================================================================
 * 移动端外壳：底栏三格（对话 / 回忆 / 我的）、顶栏「更多」弹层、回忆分段条。
 *
 * 为什么不把这些逻辑并进既有模块：它们横跨"导航 + 页面 + 弹层"三处，塞进任何
 * 一个既有文件都会让那个文件重新长出跨领域职责。窄屏与宽屏又是两套信息架构，
 * 集中在这里才能一眼看清"窄屏多了什么、动的是哪些 id"。
 *
 * 原则：只重排宿主自己的控件，不重写业务逻辑，也不碰插件契约。
 *   · 底栏与弹层里的每一格都点击**既有的**按钮，行为完全沿用原有实现；
 *   · 插件按钮容器（#headerModSlot / #composerModSlot / #sidebarModSlot）
 *     一个都不动，插件注册的按钮继续按插槽原样出现。
 * ========================================================================== */

(function () {
    'use strict';

    var MOBILE_MQ = '(max-width: 980px)';

    function byId(id) { return document.getElementById(id); }

    /** 触发一个既有按钮的 click：窄屏只是把入口挪了位置，行为仍归原实现管。 */
    function clickExisting(id) {
        var el = byId(id);
        if (!el) return false;
        try { el.click(); return true; } catch (e) { return false; }
    }

    var ICONS = {
        chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6.5h14v9H9l-4 3v-12z"/><path d="M8 10h8M8 13h5"/></svg>',
        memories: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.5h9.5L18 7v12.5H6z"/><path d="M15.5 4.5V7H18M9 11h6M9 14.5h4"/></svg>',
        mine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.7"/><path d="M4.5 20a7.5 7.5 0 0115 0"/></svg>',
        dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
        memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h7"/><path d="M17 17h3m-1.5-1.5v3"/></svg>',
        bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.7V5a2 2 0 10-4 0v.3C7.7 6.2 6 8.4 6 11v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1"/></svg>',
        model: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M7.5 9.5h9M7.5 13h5"/></svg>',
        theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>',
        search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
        folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5A2.5 2.5 0 016.5 5h3.2l1.6 2h6.2A2.5 2.5 0 0120 9.5v7A2.5 2.5 0 0117.5 19h-11A2.5 2.5 0 014 16.5v-9z"/></svg>',
        pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.6 4.6L19 7.6"/></svg>',
        trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.8A.8.8 0 019.8 4h4.4a.8.8 0 01.8.8V7M6 7l.9 12.2a1.8 1.8 0 001.8 1.8h6.6a1.8 1.8 0 001.8-1.8L18 7"/></svg>',
        chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'
    };

    // ==================== 底栏（对话 / 回忆 / 我的） ====================

    var NAV_ITEMS = [
        { key: 'chat', label: '对话', icon: ICONS.chat },
        { key: 'memories', label: '回忆', icon: ICONS.memories },
        { key: 'mine', label: '我的', icon: ICONS.mine }
    ];

    function buildNav() {
        if (byId('mobileNav')) return;
        var nav = document.createElement('nav');
        nav.id = 'mobileNav';
        nav.setAttribute('aria-label', '主导航');
        NAV_ITEMS.forEach(function (it) {
            var b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('data-mobile-nav', it.key);
            b.setAttribute('aria-label', it.label);
            b.innerHTML = it.icon + '<span></span>';
            var label = b.lastChild;
            if (label) label.textContent = it.label;
            nav.appendChild(b);
        });
        nav.addEventListener('click', function (e) {
            var b = e.target && e.target.closest ? e.target.closest('[data-mobile-nav]') : null;
            if (!b) return;
            var key = b.getAttribute('data-mobile-nav');
            closeAchievements();
            // 设置是整页下钻，退出还有左上角返回键 —— 点底部导航就该回到对应的页
            closeSettingsIfOpen();
            if (key === 'chat') {
                closeMine();
                clickExisting('railChatBtn');
            } else if (key === 'memories') {
                closeMine();
                openMemories();
            } else if (key === 'mine') {
                // 没有 ✕ 了：再点一次「我的」就是收起
                var minePage = byId('mobileMine');
                if (minePage && minePage.classList.contains('open')) closeMine();
                else openMine();
            }
            syncNav();
        });
        document.body.appendChild(nav);
    }

    /** 进入「回忆」：任一回忆页已开着就保持原样，否则落在「记忆」（最近看的多半是它）。 */
    function openMemories() {
        closeAchievements();
        var onPage = false;
        try {
            onPage = !!(state.notesMode || state.diaryMode || state.memoryPageMode);
        } catch (e) { onPage = false; }
        if (onPage) return;
        if (typeof enterMemoryPage === 'function') enterMemoryPage();
    }

    // ==================== 回忆分段条（日记 / 记忆 / 语笺 / 成就） ====================

    var HUB_ITEMS = [
        { key: 'diary', label: '日记' },
        { key: 'memory', label: '记忆' },
        { key: 'notes', label: '语笺' },
        { key: 'ach', label: '成就' }
    ];

    /**
     * 胶囊开关里的滑块：正好是"选中那一格"的大小，圆角跟着胶囊走（999px）——
     * 选中第一格 / 最后一格时，滑块那端的半圆和胶囊那端的半圆同轴，看起来就是紧紧贴着一边。
     * 位置用 getBoundingClientRect 量，和 span/按钮的定位方式无关。
     */
    function syncCapsuleThumb(bar, pad) {
        var thumb = bar && bar.querySelector('.mm-seg-thumb');
        if (!thumb) return;
        var btn = bar.querySelector('button.active') || bar.querySelector('.tab-active');
        // clientHeight 已经不含边框，扣掉上下内边距就是内高（Element 上没有 clientBottom 这种东西）
        var inner = bar.clientHeight - pad * 2;
        if (!btn || !bar.clientWidth || inner <= 0) { thumb.style.opacity = '0'; return; }
        // 用布局偏移（offsetLeft / offsetWidth）而不是 getBoundingClientRect：
        //   浮层开合时面板正在做 scale / translate 动画，rect 量到的是"变换后"的坐标，
        //   滑块会摆歪几个像素（成就那条尤其明显）；offset* 不受 transform 影响。
        var rrWidth = btn.offsetWidth;
        if (!rrWidth) { thumb.style.opacity = '0'; return; }
        var left = btn.offsetLeft;
        // 第一次摆位（还没显过形）直接到位、不走过渡：否则滑块会从最左边"滑进来"，像没做完的动画。
        //   注意 width/height/top/opacity/transform 必须在 transition:none 期间全部写完，
        //   否则恢复过渡后再改 transform 又会动起来。
        var firstTime = thumb.style.opacity !== '1';
        if (firstTime) thumb.style.transition = 'none';
        thumb.style.width = rrWidth + 'px';
        thumb.style.height = inner + 'px';
        thumb.style.top = pad + 'px';
        thumb.style.transform = 'translateX(' + left + 'px)';
        thumb.style.opacity = '1';
        if (firstTime) {
            void thumb.offsetWidth;
            thumb.style.transition = '';
        }
    }

    /** 当前可见的那条胶囊（三页各一条，隐藏的那些 clientWidth 为 0）。 */
    function visibleHubBar() {
        var bars = document.querySelectorAll('.mobile-hub-seg');
        for (var i = 0; i < bars.length; i++) {
            if (bars[i].clientWidth > 0) return bars[i];
        }
        return null;
    }

    /** 让新那条胶囊的滑块从上一页的位置滑过来（三页同宽同位，位置可以直接沿用）。 */
    function slideThumbFrom(bar, pad, fromLeft) {
        var thumb = bar && bar.querySelector('.mm-seg-thumb');
        if (!thumb || fromLeft == null) return;
        thumb.style.transition = 'none';
        thumb.style.opacity = '1';
        syncCapsuleThumb(bar, pad);            // 先把尺寸与目标位摆好（此刻无过渡）
        var target = thumb.style.transform;
        thumb.style.transform = 'translateX(' + fromLeft + 'px)';
        void thumb.offsetWidth;
        thumb.style.transition = '';
        thumb.style.transform = target;        // 再从这里滑到目标位
    }

    function syncAllCapsuleThumbs() {
        Array.prototype.forEach.call(document.querySelectorAll('.mobile-hub-seg'), function (bar) {
            syncCapsuleThumb(bar, 4);
        });
        Array.prototype.forEach.call(document.querySelectorAll('#mobileMine .mm-seg'), function (bar) {
            syncCapsuleThumb(bar, 2);
        });
        Array.prototype.forEach.call(document.querySelectorAll('#notesPage .notes-tabs'), function (bar) {
            syncCapsuleThumb(bar, 3);
        });
    }

    /** 语笺的「消息收藏 / 金句收藏」两栏：装进一个胶囊，滑块跟着选中的一栏走。 */
    function wireNotesSeg() {
        var tabs = document.querySelector('#notesPage .notes-tabs');
        if (!tabs || tabs.querySelector('.mm-seg-thumb')) return;
        var thumb = document.createElement('span');
        thumb.className = 'mm-seg-thumb';
        thumb.setAttribute('aria-hidden', 'true');
        tabs.appendChild(thumb);
        tabs.addEventListener('click', function () {
            window.requestAnimationFrame(function () { syncCapsuleThumb(tabs, 3); });
        });
        syncCapsuleThumb(tabs, 3);
    }

    function makeHubBar() {
        var bar = document.createElement('div');
        bar.className = 'mobile-hub-seg';
        bar.setAttribute('role', 'group');
        bar.setAttribute('aria-label', '回忆分类');
        HUB_ITEMS.forEach(function (it) {
            var b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('data-hub', it.key);
            b.textContent = it.label;
            bar.appendChild(b);
        });
        var thumb = document.createElement('span');
        thumb.className = 'mm-seg-thumb';
        thumb.setAttribute('aria-hidden', 'true');
        bar.appendChild(thumb);
        return bar;
    }

    /** 成就是懒建的浮层：它第一次被打开时才存在，所以分段条也要在那之后再补。 */
    function ensureAchHub() {
        var panel = document.querySelector('#achievementsOverlay .modal-panel');
        if (!panel || panel.querySelector('.mobile-hub-seg')) return;
        panel.insertBefore(makeHubBar(), panel.firstChild);
    }

    function closeAchievements() {
        try {
            if (window.ElainaAchievements && typeof window.ElainaAchievements.close === 'function') {
                window.ElainaAchievements.close();
            }
        } catch (err) { /* 成就模块不在时忽略 */ }
    }

    /** 每个回忆页各插一条：分段条随页走，切页时不必搬运同一个节点。 */
    function buildHubBars() {
        ['notesPage', 'diaryPage', 'memoryPage'].forEach(function (pageId) {
            var page = byId(pageId);
            if (!page || page.querySelector('.mobile-hub-seg')) return;
            var bar = makeHubBar();
            var head = page.querySelector('.page-secondary-header');
            if (head && head.parentNode === page) page.insertBefore(bar, head.nextSibling);
            else page.insertBefore(bar, page.firstChild);
        });
    }

    // ==================== 记忆 / 日记：按对话筛选 ====================
    // 这两页的内容都按对话组织（日记按 conversationId 分组；记忆目前只有 diary
    //   类目带归属）。窄屏左侧没有对话列表可点，所以在页内工具栏放一颗「选择对话」，
    //   点开复用宿主的分类选择弹层列出全部对话。

    function convFilterIdOf(target) {
        try {
            return target === 'diary' ? (state.diaryFilterConvId || '') : (state.memoryFilterConvId || '');
        } catch (e) { return ''; }
    }

    function convFilterTitle(id) {
        if (!id) return '全部对话';
        var conv = (state.conversations || []).find(function (c) { return c.id === id; });
        return conv ? (conv.title || '未命名对话') : '已删除的对话';
    }

    /** 筛选变化后刷新两颗按钮的文案与高亮（两个页面的 render 也会调它）。 */
    function syncConvFilterLabels() {
        ['diary', 'memory'].forEach(function (target) {
            var btn = document.querySelector('.conv-filter-btn[data-conv-filter="' + target + '"]');
            if (!btn) return;
            var id = convFilterIdOf(target);
            var label = btn.querySelector('.conv-filter-label');
            if (label) label.textContent = convFilterTitle(id);
            btn.classList.toggle('is-filtered', !!id);
            btn.title = id ? ('只看：' + convFilterTitle(id)) : '选择一段对话，只看它的内容';
            btn.setAttribute('aria-label', btn.title);
        });
    }
    // diary.js / memory-page.js 在渲染完会调用它；它们不在本 IIFE 里，必须挂到 window。
    window.syncConvFilterLabels = syncConvFilterLabels;

    function applyConvFilter(target, id) {
        try {
            if (target === 'diary') state.diaryFilterConvId = id || '';
            else state.memoryFilterConvId = id || '';
        } catch (e) { return; }
        if (target === 'diary' && typeof renderDiaryPage === 'function') renderDiaryPage();
        if (target === 'memory' && typeof renderMemoryPage === 'function') renderMemoryPage();
        // 日记筛选还影响侧栏高亮（桌面会用到）；手机上侧栏抽屉也保持一致。
        if (target === 'diary' && typeof renderFolderList === 'function') renderFolderList();
        syncConvFilterLabels();
    }

    function openConvFilterPicker(target) {
        var overlay = byId('conversationMoveOverlay');
        var list = byId('conversationMoveList');
        var title = byId('conversationMoveTitle');
        if (!overlay || !list) return;
        if (title) title.textContent = '按对话筛选';
        var current = convFilterIdOf(target);
        list.innerHTML = '';
        var addRow = function (id, name, icon) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'conversation-move-option' + (id === current ? ' is-current' : '');
            row.innerHTML = icon + '<span></span>';
            row.lastChild.textContent = name;
            row.addEventListener('click', function () {
                applyConvFilter(target, id);
                try { closeConversationMoveDialog(); } catch (e) { /* 忽略 */ }
            });
            list.appendChild(row);
        };
        addRow('', '全部对话', ICONS.memories);
        var convs = (state.conversations || []).slice();
        convs.forEach(function (c) { addRow(c.id, c.title || '未命名对话', ICONS.chat); });
        if (!convs.length) {
            var empty = document.createElement('div');
            empty.className = 'conv-filter-empty';
            empty.textContent = '还没有对话。';
            list.appendChild(empty);
        }
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
    }

    function buildConvFilters() {
        [['diary', '#diaryPage .diary-toolbar'], ['memory', '#memoryPage .memory-toolbar']].forEach(function (pair) {
            var bar = document.querySelector(pair[1]);
            if (!bar || bar.querySelector('.conv-filter-btn')) return;
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'conv-filter-btn';
            btn.setAttribute('data-conv-filter', pair[0]);
            btn.innerHTML = ICONS.chat + '<span class="conv-filter-label">全部对话</span>' + ICONS.chevron;
            btn.addEventListener('click', function () { openConvFilterPicker(pair[0]); });
            bar.insertBefore(btn, bar.firstChild);
        });
        syncConvFilterLabels();
    }

    /**
     * 三个回忆页各由自己的 enter 函数显示，而那些函数只负责藏起"除自己以外的一部分"：
     * 直接从「记忆」切「日记」时，memoryPage 不会被前者藏起来，两页会叠着显示。
     * 分段条允许任意跳转，所以切换前先把另外两类收掉，不依赖各 enter 的假设。
     */
    function leaveOtherModes(except) {
        try {
            if (except !== 'notes' && state.notesMode && typeof exitNotesMode === 'function') exitNotesMode();
            if (except !== 'diary' && state.diaryMode && typeof exitDiaryMode === 'function') exitDiaryMode();
            if (except !== 'memory' && state.memoryPageMode && typeof exitMemoryPage === 'function') exitMemoryPage();
        } catch (err) { /* state 未就绪时忽略 */ }
    }

    function onHubClick(e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-hub]') : null;
        if (!b) return;
        var key = b.getAttribute('data-hub');
        // 切页前先记下"当前那条胶囊的滑块在哪"：每页各有一条胶囊，
        //   切过去以后让新条从旧位置滑到新位置，才看得出是同一个开关在动。
        var prevLeft = null;
        var prevBar = visibleHubBar();
        if (prevBar) {
            var pt = prevBar.querySelector('.mm-seg-thumb');
            if (pt && pt.style.opacity === '1') {
                var pbr = prevBar.getBoundingClientRect();
                prevLeft = Math.round(pt.getBoundingClientRect().left - pbr.left);
            }
        }
        if (key === 'ach') {
            // 成就是同一段分段条里的一格：再点一次收起，和其它三格的切换语义一致。
            var wasOpen = false;
            try {
                wasOpen = !!(window.ElainaAchievements && typeof window.ElainaAchievements.isOpen === 'function'
                    && window.ElainaAchievements.isOpen());
            } catch (e) { wasOpen = false; }
            try {
                if (wasOpen) closeAchievements();
                else if (window.ElainaAchievements && typeof window.ElainaAchievements.open === 'function') {
                    window.ElainaAchievements.open();
                    ensureAchHub();
                    // 先把高亮落到「成就」，再让内容滑进来、滑块从上一格滑过去 ——
                    //   否则打开时是一整块直接出现（其它三页是滑进来的，手感对不上）。
                    syncHubBars();
                    var panel = document.querySelector('#achievementsOverlay .modal-panel');
                    if (panel) slideChildren(panel, 1);
                    var achBar = panel && panel.querySelector('.mobile-hub-seg');
                    if (achBar && prevLeft != null) slideThumbFrom(achBar, 4, prevLeft);
                }
            } catch (err) { /* 成就模块不在时忽略 */ }
            syncNav();
            return;
        }
        var prev = currentHubKey();
        closeAchievements();
        leaveOtherModes(key);
        if (key === 'diary' && typeof enterDiaryMode === 'function') enterDiaryMode();
        else if (key === 'memory' && typeof enterMemoryPage === 'function') enterMemoryPage();
        else if (key === 'notes' && typeof enterNotesMode === 'function') enterNotesMode();
        // 往右切页就从右边进来，往左切就从左边进来；从别处刚进回忆（没有上一页）只淡入
        animateHubSwitch(HUB_PAGE[key], HUB_ORDER.indexOf(key) - HUB_ORDER.indexOf(prev));
        if (prevLeft != null) slideThumbFrom(visibleHubBar(), 4, prevLeft);
        syncNav();
    }

    var HUB_ORDER = ['diary', 'memory', 'notes', 'ach'];
    var HUB_PAGE = { diary: 'diaryPage', memory: 'memoryPage', notes: 'notesPage' };

    /** 当前停在哪一格：分段条的高亮与"往左还是往右切"都按它算。 */
    function currentHubKey() {
        try {
            if (window.ElainaAchievements && typeof window.ElainaAchievements.isOpen === 'function'
                && window.ElainaAchievements.isOpen()) return 'ach';
            if (state.diaryMode) return 'diary';
            if (state.notesMode) return 'notes';
        } catch (e) { /* state 未就绪时按「记忆」算 */ }
        return 'memory';
    }

    /**
     * 切换回忆页时的左右滑入：只动页面里"除浮层以外"的直接子元素。
     * 为什么跳过 position: fixed 的子元素：给祖先加 transform 会改变 fixed 的定位参照
     *   （收藏详情、成就浮层都是 fixed），它们必须留在原地。
     */
    function animateHubSwitch(pageId, dir) {
        if (!pageId || !dir) return;
        slideChildren(byId(pageId), dir);
    }

    /** 让 el 的直接子元素（浮层除外）从左右滑入：切页与打开成就浮层共用。 */
    function slideChildren(root, dir) {
        if (!root || !dir) return;
        var cls = dir > 0 ? 'mm-slide-in-right' : 'mm-slide-in-left';
        Array.prototype.forEach.call(root.children, function (el) {
            if (!el || !el.classList || el.classList.contains('hidden')) return;
            // 浮层不能动（fixed 的定位参照会被祖先的 transform 改掉）
            if (el.classList.contains('mobile-hub-seg')) return;
            var pos = '';
            try { pos = getComputedStyle(el).position; } catch (e) { pos = ''; }
            if (pos === 'fixed') return;
            el.classList.remove('mm-slide-in-left', 'mm-slide-in-right');
            void el.offsetWidth;
            el.classList.add(cls);
            el.addEventListener('animationend', function onEnd() {
                el.classList.remove('mm-slide-in-left', 'mm-slide-in-right');
                el.removeEventListener('animationend', onEnd);
            });
        });
    }

    // ==================== 顶栏「更多」弹层 ====================

    function makeRow(icon, title, desc, onClick) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'mss-row';
        var ic = document.createElement('span');
        ic.className = 'mss-ic';
        ic.innerHTML = icon;
        var copy = document.createElement('span');
        copy.className = 'mss-copy';
        var t = document.createElement('b');
        t.textContent = title;
        var d = document.createElement('span');
        d.textContent = desc;
        copy.appendChild(t);
        copy.appendChild(d);
        row.appendChild(ic);
        row.appendChild(copy);
        row.addEventListener('click', onClick);
        return row;
    }

    function closeSheet() {
        var box = byId('mobileShellSheet');
        if (box) box.classList.remove('open');
    }

    function themeMode() {
        var mode = 'system';
        try {
            if (window.Store) {
                var v = Store.getItem('elaina_theme');
                if (v === 'light' || v === 'dark' || v === 'system') mode = v;
            }
        } catch (e) { /* 读不到就按跟随设备显示 */ }
        return mode;
    }

    function buildSheet() {
        if (byId('mobileShellSheet')) return;
        var wrap = document.createElement('div');
        wrap.id = 'mobileShellSheet';
        var backdrop = document.createElement('div');
        backdrop.className = 'mss-backdrop';
        var panel = document.createElement('div');
        panel.className = 'mss-panel';
        var handle = document.createElement('div');
        handle.className = 'mss-handle';
        var head = document.createElement('div');
        head.className = 'mss-head';
        var title = document.createElement('span');
        title.textContent = '更多';
        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'mss-close';
        close.setAttribute('aria-label', '关闭');
        close.textContent = '✕';
        head.appendChild(title);
        head.appendChild(close);
        var body = document.createElement('div');
        body.className = 'mss-body';

        body.appendChild(makeRow(ICONS.mine, '会话人设', '为这段对话单独换人设与世界观', function () {
            closeSheet();
            if (typeof openConversationPromptEditor === 'function') openConversationPromptEditor();
        }));
        body.appendChild(makeRow(ICONS.memory, '整理当前记忆', '让伊蕾娜把这段对话收进记忆', function () {
            clickExisting('headerMemoryBtn');
            closeSheet();
        }));
        body.appendChild(makeRow(ICONS.bell, '公告', '更新与活动', function () {
            clickExisting('headerAnnounceBtn');
            closeSheet();
        }));
        // 不借道 rdModelPill：那颗胶囊现在点开的是会话设定，模型切换走这里直达设置分栏。
        body.appendChild(makeRow(ICONS.model, '当前模型', '查看或切换 BYOK 模型', function () {
            closeSheet();
            openSettingsAt('tab-model');
        }));

        panel.appendChild(handle);
        panel.appendChild(head);
        panel.appendChild(body);
        wrap.appendChild(backdrop);
        wrap.appendChild(panel);
        document.body.appendChild(wrap);

        close.addEventListener('click', closeSheet);
        backdrop.addEventListener('click', closeSheet);
    }

    // ==================== 状态同步 ====================

    /** 会话页与列表页共用同一块主区，只靠 hidden 类区分；这里给出唯一判据。 */
    function inConversationView() {
        var hist = byId('conversationHistory');
        var init = byId('initialState');
        return !!(hist && !hist.classList.contains('hidden')) && !!(init && init.classList.contains('hidden'));
    }

    function syncNav() {
        var nav = byId('mobileNav');
        if (!nav) return;

        var active = 'chat';
        try {
            if (state.notesMode || state.diaryMode || state.memoryPageMode) active = 'memories';
        } catch (e) { /* state 未就绪时按「对话」显示 */ }
        try {
            if (window.ElainaAchievements && typeof window.ElainaAchievements.isOpen === 'function'
                && window.ElainaAchievements.isOpen()) active = 'memories';
        } catch (e) { /* 成就模块不在时忽略 */ }

        var minePage = byId('mobileMine');
        if (minePage && minePage.classList.contains('open')) active = 'mine';

        var settingsOpen = false;
        var settings = byId('settingsOverlay');
        if (settings) settingsOpen = !settings.classList.contains('hidden');

        // 「＋」工具卡住在主区里，而主区那层 fixed 外壳自成一个层级 ——
        //   弹层压不过 body 上的底栏。弹层开着时让底栏让位，视觉与点击都归弹层。
        var composerOpen = false;
        ['composerMoreMenu', 'initialComposerMoreMenu'].forEach(function (id) {
            var el = byId(id);
            if (el && !el.classList.contains('hidden')) composerOpen = true;
        });

        // 进会话就收起底栏：手机上的对话是"沉浸"的，输入栏直接贴底。
        var convOpen = inConversationView();

        // 多选条只属于首页列表：一旦离开首页（进会话 / 设置 / 回忆 / 我的），
        //   它就只剩一条盖在别的内容上的条子，选中集合也没有可操作的对象。
        if (convSelect.on) {
            var homeShown = false;
            try {
                var initEl = byId('initialState');
                homeShown = !!(initEl && !initEl.classList.contains('hidden'));
            } catch (e) { homeShown = false; }
            if (!homeShown || settingsOpen || active !== 'chat') exitConvSelect();
        }

        document.body.classList.toggle('mm-in-conv', convOpen);
        // 设置页保留底栏：退出还可以走左上角返回键与系统返回；点底栏也会顺手关掉设置。
        nav.classList.toggle('mobile-nav-hidden', composerOpen || convOpen);

        Array.prototype.forEach.call(nav.querySelectorAll('[data-mobile-nav]'), function (b) {
            b.classList.toggle('active', b.getAttribute('data-mobile-nav') === active);
        });

        syncMobileHeaderMode();
        syncAnnounceBadge();
        syncHubBars();
    }

    function syncHubBars() {
        var active = 'memory';
        try {
            if (state.diaryMode) active = 'diary';
            else if (state.notesMode) active = 'notes';
        } catch (e) { /* state 未就绪时按「记忆」显示 */ }
        try {
            if (window.ElainaAchievements && typeof window.ElainaAchievements.isOpen === 'function'
                && window.ElainaAchievements.isOpen()) active = 'ach';
        } catch (e) { /* 成就模块不在时忽略 */ }
        Array.prototype.forEach.call(document.querySelectorAll('.mobile-hub-seg button'), function (b) {
            b.classList.toggle('active', b.getAttribute('data-hub') === active);
        });
        wireNotesSeg();
        syncAllCapsuleThumbs();
    }

    /**
     * 状态观察会成串触发（一次切页要改好几个 class）。合并到下一帧再同步一次，
     * 免得每次 class 变动都全量查一遍 DOM —— 那正是"点一下有点顿"的来源之一。
     */
    var syncScheduled = false;
    function scheduleSyncNav() {
        if (syncScheduled) return;
        syncScheduled = true;
        var run = function () { syncScheduled = false; syncNav(); };
        if (window.requestAnimationFrame) window.requestAnimationFrame(run);
        else window.setTimeout(run, 16);
    }

    /**
     * 底栏高亮与分段条都跟着页面状态走，而状态是既有函数用一个 hidden 类表达的。
     * 监听那几个节点的 class，比在每个 enter/exit 函数里各加一句调用更省事，
     * 也不会把移动端知识渗进那些与窄屏无关的模块。
     */
    function watchState() {
        if (!window.MutationObserver) return;
        var targets = ['notesPage', 'diaryPage', 'memoryPage', 'achievementsOverlay', 'settingsOverlay', 'composerMoreMenu', 'initialComposerMoreMenu', 'announceStatusDot', 'conversationHistory'];
        var ob = new MutationObserver(function () { scheduleSyncNav(); });
        targets.forEach(function (id) {
            var el = byId(id);
            if (el) ob.observe(el, { attributes: true, attributeFilter: ['class'] });
        });

        // 消息是逐条 append 的：只在新节点进来时补头像，切会话整屏重绘也走这里。
        var hist = byId('conversationHistory');
        if (hist) new MutationObserver(function () { scheduleDecorate(); }).observe(hist, { childList: true });

        // 侧栏那份列表是"对话数据"的唯一渲染出口；它一重画，首页那份跟着重画。
        var folder = byId('folderList');
        if (folder) new MutationObserver(function () { renderMobileConvList(); }).observe(folder, { childList: true });

        var initial = byId('initialState');
        if (initial) {
            new MutationObserver(function () {
                if (!initial.classList.contains('hidden')) {
                    renderMobileConvList();
                    syncMobileQuote();
                }
            }).observe(initial, { attributes: true, attributeFilter: ['class'] });
        }

        // 金句文本由数据模块写进那个被隐藏的胶囊；它一写，首页卡片跟着变。
        ['quoteText', 'quoteSource'].forEach(function (id) {
            var el = byId(id);
            if (el) new MutationObserver(function () { syncMobileQuote(); })
                .observe(el, { childList: true, characterData: true, subtree: true });
        });

        ['quoteFavBtn'].forEach(function (id) {
            var el = byId(id);
            if (el) new MutationObserver(function () { syncMobileQuote(); })
                .observe(el, { attributes: true, attributeFilter: ['class'] });
        });
    }

    // ==================== 「我的」整页（窄屏） ====================

    var MINE_ICONS = {
        capability: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
        plugins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6v3a2 2 0 104 0V4h2v6h-3a2 2 0 100 4h3v6H9v-3a2 2 0 10-4 0v3H3v-6h3a2 2 0 100-4H3V4h6z"/></svg>',
        log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h14M5 12h14M5 18h9"/></svg>',
        about: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/></svg>',
        data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>',
        lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 118 0v2.5"/></svg>'
    };

    /** 「外观主题」那行的副标题取自主题模块，避免把主题名写死在宿主里。 */
    function themeDesc() {
        try {
            if (window.ElainaTheme && typeof window.ElainaTheme.templates === 'function') {
                var list = window.ElainaTheme.templates();
                var cur = (typeof window.ElainaTheme.current === 'function') ? window.ElainaTheme.current() : '';
                var hit = null;
                for (var i = 0; i < list.length; i++) {
                    if (list[i].id === cur) { hit = list[i]; break; }
                }
                return (hit ? hit.name : '默认') + ' · 共 ' + list.length + ' 套';
            }
        } catch (e) { /* 主题模块不在时给个泛化文案 */ }
        return '多套主题可选';
    }

    function makeMineSeg() {
        var seg = document.createElement('span');
        seg.className = 'mm-seg';
        [['system', '跟随'], ['light', '浅色'], ['dark', '深色']].forEach(function (it) {
            var b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('data-mode', it[0]);
            b.textContent = it[1];
            b.addEventListener('click', function () {
                var target = document.querySelector('#headerThemeBtn .theme-seg[data-mode="' + it[0] + '"]');
                if (target) target.click();
                syncMineThemeSeg();
            });
            seg.appendChild(b);
        });
        var thumb = document.createElement('span');
        thumb.className = 'mm-seg-thumb';
        thumb.setAttribute('aria-hidden', 'true');
        seg.appendChild(thumb);
        return seg;
    }

    function syncMineThemeSeg() {
        var cur = themeMode();
        Array.prototype.forEach.call(document.querySelectorAll('#mobileMine .mm-seg button'), function (b) {
            b.classList.toggle('active', b.getAttribute('data-mode') === cur);
        });
        Array.prototype.forEach.call(document.querySelectorAll('#mobileMine .mm-seg'), function (bar) {
            syncCapsuleThumb(bar, 2);
        });
    }

    function makeMineRow(spec) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'mm-row';
        var ic = document.createElement('span');
        ic.className = 'mm-ic';
        ic.innerHTML = spec.icon || ICONS.model;
        var copy = document.createElement('span');
        copy.className = 'mm-copy';
        var t = document.createElement('b');
        t.textContent = spec.title;
        copy.appendChild(t);
        if (spec.desc) {
            var d = document.createElement('span');
            d.textContent = spec.desc;
            if (spec.descId) d.id = spec.descId;
            copy.appendChild(d);
        }
        row.appendChild(ic);
        row.appendChild(copy);
        if (spec.seg) {
            row.appendChild(makeMineSeg());
        } else {
            var chev = document.createElement('span');
            chev.className = 'mm-chev';
            chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>';
            row.appendChild(chev);
        }
        if (spec.onClick) row.addEventListener('click', spec.onClick);
        return row;
    }

    /** 「我的」里的公告提示条：有未读带红点，点开既有的公告面板。 */
    function makeMineNotice() {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'mm-notice';
        var ic = document.createElement('span');
        ic.className = 'mm-notice-ic';
        ic.innerHTML = ICONS.bell;
        var copy = document.createElement('span');
        copy.className = 'mm-copy';
        var t = document.createElement('b');
        t.textContent = '公告';
        var d = document.createElement('span');
        d.textContent = '更新与活动';
        copy.appendChild(t);
        copy.appendChild(d);
        var badge = document.createElement('span');
        badge.className = 'mm-badge hidden';
        badge.id = 'mmNoticeBadge';
        badge.textContent = '新';
        row.appendChild(ic);
        row.appendChild(copy);
        row.appendChild(badge);
        row.addEventListener('click', function () {
            // 面板已经搬到 body（压过「我的」），所以这里**不关**「我的」——
            //   关掉会把用户甩回对话页。setTimeout 只是躲开"同一次点击判成点外面"。
            window.setTimeout(function () { clickExisting('headerAnnounceBtn'); }, 40);
        });
        return row;
    }

    function makeMineGroup(title, rows) {
        var group = document.createElement('div');
        group.className = 'mm-group';
        var head = document.createElement('div');
        head.className = 'mm-group-title';
        head.textContent = title;
        group.appendChild(head);
        rows.forEach(function (spec) { group.appendChild(makeMineRow(spec)); });
        return group;
    }

    /**
     * 打开设置并切到指定分栏：「我的」每行都落到既有分栏，不新做一套设置界面。
     * scrollId 用于大类里的小节（数据 / 密码 / 更新都在「高级」里），
     * 切过去后再把它滚进视野，否则用户仍要在一整栏里自己找。
     */
    function openSettingsAt(tab, scrollId) {
        if (typeof openSettings === 'function') openSettings();
        if (tab && typeof switchSettingsTab === 'function') {
            try { switchSettingsTab(tab); } catch (e) { /* 分栏不存在时只开设置 */ }
        }
        animateSettingsContent();
        if (scrollId) {
            window.setTimeout(function () {
                var target = byId(scrollId);
                if (!target || typeof target.scrollIntoView !== 'function') return;
                try { target.scrollIntoView({ block: 'start' }); } catch (err) { target.scrollIntoView(); }
                // 滚到的那一段闪一下底：不然"跳过去了"和"本来就在这"看不出区别
                var section = target.closest ? target.closest('section') : null;
                if (section && section.classList) {
                    section.classList.remove('mm-target-flash');
                    void section.offsetWidth;
                    section.classList.add('mm-target-flash');
                    window.setTimeout(function () { section.classList.remove('mm-target-flash'); }, 1400);
                }
            }, 30);
        }
        syncNav();
    }

    function buildMine() {
        if (byId('mobileMine')) return;
        var page = document.createElement('div');
        page.id = 'mobileMine';
        // 页头（「我的」标题 + ✕）不再需要：这一页就是底栏的一格，
        //   进出都走底栏（再点一次「我的」收起，点别的格直接换页）。
        var scroll = document.createElement('div');
        scroll.className = 'mm-scroll';

        var profile = document.createElement('button');
        profile.type = 'button';
        profile.className = 'mm-profile';
        var av = document.createElement('span');
        av.className = 'mm-avatar';
        av.textContent = '旅';
        var pcol = document.createElement('span');
        pcol.className = 'mm-copy';
        var pname = document.createElement('b');
        pname.id = 'mmProfileName';
        pname.textContent = '旅人';
        var phint = document.createElement('span');
        phint.id = 'mmProfileHint';
        phint.textContent = '编辑名称与头像';
        var pstats = document.createElement('span');
        pstats.id = 'mmProfileStats';
        pstats.className = 'mm-stats';
        pcol.appendChild(pname);
        pcol.appendChild(phint);
        pcol.appendChild(pstats);
        profile.appendChild(av);
        profile.appendChild(pcol);
        profile.addEventListener('click', function () {
            if (typeof openProfilePanel === 'function') openProfilePanel();
        });
        scroll.appendChild(profile);

        // 公告是"要主动看"的东西，放在资料卡正下方一条高亮提示，而不是埋进「更多」。
        scroll.appendChild(makeMineNotice());

        // 「外观模式」那条去掉了：外观与主题页里本来就有同一个三段开关，
        //   放在「我的」上等于把同一个设置摆两遍。
        scroll.appendChild(makeMineGroup('外观', [
            { icon: ICONS.theme, title: '外观与主题', desc: themeDesc(), descId: 'mmThemeDesc', onClick: function () { openSettingsAt('tab-appearance'); } }
        ]));

        // 每行落到**自己那一段**：只给分栏名的话，模型/语音三行、角色/世界观两行
        //   点进去都是同一页的顶部，看起来像"三个入口其实是同一个页面"。
        scroll.appendChild(makeMineGroup('模型与语音', [
            { icon: ICONS.model, title: '对话模型', desc: '默认模型 / 失败回退 / 多套配置', onClick: function () { openSettingsAt('tab-model', 'settingChatModel'); } },
            { icon: ICONS.bell, title: '语音输出', desc: 'TTS 服务商与音色', onClick: function () { openSettingsAt('tab-model', 'settingTtsProvider'); } },
            { icon: ICONS.memory, title: '语音输入', desc: 'ASR 服务商与语言', onClick: function () { openSettingsAt('tab-model', 'settingAsrApiKey'); } }
        ]));

        scroll.appendChild(makeMineGroup('角色与能力', [
            { icon: ICONS.mine, title: '人设与角色卡', desc: '角色名 / 称号 / 完整角色卡', onClick: function () { openSettingsAt('tab-character', 'characterSettingsSection'); } },
            { icon: ICONS.mine, title: '世界观', desc: '世界规则与时代背景', onClick: function () { openSettingsAt('tab-character', 'worldSettingsSection'); } },
            { icon: MINE_ICONS.capability, title: '能力与权限', desc: '记忆整理 / 联网 / 手机操作', onClick: function () { openSettingsAt('tab-capability'); } }
        ]));

        scroll.appendChild(makeMineGroup('数据与安全', [
            { icon: MINE_ICONS.data, title: '我的数据', desc: '导入 / 导出 / 局域网共享', onClick: function () { openSettingsAt('tab-advanced', 'dataSettingsSection'); } },
            { icon: MINE_ICONS.lock, title: '访问密码', desc: '本机与局域网登录凭据', onClick: function () { openSettingsAt('tab-advanced', 'authSettingsSection'); } },
            { icon: MINE_ICONS.about, title: '版本与更新', desc: '检测新版本与安装包', onClick: function () { openSettingsAt('tab-advanced', 'updateSettingsSection'); } }
        ]));

        scroll.appendChild(makeMineGroup('更多', [
            { icon: MINE_ICONS.plugins, title: '插件与扩展', desc: '插件 / 技能 / MCP', onClick: function () { openSettingsAt('tab-mods'); } },
            { icon: MINE_ICONS.log, title: '日志', desc: '按级别与模块排查', onClick: function () { openSettingsAt('tab-log'); } }
        ]));

        var version = document.createElement('div');
        version.className = 'mm-version';
        var foot = byId('appVersionFooter');
        version.textContent = (foot && foot.textContent) ? foot.textContent : 'ElainaChat';
        scroll.appendChild(version);

        page.appendChild(scroll);
        document.body.appendChild(page);
    }

    /**
     * 资料卡的数字都来自既有状态（对话数 / 记忆条数 / 已解锁成就），
     * 不在这里另存一份计数 —— 另存一份就一定会与真实数据对不上。
     */
    function syncMineProfile() {
        var name = '旅人';
        try { if (typeof getUserProfileName === 'function') name = getUserProfileName() || name; } catch (e) { /* 资料未就绪 */ }
        var b = byId('mmProfileName');
        if (b) b.textContent = name;
        var av = document.querySelector('#mobileMine .mm-avatar');
        if (av) av.textContent = String(name).slice(0, 1);

        var convs = 0;
        var days = 1;
        try {
            convs = (state.conversations || []).length;
            var earliest = 0;
            (state.conversations || []).forEach(function (c) {
                var t = new Date(c.createdAt || c.updatedAt || 0).getTime();
                if (t && (!earliest || t < earliest)) earliest = t;
            });
            if (earliest) days = Math.max(1, Math.ceil((Date.now() - earliest) / 86400000));
        } catch (e) { /* state 未就绪时按 1 天显示 */ }
        var hint = byId('mmProfileHint');
        if (hint) hint.textContent = '与伊蕾娜同行 ' + days + ' 天';

        var mem = 0;
        try {
            var core = state.memoryCore || {};
            ['diary', 'pivotal_memory', 'promise', 'preference', 'motivation', 'plan'].forEach(function (k) {
                if (Array.isArray(core[k])) mem += core[k].length;
            });
        } catch (e) { /* 记忆未加载时按 0 显示 */ }
        var ach = 0;
        try {
            var A = window.ElainaAchievements;
            if (A && Array.isArray(A.DEFS) && typeof A.isUnlocked === 'function') {
                ach = A.DEFS.filter(function (d) { return A.isUnlocked(d.id); }).length;
            }
        } catch (e) { /* 成就模块不在时按 0 显示 */ }

        var stats = byId('mmProfileStats');
        if (stats) {
            stats.innerHTML = '';
            [[convs, '对话'], [mem, '记忆'], [ach, '成就']].forEach(function (pair) {
                var cell = document.createElement('span');
                var num = document.createElement('b');
                num.textContent = String(pair[0]);
                cell.appendChild(num);
                cell.appendChild(document.createTextNode(pair[1]));
                stats.appendChild(cell);
            });
        }
    }

    function openMine() {
        buildMine();
        var page = byId('mobileMine');
        if (!page) return;
        var desc = byId('mmThemeDesc');
        if (desc) desc.textContent = themeDesc();
        syncMineThemeSeg();
        syncMineProfile();
        page.classList.add('open');
        syncNav();
    }

    function closeMine() {
        var page = byId('mobileMine');
        if (page) page.classList.remove('open');
        syncNav();
    }

    // ==================== 设置：窄屏单栏下钻 ====================
    // 窄屏不再给 7 个分栏做横向图标栏：分类由「我的」承担，设置只显示当前这一类。
    // 顶栏换成「返回 + 类名」，类名跟着既有 switchSettingsTab 的选中态走。

    function buildSettingsTitle() {
        var top = byId('settingsTopBar');
        if (!top || byId('mobileSettingsTitle')) return;
        var t = document.createElement('div');
        t.id = 'mobileSettingsTitle';
        top.appendChild(t);
    }

    /**
     * 同一颗按钮在宽屏是「关闭设置」、窄屏是「返回」：图标由 CSS 切换，
     * 无障碍名称也得跟着视口换 —— 否则读屏会把它念成"关闭设置"。
     */
    function syncSettingsBackLabel() {
        var btn = byId('closeSettings');
        if (!btn) return;
        var label = window.matchMedia(MOBILE_MQ).matches ? '返回' : '关闭设置';
        btn.title = label;
        btn.setAttribute('aria-label', label);
    }

    function settingsTitleText() {
        var btn = document.querySelector('#settingsTabNav .settings-tab-btn.active');
        var label = btn ? (btn.textContent || '').trim() : '';
        return label || '设置';
    }

    function syncSettingsTitle() {
        var t = byId('mobileSettingsTitle');
        if (t) t.textContent = settingsTitleText();
    }

    function watchSettings() {
        buildSettingsTitle();
        syncSettingsBackLabel();
        // 旋转 / 拉宽窗口后按钮会从「返回」变回「关闭」，名称要跟着换
        var mq = window.matchMedia(MOBILE_MQ);
        if (mq && mq.addEventListener) mq.addEventListener('change', syncSettingsBackLabel);
        if (!window.MutationObserver) return;
        var nav = byId('settingsTabNav');
        if (nav) new MutationObserver(syncSettingsTitle).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'] });
        var overlay = byId('settingsOverlay');
        if (overlay) {
            new MutationObserver(function () {
                if (overlay.classList.contains('hidden')) { dropSettingsHistoryEntry(); return; }
                syncSettingsTitle();
                pushSettingsHistoryEntry();
            }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
        }
        // 分栏切换（「我的」里点另一行 = switchSettingsTab）时，内容也滑一次。
        // 只在"当前分栏 id 真的变了"时触发 —— 否则动画自己加的那个类会再触发一次观察者，绕成死循环。
        var content = byId('settingsContent');
        if (content) {
            new MutationObserver(function () {
                var active = document.querySelector('#settingsContent .settings-tab-panel.active-panel');
                if (!active) return;
                if (active.id === lastSettingsPanelId) return;
                lastSettingsPanelId = active.id;
                animateSettingsContent();
            }).observe(content, { subtree: true, attributes: true, attributeFilter: ['class'] });
        }
    }

    // 上一次动画落在哪个分栏：观察者只在 id 真变了时才播，避免"动画加类→观察者→再动画"的死循环
    var lastSettingsPanelId = null;

    /**
     * 设置内容从右侧滑入：进设置、以及点「我的」里另一行换分栏时都播一次。
     * 只动**当前分栏面板**，不动外层滚动容器 —— 否则整页（连同标题栏）一起平移，
     * 看起来像"整个页面被推了一下"，而不是"这一类内容换了一屏"。
     */
    function animateSettingsContent() {
        var panel = document.querySelector('#settingsContent .settings-tab-panel.active-panel');
        if (!panel || !panel.classList) return;
        lastSettingsPanelId = panel.id;
        // 换分栏就回到顶部：停在上一栏的滚动位置会让人以为内容没变
        var content = byId('settingsContent');
        if (content) content.scrollTop = 0;
        panel.classList.remove('mm-slide-in-right');
        void panel.offsetWidth;
        panel.classList.add('mm-slide-in-right');
        panel.addEventListener('animationend', function onEnd() {
            panel.classList.remove('mm-slide-in-right');
            panel.removeEventListener('animationend', onEnd);
        });
    }

    function closeSettingsIfOpen() {
        var overlay = byId('settingsOverlay');
        if (!overlay || overlay.classList.contains('hidden')) return;
        try { closeSettingsPanel(); } catch (e) { /* 忽略：关不掉也不该挡住导航 */ }
    }

    // ---- 设置页的系统返回 ----
    // 返回有三条路：左上角返回键、系统返回手势、底部导航。手势走的是浏览器返回，
    // 所以打开设置时压一条历史记录，返回时把它吃掉并关面板。
    var settingsHistoryPushed = false;

    function pushSettingsHistoryEntry() {
        if (settingsHistoryPushed || !window.history || !history.pushState) return;
        if (!window.matchMedia('(max-width: 980px)').matches) return;
        try {
            history.pushState({ mmSettings: 1 }, '');
            settingsHistoryPushed = true;
        } catch (e) { /* 无历史 API 时退化成"只能用底部导航" */ }
    }

    function dropSettingsHistoryEntry() {
        if (!settingsHistoryPushed) return;
        settingsHistoryPushed = false;
        try { history.back(); } catch (e) { /* 忽略 */ }
    }

    window.addEventListener('popstate', function () {
        if (!settingsHistoryPushed) return;
        settingsHistoryPushed = false;
        var overlay = byId('settingsOverlay');
        if (overlay && !overlay.classList.contains('hidden')) {
            try { closeSettingsPanel(); } catch (e) { /* 忽略 */ }
        }
    });

    /**
     * 顶栏的公告入口：宿主自己的按钮在窄屏都收进了「更多」，
     * 但公告属于"要主动看"的东西，留一颗铃铛在顶栏才算显眼。
     */
    function buildAnnounceBtn() {
        var header = byId('chatHeader');
        if (!header || byId('mobileAnnounceBtn')) return;
        var b = document.createElement('button');
        b.id = 'mobileAnnounceBtn';
        b.type = 'button';
        b.title = '公告';
        b.setAttribute('aria-label', '公告');
        b.innerHTML = ICONS.bell + '<span id="mobileAnnounceDot" class="ma-dot hidden"></span>';
        // 必须挡住冒泡：宿主对"点面板外"的判定挂在 document 上，
        // 这颗铃铛不在原按钮/面板的子树里，不拦就会被同一次点击立刻判成"点了外面"。
        b.addEventListener('click', function (ev) {
            if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
            clickExisting('headerAnnounceBtn');
        });
        var more = byId('mobileMoreBtn');
        if (more) header.insertBefore(b, more); else header.appendChild(b);
    }

    /** 未读红点只有一个来源（#announceStatusDot），两处入口都照它显示。 */
    function syncAnnounceBadge() {
        var src = byId('announceStatusDot');
        var unread = !!(src && !src.classList.contains('hidden'));
        ['mobileAnnounceDot', 'mmNoticeBadge'].forEach(function (id) {
            var el = byId(id);
            if (el) el.classList.toggle('hidden', !unread);
        });
    }

    // ==================== 窄屏首页：对话列表 + 返回 ====================

    /**
     * 窄屏没有"列表在左边栏"这块常驻区域，所以首页要自己给一份最近对话。
     * 数据读 state.conversations（与侧栏同源），点击复用 switchConversation；
     * 侧栏重绘时用 observer 跟着重画，避免两处各维护一份。
     */
    function buildMobileHome() {
        var init = byId('initialState');
        if (!init || byId('mobileConvList')) return;
        // 搜索框独立于列表：列表每次重画只清自己，输入焦点不会被重画打断。
        var search = document.createElement('input');
        search.id = 'mobileConvSearch';
        search.className = 'mmc-search hidden';
        search.type = 'text';
        search.autocomplete = 'off';
        search.placeholder = '搜索对话…';
        search.setAttribute('aria-label', '搜索对话');
        search.addEventListener('input', function () { renderMobileConvList(); });
        init.appendChild(search);

        var box = document.createElement('div');
        box.id = 'mobileConvList';
        box.className = 'mobile-conv-list hidden';
        init.appendChild(box);

        buildConvSelectBar();

        // 点空白处 = 想退出多选。首页这块空白很大（金句卡、输入框、分组头、行与行的缝），
        //   随手一碰就把攒好的一批清掉太容易误触，所以先问一句（askCancelConvSelect）。
        // 用捕获阶段并停在这里：多选时这些点击只表达"退出"，不该顺带把分组收起、
        //   把输入框点开之类的副作用一起做掉。
        init.addEventListener('click', function (ev) {
            if (!convSelect.on) return;
            var t = ev.target;
            if (!t || !t.closest) return;
            if (t.closest('.mmc-item') || t.closest('#mmConvSelBar')) return;
            if (typeof ev.preventDefault === 'function') ev.preventDefault();
            if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
            askCancelConvSelect();
        }, true);
    }

    /** 列表时间：今天给时刻、昨天说「昨天」、更早给月/日 —— 「11/01」分不出是不是今天。 */
    function convTimeText(conv) {
        var d = new Date(conv && conv.updatedAt ? conv.updatedAt : NaN);
        if (isNaN(d.getTime())) return '';
        var now = new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
            return pad(d.getHours()) + ':' + pad(d.getMinutes());
        }
        var y = new Date(now.getTime() - 86400000);
        if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return '昨天';
        return pad(d.getMonth() + 1) + '/' + pad(d.getDate());
    }

    /**
     * 收起来的分组（只在本次会话里记着）。
     * 为什么不落盘：落盘就得新增一个设置键，而新增键要按 D13 三处同步
     *   （store 白名单 / Android 白名单 / server 读写）—— 为"分组收没收起"付这个代价不值。
     */
    var collapsedFolders = {};

    // 有对话被移进某个分组时先把那个分组展开（收起状态下落进去等于没看见）。
    window.__elainaExpandConvFolder = function (id) {
        if (id && collapsedFolders[id]) delete collapsedFolders[id];
    };

    /** 一段对话属于哪个分组：空串 = 未分类。 */
    function convFolderOf(conv) {
        return (conv && conv.categoryId) ? String(conv.categoryId) : '';
    }

    /**
     * 首页按「文件夹」分区铺开：置顶一组、未分类一组、每个自定义分类一组。
     * 分组头和抽屉那套用同一个 data-folder-id —— 拖拽落点因此两处共用一份逻辑；
     * 空分类也留一个头，否则就没地方把对话拖进去。
     */
    function appendConvSection(box, spec) {
        var section = document.createElement('div');
        section.className = 'mmc-section';
        section.setAttribute('data-conv-section', '');
        var head = document.createElement('div');
        head.className = 'mmc-folder';
        head.setAttribute('data-folder-id', spec.header.id);
        head.setAttribute('role', 'button');
        head.setAttribute('tabindex', '0');
        head.title = '点一下收起 / 展开';
        var ic = document.createElement('span');
        ic.className = 'mmc-folder-ic';
        ic.innerHTML = spec.header.pinned ? ICONS.pin : ICONS.folder;
        var label = document.createElement('b');
        label.textContent = spec.header.name;
        var count = document.createElement('span');
        count.className = 'mmc-folder-n';
        count.textContent = String(spec.rows.length);
        var chev = document.createElement('span');
        chev.className = 'mmc-folder-chev';
        chev.innerHTML = ICONS.chevron;
        head.appendChild(ic);
        head.appendChild(label);
        head.appendChild(count);
        head.appendChild(chev);
        // 收起 / 展开：折起来的行仍然留在 DOM 里（只是高度收成 0），
        //   不 display:none 是为了让展开时能量到真实高度、做得出动画。
        //   两层结构：外层是"裁剪框"（高度动画），内层整体上移（位移动画）——
        //   于是行是从分组头底下"滑上去"，而不是原地被裁掉。
        var wrap = document.createElement('div');
        wrap.className = 'mmc-rows';
        var inner = document.createElement('div');
        inner.className = 'space-y-0.5 mmc-rows-inner';
        wrap.appendChild(inner);
        if (collapsedFolders[spec.header.id]) {
            // 首帧就是收起的：直接给 0 高度，不走动画
            section.classList.add('is-collapsed');
            wrap.style.height = '0px';
        }
        head.addEventListener('click', function () {
            // 长按出菜单后紧跟的那次点击不该顺带把分组收起
            var until = 0;
            try { until = suppressConversationClickUntil || 0; } catch (e) { until = 0; }
            if (Date.now() < until) return;
            var next = !collapsedFolders[spec.header.id];
            collapsedFolders[spec.header.id] = next;
            animateConvSection(section, wrap, inner, next);
        });
        // 真文件夹才给菜单：「未分类」「置顶」不是分类，删不掉也不该重命名
        if (spec.header.id && spec.header.id !== '__unfiled__' && !spec.header.pinned
            && typeof bindCategoryPick === 'function') {
            bindCategoryPick(head, spec.header.id);
        }
        section.appendChild(head);

        spec.rows.forEach(function (conv) { appendConvRow(inner, conv); });
        section.appendChild(wrap);
        box.appendChild(section);
    }

    function appendConvRow(box, conv) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'mmc-item';
        item.setAttribute('data-conv-id', conv.id);
        // 勾选圈压在前面的图标（头像）上：多选时"点哪一行"与"选中的是谁"
        //   落在同一个位置上，不必再把整行改成另一种排版。
        //   头像内容跟对话绑定的卡走（绑卡 = 卡名首字，否则应用图标），与桌面侧栏同源。
        var avWrap = document.createElement('span');
        avWrap.className = 'mmc-avatar-wrap';
        var av = document.createElement('span');
        av.className = 'mmc-avatar';
        av.innerHTML = conversationAvatarMarkup(conv);
        var pick = document.createElement('span');
        pick.className = 'mmc-pick';
        pick.setAttribute('aria-hidden', 'true');
        pick.innerHTML = ICONS.check;
        avWrap.appendChild(av);
        avWrap.appendChild(pick);
        var main = document.createElement('span');
        main.className = 'mmc-main';
        var top = document.createElement('span');
        top.className = 'mmc-top';
        var title = document.createElement('span');
        title.className = 'mmc-title';
        title.textContent = conv.title || '新对话';
        var time = document.createElement('span');
        time.className = 'mmc-time';
        time.textContent = convTimeText(conv);
        top.appendChild(title);
        top.appendChild(time);
        var prev = document.createElement('span');
        prev.className = 'mmc-prev';
        try {
            prev.textContent = (typeof conversationPreviewText === 'function')
                ? conversationPreviewText(conv) : '';
        } catch (err) { prev.textContent = ''; }
        main.appendChild(top);
        main.appendChild(prev);
        item.appendChild(avWrap);
        item.appendChild(main);
        // 长按出菜单（收藏 / 置顶 / 重命名 / 分类 / 多选 / 删除）；
        // 菜单里的「多选」才进勾选态 —— 勾选框只长在这份列表的行上，所以只有这里传 onMultiSelect。
        if (typeof bindConversationPick === 'function') {
            bindConversationPick(item, conv, {
                onMultiSelect: function (id) { enterConvSelect(id); }
            });
        }
        item.addEventListener('click', function () {
            var until = 0;
            try { until = suppressConversationClickUntil || 0; } catch (e) { until = 0; }
            if (Date.now() < until) return;
            // 多选时整行就是勾选框：点一下切换选中，不再进对话。
            if (convSelect.on) { toggleConvSelect(conv.id); return; }
            if (typeof switchConversation === 'function') switchConversation(conv.id);
        });
        box.appendChild(item);
    }

    /**
     * 收起 / 展开：外层裁剪框的高度 与 内层内容的位移 同时走 ——
     *   高度 H → 0，内层 translateY 0 → -H。行于是从分组头底下**滑上去**，
     *   而不是原地被下边缘一点点裁掉（那样看着像"消失"）。
     * 为什么不用 display:none：display 不可过渡；为什么不用 grid-template-rows：旧 WebView 上没保障。
     * 行始终留在 DOM 里，所以按 DOM 顺序读列表的逻辑不受影响。
     */
    function animateConvSection(section, wrap, inner, collapsed) {
        if (!wrap || !inner) return;
        var from = wrap.getBoundingClientRect().height;
        // contentH 是这一组内容的真实高度：收起时就是当前高度，展开时用 scrollHeight 量
        var contentH = collapsed ? from : wrap.scrollHeight;
        // 起点先坐实：同一帧里直接改两次 height 不会产生过渡
        wrap.style.height = from + 'px';
        inner.style.transform = 'translateY(' + (from - contentH) + 'px)';
        void wrap.offsetHeight;
        section.classList.toggle('is-collapsed', collapsed);
        var to = collapsed ? 0 : contentH;
        wrap.style.height = to + 'px';
        // 位移和高度同步走：内容始终"贴着自己那一截"，看着是从分组头底下滑进 / 滑出
        inner.style.transform = 'translateY(' + (to - contentH) + 'px)';
        window.clearTimeout(wrap.__mmAnim);
        wrap.__mmAnim = window.setTimeout(function () {
            // 收起态必须把 0 留着（清掉内联高度会退回 auto，等于又展开）；展开态才清空
            if (collapsed) {
                wrap.style.height = '0px';
                inner.style.transform = 'translateY(' + (-contentH) + 'px)';
            } else {
                wrap.style.height = '';
                inner.style.transform = '';
            }
        }, 320);
    }

    function renderMobileConvList() {
        var box = byId('mobileConvList');
        if (!box) return;
        // 列表重画会换掉长按锚点，旧菜单留着就挂在了一个已经不在文档里的节点上。
        if (typeof closeConversationContextMenu === 'function') closeConversationContextMenu();
        var list = [];
        try { list = (state.conversations || []).slice(); } catch (e) { list = []; }
        if (!list.length) { box.classList.add('hidden'); syncConvSelectUI(); return; }

        var search = byId('mobileConvSearch');
        var kw = search ? String(search.value || '').trim().toLowerCase() : '';
        var match = function (c) { return !kw || String(c.title || '').toLowerCase().indexOf(kw) >= 0; };
        var visible = list.filter(match);

        box.innerHTML = '';
        box.classList.remove('hidden');

        var pinned = visible.filter(function (c) { return !!c.isPinned; });
        if (pinned.length) appendConvSection(box, { header: { id: '__pinned__', name: '置顶', pinned: true }, rows: pinned });

        var cats = [{ id: '', name: '未分类' }];
        try {
            (state.categories || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
                .forEach(function (c) { cats.push({ id: c.id, name: c.name }); });
        } catch (e) { /* 分类未就绪时只有未分类 */ }

        cats.forEach(function (cat) {
            var rows = visible.filter(function (c) {
                return !c.isPinned && convFolderOf(c) === cat.id;
            });
            // 搜索时把没命中的分组整个收起来；不搜索时保留空分组（它是拖拽落点）。
            if (!rows.length && kw) return;
            appendConvSection(box, { header: { id: cat.id || '__unfiled__', name: cat.name }, rows: rows });
        });
        syncHomeGreeting();
        // 重画会换掉所有行节点，选中态得按 id 重新贴回去（搜索、分组变更都会走到这里）。
        syncConvSelectUI();
    }


    // ==================== 首页多选：菜单「多选」进入，分类 / 删除 ====================

    /**
     * 多选状态。
     *
     * 为什么记 id 而不是记节点：列表会被搜索、分组变更整份重画，
     *   节点一换，挂在节点上的"选中"就全丢了；id 跟着数据走，重画后照样对得上。
     */
    var convSelect = { on: false, ids: {}, historyPushed: false, asking: false };

    function convSelectedIds() {
        var out = [];
        for (var id in convSelect.ids) {
            if (Object.prototype.hasOwnProperty.call(convSelect.ids, id)) out.push(id);
        }
        return out;
    }

    function buildConvSelectBar() {
        if (byId('mmConvSelBar')) return;
        var bar = document.createElement('div');
        bar.id = 'mmConvSelBar';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', '多选操作');

        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'mm-selbar-x';
        close.setAttribute('aria-label', '退出多选');
        close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        close.addEventListener('click', function () { exitConvSelect(); });

        var count = document.createElement('span');
        count.className = 'mm-selbar-n';
        count.setAttribute('aria-live', 'polite');

        var move = document.createElement('button');
        move.type = 'button';
        move.className = 'mm-selbar-act';
        move.innerHTML = ICONS.folder + '<span>分类</span>';
        move.addEventListener('click', function () { batchMoveSelected(); });

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'mm-selbar-act is-danger';
        del.innerHTML = ICONS.trash + '<span>删除</span>';
        del.addEventListener('click', function () { batchDeleteSelected(); });

        bar.appendChild(close);
        bar.appendChild(count);
        bar.appendChild(move);
        bar.appendChild(del);
        document.body.appendChild(bar);
    }

    /**
     * 进入多选（由长按菜单里的「多选」调用）。
     *
     * 长按菜单本身保持原样（收藏 / 置顶 / 重命名 / 分类 / 删除）：那些都是"只对这一条"的操作。
     *   进了多选之后才换成"一次处理一批"的两颗按钮（分类 / 删除）—— 这时单条操作没有意义，
     *   而六项菜单挤在一条底部横条里也放不下。
     */
    function enterConvSelect(convId) {
        if (!window.matchMedia(MOBILE_MQ).matches) return;
        if (typeof closeConversationContextMenu === 'function') closeConversationContextMenu();
        convSelect.on = true;
        if (convId) convSelect.ids[convId] = true;
        pushConvSelectHistory();
        syncConvSelectUI();
    }

    function exitConvSelect() {
        if (!convSelect.on) return;
        convSelect.on = false;
        convSelect.ids = {};
        dropConvSelectHistory();
        syncConvSelectUI();
    }

    /**
     * 「要不要取消多选」的确认：点空白处、Esc、系统返回都先走这里。
     *
     * 为什么不直接退：首页这块空白很大（金句卡、输入框、分组头、行与行的缝），
     *   随手一碰就把攒好的一批清掉，而多选本来就是"攒一批再操作"才用得上的功能。
     *   多选条上的 ✕ 是明确的退出按钮，按它的人知道自己要退出 —— 那里才直接退。
     *
     * @param {() => void} [onKeep] 用户选了"继续多选"之后调用（系统返回要据此补回历史记录）
     */
    function askCancelConvSelect(onKeep) {
        if (!convSelect.on || convSelect.asking) return;
        if (typeof showCustomConfirm !== 'function') { exitConvSelect(); return; }
        convSelect.asking = true;
        showCustomConfirm('已选中的 ' + convSelectedIds().length + ' 个对话不会被操作。', '取消多选')
            .then(function (confirmed) {
                convSelect.asking = false;
                if (confirmed) exitConvSelect();
                else if (typeof onKeep === 'function') onKeep();
            });
    }

    function toggleConvSelect(convId) {
        if (!convSelect.on) return;
        if (convSelect.ids[convId]) delete convSelect.ids[convId];
        else convSelect.ids[convId] = true;
        // 一个都不剩就等于没有可操作的对象：直接退出，不留一条"已选 0"的条子占着底边。
        if (!convSelectedIds().length) { exitConvSelect(); return; }
        syncConvSelectUI();
    }

    /** 把状态贴到 DOM 上：勾选圈、多选条、底部留白，三处始终由这一个函数决定。 */
    function syncConvSelectUI() {
        var box = byId('mobileConvList');
        var bar = byId('mmConvSelBar');
        var init = byId('initialState');

        if (convSelect.on) {
            // 别处删掉的对话不能还留在"已选"里，否则计数与实际可删的对象对不上。
            var alive = {};
            try {
                (state.conversations || []).forEach(function (c) { alive[c.id] = true; });
            } catch (e) { alive = null; }
            if (alive) {
                convSelectedIds().forEach(function (id) { if (!alive[id]) delete convSelect.ids[id]; });
            }
            if (!convSelectedIds().length) { exitConvSelect(); return; }
        }

        if (box) {
            box.classList.toggle('is-selecting', convSelect.on);
            Array.prototype.forEach.call(box.querySelectorAll('.mmc-item'), function (item) {
                var on = !!convSelect.ids[item.getAttribute('data-conv-id')];
                item.classList.toggle('is-selected', on);
                item.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
        }
        if (bar) {
            bar.classList.toggle('is-open', convSelect.on);
            var count = bar.querySelector('.mm-selbar-n');
            if (count) count.textContent = '已选 ' + convSelectedIds().length + ' 项';
        }
        // 多选条是固定层，会把列表末尾几行盖住；给首页补一段等高的底部留白。
        if (init) init.classList.toggle('is-conv-selecting', convSelect.on);
    }

    function batchMoveSelected() {
        var ids = convSelectedIds();
        if (!ids.length || typeof openConversationMoveDialog !== 'function') return;
        openConversationMoveDialog(null, ids, function () {
            exitConvSelect();
            renderMobileConvList();
        });
    }

    function batchDeleteSelected() {
        var ids = convSelectedIds();
        if (!ids.length || typeof showCustomConfirm !== 'function') return;
        showCustomConfirm('确认删除选中的 ' + ids.length + ' 个对话？').then(function (ok) {
            if (!ok) return;
            applyConvBatchDelete(ids);
        });
    }

    function applyConvBatchDelete(ids) {
        var gone = {};
        ids.forEach(function (id) { gone[id] = true; });
        try {
            state.conversations = (state.conversations || []).filter(function (c) { return !gone[c.id]; });
        } catch (e) { return; }
        // 日记 / 收藏也挂在对话上：只删对话会留下"已删除的对话"分组（单个删除走的是同一个函数）。
        if (typeof purgeConversationDependents === 'function') purgeConversationDependents(ids);
        if (typeof saveConversations === 'function') saveConversations();
        if (typeof updateNotesBadge === 'function') updateNotesBadge();
        var current = state.currentConversationId;
        if (current && gone[current]) {
            state.currentConversationId = null;
            try { Store.removeItem('elaina_open_current_conv'); } catch (e) { /* 忽略 */ }
            if (typeof showInitialState === 'function') showInitialState();
        }
        exitConvSelect();
        if (typeof renderFolderList === 'function') renderFolderList();
        renderMobileConvList();
        if (state.diaryMode && typeof renderDiaryPage === 'function') renderDiaryPage();
        if (state.memoryPageMode && typeof renderMemoryPage === 'function') renderMemoryPage();
    }

    // 多选是"浮在首页上"的一层：系统返回、Esc 都该退出它，而不是离开页面。
    function pushConvSelectHistory() {
        if (convSelect.historyPushed || !window.history || !history.pushState) return;
        if (!window.matchMedia(MOBILE_MQ).matches) return;
        try {
            history.pushState({ mmConvSelect: 1 }, '');
            convSelect.historyPushed = true;
        } catch (e) { /* 无历史 API：用多选条上的 ✕ 退出 */ }
    }

    function dropConvSelectHistory() {
        if (!convSelect.historyPushed) return;
        convSelect.historyPushed = false;
        try { history.back(); } catch (e) { /* 忽略 */ }
    }

    window.addEventListener('popstate', function () {
        if (!convSelect.historyPushed) return;
        convSelect.historyPushed = false;
        if (!convSelect.on) return;
        // 系统返回也算"取消"：先问一句，用户选择继续多选就把这条历史记录补回去
        //   （记录已被这次返回吃掉，不补的话下一次返回会直接离开首页）。
        askCancelConvSelect(pushConvSelectHistory);
    });

    window.addEventListener('keydown', function (ev) {
        if (convSelect.on && ev.key === 'Escape') askCancelConvSelect();
    });

    /**
     * 气泡里不写名字和秒级时间。
     * 消息节点由 ui.js 渲染（业务链路），AI 头像也在那条路径里（.ai-msg-avatar），
     * 这里只把时间裁到分钟，不再另插头像 —— 插了就和业务渲染的撞成两份。
     */
    function decorateMessage(item) {
        if (!item || item.getAttribute('data-mm-decor') === '1') return;
        item.setAttribute('data-mm-decor', '1');
        var stamp = item.querySelector('.text-xs.text-indigo-300');
        if (stamp) stamp.textContent = String(stamp.textContent || '').replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
    }

    function decorateMessages() {
        var hist = byId('conversationHistory');
        if (!hist) return;
        Array.prototype.forEach.call(hist.querySelectorAll('.message-item'), decorateMessage);
    }

    var decorateScheduled = false;
    function scheduleDecorate() {
        if (decorateScheduled) return;
        decorateScheduled = true;
        var run = function () { decorateScheduled = false; decorateMessages(); };
        if (window.requestAnimationFrame) window.requestAnimationFrame(run);
        else window.setTimeout(run, 16);
    }

    // ==================== 首页输入框：点一下直接进对话（草稿态） ====================

    var DRAFT_ANIM_MS = 280;

    function reduceMotion() {
        try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
    }

    /** 把首页那条输入框复制一份，从原位滑到底部输入栏的位置，做"同一个框落下去"的观感。 */
    function flyComposerToBottom(from) {
        var bar = byId('inputBar');
        if (!bar || !from) return;
        var to = bar.getBoundingClientRect();
        var ghost = document.createElement('div');
        ghost.className = 'mm-composer-ghost';
        var inner = document.createElement('div');
        inner.className = 'mm-composer-ghost-inner';
        inner.textContent = '和伊蕾娜说点什么…';
        ghost.appendChild(inner);
        ghost.style.left = from.left + 'px';
        ghost.style.top = from.top + 'px';
        ghost.style.width = from.width + 'px';
        ghost.style.height = from.height + 'px';
        document.body.appendChild(ghost);
        var drop = function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); };
        var seconds = (DRAFT_ANIM_MS / 1000) + 's';
        window.requestAnimationFrame(function () {
            ghost.style.transition = 'left ' + seconds + ' cubic-bezier(.22,.75,.25,1), top ' + seconds
                + ' cubic-bezier(.22,.75,.25,1), width ' + seconds + ' cubic-bezier(.22,.75,.25,1), height '
                + seconds + ' cubic-bezier(.22,.75,.25,1), opacity ' + seconds;
            ghost.style.left = '12px';
            ghost.style.width = Math.max(260, window.innerWidth - 24) + 'px';
            ghost.style.top = (to.top + 6) + 'px';
            ghost.style.height = Math.max(38, to.height - 20) + 'px';
            ghost.style.opacity = '.25';
            window.setTimeout(drop, DRAFT_ANIM_MS + 80);
        });
    }

    /**
     * 首页点输入框 = 直接开始一段对话，但**先不建会话记录**：
     * 真正发消息那条路径（handleTextSubmit）才会 createConversation，
     * 所以什么都没发就返回的话，列表里不会多一条空的「新对话」。
     */
    function enterDraftChat() {
        var init = byId('initialState');
        var shell = init ? init.querySelector('.initial-composer-shell') : null;
        var from = (shell && !reduceMotion()) ? shell.getBoundingClientRect() : null;
        var homeInput = byId('initialTextInput');
        var typed = homeInput ? String(homeInput.value || '') : '';

        try { state.currentConversationId = null; } catch (e) { /* state 未就绪 */ }

        if (init) init.classList.add('hidden');
        var hist = byId('conversationHistory');
        if (hist) { hist.innerHTML = ''; hist.classList.remove('hidden'); }
        var bar = byId('inputBar');
        if (bar) bar.classList.remove('hidden');

        var title = byId('currentConversationTitle');
        if (title) {
            var name = '伊蕾娜';
            try { name = state.characterCard.name || name; } catch (e) { /* 角色卡未就绪 */ }
            title.textContent = name;
        }

        var input = byId('textInput');
        if (input) {
            input.value = typed;
            if (homeInput) homeInput.value = '';
        }
        if (from) flyComposerToBottom(from);

        syncMobileHeaderMode();
        syncNav();
        if (typeof updateComposerSendVisibility === 'function') updateComposerSendVisibility();
        window.setTimeout(function () { if (input && input.focus) input.focus(); }, from ? DRAFT_ANIM_MS : 0);
    }

    /** 首页那条输入框只在窄屏接管；桌面端保持"输完按 Enter"的原有行为。 */
    function wireHomeComposer() {
        var shell = document.querySelector('#initialState .initial-composer-shell');
        if (!shell || shell.getAttribute('data-mm-draft') === '1') return;
        shell.setAttribute('data-mm-draft', '1');
        shell.addEventListener('pointerdown', function (ev) {
            if (!window.matchMedia(MOBILE_MQ).matches) return;
            if (ev.target && ev.target.closest && ev.target.closest('button')) return;
            // 拦住默认聚焦：焦点要落到底部那条输入框上，而不是原地闪一下再跳。
            if (typeof ev.preventDefault === 'function') ev.preventDefault();
            // 多选中点输入框：不直接进对话（那会把整批勾选静默丢掉），先问要不要取消多选。
            if (convSelect.on) { askCancelConvSelect(); return; }
            enterDraftChat();
        });
    }

    /** 回到"对话列表"：只清内存里的当前会话（不写盘，免得影响桌面端的'上次打开'）。 */
    function showMobileList() {
        try { state.currentConversationId = null; } catch (e) { /* 忽略 */ }
        if (typeof showInitialState === 'function') showInitialState();
        renderMobileConvList();
        syncNav();
    }

    /** 首页的「今日金句」卡：窄屏把被重设计层藏起来的金句以卡片形式放回来。 */
    function buildMobileQuote() {
        var init = byId('initialState');
        var composer = init ? init.querySelector('.initial-composer') : null;
        if (!init || byId('mobileQuoteCard')) return;
        var card = document.createElement('div');
        card.id = 'mobileQuoteCard';
        card.className = 'mobile-quote-card hidden';
        var eyebrow = document.createElement('div');
        eyebrow.className = 'mqc-eyebrow';
        eyebrow.textContent = '✦ 今日金句';
        var text = document.createElement('p');
        text.className = 'mqc-text';
        var foot = document.createElement('div');
        foot.className = 'mqc-foot';
        var source = document.createElement('span');
        source.className = 'mqc-source';
        var actions = document.createElement('span');
        actions.className = 'mqc-actions';
        // 只留收藏：收藏会进「回忆 → 语笺 → 金句收藏」，点赞没有对应落地页。
        var fav = document.createElement('button');
        fav.type = 'button';
        fav.className = 'mqc-act';
        fav.setAttribute('data-act-fav', '');
        fav.title = '收藏';
        fav.setAttribute('aria-label', '收藏');
                fav.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l2.4 5 5.6.8-4 3.9.9 5.5L12 16.6 7.1 19.2 8 13.7 4 9.8 9.6 9z"/></svg>';
        fav.addEventListener('click', function () {
            if (typeof toggleQuoteFavorite === 'function') toggleQuoteFavorite();
            syncMobileQuote();
        });
        actions.appendChild(fav);
        foot.appendChild(source);
        foot.appendChild(actions);
        card.appendChild(eyebrow);
        card.appendChild(text);
        card.appendChild(foot);
        if (composer && composer.parentNode === init) init.insertBefore(card, composer);
        else init.appendChild(card);
    }

    /** 金句文本与收藏态都读既有实现的状态，不另存一份。 */
    function syncMobileQuote() {
        var card = byId('mobileQuoteCard');
        if (!card) return;
        var textEl = byId('quoteText');
        var srcEl = byId('quoteSource');
        var text = textEl ? String(textEl.textContent || '').trim() : '';
        var src = srcEl ? String(srcEl.textContent || '').trim() : '';
        if (!text) { card.classList.add('hidden'); return; }
        card.classList.remove('hidden');
        var t = card.querySelector('.mqc-text');
        var s = card.querySelector('.mqc-source');
        if (t) t.textContent = text;
        if (s) s.textContent = src ? ('— ' + src) : '';
        var key = (typeof getTodayKey === 'function') ? getTodayKey() : '';
        var faved = false;
        try {
            faved = !!(state.favorites && key && state.favorites.some(function (f) {
                return f.type === 'quote' && f.quoteDate === key;
            }));
        } catch (err) { faved = false; }
        var fav = card.querySelector('[data-act-fav]');
        if (fav) fav.classList.toggle('is-on', faved);
    }

    // ==================== 首页 / 会话页两套顶栏（对齐原型） ====================

    /**
     * 原型里首页与会话页是两条不同的顶栏：
     *   首页 = 头像 + 问候 + 搜索 + 新建；会话页 = 返回 + 角色头像 + 名字 + 状态。
     * 这里把两套需要的节点都建好，靠 .is-home / .is-conv 切换可见性。
     */
    function buildHomeHeader() {
        var header = byId('chatHeader');
        if (!header) return;

        if (!byId('mobileHomeAvatar')) {
            var av = document.createElement('button');
            av.id = 'mobileHomeAvatar';
            av.type = 'button';
            av.className = 'mh-avatar';
            av.textContent = '旅';
            av.title = '我的资料';
            av.setAttribute('aria-label', '我的资料');
            av.addEventListener('click', function () {
                if (typeof openProfilePanel === 'function') openProfilePanel();
            });
            header.insertBefore(av, header.firstChild);
        }

        if (!byId('mobileHomeActions')) {
            var box = document.createElement('div');
            box.id = 'mobileHomeActions';
            var search = document.createElement('button');
            search.type = 'button';
            search.className = 'mh-act';
            search.title = '搜索对话';
            search.setAttribute('aria-label', '搜索对话');
            search.innerHTML = ICONS.search;
            // 首页现在就是完整的对话列表（含文件夹），搜索就地筛这份列表，不再去开抽屉。
            search.addEventListener('click', function (ev) {
                if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
                var input = byId('mobileConvSearch');
                if (!input) return;
                if (input.classList.contains('hidden')) {
                    input.classList.remove('hidden');
                    input.focus();
                } else {
                    input.value = '';
                    input.classList.add('hidden');
                    renderMobileConvList();
                }
            });
            // 右上角不再放「新建对话」：中间那条输入框就是入口 ——
            //   点它直接进对话（见 enterDraftChat），不需要再多一颗按钮。
            box.appendChild(search);
            var slot = byId('headerModSlot');
            if (slot && slot.parentNode === header) header.insertBefore(box, slot);
            else header.appendChild(box);
        }

        var copy = header.querySelector('.rd-header-copy');
        // 回忆的四个页面原本各写一条页头（英文眉题 + 大标题 + 返回），窄屏收成
        //   "外壳顶栏 + 分段条"两行：标题写「回忆」，具体分类由分段条表达。
        if (copy && !byId('mobileHubTitle')) {
            var hub = document.createElement('div');
            hub.id = 'mobileHubTitle';
            var hubT = document.createElement('div');
            hubT.className = 'mht-title';
            hubT.textContent = '回忆';
            var hubS = document.createElement('div');
            hubS.className = 'mht-sub';
            hubS.textContent = '她记得的每一段旅途';
            hub.appendChild(hubT);
            hub.appendChild(hubS);
            copy.appendChild(hub);
        }
        if (copy && !byId('mobileHomeGreeting')) {
            var g = document.createElement('div');
            g.id = 'mobileHomeGreeting';
            var hello = document.createElement('div');
            hello.className = 'mh-hello';
            var sub = document.createElement('div');
            sub.className = 'mh-sub';
            g.appendChild(hello);
            g.appendChild(sub);
            copy.appendChild(g);
        }
    }

    function syncHomeGreeting() {
        var g = byId('mobileHomeGreeting');
        if (!g) return;
        var hour = new Date().getHours();
        var hello = hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
        var convs = 0;
        var cats = 0;
        try { convs = (state.conversations || []).length; } catch (e) { convs = 0; }
        try { cats = (state.categories || []).length; } catch (e) { cats = 0; }
        var userName = '旅人';
        try { if (typeof getUserProfileName === 'function') userName = getUserProfileName() || userName; } catch (e) { /* 资料未就绪 */ }
        var helloEl = g.querySelector('.mh-hello');
        var subEl = g.querySelector('.mh-sub');
        if (helloEl) helloEl.textContent = hello + '，' + userName;
        if (subEl) subEl.textContent = convs + ' 段旅途 · ' + cats + ' 个分类';
        var homeAv = byId('mobileHomeAvatar');
        if (homeAv) homeAv.textContent = String(userName).slice(0, 1);
    }

    function buildBackBtn() {
        var header = byId('chatHeader');
        if (!header || byId('mobileBackBtn')) return;
        var b = document.createElement('button');
        b.id = 'mobileBackBtn';
        b.type = 'button';
        b.title = '返回对话列表';
        b.setAttribute('aria-label', '返回对话列表');
        b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 19l-7-7 7-7"/></svg>';
        b.addEventListener('click', showMobileList);
        header.insertBefore(b, header.firstChild);
    }

    /**
     * 滚动条只在滚动时亮：平时 thumb 透明，滚动开始后给 700ms 的可见窗口。
     * 为什么不用 CSS 自动淡出：这条滚动条是 ::-webkit-scrollbar 自绘的，
     *   自绘的 thumb 只要给了颜色就会一直显示（触屏上常亮很扎眼）。
     */
    function wireScrollbarFade() {
        var timers = new WeakMap();
        document.addEventListener('scroll', function (e) {
            // 文档整体滚动时 target 是 document，换成滚动元素才能挂类
            var el = (e.target === document || e.target === document.documentElement)
                ? (document.scrollingElement || document.documentElement)
                : e.target;
            if (!el || el.nodeType !== 1 || !el.classList) return;
            el.classList.add('is-scrolling');
            var t = timers.get(el);
            if (t) window.clearTimeout(t);
            timers.set(el, window.setTimeout(function () {
                el.classList.remove('is-scrolling');
                timers.delete(el);
            }, 700));
        }, true);
    }

    /** 会话页与列表页在窄屏共用同一条顶栏：进会话时把汉堡换成返回。 */
    function syncMobileHeaderMode() {
        var header = byId('chatHeader');
        if (!header) return;
        var inConv = inConversationView();
        var inPages = false;
        try { inPages = !!(state.notesMode || state.diaryMode || state.memoryPageMode); } catch (e) { inPages = false; }
        var settingsOpen = false;
        var settings = byId('settingsOverlay');
        if (settings) settingsOpen = !settings.classList.contains('hidden');
        var home = !inConv && !inPages && !settingsOpen;

        var back = byId('mobileBackBtn');
        if (back) back.classList.toggle('is-visible', inConv);

        header.classList.toggle('is-conv', inConv);
        header.classList.toggle('is-pages', inPages);
        header.classList.toggle('is-home', home);
        syncHomeGreeting();
    }

    /** 公告面板默认住在顶栏里；窄屏把它搬到 body，才能压过「我的」整页。 */
    function ensureAnnounceHost() {
        var panel = byId('announcePanel');
        var header = byId('chatHeader');
        if (!panel || !header) return;
        var mobile = window.matchMedia(MOBILE_MQ).matches;
        if (mobile) {
            if (panel.parentElement !== document.body) {
                if (!ensureAnnounceHost.home) ensureAnnounceHost.home = panel.parentElement;
                document.body.appendChild(panel);
            }
        } else if (ensureAnnounceHost.home && panel.parentElement === document.body) {
            ensureAnnounceHost.home.appendChild(panel);
        }
    }

    function buildMoreBtn() {
        var header = byId('chatHeader');
        if (!header || byId('mobileMoreBtn')) return;
        var b = document.createElement('button');
        b.id = 'mobileMoreBtn';
        b.type = 'button';
        b.title = '更多';
        b.setAttribute('aria-label', '更多');
        b.innerHTML = ICONS.dots;
        b.addEventListener('click', function () {
            buildSheet();
            var box = byId('mobileShellSheet');
            if (box) box.classList.add('open');
        });
        header.appendChild(b);
    }

    function init() {
        wireScrollbarFade();
        window.addEventListener('resize', function () { syncAllCapsuleThumbs(); });
        window.addEventListener('orientationchange', function () { window.setTimeout(syncAllCapsuleThumbs, 220); });
        if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
            // 字体晚到会改变每格宽度，圆要跟着重摆
            document.fonts.ready.then(function () { syncAllCapsuleThumbs(); }).catch(function () {});
        }
        buildNav();
        buildMoreBtn();
        buildAnnounceBtn();
        syncAnnounceBadge();
        buildHubBars();
        buildConvFilters();
        wireNotesSeg();
        buildMobileHome();
        buildMobileQuote();
        wireHomeComposer();
        buildBackBtn();
        buildHomeHeader();
        ensureAnnounceHost();
        renderMobileConvList();
        syncMobileQuote();
        watchState();
        watchSettings();
        // 成就浮层是懒建的：出现的那一刻把它并入「回忆」这套排版。
        if (window.MutationObserver) {
            new MutationObserver(function () {
                if (byId('achievementsOverlay')) ensureAchHub();
            }).observe(document.body, { childList: true });
        }
        syncNav();
        document.addEventListener('click', onHubClick);
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var mine = byId('mobileMine');
            var settings = byId('settingsOverlay');
            if (mine && mine.classList.contains('open') && (!settings || settings.classList.contains('hidden'))) closeMine();
        });
        window.addEventListener('resize', function () {
            if (!window.matchMedia(MOBILE_MQ).matches) closeMine();
            ensureAnnounceHost();
            renderMobileConvList();
            syncNav();
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
