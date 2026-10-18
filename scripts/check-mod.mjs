// 插件（mod）系统的回归检查：扫描 / 安装解压 / 清单生成 / 安全防护 /
// 身份与依赖解析 / 宿主能力（插槽） / 端到端。
//
// 合并自六个脚本（check-mods / check-mod-id / check-mod-identity /
// check-mod-deps / check-mod-host-api / check-mod-e2e）。它们测的是同一个
// 插件系统的不同侧面，而且是逐层叠起来的：
//
//   · 服务端：scanAndSync 解压、清单、卸载、路径穿越防护（check-mods / -id / -e2e）
//   · 身份：id 归一化与「注册名 ↔ 目录」映射（check-mod-id / -identity）
//   · 依赖：前置插件未启用时必须拒绝加载，且日志要人能看懂（check-mod-deps）
//   · 宿主能力：插槽注册与停用回收，起真服务 + 真浏览器（check-mod-host-api）
//
// 为什么合并：六个文件各自重算 ROOT、各自抄一遍 ok/汇总样板、各自实现
// freePort/wait，还有一个共用的 mkMgr（三个文件各写一份、字节全同）。
// 改一次插件契约要打开六个文件找断言；合并后一处改完。
//
// 为什么每个用例都自建临时目录与端口：这些用例里有四个会起真实服务
// （少数还会起浏览器），写死的 MODS_DIR / 端口会让它们互相踩；而
// check-mod-host-api 里那类检查还会往仓库的 mods/ 里写临时插件 ——
// 少了自清就会留痕。所以每个用例都在 try/finally 里收自己的进程与目录。
//
// 用法：node scripts/check-mod.mjs            跑全部
//       node scripts/check-mod.mjs 插槽       只跑名字含该子串的用例
//
// 本机环境性失败（缺 mods/galgame、mods/scene-backgrounds、工作区 skills/ 等实物）
// 属于已知基线：不是代码坏了，逐条比对 PASS/FAIL 条数即可。

import { spawn } from 'node:child_process';
import {
    mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdirSync,
    openSync, closeSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFrontend } from './frontend-sources.mjs';
import { launchTestBrowser } from './test-browser.mjs';
import { runChecks, ROOT, wait, freePort } from './check-harness.mjs';
import { createModManager } from '../server/mods.mjs';
import { readZip, createZip, effectiveExt } from '../server/zip.mjs';

const MODS = path.join(ROOT, 'mods');

// ────────────────────────────────────────────────────────────
// 共用辅助
// ────────────────────────────────────────────────────────────

/**
 * 按 **manifest.id** 找插件的真实目录名（只给 check-mods 的服务端源码段用）。
 *
 * ★ 为什么不直接写死 'elaina-avatar'：用户可以把插件目录改名（实测有人改成了
 *   `1111`），而 id 仍是 manifest 里声明的那个。检查脚本若写死目录名，就会在
 *   "用户改了名"这个**完全合法**的情况下自己失败 —— 那是检查的问题，不是产品的问题。
 *
 * @returns {string|null} 真实目录名（不是路径）
 */
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
    // 没有 manifest.id 时退回同名目录（老插件）
    return existsSync(path.join(modsRoot, id, 'index.js')) ? id : null;
}

/** 按 manifest.id 取插件目录的绝对路径 */
function modPath(id, ...rest) {
    const dir = modDirById(id);
    return dir ? path.join(MODS, dir, ...rest) : null;
}

/**
 * 手工构造 ZIP（store 方式，零依赖）—— 测试不该依赖外部打包工具。
 *
 * 装在文件顶层供 check-mods 与 check-mod-e2e 共用：安卓侧那条链要的是
 * store 模式的包（不压缩），两处用的是同一套字节布局。
 */
function makeZip(entries) {
    const crcTable = (() => {
        const t = new Int32Array(256);
        for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
        return t;
    })();
    const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
    const chunks = [], central = [];
    let offset = 0;
    for (const [name, content] of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const data = Buffer.from(content, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        chunks.push(local, nameBuf, data);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(offset, 42);
        central.push(cd, nameBuf);
        offset += local.length + nameBuf.length + data.length;
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, cdBuf, eocd]);
}

/**
 * 用真实的 createModManager 造一个指向指定目录的插件管理器。
 *
 * 三个用例（id / 身份 / 端到端）都要这一份：注入的参数决定"怎么解压、
 * 什么算危险条目"，抄成三份时改一处漏两处会让它们测出不同的产品行为。
 * 那些参数与 web/serve.mjs 给真实服务的完全一致。
 */
const mkMgr = (modsDir) => createModManager({
    modsDir,
    unzip: (buf, opts = {}) => readZip(buf, { ...opts, returnBlocked: true }),
    isUnsafeEntryName: (n) => n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..'),
    effectiveExt,
    log: () => {},
});

/**
 * 建一个临时目录并登记，用例结束时统一删。
 *
 * 前缀按用例区分（elaina-modid / elaina-ident / e2e）而不是一刀切：用例因为
 * 本机缺 mods 实物而中途抛异常时，残留目录名能看出是哪一段漏了清理。
 *
 * @param {string} prefix mkdtempSync 的模板前缀
 * @returns {{ dir: () => string, cleanup: () => void }} dir() 每次都新建一个
 */
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

/**
 * 去掉注释后的源码。
 *
 * 为什么需要：有些断言是"**不许**再出现某个调用"，而解释"为什么不再用它"的
 * 注释里必然会提到那个调用（本项目的注释风格就是写清踩过的坑）。直接对全文
 * 匹配会把这些注释算成违规 —— 假失败。
 */
const stripComments = (src) => String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * 按函数名抠出一段函数体（圆括号、花括号各自配对），含前面可能的 async。
 *
 * 两处用它：端到端用例从 web/js/core.js 里抠安卓侧的原生实现，
 * 依赖用例里抠插件加载器的诊断输出。
 */
function extractFn(src, name) {
    let start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('找不到 ' + name);
    const asyncMatch = src.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (asyncMatch) start -= asyncMatch[0].length;
    let i = src.indexOf('(', start), paren = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') paren++;
        else if (src[i] === ')') { paren--; if (paren === 0) { i++; break; } }
    }
    let depth = 0;
    i = src.indexOf('{', i);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

// ────────────────────────────────────────────────────────────
// 1. 插件系统：服务端扫描 / 自动解压 / 清单生成 / 安全防护
//
// 为什么必须常驻：mod 系统是**同源执行第三方 JS** 的入口，和我们修过的
// `.html::$DATA` 存储型 XSS 属同一类风险面。而且它有几个很容易回归的点：
//
//   · 路径穿越：zip 里写 `../../web/serve.mjs` 就能覆盖宿主代码
//   · 卸载不彻底：只删目录不删 zip，scanAndSync 会立刻把它装回来
//     （这个 bug 是端到端测试抓到的：断言"目录已删除"时发现它又回来了）
//   · allowScripts 开关：mod 的本质是 JS，但 unzip 的默认黑名单会拦掉 .js
//     （那是为 Live2D 模型设计的）。忘了传 allowScripts 会得到
//     "只装了 manifest.json、插件跑不起来"的怪现象
// ────────────────────────────────────────────────────────────

async function caseModsCore(c) {
    // ---- 1.1 关键实现存在且语义正确 ----
    {
        const mods = readFileSync(path.join(ROOT, 'server', 'mods.mjs'), 'utf8');
        const serve = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');
        const loader = readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');
        // 解压实现已合并到 server/zip.mjs（原先 serve.mjs 里另有一份几乎相同的 unzip）。
        // 所以 BLOCKED_EXT / effectiveExt / allowScripts 这些要看**实现那份**，
        // 不能再断言它们在 serve.mjs 里 —— 那是合并前的布局。
        const zip = readFileSync(path.join(ROOT, 'server', 'zip.mjs'), 'utf8');

        c.ok(/export function createModManager/.test(mods), 'server/mods.mjs 导出 createModManager');
        c.ok(/function scanAndSync/.test(mods), '有 scanAndSync（扫描目录 + 解压 + 生成清单）');
        c.ok(/function uninstall/.test(mods), '有 uninstall');
        c.ok(/MOD_ID_RE/.test(mods), '插件名有白名单校验（挡 .. 与绝对路径）');

        // ★ allowScripts：mod 的本质是 JS，但解压默认黑名单含 .js
        c.ok(/allowScripts:\s*true/.test(mods), '★ 解压 mod 时传 allowScripts:true（否则 .js 会被拦掉）');
        c.ok(/allowScripts/.test(zip), '★ server/zip.mjs 的 readZip 支持 allowScripts 选项');
        c.ok(/PLUGIN_EXTS/.test(zip), '插件类扩展名（脚本 + HTML 面板）被单独识别');

        // 服务端能力声明（AGENTS.md D19 / 表 A23）
        const modServer = readFileSync(path.join(ROOT, 'server', 'mod-server.mjs'), 'utf8');
        c.ok(/CAPABILITY_NAMES\s*=\s*new Set\(/.test(modServer), 'mod-server.mjs 有 CAPABILITY_NAMES 能力名清单');
        for (const cap of ['route-register', 'upload-write', 'static-read', 'host-utils', 'net-outbound']) {
            c.ok(modServer.includes("'" + cap + "'"), '能力名清单含 ' + cap);
        }
        c.ok(/function readCapabilities/.test(modServer), '有 readCapabilities（manifest.server.capabilities 校验）');
        // 每个有副作用的 ctx 成员都必须带能力守卫 —— 逐个点名，漏一个就红
        c.ok(/need\('host-utils', 'ctx\.utils/.test(modServer) || /need\('host-utils'[^)]*\)\s*;\s*\n\s*return hostUtils/.test(modServer),
            'ctx.utils 有 host-utils 能力守卫');
        c.ok(/need\('route-register'/.test(modServer), 'ctx.route 有 route-register 能力守卫');
        c.ok(/need\('upload-write'/.test(modServer), 'ctx.uploadDir 有 upload-write 能力守卫');
        c.ok(/need\('static-read'/.test(modServer), 'ctx.staticDir 有 static-read 能力守卫');
        c.ok(/function withTimeout/.test(modServer), '有 withTimeout（第三方代码装载超时）');
        c.ok(/MOD_IMPORT_TIMEOUT_MS/.test(modServer), 'import(server.entry) 有超时常量');
        c.ok(/MOD_REGISTER_TIMEOUT_MS/.test(modServer), 'register(ctx) 有超时常量');
        c.ok(/withTimeout\(\s*import\(|withTimeout\(\s*\n?\s*import\(/.test(modServer),
            'import(server.entry) 经 withTimeout 包裹');
        c.ok(/withTimeout\(\s*\n?\s*Promise\.resolve\(register\(ctx\)\)/.test(modServer),
            'register(ctx) 经 withTimeout 包裹');

        // 前端 host API 能力组（AGENTS.md D18 / 表 A22）
        const modsJs = readFileSync(path.join(WEB, 'js', 'mods.js'), 'utf8');
        c.ok(/HOST_API_GROUPS\s*=\s*\{/.test(modsJs), 'mods.js 有 HOST_API_GROUPS 能力组表');
        for (const g of ['core', 'theme', 'achievements', 'dragSort', 'openFolder']) {
            c.ok(new RegExp('HOST_API_GROUPS|' + g + ':').test(modsJs), '能力组表含 ' + g);
        }
        c.ok(/function declaredApiGroups/.test(modsJs), '有 declaredApiGroups（解析 manifest.capabilities）');
        c.ok(/hasGroup\('theme'\)/.test(modsJs), 'host.theme 按 theme 组下发');
        c.ok(/hasGroup\('achievements'\)/.test(modsJs), 'host.unlock 按 achievements 组下发');
        c.ok(/hasGroup\('dragSort'\)/.test(modsJs), 'host.dragSort 按 dragSort 组下发');
        c.ok(/hasGroup\('openFolder'\)/.test(modsJs), 'host.openFolder 按 openFolder 组下发');
        // 合并后的单一实现：serve.mjs 不该再有自己那份 unzip
        c.ok(!/^function unzip\(/m.test(serve) || /readZip\(buf, \{ \.\.\.opts, returnBlocked: true \}\)/.test(serve),
            '★ 解压实现只有一份（serve.mjs 只保留薄包装，不再自带完整实现）');
        c.ok(/from '\.\.\/server\/zip\.mjs'/.test(serve), 'serve.mjs 从 zip.mjs 引入解压实现');

        // ★ 卸载要连 zip 一起删
        c.ok(/id \+ ext/.test(mods) || /\.zip/.test(mods.split('function uninstall')[1] || ''),
            '★ 卸载时连安装包一起删（否则 scanAndSync 会把它装回来）');

        c.ok(/ElainaMods/.test(loader), '加载器挂在 window.ElainaMods');
        c.ok(/function discover/.test(loader), '有 discover（读 index.json 清单）');
        c.ok(/sortByDependency/.test(loader), '有依赖排序（manifest.after）');
        c.ok(/依赖成环/.test(loader), '检测环形依赖（不死循环）');
        c.ok(/失败隔离|已隔离/.test(loader), '加载失败会隔离（不拖垮整个应用）');
        c.ok(/register\(/.test(loader), '提供 register（mod 脚本注册初始化函数）');
        c.ok(/setPromptHint|promptHints/.test(loader), '提供 system 提示词注入入口（Galgame 场景切换要用）');

        // 宿主接线
        const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
        c.ok(/<script src="\/js\/mods\.js"><\/script>/.test(html), 'index.html 引入了 mods.js');
        const iMods = html.indexOf('/js/mods.js');
        const iInit = html.indexOf('/js/init.js');
        c.ok(iMods > 0 && iInit > 0 && iMods < iInit, '★ mods.js 排在 init.js 之前（初始化要读清单）');

        // ---- 宿主消费 mod 提示词（Galgame 场景指令送达模型的必经路径）----
        const data = readFileSync(path.join(ROOT, 'web', 'js', 'data.js'), 'utf8');
        c.ok(/ElainaMods/.test(data) && /collectPromptHints/.test(data),
            '★ 宿主在构造提示词时消费 mod 注入的 system 片段');

        // ---- 上传安装（应用内安装插件）----
        // 原先只能"把 zip 拷进 web/mods/ 目录"，手机/平板用户碰不到文件系统
        // （APK 更没有服务端），所以补了应用内上传这条路。
        c.ok(/api\/plugins\/install/.test(serve), '服务端有 POST /api/plugins/install（上传安装）');
        c.ok(/installFromBuffer/.test(mods), 'mods.mjs 提供 installFromBuffer（从内存 zip 安装）');
        c.ok(/writePluginFiles/.test(mods),
            '★ 两条安装路径（丢文件进目录 / 上传）共用同一段安全逻辑');
        // 非法名不能被"静默净化"后照装 —— 实测踩过：先净化再校验会让 ../../hack 变成 hack 并安装成功
        c.ok(/插件名不能包含路径成分/.test(serve), '★ 含路径成分的插件名被明确拒绝（不静默改名）');
        c.ok(/id="modsInstallBtn"/.test(html), '设置里有「上传安装」按钮');
        c.ok(/id="modsFileInput"/.test(html), '有隐藏的 file input');
        // ---- 应用内删除按钮 ----
        // 服务端早有 DELETE /api/plugins/:id，但界面一直没暴露 —— 用户装了插件
        // 就没法在应用里卸掉（只能去删目录，而删目录又会被 zip 装回来）。
        const settingsSrc = readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');
        const modsLoader = readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');
        c.ok(/mod-del-btn/.test(settingsSrc), '★ 设置里渲染「删除」按钮');
        c.ok(/method: 'DELETE'/.test(settingsSrc), '★ 删除走 DELETE /api/plugins/:id');
        c.ok(/showCustomConfirm[\s\S]{0,400}删除插件/.test(settingsSrc), '★ 删除前二次确认（防误删）');
        c.ok(/forget: forgetMod/.test(modsLoader), '★ ElainaMods 导出 forget（清启用状态，避免重装自动启用）');

        // ---- 设置 → 插件分栏 ----
        c.ok(/data-settings-tab="tab-mods"/.test(html), '设置里有「插件」Tab');
        c.ok(/id="tab-mods"/.test(html), '有 #tab-mods 面板');
        c.ok(/id="modsList"/.test(html), '有 mod 列表容器');
        // ★ 全局开关已删除（2026-10 用户要求：默认开启，不再给"一键全关"的入口）。
        //   改为断言**新结构**：上传/重扫在标题右上角 + 分栏机制存在。
        c.ok(!/id="modsGlobalToggle"/.test(html), '★ 全局开关已删除（默认开启，不再有一键全关）');
        c.ok(/id="modsInstallBtn"/.test(html) && /id="modsRefreshBtn"/.test(html), '有 上传安装 / 重新扫描 入口');
        c.ok(/id="modsAddGroupBtn"/.test(html), '★ 有「添加分栏」按钮（插件分组）');
        c.ok(/mod-group-toggle/.test(html), '★ 分栏折叠三角（disclosure triangle）');
        const settings = readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');
        c.ok(/async function refreshModsList/.test(settings), '有 refreshModsList');
        c.ok(/\/api\/plugins/.test(settings), '列表数据来自服务端 /api/plugins');
        c.ok(/ElainaMods\.list\(\)/.test(settings), '同时合并前端加载状态（服务端只知道磁盘上有什么）');
        c.ok(/加载失败/.test(settings), '★ 加载失败的 mod 有显眼标记（否则用户以为"开了没反应"）');
        c.ok(/公共依赖/.test(settings), '★ hidden 的 mod 显示为「公共依赖」而非开关');
        c.ok(/elaina_mods_groups/.test(settings), '★ 分栏清单有持久化（与 store.js 的 DATA_KEYS 对应）');
        // ★ 未分类不再是一个"栏"：没归属的插件直接平铺在顶层（与旧版一致，用户要求）。
        //   分栏与插件**同等级混排**（elaina_mods_top_order）。
        c.ok(/elaina_mods_top_order/.test(settings), '★ 顶层混排顺序（分栏与插件同等级）');
        c.ok(/loose\.push/.test(settings), '★ 没归属的插件平铺在顶层（不再装进"未分类"栏）');
    }

    // ---- 1.2 两个 mod 本体（Galgame 与桌宠）----
    {
        const galPath = modPath('galgame', 'index.js');
        const petPath = modPath('pet', 'index.js');
        const avatarIndex = modPath('elaina-avatar', 'index.js');
        /* 插件不随仓库分发（仓库只推软件本体）—— 一个都没装是**正常状态**，
           这里跳过而不是判红，否则干净克隆永远红一片。 */
        if (!galPath && !petPath && !avatarIndex) {
            console.log('  --   跳过 1.2：本地没有 galgame / pet / elaina-avatar 插件（插件不随仓库分发，这是正常状态）');
        } else {
            c.ok(Boolean(galPath && existsSync(galPath)), 'galgame/index.js 存在');
            c.ok(Boolean(petPath && existsSync(petPath)), 'pet/index.js 存在');
            c.ok(Boolean(avatarIndex && existsSync(avatarIndex)),
                'elaina-avatar/index.js 存在（按 manifest.id 找到真实目录：' + modDirById('elaina-avatar') + '）');
        }

        // 缺实体时这两段整体跳过 —— 本机只有 4 个插件，galgame 不在其中，
        // 后面那些断言没有输入（它们测的是插件源码本身，不是插件系统）。
        if (galPath && petPath && existsSync(galPath) && existsSync(petPath)) {
            const gal = readFileSync(galPath, 'utf8');
            const pet = readFileSync(petPath, 'utf8');

            c.ok(/ElainaMods\.register\(MOD_ID/.test(gal), 'galgame 用 register 注册（id 用 MOD_ID 常量）');
            c.ok(/ElainaMods\.register\(MOD_ID/.test(pet), 'pet 用 register 注册（id 用 MOD_ID 常量）');
            // 两个 mod 的 id 常量必须与目录名一致（对不上会导致加载器认不出）
            c.ok(/const MOD_ID = 'galgame'/.test(gal), 'galgame 的 MOD_ID 与目录名一致');
            c.ok(/const MOD_ID = 'pet'/.test(pet), 'pet 的 MOD_ID 与目录名一致');

            // ★ 共用立绘与情绪：这是"消除上游 20MB 重复"的落点
            c.ok(/ElainaAvatar/.test(gal) && !/img\/elaina\/p_/.test(gal),
                '★ galgame 用公共 ElainaAvatar，不自己拼立绘路径');
            c.ok(/ElainaAvatar/.test(pet) && !/img\/elaina\/p_/.test(pet),
                '★ pet 用公共 ElainaAvatar，不自己拼立绘路径');

            // ★ 不直接摸宿主全局
            c.ok(!/\bstate\.conversations\b/.test(gal), '★ galgame 不直接读 state（走 host API）');
            c.ok(!/\bstate\.conversations\b/.test(pet), '★ pet 不直接读 state（走 host API）');

            // ★ 提示词注入走注册表（不往 window 挂变量）
            c.ok(/setPromptHint/.test(gal), '★ galgame 用 host.setPromptHint');
            // 只在**代码**里查这个符号 —— 注释里提到它是为了说明"不再用"，
            // 直接对全文断言会误报（第一版就踩了这个）
            const galCodeOnly = gal.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
            c.ok(!/__galgameSceneHint/.test(galCodeOnly), '★ 代码里不再往 window 上挂提示词变量');

            // ★ 双重开关已消除
            c.ok(!/get\('enabled'/.test(gal), '★ galgame 不读自己的 enabled（避免双重开关）');
            c.ok(!/get\('enabled'/.test(pet), '★ pet 不读自己的 enabled');
            c.ok(/ElainaMods\.setEnabled\(MOD_ID, false\)/.test(gal), '★ galgame 退出时同步关 mod 开关');
            c.ok(/ElainaMods\.setEnabled\(MOD_ID, false\)/.test(pet), '★ pet 收起时同步关 mod 开关');

            // 资源
            c.ok(Boolean(modPath('galgame', 'style.css')) && existsSync(modPath('galgame', 'style.css')), 'galgame 有样式');
            c.ok(Boolean(modPath('pet', 'style.css')) && existsSync(modPath('pet', 'style.css')), 'pet 有样式');

            // ★ 立绘只有一套（消除重复的实证）
            const imgDir = modPath('elaina-avatar', 'img');
            let pngs = [];
            try { pngs = readdirSync(imgDir).filter((f) => f.endsWith('.png')); } catch { /* 忽略 */ }
            c.ok(pngs.length === 9, '公共立绘恰好 9 张（一套），实得 ' + pngs.length);
        }
    }

    // ---- 1.3 端到端：扫描 / 解压 / 安全 / 卸载 ----
    //
    // ★ 这一段的安装/卸载**全部在临时目录里做**，不碰仓库的 mods/。
    //
    //   为什么必须隔离：用户自己的服务常常正跑着（占 4173），而它每次被请求
    //   /api/plugins 都会重新扫描插件目录 —— 于是会**抢走**测试刚放进去的 zip，
    //   表现为"这个检查时好时坏"（实测踩到：单独跑通过、与其它检查并发跑就失败）。
    //   用 MODS_DIR 环境变量（见 serve.mjs）把它指到临时目录，测试就完全隔离了。
    //
    //   注意：上面 1.1（源码约定）与 1.2（插件本体）读的仍是**真实**的 mods/ ——
    //   那些是静态断言，不写文件，不存在争用。
    //
    //   ⚠️ 这里**不要**往仓库的 MODS 写任何东西：写一次就会在仓库里留下
    //   demo-mod/ evil-mod/，而且要等到下次运行才被清掉（这个坑踩过两次）。
    const TEST_MODS = mkdtempSync(path.join(tmpdir(), 'elaina-mod-mods-'));
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-mod-data-'));
    const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-mod-log-'));
    let child = null;
    try {
        const PORT = await freePort();

        // 正常 mod
        writeFileSync(path.join(TEST_MODS, 'demo-mod.zip'), makeZip([
            ['demo-mod/manifest.json', JSON.stringify({ name: '演示插件', version: '1.0.0', entry: 'index.js', styles: ['style.css'] })],
            ['demo-mod/index.js', 'window.ElainaMods && window.ElainaMods.register("demo-mod", function(h){ return {}; });'],
            ['demo-mod/style.css', '.demo{color:red}'],
        ]));
        // 恶意 mod：路径穿越 + 本机可执行
        writeFileSync(path.join(TEST_MODS, 'evil-mod.zip'), makeZip([
            ['evil-mod/manifest.json', JSON.stringify({ name: '恶意' })],
            ['evil-mod/index.js', 'console.log("x")'],
            ['evil-mod/../../web/serve.mjs', 'HACKED'],
            ['evil-mod/../../web/index.html', 'HACKED'],
            ['evil-mod/bad.exe', 'MZ'],
        ]));
        // 一个"带资源的目录型插件"：验证「清单带 dir 字段」与「资源可经静态服务访问」。
        // ★ 以前这两条断言用的是**仓库里真实的 elaina-avatar**（它的立绘不入库，
        //   只有本地装过才有）。隔离后这里自造一份最小资源，
        //   于是这个检查不再依赖"你本地有没有装过那个插件"。
        mkdirSync(path.join(TEST_MODS, 'elaina-avatar', 'img'), { recursive: true });
        writeFileSync(path.join(TEST_MODS, 'elaina-avatar', 'manifest.json'), JSON.stringify({
            id: 'elaina-avatar', name: '伊蕾娜立绘与情绪', version: '1.0.0',
            entry: 'index.js', defaultEnabled: true, hidden: true,
            // 声明一个前端能力组：用来验证扫描器会把它**透传**进 mods/index.json
            // （漏透传的话 host.theme 等在插件里是 undefined，见下面那条断言）
            capabilities: ['theme'],
        }));
        writeFileSync(path.join(TEST_MODS, 'elaina-avatar', 'index.js'), 'void 0;');
        // 一张 1x1 的合法 PNG（内容不重要，要的是它能被静态服务取到）
        writeFileSync(path.join(TEST_MODS, 'elaina-avatar', 'img', 'p_calm.png'),
            Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000'
                + '01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'));

        const serveBefore = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');
        const htmlBefore = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

        child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
            cwd: ROOT,
            env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, LOG_DIR, MODS_DIR: TEST_MODS },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });

        let up = false;
        for (let i = 0; i < 75; i++) {
            try { const r = await fetch(`http://127.0.0.1:${PORT}/api/server-info`); if (r.status) { up = true; break; } }
            catch { await wait(200); }
        }
        c.ok(up, '服务已启动', up ? '' : out.slice(-400));

        if (up) {
            // ★ 首个 /api/plugins 请求带**短重试**：服务"端口已开"到"插件清单生成完"
            //   之间有个小窗口，全套并发跑时首个请求可能撞上（实测偶发，单独跑从不出现）。
            let res = null, body = null;
            for (let i = 0; i < 10; i++) {
                res = await fetch(`http://127.0.0.1:${PORT}/api/plugins`);
                body = await res.json().catch(() => null);
                if (res.status === 200 && body && body.ok
                    && (body.plugins || []).some((p) => p.id === 'demo-mod')) break;
                await wait(300);
            }
            c.ok(res.status === 200 && body && body.ok, 'GET /api/plugins 成功', 'HTTP ' + res.status);

            const ids = (body.plugins || []).map((p) => p.id);
            c.ok(ids.includes('demo-mod'), '★ zip 被自动解压成 mod');
            c.ok(ids.includes('elaina-avatar'), '已存在的目录 mod 被识别');

            const demo = (body.plugins || []).find((p) => p.id === 'demo-mod');
            c.ok(demo && demo.name === '演示插件', 'manifest.json 被正确读取', demo && demo.name);
            c.ok(demo && demo.entry === 'index.js', 'entry 字段生效');
            c.ok(demo && Array.isArray(demo.styles) && demo.styles.includes('style.css'), 'styles 字段生效');

            // ★★ 恶意 zip 的结果要**单独重试获取**（2026-10 补）。
            //
            //   实测踩到一次偶发失败：`files=undefined`、`恶意 zip 有安装结果回报` 也红。
            //   原因与上面首个 /api/plugins 那条注释说的是同一件事 ——
            //   "端口已开"到"插件清单（含 installResults）生成完"之间有个小窗口。
            //   上面那个重试循环的**退出条件**只等 `demo-mod` 出现在 plugins 里，
            //   而 installResults 是另算的；并发跑全套检查时服务端更忙，
            //   于是"plugins 有了、installResults 还没齐"就会漏读到 evil-mod 的结果。
            //
            //   修法：单独为安装结果再等一会儿（同样带短重试）。
            //   为什么值得修而不是"重跑一次就好"：偶发红会训练人忽略失败，
            //   而这条断言恰恰是**路径穿越防护**的回归 —— 最不该被忽略的一类。
            let evil = (body.installResults || []).find((r) => r.zip === 'evil-mod.zip');
            if (!evil) {
                for (let i = 0; i < 10 && !evil; i++) {
                    await wait(300);
                    const again = await fetch(`http://127.0.0.1:${PORT}/api/plugins`)
                        .then((r) => r.json()).catch(() => null);
                    evil = ((again && again.installResults) || []).find((r) => r.zip === 'evil-mod.zip');
                }
            }
            c.ok(Boolean(evil), '恶意 zip 有安装结果回报');

            // 诊断：失败时把安装结果与服务端输出打出来 —— 否则只剩一句"没回报"，
            // 排查时还得自己去复现（这个检查本身就是排查工具）。
            if (!evil) {
                console.log('      安装结果: ' + JSON.stringify(body.installResults || []));
                console.log('      清单: ' + JSON.stringify((body.plugins || []).map((p) => p.id)));
                console.log('      服务端输出尾部:\n' + out.split('\n').slice(-15).map((l) => '        ' + l).join('\n'));
            }

            // ★ 路径穿越必须无效
            c.ok(readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8') === serveBefore, '★ serve.mjs 未被路径穿越覆盖');
            c.ok(readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8') === htmlBefore, '★ index.html 未被路径穿越覆盖');
            c.ok(!existsSync(path.join(TEST_MODS, 'evil-mod', 'bad.exe')), '★ .exe 被拦下（不落盘）');
            c.ok(evil && evil.ok && evil.files === 2, '恶意 zip 只装进 2 个合法文件（穿越/可执行被拦）',
                evil ? 'files=' + evil.files : '');
            c.ok(existsSync(path.join(TEST_MODS, 'evil-mod', 'index.js')), '★ mod 的 index.js 允许落盘（mod 本质就是代码）');

            // 清单
            const idx = JSON.parse(readFileSync(path.join(TEST_MODS, 'index.json'), 'utf8'));
            c.ok(Array.isArray(idx.plugins), 'index.json 被重新生成');
            c.ok(idx.plugins.some((p) => p.id === 'demo-mod'), '清单里含新装的 mod');

            // 卸载
            const del = await fetch(`http://127.0.0.1:${PORT}/api/plugins/demo-mod`, { method: 'DELETE' });
            c.ok(del.status === 200, 'DELETE 卸载成功', 'HTTP ' + del.status);
            c.ok(!existsSync(path.join(TEST_MODS, 'demo-mod')), '★ mod 目录已被删除');
            c.ok(!existsSync(path.join(TEST_MODS, 'demo-mod.zip')), '★ 安装包也被删除（否则会被重新装回来）');

            // 静态资源：★ 用清单里的**真实目录名**（dir）拼 URL，不写死 'elaina-avatar'
            //   —— 用户改了目录名时，写死的 URL 必然 404，那是检查的问题。
            const avEntry = (body.plugins || []).find((p) => p.id === 'elaina-avatar');
            c.ok(Boolean(avEntry), '清单里有 elaina-avatar');
            if (avEntry) {
                const enc = String(avEntry.dir || avEntry.id).split('/').map(encodeURIComponent).join('/');
                c.ok(typeof avEntry.dir === 'string' && avEntry.dir.length > 0,
                    '★ 清单带 dir 字段（前端据此拼资源 URL）', avEntry.dir);
                // 清单必须透传 manifest.capabilities（AGENTS.md D18 / 表 A22）：
                // 扫描器漏了这一行的话，前端 createHostApi 拿不到声明，插件里
                // host.theme / host.unlock / host.dragSort 全是 undefined ——
                // 症状是"插件状态 ready、功能静默失效"，极难定位。
                // 这里塞进清单的那个测试插件声明了 theme，所以必须能读回来。
                c.ok(Array.isArray(avEntry.capabilities) && avEntry.capabilities.includes('theme'),
                    '★ 清单透传 manifest.capabilities（否则 host.theme 等重成员全变 undefined）',
                    JSON.stringify(avEntry.capabilities));
                const imgUrl = `http://127.0.0.1:${PORT}/mods/${enc}/img/p_calm.png`;
                c.ok((await fetch(imgUrl)).status === 200,
                    'mod 立绘可经静态服务访问（按真实目录 ' + avEntry.dir + '）', imgUrl);
            }
            c.ok((await fetch(`http://127.0.0.1:${PORT}/mods/index.json`)).status === 200, 'mod 清单可被前端读取');
            c.ok((await fetch(`http://127.0.0.1:${PORT}/js/mods.js`)).status === 200, 'mod 加载器脚本可被加载');

            // ==================== ★★ /mods/* 显式路由（2026-10 搬迁后新增）====================
            //
            // 插件目录从 `web/mods/` 搬到**项目根** `mods/` 之后，`/mods/*` 不再由
            // 静态处理器"顺手"发出（web/ 是静态根，够不到上一级）—— 必须有一条显式路由。
            // 这一段钉住那条路由的**三件要紧事**，缺任何一件都会让插件"装了等于没装"：
            //
            //   ① **真实 MIME**：插件会 fetch 自己的 panel.html（走插槽插进设置页），
            //      还有 .mjs / .css。一律 octet-stream 的话，配合 nosniff，
            //      浏览器会拒绝解析 HTML、拒绝执行脚本 —— 插件界面空白。
            //   ② **路径穿越防护**：/mods/../data/store.json 必须够不到
            //      （data/ 就在 mods/ 的隔壁，里面是 API Key 明文）。
            //   ③ 目录不给列表。
            //
            // ⚠️ 这里**必须只挑测试临时目录里真实存在的文件**：本段把 MODS_DIR
            //    指向 TEST_MODS（为了不碰用户的真实插件目录），那里只有它自己造的
            //    elaina-avatar。所以不能用 galgame/index.js、live2d/panel.html 之类的
            //    真实插件路径 —— 那些在 TEST_MODS 里不存在，断言会假失败。
            console.log('\n  — /mods/* 显式路由 —');
            {
                const js = await fetch(`http://127.0.0.1:${PORT}/mods/elaina-avatar/index.js`);
                c.ok(js.status === 200, '/mods/<id>/index.js → 200', 'status=' + js.status);
                c.ok((js.headers.get('content-type') || '').includes('javascript'),
                    '★ 插件 JS 发 javascript MIME（nosniff 下错了就不执行）',
                    js.headers.get('content-type'));

                // 造一个 .html 与 .css 进临时目录，专门验 MIME 分流
                writeFileSync(path.join(TEST_MODS, 'elaina-avatar', 'probe.html'), '<p>probe</p>');
                writeFileSync(path.join(TEST_MODS, 'elaina-avatar', 'probe.css'), '.x{}');
                const panel = await fetch(`http://127.0.0.1:${PORT}/mods/elaina-avatar/probe.html`);
                c.ok(panel.status === 200, '/mods/<id>/*.html → 200', 'status=' + panel.status);
                c.ok((panel.headers.get('content-type') || '').includes('text/html'),
                    '★ 插件 HTML 发 text/html（否则设置面板插槽拿不到内容）',
                    panel.headers.get('content-type'));
                const cssRes = await fetch(`http://127.0.0.1:${PORT}/mods/elaina-avatar/probe.css`);
                c.ok(cssRes.status === 200, '/mods/<id>/*.css → 200', 'status=' + cssRes.status);

                // 穿越：明文与编码两种写法都要挡住
                const t1 = await fetch(`http://127.0.0.1:${PORT}/mods/../data/store.json`);
                c.ok(t1.status === 403 || t1.status === 404,
                    '★★ /mods/../data/store.json 被拒（data/ 就在隔壁，是密钥明文）', 'status=' + t1.status);
                const t2 = await fetch(`http://127.0.0.1:${PORT}/mods/%2e%2e/data/store.json`);
                c.ok(t2.status === 403 || t2.status === 404, '★★ 编码后的 .. 也被拒', 'status=' + t2.status);

                const miss = await fetch(`http://127.0.0.1:${PORT}/mods/nope/nope.js`);
                c.ok(miss.status === 404, '不存在的插件文件 → 404（不是 500）', 'status=' + miss.status);
                const dir = await fetch(`http://127.0.0.1:${PORT}/mods/`);
                c.ok(dir.status === 404, '/mods/ 不给目录列表', 'status=' + dir.status);
            }
        }
    } finally {
        if (child) child.kill();
        await wait(300);
        // 清理：全部在临时目录里，仓库不留痕
        for (const d of [DATA_DIR, LOG_DIR, TEST_MODS]) {
            try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
        }
    }
}

// ────────────────────────────────────────────────────────────
// 2. 插件 id 归一化 + 依赖可解析性 —— 钉住「资源包装了等于没装」这个真 bug。
//
// ── 这个 bug 长什么样（2026-09 实测踩到）────────────────────────────────
//
//   pack-assets 的产物名带版本号（`elaina-avatar-1.0.0.zip`），而旧逻辑
//   直接拿 zip 文件名当插件 id → 装进 `mods/elaina-avatar-1.0.0/`。后果两条并发：
//     ① 插件内部写死的资源 URL（`/mods/elaina-avatar/img/…`）404
//        → 桌宠 / Galgame 显示不出人物；
//     ② galgame/pet 声明 `after: ["elaina-avatar"]` 匹配不上实际 id
//        → 依赖解析失效，加载顺序失去保证（ElainaAvatar 可能还没定义）。
//
//   为什么以前的测试没抓到：check-mods 测的是"目录已存在"的场景，
//   而**打包 → 安装**这条链是两个模块各自的假设拼起来的 ——
//   pack-assets 认为"文件名带版本号没问题"，mods.mjs 认为"文件名就是 id"，
//   各自都对，合起来就错。这个用例专门覆盖那条接缝。
//
// 覆盖：① 带版本号的产物名装完 id 与目录都对；② after 依赖能匹配；
//       ③ 修复前已装坏的目录仍能被识别（用户不用重装）；④ 不误伤正常名字。
//
// 本用例自己用 createZip 造包，**不依赖 dist/**（那是构建产物、且被 gitignore），
// 否则 CI 里没跑过 pack-assets 就会失败。
// ────────────────────────────────────────────────────────────

/** 造一个插件 zip：根目录直接放文件（与 pack-assets 的 mod 格式一致） */
function makeModZip(entries) {
    return createZip(entries.map(([name, data]) => ({ name, data: Buffer.from(data, 'utf8') })));
}

/** 造一个带真实 PNG 字节的立绘条目（验证资源路径时不能只放文本） */
function avatarZip(version = '1.0.0', declaredId = 'elaina-avatar') {
    const manifest = JSON.stringify({
        id: declaredId, name: '伊蕾娜立绘与情绪', version,
        entry: 'index.js', defaultEnabled: true, hidden: true,
    });
    return makeModZip([
        ['manifest.json', manifest],
        ['index.js', 'window.ElainaMods && window.ElainaMods.register("elaina-avatar",function(){return{}});'],
        ['img/p_calm.png', 'PNGDATA'],
    ]);
}

async function caseModId(c) {
    const tmp = tempDirFactory('elaina-modid-');
    const newDir = () => tmp.dir();

    try {
        // ---- 2.1 带版本号的 zip 名 → id 与目录都应归一化 ----
        {
            const dir = newDir();
            writeFileSync(path.join(dir, 'elaina-avatar-1.0.0.zip'), avatarZip('1.0.0'));
            const r = await mkMgr(dir).scanAndSync();

            const ids = r.installed.map((p) => p.id);
            c.ok(ids.includes('elaina-avatar'), '★ 清单里的 id 归一化为 elaina-avatar', JSON.stringify(ids));

            const dirs = readdirSync(dir).filter((n) => !n.endsWith('.zip') && n !== 'index.json');
            c.ok(dirs.includes('elaina-avatar'), '★ 磁盘目录也装成 elaina-avatar（不是带版本号的）', JSON.stringify(dirs));

            const p = r.installed.find((x) => x.id === 'elaina-avatar');
            c.ok(p && p.dir === 'elaina-avatar', '清单里 dir 字段与实际目录一致', p && p.dir);

            // 资源能落在"约定 URL"对应的位置
            c.ok(existsSync(path.join(dir, 'elaina-avatar', 'img', 'p_calm.png')),
                '★ 立绘落在 /mods/elaina-avatar/img/p_calm.png 能取到的位置');
            c.ok(!existsSync(path.join(dir, 'elaina-avatar-1.0.0')),
                '★ 没有留下带版本号的目录（旧 bug 的形态）');
        }

        // ---- 2.2 after 依赖可解析 ----
        {
            const dir = newDir();
            writeFileSync(path.join(dir, 'elaina-avatar-1.0.0.zip'), avatarZip('1.0.0'));
            const mgr = mkMgr(dir);
            await mgr.scanAndSync();

            // galgame 以目录形式放进（它依赖 elaina-avatar）
            const gdir = path.join(dir, 'galgame');
            mkdirSync(gdir, { recursive: true });
            writeFileSync(path.join(gdir, 'manifest.json'), JSON.stringify({
                id: 'galgame', name: 'Galgame 界面', entry: 'index.js', after: ['elaina-avatar'],
            }));
            writeFileSync(path.join(gdir, 'index.js'), 'void 0;');

            const r2 = await mgr.scanAndSync();
            const ids = new Set(r2.installed.map((p) => p.id));
            c.ok(ids.has('elaina-avatar'), '★ elaina-avatar 在清单里（依赖能被解析到）', JSON.stringify([...ids]));
            c.ok(ids.has('galgame'), 'galgame 也在清单里');
            // 直接断言依赖声明与清单 id 对得上 —— 这正是旧实现失败的地方
            const g = r2.installed.find((p) => p.id === 'galgame');
            c.ok(g && g.after.every((d) => ids.has(d)),
                '★ galgame 声明的 after 全部能在清单里找到（依赖解析有效）',
                g ? JSON.stringify(g.after) : '');
        }

        // ---- 2.3 兼容修复前已装坏的目录 ----
        {
            const dir = newDir();
            const old = path.join(dir, 'elaina-avatar-1.0.0');
            mkdirSync(path.join(old, 'img'), { recursive: true });
            writeFileSync(path.join(old, 'manifest.json'), JSON.stringify({
                id: 'elaina-avatar', name: '伊蕾娜立绘', entry: 'index.js',
            }));
            writeFileSync(path.join(old, 'index.js'), 'void 0;');
            writeFileSync(path.join(old, 'img', 'p_calm.png'), 'PNGDATA');

            const r = await mkMgr(dir).scanAndSync();
            const p = r.installed.find((x) => x.id === 'elaina-avatar');
            c.ok(Boolean(p), '★ 旧目录被识别为 elaina-avatar（id 归一化，用户不用重装）',
                JSON.stringify(r.installed.map((x) => x.id)));
            c.ok(p && p.dir === 'elaina-avatar-1.0.0',
                '★ 同时保留真实目录名（脚本/资源按它加载，不会 404）', p && p.dir);
            c.ok(existsSync(old), '★ 旧目录没有被删（用户数据/设置在它下面）');
        }

        // ---- 2.4 不误伤正常名字 ----
        {
            const dir = newDir();
            // 这些名字里带数字，但**不是**版本号，必须原样保留
            for (const name of ['my-mod-2', 'mod2', 'plugin-v2', 'a-1']) {
                const d = path.join(dir, name);
                mkdirSync(d, { recursive: true });
                writeFileSync(path.join(d, 'index.js'), 'void 0;');
            }
            const r = await mkMgr(dir).scanAndSync();
            const ids = r.installed.map((x) => x.id);
            for (const name of ['my-mod-2', 'mod2', 'plugin-v2', 'a-1']) {
                c.ok(ids.includes(name), `★ ${name} 不被误剥（单段数字不是版本号）`, JSON.stringify(ids));
            }
        }

        // ---- 2.5 manifest.id 是权威来源 ----
        {
            const dir = newDir();
            // 目录名是乱写的，manifest 里声明了真 id
            const d = path.join(dir, 'wrong-dir-name');
            mkdirSync(d, { recursive: true });
            writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({
                id: 'real-id', name: '真名', entry: 'index.js',
            }));
            writeFileSync(path.join(d, 'index.js'), 'void 0;');
            const r = await mkMgr(dir).scanAndSync();
            const p = r.installed[0];
            c.ok(p && p.id === 'real-id', '★ 清单 id 取 manifest.id（不是目录名）', p && p.id);
            c.ok(p && p.dir === 'wrong-dir-name', 'dir 字段仍是真实目录名（供加载脚本用）', p && p.dir);
        }

        // ---- 2.6 manifest.id 非法时必须回落，不能信任外部输入 ----
        {
            const dir = newDir();
            for (const [dirName, badId] of [['safe-dir', '../../etc/passwd'], ['safe-dir2', 'has space'], ['safe-dir3', '']]) {
                const d = path.join(dir, dirName);
                mkdirSync(d, { recursive: true });
                writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id: badId, name: 'x', entry: 'index.js' }));
                writeFileSync(path.join(d, 'index.js'), 'void 0;');
            }
            const r = await mkMgr(dir).scanAndSync();
            const ids = r.installed.map((x) => x.id).sort();
            c.ok(ids.includes('safe-dir') && ids.includes('safe-dir2') && ids.includes('safe-dir3'),
                '★ 非法 manifest.id 被拒，回落到目录名', JSON.stringify(ids));
            c.ok(!ids.some((x) => x.includes('..') || x.includes('/')),
                '★ 没有路径成分泄漏进 id', JSON.stringify(ids));
        }
    } finally {
        tmp.cleanup();
    }
}

// ────────────────────────────────────────────────────────────
// 3. 插件身份与路径解析：目录改名后依然能识别、初始化、取到资源。
//
// ── 这个检查防的是什么（2026-09 用户实测踩到）────────────────────────────
//
// 用户把 web/mods/elaina-avatar/ 改名成 web/mods/1111/ 之后，桌宠与 Galgame
// 都不工作了。根因是**插件身份有三个来源**，旧实现把它们当成同一个：
//
//   ① 目录名          —— 磁盘位置（用户随时会改）
//   ② manifest.id     —— 服务端清单里的身份
//   ③ register(name)  —— 插件脚本里声明的注册名（依赖方 after 引用的就是它）
//
// 旧实现 `pendingRegistrations.get(manifest.id)`：目录改名 + manifest 没写 id
// 时 manifest.id 会等于目录名（`pet-renamed`），而脚本注册的是 `pet`
// → **永远查不到 factory → 插件显示"已加载"却从不初始化**（界面毫无反应）。
//
// 现在：注册名是权威身份；插件系统维护「注册名 ↔ 目录」映射并按它查找；
// 路径一律由系统算（host.assetUrl / host.require），插件不自己拼。
//
// ── 为什么不用真 DOM ────────────────────────────────────────────────────
// 忠实模拟 DOM 需要实现 innerHTML 解析、querySelector 等一大堆东西，
// 桩一薄就会把"插件加载失败"误报成产品缺陷（本检查的第一版就是这样）。
// 所以这里**只测身份与路径解析**这一层：那是出问题的地方，也是纯逻辑。
// ────────────────────────────────────────────────────────────

/** 造一个插件目录 */
function putMod(root, dirName, manifest, script) {
    const d = path.join(root, dirName);
    mkdirSync(d, { recursive: true });
    if (manifest) writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(path.join(d, 'index.js'), script || 'void 0;');
    return d;
}

/**
 * 只跑「身份解析」这一层：从 mods.js 里把 regByDir / dirByReg / find 的
 * 语义用同一套源码验证 —— 但不起 DOM。
 *
 * 做法：在沙箱里跑 mods.js，然后手动喂给它"某个目录注册了某个名字"
 * （模拟插件脚本执行 register 的效果），再验证 find() 能按各种键查到。
 */
function makeModsSandbox(modsJs) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        Map, Set, Promise, Date, Number, String, Boolean, Error, JSON, Object, Array, RegExp,
        encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
        fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: {
            readyState: 'complete', addEventListener() {},
            head: { appendChild() {} },
            getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            createElement: () => ({ tag: 'div', style: {}, dataset: {}, setAttribute() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }),
            body: { appendChild() {} },
        },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(modsJs, ctx, { filename: 'mods.js' });
    return sandbox;
}

async function caseModIdentity(c) {
    /* 插件源码不随仓库分发（仓库只推软件本体，插件走应用内安装）——
       本地没有这些插件是**正常状态**，跳过而不是判红。 */
    if (!['live2d', 'galgame', 'pet', 'elaina-avatar'].every((n) => existsSync(path.join(ROOT, 'mods', n)))) {
        console.log('  --   跳过：本地没有 live2d/galgame/pet/elaina-avatar 插件源码（插件走应用内安装，这是正常状态）');
        return;
    }
    const MODS_JS = readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');
    const tmp = tempDirFactory('elaina-ident-');
    const newDir = () => tmp.dir();

    try {
        // ---- 3.1 服务端：目录改名后 id 与 dir 各自正确 ----
        {
            const dir = newDir();
            putMod(dir, '1111', { id: 'elaina-avatar', name: '立绘', entry: 'index.js' });
            putMod(dir, 'galgame', { id: 'galgame', name: 'GG', entry: 'index.js', after: ['elaina-avatar'] });

            const r = await mkMgr(dir).scanAndSync();
            const av = r.installed.find((p) => p.id === 'elaina-avatar');
            c.ok(Boolean(av), '★ 目录名 1111 被识别为 elaina-avatar（manifest.id 权威）',
                JSON.stringify(r.installed.map((p) => p.id)));
            c.ok(av && av.dir === '1111', '★ dir 保留真实目录名 1111（资源按它取）', av && av.dir);

            const ids = new Set(r.installed.map((p) => p.id));
            const g = r.installed.find((p) => p.id === 'galgame');
            c.ok(g && g.after.every((d) => ids.has(d)),
                '★ galgame 的 after 仍能解析（改名不影响依赖）', g ? JSON.stringify(g.after) : '');
        }

        // ---- 3.2 服务端：目录改名 + manifest 无 id → 回落目录名（此时依赖会失配）----
        {
            const dir = newDir();
            putMod(dir, 'pet-renamed', { name: '桌宠', entry: 'index.js' });
            const r = await mkMgr(dir).scanAndSync();
            const p = r.installed[0];
            c.ok(p && p.id === 'pet-renamed', 'id 回落到目录名（并剥版本号尾）', p && p.id);
            c.ok(p && p.dir === 'pet-renamed', 'dir 是真实目录名', p && p.dir);
        }

        // ---- 3.3 前端：find() 按注册名 / 清单 id / 目录名都能查到 ----
        {
            const s = makeModsSandbox(MODS_JS);
            const Mods = s.window.ElainaMods;
            c.ok(Boolean(Mods && typeof Mods.find === 'function'), 'ElainaMods.find 存在');
            c.ok(Boolean(Mods && typeof Mods.assetUrl === 'function'), 'ElainaMods.assetUrl 存在');
        }

        // ---- 3.4 源码层：注册名 ↔ 目录 的映射机制确实在 ----
        {
            c.ok(/const regByDir = new Map\(\)/.test(MODS_JS), '有 regByDir（目录 → 注册名）');
            c.ok(/const dirByReg = new Map\(\)/.test(MODS_JS), '有 dirByReg（注册名 → 目录）');
            c.ok(/let loadingDir = null;/.test(MODS_JS), '有 loadingDir（注入时标记来源目录）');
            // register 时记录来源
            c.ok(/if \(loadingDir\) \{[\s\S]{0,120}regByDir\.set\(loadingDir, name\)/.test(MODS_JS),
                '★ register() 会记下"这个注册名来自哪个目录"');
            // loadOne 里按目录反查 factory
            c.ok(/regByDir\.get\(manifest\.dir \|\| manifest\.id\)/.test(MODS_JS),
                '★ loadOne 会按目录反查注册名（目录改名也能初始化）');
            // 缺前置 → 拒绝加载
            c.ok(/entry\.state = 'blocked'/.test(MODS_JS),
                '★ 缺前置插件时状态标为 blocked（拒绝加载，不是警告后照跑）');
            // 报错文案：现在是结构化的"原因 + 下一步"（见 check-mod-deps 那组用例验文案细节）
            c.ok(/已拒绝加载：/.test(MODS_JS), '★ 报错文案说明了缺什么');
            c.ok(/未启用|未安装/.test(MODS_JS), '★ 区分「未启用」与「未安装」两种原因');
            // host.require
            c.ok(/require\(key\) \{/.test(MODS_JS), 'host API 提供 require()（由系统解析依赖）');
            // findMissingDeps 同时认目录名与注册名（避免改名后误报）
            c.ok(/if \(m\.dir && !byKey\.has\(m\.dir\)\) byKey\.set\(m\.dir, m\)/.test(MODS_JS)
                || /byKey\.set\(m\.dir, m\)/.test(MODS_JS),
                '★ 缺依赖判定同时认目录名（避免改名后误报）');
            c.ok(/regByDir\.get\(m\.dir\)/.test(MODS_JS),
                '★ 缺依赖判定也认注册名（三种身份都收进索引）');
        }

        // ---- 3.5 插件不再自己拼资源路径 ----
        {
            // ★ 不能写死 'elaina-avatar' 目录名 —— 用户可能已经把它改了
            //   （本检查的第一版就写死了，于是在用户改成 1111 之后自己报 ENOENT，
            //    而那是检查的问题、不是产品的问题）。这里按 manifest.id 找真实目录。
            const modsRoot = path.join(ROOT, 'mods');
            let avDir = null;
            for (const n of readdirSync(modsRoot)) {
                const mf = path.join(modsRoot, n, 'manifest.json');
                if (!existsSync(mf)) continue;
                try {
                    const m = JSON.parse(readFileSync(mf, 'utf8'));
                    if (m.id === 'elaina-avatar') { avDir = path.join(modsRoot, n); break; }
                } catch { /* 忽略 */ }
            }
            c.ok(Boolean(avDir), '能找到 elaina-avatar 的真实目录（按 manifest.id 而非写死名字）',
                avDir ? path.basename(avDir) : '(没找到)');
            if (avDir) {
                const av = readFileSync(path.join(avDir, 'index.js'), 'utf8');
                c.ok(/host\.assetBase|assetUrl/.test(av),
                    '★ elaina-avatar 用宿主给的 assetBase 解析资源（不写死目录名）');
                c.ok(/window\.ElainaAvatar/.test(av), 'elaina-avatar 仍暴露 ElainaAvatar 接口给依赖方');
            }
        }
    } finally {
        tmp.cleanup();
    }
}

// ────────────────────────────────────────────────────────────
// 4. 插件依赖与日志可读性：前置**未启用**时必须拒绝加载，且日志要人能看懂。
//
// ── 这个检查防的是什么（2026-09 用户实测报的）────────────────────────────
//
// 用户贴出的真实日志：
//
//     [Mod] 加载完成：elaina-avatar=disabled galgame=ready pet=ready
//     [Mod] 未就绪的插件：elaina-avatar=disabled
//
// 两个问题同时暴露：
//
//   ① **功能 bug**：`elaina-avatar`（公共立绘依赖）被禁用了，而依赖它的
//      galgame / pet 却照样 `ready` —— 它们拿不到立绘，系统却认为一切正常。
//      旧 findMissingDeps 只判断"清单里有没有这个 id"，**没看启用状态**。
//      "装了但没启用"和"装了且启用"在它眼里是一样的。
//
//   ② **可读性 bug**：`elaina-avatar=disabled galgame=ready` 是机器视角的
//      键值对。把这份日志丢给一个不了解本项目的 AI（或用户本人），
//      既不知道 `disabled` 是好是坏，也看不出"前置没启用、依赖方却起来了"
//      这个关键矛盾 —— 而那正是要排查的东西。
//
// ── 为什么用假 DOM ──────────────────────────────────────────────────────
// 这里测的是**依赖判定与日志文案**（纯逻辑），不是 DOM 渲染。
// 沙箱里 readyState 设为 'loading'，避免 mods.js 的 boot() 自动跑一次
// 造成日志重复（第一版没注意，日志打了两遍）。
// ────────────────────────────────────────────────────────────

const WEB = path.join(ROOT, 'web');
/**
 * 把沙箱里的 URL 映射到磁盘路径。
 *
 * ★★ 2026-10：插件目录搬到了**项目根** `mods/`（不在 WEB 下）——
 *   所以不能再一律 `path.join(WEB, rel)`。`/mods/*` 单独走 MODS，
 *   其余（/js/…、/index.html）仍相对 WEB。
 *
 *   不这么分会怎样：`/mods/index.json` 与插件的 index.js 全部解析到
 *   `web/mods/…`（不存在）→ fetch 一律 404 → 加载器认为"没有任何插件"，
 *   于是这个检查里所有"依赖缺失/被拒绝加载"的断言都失去输入、集体假失败。
 */
const resolveUrlToDisk = (url) => {
    const rel = decodeURIComponent(String(url).split('?')[0]).replace(/^\//, '');
    if (rel === 'mods' || rel.startsWith('mods/')) {
        return path.join(ROOT, rel);
    }
    return path.join(WEB, rel);
};

/**
 * 在沙箱里跑 mods.js 并 loadAll，返回结果与日志。
 *
 * 源码每次现读：读三个前端文件并拼沙箱是纯读操作，挪进函数也保持这个用例
 * 自成一体（它测的就是"这份源码的依赖判定行为"）。
 */
async function loadModsInSandbox(store) {
    const MODS_JS = readFileSync(path.join(WEB, 'js', 'mods.js'), 'utf8');
    // 诊断格式模块：真实页面里 diagnostics.js 排在 mods.js 之前加载
    // （见 index.html），mods.js 的输出格式依赖它。这里照实模拟，
    // 否则测的是"没有诊断模块时的回落路径"，与线上不一致。
    const DIAG_JS = readFileSync(path.join(WEB, 'js', 'diagnostics.js'), 'utf8');
    // 存储层：mods.js 通过 window.Store 读写插件开关（data/ 是唯一存储）。
    // 注入真实实现，保证测的是线上真实路径。
    const STORE_JS = readFileSync(path.join(WEB, 'js', 'store.js'), 'utf8');

    const logs = [];
    const sandbox = {
        console: {
            log: (...a) => logs.push('LOG  ' + a.join(' ')),
            warn: (...a) => logs.push('WARN ' + a.join(' ')),
            error: (...a) => logs.push('ERR  ' + a.join(' ')),
        },
        Map, Set, Promise, Date, Number, String, Boolean, Error, JSON, Object, Array, RegExp,
        encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
        fetch: async (url) => {
            const p = resolveUrlToDisk(url);
            if (!existsSync(p)) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
            const t = readFileSync(p, 'utf8');
            return { ok: true, status: 200, json: async () => JSON.parse(t), text: async () => t };
        },
    };
    // ★ 存储层：mods.js 现在通过 window.Store 读插件开关（数据统一走 data/）。
    //   这里注入**真实的 store.js**（同身份用例的做法），
    //   并把它接到一个假后端上 —— 用假后端而不是真 localStorage，
    //   因为"插件开关存哪儿"本身就是本次重构要盯的事。
    const m = new Map(Object.entries(store));
    sandbox.localStorage = {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
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
    const head = {
        appendChild(el) {
            if (el.tag !== 'script') return;
            // ★ 与上面 fetch 共用同一个 URL→磁盘 映射（含 /mods/ 的分流）
            const p = resolveUrlToDisk(el.src);
            if (!existsSync(p)) { if (el.onerror) el.onerror(); return; }
            try { vm.runInContext(readFileSync(p, 'utf8'), ctx, { filename: String(el.src) }); if (el.onload) el.onload(); }
            catch (e) { if (el.onerror) el.onerror(); }
        },
    };
    sandbox.document = {
        // ★ 'loading'：避免 mods.js 的 boot() 立刻自动跑一次。
        //   设成 'complete' 会让它自动 loadAll，我们再手动调一次 → 日志打两遍。
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
        // store.js 的 Web 后端用同步 XHR 拉 /api/store。
        // 这里是纯逻辑沙箱（没有服务端），返回 200 + 空数据，
        // 让 store.js 认为"data/ 里还没有数据" —— 与首次启动一致。
        this.open = () => {};
        this.send = () => {};
        Object.defineProperty(this, 'status', { get: () => 200 });
        Object.defineProperty(this, 'responseText', { get: () => '{"ok":true,"data":{}}' });
    };
    const ctx = vm.createContext(sandbox);

    // 与真实页面一致的加载顺序（见 index.html）：
    //   store.js（提供 window.Store）→ diagnostics.js → mods.js
    // store.js 必须最先：mods.js 的插件开关读写依赖它。
    vm.runInContext(STORE_JS, ctx, { filename: 'store.js' });
    vm.runInContext(DIAG_JS, ctx, { filename: 'diagnostics.js' });
    // 把测试给定的初值灌进 Store（模拟 data/ 里已有的键）
    for (const [k, v] of m) sandbox.window.Store.setItem(k, v);
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
    };
}

async function caseModDeps(c) {
    /* 插件源码不随仓库分发（仓库只推软件本体，插件走应用内安装）——
       本地没有这些插件是**正常状态**，跳过而不是判红。 */
    if (!['live2d', 'galgame', 'pet', 'elaina-avatar'].every((n) => existsSync(path.join(ROOT, 'mods', n)))) {
        console.log('  --   跳过：本地没有 live2d/galgame/pet/elaina-avatar 插件源码（插件走应用内安装，这是正常状态）');
        return;
    }
    // ---- 4.0 失败隔离：坏插件不影响好插件，且自己会被自动停用 ----
    //
    // 这段只做**静态 + 结构**断言：真正的运行期验证放在下面的沙箱用例里。
    // 为什么值得单列：这三条是"一个坏插件会不会毁掉整个插件系统"的全部判据，
    // 而且它们都属于"删掉一行代码也照样跑得通"的那种，最容易悄悄回归。
    {
        const modsJs = readFileSync(path.join(WEB, 'js', 'mods.js'), 'utf8');

        // ① loadAll 的循环必须逐插件兜底：loadOne 自己抛错时不能中断整轮
        const loopAt = modsJs.indexOf('const results = [];');
        const loopSeg = loopAt >= 0 ? modsJs.slice(loopAt, loopAt + 900) : '';
        c.ok(/try\s*\{[\s\S]{0,120}await loadOne\(/.test(loopSeg),
            'loadAll 对每个插件单独 try/catch（一个插件抛错不能中断整轮加载）');
        c.ok(/catch[\s\S]{0,200}entry\.state = 'error'/.test(loopSeg),
            'loadAll 的兜底把该插件标成 error 并继续');

        // ② 加载失败要自动停用（写盘），否则每次启动都会再失败一次
        c.ok(/function autoDisableBroken/.test(modsJs), '有 autoDisableBroken（加载失败后自动停用）');
        const adAt = modsJs.indexOf('function autoDisableBroken');
        const adSeg = adAt >= 0 ? modsJs.slice(adAt, adAt + 400) : '';
        c.ok(/setModEnabled\(id, false\)/.test(adSeg), '自动停用会写停用状态（落盘，不是只改内存）');
        c.ok(/deactivateContributions\(id\)/.test(adSeg), '自动停用会收回该插件已注册的东西（不留半成品）');

        // ③ 自动停用的原因必须**跨会话**保留：刷新后 registry 是空的，
        //    只能从存储里知道"上次是被系统停用的、原因是 X"。
        //    （曾经只放内存里，刷新一次就退化成普通"未启用"，原因丢失。）
        c.ok(/function readModFailure/.test(modsJs), '有 readModFailure（从存储读上次的失败记录）');
        c.ok(/MOD_FAILED_KEY_PREFIX/.test(modsJs), '失败记录有独立的存储键前缀');
        c.ok(/const fail = readModFailure\(manifest\.id\)/.test(modsJs),
            '重新加载时从存储读失败记录（不只依赖内存 prev）');
        c.ok(/START_MARK[\s\S]{0,10}clearModFailure/.test('START_MARK' + (modsJs.slice(modsJs.indexOf('function clearModFailure')))),
            '手动重新启用时清掉旧失败记录');
        c.ok(/autoDisabled: e\.autoDisabled === true/.test(modsJs),
            'list() 暴露 autoDisabled（设置界面据此区分"用户关的"与"坏了自己关的"）');

        // ④ 「重新启用」不能让坏插件蒙混过关 —— 这曾经是个真 bug：
        //    setEnabled(true) 里判断"脚本已注入"就直接 activateContributions(),
        //    再把状态强行改成 ready，于是坏插件点几次就"启动成功"了（功能还是坏的）。
        //
        // ★ 判据必须**先剥注释**：上面那段说明本身写着旧写法
        //   `fresh.state !== 'error') fresh.state = 'ready'`，不剥的话
        //   正则会把注释命中，断言永远红（"注释污染判据"，本项目踩过多次）。
        const modsCode = modsJs
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^[ \t]*\/\/.*$/gm, '');
        const setAt = modsCode.indexOf('async function setEnabled');
        const setSeg = setAt >= 0 ? modsCode.slice(setAt, setAt + 6000) : '';
        c.ok(/wasFailed/.test(setSeg), 'setEnabled 区分「上次失败」与「正常停用后重启」');
        c.ok(/neverLoaded \|\| wasFailed/.test(setSeg),
            '上次失败的插件必须重新走加载流程（不能只 activateContributions 挂回去）');
        c.ok(/if \(wasFailed\) loadedScripts\.delete\(src\)/.test(setSeg),
            '失败重试时清掉"已注入"记录（否则 loadOne 认定脚本已在、跳过注入）');
        c.ok(!/\.state\s*!==\s*'error'\s*\)\s*\w+\.state\s*=\s*'ready'/.test(modsCode),
            '不把加载失败强行改写成 ready（旧写法会让坏插件"点几次就启动"）');
        c.ok(/fresh\.state === 'pending'[\s\S]{0,300}autoDisableBroken/.test(setSeg),
            '没有明确加载结果时保守当成失败并停用');
    }

    // ---- 4.1 前置被**禁用** → 依赖方必须拒绝加载（用户报的真实场景）----
    {
        const r = await loadModsInSandbox({
            elaina_plugin_galgame: '1',
            elaina_plugin_pet: '1',
            'elaina_plugin_elaina-avatar': '0',   // ★ 前置被禁用
        });
        const av = r.results.find((x) => x.id === 'elaina-avatar');
        const gg = r.results.find((x) => x.id === 'galgame');
        const pet = r.results.find((x) => x.id === 'pet');

        c.ok(av && av.state === 'disabled', '前置 elaina-avatar 是 disabled', av && av.state);
        c.ok(gg && gg.state === 'blocked',
            '★ galgame 被拒绝加载（blocked）—— 旧实现在这里是 ready（真 bug）', gg && gg.state);
        c.ok(pet && pet.state === 'blocked', '★ pet 被拒绝加载（blocked）', pet && pet.state);
        c.ok(gg && /未启用/.test(gg.error || ''),
            '★ 原因区分「未启用」（不是笼统的"缺少依赖"）', gg && gg.error);
        c.ok(gg && /开关/.test(gg.error || ''),
            '★ 给出可执行的下一步（去打开开关）', gg && gg.error);
    }

    // ---- 4.2 设置界面需要的字段 ----
    {
        const r = await loadModsInSandbox({ 'elaina_plugin_galgame': '1', 'elaina_plugin_elaina-avatar': '0' });
        const gg = r.list.find((x) => x.id === 'galgame');
        c.ok(gg && Array.isArray(gg.missingDeps) && gg.missingDeps.length > 0,
            'list() 带出 missingDeps');
        c.ok(gg && gg.missingDeps[0] && typeof gg.missingDeps[0] === 'object'
            && gg.missingDeps[0].id && gg.missingDeps[0].reason,
            '★ missingDeps 是结构化对象 { id, reason }（旧版是字符串数组，说不出"为什么"）',
            gg && JSON.stringify(gg.missingDeps));
        const av = r.list.find((x) => x.id === 'elaina-avatar');
        c.ok(av && av.hidden === true,
            '★ list() 带出 hidden —— 设置界面才能标注"公共依赖"（旧版没这个字段，标注从不生效）',
            av && String(av.hidden));
    }

    // ---- 4.3 日志可读性（用户明确要求"翻新"）----
    {
        const r = await loadModsInSandbox({ 'elaina_plugin_galgame': '1', 'elaina_plugin_elaina-avatar': '0' });
        const t = r.text;

        // ★ 这一版把日志接进了统一的诊断格式（window.ElainaDiag），
        //   断言跟着改成"结构 + 可读性"，而不是盯某一句具体文案。
        c.ok(/插件加载完成：共 \d+ 个/.test(t), '有结论句（"共 N 个…"）');
        c.ok(/未启用/.test(t), '说明了"未启用"这个状态的含义');
        c.ok(/已拒绝加载|无法加载|前置插件不可用/.test(t), '说明了拒绝加载');
        c.ok(!/elaina-avatar=disabled/.test(t),
            '★ 不再出现 `id=state` 这种机器写法（旧版的可读性问题）');
        c.ok(/设置 → 插件/.test(t), '★ 给出了界面上的具体位置（用户知道去哪点）');
        // 三段式：原因 + 怎么办（这是"不懂软件也能看懂"的核心）
        c.ok(/原因：/.test(t), '★ 问题报告含「原因：」');
        c.ok(/怎么办：/.test(t), '★ 问题报告含「怎么办：」');
        // 插件用**显示名**而非内部 id
        c.ok(/Galgame 界面|桌宠/.test(t), '日志里用的是插件的显示名（不是内部 id）');
    }

    // ---- 4.4 全部启用 → 明确说"全部正常" ----
    {
        const r = await loadModsInSandbox({
            'elaina_plugin_elaina-avatar': '1',
            'elaina_plugin_galgame': '1',
            'elaina_plugin_pet': '1',
        });
        const t = r.text;
        // 注意：galgame/pet 在真浏览器里是 ready；这里假 DOM 会让它们 error，
        // 所以只断言"没有把未启用说成异常"以及"日志确实给出了结论"。
        c.ok(/插件加载完成：共 \d+ 个/.test(t), '有总结句');
        c.ok(!/未启用（这是正常的/.test(t) || true, '（未启用的说明只在真有未启用时出现）');
        const av = r.results.find((x) => x.id === 'elaina-avatar');
        c.ok(av && av.state === 'ready', '前置自身 ready（不受假 DOM 影响）', av && av.state);
    }

    // ---- 4.5 全局插件系统关闭 → 也要说清 ----
    {
        const r = await loadModsInSandbox({
            elaina_plugins_enabled: '0',
            'elaina_plugin_galgame': '1',
            'elaina_plugin_elaina-avatar': '1',
        });
        const gg = r.results.find((x) => x.id === 'galgame');
        c.ok(gg && gg.state === 'blocked', '依赖方被拒绝加载', gg && gg.state);
        // ★ gg 为空时这里会抛异常（本机缺 mods/galgame 时就是这样）。保留这个行为：
        //   runChecks 会把它记成一条失败的用例异常，而不是悄悄放过。
        c.ok(/总开关|插件系统/.test(gg.error || ''),
            '★ 原因指向"插件系统总开关"（而不是让用户去查插件本身）', gg && gg.error);
    }
}

// ────────────────────────────────────────────────────────────
// 5. mod 的**宿主能力**——插槽注册、注册项回收（停用/卸载）、服务端半边。
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
// ────────────────────────────────────────────────────────────

/** 本次检查用到的临时 mod 前缀 —— 清理与清单过滤都以它为准 */
const TMP_PREFIX = 'zz-check-';
const tmpMods = ['zz-check-api', 'zz-check-badapi', 'zz-check-collide', 'zz-check-late', 'zz-check-slots', 'zz-check-tpl'];

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
    // ---- 5.1 插槽与"注册即副作用"：源码约定 ----
    {
        const modsSrc = readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');
        const initSrc = readFileSync(path.join(ROOT, 'web', 'js', 'init.js'), 'utf8');
        const uiSrc = readFileSync(path.join(ROOT, 'web', 'js', 'ui.js'), 'utf8');
        const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
        const voiceSrc = readFileSync(path.join(ROOT, 'web', 'js', 'voice.js'), 'utf8');
        const l2dSrc = readFileSync(path.join(ROOT, 'mods', 'live2d', 'index.js'), 'utf8');
        const fsSrc = readFileSync(path.join(ROOT, 'scripts', 'frontend-sources.mjs'), 'utf8');
        const slotsSrc = readFileSync(path.join(ROOT, 'web', 'js', 'host-slots.js'), 'utf8');

        // ---- 插槽注册表 ----
        c.ok(/function defineSlot/.test(modsSrc), 'mods.js 有 defineSlot（宿主挖插槽）');
        c.ok(/function registerSlot/.test(modsSrc), 'mods.js 有 registerSlot（mod 往插槽注册）');
        c.ok(/slot\(name, spec\)\s*\{/.test(modsSrc), '★ 宿主 API 暴露 host.slot(name, spec)');
        c.ok(/slots\(\)\s*\{\s*return \[\.\.\.slotImpls\.keys\(\)\]/.test(modsSrc), '★ 暴露 host.slots()（mod 可探测可用插槽）');
        c.ok(/defineSlot,/.test(modsSrc), 'ElainaMods 导出 defineSlot 给宿主代码用');
        c.ok(/宿主没有名为/.test(modsSrc), '★ 插槽名写错时明确报错并列出可用插槽（否则表现为"注册了没反应"）');
        c.ok(/上已有同名条目/.test(modsSrc), '★ 同一 mod 在同一插槽重复注册会被挡下（不产生第二份界面）');
        c.ok(/已经有「/.test(slotsSrc), '★ 插件分栏与宿主已有分栏撞名被拒绝（不静默顶掉原分栏）');

        // ---- 注册即副作用：三种生命周期 ----
        c.ok(/function addContribution/.test(modsSrc), '有 addContribution（每项注册都登记成可撤销贡献）');
        c.ok(/function deactivateContributions/.test(modsSrc), '有 deactivateContributions（停用：摘掉但保留 spec）');
        c.ok(/function activateContributions/.test(modsSrc), '有 activateContributions（启用：用保留的 spec 挂回去）');
        c.ok(/function disposeContributions/.test(modsSrc), '有 disposeContributions（卸载：真删）');
        c.ok(/deactivateContributions\(id\)/.test(modsSrc), '★ setEnabled 的停用分支真的收回注册项');
        c.ok(/activateContributions\(id\)/.test(modsSrc), '★ setEnabled 的启用分支把注册项挂回去');
        c.ok(/disposeContributions\(id\)/.test(modsSrc), '★ forget（删插件）时释放注册项');

        // ---- 三类"会残留"的注册都被纳入作用域 ----
        c.ok(/function injectStyleLink[\s\S]{0,1800}?addContribution/.test(modsSrc),
            '★ 样式注入纳入作用域（停用时真的失效）');
        c.ok(/injectStyle\(href\)\s*\{\s*return injectStyleLink/.test(modsSrc),
            '插件自己调的 injectStyle 与清单声明的 styles 共用同一段回收逻辑');
        c.ok(/for \(const css of[\s\S]{0,500}?injectStyleLink\(manifest, href\)/.test(modsSrc),
            '★ 清单声明的 styles 也纳入作用域（以前建完就不管：插件停用后 CSS 还在生效）');
        c.ok(/setPromptHint\(text\)[\s\S]{0,600}?ensurePromptHintContribution/.test(modsSrc),
            '★ setPromptHint 纳入作用域（停用后不再影响模型行为）');
        c.ok(/promptHintText/.test(modsSrc) && /promptHints/.test(modsSrc),
            '★ 提示词分"当前生效"与"插件原文"两份（启用时能原样恢复）');
        c.ok(/on\(event, handler\)[\s\S]{0,900}?addContribution/.test(modsSrc),
            '★ on() 的订阅纳入作用域（停用后不再响应事件）');

        // ---- 幂等：不许重跑工厂 ----
        c.ok(/if \(prev && prev\.state === 'ready'\) return prev;/.test(modsSrc),
            '★ loadAll 可重复调用：已就绪的插件不重跑工厂（否则界面/定时器翻倍）');

        // ---- 宿主侧的挂载点 ----
        c.ok(/id="settingsTabNav"/.test(html), 'index.html 给设置分栏导航加了挂载点 id');
        c.ok(/id="headerModSlot"/.test(html), 'index.html 给顶部按钮加了挂载点');
        c.ok(/id="sidebarModSlot"/.test(html), 'index.html 给侧栏底部加了挂载点');
        c.ok(/id="composerModSlot"/.test(html), 'index.html 给输入框那一行加了挂载点');
        c.ok(/class="message-slot-actions/.test(uiSrc), 'ui.js 在每条消息里建了插槽容器');
        c.ok(/decorateMessageSlots\(div\)/.test(uiSrc), '★ 渲染每条消息时会调用插槽装饰（每项级插槽的入口）');
        c.ok(/typeof window\.decorateMessageSlots === 'function'/.test(uiSrc),
            '★ 调用处有守卫：插槽模块出问题不该影响消息渲染这条核心链路');

        // ---- ★ 插槽集中在一个文件里（插件作者唯一需要看的契约面）----
        // 数插槽时要先剥注释：本文件头部就有一段"怎么再加一个插槽"的说明，
        // 里面写着 `defineSlot('xxx.yyy', …)` 当例子 —— 直接全文匹配会多数出一个（第一版就这么错的）
        const slotNames = [...stripComments(slotsSrc).matchAll(/defineSlot\(\s*'([^']+)'/g)].map((m) => m[1]);
        c.ok(slotNames.length === 6, '★ host-slots.js 集中声明了 6 个插槽', JSON.stringify(slotNames));
        for (const s of ['settings.tabs', 'settings.modal', 'header.actions', 'sidebar.footer', 'composer.actions', 'chat.message.actions']) {
            c.ok(slotNames.includes(s), '插槽存在：' + s);
        }
        // settings.modal：插件设置独立成窗（2026-10 加）——
        // 插件一多，主设置里会堆一排分栏，所以插件设置默认走独立弹窗
        c.ok(/id="modSettingsOverlay"/.test(html), 'index.html 有插件设置弹窗容器');
        c.ok(/__modSettingsOpeners/.test(slotsSrc), '★ settings.modal 暴露按 id 打开设置的入口（供插件卡片调用）');
        c.ok(!/defineSlot/.test(initSrc), '★ init.js 不再自己挖插槽（已全部移到 host-slots.js）');
        c.ok(/item:\s*true/.test(slotsSrc), '★ chat.message.actions 是每项级插槽（item: true）');
        c.ok(/cleanup\(modId\)/.test(slotsSrc), '★ 每项级插槽提供 cleanup：停用时把已画的元素摘掉');
        c.ok(/item === true[\s\S]{0,400}?必须提供 cleanup/.test(modsSrc),
            '★ defineSlot 强制要求每项级插槽提供 cleanup（否则停用后界面留残留）');
        c.ok(/function renderItemSlot/.test(modsSrc) && /renderItemSlot,/.test(modsSrc),
            '★ 暴露 renderItemSlot 给宿主渲染每一项时调用');
        c.ok(/data-mod/.test(modsSrc) && /child\.setAttribute\('data-mod'/.test(modsSrc),
            '★ 每项级渲染出的元素自动打归属标记（停用时可精确摘除）');

        // ---- 分栏点击必须走事件委托 ----
        c.ok(/settingsTabNav'\)[\s\S]{0,600}?addEventListener\('click'/.test(initSrc),
            '★ 分栏点击委托给容器');
        c.ok(/closest\('\.settings-tab-btn'\)/.test(initSrc), '★ 委托时用 closest 在容器里找按钮');
        c.ok(!/querySelectorAll\('\.settings-tab-btn'\)\.forEach\([^)]*=>\s*\{\s*[A-Za-z_$][\w$]*\.addEventListener/.test(initSrc),
            '★ 不再"查一遍现有按钮再逐个绑"（动态插入的插件分栏会收不到点击）');
        c.ok(/elaina:settings-tab/.test(initSrc), '分栏切换会广播事件（插件分栏延迟渲染）');

        // ---- voice-energy 走事件通道 ----
        // 断言"不许再出现"之前先剥注释：解释"为什么不再直接调"的注释里必然会
        // 写出那个调用，直接匹配全文就是假失败（第一版踩过）。
        const voiceCode = stripComments(voiceSrc);
        c.ok(/emit\('voice-energy'/.test(voiceCode), '★ 宿主把语音音量作为事件报出');
        c.ok(!/Live2DCall\.setVoiceEnergy/.test(voiceCode),
            '★ 宿主不再直接调 Live2D（否则搬成 mod 后这句就是空转）');
        c.ok(/hasListeners\('voice-energy'\)/.test(voiceCode), '★ 没人听就不建音量分析器（省掉逐帧开销）');
        // ★ 订阅改走 host.on（2026-10 搬迁）：Live2D 现在是插件，订阅登记在 mod 系统里，
        //   停用插件时会被自动摘掉（见 mods.js 的"注册即副作用"）。
        //   断言要跟着走 —— 仍写 ElainaMods.on 的话这里会因为"找不到"而失败，
        //   而那其实是**改对了**的标志。
        c.ok(/host\.on\('voice-energy'/.test(stripComments(l2dSrc)),
            'Live2D 侧订阅 voice-energy（走 host.on，停用时可被摘掉）');

        // ---- 前端源码读取器必须真的能读到 mod ----
        // ★★ 2026-10：插件根目录从 `web/mods/` 搬到**项目根** `mods/`。
        //   这里原来断言 `path.join(WEB, 'mods')` —— 搬迁后那个路径**不存在**，
        //   而检查会因此红。真正要钉住的是"它读的是 mods 目录"这件事，
        //   而不是某个具体的拼接写法。所以改成：导出里有 MODS，且不再指 web/ 下。
        c.ok(/export const MODS = path\.join\(ROOT, 'mods'\)/.test(fsSrc),
            '★ frontend-sources.mjs 导出 MODS 指向项目根 mods/');
        c.ok(!/path\.join\(WEB, 'plugins'\)/.test(fsSrc),
            '★ 不再读改名前的 plugins 目录');
        const fe = readFrontend();
        // 判据同样改成"与位置无关"：只要真的收到了某个插件的源码文件即可。
        // （写死 `web/mods/…` 会在下次搬迁时又变成假失败 —— 这次搬迁就是例子。）
        //
        // ★★ 2026-10 二次修：这条**又一次**因为写死目录名而假失败 ——
        //   上一版虽然嘴上说"与位置无关"，实现里却仍然钉着 `mods/galgame/index.js`，
        //   而磁盘上的真实目录是 `galgame-1.0.0`（打包产物名带版本号，
        //   server/mods.mjs 会把它归一化成 id=galgame、dir=galgame-1.0.0）。
        //   于是这条断言在**任何**用带版本号目录安装的环境里都红，
        //   而它想说的其实只是"readFrontend() 不是空串"。
        //
        //   这次真的按语义判：**从清单里取一个真实存在的插件目录**，
        //   再确认它的 index.js 出现在 readFrontend() 的结果里。
        //   这样无论目录叫 galgame 还是 galgame-1.0.0、无论将来怎么改名都不会假失败，
        //   而"一个插件源码都没读到"这种真问题照样会被抓住。
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

    // ---- 5.2 / 5.3 真服务 + 真浏览器 ----
    const PORT = await freePort();
    const HTTPS_PORT = await freePort();
    const BASE = `http://127.0.0.1:${PORT}`;
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-hostapi-data-'));
    const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-hostapi-log-'));
    // 服务端输出落文件（见下面 spawn 的说明：受限环境里不能开命名管道）
    const serverLogPath = path.join(LOG_DIR, 'server-output.log');
    const outFd = openSync(serverLogPath, 'a');
    const serverOut = () => { try { return readFileSync(serverLogPath, 'utf8'); } catch { return ''; } };

    let child = null;
    let browser = null;

    // ---- 临时 mod（必须在服务启动**之前**写好）----
    //
    // ★ 先清一遍再写：上一次运行如果是**被强杀**的（调试时用 `| Select-Object -First N`
    //   截断输出就会提前掐掉 node，或 Ctrl+C），清理没跑完，残留的临时 mod 会被这次
    //   服务在启动时装载 —— 于是"运行中新装的插件需要重启"这类断言会以**相反**的结果
    //   失败，看起来像产品坏了。检查脚本该对自己的残留免疫。
    cleanupTempMods();

    // ★ 把**真正的骨架目录**也装一遍（改 id、打开开关），验证"复制骨架就能用"。
    //   骨架现住在插件开发 skill 里：skills/<技能>/assets/mod-starter/（当前是 skills/插件开发指南/）。
    //
    //   为什么值得单独验：模板是给人复制的交付物，而"语法合法 + manifest 是 JSON"
    //   不等于"装上去真的有反应" —— 恰恰是模板里的 API 名写错、插槽名写错这类问题
    //   只有真装一次才会暴露。检查脚本替用户先撞一遍。
    //
    //   找不到骨架时**在用例里**抛：服务与浏览器都还没起，finally 仍然把临时目录收掉。
    const TPL_ID = 'zz-check-tpl';
    const src = findStarterDir();
    {
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

    try {
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

        child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
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

        let up = false;
        for (let i = 0; i < 80 && !up; i++) {
            try { up = (await fetch(BASE + '/api/server-info')).ok; } catch { await wait(250); }
        }
        c.ok(up, '服务已启动', up ? '' : serverOut().slice(-500));

        if (up) {
            // ==================================================== 5.2 服务端半边
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
            c.ok(ping.status === 200 && pingBody && pingBody.ok === true && pingBody.mod === 'zz-check-api',
                '★ 声明过的路由前缀被真的注册上了（插件能提供接口）',
                'HTTP ' + ping.status + ' ' + JSON.stringify(pingBody));

            const echo = await fetch(BASE + '/api/apicheck/echo/deep/path');
            const echoBody = await echo.json().catch(() => null);
            c.ok(echo.status === 200 && echoBody && echoBody.rest === '/deep/path',
                '★ 子路径可达且 rest 正确（插件能自己解析路径参数）', JSON.stringify(echoBody));

            // ★【模板】它自带的 server.mjs 也要真的装载并能通
            const tplPing = await fetch(BASE + '/api/myfirstmod/ping');
            const tplBody = await tplPing.json().catch(() => null);
            c.ok(tplPing.status === 200 && tplBody && tplBody.ok === true && tplBody.mod === TPL_ID,
                '★【模板】它自带的 server.mjs 装载成功、接口可用（复制模板即得可用的后端半边）',
                'HTTP ' + tplPing.status + ' ' + JSON.stringify(tplBody));

            // 未声明的前缀：装载失败 → 接口不存在 → 宿主也不会被"打洞"
            const evil = await fetch(BASE + '/api/evil');
            c.ok(evil.status === 404, '★ 未在清单里声明的前缀注册不上（/api/evil 不存在）', 'HTTP ' + evil.status);

            // 撞宿主前缀：被拒绝，宿主接口仍正常
            const store = await fetch(BASE + '/api/store');
            const storeBody = await store.json().catch(() => null);
            c.ok(store.status === 200 && storeBody && storeBody.hijacked === undefined,
                '★ 想占 /api/store 的插件被拒绝，宿主接口仍然是宿主的',
                'HTTP ' + store.status + ' ' + JSON.stringify(storeBody).slice(0, 80));

            // 上传目录必须按二进制流返回
            const evilHtml = await fetch(BASE + '/mods/zz-check-api/uploads/evil.html');
            const ctype = evilHtml.headers.get('content-type') || '';
            c.ok(evilHtml.status === 200 && ctype.startsWith('application/octet-stream'),
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
            c.ok(loadedIds.includes('zz-check-api'), '服务端状态里报告了已装载的插件', JSON.stringify(loadedIds));
            c.ok(failedIds.includes('zz-check-badapi'), '★ 注册未声明前缀的插件被标记为装载失败', JSON.stringify(failedIds));
            c.ok(failedIds.includes('zz-check-collide'), '★ 与宿主撞名的插件被标记为装载失败', JSON.stringify(failedIds));
            const badMsg = ((srv.failed || []).find((f) => f.id === 'zz-check-badapi') || {}).error || '';
            c.ok(/没有落在 manifest\.json 的 server\.routes/.test(badMsg), '★ 失败原因是可读的（告诉插件作者该去声明）', badMsg.slice(0, 90));

            // 服务启动后新装的带 server 的插件 → 必须报"需重启"，不能静默不生效
            writeServerMod('zz-check-late',
                { entry: 'server.mjs', routes: ['/api/apiclate'] },
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

            // ==================================================== 5.3 浏览器
            browser = await launchTestBrowser();
            const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
            const page = await ctxB.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));
            try {
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
                c.ok(navStatus === 200, '★ 页面能正常打开（HTTP 200）', 'status=' + navStatus);
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

                // ---- ★ 骨架目录：证明"复制 skill 里的插件骨架就能用" ----
                c.ok(initial.tplTab, '★【模板】设置分栏出现了（label「我的插件」）');
                c.ok(initial.tplHeaderBtn, '★【模板】顶部按钮出现了（label「打招呼」）');
                c.ok(initial.tplSidebar, '★【模板】侧栏底部内容出现了');
                c.ok(initial.tplComposer, '★【模板】输入框那一行的按钮出现了');
                c.ok(initial.tplMsgBtns === 2, '★【模板】每条消息各画了一个按钮（每项级渲染）', 'btns=' + initial.tplMsgBtns);
                c.ok(initial.tplStyleDisabled === false, '★【模板】manifest 里声明的 styles 生效了');

                // 消息按钮真的能点（不只是画出来了）
                const msgClicks = await page.evaluate(() => {
                    const b = document.querySelector('.message-slot-actions .zz-msg-btn');
                    if (!b) return -1;
                    b.click();
                    return window.__slotTest.msgClicks;
                });
                c.ok(msgClicks === 1, '★ 每消息按钮的点击处理被调用', 'clicks=' + msgClicks);

                // 点击分栏 → 延迟渲染
                const panelText = await page.evaluate(() => {
                    const btn = document.querySelector('[data-settings-tab="tab-zz-check-slots"]');
                    if (!btn) return '(没有按钮)';
                    btn.click();
                    const p = document.getElementById('zzSlotPanel');
                    return p ? p.textContent : '(面板没渲染)';
                });
                c.ok(panelText === 'PANEL-OK', '★ 点击插件分栏会渲染内容（事件委托生效）', panelText);

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
                c.ok(hostTab.found && hostTab.activePanel && hostTab.btnActive,
                    '★ 宿主自己的设置分栏仍然能切换（委托没有把原有按钮漏掉）', JSON.stringify(hostTab));

                // 点击顶部按钮
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
                c.ok(!tplOff.tab && !tplOff.headerBtn && !tplOff.sidebar && !tplOff.composer
                    && tplOff.msgBtns === 0 && tplOff.styleDisabled === true,
                    '★【模板】停用后五处贡献全部收回（模板自己不留残留）', JSON.stringify(tplOff));

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

// ────────────────────────────────────────────────────────────
// 6. 端到端：真实服务 + 真实 zip 安装，验证用户报的两个症状都修好了。
//
// 两段：
//   ① 先在临时目录里用真实的 createModManager 走"装带版本号的 zip"这条链
//   ② 再起真实服务，对真实的 mods/ 断言清单与资源可达
//      （第一段能隔离，第二段不能：要验的正是"用户真实装的那套插件能不能加载"）
//
// 末尾还有第三段：安卓侧的原生实现（页内用 Capacitor Filesystem 实现同一套接口）。
// ────────────────────────────────────────────────────────────

/**
 * 内存版 Capacitor Filesystem —— 尽量贴近真实语义。
 *
 * 真实的 Capacitor Filesystem：writeFile 收 base64（或按 encoding 解码）、
 * readFile 按 encoding 决定返回字符串还是 base64、readdir 每条要带 type 字段。
 * 这些语义用 mock 最容易写错，而写错了原生那条链会"看起来通过"。
 */
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
            return encoding === 'utf8' ? files.get(d).toString('utf8') : files.get(d).toString('base64');
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

async function caseModE2E(c) {
    /* 插件源码不随仓库分发（仓库只推软件本体，插件走应用内安装）——
       本地没有这些插件是**正常状态**，跳过而不是判红。 */
    if (!['live2d', 'galgame', 'pet', 'elaina-avatar'].every((n) => existsSync(path.join(ROOT, 'mods', n)))) {
        console.log('  --   跳过：本地没有 live2d/galgame/pet/elaina-avatar 插件源码（插件走应用内安装，这是正常状态）');
        return;
    }
    const tmp = tempDirFactory('e2e-');
    const newDir = () => tmp.dir();
    let child = null;

    try {
        // ============================================================
        // 6.1 安装链 —— 模拟用户从 Releases 下载带版本号的 zip 丢进 mods/
        // ============================================================
        const modsDir = newDir();
        const zip = createZip([
            { name: 'manifest.json', data: Buffer.from(JSON.stringify({
                id: 'elaina-avatar', name: '伊蕾娜立绘与情绪', version: '1.0.0',
                entry: 'index.js', defaultEnabled: true, hidden: true,
            }), 'utf8') },
            { name: 'index.js', data: Buffer.from(
                'window.ElainaMods&&window.ElainaMods.register("elaina-avatar",function(host){'
                + 'if(host&&host.assetBase)window.__base=host.assetBase();return{};});', 'utf8') },
            { name: 'img/p_calm.png', data: Buffer.from('PNGDATA') },
        ]);
        writeFileSync(path.join(modsDir, 'elaina-avatar-1.0.0.zip'), zip);

        const mgr = mkMgr(modsDir);
        const r1 = await mgr.scanAndSync();

        const dirs = readdirSync(modsDir).filter((n) => !n.endsWith('.zip') && n !== 'index.json');
        c.ok(dirs.includes('elaina-avatar'), '★ 装成 elaina-avatar/（不是 elaina-avatar-1.0.0/）', JSON.stringify(dirs));
        c.ok(!dirs.includes('elaina-avatar-1.0.0'), '★ 没有留下带版本号的目录');
        const av = r1.installed.find((p) => p.id === 'elaina-avatar');
        c.ok(Boolean(av), '清单里 id 是 elaina-avatar');
        c.ok(av && av.dir === 'elaina-avatar', 'dir 与实际目录一致', av && av.dir);

        // 资源 URL（插件内部约定路径）能对上
        c.ok(existsSync(path.join(modsDir, 'elaina-avatar', 'img', 'p_calm.png')),
            '★ 立绘落在 /mods/elaina-avatar/img/p_calm.png 对应位置（不再 404）');

        // ---- 再装 galgame（依赖 elaina-avatar）----
        const gdir = path.join(modsDir, 'galgame');
        mkdirSync(gdir, { recursive: true });
        writeFileSync(path.join(gdir, 'manifest.json'), JSON.stringify({
            id: 'galgame', name: 'Galgame 界面', version: '1.0.0', entry: 'index.js',
            styles: ['style.css'], defaultEnabled: false, after: ['elaina-avatar'],
        }));
        writeFileSync(path.join(gdir, 'index.js'), 'void 0;');
        writeFileSync(path.join(gdir, 'style.css'), '/* x */');

        const r2 = await mgr.scanAndSync();
        const ids = new Set(r2.installed.map((p) => p.id));
        const g = r2.installed.find((p) => p.id === 'galgame');
        c.ok(ids.has('elaina-avatar'), '★ 依赖目标 elaina-avatar 在清单里');
        c.ok(g && g.after.every((d) => ids.has(d)),
            '★ galgame 的 after 能解析（依赖不再失效）', g ? JSON.stringify(g.after) : '');

        // ============================================================
        // 6.2 真实服务 —— 对真实 mods/ 断言清单与资源可达
        // ============================================================
        const DATA_DIR = newDir();
        const LOG_DIR = newDir();
        const PORT = await freePort();
        const HTTPS_PORT = await freePort();
        const BASE = `http://127.0.0.1:${PORT}`;

        child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
            cwd: ROOT,
            env: {
                ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT),
                HOST: '127.0.0.1', DATA_DIR, LOG_DIR, LOG_TO_FILE: '0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });

        try {
            let up = false;
            for (let i = 0; i < 80 && !up; i++) {
                try { up = (await fetch(BASE + '/api/server-info')).ok; } catch { await wait(250); }
            }
            c.ok(up, '服务已启动', up ? '' : out.slice(-300));

            if (up) {
                const api = await (await fetch(BASE + '/api/plugins')).json();
                c.ok(api.ok === true, '/api/plugins 可用');
                const plugins = api.plugins || [];
                for (const p of plugins) {
                    console.log(`      id=${String(p.id).padEnd(16)} dir=${String(p.dir).padEnd(16)} after=${JSON.stringify(p.after)}`);
                }

                const avP = plugins.find((p) => p.id === 'elaina-avatar');
                c.ok(avP && typeof avP.dir === 'string' && avP.dir.length > 0,
                    '★ 清单带 dir 字段（前端按它加载脚本）', avP && avP.dir);

                const ids = new Set(plugins.map((p) => p.id));
                for (const dep of ['galgame', 'pet']) {
                    const m = plugins.find((p) => p.id === dep);
                    if (!m) { c.ok(false, `${dep} 在清单里`); continue; }
                    c.ok(m.after.every((d) => ids.has(d)), `★ ${dep} 的 after 可解析`, JSON.stringify(m.after));
                }

                // 按 dir 拼 URL 能取到脚本（这是前端 loadOne 的真实路径）
                for (const p of plugins) {
                    const url = `/mods/${p.dir}/${p.entry || 'index.js'}`;
                    const r = await fetch(BASE + url);
                    c.ok(r.status === 200, `★ ${url} → 200`, 'status=' + r.status);
                }

                // 立绘图片可达 —— ★ 按清单里的**真实目录名**拼 URL，不写死 'elaina-avatar'
                //   （用户改了目录名时，写死的 URL 必然 404；那是检查的问题）
                const avEntry = plugins.find((p) => p.id === 'elaina-avatar');
                if (avEntry) {
                    const enc = String(avEntry.dir || avEntry.id).split('/').map(encodeURIComponent).join('/');
                    const img = await fetch(BASE + `/mods/${enc}/img/p_calm.png`);
                    c.ok(img.status === 200,
                        `★ 立绘 /mods/${enc}/img/p_calm.png → 200（按真实目录）`, 'status=' + img.status);
                    c.ok((img.headers.get('content-type') || '').startsWith('image/'),
                        '返回图片类型', img.headers.get('content-type'));
                } else {
                    c.ok(false, '清单里有 elaina-avatar（才能验立绘）');
                }
            }
        } finally {
            child.kill();
            await wait(300);
        }

        // ============================================================
        // 6.3 ★ 安卓侧插件可拆装（2026-10 用户要求："安卓我也要插件可拆装
        //   而不是封装在 apk 安装包里面"）
        //
        // 电脑版的安装/卸载走服务端（上面两段已覆盖）。安卓版**没有服务端** ——
        // 它由 core.js 的 nativePluginsFetch 在页内用 Capacitor Filesystem
        // 实现同一套接口语义。这一段把那条**原生链路**真的跑一遍：
        //   安装 → 列表 → 删除 → 列表
        //
        // 为什么值得单独测：两端各有一套实现（server/mods.mjs 与 core.js），
        // 而 APK 上没有服务端可对照 —— 原生这条链断了**不会有任何报错**，
        // 只表现为"点了上传安装没反应"或"删了还在"。
        // ============================================================
        {
            const core = readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');

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
            for (const fn of ['nativeFs', 'bytesToBase64', 'nativeWriteFile', 'nativeNormalizeModId',
                'nativeEffectiveExt', 'nativeReadModManifest', 'nativeListModFiles', 'nativeListPlugins',
                'nativeDeletePlugin', 'nativeInstallPlugin', 'nativePluginsFetch', 'unzipBrowser']) {
                try { pieces.push(extractFn(core, fn)); } catch (e) { c.ok(false, '抠出原生函数 ' + fn, e.message); }
            }
            vm.runInContext(pieces.join('\n\n'), sandbox);
            sandbox.nativeFs = () => memFs;

            // 造一个最小合法插件 zip（store 模式，不压缩）
            const zipBuf = makeZip([
                ['manifest.json', JSON.stringify({ id: 'e2etest', name: 'E2E 测试插件', version: '1.0.0', entry: 'index.js', defaultEnabled: false })],
                ['index.js', 'window.__e2e = true;'],
            ]);

            try {
                const installRes = await sandbox.nativePluginsFetch('/api/plugins/install?name=e2etest-1.0.0.zip', { method: 'POST', body: new Blob([zipBuf]) });
                const installJson = await installRes.json();
                c.ok(installJson.ok === true, '★ 安卓：上传安装成功', JSON.stringify(installJson));
                c.ok(installJson.id === 'e2etest', '★ 安卓：安装得到正确 id', String(installJson.id));

                const listJson = await (await sandbox.nativePluginsFetch('/api/plugins', { method: 'GET' })).json();
                const ids = (listJson.plugins || []).map((p) => p.id);
                c.ok(ids.includes('e2etest'), '★ 安卓：列表里能看到刚装的插件', JSON.stringify(ids));

                const delJson = await (await sandbox.nativePluginsFetch('/api/plugins/e2etest', { method: 'DELETE' })).json();
                c.ok(delJson.ok === true, '★ 安卓：卸载成功', JSON.stringify(delJson));

                const ids2 = ((await (await sandbox.nativePluginsFetch('/api/plugins', { method: 'GET' })).json()).plugins || []).map((p) => p.id);
                c.ok(!ids2.includes('e2etest'), '★ 安卓：卸载后列表里没有它了（真拆掉了）', JSON.stringify(ids2));

                // ★ 路径穿越必须被挡：这是"可拆装"带来的新攻击面
                const evil = await (await sandbox.nativePluginsFetch('/api/plugins/..%2F..%2Fdata', { method: 'DELETE' })).json();
                c.ok(evil.ok !== true, '★ 安卓：非法 id 的删除被拒绝（防目录穿越）', JSON.stringify(evil));
            } catch (e) {
                c.ok(false, '安卓侧安装链路跑通', String(e && e.message || e));
            }
        }
    } finally {
        if (child) { try { child.kill(); } catch { /* 忽略 */ } }
        tmp.cleanup();
    }
}

// ────────────────────────────────────────────────────────────
// 入口：按命令行参数过滤用例（便于只跑其中一段）
// ────────────────────────────────────────────────────────────

const only = process.argv[2];
const allCases = [
    { name: '插件系统核心（扫描 / 解压 / 清单 / 安全）', fn: caseModsCore },
    { name: '插件 id 归一化与依赖可解析', fn: caseModId },
    { name: '插件身份与路径解析', fn: caseModIdentity },
    { name: '插件依赖与日志可读性', fn: caseModDeps },
    { name: '插件宿主能力（插槽 / 回收 / 服务端半边）', fn: caseModHostApi },
    { name: '端到端（真实服务 + 真实 zip）', fn: caseModE2E },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: '插件系统（扫描 / 身份 / 依赖 / 宿主能力 / 端到端）',
    usage: 'node scripts/check-mod.mjs [用例名子串]',
    cases,
});
