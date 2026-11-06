/* 插件系统（动态 mod 加载器）：清单驱动、失败隔离、按需加载、顺序可控（manifest.after 拓扑排序并检测环）、宿主 API 收窄。
 * 脚本用 <script src> 注入而非 fetch+eval：保留来源与调试堆栈；代价是异步，所以提供 await loadAll()。 */
(function () {
    'use strict';

    /* 插件根目录（相对站点根）。必须是 `let`：安卓 APK 上这个根要在首次加载插件之前换成应用数据目录的 WebView 可访问地址；
     * 这里不做编码（编码由 modDir() 逐段负责，在赋值处再 encode 会双重编码导致 404）。 */
    let MOD_ROOT = '/mods/';

    // 拖拽排序内核单独成文件（设置页与插件页共用；见 mods-drag-sort.js）
    const { bindFlatDragSort } = window.ElainaModsDragSort;
    const { modDir, withTimeout, resolveModAsset, lastModScriptUrl } = window.ElainaModsPaths({ getModRoot: () => MOD_ROOT });
    const { sortByDependency, describeMissingDeps, refusalMessage, dependentNames } = window.ElainaModsGraph;

    /* 等原生插件根就绪。平台判定不在这里（core.js 保证非原生环境下 `__nativeModsRootPromise` 不存在）；
     * 必须显式等待：首次 loadAll 若不等就会用桌面根去加载、APK 上全部 404。等待放在 loadAll 内部（入口不止 boot 一个）。 */
    let _nativeModRootWaited = null;
    function awaitNativeModRoot() {
        // 非原生（或根初始化失败）：core 不会设置这个 Promise → 立即过
        if (!window.__nativeModsRootPromise) return Promise.resolve();
        if (!_nativeModRootWaited) {
            _nativeModRootWaited = Promise.resolve(window.__nativeModsRootPromise)
                .then(() => {
                    if (window.__nativeModBase) MOD_ROOT = window.__nativeModBase;
                })
                .catch(() => { /* core 那边已打日志；回落桌面根 */ });
        }
        return _nativeModRootWaited;
    }

    /** 插件状态：id -> { manifest, state, error, api } */
    const registry = new Map();

    /** 已注入的 <script>，避免重复注入 */
    const loadedScripts = new Set();
    const { injectScript, SCRIPT_LOAD_TIMEOUT_MS } = window.ElainaModsLoader({ loadedScripts });

    /* 第三方代码的单次时间上限：脚本请求可能被拖住，初始化函数也可能返回永不 resolve 的 Promise；
     * 没有上限时前者会让整轮 loadAll 卡在一个 URL 上，后者会让「设置 → 插件」永远停在"加载中"。 */
    const MOD_INIT_TIMEOUT_MS = 20000;
    /** 同一个插件运行期连续出错多少次后自动停用（偶发一次不处罚） */
    const MOD_FAULT_LIMIT = 5;
    /** 全局开关：用户可以在设置里彻底关掉插件系统 */
    const MODS_ENABLED_KEY = 'elaina_plugins_enabled';
    const MOD_ENABLED_KEY_PREFIX = 'elaina_plugin_';
    /* 插件上次加载失败的原因（`elaina_plugin_failed_<id>` → `{at, error}`）。单独前缀而不塞进开关键：开关是"0/1"、
     * 混进 JSON 解析变脆且生命周期不同；前缀 `elaina_plugin` 由 store.js 的 DATA_KEYS 按 `^elaina_plugin_\S+$` 放行，天然落盘、跨设备同步。 */
    const MOD_FAILED_KEY_PREFIX = 'elaina_plugin_failed_';

    function modsGloballyEnabled() {
        try { return Store.getItem(MODS_ENABLED_KEY) !== '0'; } catch (e) { return true; }
    }
    function setModsGloballyEnabled(on) {
        try { Store.setItem(MODS_ENABLED_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }
    /* 某个插件是否启用。**没有用户设置时一律算关闭**：插件会改动界面与行为，判据不能写成 `!== false`
     * （作者漏写就等于默认打开）；要默认开的插件必须显式写 `"defaultEnabled": true`。 */
    function isModEnabled(id, manifest) {
        try {
            const v = Store.getItem(MOD_ENABLED_KEY_PREFIX + id);
            if (v === null) return Boolean(manifest && manifest.defaultEnabled === true);
            return v === '1';
        } catch (e) {
            return Boolean(manifest && manifest.defaultEnabled === true);
        }
    }
    function setModEnabled(id, on) {
        try { Store.setItem(MOD_ENABLED_KEY_PREFIX + id, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }

    //  插件脚本与宿主同源同窗口，语言层面没有沙箱；能做的隔离是在每个「宿主 → 插件」的调用边界上兜住异常，
    //  并给单个插件一个错误预算（偶发一次不停用，反复炸就不能继续留在界面上），统一走 guardMod / guardModAsync。

    function createHostApi(manifest, regName, lifecycle) {
        // 日志前缀用**注册名**（插件自己认得的名字），便于对上它的源码
        const name = regName || manifest.id;
        const log = (level, ...args) => {
            const tag = '[Mod:' + name + ']';
            const fn = console[level] || console.log;
            try { fn(tag, ...args); } catch (e) { /* 忽略 */ }
        };
        // 这个插件声明了哪些能力组（缺省只有 core）
        const groups = declaredApiGroups(manifest, log);
        const hasGroup = (g) => groups.has(g);
        const ctx = { manifest, name, log, groups, lifecycle };
        const extras = getHostExtras();
        return {
            ...getHostCore()(ctx),
            ...(hasGroup('openFolder') ? extras.openFolderHostApi(ctx) : {}),
            ...(hasGroup('dragSort') ? extras.dragSortHostApi(ctx) : {}),
            ...(hasGroup('theme') ? extras.themeHostApi(ctx) : {}),
            ...(hasGroup('achievements') ? extras.achievementsHostApi(ctx) : {}),
            ...(hasGroup('desktopWindow') ? extras.desktopWindowHostApi(ctx) : {}),
            ...(hasGroup('appUi') ? extras.appUiHostApi(ctx) : {}),
        };
    }

    /* core 组：插件的基本生存能力（永远提供，不可关闭） */
    /* 'app-ready' 是否已经发生过（由 `ElainaMods.markAppReady()` 在 init() 末尾置位）。单独存状态而不是只依赖事件：
     * mod 加载是异步的，晚注册的 mod 会错过一次性事件（见 host.on 里的补调）。 */
    let appReadyFired = false;

    //  宿主插槽 +「注册即副作用」：宿主只负责挖插槽（settings.tabs / header.actions…），mod 用 host.slot(name, spec) 注册。
    //  每项注册都记成可撤销贡献（停用 deactivate 摘掉但留 spec；启用 activate 挂回、不重跑工厂；卸载 dispose 真删），
    //  否则"关掉"只是表面关掉 —— 插槽入口、注入的样式、system 提示词、事件订阅都会留着。

    const {
        contributionSet, addContribution, forEachContribution,
        deactivateContributions, activateContributions, disposeContributions,
        lifecycleFor, abortLifecycle,
    } = window.ElainaModsContributions();

    const { reportModFault, guardMod, guardModAsync, autoDisableBroken, readModFailure, clearModFailure } = window.ElainaModsFaults({
        getRegistry: () => registry, setModEnabled, deactivateContributions,
        MOD_FAULT_LIMIT, MOD_FAILED_KEY_PREFIX,
    });

    const {
        registerService, findService, removeModServices,
        promptHints, promptHintText, ensurePromptHintContribution,
        registerSettingsOpener, unregisterSettingsOpener,
        closeModSettings, openModSettings, hasModSettings,
        collectPromptHints, settingsOpeners,
    } = window.ElainaModsServices({ getRegistry: () => registry, contributionSet, guardMod });

    const {
        slotImpls, registerSlot, renderItemSlot, injectStyleLink, validateSlotSpec, defineSlot,
    } = window.ElainaModsSlots({ addContribution, guardMod, guardModAsync, resolveModAsset });

    /** 简易事件总线（宿主 ↔ 插件、插件 ↔ 插件） */
    const bus = new Map();

    // 插槽登记在 mods-slots.js、清单发现与排序在 mods-load.js、脚本注入在 mods-loader.js：本文件只做装配。

    /** 插件脚本通过它注册初始化函数（在脚本执行时调用） */
    const pendingRegistrations = new Map();

    /* 注册名 ↔ 目录 的双向映射（插件系统自己维护，插件不参与算路径）。身份有两个来源：清单给的 `manifest.id`
     * 与脚本里 `register('pet', …)` 的注册名；用户改了目录名后两者可能不同，只按 manifest.id 查会查不到 factory。 */
    const regByDir = new Map();
    const dirByReg = new Map();

    /** 当前正在注入的插件目录（register() 据此知道自己来自哪个目录） */
    let loadingDir = null;

    const { forgetMod } = window.ElainaModsForget({
        getRegistry: () => registry, disposeContributions, removeModServices,
        getPendingRegistrations: () => pendingRegistrations,
        getRegByDir: () => regByDir, getDirByReg: () => dirByReg,
        loadedScripts, getModRoot: () => MOD_ROOT, MOD_ENABLED_KEY_PREFIX,
    });

    const { manifestKeyIndex, findMissingDeps, pullUpPrerequisites, findByKey, dependentsOf } = window.ElainaModsDeps({
        getRegByDir: () => regByDir, getRegistry: () => registry, getDirByReg: () => dirByReg,
        modsGloballyEnabled, isModEnabled, setModEnabled,
    });

    const { loadOne } = window.ElainaModsLoadOne({
        getRegistry: () => registry, isModEnabled, readModFailure, deactivateContributions,
        findByKey, refusalMessage, modsGloballyEnabled, resolveModAsset,
        injectStyleLink, injectScript, setLoadingDir: (v) => { loadingDir = v; },
        getPendingRegistrations: () => pendingRegistrations, getRegByDir: () => regByDir,
        lifecycleFor, withTimeout, createHostApi, MOD_INIT_TIMEOUT_MS, autoDisableBroken,
    });

    const { discover, loadAll } = window.ElainaModsLoad({
        awaitNativeModRoot, getModRoot: () => MOD_ROOT,
        sortByDependency, pullUpPrerequisites, findMissingDeps,
        loadOne, logLoadSummary, getRegistry: () => registry, autoDisableBroken,
    });

    /* 把事件广播给总线上的订阅者：总线上的回调在 `host.on` 里已各自包了隔离，这里只做分发（两处各拦一次会让日志重复）。
     * 宿主自己注册的回调（ElainaMods.on）出错同样不该中断其它订阅者，所以保留一层兜底但不计入任何插件。 */
    function dispatch(event, detail) {
        const set = bus.get(event);
        if (!set) return;
        for (const h of [...set]) {
            try { h(detail); } catch (e) {
                console.error('[Mod] 事件回调出错（已隔离）：' + event, e);
            }
        }
    }
    /** 宿主侧广播事件（对外名字仍是 emit，见 ElainaMods 的导出） */
    const emit = dispatch;

    const {
        host, readModStorage, writeModStorage, createModStorage, migrateLegacyModStorage,
        getHostCore, getHostExtras,
    } = window.ElainaModsHost({
        resolveModAsset, modDir, getModRoot: () => MOD_ROOT,
        registerService, openModSettings, hasModSettings,
        registerSlot, slotImpls, injectStyleLink,
        promptHintText, promptHints, ensurePromptHintContribution,
        guardModAsync, guardMod, bus, isAppReady: () => appReadyFired,
        addContribution, dispatch, HOST_CAPABILITIES, bindFlatDragSort,
    });

    const { ensurePrerequisites, setEnabled } = window.ElainaModsEnable({
        getRegistry: () => registry, findByKey, dependentsOf, dependentNames, refusalMessage,
        isModEnabled, setModEnabled, clearModFailure,
        deactivateContributions, activateContributions, emit,
        lastModScriptUrl, loadedScripts, loadOne, autoDisableBroken, guardModAsync,
    });

    //  对外接口

    window.ElainaMods = window.ElainaModsApi({
        migrateLegacyModStorage, findService, findByKey, loadAll,
        isModEnabled, setEnabled, dependentsOf, forgetMod,
        modsGloballyEnabled, setModsGloballyEnabled,
        defineSlot, renderItemSlot, collectPromptHints, emit,
        registerSettingsOpener, unregisterSettingsOpener,
        closeModSettings, openModSettings, hasModSettings, settingsOpeners,
        bus, slotImpls, disposeContributions, guardMod, guardModAsync,
        MOD_FAULT_LIMIT,
        getRegistry: () => registry, getLoadingDir: () => loadingDir,
        getPendingRegistrations: () => pendingRegistrations,
        getRegByDir: () => regByDir, getDirByReg: () => dirByReg,
        getModRoot: () => MOD_ROOT,
        isAppReady: () => appReadyFired,
        markAppReadyState: () => { appReadyFired = true; },
    });

    // 页面就绪后自动加载（宿主也可以显式调 loadAll）。必须等 Store 启动完成：
    // host.storage 读的是 Store 缓存，抢在 bootstrap 前面会让插件读到空数据、把默认值写回去。
    function boot() {
        const start = () => {
            migrateLegacyModStorage();
            loadAll().catch((e) => console.error('[Plugin] 加载流程异常', e));
        };
        let ready;
        try {
            ready = (window.Store && typeof Store.bootstrap === 'function')
                ? Store.bootstrap()
                : Promise.resolve();
        } catch (e) {
            ready = Promise.resolve();
        }
        Promise.resolve(ready).then(start, start);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
