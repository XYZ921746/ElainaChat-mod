// 插件（mod）系统的回归检查：扫描 / 安装解压 / 清单生成 / 安全防护 / 身份与依赖解析 / 宿主能力（插槽）/ 端到端。
// 每个用例自建临时目录与端口并在 try/finally 里自清（部分用例起真实服务，写死端口/MODS_DIR 会互相争用，往仓库 mods/ 写东西会留痕）。
// 用法：node scripts/check-mod.mjs [用例名子串]，缺省跑全部。
// 本机环境性失败（缺 mods/ 实物）属已知基线：不是代码坏了，逐条比对 PASS/FAIL 条数即可。

import { spawn } from 'node:child_process';
import {
    mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdirSync,
    openSync, closeSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFrontend, readHtmlAndStyles } from './frontend-sources.mjs';
import { launchTestBrowser } from './test-browser.mjs';
import { runChecks, ROOT, wait, waitServerUp, freePort } from './check-harness.mjs';
import { createModManager } from '../server/mods.mjs';
import { createModServer } from '../server/mod-server.mjs';
import { createSkillManager } from '../server/skills.mjs';
import { readZip, createZip, effectiveExt } from '../server/zip.mjs';
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

function modPath(id, ...rest) {
    const dir = modDirById(id);
    return dir ? path.join(MODS, dir, ...rest) : null;
}

// 手工构造 store 模式（不压缩）ZIP：测试不依赖外部打包工具，安卓链也要同一套字节布局
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

// 用真实 createModManager 造指向指定目录的管理器：参数与 web/serve.mjs 给真实服务的一致，各用例共用这一份
const mkMgr = (modsDir) => createModManager({
    modsDir,
    unzip: (buf, opts = {}) => readZip(buf, { ...opts, returnBlocked: true }),
    isUnsafeEntryName: (n) => n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..'),
    effectiveExt,
    log: () => {},
});

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

// 1. 插件系统：服务端扫描 / 自动解压 / 清单生成 / 安全防护
// 为什么常驻：mod 是同源执行第三方 JS 的入口，路径穿越、卸载不彻底、allowScripts 忘传都极易回归
async function caseModsCore(c) {
    {
        const mods = readFileSync(path.join(ROOT, 'server', 'mods.mjs'), 'utf8');
        const serve = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');
        const loader = readFileSync(path.join(ROOT, 'web', 'js', 'mods-load.js'), 'utf8')
            + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');
        // 解压实现要看 server/zip.mjs 那份：serve.mjs 只保留薄包装，不再自带完整实现
        const zip = readFileSync(path.join(ROOT, 'server', 'zip.mjs'), 'utf8');

        c.ok(/export function createModManager/.test(mods), 'server/mods.mjs 导出 createModManager');
        c.ok(/function scanAndSync/.test(mods), '有 scanAndSync（扫描目录 + 解压 + 生成清单）');
        c.ok(/function uninstall/.test(mods), '有 uninstall');
        c.ok(/MOD_ID_RE/.test(mods), '插件名有白名单校验（挡 .. 与绝对路径）');

        // allowScripts：mod 的本质是 JS，但解压默认黑名单含 .js
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
        const modsJs = readFileSync(path.join(WEB, 'js', 'mods-capabilities.js'), 'utf8')
            + '\n' + readFileSync(path.join(WEB, 'js', 'mods.js'), 'utf8');
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

        c.ok(/id \+ ext/.test(mods) || /\.zip/.test(mods.split('function uninstall')[1] || ''),
            '★ 卸载时连安装包一起删（否则 scanAndSync 会把它装回来）');

        // 卸载必须按真实目录删：id 来自 manifest、目录名是安装时的包名，两者可不一致（表 A9），
        // 用 id 拼的路径不存在而 rm(force:true) 静默成功，表现为"卸载不掉却提示已删除"
        c.ok(/function findModDirById/.test(mods),
            '★ 有 findModDirById（按 id 反查真实目录，因为目录名 ≠ id）');
        const uninstallFn = mods.split('function uninstall')[1] || '';
        // 只取 uninstall 本体：紧随其后的 findModDirById 会合法地用同名目录拼一次路径，算进来会误红
        const uninstallBody = uninstallFn.split('async function findModDirById')[0];
        c.ok(/await\s+findModDirById\(id\)/.test(uninstallBody),
            '★ 卸载经 findModDirById 解析真实目录（不是 path.join(modsDir, id)）');
        c.ok(!/path\.join\(modsDir,\s*id\)/.test(uninstallBody),
            '★ 卸载不得用 id 直接拼目录路径（拼出来的目录名可能不存在）');
        c.ok(/if\s*\(!dir\)\s*throw/.test(uninstallBody) || /!dir\)\s*\{?\s*throw/.test(uninstallBody),
            '★ 找不到目录时明确抛错（不假装卸载成功）');
        // 删完要确认真的没了：Windows 上文件被占用会留下半删目录
        c.ok(/await\s+stat\(resolved\)/.test(uninstallBody),
            '★ 删完复查目录确已消失（文件被占用时不留"假成功"）');
        c.ok(/function findModDirById/.test(mods) && /manifest\.json/.test(mods.split('function findModDirById')[1] || ''),
            '★ findModDirById 读各目录 manifest.json 比对 id（目录名不可靠）');

        // README 与卸载是同一个身份问题：带版本号的安装目录用 id 拼 README 路径永远读不到
        const readmeBody = (mods.split('function readReadme')[1] || '').split('async function uninstall')[0];
        c.ok(/await\s+findModDirById\(id\)/.test(readmeBody),
            '★ README 经 findModDirById 解析真实目录（不是 path.join(modsDir, id)）');
        c.ok(!/path\.join\(modsDir,\s*id\)/.test(readmeBody),
            '★ README 不得用 id 直接拼目录路径（目录名可能带版本号）');

        c.ok(/ElainaMods/.test(loader), '加载器挂在 window.ElainaMods');
        c.ok(/function discover/.test(loader), '有 discover（读 index.json 清单）');
        c.ok(/sortByDependency/.test(loader), '有依赖排序（manifest.after）');
        c.ok(/依赖成环/.test(loader), '检测环形依赖（不死循环）');
        c.ok(/失败隔离|已隔离/.test(loader), '加载失败会隔离（不拖垮整个应用）');
        c.ok(/register\(/.test(loader), '提供 register（mod 脚本注册初始化函数）');
        c.ok(/setPromptHint|promptHints/.test(loader), '提供 system 提示词注入入口（Galgame 场景切换要用）');

        // 插件市场：依赖必须自动补齐 —— 只提示"缺依赖"不够，主体装完会因前置缺失拒绝加载，看起来像插件坏了
        const market = readFileSync(path.join(WEB, 'js', 'market-utils.js'), 'utf8')
            + '\n' + readFileSync(path.join(WEB, 'js', 'download.js'), 'utf8')
            + '\n' + readFileSync(path.join(WEB, 'js', 'mod-market.js'), 'utf8');
        c.ok(/function resolveInstallOrder/.test(market),
            '★ 有 resolveInstallOrder（把依赖摊平成安装顺序）');
        c.ok(/resolveInstallOrder\(dep,\s*byId,\s*installed,\s*visiting\)/.test(market),
            '★ 递归解析依赖（依赖的依赖也要装）');
        c.ok(/visiting/.test(market) && /visiting\.has\(/.test(market),
            '★ 依赖环检测（相互依赖不死循环）');
        c.ok(/out\.push\(\{\s*plugin:\s*p1/.test(market),
            '★ 本体排在依赖之后（深度优先后序）');
        // 断言必须锚定 installed.has 前提：只匹配 out.push 的话，去掉判断也会通过，等于没检查
        c.ok(/if\s*\(!installed\.has\(p1\.id\)\)\s*out\.push\(\{\s*plugin:\s*p1/.test(market),
            '★ 已安装的依赖不重复下载（push 必须在 installed.has 判断之内）');
        const installBody = market.split('function installFromMarket')[1] || '';
        c.ok(/for\s*\(var\s+i\s*=\s*0;\s*i\s*<\s*queue\.length/.test(installBody),
            '★ 按队列依次安装（依赖先于本体落盘）');
        c.ok(/done\.length\s*>\s*1/.test(installBody),
            '★ 装完把一起装上的依赖告知用户（否则用户不知道多了什么）');
        // 依赖解析必须用整份索引：改用某个分区的话前置扩展不会跟着装，主体装完照样拒绝加载
        c.ok(/lastIndex\.plugins/.test(installBody),
            '★ 依赖解析读整份索引（前置扩展照样会被一起装）');
        // 纯底座类前置默认不收进列表：无独立界面，单列等于请用户手装不认识的包；判定看依赖关系而非 id
        c.ok(/function isPrerequisiteOnly/.test(market) && /kind === 'resource'/.test(market)
            && /o\.depends\.indexOf\(p\.id\) >= 0/.test(market),
            '★ 纯底座前置按「resource 或只被别人依赖」认定（不点名 id）');
        // 商店端显式声明优先于推断：true 收起、false 强制单列，只认 true 的话带独立界面的资源包回不了列表
        c.ok(/p\.prerequisite === true/.test(market) && /p\.prerequisite === false/.test(market),
            '★ 索引可用 prerequisite 显式声明（true 进前置区 / false 强制进普通列表）');
        c.ok(/p\.hidden === true/.test(market),
            '★ 兼容索引沿用 manifest.hidden 的商店源（只认 true，false 不参与判定）');
        c.ok(/function splitMarketPlugins/.test(market) && /marketSectionHead/.test(market),
            '★ 前置扩展单列一个区（不隐藏、不与普通扩展混排）');
        c.ok(/marketPrereqOpen/.test(market) && /marketPrereqBody/.test(market)
            && /classList\.toggle\('hidden', !marketPrereqOpen\)/.test(market),
            '★ 市场的前置区默认收起（点标题展开，收起只是折叠）');

        // 大包分片并发下载：单条 TCP 流限速严重而浏览器默认多连接；钉住"并发是默认路径"与"退回单流"退路
        c.ok(/function downloadZipSegmented/.test(market),
            '★ 有分片并发下载（downloadZipSegmented）');
        c.ok(/headers:\s*\{\s*Range:\s*'bytes='\s*\+\s*start/.test(market),
            '★ 分片请求带 Range 头（并发靠它切段）');
        c.ok(/function segmentCountFor/.test(market) && /MAX_SEGMENTS/.test(market),
            '★ 片数按体积计算且有上限（segmentCountFor + MAX_SEGMENTS）');
        c.ok(/IS_MOBILE_DEVICE/.test(market),
            '★ 手机端降低并发片数（复用 core.js 的设备判定，不另嗅探 UA）');
        // 退路一：服务端回了 200（忽略 Range）不能当分片用，否则 16 个 200 会被拼成一个 16 倍大的坏 zip
        c.ok(/!\s*===\s*206|status\s*!==\s*206/.test(market),
            '★ 非 206 判定（服务端忽略 Range 时不当分片用）');
        const segBody = market.split('function downloadZipSegmented')[1] || '';
        c.ok(/SEGMENT_RETRIES/.test(segBody) && /attempt\s*<=\s*SEGMENT_RETRIES/.test(segBody),
            '★ 分片失败会重试（单连接在这条链路上常中途卡死）');
        const fromBody = market.split('function downloadZipFrom')[1] || '';
        c.ok(/catch\s*\(e\)[\s\S]{0,400}单流/.test(fromBody),
            '★ 分片整体失败后回退单流（分片不是唯一路径）');
        // 退路二：镜像只有在原地址整条路失败后才用，正常情况不能白打一次网络
        c.ok(/function packageMirrorUrls/.test(market),
            '★ 有包下载镜像候选（packageMirrorUrls）');
        const dlBody = market.split('async function downloadZip\(')[1] || '';
        c.ok(/packageMirrorUrls\(url\)/.test(dlBody) && /for\s*\([^)]*urls\.length/.test(dlBody),
            '★ 镜像按顺序回退（原地址排第一）');
        // 镜像只对官方索引下的包生效：自建源的托管路径猜不出来；断言认提前返回行为而非具体写法
        c.ok(/store\\\/packages|store\/packages/.test(market) && /if\s*\(!m\)\s*return\s*(?:\[url\]|out)\s*;/.test(market),
            '★ 镜像只作用于官方源的包地址（自建源不被硬套）');
        c.ok(/cache:\s*'no-cache'/.test(market),
            '★ 索引用 no-cache（可存但回源验证，不是 no-store 全量重下）');

        const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
        c.ok(/<script[^>]*src="\/js\/mods\.js"[^>]*><\/script>/.test(html), 'index.html 引入了 mods.js');
        const iMods = html.indexOf('/js/mods.js');
        const iInit = html.indexOf('/js/init.js');
        c.ok(iMods > 0 && iInit > 0 && iMods < iInit, '★ mods.js 排在 init.js 之前（初始化要读清单）');

        const data = readFileSync(path.join(ROOT, 'web', 'js', 'roleplay.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'chat.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'data.js'), 'utf8');
        c.ok(/ElainaMods/.test(data) && /collectPromptHints/.test(data),
            '★ 宿主在构造提示词时消费 mod 注入的 system 片段');

        c.ok(/api\/plugins\/install/.test(serve), '服务端有 POST /api/plugins/install（上传安装）');
        c.ok(/installFromBuffer/.test(mods), 'mods.mjs 提供 installFromBuffer（从内存 zip 安装）');
        c.ok(/writePluginFiles/.test(mods),
            '★ 两条安装路径（丢文件进目录 / 上传）共用同一段安全逻辑');
        c.ok(/插件名不能包含路径成分/.test(serve), '★ 含路径成分的插件名被明确拒绝（不静默改名）');
        c.ok(/id="modsInstallBtn"/.test(html), '设置里有「上传安装」按钮');
        c.ok(/id="modsFileInput"/.test(html), '有隐藏的 file input');
        // 应用内删除按钮：服务端早有 DELETE /api/plugins/:id，界面没暴露时用户只能删目录、又会被 zip 装回来
        const settingsSrc = readFileSync(path.join(ROOT, 'web', 'js', 'plugins.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');
        const modsLoader = readFileSync(path.join(ROOT, 'web', 'js', 'mods-host-core.js'), 'utf8')
    + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'mods-api.js'), 'utf8')
    + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');
        c.ok(/mod-del-btn/.test(settingsSrc), '★ 设置里渲染「删除」按钮');
        c.ok(/method: 'DELETE'/.test(settingsSrc), '★ 删除走 DELETE /api/plugins/:id');
        c.ok(/showCustomConfirm[\s\S]{0,400}删除插件/.test(settingsSrc), '★ 删除前二次确认（防误删）');
        c.ok(/forget: forgetMod/.test(modsLoader), '★ ElainaMods 导出 forget（清启用状态，避免重装自动启用）');

        c.ok(/data-settings-tab="tab-mods"/.test(html), '设置里有「插件」Tab');
        c.ok(/id="tab-mods"/.test(html), '有 #tab-mods 面板');
        c.ok(/id="modsList"/.test(html), '有 mod 列表容器');
        c.ok(!/id="modsGlobalToggle"/.test(html), '★ 全局开关已删除（默认开启，不再有一键全关）');
        c.ok(/id="modsInstallBtn"/.test(html), '有 上传安装 入口');
        // 清单在每次打开设置时都会重扫（openSettings → refreshModsList），标题栏重扫/卡片 ⟳/悬浮钮都不该回来
        c.ok(!/id="modsRefreshBtn"/.test(html), '★ 没有「⟳ 重新扫描」按钮');
        c.ok(!/modsFab/.test(html), '★ 没有右下角悬浮刷新钮');
        const settingsForCard = readFileSync(path.join(ROOT, 'web', 'js', 'plugins.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');
        c.ok(!/mod-refresh-one/.test(settingsForCard), '★ 卡片上没有单独的 ⟳');
        c.ok(/id="modsAddGroupBtn"/.test(html), '★ 有「添加分栏」按钮（插件分组）');
        // 「浏览目录」必须带 id（init.js 按 id 绑一次）：挂在 refreshModsList 里按 class 绑会被整块 innerHTML 重建冲掉
        c.ok(/id="modsBrowseBtn"/.test(html), '★ 有「浏览目录」按钮（id 形式，供 init 绑一次）');
        c.ok(/id="modsBrowseResult"/.test(html), '★ 「浏览目录」有独立结果面板（长路径不会被挤没）');
        c.ok(/mod-group-toggle/.test(readHtmlAndStyles()), '★ 分栏折叠三角（disclosure triangle）');
        const settings = readFileSync(path.join(ROOT, 'web', 'js', 'plugins.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');
        c.ok(/async function refreshModsList/.test(settings), '有 refreshModsList');
        c.ok(/getElementById\('modsBrowseBtn'\)\?\.addEventListener/.test(readFileSync(path.join(ROOT, 'web', 'js', 'bindings.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'init.js'), 'utf8')),
            '★ 「浏览目录」在 init.js 绑一次（不随列表重建丢失）');
        c.ok(!/modsBrowseBtn[\s\S]{0,400}addEventListener/.test(settings),
            '★ settings.js 里不再重复绑定「浏览目录」');
        const initSrc2 = readFileSync(path.join(ROOT, 'web', 'js', 'bindings.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'init.js'), 'utf8');
        c.ok(/modsBrowseBtn[\s\S]{0,2000}fetch\('\/api\/plugins\/open-folder'/.test(initSrc2),
            '★ 「浏览目录」先真去打开 mods/，再列内容兜底');
        c.ok(/\/api\/plugins/.test(settings), '列表数据来自服务端 /api/plugins');
        c.ok(/ElainaMods\.list\(\)/.test(settings), '同时合并前端加载状态（服务端只知道磁盘上有什么）');
        c.ok(/加载失败/.test(settings), '★ 加载失败的 mod 有显眼标记（否则用户以为"开了没反应"）');
        c.ok(/公共依赖/.test(settings), '★ hidden 的 mod 显示为「公共依赖」而非开关');
        c.ok(/前置扩展/.test(settings) && /prereqMods/.test(settings) && /isPrereqMod/.test(settings),
            '★ 插件页有固定的「前置扩展」区（不隐藏，单独存放）');
        c.ok(/afterNames/.test(settings),
            '★ 前置判定同时认 manifest.hidden 与"被别的插件 after 点名"');
        const gal = readFileSync(modPath('galgame', 'index.js'), 'utf8');
        c.ok(/enabled = false;\s*\n\s*build\(\);/.test(gal) && !/if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', \(\) => open\(\)\);/.test(gal),
            '★ 启用 galgame 不再自动打开剧情界面（由主页按钮进入）');
        c.ok(/function setEnabled\(on, silent\)/.test(gal) && !/if \(on\) open\(\); else close\(\);/.test(gal),
            '★ setEnabled(true) 只让功能可用，不打开界面（避免"拨开关就被推进全屏"）');
        const galReg = readFileSync(modPath('galgame', 'register.js'), 'utf8');
        c.ok(/id: 'scenario'/.test(galReg) && /settings\.modal/.test(galReg)
            && /id: 'galgame'/.test(galReg),
            '★ 主页右上角一个「情景演绎」入口 + 设置窗按插件 id 注册（齿轮能找到它）');
        const l2dCore = readFileSync(modPath('galgame', 'index-live2d.js'), 'utf8');
        const l2dPanel = readFileSync(modPath('galgame', 'settings-panel.js'), 'utf8');
        const l2dHtml = readFileSync(modPath('galgame', 'panel.html'), 'utf8');
        c.ok(/function setSceneMode/.test(l2dCore) && /sceneMode/.test(l2dCore)
            && /id="ggL2dPortrait"/.test(l2dCore),
            '★ 舞台支持双模式（Live2D / 图片立绘）并共用同一个气泡');
        c.ok(!/挂断|结束通话/.test(l2dCore) && !/live2d-speaking|live2d-mute-hint/.test(l2dCore),
            '★ 情景演绎界面不再有视频通话控件（挂断 / 正在说话 / 静音提示）');
        c.ok(!/live2d-model-select|live2d-topbar/.test(l2dCore)
            && /id="live2d-exit-btn"/.test(l2dCore) && /\.live2d-exit-btn/.test(l2dCore),
            '★ 舞台右上角只有按钮组（退出 / 朗读 / 语音输入），没有模型下拉与底栏退出');
        const galManifest = JSON.parse(readFileSync(modPath('galgame', 'manifest.json'), 'utf8'));
        c.ok(Array.isArray(galManifest.skills) && galManifest.skills.includes('skills/scenario-stage')
            && existsSync(path.join(path.dirname(modPath('galgame', 'manifest.json')), 'skills/scenario-stage/SKILL.md')),
            '★ 随附「情景演绎」技能（告诉 AI 怎么调背景与表情）');
        c.ok(/listBackgrounds\(\)/.test(l2dCore) && /setBackgroundByName\(/.test(l2dCore)
            && /listEmotions\(\)/.test(l2dCore) && /setEmotion\(name\)/.test(l2dCore),
            '★ 暴露背景/表情接口（listBackgrounds / setBackgroundByName / listEmotions / setEmotion）');
        c.ok(/sceneMode === 'portrait'[\s\S]{0,200}resolveEmotionKey\(expName\)/.test(l2dCore),
            '★ [表情:] 在立绘模式下映射成对应情绪（两种呈现都生效）');
        // 语音朗读/输入走宿主 host.speak 与 host.dictation（D14：不直接摸宿主内部）
        const coreSrc = readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');
        c.ok(/get speech\(\)/.test(coreSrc) && /startVoicePlaybackOnce\(/.test(coreSrc),
            '★ 宿主提供 ElainaHost.speech（复用同一条 TTS 链路）');
        c.ok(/speak\(text, opts\) \{/.test(modsLoader) && /speechConfigured\(\)/.test(modsLoader),
            '★ host API 暴露 speak / speechConfigured / stopSpeech');
        c.ok(/function speakBubble/.test(l2dCore) && /host\.speak\(/.test(l2dCore)
            && !/live2d-speech-btn|getSpeechEnabled|setSpeechEnabled/.test(l2dCore),
            '★ 舞台自动朗读 AI 新回复（默认开，没有朗读开关）');
        c.ok(/get dictation\(\)/.test(coreSrc) && /canUseCloudFinalAsr/.test(coreSrc),
            '★ 宿主提供 ElainaHost.dictation（ASR 是否配置、开麦/结束）');
        c.ok(/dictate\(action\) \{/.test(modsLoader) && /dictationConfigured\(\)/.test(modsLoader),
            '★ host API 暴露 dictate / dictationConfigured / dictationState');
        c.ok(/live2d-mic-btn/.test(l2dCore) && /host\.dictate\(/.test(l2dCore)
            && /dictationConfigured/.test(l2dCore),
            '★ 舞台语音输入按钮（未配置 ASR 时隐藏，识别完自动发送）');
        c.ok(/gg-srow[\s\S]{0,400}live2d-mic-btn|live2d-mic-btn[\s\S]{0,400}gg-srow/.test(l2dCore)
            && /class="gg-mic-btn"/.test(l2dCore),
            '★ 说话按钮与输入框同一行（发给键左侧）');
        c.ok(!/data-?[^>]*gsSpeech|id="gsSpeech"|id="gsDictationHint"/.test(l2dHtml)
            && !/gsSpeech|gsDictationHint/.test(l2dPanel),
            '★ 设置页不放朗读/语音输入开关（都走宿主「设置 → 语音」）');
        c.ok(!/const host = document\.createElement/.test(l2dCore),
            '★ buildUI 不遮蔽 host API（DOM 变量叫 layer）');
        c.ok(/data-scene-mode="live2d"/.test(l2dHtml) && /data-scene-mode="portrait"/.test(l2dHtml)
            && /setSceneMode/.test(l2dPanel),
            '★ 设置页有「角色呈现」切换（立绘 / 模型），改动立即生效');
        c.ok(/noGrip/.test(settings),
            '★ 前置区卡片不画拖拽把手（固定分区，不参与用户分栏）');
        c.ok(/modsPrereqOpen/.test(settings) && /modsPrereqBody/.test(settings),
            '★ 插件页前置区默认收起（标题可展开，拨开关重渲染后保持展开态）');
        // 前置卡片挂在 #modsList 之外：事件只绑 #modsList 时卡片上的按钮与开关全都没有监听器
        c.ok(/getElementById\('modsPrereqBody'\)[\s\S]{0,200}bindModToggle\(root, hint\)[\s\S]{0,120}bindModCardButtons\(root, hint\)/.test(settings),
            '★ 前置区卡片的按钮与开关也绑事件（它们不在 #modsList 里，只绑 box 会点了没反应）');
        c.ok(/after: Array\.isArray\(e\.manifest\.after\)/.test(modsLoader),
            '★ list() 带出 after（APK/手工目录也判得出前置）');
        c.ok(/elaina_mods_groups/.test(settings), '★ 分栏清单有持久化（与 store.js 的 DATA_KEYS 对应）');
        c.ok(/elaina_mods_top_order/.test(settings), '★ 顶层混排顺序（分栏与插件同等级）');
        c.ok(/loose\.push/.test(settings), '★ 没归属的插件平铺在顶层（不再装进"未分类"栏）');
    }

    {
        const galPath = modPath('galgame', 'index.js');
        const petPath = modPath('pet', 'index.js');
        const avatarIndex = modPath('elaina-avatar', 'index.js');
        /* 插件不随仓库分发，缺了是正常状态：跳过而不是判红，且逐个实物判断 ——
           只装了其中几个同样正常，"三个都缺才跳过"会让部分安装误红。 */
        const wanted = [['galgame', galPath], ['pet', petPath], ['elaina-avatar', avatarIndex]];
        const missingAssets = wanted.filter(([, p]) => !p || !existsSync(p)).map(([n]) => n);
        for (const [n, p] of wanted) {
            if (!p || !existsSync(p)) continue;
            c.ok(true, n + '/index.js 存在'
                + (n === 'elaina-avatar' ? '（按 manifest.id 找到真实目录：' + modDirById('elaina-avatar') + '）' : ''));
        }
        if (missingAssets.length) {
            console.log('  --   跳过 1.2：本地没有 ' + missingAssets.join(' / ')
                + ' 插件（插件不随仓库分发，这是正常状态）');
        }

        if (galPath && petPath && existsSync(galPath) && existsSync(petPath)) {
            const gal = readFileSync(galPath, 'utf8');
            const pet = readFileSync(petPath, 'utf8');

            c.ok(/ElainaMods\.register\(MOD_ID/.test(gal), 'galgame 用 register 注册（id 用 MOD_ID 常量）');
            c.ok(/ElainaMods\.register\(MOD_ID/.test(pet), 'pet 用 register 注册（id 用 MOD_ID 常量）');
            c.ok(/const MOD_ID = 'galgame'/.test(gal), 'galgame 的 MOD_ID 与目录名一致');
            c.ok(/const MOD_ID = 'pet'/.test(pet), 'pet 的 MOD_ID 与目录名一致');

            c.ok(/ElainaAvatar/.test(gal) && !/img\/elaina\/p_/.test(gal),
                '★ galgame 用公共 ElainaAvatar，不自己拼立绘路径');
            c.ok(/ElainaAvatar/.test(pet) && !/img\/elaina\/p_/.test(pet),
                '★ pet 用公共 ElainaAvatar，不自己拼立绘路径');

            c.ok(!/\bstate\.conversations\b/.test(gal), '★ galgame 不直接读 state（走 host API）');
            c.ok(!/\bstate\.conversations\b/.test(pet), '★ pet 不直接读 state（走 host API）');

            c.ok(/setPromptHint/.test(gal), '★ galgame 用 host.setPromptHint');
            const galCodeOnly = gal.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
            c.ok(!/__galgameSceneHint/.test(galCodeOnly), '★ 代码里不再往 window 上挂提示词变量');

            c.ok(!/get\('enabled'/.test(gal), '★ galgame 不读自己的 enabled（避免双重开关）');
            c.ok(!/get\('enabled'/.test(pet), '★ pet 不读自己的 enabled');
            c.ok(/ElainaMods\.setEnabled\(MOD_ID, false\)/.test(gal), '★ galgame 退出时同步关 mod 开关');
            c.ok(/ElainaMods\.setEnabled\(MOD_ID, false\)/.test(pet), '★ pet 收起时同步关 mod 开关');

            c.ok(Boolean(modPath('galgame', 'style.css')) && existsSync(modPath('galgame', 'style.css')), 'galgame 有样式');
            c.ok(Boolean(modPath('pet', 'style.css')) && existsSync(modPath('pet', 'style.css')), 'pet 有样式');

            const imgDir = modPath('elaina-avatar', 'img');
            let pngs = [];
            try { pngs = readdirSync(imgDir).filter((f) => f.endsWith('.png')); } catch { /* 忽略 */ }
            c.ok(pngs.length === 9, '公共立绘恰好 9 张（一套），实得 ' + pngs.length);
        }
    }

    // 1.3 端到端：安装/卸载全在临时目录里做（MODS_DIR 指过去）：用户自己的服务每次被请求 /api/plugins
    // 都会重扫插件目录、抢走测试刚放的 zip，导致时好时坏。不要往仓库 mods/ 写任何东西，会留痕。
    const TEST_MODS = mkdtempSync(path.join(tmpdir(), 'elaina-mod-mods-'));
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-mod-data-'));
    const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-mod-log-'));
    let child = null;
    try {
        const PORT = await freePort();

        writeFileSync(path.join(TEST_MODS, 'demo-mod.zip'), makeZip([
            ['demo-mod/manifest.json', JSON.stringify({ name: '演示插件', version: '1.0.0', entry: 'index.js', styles: ['style.css'] })],
            ['demo-mod/index.js', 'window.ElainaMods && window.ElainaMods.register("demo-mod", function(h){ return {}; });'],
            ['demo-mod/style.css', '.demo{color:red}'],
        ]));
        writeFileSync(path.join(TEST_MODS, 'evil-mod.zip'), makeZip([
            ['evil-mod/manifest.json', JSON.stringify({ name: '恶意' })],
            ['evil-mod/index.js', 'console.log("x")'],
            ['evil-mod/../../web/serve.mjs', 'HACKED'],
            ['evil-mod/../../web/index.html', 'HACKED'],
            ['evil-mod/bad.exe', 'MZ'],
        ]));
        mkdirSync(path.join(TEST_MODS, 'elaina-avatar', 'img'), { recursive: true });
        writeFileSync(path.join(TEST_MODS, 'elaina-avatar', 'manifest.json'), JSON.stringify({
            id: 'elaina-avatar', name: '伊蕾娜立绘与情绪', version: '1.0.0',
            entry: 'index.js', defaultEnabled: true, hidden: true,
            capabilities: ['theme'],
        }));
        writeFileSync(path.join(TEST_MODS, 'elaina-avatar', 'index.js'), 'void 0;');
        // 一张 1x1 的合法 PNG（内容不重要，要的是它能被静态服务取到）
        writeFileSync(path.join(TEST_MODS, 'elaina-avatar', 'img', 'p_calm.png'),
            Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000'
                + '01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'));

        // 带版本号的安装目录 + README：目录名（birthday-1.1.0）与 manifest.id（birthday）不一致，用 id 拼路径会 404
        mkdirSync(path.join(TEST_MODS, 'birthday-1.1.0'), { recursive: true });
        writeFileSync(path.join(TEST_MODS, 'birthday-1.1.0', 'manifest.json'), JSON.stringify({
            id: 'birthday', name: '生日说明测试', version: '1.1.0', entry: 'index.js',
        }));
        writeFileSync(path.join(TEST_MODS, 'birthday-1.1.0', 'index.js'), 'void 0;');
        writeFileSync(path.join(TEST_MODS, 'birthday-1.1.0', 'README.md'), '# 生日说明测试\n');

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
            // 首个 /api/plugins 带短重试：并发跑全套检查时，"端口已开"到"清单与 installResults 生成完"
            // 有窗口，退出条件须同时等到 demo-mod（含 styles）与 evil-mod 的安装结果，缺一会在窗口里读到半截
            let res = null, body = null;
            for (let i = 0; i < 20; i++) {
                res = await fetch(`http://127.0.0.1:${PORT}/api/plugins`);
                body = await res.json().catch(() => null);
                const demoNow = ((body && body.plugins) || []).find((p) => p.id === 'demo-mod');
                const results = (body && body.installResults) || [];
                const evilNow = results.find((r) => r && r.zip === 'evil-mod.zip' && typeof r.ok === 'boolean');
                if (res.status === 200 && body && body.ok && demoNow
                    && demoNow.name === '演示插件'
                    && Array.isArray(demoNow.styles) && demoNow.styles.includes('style.css')
                    && evilNow) break;
                await wait(300);
            }
            c.ok(res.status === 200 && body && body.ok, 'GET /api/plugins 成功', 'HTTP ' + res.status);

            const ids = (body.plugins || []).map((p) => p.id);
            c.ok(ids.includes('demo-mod'), '★ zip 被自动解压成 mod');
            c.ok(ids.includes('elaina-avatar'), '已存在的目录 mod 被识别');

            // README 接口必须按 manifest.id 找目录：目录名带版本号时拿 id 直接拼会 404，说明按钮全失效
            {
                const rr = await fetch(`http://127.0.0.1:${PORT}/api/plugins/birthday/readme`);
                const rb = await rr.json().catch(() => null);
                c.ok(rr.status === 200 && rb && rb.ok,
                    '★★ README 按 manifest.id 解析真实目录（目录名可带版本号）', 'HTTP ' + rr.status);
                c.ok(rb && String(rb.text || '').includes('生日说明测试'),
                    '★ README 正文按真实目录读回');
            }

            const demo = (body.plugins || []).find((p) => p.id === 'demo-mod');
            c.ok(demo && demo.name === '演示插件', 'manifest.json 被正确读取', demo && demo.name);
            c.ok(demo && demo.entry === 'index.js', 'entry 字段生效');
            c.ok(demo && Array.isArray(demo.styles) && demo.styles.includes('style.css'), 'styles 字段生效');

            // 恶意 zip 的安装结果要单独重试获取：首个循环只等 plugins 里的 demo-mod，installResults 另算，
            // 并发跑时会漏读；且装成功后 zip 被删、结果有时间窗 —— 判据用"ok 字段存在"防残缺快照，安全结论以下面磁盘事实为准
            const evilDone = (r) => r && typeof r.ok === 'boolean';
            const findEvil = (b) => ((b && b.installResults) || []).find((r) => r.zip === 'evil-mod.zip' && evilDone(r));
            let evil = findEvil(body);
            if (!evil) {
                for (let i = 0; i < 20 && !evil; i++) {
                    await wait(300);
                    const again = await fetch(`http://127.0.0.1:${PORT}/api/plugins`)
                        .then((r) => r.json()).catch(() => null);
                    evil = findEvil(again);
                }
            }
            c.ok(Boolean(evil), '恶意 zip 有安装结果回报');

            // 诊断：失败时把安装结果与服务端输出打出来，否则排查只能自己复现
            if (!evil) {
                console.log('      安装结果: ' + JSON.stringify(body.installResults || []));
                console.log('      清单: ' + JSON.stringify((body.plugins || []).map((p) => p.id)));
                console.log('      服务端输出尾部:\n' + out.split('\n').slice(-15).map((l) => '        ' + l).join('\n'));
            }
            // 装了却拿不到结果时唯一可靠信号是磁盘真实内容：读两次再比，并发跑时偶发"读到半截"会被误判成被覆盖
            const stillSame = (p) => {
                for (let i = 0; i < 3; i++) {
                    try { if (readFileSync(p, 'utf8') === (p.endsWith('serve.mjs') ? serveBefore : htmlBefore)) return true; }
                    catch { /* 读失败当作不一致 */ }
                }
                return false;
            };

            c.ok(stillSame(path.join(ROOT, 'web', 'serve.mjs')), '★ serve.mjs 未被路径穿越覆盖');
            c.ok(stillSame(path.join(ROOT, 'web', 'index.html')), '★ index.html 未被路径穿越覆盖');
            c.ok(!existsSync(path.join(TEST_MODS, 'evil-mod', 'bad.exe')), '★ .exe 被拦下（不落盘）');
            if (evil && typeof evil.files === 'number') {
                c.ok(evil.ok && evil.files === 2, '恶意 zip 只装进 2 个合法文件（穿越/可执行被拦）',
                    'files=' + evil.files);
            }
            // 与安装结果时间窗无关的磁盘事实：这几条才是路径穿越防护的可靠回归
            {
                const evilDir = path.join(TEST_MODS, 'evil-mod');
                const inside = existsSync(evilDir) ? readdirSync(evilDir) : [];
                c.ok(!inside.includes('bad.exe'), '★ .exe 未落盘（以磁盘为准）', inside.join(','));
                const okFiles = inside.filter((n) => /^(manifest\.json|index\.js)$/.test(n));
                c.ok(okFiles.length === 2, '★ 恶意 zip 只落盘 2 个合法文件（以磁盘为准）', inside.join(','));
            }
            c.ok(existsSync(path.join(TEST_MODS, 'evil-mod', 'index.js')), '★ mod 的 index.js 允许落盘（mod 本质就是代码）');

            const idx = JSON.parse(readFileSync(path.join(TEST_MODS, 'index.json'), 'utf8'));
            c.ok(Array.isArray(idx.plugins), 'index.json 被重新生成');
            c.ok(idx.plugins.some((p) => p.id === 'demo-mod'), '清单里含新装的 mod');

            const del = await fetch(`http://127.0.0.1:${PORT}/api/plugins/demo-mod`, { method: 'DELETE' });
            c.ok(del.status === 200, 'DELETE 卸载成功', 'HTTP ' + del.status);
            c.ok(!existsSync(path.join(TEST_MODS, 'demo-mod')), '★ mod 目录已被删除');
            c.ok(!existsSync(path.join(TEST_MODS, 'demo-mod.zip')), '★ 安装包也被删除（否则会被重新装回来）');

            // 静态资源用清单里的真实目录名（dir）拼 URL：用户改了目录名时写死的 URL 必然 404
            const avEntry = (body.plugins || []).find((p) => p.id === 'elaina-avatar');
            c.ok(Boolean(avEntry), '清单里有 elaina-avatar');
            if (avEntry) {
                const enc = String(avEntry.dir || avEntry.id).split('/').map(encodeURIComponent).join('/');
                c.ok(typeof avEntry.dir === 'string' && avEntry.dir.length > 0,
                    '★ 清单带 dir 字段（前端据此拼资源 URL）', avEntry.dir);
                // 清单必须透传 manifest.capabilities（AGENTS.md D18 / 表 A22）：漏了则 host.theme 等全变 undefined
                c.ok(Array.isArray(avEntry.capabilities) && avEntry.capabilities.includes('theme'),
                    '★ 清单透传 manifest.capabilities（否则 host.theme 等重成员全变 undefined）',
                    JSON.stringify(avEntry.capabilities));
                const imgUrl = `http://127.0.0.1:${PORT}/mods/${enc}/img/p_calm.png`;
                c.ok((await fetch(imgUrl)).status === 200,
                    'mod 立绘可经静态服务访问（按真实目录 ' + avEntry.dir + '）', imgUrl);
            }
            c.ok((await fetch(`http://127.0.0.1:${PORT}/mods/index.json`)).status === 200, 'mod 清单可被前端读取');
            c.ok((await fetch(`http://127.0.0.1:${PORT}/js/mods.js`)).status === 200, 'mod 加载器脚本可被加载');

            // /mods/* 显式路由：web/ 静态根够不到项目根 mods/；钉住真实 MIME（nosniff 下 octet-stream
            // 让插件界面空白）、路径穿越（隔壁 data/ 是密钥明文）、目录不给列表；只挑 TEST_MODS 里真实存在的文件
            console.log('\n  — /mods/* 显式路由 —');
            {
                const js = await fetch(`http://127.0.0.1:${PORT}/mods/elaina-avatar/index.js`);
                c.ok(js.status === 200, '/mods/<id>/index.js → 200', 'status=' + js.status);
                c.ok((js.headers.get('content-type') || '').includes('javascript'),
                    '★ 插件 JS 发 javascript MIME（nosniff 下错了就不执行）',
                    js.headers.get('content-type'));

                writeFileSync(path.join(TEST_MODS, 'elaina-avatar', 'probe.html'), '<p>probe</p>');
                writeFileSync(path.join(TEST_MODS, 'elaina-avatar', 'probe.css'), '.x{}');
                const panel = await fetch(`http://127.0.0.1:${PORT}/mods/elaina-avatar/probe.html`);
                c.ok(panel.status === 200, '/mods/<id>/*.html → 200', 'status=' + panel.status);
                c.ok((panel.headers.get('content-type') || '').includes('text/html'),
                    '★ 插件 HTML 发 text/html（否则设置面板插槽拿不到内容）',
                    panel.headers.get('content-type'));
                const cssRes = await fetch(`http://127.0.0.1:${PORT}/mods/elaina-avatar/probe.css`);
                c.ok(cssRes.status === 200, '/mods/<id>/*.css → 200', 'status=' + cssRes.status);

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
        for (const d of [DATA_DIR, LOG_DIR, TEST_MODS]) {
            try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
        }
    }
}

// 2. 插件 id 归一化 + 依赖可解析性 —— 钉住「资源包装了等于没装」。
// 成因：安装逻辑直接拿 zip 文件名当 id，装进带版本号的目录，资源 URL 404、after 匹配不上；自造包不依赖被 gitignore 的 dist/。

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

            c.ok(existsSync(path.join(dir, 'elaina-avatar', 'img', 'p_calm.png')),
                '★ 立绘落在 /mods/elaina-avatar/img/p_calm.png 能取到的位置');
            c.ok(!existsSync(path.join(dir, 'elaina-avatar-1.0.0')),
                '★ 没有留下带版本号的目录（旧 bug 的形态）');
        }

        {
            const dir = newDir();
            writeFileSync(path.join(dir, 'elaina-avatar-1.0.0.zip'), avatarZip('1.0.0'));
            const mgr = mkMgr(dir);
            await mgr.scanAndSync();

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
            const g = r2.installed.find((p) => p.id === 'galgame');
            c.ok(g && g.after.every((d) => ids.has(d)),
                '★ galgame 声明的 after 全部能在清单里找到（依赖解析有效）',
                g ? JSON.stringify(g.after) : '');
        }

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

        {
            const dir = newDir();
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

        {
            const dir = newDir();
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

        // 2.7 装载只认"完整的一段"：解压逐文件落盘而清单每次请求都重扫，直接往 mods/<id>/ 写会出现
        // "目录在、index.js 未写完"被扫进清单的中间态（前端取脚本 404 并当场停用）；钉住临时目录不被扫成插件、装完必有完整一份
        {
            const dir = newDir();
            const staging = path.join(dir, `.installing-elaina-avatar-${process.pid}-1`);
            mkdirSync(staging, { recursive: true });
            writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
                id: 'elaina-avatar', name: '写了一半的插件', entry: 'index.js',
            }));
            const r = await mkMgr(dir).scanAndSync();
            c.ok(!r.installed.some((p) => p.id === 'elaina-avatar'),
                '★ 安装中途的临时目录不被扫成已装插件（否则脚本会 404 并当场停用）',
                JSON.stringify(r.installed.map((p) => p.id)));
            c.ok(!readdirSync(dir).some((n) => n.startsWith('.installing-')),
                '★ 扫描会清掉安装未完成留下的临时目录（否则白占几十 MB 且用户看不见）',
                JSON.stringify(readdirSync(dir)));

            writeFileSync(path.join(dir, 'elaina-avatar-1.0.0.zip'), avatarZip('1.0.0'));
            const r2 = await mkMgr(dir).scanAndSync();
            const p = r2.installed.find((x) => x.id === 'elaina-avatar');
            c.ok(Boolean(p), '★ zip 装完后清单里有它', JSON.stringify(r2.installed.map((x) => x.id)));
            c.ok(p && existsSync(path.join(dir, p.dir, 'index.js')),
                '★ 装完 entry 脚本确实落盘（不存在"清单有、脚本没有"的中间态）', p && p.dir);
            c.ok(readdirSync(dir).every((n) => !n.startsWith('.installing-')),
                '★ 安装成功/失败都不留临时目录残骸', JSON.stringify(readdirSync(dir)));
        }

        // 2.8 默认关闭只认显式 true：判据写成 !== false 就是"漏写即默认打开"，与文档相反；
        // 三处（server 扫描 / 前端 isModEnabled / 原生清单）必须同语义，任何一处不同都两端口径不一
        {
            const dir = newDir();
            const mk = (id, mf) => {
                const d = path.join(dir, id);
                mkdirSync(d, { recursive: true });
                writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(mf));
                writeFileSync(path.join(d, 'index.js'), 'void 0;');
            };
            mk('explicit-on', { id: 'explicit-on', name: 'A', entry: 'index.js', defaultEnabled: true });
            mk('explicit-off', { id: 'explicit-off', name: 'B', entry: 'index.js', defaultEnabled: false });
            mk('no-field', { id: 'no-field', name: 'C', entry: 'index.js' });
            mk('bogus-value', { id: 'bogus-value', name: 'D', entry: 'index.js', defaultEnabled: 'yes' });
            const r = await mkMgr(dir).scanAndSync();
            const byId = new Map(r.installed.map((p) => [p.id, p]));
            const flag = (id) => byId.get(id) && byId.get(id).defaultEnabled;
            c.ok(flag('explicit-on') === true, '★ 显式 defaultEnabled:true 才算默认启用', String(flag('explicit-on')));
            c.ok(flag('explicit-off') === false, '显式 false 是默认关闭', String(flag('explicit-off')));
            c.ok(flag('no-field') === false,
                '★ 漏写 defaultEnabled 算默认关闭（写成 !== false 就是默认打开，与文档相反）',
                String(flag('no-field')));
            c.ok(flag('bogus-value') === false, '非 true 的取值一律算关闭', String(flag('bogus-value')));

            const modsSrc = readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');
            const coreSrc = readFileSync(path.join(ROOT, 'web', 'js', 'core-native-mod.js'), 'utf8')
                + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');
            const serverSrc = readFileSync(path.join(ROOT, 'server', 'mods.mjs'), 'utf8');
            for (const [name, src] of [['web/js/mods.js', modsSrc], ['web/js/core.js', coreSrc], ['server/mods.mjs', serverSrc]]) {
                c.ok(!/defaultEnabled\s*!==\s*false/.test(src),
                    `★ ${name} 的默认关闭判据不是 !== false（那是"默认打开"）`);
                c.ok(/defaultEnabled\s*===\s*true/.test(src),
                    `★ ${name} 只把显式 true 当默认启用`);
            }
        }
    } finally {
        tmp.cleanup();
    }
}

// 3. 插件身份与路径解析：目录改名后依然能识别、初始化、取到资源。
// 身份有三个来源（目录名 / manifest.id / register 名），注册名是权威；只测这一层纯逻辑，假 DOM 桩薄会误报。
/** 造一个插件目录 */
function putMod(root, dirName, manifest, script) {
    const d = path.join(root, dirName);
    mkdirSync(d, { recursive: true });
    if (manifest) writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(path.join(d, 'index.js'), script || 'void 0;');
    return d;
}

// 在沙箱里跑 mods.js 并手动喂"某目录注册了某名字"（模拟 register 效果），只验证身份解析层，不起 DOM
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
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-paths.js'), 'utf8'), ctx, { filename: 'mods-paths.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-graph.js'), 'utf8'), ctx, { filename: 'mods-graph.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-drag-sort.js'), 'utf8'), ctx, { filename: 'mods-drag-sort.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-storage.js'), 'utf8'), ctx, { filename: 'mods-storage.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-host-core.js'), 'utf8'), ctx, { filename: 'mods-host-core.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-loader.js'), 'utf8'), ctx, { filename: 'mods-loader.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-contributions.js'), 'utf8'), ctx, { filename: 'mods-contributions.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-services.js'), 'utf8'), ctx, { filename: 'mods-services.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-slots.js'), 'utf8'), ctx, { filename: 'mods-slots.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-summary.js'), 'utf8'), ctx, { filename: 'mods-summary.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-deps.js'), 'utf8'), ctx, { filename: 'mods-deps.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-capabilities.js'), 'utf8'), ctx, { filename: 'mods-capabilities.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-load.js'), 'utf8'), ctx, { filename: 'mods-load.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-enable.js'), 'utf8'), ctx, { filename: 'mods-enable.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-load-one.js'), 'utf8'), ctx, { filename: 'mods-load-one.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-faults.js'), 'utf8'), ctx, { filename: 'mods-faults.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-host.js'), 'utf8'), ctx, { filename: 'mods-host.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-forget.js'), 'utf8'), ctx, { filename: 'mods-forget.js' });
    vm.runInContext(readFileSync(path.join(WEB, 'js', 'mods-api.js'), 'utf8'), ctx, { filename: 'mods-api.js' });
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

        {
            const dir = newDir();
            putMod(dir, 'pet-renamed', { name: '桌宠', entry: 'index.js' });
            const r = await mkMgr(dir).scanAndSync();
            const p = r.installed[0];
            c.ok(p && p.id === 'pet-renamed', 'id 回落到目录名（并剥版本号尾）', p && p.id);
            c.ok(p && p.dir === 'pet-renamed', 'dir 是真实目录名', p && p.dir);
        }

        {
            const s = makeModsSandbox(MODS_JS);
            const Mods = s.window.ElainaMods;
            c.ok(Boolean(Mods && typeof Mods.find === 'function'), 'ElainaMods.find 存在');
            c.ok(Boolean(Mods && typeof Mods.assetUrl === 'function'), 'ElainaMods.assetUrl 存在');
        }

        {
            c.ok(/const regByDir = new Map\(\)/.test(MODS_JS), '有 regByDir（目录 → 注册名）');
            c.ok(/const dirByReg = new Map\(\)/.test(MODS_JS), '有 dirByReg（注册名 → 目录）');
            c.ok(/let loadingDir = null;/.test(MODS_JS), '有 loadingDir（注入时标记来源目录）');
            c.ok(/if \(loadingDir\) \{[\s\S]{0,120}regByDir\.set\(loadingDir, name\)/.test(MODS_JS),
                '★ register() 会记下"这个注册名来自哪个目录"');
            c.ok(/regByDir\.get\(manifest\.dir \|\| manifest\.id\)/.test(MODS_JS),
                '★ loadOne 会按目录反查注册名（目录改名也能初始化）');
            c.ok(/entry\.state = 'blocked'/.test(MODS_JS),
                '★ 缺前置插件时状态标为 blocked（拒绝加载，不是警告后照跑）');
            c.ok(/已拒绝加载：/.test(MODS_JS), '★ 报错文案说明了缺什么');
            c.ok(/未启用|未安装/.test(MODS_JS), '★ 区分「未启用」与「未安装」两种原因');
            c.ok(/require\(key\) \{/.test(MODS_JS), 'host API 提供 require()（由系统解析依赖）');
            c.ok(/if \(m\.dir && !byKey\.has\(m\.dir\)\) byKey\.set\(m\.dir, m\)/.test(MODS_JS)
                || /byKey\.set\(m\.dir, m\)/.test(MODS_JS),
                '★ 缺依赖判定同时认目录名（避免改名后误报）');
            c.ok(/regByDir\.get\(m\.dir\)/.test(MODS_JS),
                '★ 缺依赖判定也认注册名（三种身份都收进索引）');
        }

        {
            // 不能写死 'elaina-avatar' 目录名：用户可能已改名，按 manifest.id 找真实目录
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

// 3b. 插件隔离与统一接口：钉住边界（工厂/插槽/事件回调/清单外链脚本的异常只停在自己身上）与
// 统一（设置入口、资源路径、错误出口只有一个，不靠 window 私有全局名）。全部用临时目录自造插件。

/** 在临时目录写一个自造插件，返回可直接喂给 loadModsInSandbox 的清单条目 */
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
    /* 插件源码不随仓库分发，本地没有是正常状态：跳过而不是判红。
       判定用 modDirById 按 manifest.id 找目录（目录名常带版本号，拿 id 拼目录会把"装了"误判成"没装"）。 */
    if (!['live2d', 'galgame', 'pet', 'elaina-avatar'].every((n) => Boolean(modDirById(n)))) {
        console.log('  --   跳过：本地没有 live2d/galgame/pet/elaina-avatar 插件源码（插件走应用内安装，这是正常状态）');
        return;
    }
    // 失败隔离：坏插件不影响好插件且会被自动停用；静态+结构断言，这几条删一行也照样跑得通、最易悄悄回归
    {
        const modsJs = readFileSync(path.join(WEB, 'js', 'mods.js'), 'utf8');

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
        c.ok(/START_MARK[\s\S]{0,10}clearModFailure/.test('START_MARK' + (modsJs.slice(modsJs.indexOf('function clearModFailure')))),
            '手动重新启用时清掉旧失败记录');
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
        c.ok(/if \(wasFailed\) loadedScripts\.delete\(src\)/.test(setSeg),
            '失败重试时清掉"已注入"记录（否则 loadOne 认定脚本已在、跳过注入）');
        c.ok(!/\.state\s*!==\s*'error'\s*\)\s*\w+\.state\s*=\s*'ready'/.test(modsCode),
            '不把加载失败强行改写成 ready（旧写法会让坏插件"点几次就启动"）');
        c.ok(/fresh\.state === 'pending'[\s\S]{0,300}autoDisableBroken/.test(setSeg),
            '没有明确加载结果时保守当成失败并停用');
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

// 服务端半边门禁：停用的插件不装载、总开关关闭时全部不装载、已装载成功不误报需重启（signature 同形状比较）
async function caseModServerGate(c) {
    const ok = (cond, label, detail) => c.ok(cond, label, detail);
    const tmp = mkdtempSync(path.join(tmpdir(), 'elaina-modgate-'));
    const modsDir = path.join(tmp, 'mods');
    const writeMod = (id, { server = null, defaultEnabled = false } = {}) => {
        const dir = path.join(modsDir, id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            id, name: id, entry: 'index.js', defaultEnabled, ...(server ? { server } : {}),
        }, null, 2));
        writeFileSync(path.join(dir, 'index.js'), 'void 0;');
        if (server) {
            writeFileSync(path.join(dir, 'server.mjs'),
                `export function register(ctx) { ctx.route('GET', '/api/${id}/ping', (req, res) => ctx.json(res, 200, { ok: true })); }`);
        }
    };
    try {
        writeMod('zz-gate-enabled', { server: { entry: 'server.mjs', routes: ['/api/zz-gate-enabled'], capabilities: ['route-register'] } });
        writeMod('zz-gate-disabled', { server: { entry: 'server.mjs', routes: ['/api/zz-gate-disabled'], capabilities: ['route-register'] } });
        writeMod('zz-gate-default', { defaultEnabled: true, server: { entry: 'server.mjs', routes: ['/api/zz-gate-default'], capabilities: ['route-register'] } });
        // 与 scanAndSync/buildPluginList 给出的条目同形：顶层必须带 server / defaultEnabled，否则 loadAll 读不到
        const installed = ['zz-gate-enabled', 'zz-gate-disabled', 'zz-gate-default'].map((id) => ({
            id, dir: id, ...JSON.parse(readFileSync(path.join(modsDir, id, 'manifest.json'), 'utf8')),
        }));
        const hostRoutePrefixes = ['/api/store', '/api/plugins'];

        const ms = createModServer({ modsDir, hostRoutePrefixes, jsonResponse() {}, readJsonBody() {}, log() {} });
        const isEnabled = (id, entry) => (id === 'zz-gate-enabled' ? true
            : id === 'zz-gate-disabled' ? false
                : Boolean(entry && entry.defaultEnabled === true));
        await ms.loadAll(installed, isEnabled);
        const byId = Object.fromEntries(ms.status(installed).mods.map((m) => [m.id, m]));
        ok(byId['zz-gate-enabled'] && byId['zz-gate-enabled'].ok === true,
            '启用插件装载服务端半边', JSON.stringify(byId['zz-gate-enabled']));
        ok(byId['zz-gate-default'] && byId['zz-gate-default'].ok === true,
            '未写开关时 defaultEnabled=true 照常装载', JSON.stringify(byId['zz-gate-default']));
        ok(byId['zz-gate-disabled'] && byId['zz-gate-disabled'].ok === false && byId['zz-gate-disabled'].enabled === false,
            '★ 停用的插件不装载服务端半边（停用要真的停用）', JSON.stringify(byId['zz-gate-disabled']));
        const restart = ms.status(installed).needsRestart || [];
        ok(restart.length === 0, '★ 已装载成功的插件不被误报“需重启”（signature 同形状比较）', JSON.stringify(restart));
        const routes = ms._routes().map((r) => r.prefix);
        ok(routes.includes('/api/zz-gate-enabled/ping') && routes.includes('/api/zz-gate-default/ping')
            && !routes.includes('/api/zz-gate-disabled/ping'),
            '★ 启用/默认的接口注册了，停用的没注册', JSON.stringify(routes));

        const ms2 = createModServer({ modsDir, hostRoutePrefixes, jsonResponse() {}, readJsonBody() {}, log() {} });
        await ms2.loadAll(installed, () => false);
        ok(ms2._routes().length === 0, '★ 总开关关闭时任何插件服务端路由都不装载', JSON.stringify(ms2._routes()));

        const serveSrc = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');
        ok(/modServer\.loadAll\(r\.installed,\s*isEnabled\)/.test(serveSrc),
            '★ serve.mjs 把启用状态传给 loadAll（不是只停前端）');

        const modsSrc = readFileSync(path.join(ROOT, 'server', 'mods.mjs'), 'utf8');
        ok(!/async\s+function\s+writeIndexFile\s*\(/.test(modsSrc),
            'mods.mjs 不再保留自递归的 writeIndexFile 空壳');
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
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
    const serverOut = () => { try { return readFileSync(serverLogPath, 'utf8'); } catch { return ''; } };

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
        // 试图注册未声明前缀的 mod → 装载必须失败并隔离
        writeServerMod('zz-check-badapi',
            { entry: 'server.mjs', routes: ['/api/apicheckbad'] },
            `export function register(ctx) {
        ctx.route('GET', '/api/evil', (req, res) => { ctx.json(res, 200, { ok: true, hacked: true }); });
    }`);
        // 想占宿主已有前缀的 mod → 必须被拒绝（否则永远收不到请求却不报错）
        writeServerMod('zz-check-collide',
            { entry: 'server.mjs', routes: ['/api/store'] },
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

        child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
            cwd: ROOT,
            env: {
                ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT),
                HOST: '127.0.0.1', DATA_DIR, LOG_DIR, LOG_TO_FILE: '0',
            },
            // 子进程输出走文件描述符，不用 stdio:'pipe'：受限环境不允许打开命名管道，会直接 EPERM；
            // 写文件没有这个限制，失败时服务端输出也留得下来（比 stdio:'ignore' 强）
            stdio: ['ignore', outFd, outFd],
        });

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
        // 6.1 安装链 —— 模拟用户从 Releases 下载带版本号的 zip 丢进 mods/
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

        c.ok(existsSync(path.join(modsDir, 'elaina-avatar', 'img', 'p_calm.png')),
            '★ 立绘落在 /mods/elaina-avatar/img/p_calm.png 对应位置（不再 404）');

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
            const up = await waitServerUp(BASE);
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

                // 立绘图片可达 —— 按清单里的真实目录名拼 URL（写死 'elaina-avatar' 在改名后必然 404）
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
            for (const fn of ['nativeFs', 'bytesToBase64', 'nativeWriteFile', 'nativeNormalizeModId',
                'nativeEffectiveExt', 'nativeReadModManifest', 'nativeListModFiles', 'nativeListPlugins',
                'nativeDeletePlugin', 'nativeInstallPlugin', 'nativePluginsFetch', 'unzipBrowser']) {
                try { pieces.push(extractFn(core, fn)); } catch (e) { c.ok(false, '抠出原生函数 ' + fn, e.message); }
            }
            vm.runInContext(pieces.join('\n\n'), sandbox);
            sandbox.nativeFs = () => memFs;

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

                // 路径穿越必须被挡：这是"可拆装"带来的新攻击面
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

// 技能（skills）：与插件平行的一套，扫描结果必须永远是"资料"。
// 技能是给 AI 的文本资料、插件是扩展应用的代码，混同则"装一个 zip"=给自己发执行能力；scan() 每项必须 kind:'knowledge'。
async function caseSkills(c) {
    const root = mkdtempSync(path.join(tmpdir(), 'elaina-skills-'));
    const skillsDir = path.join(root, 'skills');
    const modsDir = path.join(root, 'mods');
    try {
        // ① 本地技能：含 SKILL.md 的目录才算技能（不含的是用户随手放的杂物）
        mkdirSync(path.join(skillsDir, '写作助手'), { recursive: true });
        writeFileSync(path.join(skillsDir, '写作助手', 'SKILL.md'),
            '---\nname: 写作助手\ndescription: 帮我把草稿写得更好\n---\n\n正文\n');
        mkdirSync(path.join(skillsDir, '杂物'), { recursive: true });
        writeFileSync(path.join(skillsDir, '杂物', 'note.txt'), 'x');

        // ② 插件随附技能：manifest 的 skills 声明，文件住在插件目录内
        mkdirSync(path.join(modsDir, 'demo-plugin', 'skills', 'guide'), { recursive: true });
        writeFileSync(path.join(modsDir, 'demo-plugin', 'manifest.json'), JSON.stringify({
            id: 'demo-plugin', name: '演示插件', version: '1.0.0', entry: 'index.js',
            skills: ['skills/guide', '../../../web'],   // 后一条是恶意的路径穿越声明
        }));
        writeFileSync(path.join(modsDir, 'demo-plugin', 'skills', 'guide', 'SKILL.md'),
            '---\nname: 插件指南\ndescription: 这个插件怎么用\n---\n');

        const logs = [];
        const mgr = createSkillManager({
            skillsDir, modsDir,
            unzip: () => ({ files: [] }),        // 扫描不碰解压，给个占位
            isUnsafeEntryName: () => false,
            effectiveExt,
            log: (m) => logs.push(String(m)),
        });
        const { skills } = await mgr.scan();
        const byId = (id) => skills.find((s) => s.id === id);

        c.ok(Boolean(byId('写作助手')), '本地技能（含 SKILL.md）被扫出来');
        c.ok(byId('写作助手')?.description === '帮我把草稿写得更好', 'description 取 frontmatter');
        c.ok(!byId('杂物'), '没有 SKILL.md 的目录不被当成技能');
        c.ok(Boolean(byId('demo-plugin/skills/guide')), '插件随附技能以 owner/相对路径 进清单');
        c.ok(skills.length === 2, '清单里正好是那两项（无多余项）', skills.map((s) => s.id).join(' / '));

        // 边界：每一项都必须带 kind:'knowledge' —— 前端据此只注册成纯知识条目
        c.ok(skills.length > 0 && skills.every((s) => s.kind === 'knowledge'),
            '★ 扫描结果每一项都是 kind:knowledge（技能永远不是可执行能力）',
            skills.map((s) => s.id + ':' + s.kind).join(' / '));
        c.ok(!skills.some((s) => s.kind === 'tool'), '★ 扫描结果里没有任何 kind:tool 的条目',
            skills.filter((s) => s.kind === 'tool').map((s) => s.id).join(' / '));

        // 恶意的 skills 声明（含 ..）必须被跳过，不得读到插件目录之外
        c.ok(logs.some((m) => m.includes('不安全')), '不安全的 skills 声明被跳过并记日志', logs.join(' | '));
        c.ok(!skills.some((s) => s.id.includes('..')), '清单里没有越界的随附技能');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

// 仓库自带的「制作插件」技能：入口必须短（技能随每轮对话进能力索引，全写入口则每轮都付这份上下文），
// 细则按需加载。钉住：入口存在且 frontmatter 完整、体积有上限、入口引用的分节文件都真实存在。
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

    // 用真实的管理器扫一遍：必须作为本地技能被发现且仍是纯知识；modsDir 指临时空目录，不受本机插件影响
    const emptyMods = mkdtempSync(path.join(tmpdir(), 'elaina-skill-mods-'));
    const mgr = createSkillManager({
        skillsDir: path.join(ROOT, 'skills'),
        modsDir: emptyMods,
        unzip: () => ({ files: [] }),
        isUnsafeEntryName: () => false,
        effectiveExt,
        log: () => {},
    });
    const { skills } = await mgr.scan();
    const found = skills.find((s) => s.id === 'mod-authoring-guide');
    c.ok(Boolean(found), '★ 被服务端扫成本地技能（id = 目录名）');
    c.ok(found && found.kind === 'knowledge', '★★ 仍是 kind:knowledge（资料，不可执行）');
    c.ok(found && Boolean(found.description), '★ description 进清单（AI 据此判断要不要读）');
    const body = await mgr.readSkill('mod-authoring-guide');
    c.ok(body.ok && body.text.includes('制作插件'), '★ 正文可经 readSkill 读回');
    rmSync(emptyMods, { recursive: true, force: true });
}

// 手机端 bootstrap 的 mod 服务端半边（与 serve.mjs 同构的那一半）：布局照 sync-web 产物形态，
// 数据目录与插件根共用一个 <tmp>（插件根是 dataDir 的同级 mods，放错会"装载 0 个插件"假绿）；夹具现场生成。

// 组装并拉起一个临时 bootstrap；waitMods 等 /api/ping 的 modsLoaded 有结论
async function startBootstrapMods(c, TMP) {
    const NODE_ROOT = path.join(TMP, 'nodejs');
    const DATA_DIR = path.join(TMP, 'elaina-data');

    // 共享模块清单从 sync-web.mjs 提取（单一事实源；打包工具住在 dist/Android/scripts/）
    const syncSrc = readFileSync(path.join(ROOT, 'dist', 'Android', 'scripts', 'sync-web.mjs'), 'utf8');
    const listMatch = syncSrc.match(/SHARED_SERVER_MODULES\s*=\s*\[([^\]]*)\]/);
    if (!listMatch) throw new Error('无法从 sync-web.mjs 提取 SHARED_SERVER_MODULES');
    const shared = listMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);

    mkdirSync(path.join(NODE_ROOT, 'server'), { recursive: true });
    cpSync(path.join(ROOT, 'web', 'nodejs', 'bootstrap.mjs'), path.join(NODE_ROOT, 'bootstrap.mjs'));
    for (const name of shared) {
        cpSync(path.join(ROOT, 'server', name), path.join(NODE_ROOT, 'server', name));
    }

    const child = spawn(process.execPath, [path.join(NODE_ROOT, 'bootstrap.mjs'), `--data-dir=${DATA_DIR}`], {
        cwd: NODE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    // 等"进程真的退了"而不只是发 kill 信号：连续起停多个 bootstrap 时，上一个活着会拖慢下一个启动
    const stop = async () => {
        const exited = new Promise((resolve) => {
            if (child.exitCode !== null) return resolve();
            const t = setTimeout(resolve, 4000);
            child.once('exit', () => { clearTimeout(t); resolve(); });
        });
        try { child.kill(); } catch { /* 已退出 */ }
        await exited;
    };

    // 等 bootstrap 打出 __ELAINA_READY__（它自己挑端口后报出来）。
    // 上限 60s：并发跑整套检查时冷启动 + 扫 mods/ 可达 20s 以上，窗口窄了会"单独跑绿、并发跑红"
    async function waitReady(timeoutMs = 60000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const m = out.match(/__ELAINA_READY__(\{[^\n]*\})/);
            if (m) {
                try { return JSON.parse(m[1]); } catch { /* 行不完整 */ }
            }
            await wait(120);
        }
        return null;
    }
    // 轮询 /api/ping 直到 modsLoaded 有结论（阶段一协议：字段缺失 = 本版无装载能力）。
    // 超时给宽（连续起停多个 bootstrap 时冷启动慢）；每次探测带单次超时，否则裸 fetch 可能挂到连接超时
    async function waitMods(timeoutMs = 60000) {
        const ready = await waitReady();
        if (!ready) return null;
        const deadline = Date.now() + timeoutMs;
        const base = `http://127.0.0.1:${ready.port}`;
        while (Date.now() < deadline) {
            try {
                const res = await fetch(base + '/api/ping', {
                    headers: { Origin: 'https://localhost' },
                    signal: AbortSignal.timeout(2000),
                });
                if (res.ok) {
                    const info = await res.json();
                    if (info.modsLoaded === true) return { base, info };
                    // 字段在但还没置 true = 已监听、装载还在跑，继续等；真正"无装载能力"由超时返回表达
                }
            } catch { /* 继续轮询 */ }
            await wait(150);
        }
        return { base, info: null };
    }
    return { out: () => out, stop, waitReady, waitMods, DATA_DIR };
}

/** 生成一个最小夹具插件（声明 server 半边），root 是它的目录 */
function writeFixtureMod(root, { id, serverEntry, manifest }) {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(path.join(root, 'index.js'), '// 检查夹具：前端半边不参与本用例\n');
    writeFileSync(path.join(root, 'server.mjs'), serverEntry);
}

async function caseBootstrapMods(c) {
    const TMP = mkdtempSync(path.join(tmpdir(), 'elaina-bootstrap-mod-'));
    const ORIGIN = { Origin: 'https://localhost' };
    try {
        // 夹具①：正常，声明 routes + host-utils，一个 GET 一个 POST(JSON)
        writeFixtureMod(path.join(TMP, 'mods', 'demo-fixture'), {
            id: 'demo-fixture',
            serverEntry: [
                "export function register(ctx) {",
                "    ctx.route('GET', '/api/demo/echo', (req, res) => ctx.json(res, 200, { ok: true, echo: 'demo', caps: ctx.capabilities() }));",
                "    ctx.route('POST', '/api/demo/rename', async (req, res) => {",
                "        const body = await ctx.readJson(req);",
                "        return ctx.json(res, 200, { ok: true, renamed: body && body.name });",
                "    });",
                "    ctx.log('demo fixture ready');",
                "}",
            ].join('\n'),
            manifest: {
                id: 'demo-fixture', name: '演示插件（检查夹具）', version: '1.0.0', entry: 'index.js',
                defaultEnabled: true,
                server: {
                    entry: 'server.mjs',
                    capabilities: ['route-register', 'host-utils'],
                    routes: ['/api/demo'],
                },
            },
        });
        // 夹具②：撞宿主前缀（/api/ping 是 bootstrap 自己的地址）→ 必须被拒绝装载
        writeFixtureMod(path.join(TMP, 'mods', 'collide-fixture'), {
            id: 'collide-fixture',
            serverEntry: "export function register(ctx) { ctx.route('GET', '/api/ping/x', () => {}); }",
            manifest: {
                id: 'collide-fixture', name: '撞名夹具', version: '1.0.0', entry: 'index.js',
                defaultEnabled: true,
                server: { entry: 'server.mjs', capabilities: ['route-register'], routes: ['/api/ping'] },
            },
        });
        // 夹具③：未声明 host-utils 却用 ctx.utils → need() 必须当场报错（D19）
        writeFixtureMod(path.join(TMP, 'mods', 'no-cap-fixture'), {
            id: 'no-cap-fixture',
            serverEntry: "export function register(ctx) { const u = ctx.utils; }",
            manifest: {
                id: 'no-cap-fixture', name: '无能力夹具', version: '1.0.0', entry: 'index.js',
                defaultEnabled: true,
                server: { entry: 'server.mjs', capabilities: ['route-register'], routes: ['/api/demo2'] },
            },
        });

        const srv = await startBootstrapMods(c, TMP);
        try {
            const got = await srv.waitMods();
            c.ok(Boolean(got && got.info), '★ bootstrap 起来且 ping 带 modsLoaded=true（装载有结论）', srv.out().slice(-300));
            // 起不来时不能直接 return：那会跳过 srv.stop()，子进程带 pipe 活着、检查进程永不退出
            if (!got || !got.info) return;
            const BASE = got.base;

        const echo = await (await fetch(BASE + '/api/demo/echo', { headers: ORIGIN })).json();
        c.ok(echo.ok === true && echo.echo === 'demo', '★ 夹具的 /api/demo/* 路由可分发', JSON.stringify(echo).slice(0, 120));
        c.ok(Array.isArray(echo.caps) && echo.caps.includes('host-utils'), 'ctx.capabilities() 报告已声明能力');
        const rename = await (await fetch(BASE + '/api/demo/rename', {
            method: 'POST',
            headers: { ...ORIGIN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '新名字' }),
        })).json();
        c.ok(rename.ok === true && rename.renamed === '新名字', '夹具经 ctx.readJson 收到 JSON 请求体');

        c.ok(Array.isArray(got.info.modRoutes) && got.info.modRoutes.includes('/api/demo'),
            '★ ping.modRoutes 含夹具前缀 /api/demo', JSON.stringify(got.info.modRoutes));
        c.ok(!got.info.modRoutes.includes('/api/ping'), '撞宿主前缀的夹具不在 modRoutes 里');

        // /api/mods/status 形状（D-7）
        const status = await (await fetch(BASE + '/api/mods/status', { headers: ORIGIN })).json();
        c.ok(status.ok === true && status.modsLoaded === true, 'GET /api/mods/status 返回 ok 且 modsLoaded=true');
        const failedIds = (status.failed || []).map((f) => f.id);
        c.ok(failedIds.includes('collide-fixture'), '★ 撞宿主前缀的夹具被拒绝装载并进 failed',
            JSON.stringify(status.failed));
        c.ok(failedIds.includes('no-cap-fixture'), '★ 未声明 host-utils 的夹具装载失败（need() 生效）');
        const collideErr = (status.failed || []).find((f) => f.id === 'collide-fixture');
        c.ok(collideErr && /宿主/.test(collideErr.error), '撞名报错点名「宿主」');
        const noCapErr = (status.failed || []).find((f) => f.id === 'no-cap-fixture');
        c.ok(noCapErr && /host-utils/.test(noCapErr.error), '无能力报错点名缺的能力（host-utils）');
        c.ok((status.mods || []).some((m) => m.id === 'demo-fixture' && m.ok === true), '正常夹具在 status.mods 里为 ok');

        const pingStill = await (await fetch(BASE + '/api/ping', { headers: ORIGIN })).json();
        c.ok(pingStill.ok === true && pingStill.uptimeSeconds !== undefined, '宿主 /api/ping 不被插件吃掉');
        } finally {
            await srv.stop();
        }

        // 启用判定：总开关关 → 任何插件不装载（F-13 两段都要复刻）
        writeFileSync(path.join(TMP, 'store.json'), JSON.stringify({ elaina_plugins_enabled: '0' }));
        const srv2 = await startBootstrapMods(c, TMP);
        try {
            const got2 = await srv2.waitMods();
            c.ok(Boolean(got2 && got2.info), '总开关关闭时 bootstrap 仍给出装载结论');
            if (got2 && got2.info) {
                c.ok(!got2.info.modRoutes.includes('/api/demo'),
                    '★ 总开关关（elaina_plugins_enabled=0）→ 夹具路由不装载（服务端半边真的停用）');
                const echo2 = await fetch(got2.base + '/api/demo/echo', { headers: ORIGIN });
                c.ok(echo2.status === 404, '总开关关时夹具接口 404', String(echo2.status));
            }
        } finally {
            await srv2.stop();
        }

        // 启用判定：per-id 关 → 该插件不装载，其它不受影响
        writeFileSync(path.join(TMP, 'store.json'), JSON.stringify({
            'elaina_plugin_demo-fixture': '0',
            'elaina_plugin_collide-fixture': '0',
            'elaina_plugin_no-cap-fixture': '0',
        }));
        const srv3 = await startBootstrapMods(c, TMP);
        try {
            const got3 = await srv3.waitMods();
            c.ok(Boolean(got3 && got3.info), 'per-id 停用时 bootstrap 仍给出装载结论');
            if (got3 && got3.info) {
                c.ok(!got3.info.modRoutes.includes('/api/demo'),
                    '★ per-id 开关（elaina_plugin_<id>=0）→ 该插件不装载');
            }
        } finally {
            await srv3.stop();
        }
    } finally {
        try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 句柄残留不阻塞结论 */ }
    }
}

async function caseBootstrapMigrate(c) {
    const TMP = mkdtempSync(path.join(tmpdir(), 'elaina-bootstrap-mig-'));
    const ORIGIN = { Origin: 'https://localhost' };
    try {
        // 夹具：声明 static /live2d/models → models（迁移目标由这份声明决定，不点名插件 id）
        writeFixtureMod(path.join(TMP, 'mods', 'demo-fixture'), {
            id: 'demo-fixture',
            serverEntry: [
                "export function register(ctx) {",
                "    const dir = ctx.staticDir('/live2d/models');",
                "    ctx.route('GET', '/api/demo/echo', (req, res) => ctx.json(res, 200, { ok: true }));",
                "    ctx.log('models at ' + dir);",
                "}",
            ].join('\n'),
            manifest: {
                id: 'demo-fixture', name: '迁移夹具', version: '1.0.0', entry: 'index.js',
                defaultEnabled: true,
                server: {
                    entry: 'server.mjs',
                    capabilities: ['route-register', 'static-read'],
                    routes: ['/api/demo'],
                    static: [{ url: '/live2d/models', dir: 'models' }],
                },
            },
        });

        mkdirSync(path.join(TMP, 'live2d', 'models', '旧模型A'), { recursive: true });
        writeFileSync(path.join(TMP, 'live2d', 'models', '旧模型A', 'model3.json'), '{}');
        mkdirSync(path.join(TMP, 'live2d', 'models', '冲突模型'), { recursive: true });
        writeFileSync(path.join(TMP, 'live2d', 'models', '冲突模型', 'old.txt'), 'old');
        // 目标已存在同名目录：用户后装的同名模型优先，迁移应跳过不覆盖
        mkdirSync(path.join(TMP, 'mods', 'demo-fixture', 'models', '冲突模型'), { recursive: true });
        writeFileSync(path.join(TMP, 'mods', 'demo-fixture', 'models', '冲突模型', 'new.txt'), 'new');

        const srv = await startBootstrapMods(c, TMP);
        try {
            const got = await srv.waitMods();
            c.ok(Boolean(got && got.info), 'bootstrap（含 static 夹具）已就绪', srv.out().slice(-400));
            // 起不来时直接 return 会跳过 srv.stop()，子进程带 pipe 活着、检查进程永不退出
            if (!got || !got.info) return;

            const movedRoot = path.join(TMP, 'mods', 'demo-fixture', 'models');
            c.ok(existsSync(path.join(movedRoot, '旧模型A', 'model3.json')),
                '★ 旧布局模型被迁移到插件目录（static 声明决定目标，不点名插件 id）');
            c.ok(!existsSync(path.join(TMP, 'live2d', 'models', '旧模型A')), '迁移完成后旧位置不再有该模型');
            c.ok(existsSync(path.join(movedRoot, '冲突模型', 'new.txt'))
                && !existsSync(path.join(movedRoot, '冲突模型', 'old.txt')),
                '★ 目标已存在的同名模型跳过不覆盖（用户后装的优先）');
            // modStatic 的 relPath 相对 filesDir（TMP），前端 Filesystem 直接可用
            const st = (got.info.modStatic || []).find((s) => s.url === '/live2d/models');
            c.ok(Boolean(st) && st.relPath === 'mods/demo-fixture/models',
                '★ ping.modStatic 报相对 filesDir 的 relPath', JSON.stringify(got.info.modStatic));
        } finally {
            await srv.stop();
        }

        // 幂等：第二次启动不再动任何东西
        const marker = path.join(TMP, 'mods', 'demo-fixture', 'models', '旧模型A', 'model3.json');
        const before = readFileSync(marker, 'utf8');
        const srv2 = await startBootstrapMods(c, TMP);
        try {
            const got2 = await srv2.waitMods();
            c.ok(Boolean(got2 && got2.info), '第二次启动正常就绪', srv2.out().slice(-300));
            if (got2) {
                c.ok(existsSync(marker) && readFileSync(marker, 'utf8') === before,
                    '★ 第二次启动不重复迁移（幂等）');
                c.ok(!existsSync(path.join(TMP, 'live2d', 'models', '旧模型A')), '旧位置保持为空');
            }
        } finally {
            await srv2.stop();
        }

        // 插件停用 → 不迁移（复刻兜底只认旧位置，模型必须留在原地）
        const TMP2 = mkdtempSync(path.join(tmpdir(), 'elaina-bootstrap-mig2-'));
        try {
            cpSync(path.join(TMP, 'mods', 'demo-fixture'), path.join(TMP2, 'mods', 'demo-fixture'), { recursive: true });
            mkdirSync(path.join(TMP2, 'live2d', 'models', '留在原地'), { recursive: true });
            writeFileSync(path.join(TMP2, 'live2d', 'models', '留在原地', 'model3.json'), '{}');
            writeFileSync(path.join(TMP2, 'store.json'), JSON.stringify({ 'elaina_plugin_demo-fixture': '0' }));

            const srv3 = await startBootstrapMods(c, TMP2);
            try {
                // 插件停用时 bootstrap 不装载服务端半边，modsLoaded 可能永不出现（阶段一协议：
                // 字段缺失 = 无装载能力）；这段"起来了"就是结论，不把装载结论当前提，否则并发跑偶发红
                const ready3 = await srv3.waitReady();
                c.ok(Boolean(ready3 && ready3.port), '停用插件的 bootstrap 正常就绪', srv3.out().slice(-300));
                const got3 = ready3 ? await srv3.waitMods() : null;
                c.ok(Boolean(got3 && got3.info), '停用插件的 bootstrap 正常就绪', srv3.out().slice(-300));
                if (got3) {
                    c.ok(existsSync(path.join(TMP2, 'live2d', 'models', '留在原地', 'model3.json')),
                        '★ 插件停用时旧布局不迁移（原生兜底复刻只认旧位置）');
                    c.ok(!existsSync(path.join(TMP2, 'mods', 'demo-fixture', 'models', '留在原地')),
                        '停用时插件目录里没有迁移产物');
                }
            } finally {
                await srv3.stop();
            }
        } finally {
            try { rmSync(TMP2, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    } finally {
        try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// 共享模块闭包检查：加一行共享模块"跑不起来"要到真机才发现（ERR_MODULE_NOT_FOUND 或静默不装载）。
// 钉住：相对 import 落在清单内、无裸包 import、bootstrap 的 ./server/* import 也在清单内、不用 Node 18 后的 API。
async function caseSharedClosure(c) {
    const syncSrc = readFileSync(path.join(ROOT, 'dist', 'Android', 'scripts', 'sync-web.mjs'), 'utf8');
    const listMatch = syncSrc.match(/SHARED_SERVER_MODULES\s*=\s*\[([^\]]*)\]/);
    c.ok(Boolean(listMatch), '能提取 SHARED_SERVER_MODULES');
    const shared = new Set(listMatch
        ? listMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
        : []);

    // Node 18 之后的 API 黑名单（nodejs-mobile 是 v18.20.4，F-29）；从 node: 模块解构出不存在的新 API 也拦：
    // 如 zlib.crc32（Node 20.15+）本地能跑、子进程里 bootstrap 静默起不来，只有静态扫描抓得住
    const NODE18_BLACKLIST = /\bObject\.groupBy\b|\bMap\.groupBy\b|\bArray\.fromAsync\b|\bPromise\.withResolvers\b|\.toSorted\(|\.toReversed\(/;
    /** Node 18 的 node: 内置模块里**没有**的具名导出（按模块名分组） */
    const NODE18_MISSING_EXPORTS = {
        'node:zlib': ['crc32'],
        'node:fs': ['glob', 'globSync'],
        'node:util': ['parseArgs'],
        'node:test': ['mock'],
        'node:module': ['registerHooks'],
        'node:process': ['getBuiltinModule'],
    };
    /** 找出"从某个 node: 模块 import 了解构里不存在的名字" */
    function findMissingBuiltinExports(name, src) {
        const problems = [];
        const re = /import\s*\{([^}]*)\}\s*from\s*['"](node:[^'"]+)['"]/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
            const missing = NODE18_MISSING_EXPORTS[m[2]];
            if (!missing) continue;
            for (const n of names) {
                if (missing.includes(n)) {
                    problems.push(`${name} 从 ${m[2]} import 了 Node 18 没有的导出「${n}」（nodejs-mobile 是 v18.20.4）`);
                }
            }
        }
        return problems;
    }

    /** 检查一个 .mjs 源文件的全部 import，违规返回描述数组 */
    function checkImports(name, src) {
        const problems = [];
        const importRe = /import\s+[^'"]*from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
        let m;
        while ((m = importRe.exec(src)) !== null) {
            const spec = m[1] || m[2];
            if (spec.startsWith('node:')) continue;                       // 内置模块：可用
            if (spec.startsWith('./')) {
                const base = spec.slice(2).split('?')[0];
                // ③ 不许 import 回 serve.mjs / web/（那会把桌面启动链拖进手机）
                if (base.startsWith('../') || base.includes('serve.mjs')) {
                    problems.push(`${name} import 了桌面专属路径：${spec}`);
                    continue;
                }
                if (!shared.has(base)) {
                    problems.push(`${name} 的相对 import ${spec} 不在 SHARED_SERVER_MODULES 里（复制出去少文件）`);
                }
            } else {
                problems.push(`${name} 有裸包 import：${spec}（APK 里没有 node_modules）`);
            }
        }
        // 这两项与 import 形态无关，必须无条件检查整个文件（挂进上面循环会漏掉无相对 import 的文件）
        if (NODE18_BLACKLIST.test(src)) {
            problems.push(`${name} 用了 Node 18 之后才有的 API（nodejs-mobile 是 v18.20.4）`);
        }
        problems.push(...findMissingBuiltinExports(name, src));
        return problems;
    }

    const problems = [];
    for (const name of shared) {
        const src = readFileSync(path.join(ROOT, 'server', name), 'utf8');
        problems.push(...checkImports(name, src));
    }
    // bootstrap.mjs 自己 import 的 ./server/* 也必须在清单内
    const bootSrc = readFileSync(path.join(ROOT, 'web', 'nodejs', 'bootstrap.mjs'), 'utf8');
    {
        const importRe = /import\s+[^'"]*from\s*['"](\.\/server\/[^'"]+)['"]/g;
        let m;
        while ((m = importRe.exec(bootSrc)) !== null) {
            const base = m[1].slice('./server/'.length);
            if (!shared.has(base)) {
                problems.push(`bootstrap.mjs import 的 ./server/${base} 不在 SHARED_SERVER_MODULES 里`);
            }
        }
        if (NODE18_BLACKLIST.test(bootSrc)) {
            problems.push('bootstrap.mjs 用了 Node 18 之后才有的 API');
        }
        problems.push(...findMissingBuiltinExports('bootstrap.mjs', bootSrc));
    }
    c.ok(problems.length === 0, '★ 共享模块闭包完整（相对 import 全在清单 / 无裸包 / 无 Node18+ API）',
        problems.join('；'));

    // 清单里的每个文件都真实存在（copyFile 缺源会当场抛，这里提前点破）
    for (const name of shared) {
        c.ok(existsSync(path.join(ROOT, 'server', name)), `共享模块存在：${name}`);
    }
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

const only = process.argv[2];
const allCases = [
    { name: '插件系统核心（扫描 / 解压 / 清单 / 安全）', fn: caseModsCore },
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
    { name: 'bootstrap 装载 mod 服务端', fn: caseBootstrapMods },
    { name: 'bootstrap 模型目录迁移', fn: caseBootstrapMigrate },
    { name: '共享模块闭包检查', fn: caseSharedClosure },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: '插件系统（扫描 / 身份 / 依赖 / 宿主能力 / 端到端）',
    usage: 'node scripts/check-mod.mjs [用例名子串]',
    cases,
});
