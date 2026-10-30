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

    /**
     * 插件在磁盘上的**实际目录名**（已做 URL 编码，可直接拼进 URL）。
     *
     * 不能直接用 manifest.id 拼 URL：id 是**身份**（依赖匹配、资源引用），目录名是它落在
     *   磁盘的哪个文件夹，两者可以不同（打包产物名当目录名装过：目录 `elaina-avatar-1.0.0`、
     *   id `elaina-avatar`），按 id 拼会让脚本与图片全部 404。
     * 必须 encodeURIComponent：用户可以把目录改成中文或带空格；不编码时 `el.src` 读回来是
     *   已编码的串，与 `loadedScripts` 里存的未编码原串对不上 → 每次启用都重复注入脚本，
     *   插件初始化跑两遍（界面两份、事件监听挂两遍）。
     * 服务端同时给出 id 与 dir，这里优先用 dir；没有 dir 的清单回落到 id。
     */
    function modDir(manifest) {
        const d = manifest && typeof manifest.dir === 'string' ? manifest.dir.trim() : '';
        const raw = d || (manifest && manifest.id) || '';
        // 逐段编码：不能整串 encodeURIComponent（会把路径分隔符也编掉）。
        // 这里 dir 是单层目录名，但仍按 '/' 分段处理，兼容带子路径的写法。
        return String(raw).split('/').map(encodeURIComponent).join('/');
    }

    /** 插件状态：id -> { manifest, state, error, api } */
    const registry = new Map();

    /** 已注入的 <script>，避免重复注入 */
    const loadedScripts = new Set();

    /**
     * 插件服务表：name -> Map(modId -> api)。
     * 宿主用 ElainaMods.service(name) 找服务，不再写插件专有全局名（D3）。
     */
    const services = new Map();
    function registerService(modId, name, api) {
        const key = String(name || '').trim();
        if (!key) return () => {};
        if (!services.has(key)) services.set(key, new Map());
        services.get(key).set(modId, api);
        return () => {
            const m = services.get(key);
            if (!m) return;
            m.delete(modId);
            if (!m.size) services.delete(key);
        };
    }
    function findService(name) {
        const key = String(name || '').trim();
        const m = services.get(key);
        if (!m) return null;
        for (const [modId, api] of m) {
            const entry = registry.get(modId);
            if (entry && entry.state === 'ready') return api;
        }
        return null;
    }
    function removeModServices(modId) {
        for (const [key, m] of services) {
            m.delete(modId);
            if (!m.size) services.delete(key);
        }
    }

    /**
     * 第三方代码的单次时间上限。
     *
     * 脚本请求可能被服务端/系统占用拖住，初始化函数也可能返回永不 resolve 的 Promise。
     * 没有上限时前者会让整轮 loadAll 卡在一个 URL 上，后者会让「设置 → 插件」永远停在"加载中"。
     */
    const SCRIPT_LOAD_TIMEOUT_MS = 15000;
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

    /** 给一段第三方初始化代码加超时：永不 resolve 的插件不能把整轮加载挂住。 */
    function withTimeout(promise, ms, message) {
        let timer = null;
        return Promise.race([
            Promise.resolve(promise),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms);
            }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
    }

    /**
     * 解析插件清单里的相对路径。
     *
     * 为什么必须校验：manifest 是**插件作者写的**，而 `<script src>` 接受
     *   `//evil.example/x.js` 这种协议相对地址 —— 不拦的话一份清单就能把
     *   任意站点的代码拉进页面执行。同样要挡 `../`（越出插件目录）与
     *   绝对路径（写到宿主根）。已解析成 MOD_ROOT 下本插件目录的 URL 则
     *   原样放行，供 host.injectStyle(host.assetUrl(...)) 这类调用复用。
     *
     * @returns {string|null} 可用的 URL；不合法返回 null（调用方必须拒绝加载）
     */
    function resolveModAsset(manifest, rel, kind) {
        const raw = String(rel == null ? '' : rel).trim();
        const base = MOD_ROOT + modDir(manifest) + '/';
        if (!raw) return base;
        const hashIdx = raw.search(/[?#]/);
        const pathPart = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
        const suffix = hashIdx >= 0 ? raw.slice(hashIdx) : '';
        const unix = pathPart.replace(/\\/g, '/');
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(unix) || unix.startsWith('//')) {
            console.error('[Mod:' + manifest.id + '] ' + kind + ' 不能指向外部地址，已拒绝：' + raw);
            return null;
        }
        if (unix.startsWith('/')) {
            if (unix.startsWith(base)) return unix + suffix;
            console.error('[Mod:' + manifest.id + '] ' + kind + ' 必须是本插件目录内的相对路径，已拒绝：' + raw);
            return null;
        }
        const parts = unix.split('/').filter((p) => p && p !== '.');
        if (!parts.length || parts.some((p) => p === '..')) {
            console.error('[Mod:' + manifest.id + '] ' + kind + ' 路径越界或为空，已拒绝：' + raw);
            return null;
        }
        return base + parts.join('/') + suffix;
    }

    /**
     * 某个插件**最后一个被注入的脚本**的 URL。
     *
     * loadOne 按 `scripts` 顺序注入、entry 最后，所以"脚本是否已注入过"的判据
     *   就是这最后一个 URL。它必须与 loadOne 用**同一个** resolveModAsset ——
     *   两处各拼一次时（历史写法就是这样），只要 `./x.js` 这类写法被一边
     *   归一化、另一边没有，判据就会永远为假，于是每次启用都重复注入脚本，
     *   插件初始化跑两遍（两份界面、两组定时器）。
     *
     * @returns {string|null} 无脚本或路径不合法时返回 null
     */
    function lastModScriptUrl(manifest) {
        const entrySrc = manifest.entry || 'index.js';
        const extra = (Array.isArray(manifest.scripts) ? manifest.scripts : [])
            .filter((s) => typeof s === 'string' && s && s !== entrySrc);
        const last = extra.length ? extra[extra.length - 1] : entrySrc;
        return resolveModAsset(manifest, last, 'scripts');
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
    const HOST_CAPABILITIES = {
        /** 能发用户消息（走主输入框同一条链路） */
        sendUserMessage: () => typeof host().sendUserMessage === 'function',
        /** 能按消息重算会话标题（自动取名） */
        refreshAutoConversationTitle: () => typeof host().refreshAutoConversationTitle === 'function',
        /** 能渲染 Markdown / LaTeX */
        renderText: () => typeof host().renderMessageText === 'function',
        /** 有宿主弹窗（提示 / 确认） */
        dialogs: () => typeof host().showCustomAlert === 'function',
        /** 有主题系统（host.theme 可用） */
        theme: () => Boolean(host().theme),
        /** 有成就系统（host.unlock 可用） */
        achievements: () => Boolean(host().achievements),
        /** 有会话数据（host.getConversation / getMessages 可用） */
        conversations: () => Boolean(host().state),
        /** 有语音合成能力（host.speech 可用 —— TTS 是否已配置另说） */
        speech: () => Boolean(host().speech),
        /** 有语音输入能力（host.dictation 可用 —— ASR 是否已配置另说） */
        dictation: () => Boolean(host().dictation),
        /** 有本机服务端（openFolder 等需要服务端的能力才会成功） */
        localServer: () => {
            try {
                return typeof location !== 'undefined'
                    && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(String(location.hostname || ''));
            } catch (e) { return false; }
        },
    };

    /**
     * host API 的成员分组：每组要插件在 manifest 里**声明**才拿得到。
     *
     * 为什么分组而不是全给：`createHostApi` 曾经一次性给 20 多个成员，插件随手
     *   就能用上"很重的"那几个（注册主题模板、写宿主成就、绑全站拖拽内核）——
     *   而绝大多数插件一辈子用不到它们。给全部等于把这些重能力的维护成本
     *   摊到每个插件身上，也让"这个插件到底要什么"在清单里看不出来。
     *
     * 分组之后：不声明的组，对应成员**根本不在** `host` 上（不是空函数，
     *   是 undefined）—— 误用时立刻 TypeError，离调用点最近，最好查。
     *
     * 兼容：`core` 组永远给（存消息、渲染、弹窗、storage、slot…），
     *   它是插件能干活的最小集合。已有插件不需要改 manifest 就能继续跑；
     *   要额外能力时在 manifest 的 `capabilities` 里加一个字符串即可。
     */
    const HOST_API_GROUPS = {
        /** 永远提供：插件的基本生存能力 */
        core: [],
        /** 主题模板注册（host.theme / use / restore） */
        theme: ['theme'],
        /** 成就上报（host.unlock） */
        achievements: ['unlock'],
        /** 全站拖拽排序内核（host.dragSort） */
        dragSort: ['dragSort'],
        /** 在系统文件管理器里打开插件目录（host.openFolder） */
        openFolder: ['openFolder'],
    };

    /**
     * 读某个插件声明的 host API 能力组。
     *
     * 声明位置是 manifest 的 `capabilities`（数组，与 server.capabilities 同名
     * 但各管一半：这个只管前端 host API）。缺省 = 只给 core。
     * 未知组名**明确报出来**并忽略 —— 静默忽略会让插件作者以为申请到了，
     * 运行到那一步才发现 `host.theme` 是 undefined。
     */
    function declaredApiGroups(manifest, log) {
        const raw = manifest && manifest.capabilities;
        const out = new Set(['core']);
        if (raw === undefined || raw === null) return out;
        if (!Array.isArray(raw)) {
            log('error', 'manifest 的 capabilities 必须是字符串数组（可用：'
                + Object.keys(HOST_API_GROUPS).join('、') + '），本次按「只给 core」处理');
            return out;
        }
        for (const item of raw) {
            const g = String(item || '').trim();
            if (!g) continue;
            if (!Object.prototype.hasOwnProperty.call(HOST_API_GROUPS, g)) {
                log('warn', 'manifest 的 capabilities 里有未知组「' + g + '」（可用：'
                    + Object.keys(HOST_API_GROUPS).join('、') + '），已忽略');
                continue;
            }
            out.add(g);
        }
        return out;
    }

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
            ...coreHostApi(ctx),
            ...(hasGroup('openFolder') ? extras.openFolderHostApi(ctx) : {}),
            ...(hasGroup('dragSort') ? extras.dragSortHostApi(ctx) : {}),
            ...(hasGroup('theme') ? extras.themeHostApi(ctx) : {}),
            ...(hasGroup('achievements') ? extras.achievementsHostApi(ctx) : {}),
        };
    }

    /**
     * core 组：插件的基本生存能力（永远提供，不可关闭）。
     */
    function coreHostApi({ manifest, name, log, groups, lifecycle }) {
        return {
            id: name,
            manifestId: manifest.id,
            /** 插件自己的版本（历史字段，保留兼容；新代码请用 pluginVersion） */
            version: manifest.version || '0.0.0',
            /** 插件自己的版本（与 hostVersion 分开，避免把两者混用） */
            pluginVersion: manifest.version || '0.0.0',
            /** 宿主契约版本（core.js 的 ElainaHost.version），插件据此做能力判断 */
            hostVersion: String(host().version || ''),
            /**
             * 宿主停用/卸载这个插件时触发。长任务（轮询、下载）应监听它并退出；
             * 用户只是临时关掉再打开时**不会**触发（同一个 api 要能继续用）。
             */
            signal: lifecycle ? lifecycle.signal : undefined,

            /**
             * 注册一个插件服务，供宿主或其它插件按名字取用。
             * 返回取消函数；停用/卸载时宿主会自动摘掉（不必手动调）。
             */
            service(serviceName, api) {
                return registerService(manifest.id, serviceName, api);
            },

            /**
             * 取本插件资源的 URL 基址（结尾带 /）。
             *
             * 必须用它而不是自己拼 '/mods/<名字>/…'：插件**声明的 id** 与它**实际被安装成**的目录名
             *   可能不一致（曾把带版本号的 zip 名当目录名，装出 elaina-avatar-1.0.0/，写死的 URL 全部 404）。
             * 这里用的是磁盘上真实的 manifest.dir。
             *
             * 典型用法：host.assetUrl('img/p_calm.png') → '/mods/elaina-avatar/img/p_calm.png'
             */
            assetUrl(rel) {
                const url = resolveModAsset(manifest, rel, 'assetUrl');
                return url == null ? '' : url;
            },
            /** 本插件资源目录的 URL（结尾带 /），供需要自行拼路径的场合 */
            assetBase() { return MOD_ROOT + modDir(manifest) + '/'; },

            /**
             * 按**注册名 / 清单 id / 目录名**中的任意一个查找插件。
             *
             * 插件之间互相依赖时（galgame 要用 elaina-avatar 的立绘）自己拼路径是脆的：
             *   用户改了目录名、或清单 id 与注册名不一致，路径就错了。交给系统查表才稳。
             *
             *   const av = host.require('elaina-avatar');
             *   if (!av.ok) { host.error(av.reason); return; }
             *   const url = av.url('img/p_calm.png');
             */
            require(key) {
                try {
                    const found = window.ElainaMods.find(key);
                    if (!found) {
                        return {
                            ok: false,
                            reason: '找不到插件「' + key + '」。请先在「设置 → 插件」里安装并启用它。',
                        };
                    }
                    if (found.state !== 'ready') {
                        return {
                            ok: false,
                            found,
                            reason: '插件「' + key + '」当前状态是 ' + found.state
                                + '，还不能使用' + (found.entry && found.entry.error ? '：' + found.entry.error : '。'),
                        };
                    }
                    const dir = found.dir;
                    const targetManifest = (found.entry && found.entry.manifest) || { id: found.id, dir };
                    const base = MOD_ROOT + dir.split('/').map(encodeURIComponent).join('/') + '/';
                    return {
                        ok: true,
                        id: found.id,
                        dir,
                        regName: found.regName,
                        api: found.entry ? found.entry.api : null,
                        /** 取该插件的资源 URL（路径由系统按真实目录算，越界/外链一律拒绝） */
                        url: (rel) => {
                            const url = resolveModAsset(targetManifest, rel, 'require().url');
                            return url == null ? '' : url;
                        },
                        base: () => base,
                    };
                } catch (e) {
                    return { ok: false, reason: '查找插件「' + key + '」时出错：' + (e && e.message || e) };
                }
            },

            log: (...a) => log('log', ...a),
            warn: (...a) => log('warn', ...a),
            error: (...a) => log('error', ...a),

            /** 取当前会话；没有则 null */
            getConversation() {
                const st = host().state;
                if (!st) return null;
                const list = st.conversations || [];
                return list.find((c) => c.id === st.currentConversationId) || list[0] || null;
            },
            /** 取会话里的消息数组（引用，插件只读遍历） */
            getMessages() {
                const c = this.getConversation();
                return (c && Array.isArray(c.messages)) ? c.messages : [];
            },
            /** 当前是否处于某个特殊页面模式（便签/日记），插件据此决定要不要显示 */
            getUiMode() {
                const st = host().state;
                return { notes: !!(st && st.notesMode), diary: !!(st && st.diaryMode) };
            },

            /**
             * 以用户身份发一条消息。复用宿主的 handleUserInput，保证与主输入框完全同一条链路
             * （记忆、续跑、停止、语音都自动生效）。
             *
             * 必须自己构造消息**对象**：handleUserInput 签名是 `(message, conversation)`，内部读
             *   `message.text` / `message.id`；传字符串会得到 `message.text === undefined`，
             *   发出去的是**空消息**（role=user 的内容长度 0，模型什么都看不到）。
             *   主输入框那条路也是 id + role + text + timestamp 再 push 进 conversation.messages。
             */
            sendUserMessage(text) {
                try {
                    const msg = String(text || '').trim();
                    if (!msg) return false;
                    const H = host();
                    const c = this.getConversation();
                    if (!c || typeof H.sendUserMessage !== 'function' || typeof H.newId !== 'function') return false;

                    const message = {
                        id: H.newId(),
                        role: 'user',
                        text: msg,
                        timestamp: new Date().toLocaleTimeString(),
                    };
                    if (!Array.isArray(c.messages)) c.messages = [];
                    c.messages.push(message);

                    // 给会话起个名（与主输入框走同一个判据）：插件发出的消息
                    //   同样不该让标题停在"新对话"上。
                    try {
                        if (H.refreshAutoConversationTitle && H.refreshAutoConversationTitle(c)) {
                            if (H.renderFolderList) H.renderFolderList();
                            if (H.updateCurrentConversationTitle) H.updateCurrentConversationTitle();
                        }
                    } catch (e) { /* 命名失败不影响发送 */ }
                    // 让界面把新消息画出来（主输入框那条路也会 loadConversation）
                    try {
                        if (H.loadConversation) H.loadConversation(c.id);
                    } catch (e) { /* 忽略 */ }

                    H.sendUserMessage(message, c);
                    return true;
                } catch (e) { log('error', 'sendUserMessage 失败', e); return false; }
            },

            renderText(text) {
                const fn = host().renderMessageText;
                try {
                    if (fn) return fn(text);
                } catch (e) { /* 回落到纯文本 */ }
                // 回落：至少把 HTML 转义掉，避免插件直接把用户内容当 HTML 插进去
                return String(text == null ? '' : text)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            },

            /**
             * 让宿主把一段话念出来。
             *
             * 必须走宿主：用哪个 TTS 供应商、有没有配 Key、要不要日语朗读稿，都是宿主设置里的知识
             *   （见 core.js 的 ElainaHost.speech）。插件再实现一遍等于把"哪家 API、什么鉴权"复制一份。
             * 与"播放这条消息的语音"是同一条链路：会抢占正在播的、走缓存，onEnd 在播完或被取消时都会回调
             *   （插件据此收嘴型 / 恢复状态）。
             *
             * @param {string} text
             * @param {{onStart?:Function,onEnd?:Function,messageId?:string}} [opts]
             * @returns {Promise} 宿主没有语音能力时抛错，调用方自己 catch（别静默吞）
             */
            speak(text, opts) {
                const sp = host().speech;
                if (!sp || typeof sp.speak !== 'function') {
                    throw new Error('宿主没有语音合成能力');
                }
                return sp.speak(text, opts);
            },
            /** 语音是否已配置（供应商 + Key 齐全）。插件据此决定要不要给"朗读"入口 */
            speechConfigured() {
                const sp = host().speech;
                return Boolean(sp && sp.configured);
            },
            /** 停掉正在播放的语音 */
            stopSpeech() {
                const sp = host().speech;
                if (sp && typeof sp.stop === 'function') return sp.stop();
                return Promise.resolve();
            },

            /**
             * 开麦 / 结束并发送。走宿主那颗麦克风按钮的同一个动作（host.dictation），
             * 所以识别结果与主输入框走同一条链路（记忆、续跑、TTS 都自动生效）。
             *
             * @param {'start'|'stop'} [action] 缺省 = 切换（正在听就结束，否则开始）
             */
            dictate(action) {
                const d = host().dictation;
                if (!d) throw new Error('宿主没有语音输入能力');
                if (action === 'start') return d.start();
                if (action === 'stop') return d.stop();
                return d.toggle();
            },
            /** 语音输入是否已配置（供应商 + Key 齐全）。false 时插件不该给入口 */
            dictationConfigured() {
                const d = host().dictation;
                return Boolean(d && d.configured);
            },
            /** 当前语音输入状态：idle / listening / paused / thinking / error */
            dictationState() {
                const d = host().dictation;
                return d ? String(d.state || 'idle') : 'idle';
            },

            /**
             * 弹一个提示框（带标题）。
             *
             * 不让插件直接调 window.showCustomAlert：那是宿主的**内部实现**，宿主改名或改签名就会
             *   悄悄弄坏插件（这正是 host API 收窄清单要防的事）。走这里之后宿主可自由重构。
             * 没有该能力时（老宿主 / 极端环境）回落到原生 alert ——
             *   宁可弹得难看，也不要让插件的重要提示（如"重命名失败"）消失。
             */
            alert(message, title) {
                const text = String(message == null ? '' : message);
                const fn = host().showCustomAlert;
                try {
                    if (fn) return fn(text, title);
                } catch (e) { /* 回落到原生 */ }
                try { window.alert((title ? title + '\n\n' : '') + text); } catch (e) { /* 忽略 */ }
            },

            /** 弹一个确认框，返回 Promise<boolean>。同上：不要直接摸宿主内部。 */
            async confirm(message, title) {
                const text = String(message == null ? '' : message);
                const fn = host().showCustomConfirm;
                try {
                    if (fn) return Boolean(await fn(text, title));
                } catch (e) { /* 回落到原生 */ }
                try { return window.confirm((title ? title + '\n\n' : '') + text); } catch (e) { return false; }
            },

            /**
             * `host.storage`：一块**带插件命名空间**的存储，落宿主 data/。
             *
             *   const s = host.storage;
             *   s.set('seen', '2026-10-17');   // 存（值须 JSON 可序列化）
             *   s.get('seen', '');              // 读；不存在返回第二个参数
             *   s.remove('seen'); s.keys(); s.all();
             *
             * 由宿主提供：插件拿不到宿主的 Store 内部键，而自己写 localStorage 又进不了 data/
             *   （不跨设备、不进备份）。全部插件的存储收在 `elaina_mod_storage` 一个键里按 id 分区。
             * 停用插件**不会**清掉它的数据 —— 那是"关掉功能"，不是"抹掉记录"。
             */
            storage: createModStorage(manifest.id),

            /**
             * 往宿主插槽里注册一项。设置分栏 / 顶部按钮都是插槽实例。
             *
             *   const tab = host.slot('settings.tabs', {
             *       id: 'live2d', label: 'Live2D',
             *       render(container) { … },      // 可被重复调用（重新挂载时会再调）
             *   });
             *
             * 返回句柄 `{ el, dispose() }`。**通常不需要自己 dispose** —— 停用/卸载插件时 mod 系统
             * 会统一回收；只有"插件还在、但这一项不要了"时才手动调。
             *
             * @returns {{el:Element|null, dispose:Function}|null} 注册失败（插槽名写错）返回 null
             */
            slot(name, spec) { return registerSlot(manifest.id, name, spec, log); },
            /** 宿主当前提供的插槽名（mod 想探测可用扩展点时用） */
            slots() { return [...slotImpls.keys()]; },

            /**
             * 打开**另一个插件**的设置窗（按它的 id）。
             *
             * 为什么要有这个：插件之间常互相引导（"模型在另一个扩展包里管理"），
             *   若各自去摸宿主内部的登记表，就等于把宿主的实现细节当成插件 API；
             *   走这里，插件不必知道打开函数存在哪，也拿得到明确的 false
             *   （对方没装 / 没启用 / 没有设置窗）。
             *
             * @returns {boolean} 是否真的打开了
             */
            openSettings(targetId) { return openModSettings(targetId); },
            /** 目标插件有没有设置窗（插件据此决定要不要显示那颗齿轮/引导） */
            hasSettings(targetId) { return hasModSettings(targetId); },

            /**
             * 注入一份插件自己的样式表。
             *
             * 传相对路径即可（`host.injectStyle('extra.css')`），由系统按本插件真实目录拼；
             *   也可传 host.assetUrl() 的结果。外链与越界路径会被拒绝 ——
             *   一份清单/一行插件代码就能把任意站点的 CSS 拉进页面，那等同于让第三方改写整个界面。
             *
             * 停用时会**真的失效**（`disabled=true`，不重新下载），启用时恢复；
             *   与清单里 `styles` 声明的那份走同一段代码，两条路径都会回收。
             */
            injectStyle(href) {
                const url = resolveModAsset(manifest, href, 'injectStyle');
                return url == null ? null : injectStyleLink(manifest, url);
            },

            /**
             * 注册一段"动态 system 提示词"。宿主在每次构造对话消息时调用它。
             * 用注册而不是直接改：插件不该知道宿主怎么拼提示词，宿主也不该知道有哪些插件 ——
             *   注册表是唯一的耦合点。
             * 插件被停用时这段提示词会被**摘掉**（文本留着，启用时原样恢复）——
             *   不摘就会出现"关掉的插件还在影响模型行为"，看不见也想不到去查。
             */
            setPromptHint(text) {
                const t = String(text || '');
                promptHintText.set(manifest.id, t);
                promptHints.set(manifest.id, t);
                ensurePromptHintContribution(manifest.id);
            },
            clearPromptHint() {
                promptHintText.delete(manifest.id);
                promptHints.delete(manifest.id);
            },

            /**
             * 订阅宿主事件。返回取消订阅的函数。
             * 停用插件时订阅会被摘掉（回调留着，启用时再接上）—— 否则停用的插件仍在后台响应事件。
             *   返回的取消函数仍然可用（用于插件自己中途退订）。
             */
            on(event, handler) {
                if (typeof handler !== 'function') {
                    log('error', 'host.on 的第二个参数必须是函数，已忽略');
                    return () => {};
                }
                // 包一层再进总线：宿主 emit 时不需要知道某个 mod 会不会抛错，
                //   异步回调的 rejection 也不会漏成 unhandledrejection。
                const wrapped = (detail) => guardModAsync(
                    manifest.id, '事件 ' + event, () => handler(detail));
                const attach = () => {
                    if (!bus.has(event)) bus.set(event, new Set());
                    bus.get(event).add(wrapped);
                    // 'app-ready' 是"一次性、且可能已经发生过"的事件：mod 在
                    //   DOMContentLoaded 就加载，而初始化完成可能早于某个 mod 的
                    //   注册（loadAll 异步）→ 慢加载的 mod 会永远等不到这个信号。
                    //   所以订阅时若它已经发生过，立刻补调一次。
                    if (event === 'app-ready' && appReadyFired) {
                        guardModAsync(manifest.id, 'app-ready 处理', () => handler());
                    }
                };
                const detach = () => {
                    const set = bus.get(event);
                    if (set) set.delete(wrapped);
                };
                addContribution(manifest.id, {
                    activate: attach,
                    deactivate: detach,
                    dispose: detach,
                });
                return detach;
            },
            emit(event, detail) {
                // 与宿主广播走**同一条**分发路径：订阅者已在 host.on 里各自包了隔离，
                //   这里再写一份 try/catch 只会让同一个错误记两遍日志。
                dispatch(event, detail);
            },

            /**
             * `host.has(capability)` —— 宿主**声明的**能力是否可用。
             *
             * 参数是一份固定清单里的名字（见 HOST_CAPABILITIES），不是任意全局名。
             * 早期版本是 `typeof window[name] !== 'undefined'`，等于把 window 上
             * 的一切都变成了 API：插件随便写一个名字就能探到另一个
             * 插件的私有全局名，宿主也没法据这份清单做兼容性判断。名字写错时
             * 现在会明确报出来，而不是安静返回 false。
             */
            has(capability) {
                const key = String(capability || '');
                if (!Object.prototype.hasOwnProperty.call(HOST_CAPABILITIES, key)) {
                    log('warn', 'host.has 不认识的能力名「' + key + '」，可用：'
                        + Object.keys(HOST_CAPABILITIES).join('、'));
                    return false;
                }
                try { return Boolean(HOST_CAPABILITIES[key]()); } catch (e) { return false; }
            },
            /** 宿主支持的能力名清单（插件做兼容性判断时用，不必猜） */
            capabilities() { return Object.keys(HOST_CAPABILITIES); },
            /** 本插件被授予的能力组（manifest.capabilities 解析后的结果） */
            grantedGroups() { return [...groups]; },
        };
    }

    /**
     * 在系统文件管理器里打开这个插件的目录。
     *
     *   await host.openFolder();                  // 插件自己的目录
     *   await host.openFolder('models/deepseek'); // 插件目录内的一层子路径
     *
     * 由宿主代劳：路径白名单在**服务端**，插件只要说"我想开自己目录下的这个子路径"，
     *   越界与否由宿主拒绝 —— 插件不必也不该知道 `mods/` 在哪、白名单长什么样。
     * 只有本机（有服务端）能开；APK / 局域网设备会拿到明确的失败原因，
     *   插件据此给用户提示即可（不要静默）。
     *
     * @returns {Promise<{ok:boolean, path?:string, message?:string}>}
     */
    /** 插件注册的 system 提示词片段：id -> text（**当前生效**的那些） */
    const promptHints = new Map();

    /**
     * 插件声明的提示词原文：id -> text（**与启用状态无关**）。
     *
     * 为什么要与 promptHints 分开：停用插件是"把这段提示词摘下来"，
     * 而不是"忘掉插件写过什么"。启用时要能原样挂回去，所以原文留在这里。
     */
    const promptHintText = new Map();

    /**
     * 给某个 mod 挂上"提示词"这条贡献（每个 mod 只挂一次）。
     *
     * 为什么延迟登记、且只登记一条：
     *   galgame 会随场景切换反复调 setPromptHint。若每次调用都新增一条贡献，
     *   停用时会反复删同一个键（无害但白涨），而"恢复"时会按登记顺序挂回
     *   **早期那份旧文本**（最后一条只会再覆盖一次，结果是巧合而非保证）。
     *   这里只挂一条，它的 activate 永远去读当前原文。
     */
    function ensurePromptHintContribution(modId) {
        const set = contributionSet(modId);
        for (const c of set) {
            if (c.__promptHint) return;
        }
        set.add({
            __promptHint: true,
            activate() {
                if (promptHintText.has(modId)) promptHints.set(modId, promptHintText.get(modId));
            },
            deactivate() { promptHints.delete(modId); },
            dispose() { promptHints.delete(modId); promptHintText.delete(modId); },
        });
    }

    /** 简易事件总线（宿主 ↔ 插件、插件 ↔ 插件） */
    const bus = new Map();

    const settingsOpeners = new Map();

    /** 登记一个插件的设置打开函数（由 settings.modal 插槽实现调用） */
    function registerSettingsOpener(modId, openers) {
        const id = String(modId || '');
        if (!id) return;
        settingsOpeners.set(id, openers || {});
        // 兼容镜像：已安装的旧插件（如 galgame 的设置面板）会直接读这张全局表
        //   去打开别的插件的设置。宿主自己不再读它，但**不能删** —— 删了这些
        //   插件会静默失效，而它们装在本机、改不了。
        try {
            if (!window.__modSettingsOpeners) window.__modSettingsOpeners = {};
            const open = openers && openers.open;
            if (typeof open === 'function') window.__modSettingsOpeners[id] = open;
        } catch (e) { /* 忽略 */ }
    }
    /** 注销（插件停用/卸载时） */
    function unregisterSettingsOpener(modId) {
        const id = String(modId || '');
        settingsOpeners.delete(id);
        try {
            if (window.__modSettingsOpeners) delete window.__modSettingsOpeners[id];
        } catch (e) { /* 忽略 */ }
    }
    /**
     * 按插件 id 关闭设置窗。
     *
     * 为什么必须有：宿主界面的 × / 点遮罩 / Esc 都只是把弹窗藏起来，
     *   它们不经过插件的 `close`，于是 spec.onClose 永远不触发 ——
     *   插件靠它保存设置、停计时器，结果就是"关窗后改动丢失、定时器还在跑"。
     */
    function closeModSettings(modId) {
        const hit = settingsOpeners.get(String(modId || ''));
        if (!hit || typeof hit.close !== 'function') return false;
        return guardMod(modId, '关闭设置窗', () => { hit.close(); return true; }, false);
    }
    /** 按插件 id 打开设置；没有则返回 false（调用方据此回落到分栏） */
    function openModSettings(modId) {
        const hit = settingsOpeners.get(String(modId || ''));
        if (!hit || typeof hit.open !== 'function') return false;
        return guardMod(modId, '打开设置窗', () => { hit.open(); return true; }, false);
    }
    /** 该插件有没有设置窗（插件卡片据此决定要不要画齿轮） */
    function hasModSettings(modId) {
        const hit = settingsOpeners.get(String(modId || ''));
        return Boolean(hit && typeof hit.open === 'function');
    }

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

    /** 宿主挖好的插槽：插槽名 → 挂载实现 { mount(spec), note? } */
    const slotImpls = new Map();

    /** 插槽上已注册的条目：插槽名 → Map<key, entry>（entry 见 registerSlot） */
    const slotEntries = new Map();

    /** 每个 mod 的可撤销贡献：modId → Set<contribution> */
    const contributions = new Map();

    function contributionSet(modId) {
        if (!contributions.has(modId)) contributions.set(modId, new Set());
        return contributions.get(modId);
    }

    /**
     * 登记一项贡献并立即挂上。
     * @param {string} modId 归属的 mod（停用/卸载时按它整批回收）
     * @param {{activate?:Function, deactivate?:Function, dispose?:Function}} c
     */
    function addContribution(modId, c) {
        contributionSet(modId).add(c);
        try {
            if (typeof c.activate === 'function') c.activate();
        } catch (e) {
            // 挂载失败不该连累别的贡献，但必须报出来 —— 否则表现为"注册了没反应"
            console.error('[Mod:' + modId + '] 注册项挂载失败（已跳过这一项）', e);
        }
        return c;
    }

    /** 对某个 mod 的全部贡献依次执行某个动作（单项出错不影响其余） */
    function forEachContribution(modId, action) {
        const set = contributions.get(modId);
        if (!set) return;
        for (const c of [...set]) {
            try {
                if (typeof c[action] === 'function') c[action]();
            } catch (e) {
                console.error('[Mod:' + modId + '] ' + action + ' 失败（继续处理其余注册项）', e);
            }
        }
    }

    // ---- 生命周期信号（host.signal）：停用再启用**不能**发 abort（同一个 api 还要继续用，
    //      插件停了轮询就再没第二次机会恢复）；只有真正卸载/删除（dispose）才 abort ----
    const lifecycleCtl = new Map();
    /**
     * 造一个生命周期信号。
     *
     * 优先用 AbortController；环境里没有时给一个**形状相同**的最小实现 ——
     *   host.signal 是插件依赖的公开契约，不能因为"这个环境没 AbortController"
     *   就变成 undefined（插件会写 `host.signal.addEventListener(...)`）。
     */
    function makeLifecycle() {
        if (typeof AbortController === 'function') {
            const ctl = new AbortController();
            return { signal: ctl.signal, abort: () => { try { ctl.abort(); } catch (e) { /* 忽略 */ } } };
        }
        const listeners = new Set();
        const signal = {
            aborted: false,
            addEventListener(_type, fn) { if (typeof fn === 'function') listeners.add(fn); },
            removeEventListener(_type, fn) { listeners.delete(fn); },
        };
        return {
            signal,
            abort() {
                if (signal.aborted) return;
                signal.aborted = true;
                for (const fn of [...listeners]) {
                    try { fn(); } catch (e) { /* 监听者出错不影响其它监听者 */ }
                }
            },
        };
    }
    function lifecycleFor(modId) {
        if (!lifecycleCtl.has(modId)) lifecycleCtl.set(modId, makeLifecycle());
        return { signal: lifecycleCtl.get(modId).signal };
    }
    function abortLifecycle(modId) {
        const ctl = lifecycleCtl.get(modId);
        if (ctl) { try { ctl.abort(); } catch (e) { /* 忽略 */ } }
        lifecycleCtl.delete(modId);
    }

    /** 停用：摘掉贡献但保留 spec，之后还能 activate 回来 */
    function deactivateContributions(modId) { forEachContribution(modId, 'deactivate'); }
    /** 重新启用：用保留的 spec 挂回去 */
    function activateContributions(modId) { forEachContribution(modId, 'activate'); }
    /** 卸载：真删。调用后这个 mod 的贡献表被清空 */
    function disposeContributions(modId) {
        // 倒序释放：后注册的先摘，和构造顺序相反（与栈式清理一致）
        const set = contributions.get(modId);
        if (set) {
            for (const c of [...set].reverse()) {
                try { if (typeof c.dispose === 'function') c.dispose(); }
                catch (e) { console.error('[Mod:' + modId + '] 释放注册项失败', e); }
            }
        }
        contributions.delete(modId);
        // 真正卸载：告诉插件停掉长任务（停用/启用不会走到这里）
        abortLifecycle(modId);
    }

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
    function registerSlot(modId, name, spec, log) {
        const impl = slotImpls.get(name);
        if (!impl) {
            const available = [...slotImpls.keys()].join('、') || '（宿主当前没有提供任何插槽）';
            log('error', '宿主没有名为「' + name + '」的插槽，本次注册被忽略。可用插槽：' + available);
            return null;
        }
        if (!spec || typeof spec !== 'object') {
            log('error', 'host.slot(' + name + ', spec) 的 spec 必须是对象');
            return null;
        }
        // 形状校验：缺字段 / 类型不对时当场拒绝，并说清缺什么。
        // 不校验的话故障会推迟到渲染那一刻，报的是"xxx is not a function"，
        // 插件作者指不回自己的注册点。
        const bad = validateSlotSpec(name, spec, impl.spec);
        if (bad) {
            log('error', '往插槽「' + name + '」注册失败：' + bad);
            return null;
        }
        const key = modId + ':' + String(spec.id || spec.key || 'default');
        if (!slotEntries.has(name)) slotEntries.set(name, new Map());
        const table = slotEntries.get(name);
        if (table.has(key)) {
            log('warn', '插槽 ' + name + ' 上已有同名条目（' + key + '），本次注册被忽略');
            return table.get(key).handle;
        }

        const entry = { modId, name, key, spec, mounted: null, active: false };

        function mountNow() {
            if (entry.mounted) return;
            // 插槽实现由宿主写，但它会调用**插件的 render** —— 两边都可能抛，
            //   从这一层分不出是谁的错，所以只记日志、不计入插件的错误预算：
            //   插件自己的 render 在 renderItemSlot / 各插槽实现里另有计数的边界。
            const m = guardMod(modId, '插槽 ' + name + ' 挂载',
                () => impl.mount(spec, { modId, name, key, log }), null, { count: false });
            // 插槽实现可以不返回东西（例如纯粹的内部登记），那就没什么可显隐的
            entry.mounted = m || { el: null, dispose() {} };
            if (typeof entry.mounted.show === 'function') {
                guardMod(modId, '插槽 ' + name + ' 显示', () => entry.mounted.show(), null, { count: false });
            }
        }

        /**
         * 卸载挂载出来的东西，但**保留 spec 与登记行**。
         *
         * 停用走"真卸载"而不是"只藏起来"：
         *   藏着的面板会带着旧内容（延迟渲染的标记已经置位），重新启用后显示的是
         *   停用前的状态 —— 而用户在这期间可能改过设置，看到的却是过期界面。
         *   卸载后用同一份 spec 重新挂载，渲染标记也是新的，内容自然是当前的。
         */
        function unmountNow() {
            if (entry.mounted && typeof entry.mounted.dispose === 'function') {
                try { entry.mounted.dispose(); } catch (e) { /* 释放失败不该挡住状态推进 */ }
            }
            entry.mounted = null;
        }

        const handle = {
            get el() { return entry.mounted ? entry.mounted.el : null; },
            /** 每项级插槽：宿主把 spec 渲染进某个容器时，靠它判断这项要不要参与 */
            get active() { return entry.active; },
            dispose() {
                unmountNow();
                const t = slotEntries.get(name);
                if (t) t.delete(key);
            },
        };
        entry.handle = handle;
        table.set(key, entry);

        const c = {
            activate() {
                entry.active = true;
                // 每项级插槽没有"一次性的挂载"可做 —— 内容由宿主在渲染每一项时拉取
                if (impl.item === true) { if (typeof impl.refresh === 'function') safely(() => impl.refresh(modId)); return; }
                mountNow();
            },
            deactivate() {
                entry.active = false;
                if (impl.item === true) {
                    // 停用要**立刻**把已经画在界面上的东西摘掉，不能等下次重渲染 ——
                    //   否则用户关了插件，消息行里的按钮还留着（点了会报错或没反应）。
                    //   摘除方式由插槽实现决定（它知道自己的容器长什么样）。
                    if (typeof impl.cleanup === 'function') safely(() => impl.cleanup(modId));
                    return;
                }
                unmountNow();
            },
            dispose() {
                if (impl.item === true && typeof impl.cleanup === 'function') safely(() => impl.cleanup(modId));
                handle.dispose();
            },
        };
        addContribution(modId, c);
        return handle;
    }

    /**
     * 跑一小段插件提供的回调，出错只记日志（插件的问题不该中断宿主流程）。
     *
     * 插槽的 cleanup / refresh 是**插件或宿主**两边都可能写的回调，
     *   从这一层分不出责任方，故只隔离不计入插件错误预算。
     */
    function safely(fn) {
        try { fn(); } catch (e) { console.error('[Mod] 插槽回调出错（已隔离）', e); }
    }

    /**
     * 宿主渲染「每一项都要装饰」的位置时调用它（每项级插槽，`defineSlot` 里标了 `item: true`）。
     *
     * 与普通插槽的区别：普通插槽是**注册时挂载一次**（比如设置里的一个分栏）；
     * 每项级插槽是**宿主每渲染一项就问一次**（比如每条消息行的按钮）——
     * 注册时还没有消息，所以那时候什么都挂不了。
     *
     * @param {string} name  插槽名
     * @param {Element} container 宿主给 mod 的容器（mod 只往里加，别动别的）
     * @param {*} item 这一项的上下文（如 { message, conversationId }）
     */
    function renderItemSlot(name, container, item) {
        if (!container || !container.appendChild) return 0;
        const table = slotEntries.get(name);
        if (!table) return 0;
        let count = 0;
        for (const entry of table.values()) {
            if (!entry.active) continue;                 // 停用的 mod 不参与
            const render = entry.spec && entry.spec.render;
            if (typeof render !== 'function') continue;
            // 记下渲染前已有的子节点：渲染后新加进来的都算这个 mod 的，
            // 打上 data-mod 便于停用时精确摘除（不碰其它 mod 与宿主自己的东西）
            const before = new Set(container.children);
            // 每条消息都会调到这里：一处 render 抛错绝不能打断消息渲染那条核心链路。
            //   render 允许是 async（返回值是 Promise）—— 它拒绝时同样只能记在
            //   该插件名下，不能变成一条没人认领的 unhandledrejection。
            let late = null;
            const ok = guardMod(entry.modId, '插槽 ' + name + ' 渲染', () => {
                const result = render(container, item);
                if (result && typeof result.then === 'function') late = result;
                return true;
            }, false);
            if (late) guardModAsync(entry.modId, '插槽 ' + name + ' 异步渲染', () => late, undefined);
            if (!ok) {
                // 抛错前它可能已经往容器里塞了一半元素：清掉刚加的那些，
                //   否则停用时的 cleanup 只认打过标记的元素，这半截会永久残留。
                for (const child of [...container.children]) {
                    if (!before.has(child)) { try { child.remove(); } catch (e) { /* 忽略 */ } }
                }
                continue;
            }
            for (const child of container.children) {
                if (!before.has(child) && !child.hasAttribute('data-mod')) {
                    child.setAttribute('data-mod', entry.modId);
                }
            }
            count++;
        }
        return count;
    }

    /**
     * 给一组 `.mod-card` 绑定**扁平列表**的拖拽排序（宿主实现，供插件复用）。
     *
     * 与设置页插件列表那套手感一致：
     *   · 卡片改成 position:fixed 挂到 body，跟着指针走（transform 每帧更新）
     *   · 原位置留一个虚线占位块，随指针移动 —— 那就是"让出来的空白"
     *   · 其它卡片用 FLIP（先量后改再演回去）平滑换位
     *   · 松手后卡片飞回占位块；Esc / pointercancel 取消
     *
     * 几个必须做对的点：
     *   ① move/up 绑在 **document** 上，不是 grip。卡片拖拽中会被移到 body，
     *      元素搬位置时指针捕获**可能丢失**，一旦丢了卡片会僵在半空、占位块留着。
     *   ② 卡片 fixed 定位必须记住原来的屏幕位置（left/top/width/height），
     *      否则会跳到左上角。
     *   ③ 拖拽期间给 body 加类禁用文字划选，否则拖动会变成划选。
     *   ④ 只改**显示顺序**：宿主不解释 id 语义、不碰加载顺序，持久化交给调用方。
     *
     * @param {Element} container 容器（直接子元素里带 class="mod-card" 的参与排序）
     * @param {(ids:string[], container:Element)=>void} [onDone] 松手后回调（拿到新顺序）
     * @returns {Function} 解绑函数
     */
/** 按下时的几何快照：把同层其它项按"行 → 列"摊平成阅读顺序，供落点判定用。 */
function buildFlatDragSnapshot(parent, card, itemSel) {
    const others = [];
    for (const el of parent.children) {
        if (el === card || !el.matches || !el.matches(itemSel)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        others.push({ el, left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    }
    // 按"行"分组（纵向中心相近算同一行），行内按 x 排；再摊平成阅读顺序
    const rows = [];
    for (const it of others.slice().sort((a, b) => a.cy - b.cy || a.left - b.left)) {
        const row = rows.find((rw) => Math.abs(rw.cy - it.cy) <= Math.max(8, it.height / 2));
        if (row) row.items.push(it); else rows.push({ cy: it.cy, items: [it] });
    }
    rows.forEach((rw) => rw.items.sort((a, b) => a.left - b.left));
    const flat = [];
    rows.forEach((rw) => { rw.start = flat.length; rw.items.forEach((it) => flat.push(it)); });
    return { rows, flat };
}

/** 拖拽项 id：优先指定属性，否则先 data-model-name 后 data-mod-id。 */
function flatDragIdOf(el, idAttr) {
    if (idAttr) return el.getAttribute(idAttr) || '';
    return el.getAttribute('data-model-name') || el.getAttribute('data-mod-id') || '';
}

/** FLIP：改动布局前后测量，用 transform 把位移"演"回去。
 *  scope = 布局被改动的容器。跨容器搬家时对**旧容器**再调一次，
 *  两边的项都得到位移补偿（否则另一边的项会瞬移，动画"消失"）。 */
function flipDragLayout(scope, mutate, drag, itemSel, placeholderClass) {
    const items = [...scope.querySelectorAll(itemSel + ', .' + placeholderClass)];
    const first = new Map();
    for (const el of items) first.set(el, el.getBoundingClientRect());
    // 跨容器：占位块自身的旧屏幕位置也记下（它要从那里"飞"到新家）
    const phRect = drag && drag.ph ? drag.ph.getBoundingClientRect() : null;
    mutate();
    for (const [el, r] of first) {
        if (!el.isConnected) continue;
        const now = el.getBoundingClientRect();
        const dx = r.left - now.left;
        const dy = r.top - now.top;
        if (!dx && !dy) continue;
        el.style.transition = 'none';
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        requestAnimationFrame(() => {
            el.style.transition = 'transform .18s cubic-bezier(.2,.8,.3,1)';
            el.style.transform = '';
            // 动画结束后摘掉内联 transition：否则它会一直盖住 .mod-card 的
            //   hover 过渡，下一次拖拽前的悬停/换位手感就变了。
            setTimeout(() => { el.style.transition = ''; }, 220);
        });
    }
    // 占位块跨容器：从旧位置演到新位置（否则它瞬移 —— "动画消失"的观感来源）
    if (phRect && drag && drag.ph.isConnected) {
        const nowP = drag.ph.getBoundingClientRect();
        const dx = phRect.left - nowP.left;
        const dy = phRect.top - nowP.top;
        if (dx || dy) {
            drag.ph.style.transition = 'none';
            drag.ph.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
            requestAnimationFrame(() => {
                drag.ph.style.transition = 'transform .18s cubic-bezier(.2,.8,.3,1)';
                drag.ph.style.transform = '';
                setTimeout(() => { drag.ph.style.transition = ''; }, 220);
            });
        }
    }
}

/** 落点 = 卡片自身走到哪一格（按下时快照，不看实时布局）；返回占位块要插到谁之前。 */
function pickDragInsertTarget(snap, rect, card, ph) {
    if (snap && snap.rows.length) {
        // 卡片当前中心 = 按下时的矩形 + 内联 transform 的位移
        const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(card.style.transform || '');
        const dx = m ? parseFloat(m[1]) : 0;
        const dy = m ? parseFloat(m[2]) : 0;
        const cx = rect.left + rect.width / 2 + dx;
        const cy = rect.top + rect.height / 2 + dy;
        // ① 落在哪一行：取纵向最近的一行（拖到列表外也能落到首行/末行）
        let row = snap.rows[0];
        let bestD = Infinity;
        for (const rw of snap.rows) {
            const d = Math.abs(rw.cy - cy);
            if (d < bestD) { bestD = d; row = rw; }
        }
        // ② 该行里的第几列：卡片中心越过某张卡的中心才算越过它
        let col = 0;
        while (col < row.items.length && row.items[col].cx < cx) col++;
        const want = row.start + col;
        return snap.flat[want] ? snap.flat[want].el : null;
    }
    return ph.nextElementSibling;
}

/** 指针进出父容器的滞回判定（纵向 24px、横向 0）：返回本次应使用的容器。 */
function computeActiveParent(e, pr, outer, parent, lastParent, hoverBand) {
    const outsideX = e.clientX < pr.left || e.clientX > pr.right;
    let useOuter;
    if (lastParent === outer) {
        // 已在外层：只有缩回父容器边界内才回去
        useOuter = outsideX
            || !(e.clientY > pr.top + hoverBand && e.clientY < pr.bottom - hoverBand);
    } else {
        // 在父容器内：越出边界（横向任意，纵向 24px）才出去
        useOuter = outsideX || e.clientY < pr.top - hoverBand || e.clientY > pr.bottom + hoverBand;
    }
    return (useOuter && outer) ? outer : parent;
}

/** 把拖拽中的卡片从 fixed 状态放回占位块的位置，并还原被临时清掉的面板 transform。 */
function restoreDraggedCard(card, ph, parent, draggingClass, panel, panelTransform, panelFillMode) {
    const phParent = ph.parentElement || parent;
    card.style.transition = '';
    card.style.transform = '';
    card.style.transformOrigin = '';   // 别把抓取点的原点留给卡片常态
    card.style.left = '';
    card.style.top = '';
    card.style.width = '';
    card.style.height = '';
    card.classList.remove(draggingClass);
    // 回到占位块的位置（占位块在哪个容器就插回哪里）
    phParent.insertBefore(card, ph);
    ph.remove();
    document.body.classList.remove('mod-dragging-active');
    if (panel) {
        if (panelTransform && panelTransform.value) {
            panel.style.setProperty('transform', panelTransform.value, panelTransform.priority);
        } else {
            panel.style.removeProperty('transform');
        }
        if (panelFillMode && panelFillMode.value) {
            panel.style.setProperty('animation-fill-mode', panelFillMode.value, panelFillMode.priority);
        } else {
            panel.style.removeProperty('animation-fill-mode');
        }
    }
}

    function bindFlatDragSort(container, onDone, options) {
        if (!container) return () => {};
        // 可配置项：分栏（.mod-group）的拖拽也复用这套内核 —— 它的"项"是分栏
        //   而不是卡片，把手是整个分栏头而不是三条竖线。选项不给时用卡片默认值。
        const opts = options || {};
        const ITEM_SEL = opts.itemSelector || '.mod-card';
        const HANDLE_SEL = opts.handleSelector || '.mod-grip';
        const ID_ATTR = opts.idAttr || null;              // null = 自动（先 data-model-name 后 data-mod-id）
        const PLACEHOLDER_CLASS = opts.placeholderClass || 'mod-placeholder';
        const DRAGGING_CLASS = opts.draggingClass || 'mod-dragging';
        // 外层容器的项选择器（可选）：拖出父容器后，插入点候选按这个选。
        //   插件分栏场景：拖分栏到顶层时，候选要**包含平铺卡片**——否则分栏只能
        //   插到其它分栏前面，永远到不了卡片之间（"分栏拖不到卡片上面"的根因）。
        const OUTER_ITEM_SEL = opts.outerItemSelector || ITEM_SEL;
        // 顶层混排模式：项本身就在 container 顶层（分栏与卡片混排），
        //   插入点候选**始终**用 OUTER_ITEM_SEL（含两类项）—— 不需要"逃逸"判定。
        const TOP_MIXED = Boolean(opts.topLevelMixed);
        // 拖拽时挂在"项"上的类由 CSS 定义（.mod-card.mod-dragging / .mod-group.mod-dragging）
        const handlers = [];
        let drag = null;
        // 拖拽中的"项"所在的**真实父容器**（pointerdown 时确定）。
        //   不能假设调用方传的 container 就是项的父级：分栏渲染后卡片住在
        //   .mod-group-body 里，container 是更外层的 #modsList。排序范围、
        //   占位块、FLIP 测量都应限定在这一层（跨分栏的移动是上层的职责）。
        let parent = null;
        // "逃逸"容器：项被拖出父容器范围时的落脚点（outerContainer 选项）。
        //   例如卡片从分栏体拖出到 #modsList 顶层 —— 没有它，放进去的拿不出来。
        let outer = opts.outerContainer || null;

        container.querySelectorAll(HANDLE_SEL).forEach((grip) => {
            const onDown = (ev) => {
                if (drag) return;
                const card = grip.closest(ITEM_SEL);
                if (!card) return;
                // 只认主键 / 触摸：右键、中键拖动不该触发排序
                if (ev.button != null && ev.button !== 0) return;
                // 调用方否决：把手可能同时是别的控件（如分栏头还是折叠开关），
                //   canStart 返回 false 表示"这次按下不进拖拽"（调用方已自行处理语义）。
                if (typeof opts.canStart === 'function' && !opts.canStart(ev)) return;
                ev.preventDefault();
                // 记录手势是否移动过 + 起点：配合 opts.onTap 实现"没动就松手 = 单击"。
                //   preventDefault 吞掉了 click，调用方只能从这里拿单击语义。
                const downX = ev.clientX, downY = ev.clientY;
                let moved = false;

                const rect = card.getBoundingClientRect();
                // 卡片的**真实父容器**：占位块要插到卡片原来的位置，
                //   即卡片自己的 parentElement 里 —— 不能假设调用方传的 container
                //   就是卡片的父级。分栏渲染后卡片住在 .mod-group-body 里，
                //   而 container 是更外层的 #modsList；这时 insertBefore(ph, card)
                //   会抛 "not a child of this node"。
                //   排序的目标范围也跟着取真实父容器 —— 拖拽排序本来就是
                //   "在同一层里换位置"，跨分栏的移动由上层（归类拖拽）负责。
                parent = card.parentElement;
                const ph = document.createElement('div');
                ph.className = PLACEHOLDER_CLASS;
                ph.style.height = rect.height + 'px';
                parent.insertBefore(ph, card);
                // ② 卡片改成 fixed 跟随指针（记住原屏幕位置，否则会跳到左上角）
                card.style.width = rect.width + 'px';
                card.style.height = rect.height + 'px';
                card.style.left = rect.left + 'px';
                card.style.top = rect.top + 'px';
                card.classList.add(DRAGGING_CLASS);
                // 卡片留在原 DOM 里（保持 #settingsContent / #tab-mods 的 CSS 上下文），
                //   只把设置面板的 transform 临时清掉：有 transform 的祖先会成为
                //   position:fixed 的包含块，卡片就会被面板的 overflow:hidden 裁掉。
                const panel = card.closest('.modal-panel');
                const panelTransform = panel ? {
                    value: panel.style.getPropertyValue('transform'),
                    priority: panel.style.getPropertyPriority('transform'),
                } : null;
                // 面板的入场动画带 fill-mode:both，结束帧的 transform 仍是 identity matrix
                //   —— 它照样会成为 position:fixed 的包含块（卡片坐标会整体偏移）。
                //   只临时关掉 fill-mode（不要动 animation 本身）：把 animation 设成 none
                //   再还原会让浏览器从头重播一遍入场动画 —— 表现就是"拖完设置闪一下"。
                const panelFillMode = panel ? {
                    value: panel.style.getPropertyValue('animation-fill-mode'),
                    priority: panel.style.getPropertyPriority('animation-fill-mode'),
                } : null;
                if (panel) {
                    panel.style.setProperty('transform', 'none', 'important');
                    panel.style.setProperty('animation-fill-mode', 'none', 'important');
                }
                // 停掉动画后包含块可能仍有残余偏移，按实际位置校正一次。
                const fixedRect = card.getBoundingClientRect();
                const offX = rect.left - fixedRect.left;
                const offY = rect.top - fixedRect.top;
                if (offX || offY) {
                    card.style.left = (rect.left + offX) + 'px';
                    card.style.top = (rect.top + offY) + 'px';
                }
                document.body.classList.add('mod-dragging-active');
                try { grip.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }

                drag = {
                    card, ph, grip, panel, panelTransform, panelFillMode,
                    // 按下时卡片在屏幕上的位置：判断"指针是否还在原处"用（不能用占位块当前位置）
                    originRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                    // 抓取点相对卡片左上角的偏移。拖动时保持不变，
                    //   卡片才不会在按下的瞬间"跳"到指针下方（桌面图标的手感）。
                    grabDX: ev.clientX - rect.left,
                    grabDY: ev.clientY - rect.top,
                    // 上一次的落点，用于判断占位块要不要挪（否则每帧都触发 FLIP）
                    lastBefore: card,
                    swapTarget: null,
                    lastParent: null,
                    // 父容器 rect 缓存：拖动中滚动/结构不变，无需每帧重测
                    //   （每帧 getBoundingClientRect 是"经过分栏变卡"的元凶之一）。
                    prCache: null,
                };
                drag.prCache = parent.getBoundingClientRect();
                // ── 落点判据用的"按下时快照"（见 onMove 里的说明）──────────────
                drag.snap = buildFlatDragSnapshot(parent, card, ITEM_SEL);

                // 抬起感只靠阴影（CSS .mod-dragging），不改尺寸：
                //   缩放会让卡片比拖拽前大一圈，用户会以为"拖完第一张变大了"。
                setTf(0, 0);

                const onMove = (e) => {
                    if (!drag) return;
                    // 记录"动过"：移出 5px 即视为拖拽（供 onTap 判单击用）
                    if (!moved && (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5)) {
                        moved = true;
                    }
                    // 二维跟手：抓在哪就一直在哪。只写 translateY 的话横向拖动
                    //   时卡片横向不动，看起来就是"不跟手"。
                    const dx = e.clientX - rect.left - drag.grabDX;
                    const dy = e.clientY - rect.top - drag.grabDY;
                    setTf(dx, dy);

                    // ★ 读卡片现在的位置之前必须让浏览器**落一次布局**：
                    //   上面刚写了内联 transform，但同一帧内 getBoundingClientRect 返回的
                    //   可能仍是旧位置（实测：卡片中心比指针落后一帧，导致换位晚、且左右不等）。
                    void card.offsetWidth;

                    // 插入点判定分两种（都排除拖动中的项自身）：
                    //   a) TOP_MIXED 模式（项在 container 顶层混排，如分栏拖动）：
                    //      候选**始终**用 OUTER_ITEM_SEL —— 卡片与分栏同等级，
                    //      分栏可以插到任何卡片之间（用户要求）。
                    //   b) 有外层容器：指针移出父容器范围 → 占位块提升到外层；
                    //      指针回到父容器范围 → 降级回栏内。
                    //   c) 其余：候选限定在真实父容器内（普通栏内排序）。
                    // 滞回带（hysteresis）24px：进出外层用**不同的边界** ——
                    //   走出去要越出边界 24px，走回来要缩进边界内 24px。
                    //   没有滞回时指针在分栏边缘来回 1px 都会翻转 activeParent，
                    //   占位块每帧在两个容器间搬家 + FLIP 全量重测 —— 这就是
                    //   "经过分栏时明显变卡"的根因（每帧两次强制布局）。
                    const HOVER_BAND = 24;
                    if (!drag.prCache) drag.prCache = parent.getBoundingClientRect();
                    const pr = drag.prCache;
                    // 纵向滞回 24px，横向 0：列表宽屏下是**多列网格**，指针横向离开容器
                    //   通常正是想拖到别的列 / 另一个容器，多点 24px 只会让"往右拖没反应"。
                    const activeParent = computeActiveParent(e, pr, outer, parent, drag.lastParent, HOVER_BAND);

                    // 多列时按"导航顺序"找插入点：把候选排成阅读顺序（行 → 列），
                    //   落点在**当前占位**之前的第一个候选之后插。
                    //   为什么不再"命中项 A 就插到 A 前面"：那样必须把指针挪进某张卡的
                    //   左半边才会换位 —— 用户说"拖到上一个插件待的地方就该换"。改成
                    //   几何判据后，**指针进入某张卡的范围，占位块就落到那张卡原来的位置**，
                    //   被顶开的卡自己让位（FLIP 平滑移过去）。
                    //   指针在卡片左右两侧的空白里时，仍按中线归到相邻的一张 —— 不会跳。
                    // 插入点：**统一按阅读顺序**（多列时行→列，单列时就是纵向）遍历，
                    //   命中判据是"指针在它的 3/5 线之前"。
                    //
                    //   为什么是 3/5 而不是 1/2（用户要求）：中线要拖到卡片正中才会换位，
                    //   手感"按下去一半才开始动"；提前到 3/5 处，只要挪到上一张卡片的
                    //   大部分区域就已经开始让位，拖起来更跟手。
                    //   多列时先按"行"聚合（同一行内的项按 x 排序），这样换位是二维的：
                    //   指针进入某一行的范围，就是和这一行里的那张比。
                    // 落点 = **卡片自身走到哪一格**，用按下时的快照算（不看指针、不看实时布局）。
                    //   为什么按卡片而不按指针：抓取点常在左上角的把手上，与卡片中心差出半个卡宽；
                    //   按指针判时同一段指针位移在两个方向上对应的卡片位移不等（一边"太灵敏"、
                    //   一边"太钝"）。用卡片中心判，左右各走半格才换，两个方向行程一致。
                    //   为什么用快照：换位动画进行中其它卡片的 rect 会短暂交叉/重合，
                    //   拿实时 rect 判会来回跳；快照在按下那一刻固定，目标格只随卡片位移单调变化。
                    const phNext = pickDragInsertTarget(drag.snap, rect, card, drag.ph);
                    if (phNext === drag.lastBefore && activeParent === drag.lastParent) return;
                    drag.lastBefore = phNext;
                    drag.lastParent = activeParent;
                    // 跨容器搬家：旧容器也要 FLIP 补偿（否则它里面的项瞬移）
                    const oldParent = drag.ph.parentElement;
                    // 这里只用"插到目标之前"一种动作：拖动项占住目标的格子、目标顺延向后，
                    // 与"两者互换"的观感一致，且不会与内核的落位逻辑打架。
                    //   （曾经试图显式对调两个节点，结果是顺序错一步就退化成原地不动。）
                    flipDragLayout(activeParent, () => {
                        // 只把占位块插到目标之前 —— 网格里其它卡片由 FLIP 平滑让位，
                        //   连续相邻地跨格，观感就是"和旁边那张换"。
                        if (phNext && phNext !== drag.ph) activeParent.insertBefore(drag.ph, phNext);
                        else if (!phNext) activeParent.appendChild(drag.ph);
                    }, drag, ITEM_SEL, PLACEHOLDER_CLASS);
                    if (oldParent !== activeParent && oldParent !== drag.ph.parentElement) {
                        flipDragLayout(oldParent, () => { /* 占位块已搬走 —— 只补偿留在旧容器的项 */ },
                            drag, ITEM_SEL, PLACEHOLDER_CLASS);
                    }
                };

                /** 写内联 transform：只做位移，不改尺寸（抬起感由 CSS 阴影承担）。 */
                function setTf(dx, dy) {
                    const c = drag ? drag.card : card;
                    c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
                }
                const finish = (commit) => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                    document.removeEventListener('pointercancel', onCancel);
                    // 必须带上 capture:true —— removeEventListener 要求
                    //   "捕获标志 + 回调"都对得上才算同一个监听器。
                    //   漏了这个参数就摘不掉：拖拽用鼠标松手结束时（不走 Esc 分支），
                    //   那个 once 监听器会**残留**在 document 上，之后每一次 Escape
                    //   都被它拦掉 —— 用户会发现**插件设置弹窗再也关不上了**。
                    //   （once 只在它真的被触发时才自动摘除，不能指望它兜底。）
                    document.removeEventListener('keydown', onKey, { capture: true });
                    if (!drag) return;
                    const { card: c, ph, panel, panelTransform, panelFillMode } = drag;
                    // 占位块此刻可能已被"拖出分栏"搬进外层容器 —— 还原/落位
                    //   都要跟着占位块**现在的**父节点走，不能用固定的 parent。
                    const restore = () => restoreDraggedCard(c, ph, parent, DRAGGING_CLASS, panel, panelTransform, panelFillMode);
                    if (commit) {
                        // 没动过 = 单击手势：报告给调用方（它可能有"点把手"的语义，
                        //   如分栏头的单击切折叠），同时顺序没变，无需 onDone 重排。
                        if (!moved) {
                            restore();
                            if (typeof opts.onTap === 'function') opts.onTap(card);
                            drag = null;
                            return;
                        }
                        // 松手：把卡片平滑"放"到占位块上，落位后再换回文档流。
                        // 位移是相对 **left/top 基准**算的，不是相对当前位置：
                        //   卡片是 fixed + left/top=抓取时的屏幕位置，内联 transform
                        //   是相对那个基准的偏移。所以目标偏移 =
                        //   占位块位置 − 基准位置。
                        //   （不能拿"当前位置"再叠加 —— getBoundingClientRect 已经
                        //    含了 transform，再加一次就飞过头。）
                        // 不写 scale：让卡片从"抬起的 1.03"自己落回 1.0，
                        //   读起来就是"把图标放下"。
                        const target = ph.getBoundingClientRect();
                        const dx = target.left - rect.left;
                        const dy = target.top - rect.top;
                        c.style.transition = 'transform .18s cubic-bezier(.2,.8,.3,1)';
                        c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
                        setTimeout(() => {
                            restore();
                            if (typeof onDone === 'function') {
                                const ids = [...container.querySelectorAll(ITEM_SEL)].map((el) => flatDragIdOf(el, ID_ATTR));
                                onDone(ids, container);
                            }
                        }, 190);
                    } else {
                        restore();
                    }
                    drag = null;
                };
                const onUp = () => finish(true);
                const onCancel = () => finish(false);
                /**
                 * Esc 取消拖动。
                 *
                 * 为什么要抢在宿主前面：宿主在**弹窗**上也监听 Escape
                 *   （host-slots.js 的插件设置弹窗、init.js 的各种弹窗），
                 *   一条 Escape 会同时触发两个处理器 —— 用户"想取消拖动"却把整个
                 *   设置弹窗关掉了，拖拽上下文一起丢（弹窗 hidden 之后卡片测量全部落空）。
                 *
                 * 关键是**捕获阶段**（第三个参数 true）：宿主的监听器挂在
                 *   document 的冒泡阶段，我如果也挂冒泡，会按注册顺序执行 ——
                 *   宿主在打开弹窗时就注册了，一定比我早，我根本拦不住。
                 *   挂捕获阶段则在事件下行途中就先拿到它，此时
                 *   stopImmediatePropagation 能阻止同一节点上的其余监听器，
                 *   stopPropagation 阻止它继续冒泡回 document → 宿主收不到。
                 *   （拖动是一层更内层的临时状态，它先消费这个按键才对。）
                 *
                 * finish(false) 会把这个监听器摘掉，所以下一次 Esc 一切正常。
                 */
                const onKey = (e) => {
                    if (e.key !== 'Escape') return;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    e.stopPropagation();
                    finish(false);
                };

                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
                document.addEventListener('pointercancel', onCancel);
                // 捕获阶段（true）—— 见 onKey 的说明，必须抢在宿主前面消费掉 Escape
                document.addEventListener('keydown', onKey, { once: true, capture: true });
            };
            grip.addEventListener('pointerdown', onDown);
            handlers.push([grip, onDown]);
        });

        return () => { for (const [el, fn] of handlers) el.removeEventListener('pointerdown', fn); };
    }

    // 给设置页（settings.js）复用同一份实现 —— 插件列表与模型列表的拖拽
    // 本来就是同一件事。
    // 为什么必须共用：分成两份拷贝的结果就是这次踩的坑 —— 一边修了"卡片被弹窗
    //   盖住"、另一边还是坏的；手感也会悄悄分叉（一个只跟纵向、一个跟二维）。
    // 设置页在 mods.js **之前**加载，所以它只能在真正用的时候来取这个全局
    //   （那时 mods.js 早已执行完）。
    window.__elainaBindFlatDragSort = bindFlatDragSort;

    /**
     * 注入（或取回）某个 mod 的样式表，并把它登记成**可撤销贡献**。
     *
     * 为什么"清单声明的 styles"也必须走这里，而不是 loadOne 里直接建 `<link>`：
     *   不纳入可撤销作用域，插件**停用后它的 CSS 仍在生效** —— 覆盖了宿主样式、
     *   藏了某个控件，从界面上完全看不出是哪个插件干的。插件自己调 injectStyle
     *   的那条路也一样纳入。两条注入路径共用这段代码，才不会分叉成"一条能回收、一条不能"。
     *
     * 用 `disabled` 而不是删节点：重新启用时不必再走一次网络请求。
     */
    function injectStyleLink(manifest, href) {
        const url = String(href || '');
        if (!url) return null;
        // id 由 url 决定 → 清单声明的与插件 injectStyle 的同一份样式会**去重成一条**，
        // 于是"同一个插件同一份 CSS"不会出现两个 link（两个贡献项同时开关也无害）
        const id = 'mod-style-' + manifest.id + '-' + url.replace(/[^\w.-]/g, '_');
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('link');
            el.id = id;
            el.rel = 'stylesheet';
            el.href = url;
            el.setAttribute('data-mod', manifest.id);
            document.head.appendChild(el);
        }
        const link = el;
        addContribution(manifest.id, {
            activate() { link.disabled = false; },
            deactivate() { link.disabled = true; },
            dispose() { try { link.remove(); } catch (e) { /* 忽略 */ } },
        });
        return el;
    }

    /**
     * 校验一个插槽 spec 是否符合该插槽的约定。
     *
     * 为什么要有这一步：插槽的 spec 形状是**宿主挖插槽那一方**定的
     * （settings.tabs 要 `label` + `render`，header.actions 要 `onClick`…），
     * 而插件是第三方写的。形状不对时不校验，故障会推迟到渲染那一刻才炸，
     * 而且报的是 "xxx is not a function" 这种指不回注册点的错 —— 插件作者
     * 完全不知道是自己少传了字段。
     *
     * 期望的形状由 `defineSlot` 的 `spec` 描述（见 defineSlot 的说明），
     * 这里只做**通用判定**：必填、类型、id 合法性。不猜业务语义。
     *
     * @returns {string|null} 不合规的原因；null 表示通过
     */
    function validateSlotSpec(name, spec, schema) {
        const s = schema || {};
        const required = Array.isArray(s.required) ? s.required : [];
        const types = (s.types && typeof s.types === 'object') ? s.types : {};

        for (const field of required) {
            if (spec[field] === undefined || spec[field] === null || spec[field] === '') {
                return '缺少必填字段「' + field + '」（' + name + ' 需要：'
                    + required.join('、') + '）';
            }
        }
        for (const [field, want] of Object.entries(types)) {
            const v = spec[field];
            if (v === undefined || v === null) continue;   // 可选字段缺省即跳过
            const ok = want === 'function' ? typeof v === 'function'
                : want === 'string' ? typeof v === 'string'
                    : want === 'number' ? typeof v === 'number'
                        : want === 'boolean' ? typeof v === 'boolean'
                            : want === 'array' ? Array.isArray(v)
                                : true;
            if (!ok) {
                return '字段「' + field + '」应是 ' + want + '，实际是 '
                    + (Array.isArray(v) ? 'array' : typeof v);
            }
        }
        // id 会进 CSS 选择器与 data 属性，只允许安全字符（与 mod id 同口径）
        if (spec.id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(spec.id))) {
            return 'id「' + spec.id + '」不合法（字母数字开头，只含字母数字 . _ -，最长 64）';
        }
        return null;
    }

    /**
     * 宿主把一个插槽挖出来（mod 只能往**已存在**的插槽里注册）。
     *
     * 由掌握该处 DOM 的宿主代码调用（`web/js/host-slots.js` 里集中声明），
     * 而不是写在 mod 系统里 —— 插槽的 spec 约定属于"谁挖的谁解释"。
     * 这样 mod 系统本身不需要知道"设置分栏长什么样"。
     *
     * 两种形态：
     *   · **普通插槽**：提供 `mount(spec, ctx)`，mod 注册时挂载一次（设置分栏、顶部按钮…）
     *   · **每项级插槽**：标 `item: true`，不挂载；宿主每渲染一项就调
     *     `ElainaMods.renderItemSlot(name, container, item)` 把 spec 拉出来渲染
     *     （消息行按钮就属于这种 —— 注册时还没有消息可挂）。
     *     可选提供 `cleanup(modId)`（停用时立刻摘掉已画的元素）与 `refresh(modId)`（启用时补画）。
     *
     * 额外可选 `spec: { required: [...], types: { 字段: '类型' } }` 声明本插槽的
     * 必填字段与字段类型 —— 注册时据此校验，形状不对就当场拒绝并说明缺什么，
     * 而不是等到渲染时抛出指不回注册点的错误。
     */
    function defineSlot(name, impl) {
        const n = String(name || '');
        if (!n) throw new Error('插槽名不能为空');
        if (!impl) throw new Error('插槽 ' + n + ' 缺少实现');
        if (impl.item === true) {
            if (typeof impl.cleanup !== 'function') {
                // 没有 cleanup 的话"停用"就只是停止再画新的，**已经画在界面上的会留着** ——
                // 那正是本项目反复修的一类 bug，所以在挖插槽这一步就要求提供。
                throw new Error('每项级插槽 ' + n + ' 必须提供 cleanup(modId)，否则停用后界面上的残留摘不掉');
            }
        } else if (typeof impl.mount !== 'function') {
            throw new Error('插槽 ' + n + ' 必须提供 mount(spec)');
        }
        slotImpls.set(n, impl);
        return () => slotImpls.delete(n);
    }

    /** 供宿主取全部插件的提示词片段（拼进 system） */
    function collectPromptHints() {
        const out = [];
        for (const [id, text] of promptHints) {
            if (text) out.push(text);
        }
        return out;
    }

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

    /** 拓扑排序：尊重 manifest.after；检测环形依赖 */
    function sortByDependency(manifests) {
        const byId = new Map(manifests.map((m) => [m.id, m]));
        const out = [];
        const mark = new Map();   // id -> 1=访问中 2=已完成

        function visit(m, chain) {
            const st = mark.get(m.id);
            if (st === 2) return;
            if (st === 1) {
                throw new Error('插件依赖成环：' + chain.concat(m.id).join(' → '));
            }
            mark.set(m.id, 1);
            for (const dep of (Array.isArray(m.after) ? m.after : [])) {
                const d = byId.get(dep);
                if (d) visit(d, chain.concat(m.id));
            }
            mark.set(m.id, 2);
            out.push(m);
        }

        for (const m of manifests) visit(m, []);
        return out;
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
    const SCRIPT_LOAD_ATTEMPTS = 3;
    /** 每次重试前的等待（毫秒），逐次加长：给占用文件的进程一点时间松手 */
    const SCRIPT_RETRY_DELAYS = [400, 1200];

    /** 注入一个 <script>，resolve 于 load / reject 于 error（瞬时失败会重试） */
    function injectScript(src, attempt = 1) {
        if (loadedScripts.has(src)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            // 重试时必须换一个 URL：同一地址的失败结果可能已被浏览器缓存，
            // 不带新参数的话"重试"只是从缓存里再拿一次同样的失败。
            el.src = attempt > 1
                ? src + (src.includes('?') ? '&' : '?') + 'retry=' + attempt
                : src;
            el.setAttribute('data-mod-script', '1');
            // 超时即失败：服务端/系统把文件占住时，onload/onerror 可能**都不触发**。
            //   没有这道闸，整轮 loadAll 会永远停在这个 URL 上，后面的插件
            //   一个都不会加载（表现为"插件系统只加载了一半"）。
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { el.remove(); } catch (e) { /* 忽略 */ }
                reject(new Error('脚本加载超时（' + Math.round(SCRIPT_LOAD_TIMEOUT_MS / 1000)
                    + ' 秒）：' + src));
            }, SCRIPT_LOAD_TIMEOUT_MS);
            const done = (fn) => (arg) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(arg);
            };
            el.onload = done(() => { loadedScripts.add(src); resolve(); });
            el.onerror = done(() => {
                try { el.remove(); } catch (e) { /* 老浏览器没有 remove，忽略 */ }
                if (attempt >= SCRIPT_LOAD_ATTEMPTS) {
                    reject(new Error('脚本加载失败：' + src));
                    return;
                }
                const wait = SCRIPT_RETRY_DELAYS[attempt - 1] || 1200;
                console.warn('[Mod] 脚本加载失败，' + wait + 'ms 后重试（第 '
                    + (attempt + 1) + '/' + SCRIPT_LOAD_ATTEMPTS + ' 次）：' + src);
                setTimeout(() => {
                    injectScript(src, attempt + 1).then(resolve, reject);
                }, wait);
            });
            document.head.appendChild(el);
        });
    }

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

    /**
     * 清单索引：清单 id / 目录名 / 注册名 → 清单条目。
     *
     * 三种键都可能被 `after` 引用（用户改过目录名、manifest 没写 id 时，
     * 依赖方写的仍是脚本里的注册名）—— 建索引用的地方不止一处，
     * 各写一份必然漂移，收敛成一个函数。
     */
    function manifestKeyIndex(manifests) {
        const byKey = new Map();
        for (const m of manifests) {
            if (m.id) byKey.set(m.id, m);
            if (m.dir && !byKey.has(m.dir)) byKey.set(m.dir, m);
            const rn = m.dir ? regByDir.get(m.dir) : null;
            if (rn && !byKey.has(rn)) byKey.set(rn, m);
        }
        return byKey;
    }

    /**
     * 找出每个插件**不可用的前置插件**，并说明原因。
     *
     * ── 为什么要单独做这件事 ─────────────────────────────────────────────
     *
     * `sortByDependency` 对找不到的依赖是 `if (d) visit(...)` —— **静默跳过**。
     * mod 拆成独立分发后，"只装 galgame 不装 elaina-avatar"是常态，
     * 那时的表现是"Galgame 打开了但没有立绘"，控制台一声不响。
     *
     * ── 装了但**没启用**，等于不可用 ────────────────────────────────────
     *
     * 只判断"清单里有没有这个 id"会漏掉启用状态，漏判的典型日志是：
     *
     *     [Mod] 加载完成：elaina-avatar=disabled galgame=ready pet=ready
     *
     * 前置被禁用了，依赖它的两个插件却照样 ready —— 拿不到立绘而系统认为正常。
     * 所以判定必须同时看**启用状态**：
     *   · 前置不在清单里           → 原因：未安装
     *   · 前置在清单里但被禁用      → 原因：未启用（用户可以在设置里打开）
     *   · 前置自己被拦（缺它自己的前置）→ 原因：前置本身不可用（级联）
     * 三种情况给三种不同的提示，用户才知道该做什么。
     *
     * 身份判定要同时认**清单 id**、**目录名**、**注册名**：
     *   用户改了插件目录名、而 manifest 没写 id 时，清单 id 会等于目录名
     *   （如 `pet-renamed`），而依赖方 after 里写的仍是注册名 `pet`。
     *   只按清单 id 比会**误报"缺依赖"**，把好好的插件拦下来。
     *
     * @returns {Map<string, Array<{id:string, reason:string, fixable:boolean}>>}
     */
    function findMissingDeps(manifests) {
        const byKey = manifestKeyIndex(manifests);

        // 第一轮：只算"未安装 / 未启用"（不涉及级联）
        const missing = new Map();
        for (const m of manifests) {
            const deps = Array.isArray(m.after) ? m.after : [];
            const lack = [];
            for (const d of deps) {
                const target = byKey.get(d);
                if (!target) {
                    lack.push({ id: d, reason: '未安装', fixable: false });
                    continue;
                }
                // 前置存在但被禁用（或全局插件系统关着）→ 同样不可用
                if (!modsGloballyEnabled()) {
                    lack.push({ id: d, reason: '插件系统总开关已关闭', fixable: true });
                } else if (!isModEnabled(target.id, target)) {
                    lack.push({ id: d, reason: '未启用', fixable: true });
                }
            }
            if (lack.length) missing.set(m.id, lack);
        }

        // 第二轮：级联 —— 前置自己也被拦时，标成"前置本身不可用"。
        //   一遍不够（A 依赖 B、B 依赖 C），这里迭代到稳定，最多 N 轮。
        //   不这样做的后果：A 会显示"前置 B 已就绪"，而 B 其实也没起来。
        for (let round = 0; round < manifests.length; round++) {
            let changed = false;
            for (const m of manifests) {
                const lack = missing.get(m.id);
                if (!lack) continue;
                for (const item of lack) {
                    if (item.reason !== '未安装' && item.reason !== '未启用') continue;
                    const depBlocked = missing.has(item.id);
                    if (depBlocked) {
                        item.reason = '前置本身不可用（它自己也缺前置）';
                        item.fixable = false;
                        changed = true;
                    }
                }
            }
            if (!changed) break;
        }
        return missing;
    }

    /**
     * 把"前置为什么不可用"翻译成每条一句话（原因 + 可执行的下一步）。
     *
     * loadAll 的拒绝加载与 setEnabled 的拒绝启动**共用**这一份 ——
     * 两个入口各写一份必然漂移，用户在不同地方会看到两种说法。
     */
    function describeMissingDeps(missingDeps) {
        return (Array.isArray(missingDeps) ? missingDeps : []).map((d) => {
            const what = '前置插件「' + d.id + '」' + d.reason;
            if (d.reason === '未启用') {
                return what + ' —— 到「设置 → 插件」里把它的开关打开';
            }
            if (d.reason === '未安装') {
                return what + ' —— 需要先安装它（见 Releases 的扩展包）';
            }
            if (d.reason === '插件系统总开关已关闭') {
                return what + ' —— 到「设置 → 插件」打开「启用插件系统」并刷新页面';
            }
            if (d.reason === '加载失败') {
                return what + ' —— 先把它修好（它自己的卡片上写着失败原因），再回来打开本插件';
            }
            if (d.reason === '自身前置不可用') {
                return what + ' —— 先把它的前置补齐，再回来打开本插件';
            }
            return what + ' —— 请先修好那个插件';
        }).join('；');
    }

    /** 拒绝加载 / 拒绝启动时的完整说明（措辞与 describeMissingDeps 同源） */
    function refusalMessage(missingDeps) {
        return '已拒绝加载：' + describeMissingDeps(missingDeps)
            + '。（缺了前置就启动，功能只会是残缺的，所以这里直接拒绝而不是带病运行。）';
    }

    /**
     * 把**已启用插件**的前置自动带上（只写开关，不动加载）。
     *
     * 为什么放在 loadAll 里：`after` 是"没有它我就残缺"的硬声明，用户打开
     *   依赖方的那一刻就已经表达过"要完整可用"；前置停在关闭状态时，依赖方
     *   每次启动都会被拒绝，用户还得自己去猜"还差哪个开关"。
     *   这里把这种状态自动补齐 —— 加载仍按依赖序在后面统一做，
     *   顺序保证由 sortByDependency 提供。
     *
     * 只动"装了但没启用"的前置；未安装的装不出来（交给加载期按「未安装」
     *   拒绝并说明）。环依赖用 visiting 挡住（sortByDependency 只报错，不解开环）。
     */
    function pullUpPrerequisites(manifests) {
        if (!modsGloballyEnabled()) return;   // 总开关关着时一切都不加载，别动开关
        const byKey = manifestKeyIndex(manifests);
        const pulled = [];
        const visit = (m, visiting) => {
            for (const d of (Array.isArray(m.after) ? m.after : [])) {
                const dep = byKey.get(d);
                if (!dep) continue;                     // 未安装：加载期会报
                if (visiting.has(dep.id)) continue;     // 环
                visiting.add(dep.id);
                if (!isModEnabled(dep.id, dep)) {
                    setModEnabled(dep.id, true);
                    pulled.push(dep.name || dep.id);
                }
                visit(dep, visiting);                   // 前置的前置也要带上
            }
        };
        for (const m of manifests) {
            if (!isModEnabled(m.id, m)) continue;       // 依赖方自己没启用：它的前置不用拉
            visit(m, new Set([m.id]));
        }
        if (pulled.length) {
            console.log('[Mod] 已连同前置一起启用：' + [...new Set(pulled)].join('、')
                + '（依赖方是启用的，前置不该停在关闭状态）');
        }
    }

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

    /** 插件状态的**中文说明** —— 日志与设置界面共用一份，避免两处说法不一致 */
    const STATE_LABEL = {
        ready: '已加载',
        disabled: '已关闭（未启用）',
        blocked: '已拒绝加载（前置插件不可用）',
        error: '加载失败',
        pending: '加载中',
    };

    /**
     * 打印加载结果汇总。
     *
     * 为什么不直接打 `elaina-avatar=disabled galgame=ready pet=ready`：
     *   那是**机器视角的键值对**：不了解本项目的 AI（或用户本人）看到这行，
     *   既不知道 `disabled` 是好是坏，也看不出"前置没启用、依赖它的却起来了"
     *   这个关键矛盾。
     *
     *   日志是给**排查问题的人（或 AI）**看的，不是给程序看的。所以：
     *     · 先自报家门（哪个模块在说话、它负责什么）
     *     · 先给结论（几个可用、几个未启用、几个有问题）
     *     · 每个有问题的插件：名字 + 中文状态 + 具体原因 + **下一步该做什么**
     *     · 全部正常时**明确说一句**（"什么都没有"与"一切正常"视觉上无法区分）
     *
     * 格式走 window.ElainaDiag（与 server/diagnostics.mjs 同一套），
     * 这样浏览器日志与服务端日志看起来是一回事，对照着读不会错位。
     * 没有该模块时（老页面缓存）回落到等价的手写输出，不让日志消失。
     */
    function logLoadSummary(results) {
        const total = results.length;
        const ready = results.filter((e) => e.state === 'ready');
        const disabled = results.filter((e) => e.state === 'disabled');
        const broken = results.filter((e) => e.state !== 'ready' && e.state !== 'disabled');

        // 插件的中文名（显示名优先，id 附在后面备查）
        const nm = (e) => {
            const name = e.manifest.name || e.manifest.id;
            return name === e.manifest.id ? name : name + '（' + e.manifest.id + '）';
        };

        const D = window.ElainaDiag;
        if (!D) {
            console.log('[Mod] 插件加载完成：共 ' + total + ' 个，可用 ' + ready.length + ' 个'
                + (disabled.length ? '，未启用 ' + disabled.length + ' 个' : '')
                + (broken.length ? '，有问题 ' + broken.length + ' 个' : '') + '。');
            if (ready.length) console.log('[Mod]   ✔ 可用：' + ready.map(nm).join('、'));
            if (disabled.length) {
                console.log('[Mod]   ○ 未启用（这是正常的，插件默认关闭）：' + disabled.map(nm).join('、')
                    + '\n        如需使用，到「设置 → 插件」打开对应开关。');
            }
            for (const e of broken) {
                console.error('[Mod]   ✘ ' + nm(e) + '：' + (STATE_LABEL[e.state] || e.state));
                if (e.error) console.error('[Mod]     ' + e.error);
            }
            if (!broken.length && !disabled.length) console.log('[Mod]   全部正常。');
            return;
        }

        console.log('[Mod] ' + D.checklist([{
            state: broken.length ? 'bad' : 'ok',
            label: '插件加载完成：共 ' + total + ' 个，可用 ' + ready.length + ' 个'
                + (disabled.length ? '，未启用 ' + disabled.length + ' 个' : '')
                + (broken.length ? '，有问题 ' + broken.length + ' 个' : ''),
            hint: total ? '插件由 mods/ 下的扩展包提供，可在「设置 → 插件」里开关。' : undefined,
        }], '插件系统'));

        if (ready.length) {
            console.log('[Mod] ' + D.checklist([
                { state: 'ok', label: '正常工作：' + ready.map(nm).join('、') },
            ]));
        }

        // 未启用的单独成段：默认关闭是设计如此，不该和故障混在一起报警 ——
        //   否则用户会对警告脱敏，真正的问题反而被忽略。
        if (disabled.length) {
            console.log('[Mod] ' + D.checklist([
                {
                    state: 'note',
                    label: '未启用（这是正常的，插件默认关闭）：' + disabled.map(nm).join('、'),
                    hint: '如需使用，到「设置 → 插件」打开对应开关，然后刷新页面。',
                },
            ]));
        }

        for (const e of broken) {
            const label = STATE_LABEL[e.state] || e.state;
            const dep = (e.missingDeps || []).map((d) => d.id + '（' + d.reason + '）').join('、');
            console.error('[Mod] ' + D.problem({
                what: '插件「' + nm(e) + '」' + label,
                where: 'mods/' + (e.manifest.dir || e.manifest.id) + '/',
                why: e.error || (dep ? '它依赖的前置插件不可用：' + dep : '加载过程中出错'),
                how: e.state === 'blocked'
                    ? '先修好它依赖的前置插件（见上面的原因），再刷新页面。'
                    : '把这条日志（含上面的原因）整份复制出来，就是排查依据。',
            }));
        }
        if (broken.length) {
            console.error('[Mod] ' + D.summary(
                broken.map((e) => nm(e) + '：' + (STATE_LABEL[e.state] || e.state)),
                { after: '以上插件不会生效。按上面每条给出的方法处理后，刷新页面重试。' },
            ));
        } else {
            console.log('[Mod] ' + D.summary([], {
                notes: disabled.length
                    ? ['上面列出的「未启用」是正常状态，需要时到「设置 → 插件」开启即可。']
                    : ['所有插件都已正常工作。'],
            }));
        }
    }

    /** 按注册名 / 清单 id / 目录名中的任意一个查注册条目（三键都可能被 after 引用） */
    function findByKey(key) {
        const k = String(key || '');
        if (!k) return null;
        let entry = registry.get(k);
        if (!entry) {
            const dir = dirByReg.get(k);
            if (dir) entry = [...registry.values()].find((e) => (e.manifest.dir || e.manifest.id) === dir);
        }
        if (!entry) entry = [...registry.values()].find((e) => (e.manifest.dir || e.manifest.id) === k);
        return entry || null;
    }

    /**
     * 谁正在用这个插件：`after` 指向它、且已启用并加载成功（ready）的插件。
     *
     * 给"停用 / 卸载"做闸门用 —— 前置一旦被关掉/删掉，正在运行的依赖方
     *   下一轮就会以"前置不可用"被拒（界面从"好好的"变成"半残"）。
     *   所以要在动手**之前**问这里，把"谁会受影响"说给用户听。
     *
     * 只算 ready 的依赖方：停用（disabled）/ 被拒（blocked）/ 坏（error）的
     *   插件本来就没在用它，拦着不让删只会让人莫名其妙。
     *
     * @returns {Array<{id:string, name:string}>} 依赖方列表（空 = 没人在用，随便动）
     */
    function dependentsOf(id) {
        const entry = registry.get(id) || findByKey(id);
        if (!entry) return [];
        const out = [];
        for (const e of registry.values()) {
            if (e === entry) continue;
            const after = Array.isArray(e.manifest.after) ? e.manifest.after : [];
            // 三键匹配（清单 id / 目录名 / 注册名）—— 与 findByKey 同一套判据
            if (!after.some((d) => findByKey(d) === entry)) continue;
            if (e.state === 'ready' && isModEnabled(e.manifest.id, e.manifest)) {
                out.push({ id: e.manifest.id, name: e.manifest.name || e.manifest.id });
            }
        }
        return out;
    }

    /** 依赖方名单拼成「A」「B」这样的可读串（日志与弹窗共用一份措辞） */
    function dependentNames(using) {
        return (using || []).map((d) => '「' + (d.name || d.id) + '」').join('、');
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
