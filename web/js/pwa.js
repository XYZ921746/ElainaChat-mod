/* ========================================================================
 * 桌面应用化：把网页版「安装」成独立窗口的桌面应用。
 *
 * 做两件事，都不碰业务逻辑：
 *   ① 注册一个**不缓存任何东西**的 Service Worker（web/sw.js）——
 *      可安装性判据要求站点有 SW 处理 fetch，这一条只是为了让安装入口出现；
 *   ② 在**浏览器自己不给安装入口**的少数环境里，接住 `beforeinstallprompt`，
 *      用顶栏那个按钮补一个入口。Chrome / Edge 这类地址栏本来就有安装图标的
 *      浏览器整段跳过 —— 同一件事给两遍，主界面就变成了"装我"的广告位。
 *      「这次要不要给」由 `window.ElainaRuntime.canInstallAsApp` 决定
 *      （判断住在 core.js 的原生适配段，见 AGENTS.md D5）。
 *
 * 按钮的显隐完全由浏览器事件驱动，**没有一个自己编的判据**：
 *   · 事件没来（不支持 / 已安装 / 非安全上下文 / 用局域网 IP 访问）→ 按钮一直
 *     `hidden`，用户一个字都看不到；
 *   · `appinstalled` 或已处于 `display-mode: standalone` → 隐藏并永不再显示。
 * 「什么时候该给安装入口」这件事只有一个裁判：浏览器自己。
 *
 * 事件监听必须在**脚本求值阶段**就挂上（不能等 DOMContentLoaded）：
 * beforeinstallprompt 可能早于就绪事件触发，晚挂一步就永远等不到按钮。
 * DOM 相关的事（找按钮、点按钮）才留到就绪之后。
 * ======================================================================== */

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

    /**
     * 注册 SW。
     *
     * 只在安全上下文里注册：局域网 IP 走 http 时 `navigator.serviceWorker`
     * 不存在或注册即抛 —— 那种情况下安装本来就不可能，静默跳过比报错更符合
     * 用户预期（这条路看不到任何提示，也不该看到）。
     *
     * 失败一律吞掉、只打 debug：SW 起不来只损失「安装按钮」，聊天本身不受影响，
     * 非核心路径不该在控制台里刷成一片红色报错。
     */
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

    // ── 事件监听：立即挂上，不等 DOM 就绪（理由见文件头）──
    // 安卓壳里页面已经是 APK 了，这一整套没有意义，直接不进这条分支
    const runtime = window.ElainaRuntime;
    const enabled = !(runtime && runtime.canInstallAsApp === false);

    if (enabled) {
        window.addEventListener('beforeinstallprompt', (event) => {
            // 必须阻止默认：否则 Chrome 会在某些时机自己弹一个小气泡，
            // 与顶栏那个按钮形成两个入口
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
