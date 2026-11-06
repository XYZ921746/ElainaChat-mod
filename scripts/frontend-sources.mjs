// 前端源码读取器 —— 把所有前端源码按**真实加载顺序**拼成一份文本（顺序错会让 "A 在 B 之前" 类断言静默失真）。
// 用法：import { readFrontend, listFrontendFiles } from './frontend-sources.mjs';

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB = path.join(ROOT, 'web');
/** 插件根目录：项目根的 mods/（与 data/ 平级），不在 web/ 静态根里。 */
export const MODS = path.join(ROOT, 'mods');

/** 读 index.html 里 <script src="/js/…"> 的出现顺序（真实加载顺序；defer/async 属性不改变次序），返回文件基名数组。 */
function indexHtmlScriptOrder() {
    let text = '';
    try { text = readFileSync(path.join(WEB, 'index.html'), 'utf8'); } catch { return []; }
    return [...text.matchAll(/<script[^>]*src="\/js\/([^"]+)"[^>]*><\/script>/g)].map((m) => m[1]);
}

/**
 * 按加载顺序列出前端源码：index.html → css/base.css（样式断言的数据源，漏收会在空串上假"通过"）→ web/*.js →
 * web/js/*.js（照抄 index.html 的 <script> 顺序，未列出的按字典序追加）→ mods/ → 主题目录。
 * 顺序必须与真实加载一致（断言常用 indexOf(A)/indexOf(B) 取中间源码，顺序错会静默失真）。
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

    pushIfFile(path.join(WEB, 'index.html'));

    pushIfFile(path.join(WEB, 'css', 'base.css'));

    pushDir(WEB, (n) => n.endsWith('.js'));

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

    // 插件目录：路径统一从 MODS 取 —— 写错不报错而是静默少读，断言在空串上假"通过"
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
            // 插件自带的 HTML 片段也要收：界面结构在自己的 .html 里，不收会让其 getElementById 全被误报
            pushDir(dir, (n) => n.endsWith('.html'));
            pushDir(path.join(dir, 'js'), (n) => n.endsWith('.js'));
        }
    }

    // 主题目录：多主题切换后，样式断言要能看到全部主题
    const themesDir = path.join(WEB, 'themes');
    if (existsSync(themesDir)) {
        pushDir(themesDir, (n) => n.endsWith('.css') || n.endsWith('.js'));
    }

    return out;
}

/** 把全部前端源码拼成一份文本；每个文件前加分隔注释标明相对路径，报错行号可回溯到具体文件 */
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

/** 样式断言用：「HTML 骨架 + 基础样式层 + 设置层」拼成的一份文本（只读骨架会在空串上假"通过"）。 */
export function readHtmlAndStyles() {
    const read = (rel) => {
        try { return readFileSync(path.join(WEB, rel), 'utf8'); } catch { return ''; }
    };
    return read('index.html') + '\n' + read('css/base.css') + '\n' + read('css/settings.css');
}

export function readWebFile(rel) {
    const p = path.join(WEB, rel);
    try { return readFileSync(p, 'utf8'); } catch { return ''; }
}
