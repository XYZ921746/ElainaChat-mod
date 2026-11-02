/* ============================================================================
 * 插件错误隔离与失败记录（从 mods.js 拆出）
 *
 * reportModFault / guardMod / guardModAsync / autoDisableBroken /
 * readModFailure / clearModFailure。统一错误预算与落盘失败原因。
 * ========================================================================== */
(function () {
    'use strict';

    window.ElainaModsFaults = function (deps) {
        const getRegistry = deps.getRegistry;
        const setModEnabled = deps.setModEnabled;
        const deactivateContributions = deps.deactivateContributions;
        const MOD_FAULT_LIMIT = deps.MOD_FAULT_LIMIT;
        const MOD_FAILED_KEY_PREFIX = deps.MOD_FAILED_KEY_PREFIX;
    /** 统一的插件错误出口：带插件 id、计入错误预算；超过上限自动停用。 */
    function reportModFault(modId, where, error, opts) {
        const count = !opts || opts.count !== false;
        const detail = String((error && error.message) || error || '未知错误');
        console.error('[Mod:' + modId + '] ' + where + ' 失败（已隔离，不影响宿主）', error);
        if (!count) return;
        const entry = getRegistry().get(modId);
        if (!entry) return;
        entry.faultCount = (entry.faultCount || 0) + 1;
        if (entry.state !== 'ready' || entry.faultCount < MOD_FAULT_LIMIT) return;
        entry.state = 'error';
        entry.error = '运行期连续出错 ' + entry.faultCount + ' 次（最近一次：'
            + where + '）：' + detail;
        autoDisableBroken(modId, entry);
        console.error('[Mod:' + modId + '] 运行期错误过多，已自动停用；其余插件与宿主继续运行');
    }

    /** 同步调用插件回调：异常不越过这条线。 */
    function guardMod(modId, where, fn, fallback, opts) {
        try { return fn(); } catch (e) {
            reportModFault(modId, where, e, opts);
            return fallback;
        }
    }

    /** 异步版：同步异常与 Promise 拒绝都收在这里（否则会变成 unhandledrejection）。 */
    function guardModAsync(modId, where, fn, fallback) {
        try {
            const result = fn();
            if (result && typeof result.then === 'function') {
                return result.catch((e) => {
                    reportModFault(modId, where, e);
                    return fallback;
                });
            }
            return result;
        } catch (e) {
            reportModFault(modId, where, e);
            return fallback;
        }
    }



    function autoDisableBroken(id, entry) {
        try { setModEnabled(id, false); } catch (e) { /* 写盘失败也要继续收回注册项 */ }
        try { deactivateContributions(id); } catch (e) { /* 同上 */ }
        if (entry) {
            entry.autoDisabled = true;      // 供设置界面区分「用户关的」与「坏了自己关的」
            entry.enabledBefore = true;     // 它本来是要启用的，只是失败了
            // 原因单独存一个键（不塞进 enabled 那个键里：那是开关语义，
            // 混进原因会让"0/1"的解析变得脆弱）
            try {
                Store.setItem(MOD_FAILED_KEY_PREFIX + id, JSON.stringify({
                    at: Date.now(),
                    error: String((entry.error || '') || '未知错误'),
                }));
            } catch (e) { /* 存不下就只影响"原因能不能跨会话保留"，不影响隔离 */ }
        }
    }

    /** 读某个插件上次的失败记录（没有则 null） */
    function readModFailure(id) {
        try {
            const raw = Store.getItem(MOD_FAILED_KEY_PREFIX + id);
            if (!raw) return null;
            const o = JSON.parse(raw);
            return (o && typeof o === 'object' && o.error) ? o : null;
        } catch (e) { return null; }
    }

    /** 清掉失败记录（用户手动重新启用时调用：他想再试一次，就别再顶着旧错误） */
    function clearModFailure(id) {
        try { Store.removeItem(MOD_FAILED_KEY_PREFIX + id); } catch (e) { /* 忽略 */ }
    }


        return { reportModFault, guardMod, guardModAsync, autoDisableBroken, readModFailure, clearModFailure };
    };
})();
