// 检查脚本共用运行时 —— 断言计数、端口分配、等待。每个模块用 runModule() 跑一组**串行**执行的用例：
// 用例各自一个函数作用域，断言经 ctx.ok 记账（失败记成 `<用例名> :: <断言>`），单个用例抛异常不影响后续用例。
// 用法见 check-chat.mjs：import { runModule, ok, wait, freePort } 后调 runModule({ title, usage, cases })。

import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
