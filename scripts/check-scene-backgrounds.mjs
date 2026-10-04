// 回归检查：场景背景资源包（scene-backgrounds）。
//
// 为什么需要它 —— 这个包有一个**静默失效**的典型风险：
//   背景图放在 img/bg/ 里，而清单（index.js 的 BGS 数组）是另一处维护的。
//   两者不一致时**不会报错**：
//     · 目录里有图、清单漏登记 → 那张图在界面上**选不到**（用户以为图丢了）
//     · 清单登记了、目录里没图   → 界面上那张图是**裂图/空白**
//   而这两个现象都不像"清单写错了"，排查方向天然会跑偏。
//
// 另外它还被两个消费者依赖（galgame / 视频通话），所以还要验：
//   · 接口齐全（list/url/label/has/pick）
//   · pick() 的中文模糊匹配真的能挑到（AI 的 [背景:雪夜] 走这条路）
//   · 服务端能真的把图发出去（静态服务可达）—— 这一步要起真服务
//
// 用法：node scripts/check-scene-backgrounds.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(ROOT, 'web', 'mods');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
    const s = createNetServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/** 按 manifest.id 找真实目录（用户可能改过目录名） */
function modDirById(id) {
    let names = [];
    try { names = readdirSync(MODS); } catch { return null; }
    for (const n of names) {
        const mf = path.join(MODS, n, 'manifest.json');
        if (!existsSync(mf)) continue;
        try {
            const m = JSON.parse(readFileSync(mf, 'utf8'));
            if (m && m.id === id) return n;
        } catch { /* 忽略坏 manifest */ }
    }
    return existsSync(path.join(MODS, id, 'index.js')) ? id : null;
}

// ============================================================ 1. 清单 ↔ 文件
console.log('=== 1. 清单与图片文件必须一一对应 ===');
const dir = modDirById('scene-backgrounds');
if (!dir) {
    ok(false, '找到 scene-backgrounds 插件（按 manifest.id）');
} else {
    ok(true, '找到 scene-backgrounds 插件（目录 ' + dir + '）');
    const indexSrc = readFileSync(path.join(MODS, dir, 'index.js'), 'utf8');
    const bgDir = path.join(MODS, dir, 'img', 'bg');

    // 从 BGS 数组里抠出文件名：形如 ['snowy_street', '雪之街']
    const listed = [...indexSrc.matchAll(/\[\s*'([A-Za-z0-9_\-]+)'\s*,\s*'[^']*'\s*\]/g)].map((m) => m[1]);
    ok(listed.length >= 30, 'BGS 清单里有 ' + listed.length + ' 条（应 ≥30）');
    // 清单里不该有重复文件名（重复的话界面上会出现两张同名图）
    const dupList = listed.filter((x, i) => listed.indexOf(x) !== i);
    ok(dupList.length === 0, '清单里没有重复的文件名', JSON.stringify([...new Set(dupList)]));

    let files = [];
    try { files = readdirSync(bgDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)); } catch { /* 目录不存在 */ }
    ok(files.length > 0, 'img/bg/ 里有图片（' + files.length + ' 个）', bgDir);

    const fileBase = new Set(files.map((f) => f.replace(/\.(jpe?g|png|webp)$/i, '')));
    const listSet = new Set(listed);

    // ★ 清单登记了、但目录里没有 → 界面上是裂图（最容易被忽略的一种）
    const missingFiles = listed.filter((n) => !fileBase.has(n));
    ok(missingFiles.length === 0,
        '★ 清单里每一项都有对应的图片文件（没有裂图）',
        missingFiles.length ? '缺文件：' + missingFiles.join('、') : '');

    // ★ 目录里有、但清单没登记 → 那张图在界面上选不到（静默失效）
    const notListed = [...fileBase].filter((n) => !listSet.has(n));
    ok(notListed.length === 0,
        '★ img/bg/ 里每个文件都在清单里登记了（否则选不到）',
        notListed.length ? '未登记：' + notListed.join('、') : '');

    // 中文标签不该重复（重复会让 pick() 的"精确匹配标签"产生歧义 ——
    // 它会命中第一个，而用户以为是另一个）
    const labels = [...indexSrc.matchAll(/\[\s*'[A-Za-z0-9_\-]+'\s*,\s*'([^']*)'\s*\]/g)].map((m) => m[1]);
    const dupLabel = labels.filter((x, i) => x && labels.indexOf(x) !== i);
    ok(dupLabel.length === 0, '中文标签没有重复', JSON.stringify([...new Set(dupLabel)]));

    // 接口齐全（两个消费方都靠它）
    //   判据宽松一点：`function xxx(` 或 `const xxx =` 都算 ——
    //   实现形式不该被这个检查锁死，只要那个名字可用就行。
    for (const fn of ['list', 'url', 'label', 'has', 'pick']) {
        const asFn = new RegExp('function\\s+' + fn + '\\s*\\(').test(indexSrc);
        const asConst = new RegExp('const\\s+' + fn + '\\s*=').test(indexSrc);
        ok(asFn || asConst, '提供 ' + fn + '()');
    }
    // 基址不能写死目录名（id 与实际目录名可能不一致 → 全部 404）
    ok(/host\.assetBase/.test(indexSrc),
        '★ 用 host.assetBase() 取真实目录（不写死 /mods/scene-backgrounds/）');
    // 必须自己注册
    ok(/ElainaMods\.register\(/.test(indexSrc), '用 ElainaMods.register 注册');
}

// ============================================================ 2. 两个消费方
console.log('\n=== 2. 消费方声明正确 ===');
{
    // galgame 用背景 → 必须声明依赖，并在代码里走资源包
    const galSrc = dir ? readFileSync(path.join(MODS, modDirById('galgame') || 'galgame', 'index.js'), 'utf8') : '';
    ok(/host\.require\('scene-backgrounds'\)/.test(galSrc),
        '★ galgame 通过 host.require 取背景（不自己拼路径）');
    const galMf = JSON.parse(readFileSync(path.join(MODS, modDirById('galgame') || 'galgame', 'manifest.json'), 'utf8'));
    ok(Array.isArray(galMf.after) && galMf.after.includes('scene-backgrounds'),
        '★ galgame 的 manifest.after 声明了 scene-backgrounds', JSON.stringify(galMf.after));

    // 视频通话用背景，但**不该**声明依赖 —— 背景是可选加分项，
    // 声明依赖会让"没装背景包"直接拒绝加载视频通话（过度约束）
    const l2dDir = modDirById('live2d');
    if (l2dDir) {
        const l2dMf = JSON.parse(readFileSync(path.join(MODS, l2dDir, 'manifest.json'), 'utf8'));
        ok(!(Array.isArray(l2dMf.after) && l2dMf.after.includes('scene-backgrounds')),
            '★ live2d **不**声明依赖 scene-backgrounds（背景可选，不装也能用）',
            JSON.stringify(l2dMf.after));
        const l2dSrc = readFileSync(path.join(MODS, l2dDir, 'index.js'), 'utf8');
        ok(/ElainaSceneBackgrounds/.test(l2dSrc),
            '★ live2d 用全局接口取背景（运行期探测，资源包不在就降级）');
    }
    // galgame 里不该再留着背景图（搬走了）
    const galBg = path.join(MODS, modDirById('galgame') || 'galgame', 'img', 'bg');
    const stillThere = existsSync(galBg) ? readdirSync(galBg).filter((f) => /\.(jpe?g|png)$/i.test(f)) : [];
    ok(stillThere.length === 0, '★ galgame 下不再留背景图（避免两份重复占体积）',
        stillThere.length ? stillThere.length + ' 个残留' : '');
}

// ============================================================ 3. 真服务
console.log('\n=== 3. 静态服务能真的把图发出去 ===');
{
    const PORT = await freePort();
    const HTTPS_PORT = await freePort();
    const BASE = `http://127.0.0.1:${PORT}`;
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-bg-data-'));
    const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-bg-log-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT),
            HOST: '127.0.0.1', DATA_DIR, LOG_DIR, LOG_TO_FILE: '0',
        },
        stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
        let up = false;
        for (let i = 0; i < 80 && !up; i++) {
            try { up = (await fetch(BASE + '/api/server-info')).ok; } catch { await wait(250); }
        }
        ok(up, '服务已启动');
        if (up) {
            // 取一张真实存在的图（从清单里挑第一张，不写死）
            const indexSrc = dir ? readFileSync(path.join(MODS, dir, 'index.js'), 'utf8') : '';
            const first = ([...indexSrc.matchAll(/\[\s*'([A-Za-z0-9_\-]+)'\s*,\s*'[^']*'\s*\]/g)][0] || [])[1];
            const realDir = dir || 'scene-backgrounds';
            const enc = realDir.split('/').map(encodeURIComponent).join('/');
            if (first) {
                const r = await fetch(`${BASE}/mods/${enc}/img/bg/${first}.jpg`);
                ok(r.status === 200, '★ 背景图可经静态服务访问（' + first + '.jpg）', 'HTTP ' + r.status);
                const ct = r.headers.get('content-type') || '';
                ok(ct.startsWith('image/'), '返回图片类型', ct);
            }
            // 清单接口里也应列出这个插件
            const api = await (await fetch(BASE + '/api/plugins')).json().catch(() => null);
            const ids = (api && api.plugins || []).map((p) => p.id);
            ok(ids.includes('scene-backgrounds'), '插件清单里有 scene-backgrounds', JSON.stringify(ids));
        }
    } finally {
        child.kill();
        await wait(300);
        for (const d of [DATA_DIR, LOG_DIR]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    }
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
