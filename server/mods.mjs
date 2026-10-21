// 插件（mod）的服务端支持：扫描目录 / 自动解压 zip / 生成清单 / 安装与卸载。
//
// ── 为什么需要服务端参与 ──────────────────────────────────────────────────
//
// 浏览器**无法列目录**。前端想知道"有哪些 mod"，只有两条路：
//   ① 有一份清单文件（谁生成？手工维护最容易忘）
//   ② 服务端扫描目录后生成清单（Node 能列目录）
//
// 这里走 ②：把 `xxx.zip` 丢进 mods/ 就会被自动解压、写进清单，
// 前端只管读清单。这样"装一个 mod"真的就是"丢个 zip 进去"。
//   插件目录在**项目根**的 mods/（与 data/ 平级），不在 web/ 静态根里 ——
//  插件是运行期内容，与随仓库分发的前端资源不是一类东西。
//
// ── 安全（这是 mod 系统最大的风险面）──────────────────────────────────────
//
// mod 的本质是**在同源下执行第三方 JS** —— 和我们修过的 `.html::$DATA`
// 存储型 XSS 是同一类风险。所以解压必须严防三件事：
//
//   ① **路径穿越**：zip 里写 `../../web/serve.mjs` 就能覆盖宿主代码。
//      防护：复用 isUnsafeEntryName + 解析后的绝对路径必须仍在插件目录内（双保险）。
//   ② **覆盖宿主文件**：插件只能写进 mods/<id>/，不能碰 index.html / app-*.js。
//      防护：解压目标目录写死，且拒绝任何逃逸路径。
//   ③ **危险类型**：插件**必须**能带 .js（它就是代码），所以这里**不能**套用
//      BLOCKED_EXT 那套黑名单 —— 那是给 Live2D 模型用的（模型不该带脚本）。
//      插件的取舍是：允许 .js，但**限制在插件自己的目录里**，
//      并且在界面上明确告知用户"安装 mod = 信任它的代码"。
//      同时仍然拦掉 .exe/.dll/.bat 这类**本机可执行**文件 —— 它们在浏览器里
//      本来也不会被执行，但会被下载到磁盘，属于不必要的风险。
//
// ── 与 Live2D 上传的区别 ─────────────────────────────────────────────────
// Live2D 走的是"用户在界面上传 zip"（handleUpload）。插件这里是
// "文件已经在 mods/ 目录里了，服务端自己去发现" —— 因为用户可能是
// 直接用文件管理器把 zip 拷进去的，没有经过浏览器。

import { readdir, stat, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * 插件 **id** 的合法性：只允许字母数字、连字符、下划线、点（且不能是 . / ..）。
 *
 * id 与目录名的约束**不同**，别混用：
 *   · id 是**身份**：要进 localStorage 键名、要拼资源 URL、要做依赖匹配，
 *     所以收得紧（纯 ASCII、无空格）—— 中文 id 会让 `/mods/<id>/…` 这种
 *     URL 与 localStorage 键都变得难处理。
 *   · 目录名是**磁盘位置**：用户完全可能把它改成中文（"桌宠"）或带空格
 *     （"my pet"）。这类目录**必须照样能识别** —— 它只要是个安全的目录名即可。
 *   两者共用同一个正则的话，把插件目录改成中文就会**直接扫不到**
 *   （连 manifest 都不读），表现为"改个名字插件就消失了"。
 */
const MOD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 插件**目录名**的合法性（比 id 宽松）。
 *
 * 允许中文、空格、括号等常见字符 —— 用户会这样命名。只挡掉真正危险的东西：
 *   · 路径分隔符 `/` `\` 与 `..`（目录穿越）
 *   · 以 `.` 开头（隐藏目录，且 `.`/`..` 本身）
 *   · Windows 非法字符 `<>:"|?*` 与控制字符（建不出这种目录，或建出来无法访问）
 *   · 首尾空白与尾随点（Windows 会静默吃掉，导致名字与预期不符）
 * 长度上限 128，避免异常长的名字。
 */
const MOD_DIR_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,128}$/;
function isSafeModDirName(name) {
    const n = String(name || '');
    if (!n || n === '.' || n === '..') return false;
    if (n.startsWith('.')) return false;              // 隐藏目录 / . ..
    if (n !== n.trim()) return false;                 // 首尾空白
    if (/[. ]$/.test(n)) return false;                // 尾随点/空格（Windows 会吃掉）
    if (n.includes('..')) return false;               // 防穿越（配合上面的分隔符检查）
    return MOD_DIR_RE.test(n);
}

/**
 * 把 zip 文件名归一化成插件 id：剥掉尾部的版本号。
 *
 * 这是修「资源包装了等于没装」的核心：
 *
 *   pack-assets.mjs 的产物名带版本号（`elaina-avatar-1.0.0.zip`），
 *   而旧逻辑直接拿 zip 文件名当插件 id —— 于是插件装进了
 *   `mods/elaina-avatar-1.0.0/`，后果是**两条**同时发生：
 *     ① 插件内部写死的资源 URL（`/mods/elaina-avatar/img/…`）404
 *        → 桌宠 / Galgame 显示不出人物；
 *     ② 依赖它的 mod 声明 `after: ["elaina-avatar"]`，匹配不上实际 id
 *        → 依赖解析失效，加载顺序失去保证。
 *
 *   为什么在**安装端**归一化、而不是让打包去掉版本号：版本号在
 *   Releases 文件名上有用（区分版本、避免浏览器缓存旧包），
 *   该保留的是产物名，该修的是"id 不能等于文件名"。
 *
 *   剥法**只认多段版本号**（`-1.0.0` / `-1.0`），不认单段（`-2`）。
 *   为什么这样划界：`my-mod-2`、`mod-2` 这类"名字里带个序号"的插件很常见，
 *   把 `-2` 当版本号剥掉会把 `my-mod-2` 变成 `my-mod` —— 误伤真实名字。
 *   而打包产物永远是 `x.y.z`（见 pack-assets 的 `${id}-${version}`，
 *   version 来自 manifest，本仓库三个包都是 `1.0.0`），所以只剥带点的形式
 *   既够用、又不会伤到用户自建的插件。
 *   若剥完不合法（比如剥成空串）则原样返回，交由调用方的白名单报错。
 */
export function normalizeModId(rawName) {
    const base = String(rawName || '').replace(/\.zip$/i, '');
    // 至少两段数字才算版本号：-1.0 / -1.0.0 / -2.1.3
    const stripped = base.replace(/-[0-9]+\.[0-9]+(\.[0-9]+)*$/, '');
    return (MOD_ID_RE.test(stripped) && MOD_ID_RE.test(base)) ? stripped : base;
}

/** 插件目录里允许落盘的本机可执行类型（拦掉，避免用户误双击） */
const MOD_BLOCKED_EXT = new Set([
    '.exe', '.dll', '.com', '.scr', '.msi', '.bat', '.cmd',
    '.ps1', '.psm1', '.vbs', '.wsf', '.jar', '.sh', '.app', '.deb', '.rpm',
]);

/** 单个插件解压后体积上限（防 zip bomb） */
const MOD_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 插件管理器。
 *
 * @param {object} opts
 * @param {string} opts.modsDir  插件根目录
 * @param {Function} opts.unzip     解压函数（复用 serve.mjs 里那份，已含体积/类型校验）
 * @param {Function} opts.isUnsafeEntryName 条目名安全检查（同上）
 * @param {Function} opts.effectiveExt 取"最终落盘名"的扩展名（含 ADS/尾随点防护）
 * @param {Function} opts.log       日志函数
 */
export function createModManager({ modsDir, unzip, isUnsafeEntryName, effectiveExt, log = () => {} }) {
    const INDEX_FILE = path.join(modsDir, 'index.json');

    /**
     * 最近一次扫描"装出来的结果"缓存。
     *
     * 为什么需要它：zip 装成功后会被删掉（见 scanAndSync 里的说明），
     * 于是**下一次扫描的 zips 是空的**，安装结果也就没了。
     * 而用户要看的恰恰是那份结果 —— 尤其"哪些文件被拦下了"
     * （恶意 zip 里混了 .exe / 路径穿越时，只有这里能告诉用户）。
     *
     * 用时间窗而不是"读一次就清"：同一个 zip 装完后，前端可能先后请求
     * /mods/index.json（页面加载）和 /api/plugins（设置页），
     * "读一次就清"会让先到的那次把结果吃掉，后到的什么也看不到。
     */
    let installReport = { at: 0, results: [] };
    const INSTALL_REPORT_TTL = 5 * 60 * 1000;   // 5 分钟，足够用户打开设置页看到

    /**
     * 读插件目录里的 manifest.json（优先）或从目录名推断。
     *
     * id 的权威来源是 **manifest.id**，不是目录名。
     *
     *   反过来用目录名覆盖 manifest.id 是不行的：那条思路的前提是"目录名一定对"，
     *   而 pack-assets 的产物名带版本号 —— 把 `elaina-avatar-1.0.0` 当目录名安装时，
     *   **目录名才是错的那个**，插件内部写死的资源 URL 与依赖它的 `after` 全都对不上。
     *
     *   现在改成：manifest.id 合法就用它（它是插件作者声明的身份，也是
     *   资源路径与依赖引用的基准），只有缺失/非法时才回落到目录名。
     *
     * 回落时还会对目录名做 normalizeModId（剥版本号尾），这样
     *   "没写 id 的插件 + 带版本号的目录名"也能得到干净的 id。
     *   `MOD_ID_RE` 校验必须保留 —— manifest 是外部输入，不能直接信。
     */
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
                // 没写 id / 写得不合法 → 用目录名，并剥掉可能的版本号尾
                return { ...m, id: normalizeModId(fallbackId) };
            }
        } catch (e) {
            if (e && e.code !== 'ENOENT') log('插件 manifest.json 解析失败：' + dir + ' —— ' + e.message);
        }
        // 没有 manifest 时给一份最小可用清单：让"只有 index.js 的 mod"也能跑
        return {
            id: normalizeModId(fallbackId),
            name: fallbackId, version: '', description: '', entry: 'index.js',
        };
    }

    /**
     * 解压一个插件 zip 到 mods/<id>/。
     *
     * 安全要点全在这里：
     *   · id 先做白名单校验（挡住 `..` / 绝对路径 / 奇怪字符）
     *   · 目标目录写死为 mods/<id>，且每条目解析后必须仍在其内（双保险）
     *   · 危险的本机可执行类型跳过
     *   · 总解压体积封顶
     */
    /**
     * 从**内存里的 zip** 安装插件（供「应用内上传」用）。
     *
     * 与 extractPluginZip 的区别只在于数据来源：那个从磁盘文件读，这个直接收
     * Buffer。安全逻辑**完全一致**（路径穿越 / 绝对路径 / 危险类型 / 体积上限），
     * 因为两者最终都走同一段解压循环 —— 这是刻意的：安全规则只该有一份。
     *
     * @param {Buffer} buf       zip 内容
     * @param {string} id        插件 id（来自 zip 文件名，会做白名单校验）
     * @returns {Promise<{id, written, skipped}>}
     */
    async function installFromBuffer(buf, id) {
        if (!MOD_ID_RE.test(id)) throw new Error('插件名不合法：' + id);
        if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip 文件');
        return writePluginFiles(buf, id);
    }

    /**
     * 解压并落盘（extractPluginZip 与 installFromBuffer 的公共实现）。
     * 把这段单独抽出来，是为了让"从文件装"和"从上传装"走**同一条安全路径**。
     */
    async function writePluginFiles(buf, id) {
        // allowScripts: true —— mod 的本质就是 JS。
        //   默认的黑名单会把 .js/.mjs 拦掉（那是为 Live2D 模型设计的：模型不该带脚本），
        //   用它解 mod 包会得到"只有 manifest.json、插件跑不起来"的怪现象。
        //   开了这个选项后，路径穿越 / 绝对路径 / 体积上限 / .exe 等仍然全部拦截。
        const { files } = unzip(buf, { allowScripts: true });

        const targetDir = path.join(modsDir, id);
        // 先写到**临时目录**，全部条目落盘后再整体改名成正式目录。
        //
        // 为什么不能直接写 targetDir：`/mods/index.json` 与 `/api/plugins` 每次
        //   请求都会 scanAndSync()，而扫描认的是"目录存在就算已安装"。直接往
        //   mods/<id>/ 里逐个写文件的话，中途那一刻目录已经存在、index.js 还没写完 ——
        //   这时前端读到清单就会去请求 `/mods/<id>/index.js`，拿到 404 并**当场把
        //   插件标成加载失败、自动停用**（用户看到的就是"装完就报脚本加载失败"）。
        //   临时目录名以 `.` 开头，会被扫描器的 isSafeModDirName 直接跳过，天然不会被认成插件。
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
        // 全部条目落盘后才把临时目录改名成正式目录：改名（rename）在同一卷上是
        //   原子的，扫描器要么看不到这个插件，要么看到的就是**完整**的一份 ——
        //   不存在"目录在、index.js 还没写完"的中间态。
        // 重装语义：先清空旧目录再改名，否则会留下上一次安装的残留文件
        //   （那些文件没有清单条目，「删插件」也删不到它们）。
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

    /** 从磁盘上的 zip 文件安装（扫描目录时自动调用） */
    async function extractPluginZip(zipPath, id) {
        if (!MOD_ID_RE.test(id)) throw new Error('插件名不合法：' + id);
        const buf = await readFile(zipPath);
        return writePluginFiles(buf, id);
    }

    /**
     * 扫描插件目录：解压待安装的 zip，收集已安装的插件，生成 index.json。
     *
     * 什么时候调用：
     *   · 服务启动时（把用户刚拷进来的 zip 装上）
     *   · 前端请求 /api/plugins 时（用户可能在服务运行期间拷了 zip 进来）
     *   · 前端请求 /mods/index.json 时（清单必须新鲜，见 serve.mjs 里的说明）
     */
    async function scanAndSync() {
        await mkdir(modsDir, { recursive: true }).catch(() => {});
        const entries = await readdir(modsDir, { withFileTypes: true }).catch(() => []);

        // 清掉**安装中途留下的临时目录**（`.installing-*`）。
        //
        //   为什么需要：安装是先写临时目录再原子改名（见 writePluginFiles），
        //   而进程若在中途被杀（用户关窗口、断电），那份临时目录就留在磁盘上 ——
        //   隐藏、不会被扫成插件（isSafeModDirName 跳过 `.` 开头），但会白占
        //   几十 MB，且用户永远看不见它。扫描时顺手清掉是最省事的时机。
        const stale = [];
        for (const e of entries) {
            if (e.isDirectory() && e.name.startsWith('.installing-')) stale.push(e.name);
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
                // 目录名用 isSafeModDirName（宽松，允许中文/空格），
                //   而不是 MOD_ID_RE（严格 ASCII）—— 用户把插件目录改成
                //   「桌宠」是完全合理的目录名，用严格 ASCII 正则会直接扫不到它。
                if (!isSafeModDirName(e.name)) {
                    log(`跳过目录 ${e.name}：名字含不安全字符或非法形式`);
                    continue;
                }
                installed.push({ id: e.name, dir: path.join(modsDir, e.name) });
            } else if (e.isFile() && /\.zip$/i.test(e.name)) {
                zips.push(e.name);
            }
        }

        // 解压待安装的 zip。id = zip 文件名去掉扩展名。
        //
        // 装成功后**删掉 zip**（一次性安装包）。
        //
        // 为什么必须删：zip 是"待安装"的源，只要它还在目录里，**每次扫描都会
        // 重新解压安装**。于是用户手动删掉插件目录后，下一次扫描（打开设置就会触发）
        // 又把它装回来 —— 表现就是"我明明卸载了，插件列表里还在"。
        // 点「卸载」按钮那条路是对的（它会删 zip），但用户直接删目录时就没辙了。
        //
        // 删掉之后语义就清楚了：目录存在 = 已安装；要重装就再放一次 zip。
        // 这也让"删目录"变成真正有效的卸载方式。
        //
        // 装完的**结果要留住**，不能扫完就丢。
        //
        //   为什么：安装结果（尤其"哪些文件被拦下了"）是给用户看的反馈。
        //   zip 装成功后会被删掉，所以下一次扫描时 zips 已经空了 ——
        //   若结果只存在本次调用的局部变量里，用户打开设置页那次扫描
        //   就会看到一片空白，以为"装了什么都没发生"。
        //
        //   实现用**时间窗**而不是"读一次就清"：同一个 zip 装完之后，
        //   前端可能先后请求 /mods/index.json（页面加载）与 /api/plugins
        //   （设置页），"读一次就清"会让先到的那次把结果吃掉。
        //   留一个时间窗，期间任何一次读都能看到，过期自然失效。
        const installResults = [];
        for (const z of zips) {
            // id 要先过 normalizeModId 剥掉版本号 ——
            //   pack-assets 的产物名是 `elaina-avatar-1.0.0.zip`，
            //   直接拿文件名当 id 会装进 elaina-avatar-1.0.0/，
            //   资源 URL 与 after 依赖同时失效（见 normalizeModId 的说明）。
            const id = normalizeModId(z);
            if (!MOD_ID_RE.test(id)) {
                installResults.push({ zip: z, ok: false, error: '插件名不合法（只允许字母数字、- _ .）' });
                continue;
            }
            // 若归一化后的目录已存在（用户重复放了不同版本的包），明确报出来
            // 而不是静默覆盖 —— 覆盖会把用户已有的设置一并带走。
            const targetDir = path.join(modsDir, id);
            const alreadyInstalled = installed.some((i) => i.id === id);
            if (alreadyInstalled) {
                installResults.push({ zip: z, ok: false, error: `插件 ${id} 已安装（如需更新请先删除旧版）` });
                await rm(path.join(modsDir, z), { force: true }).catch(() => {});
                log(`跳过 ${z}：${id} 已安装，安装包已清理`);
                continue;
            }
            try {
                const r = await extractPluginZip(path.join(modsDir, z), id);
                installResults.push({ zip: z, ok: true, id: r.id, files: r.written });
                if (!alreadyInstalled) installed.push({ id, dir: targetDir });
                // 装好即清理安装包（见上面的说明）
                await rm(path.join(modsDir, z), { force: true }).catch(() => {});
                log('已安装插件：' + id + '（' + r.written + ' 个文件，安装包已清理）');
            } catch (err) {
                installResults.push({ zip: z, ok: false, error: String((err && err.message) || err) });
                log('插件安装失败：' + z + ' —— ' + installResults[installResults.length - 1].error);
                // 失败的 zip **保留** —— 用户要能看到它、修好再重试。
                // 删掉的话"装失败"就变成"文件凭空消失"，更难排查。
            }
        }

        // 收集已安装插件的清单
        //
        // 这里同时给出两个名字，各有各的用途：
        //   id  —— 归一化后的**身份**：依赖匹配（after）与资源 URL 的基准。
        //          它等于 manifest.id（缺失时才回落到目录名）。
        //   dir —— 磁盘上的**实际目录名**：前端按它拼脚本/样式的 URL。
        // 二者不一致的情况真实存在（历史版本把 `elaina-avatar-1.0.0` 当目录名装过），
        // 只给一个名字必然有一处 404 —— 要么脚本加载不到，要么图片加载不到。
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
                // scripts：额外的脚本文件（按顺序注入，entry 仍是第一个）。
                // 让一个插件能拆成"注册装配 / 设置面板 / 实现主体"几个文件 ——
                // 硬塞进一个文件只会越来越难维护（Live2D 插件就是这么拆的）。
                scripts: Array.isArray(m.scripts) ? m.scripts.filter((s) => typeof s === 'string' && s) : [],
                styles: Array.isArray(m.styles) ? m.styles : [],
                // 默认关闭（与 web/js/mods.js 的 isModEnabled 同语义）：只有显式写
                //   `"defaultEnabled": true` 才算默认开，漏写/写别的都算关 ——
                //   插件会改动界面，不该在用户不知情时生效。
                defaultEnabled: m.defaultEnabled === true,
                after: Array.isArray(m.after) ? m.after : [],
                hidden: m.hidden === true,
                // 前端 host API 的能力组（AGENTS.md D18 / 表 A22）：原样搬运。
                // **必须带出去** —— 前端 createHostApi 靠它决定给插件下发哪些成员；
                // 漏了这一行，插件声明的 theme/achievements/dragSort/openFolder
                // 全部拿不到，而症状是"插件加载成功但功能静默失效"。
                // 没声明时不写这个字段（同 server 的理由：避免给每个插件加一行噪音）。
                ...(Array.isArray(m.capabilities) && m.capabilities.length
                    ? { capabilities: m.capabilities.filter((s) => typeof s === 'string' && s) }
                    : {}),
                // 宿主半边（服务端路由 / 上传目录）的**声明**，原样带出去交给 serve.mjs 装配。
                // 这里只搬运不解释：声明是否合法由 server/mod-server.mjs 判定并报错 ——
                // 扫描器不该长着"路由前缀怎么写才合法"的知识。
                // 没声明时**不写这个字段**：绝大多数插件没有服务端半边，给每个插件都加一行
                // `"server": null` 只会让清单变长、让每次重新生成都产生无意义 diff。
                ...(m.server && typeof m.server === 'object' && !Array.isArray(m.server) ? { server: m.server } : {}),
                hasManifest: await exists(path.join(it.dir, 'manifest.json')),
            });
        }

        // 写清单。**注意**：保留手工维护的额外字段（比如注释），只覆盖 plugins 数组。
        let prev = {};
        try { prev = JSON.parse(await readFile(INDEX_FILE, 'utf8')); } catch { /* 首次运行 */ }
        const out = {
            ...(prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}),
            comment: '本文件由服务端扫描 mods/ 自动生成（见 server/mods.mjs）。手工改动会在下次扫描时被覆盖。',
            generatedAt: new Date().toISOString(),
            plugins: list,
        };
        await writeFile(INDEX_FILE, JSON.stringify(out, null, 2), 'utf8');

        // 安装结果的留存（见 installReport 的说明）：
        //   · 本次真的装了东西 → 记下来，并把时间戳刷新
        //   · 本次没装（zip 已在上一次被消费）→ 把未过期的旧结果一并返回，
        //     这样"装完 → 打开设置页"仍能看到"哪些文件被拦下了"
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

    /**
     * 读插件的 README（供插件页的「说明」按钮）。
     *
     * 为什么用**白名单文件名**而不是"让前端传文件名"：
     *   一旦接受任意文件名，就等于给了一个"读插件目录里任意文件"的口子 ——
     *   而插件目录里可能有 manifest.json（含作者私密配置）甚至别的插件留下的东西。
     *   这里只认几个约定俗成的说明文件名，其余一律不读。
     *
     * 大小上限 256KB：README 不该那么大，超了说明传错了文件（或有人拿它当传输通道）。
     *
     * @returns {{ok:true, name:string, text:string}|{ok:false, message:string}}
     */
    const README_NAMES = ['README.md', 'readme.md', 'README.txt', 'readme.txt', 'README', '说明.md'];
    async function readReadme(id) {
        if (!MOD_ID_RE.test(id)) return { ok: false, message: '插件名不合法' };
        const dir = path.join(modsDir, id);
        if (!dir.startsWith(modsDir + path.sep)) return { ok: false, message: '路径越界' };
        for (const name of README_NAMES) {
            const p = path.join(dir, name);
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
        // 明确区分"没有 README"与"读取失败" —— 前端要给出不同的提示
        return { ok: false, message: '该插件没有 README 文件' };
    }

    /**
     * 卸载：删除插件目录**以及对应的安装包**。
     *
     * 为什么必须连 zip 一起删：目录里那份 `xxx.zip` 是"待安装"的源。
     * 如果只删目录，紧接着的 scanAndSync() 会立刻把它重新解压装回来 ——
     * 用户点「卸载」，mod 转一圈又出现了，看起来像卸载功能坏了。
     * （这个坑是端到端测试抓到的：断言"目录已删除"时发现它又回来了。）
     *
     * ── 目录名 ≠ 插件 id ──────────────────────────────────────────────
     *
     * 清单里的 `id` 来自 manifest（如 `galgame`），而**目录名**是安装时的包名
     * （如 `galgame-1.0.0`）—— 两者是各自独立的字段，可以不一致（见表 A9）。
     * 所以删目录**不能**用 id 直接拼路径：拼出来的 `mods/galgame` 不存在，
     * 而 `rm(..., { force: true })` 对不存在的路径是**静默成功**的 ——
     * 接口会回 `{ok:true}`、界面提示"已删除"，插件却原封不动，
     * 用户点多少次都一样，且没有任何报错可循。
     *
     * 因此必须先在磁盘上**按 id 反查真实目录**（同名目录优先，否则读各目录的
     * manifest 比对 id）；查不到就**明确报错**，不假装成功。
     *
     * 同理，删完之后要**确认目录真的没了**：文件被占用时 Windows 会留下半删
     * 目录，此时继续返回成功又是一次无声的谎报。
     */
    async function uninstall(id) {
        if (!MOD_ID_RE.test(id)) throw new Error('插件名不合法');
        const dir = await findModDirById(id);
        if (!dir) throw new Error('没有找到插件「' + id + '」的目录（可能已经被删掉了）');
        // 双保险：解析后的路径必须真的在 modsDir 下
        const resolved = path.resolve(dir);
        if (resolved !== modsDir && !resolved.startsWith(modsDir + path.sep)) {
            throw new Error('路径越界');
        }
        await rm(resolved, { recursive: true, force: true });
        // 删完要确认真的没了 —— 文件被占用时 Windows 会留下半删状态，
        //   那时继续往下走只会让用户以为卸载成功了。
        if (await stat(resolved).then(() => true, () => false)) {
            throw new Error('插件目录没能删掉（可能有程序正在占用其中的文件）：' + resolved);
        }
        // 连同安装包一起删（大小写两种扩展名都试）——
        //   包名与 id 也可能不一致，所以按"归一到同一个 id"来判断。
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

    /**
     * 按插件 id 在 modsDir 里找出**实际目录**。
     *
     * 匹配顺序（先便宜后贵）：
     *   ① 同名目录（绝大多数情况：id 与目录名一致）；
     *   ② 每个目录的 manifest.json 里 `id` 字段 —— 这才是权威来源，
     *      因为目录名是安装时的包名（`galgame-1.0.0`），id 由 manifest 决定。
     *
     * @returns {Promise<string|null>} 绝对路径；找不到返回 null
     */
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

    return { scanAndSync, uninstall, extractPluginZip, installFromBuffer, readReadme, MOD_ID_RE };
}
