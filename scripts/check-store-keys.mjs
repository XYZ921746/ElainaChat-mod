// 回归检查：Store 的 DATA_KEYS 白名单 ↔ 实际使用的键 必须对得上。
//
// 为什么需要它 —— Store 有个特性（也是坑）：
//   setItem 只对 **DATA_KEYS 白名单里的键**入队推送（写进 data/），
//   其余键**只写内存缓存** —— 表现为"生效了，刷新就回去"。
//   这个坑踩过三次（elaina_mods_order / elaina_live2d_model_order /
//   elaina_mods_top_order），每次的修复都是"把键加回白名单"，
//   但没有检查盯着的话，下一个新键还会漏。
//
// 怎么查：全量扫描 web/js/*.js 里所有 Store.setItem 的**字面量键名**与
//   动态拼出来的键前缀，凡是不在 DATA_KEYS 白名单里的都报出来
//   （白名单本身从 store.js 的源码里解析，不维护第二份清单）。
//
// 用法：node scripts/check-store-keys.mjs
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storeSrc = readFileSync(path.join(ROOT, 'web', 'js', 'store.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

// ── 1. 从 store.js 源码解析 DATA_KEYS 白名单 ──
const keysBlock = storeSrc.match(/DATA_KEYS\s*=\s*\[[\s\S]*?\]/);
ok(Boolean(keysBlock), 'store.js 里能解析到 DATA_KEYS 数组');
const whitelist = new Set();
if (keysBlock) {
    for (const m of keysBlock[0].matchAll(/'([^']+)'/g)) whitelist.add(m[1]);
}
ok(whitelist.size >= 10, '白名单解析出 ' + whitelist.size + ' 个键（应 ≥10）');

// ── 2. 全量扫描 setItem 的字面量键 ──
const jsDir = path.join(ROOT, 'web', 'js');
const files = readdirSync(jsDir).filter((f) => f.endsWith('.js'))
    .map((f) => path.join(jsDir, f));
const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

const missing = new Set();     // 用了但不在白名单
let literalCalls = 0;
for (const [fp, src] of files.map((f) => [f, readFileSync(f, 'utf8')])) {
    // 字面量：Store.setItem('xxx', …) / localStorage 语义的同名调用
    for (const m of src.matchAll(/Store\.setItem\(\s*'([^']+)'/g)) {
        literalCalls++;
        if (!whitelist.has(m[1])) missing.add(path.basename(fp) + ' → ' + m[1]);
    }
}
for (const m of html.matchAll(/Store\.setItem\(\s*'([^']+)'/g)) {
    literalCalls++;
    if (!whitelist.has(m[1])) missing.add('index.html(内联) → ' + m[1]);
}
ok(literalCalls >= 5, '扫到 ' + literalCalls + ' 处字面量 setItem 调用');
ok(missing.size === 0,
    '★ 所有字面量 setItem 的键都在 DATA_KEYS 白名单里（不会刷新即丢）',
    missing.size ? [...missing].join('；') : '');

// ── 3. 关键键必须存在（业务约定）──
for (const k of ['elaina_mods_order', 'elaina_mods_groups', 'elaina_mods_group_of',
    'elaina_mods_top_order', 'elaina_live2d_model_order']) {
    ok(whitelist.has(k), '白名单包含 ' + k);
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
