// 检查脚本共用的浏览器启动器。
//
// 为什么要有这个文件：**浏览器路径**与**屏蔽外网**这两件事以前散在每个检查里，
// 而它们都是环境相关的配置 —— 该只有一份。
//
// 历史上踩过的两个坑，都属于"检查脚本自己在环境里失败"（比没有检查更糟：
// 它看起来像产品坏了）：
//
//   ① 硬编码某个浏览器的路径 → 换台机器就找不到，五个 Playwright 测试无限挂起
//      （见 8.30）。所以路径只留这一处，改一处即可。
//   ② 不屏蔽外网 → 页面 <head> 里有几条从 jsdelivr CDN 拉的字体样式表
//      （noto-sans-sc / outfit）。检查机连不上外网时 Chromium 会**一直等**，
//      实测 domcontentloaded 从 0.7 秒被拖到 **68 秒** → 检查以
//      `page.goto: Timeout 30000ms exceeded` 失败，而原因与产品毫无关系（见 8.45）。
//
// 屏蔽外网还能顺带保证另一件事：检查结果不会被 CDN 的可用性影响。

// playwright-core 从安卓工程那边解析（本仓库自身零依赖，不装 npm 包）。
// 路径只此一处；将来挪了位置也只改这里。
export const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/**
 * 让 Chromium 把**所有外部域名**当作解析失败，只放行回环地址。
 *
 * ★ `MAP *` 连**字面 IP 也会拦** —— 不显式放行 127.0.0.1 的话，连被测服务
 *   自己都打不开（实测：页面 2.7 秒就报导航失败，比原来的超时更难判读）。
 */
export const BLOCK_EXTERNAL_NET =
    '--host-resolver-rules=MAP 127.0.0.1 127.0.0.1, MAP localhost 127.0.0.1, MAP * ~NOTFOUND';

/** 启动一个只连本机的测试浏览器 */
export async function launchTestBrowser(extra = {}) {
    const { chromium } = await import('file:///D:/222/android-app/node_modules/playwright-core/index.mjs');
    return chromium.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: [BLOCK_EXTERNAL_NET],
        ...extra,
    });
}
