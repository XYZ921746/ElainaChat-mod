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

    /** 统一的插件错误出口：带插件 id、计入错误预算；超过上限自动停用。 */
    function reportModFault(modId, where, error, opts) {
        const count = !opts || opts.count !== false;
        const detail = String((error && error.message) || error || '未知错误');
        console.error('[Mod:' + modId + '] ' + where + ' 失败（已隔离，不影响宿主）', error);
        if (!count) return;
        const entry = registry.get(modId);
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
                getModRoot: () => MOD_ROOT,
                registerService, openModSettings, hasModSettings, createModStorage,
                registerSlot, slotImpls, injectStyleLink, promptHintText, promptHints,
                ensurePromptHintContribution, guardModAsync, bus,
                isAppReady: () => appReadyFired, addContribution, dispatch,
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

    const { ensurePrerequisites, setEnabled } = window.ElainaModsEnable({
        getRegistry: () => registry, findByKey, dependentsOf, dependentNames, refusalMessage,
        isModEnabled, setModEnabled, clearModFailure,
        deactivateContributions, activateContributions, emit,
        lastModScriptUrl, loadedScripts, loadOne, autoDisableBroken, guardModAsync,
    });

    // ========================================================================
    //  对外接口
    // ========================================================================

    window.ElainaMods = {
        /** 把旧插件 localStorage 偏好搬进 host.storage（启动时自动调用；测试/诊断可手动调） */
        migrateLegacyStorage: migrateLegacyModStorage,
        /** 按名字取插件服务（只返回已启用/已就绪的插件注册的服务） */
        service: findService,
        /**
         * 插件脚本用它注册初始化函数：ElainaMods.register('galgame', (host) => ({...}))
         *
         * 注册名就是插件的**权威身份**（依赖匹配、资源查找都以它为准）。
         *   这里同时记下"它来自哪个目录"（loadingDir）—— 这样即使目录名、
         *   manifest.id、注册名三者不一致，插件系统也能靠这张表把它们对上。
         *   见 regByDir 的说明。
         */
        register(id, factory) {
            const name = String(id || '').trim();
            // 只允许在**本插件的脚本注入期间**登记：脚本执行完之后再调 register，
            //   等于让运行中的插件（或任何一段代码）给别的插件塞一个工厂。
            if (!loadingDir) {
                console.error('[Mod] register() 只能在插件脚本加载期间调用，本次被忽略：' + name);
                return;
            }
            if (!name || typeof factory !== 'function') {
                console.error('[Mod:' + loadingDir + '] register(id, factory) 需要名字与函数，本次被忽略');
                return;
            }
            const claim = pendingRegistrations.get(name);
            // 一个注册名只能属于一个目录：否则 A 插件可以在 B 之前用 B 的名字登记，
            //   B 加载时就会执行 A 的代码（并拿到 B 的 host API）。
            if (claim && claim.dir && claim.dir !== loadingDir) {
                console.error('[Mod:' + loadingDir + '] 注册名「' + name + '」已属于目录 '
                    + claim.dir + '，本次注册被拒绝（一个插件不能替另一个插件登记）');
                return;
            }
            pendingRegistrations.set(name, { factory, dir: loadingDir });
            if (loadingDir) {
                regByDir.set(loadingDir, name);
                dirByReg.set(name, loadingDir);
            }
        },
        /**
         * 按注册名/清单 id/目录名中的**任意一个**查插件。
         *
         * 这是"路径与身份由插件系统统一管理"的入口：插件之间互相查找
         * （例如 galgame 找 elaina-avatar）不该靠拼字符串，而该问系统。
         * 三个键都试一遍，用户改了目录名也照样查得到。
         *
         * @returns {{id, dir, regName, state, entry}|null}
         */
        find(key) {
            // 三键查找（清单 id / 注册名 / 目录名）收敛在 findByKey ——
            //   setEnabled 拉前置时也要按同一套键找，两处各写一份必然漂移。
            const entry = findByKey(key);
            if (!entry) return null;
            return {
                id: entry.manifest.id,
                dir: entry.manifest.dir || entry.manifest.id,
                regName: entry.regName || entry.manifest.id,
                state: entry.state,
                entry,
            };
        },
        /** 取某个插件资源的 URL（按注册名/清单 id/目录名均可查，自动编码） */
        assetUrl(key, rel) {
            const found = window.ElainaMods.find(key);
            const dir = found ? found.dir : String(key || '');
            const r = String(rel || '').replace(/^\/+/, '');
            const enc = dir.split('/').map(encodeURIComponent).join('/');
            return MOD_ROOT + enc + '/' + r;
        },
        loadAll,
        /** 列出已发现的插件及其状态（供设置界面渲染） */
        list() {
            return [...registry.values()].map((e) => ({
                id: e.manifest.id,
                // dir / regName 都暴露出去：设置界面与宿主都要用真实目录，
                // 而不是拿 id 去猜（三者可能不一致，见 modDir 说明）
                dir: e.manifest.dir || e.manifest.id,
                regName: e.regName || e.manifest.id,
                name: e.manifest.name || e.manifest.id,
                version: e.manifest.version || '',
                description: e.manifest.description || '',
                state: e.state,
                error: e.error,
                enabled: isModEnabled(e.manifest.id, e.manifest),
                // hidden：公共依赖类插件（不提供界面，被其他插件共用）。
                // 设置界面用它加一句用途说明 —— 但**仍然给开关**：
                // 不给开关的话，它一旦被禁用就无法从界面恢复，依赖它的插件会连带
                // 失效，而用户找不到地方修。
                hidden: e.manifest.hidden === true,
                // 前置声明（`after`）：设置页据此把"被别人依赖"的插件归到前置扩展区，
                //   而不是只看作者有没有写 hidden —— 有些前置本身带管理界面（如
                //   live2d-models 的模型管理），作者不会把它标成 hidden，但它同样是
                //   别的插件跑起来的前提。
                after: Array.isArray(e.manifest.after) ? e.manifest.after.slice() : [],
                // 不可用的前置插件（未安装 / 未启用 / 级联不可用）——
                // 这类插件会被**拒绝加载**，设置界面据此显示原因与下一步
                missingDeps: e.missingDeps || [],
                // 是不是「加载失败后自动停用」造成的关闭。
                // 设置界面用它把卡片文案写成"加载失败已自动停用"，并把原因显示
                // 在卡片上 —— 否则用户只会看到开关是关的，以为是自己没开。
                autoDisabled: e.autoDisabled === true,
                // 运行期出错次数（守护边界累计）。设置页拿它区分
                //   「一装就坏」与「跑着跑着开始坏」——后者的下一步是修插件，
                //   而不是"再点一次开关试试"。
                faultCount: e.faultCount || 0,
            }));
        },
        setEnabled,
        /**
         * 谁正在用这个插件（已启用且加载成功的依赖方）。
         *
         * 停用 / 卸载前问它：非空就别动这个插件 —— 拦下并告诉用户先关谁。
         * （设置页的开关与删除按钮都先查这里再动手，弹窗文案用它拼名字。）
         */
        dependentsOf,
        /**
         * 重新扫描并加载插件（幂等，可重复调用）。
         *
         * 为什么市场装完必须调它：注册表只在 loadAll() 里建立。市场装完新插件后
         *   不重新扫描，插件就不在注册表里 —— 此时插件栏那个开关点了也不生效
         *   （setEnabled 开头 `registry.get(id)` 取不到就直接 `return false`），
         *   用户看着开关在那儿其实按不动，也没有任何报错。
         *   调一次即可让新插件当场加载，之前因缺前置被拒的插件也会在这一轮里
         *   **重新评估**依赖（前置补齐即生效）。
         *
         *   为什么重复调用安全：loadAll 全程幂等 —— loadOne 有"脚本已注入过"闸门
         *   （见那里的说明），启动与多设备同步两条路径本来就会重复调用它。
         */
        reload: loadAll,
        /** 删插件时调用：清掉启用状态与已加载记录（避免重装后被自动启用） */
        forget: forgetMod,
        isEnabled: (id) => {
            const e = registry.get(id);
            return e ? isModEnabled(id, e.manifest) : false;
        },
        /** 全局开关：关掉后所有插件都不加载（需要刷新页面生效） */
        isGloballyEnabled: modsGloballyEnabled,
        setGloballyEnabled(on) { setModsGloballyEnabled(on); },

        /**
         * 挖一个插槽出来，之后 mod 就能往这个名字里注册。
         *
         * 为什么由宿主调用而不是写在 mod 系统里：插槽的 spec 约定
         * （例如 settings.tabs 要 label + render）属于"谁挖的谁解释"。
         * mod 系统只负责归属、去重与生命周期，不需要长着每种扩展点的知识。
         *
         * 调用时机：宿主脚本的**顶层**（在 mod 加载之前）。mod 系统读清单是
         * 异步的，所以只要插槽在顶层挖好，一定早于任何 mod 注册。
         *
         * @returns {Function} 撤掉这个插槽（测试与热重载用）
         */
        defineSlot,

        /**
         * 宿主渲染「每一项都要装饰」的位置时用它（每项级插槽）。
         * 例：每条消息渲染完，宿主把消息行的容器交给注册过 chat.message.actions 的 mod。
         */
        renderItemSlot,
        /** 宿主用它取全部插件的 system 提示词片段 */
        collectPromptHints,
        /** 宿主用它广播事件给插件（如"AI 回复完成"、语音音量） */
        emit,

        /** 登记/注销某插件的设置窗打开函数（settings.modal 插槽实现用） */
        registerSettingsOpener,
        unregisterSettingsOpener,
        closeModSettings,
        /** 按插件 id 打开设置窗；没有设置窗返回 false */
        openModSettings,
        /** 该插件有没有设置窗（插件卡片据此决定画不画齿轮） */
        hasModSettings,
        /** 已登记设置窗的插件 id 清单（诊断用） */
        settingsOpeners: () => [...settingsOpeners.keys()],
        /**
         * 宿主在 init() 末尾调一次：通知插件"应用已初始化完成"。
         *
         * 会广播 `app-ready` 并记下"已发生" —— 之后才注册的 mod 订阅时会被
         * 立刻补调（见 host.on 的说明），所以慢加载也不会漏掉这个信号。
         */
        markAppReady() {
            if (appReadyFired) return;
            appReadyFired = true;
            emit('app-ready', {});
        },
        on(event, handler) {
            if (!bus.has(event)) bus.set(event, new Set());
            bus.get(event).add(handler);
            return () => bus.get(event).delete(handler);
        },
        /**
         * 某个事件上有没有订阅者。
         *
         * 宿主用它决定"值不值得算"：例如 TTS 的音量分析要跑
         * requestAnimationFrame 循环，没人听的时候就不该白跑。
         */
        hasListeners(event) {
            const set = bus.get(event);
            if (!set) return false;
            // 停用的 mod 的订阅会被摘掉，所以这里看到的就是"真正在听的人"
            for (const h of set) { if (typeof h === 'function') return true; }
            return false;
        },

        /** 宿主插槽的名字清单（诊断与 mod 自查用） */
        slotNames: () => [...slotImpls.keys()],
        _disposeContributions: disposeContributions,
        _registry: registry,

        // ---- 运行期错误的统一入口（宿主其它模块也可借它隔离回调）----
        /**
         * 把一段第三方回调包进隔离边界。
         *
         * 宿主的 DOM 事件、定时器里如果直接调插件回调，一次抛错就会中断
         *   那一次宿主流程；走这里则只记一条带插件名的日志，并按错误预算
         *   决定要不要停用该插件（连续出错才停，偶发一次不处罚）。
         *
         * @param {string} modId 归属插件
         * @param {string} where 出错位置（写进日志，便于定位）
         * @param {Function} fn 要执行的回调
         * @param {*} [fallback] 出错时的返回值
         */
        guard: guardMod,
        /** 异步版 guard：同步异常与 Promise 拒绝都拦在这条线内 */
        guardAsync: guardModAsync,
        /** 某个插件当前的错误次数（诊断用；超过 MOD_FAULT_LIMIT 会被停用） */
        faultCount: (id) => {
            const e = registry.get(id);
            return e ? (e.faultCount || 0) : 0;
        },
        faultLimit: MOD_FAULT_LIMIT,
    };

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
