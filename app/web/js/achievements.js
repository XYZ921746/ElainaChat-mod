/* ============================================================================
 * 成就系统（生日纪念也收在这里）
 *
 * 分类功能的入口在成就面板顶部（「管理分类」），功能本身保留：
 * 删掉入口用户就没法把对话移进/移出文件夹。
 *
 * 两类成就：
 *   ① 可判定成就（DEFS 里有 check）—— 由当前数据实时算出，达到条件自动解锁；
 *   ② 事件成就（special: true）—— 无法从数据推算，只能由具体事件主动上报
 *      （unlock(id, detail)），生日纪念由 birthday 插件调用 recordMemorial()。
 *
 * 解锁结果必须持久化到 Store（elaina_achievements），不能每次实时算：
 * 用户删掉几段对话后，"旅途同行"不该又变回未解锁 —— 成就记录的是"做到过"。
 * 该键必须在 store.js 的 DATA_KEYS 白名单里，否则重刷即丢。
 * ========================================================================== */
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

    // ========================================================================
    //  成就定义
    //
    //  顺序即展示顺序：**事件成就排前面**（它们是"故事"，用户最想看），
    //    判定类成就（进度型）排后面。
    // ========================================================================

    const DEFS = [
        // ---- 生日纪念（事件成就，由 birthday.js 上报）----
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

        // ---- 进度成就（由当前数据实时判定）----
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
    ];

    // ========================================================================
    //  读写
    // ========================================================================

    /** 已解锁记录：{ [id]: { unlockedAt, detail } } */
    let unlocked = {};

    /**
     * 是否已经过了 `Store.bootstrap()`。
     *
     * 与 birthday.js 里那道闸门同一个理由：本模块在**脚本求值阶段**就
     *   `load()` 了一次，而那一刻 `Store` 缓存还是空的（`bootstrap()` 要等
     *   `init()` 才跑）—— 读到的必然是"没有任何成就"。
     *   更要紧的是 `save()`：bootstrap 之前写回会把一份**空的成就表**
     *   推进推送队列，可能覆盖掉 data/ 里用户真实的成就记录。
     *   所以 bootstrap 之前只读不写，由 `refresh()` 放行。
     */
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

    /** 当前数据快照 —— 判定类成就的输入 */
    function snapshot() {
        let convCount = 0, diaryCount = 0;
        try {
            convCount = Array.isArray(state.conversations) ? state.conversations.length : 0;
        } catch (e) { /* state 未就绪 */ }
        try {
            diaryCount = (state.memoryCore && Array.isArray(state.memoryCore.diary))
                ? state.memoryCore.diary.length : 0;
        } catch (e) { /* 忽略 */ }
        return { convCount, diaryCount, unlockedCount: Object.keys(unlocked).length };
    }

    /**
     * 重新判定所有"进度型"成就，把新达成的解锁掉。
     *
     * 为什么"星屑之日"这类事件成就不在这里判定：它们没有 `check`，
     *   只能由事件上报（见文件顶部说明）。这里跳过没有 check 的定义，
     *   而不是给它们一个恒为 false 的 check —— 后者会让"这个成就是干嘛的"
     *   变得难以阅读。
     *
     * @returns {string[]} 本次新解锁的成就 id
     */
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

    /**
     * 主动解锁一个"事件成就"。
     *
     * @param {string} id 成就 id（必须在 DEFS 里，否则忽略 —— 防止拼错 id
     *        静默写进一条界面上永远看不到的记录）
     * @param {string} [detail] 纪念正文（会显示在成就卡片里）
     * @returns {boolean} 是否**本次新解锁**（已经解锁过返回 false，便于调用方
     *          避免重复庆祝）
     */
    function unlock(id, detail) {
        if (!DEFS.some((d) => d.id === id)) return false;
        if (unlocked[id]) {
            // 已解锁：**允许刷新**纪念正文。
            //
            // 为什么是"覆盖"而不是"只在为空时补写"：
            //   生日纪念的正文是**分两步**生成的 —— 打开应用那天先写一句
            //   "10 月 17 日 · 星屑之日"，等他选完「记得 / 忘了」之后，
            //   正文里才该出现"他一开口就说『当然记得』"。
            //   若只在为空时补写，后半句永远进不去（先解锁时已经有了正文），
            //   纪念就会丢掉最该留下的那一笔。
            //   重复调用是幂等的（正文一样就还是同一段文字）。
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

    // ========================================================================
    //  界面
    // ========================================================================

    let overlay = null;

    /**
     * 建成就弹窗的骨架。
     *
     * 为什么在 JS 里建而不是写进 index.html：
     *   这块界面只有"打开成就页"时才需要，写进 HTML 会让首屏多背一段
     *   平时看不见的结构；而且成就卡片数量由 DEFS 决定，本来就该由 JS 渲染。
     *   用 `el.id = '...'` 赋值而不是只写 innerHTML 字符串 ——
     *     check-dom-refs 靠"`id=` 赋值"识别运行期动态创建的 id，
     *     只写在 innerHTML 里它认不出来，会把 getElementById 误报成悬空引用。
     */
    function build() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'achievementsOverlay';
        overlay.className = 'fixed inset-0 z-50 hidden items-center justify-center p-4 modal-overlay';
        overlay.innerHTML =
            '<div class="modal-panel w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden animate-modal-pop">'
              + '<div class="flex items-center gap-3 px-6 py-4 border-b border-white/60 flex-shrink-0">'
                + '<span class="ach-title-icon" aria-hidden="true">🏆</span>'
                + '<div class="text-base font-bold text-indigo-950">成就</div>'
                + '<span id="achCount" class="ach-count"></span>'
                // 分类入口保留在这里 —— 见文件顶部"它取代了什么"的说明
                + '<button id="achCategoriesBtn" class="btn-secondary text-xs ml-auto" type="button">管理分类</button>'
                + '<button id="achCloseBtn" class="p-1.5 rounded-lg hover:bg-white/60 transition-colors" type="button" aria-label="关闭成就">'
                  + '<svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>'
                + '</button>'
              + '</div>'
              + '<div id="achList" class="flex-1 overflow-y-auto scroll-soft px-6 py-4 space-y-3"></div>'
            + '</div>';
        document.body.appendChild(overlay);

        overlay.querySelector('#achCloseBtn').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        // 分类：把用户交回分类弹窗本身（不复制一份实现）
        overlay.querySelector('#achCategoriesBtn').addEventListener('click', () => {
            close();
            try { if (typeof openCategoriesModal === 'function') openCategoriesModal(); }
            catch (e) { /* 分类弹窗不可用时不影响成就页 */ }
        });
    }

    function render() {
        const box = overlay.querySelector('#achList');
        const items = list();
        const got = items.filter((i) => i.unlocked).length;
        overlay.querySelector('#achCount').textContent = got + ' / ' + items.length;

        box.innerHTML = items.map((it) => {
            const cls = 'ach-card' + (it.unlocked ? ' is-unlocked' : '') + (it.memorial ? ' is-memorial' : '');
            // 纪念正文走 textContent 语义（esc 转义后插入），
            //   它是**模型/用户内容**，不能当 HTML 解析
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
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
        try { if (typeof setRailActive === 'function') setRailActive('categories'); }
        catch (e) { /* 忽略 */ }
    }

    function close() {
        if (!overlay) return;
        overlay.classList.add('hidden');
        overlay.classList.remove('flex');
        try { if (typeof syncRailActive === 'function') syncRailActive(); }
        catch (e) { /* 忽略 */ }
    }

    function isOpen() {
        return Boolean(overlay && !overlay.classList.contains('hidden'));
    }

    // ========================================================================
    //  对外接口
    // ========================================================================

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
        /**
         * `Store.bootstrap()` 之后由 init.js 调用。
         *
         * 脚本求值阶段读到的必然是空表（缓存还没填），不重读的话
         * **每次刷新成就都会看起来"全都没解锁"**，而 data/ 里其实好好存着。
         */
        refresh: () => {
            ready = true;
            load();
            return Object.keys(unlocked).length;
        },
        /** 供生日模块上报纪念记录用（见 birthday.js） */
        esc,
    };
})();
