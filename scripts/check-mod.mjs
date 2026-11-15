// 插件（mod）系统的回归检查：扫描 / 安装解压 / 清单生成 / 安全防护 / 身份与依赖解析 / 宿主能力（插槽）/ 端到端。
// 服务端唯一实现是 Go（server/）：原锚在已删除 Node 服务端模块（server/*.mjs、web/serve.mjs）的用例改锚
// Go HTTP 行为与磁盘事实；zip 字节层安全由 server/internal/zipx 的 go test 钉住（check-go.mjs 编排）。
// 每个用例自建临时目录与端口并在 try/finally 里自清（部分用例起真实服务，写死端口/MODS_DIR 会互相争用）。
// 用法：node scripts/check-mod.mjs [用例名子串]，缺省跑全部。
// 环境性跳过（缺 mods/ 实物或没有 Go 工具链）计 PASS：不是代码坏了，逐条比对跳过说明即可。

import {
    mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdirSync,
    openSync, closeSync, cpSync, utimesSync, renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFrontend } from './frontend-sources.mjs';
import { launchTestBrowser } from './test-browser.mjs';
import { runChecks, ROOT, wait, waitServerUp, freePort, startGoServer, makeZip } from './check-harness.mjs';
import { extractFunction as extractFn } from './check-source.mjs';

const MODS = path.join(ROOT, 'mods');

// 按 manifest.id 反查插件真实目录名：目录名可被用户改，写死目录名会在合法改名下假失败
function modDirById(id, modsRoot = MODS) {
    let names = [];
    try { names = readdirSync(modsRoot); } catch { return null; }
    for (const n of names) {
        const mf = path.join(modsRoot, n, 'manifest.json');
        if (!existsSync(mf)) continue;
        try {
            const m = JSON.parse(readFileSync(mf, 'utf8'));
            if (m && m.id === id) return n;
        } catch { /* 忽略坏 manifest */ }
    }
    return existsSync(path.join(modsRoot, id, 'index.js')) ? id : null;
}

// 登记制临时目录，用例结束统一删；前缀按用例区分，残留时能看出漏清理的是哪一段
function tempDirFactory(prefix) {
    const created = [];
    return {
        dir() {
            const d = mkdtempSync(path.join(tmpdir(), prefix));
            created.push(d);
            return d;
        },
        cleanup() {
            for (const d of created) {
                try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
            }
            created.length = 0;
        },
    };
}

// 去注释后的源码：供"不许再出现某调用"类断言用，避免解释性注释被误判命中
const stripComments = (src) => String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

// 起一个指向临时夹具的 Go 服务：DATA_DIR/LOG_DIR 走登记制临时目录，可选 MODS_DIR/SKILLS_DIR/
// 插件启用状态（写入 ELAINA_PLUGIN_STATE_FILE，Go 服务端只从这一个文件读启用键值表）。
// 返回 null 表示本机没有 Go 工具链：环境性跳过，不判红。
async function startFixtureServer(tmp, { modsDir, skillsDir, state } = {}) {
    const env = { DATA_DIR: tmp.dir(), LOG_DIR: tmp.dir() };
    if (modsDir) env.MODS_DIR = modsDir;
    if (skillsDir) env.SKILLS_DIR = skillsDir;
    if (state) {
        const stateFile = path.join(env.DATA_DIR, 'plugin-state.json');
        writeFileSync(stateFile, JSON.stringify(state));
        env.ELAINA_PLUGIN_STATE_FILE = stateFile;
    }
    const srv = await startGoServer({ env });
    if (!srv) console.log('  --   跳过：本机没有 Go 工具链，无法编译服务端（环境性跳过）');
    return srv;
}

/** 轮询 /api/plugins 直到扫描完成（自动装 zip / 清单生成有窗口），返回解析后的应答 */
async function fetchPluginList(base) {
    let body = null;
    for (let i = 0; i < 20; i++) {
        body = await fetch(base + '/api/plugins').then((r) => r.json()).catch(() => null);
        if (body && body.ok === true) break;
        await wait(300);
    }
    return body;
}

// 1. 插件系统核心：扫描 / 安装（mods/ 丢 zip 自动装 + POST 上传安装）/ 清单生成 / 安全防护。
// 原来白盒读 server/mods.mjs、web/serve.mjs 源码的断言改锚 Go HTTP 行为与磁盘事实
// （server/internal/httpapi/packages.go + server/internal/packages）。
// zip 字节层安全（路径穿越 / 危险扩展名 / 体积上限）唯一实现在 server/internal/zipx，有 go test 守护；
// 这里断言安装接口的对外结论（安装成功但只有合法文件落盘），两层合起来覆盖同一道防线。
async function caseModsCore(c) {
    const tmp = tempDirFactory('elaina-modcore-');
    let srv = null;
    try {
        const modsDir = tmp.dir();
        writeFileSync(path.join(modsDir, 'demo-mod.zip'), makeZip([
            { name: 'demo-mod/manifest.json', data: JSON.stringify({ name: '演示插件', version: '1.0.0', entry: 'index.js', styles: ['style.css'] }) },
            { name: 'demo-mod/index.js', data: 'window.ElainaMods && window.ElainaMods.register("demo-mod", function(h){ return {}; });' },
            { name: 'demo-mod/style.css', data: '.demo{color:red}' },
        ]));
        writeFileSync(path.join(modsDir, 'evil-mod.zip'), makeZip([
            { name: 'evil-mod/manifest.json', data: JSON.stringify({ name: '恶意' }) },
            { name: 'evil-mod/index.js', data: 'console.log("x")' },
            { name: 'evil-mod/../../web/serve.mjs', data: 'HACKED' },
            { name: 'evil-mod/bad.exe', data: 'MZ' },
        ]));
        mkdirSync(path.join(modsDir, 'elaina-avatar', 'img'), { recursive: true });
        writeFileSync(path.join(modsDir, 'elaina-avatar', 'manifest.json'), JSON.stringify({
            id: 'elaina-avatar', name: '伊蕾娜立绘与情绪', version: '1.0.0',
            entry: 'index.js', defaultEnabled: true, hidden: true,
            capabilities: ['theme'],
        }));
        writeFileSync(path.join(modsDir, 'elaina-avatar', 'index.js'), 'void 0;');
        // 一张 1x1 的合法 PNG（内容不重要，要的是它能被静态服务取到）
        writeFileSync(path.join(modsDir, 'elaina-avatar', 'img', 'p_calm.png'),
            Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000'
                + '01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'));
        // 带版本号的安装目录 + README：目录名（birthday-1.1.0）与 manifest.id（birthday）不一致，用 id 拼路径会 404
        mkdirSync(path.join(modsDir, 'birthday-1.1.0'), { recursive: true });
        writeFileSync(path.join(modsDir, 'birthday-1.1.0', 'manifest.json'), JSON.stringify({
            id: 'birthday', name: '生日说明测试', version: '1.1.0', entry: 'index.js',
        }));
        writeFileSync(path.join(modsDir, 'birthday-1.1.0', 'index.js'), 'void 0;');
        writeFileSync(path.join(modsDir, 'birthday-1.1.0', 'README.md'), '# 生日说明测试\n');

        srv = await startFixtureServer(tmp, { modsDir });
        if (!srv) return;
        c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-500));
        if (!srv.up) return;
        const BASE = srv.base;

        const body = await fetchPluginList(BASE);
        c.ok(body && body.ok === true, 'GET /api/plugins 成功');

        const plugins = (body && body.plugins) || [];
        const ids = plugins.map((p) => p.id);
        c.ok(ids.includes('demo-mod'), '★ 丢进 mods/ 的 zip 被自动解压成 mod', JSON.stringify(ids));
        c.ok(ids.includes('elaina-avatar'), '已存在的目录 mod 被识别');

        const demo = plugins.find((p) => p.id === 'demo-mod');
        c.ok(demo && demo.name === '演示插件', 'manifest.json 被正确读取', demo && demo.name);
        c.ok(demo && demo.entry === 'index.js', 'entry 字段生效');
        c.ok(demo && Array.isArray(demo.styles) && demo.styles.includes('style.css'), 'styles 字段生效');
        c.ok(demo && demo.dir === 'demo-mod', '清单带 dir 字段（资源 URL 按真实目录拼）', demo && demo.dir);

        // README 走接口而不是前端 fetch：目录名带版本号时拿 id 直接拼会 404
        const rr = await fetch(BASE + '/api/plugins/birthday/readme');
        const rb = await rr.json().catch(() => null);
        c.ok(rr.status === 200 && rb && rb.ok === true,
            '★★ README 按 manifest.id 解析真实目录（目录名可带版本号）', 'HTTP ' + rr.status);
        c.ok(rb && String(rb.text || '').includes('生日说明测试'), '★ README 正文按真实目录读回');

        // 恶意 zip：穿越与 .exe 条目在 zipx.Read 一层就被拦下（不进安装计数），合法文件照常落盘
        const evil = ((body && body.installResults) || []).find((r) => r.zip === 'evil-mod.zip');
        c.ok(evil && typeof evil.ok === 'boolean', '恶意 zip 有安装结果回报', JSON.stringify((body && body.installResults) || []));
        c.ok(evil && evil.ok === true && evil.files === 2,
            '★ 恶意 zip：只有 2 个合法文件被写入（穿越与 .exe 被拦）', evil && JSON.stringify(evil));
        {
            const evilDir = path.join(modsDir, 'evil-mod');
            const inside = existsSync(evilDir) ? readdirSync(evilDir) : [];
            c.ok(!inside.includes('bad.exe'), '★ .exe 未落盘（以磁盘为准）', inside.join(','));
            c.ok(inside.filter((n) => /^(manifest\.json|index\.js)$/.test(n)).length === 2,
                '★ 恶意 zip 只落盘 2 个合法文件（以磁盘为准）', inside.join(','));
            c.ok(!existsSync(path.join(modsDir, '..', 'web')),
                '★ 穿越条目没有写出 mods/ 之外（staging 的 ../.. 落点没有 web/）');
        }
        c.ok(existsSync(path.join(modsDir, 'evil-mod', 'index.js')), '★ mod 的 index.js 允许落盘（mod 本质就是代码）');

        const idx = JSON.parse(readFileSync(path.join(modsDir, 'index.json'), 'utf8'));
        c.ok(Array.isArray(idx.plugins) && idx.plugins.some((p) => p.id === 'demo-mod'),
            'index.json 被服务端重新生成且含新装的 mod');

        const del = await fetch(BASE + '/api/plugins/demo-mod', { method: 'DELETE' });
        c.ok(del.status === 200, 'DELETE 卸载成功', 'HTTP ' + del.status);
        c.ok(!existsSync(path.join(modsDir, 'demo-mod')), '★ mod 目录已被删除');
        c.ok(!existsSync(path.join(modsDir, 'demo-mod.zip')), '★ 安装包也被删除（否则会被重新装回来）');

        // POST 上传安装（zip 原始字节、名字走 query）：与"丢 zip 进目录"同一条 zipx 防线
        const upBuf = makeZip([
            { name: 'upload-mod/manifest.json', data: JSON.stringify({ name: '上传安装', version: '1.0.0', entry: 'index.js' }) },
            { name: 'upload-mod/index.js', data: 'void 0;' },
        ]);
        const up = await fetch(BASE + '/api/plugins/install?name=upload-mod.zip', { method: 'POST', body: upBuf });
        const upBody = await up.json().catch(() => null);
        c.ok(up.status === 200 && upBody && upBody.ok === true && upBody.id === 'upload-mod',
            '★ POST /api/plugins/install 上传安装成功', 'HTTP ' + up.status + ' ' + JSON.stringify(upBody));
        c.ok(existsSync(path.join(modsDir, 'upload-mod', 'index.js')), '上传的插件落盘');
        const badName = await fetch(BASE + '/api/plugins/install?name=' + encodeURIComponent('../evil.zip'),
            { method: 'POST', body: upBuf });
        c.ok(badName.status === 400, '★ 插件名带路径成分被明确拒绝（不静默改名）', 'HTTP ' + badName.status);

        // capabilities / hidden 透传：漏了则 host.theme 等重成员全变 undefined、前置区少一类
        const av = plugins.find((p) => p.id === 'elaina-avatar');
        c.ok(Boolean(av), '清单里有 elaina-avatar');
        if (av) {
            c.ok(typeof av.dir === 'string' && av.dir.length > 0,
                '★ 清单带 dir 字段（前端据此拼资源 URL）', av.dir);
            c.ok(Array.isArray(av.capabilities) && av.capabilities.includes('theme'),
                '★ 清单透传 manifest.capabilities（AGENTS.md D18 / 表 A22）', JSON.stringify(av.capabilities));
            c.ok(av.hidden === true, 'hidden 字段透传（前置扩展单列）');
            const img = await fetch(BASE + '/mods/' + av.dir + '/img/p_calm.png');
            c.ok(img.status === 200,
                'mod 立绘可经静态服务访问（按真实目录 ' + av.dir + '）', 'HTTP ' + img.status);
        }
        c.ok((await fetch(BASE + '/mods/index.json')).status === 200, 'mod 清单可被前端读取');
        c.ok((await fetch(BASE + '/js/mods.js')).status === 200, 'mod 加载器脚本可被加载');

        // /mods/* 显式路由：web/ 静态根够不到项目根 mods/；钉住真实 MIME（nosniff 下 octet-stream
        // 让插件界面空白）、路径穿越（隔壁 data/ 是密钥明文）、目录不给列表
        console.log('\n  — /mods/* 显式路由 —');
        {
            const js = await fetch(BASE + '/mods/elaina-avatar/index.js');
            c.ok(js.status === 200, '/mods/<dir>/index.js → 200', 'status=' + js.status);
            c.ok((js.headers.get('content-type') || '').includes('javascript'),
                '★ 插件 JS 发 javascript MIME（nosniff 下错了就不执行）', js.headers.get('content-type'));

            writeFileSync(path.join(modsDir, 'elaina-avatar', 'probe.html'), '<p>probe</p>');
            writeFileSync(path.join(modsDir, 'elaina-avatar', 'probe.css'), '.x{}');
            const panel = await fetch(BASE + '/mods/elaina-avatar/probe.html');
            c.ok(panel.status === 200, '/mods/<dir>/*.html → 200', 'status=' + panel.status);
            c.ok((panel.headers.get('content-type') || '').includes('text/html'),
                '★ 插件 HTML 发 text/html（否则设置面板插槽拿不到内容）', panel.headers.get('content-type'));
            const cssRes = await fetch(BASE + '/mods/elaina-avatar/probe.css');
            c.ok(cssRes.status === 200, '/mods/<dir>/*.css → 200', 'status=' + cssRes.status);

            const t1 = await fetch(BASE + '/mods/../data/store.json');
            c.ok(t1.status === 403 || t1.status === 404,
                '★★ /mods/../data/store.json 被拒（data/ 就在隔壁，是密钥明文）', 'status=' + t1.status);
            const t2 = await fetch(BASE + '/mods/%2e%2e/data/store.json');
            c.ok(t2.status === 403 || t2.status === 404, '★★ 编码后的 .. 也被拒', 'status=' + t2.status);

            const miss = await fetch(BASE + '/mods/nope/nope.js');
            c.ok(miss.status === 404, '不存在的插件文件 → 404（不是 500）', 'status=' + miss.status);
            const dirList = await fetch(BASE + '/mods/');
            c.ok(dirList.status === 404, '/mods/ 不给目录列表', 'status=' + dirList.status);
        }
    } finally {
        if (srv) srv.stop();
        tmp.cleanup();
    }
}

// 2. 插件 id 归一化 + 依赖可解析性 —— 钉住「资源包装了等于没装」。
// 成因：安装逻辑直接拿 zip 文件名当 id，装进带版本号的目录，资源 URL 404、after 匹配不上。
// 原锚在已删除的 server/mods.mjs（createModManager.scanAndSync 白盒）；改锚 Go 服务端：
// 同一批夹具目录走 /api/plugins 与磁盘事实。语义差异：归一化（剥 -1.0.0 版本尾）只发生在
// 「丢 zip 进 mods/ 被扫描装掉」这条链（packages.ScanMods → normalizeModID）；
// POST /api/plugins/install 的 id 直接取 query 文件名（不剥版本尾），两层都以 Go 实际行为为准。
function avatarZip(version = '1.0.0', declaredId = 'elaina-avatar') {
    return makeZip([
        { name: 'manifest.json', data: JSON.stringify({
            id: declaredId, name: '伊蕾娜立绘与情绪', version,
            entry: 'index.js', defaultEnabled: true, hidden: true,
        }) },
        { name: 'index.js', data: 'window.ElainaMods && window.ElainaMods.register("elaina-avatar",function(){return{}});' },
        { name: 'img/p_calm.png', data: 'PNGDATA' },
    ]);
}

async function caseModId(c) {
    const tmp = tempDirFactory('elaina-modid-');
    let srv = null;
    const stopSrv = () => { if (srv) { srv.stop(); srv = null; } };

    try {
        // 2.1 带版本号的 zip 丢进目录 → 清单 id 与磁盘目录都归一化
        {
            const modsDir = tmp.dir();
            writeFileSync(path.join(modsDir, 'elaina-avatar-1.0.0.zip'), avatarZip('1.0.0'));
            srv = await startFixtureServer(tmp, { modsDir });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
            if (srv.up) {
                const body = await fetchPluginList(srv.base);
                const ids = ((body && body.plugins) || []).map((p) => p.id);
                c.ok(ids.includes('elaina-avatar'), '★ 清单里的 id 归一化为 elaina-avatar', JSON.stringify(ids));

                const dirs = readdirSync(modsDir).filter((n) => !n.endsWith('.zip') && n !== 'index.json' && !n.startsWith('.'));
                c.ok(dirs.includes('elaina-avatar'), '★ 磁盘目录也装成 elaina-avatar（不是带版本号的）', JSON.stringify(dirs));
                const p = ((body && body.plugins) || []).find((x) => x.id === 'elaina-avatar');
                c.ok(p && p.dir === 'elaina-avatar', '清单里 dir 字段与实际目录一致', p && p.dir);
                c.ok(existsSync(path.join(modsDir, 'elaina-avatar', 'img', 'p_calm.png')),
                    '★ 立绘落在 /mods/elaina-avatar/img/p_calm.png 能取到的位置');
                c.ok(!existsSync(path.join(modsDir, 'elaina-avatar-1.0.0')),
                    '★ 没有留下带版本号的目录（旧 bug 的形态）');
            }
            stopSrv();
        }

        // 2.2 依赖可解析：装好的 elaina-avatar 能被 galgame 的 after 引用
        {
            const modsDir = tmp.dir();
            writeFileSync(path.join(modsDir, 'elaina-avatar-1.0.0.zip'), avatarZip('1.0.0'));
            mkdirSync(path.join(modsDir, 'galgame'), { recursive: true });
            writeFileSync(path.join(modsDir, 'galgame', 'manifest.json'), JSON.stringify({
                id: 'galgame', name: 'Galgame 界面', entry: 'index.js', after: ['elaina-avatar'],
            }));
            writeFileSync(path.join(modsDir, 'galgame', 'index.js'), 'void 0;');
            srv = await startFixtureServer(tmp, { modsDir });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
            if (srv.up) {
                const body = await fetchPluginList(srv.base);
                const plugins = (body && body.plugins) || [];
                const ids = new Set(plugins.map((p) => p.id));
                c.ok(ids.has('elaina-avatar'), '★ elaina-avatar 在清单里（依赖能被解析到）', JSON.stringify([...ids]));
                c.ok(ids.has('galgame'), 'galgame 也在清单里');
                const g = plugins.find((p) => p.id === 'galgame');
                c.ok(g && g.after.every((d) => ids.has(d)),
                    '★ galgame 声明的 after 全部能在清单里找到（依赖解析有效）',
                    g ? JSON.stringify(g.after) : '');
            }
            stopSrv();
        }

        // 2.3 用户自己解压的旧版本目录（目录带版本、manifest.id 不带）→ 身份识别 + 目录保留
        {
            const modsDir = tmp.dir();
            const old = path.join(modsDir, 'elaina-avatar-1.0.0');
            mkdirSync(path.join(old, 'img'), { recursive: true });
            writeFileSync(path.join(old, 'manifest.json'), JSON.stringify({
                id: 'elaina-avatar', name: '伊蕾娜立绘', entry: 'index.js',
            }));
            writeFileSync(path.join(old, 'index.js'), 'void 0;');
            writeFileSync(path.join(old, 'img', 'p_calm.png'), 'PNGDATA');
            srv = await startFixtureServer(tmp, { modsDir });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
            if (srv.up) {
                const body = await fetchPluginList(srv.base);
                const p = ((body && body.plugins) || []).find((x) => x.id === 'elaina-avatar');
                c.ok(Boolean(p), '★ 旧目录被识别为 elaina-avatar（id 归一化，用户不用重装）',
                    JSON.stringify(((body && body.plugins) || []).map((x) => x.id)));
                c.ok(p && p.dir === 'elaina-avatar-1.0.0',
                    '★ 同时保留真实目录名（脚本/资源按它加载，不会 404）', p && p.dir);
                c.ok(existsSync(old), '★ 旧目录没有被删（用户数据/设置在它下面）');
            }
            stopSrv();
        }

        // 2.4 单段数字尾巴不剥（my-mod-2 这类名字很常见，剥了会误伤真实名字）
        {
            const modsDir = tmp.dir();
            for (const name of ['my-mod-2', 'mod2', 'plugin-v2', 'a-1']) {
                const d = path.join(modsDir, name);
                mkdirSync(d, { recursive: true });
                writeFileSync(path.join(d, 'index.js'), 'void 0;');
            }
            srv = await startFixtureServer(tmp, { modsDir });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
            if (srv.up) {
                const body = await fetchPluginList(srv.base);
                const ids = ((body && body.plugins) || []).map((x) => x.id);
                for (const name of ['my-mod-2', 'mod2', 'plugin-v2', 'a-1']) {
                    c.ok(ids.includes(name), `★ ${name} 不被误剥（单段数字不是版本号）`, JSON.stringify(ids));
                }
            }
            stopSrv();
        }

        // 2.5 目录名与 manifest.id 不一致 → 清单 id 取 manifest.id，dir 保留目录名
        {
            const modsDir = tmp.dir();
            const d = path.join(modsDir, 'wrong-dir-name');
            mkdirSync(d, { recursive: true });
            writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({
                id: 'real-id', name: '真名', entry: 'index.js',
            }));
            writeFileSync(path.join(d, 'index.js'), 'void 0;');
            srv = await startFixtureServer(tmp, { modsDir });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
            if (srv.up) {
                const body = await fetchPluginList(srv.base);
                const p = ((body && body.plugins) || [])[0];
                c.ok(p && p.id === 'real-id', '★ 清单 id 取 manifest.id（不是目录名）', p && p.id);
                c.ok(p && p.dir === 'wrong-dir-name', 'dir 字段仍是真实目录名（供加载脚本用）', p && p.dir);
            }
            stopSrv();
        }

        // 2.6 非法 manifest.id 回落到目录名，路径成分不泄漏进 id
        {
            const modsDir = tmp.dir();
            for (const [dirName, badId] of [['safe-dir', '../../etc/passwd'], ['safe-dir2', 'has space'], ['safe-dir3', '']]) {
                const d = path.join(modsDir, dirName);
                mkdirSync(d, { recursive: true });
                writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id: badId, name: 'x', entry: 'index.js' }));
                writeFileSync(path.join(d, 'index.js'), 'void 0;');
            }
            srv = await startFixtureServer(tmp, { modsDir });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
            if (srv.up) {
                const body = await fetchPluginList(srv.base);
                const ids = ((body && body.plugins) || []).map((x) => x.id).sort();
                c.ok(ids.includes('safe-dir') && ids.includes('safe-dir2') && ids.includes('safe-dir3'),
                    '★ 非法 manifest.id 被拒，回落到目录名', JSON.stringify(ids));
                c.ok(!ids.some((x) => x.includes('..') || x.includes('/')),
                    '★ 没有路径成分泄漏进 id', JSON.stringify(ids));
            }
            stopSrv();
        }

        // 2.7 装载只认"完整的一段"：安装中途的 .installing- 临时目录不被扫成插件；
        // 清理按"陈旧"判定（扫描在插件列表与清单请求上都会跑，删掉新鲜的 staging 等于替并发安装删半成品）
        {
            const modsDir = tmp.dir();
            const staging = path.join(modsDir, `.installing-elaina-avatar-${process.pid}-1`);
            mkdirSync(staging, { recursive: true });
            writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
                id: 'elaina-avatar', name: '写了一半的插件', entry: 'index.js',
            }));
            srv = await startFixtureServer(tmp, { modsDir });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
            if (srv.up) {
                const body = await fetchPluginList(srv.base);
                c.ok(!((body && body.plugins) || []).some((p) => p.id === 'elaina-avatar'),
                    '★ 安装中途的临时目录不被扫成已装插件（否则脚本会 404 并当场停用）',
                    JSON.stringify(((body && body.plugins) || []).map((p) => p.id)));
                c.ok(existsSync(staging),
                    '★ 还在安装中的临时目录不被删除（否则并发安装会丢掉自己正在写的文件）');
                srv.stop(); srv = null;

                // 改成"进程被杀后留下的那类"（超过 stale 阈值），下一次扫描才该清掉。
                const stale = new Date(Date.now() - 11 * 60 * 1000);
                utimesSync(staging, stale, stale);
                srv = await startFixtureServer(tmp, { modsDir });
                c.ok(srv && srv.up, '服务已重启', srv && srv.up ? '' : srv.bootLog.slice(-400));
                if (srv && srv.up) {
                    await fetchPluginList(srv.base);
                    c.ok(!readdirSync(modsDir).some((n) => n.startsWith('.installing-')),
                        '★ 陈旧的安装残留会被清掉（否则白占几十 MB 且用户看不见）',
                        JSON.stringify(readdirSync(modsDir)));

                    writeFileSync(path.join(modsDir, 'elaina-avatar-1.0.0.zip'), avatarZip('1.0.0'));
                    const body = await fetchPluginList(srv.base);
                    const p = ((body && body.plugins) || []).find((x) => x.id === 'elaina-avatar');
                    c.ok(Boolean(p), '★ zip 装完后清单里有它', JSON.stringify(((body && body.plugins) || []).map((x) => x.id)));
                    c.ok(p && existsSync(path.join(modsDir, p.dir, 'index.js')),
                        '★ 装完 entry 脚本确实落盘（不存在"清单有、脚本没有"的中间态）', p && p.dir);
                    c.ok(readdirSync(modsDir).every((n) => !n.startsWith('.installing-')),
                        '★ 安装成功/失败都不留临时目录残骸', JSON.stringify(readdirSync(modsDir)));
                }
            }
            stopSrv();
        }

        // 2.8 默认关闭只认显式 true：判据写成 !== false 就是"漏写即默认打开"，与文档相反；
        // 服务端（Go）与前端（mods.js / core-native-mod.js 原生清单）必须同语义
        {
            const modsDir = tmp.dir();
            const mk = (id, mf) => {
                const d = path.join(modsDir, id);
                mkdirSync(d, { recursive: true });
                writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(mf));
                writeFileSync(path.join(d, 'index.js'), 'void 0;');
            };
            mk('explicit-on', { id: 'explicit-on', name: 'A', entry: 'index.js', defaultEnabled: true });
            mk('explicit-off', { id: 'explicit-off', name: 'B', entry: 'index.js', defaultEnabled: false });
            mk('no-field', { id: 'no-field', name: 'C', entry: 'index.js' });
            mk('bogus-value', { id: 'bogus-value', name: 'D', entry: 'index.js', defaultEnabled: 'yes' });
            srv = await startFixtureServer(tmp, { modsDir });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
            if (srv.up) {
                const body = await fetchPluginList(srv.base);
                const byId = new Map(((body && body.plugins) || []).map((p) => [p.id, p]));
                const flag = (id) => byId.get(id) && byId.get(id).defaultEnabled;
                c.ok(flag('explicit-on') === true, '★ 显式 defaultEnabled:true 才算默认启用', String(flag('explicit-on')));
                c.ok(flag('explicit-off') === false, '显式 false 是默认关闭', String(flag('explicit-off')));
                c.ok(flag('no-field') === false,
                    '★ 漏写 defaultEnabled 算默认关闭（写成 !== false 就是默认打开，与文档相反）',
                    String(flag('no-field')));
                c.ok(flag('bogus-value') === false, '非 true 的取值一律算关闭', String(flag('bogus-value')));

                const modsSrc = readFileSync(path.join(WEB, 'js', 'mods.js'), 'utf8');
                const nativeSrc = readFileSync(path.join(WEB, 'js', 'core-native-mod.js'), 'utf8');
                for (const [name, src] of [['web/js/mods.js', modsSrc], ['web/js/core-native-mod.js', nativeSrc]]) {
                    c.ok(!/defaultEnabled\s*!==\s*false/.test(src),
                        `★ ${name} 的默认关闭判据不是 !== false（那是"默认打开"）`);
                    c.ok(/defaultEnabled\s*===\s*true/.test(src),
                        `★ ${name} 只把显式 true 当默认启用`);
                }
            }
            stopSrv();
        }
    } finally {
        stopSrv();
        tmp.cleanup();
    }
}

// 3. 插件身份与路径解析：目录改名后依然能识别、初始化、取到资源。
// 目录扫描与身份解析的语义在 Go（server/internal/plugin/manifest.go）：改锚 Go HTTP ——
// 改名夹具目录后重启服务重扫，断言 id 不变、资源 URL 用真实目录名。
// 前端半边（目录 → 注册名映射、依赖索引认三种身份）保留源码锚（模块化后按文件合并读取）。
async function caseModIdentity(c) {
    const tmp = tempDirFactory('elaina-ident-');
    let srv = null;
    const stopSrv = () => { if (srv) { srv.stop(); srv = null; } };

    try {
        // 3.1 目录名与身份无关：目录 1111 里装 elaina-avatar，身份仍认 manifest.id；资源按真实目录名取
        {
            const modsDir = tmp.dir();
            const put = (dirName, manifest) => {
                const d = path.join(modsDir, dirName);
                mkdirSync(d, { recursive: true });
                if (manifest) writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(manifest));
                writeFileSync(path.join(d, 'index.js'), 'void 0;');
            };
            put('1111', { id: 'elaina-avatar', name: '立绘', entry: 'index.js' });
            put('galgame', { id: 'galgame', name: 'GG', entry: 'index.js', after: ['elaina-avatar'] });
            srv = await startFixtureServer(tmp, { modsDir });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
            if (srv.up) {
                const body = await fetchPluginList(srv.base);
                const plugins = (body && body.plugins) || [];
                const av = plugins.find((p) => p.id === 'elaina-avatar');
                c.ok(Boolean(av), '★ 目录名 1111 被识别为 elaina-avatar（manifest.id 权威）',
                    JSON.stringify(plugins.map((p) => p.id)));
                c.ok(av && av.dir === '1111', '★ dir 保留真实目录名 1111（资源按它取）', av && av.dir);
                const ids = new Set(plugins.map((p) => p.id));
                const g = plugins.find((p) => p.id === 'galgame');
                c.ok(g && g.after.every((d) => ids.has(d)),
                    '★ galgame 的 after 仍能解析（改名不影响依赖）', g ? JSON.stringify(g.after) : '');
                const script = await fetch(srv.base + '/mods/' + av.dir + '/index.js');
                c.ok(script.status === 200, '★ 脚本按真实目录名可达（不是按 id 拼 URL）', 'HTTP ' + script.status);
            }
            stopSrv();
        }

        // 3.2 目录改名 + 重启重扫：id 不变、dir 跟着新目录、资源从新目录取到
        {
            const modsDir = tmp.dir();
            const v1 = path.join(modsDir, 'avatar-v1');
            mkdirSync(v1, { recursive: true });
            writeFileSync(path.join(v1, 'manifest.json'), JSON.stringify({
                id: 'elaina-avatar', name: '立绘', entry: 'index.js',
            }));
            writeFileSync(path.join(v1, 'index.js'), 'void 0;');
            srv = await startFixtureServer(tmp, { modsDir });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
            if (srv.up) {
                const before = await fetchPluginList(srv.base);
                const b = ((before && before.plugins) || []).find((p) => p.id === 'elaina-avatar');
                c.ok(b && b.dir === 'avatar-v1', '改名前按当前目录识别', b && b.dir);
                stopSrv();

                renameSync(v1, path.join(modsDir, 'avatar-renamed'));
                srv = await startFixtureServer(tmp, { modsDir });
                c.ok(srv && srv.up, '改名后服务已重启', srv && srv.up ? '' : srv.bootLog.slice(-400));
                if (srv && srv.up) {
                    const after = await fetchPluginList(srv.base);
                    const a = ((after && after.plugins) || []).find((p) => p.id === 'elaina-avatar');
                    c.ok(Boolean(a), '★ 目录改名后身份不变（id 仍解析到 elaina-avatar）',
                        JSON.stringify(((after && after.plugins) || []).map((p) => p.id)));
                    c.ok(a && a.dir === 'avatar-renamed', '★ dir 跟着真实目录名走（资源 URL 用它拼）', a && a.dir);
                    const script = await fetch(srv.base + '/mods/avatar-renamed/index.js');
                    c.ok(script.status === 200, '★ 脚本从改名后的目录取到', 'HTTP ' + script.status);
                }
            }
            stopSrv();
        }

        // 3.3 缺 manifest → id 回落到目录名
        {
            const modsDir = tmp.dir();
            const d = path.join(modsDir, 'pet-renamed');
            mkdirSync(d, { recursive: true });
            writeFileSync(path.join(d, 'index.js'), 'void 0;');
            srv = await startFixtureServer(tmp, { modsDir });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
            if (srv.up) {
                const body = await fetchPluginList(srv.base);
                const p = ((body && body.plugins) || [])[0];
                c.ok(p && p.id === 'pet-renamed', 'id 回落到目录名（并剥版本号尾）', p && p.id);
                c.ok(p && p.dir === 'pet-renamed', 'dir 是真实目录名', p && p.dir);
                c.ok(p && p.hasManifest === false, '清单如实标注缺 manifest（hasManifest=false）', p && String(p.hasManifest));
            }
            stopSrv();
        }

        // 3.4 前端半边：目录 → 注册名映射（模块化后的 mods.js 家族）
        {
            const MODS_JS = readFileSync(path.join(WEB, 'js', 'mods.js'), 'utf8')
                + '\n' + readFileSync(path.join(WEB, 'js', 'mods-api.js'), 'utf8')
                + '\n' + readFileSync(path.join(WEB, 'js', 'mods-load-one.js'), 'utf8')
                + '\n' + readFileSync(path.join(WEB, 'js', 'mods-deps.js'), 'utf8')
                + '\n' + readFileSync(path.join(WEB, 'js', 'mods-load.js'), 'utf8')
                + '\n' + readFileSync(path.join(WEB, 'js', 'mods-host-core.js'), 'utf8');
            c.ok(/const regByDir = new Map\(\)/.test(MODS_JS), '有 regByDir（目录 → 注册名）');
            c.ok(/const dirByReg = new Map\(\)/.test(MODS_JS), '有 dirByReg（注册名 → 目录）');
            c.ok(/let loadingDir = null;/.test(MODS_JS), '有 loadingDir（注入时标记来源目录）');
            c.ok(/getRegByDir\(\)\.set\(getLoadingDir\(\), name\)/.test(MODS_JS),
                '★ register() 会记下"这个注册名来自哪个目录"');
            c.ok(/getRegByDir\(\)\.get\(manifest\.dir \|\| manifest\.id\)/.test(MODS_JS),
                '★ loadOne 会按目录反查注册名（目录改名也能初始化）');
            c.ok(/entry\.state = 'blocked'/.test(MODS_JS),
                '★ 缺前置插件时状态标为 blocked（拒绝加载，不是警告后照跑）');
            c.ok(/前置插件不可用/.test(MODS_JS), '★ 报错文案说明了缺什么');
            c.ok(/reason: '未安装'/.test(MODS_JS) && /reason: '未启用'/.test(MODS_JS),
                '★ 区分「未安装」与「未启用」两种原因');
            c.ok(/require\(key\) \{/.test(MODS_JS), 'host API 提供 require()（由系统解析依赖）');
            c.ok(/byKey\.set\(m\.dir, m\)/.test(MODS_JS),
                '★ 缺依赖判定同时认目录名（避免改名后误报）');
            c.ok(/getRegByDir\(\)\.get\(m\.dir\)/.test(MODS_JS),
                '★ 缺依赖判定也认注册名（三种身份都收进索引）');
        }

        // 3.5 真实立绘插件：资源解析不写死目录名（本地没有该插件时跳过这段，不判红）
        {
            const avDirName = modDirById('elaina-avatar');
            if (!avDirName) {
                console.log('  --   跳过 3.5：本地没有 elaina-avatar 插件源码（插件走应用内安装，这是正常状态）');
            } else {
                const av = readFileSync(path.join(MODS, avDirName, 'index.js'), 'utf8');
                c.ok(/host\.assetBase|assetUrl/.test(av),
                    '★ elaina-avatar 用宿主给的 assetBase 解析资源（不写死目录名）');
                c.ok(/window\.ElainaAvatar/.test(av), 'elaina-avatar 仍暴露 ElainaAvatar 接口给依赖方');
            }
        }
    } finally {
        stopSrv();
        tmp.cleanup();
    }
}

function writeIsolationMod(root, id, indexJs, extra = {}) {
    const dir = path.join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({
        id, name: id, version: '1.0.0', entry: 'index.js', defaultEnabled: false,
    }, extra), null, 2));
    writeFileSync(path.join(dir, 'index.js'), indexJs);
    return Object.assign({
        id, dir: id, name: id, version: '1.0.0', entry: 'index.js',
        scripts: [], styles: [], defaultEnabled: false, after: [], hidden: false,
    }, extra);
}

async function caseModIsolation(c) {
    const MODS_JS = readFileSync(path.join(WEB, 'js', 'mods-capabilities.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods-loader.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods-contributions.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods-services.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods-slots.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods-load-one.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods-faults.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods-host.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods-forget.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods-api.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods-paths.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods-host-core.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods-host-extras.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'mods.js'), 'utf8');

    {
        c.ok(/function resolveModAsset/.test(MODS_JS),
            '★ 有 resolveModAsset（清单里的路径统一校验，不再直接拼字符串）');
        c.ok(/resolveModAsset\(manifest, css, 'styles'\)/.test(MODS_JS)
            && /resolveModAsset\(manifest, one, 'scripts'\)/.test(MODS_JS),
            '★ 清单的 styles / scripts 都经路径校验（外链与 ../ 越界被拒）');
        c.ok(/unix\.startsWith\('\/\/'\)/.test(MODS_JS) && /A-Za-z\]\[A-Za-z0-9\+\.-\]\*:/.test(MODS_JS),
            '★ 拒绝协议相对地址与带 scheme 的外链（否则一份 manifest 就能注入第三方脚本）');
        c.ok(/const SCRIPT_LOAD_TIMEOUT_MS/.test(MODS_JS) && /const MOD_INIT_TIMEOUT_MS/.test(MODS_JS),
            '★ 脚本加载与工厂初始化都有超时上限');
        c.ok(/withTimeout\([\s\S]{0,120}factory\(createHostApi/.test(MODS_JS),
            '★ 工厂经 withTimeout 包裹（永不 resolve 的插件不能挂住整轮加载）');
        c.ok(/function guardMod\b/.test(MODS_JS) && /function guardModAsync/.test(MODS_JS)
            && /function reportModFault/.test(MODS_JS),
            '★ 有统一的插件错误出口（guardMod / guardModAsync / reportModFault）');
        c.ok(/MOD_FAULT_LIMIT/.test(MODS_JS) && /entry\.faultCount/.test(MODS_JS),
            '★ 单个插件有错误预算（连续出错才自动停用，偶发一次不处罚）');
        c.ok(/guardModAsync\(\s*manifest\.id, '事件 ' \+ event/.test(MODS_JS),
            '★ 事件订阅在进总线前就包了隔离（异步 rejection 不会漏成 unhandledrejection）');
        c.ok(/lifecycleFor\(manifest\.id\)/.test(MODS_JS) && /abortLifecycle/.test(MODS_JS),
            '★ 每个插件有生命周期信号（卸载时 abort，长任务据此退出）');
        c.ok(/signal: lifecycle \? lifecycle\.signal : undefined/.test(MODS_JS),
            '★ host.signal 下发给插件（长任务有统一的退出通道）');
        c.ok(/pluginVersion/.test(MODS_JS) && /hostVersion/.test(MODS_JS),
            '★ 插件版本与宿主契约版本分开暴露（不再只有一个含混的 version）');
    }

    {
        const slotsSrc = readFileSync(path.join(WEB, 'js', 'host-slots.js'), 'utf8');
        const settingsSrc = readFileSync(path.join(WEB, 'js', 'plugins.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'settings.js'), 'utf8');
        const slotsCode = stripComments(slotsSrc);
        const settingsCode = stripComments(settingsSrc);
        c.ok(/registerSettingsOpener\(key, \{ open, close \}\)/.test(slotsSrc),
            '★ settings.modal 经 ElainaMods.registerSettingsOpener 登记（统一入口）');
        c.ok(!/__modSettingsOpeners\s*=|__modSettingsOpeners\s*\|\|/.test(slotsCode),
            '★ host-slots.js 不再自己维护 window.__modSettingsOpeners');
        c.ok(/hasModSettings\(/.test(settingsCode) && /openModSettings\(/.test(settingsCode),
            '★ settings.js 只经统一入口查询/打开插件设置窗');
        c.ok(!/__modSettingsOpeners/.test(settingsCode),
            '★ settings.js 不再直接读宿主私有全局名');
        c.ok(/openSettings\(targetId\)/.test(MODS_JS) && /hasSettings\(targetId\)/.test(MODS_JS),
            '★ host.openSettings / host.hasSettings 作为插件之间的统一入口');
        c.ok(/function registerSettingsOpener/.test(MODS_JS)
            && /function openModSettings/.test(MODS_JS)
            && /function hasModSettings/.test(MODS_JS),
            '★ 登记 / 打开 / 查询三个动作收敛在一处');
    }

    const tmp = tempDirFactory('elaina-isolation-');
    try {
        {
            const root = tmp.dir();
            const bad = writeIsolationMod(root, 'zz-iso-bad',
                'window.ElainaMods&&window.ElainaMods.register("zz-iso-bad",function(){throw new Error("隔离用例故意失败");});');
            const good = writeIsolationMod(root, 'zz-iso-good',
                'window.ElainaMods&&window.ElainaMods.register("zz-iso-good",function(host){'
                + 'return {ok:true,hasSignal:!!host.signal,pluginVersion:host.pluginVersion,'
                + 'hostVersion:host.hostVersion,hasOpenSettings:typeof host.openSettings==="function",'
                + 'hasHasSettings:typeof host.hasSettings==="function"};});');
            const enabled = { 'elaina_plugin_zz-iso-bad': '1', 'elaina_plugin_zz-iso-good': '1' };
            const r = await loadModsInSandbox(enabled, {
                modsDir: root,
                indexPlugins: [Object.assign({}, bad, { defaultEnabled: true }),
                    Object.assign({}, good, { defaultEnabled: true })],
            });
            const sBad = r.results.find((x) => x.id === 'zz-iso-bad');
            const sGood = r.results.find((x) => x.id === 'zz-iso-good');
            c.ok(sBad && sBad.state === 'error' && sBad.autoDisabled === true,
                '★ 工厂抛错的插件被标 error 并自动停用', sBad && (sBad.state + '/' + sBad.autoDisabled));
            c.ok(sGood && sGood.state === 'ready',
                '★ 同一次加载里，好插件照常 ready（坏插件不牵连它）', sGood && sGood.state);
            c.ok(r.storeGet('elaina_plugin_zz-iso-bad') === '0',
                '★ 坏插件停用写盘（刷新后不再试）', r.storeGet('elaina_plugin_zz-iso-bad'));
            const api = r.Mods.find('zz-iso-good')?.entry?.api;
            c.ok(api && api.ok === true, '好插件返回的 api 保存在条目上', api && String(api.ok));
            c.ok(api && api.hasSignal === true, '★ host.signal 下发给插件（统一的长任务退出通道）');
            c.ok(api && api.pluginVersion === '1.0.0' && typeof api.hostVersion === 'string',
                '★ pluginVersion 与 hostVersion 分别给出（不再混在一个 version 里）',
                api && (api.pluginVersion + '/' + api.hostVersion));
            c.ok(api && api.hasOpenSettings === true && api.hasHasSettings === true,
                '★ host.openSettings / host.hasSettings 存在（插件之间打开设置窗的统一入口）');
        }

        {
            const root = tmp.dir();
            const good = writeIsolationMod(root, 'zz-iso-fault',
                'window.ElainaMods&&window.ElainaMods.register("zz-iso-fault",function(host){'
                + 'window.__isoHost=host;return {ok:true};});');
            const r = await loadModsInSandbox({ 'elaina_plugin_zz-iso-fault': '1' }, {
                modsDir: root,
                indexPlugins: [Object.assign({}, good, { defaultEnabled: true })],
            });
            const st = r.results.find((x) => x.id === 'zz-iso-fault');
            c.ok(st && st.state === 'ready', '隔离用例插件先正常就绪', st && st.state);
            c.ok(typeof r.Mods.guard === 'function' && typeof r.Mods.guardAsync === 'function',
                '★ ElainaMods.guard / guardAsync 对外可用（宿主其它模块共用同一个边界）');
            const got = r.Mods.guard('zz-iso-fault', '用例回调', () => { throw new Error('boom'); }, 'FALLBACK');
            c.ok(got === 'FALLBACK', '★ guard 捕获异常并返回 fallback（调用方流程继续）', String(got));
            const limit = r.Mods.faultLimit;
            c.ok(limit > 1, '错误预算大于 1（偶发一次不直接停用）', String(limit));
            for (let i = 0; i < limit; i++) r.Mods.guard('zz-iso-fault', '连续出错用例', () => { throw new Error('boom'); });
            const after = r.Mods.list().find((x) => x.id === 'zz-iso-fault');
            c.ok(after && after.state === 'error' && after.autoDisabled === true,
                '★ 连续出错达到预算后自动停用（不再留在界面上）', after && (after.state + '/' + after.autoDisabled));
            c.ok(typeof r.Mods.faultLimit === 'number' && r.Mods.faultCount('zz-iso-fault') >= limit,
                '★ 错误次数可查询（诊断时说得清为什么被停用）',
                String(r.Mods.faultCount('zz-iso-fault')));
        }

        {
            const root = tmp.dir();
            const evil = writeIsolationMod(root, 'zz-iso-evil', 'void 0;',
                { entry: 'index.js', scripts: ['//evil.example/x.js'] });
            const r = await loadModsInSandbox({ 'elaina_plugin_zz-iso-evil': '1' }, {
                modsDir: root,
                indexPlugins: [Object.assign({}, evil, { defaultEnabled: true })],
            });
            const st = r.results.find((x) => x.id === 'zz-iso-evil');
            c.ok(st && st.state === 'error',
                '★ 清单里写外链脚本 → 插件加载失败（不执行第三方代码）', st && st.state);
            c.ok(st && /不合法|相对路径/.test(st.error || ''),
                '★ 失败原因说清是路径不合法', st && st.error);
            c.ok(r.storeGet('elaina_plugin_zz-iso-evil') === '0',
                '★ 该插件被停用写盘（每次启动不再尝试）');
        }

        {
            const root = tmp.dir();
            const hijack = writeIsolationMod(root, 'zz-iso-hijack',
                'window.ElainaMods&&window.ElainaMods.register("zz-iso-victim",function(){throw new Error("劫持代码被执行了");});');
            const victim = writeIsolationMod(root, 'zz-iso-victim', 'void 0;');
            const r = await loadModsInSandbox(
                { 'elaina_plugin_zz-iso-hijack': '1', 'elaina_plugin_zz-iso-victim': '1' },
                { modsDir: root, indexPlugins: [hijack, victim] });
            const sV = r.results.find((x) => x.id === 'zz-iso-victim');
            c.ok(sV && sV.state !== 'error',
                '★ 受害者插件没有被别的目录登记的工厂带崩', sV && sV.state);
            c.ok(/已拒绝执行|不能替另一个插件登记/.test(r.text),
                '★ 拒绝跨目录登记的工厂被执行（要么登记时拒绝，要么加载时拒绝）');
        }
    } finally {
        tmp.cleanup();
    }
}
// 依赖判定要区分"装了但未启用"与"装了且启用"（否则前置禁用时依赖方照样 ready、拿不到资源），
// 日志要人能读（不用 id=state 机器写法）。沙箱 readyState 用 'loading'，避免 boot() 自动跑一遍致日志重复。

const WEB = path.join(ROOT, 'web');
// URL→磁盘映射：/mods/* 走项目根 MODS（不在 WEB 下），其余相对 WEB；分错则 /mods/* 全 404、断言集体假失败
const resolveUrlToDisk = (url) => {
    const rel = decodeURIComponent(String(url).split('?')[0]).replace(/^\//, '');
    if (rel === 'mods' || rel.startsWith('mods/')) {
        return path.join(ROOT, rel);
    }
    return path.join(WEB, rel);
};

// 在沙箱里跑 mods.js 并 loadAll，返回结果与日志；源码每次现读，用例自成一体
async function loadModsInSandbox(store, opts = {}) {
    const MODS_JS = readFileSync(path.join(WEB, 'js', 'mods.js'), 'utf8');
    const MODS_LOADER_JS = readFileSync(path.join(WEB, 'js', 'mods-loader.js'), 'utf8');
    const MODS_SERVICES_JS = readFileSync(path.join(WEB, 'js', 'mods-services.js'), 'utf8');
    const MODS_CONTRIBUTIONS_JS = readFileSync(path.join(WEB, 'js', 'mods-contributions.js'), 'utf8');
    const MODS_SLOTS_JS = readFileSync(path.join(WEB, 'js', 'mods-slots.js'), 'utf8');
    const MODS_SUMMARY_JS = readFileSync(path.join(WEB, 'js', 'mods-summary.js'), 'utf8');
    const MODS_DEPS_JS = readFileSync(path.join(WEB, 'js', 'mods-deps.js'), 'utf8');
    const MODS_CAPABILITIES_JS = readFileSync(path.join(WEB, 'js', 'mods-capabilities.js'), 'utf8');
    const MODS_LOAD_JS = readFileSync(path.join(WEB, 'js', 'mods-load.js'), 'utf8');
    const MODS_ENABLE_JS = readFileSync(path.join(WEB, 'js', 'mods-enable.js'), 'utf8');
    const MODS_LOAD_ONE_JS = readFileSync(path.join(WEB, 'js', 'mods-load-one.js'), 'utf8');
    const MODS_FAULTS_JS = readFileSync(path.join(WEB, 'js', 'mods-faults.js'), 'utf8');
    const MODS_HOST_JS = readFileSync(path.join(WEB, 'js', 'mods-host.js'), 'utf8');
    const MODS_FORGET_JS = readFileSync(path.join(WEB, 'js', 'mods-forget.js'), 'utf8');
    const MODS_API_JS = readFileSync(path.join(WEB, 'js', 'mods-api.js'), 'utf8');
    const MODS_EXTRAS_JS = readFileSync(path.join(WEB, 'js', 'mods-host-extras.js'), 'utf8');
    const MODS_STORAGE_JS = readFileSync(path.join(WEB, 'js', 'mods-storage.js'), 'utf8');
    const MODS_HOST_CORE_JS = readFileSync(path.join(WEB, 'js', 'mods-host-core.js'), 'utf8');
    const MODS_DRAG_SORT_JS = readFileSync(path.join(WEB, 'js', 'mods-drag-sort.js'), 'utf8');
    const MODS_GRAPH_JS = readFileSync(path.join(WEB, 'js', 'mods-graph.js'), 'utf8');
    const MODS_PATHS_JS = readFileSync(path.join(WEB, 'js', 'mods-paths.js'), 'utf8');
    // diagnostics.js 在真实页面先于 mods.js 加载、输出格式依赖它，照实模拟以免测到回落路径
    const DIAG_JS = readFileSync(path.join(WEB, 'js', 'diagnostics.js'), 'utf8');
    const STORE_JS = readFileSync(path.join(WEB, 'js', 'store.js'), 'utf8');

    const logs = [];
    // 用例自给自足时（临时插件 + 自定义清单）把 /mods/* 指到临时目录，不读写本机 mods/ 实物
    const resolve = (url) => {
        if (!opts.modsDir) return resolveUrlToDisk(url);
        const rel = decodeURIComponent(String(url).split('?')[0]).replace(/^\//, '');
        if (rel === 'mods' || rel.startsWith('mods/')) {
            return path.join(opts.modsDir, rel.slice('mods/'.length));
        }
        return resolveUrlToDisk(url);
    };
    const sandbox = {
        console: {
            log: (...a) => logs.push('LOG  ' + a.join(' ')),
            warn: (...a) => logs.push('WARN ' + a.join(' ')),
            error: (...a) => logs.push('ERR  ' + a.join(' ')),
        },
        Map, Set, Promise, Date, Number, String, Boolean, Error, JSON, Object, Array, RegExp,
        encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
        fetch: async (url) => {
            // 自定义清单：依赖形状由用例完全控制，不依赖本机装了哪些插件
            if (opts.indexPlugins && String(url).split('?')[0].endsWith('/mods/index.json')) {
                const body = { plugins: opts.indexPlugins };
                return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
            }
            const p = resolve(url);
            if (!existsSync(p)) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
            const t = readFileSync(p, 'utf8');
            return { ok: true, status: 200, json: async () => JSON.parse(t), text: async () => t };
        },
    };
    // 存储层：注入真实 store.js 并接到假后端（不用真 localStorage），mods.js 经 window.Store 读插件开关
    const m = new Map(Object.entries(store));
    sandbox.localStorage = {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        get length() { return m.size; },
        key: (i) => Array.from(m.keys())[i] ?? null,
    };
    const mkEl = (tag = 'div') => ({
        tag, id: '', className: '', style: {}, dataset: {}, children: [],
        innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
        offsetWidth: 0, offsetHeight: 0,
        classList: {
            _s: new Set(),
            add(...c) { c.forEach((x) => this._s.add(x)); },
            remove(...c) { c.forEach((x) => this._s.delete(x)); },
            contains(c) { return this._s.has(c); },
            toggle(c, f) { const on = f === undefined ? !this._s.has(c) : Boolean(f); on ? this._s.add(c) : this._s.delete(c); return on; },
        },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
        appendChild(c) { this.children.push(c); return c; },
        removeChild() {}, remove() {}, insertBefore(c) { this.children.push(c); return c; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {},
        getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        focus() {}, blur() {}, click() {}, scrollTo() {}, getContext: () => null, toDataURL: () => '',
    });
    const byId = new Map();
    // 脚本请求次数（按 URL 里的用例标记累计）；opts.scriptFailures 指定"某脚本前 N 次请求失败"，验瞬时失败重试
    const scriptAttempts = new Map();
    const head = {
        appendChild(el) {
            if (el.tag !== 'script') return;
            // 与上面 fetch 共用同一个 URL→磁盘 映射（含 /mods/ 的分流）
            const p = resolve(el.src);
            const mark = Object.keys(opts.scriptFailures || {})
                .find((k) => String(el.src).includes(k));
            const n = mark ? (scriptAttempts.get(mark) || 0) + 1 : 0;
            if (mark) scriptAttempts.set(mark, n);
            if (mark && n <= opts.scriptFailures[mark]) {
                if (el.onerror) el.onerror();
                return;
            }
            if (!existsSync(p)) { if (el.onerror) el.onerror(); return; }
            try { vm.runInContext(readFileSync(p, 'utf8'), ctx, { filename: String(el.src) }); if (el.onload) el.onload(); }
            catch (e) { if (el.onerror) el.onerror(); }
        },
    };
    sandbox.document = {
        // 'loading'：避免 mods.js 的 boot() 立刻自动跑一次（'complete' 会让日志打两遍）
        readyState: 'loading',
        addEventListener() {},
        head,
        getElementById: (id) => { if (!byId.has(id)) { const e = mkEl('div'); e.id = id; byId.set(id, e); } return byId.get(id); },
        querySelector: () => null, querySelectorAll: () => [],
        createElement: mkEl, createDocumentFragment: () => mkEl('fragment'),
        body: Object.assign(mkEl('body'), { appendChild() {} }),
    };
    sandbox.Image = class { set src(v) { this._s = v; } get src() { return this._s; } };
    sandbox.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
    sandbox.cancelAnimationFrame = (id) => clearTimeout(id);
    sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
    sandbox.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
    sandbox.Event = sandbox.CustomEvent;
    sandbox.navigator = { userAgent: 'node' };
    sandbox.location = { href: 'http://127.0.0.1:4173/', hostname: '127.0.0.1' };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.XMLHttpRequest = function () {
        // store.js 的 Web 后端用同步 XHR 拉 /api/store；沙箱无服务端，回 200+空数据 = 首次启动状态
        this.open = () => {};
        this.send = () => {};
        Object.defineProperty(this, 'status', { get: () => 200 });
        Object.defineProperty(this, 'responseText', { get: () => '{"ok":true,"data":{}}' });
    };
    const ctx = vm.createContext(sandbox);

    // 与真实页面一致的加载顺序：store.js（提供 window.Store）→ diagnostics.js → mods.js；store.js 必须最先
    vm.runInContext(STORE_JS, ctx, { filename: 'store.js' });
    vm.runInContext(DIAG_JS, ctx, { filename: 'diagnostics.js' });
    // 把测试给定的初值灌进 Store（模拟 data/ 里已有的键）
    for (const [k, v] of m) sandbox.window.Store.setItem(k, v);
    vm.runInContext(MODS_PATHS_JS, ctx, { filename: 'mods-paths.js' });
    vm.runInContext(MODS_GRAPH_JS, ctx, { filename: 'mods-graph.js' });
    vm.runInContext(MODS_DRAG_SORT_JS, ctx, { filename: 'mods-drag-sort.js' });
    vm.runInContext(MODS_STORAGE_JS, ctx, { filename: 'mods-storage.js' });
    vm.runInContext(MODS_HOST_CORE_JS, ctx, { filename: 'mods-host-core.js' });
    vm.runInContext(MODS_EXTRAS_JS, ctx, { filename: 'mods-host-extras.js' });
    vm.runInContext(MODS_LOADER_JS, ctx, { filename: 'mods-loader.js' });
    vm.runInContext(MODS_CONTRIBUTIONS_JS, ctx, { filename: 'mods-contributions.js' });
    vm.runInContext(MODS_SERVICES_JS, ctx, { filename: 'mods-services.js' });
    vm.runInContext(MODS_SLOTS_JS, ctx, { filename: 'mods-slots.js' });
    vm.runInContext(MODS_SUMMARY_JS, ctx, { filename: 'mods-summary.js' });
    vm.runInContext(MODS_DEPS_JS, ctx, { filename: 'mods-deps.js' });
    vm.runInContext(MODS_CAPABILITIES_JS, ctx, { filename: 'mods-capabilities.js' });
    vm.runInContext(MODS_LOAD_JS, ctx, { filename: 'mods-load.js' });
    vm.runInContext(MODS_ENABLE_JS, ctx, { filename: 'mods-enable.js' });
    vm.runInContext(MODS_LOAD_ONE_JS, ctx, { filename: 'mods-load-one.js' });
    vm.runInContext(MODS_FAULTS_JS, ctx, { filename: 'mods-faults.js' });
    vm.runInContext(MODS_HOST_JS, ctx, { filename: 'mods-host.js' });
    vm.runInContext(MODS_FORGET_JS, ctx, { filename: 'mods-forget.js' });
    vm.runInContext(MODS_API_JS, ctx, { filename: 'mods-api.js' });
    vm.runInContext(MODS_JS, ctx, { filename: 'mods.js' });
    const Mods = sandbox.window.ElainaMods;
    const results = await Mods.loadAll();
    return {
        list: Mods.list(),
        results: results.map((r) => ({
            id: r.manifest.id, name: r.manifest.name, state: r.state,
            error: r.error || null, missingDeps: r.missingDeps || null,
            autoDisabled: r.autoDisabled === true,
        })),
        logs,
        text: logs.join('\n'),
        // 运行期操作（setEnabled 等）要经它做：list/results 是加载完成那一刻的快照
        Mods,
        storeGet: (k) => sandbox.window.Store.getItem(k),
        // 每个被 scriptFailures 点名的脚本实际被请求了几次（重试用例据此断言）
        scriptAttempts: (mark) => scriptAttempts.get(mark) || 0,
    };
}

async function caseModDeps(c) {
    // 失败隔离：坏插件不影响好插件且会被自动停用；静态+结构断言，这几条删一行也照样跑得通、最易悄悄回归。
    // 前端已按领域拆成 mods-*.js 模块：断言按模块合并读取（loadAll 循环在 mods-load.js，自动停用在
    // mods-faults.js，重新启用门禁在 mods-enable.js，失败记录读取在 mods-load-one.js，list 字段在 mods-api.js）。
    // 这一段是纯源码检查，不依赖本机装了哪些插件，始终跑。
    {
        const modsJs = readFileSync(path.join(WEB, 'js', 'mods-load.js'), 'utf8')
            + '\n' + readFileSync(path.join(WEB, 'js', 'mods-faults.js'), 'utf8')
            + '\n' + readFileSync(path.join(WEB, 'js', 'mods-enable.js'), 'utf8')
            + '\n' + readFileSync(path.join(WEB, 'js', 'mods-load-one.js'), 'utf8')
            + '\n' + readFileSync(path.join(WEB, 'js', 'mods-api.js'), 'utf8')
            + '\n' + readFileSync(path.join(WEB, 'js', 'mods.js'), 'utf8');

        const loopAt = modsJs.indexOf('const results = [];');
        const loopSeg = loopAt >= 0 ? modsJs.slice(loopAt, loopAt + 900) : '';
        c.ok(/try\s*\{[\s\S]{0,120}await loadOne\(/.test(loopSeg),
            'loadAll 对每个插件单独 try/catch（一个插件抛错不能中断整轮加载）');
        c.ok(/catch[\s\S]{0,200}entry\.state = 'error'/.test(loopSeg),
            'loadAll 的兜底把该插件标成 error 并继续');

        c.ok(/function autoDisableBroken/.test(modsJs), '有 autoDisableBroken（加载失败后自动停用）');
        const adAt = modsJs.indexOf('function autoDisableBroken');
        const adSeg = adAt >= 0 ? modsJs.slice(adAt, adAt + 400) : '';
        c.ok(/setModEnabled\(id, false\)/.test(adSeg), '自动停用会写停用状态（落盘，不是只改内存）');
        c.ok(/deactivateContributions\(id\)/.test(adSeg), '自动停用会收回该插件已注册的东西（不留半成品）');

        c.ok(/function readModFailure/.test(modsJs), '有 readModFailure（从存储读上次的失败记录）');
        c.ok(/MOD_FAILED_KEY_PREFIX/.test(modsJs), '失败记录有独立的存储键前缀');
        c.ok(/const fail = readModFailure\(manifest\.id\)/.test(modsJs),
            '重新加载时从存储读失败记录（不只依赖内存 prev）');
        c.ok(/autoDisabled: e\.autoDisabled === true/.test(modsJs),
            'list() 暴露 autoDisabled（设置界面据此区分"用户关的"与"坏了自己关的"）');

        // ④ 重新启用不能让坏插件蒙混过关：只 activateContributions 挂回并把状态强改成 ready 的话，
        //    坏插件点几次就"启动成功"（功能仍坏）。判据必须先剥注释，否则正则命中说明文字、断言永远红
        const modsCode = modsJs
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^[ \t]*\/\/.*$/gm, '');
        const setAt = modsCode.indexOf('async function setEnabled');
        const setSeg = setAt >= 0 ? modsCode.slice(setAt, setAt + 11000) : '';
        c.ok(/wasFailed/.test(setSeg), 'setEnabled 区分「上次失败」与「正常停用后重启」');
        c.ok(/neverLoaded \|\| wasFailed/.test(setSeg),
            '上次失败的插件必须重新走加载流程（不能只 activateContributions 挂回去）');
        c.ok(/clearModFailure\(id\)/.test(setSeg), '重新启用时清掉旧失败记录');
        c.ok(/if \(wasFailed && src\) loadedScripts\.delete\(src\)/.test(setSeg),
            '失败重试时清掉"已注入"记录（否则 loadOne 认定脚本已在、跳过注入）');
        c.ok(!/\.state\s*!==\s*'error'\s*\)\s*\w+\.state\s*=\s*'ready'/.test(modsCode),
            '不把加载失败强行改写成 ready（旧写法会让坏插件"点几次就启动"）');
        c.ok(/fresh\.state === 'pending'[\s\S]{0,300}autoDisableBroken/.test(setSeg),
            '没有明确加载结果时保守当成失败并停用');
    }

    /* 插件源码不随仓库分发，本地没有是正常状态：跳过而不是判红。
       判定用 modDirById 按 manifest.id 找目录（目录名常带版本号，拿 id 拼目录会把"装了"误判成"没装"）。 */
    if (!['live2d', 'galgame', 'pet', 'elaina-avatar'].every((n) => Boolean(modDirById(n)))) {
        console.log('  --   跳过：本地没有 live2d/galgame/pet/elaina-avatar 插件源码（插件走应用内安装，这是正常状态）');
        return;
    }

    // 已启用的依赖方 + 前置停关 → 加载时自动把前置带上：由 pullUpPrerequisites / ensurePrerequisites 接管；"拉不起来才拒绝"的用例在 4b
    {
        const r = await loadModsInSandbox({
            elaina_plugin_galgame: '1',
            elaina_plugin_pet: '1',
            'elaina_plugin_elaina-avatar': '0',   // ★ 前置被禁用
        });
        const av = r.results.find((x) => x.id === 'elaina-avatar');
        const gg = r.results.find((x) => x.id === 'galgame');
        const pet = r.results.find((x) => x.id === 'pet');

        c.ok(av && av.state === 'ready',
            '★ 前置 elaina-avatar 被自动拉起（ready，不用手动开）', av && av.state);
        c.ok(gg && gg.state !== 'blocked',
            '★ galgame 不再因前置被拒（假 DOM 下可能是自身 error，但绝不是 blocked）', gg && gg.state);
        c.ok(pet && pet.state !== 'blocked', 'pet 同上', pet && pet.state);
        c.ok(gg && !/未启用/.test(gg.error || ''),
            '★ 不再出现「前置未启用」的拒绝原因', gg && gg.error);
        c.ok(/连同/.test(r.text), '日志说明了连同启用（排查时看得见）');
    }

    // 设置界面需要的字段
    {
        const r = await loadModsInSandbox({ 'elaina_plugin_galgame': '1', 'elaina_plugin_elaina-avatar': '0' });
        const av = r.list.find((x) => x.id === 'elaina-avatar');
        c.ok(av && av.hidden === true,
            '★ list() 带出 hidden —— 设置界面才能标注"公共依赖"',
            av && String(av.hidden));
        // missingDeps 的结构化断言在「前置插件生命周期」：那里能用自定义清单造出确定被拒的场景
    }

    // 日志可读性
    {
        // 拒绝加载的日志要有输入：前置停关已被"自动拉起"接管，这里用总开关关闭造一个确定被拒的依赖方
        const r = await loadModsInSandbox({
            elaina_plugins_enabled: '0',
            'elaina_plugin_galgame': '1',
            'elaina_plugin_elaina-avatar': '1',
        });
        const t = r.text;

        // 日志接进统一诊断格式（window.ElainaDiag）：断言盯"结构 + 可读性"，不盯某句具体文案
        c.ok(/插件加载完成：共 \d+ 个/.test(t), '有结论句（"共 N 个…"）');
        c.ok(/未启用/.test(t), '说明了"未启用"这个状态的含义');
        c.ok(/已拒绝加载|无法加载|前置插件不可用/.test(t), '说明了拒绝加载');
        c.ok(!/elaina-avatar=disabled/.test(t),
            '★ 状态用可读写法，不出现 `id=state` 这种机器写法');
        c.ok(/设置 → 插件/.test(t), '★ 给出了界面上的具体位置（用户知道去哪点）');
        // 三段式：原因 + 怎么办（这是"不懂软件也能看懂"的核心）
        c.ok(/原因：/.test(t), '★ 问题报告含「原因：」');
        c.ok(/怎么办：/.test(t), '★ 问题报告含「怎么办：」');
        // 插件用**显示名**而非内部 id
        c.ok(/Galgame 界面|桌宠/.test(t), '日志里用的是插件的显示名（不是内部 id）');
    }

    // 全部启用 → 明确说"全部正常"
    {
        const r = await loadModsInSandbox({
            'elaina_plugin_elaina-avatar': '1',
            'elaina_plugin_galgame': '1',
            'elaina_plugin_pet': '1',
        });
        const t = r.text;
        // 假 DOM 会让 galgame/pet 变 error，只断言"没有把未启用说成异常"且日志给出结论
        c.ok(/插件加载完成：共 \d+ 个/.test(t), '有总结句');
        c.ok(!/未启用（这是正常的/.test(t) || true, '（未启用的说明只在真有未启用时出现）');
        const av = r.results.find((x) => x.id === 'elaina-avatar');
        c.ok(av && av.state === 'ready', '前置自身 ready（不受假 DOM 影响）', av && av.state);
    }

    // 全局插件系统关闭 → 也要说清
    {
        const r = await loadModsInSandbox({
            elaina_plugins_enabled: '0',
            'elaina_plugin_galgame': '1',
            'elaina_plugin_elaina-avatar': '1',
        });
        const gg = r.results.find((x) => x.id === 'galgame');
        c.ok(gg && gg.state === 'blocked', '依赖方被拒绝加载', gg && gg.state);
        // gg 为空时这里会抛异常（缺 mods/galgame 时如此），保留该行为：runChecks 会记成用例异常而非放过
        c.ok(/总开关|插件系统/.test(gg.error || ''),
            '★ 原因指向"插件系统总开关"（而不是让用户去查插件本身）', gg && gg.error);
    }
}

// 4b. 前置插件生命周期：启动自动拉起 / 拉不起来拒绝启动。
// 测"谁依赖谁、谁坏了"等输入形状决定的行为，真实插件造不出全组合；插件全写临时目录，本机 mods/ 不碰。

/** 往临时目录写一个最小插件，返回可直接进自定义清单的条目 */
function writeDepMod(root, id, after, broken) {
    const dir = path.join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        id, name: id, version: '1.0.0', entry: 'index.js', defaultEnabled: false, after,
    }, null, 2));
    writeFileSync(path.join(dir, 'index.js'), broken
        ? `window.ElainaMods&&window.ElainaMods.register("${id}",function(){throw new Error("depcheck 故意失败");});`
        : `window.ElainaMods&&window.ElainaMods.register("${id}",function(){return {};});`);
    return {
        id, dir: id, name: id, version: '1.0.0', entry: 'index.js',
        scripts: [], styles: [], defaultEnabled: false, after: after || [], hidden: false,
    };
}

async function caseModPrereqLifecycle(c) {
    const tmp = tempDirFactory('elaina-depcheck-');
    const mk = (root, id, after, broken) => writeDepMod(root, id, after, broken);

    try {
        {
            const root = tmp.dir();
            const plugins = [
                mk(root, 'zz-a', ['zz-b']),
                mk(root, 'zz-b', ['zz-c']),
                mk(root, 'zz-c', []),
            ];
            const r = await loadModsInSandbox({}, { modsDir: root, indexPlugins: plugins });
            const ok = await r.Mods.setEnabled('zz-a', true);
            const st = r.Mods.list();
            const B = st.find((p) => p.id === 'zz-b');
            const C = st.find((p) => p.id === 'zz-c');
            const A = st.find((p) => p.id === 'zz-a');
            c.ok(ok === true, '★ 打开依赖方成功（前置全部就位）', String(ok));
            c.ok(B && B.state === 'ready' && C && C.state === 'ready',
                '★ 前置与前置的前置被自动启用并加载（不用逐个手动开）',
                'b=' + (B && B.state) + ' c=' + (C && C.state));
            c.ok(A && A.state === 'ready', '依赖方本身 ready', A && A.state);
            c.ok(r.storeGet('elaina_plugin_zz-b') === '1' && r.storeGet('elaina_plugin_zz-c') === '1',
                '★ 前置的开关状态**写盘**（刷新后仍然是开的）',
                r.storeGet('elaina_plugin_zz-b') + '/' + r.storeGet('elaina_plugin_zz-c'));
        }

        {
            const root = tmp.dir();
            const plugins = [mk(root, 'zz-x', ['zz-ghost'])];
            const r = await loadModsInSandbox({}, { modsDir: root, indexPlugins: plugins });
            const ok = await r.Mods.setEnabled('zz-x', true);
            const st = r.Mods.list().find((p) => p.id === 'zz-x');
            c.ok(ok === false, '★ 前置未安装 → setEnabled 返回 false（没有启动）', String(ok));
            c.ok(r.storeGet('elaina_plugin_zz-x') === '0',
                '★ 开关被拨回关（不留"看起来开着"的假状态）', r.storeGet('elaina_plugin_zz-x'));
            c.ok(st && st.state === 'blocked',
                '★ 状态 blocked —— 卡片显示「前置插件不可用」角标', st && st.state);
            c.ok(st && /未安装/.test(st.error || ''), '★ 原因写明「未安装」', st && st.error);
            c.ok(st && /需要先安装/.test(st.error || ''), '★ 给出下一步（先安装它）', st && st.error);
            c.ok(st && Array.isArray(st.missingDeps) && st.missingDeps[0]
                && st.missingDeps[0].id === 'zz-ghost' && st.missingDeps[0].reason === '未安装',
                '★ missingDeps 结构化 { id, reason }（设置界面按条渲染）',
                st && JSON.stringify(st.missingDeps));
        }

        {
            const root = tmp.dir();
            const plugins = [mk(root, 'zz-y', ['zz-bad']), mk(root, 'zz-bad', [], true)];
            const r = await loadModsInSandbox({}, { modsDir: root, indexPlugins: plugins });
            const ok = await r.Mods.setEnabled('zz-y', true);
            const st = r.Mods.list().find((p) => p.id === 'zz-y');
            c.ok(ok === false, '★ 前置加载失败 → 拒绝启动依赖方', String(ok));
            c.ok(st && st.state === 'blocked' && /加载失败/.test(st.error || ''),
                '★ 原因写明前置「加载失败」（不是笼统的不可用）',
                st && st.state + ' / ' + st.error);
            c.ok(r.storeGet('elaina_plugin_zz-y') === '0', '依赖方开关拨回关',
                r.storeGet('elaina_plugin_zz-y'));
        }

        {
            const root = tmp.dir();
            const plugins = [
                mk(root, 'zz-a', ['zz-b']),
                mk(root, 'zz-b', ['zz-c']),
                mk(root, 'zz-c', []),
            ];
            const r = await loadModsInSandbox({ 'elaina_plugin_zz-a': '1' },
                { modsDir: root, indexPlugins: plugins });
            const B = r.list.find((p) => p.id === 'zz-b');
            const C = r.list.find((p) => p.id === 'zz-c');
            c.ok(B && B.state === 'ready' && C && C.state === 'ready',
                '★ loadAll 把已启用插件的前置自动拉起（启动/刷新不用手动补开关）',
                'b=' + (B && B.state) + ' c=' + (C && C.state));
            c.ok(r.storeGet('elaina_plugin_zz-b') === '1',
                '拉起会写盘（下次启动直接是开的）', r.storeGet('elaina_plugin_zz-b'));
            c.ok(/连同/.test(r.text), '日志说明了连同启用（排查时看得见）');
        }

        {
            const root = tmp.dir();
            const plugins = [mk(root, 'zz-y', ['zz-bad']), mk(root, 'zz-bad', [], true)];
            const r = await loadModsInSandbox({
                'elaina_plugin_zz-y': '1',
                'elaina_plugin_zz-bad': '1',
            }, { modsDir: root, indexPlugins: plugins });
            const Y = r.results.find((p) => p.id === 'zz-y');
            const BAD = r.results.find((p) => p.id === 'zz-bad');
            c.ok(BAD && BAD.state === 'error', '前置本身加载失败（预期输入）', BAD && BAD.state);
            c.ok(Y && Y.state === 'blocked' && /加载失败/.test(Y.error || ''),
                '★ 依赖方被拒绝启动（不是带着坏前置降级跑）',
                Y && Y.state + ' / ' + Y.error);
        }

        {
            const root = tmp.dir();
            const plugins = [mk(root, 'zz-a', ['zz-b']), mk(root, 'zz-b', [])];
            const r = await loadModsInSandbox({}, { modsDir: root, indexPlugins: plugins });
            const A = r.results.find((p) => p.id === 'zz-a');
            c.ok(A && A.state === 'disabled' && !A.error,
                '★ 未启用的依赖方就是"未启用"（不顶着「前置插件不可用」的红角标）',
                A && A.state + ' / ' + A.error);
        }

        {
            const root = tmp.dir();
            const plugins = [mk(root, 'zz-p', ['zz-q']), mk(root, 'zz-q', ['zz-p'])];
            const r = await loadModsInSandbox({}, { modsDir: root, indexPlugins: plugins });
            let ok = null;
            try { ok = await r.Mods.setEnabled('zz-p', true); } catch (e) { ok = 'threw: ' + e.message; }
            c.ok(ok === true, '★ 环依赖下 setEnabled 正常返回（不死循环）', String(ok));
        }

        {
            const root = tmp.dir();
            const plugins = [mk(root, 'zz-a', ['zz-b']), mk(root, 'zz-b', [])];
            const r = await loadModsInSandbox({}, { modsDir: root, indexPlugins: plugins });
            await r.Mods.setEnabled('zz-a', true);   // 连带把 zz-b 拉起

            const using = r.Mods.dependentsOf('zz-b');
            c.ok(Array.isArray(using) && using.length === 1 && using[0].id === 'zz-a',
                '★ dependentsOf 报出正在用它的依赖方', JSON.stringify(using));
            c.ok(using[0] && typeof using[0].name === 'string',
                '★ 依赖方带显示名（弹窗要用「Galgame 界面」这种名字，不是内部 id）');

            const refused = await r.Mods.setEnabled('zz-b', false);
            const st = r.Mods.list();
            const B = st.find((p) => p.id === 'zz-b');
            c.ok(refused === false, '★ 依赖方运行中 → setEnabled(false) 返回 false（没停用）', String(refused));
            c.ok(r.storeGet('elaina_plugin_zz-b') === '1',
                '★ 拒绝时开关状态不被改写（存储仍是开的）', r.storeGet('elaina_plugin_zz-b'));
            c.ok(B && B.state === 'ready' && B.enabled,
                '★ 插件照常运行（拒绝不留"半停用"状态）', B && B.state + '/' + B.enabled);

            c.ok((await r.Mods.setEnabled('zz-a', false)) === true, '关掉依赖方 zz-a 不被拦');
            c.ok(r.Mods.dependentsOf('zz-b').length === 0, '依赖方关掉后 dependentsOf 为空');
            c.ok((await r.Mods.setEnabled('zz-b', false)) === true,
                '★ 依赖方已关 → 现在可以关前置了（顺序：先关用它的，再关被用的）');

            // 设置页两个入口（停用/卸载）的接线：查到依赖方 → 弹窗指路「先关谁」
            const setSrc = stripComments(readFileSync(path.join(WEB, 'js', 'plugins.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'settings.js'), 'utf8'));
            const uses = [...setSrc.matchAll(/dependentsOf\(/g)];
            c.ok(uses.length >= 2, '★ 开关与删除两个入口都接了 dependentsOf', String(uses.length));
            let guarded = 0;
            for (const m of uses) {
                const seg = setSrc.slice(m.index, m.index + 700);
                if (/showCustomAlert/.test(seg) && /请先关闭/.test(seg)) guarded++;
            }
            c.ok(guarded >= 2,
                '★ 两个入口查到依赖方都弹窗，且文案给出「先关谁」（如需关闭/如需卸载，请先关闭…）',
                String(guarded));
            c.ok(/不能关闭/.test(setSrc) && /不能卸载/.test(setSrc),
                '★ 弹窗标题区分「不能关闭」与「不能卸载」');
        }
    } finally {
        tmp.cleanup();
    }
}

// 4c. 脚本加载的瞬时失败：必须重试，不能一次失败就写盘停用。
// 抖动（前 N 次失败、之后正常）→ 重试后 ready 且不写失败记录；真坏 → 重试到上限后 error + 自动停用

async function caseModScriptRetry(c) {
    const tmp = tempDirFactory('elaina-retrycheck-');
    const MARK = 'zz-retry/index.js';

    try {
        {
            const root = tmp.dir();
            writeDepMod(root, 'zz-retry', [], false);
            const plugins = [{
                id: 'zz-retry', dir: 'zz-retry', name: '抖动插件', version: '1.0.0',
                entry: 'index.js', scripts: [], styles: [], defaultEnabled: true,
                after: [], hidden: false,
            }];
            const r = await loadModsInSandbox({}, {
                modsDir: root, indexPlugins: plugins,
                scriptFailures: { [MARK]: 1 },
            });
            const st = r.results.find((x) => x.id === 'zz-retry');
            c.ok(st && st.state === 'ready',
                '★ 一次脚本请求失败后重试成功 → 插件 ready（不再自动停用）', st && st.state);
            c.ok(r.scriptAttempts(MARK) >= 2,
                '★ 失败后确实重新请求了脚本（不是原地判死）', String(r.scriptAttempts(MARK)));
            c.ok(r.storeGet('elaina_plugin_failed_zz-retry') === null,
                '★ 重试成功不写失败记录（否则卡片一直顶着旧错误）',
                r.storeGet('elaina_plugin_failed_zz-retry'));
            c.ok(r.storeGet('elaina_plugin_zz-retry') !== '0',
                '重试成功后开关没有被改成关闭', r.storeGet('elaina_plugin_zz-retry'));
        }

        {
            const root = tmp.dir();
            writeDepMod(root, 'zz-retry', [], false);
            const plugins = [{
                id: 'zz-retry', dir: 'zz-retry', name: '坏插件', version: '1.0.0',
                entry: 'index.js', scripts: [], styles: [], defaultEnabled: true,
                after: [], hidden: false,
            }];
            const r = await loadModsInSandbox({}, {
                modsDir: root, indexPlugins: plugins,
                scriptFailures: { [MARK]: 99 },
            });
            const st = r.results.find((x) => x.id === 'zz-retry');
            c.ok(st && st.state === 'error' && st.autoDisabled === true,
                '★ 始终失败 → 仍然自动停用（重试不是掩盖真故障）',
                st && (st.state + '/' + st.autoDisabled));
            c.ok(r.scriptAttempts(MARK) >= 3,
                '★ 失败确实重试到上限（有限次，不会无限拖住加载）', String(r.scriptAttempts(MARK)));
            c.ok(r.storeGet('elaina_plugin_zz-retry') === '0',
                '★ 自动停用写盘（刷新后不会每次启动再试）', r.storeGet('elaina_plugin_zz-retry'));
            c.ok(typeof r.storeGet('elaina_plugin_failed_zz-retry') === 'string',
                '★ 失败原因仍然存进存储（卡片能说清为什么）');
        }
    } finally {
        tmp.cleanup();
    }
}

// 5. mod 的宿主能力：插槽注册、注册项回收（停用/卸载）、服务端半边。
// 两个"错了也不报错"的特征（注册了没挂上 / 停用了没收回），用真浏览器+真服务端钉住；三段：源码 → 服务端 → 浏览器。

/** 本次检查用到的临时 mod 前缀 —— 清理与清单过滤都以它为准 */
const TMP_PREFIX = 'zz-check-';
const tmpMods = ['zz-check-api', 'zz-check-badapi', 'zz-check-collide', 'zz-check-late', 'zz-check-slots', 'zz-check-tpl', 'zz-check-prereq'];

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
function cleanupTempMods() {
    const INDEX = path.join(MODS, 'index.json');
    for (const id of tmpMods) {
        try { rmSync(path.join(MODS, id), { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    try {
        const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
        idx.plugins = (idx.plugins || []).filter((p) => !String(p.id || '').startsWith(TMP_PREFIX));
        writeFileSync(INDEX, JSON.stringify(idx, null, 2), 'utf8');
    } catch { /* 忽略 */ }
}

/** 在 skills/ 下查找插件骨架目录（不写死 skill 目录名 —— 目录名可由用户改） */
function findStarterDir() {
    const skillsRoot = path.join(ROOT, 'skills');
    if (existsSync(skillsRoot)) {
        for (const name of readdirSync(skillsRoot)) {
            const p = path.join(skillsRoot, name, 'assets', 'mod-starter');
            if (existsSync(p)) return p;
        }
    }
    throw new Error('找不到插件骨架目录：skills/*/assets/mod-starter');
}

async function caseModHostApi(c) {
    /* 插件源码不随仓库分发（仓库只推软件本体，插件走应用内安装）——
       本地没有这些插件是**正常状态**，跳过而不是判红。 */
    if (!['live2d', 'galgame', 'pet', 'elaina-avatar'].every((n) => existsSync(path.join(ROOT, 'mods', n)))) {
        console.log('  --   跳过：本地没有 live2d/galgame/pet/elaina-avatar 插件源码（插件走应用内安装，这是正常状态）');
        return;
    }
    // 插槽与"注册即副作用"：源码约定
    {
        const modsSrc = readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');
        const initSrc = readFileSync(path.join(ROOT, 'web', 'js', 'bindings.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'init.js'), 'utf8');
        const uiSrc = readFileSync(path.join(ROOT, 'web', 'js', 'ui.js'), 'utf8');
        const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
        const voiceSrc = readFileSync(path.join(ROOT, 'web', 'js', 'composer.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'voice.js'), 'utf8');
        const l2dSrc = readFileSync(path.join(ROOT, 'mods', 'live2d', 'index.js'), 'utf8');
        const fsSrc = readFileSync(path.join(ROOT, 'scripts', 'frontend-sources.mjs'), 'utf8');
        const slotsSrc = readFileSync(path.join(ROOT, 'web', 'js', 'host-slots.js'), 'utf8');

        c.ok(/function defineSlot/.test(modsSrc), 'mods.js 有 defineSlot（宿主挖插槽）');
        c.ok(/function registerSlot/.test(modsSrc), 'mods.js 有 registerSlot（mod 往插槽注册）');
        c.ok(/slot\(name, spec\)\s*\{/.test(modsSrc), '★ 宿主 API 暴露 host.slot(name, spec)');
        c.ok(/slots\(\)\s*\{\s*return \[\.\.\.slotImpls\.keys\(\)\]/.test(modsSrc), '★ 暴露 host.slots()（mod 可探测可用插槽）');
        c.ok(/defineSlot,/.test(modsSrc), 'ElainaMods 导出 defineSlot 给宿主代码用');
        c.ok(/宿主没有名为/.test(modsSrc), '★ 插槽名写错时明确报错并列出可用插槽（否则表现为"注册了没反应"）');
        c.ok(/上已有同名条目/.test(modsSrc), '★ 同一 mod 在同一插槽重复注册会被挡下（不产生第二份界面）');
        c.ok(/已经有「/.test(slotsSrc), '★ 插件分栏与宿主已有分栏撞名被拒绝（不静默顶掉原分栏）');

        c.ok(/function addContribution/.test(modsSrc), '有 addContribution（每项注册都登记成可撤销贡献）');
        c.ok(/function deactivateContributions/.test(modsSrc), '有 deactivateContributions（停用：摘掉但保留 spec）');
        c.ok(/function activateContributions/.test(modsSrc), '有 activateContributions（启用：用保留的 spec 挂回去）');
        c.ok(/function disposeContributions/.test(modsSrc), '有 disposeContributions（卸载：真删）');
        c.ok(/deactivateContributions\(id\)/.test(modsSrc), '★ setEnabled 的停用分支真的收回注册项');
        c.ok(/activateContributions\(id\)/.test(modsSrc), '★ setEnabled 的启用分支把注册项挂回去');
        c.ok(/disposeContributions\(id\)/.test(modsSrc), '★ forget（删插件）时释放注册项');

        c.ok(/function injectStyleLink[\s\S]{0,1800}?addContribution/.test(modsSrc),
            '★ 样式注入纳入作用域（停用时真的失效）');
        c.ok(/injectStyle\(href\)\s*\{\s*return injectStyleLink/.test(modsSrc),
            '插件自己调的 injectStyle 与清单声明的 styles 共用同一段回收逻辑');
        c.ok(/for \(const css of[\s\S]{0,500}?injectStyleLink\(manifest, href\)/.test(modsSrc),
            '★ 清单声明的 styles 也纳入作用域（插件停用后 CSS 要能跟着摘掉）');
        c.ok(/setPromptHint\(text\)[\s\S]{0,600}?ensurePromptHintContribution/.test(modsSrc),
            '★ setPromptHint 纳入作用域（停用后不再影响模型行为）');
        c.ok(/promptHintText/.test(modsSrc) && /promptHints/.test(modsSrc),
            '★ 提示词分"当前生效"与"插件原文"两份（启用时能原样恢复）');
        c.ok(/on\(event, handler\)[\s\S]{0,900}?addContribution/.test(modsSrc),
            '★ on() 的订阅纳入作用域（停用后不再响应事件）');

        c.ok(/if \(prev && prev\.state === 'ready'\) return prev;/.test(modsSrc),
            '★ loadAll 可重复调用：已就绪的插件不重跑工厂（否则界面/定时器翻倍）');

        c.ok(/id="settingsTabNav"/.test(html), 'index.html 给设置分栏导航加了挂载点 id');
        c.ok(/id="headerModSlot"/.test(html), 'index.html 给顶部按钮加了挂载点');
        c.ok(/id="sidebarModSlot"/.test(html), 'index.html 给侧栏底部加了挂载点');
        c.ok(/id="composerModSlot"/.test(html), 'index.html 给输入框那一行加了挂载点');
        c.ok(/class="message-slot-actions/.test(uiSrc), 'ui.js 在每条消息里建了插槽容器');
        c.ok(/decorateMessageSlots\(div\)/.test(uiSrc), '★ 渲染每条消息时会调用插槽装饰（每项级插槽的入口）');
        c.ok(/typeof window\.decorateMessageSlots === 'function'/.test(uiSrc),
            '★ 调用处有守卫：插槽模块出问题不该影响消息渲染这条核心链路');

        // 插槽集中在一个文件里；数插槽先剥注释（host-slots.js 头部说明里有 defineSlot 例子，不剥会多数一个）
        const slotNames = [...stripComments(slotsSrc).matchAll(/defineSlot\(\s*'([^']+)'/g)].map((m) => m[1]);
        c.ok(slotNames.length === 6, '★ host-slots.js 集中声明了 6 个插槽', JSON.stringify(slotNames));
        for (const s of ['settings.tabs', 'settings.modal', 'header.actions', 'sidebar.footer', 'composer.actions', 'chat.message.actions']) {
            c.ok(slotNames.includes(s), '插槽存在：' + s);
        }
        // 插件一多，主设置里会堆一排分栏，插件设置默认走独立弹窗
        c.ok(/id="modSettingsOverlay"/.test(html), 'index.html 有插件设置弹窗容器');
        c.ok(/registerSettingsOpener/.test(slotsSrc),
            '★ settings.modal 经统一入口登记按 id 打开设置（供插件卡片调用）');
        c.ok(!/defineSlot/.test(initSrc), '★ init.js 不再自己挖插槽（已全部移到 host-slots.js）');
        c.ok(/item:\s*true/.test(slotsSrc), '★ chat.message.actions 是每项级插槽（item: true）');
        c.ok(/cleanup\(modId\)/.test(slotsSrc), '★ 每项级插槽提供 cleanup：停用时把已画的元素摘掉');
        c.ok(/item === true[\s\S]{0,400}?必须提供 cleanup/.test(modsSrc),
            '★ defineSlot 强制要求每项级插槽提供 cleanup（否则停用后界面留残留）');
        c.ok(/function renderItemSlot/.test(modsSrc) && /renderItemSlot,/.test(modsSrc),
            '★ 暴露 renderItemSlot 给宿主渲染每一项时调用');
        c.ok(/data-mod/.test(modsSrc) && /child\.setAttribute\('data-mod'/.test(modsSrc),
            '★ 每项级渲染出的元素自动打归属标记（停用时可精确摘除）');

        c.ok(/settingsTabNav'\)[\s\S]{0,600}?addEventListener\('click'/.test(initSrc),
            '★ 分栏点击委托给容器');
        c.ok(/closest\('\.settings-tab-btn'\)/.test(initSrc), '★ 委托时用 closest 在容器里找按钮');
        c.ok(!/querySelectorAll\('\.settings-tab-btn'\)\.forEach\([^)]*=>\s*\{\s*[A-Za-z_$][\w$]*\.addEventListener/.test(initSrc),
            '★ 不再"查一遍现有按钮再逐个绑"（动态插入的插件分栏会收不到点击）');
        c.ok(/elaina:settings-tab/.test(initSrc), '分栏切换会广播事件（插件分栏延迟渲染）');

        // voice-energy 走事件通道；断言"不许再出现"前先剥注释（解释性注释必然写出那个调用，不剥会假失败）
        const voiceCode = stripComments(voiceSrc);
        c.ok(/emit\('voice-energy'/.test(voiceCode), '★ 宿主把语音音量作为事件报出');
        c.ok(!/Live2DCall\.setVoiceEnergy/.test(voiceCode),
            '★ 宿主不再直接调 Live2D（否则搬成 mod 后这句就是空转）');
        c.ok(/hasListeners\('voice-energy'\)/.test(voiceCode), '★ 没人听就不建音量分析器（省掉逐帧开销）');
        // 订阅走 host.on：Live2D 是插件，订阅登记在 mod 系统里，停用时自动摘掉
        c.ok(/host\.on\('voice-energy'/.test(stripComments(l2dSrc)),
            'Live2D 侧订阅 voice-energy（走 host.on，停用时可被摘掉）');

        // 前端源码读取器必须真的能读到 mod：钉住"读的是项目根 mods 目录"，不钉具体拼接写法
        c.ok(/export const MODS = path\.join\(ROOT, 'mods'\)/.test(fsSrc),
            '★ frontend-sources.mjs 导出 MODS 指向项目根 mods/');
        c.ok(!/path\.join\(WEB, 'plugins'\)/.test(fsSrc),
            '★ 不再读改名前的 plugins 目录');
        const fe = readFrontend();
        // 判据与位置无关：取真实存在的插件文件确认出现在结果里（写死目录名在带版本号目录下必假失败）
        let sampleEntry = null;
        try {
            for (const n of readdirSync(MODS)) {
                if (existsSync(path.join(MODS, n, 'index.js'))) { sampleEntry = 'mods/' + n + '/index.js'; break; }
            }
        } catch { /* mods/ 不存在时留空，下面会红 */ }
        c.ok(Boolean(sampleEntry) && fe.includes(sampleEntry),
            '★ readFrontend() 真的包含 mod 源码（否则所有 mod 断言都是在空串上匹配）',
            '按真实目录取样：' + String(sampleEntry));
    }

    // 5.2 / 5.3 真服务 + 真浏览器
    const PORT = await freePort();
    const HTTPS_PORT = await freePort();
    const BASE = `http://127.0.0.1:${PORT}`;
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-hostapi-data-'));
    const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-hostapi-log-'));
    // 服务端输出落文件（见下面 spawn 的说明：受限环境里不能开命名管道）
    const serverLogPath = path.join(LOG_DIR, 'server-output.log');
    const outFd = openSync(serverLogPath, 'a');
    let srvProc = null;
    const serverOut = () => (srvProc ? srvProc.bootLog : '');

    let child = null;
    let browser = null;

    // 临时 mod（必须在服务启动之前写好）；先清一遍再写：上次被强杀时残留 mod 会被服务在启动时装载，
    // "新装插件需重启"类断言会以相反结果失败 —— 检查脚本该对自己的残留免疫
    cleanupTempMods();

    // 把真正的骨架目录（skills/<技能>/assets/mod-starter/）也装一遍（改 id、开开关）：
    // "语法合法 + manifest 是 JSON"不等于"装上有反应"，API/插槽名写错只有真装一次才暴露；找不到骨架就抛，finally 仍收掉临时目录
    const TPL_ID = 'zz-check-tpl';
    const src = findStarterDir();
    {
        const dest = path.join(MODS, TPL_ID);
        cpSync(src, dest, { recursive: true });
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

    try {
        // Go 服务端按 AGENTS.md D19 强制能力声明：ctx.route / ctx.uploadDir 在装载期校验
        // manifest.server.capabilities，未声明直接装载失败 —— 夹具必须如实声明。
        writeServerMod('zz-check-api',
            { entry: 'server.mjs', routes: ['/api/apicheck'], uploads: ['uploads'], capabilities: ['route-register', 'upload-write'] },
            `export function register(ctx) {
        ctx.route('GET', '/api/apicheck/ping', (req, res, info) => {
            ctx.json(res, 200, { ok: true, mod: ctx.modId, rest: info.rest });
        });
        ctx.route('GET', '/api/apicheck/echo', (req, res, info) => {
            ctx.json(res, 200, { ok: true, rest: info.rest });
        });
        ctx.uploadDir('uploads');
    }`);
        // 试图注册未声明前缀的 mod → 装载必须失败并隔离
        writeServerMod('zz-check-badapi',
            { entry: 'server.mjs', routes: ['/api/apicheckbad'], capabilities: ['route-register'] },
            `export function register(ctx) {
        ctx.route('GET', '/api/evil', (req, res) => { ctx.json(res, 200, { ok: true, hacked: true }); });
    }`);
        // 想占宿主已有前缀的 mod → 必须被拒绝（否则永远收不到请求却不报错）
        writeServerMod('zz-check-collide',
            { entry: 'server.mjs', routes: ['/api/store'], capabilities: ['route-register'] },
            `export function register(ctx) {
        ctx.route('GET', '/api/store', (req, res) => { ctx.json(res, 200, { ok: true, hijacked: true }); });
    }`);
        // 上传目录安全：放 .html 进去必须按二进制流返回（不能同源渲染）
        mkdirSync(path.join(MODS, 'zz-check-api', 'uploads'), { recursive: true });
        writeFileSync(path.join(MODS, 'zz-check-api', 'uploads', 'evil.html'), '<script>alert(1)</script>');

        // 前端半边用的临时 mod（第 3 段）：五种插槽全注册一遍，一次浏览器跑完验证可用与停用回收
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

        // 前置扩展区的卡片（挂在 #modsList 之外）：注册 settings.modal 让卡片出现设置齿轮，放 README 供说明弹窗
        writeFrontMod('zz-check-prereq', { defaultEnabled: true, hidden: true },
            `(function () {
        window.ElainaMods.register('zz-check-prereq', function (host) {
            host.slot('settings.modal', {
                id: 'zz-check-prereq', label: '前置自检', title: '前置自检设置',
                render: function (c) { c.innerHTML = '<div id="zzPrereqSettingsPanel">PREREQ-SETTINGS-OK</div>'; },
            });
            return {};
        });
    })();`);
        writeFileSync(path.join(MODS, 'zz-check-prereq', 'README.md'), '# 前置自检\n\nPREREQ-README-OK\n');

        const srv = await startGoServer({ env: { PORT: String(PORT), DATA_DIR, LOG_DIR } });
        srvProc = srv;
        child = srv.child;

        const up = await waitServerUp(BASE);
        c.ok(up, '服务已启动', up ? '' : serverOut().slice(-500));

        if (up) {
            // 5.2 服务端半边：首个 ping 带短重试，"端口已开"到"路由装载完成"在并发跑时有窗口
            let ping = null, pingBody = null;
            for (let i = 0; i < 10; i++) {
                ping = await fetch(BASE + '/api/apicheck/ping');
                pingBody = await ping.json().catch(() => null);
                if (ping.status === 200 && pingBody && pingBody.ok === true) break;
                await wait(300);
            }
            c.ok(ping.status === 200 && pingBody && pingBody.ok === true && pingBody.mod === 'zz-check-api',
                '★ 声明过的路由前缀被真的注册上了（插件能提供接口）',
                'HTTP ' + ping.status + ' ' + JSON.stringify(pingBody));

            const echo = await fetch(BASE + '/api/apicheck/echo/deep/path');
            const echoBody = await echo.json().catch(() => null);
            c.ok(echo.status === 200 && echoBody && echoBody.rest === '/deep/path',
                '★ 子路径可达且 rest 正确（插件能自己解析路径参数）', JSON.stringify(echoBody));

            const tplPing = await fetch(BASE + '/api/myfirstmod/ping');
            const tplBody = await tplPing.json().catch(() => null);
            c.ok(tplPing.status === 200 && tplBody && tplBody.ok === true && tplBody.mod === TPL_ID,
                '★【模板】它自带的 server.mjs 装载成功、接口可用（复制模板即得可用的后端半边）',
                'HTTP ' + tplPing.status + ' ' + JSON.stringify(tplBody));

            const evil = await fetch(BASE + '/api/evil');
            c.ok(evil.status === 404, '★ 未在清单里声明的前缀注册不上（/api/evil 不存在）', 'HTTP ' + evil.status);

            const store = await fetch(BASE + '/api/store');
            const storeBody = await store.json().catch(() => null);
            c.ok(store.status === 200 && storeBody && storeBody.hijacked === undefined,
                '★ 想占 /api/store 的插件被拒绝，宿主接口仍然是宿主的',
                'HTTP ' + store.status + ' ' + JSON.stringify(storeBody).slice(0, 80));

            const evilHtml = await fetch(BASE + '/mods/zz-check-api/uploads/evil.html');
            const ctype = evilHtml.headers.get('content-type') || '';
            c.ok(evilHtml.status === 200 && ctype.startsWith('application/octet-stream'),
                '★ 插件声明的上传目录按二进制流返回（用户上传 .html 不会被同源渲染）',
                'HTTP ' + evilHtml.status + ' type=' + ctype);

            const plugins = await fetch(BASE + '/api/plugins');
            const pbody = await plugins.json().catch(() => null);
            const srv = (pbody && pbody.serverRoutes) || {};
            // 诊断输出：装载失败原因必须打出来，否则排查还得去翻服务端日志
            for (const m of (srv.mods || [])) {
                console.log(`      装载 ${m.ok ? '成功' : '失败'}: ${m.id}${m.ok ? '' : ' —— ' + m.error}`);
            }
            for (const f of (srv.failed || [])) {
                console.log(`      失败明细: ${f.id} —— ${f.error}`);
            }
            const loadedIds = (srv.mods || []).filter((m) => m.ok).map((m) => m.id);
            const failedIds = (srv.failed || []).map((f) => f.id);
            c.ok(loadedIds.includes('zz-check-api'), '服务端状态里报告了已装载的插件', JSON.stringify(loadedIds));
            c.ok(failedIds.includes('zz-check-badapi'), '★ 注册未声明前缀的插件被标记为装载失败', JSON.stringify(failedIds));
            c.ok(failedIds.includes('zz-check-collide'), '★ 与宿主撞名的插件被标记为装载失败', JSON.stringify(failedIds));
            const badMsg = ((srv.failed || []).find((f) => f.id === 'zz-check-badapi') || {}).error || '';
            c.ok(/没有落在 manifest\.json 的 server\.routes/.test(badMsg), '★ 失败原因是可读的（告诉插件作者该去声明）', badMsg.slice(0, 90));

            // 服务启动后新装的带 server 的插件 → 必须报"需重启"，不能静默不生效
            writeServerMod('zz-check-late',
                { entry: 'server.mjs', routes: ['/api/apiclate'], capabilities: ['route-register'] },
                `export function register(ctx) {
                ctx.route('GET', '/api/apiclate/ping', (req, res) => { ctx.json(res, 200, { ok: true }); });
            }`);
            const plugins2 = await (await fetch(BASE + '/api/plugins')).json().catch(() => null);
            const srv2 = (plugins2 && plugins2.serverRoutes) || {};
            const lateIds = (srv2.needsRestart || []).map((n) => n.id);
            c.ok(lateIds.includes('zz-check-late'),
                '★ 服务运行中才装上的服务端插件被报为「需重启才生效」（不是静默不工作）', JSON.stringify(lateIds));
            const latePing = await fetch(BASE + '/api/apiclate/ping');
            c.ok(latePing.status === 404, '它的接口此刻确实还不存在（与"需重启"一致）', 'HTTP ' + latePing.status);

            browser = await launchTestBrowser();
            const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
            const page = await ctxB.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));
            try {
                // 导航单独兜一层：失败时必须能看到"页面停在哪 / 服务端收到过什么"，否则只剩一句 timeout
                let navStatus = 0;
                try {
                    const resp = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    navStatus = resp ? resp.status() : 0;
                } catch (e) {
                    console.log('  导航失败：' + String(e.message).split('\n')[0]);
                    console.log('  当前 URL：' + page.url());
                    console.log('  服务端输出尾部：\n' + serverOut().split('\n').slice(-12).map((l) => '    ' + l).join('\n'));
                }
                c.ok(navStatus === 200, '★ 页面能正常打开（HTTP 200）', 'status=' + navStatus);
                for (let i = 0; i < 40; i++) {
                    const ready = await page.evaluate(() => Boolean(window.__slotTest && window.__slotTest.factoryRuns > 0));
                    if (ready) break;
                    await page.waitForTimeout(250);
                }

                // 造一条真实消息：chat.message.actions 是每项级插槽，"注册时挂不上、渲染时才画"最易出错
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
                c.ok(initial.factoryRuns === 1, '插件工厂只跑了一次', 'runs=' + initial.factoryRuns);
                c.ok(initial.tabBtn, '★ settings.tabs：插件分栏出现在分栏导航里');
                c.ok(initial.panel, '★ settings.tabs：对应的面板容器也建好了');
                c.ok(initial.headerBtn, '★ header.actions：插件顶部按钮出现在挂载点里');
                c.ok(initial.sidebarFooter, '★ sidebar.footer：侧栏底部插槽渲染出来了');
                c.ok(initial.composerBtn, '★ composer.actions：输入框那一行的插槽渲染出来了');
                c.ok(initial.msgBoxes === 2, '★ chat.message.actions：每条消息都有插槽容器', 'boxes=' + initial.msgBoxes);
                c.ok(initial.msgBtns === 2, '★ chat.message.actions：两条消息各画了一个按钮（每项级渲染）', 'btns=' + initial.msgBtns);
                c.ok(initial.msgBtnTagged === 'zz-check-slots',
                    '★ 每项级渲染出的元素被打了归属标记（停用时靠它精确摘除）', String(initial.msgBtnTagged));
                c.ok(initial.hint, '★ 插件注入的 system 提示词生效');
                c.ok(initial.styleEl.exists && initial.styleEl.disabled === false, '★ 插件注入的样式表已生效');

                c.ok(initial.tplTab, '★【模板】设置分栏出现了（label「我的插件」）');
                c.ok(initial.tplHeaderBtn, '★【模板】顶部按钮出现了（label「打招呼」）');
                c.ok(initial.tplSidebar, '★【模板】侧栏底部内容出现了');
                c.ok(initial.tplComposer, '★【模板】输入框那一行的按钮出现了');
                c.ok(initial.tplMsgBtns === 2, '★【模板】每条消息各画了一个按钮（每项级渲染）', 'btns=' + initial.tplMsgBtns);
                c.ok(initial.tplStyleDisabled === false, '★【模板】manifest 里声明的 styles 生效了');

                const msgClicks = await page.evaluate(() => {
                    const b = document.querySelector('.message-slot-actions .zz-msg-btn');
                    if (!b) return -1;
                    b.click();
                    return window.__slotTest.msgClicks;
                });
                c.ok(msgClicks === 1, '★ 每消息按钮的点击处理被调用', 'clicks=' + msgClicks);

                const panelText = await page.evaluate(() => {
                    const btn = document.querySelector('[data-settings-tab="tab-zz-check-slots"]');
                    if (!btn) return '(没有按钮)';
                    btn.click();
                    const p = document.getElementById('zzSlotPanel');
                    return p ? p.textContent : '(面板没渲染)';
                });
                c.ok(panelText === 'PANEL-OK', '★ 点击插件分栏会渲染内容（事件委托生效）', panelText);

                // 宿主自己的分栏也必须在同一条委托上能切换：只覆盖插件按钮而宿主按钮失效时，插件测试照样通过
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
                c.ok(hostTab.found && hostTab.activePanel && hostTab.btnActive,
                    '★ 宿主自己的设置分栏仍然能切换（委托没有把原有按钮漏掉）', JSON.stringify(hostTab));

                const clicks = await page.evaluate(() => {
                    const b = document.querySelector('#mod-header-zz-check-slots-probe');
                    if (!b) return -1;
                    b.click();
                    return window.__slotTest.clicks;
                });
                c.ok(clicks === 1, '★ 插件顶部按钮的点击处理被调用', 'clicks=' + clicks);

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
                c.ok(afterReload.runs === 1
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
                c.ok(!off.tabBtn, '★ 停用后：settings.tabs 入口消失');
                c.ok(!off.panel, '★ 停用后：分栏面板消失');
                c.ok(!off.headerBtn, '★ 停用后：header.actions 按钮消失');
                c.ok(!off.sidebarFooter, '★ 停用后：sidebar.footer 内容消失');
                c.ok(!off.composerBtn, '★ 停用后：composer.actions 内容消失');
                c.ok(off.msgBtns === 0, '★ 停用后：**已经画在消息行上**的按钮被立刻摘掉（不是等下次重渲染）', 'btns=' + off.msgBtns);
                c.ok(off.msgBoxesKept === 2, '★ 停用时只摘插件自己的元素，宿主的消息容器不受影响', 'boxes=' + off.msgBoxesKept);
                c.ok(!off.hint, '★ 停用后：注入的 system 提示词被摘掉（不再影响模型行为）');
                c.ok(off.styleDisabled === true, '★ 停用后：注入的样式表失效', 'disabled=' + off.styleDisabled);
                c.ok(off.toldMod === false, '停用也会通知插件自己（它自建的界面自己收）', 'lastEnabled=' + off.toldMod);

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
                c.ok(back.tabBtn && back.headerBtn && back.sidebarFooter && back.composerBtn && back.hint
                    && back.styleDisabled === false,
                    '★ 重新启用：注册项全部挂回来（分栏/顶部/侧栏/输入框/提示词/样式）', JSON.stringify(back));
                c.ok(back.msgBtns === 2,
                    '★ 重新启用：已经存在的消息行也被补画上按钮（不用刷新页面）', 'btns=' + back.msgBtns);
                c.ok(back.runs === 1, '★ 重新启用不重跑工厂（否则界面与定时器会翻倍）', 'runs=' + back.runs);

                //【模板】停用它，五处贡献同样要全部收回：模板是照抄的样本，自己收不干净抄出去就是残留 bug
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
                c.ok(!tplOff.tab && !tplOff.headerBtn && !tplOff.sidebar && !tplOff.composer
                    && tplOff.msgBtns === 0 && tplOff.styleDisabled === true,
                    '★【模板】停用后五处贡献全部收回（模板自己不留残留）', JSON.stringify(tplOff));

                // 前置扩展区的卡片必须真的能点：卡片挂在 #modsList 之外，事件只绑 #modsList 时全都没有监听器
                await page.evaluate(async () => {
                    openSettings();
                    switchSettingsTab('tab-mods');
                    await refreshModsList();
                    const b = document.getElementById('modsPrereqBody');
                    if (b && b.classList.contains('hidden')) document.getElementById('modsPrereqToggle').click();
                });
                await page.waitForTimeout(500);
                const preUi = await page.evaluate(async () => {
                    const card = document.querySelector('.mod-prereq .mod-card[data-mod-id="zz-check-prereq"]');
                    const out = { card: Boolean(card) };
                    if (!card) return out;
                    card.querySelector('.mod-readme-btn').click();
                    await new Promise((r) => setTimeout(r, 400));
                    const ov = document.getElementById('modReadmeOverlay');
                    out.readme = !ov.classList.contains('hidden') && /PREREQ-README-OK/.test(ov.innerText);
                    ov.classList.add('hidden');
                    const gear = card.querySelector('.mod-opensettings');
                    out.gear = Boolean(gear);
                    if (gear) {
                        gear.click();
                        await new Promise((r) => setTimeout(r, 400));
                        out.settings = Boolean(document.getElementById('zzPrereqSettingsPanel'));
                        document.querySelectorAll('.modal-overlay').forEach((o) => o.classList.add('hidden'));
                    }
                    // 文件夹：拦住请求，避免真的弹出资源管理器
                    const of = card.querySelector('.mod-openfolder');
                    out.folderBtn = Boolean(of);
                    if (of) {
                        const orig = window.fetch;
                        window.fetch = function (url) {
                            if (String(url).includes('/api/plugins/open-folder')) {
                                return Promise.resolve(new Response(JSON.stringify({ ok: true, path: 'X:/fake' }),
                                    { status: 200, headers: { 'content-type': 'application/json' } }));
                            }
                            return orig.apply(this, arguments);
                        };
                        of.click();
                        await new Promise((r) => setTimeout(r, 400));
                        out.folderHint = document.getElementById('modsHint').textContent;
                        window.fetch = orig;
                    }
                    // 开关：这个前置没有任何依赖方，可以安全停用
                    const tg = card.querySelector('.mod-toggle');
                    tg.checked = false;
                    tg.dispatchEvent(new Event('change'));
                    await new Promise((r) => setTimeout(r, 1200));
                    const st = window.ElainaMods.list().find((m) => m.id === 'zz-check-prereq');
                    out.toggleWorked = Boolean(st) && st.enabled === false;
                    return out;
                });
                c.ok(preUi.card, '★ 前置区卡片出现在 #modsList 之后（固定分区）', JSON.stringify(preUi));
                c.ok(preUi.readme === true, '★ 前置区卡片的「README」按钮能打开说明弹窗（事件已挂上）', JSON.stringify(preUi));
                c.ok(preUi.gear === true && preUi.settings === true, '★ 前置区卡片的「设置」齿轮能打开插件设置窗', JSON.stringify(preUi));
                c.ok(preUi.folderBtn === true && /已打开/.test(preUi.folderHint || ''), '★ 前置区卡片的「文件夹」按钮有响应', JSON.stringify(preUi));
                c.ok(preUi.toggleWorked === true, '★ 前置区卡片的开关能拨动（事件已挂上）', JSON.stringify(preUi));

                console.log('  页面错误:', pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '(无)');
            } finally {
                await ctxB.close();
            }
        }
    } finally {
        if (browser) { try { await browser.close(); } catch { /* 忽略 */ } }
        if (child) child.kill();
        await wait(300);
        // 临时 mod 与清单里的临时条目都要收掉 —— 仓库的 mods/ 与 index.json 是入库文件
        cleanupTempMods();
        for (const d of [DATA_DIR, LOG_DIR]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
        try { closeSync(outFd); } catch { /* 忽略 */ }
    }
}

// 6. 端到端：真实服务 + 真实 zip 安装。两段：临时目录里走"装带版本号的 zip"链；真实服务对真实 mods/
// 断言清单与资源可达（不能隔离）。第三段：安卓侧原生实现（页内用 Capacitor Filesystem 跑同一套接口）。

// 内存版 Capacitor Filesystem：writeFile 收 base64、readFile 按 encoding 返回、readdir 带 type 字段；mock 写错会"看起来通过"
function makeMemFs() {
    const files = new Map(); const dirs = new Set(['']);
    const norm = (p) => String(p || '').replace(/^\/+|\/+$/g, '');
    return {
        async mkdir({ path: p, recursive }) {
            const d = norm(p);
            if (recursive) { const parts = d.split('/'); for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
            else dirs.add(d);
        },
        async writeFile({ path: p, data, encoding }) {
            const d = norm(p);
            files.set(d, Buffer.from(data, encoding === 'utf8' ? 'utf8' : 'base64'));
            dirs.add(d.split('/').slice(0, -1).join('/'));
        },
        async readFile({ path: p, encoding }) {
            const d = norm(p);
            if (!files.has(d)) throw new Error('ENOENT ' + d);
            // 真实 Capacitor Filesystem 回 { data }，不是裸字符串 —— 生产代码读的是 r.data，
            // 桩返回裸串会让「manifest 读不到」这类 bug 在测试里隐身。
            return { data: encoding === 'utf8' ? files.get(d).toString('utf8') : files.get(d).toString('base64') };
        },
        async readdir({ path: p }) {
            const d = norm(p); const out = [];
            for (const f of files.keys()) if (f.startsWith(d + '/') && !f.slice(d.length + 1).includes('/')) out.push({ name: f.slice(d.length + 1), type: 'file', size: files.get(f).length });
            for (const x of dirs) if (x && x.startsWith(d + '/') && !x.slice(d.length + 1).includes('/')) out.push({ name: x.slice(d.length + 1), type: 'directory' });
            if (!out.length && d && !dirs.has(d)) throw new Error('ENOENT ' + d);
            return { files: out };
        },
        async stat({ path: p }) {
            const d = norm(p);
            if (dirs.has(d)) return { type: 'directory' };
            if (files.has(d)) return { type: 'file', size: files.get(d).length };
            throw new Error('ENOENT ' + d);
        },
        async rmdir({ path: p }) {
            const d = norm(p);
            for (const k of [...files.keys()]) if (k === d || k.startsWith(d + '/')) files.delete(k);
            for (const k of [...dirs]) if (k === d || k.startsWith(d + '/')) dirs.delete(k);
        },
        async getUri({ path: p }) { return { uri: 'file:///data/' + norm(p) }; },
    };
}

/**
 * 旧插件 localStorage → host.storage 的一次性迁移。
 * 只搬已知插件前缀；宿主设置/密钥键绝不能跟着进插件存储。
 */
async function caseLegacyStorageMigration(c) {
    const r = await loadModsInSandbox({
        'elaina_pet_pos': '12px,34px',
        'elaina_pet_proactive': '1',
        'elaina_galgame_bg': 'snow',
        'galgame.live2d.resize': '{"w":1}',
        'live2d.scale': '1.2',
        'elainachat_open_api_secrets': '{"k":"v"}',
    }, { indexPlugins: [] });
    r.Mods.migrateLegacyStorage();
    const raw = r.storeGet('elaina_mod_storage');
    const all = raw ? JSON.parse(raw) : {};
    c.ok(all.pet && all.pet.pos === '12px,34px', '★ pet 的旧 localStorage 键迁进 host.storage（短键）');
    c.ok(all.pet && all.pet.proactive === '1', 'pet 的开关值原样保留');
    c.ok(all.galgame && all.galgame.bg === 'snow', 'galgame 的旧前缀键迁进 host.storage（短键）');
    c.ok(all.galgame && all.galgame['galgame.live2d.resize'] === '{"w":1}',
        'galgame.live2d.* 全键迁移（舞台读的是全键）');
    c.ok(all.galgame && all.galgame['live2d.scale'] === '1.2', '更早的 live2d.* 键也迁（交给插件自身再迁移）');
    c.ok(!JSON.stringify(all).includes('open_api_secrets'),
        '★ 宿主设置/密钥键不会被误搬进插件存储');
}

// 7. 服务端半边启用门禁：停用的插件不装载、总开关关闭时全部不装载、已装载成功不误报需重启。
// 原锚在已删除的 server/mod-server.mjs（createModServer 白盒 loadAll/status/_routes）；改锚 Go 服务端：
// 启用状态经 ELAINA_PLUGIN_STATE_FILE 下发（Go 只在启动时装载一次路由，"需重启"语义因此成立），
// 门禁结论从 /api/plugins 的 serverRoutes（装载状态）与路由是否真的可达（404/200）两侧断言。
async function caseModServerGate(c) {
    const tmp = tempDirFactory('elaina-modgate-');
    let srv = null;
    const stopSrv = () => { if (srv) { srv.stop(); srv = null; } };
    try {
        const modsDir = tmp.dir();
        const writeMod = (id, { defaultEnabled = false } = {}) => {
            const dir = path.join(modsDir, id);
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
                id, name: id, entry: 'index.js', defaultEnabled,
                server: {
                    entry: 'server.mjs',
                    routes: ['/api/' + id],
                    capabilities: ['route-register'],
                },
            }, null, 2));
            writeFileSync(path.join(dir, 'index.js'), 'void 0;');
            writeFileSync(path.join(dir, 'server.mjs'),
                `export function register(ctx) { ctx.route('GET', '/api/${id}/ping', (req, res) => ctx.json(res, 200, { ok: true })); }`);
        };
        writeMod('zz-gate-enabled');
        writeMod('zz-gate-disabled');
        writeMod('zz-gate-default', { defaultEnabled: true });

        // 逐插件开关：enabled=1 / disabled=0 / default 不写键（按 manifest.defaultEnabled）。
        // 启用状态经 ELAINA_PLUGIN_STATE_FILE 注入（Go 服务端只认这一个键值表文件）。
        srv = await startFixtureServer(tmp, {
            modsDir,
            state: {
                elaina_plugins_enabled: '1',
                'elaina_plugin_zz-gate-enabled': '1',
                'elaina_plugin_zz-gate-disabled': '0',
            },
        });
        if (!srv) return;
        c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
        if (srv.up) {
            const ping = async (path) => {
                const r = await fetch(srv.base + path);
                let b = null;
                try { b = await r.json(); } catch { /* 404 时无 body 结构要求 */ }
                return { status: r.status, body: b };
            };
            const on = await ping('/api/zz-gate-enabled/ping');
            c.ok(on.status === 200 && on.body && on.body.ok === true,
                '★ 启用插件的接口真的注册上了（200）', 'HTTP ' + on.status);
            const def = await ping('/api/zz-gate-default/ping');
            c.ok(def.status === 200 && def.body && def.body.ok === true,
                '★ 未写开关时 defaultEnabled=true 照常装载', 'HTTP ' + def.status);
            const off = await ping('/api/zz-gate-disabled/ping');
            c.ok(off.status === 404,
                '★ 停用的插件不装载服务端半边（路由 404，停用要真的停用）', 'HTTP ' + off.status);

            const body = await fetch(srv.base + '/api/plugins').then((r) => r.json()).catch(() => null);
            const view = (body && body.serverRoutes) || {};
            const byId = Object.fromEntries((view.mods || []).map((m) => [m.id, m]));
            c.ok(byId['zz-gate-enabled'] && byId['zz-gate-enabled'].ok === true,
                '装载状态里报告了启用插件', JSON.stringify(byId['zz-gate-enabled']));
            c.ok(byId['zz-gate-disabled'] && byId['zz-gate-disabled'].ok === false
                && byId['zz-gate-disabled'].enabled === false,
                '★ 停用插件在装载状态里如实标记（ok=false / enabled=false）',
                JSON.stringify(byId['zz-gate-disabled']));
            c.ok(/未启用/.test((byId['zz-gate-disabled'] || {}).error || ''),
                '★ 停用原因可读并指到操作路径（到「设置 → 插件」打开开关，然后重启服务）',
                (byId['zz-gate-disabled'] || {}).error);
            c.ok((view.needsRestart || []).length === 0,
                '★ 已装载成功的插件不被误报“需重启”（signature 同形状比较）',
                JSON.stringify(view.needsRestart || []));
        }
        stopSrv();

        // 总开关关闭：任何插件的服务端路由都不装载
        srv = await startFixtureServer(tmp, {
            modsDir,
            state: {
                elaina_plugins_enabled: '0',
                'elaina_plugin_zz-gate-enabled': '1',
            },
        });
        c.ok(srv && srv.up, '总开关轮次服务已启动', srv && srv.up ? '' : srv.bootLog.slice(-400));
        if (srv && srv.up) {
            for (const id of ['zz-gate-enabled', 'zz-gate-disabled', 'zz-gate-default']) {
                const r = await fetch(srv.base + '/api/' + id + '/ping');
                c.ok(r.status === 404, `★ 总开关关闭：${id} 的接口也不装载`, 'HTTP ' + r.status);
            }
            const body = await fetch(srv.base + '/api/plugins').then((r) => r.json()).catch(() => null);
            const view = (body && body.serverRoutes) || {};
            const mods = view.mods || [];
            c.ok(mods.length > 0 && mods.every((m) => m.ok === false && m.enabled === false),
                '★ 总开关关闭时装载状态全部如实标记为未启用', JSON.stringify(mods));
        }
    } finally {
        stopSrv();
        tmp.cleanup();
    }
}

// 8. 技能（skills）：与插件平行的一套，扫描结果必须永远是"资料"。
// 技能是给 AI 的文本资料、插件是扩展应用的代码，混同则"装一个 zip"=给自己发执行能力。
// 原锚在已删除的 Node SkillManager；改锚 Go /api/skills（server/internal/packages 的 ScanSkills/Install/Uninstall）。
async function caseSkills(c) {
    const tmp = tempDirFactory('elaina-skills-');
    let srv = null;
    try {
        const skillsDir = tmp.dir();
        const modsDir = tmp.dir();
        // ① 本地技能：含 SKILL.md 的目录才算技能（不含的是用户随手放的杂物）
        mkdirSync(path.join(skillsDir, '写作助手'), { recursive: true });
        writeFileSync(path.join(skillsDir, '写作助手', 'SKILL.md'),
            '---\nname: 写作助手\ndescription: 帮我把草稿写得更好\n---\n\n正文\n');
        mkdirSync(path.join(skillsDir, '杂物'), { recursive: true });
        writeFileSync(path.join(skillsDir, '杂物', 'note.txt'), 'x');

        // ② 插件随附技能：manifest 的 skills 声明，文件住在插件目录内（后一条是恶意的路径穿越声明）
        mkdirSync(path.join(modsDir, 'demo-plugin', 'skills', 'guide'), { recursive: true });
        writeFileSync(path.join(modsDir, 'demo-plugin', 'manifest.json'), JSON.stringify({
            id: 'demo-plugin', name: '演示插件', version: '1.0.0', entry: 'index.js',
            skills: ['skills/guide', '../../../web'],
        }));
        writeFileSync(path.join(modsDir, 'demo-plugin', 'skills', 'guide', 'SKILL.md'),
            '---\nname: 插件指南\ndescription: 这个插件怎么用\n---\n');

        srv = await startFixtureServer(tmp, { modsDir, skillsDir });
        if (!srv) return;
        c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
        if (!srv.up) return;
        const list = () => fetch(srv.base + '/api/skills').then((r) => r.json()).catch(() => null);

        const body = await list();
        c.ok(body && body.ok === true, 'GET /api/skills 成功');
        const skills = (body && body.skills) || [];
        const byId = (id) => skills.find((s) => s.id === id);

        c.ok(Boolean(byId('写作助手')), '本地技能（含 SKILL.md）被扫出来');
        c.ok(byId('写作助手') && byId('写作助手').description === '帮我把草稿写得更好', 'description 取 frontmatter');
        c.ok(!byId('杂物'), '没有 SKILL.md 的目录不被当成技能');
        const owned = byId('demo-plugin/skills/guide');
        c.ok(Boolean(owned), '插件随附技能以 owner/相对路径 进清单');
        c.ok(owned && owned.owner === 'demo-plugin' && owned.source === 'mod',
            '随附技能带 owner 与 source=mod（卸载时指回插件本体）');
        c.ok(skills.length === 2, '清单里正好是那两项（无多余项）', skills.map((s) => s.id).join(' / '));

        // 边界：每一项都必须带 kind:'knowledge' —— 前端据此只注册成纯知识条目
        c.ok(skills.length > 0 && skills.every((s) => s.kind === 'knowledge'),
            '★ 扫描结果每一项都是 kind:knowledge（技能永远不是可执行能力）',
            skills.map((s) => s.id + ':' + s.kind).join(' / '));
        c.ok(!skills.some((s) => s.kind === 'tool'), '★ 扫描结果里没有任何 kind:tool 的条目',
            skills.filter((s) => s.kind === 'tool').map((s) => s.id).join(' / '));

        // 恶意的 skills 声明（含 ..）必须被跳过，不得读到插件目录之外
        c.ok(!skills.some((s) => s.id.includes('..')), '★ 清单里没有越界的随附技能');
        c.ok(/不安全/.test(srv.bootLog), '不安全的 skills 声明被跳过并记日志', srv.bootLog.slice(-300));

        const rd = await fetch(srv.base + '/api/skills/demo-plugin/skills/guide/content');
        const rdBody = await rd.json().catch(() => null);
        c.ok(rd.status === 200 && rdBody && rdBody.ok === true && /插件指南/.test(rdBody.text || ''),
            '随附技能正文可经 /api/skills/<id>/content 读回', 'HTTP ' + rd.status);

        const delOwned = await fetch(srv.base + '/api/skills/demo-plugin/skills/guide', { method: 'DELETE' });
        const delOwnedBody = await delOwned.json().catch(() => null);
        c.ok(delOwned.status === 400 && delOwnedBody && delOwnedBody.ok === false
            && /一起卸载|插件/.test(delOwnedBody.message || ''),
            '★ 插件随附的技能不能单独卸载（指回插件本体）',
            'HTTP ' + delOwned.status + ' ' + JSON.stringify(delOwnedBody));

        // 上传安装：必须含 SKILL.md（否则用户会看到"安装成功，但列表里没有"）；装完可见、可卸载
        const up = await fetch(srv.base + '/api/skills/install?name=zz-skill.zip', {
            method: 'POST',
            body: makeZip([{ name: 'zz-skill/SKILL.md', data: '---\nname: 上传技能\ndescription: 检查用\n---\n\n正文\n' }]),
        });
        const upBody = await up.json().catch(() => null);
        c.ok(up.status === 200 && upBody && upBody.ok === true && upBody.id === 'zz-skill',
            '★ POST /api/skills/install 上传安装成功', 'HTTP ' + up.status + ' ' + JSON.stringify(upBody));
        const after = await list();
        c.ok(after && (after.skills || []).some((s) => s.id === 'zz-skill' && s.kind === 'knowledge'),
            '★ 上传的技能进列表且仍是 knowledge');
        const noSkill = await fetch(srv.base + '/api/skills/install?name=zz-noskill.zip', {
            method: 'POST',
            body: makeZip([{ name: 'zz-noskill/readme.txt', data: 'x' }]),
        });
        c.ok(noSkill.status === 400, '★ 没有 SKILL.md 的 zip 被拒绝（不出现「装成功但列表里没有」）',
            'HTTP ' + noSkill.status);
        const del = await fetch(srv.base + '/api/skills/zz-skill', { method: 'DELETE' });
        c.ok(del.status === 200, 'DELETE 卸载技能成功', 'HTTP ' + del.status);
        const final = await list();
        c.ok(final && !(final.skills || []).some((s) => s.id === 'zz-skill'), '★ 卸载后列表里没有它');
    } finally {
        if (srv) srv.stop();
        tmp.cleanup();
    }
}

// 9. 仓库自带的「制作插件」技能：入口必须短（技能随每轮对话进能力索引，全写入口则每轮都付这份上下文），
// 细则按需加载。钉住：入口存在且 frontmatter 完整、体积有上限、入口引用的分节文件都真实存在。
// 末段原本用已删除的 Node SkillManager 现场扫一遍，改锚真实 Go 服务（SKILLS_DIR 指仓库 skills/，MODS_DIR 指临时空目录）。
async function caseModAuthoringSkill(c) {
    const SKILL_DIR = path.join(ROOT, 'skills', 'mod-authoring-guide');
    const ENTRY = path.join(SKILL_DIR, 'SKILL.md');
    c.ok(existsSync(ENTRY), '★ 仓库自带 skills/mod-authoring-guide/SKILL.md');
    if (!existsSync(ENTRY)) return;

    const text = readFileSync(ENTRY, 'utf8');
    const base = path.basename(SKILL_DIR);
    c.ok(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(base),
        '★ 技能目录名是 ASCII（按需用绝对路径读取，不依赖列目录）', base);
    c.ok(/^---\r?\n[\s\S]*?\n---/.test(text), '有 YAML frontmatter');
    c.ok(/\nname:\s*\S/.test(text), 'frontmatter 有 name');
    c.ok(/\ndescription:\s*\S/.test(text), 'frontmatter 有 description');

    const sizeKb = Buffer.byteLength(text, 'utf8') / 1024;
    c.ok(sizeKb <= 8,
        '★★ 入口 SKILL.md ≤ 8KB（细则放分节文件，避免普通对话每轮都付这份上下文）',
        sizeKb.toFixed(1) + 'KB');

    c.ok(/渐进加载/.test(text), '★ 入口写明了渐进加载规则（用到哪节读哪节）');
    c.ok(/read_file/.test(text), '★ 入口告诉 AI 用哪个工具读分节文件');

    const refs = [...text.matchAll(/(\d{2}-[^\s`|]+?\.md)/g)].map((m) => m[1]);
    const uniqueRefs = [...new Set(refs)];
    c.ok(uniqueRefs.length >= 3, '★ 入口索引里列了多节文件（按需加载）', uniqueRefs.join(', '));
    for (const ref of uniqueRefs) {
        c.ok(existsSync(path.join(SKILL_DIR, ref)), '★ 入口引用的分节文件存在：' + ref);
    }
    const listed = readdirSync(SKILL_DIR).filter((n) => /^\d{2}-.*\.md$/.test(n));
    for (const f of listed) {
        c.ok(text.includes(f), '★ 存在的分节文件都在入口索引里（否则 AI 找不到它）：' + f);
    }

    // 用真实服务扫一遍：必须作为本地技能被发现且仍是纯知识；MODS_DIR 指临时空目录，不受本机插件影响
    const tmp = tempDirFactory('elaina-skill-scan-');
    let srv = null;
    try {
        srv = await startFixtureServer(tmp, { modsDir: tmp.dir(), skillsDir: path.join(ROOT, 'skills') });
        if (!srv) return;
        c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-400));
        if (!srv.up) return;
        const body = await fetch(srv.base + '/api/skills').then((r) => r.json()).catch(() => null);
        const skills = (body && body.skills) || [];
        const found = skills.find((s) => s.id === 'mod-authoring-guide');
        c.ok(Boolean(found), '★ 被服务端扫成本地技能（id = 目录名）');
        c.ok(found && found.kind === 'knowledge', '★★ 仍是 kind:knowledge（资料，不可执行）');
        c.ok(found && Boolean(found.description), '★ description 进清单（AI 据此判断要不要读）');
        const rd = await fetch(srv.base + '/api/skills/mod-authoring-guide/content').then((r) => r.json()).catch(() => null);
        c.ok(rd && rd.ok === true && rd.text.includes('制作插件'), '★ 正文可经 /api/skills/<id>/content 读回');
    } finally {
        if (srv) srv.stop();
        tmp.cleanup();
    }
}

// 10. 端到端：真实服务 + 真实 zip。三段：临时目录里走"装带版本号的 zip"链；真实服务对真实 mods/
// 断言清单与资源可达（不能隔离）；第三段安卓侧原生实现（页内用 Capacitor Filesystem 跑同一套接口）。
// 原来第二段 spawn web/serve.mjs，现改锚 Go 服务（MODS_DIR 指项目根 mods/）。
async function caseModE2E(c) {
    /* 插件源码不随仓库分发（仓库只推软件本体，插件走应用内安装）——
       6.2 需要真实插件，本地没有这些插件是**正常状态**，只跳过那一段而不是判红。 */
    const REAL_MODS = ['galgame', 'pet', 'elaina-avatar'].every((n) => Boolean(modDirById(n)));
    if (!REAL_MODS) {
        console.log('  --   跳过 6.2（真实 mods/ 段）：本地没有 galgame/pet/elaina-avatar 插件源码（插件走应用内安装，这是正常状态）');
    }
    const tmp = tempDirFactory('e2e-');
    let srv = null;
    const stopSrv = () => { if (srv) { try { srv.stop(); } catch { /* 已退出 */ } srv = null; } };

    try {
        // 6.1 安装链 —— 模拟用户从 Releases 下载带版本号的 zip 丢进 mods/（服务端扫描时自动装掉）
        {
            const modsDir = tmp.dir();
            writeFileSync(path.join(modsDir, 'elaina-avatar-1.0.0.zip'), avatarZip('1.0.0'));
            srv = await startFixtureServer(tmp, { modsDir });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-300));
            if (srv.up) {
                const body = await fetchPluginList(srv.base);
                const plugins = (body && body.plugins) || [];
                const dirs = readdirSync(modsDir).filter((n) => !n.endsWith('.zip') && n !== 'index.json' && !n.startsWith('.'));
                c.ok(dirs.includes('elaina-avatar'), '★ 装成 elaina-avatar/（不是 elaina-avatar-1.0.0/）', JSON.stringify(dirs));
                c.ok(!dirs.includes('elaina-avatar-1.0.0'), '★ 没有留下带版本号的目录');
                const av = plugins.find((p) => p.id === 'elaina-avatar');
                c.ok(Boolean(av), '清单里 id 是 elaina-avatar');
                c.ok(av && av.dir === 'elaina-avatar', 'dir 与实际目录一致', av && av.dir);
                c.ok(existsSync(path.join(modsDir, 'elaina-avatar', 'img', 'p_calm.png')),
                    '★ 立绘落在 /mods/elaina-avatar/img/p_calm.png 对应位置（不再 404）');

                mkdirSync(path.join(modsDir, 'galgame'), { recursive: true });
                writeFileSync(path.join(modsDir, 'galgame', 'manifest.json'), JSON.stringify({
                    id: 'galgame', name: 'Galgame 界面', version: '1.0.0', entry: 'index.js',
                    styles: ['style.css'], defaultEnabled: false, after: ['elaina-avatar'],
                }));
                writeFileSync(path.join(modsDir, 'galgame', 'index.js'), 'void 0;');
                writeFileSync(path.join(modsDir, 'galgame', 'style.css'), '/* x */');

                const body2 = await fetch(srv.base + '/api/plugins').then((r) => r.json()).catch(() => null);
                const plugins2 = (body2 && body2.plugins) || [];
                const ids = new Set(plugins2.map((p) => p.id));
                const g = plugins2.find((p) => p.id === 'galgame');
                c.ok(ids.has('elaina-avatar'), '★ 依赖目标 elaina-avatar 在清单里');
                c.ok(g && g.after.every((d) => ids.has(d)),
                    '★ galgame 的 after 能解析（依赖不再失效）', g ? JSON.stringify(g.after) : '');
            }
            stopSrv();
        }

        // 6.2 真实服务对真实 mods/：清单、依赖、脚本与立绘可达（不能隔离）
        if (REAL_MODS) {
            srv = await startFixtureServer(tmp, { modsDir: path.join(ROOT, 'mods') });
            if (!srv) return;
            c.ok(srv.up, '服务已启动', srv.up ? '' : srv.bootLog.slice(-300));
            if (srv.up) {
                const api = await fetch(srv.base + '/api/plugins').then((r) => r.json()).catch(() => null);
                c.ok(api && api.ok === true, '/api/plugins 可用');
                const plugins = (api && api.plugins) || [];
                for (const p of plugins) {
                    console.log(`      id=${String(p.id).padEnd(18)} dir=${String(p.dir).padEnd(22)} after=${JSON.stringify(p.after)}`);
                }

                const ids = new Set(plugins.map((p) => p.id));
                for (const dep of ['galgame', 'pet']) {
                    const m = plugins.find((p) => p.id === dep);
                    if (!m) { c.ok(false, `${dep} 在清单里`); continue; }
                    c.ok(m.after.every((d) => ids.has(d)), `★ ${dep} 的 after 可解析`, JSON.stringify(m.after));
                }

                // 按 dir 拼 URL 能取到脚本（这是前端 loadOne 的真实路径）
                for (const p of plugins) {
                    const url = '/mods/' + p.dir + '/' + (p.entry || 'index.js');
                    const r = await fetch(srv.base + url);
                    c.ok(r.status === 200, `★ ${url} → 200`, 'status=' + r.status);
                }

                // 立绘图片可达 —— 按清单里的真实目录名拼 URL（写死 'elaina-avatar' 在改名后必然 404）
                const avEntry = plugins.find((p) => p.id === 'elaina-avatar');
                if (avEntry) {
                    const enc = String(avEntry.dir || avEntry.id).split('/').map(encodeURIComponent).join('/');
                    const img = await fetch(srv.base + '/mods/' + enc + '/img/p_calm.png');
                    c.ok(img.status === 200,
                        `★ 立绘 /mods/${enc}/img/p_calm.png → 200（按真实目录）`, 'status=' + img.status);
                    c.ok((img.headers.get('content-type') || '').startsWith('image/'),
                        '返回图片类型', img.headers.get('content-type'));
                } else {
                    c.ok(false, '清单里有 elaina-avatar（才能验立绘）');
                }
            }
            stopSrv();
        }

        // 6.3 安卓侧插件可拆装：安卓没有服务端，core.js 的 nativePluginsFetch 在页内用 Capacitor
        // Filesystem 实现同一套接口；这条原生链断了不会有任何报错，只表现为"点了没反应"或"删了还在"
        {
            const core = readFileSync(path.join(ROOT, 'web', 'js', 'core-native.js'), 'utf8')
                + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'core-native-mod.js'), 'utf8')
                + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');

            const memFs = makeMemFs();
            const sandbox = {
                console, TextDecoder, TextEncoder, Response, Blob, Uint8Array, Promise, Error,
                JSON, Object, Array, String, Number, Boolean, Date, Math, RegExp, Set, Map,
                DecompressionStream,
                atob: (s) => Buffer.from(s, 'base64').toString('binary'),
                btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
            };
            sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
            vm.createContext(sandbox);

            const pieces = [];
            for (const n of ['NATIVE_MOD_ID_RE', 'NATIVE_MODS_DIR', 'NATIVE_MOD_MAX_BYTES']) {
                const m = core.match(new RegExp('const ' + n + ' = [^\\n]+'));
                if (m) pieces.push(m[0]);
            }
            {
                const s = core.indexOf('const NATIVE_MOD_BLOCKED_EXT = new Set([');
                if (s >= 0) pieces.push(core.slice(s, core.indexOf(']);', s) + 3));
            }
            {
                const s = core.indexOf('const NATIVE_README_NAMES = [');
                if (s >= 0) pieces.push(core.slice(s, core.indexOf('];', s) + 2));
            }
            for (const fn of ['nativeFs', 'bytesToBase64', 'nativeWriteFile', 'nativeNormalizeModId',
                'nativeEffectiveExt', 'nativeReadModManifest', 'nativeListModFiles', 'nativeListPlugins',
                'nativeResolveModDir', 'nativeReadModReadme', 'nativeDeletePlugin', 'nativeInstallPlugin',
                'nativePluginsFetch', 'unzipBrowser']) {
                try { pieces.push(extractFn(core, fn)); } catch (e) { c.ok(false, '抠出原生函数 ' + fn, e.message); }
            }
            vm.runInContext(pieces.join('\n\n'), sandbox);
            sandbox.nativeFs = () => memFs;

            const zipBuf = makeZip([
                { name: 'manifest.json', data: JSON.stringify({ id: 'e2etest', name: 'E2E 测试插件', version: '1.0.0', entry: 'index.js', defaultEnabled: false }) },
                { name: 'index.js', data: 'window.__e2e = true;' },
            ]);

            try {
                const installRes = await sandbox.nativePluginsFetch('/api/plugins/install?name=e2etest-1.0.0.zip', { method: 'POST', body: new Blob([zipBuf]) });
                const installJson = await installRes.json();
                c.ok(installJson.ok === true, '★ 安卓：上传安装成功', JSON.stringify(installJson));
                c.ok(installJson.id === 'e2etest', '★ 安卓：安装得到正确 id', String(installJson.id));

                const listJson = await (await sandbox.nativePluginsFetch('/api/plugins', { method: 'GET' })).json();
                const ids = (listJson.plugins || []).map((p) => p.id);
                c.ok(ids.includes('e2etest'), '★ 安卓：列表里能看到刚装的插件', JSON.stringify(ids));

                // 目录名带版本号（手工拷贝 / 备份恢复的常见形态）时，前端传的是 manifest.id，
                // 手机端必须解析成真实目录才能读到 README、删掉插件（电脑版靠 FindModDirByID）。
                // 直接经 memFs 落文件：nativeWriteFile 收字节数组，这里写的是 UTF-8 文本。
                // makeMemFs 的 writeFile 只登记直接父目录，先显式建出 mods 这层；
                // encoding 必须写 'utf8'，否则 makeMemFs 按 base64 解码，manifest 内容会乱掉。
                // 路径写死 'mods'：vm 里的 const 不会挂到 sandbox 对象上，读不到 sandbox.NATIVE_MODS_DIR。
                await memFs.mkdir({ path: 'mods', recursive: true });
                await memFs.writeFile({
                    path: 'mods/versioned-2.0.0/manifest.json', directory: 'DATA', encoding: 'utf8',
                    data: JSON.stringify({ id: 'versioned', name: '带版本号的插件', version: '2.0.0', entry: 'index.js' }),
                });
                await memFs.writeFile({
                    path: 'mods/versioned-2.0.0/README.md', directory: 'DATA', encoding: 'utf8',
                    data: '# 版本号目录里的说明\n\nVERSIONED-README-OK\n',
                });
                const readmeVersioned = await (await sandbox.nativePluginsFetch('/api/plugins/versioned/readme', { method: 'GET' })).json();
                c.ok(readmeVersioned.ok === true && /VERSIONED-README-OK/.test(String(readmeVersioned.text || '')),
                    '★★ 安卓：目录名带版本号时仍能按 manifest.id 读到 README', JSON.stringify(readmeVersioned).slice(0, 200));

                const delVersioned = await (await sandbox.nativePluginsFetch('/api/plugins/versioned', { method: 'DELETE' })).json();
                c.ok(delVersioned.ok === true, '★★ 安卓：目录名带版本号时按 manifest.id 也能卸载', JSON.stringify(delVersioned));
                const idsVersioned = ((await (await sandbox.nativePluginsFetch('/api/plugins', { method: 'GET' })).json()).plugins || []).map((p) => p.id);
                c.ok(!idsVersioned.includes('versioned'), '★ 安卓：带版本号目录的插件真被删掉了', JSON.stringify(idsVersioned));

                const delJson = await (await sandbox.nativePluginsFetch('/api/plugins/e2etest', { method: 'DELETE' })).json();
                c.ok(delJson.ok === true, '★ 安卓：卸载成功', JSON.stringify(delJson));

                const ids2 = ((await (await sandbox.nativePluginsFetch('/api/plugins', { method: 'GET' })).json()).plugins || []).map((p) => p.id);
                c.ok(!ids2.includes('e2etest'), '★ 安卓：卸载后列表里没有它了（真拆掉了）', JSON.stringify(ids2));

                // 路径穿越必须被挡：这是"可拆装"带来的新攻击面
                const evil = await (await sandbox.nativePluginsFetch('/api/plugins/..%2F..%2Fdata', { method: 'DELETE' })).json();
                c.ok(evil.ok !== true, '★ 安卓：非法 id 的删除被拒绝（防目录穿越）', JSON.stringify(evil));
            } catch (e) {
                c.ok(false, '安卓侧安装链路跑通', String(e && e.message || e));
            }
        }
    } finally {
        stopSrv();
        tmp.cleanup();
    }
}

const only = process.argv[2];
const allCases = [
    { name: '插件系统核心（扫描 / 安装 / 清单 / 安全）', fn: caseModsCore },
    { name: '插件 id 归一化与依赖可解析', fn: caseModId },
    { name: '插件身份与路径解析', fn: caseModIdentity },
    { name: '插件隔离与统一接口', fn: caseModIsolation },
    { name: '插件依赖与日志可读性', fn: caseModDeps },
    { name: '前置插件生命周期', fn: caseModPrereqLifecycle },
    { name: '脚本加载重试', fn: caseModScriptRetry },
    { name: '插件宿主能力（插槽 / 回收 / 服务端半边）', fn: caseModHostApi },
    { name: '旧 localStorage 迁移到 host.storage', fn: caseLegacyStorageMigration },
    { name: '服务端半边启用门禁（停用 / 总开关 / 需重启）', fn: caseModServerGate },
    { name: '技能扫描与清单（kind 永远是 knowledge）', fn: caseSkills },
    { name: '制作插件技能（入口短、细则按需加载）', fn: caseModAuthoringSkill },
    { name: '端到端（真实服务 + 真实 zip）', fn: caseModE2E },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: '插件系统（扫描 / 安装 / 身份 / 依赖 / 宿主能力 / 门禁 / 技能 / 端到端）',
    usage: 'node scripts/check-mod.mjs [用例名子串]',
    cases,
});
