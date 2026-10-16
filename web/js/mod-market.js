/* ============================================================================
 * 插件市场（从 web 仓库拉取可选扩展包并安装）
 *
 * ── 与「插件」栏的分工（刻意分开，不混成一屏）────────────────────────────
 *
 *   · 插件栏   —— 管**本机已装**的插件：开关、设置、删除、拖拽分栏。
 *   · 插件市场 —— 管**从商店下载并安装**：列出 web 仓库里有哪些扩展包可用。
 *                 从插件栏右上角的按钮打开，**独立成窗、不占主设置的分栏**。
 *
 * 为什么分开：两者的**数据源与动作完全不同**（本地磁盘 vs 远程仓库），
 * 混在一屏会让"这个插件到底装没装"变得难以判断。这与"技能不混进插件列表"、
 * "插件设置独立成窗"是同一条取舍（见 app-06-settings.js 与 host-slots.js 的注释）。
 *
 * ── 数据源 ────────────────────────────────────────────────────────────
 *
 * web 仓库（XYZ921746/web）Pages 上的 `store/index.json`：
 *   { baseUrl, plugins: [ { id, name, version, kind, description, depends,
 *                          sizeBytes, downloadUrl } ] }
 * 包地址就是 baseUrl 下的 `<id>-<version>.zip`。Pages 返回
 * `Access-Control-Allow-Origin: *`，所以前端可以直接 fetch（实测确认）。
 * 索引地址可用设置里的「商店源」覆盖（Store 键 elaina_market_url）。
 *
 * ── 安装走的是**原有协议**，两端通用 ──────────────────────────────────
 *
 * 「上传安装」那条路：POST /api/plugins/install?name=<zip名>，请求体就是
 * zip 的原始字节（见 app-07-init.js）。这里只是把"用户在文件选择器里选的
 * 文件"换成"从商店下载到的 Blob"，其余**一个字都不用改**。
 * 安卓侧更省事：app-01-core.js 改写过 window.fetch，会把这个请求拦到
 * nativeInstallPlugin —— 所以同一段代码在电脑与手机上都能装。
 * ========================================================================== */

(function () {
    'use strict';

    /** 默认商店源：web 仓库 Pages 上的索引 */
    var DEFAULT_INDEX_URL = 'https://xyz921746.github.io/web/store/index.json';
    /** 自定义商店源的 Store 键（已同步进 store.js 的 DATA_KEYS，否则写入会被静默丢弃） */
    var URL_KEY = 'elaina_market_url';

    var $ = function (id) { return document.getElementById(id); };

    /** 上一次拉到的索引与"已装"快照：搜索框过滤时复用，避免每敲一个字就打一次网络 */
    var lastIndex = null;
    var lastInstalled = null;

    function marketIndexUrl() {
        try {
            var v = (window.Store && typeof Store.getItem === 'function') ? Store.getItem(URL_KEY) : '';
            if (v && String(v).trim()) return String(v).trim();
        } catch (e) { /* 忽略 */ }
        return DEFAULT_INDEX_URL;
    }

    function esc(t) {
        return (typeof escapeHtml === 'function') ? escapeHtml(t == null ? '' : t) : String(t == null ? '' : t);
    }

    function setHint(text, cls) {
        var el = $('marketHint');
        if (!el) return;
        el.textContent = text;
        el.className = 'text-[11px] leading-relaxed mb-3 ' + (cls || 'text-indigo-400');
    }

    function fmtSize(bytes) {
        if (!bytes || bytes < 0) return '';
        return (bytes >= 1048576)
            ? (bytes / 1048576).toFixed(1) + ' MB'
            : Math.max(1, Math.round(bytes / 1024)) + ' KB';
    }

    /** zip 文件名要能让服务端还原出插件 id：`<id>-<version>.zip`（见 server/mods.mjs 的 normalizeModId） */
    function packageNameOf(p) {
        var base = String(p.downloadUrl || '').split('?')[0].split('/').pop() || '';
        if (/\.zip$/i.test(base)) return base;
        return String(p.id) + '-' + (p.version || '0.0.0') + '.zip';
    }

    /** 内置镜像源：GitHub Pages 在大陆常被墙，jsDelivr 可达性好得多 */
    var MIRROR_INDEX_URL = 'https://cdn.jsdelivr.net/gh/XYZ921746/web@main/store/index.json';

    /**
     * 商店源候选（按顺序尝试）：自定义源 → Pages → jsDelivr 镜像。
     *
     * ★ 2026-10 加：与公告源（app-02-data.js 的 announceSourceUrls）是同一条可达性
     *   思路。原先只有单点 URL，源够不到的用户"整个市场都用不了"—— 多给一条镜像，
     *   大陆环境下能救回一大片。全失败才报错。
     */
    function marketIndexUrls() {
        var out = [];
        var push = function (u) { u = String(u || '').trim(); if (u && out.indexOf(u) < 0) out.push(u); };
        var custom = '';
        try { custom = String(Store.getItem(URL_KEY) || '').trim(); } catch (e) { /* 忽略 */ }
        if (custom) push(custom);
        push(DEFAULT_INDEX_URL);
        push(MIRROR_INDEX_URL);
        return out;
    }

    /** 拉索引：多源逐个试，全失败抛最后一个异常，由调用方决定怎么显示（不吞错） */
    async function fetchMarketIndex() {
        var lastErr = null;
        var urls = marketIndexUrls();
        for (var i = 0; i < urls.length; i++) {
            try {
                var res = await fetch(urls[i], { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                var data = await res.json();
                var plugins = (data && Array.isArray(data.plugins)) ? data.plugins : [];
                if (!plugins.length) throw new Error('索引里没有插件');
                lastIndex = data;
                return { data: data, plugins: plugins };
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('没有可用的商店源');
    }

    /**
     * 本机已装插件：id → { version, enabled, state, missingDeps }
     *
     * 两条来源都要（与 refreshModsList 同样的理由）：
     *   · /api/plugins —— 磁盘上有什么（APK 上由原生拦截器接住，形状一致）
     *   · ElainaMods.list() —— 实际加载结果（含"未启用""缺依赖"这些运行时状态）
     */
    async function installedMap() {
        var map = new Map();
        try {
            var res = await fetch('/api/plugins', { cache: 'no-store' });
            if (res.ok) {
                var data = await res.json();
                for (var p of ((data && data.plugins) || [])) {
                    map.set(p.id, { version: p.version || '', enabled: p.defaultEnabled !== false });
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

    /** 卡片状态：未安装 / 已安装 / 可更新 */
    function statusOf(p, installed) {
        var cur = installed.get(p.id);
        if (!cur) return 'absent';
        var mine = String(cur.version || ''), theirs = String(p.version || '');
        if (mine && theirs && mine !== theirs) return 'update';
        return 'installed';
    }

    function marketCard(p, installed) {
        var st = statusOf(p, installed);
        var size = fmtSize(p.sizeBytes);

        // 依赖：装了之后才提示"缺依赖"——没装时提示没意义（用户还没到那一步）
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
            depLine = '<div class="text-[11px] text-indigo-400 leading-relaxed mt-0.5">依赖：' + esc(deps.join('、')) + '</div>';
            if (missing.length) {
                depLine += '<span class="block text-[11px] text-red-500 leading-relaxed mt-1">'
                    + '缺依赖：' + esc(missing.join('、')) + ' —— 先把它装上并打开开关</span>';
            }
        }

        var kindBadge = '<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 ml-1">'
            + (p.kind === 'resource' ? '公共资源' : '界面') + '</span>';
        var verBadge = p.version ? '<span class="text-[10px] text-indigo-400 ml-1">v' + esc(p.version) + '</span>' : '';
        var stateBadge = (st === 'installed')
            ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600 ml-1">已安装</span>'
            : (st === 'update'
                ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-600 ml-1">可更新</span>' : '');

        var btnText = (st === 'installed') ? '已安装' : (st === 'update' ? '更新' : '安装');
        var disabled = (st === 'installed') ? ' disabled' : '';
        var btn = '<button type="button" class="btn-secondary text-xs market-install-btn"'
            + ' data-market-id="' + esc(p.id) + '"' + disabled
            + ' style="padding:5px 12px">' + btnText + '</button>';

        return '<div class="mod-card" data-market-card="' + esc(p.id) + '">'
            + '<div class="min-w-0 flex-1">'
              + '<div class="flex items-start gap-2">'
                + '<div class="min-w-0 flex-1">'
                  + '<span class="text-xs font-semibold text-indigo-800">' + esc(p.name || p.id) + '</span>'
                  + verBadge + kindBadge + stateBadge
                  + '<div class="text-[11px] text-indigo-400 leading-relaxed mt-0.5">' + esc(p.description || '') + '</div>'
                  + depLine
                + '</div>'
                + '<div class="flex-none pt-0.5">' + btn + '</div>'
              + '</div>'
              + (size ? '<div class="text-[10px] text-indigo-300 mt-1">包大小 ' + size + '</div>' : '')
            + '</div>'
          + '</div>';
    }

    /** 搜索词（小写）。空串 = 不过滤 */
    function marketQuery() {
        var el = $('marketSearch');
        return el ? String(el.value || '').trim().toLowerCase() : '';
    }

    /**
     * 一条索引是否命中搜索词。
     *
     * 匹配 id / 名字 / 说明 / 依赖 —— 只匹配名字太窄：用户往往是按"能干什么"找的
     * （搜 "live2d"、"背景"、"剧情"），这些词多半只出现在说明或依赖里。
     */
    function matchesQuery(p, q) {
        if (!q) return true;
        var hay = [p.id, p.name, p.description]
            .concat(Array.isArray(p.depends) ? p.depends : [])
            .join(' ').toLowerCase();
        return hay.indexOf(q) >= 0;
    }

    /** 只负责渲染（用内存里的索引与已装快照）—— 搜索框每敲一下就调这里，不打网络 */
    function renderMarketList() {
        var box = $('marketList');
        if (!box || !lastIndex) return;
        var installed = lastInstalled || new Map();
        var all = Array.isArray(lastIndex.plugins) ? lastIndex.plugins : [];
        var q = marketQuery();
        var plugins = all.filter(function (p) { return matchesQuery(p, q); });

        if (!plugins.length) {
            box.innerHTML = '<div class="text-[11px] text-indigo-400">没有匹配「' + esc(q) + '」的扩展包。</div>';
            setHint('共 ' + all.length + ' 个扩展包，当前筛选出 0 个。换个词试试，或清空搜索框。', 'text-indigo-400');
            return;
        }
        box.innerHTML = plugins.map(function (p) { return marketCard(p, installed); }).join('');
        setHint('共 ' + all.length + ' 个扩展包'
            + (q ? '，筛选出 ' + plugins.length + ' 个' : '')
            + '。装完回到「插件」栏打开开关才会生效。（源：' + marketIndexUrl() + '）',
            'text-indigo-400');
    }

    /** 拉索引 + 算已装状态 + 渲染（搜索词原样保留） */
    async function refreshMarketList() {
        var box = $('marketList');
        if (!box) return;
        box.innerHTML = '<div class="text-[11px] text-indigo-400">正在读取商店索引…</div>';
        try {
            await fetchMarketIndex();
            lastInstalled = await installedMap();
            renderMarketList();
        } catch (err) {
            lastIndex = null;
            box.innerHTML = '';
            setHint('商店索引读取失败：' + String((err && err.message) || err)
                + '。检查网络，或把下面的「商店源」改成可用的索引地址。', 'text-red-500');
        }
    }

    /**
     * 下载一个 zip。
     *
     * 为什么自己读流而不是 await res.blob()：要给用户看到进度 ——
     * 立绘、背景包有 7~10 MB，手机上一声不吭地等十几秒，用户会以为卡死了。
     * 拿不到 Content-Length（或环境不支持流式读取）时就退化成整体读，
     * 此时进度条只显示已下载字节数。
     */
    async function downloadZip(url, onProgress) {
        var res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
        var total = Number(res.headers.get('Content-Length') || 0);
        if (!res.body || typeof res.body.getReader !== 'function') {
            var buf = await res.arrayBuffer();
            if (onProgress) onProgress(buf.byteLength, buf.byteLength);
            return new Blob([buf], { type: 'application/zip' });
        }
        var reader = res.body.getReader();
        var chunks = [];
        var got = 0;
        for (;;) {
            var step = await reader.read();
            if (step.done) break;
            chunks.push(step.value);
            got += step.value.length;
            if (onProgress) onProgress(got, total);
        }
        return new Blob(chunks, { type: 'application/zip' });
    }

    /** 从市场安装一个插件（下载 → 复用上传安装协议 → 刷新两栏） */
    async function installFromMarket(p, btn) {
        var name = packageNameOf(p);
        var label = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = '准备中…'; }
        try {
            if (!p.downloadUrl) throw new Error('索引里这条没有 downloadUrl');
            setHint('正在下载 ' + (p.name || p.id) + ' …', 'text-indigo-400');
            var blob = await downloadZip(p.downloadUrl, function (got, total) {
                if (!btn) return;
                var shown;
                if (total) shown = Math.floor(got / total * 100) + '%';
                else shown = fmtSize(got) || (Math.round(got / 1024) + ' KB');
                btn.textContent = '下载 ' + shown;
            });
            if (btn) btn.textContent = '安装中…';
            var res = await fetch('/api/plugins/install?name=' + encodeURIComponent(name), {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: blob,
            });
            var data = await res.json().catch(function () { return null; });
            if (!res.ok || !data || !data.ok) {
                throw new Error((data && data.message) || ('HTTP ' + res.status));
            }
            // ★★ 2026-10 修（用户实测报障："下载成功、装上了，就是用不了"）：
            //   装完必须**重新扫描加载**（ElainaMods.reload → mods.js 的 loadAll）。
            //   插件的注册表只在页面启动时建立一次；不重扫的话这个新插件不在注册表里，
            //   插件栏的开关点了也不生效（setEnabled 取不到 entry 直接 return false），
            //   用户就会看到"装成功了但没有任何变化"。重扫还会**重新评估依赖**：
            //   之前因缺前置被拒的插件，前置补齐后会在这一轮里直接生效。
            var reloaded = false;
            try {
                if (window.ElainaMods && typeof window.ElainaMods.reload === 'function') {
                    await window.ElainaMods.reload();
                    reloaded = true;
                }
            } catch (e) { /* 加载失败不该把"安装成功"说成失败 */ }
            setHint((reloaded ? '✅ 已安装并已加载 ' : '✅ 已安装 ')
                + (p.name || p.id)
                + (reloaded ? '，已生效。' : '，刷新页面后生效。'), 'text-emerald-600');
            // 插件栏那份清单必须跟着刷新，否则用户切过去看不到刚装的插件
            if (typeof refreshModsList === 'function') void refreshModsList();
            await refreshMarketList();
        } catch (err) {
            if (btn) { btn.disabled = false; btn.textContent = label; }
            setHint('安装失败：' + String((err && err.message) || err), 'text-red-500');
        }
    }

    /**
     * 打开市场弹窗（入口是「插件」栏右上角那个按钮）。
     *
     * 为什么**不预拉**：市场是"想装东西时才点开"的地方，启动就多打一次网络没意义。
     * 每次打开都重拉一遍 —— 索引在别的设备上可能刚更新过（插件升版、上新），
     * 拿到旧的列表会让用户以为"商店里没有"。
     */
    function openMarket() {
        var overlay = $('marketOverlay');
        if (!overlay) return;
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
        void refreshMarketList();
    }

    function closeMarket() {
        var overlay = $('marketOverlay');
        if (!overlay) return;
        overlay.classList.add('hidden');
        overlay.classList.remove('flex');
    }

    function bindMarketEvents() {
        // 回填已保存的商店源（没存过就留空 —— 空 = 用默认地址，默认值写在 placeholder 上）
        var urlInput = $('marketUrl');
        if (urlInput) {
            try { urlInput.value = Store.getItem(URL_KEY) || ''; } catch (e) { /* 忽略 */ }
        }

        // 刷新
        $('marketRefreshBtn')?.addEventListener('click', function () { void refreshMarketList(); });

        // 搜索：**本地过滤**，不重新请求 —— 索引与已装状态已经在内存里了
        $('marketSearch')?.addEventListener('input', function () { renderMarketList(); });

        // 商店源：保存后立刻重拉（空值 = 恢复默认）
        $('marketUrlSave')?.addEventListener('click', function () {
            var input = $('marketUrl');
            var v = input ? String(input.value || '').trim() : '';
            try {
                if (v) Store.setItem(URL_KEY, v); else Store.removeItem(URL_KEY);
                if (window.Store && typeof Store._flush === 'function') Store._flush();
            } catch (e) { /* 忽略 */ }
            void refreshMarketList();
        });

        // 安装按钮：**事件委托**，卡片是整批 innerHTML 重写的，
        // 逐个绑定会在每次刷新后失效（这一点与插件列表同一套路，见 app-06-settings.js）
        $('marketList')?.addEventListener('click', function (ev) {
            var btn = ev.target && ev.target.closest ? ev.target.closest('.market-install-btn') : null;
            if (!btn || btn.disabled) return;
            var id = btn.getAttribute('data-market-id');
            var p = (lastIndex && Array.isArray(lastIndex.plugins))
                ? lastIndex.plugins.find(function (x) { return x.id === id; }) : null;
            if (!p) { setHint('找不到这个插件的索引条目，请先点刷新。', 'text-red-500'); return; }
            void installFromMarket(p, btn);
        });

        // 「插件」栏里的入口按钮（见 index.html 插件卡片标题行的那排按钮）
        $('modsMarketBtn')?.addEventListener('click', openMarket);

        // 关闭：✕ / 点遮罩 / Esc —— 与其它弹窗（插件 README、插件设置）同一套习惯
        $('marketClose')?.addEventListener('click', closeMarket);
        var overlay = $('marketOverlay');
        if (overlay) {
            overlay.addEventListener('click', function (e) { if (e.target === overlay) closeMarket(); });
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeMarket();
            });
        }

        // ★ 启动时**不**预拉：市场是"想装东西时才点开"的地方，启动就多打一次网络没意义。
        //   打开时拉（见 openMarket），每次都是新鲜数据。
    }

    // 供其它模块调用（例如以后想在别处放个"去市场"的入口）
    window.ElainaMarket = {
        refresh: refreshMarketList,
        open: openMarket,
        close: closeMarket,
        indexUrl: marketIndexUrl,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindMarketEvents);
    } else {
        bindMarketEvents();
    }
})();
