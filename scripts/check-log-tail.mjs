// 端到端：起真实服务 → 打日志 → 查 /api/logs/tail 的过滤能力 → 浏览器看查看器。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-tail-'));
const PORT = await freePort();
const HTTPS_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), HOST: '127.0.0.1', LOG_DIR, DATA_DIR: path.join(LOG_DIR, 'data'), LOG_TO_FILE: '1', LOG_CHAT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
let up = false;
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
child.on('exit', (code, sig) => {
    if (!up && code !== 0 && !out.includes('listening')) {
        console.log('（子进程退出 code=' + code + ' sig=' + sig + '）输出：\n' + out.slice(0, 1200));
    }
});

try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
        try { up = (await fetch(BASE + '/api/server-info')).ok; } catch { await wait(250); }
    }
    ok(up, '服务已启动', up ? '' : out.slice(-300));
    await wait(800);

    // ── 1. 基本拉取 ──
    const all = await (await fetch(BASE + '/api/logs/tail?limit=500')).json();
    ok(all.ok === true, '/api/logs/tail 可用');
    ok(Array.isArray(all.entries) && all.entries.length > 5, '缓冲里有启动日志', String(all.entries?.length));
    ok(all.entries[0].ts >= (all.entries[1]?.ts || 0), '★ 按时间倒序（最新在前）');
    for (const e of all.entries) {
        if (!(typeof e.ts === 'number' && e.level && e.tag && typeof e.message === 'string')) {
            ok(false, '记录字段完整', JSON.stringify(e)); break;
        }
    }
    ok(true, '每条记录都有 ts/level/tag/message 结构化字段');

    // ── 2. 级别过滤 ──
    const errs = await (await fetch(BASE + '/api/logs/tail?level=ERROR&limit=500')).json();
    ok(errs.entries.every((e) => ['ERROR', 'CRITICAL'].includes(e.level)),
        '★ level=ERROR 只返回 ERROR/CRITICAL', JSON.stringify(errs.entries.slice(0, 2).map((e) => e.level)));

    // ── 3. 模块过滤 ──
    const tags = await (await fetch(BASE + '/api/logs/tail?limit=500')).json().then((j) => j.tags);
    ok(Array.isArray(tags) && tags.includes('Mod'), '★ tags 列表包含 Mod（前端过滤下拉的数据源）', JSON.stringify(tags));
    const modOnly = await (await fetch(BASE + '/api/logs/tail?tags=Mod&limit=500')).json();
    ok(modOnly.entries.length > 0 && modOnly.entries.every((e) => e.tag === 'Mod'),
        '★ tags=Mod 只返回 Mod 模块', JSON.stringify(modOnly.entries.map((e) => e.tag).slice(0, 3)));

    // ── 4. 关键词过滤 ──
    const kw = await (await fetch(BASE + '/api/logs/tail?search=galgame&limit=500')).json();
    ok(kw.entries.every((e) => e.message.toLowerCase().includes('galgame')),
        '★ search 关键词过滤（大小写不敏感）');

    // ── 5. 增量拉取 ──
    const first = await (await fetch(BASE + '/api/logs/tail?limit=1')).json();
    const since = first.entries[0]?.ts || 0;
    await wait(300);
    const inc = await (await fetch(BASE + `/api/logs/tail?since=${since}&limit=300`)).json();
    ok(inc.entries.every((e) => e.ts > since), '★ since 增量只返回更新的记录', `${inc.entries.length} 条`);

    // ── 5.5 ★ 同一毫秒内的记录必须靠 sinceSeq 精确带回（2026-10 修的真漏洞）──
    //
    //   时间戳只有毫秒精度，而一次启动会连打十几条日志 —— 同一个毫秒里有 5 条很正常。
    //   旧实现比的是 `e.ts <= since`（闭区间），于是查看器带着"这一毫秒最后一条"的 ts
    //   回来时，同毫秒里**晚于它写入的**会被跳过，而且下一轮的 lastTs 还是这个毫秒，
    //   它们**永远补不回来** —— 表现在用户眼前就是"bat 面板刷过好几行、查看器里少几行"。
    //
    //   ★ 这里直接用 log-buffer 单测，而不是靠"打一堆请求碰运气撞同一毫秒"：
    //     后者会飘（并发请求未必落在同一毫秒，机器一快一慢结论就变）。
    //     log-buffer 是纯逻辑，能精确构造"同一毫秒多条"这个条件。
    {
        const { createLogBuffer } = await import('../server/log-buffer.mjs');
        const buf = createLogBuffer(100);
        const T = 1700000000000;                 // 固定时刻，不受真实时钟影响
        // 同一毫秒 5 条，后面再跟一条不同毫秒的
        for (let i = 0; i < 5; i++) {
            buf.push({ ts: T, level: 'DEBUG', tag: 'HTTP', message: 'same-ms-' + i });
        }
        buf.push({ ts: T + 1, level: 'INFO', tag: 'Core', message: 'next-ms' });

        const all = buf.query({ limit: 100 });
        ok(all.entries.length === 6, '单测：6 条都进了缓冲', String(all.entries.length));
        ok(all.entries.every((e) => Number.isInteger(e.seq)),
            '★ 单测：每条都带写入序号 seq');
        const sameMs = all.entries.filter((e) => e.ts === T);
        ok(sameMs.length === 5, '★ 单测：确实构造出同一毫秒 5 条', String(sameMs.length));

        // 游标 = 该毫秒**最早**那条（列表新→旧，所以取末位）
        const earliest = sameMs[sameMs.length - 1];
        const after = buf.query({ since: T, sinceSeq: earliest.seq, limit: 100 });
        const gotSeqs = new Set(after.entries.map((e) => e.seq));
        const missed = sameMs.filter((e) => e.seq !== earliest.seq && !gotSeqs.has(e.seq));
        ok(missed.length === 0,
            '★★ 单测：带了 sinceSeq 时，同毫秒的后续记录一条都不丢',
            missed.length ? `漏 ${missed.length} 条` : `带回 ${after.entries.length} 条`);
        ok(after.entries.some((e) => e.message === 'next-ms'),
            '★ 单测：更新的毫秒照常返回');

        // 不给 sinceSeq 时保持旧的严格 ">" 语义（老调用方不该突然收到重复行）
        const legacy = buf.query({ since: T, limit: 100 });
        ok(legacy.entries.every((e) => e.ts > T),
            '★ 单测：只传 since 的调用方仍是严格 ">"（不改变旧语义）',
            `${legacy.entries.length} 条`);

        // 老语义下的**丢条**必须能被这条断言复现出来 —— 否则说明测试没测到点上
        const legacySeqs = new Set(legacy.entries.map((e) => e.seq));
        const legacyMissed = sameMs.filter((e) => !legacySeqs.has(e.seq));
        ok(legacyMissed.length === 5,
            '★★ 单测：只比时间戳时同毫秒 5 条全丢（这就是原 bug 的实证）',
            `丢 ${legacyMissed.length} 条`);
    }

    // 接口层：真实响应里也要带 seq（前端游标靠它）
    {
        const t = await (await fetch(BASE + '/api/logs/tail?limit=20')).json();
        ok(t.entries.length > 0 && t.entries.every((e) => Number.isInteger(e.seq)),
            '★ /api/logs/tail 的每条记录都带 seq', `${t.entries.length} 条`);
    }

    // ── 6. 内存缓冲不受落盘级别影响（即使把落盘级别调高，缓冲仍全量）──
    const setRes = await fetch(BASE + '/api/logs/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 'CRITICAL' }),
    });
    ok(setRes.ok, '把落盘级别调到 CRITICAL');
    console.log('[test] 触发一条 INFO（访问 /api/plugins）');
    await fetch(BASE + '/api/plugins');
    await wait(300);
    const after = await (await fetch(BASE + '/api/logs/tail?level=INFO&limit=50')).json();
    ok(after.entries.some((e) => e.level === 'INFO'),
        '★ 落盘级别=CRITICAL 时缓冲里仍有 INFO（过滤在读端做）', `共 ${after.entries.length} 条 INFO`);
    // 落盘文件里则**没有** INFO（级别过滤对文件仍生效）
    const fs = await import('node:fs');
    const logFile = fs.readdirSync(LOG_DIR).find((n) => n.endsWith('.log') && !n.includes('trace'));
    if (logFile) {
        const content = fs.readFileSync(path.join(LOG_DIR, logFile), 'utf8');
        const tailPart = content.split('\n').slice(-30).join('\n');
        ok(!/\[INFO\]/.test(tailPart) || !/plugins.*200/.test(tailPart),
            '★ 落盘文件仍然按级别过滤（CRITICAL 时不写 INFO）');
    }
    // 恢复级别
    await fetch(BASE + '/api/logs/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 'INFO' }),
    });

    // ── 8. 自噪音回路：查看器轮询不应把日志刷屏（2026-09 用户实测）──────
    //   之前 /api/logs/tail 每次轮询都被 HTTP 访问日志记一行 ——
    //   查看器一开，启动窗口每 2 秒滚一条"GET /api/logs/tail"，
    //   日志系统在观察自己。成功轮询必须静默（失败仍要报）。
    {
        const before = out.length;
        for (let i = 0; i < 3; i++) {
            await fetch(BASE + '/api/logs/tail?limit=10');
            await fetch(BASE + '/api/client-log', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ items: [{ level: 'info', text: '[Mod:test] viewer poll', page: '/' }] }),
            }).catch(() => {});
        }
        await wait(500);
        const added = out.slice(before);
        ok(!added.includes('/api/logs/tail'), '★ 查看器轮询（成功）不打访问日志 —— 不再自噪音', added.slice(0, 200));
        // 失败时仍要能看见：带不存在参数不会失败，改用一个真正的 404 轮询等价物验证 QUIET 只对成功生效
        const r404 = await fetch(BASE + '/api/logs/tail-x');
        ok(r404.status === 404, '（前置）未知接口仍 404');
        await wait(300);
        ok(out.includes('/api/logs/tail-x') && out.includes('404'), '★ 未知接口的 4xx 仍会记录（静默不吞错误）');
    }

    // ── 9. 英文事实行仍然成立 ──
    //（等待插件扫描完成 —— 它在 listen 回调里异步跑）
    for (let i = 0; i < 20 && !out.includes('installed: elaina-avatar'); i++) {
        await wait(200);
    }
    // 注：emitLog 会把消息开头的 [mod] 抽成标签字段并规范为 [Mod]，
    // 所以输出行是 `[Mod] [INFO] ... installed: elaina-avatar`。
    ok(/installed: elaina-avatar \(dir=/.test(out), '★ 启动日志是英文事实行（installed: id (dir=…)）', out.slice(-300));
    ok(out.includes('listening on http://'), '★ listening 行给出地址');
    ok(!/【怎么用】/.test(out), '★ 说明文字不再刷进日志流');
    ok(!/技术信息/.test(out), '★ 冗长的技术信息块已移除');
} finally {
    child.kill();
    await wait(300);
    try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
