// 检查模块的并行运行器：并行可调并发、单模块计时（末尾按耗时排序）、输出按模块分组。
// 清单只在这个文件里维护：package.json 的 check 脚本调它——两份清单必然漂移，漏跑查不出。
// 用法：
//   node scripts/run-checks.mjs                 全部，默认并发
//   node scripts/run-checks.mjs --jobs 8        指定并发
//   node scripts/run-checks.mjs --only mod      只跑名字含 mod 的模块
//   node scripts/run-checks.mjs --serial        退回串行（排查互相干扰时用）
//   node scripts/run-checks.mjs --bail          第一个失败就停（不启动后续模块）

import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 检查模块清单。
 * nodeArgs 让额外 Node 参数跟着模块走（如 check-frontend 需要 --experimental-vm-modules，
 * 缺它是环境问题不是代码错），而不是要求人记住怎么调。
 */
const MODULES = [
    // Go 服务端是运行时本体：编译 / vet / 测试排在最前，失败时无需再跑前端模块。
    { name: 'check-go' },
    { name: 'check-frontend', args: ['--experimental-vm-modules'] },
    { name: 'check-agent' },
    { name: 'check-chat' },
    { name: 'check-data' },
    { name: 'check-stream' },
    { name: 'check-mod' },
    { name: 'check-log' },
    { name: 'check-security' },
    { name: 'check-ui' },
    // 手机 / 桌面同一份 DOM 响应式呈现的约定检查：断点收口、分层退出、「我的」入口落地、二级页单壳。
    { name: 'check-mobile' },
    { name: 'check-system' },
    { name: 'check-update' },
    // 浏览器能力（CDP）：没装 Chrome/Edge 的机器上，真浏览器用例按环境性跳过（不判红）
    { name: 'check-browser' },
];

function parseArgs(argv) {
    const out = {
        jobs: Math.max(2, Math.min(6, os.cpus().length - 1)),
        only: '', serial: false, bail: false,
        // 单模块硬超时：轮询漏带单次超时会让进程永远挂着不报错，超时即杀并报失败
        timeoutMs: 300000,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--serial') out.serial = true;
        else if (a === '--bail') out.bail = true;
        else if (a === '--jobs') out.jobs = Math.max(1, Number(argv[++i]) || 1);
        else if (a.startsWith('--jobs=')) out.jobs = Math.max(1, Number(a.slice(7)) || 1);
        else if (a === '--only') out.only = String(argv[++i] || '');
        else if (a.startsWith('--only=')) out.only = a.slice(7);
        else if (a === '--timeout') out.timeoutMs = Math.max(10000, Number(argv[++i]) || 300000);
        else if (a.startsWith('--timeout=')) out.timeoutMs = Math.max(10000, Number(a.slice(10)) || 300000);
    }
    if (out.serial) out.jobs = 1;
    return out;
}

/** 跑一个模块，收集输出与耗时；不打印（由调用方按完成顺序打印）。
 *  portBase 给子进程一个专属端口区间（ELAINA_CHECK_PORT_BASE）：并发模块各自起真实服务，
 *  freePort 的绑定-关闭-复用窗口会让两个模块抢到同一端口，整段用例打在别人的服务上。
 *  configPath 给子进程一份独立配置：改密类用例会把 password 写进 ELAINA_CONFIG_FILE 指向的
 *  文件，共享一份会让后启动的模块整个带起密码（全量 401 假红）。 */
function runModule(mod, timeoutMs, portBase) {
    return new Promise((resolve) => {
        const started = Date.now();
        const configPath = path.join(os.tmpdir(), `elaina-check-config-${process.pid}-${portBase}.json`);
        try { writeFileSync(configPath, '{}\n', 'utf8'); } catch { /* 写不出就继承父环境 */ }
        const child = spawn(process.execPath, [...(mod.args || []), path.join('scripts', mod.name + '.mjs')], {
            cwd: ROOT,
            env: {
                ...process.env,
                ELAINA_CHECK_PORT_BASE: String(portBase),
                ELAINA_CONFIG_FILE: configPath,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let out = '';
        let killedByTimeout = false;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });

        const timer = setTimeout(() => {
            killedByTimeout = true;
            try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
        }, timeoutMs);

        const finish = (code) => {
            clearTimeout(timer);
            // 每个模块一份独立的临时配置：跑完就删，不在 temp 里攒小文件。
            try { rmSync(configPath, { force: true }); } catch { /* 删不掉也不影响结果 */ }
            if (killedByTimeout) {
                out += `\n  FAIL  模块超时（${Math.round(timeoutMs / 1000)}s 未结束，已强制终止）`
                    + '\n  · 多半是某处轮询的 fetch 没带单次超时（连接建立了但对方不回包）'
                    + '\n  · 用 node scripts/' + mod.name + '.mjs "<用例名>" 单独跑，看停在哪一步';
                resolve({ name: mod.name, code: 1, out, ms: Date.now() - started, timedOut: true });
                return;
            }
            resolve({ name: mod.name, code: code == null ? 1 : code, out, ms: Date.now() - started });
        };
        child.on('error', (e) => {
            out += '\n' + String(e && e.message);
            finish(1);
        });
        child.on('close', (code) => finish(code == null ? 1 : code));
    });
}

/** 从模块输出里摘出汇总行（`PASS 32   FAIL 0`），用于末尾总表 */
function summaryOf(text) {
    const hits = [...String(text || '').matchAll(/PASS\s+(\d+)\s+FAIL\s+(\d+)/g)];
    if (!hits.length) return null;
    const last = hits[hits.length - 1];
    return { pass: Number(last[1]), fail: Number(last[2]) };
}

/** 失败模块只打关键几行：整段输出可能几百行，把真正的失败淹掉 */
function failureDigest(text) {
    const lines = String(text || '').split(/\r?\n/);
    const keep = [];
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^\s*(FAIL|SKIP)\b/.test(l) || /失败项：/.test(l) || /^\s*·/.test(l) || /用例抛出异常/.test(l)) {
            keep.push(l);
            // 失败行后面常跟着调用栈前几行，带上一行上下文便于定位
            if (lines[i + 1] && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*(PASS|FAIL)/.test(lines[i + 1])) {
                keep.push(lines[i + 1]);
            }
        }
    }
    return keep.length ? keep.join('\n') : lines.slice(-15).join('\n');
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const list = opts.only ? MODULES.filter((m) => m.name.includes(opts.only)) : MODULES;
    if (!list.length) {
        console.error('没有匹配的检查模块：' + opts.only);
        process.exitCode = 1;
        return;
    }

    console.log(`\n########## 运行 ${list.length} 个检查模块（并发 ${opts.jobs}，单模块上限 ${Math.round(opts.timeoutMs / 1000)}s）##########`);
    const startedAll = Date.now();
    const results = [];
    let next = 0;
    let bail = false;

    // 固定大小的并发池：谁先完成谁先打印，避免所有输出挤在最后一起刷。
    // 每个 worker 分一段 1000 宽的端口区间（20000 起，6 并发最多占 6000），区间互不相交。
    async function worker(index) {
        const portBase = 20000 + index * 1000 + 1000;
        for (;;) {
            if (bail) return;
            const i = next++;
            if (i >= list.length) return;
            const mod = list[i];
            const r = await runModule(mod, opts.timeoutMs, portBase);
            results.push(r);
            const mark = r.code === 0 ? 'PASS' : 'FAIL';
            const s = summaryOf(r.out);
            console.log(`\n=== [${mark}] ${mod.name}  ${(r.ms / 1000).toFixed(1)}s`
                + (s ? `  (${s.pass} 通过 / ${s.fail} 失败)` : '') + ' ===');
            if (r.code !== 0) {
                console.log(failureDigest(r.out));
                if (opts.bail) bail = true;
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(opts.jobs, list.length) }, (_, i) => worker(i)));

    // 汇总：按耗时排序，一眼看出谁在拖时间
    const totalMs = Date.now() - startedAll;
    const failed = results.filter((r) => r.code !== 0);
    const timedOut = failed.filter((r) => r.timedOut);
    let pass = 0;
    let fail = 0;
    for (const r of results) {
        const s = summaryOf(r.out);
        if (s) { pass += s.pass; fail += s.fail; }
    }

    console.log('\n' + '='.repeat(58));
    console.log('  耗时（降序）');
    console.log('='.repeat(58));
    for (const r of [...results].sort((a, b) => b.ms - a.ms)) {
        const s = summaryOf(r.out);
        console.log(`  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.name.padEnd(18)}`
            + (s ? `${String(s.pass).padStart(4)} 通过 / ${s.fail} 失败` : (r.code === 0 ? '通过' : '失败')));
    }
    console.log('-'.repeat(58));
    console.log(`  合计 ${(totalMs / 1000).toFixed(1)}s（串行之和约 `
        + `${(results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1)}s）`);
    console.log(`\n  PASS ${pass}   FAIL ${fail}`);
    if (failed.length) console.log('  失败模块：' + failed.map((r) => r.name).join('、'));
    if (timedOut.length) {
        console.log('  超时模块：' + timedOut.map((r) => r.name).join('、')
            + '（整轮不会因此卡住，但要点开它单独跑一次定位）');
    }
    console.log('='.repeat(58));

    process.exitCode = failed.length ? 1 : 0;
}

await main();
