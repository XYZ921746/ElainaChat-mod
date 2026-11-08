/* 插件市场纯函数：转义 / 大小格式化 / 包名 / 状态 / 前置分组 / 搜索匹配 / 安装顺序，不依赖市场闭包与 DOM。 */
'use strict';

    function esc(t) {
        return (typeof escapeHtml === 'function') ? escapeHtml(t == null ? '' : t) : String(t == null ? '' : t);
    }

    /** 卡片描述等单行文案：轻量 Markdown 渲染（加粗、行内代码），星号记号不裸奔 */
    function md(t) {
        const s = String(t == null ? '' : t);
        return (window.ElainaReadme && window.ElainaReadme.inline) ? window.ElainaReadme.inline(s) : esc(s);
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


    /** 卡片状态：未安装 / 已安装 / 可更新 */
    function statusOf(p, installed) {
        var cur = installed.get(p.id);
        if (!cur) return 'absent';
        var mine = String(cur.version || ''), theirs = String(p.version || '');
        if (mine && theirs && mine !== theirs) return 'update';
        return 'installed';
    }


    /** 已装插件与商店索引逐条比对：版本号两边都有且不同才算可更新（与卡片 statusOf 同一条判定，任一边缺版本号就不敢动）。 */
    function updateCandidatesOf(installedList, indexPlugins) {
        var installed = new Map();
        var mine = Array.isArray(installedList) ? installedList : [];
        for (var i = 0; i < mine.length; i++) {
            if (mine[i] && mine[i].id) installed.set(mine[i].id, mine[i]);
        }
        var out = [];
        var idx = Array.isArray(indexPlugins) ? indexPlugins : [];
        for (var j = 0; j < idx.length; j++) {
            var p = idx[j];
            if (!p || !p.id || !installed.has(p.id)) continue;
            var cur = String(installed.get(p.id).version || '');
            var next = String(p.version || '');
            if (cur && next && cur !== next) out.push({ plugin: p, current: cur });
        }
        return out;
    }


    /** 批量更新按依赖先行排序：X 依赖 Y 且同批都更时 Y 先装，重扫时才不会拿新 X 配旧依赖。 */
    function sortUpdateFirstDeps(items) {
        var list = Array.isArray(items) ? items.slice() : [];
        var byId = new Map();
        for (var i = 0; i < list.length; i++) byId.set(list[i].plugin.id, list[i]);
        var out = [];
        var done = new Set();
        var guard = list.length + 1;   // 依赖成环时靠它退出，环里的按原序补在尾部
        while (out.length < list.length && guard-- > 0) {
            var progressed = false;
            for (var j = 0; j < list.length; j++) {
                var it = list[j];
                if (done.has(it.plugin.id)) continue;
                var deps = Array.isArray(it.plugin.depends) ? it.plugin.depends : [];
                var ready = deps.every(function (d) { return !byId.has(d) || done.has(d); });
                if (ready) { out.push(it); done.add(it.plugin.id); progressed = true; }
            }
            if (!progressed) break;
        }
        for (var k = 0; k < list.length; k++) {
            if (!done.has(list[k].plugin.id)) out.push(list[k]);
        }
        return out;
    }


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

    /** 分成「普通扩展」与「前置扩展」两组，顺序保持索引原序：前置默认收起但一直列着 —— 用户要单独装、要确认装没装都得找得到。 */
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


    function matchesQuery(p, q) {
        if (!q) return true;
        var hay = [p.id, p.name, p.description]
            .concat(Array.isArray(p.depends) ? p.depends : [])
            .join(' ').toLowerCase();
        return hay.indexOf(q) >= 0;
    }


    /** 平台分类：mobile / desktop / universal。缺省与非法值都按 universal（通用）处理：第三方商店源不写这字段时，全部插件照常出现在所有分类里。 */
    function platformOf(p) {
        var v = String(p && p.platform || '').toLowerCase();
        return (v === 'mobile' || v === 'desktop') ? v : 'universal';
    }

    /** 平台筛选：all = 全部（手机设备上除外 —— 电脑插件默认不进手机列表，点「电脑」分类才看得到）。
        手机 / 电脑分类各自带上通用插件：通用本来就两边可用，单列一个分类只会逼用户先猜该点哪个。 */
    function matchesPlatform(p, sel, isMobileDevice) {
        var plat = platformOf(p);
        if (sel === 'all') return !(isMobileDevice && plat === 'desktop');
        return plat === sel || plat === 'universal';
    }


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
                // 索引里没有这个依赖就装不了，但别因此把主插件也拦住：把名字带出去由调用方提示。
                missingBehind.push(d);
                continue;
            }
            out = out.concat(resolveInstallOrder(dep, byId, installed, visiting));
        }
        // 已装的依赖不重复下载（用户可能已经装过了）
        if (!installed.has(p1.id)) out.push({ plugin: p1, missingBehind: missingBehind });
        return out;
    }


