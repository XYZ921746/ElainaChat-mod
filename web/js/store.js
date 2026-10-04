// 统一数据存储层：**data/ 是唯一权威存储**，localStorage 不再保存任何业务数据。
//
// ── 为什么要有这一层（2026-09 重构）────────────────────────────────────
//
// 用户实测："删除 data 分区后重新打开还是有数据"。
//
// 根因：原先有两套存储并存，而且**localStorage 才是真身**：
//   · data-sync.js 启动时先把服务端 data/store.json 灌进 localStorage；
//   · 之后每次写 localStorage 再防抖推回服务端；
//   · 服务端缺、本机有的键还会**反向补推**（data-sync.js 第 ② 步）。
// 于是删掉 data/ 后重启，localStorage 里的数据又被推回去 —— 看起来"删了还在"。
//
// 现在把关系倒过来：**内存缓存 + data/ 后端**，localStorage 完全不参与业务数据。
//
// ── 为什么用「内存缓存 + 同步读写」而不是全异步 ──────────────────────────
//
// 应用的初始化是**同步**的：theme.js 在脚本求值时就同步读主题（防首屏闪烁），
// app-07-init 里 loadSettings/loadConversations 等也是同步函数。
// 若把读改成异步，这些地方要全部改成 async 并串行 await —— 改动面极大，
// 而且主题会在启动瞬间闪一下默认色。
//
// 所以：**读永远同步命中内存缓存**，代价是启动时要有一次"填缓存"的动作。
// 这一层负责把"填缓存"这件事做到最早、最快。
//
// ── 两个后端 ────────────────────────────────────────────────────────────
//
//   Web（有本地服务）：同步 XHR 拉 GET /api/store 填缓存 —— 与旧实现同一机制，
//     零闪烁、零风险；写走防抖 POST /api/store，落 data/store.json + 分类文件。
//   APK（无本地服务）：Capacitor Filesystem 读写应用私有目录下的 store.json ——
//     那就是 APK 的 "data/"。启动时 await 一次读完（init() 是 async 的）。
//
// 对外 API 刻意与 localStorage 形似（getItem/setItem/removeItem），
// 这样替换调用点时是机械改动，不引入新的心智负担。
(function () {
    'use strict';

    // ── 哪些键算「业务数据」 ──
    // 只有列在这里的键才会被持久化。UI 临时状态（如侧栏展开）不入库，
    // 避免把一次性的界面状态写进用户的数据文件里。
    var DATA_KEYS = [
        'elaina_open_settings',          // 设置（模型/地址/开关等）
        'elainachat_open_api_secrets',   // API Key（用户选择存进 data/）
        'elaina_open_conversations',     // 聊天记录
        'elaina_open_categories',        // 分类
        'elaina_open_favorites',         // 收藏
        'elaina_open_liked_quotes',      // 喜欢的台词
        'elaina_open_character_card',    // 当前生效的角色卡（旧格式，保留兼容）
        'elaina_open_character_cards',   // 角色卡列表
        'elaina_open_current_card',      // 当前选中的角色卡 id
        'elaina_open_memory_core',       // 记忆
        'elaina_open_current_conv',      // 上次打开的对话
        'elaina_open_tasks',             // 定时任务
        'elaina_theme_template',         // 主题模板
        'elaina_theme',                  // 明暗模式
        'elaina_theme_custom',           // 自定义主题色
        'elaina_plugins_enabled',        // 插件系统总开关
        'live2d.bg',                     // Live2D 背景
        'live2d.mouseFollow',            // 鼠标跟随开关
        'live2d.mouseFollowScale',       // 鼠标跟随幅度
        // 插件页的拖拽顺序（纯 UI 偏好）。
        // ★ 不加进来会被**静默丢弃**：setItem 只对 isDataKey 为真的键入队推送，
        //   其余只写内存缓存 —— 表现为"拖完看着生效了，刷新就回去了"（实测踩到）。
        //   它不影响插件加载顺序（那个由 manifest.after 保证），只是列表怎么排。
        'elaina_mods_order',
        // 插件分栏（分组）：分栏清单 + 插件归属（见 app-06-settings.js 的 refreshModsList）
        'elaina_mods_groups',
        'elaina_mods_group_of',
        // ★ 顶层混排顺序（平铺插件与分栏的次序）。第三次踩同一个坑了 ——
        //   新增 Store 键必须同步进这份白名单，否则写入只进内存缓存，
        //   刷新即丢（"拖完看着生效了，刷新就回去了"）。以后新增键时
        //   检查脚本应盯着这个清单……见 scripts/check-store-keys.mjs（新增）。
        'elaina_mods_top_order',
        // Live2D 模型列表的拖拽顺序（同上，纯 UI 偏好）。
        'elaina_live2d_model_order'
    ];
    var DATA_SET = {};
    for (var i = 0; i < DATA_KEYS.length; i++) DATA_SET[DATA_KEYS[i]] = true;

    // 插件开关是动态键（elaina_plugin_<id>），单独按前缀放行
    function isDataKey(key) {
        if (DATA_SET[key]) return true;
        // elaina_plugin_ 后面必须有内容，且不是别的前缀碰巧匹配
        return typeof key === 'string' && /^elaina_plugin_\S+$/.test(key);
    }

    var cache = Object.create(null);     // 权威副本（内存）
    var pending = Object.create(null);   // 待推送的补丁
    var flushTimer = null;
    var backend = null;
    var bootstrapped = false;

    // 本客户端的随机标识：用于让服务端在广播时**跳过发起方自己**。
    // 每个标签页一份（模块级变量），关掉标签页就没了，不需要持久化。
    var clientId = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);

    // 变更订阅者：别的设备改了数据时通知业务层重新渲染（见 subscribeRemote）
    var changeListeners = new Set();
    // SSE 长连接（多设备实时同步）。只建一次，见 subscribeRemote。
    var eventSource = null;

    function notifyLocal(keys, patch) {
        for (var fn of changeListeners) {
            try { fn(keys, patch); } catch (e) { console.warn('[Store] 变更回调出错', e); }
        }
    }

    // ── 后端接口 ────────────────────────────────────────────────────────
    //
    // loadAll() → Promise<{key: stringValue}>    启动时读全量
    // save(patch) → Promise<void>                写增量（值 null 表示删除）
    //
    // Web 后端的 loadAll 是**同步填充**的（内部用同步 XHR），因为
    // Web 版必须在脚本求值阶段就能读到主题；APK 后端是真异步。

    function createWebBackend() {
        return {
            // 同步拉取：用同步 XHR 是**刻意**的 —— 见文件头的说明。
            // 服务端不可用（如刚启动还没就绪）时不抛错，返回空对象，
            // 应用照常以默认值启动（下次写入会把本机数据补上去）。
            loadAllSync: function () {
                try {
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', '/api/store', false);
                    xhr.send(null);
                    if (xhr.status !== 200) return null;
                    var res = JSON.parse(xhr.responseText || '{}');
                    return (res && res.data) || {};
                } catch (e) {
                    return null;
                }
            },
            save: function (patch) {
                var body = JSON.stringify({ data: patch });
                var headers = { 'Content-Type': 'application/json', 'X-Store-Client': clientId };
                // sendBeacon：刚改完设置就关页面/切后台时也能发出去。
                // ⚠️ sendBeacon **不能设自定义请求头** —— 所以这条路上不带 clientId，
                //    服务端就会把它广播回来（包括发给自己）。这是刻意的取舍：
                //    宁可多发一次（客户端按键比对后无变化就不动 UI），
                //    也不要因为丢最后一次修改而损坏数据。
                try {
                    if (navigator.sendBeacon) {
                        var blob = new Blob([body], { type: 'application/json' });
                        if (navigator.sendBeacon('/api/store', blob)) return Promise.resolve();
                    }
                } catch (e) { /* 退回 fetch */ }
                return fetch('/api/store', {
                    method: 'POST',
                    headers: headers,
                    body: body,
                    keepalive: true,
                }).catch(function () { /* 服务端没开就只留内存，下次写入再试 */ });
            },
        };
    }

    function createNativeBackend() {
        // Capacitor Filesystem：APK 的 "data/" 就是应用私有目录。
        // 用 Directory.Data 而不是 External —— 无需任何存储权限，
        // 且卸载时可随应用数据一起清理（与 Web 版删 data/ 的语义一致）。
        var FILE = 'store.json';
        var DIR = 'DATA';
        function fs() {
            return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) || null;
        }
        return {
            loadAll: function () {
                var F = fs();
                if (!F) return Promise.resolve(null);
                return F.readFile({ path: FILE, directory: DIR, encoding: 'utf8' })
                    .then(function (r) {
                        try { return JSON.parse(String(r && r.data || '{}')) || {}; } catch (e) { return {}; }
                    })
                    .catch(function () {
                        // 首次运行 / 文件不存在 —— 都是"还没有数据"，不是错误
                        return null;
                    });
            },
            save: function (patch) {
                var F = fs();
                if (!F) return Promise.resolve();
                // 文件是整份覆盖写：先合并进当前缓存再整体落盘。
                // 不做增量是因为 APK 端只有这一个进程写，不存在并发冲突，
                // 整份写反而保证文件内容与内存缓存始终一致。
                var all = Object.assign({}, cache);
                for (var k in patch) {
                    if (patch[k] === null) delete all[k];
                    else all[k] = patch[k];
                }
                return F.writeFile({
                    path: FILE, directory: DIR, encoding: 'utf8',
                    data: JSON.stringify(all),
                }).catch(function (e) {
                    console.warn('[Store] 写入失败', e);
                });
            },
        };
    }

    // ── 推送队列（与旧 data-sync.js 同策略：防抖 + pagehide 兜底）──
    function flush() {
        flushTimer = null;
        var keys = Object.keys(pending);
        if (!keys.length) return;
        var patch = pending;
        pending = Object.create(null);
        try { backend.save(patch); } catch (e) { /* 持久化失败不影响使用 */ }
    }

    function queue(key, value) {
        pending[key] = value;
        if (!flushTimer) flushTimer = setTimeout(flush, 800);
    }

    // ── 对外 API ────────────────────────────────────────────────────────

    /** 同步读。未命中返回 null（与 localStorage.getItem 一致） */
    function getItem(key) {
        return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
    }

    /** 同步写：更新缓存 + 排入推送队列 */
    function setItem(key, value) {
        var v = String(value);
        cache[key] = v;
        if (isDataKey(key)) queue(key, v);
    }

    function removeItem(key) {
        delete cache[key];
        if (isDataKey(key)) queue(key, null);
    }

    /**
     * 订阅**其它设备**的改动（多设备实时同步）。
     *
     * 做两件事：
     *   ① 开一条 SSE 长连接 /api/store/stream，收到服务端广播时把数据合进缓存；
     *   ② 合并后调用回调，让业务层重新渲染（否则数据变了、界面还是旧的）。
     *
     * ⚠️ 只在 Web 上有意义：APK 没有服务端，单设备不存在"别的设备改了"。
     *    APK 上这个函数直接返回，不建立连接。
     *
     * @param {(keys: string[]) => void} onChange 远端改动到达时调用
     */
    function subscribeRemote(onChange) {
        if (typeof onChange === 'function') changeListeners.add(onChange);
        // APK / 无 EventSource 环境：什么都不做
        if (backend === createNativeBackend() || typeof window.EventSource !== 'function') {
            return function () { changeListeners.delete(onChange); };
        }
        if (eventSource) return function () { changeListeners.delete(onChange); };

        try {
            eventSource = new window.EventSource('/api/store/stream?client=' + encodeURIComponent(clientId));
            eventSource.onmessage = function (ev) {
                var msg;
                try { msg = JSON.parse(ev.data || '{}'); } catch (e) { return; }
                if (!msg || msg.type !== 'store-change' || !msg.data) return;
                // 服务端已按 clientId 跳过发起方，这里再挡一道：
                // sendBeacon 那条路无法带 clientId，所以自己的改动也可能被推回来。
                if (msg.from && msg.from === clientId) return;

                var keys = Object.keys(msg.data);
                var changed = [];
                for (var i = 0; i < keys.length; i++) {
                    var k = keys[i];
                    var v = msg.data[k];
                    if (v === null) {
                        if (Object.prototype.hasOwnProperty.call(cache, k)) { delete cache[k]; changed.push(k); }
                    } else if (cache[k] !== v) {
                        cache[k] = v;
                        changed.push(k);
                    }
                }
                // 值没变就不惊动界面（避免自己刚改完又被自己触发的广播重渲染）
                if (changed.length) {
                    console.log('[Store] 收到其它设备的改动：' + changed.length + ' 项');
                    notifyLocal(changed, msg.data);
                }
            };
            eventSource.onerror = function () {
                // EventSource 会自己重连，这里只记一行 —— 服务端重启期间刷屏没意义。
                // （不关掉连接：浏览器原生重连比我们自己写的退避更可靠）
            };
        } catch (e) {
            console.warn('[Store] 实时同步连接失败（不影响本地读写）', e);
        }
        return function () { changeListeners.delete(onChange); };
    }

    /**
     * 启动引导：把 data/ 里的数据填进内存缓存。**必须在任何读取之前调用。**
     *
     * Web 后端是同步填充的，所以这个 Promise 在 Web 上其实立即就已就绪；
     * 写成 Promise 是为了兼容 APK（Filesystem 是异步的）。
     *
     * ★ 这里**不做** localStorage 自动迁移（2026-09 定稿）。
     *
     *   曾经有过一版"把老版本留在 localStorage 的数据自动搬进 data/"，
     *   出发点是好的（免得老用户升级后看起来数据没了），但它制造了一个
     *   更让人困惑的现象：
     *
     *     用户关掉服务 → 删掉 data/ → 重启 → **data/ 又被填满了**
     *
     *   因为那台浏览器里 localStorage 还留着旧数据，而迁移标记是这回才引入的
     *   —— 对用户来说就是"我明明删了，数据又回来了"。
     *
     *   现在的原则简单到不需要解释：**data/ 就是全部。删掉它，数据就没了。**
     *   代价是老版本用户升级后需要手动导入一次（设置 → 我的数据 → 导入备份），
     *   这个代价换来的是"删了就是删了"这个不需要任何心智模型的保证。
     */
    function bootstrap() {
        if (bootstrapped) return Promise.resolve();
        bootstrapped = true;

        var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
        backend = isNative ? createNativeBackend() : createWebBackend();

        // Web：同步填缓存（零闪烁）
        if (backend.loadAllSync) {
            var data = backend.loadAllSync();
            if (data) {
                for (var k in data) {
                    if (typeof data[k] === 'string') cache[k] = data[k];
                }
            }
            return Promise.resolve();
        }

        // APK：异步读文件
        return backend.loadAll().then(function (data) {
            if (data) {
                for (var k in data) {
                    if (typeof data[k] === 'string') cache[k] = data[k];
                }
            }
        }).catch(function () { /* 读不到就按空数据启动 */ });
    }

    /** 当前缓存快照（调试 / 迁移用） */
    function snapshot() {
        return Object.assign({}, cache);
    }

    window.Store = {
        bootstrap: bootstrap,
        getItem: getItem,
        setItem: setItem,
        removeItem: removeItem,
        /** 订阅其它设备的改动（多设备实时同步），返回取消订阅函数 */
        subscribeRemote: subscribeRemote,
        /** 本客户端的标识（服务端用它跳过发起方） */
        clientId: function () { return clientId; },
        snapshot: snapshot,
        isDataKey: isDataKey,
        DATA_KEYS: DATA_KEYS,
        // 供测试与迁移使用
        _flush: flush,
    };

    // 关页面/切后台时把待推送的补丁发出去（与旧实现一致，避免丢最后一次修改）。
    // 用可选调用：非浏览器环境（单元测试的沙箱）没有 addEventListener，
    // 不能因为这一句就让整个存储层加载失败。
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', function () {
            if (flushTimer) { clearTimeout(flushTimer); flush(); }
        });
    }
})();
