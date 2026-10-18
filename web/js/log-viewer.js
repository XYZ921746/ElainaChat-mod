// 软件内日志模块（AstrBot 风格的"数据与日志"页）。
//
// 版式对齐 AstrBot 的日志/控制台效果（AstrBot 是参考图）。
//
// ── 目标（用户原话）─────────────────────────────────────────────────────
//
//   "控制台输出全部日志，然后软件内日志系统可以对日志进行分类，
//    分离掉不想看的信息"
//
// ── 位置：设置里的**独立分栏**（这里我判断错过两次，写清楚约束在哪）──
//
//   日志是排查用的、不是每天点的功能，所以不能放主界面 rail 上 ——
//   用户的原话是"我日志是让你放设置里而不是放主界面啊！！！"。
//   也不能放进「设置 → 高级」的最后一项：高级那一栏内容总高（约 920px）超过
//   内容区视口（约 842px），入口会被挤到**屏幕外**（按钮 top=895 / 视口高 900），
//   不滚动根本看不到，用户会反馈"设置里我没看见日志界面"。
//
//   所以：**独立分栏**（#tab-log，与外观/角色/对话并列）。
//   它在顶部导航上永远可见、一点就到，也不用滚动。
//
// ── 界面结构（对齐参考图）───────────────────────────────────────────────
//
//   ① 级别药丸   DEBUG / INFO / WARNING / ERROR / CRITICAL —— **多选**，
//                点掉某一类就把它从视图里去掉（参考图里就是这个交互）。
//   ② 工具栏     模块下拉 / 关键词 / 排除用户对话 / 自动滚动 / 刷新 / 清屏
//   ③ 日志区     终端式深色区，等宽字体，旧在上、新在下
//   ④ 状态栏     总条数 / 当前显示 / 缓冲占用 / 日志文件位置
//
// ── 数据源与过滤分工 ────────────────────────────────────────────────────
//
//   数据源：GET /api/logs/tail（服务端内存缓冲，**全量**、不受落盘级别约束）。
//   级别 / 模块 / 关键词过滤在**服务端**做（缓冲本来就有这三个查询参数）；
//   "排除用户对话"是**前端**过滤 —— 它是"按正文特征排除"，服务端没有这个概念，
//   而且它只影响显示，不该为此加一个接口参数。
//
// ── 为什么轮询而不是 WebSocket ──────────────────────────────────────────
// 服务端是零依赖的静态服务，没有 ws 升级层；日志查看是低频操作（打开这一页才看），
// 2 秒轮询的代价可以忽略。引入 WS 栈只为这个功能不值得。
//
// 日志正文本身是英文（检索友好），这里的**界面文案**用中文（给人看）。
(function () {
    'use strict';

    /**
     * 级别药丸的顺序与短码。**与服务端 LEVEL_SHORT 同一套**。
     *
     * 为什么查看器也要用短码：落盘文件与控制台显示的就是短码（DBUG/ERRO/CRIT），
     * 查看器若显示长名，同一行日志在两个窗口里级别文字就不一样 ——
     * 用户对照着看时会以为"两边的日志不同"。
     *
     * 药丸上显示长名（WARNING/CRITICAL）是为了**可读**，但送进接口的是短码 ——
     * 这样界面好看、数据对齐，两件事都成立。
     */
    const LEVELS = [
        { short: 'DBUG', long: 'DEBUG', full: 'DEBUG' },
        { short: 'INFO', long: 'INFO', full: 'INFO' },
        { short: 'WARN', long: 'WARNING', full: 'WARN' },
        { short: 'ERRO', long: 'ERROR', full: 'ERROR' },
        { short: 'CRIT', long: 'CRITICAL', full: 'CRITICAL' },
    ];
    /** 级别长名（接口用） → 四位短码（行内显示用） */
    const LEVEL_SHORT = { DEBUG: 'DBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERRO', CRITICAL: 'CRIT' };

    /**
     * "排除用户对话"的判据。
     *
     * 服务端在追踪对话时会打 `[chat] 提问：…` / `[chat] 回复：…` 这类摘要
     * （见 serve.mjs 的对话追踪）。这些行含用户与角色的**真实聊天内容**，
     * 排查程序问题时是纯噪音，而且在录屏/截图分享日志时是隐私面。
     *
     * 判据刻意**窄**：只认 `[chat]` 模块 + 提问/回复/自动功能这几种正文，
     * 不用"含中文就排除"这类宽判据 —— 那会把真正要看的中文报错也一起藏掉。
     */
    const CHAT_LINE_RE = /^(提问|回复|提问来自自动功能)/;

    let timer = null;
    let lastTs = 0;          // 增量拉取：只取比这更新的
    let lastSeq = -1;        // 增量游标：同一毫秒内靠写入序号区分（见 log-buffer.mjs 的 query）
    let knownTags = new Set();
    let bound = false;
    /**
     * 请求序号：只渲染**最后一次**发起的请求的结果。
     *
     * 为什么需要它：连续点级别药丸时会并发发出多个 refresh，
     *   而它们的返回顺序**不保证与发出顺序一致**。于是先发的（旧过滤条件）可能后到，
     *   把后发的（新过滤条件）结果覆盖掉 —— 表现是"点了药丸，界面显示的却是上一个状态"，
     *   而且再点一次又对了（看起来像"偶尔失灵"）。加了序号闸门后，过期的响应直接丢弃。
     */
    let reqSeq = 0;

    const el = (id) => document.getElementById(id);

    function esc(s) {
        return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function fmtTime(ts) {
        const d = new Date(ts);
        const p = (n, w = 2) => String(n).padStart(w, '0');
        // 毫秒：与服务端日志行一致（同一秒里可能连打十几条，没有毫秒分不出先后）
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    }

    /** 当前选中的级别短码集合（药丸的 aria-pressed="true"） */
    function selectedLevels() {
        const out = [];
        document.querySelectorAll('#logLevelPills .log-pill').forEach((btn) => {
            if (btn.getAttribute('aria-pressed') === 'true') out.push(btn.dataset.level);
        });
        return out;
    }

    /**
     * 把选中的级别换算成服务端的 `level` 查询参数。
     *
     * 服务端的 level 是"最低级别（含）"的语义，而药丸是**多选**（可以只留
     * DEBUG + ERROR 这种不连续的组合）。两者不能直接对应，所以：
     *   · 全选 / 只选了一个最低的 → 传那个最低级别（等价，且省流量）
     *   · 其它组合 → 不传 level（拿全量），由前端按选中集合精确筛
     * 这样"服务端过滤"与"多选药丸"两个目标都成立，也不会漏掉任何一类。
     */
    function levelParam() {
        const sel = selectedLevels();
        if (!sel.length) return '__none__';       // 全关：没有级别该显示
        if (sel.length === LEVELS.length) return 'DEBUG';
        const order = LEVELS.map((l) => l.full);
        const idx = sel.map((s) => order.indexOf(s)).filter((i) => i >= 0);
        const min = Math.min(...idx);
        // 选中的正好是"从最低级别到某一档"的连续前缀时，可以用服务端过滤
        const isPrefix = idx.length === (order.length - min);
        return isPrefix ? order[min] : '';
    }

    /** 一条记录是否该显示（前端这一侧：级别多选 + 排除对话） */
    function passesLocalFilter(e) {
        const sel = selectedLevels();
        if (!sel.length) return false;
        if (!sel.includes(e.level)) return false;
        if (el('logHideChat')?.checked && e.tag === 'Chat' && CHAT_LINE_RE.test(String(e.message || '').trim())) {
            return false;
        }
        return true;
    }

    /**
     * 一条记录 → 一行 HTML。
     *
     * 字段顺序、级别写法都**与 bat 面板/日志文件对齐**：
     *     面板/文件： [时刻] [模块] [级别] [来源]: 正文
     *     本查看器：  [时刻] [模块] [级别] [来源] 正文
     *   顺序必须一致：若本查看器写成 `时刻 [级别] [模块] 正文`，级别与模块
     *   **位置就是反的**，同一行日志在两个窗口里看起来像两件事。
     *
     * 级别用**四位短码**（DBUG/ERRO/CRIT）而不是长名：落盘文件与控制台用的就是短码，
     * 用长名会让"同一行"在两边显示成不同的级别文字。
     */
    function renderEntry(e) {
        const short = LEVEL_SHORT[e.level] || e.level;
        return `<div class="log-line" data-level="${esc(e.level)}">`
            + `<span class="log-time">[${fmtTime(e.ts)}]</span> `
            + `<span class="log-tag">[${esc(e.tag)}]</span> `
            + `<span class="log-lv">[${esc(short)}]</span> `
            + (e.loc ? `<span class="log-loc">[${esc(e.loc)}]:</span> ` : '')
            + `<span class="log-msg">${esc(e.message)}</span></div>`;
    }

    /** 日志区当前渲染的行数（状态栏与检查脚本都要用） */
    function renderedCount() {
        const box = el('logPageBox');
        return box ? box.querySelectorAll('.log-line').length : 0;
    }

    function setMeta(parts) {
        const meta = el('logPageMeta');
        if (meta) meta.innerHTML = parts.filter(Boolean).join(' · ');
    }

    async function refresh(full) {
        const box = el('logPageBox');
        if (!box) return;
        const myReq = ++reqSeq;          // 本次请求的序号（见 reqSeq 的说明）
        try {
            const tag = el('logTagSelect')?.value || '';
            const search = el('logSearchInput')?.value?.trim() || '';
            // 首次 / 换过滤条件：全量拉（最多 500 条）；否则增量
            const params = new URLSearchParams();
            const lv = levelParam();
            if (lv === '__none__') {
                // 所有级别都被点掉了：不请求，直接显示空态（比拉回来再全丢掉更省）
                box.innerHTML = '<div class="log-empty">（所有级别都被关掉了 —— 点上面的级别药丸重新打开）</div>';
                setMeta(['已隐藏全部级别']);
                return;
            }
            if (lv) params.set('level', lv);
            if (tag) params.set('tags', tag);
            if (search) params.set('search', search);
            // 增量要用**两个**游标：时间戳 + 写入序号。
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
            // 过期响应丢弃：期间又发起过请求的话，这个结果已经不代表当前过滤条件了。
            //   不加这道闸门会"偶尔显示上一个状态"（见 reqSeq 的说明）。
            if (myReq !== reqSeq) return;

            // 模块下拉框：把缓冲里出现过的模块补进去（只增不减）
            const tagSel = el('logTagSelect');
            if (tagSel && Array.isArray(json.tags)) {
                for (const t of json.tags) {
                    if (!knownTags.has(t)) {
                        knownTags.add(t);
                        const opt = document.createElement('option');
                        opt.value = t; opt.textContent = t;
                        tagSel.appendChild(opt);
                    }
                }
            }

            const entries = json.entries || [];
            if (!entries.length && !full) return;   // 增量没有新东西，不动 DOM

            // 顺序**与 bat 面板一致：旧在上、新在下**。
            //
            //   服务端返回的是新→旧（查询是从最新的往回扫），这里翻过来再渲染。
            //   为什么值得翻：面板是"旧在上、新在下、跟 tail -f 一样"，
            //   查看器必须**同一个方向** —— 两个窗口顺序相反就无法逐行对照，
            //   用户会说"对不上"。
            const ordered = entries.slice().reverse();   // 旧 → 新
            // 前端这一侧再筛一遍（级别多选 / 排除对话）。
            // 服务端已经按 level/tag/search 筛过，这里只处理它表达不了的两件事。
            const visible = ordered.filter(passesLocalFilter);

            if (full) {
                box.innerHTML = visible.map(renderEntry).join('')
                    || '<div class="log-empty">（没有匹配的日志）</div>';
                box.scrollTop = box.scrollHeight;        // 全量后停在最新（底部）
            } else {
                if (visible.length) box.insertAdjacentHTML('beforeend', visible.map(renderEntry).join(''));
                // 只在用户本来就贴着底部、且开了「自动滚动」时才滚 ——
                // 他翻上去看历史时不该被拽回来
                if (el('logAutoScroll')?.checked) {
                    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
                    if (nearBottom) box.scrollTop = box.scrollHeight;
                }
            }
            // 记录本次拉到的最新条目的游标（entries[0] 是最新的）。
            // 序号与时间戳必须**成对**更新 —— 只更新时间戳会让下一轮把同一毫秒的
            // 后续记录当成"已经见过"而丢掉。
            if (entries.length) {
                lastTs = entries[0].ts;
                lastSeq = Number(entries[0].seq ?? -1);
            }

            const hiddenByLocal = ordered.length - visible.length;
            setMeta([
                `内存缓冲 <b>${json.total}</b> 条`
                    + (json.dropped ? `（已滚动丢弃 ${json.dropped} 条旧记录）` : ''),
                `当前显示 <b>${renderedCount()}</b> 条`,
                full ? `本次拉到 ${entries.length} 条` : `新增 ${entries.length} 条`,
                hiddenByLocal > 0 ? `按级别/对话隐藏 ${hiddenByLocal} 条` : '',
                '顺序与 bat 面板一致（旧在上）',
                '完整历史在 data/logs/ 下的日志文件里',
            ]);
        } catch (e) { /* 服务端不在（APK 场景）时这一页会提示不可用 */ }
    }

    /**
     * 这一栏是否真的显示着（决定轮询要不要干活）。
     *
     * 日志现在住在设置面板的一个分栏里，所以"可见"有两层条件：
     *   ① 设置面板本身是打开的（否则整个面板 hidden）
     *   ② 当前选中的分栏就是 tab-log（其它分栏时本栏是 display:none）
     *   漏掉 ① 会让"关掉设置后轮询还在跑"（服务端日志被自噪音刷屏）；
     *   漏掉 ② 会让"停在别的分栏时也在拉"，白耗流量。
     */
    function isVisible() {
        const panel = el('tab-log');
        if (!panel || !panel.classList.contains('active-panel')) return false;
        const overlay = el('settingsOverlay');
        if (overlay && overlay.classList.contains('hidden')) return false;
        return true;
    }

    function start() {
        if (timer) return;
        timer = setInterval(() => {
            if (!isVisible()) return;
            refresh(false);
        }, 2000);
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    /** 级别药丸：点一下切换选中，并立刻重拉 */
    function togglePill(btn) {
        const on = btn.getAttribute('aria-pressed') === 'true';
        btn.setAttribute('aria-pressed', on ? 'false' : 'true');
        lastTs = 0; lastSeq = -1;      // 过滤条件变了 → 下一轮必须全量
        refresh(true);
    }

    function bind() {
        const panel = el('tab-log');
        if (!panel || bound) return Boolean(panel);
        bound = true;

        el('logLevelPills')?.addEventListener('click', (ev) => {
            const btn = ev.target.closest('.log-pill');
            if (btn) togglePill(btn);
        });
        el('logTagSelect')?.addEventListener('change', () => { lastTs = 0; lastSeq = -1; refresh(true); });
        el('logHideChat')?.addEventListener('change', () => { lastTs = 0; lastSeq = -1; refresh(true); });
        el('logRefreshBtn')?.addEventListener('click', () => { lastTs = 0; lastSeq = -1; refresh(true); });
        el('logClearBtn')?.addEventListener('click', () => {
            const box = el('logPageBox');
            if (box) box.innerHTML = '<div class="log-empty">（已清屏 —— 新日志会继续出现；日志文件未受影响）</div>';
            setMeta(['已清屏', '新日志会继续出现']);
        });
        // 关键词：输入停顿 400ms 再拉，避免每敲一个字符都打一次接口
        let debounce = null;
        el('logSearchInput')?.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => { lastTs = 0; lastSeq = -1; refresh(true); }, 400);
        });
        return true;
    }

    /**
     * 进入这一栏（由分栏切换时调用）：绑事件、首次全量拉、开轮询。
     *
     * 为什么不再需要"页面模式"（藏聊天区 / 切 rail 高亮 / state.logMode）：
     *   日志已经是设置面板里的一个分栏，面板打开时聊天区本来就藏着，
     *   rail 高亮本来就是「设置」。所以不需要 enterLogMode/exitLogMode 那套
     *   "独立全屏页"的开关：分栏化之后整块都是多余状态。
     */
    function open() {
        if (!bind()) return;
        lastTs = 0; lastSeq = -1;
        refresh(true);
        start();
    }

    /** 离开这一栏 / 关闭设置：停掉轮询（否则服务端日志会被自噪音刷屏） */
    function close() {
        stop();
    }

    // 暴露给 settings / init：分栏进入与离开
    window.LogViewer = { open, close, refresh, isVisible };
})();
