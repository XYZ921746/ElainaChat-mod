// 检查脚本共用的“源码抽取”工具。
// 为什么要有它：extractFn/extractFnFrom/extractFnNamed 曾在 6 个检查里各写一份，
//   而其中大多数只做朴素的花括号配对 —— 函数体里只要出现 '}' 字符串、模板串
//   或参数默认值 {}，就会截出半截函数，报一个和本函数无关的语法错误。
//   这里收成一份实现：跳过字符串 / 模板串 / 行注释 / 块注释，再配对括号与花括号。
//   代价是几行工具代码，收益是所有检查对“函数里有什么”不再各有一套规则。

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 跳过模板串里的 ${...} 表达式（可嵌套字符串/模板/对象字面量），返回 '}' 之后的下标 */
function skipTemplateExpr(src, i) {
    let depth = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipComment(src, i); continue; }
        if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
        if (c === '/' && looksLikeRegex(src, i)) { i = skipRegex(src, i); continue; }
        if (c === '{') depth += 1;
        else if (c === '}') {
            if (depth === 0) return i + 1;
            depth -= 1;
        }
        i += 1;
    }
    return i;
}

/** 跳过一段字符串 / 模板串（含引号），返回引号之后的下标 */
function skipString(src, i) {
    const q = src[i];
    if (q === '`') {
        i += 1;
        while (i < src.length) {
            const c = src[i];
            if (c === '\\') { i += 2; continue; }
            if (c === '`') return i + 1;
            if (c === '$' && src[i + 1] === '{') { i = skipTemplateExpr(src, i + 2); continue; }
            i += 1;
        }
        return i;
    }
    i += 1;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === q) { i += 1; break; }
        i += 1;
    }
    return i;
}

/** 跳过注释，返回注释之后的下标 */
function skipComment(src, i) {
    if (src[i] === '/' && src[i + 1] === '/') {
        i += 2;
        while (i < src.length && src[i] !== '\n') i += 1;
        return i;
    }
    if (src[i] === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
        return Math.min(src.length, i + 2);
    }
    return i;
}

/** 正则字面量：/.../flags（含字符类里的 / 与转义） */
function skipRegex(src, i) {
    i += 1;
    let inClass = false;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { i += 1; break; }
        i += 1;
    }
    while (i < src.length && /[a-z]/i.test(src[i])) i += 1;
    return i;
}

/** '/' 在当前位置是正则字面量的开头，还是除号？用前一个有效字符做启发式判断。 */
function looksLikeRegex(src, i) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j -= 1;
    if (j < 0) return true;
    const c = src[j];
    if ('(,=:[!&|?{};+-*%<>~^'.includes(c)) return true;
    // return /re/、case /re/、typeof /re/ 这类关键字之后
    const before = src.slice(Math.max(0, j - 12), j + 1);
    return /(?:return|case|typeof|instanceof|in|of|new|delete|void|throw|else|do)$/.test(before);
}

/** 从 openIdx 的 '(' 开始配对，返回 ')' 之后的下标；失败返回 -1 */
function matchParen(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length;) {
        const c = src[i];
        if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipComment(src, i); continue; }
        if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
        if (c === '/' && looksLikeRegex(src, i)) { i = skipRegex(src, i); continue; }
        if (c === '(') depth += 1;
        else if (c === ')') { depth -= 1; if (depth === 0) return i + 1; }
        i += 1;
    }
    return -1;
}

/** 从 openIdx 的 '{' 开始配对，返回 '}' 之后的下标；失败返回 -1 */
function matchBrace(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length;) {
        const c = src[i];
        if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipComment(src, i); continue; }
        if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
        if (c === '/' && looksLikeRegex(src, i)) { i = skipRegex(src, i); continue; }
        if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; if (depth === 0) return i + 1; }
        i += 1;
    }
    return -1;
}

/**
 * 按函数名取出完整函数声明（含 async 前缀）。
 *
 * @param {string} source 源码全文
 * @param {string} name 函数名
 * @param {{required?:boolean,label?:string}} [opts]
 *   required=false 时找不到返回空串（有些检查把“没有”当合法分支）；
 *   默认找不到就抛错——避免“函数被改名后检查静默匹配空串”。
 */
export function extractFunction(source, name, opts = {}) {
    const src = String(source == null ? '' : source);
    const required = opts.required !== false;
    const label = opts.label || '源码';
    const re = new RegExp('(?:^|[^\\w$.])function\\s+' + escapeRegExp(name) + '\\s*\\(', 'm');
    const m = re.exec(src);
    if (!m) {
        if (required) throw new Error('在 ' + label + ' 里找不到函数: ' + name + '（重命名了？请同步更新本检查）');
        return '';
    }
    let start = m.index + (m[0].startsWith('function') ? 0 : 1);
    // 把 async 前缀一起带上（如果紧邻）
    const am = src.slice(Math.max(0, start - 12), start).match(/async\s*$/);
    if (am) start -= am[0].length;
    const openParen = src.indexOf('(', m.index + m[0].length - 1);
    const afterParen = matchParen(src, openParen);
    if (afterParen < 0) {
        if (required) throw new Error('函数 ' + name + ' 的参数表括号不配平（' + label + '）');
        return '';
    }
    const openBrace = src.indexOf('{', afterParen);
    const end = openBrace < 0 ? -1 : matchBrace(src, openBrace);
    if (end < 0) {
        if (required) throw new Error('函数 ' + name + ' 的函数体花括号不配平（' + label + '）');
        return '';
    }
    return src.slice(start, end);
}

/** 按类名取出完整类声明（class Name ... { ... }） */
export function extractClass(source, name, opts = {}) {
    const src = String(source == null ? '' : source);
    const required = opts.required !== false;
    const label = opts.label || '源码';
    const re = new RegExp('(?:^|[^\\w$.])class\\s+' + escapeRegExp(name) + '\\b', 'm');
    const m = re.exec(src);
    if (!m) {
        if (required) throw new Error('在 ' + label + ' 里找不到类: ' + name + '（重命名了？请同步更新本检查）');
        return '';
    }
    const start = m.index + (m[0].startsWith('class') ? 0 : 1);
    const openBrace = src.indexOf('{', m.index);
    const end = openBrace < 0 ? -1 : matchBrace(src, openBrace);
    if (end < 0) {
        if (required) throw new Error('类 ' + name + ' 的花括号不配平（' + label + '）');
        return '';
    }
    return src.slice(start, end);
}

/** 从 start 开始找一条语句的结尾（顶层的 ';'），跳过字符串/注释/正则与括号嵌套 */
function findStatementEnd(src, start) {
    const depth = { '(': 0, '[': 0, '{': 0 };
    for (let i = start; i < src.length;) {
        const c = src[i];
        if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipComment(src, i); continue; }
        if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
        if (c === '/' && looksLikeRegex(src, i)) { i = skipRegex(src, i); continue; }
        if (c === '(') depth['('] += 1;
        else if (c === ')') depth['('] -= 1;
        else if (c === '[') depth['['] += 1;
        else if (c === ']') depth['['] -= 1;
        else if (c === '{') depth['{'] += 1;
        else if (c === '}') depth['{'] -= 1;
        else if (c === ';' && depth['('] === 0 && depth['['] === 0 && depth['{'] === 0) return i + 1;
        i += 1;
    }
    return -1;
}

/** 取一个顶层变量声明（const/let/var NAME = ...;），找不到时按 required 处理 */
export function extractVariable(source, name, opts = {}) {
    const src = String(source == null ? '' : source);
    const required = opts.required !== false;
    const label = opts.label || '源码';
    const re = new RegExp('^(?:const|let|var)\\s+' + escapeRegExp(name) + '\\s*=', 'm');
    const m = re.exec(src);
    if (!m) {
        if (required) throw new Error('在 ' + label + ' 里找不到变量声明: ' + name);
        return '';
    }
    const end = findStatementEnd(src, m.index);
    if (end < 0) {
        if (required) throw new Error('变量声明 ' + name + ' 没有找到结尾分号（' + label + '）');
        return '';
    }
    return src.slice(m.index, end);
}

/**
 * 取**所有顶层函数声明**拼成一段可执行脚本。
 * 用途：把“整个模块的函数环境”装进同一个 VM，而不是只抠目标函数 ——
 * 目标函数依赖同文件的 helper 时，后者自动在场，不会 ReferenceError。
 */
export function extractTopLevelFunctions(source) {
    const src = String(source == null ? '' : source);
    const names = [];
    for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
        if (!names.includes(m[1])) names.push(m[1]);
    }
    return names.map((n) => extractFunction(src, n)).join('\n\n');
}

/** 去掉注释后的源码 —— 断言“不许再出现 X”时，解释 X 的注释不该算违规 */
export function stripComments(src) {
    return String(src == null ? '' : src)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^[ \t]*\/\/[^\n]*/gm, '');
}

/** 造一个 VM 沙箱；extra 里的键会被复制进去。window/globalThis 指回沙箱自身。 */
export function makeVmSandbox(extra = {}) {
    const sandbox = { console, ...extra };
    sandbox.globalThis = sandbox;
    if (!sandbox.window) sandbox.window = sandbox;
    vm.createContext(sandbox);
    return sandbox;
}

/** 按给定顺序把经典脚本跑进同一个沙箱（顶层 function/const 对后续脚本可见，类似浏览器）。 */
export function runClassicScripts(files, sandbox) {
    for (const file of files) {
        vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: String(file) });
    }
    return sandbox;
}
