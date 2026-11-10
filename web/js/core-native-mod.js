// 原生（Capacitor APK）插件接口：mod 的安装 / 列表 / 删除在 APK 上没有 Node 服务端，用 Capacitor Filesystem 复刻同一套接口语义；依赖 core-native.js 的 nativeFs / 字节工具。
'use strict';

// 插件管理接口在电脑版由 serve.mjs + server/mods.mjs 提供；APK 没有 Node 进程，请求打过去只会 404。存放位置是应用数据目录下的 mods/<id>/；安全规则（路径穿越 / 绝对路径 / 危险扩展名 / 体积上限）两端各写实现，判定标准必须一致。

/** 插件 id 白名单（与 server/mods.mjs 的 MOD_ID_RE 同一形状） */
const NATIVE_MOD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 危险扩展名（对齐 server/mods.mjs 的 MOD_BLOCKED_EXT 核心集：本机可执行 / 服务端脚本）。mod 允许 .js —— 它本来就是代码，与电脑版 unzip({ allowScripts: true }) 的取舍一致。 */
const NATIVE_MOD_BLOCKED_EXT = new Set([
    '.exe', '.dll', '.bat', '.cmd', '.com', '.scr', '.msi', '.sh', '.ps1',
    '.html', '.htm', '.xhtml', '.hta', '.svg',
]);
/** 插件安装路径上允许落盘的危险扩展名（白名单语义，与 server/zip.mjs 的 PLUGIN_EXTS 同一张表：插件确实要带自己的面板页，如 galgame 的 panel.html）。缺了这条豁免，手机端会静默跳过这些文件：插件照常加载、唯独面板 404。落盘位置是 app 私有目录，比电脑版静态目录更封闭。 */
const NATIVE_MOD_PLUGIN_EXTS = new Set(['.html', '.htm']);
/** 单个插件解压后的体积上限（与 server/mods.mjs 的 MOD_MAX_BYTES 一致：64MB）。两端数值必须同源，否则同一个 30MB 的包电脑能装、手机装不上，用户无从理解。 */
const NATIVE_MOD_MAX_BYTES = 64 * 1024 * 1024;

/** 归一化插件 id：剥掉 zip 文件名里常见的版本尾巴（与 server/mods.mjs 的 normalizeModId 同一形状：只剥至少两段的版本号 -1.2.3 / -1.2.3.4）。刻意不剥 -2 —— my-mod-2.zip 的「2」可能是作者编号而不是版本号，剥了两端会不一致；server/mods.mjs 有完整论证。 */
function nativeNormalizeModId(raw) {
    let s = String(raw || '').trim().replace(/\.zip$/i, '');
    const m = s.match(/^(.+?)-\d+(?:\.\d+)+$/);
    if (m && m[1] && NATIVE_MOD_ID_RE.test(m[1])) s = m[1];
    return s;
}

/** 有效扩展名判定（原样移植 server/zip.mjs 的 effectiveExt —— 安全规则两端必须同语义）。不能直接 lastIndexOf('.')：
 * NTFS ADS 与尾点 / 尾空格能把 .html 伪装成看不出来（shell.html::$DATA / shell.html. / shell.html␠ 都会放行）；先截掉第一个 : 之后的部分、再剥尾部 [. ] 就能拦下。 */
function nativeEffectiveExt(name) {
    let s = String(name || '');
    const colon = s.indexOf(':');
    if (colon >= 0) s = s.slice(0, colon);           // 剥 ADS 流名（x.html::$DATA → x.html）
    s = s.replace(/[. ]+$/, '');                      // 剥尾点/尾空格（x.html. → x.html）
    const dot = s.lastIndexOf('.');
    return dot >= 0 ? s.slice(dot).toLowerCase() : '';
}

/** 取插件数据目录（Directory.Data）下的 mods/ 相对路径前缀 */
const NATIVE_MODS_DIR = 'mods';

/** 读插件目录里的 manifest.json，返回归一化后的清单条目（字段对齐 server/mods.mjs） */
async function nativeReadModManifest(fs, dir, modId) {
    let m = null;
    try {
        const r = await fs.readFile({ path: `${NATIVE_MODS_DIR}/${modId}/manifest.json`, directory: dir, encoding: 'utf8' });
        m = JSON.parse(String(r && r.data || '{}'));
    } catch (e) { /* 没有 manifest：给最小可用清单（与电脑版 readManifest 一致） */ }
    const declared = m && typeof m.id === 'string' ? m.id.trim() : '';
    const id = (declared && NATIVE_MOD_ID_RE.test(declared)) ? declared : modId;
    return {
        id,
        dir: modId,
        name: (m && m.name) || id,
        version: (m && m.version) || '',
        description: (m && m.description) || '',
        entry: (m && m.entry) || 'index.js',
        scripts: Array.isArray(m && m.scripts) ? m.scripts.filter((s) => typeof s === 'string' && s) : [],
        styles: Array.isArray(m && m.styles) ? m.styles : [],
        // 默认关闭（与 web/js/mods.js 的 isModEnabled 同语义）：只有显式写 "defaultEnabled": true 才算默认开 —— 插件会改动界面，不该在用户不知情时生效。
        defaultEnabled: (m && m.defaultEnabled === true),
        after: Array.isArray(m && m.after) ? m.after : [],
        hidden: m ? m.hidden === true : false,
        hasManifest: Boolean(m),
    };
}

/** 递归列一个插件目录下的文件（相对路径），给清单生成用 */
async function nativeListModFiles(fs, dir, modId, relPath = '', depth = 0) {
    if (depth > 6) return [];
    const base = `${NATIVE_MODS_DIR}/${modId}`;
    let listing;
    try { listing = await fs.readdir({ path: relPath ? base + '/' + relPath : base, directory: dir }); }
    catch (e) { return []; }
    const out = [];
    for (const f of (listing.files || [])) {
        const rel = relPath ? relPath + '/' + f.name : f.name;
        if (f.type === 'directory') out.push(...await nativeListModFiles(fs, dir, modId, rel, depth + 1));
        else out.push(rel);
    }
    return out;
}

/** 扫描数据目录的 mods/，生成清单（形状对齐 server/mods.mjs 的 scanAndSync 输出） */
async function nativeListPlugins(fs, dir) {
    let entries;
    try { entries = await fs.readdir({ path: NATIVE_MODS_DIR, directory: dir }); }
    catch (e) { return []; }   // 没装过任何插件 = 正常空态
    // 只认目录（安全审计 #16）：type 缺失时把文件也当目录，会为它造出幽灵清单条目；那就退一步用 stat 确认，stat 失败的跳过。
    const ids = [];
    for (const e of (entries.files || [])) {
        if (!e.name || e.name === 'index.json') continue;
        if (e.type === 'directory') { ids.push(e.name); continue; }
        if (e.type) continue;                      // 明确是文件 → 跳过
        try {
            const st = await fs.stat({ path: `${NATIVE_MODS_DIR}/${e.name}`, directory: dir });
            if (!st || st.type === 'directory') ids.push(e.name);
        } catch (e2) { /* 读不到的条目跳过 */ }
    }
    const list = [];
    for (const id of ids) {
        try { list.push(await nativeReadModManifest(fs, dir, id)); } catch (e) { /* 跳过坏目录 */ }
    }
    return list;
}

/** 把插件目录递归删掉（卸载） */
async function nativeDeletePlugin(fs, dir, modId) {
    if (!NATIVE_MOD_ID_RE.test(modId)) throw new Error('插件名不合法：' + modId);
    await fs.rmdir({ path: `${NATIVE_MODS_DIR}/${modId}`, directory: dir, recursive: true });
}

/** 读插件自带的说明文件（对应电脑版 GET /api/plugins/:id/readme）。白名单与 server/mods.mjs 的 readReadme 是同一张表 —— 两端行为分叉（「电脑上读得到、手机上读不到」）是最难排查的一类问题。Capacitor FS 没有便宜的「先 stat 再读」，读出来再查长度效果相同。 */
const NATIVE_README_NAMES = ['README.md', 'readme.md', 'README.txt', 'readme.txt', 'README', '说明.md'];

async function nativeReadModReadme(fs, dir, modId) {
    if (!NATIVE_MOD_ID_RE.test(modId)) return { ok: false, message: '插件名不合法' };
    for (const name of NATIVE_README_NAMES) {
        let text;
        try {
            const r = await fs.readFile({ path: `${NATIVE_MODS_DIR}/${modId}/${name}`, directory: dir, encoding: 'utf8' });
            text = String(r && r.data || '');   // Capacitor readFile 回 {data}，不是裸字符串
        } catch (e) { continue; }   // 这个名字不存在 → 试下一个
        if (text.length > 256 * 1024) {
            return { ok: false, message: '说明文件过大（超过 256KB），已拒绝读取' };
        }
        return { ok: true, name, text };
    }
    // 与电脑版同一句话：前端要区分"没有 README"与"读取失败"
    return { ok: false, message: '该插件没有 README 文件' };
}

/** 从内存里的 zip 安装插件到数据目录（对应电脑版 installFromBuffer）。unzipBrowser 只管「解开」，这里管全部安全判定与落盘，逐条对齐 server/mods.mjs 的 writePluginFiles：id 白名单、先清空旧目录、剥单层顶层目录、不安全名 + 危险扩展名、解压总体积封顶。 */
async function nativeInstallPlugin(buf, rawName) {
    const fs = nativeFs();
    if (!fs) throw new Error('文件系统插件不可用');
    const dir = (fs.Directory && fs.Directory.Data) ? fs.Directory.Data : 'DATA';

    // 原始 zip 体积上限（安全审计 #14）：先挡超大包 —— 解压炸弹会把 WebView 内存吃满，入口处先卡总量是最便宜的兜底，与电脑版 readRawBody 的上传上限同量级。
    if (!buf || buf.length < 22) throw new Error('不是有效的 zip 文件');
    if (buf.length > NATIVE_MOD_MAX_BYTES) {
        throw new Error('插件包超过 ' + Math.round(NATIVE_MOD_MAX_BYTES / 1024 / 1024) + 'MB 上限');
    }

    const modId = nativeNormalizeModId(rawName);
    if (!NATIVE_MOD_ID_RE.test(modId)) throw new Error('插件名不合法：' + rawName);

    const files = await unzipBrowser(buf);
    if (!files.length) throw new Error('zip 为空或无法解析');

    // ① 先在内存里判定全部条目，全部通过才动文件系统（写了一半失败留下的半套比不装更难排查）；先把条目名统一成正斜杠，否则 a\b.js 形态的包在电脑被平铺、在手机会多套一层目录（安全审计差异 #2-part1）。
    for (const f of files) f.name = String(f.name).replace(/\\/g, '/');
    const topCandidates = new Set(files.map((f) => f.name.split('/')[0]));
    const stripTop = topCandidates.size === 1 && files.every((f) => f.name.includes('/'));
    const plan = [];
    let total = 0;
    let skipped = 0;
    for (const f of files) {
        let rel = f.name;
        if (stripTop) rel = rel.slice(rel.indexOf('/') + 1);
        if (!rel || rel.endsWith('/')) continue;
        // 不安全名：绝对路径 / `..` 穿越（对齐 server 的 isUnsafeEntryName）
        if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) { skipped++; continue; }
        // 危险扩展名：用 effectiveExt 语义 —— 直接 lastIndexOf('.') 会被 x.html::$DATA / x.html. / x.html␠ 三种 Windows 写法绕过
        const ext = nativeEffectiveExt(rel.split('/').pop() || '');
        // 插件豁免（NATIVE_MOD_PLUGIN_EXTS）优先于黑名单：.html 对普通包是危险扩展名，对插件是「自带面板页」，与电脑版 PLUGIN_EXTS 同语义
        if (NATIVE_MOD_BLOCKED_EXT.has(ext) && !NATIVE_MOD_PLUGIN_EXTS.has(ext)) { skipped++; continue; }
        total += f.data.length;
        if (total > NATIVE_MOD_MAX_BYTES) throw new Error('插件解压后超过 ' + Math.round(NATIVE_MOD_MAX_BYTES / 1024 / 1024) + 'MB 上限');
        plan.push({ rel, data: f.data });
    }
    if (!plan.length) throw new Error('zip 内没有可用文件');

    // ② 读 manifest（先在内存里解析出真实 id —— 目录名以它为准，对齐电脑版「manifest.id 是权威身份」的约定）
    let manifestEntry = null;
    const mfFile = plan.find((p) => p.rel === 'manifest.json')
        || plan.find((p) => p.rel.endsWith('/manifest.json'));
    if (mfFile) {
        try {
            const parsed = JSON.parse(new TextDecoder('utf-8').decode(mfFile.data));
            const declared = parsed && typeof parsed.id === 'string' ? parsed.id.trim() : '';
            const finalId = (declared && NATIVE_MOD_ID_RE.test(declared)) ? declared : modId;
            manifestEntry = { parsed, finalId };
        } catch (e) { /* manifest 坏了按"没有 manifest"装，行为与电脑版一致 */ }
    }
    const finalId = manifestEntry ? manifestEntry.finalId : modId;

    // ③ 防顶替（安全审计 #11，本表最重的一条）：manifest.id 可以把安装目录重定向到另一个名字，不设防则「装 A 静默清空并顶替已装的 B」成立；目标目录已存在且不是本次 zip 来源名时拒绝安装。
    const base = `${NATIVE_MODS_DIR}/${finalId}`;
    if (finalId !== modId) {
        let existsAlready = false;
        try { await fs.stat({ path: base, directory: dir }); existsAlready = true; } catch (e) { /* 不存在 */ }
        if (existsAlready) {
            throw new Error(`插件 ${finalId} 已存在（与安装包名 ${modId} 不同）。请先在插件页删除它，再安装这个包。`);
        }
    }

    // ④ 清空旧目录（重装语义）→ 逐文件写入
    await fs.rmdir({ path: base, directory: dir, recursive: true }).catch(() => {});
    let written = 0;
    for (const p of plan) {
        await nativeWriteFile(`${base}/${p.rel}`, dir, p.data);
        written++;
    }
    return { id: finalId, written, skipped };
}

/** 插件接口的原生分发（形状对齐 nativeLive2dFetch） */
async function nativePluginsFetch(url, options) {
    const method = ((options && options.method) || 'GET').toUpperCase();
    const fs = nativeFs();
    // 一律走 makeRes 出口（check-native-response 的硬约束：所有 return 都要走 makeRes/json）—— 裸对象会缺字段，调用方 readJsonSafe 第一行 await res.text() 直接 TypeError。
    const makeRes = (status, obj) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => obj,
        text: async () => JSON.stringify(obj),
    });
    const json = (obj) => makeRes(200, obj);
    if (!fs) return makeRes(500, { ok: false, message: '文件系统插件不可用' });
    const dir = (fs.Directory && fs.Directory.Data) ? fs.Directory.Data : 'DATA';
    try {
        // 列表：形状对齐电脑版 GET /api/plugins（前端 refreshModsList 只用 plugins 数组）
        if (url === '/api/plugins' && method === 'GET') {
            const plugins = await nativeListPlugins(fs, dir);
            return json({ ok: true, plugins, generatedAt: new Date().toISOString() });
        }
        // 安装：请求体是 zip 原始字节（与电脑版同一条协议）
        if (url.startsWith('/api/plugins/install') && method === 'POST') {
            const rawName = (() => {
                try { return decodeURIComponent((url.split('?')[1] || '').replace(/^name=/, '')) || 'plugin.zip'; }
                catch (e) { return 'plugin.zip'; }
            })();
            const body = options && options.body;
            if (!body) return makeRes(400, { ok: false, message: '无文件' });
            const buf = new Uint8Array(body instanceof Blob ? await body.arrayBuffer() : await new Response(body).arrayBuffer());
            const r = await nativeInstallPlugin(buf, rawName);
            return json({ ok: true, id: r.id, files: r.written, skipped: r.skipped, message: `已安装 ${r.id}（${r.written} 个文件）` });
        }
        // 说明（README）：对齐电脑版 GET /api/plugins/:id/readme；漏了这条手机端点「查看说明」直接网络失败。
        const readmeMatch = String(url).match(/^\/api\/plugins\/([^/]+)\/readme$/);
        if (readmeMatch && method === 'GET') {
            const r = await nativeReadModReadme(fs, dir, decodeURIComponent(readmeMatch[1]));
            return json(r);
        }
        // 删除：对齐电脑版 DELETE /api/plugins/:id
        const delMatch = String(url).match(/^\/api\/plugins\/([^/]+)$/);
        if (delMatch && method === 'DELETE') {
            const modId = decodeURIComponent(delMatch[1]);
            await nativeDeletePlugin(fs, dir, modId);
            return json({ ok: true, deleted: modId });
        }
        return makeRes(404, { ok: false, message: 'Not found（手机端未实现该接口）' });
    } catch (err) {
        return makeRes(500, { ok: false, message: err.message || String(err) });
    }
}

// 原生模式下拦截 /api/live2d/ 与 /api/plugins/ 请求；本地服务就绪后按前缀清单转发一部分接口，转发不了的回落本地实现（「本地服务不可用」是默认形态）。
if (IS_NATIVE_APP) {
    const nativeOrigFetch = window.fetch.bind(window);

    // 本地服务转发。转发清单 = 固定清单（日志接口，bootstrap 自己实现）+ 动态清单（已装载插件的路由前缀，来自 /api/ping 的 modRoutes）；固定清单可以写死，插件路由不能，只能按服务报告的清单转发。
    const NODE_FIXED_PREFIXES = ['/api/logs/', '/api/client-log', '/api/mods/status', '/api/memory/'];
    // 转发超时：普通请求 30s，上传放宽到 5 分钟（200MB 上限按慢网络也要走得完）；调用方自带 AbortSignal 时透传。
    const NODE_TIMEOUT_MS = 30000;
    const NODE_UPLOAD_TIMEOUT_MS = 300000;
    let nodeFailCount = 0;
    let nodeDown = false;

    /** 段边界匹配：/api/live2d 命中 /api/live2d/...，不命中 /api/live2dfoo */
    function nodeRouteHit(u) {
        for (const p of NODE_FIXED_PREFIXES) {
            if (u === p || u.startsWith(p.endsWith('/') ? p : p + '/')) return true;
        }
        const modRoutes = Array.isArray(window.__nodeRoutePrefixes) ? window.__nodeRoutePrefixes : [];
        for (const p of modRoutes) {
            if (typeof p !== 'string') continue;
            if (u === p || u.startsWith(p + '/')) return true;
        }
        return false;
    }

    /** 连续失败后确认 node 是否真掉线：ping 通 = 只是瞬时抖动，重置计数；ping 不通 = 掉线，停用转发（不清 __nodeBase —— 万一是误判，下次启动还能恢复；本会话内让请求明确走本地实现，而不是每次白等 30s 超时）。 */
    async function markNodeDownIfDead() {
        try {
            const res = await nativeOrigFetch(window.__nodeBase + '/api/ping', { cache: 'no-store' });
            if (res.ok) { nodeFailCount = 0; return; }
        } catch (e) { /* ping 也失败 → 掉线 */ }
        nodeDown = true;
        window.__nodeRoutePrefixes = [];
        console.warn('[Native] 内嵌服务连续失败且 ping 不通，已停用转发（本次会话走本地实现，重启应用可恢复）');
    }

    /** 把一条 /api/* 请求原样透传给回环服务。body/headers/method 一律不动（上传是原始 File 字节，转 JSON 就废了） */
    async function forwardToNode(u, options) {
        const opts = options || {};
        if (opts.signal) return nativeOrigFetch(window.__nodeBase + u, opts);
        const isUpload = u === '/api/live2d/upload' || u.startsWith('/api/live2d/upload');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(),
            isUpload ? NODE_UPLOAD_TIMEOUT_MS : NODE_TIMEOUT_MS);
        try {
            return await nativeOrigFetch(window.__nodeBase + u, { ...opts, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    // navigator.sendBeacon 补丁（只劫持 /api/client-log）：sendBeacon 不走 window.fetch，拦截器拦不到，相对地址在手机上必然 404。
    // 不能换成 fetch(…, keepalive)（请求体上限 64KiB 且全局共享，Blob + application/json 还会触发预检而页面卸载时来不及）；用 text/plain、按字节分批 ≤48KiB、串行冲刷。
    const nativeOrigBeacon = typeof navigator.sendBeacon === 'function'
        ? navigator.sendBeacon.bind(navigator) : null;
    let beaconKick = null;
    if (nativeOrigBeacon) {
        const BEACON_QUEUE_MAX = 100;
        const BEACON_BATCH_BYTES = 48 * 1024;
        const beaconQueue = [];
        let beaconDroppedCount = 0;
        let beaconBusy = false;
        const beaconEncoder = new TextEncoder();

        const beaconEnqueue = (items) => {
            for (const it of items) {
                while (beaconQueue.length >= BEACON_QUEUE_MAX) {
                    beaconQueue.shift();
                    beaconDroppedCount++;
                }
                beaconQueue.push({
                    level: String((it && it.level) || 'log'),
                    text: String((it && it.text) || ''),
                    page: String((it && it.page) || ''),
                });
            }
        };

        async function beaconFlush() {
            if (beaconBusy) return;
            beaconBusy = true;
            try {
                while (beaconQueue.length && window.__nodeBase && !nodeDown) {
                    const batch = [];
                    let bytes = 2;          // JSON 骨架 "{}" 与分隔符的余量
                    while (beaconQueue.length) {
                        const itemBytes = beaconEncoder.encode(JSON.stringify(beaconQueue[0])).length + 1;
                        if (batch.length && bytes + itemBytes > BEACON_BATCH_BYTES) break;
                        bytes += itemBytes;
                        batch.push(beaconQueue.shift());
                    }
                    try {
                        await forwardToNode('/api/client-log', {
                            method: 'POST',
                            headers: { 'Content-Type': 'text/plain' },
                            body: JSON.stringify({ items: batch }),
                            keepalive: true,
                        });
                    } catch (e) {
                        nodeFailCount++;                 // beacon 失败同样是 node 故障的信号
                        beaconQueue.unshift(...batch);   // 本批塞回去，下轮再试
                        break;
                    }
                }
                if (beaconDroppedCount > 0) {
                    console.warn('[Native] 前端日志队列溢出，丢弃了 ' + beaconDroppedCount + ' 条最旧记录');
                    beaconDroppedCount = 0;
                }
            } finally {
                beaconBusy = false;
            }
        }

        /** 异步解出 beacon 载荷里的 items 入队（sendBeacon 是同步签名，内容只能异步读） */
        const queueBeaconPayload = (data) => {
            Promise.resolve().then(async () => {
                let text = '';
                if (typeof data === 'string') text = data;
                else if (data && typeof data.text === 'function') text = await data.text();
                else return;
                let items = null;
                try {
                    const parsed = JSON.parse(text);
                    items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
                } catch (e) { items = null; }
                if (items && items.length) {
                    beaconEnqueue(items);
                    beaconFlush();
                }
            }).catch(() => { /* 上报链路绝不能影响应用本身 */ });
        };

        beaconKick = beaconFlush;

        navigator.sendBeacon = function (url, data) {
            const path = typeof url === 'string' ? url.split('?')[0] : '';
            if (path === '/api/client-log') {
                queueBeaconPayload(data);   // 未就绪时入队，就绪后由 __nodeReadyPromise 触发冲刷
                return true;
            }
            return nativeOrigBeacon(url, data);
        };
    }

    window.fetch = async (input, options) => {
        const u = typeof input === 'string' ? input : String((input && input.url) || input);
        // 本地服务转发：命中清单（固定清单 + 插件路由）且服务就绪。只对绝对路径匹配 —— http(s):// 与 _capacitor_file_ 的完整 URL 一律放行，别劫持引擎 / 图片请求。
        if (window.__nodeBase && !nodeDown && u.startsWith('/api/') && nodeRouteHit(u)) {
            try {
                const res = await forwardToNode(u, options);
                nodeFailCount = 0;
                return res;
            } catch (e) {
                nodeFailCount++;
                // /api/live2d/ 有原生兜底 → 运行中也回落；其它前缀没有本地实现，回落只会掩盖真实故障 → 原样抛回调用方。
                if (u === '/api/live2d' || u.startsWith('/api/live2d/')) {
                    console.warn('[Native] 转发内嵌服务失败，回落本地实现:', u, (e && e.message) || e);
                    return nativeLive2dFetch(u, options || {});
                }
                if (nodeFailCount >= 3) await markNodeDownIfDead();
                throw e;
            }
        }
        if (u.startsWith('/api/live2d/')) return nativeLive2dFetch(u, options || {});
        // 插件管理（安装 / 列表 / 删除 / 说明）：手机版在这里原生实现；只拦已知前缀，其余照常放行，不然 store.js 等处的真实请求会被误劫持。
        if (u === '/api/plugins' || u.startsWith('/api/plugins/install')
            || /^\/api\/plugins\/[^/]+$/.test(u) || /^\/api\/plugins\/[^/]+\/readme$/.test(u)) {
            return nativePluginsFetch(u, options || {});
        }
        return nativeOrigFetch(input, options);
    };

    // 本地服务就绪链（独立链，不复用播种 / 插件根那两条）：start() → 轮询 status 到 ready → 轮询 /api/ping 到 modsLoaded 有结论 → 才缓存路由清单。
    // 必须等结论：HTTP listen 返回后就能 accept，而 loadAll 在它之后，先到的 ping 必然看到空清单，当终态缓存就永远是空的。
    window.__nodeReadyPromise = (async () => {
        try {
            // Capacitor 插件是异步注入到 window.Capacitor.Plugins 的，页面脚本执行时常常还没注册完；一上来就取会拿到 undefined，于是「插件不可用」被吞掉、只剩 status 轮询 —— 先等它出现（最多 5 秒）。
            const node = await waitForNodePlugin(5000);
            if (!node || typeof node.start !== 'function' || typeof node.status !== 'function') {
                throw new Error('ElainaNode 插件不可用（构建未启用本地服务）');
            }
            await node.start();   // 幂等；只调一次，不依赖停止后重启（行为未验证）
            const startedAt = Date.now();
            let state = null;
            while (Date.now() - startedAt < 20000) {
                state = await node.status();
                if (state && state.ready && Number(state.port) > 0) break;
                if (state && state.started === false && state.lastError) {
                    throw new Error(String(state.lastError));
                }
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            if (!(state && state.ready && Number(state.port) > 0)) {
                throw new Error('等内嵌服务就绪超时（20s）');
            }
            const base = 'http://127.0.0.1:' + Number(state.port);
            const routes = await waitForNodeRoutes(base);
            window.__nodeBase = base;
            window.__nodeRoutePrefixes = routes.modRoutes;
            window.__nodeModStatic = routes.modStatic;
            console.log('[Native] 内嵌服务就绪 ' + base
                + (routes.modRoutes.length ? '（插件路由：' + routes.modRoutes.join(' ') + '）' : ''));
        } catch (e) {
            console.warn('[Native] 内嵌服务不可用（已回落本地实现）', (e && e.message) || e);
        }
    })();

    /** 轮询等 Capacitor 把 ElainaNode 插件注册进来（超时返回 null，不是错误） */
    function waitForNodePlugin(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        return new Promise((resolve) => {
            const tick = () => {
                const plugin = window.Capacitor?.Plugins?.ElainaNode;
                if (plugin && typeof plugin.start === 'function') { resolve(plugin); return; }
                if (Date.now() >= deadline) { resolve(null); return; }
                setTimeout(tick, 100);
            };
            tick();
        });
    }

    /** 轮询 /api/ping 直到 mod 装载有结论。两种「没有」必须分开：字段不存在 → 本版 bootstrap 无 mod 装载能力，空清单就是终态（预期，不 warn）；字段存在但 10s 内没变 true → 装载卡住 / 崩了，缓存空清单 + warn 一行（此时插件路由全走原生兜底，功能仍在，但值得看一眼日志）。 */
    async function waitForNodeRoutes(base) {
        const deadline = Date.now() + 10000;
        let sawField = false;
        while (Date.now() < deadline) {
            let info = null;
            try {
                const res = await nativeOrigFetch(base + '/api/ping', { cache: 'no-store' });
                if (res.ok) info = await res.json();
            } catch (e) { /* 还没 listen 完 / 瞬时失败，继续轮询 */ }
            if (info) {
                if (!('modsLoaded' in info)) {
                    return { modRoutes: [], modStatic: [] };
                }
                sawField = true;
                if (info.modsLoaded === true) {
                    return {
                        modRoutes: Array.isArray(info.modRoutes)
                            ? info.modRoutes.filter((p) => typeof p === 'string') : [],
                        modStatic: Array.isArray(info.modStatic) ? info.modStatic : [],
                    };
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (sawField) console.warn('[Native] mod 装载未在 10s 内给出结论，本次按原生兜底');
        return { modRoutes: [], modStatic: [] };
    }

    // 就绪的第一件事：把攒着的前端日志冲出去（启动最初几秒的报错恰是最需要的）
    window.__nodeReadyPromise.then(() => { if (beaconKick) beaconKick(); });
}
if (IS_NATIVE_APP) {
    // 顺序不能反：先建目录并拿到 base URL（nativeModelRootReady），再种内置模型；暴露成 Promise，好让模型列表在种完之前等一下。
    window.__nativeSeedPromise = initNativeLive2dStorage()
        .then(seedBundledLive2dModels)
        .catch((e) => { console.warn('[Native] 内置模型初始化失败', e); });

    // 插件根目录（mods.js 加载器用）。刻意不复用 __nativeSeedPromise：那个串着内置 Live2D 模型的播种（95 个文件、40MB），插件加载若等它首屏会白等一次。
    // 产出 window.__nativeModBase（_capacitor_file_/…/files/mods/）：mods.js 拿它替换 /mods/ 根并逐段编码 —— 这里绝不能再 encodeURIComponent（双重编码 404）；失败保持 undefined，回落桌面根但不白屏。
    window.__nativeModsRootPromise = (async () => {
        try {
            const f = nativeFs();
            if (!f) throw new Error('Filesystem 插件不可用');
            const d = (f.Directory && f.Directory.Data) ? f.Directory.Data : 'DATA';
            // mkdir 对已存在的目录会抛错（OS-PLUG-FILE-0010 "already exists"，即便传了 recursive: true）：这里抛 → getUri 不执行 → __nativeModBase 一直 undefined → mods.js 回落桌面根 → 所有插件都不加载；只放过「已存在」这一类错误。
            try {
                await f.mkdir({ path: NATIVE_MODS_DIR, directory: d, recursive: true });
            } catch (mkdirError) {
                if (!/exist/i.test(String((mkdirError && mkdirError.message) || mkdirError))) throw mkdirError;
            }
            const res = await f.getUri({ path: NATIVE_MODS_DIR, directory: d });
            if (window.Capacitor.convertFileSrc) {
                window.__nativeModBase = window.Capacitor.convertFileSrc(res.uri) + '/';
            } else {
                window.__nativeModBase = res.uri + '/';
            }
            console.log('[Native] 插件目录:', window.__nativeModBase);
        } catch (e) {
            console.warn('[Native] 插件目录初始化失败（插件加载会回落桌面根）', e);
        }
    })();
}
