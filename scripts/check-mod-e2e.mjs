// 端到端：真实服务 + 真实 zip 安装，验证用户报的两个症状都修好了。
//
// 用临时 MODS_DIR 不可行（serve.mjs 写死 web/mods），所以这里：
//   ① 先在临时目录里用真实的 createModManager 走"装带版本号的 zip"这条链
//   ② 再起真实服务，对真实的 web/mods 断言清单与资源可达
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModManager } from '../server/mods.mjs';
import { readZip, createZip, effectiveExt } from '../server/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

const tmp = [];
const newDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'e2e-')); tmp.push(d); return d; };

const mkMgr = (modsDir) => createModManager({
    modsDir,
    unzip: (buf, opts = {}) => readZip(buf, { ...opts, returnBlocked: true }),
    isUnsafeEntryName: (n) => n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..'),
    effectiveExt,
    log: () => {},
});

try {
    // ============================================================
    // 第一部分：安装链 —— 模拟用户从 Releases 下载带版本号的 zip 丢进 mods/
    // ============================================================
    console.log('=== 1. 用户下载 elaina-avatar-1.0.0.zip 丢进 mods/ ===');
    const modsDir = newDir();
    const zip = createZip([
        { name: 'manifest.json', data: Buffer.from(JSON.stringify({
            id: 'elaina-avatar', name: '伊蕾娜立绘与情绪', version: '1.0.0',
            entry: 'index.js', defaultEnabled: true, hidden: true,
        }), 'utf8') },
        { name: 'index.js', data: Buffer.from(
            'window.ElainaMods&&window.ElainaMods.register("elaina-avatar",function(host){'
            + 'if(host&&host.assetBase)window.__base=host.assetBase();return{};});', 'utf8') },
        { name: 'img/p_calm.png', data: Buffer.from('PNGDATA') },
    ]);
    writeFileSync(path.join(modsDir, 'elaina-avatar-1.0.0.zip'), zip);

    const mgr = mkMgr(modsDir);
    const r1 = await mgr.scanAndSync();

    const dirs = readdirSync(modsDir).filter((n) => !n.endsWith('.zip') && n !== 'index.json');
    ok(dirs.includes('elaina-avatar'), '★ 装成 elaina-avatar/（不是 elaina-avatar-1.0.0/）', JSON.stringify(dirs));
    ok(!dirs.includes('elaina-avatar-1.0.0'), '★ 没有留下带版本号的目录');
    const av = r1.installed.find((p) => p.id === 'elaina-avatar');
    ok(Boolean(av), '清单里 id 是 elaina-avatar');
    ok(av && av.dir === 'elaina-avatar', 'dir 与实际目录一致', av && av.dir);

    // 资源 URL（插件内部约定路径）能对上
    ok(existsSync(path.join(modsDir, 'elaina-avatar', 'img', 'p_calm.png')),
        '★ 立绘落在 /mods/elaina-avatar/img/p_calm.png 对应位置（不再 404）');

    console.log('\n=== 2. 再装 galgame（依赖 elaina-avatar） ===');
    const gdir = path.join(modsDir, 'galgame');
    (await import('node:fs')).mkdirSync(gdir, { recursive: true });
    writeFileSync(path.join(gdir, 'manifest.json'), JSON.stringify({
        id: 'galgame', name: 'Galgame 界面', version: '1.0.0', entry: 'index.js',
        styles: ['style.css'], defaultEnabled: false, after: ['elaina-avatar'],
    }));
    writeFileSync(path.join(gdir, 'index.js'), 'void 0;');
    writeFileSync(path.join(gdir, 'style.css'), '/* x */');

    const r2 = await mgr.scanAndSync();
    const ids = new Set(r2.installed.map((p) => p.id));
    const g = r2.installed.find((p) => p.id === 'galgame');
    ok(ids.has('elaina-avatar'), '★ 依赖目标 elaina-avatar 在清单里');
    ok(g && g.after.every((d) => ids.has(d)),
        '★ galgame 的 after 能解析（依赖不再失效）', g ? JSON.stringify(g.after) : '');

    // ============================================================
    // 第二部分：真实服务 —— 对真实 web/mods 断言清单与资源可达
    // ============================================================
    console.log('\n=== 3. 真实服务的清单与资源 ===');
    const DATA_DIR = newDir();
    const LOG_DIR = newDir();
    const PORT = await freePort();
    const HTTPS_PORT = await freePort();
    const BASE = `http://127.0.0.1:${PORT}`;

    const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT),
            HOST: '127.0.0.1', DATA_DIR, LOG_DIR, LOG_TO_FILE: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    try {
        let up = false;
        for (let i = 0; i < 80 && !up; i++) {
            try { up = (await fetch(BASE + '/api/server-info')).ok; } catch { await wait(250); }
        }
        ok(up, '服务已启动', up ? '' : out.slice(-300));

        if (up) {
            const api = await (await fetch(BASE + '/api/plugins')).json();
            ok(api.ok === true, '/api/plugins 可用');
            const plugins = api.plugins || [];
            for (const p of plugins) {
                console.log(`      id=${String(p.id).padEnd(16)} dir=${String(p.dir).padEnd(16)} after=${JSON.stringify(p.after)}`);
            }

            const avP = plugins.find((p) => p.id === 'elaina-avatar');
            ok(avP && typeof avP.dir === 'string' && avP.dir.length > 0,
                '★ 清单带 dir 字段（前端按它加载脚本）', avP && avP.dir);

            const ids = new Set(plugins.map((p) => p.id));
            for (const dep of ['galgame', 'pet']) {
                const m = plugins.find((p) => p.id === dep);
                if (!m) { ok(false, `${dep} 在清单里`); continue; }
                ok(m.after.every((d) => ids.has(d)), `★ ${dep} 的 after 可解析`, JSON.stringify(m.after));
            }

            // 按 dir 拼 URL 能取到脚本（这是前端 loadOne 的真实路径）
            for (const p of plugins) {
                const url = `/mods/${p.dir}/${p.entry || 'index.js'}`;
                const r = await fetch(BASE + url);
                ok(r.status === 200, `★ ${url} → 200`, 'status=' + r.status);
            }

            // 立绘图片可达 —— ★ 按清单里的**真实目录名**拼 URL，不写死 'elaina-avatar'
            //   （用户改了目录名时，写死的 URL 必然 404；那是检查的问题）
            const avEntry = plugins.find((p) => p.id === 'elaina-avatar');
            if (avEntry) {
                const enc = String(avEntry.dir || avEntry.id).split('/').map(encodeURIComponent).join('/');
                const img = await fetch(BASE + `/mods/${enc}/img/p_calm.png`);
                ok(img.status === 200,
                    `★ 立绘 /mods/${enc}/img/p_calm.png → 200（按真实目录）`, 'status=' + img.status);
                ok((img.headers.get('content-type') || '').startsWith('image/'),
                    '返回图片类型', img.headers.get('content-type'));
            } else {
                ok(false, '清单里有 elaina-avatar（才能验立绘）');
            }
        }
    } finally {
        child.kill();
        await wait(300);
    }
} finally {
    for (const d of tmp) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

// ============================================================
// 第三部分：★ 安卓侧插件可拆装（2026-10 用户要求："安卓我也要插件可拆装
//   而不是封装在 apk 安装包里面"）
//
// 电脑版的安装/卸载走服务端（上面两部分已覆盖）。安卓版**没有服务端** ——
// 它由 app-01-core.js 的 nativePluginsFetch 在页内用 Capacitor Filesystem
// 实现同一套接口语义。这一段把那条**原生链路**真的跑一遍：
//   安装 → 列表 → 删除 → 列表
//
// 为什么值得单独测：两端各有一套实现（server/mods.mjs 与 app-01-core.js），
// 而 APK 上没有服务端可对照 —— 原生这条链断了**不会有任何报错**，
// 只表现为"点了上传安装没反应"或"删了还在"。而且它依赖
// Capacitor Filesystem 的真实语义（writeFile 收 base64、readFile 按 encoding
// 解码、readdir 要 type 字段），这些语义用 mock 最容易写错。
// ============================================================
console.log('\n=== 3. 安卓侧：插件安装 / 列表 / 删除（页内原生实现）===');
{
    const core = readFileSync(path.join(ROOT, 'web', 'js', 'app-01-core.js'), 'utf8');
    const vm = await import('node:vm');

    /** 按大括号配对抠出函数（含前面的 async） */
    function extractFn(src, name) {
        let start = src.indexOf('function ' + name + '(');
        if (start < 0) throw new Error('找不到 ' + name);
        const asyncMatch = src.slice(Math.max(0, start - 12), start).match(/async\s+$/);
        if (asyncMatch) start -= asyncMatch[0].length;
        let i = src.indexOf('(', start), paren = 0;
        for (; i < src.length; i++) {
            if (src[i] === '(') paren++;
            else if (src[i] === ')') { paren--; if (paren === 0) { i++; break; } }
        }
        let depth = 0;
        i = src.indexOf('{', i);
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
        }
        return src.slice(start, i);
    }

    /** 内存版 Capacitor Filesystem —— 尽量贴近真实语义（见上面的说明） */
    function makeMemFs() {
        const files = new Map(); const dirs = new Set(['']);
        const norm = (p) => String(p || '').replace(/^\/+|\/+$/g, '');
        return {
            async mkdir({ path: p, recursive }) {
                const d = norm(p);
                if (recursive) { const parts = d.split('/'); for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
                else dirs.add(d);
            },
            async writeFile({ path: p, data, encoding }) {
                const d = norm(p);
                files.set(d, Buffer.from(data, encoding === 'utf8' ? 'utf8' : 'base64'));
                dirs.add(d.split('/').slice(0, -1).join('/'));
            },
            async readFile({ path: p, encoding }) {
                const d = norm(p);
                if (!files.has(d)) throw new Error('ENOENT ' + d);
                return encoding === 'utf8' ? files.get(d).toString('utf8') : files.get(d).toString('base64');
            },
            async readdir({ path: p }) {
                const d = norm(p); const out = [];
                for (const f of files.keys()) if (f.startsWith(d + '/') && !f.slice(d.length + 1).includes('/')) out.push({ name: f.slice(d.length + 1), type: 'file', size: files.get(f).length });
                for (const x of dirs) if (x && x.startsWith(d + '/') && !x.slice(d.length + 1).includes('/')) out.push({ name: x.slice(d.length + 1), type: 'directory' });
                if (!out.length && d && !dirs.has(d)) throw new Error('ENOENT ' + d);
                return { files: out };
            },
            async stat({ path: p }) {
                const d = norm(p);
                if (dirs.has(d)) return { type: 'directory' };
                if (files.has(d)) return { type: 'file', size: files.get(d).length };
                throw new Error('ENOENT ' + d);
            },
            async rmdir({ path: p }) {
                const d = norm(p);
                for (const k of [...files.keys()]) if (k === d || k.startsWith(d + '/')) files.delete(k);
                for (const k of [...dirs]) if (k === d || k.startsWith(d + '/')) dirs.delete(k);
            },
            async getUri({ path: p }) { return { uri: 'file:///data/' + norm(p) }; },
        };
    }

    const memFs = makeMemFs();
    const sandbox = {
        console, TextDecoder, TextEncoder, Response, Blob, Uint8Array, Promise, Error,
        JSON, Object, Array, String, Number, Boolean, Date, Math, RegExp, Set, Map,
        DecompressionStream,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    const pieces = [];
    for (const n of ['NATIVE_MOD_ID_RE', 'NATIVE_MODS_DIR', 'NATIVE_MOD_MAX_BYTES']) {
        const m = core.match(new RegExp('const ' + n + ' = [^\\n]+'));
        if (m) pieces.push(m[0]);
    }
    {
        const s = core.indexOf('const NATIVE_MOD_BLOCKED_EXT = new Set([');
        if (s >= 0) pieces.push(core.slice(s, core.indexOf(']);', s) + 3));
    }
    for (const fn of ['nativeFs', 'bytesToBase64', 'nativeWriteFile', 'nativeNormalizeModId',
        'nativeEffectiveExt', 'nativeReadModManifest', 'nativeListModFiles', 'nativeListPlugins',
        'nativeDeletePlugin', 'nativeInstallPlugin', 'nativePluginsFetch', 'unzipBrowser']) {
        try { pieces.push(extractFn(core, fn)); } catch (e) { ok(false, '抠出原生函数 ' + fn, e.message); }
    }
    vm.runInContext(pieces.join('\n\n'), sandbox);
    sandbox.nativeFs = () => memFs;

    // 造一个最小合法插件 zip（store 模式，不压缩）
    let CRC = null;
    const crc32 = (buf) => {
        if (!CRC) { CRC = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
        let c = 0xFFFFFFFF;
        for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    };
    const makeZip = (entries) => {
        const chunks = []; const central = []; let offset = 0;
        for (const [name, content] of entries) {
            const nameBuf = Buffer.from(name, 'utf8');
            const data = Buffer.from(content, 'utf8');
            const crc = crc32(data);
            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
            local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
            local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
            chunks.push(local, nameBuf, data);
            const cd = Buffer.alloc(46);
            cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
            cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20);
            cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28);
            cd.writeUInt32LE(offset, 42);
            central.push(cd, nameBuf);
            offset += local.length + nameBuf.length + data.length;
        }
        const cdBuf = Buffer.concat(central);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
        end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
        return Buffer.concat([...chunks, cdBuf, end]);
    };

    const zipBuf = makeZip([
        ['manifest.json', JSON.stringify({ id: 'e2etest', name: 'E2E 测试插件', version: '1.0.0', entry: 'index.js', defaultEnabled: false })],
        ['index.js', 'window.__e2e = true;'],
    ]);

    try {
        const installRes = await sandbox.nativePluginsFetch('/api/plugins/install?name=e2etest-1.0.0.zip', { method: 'POST', body: new Blob([zipBuf]) });
        const installJson = await installRes.json();
        ok(installJson.ok === true, '★ 安卓：上传安装成功', JSON.stringify(installJson));
        ok(installJson.id === 'e2etest', '★ 安卓：安装得到正确 id', String(installJson.id));

        const listJson = await (await sandbox.nativePluginsFetch('/api/plugins', { method: 'GET' })).json();
        const ids = (listJson.plugins || []).map((p) => p.id);
        ok(ids.includes('e2etest'), '★ 安卓：列表里能看到刚装的插件', JSON.stringify(ids));

        const delJson = await (await sandbox.nativePluginsFetch('/api/plugins/e2etest', { method: 'DELETE' })).json();
        ok(delJson.ok === true, '★ 安卓：卸载成功', JSON.stringify(delJson));

        const ids2 = ((await (await sandbox.nativePluginsFetch('/api/plugins', { method: 'GET' })).json()).plugins || []).map((p) => p.id);
        ok(!ids2.includes('e2etest'), '★ 安卓：卸载后列表里没有它了（真拆掉了）', JSON.stringify(ids2));

        // ★ 路径穿越必须被挡：这是"可拆装"带来的新攻击面
        const evil = await (await sandbox.nativePluginsFetch('/api/plugins/..%2F..%2Fdata', { method: 'DELETE' })).json();
        ok(evil.ok !== true, '★ 安卓：非法 id 的删除被拒绝（防目录穿越）', JSON.stringify(evil));
    } catch (e) {
        ok(false, '安卓侧安装链路跑通', String(e && e.message || e));
    }
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
