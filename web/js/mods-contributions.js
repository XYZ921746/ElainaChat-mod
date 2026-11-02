/* ============================================================================
 * 插件贡献与生命周期（从 mods.js 拆出）
 *
 * 每个 mod 的可撤销贡献：activate / deactivate / dispose；
 * 以及 host.signal 的 AbortController 生命周期。
 * ========================================================================== */
(function () {
    'use strict';

    window.ElainaModsContributions = function () {
    /** 每个 mod 的可撤销贡献：modId → Set<contribution> */
    const contributions = new Map();

    function contributionSet(modId) {
        if (!contributions.has(modId)) contributions.set(modId, new Set());
        return contributions.get(modId);
    }

    /**
     * 登记一项贡献并立即挂上。
     * @param {string} modId 归属的 mod（停用/卸载时按它整批回收）
     * @param {{activate?:Function, deactivate?:Function, dispose?:Function}} c
     */
    function addContribution(modId, c) {
        contributionSet(modId).add(c);
        try {
            if (typeof c.activate === 'function') c.activate();
        } catch (e) {
            // 挂载失败不该连累别的贡献，但必须报出来 —— 否则表现为"注册了没反应"
            console.error('[Mod:' + modId + '] 注册项挂载失败（已跳过这一项）', e);
        }
        return c;
    }

    /** 对某个 mod 的全部贡献依次执行某个动作（单项出错不影响其余） */
    function forEachContribution(modId, action) {
        const set = contributions.get(modId);
        if (!set) return;
        for (const c of [...set]) {
            try {
                if (typeof c[action] === 'function') c[action]();
            } catch (e) {
                console.error('[Mod:' + modId + '] ' + action + ' 失败（继续处理其余注册项）', e);
            }
        }
    }

    // ---- 生命周期信号（host.signal）：停用再启用**不能**发 abort（同一个 api 还要继续用，
    //      插件停了轮询就再没第二次机会恢复）；只有真正卸载/删除（dispose）才 abort ----
    const lifecycleCtl = new Map();
    /**
     * 造一个生命周期信号。
     *
     * 优先用 AbortController；环境里没有时给一个**形状相同**的最小实现 ——
     *   host.signal 是插件依赖的公开契约，不能因为"这个环境没 AbortController"
     *   就变成 undefined（插件会写 `host.signal.addEventListener(...)`）。
     */
    function makeLifecycle() {
        if (typeof AbortController === 'function') {
            const ctl = new AbortController();
            return { signal: ctl.signal, abort: () => { try { ctl.abort(); } catch (e) { /* 忽略 */ } } };
        }
        const listeners = new Set();
        const signal = {
            aborted: false,
            addEventListener(_type, fn) { if (typeof fn === 'function') listeners.add(fn); },
            removeEventListener(_type, fn) { listeners.delete(fn); },
        };
        return {
            signal,
            abort() {
                if (signal.aborted) return;
                signal.aborted = true;
                for (const fn of [...listeners]) {
                    try { fn(); } catch (e) { /* 监听者出错不影响其它监听者 */ }
                }
            },
        };
    }
    function lifecycleFor(modId) {
        if (!lifecycleCtl.has(modId)) lifecycleCtl.set(modId, makeLifecycle());
        return { signal: lifecycleCtl.get(modId).signal };
    }
    function abortLifecycle(modId) {
        const ctl = lifecycleCtl.get(modId);
        if (ctl) { try { ctl.abort(); } catch (e) { /* 忽略 */ } }
        lifecycleCtl.delete(modId);
    }

    /** 停用：摘掉贡献但保留 spec，之后还能 activate 回来 */
    function deactivateContributions(modId) { forEachContribution(modId, 'deactivate'); }
    /** 重新启用：用保留的 spec 挂回去 */
    function activateContributions(modId) { forEachContribution(modId, 'activate'); }
    /** 卸载：真删。调用后这个 mod 的贡献表被清空 */
    function disposeContributions(modId) {
        // 倒序释放：后注册的先摘，和构造顺序相反（与栈式清理一致）
        const set = contributions.get(modId);
        if (set) {
            for (const c of [...set].reverse()) {
                try { if (typeof c.dispose === 'function') c.dispose(); }
                catch (e) { console.error('[Mod:' + modId + '] 释放注册项失败', e); }
            }
        }
        contributions.delete(modId);
        // 真正卸载：告诉插件停掉长任务（停用/启用不会走到这里）
        abortLifecycle(modId);
    }


        return {
            contributionSet, addContribution, forEachContribution,
            deactivateContributions, activateContributions, disposeContributions,
            lifecycleFor, abortLifecycle,
        };
    };
})();
