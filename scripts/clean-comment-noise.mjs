// 去掉注释里的「★」标记符与变更史叙述（见 AGENTS.md D8）。
//
// 为什么要有这个脚本：`web/js/` 与 `server/` 的注释里有大量 `★` 前缀与
// 「2026-09 修的真 bug」「实测踩到」「旧实现 …」这类叙述。它们不解释代码
// 为什么这样写，只复述改动之前长什么样 —— 读者要的是「为什么」。
// 规则写在 AGENTS.md，但规则只能拦新增行；存量要靠一遍机械改写。
//
// 只做确定性替换，不做任何语义改写：
//   ① 行首的 `★` / `★★` 标记符 —— 删掉（它只表示"这条重要"）
//   ② 行尾的 `★ 2026-10` 这类日期尾巴 —— 删掉
//   ③ 「（2026-09 修的真 bug）」这类括号 —— 整体删掉
//
// ★ 两道安全闸（都来自踩坑）：
//   · **只处理整行注释**：行内 `// …` 一律不碰 —— 那里常贴着示例代码
//     （`s.set('seen', '2026-10-17')`），机械替换会把代码改坏。
//   · **行首星号必须后跟空白**：`**加粗**` 这种 markdown 星号不是标记符。
//
// 剩下的「实测踩到」「旧实现」这类**句子级**叙述不由脚本处理 ——
// 机械删词只会得到 `核心：—— 之前打的是` 这种残句，反而更难读。
// 那部分按 AGENTS.md §4 逐文件人工清理。
//
// 用法：
//   node scripts/clean-comment-noise.mjs --dry-run 只看会改哪些行
//   node scripts/clean-comment-noise.mjs           改文件

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './check-harness.mjs';

const DRY = process.argv.includes('--dry-run');

/** 目录名命中即整棵跳过（第三方库、模型、图片、产物） */
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'models', 'img', 'dist', '.git']);

/** 括号里带年份 / 轮次 / 实证词的叙述：整段删掉 */
const PAREN_NOISE = /（[^（）]{0,80}?(?:20\d\d-\d\d|20\d\d 年|第[一二三四五六七八九十]+[次轮版])[^（）]{0,80}?）/g;

/** 行尾日期标记：` ★ 2026-10`、` ★ 2026-10（原生适配）` */
const TRAILING_DATE = /[ \t]*★+[ \t]*20\d\d(?:-\d\d)?(?:（[^）]*）)?[ \t]*$/;

/** 行首标记符：`// ★ `、`//  ★ `、`* ★★ ` —— 星号后必须是空白 */
const LEADING_STAR = /^(\s*(?:\/\/|\*|\/\*\*?)\s+)(?:★+(?=\s)\s*)+/;
/** 块注释续行里、缩进后紧跟 `★ ` 的行 */
const LEADING_STAR_INLINE = /^(\s+)★+(?=\s)\s+/;

/** 单独占一行的分区横幅分隔线（星号删掉后只剩它，没有信息） */
const BARE_RULE = /^\s*(?:\/\/|\*)?\s*(?:[=\-─]{4,}|\*{2,})\s*$/;

/** 注释变成空壳：删掉这一行 */
const EMPTY_COMMENT = /^\s*(?:\/\/|\*|\/\*\*?)\s*(?:[=\-─]{2,}|[·。：:])?\s*$/;

/** 该行是不是"整行注释"（不含行内注释） */
function isWholeCommentLine(line) {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith('//')) return true;
    if (t.startsWith('/*')) return true;
    if (t.startsWith('<!--')) return true;
    // 块注释续行：` * …`；星号后必须是空白或行尾，否则是 markdown 加粗
    if (/^\*(\s|$)/.test(t)) return true;
    return false;
}

function rewriteComment(line) {
    let out = line;
    out = out.replace(LEADING_STAR, '$1');
    out = out.replace(LEADING_STAR_INLINE, '$1');
    out = out.replace(TRAILING_DATE, '');
    out = out.replace(PAREN_NOISE, '');
    return out;
}

function walk(dir, out = []) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const d of entries) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) {
            if (SKIP_DIRS.has(d.name)) continue;
            walk(p, out);
        } else if (/\.(js|mjs|css|html)$/.test(d.name)) {
            out.push(p);
        }
    }
    return out;
}

const files = new Set();
files.add(path.join(ROOT, 'web', 'serve.mjs'));
files.add(path.join(ROOT, 'web', 'index.html'));
for (const f of walk(path.join(ROOT, 'web', 'js'))) files.add(f);
for (const f of walk(path.join(ROOT, 'server'))) files.add(f);

let changedFiles = 0;
let changedLines = 0;
let removedLines = 0;

for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split(/\r?\n/);
    const out = [];
    let touched = false;
    for (const line of lines) {
        if (!isWholeCommentLine(line)) { out.push(line); continue; }
        const next = rewriteComment(line);
        if (next === line) { out.push(line); continue; }
        touched = true;
        if (EMPTY_COMMENT.test(next) || BARE_RULE.test(next)) { removedLines++; continue; }
        changedLines++;
        out.push(next);
    }
    if (!touched) continue;
    changedFiles++;
    if (!DRY) writeFileSync(file, out.join('\n'), 'utf8');
    console.log((DRY ? '[dry] ' : '') + path.relative(ROOT, file));
}

console.log(`\n改动文件 ${changedFiles} 个，改写注释行 ${changedLines} 行，删除空壳行 ${removedLines} 行`);
