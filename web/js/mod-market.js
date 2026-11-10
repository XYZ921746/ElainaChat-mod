/* 插件市场：从商店索引下载并安装扩展包（含依赖），与本机插件栏的管理职责分开。
   索引 JSON 给出 baseUrl 与 plugins；包地址为 baseUrl 下的 `<id>-<version>.zip`，安装走 POST /api/plugins/install。 */

(function () {
    'use strict';

    var DEFAULT_INDEX_URL = 'https://xyz921746.github.io/web/store/index.json';
    /** 自定义商店源的 Store 键（必须在 store.js 的 DATA_KEYS 白名单里，否则写入被丢弃） */
    var URL_KEY = 'elaina_market_url';
    /** 索引请求超时：源站接住连接却不回包时，fetch 默认要挂到浏览器自己的上限（分钟级），而检查是自动发起的。 */
    var MARKET_INDEX_TIMEOUT_MS = 8000;

    var $ = function (id) { return document.getElementById(id); };

    var lastIndex = null;
    var lastInstalled = null;
    /** 批量更新正在逐条安装（此时 modsUpdateBusy 也为真，安装管线自己的调用不能被那道闸挡住） */
    var batchInstalling = false;
    // 打开市场后下一次 renderMarketList 播卡片入场，之后（搜索/刷新）不再播。
    var marketEntrancePending = false;

    function marketIndexUrl() {
        try {
            var v = (window.Store && typeof Store.getItem === 'function') ? Store.getItem(URL_KEY) : '';
            if (v && String(v).trim()) return String(v).trim();
        } catch (e) { /* 忽略 */ }
        return DEFAULT_INDEX_URL;
    }

    function setHint(text, cls) {
        var el = $('marketHint');
        if (!el) return;
        el.textContent = text;
        el.className = 'text-[11px] leading-relaxed mb-3 ' + (cls || 'text-dim');
    }

    /** 镜像源：cdn.jsdelivr.net 在部分网络被重置，gcore/testingcf 能落到包，索引清单也必须与包一致。 */
    var MIRROR_INDEX_URLS = [
        'https://cdn.jsdelivr.net/gh/XYZ921746/web@main/store/index.json',
        'https://gcore.jsdelivr.net/gh/XYZ921746/web@main/store/index.json',
        'https://testingcf.jsdelivr.net/gh/XYZ921746/web@main/store/index.json',
    ];
    /** 商店源候选：自定义 → Pages → 镜像，逐个尝试，全失败才报错。 */
    function marketIndexUrls() {
        var out = [];
        var push = function (u) { u = String(u || '').trim(); if (u && out.indexOf(u) < 0) out.push(u); };
        var custom = '';
        try { custom = String(Store.getItem(URL_KEY) || '').trim(); } catch (e) { /* 忽略 */ }
        if (custom) push(custom);
        push(DEFAULT_INDEX_URL);
        for (var i = 0; i < MIRROR_INDEX_URLS.length; i++) push(MIRROR_INDEX_URLS[i]);
        return out;
    }

    /** 拉索引：多源逐个试，全失败抛最后一个异常；no-cache 保留 ETag 复用又能每次回源验证。 */
    async function fetchMarketIndex() {
        var lastErr = null;
        var urls = marketIndexUrls();
        for (var i = 0; i < urls.length; i++) {
            var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
            var timer = ctrl ? setTimeout(function () {
                try { ctrl.abort(); } catch (e) { /* 忽略 */ }
            }, MARKET_INDEX_TIMEOUT_MS) : 0;
            try {
                var res = await fetch(urls[i], { cache: 'no-cache', signal: ctrl ? ctrl.signal : undefined });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                var data = await res.json();
                var plugins = (data && Array.isArray(data.plugins)) ? data.plugins : [];
                if (!plugins.length) throw new Error('索引里没有插件');
                lastIndex = data;
                return { data: data, plugins: plugins };
            } catch (e) {
                lastErr = (e && e.name === 'AbortError')
                    ? new Error('商店源响应超时（' + Math.round(MARKET_INDEX_TIMEOUT_MS / 1000) + 's）')
                    : e;
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
        throw lastErr || new Error('没有可用的商店源');
    }

    /** 本机已装：磁盘清单 + ElainaMods 运行时状态（未启用 / 缺依赖）合并成 id → 状态。 */
    async function installedMap() {
        var map = new Map();
        try {
            var res = await fetch('/api/plugins', { cache: 'no-store' });
            if (res.ok) {
                var data = await res.json();
                for (var p of ((data && data.plugins) || [])) {
                    map.set(p.id, { version: p.version || '', enabled: p.defaultEnabled === true });
                }
            }
        } catch (e) { /* APK 或服务未起：下面那份兜底 */ }
        var list = (window.ElainaMods && typeof ElainaMods.list === 'function') ? ElainaMods.list() : [];
        for (var m of list) {
            var cur = map.get(m.id) || {};
            cur.version = cur.version || m.version || '';
            cur.enabled = !!m.enabled;
            cur.state = m.state || '';
            cur.missingDeps = Array.isArray(m.missingDeps) ? m.missingDeps : [];
            map.set(m.id, cur);
        }
        return map;
    }

    function marketCard(p, installed, animate) {
        var st = statusOf(p, installed);
        var size = fmtSize(p.sizeBytes);
        var depLine = '';
        var deps = Array.isArray(p.depends) ? p.depends : [];
        if (deps.length) {
            var missing = [];
            if (st !== 'absent') {
                for (var d of deps) {
                    var dep = installed.get(d);
                    if (!dep) missing.push(d + '（未安装）');
                    else if (dep.state === 'disabled') missing.push(d + '（未启用）');
                }
            }
            depLine = '<div class="text-[11px] text-dim leading-relaxed mt-0.5">依赖：' + esc(deps.join('、')) + '</div>';
            if (missing.length) {
                depLine += '<span class="block text-[11px] text-danger leading-relaxed mt-1">'
                    + '缺依赖：' + esc(missing.join('、')) + ' —— 先把它装上并打开开关</span>';
            }
        }

        // 通用插件不打角标：多数插件都是通用，全打等于没打。
        var plat = platformOf(p);
        var platBadge = (plat === 'universal') ? ''
            : badge(plat === 'desktop' ? '电脑' : '手机', 'accent');
        var kindBadge = badge(p.kind === 'resource' ? '公共资源' : '界面', 'neutral');
        var verBadge = p.version ? '<span class="text-[10px] text-dim ml-1">v' + esc(p.version) + '</span>' : '';
        var stateBadge = (st === 'installed')
            ? badge('已安装', 'ok')
            : (st === 'update' ? badge('可更新', 'warn') : '');

        var btnText = (st === 'installed') ? '已安装' : (st === 'update' ? '更新' : '安装');
        var disabled = (st === 'installed') ? ' disabled' : '';
        var btn = '<button type="button" class="btn-secondary text-xs market-install-btn"'
            + ' data-market-id="' + esc(p.id) + '"' + disabled
            + ' style="padding:5px 12px">' + btnText + '</button>';

        return '<div class="mod-card' + (animate ? ' animate-fade-in-up' : '') + '" data-market-card="' + esc(p.id) + '">'
            + '<div class="min-w-0 flex-1">'
              + '<div class="flex items-start gap-2">'
                + '<div class="min-w-0 flex-1">'
                  + '<span class="text-xs font-semibold text-ink">' + esc(p.name || p.id) + '</span>'
                  + verBadge + platBadge + kindBadge + stateBadge
                  + '<div class="text-[11px] text-dim leading-relaxed mt-0.5">' + md(p.description) + '</div>'
                  + depLine
                + '</div>'
                + '<div class="flex-none pt-0.5">' + btn + '</div>'
              + '</div>'
              + (size ? '<div class="text-[10px] text-dim mt-1">包大小 ' + size + '</div>' : '')
            + '</div>'
          + '</div>';
    }

    /** 前置判定在 market-utils.js 的 isPrerequisiteOnly：prerequisite / hidden 显式声明优先于 kind 推断。 */
    /** 搜索词（小写），空串表示不过滤 */
    function marketQuery() {
        var el = $('marketSearch');
        return el ? String(el.value || '').trim().toLowerCase() : '';
    }

    /** 设备判定沿用 core.js 的 IS_MOBILE_DEVICE（APK 恒为手机）；guarded 引用，脚本被单独裁剪时不炸。 */
    function marketIsMobile() {
        return typeof IS_MOBILE_DEVICE !== 'undefined' && !!IS_MOBILE_DEVICE;
    }

    /** 平台分类筛选：all / mobile / desktop，单选；打开市场重置，不跨次记忆。 */
    var marketPlatform = 'all';

    /** 分类 chips 是静态 HTML，不随列表重渲，aria-pressed 要单独同步。 */
    function syncMarketPlatformPills() {
        var group = $('marketPlatformPills');
        if (!group) return;
        var btns = group.querySelectorAll('button[data-platform]');
        for (var i = 0; i < btns.length; i++) {
            btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-platform') === marketPlatform ? 'true' : 'false');
        }
    }

    /** 只认三个合法值，其余归 all（防自定义索引或传参带脏值）。 */
    function setMarketPlatform(v) {
        marketPlatform = (v === 'mobile' || v === 'desktop') ? v : 'all';
        syncMarketPlatformPills();
        renderMarketList();
    }

    /** 命中 id / 名字 / 说明 / 依赖：用户常按“能干什么”搜，只匹配名字太窄。 */
    /** 前置扩展区展开态：只存内存，同一次打开里搜索不把它重置。 */
    var marketPrereqOpen = false;

    /** 分区标题：点标题展开/收起 */
    function marketSectionHead(count, note) {
        var caret = marketPrereqOpen ? '▾' : '▸';
        return '<button type="button" id="marketPrereqToggle" class="w-full flex items-baseline gap-2 pt-2 text-left"'
            + ' aria-expanded="' + (marketPrereqOpen ? 'true' : 'false') + '"'
            + ' title="前置扩展默认收起；点一下展开">'
            + '<span class="text-[11px] font-semibold text-dim">前置扩展</span>'
            + '<span class="text-[10px] text-dim">' + count + ' 个 · ' + esc(note) + '</span>'
            + '<span class="ml-auto text-[10px] text-dim" data-prereq-caret>' + caret + '</span>'
            + '</button>';
    }

    function bindPrereqToggle(box) {
        var btn = box.querySelector('#marketPrereqToggle');
        var body = box.querySelector('#marketPrereqBody');
        if (!btn || !body) return;
        btn.addEventListener('click', function () {
            marketPrereqOpen = !marketPrereqOpen;
            body.classList.toggle('hidden', !marketPrereqOpen);
            btn.setAttribute('aria-expanded', marketPrereqOpen ? 'true' : 'false');
            var c = btn.querySelector('[data-prereq-caret]');
            if (c) c.textContent = marketPrereqOpen ? '▾' : '▸';
        });
    }

    function renderMarketList() {
        var box = $('marketList');
        if (!box || !lastIndex) return;
        var installed = lastInstalled || new Map();
        var all = Array.isArray(lastIndex.plugins) ? lastIndex.plugins : [];
        var groups = splitMarketPlugins(all);
        var q = marketQuery();
        var isMobile = marketIsMobile();
        var byPlatform = function (p) { return matchesPlatform(p, marketPlatform, isMobile) && matchesQuery(p, q); };
        var normal = groups.normal.filter(byPlatform);
        var prereq = groups.prereq.filter(byPlatform);
        var hit = normal.length + prereq.length;
        // 手机端「全部」视图藏着电脑插件时要点名，否则用户会以为商店只有眼前这几个
        var hiddenDesktop = 0;
        if (isMobile && marketPlatform === 'all') {
            for (var i = 0; i < all.length; i++) if (platformOf(all[i]) === 'desktop') hiddenDesktop++;
        }
        var desktopNote = hiddenDesktop ? ' 另有 ' + hiddenDesktop + ' 个电脑插件在手机上不显示，点「电脑」分类查看。' : '';

        if (!hit) {
            var why = q ? '没有匹配「' + esc(q) + '」的扩展包。' : '这个分类下暂无扩展包。';
            box.innerHTML = '<div class="text-[11px] text-dim">' + why + '</div>';
            setHint('共 ' + all.length + ' 个扩展包，当前筛选出 0 个。换个分类或换个词试试。' + desktopNote, 'text-dim');
            return;
        }
        // 入场动画只在打开市场后的首次渲染播一次：搜索框每敲一键都重渲列表，逐卡重播会闪成一片。
        var animate = marketEntrancePending;
        marketEntrancePending = false;
        box.innerHTML = normal.map(function (p) { return marketCard(p, installed, animate); }).join('')
            + (prereq.length
                ? marketSectionHead(prereq.length, '被界面类扩展包按依赖自动带入，不用单独安装')
                    + '<div id="marketPrereqBody" class="space-y-2' + (marketPrereqOpen ? '' : ' hidden') + '">'
                    + prereq.map(function (p) { return marketCard(p, installed, animate); }).join('')
                    + '</div>'
                : '');
        bindPrereqToggle(box);
        setHint('共 ' + all.length + ' 个扩展包'
            + (q ? '，筛选出 ' + hit + ' 个' : '')
            + (!q && prereq.length ? '（其中 ' + prereq.length + ' 个是前置扩展）' : '')
            + '。' + desktopNote + '装完回到「插件」栏打开开关才会生效。（源：' + marketIndexUrl() + '）',
            'text-dim');
    }

    /** 拉索引 + 算已装 + 渲染，保留搜索词 */
    async function refreshMarketList() {
        var box = $('marketList');
        if (!box) return;
        box.innerHTML = '<div class="text-[11px] text-dim">正在读取商店索引…</div>';
        try {
            await fetchMarketIndex();
            lastInstalled = await installedMap();
            renderMarketList();
        } catch (err) {
            lastIndex = null;
            box.innerHTML = '';
            setHint('商店索引读取失败：' + String((err && err.message) || err)
                + '。检查网络，或把下面的「商店源」改成可用的索引地址。', 'text-danger');
        }
    }

    var dlTasks = new Map();      // id → task（Map 保持插入序，即展示序）
    var dlSeq = 0;
    var dlOpen = true;            // 折叠态只存内存：每次打开市场都该能一眼看到进度
    var dlRenderQueued = false;
    var dlDismissed = false;      // 点 ✕ 收起：只影响显示，下载照跑，新任务时自动回来

    function dlTaskNew(title, pid, p) {
        var id = ++dlSeq;
        dlTasks.set(id, {
            id: id, title: title, pid: pid || '', p: p || null,
            phase: 'prep', note: '', got: 0, tot: 0, doneAt: 0,
            stopped: false,
            ctrl: (typeof AbortController === 'function') ? new AbortController() : null,
        });
        dlDismissed = false;   // 收起过也不影响：新一轮下载必须让用户看得见
        dlRender();
        return id;
    }

    function dlTaskPatch(id, patch) {
        var t = dlTasks.get(id);
        if (!t) return;
        for (var k in patch) t[k] = patch[k];
        dlRender();
    }

    /** 收尾任务：行不自动消失，成功行要留「卸载」，失败/停止行要留原因。 */
    function dlTaskDone(id, phase, note) {
        var t = dlTasks.get(id);
        if (!t) return;
        t.phase = phase;
        t.note = note || '';
        t.doneAt = Date.now();
        dlRender();
    }

    function dlDropFinished() {
        var n = 0;
        dlTasks.forEach(function (t) {
            if (t.phase === 'done' || t.phase === 'error' || t.phase === 'stopped') { dlTasks.delete(t.id); n++; }
        });
        if (n) dlRender();
    }

    /** 停止：先标记 stopped 再 abort，catch 据此归为「已停止」而非失败 */
    function dlStop(id) {
        var t = dlTasks.get(id);
        if (!t || t.stopped) return;
        t.stopped = true;
        if (t.ctrl) { try { t.ctrl.abort(); } catch (e) { /* 忽略 */ } }
        dlTaskPatch(id, { note: '正在停止…' });
    }

    /** 继续：已装好的包跳过；停止时正在下的包没有断点信息，只能从头下。 */
    function dlResume(id) {
        var t = dlTasks.get(id);
        if (!t || t.phase !== 'stopped' || !t.p) return;
        t.stopped = false;
        t.ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        dlTaskPatch(id, { phase: 'prep', note: '', got: 0, tot: 0 });
        void installFromMarket(t.p, null, id);
    }

    /** 卸载本次主插件：先查依赖方，依赖包是共享底座，不动。 */
    async function dlUninstall(id) {
        var t = dlTasks.get(id);
        if (!t || t.phase !== 'done' || !t.pid) return;
        if (window.ElainaMods && typeof window.ElainaMods.dependentsOf === 'function') {
            var using = window.ElainaMods.dependentsOf(t.pid);
            if (using.length) {
                var names = using.map(function (u) { return '「' + (u.name || u.id) + '」'; }).join('、');
                if (typeof showCustomAlert === 'function') {
                    showCustomAlert(names + ' 正在使用这个插件。如需卸载，请先关闭 ' + names + '。', '不能卸载');
                } else {
                    dlTaskDone(id, 'error', '不能卸载：' + names + ' 正在使用它');
                }
                return;
            }
        }
        var okToGo = (typeof showCustomConfirm === 'function')
            ? await showCustomConfirm('卸载插件「' + t.title + '」？\n\n会把插件目录和安装包一起删掉；要再用得重新下载。', '卸载插件')
            : true;
        if (!okToGo) return;
        dlTaskPatch(id, { phase: 'uninstall', note: '' });
        try {
            var res = await fetch('/api/plugins/' + encodeURIComponent(t.pid), { method: 'DELETE' });
            var data = await res.json().catch(function () { return null; });
            if (!res.ok || !data || data.ok === false) throw new Error((data && data.message) || ('HTTP ' + res.status));
            if (window.ElainaMods && typeof window.ElainaMods.forget === 'function') window.ElainaMods.forget(t.pid);
            dlTaskDone(id, 'done', '已卸载（依赖的公共资源包保留）');
            if (typeof refreshModsList === 'function') void refreshModsList();
            void refreshMarketList();
        } catch (err) {
            dlTaskDone(id, 'error', '卸载失败：' + String((err && err.message) || err));
        }
    }

    /** 渲染合帧：避免字节回调把 DOM 刷成幻灯片 */
    function dlRender() {
        if (dlRenderQueued) return;
        dlRenderQueued = true;
        setTimeout(function () { dlRenderQueued = false; dlRenderNow(); }, 120);
    }

    function dlPhaseText(t) {
        if (t.phase === 'prep') return '准备中…';
        if (t.phase === 'install') return '安装中…';
        if (t.phase === 'uninstall') return '卸载中…';
        if (t.phase === 'done') return '✅ 已完成';
        if (t.phase === 'error') return '❌ 失败';
        if (t.phase === 'stopped') return '⏹ 已停止';
        if (t.tot > 0) return '下载 ' + Math.min(100, Math.floor(t.got / t.tot * 100)) + '%';
        return '下载中 · 已下 ' + (fmtSize(t.got) || '0 KB');
    }

    function dlRowHtml(t) {
        var pct = (t.tot > 0) ? Math.min(100, Math.floor(t.got / t.tot * 100)) : -1;
        var barCls = 'h-full rounded-full transition-[width] duration-150 ';
        var barStyle = '';
        if (t.phase === 'done') { barCls += 'bg-ok'; barStyle = 'width:100%'; }
        else if (t.phase === 'error') { barCls += 'bg-danger'; barStyle = 'width:100%'; }
        else if (t.phase === 'stopped') { barCls += 'bg-slate-400'; barStyle = 'width:100%'; }
        else if (t.phase === 'install') { barCls += 'bg-accent animate-pulse'; barStyle = 'width:100%'; }
        else if (t.phase === 'uninstall') { barCls += 'bg-warn animate-pulse'; barStyle = 'width:100%'; }
        else if (pct >= 0) { barCls += 'bg-accent'; barStyle = 'width:' + pct + '%'; }
        else { barCls += 'bg-accent animate-pulse'; barStyle = 'width:100%'; }

        var note = String(t.note || '');
        if (t.phase === 'download') {
            note += (t.tot > 0)
                ? ' · ' + (fmtSize(t.got) || '0 KB') + ' / ' + fmtSize(t.tot)
                : ' · 已下 ' + (fmtSize(t.got) || '0 KB');
        }
        var noteCls = 'text-[10px] leading-relaxed mt-0.5 ' + (t.phase === 'error' ? 'text-danger' : 'text-dim');
        var act = '';
        if (t.phase === 'prep' || t.phase === 'download' || t.phase === 'install') {
            act = '<button type="button" data-dl-stop="' + t.id + '" class="flex-none rounded px-1 text-[10px] text-danger hover:text-danger" title="停止这次安装（已装上的包会留下）">停止</button>';
        } else if (t.phase === 'done') {
            act = '<button type="button" data-dl-un="' + t.id + '" class="flex-none rounded px-1 text-[10px] text-dim hover:text-soft" title="卸载这次装上的主插件（公共资源包保留）">卸载</button>'
                + '<button type="button" data-dl-x="' + t.id + '" class="flex-none rounded px-1 text-[10px] text-dim hover:text-soft" title="从列表移掉这一行">✕</button>';
        } else if (t.phase === 'stopped') {
            act = '<button type="button" data-dl-go="' + t.id + '" class="flex-none rounded px-1 text-[10px] text-ok hover:text-ok" title="接着装完（已装好的包不会重新下载）">继续</button>'
                + '<button type="button" data-dl-x="' + t.id + '" class="flex-none rounded px-1 text-[10px] text-dim hover:text-soft" title="从列表移掉这一行">✕</button>';
        } else {
            act = '<button type="button" data-dl-x="' + t.id + '" class="flex-none rounded px-1 text-[10px] text-dim hover:text-soft" title="从列表移掉这一行">✕</button>';
        }
        return '<div class="market-dl-row" data-dl-id="' + t.id + '">'
            + '<div class="flex items-baseline gap-2">'
              + '<span class="truncate text-[11px] font-semibold text-ink">' + esc(t.title) + '</span>'
              + '<span class="flex-none text-[10px] text-dim">' + esc(dlPhaseText(t)) + '</span>'
              + '<span class="ml-auto flex flex-none items-center gap-0.5">' + act + '</span>'
            + '</div>'
            + (note ? '<div class="' + noteCls + '">' + esc(note) + '</div>' : '')
            + '<div class="mt-1 h-1 overflow-hidden rounded-full bg-black/10"><div class="' + barCls + '" style="' + barStyle + '"></div></div>'
            + '</div>';
    }

    function dlRenderNow() {
        var panel = $('marketDlPanel');
        var body = $('marketDlBody');
        if (!panel || !body) return;
        if (!dlTasks.size || dlDismissed) {
            panel.classList.add('hidden');
            body.innerHTML = '';
            return;
        }
        panel.classList.remove('hidden');
        var running = 0, finished = 0;
        dlTasks.forEach(function (t) {
            if (t.phase === 'done' || t.phase === 'error' || t.phase === 'stopped') finished++; else running++;
        });
        var count = $('marketDlCount');
        if (count) count.textContent = running
            ? (running + ' 个进行中' + (finished ? ' · ' + finished + ' 个已结束' : ''))
            : (finished + ' 个已结束');
        var clearBtn = $('marketDlClear');
        if (clearBtn) clearBtn.classList.toggle('hidden', !finished);
        var caret = $('marketDlCaret');
        if (caret) caret.textContent = dlOpen ? '▾' : '▸';
        var head = $('marketDlHead');
        if (head) head.setAttribute('aria-expanded', dlOpen ? 'true' : 'false');
        body.innerHTML = Array.from(dlTasks.values()).map(dlRowHtml).join('');
        body.classList.toggle('hidden', !dlOpen);
    }

    /** 安装插件及其依赖：下载 → 复用上传安装协议 → 重扫加载并刷新两栏。 */
    async function installFromMarket(p, btn, reuseDlId) {
        // 批量更新跑着时不再从市场/卡片另起一条安装链：同一个插件 id 的两条「删目录 + 重命名」会交错，
        // 第二个 rename 在 Windows 上直接 EPERM。等这一轮结束再来。
        if (!batchInstalling && typeof modsUpdateBusy !== 'undefined' && modsUpdateBusy) {
            if (typeof showCustomAlert === 'function') showCustomAlert('正在更新插件，等这一轮结束再安装。', '请稍候');
            return false;
        }
        var name = packageNameOf(p);
        var label = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = '准备中…'; }
        var dlId = reuseDlId || dlTaskNew(p.name || p.id, p.id, p);
        var tsk = dlTasks.get(dlId);
        try {
            if (!p.downloadUrl) throw new Error('索引里这条没有 downloadUrl');

            // 依赖必须先算齐：用整份索引（含收起的前置），缺一个主体就拒绝加载。
            var all = (lastIndex && Array.isArray(lastIndex.plugins)) ? lastIndex.plugins : [];
            var byId = new Map();
            for (var one of all) byId.set(one.id, one);
            var installed = await installedMap();
            var queue = resolveInstallOrder(p, byId, installed);
            if (!queue.some(function (q) { return q.plugin.id === p.id; })) {
                queue.push({ plugin: p, missingBehind: [] });
            }

            var done = [];
            for (var i = 0; i < queue.length; i++) {
                if (tsk && tsk.stopped) break;   // 用户点过停止：后面的包（含本体）不再装
                var item = queue[i];
                var cur = item.plugin;
                var isMain = cur.id === p.id;
                var total = queue.length;
                var prefix = total > 1 ? '（' + (i + 1) + '/' + total + '）' : '';

                if (item.missingBehind.length) {
                    setHint('注意：' + (cur.name || cur.id) + ' 依赖的 '
                        + item.missingBehind.join('、') + ' 在商店里找不到，装完可能无法加载。',
                        'text-warn');
                }

                var pkgName = packageNameOf(cur);
                setHint(prefix + '正在下载 ' + (cur.name || cur.id) + ' …', 'text-dim');
                var pkgBytes = Number(cur.sizeBytes) || 0;
                dlTaskPatch(dlId, { phase: 'download', note: prefix + (cur.name || cur.id), got: 0, tot: pkgBytes });
                var blob = await downloadZip(cur.downloadUrl, pkgBytes, function (got, tot) {
                    if (btn && isMain) {
                        var shown;
                        if (tot) shown = Math.floor(got / tot * 100) + '%';
                        else shown = fmtSize(got) || (Math.round(got / 1024) + ' KB');
                        btn.textContent = '下载 ' + shown;
                    }
                    dlTaskPatch(dlId, { got: got, tot: tot || pkgBytes });
                }, tsk && tsk.ctrl ? tsk.ctrl.signal : undefined);
                if (btn && isMain) btn.textContent = '安装中…';
                dlTaskPatch(dlId, { phase: 'install', note: prefix + (cur.name || cur.id) });
                setHint(prefix + '正在安装 ' + (cur.name || cur.id) + ' …', 'text-dim');

                var res = await fetch('/api/plugins/install?name=' + encodeURIComponent(pkgName), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/zip' },
                    body: blob,
                    signal: tsk && tsk.ctrl ? tsk.ctrl.signal : undefined,   // 停止要能掐断上传
                });
                var data = await res.json().catch(function () { return null; });
                if (!res.ok || !data || !data.ok) {
                    throw new Error((data && data.message) || ('HTTP ' + res.status));
                }
                done.push(cur.name || cur.id);
            }

            // 装完必须重扫：否则新插件不在注册表里，开关点了也不生效；重扫还会重新评估依赖。
            var reloaded = false;
            try {
                if (window.ElainaMods && typeof window.ElainaMods.reload === 'function') {
                    await window.ElainaMods.reload();
                    reloaded = true;
                }
            } catch (e) { /* 加载失败不该把"安装成功"说成失败 */ }
            var extra = done.length > 1
                ? '（含依赖 ' + done.slice(0, -1).join('、') + '）'
                : '';
            setHint((reloaded ? '✅ 已安装并已加载 ' : '✅ 已安装 ')
                + (p.name || p.id) + extra
                + (reloaded ? '，已生效。' : '，刷新页面后生效。'), 'text-ok');
            dlTaskDone(dlId, 'done', (reloaded ? '已安装并已加载' : '已安装，刷新页面后生效') + extra);
            if (typeof refreshModsList === 'function') void refreshModsList();
            await refreshMarketList();
            return true;
        } catch (err) {
            // 主动停止不算失败：收成「已停止」，不标红
            var stopped = !!(tsk && tsk.stopped);
            if (btn) { btn.disabled = false; btn.textContent = label; }
            dlTaskDone(dlId, stopped ? 'stopped' : 'error',
                stopped ? '已停止；点「继续」接着装，已装好的包不会重下' : String((err && err.message) || err));
            setHint(stopped
                ? '已停止安装 ' + (p.name || p.id) + '。已装上的包保留，想续装再点一次安装。'
                : '安装失败：' + String((err && err.message) || err),
                stopped ? 'text-warn' : 'text-danger');
            return false;
        }
    }

    /** 更新检查：拉一遍商店索引（自定义源优先，多源回退），与本机已装版本逐条比对；索引拉不动就抛给调用方处理。 */
    async function checkModUpdates(installedList) {
        await fetchMarketIndex();
        return sortUpdateFirstDeps(updateCandidatesOf(installedList, lastIndex.plugins));
    }

    /** 批量更新：逐个走安装管线（右下角悬浮窗逐条显示进度），返回逐条成败，失败的由调用方留在待更清单里。 */
    async function updateModsBatch(items) {
        var list = Array.isArray(items) ? items : [];
        var out = [];
        batchInstalling = true;
        try {
            for (var i = 0; i < list.length; i++) {
                var ok = await installFromMarket(list[i].plugin, null);
                out.push({ id: list[i].plugin.id, ok: ok === true });
            }
        } finally {
            batchInstalling = false;
        }
        return out;
    }

    /** 打开市场：每次重拉索引且不预拉，避免拿到设备间过期的列表。 */
    function openMarket() {
        var overlay = $('marketOverlay');
        if (!overlay) return;
        marketEntrancePending = true;
        marketPlatform = 'all';
        syncMarketPlatformPills();
        openOverlayPanel(overlay);
        try { if (typeof syncSidePanelForView === 'function') syncSidePanelForView(); } catch (e) { /* 忽略 */ }
        dlDismissed = false;   // 进市场 = 想管下载，收起态要解开
        dlRender();            // 下载中重开市场：任务行要立即反映当前进度
        void refreshMarketList();
    }

    function closeMarket() {
        var overlay = $('marketOverlay');
        if (!overlay) return;
        closeOverlayPanel(overlay, function () {
            try { if (typeof syncSidePanelForView === 'function') syncSidePanelForView(); } catch (e) { /* 忽略 */ }
        });
    }

    function bindMarketEvents() {
        // 回填已保存的商店源（空 = 用默认地址）
        var urlInput = $('marketUrl');
        if (urlInput) {
            try { urlInput.value = Store.getItem(URL_KEY) || ''; } catch (e) { /* 忽略 */ }
        }

        $('marketRefreshBtn')?.addEventListener('click', function () { void refreshMarketList(); });

        // 搜索：本地过滤，索引与已装状态已在内存
        $('marketSearch')?.addEventListener('input', function () { renderMarketList(); });

        // 分类 chips：与安装按钮同一套事件委托，单选切换后重渲列表
        $('marketPlatformPills')?.addEventListener('click', function (ev) {
            var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-platform]') : null;
            if (!btn) return;
            setMarketPlatform(btn.getAttribute('data-platform'));
        });

        $('marketUrlSave')?.addEventListener('click', function () {
            var input = $('marketUrl');
            var v = input ? String(input.value || '').trim() : '';
            try {
                if (v) Store.setItem(URL_KEY, v); else Store.removeItem(URL_KEY);
                if (window.Store && typeof Store._flush === 'function') Store._flush();
            } catch (e) { /* 忽略 */ }
            void refreshMarketList();
        });

        // 安装按钮用事件委托：卡片是整批 innerHTML 重写的，逐个绑定会失效
        $('marketList')?.addEventListener('click', function (ev) {
            var btn = ev.target && ev.target.closest ? ev.target.closest('.market-install-btn') : null;
            if (!btn || btn.disabled) return;
            var id = btn.getAttribute('data-market-id');
            var p = (lastIndex && Array.isArray(lastIndex.plugins))
                ? lastIndex.plugins.find(function (x) { return x.id === id; }) : null;
            if (!p) { setHint('找不到这个插件的索引条目，请先点刷新。', 'text-danger'); return; }
            void installFromMarket(p, btn);
        });

        $('modsMarketBtn')?.addEventListener('click', openMarket);

        // 下载悬浮窗：停止/卸载/单行移除/清空/收起/折叠，同样用事件委托（行是整批重建的）
        var dlPanel = $('marketDlPanel');
        if (dlPanel) {
            dlPanel.addEventListener('click', function (ev) {
                var t = ev.target;
                if (!t || !t.closest) return;
                var go = t.closest('[data-dl-go]');
                if (go) { dlResume(Number(go.getAttribute('data-dl-go'))); return; }
                var stop = t.closest('[data-dl-stop]');
                if (stop) { dlStop(Number(stop.getAttribute('data-dl-stop'))); return; }
                var un = t.closest('[data-dl-un]');
                if (un) { void dlUninstall(Number(un.getAttribute('data-dl-un'))); return; }
                var x = t.closest('[data-dl-x]');
                if (x) { dlTasks.delete(Number(x.getAttribute('data-dl-x'))); dlRender(); return; }
                if (t.closest('#marketDlClear')) { dlDropFinished(); return; }
                if (t.closest('#marketDlHide')) { dlDismissed = true; dlRender(); return; }
                if (t.closest('#marketDlHead')) { dlOpen = !dlOpen; dlRender(); }
            });
        }

        // 关闭：✕ / 点遮罩 / Esc，与其它弹窗同一套习惯
        $('marketClose')?.addEventListener('click', closeMarket);
        var overlay = $('marketOverlay');
        if (overlay) {
            overlay.addEventListener('click', function (e) { if (e.target === overlay) closeMarket(); });
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeMarket();
            });
        }
    }

    window.ElainaMarket = {
        refresh: refreshMarketList,
        open: openMarket,
        close: closeMarket,
        indexUrl: marketIndexUrl,
        checkUpdates: checkModUpdates,
        updateBatch: updateModsBatch,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindMarketEvents);
    } else {
        bindMarketEvents();
    }
})();
