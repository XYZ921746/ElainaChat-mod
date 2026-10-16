// 打包 mod 与 Live2D 模型，产出可上传到 GitHub Releases 的 zip。
//
// 为什么需要这个脚本：mod 与模型都是**二进制资源**（图片、moc3），
// 不适合放在 git 仓库里（Git 对二进制无法有效增量压缩，每次改一张图
// 历史里就多存一整份）。所以改为"源码留仓库、资源走 Releases"。
//
// 用法：
//   node scripts/pack-assets.mjs              # 打包全部
//   node scripts/pack-assets.mjs galgame      # 只打某个 mod
//   node scripts/pack-assets.mjs --list       # 只列出会打包什么
//
// 产物默认放在 dist/assets/（已 gitignore）。
//
// ★ 2026-10：插件已外置到 `XYZ921746/web` 仓库托管，所以源目录与产物目录都可覆盖：
//
//   node scripts/pack-assets.mjs \
//        --mods-dir ../web/plugins \
//        --out      ../web/store/packages \
//        --index    ../web/store/index.json \
//        --base-url https://xyz921746.github.io/web/store/packages/
//
//   --mods-dir  插件源目录（默认 mods/；也可用环境变量 ELAINACHAT_MODS_SRC）
//   --out       产物输出目录（默认 dist/assets）
//   --index     打包后**合并写回**商店索引：只刷新 version/depends/sizeBytes/downloadUrl，
//               你手写的 name/description/kind 原样保留（否则每次打包都会把文案覆盖掉）
//   --base-url  商店包地址前缀；写索引时必需（或索引里已有 baseUrl 字段）
//
// ── 打包格式的约定（很重要，装的时候靠它）──────────────────────────────
//
//   mod：zip 根目录**直接是 mod 的文件**（manifest.json / index.js / img/…），
//        不要多一层同名目录。因为安装时服务端会剥掉"唯一的顶层目录"
//        （见 server/mods.mjs 的 stripTop），多一层虽然也能装，
//        但少一层更不容易出意外。
//
//   模型：zip 根目录**必须是一个以模型名命名的目录**
//        （如 `伊蕾娜·默认/xxx.model3.json`）。因为模型是按目录名识别的
//        （/api/live2d/models 返回的就是目录名），少这层会导致解压后
//        文件散落在 models/ 下、识别不出模型。
import { readdirSync, statSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../server/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);

/** 取 `--名字 <值>` 形式的参数：没给返回 null；给了但缺值直接报错退出 */
function flagValue(name) {
    const i = ARGV.indexOf(name);
    if (i === -1) return null;
    const v = ARGV[i + 1];
    if (!v || v.startsWith('--')) {
        console.error(`参数 ${name} 后面缺一个值（用法见文件顶部注释）。`);
        process.exit(1);
    }
    return v;
}

// ★★ 2026-10：插件根目录从 `web/mods/` 搬到**项目根** `mods/`（与 data/ 平级）。
// ★ 2026-10 之二：插件已外置到 web 仓库，源目录与产物目录都改成可覆盖 ——
//   优先级：命令行 > 环境变量 > 默认值（默认值保持原样，本仓库的检查不受影响）。
const MODS_DIR = path.resolve(
    flagValue('--mods-dir') || process.env.ELAINACHAT_MODS_SRC || path.join(ROOT, 'mods')
);
// ★ 模型仍在**插件目录内**（live2d-models/models）—— 但它是**用户本机装的资源**，
//   不随插件包分发（见 packMod 里的排除），只由 packModel 单独打包。
const MODELS_DIR = path.join(MODS_DIR, 'live2d-models', 'models');
const OUT_DIR = path.resolve(flagValue('--out') || path.join(ROOT, 'dist', 'assets'));

/** 递归收集目录下的文件（返回相对路径 + 内容） */
function collectFiles(dir, prefix = '', out = []) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;                 // 跳过隐藏文件
        if (e.name === 'index.json') continue;                // 服务端自动生成的清单，不该打包
        const rel = prefix ? prefix + '/' + e.name : e.name;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collectFiles(full, rel, out);
        else if (e.isFile()) out.push({ rel, full });
    }
    return out;
}

const mb = (b) => (b / 1048576).toFixed(2) + ' MB';

/** 读 manifest（拿版本号，用于文件名） */
function readManifest(dir) {
    const p = path.join(dir, 'manifest.json');
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** 打包一个 mod */
async function packMod(id) {
    const dir = path.join(MODS_DIR, id);
    if (!existsSync(dir)) return { id, error: '目录不存在' };

    // ★ 排除插件根下的 `models/`：那是 Live2D **用户本机装的模型**（本机约 40MB），
    //   不是插件本体。带上它会让包巨大，还会把"别人的模型"发给别人。
    //   模型由 packModel 单独打包（这与 README 里"资源与代码分离"的分法一致）。
    const files = collectFiles(dir).filter((f) => !f.rel.startsWith('models/'));
    if (!files.length) return { id, error: '目录为空' };

    // 至少要有入口或清单，否则装了也跑不起来
    const hasEntry = files.some((f) => f.rel === 'index.js' || f.rel === 'manifest.json');
    if (!hasEntry) return { id, error: '缺少 index.js / manifest.json' };

    const manifest = readManifest(dir);
    const version = (manifest && manifest.version) || '0.0.0';

    const entries = [];
    let total = 0;
    for (const f of files) {
        const data = await readFile(f.full);
        total += data.length;
        // ★ mod：根目录直接放文件（不套一层同名目录）
        entries.push({ name: f.rel, data });
    }

    const zip = createZip(entries);
    const outName = `${id}-${version}.zip`;
    const outPath = path.join(OUT_DIR, outName);
    await writeFile(outPath, zip);

    return { id, kind: 'mod', version, files: files.length, raw: total, zip: zip.length, outName, outPath };
}

/** 打包一个 Live2D 模型 */
async function packModel(name) {
    const dir = path.join(MODELS_DIR, name);
    if (!existsSync(dir)) return { name, error: '目录不存在' };

    const files = collectFiles(dir);
    if (!files.length) return { name, error: '目录为空' };

    // 至少要有一个 model3.json，否则不是有效模型
    const hasModel3 = files.some((f) => f.rel.endsWith('.model3.json'));
    if (!hasModel3) return { name, error: '缺少 .model3.json（不是有效的 Live2D 模型）' };

    const entries = [];
    let total = 0;
    for (const f of files) {
        const data = await readFile(f.full);
        total += data.length;
        // ★ 模型：必须套一层以模型名命名的目录
        entries.push({ name: name + '/' + f.rel, data });
    }

    const zip = createZip(entries);
    // 文件名要安全：模型名可能含中文/空格/·。
    //
    // ★ 为什么把中文也换掉（而不只是替换非法字符）：
    //   实测上传到 GitHub Releases 时，`live2d-伊蕾娜·默认.zip` 经 curl 传输后
    //   变成了 `live2d-.zip` —— 中文在 Windows 命令行 → curl 的 → GitHub API
    //   这条链路上丢了。下载链接也会带一长串 %XX，既不好看也容易出错。
    //
    //   所以产物名统一用**纯 ASCII**：非 ASCII 字符转成下划线。
    //   模型在 zip **内部**仍保留原名（那是识别用的），只是外壳文件名变 ASCII。
    //   例如 `伊蕾娜·默认` → `live2d-elaina-default.zip`（下面有映射表）。
    const ASCII_ALIAS = {
        '伊蕾娜·默认': 'elaina-default',
        deepseek: 'deepseek',
    };
    const safe = ASCII_ALIAS[name]
        || name.replace(/[^\x20-\x7E]/g, '_').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
    const outName = `live2d-${safe}.zip`;
    const outPath = path.join(OUT_DIR, outName);
    await writeFile(outPath, zip);

    return { name, kind: 'model', files: files.length, raw: total, zip: zip.length, outName, outPath };
}

// ============================================================ 主流程
const FLAG_NAMES = ['--mods-dir', '--out', '--index', '--base-url'];
const FLAG_VALUES = new Set(FLAG_NAMES.map(flagValue).filter(Boolean));
const listOnly = ARGV.includes('--list');
const indexArg = flagValue('--index');
// 只把"不像参数、也不是参数取值"的当成插件名 / 模型名
const wanted = ARGV.filter((a) => !a.startsWith('--') && !FLAG_VALUES.has(a));

const modIds = existsSync(MODS_DIR)
    ? readdirSync(MODS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
    : [];
const modelNames = existsSync(MODELS_DIR)
    ? readdirSync(MODELS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
    : [];

const pickMods = wanted.length ? modIds.filter((m) => wanted.includes(m)) : modIds;
const pickModels = wanted.length ? modelNames.filter((m) => wanted.includes(m)) : modelNames;

console.log('════════ 将打包 ════════');
console.log('  插件源: ' + MODS_DIR);
console.log('  mods  : ' + (pickMods.join(', ') || '(无)'));
console.log('  模型  : ' + (pickModels.join(', ') || '(无)'));
console.log('  输出到: ' + OUT_DIR);

if (listOnly) process.exit(0);

if (!pickMods.length && !pickModels.length) {
    console.error('\n没有可打包的内容。检查插件源目录是否存在：' + MODS_DIR);
    process.exit(1);
}

// ★ 只清掉上一次的**产物文件**，不整目录删除 —— `--out` 可能指向 web 仓库的
//   store/packages/（整目录删没问题），但万一指到 store/ 就会连带删掉
//   index.json / index.html，那是事故。所以只认 zip 与 manifest.json。
mkdirSync(OUT_DIR, { recursive: true });
for (const f of readdirSync(OUT_DIR, { withFileTypes: true })) {
    if (f.isFile() && (f.name.endsWith('.zip') || f.name === 'manifest.json')) {
        await rm(path.join(OUT_DIR, f.name), { force: true });
    }
}

const results = [];
for (const id of pickMods) results.push(await packMod(id));
for (const name of pickModels) results.push(await packModel(name));

console.log('\n════════ 打包结果 ════════');
let totalZip = 0;
const rows = [];
for (const r of results) {
    const label = r.id || r.name;
    if (r.error) {
        console.log(`  ❌ ${label.padEnd(20)} ${r.error}`);
        continue;
    }
    totalZip += r.zip;
    rows.push(r);
    const ratio = r.zip < r.raw ? Math.round(r.zip / r.raw * 100) + '%' : '—';
    console.log(`  ✅ ${r.outName.padEnd(28)} ${r.files.toString().padStart(3)} 文件  `
        + `${mb(r.raw).padStart(9)} → ${mb(r.zip).padStart(9)} (压缩率 ${ratio})`);
}
console.log(`\n  合计 ${rows.length} 个 zip，共 ${mb(totalZip)}`);
console.log(`  输出目录：${OUT_DIR}`);

// 顺带写一份上传清单，方便手动传 Releases 时对照
const manifestOut = {
    comment: '由 scripts/pack-assets.mjs 生成。上传到 GitHub Releases 后，把下载链接填到下面。',
    generatedAt: new Date().toISOString(),
    assets: rows.map((r) => ({
        kind: r.kind,
        id: r.id || r.name,
        version: r.version || '',
        file: r.outName,
        sizeBytes: r.zip,
        downloadUrl: '',   // 上传后手动填（或让用户直接粘贴到应用里）
    })),
};
await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifestOut, null, 2), 'utf8');
console.log('  另写出 manifest.json（含上传清单，下载链接待填）');

// ── 写商店索引（可选，见顶部 --index 的说明）────────────────────────────
//
// ★ 为什么是"合并"而不是"覆盖"：name / description / kind 是**人写的文案**，
//   机器不该覆盖它们 —— 否则你每次微调商店里的介绍，下次打包又被打回原样，
//   会陷入"改了又没改"的死循环。只有"算得出来"的字段才刷新。
if (indexArg) {
    const indexPath = path.resolve(indexArg);
    let prev = {};
    try { prev = JSON.parse(await readFile(indexPath, 'utf8')); } catch { /* 首次生成 */ }
    const baseUrl = String(flagValue('--base-url') || prev.baseUrl || '').trim();
    if (!baseUrl) {
        console.error('\n写索引需要包地址前缀：加 --base-url https://<用户名>.github.io/<仓库>/store/packages/，'
            + '或让索引里先有一个 baseUrl 字段。');
        process.exit(1);
    }
    const normBase = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const byId = new Map((Array.isArray(prev.plugins) ? prev.plugins : []).map((p) => [p.id, p]));
    const packed = new Set();
    for (const r of rows) {
        if (r.kind !== 'mod') continue;
        packed.add(r.id);
        const mf = readManifest(path.join(MODS_DIR, r.id)) || {};
        const old = byId.get(r.id) || {};
        byId.set(r.id, Object.assign({}, old, {
            id: r.id,
            name: old.name || mf.name || r.id,
            kind: old.kind || (mf.hidden ? 'resource' : 'ui'),
            description: old.description || mf.description || '',
            version: r.version,
            depends: Array.isArray(mf.after) ? mf.after : (Array.isArray(old.depends) ? old.depends : []),
            sizeBytes: r.zip,
            downloadUrl: normBase + r.outName,
        }));
    }
    await writeFile(indexPath, JSON.stringify(Object.assign({}, prev, {
        baseUrl: normBase,
        updatedAt: new Date().toISOString(),
        plugins: [...byId.values()],
    }), null, 2) + '\n', 'utf8');
    console.log('  已合并写回商店索引：' + indexPath + `（共 ${byId.size} 条）`);
    // 索引里有、插件源里没有的条目：**不自动删**（可能是你手工挂的外部插件），只提示
    const stale = [...byId.keys()].filter((id) => !modIds.includes(id));
    if (stale.length) {
        console.log('  ⚠️ 这些条目在插件源里找不到对应目录，已原样保留，需要清理请手动处理：' + stale.join(', '));
    }
}

if (results.some((r) => r.error)) process.exit(1);
