/* ============================================================================
 * 插件系统 —— 非 core 的 host API 能力组
 *
 * 只放"按能力组下发"的可选成员：openFolder / dragSort / theme / achievements。
 * 依赖由 mods.js 的 getHostExtras() 注入，保持单文件加载语义不变。
 * ========================================================================== */
(function () {
    'use strict';

    window.ElainaModsHostExtras = function (deps) {
        const { bindFlatDragSort, host, addContribution } = deps || {};

    function openFolderHostApi({ manifest }) {
        return {
            async openFolder(sub) {
                // 目录名不一定等于 manifest.id（A9）：安装目录被改过名时服务端只认
                //   目录名，按 id 拼出来的路径不存在 —— 先试目录名，再试身份。
                //   两个都失败才报错；报错里带上服务端的长文案（含"它的目录叫什么"）。
                // modDir 会做 URL 编码，而目录要当**查询参数**（服务端再解一次），
                //   所以这里取未编码的原始目录名。
                const rawDir = manifest && typeof manifest.dir === 'string' ? manifest.dir.trim() : '';
                const names = [rawDir, manifest.id]
                    .filter((v, i, a) => v && a.indexOf(v) === i);
                const url = (which) => {
                    const q = new URLSearchParams({ id: which });
                    if (sub) q.set('sub', String(sub));
                    return '/api/plugins/open-folder?' + q.toString();
                };
                let message = '';
                for (const which of (names.length ? names : [manifest.id])) {
                    try {
                        const res = await fetch(url(which), { method: 'POST' });
                        const data = await res.json().catch(() => null);
                        if (res.ok && data && data.ok) return { ok: true, path: data.path };
                        message = (data && data.message) || ('HTTP ' + res.status);
                        // 只对"目录不存在"换下一个名字；其它失败（越界 / 非法 / 403 / 500）重试无意义
                        const retryable = /目录不存在|目录名|Not found|HTTP 404/.test(message) || res.status === 404;
                        if (!retryable) break;
                    } catch (e) {
                        message = String((e && e.message) || e);
                    }
                }
                return { ok: false, message };
            },
        };
    }

    /**
     * 给一组 `.mod-card` 元素绑定拖拽排序（与插件页同一套手感）。
     *
     *   const stop = host.dragSort(container, (ids) => save(ids));
     *
     * 由宿主实现：指针捕获、FLIP 动画、占位块、Esc 取消、触屏这些细节各写一份必然分叉，
     *   而"某个列表拖起来手感不一样"是最难解释的那类不一致。
     * 只改**显示顺序**：宿主不解释 id 语义、不碰加载顺序；持久化交给调用方在自己的 onDone 里。
     */
    function dragSortHostApi() {
        return {
            dragSort(container, onDone) {
                return bindFlatDragSort(container, onDone);
            },
        };
    }

    /**
     * `host.theme({ id, name, dots, vars })` —— 把一套配色注册进
     * 「设置 → 外观」的主题选择器，用 vars（CSS 变量表）落成样式。
     *
     *   host.theme({
     *     id: 'stardust', name: '星屑之日',
     *     dots: ['#ded8e8', '#b8934a', '#fbf7ef'],
     *     vars: { '--pixso-canvas': '#ded8e8', '--pixso-green': '#6d6aa8', … },
     *   });
     *
     * 启用时注册、停用/卸载时**自动摘除**（走与插槽同一套贡献回收）；用户正停在它上面时回落默认主题。
     * 只给"浅色"var：深色由宿主的深色块统一覆盖（见 theme.js 的说明）。
     * @returns {{ok:boolean, id:string}}
     */
    function themeHostApi({ manifest, log }) {
        return {
            theme(spec) {
                const t = { ...(spec || {}) };
                if (!t.id) { log('warn', 'host.theme 需要 id'); return { ok: false, id: '' }; }
                const apply = () => {
                    const th = host().theme;
                    try {
                        if (th && typeof th.registerTemplate === 'function') return th.registerTemplate(t) !== false;
                    } catch (e) { /* 忽略 */ }
                    return false;
                };
                const undo = () => {
                    const th = host().theme;
                    try {
                        if (th && typeof th.unregisterTemplate === 'function') th.unregisterTemplate(t.id);
                    } catch (e) { /* 忽略 */ }
                };
                addContribution(manifest.id, { activate: apply, deactivate: undo, dispose: undo });
                return {
                    ok: true,
                    id: String(t.id),
                    /** 临时切到这套主题（记住切换前的那套，供 restore() 还原） */
                    use() {
                        try { return host().theme?.useTemplate?.(t.id) ?? null; } catch (e) { return null; }
                    },
                    /** 还原到 use() 之前用户用的那套主题 */
                    restore() {
                        try { return host().theme?.restoreTemplate?.() ?? null; } catch (e) { return null; }
                    },
                };
            },
        };
    }

    /**
     * `host.unlock(id, detail)` —— 解锁一条**宿主已定义**的成就。
     *
     * 成就是宿主的功能（面板、持久化、判定都在宿主），插件只负责"在合适的时机上报"：
     *   例如生日插件在用户选完开场分支时上报 `stardust_remembered`。
     *
     * @returns {boolean} 是否成功（id 不在宿主清单里返回 false）
     */
    function achievementsHostApi() {
        return {
            unlock(id, detail) {
                const ac = host().achievements;
                try {
                    return Boolean(ac && typeof ac.unlock === 'function' && ac.unlock(id, detail));
                } catch (e) { return false; }
            },
        };
    }


        return { openFolderHostApi, dragSortHostApi, themeHostApi, achievementsHostApi };
    };
})();
