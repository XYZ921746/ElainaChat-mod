/* ============================================================================
 * 情景演绎装配（Live2D 通话入口 + 设置面板）
 *
 * 这段装配原先住在独立的「Live2D 视频通话」插件里（register.js）。合并后它不再是
 * 注册点，而是由 galgame/index.js 在装配主界面的同时一并调用：
 *
 *   · settings.modal 插槽 → 「情景演绎设置」（内容见 panel.html）
 *   · header.actions 插槽 → 主页右上角的「情景演绎」按钮
 *   · Live2D 的提示词 → 交给 galgame 的 syncSceneHint 一起注入
 *
 * 为什么入口在顶栏而**不在**剧情界面里：情景演绎是主页的一个独立入口
 *   （用户要求），不该要求先打开剧情界面；剧情界面里也不再放它的按钮 ——
 *   它本来就盖在剧情界面之上打开，两个入口叠在一起只会让人以为要"先剧情再通话"。
 *
 * 注意：本文件不是注册点。index-live2d.js / settings-panel.js 都**不**自己调
 *   ElainaMods.register —— 注册表是 Map，多注册一次会覆盖掉 galgame 主界面。
 * ========================================================================== */
/** 本插件跨脚本的私有桥；不挂 window.__，避免 D4 私有全局名。
 *  用 var 允许脚本失败重试时重复注入而不触发 const 重复声明。 */
var GalgameBridge = GalgameBridge || {};

(function () {
    'use strict';
    // 合并包的标记：测试与排障靠它确认"这份代码是主包带进来的"，
    // 而不是旧版 live2d 插件还在。
    globalThis.ElainaMerge = true;

    /** 面板 HTML 只取一次（缓存住，重新挂载时复用） */
    let panelHtmlPromise = null;
    function loadPanelHtml(host) {
        if (!panelHtmlPromise) {
            panelHtmlPromise = fetch(host.assetUrl('panel.html'), { cache: 'no-store' })
                .then((r) => {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.text();
                })
                .catch((e) => {
                    panelHtmlPromise = null;      // 失败要能重试，别把坏结果缓存住
                    throw e;
                });
        }
        return panelHtmlPromise;
    }

    /**
     * 装配情景演绎的界面部分。由 galgame/index.js 调用（**不是**它自己调 register）。
     *
     * @param {object} host galgame 插件的 host API
     */
    function mountScenarioStage(host) {
        host.log('情景演绎：开始装配（引擎与模型来自 live2d-models）');

        // 引擎与模型的引用（缺它时 galgame 的 manifest.after 会先拦住；这里只是留个日志）
        const models = host.require('live2d-models');
        if (!models.ok) {
            host.error('情景演绎缺少资源插件：' + models.reason);
        } else {
            host.log('资源插件就绪（模型基址 ' + models.base() + '）');
        }

        // ---- 实现主体：全屏通话界面 ----
        if (typeof GalgameBridge.initLive2DCore === 'function') {
            GalgameBridge.initLive2DCore(host);
        } else {
            // 脚本没注入成功时要说清楚 —— 否则表现为"插件是 ready、但点了没反应"
            host.error('index-live2d.js 未就绪（initLive2DCore 不存在），情景演绎不可用');
        }

        // ---- 顶部按钮：情景演绎 ----
        // 合并后**只有一个入口**：剧情对话框与角色呈现都在同一个舞台里
        // （原来那个"纯 2D 剧情界面"与"视频通话"是两块重合的界面，现在
        // 舞台复用剧情的气泡/输入行，角色可切立绘或 Live2D —— 见设置页 ①）。
        host.slot('header.actions', {
            id: 'scenario',
            label: '情景演绎',
            title: '情景演绎（剧情对话 + 立绘 / Live2D）',
            svg: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">'
                + '<path stroke-linecap="round" stroke-linejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>',
            onClick() {
                if (window.Live2DCall && typeof window.Live2DCall.open === 'function') {
                    window.Live2DCall.open();
                } else {
                    host.error('情景演绎未就绪（Live2D 组件没有装配成功，刷新页面后再试）');
                }
            },
        });

        // ---- 设置：独立成窗（不占主设置的分栏）----
        host.slot('settings.modal', {
            // ★ 这里必须是**插件 id**（galgame），不是随便起的名字：
            //   设置页的齿轮按 `__modSettingsOpeners[插件id]` 找打开函数，
            //   写成 'scenario' 的话按钮能点但永远找不到这个设置窗。
            id: 'galgame',
            label: '情景演绎',
            title: '情景演绎设置',
            async render(container) {
                container.innerHTML = '<div class="text-[11px] text-indigo-400 py-4">正在加载情景演绎设置…</div>';
                let html;
                try {
                    html = await loadPanelHtml(host);
                } catch (e) {
                    // 面板是包内静态文件，取不到说明装坏了 —— 说清楚，别留空白
                    container.innerHTML = '<div class="text-[11px] text-red-500 py-4 leading-relaxed">'
                        + '情景演绎设置面板加载失败（' + String((e && e.message) || e) + '）。<br>'
                        + '请确认插件目录里有 <code>panel.html</code>，然后刷新页面重试。</div>';
                    host.error('情景演绎设置面板加载失败', e);
                    return;
                }
                container.innerHTML = html;
                try {
                    if (typeof GalgameBridge.initSettingsPanel === 'function') {
                        GalgameBridge.initSettingsPanel(host);
                    } else {
                        host.warn('settings-panel.js 未就绪，面板只有外观没有行为');
                    }
                } catch (e) {
                    host.error('情景演绎设置面板初始化失败', e);
                }
            },
        });

        return {
            /** 停用时收起通话界面（自建界面自己收，见 mods.js 的生命周期说明） */
            closeCall() {
                if (window.Live2DCall && typeof window.Live2DCall.close === 'function') {
                    try { window.Live2DCall.close(); } catch (e) { /* 忽略 */ }
                }
            },
            isCallOpen: () => Boolean(window.Live2DCall && window.Live2DCall.isOpen && window.Live2DCall.isOpen()),
        };
    }

    GalgameBridge.mountScenarioStage = mountScenarioStage;
})();
