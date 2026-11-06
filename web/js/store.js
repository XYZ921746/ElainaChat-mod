// 统一数据存储层：data/ 是唯一权威存储，localStorage 不保存业务数据。
// 读同步命中内存缓存（首屏不能等异步），写走防抖落 data/；Web 走 /api/store，APK 走 Capacitor Filesystem。
(function () {
    'use strict';

    // 业务数据键白名单：只有列在这里的键才会持久化，UI 临时状态不入库。
    var DATA_KEYS = [
        'elaina_open_settings',
        'elainachat_open_api_secrets',   // API Key（用户选择存进 data/）
        'elaina_open_conversations',
        'elaina_open_categories',
        'elaina_open_favorites',
        'elaina_open_liked_quotes',      // 历史键：点赞已下线，保留只为旧数据仍能备份/同步
        'elaina_open_character_card',    // 当前生效的角色卡（旧格式，保留兼容）
        'elaina_open_character_cards',
        'elaina_open_current_card',
        'elaina_open_memory_core',
        'elaina_memory_tiers',           // 记忆分层（热/温/冷）容量设置
        'elaina_open_current_conv',
        'elaina_open_tasks',
        'elaina_theme_template',
        'elaina_theme',
        'elaina_theme_custom',
        'elaina_rd_bubble',
        'elaina_rd_texture',
        'elaina_user_profile',
        'elaina_plugins_enabled',
        'live2d.bg',
        'live2d.mouseFollow',
        'live2d.mouseFollowScale',
        'elaina_mods_order',
        'elaina_mods_groups',
        'elaina_mods_group_of',
        // 新增 Store 键必须同步进 DATA_KEYS（否则写入只进内存、刷新即丢）；清单由 check-frontend.mjs 的「Store 键白名单」用例核对。
        'elaina_mods_top_order',
        'elaina_live2d_model_order',
        'elaina_market_url',
        'elaina_achievements',
        'elaina_mod_storage',
        'elaina_announce_read'
    ];
    var DATA_SET = {};
    for (var i = 0; i < DATA_KEYS.length; i++) DATA_SET[DATA_KEYS[i]] = true;

    // 插件开关是动态键（elaina_plugin_<id>），单独按前缀放行
    function isDataKey(key) {
        if (DATA_SET[key]) return true;
        return typeof key === 'string' && /^elaina_plugin_\S+$/.test(key);
    }

    var cache = Object.create(null);     // 权威副本（内存）
    var pending = Object.create(null);   // 待推送的补丁
    var flushTimer = null;
    var backend = null;
    var backendKind = '';   // 'web' | 'native'；bootstrap 时确定，供平台判断用（不能比较对象身份）
    var bootPromise = null;   // 并发调用共享同一个启动 Promise（见 bootstrap）

    var clientId = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);

    var changeListeners = new Set();
    var eventSource = null;

    function notifyLocal(keys, patch) {
        for (var fn of changeListeners) {
            try { fn(keys, patch); } catch (e) { console.warn('[Store] 变更回调出错', e); }
        }
    }

    // 后端接口：loadAll() → {key: stringValue}；save(patch) → void（值 null 表示删除）。
    // Web 的 loadAll 同步填充（脚本求值阶段就要读到主题），APK 后端真异步。

    // 服务端拒绝写盘/超限必须让界面知道，静默吞掉会让用户以为已保存。
    function reportSaveFailed(res) {
        return res.json().catch(function () { return {}; }).then(function (info) {
            try {
                window.dispatchEvent(new CustomEvent('elaina:store-save-failed', {
                    detail: { code: (info && info.code) || '', message: (info && info.message) || ('HTTP ' + res.status) },
                }));
            } catch (e) { /* 事件派发失败不影响后续写入 */ }
            console.warn('[Store] 保存被服务端拒绝：' + ((info && info.message) || res.status));
        });
    }

    function mergeLoadedData(data) {
        if (!data) return;
        for (var k in data) {
            if (typeof data[k] === 'string') cache[k] = data[k];
        }
    }

    function createWebBackend() {
        return {
            // 同步拉取是刻意的（Web 版在脚本求值阶段就要读到主题）；服务端不可用时不抛错，返回空对象，应用以默认值启动。
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
                // sendBeacon / keepalive fetch 约 64KB 上限，超过会静默失败（大 base64 样本会让整次写入丢失），大包改走普通 fetch。
                var keepaliveOk = body.length <= 60000;
                // 小包走 sendBeacon（关页面/切后台也能发出去）；它不能设自定义头，故不带 clientId，自己的改动可能被广播回来。
                if (keepaliveOk) {
                    try {
                        if (navigator.sendBeacon) {
                            var blob = new Blob([body], { type: 'application/json' });
                            if (navigator.sendBeacon('/api/store', blob)) return Promise.resolve();
                        }
                    } catch (e) { /* 退回 fetch */ }
                }
                return fetch('/api/store', {
                    method: 'POST',
                    headers: headers,
                    body: body,
                    keepalive: keepaliveOk,
                }).then(function (res) {
                    if (res.ok) return;
                    return reportSaveFailed(res);
                }).catch(function () { /* 服务端没开就只留内存，下次写入再试 */ });
            },
        };
    }

    function createNativeBackend() {
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
                        return null;
                    });
            },
            save: function (patch) {
                var F = fs();
                if (!F) return Promise.resolve();
                // 整份覆盖写：APK 单进程无并发冲突，整份写保证文件与缓存一致。
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

    /** 把远端补丁合进缓存，并只对真正变化的键通知业务层。 */
    function applyRemotePatch(patch) {
        var keys = Object.keys(patch);
        var changed = [];
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var v = patch[k];
            if (v === null) {
                if (Object.prototype.hasOwnProperty.call(cache, k)) { delete cache[k]; changed.push(k); }
            } else if (cache[k] !== v) {
                cache[k] = v;
                changed.push(k);
            }
        }
        if (changed.length) {
            console.log('[Store] 收到其它设备的改动：' + changed.length + ' 项');
            notifyLocal(changed, patch);
        }
    }

    // 订阅其它设备的改动：开 SSE /api/store/stream，合并后回调让业务层重渲染；只在 Web 有意义，APK 单设备直接返回。
    function subscribeRemote(onChange) {
        if (typeof onChange === 'function') changeListeners.add(onChange);
        if (backendKind === 'native' || typeof window.EventSource !== 'function') {
            return function () { changeListeners.delete(onChange); };
        }
        if (eventSource) return function () { changeListeners.delete(onChange); };

        try {
            eventSource = new window.EventSource('/api/store/stream?client=' + encodeURIComponent(clientId));
            eventSource.onmessage = function (ev) {
                var msg;
                try { msg = JSON.parse(ev.data || '{}'); } catch (e) { return; }
                if (!msg || msg.type !== 'store-change' || !msg.data) return;
                // 服务端已按 clientId 跳过发起方；sendBeacon 那条路带不了 clientId，这里再挡一道。
                if (msg.from && msg.from === clientId) return;

                applyRemotePatch(msg.data);
            };
            eventSource.onerror = function () {
                // EventSource 会自己重连，这里只记一行
            };
        } catch (e) {
            console.warn('[Store] 实时同步连接失败（不影响本地读写）', e);
        }
        return function () { changeListeners.delete(onChange); };
    }

    // 启动引导：把 data/ 填进内存缓存，必须在任何读取之前调用；Web 同步完成，Promise 仅为兼容 APK。
    // 不做 localStorage 自动迁移：否则用户删掉 data/ 重启后，旧数据会从 localStorage 搬回来。
    function bootstrap() {
        // 并发调用必须等同一个启动 Promise，否则插件会在数据读回来之前启动。
        if (bootPromise) return bootPromise;

        var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
        backendKind = isNative ? 'native' : 'web';
        backend = isNative ? createNativeBackend() : createWebBackend();

        if (backend.loadAllSync) {
            mergeLoadedData(backend.loadAllSync());
            bootPromise = Promise.resolve();
        } else {
            bootPromise = backend.loadAll().then(mergeLoadedData).catch(function () { /* 读不到就按空数据启动 */ });
        }
        return bootPromise;
    }

    /** 当前缓存快照（调试 / 迁移用） */
    function snapshot() {
        return Object.assign({}, cache);
    }

    // bootstrap 是否已跑过：主题系统在缓存为空时必须跳过应用，否则会把启动快照回放好的外观拉回默认值。
    function isBooted() {
        return bootPromise !== null;
    }

    window.Store = {
        bootstrap: bootstrap,
        /** 缓存是否已填充（bootstrap 跑过即为真，哪怕读到的空数据） */
        isBooted: isBooted,
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
        _flush: flush,
    };

    // 关页面/切后台时把待推送的补丁发出去；非浏览器环境没有 addEventListener。
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', function () {
            if (flushTimer) { clearTimeout(flushTimer); flush(); }
        });
    }
})();
