/* 宿主桥 / 存储 / host API 构造：host() / modsStorageApi() / getHostCore() / getHostExtras()（懒加载 + 依赖注入）。 */
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
    /* 宿主内部接口（`window.ElainaHost`）—— 插件系统的唯一宿主依赖面。本文件不直接摸 `handleUserInput`、
     * `renderMessageText`、`state` 这些宿主内部名字，一律经这张表取，宿主改名时插件才不会在运行到那一步才炸。 */
    function host() {
        try { return window.ElainaHost || {}; } catch (e) { return {}; }
    }

    /* 宿主声明的能力清单（`host.has(name)` 的合法参数）。固定白名单而不是 `typeof window[name]`：
     * 探测任意全局名等于把 window 上的一切（含别的插件的私有全局名）都变成插件 API；加项时它必须是**宿主**能力。 */
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
