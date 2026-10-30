// 界面与表现相关回归检查：主题 / 日记 / 生日 / Live2D 资源 / 场景背景 / 内置模型列表。
// 合并自八个脚本（check-theme / check-diary / check-birthday / check-live2d-assets /
// check-live2d-native-list / check-native-response / check-bundled-models /
// check-scene-backgrounds）。它们测的都是"用户眼睛能看到的那一层"——
// 主题配色、日记浏览、生日彩蛋、模型列表与资源 URL —— 共用同一份 readFrontend()
// 与同一批 mods/ 实物，拆成八个文件时各自抄一遍 ok/汇总/端口工具。
// 每段用例在自己的函数作用域里跑，同名局部变量（ROOT / WEB / html / src）不会互相踩，
// 失败信息形如「日记浏览 :: ★ 点侧栏能筛出该对话」。
// 用法：node scripts/check-ui.mjs          跑全部
//       node scripts/check-ui.mjs 主题     只跑名字含该子串的用例

import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, statSync, mkdirSync, copyFileSync, writeFileSync, openSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFrontend } from './frontend-sources.mjs';
import { launchTestBrowser } from './test-browser.mjs';
import { runChecks, ROOT, wait, waitServerUp, freePort } from './check-harness.mjs';
import { extractFunction as extractFnFrom, stripComments as stripCommentsOf } from './check-source.mjs';

const WEB = path.join(ROOT, 'web');
const MODS = path.join(ROOT, 'mods');

// 源码抽取与去注释统一来自 check-source.mjs（跳过字符串/注释的花括号配对）。

/** 按 manifest.id 找插件真实目录（用户可能改过目录名） */
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

// Live2D 表情/动作的「解析 + 资源 URL 拼接」
// 模型并不都把 *.exp3.json / *.motion3.json 放在 exp/ 子目录里 —— Cubism 只规定
// 文件格式，放哪由模型作者决定。仓库内置的 deepseek 把 44 个表情直接堆在模型根目录、
// 8 个动作放在 motions/，早期把 'exp/' 写死在 URL 上的实现因此让表情/动作全部 404，
// 表现出来就是"打包进去的模型没有表情"。
// 做法：用字符串切片把 mods/live2d/index.js 里的真实函数体抠出来，在 Node 里喂真实
// 清单跑一遍。不复制逻辑（复制的话测的就不是真代码了），也不依赖浏览器。

async function caseLive2dAssets(c) {
    /* 插件不随仓库分发（仓库只推软件本体，插件走应用内上传安装）—— 本地没有 mods/live2d
       是正常状态，跳过而不是抛异常（否则 npm run check 在干净克隆里永远红）。 */
    if (!existsSync(path.join(MODS, 'live2d', 'index.js'))) {
        console.log('  --   跳过：本地没有 live2d 插件（插件不随仓库分发，这是正常状态）');
        return;
    }
    const src = readFileSync(path.join(MODS, 'live2d', 'index.js'), 'utf8');
    const extractFn = (name) => extractFnFrom(src, name, 'mods/live2d/index.js');

    /** 把被测函数放进一个带桩变量的作用域里求值 */
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

    // 真实清单（取自修复后的 /api/live2d/models）
    const EXPS = ['love.exp3.json', '兔兔贴纸.exp3.json', '脸红.exp3.json', '星星眼.exp3.json', '哭.exp3.json', '晕晕.exp3.json'];
    const MOTIONS = ['aidale.motion3.json', 'motions/chuipaopao.motion3.json', 'motions/idle.motion3.json', 'motions/自拍.motion3.json'];
    const L = buildHarness({ exps: EXPS, motions: MOTIONS, known: true });

    // 1) URL 拼接：根目录文件 / 子目录文件 / 中文名 / 子目录+中文名
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

    // 2) 注入防护仍然有效（表情名会被拼进 URL 路径）
    check('路径穿越被挡', L.sanitizeAssetName('../../x'), '');
    check('斜杠被挡', L.sanitizeAssetName('motions/idle'), '');
    check('正常名放行', L.sanitizeAssetName('脸红'), '脸红');

    // 3) 表情解析
    check('精确名 -> 根目录表情', L.resolveExpressionFile('脸红'), '脸红');
    check('语义映射 happy -> 星星眼', L.resolveExpressionFile('happy'), '星星眼');
    check('语义映射 blush -> 脸红', L.resolveExpressionFile('blush'), '脸红');
    check('模糊匹配 兔兔 -> 兔兔贴纸', L.resolveExpressionFile('兔兔'), '兔兔贴纸');
    check('不存在的表情返回空串（不再发注定 404 的请求）', L.resolveExpressionFile('完全不存在的东西'), '');

    // 4) 动作解析（关键修复点）
    check('动作精确名 -> 根目录动作', L.resolveMotionFile('aidale'), 'aidale');
    check('动作名 -> motions/ 子目录', L.resolveMotionFile('idle'), 'motions/idle');
    check('语义映射 wave -> 常规（清单里没有 -> 空）', L.resolveMotionFile('wave'), '');

    // 5) 解析结果拼 URL 后必须是清单里的真实路径
    check('表情解析结果拼 URL 后可用',
        L.modelAssetUrl('deepseek', L.resolveExpressionFile('脸红') + '.exp3.json'),
        '/live2d/models/deepseek/%E8%84%B8%E7%BA%A2.exp3.json');
    check('子目录动作解析结果拼 URL 后可用',
        L.modelAssetUrl('deepseek', L.resolveMotionFile('idle') + '.motion3.json'),
        '/live2d/models/deepseek/motions/idle.motion3.json');

    // 6) 清单已知且为空 → 直接放弃，避免 404 风暴（伊蕾娜·默认 就是这种）
    const E = buildHarness({ exps: [], motions: [], known: true });
    check('无表情模型：清单已知且为空 -> 放弃', E.resolveExpressionFile('脸红'), '');
    check('无动作模型：清单已知且为空 -> 放弃', E.resolveMotionFile('idle'), '');
}

// 模型列表的「服务端实现」与「Capacitor 原生实现」必须给出同样的结果
// APK 里没有 Node 服务端，模型列表由 index.html 里的 nativeLive2dFetch() 用
// Capacitor Filesystem 自己实现；Web 版走 live2d-models 插件的 listModels()。
// 这是**同一套语义的两份代码**（都要递归扫描、都优先取根目录的 model3.json /
// vtube.json、都要把 exps/motions 表达成相对模型根目录的路径），非常容易各改各的、
// 悄悄跑偏 —— 而原生那份只有在真机上才能验证。
// 做法：把两边的真实函数体抠出来，喂**同一个真实模型目录**，原生那份的
// Capacitor Filesystem 用 Node fs 做一个等价桩，最后深比对两边输出。

async function caseLive2dNativeList(c) {
    // 目录名可能带版本号（live2d-models-1.0.0），按 manifest.id 解析 —— 写死目录名会让
    // 这个用例在“插件装了但目录带版本”的环境里静默跳过（本仓库正是这种情况）。
    const modDir = modDirById('live2d-models');
    if (!modDir || !existsSync(path.join(MODS, modDir, 'server.mjs'))) {
        console.log('  --   跳过：本地没有 live2d-models 插件（插件不随仓库分发，这是正常状态）');
        return;
    }
    // 模型已搬进资源 mod：mods/<dir>/models/。
    // 插件包本身可能不带模型（模型由用户在界面里单独安装），那种环境按“没有夹具”跳过，
    // 不判红 —— 否则干净安装的仓库会永远红在这一项。
    const MODELS_ROOT = path.join(MODS, modDir, 'models');
    if (!existsSync(MODELS_ROOT)) {
        console.log('  --   跳过：live2d-models 插件没有 models/ 目录（模型需单独安装，这是正常状态）');
        return;
    }

    // ==================== 服务端实现 ====================
    // 这两个函数住在 `export function register(ctx)` 里面（闭包内的函数声明），
    // extractFn 照样能按大括号配对抠出来。唯一的新依赖是 `ctx.json`：搬家前它们
    // 直接操作 res.writeHead/end，搬家后用宿主注入的 ctx.json。这里注入等价桩。
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

    // ==================== Capacitor 原生实现 ====================
    const htmlSrc = readFrontend();
    /**
     * Capacitor Filesystem 的等价桩：readdir 返回 { files: [{ name, type, size }] }。
     * 关键：Capacitor 的 path 是**相对应用数据目录**的（`live2d/models`、
     * `live2d/models/deepseek`），这里把数据目录映射到仓库里的真实模型目录，
     * 所以必须先剥掉 `live2d/models` 前缀，否则会拼成 .../live2d/models/live2d/models
     * —— readdir 抛错、被上层的 try/catch 吞掉，表现为"原生实现返回空列表"。
     */
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

    // ==================== 跑两边，深比对 ====================
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

    // 独立断言几个关键事实，防止"两边一起错成一样"
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

    // exps/motions 里列出的每个文件都必须真实存在（拼 URL 时不能 404）
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

// APK 里「内置模型识别不到」的**真正根因**
// 视频通话里的列表走 refreshModelList() → fetch(...).json()
// 设置面板里的列表走 refreshLive2DSettingList() → readJsonSafe(res) → **await res.text()**
// 而 nativeLive2dFetch 返回的假 Response 只有 json()，没有 text()。
// 于是设置里那条路：res.text is not a function → 被 catch 吞掉 → 列表静默为空。
// **同一个接口两条调用路径，只有一条炸** —— 这就是为什么一开始只改了
// refreshModelList 却"没解决问题"。

async function caseNativeResponse(c) {
    const html = readFrontend();

    // ============================================================ 1. 源码层
    {
        const fnStart = html.indexOf('async function nativeLive2dFetch(');
        const fnEnd = html.indexOf('return { ', fnStart) > 0 ? html.indexOf('return { ', fnStart) : html.length;
        const body = html.slice(fnStart, fnEnd);

        // 构造假 Response 的地方必须用 makeRes / json 包装
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

    // ============================================================ 2. 行为层：走设置面板的真实路径
    // 清单**可能不存在** —— `npm run sync:web:lite`（纯净版 APK）不打包模型，
    // 改走扩展包分发。判据：lite 模式下 www/live2d/models 整个目录都不存在。
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

    // 空数据目录（模拟播种失败）—— 正是用户遇到的状态
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

    // ============================================================ 3. 视频通话那条路径也不能坏
    {
        const r = await vm.runInContext(`nativeLive2dFetch('/api/live2d/models', { method: 'GET' }).then(r => r.json())`, sandbox);
        const list = (r && r.models) || [];
        if (liteMode) {
            c.ok(Array.isArray(list), '纯净版：json() 路径仍返回数组（接口形状没坏）');
        } else {
            c.ok(list.length === manifestObj.models.length, 'json() 路径同样返回全部模型', String(list.length));
        }
    }

    // ============================================================ 4. 错误响应也带 text()
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

    // ============================================================ 5. 所有出口都覆盖到
    {
        const fnStart = html.indexOf('async function nativeLive2dFetch(');
        const body = html.slice(fnStart, html.indexOf('// 字节 → base64', fnStart));
        const returns = [...body.matchAll(/return\s+(\{[\s\S]{0,120}?\};)/g)].map((m) => m[1]);
        const bad = returns.filter((r) => /json:\s*async/.test(r) && !/makeRes/.test(r));
        c.ok(bad.length === 0, '所有 return 的响应都走 makeRes/json', bad.slice(0, 2).join(' | '));
    }
}

// 场景背景资源包（scene-backgrounds）
// 这个包有一个**静默失效**的典型风险：背景图放在 img/bg/ 里，而清单
// （index.js 的 BGS 数组）是另一处维护的。两者不一致时**不会报错**：
//   · 目录里有图、清单漏登记 → 那张图在界面上**选不到**（用户以为图丢了）
//   · 清单登记了、目录里没图 → 界面上那张图是**裂图/空白**
// 而这两个现象都不像"清单写错了"，排查方向天然会跑偏。

async function caseSceneBackgrounds(c) {
    // ============================================================ 1. 清单 ↔ 文件
    const dir = modDirById('scene-backgrounds');
    if (!dir) {
        console.log('  --   跳过：本地没有 scene-backgrounds / galgame 插件（插件不随仓库分发，这是正常状态）');
        return;
    } else {
        c.ok(true, '找到 scene-backgrounds 插件（目录 ' + dir + '）');
        const indexSrc = readFileSync(path.join(MODS, dir, 'index.js'), 'utf8');
        const bgDir = path.join(MODS, dir, 'img', 'bg');

        // 从 BGS 数组里抠出文件名：形如 ['snowy_street', '雪之街']
        const listed = [...indexSrc.matchAll(/\[\s*'([A-Za-z0-9_\-]+)'\s*,\s*'[^']*'\s*\]/g)].map((m) => m[1]);
        c.ok(listed.length >= 30, 'BGS 清单里有 ' + listed.length + ' 条（应 ≥30）');
        // 清单里不该有重复文件名（重复的话界面上会出现两张同名图）
        const dupList = listed.filter((x, i) => listed.indexOf(x) !== i);
        c.ok(dupList.length === 0, '清单里没有重复的文件名', JSON.stringify([...new Set(dupList)]));

        let files = [];
        try { files = readdirSync(bgDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)); } catch { /* 目录不存在 */ }
        c.ok(files.length > 0, 'img/bg/ 里有图片（' + files.length + ' 个）', bgDir);

        const fileBase = new Set(files.map((f) => f.replace(/\.(jpe?g|png|webp)$/i, '')));
        const listSet = new Set(listed);

        // 清单登记了、但目录里没有 → 界面上是裂图（最容易被忽略的一种）
        const missingFiles = listed.filter((n) => !fileBase.has(n));
        c.ok(missingFiles.length === 0,
            '★ 清单里每一项都有对应的图片文件（没有裂图）',
            missingFiles.length ? '缺文件：' + missingFiles.join('、') : '');

        // 目录里有、但清单没登记 → 那张图在界面上选不到（静默失效）
        const notListed = [...fileBase].filter((n) => !listSet.has(n));
        c.ok(notListed.length === 0,
            '★ img/bg/ 里每个文件都在清单里登记了（否则选不到）',
            notListed.length ? '未登记：' + notListed.join('、') : '');

        // 中文标签不该重复（重复会让 pick() 的"精确匹配标签"产生歧义）
        const labels = [...indexSrc.matchAll(/\[\s*'[A-Za-z0-9_\-]+'\s*,\s*'([^']*)'\s*\]/g)].map((m) => m[1]);
        const dupLabel = labels.filter((x, i) => x && labels.indexOf(x) !== i);
        c.ok(dupLabel.length === 0, '中文标签没有重复', JSON.stringify([...new Set(dupLabel)]));

        // 接口齐全（判据宽松：`function xxx(` 或 `const xxx =` 都算 —— 实现形式不该被锁死）
        for (const fn of ['list', 'url', 'label', 'has', 'pick']) {
            const asFn = new RegExp('function\\s+' + fn + '\\s*\\(').test(indexSrc);
            const asConst = new RegExp('const\\s+' + fn + '\\s*=').test(indexSrc);
            c.ok(asFn || asConst, '提供 ' + fn + '()');
        }
        // 基址不能写死目录名（id 与实际目录名可能不一致 → 全部 404）
        c.ok(/host\.assetBase/.test(indexSrc),
            '★ 用 host.assetBase() 取真实目录（不写死 /mods/scene-backgrounds/）');
        c.ok(/ElainaMods\.register\(/.test(indexSrc), '用 ElainaMods.register 注册');
    }

    // ============================================================ 2. 两个消费方
    {
        // galgame 用背景 → 必须声明依赖，并在代码里走资源包
        const galSrc = dir ? readFileSync(path.join(MODS, modDirById('galgame') || 'galgame', 'index.js'), 'utf8') : '';
        c.ok(/host\.require\('scene-backgrounds'\)/.test(galSrc),
            '★ galgame 通过 host.require 取背景（不自己拼路径）');
        const galMf = JSON.parse(readFileSync(path.join(MODS, modDirById('galgame') || 'galgame', 'manifest.json'), 'utf8'));
        c.ok(Array.isArray(galMf.after) && galMf.after.includes('scene-backgrounds'),
            '★ galgame 的 manifest.after 声明了 scene-backgrounds', JSON.stringify(galMf.after));

        // 视频通话用背景，但**不该**声明依赖 —— 背景是可选加分项，
        // 声明依赖会让"没装背景包"直接拒绝加载视频通话（过度约束）
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
        // galgame 里不该再留着背景图（搬走了）
        const galBg = path.join(MODS, modDirById('galgame') || 'galgame', 'img', 'bg');
        const stillThere = existsSync(galBg) ? readdirSync(galBg).filter((f) => /\.(jpe?g|png)$/i.test(f)) : [];
        c.ok(stillThere.length === 0, '★ galgame 下不再留背景图（避免两份重复占体积）',
            stillThere.length ? stillThere.length + ' 个残留' : '');
    }

    // ============================================================ 3. 真服务
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
                // 取一张真实存在的图（从清单里挑第一张，不写死）
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
                // 清单接口里也应列出这个插件
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

// 多主题系统（源码层）
// 浏览器端的行为验证在 android-app/test/theme.test.mjs（那里有 playwright）。
// 这里只做静态检查 —— 根目录脚本不依赖浏览器，这是本项目的既有约定。
// 盯住的几个点（都是踩过的）：
//   · 默认主题必须"不设属性"，否则覆盖层会对默认外观生效（破坏"原样不动"）
//   · 覆盖规则权重必须够 —— 项目里已有一层用 ID 选择器覆盖 indigo 类的规则，
//     类级选择器压不住它
//   · 底色在 #mainContent 而不是 body
//   · themes.css 必须排在所有样式之后

/**
 * 取 `marker { ... }` 的花括号内容（配对扫描）。
 *
 * 为什么不能 `indexOf('}')`：注释里也有 `}`，会提前截断 —— 实测截断后只看到
 *   前几个变量，报出一批假失败。放在模块级是因为主题断言里有好几处都要用它。
 */
/**
 * 同 cssBlockAfter，但把**所有**同名块拼起来。
 *
 * 为什么需要：v2 把默认外观拆成多个 `html.rd { }` 块（尺寸一块、配色一块），
 *   只取第一个会漏掉全部配色令牌，断言就会误报"默认外观什么都没定义"。
 */
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
        c.ok(/<script src="\/js\/theme\.js"><\/script>/.test(html), 'index.html 引入 theme.js');
        c.ok(/<link rel="stylesheet" href="\/css\/themes\.css">/.test(html), 'index.html 引入 themes.css');

        // ★ themes.css 必须排在所有内联 <style> 之后（同权重靠后加载胜出）
        const cssLinkIdx = html.indexOf('/css/themes.css');
        const lastStyleEnd = html.lastIndexOf('</style>');
        c.ok(cssLinkIdx > lastStyleEnd, '★ themes.css 排在所有内联 <style> 之后',
            'link@' + cssLinkIdx + ' lastStyleEnd@' + lastStyleEnd);

        // 设置界面容器
        c.ok(/id="themePickerBox"/.test(html), '设置里有 #themePickerBox');
        c.ok(/id="headerThemeBtn"/.test(html), '深色模式控件已移到顶栏（#headerThemeBtn）');
    }

    console.log('\n=== 2. 默认主题与内置模板（v2 令牌体系）===');
    {
        const js = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
        // 默认主题必须走"移除属性"这条路径：不设 data-theme-template 时
        //   一条覆盖规则都不生效，页面就是 :root / html.rd 里的那套配色。
        c.ok(/removeAttribute\('data-theme-template'\)/.test(js),
            '★ 默认主题走 removeAttribute（不设属性 → 覆盖规则一条都不生效）');
        // v2 重构后默认模板 id 是 majo（暗夜魔女书房）；旧 id elaina 仍必须被当作默认处理，
        //   否则存量用户存着的 'elaina' 会被判成"未知模板"而落到兜底分支之外。
        c.ok(/'majo'/.test(js), '默认模板 id 为 majo（v2 视觉体系）');
        c.ok(/['"]elaina['"]/.test(js), '旧默认 id elaina 仍被识别（存量设置回落默认）');

        // 内置模板（4 套预设）
        // ★ 只从 TEMPLATES 数组里取：别处出现同样形状的 { id, name } 条目时，
        //   全局扫会把它们混进模板清单（数出比实际多）。
        const tplBlock = (js.match(/const TEMPLATES = \[[\s\S]*?\n\s*\];/) || [''])[0];
        c.ok(tplBlock.length > 0, '能取到 TEMPLATES 数组');
        const ids = [...tplBlock.matchAll(/\{\s*id:\s*'(\w+)',\s*name:/g)].map((m) => m[1]);
        // 「自定义」与插件注册的模板（如 mods/birthday 用 host.theme() 注册的「星屑之日」）
        //   都不属于**内置**清单，这里只钉内置的那几套。
        c.ok(ids.length === 4, '定义了 4 套内置模板，实得 ' + ids.length, ids.join(','));
        for (const id of ['majo', 'olive', 'mist', 'glass']) {
            c.ok(ids.includes(id), '含模板 ' + id);
        }
        // 已下线的模板 id 不再存在：存量用户存着它们时会回落到默认主题。
        //   amber / plum 是上一代浅色主题；ios / claude / sakura 是更早的一代。
        for (const id of ['amber', 'plum', 'ios', 'claude', 'sakura']) {
            c.ok(!ids.includes(id), '旧模板 id 已移除：' + id);
        }
        // 深色只有一套中性色：基调用一个属性切换多套，等于"设置里选了没生效"
        // 的另一种形态 —— 属性还在写、脚本没了，所以这里钉住它不回来。
        c.ok(!/data-dark-base/.test(js), 'theme.js 不再写 data-dark-base（深色只有一套中性色）');
        c.ok(!/DARK_BASES/.test(js), 'theme.js 不再定义 DARK_BASES');
    }

    console.log('\n=== 3. 覆盖权重（踩过的坑）===');
    {
        const css = readFileSync(path.join(WEB, 'css', 'themes.css'), 'utf8');
        // ★ v2 把配色从 --pixso-* 换成了 --rd-* 令牌（见「3b. v2 令牌体系」）：
        //   下面这一组是针对**旧变量体系**的断言，已随重构下线，保留注释只作背景。
        const LEGACY_PIXSO_ASSERTS = false;

        // ★★ 覆盖主色令牌 —— v2 的"配色割裂会重现"检查点。
        // 历史教训不变：只覆盖 --color-* / text-indigo-* 时，切主题只有聊天区变色，
        //   侧栏/外框/按钮/强调色全不动。v2 把配色收拢到 --rd-* 令牌（appearance 由
        //   html.rd 承接），所以这里改为钉住这套令牌本身：块在、关键成员齐、跨主题能覆盖。
        const rdCount = (css.match(/--rd-[a-z0-9-]+:/g) || []).length;
        c.ok(rdCount >= 40, '★ 定义了 --rd-* 令牌（v2 配色的唯一来源，实得 ' + rdCount + ' 处）');
        // 默认外观拆在几个 html.rd 块里（尺寸 / 配色各一块），必须合并后判，
        //   否则第一块只有 --rd-rail-w，会误报"一个配色令牌都没有"。
        const rootBlock = cssBlocksAfter(css, 'html.rd {');
        for (const v of ['--rd-bg', '--rd-surface', '--rd-panel', '--rd-text',
            '--rd-accent', '--rd-accent-strong', '--rd-border']) {
            c.ok(rootBlock.includes(v + ':'), '★ 默认外观定义了 ' + v);
        }
        c.ok(cssBlockAfter(css, 'html.rd[data-theme="dark"] {').length > 0,
            '★ 深色块存在（html.rd[data-theme="dark"]）');

        // ★★★ 内置模板的关键色必须与设计稿一致
        // 这些值是成体系定下来的（画布带色相、卡片留暖白、正文接近深墨），
        // 逐个钉住，防止以后"顺手调一下"把关系破坏掉。
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

        // ★ 深色唯一一套中性色的关键值（深蓝炭底 + 暖白字）
        const darkNeutralColors = [
            ['#0b0e15', '画布'],
            ['#121722', '外壳'],
            ['#f0e8d8', '正文'],
        ];
        for (const [hex, label] of darkNeutralColors) {
            c.ok(css.includes(hex), '★ 深色中性色：' + label + ' = ' + hex);
        }
        // 已移除的基调选择器不该留下残影
        c.ok(!/data-dark-base/.test(css), 'themes.css 不再有 data-dark-base 选择器');

        // ★ 深色不再写死冷色高亮
        c.ok(!/#0a84ff/i.test(css), '★ 深色不再写死 iOS 蓝 #0a84ff');
        c.ok(!/#5ca8ff/i.test(css), '★ 深色文字高亮不再写死 #5ca8ff');
        c.ok(!/rgba\(\s*30\s*,\s*46\s*,\s*80/.test(css), '★ 深色 AI 气泡不再写死藏青渐变');

        // ★ 侧栏竖栏改用独立的 --rd-rail-* 令牌（不复用文字色变量，否则深色下竖栏发白）
        c.ok(/--rd-rail-bg:/.test(css) && /--rd-rail-bg-2:/.test(css),
            '★ 侧栏竖栏有独立的 --rd-rail-bg / --rd-rail-bg-2 令牌');

        // ★ 深色三态（浅色/深色/跟随系统）
        const themeJs = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
        c.ok(/DARK_MODES\s*=\s*\[[^\]]*'system'/.test(themeJs), '★ theme.js 支持三态（含 system）');
        c.ok(/prefers-color-scheme:\s*dark/.test(themeJs), '★ 用 matchMedia 检测系统深色偏好');
        c.ok(/addEventListener\('change'/.test(themeJs), '★ 监听系统主题变化（跟随系统要实时响应）');
        c.ok(/applyDarkMode/.test(themeJs), '落 DOM 的逻辑统一在一个入口（用户改 / 系统变都走它）');

        const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
        // ★ 2026-10：深色模式从「外观」里的三态下拉**搬到顶栏的三段连体开关**
        //   （跟随设备 / 浅色 / 深色，用户按截图设计），「跟随系统」改名为「跟随设备」。
        c.ok(/id="headerThemeBtn"/.test(html), '★ 外观模式开关已移到顶栏（#headerThemeBtn）');
        c.ok(/data-mode="system"/.test(html) && /跟随设备/.test(html), '★ 含「跟随设备」段（原跟随系统）');
        c.ok(/data-mode="light"/.test(html) && /data-mode="dark"/.test(html), '★ 含浅色与深色两段');
        c.ok(/\.is-active/.test(html), '★ 选中段有 .is-active（填充圆底）');
        c.ok(!/id="themeDarkMode"/.test(html), '★ 原「外观 → 深色模式」下拉已删除');

        // ★ 主题规则的权重必须压得住既有规则（v2 的承载体是 html.rd 上的令牌，
        //   不再靠逐类覆盖 Tailwind 工具类 —— 用令牌的好处是"改一处、全站生效"）。
        c.ok(/html\.rd\[data-theme="dark"\]/.test(css) && /html\.rd\[data-theme-template="olive"\]/.test(css),
            '★ 主题与深色都以 html.rd[attr] 提权（与项目里既有的 ID 级规则同层或更高）');
        // 令牌体系成立的前提：不再逐个压 Tailwind 的 indigo 工具类（压了说明有人又在打权重战）
        c.ok(!/text-indigo-/.test(css), '★ 不再逐类覆盖 text-indigo-*（配色由令牌统一改）');
        // 侧栏/弹窗的配色来自令牌，而不是在主题层点名组件
        c.ok(/--rd-rail-bg:/.test(css) && /--rd-panel:/.test(css),
            '★ 侧栏与弹窗面板配色来自令牌（--rd-rail-bg / --rd-panel）');

        // v2 不靠 !important 打架（整份 themes.css 里一处都没有）：主题是否生效只看令牌有没有定义，
        //   所以这里钉住"不新增 !important" —— 新增往往意味着有人又去逐类覆盖工具类了。
        const importantCount = (css.match(/!important/g) || []).length;
        c.ok(importantCount === 0, '★ themes.css 不靠 !important 覆盖（令牌体系下应为 0 处，实得 ' + importantCount + '）');

        // 深色与模板正交（majo 是默认，不设属性、没有独立块）
        c.ok(/html\.rd\[data-theme="dark"\]/.test(css), '有 html.rd[data-theme="dark"] 规则');
        for (const tpl of ['olive', 'mist', 'glass']) {
            c.ok(css.includes('html.rd[data-theme-template="' + tpl + '"]'), '★ 模板 ' + tpl + ' 有变量定义');
        }

        // ★★ 主题变量完整性 + 硬编码白色防护（2026-10 用户报"深色下顶栏还是白的"）
        // 这一组断言防的是**同一类 bug**：某处用了 `var(--pixso-xxx)`，但那个变量
        // 在深色块 / 主题块里**没被覆盖**，于是它永远停在 :root 的浅色值上。
        // 实测踩到两次：
        //   ① `--pixso-surface` 只在 :root 定义（#ffffff），深色块漏了它 ——
        //      而 `#appShell` 用的正是它 → 深色下**整个应用外壳纯白**（手机全屏，等于整页白底）。
        //   ② `#mainContent > header` 直接写死 `background: #fff` —— 深色下顶栏一块白方块。
        // 这类 bug 的特点是**只在某个主题/模式下才看得见**，光读代码很难发现。

        // ① 深色块必须覆盖所有"面"级变量（漏一个就有一块浅色残留）
        const darkBlock = cssBlockAfter(css, 'html.rd[data-theme="dark"] {');
        for (const v of ['--rd-bg', '--rd-surface', '--rd-surface-2', '--rd-surface-3',
            '--rd-panel', '--rd-border', '--rd-text', '--rd-text-2', '--rd-text-3']) {
            c.ok(darkBlock.includes(v + ':'), '★ 深色块覆盖了 ' + v);
        }
        // 强调色与侧栏也必须在深色块里单独给（不能只靠浅色值派生）
        for (const v of ['--rd-accent', '--rd-accent-strong', '--rd-rail-bg']) {
            c.ok(darkBlock.includes(v + ':'), '★ 深色块覆盖了 ' + v);
        }

        // ② 每套主题模板块也要覆盖"面"级变量（否则切主题后外壳仍是上个主题的白）
        // majo（暗夜魔女书房）是默认外观，不设 data-theme-template —— 所以它**没有**独立块，
        //   由上面的 html.rd 块承担；这里钉住"别给它再加一个块"（加了反而说明默认路径变了）。
        c.ok(!css.includes('html.rd[data-theme-template="majo"]'),
            '★ majo 是默认外观（不写独立模板块，靠 html.rd 承接）');
        for (const tpl of ['olive', 'mist', 'glass']) {
            const block = cssBlockAfter(css, `html.rd[data-theme-template="${tpl}"] {`);
            c.ok(block.length > 0, `存在主题块 ${tpl}`);
            for (const v of ['--rd-bg', '--rd-surface', '--rd-accent', '--rd-warn']) {
                c.ok(block.includes(v + ':'), `★ 主题 ${tpl} 定义了 ${v}`);
            }
        }

        // ②b 警示色必须每个生效来源都有（默认外观 + 每套模板 + 深色）
        //   取不到值时 var() 落回继承色，"警示"语义直接丢掉（看起来跟普通说明一样）。
        // v2 的警示色是 --rd-warn（--pixso-warn 只留了兼容别名，见 themes.css 顶部）
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

        // ③ 移动端块里不能有"写死的白色面"。
        //    为什么专挑移动端：手机是全屏 #appShell，写死的白会变成**整页白底**，
        //    而桌面端只是中间一块卡片，不明显 —— 用户就是在手机上发现顶栏发白的。
        //   ★ 块范围要用花括号配对取，不能 `slice(indexOf('@media'))` ——
        //     那样会一路包含到文件末尾的**其它**媒体查询（实测误报了 4 处别的规则）。
        const mobileBlock = cssBlockAfter(html, '@media (max-width: 860px) {');
        // 允许的白色：文字色/阴影/描边这类"非面"用途。这里只禁**大面积背景**写死纯白。
        const badWhiteBg = [];
        for (const m of mobileBlock.matchAll(/background(?:-color)?:\s*(#[fF]{3,6}|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\.[5-9]\d*\s*\))/g)) {
            const line = mobileBlock.slice(0, m.index).split('\n').length;
            // 注释里的说明文字不算（本文件有几处刻意引用旧值的注释）
            const before = mobileBlock.slice(Math.max(0, m.index - 260), m.index);
            if (/\/\*[^*]*$/.test(before)) continue;
            badWhiteBg.push(`第 ${line} 行附近: ${m[0]}`);
        }
        c.ok(badWhiteBg.length === 0,
            '★ 移动端块里没有写死的白色背景面（深色下会变白块，用户实测报过）',
            badWhiteBg.slice(0, 4).join('  |  '));

        // ④ ★★ 设置页里的"内联浅色底"必须被主题规则接管
        //    这类面板（Agent 权限 / 隐私开关）用内联 style 写死了浅色底 + 深色字。
        //    深色下文字那一半会被主题改成浅色，底却还是写死的浅色 → 浅底浅字，几乎看不见。
        //    修法是用属性选择器统一接管，而不是逐个 class 改 —— 新增同类面板自动覆盖。
        const inlineLightRules = [
            { re: /#settingsPanel \[style\*="rgba\(249,249,255"/, label: '信息类浅色面板' },
            { re: /#settingsPanel \[style\*="rgba\(255,247,237"/, label: '警示类浅色面板' },
            { re: /#settingsPanel \[style\*="color:#b45309"\]/, label: '警示文字色' },
        ];
        for (const r of inlineLightRules) {
            c.ok(r.re.test(html), `★ 设置页的内联浅色底被主题规则接管（${r.label}）`);
        }

        // ⑤ ★★ 切深色必须同时设 CSS `color-scheme`（2026-10 用户报"下拉列表还是白的"）
        //    症状：设置 → 对话，点开「模型名」下面那个下拉，弹出来的候选列表是
        //    **白底黑字**，与深色界面割裂。
        //    为什么只改 CSS 治不了：那个下拉弹层是**浏览器原生绘制**的
        //    （Chromium 的 select popup 不在 DOM 里，任何 CSS 选择器都碰不到它）。
        //    决定它按哪套配色画的只有 `color-scheme`。实测深色下它算出来是 `normal`
        //    （从没被设过）→ 浏览器按浅色画 → 白底。
        //    `color-scheme` 还一并决定滚动条、复选框、日期选择器的配色，
        //    所以必须在**主题层**统一设，而不是给每个下拉打补丁。
        c.ok(/colorScheme\s*=/.test(themeJs),
            '★ applyDarkMode 里设置了 CSS color-scheme（否则原生下拉/滚动条仍是浅色）');
        c.ok(/document\.documentElement\.style\.colorScheme\s*=\s*dark\s*\?\s*'dark'\s*:\s*'light'/.test(themeJs),
            '★ color-scheme 随深色开关切到 dark / light');
        // 浅色时也必须**显式写 light**，不能删掉：选了"跟随系统"而系统是深色时，
        // 不写 light 会让浏览器继续按系统偏好画原生控件 —— 与应用内的浅色界面矛盾。
        c.ok(!/style\.colorScheme\s*=\s*''/.test(themeJs) && !/removeProperty\(\s*['"]color-scheme/.test(themeJs),
            '★ 浅色时显式写 light（不能删掉，否则跟随系统时会漏回深色）');

        // ⑥ ★★★ color-scheme 不够，option 必须显式给背景色（真实弹层截图证明过白底浅字）
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
        const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
        // 上游顶部导航里就有「外观」一项；埋在「高级」里要翻两层才找到
        c.ok(/data-settings-tab="tab-appearance">外观</.test(html), '★ 有独立的「外观」Tab');
        c.ok(/id="tab-appearance"/.test(html), '有 #tab-appearance 面板');
        c.ok(/id="tab-appearance" class="settings-tab-panel active-panel"/.test(html),
            '★ 外观是默认激活分栏（打开设置直接看到主题）');
        const advIdx = html.indexOf('id="tab-advanced"');
        const themeIdx = html.indexOf('themeSettingsSection');
        c.ok(themeIdx > 0 && themeIdx < advIdx, '★ 主题设置已从「高级」移到「外观」');
        c.ok(/id="themePickerBox"/.test(html), '外观分栏里有模板选择器');
        c.ok(/id="headerThemeBtn"/.test(html), '深色切换在顶栏（#headerThemeBtn，与「整理记忆」同排）');

        // ★★★ 2026-10 默认主题的**名字与色点必须与应用实际配色一致**
        // 这条防的是一次真实的不一致：`elaina`（默认主题）在 theme.js 里叫
        // 「粉紫（默认）」、色点是 ['#ec4899','#8b5cf6','#fdf2f8']，
        // 但应用实际渲染的是 index.html `:root` 那套 —— **暖米色 + 棕 + 橄榄绿**
        // （--pixso-canvas #a8b974 / --pixso-green #a7bb6c / --pixso-cream #f8f5f2）。
        // 名字/色点是"还是粉紫配色"时定的，后来 :root 换成橄榄绿**没跟着改**，
        // 于是主题选择器显示"粉紫"、点进去是绿的 —— 用户报的
        // "设置页面与对话主题对不上"就是这个。
        // 判据：默认主题的三个色点必须**等于 :root 里的真实值**。
        // 这样改 :root 而忘了改 theme.js 时会立刻红。
        {
            const themeJs = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
            const tplLine = (themeJs.match(/\{ id: 'majo',[^}]*\}/) || [''])[0];
            c.ok(/name: '暗夜魔女书房/.test(tplLine),
                '★ 默认主题的名字反映实际配色（不能还叫"粉紫"）', tplLine.slice(0, 60));
            // 从 index.html 的 :root 取真实值来比对
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
            // 反向：不该再出现那套粉紫色点
            c.ok(!/id: 'majo'[^}]*#ec4899/.test(themeJs),
                '★ 默认主题不再挂着粉紫色点 #ec4899');
        }

        // ★★★ 2026-10 默认主题下不该有**写死的粉紫**（用户："设置页面主题还是粉色的"）
        // 这类残留查起来很费劲，因为它们是**分散**的写死颜色：
        //   · body 的粉紫渐变 `#FFF0F5→#FFE4E1→#E6E6FA`（设置遮罩 82% 不透明 → 透出来）
        //   · 一堆 `rgba(236,72,153,…)` 聚焦描边 / 边框 / 阴影
        //   · `text-pink-500` 这类 Tailwind 类（**弹窗之外**的地方没被既有规则覆盖）
        //   · `--color-primary`（#ec4899）被当强调色直接引用
        // 判据：把这些"粉紫特征值"整体列出来，**除了注释以外**不许出现。
        // ★ 为什么排除注释：代码里刻意写了注释解释"原来是写死的粉"，
        //   那些注释会被正则命中（这是第三次踩"注释污染判据"，见 8.60/8.62）。
        {
            const stripComments = (s) => String(s)
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/<!--[\s\S]*?-->/g, '')
                .replace(/^\s*\/\/.*$/gm, '');
            const cssNoComments = stripComments(html);
            const PINK_SIGNS = [
                { re: /#ec4899/i, label: '#ec4899' },
                { re: /#8b5cf6/i, label: '#8b5cf6' },
                { re: /#FFF0F5/i, label: '#FFF0F5（粉渐变起）' },
                { re: /rgba\(\s*236\s*,\s*72\s*,\s*153/, label: 'rgba(236,72,153)（粉）' },
                { re: /rgba\(\s*244\s*,\s*114\s*,\s*182/, label: 'rgba(244,114,182)（粉）' },
            ];
            for (const s of PINK_SIGNS) {
                c.ok(!s.re.test(cssNoComments),
                    `★ 默认主题下没有写死的粉紫 ${s.label}（注释不计）`);
            }
            // `--color-primary` 这套只服务"自定义"主题与 Tailwind 兜底，
            // 不该被宿主样式直接当强调色用（那会在默认主题下变粉）。
            c.ok(!/var\(--color-primary\)|var\(--color-secondary\)|var\(--color-accent\)/.test(cssNoComments),
                '★ 宿主规则不再直接引用 --color-*（那套是粉紫，只给自定义主题/兜底用）');
        }

        // ★★★ 2026-10 所有下拉必须**统一外观**（用户："其他比如语言主题那里的下拉还是老下拉"）
        // `<select>` 默认由浏览器原生绘制（Windows 是方角小箭头），
        // 与圆角输入框/组合框不一致，且深色下原生箭头不跟随。
        // 修法是 `appearance: none` + 内联 SVG 自绘三角。
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

        // ★★★ 2026-10 组合框必须是**一个整体外框**（用户："下拉是一个整体而不是和输入框分成两个部分"）
        // 第一版把边框画在 input 和三角按钮**各自**身上（靠 -1px 重叠骗眼睛），
        // 结果用户一眼看出是两块；而且高度还对不上（46 vs 48）。
        // 正确做法：外框画在**容器** `.model-combo-row` 上，两个子元素都不带边框。
        {
            const rowRule = html.match(/\.model-combo-row\s*\{([^}]*)\}/);
            c.ok(!!rowRule, '找得到 .model-combo-row 规则');
            if (rowRule) {
                c.ok(/border:\s*1px solid/.test(rowRule[1]), '★ 外框画在**容器**上（唯一的那个框）');
                c.ok(/border-radius:\s*13px/.test(rowRule[1]), '容器有圆角');
                c.ok(/height:\s*46px/.test(rowRule[1]),
                    '★ 容器定高 46px —— 必须与普通 select **实测**一致（第一版写 48 就差了 2px）');
            }
            const inRule = html.match(/\.model-combo-input\s*\{([^}]*)\}/);
            c.ok(!!inRule, '找得到 .model-combo-input 规则');
            if (inRule) {
                c.ok(/border:\s*0\s*!important/.test(inRule[1]),
                    '★ 输入区**不带边框**（它是外框里的一段，不是第二个框）');
                c.ok(/background:\s*transparent\s*!important/.test(inRule[1]), '输入区背景透明');
            }
            const tgRule = html.match(/\.model-combo-toggle\s*\{([^}]*)\}/);
            c.ok(!!tgRule, '找得到 .model-combo-toggle 规则');
            if (tgRule) {
                c.ok(/border:\s*0;/.test(tgRule[1]) || /border:\s*0\s*;/.test(tgRule[1]),
                    '★ 三角按钮也不带边框（同上）');
                c.ok(/width:\s*46px/.test(tgRule[1]), '★ 三角区域够宽（46px，用户要求"大一些"）');
            }
            // 反向：老的写法（input 上写 border-top-right-radius: 0）不该回来
            c.ok(!/\.model-combo-input\s*\{[^}]*border-top-right-radius:\s*0/.test(html),
                '★ 没有回到"两个框拼一起"的旧写法');
        }

        // ★★★ 2026-10 导航按钮组必须**居中**（用户："导航栏应该是居中的，现在选择靠左"）
        // 这条防的是一个很隐蔽的失效：`#settingsTabNav` 上写着
        // `width: max-content` + `margin: 0 auto`（本意居中），
        // 但元素上还挂着 Tailwind 的 **`flex-1`**（= `flex: 1 1 0%`）——
        // 在 flex 父容器里它会撑满整行，于是 max-content 被忽略、auto margin 无空间可分，
        // 按钮组贴在左边。实测（1440px 视口）按钮组中心偏离视口中心 **317px**。
        // 修法是把 flex 改成 `0 1 auto`（让 max-content 生效）。
        // 断言两件事：
        //   ① flex 不能再是 `1 1 0%`（不能靠 flex-1 撑满）
        //   ② `justify-content` 必须仍是 flex-start —— **不能改成 center**！
        //      溢出时（手机上 9 个分栏 > 屏宽）center 会把溢出均分到两侧，
        //      左侧那半永远滚不回来（`scrollLeft` 最小是 0）。这条坑在基础规则的
        //      长注释里记着，这里反向钉住，防止有人"顺手"把它改成 center。
        {
            // ★ 取**基础** #settingsTabNav 规则块 —— 文件里有**三处**同名选择器：
            //   移动端媒体查询里的两份（只改 max-width/padding 之类）+ 基础规则一份。
            //   ★★ 提取必须用**花括号配对**，不能用 `\{([\s\S]*?)\n    \}` 这种正则：
            //      媒体查询里那份的缩进是 12 空格，而正则要求 4 空格，
            //      于是非贪婪匹配会**一路跑过它自己的 `}`**、吞进后面几百行
            //      （实测：选出的"基础规则"里混着 .settings-tab-btn 的样式，
            //        导致 flex / max-content 两条断言假失败）。
            const navBodies = [];
            for (let i = 0; i < html.length; i++) {
                if (!html.startsWith('#settingsTabNav', i)) continue;
                const open = html.indexOf('{', i);
                if (open < 0) break;
                let depth = 0;
                for (let j = open; j < html.length; j++) {
                    if (html[j] === '{') depth++;
                    else if (html[j] === '}') { depth--; if (depth === 0) { navBodies.push(html.slice(open + 1, j)); break; } }
                }
                i = open;
            }
            c.ok(navBodies.length >= 2, '找到多处 #settingsTabNav 规则（基础 + 移动端）',
                '实际 ' + navBodies.length + ' 处');
            // 基础规则 = 含 `flex:` 简写的那一份（移动端那份只有 max-width/padding）
            const body = navBodies.find((b) => /(^|\s)flex\s*:\s*\d/.test(b)) || '';
            c.ok(!!body, '找得到基础 #settingsTabNav 规则（含 flex 简写的那一份）');
            if (body) {
                // ★ 断言前先**剥掉注释**：这段规则里刻意写了注释解释"flex: 1 1 0% 会撑满整行"
                //   （说明为什么不能这么写），而那条注释本身会被正则命中 ——
                //   于是"不该有 flex: 1 1 0%"这条断言被**解释为什么不该有的注释**触发了。
                //   这是"注释污染判据"的第二次踩坑（第一次见 check-agent-phone.mjs）。
                const code = body
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/\/\/[^\n]*/g, '');
                c.ok(/flex:\s*0\s+1\s+auto/.test(code),
                    '★ 导航用 flex: 0 1 auto（写成 flex-1 会撑满整行、居中失效）');
                c.ok(!/flex:\s*1\s+1\s+0%/.test(code),
                    '★ 导航不再被 flex: 1 1 0% 撑满（那会让 max-content 失效）');
                c.ok(/width:\s*max-content/.test(code), '导航宽度是 max-content（才能被 auto margin 居中）');
                c.ok(/margin:\s*0\s+auto/.test(code), '导航靠 margin: 0 auto 居中');
                c.ok(/justify-content:\s*flex-start/.test(code),
                    '★★ justify-content 仍是 flex-start（改成 center 会让溢出部分滚不回来）');
            }
            // 元素上不能同时挂 flex-1（那是当初失效的来源）
            const navTag = html.match(/<div id="settingsTabNav"[^>]*>/);
            c.ok(!!navTag, '找得到 #settingsTabNav 元素');
            if (navTag) {
                c.ok(!/class="[^"]*\bflex-1\b/.test(navTag[0]),
                    '★★ 元素上没有 flex-1（有它会盖掉 CSS 里的 flex: 0 1 auto）');
            }
        }

        // ★★ 结构完整性：各分栏不能互相嵌套
        // 这条是补的回归。搬移主题块时插入的 HTML 少了一个 `>`（写成 `</div`），
        // 浏览器把它当成"未闭合的 div 开始"，**后面 8 个分栏全被嵌进了 tab-appearance**。
        // 而 CSS 是 `.settings-tab-panel{display:none}` + `.active-panel{display:block}`，
        // 表现就是"除了外观，其他设置全都不见了"。
        // 这里用 div 配对算出每个分栏的范围，检查有没有谁被包在别人里面。
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
            // ★ 这里数的是**宿主自带**的分栏。历史上变过几次：
            //   2026-10 起 Live2D 那一栏由插件通过 settings.tabs 插槽渲染（见 mods/live2d/），
            //   所以宿主 HTML 里从 9 变 8；同月新增宿主自带的「日志」分栏 → 回到 9；
            //   同月又把「对话 / 语音 / 视觉」三栏**合并成「模型」** → 变 7。
            //   ⚠️ 用「≥N + 断言合并本身」而不是写死数字：数字会随每次搬动失效，
            //      而真正要钉住的是"合并确实发生了、且三个旧分栏不再存在"。
            c.ok(ids.length >= 7, `宿主自带 ${ids.length} 个分栏（应 ≥7）`);
            // ★★ 三个模型类分栏必须已合并成 tab-model（2026-10 用户要求）
            c.ok(ids.includes('tab-model'), '★ 有「模型」分栏（对话 + 语音 + 视觉已合并）');
            for (const gone of ['tab-chat', 'tab-voice', 'tab-vision']) {
                c.ok(!ids.includes(gone), `★ 旧的 ${gone} 分栏已不存在（已并入 tab-model）`);
            }
            const l2dManifest = path.join(ROOT, 'mods', 'live2d', 'manifest.json');
            if (existsSync(l2dManifest)) {
                const l2dSrc = readFileSync(path.join(ROOT, 'mods', 'live2d', 'register.js'), 'utf8');
                // ★ 2026-10 起改用 settings.modal（独立弹窗）而不是 settings.tabs（占分栏）：
                //   插件设置全堆在主设置里会堆一排分栏，难看也难找。见 host-slots.js 的说明。
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

            // 顺带查常见的标签残缺：`</div` 后面直接跟换行（少个 >）
            const brokenTag = /<\/div\s*\n/.test(region) || /<\/section\s*\n/.test(region);
            c.ok(!brokenTag, '★ 没有残缺的闭合标签（如 </div 少了 >）');
        }
    }

    console.log('\n=== 3.6 插件主题摘除后，不能"变量没了但属性还在" ===');
    {
        // ★★★ 2026-10 用户实测：「删了几个插件之后，再点删除插件，
        //   弹窗里的「确定」按钮在 DOM 里、视觉上却看不见」。
        //   根因两层，都要钉住：
        //   ① theme.js 的 unregisterTemplate 把"用户是否正停在这套主题上"的判断写在
        //      splice **之后** —— 那一刻 id 已不在清单里，currentTemplate() 一律返回
        //      'elaina'，判断恒为 false，"回落默认主题"这一支**从未执行过**。
        //      于是 html 上留着 data-theme-template，而该主题注入的变量样式已被 remove。
        //   ② themes.css 里 `html[data-theme-template] .modal-panel .btn-primary` 的
        //      background 直接裸用 `var(--tpl-primary)` —— 变量取不到时整条声明在
        //      "计算期无效"后回落成透明，而 color 仍是 `#fff !important`：
        //      白字透明底 = **一个看不见的按钮**。
        const jsRaw = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
        // ★ 先剥注释：文件里刻意写了注释解释这两条判据，
        //   而注释里的 `currentTemplate() === id` 会被正则在正文之前命中（"注释污染判据"）。
        const js = jsRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        const fnIdx = js.indexOf('function unregisterTemplate');
        const fnSrc = fnIdx < 0 ? '' : js.slice(fnIdx, js.indexOf('function refreshPicker', fnIdx));
        const guardIdx = fnSrc.indexOf('currentTemplate() === id');
        const spliceIdx = fnSrc.indexOf('MOD_TEMPLATES.splice');
        c.ok(guardIdx >= 0 && spliceIdx >= 0 && guardIdx < spliceIdx,
            '★★ unregisterTemplate 的"是否正停在这套主题上"必须在 splice **之前**判（写在之后恒为 false）',
            `guard@${guardIdx} splice@${spliceIdx}`);

        // v2 不再用 --tpl-primary 写覆盖规则：按钮/气泡直接吃 --rd-accent 一类的令牌。
        //   那个"变量没了但属性还在 → 白字透明底"的失效链条因此不存在了；
        //   但旧插件仍可能读 --tpl-primary，所以它必须保留为**有值**的兼容别名，且不能被裸用。
        const css = readFileSync(path.join(WEB, 'css', 'themes.css'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '');
        c.ok(/--tpl-primary:\s*var\(--rd-accent\)/.test(css),
            '★ --tpl-primary 是 --rd-accent 的兼容别名（旧插件取得到值）');
        c.ok(!/var\(--tpl-primary\s*\)/.test(css),
            '★★ 没有裸用 var(--tpl-primary)（取不到值时会回落成透明）');
    }

    console.log('\n=== 4. 同步（APK 端要用）===');
    {
        // 打包工具住在 dist/Android/scripts/（与其它 Android 打包内容放在一起）
        const sync = readFileSync(path.join(ROOT, 'dist', 'Android', 'scripts', 'sync-web.mjs'), 'utf8');
        c.ok(/collectCssFiles/.test(sync), '★ sync-web.mjs 会同步 web/css/（否则 APK 里主题切换无效）');
        c.ok(/theme\.js/.test(sync) || /collectJsFiles/.test(sync),
            'js/ 是自动发现的，theme.js 会被带上');
    }


}

// 旅行日记的浏览体验（按对话分组 / 点侧栏筛选 / 弹窗看全文）
// 真起一次 serve.mjs + Playwright 点页面 —— 这一块的 bug 全是"点着点着不对"，
// 纯源码断言抓不到。

async function caseDiary(c) {
    const read = (p) => readFileSync(p, 'utf8');
    const stripComments = stripCommentsOf;
    void read; void stripComments;

    // ============================================================ 1. 源码约定
    console.log('=== 1. 源码约定 ===');
    {
        const ui = readFileSync(path.join(WEB, 'js', 'conversations.js'), 'utf8')
            + '\n' + readFileSync(path.join(WEB, 'js', 'ui.js'), 'utf8');
        const core = readFileSync(path.join(WEB, 'js', 'core-state.js'), 'utf8')
        + '\n' + readFileSync(path.join(WEB, 'js', 'core.js'), 'utf8');
        const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');

        // ① 按对话分组
        c.ok(/function renderDiaryPage/.test(ui), '有 renderDiaryPage');
        c.ok(/diary-group-head/.test(ui), '★ 日记按对话分组渲染（组标题）');
        c.ok(/grid-column:\s*1\s*\/\s*-1/.test(html),
            '★ 组标题跨整行（不跨列会被塞进某一列、卡片跟着错位）');

        // ② 点侧栏 → 只筛选不跳转
        c.ok(/function focusDiaryGroup/.test(ui), '★★ 有 focusDiaryGroup（按对话筛选日记）');
        // ★ 注意：筛选状态定义在 **core.js 的 state** 里，不在 ui.js。
        //   （我第一版断言写的是 ui 文件，于是必然找不到 —— 判据指错了文件。）
        c.ok(/diaryFilterConvId:\s*''/.test(core),
            '★ state 里有 diaryFilterConvId（筛选状态）');
        // ★★ 关键：只在日记页拦截；否则日常切换对话会被弄坏
        c.ok(/if \(state\.diaryMode && typeof focusDiaryGroup === 'function'\)/.test(ui),
            '★★ 只在日记页拦截侧栏点击（非日记页必须照旧进对话 —— 那是最常用的操作）');
        // ★★ 2026-10（用户要求）：日记页里**不再**放第二套筛选条 ——
        //   分类/筛选统一交给左边的对话记录，两处都能筛只会让人困惑。
        c.ok(!/function renderDiaryFilterBar/.test(ui),
            '★★ 已移除日记页内的筛选条（筛选职责交给左侧对话记录，不重复提供入口）');
        c.ok(!/diary-filter-bar/.test(ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
            '★★ 代码里不再生成 .diary-filter-bar（注释里提到不算）');
        // ★ 但"点中了哪一段"要有视觉落点（否则用户不知道点没点上）
        c.ok(/is-focused/.test(ui) && /is-focused/.test(html),
            '★★ 当前筛选的组有高亮样式（is-focused）—— 筛选条移除后需要这个落点');

        // ③ 弹窗看全文
        c.ok(/function openDiaryDetail/.test(ui), '★★ 有 openDiaryDetail（点卡片看全文）');
        c.ok(/function closeDiaryDetail/.test(ui), '有 closeDiaryDetail');
        c.ok(/card\.addEventListener\('click', openDetail\)/.test(ui),
            '★ 卡片可点击打开详情');
        // ★ 正文用 textContent 而不是 innerHTML（模型输出，防注入）
        c.ok(/p\.textContent = entry\.content/.test(ui),
            '★★ 详情正文用 textContent（日记内容来自模型，不能当 HTML 解析）');

        // ④ 不再"点组头就跳走"
        c.ok(!/head\.addEventListener\('click', jump\)/.test(ui),
            '★ 组头不再"点了就跳去聊天"（用户明确要求去掉）');
        c.ok(/data-diary-enter/.test(ui), '★ 但保留「进入对话」按钮（入口不能丢）');

        // ⑤ 进/出日记页要清筛选（否则下次进来莫名只显示一部分）
        c.ok(/function enterDiaryMode[\s\S]{0,400}?state\.diaryFilterConvId = ''/.test(ui),
            '★★ 进日记页时重置筛选（筛选是当次浏览状态，不该跨次留存）');
        c.ok(/function exitDiaryMode[\s\S]{0,500}?state\.diaryFilterConvId = ''/.test(ui),
            '★★ 离开日记页时也清掉（并关掉详情弹窗）');
        c.ok(/function exitDiaryMode[\s\S]{0,500}?closeDiaryDetail\(\)/.test(ui),
            '★ 离开日记页要关掉详情弹窗（它挂在 body 上，不随页面隐藏）');

        // ⑦ ★★ 日记页里点对话，侧栏也要有选中高亮
        //   用户报："对话记录这里选中后会有选中的特性，但在日记系统中选中没有对应特效，
        //   只有回到聊天才能正常使用。"
        //   根因：侧栏条目高亮判的是 `conv.id === state.currentConversationId`，
        //   而"日记页点对话只筛选不跳转"这个行为**恰恰不改** currentConversationId
        //   —— 于是点了对话，侧栏没有任何条目被判定为选中。
        //   （两个功能各自看都是对的，合起来就成了这个 bug。）
        c.ok(/const activeId = state\.diaryMode/.test(ui),
            '★★ 日记页时高亮判据换成"筛选的对话"（不再只看 currentConversationId）');
        c.ok(/state\.diaryFilterConvId \|\| ''/.test(ui),
            '★ 未筛选时不高亮任何条目（回落成空串，不是 undefined）');
        // ★ 只重绘日记页不够 —— 侧栏也必须跟着重绘，否则点了对话高亮不更新
        c.ok(/function focusDiaryGroup[\s\S]{0,600}?renderFolderList\(\)/.test(ui),
            '★★ focusDiaryGroup 里重绘侧栏（不重绘则侧栏高亮不更新）');
        c.ok(/function exitDiaryMode[\s\S]{0,900}?renderFolderList\(\)/.test(ui),
            '★★ 离开日记页时重绘侧栏（高亮要切回"当前对话那段"）');

        // ⑥ ★★ 删除对话时，日记与收藏都要一起清掉
        //   用户报："删除对话时会删除日记但是不会删除收藏的句子"。
        //   查下来是**两处删除入口各自只做了一半**（一个删收藏不删日记、
        //   另一个也一样）。所以这里既钉"有共用函数"，也钉"两个入口都调它"。
        c.ok(/function purgeConversationDependents/.test(ui),
            '★★ 有 purgeConversationDependents（删对话时清理依附数据）');
        c.ok(/function purgeConversationDependents[\s\S]{0,1500}?mc\.diary = mc\.diary\.filter/.test(ui),
            '★★ 它会清掉属于该对话的**日记**');
        c.ok(/function purgeConversationDependents[\s\S]{0,2000}?state\.favorites = state\.favorites\.filter/.test(ui),
            '★★ 它也会清掉属于该对话的**收藏句子**');
        // ★★ 两个删除入口都必须走它（这正是 bug 的成因：各写一半）
        const delFn = ui.slice(ui.indexOf('async function deleteConversation'), ui.indexOf('function togglePin'));
        c.ok(/purgeConversationDependents\(\[convId\]\)/.test(delFn),
            '★★ 单条删除走共用清理函数');
        const batchFn = ui.slice(ui.indexOf('async function catDeleteSelected'), ui.indexOf('// ==================== 消息渲染'));
        c.ok(/purgeConversationDependents\(catSelected\)/.test(batchFn),
            '★★ 批量删除也走同一个函数（两个入口不能再各写一半）');
        // 清完要落盘，否则刷新又回来
        c.ok(/function purgeConversationDependents[\s\S]{0,1500}?saveMemoryCore/.test(ui)
            && /function purgeConversationDependents[\s\S]{0,2000}?saveFavorites/.test(ui),
            '★★ 清理结果要落盘（日记 saveMemoryCore / 收藏 saveFavorites）');
    }

    // ============================================================ 2. 真浏览器
    const PORT = await freePort();
    const HTTPS_PORT = await freePort();
    const BASE = `http://127.0.0.1:${PORT}`;
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-diary-data-'));
    const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-diary-log-'));
    const MODS_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-diary-mods-'));

    /**
     * 造可控的测试数据。
     *
     * ★★ 两个关键点（我实测各踩了一次，写下来避免以后再错）：
     *   ① 对话与记忆**不在 store.json 里** —— 服务端把它们拆成
     *      `data/conversations/*.json` 与 `data/memory/*.json`（一条一文件 + index）。
     *      往 store.json 里塞完全不会生效，表现为"页面里那些对话根本不存在"。
     *   ② `memory/<类目>.json` 的 `value` 必须是**真正的数组**，
     *      不能再 JSON.stringify 一层。写成字符串的话，客户端拿到的是
     *      `"diary":"[...]"`，`Array.isArray()` 判定失败 → 归零成空数组 → 日记全空。
     */
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
    // 立绘依赖（生日彩蛋要用；这里给一份最小可用）
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

            const nav = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
            c.ok(nav && nav.status() === 200, '页面能打开', 'status=' + (nav ? nav.status() : '?'));
            await page.waitForTimeout(1500);
            await page.evaluate(() => {
                const ov = document.getElementById('announcementOverlay');
                if (ov) { ov.classList.add('hidden'); ov.classList.remove('flex'); }
            });

            // ---------- 2.1 分组渲染 ----------
            await page.evaluate(() => { enterDiaryMode(); });
            await page.waitForTimeout(600);
            const grouped = await page.evaluate(() => ({
                diaryMode: state.diaryMode,
                groups: [...document.querySelectorAll('.diary-group-title')].map((e) => e.textContent),
                cards: document.querySelectorAll('.diary-card').length,
                countText: (document.getElementById('diaryCount') || {}).textContent,
                enterBtns: document.querySelectorAll('.diary-group-enter').length,
            }));
            c.ok(grouped.cards === 2, '★★ 两条日记都渲染出来了（拆分文件的数据能读到）', JSON.stringify(grouped));
            c.ok(grouped.groups.includes('雪之街的相遇') && grouped.groups.includes('咖啡馆的午后'),
                '★★ 按对话分成两组，组标题是各自的对话名', JSON.stringify(grouped.groups));
            c.ok(grouped.enterBtns === 2, '★ 每个可跳转的组都有「进入对话」按钮');

            // ---------- 2.2 点侧栏 → 只筛选、不跳转 ----------
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
                    // ★ 筛选条已按用户要求移除（筛选交给左侧对话记录），
                    //   改由"当前组高亮"给出视觉落点，所以这里断言 is-focused。
                    focusedHead: document.querySelectorAll('.diary-group-head.is-focused').length,
                    focusedTitle: (document.querySelector('.diary-group-head.is-focused .diary-group-title') || {}).textContent || '',
                    filterBarGone: !document.querySelector('.diary-filter-bar'),
                    diaryVisible: !document.getElementById('diaryPage').classList.contains('hidden'),
                    chatHidden: document.getElementById('conversationHistory').classList.contains('hidden'),
                };
            });
            c.ok(filtered.found, '★★ 侧栏里能找到那条对话');
            c.ok(filtered.stillDiaryMode, '★★★ 点侧栏后**仍在日记页**（用户要求的"不再跳转到聊天"）',
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

            // ---------- 2.3 再点一次 → 取消筛选 ----------
            const toggled = await page.evaluate(async () => {
                const item = document.querySelector('#folderList [data-conv-id="cB"]');
                item.click();
                await new Promise((r) => setTimeout(r, 400));
                return { filter: state.diaryFilterConvId, cards: document.querySelectorAll('.diary-card').length };
            });
            c.ok(toggled.filter === '' && toggled.cards === 2,
                '★★ 再点同一段 → 取消筛选、恢复全部（像开关一样，不会"筛进去出不来"）',
                JSON.stringify(toggled));

            // ---------- 2.4 点卡片 → 弹窗看全文 ----------
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
                    // 卡片上是 4 行截断，弹窗必须是全文
                    clampedByCss: (() => {
                        const t = longCard.querySelector('.diary-card-text');
                        return t ? getComputedStyle(t).webkitLineClamp : null;
                    })(),
                };
            });
            c.ok(detail.found && detail.open, '★★★ 点日记卡片会弹出详情（用户要求的"展开查看"）',
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

            // ---------- 2.5 「进入对话」按钮仍能进对话 ----------
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

            // ---------- 2.6 ★★ 非日记页时点侧栏必须照旧进对话 ----------
            //   这是最容易被"筛选逻辑"改坏的地方：进对话是最常用的操作，
            //   弄坏它比原来的问题严重得多。所以单独钉一条。
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

            // ---------- 2.7 重新进日记页 → 筛选被重置 ----------
            const reenter = await page.evaluate(async () => {
                state.diaryFilterConvId = 'cB';     // 人为留一个筛选
                enterDiaryMode();
                await new Promise((r) => setTimeout(r, 400));
                return { filter: state.diaryFilterConvId, cards: document.querySelectorAll('.diary-card').length };
            });
            c.ok(reenter.filter === '' && reenter.cards === 2,
                '★★ 重新进入日记页时筛选被重置（不会莫名其妙只看到一部分）',
                JSON.stringify(reenter));

            // ---------- 2.8 ★★ 删除对话 → 日记与收藏都要清掉 ----------
            //   用户报："删除对话时会删除日记但是不会删除收藏的句子"。
            //   这里直接调真实的 deleteConversation（走确认框会自动 resolve 吗？——
            //   不行，所以先 stub 掉 showCustomConfirm 让它直接同意）。
            const purge = await page.evaluate(async () => {
                // 造两段对话 + 各一条日记 + 各一条收藏
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

                // 跳过确认框（否则会一直等用户点"确定"）
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

            // ---------- 2.9 日记页里删除后要立刻刷新（不能留着空组） ----------
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

            // ---------- 2.10 ★★ 日记页点对话 → 侧栏要有选中高亮 ----------
            //   用户报的原话："对话记录这里选中后会有选中的特性，但在日记系统中选中
            //   没有对应特效，只有回到聊天才能正常使用。"
            //   所以这里必须测**侧栏条目本身**拿到了 .sidebar-item-active，
            //   而不只是"筛选生效了"（那是另外几条断言的事）。
            //   ★ 必须先恢复 cA/cB：上面 2.8/2.9 两节为了测删除，
            //     已经把 state.conversations 换成了别的 id —— 不恢复的话
            //     侧栏里根本没有 cA/cB，querySelector 返回 null，
            //     三条断言全部假失败（第一版就是这么红的，且现象是 "b":null）。
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
                    // 当前对话没被动过（仍然是"只筛选不跳转"）
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

            // ★★ 离开日记页 → 高亮要切回"当前对话那段"
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

// 「星屑之日」生日模块（已从宿主摘出、改为插件）
// ★ 插件源码不再随仓库分发（仓库只推软件本体，插件一律走应用内上传安装）。
//   所以本地没有 mods/birthday/ 是**正常状态**，不是缺陷 ——
//   第 5 节整节跳过，否则每次 npm run check 都会红一片，把真正的回归淹没掉。
//   第 1~4 节查的是**宿主**那一侧，与插件在不在无关，照常跑到底。

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
        + read(path.join(WEB, 'js', 'data.js'));
    const initJs = read(path.join(WEB, 'js', 'init.js'));
    const achJs = read(path.join(WEB, 'js', 'achievements.js'));

    // 所有宿主前端脚本（用来断言"没有任何一处还在引用旧的 ElainaBirthday"）
    const allJs = readdirSync(path.join(WEB, 'js'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => ({ name: f, src: read(path.join(WEB, 'js', f)) }));

    // ============================================================ 1. 宿主已摘除
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

        // 主题：stardust 不再是内置模板
        const tplIds = [...themeJs.matchAll(/\{\s*id:\s*'(\w+)',\s*name:/g)].map((m) => m[1]);
        c.ok(!tplIds.includes('stardust'),
            '★★ theme.js 的 TEMPLATES 里已没有 stardust（改由插件 host.theme 注册）', tplIds.join(','));
        c.ok(!/html\[data-theme-template="stardust"\]\s*\{/.test(themesCss),
            '★★ themes.css 不再定义 stardust 的变量块（避免与插件里的变量出现两份）');

        // 存储：旧键退役、新键上位
        const keysBlock = storeJs.match(/DATA_KEYS\s*=\s*\[[\s\S]*?\]/);
        const keys = keysBlock ? [...keysBlock[0].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
        c.ok(!keys.includes('elaina_birthday'),
            '★★ DATA_KEYS 里不再有 elaina_birthday（生日状态改住插件的私有命名空间）');
        c.ok(keys.includes('elaina_mod_storage'),
            '★★ DATA_KEYS 里有 elaina_mod_storage（漏了 → 插件的持久化刷新即丢）');

        // 成就：用户选择"成就留宿主，插件只当触发器" → 三条定义必须还在
        for (const id of ['stardust_day', 'stardust_remembered', 'stardust_makeup', 'stardust_together']) {
            c.ok(new RegExp(`id: '${id}'`).test(achJs), `成就留在宿主：仍定义 ${id}`);
        }
    }

    // ============================================================ 2. 提示词注入改走插件通道
    console.log('\n=== 2. 生日补充提示词：宿主不再注入，改由插件 setPromptHint ===');
    {
        c.ok(!/ElainaBirthday/.test(stripComments(dataJs)), '★ data.js 不再读 ElainaBirthday.promptHint()');
        c.ok(/collectPromptHints\(\)/.test(dataJs),
            '★ 宿主仍保留插件提示词通道（collectPromptHints）—— 生日补充就走它');
    }

    // ============================================================ 3. 公告 ↔ 彩蛋联动改走事件
    console.log('\n=== 3. 公告与开场彩蛋的联动：宿主不再直接引用生日模块 ===');
    {
        c.ok(!/onEggDone/.test(stripComments(initJs)), '★ init.js 不再用 ElainaBirthday.onEggDone()');
        c.ok(/announcement-pending/.test(initJs),
            '★ 宿主广播 announcement-pending（"公告将要出现"，生日插件据此推迟彩蛋）');
        c.ok(/announcement-closed/.test(dataJs),
            '★ 关闭公告时广播 announcement-closed（在 closeAnnouncement 这个唯一出口里发）');
        c.ok(!/ElainaBirthday/.test(stripComments(initJs)), '★ init.js 里没有 ElainaBirthday');
    }

    // ============================================================ 4. 宿主为它补的 4 个能力
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

    // ============================================================ 5. 插件本体就位
    // ★ 2026-10 起**插件源码不再随仓库分发**（仓库只推软件本体，插件一律走应用内
    //   上传安装）。所以本地没有 mods/birthday/ 是**正常状态**，不是缺陷 ——
    //   这一节整节跳过，否则每次 npm run check 都会红一片，把真正的回归淹没掉。
    //   （第 1~4 节查的是**宿主**那一侧，与插件在不在无关，照常跑到底。）
    //   把插件放回 mods/birthday/ 就会自动恢复这一节的断言。
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

        // 用的是新 API，而不是宿主私有物
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

        // 台词与提示词内容：搬迁不能把用户给定的文案弄丢
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

        // 情景演绎（2026-10 用户要求：生日面板 →「与伊蕾娜一起过生日」→ 故事引导 → 演绎）
        c.ok(mod.includes('与伊蕾娜一起过生日'), '★ 生日面板按钮文案 = 「与伊蕾娜一起过生日」');
        c.ok(!/先这样/.test(modCode), '★★ 旧的「先这样」按钮已移除');
        c.ok(mod.includes('SCENARIO_PROMPT') && mod.includes('我想做个蛋糕。'),
            '★★ 情景演绎剧本（用户给定原文）在源码里');
        c.ok(/host\.unlock\('stardust_together'/.test(mod),
            '★★ 开始演绎时上报成就 stardust_together（今天的特别之处）');
        c.ok(/host\.sendUserMessage\(/.test(mod),
            '★★ 开始演绎走 host.sendUserMessage（宿主的"以角色身份说话"链路）');
        c.ok(/AFFINITY_MAX/.test(mod) && /st\.affinity/.test(mod), '★ 好感度数值落插件自己的状态（host.storage）');

        // 样式
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

// 按命令行参数过滤用例（便于只跑其中一段）
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



