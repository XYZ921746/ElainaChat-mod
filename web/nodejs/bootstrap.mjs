/**
 * 手机端（APK）内嵌 Node 后端的启动骨架：由原生插件 ElainaNode 调用，起一个只监听回环的 HTTP 服务；参数 --data-dir=<应用私有目录>、--port=<n>（默认 0）。
 * 启动时序：mod 装载异步发起（不阻塞端口回传）→ listen 成功 → stdout 打一行带 READY_PREFIX 的 JSON 回传端口（见 elaina_node_jni.cpp；stdout 接进管道，打完必须立即刷新，否则前端永远等不到端口）。
 * 硬性约束：① 只绑 127.0.0.1（安卓上非 root 进程不能监听对外端口）；② 绝不能调 process.exit()（结束的是整个 App，要停就关掉 server 让事件循环空掉）；
 *   ③ 进任何路由之前先校验 Origin（只认 https://localhost，见 ALLOWED_ORIGIN）—— 只绑回环不等于安全。
 * 页面是 https://localhost 而这里是 http://127.0.0.1:<port>，不同源，HTTP 头里必须带 CORS。
 * 与电脑端共用的部分（本地中继 / 内网判定 / mod 服务端装载）直接用 server/ 下被复制到 ./server/ 的模块，没有第二份实现。
 */

import http from 'node:http';
import process from 'node:process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createRelay } from './server/relay.mjs';
import { isLocalRequest, isLoopbackHostname, isInternalAddress } from './server/net-guard.mjs';
import { readJsonBody } from './server/http-util.mjs';
import { createLogBuffer } from './server/log-buffer.mjs';
import { createModServer } from './server/mod-server.mjs';
import { readZip, effectiveExt, isUnsafeEntryName, MAX_UPLOAD } from './server/zip.mjs';

/** 端口回传行的前缀，与 elaina_node_jni.cpp 里的 READY_PREFIX 必须一致。 */
const READY_PREFIX = '__ELAINA_READY__';

const HOST = '127.0.0.1';

function readArgument(name, fallback) {
    const prefix = `--${name}=`;
    const hit = process.argv.find((value) => value.startsWith(prefix));
    return hit === undefined ? fallback : hit.slice(prefix.length);
}

const dataDirectory = readArgument('data-dir', '');
const requestedPort = Number.parseInt(readArgument('port', '0'), 10) || 0;

// 进程级兜底：未捕获异常默认会结束整个 Node 运行时（等于整个 App 跟着死），所以两类致命事件都只记一行日志、不 process.exit。
process.on('uncaughtException', (error) => {
    console.error('[bootstrap] 未捕获异常（已兜底，继续运行）：'
        + String((error && error.stack) || error));
});
process.on('unhandledRejection', (reason) => {
    console.error('[bootstrap] 未处理的 Promise 拒绝（已兜底，继续运行）：'
        + String((reason && reason.stack) || reason));
});

let port = 0;

/** 放行跨源请求：回显 Origin 而不是写死 `*`（页面只有一个来源 https://localhost，回显够用又不把接口敞开给任意网页）。 */
function applyCorsHeaders(request, response) {
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin || '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Vary', 'Origin');
}

function sendJson(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
}

// 日志系统（与电脑端 serve.mjs 同构的手机版）：内存环形缓冲（/api/logs/tail 的数据源）+ 主日志/追踪日志双文件落盘；查询形状与 serve.mjs 逐字对齐（消费方是同一个 log-viewer.js），落盘每次启动一组 <启动时刻>.log / .trace.log（单文件超 LOG_MAX_BYTES 拆 _2/_3、只留最近 LOG_KEEP 次启动）；同步写保证串行、不会交错断行。
const LOG_DIR = dataDirectory ? path.join(dataDirectory, 'logs') : '';
const LOG_KEEP = 10;                       // 保留最近多少次启动的日志
const LOG_MAX_BYTES = 8 * 1024 * 1024;     // 单个日志文件上限，超出拆 _2/_3
const LOG_TO_FILE = String(process.env.LOG_TO_FILE ?? '1') !== '0' && Boolean(LOG_DIR);
const traceEnabled = String(process.env.LOG_CHAT ?? '1') !== '0';

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');
function logStampFor(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
        + `_${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`;
}
function logTimeFull(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
        + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
        + `.${pad3(date.getMilliseconds())}`;
}
function logTimeShort(date = new Date()) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
        + `.${pad3(date.getMilliseconds())}`;
}

const LEVEL_SHORT = { DEBUG: 'DBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERRO', CRITICAL: 'CRIT' };
const LEVEL_NUM = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, CRITICAL: 50 };
const LEVEL_INPUT_ALIASES = {
    DBUG: 'DEBUG', DEBUG: 'DEBUG',
    INFO: 'INFO', INFORMATION: 'INFO',
    WARN: 'WARN', WARNING: 'WARN',
    ERRO: 'ERROR', ERR: 'ERROR', ERROR: 'ERROR',
    CRIT: 'CRITICAL', CRITICAL: 'CRITICAL', FATAL: 'CRITICAL',
};
function normalizeLevelName(raw) {
    return LEVEL_INPUT_ALIASES[String(raw || '').trim().toUpperCase()] || null;
}

const TAG_ALIASES = {
    boot: 'Core', core: 'Core', log: 'Core', bootstrap: 'Core', store: 'Store',
    relay: 'Relay', live2d: 'Live2D', agent: 'Agent', chat: 'Chat', http: 'HTTP',
    page: 'Page', auth: 'Auth', mod: 'Mod', node: 'Node', trace: 'Trace',
};
function normalizeTag(raw) {
    const key = String(raw || '').trim();
    if (!key) return 'Core';
    const hit = TAG_ALIASES[key] || TAG_ALIASES[key.toLowerCase()];
    if (hit) return hit;
    return key.length <= 12 ? key[0].toUpperCase() + key.slice(1) : 'Core';
}

// 写进缓冲与日志文件的文本要脱敏（与 serve.mjs 的 SECRET_RULES 同一套正则）：前端报错里常带请求体/响应体，明文 API Key 会跟着进文件与查看器。
const SECRET_RULES = [
    [/访问密码[^：:\n]{0,20}[:：]\s*\S+/g, '访问密码: ******'],
    [/LAN access password[^:\n]*:\s*\S+/gi, 'LAN access password: ******'],
    [/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1******'],
    [/((?:apiKey|api_key|api-key|accessKey|access_key|token|password|secret|authorization)"?\s*[:=]\s*"?)([A-Za-z0-9._\-]{12,})/gi, '$1******'],
    [/\b(sk|rc|hk|ak)-[A-Za-z0-9._\-]{16,}/g, '$1-******'],
];
function redactSecrets(text) {
    let out = String(text);
    for (const [re, to] of SECRET_RULES) out = out.replace(re, to);
    return out;
}

const mainSink = { base: '', ext: '.log', part: 1, file: '', bytes: 0 };
const traceSink = { base: '', ext: '.trace.log', part: 1, file: '', bytes: 0 };
function sinkPath(sink) {
    return path.join(LOG_DIR, sink.base + (sink.part > 1 ? '_' + sink.part : '') + sink.ext);
}
const LOG_NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:[-._][A-Za-z0-9]+)*\.log$/;
const LOG_STAMP_LEN = 19;                  // `YYYY-MM-DD_HH-mm-ss` 的长度，按"启动"分组用

function initLogFiles() {
    if (!LOG_TO_FILE) return;
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        let base = logStampFor(new Date());
        for (let i = 2; existsSync(path.join(LOG_DIR, base + '.log')); i++) base = logStampFor(new Date()) + '-' + i;
        mainSink.base = base;
        traceSink.base = base;
        mainSink.file = sinkPath(mainSink);
        traceSink.file = sinkPath(traceSink);
        appendFileSync(mainSink.file, '');   // 立即建出空文件：tail -f 从启动就能挂上
        if (traceEnabled) appendFileSync(traceSink.file, '');
    } catch { /* 目录不可写时退化为"只进缓冲与 stdout" */ }
}

function appendToFile(sink, text) {
    if (!LOG_TO_FILE || !sink.file) return;
    try {
        const bytes = Buffer.byteLength(text);
        if (sink.bytes + bytes > LOG_MAX_BYTES) {
            sink.part += 1;
            sink.file = sinkPath(sink);
            sink.bytes = 0;
            console.log('[Core] 日志超过 '
                + `${Math.round(LOG_MAX_BYTES / 1024 / 1024)}MB，换到 ${path.basename(sink.file)}`);
        }
        appendFileSync(sink.file, text);
        sink.bytes += bytes;
    } catch { /* 日志写不进去也绝不能影响主流程 */ }
}

function pruneOldLogs() {
    try {
        const sessions = new Map();
        for (const name of readdirSync(LOG_DIR)) {
            if (!LOG_NAME_RE.test(name)) continue;
            const key = name.slice(0, LOG_STAMP_LEN);
            if (!sessions.has(key)) sessions.set(key, []);
            sessions.get(key).push(name);
        }
        const stale = [...sessions.keys()].sort().slice(0, Math.max(0, sessions.size - LOG_KEEP));
        for (const key of stale) {
            for (const name of sessions.get(key)) {
                rmSync(path.join(LOG_DIR, name), { force: true });
                console.log(`[Core] 清理旧日志 ${name}（只保留最近 ${LOG_KEEP} 次启动）`);
            }
        }
    } catch { /* 清理失败不影响启动 */ }
}

const logBuffer = createLogBuffer();

// 包装 console 之前先留一份原件：日志系统自己输出时要用它，否则会递归；traceLine 的 stdout 也走原件 —— 走重挂后的 console 会把追踪全文灌进主日志与缓冲。
const consoleOriginal = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
};

/** 写一条主日志：消息开头的 `[标签]` 抽成 tag 字段（与 serve.mjs 的 emitLog 同一套约定：调用点写 `console.log('[relay] …')`，输出即结构化）。 */
function emitLog(level, args) {
    const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    const m = text.match(/^\s*\[([^\]\n]{1,16})\]\s*([\s\S]*)$/);
    const tag = m ? normalizeTag(m[1]) : 'Core';
    const body = (m ? m[2] : text).replace(/\s+$/, '');
    if (!body.trim()) return;
    const now = new Date();
    const short = LEVEL_SHORT[level] || 'INFO';
    logBuffer.push({
        ts: now, level, tag, loc: '',
        message: redactSecrets(body).replace(/^\n+/, ''),
    });
    if (LOG_TO_FILE && (LEVEL_NUM[level] || 20) >= LEVEL_NUM.INFO) {
        const head = `[${logTimeFull(now)}] [${tag}] [${short}]: `;
        const safe = redactSecrets(body).replace(/^\n+/, '');
        // 多行保留换行、后续行不重复前缀（压成一行会毁掉异常栈这类多行诊断块）
        const lines = safe.split('\n');
        const rest = lines.slice(1).map((l) => l.replace(/\s+$/, ''));
        appendToFile(mainSink, head + lines[0].replace(/\s+$/, '') + (rest.length ? '\n' + rest.join('\n') : '') + '\n');
    }
    // stdout → logcat：不带 ANSI 色（logcat 不是终端）；这个通道保持全量，`adb logcat | grep ELAINA` 永远能看到一切
    consoleOriginal[level === 'DEBUG' ? 'log' : (level === 'ERROR' ? 'error' : (level === 'WARN' ? 'warn' : 'log'))](
        `[${logTimeShort(now)}] [${tag}] [${short}]: ${body}`);
}

for (const [method, level] of [
    ['log', 'INFO'], ['info', 'INFO'], ['debug', 'DEBUG'], ['warn', 'WARN'], ['error', 'ERROR'],
]) {
    console[method] = function patchedConsoleLog(...args) {
        try {
            emitLog(level, args);
        } catch {
            consoleOriginal[method === 'debug' ? 'log' : method](...args);
        }
    };
}

initLogFiles();
pruneOldLogs();   // 放在包装之后：清理动作本身也进日志

/** 追踪日志：中继的完整请求/回复、前端上报的报错全文。只写 traceSink 文件（多行原样保留）、不进缓冲 —— 摘要行由调用方走 console.log 进主日志，stdout 用原件再打一份（logcat 保留一条活路）。 */
function traceLine(text) {
    if (!traceEnabled) return;
    const body = String(text ?? '');
    if (!body.trim()) return;
    appendToFile(traceSink, `[${logTimeFull()}] ${redactSecrets(body)}\n`);
    consoleOriginal.log('[trace] ' + body);
}

// mod 服务端半边装载（与电脑端 serve.mjs 同构）：装载的就是 server/mod-server.mjs 本尊（能力声明 need()/超时/回滚全套生效），目录布局 = Capacitor Directory.Data(filesDir) 下的 mods/<manifest.id>/；本进程数据目录是 filesDir/elaina-data，所以插件根是 path.resolve(dataDirectory, '..', 'mods')，filesDir/store.json 也直接可读。
const FILES_ROOT = dataDirectory ? path.resolve(dataDirectory, '..') : '';
const MODS_DIR = FILES_ROOT ? path.join(FILES_ROOT, 'mods') : '';

/** 宿主自己占用的 /api 前缀 —— bootstrap 的路由清单，插件撞名会被拒绝装载 */
const HOST_ROUTE_PREFIXES = [
    '/api/relay', '/api/ping', '/api/shutdown',
    '/api/logs', '/api/client-log', '/api/mods',
];

const modServer = createModServer({
    modsDir: MODS_DIR,
    hostRoutePrefixes: HOST_ROUTE_PREFIXES,
    hostStaticPrefixes: [],
    jsonResponse: sendJson,   // 签名相同（res, code, obj），对齐 sendJson 的 Content-Length 行为
    readJsonBody,
    // 与 serve.mjs 接线同一形状的宿主共享工具（实现全部来自 server/zip.mjs，两端同一份 —— 数字或判定分叉就是"电脑能传、手机 413"）
    hostUtils: {
        readZip: (buf, opts) => readZip(buf, { ...opts, returnBlocked: true }),
        isUnsafeEntryName,
        effectiveExt,
        MAX_UPLOAD,
    },
    log: (msg) => console.log('[Mod] ' + msg),
});

let modsLoaded = false;
let installedMods = [];

/** 扫插件根：逐目录读 manifest.json（纯读 JSON，不执行任何插件代码），返回展开形状（{...manifest, id, dir}）—— modServer 的 loadAll/loadOne/status 都从条目顶层读；身份判定对齐 server/mods.mjs 的 readManifest（manifest.id 合法则以它为身份，否则回落目录名）。 */
async function scanInstalledMods() {
    const out = [];
    let entries = [];
    try { entries = await readdir(MODS_DIR, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'index.json') continue;
        let manifest = null;
        try {
            manifest = JSON.parse(await readFile(path.join(MODS_DIR, e.name, 'manifest.json'), 'utf8'));
        } catch { continue; /* 坏目录跳过，不阻塞其它插件 */ }
        if (!manifest || typeof manifest !== 'object') continue;
        const declared = typeof manifest.id === 'string' ? manifest.id.trim() : '';
        const id = (declared && modServer.MOD_ID_RE.test(declared)) ? declared : e.name;
        out.push({ ...manifest, id, dir: e.name });
    }
    return out;
}

/**
 * 读启用状态：filesDir/store.json（前端 store.js 原生后端写的，一层扁平 `键 → 字符串`）。两段判定都必须复刻：总开关 elaina_plugins_enabled !== '0'（缺省 = 开）
 * 且 per-id elaina_plugin_<id> === '1'（缺键看 manifest.defaultEnabled === true）—— 只判一处会让"用户关了插件系统"或"停用的插件服务端照活"漏网。
 */
async function readEnabledState() {
    try {
        const raw = await readFile(path.join(FILES_ROOT, 'store.json'), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }   // 首次运行 / 文件不存在 = 全部默认
}

/** 静态解析：收集已启用插件的 server.static 声明 → { URL前缀: 绝对目录 }。用 modServer.readDeclaration（同一份实现），只读 manifest、不执行插件代码 —— 归位的判据必须是"纯数据"，等装载结果就晚了（那时 models/ 可能还不存在、直接装载失败）。 */
function resolveEnabledStatics(installed, isEnabled) {
    const map = {};
    for (const it of installed) {
        if (!isEnabled(it.id, it)) continue;
        const decl = modServer.readDeclaration(it);
        if (!decl || decl.error) continue;
        const baseDir = path.join(MODS_DIR, it.dir);
        for (const s of (decl.statics || [])) {
            map[s.url] = path.join(baseDir, s.dir);
        }
    }
    return map;
}

/**
 * 模型目录归位：filesDir/live2d/models/<名> → 插件目录。目标目录由静态映射决定，判据是"谁声明了 /live2d/models"而不点名插件 id（目录名带版本后缀，写死必错）；
 * 没有该声明（插件没装 / 被停用）→ 整体跳过（停用时前端回落原生复刻，复刻只认原位）；目标已存在则跳过；fs.rename 同 filesDir 零拷贝，源目录空时幂等。
 */
async function migrateLegacyModels(staticMap) {
    const legacyRoot = path.join(FILES_ROOT, 'live2d', 'models');
    let entries;
    try { entries = await readdir(legacyRoot, { withFileTypes: true }); } catch { return; }
    const targetRoot = staticMap['/live2d/models'];
    if (!targetRoot) {
        console.log('[Core] 没有已启用插件声明 /live2d/models，旧模型目录保持原位（不迁移）');
        return;
    }
    let moved = 0;
    let skipped = 0;
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const from = path.join(legacyRoot, e.name);
        const to = path.join(targetRoot, e.name);
        if (existsSync(to)) { skipped++; continue; }
        await mkdir(path.dirname(to), { recursive: true });   // rename 不建父目录
        await rename(from, to);
        moved++;
    }
    if (moved || skipped) {
        console.log(`[Core] 旧模型目录迁移完成：移动 ${moved} 个，跳过 ${skipped} 个（目标已存在，用户后装的同名模型优先）`);
    }
}

/**
 * 装载全部已安装、已启用的插件服务端半边。固定三段顺序（不得调换）：① 静态解析（纯读 manifest）→ ② 模型目录归位（目标由静态映射决定）→ ③ loadAll；
 * 末尾无论结果如何都置 modsLoaded = true —— 前端靠它区分"装载中"与"装载完（哪怕全失败）"。
 */
async function loadMods() {
    installedMods = await scanInstalledMods();
    if (installedMods.length) console.log('[Mod] 发现 ' + installedMods.length + ' 个已安装插件');
    const store = await readEnabledState();
    // 两段判定：总开关 !== '0' 且 per-id === '1'（缺键看 defaultEnabled === true；条目是展开的 manifest 形状）。
    const isEnabled = (id, entry) => {
        if (String(store['elaina_plugins_enabled'] ?? '') === '0') return false;
        const v = store['elaina_plugin_' + id];
        if (v === '1') return true;
        if (v === '0') return false;
        return Boolean(entry && entry.defaultEnabled === true);
    };
    const staticMap = resolveEnabledStatics(installedMods, isEnabled);
    await migrateLegacyModels(staticMap);
    await modServer.loadAll(installedMods, isEnabled);
    modsLoaded = true;
}

/**
 * 手机上真正的边界：只认页面自己发来的请求（Origin 必须是 https://localhost）—— 安卓的 127.0.0.1 是整机共享的，
 * 同机任何别的 App 连过来时 remoteAddress 同样是 127.0.0.1，所以电脑端那套 isLocalRequest 在手机上恒真、不能用；
 * 代价：不带 Origin 的本机请求也会被拒（原生插件在 stop() 里显式补了这个头，见 ElainaNodePlugin.stop）。
 */
const ALLOWED_ORIGIN = 'https://localhost';
const originAllowed = (request) => String(request.headers.origin || '') === ALLOWED_ORIGIN;

/** 本地中继 —— 用与电脑端同一份实现（server/relay.mjs）：页面在 https://localhost、这里是 http://127.0.0.1:<随机端口>，天生跨源，处境与电脑端一样。Node 侧真流式，SSE 能逐块透传（走原生 HTTP 插件那条路是攒完再回，增量就没了）。 */
const relayHandler = createRelay({
    traceLine,
    // 这三个判定用的是与电脑端同一份实现（net-guard）：手机上它们天然短路（见上面关于回环是整机共享的说明），仍然传真的实现而不是空壳 —— 将来谁改了监听地址，这道防线会立刻开始生效。
    isLocalRequest,
    isLoopbackHostname,
    isInternalAddress,
});

const server = http.createServer(async (request, response) => {
    applyCorsHeaders(request, response);

    if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
    }

    if (!originAllowed(request)) {
        sendJson(response, 403, {
            ok: false,
            message: '只接受来自本应用页面的请求（缺少正确的 Origin）',
        });
        return;
    }

    const pathname = new URL(request.url, `http://${HOST}`).pathname;

    if (pathname === '/api/relay' && request.method === 'POST') {
        return relayHandler.handleRelay(request, response);
    }

    // 前端日志上报：WebView 里 console.error / 未捕获异常经 sendBeacon 进来。**不校验 Content-Type** ——
    //   前端的 beacon 补丁故意发 text/plain（免跨源预检，页面卸载时预检常常来不及回来），这里按 JSON 解析即可。
    if (pathname === '/api/client-log' && request.method === 'POST') {
        let body;
        try { body = await readJsonBody(request, 64 * 1024); } catch { return sendJson(response, 400, { ok: false }); }
        const items = Array.isArray(body && body.items) ? body.items.slice(0, 20) : [];
        for (const it of items) {
            const rawLevel = String((it && it.level) || 'log').toLowerCase();
            const level = ['debug', 'info', 'warn', 'error'].includes(rawLevel) ? rawLevel : 'log';
            const page = String((it && it.page) || '').slice(0, 36);
            const text = String((it && it.text) || '').trim();
            if (!text) continue;
            const oneLine = text.replace(/\s+/g, ' ');
            const clipped = oneLine.length > 2000
                ? oneLine.slice(0, 2000) + ' …（已截断，完整内容见追踪日志）'
                : oneLine;
            const method = { debug: 'debug', info: 'log', warn: 'warn', error: 'error' }[level] || 'log';
            console[method]('[page] ' + (page ? page + '  ' : '') + clipped);
            traceLine(`===== 浏览器上报 · ${page || '/'} · ${level.toUpperCase()} =====\n${text}`);
        }
        return sendJson(response, 200, { ok: true });
    }

    // 日志查看器的数据源：内存缓冲按条件取。查询参数（可选）：level（最低级别）/ tags（逗号分隔）/ search / limit /
    //   since + sinceSeq（增量游标，两个值必须成对 —— 只传时间戳会丢同毫秒记录，详见 server/log-buffer.mjs 的 query）。
    if (pathname === '/api/logs/tail' && request.method === 'GET') {
        const u = new URL(request.url || '/', `http://${HOST}`);
        const result = logBuffer.query({
            minLevel: normalizeLevelName(u.searchParams.get('level')) || undefined,
            tags: u.searchParams.get('tags') ? u.searchParams.get('tags').split(',').map((s) => s.trim()).filter(Boolean) : undefined,
            search: u.searchParams.get('search') || undefined,
            limit: Number(u.searchParams.get('limit')) || undefined,
            since: Number(u.searchParams.get('since')) || undefined,
            sinceSeq: u.searchParams.get('sinceSeq') !== null && u.searchParams.get('sinceSeq') !== ''
                ? Number(u.searchParams.get('sinceSeq')) : undefined,
        });
        return sendJson(response, 200, { ok: true, ...result, tags: logBuffer.tags() });
    }

    if (pathname === '/api/logs/settings' && request.method === 'GET') {
        return sendJson(response, 200, {
            ok: true,
            level: 'INFO',
            levels: ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'],
            trace: traceEnabled,
            fileEnabled: LOG_TO_FILE,
            logDir: 'logs/',
            mainFile: mainSink.file ? path.basename(mainSink.file) : '',
            traceFile: traceSink.file ? path.basename(traceSink.file) : '',
            keep: LOG_KEEP,
            maxMb: Math.round(LOG_MAX_BYTES / 1024 / 1024),
        });
    }

    if (pathname === '/api/ping' && request.method === 'GET') {
        // modsLoaded/modRoutes/modStatic：前端轮询 ping 直到 modsLoaded === true 才缓存清单（先到的 ping 必然看到空清单 —— loadAll 在 listen 之后 —— 当终态就永远是空的）；
        //   modRoutes 取**声明前缀**（status().mods[].routes 的并集）而不是具体端点（给具体端点会漏掉同前缀的其它端点）；modStatic 的 relPath 相对 filesDir，绝对路径只留在服务端。
        const modRoutes = [...new Set(modServer.status(installedMods).mods
            .filter((m) => m.ok)
            .flatMap((m) => (Array.isArray(m.routes) ? m.routes : [])))];
        sendJson(response, 200, {
            ok: true,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            port,
            uptimeSeconds: Math.round(process.uptime()),
            dataDirectory,
            modsLoaded,
            modRoutes,
            modStatic: modServer.statics().map((s) => ({
                url: s.url,
                relPath: path.relative(FILES_ROOT, s.dir).replace(/\\/g, '/'),
            })),
        });
        return;
    }

    // mod 装载状态：排障用。不塞进 /api/plugins（那是前端原生实现的地盘，两处状态迟早漂移），也不塞进 ping（status 含 N 个插件明细，200ms 级探针不该变胖）
    if (pathname === '/api/mods/status' && request.method === 'GET') {
        sendJson(response, 200, { ok: true, modsLoaded, ...modServer.status(installedMods) });
        return;
    }

    if (pathname === '/api/shutdown' && request.method === 'POST') {
        sendJson(response, 200, { ok: true, stopping: true });
        // 关掉监听、断掉已有的 keep-alive 连接，让事件循环空掉 —— node::Start 随之返回，Java 那边的线程结束，App 进程留着；不用 process.exit()（见文件头 ②）。
        server.close();
        if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
        }
        return;
    }

    // mod 路由分发排在 bootstrap 自身路由**之后**（宿主永远优先；撞名在装载期已拒绝，这里是第二道保险）
    if (await modServer.handle(request, response, { pathname, url: request.url })) {
        return;
    }

    sendJson(response, 404, { ok: false, error: 'no such endpoint', path: pathname });
});

server.on('error', (error) => {
    console.error('内嵌 Node 服务启动失败：', error && error.message ? error.message : error);
});

// ② mod 装载：listen 之前发起（异步，不阻塞端口回传）；"全部装载失败"同样是结论，前端不该为一个坏插件等满 10s。
if (MODS_DIR) {
    loadMods().catch((error) => {
        console.error('[Mod] 装载流程失败（已隔离）：' + String((error && error.message) || error));
        modsLoaded = true;
    });
}

server.listen(requestedPort, HOST, () => {
    port = server.address().port;
    console.log(`[Core] embedded node listening on http://${HOST}:${port} (pid ${process.pid}, ${process.version})`);
    // ① 端口回传：写完整行 + 换行，原生侧按行解析。**必须**用 process.stdout.write 直写 —— console.log 已被日志系统重挂，输出会带上时间戳前缀，原生侧按 READY_PREFIX 解析就匹配不上了。
    process.stdout.write(`${READY_PREFIX}${JSON.stringify({
        port,
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        dataDirectory,
    })}\n`);
});
