// 回归检查：mod 的**宿主能力**——插槽注册、注册项回收（停用/卸载）、服务端半边。
//
// ── 为什么这些必须常驻检查 ────────────────────────────────────────────────
//
// 这一层是 Live2D 等扩展从宿主搬进 mod 的前提，它有两个"错了也不报错"的特征：
//
//   ① **注册了但没挂上**：插槽名写错、挂载点在 DOM 里不存在、点击没人管 ——
//      表现都是"界面没变化"，而控制台可能一声不响。
//   ② **停用了但没收回**：插槽入口还在、样式还在生效、system 提示词还在往
//      模型里灌、事件订阅还在响应。用户以为关掉了，实际没有。
//      这两种都是本项目反复踩过的类型（"装了等于没装"），所以要用真浏览器、
//      真服务端把它钉住，而不是只做源码字符串匹配。
//
// 三段：
//   1. 源码约定（快速失败，先跑）
//   2. 服务端半边：声明白名单 / 撞名拒绝 / 上传目录按二进制返回 / 需重启上报
//   3. 浏览器：插槽真的挂上了、停用真的收回、重新启用不重跑工厂
//
// 用法：node scripts/check-mod-host-api.mjs
import { launchTestBrowser } from './test-browser.mjs';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, openSync, cpSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(ROOT, 'web', 'mods');
const INDEX = path.join(MODS, 'index.json');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
    const s = createNetServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/**
 * 去掉注释后的源码。
 *
 * 为什么需要：有些断言是"**不许**再出现某个调用"，而解释"为什么不再用它"的
 * 注释里必然会提到那个调用（本项目的注释风格就是写清踩过的坑）。直接对全文
 * 匹配会把这些注释算成违规 —— 假失败。第一版就踩了这个。
 */
const stripComments = (src) => String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/** 本次检查用到的临时 mod 前缀 —— 清理与清单过滤都以它为准 */
const TMP_PREFIX = 'zz-check-';
const tmpMods = ['zz-check-api', 'zz-check-badapi', 'zz-check-collide', 'zz-check-late', 'zz-check-slots', 'zz-check-tpl'];

// ============================================================ 1. 源码约定
console.log('=== 1. 插槽与"注册即副作用"：源码约定 ===');
{
    const modsSrc = readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');
    const initSrc = readFileSync(path.join(ROOT, 'web', 'js', 'app-07-init.js'), 'utf8');
    const uiSrc = readFileSync(path.join(ROOT, 'web', 'js', 'app-04-ui.js'), 'utf8');
    const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    const voiceSrc = readFileSync(path.join(ROOT, 'web', 'js', 'app-05-voice.js'), 'utf8');
    const l2dSrc = readFileSync(path.join(ROOT, 'web', 'mods', 'live2d', 'index.js'), 'utf8');
    const fsSrc = readFileSync(path.join(ROOT, 'scripts', 'frontend-sources.mjs'), 'utf8');
    const slotsSrc = readFileSync(path.join(ROOT, 'web', 'js', 'host-slots.js'), 'utf8');

    // ---- 插槽注册表 ----
    ok(/function defineSlot/.test(modsSrc), 'mods.js 有 defineSlot（宿主挖插槽）');
    ok(/function registerSlot/.test(modsSrc), 'mods.js 有 registerSlot（mod 往插槽注册）');
    ok(/slot\(name, spec\)\s*\{/.test(modsSrc), '★ 宿主 API 暴露 host.slot(name, spec)');
    ok(/slots\(\)\s*\{\s*return \[\.\.\.slotImpls\.keys\(\)\]/.test(modsSrc), '★ 暴露 host.slots()（mod 可探测可用插槽）');
    ok(/defineSlot,/.test(modsSrc), 'ElainaMods 导出 defineSlot 给宿主代码用');
    ok(/宿主没有名为/.test(modsSrc), '★ 插槽名写错时明确报错并列出可用插槽（否则表现为"注册了没反应"）');
    ok(/上已有同名条目/.test(modsSrc), '★ 同一 mod 在同一插槽重复注册会被挡下（不产生第二份界面）');
    ok(/已经有「/.test(slotsSrc), '★ 插件分栏与宿主已有分栏撞名被拒绝（不静默顶掉原分栏）');

    // ---- 注册即副作用：三种生命周期 ----
    ok(/function addContribution/.test(modsSrc), '有 addContribution（每项注册都登记成可撤销贡献）');
    ok(/function deactivateContributions/.test(modsSrc), '有 deactivateContributions（停用：摘掉但保留 spec）');
    ok(/function activateContributions/.test(modsSrc), '有 activateContributions（启用：用保留的 spec 挂回去）');
    ok(/function disposeContributions/.test(modsSrc), '有 disposeContributions（卸载：真删）');
    ok(/deactivateContributions\(id\)/.test(modsSrc), '★ setEnabled 的停用分支真的收回注册项');
    ok(/activateContributions\(id\)/.test(modsSrc), '★ setEnabled 的启用分支把注册项挂回去');
    ok(/disposeContributions\(id\)/.test(modsSrc), '★ forget（删插件）时释放注册项');

    // ---- 三类"会残留"的注册都被纳入作用域 ----
    ok(/function injectStyleLink[\s\S]{0,1800}?addContribution/.test(modsSrc),
        '★ 样式注入纳入作用域（停用时真的失效）');
    ok(/injectStyle\(href\)\s*\{\s*return injectStyleLink/.test(modsSrc),
        '插件自己调的 injectStyle 与清单声明的 styles 共用同一段回收逻辑');
    ok(/for \(const css of[\s\S]{0,500}?injectStyleLink\(manifest, href\)/.test(modsSrc),
        '★ 清单声明的 styles 也纳入作用域（以前建完就不管：插件停用后 CSS 还在生效）');
    ok(/setPromptHint\(text\)[\s\S]{0,600}?ensurePromptHintContribution/.test(modsSrc),
        '★ setPromptHint 纳入作用域（停用后不再影响模型行为）');
    ok(/promptHintText/.test(modsSrc) && /promptHints/.test(modsSrc),
        '★ 提示词分"当前生效"与"插件原文"两份（启用时能原样恢复）');
    ok(/on\(event, handler\)[\s\S]{0,900}?addContribution/.test(modsSrc),
        '★ on() 的订阅纳入作用域（停用后不再响应事件）');

    // ---- 幂等：不许重跑工厂 ----
    ok(/if \(prev && prev\.state === 'ready'\) return prev;/.test(modsSrc),
        '★ loadAll 可重复调用：已就绪的插件不重跑工厂（否则界面/定时器翻倍）');

    // ---- 宿主侧的挂载点 ----
    ok(/id="settingsTabNav"/.test(html), 'index.html 给设置分栏导航加了挂载点 id');
    ok(/id="headerModSlot"/.test(html), 'index.html 给顶部按钮加了挂载点');
    ok(/id="sidebarModSlot"/.test(html), 'index.html 给侧栏底部加了挂载点');
    ok(/id="composerModSlot"/.test(html), 'index.html 给输入框那一行加了挂载点');
    ok(/class="message-slot-actions/.test(uiSrc), 'app-04-ui.js 在每条消息里建了插槽容器');
    ok(/decorateMessageSlots\(div\)/.test(uiSrc), '★ 渲染每条消息时会调用插槽装饰（每项级插槽的入口）');
    ok(/typeof window\.decorateMessageSlots === 'function'/.test(uiSrc),
        '★ 调用处有守卫：插槽模块出问题不该影响消息渲染这条核心链路');

    // ---- ★ 插槽集中在一个文件里（插件作者唯一需要看的契约面）----
    // 数插槽时要先剥注释：本文件头部就有一段"怎么再加一个插槽"的说明，
    // 里面写着 `defineSlot('xxx.yyy', …)` 当例子 —— 直接全文匹配会多数出一个（第一版就这么错的）
    const slotNames = [...stripComments(slotsSrc).matchAll(/defineSlot\(\s*'([^']+)'/g)].map((m) => m[1]);
    ok(slotNames.length === 6, '★ host-slots.js 集中声明了 6 个插槽', JSON.stringify(slotNames));
    for (const s of ['settings.tabs', 'settings.modal', 'header.actions', 'sidebar.footer', 'composer.actions', 'chat.message.actions']) {
        ok(slotNames.includes(s), '插槽存在：' + s);
    }
    // settings.modal：插件设置独立成窗（2026-10 加）——
    // 插件一多，主设置里会堆一排分栏，所以插件设置默认走独立弹窗
    ok(/id="modSettingsOverlay"/.test(html), 'index.html 有插件设置弹窗容器');
    ok(/__modSettingsOpeners/.test(slotsSrc), '★ settings.modal 暴露按 id 打开设置的入口（供插件卡片调用）');
    ok(!/defineSlot/.test(initSrc), '★ app-07-init.js 不再自己挖插槽（已全部移到 host-slots.js）');
    ok(/item:\s*true/.test(slotsSrc), '★ chat.message.actions 是每项级插槽（item: true）');
    ok(/cleanup\(modId\)/.test(slotsSrc), '★ 每项级插槽提供 cleanup：停用时把已画的元素摘掉');
    ok(/item === true[\s\S]{0,400}?必须提供 cleanup/.test(modsSrc),
        '★ defineSlot 强制要求每项级插槽提供 cleanup（否则停用后界面留残留）');
    ok(/function renderItemSlot/.test(modsSrc) && /renderItemSlot,/.test(modsSrc),
        '★ 暴露 renderItemSlot 给宿主渲染每一项时调用');
    ok(/data-mod/.test(modsSrc) && /child\.setAttribute\('data-mod'/.test(modsSrc),
        '★ 每项级渲染出的元素自动打归属标记（停用时可精确摘除）');

    // ---- 分栏点击必须走事件委托 ----
    ok(/settingsTabNav'\)[\s\S]{0,600}?addEventListener\('click'/.test(initSrc),
        '★ 分栏点击委托给容器');
    ok(/closest\('\.settings-tab-btn'\)/.test(initSrc), '★ 委托时用 closest 在容器里找按钮');
    ok(!/querySelectorAll\('\.settings-tab-btn'\)\.forEach\([^)]*=>\s*\{\s*[A-Za-z_$][\w$]*\.addEventListener/.test(initSrc),
        '★ 不再"查一遍现有按钮再逐个绑"（动态插入的插件分栏会收不到点击）');
    ok(/elaina:settings-tab/.test(initSrc), '分栏切换会广播事件（插件分栏延迟渲染）');

    // ---- voice-energy 走事件通道 ----
    // 断言"不许再出现"之前先剥注释：解释"为什么不再直接调"的注释里必然会
    // 写出那个调用，直接匹配全文就是假失败（第一版踩过）。
    const voiceCode = stripComments(voiceSrc);
    ok(/emit\('voice-energy'/.test(voiceCode), '★ 宿主把语音音量作为事件报出');
    ok(!/Live2DCall\.setVoiceEnergy/.test(voiceCode),
        '★ 宿主不再直接调 Live2D（否则搬成 mod 后这句就是空转）');
    ok(/hasListeners\('voice-energy'\)/.test(voiceCode), '★ 没人听就不建音量分析器（省掉逐帧开销）');
    // ★ 订阅改走 host.on（2026-10 搬迁）：Live2D 现在是插件，订阅登记在 mod 系统里，
    //   停用插件时会被自动摘掉（见 mods.js 的"注册即副作用"）。
    //   断言要跟着走 —— 仍写 ElainaMods.on 的话这里会因为"找不到"而失败，
    //   而那其实是**改对了**的标志。
    ok(/host\.on\('voice-energy'/.test(stripComments(l2dSrc)),
        'Live2D 侧订阅 voice-energy（走 host.on，停用时可被摘掉）');

    // ---- 前端源码读取器必须真的能读到 mod ----
    ok(/path\.join\(WEB, 'mods'\)/.test(fsSrc) && !/path\.join\(WEB, 'plugins'\)/.test(fsSrc),
        '★ frontend-sources.mjs 读的是 mods 目录（不是改名前的 plugins）');
    const { readFrontend } = await import('./frontend-sources.mjs');
    const fe = readFrontend();
    ok(fe.includes('web/mods/galgame/index.js'),
        '★ readFrontend() 真的包含 mod 源码（否则所有 mod 断言都是在空串上匹配）');
}

// ============================================================ 2 & 3. 真服务 + 真浏览器
const PORT = await freePort();
const HTTPS_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-hostapi-data-'));
const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-hostapi-log-'));
// 服务端输出落文件（见下面 spawn 的说明：受限环境里不能开命名管道）
const serverLogPath = path.join(LOG_DIR, 'server-output.log');
const outFd = openSync(serverLogPath, 'a');

/** 写一个只含前端半边的临时 mod */
function writeFrontMod(id, manifestExtra, indexJs, styleCss) {
    const dir = path.join(MODS, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({
        id, name: '检查用插件', version: '1.0.0', entry: 'index.js',
    }, manifestExtra), null, 2));
    writeFileSync(path.join(dir, 'index.js'), indexJs);
    if (styleCss) writeFileSync(path.join(dir, 'style.css'), styleCss);
}

/** 写一个含服务端半边的临时 mod */
function writeServerMod(id, serverDecl, serverJs) {
    const dir = path.join(MODS, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        id, name: '检查用插件', version: '1.0.0', entry: 'index.js', defaultEnabled: false,
        server: serverDecl,
    }, null, 2));
    writeFileSync(path.join(dir, 'index.js'), 'void 0;');
    writeFileSync(path.join(dir, 'server.mjs'), serverJs);
}

/** 清理：删临时 mod 目录 + 把清单里的临时条目滤掉（清单是入库文件，不能留痕） */
function cleanup() {
    for (const id of tmpMods) {
        try { rmSync(path.join(MODS, id), { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    try {
        const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
        idx.plugins = (idx.plugins || []).filter((p) => !String(p.id || '').startsWith(TMP_PREFIX));
        writeFileSync(INDEX, JSON.stringify(idx, null, 2), 'utf8');
    } catch { /* 忽略 */ }
}

// ---- 临时 mod（必须在服务启动**之前**写好）----
//
// ★ 先清一遍再写：上一次运行如果是**被强杀**的（调试时用 `| Select-Object -First N`
//   截断输出就会提前掐掉 node，或 Ctrl+C），清理没跑完，残留的临时 mod 会被这次
//   服务在启动时装载 —— 于是"运行中新装的插件需要重启"这类断言会以**相反**的结果
//   失败，看起来像产品坏了。检查脚本该对自己的残留免疫。
cleanup();

// ★ 把**真正的模板目录**也装一遍（改 id、打开开关），验证"复制模板就能用"。
//
//   为什么值得单独验：模板是给人复制的交付物，而"语法合法 + manifest 是 JSON"
//   不等于"装上去真的有反应" —— 恰恰是模板里的 API 名写错、插槽名写错这类问题
//   只有真装一次才会暴露。检查脚本替用户先撞一遍。
const TPL_ID = 'zz-check-tpl';
{
    const src = path.join(ROOT, 'templates', 'mod-starter');
    const dest = path.join(MODS, TPL_ID);
    cpSync(src, dest, { recursive: true });
    // manifest：换 id/名字并打开开关（默认是 false，模板本来就该默认关闭）
    const mfPath = path.join(dest, 'manifest.json');
    const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
    mf.id = TPL_ID;
    mf.name = '模板自检';
    mf.defaultEnabled = true;
    writeFileSync(mfPath, JSON.stringify(mf, null, 2));
    // index.js：模板里的 MOD_ID 必须跟着改，否则注册名与清单 id 对不上
    const jsPath = path.join(dest, 'index.js');
    writeFileSync(jsPath, readFileSync(jsPath, 'utf8')
        .replace("const MOD_ID = 'my-first-mod'", "const MOD_ID = '" + TPL_ID + "'"));
}

writeServerMod('zz-check-api',
    { entry: 'server.mjs', routes: ['/api/apicheck'], uploads: ['uploads'] },
    `export function register(ctx) {
        ctx.route('GET', '/api/apicheck/ping', (req, res, info) => {
            ctx.json(res, 200, { ok: true, mod: ctx.modId, rest: info.rest });
        });
        ctx.route('GET', '/api/apicheck/echo', (req, res, info) => {
            ctx.json(res, 200, { ok: true, rest: info.rest });
        });
        ctx.uploadDir('uploads');
    }`);
// 这个 mod 试图注册一个**没声明过**的前缀 → 装载必须失败并隔离
writeServerMod('zz-check-badapi',
    { entry: 'server.mjs', routes: ['/api/apicheckbad'] },
    `export function register(ctx) {
        ctx.route('GET', '/api/evil', (req, res) => { ctx.json(res, 200, { ok: true, hacked: true }); });
    }`);
// 这个 mod 想占宿主已有的前缀 → 必须被拒绝（否则它永远收不到请求却不报错）
writeServerMod('zz-check-collide',
    { entry: 'server.mjs', routes: ['/api/store'] },
    `export function register(ctx) {
        ctx.route('GET', '/api/store', (req, res) => { ctx.json(res, 200, { ok: true, hijacked: true }); });
    }`);
// 上传目录安全：放一个 .html 进去，必须按二进制流返回（不能同源渲染）
mkdirSync(path.join(MODS, 'zz-check-api', 'uploads'), { recursive: true });
writeFileSync(path.join(MODS, 'zz-check-api', 'uploads', 'evil.html'), '<script>alert(1)</script>');

// ---- 前端半边用的临时 mod（第 3 段）----
// 它把**五种插槽全注册一遍**，这样一次浏览器跑完就能验证所有扩展点都真的能用、
// 且停用时全部收回（插槽从 2 个加到 5 个之后，少验一个就会有"文档说有、实际挂不上"）。
writeFrontMod('zz-check-slots', { defaultEnabled: true, styles: ['style.css'] },
    `(function () {
        window.__slotTest = { factoryRuns: 0, clicks: 0, msgClicks: 0, lastEnabled: null };
        window.ElainaMods.register('zz-check-slots', function (host) {
            window.__slotTest.factoryRuns++;
            host.injectStyle(host.assetUrl('style.css'));
            host.setPromptHint('SLOT-TEST-PROMPT-HINT');
            host.slot('settings.tabs', {
                id: 'zz-check-slots', label: '插槽自检',
                render: function (el) { el.innerHTML = '<div id="zzSlotPanel">PANEL-OK</div>'; },
            });
            host.slot('header.actions', {
                id: 'probe', label: '探针', title: '插槽探针',
                onClick: function () { window.__slotTest.clicks++; },
            });
            host.slot('sidebar.footer', {
                id: 'footer',
                render: function (box) {
                    var b = document.createElement('div');
                    b.id = 'zzSidebarFooter';
                    b.textContent = 'SIDEBAR-FOOTER-OK';
                    box.appendChild(b);
                },
            });
            host.slot('composer.actions', {
                id: 'composer',
                render: function (box) {
                    var b = document.createElement('button');
                    b.type = 'button';
                    b.id = 'zzComposerBtn';
                    b.textContent = 'COMPOSER-OK';
                    box.appendChild(b);
                },
            });
            // ★ 每项级插槽：注册时还没有消息，所以这里"什么都不挂"是正常的 ——
            //   真正渲染发生在宿主渲染每条消息时（见 host-slots.js 的说明）
            host.slot('chat.message.actions', {
                id: 'msg',
                render: function (box, item) {
                    var b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'zz-msg-btn';
                    b.textContent = 'MSG-OK';
                    b.title = item && item.message ? String(item.message.id) : '(无)';
                    b.addEventListener('click', function () { window.__slotTest.msgClicks++; });
                    box.appendChild(b);
                },
            });
            return { setEnabled: function (on) { window.__slotTest.lastEnabled = on; } };
        });
    })();`,
    '.zz-slot-test{color:red}');

const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
    cwd: ROOT,
    env: {
        ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT),
        HOST: '127.0.0.1', DATA_DIR, LOG_DIR, LOG_TO_FILE: '0',
    },
    // ★ 子进程输出走**文件描述符**，不用 stdio:'pipe'。
    //   受限执行环境（本项目的 DSH 沙箱就是）不允许程序打开命名管道，
    //   stdio:'pipe' 起子进程会直接 EPERM。写文件没有这个限制，而且
    //   失败时服务端输出照样留得下来（比 stdio:'ignore' 强得多）。
    stdio: ['ignore', outFd, outFd],
});
const serverOut = () => { try { return readFileSync(serverLogPath, 'utf8'); } catch { return ''; } };

let browser = null;
try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
        try { up = (await fetch(BASE + '/api/server-info')).ok; } catch { await wait(250); }
    }
    ok(up, '服务已启动', up ? '' : serverOut().slice(-500));

    if (up) {
        // ==================================================== 2. 服务端半边
        console.log('\n=== 2. 服务端半边：声明白名单 / 撞名 / 上传目录 ===');

        // ★ 插件后端路由的首个请求带**短重试**：全套检查并发跑时磁盘/CPU 紧张，
        //   服务"端口已开"到"插件路由装载完成"之间有个小窗口 —— 首个 ping 可能
        //   落在窗口里拿到 404（实测偶发，单独跑从不出现）。重试到路由就绪为止。
        let ping = null, pingBody = null;
        for (let i = 0; i < 10; i++) {
            ping = await fetch(BASE + '/api/apicheck/ping');
            pingBody = await ping.json().catch(() => null);
            if (ping.status === 200 && pingBody && pingBody.ok === true) break;
            await wait(300);
        }
        ok(ping.status === 200 && pingBody && pingBody.ok === true && pingBody.mod === 'zz-check-api',
            '★ 声明过的路由前缀被真的注册上了（插件能提供接口）',
            'HTTP ' + ping.status + ' ' + JSON.stringify(pingBody));

        const echo = await fetch(BASE + '/api/apicheck/echo/deep/path');
        const echoBody = await echo.json().catch(() => null);
        ok(echo.status === 200 && echoBody && echoBody.rest === '/deep/path',
            '★ 子路径可达且 rest 正确（插件能自己解析路径参数）', JSON.stringify(echoBody));

        // ★【模板】它自带的 server.mjs 也要真的装载并能通
        const tplPing = await fetch(BASE + '/api/myfirstmod/ping');
        const tplBody = await tplPing.json().catch(() => null);
        ok(tplPing.status === 200 && tplBody && tplBody.ok === true && tplBody.mod === TPL_ID,
            '★【模板】它自带的 server.mjs 装载成功、接口可用（复制模板即得可用的后端半边）',
            'HTTP ' + tplPing.status + ' ' + JSON.stringify(tplBody));

        // 未声明的前缀：装载失败 → 接口不存在 → 宿主也不会被"打洞"
        const evil = await fetch(BASE + '/api/evil');
        ok(evil.status === 404, '★ 未在清单里声明的前缀注册不上（/api/evil 不存在）', 'HTTP ' + evil.status);

        // 撞宿主前缀：被拒绝，宿主接口仍正常
        const store = await fetch(BASE + '/api/store');
        const storeBody = await store.json().catch(() => null);
        ok(store.status === 200 && storeBody && storeBody.hijacked === undefined,
            '★ 想占 /api/store 的插件被拒绝，宿主接口仍然是宿主的',
            'HTTP ' + store.status + ' ' + JSON.stringify(storeBody).slice(0, 80));

        // 上传目录必须按二进制流返回
        const evilHtml = await fetch(BASE + '/mods/zz-check-api/uploads/evil.html');
        const ctype = evilHtml.headers.get('content-type') || '';
        ok(evilHtml.status === 200 && ctype.startsWith('application/octet-stream'),
            '★ 插件声明的上传目录按二进制流返回（用户上传 .html 不会被同源渲染）',
            'HTTP ' + evilHtml.status + ' type=' + ctype);

        // 状态上报：谁装载了、谁失败了
        const plugins = await fetch(BASE + '/api/plugins');
        const pbody = await plugins.json().catch(() => null);
        const srv = (pbody && pbody.serverRoutes) || {};
        // 诊断输出：装载失败的原因必须打出来，否则只剩一句"没装载上"，
        // 排查时还得去翻服务端日志（而这个检查自己就是排查工具）
        for (const m of (srv.mods || [])) {
            console.log(`      装载 ${m.ok ? '成功' : '失败'}: ${m.id}${m.ok ? '' : ' —— ' + m.error}`);
        }
        for (const f of (srv.failed || [])) {
            console.log(`      失败明细: ${f.id} —— ${f.error}`);
        }
        const loadedIds = (srv.mods || []).filter((m) => m.ok).map((m) => m.id);
        const failedIds = (srv.failed || []).map((f) => f.id);
        ok(loadedIds.includes('zz-check-api'), '服务端状态里报告了已装载的插件', JSON.stringify(loadedIds));
        ok(failedIds.includes('zz-check-badapi'), '★ 注册未声明前缀的插件被标记为装载失败', JSON.stringify(failedIds));
        ok(failedIds.includes('zz-check-collide'), '★ 与宿主撞名的插件被标记为装载失败', JSON.stringify(failedIds));
        const badMsg = ((srv.failed || []).find((f) => f.id === 'zz-check-badapi') || {}).error || '';
        ok(/没有落在 manifest\.json 的 server\.routes/.test(badMsg), '★ 失败原因是可读的（告诉插件作者该去声明）', badMsg.slice(0, 90));

        // 服务启动后新装的带 server 的插件 → 必须报"需重启"，不能静默不生效
        writeServerMod('zz-check-late',
            { entry: 'server.mjs', routes: ['/api/apiclate'] },
            `export function register(ctx) {
                ctx.route('GET', '/api/apiclate/ping', (req, res) => { ctx.json(res, 200, { ok: true }); });
            }`);
        const plugins2 = await (await fetch(BASE + '/api/plugins')).json().catch(() => null);
        const srv2 = (plugins2 && plugins2.serverRoutes) || {};
        const lateIds = (srv2.needsRestart || []).map((n) => n.id);
        ok(lateIds.includes('zz-check-late'),
            '★ 服务运行中才装上的服务端插件被报为「需重启才生效」（不是静默不工作）', JSON.stringify(lateIds));
        const latePing = await fetch(BASE + '/api/apiclate/ping');
        ok(latePing.status === 404, '它的接口此刻确实还不存在（与"需重启"一致）', 'HTTP ' + latePing.status);

        // ==================================================== 3. 浏览器
        console.log('\n=== 3. 浏览器：插槽真的挂上 / 停用真的收回 ===');
        browser = await launchTestBrowser();
        const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctxB.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        // 导航单独兜一层：失败时必须能看到"页面停在哪 / 服务端收到过什么"，
        // 否则只剩一句 timeout，排查等于从零开始（第一版就卡在这里）。
        let navStatus = 0;
        try {
            const resp = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
            navStatus = resp ? resp.status() : 0;
        } catch (e) {
            console.log('  导航失败：' + String(e.message).split('\n')[0]);
            console.log('  当前 URL：' + page.url());
            console.log('  服务端输出尾部：\n' + serverOut().split('\n').slice(-12).map((l) => '    ' + l).join('\n'));
        }
        ok(navStatus === 200, '★ 页面能正常打开（HTTP 200）', 'status=' + navStatus);
        // 等插件系统把清单读完并注册（mods.js 的 boot 是异步的）
        for (let i = 0; i < 40; i++) {
            const ready = await page.evaluate(() => Boolean(window.__slotTest && window.__slotTest.factoryRuns > 0));
            if (ready) break;
            await page.waitForTimeout(250);
        }

        // ★ 造一条真实消息 —— chat.message.actions 是**每项级**插槽，没有消息就没有
        //   任何东西可验；而"注册时挂不上、渲染时才画"正是它最容易出错的地方。
        await page.evaluate(() => {
            state.conversations = [{
                id: 'zz-slot-conv', title: '插槽自检会话',
                messages: [
                    { id: 'zz-m1', role: 'ai', text: '第一条', timestamp: '00:00:01' },
                    { id: 'zz-m2', role: 'user', text: '第二条', timestamp: '00:00:02' },
                ],
            }];
            state.currentConversationId = 'zz-slot-conv';
            loadConversation('zz-slot-conv');
        });
        await page.waitForTimeout(400);

        const initial = await page.evaluate(() => {
            const nav = document.getElementById('settingsTabNav');
            const slot = document.getElementById('headerModSlot');
            return {
                factoryRuns: window.__slotTest ? window.__slotTest.factoryRuns : 0,
                tabBtn: Boolean(nav && nav.querySelector('[data-settings-tab="tab-zz-check-slots"]')),
                panel: Boolean(document.getElementById('tab-zz-check-slots')),
                headerBtn: Boolean(slot && slot.querySelector('#mod-header-zz-check-slots-probe')),
                sidebarFooter: Boolean(document.getElementById('zzSidebarFooter')),
                composerBtn: Boolean(document.getElementById('zzComposerBtn')),
                msgBoxes: document.querySelectorAll('.message-slot-actions').length,
                msgBtns: document.querySelectorAll('.message-slot-actions .zz-msg-btn').length,
                msgBtnTagged: (() => {
                    const b = document.querySelector('.message-slot-actions .zz-msg-btn');
                    return b ? b.getAttribute('data-mod') : null;
                })(),
                hint: (window.ElainaMods.collectPromptHints() || []).join('|').includes('SLOT-TEST-PROMPT-HINT'),
                styleEl: (() => {
                    const l = document.querySelector('link[data-mod="zz-check-slots"]');
                    return l ? { exists: true, disabled: l.disabled } : { exists: false };
                })(),
                // ---- 模板目录（改 id 后原样装进来）有没有真的生效 ----
                tplTab: Boolean(document.querySelector('[data-settings-tab="tab-' + 'zz-check-tpl"]')),
                tplHeaderBtn: Boolean(document.getElementById('mod-header-zz-check-tpl-hello')),
                tplSidebar: Boolean(document.querySelector('#sidebarModSlot .my-mod-footer')),
                tplComposer: Boolean(document.querySelector('#composerModSlot .my-mod-quick')),
                tplMsgBtns: document.querySelectorAll('.message-slot-actions .my-mod-msg-btn').length,
                tplStyleDisabled: (() => {
                    const l = document.querySelector('link[data-mod="zz-check-tpl"]');
                    return l ? l.disabled : null;
                })(),
            };
        });
        ok(initial.factoryRuns === 1, '插件工厂只跑了一次', 'runs=' + initial.factoryRuns);
        ok(initial.tabBtn, '★ settings.tabs：插件分栏出现在分栏导航里');
        ok(initial.panel, '★ settings.tabs：对应的面板容器也建好了');
        ok(initial.headerBtn, '★ header.actions：插件顶部按钮出现在挂载点里');
        ok(initial.sidebarFooter, '★ sidebar.footer：侧栏底部插槽渲染出来了');
        ok(initial.composerBtn, '★ composer.actions：输入框那一行的插槽渲染出来了');
        ok(initial.msgBoxes === 2, '★ chat.message.actions：每条消息都有插槽容器', 'boxes=' + initial.msgBoxes);
        ok(initial.msgBtns === 2, '★ chat.message.actions：两条消息各画了一个按钮（每项级渲染）', 'btns=' + initial.msgBtns);
        ok(initial.msgBtnTagged === 'zz-check-slots',
            '★ 每项级渲染出的元素被打了归属标记（停用时靠它精确摘除）', String(initial.msgBtnTagged));
        ok(initial.hint, '★ 插件注入的 system 提示词生效');
        ok(initial.styleEl.exists && initial.styleEl.disabled === false, '★ 插件注入的样式表已生效');

        // ---- ★ 模板目录：证明"复制 templates/mod-starter 就能用" ----
        ok(initial.tplTab, '★【模板】设置分栏出现了（label「我的插件」）');
        ok(initial.tplHeaderBtn, '★【模板】顶部按钮出现了（label「打招呼」）');
        ok(initial.tplSidebar, '★【模板】侧栏底部内容出现了');
        ok(initial.tplComposer, '★【模板】输入框那一行的按钮出现了');
        ok(initial.tplMsgBtns === 2, '★【模板】每条消息各画了一个按钮（每项级渲染）', 'btns=' + initial.tplMsgBtns);
        ok(initial.tplStyleDisabled === false, '★【模板】manifest 里声明的 styles 生效了');

        // 消息按钮真的能点（不只是画出来了）
        const msgClicks = await page.evaluate(() => {
            const b = document.querySelector('.message-slot-actions .zz-msg-btn');
            if (!b) return -1;
            b.click();
            return window.__slotTest.msgClicks;
        });
        ok(msgClicks === 1, '★ 每消息按钮的点击处理被调用', 'clicks=' + msgClicks);

        // 点击分栏 → 延迟渲染
        const panelText = await page.evaluate(() => {
            const btn = document.querySelector('[data-settings-tab="tab-zz-check-slots"]');
            if (!btn) return '(没有按钮)';
            btn.click();
            const p = document.getElementById('zzSlotPanel');
            return p ? p.textContent : '(面板没渲染)';
        });
        ok(panelText === 'PANEL-OK', '★ 点击插件分栏会渲染内容（事件委托生效）', panelText);

        // ★ 宿主**自己的**分栏也必须在同一条委托上能切换。
        //   这是"把逐个绑按钮改成事件委托"最容易漏掉的回归点：委托只覆盖了插件按钮、
        //   宿主按钮却因为监听被删而失效 —— 而那样插件分栏的测试照样通过。
        const hostTab = await page.evaluate(() => {
            const btn = document.querySelector('[data-settings-tab="tab-advanced"]');
            if (!btn) return { found: false };
            btn.click();
            const p = document.getElementById('tab-advanced');
            return {
                found: true,
                activePanel: p ? p.classList.contains('active-panel') : false,
                btnActive: btn.classList.contains('active'),
            };
        });
        ok(hostTab.found && hostTab.activePanel && hostTab.btnActive,
            '★ 宿主自己的设置分栏仍然能切换（委托没有把原有按钮漏掉）', JSON.stringify(hostTab));

        // 点击顶部按钮
        const clicks = await page.evaluate(() => {
            const b = document.querySelector('#mod-header-zz-check-slots-probe');
            if (!b) return -1;
            b.click();
            return window.__slotTest.clicks;
        });
        ok(clicks === 1, '★ 插件顶部按钮的点击处理被调用', 'clicks=' + clicks);

        // 再调一次 loadAll：工厂不许重跑（幂等闸门）
        await page.evaluate(() => window.ElainaMods.loadAll());
        await page.waitForTimeout(600);
        const afterReload = await page.evaluate(() => ({
            runs: window.__slotTest.factoryRuns,
            tabCount: document.querySelectorAll('[data-settings-tab="tab-zz-check-slots"]').length,
            headerCount: document.querySelectorAll('#mod-header-zz-check-slots-probe').length,
            sidebarCount: document.querySelectorAll('#zzSidebarFooter').length,
            composerCount: document.querySelectorAll('#zzComposerBtn').length,
            msgBtnCount: document.querySelectorAll('.message-slot-actions .zz-msg-btn').length,
        }));
        ok(afterReload.runs === 1
            && afterReload.tabCount === 1 && afterReload.headerCount === 1
            && afterReload.sidebarCount === 1 && afterReload.composerCount === 1
            && afterReload.msgBtnCount === 2,
            '★ 重复 loadAll 不重跑工厂、每处插槽都不产生第二份',
            JSON.stringify(afterReload));

        // 停用 → 一切都要收回
        await page.evaluate(() => window.ElainaMods.setEnabled('zz-check-slots', false));
        await page.waitForTimeout(300);
        const off = await page.evaluate(() => ({
            tabBtn: Boolean(document.querySelector('[data-settings-tab="tab-zz-check-slots"]')),
            panel: Boolean(document.getElementById('tab-zz-check-slots')),
            headerBtn: Boolean(document.querySelector('#mod-header-zz-check-slots-probe')),
            sidebarFooter: Boolean(document.getElementById('zzSidebarFooter')),
            composerBtn: Boolean(document.getElementById('zzComposerBtn')),
            msgBtns: document.querySelectorAll('.message-slot-actions .zz-msg-btn').length,
            // 容器本身必须还在（它是宿主的，插件不该把它一起带走）
            msgBoxesKept: document.querySelectorAll('.message-slot-actions').length,
            hint: (window.ElainaMods.collectPromptHints() || []).join('|').includes('SLOT-TEST-PROMPT-HINT'),
            styleDisabled: (() => {
                const l = document.querySelector('link[data-mod="zz-check-slots"]');
                return l ? l.disabled : null;
            })(),
            toldMod: window.__slotTest.lastEnabled,
        }));
        ok(!off.tabBtn, '★ 停用后：settings.tabs 入口消失');
        ok(!off.panel, '★ 停用后：分栏面板消失');
        ok(!off.headerBtn, '★ 停用后：header.actions 按钮消失');
        ok(!off.sidebarFooter, '★ 停用后：sidebar.footer 内容消失');
        ok(!off.composerBtn, '★ 停用后：composer.actions 内容消失');
        ok(off.msgBtns === 0, '★ 停用后：**已经画在消息行上**的按钮被立刻摘掉（不是等下次重渲染）', 'btns=' + off.msgBtns);
        ok(off.msgBoxesKept === 2, '★ 停用时只摘插件自己的元素，宿主的消息容器不受影响', 'boxes=' + off.msgBoxesKept);
        ok(!off.hint, '★ 停用后：注入的 system 提示词被摘掉（不再影响模型行为）');
        ok(off.styleDisabled === true, '★ 停用后：注入的样式表失效', 'disabled=' + off.styleDisabled);
        ok(off.toldMod === false, '停用也会通知插件自己（它自建的界面自己收）', 'lastEnabled=' + off.toldMod);

        // 重新启用 → 挂回来，且**不重跑工厂**
        await page.evaluate(() => window.ElainaMods.setEnabled('zz-check-slots', true));
        await page.waitForTimeout(400);
        const back = await page.evaluate(() => ({
            runs: window.__slotTest.factoryRuns,
            tabBtn: Boolean(document.querySelector('[data-settings-tab="tab-zz-check-slots"]')),
            headerBtn: Boolean(document.querySelector('#mod-header-zz-check-slots-probe')),
            sidebarFooter: Boolean(document.getElementById('zzSidebarFooter')),
            composerBtn: Boolean(document.getElementById('zzComposerBtn')),
            msgBtns: document.querySelectorAll('.message-slot-actions .zz-msg-btn').length,
            hint: (window.ElainaMods.collectPromptHints() || []).join('|').includes('SLOT-TEST-PROMPT-HINT'),
            styleDisabled: (() => {
                const l = document.querySelector('link[data-mod="zz-check-slots"]');
                return l ? l.disabled : null;
            })(),
        }));
        ok(back.tabBtn && back.headerBtn && back.sidebarFooter && back.composerBtn && back.hint
            && back.styleDisabled === false,
            '★ 重新启用：注册项全部挂回来（分栏/顶部/侧栏/输入框/提示词/样式）', JSON.stringify(back));
        ok(back.msgBtns === 2,
            '★ 重新启用：已经存在的消息行也被补画上按钮（不用刷新页面）', 'btns=' + back.msgBtns);
        ok(back.runs === 1, '★ 重新启用不重跑工厂（否则界面与定时器会翻倍）', 'runs=' + back.runs);

        // ---- ★【模板】停用它，五处贡献同样要全部收回 ----
        //   模板是别人会照着抄的东西：如果它自己都收不干净，抄出去的就是残留 bug。
        await page.evaluate(() => window.ElainaMods.setEnabled('zz-check-tpl', false));
        await page.waitForTimeout(300);
        const tplOff = await page.evaluate(() => ({
            tab: Boolean(document.querySelector('[data-settings-tab="tab-zz-check-tpl"]')),
            headerBtn: Boolean(document.getElementById('mod-header-zz-check-tpl-hello')),
            sidebar: Boolean(document.querySelector('#sidebarModSlot .my-mod-footer')),
            composer: Boolean(document.querySelector('#composerModSlot .my-mod-quick')),
            msgBtns: document.querySelectorAll('.message-slot-actions .my-mod-msg-btn').length,
            styleDisabled: (() => {
                const l = document.querySelector('link[data-mod="zz-check-tpl"]');
                return l ? l.disabled : null;
            })(),
        }));
        ok(!tplOff.tab && !tplOff.headerBtn && !tplOff.sidebar && !tplOff.composer
            && tplOff.msgBtns === 0 && tplOff.styleDisabled === true,
            '★【模板】停用后五处贡献全部收回（模板自己不留残留）', JSON.stringify(tplOff));

        console.log('  页面错误:', pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '(无)');
        await ctxB.close();
    }
} finally {
    if (browser) { try { await browser.close(); } catch { /* 忽略 */ } }
    child.kill();
    await wait(300);
    cleanup();
    for (const d of [DATA_DIR, LOG_DIR]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
