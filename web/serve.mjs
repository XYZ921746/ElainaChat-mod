import {
    createReadStream, appendFileSync, mkdirSync, renameSync, statSync, lstatSync,
    readdirSync, rmSync, existsSync, readFileSync, writeFileSync,
} from 'node:fs';
import { stat, lstat, mkdir, writeFile, readFile, readdir, rm, rename } from 'node:fs/promises';
import { createServer, get as httpGet } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { createServer as createNetServer, createConnection } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, scrypt, createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify, inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import dns from 'node:dns';
import { createStore } from '../server/store.mjs';
import { createModManager } from '../server/mods.mjs';
// 技能（skill）是给 AI 的纯文本指令，与插件分开管理、走独立的 /api/skills（见 server/skills.mjs）
import { createSkillManager } from '../server/skills.mjs';
// 备份时把插件 / 技能目录与 data/ 键值合进同一个 zip（见 server/backup-packages.mjs）
import { createPackageBackup } from '../server/backup-packages.mjs';
import { createLanShare, LAN_SHARE_PREFIX } from '../server/lan-share.mjs';
// 版本检测：查 GitHub 最新 Release（见 server/update-check.mjs）；可注入 fetch/时钟，便于穷举断言
import { createUpdateChecker } from '../server/update-check.mjs';
// 插件的服务端半边：按 manifest.json 的 server 声明装载路由与上传目录（见 server/mod-server.mjs）
import { createModServer } from '../server/mod-server.mjs';
// MCP 客户端：把外部 MCP 服务器的工具接进 AI 工具清单；只做客户端方向（见 server/mcp-registry.mjs）
import { createMcpRegistry } from '../server/mcp-registry.mjs';
// 电脑活动摘要（前台窗口 + 进程），供桌宠使用（见 server/activity.mjs）
import { activitySummaryCached } from '../server/activity.mjs';
// 电脑命令执行：危险命令判定是纯函数，单独成模块便于穷举断言（见 server/pc-command.mjs）
import { classifyCommand, runCommand, formatCommandResult, availableShells } from '../server/pc-command.mjs';
// 登录防爆破与密码强度：局域网可执行命令之后，密码是唯一防线（见 server/auth-guard.mjs）
import { createLoginGuard, validatePasswordStrength, PWD_MIN_LEN } from '../server/auth-guard.mjs';
// zip 解压与安全判定唯一实现在 server/zip.mjs（上限、危险扩展名、GBK、zip64）；这里只是薄包装
import { readZip, BLOCKED_EXT, effectiveExt, isUnsafeEntryName, MAX_UPLOAD } from '../server/zip.mjs';
import { banner } from '../server/diagnostics.mjs';
// 内存日志缓冲：软件内日志查看器的数据源（控制台全量、界面筛着看）。
import { createLogBuffer } from '../server/log-buffer.mjs';
// jsonResponse / readJsonBody：通用 HTTP 小工具，手机端内嵌 Node 要共用同一份（见 server/http-util.mjs）
import { jsonResponse, readJsonBody } from '../server/http-util.mjs';
// 本地中继：两端共用一份实现（见 server/relay.mjs），这里只接上本机日志与安全判定
import { createRelay } from '../server/relay.mjs';
// 网络边界判定（本机 / 回环 / 内网），手机端中继共用同一份（见 server/net-guard.mjs）
import { isLocalRequest, isLoopbackHostname, isPrivateIPv4, isInternalAddress } from '../server/net-guard.mjs';
// AI 用浏览器：真开 Chrome / Edge 操作页面；与 pc-command 分开是刻意的（见 server/browser.mjs）
import { createBrowserSession, runBrowserAction, findBrowserExecutable } from '../server/browser.mjs';

const scryptAsync = promisify(scrypt);

const root = path.dirname(fileURLToPath(import.meta.url));
// 应用根目录（web 的上一级）：端侧数据与证书都放这里；它在静态根 web/ 之外，不会被直接下载走
const APP_ROOT = path.resolve(root, '..');
// DATA_DIR 可用环境变量覆盖：自动化检查要跑真实读写，不能落到用户真实 data/
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(APP_ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const STORE_MAX_BYTES = 32 * 1024 * 1024; // 端侧数据（聊天记录等）单次提交上限
// 单个键超限必须**报错**而不是丢弃：聊天记录全在一个键里，丢弃等于"保存成功但什么都没写"
const STORE_KEY_MAX_CHARS = 8 * 1024 * 1024;

// 配置文件放在 DATA_DIR/config.json；ELAINA_CONFIG_FILE 可覆盖（检查用临时文件）。
const CONFIG_FILE = process.env.ELAINA_CONFIG_FILE
    ? path.resolve(process.env.ELAINA_CONFIG_FILE)
    : path.join(DATA_DIR, 'config.json');

let FILE_CONFIG;
try {
    FILE_CONFIG = loadServerConfig(CONFIG_FILE);
} catch (err) {
    console.error('[boot] CRITICAL: ' + String((err && err.message) || err));
    process.exit(1);
}
ensureSampleConfig();

// 默认监听 0.0.0.0：局域网内其他设备可通过 http://<本机IP>:4173 访问；HOST 环境变量可覆盖（如 127.0.0.1 仅本机）。
const host = process.env.HOST || FILE_CONFIG.host || '127.0.0.1';
/**
 * 端口默认从 3999 起、被占用就往上找；显式传 PORT（或配置里给了具体端口）时按给定端口、占用即报错退出
 * （自动化检查各自传临时端口，静默漂移会断言对不上、并发用例会互抢端口）。
 */
const PORT_ENV = process.env.PORT !== undefined && String(process.env.PORT).trim() !== '';
const PORT_EXPLICIT = PORT_ENV || (FILE_CONFIG.portSet && FILE_CONFIG.port > 0);
const PORT_START = Number(PORT_ENV ? process.env.PORT : (PORT_EXPLICIT ? FILE_CONFIG.port : 3999));
// HTTPS 默认开；配置或环境变量可关掉（纯 HTTP，不生成/读取证书）。
const HTTPS_ENABLED = (() => {
    const raw = process.env.ELAINA_HTTPS;
    if (raw !== undefined && String(raw).trim() !== '') {
        return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
    }
    return FILE_CONFIG.https !== false;
})();
const CERT_PATHS = resolveCertPaths();
/** 往上最多找多少个端口（3999 → 4098）。够用，又不至于卡住启动。 */
const PORT_SCAN_SPAN = 100;
/** 本项目另一实例已在跑时的退出码：启动.bat 认这个码就不再 pause（此分支没有服务可看） */
const EXIT_ALREADY_RUNNING = 3;

// 未显式传 PORT 时先探测：本项目实例占端口就复用并退出（见 isOurInstance），别的软件占着就往后换端口；检查脚本各自传 PORT。
if (!PORT_EXPLICIT) {
    try {
        const running = await findRunningInstance(PORT_START, PORT_SCAN_SPAN);
        if (running) {
            console.log(`[boot] another instance is already running on port ${running} - reusing it`);
            openBrowser('http://127.0.0.1:' + running);
            process.exit(EXIT_ALREADY_RUNNING);
        }
    } catch (err) {
        console.warn('[boot] 检查已有实例失败，按新实例继续：' + String((err && err.message) || err));
    }
}

// 插件（mod）根目录：xxx.zip 丢进来即自动解压写进 index.json；它在静态根 web/ 之外，必须另有显式 /mods/ 路由否则全 404；MODS_DIR 可覆盖。
const MODS_DIR = process.env.MODS_DIR
    ? path.resolve(process.env.MODS_DIR)
    : path.join(root, '..', 'mods');

// 技能（skill）根目录：与 MODS_DIR 平级、不在静态根内，只经 /api/skills 暴露；SKILLS_DIR 同样可覆盖以隔离自动化检查。
const SKILLS_DIR = process.env.SKILLS_DIR
    ? path.resolve(process.env.SKILLS_DIR)
    : path.join(root, '..', 'skills');

/** 该路径是否是禁止在应用文件夹内写入的危险类型 */
function isBlockedWritePath(target) {
    return BLOCKED_EXT.has(effectiveExt(path.basename(String(target || ''))));
}

// 日志系统：格式参照 AstrBot（控制台 [HH:mm:ss.SSS] [标签] [级别] [来源:行号]: 消息，文件带完整日期；级别四位、WARN 及以上附版本号、本地时间）；主日志一行一条便于 grep，追踪日志存完整对话；每次启动一组文件、超限拆 _2/_3、只留 LOG_KEEP 次；不记请求头；LOG_DIR 可覆盖。
const LOG_DIR = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(DATA_DIR, 'logs');
const LOG_KEEP = 10;                       // 保留最近多少次启动的日志
const LOG_MAX_BYTES = 8 * 1024 * 1024;     // 单个日志文件上限，超出拆 _2/_3
const LOG_TO_FILE = String(process.env.LOG_TO_FILE ?? '1') !== '0';
// 完整对话是否写追踪日志（LOG_CHAT=0 关掉）；只作初始值，运行期在 设置 → 高级 → 日志 切换（traceEnabled）
const LOG_CHAT = String(process.env.LOG_CHAT ?? '1') !== '0';
// （本条日志与追踪日志的几个大小上限在 server/relay.mjs —— 它们只服务于中继。）

// 文件名：<时刻>.log / <时刻>.trace.log / <时刻>_2.log / <时刻>.trace_2.log / <时刻>-2.log（同秒再起一个实例）
const LOG_NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:[-._][A-Za-z0-9]+)*\.log$/;
const LOG_STAMP_LEN = 19;                  // `YYYY-MM-DD_HH-mm-ss` 的长度，用来按"启动"分组

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');
/** 时刻 → 文件名里的那一段（本地时间）。**不含毫秒** —— 文件名要能当路径用，越短越好 */
function logStampFor(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
        + `_${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`;
}
/**
 * 时刻 → 日志行里的 `YYYY-MM-DD HH:mm:ss.SSS`。
 * 带毫秒：一次启动连打十几条日志，秒级精度分不出先后；文件名仍用秒级（logStampFor）。
 */
function logTimeFull(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
        + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
        + `.${pad3(date.getMilliseconds())}`;
}
/** 时刻 → 控制台用的 `HH:mm:ss.SSS` */
function logTimeShort(date = new Date()) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
        + `.${pad3(date.getMilliseconds())}`;
}

// 级别（四位，对齐 AstrBot short_levelname）
const LEVEL_SHORT = { DEBUG: 'DBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERRO', CRITICAL: 'CRIT' };
const LEVEL_NO = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, CRITICAL: 50 };
// 级别从低到高。对外（设置界面 / API）一律用这套全名，短名只出现在日志行里。
const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];
// 用户可能填 AstrBot 那套短名或 logging 的全名，统一收敛
const LEVEL_INPUT_ALIASES = {
    DBUG: 'DEBUG', DEBUG: 'DEBUG',
    INFO: 'INFO', INFORMATION: 'INFO',
    WARN: 'WARN', WARNING: 'WARN',
    ERRO: 'ERROR', ERR: 'ERROR', ERROR: 'ERROR',
    CRIT: 'CRITICAL', CRITICAL: 'CRITICAL', FATAL: 'CRITICAL',
};

// 落盘级别：控制台 sink 恒看全量、文件 sink 按级别过滤；级别不是用户配置也不持久化到磁盘，只认"环境变量 > 默认"两档，运行期可经 /api/logs/settings 临时改。
let fileLevel = 'INFO';        // 当前落盘级别（低于它的记录只进控制台）
let traceEnabled = LOG_CHAT;   // 对话追踪日志开关（默认开；LOG_CHAT=0 可关）

/** 把任意写法收敛成标准级别名；非法值返回 null（调用方决定回落到什么） */
function normalizeLevelName(raw) {
    return LEVEL_INPUT_ALIASES[String(raw || '').trim().toUpperCase()] || null;
}

// 控制台级别：请求日志是 DEBUG 级，全量会把终端刷成每个请求一行；consoleLevel=DEBUG 看全部、INFO（默认）日常干净；内存缓冲不受级别约束。
let consoleLevel = 'INFO';

// 初始化只读环境变量（理由见上面 fileLevel 那段），环境变量优先是刻意的 —— 自动化检查要能强制指定级别。
{
    fileLevel = normalizeLevelName(process.env.LOG_LEVEL) || 'INFO';
    consoleLevel = normalizeLevelName(process.env.LOG_CONSOLE) || 'INFO';
}

/** 当前级别是否该落盘 */
function shouldLogToFile(level) {
    return (LEVEL_NO[level] || 20) >= (LEVEL_NO[fileLevel] || 20);
}

function shouldLogToConsole(level) {
    return (LEVEL_NO[level] || 20) >= (LEVEL_NO[consoleLevel] || 20);
}

function setConsoleLevel(next) {
    const level = normalizeLevelName(next);
    if (!level || level === consoleLevel) return false;
    consoleLevel = level;
    return true;
}

/** 运行中改落盘级别。返回是否真的变了（没变就不用重挂 sink / 写盘） */
function setFileLogLevel(next) {
    const level = normalizeLevelName(next);
    if (!level || level === fileLevel) return false;
    fileLevel = level;
    return true;
}

/**
 * 运行中开关对话追踪日志（只有 /api/logs/settings 会调它）。
 * 打开时若文件还没建过就补建一个，否则调用方打开开关、去目录里找却什么都没有。
 */
function setTraceEnabled(on) {
    const next = Boolean(on);
    if (next === traceEnabled) return false;
    traceEnabled = next;
    if (next && LOG_TO_FILE && !traceSink.file) {
        try {
            traceSink.file = sinkPath(traceSink);
            appendFileSync(traceSink.file, '');
        } catch { /* 建不出来就只影响追踪日志 */ }
    }
    return true;
}
// AstrBot 的级别色：DEBUG 亮蓝 / INFO 亮青 / WARN 亮黄 / ERROR 红 / CRIT 亮红
const LEVEL_COLOR = {
    DEBUG: '\x1b[1;34m', INFO: '\x1b[1;36m', WARN: '\x1b[1;33m',
    ERROR: '\x1b[31m', CRITICAL: '\x1b[1;31m',
};
const ANSI_RESET = '\x1b[0m';
const ANSI_TIME = '\x1b[32m';   // 时间绿色，同 AstrBot 的 <green>{time}</green>
const ANSI_LOC = '\x1b[90m';    // 来源位置压暗：它是排查用的元信息，不该和正文抢注意力
// 正文按级别上色：长日志里不必逐行读级别列，扫颜色就能分出提示与报错。INFO 用终端默认前景色，深底浅底都可读。
const BODY_COLOR = {
    DEBUG: '\x1b[90m', INFO: '', WARN: '\x1b[33m',
    ERROR: '\x1b[91m', CRITICAL: '\x1b[1;91m',
};
// 模块配色：一条日志里时间（绿）、模块（按名字）、级别（按严重度）、正文（随级别）各占一色。
// 固定模块用固定色（排查时"绿的那条是 Chat"能形成肌肉记忆），插件等新模块按名字散列，保证同一模块每次都是同一种颜色。
const TAG_PALETTE = [
    '\x1b[38;5;111m', '\x1b[38;5;141m', '\x1b[38;5;114m', '\x1b[38;5;180m',
    '\x1b[38;5;116m', '\x1b[38;5;176m', '\x1b[38;5;151m', '\x1b[38;5;147m',
    '\x1b[38;5;210m', '\x1b[38;5;117m', '\x1b[38;5;144m', '\x1b[38;5;182m',
];
const TAG_FIXED = {
    Core: 0, Relay: 1, Chat: 2, Agent: 3, Store: 4, HTTP: 5, Mod: 6, Auth: 7,
    Cert: 8, MCP: 9, Skill: 10, TTS: 11, ASR: 11, Vision: 9, Page: 4, Live2D: 2,
};
/** 模块名 → 颜色码；散列只是兜底，固定表保证常见模块的颜色稳定可记 */
function tagColor(tag) {
    const fixed = TAG_FIXED[tag];
    if (fixed !== undefined) return TAG_PALETTE[fixed];
    let h = 0;
    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
    return TAG_PALETTE[h % TAG_PALETTE.length];
}

// 版本号：WARN 及以上附在级别后（同 AstrBot 的 astrbot_version_tag）；打包形态里 package.json 在 asar 内，桌面壳通过 APP_VERSION 传版本号。
let APP_VERSION = process.env.APP_VERSION || '0.0.0';
if (!process.env.APP_VERSION) {
    try {
        APP_VERSION = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || APP_VERSION;
    } catch { /* 读不到就算了 */ }
}

// 运行形态：桌面壳通过 ELAINA_EDITION 告知（目前只认 windows），版本检测据此给对应安装包，未知值一律当 web。
const APP_EDITION = (() => {
    const raw = String(process.env.ELAINA_EDITION || '').trim().toLowerCase();
    return raw === 'windows' ? raw : 'web';
})();

// 消息开头的 [xxx] 抽出来当标签、正文不再重复，调用点照旧写 console.log('[relay] ...')；散落的标签在这里收敛成固定词汇。
const TAG_ALIASES = {
    boot: 'Core', log: 'Core', store: 'Store', relay: 'Relay', live2d: 'Live2D',
    agent: 'Agent', chat: 'Chat', http: 'HTTP', page: 'Page',
    鉴权: 'Auth', auth: 'Auth', https: 'Cert', tls: 'Cert', cert: 'Cert',
    tts: 'TTS', asr: 'ASR', vision: 'Vision',
};
function normalizeTag(raw) {
    const key = String(raw || '').trim();
    if (!key) return 'Core';
    const hit = TAG_ALIASES[key] || TAG_ALIASES[key.toLowerCase()];
    if (hit) return hit;
    // 未知标签原样保留（首字母大写），免得新写的标签被悄悄吞掉
    return key.length <= 12 ? key[0].toUpperCase() + key.slice(1) : 'Core';
}

// 来源位置：取调用栈里第一条不属于日志模块自己的帧（跳过内部帧，否则每条日志都指向 emitLog 自己）；patchedConsoleLog 是下面包装函数的名字。
const LOG_INTERNAL_FNS = new Set(['emitLog', 'appendToFile', 'captureLocation', 'patchedConsoleLog', 'traceLine', 'logCritical']);
function captureLocation() {
    try {
        const lines = String(new Error().stack || '').split('\n');
        for (let i = 1; i < lines.length; i++) {
            const m = lines[i].match(/at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/);
            if (!m) continue;
            // 被赋成 console.log 之后，V8 把函数名渲染成 console.patchedConsoleLog [as log]；不剥掉这个后缀就过不了内部帧判定。
            const rawFn = (m[1] || '').replace(/\s*\[as\s+[^\]]*\]\s*$/, '').trim();
            if (LOG_INTERNAL_FNS.has(rawFn) || LOG_INTERNAL_FNS.has(rawFn.replace(/^.*\./, ''))) continue;
            const file = m[2].replace(/\\/g, '/');
            if (!file || file.startsWith('node:')) continue;
            const base = file.split('/').pop().replace(/\.(mjs|cjs|js)$/, '');
            if (!base) continue;
            return base + ':' + m[3];
        }
    } catch { /* 拿不到行号不影响日志本身 */ }
    return 'serve.mjs:?';
}

// 控制台是否上色：ELAINA_LOG_COLOR 显式覆盖（强制开/关），否则 hasColors() 尊重 NO_COLOR / FORCE_COLOR；非 TTY 时返回 false，重定向不会带转义码。
const CONSOLE_COLOR = (() => {
    try {
        const override = String(process.env.ELAINA_LOG_COLOR || '').trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(override)) return true;
        if (['0', 'false', 'no', 'off'].includes(override)) return false;
        if (!process.stdout.isTTY) return false;
        if (typeof process.stdout.hasColors === 'function') return process.stdout.hasColors();
        return !process.env.NO_COLOR;
    } catch { return false; }
})();

// 包装 console 之前先留一份原件：日志系统自己输出时要用它，否则会递归。
const consoleOriginal = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
};

// 固定名 server.log（4MB 滚动成 server.log.1）不改名会留下孤儿文件、用户分不清新旧；按其修改时间改名成新格式，让它作为历史日志参与轮转。
function adoptLegacyLogs() {
    for (const [legacy, tag] of [['server.log', ''], ['server.log.1', '_old']]) {
        const full = path.join(LOG_DIR, legacy);
        try {
            if (!existsSync(full)) continue;
            const stamp = logStampFor(statSync(full).mtime);
            let target = path.join(LOG_DIR, stamp + tag + '.log');
            for (let i = 2; existsSync(target); i++) target = path.join(LOG_DIR, `${stamp}${tag}_${i}.log`);
            renameSync(full, target);
            // 走 console.log（→ emitLog）而不是 consoleOriginal："日志文件改名了"也要在应用内查看器查得到。
            console.log(`[Core] 旧日志 ${legacy} 已改名为 ${path.basename(target)}`);
        } catch { /* 改不动就留着，不影响启动 */ }
    }
}

// 只保留最近 LOG_KEEP 次启动：一次启动产出两个文件，按文件数算"留 10 份"只等于 5 次启动，保留量会凭空缩水一半。
function pruneOldLogs() {
    try {
        const sessions = new Map();
        for (const name of readdirSync(LOG_DIR)) {
            if (!LOG_NAME_RE.test(name)) continue;
            const key = name.slice(0, LOG_STAMP_LEN);   // 文件名前缀就是启动时刻
            if (!sessions.has(key)) sessions.set(key, []);
            sessions.get(key).push(name);
        }
        const stale = [...sessions.keys()].sort().slice(0, Math.max(0, sessions.size - LOG_KEEP));
        for (const key of stale) {
            for (const name of sessions.get(key)) {
                rmSync(path.join(LOG_DIR, name), { force: true });
                // 走 console.log（→ emitLog）：prune 在 console 包装之后跑，日志文件已关，走 emitLog 是安全的。
                console.log(`[Core] 清理旧日志 ${name}（只保留最近 ${LOG_KEEP} 次启动）`);
            }
        }
    } catch { /* 清理失败不影响启动 */ }
}

/**
 * 写进日志文件的文本要脱敏：日志常被发出去看，启动横幅里的明文访问密码会跟着漏。
 * 只在写文件与内存缓冲两层脱敏（缓冲经 /api/logs/tail 发给局域网设备），控制台保持原样以便本机用密码登录。
 */
const SECRET_RULES = [
    // 启动横幅只保留标签；规则必须容忍"标签与冒号之间还有别的字"—— 收紧成"访问密码紧跟冒号"会漏掉「局域网访问密码（初始随机）：xxxx」。
    [/访问密码[^：:\n]{0,20}[:：]\s*\S+/g, '访问密码: ******（仅打印在控制台，不写入日志）'],
    // 英文事实行 `[auth] LAN access password (initial, change it in Settings): xxx` 形态（check-log.mjs 把所有既有格式喂一遍盯着）。
    [/LAN access password[^:\n]*:\s*\S+/gi, 'LAN access password: ******'],
    // 密码单独占一行的形态（提示语在上一行、密码独占下一行）；限制 6-64 位连续非空白字符，避免误伤普通文本行。
    [/(输这个密码[^\n]*\n\s*)(\S{6,64})(\s*\n)/g, '$1******（仅打印在控制台，不写入日志）$3'],
    // 兜底：万一日志里带上了 Authorization 头或 key=value 形式的凭据
    [/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1******'],
    [/((?:apiKey|api_key|api-key|accessKey|access_key|token|password|secret|authorization)"?\s*[:=]\s*"?)([A-Za-z0-9._\-]{12,})/gi, '$1******'],
    // Tavily 的 Key 形态 tvly-xxxx：Bearer 那条已覆盖 Authorization 形态，裸 key 没有字段名，只能按厂商前缀认。
    [/\btvly-[A-Za-z0-9._\-]{8,}/g, 'tvly-******'],
    // 常见厂商的裸 key 形态（sk- / rc- 等），万一出现在对话或报错里
    [/\b(sk|rc|hk|ak)-[A-Za-z0-9._\-]{16,}/g, '$1-******'],
];

function redactSecrets(text) {
    let out = String(text);
    for (const [re, to] of SECRET_RULES) out = out.replace(re, to);
    return out;
}

// 两个 sink 的文件状态：part=1 不带序号，超过 LOG_MAX_BYTES 递增成 _2；同秒起第二实例用 -2 挂在 base 上，免得与大小拆分序号撞车。
const mainSink = { base: '', ext: '.log', part: 1, file: '', bytes: 0 };
const traceSink = { base: '', ext: '.trace.log', part: 1, file: '', bytes: 0 };
function sinkPath(sink) {
    return path.join(LOG_DIR, sink.base + (sink.part > 1 ? '_' + sink.part : '') + sink.ext);
}

function initLogFiles() {
    if (!LOG_TO_FILE) return;
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        adoptLegacyLogs();
        let base = logStampFor(new Date());
        for (let i = 2; existsSync(path.join(LOG_DIR, base + '.log')); i++) base = logStampFor(new Date()) + '-' + i;
        mainSink.base = base;
        traceSink.base = base;
        mainSink.file = sinkPath(mainSink);
        traceSink.file = sinkPath(traceSink);
        appendFileSync(mainSink.file, '');   // 立即建出空文件：这样它也会被算进"最近 N 次启动"
        // 追踪日志也先建出来：启动横幅已报出路径，且 tail -f 能从服务启动就挂上。
        if (traceEnabled) appendFileSync(traceSink.file, '');
    } catch { /* 目录不可写时退化为"只打控制台" */ }
}

/** 追加一行到某个 sink，必要时按大小换下一段 */
function appendToFile(sink, text) {
    if (!LOG_TO_FILE || !sink.file) return;
    try {
        const bytes = Buffer.byteLength(text);
        if (sink.bytes + bytes > LOG_MAX_BYTES) {
            sink.part += 1;
            sink.file = sinkPath(sink);
            sink.bytes = 0;
            // 走 console.log（→ emitLog）而不是 consoleOriginal：直推终端的话这条只在 bat 面板、查看器里没有，而"日志拆成第二个文件"恰恰要在查看器里解释。
            console.log('[Core] 日志超过 '
                + `${Math.round(LOG_MAX_BYTES / 1024 / 1024)}MB，换到 ${path.basename(sink.file)}`);
        }
        appendFileSync(sink.file, text);
        sink.bytes += bytes;
    } catch { /* 日志写不进去也绝不能影响主流程 */ }
}

/**
 * 写一条主日志。
 * 消息开头的 `[标签]` 被抽成标签字段、正文不再重复，所以调用点仍是 `console.log('[relay] ...')` 的自然写法。
 */
function emitLog(level, args) {
    const text = args
        .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4, breakLength: Infinity })))
        .join(' ');
    const m = text.match(/^\s*\[([^\]\n]{1,16})\]\s*([\s\S]*)$/);
    const tag = m ? normalizeTag(m[1]) : 'Core';
    const body = (m ? m[2] : text).replace(/\s+$/, '');
    // 纯空白不落盘：否则 console.log('') 也会写成一条空记录，翻日志时全是噪音
    if (!body.trim()) return;

    const now = new Date();
    const short = LEVEL_SHORT[level] || 'INFO';
    const loc = captureLocation();
    // AstrBot 只在 WARNING 及以上附版本号 —— 正常信息里塞版本号纯属噪音
    const verTag = (LEVEL_NO[level] || 20) >= 30 ? ` [v${APP_VERSION}]` : '';

    // 内存缓冲：每条都收（不受级别约束，读时过滤），查看器随时能看全部历史；脱敏后再存，与文件同一口径。
    logBuffer.push({
        ts: now, level, tag, loc,
        message: redactSecrets(body).replace(/^\n+/, ''),
    });

    if (shouldLogToFile(level)) {
        appendToFile(mainSink, formatForFile(body, now, tag, short, verTag, loc));
    }

    // 控制台：按控制台级别过滤；正文保持原样（人看的）。被过滤的记录进了缓冲与（若达标）文件，需要时切级别或开查看器都能找回来。
    if (!shouldLogToConsole(level)) return;
    if (!CONSOLE_COLOR) {
        consoleOriginal.log(`[${logTimeShort(now)}] [${tag}] [${short}]${verTag} [${loc}]: ` + body);
        return;
    }
    const head = `${ANSI_TIME}[${logTimeShort(now)}]${ANSI_RESET} `
        + `${tagColor(tag)}[${tag}]${ANSI_RESET} `
        + `${LEVEL_COLOR[level] || ''}[${short}]${ANSI_RESET}${verTag} `
        + `${ANSI_LOC}[${loc}]:${ANSI_RESET} `;
    const bodyColor = BODY_COLOR[level];
    consoleOriginal.log(head + (bodyColor ? bodyColor + body + ANSI_RESET : body));
}

/**
 * 把一条记录格式化进主日志文件。
 * 单行保持一行一条（保证 grep/tail 可用）；多行保留换行、首行带完整前缀、后续行只缩进 —— 压成一行会毁掉诊断块的可读性。
 */
function formatForFile(body, now, tag, short, verTag, loc) {
    const head = `[${logTimeFull(now)}] [${tag}] [${short}]${verTag} [${loc}]: `;
    // 先去掉正文开头的空行：诊断块以 \n 开头与上一条隔开，原样落盘会让记录首行只剩前缀、标题成了下一行且无缩进，grep [ERRO] 也定位不到内容。
    const safe = redactSecrets(body).replace(/^\n+/, '');
    if (!safe.includes('\n')) return head + safe + '\n';
    const lines = safe.split('\n');
    // 首行接在前缀后面；后续行原样保留（自带缩进），只去行尾空白。
    const rest = lines.slice(1).map((l) => l.replace(/\s+$/, ''));
    return head + lines[0].replace(/\s+$/, '') + '\n' + rest.join('\n') + '\n';
}

// 内存日志缓冲（软件内日志查看器的数据源）：emitLog 存结构化记录，/api/logs/tail 读时按级别/模块/关键词过滤（写入不受落盘级别约束）。
const logBuffer = createLogBuffer();

/**
 * 写追踪日志：LLM 完整请求消息、完整回复、完整上游报错。
 * 多行原样保留（给人读）；只在开头带一个时间戳，正文块不逐行加前缀。
 */
function traceLine(text) {
    if (!traceEnabled) return;
    const body = String(text ?? '');
    if (!body.trim()) return;
    appendToFile(traceSink, `[${logTimeFull()}] ${redactSecrets(body)}\n`);
}

initLogFiles();

for (const [method, level] of [
    ['log', 'INFO'], ['info', 'INFO'], ['debug', 'DEBUG'], ['warn', 'WARN'], ['error', 'ERROR'],
]) {
    // 具名函数：captureLocation() 靠函数名跳过包装层，匿名箭头函数拿不到稳定的名字
    console[method] = function patchedConsoleLog(...args) {
        try {
            // 只走 emitLog —— 它已负责格式化并调用 consoleOriginal 输出，再打一遍会让每条日志出现两行。
            emitLog(level, args);
        } catch {
            // 日志系统自己出问题时必须把内容原样吐出来，否则等于把整条链路静音
            consoleOriginal[method === 'debug' ? 'log' : method](...args);
        }
    };
}

// CRITICAL 没有对应的 console 方法，用显式函数暴露，补上真正的产生路径（否则级别过滤里的它没有意义）。
function logCritical(...args) {
    try { emitLog('CRITICAL', args); } catch { consoleOriginal.error(...args); }
}

pruneOldLogs();   // 放在包装之后：清理动作本身也进日志

// 记录本次启动的标识，日志文件里能看出这份日志属于哪一次、跑了多久
const BOOT_AT = Date.now();

// 启动输出：简短、英文、信息密度优先 —— 正文一行一个事件、用英文（中文长句无法 grep），「这是什么/怎么用」不塞进日志流；面向人的引导只在首次生成密码那条保留中文。
console.log(banner({
    name: 'ElainaChat Mod',
    version: APP_VERSION,
    tagline: `local AI chat server · pid=${process.pid} · node=${process.version}`
        + ` · ${process.platform}/${process.arch}`,
}));
console.log(`[boot] log file: ${LOG_TO_FILE ? path.relative(APP_ROOT, mainSink.file) : 'disabled (LOG_TO_FILE=0)'}`
    + ` · file level: ${fileLevel} · trace: ${traceEnabled ? 'on' : 'off'}`);
if (LOG_TO_FILE && traceEnabled) {
    // 追踪日志含完整对话内容 —— 对外分享日志前必须知道这一点（保留中文，给人看的提醒）
    console.log('[boot] 注意：追踪日志含完整聊天内容，对外分享前先查看 '
        + path.relative(APP_ROOT, traceSink.file));
}

// 收尾也留一行：文件最后一个时间戳就是会话结束时刻，配合文件名能知道这次跑了多久（排查"服务是不是半夜自己挂了"的判据）。
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        try {
            const sec = Math.round((Date.now() - BOOT_AT) / 1000);
            console.log(`[boot] 收到 ${signal}，服务结束（本次运行 ${sec} 秒）`);
        } catch { /* 收尾日志失败也要能正常退出 */ }
        process.exit(0);
    });
}

const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    // PWA 安装清单：类型错了安装入口就不出现，且控制台只报含糊的 "Manifest: Line: 1, column: 1, Syntax error"。
    ['.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.json', 'application/json'],
    ['.moc3', 'application/octet-stream'],
    ['.svg', 'image/svg+xml'],
    // 软件自带的 MiMo TTS 参考音频确实是 m4a（ftypisom）容器，只是文件名带 .mp3 —— 不能按扩展名推断音频格式（见 settings.js 按文件头嗅探的说明）。
    ['.mp3', 'audio/mpeg'],
    ['.m4a', 'audio/mp4'],
]);

/**
 * zip 解压薄包装：实现在 server/zip.mjs（readZip 内含体积上限、危险类型拦截、GBK、zip64）；
 * {files, blocked} 是调用点既有约定，模型上传与 mod 安装都按这个形态取值。
 */
function unzip(buf, opts = {}) {
    return readZip(buf, { ...opts, returnBlocked: true });
}

// 插件（mod）管理器：复用上面的 unzip —— 解压是安全敏感代码，只该有一个实现。
const modManager = createModManager({
    modsDir: MODS_DIR,
    unzip,
    isUnsafeEntryName,
    effectiveExt,
    log: (msg) => console.log('[Mod] ' + msg),
});

// MCP 客户端注册表：服务器是长命子进程，只建一份注册表跨请求复用，否则会长出成堆不会退出的 node 进程。
const mcpRegistry = createMcpRegistry({
    log: (msg) => console.log('[MCP] ' + msg),
});

/**
 * 读用户配置的 MCP 服务器清单。
 * 走 store 公开接口读 elaina_open_settings（自拼路径在布局变动后会静默失效）；只读配置，真启动发生在 listTools / callTool。
 */
function normalizeMcpHeaders(headers) {
    // 自定义请求头（远程鉴权）只保留字符串值：非字符串进 header 会让 fetch 抛 TypeError，报错看不懂。
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
    return Object.fromEntries(Object.entries(headers)
        .filter(([k, v]) => k && (typeof v === 'string' || typeof v === 'number'))
        .map(([k, v]) => [String(k), String(v)]));
}

function normalizeMcpServer(s) {
    return {
        id: String(s.id || '').trim(),
        name: String(s.name || s.id || '').trim(),
        url: String(s.url || '').trim(),
        command: String(s.command || '').trim(),
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        env: (s.env && typeof s.env === 'object') ? s.env : {},
        cwd: String(s.cwd || '').trim(),
        headers: normalizeMcpHeaders(s.headers),
    };
}

async function mcpServersFromSettings() {
    try {
        const data = await loadStore();
        const settings = JSON.parse(data['elaina_open_settings'] || '{}');
        const list = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
        return list
            .filter((s) => s && typeof s === 'object' && s.enabled === true)
            .map(normalizeMcpServer)
            // 只要有 url 或 command 就能连；两者都没有的条目已在客户端标 disabled，这里再挡一次，避免建一个必然失败的连接。
            .filter((s) => s.id && (s.url || s.command));
    } catch {
        return [];
    }
}

// 技能（skill）管理器：与 modManager 复用同一份 unzip；modsDir 用于读插件 manifest 里 "skills": [...] 的声明（随附技能）。
const skillManager = createSkillManager({
    skillsDir: SKILLS_DIR,
    modsDir: MODS_DIR,
    unzip,
    isUnsafeEntryName,
    effectiveExt,
    log: (msg) => console.log('[Skill] ' + msg),
});

// 数据备份里的插件 / 技能：共用安装接口那套路径与扩展名校验，备份恢复与市场安装受同一份安全规则约束。
const packageBackup = createPackageBackup({
    modsDir: MODS_DIR,
    skillsDir: SKILLS_DIR,
    isUnsafeEntryName,
    effectiveExt,
    log: (msg) => console.log('[Backup] ' + msg),
});

/**
 * 宿主自己占用的 `/api` 前缀：插件注册路由撞名会被拒绝装载，装载期报错好过静默失效（装了等于没装）。
 * 这份清单必须跟着新接口更新；漏了不会不安全（宿主仍优先），只会让插件从"装载报错"退化成"接口没反应"。
 */
const HOST_API_PREFIXES = [
    '/api/server-info', '/api/auth', '/api/relay', '/api/client-log',
    '/api/logs', '/api/store', '/api/data',
    '/api/plugins', '/api/skills', '/api/agent', '/api/memory',
    // '/api/live2d' 不在清单里：它是 live2d-models 插件自己声明的地址；宿主交出这块地址时必须同时删掉这一行。
];

/**
 * 宿主自己占用的静态资源前缀：插件声明 server.static 撞名会被拒绝，与 HOST_API_PREFIXES 同理，只是非 /api。
 * '/live2d' 不在清单里：模型目录住在 mods/live2d-models/，由该插件用 server.static 声明。
 */
const HOST_STATIC_PREFIXES = [
    '/vendor', '/js', '/css', '/mods', '/themes',
];

const modServer = createModServer({
    modsDir: MODS_DIR,
    hostRoutePrefixes: HOST_API_PREFIXES,
    hostStaticPrefixes: HOST_STATIC_PREFIXES,
    jsonResponse,
    readJsonBody,
    // 共享给插件的宿主工具：解压是安全敏感代码，实现只有一份（见 server/zip.mjs），插件拿到的就是这套已加固的实现。
    hostUtils: {
        readZip: (buf, opts) => readZip(buf, { ...opts, returnBlocked: true }),
        isUnsafeEntryName,
        effectiveExt,
        MAX_UPLOAD,
    },
    log: (msg) => console.log('[Mod] ' + msg),
});

// AI Agent 文件操作 API：四档权限（off 整块关闭、strict 逐条确认、auto 自动通过但禁删、full 完全访问）；读取三档都不询问、可无声读 data/store.json；auto 只禁删不禁覆盖。
const AGENT_APP_ROOT = path.resolve(root);
const AGENT_READ_LIMIT = 300 * 1024; // 读文件上限 300KB
const AGENT_WRITE_LIMIT = 1024 * 1024; // 写请求体上限 1MB

/** 四档权限的权威清单。前端 agentAccess 白名单必须与此保持一致。 */
const AGENT_ACCESS_LEVELS = ['off', 'strict', 'auto', 'full'];
const AGENT_ACCESS_DEFAULT = 'strict';

/** 把请求里传来的档位收敛到合法值。非法值一律按最严的 strict 处理。 */
function normalizeAgentAccess(value) {
    const v = String(value || '').trim();
    return AGENT_ACCESS_LEVELS.includes(v) ? v : AGENT_ACCESS_DEFAULT;
}

/**
 * off 的语义是能力不存在，而不是"要不要问"：读、写、删、执行命令全都没有。
 * 与 auto / full 那些"放行"档是两回事，所以判据单独拎出来，别混进 accessAsksBeforeChange。
 */
function accessDisabled(access) {
    return normalizeAgentAccess(access) === 'off';
}

/** 统一回给前端/模型的「电脑操作已关闭」响应（四个写/读/命令接口共用一种形状）。 */
function agentDisabledResponse(res) {
    return jsonResponse(res, 403, {
        ok: false,
        agentDisabled: true,
        message: 'AI 的电脑操作已在设置里关闭（「AI 权限 → 关闭」）。'
            + '需要时请在「设置 → 能力 → AI 权限」里改回某一档。',
    });
}

/** 这一档允不允许删除。只有 full 允许。 */
function accessAllowsDelete(access) {
    return normalizeAgentAccess(access) === 'full';
}

/** 这一档下"改动电脑的操作"要不要逐条询问。只有 strict 要。 */
function accessAsksBeforeChange(access) {
    return normalizeAgentAccess(access) === 'strict';
}

// AI 用浏览器：进程级单例（浏览器有状态，每请求新建会切断"看页面 → 点一下 → 再看"）；空闲自动关闭由 session 自己管（见 browser.mjs）。
const browserSession = createBrowserSession({
    log: (msg) => console.log('[Browser] ' + msg),
    // 有头模式让用户看得见 AI 在点什么；不要弹窗就把 ELAINA_BROWSER_HEADLESS 设为 1。
    headless: process.env.ELAINA_BROWSER_HEADLESS === '1',
});

/**
 * 浏览器接口的统一鉴权与档位判定：调试端口能读所有 cookie 与 localStorage，所以只认本机；off 档同样整块关闭。
 *
 * @returns {string|null} 拒绝原因；null 表示放行
 */
function browserDenyReason(request, access) {
    if (!isLocalRequest(request)) return '只有本机能用 AI 浏览器（调试端口能读到这台机器上所有登录态）';
    if (accessDisabled(access)) return 'AI 的电脑操作已在设置里关闭（「AI 权限 → 关闭」）';
    return null;
}

/**
 * 用户有没有打开「允许 AI 用浏览器」：服务端必须自己读设置（前端可被绕过），读不到一律当关闭。
 * 设置存在 data/store.json 的 elaina_open_settings（与前端同键）。
 */
async function browserEnabledByUser() {
    try {
        // 走 store 公开接口而不是自己读文件：store.json 真身是 data/main/store.json，自拼路径在布局变动后会静默失效。
        const data = await loadStore();
        const settings = JSON.parse(data['elaina_open_settings'] || '{}');
        return settings.agentBrowserEnabled === true;
    } catch {
        return false;
    }
}

/**
 * 两个路径是不是同一个：Windows 路径比较大小写不敏感，直接 === 会让换个大小写绕过删除守卫；
 * 大小写敏感平台（Linux / macOS）保持严格比较。
 */
function samePath(a, b) {
    const ra = path.resolve(String(a || ''));
    const rb = path.resolve(String(b || ''));
    return process.platform === 'win32'
        ? ra.toLowerCase() === rb.toLowerCase()
        : ra === rb;
}

/**
 * target 是否在 dir 内部或就是 dir 本身（同样按平台处理大小写）。用于"系统目录不许删"这类子树守卫。
 */
function isPathInside(target, dir) {
    const t = path.resolve(String(target || ''));
    const d = path.resolve(String(dir || ''));
    if (process.platform === 'win32') {
        const tl = t.toLowerCase();
        const dl = d.toLowerCase();
        return tl === dl || tl.startsWith(dl + path.sep);
    }
    return t === d || t.startsWith(d + path.sep);
}

// 外壳文件夹（桌面/文档/下载…）的真实位置：用户可把桌面移到任意位置、OneDrive 也会重定向，按惯例猜必然猜错；权威答案在注册表 HKCU\...\User Shell Folders。
const SHELL_FOLDER_SPECS = [
    { key: 'desktop', label: '桌面', reg: ['Desktop'], fallback: ['Desktop', '桌面', 'OneDrive/Desktop', 'OneDrive/桌面'], aliases: ['desktop', '桌面'] },
    { key: 'documents', label: '文档', reg: ['Personal'], fallback: ['Documents', '文档'], aliases: ['documents', '文档'] },
    { key: 'downloads', label: '下载', reg: ['{374DE290-123F-4565-9164-39C4925E467B}'], fallback: ['Downloads', '下载'], aliases: ['downloads', '下载'] },
    { key: 'pictures', label: '图片', reg: ['My Pictures'], fallback: ['Pictures', '图片'], aliases: ['pictures', '图片'] },
    { key: 'music', label: '音乐', reg: ['My Music'], fallback: ['Music', '音乐'], aliases: ['music', '音乐'] },
    { key: 'videos', label: '视频', reg: ['My Video'], fallback: ['Videos', '视频'], aliases: ['videos', '视频'] },
];

/** 展开 Windows 环境变量（%USERPROFILE% 之类），大小写不敏感 */
function expandWindowsEnv(value) {
    return String(value || '').replace(/%([^%\s]+)%/g, (whole, name) => {
        const hit = Object.keys(process.env).find(k => k.toLowerCase() === String(name).toLowerCase());
        return hit ? process.env[hit] : whole;
    });
}

/**
 * 把命令行程序的原始输出字节解成字符串：Windows 控制台程序默认按系统 ANSI 代码页（中文系统 GBK）写 stdout，
 * 按 UTF-8 解会把路径弄坏；用"先 UTF-8，出现替换字符就按 GBK 重解"。
 */
function decodeCliText(buf) {
    const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''));
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    if (!utf8.includes('\uFFFD')) return utf8;
    try { return new TextDecoder('gbk').decode(bytes); } catch { return utf8; }
}

/** 读注册表里的 User Shell Folders。返回 { 值名: 路径 }，读不到就是空对象 */
function readUserShellFolders() {
    const out = {};
    if (process.platform !== 'win32') return out;
    const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';

    // ① PowerShell：输出用 Base64 包一层，非 ASCII 路径不会被代码页打碎；放前面是因为 reg.exe 控制不了输出编码。
    try {
        const script = "$p = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'"
            + " | Select-Object -Property * -Exclude PS* | ConvertTo-Json -Compress;"
            + " [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))";
        const raw = decodeCliText(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000, windowsHide: true }));
        const parsed = JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8') || '{}');
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    } catch { /* 没装 / 被策略拦住，走兜底 */ }

    // ② 兜底：reg.exe（PowerShell 被禁用时）。输出形如：    Desktop    REG_EXPAND_SZ    D:\桌面
    if (!Object.keys(out).length) {
        try {
            const raw = decodeCliText(execFileSync('reg.exe', ['query', regKey], { timeout: 5000, windowsHide: true }));
            for (const line of raw.split(/\r?\n/)) {
                const m = line.match(/^\s*(.+?)\s{2,}REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i);
                if (m) out[m[1].trim()] = m[2].trim();
            }
        } catch { /* 被安全策略拦住 / 不存在，交给上层按惯例猜 */ }
    }
    return out;
}

// 只解析一次（起进程不便宜，而且这些路径在一次运行里不会变）
const shellFolderCache = { resolved: false, roots: [], aliasMap: new Map() };

function resolveShellFolders() {
    if (shellFolderCache.resolved) return shellFolderCache;
    shellFolderCache.resolved = true; // 先置位：即使解析抛异常也不重复起进程
    const registry = readUserShellFolders();
    const home = os.homedir();
    const aliasMap = new Map();
    const roots = [];
    for (const spec of SHELL_FOLDER_SPECS) {
        let found = '';
        for (const name of spec.reg) {
            if (registry[name]) { found = expandWindowsEnv(registry[name]); break; }
        }
        if (!found) {
            for (const name of spec.fallback) {
                const candidate = path.resolve(home, name);
                if (existsSync(candidate)) { found = candidate; break; }
            }
        }
        if (!found) continue;
        roots.push({ key: spec.key, label: spec.label, path: found, exists: existsSync(found) });
        for (const alias of spec.aliases) aliasMap.set(alias.toLowerCase(), found);
    }
    aliasMap.set('userprofile', home);
    aliasMap.set('home', home);
    if (process.env.TEMP) aliasMap.set('temp', process.env.TEMP);
    if (process.env.APPDATA) aliasMap.set('appdata', process.env.APPDATA);
    if (process.env.LOCALAPPDATA) aliasMap.set('localappdata', process.env.LOCALAPPDATA);
    shellFolderCache.roots = roots;
    shellFolderCache.aliasMap = aliasMap;
    return shellFolderCache;
}

/**
 * 把 AI 写的路径别名换成真实路径（支持 %DESKTOP%\a.txt 与 ~desktop/a.txt）。
 * 只认这两种显式写法：不猜「桌面\a.txt」这种裸词，否则一个恰好叫「桌面」的目录会被劫持。
 */
function expandPathAliases(raw) {
    const { aliasMap } = resolveShellFolders();
    let p = String(raw || '').trim();
    if (!p) return p;
    p = p.replace(/%([^%\s]{1,32})%/g, (whole, name) => aliasMap.get(String(name).trim().toLowerCase()) || whole);
    const tilde = p.match(/^~([A-Za-z_][A-Za-z0-9_]*)?(?=$|[\\/])/);
    if (tilde) {
        const hit = aliasMap.get(String(tilde[1] || 'home').toLowerCase());
        if (hit) p = hit + p.slice(tilde[0].length);
    }
    return p;
}

/** 给 AI 看的「真实位置」提示（路径不存在时附在错误里，让它下一轮能自己纠正） */
function shellFolderHint() {
    const { roots } = resolveShellFolders();
    if (!roots.length) return '';
    return '这台电脑的真实位置：' + roots.map(r => `${r.label}=${r.path}`).join('、')
        + '。路径不存在时请直接用上面的绝对路径，或用别名 %DESKTOP% / %DOCUMENTS% / %DOWNLOADS%。';
}

// isLocalRequest 在 server/net-guard.mjs（文件顶部 import 回来）；手机端中继要用同一份判定。

/**
 * 是否已获得「操作这台电脑」的授权：局域网设备登录后与本机同等能力，密码成为唯一那道门，
 * 所以密码强度校验与登录防爆破（server/auth-guard.mjs）是必要组成；能走到这里必然已过 handleLogin。
 */
function hasComputerGrant(request) {
    return isAuthenticated(request);
}

const PERM_DENIED_MSG = '需要先登录后才能操作电脑（局域网设备请在设置里填访问密码）。';

/**
 * 解析 Agent 路径，只做路径规范化 + 授权检查（三档都能访问任意路径）；allowOutside 保留形参是为了不动调用方签名。
 * reason: 'outside' 永远不会返回，needEscalation 分支仅为兼容老客户端保留。
 *
 * @returns {{ok:true, path:string} | {ok:false, reason:'invalid'|'remote'}}
 */
function resolveAgentPathEx(rawPath, access, privileged, allowOutside = false) {
    const p = expandPathAliases(rawPath);
    if (!p) return { ok: false, reason: 'invalid' };
    const resolved = path.resolve(p);
    if (!privileged) return { ok: false, reason: 'remote' };
    return { ok: true, path: resolved };
}

/** 旧签名保留：只要最终路径，拿不到就是 null（供不关心失败原因的调用方用） */
function resolveAgentPath(rawPath, access, privileged, allowOutside = false) {
    const r = resolveAgentPathEx(rawPath, access, privileged, allowOutside);
    return r.ok ? r.path : null;
}

/**
 * 统一的「路径被拒」响应。
 * 'outside' 已不可能出现（见 resolveAgentPathEx），但分支保留以兼容仍在等 needEscalation 的老前端。
 */
function denyPath(res, reason, privileged) {
    if (reason === 'outside') {
        return jsonResponse(res, 403, {
            ok: false,
            needEscalation: true,
            message: '这个位置需要你确认后才能访问。',
        });
    }
    if (reason === 'remote') {
        // 认证闸门在更前面（未登录的请求到不了 /api/agent/），所以这通常意味着"会话过期了"。
        return jsonResponse(res, 403, { ok: false, message: PERM_DENIED_MSG });
    }
    return jsonResponse(res, 403, { ok: false, message: '路径无效' });
}

/**
 * 列目录。返回 [{ name, type, link }]；type 判定必须走 stat 兜底 —— Windows junction 在 Dirent 里既不是目录也不是文件，
 * 只看 isDirectory() 会把这些兼容性链接全标成文件。
 */
async function listAgentEntries(target) {
    const entries = await readdir(target, { withFileTypes: true });
    const list = await Promise.all(entries.map(async (e) => {
        if (e.isDirectory()) return { name: e.name, type: 'dir', link: false };
        if (e.isFile()) return { name: e.name, type: 'file', link: false };
        // 符号链接 / junction：跟随一次，按真实类型归类，并标记 link 供界面区分
        const real = await stat(path.join(target, e.name)).catch(() => null);
        if (real && real.isDirectory()) return { name: e.name, type: 'dir', link: true };
        return { name: e.name, type: 'file', link: Boolean(e.isSymbolicLink()) };
    }));
    return list.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

async function agentLs(params, res, privileged) {
    try {
        const access = normalizeAgentAccess(params.get('access') || params.get('permission'));
        if (accessDisabled(access)) return agentDisabledResponse(res);
        const r = resolveAgentPathEx(params.get('path') || AGENT_APP_ROOT, access, privileged);
        if (!r.ok) return denyPath(res, r.reason, privileged);
        const target = r.path;
        // 读取不问确认 —— 但路径提示照给（AI 猜错路径时能自己纠正）
        const info = await stat(target).catch(() => null);
        if (!info || !info.isDirectory()) {
            const hint = shellFolderHint();
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, message: '目录不存在：' + target + (hint ? '。' + hint : '') }));
            return;
        }
        const list = await listAgentEntries(target);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: target, entries: list }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: err.message }));
    }
}

async function agentRead(params, res, privileged) {
    try {
        const access = normalizeAgentAccess(params.get('access') || params.get('permission'));
        if (accessDisabled(access)) return agentDisabledResponse(res);
        const r = resolveAgentPathEx(params.get('path'), access, privileged);
        if (!r.ok) return denyPath(res, r.reason, privileged);
        const target = r.path;
        const info = await stat(target).catch(() => null);
        if (!info || !info.isFile()) {
            const hint = shellFolderHint();
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, message: '文件不存在：' + target + (hint ? '。' + hint : '') }));
            return;
        }
        if (info.size > AGENT_READ_LIMIT) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '文件过大（>300KB）' })); return; }
        const buf = await (await import('node:fs/promises')).readFile(target, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, path: target, content: String(buf).slice(0, AGENT_READ_LIMIT) }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: err.message }));
    }
}

async function readAgentWriteBody(request, res) {
    const chunks = [];   // 不设上限的话，一个超大 body 就能把进程内存吃满
    let total = 0;
    for await (const chunk of request) {
        total += chunk.length;
        if (total > AGENT_WRITE_LIMIT) {
            request.resume();
            jsonResponse(res, 413, { ok: false, message: `写入内容超过 ${Math.round(AGENT_WRITE_LIMIT / 1024)}KB 上限` });
            return null;
        }
        chunks.push(chunk);
    }
    try {
        return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch {
        jsonResponse(res, 400, { ok: false, message: '请求体无效' });
        return null;
    }
}

function rejectBlockedWriteTarget(target, access, res) {
    // web/ 内禁写危险类型（.html/.js/.svg）：落进 web/ 就会被同源执行/渲染；它只挡写入接口，有命令执行后 echo x > web/a.html 仍可落盘。
    const inAppRoot = target === AGENT_APP_ROOT || target.startsWith(AGENT_APP_ROOT + path.sep);
    if (inAppRoot && access !== 'full' && isBlockedWritePath(target)) {
        jsonResponse(res, 400, { ok: false, message: '应用文件夹内不允许写 .html/.js/.svg 等可执行类型的文件（防止同源代码注入）' });
        return true;
    }
    return false;
}

async function confirmAgentWrite(target, access, body, res) {
    // strict 档下任何写入都要先确认（新建与覆盖都算"改动电脑"）；auto 与 full 直接放行（auto 只禁删除，AI 可用"写入同名文件"绕过）。
    let targetExists = false;
    try {
        const existed = await stat(target);
        targetExists = existed.isFile();
    } catch { /* 不存在 / 无权限：都按"新建"处理，真正的错误由 writeFile 抛出 */ }
    // overwrite:true = 用户已确认这次写入；新建与覆盖共用这一个确认令牌（前端两条确认分支复用同一个 send(true) 通道，见 agent.js 的 doAgentFile）。
    if (accessAsksBeforeChange(access) && body.overwrite !== true) {
        if (targetExists) {
            jsonResponse(res, 403, {
                ok: false,
                needOverwrite: true,
                message: '目标文件已存在：这次写入会**覆盖**它原有的内容。需要你确认后才能继续。',
            });
            return false;
        }
        jsonResponse(res, 403, {
            ok: false,
            needCreate: true,
            message: 'AI 想在你的电脑上新建一个文件：' + target + '。需要你确认后才能写入。',
        });
        return false;
    }
    return true;
}

async function ensureWriteParent(target) {
    // 只在目录不存在时创建（Windows 对盘符根目录如 D:\ 执行 mkdir 会报 EPERM）
    const dir = path.dirname(target);
    try {
        await stat(dir);
    } catch {
        try { await mkdir(dir, { recursive: true }); } catch (e) { /* 忽略已存在等错误 */ }
    }
}

async function agentWrite(request, res, privileged) {
    try {
        const parsed = await readAgentWriteBody(request, res);
        if (!parsed) return;
        const body = parsed.body;
        const access = normalizeAgentAccess(body.access || body.permission);
        if (accessDisabled(access)) return agentDisabledResponse(res);
        const r = resolveAgentPathEx(body.path, access, privileged);
        if (!r.ok) return denyPath(res, r.reason, privileged);
        const target = r.path;
        if (rejectBlockedWriteTarget(target, access, res)) return;
        if (!(await confirmAgentWrite(target, access, body, res))) return;
        await ensureWriteParent(target);
        await writeFile(target, String(body.content ?? ''), 'utf8');
        jsonResponse(res, 200, { ok: true, path: target });
    } catch (err) {
        jsonResponse(res, 500, { ok: false, message: err.message });
    }
}

/**
 * AI 执行电脑命令（PowerShell / cmd）：服务端必须自己判定危险并拒绝未带 approved 的请求（前端可被绕过）。
 * strict 每条都要求 approved（命令是任意操作，没有安全的免问子集）；auto 只拦危险命令；full 全放行，含删除类命令。
 */
async function agentExec(request, res, privileged) {
    try {
        let body;
        try { body = await readJsonBody(request, 256 * 1024); } catch { return jsonResponse(res, 400, { ok: false, message: '请求体无效' }); }

        const access = normalizeAgentAccess(body.access || body.permission);
        if (!privileged) {
            return jsonResponse(res, 403, { ok: false, message: PERM_DENIED_MSG });
        }
        // `off` 档：整块关闭，连命令执行也不存在（比"要不要问"更靠前的一层）。
        if (accessDisabled(access)) return agentDisabledResponse(res);
        const command = String(body.command || '').trim();
        if (!command) return jsonResponse(res, 400, { ok: false, message: '命令为空' });
        if (command.length > 8000) return jsonResponse(res, 400, { ok: false, message: '命令过长（上限 8000 字符）' });

        const verdict = classifyCommand(command);   // 服务端权威判定，不信前端传来的 risk
        // 该不该要 approved：strict 一律要（每条都问），auto 只要危险命令，full 从不。
        const needsApproval = access === 'strict' ? true : (access === 'auto' && verdict.risk === 'dangerous');
        if (needsApproval && body.approved !== true) {
            return jsonResponse(res, 403, {
                ok: false,
                needApproval: true,
                risk: verdict.risk,
                reasons: access === 'strict' && verdict.risk !== 'dangerous'
                    ? ['当前是「逐条确认」模式，每条命令都需要你确认']
                    : verdict.reasons,
                message: '这条命令需要用户确认后才能执行。',
            });
        }

        let cwd;
        if (body.cwd) {
            const target = resolveAgentPath(body.cwd, access, privileged);
            if (!target) return jsonResponse(res, 403, { ok: false, message: '工作目录无效' });
            cwd = target;
        }

        const result = await runCommand(command, { shell: body.shell, cwd });
        return jsonResponse(res, 200, {
            ok: result.ok,
            risk: verdict.risk,
            reasons: verdict.reasons,
            shell: result.shell,
            code: result.code,
            timedOut: result.timedOut,
            truncated: result.truncated,
            stdout: result.stdout,
            stderr: result.stderr,
            text: formatCommandResult(result),
        });
    } catch (err) {
        jsonResponse(res, 500, { ok: false, message: String(err?.message || err) });
    }
}

/**
 * AI 删除文件或目录：单独成接口而不是走命令 —— 命令在 auto 档因"删除类危险"必问而根本删不掉，且删除范围只能靠黑名单（必然漏）。
 * 三档：strict 回 needDelete 确认一次；auto 整体拒绝；full 直接执行；服务端自己判档，不信前端 confirmed。
 */
function rejectDeleteTarget(target, res) {
    // 拒绝删除"删了就回不来 / 会连坐"的位置，判据是精确匹配（+ 系统目录用前缀）；full 档只挡整锅端的那几个，这是"防手滑"不是"防恶意"。
    const projectRoot = path.resolve(AGENT_APP_ROOT, '..');
    const rootOfTarget = path.parse(target).root;
    if (samePath(target, rootOfTarget)) {
        jsonResponse(res, 400, { ok: false, message: '不能删除盘符根目录：' + target });
        return true;
    }
    // 比较必须走 samePath（Windows 下大小写不敏感），直接 === 会被换个大小写的同一目录绕过。
    const exactGuard = [
        { p: projectRoot, why: '项目根目录' },
        { p: AGENT_APP_ROOT, why: '应用自己的文件夹（web/）' },
    ];
    for (const g of exactGuard) {
        if (samePath(target, g.p)) {
            jsonResponse(res, 400, {
                ok: false,
                message: '不能删除' + g.why + '本身：' + target
                    + '\n（它里面的单个文件可以删，但整个目录不行 —— 那会把应用连根拔掉。）',
            });
            return true;
        }
    }
    const prefixGuard = [
        { p: process.env.SystemRoot || 'C:\\Windows', why: '系统目录' },
        { p: process.env.ProgramFiles || 'C:\\Program Files', why: '程序目录' },
    ];
    for (const g of prefixGuard) {
        if (isPathInside(target, g.p)) {
            jsonResponse(res, 400, { ok: false, message: '不能删除' + g.why + '：' + target });
            return true;
        }
    }
    return false;
}

function deleteFailureReason(rmErr) {
    // 删除失败要给人能看懂的原因，不能把 Node 原始错误码甩出去：EBUSY / EPERM 不是"操作错了"，而是"现在删不了"。
    const code = String(rmErr?.code || '');
    if (code === 'EBUSY') return '这个文件或目录正被别的程序占用（先关掉它再试）';
    if (code === 'EPERM') return '没有权限删除它（可能是只读，或需要管理员权限）';
    if (code === 'ENOTEMPTY') return '目录非空且其中有删不掉的内容';
    if (code === 'ENOENT') return '它已经不存在了（可能刚被别的程序删掉）';
    return '删除失败（' + code + '）';
}

async function agentDelete(request, res, privileged) {
    try {
        let body;
        try { body = await readJsonBody(request, 256 * 1024); } catch { return jsonResponse(res, 400, { ok: false, message: '请求体无效' }); }

        const access = normalizeAgentAccess(body.access || body.permission);
        if (!privileged) return jsonResponse(res, 403, { ok: false, message: PERM_DENIED_MSG });
        if (accessDisabled(access)) return agentDisabledResponse(res);

        if (!accessAllowsDelete(access) && access === 'auto') {
            return jsonResponse(res, 403, {
                ok: false,
                deleteForbidden: true,
                message: '当前是「自动通过（禁止删除）」模式，AI 不能删除文件。'
                    + '需要删除的话，请在「设置 → 能力 → AI 权限」里切到「完全访问」，或自己手动删除。',
            });
        }

        const r = resolveAgentPathEx(body.path, access, privileged);
        if (!r.ok) return denyPath(res, r.reason, privileged);
        const target = r.path;
        if (rejectDeleteTarget(target, res)) return;

        const info = await stat(target).catch(() => null);
        if (!info) return jsonResponse(res, 404, { ok: false, message: '要删除的东西不存在：' + target });

        if (accessAsksBeforeChange(access) && body.confirmed !== true) {
            return jsonResponse(res, 403, {
                ok: false,
                needDelete: true,
                isDir: info.isDirectory(),
                message: '即将**永久删除**：' + target
                    + '（' + (info.isDirectory() ? '目录及其全部内容' : '文件') + '）。删除后无法恢复，需要你确认。',
            });
        }

        const isDir = info.isDirectory();
        try {
            if (isDir) {
                await rm(target, { recursive: true, force: true });
            } else {
                await rm(target, { force: true });
            }
        } catch (rmErr) {
            const code = String(rmErr?.code || '');
            return jsonResponse(res, 500, { ok: false, code, message: deleteFailureReason(rmErr) + '：' + target });
        }
        return jsonResponse(res, 200, {
            ok: true,
            path: target,
            wasDir: isDir,
            message: '已删除' + (isDir ? '目录' : '文件') + '：' + target,
        });
    } catch (err) {
        jsonResponse(res, 500, { ok: false, message: String(err?.message || err) });
    }
}

// 来源校验：Host 白名单 + 同站校验 —— Agent 文件接口的权限模式由请求方传参决定、"是否本机"只看 remoteAddress，DNS rebinding 可同时满足两者，所以必须校验 Host 头本身。
const EXTRA_ALLOWED_HOSTS = [
    ...String(process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    ...(FILE_CONFIG.allowedHosts || []),
];

const allowedHostNames = (() => {
    const set = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    try { set.add(String(os.hostname()).toLowerCase()); } catch { /* ignore */ }
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
            // IPv6 链路本地地址会带 %zone，Host 头里不会有
            set.add(String(net.address || '').split('%')[0].toLowerCase());
        }
    }
    for (const h of EXTRA_ALLOWED_HOSTS) set.add(h);
    set.delete('');
    return set;
})();

function hostnameOfHostHeader(raw) {
    const h = String(raw || '').trim().toLowerCase();
    if (!h) return '';
    if (h.startsWith('[')) {                       // IPv6 字面量：[::1]:4173
        const end = h.indexOf(']');
        return end > 0 ? h.slice(0, end + 1) : h;
    }
    const i = h.lastIndexOf(':');
    return i > 0 ? h.slice(0, i) : h;
}

function isAllowedHost(request) {
    const hostname = hostnameOfHostHeader(request.headers.host);
    if (!hostname) return false; // HTTP/1.1 必须带 Host
    return allowedHostNames.has(hostname);
}

// isLoopbackHostname 在 server/net-guard.mjs（文件顶部 import 回来）。

// 同站校验：第三方页面的 GET 不带 Origin，但会带 Sec-Fetch-Site: cross-site；不带 Sec-Fetch-* 的客户端若带了 Origin 且与 Host 不同源也按跨站处理。
function isCrossSiteRequest(request) {
    const sfs = String(request.headers['sec-fetch-site'] || '').toLowerCase();
    if (sfs) return sfs !== 'same-origin' && sfs !== 'none';
    const origin = request.headers.origin;
    if (!origin) return false;
    try { return new URL(origin).host !== (request.headers.host || ''); } catch { return true; }
}

// HTTPS（手机端麦克风需要 secure context）：浏览器只允许在 https / localhost 下调 getUserMedia，只能补一个自签 HTTPS 端口（证书首次启动生成到 data/，端口由主端口推导）。

function localIPv4List() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list || []) {
            if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
        }
    }
    // 私有网段排前面：手机/平板能连的通常是 192.168.x.x / 10.x / 172.16-31.x，VPN 与虚拟网卡常在公网段会把人带偏。
    return out.sort((a, b) => (isPrivateIPv4(b) ? 1 : 0) - (isPrivateIPv4(a) ? 1 : 0));
}

/**
 * 探测某个端口能否被监听：真正 listen 一次再关掉，且必须绑 host 而不是回环地址（否则会假阴性）。
 *
 * @returns {Promise<boolean>}
 */
function canListen(p, h) {
    return new Promise((resolve) => {
        const probe = createNetServer();
        probe.once('error', () => resolve(false));
        probe.once('listening', () => probe.close(() => resolve(true)));
        // exclusive 防止与别的进程共享同一个端口（Windows 默认允许共享，不加的话"两个服务都监听 3999"也能探测成功）。
        probe.listen({ port: p, host: h, exclusive: true });
    });
}

/**
 * 这个端口上已经有东西在收连接吗：Windows 允许两个进程分别绑 127.0.0.1:P 与 0.0.0.0:P，
 * 所以"我绑上了"不等于"端口归我"；超时按"没人应答"处理。
 *
 * @returns {Promise<boolean>}
 */
function portHasListener(p) {
    return new Promise((resolve) => {
        const socket = createConnection({ host: '127.0.0.1', port: p });
        let settled = false;
        const settle = (v) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(v);
        };
        socket.setTimeout(500, () => settle(false));
        socket.once('connect', () => settle(true));
        socket.once('error', () => settle(false));
    });
}

/**
 * 我们能不能独占地用这个端口：绑得上，且此刻没人在上面收连接；先问"有没有人接"，比真的绑一次便宜。
 *
 * @returns {Promise<boolean>}
 */
async function isPortFree(p, h) {
    if (await portHasListener(p)) return false;
    return canListen(p, h);
}

/**
 * 从 start 起找一个能用的端口。
 *
 * @returns {Promise<number>} 可用的端口
 * @throws 全部被占用时抛错（附上扫描范围，便于用户判断是哪里占着）
 */
async function pickPort(start, h, span) {
    for (let p = start; p < start + span; p++) {
        if (await isPortFree(p, h)) return p;
    }
    throw new Error('端口 ' + start + '–' + (start + span - 1) + ' 全部被占用，请关掉占用它们的程序后重试');
}

/**
 * 这个端口上跑的是不是本项目自己的实例：判据是 /api/server-info 的应答形状，只连回环地址。
 * 应答须为 `{ ok:true, httpPort:<数字> }`，别的软件不会恰好回这个形状。
 *
 * @returns {Promise<boolean>}
 */
function isOurInstance(p) {
    return new Promise((resolve) => {
        const req = httpGet({ host: '127.0.0.1', port: p, path: '/api/server-info', timeout: 700 }, (res) => {
            if (res.statusCode !== 200) { res.resume(); resolve(false); return; }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
                // 不是我们的接口就不值得把整个响应读完（对方可能一直发）
                if (body.length > 4096) { req.destroy(); resolve(false); }
            });
            res.on('end', () => {
                try {
                    const info = JSON.parse(body);
                    resolve(Boolean(info && info.ok === true && typeof info.httpPort === 'number'));
                } catch { resolve(false); }
            });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

/**
 * 从 start 往上找：在遇到第一个空闲端口之前，有没有本项目自己的实例在跑。
 * 遇到第一个空闲端口就停 —— 启动顺序总是从 3999 起占最靠下的空闲端口，前面不会有自己人。
 *
 * @returns {Promise<number>} 已有实例的端口；没有则 0（正常的全新启动）
 */
async function findRunningInstance(start, span) {
    for (let p = start; p < start + span; p++) {
        if (await isPortFree(p, host)) return 0;
        if (await isOurInstance(p)) return p;
    }
    return 0;
}

// data/config.json：未知键忽略，已知键类型写错直接报错并带文件路径。
function loadServerConfig(file) {
    const out = { port: 0, portSet: false, host: '', https: true, cert: '', key: '', password: '', allowedHosts: [] };
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return out;
        throw err;
    }
    let doc;
    try {
        doc = JSON.parse(raw);
    } catch (err) {
        throw new Error(`${file}: JSON 解析失败：${String((err && err.message) || err)}`);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error(`${file}: 顶层必须是 JSON 对象`);
    }
    if (doc.port !== undefined && doc.port !== null) {
        if (!Number.isInteger(doc.port) || doc.port < 0 || doc.port > 65535) {
            throw new Error(`${file}: port 不是合法端口：${doc.port}`);
        }
        out.port = doc.port;
        out.portSet = true;
    }
    if (doc.host !== undefined && doc.host !== null) {
        if (typeof doc.host !== 'string') throw new Error(`${file}: host 必须是字符串`);
        out.host = doc.host;
    }
    if (doc.https !== undefined && doc.https !== null) {
        if (typeof doc.https !== 'boolean') throw new Error(`${file}: https 必须是 true/false`);
        out.https = doc.https;
    }
    if (doc.cert !== undefined && doc.cert !== null) {
        if (typeof doc.cert !== 'string') throw new Error(`${file}: cert 必须是字符串`);
        out.cert = doc.cert;
    }
    if (doc.key !== undefined && doc.key !== null) {
        if (typeof doc.key !== 'string') throw new Error(`${file}: key 必须是字符串`);
        out.key = doc.key;
    }
    if (doc.password !== undefined && doc.password !== null) {
        if (typeof doc.password !== 'string') throw new Error(`${file}: password 必须是字符串`);
        out.password = doc.password;
    }
    if (doc.allowed_hosts !== undefined && doc.allowed_hosts !== null) {
        if (!Array.isArray(doc.allowed_hosts)) throw new Error(`${file}: allowed_hosts 必须是数组`);
        out.allowedHosts = doc.allowed_hosts.map((h) => {
            if (typeof h !== 'string') throw new Error(`${file}: allowed_hosts 只能放字符串`);
            return h.trim().toLowerCase();
        }).filter(Boolean);
    }
    return out;
}

function ensureSampleConfig() {
    const file = CONFIG_FILE;
    try {
        if (existsSync(file)) return;
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, `{
  "port": 3999,
  "host": "127.0.0.1",
  "https": true,
  "cert": null,
  "key": null,
  "password": "",
  "allowed_hosts": []
}
`, { encoding: 'utf8', mode: 0o600 });
        // 先写临时文件再改名：两个实例同时首启时不会读到写了一半的 JSON。
        renameSync(tmp, file);
    } catch (err) {
        console.warn('[config] 写入配置样例失败：' + String((err && err.message) || err));
    }
}

function resolveCertPaths() {
    const configDir = path.dirname(CONFIG_FILE);
    const resolvePath = (raw) => (path.isAbsolute(raw) ? raw : path.join(configDir, raw));
    const cert = String(process.env.ELAINA_CERT_FILE || FILE_CONFIG.cert || '').trim();
    const key = String(process.env.ELAINA_KEY_FILE || FILE_CONFIG.key || '').trim();
    if ((cert === '') !== (key === '')) {
        console.error('[boot] CRITICAL: cert 与 key 必须同时配置（当前只给了一个）');
        process.exit(1);
    }
    if (cert) {
        const certPath = resolvePath(cert);
        const keyPath = resolvePath(key);
        if (!existsSync(certPath) || !existsSync(keyPath)) {
            console.error('[boot] CRITICAL: 配置的证书或私钥不存在：' + certPath);
            process.exit(1);
        }
        return { cert: certPath, key: keyPath, explicit: true };
    }
    const autoCert = path.join(configDir, 'cert.pem');
    const autoKey = path.join(configDir, 'key.pem');
    if (existsSync(autoCert) && existsSync(autoKey)) {
        return { cert: autoCert, key: autoKey, explicit: false };
    }
    return { cert: path.join(DATA_DIR, 'cert.pem'), key: path.join(DATA_DIR, 'key.pem'), explicit: false };
}

function findOpenssl() {
    const candidates = [
        process.env.OPENSSL_PATH,
        'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
        'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
        'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
        '/usr/bin/openssl',
        '/usr/local/bin/openssl',
    ].filter(Boolean);
    for (const c of candidates) {
        try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* 换下一个 */ }
    }
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return 'openssl'; } catch { /* 没有 */ }
    return null;
}

// 读出证书还剩多少天、以及它是不是我们自己生成的；自签证书默认 825 天（Chrome / Safari 上限），剩余不足 30 天自动换新。
function describeCert(certBuf) {
    try {
        const x = new X509Certificate(certBuf);
        return {
            daysLeft: (new Date(x.validTo).getTime() - Date.now()) / 86400000,
            selfMade: String(x.subject || '').includes('ElainaChat'),
        };
    } catch {
        return { daysLeft: Infinity, selfMade: false };
    }
}

async function ensureCertificate(force = false) {
    try {
        const [cert, key] = await Promise.all([readFile(CERT_PATHS.cert), readFile(CERT_PATHS.key)]);
        if (cert.length && key.length) {
            const info = describeCert(cert);
            // 用户自己换的证书一律不动；只有我们自己签的才做自动续期。
            if (!info.selfMade) return { cert, key, generated: false, custom: true, daysLeft: info.daysLeft };
            if (!force && info.daysLeft >= 30) {
                return { cert, key, generated: false, daysLeft: info.daysLeft };
            }
        }
    } catch { /* 还没有证书，往下生成 */ }

    const openssl = findOpenssl();
    if (!openssl) return null;

    try {
        await mkdir(path.dirname(CERT_PATHS.cert), { recursive: true });
        await mkdir(path.dirname(CERT_PATHS.key), { recursive: true });
        // SAN 必须带上局域网 IP 与主机名，否则用对应地址访问时证书主体对不上。
        const sans = ['DNS:localhost', 'IP:127.0.0.1', 'IP:::1'];
        try {
            const hostname = os.hostname();
            if (hostname && hostname.toLowerCase() !== 'localhost') sans.push('DNS:' + hostname);
        } catch { /* 拿不到主机名就不加 */ }
        for (const ip of localIPv4List()) sans.push('IP:' + ip);
        execFileSync(openssl, [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', CERT_PATHS.key, '-out', CERT_PATHS.cert,
            '-days', '825',
            '-subj', '/CN=ElainaChat',
            '-addext', 'subjectAltName=' + sans.join(','),
        ], { stdio: 'ignore', timeout: 60000 });
        const [cert, key] = await Promise.all([readFile(CERT_PATHS.cert), readFile(CERT_PATHS.key)]);
        return { cert, key, generated: true, daysLeft: describeCert(cert).daysLeft };
    } catch (err) {
        console.warn('  ! HTTPS 自签证书生成失败：' + (err && err.message ? err.message : err));
        return null;
    }
}

/**
 * 数据导入的完整判定（纯逻辑，不碰 request / response）：整包解不开 / 没有可导入内容时必须在写任何文件之前返回错误；
 * 备份 zip 顶层三件与项目根一一对应（data/ → store，mods/ 与 skills/ → packageBackup）。
 *
 * @param {Buffer} raw   原始备份字节（zip 或 v1 单 JSON）
 * @param {'merge'|'replace'} mode
 * @returns {Promise<{status:number, body:object}>}
 */
async function importBackupPayload(raw, mode) {
    const isZip = raw.length >= 4 && raw.readUInt32LE(0) === 0x04034b50;
    let packageFiles = null;
    let hasPackages = false;
    if (isZip) {
        // 插件 / 技能条目要从同一个 zip 里单独读一遍：数据解析刻意不开 allowScripts（默认黑名单保护数据路径），而插件入口本来就是 .js。
        try {
            packageFiles = readZip(raw, { maxTotal: 256 * 1024 * 1024, maxEntry: 64 * 1024 * 1024, allowScripts: true });
        } catch (err) {
            return { status: 400, body: { ok: false, message: '这个文件不是有效的 zip 备份：' + String((err && err.message) || err) } };
        }
        // 先看恢复器认不认这个包：纯 .exe 的 mods/ 会让"有包"为真却一个也恢复不了，那种情况该报"没有可导入的数据"，而不是先清数据再报错。
        const preview = await packageBackup.restore(packageFiles, { dryRun: true });
        hasPackages = preview.mods > 0 || preview.skills > 0;
    }

    // 先读不写：hasImportableData 只解析不落盘，避免坏包先清掉数据再报失败。
    const hasData = await store.hasImportableData(raw).catch(() => false);
    if (!hasData && !hasPackages) {
        return { status: 400, body: { ok: false, message: '备份里没有可导入的数据' } };
    }

    // 数据先落盘：包恢复失败时聊天记录与设置至少已经回来了。
    let result = { ok: false, keys: 0, source: isZip ? 'zip' : 'json', message: '备份里没有可导入的数据' };
    if (hasData) result = await store.importBackup(raw, mode);

    let pkg = null;
    if (hasPackages) {
        pkg = await packageBackup.restore(packageFiles, { allowScripts: true });
        // 插件 / 技能目录变了，清单必须重扫：否则前端拿到的还是旧 index.json，表现为"导入成功但插件列表没变"。
        if (pkg.mods || pkg.skills) {
            try { await modManager.scanAndSync(); } catch (err) { console.warn('[备份] 重扫插件失败：' + String((err && err.message) || err)); }
            try { await skillManager.scan(); } catch (err) { console.warn('[备份] 重扫技能失败：' + String((err && err.message) || err)); }
        }
    }

    const restoredAny = Boolean(pkg && (pkg.mods || pkg.skills));
    if (!result.ok && !restoredAny) {
        const why = (pkg && pkg.errors && pkg.errors[0]) || (pkg && pkg.error)
            || result.message || '备份里没有可导入的数据';
        return { status: 400, body: { ok: false, message: why } };
    }

    let message = result.message || `已导入 ${result.keys} 项数据`;
    if (pkg) {
        const parts = [];
        if (pkg.mods) parts.push(pkg.mods + ' 个插件');
        if (pkg.skills) parts.push(pkg.skills + ' 个技能');
        if (parts.length) {
            message = '已导入 ' + (result.keys ? result.keys + ' 项数据、' : '') + parts.join('、')
                + '（' + (mode === 'replace' ? '替换' : '合并') + '模式）';
        }
        if (pkg.skipped) message += '；跳过 ' + pkg.skipped + ' 个不安全文件';
        if (pkg.errors && pkg.errors.length) message += '；' + pkg.errors.length + ' 个包未恢复：' + pkg.errors[0];
        if (pkg.error) message += '；插件与技能未恢复：' + pkg.error;
    }

    return {
        status: 200,
        body: { ok: true, mode, keys: result.keys, source: result.source, packages: pkg, message },
    };
}

// 端侧数据存储（data/ 分类落盘）：localStorage 每台设备各存一份，需要跨设备共享的键改落服务端 data/；结构见 server/store.mjs，前端仍然只看到键值。
const store = createStore({
    dataDir: DATA_DIR,
    log: (level, msg) => (level === 'error' ? console.error(msg) : console.log(msg)),
});
const loadStore = () => store.loadStore();
const saveStore = () => store.saveStore();

/** 打包一份完整备份（data/ + mods/ + skills/）。导出接口与局域网共享共用这一份实现。 */
async function buildBackupBuffer() {
    const packages = await packageBackup.collect();
    return await store.exportZip(packages.entries, packages.counts);
}

const lanShare = createLanShare({
    collectBackup: buildBackupBuffer,
    maxUpload: MAX_UPLOAD,
    // 局域网设备只在本机设置过访问密码后才能用：默认状态（未设置密码）不算。
    isPasswordSet: hasAccessPassword,
    log: (msg) => console.log('[LAN共享] ' + msg),
});

// 版本检测器：跨请求复用，成功结果缓存十分钟（未登录的 GitHub 接口每小时 60 次）；仓库名可用 ELAINA_UPDATE_REPO 覆盖。
const updateChecker = createUpdateChecker({});

/**
 * 校验并收敛 POST /api/store 提交上来的补丁：只收字符串值（与 localStorage 语义一致），限制键长与单键体积。
 * null 是删除标记，必须原样保留交给合并步骤真删，否则"删除"永远到不了磁盘（例如插件失败记录清不掉）。
 */
function normalizeStorePatch(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { patch: {}, oversized: [] };
    const patch = {};
    const oversized = [];
    for (const [k, v] of Object.entries(raw)) {
        if (typeof k !== 'string' || !k || k.length > 120) continue;
        if (v === null) { patch[k] = null; continue; }
        if (typeof v !== 'string') continue;
        if (v.length > STORE_KEY_MAX_CHARS) { oversized.push({ key: k, size: v.length }); continue; }
        patch[k] = v;
    }
    return { patch, oversized };
}

// 多设备实时同步（store 变更广播）：每个打开的页面订阅 /api/store/stream，POST 成功后把本次改动的键推给所有订阅者；带 origin 标记跳过发起方，避免旧值覆盖。
const storeSubscribers = new Set();   // { res, clientId }

function broadcastStoreChange(patch, request) {
    if (!storeSubscribers.size) return;
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const from = String(request.headers['x-store-client'] || '');
    const payload = JSON.stringify({ type: 'store-change', keys, data: patch, from });
    for (const sub of storeSubscribers) {
        if (from && sub.clientId === from) continue;   // 不回推给发起方
        try {
            sub.res.write(`data: ${payload}\n\n`);
        } catch (e) {
            storeSubscribers.delete(sub);   // 写失败说明连接已断，摘掉
        }
    }
}

/** SSE 长连接：把 store 的变更实时推给这个页面 */
function handleStoreStream(request, response) {
    const clientId = String(new URL(request.url || '/', 'http://x').searchParams.get('client') || '');
    response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
    });
    // 立刻发一条注释行：让浏览器认为连接已建立（有些实现要收到数据才触发 open）
    response.write(': connected\n\n');
    const sub = { res: response, clientId };
    storeSubscribers.add(sub);
    // 心跳：中间有反向代理时长时间无数据会被掐断，25 秒一次注释行，成本可忽略。
    const beat = setInterval(() => {
        try { response.write(': ping\n\n'); } catch { /* 断开由下面的 close 处理 */ }
    }, 25000);
    beat.unref?.();
    const cleanup = () => {
        clearInterval(beat);
        storeSubscribers.delete(sub);
    };
    response.on('close', cleanup);
    response.on('error', cleanup);
    request.on('close', cleanup);
    // 注意：**不要** end()，这是个长连接，保持打开直到客户端断开
}

// 访问鉴权：服务默认监听 0.0.0.0 且 Agent 接口没有鉴权，必须设访问控制 —— 本机免密进且可改密码；局域网设备必须登录（HttpOnly Cookie，默认 7 天）。
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const LEGACY_AUTH_FILE = path.join(root, '.local-auth.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'elaina_session';
// 登录防爆破：单 IP 指数退避 + 全局限流，参数集中在 auth-guard.mjs；固定窗口等于告诉攻击者"每 60 秒能试 5 次"，这里锁定时间逐次翻倍、计数只在成功时清零。
const loginGuard = createLoginGuard();
// 会话表：键是 token 的 sha256（表要落盘，不该直接得到可用凭据），值是过期时间戳；落盘是因为桌面壳每次启动新起 node 进程，只放内存会逼所有人重新输密码。
const sessions = new Map();

function sessionKey(token) {
    return createHash('sha256').update(String(token)).digest('hex');
}

async function loadSessions() {
    try {
        const list = JSON.parse(await readFile(SESSIONS_FILE, 'utf8'));
        if (!Array.isArray(list)) return;
        const now = Date.now();
        for (const row of list) {
            if (!Array.isArray(row)) continue;
            const [key, exp] = row;
            if (typeof key === 'string' && key && Number(exp) > now) sessions.set(key, Number(exp));
        }
    } catch { /* 文件不存在或损坏：视为没有可恢复的会话 */ }
}

async function saveSessions() {
    try {
        await mkdir(DATA_DIR, { recursive: true });
        const now = Date.now();
        const list = [];
        for (const [key, exp] of sessions) if (exp > now) list.push([key, exp]);
        await writeFile(SESSIONS_FILE, JSON.stringify(list), 'utf8');
    } catch (err) {
        // 落盘失败不该挡住登录本身：本次运行仍靠内存里的表工作，只是重启后需要重新登录。
        console.error('[鉴权] 会话保存失败（本次运行仍有效，重启后需重新登录）:', String(err?.message || err));
    }
}

// 定期清理过期会话：长期运行时只增不减会慢慢堆积内存；登录守卫的 per-IP 记录一并清理（它自己的规则保证还欠着失败次数的记录不会被抹掉）。
const pruneTimer = setInterval(() => {
    const now = Date.now();
    let pruned = false;
    for (const [token, exp] of sessions) if (now > exp) { sessions.delete(token); pruned = true; }
    if (pruned) saveSessions();
    // 登录守卫的 per-IP 记录同样只增不减（换源扫描 / DHCP 续租 / IPv6 隐私地址都会产生新键），一并在这里清。
    try { loginGuard.prune(now); } catch { /* 清理失败不影响鉴权 */ }
}, 10 * 60 * 1000);
pruneTimer.unref?.();

function hashPassword(password, salt) {
    return scryptAsync(String(password), String(salt), 64).then(buf => Buffer.from(buf).toString('hex'));
}

/** 定长摘要后再比较：避免"长度不等直接 return"泄漏信息 */
function safeEqualText(a, b) {
    const ha = createHash('sha256').update(String(a)).digest();
    const hb = createHash('sha256').update(String(b)).digest();
    return timingSafeEqual(ha, hb);
}

function safeEqualHex(a, b) {
    const ba = Buffer.from(String(a), 'hex');
    const bb = Buffer.from(String(b), 'hex');
    if (!ba.length || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

let auth = null; // { isDefault:true, password } 或 { isDefault:false, salt, hash }

async function loadAuthFile() {
    try {
        const o = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
        if (o && typeof o === 'object') return o;
    } catch { /* 文件不存在或损坏 → 继续看老位置 */ }

    // 一次性迁移：老位置有就搬到新位置；搬不动（权限等）也不能让用户被锁在门外，退回用老内容继续跑。
    try {
        const legacy = JSON.parse(await readFile(LEGACY_AUTH_FILE, 'utf8'));
        if (legacy && typeof legacy === 'object') {
            try {
                await mkdir(DATA_DIR, { recursive: true });
                await rename(LEGACY_AUTH_FILE, AUTH_FILE);
                console.log('[鉴权] 访问密码文件已迁移：web/.local-auth.json → data/auth.json');
            } catch (err) {
                console.error('[鉴权] 访问密码文件迁移失败，暂时沿用旧位置:', String(err?.message || err));
            }
            return legacy;
        }
    } catch { /* 老位置也没有 → 视为未初始化 */ }

    return null;
}

async function saveAuthFile(o) {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(AUTH_FILE, JSON.stringify(o, null, 2), 'utf8');
}

// 启动时准备密码：默认状态是「尚未设置」；局域网设备只认用户主动设置的密码，不生成随机默认密码（没人设置过的随机串只会在界面上误导用户）。
async function ensureAuth() {
    auth = await loadAuthFile();
    if (auth && (auth.isDefault === false || (auth.salt && auth.hash))) return { generated: false, isDefault: false };
    const createdAt = (auth && auth.createdAt) || new Date().toISOString();
    if (!auth || auth.isDefault !== true || auth.password) {
        auth = { isDefault: true, createdAt };
        await saveAuthFile(auth);
    }
    return { generated: false, isDefault: true, password: '' };
}

// 校验密码：scrypt 是本服务最重的计算，必须异步，否则并发登录请求会把事件循环整块占住（同步 scryptSync 每次阻塞数十毫秒）。
async function verifyPassword(password) {
    if (!auth) return false;
    if (auth.isDefault && auth.password) return safeEqualText(password, auth.password);
    if (auth.salt && auth.hash) return safeEqualHex(await hashPassword(password, auth.salt), auth.hash);
    return false;
}

async function setPassword(next) {
    const salt = randomBytes(16).toString('hex');
    auth = { isDefault: false, salt, hash: await hashPassword(next, salt), changedAt: new Date().toISOString() };
    await saveAuthFile(auth);
    sessions.clear(); // 改密码后所有已登录设备需重新登录
    await saveSessions();
}

function parseCookies(request) {
    const out = {};
    const raw = request.headers.cookie;
    if (!raw) return out;
    for (const part of String(raw).split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const key = part.slice(0, i).trim();
        let value = part.slice(i + 1).trim();
        // 别的程序也可能往本机写 cookie，百分号编码坏了不该让整页 404 —— 解不开就按原文用。
        try { value = decodeURIComponent(value); } catch { /* 保持原文 */ }
        out[key] = value;
    }
    return out;
}

function hasValidSession(request) {
    const token = parseCookies(request)[SESSION_COOKIE] || '';
    if (!token) return false;
    const key = sessionKey(token);
    const exp = sessions.get(key);
    if (!exp) return false;
    if (Date.now() > exp) { sessions.delete(key); return false; }
    return true;
}

/**
 * 磁盘上有没有一个目录，其 manifest.id 等于给定身份：目录名可被用户改（birthday 住在 birthday-1.1.0），
 * 只回"目录不存在"会让用户以为插件坏了；返回"目录名与 id 不一致"的人话提示（找不到返回空串）。
 */
async function suggestModDir(wantId) {
    try {
        const entries = await readdir(MODS_DIR, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory() || e.name.startsWith('.')) continue;
            const raw = await readFile(path.join(MODS_DIR, e.name, 'manifest.json'), 'utf8').catch(() => '');
            if (!raw) continue;
            let m = null;
            try { m = JSON.parse(raw); } catch { continue; }
            if (m && String(m.id || '').trim() === wantId) {
                const rid = String(m.id || '').trim();
                return '它的安装目录叫「' + e.name + '」（与 manifest.id「' + rid + '」不一致）。'
                    + '把目录改回「' + rid + '」即可，或重新安装这个插件。';
            }
        }
    } catch { /* 目录不可读：保持原错误 */ }
    return '';
}

// 本机 = 管理员（未设置密码时免密；设置后需要先登录）
function isAdmin(request) { return isLocalRequest(request); }

/** 本机是否已经主动设置过访问密码（老 auth 文件没有 isDefault 字段时看 salt/hash） */
function hasAccessPassword() {
    if (!auth) return false;
    if (auth.isDefault === false) return true;
    return Boolean(auth.salt && auth.hash);
}

function isAuthenticated(request) {
    // 未设置访问密码：只有本机可用（局域网接口在 muxSocket 处已直接关闭）。
    if (!hasAccessPassword()) return isAdmin(request);
    // 设置过密码：本机与局域网一律要登录（第一次打开也要输密码，之后靠会话 Cookie 保持登录）。
    return hasValidSession(request);
}

// 简单 CSRF 防护：浏览器发起的跨站请求会带 Origin，要求它与 Host 同源，否则任意网页都能悄悄 POST /api/auth/change-password。
function isSameOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true; // 非浏览器请求（curl / 本机脚本）
    try { return new URL(origin).host === (request.headers.host || ''); } catch { return false; }
}

// 请求日志：启动窗口里直接看到「谁、什么时候、访问了什么、结果如何」，排查手机连不上 / 接口报错时不用开浏览器控制台。
const QUIET_FILE_RE = /\.(?:js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|map)$/i;
// 高频轮询接口在成功时不打日志：/api/logs/tail 是查看器每 2 秒拉一次的数据源，
// 记下来等于日志系统观察自己，把其它事件全挤走；失败（4xx/5xx）仍然要打。
const QUIET_POLL_RE = /^\/api\/(?:logs\/tail|client-log)(?:$|\?)/;

function ipOf(request) {
    const raw = (request && request.socket && request.socket.remoteAddress) || '';
    if (raw === '::1') return '127.0.0.1';
    if (raw.startsWith('::ffff:')) return raw.slice(7);
    return raw || '?';
}

// 把 response 包一层，结束时打一行：成功请求记 DEBUG，4xx 或超过 3s 记 WARN，5xx 记 ERROR；默认看不到成功请求，但内存缓冲保留全量。
function attachRequestLog(request, response) {
    const started = Date.now();
    const origWriteHead = response.writeHead;
    response.writeHead = function (code, ...rest) {
        if (!response.__logStatus) response.__logStatus = code;
        return origWriteHead.call(this, code, ...rest);
    };
    response.on('finish', () => {
        const code = response.__logStatus || response.statusCode || 0;
        const rawPath = String(request.url || '/');
        const pathOnly = rawPath.split('?')[0];
        // 静态资源与高频轮询：连 DEBUG 都不打（缓冲里也不存 —— 纯流量，无信息量）
        if (code < 400 && (QUIET_FILE_RE.test(pathOnly) || QUIET_POLL_RE.test(pathOnly + (rawPath.includes('?') ? '?' : '')))) return;
        const ms = Date.now() - started;
        const slow = ms > 3000;
        const line = ipOf(request).padEnd(15) + ' '
            + String(request.method || '?').padEnd(5) + ' '
            + (rawPath.length > 52 ? rawPath.slice(0, 49) + '...' : rawPath).padEnd(52) + ' '
            + String(code).padEnd(4) + String(ms).padStart(5) + 'ms'
            + (slow ? '  << SLOW' : '')
            + (response.__logNote ? '   ' + response.__logNote : '')
            + (code >= 500 ? '   << server error' : code >= 400 ? '   << request failed' : '');
        const level = code >= 500 ? 'ERROR' : (code >= 400 || slow) ? 'WARN' : 'DEBUG';
        console[level === 'DEBUG' ? 'debug' : level === 'WARN' ? 'warn' : 'error']('[http] ' + line);
    });
}

function redirect(res, location, setCookie) {
    // Location 里的请求路径是攻击者可控输入，过滤控制字符与引号，防止响应分割/注入
    const safeLocation = String(location).replace(/[\r\n"'<>\\]/g, '');
    res.__logNote = '=> ' + safeLocation;
    const headers = { Location: safeLocation, 'Cache-Control': 'no-store' };
    if (setCookie) headers['Set-Cookie'] = setCookie;
    res.writeHead(302, headers);
    res.end();
}

/**
 * 读原始请求体（二进制安全），给数据导入用 —— zip 走 readJsonBody 会被 JSON.parse 弄坏。
 */
async function readRawBody(request, limit = 64 * 1024) {
    const chunks = [];
    let total = 0;
    let overflow = false;
    for await (const chunk of request) {
        total += chunk.length;
        if (total > limit) { overflow = true; chunks.length = 0; continue; }
        chunks.push(chunk);
    }
    if (overflow) {
        const err = new Error('请求体过大');
        err.code = 'LIMIT_EXCEEDED';
        throw err;
    }
    return Buffer.concat(chunks);
}

// 本地中转 /api/relay：实现在 server/relay.mjs，电脑端与手机端共用一份；这里只做接线（追踪日志 + 三个安全判定）。
const relayHandler = createRelay({
    traceLine,
    isLocalRequest,
    isLoopbackHostname,
    isInternalAddress,
});
// 路由分发处用的还是这个名字，调用点不必改
const handleRelay = relayHandler.handleRelay;

async function handleLogin(request, response) {
    const ip = ipOf(request);
    // 未设置访问密码时，局域网设备不能登录：默认状态不是给局域网用的，必须在主机上主动设一个密码。
    if (!isLocalRequest(request) && !hasAccessPassword()) {
        request.resume();
        return jsonResponse(response, 403, {
            ok: false,
            code: 'PASSWORD_NOT_SET',
            message: '本机还没有设置访问密码，局域网设备暂时不能使用。请先在本机的「设置 → 高级 → 访问密码」里设置密码。',
        });
    }
    // ① 先看是否已被锁（全局冻结优先报出来 —— 它连正常用户一起挡，用户需要知道原因）
    const st = loginGuard.status(ip);
    if (st.blocked) {
        request.resume(); // 丢弃请求体，避免客户端连接被重置
        const scopeMsg = st.scope === 'global'
            ? '失败次数过多，登录已临时冻结'
            : '尝试次数过多';
        return jsonResponse(response, 429, {
            ok: false,
            retryAfterSec: st.retryAfterSec,
            message: scopeMsg + '，请 ' + st.retryAfterSec + ' 秒后再试',
        }, { 'Retry-After': String(st.retryAfterSec) });
    }
    let body;
    try { body = await readJsonBody(request); } catch { return jsonResponse(response, 400, { ok: false, message: '请求无效' }); }
    if (!(await verifyPassword(body.password || ''))) {
        const r = loginGuard.fail(ip);
        // 失败日志：爆破时这是唯一的现场记录（谁在试、锁了多久）
        const lockNote = r.lockMs > 0
            ? `，已锁定 ${Math.ceil(r.lockMs / 1000)} 秒`
            : `（第 ${r.count} 次）`;
        console.warn('[鉴权] 密码错误 · ' + ip + lockNote + (r.globalLocked ? ' · 触发全局冻结' : ''));
        return jsonResponse(response, 401, { ok: false, message: '密码不正确' });
    }
    loginGuard.succeed(ip);
    const token = randomBytes(32).toString('hex');
    sessions.set(sessionKey(token), Date.now() + SESSION_TTL_MS);
    await saveSessions();
    jsonResponse(response, 200, { ok: true }, {
        // HTTPS 下必须带 Secure（否则 token 会走明文 HTTP）；HTTP 访问时不能加，否则用户登录不上。
        'Set-Cookie': SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Strict'
            + (request.socket.encrypted ? '; Secure' : '')
            + '; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
    });
}

function loginPageHtml() {
    const authPathHtml = String(AUTH_FILE).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ElainaChat Mod · 需要访问密码</title>
<style>
  /* 配色取自应用实际渲染值（pixso 主题）：
     橄榄绿画布 #a8b974 / 白色面板 / 米色输入框 #f8f5f2 / 绿色药丸按钮 #a7bb6c / 棕色文字 #4c3123 */
  * { box-sizing: border-box; }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px;
    background: #a8b974;
    color: #4c3123;
    font-family: "Outfit Variable", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* 与应用内 .modal-panel 一致 */
  .card {
    width:100%; max-width:380px; padding:30px 28px;
    background: #ffffff;
    border: 1px solid #d9c7c0;
    border-radius: 26px;
    box-shadow: 0 26px 70px rgba(58, 39, 29, 0.24);
  }
  /* 橙色小标，和应用的欢迎弹窗同款 */
  .eyebrow { font-size:11px; font-weight:700; letter-spacing:.08em; color:#ff7d4d; margin-bottom:8px; }
  h1 { margin:0 0 8px; font-size:21px; font-weight:700; color:#4c3123; }
  .sub { margin:0 0 20px; font-size:13px; line-height:1.7; color:#765e52; }
  /* 输入框：与应用内 .modal-input 一致 */
  input {
    width:100%; padding:12px 14px; border-radius:13px; outline:none;
    background: #f8f5f2;
    border: 1px solid #d9c7c0;
    color: #4c3123; font-size:14px; line-height:1.5; font-family:inherit;
    transition: all .18s ease;
  }
  input::placeholder { color: #a89a92; }
  input:focus { background:#ffffff; border-color:#a7bb6c; box-shadow:0 0 0 3px rgba(167,187,108,.25); }
  /* 按钮：与应用内 .btn-primary 一致（绿色药丸） */
  button {
    width:100%; margin-top:12px; padding:12px; cursor:pointer; font-family:inherit;
    border:none; border-radius:999px;
    background: #a7bb6c; color:#ffffff; font-size:15px; font-weight:600;
    transition: all .18s ease;
  }
  button:hover { background:#98ad5c; }
  button:active { transform: translateY(1px); }
  /* 忘记密码：次要按钮，别抢主按钮的位置 */
  button.forgot { margin-top:10px; padding:9px; background:transparent; color:#738746; border:1px solid #d9c7c0; font-size:13px; font-weight:600; }
  button.forgot:hover { background:#f8f5f2; }
  .forgot-hint { margin-top:10px; padding:10px 12px; background:#f8f5f2; border:1px solid #e9ddda; border-radius:10px; text-align:left; }
  .err { min-height:18px; margin:10px 0 0; font-size:12px; color:#d9541f; }
  .divider { height:1px; background:#e9ddda; margin:18px 0 14px; }
  .hint { margin:0; font-size:11.5px; line-height:1.75; color:#765e52; }
  code { background:#f8f5f2; border:1px solid #e9ddda; color:#738746; padding:1px 6px; border-radius:6px; font-size:11px; }
  a { color:#738746; font-weight:600; text-decoration:underline; }
</style>
</head>
<body>
  <div class="card">
    <div class="eyebrow">ElainaChat Mod · 局域网访问</div>
    <h1>需要访问密码</h1>
    <p class="sub">这台设备需要访问密码，请输入后进入。</p>
    <form id="loginForm">
      <input id="pwd" type="password" placeholder="访问密码" autocomplete="current-password" autofocus>
      <button type="submit">进入</button>
    </form>
    <p class="err" id="err"></p>
    <button type="button" class="forgot" id="forgotBtn">忘记密码？</button>
    <p class="hint forgot-hint" id="forgotHint" style="display:none">
      忘记密码只能重置：删除这个文件后重启应用 —— <code>${authPathHtml}</code><br>
      删除后应用会回到「尚未设置密码」状态（局域网接口关闭，只有本机能用），再重新设置即可。
    </p>
    <div class="divider"></div>
    <p class="hint">
      还没设置密码时只有本机能用；设置之后，本机与局域网设备打开应用都需要输入这个密码。<br>
      首次设置请在本机的「设置 → 高级 → 访问密码」里完成。
    </p>
    <div class="divider" id="httpsDivider" style="display:none"></div>
    <p class="hint" id="httpsHint" style="display:none">
      要用语音输入？浏览器规定麦克风只能在 HTTPS 下调用，http 打开的页面一定用不了。<br>
      换成 <a id="httpsLink" href="#">这个 HTTPS 地址</a> 打开即可（首次会提示证书不受信任，
      点「高级」→「继续前往」）。只是聊天的话，现在这个地址就够了。
    </p>
  </div>
<script>
  // 手机通过「http + 局域网 IP」打开时，语音输入会被浏览器禁用（麦克风只在 https/localhost 下可用）。
  // 直接把可点的 HTTPS 地址摆出来，用户不用记端口号，也不用自己改协议。
  (function () {
    var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (location.protocol !== 'http:' || isLocal) return;
    fetch('/api/server-info')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var p = j && j.httpsPort;
        if (!p) return;
        var path = location.pathname === '/login' ? '/' : location.pathname;
        var url = 'https://' + location.hostname + ':' + p + path + location.search;
        var a = document.getElementById('httpsLink');
        if (a) a.href = url;
        var d = document.getElementById('httpsDivider');
        var h = document.getElementById('httpsHint');
        if (d) d.style.display = 'block';
        if (h) h.style.display = 'block';
      })
      .catch(function () { /* 拿不到就不显示，不影响登录 */ });
  })();

  document.getElementById('forgotBtn').addEventListener('click', function () {
    var h = document.getElementById('forgotHint');
    if (h) h.style.display = h.style.display === 'none' ? 'block' : 'none';
  });

  document.getElementById('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = document.getElementById('err');
    err.textContent = '';
    try {
      var res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('pwd').value })
      });
      var json = await res.json();
      if (json.ok) { location.href = '/'; return; }
      err.textContent = json.message || '密码不正确';
    } catch (e2) {
      err.textContent = '网络错误：' + e2.message;
    }
  });
</script>
</body>
</html>`;
}

// HTTP 与 HTTPS 共用的请求处理器（HTTPS 只是为了手机端能用麦克风，路由逻辑完全一致）
const requestHandler = async (request, response) => {
    attachRequestLog(request, response);
    try {
        const url = new URL(request.url || '/', `http://${host}`);
        // 反斜杠先归一成斜杠，必须在 decodeURIComponent 之后（%5c 也要处理）：new URL() 不碰反斜杠，path.resolve 会把 ..\..\serve.mjs 解析上跳。
        const pathname = decodeURIComponent(url.pathname).replace(/\\/g, '/');

        // ① Host 白名单：防 DNS rebinding（详见 isAllowedHost 说明），必须在其他所有处理之前 —— "是否本机"本身依赖请求来源可信。
        if (!isAllowedHost(request)) {
            const msg = '禁止访问：请求的 Host「' + String(request.headers.host || '') + '」不在允许列表内。\n'
                + '如果你确实是通过主机名/域名访问，请用环境变量追加白名单后重启，例如：\n'
                + '  set ALLOWED_HOSTS=my-pc.local\n'
                + '（这是为了防止 DNS rebinding 让任意网页拿到本机管理员身份）';
            if (pathname.startsWith('/api/')) return jsonResponse(response, 403, { ok: false, message: msg });
            response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return response.end(msg);
        }

        // ①.5 HTTP → HTTPS 自动跳转：HTTPS 可用才跳、本机不跳、/api/ 不跳；?stay=http 留在 http（写 cookie），?stay=https 恢复自动跳转。
        if (!request.socket.encrypted) {
            let urlObj = null;
            try { urlObj = new URL(request.url || '/', 'http://' + (request.headers.host || 'localhost')); } catch { /* 忽略怪 URL */ }
            const stay = urlObj ? urlObj.searchParams.get('stay') : null;

            if (stay === 'http') {
                urlObj.searchParams.delete('stay');
                return redirect(response, urlObj.pathname + (urlObj.search || ''),
                    'elaina_stay_http=1; Path=/; Max-Age=31536000; SameSite=Lax');
            }
            if (stay === 'https') {
                return redirect(response, urlObj.pathname, 'elaina_stay_http=; Path=/; Max-Age=0; SameSite=Lax');
            }

            const reqHostname = hostnameOfHostHeader(request.headers.host);
            const canUpgrade = Boolean(certInfo)
                && !pathname.startsWith('/api/')                  // 接口不跳，否则前端 fetch 会炸
                && !isLoopbackHostname(reqHostname)               // 本机不跳
                && parseCookies(request)['elaina_stay_http'] !== '1'
                && /text\/html/i.test(String(request.headers.accept || '')); // 只跳页面导航，不跳静态资源
            if (canUpgrade) {
                // 跳到同一个端口的 https：每个端口都同时认两种协议，地址里只有协议变了，用户不用换端口号。
                const hostHeader = String(request.headers.host || '');
                const colon = hostHeader.lastIndexOf(':');
                const reqPort = colon > 0 ? hostHeader.slice(colon + 1) : '443';
                return redirect(response, 'https://' + reqHostname + ':' + reqPort + (request.url || '/'));
            }
        }

        // ② CSRF：非 GET 的跨站请求一律拒绝（详见 isSameOrigin 说明）
        if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameOrigin(request)) {
            return jsonResponse(response, 403, { ok: false, message: '跨站请求被拒绝' });
        }
        // ③ 跨站 GET 也要拦：第三方页面可能不带 Origin，但会带 Sec-Fetch-Site: cross-site；不拦的话 /api/agent/read 可被任意网页借本机浏览器读取本地文件。
        if (pathname.startsWith('/api/') && isCrossSiteRequest(request)) {
            return jsonResponse(response, 403, { ok: false, message: '跨站请求被拒绝' });
        }

        // 服务端信息（无需鉴权，只暴露端口号）：登录页也用它，手机用 http 打开时得能给出可点的 HTTPS 地址。
        if (pathname === '/api/server-info' && request.method === 'GET') {
            return jsonResponse(response, 200, {
                ok: true,
                // 同一个端口同时支持 https，所以返回主端口本身
                httpsPort: certInfo ? port : 0,
                httpPort: port,
                // 版本与运行形态：设置页要显示当前版本并按形态给安装包；不含敏感信息，登录页也拿得到。
                version: APP_VERSION,
                edition: APP_EDITION,
            });
        }

        // 登录页（无需鉴权）；同样加防嵌套头 —— 能被 iframe 嵌套就等于给了点击劫持一个落点。
        if (pathname === '/login') {
            // 已持有有效会话就不该再看到密码表单：后退/刷新回到这里再要一次密码会让用户以为没登录成功，直接回首页。
            if (hasValidSession(request)) return redirect(response, '/');
            response.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Frame-Options': 'DENY',
                'Referrer-Policy': 'no-referrer',
                'X-Content-Type-Options': 'nosniff',
            });
            return response.end(loginPageHtml());
        }
        if (pathname === '/api/auth/login' && request.method === 'POST') {
            return await handleLogin(request, response);
        }
        if (!isAuthenticated(request)) {   // 本机（管理员）放行，其余必须已登录
            if (pathname.startsWith('/api/')) {
                return jsonResponse(response, 401, { ok: false, message: '需要访问密码', needLogin: true });
            }
            response.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
            return response.end();
        }

        // 本地中转：放在鉴权之后 —— 它会把请求原样转发到任意 http(s) 地址，不能让未登录访客当跳板。
        if (pathname === '/api/relay' && request.method === 'POST') {
            return await handleRelay(request, response);
        }

        // 前端日志上报：把浏览器控制台错误转到启动窗口，拿手机排查时也能与请求日志对照。
        if (pathname === '/api/client-log' && request.method === 'POST') {
            let body;
            try { body = await readJsonBody(request, 64 * 1024); } catch { return jsonResponse(response, 400, { ok: false }); }
            const items = Array.isArray(body && body.items) ? body.items.slice(0, 20) : [];
            for (const it of items) {
                const rawLevel = String((it && it.level) || 'log').toLowerCase();
                const level = ['debug', 'info', 'warn', 'error'].includes(rawLevel) ? rawLevel : 'log';
                const page = String((it && it.page) || '').slice(0, 36);
                const text = String((it && it.text) || '').trim();
                if (!text) continue;
                // 主日志压成一行；截得太短（300 字符）会把最关键的上游报错砍在半截，放宽到 2000。
                const oneLine = text.replace(/\s+/g, ' ');
                const clipped = oneLine.length > 2000
                    ? oneLine.slice(0, 2000) + ' …（已截断，完整内容见追踪日志）'
                    : oneLine;
                // 浏览器的 console.debug 必须真的记成 DBUG，否则"把级别调到 DEBUG"也看不到前端调试信息。
                const method = { debug: 'debug', info: 'log', warn: 'warn', error: 'error' }[level] || 'log';
                console[method]('[page] ' + ipOf(request).padEnd(15) + ' '
                    + (page ? page + '  ' : '') + clipped);
                traceLine(`===== 浏览器上报 · ${page || '/'} · ${level.toUpperCase()} =====\n${text}`);
            }
            return jsonResponse(response, 200, { ok: true });
        }

        // 日志查看器的数据源：从内存缓冲按条件取（level / tags / search / limit / since + sinceSeq）；不读文件，缓冲才是全量，切级别/模块即时生效。
        if (pathname === '/api/logs/tail' && request.method === 'GET') {
            const u = new URL(request.url || '/', 'http://x');
            const result = logBuffer.query({
                minLevel: normalizeLevelName(u.searchParams.get('level')) || undefined,
                tags: u.searchParams.get('tags') ? u.searchParams.get('tags').split(',').map((s) => s.trim()).filter(Boolean) : undefined,
                search: u.searchParams.get('search') || undefined,
                limit: Number(u.searchParams.get('limit')) || undefined,
                // 增量游标是两个值（时间戳 + 写入序号）：只传 since 会让同一毫秒里的后续记录被永久跳过（见 server/log-buffer.mjs 的 query()）。
                since: Number(u.searchParams.get('since')) || undefined,
                sinceSeq: u.searchParams.get('sinceSeq') !== null && u.searchParams.get('sinceSeq') !== ''
                    ? Number(u.searchParams.get('sinceSeq')) : undefined,
            });
            return jsonResponse(response, 200, { ok: true, ...result, tags: logBuffer.tags() });
        }

        // 日志设置：读取当前状态 / 运行时调整级别与对话追踪；放在鉴权之后 —— 它会改服务端行为。
        if (pathname === '/api/logs/settings' && request.method === 'GET') {
            return jsonResponse(response, 200, {
                ok: true,
                level: fileLevel,
                consoleLevel,
                levels: LEVEL_NAMES,
                trace: traceEnabled,
                fileEnabled: LOG_TO_FILE,
                logDir: path.relative(APP_ROOT, LOG_DIR) || '.',
                mainFile: mainSink.file ? path.relative(APP_ROOT, mainSink.file) : '',
                traceFile: traceSink.file ? path.relative(APP_ROOT, traceSink.file) : '',
                keep: LOG_KEEP,
                maxMb: Math.round(LOG_MAX_BYTES / 1024 / 1024),
            });
        }
        if (pathname === '/api/logs/settings' && request.method === 'POST') {
            let body;
            try { body = await readJsonBody(request, 8 * 1024); } catch { return jsonResponse(response, 400, { ok: false, message: '请求格式无效' }); }
            const notes = [];
            if (body && body.level !== undefined) {
                const want = normalizeLevelName(body.level);
                if (!want) return jsonResponse(response, 400, { ok: false, message: '级别无效，可选：' + LEVEL_NAMES.join(' / ') });
                if (setFileLogLevel(want)) notes.push(`落盘级别已改为 ${want}`);
            }
            if (body && body.consoleLevel !== undefined) {
                const want = normalizeLevelName(body.consoleLevel);
                if (!want) return jsonResponse(response, 400, { ok: false, message: '级别无效，可选：' + LEVEL_NAMES.join(' / ') });
                if (setConsoleLevel(want)) notes.push(`控制台级别已改为 ${want}`);
            }
            if (body && body.trace !== undefined) {
                if (setTraceEnabled(body.trace)) notes.push(body.trace ? '对话追踪已开启' : '对话追踪已关闭');
            }
            if (notes.length) {
                console.warn(`[log] 日志设置已更新：${notes.join('；')}（操作者 ${ipOf(request)}）`);
            }
            return jsonResponse(response, 200, {
                ok: true, level: fileLevel, consoleLevel, trace: traceEnabled, changed: notes,
            });
        }

        // 端侧数据存储：需要跨设备共享的项（设置 / 聊天记录 / API Key）走 data/store.json；已过上面的鉴权。
        if (pathname === '/api/store' && request.method === 'GET') {
            return jsonResponse(response, 200, { ok: true, data: await loadStore() });
        }
        if (pathname === '/api/store' && request.method === 'POST') {
            let body;
            try {
                body = await readJsonBody(request, STORE_MAX_BYTES);
            } catch {
                return jsonResponse(response, 400, { ok: false, message: '提交内容过大或格式无效' });
            }
            const { patch, oversized } = normalizeStorePatch(body && body.data);
            if (oversized.length) {
                const first = oversized[0];
                return jsonResponse(response, 413, {
                    ok: false,
                    code: 'KEY_TOO_LARGE',
                    message: '「' + first.key + '」过大（约 ' + Math.round(first.size / 1024 / 1024) + 'M 字符），'
                        + '本次未保存。请先在设置里导出备份并清理聊天记录，再继续。',
                    keys: oversized,
                });
            }
            const current = await loadStore();
            // 按键合并：只覆盖本次提交的键；null 是删除标记，必须 delete 而不是赋成 null（否则文件里留一份假数据）。
            for (const [k, v] of Object.entries(patch)) {
                if (v === null) delete current[k];
                else current[k] = v;
            }
            try {
                await saveStore();
            } catch (err) {
                return jsonResponse(response, 500, {
                    ok: false,
                    code: 'STORE_WRITE_FAILED',
                    message: '保存失败（数据还在本机内存里，检查磁盘空间 / 文件权限后重试）：'
                        + String((err && err.message) || err),
                });
            }
            broadcastStoreChange(patch, request);
            return jsonResponse(response, 200, { ok: true, keys: Object.keys(patch).length });
        }

        // 多设备实时同步：SSE 长连接（EventSource 原生支持、自动重连），比 WebSocket 少一层握手与帧协议实现。
        if (pathname === '/api/store/stream' && request.method === 'GET') {
            return handleStoreStream(request, response);
        }

        // 数据导出：把 data/ 下的全部分类数据打包成一个 zip 文件下载，用于换机器、重装、升级前备份。
        if (pathname === '/api/data/export' && request.method === 'GET') {
            let body;
            try {
                body = await buildBackupBuffer();
            } catch (err) {
                // 插件目录读不到（被占用 / 权限）时不能悄悄退回"只导出 data/"：用户会以为备份是全的。
                const msg = String((err && err.message) || err);
                console.error('[备份] 导出失败：' + msg);
                return jsonResponse(response, 500, { ok: false, message: '导出失败：' + msg });
            }
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            const filename = `elainachat-backup-${stamp}.zip`;
            // 刻意不发 Content-Disposition: attachment：迅雷/FDM 这类下载器看到 attachment 就抢走 URL；改由前端 fetch 成 blob 后用 <a download> 保存，文件名走自定义头。
            response.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Length': body.length,
                'X-Backup-Filename': filename,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            });
            return response.end(body);
        }
        // 数据导入：接受 zip 或 v1 单 JSON 备份，按 merge（默认）或 replace 合并进 data/；收原始字节而不是 JSON（zip 会被解析坏）。
        if (pathname === '/api/data/import' && request.method === 'POST') {
            let raw;
            try {
                raw = await readRawBody(request, MAX_UPLOAD);
            } catch (err) {
                const over = err && (err.code === 'LIMIT_EXCEEDED' || /过大|too large/i.test(String(err.message || err)));
                return jsonResponse(response, over ? 413 : 400, {
                    ok: false, message: over ? '备份文件过大' : '读取备份失败：' + String((err && err.message) || err),
                });
            }
            const mode = url.searchParams.get('mode') === 'replace' ? 'replace' : 'merge';
            try {
                const out = await importBackupPayload(raw, mode);
                return jsonResponse(response, out.status, out.body);
            } catch (err) {
                return jsonResponse(response, 400, { ok: false, message: '导入失败：' + (err && err.message ? err.message : '未知错误') });
            }
        }
        if (pathname === '/api/data/info' && request.method === 'GET') {
            const storeData = await loadStore();
            const keys = Object.keys(storeData);
            const counts = { characters: 0, conversations: 0, memoryEntries: 0, mods: 0, skills: 0 };
            try { counts.characters = JSON.parse(storeData['elaina_open_character_cards'] || '[]').length; } catch { /* 忽略 */ }
            try { counts.conversations = JSON.parse(storeData['elaina_open_conversations'] || '[]').length; } catch { /* 忽略 */ }
            try {
                const mem = JSON.parse(storeData['elaina_open_memory_core'] || '{}');
                counts.memoryEntries = Array.isArray(mem.diary) ? mem.diary.length : 0;
            } catch { /* 忽略 */ }
            try {
                const pkg = await packageBackup.counts();
                counts.mods = pkg.mods;
                counts.skills = pkg.skills;
            } catch { /* 目录读不到时仍返回其它统计 */ }
            return jsonResponse(response, 200, {
                ok: true,
                dir: path.relative(APP_ROOT, DATA_DIR) || 'data',
                layout: {
                    settings: 'store.json（设置 / API Key / UI 偏好）',
                    characters: 'characters/（一卡一文件）',
                    conversations: 'conversations/（一对话一文件）',
                    memory: 'memory.json',
                    mods: 'mods/（已安装插件，导入备份时原样写回）',
                    skills: 'skills/（本地技能，导入备份时原样写回）',
                    logs: 'logs/',
                },
                counts,
                keys: keys.length,
            });
        }

        // 版本检测：查 GitHub 最新 Release，供「设置 → 高级 → 版本与更新」用；放在鉴权闸门之后避免未登录访客当跳板，只做检测与提示（见 web/js/update-check.js）。
        if (pathname === '/api/app/update' && request.method === 'GET') {
            const result = await updateChecker.check();
            return jsonResponse(response, 200, Object.assign({ current: APP_VERSION, edition: APP_EDITION }, result));
        }

        // 局域网共享数据：与「我的数据」的导出 / 导入配套；同属 /api/data/，仍走上面的鉴权闸门。
        if (pathname.startsWith(LAN_SHARE_PREFIX + '/')) {
            if (await lanShare.handle(request, response, { pathname, url })) return;
        }

        // 鉴权状态：初始明文密码只回给本机管理员；本机管理员才拿到真实路径（重置密码要删的就是它，DATA_DIR 可被覆盖）。
        if (pathname === '/api/auth/status' && request.method === 'GET') {
            const admin = isAdmin(request);
            return jsonResponse(response, 200, {
                ok: true,
                isAdmin: admin,
                isDefaultPassword: Boolean(auth && auth.isDefault),
                passwordHint: (admin && auth && auth.isDefault && auth.password) ? auth.password : '',
                authFile: admin ? AUTH_FILE : '',
                passwordManagedByConfig: Boolean(FILE_CONFIG.password),
            });
        }
        if (pathname === '/api/auth/change-password' && request.method === 'POST') {
            if (!isAdmin(request) || !isAuthenticated(request)) {
                return jsonResponse(response, 403, { ok: false, message: '只有本机（已登录的管理员）可以修改访问密码' });
            }
            if (FILE_CONFIG.password) {
                return jsonResponse(response, 409, { ok: false, message: '访问密码由 data/config.json 管理，请修改配置文件里的 password 后重启应用' });
            }
            let body;
            try { body = await readJsonBody(request); } catch { return jsonResponse(response, 400, { ok: false, message: '请求无效' }); }
            const next = String(body.next || '');
            // 强度校验：密码是"能不能在这台电脑上执行命令"的唯一那道门，弱口令在跑得动 scrypt 的机器上可被离线秒破（见 auth-guard.mjs）。
            const strength = validatePasswordStrength(next);
            if (!strength.ok) {
                return jsonResponse(response, 400, { ok: false, message: strength.message });
            }
            await setPassword(next);
            // 改密码后把登录失败记录一并清掉：旧密码攒下的锁定不该连累新密码，否则用户刚设完强密码手机还被锁着。
            loginGuard.reset();
            // 当前设备刚设完密码，直接补发一个会话：setPassword() 清空所有会话，若连本机一起踢回登录页就要再输一遍。
            const token = randomBytes(32).toString('hex');
            sessions.set(sessionKey(token), Date.now() + SESSION_TTL_MS);
            await saveSessions();
            console.log('[鉴权] 访问密码已更新（其它设备需重新登录）');
            return jsonResponse(response, 200, {
                ok: true,
                message: '访问密码已更新，其它设备需要用新密码重新登录',
                minLength: PWD_MIN_LEN,
            }, {
                'Set-Cookie': SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Strict'
                    + (request.socket.encrypted ? '; Secure' : '')
                    + '; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
            });
        }


        // 插件（mod）接口：列出插件每次请求都重新扫描目录 —— 用户可能在服务运行期间把 zip 拷进 mods/，启动扫一次会让他以为没生效。
        if (pathname === '/api/plugins' && request.method === 'GET') {
            try {
                const result = await modManager.scanAndSync();
                return jsonResponse(response, 200, {
                    ok: true,
                    plugins: result.installed,
                    // 回报安装结果：zip 解压失败时必须让用户看到原因，否则"我把 zip 放进去了但没反应"无从排查。
                    installResults: result.results,
                    // 服务端半边装载状态：路由是启动时一次装载的常驻注册表，如实报出 needsRestart 而不是让用户面对静默不工作的接口。
                    serverRoutes: modServer.status(result.installed),
                });
            } catch (err) {
                return jsonResponse(response, 500, { ok: false, message: '扫描插件目录失败：' + String((err && err.message) || err) });
            }
        }
        // 在文件管理器里打开插件目录：这是让服务进程唤起本机程序的特权操作，只限本机，且只认 ?id=<插件id> 或不带参数（不把路径交给 shell）。
        if (pathname === '/api/plugins/open-folder' && request.method === 'POST') {
            if (!isLocalRequest(request)) {
                return jsonResponse(response, 403, { ok: false, message: '只有本机可以打开文件夹' });
            }
            // `dir=`：浏览器里点「在文件管理器打开」失败时的兜底查看，只回目录名清单 —— 同一道本机限制，不收也不回任何路径。
            if (url.searchParams.get('dir') === '1') {
                const shown = process.platform === 'win32' ? MODS_DIR : 'mods/';
                const entries = await readdir(MODS_DIR, { withFileTypes: true }).catch(() => []);
                return jsonResponse(response, 200, {
                    ok: true,
                    path: shown,
                    entries: entries
                        .filter((e) => !e.name.startsWith('.'))
                        .map((e) => ({ name: e.name, dir: e.isDirectory() })),
                });
            }
            let target = MODS_DIR;
            const wantId = String(url.searchParams.get('id') || '').trim();
            // sub：插件目录内的一层子路径（如 models/deepseek），逐段白名单 + 解析后必须仍在插件目录内；用于直接打开模型文件夹改文件。
            const wantSub = String(url.searchParams.get('sub') || '').trim().replace(/\\/g, '/');
            if (wantId) {
                if (!modManager.MOD_ID_RE.test(wantId)) {
                    return jsonResponse(response, 400, { ok: false, message: '插件名不合法' });
                }
                // id 是身份（manifest.id），磁盘上住的是目录名，两者可以不同（表 A9）；必须先按 id 反查真实目录。
                const resolved = await modManager.findModDirById(wantId);
                let dir = resolved || path.join(MODS_DIR, wantId);
                if (!dir.startsWith(MODS_DIR + path.sep)) {
                    return jsonResponse(response, 400, { ok: false, message: '路径越界' });
                }
                if (wantSub) {
                    const segs = wantSub.split('/').filter(Boolean);
                    for (const s of segs) {
                        if (s === '.' || s === '..' || s.startsWith('.')) {
                            return jsonResponse(response, 400, { ok: false, message: '子路径不合法' });
                        }
                        if (/[<>:"|?*\u0000-\u001f]/.test(s)) {
                            return jsonResponse(response, 400, { ok: false, message: '子路径含非法字符' });
                        }
                    }
                    // 插件目录的边界是反查出来的真实目录，不是按 id 拼出来的路径（两者对"身份≠目录名"的插件不同，拿错会让合法子路径被判越界）。
                    const pluginDir = dir;
                    dir = path.join(pluginDir, ...segs);
                    if (dir !== pluginDir && !dir.startsWith(pluginDir + path.sep)) {   // 双保险：拼完必须仍在插件目录内
                        return jsonResponse(response, 400, { ok: false, message: '路径越界' });
                    }
                }
                const info = await stat(dir).catch(() => null);
                if (!info || !info.isDirectory()) {
                    // 失败原因要指回用户能做的动作：反查到了真实目录说明"名字对不上"已解决；缺子路径时别再说"目录名不一致"。
                    const hint = resolved ? '' : await suggestModDir(wantId);
                    return jsonResponse(response, 404, {
                        ok: false,
                        message: '目录不存在：' + (resolved && wantSub
                            ? path.basename(resolved) + '/' + wantSub
                            : wantId + (wantSub ? '/' + wantSub : ''))
                            + (resolved && wantSub ? '（插件目录在，但这个子路径不存在）' : '')
                            + (hint ? '。' + hint : ''),
                    });
                }
                target = dir;
            } else {
                // 根目录可能还不存在（全新安装、一个插件都没装）→ 先建出来，否则"打开文件夹"会失败。
                await mkdir(MODS_DIR, { recursive: true }).catch(() => {});
            }
            // 用 spawn 而不是 exec（参数经数组、不经 shell，路径里的空格/引号不会变命令注入）；不能"发出去就报成功"—— explorer/open 瞬间返回，要等启动结果。
            const openInfo = process.platform === 'win32'
                ? { cmd: 'explorer', shown: target }
                : process.platform === 'darwin'
                    ? { cmd: 'open', shown: target }
                    : { cmd: 'xdg-open', shown: target };
            // explorer 打开目录是正常用法，退出码可能非 0，不能据此判失败 —— 只认 spawn 的同步抛错（命令不存在 / 没权限启动）。
            try {
                spawn(openInfo.cmd, [target], { detached: true, stdio: 'ignore' }).unref();
            } catch (err) {
                const why = String((err && err.message) || err);
                console.log('[Mod] 打开插件目录失败：' + why + '（' + target + '）');
                return jsonResponse(response, 500, {
                    ok: false,
                    message: '打不开系统文件管理器（' + openInfo.cmd + '）：' + why
                        + '。插件目录是 ' + (process.platform === 'win32' ? target : 'mods/')
                        + '，可改用「浏览目录」查看。',
                    path: target,
                });
            }
            console.log('[Mod] 已请求打开插件目录：' + target);
            return jsonResponse(response, 200, { ok: true, path: target });
        }
        const plugDel = pathname.match(/^\/api\/plugins\/([^/]+)$/);
        if (plugDel && request.method === 'DELETE') {
            if (!isLocalRequest(request)) {
                return jsonResponse(response, 403, { ok: false, message: '只有本机可以卸载插件' });
            }
            try {
                await modManager.uninstall(plugDel[1]);
                return jsonResponse(response, 200, { ok: true });
            } catch (err) {
                return jsonResponse(response, 400, { ok: false, message: String((err && err.message) || err) });
            }
        }
        // 上传安装插件：只靠"把 zip 拷进 mods/"不够（手机/平板碰不到文件系统）；请求体是 zip 原始字节（非 multipart），插件名从 query 取。
        if (pathname === '/api/plugins/install' && request.method === 'POST') {
            if (!isLocalRequest(request)) {
                return jsonResponse(response, 403, { ok: false, message: '只有本机可以安装插件' });
            }
            const rawName = String(url.searchParams.get('name') || '').trim();
            if (!rawName) {
                return jsonResponse(response, 400, { ok: false, message: '缺少插件名（请把 zip 文件名作为 name 参数）' });
            }
            // 先拒绝"名字里带路径成分"的请求，再净化：先净化会把 ../../hack.zip 静默改成 hack 并安装成功，既曲解意图又掩盖穿越尝试。
            if (/[\\/]/.test(rawName) || rawName.includes('..')) {
                return jsonResponse(response, 400, { ok: false, message: '插件名不能包含路径成分（/ \\ ..）' });
            }
            const id = rawName.replace(/\.zip$/i, '');
            if (!id) {
                return jsonResponse(response, 400, { ok: false, message: '缺少插件名（请把 zip 文件名作为 name 参数）' });
            }
            let buf;
            try {
                buf = await readRawBody(request, MAX_UPLOAD);
            } catch (err) {
                return jsonResponse(response, 413, { ok: false, message: '上传失败或文件过大：' + String((err && err.message) || err) });
            }
            if (!buf || buf.length < 22) {
                return jsonResponse(response, 400, { ok: false, message: '文件为空或不是有效的 zip' });
            }
            try {
                const r = await modManager.installFromBuffer(buf, id);
                await modManager.scanAndSync();
                console.log(`[Mod] 已通过上传安装插件：${id}（${r.written} 个文件${r.skipped ? '，跳过 ' + r.skipped + ' 个' : ''}）`);
                return jsonResponse(response, 200, {
                    ok: true, id: r.id, files: r.written, skipped: r.skipped,
                    message: '已安装 ' + r.id + '（' + r.written + ' 个文件）',
                });
            } catch (err) {
                return jsonResponse(response, 400, { ok: false, message: String((err && err.message) || err) });
            }
        }

        // 技能（skill）接口：技能是给 AI 的指令与知识（纯文本、不注册进应用），与插件分开管理、独立成 /api/skills；列出技能每次请求都重新扫描。
        if (pathname === '/api/skills' && request.method === 'GET') {
            try {
                const result = await skillManager.scan();
                return jsonResponse(response, 200, { ok: true, skills: result.skills });
            } catch (err) {
                return jsonResponse(response, 500, { ok: false, message: '扫描技能目录失败：' + String((err && err.message) || err) });
            }
        }
        if (pathname === '/api/skills/install' && request.method === 'POST') {
            if (!isLocalRequest(request)) {
                return jsonResponse(response, 403, { ok: false, message: '只有本机可以安装技能' });
            }
            const rawName = String(url.searchParams.get('name') || '').trim();
            if (!rawName) {
                return jsonResponse(response, 400, { ok: false, message: '缺少技能名（请把 zip 文件名作为 name 参数）' });
            }
            // 先拒绝"名字里带路径成分"的请求，再净化（顺序同插件安装）：否则 `../../hack.zip` 会被静默改成 `hack`。
            if (/[\\/]/.test(rawName) || rawName.includes('..')) {
                return jsonResponse(response, 400, { ok: false, message: '技能名不能包含路径成分（/ \\ ..）' });
            }
            const id = rawName.replace(/\.zip$/i, '');
            if (!id) {
                return jsonResponse(response, 400, { ok: false, message: '缺少技能名（请把 zip 文件名作为 name 参数）' });
            }
            let buf;
            try {
                buf = await readRawBody(request, MAX_UPLOAD);
            } catch (err) {
                return jsonResponse(response, 413, { ok: false, message: '上传失败或文件过大：' + String((err && err.message) || err) });
            }
            if (!buf || buf.length < 22) {
                return jsonResponse(response, 400, { ok: false, message: '文件为空或不是有效的 zip' });
            }
            try {
                const r = await skillManager.installFromBuffer(buf, id);
                await skillManager.scan();
                console.log(`[Skill] 已通过上传安装技能：${id}（${r.written} 个文件${r.skipped ? '，跳过 ' + r.skipped + ' 个' : ''}）`);
                return jsonResponse(response, 200, {
                    ok: true, id: r.id, files: r.written, skipped: r.skipped,
                    message: '已安装 ' + r.id + '（' + r.written + ' 个文件）',
                });
            } catch (err) {
                return jsonResponse(response, 400, { ok: false, message: String((err && err.message) || err) });
            }
        }
        const skillDel = pathname.match(/^\/api\/skills\/([^/]+)$/);
        if (skillDel && request.method === 'DELETE') {
            if (!isLocalRequest(request)) {
                return jsonResponse(response, 403, { ok: false, message: '只有本机可以卸载技能' });
            }
            try {
                await skillManager.uninstall(skillDel[1]);
                return jsonResponse(response, 200, { ok: true });
            } catch (err) {
                return jsonResponse(response, 400, { ok: false, message: String((err && err.message) || err) });
            }
        }
        // 读技能的 SKILL.md：技能目录不在静态根 web/ 内，前端拼不出路径；用 (.+) 允许 id 含斜杠，安全性靠 skillManager.readSkill 的路径校验。
        const skillContent = pathname.match(/^\/api\/skills\/(.+)\/content$/);
        if (skillContent && request.method === 'GET') {
            try {
                const id = skillContent[1];
                const r = await skillManager.readSkill(id);
                if (!r.ok) {
                    return jsonResponse(response, 404, { ok: false, message: r.message });
                }
                return jsonResponse(response, 200, { ok: true, name: r.name, text: r.text });
            } catch (err) {
                return jsonResponse(response, 500, { ok: false, message: String((err && err.message) || err) });
            }
        }

        // API：AI Agent 文件/命令操作（权限档位见 AGENT_ACCESS_LEVELS）；privileged = 本机或已登录的局域网设备，能到这里必然已过 isAuthenticated。
        const privileged = hasComputerGrant(request);
        if (pathname === '/api/agent/roots' && request.method === 'GET') {
            const { roots } = resolveShellFolders();
            const rootsAccess = normalizeAgentAccess(url.searchParams.get('access') || url.searchParams.get('permission'));
            const revealPaths = privileged && !accessDisabled(rootsAccess);
            const visible = revealPaths ? roots : roots.map(r => ({ ...r, path: undefined }));
            return jsonResponse(response, 200, { ok: true, platform: process.platform, roots: visible });
        }
        if (pathname === '/api/agent/ls' && request.method === 'GET') {
            return await agentLs(url.searchParams, response, privileged);
        }
        if (pathname === '/api/agent/read' && request.method === 'GET') {
            return await agentRead(url.searchParams, response, privileged);
        }
        if (pathname === '/api/agent/write' && request.method === 'POST') {
            return await agentWrite(request, response, privileged);
        }
        if (pathname === '/api/agent/delete' && request.method === 'POST') {
            return await agentDelete(request, response, privileged);
        }
        if (pathname === '/api/agent/exec' && request.method === 'POST') {
            return await agentExec(request, response, privileged);
        }
        // AI 用浏览器：真的开 Chrome / Edge 看页面、点东西；鉴权比文件/命令更紧（见 browserDenyReason）—— 调试端口能读全部 cookie，只认本机。
        if (pathname === '/api/agent/browser' && request.method === 'POST') {
            let body;
            try { body = await readJsonBody(request, 64 * 1024); } catch { return jsonResponse(response, 400, { ok: false, message: '请求体无效' }); }
            const access = normalizeAgentAccess(body.access || body.permission);
            const deny = browserDenyReason(request, access);
            if (deny) return jsonResponse(response, 403, { ok: false, message: deny });
            if (!await browserEnabledByUser()) {
                return jsonResponse(response, 403, {
                    ok: false,
                    message: '浏览器功能没有打开。请在「设置 → 能力 → 浏览器」里打开「允许 AI 用浏览器」。',
                });
            }
            const result = await runBrowserAction(browserSession, body.action, body.args || {});
            // 一律 200：ok 在 body 里。浏览器"打不开这个网址"是正常结果，用 4xx/5xx 会让前端当成服务端坏了，而模型需要那条具体原因。
            return jsonResponse(response, 200, result);
        }
        if (pathname === '/api/agent/browser/status' && request.method === 'GET') {
            const access = normalizeAgentAccess(url.searchParams.get('access') || url.searchParams.get('permission'));
            const deny = browserDenyReason(request, access);
            if (deny) return jsonResponse(response, 403, { ok: false, message: deny });
            const exe = findBrowserExecutable();
            return jsonResponse(response, 200, {
                ok: true,
                available: Boolean(exe),
                executable: exe,
                running: browserSession.isRunning(),
            });
        }
        // MCP 客户端：列出"用户配置的 MCP 服务器此刻提供哪些工具"，前端启动时拉一次并注册成操作注册表条目（ns:'mcp'）。
        if (pathname === '/api/mcp/tools' && request.method === 'GET') {
            const access = normalizeAgentAccess(url.searchParams.get('access') || url.searchParams.get('permission'));
            if (access === 'off') {
                return jsonResponse(response, 403, { ok: false, message: '电脑操作已关闭，MCP 工具也不可用' });
            }
            const servers = await mcpServersFromSettings();
            const out = [];
            for (const def of servers) {
                const res = await mcpRegistry.listTools(def);
                out.push({
                    id: def.id,
                    name: def.name,
                    ok: res.ok,
                    error: res.error,
                    tools: res.tools.map((t) => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                    })),
                });
            }
            return jsonResponse(response, 200, { ok: true, servers: out });
        }
        if (pathname === '/api/mcp/call' && request.method === 'POST') {
            let body;
            try { body = await readJsonBody(request, 256 * 1024); } catch { return jsonResponse(response, 400, { ok: false, message: '请求体无效' }); }
            const access = normalizeAgentAccess(body.access || body.permission);
            if (access === 'off') {
                return jsonResponse(response, 403, { ok: false, message: '电脑操作已关闭，MCP 工具也不可用' });
            }
            const serverId = String(body.server || '').trim();
            const toolName = String(body.tool || '').trim();
            if (!serverId || !toolName) {
                return jsonResponse(response, 400, { ok: false, message: '需要 server 与 tool' });
            }
            const servers = await mcpServersFromSettings();
            const def = servers.find((s) => s.id === serverId);
            // 不在"已启用"清单里的服务器一律拒绝：前端可以被绕过，"配置里没有却能调起来"等于绕过用户关掉的开关。
            if (!def) {
                return jsonResponse(response, 403, { ok: false, message: '没有这台 MCP 服务器，或它没有启用：' + serverId });
            }
            const result = await mcpRegistry.callTool(def, toolName, body.arguments || {});
            // 一律 200：ok 在 body 里。工具自身报错（isError / 超时）是正常结果，模型需要那条具体原因而不是"接口 500"。
            return jsonResponse(response, 200, result);
        }
        // 测试连接：拿一份还没保存的配置去连一次（否则只有"保存后才知道连不连得上"）；配置还没落盘，只能由前端把候选配置递过来。
        if (pathname === '/api/mcp/test' && request.method === 'POST') {
            let body;
            try { body = await readJsonBody(request, 64 * 1024); } catch { return jsonResponse(response, 400, { ok: false, message: '请求体无效' }); }
            const access = normalizeAgentAccess(body.access || body.permission);
            if (access === 'off') {
                return jsonResponse(response, 403, { ok: false, message: '电脑操作已关闭，MCP 工具也不可用' });
            }
            const raw = body.server;
            if (!raw || typeof raw !== 'object') {
                return jsonResponse(response, 400, { ok: false, message: '需要 server 配置对象' });
            }
            const def = {
                id: String(raw.id || 'test').trim() || 'test',
                name: String(raw.name || raw.id || 'test').trim(),
                url: String(raw.url || '').trim(),
                command: String(raw.command || '').trim(),
                args: Array.isArray(raw.args) ? raw.args.map(String) : [],
                env: (raw.env && typeof raw.env === 'object') ? raw.env : {},
                cwd: String(raw.cwd || '').trim(),
                headers: (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers))
                    ? Object.fromEntries(Object.entries(raw.headers)
                        .filter(([k, v]) => k && (typeof v === 'string' || typeof v === 'number'))
                        .map(([k, v]) => [String(k), String(v)]))
                    : {},
            };
            if (!def.url && !def.command) {
                return jsonResponse(response, 200, { ok: false, message: '需要 url（远程）或 command（本地），否则连不上' });
            }
            def.id = '__test__' + def.id;
            try {
                const res = await mcpRegistry.listTools(def);
                if (!res.ok) {
                    return jsonResponse(response, 200, { ok: false, message: res.error || '连接失败' });
                }
                const tools = (res.tools || []).map((t) => t.name);
                const st = mcpRegistry.status(def);
                return jsonResponse(response, 200, {
                    ok: true,
                    message: '连接成功，发现 ' + tools.length + ' 个工具',
                    serverInfo: (st && st.serverInfo) || null,
                    tools,
                });
            } catch (err) {
                return jsonResponse(response, 200, { ok: false, message: String((err && err.message) || err) });
            } finally {
                try { await mcpRegistry.stop({ id: def.id }); } catch { /* 忽略 */ }
            }
        }
        if (pathname === '/api/mcp/stop' && request.method === 'POST') {
            let body = {};
            try { body = await readJsonBody(request, 16 * 1024); } catch { body = {}; }
            const serverId = String((body && body.server) || '').trim();
            if (serverId) {
                await mcpRegistry.stop({ id: serverId });
                return jsonResponse(response, 200, { ok: true, stopped: [serverId] });
            }
            await mcpRegistry.stop();
            return jsonResponse(response, 200, { ok: true, stopped: 'all' });
        }
        if (pathname === '/api/mcp/status' && request.method === 'GET') {
            const servers = await mcpServersFromSettings();
            return jsonResponse(response, 200, {
                ok: true,
                servers: servers.map((def) => ({ id: def.id, name: def.name, ...mcpRegistry.status(def) })),
            });
        }
        // 看电脑在干什么（前台窗口 + 进程），供桌宠让 AI 知道用户在做什么；这是隐私数据，已登录的局域网设备也能读 —— 密码就是这道门。
        if (pathname === '/api/agent/activity' && request.method === 'GET') {
            if (!privileged) {
                return jsonResponse(response, 403, { ok: false, message: '需要登录后才能读取电脑活动状态' });
            }
            // off 档：前台窗口标题 / 可见文本 / 进程列表也是"电脑信息"，整块关闭时一并拒掉。
            if (accessDisabled(url.searchParams.get('access') || url.searchParams.get('permission'))) {
                return agentDisabledResponse(response);
            }
            const force = url.searchParams.get('force') === '1';
            return jsonResponse(response, 200, activitySummaryCached(force));
        }

        // 插件（mod）注册的服务端路由：排在宿主所有路由之后、静态文件之前 —— 宿主永远优先，插件 /api 前缀不会被静态处理器当成找不到的文件。
        if (await modServer.handle(request, response, { pathname, url })) return;

        // 读插件的 README：走接口而不是让前端 fetch —— 目录名与 id 可能不一致、.md 不在 MIME 表里会被当下载、且这里用白名单文件名读；放在 modServer.handle 之后让插件路由优先。
        const readmeMatch = pathname.match(/^\/api\/plugins\/([^/]+)\/readme$/);
        if (readmeMatch && request.method === 'GET') {
            try {
                const id = readmeMatch[1];
                const r = await modManager.readReadme(id);
                if (!r.ok) {
                    return jsonResponse(response, 404, { ok: false, message: r.message });
                }
                return jsonResponse(response, 200, { ok: true, name: r.name, text: r.text });
            } catch (err) {
                return jsonResponse(response, 500, { ok: false, message: String((err && err.message) || err) });
            }
        }

        // 插件清单必须每次请求都重新扫描：前端加载插件读的就是这个文件，只刷新页面时清单还是旧的，目录改名后会去请求旧目录、插件加载失败。
        if (pathname === '/mods/index.json' && request.method === 'GET') {
            try {
                const result = await modManager.scanAndSync();
                const body = JSON.stringify({
                    comment: '本文件由服务端扫描 mods/ 自动生成（见 server/mods.mjs）。手工改动会在下次扫描时被覆盖。',
                    generatedAt: new Date().toISOString(),
                    plugins: result.installed,
                }, null, 2);
                response.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                });
                return response.end(body);
            } catch (err) {
                console.error('[Mod] 生成插件清单失败：' + String((err && err.message) || err));
                return jsonResponse(response, 500, { ok: false, message: '扫描插件目录失败' });
            }
        }

        // 浏览器会自己请求 /favicon.ico，没这个文件就每开一次页面刷一条 404；回 204 安静且语义正确。
        if (pathname === '/favicon.ico') {
            response.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
            return response.end();
        }

        // 插件静态资源 /mods/：插件目录在项目根的 mods/，静态处理器只发 web/，没有这段就是立绘 / 背景 / Live2D 模型 / panel.html 全部 404；MIME 按真实扩展名发。
        if (pathname.startsWith('/mods/')) {
            try {
                const rel = pathname.slice('/mods/'.length);
                if (!rel || rel.endsWith('/')) {
                    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
                    return;
                }
                const target = path.resolve(MODS_DIR, rel);
                if (target !== MODS_DIR && !target.startsWith(MODS_DIR + path.sep)) {   // 二次确认仍在插件根内，挡住拼接绕过
                    response.writeHead(403, { 'X-Content-Type-Options': 'nosniff' }).end('Forbidden');
                    return;
                }
                const st = lstatSync(target);
                if (st.isSymbolicLink() || !st.isFile()) throw new Error('Not a regular file');

                // 插件声明的"用户上传落地处"仍按二进制流发：用户上传的 zip 若混入 .html/.svg，同源渲染就是 XSS 执行点。
                const uploadRoots = modServer.uploadRoots();
                const inUploadDir = uploadRoots.some((r) => target.startsWith(r + path.sep));
                const ext = path.extname(target).toLowerCase();
                const ctype = inUploadDir
                    ? 'application/octet-stream'
                    : (contentTypes.get(ext) || 'application/octet-stream');

                response.writeHead(200, {
                    'Content-Type': ctype,
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                    ...(ctype.startsWith('text/html') ? {
                        'X-Frame-Options': 'DENY',
                        'Referrer-Policy': 'no-referrer',
                    } : {}),
                });
                return streamFile(response, target);
            } catch {
                response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
                return;
            }
        }

        const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        // 禁止访问隐藏文件：挡住 .env / .git / 各类点文件，以及误放在这里的 .local-auth.json（正确位置是 data/）。
        if (relative.split('/').some(seg => seg.startsWith('.'))) {
            response.writeHead(403, { 'X-Content-Type-Options': 'nosniff' }).end('Forbidden');
            return;
        }

        // 路径穿越：`..` 段一律拒绝 —— pathname 只做了 decodeURIComponent、没有规范化，不判的话不存在的路径会 200 并绕开插件静态映射。
        if (relative.split(/[\\/]+/).some(seg => seg === '..')) {
            response.writeHead(403, { 'X-Content-Type-Options': 'nosniff' }).end('Forbidden');
            return;
        }

        // 先问插件：这条 URL 是不是某个插件声明的静态资源（Live2D 模型走 /live2d/models/…）；排在宿主静态解析之前，resolveStatic 内部负责段边界与越界校验。
        const modStatic = modServer.resolveStatic(pathname, (abs) => {
            try { const st = lstatSync(abs); return st.isFile() && !st.isSymbolicLink(); } catch { return false; }
        });
        if (modStatic) {
            // MIME 由插件声明决定：'binary' 一律 octet-stream（防 zip 混入 .html/.svg 被同源渲染）；'auto'（mod 自带代码）按真实 MIME，否则 nosniff 会拒绝执行。
            const mime = modStatic.mime === 'auto'
                ? (contentTypes.get(path.extname(modStatic.abs).toLowerCase()) || 'application/octet-stream')
                : 'application/octet-stream';
            return serveFile(response, modStatic.abs, mime);
        }

        const target = path.resolve(root, relative);
        const allowed = target.startsWith(root + path.sep);
        if (!allowed && target !== path.join(root, 'index.html')) {
            response.writeHead(403, { 'X-Content-Type-Options': 'nosniff' }).end('Forbidden');
            return;
        }
        const info = await lstat(target);   // 符号链接不跟随，避免 web/ 内的软链把任意文件读出去
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('Not a regular file');

        // 插件声明的"用户上传落地处"一律按二进制流返回：用户上传的 zip 混入 .html/.svg，同源渲染就是 XSS 执行点。
        const uploadRoots = modServer.uploadRoots();
        const inUploadDir = uploadRoots.some((r) => target.startsWith(r + path.sep));
        const ext = path.extname(target).toLowerCase();
        const ctype = inUploadDir ? 'application/octet-stream' : (contentTypes.get(ext) || 'application/octet-stream');

        response.writeHead(200, {
            'Content-Type': ctype,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...(relative === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
            // HTML 页面不许被第三方页面 iframe 嵌套（点击劫持），Referer 也不该把带 ?stay=http 的 URL 泄给外链。
            ...(ctype.startsWith('text/html') ? {
                'X-Frame-Options': 'DENY',
                'Referrer-Policy': 'no-referrer',
            } : {}),
        });
        return streamFile(response, target);
    } catch {
        if (!response.headersSent) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }).end('Not found');
        } else {
            try { response.destroy(); } catch { /* ignore */ }
        }
    }
};

/**
 * 流式返回一个文件（宿主页面与插件静态资源共用）。
 * 单独抽出来是为了让两条路径共用同一份错误兜底与句柄释放，复制一份迟早分叉。
 */
function streamFile(response, filePath) {
    const stream = createReadStream(filePath);
    // pipe 不转发错误，必须自己兜住：读取失败 / 客户端中途断开不能变成未处理异常，且要释放文件句柄。
    stream.on('error', () => { try { response.destroy(); } catch { /* ignore */ } });
    response.on('close', () => { try { stream.destroy(); } catch { /* ignore */ } });
    stream.pipe(response);
}

/**
 * 返回插件静态目录里的一个文件。
 * 类型固定为 octet-stream（与 uploadRoots 同一理由），防用户上传的 .html/.svg 被同源渲染。
 */
function serveFile(response, filePath, ctype) {
    response.writeHead(200, {
        'Content-Type': ctype || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    return streamFile(response, filePath);
}

// 启动监听失败：英文、一行事件 + 结构化细节（技术日志规范），用 CRITICAL —— 服务根本没起来；修复命令保留给需要的人。
function printListenError(err, which, usedPort) {
    if (err && err.code === 'EADDRINUSE') {
        const alt = Number(usedPort) + 2;
        logCritical(`[boot] CRITICAL: ${which} port ${usedPort} already in use - server not started`
            + `\n  cause: another process is bound to this port (most likely a previous instance that is still running)`
            + `\n  fix 1: find & kill it:  netstat -ano | findstr :${usedPort}  then  taskkill /PID <pid> /F`
            + `\n  fix 2: use another port:  set PORT=${alt} && node web/serve.mjs`
            + `\n  （一句话：端口被占用，多半是上一个实例还开着 —— 关掉它或按上面换端口重启）`);
    } else {
        logCritical(`[boot] CRITICAL: ${which} listen failed: ${String((err && err.message) || err)}`);
    }
    process.exitCode = 1;
}

if (process.argv.includes('--reset-password')) {
    await rm(AUTH_FILE, { force: true });
    await rm(LEGACY_AUTH_FILE, { force: true });
    await rm(SESSIONS_FILE, { force: true });
    console.log('[鉴权] 已按 --reset-password 清除旧密码，将重新生成');
}
const authInfo = await ensureAuth();
if (FILE_CONFIG.password) {
    const strength = validatePasswordStrength(FILE_CONFIG.password);
    if (!strength.ok) {
        console.error('[boot] CRITICAL: data/config.json 的 password 不满足强度要求：' + strength.message);
        process.exit(1);
    }
    if (!(await verifyPassword(FILE_CONFIG.password))) {
        await setPassword(FILE_CONFIG.password);
        authInfo.isDefault = false;
        console.log('[鉴权] 访问密码已按 data/config.json 更新（其它设备需重新登录）');
    }
}
await loadSessions();

// 数据存储迁移：单文件 store.json 把聊天记录/人设卡/记忆挤在一起，按类别拆开（见 server/store.mjs）；在监听之前跑完，幂等。
try {
    const moved = await store.migrateIfNeeded();
    if (moved.length) {
        console.log(`[store] 数据已迁移到分类存储：${moved.join('、')}（原始数据未删除，见 data/）`);
    }
} catch (err) {
    console.error('[store] 迁移失败（服务继续启动，旧数据未受影响）:', err && err.message ? err.message : err);
}

// --reset-cert：换一张新的自签证书；用户自己的证书不会被覆盖。
const forceNewCert = process.argv.includes('--reset-cert');
const certInfo = HTTPS_ENABLED ? await ensureCertificate(forceNewCert) : null;
if (certInfo && certInfo.custom) {
    console.log('[boot] 使用自定义 HTTPS 证书：' + CERT_PATHS.cert);
} else if (certInfo && certInfo.generated) {
    console.log('[boot] 已生成 HTTPS 自签证书（有效期 825 天）');
} else if (!HTTPS_ENABLED) {
    console.log('[boot] HTTPS 已在配置中关闭，只跑 HTTP');
} else if (!certInfo) {
    console.warn('[boot] HTTPS 不可用（openssl 缺失或证书生成失败），本次只跑 HTTP');
}

// 监听入口：同一个端口按首字节分流 HTTP / HTTPS；未设置访问密码时，局域网连接在 TCP 层就销毁。
const httpServer = createServer(requestHandler);
const httpsServer = certInfo
    ? createSecureServer({ key: certInfo.key, cert: certInfo.cert }, requestHandler)
    : null;

if (httpsServer) {
    httpsServer.on('tlsClientError', (err, socket) => {
        const addr = (socket && socket.remoteAddress) ? socket.remoteAddress.replace('::ffff:', '') : '?';
        console.warn('[tls] ' + addr.padEnd(15) + ' TLS 握手失败   '
            + String((err && err.message) || err).slice(0, 100));
    });
}

const muxSocket = (socket) => {
    // 未设置访问密码时，局域网接口直接关闭：非回环连接直接销毁 socket（连接被重置）；本机回环照常可用，设置密码后新连接立即放行。
    if (!hasAccessPassword() && !isLocalRequest({ socket })) {
        try { socket.destroy(); } catch (e) { /* 已关 */ }
        return;
    }
    // 客户端"连上又立刻断开"（DevTools 自动探测）会让裸 socket 抛 ECONNRESET，分路之前没人接这个错误会带崩进程。
    socket.on('error', () => { try { socket.destroy(); } catch (e) { /* 已关 */ } });
    socket.once('data', (buf) => {
        if (!buf || !buf.length) { socket.destroy(); return; }
        socket.pause();
        socket.unshift(buf);
        if (buf[0] === 0x16 && httpsServer) httpsServer.emit('connection', socket);
        else httpServer.emit('connection', socket);
        process.nextTick(() => socket.resume());
    });
};

const mainServer = createNetServer(muxSocket);

// 真正对外用的端口：显式给了 PORT 就用它（检查脚本走这条），否则从 3999 起自动找一个空闲的。
let port = PORT_START;
if (!PORT_EXPLICIT) {
    try {
        port = await pickPort(PORT_START, host, PORT_SCAN_SPAN);
        if (port !== PORT_START) {
            console.log(`[boot] port ${PORT_START} is busy, using ${port} instead`);
        }
    } catch (err) {
        console.error('[boot] ' + String((err && err.message) || err));
        process.exit(1);
    }
}
mainServer.on('error', (err) => printListenError(err, 'HTTP/HTTPS', port));

// exclusive 在 Windows 上闸住"同一地址:端口被别的进程再绑一次"，但挡不住共享；端口归谁由 isPortFree 的探针决定，这里只补一道闸。
mainServer.listen({ port, host, exclusive: true }, async () => {
    // 启动事件：一行一个事实、英文（"怎么用"的引导已移出日志流）—— 什么在什么端口、装了什么插件、密码是不是初始的。
    const urls = ['http://127.0.0.1:' + port];
    if ((host === '0.0.0.0' || host === '::') && hasAccessPassword()) {
        for (const ip of localIPv4List()) urls.push('http://' + ip + ':' + port);
    }
    console.log(`[boot] listening on ${urls.join(', ')}${certInfo ? ' (HTTP+HTTPS on the same port)' : ''}`);

    // 自动打开浏览器（只在用户双击启动那条路下做，判定收在 openBrowser 里）；地址用实际监听到的端口，端口漂移后写死 3999 是打不开的。
    openBrowser('http://127.0.0.1:' + port);

    if (authInfo.isDefault) {
        console.log('[auth] LAN access password: not set (set one in Settings → Advanced before LAN devices can connect)');
    } else {
        console.log('[auth] LAN access password: user-configured');
    }

    try {
        const r = await modManager.scanAndSync();
        if (r.installed.length) {
            for (const p of r.installed) {
                console.log(`[mod] installed: ${p.id} (dir=${p.dir}${p.after.length ? ', after=' + p.after.join('+') : ''})`);
            }
        } else {
            console.log('[mod] no plugins installed (text chat works without them)');
        }
        if (r.results.length) {
            for (const res of r.results) {
                if (res.ok) console.log(`[mod] installed from zip: ${res.id} (${res.files} files)`);
                else console.error(`[mod] install failed: ${res.zip} - ${res.error}`);
            }
        }
        // 插件的服务端半边（manifest.server）：启动时装载一次，路由是常驻注册表；必须按用户的启用状态过滤，否则停用只停前端。
        const enabledState = await loadStore();
        const isEnabled = (id, entry) => {
            if (String(enabledState['elaina_plugins_enabled'] ?? '') === '0') return false;
            const v = enabledState['elaina_plugin_' + id];
            if (v === '1') return true;
            if (v === '0') return false;
            return Boolean(entry && entry.defaultEnabled === true);
        };
        const srv = await modServer.loadAll(r.installed, isEnabled);
        if (srv.needsRestart.length) {
            for (const n of srv.needsRestart) console.warn(`[mod] server side pending restart: ${n.id} - ${n.why}`);
        }
    } catch (err) {
        console.error(`[mod] scan failed: ${String((err && err.message) || err)}`);
    }

    console.log('[boot] 就绪。日志可在应用内「设置 → 日志」按级别/模块筛选查看。');
});

/**
 * 按需打开浏览器指向某个已就绪的地址（全新启动与「已有实例在跑」共用）。
 * 只在 OPEN_BROWSER === '1' 时打开（serve.mjs 也是几十个检查用例的子进程，无条件弹窗会炸出几十个标签页）；失败只警告不退出。
 */
function openBrowser(url) {
    if (process.env.OPEN_BROWSER === '1') {
        try {
            // Windows 的 start 是 cmd 内建命令，必须经 cmd /c；第一个引号参数是窗口标题，不能省（否则带引号的 URL 会被当成标题）。
            const cmd = process.platform === 'win32'
                ? ['cmd', ['/c', 'start', '', url]]
                : process.platform === 'darwin'
                    ? ['open', [url]]
                    : ['xdg-open', [url]];
            const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
            child.unref();
            console.log('[boot] opening browser: ' + url);
        } catch (err) {
            console.warn('[boot] 无法自动打开浏览器（' + String((err && err.message) || err)
                + '）—— 请手动访问 ' + url);
        }
    }
}

