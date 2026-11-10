// 界面与表现相关回归检查：主题 / 日记 / 生日 / Live2D 资源 / 场景背景 / 内置模型列表。
// 每段用例在自己的函数作用域里跑，同名局部变量（ROOT / WEB / html / src）不会互相踩，失败信息形如「<用例名> :: <断言原文>」。
// 用法：node scripts/check-ui.mjs [用例名子串] —— 不带参数跑全部。

import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, statSync, mkdirSync, copyFileSync, writeFileSync, openSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFrontend, readHtmlAndStyles } from './frontend-sources.mjs';
import { launchTestBrowser } from './test-browser.mjs';
import { runChecks, ROOT, wait, waitServerUp, freePort } from './check-harness.mjs';
import { extractFunction as extractFnFrom, stripComments as stripCommentsOf } from './check-source.mjs';

const WEB = path.join(ROOT, 'web');
const MODS = path.join(ROOT, 'mods');

// 源码抽取与去注释统一来自 check-source.mjs（跳过字符串/注释的花括号配对）。

function modDirById(id) {
    let names = [];
    try { names = readdirSync(MODS); } catch { return null; }
    for (const n of names) {
        const mf = path.join(MODS, n, 'manifest.json');
        if (!existsSync(mf)) continue;
        try {
            const m = JSON.parse(readFileSync(mf, 'utf8'));
            if (m && m.id === id) return n;
        } catch { /* 忽略坏 manifest */ }
    }
    return existsSync(path.join(MODS, id, 'index.js')) ? id : null;
}

// Live2D 表情/动作的「解析 + 资源 URL 拼接」：URL 必须按真实清单拼（写死前缀会让资源全 404），所以切片抠出真实函数体在 Node 里跑真实清单，不复制逻辑、不依赖浏览器。

async function caseLive2dAssets(c) {
    /* 插件不随仓库分发（应用内上传安装），本地没有 mods/live2d 是正常状态，跳过而不是抛异常。 */
    if (!existsSync(path.join(MODS, 'live2d', 'index.js'))) {
        console.log('  --   跳过：本地没有 live2d 插件（插件不随仓库分发，这是正常状态）');
        return;
    }
    const src = readFileSync(path.join(MODS, 'live2d', 'index.js'), 'utf8');
    const extractFn = (name) => extractFnFrom(src, name, 'mods/live2d/index.js');

    function buildHarness({ exps = [], motions = [], known = true }) {
        return new Function(`
        const EXP_SYNONYM_GROUPS = [];
        const EXPRESSION_MAP = { happy: '星星眼', sad: '哭哭', blush: '脸红', dizzy: '晕晕眼' };
        const MOTION_MAP = { wave: '常规', bow: '前倾' };
        const currentModelExps = ${JSON.stringify(exps)};
        const currentModelMotions = ${JSON.stringify(motions)};
        const modelAssetListKnown = ${JSON.stringify(known)};
        function modelBaseUrl(name) { return '/live2d/models/' + encodeURIComponent(name) + '/'; }
        ${extractFn('modelAssetUrl')}
        ${extractFn('sanitizeAssetName')}
        ${extractFn('fuzzyMatchFileName')}
        ${extractFn('resolveExpressionFile')}
        ${extractFn('resolveMotionFile')}
        return { modelAssetUrl, sanitizeAssetName, fuzzyMatchFileName, resolveExpressionFile, resolveMotionFile };
    `)();
    }

    const check = (label, actual, expected) => {
        c.ok(actual === expected, label,
            actual === expected ? '' : 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected));
    };

    const EXPS = ['love.exp3.json', '兔兔贴纸.exp3.json', '脸红.exp3.json', '星星眼.exp3.json', '哭.exp3.json', '晕晕.exp3.json'];
    const MOTIONS = ['aidale.motion3.json', 'motions/chuipaopao.motion3.json', 'motions/idle.motion3.json', 'motions/自拍.motion3.json'];
    const L = buildHarness({ exps: EXPS, motions: MOTIONS, known: true });

    check('根目录中文表情 URL',
        L.modelAssetUrl('deepseek', '脸红.exp3.json'),
        '/live2d/models/deepseek/%E8%84%B8%E7%BA%A2.exp3.json');
    check('子目录动作 URL（路径分隔符不能被编码成 %2F）',
        L.modelAssetUrl('deepseek', 'motions/idle.motion3.json'),
        '/live2d/models/deepseek/motions/idle.motion3.json');
    check('子目录+中文动作 URL',
        L.modelAssetUrl('deepseek', 'motions/自拍.motion3.json'),
        '/live2d/models/deepseek/motions/%E8%87%AA%E6%8B%8D.motion3.json');
    check('模型名带非 ASCII（· 是 U+00B7）',
        L.modelAssetUrl('伊蕾娜·默认', 'LSS.model3.json'),
        '/live2d/models/%E4%BC%8A%E8%95%BE%E5%A8%9C%C2%B7%E9%BB%98%E8%AE%A4/LSS.model3.json');

    check('路径穿越被挡', L.sanitizeAssetName('../../x'), '');
    check('斜杠被挡', L.sanitizeAssetName('motions/idle'), '');
    check('正常名放行', L.sanitizeAssetName('脸红'), '脸红');

    check('精确名 -> 根目录表情', L.resolveExpressionFile('脸红'), '脸红');
    check('语义映射 happy -> 星星眼', L.resolveExpressionFile('happy'), '星星眼');
    check('语义映射 blush -> 脸红', L.resolveExpressionFile('blush'), '脸红');
    check('模糊匹配 兔兔 -> 兔兔贴纸', L.resolveExpressionFile('兔兔'), '兔兔贴纸');
    check('不存在的表情返回空串（不再发注定 404 的请求）', L.resolveExpressionFile('完全不存在的东西'), '');

    check('动作精确名 -> 根目录动作', L.resolveMotionFile('aidale'), 'aidale');
    check('动作名 -> motions/ 子目录', L.resolveMotionFile('idle'), 'motions/idle');
    check('语义映射 wave -> 常规（清单里没有 -> 空）', L.resolveMotionFile('wave'), '');

    check('表情解析结果拼 URL 后可用',
        L.modelAssetUrl('deepseek', L.resolveExpressionFile('脸红') + '.exp3.json'),
        '/live2d/models/deepseek/%E8%84%B8%E7%BA%A2.exp3.json');
    check('子目录动作解析结果拼 URL 后可用',
        L.modelAssetUrl('deepseek', L.resolveMotionFile('idle') + '.motion3.json'),
        '/live2d/models/deepseek/motions/idle.motion3.json');

    const E = buildHarness({ exps: [], motions: [], known: true });
    check('无表情模型：清单已知且为空 -> 放弃', E.resolveExpressionFile('脸红'), '');
    check('无动作模型：清单已知且为空 -> 放弃', E.resolveMotionFile('idle'), '');
}

// 模型列表的「服务端实现」与「Capacitor 原生实现」必须给出同样的结果：APK 里没有 Node 服务端，列表由 index.html 的 nativeLive2dFetch() 用 Capacitor Filesystem 自实现，两份同语义代码容易各改各的跑偏，所以抠出两边真实函数体深比对。

async function caseLive2dNativeList(c) {
    // 目录名可能带版本号（live2d-models-1.0.0），按 manifest.id 解析 —— 写死目录名会让这个用例在"插件装了但目录带版本"的环境里静默跳过。
    const modDir = modDirById('live2d-models');
    if (!modDir || !existsSync(path.join(MODS, modDir, 'server.mjs'))) {
        console.log('  --   跳过：本地没有 live2d-models 插件（插件不随仓库分发，这是正常状态）');
        return;
    }
    const MODELS_ROOT = path.join(MODS, modDir, 'models');
    if (!existsSync(MODELS_ROOT)) {
        console.log('  --   跳过：live2d-models 插件没有 models/ 目录（模型需单独安装，这是正常状态）');
        return;
    }

    const serveSrc = readFileSync(path.join(MODS, modDir, 'server.mjs'), 'utf8');
    const ctxStub = {
        json(res, status, obj) {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        },
    };
    const server = new Function('readdir', 'stat', 'path', 'MODELS_DIR', 'ctx', `
        ${extractFnFrom(serveSrc, 'collectModelFiles', 'live2d-models/server.mjs')}
        ${extractFnFrom(serveSrc, 'listModels', 'live2d-models/server.mjs')}
        return { listModels };
    `)(readdir, stat, path, MODELS_ROOT, ctxStub);

    const htmlSrc = readFrontend();
    /** Capacitor Filesystem 等价桩：path 相对应用数据目录，必须先剥掉 live2d/models 前缀再映射，否则拼出双重前缀、readdir 抛错被吞、原生实现返回空列表。 */
    const fsStub = {
        Directory: { Data: 'DATA' },
        async readdir({ path: p }) {
            const rel = String(p).replace(/^live2d\/models\/?/, '');
            const abs = rel ? path.join(MODELS_ROOT, rel) : MODELS_ROOT;
            const entries = await readdir(abs, { withFileTypes: true });
            return {
                files: entries.map((e) => ({
                    name: e.name,
                    type: e.isDirectory() ? 'directory' : 'file',
                    size: e.isDirectory() ? 0 : statSync(path.join(abs, e.name)).size,
                })),
            };
        },
    };
    const native = new Function('nativeFsStub', `
        ${extractFnFrom(htmlSrc, 'nativeCollectModelFiles', 'index.html')}
        ${extractFnFrom(htmlSrc, 'nativeWriteFile', 'index.html')}
        ${extractFnFrom(htmlSrc, 'bytesToBase64', 'index.html')}
        ${extractFnFrom(htmlSrc, 'unzipBrowser', 'index.html')}
        ${extractFnFrom(htmlSrc, 'nativeLive2dFetch', 'index.html')}
        function nativeFs() { return nativeFsStub; }
        return { nativeLive2dFetch };
    `)(fsStub);

    const resStub = { body: '', writeHead() {}, end(s) { this.body = s; } };
    await server.listModels(resStub);
    const serverModels = JSON.parse(resStub.body).models;

    const nativeResponse = await native.nativeLive2dFetch('/api/live2d/models', { method: 'GET' });
    const nativeModels = (await nativeResponse.json()).models;

    const norm = (list) => list
        .map((m) => ({ name: m.name, modelJson: m.modelJson, vtube: m.vtube ?? null, exps: m.exps, motions: m.motions }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const a = norm(serverModels);
    const b = norm(nativeModels);
    const same = JSON.stringify(a) === JSON.stringify(b);

    const check = (label, actual, expected) => {
        c.ok(actual === expected, label,
            actual === expected ? '' : 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected));
    };

    console.log('  服务端 listModels()      :', JSON.stringify(a.map((m) => [m.name, m.exps.length, m.motions.length])));
    console.log('  原生 nativeLive2dFetch() :', JSON.stringify(b.map((m) => [m.name, m.exps.length, m.motions.length])));

    check('两边模型数一致', b.length, a.length);
    check('两边结果逐字段深比对一致', same, true);

    const deepseek = a.find((m) => m.name === 'deepseek');
    const elaina = a.find((m) => m.name === '伊蕾娜·默认');
    check('deepseek 的 modelJson 取的是根目录下的', deepseek?.modelJson, 'c_0120.model3.json');
    check('deepseek 的 vtube 取的是根目录下的', deepseek?.vtube, 'c_0120.vtube.json');
    check('deepseek 表情数 > 40（根目录下的 exp3 被扫到）', (deepseek?.exps.length ?? 0) > 40, true);
    check('deepseek 动作包含 motions/ 子目录项',
        Boolean(deepseek?.motions.some((f) => f.startsWith('motions/'))), true);
    check('exps 是相对路径而非裸文件名（根目录项不带斜杠）',
        Boolean(deepseek?.exps.every((f) => !f.includes('/'))), true);
    check('伊蕾娜·默认 无表情无动作（模型本身没带，不是 bug）',
        `${elaina?.exps.length}/${elaina?.motions.length}`, '0/0');

    const missing = [];
    for (const m of a) {
        for (const rel of [...m.exps, ...m.motions]) {
            const abs = path.join(MODELS_ROOT, m.name, rel);
            try { statSync(abs); } catch { missing.push(`${m.name}/${rel}`); }
        }
    }
    check('清单里的每个表情/动作文件都真实存在', missing.length, 0);
    if (missing.length) console.log('  缺失:', missing);
}

// APK「内置模型识别不到」的根因：设置面板那条路要 await res.text()，而 nativeLive2dFetch 返回的假 Response 只有 json() 没有 text() → TypeError 被 catch 吞掉、列表静默为空（同一接口两条路径只炸一条）。

async function caseNativeResponse(c) {
    const html = readFrontend();

    {
        const fnStart = html.indexOf('async function nativeLive2dFetch(');
        const fnEnd = html.indexOf('return { ', fnStart) > 0 ? html.indexOf('return { ', fnStart) : html.length;
        const body = html.slice(fnStart, fnEnd);

        const bare = [...body.matchAll(/\{[^{}]*json:\s*async\s*\(\)\s*=>[^{}]*\}/g)]
            .map((m) => m[0])
            .filter((s) => !/text:/.test(s));
        const offenders = bare.filter((s) => !/makeRes/.test(s));
        c.ok(offenders.length === 0,
            '没有"只有 json() 没有 text()"的假 Response',
            offenders.length + ' 处: ' + offenders.slice(0, 2).join(' | '));

        c.ok(/text:\s*async\s*\(\)/.test(body), 'nativeLive2dFetch 里提供了 text()');
        c.ok(/const makeRes\s*=/.test(body), '用统一的 makeRes 构造响应（避免下次又漏一个）');
    }

    // 清单**可能不存在** —— `npm run sync:web:lite`（纯净版 APK）不打包模型，改走扩展包分发：lite 模式下 www/live2d/models 整个目录都不存在。
    const MANIFEST = path.join(ROOT, '..', 'android-app', 'www', 'live2d', 'models', 'manifest.json');
    const MODELS_DIR = path.join(ROOT, '..', 'android-app', 'www', 'live2d', 'models');
    const liteMode = !existsSync(MODELS_DIR);

    if (liteMode) {
        console.log('  [纯净版模式] 未打包 Live2D 模型，跳过"打包清单"相关断言');
        c.ok(!existsSync(MANIFEST), '纯净版：不含打包清单（符合预期）');
    }
    if (!liteMode) c.ok(existsSync(MANIFEST), '安卓工程里有 manifest.json');
    const manifestObj = existsSync(MANIFEST)
        ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
        : { models: [] };

    const fsMock = {
        files: new Map(),
        Directory: { Data: 'DATA' },
        async mkdir() {},
        async writeFile(o) { this.files.set(o.path, o.data); },
        async appendFile(o) { this.files.set(o.path, (this.files.get(o.path) || '') + o.data); },
        async readFile(o) { if (!this.files.has(o.path)) throw new Error('不存在'); return { data: this.files.get(o.path) }; },
        async readdir() { return { files: [] }; },
        async getUri() { return { uri: 'file:///data/x/live2d/models' }; },
    };

    const sandbox = {
        console,
        window: {},
        Capacitor: { convertFileSrc: (u) => 'https://localhost/_capacitor_file_' + u, Plugins: { Filesystem: fsMock } },
        IS_NATIVE_APP: true,
        nativeFs: () => fsMock,
        nativeModelRootReady: true,
        TextEncoder, TextDecoder, Uint8Array, Buffer, JSON, Number, String, Math, Object, Array, Error, Promise, Map, Set,
        setTimeout, clearTimeout,
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        fetch: async (url) => {
            const u = String(url).replace(/^https?:\/\/[^/]+/, '');
            if (u === '/live2d/models/manifest.json') {
                return { ok: true, status: 200, async json() { return manifestObj; }, async text() { return JSON.stringify(manifestObj); } };
            }
            return { ok: false, status: 404, async json() { return {}; }, async text() { return ''; } };
        },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    vm.runInContext([
        extractFnFrom(html, 'bundledManifestModels', 'index.html'),
        extractFnFrom(html, 'nativeCollectModelFiles', 'index.html'),
        extractFnFrom(html, 'nativeLive2dFetch', 'index.html'),
    ].filter(Boolean).join('\n\n'), sandbox);

    // 复刻设置面板的真实取法：readJsonSafe 的语义 = 先 text()，JSON.parse
    const settingPath = await vm.runInContext(`
        nativeLive2dFetch('/api/live2d/models', { method: 'GET' }).then(async (res) => {
            // 这就是 readJsonSafe 的第一步 —— 旧代码在这里抛 TypeError
            const text = await res.text();
            return { hasText: typeof text === 'string', parsed: JSON.parse(text) };
        })
    `, sandbox);

    c.ok(settingPath.hasText, 'res.text() 可用（旧代码在这里抛 TypeError）');
    const models = (settingPath.parsed && settingPath.parsed.models) || [];
    console.log('  设置面板这条路径拿到 ' + models.length + ' 个模型: ' + JSON.stringify(models.map((m) => m.name)));
    if (liteMode) {
        // 纯净版没有内置模型，断言会退化成 0 === 0（恒真、无检验力）—— 明确跳过
        console.log('  [纯净版模式] 无内置模型，跳过"列出全部内置模型"的计数断言');
    } else {
        c.ok(models.length === manifestObj.models.length,
            '设置面板能列出全部内置模型（这就是用户报的那个问题）',
            '期望 ' + manifestObj.models.length + '，实际 ' + models.length);
    }

    {
        const r = await vm.runInContext(`nativeLive2dFetch('/api/live2d/models', { method: 'GET' }).then(r => r.json())`, sandbox);
        const list = (r && r.models) || [];
        if (liteMode) {
            c.ok(Array.isArray(list), '纯净版：json() 路径仍返回数组（接口形状没坏）');
        } else {
            c.ok(list.length === manifestObj.models.length, 'json() 路径同样返回全部模型', String(list.length));
        }
    }

    {
        const r = await vm.runInContext(`
            nativeLive2dFetch('/api/live2d/nonexistent', { method: 'GET' }).then(async (res) => {
                let textOk = false;
                try { textOk = typeof (await res.text()) === 'string'; } catch (e) { textOk = false; }
                return { status: res.status, ok: res.ok, textOk };
            })
        `, sandbox);
        c.ok(r.status === 404, '未知接口返回 404');
        c.ok(r.ok === false, 'ok 为 false');
        c.ok(r.textOk, '404 响应也有 text()（readJsonSafe 对非 2xx 也要能读）');
    }

    {
        const fnStart = html.indexOf('async function nativeLive2dFetch(');
        const body = html.slice(fnStart, html.indexOf('// 字节 → base64', fnStart));
        const returns = [...body.matchAll(/return\s+(\{[\s\S]{0,120}?\};)/g)].map((m) => m[1]);
        const bad = returns.filter((r) => /json:\s*async/.test(r) && !/makeRes/.test(r));
        c.ok(bad.length === 0, '所有 return 的响应都走 makeRes/json', bad.slice(0, 2).join(' | '));
    }
}

// 场景背景资源包（scene-backgrounds）：img/bg/ 与 index.js 的 BGS 清单两处维护，不一致不会报错 —— 有图未登记则界面上选不到，登记无图则是裂图，两种现象都不指向"清单写错了"，排查易跑偏。

async function caseSceneBackgrounds(c) {
    const dir = modDirById('scene-backgrounds');
    if (!dir) {
        console.log('  --   跳过：本地没有 scene-backgrounds / galgame 插件（插件不随仓库分发，这是正常状态）');
        return;
    } else {
        c.ok(true, '找到 scene-backgrounds 插件（目录 ' + dir + '）');
        const indexSrc = readFileSync(path.join(MODS, dir, 'index.js'), 'utf8');
        const bgDir = path.join(MODS, dir, 'img', 'bg');

        const listed = [...indexSrc.matchAll(/\[\s*'([A-Za-z0-9_\-]+)'\s*,\s*'[^']*'\s*\]/g)].map((m) => m[1]);
        c.ok(listed.length >= 30, 'BGS 清单里有 ' + listed.length + ' 条（应 ≥30）');
        const dupList = listed.filter((x, i) => listed.indexOf(x) !== i);
        c.ok(dupList.length === 0, '清单里没有重复的文件名', JSON.stringify([...new Set(dupList)]));

        let files = [];
        try { files = readdirSync(bgDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)); } catch { /* 目录不存在 */ }
        c.ok(files.length > 0, 'img/bg/ 里有图片（' + files.length + ' 个）', bgDir);

        const fileBase = new Set(files.map((f) => f.replace(/\.(jpe?g|png|webp)$/i, '')));
        const listSet = new Set(listed);

        const missingFiles = listed.filter((n) => !fileBase.has(n));
        c.ok(missingFiles.length === 0,
            '★ 清单里每一项都有对应的图片文件（没有裂图）',
            missingFiles.length ? '缺文件：' + missingFiles.join('、') : '');

        const notListed = [...fileBase].filter((n) => !listSet.has(n));
        c.ok(notListed.length === 0,
            '★ img/bg/ 里每个文件都在清单里登记了（否则选不到）',
            notListed.length ? '未登记：' + notListed.join('、') : '');

        const labels = [...indexSrc.matchAll(/\[\s*'[A-Za-z0-9_\-]+'\s*,\s*'([^']*)'\s*\]/g)].map((m) => m[1]);
        const dupLabel = labels.filter((x, i) => x && labels.indexOf(x) !== i);
        c.ok(dupLabel.length === 0, '中文标签没有重复', JSON.stringify([...new Set(dupLabel)]));

        for (const fn of ['list', 'url', 'label', 'has', 'pick']) {
            const asFn = new RegExp('function\\s+' + fn + '\\s*\\(').test(indexSrc);
            const asConst = new RegExp('const\\s+' + fn + '\\s*=').test(indexSrc);
            c.ok(asFn || asConst, '提供 ' + fn + '()');
        }
        c.ok(/host\.assetBase/.test(indexSrc),
            '★ 用 host.assetBase() 取真实目录（不写死 /mods/scene-backgrounds/）');
        c.ok(/ElainaMods\.register\(/.test(indexSrc), '用 ElainaMods.register 注册');
    }

    {
        const galSrc = dir ? readFileSync(path.join(MODS, modDirById('galgame') || 'galgame', 'index.js'), 'utf8') : '';
        c.ok(/host\.require\('scene-backgrounds'\)/.test(galSrc),
            '★ galgame 通过 host.require 取背景（不自己拼路径）');
        const galMf = JSON.parse(readFileSync(path.join(MODS, modDirById('galgame') || 'galgame', 'manifest.json'), 'utf8'));
        c.ok(Array.isArray(galMf.after) && galMf.after.includes('scene-backgrounds'),
            '★ galgame 的 manifest.after 声明了 scene-backgrounds', JSON.stringify(galMf.after));

        const l2dDir = modDirById('live2d');
        if (l2dDir) {
            const l2dMf = JSON.parse(readFileSync(path.join(MODS, l2dDir, 'manifest.json'), 'utf8'));
            c.ok(!(Array.isArray(l2dMf.after) && l2dMf.after.includes('scene-backgrounds')),
                '★ live2d **不**声明依赖 scene-backgrounds（背景可选，不装也能用）',
                JSON.stringify(l2dMf.after));
            const l2dSrc = readFileSync(path.join(MODS, l2dDir, 'index.js'), 'utf8');
            c.ok(/ElainaSceneBackgrounds/.test(l2dSrc),
                '★ live2d 用全局接口取背景（运行期探测，资源包不在就降级）');
        }
        const galBg = path.join(MODS, modDirById('galgame') || 'galgame', 'img', 'bg');
        const stillThere = existsSync(galBg) ? readdirSync(galBg).filter((f) => /\.(jpe?g|png)$/i.test(f)) : [];
        c.ok(stillThere.length === 0, '★ galgame 下不再留背景图（避免两份重复占体积）',
            stillThere.length ? stillThere.length + ' 个残留' : '');
    }

    {
        const PORT = await freePort();
        const HTTPS_PORT = await freePort();
        const BASE = `http://127.0.0.1:${PORT}`;
        const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-bg-data-'));
        const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-bg-log-'));
        const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
            cwd: ROOT,
            env: {
                ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT),
                HOST: '127.0.0.1', DATA_DIR, LOG_DIR, LOG_TO_FILE: '0',
            },
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        try {
            const up = await waitServerUp(BASE);
            c.ok(up, '服务已启动');
            if (up) {
                const indexSrc = dir ? readFileSync(path.join(MODS, dir, 'index.js'), 'utf8') : '';
                const first = ([...indexSrc.matchAll(/\[\s*'([A-Za-z0-9_\-]+)'\s*,\s*'[^']*'\s*\]/g)][0] || [])[1];
                const realDir = dir || 'scene-backgrounds';
                const enc = realDir.split('/').map(encodeURIComponent).join('/');
                if (first) {
                    const r = await fetch(`${BASE}/mods/${enc}/img/bg/${first}.jpg`);
                    c.ok(r.status === 200, '★ 背景图可经静态服务访问（' + first + '.jpg）', 'HTTP ' + r.status);
                    const ct = r.headers.get('content-type') || '';
                    c.ok(ct.startsWith('image/'), '返回图片类型', ct);
                }
                const api = await (await fetch(BASE + '/api/plugins')).json().catch(() => null);
                const ids = (api && api.plugins || []).map((p) => p.id);
                c.ok(ids.includes('scene-backgrounds'), '插件清单里有 scene-backgrounds', JSON.stringify(ids));
            }
        } finally {
            child.kill();
            await wait(300);
            for (const d of [DATA_DIR, LOG_DIR]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
        }
    }
}

// 多主题系统（源码层）：浏览器端的行为验证在 android-app/test/theme.test.mjs（那里有 playwright），这里只做静态检查 —— 根目录脚本不依赖浏览器。

/** 把所有同名 `marker { ... }` 块拼接（配对扫描）：默认外观拆成尺寸/配色多个 html.rd 块，只取第一个会漏掉配色令牌。 */
function cssBlocksAfter(text, marker) {
    let out = '';
    let from = 0;
    for (;;) {
        const at = String(text).indexOf(marker, from);
        if (at < 0) break;
        out += cssBlockAfter(text.slice(at), marker) + '\n';
        from = at + marker.length;
    }
    return out;
}

/** 取 `marker { ... }` 的花括号内容（配对扫描）；不能用 indexOf('}')——注释里的 `}` 会提前截断。 */
function cssBlockAfter(text, marker) {
    const start = String(text || '').indexOf(marker);
    if (start < 0) return '';
    const open = String(text).indexOf('{', start);
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(open + 1, i); }
    }
    return '';
}

async function caseTheme(c) {
    const read = (p) => readFileSync(p, 'utf8');
    const html = readFrontend();
    void html;

    console.log('=== 1. 文件与接线 ===');
    {
        const themeJs = path.join(WEB, 'js', 'theme.js');
        const themesCss = path.join(WEB, 'css', 'themes.css');
        c.ok(existsSync(themeJs), 'web/js/theme.js 存在');
        c.ok(existsSync(themesCss), 'web/css/themes.css 存在');

        const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
        c.ok(/<script[^>]*src="\/js\/theme\.js"[^>]*><\/script>/.test(html), 'index.html 引入 theme.js');
        c.ok(/<link rel="stylesheet" href="\/css\/themes\.css">/.test(html), 'index.html 引入 themes.css');
        c.ok(/<link rel="stylesheet" href="\/css\/base\.css">/.test(html), 'index.html 引入 base.css');
        c.ok(!/<style[\s>]/.test(html), '★ index.html 不再有内联 <style>（样式统一住 web/css/）');

        // 基础层必须在主题层之前：同权重靠后加载胜出，反了则主题压不住。
        const baseLinkIdx = html.indexOf('/css/base.css');
        const cssLinkIdx = html.indexOf('/css/themes.css');
        c.ok(baseLinkIdx > 0 && cssLinkIdx > baseLinkIdx, '★ themes.css 排在 base.css 之后',
            'base@' + baseLinkIdx + ' themes@' + cssLinkIdx);

        c.ok(/id="themePickerBox"/.test(html), '设置里有 #themePickerBox');
        c.ok(/id="headerThemeBtn"/.test(html), '深色模式控件已移到顶栏（#headerThemeBtn）');
    }

    console.log('\n=== 2. 默认主题与内置模板（v2 令牌体系）===');
    {
        const js = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
        c.ok(/removeAttribute\('data-theme-template'\)/.test(js),
            '★ 默认主题走 removeAttribute（不设属性 → 覆盖规则一条都不生效）');
        c.ok(/'majo'/.test(js), '默认模板 id 为 majo（v2 视觉体系）');
        c.ok(/['"]elaina['"]/.test(js), '旧默认 id elaina 仍被识别（存量设置回落默认）');

        // 只从 TEMPLATES 数组里取，别处同形状的 { id, name } 条目会混进清单数多。
        const tplBlock = (js.match(/const TEMPLATES = \[[\s\S]*?\n\s*\];/) || [''])[0];
        c.ok(tplBlock.length > 0, '能取到 TEMPLATES 数组');
        const ids = [...tplBlock.matchAll(/\{\s*id:\s*'(\w+)',\s*name:/g)].map((m) => m[1]);
        // 「自定义」与插件注册的模板（如 host.theme() 注册的「星屑之日」）不属于内置清单，只钉内置的那几套。
        c.ok(ids.length === 4, '定义了 4 套内置模板，实得 ' + ids.length, ids.join(','));
        for (const id of ['majo', 'olive', 'mist', 'glass']) {
            c.ok(ids.includes(id), '含模板 ' + id);
        }
        // 自定义主题已下线：卡片不在清单里，整条 DIY 通路不可达（setTemplate('custom') 会被本校验打回 majo）。
        c.ok(!ids.includes('custom'), '自定义主题已下线，不再出现在内置清单里');
        for (const id of ['amber', 'plum', 'ios', 'claude', 'sakura']) {
            c.ok(!ids.includes(id), '旧模板 id 已移除：' + id);
        }
        // 深色只有一套中性色：基调用属性切多套会造成"设置选了没生效"，钉住它不回来。
        c.ok(!/data-dark-base/.test(js), 'theme.js 不再写 data-dark-base（深色只有一套中性色）');
        c.ok(!/DARK_BASES/.test(js), 'theme.js 不再定义 DARK_BASES');
    }

    console.log('\n=== 3. 覆盖权重（易错点）===');
    {
        const css = readFileSync(path.join(WEB, 'css', 'themes.css'), 'utf8');
        const LEGACY_PIXSO_ASSERTS = false;

        // 配色割裂检查点：只覆盖 --color-* / text-indigo-* 时切主题只有聊天区变色；v2 配色收拢到 --rd-* 令牌（html.rd 承接），这里钉令牌本身：块在、关键成员齐、跨主题能覆盖。
        const rdCount = (css.match(/--rd-[a-z0-9-]+:/g) || []).length;
        c.ok(rdCount >= 40, '★ 定义了 --rd-* 令牌（v2 配色的唯一来源，实得 ' + rdCount + ' 处）');
        const rootBlock = cssBlocksAfter(css, 'html.rd {');
        for (const v of ['--rd-bg', '--rd-surface', '--rd-panel', '--rd-text',
            '--rd-accent', '--rd-accent-strong', '--rd-border']) {
            c.ok(rootBlock.includes(v + ':'), '★ 默认外观定义了 ' + v);
        }
        c.ok(cssBlockAfter(css, 'html.rd[data-theme="dark"] {').length > 0,
            '★ 深色块存在（html.rd[data-theme="dark"]）');

        const themeColors = [
            ['#4d8fb4', '雾蓝日系 · 主色'],
            ['#eef5fa', '雾蓝日系 · 画布'],
            ['#f8f5f2', '暖米绿 · 画布'],
            ['#738746', '暖米绿 · 主色'],
            ['#465fd0', '石墨玻璃 · 主色'],
            ['#eef1f7', '石墨玻璃 · 画布'],
            ['#f4eee1', '暗夜魔女书房 · 画布'],
            ['#8a6a1f', '暗夜魔女书房 · 主色'],
        ];
        for (const [hex, label] of themeColors) {
            c.ok(css.includes(hex), '★ 主题配色：' + label + ' = ' + hex);
        }

        const darkNeutralColors = [
            ['#0b0e15', '画布'],
            ['#121722', '外壳'],
            ['#f0e8d8', '正文'],
        ];
        for (const [hex, label] of darkNeutralColors) {
            c.ok(css.includes(hex), '★ 深色中性色：' + label + ' = ' + hex);
        }
        c.ok(!/data-dark-base/.test(css), 'themes.css 不再有 data-dark-base 选择器');

        c.ok(!/#0a84ff/i.test(css), '★ 深色不再写死 iOS 蓝 #0a84ff');
        c.ok(!/#5ca8ff/i.test(css), '★ 深色文字高亮不再写死 #5ca8ff');
        c.ok(!/rgba\(\s*30\s*,\s*46\s*,\s*80/.test(css), '★ 深色 AI 气泡不再写死藏青渐变');

        c.ok(/--rd-rail-bg:/.test(css) && /--rd-rail-bg-2:/.test(css),
            '★ 侧栏竖栏有独立的 --rd-rail-bg / --rd-rail-bg-2 令牌');

        const themeJs = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
        c.ok(/DARK_MODES\s*=\s*\[[^\]]*'system'/.test(themeJs), '★ theme.js 支持三态（含 system）');
        c.ok(/prefers-color-scheme:\s*dark/.test(themeJs), '★ 用 matchMedia 检测系统深色偏好');
        c.ok(/addEventListener\('change'/.test(themeJs), '★ 监听系统主题变化（跟随系统要实时响应）');
        c.ok(/applyDarkMode/.test(themeJs), '落 DOM 的逻辑统一在一个入口（用户改 / 系统变都走它）');

        const html = readHtmlAndStyles();
        c.ok(/id="headerThemeBtn"/.test(html), '★ 外观模式开关已移到顶栏（#headerThemeBtn）');
        c.ok(/data-mode="system"/.test(html) && /跟随设备/.test(html), '★ 含「跟随设备」段（原跟随系统）');
        c.ok(/data-mode="light"/.test(html) && /data-mode="dark"/.test(html), '★ 含浅色与深色两段');
        c.ok(/\.is-active/.test(html), '★ 选中段有 .is-active（填充圆底）');
        c.ok(!/id="themeDarkMode"/.test(html), '★ 原「外观 → 深色模式」下拉已删除');

        // 权重压得住既有规则靠 html.rd 令牌承载，不再逐类覆盖 Tailwind 工具类（改一处全站生效）。
        c.ok(/html\.rd\[data-theme="dark"\]/.test(css) && /html\.rd\[data-theme-template="olive"\]/.test(css),
            '★ 主题与深色都以 html.rd[attr] 提权（与项目里既有的 ID 级规则同层或更高）');
        c.ok(!/text-indigo-/.test(css), '★ 不再逐类覆盖 text-indigo-*（配色由令牌统一改）');
        c.ok(/--rd-rail-bg:/.test(css) && /--rd-panel:/.test(css),
            '★ 侧栏与弹窗面板配色来自令牌（--rd-rail-bg / --rd-panel）');

        // 主题生效只看令牌定义，钉住"不新增 !important"：新增往往意味着有人又去逐类覆盖工具类。
        const importantCount = (css.match(/!important/g) || []).length;
        c.ok(importantCount === 0, '★ themes.css 不靠 !important 覆盖（令牌体系下应为 0 处，实得 ' + importantCount + '）');

        // 深色与模板正交（majo 是默认，不设属性、没有独立块）
        c.ok(/html\.rd\[data-theme="dark"\]/.test(css), '有 html.rd[data-theme="dark"] 规则');
        for (const tpl of ['olive', 'mist', 'glass']) {
            c.ok(css.includes('html.rd[data-theme-template="' + tpl + '"]'), '★ 模板 ' + tpl + ' 有变量定义');
        }

        // 主题变量完整性 + 硬编码白色防护：用了 var(--xxx) 但深色/主题块没覆盖，就停在 :root 浅色值上；硬编码 #fff 同理。
        //   这类 bug 只在某个主题/模式下才看得见，光读代码很难发现。
        const darkBlock = cssBlockAfter(css, 'html.rd[data-theme="dark"] {');
        for (const v of ['--rd-bg', '--rd-surface', '--rd-surface-2', '--rd-surface-3',
            '--rd-panel', '--rd-border', '--rd-text', '--rd-text-2', '--rd-text-3']) {
            c.ok(darkBlock.includes(v + ':'), '★ 深色块覆盖了 ' + v);
        }
        for (const v of ['--rd-accent', '--rd-accent-strong', '--rd-rail-bg']) {
            c.ok(darkBlock.includes(v + ':'), '★ 深色块覆盖了 ' + v);
        }

        c.ok(!css.includes('html.rd[data-theme-template="majo"]'),
            '★ majo 是默认外观（不写独立模板块，靠 html.rd 承接）');
        for (const tpl of ['olive', 'mist', 'glass']) {
            const block = cssBlockAfter(css, `html.rd[data-theme-template="${tpl}"] {`);
            c.ok(block.length > 0, `存在主题块 ${tpl}`);
            for (const v of ['--rd-bg', '--rd-surface', '--rd-accent', '--rd-warn']) {
                c.ok(block.includes(v + ':'), `★ 主题 ${tpl} 定义了 ${v}`);
            }
        }

        for (const v of ['--rd-warn', '--rd-warn-strong', '--rd-warn-bg', '--rd-warn-border']) {
            c.ok(css.includes(v + ':'), `★ 定义了 ${v}（警示色与品牌主色分开）`);
        }
        c.ok(/--pixso-warn:\s*var\(--rd-warn\)/.test(css), '★ --pixso-warn 仍映射到 --rd-warn（旧插件兼容）');
        for (const tpl of ['olive', 'mist', 'glass']) {
            const block = cssBlockAfter(css, `html.rd[data-theme-template="${tpl}"] {`);
            c.ok(block.includes('--rd-warn:'), `★ 主题 ${tpl} 定义了 --rd-warn`);
        }
        c.ok(darkBlock.includes('--rd-warn:'), '★ 深色块覆盖了 --rd-warn（深色下要提亮）');
        {
            const darkWarn = (darkBlock.match(/--rd-warn:\s*([^;]+);/) || [])[1] || '';
            c.ok(darkWarn.trim() !== '#b45309', '★ 深色的 --rd-warn 已提亮', 'darkWarn=' + darkWarn.trim());
        }

        // 移动端块里不能有"写死的白色面"：手机是全屏 #appShell，写死白 = 整页白底（桌面只是卡片一块）；
        //   块范围要用花括号配对取，不能 `slice(indexOf('@media'))` —— 会一路吞到后面其它媒体查询。
        const mobileBlock = cssBlockAfter(html, '@media (max-width: 860px) {');
        const badWhiteBg = [];
        for (const m of mobileBlock.matchAll(/background(?:-color)?:\s*(#[fF]{3,6}|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\.[5-9]\d*\s*\))/g)) {
            const line = mobileBlock.slice(0, m.index).split('\n').length;
            const before = mobileBlock.slice(Math.max(0, m.index - 260), m.index);
            if (/\/\*[^*]*$/.test(before)) continue;
            badWhiteBg.push(`第 ${line} 行附近: ${m[0]}`);
        }
        c.ok(badWhiteBg.length === 0,
            '★ 移动端块里没有写死的白色背景面（深色下会变白块，用户实测报过）',
            badWhiteBg.slice(0, 4).join('  |  '));

        // 浅色底曾以内联 RGB 写死，深色下字被主题改浅、底仍是浅的；改成语义类后由主题变量统一取值。
        c.ok(/class="[^"]*set-note[^"]*"/.test(html), '★ 设置页的信息面板走 .set-note 语义类');
        c.ok(/class="[^"]*set-note-warn[^"]*"/.test(html), '★ 警示面板走 .set-note-warn，不再写死浅橙底');
        c.ok(/\.set-note-warn\s*\{/.test(html) && /var\(--rd-warn-bg\)/.test(html),
            '★ .set-note-warn 用主题警示变量（深色下自动换底）');
        const rawHtml = readFileSync(path.join(WEB, 'index.html'), 'utf8');
        c.ok(!/rgba\(249,249,255|rgba\(255,247,237|rgba\(255,251,240|color:#b45309|color:#9a3412/.test(rawHtml),
            '★ 设置页不再有写死的浅色内联底与警示字色');

        // 切深色必须同时设 CSS `color-scheme`：select 弹层是浏览器原生绘制、CSS 碰不到，只由 color-scheme 决定配色（滚动条/复选框/日期选择器同理，须在主题层统一设）。
        c.ok(/colorScheme\s*=/.test(themeJs),
            '★ applyDarkMode 里设置了 CSS color-scheme（否则原生下拉/滚动条仍是浅色）');
        c.ok(/document\.documentElement\.style\.colorScheme\s*=\s*dark\s*\?\s*'dark'\s*:\s*'light'/.test(themeJs),
            '★ color-scheme 随深色开关切到 dark / light');
        // 浅色也要显式写 light：删掉则"跟随系统"遇到深色系统时原生控件仍按深色画。
        c.ok(!/style\.colorScheme\s*=\s*''/.test(themeJs) && !/removeProperty\(\s*['"]color-scheme/.test(themeJs),
            '★ 浅色时显式写 light（不能删掉，否则跟随系统时会漏回深色）');
        c.ok(/select option/.test(css), '★★ 显式给 <option> 设样式（color-scheme 管不到 option 的背景）');
        {
            const optRule = css.match(/html\.rd\[data-theme="dark"\][^{]*select option[^{]*\{([^}]*)\}/);
            c.ok(!!optRule, '★ 深色下有 select option 规则');
            if (optRule) {
                c.ok(/background-color\s*:/.test(optRule[1]), '★★ 深色的 option 设了 background-color');
                c.ok(/color\s*:/.test(optRule[1]), '深色的 option 也设了 color');
            }
            c.ok(/html\.rd:not\(\[data-theme="dark"\]\)[^{]*select option/.test(css),
                '★ 浅色主题也显式给了 option 配色（防"跟随系统"下浏览器画深底）');
        }
    }

    console.log('\n=== 3.5 主题设置独立成「外观」分栏 ===');
    {
        const html = readHtmlAndStyles();
        c.ok(/data-settings-tab="tab-appearance"[\s\S]{0,300}<b>外观<\/b>/.test(html), '★ 有独立的「外观」Tab');
        c.ok(/id="tab-appearance"/.test(html), '有 #tab-appearance 面板');
        c.ok(/id="tab-appearance" class="settings-tab-panel active-panel"/.test(html),
            '★ 外观是默认激活分栏（打开设置直接看到主题）');
        const advIdx = html.indexOf('id="tab-advanced"');
        const themeIdx = html.indexOf('themeSettingsSection');
        c.ok(themeIdx > 0 && themeIdx < advIdx, '★ 主题设置已从「高级」移到「外观」');
        c.ok(/id="themePickerBox"/.test(html), '外观分栏里有模板选择器');
        c.ok(/id="headerThemeBtn"/.test(html), '深色切换在顶栏（#headerThemeBtn，与「整理记忆」同排）');

        // 默认主题的名字与色点必须与应用实际配色一致：theme.js 里的名字/色点和 index.html :root 真实值会漂移，
        //   判据 = 色点必须等于 :root 里三个真实值（改 :root 忘改 theme.js 时立刻红）。
        {
            const themeJs = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
            const tplLine = (themeJs.match(/\{ id: 'majo',[^}]*\}/) || [''])[0];
            c.ok(/name: '暗夜魔女书房/.test(tplLine),
                '★ 默认主题的名字反映实际配色（不能还叫"粉紫"）', tplLine.slice(0, 60));
            const rootBlock = (html.match(/:root\s*\{[\s\S]*?--pixso-shadow[^;]*;/) || [''])[0];
            const val = (n) => (rootBlock.match(new RegExp('--' + n + ':\\s*([^;]+);')) || [])[1]?.trim() || '';
            const realCanvas = val('pixso-canvas');
            const realGreen = val('pixso-green');
            const realCream = val('pixso-cream');
            c.ok(Boolean(realCanvas && realGreen && realCream), '取到 :root 的三个基准色',
                JSON.stringify({ realCanvas, realGreen, realCream }));
            for (const [label, v] of [['canvas', realCanvas], ['green', realGreen], ['cream', realCream]]) {
                if (!v) continue;
                c.ok(tplLine.includes("'" + v + "'"),
                    `★ 默认主题色点包含 :root 的真实 --pixso-${label}（${v}）`);
            }
            c.ok(!/id: 'majo'[^}]*#ec4899/.test(themeJs),
                '★ 默认主题不再挂着粉紫色点 #ec4899');
        }

        // 判据：基础样式层里除「兜底调色板」外不许出现粉紫特征值；.fallback-ready 镜像 Tailwind 的 pink/violet，不是主题配色。
        // 必须先剥注释，否则解释"这里是写死的粉"的注释会被正则命中。
        {
            const baseCss = readFileSync(path.join(WEB, 'css', 'base.css'), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\.fallback-ready[^{}]*\{[^{}]*\}/g, '');
            const PINK_SIGNS = [
                { re: /#ec4899/i, label: '#ec4899' },
                { re: /#8b5cf6/i, label: '#8b5cf6' },
                { re: /#FFF0F5/i, label: '#FFF0F5（粉渐变起）' },
                { re: /rgba\(\s*236\s*,\s*72\s*,\s*153/, label: 'rgba(236,72,153)（粉）' },
                { re: /rgba\(\s*244\s*,\s*114\s*,\s*182/, label: 'rgba(244,114,182)（粉）' },
                { re: /rgba\(\s*139\s*,\s*92\s*,\s*246/, label: 'rgba(139,92,246)（紫）' },
                { re: /rgba\(\s*167\s*,\s*139\s*,\s*250/, label: 'rgba(167,139,250)（紫）' },
            ];
            for (const s of PINK_SIGNS) {
                c.ok(!s.re.test(baseCss),
                    `★ 默认主题下没有写死的粉紫 ${s.label}（注释与兜底调色板不计）`);
            }
// --color-* 只给"自定义"主题与 Tailwind 兜底，宿主直接引用会在默认主题下变粉。
            c.ok(!/var\(--color-primary\)|var\(--color-secondary\)|var\(--color-accent\)/.test(baseCss),
                '★ 宿主规则不再直接引用 --color-*（那套是粉紫，只给自定义主题/兜底用）');
        }

        // 所有下拉统一外观：`<select>` 原生绘制与圆角输入框不一致、深色下箭头不跟随，修法 `appearance: none` + 内联 SVG 自绘三角。
        {
            const selRule = html.match(/#settingsPanel select\.modal-input[^{]*\{([^}]*)\}/);
            c.ok(!!selRule, '找得到「设置里所有 select」的外观规则');
            if (selRule) {
                c.ok(/appearance:\s*none/.test(selRule[1]), '★ 去掉原生外观（appearance: none）');
                c.ok(/background-image:\s*url\("data:image\/svg\+xml/.test(selRule[1]),
                    '★ 用内联 SVG 自绘三角（不能靠 ::after —— select 是替换元素，伪元素不渲染）');
                c.ok(/padding-right:\s*34px/.test(selRule[1]),
                    '★ 右侧留出 34px 给三角（否则长选项文字压到箭头上）');
            }
            // 深色下箭头要单独提亮（内联 SVG 里的 stroke 取不到 currentColor）
            c.ok(/html\[data-theme="dark"\][^{]*select[^{]*\{[^}]*background-image:\s*url\("data:image\/svg\+xml/.test(html),
                '★ 深色下换一份更亮的箭头 SVG');
        }

        // 导航按钮组居中：`flex-1`（flex: 1 1 0%）会撑满整行让 max-content + auto margin 失效，修法把 flex 改成 `0 1 auto`；断言 ① 不得再有 flex-1 ② justify-content 必须仍 flex-start。
        {
            // 滚动不变量：overflow-x:auto 下 center 会把溢出均分两侧，scrollLeft 最小 0，左半永远滚不回。属主是 redesign.css 的 `html.rd #settingsTabNav`；
        //   提取用花括号配对而非正则 —— 同文件多处同名选择器，非贪婪匹配会吞进后面几百行。
            const ownerCss = readFileSync(path.join(WEB, 'css', 'redesign.css'), 'utf8');
            const navOwner = cssBlockAfter(ownerCss, 'html.rd #settingsTabNav {');
            c.ok(Boolean(navOwner), '找得到 #settingsTabNav 规则的属主（redesign.css）');
            c.ok(/display:\s*flex/.test(navOwner), '导航是 flex 容器（属主规则里声明）');
            c.ok(/justify-content:\s*flex-start/.test(navOwner),
                '★★ justify-content 仍是 flex-start（改成 center 会让溢出部分滚不回来）');
            c.ok(!/flex:\s*1\s+1\s+0%/.test(ownerCss),
                '★ 导航没有被 flex: 1 1 0% 撑满（那会让内容宽度失效）');
            const navTag = html.match(/<div id="settingsTabNav"[^>]*>/);
            c.ok(!!navTag, '找得到 #settingsTabNav 元素');
            if (navTag) {
                c.ok(!/class="[^"]*\bflex-1\b/.test(navTag[0]),
                    '★★ 元素上没有 flex-1（有它会盖掉 CSS 里的 flex 简写）');
            }
        }

        // 各分栏不能互相嵌套：漏一个 `>`（写成 </div）会让后面分栏全嵌进 tab-appearance，表现"除了外观其他设置全不见"；用 div 配对算出各分栏范围。
        const overlayStart = html.indexOf('id="settingsOverlay"');
        if (overlayStart < 0) {
            c.ok(false, '找不到 settingsOverlay');
        } else {
            let depth = 0, i = html.lastIndexOf('<div', overlayStart), overlayEnd = -1;
            for (; i < html.length; i++) {
                if (html.startsWith('<div', i)) { depth++; i += 3; }
                else if (html.startsWith('</div>', i)) { depth--; i += 5; if (depth === 0) { overlayEnd = i; break; } }
            }
            const region = html.slice(overlayStart, overlayEnd > 0 ? overlayEnd : html.length);
            const ids = [...region.matchAll(/id="(tab-\w+)" class="settings-tab-panel/g)].map((m) => m[1]);
            c.ok(ids.length >= 7, `宿主自带 ${ids.length} 个分栏（应 ≥7）`);
            c.ok(ids.includes('tab-model'), '★ 有「模型」分栏（对话 + 语音 + 视觉已合并）');
            for (const gone of ['tab-chat', 'tab-voice', 'tab-vision']) {
                c.ok(!ids.includes(gone), `★ 旧的 ${gone} 分栏已不存在（已并入 tab-model）`);
            }
            const l2dManifest = path.join(ROOT, 'mods', 'live2d', 'manifest.json');
            if (existsSync(l2dManifest)) {
                const l2dSrc = readFileSync(path.join(ROOT, 'mods', 'live2d', 'register.js'), 'utf8');
                c.ok(/host\.slot\('settings\.modal'/.test(l2dSrc),
                    '★ Live2D 设置改由插件经 settings.modal 独立成窗（所以宿主少一个分栏是对的）');
            }

            const ranges = [];
            for (const id of ids) {
                const s = region.indexOf(`id="${id}"`);
                const divStart = region.lastIndexOf('<div', s);
                let d = 0, j = divStart, e = -1;
                for (; j < region.length; j++) {
                    if (region.startsWith('<div', j)) { d++; j += 3; }
                    else if (region.startsWith('</div>', j)) { d--; j += 5; if (d === 0) { e = j; break; } }
                }
                ranges.push({ id, s: divStart, e });
            }
            const nested = [];
            for (const a of ranges) {
                for (const b of ranges) {
                    if (a.id === b.id) continue;
                    if (a.s < b.s && b.e < a.e) nested.push(`${b.id} 嵌在 ${a.id} 里`);
                }
            }
            c.ok(nested.length === 0,
                '★ 各设置分栏互不嵌套（分栏被嵌套会导致"其他设置全消失"）',
                nested.slice(0, 3).join('; '));

            const brokenTag = /<\/div\s*\n/.test(region) || /<\/section\s*\n/.test(region);
            c.ok(!brokenTag, '★ 没有残缺的闭合标签（如 </div 少了 >）');
        }
    }

    console.log('\n=== 3.6 插件主题摘除后，不能"变量没了但属性还在" ===');
    {
        // 根因两层都要钉住：① unregisterTemplate 的判断写在 splice **之后**则恒为 false，回落默认从未执行；② 裸用 var(--tpl-primary)，变量取不到时声明无效 → 背景透明，配 #fff 字 = 看不见的按钮。
        const jsRaw = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
        // 先剥注释：文件里的注释含 `currentTemplate() === id`，会被正则先于正文命中。
        const js = jsRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        const fnIdx = js.indexOf('function unregisterTemplate');
        const fnSrc = fnIdx < 0 ? '' : js.slice(fnIdx, js.indexOf('function refreshPicker', fnIdx));
        const guardIdx = fnSrc.indexOf('currentTemplate() === id');
        const spliceIdx = fnSrc.indexOf('MOD_TEMPLATES.splice');
        c.ok(guardIdx >= 0 && spliceIdx >= 0 && guardIdx < spliceIdx,
            '★★ unregisterTemplate 的"是否正停在这套主题上"必须在 splice **之前**判（写在之后恒为 false）',
            `guard@${guardIdx} splice@${spliceIdx}`);

        // v2 覆盖规则改用 --rd-accent 令牌；--tpl-primary 仅保留为有值的兼容别名（第三方插件仍读它），且不得被裸用。
        const css = readFileSync(path.join(WEB, 'css', 'themes.css'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '');
        c.ok(/--tpl-primary:\s*var\(--rd-accent\)/.test(css),
            '★ --tpl-primary 是 --rd-accent 的兼容别名（旧插件取得到值）');
        c.ok(!/var\(--tpl-primary\s*\)/.test(css),
            '★★ 没有裸用 var(--tpl-primary)（取不到值时会回落成透明）');
    }

    console.log('\n=== 4. 同步（APK 端要用）===');
    {
        const sync = readFileSync(path.join(ROOT, 'dist', 'Android', 'scripts', 'sync-web.mjs'), 'utf8');
        c.ok(/collectCssFiles/.test(sync), '★ sync-web.mjs 会同步 web/css/（否则 APK 里主题切换无效）');
        c.ok(/theme\.js/.test(sync) || /collectJsFiles/.test(sync),
            'js/ 是自动发现的，theme.js 会被带上');
    }


}

// 旅行日记的浏览体验（按对话分组 / 点侧栏筛选 / 弹窗看全文）：真起一次 serve.mjs + Playwright 点页面 ——
// 这一块的 bug 全是"点着点着不对"，纯源码断言抓不到。

async function caseDiary(c) {
    const read = (p) => readFileSync(p, 'utf8');
    const stripComments = stripCommentsOf;
    void read; void stripComments;

    console.log('=== 1. 源码约定 ===');
    {
        const ui = readFileSync(path.join(WEB, 'js', 'conversations.js'), 'utf8')
            + '\n' + readFileSync(path.join(WEB, 'js', 'favorites.js'), 'utf8')
            + '\n' + readFileSync(path.join(WEB, 'js', 'diary.js'), 'utf8')
            + '\n' + readFileSync(path.join(WEB, 'js', 'ui.js'), 'utf8');
        const core = readFileSync(path.join(WEB, 'js', 'core-state.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'core.js'), 'utf8');
        const html = readHtmlAndStyles();

        c.ok(/function renderDiaryPage/.test(ui), '有 renderDiaryPage');
        c.ok(/diary-group-head/.test(ui), '★ 日记按对话分组渲染（组标题）');
        c.ok(/grid-column:\s*1\s*\/\s*-1/.test(html),
            '★ 组标题跨整行（不跨列会被塞进某一列、卡片跟着错位）');

        c.ok(/function focusDiaryGroup/.test(ui), '★★ 有 focusDiaryGroup（按对话筛选日记）');
        // 筛选状态定义在 **core.js 的 state** 里，不在 ui.js —— 判据要指对文件。
        c.ok(/diaryFilterConvId:\s*''/.test(core),
            '★ state 里有 diaryFilterConvId（筛选状态）');
        c.ok(/if \(state\.diaryMode && typeof focusDiaryGroup === 'function'\)/.test(ui),
            '★★ 只在日记页拦截侧栏点击（非日记页必须照旧进对话 —— 那是最常用的操作）');
        c.ok(!/function renderDiaryFilterBar/.test(ui),
            '★★ 已移除日记页内的筛选条（筛选职责交给左侧对话记录，不重复提供入口）');
        c.ok(!/diary-filter-bar/.test(ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
            '★★ 代码里不再生成 .diary-filter-bar（注释里提到不算）');
        c.ok(/is-focused/.test(ui) && /is-focused/.test(html),
            '★★ 当前筛选的组有高亮样式（is-focused）—— 筛选条移除后需要这个落点');

        c.ok(/function openDiaryDetail/.test(ui), '★★ 有 openDiaryDetail（点卡片看全文）');
        c.ok(/function closeDiaryDetail/.test(ui), '有 closeDiaryDetail');
        c.ok(/card\.addEventListener\('click', openDetail\)/.test(ui),
            '★ 卡片可点击打开详情');
        c.ok(/p\.textContent = entry\.content/.test(ui),
            '★★ 详情正文用 textContent（日记内容来自模型，不能当 HTML 解析）');

        c.ok(!/head\.addEventListener\('click', jump\)/.test(ui),
            '★ 组头不再"点了就跳去聊天"（用户明确要求去掉）');
        c.ok(/data-diary-enter/.test(ui), '★ 但保留「进入对话」按钮（入口不能丢）');

        c.ok(/function enterDiaryMode[\s\S]{0,400}?state\.diaryFilterConvId = ''/.test(ui),
            '★★ 进日记页时重置筛选（筛选是当次浏览状态，不该跨次留存）');
        c.ok(/function exitDiaryMode[\s\S]{0,500}?state\.diaryFilterConvId = ''/.test(ui),
            '★★ 离开日记页时也清掉（并关掉详情弹窗）');
        c.ok(/function exitDiaryMode[\s\S]{0,500}?closeDiaryDetail\(\)/.test(ui),
            '★ 离开日记页要关掉详情弹窗（它挂在 body 上，不随页面隐藏）');

        c.ok(/const activeId = state\.diaryMode/.test(ui),
            '★★ 日记页时高亮判据换成"筛选的对话"（不再只看 currentConversationId）');
        c.ok(/state\.diaryFilterConvId \|\| ''/.test(ui),
            '★ 未筛选时不高亮任何条目（回落成空串，不是 undefined）');
        c.ok(/function focusDiaryGroup[\s\S]{0,600}?renderFolderList\(\)/.test(ui),
            '★★ focusDiaryGroup 里重绘侧栏（不重绘则侧栏高亮不更新）');
        c.ok(/function exitDiaryMode[\s\S]{0,900}?renderFolderList\(\)/.test(ui),
            '★★ 离开日记页时重绘侧栏（高亮要切回"当前对话那段"）');

        c.ok(/function purgeConversationDependents/.test(ui),
            '★★ 有 purgeConversationDependents（删对话时清理依附数据）');
        c.ok(/function purgeConversationDependents[\s\S]{0,1500}?mc\.diary = mc\.diary\.filter/.test(ui),
            '★★ 它会清掉属于该对话的**日记**');
        c.ok(/function purgeConversationDependents[\s\S]{0,2000}?state\.favorites = state\.favorites\.filter/.test(ui),
            '★★ 它也会清掉属于该对话的**收藏句子**');
        const delFn = ui.slice(ui.indexOf('async function deleteConversation'), ui.indexOf('function togglePin'));
        c.ok(/purgeConversationDependents\(\[convId\]\)/.test(delFn),
            '★★ 单条删除走共用清理函数');
        const batchFn = ui.slice(ui.indexOf('async function catDeleteSelected'), ui.indexOf('// ==================== 消息渲染'));
        c.ok(/purgeConversationDependents\(catSelected\)/.test(batchFn),
            '★★ 批量删除也走同一个函数（两个入口不能再各写一半）');
        c.ok(/function purgeConversationDependents[\s\S]{0,1500}?saveMemoryCore/.test(ui)
            && /function purgeConversationDependents[\s\S]{0,2000}?saveFavorites/.test(ui),
            '★★ 清理结果要落盘（日记 saveMemoryCore / 收藏 saveFavorites）');
    }

    const PORT = await freePort();
    const HTTPS_PORT = await freePort();
    const BASE = `http://127.0.0.1:${PORT}`;
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-diary-data-'));
    const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-diary-log-'));
    const MODS_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-diary-mods-'));

    /** 造可控的测试数据。① 对话与记忆不在 store.json：服务端拆成 data/conversations/*.json 与 data/memory/*.json（一条一文件 + index）。
     * ② memory/<类目>.json 的 value 必须是真数组，再 stringify 一层会让 Array.isArray 判定失败、日记全空。 */
    {
        const convDir = path.join(DATA_DIR, 'conversations');
        mkdirSync(convDir, { recursive: true });
        const long = '长'.repeat(500);
        const convs = [
            { id: 'cA', title: '雪之街的相遇', messages: [{ id: 'm1', role: 'ai', text: 'hi', timestamp: '10:00' }], updatedAt: Date.now() },
            { id: 'cB', title: '咖啡馆的午后', messages: [{ id: 'm2', role: 'ai', text: 'hi', timestamp: '11:00' }], updatedAt: Date.now() },
        ];
        for (const c of convs) writeFileSync(path.join(convDir, c.id + '.json'), JSON.stringify(c, null, 2), 'utf8');
        writeFileSync(path.join(convDir, 'index.json'),
            JSON.stringify({ version: 1, order: ['cA', 'cB'], currentConversationId: 'cA' }, null, 2), 'utf8');

        const memDir = path.join(DATA_DIR, 'main', 'memory');
        mkdirSync(memDir, { recursive: true });
        writeFileSync(path.join(memDir, 'diary.json'), JSON.stringify({
            version: 1,
            value: [
                { date: '2026年10月14日', content: 'A 的故事：' + long, essences: ['雪之街'], conversationId: 'cA', conversationTitle: '雪之街的相遇', timestamp: '2026-10-14T10:00:00.000Z' },
                { date: '2026年10月14日', content: 'B 的故事：咖啡馆', essences: ['咖啡馆'], conversationId: 'cB', conversationTitle: '咖啡馆的午后', timestamp: '2026-10-14T11:00:00.000Z' },
            ],
        }, null, 2), 'utf8');
        for (const k of ['promise', 'preference', 'plan', 'motivation', 'pivotal_memory']) {
            writeFileSync(path.join(memDir, k + '.json'), JSON.stringify({ version: 1, value: [] }, null, 2), 'utf8');
        }
    }
    {
        const src = path.join(ROOT, 'mods');
        if (existsSync(src)) for (const n of readdirSync(src)) {
            const mf = path.join(src, n, 'manifest.json');
            if (!existsSync(mf)) continue;
            try {
                if (JSON.parse(readFileSync(mf, 'utf8')).id === 'elaina-avatar') {
                    const dest = path.join(MODS_DIR, 'elaina-avatar');
                    mkdirSync(dest, { recursive: true });
                    copyFileSync(path.join(src, n, 'manifest.json'), path.join(dest, 'manifest.json'));
                    if (existsSync(path.join(src, n, 'index.js'))) copyFileSync(path.join(src, n, 'index.js'), path.join(dest, 'index.js'));
                    const im = path.join(src, n, 'img');
                    if (existsSync(im)) {
                        mkdirSync(path.join(dest, 'img'), { recursive: true });
                        for (const f of readdirSync(im)) copyFileSync(path.join(im, f), path.join(dest, 'img', f));
                    }
                }
            } catch { /* 忽略 */ }
        }
    }

    const serverLogPath = path.join(LOG_DIR, 'server-output.log');
    const outFd = openSync(serverLogPath, 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT),
            HOST: '127.0.0.1', DATA_DIR, LOG_DIR, LOG_TO_FILE: '0', MODS_DIR,
        },
        stdio: ['ignore', outFd, outFd],
    });
    const serverOut = () => { try { return readFileSync(serverLogPath, 'utf8'); } catch { return ''; } };

    let browser = null;
    try {
        const up = await waitServerUp(BASE);
        c.ok(up, '服务已启动', up ? '' : serverOut().slice(-400));

        if (up) {
            browser = await launchTestBrowser();
            const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
            const page = await ctx.newPage();
            const errs = [];
            page.on('pageerror', (e) => errs.push(e.message));

            // 记忆正文的权威是 /api/memory/core（M2b）：Node 夹具没有这个接口，
            // 在浏览器层把请求拦下并返回夹具 canonical —— 页面走的仍是真实路径
            //（refreshMemoryCore → adopt → 渲染），不是往 state 里硬塞。
            const memoryCoreFixture = {
                diary: [
                    { id: 'diary:cA|2026年10月14日', conversationId: 'cA', conversationTitle: '雪之街的相遇', date: '2026年10月14日', content: 'A 的故事：' + '长'.repeat(500), essences: ['雪之街'], timestamp: '2026-10-14T10:00:00.000Z' },
                    { id: 'diary:cB|2026年10月14日', conversationId: 'cB', conversationTitle: '咖啡馆的午后', date: '2026年10月14日', content: 'B 的故事：咖啡馆', essences: ['咖啡馆'], timestamp: '2026-10-14T11:00:00.000Z' },
                ],
                promise: [], preference: [], plan: [], motivation: [], pivotal_memory: [],
            };
            // 探测接口也要接住：refreshMemoryCore 先探 /index/status，404 会让它整段跳过。
            await page.route('**/api/memory/index/status', (route) => route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, available: true, count: memoryCoreFixture.diary.length }),
            }));
            await page.route('**/api/memory/core', (route) => route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, core: memoryCoreFixture }),
            }));

            const nav = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
            c.ok(nav && nav.status() === 200, '页面能打开', 'status=' + (nav ? nav.status() : '?'));
            await page.waitForTimeout(1500);
            await page.evaluate(() => {
                const ov = document.getElementById('announcementOverlay');
                if (ov) { ov.classList.add('hidden'); ov.classList.remove('flex'); }
            });

            await page.evaluate(() => { enterDiaryMode(); });
            await page.waitForTimeout(600);
            const grouped = await page.evaluate(() => ({
                diaryMode: state.diaryMode,
                groups: [...document.querySelectorAll('.diary-group-title')].map((e) => e.textContent),
                cards: document.querySelectorAll('.diary-card').length,
                countText: (document.getElementById('diaryCount') || {}).textContent,
                enterBtns: document.querySelectorAll('.diary-group-enter').length,
            }));
            c.ok(grouped.cards === 2, '★★ 两条日记都渲染出来了（canonical 数据经 /api/memory/core 读到）', JSON.stringify(grouped));
            c.ok(grouped.groups.includes('雪之街的相遇') && grouped.groups.includes('咖啡馆的午后'),
                '★★ 按对话分成两组，组标题是各自的对话名', JSON.stringify(grouped.groups));
            c.ok(grouped.enterBtns === 2, '★ 每个可跳转的组都有「进入对话」按钮');

            const filtered = await page.evaluate(async () => {
                const item = document.querySelector('#folderList [data-conv-id="cB"]');
                if (!item) return { found: false };
                item.click();
                await new Promise((r) => setTimeout(r, 500));
                return {
                    found: true,
                    stillDiaryMode: state.diaryMode,
                    currentConv: state.currentConversationId,
                    filter: state.diaryFilterConvId,
                    groups: [...document.querySelectorAll('.diary-group-title')].map((e) => e.textContent),
                    cards: document.querySelectorAll('.diary-card').length,
                    focusedHead: document.querySelectorAll('.diary-group-head.is-focused').length,
                    focusedTitle: (document.querySelector('.diary-group-head.is-focused .diary-group-title') || {}).textContent || '',
                    filterBarGone: !document.querySelector('.diary-filter-bar'),
                    diaryVisible: !document.getElementById('diaryPage').classList.contains('hidden'),
                    chatHidden: document.getElementById('conversationHistory').classList.contains('hidden'),
                };
            });
            c.ok(filtered.found, '★★ 侧栏里能找到那条对话');
            c.ok(filtered.stillDiaryMode, '★★★ 点侧栏后**仍在日记页**',
                JSON.stringify(filtered));
            c.ok(filtered.filter === 'cB',
                '★★ 筛选到了被点的那段对话', String(filtered.filter));
            c.ok(filtered.cards === 1 && filtered.groups.length === 1 && filtered.groups[0] === '咖啡馆的午后',
                '★★ 只显示该对话的日记（别的对话收起来了）', JSON.stringify(filtered.groups));
            c.ok(filtered.focusedHead === 1 && filtered.focusedTitle === '咖啡馆的午后',
                '★★ 当前筛选的那一组有高亮（is-focused）—— 筛选条移除后靠它告诉用户"点中了"',
                JSON.stringify({ n: filtered.focusedHead, t: filtered.focusedTitle }));
            c.ok(filtered.filterBarGone,
                '★★ 日记页里**没有**第二套筛选条（分类职责已交给左侧对话记录）');
            c.ok(filtered.chatHidden, '★ 聊天区没有因此被显示出来');
            c.ok(filtered.diaryVisible, '★ 日记页仍然可见');

            const toggled = await page.evaluate(async () => {
                const item = document.querySelector('#folderList [data-conv-id="cB"]');
                item.click();
                await new Promise((r) => setTimeout(r, 400));
                return { filter: state.diaryFilterConvId, cards: document.querySelectorAll('.diary-card').length };
            });
            c.ok(toggled.filter === '' && toggled.cards === 2,
                '★★ 再点同一段 → 取消筛选、恢复全部（像开关一样，不会"筛进去出不来"）',
                JSON.stringify(toggled));

            const detail = await page.evaluate(async () => {
                const cards = [...document.querySelectorAll('.diary-card')];
                const longCard = cards.find((c) => (c.textContent || '').includes('A 的故事'));
                if (!longCard) return { found: false };
                longCard.click();
                await new Promise((r) => setTimeout(r, 400));
                const ov = document.getElementById('diaryDetailOverlay');
                const txt = document.querySelector('.diary-detail-text');
                return {
                    found: true,
                    open: ov ? !ov.classList.contains('hidden') : null,
                    fullLen: txt ? txt.textContent.length : 0,
                    meta: (document.getElementById('diaryDetailMeta') || {}).textContent || '',
                    essences: document.querySelectorAll('#diaryDetailBody .diary-essence').length,
                    clampedByCss: (() => {
                        const t = longCard.querySelector('.diary-card-text');
                        return t ? getComputedStyle(t).webkitLineClamp : null;
                    })(),
                };
            });
            c.ok(detail.found && detail.open, '★★★ 点日记卡片会弹出详情',
                JSON.stringify(detail));
            c.ok(detail.fullLen > 500,
                '★★★ 弹窗里是**完整正文**（卡片被 CSS 截成 4 行，这里必须是全文）',
                '弹窗长度=' + detail.fullLen);
            c.ok(String(detail.clampedByCss) === '4',
                '★ 卡片本身仍是 4 行截断（列表保持整齐 —— 靠弹窗看全文）', String(detail.clampedByCss));
            c.ok(/雪之街/.test(detail.meta), '★ 弹窗标题带来源对话名', detail.meta);
            c.ok(detail.essences >= 1, '★ 弹窗里保留了关键词标签');

            const closed = await page.evaluate(async () => {
                const b = document.getElementById('diaryDetailClose');
                if (b) b.click();
                await new Promise((r) => setTimeout(r, 300));
                const ov = document.getElementById('diaryDetailOverlay');
                return ov ? ov.classList.contains('hidden') : null;
            });
            c.ok(closed === true, '★ 关闭按钮能关掉详情弹窗');

            const enterBtn = await page.evaluate(async () => {
                const b = document.querySelector('.diary-group-enter');
                if (!b) return { found: false };
                b.click();
                await new Promise((r) => setTimeout(r, 600));
                return {
                    found: true,
                    diaryMode: state.diaryMode,
                    currentConv: state.currentConversationId,
                    chatVisible: !document.getElementById('conversationHistory').classList.contains('hidden'),
                };
            });
            c.ok(enterBtn.found && !enterBtn.diaryMode && enterBtn.chatVisible,
                '★★ 「进入对话」按钮仍能切到那段对话（入口没被去掉）', JSON.stringify(enterBtn));

            // 非日记页时点侧栏必须照旧进对话 —— 进对话是常用操作，最容易被筛选逻辑改坏，单独钉一条。
            const normal = await page.evaluate(async () => {
                const item = document.querySelector('#folderList [data-conv-id="cA"]');
                if (!item) return { found: false };
                item.click();
                await new Promise((r) => setTimeout(r, 600));
                return {
                    found: true,
                    diaryMode: state.diaryMode,
                    currentConv: state.currentConversationId,
                    chatVisible: !document.getElementById('conversationHistory').classList.contains('hidden'),
                };
            });
            c.ok(normal.found && !normal.diaryMode && normal.currentConv === 'cA' && normal.chatVisible,
                '★★★ 非日记页点侧栏**照旧进入对话**（筛选逻辑不能影响日常操作）',
                JSON.stringify(normal));

            const reenter = await page.evaluate(async () => {
                state.diaryFilterConvId = 'cB';     // 人为留一个筛选
                enterDiaryMode();
                await new Promise((r) => setTimeout(r, 400));
                return { filter: state.diaryFilterConvId, cards: document.querySelectorAll('.diary-card').length };
            });
            c.ok(reenter.filter === '' && reenter.cards === 2,
                '★★ 重新进入日记页时筛选被重置（不会莫名其妙只看到一部分）',
                JSON.stringify(reenter));

            const purge = await page.evaluate(async () => {
                state.conversations = [
                    { id: 'dA', title: '会被删的对话', messages: [], updatedAt: Date.now() },
                    { id: 'dB', title: '要保留的对话', messages: [], updatedAt: Date.now() },
                ];
                state.memoryCore = {
                    diary: [
                        { date: '2026年10月14日', content: 'A 的日记', conversationId: 'dA', conversationTitle: '会被删的对话', timestamp: '2026-10-14T10:00:00.000Z' },
                        { date: '2026年10月14日', content: 'B 的日记', conversationId: 'dB', conversationTitle: '要保留的对话', timestamp: '2026-10-14T11:00:00.000Z' },
                    ],
                    promise: [], preference: [], plan: [], motivation: [], pivotal_memory: [],
                };
                state.favorites = [
                    { id: 'f1', conversationId: 'dA', text: 'A 的收藏句子' },
                    { id: 'f2', conversationId: 'dB', text: 'B 的收藏句子' },
                ];
                state.currentConversationId = null;

                const before = { diary: state.memoryCore.diary.length, favs: state.favorites.length };

                const origConfirm = window.showCustomConfirm;
                window.showCustomConfirm = async () => true;
                try {
                    await deleteConversation('dA');
                } finally {
                    window.showCustomConfirm = origConfirm;
                }
                return {
                    before,
                    diaryLeft: state.memoryCore.diary.map((e) => e.content),
                    favsLeft: state.favorites.map((f) => f.text),
                    convLeft: state.conversations.map((c) => c.id),
                };
            });
            c.ok(purge.diaryLeft.length === 1 && purge.diaryLeft[0] === 'B 的日记',
                '★★★ 删除对话会清掉**该对话的日记**（不是全部日记）',
                JSON.stringify(purge.diaryLeft));
            c.ok(purge.favsLeft.length === 1 && purge.favsLeft[0] === 'B 的收藏句子',
                '★★★ 删除对话也会清掉**该对话的收藏句子**（用户报的那一半）',
                JSON.stringify(purge.favsLeft));
            c.ok(!purge.convLeft.includes('dA'), '★ 对话本身被删掉');
            c.ok(purge.convLeft.includes('dB'), '★ 别的对话不受影响');

            const liveRefresh = await page.evaluate(async () => {
                state.conversations = [
                    { id: 'rA', title: '待删', messages: [], updatedAt: Date.now() },
                    { id: 'rB', title: '保留', messages: [], updatedAt: Date.now() },
                ];
                state.memoryCore = {
                    diary: [
                        { date: '2026年10月14日', content: 'rA 日记', conversationId: 'rA', conversationTitle: '待删', timestamp: '2026-10-14T10:00:00.000Z' },
                        { date: '2026年10月14日', content: 'rB 日记', conversationId: 'rB', conversationTitle: '保留', timestamp: '2026-10-14T11:00:00.000Z' },
                    ],
                    promise: [], preference: [], plan: [], motivation: [], pivotal_memory: [],
                };
                state.favorites = [];
                state.diaryFilterConvId = '';
                enterDiaryMode();
                const beforeGroups = document.querySelectorAll('.diary-group-head').length;

                const origConfirm = window.showCustomConfirm;
                window.showCustomConfirm = async () => true;
                try { await deleteConversation('rA'); } finally { window.showCustomConfirm = origConfirm; }

                return {
                    beforeGroups,
                    afterGroups: document.querySelectorAll('.diary-group-head').length,
                    titles: [...document.querySelectorAll('.diary-group-title')].map((e) => e.textContent),
                };
            });
            c.ok(liveRefresh.beforeGroups === 2, '（准备）删除前有 2 组', String(liveRefresh.beforeGroups));
            c.ok(liveRefresh.afterGroups === 1 && liveRefresh.titles.includes('保留'),
                '★★ 在日记页里删对话后**立刻刷新**（不留下一个点进去是空的组）',
                JSON.stringify(liveRefresh));

            // 日记页点对话后侧栏条目本身要拿到 .sidebar-item-active（不只是"筛选生效了"）；上面测删除时已把 state.conversations 换成别的 id，这里先恢复 cA/cB，否则查不到、断言假失败。
            const hl = await page.evaluate(async () => {
                state.conversations = [
                    { id: 'cA', title: '雪之街的相遇', messages: [], updatedAt: Date.now() },
                    { id: 'cB', title: '咖啡馆的午后', messages: [], updatedAt: Date.now() },
                ];
                state.memoryCore = {
                    diary: [
                        { date: '2026年10月14日', content: 'A 的故事', essences: [], conversationId: 'cA', conversationTitle: '雪之街的相遇', timestamp: '2026-10-14T10:00:00.000Z' },
                        { date: '2026年10月14日', content: 'B 的故事', essences: [], conversationId: 'cB', conversationTitle: '咖啡馆的午后', timestamp: '2026-10-14T11:00:00.000Z' },
                    ],
                    promise: [], preference: [], plan: [], motivation: [], pivotal_memory: [],
                };
                state.favorites = [];
                state.currentConversationId = 'cA';
                enterDiaryMode();
                await new Promise((r) => setTimeout(r, 400));
                const before = {
                    activeItems: [...document.querySelectorAll('#folderList .sidebar-item-active')].map((e) => e.getAttribute('data-conv-id')),
                };
                focusDiaryGroup('cB');
                await new Promise((r) => setTimeout(r, 400));
                const itemB = document.querySelector('#folderList [data-conv-id="cB"]');
                const itemA = document.querySelector('#folderList [data-conv-id="cA"]');
                return {
                    before,
                    afterActive: [...document.querySelectorAll('#folderList .sidebar-item-active')].map((e) => e.getAttribute('data-conv-id')),
                    bHasClass: itemB ? itemB.classList.contains('sidebar-item-active') : null,
                    aHasClass: itemA ? itemA.classList.contains('sidebar-item-active') : null,
                    currentConv: state.currentConversationId,
                    stillDiary: state.diaryMode,
                };
            });
            c.ok(!hl.before.activeItems.includes('cB'),
                '（准备）点之前侧栏没有选中 cB（说明下面是一次真切换）', JSON.stringify(hl.before));
            c.ok(hl.afterActive.includes('cB') && hl.afterActive.length === 1,
                '★★★ 日记页点对话后，侧栏**只有那段**拿到选中特效（.sidebar-item-active）',
                JSON.stringify(hl.afterActive));
            c.ok(hl.bHasClass === true && hl.aHasClass === false,
                '★★ 被点的那条高亮、另一条不高亮（不会两条一起亮）',
                JSON.stringify({ b: hl.bHasClass, a: hl.aHasClass }));
            c.ok(hl.currentConv !== 'cB',
                '★ 同时 currentConversationId 仍没变（"只筛选不跳转"没被破坏）',
                String(hl.currentConv));

            const back = await page.evaluate(async () => {
                state.currentConversationId = 'cA';     // 模拟当前对话是 cA
                exitDiaryMode();
                await new Promise((r) => setTimeout(r, 400));
                const itemA = document.querySelector('#folderList [data-conv-id="cA"]');
                const itemB = document.querySelector('#folderList [data-conv-id="cB"]');
                return {
                    aHas: itemA ? itemA.classList.contains('sidebar-item-active') : null,
                    bHas: itemB ? itemB.classList.contains('sidebar-item-active') : null,
                    diaryMode: state.diaryMode,
                    filter: state.diaryFilterConvId,
                };
            });
            c.ok(back.aHas === true && back.bHas === false,
                '★★ 回到聊天后高亮切回**当前对话**（cA 亮、cB 灭）',
                JSON.stringify(back));
            c.ok(back.diaryMode === false && back.filter === '',
                '★ 离开日记页时筛选也清掉了');

            console.log('  页面错误:', errs.length ? errs.slice(0, 3).join(' | ') : '(无)');
            c.ok(errs.length === 0, '★ 全程没有页面 JS 报错', errs.slice(0, 2).join(' | '));

            await ctx.close();
        }
    } finally {
        if (browser) { try { await browser.close(); } catch { /* 忽略 */ } }
        child.kill();
        await wait(300);
        for (const d of [DATA_DIR, LOG_DIR, MODS_DIR]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    }


}

// 「星屑之日」生日模块（已从宿主摘出、改为插件）：插件源码不随仓库分发（应用内上传安装），本地没有 mods/birthday/ 时第 5 节整节跳过，第 1~4 节查宿主那一侧照常跑。

async function caseBirthday(c) {
    const MOD = path.join(ROOT, 'mods', 'birthday');
    const read = (p) => readFileSync(p, 'utf8');
    const stripComments = stripCommentsOf;

    const indexHtml = read(path.join(WEB, 'index.html'));
    const themeJs = read(path.join(WEB, 'js', 'theme.js'));
    const themesCss = read(path.join(WEB, 'css', 'themes.css'));
    const storeJs = read(path.join(WEB, 'js', 'store.js'));
    const modsJs = read(path.join(WEB, 'js', 'mods-loader.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-contributions.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-services.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-slots.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-summary.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-deps.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-capabilities.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-load.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-enable.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-load-one.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-faults.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-host.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-forget.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-api.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-storage.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-host-core.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods-host-extras.js')) + '\n'
        + read(path.join(WEB, 'js', 'mods.js'));
    const dataJs = read(path.join(WEB, 'js', 'announcements.js')) + '\n'
        + read(path.join(WEB, 'js', 'roleplay.js')) + '\n'
        + read(path.join(WEB, 'js', 'chat.js')) + '\n'
        + read(path.join(WEB, 'js', 'data.js'));
    const initJs = read(path.join(WEB, 'js', 'bindings.js')) + '\n'
        + read(path.join(WEB, 'js', 'init.js'));
    const achJs = read(path.join(WEB, 'js', 'achievements.js'));

    const allJs = readdirSync(path.join(WEB, 'js'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => ({ name: f, src: read(path.join(WEB, 'js', f)) }));

    console.log('=== 1. 宿主已摘除（旧模块文件 / 引用 / 主题 / 存储白名单）===');
    {
        c.ok(!existsSync(path.join(WEB, 'js', 'birthday.js')), '★ web/js/birthday.js 已删除');
        c.ok(!existsSync(path.join(WEB, 'css', 'birthday.css')), '★ web/css/birthday.css 已删除');
        c.ok(!/\/js\/birthday\.js/.test(indexHtml), '★ index.html 不再引入 birthday.js');
        c.ok(!/\/css\/birthday\.css/.test(indexHtml), '★ index.html 不再引入 birthday.css');
        // 成就是为了"生日纪念"才有的模块，但成就本身是宿主功能 —— 它的样式留在宿主
        c.ok(/\/css\/achievements\.css/.test(indexHtml),
            '★ 成就样式拆成宿主自己的 css/achievements.css（生日那份随插件走）');
        const offenders = allJs.filter((f) => /ElainaBirthday/.test(stripComments(f.src))).map((f) => f.name);
        c.ok(offenders.length === 0,
            '★★ 宿主前端脚本里不再有任何 ElainaBirthday 引用（否则旧模块一删就报错）',
            offenders.join(', '));

        const tplIds = [...themeJs.matchAll(/\{\s*id:\s*'(\w+)',\s*name:/g)].map((m) => m[1]);
        c.ok(!tplIds.includes('stardust'),
            '★★ theme.js 的 TEMPLATES 里已没有 stardust（改由插件 host.theme 注册）', tplIds.join(','));
        c.ok(!/html\[data-theme-template="stardust"\]\s*\{/.test(themesCss),
            '★★ themes.css 不再定义 stardust 的变量块（避免与插件里的变量出现两份）');

        const keysBlock = storeJs.match(/DATA_KEYS\s*=\s*\[[\s\S]*?\]/);
        const keys = keysBlock ? [...keysBlock[0].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
        c.ok(!keys.includes('elaina_birthday'),
            '★★ DATA_KEYS 里不再有 elaina_birthday（生日状态改住插件的私有命名空间）');
        c.ok(keys.includes('elaina_mod_storage'),
            '★★ DATA_KEYS 里有 elaina_mod_storage（漏了 → 插件的持久化刷新即丢）');

        // 成就属宿主功能、插件只当触发器 → 四条定义必须还在
        for (const id of ['stardust_day', 'stardust_remembered', 'stardust_makeup', 'stardust_together']) {
            c.ok(new RegExp(`id: '${id}'`).test(achJs), `成就留在宿主：仍定义 ${id}`);
        }
    }

    console.log('\n=== 2. 生日补充提示词：宿主不再注入，改由插件 setPromptHint ===');
    {
        c.ok(!/ElainaBirthday/.test(stripComments(dataJs)), '★ data.js 不再读 ElainaBirthday.promptHint()');
        c.ok(/collectPromptHints\(\)/.test(dataJs),
            '★ 宿主仍保留插件提示词通道（collectPromptHints）—— 生日补充就走它');
    }

    console.log('\n=== 3. 公告与开场彩蛋的联动：宿主不再直接引用生日模块 ===');
    {
        c.ok(!/onEggDone/.test(stripComments(initJs)), '★ init.js 不再用 ElainaBirthday.onEggDone()');
        c.ok(/announcement-pending/.test(initJs),
            '★ 宿主广播 announcement-pending（"公告将要出现"，生日插件据此推迟彩蛋）');
        c.ok(/announcement-closed/.test(dataJs),
            '★ 关闭公告时广播 announcement-closed（在 closeAnnouncement 这个唯一出口里发）');
        c.ok(!/ElainaBirthday/.test(stripComments(initJs)), '★ init.js 里没有 ElainaBirthday');
    }

    console.log('\n=== 4. 宿主新 API（host.theme / storage / unlock / app-ready）===');
    {
        c.ok(/storage:\s*createModStorage\(/.test(modsJs), '★★ host.storage 已提供（落 data/ 的插件私有存储）');
        c.ok(/createModStorage\(modId\)/.test(modsJs), '★ 存储按插件 id 分区');
        c.ok(/theme\(spec\)\s*\{/.test(modsJs), '★★ host.theme(spec) 已提供');
        c.ok(/useTemplate/.test(modsJs) && /restoreTemplate/.test(modsJs),
            '★★ host.theme 的句柄带 use()/restore()（临时切主题再还原）');
        c.ok(/unlock\(id,\s*detail\)\s*\{/.test(modsJs), '★★ host.unlock(id, detail) 已提供（触发宿主成就）');
        c.ok(/markAppReady\(/.test(modsJs), '★★ markAppReady()（init 末尾广播 app-ready）');
        c.ok(/appReadyFired/.test(modsJs) && /event === 'app-ready' && (appReadyFired|isAppReady\(\))/.test(modsJs),
            '★★ app-ready 对晚注册的插件会补调（否则慢加载的插件永远等不到启动信号）');

        c.ok(/function registerTemplate/.test(themeJs), '★ theme.js 有 registerTemplate()');
        c.ok(/function unregisterTemplate/.test(themeJs), '★ theme.js 有 unregisterTemplate()');
        c.ok(/function useTemplate/.test(themeJs) && /function restoreTemplate/.test(themeJs),
            '★ theme.js 有 useTemplate()/restoreTemplate()');
        c.ok(/function allTemplates/.test(themeJs) && /allTemplates\(\)\.some/.test(themeJs),
            '★★ 主题校验走 allTemplates（内置 + 插件注册的），否则插件主题会被判非法回落');
        c.ok(/:not\(\[data-theme="dark"\]\)/.test(themeJs),
            '★★ 插件主题的注入样式带 :not([data-theme="dark"]) 守卫（否则会盖掉深色块）');
    }

    if (!existsSync(path.join(MOD, 'manifest.json'))) {
        console.log('\n=== 5. 插件 mods/birthday 就位：跳过 ===');
        console.log('  本地没有 mods/birthday/ —— 插件已改为应用内安装，源码不再随仓库分发。');
        return;
    }
    console.log('\n=== 5. 插件 mods/birthday 就位（清单 / 入口 / 样式）===');
    {
        const mfPath = path.join(MOD, 'manifest.json');
        c.ok(existsSync(mfPath), '★ manifest.json 存在');
        let mf = null;
        try { mf = JSON.parse(read(mfPath)); } catch (e) { /* 下面报出来 */ }
        c.ok(Boolean(mf), '★ manifest.json 是合法 JSON');
        if (mf) {
            c.ok(mf.id === 'birthday', "★ manifest.id = 'birthday'", String(mf.id));
            c.ok(mf.entry === 'index.js', '★ entry = index.js', String(mf.entry));
            c.ok(Array.isArray(mf.styles) && mf.styles.includes('style.css'), '★ styles 声明了 style.css');
            c.ok(mf.defaultEnabled === false,
                '★ defaultEnabled=false（插件默认关闭：它会在生日当天改动界面，不该在用户不知情时生效）');
        }

        const entryPath = path.join(MOD, 'index.js');
        c.ok(existsSync(entryPath), '★ index.js 存在');
        const mod = existsSync(entryPath) ? read(entryPath) : '';

        c.ok(/ElainaMods\.register\(MOD_ID/.test(mod) && /MOD_ID = 'birthday'/.test(mod),
            "★★ 用 ElainaMods.register('birthday') 注册，与 manifest.id 一致");

        c.ok(/host\.theme\(\{/.test(mod), '★★ 用 host.theme 注册「星屑之日」配色');
        c.ok(/'id':\s*THEME_ID|id:\s*THEME_ID/.test(mod), '★ 主题 id 用 THEME_ID 常量（= stardust）');
        c.ok(/THEME_ID = 'stardust'/.test(mod), "★ THEME_ID = 'stardust'");
        c.ok(/theme\.use\(\)/.test(mod) && /theme\.restore\(\)/.test(mod),
            '★★ 切主题 / 还原都用 host.theme 的句柄（不碰用户的主题偏好）');
        c.ok(/host\.storage\.get\(/.test(mod) && /host\.storage\.set\(/.test(mod),
            '★★ 状态读写走 host.storage（落 data/、跨设备同步）');
        c.ok(/host\.unlock\('stardust_day'/.test(mod) && /host\.unlock\('stardust_remembered'/.test(mod)
            && /host\.unlock\('stardust_makeup'/.test(mod),
            '★★ 三条纪念成就都用 host.unlock 上报');
        c.ok(/host\.setPromptHint\(/.test(mod) && /host\.clearPromptHint\(/.test(mod),
            '★★ 生日补充走 setPromptHint（不是生日时 clearPromptHint，日常对话不受影响）');
        c.ok(/host\.slot\('header\.actions'/.test(mod), '★★ 顶栏蛋糕按钮走 header.actions 插槽');
        c.ok(/host\.on\('app-ready'/.test(mod), '★★ 等 app-ready 再读盘/启动看门狗');
        c.ok(/host\.on\('announcement-closed'/.test(mod),
            '★★ 订阅 announcement-closed：首次公告关闭后才演开场彩蛋');
        c.ok(/host\.require\('elaina-avatar'\)/.test(mod),
            '★ 立绘走 host.require（不自己拼资源路径）；缺失时降级不显示人像');
        c.ok(!/Store\.(getItem|setItem|removeItem)/.test(mod),
            '★★ 插件不直接用宿主 Store 的读写（只走 host.storage）');

        // 台词与提示词文案必须原样保留
        c.ok(mod.includes('今天？……哼，你居然记得。那就特别允许你陪我一天吧。'), '★ 开场台词保留');
        c.ok(mod.includes('明天我就要继续旅行了。明年今日，如果你还在，也许我会回来。'), '★ 告别台词保留');
        c.ok(mod.includes('BIRTHDAY_PROMPT'), '★ 生日补充提示词常量在');
        for (const s of ['不是用户的生日', '寿星本人', '蘑菇', '魔女的愿望说出来就不灵了', '仍然完全按角色卡执行']) {
            c.ok(mod.includes(s), '★ 生日提示词含关键内容「' + s + '」');
        }
        c.ok(/18\s*岁/.test(mod), '★ 写明 18 岁生日');
        const modCode = stripComments(mod);
        c.ok(!/【身份与外貌】/.test(modCode) && !/【人格核心】/.test(modCode),
            '★★ 生日补充**不重复**角色卡已有的身份类小节（只出现在解释它的注释里不算）');
        c.ok(/setInterval\(watchdogTick,\s*15\s*\*\s*1000\)/.test(mod),
            '★ 日期看门狗 15 秒一次（改了系统时间不用重启就能跟上）');
        c.ok(/addEventListener\('focus'/.test(mod) && /addEventListener\('pageshow'/.test(mod),
            '★★ focus / pageshow 也会立刻对齐（用户报的"改完时间必须重启"就是缺这个）');

        c.ok(mod.includes('与伊蕾娜一起过生日'), '★ 生日面板按钮文案 = 「与伊蕾娜一起过生日」');
        c.ok(!/先这样/.test(modCode), '★★ 旧的「先这样」按钮已移除');
        c.ok(mod.includes('SCENARIO_PROMPT') && mod.includes('我想做个蛋糕。'),
            '★★ 情景演绎剧本（用户给定原文）在源码里');
        c.ok(/host\.unlock\('stardust_together'/.test(mod),
            '★★ 开始演绎时上报成就 stardust_together（今天的特别之处）');
        c.ok(/host\.sendUserMessage\(/.test(mod),
            '★★ 开始演绎走 host.sendUserMessage（宿主的"以角色身份说话"链路）');
        c.ok(/AFFINITY_MAX/.test(mod) && /st\.affinity/.test(mod), '★ 好感度数值落插件自己的状态（host.storage）');

        const cssPath = path.join(MOD, 'style.css');
        c.ok(existsSync(cssPath), '★ style.css 存在');
        const modCss = existsSync(cssPath) ? read(cssPath) : '';
        for (const sel of ['#mainContent { position: relative; }', '.birthday-chat-decor', '.birthday-egg', '.bd-panel', '.birthday-farewell']) {
            c.ok(modCss.includes(sel), '★ style.css 含 ' + sel);
        }
        c.ok(/:not\(\[data-theme="dark"\]\)/.test(modCss) || /html\[data-theme="dark"\]/.test(modCss),
            '★ style.css 有深色覆盖（花纹/面板不出现"一块块白"）');
    }

}

//__INSERT_LONG_CASES__

const only = process.argv[2];
const allCases = [
    { name: '主题系统', fn: caseTheme, from: 'check-theme' },
    { name: '日记浏览', fn: caseDiary, from: 'check-diary' },
    { name: '生日模块', fn: caseBirthday, from: 'check-birthday' },
    { name: 'Live2D 资源解析', fn: caseLive2dAssets, from: 'check-live2d-assets' },
    { name: '内置模型列表（双实现）', fn: caseLive2dNativeList, from: 'check-live2d-native-list' },
    { name: '原生响应形状', fn: caseNativeResponse, from: 'check-native-response' },
    { name: '场景背景资源包', fn: caseSceneBackgrounds, from: 'check-scene-backgrounds' },
];
const cases = only ? allCases.filter((x) => x.name.includes(only) || x.from.includes(only)) : allCases;

await runChecks({
    title: '界面与表现（主题 / 日记 / 生日 / Live2D / 场景背景）',
    usage: 'node scripts/check-ui.mjs [用例名子串]',
    cases,
});
