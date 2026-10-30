// 检查脚本共用的浏览器启动器。
// 为什么要有这个文件：**浏览器路径**与**屏蔽外网**这两件事以前散在每个检查里，
// 而它们都是环境相关的配置 —— 该只有一份。
// 历史上踩过的两个坑，都属于"检查脚本自己在环境里失败"（比没有检查更糟：
// 它看起来像产品坏了）：
//   ① 硬编码某个浏览器的路径 → 换台机器就找不到，五个 Playwright 测试无限挂起
//      （见 8.30）。所以路径只留这一处，改一处即可。
//   ② 不屏蔽外网 → 页面 <head> 里有几条从 jsdelivr CDN 拉的字体样式表
//      （noto-sans-sc / outfit）。检查机连不上外网时 Chromium 会**一直等**，
//      实测 domcontentloaded 从 0.7 秒被拖到 **68 秒** → 检查以
//      `page.goto: Timeout 30000ms exceeded` 失败，而原因与产品毫无关系（见 8.45）。
// 屏蔽外网还能顺带保证另一件事：检查结果不会被 CDN 的可用性影响。

// playwright-core 从安卓工程那边解析（本仓库自身零依赖，不装 npm 包）。
// 路径只此一处；将来挪了位置也只改这里。
// 按顺序解析而不是写死绝对路径：写死的位置换个克隆目录/换台机器就 `Cannot find module`，
// 检查脚本自己在环境里失败，看起来像产品坏了。顺序为
// ELAINACHAT_PLAYWRIGHT 环境变量 → 同级 ../android-app → 本仓库 node_modules；
// 都找不到时抛一条**说清楚怎么办**的错误，而不是把 ENOTFOUND 甩给读者。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PLAYWRIGHT_CANDIDATES = [
    process.env.ELAINACHAT_PLAYWRIGHT || '',
    path.join(REPO_ROOT, '..', 'android-app', 'node_modules', 'playwright-core', 'index.mjs'),
    path.join(REPO_ROOT, 'node_modules', 'playwright-core', 'index.mjs'),
].filter(Boolean);

export function resolvePlaywrightPath() {
    for (const p of PLAYWRIGHT_CANDIDATES) {
        try { if (fs.existsSync(p)) return p; } catch (e) { /* 忽略 */ }
    }
    return '';
}

// 浏览器可执行文件同样不写死：环境变量 → Chrome → Edge（这台机器至少有一个）
const CHROME_CANDIDATES = [
    process.env.ELAINACHAT_CHROME || '',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

export function resolveChromePath() {
    for (const p of CHROME_CANDIDATES) {
        try { if (fs.existsSync(p)) return p; } catch (e) { /* 忽略 */ }
    }
    return '';
}

export const CHROME_PATH = resolveChromePath();

/**
 * 让 Chromium 把**所有外部域名**当作解析失败，只放行回环地址。
 *
 * ★ `MAP *` 连**字面 IP 也会拦** —— 不显式放行 127.0.0.1 的话，连被测服务
 *   自己都打不开（实测：页面 2.7 秒就报导航失败，比原来的超时更难判读）。
 */
export const BLOCK_EXTERNAL_NET =
    '--host-resolver-rules=MAP 127.0.0.1 127.0.0.1, MAP localhost 127.0.0.1, MAP * ~NOTFOUND';

/** 启动一个只连本机的测试浏览器（找不到 playwright / 浏览器时抛一条可执行的错误） */
export async function launchTestBrowser(extra = {}) {
    const pw = resolvePlaywrightPath();
    if (!pw) {
        throw new Error('找不到 playwright-core：请设置 ELAINACHAT_PLAYWRIGHT 指向 .../node_modules/playwright-core/index.mjs，'
            + '或把 android-app 放在本仓库的上一级（本仓库自身零依赖，不装 npm 包）');
    }
    const chrome = CHROME_PATH;
    if (!chrome) {
        throw new Error('找不到 Chrome/Edge：请设置 ELAINACHAT_CHROME 指向浏览器可执行文件');
    }
    const { chromium } = await import(pathToFileURL(pw).href);
    return chromium.launch({
        executablePath: chrome,
        headless: true,
        args: [BLOCK_EXTERNAL_NET],
        ...extra,
    });
}
