// 统一数据存储层：data/ 是唯一权威存储，localStorage 不保存业务数据；
// 唯一例外是服务不可用期间的写暂存（stagePatch），它只装从未成功推上服务端的补丁，重放成功即清空。
// 读同步命中内存缓存（首屏不能等异步），写走防抖落 data/；Web 与 APK 都走 /api/store（APK 走内嵌 Go 服务），
// APK 只在服务未就绪时从 store.cache.json 兜底读。
(function () {
    'use strict';

    // 业务数据键白名单：只有列在这里的键才会持久化，UI 临时状态不入库。
    var DATA_KEYS = [
        'elaina_open_settings',
        'elainachat_open_api_secrets',   // API Key（用户选择存进 data/）
        'elaina_open_conversations',
        'elaina_open_categories',
        'elaina_open_favorites',
        'elaina_open_liked_quotes',      // 点赞已移除；保留该键只为旧数据仍能备份/同步
        'elaina_open_character_card',    // 角色卡的旧格式键：仅启动时读取迁移，写入走 cards 列表与 current_card
        'elaina_open_character_cards',
        'elaina_open_current_card',
        'elaina_memory_vectors',         // 记忆/对话原文的向量索引（派生数据，可按嵌入模型重建）
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

    // 服务不可用期间的写暂存：保存失败的补丁落 localStorage，服务恢复后重放推给服务端。
    // 暂存只装「服务端拒收期间」的补丁，重放成功即清空。权威永远只有 data/ 一份，暂存是待写队列不是第二权威。
    var STAGE_KEY = 'elaina_store_stage';

    // 每个键「服务端确认过的值」：写入成功、读到权威快照、收到远端补丁时更新。
    // 暂存补丁时把当前基线一并记下，重放前才能判断这条暂存是否已经被别人超越 ——
    // 只有服务端的值仍等于基线（期间没人写过），暂存才是唯一的新值，重放才是安全的。
    var synced = Object.create(null);

    function markSynced(key, value) {
        if (value === null || value === undefined) delete synced[key];
        else synced[key] = value;
    }

    // 首帧主题快照：只有「主题呈现结果」（模板 / 深浅 / 自定义 CSS 变量），不含设置正文。
    // 它必须能在 index.html 的内联脚本里同步读到 —— 那时 Store 还没求值，读不到 data/，
    // 所以只能落在 localStorage（同步、跨进程保留）。放这里是为了让 localStorage 的访问
    // 全部收在存储层，业务代码（theme.js）只经 Store 暴露的方法。
    // 为什么不用 sessionStorage：它的寿命是「页面会话」，APK 每次冷启动都是新进程，
    // 于是手机端每次启动都读不到快照，首帧先按默认浅色渲染再切回深色（用户可见的闪烁）。
    var BOOT_THEME_KEY = 'elaina_theme_boot';

    function bootThemeSnapshotGet() {
        try { return localStorage.getItem(BOOT_THEME_KEY) || ''; } catch (e) { return ''; }
    }

    function bootThemeSnapshotSet(text) {
        try { localStorage.setItem(BOOT_THEME_KEY, String(text || '')); } catch (e) { /* 隐私模式 / 超配额：只损失首帧回放 */ }
    }

    function stagePatch(patch) {
        try {
            var staged = {};
            var base = {};
            try {
                var prev = JSON.parse(localStorage.getItem(STAGE_KEY) || 'null');
                if (prev && prev.data) { staged = prev.data || {}; base = prev.base || {}; }
            } catch (e) { staged = {}; base = {}; }
            for (var k in patch) {
                staged[k] = patch[k];
                // 基线只在第一次暂存这个键时记下：那时 synced 里还是服务端认的值。
                // 之后再暂存同一个键不能刷新基线，否则暂存期间没人写过的判断会失真。
                if (!Object.prototype.hasOwnProperty.call(base, k)) {
                    base[k] = Object.prototype.hasOwnProperty.call(synced, k) ? synced[k] : null;
                }
            }
            localStorage.setItem(STAGE_KEY, JSON.stringify({ data: staged, base: base }));
        } catch (e) { /* 隐私模式 / 超配额：只能依赖本页内存的重试 */ }
    }

    function readStaged() {
        try {
            var raw = JSON.parse(localStorage.getItem(STAGE_KEY) || 'null');
            if (!raw) return null;
            // 兼容没有 base 的旧格式：当作"基线未知"，重放时按服务端当前值判断。
            return { data: raw.data || raw, base: raw.base || {} };
        } catch (e) { return null; }
    }

    function clearStagedKeys(keys) {
        try {
            var staged = readStaged();
            if (!staged) return;
            for (var i = 0; i < keys.length; i++) { delete staged.data[keys[i]]; delete staged.base[keys[i]]; }
            if (Object.keys(staged.data).length) localStorage.setItem(STAGE_KEY, JSON.stringify(staged));
            else localStorage.removeItem(STAGE_KEY);
        } catch (e) { /* 忽略 */ }
    }

    function replayStagedPatch(base) {
        // 写闸门未解除（还没成功加载过权威快照）时不重放：暂存补丁可能在服务端拒收窗口里
        // 混入了派生自空缓存的整表值，先加载后重放。
        if (!everLoaded) return;
        var staged = readStaged();
        if (!staged) return;
        var keys = Object.keys(staged.data);
        if (!keys.length) { try { localStorage.removeItem(STAGE_KEY); } catch (e) { /* 忽略 */ } return; }

        // 先拿服务端权威值逐键比对基线，只重放「服务端仍停在基线」的键。
        // 不做这层比对时，一台设备留下的陈旧暂存会在另一台设备写入新值之后把它覆盖回去 ——
        // 暂存是"待写队列"，它比的是自己离开时的服务端，而不是别人的最新写入。
        var snapshot = null;
        try { snapshot = backend.loadAllSync(); } catch (e) { snapshot = null; }
        if (!snapshot) return;   // 读不到权威就先不重放，下次再试

        var send = {};
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var serverValue = Object.prototype.hasOwnProperty.call(snapshot, k) ? snapshot[k] : null;
            var baseValue = Object.prototype.hasOwnProperty.call(staged.base, k) ? staged.base[k] : undefined;
            // 基线未知（旧格式暂存）：服务端已有值就说明它比暂存新，丢弃。
            if (baseValue === undefined) {
                if (serverValue === null) send[k] = staged.data[k];
                else {
                    console.warn('[Store] 服务恢复后丢弃暂存键 ' + k + '：基线未知且服务端已有值');
                    clearStagedKeys([k]);
                }
                continue;
            }
            if (serverValue === baseValue) send[k] = staged.data[k];
            else {
                // 期间有人写过：暂存已过期，丢弃而不是覆盖。丢弃必须留痕 —— 这是用户可感知的
                // 数据丢失路径，无日志时排查只剩"我的改动去哪了"。
                console.warn('[Store] 服务恢复后丢弃暂存键 ' + k + '：服务端已有更新的值');
                clearStagedKeys([k]);
            }
        }
        if (!Object.keys(send).length) return;

        fetch((base || '') + '/api/store', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Store-Client': clientId },
            body: JSON.stringify({ data: send }),
        }).then(function (res) {
            if (!res.ok) return; // 服务端仍在拒绝：保留暂存，下次再试
            applyRemotePatch(send); // 本页缓存对齐到已推送的值（暂存的值此时才是最新）
            clearStagedKeys(Object.keys(send));
        }).catch(function () { /* 保留暂存，下次再试 */ });
    }

    // 写闸门：成功拿到过一次权威快照之前，任何数据键都不得写出到服务端。
    // 空缓存状态下的写入（设置对象、会话数组）派生自默认值，整表发出会覆盖服务端权威；
    // 扣留到加载成功再处理，见 markLoaded。内存读写不受影响。
    var everLoaded = false;
    var loadRetryTimer = null;

    function markLoaded(base, late) {
        if (everLoaded) return;
        everLoaded = true;
        var held = pending;
        pending = Object.create(null);
        if (Object.keys(held).length) {
            if (late) {
                // 迟到的加载说明这些补丁写于空缓存期间：整表键会以毒化快照顶掉服务端权威，
                // 丢弃比发出安全；丢弃的键会随对齐刷新回用户可见的旧值。
                console.warn('[Store] 服务恢复后丢弃了 ' + Object.keys(held).length + ' 项空缓存期间的本页改动');
            } else {
                try { backend.save(held); } catch (e) { /* 持久化失败不影响使用 */ }
            }
        }
        replayStagedPatch(base || '');
    }

    function attemptLoadRetry() {
        if (everLoaded || backendKind !== 'web' || !backend || !backend.loadAllSync) return false;
        var snapshotData = backend.loadAllSync();
        if (!snapshotData) return false;
        replaceLoadedData(snapshotData);
        markLoaded('', true);
        return true;
    }

    // 引导期读失败（服务端没起/正在重启）不放弃：按 2s/5s/10s 重试三次全量加载。
    function scheduleLoadRetry(attempt) {
        var n = attempt || 0;
        if (n >= 3 || everLoaded) return;
        if (loadRetryTimer) clearTimeout(loadRetryTimer);
        loadRetryTimer = setTimeout(function () {
            loadRetryTimer = null;
            if (everLoaded) return;
            if (!attemptLoadRetry()) scheduleLoadRetry(n + 1);
        }, [2000, 5000, 10000][n] || 10000);
    }

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
        // 权威快照到达即建立基线：这是"服务端认的值"，后续暂存重放拿它比对。
        for (var k2 in data) {
            if (isDataKey(k2) && typeof data[k2] === 'string') markSynced(k2, data[k2]);
        }
    }

    // 服务端返回的是完整权威快照：先清掉本地业务键再合并，避免删除的对话/卡片被旧缓存“复活”。
    // 非业务键（纯 UI 临时状态）不落库，保留在内存里无妨。
    function replaceLoadedData(data) {
        if (!data) return;
        for (var k in cache) {
            if (isDataKey(k)) delete cache[k];
        }
        mergeLoadedData(data);
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
                // keepalive 请求体约 64KB 上限（超限整次写入失败，大 base64 样本会让整次写入丢失），大包改走普通 fetch。
                //
                // 不用 sendBeacon：它返回 true 只表示「已入队」，浏览器可以把这条请求压到页面卸载时才真正发出
                // （实测同一页面同一时刻，beacon 十几秒未送达、keepalive fetch 半秒内落盘）。写入被压后延
                // 意味着「界面显示已保存」与「数据在盘上」之间有一段谁也不知道多长的窗口，进程被杀就是真丢。
                // keepalive fetch 同样能在关页面/切后台时发出去，而且能设 X-Store-Client（beacon 设不了，
                // 自己的改动会被 SSE 广播回来多渲染一次），失败也能进 catch 走暂存。
                var keepaliveOk = body.length <= 60000;
                return fetch('/api/store', {
                    method: 'POST',
                    headers: headers,
                    body: body,
                    keepalive: keepaliveOk,
                }).then(function (res) {
                    if (res.ok) {
                        // 写入成功即服务端认了这个值：更新基线，后续暂存重放才有得比。
                        for (var k in patch) markSynced(k, patch[k]);
                        clearStagedKeys(Object.keys(patch));
                        replayStagedPatch('');
                        return;
                    }
                    return reportSaveFailed(res);
                }).catch(function () {
                    // 服务端没开：补丁暂存到本地，恢复后重放；只留内存的话刷新即丢。
                    stagePatch(patch);
                });
            },
        };
    }

    function createNativeBackend() {
        var CACHE = 'store.cache.json';
        var LEGACY = 'store.json';
        var DIR = 'DATA';
        var SETTINGS_KEY = 'elaina_open_settings';

        function fs() {
            return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) || null;
        }

        function readText(name) {
            var F = fs();
            if (!F) return Promise.resolve(null);
            return F.readFile({ path: name, directory: DIR, encoding: 'utf8' })
                .then(function (r) { return String(r && r.data || ''); })
                .catch(function () { return null; });
        }

        function parseText(text) {
            if (!text) return null;
            try { return JSON.parse(text) || {}; } catch (e) { return null; }
        }

        // 缓存里不重复存语音样本的字节：权威那份已经在 elaina-data/main/voice-samples/ 下，
        // 服务端 Load() 会把它拼成 data URL 发过来，原样写进缓存就等于同一段音频在设备上存两遍
        // （而且 base64 比原始 wav 还大三分之一，2.9MB 的样本变成 3.8MB）。
        // 缓存只是「服务没起来时先把界面画出来」的兜底，样本读不到时最坏结果是用户重新上传一次，
        // 不值得为它多占几 MB。写入时换成占位符，读回来时再从磁盘还原。
        var VOICE_SAMPLE_FIELD = 'mimoTtsCloneSample';
        var VOICE_SAMPLE_SLOT = 'mimo-clone';
        var VOICE_SAMPLE_MARK = 'file:' + VOICE_SAMPLE_SLOT;
        // 只对明显偏大的样本做替换：内置小样本留在缓存里反而更稳（不依赖磁盘布局）。
        var VOICE_SAMPLE_CACHE_LIMIT = 64 * 1024;

        function voiceSamplePath(ext) {
            return 'elaina-data/main/voice-samples/' + VOICE_SAMPLE_SLOT + ext;
        }

        /** 把设置包里的超大样本换成 file: 引用；解析不出设置包就原样返回。 */
        function stripVoiceSample(data) {
            if (!data || typeof data[SETTINGS_KEY] !== 'string') return data;
            var settings;
            try { settings = JSON.parse(data[SETTINGS_KEY]); } catch (e) { return data; }
            if (!settings || typeof settings !== 'object') return data;
            var sample = settings[VOICE_SAMPLE_FIELD];
            if (typeof sample !== 'string' || sample.length <= VOICE_SAMPLE_CACHE_LIMIT) return data;
            settings[VOICE_SAMPLE_FIELD] = VOICE_SAMPLE_MARK;
            var out = {};
            for (var k in data) { if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k]; }
            out[SETTINGS_KEY] = JSON.stringify(settings);
            return out;
        }

        /** 把缓存里的 file: 引用还原成 data URL；磁盘上没有就删字段（当成没设置样本，可重新上传）。 */
        function restoreVoiceSample(data) {
            if (!data || typeof data[SETTINGS_KEY] !== 'string') return Promise.resolve(data);
            var settings;
            try { settings = JSON.parse(data[SETTINGS_KEY]); } catch (e) { return Promise.resolve(data); }
            if (!settings || settings[VOICE_SAMPLE_FIELD] !== VOICE_SAMPLE_MARK) return Promise.resolve(data);
            var F = fs();
            if (!F) return Promise.resolve(data);
            // 服务端只认 .wav / .mp3 / .bin 三种落盘名；元数据里的 mime 决定扩展名，这里按序试。
            var exts = ['.wav', '.mp3', '.bin'];
            function tryNext(i) {
                if (i >= exts.length) {
                    delete settings[VOICE_SAMPLE_FIELD];
                    var dropped = {};
                    for (var k in data) { if (Object.prototype.hasOwnProperty.call(data, k)) dropped[k] = data[k]; }
                    dropped[SETTINGS_KEY] = JSON.stringify(settings);
                    return dropped;
                }
                return F.readFile({ path: voiceSamplePath(exts[i]), directory: DIR })
                    .then(function (r) {
                        var b64 = String(r && r.data || '');
                        if (!b64) return tryNext(i + 1);
                        var mime = exts[i] === '.mp3' ? 'audio/mpeg' : 'audio/wav';
                        settings[VOICE_SAMPLE_FIELD] = 'data:' + mime + ';base64,' + b64;
                        var out = {};
                        for (var k in data) { if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k]; }
                        out[SETTINGS_KEY] = JSON.stringify(settings);
                        return out;
                    })
                    .catch(function () { return tryNext(i + 1); });
            }
            return Promise.resolve(tryNext(0));
        }

        function writeCacheData(data) {
            var F = fs();
            if (!F) return;
            try {
                F.writeFile({
                    path: CACHE, directory: DIR, encoding: 'utf8',
                    data: JSON.stringify(stripVoiceSample(data) || {}),
                }).catch(function () { /* 缓存失败不影响服务端权威数据 */ });
            } catch (e) { /* 缓存失败不影响服务端权威数据 */ }
        }

        function readCache() {
            return readText(CACHE).then(function (text) {
                var cached = parseText(text);
                if (cached) return restoreVoiceSample(cached);
                return readText(LEGACY).then(function (legacy) {
                    return restoreVoiceSample(parseText(legacy) || {});
                });
            });
        }

        // 手机服务的启动是异步的（core-native-mod.js 的 __nodeReadyPromise）。
        // 最多等 8 秒：首次迁移大 Store 时服务会慢一点；真的起不来再用缓存把界面拉起来，避免无限卡启动页。
        function waitNodeBase(ms) {
            if (window.__nodeBase) return Promise.resolve(window.__nodeBase);
            var ready = window.__nodeReadyPromise;
            if (ready && typeof ready.then === 'function') {
                return Promise.race([
                    Promise.resolve(ready).then(function () { return window.__nodeBase || ''; }),
                    new Promise(function (resolve) { setTimeout(function () { resolve(''); }, ms); }),
                ]);
            }
            var deadline = Date.now() + ms;
            return new Promise(function (resolve) {
                (function tick() {
                    if (window.__nodeBase) return resolve(window.__nodeBase);
                    if (Date.now() >= deadline) return resolve('');
                    setTimeout(tick, 100);
                })();
            });
        }

        function fetchStore(base) {
            return fetch(base + '/api/store', { cache: 'no-store' }).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            }).then(function (json) {
                if (!json || !json.ok || !json.data) throw new Error('响应不合法');
                return json.data;
            });
        }

        function notifySaveFailed(code, message) {
            try {
                window.dispatchEvent(new CustomEvent('elaina:store-save-failed', {
                    detail: { code: code, message: message },
                }));
            } catch (e) { /* 事件派发失败不影响后续 */ }
            console.warn('[Store] ' + message);
        }

        // 服务端返回的是完整权威快照（Go 会省略空集合），按它做 diff：服务端没有的业务键按删除处理。
        // 走 applyRemotePatch 而不是整表替换，是为了让「已有界面」跟着变 —— 缓存先上屏时，
        // 业务层已经按缓存渲染过一轮，这里必须把差异通知出去。
        function applyServerSnapshot(data) {
            var patch = {};
            for (var k in cache) {
                if (isDataKey(k) && !Object.prototype.hasOwnProperty.call(data, k)) patch[k] = null;
            }
            for (var key in data) patch[key] = data[key];
            applyRemotePatch(patch);
        }

        // 首屏宽限：服务在这段时间内给出数据就照旧等它（桌面/局域网、热启动都很快）；
        // 超过就先用缓存把界面画出来，服务结果到了再对齐。真机冷启动要拉起 Go 进程，
        // 把它放进首屏必经路径等于每次启动都白等一段与首屏无关的时间。
        var FIRST_PAINT_GRACE_MS = 1500;

        return {
            // Go 会省略空集合（删除最后一个对话/卡片后 GET 不再返回该键），所以加载只能 replace，不能 merge。
            replaceOnLoad: true,
            // replayStagedPatch 要同步拿到服务端当前值与暂存基线比对；APK 没有 Web 后端那条同步通路，按同一形状提供。
            // 只服务重放比对，不承担引导加载（native 引导仍走异步 loadAll —— 缓存兜底与首屏宽限都在那条路上）。
            // 服务未就绪（__nodeBase 空）或请求失败时返回 null，重放顺延到下一次触发。
            loadAllSync: function () {
                var nodeBase = window.__nodeBase;
                if (!nodeBase) return null;
                try {
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', nodeBase + '/api/store', false);
                    xhr.send(null);
                    if (xhr.status !== 200) return null;
                    var res = JSON.parse(xhr.responseText || '{}');
                    return (res && res.data) || {};
                } catch (e) {
                    return null;
                }
            },
            loadAll: function () {
                // 结果三种形态：对象 = 拿到服务端数据；null = 服务已明确不可用；undefined = 宽限期到、服务还没给。
                var serverPromise = waitNodeBase(20000).then(function (base) {
                    if (!base) return null;
                    return fetchStore(base).then(function (data) {
                        writeCacheData(data);
                        return { base: base, data: data };
                    }).catch(function (e) {
                        console.warn('[Store] 读取本机服务失败，改用缓存', (e && e.message) || e);
                        return null;
                    });
                });
                var settleFromServer = function (hit) {
                    if (hit) {
                        // 解除写闸门并顺带重放：上次服务中断期间暂存的补丁，恢复后推回服务端。
                        markLoaded(hit.base, false);
                        return hit.data;
                    }
                    // 服务起不来 / 读失败：设备上没有更好的权威可等，缓存就是本机最好的一份。
                    // 缓存兜底成功也算已加载：永久扣留写闸门会让 APK 写不进任何数据。
                    return readCache().then(function (cached) {
                        markLoaded('', false);
                        return cached;
                    });
                };
                return readCache().then(function (cached) {
                    var hasCache = Boolean(cached && Object.keys(cached).length);
                    // 没有缓存（首次安装 / 迁移还没落盘）：缓存画不出任何东西，等服务的真实数据比先画空更好。
                    if (!hasCache) return serverPromise.then(settleFromServer);
                    return Promise.race([
                        serverPromise,
                        new Promise(function (resolve) {
                            setTimeout(function () { resolve(undefined); }, FIRST_PAINT_GRACE_MS);
                        }),
                    ]).then(function (hit) {
                        if (hit !== undefined) return settleFromServer(hit);
                        // 宽限期到：先把缓存交出去让首屏出来，服务数据到了再对齐。
                        // 对齐必须排在 bootstrap 的整表替换之后（macrotask 晚于它那一轮微任务），
                        // 否则会被「替换成缓存」盖掉，之后再没有第二次机会。
                        // 写闸门此时仍关着 —— 这段时间的本页改动扣留在 pending，对齐时重新盖回去，
                        // 不会出现「用户刚改的值被服务端快照冲掉」。
                        serverPromise.then(function (late) {
                            setTimeout(function () {
                                if (late) {
                                    applyServerSnapshot(late.data);
                                    // pending 里是本页比服务端新的改动：盖回去，随后由 markLoaded 一次性推给服务端。
                                    for (var k in pending) {
                                        if (pending[k] === null) delete cache[k];
                                        else cache[k] = pending[k];
                                    }
                                }
                                markLoaded(late ? late.base : '', false);
                            }, 0);
                        });
                        return cached;
                    });
                });
            },
            save: function (patch) {
                var base = window.__nodeBase;
                if (!base) {
                    // 服务未就绪也要把改动留到盘上：恢复后由 replayStagedPatch 推回服务端。
                    stagePatch(patch);
                    notifySaveFailed('LOCAL_SERVER_DOWN', '本机服务未就绪，改动已暂存到本机，服务恢复后自动同步');
                    return Promise.resolve();
                }
                var body = JSON.stringify({ data: patch });
                return fetch(base + '/api/store', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Store-Client': clientId },
                    body: body,
                    // sendBeacon 设不了 X-Store-Client，且跨源 JSON 会预检；用 fetch + keepalive 覆盖小包。
                    keepalive: body.length <= 60000,
                }).then(function (res) {
                    if (res.ok) {
                        writeCacheData(cache);
                        for (var k in patch) markSynced(k, patch[k]);
                        clearStagedKeys(Object.keys(patch));
                        replayStagedPatch(base);
                        return;
                    }
                    return reportSaveFailed(res);
                }).catch(function (e) {
                    stagePatch(patch);
                    notifySaveFailed('LOCAL_SERVER_DOWN', String((e && e.message) || e));
                });
            },
        };
    }

    // 写入串行链：同一时刻至多一个补丁在途。两个补丁并发在途时，先发的那个可能后收到失败
    // 响应，暂存基线取到的是已被后发成功写入刷新过的 synced，重放就会把服务端已认的新值
    // 盖回过期值 —— 串行后失败响应到达时 synced 必然仍是这次发送时的值，基线才可比。
    var saveChain = Promise.resolve();
    // 关页后不再排队：卸载中排在链上的补丁可能没机会发出，关页保存宁可直发保住 keepalive 通路。
    var unloading = false;

    function flush() {
        flushTimer = null;
        // 写闸门未解除时扣留：补丁留在 pending，markLoaded 后再发；关页时落暂存（见 pagehide）。
        if (!everLoaded) return;
        var keys = Object.keys(pending);
        if (!keys.length) return;
        var patch = pending;
        pending = Object.create(null);
        if (unloading) {
            try { backend.save(patch); } catch (e) { /* 持久化失败不影响使用 */ }
            return;
        }
        saveChain = saveChain.then(function () { return backend.save(patch); })
            .catch(function () { /* 持久化失败不影响使用 */ });
    }

    function queue(key, value) {
        pending[key] = value;
        if (!flushTimer) flushTimer = setTimeout(flush, 800);
    }

    /** 同步读。未命中返回 null（与 localStorage.getItem 一致） */
    function getItem(key) {
        return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
    }

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
            markSynced(k, v);   // 服务端已确认这个值（远端改动与自己的成功写入都走这里）
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
            // 服务端会在订阅者跟不上写入时主动断开连接，断开期间的事件不会补发；
            // 所以每次连接成功都要重拉一次全量把缓存对齐，只靠增量补丁会悄悄缺键。
            // 首连也不例外：引导期读失败时，这次对齐是空缓存拿到权威数据的唯一通路。
            eventSource.onopen = function () {
                // 快照里没有的业务键按删除处理，走 applyRemotePatch 的 diff + notifyLocal 驱动业务层重渲染。
                var snapshot = backend.loadAllSync();
                if (!snapshot) return;
                var patch = {};
                for (var k in cache) {
                    if (isDataKey(k) && !Object.prototype.hasOwnProperty.call(snapshot, k)) patch[k] = null;
                }
                for (var key in snapshot) patch[key] = snapshot[key];
                applyRemotePatch(patch);
                markLoaded('', true);
                if (typeof window.refreshMemoryCore === 'function') {
                    window.refreshMemoryCore().catch(function () { /* 刷新失败保留本地 */ });
                }
            };
            eventSource.onmessage = function (ev) {
                var msg;
                try { msg = JSON.parse(ev.data || '{}'); } catch (e) { return; }
                if (!msg || !msg.type) return;
                // 记忆权威在服务端（M2b）：别的设备改了记忆就重拉 canonical 数据。
                if (msg.type === 'memory-change') {
                    if (typeof window.refreshMemoryCore === 'function') {
                        window.refreshMemoryCore().catch(function () { /* 刷新失败保留本地 */ });
                    }
                    return;
                }
                if (msg.type !== 'store-change' || !msg.data) return;
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

        // 同步引导只属于 Web（脚本求值阶段就要读到主题）；native 的 loadAllSync 只服务暂存重放，
        // 引导必须仍走异步 loadAll：缓存兜底、首屏宽限、服务对齐都在那条路上。
        if (backend.loadAllSync && backendKind === 'web') {
            var initial = backend.loadAllSync();
            if (initial) {
                mergeLoadedData(initial);
                markLoaded('', false);
            } else {
                // 服务端没起/正在重启：重试期间写闸门扣留所有数据键，避免空缓存派生值覆盖权威。
                scheduleLoadRetry(0);
            }
            bootPromise = Promise.resolve();
        } else {
            bootPromise = backend.loadAll().then(function (data) {
                if (backend.replaceOnLoad) replaceLoadedData(data);
                else mergeLoadedData(data);
            }).catch(function () { /* 读不到就按空数据启动 */ });
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

    /** 本地写暂存的原始通路：全库的 localStorage 访问必须收在存储层内（check-data
        的存储层例外），业务层（如记忆暂存）经这组方法落盘，不直接碰 localStorage。 */
    function rawStageSet(key, value) { localStorage.setItem(key, value); }
    function rawStageGet(key) { return localStorage.getItem(key); }
    function rawStageRemove(key) { localStorage.removeItem(key); }

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
        /** 服务不可用期间的写暂存通路（唯一允许的 localStorage 使用：待写队列，重放成功即清空） */
        rawStage: { set: rawStageSet, get: rawStageGet, remove: rawStageRemove },
        /** 首帧主题快照（只有呈现结果，不含设置正文）：index.html 的内联脚本在 Store 求值前同步读它 */
        bootThemeSnapshot: { get: bootThemeSnapshotGet, set: bootThemeSnapshotSet },
        _flush: flush,
        /** 检查脚本用：立即做一次全量加载重试（正常路径由定时器/SSE 首连触发） */
        _loadRetryNow: attemptLoadRetry,
    };

    // 关页面/切后台时把待推送的补丁发出去；非浏览器环境没有 addEventListener。
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', function () {
            unloading = true;
            if (flushTimer) { clearTimeout(flushTimer); flush(); }
            // 写闸门扣留期间关页：这些补丁从未发出过，落暂存才能在下次启动加载后补发。
            if (!everLoaded) {
                var held = pending;
                pending = Object.create(null);
                if (Object.keys(held).length) stagePatch(held);
            }
        });
        // bfcache 恢复后页面继续活着：串行链要接回来，否则恢复后的写入永远走直发。
        window.addEventListener('pageshow', function () { unloading = false; });
    }
})();
