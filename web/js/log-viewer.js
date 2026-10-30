// 软件内日志模块（"数据与日志"页）。
// 日志是排查工具、不是日常入口，所以放设置里的独立分栏（#tab-log）：
// 放主界面 rail 会占位，放「设置 → 高级」末尾会被内容区高度挤出屏幕。
// 数据源：GET /api/logs/tail（服务端内存缓冲，全量、不受落盘级别约束）。
// 级别 / 模块 / 关键词过滤在服务端做；"排除用户对话"按正文特征过滤，只影响显示，所以放前端。
// 轮询而非 WebSocket：服务端是零依赖静态服务，没有 ws 升级层；日志页是低频操作，2 秒轮询可以忽略。
// 日志正文本身是英文（检索友好），这里的**界面文案**用中文（给人看）。
(function () {
    'use strict';

    /**
     * 级别药丸的顺序与短码，**与服务端 LEVEL_SHORT 同一套**。
     * 落盘文件与控制台显示的是短码（DBUG/ERRO/CRIT）；查看器若显示长名，
     * 同一行日志在两个窗口里级别文字就不一样，用户会以为"两边的日志不同"。
     * 药丸上显示长名只为可读，送进接口的仍是短码。
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
     * 服务端追踪对话时会打 `[chat] 提问：…` / `[chat] 回复：…` 摘要（见 serve.mjs 的对话追踪），含真实聊天内容：
     * 排障时是纯噪音，录屏/截图分享日志时是隐私面。判据刻意**窄** —— 只认这几种正文，
     * 不用"含中文就排除"这类宽判据（那会把真正要看的中文报错一起藏掉）。
     */
    const CHAT_LINE_RE = /^(提问|回复|提问来自自动功能)/;

    let timer = null;
    let lastTs = 0;          // 增量拉取：只取比这更新的
    let lastSeq = -1;        // 增量游标：同一毫秒内靠写入序号区分（见 log-buffer.mjs 的 query）
    let knownTags = new Set();
    let bound = false;
    /**
     * 请求序号：只渲染**最后一次**发起的请求的结果。
     * 连点药丸会并发发出多个 refresh，返回顺序不保证与发出顺序一致；
     * 旧过滤条件的结果后到就会盖掉新结果（表现为"点了药丸，界面却是上一个状态"）。
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
     * 服务端的 level 是"最低级别（含）"，药丸是**多选**（可以只留 DEBUG + ERROR 这种
     * 不连续的组合），两者不能直接对应：全选或选中的正好是连续前缀 → 传那个最低级别；
     * 其它组合 → 不传 level（拿全量）由前端精确筛，这样不漏也不白拉。
     */
    function levelParam() {
        const sel = selectedLevels();
        if (!sel.length) return '__none__';       // 全关：没有级别该显示
        if (sel.length === LEVELS.length) return 'DEBUG';
        const order = LEVELS.map((l) => l.full);
        const idx = sel.map((s) => order.indexOf(s)).filter((i) => i >= 0);
        const min = Math.min(...idx);
        const isPrefix = idx.length === (order.length - min);
        return isPrefix ? order[min] : '';
    }

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
     * 字段顺序、级别写法都**与 bat 面板/日志文件对齐**（[时刻] [模块] [级别] [来源] 正文）：
     * 顺序一旦不同，同一行日志在两个窗口里看起来像两件事；级别用四位短码也是同理。
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

    /** 按当前过滤条件取回要导出的日志条目；没有可导出内容时说明原因并返回 null。 */
    async function collectExportEntries(say) {
        const params = new URLSearchParams();
        const lv = levelParam();
        if (lv === '__none__') { say('所有级别都被关掉了 —— 没有可导出的内容'); return null; }
        if (lv) params.set('level', lv);
        const tag = el('logTagSelect')?.value || '';
        if (tag) params.set('tags', tag);
        const search = el('logSearchInput')?.value?.trim() || '';
        if (search) params.set('search', search);
        params.set('limit', '3000');   // 缓冲容量（RING_CAPACITY），一次拿全
        const res = await fetch('/api/logs/tail?' + params.toString(), { cache: 'no-store' });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json || !json.ok) { say('导出失败：日志服务不可用'); return null; }
        const entries = (json.entries || []).slice().reverse()
            .filter(passesLocalFilter);
        if (!entries.length) { say('当前过滤下没有日志可导出'); return null; }
        return { entries, lv, tag, search };
    }

    /** 把条目拼成可直接保存的文本（含表头与过滤说明），并生成文件名。 */
    function buildExportText(entries, lv, tag, search) {
        const p = (n, w = 2) => String(n).padStart(w, '0');
        const stamp = (ts) => {
            const d = new Date(ts);
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
                + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
        };
        const lines = entries.map((e) => {
            const short = LEVEL_SHORT[e.level] || e.level;
            return `[${stamp(e.ts)}] [${e.tag}] [${short}]` + (e.loc ? ` [${e.loc}]:` : '') + ` ${e.message}`;
        });
        const filters = [
            lv && lv !== 'DEBUG' ? '级别≥' + lv : '',
            tag ? '模块=' + tag : '',
            search ? '关键词=' + search : '',
            el('logHideChat')?.checked ? '已排除对话' : '',
        ].filter(Boolean).join('，') || '无';
        const head = [
            'ElainaChat 运行日志导出',
            '导出时间：' + stamp(Date.now()),
            // 版本号只在侧栏底部（"v2.0.0 · 魔女之旅"）：按 v 前缀全页找，
            //   不能写死下标 —— 布局一改就会拿到别处的 "1"
            '版本：' + (Array.from(document.querySelectorAll('[class*="text-[10px]"]'))
                .map((el) => el.textContent.trim())
                .find((t) => /^v\d/.test(t)) || ''),
            '环境：' + navigator.userAgent,
            '条数：' + lines.length + '（过滤：' + filters + '）',
            '――――――――――――――――――――――――――',
        ].join('\n');
        const text = head + '\n' + lines.join('\n') + '\n';

        const d = new Date();
        const fname = 'elainachat-log-'
            + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
            + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.txt';
        return { text, fname, count: lines.length };
    }

    /**
     * 按运行环境选择保存方式：
     *   ① APK：原生 ElainaExport 拉 SAF「创建文档」选择器（自选目录与文件名，无需存储权限）。
     *      WebView 里做不到 —— showSaveFilePicker 在 Android WebView 上不存在，
     *      a[download] 的 blob 会被 DownloadListener 静默丢掉（界面说"已导出"，全盘找不到文件）。
     *      选择器打不开的极罕见环境回落固定目录：公共 Download（Android 11+ 无需权限）→ CACHE。
     *   ② 电脑：showSaveFilePicker（真正的系统"另存为"）；桌面 navigator.share 只有 Outlook 类
     *      目标，不选它。③ 手机浏览器：navigator.share。④ 兜底：a[download]。
     */
    async function saveExportText(text, fname, count, say) {
        const file = new File([text], fname, { type: 'text/plain' });

        // ① APK：系统「创建文档」选择器 —— 自选保存位置（SAF，无需权限）
        const cap = window.Capacitor;
        const capFs = cap && cap.Plugins && cap.Plugins.Filesystem;
        const capExport = cap && cap.Plugins && cap.Plugins.ElainaExport;
        if (capFs && capExport && typeof capExport.saveText === 'function') {
            const r = await capExport.saveText({ data: text, fileName: fname });
            if (r && r.ok) { say('已保存到所选位置（' + count + ' 条）'); return; }
            if (r && r.reason === 'cancelled') { say('已取消导出'); return; }
            // 选择器打不开等异常 → 在状态栏说明原因，落到固定目录兜底
            say((r && r.text) || '系统选择器不可用，改存固定位置…');
        }
        if (capFs) {
            const tryWrite = async (directory, path, okMsg) => {
                await capFs.writeFile({ path, data: text, directory, encoding: 'utf8', recursive: true });
                say(okMsg);
            };
            try {
                // Android 11+（API 30+）：公共 Download 创建自己的文件无需任何权限
                await tryWrite('EXTERNAL_STORAGE', 'Download/' + fname,
                    '已保存到「下载」文件夹：' + fname + '（' + count + ' 条）');
                return;
            } catch (e) {
                // Android 10 及更老的权限模型写公共目录会失败 → 回落缓存，至少给得出路径
                try {
                    await tryWrite('CACHE', 'log-exports/' + fname,
                        '已导出到应用缓存：log-exports/' + fname + '（公共下载不可写：' + String((e && e.message) || e) + '）');
                    return;
                } catch (e2) { /* 缓存也失败 → 落到 ②③ */ }
            }
        }

        // ② 电脑：系统「另存为」对话框（File System Access API）
        if (typeof window.showSaveFilePicker === 'function') {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: fname,
                    types: [{ description: '文本文件', accept: { 'text/plain': ['.txt'] } }],
                });
                const w = await handle.createWritable();
                await w.write(file);
                await w.close();
                say('已保存到所选位置（' + count + ' 条）');
                return;
            } catch (e) {
                if (e && e.name === 'AbortError') { say('已取消导出'); return; }
                /* 手势丢失等异常 → 落到 ③④ */
            }
        }

        // ③ 手机浏览器（仅移动端）：系统分享面板（桌面共享面板没有文件落点，跳过）
        const mobile = (typeof IS_MOBILE_DEVICE !== 'undefined') && IS_MOBILE_DEVICE;
        if (mobile && navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file], title: fname });
                say('已通过系统分享发出 ' + fname);
                return;
            } catch (e) {
                if (e && e.name === 'AbortError') { say('已取消分享'); return; }   // 用户关掉分享面板不算失败
                /* 不支持 files 的 share 会 throw —— 落到 ④ */
            }
        }
        // ④ 兜底：浏览器下载（受浏览器"每次询问"设置控制）
        try {
            const url = URL.createObjectURL(file);
            const a = document.createElement('a');
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            say('已导出 ' + fname + '（' + count + ' 条）');
        } catch (e) {
            say('导出失败：当前环境不支持保存，请截图或长按复制日志');
        }
    }

    /**
     * 导出当前过滤下的全部缓冲日志（「日志」栏工具栏的导出按钮）。
     *
     * 手机上几百行等宽小字没法看，用户真正要的是"把日志发给懂的人"，
     * 所以按环境选保存方式（见 saveExportText）。过滤与页面**同一套**
     * （导出"看到的"而不是"全部的"）；时刻带完整日期 ——
     * 页面只看"今天几点"，文件是拿走的，必须自带日期。
     */
    async function exportLogs() {
        const meta = el('logPageMeta');
        const say = (t) => { if (meta) meta.textContent = t; };
        const btn = el('logExportBtn');
        if (btn) btn.disabled = true;
        try {
            const collected = await collectExportEntries(say);
            if (!collected) return;
            const { text, fname, count } = buildExportText(collected.entries, collected.lv, collected.tag, collected.search);
            await saveExportText(text, fname, count, say);
        } catch (err) {
            say('导出失败：' + String((err && err.message) || err));
        } finally {
            if (btn) btn.disabled = false;
        }
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
        const myReq = ++reqSeq;
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
            // 增量要用**两个**游标：时间戳 + 写入序号。只传时间戳会让同一毫秒里的
            //   后续记录被永久跳过（一次启动就有一批同毫秒日志），表现是"面板刷过好几行、查看器少几行"。
            if (!full && lastTs) {
                params.set('since', String(lastTs));
                if (lastSeq >= 0) params.set('sinceSeq', String(lastSeq));
                params.set('limit', '300');
            }
            const res = await fetch('/api/logs/tail?' + params.toString(), { cache: 'no-store' });
            if (!res.ok) { showUnavailable(); return; }
            const json = await res.json();
            if (!json.ok) { showUnavailable(); return; }
            if (myReq !== reqSeq) return;

            // 服务恢复了：清掉上一轮的"不可用"空态，否则空态文案会一直挂着、新日志追加在它后面
            const wasUnavailable = unavailableShown;
            if (wasUnavailable) {
                unavailableShown = false;
                const boxNow = el('logPageBox');
                if (boxNow) boxNow.innerHTML = '';
            }

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
            if (!entries.length && !full && !wasUnavailable) return;   // 增量没有新东西，不动 DOM

            // 顺序**与 bat 面板一致：旧在上、新在下**（服务端返回新→旧，这里翻过来）。
            //   两个窗口顺序相反就无法逐行对照，用户会说"对不上"。
            const ordered = entries.slice().reverse();
            // 前端这一侧再筛一遍（级别多选 / 排除对话）。
            // 服务端已经按 level/tag/search 筛过，这里只处理它表达不了的两件事。
            const visible = ordered.filter(passesLocalFilter);

            if (full) {
                box.innerHTML = visible.map(renderEntry).join('')
                    || '<div class="log-empty">（没有匹配的日志）</div>';
                box.scrollTop = box.scrollHeight;
            } else {
                if (visible.length) box.insertAdjacentHTML('beforeend', visible.map(renderEntry).join(''));
                // 只在用户本来就贴着底部、且开了「自动滚动」时才滚 ——
                // 他翻上去看历史时不该被拽回来
                if (el('logAutoScroll')?.checked) {
                    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
                    if (nearBottom) box.scrollTop = box.scrollHeight;
                }
            }
            // 记录最新条目的游标（entries[0] 是最新的）。序号与时间戳必须**成对**更新 ——
            // 只更新时间戳会让下一轮把同一毫秒的后续记录当成"已经见过"而丢掉。
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
                '完整历史在日志文件里',
            ]);
        } catch (e) {
            // 服务不在（桌面服务挂了 / 手机端内嵌服务未就绪）时给可见的空态，而不是静默 return ——
            // "这一页是死的还是没日志"必须一眼分得清；这里不做环境判断，两端共用同一表现。
            showUnavailable();
        }
    }

    /** "服务不可用"空态是否已显示过（避免每 2 秒重写一次 DOM 造成闪烁） */
    let unavailableShown = false;
    function showUnavailable() {
        if (unavailableShown) return;
        unavailableShown = true;
        const box = el('logPageBox');
        if (box) {
            box.innerHTML = '<div class="log-empty">（日志服务当前不可用 —— '
                + '服务启动后这里会自动恢复显示）</div>';
        }
        setMeta(['日志服务不可用']);
    }

    /**
     * 这一栏是否真的显示着（决定轮询要不要干活）。
     * "可见"有两层条件：① 设置面板本身打开 ② 当前分栏是 tab-log。
     * 漏掉 ① 会让"关掉设置后轮询还在跑"（服务端日志被自噪音刷屏）；漏掉 ② 会白耗流量。
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
        el('logExportBtn')?.addEventListener('click', () => { void exportLogs(); });
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
     * 进入这一栏（分栏切换时调用）：绑事件、首次全量拉、开轮询。
     * 不需要 enterLogMode/exitLogMode 那类"独立全屏页"开关：面板打开时聊天区本来就藏着，
     * rail 高亮本来就是「设置」。
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