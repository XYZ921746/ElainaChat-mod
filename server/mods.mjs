// 插件（mod）的服务端支持：扫描目录 / 自动解压 zip / 生成清单 / 安装与卸载。浏览器无法列目录，所以清单由服务端扫描生成 —— 丢个 zip 进 mods/ 即安装。
// 安全边界：mod 是在同源下执行第三方 JS，解压必须防路径穿越、只能写进 mods/<id>/、拦掉 .exe 等本机可执行文件（.js 必须放行，它是插件本体）。

import { readdir, stat, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';

/** 插件 id：只允许 ASCII 字母数字与 . _ -（要进 localStorage 键名、资源 URL、依赖匹配，比目录名收得紧）；目录名另用 MOD_DIR_RE，共用正则会让中文目录扫不到 */
export const MOD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 插件目录名（比 id 宽松）：允许中文/空格/括号，只挡路径分隔符与 ..、前导点、Windows 建不出或访问不了的字符、以及会被静默吃掉的尾随点/首尾空白，长度上限 128 */
const MOD_DIR_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,128}$/;
export function isSafeModDirName(name) {
    const n = String(name || '');
    if (!n || n === '.' || n === '..') return false;
    if (n.startsWith('.')) return false;              // 隐藏目录 / . ..
    if (n !== n.trim()) return false;                 // 首尾空白
    if (/[. ]$/.test(n)) return false;                // 尾随点/空格（Windows 会吃掉）
    if (n.includes('..')) return false;               // 防穿越（配合上面的分隔符检查）
    return MOD_DIR_RE.test(n);
}

/** 把 zip 文件名归一化成插件 id：只剥多段版本号尾（-1.0 / -1.0.0），不剥单段（-2）—— `my-mod-2` 这类名字很常见，剥了会误伤真实名字；归一化放在安装端而不是让打包去掉版本号（Releases 文件名需要它区分版本），剥完不合法则原样返回，交由白名单报错 */
export function normalizeModId(rawName) {
    const base = String(rawName || '').replace(/\.zip$/i, '');
    const stripped = base.replace(/-[0-9]+\.[0-9]+(\.[0-9]+)*$/, '');
    return (MOD_ID_RE.test(stripped) && MOD_ID_RE.test(base)) ? stripped : base;
}

export const MOD_BLOCKED_EXT = new Set([
    '.exe', '.dll', '.com', '.scr', '.msi', '.bat', '.cmd',
    '.ps1', '.psm1', '.vbs', '.wsf', '.jar', '.sh', '.app', '.deb', '.rpm',
]);

const MOD_MAX_BYTES = 64 * 1024 * 1024;

/** 插件管理器。unzip / isUnsafeEntryName / effectiveExt 复用 serve.mjs 里那份（已含体积与类型校验），安全规则不出现第二份实现 */
export function createModManager({ modsDir, unzip, isUnsafeEntryName, effectiveExt, log = () => {} }) {
    const INDEX_FILE = path.join(modsDir, 'index.json');

    /** 最近一次扫描的安装结果缓存：zip 装成功后会被删掉，下一次扫描 zips 为空，结果只能留在这里（尤其"哪些文件被拦下了"）；用时间窗而非"读一次就清"，因为前端可能先后请求 /mods/index.json 与 /api/plugins，先到的那次会把结果吃掉 */
    let installReport = { at: 0, results: [] };
    const INSTALL_REPORT_TTL = 5 * 60 * 1000;   // 5 分钟，足够用户打开设置页看到
    let indexWriteQueue = Promise.resolve();
    /** 同一插件目录的安装链：见 writePluginFiles 的包装 */
    const installChains = new Map();
    /** 安装临时目录多久算「陈旧」：扫描在 /api/plugins 与 /mods/index.json 上都会跑，
        正在安装的 staging 目录还很新，无条件删会让安装中途丢掉自己正在写的文件。 */
    const INSTALL_STAGING_STALE_MS = 10 * 60 * 1000;

    /** 读 manifest.json（优先）或从目录名推断：id 的权威来源是 manifest.id（插件作者声明的身份，也是资源路径与依赖引用的基准），只有缺失/非法时才回落到目录名并走 normalizeModId 剥版本号；MOD_ID_RE 校验必须保留 —— manifest 是外部输入，不能直接信 */
    async function readManifest(dir, fallbackId) {
        const mf = path.join(dir, 'manifest.json');
        try {
            const raw = await readFile(mf, 'utf8');
            const m = JSON.parse(raw);
            if (m && typeof m === 'object') {
                const declared = typeof m.id === 'string' ? m.id.trim() : '';
                if (declared && MOD_ID_RE.test(declared)) return { ...m, id: declared };
                if (declared) {
                    log(`插件 ${fallbackId} 的 manifest.id 不合法（${declared}），回落到目录名`);
                }
                return { ...m, id: normalizeModId(fallbackId) };
            }
        } catch (e) {
            if (e && e.code !== 'ENOENT') log('插件 manifest.json 解析失败：' + dir + ' —— ' + e.message);
        }
        return {
            id: normalizeModId(fallbackId),
            name: fallbackId, version: '', description: '', entry: 'index.js',
        };
    }

    /** 从内存里的 zip 安装插件（应用内上传）：与 extractPluginZip 只有数据来源不同（磁盘文件 / Buffer），安全逻辑完全一致，两者都走 writePluginFiles。 */
    async function installFromBuffer(buf, id) {
        if (!MOD_ID_RE.test(id)) throw new Error('插件名不合法：' + id);
        if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip 文件');
        return writePluginFiles(buf, id);
    }

    /** 同一插件目录的安装串行化：两个请求各自「删旧目录 + 重命名」会交错，Windows 上第二个 rename 直接 EPERM。
        排队而不是拒绝：调用方各自会重扫，串行后两次安装都完整。 */
    function writePluginFiles(buf, id) {
        const prev = installChains.get(id) || Promise.resolve();
        const run = prev.then(() => writePluginFilesNow(buf, id), () => writePluginFilesNow(buf, id));
        const tail = run.catch(() => {});
        installChains.set(id, tail);
        tail.finally(() => { if (installChains.get(id) === tail) installChains.delete(id); });
        return run;
    }

    /** 解压并落盘（extractPluginZip 与 installFromBuffer 的公共实现）：id 先过白名单，每条目解析后的绝对路径必须仍在插件目录内，危险的可执行类型跳过，总体积封顶；抽成一份是为了让"从文件装"和"从上传装"走同一条安全路径 */
    async function writePluginFilesNow(buf, id) {
        // allowScripts: true —— mod 的本质就是 JS（默认黑名单会拦掉 .js/.mjs，解 mod 包会得到只有 manifest.json 的残缺插件）；路径穿越 / 绝对路径 / 体积上限 / .exe 等仍全部拦截。
        const { files } = unzip(buf, { allowScripts: true });

        const targetDir = path.join(modsDir, id);
        // 先写临时目录、全部落盘后再整体 rename：扫描认的是"目录存在就算已安装"，直接写 mods/<id>/ 会出现 index.js 还没写完、前端就先请求它的中间态；临时目录名以 . 开头，会被扫描器的 isSafeModDirName 跳过，天然不会被认成插件。
        const stagingDir = path.join(modsDir, `.installing-${id}-${process.pid}-${Date.now()}`);
        await rm(stagingDir, { recursive: true, force: true });
        await mkdir(stagingDir, { recursive: true });

        // zip 内可能有一层与插件同名的顶层目录 —— 去掉它，把文件平铺到插件目录
        const topCandidates = new Set(files.map((f) => f.name.split('/')[0]));
        const stripTop = topCandidates.size === 1 && files.every((f) => f.name.includes('/'));

        let written = 0;
        let total = 0;
        const skipped = [];
        for (const f of files) {
            let rel = f.name;
            if (stripTop) rel = rel.slice(rel.indexOf('/') + 1);
            if (!rel || rel.endsWith('/')) continue;
            if (isUnsafeEntryName(rel)) { skipped.push(f.name); continue; }

            const outPath = path.join(stagingDir, rel);
            // 双保险：解析后的绝对路径必须仍在插件目录内
            if (outPath !== stagingDir && !outPath.startsWith(stagingDir + path.sep)) {
                skipped.push(f.name);
                continue;
            }
            // 拦掉本机可执行类型（用 effectiveExt：能识破 x.exe::$DATA 这类写法）
            if (MOD_BLOCKED_EXT.has(effectiveExt(path.basename(rel)))) {
                skipped.push(f.name);
                continue;
            }
            total += f.data.length;
            if (total > MOD_MAX_BYTES) {
                await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
                throw new Error('插件解压后超过 ' + Math.round(MOD_MAX_BYTES / 1024 / 1024) + 'MB 上限');
            }
            await mkdir(path.dirname(outPath), { recursive: true });
            await writeFile(outPath, f.data);
            written++;
        }
        if (!written) {
            await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
            throw new Error('zip 内没有可用文件');
        }
        // 同卷 rename 是原子的，扫描器要么看不到、要么看到完整的一份；重装语义：先清空旧目录再 rename，否则会留下上一次安装的残留文件（没清单条目，「删插件」也删不到它们）。
        try {
            await rm(targetDir, { recursive: true, force: true });
            await rename(stagingDir, targetDir);
        } catch (err) {
            await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
            throw err;
        }
        if (skipped.length) log('插件 ' + id + ' 跳过 ' + skipped.length + ' 个不安全/不允许的条目');
        return { id, written, skipped: skipped.length };
    }

    async function extractPluginZip(zipPath, id) {
        if (!MOD_ID_RE.test(id)) throw new Error('插件名不合法：' + id);
        const buf = await readFile(zipPath);
        return writePluginFiles(buf, id);
    }

    /** 把已安装目录映射成清单条目：id 是归一化身份（用于 after 依赖与资源 URL），dir 是磁盘真实目录名（前端拼 URL 用）；两者可能不一致（A9）。 */
    async function buildPluginList(installed) {
        const list = [];
        for (const it of installed) {
            const m = await readManifest(it.dir, it.id);
            const dirName = path.basename(it.dir);
            list.push({
                id: m.id,
                dir: dirName,
                name: m.name || m.id,
                version: m.version || '',
                description: m.description || '',
                entry: m.entry || 'index.js',
                // scripts：额外脚本文件（按顺序注入，entry 仍是第一个），让插件能拆成注册装配 / 设置面板 / 实现主体几个文件
                scripts: Array.isArray(m.scripts) ? m.scripts.filter((s) => typeof s === 'string' && s) : [],
                styles: Array.isArray(m.styles) ? m.styles : [],
                // 默认关闭（与 web/js/mods.js 的 isModEnabled 同语义）：只有显式写 "defaultEnabled": true 才算开 —— 插件会改动界面，不该在用户不知情时生效
                defaultEnabled: m.defaultEnabled === true,
                after: Array.isArray(m.after) ? m.after : [],
                hidden: m.hidden === true,
                // 前端 host API 能力组（AGENTS.md D18 / 表 A22）：必须带出去 —— createHostApi 靠它决定下发哪些成员，漏了插件声明的能力会静默失效
                ...(Array.isArray(m.capabilities) && m.capabilities.length
                    ? { capabilities: m.capabilities.filter((s) => typeof s === 'string' && s) }
                    : {}),
                // 服务端半边（路由 / 上传目录）的声明原样带出去交给 serve.mjs 装配，合法性由 server/mod-server.mjs 判定 —— 扫描器不该长着"路由前缀怎么写才合法"的知识
                ...(m.server && typeof m.server === 'object' && !Array.isArray(m.server) ? { server: m.server } : {}),
                hasManifest: await exists(path.join(it.dir, 'manifest.json')),
            });
        }
        return list;
    }

    async function scanAndSync() {
        await mkdir(modsDir, { recursive: true }).catch(() => {});
        const entries = await readdir(modsDir, { withFileTypes: true }).catch(() => []);

        // 顺手清掉安装中途留下的 `.installing-*` 临时目录：进程被杀时它会留在磁盘上，隐藏、不会被扫成插件，但白占几十 MB 且用户看不见。
        // 只清陈旧的：扫描可能在别人的安装请求进行中被调用（插件列表 / 清单都会触发），删掉新鲜的 staging 等于替对方删掉半成品。
        const stale = [];
        for (const e of entries) {
            if (!e.isDirectory() || !e.name.startsWith('.installing-')) continue;
            try {
                const st = await stat(path.join(modsDir, e.name));
                if (Date.now() - st.mtimeMs >= INSTALL_STAGING_STALE_MS) stale.push(e.name);
            } catch (e) { /* 目录已被并发安装改名/删除：下一轮再说 */ }
        }
        if (stale.length) {
            for (const name of stale) {
                await rm(path.join(modsDir, name), { recursive: true, force: true }).catch(() => {});
            }
            log('清理了 ' + stale.length + ' 个安装未完成的临时目录');
            entries.splice(0, entries.length, ...await readdir(modsDir, { withFileTypes: true }).catch(() => []));
        }

        const installed = [];   // { id, dir }
        const zips = [];
        for (const e of entries) {
            if (e.name === 'index.json') continue;
            if (e.isDirectory()) {
                // 目录名用 isSafeModDirName（宽松，允许中文/空格）而不是 MOD_ID_RE：把插件目录改成「桌宠」是合理命名，严格 ASCII 正则会直接扫不到它
                if (!isSafeModDirName(e.name)) {
                    log(`跳过目录 ${e.name}：名字含不安全字符或非法形式`);
                    continue;
                }
                installed.push({ id: e.name, dir: path.join(modsDir, e.name) });
            } else if (e.isFile() && /\.zip$/i.test(e.name)) {
                zips.push(e.name);
            }
        }

        // 装成功后删掉 zip（一次性安装包）：zip 只要还在，每次扫描都会重新解压，用户手动删掉插件目录后下一次扫描又把它装回来（表现为"卸载了还在"）；删掉后语义清楚：目录存在 = 已安装，要重装就再放一次 zip；安装结果另存 installReport，供用户看到"哪些文件被拦下了"。
        const installResults = [];
        for (const z of zips) {
            // id 先剥版本号再校验：产物名形如 `elaina-avatar-1.0.0.zip`，直接当 id 会让资源 URL 与 after 依赖同时失效（见 normalizeModId）
            const id = normalizeModId(z);
            if (!MOD_ID_RE.test(id)) {
                installResults.push({ zip: z, ok: false, error: '插件名不合法（只允许字母数字、- _ .）' });
                continue;
            }
            // 若归一化后的目录已存在（用户重复放了不同版本的包），明确报出来而不是静默覆盖 —— 覆盖会把用户已有的设置一并带走。
            const targetDir = path.join(modsDir, id);
            const alreadyInstalled = installed.some((i) => i.id === id);
            if (alreadyInstalled) {
                installResults.push({ zip: z, ok: false, error: `插件 ${id} 已安装（如需更新请先卸载）` });
                await rm(path.join(modsDir, z), { force: true }).catch(() => {});
                log(`跳过 ${z}：${id} 已安装，安装包已清理`);
                continue;
            }
            try {
                const r = await extractPluginZip(path.join(modsDir, z), id);
                installResults.push({ zip: z, ok: true, id: r.id, files: r.written });
                if (!alreadyInstalled) installed.push({ id, dir: targetDir });
                await rm(path.join(modsDir, z), { force: true }).catch(() => {});
                log('已安装插件：' + id + '（' + r.written + ' 个文件，安装包已清理）');
            } catch (err) {
                installResults.push({ zip: z, ok: false, error: String((err && err.message) || err) });
                log('插件安装失败：' + z + ' —— ' + installResults[installResults.length - 1].error);
                // 失败的 zip **保留** —— 用户要能看到它、修好再重试；删掉的话"装失败"就变成"文件凭空消失"，更难排查。
            }
        }

        const list = await buildPluginList(installed);

        // 写清单时保留手工维护的额外字段（比如注释），只覆盖 plugins 数组；写盘必须串行 + 临时文件 rename —— 两次扫描并发 read-modify-write 会互相覆盖，读端还会撞到写了一半的 JSON。
        indexWriteQueue = indexWriteQueue.then(async () => {
            let prev = {};
            try { prev = JSON.parse(await readFile(INDEX_FILE, 'utf8')); } catch { /* 首次运行 */ }
            const out = {
                ...(prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}),
                comment: '本文件由服务端扫描 mods/ 自动生成（见 server/mods.mjs）。手工改动会在下次扫描时被覆盖。',
                generatedAt: new Date().toISOString(),
                plugins: list,
            };
            const tmp = INDEX_FILE + '.tmp';
            await writeFile(tmp, JSON.stringify(out, null, 2), 'utf8');
            await rename(tmp, INDEX_FILE);
        }).catch((err) => { log('插件清单写入失败：' + String((err && err.message) || err)); });
        await indexWriteQueue;

        // 安装结果的留存：本次装了东西就记下并刷新时间戳；没装则返回未过期的缓存结果，让"装完 → 打开设置页"仍能看到
        if (installResults.length) {
            installReport = { at: Date.now(), results: installResults };
        }
        const fresh = Date.now() - installReport.at < INSTALL_REPORT_TTL;
        const results = installResults.length
            ? installResults
            : (fresh ? installReport.results : []);

        return { installed: list, results };
    }

    async function exists(p) {
        try { await stat(p); return true; } catch { return false; }
    }

    /** 读插件的 README（供插件页「说明」按钮）：文件名走白名单，不接受前端传任意名字 —— 否则等于开放"读插件目录里任意文件"，会读到 manifest 等私有内容；大小上限 256KB（超过说明传错了文件，或有人拿它当传输通道） */
    const README_NAMES = ['README.md', 'readme.md', 'README.txt', 'readme.txt', 'README', '说明.md'];
    async function readReadme(id) {
        if (!MOD_ID_RE.test(id)) return { ok: false, message: '插件名不合法' };
        // 目录名是安装时的包名（如 birthday-1.1.0），id 来自 manifest（如 birthday），用 id 直接拼路径会让带版本号的目录永远读不到 README（见表 A9）
        const dir = await findModDirById(id);
        if (!dir) return { ok: false, message: '没有找到插件「' + id + '」的目录（可能已经被删掉了）' };
        const resolved = path.resolve(dir);
        if (resolved !== modsDir && !resolved.startsWith(modsDir + path.sep)) {
            return { ok: false, message: '路径越界' };
        }
        for (const name of README_NAMES) {
            const p = path.join(resolved, name);
            const info = await stat(p).catch(() => null);
            if (!info || !info.isFile()) continue;
            if (info.size > 256 * 1024) return { ok: false, message: '说明文件过大（超过 256KB），已拒绝读取' };
            try {
                const text = await readFile(p, 'utf8');
                return { ok: true, name, text };
            } catch (e) {
                return { ok: false, message: '读取失败：' + String((e && e.message) || e) };
            }
        }
        return { ok: false, message: '该插件没有 README 文件' };
    }

    /**
     * 卸载：删插件目录以及对应的安装包 —— 只删目录的话紧接着的 scanAndSync() 会把 zip 重新解压装回来。
     * 目录名 ≠ 插件 id（A9）：不能用 id 直接拼路径 —— 拼出不存在的路径时 rm 的 force 是静默成功、会回 ok 而插件原封不动，所以必须按 id 反查真实目录，查不到就明确报错；删完还要确认目录真的没了（文件被占用时 Windows 会留下半删目录，继续返回成功又是一次谎报）。
     */
    async function uninstall(id) {
        if (!MOD_ID_RE.test(id)) throw new Error('插件名不合法');
        const dir = await findModDirById(id);
        if (!dir) throw new Error('没有找到插件「' + id + '」的目录（可能已经被删掉了）');
        const resolved = path.resolve(dir);
        if (resolved !== modsDir && !resolved.startsWith(modsDir + path.sep)) {
            throw new Error('路径越界');
        }
        await rm(resolved, { recursive: true, force: true });
        if (await stat(resolved).then(() => true, () => false)) {
            throw new Error('插件目录没能删掉（可能有程序正在占用其中的文件）：' + resolved);
        }
        // 连同安装包一起删（大小写两种扩展名都试）：包名与 id 也可能不一致，按"归一到同一个 id"判断
        for (const ext of ['.zip', '.ZIP']) {
            const zips = await readdir(modsDir).catch(() => []);
            for (const z of zips) {
                if (!z.toLowerCase().endsWith(ext.toLowerCase())) continue;
                if (normalizeModId(z) !== id && z.slice(0, -ext.length) !== id) continue;
                await rm(path.join(modsDir, z), { force: true }).catch(() => {});
            }
        }
        await scanAndSync();
        return true;
    }

    async function findModDirById(id) {
        const entries = await readdir(modsDir, { withFileTypes: true }).catch(() => []);
        const dirs = entries.filter((e) => e.isDirectory() && isSafeModDirName(e.name)).map((e) => e.name);
        if (dirs.includes(id)) return path.join(modsDir, id);
        for (const name of dirs) {
            try {
                const raw = await readFile(path.join(modsDir, name, 'manifest.json'), 'utf8');
                const m = JSON.parse(raw);
                if (String(m && m.id || '').trim() === id) return path.join(modsDir, name);
            } catch { /* 没有 manifest 或不是合法 JSON —— 跳过 */ }
        }
        return null;
    }

    return { scanAndSync, uninstall, extractPluginZip, installFromBuffer, readReadme, findModDirById, MOD_ID_RE };
}
