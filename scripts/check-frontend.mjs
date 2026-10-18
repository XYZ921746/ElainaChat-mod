// 前端结构检查：DOM 引用、内联脚本语法、Store 键白名单、消息渲染。
//
// 合并自四个独立脚本（check-dom-refs / check-inline-scripts /
// check-store-keys / check-message-render）—— 它们测的都是"前端源码的静态结构"，
// 共享同一份 readFrontend()，拆成四个文件只是各自多抄一遍样板。
//
// 每段用例在自己的函数作用域里跑，断言经 ctx.ok 记账，
// 失败信息形如「DOM 引用 :: 第 812 行：getElementById('x') —— HTML 里没有这个 id」。
//
// 用法：node scripts/check-frontend.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readFrontend } from './frontend-sources.mjs';
import { runChecks, ROOT } from './check-harness.mjs';

const HTML_FILE = path.join(ROOT, 'web', 'index.html');
const JS_DIR = path.join(ROOT, 'web', 'js');

// ────────────────────────────────────────────────────────────
// 1. DOM 引用落地
//
// 单文件应用没有构建期检查，`document.getElementById('x')` 写错一个字母
// 只会得到 null，然后在某个不常走的代码路径上炸成 "Cannot read properties
// of null"。改 id、重命名元素时尤其容易漏。这段在打开浏览器之前就报出来。
// ────────────────────────────────────────────────────────────

/**
 * 用花括号配对取出一段对象字面量的内容。
 *
 * 为什么不用正则：原来写的是把结尾缩进写死成 8 空格，前端拆分成模块后
 * 缩进基线变了，正则失配，于是报出"没找到 elements 映射表"—— 把"缩进变了"
 * 误报成"脚本过时"。改成"匹配到第一个 };" 也不行：非贪婪匹配会在映射表
 * 内部的嵌套对象处提前停下。配对扫描对缩进和嵌套都免疫。
 */
function extractBalancedObject(text, startMarker) {
    const start = text.indexOf(startMarker);
    if (start < 0) return null;
    const open = text.indexOf('{', start);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        // 跳过字符串/模板串里的花括号（映射表的值是 getElementById('x')，含引号）
        if (ch === '"' || ch === "'" || ch === '`') {
            const q = ch; i++;
            while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; }
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return text.slice(open + 1, i); }
    }
    return null;
}

async function caseDomRefs(c) {
    // 前端拆分后：id 定义在 index.html，但 getElementById 调用散在 web/js/*.js ——
    // 必须读**整个前端**，只读 index.html 会漏掉绝大多数调用点，等于把检查废掉。
    const html = readFrontend();

    // 收集 HTML 里真实存在的 id
    const htmlIds = new Set();
    for (const m of html.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)) htmlIds.add(m[1]);
    // 运行时动态创建的 id（前端自己 appendChild 出来的）也要算进来
    for (const m of html.matchAll(/\.id\s*=\s*["']([A-Za-z][\w-]*)["']/g)) htmlIds.add(m[1]);
    for (const m of html.matchAll(/setAttribute\(\s*["']id["']\s*,\s*["']([^"']+)["']/g)) htmlIds.add(m[1]);

    const problems = [];

    // 所有 getElementById('x') 的目标必须存在
    const getByIdRe = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
    const seenById = new Map();
    for (const m of html.matchAll(getByIdRe)) {
        const id = m[1];
        if (htmlIds.has(id)) continue;
        const line = html.slice(0, m.index).split('\n').length;
        if (!seenById.has(id)) seenById.set(id, line);
    }
    for (const [id, line] of seenById) {
        problems.push(`第 ${line} 行：getElementById('${id}') —— HTML 里没有这个 id`);
    }

    // elements.xxx 必须都在 elements 映射表里定义
    const mapBody = extractBalancedObject(html, 'const elements = {');
    if (mapBody == null) {
        problems.push('没找到 elements 映射表（花括号配对失败，需要检查本脚本）');
    } else {
        const definedKeys = new Set();
        for (const m of mapBody.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) definedKeys.add(m[1]);

        // 只检查 elements.xxx 的读取；elements.xxx = ... 是赋值，不算
        const usedKeys = new Map();
        for (const m of html.matchAll(/elements\.([A-Za-z_$][\w$]*)/g)) {
            const key = m[1];
            if (definedKeys.has(key)) continue;
            const line = html.slice(0, m.index).split('\n').length;
            if (!usedKeys.has(key)) usedKeys.set(key, line);
        }
        for (const [key, line] of usedKeys) {
            problems.push(`第 ${line} 行：elements.${key} —— 映射表里没有这个键`);
        }
        console.log(`  elements 映射表：定义了 ${definedKeys.size} 个元素。`);
    }

    console.log(`  HTML 中的 id 共 ${htmlIds.size} 个。`);
    c.ok(problems.length === 0, '所有 DOM 引用都能落地',
        problems.length ? `\n      · ${problems.join('\n      · ')}` : '');
}

// ────────────────────────────────────────────────────────────
// 2. 内联脚本语法
//
// 单文件应用的内联 <script> 没有任何构建期语法检查，写错一个括号要等到
// 打开页面白屏才发现。这里用 vm.SourceTextModule 真正解析一遍。
// ────────────────────────────────────────────────────────────

async function caseInlineScripts(c) {
    const vm = await import('node:vm');
    const SourceTextModule = vm.SourceTextModule;
    const html = readFileSync(HTML_FILE, 'utf8');

    const errors = [];
    let checked = 0;

    const check = (code, label) => {
        checked++;
        try {
            // eslint-disable-next-line no-new
            new SourceTextModule(code, { identifier: label });
        } catch (e) {
            errors.push(`${label}: ${e.message}`);
        }
    };

    // 内联 <script> 块
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
        const code = m[1];
        if (!code.trim()) continue;
        const line = html.slice(0, m.index).split('\n').length;
        check(code, `index.html 内联脚本(第 ${line} 行起)`);
    }

    // web/js/ 下的外置脚本
    if (readdirSync) {
        for (const f of readdirSync(JS_DIR).filter((n) => n.endsWith('.js')).sort()) {
            check(readFileSync(path.join(JS_DIR, f), 'utf8'), `web/js/${f}`);
        }
    }

    c.ok(checked > 0, `解析了 ${checked} 段脚本`, checked ? '' : '一段都没找到');
    c.ok(errors.length === 0, '★ 所有脚本语法正确',
        errors.length ? `\n      · ${errors.join('\n      · ')}` : '');
}

// ────────────────────────────────────────────────────────────
// 3. Store DATA_KEYS 白名单 ↔ 实际使用的键
//
// Store 有个特性（也是坑）：setItem 只对 **DATA_KEYS 白名单里的键**入队推送
// （写进 data/），其余键**只写内存缓存** —— 表现为"生效了，刷新就回去"。
// 这个坑踩过三次（elaina_mods_order / elaina_live2d_model_order /
// elaina_mods_top_order），每次的修复都是"把键加回白名单"，
// 但没有检查盯着的话，下一个新键还会漏。
// ────────────────────────────────────────────────────────────

async function caseStoreKeys(c) {
    const storeSrc = readFileSync(path.join(JS_DIR, 'store.js'), 'utf8');

    // 从 store.js 源码解析 DATA_KEYS 白名单（不维护第二份清单）
    const keysBlock = storeSrc.match(/DATA_KEYS\s*=\s*\[[\s\S]*?\]/);
    c.ok(Boolean(keysBlock), 'store.js 里能解析到 DATA_KEYS 数组');
    const whitelist = new Set();
    if (keysBlock) {
        for (const m of keysBlock[0].matchAll(/'([^']+)'/g)) whitelist.add(m[1]);
    }
    c.ok(whitelist.size >= 10, '白名单解析出 ' + whitelist.size + ' 个键（应 ≥10）');

    // 全量扫描 setItem 的字面量键
    const files = readdirSync(JS_DIR).filter((f) => f.endsWith('.js'))
        .map((f) => path.join(JS_DIR, f));
    const html = readFileSync(HTML_FILE, 'utf8');

    const missing = new Set();     // 用了但不在白名单
    let literalCalls = 0;
    for (const [fp, src] of files.map((f) => [f, readFileSync(f, 'utf8')])) {
        // 字面量：Store.setItem('xxx', …)
        for (const m of src.matchAll(/Store\.setItem\(\s*'([^']+)'/g)) {
            literalCalls++;
            if (!whitelist.has(m[1])) missing.add(path.basename(fp) + ' → ' + m[1]);
        }
    }
    for (const m of html.matchAll(/Store\.setItem\(\s*'([^']+)'/g)) {
        literalCalls++;
        if (!whitelist.has(m[1])) missing.add('index.html(内联) → ' + m[1]);
    }
    c.ok(literalCalls >= 5, '扫到 ' + literalCalls + ' 处字面量 setItem 调用');
    c.ok(missing.size === 0,
        '★ 所有字面量 setItem 的键都在 DATA_KEYS 白名单里（不会刷新即丢）',
        missing.size ? [...missing].join('；') : '');

    // 关键键必须存在（业务约定）
    for (const k of ['elaina_mods_order', 'elaina_mods_groups', 'elaina_mods_group_of',
        'elaina_mods_top_order', 'elaina_live2d_model_order', 'elaina_announce_read']) {
        c.ok(whitelist.has(k), '白名单包含 ' + k);
    }
}

// ────────────────────────────────────────────────────────────
// 4. 消息渲染（Markdown + LaTeX）
//
// ① **安全**：marked 会照单全收 `[x](javascript:...)`，生成可点击的
//    `href="javascript:..."` —— 那等于把"点一下就执行任意代码"送给模型输出
//    （模型输出受提示词影响，而提示词可被对话内容影响）。
//    必须先 escapeHtml 再 marked，并在渲染后清洗危险协议。
//
// ② **回落**：marked / katex 任一缺失（vendor 没同步、离线失败）时，
//    必须静默降级为纯文本转义，而不是抛错或白屏。
// ────────────────────────────────────────────────────────────

async function caseMessageRender(c) {
    const html = readFrontend();
    const ui = readFileSync(path.join(JS_DIR, 'ui.js'), 'utf8');
    const mods = readFileSync(path.join(JS_DIR, 'mods.js'), 'utf8');

    c.ok(/function renderMessageText/.test(ui), 'ui.js 里有 renderMessageText');
    c.ok(/window\.marked/.test(ui), '使用 marked 做 Markdown 渲染');
    c.ok(/window\.katex/.test(ui), '使用 katex 做公式渲染');
    c.ok(/<script src="\/vendor\/marked\/marked\.min\.js">/.test(html), 'index.html 引入 marked');
    c.ok(/<script src="\/vendor\/katex\/katex\.min\.js">/.test(html), 'index.html 引入 katex');
    c.ok(/katex\.min\.css/.test(html), 'index.html 引入 katex 样式');

    // 顺序：必须先 escapeHtml，再交给 marked
    const escIdx = ui.indexOf('escapeHtml(raw)');
    const mdIdx = ui.indexOf('mdParse(safe');
    c.ok(escIdx > 0 && mdIdx > 0 && escIdx < mdIdx, '★ 先 escapeHtml 再 marked（顺序反了就是 XSS）');
    c.ok(/javascript\|data\|vbscript\|file/.test(ui), '★ 清洗危险协议的链接');
    c.ok(/<a\\b\[\^>\]\*href/.test(ui) || /href\\s\*=\\s\*"\(\[\^"\]\*\)"/.test(ui), '★ 检查 <a href> 的协议');
    c.ok(/<img\\b\[\^>\]\*src/.test(ui) || /src\\s\*=\\s\*"\(\[\^"\]\*\)"/.test(ui), '★ 检查 <img src> 的协议');

    c.ok(/if \(!hasMd \|\| !mdParse\) return escapeHtml\(raw\);/.test(ui), '★ 无 marked 时回落纯文本');
    c.ok(/catch \(e\) \{ return escapeHtml\(raw\); \}/.test(ui), '★ marked 抛错时回落纯文本');
    c.ok(/window\.katex && typeof window\.katex\.renderToString === 'function'/.test(ui), '★ katex 缺失时跳过公式渲染');

    c.ok(/\(\\^\|\\n\)\\s\*\\\|\[\^\\n\]\*\\\|/.test(ui) || /\\s\*\\\|\[\^\\n\]\*\\\|/.test(ui),
        '★ hasMd 检测覆盖表格（上游漏了，表格会原样露出管道符）');
    c.ok(/BT0|\\uE200/.test(ui), '★ 反引号占位符处理（escapeHtml 会把 ` 转成 &#96; 导致代码块失效）');

    const callSites = (ui.match(/renderMessageText\(message\.text\)/g) || []).length;
    c.ok(callSites >= 2, '两处消息渲染都改用 renderMessageText（用户气泡 + AI 气泡）', 'count=' + callSites);
    c.ok(!/whitespace-pre-wrap">\$\{escapeHtml\(message\.text\)\}/.test(ui),
        '★ 旧的纯文本渲染已被替换（否则 Markdown 不生效）');

    c.ok(/<scene>/.test(ui), '剥离独占行的 <scene> 标记');
    c.ok(/syncSceneHint|__galgameSceneHint|sceneHint/.test(mods) || /setPromptHint/.test(mods),
        'mod 系统提供 system 提示词注入（场景切换指令靠它送达模型）');
}

await runChecks({
    title: '前端结构（DOM 引用 / 内联脚本 / Store 键 / 消息渲染）',
    usage: 'node scripts/check-frontend.mjs',
    cases: [
        { name: 'DOM 引用落地', fn: caseDomRefs },
        { name: '内联脚本语法', fn: caseInlineScripts },
        { name: 'Store 键白名单', fn: caseStoreKeys },
        { name: '消息渲染', fn: caseMessageRender },
    ],
});
