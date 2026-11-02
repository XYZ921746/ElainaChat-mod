/* ============================================================================
 * 插件市场纯函数（从 mod-market.js 拆分）
 *
 * 转义 / 大小格式化 / 包名 / 状态 / 前置分组 / 搜索匹配 / 安装顺序。
 * 不依赖市场闭包与 DOM，供 mod-market.js 调用。
 * ========================================================================== */
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


    function matchesQuery(p, q) {
        if (!q) return true;
        var hay = [p.id, p.name, p.description]
            .concat(Array.isArray(p.depends) ? p.depends : [])
            .join(' ').toLowerCase();
        return hay.indexOf(q) >= 0;
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


