/* 桌面应用化：注册一个不缓存任何东西的 SW（web/sw.js）以满足可安装性判据，并在浏览器不给安装入口的环境里接住 `beforeinstallprompt`
 * 补一个顶栏入口。开关由 `window.ElainaRuntime.canInstallAsApp` 决定（见 AGENTS.md D5）；监听必须在脚本求值阶段挂上，按钮显隐由浏览器事件驱动。 */

(function () {
    'use strict';

    /** 浏览器交出来的安装事件；用完必须置空，它只能 prompt 一次 */
    let deferredPrompt = null;

    /** 按钮按需查一次并缓存 —— 脚本求值时机可能早于/晚于 DOM，两者都能工作 */
    let installBtn = null;
    let btnResolved = false;
    function button() {
        if (!btnResolved) {
            installBtn = document.getElementById('headerInstallBtn');
            if (installBtn) btnResolved = true;
        }
        return installBtn;
    }

    /** 已经在独立窗口里跑（已安装 / 被 `--app` 打开）—— 再给「安装」就是重复入口 */
    function isStandalone() {
        try {
            if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
            if (window.matchMedia && window.matchMedia('(display-mode: minimal-ui)').matches) return true;
            if (navigator.standalone === true) return true;   // iOS Safari 的私有字段
        } catch { /* 老浏览器没有 matchMedia 就当不是 */ }
        return false;
    }

    function showButton() {
        const btn = button();
        if (!btn || isStandalone()) return;
        btn.classList.remove('hidden');
    }

    function hideButton() {
        const btn = button();
        if (btn) btn.classList.add('hidden');
    }

    /** 注册 SW：只在安全上下文注册（局域网 IP 走 http 时 serviceWorker 不存在或注册即抛，那时安装本来就不可能）。
     *  失败一律吞掉只打 debug —— SW 起不来只损失「安装按钮」，聊天本身不受影响。 */
    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        if (!window.isSecureContext) return;
        try {
            // scope 必须覆盖站点根：装好的应用窗口打开的是 /，SW 得管同一范围
            navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
                console.debug('[pwa] Service Worker 注册失败（不影响使用）：', err && err.message ? err.message : err);
            });
        } catch (err) {
            console.debug('[pwa] Service Worker 不可用：', err && err.message ? err.message : err);
        }
    }

    function onButtonClick() {
        if (!deferredPrompt) { hideButton(); return; }
        // 先藏按钮再弹框：系统框关掉后事件已失效，留着的按钮就是个死按钮
        hideButton();
        const prompt = deferredPrompt;
        deferredPrompt = null;
        (async () => {
            try {
                prompt.prompt();
                await prompt.userChoice;
            } catch (err) {
                console.debug('[pwa] 安装提示失败：', err && err.message ? err.message : err);
            }
        })();
    }

    // 事件监听：立即挂上，不等 DOM 就绪（理由见文件头）；安卓壳里页面已是 APK，这一整套没有意义，不进这条分支。
    const runtime = window.ElainaRuntime;
    const enabled = !(runtime && runtime.canInstallAsApp === false);

    if (enabled) {
        window.addEventListener('beforeinstallprompt', (event) => {
            // 必须阻止默认：否则 Chrome 会在某些时机自己弹一个小气泡，与顶栏那个按钮形成两个入口
            event.preventDefault();
            deferredPrompt = event;
            showButton();
        });

        window.addEventListener('appinstalled', () => {
            deferredPrompt = null;
            hideButton();
        });
    }

    function boot() {
        const btn = button();
        if (btn) btn.addEventListener('click', onButtonClick);

        if (!enabled) { hideButton(); return; }

        registerServiceWorker();

        if (isStandalone()) {
            // 已经在独立窗口里了：按钮永远不该出现
            hideButton();
            return;
        }

        // 事件若在 DOM 就绪前就到了（按钮那时还查不到），这里补显一次
        if (deferredPrompt) showButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
