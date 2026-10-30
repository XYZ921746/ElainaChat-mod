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
    async function discover() {
        try {
            const res = await fetch(window.__nativeModBase
                ? '/api/plugins'
                : (MOD_ROOT + 'index.json'), { cache: 'no-store' });
            if (!res.ok) return [];
            const data = await res.json();
            // 兼容两种写法：数组，或 { plugins: [...] }（后者便于写注释字段）
            const list = Array.isArray(data) ? data : (data && Array.isArray(data.plugins) ? data.plugins : []);
            return list.filter((m) => m && typeof m.id === 'string' && m.id);
        } catch (e) {
            // 没有插件目录是**正常情况**（用户全删了），不该报错打扰
            return [];
        }
    }

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
    async function loadOne(manifest, missingDeps = []) {
        // 幂等：已经就绪的插件**不要重跑工厂**。
        //   为什么必须有这道闸：loadAll() 会被调用多次 —— 页面启动一次，
        //   多设备同步收到"插件开关变了"时还会再来一次（init.js 里那条）。
        //   没有闸门时第二次 loadOne 会照跑工厂，而 <script> 已经注入过、
        //   factory 还在 pendingRegistrations 里 —— 于是 galgame / pet 的
        //   工厂被执行第二遍：**两份界面、两组定时器、双击一样的响应**。
        //   "已经就绪"意味着初始化已经发生过。要重新出现只能靠
        //   activateContributions()（宿主侧注册项）或 mod 自己的 setEnabled，
        //   都不是重跑工厂。
        const prev = registry.get(manifest.id);
        if (prev && prev.state === 'ready') return prev;

        const entry = { manifest, state: 'pending', error: null, api: null };
        registry.set(manifest.id, entry);

        // 先看**本插件自己**要不要加载：没启用 / 插件系统总开关关着 → disabled 返回。
        //   前置的判定放在这**之后**：前置是"启动它"的前提，不是它自身的故障。
        //   一个从没启用过的插件（默认关闭的常态）不该顶着红色的
        //   「前置插件不可用」角标 —— 那是把"没开"误报成了"坏了"。
        //   「上次加载失败被自动停用」与「用户自己关的」是两种不同的关闭，
        //   必须分得开：前者要把失败原因留在卡片上（用户才知道该修什么），
        //   后者才是干干净净的"未启用"。
        //   原因从**存储**里读，不看内存的 prev：刷新后是新会话，registry 空着，
        //   只有落盘的记录还在。这就是 autoDisableBroken 必须写盘的原因。
        if (!isModEnabled(manifest.id, manifest)) {
            const fail = readModFailure(manifest.id);
            if (fail) {
                entry.state = 'error';
                entry.error = fail.error;
                entry.autoDisabled = true;
                entry.failedAt = fail.at;
            } else {
                entry.state = 'disabled';
            }
            deactivateContributions(manifest.id);
            return entry;
        }
        // 前置插件不可用 → **拒绝加载**，并给出可读原因。
        // 只打一句警告然后照样加载很糟：插件会在"依赖不在"的前提下跑起来 ——
        // 例如 galgame 拿不到 elaina-avatar 的接口，于是自己回落成"没有立绘"，
        // 用户看到的是"界面能打开但没有人物"，而设置里那个"缺依赖"角标很容易被忽略。
        // 更麻烦的是**加载顺序失去保证**：依赖可能排在它后面才加载。
        // 所以判定同时看"装没装"与"启用没启用"。"装了但没启用"等于不可用：
        //     [Mod] 加载完成：elaina-avatar=disabled galgame=ready pet=ready
        // 这行日志就是漏判的证据 —— 前置被禁用了，两个依赖方却照样 ready，
        // 拿不到立绘而系统认为正常。
        // 清单期算不出的第三种不可用在这里补上：前置**这一轮**加载失败/被拒
        //   （依赖序保证它排在前面、已经处理完）。不看这个的话，依赖方会带着
        //   坏前置以"降级模式"跑起来 —— 界面在了、人物没了，系统却认为正常。
        // 这段在"总开关"判定**之前**：总开关关着时，带前置的已启用插件要
        //   报 blocked（原因指向总开关），不带前置的直接 disabled —— 两种都要
        //   说得清"是谁拦的"。
        const lack = (missingDeps || []).slice();
        for (const d of (Array.isArray(manifest.after) ? manifest.after : [])) {
            if (lack.some((x) => x.id === d)) continue;    // 已有结论的不重复报
            const depEntry = findByKey(d);
            if (depEntry && (depEntry.state === 'error' || depEntry.state === 'blocked')) {
                lack.push({
                    id: d,
                    reason: depEntry.state === 'error' ? '加载失败' : '自身前置不可用',
                    fixable: false,
                });
            }
        }
        if (lack.length) {
            entry.state = 'blocked';
            entry.missingDeps = lack;
            // 不可用时把它之前的注册项收起来：一个"被拒绝加载"的插件
            // 不该继续占着界面入口或往提示词里加东西
            deactivateContributions(manifest.id);
            // 每条原因一句话，人（和 AI）都能读懂该做什么
            entry.error = refusalMessage(lack);
            console.error('[Mod:' + manifest.id + '] ' + entry.error);
            return entry;
        }

        if (!modsGloballyEnabled()) {
            entry.state = 'disabled';
            deactivateContributions(manifest.id);
            return entry;
        }

        try {
            // ① 样式（可选）
            //    路径由 resolveModAsset 统一校验并拼成 URL（外链 / 越界一律拒绝）。
            //    清单是**插件作者写的**，不是可信输入：`//evil.example/x.css`
            //    这种协议相对地址会让宿主自己去拉第三方样式，等于把整个界面的
            //    外观交给那个站点，所以在这里就挡掉，并让该插件加载失败。
            //    走 injectStyleLink 而不是直接建 <link>：清单声明的样式也必须
            //      纳入可撤销作用域，否则插件停用后它的 CSS 还在生效（既有 bug）。
            for (const css of (Array.isArray(manifest.styles) ? manifest.styles : [])) {
                const href = resolveModAsset(manifest, css, 'styles');
                if (!href) throw new Error('manifest.styles 里有不合法的路径（必须是本插件目录内的相对路径）：' + css);
                injectStyleLink(manifest, href);
            }

            // ② 入口脚本
            // 注入前记下"当前在加载哪个目录"：插件脚本执行时会调
            //   register(name, …)，系统据此知道**这个注册名来自哪个目录**。
            //   这是"路径由插件系统查"的关键一环 —— 见 regByDir 的说明。
            // 多脚本：manifest.scripts 列出的文件**先**注入，entry **最后**注入。
            //   为什么 entry 放最后：
            //   一个插件拆成"实现主体 / 设置面板 / 注册装配"几个文件时，
            //   装配那个文件（entry）要**调用**其它文件定义的东西 ——
            //   所以它必须在最后执行。反过来（entry 先）会让装配时
            //   Live2D 服务还是空，表现为"插件是 ready、
            //   但界面什么都没出现"，而控制台一声不响。
            //   顺序是**声明顺序**，且全部注入完成后才调 factory。
            const entrySrc = manifest.entry || 'index.js';
            const extra = Array.isArray(manifest.scripts) ? manifest.scripts : [];
            const deps = extra.filter((s) => typeof s === 'string' && s && s !== entrySrc);
            const allScripts = [...deps, entrySrc];
            loadingDir = manifest.dir || manifest.id;
            try {
                for (const one of allScripts) {
                    // 脚本路径同样来自清单：拒绝外链与 ../ 越界。否则一份
                    //   manifest 就能把任意站点的 JS 注入宿主页面并拿到 host API。
                    const src = resolveModAsset(manifest, one, 'scripts');
                    if (!src) throw new Error('脚本路径不合法（必须是本插件目录内的相对路径）：' + one);
                    await injectScript(src);
                }
            } finally {
                loadingDir = null;
            }

            // ③ 初始化：找这个插件注册的 factory。
            // 先按 manifest.id 找（常规情况），找不到就按**本目录注册了什么**找。
            //   为什么需要第二步：用户改了目录名、而 manifest 又没写 id 时，
            //   manifest.id 会等于目录名（如 pet-renamed），而脚本里注册的
            //   仍是 'pet' —— 只按 manifest.id 查会**永远查不到**，
            //   插件表现为"已加载但从不初始化"（界面毫无反应）。
            //   按目录反查就能把这条链接上，目录怎么改都不影响。
            let factory = pendingRegistrations.get(manifest.id);
            let regName = manifest.id;
            // 登记记录带着它的来源目录：注册名与目录对不上时**不能执行** ——
            //   那是"另一个插件替我登记了工厂"的唯一可见信号。
            const ownedFactory = (rec) => {
                if (!rec || typeof rec.factory !== 'function') return null;
                const ownDir = manifest.dir || manifest.id;
                if (rec.dir && rec.dir !== ownDir) {
                    console.error('[Mod:' + manifest.id + '] 注册名「' + regName + '」来自另一个目录（'
                        + rec.dir + '），已拒绝执行');
                    return null;
                }
                return rec.factory;
            };
            factory = ownedFactory(factory);
            if (typeof factory !== 'function') {
                const byDir = regByDir.get(manifest.dir || manifest.id);
                regName = byDir || regName;
                if (byDir) {
                    const rec = pendingRegistrations.get(byDir);
                    factory = ownedFactory(rec);
                    if (typeof factory === 'function') {
                        console.warn('[Mod:' + manifest.id + '] 清单 id 与注册名不一致（'
                            + manifest.id + ' ≠ ' + byDir + '），已按注册名加载'
                            + '（建议在 manifest.json 里显式写 "id": "' + byDir + '"）');
                    }
                }
            }

            if (typeof factory === 'function') {
                entry.regName = regName;
                // 生命周期信号：插件卸载/删除时 abort，插件据此停掉轮询、下载、
                //   定时器这类长任务。临时停用**不**触发（同一个 api 还要能继续用）。
                const lifecycle = lifecycleFor(manifest.id);
                // 工厂是**第三方代码的入口**：它既可能同步抛错，也可能返回一个
                //   永不 resolve 的 Promise。后者不加超时的话，这个插件会永远停在
                //   pending，整轮加载后续的插件也一起等着。
                entry.api = await withTimeout(
                    Promise.resolve().then(() => factory(createHostApi(manifest, regName, lifecycle))),
                    MOD_INIT_TIMEOUT_MS,
                    '初始化超时（' + Math.round(MOD_INIT_TIMEOUT_MS / 1000)
                        + ' 秒没有返回结果，插件可能卡在某个 await 上）');
            } else if (manifest.autoInit !== false) {
                // 没有 register 的插件：脚本加载成功即算可用（有些 mod 自带启动逻辑）
                entry.api = null;
            }
            entry.state = 'ready';
        } catch (err) {
            entry.state = 'error';
            entry.error = String((err && err.message) || err);
            // 加载失败的插件**直接停用**，并把它已经注册的东西收回去。
            // 为什么不能只是标个 error 留在那儿：一个半初始化的插件可能已经
            //   注册了插槽、注入了样式、挂上了事件订阅（工厂跑到一半抛错），
            //   这些"半成品"留在界面上会变成点了没反应的按钮 / 解释不了的
            //   样式错乱。既然它坏了，就当它没启用 —— 这也是用户看到的语义：
            //   开关关上，卡片上写着为什么。
            // 停用状态**写盘**（不是只改内存），否则刷新后又会试着加载一遍、
            //   再失败一次，形成"每次启动都报一次错"的噪音。
            autoDisableBroken(manifest.id, entry);
            console.error('[Mod:' + manifest.id + '] 加载失败（已自动停用，不影响其他插件）', err);
        }
        return entry;
    }

    /**
     * 把加载失败的插件停用，并收回它已经注册的东西。
     *
     * 只做三件事，不碰别的插件：写停用状态、收回注册项、把原因**存起来**。
     * 设置界面据此把开关显示成「关」并显示原因 —— 用户想再试一次时手动打开
     * 即可（打开会重新走一遍加载流程）。
     *
     * 失败原因必须**落盘**，不能只放在内存的 entry 上：
     *   下一次刷新是新会话，registry 是空的 —— 那时只能从存储里知道
     *   "这个插件上次是被系统停用的，原因是 X"。只记在内存的话，刷新一次
     *   就退化成普通的「未启用」，用户再也看不到为什么坏了。
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

    /** 加载全部插件 */
    async function loadAll() {
        // 原生模式：先等插件根就绪（幂等，任何触发路径都安全 ——
        //   本函数的入口不止 boot 一处，多设备同步也会再调）。
        //   不等的话首次加载会用桌面根 /mods/ 去拼 URL，APK 上全部 404。
        await awaitNativeModRoot();
        // 先打一条总览日志（console.log，会被前端日志转发带到启动窗口）。
        // 为什么必须有：插件的加载是"看不见的过程"，而"没有 mod 日志"这个现象
        // 既可能是**成功**（成功日志若走 console.log 就未必被转发到启动窗口），
        // 也可能是 **mods.js 压根没跑 / 清单读不到** —— 两者在启动窗口里长得
        // 一模一样，无法据此排查。所以无论成败都先留一条
        // "我是谁、我开始加载了、清单里有几个"的痕迹。
        const manifests = await discover();
        console.log('[Mod] 【插件系统】（提供界面扩展与功能增强）开始加载 —— '
            + '清单里发现 ' + manifests.length + ' 个插件'
            + (manifests.length ? '：' + manifests.map((m) => m.name || m.id).join('、') : ''));
        if (!manifests.length) {
            // 清单为空 = 没装任何插件，或 index.json 取不到。后者要能看出来。
            const D0 = window.ElainaDiag;
            console.warn('[Mod] ' + (D0 ? D0.problem({
                what: '没有发现任何插件',
                where: '/mods/index.json',
                why: '两种可能：① 你还没装插件（这是正常的，程序本体的文字聊天不受影响）；'
                    + '② 清单文件读不到（服务端没起来或返回了错误）。',
                how: '想加功能就到「设置 → 插件」上传扩展包；'
                    + '若你确信装过插件，请确认服务端窗口还开着，然后刷新页面。',
            }) : '插件清单为空 —— 没安装任何插件，或 /mods/index.json 读取失败'));
            return [];
        }

        // 已启用的插件先把前置带上（为什么在这里做：见 pullUpPrerequisites 的说明），
        //   再算"还缺什么" —— 拉得起来的不算缺。
        pullUpPrerequisites(manifests);

        // 先查不可用的前置插件 —— 这类插件会被**拒绝加载**（不是警告后照跑）。
        //   判定同时看"装没装"与"启用没启用"，并认清单 id / 目录名 / 注册名三种键。
        const missing = findMissingDeps(manifests);
        for (const [id, lack] of missing) {
            const D1 = window.ElainaDiag;
            const detail = lack.map((d) => '「' + d.id + '」' + d.reason).join('、');
            console.error('[Mod] ' + (D1 ? D1.problem({
                what: '插件「' + id + '」的前置插件不可用，它不会被加载',
                where: 'mods/',
                why: '它依赖 ' + detail,
                how: lack.some((d) => d.reason === '未启用')
                    ? '到「设置 → 插件」把那个前置插件的开关打开，然后刷新页面。'
                    : '先安装缺失的前置插件（见 Releases 的扩展包），再刷新页面。',
            }) : '插件「' + id + '」无法加载 —— 它依赖的前置插件不可用：' + detail));
        }

        let ordered;
        try {
            ordered = sortByDependency(manifests);
        } catch (err) {
            // 依赖成环：报错但不要全崩 —— 退化成"按声明顺序加载"
            console.error('[Mod] ' + err.message + '，退化为按声明顺序加载');
            ordered = manifests;
        }

        const results = [];
        // 顺序加载（不是并发）：插件之间可能有依赖，且顺序加载让失败定位更容易
        for (const m of ordered) {
            const lack = missing.get(m.id) || [];
            // 逐插件兜底：**一个插件出事绝不能带崩整轮加载**。
            // loadOne 内部已经用 try/catch 包住了插件自己的代码，但它前半段
            // （读 registry、处理依赖结论）不在那个 try 里。这里再兜一层，
            // 保证「第 3 个插件出意外」不会让第 4、5、6 个根本不被加载 ——
            // 那正是 AGENTS.md「失败隔离」要防的事。
            let entry;
            try {
                entry = await loadOne(m, lack);
            } catch (e) {
                const prev = registry.get(m.id);
                entry = prev || { manifest: m, state: 'error', error: null, api: null };
                entry.state = 'error';
                entry.error = '加载过程中出现未预期的错误：' + String((e && e.message) || e);
                registry.set(m.id, entry);
                // 与 loadOne 的失败路径一致：坏了就停用，别留在"半启用"状态
                autoDisableBroken(m.id, entry);
                console.error('[Mod:' + m.id + '] 加载时抛出异常（已隔离并停用，其余插件继续加载）', e);
            }
            if (!entry) entry = { manifest: m, state: 'error', error: '加载流程没有返回结果', api: null };
            // 不可用的前置也记到条目上，供设置界面显示（loadOne 已在 error 里写了原因）
            if (lack.length) entry.missingDeps = lack;
            results.push(entry);
        }

        logLoadSummary(results);
        return results;
    }

    /**
     * 把 manifest.after 声明的前置插件逐个**拉到可用**：
     *   已装但没启用 → 递归 setEnabled（连它自己的前置一起拉）；已就绪 → 跳过。
     *
     * 返回拉不起来的清单（未安装 / 加载失败 / 它自己也缺前置），
     * 调用方据此**拒绝启动**并说明原因 —— 每种原因在 refusalMessage 里都有下一步。
     *
     * visiting 挡住 after 成环时的递归（sortByDependency 只报错，不解开环）。
     *
     * @returns {Promise<Array<{id:string, reason:string, fixable:boolean}>>}
     */
    async function ensurePrerequisites(entry, visiting) {
        const lack = [];
        const after = Array.isArray(entry.manifest.after) ? entry.manifest.after : [];
        for (const d of after) {
            if (!d || typeof d !== 'string') continue;
            const depEntry = findByKey(d);
            if (!depEntry) {
                lack.push({ id: d, reason: '未安装', fixable: false });
                continue;
            }
            if (visiting.has(depEntry.manifest.id)) continue;    // 环：另一条链正在处理它
            visiting.add(depEntry.manifest.id);
            const ready = depEntry.state === 'ready'
                && isModEnabled(depEntry.manifest.id, depEntry.manifest);
            if (!ready) {
                await setEnabled(depEntry.manifest.id, true, visiting);
                const fresh = registry.get(depEntry.manifest.id);
                if (!fresh || fresh.state !== 'ready') {
                    lack.push({
                        id: d,
                        reason: fresh && fresh.state === 'error' ? '加载失败'
                            : (fresh && fresh.state === 'blocked' ? '自身前置不可用' : '不可用'),
                        fixable: false,
                    });
                }
            }
            visiting.delete(depEntry.manifest.id);
        }
        return lack;
    }

    /** 运行时启用/停用（停用只收回注册项，不卸载脚本 —— 卸载需要整页刷新） */
    /**
     * 运行时启用 / 停用。
     *
     * ⚠️ 这里有个很容易漏的点：**mod 默认是关闭的，所以它的脚本从未被注入过**
     * （loadAll 只加载"已启用"的 mod）。如果启用时只改状态和 localStorage，
     * 用户会看到开关变成"已启用"、界面却没有任何反应 —— 而且刷新后才正常，
     * 看起来像"开关坏了"。
     *
     * 所以启用时必须判断：脚本还没加载就先走一遍加载流程。
     *
     * 停用是"两步"：
     *   ① mod 自己的 setEnabled(false) —— 收起它自建的界面、停掉它的定时器
     *   ② deactivateContributions()      —— 收回它经宿主注册的东西
     *      （插槽入口、注入的样式、system 提示词、事件订阅）
     *   只有 ① 的话，host.slot 注册的设置分栏/顶部按钮、injectStyle 的样式、
     *   setPromptHint 的提示词都会**留在原地** —— 表现为"关掉了但还在起作用"。
     *
     * 已注入的脚本没法"卸载"，但停用后它不显示、不注册、不响应事件，
     *   效果上等价。真要彻底卸载得整页刷新（或删插件目录）。
     */
    async function setEnabled(id, on, visiting) {
        const entry = registry.get(id);
        if (!entry) return false;

        if (!on) {
            // 停用前先问"有谁在用我"：正在运行的依赖方存在 → **拒绝停用**。
            //   为什么拦而不是连带关掉依赖方：连带关会一次动掉用户没碰的插件
            //   （他可能只是想腾点内存，并不知道这一下会连 Galgame 一起没了）；
            //   拦下并说清"先关谁"，把顺序决定权留给用户。
            //   判定放在写开关**之前**：拒绝时存储与状态都不能被改动。
            const using = dependentsOf(id);
            if (using.length) {
                const names = dependentNames(using);
                console.error('[Mod:' + id + '] 拒绝停用：' + names
                    + ' 正在使用这个插件。如需关闭，请先关闭 ' + names + '。');
                return false;
            }
        }

        if (on) {
            // 启用前先把前置拉起来（已装未启用的自动启用并加载，递归含前置的前置）。
            //   拉不起来的：**拒绝启动** —— 开关拨回关、原因写在条目上
            //   （设置页卡片显示「前置插件不可用」角标 + 每条的下一步）。
            //   为什么不"照常启动让它自己降级"：插件的降级路径是按"前置暂时
            //   不在"写的，用户实际看到的是"功能都在、人物没有"的半残界面，
            //   而且没有任何提示告诉他差了什么。
            const lack = await ensurePrerequisites(entry, visiting || new Set([id]));
            if (lack.length) {
                setModEnabled(id, false);
                entry.state = 'blocked';
                entry.missingDeps = lack;
                entry.autoDisabled = false;
                entry.error = refusalMessage(lack);
                // 拒绝启动不是加载失败：清掉旧的失败记录，
                // 免得刷新后卡片顶出另一套（过期的）说法
                clearModFailure(id);
                deactivateContributions(id);
                console.error('[Mod:' + id + '] ' + entry.error);
                emit('mod-changed', { id, enabled: false });
                return false;
            }
        }

        setModEnabled(id, on);

        if (on) {
            // 上一次是**加载失败**吗？这决定了下面走哪条路。
            // 关键区别（这里曾经出过真 bug）：
            //   · 正常的"停用后重新启用" —— 插件**成功初始化过**，只是被关掉了。
            //     脚本已经注入、工厂已经跑完，注册项还留着 spec，所以只要
            //     activateContributions() 把宿主侧的东西挂回去即可，**绝不能重跑工厂**
            //     （重跑会得到两份界面、两组定时器）。
            //   · 上次是**初始化失败** —— 工厂没跑完，它注册的东西已经被
            //     autoDisableBroken 收回了，`entry.api` 也是空的。这时"挂回去"
            //     等于把半成品重新贴到界面上，而且状态还会被强行改成 ready ——
            //     表现为"坏插件点几次之后自己启动了"。
            //     这种必须**重新走一遍初始化**（重注入脚本 + 重跑工厂），
            //     让失败的那一步再失败一次，从而继续被拦下。
            const wasFailed = entry.state === 'error' || entry.autoDisabled === true;
            // 用户手动打开 = "我想再试一次"，先把上次的失败记录清掉：
            // 否则卡片会一直顶着旧错误，哪怕这次其实加载成功了。
            // （本次若又失败，autoDisableBroken 会重新写一条。）
            clearModFailure(id);
            entry.autoDisabled = false;
            if (entry.state === 'error') { entry.state = 'pending'; entry.error = null; }
            // 还没加载过 → 现场加载（这样开关是"立即生效"，不需要刷新页面）
            // 判据用"入口脚本是否已注入"而不是 api 是否为空：
            //   · 有些 mod 没有 register()，加载完 api 就是 null —— 用 api 判会误判成"没加载过"
            //   · 重复启用时不该重复注入脚本（<script> 会被再插一遍，mod 的初始化会跑两次）
            // 判据与 loadOne **共用同一个** lastModScriptUrl：两处各拼一次 URL 时，
            //   只要 `./x.js` 这类写法被一边归一化、另一边没有，就会永远判成"没加载过"，
            //   于是每次启用都重复注入脚本。
            const src = lastModScriptUrl(entry.manifest);
            const neverLoaded = !src || !loadedScripts.has(src);
            if (neverLoaded || wasFailed) {
                // wasFailed 时必须**把"已注入"的记录清掉**，否则 loadOne 会认为
                // 脚本已经在页面上、跳过注入 —— 而那次注入之后工厂是崩过的，
                // 重跑工厂需要脚本里那个 register() 重新登记一遍。
                // （脚本重复执行本身是安全的：它只是再次调用 register 覆盖同一个条目。）
                if (wasFailed && src) loadedScripts.delete(src);
                try {
                    await loadOne(entry.manifest);
                } catch (e) {
                    // loadOne 内部已经做了失败隔离，这里兜住它自己抛出的意外
                    const fresh = registry.get(id);
                    if (fresh) {
                        fresh.state = 'error';
                        fresh.error = String((e && e.message) || e);
                        autoDisableBroken(id, fresh);
                    }
                }
            } else {
                // 已经初始化**成功**过：用保留的 spec 把宿主侧注册项挂回去，
                // **不重跑工厂**（工厂跑第二遍会得到两份界面/两组定时器，
                // 见 loadOne 开头的闸门）。
                // 这条路径能执行，前提是 wasFailed === false —— 也就是它上一次
                // 初始化是成功的、只是被用户关掉了。所以这里把状态标回 ready 是
                // 对的：它的 api 还在、注册项的 spec 还在，挂回去就真的在跑。
                activateContributions(id);
                if (typeof entry.api?.setEnabled === 'function') {
                    // 插件自己的开关回调也走统一边界：它抛错不该影响宿主的状态推进。
                    guardModAsync(id, '插件 setEnabled(true) 回调', () => entry.api.setEnabled(true));
                }
                entry.state = 'ready';
            }
            // 注意：loadOne 会往 registry 里塞一个**新** entry 对象，
            // 所以这里必须重新取一次，不能继续用上面那个旧引用（否则读到过期的 state）
            // 状态由**加载结果**决定，不许在这里强行改写成 ready。
            //   曾经这里写的是 `if (fresh.state !== 'error') fresh.state = 'ready'` ——
            //   而加载失败的插件被 autoDisableBroken 置成了 error 之后，
            //   下一次点击时它会被上游改成 pending，于是这条判断成立、又被改成
            //   ready：坏插件点几次之后就在界面上"启动成功"了，功能还是坏的。
            //   现在只在**真的加载成功**（loadOne 返回 ready）时才保持 ready；
            //   其余一律以上一步的结论为准。
            const fresh = registry.get(id);
            if (fresh && fresh.state === 'pending') {
                // loadOne 没有把它推进到任何终态（异常路径没覆盖到）：保守当成失败
                fresh.state = 'error';
                fresh.error = fresh.error || '启用过程中没有拿到明确的加载结果';
                autoDisableBroken(id, fresh);
            }
        } else {
            if (typeof entry.api?.setEnabled === 'function') {
                guardModAsync(id, '插件 setEnabled(false) 回调', () => entry.api.setEnabled(false));
            }
            deactivateContributions(id);
            entry.state = 'disabled';
        }

        emit('mod-changed', { id, enabled: on });
        return true;
    }

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
