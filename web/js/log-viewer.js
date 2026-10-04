// 软件内日志查看器（AstrBot 风格分级系统的前端一半）。
//
// ── 目标（用户原话）─────────────────────────────────────────────────────
//
//   "控制台输出全部日志，然后软件内日志系统可以对日志进行分类，
//    分离掉不想看的信息" —— 之前没做好，这里补完。
//
// 数据源：GET /api/logs/tail（服务端内存缓冲，**全量**、不受落盘级别约束）。
// 过滤在服务端做（级别 / 模块 / 关键词），前端只负责展示与轮询。
//
// ── 为什么轮询而不是 WebSocket ──────────────────────────────────────────
// 服务端是零依赖的静态服务，没有 ws 升级层；日志查看是低频操作（打开设置才看），
// 2 秒轮询的代价可以忽略。引入 WS 栈只为这个功能不值得。
//
// 日志正文本身是英文（检索友好），这里的**界面文案**用中文（给人看）。
(function () {
    'use strict';

    // 级别徽标的配色（与 AstrBot 的级别色一致：debug 灰、info 绿、warn 黄、error/crit 红）
    const LEVEL_STYLE = {
        DEBUG: 'text-slate-400',
        DBUG: 'text-slate-400',
        INFO: 'text-emerald-400',
        WARN: 'text-amber-400',
        ERROR: 'text-red-400',
        ERRO: 'text-red-400',
        CRITICAL: 'text-red-300 font-bold',
        CRIT: 'text-red-300 font-bold',
    };
    /**
     * 级别长名 → 四位短码。**与服务端 LEVEL_SHORT 保持同一套**。
     *
     * 为什么查看器也要用短码：落盘文件与控制台显示的就是短码（DBUG/ERRO/CRIT），
     * 查看器若显示长名，同一行日志在两个窗口里级别文字就不一样 ——
     * 用户对照着看时会以为"两边的日志不同"（2026-10 实测反馈）。
     */
    const LEVEL_SHORT = { DEBUG: 'DBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERRO', CRITICAL: 'CRIT' };
    // 模块名固定配色：一眼区分"谁在说话"
    const TAG_HUES = [210, 280, 30, 150, 330, 60, 180, 255];
    const tagColor = (tag) => {
        let h = 0;
        for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
        return `hsl(${TAG_HUES[h % TAG_HUES.length]} 70% 70%)`;
    };

    let timer = null;
    let lastTs = 0;          // 增量拉取：只取比这更新的
    let lastSeq = -1;        // 增量游标：同一毫秒内靠写入序号区分（见 log-buffer.mjs 的 query）
    let knownTags = new Set();

    const el = (id) => document.getElementById(id);

    function esc(s) {
        return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function fmtTime(ts) {
        const d = new Date(ts);
        const p = (n, w = 2) => String(n).padStart(w, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    /**
     * 一条记录 → 一行 HTML。
     *
     * ★ 字段顺序、级别写法都**与 bat 面板/日志文件对齐**（2026-10 用户报"对不上"）：
     *     面板/文件： [时刻] [模块] [级别] [来源]: 正文
     *     本查看器：  [时刻] [模块] [级别] [来源] 正文
     *   改之前这里写的是 `时刻 [级别] [模块] 正文` —— 级别与模块**位置是反的**，
     *   于是同一行日志在两个窗口里看起来像两件事（用户实测反馈）。
     *
     * 级别用**四位短码**（DBUG/ERRO/CRIT）而不是长名：落盘文件与控制台用的就是短码，
     * 用长名会让"同一行"在两边显示成不同的级别文字。
     */
    function renderEntry(e) {
        const short = LEVEL_SHORT[e.level] || e.level;
        const lv = LEVEL_STYLE[e.level] || LEVEL_STYLE[short] || 'text-slate-300';
        const tg = tagColor(e.tag);
        return `<div class="hover:bg-white/5 rounded px-1">`
            + `<span class="text-slate-500">[${fmtTime(e.ts)}]</span> `
            + `<span style="color:${tg}">[${esc(e.tag)}]</span> `
            + `<span class="${lv}">[${esc(short)}]</span> `
            + (e.loc ? `<span class="text-slate-500">[${esc(e.loc)}]:</span> ` : '')
            + `<span class="text-slate-300">${esc(e.message)}</span></div>`;
    }

    async function refresh(full) {
        const box = el('logViewerBox');
        if (!box) return;
        try {
            const level = el('logViewerLevel')?.value || '';
            const tag = el('logViewerTag')?.value || '';
            const search = el('logViewerSearch')?.value?.trim() || '';
            // 首次 / 换过滤条件：全量拉（最多 500 条）；否则增量
            const params = new URLSearchParams();
            if (level) params.set('level', level);
            if (tag) params.set('tags', tag);
            if (search) params.set('search', search);
            // ★ 增量要用**两个**游标：时间戳 + 写入序号。
            //   只传时间戳会让同一毫秒里的后续记录被永久跳过（一次启动就有一批同毫秒日志），
            //   表现是"bat 面板刷过好几行、查看器里少几行"。详见 server/log-buffer.mjs。
            if (!full && lastTs) {
                params.set('since', String(lastTs));
                if (lastSeq >= 0) params.set('sinceSeq', String(lastSeq));
                params.set('limit', '300');
            }
            const res = await fetch('/api/logs/tail?' + params.toString(), { cache: 'no-store' });
            if (!res.ok) return;
            const json = await res.json();
            if (!json.ok) return;

            // 模块下拉框：把缓冲里出现过的模块补进去（只增不减）
            const tagSel = el('logViewerTag');
            if (tagSel && Array.isArray(json.tags)) {
                for (const t of json.tags) {
                    if (!knownTags.has(t)) {
                        knownTags.add(t);
                        const opt = document.createElement('option');
                        opt.value = t; opt.textContent = '模块: ' + t;
                        tagSel.appendChild(opt);
                    }
                }
            }

            const entries = json.entries || [];
            if (!entries.length && !full) return;   // 增量没有新东西，不动 DOM

            // ★ 顺序**与 bat 面板一致：旧在上、新在下**（2026-10 用户报"对不上"）。
            //
            //   服务端返回的是新→旧（查询是从最新的往回扫），这里翻过来再渲染。
            //   为什么值得翻：面板是"旧在上、新在下、跟 tail -f 一样"，
            //   查看器原先反过来 —— 同一批日志在两个窗口里顺序完全相反，
            //   根本没法逐行对照（用户实测反馈"对不上"就是这个）。
            //   代价：最新日志在底部，不在视野顶部。但"能对上"比"不用滚动"重要 ——
            //   要看最新时用「刷新」或等自动滚动（下面会滚到底）。
            const ordered = entries.slice().reverse();   // 旧 → 新

            if (full) {
                box.innerHTML = ordered.map(renderEntry).join('') || '<div class="text-slate-500">（没有匹配的日志）</div>';
                box.scrollTop = box.scrollHeight;        // 全量后停在最新（底部）
            } else {
                // 增量：接到**底部**
                if (ordered.length) box.insertAdjacentHTML('beforeend', ordered.map(renderEntry).join(''));
                // 只在用户本来就贴着底部时才自动滚动 —— 他翻上去看历史时不该被拽回来
                const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
                if (nearBottom || full) box.scrollTop = box.scrollHeight;
            }
            // 记录本次拉到的最新条目的游标（entries[0] 是最新的）。
            // 序号与时间戳必须**成对**更新 —— 只更新时间戳会让下一轮把同一毫秒的
            // 后续记录当成"已经见过"而丢掉。
            if (entries.length) {
                lastTs = entries[0].ts;
                lastSeq = Number(entries[0].seq ?? -1);
            }

            const meta = el('logViewerMeta');
            if (meta) {
                const shown = full
                    ? entries.length
                    : ('+' + entries.length);
                meta.textContent = `内存缓冲 ${json.total} 条`
                    + (json.dropped ? `（已滚动丢弃 ${json.dropped} 条旧记录）` : '')
                    + ` · 当前显示 ${shown} 条`
                    + ' · 顺序与 bat 面板一致（旧在上）'
                    + ' · 日志正文为英文（便于检索），完整历史在 data/logs/ 下的日志文件里';
            }
        } catch (e) { /* 服务端不在（APK 场景）时整个 section 已被隐藏 */ }
    }

    function isVisible() {
        const section = el('logViewerSection');
        if (!section) return false;
        // section 自己没被隐藏，且它的祖先（设置面板 overlay）也没被隐藏。
        // ★ 只查 section 自己是不够的：closeSettingsPanel 隐藏的是**整个面板**，
        //   section 的 class 不变 —— 那样关掉设置后轮询仍会继续
        //   （服务端日志被 2 秒一条的自噪音刷屏，实测踩到）。
        if (section.classList.contains('hidden')) return false;
        let node = section.parentElement;
        while (node) {
            if (node.classList && node.classList.contains('hidden')) return false;
            node = node.parentElement;
        }
        return true;
    }

    function start() {
        if (timer) return;
        timer = setInterval(() => {
            if (!isVisible() || !el('logViewerAuto')?.checked) return;
            refresh(false);
        }, 2000);
    }

    function bind() {
        const section = el('logViewerSection');
        if (!section) return false;
        el('logViewerRefresh')?.addEventListener('click', () => refresh(true));
        for (const id of ['logViewerLevel', 'logViewerTag']) {
            el(id)?.addEventListener('change', () => refresh(true));
        }
        // 关键词：输入停顿 400ms 再拉，避免每敲一个字符都打一次接口
        let debounce = null;
        el('logViewerSearch')?.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => refresh(true), 400);
        });
        el('logViewerAuto')?.addEventListener('change', (ev) => {
            if (ev.target.checked) refresh(true);
        });
        return true;
    }

    // 暴露给 app-06-settings：面板被打开时调用（做首次全量加载）
    window.LogViewer = {
        show() {
            const section = el('logViewerSection');
            if (!section) return;
            section.classList.remove('hidden');
            if (!bind()) return;
            refresh(true);
            start();
        },
    };
})();
