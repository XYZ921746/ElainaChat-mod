// 检查脚本共用运行时 —— 断言计数、端口分配、等待、Go 服务端夹具、zip 造/读。
// 每个模块用 runModule() 跑一组**串行**执行的用例：
// 用例各自一个函数作用域，断言经 ctx.ok 记账（失败记成 `<用例名> :: <断言>`），单个用例抛异常不影响后续用例。
// 用法见 check-chat.mjs：import { runModule, ok, wait, freePort } 后调 runModule({ title, usage, cases })。

import { spawn, spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 让出事件循环 ms 毫秒 —— 等子进程吐出启动日志、等页面渲染完 */
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立，成立即返回、超时才放弃 —— 固定 wait(N) 既慢（条件早成立仍付满额）又会随机假红（机器忙时 N 不够）；@returns {Promise<boolean>} */
export async function waitFor(probe, opts = {}) {
    const timeoutMs = opts.timeoutMs === undefined ? 8000 : opts.timeoutMs;
    const intervalMs = opts.intervalMs === undefined ? 60 : opts.intervalMs;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try { if (await probe()) return true; } catch { /* 还没就绪：继续轮询 */ }
        if (Date.now() >= deadline) return false;
        await wait(intervalMs);
    }
}

/** 向内核要一个当前空闲的端口（监听 0 后立刻关掉，有极小竞态窗口）：硬编码端口并行跑会互撞，表现为与产品无关的失败。 */
export const freePort = () => new Promise((res, rej) => {
    const s = createNetServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => res(p));
    });
});

/** 带单次超时的探测请求：返回布尔、不抛错 —— 裸 fetch 在对方不回包时会永远挂着，整轮检查停住不动且无任何报错线索。 */
export async function probeOk(url, timeoutMs = 2000) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        return Boolean(res && res.ok);
    } catch {
        return false;
    }
}

/** 轮询 /api/server-info 直到这个检查起的服务真的就绪；单次探测带超时（见 probeOk）—— 端口被占、对方不回包时，无超时的轮询会挂死整轮检查。 */
export async function waitServerUp(base, opts = {}) {
    return waitFor(() => probeOk(base + '/api/server-info', opts.probeTimeoutMs), {
        timeoutMs: opts.timeoutMs === undefined ? 20000 : opts.timeoutMs,
        intervalMs: opts.intervalMs === undefined ? 50 : opts.intervalMs,
    });
}

// ==================== Go 服务端夹具 ====================
// 运行时服务端只有一套 Go 实现：需要真实 HTTP 的用例都拉起 server/ 里编译出的二进制。
// 没装 Go 工具链时 buildGoServer() 返回 null，用例据此按环境性跳过（不判红）。

let goServerBin = null;

/** 编译（或复用）检查用的 Go 服务端二进制；无 Go 工具链返回 null。构建走 go 缓存，通常一两秒。
 *  spawnSync 会阻塞事件循环，并发模块的首次调用天然串行，不会出现两个 go build 写同一输出。 */
export function buildGoServer() {
    if (goServerBin && existsSync(goServerBin)) return goServerBin;
    const probe = spawnSync('go', ['version'], { encoding: 'utf8', windowsHide: true });
    if (probe.error || probe.status !== 0) return null;
    const outDir = path.join(os.tmpdir(), `elaina-check-server-${process.pid}`);
    const ext = process.platform === 'win32' ? '.exe' : '';
    const out = path.join(outDir, 'elaina-server' + ext);
    const res = spawnSync('go', ['build', '-o', out, './cmd/elaina-server'], {
        cwd: path.join(ROOT, 'server'),
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
    });
    if (res.status !== 0 || !existsSync(out)) {
        throw new Error('Go 服务端编译失败：\n' + String(res.stdout || '') + String(res.stderr || ''));
    }
    goServerBin = out;
    return out;
}

/**
 * 起一个真实的 Go 服务端：注入与产品运行形态同名的环境变量（PORT/HOST/DATA_DIR/LOG_DIR/…），
 * 等就绪后返回句柄。OPEN_BROWSER 必须显式关掉，否则检查会弹浏览器。
 * extraEnv 里的值必须是字符串；stop() 幂等，用例抛异常也要在 finally 里收尾。
 */
// 端口分配器：单次运行内单调递增、用过的绝不复用。freePort 的「绑定 0 → 关闭 → 复用」
// 在并发之间有竞态窗口（A 关闭后 B 挑中同一端口并先绑定），表现为大面积与产品无关的假红
// （第 38 周期收尾记录过）。run-checks 会给每个子进程注入不相交的 ELAINA_CHECK_PORT_BASE
// （按并发 worker 切片），子进程内部再单调递增 —— 跨进程撞车从构造上不可能发生；
// 单独跑模块时退回 pid 散列基点（单进程内同样不会自撞）。
const harnessPortBase = (() => {
    const raw = Number(process.env.ELAINA_CHECK_PORT_BASE);
    if (Number.isFinite(raw) && raw >= 20000 && raw <= 60000) return Math.floor(raw);
    return 20000 + (process.pid % 30000);
})();
let harnessPortCounter = harnessPortBase;
const harnessUsedPorts = new Set();
export const allocateHarnessPort = () => {
    let candidate = harnessPortCounter;
    do {
        candidate += 1;
        if (candidate >= harnessPortBase + 1000) candidate = harnessPortBase + 1;
    } while (harnessUsedPorts.has(candidate));
    harnessPortCounter = candidate;
    harnessUsedPorts.add(candidate);
    return candidate;
};

export async function startGoServer({ env = {}, extraEnv = {}, onOutput } = {}) {
    const bin = buildGoServer();
    if (!bin) return null;
    const port = env.PORT ? Number(env.PORT) : allocateHarnessPort();
    // 每个夹具一份独立 config（默认就在它自己的 DATA_DIR 里，与产品布局一致）：
    // 改密类用例会把 password 写进 ELAINA_CONFIG_FILE 指向的文件，共享一份会让
    // 同模块里后启动的服务整个带起密码；调用方显式给了 ELAINA_CONFIG_FILE 就尊重它。
    const dataDir = env.DATA_DIR || extraEnv.DATA_DIR;
    const hasExplicitConfig = env.ELAINA_CONFIG_FILE !== undefined || extraEnv.ELAINA_CONFIG_FILE !== undefined;
    const childEnv = {
        ...process.env,
        OPEN_BROWSER: '0',
        LOG_TO_FILE: '0',
        HOST: '127.0.0.1',
        PORT: String(port),
        ...env,
        ...extraEnv,
    };
    if (dataDir && !hasExplicitConfig) {
        childEnv.ELAINA_CONFIG_FILE = path.join(dataDir, 'config.json');
    }
    const child = spawn(bin, [], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let bootLog = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { bootLog += d; if (onOutput) onOutput(d); });
    child.stderr.on('data', (d) => { bootLog += d; if (onOutput) onOutput(d); });
    const base = `http://127.0.0.1:${port}`;
    let up = await waitServerUp(base);
    // 端口竞态守卫：PORT 被并发用例抢先绑定时本进程会立刻退出，而探活探到的是别人的服务 ——
    // 稍等后确认子进程还活着，up 才可信。
    await new Promise((r) => setTimeout(r, 100));
    up = up && child.exitCode === null && child.signalCode === null;
    let stopped = false;
    return {
        bin, base, port, child, up,
        // 日志是持续的：技能/插件扫描这类动作发生在首次请求时，快照会把后续行漏掉
        get bootLog() { return bootLog; },
        stop() {
            if (stopped) return;
            stopped = true;
            try { child.kill(); } catch { /* 已经退了 */ }
        },
        async stopped() {
            return waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 5000, intervalMs: 30 })
                .then(() => true);
        },
    };
}

// ==================== zip 造 / 读夹具 ====================
// 只服务测试：手工构造 store（不压缩）zip、读出条目（store 与 deflate 都解）。
// 产品语义（危险扩展名、路径穿越、体积上限）唯一实现在 server/internal/zipx，这里不重复。

function crc32(buf) {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

/** 造一个 store（不压缩）zip。entries: [{ name, data }]，data 为字符串或 Buffer。 */
export function makeZip(entries) {
    const chunks = [], central = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        const crc = crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        chunks.push(local, nameBuf, raw);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(raw.length, 20); cd.writeUInt32LE(raw.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(offset, 42);
        central.push(cd, nameBuf);
        offset += local.length + nameBuf.length + raw.length;
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, cdBuf, eocd]);
}

/** 读 zip 全部条目（store 与 deflate 都解），返回 [{ name, data:Buffer }]；坏结构抛错。 */
export function readZipEntries(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    // 从尾部找 EOCD（0x06054b50）：注释最长 65535，向后扫足够远
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
        if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip：找不到 EOCD');
    const count = b.readUInt16LE(eocd + 10);
    let p = b.readUInt32LE(eocd + 16);
    const out = [];
    for (let i = 0; i < count; i++) {
        if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('zip：中央目录损坏');
        const method = b.readUInt16LE(p + 10);
        const compSize = b.readUInt32LE(p + 20);
        const nameLen = b.readUInt16LE(p + 28);
        const extraLen = b.readUInt16LE(p + 30);
        const commentLen = b.readUInt16LE(p + 32);
        const lfhOffset = b.readUInt32LE(p + 42);
        const name = b.slice(p + 46, p + 46 + nameLen).toString('utf8');
        // 回到 local header 读真实数据起点（local extra 与 central extra 长度可能不同）
        const lNameLen = b.readUInt16LE(lfhOffset + 26);
        const lExtraLen = b.readUInt16LE(lfhOffset + 28);
        const dataStart = lfhOffset + 30 + lNameLen + lExtraLen;
        const raw = b.slice(dataStart, dataStart + compSize);
        const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
        out.push({ name, data });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

/** 跑一个模块的全部用例（顺序执行），失败记成 `<用例名> :: <断言>` —— 单个用例抛异常不影响后续用例：一次改动要能暴露全部问题，而不是修一个跑一轮。 */
export async function runModule({ title, usage, cases }) {
    let pass = 0;
    let fail = 0;
    const failures = [];

    const ok = (c, label, extra) => {
        if (c) {
            pass++;
            console.log('  PASS  ' + label);
        } else {
            fail++;
            failures.push(`${current} :: ${label}`);
            console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : ''));
        }
    };

    let current = '(init)';
    const ctx = { ok, ROOT, wait, waitFor, waitServerUp, freePort };
    ctx.c = ctx;

    console.log(`\n########## ${title} ##########`);
    if (usage) console.log(`用法：${usage}`);

    for (const item of cases) {
        current = item.name;
        console.log(`\n=== ${item.name} ===`);
        try {
            await item.fn(ctx);
        } catch (e) {
            fail++;
            failures.push(`${item.name} :: <用例抛出异常>`);
            console.log('  FAIL  用例抛出异常  -> ' + (e && e.message ? e.message : e));
            if (e && e.stack) console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
        }
    }

    return { pass, fail, failures };
}

export function report({ pass, fail, failures }, { label } = {}) {
    console.log('\n' + '='.repeat(46));
    if (label) console.log('  ' + label);
    console.log(`  PASS ${pass}   FAIL ${fail}`);
    if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
    console.log('='.repeat(46));
    process.exitCode = fail ? 1 : 0;
}

/** 合并模块的入口：跑用例、打汇总、设退出码，每个 check-<模块>.mjs 结尾只剩一行调用 */
export async function runChecks(spec) {
    const r = await runModule(spec);
    report(r, { label: spec.title });
    if (spec.onFinish) await spec.onFinish(r);
    return r;
}
