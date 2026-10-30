/* ============================================================================
 * 插件脚本注入器（从 mods.js 拆出）
 *
 * <script> 注入 / 超时 / 瞬时失败重试。只有 loadedScripts 一份共享状态。
 * ========================================================================== */
(function () {
    'use strict';

    window.ElainaModsLoader = function (deps) {
        const loadedScripts = deps && deps.loadedScripts ? deps.loadedScripts : new Set();
        const SCRIPT_LOAD_TIMEOUT_MS = 15000;
    const SCRIPT_LOAD_ATTEMPTS = 3;
    /** 每次重试前的等待（毫秒），逐次加长：给占用文件的进程一点时间松手 */
    const SCRIPT_RETRY_DELAYS = [400, 1200];

    /** 注入一个 <script>，resolve 于 load / reject 于 error（瞬时失败会重试） */
    function injectScript(src, attempt = 1) {
        if (loadedScripts.has(src)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            // 重试时必须换一个 URL：同一地址的失败结果可能已被浏览器缓存，
            // 不带新参数的话"重试"只是从缓存里再拿一次同样的失败。
            el.src = attempt > 1
                ? src + (src.includes('?') ? '&' : '?') + 'retry=' + attempt
                : src;
            el.setAttribute('data-mod-script', '1');
            // 超时即失败：服务端/系统把文件占住时，onload/onerror 可能**都不触发**。
            //   没有这道闸，整轮 loadAll 会永远停在这个 URL 上，后面的插件
            //   一个都不会加载（表现为"插件系统只加载了一半"）。
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { el.remove(); } catch (e) { /* 忽略 */ }
                reject(new Error('脚本加载超时（' + Math.round(SCRIPT_LOAD_TIMEOUT_MS / 1000)
                    + ' 秒）：' + src));
            }, SCRIPT_LOAD_TIMEOUT_MS);
            const done = (fn) => (arg) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(arg);
            };
            el.onload = done(() => { loadedScripts.add(src); resolve(); });
            el.onerror = done(() => {
                try { el.remove(); } catch (e) { /* 老浏览器没有 remove，忽略 */ }
                if (attempt >= SCRIPT_LOAD_ATTEMPTS) {
                    reject(new Error('脚本加载失败：' + src));
                    return;
                }
                const wait = SCRIPT_RETRY_DELAYS[attempt - 1] || 1200;
                console.warn('[Mod] 脚本加载失败，' + wait + 'ms 后重试（第 '
                    + (attempt + 1) + '/' + SCRIPT_LOAD_ATTEMPTS + ' 次）：' + src);
                setTimeout(() => {
                    injectScript(src, attempt + 1).then(resolve, reject);
                }, wait);
            });
            document.head.appendChild(el);
        });
    }


        return { injectScript, SCRIPT_LOAD_TIMEOUT_MS };
    };
})();
