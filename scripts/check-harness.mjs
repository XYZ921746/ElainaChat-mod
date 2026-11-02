// 检查脚本共用运行时 —— 断言计数、端口分配、等待。
// 为什么需要它：47 个 check-*.mjs 里有 `wait` 抄了 12 遍（字节全同）、
// `freePort` 14 遍（其中 11 份全同，另 3 份是变体）、`pass/fail/ok` + 结尾汇总
// 抄了 25 遍。这些是纯样板，与"检查什么"无关；散在 47 个文件里时，
// 改一次汇总格式要动 25 处，漏一处就出现两种输出风格。
// 合并后的每个模块文件（check-chat.mjs 等）用 runModule() 跑一组用例：
// 每个用例在自己的函数作用域里，断言经 ctx.ok 记账 —— 这样十几段代码
// 放进同一文件时，各自的 `ROOT`/`html`/`src` 局部变量不会互相踩。
// 用法（见 check-chat.mjs）：
//   import { runModule, ok, wait, freePort } from './check-harness.mjs';
//   runModule({ title: '...', usage: 'node scripts/check-chat.mjs', cases: [
//       { name: '适配器', fn: async (c) => { c.ok(x, 'label'); } },
//   ] });

import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 让出事件循环 ms 毫秒 —— 等子进程吐出启动日志、等页面渲染完 */
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询等待某个条件成立，成立即返回，超时才放弃。
 *
 * 为什么要有它：检查里大量写的是「做完动作 → `await wait(2500)` → 断言」。
 *   固定等待有两个毛病，恰好都在这个项目上出现过：
 *   ① **慢**：条件通常几十毫秒就成立了，却每次都付满额；一个模块里十几处
 *      固定等待就能把总耗时推到几十秒；
 *   ② **假红**：机器一忙，2500ms 也可能不够，于是断言随机失败 ——
 *      那种"重跑就好了"的红，最后没人再信检查结果。
 *   轮询把"等多久"从**猜一个数**改成**等事实**：成立就走，不成立才等到超时。
 *
 * @param {Function} probe 返回真值即视为成立（可以是 async）
 * @param {{timeoutMs?:number, intervalMs?:number, label?:string}} [opts]
 * @returns {Promise<boolean>} 是否在超时前成立
 */
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

/**
 * 向内核要一个当前空闲的端口。
 *
 * 监听 0 让内核分配，拿到端口后立刻关掉 —— 中间存在极小的竞态窗口，
 * 但比硬编码端口可靠得多：硬编码端口的检查在同一台机器上并行跑时会互撞，
 * 表现为"端口被占用"这种与产品无关的失败。
 */
export const freePort = () => new Promise((res, rej) => {
    const s = createNetServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => res(p));
    });
});

/**
 * 带单次超时的探测请求：**返回布尔，不抛错**。
 *
 * 为什么轮询里的 fetch 必须带超时：连接被建立但对方不回包时（服务半启动、
 *   端口被别的程序占着、握手卡住），裸 `await fetch(...)` 会**永远挂着**。
 *   那时轮询循环的"截止时间"永远轮不到检查 —— 表现不是"检查失败"，
 *   而是**整轮检查停在那里不动**。这类挂起比失败难查得多：没有报错、
 *   没有超时信息，只能靠人发现"怎么这么久"。
 *
 * @param {string} url
 * @param {number} [timeoutMs] 单次请求上限
 * @returns {Promise<boolean>} 是否拿到了 ok 响应
 */
export async function probeOk(url, timeoutMs = 2000) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        return Boolean(res && res.ok);
    } catch {
        return false;
    }
}

/**
 * 轮询 `/api/server-info` 直到这个检查起的服务真的就绪。
 *
 * 这段"起服务 → 等服务 → 超时整段报错"的逻辑在 6 个模块里各有一份拷贝，
 *   连轮询间隔都抄了同一个 250ms：改一次间隔要动六处，而每处都多付最多
 *   250ms 的等待。收敛到这里后，间隔只在这一行。
 *
 * 单次探测也带超时（见 probeOk）：端口被占、对方不回包时，
 *   没有超时的轮询会让整轮检查挂死而不是报错。
 *
 * @param {string} base 形如 `http://127.0.0.1:1234`
 * @returns {Promise<boolean>} 超时前是否起来了
 */
export async function waitServerUp(base, opts = {}) {
    return waitFor(() => probeOk(base + '/api/server-info', opts.probeTimeoutMs), {
        timeoutMs: opts.timeoutMs === undefined ? 20000 : opts.timeoutMs,
        intervalMs: opts.intervalMs === undefined ? 50 : opts.intervalMs,
    });
}

/**
 * 跑一个模块的全部用例，末尾统一汇总。
 *
 * 为什么失败信息要带用例名：合并前每个脚本只测一个模块，失败时进程名本身就是
 * 定位信息；合并后一个进程测十几段，只报"第 3 个断言失败"就找不到是哪段坏了。
 * 所以每条失败都记成 `<用例名> :: <断言>`。
 *
 * 某个用例抛异常不影响后续用例 —— 检查脚本自己崩了时，仍然希望看到
 * 其余用例的结果，否则一次改动要反复跑十几分钟才能逐个暴露问题。
 */
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

/** 打印汇总并按结果设置退出码 */
export function report({ pass, fail, failures }, { label } = {}) {
    console.log('\n' + '='.repeat(46));
    if (label) console.log('  ' + label);
    console.log(`  PASS ${pass}   FAIL ${fail}`);
    if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
    console.log('='.repeat(46));
    process.exitCode = fail ? 1 : 0;
}

/**
 * 合并模块的入口：跑用例、打汇总、设退出码。
 * 这样每个 check-<模块>.mjs 的结尾只剩一行调用。
 */
export async function runChecks(spec) {
    const r = await runModule(spec);
    report(r, { label: spec.title });
    if (spec.onFinish) await spec.onFinish(r);
    return r;
}
