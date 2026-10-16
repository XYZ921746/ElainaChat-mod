// 把外部的插件源（web 仓库的 plugins/）接到本仓库的 mods/。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
//
// 插件已搬到 web 仓库（XYZ921746/web）托管，但本仓库里一堆东西仍是按
// `mods/` 读的：`npm run check` 里的 check-mods / check-mod-e2e /
// check-scene-backgrounds / check-bundled-models …，以及 `npm run pack:assets`。
// 两边各存一份迟早会漂移（改了这边忘了那边），这个脚本把两者接起来。
//
// 用法：
//   node scripts/link-mods.mjs --src D:/path/to/web/plugins
//   node scripts/link-mods.mjs --src ... --dry-run    # 只看会做什么
//   node scripts/link-mods.mjs --src ... --link       # 改用目录联接（见下）
//   也可以用环境变量 ELAINACHAT_MODS_SRC 代替 --src
//
// ── 为什么默认是"复制"而不是"联接" ──────────────────────────────────────
//
// 联接（junction）看着更干净，但它要求把 `mods/` 整个换掉。而本机
// `mods/live2d-models/models/` 里可能装着你自己的 Live2D 模型（约 40MB，
// **不在** web 仓库里）—— 一联接就等于把它们从视野里抹掉。
// 所以默认走复制：只补源里有的文件，**从不删除**目标里多出来的东西。
// 真想联接就显式加 --link，且只有 mods/ 不存在或为空时才会执行。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);

function flagValue(name) {
    const i = ARGV.indexOf(name);
    if (i === -1) return null;
    const v = ARGV[i + 1];
    if (!v || v.startsWith('--')) {
        console.error(`参数 ${name} 后面缺一个值。`);
        process.exit(1);
    }
    return v;
}

const DRY = ARGV.includes('--dry-run');
const LINK = ARGV.includes('--link');
const DST = path.join(ROOT, 'mods');
const srcArg = flagValue('--src') || process.env.ELAINACHAT_MODS_SRC;

if (!srcArg) {
    console.error(
        '没指定插件源。插件源在 web 仓库（XYZ921746/web）的 plugins/ 下，先把它 clone 下来：\n'
        + '  git clone https://github.com/XYZ921746/web.git D:/path/to/web\n'
        + '  node scripts/link-mods.mjs --src D:/path/to/web/plugins\n'
        + '（或设环境变量 ELAINACHAT_MODS_SRC 指过去，npm run link:mods 就不必带参数）'
    );
    process.exit(1);
}

const SRC = path.resolve(srcArg);

if (!existsSync(SRC) || !statSync(SRC).isDirectory()) {
    console.error('插件源不存在或不是目录：' + SRC);
    process.exit(1);
}

const pluginDirs = readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

if (!pluginDirs.length) {
    console.error('插件源里一个插件目录都没有：' + SRC);
    process.exit(1);
}

console.log('插件源: ' + SRC);
console.log('目标  : ' + DST);
console.log('插件  : ' + pluginDirs.join(', '));

if (LINK) {
    // 只有"不存在或为空"才敢替换 —— 非空就可能是用户自己装的模型，不能碰
    const dstExists = existsSync(DST);
    const dstEmpty = dstExists && readdirSync(DST).length === 0;
    if (dstExists && !dstEmpty) {
        console.error('\nmods/ 已存在且非空，拒绝自动替换。'
            + '\n它里面可能有你自己装的 Live2D 模型（mods/live2d-models/models/），'
            + '\n而那些**不在** web 仓库里，替换掉就看不见了。'
            + '\n确实要用联接：先手动把 mods/ 改名备份（如 mods.old），再执行 --link。');
        process.exit(1);
    }
    if (DRY) {
        console.log('\n[dry-run] 会：删除空的/不存在的 mods/，并建立目录联接 -> ' + SRC);
        process.exit(0);
    }
    if (dstExists) rmSync(DST, { recursive: true, force: true });
    mkdirSync(path.dirname(DST), { recursive: true });
    symlinkSync(SRC, DST, 'junction');
    console.log('\n已建立目录联接：' + DST + ' -> ' + SRC);
    process.exit(0);
}

if (DRY) {
    console.log('\n[dry-run] 会把上面这些插件目录复制到 mods/（已存在则覆盖同名文件，不删除多余文件）');
    process.exit(0);
}

mkdirSync(DST, { recursive: true });
let copied = 0;
for (const id of pluginDirs) {
    cpSync(path.join(SRC, id), path.join(DST, id), { recursive: true, force: true });
    copied++;
}
console.log('\n已同步 ' + copied + ' 个插件目录到 mods/。');
console.log('★ 目标里原有的其它内容（例如你自己装的 Live2D 模型）没被动过。');
console.log('★ 注意：web 仓库里的 plugins/<id>/models/ 不入库，所以那边的模型不会同步过来 —— 这是刻意的。');
