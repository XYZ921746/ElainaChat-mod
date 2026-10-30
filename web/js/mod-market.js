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
 * "插件设置独立成窗"是同一条取舍（见 settings.js 与 host-slots.js 的注释）。
 *
 * 市场列表把**前置扩展**（立绘、场景图、引擎包）归到列表末尾一个可折叠的区里：
 * 默认收起（打开市场先看到"点开就能用的界面"），点标题展开即可单独安装；
 * 收起只是视觉折叠，条目仍在 `lastIndex.plugins` 里，搜到谁都会展开显示。
 *
 * ── 数据源 ────────────────────────────────────────────────────────────
 *
 * web 仓库（XYZ921746/web）Pages 上的 `store/index.json`：
 *   { baseUrl, plugins: [ { id, name, version, kind, description, depends,
 *                          sizeBytes, downloadUrl } ] }
 * 包地址就是 baseUrl 下的 `<id>-<version>.zip`。Pages 返回
 * `Access-Control-Allow-Origin: *`，所以前端可以直接 fetch。
 * 索引地址可用设置里的「商店源」覆盖（Store 键 elaina_market_url）。
 *
 * ── 安装走的是**原有协议**，两端通用 ──────────────────────────────────
 *
 * 「上传安装」那条路：POST /api/plugins/install?name=<zip名>，请求体就是
 * zip 的原始字节（见 init.js）。这里只是把"用户在文件选择器里选的
 * 文件"换成"从商店下载到的 Blob"，其余**一个字都不用改**。
 * 安卓侧更省事：core.js 改写过 window.fetch，会把这个请求拦到
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

    /** 卡片描述等单行文案：轻量 Markdown 渲染（加粗、行内代码），星号记号不裸奔 */
    function md(t) {
        const s = String(t == null ? '' : t);
        return (window.ElainaReadme && window.ElainaReadme.inline) ? window.ElainaReadme.inline(s) : esc(s);
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

    /** 内置镜像源：GitHub Pages 在大陆常被墙，jsDelivr 系可达性好得多。
     *  cdn.jsdelivr.net 在部分网络对整站连接重置（索引也取不到），所以把包镜像
     *  那两个确定能落到包的域名（gcore / testingcf）也登记进索引候选 ——
     *  索引与包的镜像清单不一致时，"包能下、市场却整个打不开"照样发生。 */
    var MIRROR_INDEX_URLS = [
        'https://cdn.jsdelivr.net/gh/XYZ921746/web@main/store/index.json',
        'https://gcore.jsdelivr.net/gh/XYZ921746/web@main/store/index.json',
        'https://testingcf.jsdelivr.net/gh/XYZ921746/web@main/store/index.json',
    ];
    /**
     * 包下载镜像：把 GitHub Pages 的包地址映射到 jsDelivr 上。
     *
     * 为什么需要：索引里的 downloadUrl 写死是 Pages 地址，而 Pages 在大陆**整条链路
     *   时通时不通**（实测：同一天里单连接从 0.09 MB/s 掉到 20s 全超时，此时 jsDelivr
     *   的 gcore 镜像还有 0.45 MB/s）。分片并发解决的是"单流被限速"，解决不了
     *   "这条链路根本连不上" —— 两者必须都有。
     *
     * 注意 cdn.jsdelivr.net 实测对**包文件**连不上（索引能取、包不能），所以镜像
     * 只登记确定能取到包的域名，且失败要能安静跳过。
     */
    var MIRROR_PACKAGE_BASES = [
        'https://gcore.jsdelivr.net/gh/XYZ921746/web@main',
        'https://testingcf.jsdelivr.net/gh/XYZ921746/web@main',
    ];

    /**
     * 上一次哪个源是通的（模块级记忆，不落盘）。
     *
     * 为什么要记忆：链路状态在一次会话里很稳定 —— 要么 Pages 通、要么只有镜像通。
     *   每次下载都从 Pages 开始试的话，Pages 不通时**每个包**都要先白等一次超时
     *   （装一个带依赖的插件要等 N 次）。记住上次成功的那个，下次直接从它开始。
     *   只活在内存里：刷新页面就重新学习，不需要也不应该持久化。
     */
    var lastGoodBase = '';

    /**
     * 给一个包地址算镜像候选。
     *
     * 顺序：上次成功的源排第一 → 原地址 → 其余镜像，全部去重。
     *   只认「本站官方索引那两个源下的 store/packages/」—— 用户自建的商店源有
     *   自己的托管方式，猜不出镜像路径，硬套只会制造 404（那时只返回原地址）。
     */
    function packageMirrorUrls(url) {
        var s = String(url || '');
        var m = /^https:\/\/(?:xyz921746\.github\.io\/web|cdn\.jsdelivr\.net\/gh\/XYZ921746\/web@main)\/store\/packages\/([^/?#]+\.zip)(?:\?[^#]*)?$/i.exec(s);
        if (!m) return [url];
        var file = m[1];
        var bases = ['https://xyz921746.github.io/web'].concat(MIRROR_PACKAGE_BASES);
        var out = [];
        var push = function (u) { if (u && out.indexOf(u) < 0) out.push(u); };
        if (lastGoodBase) push(lastGoodBase + '/store/packages/' + file);   // 上次通的排第一
        push(s);                                                            // 原地址
        for (var i = 0; i < bases.length; i++) push(bases[i] + '/store/packages/' + file);
        return out;
    }

    /** 这个地址属于哪个源（用于记录 lastGoodBase） */
    function baseOfPackageUrl(u) {
        var m = /^(https:\/\/(?:xyz921746\.github\.io\/web|[a-z0-9-]+\.jsdelivr\.net\/gh\/XYZ921746\/web@main))\/store\/packages\//i.exec(String(u || ''));
        return m ? m[1] : '';
    }

    /**
     * 商店源候选（按顺序尝试）：自定义源 → Pages → jsDelivr 系镜像（见 MIRROR_INDEX_URLS）。
     *
     * 与公告源（data.js 的 announceSourceUrls）是同一条可达性
     *   思路：只给单点 URL 的话，源够不到的用户"整个市场都用不了"—— 多给一条镜像，
     *   大陆环境下能救回一大片。全失败才报错。
     */
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

    /**
     * 拉索引：多源逐个试，全失败抛最后一个异常，由调用方决定怎么显示（不吞错）。
     *
     * 缓存策略用 `no-cache` 而不是 `no-store`：前者是"可以存、但每次回源验证"
     *   （ETag/304，几十字节），后者连存都不让，每次开市场都必须整份重下。
     *   6 KB 的索引重建一次往返不贵，但它是**每次安装前都会走一遍**的请求
     *   （installFromMarket 里装完还要再拉一次），能省就省。
     */
    async function fetchMarketIndex() {
        var lastErr = null;
        var urls = marketIndexUrls();
        for (var i = 0; i < urls.length; i++) {
            try {
                var res = await fetch(urls[i], { cache: 'no-cache' });
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
                    // 默认关闭（与 mods.js 的 isModEnabled 同语义）：显式 true 才算默认开
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
                  + '<div class="text-[11px] text-indigo-400 leading-relaxed mt-0.5">' + md(p.description) + '</div>'
                  + depLine
                + '</div>'
                + '<div class="flex-none pt-0.5">' + btn + '</div>'
              + '</div>'
              + (size ? '<div class="text-[10px] text-indigo-300 mt-1">包大小 ' + size + '</div>' : '')
            + '</div>'
          + '</div>';
    }

    /**
     * 一条市场条目是不是"只给别人当底座用"的前置。
     *
     * 判定顺序（前者优先）：
     *   ① 商店索引显式声明 `prerequisite` —— `true` 归入前置区、`false` 强制进普通列表。
     *      这是**市场端唯一有決定权的地方**：商店比客户端更清楚某个包到底是素材底座
     *      还是带独立界面的工具（`live2d-models` 就同时是"引擎"和"模型管理界面"，
     *      只有维护索引的人知道它该进哪个区）。
     *   ② `hidden === true` —— 兼容把插件 `manifest.hidden` 原样带进索引的商店源；
     *      只认 `true`，`false`/缺省不算"显式要求进普通列表"，否则索引里每一条都写 `hidden:false`
     *      就会把下面的兜底规则一起废掉。
     *   ③ 兜底推断（索引还是旧格式、没有声明时）：`kind === 'resource'`，或
     *      "自己不依赖任何东西、却被同一份索引里别的条目 depends 指向"。
     *
     * 为什么兜底要看"只被指、不指人"：galgame 依赖 elaina-avatar + scene-backgrounds，
     *   但它自己也能被单独开起来 —— 市场里必须留着，用户要装的就是它。
     *   只有"只被指、不指人"的才是纯底座。
     *
     * @param {object} p 市场条目
     * @param {Array<object>} all 同一份索引里的全部条目（推断依赖关系要用）
     */
    function isPrerequisiteOnly(p, all) {
        if (!p) return false;
        if (p.prerequisite === true) return true;         // 商店声明：进前置区
        if (p.prerequisite === false) return false;       // 商店声明：强制进普通列表（覆盖 kind 推断）
        if (p.hidden === true) return true;               // 兼容 manifest.hidden 透传
        if (p.kind === 'resource') return true;
        if (!p.id) return false;
        var own = Array.isArray(p.depends) ? p.depends : [];
        if (own.length) return false;                     // 自己要别人才完整 → 它是一个功能，不是底座
        return (all || []).some(function (o) {
            return o && o.id !== p.id && Array.isArray(o.depends) && o.depends.indexOf(p.id) >= 0;
        });
    }

    /**
     * 把市场条目分成「普通扩展」与「前置扩展」两组，顺序保持索引原序。
     *
     * 前置默认收起、但**一直在**：它们是功能的一部分（立绘、场景图、引擎），
     * 用户想单独装、想确认装没装，都得能找到；从列表里删掉等于让
     * "插件页有、市场里搜不到"，反而更难解释。所以两者都列，前置落在自己的区里。
     */
    function splitMarketPlugins(all) {
        var list = Array.isArray(all) ? all : [];
        var normal = [];
        var prereq = [];
        for (var i = 0; i < list.length; i++) {
            if (isPrerequisiteOnly(list[i], list)) prereq.push(list[i]);
            else normal.push(list[i]);
        }
        return { normal: normal, prereq: prereq };
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

    /**
     * 前置扩展区的展开态（默认收起）。
     *
     * 只存内存：市场每次打开都该是"普通扩展一眼看完"的样子；但同一次打开里
     * 用户点了展开、又敲了搜索词时，不该被重新收起（渲染会整段重建）。
     */
    var marketPrereqOpen = false;

    /** 分区标题（前置扩展区）—— 点标题展开/收起，默认收起 */
    function marketSectionHead(count, note) {
        var caret = marketPrereqOpen ? '▾' : '▸';
        return '<button type="button" id="marketPrereqToggle" class="w-full flex items-baseline gap-2 pt-2 text-left"'
            + ' aria-expanded="' + (marketPrereqOpen ? 'true' : 'false') + '"'
            + ' title="前置扩展默认收起；点一下展开">'
            + '<span class="text-[11px] font-semibold text-indigo-500">前置扩展</span>'
            + '<span class="text-[10px] text-indigo-300">' + count + ' 个 · ' + esc(note) + '</span>'
            + '<span class="ml-auto text-[10px] text-indigo-400" data-prereq-caret>' + caret + '</span>'
            + '</button>';
    }

    /** 绑定展开/收起：只切 DOM 的 hidden，不重渲染（重渲染会丢掉动画与焦点） */
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

    /** 只负责渲染（用内存里的索引与已装快照）—— 搜索框每敲一下就调这里，不打网络 */
    function renderMarketList() {
        var box = $('marketList');
        if (!box || !lastIndex) return;
        var installed = lastInstalled || new Map();
        var all = Array.isArray(lastIndex.plugins) ? lastIndex.plugins : [];
        var groups = splitMarketPlugins(all);
        var q = marketQuery();
        var normal = groups.normal.filter(function (p) { return matchesQuery(p, q); });
        var prereq = groups.prereq.filter(function (p) { return matchesQuery(p, q); });
        var hit = normal.length + prereq.length;

        if (!hit) {
            box.innerHTML = '<div class="text-[11px] text-indigo-400">没有匹配「' + esc(q) + '」的扩展包。</div>';
            setHint('共 ' + all.length + ' 个扩展包，当前筛选出 0 个。换个词试试，或清空搜索框。', 'text-indigo-400');
            return;
        }
        box.innerHTML = normal.map(function (p) { return marketCard(p, installed); }).join('')
            + (prereq.length
                ? marketSectionHead(prereq.length, '被界面类扩展包按依赖自动带入，不用单独安装')
                    + '<div id="marketPrereqBody" class="space-y-2' + (marketPrereqOpen ? '' : ' hidden') + '">'
                    + prereq.map(function (p) { return marketCard(p, installed); }).join('')
                    + '</div>'
                : '');
        bindPrereqToggle(box);
        setHint('共 ' + all.length + ' 个扩展包'
            + (q ? '，筛选出 ' + hit + ' 个' : '')
            + (!q && prereq.length ? '（其中 ' + prereq.length + ' 个是前置扩展）' : '')
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

    /** 单个 Range 请求失败后的重试次数（链路抖动是常态，一次失败不代表这个包下不了） */
    var SEGMENT_RETRIES = 3;
    /** 单片最小字节数：片数按体积算，但不让一个 1MB 的包被拆成几十个请求 */
    var MIN_SEGMENT_BYTES = 512 * 1024;
    /** 片数上限。每片一条独立 TCP 连接，太多会被对端限流，也白占移动端带宽 */
    var MAX_SEGMENTS = 16;

    /**
     * 一个文件该拆几片。
     *
     * 为什么要拆：GitHub Pages 对**单条 TCP 流**限速到 ~0.1 MB/s（本机实测：10 MB 的
     *   立绘包单连接 115 s，32 并发 3.6 s,速率几乎随并发数线性增长）。浏览器自带的
     *   下载器默认多连接，所以"官网下得飞快、应用里慢成蜗牛"不是应用写错了，
     *   而是这里只开了**一条**流 —— 一个 7~10 MB 的素材包在这种链路上要等几分钟，
     *   还经常中途卡死。
     *
     * 为什么手机端少开：移动网络的并发收益远小于电脑，而每条连接都要占带宽与内存；
     *   按**能力**判断（IS_MOBILE_DEVICE），与 core.js 判断设备形态用的是同一个值，
     *   不另写一套 UA 嗅探。
     */
    function segmentCountFor(sizeBytes) {
        if (!sizeBytes || sizeBytes <= 0) return 1;
        var bySize = Math.ceil(sizeBytes / MIN_SEGMENT_BYTES);
        var cap = (typeof IS_MOBILE_DEVICE !== 'undefined' && IS_MOBILE_DEVICE) ? 6 : MAX_SEGMENTS;
        return Math.max(1, Math.min(cap, bySize));
    }

    /** 读一段 Range 响应体；进度由调用方按"已收字节"累积 */
    async function readStream(res, onBytes) {
        if (!res.body || typeof res.body.getReader !== 'function') {
            var buf = await res.arrayBuffer();
            onBytes(buf.byteLength);
            return buf;
        }
        var reader = res.body.getReader();
        var chunks = [];
        for (;;) {
            var step = await reader.read();
            if (step.done) break;
            chunks.push(step.value);
            onBytes(step.value.length);
        }
        return new Blob(chunks);
    }

    /**
     * 分片并发下载一个 zip，全部成功才返回（任何一片最终失败都让整次下载失败）。
     *
     * 进度按**总已收字节**汇报，与分片完成顺序无关 —— 否则进度条会来回跳。
     *
     * @param {string} url
     * @param {number} total 文件总字节数（必须已知，分片边界靠它算）
     * @param {function} onProgress
     */
    async function downloadZipSegmented(url, total, onProgress, signal) {
        var n = segmentCountFor(total);
        var size = Math.ceil(total / n);
        var parts = new Array(n);
        var got = 0;
        var bump = function (bytes) {
            got += bytes;
            if (onProgress) onProgress(Math.min(got, total), total);
        };

        var fetchSegment = async function (i) {
            var start = i * size;
            var end = Math.min(total - 1, start + size - 1);
            var want = end - start + 1;
            var lastErr = null;
            for (var attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
                if (signal && signal.aborted) throw new Error('已停止');   // 停止后重试没有意义
                // 上一次尝试已经吐出的字节要退回去（重试会重读同一段），
                //   否则重试几次后进度会超过 100%
                var before = 0;
                var wd = idleWatch(signal);
                try {
                    wd.kick();
                    var res = await fetch(url, {
                        cache: 'no-store',
                        headers: { Range: 'bytes=' + start + '-' + end },
                        signal: wd.signal,
                    });
                    if (res.status !== 206) {
                        // 200 = 服务端忽略了 Range，把整个文件当这一片发了回来。
                        //   不能当分片用（拼接会重复），直接放弃分片方案回退单流。
                        throw new Error('服务端不支持分片下载（HTTP ' + res.status + '）');
                    }
                    var blob = await readStream(res, function (b) { before += b; bump(b); wd.kick(); });
                    if (blob.size === want) { parts[i] = blob; return; }
                    bump(-before);
                    throw new Error('分片长度不符（期望 ' + want + '，实收 ' + blob.size + '）');
                } catch (e) {
                    bump(-before);   // before 为 0 时是无操作
                    lastErr = e;
                    // "不支持分片"是能力问题，重试也没用 → 立刻上抛给调用方回退单流。
                    //   其它错误（超时/断连/长度不符）才值得重试。
                    if (/不支持分片下载/.test(String(e && e.message))) throw e;
                } finally {
                    wd.done();
                }
            }
            throw lastErr || new Error('分片下载失败');
        };

        var tasks = [];
        for (var i = 0; i < n; i++) tasks.push(fetchSegment(i));
        await Promise.all(tasks);
        return new Blob(parts, { type: 'application/zip' });
    }

    /**
     * 浏览器端 zip 完整性快检：文件尾部 64KB 内找 EOCD 签名（PK\x05\x06）。
     *
     * 为什么在客户端查：分片路径的总长在 Pages 这类源上只能信索引的 sizeBytes，
     *   索引声明小了会拼出**尾部截断**的 zip —— 不查的话要等上传完、服务端解压
     *   才报"unexpected end of file"，用户看不出是下载坏了还是插件坏了。
     *   在这里当场发现就换下一个源（jsDelivr 系能读到真实 Content-Range）重下。
     */
    async function blobLooksCompleteZip(blob) {
        try {
            var tail = blob.slice(Math.max(0, blob.size - 65536));
            var buf = new Uint8Array(await tail.arrayBuffer());
            for (var i = buf.length - 22; i >= 0; i--) {   // EOCD 定长 22 字节起
                if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return true;
            }
            return false;
        } catch (e) { return true; }   // 检查本身失败不拦下载（交给服务端解压兜底）
    }

    /**
     * 下载一个 zip（多源回退）。
     *
     * 顺序由 packageMirrorUrls 决定（上次通的源 → 原地址 → 其余镜像）。
     *   并发解决"单流被限速"，多源解决"这条链路根本连不上" —— 两者互补，缺一不可：
     *   实测 Pages 会整条链路 20s 全超时，此时再多的并发也拿不到一个字节。
     *
     * sizeHint 是索引里声明的包体积（sizeBytes）：跨域读不到 Content-Range 的源
     *   （Pages）靠它才能启用分片，见 downloadZipFrom。
     *
     * signal 是用户「停止」的外部信号：已停止时不再尝试下一个源（否则每个源
     *   都要陪一次立刻失败的请求才轮到退出）。
     *
     * 每个源给一个**独立的快速失败预算**：源不通时我们希望尽快换下一个，而不是
     *   陪着它熬到默认超时（浏览器默认没有超时，一个死连接能挂几分钟）。用
     *   AbortController 给探测阶段加时限 —— 一旦探测成功（拿到 206 或 200），
     *   时限就撤掉，正常传输交给 idleWatch 的无进展超时保护。
     */
    async function downloadZip(url, sizeHint, onProgress, signal) {
        var urls = packageMirrorUrls(url);
        var lastErr = null;
        for (var i = 0; i < urls.length; i++) {
            if (signal && signal.aborted) throw new Error('已停止');
            try {
                var blob = await downloadZipFrom(urls[i], sizeHint, onProgress, signal);
                if (!(await blobLooksCompleteZip(blob))) {
                    // 截断的 zip 多半是这个源的总长取错了（见 blobLooksCompleteZip），
                    //   换下一个源整份重下，不把坏字节交给服务端
                    if (onProgress) onProgress(0, 0);
                    throw new Error('下载结果不完整（zip 尾部缺失），换源重试');
                }
                // 记住这个源：同一次会话里后面的包直接从它开始，不必每个都先等一次超时
                var b = baseOfPackageUrl(urls[i]);
                if (b) lastGoodBase = b;
                return blob;
            } catch (e) {
                lastErr = e;
                if (onProgress) onProgress(0, 0);   // 换源重来，进度归零
            }
        }
        throw lastErr || new Error('下载失败');
    }

    /** 探测阶段的时限（毫秒）：源连不上时尽快换下一个，别陪着死连接熬 */
    var PROBE_TIMEOUT_MS = 8000;

    /** 给 fetch 套一个只在"拿到响应头"之前生效的时限；external 供用户「停止」掐断 */
    async function fetchWithProbeTimeout(url, opts, external) {
        var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        var timer = null;
        var o = Object.assign({}, opts);
        if (ctrl) {
            o.signal = ctrl.signal;
            if (external) {
                var trip = function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } };
                if (external.aborted) trip();
                else external.addEventListener('abort', trip, { once: true });
            }
            timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, PROBE_TIMEOUT_MS);
        } else if (external) {
            o.signal = external;
        }
        try {
            return await fetch(url, o);
        } finally {
            if (timer) clearTimeout(timer);   // 响应头已到 → 时限作废，传输不再被掐
        }
    }

    /** 无进展超时（毫秒）：传输体这么久没收到任何新字节就中断这次 fetch */
    var IDLE_TIMEOUT_MS = 20000;

    /**
     * "收字节续命"的看门狗。
     *
     * 为什么需要：浏览器 fetch 默认没有超时，商店源链路会出现"连得上但整条卡死"
     *   （响应头已到、传输体一个字节都不再来）。探测时限只保到响应头，之后的
     *   单流/分片传输若不设看门狗，按钮会永远停在某个百分比，用户只能干等。
     *   用法：fetch 前调 kick() 起表，每收到一段数据 kick() 续命，读完 done() 撤表；
     *   超时触发 abort() 让进行中的 read() 以异常结束，交给调用方既有的重试/换源。
     *   external 是用户「停止」的外部信号，触发时同样掐断本次传输。
     *   AbortController 不可用的环境退化为无保护（与不接看门狗时一致）。
     */
    function idleWatch(external) {
        var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        var timer = null;
        if (ctrl && external) {
            var trip = function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } };
            if (external.aborted) trip();
            else external.addEventListener('abort', trip, { once: true });
        }
        return {
            signal: ctrl ? ctrl.signal : (external || undefined),
            kick: function () {
                if (!ctrl) return;
                if (timer) clearTimeout(timer);
                timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, IDLE_TIMEOUT_MS);
            },
            done: function () { if (timer) clearTimeout(timer); },
        };
    }

    /**
     * 从**单个**地址下载一个 zip。
     *
     * 优先**分片并发**（见 segmentCountFor）：单流在这条链路上被限速，7~10 MB 的
     *   素材包要等几分钟；多开几条连接能把它压到几秒。
     *
     * 为什么先发一个 1 字节的 Range 请求而不是 HEAD：要同时确认三件事 ——
     *   ① 文件多大（分片边界靠它算）；② 服务端真的回 206（只看 Accept-Ranges
     *   声明不够，有的源声明了却回 200）；③ 这一跳链路此时通不通。
     *
     * 总长有两个来源：Content-Range 响应头，或调用方传入的 sizeHint（索引里声明
     *   的 sizeBytes）。跨域响应里 Content-Range 默认读不到 —— 它不在 CORS 安全
     *   响应头里，Pages 也不发 Access-Control-Expose-Headers（jsDelivr 系发）。
     *   只依赖这个头的话，分片在默认源上永远不会启动。分片边界自己算、长度自己
     *   校验（blob.size === want），sizeHint 不准时会明确失败并退回单流。
     *
     * 任何一步不成立（拿不到长度 / 非 206 / 体积太小）都**原样退回单流** ——
     *   对不支持的源是零风险，行为与不启用分片时一致。
     *
     * 为什么自己读流而不是 await res.blob()：要给用户看到进度 —— 一声不吭地等十几秒，
     *   用户会以为卡死了。拿不到 Content-Length（或环境不支持流式读取）时就退化成
     *   整体读，此时进度只显示已下载字节数。
     */
    async function downloadZipFrom(url, sizeHint, onProgress, signal) {
        // ① 探测：1 字节 Range。206 + Content-Range 才说明分片可用
        var probe = null;
        var total = 0;
        try {
            probe = await fetchWithProbeTimeout(url, { cache: 'no-store', headers: { Range: 'bytes=0-0' } }, signal);
            if (probe.status === 206) {
                // Content-Range: bytes 0-0/<total>
                var m = /\/(\d+)\s*$/.exec(String(probe.headers.get('Content-Range') || ''));
                total = m ? Number(m[1]) : (sizeHint > 0 ? sizeHint : 0);
            } else if (probe.ok) {
                // 源不支持 Range（回了 200 整个文件）—— 这个响应体就是完整文件，
                //   直接当单流用掉，不再多发一次请求
                total = Number(probe.headers.get('Content-Length') || 0);
                var wd0 = idleWatch(signal);
                var got0 = 0;
                try {
                    wd0.kick();
                    var blob0 = await readStream(probe, function (b) {
                        wd0.kick();
                        got0 += b;
                        if (onProgress) onProgress(got0, total);
                    });
                    return new Blob([blob0], { type: 'application/zip' });
                } finally {
                    wd0.done();
                }
            }
        } catch (e) {
            if (signal && signal.aborted) throw new Error('已停止');   // 用户停止不算"探测失败"
            probe = null; /* 探测失败：走下面的单流，让它报真正的错 */
        }
        if (probe && probe.body && typeof probe.body.cancel === 'function') {
            try { await probe.body.cancel(); } catch (e) { /* 忽略 */ }
        }

        if (total > MIN_SEGMENT_BYTES && segmentCountFor(total) > 1) {
            if (signal && signal.aborted) throw new Error('已停止');
            try {
                return await downloadZipSegmented(url, total, onProgress, signal);
            } catch (e) {
                if (signal && signal.aborted) throw new Error('已停止');   // 停止不走回退，直接上抛
                // 分片走不通（源中途改口、或网络让所有分片都失败）→ 退回单流再试一次。
                //   不在这里吞错：单流也失败时抛出的是单流的错，那才是用户该看到的。
                if (onProgress) onProgress(0, 0);
            }
        }

        // ② 单流（原行为）：小包、不支持分片的源、或分片方案失败了
        if (signal && signal.aborted) throw new Error('已停止');
        var wd = idleWatch(signal);
        try {
            wd.kick();
            var res = await fetch(url, { cache: 'no-store', signal: wd.signal });
            if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
            var total2 = Number(res.headers.get('Content-Length') || 0) || total || (sizeHint > 0 ? sizeHint : 0);
            var got = 0;
            var blob = await readStream(res, function (b) {
                wd.kick();
                got += b;
                if (onProgress) onProgress(got, total2);
            });
            return new Blob([blob], { type: 'application/zip' });
        } finally {
            wd.done();
        }
    }

    /**
     * 把一个插件的依赖（含依赖的依赖）摊平成"先装依赖、后装本体"的安装顺序。
     *
     * 为什么要做这件事：依赖必须在**装本体之前**就位，否则本体装完直接拒绝加载
     *   （表现为"前置插件不可用"）。而用户看不出该装哪个 —— `elaina-avatar`
     *   这类资源包在列表里没有任何提示说"装 galgame 会用到它"。
     *   只提示"缺依赖、请先装上"等于把一步可自动完成的事推给用户。
     *
     * 顺序用**深度优先后序**：子依赖先入队，本体最后。这样安装包时它的依赖已经就位，
     *   装完 reload 一次就能直接生效，不会有"先失败再成功"的中间态。
     *
     * 已安装且版本不旧的依赖**不重复下载**（跳过），只装缺的那些。
     * 依赖环（a→b→a）用 visiting 集合挡住，不会死循环 —— 相互依赖本身就是坏数据，
     *   此时按"谁先遇到谁先装"处理，装完由 mods.js 的加载检查去报缺。
     *
     * @param {{id:string, depends?:string[]}} p1 目标插件
     * @param {Map<string,object>} byId 市场索引里全部插件（id → 条目）
     * @param {Map<string,object>} installed 本机已装（id → 条目）
     * @param {Set<string>} [visiting] 递归用的环检测集合
     * @returns {Array<{plugin:object, missingBehind:string[]}>} 安装顺序（依赖在前）
     */
    function resolveInstallOrder(p1, byId, installed, visiting) {
        visiting = visiting || new Set();
        var out = [];
        if (!p1 || visiting.has(p1.id)) return out;
        visiting.add(p1.id);
        var deps = Array.isArray(p1.depends) ? p1.depends : [];
        var missingBehind = [];
        for (var d of deps) {
            var dep = byId.get(d);
            if (!dep) {
                // 索引里没有这个依赖 —— 装不了，但别因此把主插件也拦住，
                //   把名字带出去由调用方提示"这个依赖在商店里找不到"。
                missingBehind.push(d);
                continue;
            }
            out = out.concat(resolveInstallOrder(dep, byId, installed, visiting));
        }
        // 已装的依赖不重复下载（用户可能已经装过了，或本来就是手动装的）
        if (!installed.has(p1.id)) out.push({ plugin: p1, missingBehind: missingBehind });
        // 本体即使已装也要带出去？不带 —— 调用方对"已装"本来就禁用按钮。
        return out;
    }

    /* ── 下载悬浮窗（全局右下角）──────────────────────────────────────────
     *
     * 为什么要有：进度原先只画在「用户点的那颗按钮」上 —— 依赖包在按钮上永远
     *   看不见，一次装多个时更是长时间无变化；换源/重试期间界面完全静止，
     *   用户只能干等。悬浮窗按「一次安装点击 = 一行任务」展示：阶段、百分比、
     *   字节数、失败原因；钉在**应用**右下角而非市场弹窗里 —— 关掉市场去聊天
     *   也看得见，行上还能「停止」（中止这次安装）与「卸载」（装完反悔）。
     *
     * 任务表只活在内存：页面刷新即清空 —— 下载本就不能跨刷新续传，
     *   把已死的任务留在窗上是骗人。
     */
    var dlTasks = new Map();      // id → task（Map 保持插入序，即展示序）
    var dlSeq = 0;
    var dlOpen = true;            // 折叠态只存内存：每次打开市场都该能一眼看到进度
    var dlRenderQueued = false;   // 合帧标记：进度回调每收一段数据就触发一次
    var dlDismissed = false;      // 点 ✕ 收起悬浮窗：只影响显示，下载照跑，新任务时自动回来

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

    /** 收束一个任务：phase ∈ done / error / stopped。行都**不自动消失** ——
     *  成功行上还有「卸载」这个事后动作，失败/停止行有原因要回看；
     *  想清屏用行上的 ✕、头部「清空」或整个悬浮窗的 ✕。 */
    function dlTaskDone(id, phase, note) {
        var t = dlTasks.get(id);
        if (!t) return;
        t.phase = phase;
        t.note = note || '';
        t.doneAt = Date.now();
        dlRender();
    }

    /** 清掉所有已结束（成功/失败/已停止）的行；进行中的不许动 */
    function dlDropFinished() {
        var n = 0;
        dlTasks.forEach(function (t) {
            if (t.phase === 'done' || t.phase === 'error' || t.phase === 'stopped') { dlTasks.delete(t.id); n++; }
        });
        if (n) dlRender();
    }

    /** 用户点「停止」：先置 stopped（catch 据此归类成「已停止」而非失败），再掐断在途请求 */
    function dlStop(id) {
        var t = dlTasks.get(id);
        if (!t || t.stopped) return;
        t.stopped = true;
        if (t.ctrl) { try { t.ctrl.abort(); } catch (e) { /* 忽略 */ } }
        dlTaskPatch(id, { note: '正在停止…' });
    }

    /** 用户点「继续」：接着上次的中断点把这次安装跑完。
     *  已装好的包不会重下（installFromMarket 重新解析依赖时按"已装"跳过）；
     *  停止时正在下的那一个包没有断点信息，会从头下载 —— HTTP 下载中途的字节
     *  不落盘，跨停止的断点续传要做缓存与校验，代价远超收益。 */
    function dlResume(id) {
        var t = dlTasks.get(id);
        if (!t || t.phase !== 'stopped' || !t.p) return;
        t.stopped = false;
        t.ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        dlTaskPatch(id, { phase: 'prep', note: '', got: 0, tot: 0 });
        void installFromMarket(t.p, null, id);
    }

    /** 从悬浮窗卸载这次装上的主插件：与插件栏删除同一条链（依赖方检查 + DELETE + forget）。
     *  只卸主插件、不动依赖 —— 依赖是共享底座，别的插件可能正指着它。 */
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

    /** 渲染合帧：直写 DOM 会在大包下载时被字节回调刷成幻灯片，也浪费 */
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
        if (t.phase === 'done') { barCls += 'bg-emerald-500'; barStyle = 'width:100%'; }
        else if (t.phase === 'error') { barCls += 'bg-red-400'; barStyle = 'width:100%'; }
        else if (t.phase === 'stopped') { barCls += 'bg-slate-400'; barStyle = 'width:100%'; }
        else if (t.phase === 'install') { barCls += 'bg-indigo-400 animate-pulse'; barStyle = 'width:100%'; }
        else if (t.phase === 'uninstall') { barCls += 'bg-amber-400 animate-pulse'; barStyle = 'width:100%'; }
        else if (pct >= 0) { barCls += 'bg-indigo-400'; barStyle = 'width:' + pct + '%'; }
        else { barCls += 'bg-indigo-300 animate-pulse'; barStyle = 'width:100%'; }   // 总长未知：跳动脉冲

        var note = String(t.note || '');
        if (t.phase === 'download') {
            note += (t.tot > 0)
                ? ' · ' + (fmtSize(t.got) || '0 KB') + ' / ' + fmtSize(t.tot)
                : ' · 已下 ' + (fmtSize(t.got) || '0 KB');
        }
        var noteCls = 'text-[10px] leading-relaxed mt-0.5 ' + (t.phase === 'error' ? 'text-red-500' : 'text-indigo-400');
        // 行内动作：进行中给「停止」；成功给「卸载 + ✕」；已停止给「继续 + ✕」；失败只给 ✕
        var act = '';
        if (t.phase === 'prep' || t.phase === 'download' || t.phase === 'install') {
            act = '<button type="button" data-dl-stop="' + t.id + '" class="flex-none rounded px-1 text-[10px] text-red-400 hover:text-red-600" title="停止这次安装（已装上的包会留下）">停止</button>';
        } else if (t.phase === 'done') {
            act = '<button type="button" data-dl-un="' + t.id + '" class="flex-none rounded px-1 text-[10px] text-indigo-400 hover:text-indigo-600" title="卸载这次装上的主插件（公共资源包保留）">卸载</button>'
                + '<button type="button" data-dl-x="' + t.id + '" class="flex-none rounded px-1 text-[10px] text-indigo-300 hover:text-indigo-600" title="从列表移掉这一行">✕</button>';
        } else if (t.phase === 'stopped') {
            act = '<button type="button" data-dl-go="' + t.id + '" class="flex-none rounded px-1 text-[10px] text-emerald-600 hover:text-emerald-700" title="接着装完（已装好的包不会重新下载）">继续</button>'
                + '<button type="button" data-dl-x="' + t.id + '" class="flex-none rounded px-1 text-[10px] text-indigo-300 hover:text-indigo-600" title="从列表移掉这一行">✕</button>';
        } else {
            act = '<button type="button" data-dl-x="' + t.id + '" class="flex-none rounded px-1 text-[10px] text-indigo-300 hover:text-indigo-600" title="从列表移掉这一行">✕</button>';
        }
        return '<div class="market-dl-row" data-dl-id="' + t.id + '">'
            + '<div class="flex items-baseline gap-2">'
              + '<span class="truncate text-[11px] font-semibold text-indigo-800">' + esc(t.title) + '</span>'
              + '<span class="flex-none text-[10px] text-indigo-400">' + esc(dlPhaseText(t)) + '</span>'
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

    /** 从市场安装一个插件（含其依赖）→ 下载 → 复用上传安装协议 → 刷新两栏。
     *  reuseDlId：从悬浮窗「继续」进来时复用原任务行，不再新开一行。 */
    async function installFromMarket(p, btn, reuseDlId) {
        var name = packageNameOf(p);
        var label = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = '准备中…'; }
        var dlId = reuseDlId || dlTaskNew(p.name || p.id, p.id, p);
        var tsk = dlTasks.get(dlId);
        try {
            if (!p.downloadUrl) throw new Error('索引里这条没有 downloadUrl');

            // 先把依赖算出来：缺的依赖要**一起装**，否则装完主体它照样拒绝加载。
            //   这里必须用**整份**索引（含被收起的前置），不能用列表里显示的那部分 ——
            //   收起只是不显示，依赖照样要装。
            var all = (lastIndex && Array.isArray(lastIndex.plugins)) ? lastIndex.plugins : [];
            var byId = new Map();
            for (var one of all) byId.set(one.id, one);
            var installed = await installedMap();
            var queue = resolveInstallOrder(p, byId, installed);
            if (!queue.some(function (q) { return q.plugin.id === p.id; })) {
                // 理论上不会发生（按钮对已装的是禁用的），兜一下
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
                        'text-amber-600');
                }

                var pkgName = packageNameOf(cur);
                setHint(prefix + '正在下载 ' + (cur.name || cur.id) + ' …', 'text-indigo-400');
                var pkgBytes = Number(cur.sizeBytes) || 0;
                dlTaskPatch(dlId, { phase: 'download', note: prefix + (cur.name || cur.id), got: 0, tot: pkgBytes });
                var blob = await downloadZip(cur.downloadUrl, pkgBytes, function (got, tot) {
                    // 按钮只画主插件的进度；悬浮窗每个包都画（依赖包在按钮上永远看不见）
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
                setHint(prefix + '正在安装 ' + (cur.name || cur.id) + ' …', 'text-indigo-400');

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

            // 装完必须**重新扫描加载**（ElainaMods.reload → mods.js 的 loadAll）。
            //   不重扫的症状是"下载成功、装上了，就是用不了"：
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
            var extra = done.length > 1
                ? '（含依赖 ' + done.slice(0, -1).join('、') + '）'
                : '';
            setHint((reloaded ? '✅ 已安装并已加载 ' : '✅ 已安装 ')
                + (p.name || p.id) + extra
                + (reloaded ? '，已生效。' : '，刷新页面后生效。'), 'text-emerald-600');
            dlTaskDone(dlId, 'done', (reloaded ? '已安装并已加载' : '已安装，刷新页面后生效') + extra);
            // 插件栏那份清单必须跟着刷新，否则用户切过去看不到刚装的插件
            if (typeof refreshModsList === 'function') void refreshModsList();
            await refreshMarketList();
        } catch (err) {
            // 用户主动停止 ≠ 失败：行收成「已停止」，按钮回原样，别标红吓人
            var stopped = !!(tsk && tsk.stopped);
            if (btn) { btn.disabled = false; btn.textContent = label; }
            dlTaskDone(dlId, stopped ? 'stopped' : 'error',
                stopped ? '已停止；点「继续」接着装，已装好的包不会重下' : String((err && err.message) || err));
            setHint(stopped
                ? '已停止安装 ' + (p.name || p.id) + '。已装上的包保留，想续装再点一次安装。'
                : '安装失败：' + String((err && err.message) || err),
                stopped ? 'text-amber-600' : 'text-red-500');
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
        dlDismissed = false;   // 悬浮窗是全局的：进市场 = 想管下载，收起态要解开
        dlRender();            // 下载中重开市场：任务行要立即反映当前进度
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
        // 逐个绑定会在每次刷新后失效（这一点与插件列表同一套路，见 settings.js）
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

        // 下载悬浮窗：停止/卸载/单行移除/清空/收起/折叠。事件委托 —— 行是整批
        //   innerHTML 重建的，逐个绑定会在每次进度刷新后失效（与 marketList 同套路）
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

        // 关闭：✕ / 点遮罩 / Esc —— 与其它弹窗（插件 README、插件设置）同一套习惯
        $('marketClose')?.addEventListener('click', closeMarket);
        var overlay = $('marketOverlay');
        if (overlay) {
            overlay.addEventListener('click', function (e) { if (e.target === overlay) closeMarket(); });
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeMarket();
            });
        }

        // 启动时**不**预拉：市场是"想装东西时才点开"的地方，启动就多打一次网络没意义。
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
