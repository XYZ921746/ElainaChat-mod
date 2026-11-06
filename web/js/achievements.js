// 成就分两类：DEFS 里有 check 的由数据实时判定；special 的只能由事件 unlock() 上报。
// 解锁记录必须落 Store（elaina_achievements，须在 store.js 的 DATA_KEYS 里），
// 不能实时算：用户删对话后"旅途同行"不该退回未解锁，成就记录的是"做到过"。
(function () {
    'use strict';

    const KEY = 'elaina_achievements';

    /** HTML 转义。优先用宿主的 escapeHtml（同一套实现，行为一致） */
    function esc(s) {
        try {
            if (typeof escapeHtml === 'function') return escapeHtml(s);
        } catch (e) { /* 回落 */ }
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    // 顺序即展示顺序：事件成就（故事）在前，进度成就（判定）在后。

    const DEFS = [
        // 生日纪念（事件成就，由 birthday.js 上报）
        {
            id: 'stardust_day',
            title: '星屑之日',
            desc: '陪伊蕾娜度过 10 月 17 日',
            icon: '🎂',
            special: true,
            memorial: true,   // 会带一段纪念正文
        },
        {
            id: 'stardust_remembered',
            title: '记得的人',
            desc: '在她生日这天，第一句话就是「当然记得」',
            icon: '💛',
            special: true,
            memorial: true,
        },
        {
            id: 'stardust_makeup',
            title: '亡羊补牢',
            desc: '忘了生日，但认真补上了祝福',
            icon: '🌙',
            special: true,
            memorial: true,
        },
        {
            id: 'stardust_together',
            title: '今天的特别之处',
            desc: '答应陪她一起买材料、做生日蛋糕',
            icon: '🎀',
            special: true,
            memorial: true,
        },

        // 进度成就（由当前数据实时判定）
        {
            id: 'first_words',
            title: '初次相遇',
            desc: '开始第一段对话',
            icon: '💬',
            check: (ctx) => ctx.convCount >= 1,
        },
        {
            id: 'diary_keeper',
            title: '旅行日记',
            desc: '记下 5 条日记',
            icon: '📖',
            check: (ctx) => ctx.diaryCount >= 5,
        },
        {
            id: 'ten_journeys',
            title: '旅途同行',
            desc: '拥有 10 段对话',
            icon: '🧭',
            check: (ctx) => ctx.convCount >= 10,
        },
        {
            id: 'stargazer',
            title: '收集星屑',
            desc: '解锁 5 个成就',
            icon: '✨',
            check: (ctx) => ctx.unlockedCount >= 5,
        },

        {
            id: 'long_journey',
            title: '漫长的旅途',
            desc: '交换 1000 条消息',
            icon: '🗺️',
            check: (ctx) => ctx.msgCount >= 1000,
        },
        {
            id: 'midnight_talk',
            title: '深夜谈心室',
            desc: '在 00:00–03:00 之间聊过天',
            icon: '🌌',
            check: (ctx) => ctx.talkedInDeepNight,
        },
        {
            id: 'library_regular',
            title: '书斋常客',
            desc: '收藏 20 条语笺',
            icon: '🔖',
            check: (ctx) => ctx.keepsakeCount >= 20,
        },
        {
            id: 'worlds_end',
            title: '世界尽头',
            desc: '写下 30 篇旅行日记',
            icon: '📚',
            check: (ctx) => ctx.diaryCount >= 30,
        },
        {
            id: 'seven_selves',
            title: '七个自己',
            desc: '同时启用 7 个插件',
            icon: '🧩',
            check: (ctx) => ctx.modCount >= 7,
        },
        {
            id: 'witch_heir',
            title: '灰之魔女的继承者',
            desc: '解锁其余全部成就',
            icon: '👑',
            // 不把自己数进去：否则"解锁全部"永远差一个（自己）
            check: (ctx) => ctx.unlockedCount >= DEFS.length - 1,
        },
    ];

    /** 已解锁记录：{ [id]: { unlockedAt, detail } } */
    let unlocked = {};

    // 脚本求值阶段读过一次，那时 Store 缓存还是空的；bootstrap 前只读不写，
    // 否则 save() 会把空成就表推进推送队列，覆盖 data/ 里的真实记录。
    let ready = false;

    function load() {
        try {
            const raw = Store.getItem(KEY);
            const o = raw ? JSON.parse(raw) : null;
            unlocked = (o && typeof o === 'object' && o.items && typeof o.items === 'object')
                ? o.items : {};
        } catch (e) {
            // 坏数据不该让成就页打不开 —— 当作"还没解锁任何成就"
            unlocked = {};
        }
    }

    function save() {
        if (!ready) return;   // 见 ready 的说明：bootstrap 前不许写回
        try {
            Store.setItem(KEY, JSON.stringify({ version: 1, items: unlocked }));
        } catch (e) { /* 忽略：存不下不影响本次会话内的展示 */ }
    }

    // 消息 timestamp 有两种：主链路的 toLocaleTimeString()（"下午1:23:43"），
    // 以及备份导入与部分模块的 ISO 串；两种都要能认出 0～3 点。
    function messageHour(ts) {
        const s = String(ts == null ? '' : ts);
        if (!s) return null;
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
            const parsed = Date.parse(s);
            return Number.isFinite(parsed) ? new Date(parsed).getHours() : null;
        }
        const m = s.match(/(\d{1,2})\s*[:点]/);
        if (!m) return null;
        let h = parseInt(m[1], 10);
        if (/(下午|晚上|pm)/i.test(s) && h < 12) h += 12;
        else if (/(凌晨|早上|上午|am)/i.test(s) && h === 12) h = 0;
        return (h >= 0 && h <= 23) ? h : null;
    }

    /** 当前数据快照 —— 判定类成就的输入 */
    function snapshot() {
        let convCount = 0, diaryCount = 0;
        let msgCount = 0, keepsakeCount = 0, modCount = 0;
        let talkedInDeepNight = false;
        try {
            const convs = Array.isArray(state.conversations) ? state.conversations : [];
            convCount = convs.length;
            for (const conv of convs) {
                const msgs = (conv && Array.isArray(conv.messages)) ? conv.messages : [];
                msgCount += msgs.length;
                if (!talkedInDeepNight) {
                    talkedInDeepNight = msgs.some((m) => {
                        const h = messageHour(m && m.timestamp);
                        return h !== null && h < 3;
                    });
                }
            }
        } catch (e) { /* state 未就绪 */ }
        try {
            keepsakeCount = Array.isArray(state.favorites) ? state.favorites.length : 0;
        } catch (e) { /* 忽略 */ }
        try {
            diaryCount = (state.memoryCore && Array.isArray(state.memoryCore.diary))
                ? state.memoryCore.diary.length : 0;
        } catch (e) { /* 忽略 */ }
        try {
            if (window.ElainaMods && typeof window.ElainaMods.list === 'function') {
                modCount = window.ElainaMods.list().filter((m) => m && m.enabled).length;
            }
        } catch (e) { /* 忽略 */ }
        return {
            convCount, diaryCount,
            unlockedCount: Object.keys(unlocked).length,
            msgCount, keepsakeCount, modCount, talkedInDeepNight,
        };
    }

    // 重判所有进度型成就。没有 check 的定义（事件成就）直接跳过：
    // 给它们一个恒为 false 的 check 只会让定义更难读。
    // @returns {string[]} 本次新解锁的成就 id
    function evaluate() {
        const ctx = snapshot();
        const gained = [];
        for (const def of DEFS) {
            if (typeof def.check !== 'function') continue;
            if (unlocked[def.id]) continue;
            let ok = false;
            try { ok = Boolean(def.check(ctx)); } catch (e) { ok = false; }
            if (ok) {
                unlocked[def.id] = { unlockedAt: new Date().toISOString(), detail: '' };
                gained.push(def.id);
            }
        }
        if (gained.length) save();
        return gained;
    }

    // 主动解锁事件成就。id 必须在 DEFS 里，否则拼错的 id 会静默写进
    // 一条界面上永远看不到的记录。
    // @returns {boolean} 是否本次新解锁（已解锁返回 false，便于调用方避免重复庆祝）
    function unlock(id, detail) {
        if (!DEFS.some((d) => d.id === id)) return false;
        if (unlocked[id]) {
            // 已解锁时允许覆盖纪念正文：生日正文分两步生成（先解锁时已有第一句，
            // 选完「记得/忘了」才补后半句），只在为空时补写会永远丢掉后半句。
            if (detail) {
                unlocked[id] = { ...unlocked[id], detail: String(detail) };
                save();
            }
            return false;
        }
        unlocked[id] = { unlockedAt: new Date().toISOString(), detail: String(detail || '') };
        save();
        return true;
    }

    function isUnlocked(id) { return Boolean(unlocked[id]); }

    /** 成就列表（含解锁状态），供界面渲染 */
    function list() {
        return DEFS.map((d) => ({
            ...d,
            unlocked: Boolean(unlocked[d.id]),
            unlockedAt: unlocked[d.id] ? unlocked[d.id].unlockedAt : '',
            detail: unlocked[d.id] ? (unlocked[d.id].detail || '') : '',
        }));
    }

    let overlay = null;

    // 界面由 JS 建：只在打开成就页时需要，卡片数量也由 DEFS 决定。
    // id 必须用 el.id 赋值 —— check-dom-refs 靠赋值识别动态创建的 id，只写 innerHTML 会被误报悬空引用。
    // 页头沿用 page-secondary-* 类名，才能吃到 css/pages-luxe.css 的次级页排版。
    function build() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'achievementsOverlay';
        overlay.className = 'fixed inset-0 z-50 hidden items-center justify-center p-4 modal-overlay';
        overlay.innerHTML =
            '<div class="modal-panel w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden animate-modal-pop">'
              + '<div class="page-secondary-header flex-shrink-0">'
                + '<div class="page-secondary-copy">'
                  + '<div class="page-secondary-title">成就</div>'
                  + '<div class="page-secondary-subtitle">旅途留下的证明，事件成就会停在解锁的那一天</div>'
                + '</div>'
                + '<span id="achCount" class="ach-count"></span>'
                + '<button id="achCloseBtn" class="page-secondary-back" type="button" aria-label="返回">'
                  + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>'
                  + '<span>返回</span>'
                + '</button>'
              + '</div>'
              + '<div id="achList" class="flex-1 overflow-y-auto scroll-soft px-6 py-4 space-y-3"></div>'
            + '</div>';
        document.body.appendChild(overlay);

        overlay.querySelector('#achCloseBtn').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    }

    function render() {
        const box = overlay.querySelector('#achList');
        const items = list();
        const got = items.filter((i) => i.unlocked).length;
        overlay.querySelector('#achCount').textContent = got + ' / ' + items.length;

        // 已解锁排前面、未解锁排后面；同组内保持定义顺序（sort 稳定）
        const ordered = items.slice().sort((a, b) => (b.unlocked ? 1 : 0) - (a.unlocked ? 1 : 0));
        box.innerHTML = ordered.map((it) => {
            const cls = 'ach-card' + (it.unlocked ? ' is-unlocked' : '') + (it.memorial ? ' is-memorial' : '');
            // 纪念正文是模型/用户内容，esc 转义后插入，不能当 HTML 解析
            const detail = it.unlocked && it.detail
                ? '<div class="ach-detail">' + esc(it.detail) + '</div>' : '';
            const when = it.unlocked && it.unlockedAt
                ? '<div class="ach-when">' + esc(new Date(it.unlockedAt).toLocaleString('zh-CN')) + '</div>' : '';
            return '<div class="' + cls + '">'
                + '<div class="ach-icon" aria-hidden="true">' + (it.unlocked ? it.icon : '🔒') + '</div>'
                + '<div class="ach-body">'
                  + '<div class="ach-name">' + esc(it.title) + '</div>'
                  + '<div class="ach-desc">' + esc(it.desc) + '</div>'
                  + detail + when
                + '</div>'
              + '</div>';
        }).join('');
    }

    function open() {
        build();
        // 打开时重算一次进度成就 —— 用户可能是刚聊完/刚写完日记就点进来的
        evaluate();
        render();
        openOverlayPanel(overlay);
        // 成就页是"看内容"的整页：宽屏把对话面板收起来，页面拿整幅宽度。
        // 浮层打开时才建，watchSidePanel 启动时观察不到它，所以这里显式同步。
        try { if (typeof syncSidePanelForView === 'function') syncSidePanelForView(); } catch (e) { /* 忽略 */ }
        try { if (typeof setRailActive === 'function') setRailActive('categories'); }
        catch (e) { /* 忽略 */ }
    }

    function close() {
        if (!overlay) return;
        closeOverlayPanel(overlay, function () {
            try { if (typeof syncSidePanelForView === 'function') syncSidePanelForView(); } catch (e) { /* 忽略 */ }
            try { if (typeof syncRailActive === 'function') syncRailActive(); }
            catch (e) { /* 忽略 */ }
        });
    }

    function isOpen() {
        return Boolean(overlay && !overlay.classList.contains('hidden'));
    }

    load();

    window.ElainaAchievements = {
        DEFS,
        list,
        unlock,
        isUnlocked,
        evaluate,
        open,
        close,
        isOpen,
        // Store.bootstrap() 之后由 init.js 调用：脚本求值阶段读到的是空表，
        // 不重读会让每次刷新看起来"全都没解锁"。
        refresh: () => {
            ready = true;
            load();
            return Object.keys(unlocked).length;
        },
        /** 供生日模块上报纪念记录用（见 birthday.js） */
        esc,
    };
})();

