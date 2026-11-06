// 检查脚本共用的浏览器启动器：浏览器路径与屏蔽外网都是环境相关配置，只留一份。
// 硬编码浏览器路径换台机器就挂；不屏蔽外网时 CDN 字体样式表会把 domcontentloaded 拖到超时，
// 表现为与产品无关的假失败；屏蔽外网同时让结果不受 CDN 可用性影响。

// playwright-core 按顺序解析（本仓库零依赖、不装 npm 包）：
// ELAINACHAT_PLAYWRIGHT 环境变量 → 同级 ../android-app → 本仓库 node_modules；
// 都找不到时抛一条说清楚怎么办的错误，而不是把 ENOTFOUND 甩给读者。
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
 * 让 Chromium 把所有外部域名当作解析失败，只放行回环地址。
 * MAP * 连字面 IP 也拦，必须显式放行 127.0.0.1，否则被测服务自己都打不开。
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
