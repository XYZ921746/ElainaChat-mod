// 「网页版装成桌面应用」（PWA）的回归检查。
// 这一层坏掉时的表现非常安静：**安装按钮就是不出现**，页面本身一切正常，
// 控制台最多一句含糊的 "Manifest: Syntax error"。所以必须在这里钉死三件事：
//   ① 三段拼装齐全：manifest 通过 HTTP 发得出去、类型正确；图标是真的 PNG
//      且尺寸够；SW 真的注册成功并接管 —— 缺任一条，浏览器就判定「不可安装」；
//   ② SW **不缓存任何东西**：本项目所有资源都是 `Cache-Control: no-store`，
//      缓存住就等于「改了代码它不变」，而这套项目没有构建期 hash；
//   ③ 安装入口只有浏览器一个裁判：按钮默认 `hidden`，只在
//      `beforeinstallprompt` 之后显形，绝不在业务代码里自己编"该不该显示"。
// 判据里有两处是**实测过的坑**，不要凭直觉改回去：
//   · 图标必须是 PNG。用 JPEG 时 Chrome 直接报
//     `manifest-missing-suitable-icon`（即便 sizes 写着 192x192），按钮永远不出现；
//   · pwa.js 里不许出现 Capacitor / isNativePlatform（AGENTS.md D5）——
//     平台判断留在 core.js 的适配段，业务模块只读去平台化的语义。
// 用法：node scripts/check-pwa.mjs           跑全部
//       node scripts/check-pwa.mjs 图标      只跑名字含该子串的用例

import { readFileSync, existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runChecks, ROOT, wait, freePort } from './check-harness.mjs';

const WEB = path.join(ROOT, 'web');
const HTML_FILE = path.join(WEB, 'index.html');
const MANIFEST_FILE = path.join(WEB, 'manifest.webmanifest');
const SW_FILE = path.join(WEB, 'sw.js');
const PWA_JS = path.join(WEB, 'js', 'pwa.js');
const ICON_DIR = path.join(WEB, 'icons');

/** 去掉注释，断言"不许出现 X"时不该被解释 X 的注释误伤 */
const stripComments = (src) => String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/**
 * 读 PNG 头拿真实宽高与色彩类型。
 *
 * 为什么要读到字节级：manifest 里 `sizes` 是**自己写的**，写错浏览器不认，
 * 而症状就是"按钮不出现"。只有从文件头读出来的才是事实。
 */
function readPngHeader(buf) {
    if (!buf || buf.length < 33) return null;
    // 8 字节签名：89 50 4E 47 0D 0A 1A 0A
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return null;
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
        bitDepth: buf[24],
        colorType: buf[25],   // 3 = 调色板
    };
}

/** 解析 data URL 或普通 URL 里 manifest 的 icons 条目的尺寸声明 */
function parseSizes(text) {
    if (!/^\d+x\d+$/.test(String(text || '').trim())) return null;
    const [w, h] = text.split('x').map(Number);
    return { w, h };
}

runChecks({
    title: '桌面应用化（PWA：manifest / 图标 / Service Worker / 安装入口）',
    usage: 'node scripts/check-pwa.mjs [用例名子串]',
    cases: [
        {
            name: 'manifest 形状与落地',
            fn: async (c) => {
                c.ok(existsSync(MANIFEST_FILE), 'web/manifest.webmanifest 存在');
                if (!existsSync(MANIFEST_FILE)) return;

                let m = null;
                try { m = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')); } catch { /* 下面判 */ }
                c.ok(!!m, 'manifest 是合法 JSON');
                if (!m) return;

                // 可安装性的必备字段（缺 name/short_name/start_url/display 任一都不行）
                c.ok(typeof m.name === 'string' && m.name.trim().length > 0, 'manifest 有 name');
                c.ok(typeof m.short_name === 'string' && m.short_name.trim().length > 0, 'manifest 有 short_name');

                // start_url 必须是**站点根**：安装后的应用窗口打开的就是它。
                //   写成相对文件名（如 index.html）时，装出来的快捷方式会带上它，
                //   而我们没有任何路由靠它分发 —— 将来加路由就会静默错位。
                c.ok(m.start_url === '/', "start_url 是站点根 '/'（实得 " + JSON.stringify(m.start_url) + '）');

                // scope 必须覆盖根：SW 的默认 scope 与页面同源根，scope 收窄会让
                //   "装好的窗口里有点不开的页面"
                c.ok(m.scope === '/', "scope 是站点根 '/'（实得 " + JSON.stringify(m.scope) + '）');

                // standalone = 独立窗口、无地址栏。这正是"跟 app 差不多"的来源；
                //   browser / minimal-ui 都会留着浏览器外壳，与目标不符。
                c.ok(m.display === 'standalone',
                    "display 是 'standalone'（独立窗口无地址栏，实得 " + JSON.stringify(m.display) + '）');

                // theme_color / background_color 决定启动画面与标题栏底色，
                //   缺了会闪一下白 —— 观感问题，但正是"像不像 app"的关键
                c.ok(/^#[0-9a-fA-F]{6}$/.test(String(m.theme_color || '')), 'theme_color 是 #rrggbb');
                c.ok(/^#[0-9a-fA-F]{6}$/.test(String(m.background_color || '')), 'background_color 是 #rrggbb');

                c.ok(Array.isArray(m.icons) && m.icons.length > 0, 'manifest 声明了 icons');
            },
        },

        {
            name: '图标真实可用（PNG + 尺寸达标）',
            fn: async (c) => {
                if (!existsSync(MANIFEST_FILE)) { c.ok(false, '缺 manifest，无法验证图标'); return; }
                const m = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
                const icons = Array.isArray(m.icons) ? m.icons : [];

                // ★ 实测坑：JPEG 图标会让 Chrome 报 manifest-missing-suitable-icon，
                //   安装按钮永远不出现（sizes 写对也没用）。所以这里卡死 PNG。
                let sawPng = false;
                let maxSide = 0;
                let sawMaskable = false;

                for (const icon of icons) {
                    const src = String(icon.src || '');
                    const file = path.join(WEB, src.replace(/^\//, ''));

                    c.ok(existsSync(file), '图标文件存在：' + src);
                    if (!existsSync(file)) continue;

                    const buf = readFileSync(file);
                    const head = readPngHeader(buf);
                    c.ok(!!head, '图标是真正的 PNG（文件头校验）：' + src);
                    if (!head) continue;
                    sawPng = true;

                    const declared = parseSizes(icon.sizes);
                    c.ok(!!declared, '图标 sizes 写法合法（WxH）：' + src + ' = ' + JSON.stringify(icon.sizes));
                    if (declared) {
                        // 声明尺寸必须与文件真实像素一致：不一致时浏览器按声明排队，
                        // 实际图不符会让安装用的图标是空白/被拉伸
                        c.ok(head.width === declared.w && head.height === declared.h,
                            '声明的尺寸与真实像素一致：' + src + '（声明 ' + icon.sizes
                            + '，实际 ' + head.width + 'x' + head.height + '）');
                    }

                    const type = String(icon.type || '');
                    c.ok(/^image\/png$/.test(type), 'type 标成 image/png：' + src + '（实得 ' + JSON.stringify(type) + '）');

                    if (Math.min(head.width, head.height) > maxSide) maxSide = Math.min(head.width, head.height);
                    if (String(icon.purpose || '').includes('maskable')) {
                        sawMaskable = true;
                        // maskable 的安全区是中间 80%，图必须留边，
                        // 否则在圆形/方形裁切下人物脸会被切掉
                        c.ok(true, '有 maskable 图标：' + src);
                    }
                }

                c.ok(sawPng, '至少有一个 PNG 图标（JPEG 会让安装入口不出现）');

                // Chrome 的判据：至少一个图标 ≥144px。取 512 更稳（高 DPI 任务栏用）
                c.ok(maxSide >= 144, '图标尺寸达到浏览器的 144px 下限（最大 ' + maxSide + 'px）');
                c.ok(maxSide >= 512, '有 512px 图标（高 DPI 任务栏/开始菜单用，最大 ' + maxSide + 'px）');

                c.ok(sawMaskable, '★ 有 purpose=maskable 的图标（安卓/Windows 磁贴圆形裁切不留白边）');
            },
        },

        {
            name: 'Service Worker 只做可安装性、不缓存',
            fn: async (c) => {
                c.ok(existsSync(SW_FILE), 'web/sw.js 存在');
                if (!existsSync(SW_FILE)) return;
                const raw = readFileSync(SW_FILE, 'utf8');
                const code = stripComments(raw);

                // 必须有 fetch 监听器：可安装性判据要求站点有 SW 处理 fetch。
                //   没有它，Chrome 不给 beforeinstallprompt，安装按钮永不出现。
                c.ok(/addEventListener\(\s*['"]fetch['"]/.test(code), '★ SW 注册了 fetch 监听器（可安装性的硬要求）');

                // ★ 本项目**明确不缓存**：所有资源都是 no-store，缓存住就是
                //   "改了代码它不变"；插件资源与 /api 更是不能缓存。
                //   出现 Cache API 调用即判红 —— 这条是有意为之，不是漏写。
                c.ok(!/caches\s*\.\s*(open|match|add|addAll|put)\b/.test(code),
                    '★ SW 不调用 Cache API（本项目所有资源都是 no-store，缓存住会让改动不生效）');

                c.ok(!/cachedResponse|respondWith\s*\(/.test(code),
                    'SW 的 fetch 监听器不接管响应（请求直连网络，行为与没有 SW 时一致）');

                // skipWaiting + claim：新版本立刻接管，不让用户为了升级去关窗口
                c.ok(/skipWaiting\s*\(/.test(code), 'install 里调 skipWaiting()（新 SW 立刻接管）');
                c.ok(/clients\s*\.\s*claim\s*\(/.test(code), 'activate 里调 clients.claim()（不等旧页面刷新）');
            },
        },

        {
            name: '安装入口：只有浏览器一个裁判',
            fn: async (c) => {
                const html = readFileSync(HTML_FILE, 'utf8');

                // 页面必须挂上 manifest 与图标，否则浏览器根本不知道这是个应用
                c.ok(/<link[^>]+rel=["']manifest["'][^>]*>/.test(html), 'index.html 引用了 manifest');
                c.ok(/href=["']\/manifest\.webmanifest["']/.test(html), 'manifest 指向 /manifest.webmanifest');
                c.ok(/<meta[^>]+name=["']theme-color["']/.test(html), 'index.html 声明了 theme-color');
                c.ok(/rel=["']icon["']/.test(html), 'index.html 声明了 favicon');

                // 按钮必须存在且**默认 hidden**：显不显示只能由 beforeinstallprompt 决定
                const btn = /<button[^>]*id=["']headerInstallBtn["'][^>]*>/.exec(html);
                c.ok(!!btn, 'index.html 有安装按钮 #headerInstallBtn');
                if (btn) {
                    c.ok(/\bclass=["'][^"']*\bhidden\b/.test(btn[0]),
                        '★ 按钮默认 hidden（只在浏览器给出 beforeinstallprompt 后才显形）');
                }

                c.ok(/<script src="\/js\/pwa\.js"><\/script>/.test(html), 'index.html 加载了 pwa.js');

                c.ok(existsSync(PWA_JS), 'web/js/pwa.js 存在');
                if (!existsSync(PWA_JS)) return;
                const pwaRaw = readFileSync(PWA_JS, 'utf8');
                const pwa = stripComments(pwaRaw);

                // 显隐判据必须来自浏览器事件
                c.ok(/beforeinstallprompt/.test(pwa), 'pwa.js 监听 beforeinstallprompt');
                c.ok(/appinstalled/.test(pwa), 'pwa.js 监听 appinstalled（装好就藏按钮）');
                c.ok(/display-mode:\s*standalone/.test(pwa), 'pwa.js 认 display-mode: standalone（已装就不再给入口）');
                c.ok(/preventDefault\s*\(\s*\)/.test(pwa), '接到事件后 preventDefault（不让浏览器另弹一个入口）');
                c.ok(/\.prompt\s*\(\s*\)/.test(pwa), '点按钮时才调 prompt()');

                // 安全上下文才注册 SW：局域网 IP 走 http 时 navigator.serviceWorker
                //   要么不存在、要么注册即抛，静默跳过比报错更符合预期
                c.ok(/isSecureContext/.test(pwa), '注册 SW 前检查 isSecureContext');

                // ★ AGENTS.md D5：平台分支只允许在存储/适配层。
                //   pwa.js 是业务模块，摸 Capacitor 就违规 —— 它只能读
                //   core.js 暴露的去平台化语义（ElainaRuntime.canInstallAsApp）。
                c.ok(!/isNativePlatform|Capacitor\.isNative|Capacitor\.Plugins/.test(pwa),
                    '★ pwa.js 不直接判断平台（D5：只读 ElainaRuntime.canInstallAsApp）');
                c.ok(/ElainaRuntime/.test(pwa), 'pwa.js 经 window.ElainaRuntime 判断是否适用');

                // 宿主侧：语义住在 core.js 的原生适配段
                const core = stripComments(readFileSync(path.join(WEB, 'js', 'core.js'), 'utf8'));
                c.ok(/window\.ElainaRuntime\s*=/.test(core), 'core.js 暴露 window.ElainaRuntime');
                c.ok(/canInstallAsApp/.test(core), 'ElainaRuntime 提供 canInstallAsApp');
                // ★ 按钮只在"浏览器自己不给安装入口"时出现：地址栏已有安装图标的
                //   Chrome/Edge 不给 —— 否则同一件事两个入口，主界面成了"装我"的广告位。
                c.ok(/onbeforeinstallprompt/.test(core) && /browserShowsOwnInstallEntry/.test(core)
                    && /return !IS_NATIVE_APP && !browserShowsOwnInstallEntry\(\);/.test(core),
                    '★ Chrome/Edge（自带安装入口）不显示顶栏安装按钮');
            },
        },

        {
            name: '服务端按正确 MIME 发这三样',
            fn: async (c) => {
                const tmp = mkdtempSync(path.join(tmpdir(), 'elaina-pwa-'));
                const port = await freePort();
                const child = spawn(process.execPath, [path.join(WEB, 'serve.mjs')], {
                    cwd: ROOT,
                    env: {
                        ...process.env,
                        PORT: String(port), HOST: '127.0.0.1', OPEN_BROWSER: '0',
                        DATA_DIR: path.join(tmp, 'data'), LOG_DIR: path.join(tmp, 'logs'),
                        MODS_DIR: path.join(tmp, 'mods'), SKILLS_DIR: path.join(tmp, 'skills'),
                        LOG_TO_FILE: '0',
                    },
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                let out = '';
                child.stdout.on('data', (d) => { out += d; });
                child.stderr.on('data', (d) => { out += d; });

                try {
                    let ready = false;
                    for (let i = 0; i < 80 && !ready; i++) {
                        try { ready = (await fetch(`http://127.0.0.1:${port}/api/server-info`)).ok; }
                        catch { await wait(200); }
                    }
                    c.ok(ready, '服务已就绪', ready ? '' : out.slice(-400));
                    if (!ready) return;

                    const base = `http://127.0.0.1:${port}`;

                    // ① manifest 的类型必须是 application/manifest+json。
                    //    发成 octet-stream 时浏览器只报一句含糊的语法错误，安装入口不出现。
                    const mf = await fetch(base + '/manifest.webmanifest');
                    c.ok(mf.status === 200, 'GET /manifest.webmanifest 为 200', '实得 ' + mf.status);
                    const mfType = String(mf.headers.get('content-type') || '');
                    c.ok(/^application\/manifest\+json/.test(mfType),
                        '★ manifest 的 Content-Type 是 application/manifest+json（实得 ' + mfType + '）');
                    const mfJson = await mf.json().catch(() => null);
                    c.ok(!!mfJson, 'manifest 能被解析成 JSON');

                    // ② sw.js 必须是可执行的 JS 类型 + 声明 scope。
                    //    类型不对（或被 nosniff 拦下）时 SW 注册直接失败。
                    const sw = await fetch(base + '/sw.js');
                    c.ok(sw.status === 200, 'GET /sw.js 为 200', '实得 ' + sw.status);
                    const swType = String(sw.headers.get('content-type') || '');
                    c.ok(/^(text|application)\/javascript/.test(swType),
                        '★ sw.js 的 Content-Type 是可执行的 JS（实得 ' + swType + '）');
                    c.ok(sw.headers.get('service-worker-allowed') === '/',
                        '/sw.js 带 Service-Worker-Allowed: /（实得 ' + sw.headers.get('service-worker-allowed') + '）');

                    // ③ 图标要真能取到，且类型是图片
                    for (const icon of (mfJson && mfJson.icons) || []) {
                        const r = await fetch(base + icon.src);
                        c.ok(r.status === 200, '图标可访问：' + icon.src, '实得 ' + r.status);
                        const ct = String(r.headers.get('content-type') || '');
                        c.ok(/^image\//.test(ct), '图标是图片类型：' + icon.src + '（实得 ' + ct + '）');
                    }

                    // ④ 页面本身不受影响（这条是三样齐全的反面：别把静态服务改坏）
                    const home = await fetch(base + '/');
                    c.ok(home.status === 200, '首页仍为 200');
                    c.ok(home.headers.get('x-frame-options') === 'DENY', '首页仍带 X-Frame-Options: DENY（防嵌套没被削弱）');
                } finally {
                    try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
                    await wait(300);
                    rmSync(tmp, { recursive: true, force: true });
                }
            },
        },
    ],
});
