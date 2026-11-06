(function () {
    'use strict';

    function byId(id) {
        return document.getElementById(id);
    }

    function openSettingsTab(tabId) {
        const settings = byId('railSettingsBtn');
        if (settings) settings.click();
        window.setTimeout(function () {
            const tab = document.querySelector('[data-settings-tab="' + tabId + '"]');
            if (tab) tab.click();
        }, 180);
    }

    function currentModel() {
        try {
            // 这段对话在「当前会话设定」里绑定了模型时，胶囊显示会话自己的；否则显示
            //   「默认模型」那张卡的模型名（state.settings.model 只是迁移源，不再跟随用户切换）。
            if (typeof effectiveConversationModel === 'function') {
                const convModel = String(effectiveConversationModel() || '');
                if (convModel) return convModel;
            }
            if (typeof activeChatSettings === 'function') {
                return String(activeChatSettings().model || '');
            }
            if (typeof state !== 'undefined' && state && state.settings && state.settings.model) {
                return String(state.settings.model);
            }
        } catch (e) { /* 原型增强，不影响主流程 */ }
        return '';
    }

    function syncHeaderCopy() {
        const model = currentModel();
        const label = byId('rdModelLabel');
        if (label) label.textContent = model || 'BYOK 模型';
        const title = byId('currentConversationTitle');
        const sub = byId('rdHeaderSub');
        if (!title || !sub) return;

        const isOpen = function (id) {
            const el = byId(id);
            return !!(el && !el.classList.contains('hidden'));
        };
        let titleText = '';
        let subText = '';
        const settingsOpen = isOpen('settingsOverlay');
        const achievementsOpen = isOpen('achievementsOverlay');
        const marketOpen = isOpen('marketOverlay');
        document.body.classList.toggle('rd-page-overlay-open', settingsOpen || achievementsOpen || marketOpen);
        if (settingsOpen) {
            titleText = '设置';
            subText = '外观、角色、模型与插件';
        } else if (achievementsOpen) {
            titleText = '成就';
            subText = '旅途留下的证明，事件成就会停在解锁的那一天';
        } else if (marketOpen) {
            titleText = '插件市场';
            subText = '宿主只保留对话本体，其余能力按需装卸';
        } else {
            try {
                if (typeof state !== 'undefined' && state) {
                    if (state.notesMode) {
                        titleText = '语笺';
                        subText = '收藏的消息与金句';
                    } else if (state.diaryMode) {
                        titleText = '旅行日记';
                        subText = '把值得记住的旅途片段按时间收好';
                    } else if (state.memoryPageMode) {
                        titleText = '记忆';
                        subText = '她记得的那些事，都收在这里';
                    }
                }
            } catch (e) { /* 忽略 */ }
            if (!titleText && typeof updateCurrentConversationTitle === 'function') {
                updateCurrentConversationTitle();
            }
        }

        if (titleText) title.textContent = titleText;
        sub.textContent = subText || ((model ? model + ' · ' : '') + '灰之魔女');
    }

    window.setTimeout(syncHeaderCopy, 600);
    window.setTimeout(syncHeaderCopy, 1800);

    const modelPill = byId('rdModelPill');
    if (modelPill) {
        // 胶囊在顶栏常驻，是「调这段对话的人设」最顺手的落点；切模型仍走设置页。
        modelPill.addEventListener('click', function () {
            if (typeof openConversationPromptEditor === 'function') openConversationPromptEditor();
            else openSettingsTab('tab-model');
        });
    }

    function ensureDiaryStats() {
        const page = byId('diaryPage');
        if (!page) return null;
        let stats = page.querySelector('.rd-diary-stats');
        if (stats) return stats;
        const toolbar = page.querySelector('.diary-toolbar');
        if (!toolbar) return null;
        stats = document.createElement('div');
        stats.className = 'rd-diary-stats';
        stats.innerHTML =
            '<div class="rd-diary-stat"><b data-stat="entries">0</b><span>篇日记</span></div>' +
            '<div class="rd-diary-stat"><b data-stat="words">0</b><span>累计字数</span></div>' +
            '<div class="rd-diary-stat"><b data-stat="groups">0</b><span>对话分组</span></div>';
        toolbar.insertAdjacentElement('afterend', stats);
        return stats;
    }

    function updateDiaryStats() {
        const stats = ensureDiaryStats();
        if (!stats) return;
        let diary = [];
        try {
            if (typeof state !== 'undefined' && state && state.memoryCore && Array.isArray(state.memoryCore.diary)) {
                diary = state.memoryCore.diary;
            }
        } catch (e) { /* 忽略 */ }
        const words = diary.reduce(function (sum, entry) {
            return sum + String(entry && entry.content || '').length;
        }, 0);
        const groups = new Set(diary.map(function (entry) {
            return (entry && entry.conversationId) || '';
        })).size;
        const set = function (name, value) {
            const node = stats.querySelector('[data-stat="' + name + '"]');
            if (node) node.textContent = value;
        };
        set('entries', diary.length);
        set('words', words.toLocaleString());
        set('groups', groups);
    }

    const diaryBtn = byId('railDiaryBtn');
    if (diaryBtn) diaryBtn.addEventListener('click', function () {
        window.setTimeout(updateDiaryStats, 300);
        window.setTimeout(syncHeaderCopy, 80);
    });

    // 语笺/日记/对话之间切换后，顶栏副标题跟着原型更新。
    ['railChatBtn', 'railNotesBtn', 'exitNotesBtn', 'exitDiaryBtn', 'railMemoryBtn', 'exitMemoryBtn'].forEach(function (id) {
        const btn = byId(id);
        if (btn) btn.addEventListener('click', function () { window.setTimeout(syncHeaderCopy, 80); });
    });
    window.setTimeout(updateDiaryStats, 900);
    window.setInterval(updateDiaryStats, 2000);

    function decorateAchievements() {
        const list = byId('achList');
        if (!list || list.querySelector('.rd-ach-hero')) return;
        let items = [];
        try {
            if (window.ElainaAchievements && typeof window.ElainaAchievements.list === 'function') {
                items = window.ElainaAchievements.list();
            }
        } catch (e) { return; }
        if (!Array.isArray(items) || !items.length) return;
        const unlocked = items.filter(function (item) { return item && item.unlocked; }).length;
        const pct = Math.round(unlocked / items.length * 100);
        const title = unlocked === items.length ? '旅途已经写满' : '下一枚徽章就在前面';
        const hero = document.createElement('div');
        hero.className = 'rd-ach-hero';
        hero.innerHTML =
            '<div class="rd-ach-ring" style="--p:' + pct + '"><span>' + unlocked + '/' + items.length + '</span></div>' +
            '<div class="rd-ach-copy"><div class="rd-page-eyebrow">PROGRESS</div>' +
            '<h3>' + title + '</h3>' +
            '<p>已解锁 ' + unlocked + ' 个成就，还有 ' + (items.length - unlocked) + ' 个等待遇见。</p>' +
            '<div class="rd-ach-bar"><i style="width:' + pct + '%"></i></div></div>';
        list.prepend(hero);
    }

    const achBtn = byId('railCategoriesBtn');
    if (achBtn) achBtn.addEventListener('click', function () { window.setTimeout(decorateAchievements, 450); });
    if (document.getElementById('achList')) decorateAchievements();
    const bodyObserver = new MutationObserver(function () {
        if (document.getElementById('achList')) decorateAchievements();
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    function syncDisplayControls() {
        let mode = 'light';
        try {
            if (window.ElainaTheme && typeof window.ElainaTheme.darkMode === 'function') {
                mode = window.ElainaTheme.darkMode();
            }
        } catch (e) { /* 忽略 */ }
        document.querySelectorAll('[data-rd-mode]').forEach(function (button) {
            button.classList.toggle('active', button.dataset.rdMode === mode);
        });
        const label = byId('rdCurrentTheme');
        if (label) {
            let name = '暗夜魔女书房';
            try {
                const current = window.ElainaTheme.current();
                const templates = window.ElainaTheme.templates ? window.ElainaTheme.templates() : [];
                const theme = templates.filter(function (item) { return item.id === current; })[0];
                if (theme && theme.name) name = theme.name;
            } catch (e) { /* 忽略 */ }
            label.textContent = name;
        }
    }

    document.querySelectorAll('[data-rd-mode]').forEach(function (button) {
        button.addEventListener('click', function () {
            try {
                window.ElainaTheme.setDarkMode(button.dataset.rdMode);
            } catch (e) { /* 忽略 */ }
            syncDisplayControls();
        });
    });

    document.querySelectorAll('.theme-seg').forEach(function (button) {
        button.addEventListener('click', function () {
            window.setTimeout(syncDisplayControls, 60);
        });
    });

    const themePicker = byId('themePickerBox');
    if (themePicker) {
        themePicker.addEventListener('click', function (event) {
            if (event.target.closest('.theme-tpl-card')) {
                window.setTimeout(syncDisplayControls, 80);
            }
        });
    }

    // 两个设置入口（宽屏竖栏 / 窄屏顶栏）是同一件事，同步逻辑两边都要挂。
    [byId('railSettingsBtn'), byId('headerSettingsBtn')].forEach(function (btn) {
        if (!btn) return;
        btn.addEventListener('click', function () {
            window.setTimeout(syncDisplayControls, 220);
            window.setTimeout(syncHeaderCopy, 220);
        });
    });
    window.setTimeout(syncDisplayControls, 800);

    function applyVisualPrefs() {
        let bubble = 'round';
        let texture = 'on';
        try {
            bubble = Store.getItem('elaina_rd_bubble') || 'round';
            texture = Store.getItem('elaina_rd_texture') || 'on';
        } catch (e) { /* 忽略 */ }
        document.documentElement.dataset.bubble = bubble;
        document.documentElement.dataset.texture = texture;
        document.querySelectorAll('[data-rd-bubble]').forEach(function (button) {
            button.classList.toggle('active', button.dataset.rdBubble === bubble);
        });
        const previewMode = document.getElementById('bubblePreviewMode');
        if (previewMode) previewMode.textContent = bubble === 'compact' ? '紧凑' : '圆润';
        const toggle = document.querySelector('[data-rd-texture]');
        if (toggle) toggle.classList.toggle('on', texture !== 'off');
    }

    document.querySelectorAll('[data-rd-bubble]').forEach(function (button) {
        button.addEventListener('click', function () {
            try { Store.setItem('elaina_rd_bubble', button.dataset.rdBubble); } catch (e) { /* 忽略 */ }
            applyVisualPrefs();
        });
    });

    const textureToggle = document.querySelector('[data-rd-texture]');
    if (textureToggle) {
        textureToggle.addEventListener('click', function () {
            const next = document.documentElement.dataset.texture === 'off' ? 'on' : 'off';
            try { Store.setItem('elaina_rd_texture', next); } catch (e) { /* 忽略 */ }
            applyVisualPrefs();
        });
    }

    applyVisualPrefs();

    // 求值阶段 Store 缓存可能还是空的（与 theme.js 同一处境），暴露出来让 init 在
    // Store.bootstrap() 之后重放一次；多设备同步改到气泡/光晕时也要靠它重放。
    window.ElainaRdVisual = { apply: applyVisualPrefs };

    // 系统深浅色自动翻转只改 html[data-theme]，不经过任何点击路径；不观察它，
    // 设置页三段高亮会停在翻转前的档位（顶栏三段已有同样的观察者）。
    try {
        new MutationObserver(function () { syncDisplayControls(); }).observe(
            document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) { /* 忽略 */ }

    // 手机用户没有 Enter 键，输入框提示里保留键盘快捷键只会挤占文案。
    function syncComposerPlaceholder() {
        const input = byId('textInput');
        if (!input) return;
        input.placeholder = window.matchMedia('(max-width: 980px)').matches
            ? '和伊蕾娜说点什么…'
            : '和伊蕾娜说点什么...（Enter 发送）';
    }

    syncComposerPlaceholder();
    window.addEventListener('resize', syncComposerPlaceholder);

    document.addEventListener('click', function (event) {
        const sidebarNavigation = event.target.closest('.sidebar-rail-btn') ||
            event.target.closest('.conversation-item') ||
            event.target.closest('#newConversationBtn') ||
            event.target.closest('#newCategoryBtn');
        if (!sidebarNavigation) return;

        const settings = byId('settingsOverlay');
        if (settings && !settings.classList.contains('hidden') &&
            !event.target.closest('#railSettingsBtn') && !event.target.closest('#headerSettingsBtn')) {
            const close = byId('closeSettings');
            if (close) close.click();
        }

        const achievements = byId('achievementsOverlay');
        if (achievements && !achievements.classList.contains('hidden') &&
            !event.target.closest('#railCategoriesBtn')) {
            try { window.ElainaAchievements.close(); } catch (e) { /* 忽略 */ }
        }

        const market = byId('marketOverlay');
        if (market && !market.classList.contains('hidden')) {
            const close = byId('marketClose');
            if (close) close.click();
        }
    }, true);
})();
