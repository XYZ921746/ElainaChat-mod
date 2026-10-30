/* ============================================================================
 * 原生（Capacitor APK）Live2D 模型存储适配（从 core.js 拆出）
 *
 * 这里只放页面内的原生文件系统实现；IS_NATIVE_APP / IS_MOBILE_DEVICE 仍由 core.js
 * 提供（经典脚本共享全局词法环境）。加载顺序：core-native.js → core.js。
 * ========================================================================== */
'use strict';

let nativeModelRootReady = false;
/**
 * 模型数据根（相对 Directory.Data 的路径）。
 *
 * 由内嵌服务回报的 modStatic 决定（播种目标与它同一份判据）：
 *   · 已启用的 live2d-models 声明了 /live2d/models → 插件目录（mods/<目录名>/models，
 *     与桌面版同一布局，node 侧的迁移也把存量模型挪到这里）；
 *   · 插件没装 / 没启用 / node 起不来 → 旧位置 live2d/models（原生兜底复刻只认它）。
 *
 * **所有**读写模型数据目录的地方（播种 / 列表 / 上传 / 删除）都走这一个变量 ——
 * 列表接口读哪、资源 base 指哪、上传写哪，三处必须同一处，否则"列表里有、
 * 加载 404"这种分叉只是时间问题。
 */
let nativeModelRelRoot = 'live2d/models';

function nativeFs() {
    return window.Capacitor?.Plugins?.Filesystem || null;
}

// 初始化本地模型目录并暴露 WebView 可访问的 base URL。
// 播种目标由内嵌服务回报的 modStatic 决定（见 nativeModelRelRoot 的说明），
// 所以这里要先等 __nodeReadyPromise —— node 起不来时它很快失败，
// __nodeModStatic 保持 undefined → 按旧位置走，兜底链路照常。
async function initNativeLive2dStorage() {
    if (!IS_NATIVE_APP) return;
    try {
        const fs = nativeFs();
        if (!fs) return;
        await window.__nodeReadyPromise;
        const entry = (Array.isArray(window.__nodeModStatic) ? window.__nodeModStatic : [])
            .find((s) => s && s.url === '/live2d/models');
        if (entry && entry.relPath !== undefined) {
            const rel = String(entry.relPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            // 宁可少一次播种，也不要往错的地方灌 40MB：路径不合法就整个跳过
            if (!rel || rel.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
                console.warn('[Native] modStatic 的模型目录路径不合法，跳过模型初始化:', entry.relPath);
                return;
            }
            nativeModelRelRoot = rel;
        }
        const dir = (fs.Directory && fs.Directory.Data) ? fs.Directory.Data : 'DATA';
        try { await fs.mkdir({ path: nativeModelRelRoot, directory: dir, recursive: true }); } catch (e) { /* 已存在则忽略 */ }
        const res = await fs.getUri({ path: nativeModelRelRoot, directory: dir });
        // file:///... → WebView 可访问的 https://localhost/_capacitor_file_/...
        if (window.Capacitor.convertFileSrc) {
            window.__nativeModelBase = window.Capacitor.convertFileSrc(res.uri) + '/';
        } else {
            window.__nativeModelBase = res.uri + '/';
        }
        nativeModelRootReady = true;
        console.log('[Native] Live2D 模型目录:', window.__nativeModelBase);
    } catch (e) {
        console.warn('[Native] 初始化模型存储失败', e);
    }
}

// 内置模型：随 APK 一起打包的只读副本（www/live2d/models/）。
// APK 里没有服务端，模型只能从本地取；这里在启动时按 manifest.json 把内置模型
// 复制进应用数据目录，之后列表扫描与资源寻址跟用户上传的模型完全同路，无需另做适配。
// 只补"缺的 / 大小对不上的"文件，已完整的模型一律不动 —— 既不覆盖用户自己传的同名模型，
// 又能在上次播种中途失败时自愈（见下面的逐项核对）。
async function seedBundledLive2dModels() {
    if (!IS_NATIVE_APP || !nativeModelRootReady) return;
    const fs = nativeFs();
    if (!fs) return;
    const dir = (fs.Directory && fs.Directory.Data) ? fs.Directory.Data : 'DATA';
    let manifest;
    try {
        const res = await fetch('/live2d/models/manifest.json', { cache: 'no-store' });
        if (!res.ok) return; // 没有打包模型是正常情况，不是错误
        manifest = await res.json();
    } catch (e) {
        console.warn('[Native] 读取内置模型清单失败', e);
        return;
    }
    const models = Array.isArray(manifest && manifest.models) ? manifest.models : [];
    if (!models.length) return;
    for (const entry of models) {
        const name = String((entry && entry.name) || '');
        const files = Array.isArray(entry && entry.files) ? entry.files : [];
        if (!name || !files.length) continue;
        const sizes = (entry && entry.sizes && typeof entry.sizes === 'object') ? entry.sizes : null;
        // 数据目录里已有的文件（相对路径 → 字节数）。
        // 判断"要不要种"不能只看目录非空：上一次播种中途失败（写入报错、进程被杀、
        // 存储写满）会留下半套文件，目录非空但模型是坏的 —— 只判非空的话这种坏状态
        // 永远修不回来。所以按清单逐项核对：缺的、以及字节数对不上的，都补种。
        const existing = new Map();
        for (const f of await nativeCollectModelFiles(fs, dir, nativeModelRelRoot + '/' + name)) {
            existing.set(f.rel, f.size);
        }
        const pending = [];
        for (const rawRel of files) {
            const rel = String(rawRel).replace(/\\/g, '/').replace(/^\.?\//, '');
            if (!rel || rel.split('/').includes('..')) continue; // 防目录穿越
            if (!existing.has(rel)) { pending.push(rel); continue; }
            // 清单带 sizes 时按字节数核对（能抓出写了一半的坏文件）；没有则只按文件名
            const want = sizes && sizes[rel] != null ? Number(sizes[rel]) : null;
            if (want != null && existing.get(rel) !== want) pending.push(rel);
        }
        if (!pending.length) continue; // 文件齐、大小也对 → 不动它（不覆盖用户自己的东西）
        let written = 0;
        for (const rel of pending) {
            const encoded = rel.split('/').map(encodeURIComponent).join('/');
            try {
                const res = await fetch('/live2d/models/' + encodeURIComponent(name) + '/' + encoded);
                if (!res.ok) continue;
                const bytes = new Uint8Array(await res.arrayBuffer());
                await nativeWriteFile(nativeModelRelRoot + '/' + name + '/' + rel, dir, bytes);
                written++;
            } catch (e) {
                console.warn('[Native] 内置模型文件写入失败:', rel, e);
            }
        }
        console.log('[Native] 内置模型「' + name + '」补齐:', written + '/' + pending.length, '个文件（清单共', files.length, '个）');
    }
}

// 字节 → base64（分块，避免大数组栈溢出）
function bytesToBase64(bytes) {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return btoa(binary);
}

// 分块写入大文件（Capacitor bridge 对单次 base64 有限制）
async function nativeWriteFile(path, directory, data) {
    const fs = nativeFs();
    const b64 = bytesToBase64(data);
    const CHUNK = 1024 * 1024; // 1MB base64
    let offset = 0;
    let first = true;
    while (offset < b64.length) {
        const part = b64.slice(offset, offset + CHUNK);
        if (first) {
            await fs.writeFile({ path, directory, data: part, recursive: true });
            first = false;
        } else {
            await fs.appendFile({ path, directory, data: part });
        }
        offset += CHUNK;
    }
}

// 递归列出模型目录下的文件，返回 [{ rel, size }]（rel 是相对模型根目录的路径，正斜杠分隔）。
// 与服务端 collectModelFiles 保持同一套语义：表情/动作不保证放在固定子目录里，
// Cubism 只规定 *.exp3.json / *.motion3.json 的文件格式，放哪由模型作者决定。
// 内置的 deepseek 就把 44 个 *.exp3.json 堆在模型根目录、动作放在 motions/，
// 早期"只扫 exp/ 子目录"的写法因此一个都列不出来。深度设上限防病态目录树。
// 顺带带出 size：readdir 本来就返回它，播种时用它校验已种文件是否完整，不额外多一次调用。
async function nativeCollectModelFiles(fs, dir, basePath, relPath = '', depth = 0) {
    if (depth > 3) return [];
    let listing;
    try { listing = await fs.readdir({ path: relPath ? basePath + '/' + relPath : basePath, directory: dir }); }
    catch (e) { return []; }
    const out = [];
    for (const f of (listing.files || [])) {
        const rel = relPath ? relPath + '/' + f.name : f.name;
        if (f.type === 'directory') out.push(...await nativeCollectModelFiles(fs, dir, basePath, rel, depth + 1));
        else out.push({ rel, size: Number(f.size) || 0 });
    }
    return out;
}

// 浏览器端 zip 解压（store + deflate-raw，支持 UTF-8/GBK 文件名、data descriptor）
async function unzipBrowser(buf) {
    const files = [];
    let off = 0;
    const readU16 = (b, o) => (b[o] | (b[o + 1] << 8)) >>> 0;
    const readU32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    while (off + 30 <= buf.length) {
        const sig = readU32(buf, off);
        if (sig === 0x02014b50 || sig === 0x06054b50) break; // central dir / EOCD
        if (sig !== 0x04034b50) break;
        const flags = readU16(buf, off + 6);
        const method = readU16(buf, off + 8);
        const compSize = readU32(buf, off + 18);
        const nameLen = readU16(buf, off + 26);
        const extraLen = readU16(buf, off + 28);
        const nameRaw = buf.slice(off + 30, off + 30 + nameLen);
        let name = new TextDecoder('utf-8').decode(nameRaw);
        if (name.includes('\uFFFD')) {
            try { name = new TextDecoder('gbk').decode(nameRaw); } catch (e) { /* 保留原样 */ }
        }
        let dataStart = off + 30 + nameLen + extraLen;
        let comp;
        if (flags & 0x8) {
            let found = -1;
            for (let i = dataStart; i + 4 <= buf.length; i++) {
                if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x07 && buf[i + 3] === 0x08) { found = i; break; }
            }
            comp = found >= 0 ? buf.slice(dataStart, found) : buf.slice(dataStart);
            off = found >= 0 ? found + 16 : buf.length;
        } else {
            comp = buf.slice(dataStart, dataStart + compSize);
            off = dataStart + compSize;
        }
        if (name.endsWith('/')) continue;
        let data;
        if (method === 0) data = comp;
        else if (method === 8) {
            const ds = new DecompressionStream('deflate-raw');
            const stream = new Blob([comp]).stream().pipeThrough(ds);
            data = new Uint8Array(await new Response(stream).arrayBuffer());
        } else continue;
        files.push({ name, data });
    }
    return files;
}

// 原生模式下 /api/live2d/* 的本地实现
/**
 * 从**随 APK 打包的** manifest.json 直接列出内置模型。
 *
 * <p>为什么需要这条兜底：正常路径是"先把内置模型播种到应用数据目录，再从那个目录列出来"。
 * 但播种依赖 Capacitor 的 Filesystem 插件 —— 一旦它不可用（插件没注册成功、权限被拒、
 * 存储写满、ROM 限制），`nativeFs()` 返回 null，播种整段被跳过，**列表就是空的**，
 * 用户看到「（未上传模型）」，而模型其实明明就在 APK 里（assets 里有完整副本）。
 *
 * <p>打包进 APK 的模型本来就能通过 `/live2d/models/...` 直接读到（它是 WebView 的静态资源，
 * 不需要任何原生插件）。所以这里按 manifest 把清单直接拼成模型列表 —— 不碰文件系统。
 * 这是"至少让内置模型能用"的保证：上传功能可能坏，内置的不该跟着一起坏。
 */
async function bundledManifestModels() {
    try {
        const res = await fetch('/live2d/models/manifest.json', { cache: 'no-store' });
        if (!res.ok) return [];
        const manifest = await res.json();
        const list = Array.isArray(manifest && manifest.models) ? manifest.models : [];
        const out = [];
        for (const entry of list) {
            const name = String((entry && entry.name) || '');
            const files = Array.isArray(entry && entry.files) ? entry.files.map(String) : [];
            if (!name || !files.length) continue;
            // manifest 里 modelJson 是文件名；没有就在 files 里找
            let modelJson = String((entry && entry.modelJson) || '');
            if (!modelJson) {
                modelJson = files.find((f) => !f.includes('/') && f.toLowerCase().endsWith('.model3.json'))
                    || files.find((f) => f.toLowerCase().endsWith('.model3.json')) || '';
            }
            if (!modelJson) continue;
            const vtube = files.find((f) => !f.includes('/') && f.toLowerCase().endsWith('.vtube.json'))
                || files.find((f) => f.toLowerCase().endsWith('.vtube.json')) || null;
            out.push({
                name,
                modelJson,
                exps: files.filter((f) => f.toLowerCase().endsWith('.exp3.json')).sort(),
                motions: files.filter((f) => f.toLowerCase().endsWith('.motion3.json')).sort(),
                vtube,
                bundled: true,   // 标记来源：资源从 assets 取，不依赖数据目录
            });
        }
        return out;
    } catch (e) {
        return [];
    }
}

async function nativeLive2dFetch(url, options) {
    const method = (options && options.method) || 'GET';
    const fs = nativeFs();
    const dir = (fs && fs.Directory && fs.Directory.Data) ? fs.Directory.Data : 'DATA';

    // 假 Response。**必须同时有 json() 和 text()** ——
    // 调用方不只用 json()：设置面板走的是 readJsonSafe()，它第一行就是 `await res.text()`
    // （为了在服务端返回非 JSON 时给出能看懂的报错）。早期这里只实现了 json()，
    // 于是设置里的模型列表**静默为空**（TypeError 被 catch 吞掉，显示「未上传模型」），
    // 而模型其实好好地躺在 APK 里。视频通话那条路只用 json()，所以它当时是好的 ——
    // 这也是为什么这个 bug 特别难发现：同一个接口，两条调用路径，只有一条炸。
    const makeRes = (status, obj) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => obj,
        text: async () => JSON.stringify(obj),
    });
    const json = (obj) => makeRes(200, obj);
    try {
        if (url === '/api/live2d/models' && method === 'GET') {
            let entries;
            try { entries = await fs.readdir({ path: nativeModelRelRoot, directory: dir }); } catch (e) { entries = { files: [] }; }
            const models = [];
            for (const e of (entries.files || [])) {
                if (e.type && e.type !== 'directory') continue;
                const modelName = e.name;
                try {
                    const files = (await nativeCollectModelFiles(fs, dir, nativeModelRelRoot + '/' + modelName)).map(f => f.rel);
                    // model3.json / vtube.json 优先取根目录下的，避免纹理等子目录里的同名文件抢走
                    const pickRoot = (pred) => files.find(f => !f.includes('/') && pred(f)) || files.find(pred) || null;
                    const modelJson = pickRoot(f => f.toLowerCase().endsWith('.model3.json'));
                    if (!modelJson) continue;
                    const vtube = pickRoot(f => f.toLowerCase().endsWith('.vtube.json'));
                    // exps/motions 返回「相对模型根目录的路径」，客户端据此拼资源地址
                    const exps = files.filter(f => f.toLowerCase().endsWith('.exp3.json')).sort();
                    const motions = files.filter(f => f.toLowerCase().endsWith('.motion3.json')).sort();
                    models.push({ name: modelName, modelJson, exps, motions, vtube });
                } catch (e) { /* 跳过坏目录 */ }
            }

            // 合并**打包进 APK 的**内置模型。
            // 正常情况（播种成功）下，数据目录里已经有这些模型了，按名字去重后不会有变化。
            // 但播种一旦失败（Filesystem 插件不可用、权限被拒、存储写满、ROM 限制），
            // 数据目录是空的 —— 此时内置模型不该跟着一起消失：它们就在 assets 里，
            // 不依赖任何原生插件。宁可只能看内置模型，也不要让用户对着
            // 一句「（未上传模型）」以为 APK 里没带模型。
            // 用合并而不是"空了才兜底"：否则用户一旦自己上传了模型（目录非空），
            // 内置的那两个就会从列表里消失 —— 那是个更奇怪的 bug。
            // 同名时以数据目录里的为准（用户可能改过 / 重命名过，资产也从数据目录取）。
            try {
                const have = new Set(models.map((m) => m.name));
                const bundled = await bundledManifestModels();
                let added = 0;
                for (const b of bundled) {
                    if (have.has(b.name)) continue;
                    models.push(b);
                    added++;
                }
                if (added) {
                    console.log('[Native] 补入打包内置模型 ' + added + ' 个（数据目录里没有）');
                }
            } catch (e) { /* 没有打包模型是正常情况 */ }

            return json({ ok: true, models });
        }
        if (url === '/api/live2d/upload' && method === 'POST') {
            const body = options && options.body;
            if (!body) return makeRes(400, { ok: false, message: '无文件' });
            const buf = new Uint8Array(body instanceof Blob ? await body.arrayBuffer() : await new Response(body).arrayBuffer());
            const files = await unzipBrowser(buf);
            if (!files.length) return makeRes(400, { ok: false, message: 'zip 为空或无法解析' });
            const modelFile = files.find(f => f.name.toLowerCase().endsWith('.model3.json'));
            if (!modelFile) return makeRes(400, { ok: false, message: 'zip 内没有 .model3.json（需 Cubism3 模型）' });
            const safeId = 'model_' + Date.now().toString(36);
            const baseDir = nativeModelRelRoot + '/' + safeId;
            // 去掉 zip 内的顶层目录（若有）
            const topDir = (() => {
                const first = files[0].name;
                const idx = first.indexOf('/');
                if (idx > 0 && files.every(f => f.name.startsWith(first.slice(0, idx + 1)))) return first.slice(0, idx + 1);
                return '';
            })();
            let written = 0;
            for (const f of files) {
                const rel = topDir ? f.name.slice(topDir.length) : f.name;
                if (!rel) continue;
                const fullPath = baseDir + '/' + rel.replace(/\\/g, '/');
                await nativeWriteFile(fullPath, dir, f.data);
                written++;
            }
            const displayName = modelFile.name.split('/').pop().replace(/\.model3\.json$/i, '') || safeId;
            return json({ ok: true, modelName: safeId, displayName, files: written });
        }
        const delMatch = String(url).match(/^\/api\/live2d\/models\/([^/]+)$/);
        if (delMatch && method === 'DELETE') {
            await fs.rmdir({ path: nativeModelRelRoot + '/' + delMatch[1], directory: dir, recursive: true });
            return json({ ok: true, deleted: delMatch[1] });
        }
        return makeRes(404, { ok: false, message: 'Not found' });
    } catch (err) {
        return makeRes(500, { ok: false, message: err.message || String(err) });
    }
}



window.ElainaCoreNative = { nativeFs, initNativeLive2dStorage, seedBundledLive2dModels, nativeLive2dFetch };
