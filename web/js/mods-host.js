/* ============================================================================
 * 宿主桥 / 存储 / host API 构造（从 mods.js 拆出）
 *
 * host() / modsStorageApi() / getHostCore() / getHostExtras()。
 * 只负责懒加载与依赖注入；createHostApi 仍留在 mods.js 组合能力组。
 * ========================================================================== */
(function () {
    'use strict';

    window.ElainaModsHost = function (deps) {
        const {
            resolveModAsset, modDir, getModRoot, registerService, openModSettings,
            hasModSettings, registerSlot, slotImpls, injectStyleLink,
            promptHintText, promptHints, ensurePromptHintContribution,
            guardModAsync, guardMod, bus, isAppReady, addContribution, dispatch,
            HOST_CAPABILITIES, bindFlatDragSort,
        } = deps;
    /**
     * 宿主内部接口（`window.ElainaHost`）。
     *
     * 插件系统的**唯一**宿主依赖面：本文件不直接摸 `handleUserInput`、
     * `renderMessageText`、`state` 这些宿主内部名字，一律经这张表取。
     *
     * 为什么必须这样：宿主内部函数一改名，插件就在运行到那一步时才炸，
     * 而插件作者看不到宿主的改名 —— 这正是收窄的 host API 该防住的事。
     * 走这一层之后，宿主随便重构内部，只要更新 core.js 里的映射即可。
     *
     * 宿主缺失时返回一个空对象：下面每处调用都判了能力，缺了就降级，
     * 不会因为"宿主少了一块"而把插件系统整体带崩。
     */
    function host() {
        try { return window.ElainaHost || {}; } catch (e) { return {}; }
    }

    /**
     * 宿主**声明的**能力清单（`host.has(name)` 的合法参数）。
     *
     * 为什么是白名单而不是 `typeof window[name]`：探测任意全局名等于把 window
     * 上的所有东西（包括别的插件的私有全局名）都变成插件 API。固定清单才能让
     * "宿主到底承诺了什么"可读、可检查，名字写错时也能立刻报出来。
     *
     * 加一项时它必须是**宿主能力**（聊天链路、渲染、弹窗、主题、成就、存储、
     * 本机服务端）。某个具体插件的功能不算宿主能力。
     */
    /**
     * 构造交给插件的宿主接口。
     *
     * 为什么不直接把 window 给它：插件一旦随手引用宿主的内部变量
     * （`state` / `elements` / 各种内部函数），宿主以后就没法重构了 ——
     * 任何改名都会悄悄弄坏某个 mod。这里显式列出允许使用的入口，
     * 宿主改内部实现时只要保证这张表不变，插件就不会坏。
     *
     * @param {object} manifest 清单条目
     * @param {string} [regName] 插件脚本里 register() 用的名字（缺省 = manifest.id）
     */
    let _modsStorage = null;
    function modsStorageApi() {
        if (!_modsStorage) _modsStorage = window.createModsStorage(typeof Store === 'undefined' ? null : Store);
        return _modsStorage;
    }
    function readModStorage() { return modsStorageApi().readModStorage(); }
    function writeModStorage(all) { return modsStorageApi().writeModStorage(all); }
    function createModStorage(modId) { return modsStorageApi().createModStorage(modId); }
    function migrateLegacyModStorage() { return modsStorageApi().migrateLegacyModStorage(); }

    let _hostCore = null;
    function getHostCore() {
        if (!_hostCore) {
            _hostCore = window.ElainaModsHostCore({
                host, resolveModAsset, modDir,
                getModRoot,
                registerService, openModSettings, hasModSettings, createModStorage,
                registerSlot, slotImpls, injectStyleLink, promptHintText, promptHints,
                ensurePromptHintContribution, guardModAsync, bus,
                isAppReady, addContribution, dispatch,
                HOST_CAPABILITIES, guardMod,
            });
        }
        return _hostCore;
    }

    let _hostExtras = null;
    function getHostExtras() {
        if (!_hostExtras) {
            _hostExtras = window.ElainaModsHostExtras({ bindFlatDragSort, host, addContribution });
        }
        return _hostExtras;
    }


        return { host, readModStorage, writeModStorage, createModStorage, migrateLegacyModStorage, getHostCore, getHostExtras };
    };
})();
