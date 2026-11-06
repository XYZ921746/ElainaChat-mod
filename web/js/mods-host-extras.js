/* 插件系统 —— 非 core 的 host API 能力组：openFolder / dragSort / theme / achievements，依赖由 mods.js 的 getHostExtras() 注入。 */
(function () {
    'use strict';

    window.ElainaModsHostExtras = function (deps) {
        const { bindFlatDragSort, host, addContribution } = deps || {};

    function openFolderHostApi({ manifest }) {
        return {
            async openFolder(sub) {
                // 目录名不一定等于 manifest.id（A9）：服务端只认目录名，按 id 拼的路径不存在 ——
                //   先试目录名再试身份，两个都失败才报错。modDir 会做 URL 编码，而目录要当查询参数，故取原始目录名
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

    /* 给一组 `.mod-card` 元素绑定拖拽排序（与插件页同一套手感）：指针捕获、FLIP 动画、占位块、
     * Esc 取消、触屏这些细节由宿主实现（各写一份必然分叉）；只改**显示顺序**，持久化交给调用方。 */
    function dragSortHostApi() {
        return {
            dragSort(container, onDone) {
                return bindFlatDragSort(container, onDone);
            },
        };
    }

    /* `host.theme({ id, name, dots, vars })` —— 把一套配色注册进「设置 → 外观」的主题选择器，用 vars（CSS 变量表）落成样式。
     * 启用时注册、停用/卸载时**自动摘除**（走与插槽同一套贡献回收）；只给"浅色"var，深色由宿主的深色块统一覆盖。 */
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

    /* `host.unlock(id, detail)` —— 解锁一条**宿主已定义**的成就（面板、持久化、判定都在宿主），
     * 插件只负责在合适的时机上报；id 不在宿主清单里时返回 false。 */
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

    /* `host.desktopWindow` —— 桌面壳（WebView2 宿主）的原生置顶窗。壳只提供通用协议
     * （开/关一个 id 标识的透明置顶窗，url/尺寸由插件给，壳不认识任何插件），页面之间的
     * 数据同步由插件自己用 BroadcastChannel 做（同壳同 WebView2 用户目录，天然同源）。
     * 纯浏览器环境 available() 为 false：调用方必须自带兜底（如桌宠的 Document PiP）。 */
    function desktopWindowHostApi() {
        const bridge = () => {
            try { return host().shellBridge; } catch (e) { return null; }
        };
        return {
            desktopWindow: {
                /** 当前页面是否跑在桌面壳里。false 时 open/close 都是空操作并返回 false。 */
                available() {
                    return Boolean(bridge());
                },
                /** 开（或替换）一个透明置顶窗：{id, url, width, height}。id 相同则旧窗先静默关掉。
                 * url 必须是本机服务地址，壳会拒绝其它来源（窗口要与主页面同源才能互通）。 */
                open(spec) {
                    const b = bridge();
                    const s = spec || {};
                    if (!b || !s.id || !s.url) return false;
                    return b.post({
                        type: 'mod-window-open',
                        id: String(s.id),
                        url: String(s.url),
                        width: Number(s.width) || 300,
                        height: Number(s.height) || 400,
                    });
                },
                /** 关掉自己开的窗（id 不存在时壳侧忽略）。 */
                close(id) {
                    const b = bridge();
                    if (!b || !id) return false;
                    return b.post({ type: 'mod-window-close', id: String(id) });
                },
                /** 把主窗口带到前台（置顶窗被其它应用挡住主窗时用）。 */
                focusMain() {
                    const b = bridge();
                    if (!b) return false;
                    return b.post({ type: 'mod-window-focus-main' });
                },
                /** 订阅「窗被用户/系统关闭」事件：cb(id)。返回退订函数。 */
                onClosed(cb) {
                    const b = bridge();
                    if (!b || typeof b.onMessage !== 'function') return () => {};
                    return b.onMessage((data) => {
                        try {
                            if (data && data.type === 'mod-window-closed' && data.id) cb(String(data.id));
                        } catch (e) { /* 单个回调出错不影响其它订阅者 */ }
                    });
                },
            },
        };
    }

    /* `host.appUi.openAppSettings()` —— 打开宿主「设置」面板：插件自己的弹出菜单/浮层要给用户
     * 一个到设置的入口（如桌宠透明窗的菜单），自己摸设置页的全局函数会绕开它的开合状态机。 */
    function appUiHostApi() {
        return {
            appUi: {
                /** 打开宿主设置面板。返回 false = 宿主没有该能力（旧版宿主）。 */
                openAppSettings() {
                    const f = host().openAppSettings;
                    try {
                        if (typeof f === 'function') { f(); return true; }
                    } catch (e) { /* 忽略 */ }
                    return false;
                },
            },
        };
    }

        return { openFolderHostApi, dragSortHostApi, themeHostApi, achievementsHostApi, desktopWindowHostApi, appUiHostApi };
    };
})();
