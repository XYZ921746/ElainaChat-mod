/* ============================================================================
 * 原生（Capacitor APK）插件接口（从 core.js 拆出）
 *
 * mod 的安装/列表/删除在 APK 上没有 Node 服务端，这里用 Capacitor Filesystem 复刻
 * 同一套接口语义。依赖 core-native.js 的 nativeFs / 字节工具；加载顺序 core-native → 本文件 → core.js。
 * ========================================================================== */
'use strict';

// ==================== 插件（mod）的原生接口（APK） ====================
// 插件管理接口在电脑版由 serve.mjs + server/mods.mjs 提供；APK 没有 Node 进程，请求打过去只会 404，
//   界面上「上传安装」点下去就是一句看不懂的 "Not found"。两端同构：手机也走「应用内安装」，
//   差异只剩「安卓不允许往安装目录丢文件」这一条。
// 存放位置是应用数据目录下的 `mods/<id>/`（与 live2d/models/ 同一体系，卸载 App 时一起清掉）。
// 安全规则与电脑版共享同一套语义：路径穿越 / 绝对路径 / 危险扩展名 / 体积上限 —— 两端各写实现，
//   判定标准必须一致（下面逐条对齐 server/mods.mjs）。

/** 插件 id 白名单（与 server/mods.mjs 的 MOD_ID_RE 同一形状） */
const NATIVE_MOD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 危险扩展名（对齐 server/mods.mjs 的 MOD_BLOCKED_EXT 的核心集：
 *  本机可执行 / 服务端脚本。mod 允许 .js —— 它本来就是代码，
 *  与电脑版 unzip({ allowScripts: true }) 的取舍一致）。 */
const NATIVE_MOD_BLOCKED_EXT = new Set([
    '.exe', '.dll', '.bat', '.cmd', '.com', '.scr', '.msi', '.sh', '.ps1',
    '.html', '.htm', '.xhtml', '.hta', '.svg',
]);
/** 插件安装路径上**允许**落盘的危险扩展名（白名单语义，与 server/zip.mjs 的
 *  PLUGIN_EXTS 同一张表：插件确实要带自己的面板页 —— galgame 的 panel.html。
 *  缺了这条豁免，手机端会把这些文件**静默跳过**：插件照常加载、唯独面板
 *  404，两端行为分叉。落盘位置是 app 私有数据目录，比电脑版的静态目录
 *  更封闭，豁免的风险面更小。.js/.ts 等脚本扩展不在黑名单里，无需在此列。 */
const NATIVE_MOD_PLUGIN_EXTS = new Set(['.html', '.htm']);
/** 单个插件解压后的体积上限（与 server/mods.mjs 的 MOD_MAX_BYTES 一致：64MB。
 *  之前写 20MB 且注释谎称一致 —— 同一个 30MB 的包电脑能装、手机装不上，
 *  用户无从理解。两端数值必须同源，注释必须可验证。） */
const NATIVE_MOD_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 归一化插件 id：剥掉 zip 文件名里常见的版本尾巴（与 server/mods.mjs 的
 * normalizeModId **同一形状**：只剥「至少两段」的版本号 `-1.2.3` / `-1.2.3.4`，
 * 刻意**不剥** `-2` —— `my-mod-2.zip` 的"2"可能是作者编号而不是版本号，
 * 剥了会让"电脑装成 my-mod-2、手机装成 my-mod"两端不一致。
 * server/mods.mjs:96-101 有完整论证，两端必须同语义）。
 */
function nativeNormalizeModId(raw) {
    let s = String(raw || '').trim().replace(/\.zip$/i, '');
    const m = s.match(/^(.+?)-\d+(?:\.\d+)+$/);
    if (m && m[1] && NATIVE_MOD_ID_RE.test(m[1])) s = m[1];
    return s;
}

/**
 * 有效扩展名判定（**原样移植** server/zip.mjs 的 effectiveExt —— 安全规则两端必须同语义）。
 *
 * 为什么不能直接 `lastIndexOf('.')`：Windows 的 NTFS ADS 与尾点/尾空格写法
 * 能把"看得出是 .html"伪装成看不出来：
 *     `shell.html::$DATA` → 直接取 ext 得 `.html::$data`（不在黑名单 → 放行 ❌）
 *     `shell.html.`       → ext 得 `.`（放行 ❌）
 *     `shell.html␠`       → ext 得 `.html␠`（放行 ❌）
 * server 端 8.42 就是修的这个（`x.html::$DATA` 存储型 XSS 绕过）。
 * effectiveExt 先截掉第一个 `:` 之前之后的部分、再剥尾部 `[. ]`，三种写法全部还原成 `.html` 被拦。
 */
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
        // 默认关闭（与 web/js/mods.js 的 isModEnabled 同语义）：只有显式写
        //   `"defaultEnabled": true` 才算默认开，漏写/写别的都算关 ——
        //   插件会改动界面，不该在用户不知情时生效。
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
    // 只认目录（安全审计 #16）：type 缺失时把文件也当目录，会为它造出幽灵清单条目。
    //   有些实现不回 type 字段 —— 那就退一步用 stat 确认；stat 失败的跳过。
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

/**
 * 读插件自带的说明文件（对应电脑版 GET /api/plugins/:id/readme）。
 *
 * 白名单与 server/mods.mjs 的 readReadme 是同一张表 —— 两端行为分叉
 * （"电脑上读得到、手机上读不到"）是最难排查的一类问题，表必须逐项一致。
 * Capacitor FS 没有便宜的"先 stat 再读"，这里读出来再查长度：256KB 的
 * 上限本身挡的是"读不完的说明"，读进来再拦与先 stat 再拦效果相同。
 */
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

/**
 * 从内存里的 zip 安装插件到数据目录（对应电脑版 installFromBuffer）。
 *
 * 与 unzipBrowser 的分工：那个只管"解开"，这里管**全部安全判定与落盘** ——
 * 逐条对齐 server/mods.mjs 的 writePluginFiles：
 *   ① id 白名单（挡 `..` / 绝对路径 / 奇怪字符）
 *   ② 先清空旧目录再装（重装语义，避免残留旧文件）
 *   ③ zip 内单层同名顶层目录剥掉（打包习惯）
 *   ④ 每条目判不安全名 + 危险扩展名
 *   ⑤ 解压总体积封顶（超了回滚整个目录）
 */
async function nativeInstallPlugin(buf, rawName) {
    const fs = nativeFs();
    if (!fs) throw new Error('文件系统插件不可用');
    const dir = (fs.Directory && fs.Directory.Data) ? fs.Directory.Data : 'DATA';

    // 原始 zip 体积上限（安全审计 #14）：先挡超大包 —— 解压炸弹会把
    //   WebView 内存吃满（见 unzipBrowser 的说明），那条防线未建之前，
    //   入口处先卡总量是最便宜的兜底。与电脑版 readRawBody 的上传上限同量级。
    if (!buf || buf.length < 22) throw new Error('不是有效的 zip 文件');
    if (buf.length > NATIVE_MOD_MAX_BYTES) {
        throw new Error('插件包超过 ' + Math.round(NATIVE_MOD_MAX_BYTES / 1024 / 1024) + 'MB 上限');
    }

    const modId = nativeNormalizeModId(rawName);
    if (!NATIVE_MOD_ID_RE.test(modId)) throw new Error('插件名不合法：' + rawName);

    const files = await unzipBrowser(buf);
    if (!files.length) throw new Error('zip 为空或无法解析');

    // ① 先在内存里判定全部条目，全部通过才动文件系统 ——
    //    与电脑版"先清空再写"不同（那边有 rm 兜底），这里一旦写了一半失败，
    //    留下的半套比不装更难排查，所以宁可先全量校验。
    //    先把条目名统一成正斜杠（server 端 readZip 在解压层就做了）——
    //      否则 `a\b.js` 形态的包在电脑被平铺、在手机会多套一层目录，
    //      两端行为分叉（安全审计差异 #2-part1）。
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
        // 危险扩展名：用 effectiveExt 语义（见该函数注释）——
        //   直接 lastIndexOf('.') 会被 `x.html::$DATA` / `x.html.` / `x.html␠`
        //   三种 Windows 写法绕过（server 端 8.42 修过的同一个洞）。
        const ext = nativeEffectiveExt(rel.split('/').pop() || '');
        // 插件豁免（NATIVE_MOD_PLUGIN_EXTS）优先于黑名单：.html 对普通包是危险
        //   扩展名，对插件是"自带面板页"—— 与电脑版 PLUGIN_EXTS 同语义
        if (NATIVE_MOD_BLOCKED_EXT.has(ext) && !NATIVE_MOD_PLUGIN_EXTS.has(ext)) { skipped++; continue; }
        total += f.data.length;
        if (total > NATIVE_MOD_MAX_BYTES) throw new Error('插件解压后超过 ' + Math.round(NATIVE_MOD_MAX_BYTES / 1024 / 1024) + 'MB 上限');
        plan.push({ rel, data: f.data });
    }
    if (!plan.length) throw new Error('zip 内没有可用文件');

    // ② 读 manifest（先在内存里解析出**真实 id** —— 目录名以它为准，
    //    对齐电脑版"manifest.id 是权威身份"的约定）
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

    // ③ 防顶替（安全审计 #11，本表最重的一条）：
    //    manifest.id 可以把安装目录**重定向**到另一个名字 —— 若不设防，
    //    "装 A 静默清空并顶替已装的插件 B"成立（rmdir(recursive) 会把
    //    mods/B/ 整个删掉再写入）。电脑版没这个洞，因为那边目录名只用
    //    文件名 id、manifest.id 只影响清单字段。
    //    这里保留"以 manifest.id 为准"的语义（与前端身份系统一致），
    //    但目标目录**已存在且不是本次 zip 来源名**时拒绝安装 ——
    //    让用户先删再装，不能被一个包静默清掉别人的目录。
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
    // 一律走 makeRes 出口（check-native-response 的硬约束：所有 return 都要
    //   走 makeRes/json —— 裸对象会缺字段，调用方 readJsonSafe 第一行
    //   await res.text() 直接 TypeError。）
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
        // 说明（README）：对齐电脑版 GET /api/plugins/:id/readme。
        //   没有这条时手机端点「查看说明」直接网络失败 —— 插件管理三件套
        //   （列表/安装/删除）原生实现了，说明这一条漏了。
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

// 原生模式下拦截 /api/live2d/* 与 /api/plugins/* 请求；内嵌 Node（回环服务）就绪后
// 再按前缀清单把一部分 /api/* 转发给它（日志、mod 服务端半边），转发不了的一律走
// 原有本地实现 —— "node 不可用"是默认形态（构建开关默认关），兜底链路必须永远先成立。
if (IS_NATIVE_APP) {
    const nativeOrigFetch = window.fetch.bind(window);

    // ── 内嵌 Node 转发 ─────────────────────────────────────────────────
    // 转发清单 = 固定清单（日志接口，bootstrap 自己实现）+ 动态清单（已装载插件的
    // 路由前缀，来自 /api/ping 的 modRoutes）。固定清单在前端写死没问题 —— 那些
    // 接口就是为手机端加的；插件路由**不能**写死（宿主不认识任何具体插件），
    // 只能按 node 报告的清单转发。
    const NODE_FIXED_PREFIXES = ['/api/logs/', '/api/client-log', '/api/mods/status'];
    // 转发超时：普通请求 30s；上传放宽到 5 分钟（200MB 上限按慢网络也要走得完，
    // 否则大模型包必被砍）。调用方自带 AbortSignal 时透传 —— 它自己管超时。
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

    /**
     * 连续失败后确认 node 是否真掉线：ping 通 = 只是瞬时抖动，重置计数；
     * ping 不通 = 掉线，停用转发（不清 __nodeBase —— 万一是误判，下次启动还能恢复；
     * 本会话内让请求明确走本地实现，而不是每次白等 30s 超时）。
     */
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

    // ── navigator.sendBeacon 补丁（只劫持 /api/client-log）──────────────
    // 为什么必须补：sendBeacon 不走 window.fetch，拦截器拦不到它 —— 相对地址在
    // 手机上必然 404，前端报错转发在手机上整个失效。为什么不能简单换成
    // fetch(…, keepalive)：两个硬约束 ——
    //   ① keepalive 请求体上限 64KiB 且全局共享，一批 20 条 × 2000 字中文（UTF-8
    //     3 字节/字）≈ 120KB 必超，浏览器直接拒发（不会截断）；
    //   ② Blob 带 application/json 的 Content-Type 属于非安全列表，跨源触发 OPTIONS
    //     预检，而 beacon 的典型场景是页面卸载 —— 预检常常来不及回来，请求静默丢失。
    // 所以：Content-Type 用 text/plain（安全列表，免预检；bootstrap 侧解析不看它），
    // 按**字节**分批（每批 ≤ 48KiB，给头部留余量），node 未就绪时先入内存环形队列
    // （启动最初几秒的前端报错恰是最需要日志的时刻），就绪后**串行**冲刷（并发会
    // 抢同一份 keepalive 配额）。
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
        // 内嵌 Node 转发：命中清单（固定清单 + 插件路由）且 node 就绪。
        // 只对绝对路径匹配 —— http(s):// 与 _capacitor_file_ 的完整 URL 一律放行，
        // 别劫持引擎/图片请求（那些不走 /api）。
        if (window.__nodeBase && !nodeDown && u.startsWith('/api/') && nodeRouteHit(u)) {
            try {
                const res = await forwardToNode(u, options);
                nodeFailCount = 0;
                return res;
            } catch (e) {
                nodeFailCount++;
                // /api/live2d/* 有原生兜底 → 运行中也回落（不比现状差不能只覆盖启动快照）；
                // 其它前缀没有本地实现，回落只会掩盖真实故障 → 原样抛回调用方。
                if (u === '/api/live2d' || u.startsWith('/api/live2d/')) {
                    console.warn('[Native] 转发内嵌服务失败，回落本地实现:', u, (e && e.message) || e);
                    return nativeLive2dFetch(u, options || {});
                }
                if (nodeFailCount >= 3) await markNodeDownIfDead();
                throw e;
            }
        }
        if (u.startsWith('/api/live2d/')) return nativeLive2dFetch(u, options || {});
        // 插件管理（安装/列表/删除/说明）：电脑版由 serve.mjs 提供，
        //   手机版在这里原生实现（见 nativePluginsFetch 的说明）。
        //   只拦已知前缀，其余照常放行 —— 不然 store.js 等处的
        //   真实请求会被误劫持。
        if (u === '/api/plugins' || u.startsWith('/api/plugins/install')
            || /^\/api\/plugins\/[^/]+$/.test(u) || /^\/api\/plugins\/[^/]+\/readme$/.test(u)) {
            return nativePluginsFetch(u, options || {});
        }
        return nativeOrigFetch(input, options);
    };

    // ── 内嵌 Node 就绪链（独立链，不复用播种/插件根那两条）──────────────
    // 与 __nativeSeedPromise / __nativeModsRootPromise 同一套模式：开机调一次
    // start()（幂等）→ 轮询 status 到 ready → 轮询 /api/ping 到 mod 装载有结论
    // （modsLoaded）→ 才把路由清单缓存下来。**必须等结论**而不是"ping 通就算"：
    // HTTP listen 回调返回后就能 accept，而 loadAll 发生在它之后 —— 先到的 ping
    // 必然看到空清单，把它当终态缓存下来就永远是空的，且日志里没有任何报错。
    // 失败（超时 / lastError / 插件不存在）时 __nodeBase 保持 undefined，
    // 一切照现状跑。
    window.__nodeReadyPromise = (async () => {
        try {
            // Capacitor 插件是**异步**注入到 window.Capacitor.Plugins 的：
            // 页面脚本执行时它常常还没注册完。一上来就取会拿到 undefined，
            // 于是"插件不可用"被 catch 吞掉、之后只剩 status 轮询 ——
            // 表现是服务起着却从没收到过 start，Node 永远不启动。
            // 所以先等它出现（最多 5 秒），拿不到才判定本版没有内嵌 Node。
            const node = await waitForNodePlugin(5000);
            if (!node || typeof node.start !== 'function' || typeof node.status !== 'function') {
                throw new Error('ElainaNode 插件不可用（构建未启用内嵌 Node）');
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

    /**
     * 轮询 /api/ping 直到 mod 装载有结论。两种"没有"必须分开：
     *   · 字段不存在 → 本版 bootstrap 无 mod 装载能力，空清单就是终态（预期，不 warn）；
     *   · 字段存在但 10s 内没变 true → 装载卡住/崩了，缓存空清单 + warn 一行
     *     （此时插件路由全走原生兜底，功能仍在，但值得看一眼日志）。
     */
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
    // 顺序不能反：先建目录并拿到 base URL（nativeModelRootReady），再种内置模型。
    // 暴露成 Promise，好让模型列表在种完之前等一下（见 live2d-video.js 的 refreshModelList）。
    window.__nativeSeedPromise = initNativeLive2dStorage()
        .then(seedBundledLive2dModels)
        .catch((e) => { console.warn('[Native] 内置模型初始化失败', e); });

    // ── 插件根目录（mods.js 加载器用）────────────────────────────────────
    // 刻意**不**复用 __nativeSeedPromise：那个 Promise 串着内置 Live2D 模型的
    //   播种（95 个文件、40MB）。插件加载若等它，首屏会白等一次模型播种 ——
    //   两件不相干的事被一根链子拴住。这里独立起一条。
    //   产出 `window.__nativeModBase`：形如
    //     `https://localhost/_capacitor_file_/data/user/0/<包名>/files/mods/`
    //   mods.js 拿它替换 `/mods/` 根（mods.js 的 modDir 负责**逐段编码**，
    //   这里**绝不能**再 encodeURIComponent —— 双重编码会 404）。
    //   失败时保持 undefined：mods.js 会回落桌面根 `/mods/`，插件 404 但不白屏 ——
    //   与"缺能力要说清楚"的一贯做法一致（启动横幅会打一行原因）。
    window.__nativeModsRootPromise = (async () => {
        try {
            const f = nativeFs();
            if (!f) throw new Error('Filesystem 插件不可用');
            const d = (f.Directory && f.Directory.Data) ? f.Directory.Data : 'DATA';
            // mkdir 对**已存在**的目录会抛错 ——
            //   Capacitor 的 Filesystem 返回 OS-PLUG-FILE-0010
            //   "already exists, cannot be overwritten"，**即便传了 recursive: true 也一样**。
            //   于是只要有第二次启动、或者之前装过插件（files/mods 已存在），这里就抛 →
            //   下面 getUri 不会执行 → `__nativeModBase` 一直是 undefined →
            //   mods.js 回落桌面根 `/mods/`（APK 上必然 404）→ **所有插件都不加载**，
            //   日志里只有一行"插件目录初始化失败（插件加载会回落桌面根）"。
            //   这个坑只在"第二次启动之后"出现：首次安装 APK 时目录不存在，这一步是成功的，
            //   所以症状是"昨天还能用的插件今天全没了"，很难联想到这里。
            //   mkdir 的意图本来只是"确保目录存在"，
            //   已存在就是达成了目标，不该当成失败。
            //   ⚠️ 只放过"已存在"这一类错误：权限之类的照样要冒出来（不能整个吞掉）。
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

