/* ============================================================================
 * 插件系统（动态 mod 加载器）
 *
 * 插件是用户可自行增删的第三方代码，加载器因此必须：清单驱动（只认 manifest.json）、
 *   失败隔离（单个插件抛错不牵连宿主与其它插件）、按需加载（未启用不注入脚本）、
 *   顺序可控（manifest.after 拓扑排序并检测环）、宿主 API 收窄（只经 host 暴露必要能力）。
 *
 * 脚本用 <script src> 注入而非 fetch+eval：保留来源与调试堆栈，也不引入 eval 的风险；
 *   代价是异步加载，所以提供 await loadAll()。
 * ========================================================================== */
(function () {
    'use strict';

    /**
     * 插件根目录（相对站点根）。
     *
     * 必须是 `let`：安卓 APK 上这个根要在**首次加载插件之前**换成应用数据目录的
     * WebView 可访问地址，由 core.js 的 `__nativeModsRootPromise` 设好。换根能全通，
     * 是因为本文件里 MOD_ROOT 的使用点**全部是 URL 拼接**。
     * 这里**不做编码**：编码由 modDir() 逐段负责，在赋值处再 encode 会双重编码导致 404。
     */
    let MOD_ROOT = '/mods/';

    // 拖拽排序内核单独成文件（设置页与插件页共用；见 mods-drag-sort.js）
    const { bindFlatDragSort } = window.ElainaModsDragSort;
    const { modDir, withTimeout, resolveModAsset, lastModScriptUrl } = window.ElainaModsPaths({ getModRoot: () => MOD_ROOT });
    const { sortByDependency, describeMissingDeps, refusalMessage, dependentNames } = window.ElainaModsGraph;

    /**
     * 等原生插件根就绪。
     *
     * 平台判定不在这里（且业务文件里长 isNativePlatform 会让 Web/APK 分裂成两套代码）：
     *   core.js 保证非原生环境下 `__nativeModsRootPromise` 不存在，这里只看这个结果。
     * 必须显式等待：本 IIFE 同步执行时早于 `fs.getUri()` 完成，首次 loadAll 若不等就会用
     *   桌面根去加载，APK 上全部 404。等待放在 loadAll 内部，因为入口不止 boot 一个。
     */
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

    /**
     * 第三方代码的单次时间上限。
     *
     * 脚本请求可能被服务端/系统占用拖住，初始化函数也可能返回永不 resolve 的 Promise。
     * 没有上限时前者会让整轮 loadAll 卡在一个 URL 上，后者会让「设置 → 插件」永远停在"加载中"。
     */
    const MOD_INIT_TIMEOUT_MS = 20000;
    /** 同一个插件运行期连续出错多少次后自动停用（偶发一次不处罚） */
    const MOD_FAULT_LIMIT = 5;
    /** 全局开关：用户可以在设置里彻底关掉插件系统 */
    const MODS_ENABLED_KEY = 'elaina_plugins_enabled';
    const MOD_ENABLED_KEY_PREFIX = 'elaina_plugin_';
    /**
     * 插件上次加载失败的原因（`elaina_pluginfail_<id>` → `{at, error}`）。
     *
     * 为什么单独一个前缀而不是塞进开关那个键：开关的价值是"0/1"，
     * 混进 JSON 会让解析变脆；而且这两件事的生命周期不同 —— 开关由用户决定，
     * 失败记录由系统写、用户修好插件后清掉。
     * 前缀带 `elaina_plugin` 是刻意的：store.js 的 DATA_KEYS 用
     * `^elaina_plugin_\S+$` 动态放行，这样这些键天然落盘、跨设备同步。
     */
    const MOD_FAILED_KEY_PREFIX = 'elaina_plugin_failed_';


    function modsGloballyEnabled() {
        try { return Store.getItem(MODS_ENABLED_KEY) !== '0'; } catch (e) { return true; }
    }
    function setModsGloballyEnabled(on) {
        try { Store.setItem(MODS_ENABLED_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }
    /**
     * 某个插件是否启用。**没有用户设置时一律算关闭**。
     *
     * 为什么"没写 defaultEnabled"也是关闭：插件会改动界面与行为，不该在用户
     *   不知情时生效。判据若写成 `!== false`（旧的写法），作者漏写这一行就等于
     *   默认打开 —— 装完即生效，用户连"我要不要它"都没被问过。要默认开的插件
     *   必须**显式**写 `"defaultEnabled": true`，那是作者有意的选择。
     */
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

    /**
     * 忘掉某个插件的启用状态（删插件时调用）。
     *
     * 为什么删了还要清这个键：留着它没意义（插件都没了），更要紧的是
     * **重装同一个插件时会读到旧状态** —— 若上次是"已启用"，重装后会直接
     * 自动启用，而插件的约定是"默认关闭、用户手动开"。那会让新装的插件
     * 在用户不知情时改动界面。
     */
    function forgetMod(id) {
        try {
            Store.removeItem(MOD_ENABLED_KEY_PREFIX + id);
            const entry = registry.get(id);
            registry.delete(id);
            // 真删：这个 mod 注册过的插槽/样式/提示词/事件订阅一并释放。
            //   只删目录不释放注册项的话，界面里会留下一个点了没反应的入口
            //   （它指向的插件已经不在了）—— 比"没装过"更难理解。
            disposeContributions(id);
            removeModServices(id);
            // 工厂也丢掉：重装同一个插件时应当是一次干净的重注册
            pendingRegistrations.delete(id);
            const rn = entry && entry.regName;
            if (rn) {
                regByDir.forEach((v, k) => { if (v === rn) regByDir.delete(k); });
                dirByReg.delete(rn);
            }
            // 清掉"已注入脚本"的记录时要同时认 id 与**实际目录名** ——
            // 两者可能不同（见 modDir 说明），只按 id 匹配会漏删，
            // 于是重装同一个插件时脚本不会被重新注入（表现为"装了没反应"）。
            // 匹配**锚定在 MOD_ROOT 紧后方的第一个路径段**，不做子串匹配：
            //   ① 原生模式下 URL 是 `…/_capacitor_file_/…/files/mods/<id>/…`，
            //      而插件 id 允许叫 `files` / `data` —— 子串匹配下卸载一个叫 `files`
            //      的插件会把**所有**插件的注入记录全清掉（`/files/` 撞进每个 URL）。
            //   ② 桌面端同理：id 叫 `mods` 的插件 needle `'/mods/'` 同样全命中。
            //   锚定后 `…/mods/foo/…` 命中，而 `…/mods/foo-bar/…`、`…/files/foo/…`、
            //   `…/mods/bar/foo/…` 都不命中（斜杠边界）。
            const needles = ['/' + id + '/'];
            if (entry && entry.manifest && entry.manifest.dir) needles.push('/' + entry.manifest.dir + '/');
            loadedScripts.forEach((v, k) => {
                if (!k.startsWith(MOD_ROOT)) return;
                const tail = k.slice(MOD_ROOT.length);
                if (needles.some((n) => tail.startsWith(n.slice(1)))) loadedScripts.delete(k);
            });
        } catch (e) { /* 忽略 */ }
    }

    //
    //  插件脚本与宿主同源同窗口，语言层面没有沙箱。能做的隔离是在每个
    //  「宿主 → 插件」的调用边界上兜住异常，并给单个插件一个错误预算：
    //  偶发一次渲染/事件异常不该停用它，但同一个插件反复炸就不能继续留在
    //  界面上。所有边界统一走 guardMod / guardModAsync —— 各处自己写
    //  try/catch 时漏一处，就是“插件抛错、宿主流程中断”。

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
        };
    }

    /**
     * core 组：插件的基本生存能力（永远提供，不可关闭）。
     */
    /**
     * 'app-ready' 是否已经发生过。
     *
     * 由 `ElainaMods.markAppReady()` 置位（init.js 在 init() 末尾调用）。
     * 单独存这个状态而不是只依赖事件：mod 加载是异步的，晚注册的 mod 会
     * 错过一次性事件（见 host.on 里的补调）。
     */
    let appReadyFired = false;

    // ========================================================================
    //  宿主插槽（named slots）+「注册即副作用」
    //  ── 为什么不是"每种扩展点一个 API" ─────────────────────────────────────
    //  给 Live2D 搬迁列需求时，最初的结论是"要新增三种宿主能力"：注册设置分栏、
    //  注册顶部按钮、注册服务端接口。问题是这三种几乎不共用代码，而每多一种
    //  扩展点（聊天区按钮、侧栏底部…）就得再加一个宿主 API 与一套回收逻辑。
    //  改成**命名插槽**后，宿主只负责挖插槽（`settings.tabs` / `header.actions`…），
    //  mod 只用一个 `host.slot(name, spec)`。设置分栏与顶部按钮都只是插槽的实例，
    //  以后 Live2D / Galgame / 任何新 mod 共用同一套机制与同一套回收逻辑。
    //  ── 这一节的目的：注册必须可以反悔 ─────────────────────────────────
    //  插件是可开关的，而"关掉"必须真的关掉：注册过的插槽、注入的样式、
    //  追加的 system 提示词、订阅的事件，都得跟着消失。各处手写回收代码时
    //  漏一处就是一种难查的 bug（停用的 mod 仍往提示词里加内容、injectStyle
    //  挂上去再没摘过），所以回收只能有一套。
    //  所以这里把 mod 的每一项注册都记成**一条可撤销的贡献**：
    //    停用 → deactivate（从界面/提示词/事件上摘掉，但**保留 spec**）
    //    启用 → activate  （拿保留的 spec 重新挂上）
    //    卸载 → dispose   （真删，连 spec 一起丢）
    //  为什么"启用"不重跑 mod 的工厂（register 里的那个函数）：
    //    galgame / pet 的工厂里建 DOM、挂监听、起定时器。重跑工厂会得到
    //    两份界面、两组定时器。工厂在 mod 约定里是"初始化一次"，而可以
    //    反复执行的是**注册动作** —— 保留 spec 就是为了这个。
    // ========================================================================

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

    /**
     * 往插槽里注册一项（`host.slot(name, spec)` 的实现）。
     *
     * spec 由**宿主插槽的约定**决定（例如 settings.tabs 要 label + render），
     * 这里只做归属登记、去重与生命周期，不解释 spec 的业务含义 ——
     * 解释权在挖插槽的那一方，mod 系统不该长着每种扩展点的知识。
     *
     * 插槽名写错时**明确报出来并列出可用插槽**：写错名字是 mod 作者最容易犯的错，
     * 而"注册了但界面没变化"是最难查的表现形式。
     */
    // ========================================================================
    //  清单发现与排序
    // ========================================================================

    /**
     * 发现所有插件。
     *
     * 为什么需要一份"清单索引"：浏览器里没法列目录。所以约定
     * `mods/index.json` 是插件清单数组（构建/手工维护），
     * 加载器读它。这样"加一个 mod"= 加目录 + 往 index.json 加一行。
     *
     * 安卓 APK 上没有静态服务，`/mods/index.json` 根本不存在（纯净版 APK
     *   连内置插件都不带）。原生模式改走 `/api/plugins` —— 那条请求被 core.js 的
     *   原生拦截器接住，从应用数据目录扫描生成清单（形状与这里期望的完全对齐）。
     *   必须用**字面量** `/api/plugins`：拦截器精确匹配这个串，
     *   拼 MOD_ROOT 的话原生基址会是 `_capacitor_file_` 前缀，匹配不上。
     *   平台判定不在这里做（见 awaitNativeModRoot 的说明）：
     *   桌面模式 `__nativeModBase` 恒为 undefined → 恒走桌面地址；
     *   原生模式它被设置 → 恒走 /api/plugins。判定收敛在 core.js。
     */
    // ========================================================================
    //  加载
    // ========================================================================

    /**
     * 脚本注入的尝试次数（首次 + 2 次重试）。
     *
     * 为什么要重试：插件脚本是**一次 HTTP 请求**，而请求失败并不等于插件坏了 ——
     *   安装刚写完文件时可能还被系统扫描占用、复用的长连接可能已被对端关掉、
     *   浏览器也可能还留着上一次（目录尚不完整时）的失败结果。这些都是一次性的：
     *   同一 URL 隔一会儿再取就正常（实测：失败 50 秒后同一个 URL 加载成功）。
     *   不重试的话，一次抖动就被 `autoDisableBroken` 写盘停用，用户看到
     *   「加载失败 · 已自动停用」，而插件其实完全可用 —— 只能手动再把开关打开。
     *
     *   为什么是**有限次**：重试只该吸收抖动。脚本真的缺失 / 语法错误时，
     *   每次都会失败，有限次后照旧停用并给出原因 —— 不能变成"每次点都再试很久"。
     */
    /**
     * 加载并初始化单个插件。
     *
     * 失败隔离的核心：**整个函数体都包在 try/catch 里**。
     * 插件是用户可自行增删的东西，质量不可控 —— 一个坏 mod 绝不能
     * 让整个白屏（那会让用户连"去设置里关掉它"都做不到）。
     *
     * @param {object} manifest 清单条目
     * @param {Array<{id:string,reason:string,fixable:boolean}>} [missingDeps]
     *        不可用的前置插件（非空时**拒绝加载**）
     */
    /** 插件脚本通过它注册初始化函数（在脚本执行时调用） */
    const pendingRegistrations = new Map();

    /**
     * 注册名 ↔ 目录 的双向映射（插件系统自己维护，插件不参与算路径）。
     *
     * ── 为什么需要它──────────────────────────────
     *
     * 插件的**身份**其实有两个来源：
     *   · 服务端清单给的 `manifest.id`（来自 manifest.json，或回落到目录名）
     *   · 插件脚本里 `register('pet', …)` 声明的**注册名**
     *
     * 正常情况两者相同。但用户**改了插件目录名**之后就可能不同：
     * 目录叫 `pet-renamed`、manifest 又没写 id → 清单 id 是 `pet-renamed`，
     * 而脚本注册的是 `pet`。只按 `pendingRegistrations.get(manifest.id)` 查
     * → **查不到 factory → 插件永远不初始化**（清单里显示"已加载"，
     * 界面却毫无反应，是最难排查的那种）。
     *
     * 所以查找必须由插件系统来做：脚本是按目录注入的，系统**知道**
     * 某个 register() 调用来自哪个目录。于是记录 dir → 注册名，
     * loadOne 先按 manifest.id 找，找不到就按"我这个目录注册了什么"找。
     * 这样**目录怎么改都不影响插件被正确初始化**。
     */
    const regByDir = new Map();     // dir（磁盘目录名）→ 注册名
    const dirByReg = new Map();     // 注册名 → dir

    /** 当前正在注入的插件目录（register() 据此知道自己来自哪个目录） */
    let loadingDir = null;

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

    /**
     * 把事件广播给总线上的订阅者。
     *
     * 总线上的回调在 `host.on` 里已经各自包了隔离，这里**只做分发**，
     *   不再自己 try/catch —— 两个地方各拦一次时，日志会重复两遍，
     *   而且"是谁抛的"反而说不清。宿主自己注册的回调（ElainaMods.on）出错
     *   同样不该中断其它订阅者，所以保留一层兜底但不计入任何插件。
     */
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

    // ========================================================================
    //  对外接口
    // ========================================================================

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

    // 页面就绪后自动加载（宿主也可以显式调 loadAll）。
    // 必须等 Store 启动完成：host.storage 读的是 Store 缓存，抢在 bootstrap 前面
    // 会让插件读到空数据、把默认值写回去。
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
