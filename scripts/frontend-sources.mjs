// 前端源码读取器 —— 拆分之后，检查脚本仍然能"看到全部前端代码"。
// 为什么需要它：
//   前端逻辑曾整体住在 web/index.html 里，检查脚本用
//   `readFileSync('web/index.html')` + 正则去断言（"有没有这个函数""这段逻辑对不对"）。
//   主脚本拆到 web/js/*.js、插件拆到 mods/* 之后，那些脚本读到的就只剩 HTML 骨架 ——
//   断言会全部失败，而且**失败原因是"读错文件"，不是"功能坏了"**，那种红最难排查。
//   所以这里提供 readFrontend()：把所有前端源码按**加载顺序**拼成一份文本，
//   检查脚本改用它就等于"仍然在看整个前端"。
// 顺序必须与 index.html 里 <script> 的实际加载顺序一致 —— 有些脚本会断言
// "A 定义在 B 之前"（比如 chat-providers.js 必须在主脚本之前加载），
// 拼接顺序错了会让这类断言产生假结果。
// 用法：
//   import { readFrontend, listFrontendFiles } from './frontend-sources.mjs';
//   const html = readFrontend();

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB = path.join(ROOT, 'web');
/**
 * 插件根目录。
 *
 * 在**项目根**的 mods/（与 data/ 平级），不在 web/ 静态根里 ——
 *   插件不是"应用前端资源的一部分"，而是与运行期数据同级的独立内容。
 *   这里导出给检查脚本共用，避免各处再写一遍路径（写错会静默少读，见下）。
 */
export const MODS = path.join(ROOT, 'mods');

/**
 * 读 index.html 里 <script src="/js/…"> 的出现顺序 —— 那才是真实的加载顺序。
 *
 * @returns {string[]} 文件基名（如 'core.js'），按出现先后排列
 */
function indexHtmlScriptOrder() {
    let text = '';
    try { text = readFileSync(path.join(WEB, 'index.html'), 'utf8'); } catch { return []; }
    // 允许标签上带 defer / async 等属性：顺序由出现次序决定，与属性无关
    return [...text.matchAll(/<script[^>]*src="\/js\/([^"]+)"[^>]*><\/script>/g)].map((m) => m[1]);
}

/**
 * 按加载顺序列出前端源码文件。
 *
 * 顺序规则（与 index.html 保持一致）：
 *   1. index.html 本身（DOM 骨架与内联脚本）
 *   1b. web/css/base.css（基础样式层 —— 样式断言要看的规则都在这里，
 *       只读 index.html 会拿到空串，断言照样"通过"）
 *   2. web/*.js 顶层脚本
 *   3. web/js/*.js —— 照抄 index.html 里 <script src> 的真实顺序；
 *      未在 index.html 里出现的追加到末尾（字典序）
 *   4. mods/<name>/*.js（插件，按名字排序）
 *      注意是**项目根**的 mods/，不是 web/ 下的静态根。
 *
 * 第 3 步为什么要照抄加载顺序：大量断言用 html.indexOf(A) / indexOf(B) 取
 * "A 到 B 之间的源码"，若拼接顺序与真实加载顺序不一致，B 可能落在 A 之前，
 * slice 得到空串 —— 断言会**静默失真**（看起来通过了，其实什么都没测）。
 *
 * 只收文本类文件（.html/.js/.css），跳过二进制与 node_modules。
 */
export function listFrontendFiles() {
    const out = [];

    const pushIfFile = (p) => {
        if (existsSync(p) && statSync(p).isFile()) out.push(p);
    };
    const pushDir = (dir, filter) => {
        if (!existsSync(dir)) return;
        const names = readdirSync(dir)
            .filter((n) => filter(n) && statSync(path.join(dir, n)).isFile())
            .sort();
        for (const n of names) out.push(path.join(dir, n));
    };

    // 1) HTML 骨架（含内联脚本）
    pushIfFile(path.join(WEB, 'index.html'));

    // 1b) 基础样式层。样式断言（"某条规则必须存在"）看的就是它：
    //     样式不在 index.html 里之后，漏收这个文件会让那些断言在空串上匹配 ——
    //     通过，但什么都没测。
    pushIfFile(path.join(WEB, 'css', 'base.css'));

    // 2) web/ 顶层的独立脚本（如 live2d-video.js）
    pushDir(WEB, (n) => n.endsWith('.js'));

    // 3) web/js/ 下的模块 —— 按 index.html 的 <script> 顺序，而不是字典序
    const jsDir = path.join(WEB, 'js');
    if (existsSync(jsDir)) {
        const order = indexHtmlScriptOrder();
        const names = readdirSync(jsDir)
            .filter((n) => n.endsWith('.js') && statSync(path.join(jsDir, n)).isFile())
            .sort((a, b) => {
                const ia = order.indexOf(a), ib = order.indexOf(b);
                if (ia >= 0 && ib >= 0) return ia - ib;
                if (ia >= 0) return -1;
                if (ib >= 0) return 1;
                return a < b ? -1 : a > b ? 1 : 0;
            });
        for (const n of names) out.push(path.join(jsDir, n));
    }

    // 4) 插件目录：每个插件一个子目录，内部的 js/css 都要收进来
    //    （检查脚本会断言"插件是否真的被注册""样式有没有带进去"）
    // 目录名与位置**必须**和加载器一致。这里错了不会报错，而是**静默少读**：
    //   readFrontend() 里一个 mod 源码都没有，于是所有"断言 mod 行为"的检查
    //   其实是在空字符串上做匹配。这类假检查比没有检查更糟 ——
    //   它会给出"已验证"的错觉。所以路径统一从 MODS 常量取，别在别处重写。
    const modsDir = MODS;
    if (existsSync(modsDir)) {
        const plugins = readdirSync(modsDir)
            .filter((n) => statSync(path.join(modsDir, n)).isDirectory())
            .sort();
        for (const name of plugins) {
            const dir = path.join(modsDir, name);
            pushIfFile(path.join(dir, 'manifest.json'));
            pushDir(dir, (n) => n.endsWith('.js'));
            pushDir(dir, (n) => n.endsWith('.css'));
            // ★ 插件自带的 HTML 片段也要收（2026-10 补）。
            //   为什么：插件可以把界面结构放在自己的 .html 里，由插槽在渲染时取回来插入
            //   （Live2D 插件的 panel.html 就是这么做的）。而 check-dom-refs 靠
            //   readFrontend() 收集"哪些 id 真实存在" —— 不收这些 HTML 的话，
            //   插件脚本里所有 getElementById 都会被误报成"HTML 里没有这个 id"。
            //   实测踩到：一次报了 8 个假问题，全部指向 panel.html 里的控件。
            pushDir(dir, (n) => n.endsWith('.html'));
            // 插件自己的 js/ 子目录（若按子目录组织）
            pushDir(path.join(dir, 'js'), (n) => n.endsWith('.js'));
        }
    }

    // 5) 主题目录（多主题切换后，样式断言要能看到全部主题）
    const themesDir = path.join(WEB, 'themes');
    if (existsSync(themesDir)) {
        pushDir(themesDir, (n) => n.endsWith('.css') || n.endsWith('.js'));
    }

    return out;
}

/**
 * 把全部前端源码拼成一份文本。
 *
 * 每个文件前加一行 `/* ==== 文件: <相对路径> ==== *​/` 分隔注释 ——
 * 出问题时能从报错行号回溯到具体文件（否则只剩一个全局行号，没法定位）。
 */
export function readFrontend() {
    const files = listFrontendFiles();
    return files
        .map((f) => {
            const rel = path.relative(ROOT, f).replace(/\\/g, '/');
            let text = '';
            try { text = readFileSync(f, 'utf8'); } catch { text = ''; }
            return `/* ==== 文件: ${rel} ==== */\n${text}`;
        })
        .join('\n');
}

/**
 * 样式断言用：「HTML 骨架 + 基础样式层」拼成的一份文本。
 *
 * 为什么不是只读 index.html：样式规则住在 web/css/base.css，只读骨架时
 * `c.ok(/某条 CSS/.test(html))` 会在空串上匹配 —— 通过，但什么都没测。
 * 需要同时看 DOM 结构（id / 标签）与样式规则的地方用这个。
 */
export function readHtmlAndStyles() {
    const read = (rel) => {
        try { return readFileSync(path.join(WEB, rel), 'utf8'); } catch { return ''; }
    };
    return read('index.html') + '\n' + read('css/base.css');
}

/** 只读某个具体前端文件（相对 web/ 的路径），找不到返回空串 */
export function readWebFile(rel) {
    const p = path.join(WEB, rel);
    try { return readFileSync(p, 'utf8'); } catch { return ''; }
}
