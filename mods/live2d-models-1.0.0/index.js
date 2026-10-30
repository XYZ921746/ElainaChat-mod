/* ============================================================================
 * Live2D 模型（公共依赖插件）—— 前端半边
 *
 * 与 elaina-avatar 完全同一套路：**只提供资源与接口，不提供界面**，
 * 被「Live2D 视频通话」依赖。
 *
 * 为什么模型要单独一个 mod（而不是塞进视频通话那个）：
 *   · 模型是**用户上传的内容**，代码是代码 —— 分开之后换模型不用动代码，
 *     卸掉视频通话也还能留着模型
 *   · 打包分发时口径一致：elaina-avatar 是立绘资源包，这个是模型资源包，
 *     两者都可以单独更新（模型动辄 6.7MB，不该跟代码一起发版）
 *
 * ── 对外接口（挂到 window.ElainaLive2DModels）──────────────────────────────
 *   list()              列出模型（走 /api/live2d/models，Web 与 APK 同一条路）
 *   baseUrl(name)       模型资源基址（结尾带 /）
 *   assetUrl(name, rel) 模型内某个文件的 URL（rel 是相对模型根目录的路径）
 *
 * 这里**不碰任何界面**，也不 import 宿主内部 —— 视频通话那边通过
 *   host.require('live2d-models') 取这个接口。
 * ========================================================================== */
(function () {
    'use strict';

    const MOD_ID = 'live2d-models';

    /**
     * 模型资源基址。
     *
     * Web：服务端把 `/live2d/models/` 映射到本插件目录下的 models/（见 manifest.server.static）
     * APK：`window.__nativeModelBase` 指向应用数据目录（内置模型会被播种到那里）
     *
     * 两条路的**对外 URL 都是 /live2d/models/**，所以调用方不需要区分平台。
     * 平台差异只体现在「宿主有没有注入 __nativeModelBase」：有就是 APK 的数据目录，
     * 没有就是 Web 的静态映射 —— 不在插件里判断 Capacitor / 平台（D5）。
     */
    function baseUrl(name, bundled) {
        const n = encodeURIComponent(String(name || ''));
        // 打包进 APK 的内置模型走 WebView 静态资源（不依赖原生文件系统）
        if (bundled) return '/live2d/models/' + n + '/';
        const base = window.__nativeModelBase ? window.__nativeModelBase : '/live2d/models/';
        return base + n + '/';
    }

    /** 模型内某个文件的 URL；rel 是相对模型根目录的路径（可能带子目录） */
    function assetUrl(name, rel, bundled) {
        return baseUrl(name, bundled) + String(rel || '').replace(/^\/+/, '');
    }

    /**
     * 列出模型。
     *
     * 走 `/api/live2d/models` 而不是自己扫目录：Web 上那是服务端接口，
     * APK 上被 app-01-core.js 的 fetch 拦截器接住（用 Capacitor Filesystem 实现同一套语义）。
     * 所以这里**一份代码两端都能跑**。
     */
    async function list() {
        const res = await fetch('/api/live2d/models', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (!json || json.ok === false) throw new Error((json && json.message) || '接口返回失败');
        return Array.isArray(json.models) ? json.models : [];
    }

    //  引擎懒加载
    // 为什么必须懒加载：这三个库合计 770KB（Cubism Core 207KB + PIXI 460KB +
    //   pixi-live2d-display 120KB），而它们只在**打开视频通话**时才需要。
    //   拆分前它们由 index.html 无条件加载 —— 不装 Live2D 的用户也要为此付出
    //   解析与内存代价。现在改由本插件在真正需要时按顺序注入。
    // 依赖顺序是硬的，不能并发：
    //     live2dcubismcore → pixi-6 → pixi-live2d-display
    //   最后那个在**求值时**就要 window.PIXI 与 window.Live2DCubismCore 已存在。
    //   并发注入会因顺序不确定而随机失败（"有时能开有时不能"最难查）。
    const ENGINE_FILES = [
        'live2dcubismcore.min.js',
        'pixi-6.min.js',
        'pixi-live2d-display-cubism4.min.js',
    ];

    /** 引擎基址：本插件声明 server.static 的 /live2d/vendor（见 manifest） */
    function vendorBase() {
        // 电脑版：服务端按 manifest 的 server.static 把 /live2d/vendor/ 映射到插件目录。
        // APK：没有服务端，这条静态路由不存在 → HEAD 探测会 404，自动走下面的回落。
        return '/live2d/vendor/';
    }
    /** 工厂里的 host。引擎函数定义在工厂**之外**（注册之前就要能用），但它们需要
     *  host.assetUrl() 来解析"插件自己目录"——APK 上引擎随插件包分发，宿主不再附带。
     *  工厂一进来就把它存下来（见 register 回调的第一行）。 */
    let hostRef = null;
    /** 引擎回落基址（电脑版）：仓库本体不带插件时，引擎在 web/vendor/（软件本体）。
     * APK 不走这里 —— 那边宿主没有引擎了，改从插件自己目录取，见注入循环。 */
    function vendorFallbackBase() {
        return '/vendor/';
    }

    /** 已加载的脚本 URL（避免重复注入） */
    const loadedScripts = new Set();
    /** 正在进行的加载（并发调用共享同一个 Promise，不会注入两遍） */
    let enginePromise = null;

    /** 注入一个 <script> 并等它加载完 */
    function injectScript(src) {
        if (loadedScripts.has(src)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.setAttribute('data-live2d-engine', '1');
            el.onload = () => { loadedScripts.add(src); resolve(); };
            el.onerror = () => reject(new Error('引擎脚本加载失败：' + src));
            document.head.appendChild(el);
        });
    }

    /**
     * 确保引擎已就绪（可重复调用；并发调用只加载一次）。
     *
     * 就绪判据是**全局对象真的存在**，而不是"脚本 onload 过了"：
     * pixi-live2d-display 需要 window.PIXI，而某些环境下脚本能加载但初始化失败 ——
     * 只认 onload 会把那种情况当成成功，然后在用的时候才炸。
     */
    async function ensureEngine() {
        if (window.PIXI && window.Live2DCubismCore && window.PIXI.live2d) return true;
        if (enginePromise) return enginePromise;
        enginePromise = (async () => {
            // 占位：pixi-live2d-display 求值时会检查 Cubism2 的 window.Live2D。
            // 我们的模型是 Cubism3/4（用 live2dcubismcore 加载），给个占位避免它中断。
            // 这段原来在 index.html 的内联 <script> 里，随引擎一起搬进来了。
            if (!window.Live2D) {
                window.Live2D = { version: 'placeholder-cubism4-only', createLive2DModel: null };
            }
            // 逐个注入：先试插件声明的静态基址，404 再回落。
            // 2026-10：回落分支在两端不同 —— 电脑版回落到宿主 /vendor/（软件本体，
            //   插件缺失时兜底）；**APK 上宿主不再附带引擎**，改从**插件自己目录**取，
            //   地址由 host.assetUrl() 解析（别自己拼 /mods/<id>/…：id 与安装目录名可能不同）。
            for (const f of ENGINE_FILES) {
                const primary = vendorBase() + f;
                try {
                    const probe = await fetch(primary, { method: 'HEAD' });
                    if (probe.ok) { await injectScript(primary); continue; }
                } catch (e) { /* 探测失败就走回落 */ }
                const fallback = (window.__nativeModelBase && hostRef && typeof hostRef.assetUrl === 'function')
                    ? hostRef.assetUrl('vendor/' + f)
                    : vendorFallbackBase() + f;
                await injectScript(fallback);
            }
            if (!window.PIXI) throw new Error('PIXI 未就绪（脚本加载了但没挂到 window）');
            if (!window.Live2DCubismCore) throw new Error('Live2DCubismCore 未就绪');
            return true;
        })();
        try {
            return await enginePromise;
        } catch (e) {
            // 失败必须**清掉缓存的 Promise**：否则第一次失败后，
            //   后续每次调用都会立刻拿到同一个失败的 Promise ——
            //   用户即使把网络/文件问题修好了，也只能靠刷新页面才能重试。
            enginePromise = null;
            throw e;
        }
    }

    /** 引擎是否已就绪（同步探测，供调用方决定要不要 await） */
    function engineReady() {
        return Boolean(window.PIXI && window.Live2DCubismCore && window.PIXI.live2d);
    }

    window.ElainaLive2DModels = { list, baseUrl, assetUrl, isNative, ensureEngine, engineReady, vendorBase };

    if (window.ElainaMods && typeof window.ElainaMods.register === 'function') {
        window.ElainaMods.register(MOD_ID, function (host) {
            // 引擎函数定义在工厂之外，但它们要能解析"插件自己目录"（APK 上引擎随插件包走）
            hostRef = host;
            host.log('引擎与模型资源接口就绪（引擎基址 ' + vendorBase() + '）');

            // ---- 设置：模型管理----
            // 为什么管理界面在**资源包**这边：谁拥有资产，谁负责管理。
            //   搬过来之后，卸载视频通话不会把模型一起带走；
            //   想换模型也不必进视频通话（见 panel.js 开头的说明）。
            host.slot('settings.modal', {
                id: MOD_ID,
                label: 'Live2D 引擎与模型',
                title: 'Live2D 引擎与模型',
                render(container) {
                    if (typeof window.__l2dmRenderPanel === 'function') {
                        window.__l2dmRenderPanel(container, host);
                    } else {
                        // panel.js 没注入成功时说清楚，别留空白
                        container.innerHTML = '<div class="text-[11px] text-red-500 py-4">'
                            + '模型管理界面加载失败（panel.js 未就绪）。请确认插件目录里有它，然后刷新页面。</div>';
                        host.error('panel.js 未就绪（__l2dmRenderPanel 不存在）');
                    }
                },
            });

            return {
                list, baseUrl, assetUrl, isNative, ensureEngine, engineReady, vendorBase,
                /**
                 * 在文件管理器里打开一个模型（或本插件）的目录。
                 * 只是转发本插件自己的 host.openFolder —— 路径白名单在宿主/服务端，
                 *   消费方（如视频通话的详情区）拿到这个 api 就能"打开某个模型的
                 *   文件夹"，不必自己拼 /api/plugins/open-folder。
                 * @param {string} [sub] 相对本插件目录的子路径（如 'models/名字'）
                 */
                openFolder(sub) { return host.openFolder(sub); },
                /** 停用时没有自建界面要收（设置窗由插槽机制统一回收） */
                setEnabled() { /* 无自建界面 */ },
            };
        });
    }
})();

