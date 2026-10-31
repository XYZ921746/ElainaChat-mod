// 版本检测回归检查：设置 → 高级「版本与更新」。
//
// 这一块的风险与 MCP / 搜索同类：它处理**远端内容**（GitHub Release 的
// tag / 说明 / 资产地址），并据此让用户去下载安装包。判错的后果不是"显示不好看"，
// 而是"把用户引到一个错的包"或"把 javascript: 地址画成下载按钮"。所以检查分三层：
//   ① 版本比较与资产归类用 **vm 真跑 web/js/update-check.js**，断言的是实现本身，
//      而不是把逻辑在检查脚本里再抄一份（抄一份 = 以后只测抄件）；
//   ② 服务端检测器注入假 fetch，穷举 404 / 限流 / DNS / 超时 / 坏 JSON / 非法仓库；
//   ③ 接线断言：路由存在、运行形态来自 ELAINA_EDITION、页脚版本与 package.json 同步。
//
// 资产归类的断言刻意包含"发布时改了名"的样本 —— 改名不该让用户下错平台。
//
// 用法：node scripts/check-update.mjs           跑全部
//       node scripts/check-update.mjs 版本比较   只跑名字含该子串的用例

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { runChecks, ROOT } from './check-harness.mjs';
import {
    createUpdateChecker, sanitizeRelease, isValidRepo, describeFetchError, DEFAULT_REPO,
    isPublicIPv4, findHostsHijack, PUBLIC_DNS_SERVERS,
} from '../server/update-check.mjs';

const WEB = path.join(ROOT, 'web');
const read = (p) => readFileSync(p, 'utf8');

/** 造一个假的 fetch 响应（只带被测代码会读的字段）。 */
function fakeResponse(status, body, headers) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => (headers && headers[String(name).toLowerCase()]) || null },
        async json() {
            if (body === undefined) throw new Error('没有 JSON 体');
            return body;
        },
    };
}

/** 一份贴近真实发布的 Release：含正式 APK、debug APK、两个 Setup、便携 zip、源码 zip。 */
const SAMPLE_RELEASE = {
    tag_name: 'v2.1.0',
    name: 'v2.1.0',
    html_url: 'https://github.com/XYZ921746/ElainaChat-mod/releases/tag/v2.1.0',
    published_at: '2026-11-01T00:00:00Z',
    body: '这次更新改了什么',
    prerelease: false,
    zipball_url: 'https://api.github.com/repos/XYZ921746/ElainaChat-mod/zipball/v2.1.0',
    assets: [
        { name: 'Elinachat-mod-2.0.0.apk', browser_download_url: 'https://github.com/x/y/releases/download/v2.1.0/Elinachat-mod-2.0.0.apk', size: 1 },
        { name: 'Elinachat-mod-debug-x86_64.apk', browser_download_url: 'https://github.com/x/y/releases/download/v2.1.0/debug.apk', size: 1 },
        { name: 'ElainaChat-Setup.exe', browser_download_url: 'https://github.com/x/y/releases/download/v2.1.0/setup.exe', size: 1 },
        { name: 'ElainaChat-win64.zip', browser_download_url: 'https://github.com/x/y/releases/download/v2.1.0/win64.zip', size: 1 },
        { name: 'source.zip', browser_download_url: 'https://github.com/x/y/releases/download/v2.1.0/source.zip', size: 1 },
    ],
};

/** 发布者改了安装包文件名后的样本：不靠 Setup 这个词也要能归类。 */
const RENAMED_RELEASE = {
    tag_name: 'release-3.0.0',
    html_url: 'https://github.com/XYZ921746/ElainaChat-mod/releases/tag/release-3.0.0',
    zipball_url: 'https://api.github.com/repos/XYZ921746/ElainaChat-mod/zipball/release-3.0.0',
    assets: [
        { name: 'ElinaChat-3.0.0.apk', browser_download_url: 'https://github.com/x/y/releases/download/3.0.0/a.apk', size: 1 },
        { name: 'ElainaChat-3.0.0-installer.exe', browser_download_url: 'https://github.com/x/y/releases/download/3.0.0/b.exe', size: 1 },
        { name: 'ElainaChat-3.0.0-portable.zip', browser_download_url: 'https://github.com/x/y/releases/download/3.0.0/d.zip', size: 1 },
    ],
};

/**
 * 在 vm 里跑真正的前端文件，拿它自己暴露的纯函数。
 * 给一个"什么都不做"的 document 就够 —— 这里只测不碰 DOM 的那部分。
 */
function loadFrontend() {
    const code = read(path.join(WEB, 'js', 'update-check.js'));
    const sandbox = {
        console,
        document: {
            readyState: 'complete',
            getElementById: () => null,
            querySelector: () => null,
            addEventListener() {},
            createElement: () => ({
                classList: { add() {}, remove() {} },
                appendChild() {},
                setAttribute() {},
                style: {},
            }),
        },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(code, sandbox, { filename: 'web/js/update-check.js' });
    const api = sandbox.window.ElainaUpdate;
    if (!api || !api.__test__) throw new Error('update-check.js 没有暴露 __test__');
    return api.__test__;
}

/** 用例 1：版本比较。判错会让"已是最新"被打成"有新版本"，或反过来让用户永远看不到更新。 */
async function caseVersion(c) {
    const t = loadFrontend();
    const cmp = t.compareVersions;
    c.ok(cmp('2.0.1', 'v2.0.1') === 0, 'v 前缀与相同版本判为相等');
    c.ok(cmp('v2.1.0', '2.0.1') === 1, '较新的版本判为更大');
    c.ok(cmp('2.0.1', '2.1.0') === -1, '较旧的版本判为更小');
    c.ok(cmp('2.0', '2.0.0') === 0, '缺段按 0 补齐');
    c.ok(cmp('2.0.10', '2.0.9') === 1, '按数字比较而不是字符串比较');
    c.ok(cmp('2.0.1', '2.0.1-rc.1') === 1, '正式版大于同号预发布版');
    c.ok(cmp('2.1.0-rc.2', '2.1.0-rc.10') === -1, '预发布之间也能分出先后');
    // Tag 改名：从 release-2.1.0 / ElainaChat-v2.1.0 里也要能抽出数字版本
    c.ok(cmp('release-2.1.0', '2.0.1') === 1, 'Tag 带 release- 前缀仍能比较');
    c.ok(cmp('ElainaChat-v2.1.0', 'v2.0.1') === 1, 'Tag 带产品名前缀仍能比较');
    c.ok(cmp('nightly', '1.0.0') === null, '解析不了的版本返回 null，不瞎判');
    c.ok(cmp('', '') === null, '空串解析失败');
}

/** 用例 2：资产归类。错一个就是"桌面版用户下到 APK"，改名也不能错。 */
async function caseAssets(c) {
    const t = loadFrontend();
    const a = t.classifyAssets(SAMPLE_RELEASE);
    c.ok(a.apk.length === 1 && /Elinachat-mod-2\.0\.0\.apk$/.test(a.apk[0].name), 'APK 只留正式包，滤掉 debug / x86');
    c.ok(a.desktop.length === 2, '桌面版收安装包 exe 与便携 zip');
    c.ok(/Setup\.exe$/.test(a.desktop[0].name), '桌面版里 exe 排在便携 zip 前面');
    c.ok(/source\.zip$/.test(a.source), '发布者上传的 source.zip 优先作为源码包');

    // 改名样本：文件里没有 Setup 字样，靠扩展名仍要归类正确
    const r = t.classifyAssets(t.normalizeGithubRelease(RENAMED_RELEASE));
    c.ok(r.apk.length === 1 && /3\.0\.0\.apk$/.test(r.apk[0].name), '改名后 APK 仍按 .apk 认出');
    c.ok(r.desktop.length === 2, '改名后 exe / zip 仍归桌面版');
    c.ok(r.source === RENAMED_RELEASE.zipball_url, '没有源码包时回落到 GitHub 的 zipball_url');

    const empty = t.classifyAssets({ assets: [] });
    c.ok(empty.apk.length === 0 && empty.desktop.length === 0 && !empty.source, '没有资产时不塞别的平台');

    c.ok(t.safeHttpsUrl('javascript:alert(1)') === '', 'javascript: 地址被拒绝');
    c.ok(t.safeHttpsUrl('http://github.com/x') === '', '明文 http 地址被拒绝');
    c.ok(t.safeHttpsUrl('https://github.com/x') !== '', 'https 地址放行');

    // 只有 debug 包时仍要给出（否则用户一个都下不了）
    const onlyDebug = t.classifyAssets({ assets: [{ name: 'app-debug.apk', browser_download_url: 'https://github.com/x/a.apk' }] });
    c.ok(onlyDebug.apk.length === 1, '只有 debug APK 时仍保留');
}

/** 用例 3：更新判定、分组顺序与「当前平台」标记。 */
async function caseSummary(c) {
    const t = loadFrontend();
    const rel = t.normalizeGithubRelease(SAMPLE_RELEASE);

    const desktop = t.releaseSummary(rel, '2.0.1', 'windows');
    c.ok(desktop.hasUpdate === true && desktop.comparable === true, '2.1.0 对 2.0.1 判为有更新');
    c.ok(desktop.downloads[0].key === 'desktop', '桌面版用户先看到桌面版分组');
    const winCurrent = desktop.downloads.filter((d) => d.current);
    c.ok(winCurrent.length === 1 && /Setup\.exe$/.test(winCurrent[0].name), 'WebView2 形态标出 Setup.exe 为当前平台');
    c.ok(desktop.downloads.some((d) => d.multi), '同组多个包标记 multi，界面显示文件名');

    const phone = t.releaseSummary(rel, '2.0.1', 'apk');
    c.ok(phone.downloads[0].key === 'apk' && phone.downloads[0].current === true, '手机端先看到 APK 并标为当前平台');

    const source = t.releaseSummary(rel, '2.0.1', 'web');
    c.ok(source.downloads[0].key === 'source' && source.downloads[0].current === true, '电脑版（源码）先看到源码包');

    const same = t.releaseSummary(rel, '2.1.0', 'apk');
    c.ok(same.hasUpdate === false, '同版本不谎报更新');

    const weird = t.releaseSummary({ tag: 'nightly', assets: [] }, '2.0.1', 'web');
    c.ok(weird.hasUpdate === false && weird.comparable === false, '版本解析不了时不谎报有更新');

    const renamed = t.releaseSummary(t.normalizeGithubRelease(RENAMED_RELEASE), '2.0.1', 'windows');
    c.ok(renamed.hasUpdate === true && renamed.comparable === true, '改名后的 Tag 也能判出更新');
}

/** 用例 4：服务端检测器（注入假 fetch）。 */
async function caseChecker(c) {
    // —— 成功 + 请求形状 + 缓存 ——
    let calls = 0, lastUrl = '', lastInit = null, clock = 1000;
    const okChecker = createUpdateChecker({
        repo: 'x/y',
        now: () => clock,
        ttlMs: 1000,
        fetchImpl: async (url, init) => { calls++; lastUrl = url; lastInit = init; return fakeResponse(200, SAMPLE_RELEASE); },
    });
    const first = await okChecker.check();
    c.ok(first.ok === true && first.release.tag === 'v2.1.0', '成功时返回收敛后的 release');
    c.ok(lastUrl === 'https://api.github.com/repos/x/y/releases/latest', '请求地址按 owner/repo 拼对');
    c.ok(String(lastInit.headers['User-Agent'] || '').length > 0, '带 User-Agent（GitHub 缺它会 403）');
    c.ok(String(lastInit.headers['Accept']).includes('github'), 'Accept 走 GitHub 媒体类型');
    await okChecker.check();
    c.ok(calls === 1, '缓存期内不重复请求');
    clock += 5000;
    await okChecker.check();
    c.ok(calls === 2, '缓存过期后重新请求');

    // —— 404：仓库没有 Release ——
    const noRelease = createUpdateChecker({ repo: 'x/y', fetchImpl: async () => fakeResponse(404, {}) });
    const r404 = await noRelease.check();
    c.ok(r404.ok === false && r404.code === 'NO_RELEASE', '404 报「还没有 Release」');

    // —— 403 + 限流头：把 reset 时间翻成分钟 ——
    const limited = createUpdateChecker({
        repo: 'x/y',
        now: () => clock,
        fetchImpl: async () => fakeResponse(403, {}, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(clock / 1000) + 120),
        }),
    });
    const rLimit = await limited.check();
    c.ok(rLimit.ok === false && rLimit.code === 'RATE_LIMIT', '403 限流被认出来');
    c.ok(/分钟/.test(rLimit.message), '限流提示给出大约多久后重试');

    // —— 网络失败分类（关掉绕过，单测分类本身） ——
    const timeout = createUpdateChecker({
        repo: 'x/y', bypass: false, readHosts: () => null,
        fetchImpl: async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; },
    });
    c.ok((await timeout.check()).code === 'TIMEOUT', '超时归为 TIMEOUT');

    const dns = createUpdateChecker({
        repo: 'x/y', bypass: false, readHosts: () => null,
        fetchImpl: async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; },
    });
    const rDns = await dns.check();
    c.ok(rDns.code === 'DNS' && /hosts/.test(rDns.message), 'DNS 失败归为 DNS，并提示查 hosts');

    // —— hosts 劫持诊断（喂文本，不碰真实系统文件） ——
    const hijacked = createUpdateChecker({
        repo: 'x/y', bypass: false,
        readHosts: () => ({ path: 'C:/fake/hosts', text: '# x\n127.0.0.1 api.github.com\n' }),
        fetchImpl: async () => { const e = new Error('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; },
    });
    const rHijack = await hijacked.check();
    c.ok(/C:\/fake\/hosts/.test(rHijack.message) && /第 2 行/.test(rHijack.message), 'hosts 劫持时给出文件与行号');
    c.ok(isPublicIPv4('8.8.8.8') === true && isPublicIPv4('127.0.0.1') === false
        && isPublicIPv4('10.0.0.1') === false && isPublicIPv4('172.16.0.1') === false
        && isPublicIPv4('192.168.1.1') === false && isPublicIPv4('0.0.0.0') === false,
        '只接受公网 IPv4（挡掉污染成本机 / 内网地址）');
    const parsed = findHostsHijack('# comment\n::1 api.github.com\n127.0.0.1 github.com   api.github.com\n', 'api.github.com');
    c.ok(parsed && parsed.line === 2 && parsed.ip === '::1', 'hosts 解析认 ::1 且忽略注释行');
    c.ok(findHostsHijack('8.8.8.8 api.github.com\n', 'api.github.com') === null, '把 GitHub 指到公网地址不算劫持');
    c.ok(PUBLIC_DNS_SERVERS.length >= 2, '公共 DNS 有多台候选（一台被挡还有下一台）');

    // —— 直连失败后换公共 DNS 直连：成功后如实标记 viaBypass ——
    let bypassRequests = 0;
    const viaDns = createUpdateChecker({
        repo: 'x/y',
        resolveIp: async () => '140.82.1.1',
        requestByIp: async () => { bypassRequests++; return { status: 200, headers: {}, body: JSON.stringify(SAMPLE_RELEASE) }; },
        fetchImpl: async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; },
    });
    const rVia = await viaDns.check();
    c.ok(rVia.ok === true && rVia.viaBypass === true, '直连失败后公共 DNS 直连成功并标记 viaBypass');
    c.ok(bypassRequests === 1, '只重试一次直连');
    const viaCached = await viaDns.check();
    c.ok(viaCached.cached === true, '绕过成功的结果同样进缓存');

    // 绕过拿到 HTTP 层结论（404）也采信，而不是丢掉
    const via404 = createUpdateChecker({
        repo: 'x/y',
        resolveIp: async () => '140.82.1.1',
        requestByIp: async () => ({ status: 404, headers: {}, body: '{}' }),
        fetchImpl: async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; },
    });
    c.ok((await via404.check()).code === 'NO_RELEASE', '绕过拿到 404 时按「还没有 Release」报');

    // 解析不到公网 IP：回到原始错误并带上 hosts 证据
    const noIp = createUpdateChecker({
        repo: 'x/y',
        resolveIp: async () => '',
        readHosts: () => ({ path: 'C:/fake/hosts', text: '127.0.0.1 api.github.com\n' }),
        fetchImpl: async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; },
    });
    const rNoIp = await noIp.check();
    c.ok(rNoIp.ok === false && /第 1 行/.test(rNoIp.message), '绕过拿不到 IP 时回到原始错误 + hosts 行号');

    // —— 坏 JSON ——
    const badJson = createUpdateChecker({ repo: 'x/y', fetchImpl: async () => fakeResponse(200, undefined) });
    c.ok((await badJson.check()).code === 'BAD_RESPONSE', '返回不是 JSON 时报 BAD_RESPONSE');

    // —— 非法仓库名：不能拼进 URL ——
    let calledWithBadRepo = false;
    const badRepo = createUpdateChecker({
        repo: 'x/../../evil',
        fetchImpl: async () => { calledWithBadRepo = true; return fakeResponse(200, SAMPLE_RELEASE); },
    });
    const rBad = await badRepo.check();
    c.ok(rBad.code === 'CONFIG' && !calledWithBadRepo, '非法仓库名直接拒绝，不发请求');

    // —— 纯函数：收敛与判定 ——
    c.ok(isValidRepo('owner/repo') === true, '合法仓库名放行');
    c.ok(isValidRepo('../x') === false && isValidRepo('a/b/c') === false && isValidRepo('') === false,
        '非法仓库名（含纯点段 / 多段 / 空）被拒绝');
    const cleaned = sanitizeRelease({
        tag_name: 'v1.0.0', html_url: 'https://github.com/x/y', body: 'b', published_at: '2026-01-01',
        assets: [
            { name: 'a.apk', browser_download_url: 'https://github.com/a.apk', size: 5 },
            { name: 'bad.apk', browser_download_url: 'javascript:alert(1)', size: 5 },
        ],
    });
    c.ok(cleaned.assets.length === 1, '非 https 的资产地址被收敛掉');
    c.ok(sanitizeRelease({}) === null, '没有 tag 的响应视为无效');
    c.ok(describeFetchError({ name: 'TimeoutError' }).code === 'TIMEOUT', 'describeFetchError 认识超时');
}

/** 用例 5：接线（路由 / 运行形态 / 版本号同步 / 平台命名）。 */
async function caseWiring(c) {
    const indexHtml = read(path.join(WEB, 'index.html'));
    const serveJs = read(path.join(WEB, 'serve.mjs'));
    const frontJs = read(path.join(WEB, 'js', 'update-check.js'));
    const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));

    c.ok(serveJs.includes("'/api/app/update'"), '服务端有 /api/app/update 路由');
    c.ok(serveJs.includes('ELAINA_EDITION') && serveJs.includes('APP_EDITION'), '运行形态来自 ELAINA_EDITION，只认白名单');
    c.ok(serveJs.includes('version: APP_VERSION') && serveJs.includes('edition: APP_EDITION'),
        '/api/server-info 返回当前版本与运行形态');
    c.ok(frontJs.includes(DEFAULT_REPO), '前端仓库名与服务端默认仓库一致');
    c.ok(!/Capacitor|isNativePlatform/.test(frontJs), '前端不自己摸 Capacitor（平台判定留在 core.js，AGENTS.md D5）');
    c.ok(frontJs.includes('ElainaRuntime') && frontJs.includes('detectLocalRelay'), '走 core.js / core-relay 暴露的适配层');
    c.ok(frontJs.includes('viaBypass'), '前端展示「已绕过 hosts / DNS」的说明');
    const serverJs = read(path.join(ROOT, 'server', 'update-check.mjs'));
    c.ok(serverJs.includes('PUBLIC_DNS_SERVERS') && serverJs.includes('requestReleaseByIp'), '服务端具备公共 DNS 直连兜底');
    c.ok(serverJs.includes('findHostsHijack'), '服务端能指出 hosts 劫持的文件与行号');

    // 平台命名：电脑版 = 源码，桌面版 = exe
    c.ok(frontJs.includes('电脑版（源码运行'), '界面把源码 / 浏览器形态叫「电脑版」');
    c.ok(frontJs.includes('桌面版安装包'), '界面把 exe 包叫「桌面版」');
    c.ok(frontJs.includes('手机版 APK'), '手机版命名保留');

    c.ok(indexHtml.includes('id="updateSettingsSection"'), '高级分栏里有「版本与更新」卡片');
    c.ok(indexHtml.includes('id="appUpdateCheckBtn"'), '检查更新按钮存在');
    c.ok(indexHtml.includes('/js/update-check.js'), '前端模块已加载');
    c.ok(indexHtml.indexOf('/js/core.js') < indexHtml.indexOf('/js/update-check.js'),
        'update-check.js 排在 core.js 之后（它运行时要读 ElainaRuntime 与中转判定）');

    const footer = /id="appVersionFooter"[^>]*data-version="([^"]+)"/.exec(indexHtml);
    c.ok(Boolean(footer), '侧栏页脚带 data-version（APK 上没有 package.json，靠它读版本）');
    c.ok(footer && footer[1] === pkg.version, '页脚 data-version 与 package.json 的 version 一致');
    c.ok(footer && indexHtml.includes('v' + pkg.version + ' · 魔女之旅'), '页脚显示文本与 data-version 一致');

    // 桌面壳的形态标记：dist/ 是本地打包目录，不在本机的机器上按环境性跳过。
    const shells = [
        [path.join(ROOT, 'dist', 'Windows', 'shell', 'ShellHost.cs'), '电脑版（WebView2）'],
    ];
    for (const [file, label] of shells) {
        if (existsSync(file)) c.ok(read(file).includes('ELAINA_EDITION'), label + ' 壳标记运行形态');
        else c.ok(true, '跳过：' + label + ' 壳源码不在本机（dist/ 为本地目录）');
    }
}

runChecks({
    title: '版本与更新（GitHub Releases 检测）',
    usage: 'node scripts/check-update.mjs [用例名子串]',
    cases: [
        { name: '版本比较', fn: caseVersion },
        { name: '资产归类', fn: caseAssets },
        { name: '更新判定', fn: caseSummary },
        { name: '服务端检测器', fn: caseChecker },
        { name: '接线', fn: caseWiring },
    ],
});
