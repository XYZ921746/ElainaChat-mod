/**
 * 手机端（APK）内嵌 Node 后端的启动骨架。
 *
 * 电脑版是「前端页面 + serve.mjs 服务端」两部分，而 APK 里原来只有前端 ——
 * 这个文件就是服务端那一半在手机上的**起点**：先起来一个只监听回环的 HTTP
 * 服务，把「能不能跑通」这条路走通（启动耗时、体积、端口回传、日志可见性），
 * 之后再把 serve.mjs 的各段逐个搬过来（relay → data 导出 → 日志落盘 →
 * 插件 server 半边）。
 *
 * 由原生插件 ElainaNode 调用，参数：
 *   --data-dir=<应用私有目录>   以后 data/、data/logs/ 都往这里落
 *   --port=<n>                  默认 0 = 让内核挑一个空闲端口
 *
 * 三条与电脑版不同的硬性约束（都很容易踩）：
 *
 *   ① **只绑 127.0.0.1**。安卓上非 root 进程不能监听对外端口，而且就算能，
 *      把服务端暴露到局域网也毫无必要。
 *
 *   ② **端口只能由这里回传**。绑 0 号端口后端口号只有自己知道，
 *      要在监听成功时打一行带前缀的 JSON 出去，由原生侧解析（见
 *      android/app/src/main/cpp/elaina_node_jni.cpp）。
 *      注意必须**打完就刷新**：stdout 被接进了管道，不刷新会一直卡在缓冲里，
 *      表现就是「Node 明明起来了，前端却永远等不到端口」。
 *
 *   ③ **绝不能调 process.exit()**。Node 跑在 App 自己的进程里，
 *      process.exit() 结束的是整个 App，不是"只停服务端"。
 *      要停就关掉 server 让事件循环自然空掉，node::Start 随之返回。
 *
 *   ④ **进任何路由之前先校验 Origin**（只认 https://localhost，见 ALLOWED_ORIGIN）。
 *      只绑回环**不等于**安全：安卓的 127.0.0.1 是整机共享的，同机任何 App 都能
 *      连上来，而它们的 remoteAddress 也是 127.0.0.1 —— 电脑端那套"是不是本机请求"
 *      的判定在这里恒真。这道 Origin 门才是手机端真正的边界。
 *
 * 另外 HTTP 头里必须带 CORS：页面是 https://localhost，而这里是
 * http://127.0.0.1:<port>，不同源 —— 电脑版同源所以从不需要这些头。
 *
 * 与电脑端共用的部分：本地中继（/api/relay）与内网判定直接用 server/ 下那两个
 *   模块（由 sync-web 复制到本目录的 ./server/），**没有第二份实现**。
 */

import http from 'node:http';
import process from 'node:process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
// 2026-10：与电脑端**共用**的后端模块（由 Android 打包工具 dist/Android/scripts/sync-web.mjs
//   复制到这里的 ./server/ 下，见那里的 SHARED_SERVER_MODULES）。不复制源码 —— 中继逻辑、
//   内网判定、HTTP 工具、日志缓冲与 mod 服务端装载只有一份，改一处两端都变。
import { createRelay } from './server/relay.mjs';
import { isLocalRequest, isLoopbackHostname, isInternalAddress } from './server/net-guard.mjs';
import { readJsonBody } from './server/http-util.mjs';
import { createLogBuffer } from './server/log-buffer.mjs';
import { createModServer } from './server/mod-server.mjs';
import { readZip, effectiveExt, isUnsafeEntryName, MAX_UPLOAD } from './server/zip.mjs';

/** 端口回传行的前缀，与 elaina_node_jni.cpp 里的 READY_PREFIX 必须一致。 */
const READY_PREFIX = '__ELAINA_READY__';

const HOST = '127.0.0.1';

/** 读 `--name=value` 形式的命令行参数。 */
function readArgument(name, fallback) {
    const prefix = `--${name}=`;
    const hit = process.argv.find((value) => value.startsWith(prefix));
    return hit === undefined ? fallback : hit.slice(prefix.length);
}

const dataDirectory = readArgument('data-dir', '');
const requestedPort = Number.parseInt(readArgument('port', '0'), 10) || 0;

// ── 进程级兜底：未捕获异常绝不能终止 Node ──────────────────────────────
//
// Node 跑在 App 自己的进程里（见文件头 ③）：一次未捕获异常默认会结束整个
// Node 运行时 —— 等于**整个 App 跟着死**，而不只是"服务端没了"。所以把两类
// 致命事件都降级成一行日志、继续运行：HTTP 层不死，前端那条原生兜底链路
// 也就不会被触发。只记日志、不 process.exit；bootstrap 里长期只放这一组
// process.on，别在别处再 exit。
process.on('uncaughtException', (error) => {
    console.error('[bootstrap] 未捕获异常（已兜底，继续运行）：'
        + String((error && error.stack) || error));
});
process.on('unhandledRejection', (reason) => {
    console.error('[bootstrap] 未处理的 Promise 拒绝（已兜底，继续运行）：'
        + String((reason && reason.stack) || reason));
});

/**
 * 实际监听到的端口。绑 0 号端口时最终是哪个只有内核知道，
 * 所以先占位，等 listen 回调拿到真实值再填。
 */
let port = 0;

/**
 * 放行跨源请求。
 *
 * 回显 Origin 而不是写死 `*`：页面只有一个来源（https://localhost），
 * 回显既够用，又不会把接口敞开给任意网页。
 */
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

// ── 日志系统（与电脑端 serve.mjs 同构的手机版）──────────────────────────
//
// 手机版的处境：WebView 里没有控制台可看，日志不落盘就等于没发生。这一段把
// 电脑端 serve.mjs 的日志链路搬到 bootstrap：内存环形缓冲（/api/logs/tail 的
// 数据源，软件内日志查看器直接可用）+ 主日志/追踪日志双文件落盘（adb pull
// 可取走）。**查询形状与 serve.mjs 逐字对齐**（消费方是同一个 log-viewer.js），
// 桌面专属的部分不复刻：loc 行号提取（stack 抓帧）、IP 归属（手机端全部来自
// 同一个 WebView，Origin 门之外没有可区分的来源）、控制台级别过滤（logcat
// 全量，级别过滤只会把信息挡在 logcat 之外）。
//
// 落盘策略与常量照抄 serve.mjs（O-4 已核实可原样沿用）：每次启动一组
// <启动时刻>.log / .trace.log；单文件超 LOG_MAX_BYTES 拆 _2/_3；只保留最近
// LOG_KEEP 次启动。同步写（appendFileSync）—— 天然串行、不会交错断行，
// 别改成 await appendFile。
const LOG_DIR = dataDirectory ? path.join(dataDirectory, 'logs') : '';
const LOG_KEEP = 10;                       // 保留最近多少次启动的日志
const LOG_MAX_BYTES = 8 * 1024 * 1024;     // 单个日志文件上限，超出拆 _2/_3
const LOG_TO_FILE = String(process.env.LOG_TO_FILE ?? '1') !== '0' && Boolean(LOG_DIR);
// 对话追踪日志开关：默认开（LOG_CHAT=0 关掉，自动化检查可用来构造"关"的场景）
const traceEnabled = String(process.env.LOG_CHAT ?? '1') !== '0';

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');
/** 时刻 → 文件名段（本地时间，秒级；文件名要能当路径用） */
function logStampFor(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
        + `_${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`;
}
/** 时刻 → 日志行里的 `YYYY-MM-DD HH:mm:ss.SSS`（毫秒：同秒十几条日志要能分先后） */
function logTimeFull(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
        + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
        + `.${pad3(date.getMilliseconds())}`;
}
/** 时刻 → stdout（logcat）用的 `HH:mm:ss.SSS` */
function logTimeShort(date = new Date()) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
        + `.${pad3(date.getMilliseconds())}`;
}

// 级别（四位短码 + 别名收敛，均与 serve.mjs / log-viewer.js 同一套词表）
const LEVEL_SHORT = { DEBUG: 'DBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERRO', CRITICAL: 'CRIT' };
const LEVEL_NUM = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, CRITICAL: 50 };
const LEVEL_INPUT_ALIASES = {
    DBUG: 'DEBUG', DEBUG: 'DEBUG',
    INFO: 'INFO', INFORMATION: 'INFO',
    WARN: 'WARN', WARNING: 'WARN',
    ERRO: 'ERROR', ERR: 'ERROR', ERROR: 'ERROR',
    CRIT: 'CRITICAL', CRITICAL: 'CRITICAL', FATAL: 'CRITICAL',
};
/** 把任意写法收敛成标准级别名；非法值返回 null */
function normalizeLevelName(raw) {
    return LEVEL_INPUT_ALIASES[String(raw || '').trim().toUpperCase()] || null;
}

// 模块名归一化（与 serve.mjs 的 TAG_ALIASES 同一张表的子集 + 相同的兜底规则）
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
    // 未知标签原样保留（首字母大写），免得新写的标签被悄悄吞掉
    return key.length <= 12 ? key[0].toUpperCase() + key.slice(1) : 'Core';
}

// 写进缓冲与日志文件的文本要脱敏 —— 与 serve.mjs 的 SECRET_RULES 同一套正则。
// 前端报错里常带请求体/响应体，明文 API Key 会跟着进文件与查看器；缓冲经
// /api/logs/tail 提供出去，与文件同一口径。
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

// ---- 两个 sink 的文件状态（结构照抄 serve.mjs：part 管大小拆分）----
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

/** 追加一段文本到某个 sink，超大小上限就换下一段 */
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

/** 只保留最近 LOG_KEEP 次启动（同一次启动的主日志与追踪日志一起留、一起删） */
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

// 软件内日志查看器的数据源：每条都收，不受级别约束（过滤在读的时候做）
const logBuffer = createLogBuffer();

// 包装 console 之前先留一份原件：日志系统自己输出时要用它，否则会递归。
// traceLine 的 stdout 也走原件 —— 它的内容只属于追踪日志，
// 走重挂后的 console 会把全文灌进主日志与缓冲。
const consoleOriginal = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
};

/**
 * 写一条主日志。消息开头的 `[标签]` 抽成 tag 字段（与 serve.mjs 的 emitLog
 * 同一套约定：调用点写 `console.log('[relay] …')`，输出即结构化）。
 */
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
        // 多行保留换行、后续行不再重复前缀（与 serve.mjs 的 formatForFile 同取舍：
        // 无条件压成一行会毁掉异常栈这类多行诊断块）
        const lines = safe.split('\n');
        const rest = lines.slice(1).map((l) => l.replace(/\s+$/, ''));
        appendToFile(mainSink, head + lines[0].replace(/\s+$/, '') + (rest.length ? '\n' + rest.join('\n') : '') + '\n');
    }
    // stdout → logcat。不带 ANSI 色（logcat 不是终端）；这个通道保持全量，
    // `adb logcat | grep ELAINA` 永远能看到一切
    consoleOriginal[level === 'DEBUG' ? 'log' : (level === 'ERROR' ? 'error' : (level === 'WARN' ? 'warn' : 'log'))](
        `[${logTimeShort(now)}] [${tag}] [${short}]: ${body}`);
}

// 重挂 console：bootstrap 与共享模块（relay.mjs 等）内部的所有 console 输出
// 自动进 缓冲 + 主日志文件 + logcat，与电脑端 serve.mjs 同一条链路。
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

/**
 * 追踪日志：中继的完整请求/回复、前端上报的报错全文。
 * 只写 traceSink 文件（多行原样保留），不进缓冲 —— 摘要行由调用方走
 * console.log 进主日志；stdout 用原件再打一份（logcat 保留一条活路）。
 */
function traceLine(text) {
    if (!traceEnabled) return;
    const body = String(text ?? '');
    if (!body.trim()) return;
    appendToFile(traceSink, `[${logTimeFull()}] ${redactSecrets(body)}\n`);
    consoleOriginal.log('[trace] ' + body);
}

// ── mod 服务端半边装载（与电脑端 serve.mjs 同构）────────────────────────
//
// manifest.server 声明的服务端半边在电脑端由 serve.mjs 装载；手机端缺这条
// 装载路径时，唯一带 server 半边的 live2d-models 只能被前端硬编码复刻，宿主
// 认识了具体插件，违背「宿主不认识任何具体插件」的定位。这里装载的就是
// server/mod-server.mjs **本尊**（能力声明 need()/超时/回滚全套生效），
// 任何声明了 server 半边的插件在手机上都能跑。
//
// 目录布局（2.4）：Capacitor Directory.Data = filesDir，原生插件装在
// filesDir/mods/<manifest.id>/，而本进程的数据目录是 filesDir/elaina-data ——
// 所以 path.resolve(dataDirectory, '..', 'mods') 就是插件根，零迁移可见；
// filesDir/store.json（前端 store.js 原生后端写的）同样直接可读。
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
    // bootstrap 不做静态文件服务（静态资源走 WebView 的 _capacitor_file_ scheme），
    // 但插件之间撞名检查仍然生效（由 mod-server 内部做）
    hostStaticPrefixes: [],
    jsonResponse: sendJson,   // 签名相同（res, code, obj），对齐 sendJson 的 Content-Length 行为
    readJsonBody,
    // 与 serve.mjs 接线同一形状的宿主共享工具（实现全部来自 server/zip.mjs，
    // 两端同一份 —— 数字或判定分叉就是"电脑能传、手机 413"）
    hostUtils: {
        readZip: (buf, opts) => readZip(buf, { ...opts, returnBlocked: true }),
        isUnsafeEntryName,
        effectiveExt,
        MAX_UPLOAD,
    },
    log: (msg) => console.log('[Mod] ' + msg),
});

/** mod 装载是否已有结论（loadAll 返回后置 true，含"零插件"与"全部失败"） */
let modsLoaded = false;
/** 扫描出的已安装插件：[{ id, dir, manifest }]（dir 是目录名，非路径） */
let installedMods = [];

/**
 * 扫插件根：逐目录读 manifest.json（**纯读 JSON，不执行任何插件代码**）。
 * 返回**展开的 manifest 形状**（{...manifest, id, dir}）—— 与 serve.mjs 的
 * scanAndSync 输出同构：modServer 的 loadAll/loadOne/status 都从条目顶层读
 * `server` 声明与 `dir` 字段，嵌套一个 manifest 键它们就读不到（表现为
 * "发现 N 个插件、全部静默不装载"）。身份判定对齐 server/mods.mjs 的
 * readManifest：manifest.id 合法则以它为身份，否则回落目录名。
 */
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
 * 读启用状态：filesDir/store.json（前端 store.js 原生后端写的，一层扁平
 * `键 → 字符串`，O-3 已核实）。两段判定**都必须复刻**（F-13）：
 *   总开关 elaina_plugins_enabled !== '0'（缺省 = 开）
 *   且 per-id elaina_plugin_<id> === '1'（缺键看 manifest.defaultEnabled === true）
 * 只判 per-id 会漏"用户一键关了插件系统"；只判总开关会让停用的插件服务端照活。
 */
async function readEnabledState() {
    try {
        const raw = await readFile(path.join(FILES_ROOT, 'store.json'), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }   // 首次运行 / 文件不存在 = 全部默认
}

/**
 * 静态解析：收集**已启用**插件的 server.static 声明 → { URL前缀: 绝对目录 }。
 * 用 modServer.readDeclaration 解析（同一份实现，不另写一套）；只读 manifest，
 * 不执行插件代码 —— 迁移的判据必须是"纯数据"，等装载结果就晚了（装载时
 * models/ 还不存在，可能直接装载失败，失败后 status() 不再给静态声明）。
 */
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
 * 旧位置模型迁移：filesDir/live2d/models/<名> → 插件目录（与桌面同一布局，
 * server.mjs 一份代码两端跑）。目标目录由静态映射决定，判据是"谁声明了
 * /live2d/models"**不点名插件 id** —— 目录名带版本后缀，写死必错（F-21）。
 * 没有该声明（插件没装 / 被停用）→ 整体跳过：停用时前端回落原生复刻，
 * 复刻只认旧位置，模型必须留在原地。目标已存在则跳过（用户后装的同名
 * 模型优先）；fs.rename 同 filesDir 零拷贝；第二次启动时旧位置已空 → 幂等。
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
 * 装载全部已安装、已启用的插件服务端半边。固定三段顺序（D-8，不得调换）：
 *   ① 静态解析（纯读 manifest）→ ② 迁移（目标由静态映射决定）→ ③ loadAll。
 * 末尾无论结果如何都把 modsLoaded 置 true —— 前端靠它区分"装载中"与
 * "装载完（哪怕全失败）"，等不到结论就会把空清单当终态缓存下来。
 */
async function loadMods() {
    installedMods = await scanInstalledMods();
    if (installedMods.length) console.log('[Mod] 发现 ' + installedMods.length + ' 个已安装插件');
    const store = await readEnabledState();
    // 两段判定（F-13）：总开关 !== '0' 且 per-id === '1'（缺键看 defaultEnabled === true）。
    // 条目是展开的 manifest 形状，defaultEnabled 就在顶层。
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
 * 手机上**真正的边界**：只认页面自己发来的请求。
 *
 * 为什么不能像电脑端那样靠"是不是本机请求"（net-guard 的 isLocalRequest）：
 * 安卓的 127.0.0.1 是**整机共享**的 —— 同一个设备上任何别的 App 都能连到这个端口，
 * 而它们连过来时 remoteAddress 同样是 127.0.0.1，于是那套判定在手机上恒真、
 * SSRF 那两道校验根本不会触发。"只绑回环"挡不住同机的其它 App。
 *
 * 所以这里按 Origin 收：
 *   · WebView 里的页面是 https://localhost，它发起的**跨源**请求一定带这个 Origin；
 *   · 别的 App / adb 里的命令行工具要么不带 Origin，要么带的是别的值 → 直接拒。
 *
 * 代价写在明处：不带 Origin 的本机请求也会被拒 —— 原生插件因此在
 * stop() 里显式补了这个头（见 ElainaNodePlugin.stop）。要临时调试的话，
 * 别把这道门整个拆掉，改这里加白名单更安全。
 */
const ALLOWED_ORIGIN = 'https://localhost';
const originAllowed = (request) => String(request.headers.origin || '') === ALLOWED_ORIGIN;

/**
 * 本地中继 —— 用的是与电脑端**同一份**实现（server/relay.mjs）。
 *
 * 电脑端靠它绕开浏览器的 CORS（大量中转站不发 Access-Control-Allow-Origin）；
 * 手机上处境一模一样：页面在 https://localhost，而这里是 http://127.0.0.1:<随机端口>，
 * 天生跨源。而且它还带来一个额外好处 —— Node 侧是真流式，SSE 能逐块透传
 * （走原生 HTTP 插件那条路是攒完再回，增量就没了）。
 */
const relayHandler = createRelay({
    // 追踪日志：多行全文只进 traceSink 文件（见 traceLine 的说明）；
    // 摘要行由 relay 内部的 console.log/warn/error 走重挂后的 console，
    // 自动进 缓冲 + 主日志 + logcat —— 与电脑端 serve.mjs 同一条链路（U-1 结论）。
    traceLine,
    // 这三个判定用的是与电脑端同一份实现（net-guard）。手机上它们天然短路
    // （见上面关于回环是整机共享的说明），仍然传真的实现而不是空壳 ——
    // 将来谁改了监听地址，这道防线会立刻开始生效。
    isLocalRequest,
    isLoopbackHostname,
    isInternalAddress,
});

const server = http.createServer(async (request, response) => {
    applyCorsHeaders(request, response);

    // 预检请求不带业务语义，直接放行（预检不带 Origin 之外的凭据，放行它是安全的）
    if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
    }

    // 进任何路由之前先过这道门 —— 见 ALLOWED_ORIGIN 的说明
    if (!originAllowed(request)) {
        sendJson(response, 403, {
            ok: false,
            message: '只接受来自本应用页面的请求（缺少正确的 Origin）',
        });
        return;
    }

    // 只要路径，用一个固定 base 解析即可 —— 端口是动态的，没必要进这个字符串
    const pathname = new URL(request.url, `http://${HOST}`).pathname;

    // 本地中继：与电脑端同一条路（server/relay.mjs），跨源请求都在这里发出
    if (pathname === '/api/relay' && request.method === 'POST') {
        return relayHandler.handleRelay(request, response);
    }

    // ── 日志系统（查询语义与 serve.mjs 逐字对齐；消费方是同一个 log-viewer.js）──

    // 前端日志上报：WebView 里 console.error / 未捕获异常经 sendBeacon 进来。
    // **不校验 Content-Type** —— 前端的 beacon 补丁故意发 text/plain（免跨源预检，
    // 页面卸载时预检常常来不及回来），这里按 JSON 解析即可。
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
            // 主日志压成一行（截 2000 字，同桌面），完整原文进追踪日志
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

    // 日志查看器的数据源：内存缓冲按条件取。
    // 查询参数（可选）：level（最低级别）/ tags（逗号分隔）/ search / limit /
    // since + sinceSeq（增量游标，两个值必须成对 —— 只传时间戳会丢同毫秒记录，
    // 详见 server/log-buffer.mjs 的 query）。
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

    // 日志设置（最小形状：只读状态；POST 运行时调整电脑端才有，暂缓 ——
    // 手机端没有前端消费方，先保证形状可探测）
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
        // modsLoaded/modRoutes/modStatic：mod 装载的结论与清单。前端轮询
        // ping 直到 modsLoaded === true 才缓存清单 —— 先到的 ping 必然看到
        // 空清单（loadAll 在 listen 之后），把它当终态就永远是空的（D-6）。
        // modRoutes 取**声明前缀**（status().mods[].routes 的并集），不是
        // 具体端点 —— 前端按段边界匹配前缀，给它具体端点会漏掉同前缀的其它端点。
        // modStatic 的 relPath 相对 filesDir（前端 Filesystem 直接可用），
        // 绝对路径只留在服务端。
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

    // mod 装载状态：排障与后续功能用（D-7 —— 不塞进 /api/plugins：那是前端
    // 原生实现的地盘，拼一个"从 node 抄来的字段"等于两处状态迟早漂移；
    // 也不塞进 ping：status 含 N 个插件的明细，200ms 级探针不该变胖）
    if (pathname === '/api/mods/status' && request.method === 'GET') {
        sendJson(response, 200, { ok: true, modsLoaded, ...modServer.status(installedMods) });
        return;
    }

    if (pathname === '/api/shutdown' && request.method === 'POST') {
        sendJson(response, 200, { ok: true, stopping: true });
        // 关掉监听、断掉已有的 keep-alive 连接，让事件循环空掉 ——
        //   node::Start 随之返回，Java 那边的线程结束，App 进程留着。
        //   不用 process.exit()（见文件头 ③）。
        server.close();
        if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
        }
        return;
    }

    // mod 路由分发：排在 bootstrap 自身路由**之后**（宿主永远优先，撞名在
    // 装载期已拒绝，这里是第二道保险）。返回 true = 已处理、响应已写出。
    if (await modServer.handle(request, response, { pathname, url: request.url })) {
        return;
    }

    sendJson(response, 404, { ok: false, error: 'no such endpoint', path: pathname });
});

server.on('error', (error) => {
    // 起不来要让原生侧看见：写进 stderr，会被转发成 logcat 的 ERROR
    console.error('内嵌 Node 服务启动失败：', error && error.message ? error.message : error);
});

// ② mod 装载：listen 之前发起（异步进行，不阻塞端口回传）；ping 的
//    modsLoaded 标志让前端能等到结论。失败也置 modsLoaded ——
//    "全部装载失败"同样是结论，前端不该为一个坏插件等满 10s。
if (MODS_DIR) {
    loadMods().catch((error) => {
        console.error('[Mod] 装载流程失败（已隔离）：' + String((error && error.message) || error));
        modsLoaded = true;
    });
}

server.listen(requestedPort, HOST, () => {
    port = server.address().port;
    // 这一行同时进 缓冲/主日志/logcat —— 日志页刷新后能看到"服务这一半活着"
    console.log(`[Core] embedded node listening on http://${HOST}:${port} (pid ${process.pid}, ${process.version})`);
    // ① 端口回传。写完整行 + 换行，原生侧按行解析。
    //   **必须**用 process.stdout.write 直写：console.log 已被日志系统重挂，
    //   输出会带上时间戳前缀，原生侧按 READY_PREFIX 解析就匹配不上了。
    process.stdout.write(`${READY_PREFIX}${JSON.stringify({
        port,
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        dataDirectory,
    })}\n`);
});
