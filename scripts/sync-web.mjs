import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ==================== 打包模式开关 ====================
//
// 三种模式（越往下越"轻"）：
//
//   默认            全部打包（程序 + mod 代码 + mod 图片 + Live2D 模型）
//   --no-models     跳过 Live2D 模型（模型走扩展包）
//   --lite          跳过模型**与 mod 图片**，只留程序本体 + 插件代码
//
// 为什么需要 `--lite`：手机端与电脑端口径要一致 —— mod 与 live2d 都当扩展包
// 按需下载安装。mod 图片 17.5MB + 模型 6.7MB 是 APK 体积的大头，
// 把它们移出去后 APK 只剩程序本体。
//
// 环境变量 `SKIP_LIVE2D_MODELS=1` 等价于 `--no-models`（CI 里方便）。
//
// ⚠️ 必须定义在**使用之前**（下面 collectModFiles 调用时会读 `lite`）——
//    之前放在文件后半段，导致 `lite is not defined`。
//
// ⚠️ 跳过时还要**清掉安卓工程里已有的资源**，否则上一次带资源的同步残留
//    会继续被打进 APK —— 那样"跳过"就名不副实了。

const lite = process.argv.includes('--lite');
const skipModels = lite
    || process.argv.includes('--no-models')
    || String(process.env.SKIP_LIVE2D_MODELS || '') === '1';

// ★ 2026-10（新）：插件**源码**也不再打进 APK（`--with-mods` 才带）。
//
//   为什么改：与电脑版**全新 clone** 对齐 —— 仓库的 .gitignore 本来就排除了
//   web/mods/（2026-10 起"仓库只推软件本体"），也就是说电脑版 fresh clone
//   同样没有任何插件，全靠应用内「上传安装」补齐。
//   而 APK 之前把开发机 web/mods/ 里的 6 个插件源码镜像了进去 ——
//   那是"跟着开发副本走"的惯性，不是设计：它让手机端比电脑版 fresh clone
//   **多**出一份插件，两端反而不一致。
//
//   用户决定（2026-10）：**完全纯净** —— APK 不带任何插件，
//   与电脑版 fresh clone 完全一致；插件一律走「应用内上传安装」
//   （原生接口，见 app-01-core.js 的 nativePluginsFetch）。
//
//   兼容：`--with-mods` 恢复旧行为（把插件源码打进去）。
//   环境变量 WITH_BUNDLED_MODS=1 等价（CI 里方便）。
const withMods = process.argv.includes('--with-mods')
    || String(process.env.WITH_BUNDLED_MODS || '') === '1';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const sourceRoot = path.join(projectRoot, 'web');
// ★★ 2026-10：插件根目录从 `web/mods/` 搬到**项目根** `mods/`（与 data/ 平级）。
//   它**不在** sourceRoot 下，所以下面所有读插件的地方都改用这个常量。
const modsSourceRoot = path.join(projectRoot, 'mods');
// android-app 已移到项目**上一级**（D:\222\android-app）—— 构建产物与工具链
// 不放在项目目录里，避免被误提交、也便于多个项目复用同一套。
const androidAppRoot = path.join(projectRoot, '..', 'android-app');
const androidWebRoot = path.join(androidAppRoot, 'www');
// ★★ 2026-10：内嵌 Node 工程（手机端的"服务端那一半"，见 web/nodejs/）落在
//   **assets/ 根下**，而不是 assets/public/ —— 两个理由：
//     ① public/ 是 cap sync 的产物目录，而 cap sync 的复制是"只增不减"的：
//        我们这边删掉的文件不会从它那里消失（工程里已经被这个坑咬过两次，
//        见下面 LITE_CLEAN_ROOTS 的注释）；放在自己的目录里就能自己清干净。
//     ② 它是服务端代码，没有理由暴露给 WebView 去 fetch。
//   原生插件 ElainaNode 启动时把这一份复制到应用私有目录再执行 ——
//   Node 只能跑真实路径上的脚本，assets/ 不是文件系统里的路径。
const androidAssetsRoot = path.join(androidAppRoot, 'android', 'app', 'src', 'main', 'assets');
const nodeHostDestRoot = path.join(androidAssetsRoot, 'nodejs');
// ★★ 2026-10：内嵌 Node 要用的**与电脑端共用**的后端模块，从项目根的 server/ 复制进来
//   （落到 assets/nodejs/server/，内嵌入口按 './server/xxx.mjs' 引用）。
//
//   为什么是显式清单、不整目录复制：server/ 下多数模块是**电脑端专用**的 ——
//   pc-command 要命令行、auth-guard 是登录门、store/mods 走电脑的目录扫描与解压。
//   整目录搬进 APK 只会白占体积，还会让人以为手机上也能用。
//   共用哪个模块，由这里说了算；加一个就多一行。
const SHARED_SERVER_MODULES = ['relay.mjs', 'http-util.mjs', 'net-guard.mjs'];
const modelsSourceRoot = path.join(modsSourceRoot, 'live2d-models', 'models');
// ★ APK 里的落地路径**不变**：仍是 www/live2d/models/。
//   为什么不变：模型 URL（`/live2d/models/<名>/…`）是前端与 AI 提示词里都在用的约定，
//   也是 app-01-core.js 的播种逻辑与 check-bundled-models 的判据。
//   只有**仓库里的源位置**从 web/live2d/models/ 搬到了 mod 目录下（资源与代码分开），
//   打包产物这一侧完全不需要跟着动 —— 改这一行就够，不必碰任何运行时代码。
const modelsDestRoot = path.join(androidWebRoot, 'live2d', 'models');

// 同步到安卓 www 的文件（覆盖整个定制版 Web 前端）
// 注意：diag-param-bind.html 不在列表里 —— 它依赖服务端的 /api/live2d/models 列模型，
//       而 APK（Capacitor）没有这个服务端，同步过去也只会报"读取模型列表失败"。
const filesToCopy = [
    ['index.html', 'index.html'],
    ['diag-live2d.html', 'diag-live2d.html'],
    ['diag-asr.html', 'diag-asr.html'],
    // 内嵌 Node（手机端的服务端那一半）的诊断页：只在这里用得到，
    // 电脑版是 serve.mjs 真身，不需要这一页。
    ['diag-node.html', 'diag-node.html'],
    // Live2D 视频通话已搬成插件（web/mods/live2d/）：整棵 mods/ 由下面那段自动收走，
    // 不需要在这里逐条列出。
    ['vendor/tailwind.js', 'vendor/tailwind.js'],
    // ★★ 2026-10（用户决定，覆盖上一版）：**Live2D 引擎不进 APK**。
    //
    //   上一版把这三个库列在这里，理由是"APK 没有服务端，/live2d/vendor/ 必然 404，
    //   插件会回落到宿主 /vendor/，所以宿主得带一份"。现在改成：引擎是
    //   **live2d-models 插件的一部分**，随插件包分发（pack-assets 只排除 models/，
    //   vendor/ 会打进 zip），装好插件就由插件自己那份引擎工作。
    //
    //   ⚠️ 于是 APK 上跑视频通话的**前提**变成两条，缺一不可：
    //      ① 已安装 live2d-models 插件；
    //      ② 插件的 ensureEngine() 能从**插件自己目录**取引擎，而不是只认宿主
    //         /vendor/（那份已经不在了）—— 见 mods/live2d-models/index.js 的
    //         vendorFallbackBase 与注入循环里的 native 回落分支。
    //      两边是**一套改动**，别只改一边，否则视频通话只会报"引擎脚本加载失败"。
    //
    //   这三个文件在源仓库里当然还留着（电脑版要用），所以下面那套"源里没有 → 删"
    //   的过期清理抓不到它们 —— 必须显式清（见 HOST_FILES_NOT_IN_APK）。
    // Markdown + LaTeX 渲染（消息里的 **加粗**、列表、表格与 $公式$ 靠它们）
    ['vendor/marked/marked.min.js', 'vendor/marked/marked.min.js'],
    ['vendor/katex/katex.min.js', 'vendor/katex/katex.min.js'],
    ['vendor/katex/katex.min.css', 'vendor/katex/katex.min.css'],
];

// ★ 不再随 APK 分发、但要**从安卓工程里清掉**的宿主文件（引擎归 live2d-models 插件，
//   见上面那段说明）。源仓库里还留着它们（电脑版要用），所以不能靠"源里没有 → 删"。
const HOST_FILES_NOT_IN_APK = [
    'vendor/live2dcubismcore.min.js',
    'vendor/pixi-6.min.js',
    'vendor/pixi-live2d-display-cubism4.min.js',
];

// katex 字体：**必须一起同步**，否则公式会退化成方框/默认字体。
// 单独列是因为它在子目录里，且是二进制字体文件。
async function collectFontFiles(dir, prefix = '') {
    const out = [];
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
            out.push(...await collectFontFiles(path.join(dir, entry.name), rel));
        } else if (entry.isFile() && /\.(woff2?|ttf)$/i.test(entry.name)) {
            out.push(rel);
        }
    }
    return out;
}
for (const rel of (await collectFontFiles(path.join(sourceRoot, 'vendor', 'katex', 'fonts'))).sort()) {
    filesToCopy.push(['vendor/katex/fonts/' + rel, 'vendor/katex/fonts/' + rel]);
}

// web/js/ 下的前端脚本：**自动发现**，不写死清单。
//
// 为什么要自动：这些文件是 index.html 用 <script src="/js/xxx.js"> 引用的，漏同步一个
// 就会在 APK 里 404 → 页面白屏，而且 Web 版一切正常、只有装机才暴露，极难查。
// 之前手写清单时，每加一个前端脚本都得记得回来改这里 —— 这个"记得"迟早会失效。
//
// 只收 .js（含子目录），跳过隐藏文件与 .map。
async function collectJsFiles(dir, prefix = '') {
    const out = [];
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
            out.push(...await collectJsFiles(path.join(dir, entry.name), rel));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            out.push(rel);
        }
    }
    return out;
}

const jsFiles = (await collectJsFiles(path.join(sourceRoot, 'js'))).sort();
for (const rel of jsFiles) {
    filesToCopy.push(['js/' + rel, 'js/' + rel]);
}

// ==================== mod（插件）====================
//
// 为什么要打包进 APK：APK 里**没有服务端**，也就没有"扫描目录自动解压 zip"
// 那条路（浏览器无法列目录，服务端才有这个能力）。所以安卓端的 mod 只能
// 在构建时随 www 一起打进去，清单也随 www 一起带上。
//
// 用户仍可在安卓端启用/停用它们（设置 → 插件），只是不能像电脑版那样
// 丢个 zip 进去就装 —— 那需要服务端。
//
// 自动发现：整棵 mods/ 目录都收（含图片、样式、清单），不写死 mod 名。
// 与 js 的处理同理 —— 手写清单每加一个 mod 都要记得回来改，迟早会漏。
/**
 * 收集要同步进 APK 的 mod 文件。
 *
 * `lite` 为 true 时**只同步源码**（manifest.json / index.js / style.css），
 * 跳过 `img/` 等资源目录 —— 用于做"纯净版 APK"：程序本体 + 插件代码，
 * 图片与模型都当扩展包按需下载。
 *
 * 为什么按目录名判断而不是按扩展名：mod 的资源可能不止图片（以后可能有音频、
 * 字体），按 `img/` 目录排除更稳，也不会误伤将来别的资源目录 ——
 * 需要时把目录名加进 LITE_SKIP_DIRS 即可。
 *
 * ★★ 2026-10 修：`models` 必须也在跳过名单里。
 *    模型有**两套路径**，容易只想到一套：
 *      ① www/live2d/models/                     ← 旧的落地位置（给 APK 播种用）
 *      ② www/mods/live2d-models/models/         ← 插件目录下的源位置
 *    实测只清 ① 时，② 里 33.75MB 的模型照样被打进 APK，
 *    纯净版仍是 **47MB**（应为 ~10MB）。两个都要跳过。
 *    为什么不是只跳过 ① 就够：`collectModFiles` 会遍历整个 mods/ 树，
 *    把 ② 一起收走 —— 所以必须在**收集阶段**就跳过，光清残留不够。
 */
const LITE_SKIP_DIRS = new Set(['img', 'assets', 'audio', 'media', 'fonts', 'models']);

async function collectModFiles(dir, prefix = '', lite = false) {
    const out = [];
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        // 不同步 zip 安装包：那是"待安装"的源，APK 端没有解压能力，
        // 带上只是白占体积（解压好的目录才是真正要用的）
        if (entry.isFile() && /\.zip$/i.test(entry.name)) continue;
        // 纯净版：跳过资源目录（图片/模型都在这里）
        if (lite && entry.isDirectory() && LITE_SKIP_DIRS.has(entry.name)) continue;
        // 纯净版：跳过模型文件（.moc3 / .model3.json 等）——
        // 万一有 mod 把模型放在非资源目录下也别漏掉
        if (lite && entry.isFile() && /\.(moc3|model3\.json|physics3\.json|cdi3\.json|pose3\.json)$/i.test(entry.name)) continue;
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
            out.push(...await collectModFiles(path.join(dir, entry.name), rel, lite));
        } else if (entry.isFile()) {
            out.push(rel);
        }
    }
    return out;
}
// 主题样式表（web/css/ 下）—— 与 js/ 同理自动发现：
// 多主题的覆盖层就在这里，漏同步会让 APK 里主题切换无效（但页面不报错，
// 表现为"点了没反应"，很难联想到是同步遗漏）。
async function collectCssFiles(dir, prefix = '') {
    const out = [];
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
            out.push(...await collectCssFiles(path.join(dir, entry.name), rel));
        } else if (entry.isFile() && entry.name.endsWith('.css')) {
            out.push(rel);
        }
    }
    return out;
}
const cssFiles = (await collectCssFiles(path.join(sourceRoot, 'css'))).sort();
for (const rel of cssFiles) {
    filesToCopy.push(['css/' + rel, 'css/' + rel]);
}

// 自带音频（web/audio/ 下）—— 与 js/、css/ 同理自动发现。
//
// ★★ 2026-10 补：漏了这里，手机端的 MiMo TTS「内置样本」直接失效。
//   软件自带的伊蕾娜日语参考样本是 `web/audio/mimo-elaina-jp.m4a`（454KB），
//   前端从 `/audio/mimo-elaina-jp.m4a` 直接 fetch（见 app-06-settings.js 的
//   loadBuiltinMimoCloneSample）。电脑端有 serve.mjs 把 URL 映射到 web/audio/，
//   手机端没有服务端 —— 文件必须在 www/ 里，否则 fetch 404 →
//   「内置样本加载失败，请手动选择参考音频」，且切到 voiceclone 时的自动补样也失效。
//   只在装机后才暴露（电脑端一切正常），所以同样不能写死清单、得自动收全。
//
// ★--lite 也**不**跳过它：这是程序本体的一部分（与模型/图片那类扩展包资源不同），
//   体积只有几百 KB。
async function collectAudioFiles(dir, prefix = '') {
    const out = [];
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
            out.push(...await collectAudioFiles(path.join(dir, entry.name), rel));
        } else if (entry.isFile()) {
            out.push(rel);
        }
    }
    return out;
}
const audioFiles = (await collectAudioFiles(path.join(sourceRoot, 'audio'))).sort();
for (const rel of audioFiles) {
    filesToCopy.push(['audio/' + rel, 'audio/' + rel]);
}

// 插件源码：默认**不**打进 APK（与电脑版 fresh clone 一致，见顶部 `withMods` 的说明）。
// `--with-mods` 时仍收集（旧行为），`--lite` 时资源已被 collectModFiles 自己跳过。
const modFiles = withMods ? (await collectModFiles(modsSourceRoot, '', lite)).sort() : [];
for (const rel of modFiles) {
    filesToCopy.push(['mods/' + rel, 'mods/' + rel]);
}

// `--lite` 时清掉安卓工程里残留的 mod 图片与模型 ——
// 否则上一次带资源同步的文件会继续留在 www/ 里被打进 APK，
// "跳过资源"就名不副实了。（只清资源目录，不动插件代码。）
//
// ★★ 2026-10 修：原先只清 `www/`，**漏了 `cap sync` 的产物目录** ——
//    `android/app/src/main/assets/public/`。
//    实测：`--lite` 同步后 `www/live2d` 已经是 0 个文件，
//    但 `assets/public/live2d` 还留着 96 个、`mods/*/img` 还留着 40 个，
//    于是纯净版 APK 仍是 **101 MB**（应为 ~10 MB），`gradlew clean` 也清不掉
//    （clean 只删 build/，不碰 src/main/assets/）。
//    cap sync 是**只增不减**的复制：源里删掉的文件不会从产物里消失。
//    所以"跳过资源"必须**两个目录都清**：源（www）+ 产物（assets/public）。
const LITE_CLEAN_ROOTS = [androidWebRoot];
// cap sync 的产物目录（webDir=www → assets/public）。工程结构不同时自动跳过。
const capAssetsRoot = path.join(androidAppRoot, 'android', 'app', 'src', 'main', 'assets', 'public');
if (existsSync(capAssetsRoot)) LITE_CLEAN_ROOTS.push(capAssetsRoot);

if (lite) {
    let cleaned = 0;
    let cleanedDirs = 0;
    let modIds = [];
    try {
        modIds = (await readdir(modsSourceRoot, { withFileTypes: true }))
            .filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { /* 没有 mods 目录就跳过 */ }

    for (const root of LITE_CLEAN_ROOTS) {
        for (const id of modIds) {
            for (const sub of LITE_SKIP_DIRS) {
                const p = path.join(root, 'mods', id, sub);
                // 用 stat 判断存在（rm 对不存在的路径用 force 也不报错，
                // 但那样就数不出"清掉了几个"，日志会失去意义）
                try { await stat(p); } catch { continue; }
                await rm(p, { recursive: true, force: true });
                cleaned++;
            }
        }
        cleanedDirs++;
    }
    if (cleaned) {
        console.log(`  已清空 ${cleaned} 个 mod 资源目录（www/ + cap 产物目录，避免上次残留被打进 APK）`);
    }
}

// ★ `--with-mods` **没开**时，把安卓工程里残留的**整个 mods/ 目录**清掉。
//
//   上面的 lite 清理只动资源子目录（img/models），插件代码会留着 ——
//   那是 `--lite` 的语义（代码进包、资源走扩展包）。
//   但 2026-10 起默认语义变成了"**完全纯净**"（与电脑版 fresh clone 一致：
//   APK 里没有任何插件，全靠应用内安装），所以插件代码也要清。
//   仍是两处都清（www/ + cap 产物目录），理由见上面 LITE_CLEAN_ROOTS 的注释。
if (!withMods) {
    let cleaned = 0;
    for (const root of LITE_CLEAN_ROOTS) {
        const p = path.join(root, 'mods');
        try { await stat(p); } catch { continue; }
        await rm(p, { recursive: true, force: true });
        cleaned++;
    }
    if (cleaned) {
        console.log(`  已清空 ${cleaned} 处 mods/（纯净版：APK 不带任何插件，与电脑版 fresh clone 一致）`);
    }
}

// ★★ 2026-10：把"不再随 APK 分发"的宿主文件从安卓工程里清掉（正常与纯净模式都清）。
//   判据不是"源仓库里没有"（这几个文件在 web/vendor 里还在，电脑版要用），
//   而是一张**显式名单** —— 引擎已归 live2d-models 插件。不清的话，上一次同步留下的
//   旧副本会被 cap sync 继续打进 APK，"不带引擎"就名不副实。
{
    let removed = 0;
    for (const root of LITE_CLEAN_ROOTS) {
        for (const rel of HOST_FILES_NOT_IN_APK) {
            const p = path.join(root, rel);
            try { await stat(p); } catch { continue; }
            await rm(p, { force: true });
            removed++;
        }
    }
    if (removed) {
        console.log(`  已从安卓工程移除 ${removed} 个不再随 APK 分发的引擎文件（改由 live2d-models 插件提供）`);
    }
}

await mkdir(path.join(androidWebRoot, 'vendor'), { recursive: true });
for (const [src, dest] of filesToCopy) {
    const destPath = path.join(androidWebRoot, dest);
    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(path.join(sourceRoot, src), destPath);
}

// ==================== 内嵌 Node 工程（复制到 assets/nodejs/）====================
//
// 落地目录是**我们的**（不是 cap sync 的），所以这里可以放心地把过期文件删掉 ——
// 这也是把它放在 assets/ 根下、而不是 assets/public/ 的原因（见文件顶部常量处的说明）。
{
    const sourceDir = path.join(sourceRoot, 'nodejs');
    /** 收整棵目录，不限扩展名：以后可能有 .json、证书、静态资源等 */
    async function collectNodeHostFiles(dir, prefix = '') {
        const out = [];
        let entries = [];
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const rel = prefix ? prefix + '/' + entry.name : entry.name;
            if (entry.isDirectory()) out.push(...await collectNodeHostFiles(path.join(dir, entry.name), rel));
            else if (entry.isFile()) out.push(rel);
        }
        return out;
    }

    // ★★ 2026-10：与 app/build.gradle 的 buildNodeRuntime 是**同一个开关**（环境变量）。
    //   默认关：什么都不复制，并且让下面的"过期清理"把上次留下的整个 assets/nodejs
    //   清干净 —— 否则旧副本会被 cap sync 继续打进 APK，"摘掉 Node"就名不副实
    //   （而且是白占体积的死文件）。
    //   打开：设 ELAINA_NODE_RUNTIME=1 再同步（gradle 侧读的是同一个变量）。
    const nodeRuntime = String(process.env.ELAINA_NODE_RUNTIME || '') === '1';

    // 计划表：[源绝对路径, 目标相对路径]。关掉时留空 —— 空计划 = 只清理、不复制。
    const plan = [];
    if (nodeRuntime) {
        for (const rel of (await collectNodeHostFiles(sourceDir)).sort()) {
            plan.push([path.join(sourceDir, rel), rel]);
        }
        // 与电脑端共用的后端模块（见顶部 SHARED_SERVER_MODULES 的说明）。
        // 文件不存在时 copyFile 会直接抛错 → 同步失败 —— 这正是想要的：
        // 模块改名/搬走却忘了改这里，必须当场炸，而不是安静地让 APK 少一个文件。
        for (const name of SHARED_SERVER_MODULES) {
            plan.push([path.join(projectRoot, 'server', name), 'server/' + name]);
        }
    }

    // 清掉这次不再要的文件：既包含"源里删了的"，也包含"开关关掉后的整个目录"
    const desired = new Set(plan.map(([, dest]) => dest));
    let staleRemoved = 0;
    for (const rel of await collectNodeHostFiles(nodeHostDestRoot).catch(() => [])) {
        if (desired.has(rel)) continue;
        await rm(path.join(nodeHostDestRoot, rel), { force: true });
        staleRemoved++;
    }

    for (const [srcPath, dest] of plan) {
        const destPath = path.join(nodeHostDestRoot, dest);
        await mkdir(path.dirname(destPath), { recursive: true });
        await copyFile(srcPath, destPath);
    }
    console.log(nodeRuntime
        ? `  内嵌 Node 工程：${plan.length} 个文件 → assets/nodejs/（含 ${SHARED_SERVER_MODULES.length} 个与电脑端共用的后端模块）`
            + (staleRemoved ? `，顺带清掉 ${staleRemoved} 个过期文件` : '')
        : `  内嵌 Node 工程：未打包（默认关闭；要打开就设 ELAINA_NODE_RUNTIME=1）`
            + (staleRemoved ? `，已清掉工程里残留的 ${staleRemoved} 个文件` : ''));
}

// ★★ 清掉"宿主已删、安卓工程里还留着"的旧文件（2026-10 新增）。
//
//   为什么必须有这一步：这个脚本只**复制**，从不**删除**。所以源仓库里删掉一个
//   宿主文件后，安卓工程里的旧副本会一直留着 —— 而 `cap sync` 会把它一起打进
//   APK。实测踩到：`web/live2d-video.js` 早已随"Live2D 搬成插件"删除
//   （源文件不存在、index.html 也不引用它），但 `assets/public/live2d-video.js`
//   仍在 APK 里 —— 一份**永远不会被加载**的死代码，白占体积，还会让排查的人
//   以为 Live2D 仍是宿主实现。
//
//   ★ 判据：**源仓库里没有这个文件** → 过期，删。
//     不能用"不在 filesToCopy 里"当判据 —— filesToCopy 是"要同步什么"的清单，
//     不是"宿主需要什么"的权威清单（它刻意略过 diag-param-bind.html 等）。
//     我第一版就是这么写的，结果把 `vendor/live2dcubismcore.min.js` 等三个文件
//     也删了 —— 而它们**确实还在** web/vendor/ 下，且是 APK 上 Live2D 的引擎
//     来源（插件的 /live2d/vendor/ 在 APK 上没有服务端可映射，靠 /vendor/ 兜底）。
//     那次误删会被 cap sync 打进 APK，表现为"视频通话打不开"。
//
//   ⚠️ 只动 www/，**不动** cap 产物目录（assets/public/）：那个目录整体由
//      `cap sync` 覆盖式生成，我们在这里删它反而可能与 sync 的行为打架。
//      它下次 `build:apk` 时会自己跟 www/ 对齐。
{
    // 这两处不归本清单管：mods/ 由上面的纯净版清理负责，
    // live2d/models/ 由下面的模型打包负责。
    const skipPrefix = ['mods/', 'live2d/models/'];
    let removed = 0;
    for (const rel of await walk(androidWebRoot).catch(() => [])) {
        const norm = rel.replace(/\\/g, '/');
        if (skipPrefix.some((p) => norm.startsWith(p))) continue;
        // ★ 关键判据：源仓库里还有这个文件吗？有就说明它**没被删**，不能动。
        let existsInSource = false;
        try {
            await stat(path.join(sourceRoot, rel));
            existsInSource = true;
        } catch { /* 源里没有 → 过期 */ }
        if (existsInSource) continue;
        try {
            await rm(path.join(androidWebRoot, rel), { force: true });
            removed++;
            console.log(`  已删除安卓工程里的过期文件：${norm}（源仓库已没有它）`);
        } catch { /* 删不掉不影响同步结果 */ }
    }
    if (removed) console.log(`  共清理 ${removed} 个过期宿主文件`);
}

console.log(`Synced ${filesToCopy.length} files (customized Web UI incl. Live2D) into the Android project.`);
if (jsFiles.length) console.log(`  frontend scripts: ${jsFiles.map((f) => 'js/' + f).join(', ')}`);
if (modFiles.length) console.log(`  mods: ${modFiles.length} files`);
if (cssFiles.length) console.log(`  css: ${cssFiles.map((f) => 'css/' + f).join(', ')}`);
if (audioFiles.length) console.log(`  audio: ${audioFiles.map((f) => 'audio/' + f).join(', ')}`);

// ==================== 内置 Live2D 模型 ====================
// 仓库里 web/mods/live2d-models/models/ 下的模型随 APK 分发：复制进安卓工程的 www/live2d/models/，
// 并生成 manifest.json。APK 里没有服务端，模型没法从接口取，只能打包进去：
// App 首次启动时按这份清单把模型"种"进应用数据目录（见 index.html 的 seedBundledLive2dModels），
// 之后列表与加载逻辑跟用户自己上传的模型走同一条路径，不需要额外适配。
//
// `--lite` / `--no-models` 时跳过（开关定义在文件顶部，那里有完整说明）。

/** 递归列出目录下所有文件（返回相对路径，正斜杠分隔） */
async function walk(dir, prefix = '') {
    const out = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) out.push(...await walk(path.join(dir, entry.name), rel));
        else out.push(rel);
    }
    return out;
}

// 跳过打包模型的方式有两种，都支持：
//   · 命令行参数 --lite / --no-models（推荐，一眼看得出这次同步不带资源）
//   · 环境变量 SKIP_LIVE2D_MODELS=1（CI 里方便）
//
// `--lite` 是"纯净版"：**模型与 mod 图片都不进 APK**，只留程序本体 + 插件代码。
// 手机端与电脑端口径一致 —— mod 与 live2d 都当扩展包按需下载安装。
// （lite / skipModels 的定义在文件顶部，那里有完整说明）

let modelDirs = [];
if (skipModels) {
    console.log(lite
        ? '--lite 模式：Live2D 模型与 mod 图片都不打包（纯净版 APK）'
        : '--no-models 模式：Live2D 模型不打包');
} else {
    try {
        modelDirs = (await readdir(modelsSourceRoot, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    } catch { /* 没有模型目录就跳过，不影响前端同步 */ }
}

if (skipModels) {
    // 清掉安卓工程里残留的模型 + 清单，确保它们不会被打进 APK。
    // ★★ 2026-10 修：原先只清 www/，漏了 cap sync 的产物目录
    //    （android/app/src/main/assets/public/live2d/models）—— 那里残留的模型
    //    照样会被打进 APK，实测纯净版仍是 101MB。两个目录都要清。
    const roots = [androidWebRoot];
    if (existsSync(capAssetsRoot)) roots.push(capAssetsRoot);
    for (const root of roots) {
        // ① 旧的落地位置：<root>/live2d/models/
        const dest = path.join(root, 'live2d', 'models');
        await rm(dest, { recursive: true, force: true }).catch(() => {});
        await rm(path.join(root, 'live2d', 'models', 'manifest.json'), { force: true }).catch(() => {});
        // ② 插件目录下的源位置：<root>/mods/live2d-models/models/
        //    ★ 漏了它纯净版就仍是 47MB（实测踩到）—— 模型在这里有整整一套。
        await rm(path.join(root, 'mods', 'live2d-models', 'models'), { recursive: true, force: true }).catch(() => {});
    }
    console.log('  已清空 live2d 模型（www/ + cap 产物目录，两套路径都清，避免上次残留被打进去）');
} else if (!modelDirs.length) {
    console.log('No Live2D model in mods/live2d-models/models/ — nothing bundled.');
} else {
    // 先算出这次要写进去的完整文件集，再决定删什么。
    //
    // 原来是先 `rm -rf` 整个 models 目录再重建，但那样一次要删上百个文件，
    // 会撞上运行环境的批量删除保护（单次超过 50 个直接拒绝），整个 build 失败。
    // 改成"只删这次不会再写回去的旧文件"：既绕开了这个问题，也不用每次把没变过的模型重删一遍，
    // 而且中途失败不会留下半个空目录。
    const manifestModels = [];
    const desiredFiles = new Set(['manifest.json']);
    let totalFiles = 0;
    let totalBytes = 0;

    for (const name of modelDirs) {
        const srcDir = path.join(modelsSourceRoot, name);
        const files = (await walk(srcDir)).sort();
        const modelJson = files.find((f) => f.toLowerCase().endsWith('.model3.json'));
        if (!modelJson) {
            console.log(`  skip ${name} (no .model3.json)`);
            continue;
        }
        for (const rel of files) desiredFiles.add(name + '/' + rel);
        totalFiles += files.length;
        // 顺带记下每个文件的字节数：APK 首次启动播种时用它校验"数据目录里已种的文件是否完整"。
        // 只比文件名的话，上次播种中途失败写出的半截文件会被当成"已种过"，坏状态永远修不回来。
        const sizes = {};
        for (const rel of files) {
            const bytes = (await stat(path.join(srcDir, rel))).size;
            sizes[rel] = bytes;
            totalBytes += bytes;
        }
        manifestModels.push({ name, modelJson, files, sizes });
    }

    // 清理残留（模型已从仓库删掉的情况）
    let staleRemoved = 0;
    for (const rel of await walk(modelsDestRoot).catch(() => [])) {
        if (desiredFiles.has(rel)) continue;
        await rm(path.join(modelsDestRoot, rel), { force: true });
        staleRemoved++;
    }
    if (staleRemoved) console.log(`Removed ${staleRemoved} stale file(s) from the Android project.`);

    for (const { name } of manifestModels) {
        const srcDir = path.join(modelsSourceRoot, name);
        for (const rel of await walk(srcDir)) {
            const src = path.join(srcDir, rel);
            const dest = path.join(modelsDestRoot, name, rel);
            await mkdir(path.dirname(dest), { recursive: true });
            await copyFile(src, dest);
        }
    }

    await writeFile(
        path.join(modelsDestRoot, 'manifest.json'),
        JSON.stringify({ version: 1, models: manifestModels }, null, 2) + '\n',
        'utf8',
    );
    console.log(
        `Bundled ${manifestModels.length} Live2D model(s): ${totalFiles} files, `
        + `${(totalBytes / 1048576).toFixed(1)} MB (${manifestModels.map((m) => m.name).join(', ')})`,
    );
}
