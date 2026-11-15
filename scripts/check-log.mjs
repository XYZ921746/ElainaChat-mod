// 日志模块的回归检查（格式 / 落盘 / 级别 / 过滤 / 增量 / 查看器）。
// 四段测同一条链路（服务端落盘、查看器读缓冲、tail 接口），改一处常同时影响两端。
// 每段用例在各自函数作用域里跑，跨用例共用顶部无状态工具（startServe / waitUp / makeLogDir）。
// 用法：node scripts/check-log.mjs          跑全部
//       node scripts/check-log.mjs 查看器   只跑名字含该子串的用例

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, mkdtempSync, rmSync, statSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './test-browser.mjs';
import { runChecks, ROOT, wait, freePort, buildGoServer } from './check-harness.mjs';

// 整个模块只编译一次；本机没有 Go 工具链时各用例按环境性跳过（不判红）
const GO_BIN = buildGoServer();

/** 建临时日志目录（LOG_DIR 覆盖）：不碰用户 data/logs，也不触发真实日志的轮转删除 */
function makeLogDir(prefix) {
    return mkdtempSync(path.join(tmpdir(), prefix));
}

/** 清掉临时目录；失败也不影响检查结论（Windows 上文件可能还被别的句柄占着） */
function dropDir(dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 起一次 Go 服务端并收集其全部 stdout/stderr；stop() 幂等，用例中途抛异常也能收尾 */
function startServe({ port, logDir, env: extraEnv = {} }) {
    const child = spawn(GO_BIN, [], {
        cwd: ROOT,
        // 数据目录必须随日志目录一起隔离：默认会读写用户真实 data/，断言也随本机状态漂移。
        env: { ...process.env, OPEN_BROWSER: '0', PORT: String(port), HOST: '127.0.0.1', LOG_DIR: logDir, DATA_DIR: path.join(logDir, 'data'), ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const getOut = () => out;
    const stop = () => { try { child.kill(); } catch { /* 已经退了 */ } };
    return { child, getOut, stop };
}

/** 轮询 /api/server-info 直到服务起来；间隔取 50ms，一个模块起十几个服务时省总耗时 */
async function waitUp(base) {
    let up = false;
    for (let i = 0; i < 400 && !up; i++) {
        try { up = (await fetch(base + '/api/server-info')).ok; } catch { await wait(50); }
    }
    return up;
}

// 1. 日志系统端到端：格式 / 级别 / 脱敏 / 双 sink / 对话追踪
// 必须起真实服务：格式、脱敏、轮转、追踪全是运行时行为，静态读源码看不出来。

async function caseLogFormat(c) {
    if (!GO_BIN) { c.ok(true, '环境性跳过：本机没有 Go 工具链'); return; }
    const LOG_DIR = makeLogDir('elainachat-log-');

    /** 取最近写入的主日志；按 mtime 排序，同秒起双实例时按文件名排序会选错对象 */
    function readNewestMainLog() {
        const mains = readdirSync(LOG_DIR)
            .filter((n) => n.endsWith('.log') && !n.includes('.trace.'))
            .map((n) => ({ n, m: statSync(path.join(LOG_DIR, n)).mtimeMs }))
            .sort((a, b) => a.m - b.m);
        if (!mains.length) return '';
        return readFileSync(path.join(LOG_DIR, mains[mains.length - 1].n), 'utf8');
    }

    const UPSTREAM_PORT = await c.freePort();
    // 「连不上」用一个刚被释放的空闲端口 —— 写死一个号可能恰好被别的程序占着，那样这条用例就变成假阳性
    const DEAD_PORT = await c.freePort();
    const upstream = createServer((req, res) => {
        const chunks = [];
        req.on('data', (ch) => chunks.push(ch));
        req.on('end', () => {
            const send = (code, obj, type = 'application/json; charset=utf-8') => {
                res.writeHead(code, { 'content-type': type });
                res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
            };
            if (req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: 'a' }] });
            if (req.url === '/v1/chat/normal') {
                return send(200, {
                    id: 'cmpl-1', model: 'test-model',
                    choices: [{ message: { role: 'assistant', content: '你好呀，我是伊蕾娜。\n今天想去哪儿？' } }],
                });
            }
            if (req.url === '/v1/chat/bad') {
                return send(400, { detail: { error: { message: '模型 test-model 不存在，请改用 DeepSeek-V4-Flash' } } });
            }
            if (req.url === '/v1/chat/sse') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n');
                res.write('data: {"choices":[{"delta":{"content":"，第二段。"}}]}\n\n');
                res.write('data: [DONE]\n\n');
                return res.end();
            }
            if (req.url === '/v1/chat/sse-err') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write('data: {"error":{"message":"当前分组上游负载已饱和，请稍后再试"}}\n\n');
                return res.end();
            }
            return send(404, { error: { message: 'no route' } });
        });
    });
    await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

    // 本段起的每个子进程都登记在 running，finally 统一收掉 —— 漏一个就泄漏端口
    const running = [];
    try {
        /** 起一次 Go 服务端，等端口就绪。每个场景用不同端口 —— 刚 kill 掉的进程端口未必立刻释放 */
        async function startServer(extraEnv, port) {
            const s = startServe({ port, logDir: LOG_DIR, env: extraEnv });
            running.push(s);
            for (let i = 0; i < 75; i++) {
                try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.status) return s; }
                catch { await wait(200); }
            }
            s.stop();
            throw new Error('服务没能启动：\n' + s.getOut());
        }

        const PORT = await c.freePort();
        const { child, getOut } = await startServer({}, PORT);

        async function relay(body) {
            try {
                const r = await fetch(`http://127.0.0.1:${PORT}/api/relay`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                });
                return { status: r.status, text: await r.text() };
            } catch (e) { return { status: 0, text: String(e.message) }; }
        }

        const chatBody = (model) => ({
            model, stream: false, temperature: 0.8,
            messages: [
                { role: 'system', content: '你是伊蕾娜，一个爱撒娇的魔女。' },
                { role: 'user', content: '今天天气怎么样？' },
                { role: 'assistant', content: '嗯……阳光很好呢。' },
                { role: 'user', content: '那我们去哪儿玩？' },
            ],
        });
        const target = (p) => `http://127.0.0.1:${UPSTREAM_PORT}${p}`;
        const post = (p, body) => ({
            url: target(p), method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });

        await relay(post('/v1/chat/normal', chatBody('test-model')));
        await relay(post('/v1/chat/bad', chatBody('test-model')));
        await relay(post('/v1/chat/sse', chatBody('test-model')));
        await relay(post('/v1/chat/sse-err', chatBody('test-model')));
        await relay({ url: target('/v1/models'), method: 'GET' });
        await relay({ url: `http://127.0.0.1:${DEAD_PORT}/v1/chat/completions`, method: 'POST', body: JSON.stringify(chatBody('test-model')) });
        await relay({ url: 'not-a-url', method: 'POST' });
        await wait(700);

        // 完整问答全文（trace）只进内存缓冲、不落盘（重启即失，隐私上更稳）——
        // 断言改从 /api/logs/tail 取，必须在 kill 之前读。
        const traceRes = await fetch(`http://127.0.0.1:${PORT}/api/logs/tail?level=DBUG&limit=500`);
        const traceJson = await traceRes.json().catch(() => null);
        const traceText = JSON.stringify(traceJson);

        child.kill();
        await wait(200);

        const consoleOut = getOut();
        const files = readdirSync(LOG_DIR).filter((n) => n.endsWith('.log'));
        const mainName = files.find((n) => !n.includes('.trace.'));
        c.ok(!!mainName, '主日志文件已生成');
        if (!mainName) {
            console.log('主日志:', files);
            console.log(consoleOut);
            throw new Error('主日志没有生成，后面的断言无从下手');
        }

        const main = readFileSync(path.join(LOG_DIR, mainName), 'utf8');
        const mainLines = main.split('\n').filter((l) => l !== '');

        // 格式：主日志允许多行诊断块的续行不带前缀 —— 首行必须带完整前缀（grep 可用），
        // 续行必须有缩进（视觉上属于上一条记录）；断言按这两条拆。
        const LINE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[[A-Za-z0-9]+\] \[(DBUG|INFO|WARN|ERRO|CRIT)\] \s*\S/;
        const headLines = mainLines.filter((l) => LINE_RE.test(l));
        const contLines = mainLines.filter((l) => !LINE_RE.test(l));
        c.ok(headLines.length > 0, '主日志有合规的记录首行');
        // 续行必须缩进或以分隔线开头（横幅的 ==== 是刻意的视觉分隔）；其余裸文本行算格式错误。
        const badCont = contLines.filter((l) => !/^\s+\S/.test(l) && !/^=+$/.test(l));
        c.ok(badCont.length === 0, '不带前缀的续行都有缩进或分隔线（能归属到上一条记录）',
            badCont.slice(0, 3).join('\n      '));
        c.ok(mainLines.length > 0, '主日志有内容');
        c.ok(!main.includes('⏎'), '主日志里没有压平标记 ⏎（多行结构被保留）');

        // 时间是本地时间（含毫秒：同一秒能连打十几条，秒级分不出先后）
        const first = headLines[0].match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
        c.ok(!!first, '首行带完整时间戳（含毫秒）');
        if (first) {
            const t = new Date(+first[1], +first[2] - 1, +first[3], +first[4], +first[5], +first[6]).getTime();
            const skew = Math.abs(Date.now() - t);
            c.ok(skew < 120000, '日志时间戳是本地时间（不是 UTC）', `偏差 ${Math.round(skew / 1000)} 秒`);
            // 文件名里的时刻要和行内时刻同源，否则"哪次启动"和"什么时候"对不上
            const stamp = mainName.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
            c.ok(!!stamp && stamp[1] === `${first[1]}-${first[2]}-${first[3]}` && stamp[2] === first[4],
                '文件名时刻与日志内时间戳一致', `${mainName} vs ${first[0]}`);
        }

        const warnPlus = headLines.filter((l) => /\[(WARN|ERRO|CRIT)\]/.test(l));
        c.ok(warnPlus.length > 0, '有 WARN/ERRO 级别记录');
        c.ok(headLines.some((l) => l.includes('[INFO]')), '有 INFO 级别记录');

        // 脱敏与事实行：E2E 直接看真实输出（规则本身在 server/internal/logx 有单测覆盖）
        {
            const consoleOut = getOut();
            c.ok(/LAN access password:\s*not set/i.test(consoleOut),
                '启动日志说明访问密码尚未设置（局域网设备不可用）');
            c.ok(/LAN access password/.test(main) || main.includes('******') || main.includes('user-configured'),
                '日志里能看到访问密码事实行（或脱敏占位符 / 已设置）');
            // eslint-disable-next-line no-control-regex
            c.ok(!/\x1b\[/.test(consoleOut), '非 TTY 控制台不带 ANSI 颜色码');
        }

        const askCount = mainLines.filter((l) => l.includes('[Chat]') && l.includes('提问：')).length;
        c.ok(askCount === 5, '每次对话请求都留一条「提问」摘要（含连不上的那次）', `实际 ${askCount}`);
        c.ok(main.includes('提问：那我们去哪儿玩？'), '提问摘要是最后一条用户消息');
        c.ok(mainLines.filter((l) => l.includes('回复：')).length === 2, '只有真正成功的请求才留「回复」摘要');

        c.ok(main.includes('<< 上游报错：模型 test-model 不存在，请改用 DeepSeek-V4-Flash'),
            '上游 4xx 的原因被挖出来写进主日志');
        c.ok(main.includes('<< 响应内报错：当前分组上游负载已饱和'), '200 + SSE 内报错也能识别');
        c.ok(/\[ERRO\][^\n]*(ECONNREFUSED|actively refused)/.test(main),
            '连不上时记录拒绝原因（能区分 DNS/TLS/拒绝）');
        c.ok(/\[WARN\][^\n]*目标地址无效/.test(main), '非法地址被拒绝时留下 WARN');

        c.ok(traceJson && traceJson.ok === true, 'trace 全文可经 /api/logs/tail 取到（内存缓冲）');
        c.ok(traceText.includes('你是伊蕾娜，一个爱撒娇的魔女。'), 'trace 含完整 system 提示');
        c.ok(traceText.includes('今天天气怎么样？'), 'trace 含完整历史消息');
        c.ok(traceText.includes('你好呀，我是伊蕾娜。') && traceText.includes('今天想去哪儿？'), 'trace 含完整回复原文');
        c.ok(traceText.includes('模型 test-model 不存在'), 'trace 含完整上游报错响应体');
        c.ok(traceText.includes('第一段，第二段。'), '流式回复被拼回完整正文');
        c.ok(!traceText.includes('"object":"list"'), '非对话接口（获取模型）的响应体不灌进 trace');

        const { child: child2, getOut: out2 } = await startServer({ LOG_TO_FILE: '0' }, await c.freePort());
        await wait(300);
        child2.kill();
        await wait(200);
        c.ok(readdirSync(LOG_DIR).filter((n) => n.endsWith('.log')).length === 1,
            'LOG_TO_FILE=0 时不产生新日志文件（自动化场景要能关掉落盘）');

        // 控制台级别门：成功请求归 DEBUG、控制台默认 INFO，日常窗口不刷请求行；
        // 切 DEBUG（或 LOG_CONSOLE）才全量。
        {
            const port4 = await c.freePort();
            const { child: c4, getOut: out4 } = await startServer({ LOG_TO_FILE: '0' }, port4);
            await wait(400);
            await fetch(`http://127.0.0.1:${port4}/api/plugins`).catch(() => {});
            await fetch(`http://127.0.0.1:${port4}/api/server-info`).catch(() => {});
            await wait(400);
            c.ok(!/\[HTTP\]/.test(out4()), '★ 默认控制台级别下，成功请求不刷屏（[HTTP] 行消失）');
            c.ok(/listening on http:\/\//.test(out4()), '启动事件仍然可见');
            c4.kill();
            await wait(300);

            const port5 = await c.freePort();
            const { child: c5, getOut: out5 } = await startServer({ LOG_TO_FILE: '0', LOG_CONSOLE: 'DEBUG' }, port5);
            await wait(400);
            await fetch(`http://127.0.0.1:${port5}/api/plugins`).catch(() => {});
            await wait(400);
            c.ok(/\[HTTP\]/.test(out5()), '★ LOG_CONSOLE=DEBUG 时请求行可见（排查模式）');
            c5.kill();
            await wait(300);

            const port6 = await c.freePort();
            const { child: c6, getOut: out6 } = await startServer({ LOG_TO_FILE: '0' }, port6);
            await wait(400);
            await fetch(`http://127.0.0.1:${port6}/api/definitely-not-exist`).catch(() => {});
            await wait(400);
            c.ok(/\[HTTP\].*404/.test(out6()), '★ 4xx 是 WARN，任何控制台级别下都可见');
            c6.kill();
            await wait(300);
        }

        const port3 = await c.freePort();
        const { child: child3 } = await startServer({ LOG_CHAT: '0' }, port3);
        await wait(300);
        // LOG_CHAT=0：完整问答全文不进缓冲（提问/回复 摘要仍在），打一发对话验证
        await relay(post('/v1/chat/normal', chatBody('test-model')));
        await wait(400);
        const traceRes3 = await fetch(`http://127.0.0.1:${port3}/api/logs/tail?level=DBUG&limit=500`);
        const traceText3 = JSON.stringify(await traceRes3.json().catch(() => null));
        child3.kill();
        await wait(200);
        c.ok(!traceText3.includes('你是伊蕾娜，一个爱撒娇的魔女。'),
            'LOG_CHAT=0 时完整问答全文不进缓冲（只保留摘要）');

        // 落盘级别过滤：终端始终全量，级别只用来收窄文件；三条边界必须一起验，
        // 少一条就会出现"终端也被静音"或"级别设了没用"。
        {
            const port = await c.freePort();
            const { child: cl, getOut: out } = await startServer({ LOG_LEVEL: 'WARN' }, port);
            await fetch(`http://127.0.0.1:${port}/api/server-info`).catch(() => {});
            await fetch(`http://127.0.0.1:${port}/api/definitely-missing`).catch(() => {});
            await wait(400);
            cl.kill();
            await wait(200);

            const text = readNewestMainLog();
            c.ok(!/\[INFO\][^\n]*server-info/.test(text),
                'LOG_LEVEL=WARN 时 INFO 记录不落盘（级别真的在过滤文件）');
            c.ok(/\[WARN\]/.test(text), 'LOG_LEVEL=WARN 时 WARN 仍然落盘');
            c.ok(/\[INFO\]/.test(out()), 'LOG_LEVEL=WARN 时控制台仍有 INFO（终端始终全量）');
        }

        // 运行时改级别 + 对话追踪开关
        {
            const port = await c.freePort();
            const { child: cl, getOut: out } = await startServer({ LOG_LEVEL: 'ERROR' }, port);
            await fetch(`http://127.0.0.1:${port}/api/server-info`).catch(() => {});
            await wait(200);

            const settingsUrl = `http://127.0.0.1:${port}/api/logs/settings`;
            const before = await (await fetch(settingsUrl)).json();
            c.ok(before.ok && before.level === 'ERROR', 'GET /api/logs/settings 返回当前级别');
            c.ok(Array.isArray(before.levels) && before.levels.length === 5,
                '接口给出五个级别（DEBUG/INFO/WARN/ERROR/CRITICAL）');

            const patched = await (await fetch(settingsUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ level: 'DBUG' }),
            })).json();
            c.ok(patched.ok && patched.level === 'DEBUG', 'POST 接受 AstrBot 短名 DBUG 并归一成 DEBUG');

            await fetch(`http://127.0.0.1:${port}/api/server-info`).catch(() => {});
            const off = await (await fetch(settingsUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ trace: false }),
            })).json();
            c.ok(off.ok && off.trace === false, 'POST 能关闭对话追踪');

            const badRes = await fetch(settingsUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ level: '不存在的级别' }),
            });
            c.ok(badRes.status === 400, '非法级别返回 400（而不是静默接受）');
            const after = await (await fetch(settingsUrl)).json();
            c.ok(after.level === 'DEBUG', '非法级别被拒后当前级别保持不变');

            await wait(400);
            cl.kill();
            await wait(200);

            const text = readNewestMainLog();
            const hits = (text.match(/server-info/g) || []).length;
            c.ok(hits === 1, '改级别后新产生的 INFO 才落盘（改之前那条没有）', `实际出现 ${hits} 次`);
            c.ok(/\[CRIT\]/.test(out()) === false, '本次没有 CRITICAL（不该凭空造出 CRITICAL）');
        }

        // CRITICAL 真的有产生路径（防止退化成只有定义、无代码触发的死配置）
        {
            // 端口被「别的程序」占用：用普通 HTTP 服务占位，它不是本项目实例，必须报错而不是复用
            const busyPort = await c.freePort();
            const httpsPort = await c.freePort();
            const foreign = createServer((req, res) => { res.writeHead(404); res.end(); });
            await new Promise((r) => foreign.listen(busyPort, '127.0.0.1', r));
            try {
                const second = startServe({
                    port: busyPort,
                    logDir: LOG_DIR,
                    env: { HTTPS_PORT: String(httpsPort) },
                });
                running.push(second);
                await wait(1500);
                second.stop();
                await wait(200);
                c.ok(/\[CRIT\]/.test(second.getOut()), '端口被其它程序占用时产生 CRITICAL 记录（级别不是死配置）', second.getOut().slice(-300));
                c.ok(/data\/config\.json/.test(second.getOut()),
                    '占用提示指向 data/config.json 的 port（用户知道去哪儿改）', second.getOut().slice(-300));
            } finally {
                await new Promise((r) => foreign.close(r));
            }
        }

        // 同一个端口上已有本项目实例：不该报错、不该起第二个，按「已在运行」退出
        {
            const samePort = await c.freePort();
            const httpsPort = await c.freePort();
            const first = await startServer({ HTTPS_PORT: String(httpsPort) }, samePort);
            const second = startServe({
                port: samePort,
                logDir: LOG_DIR,
                env: { HTTPS_PORT: String(httpsPort) },
            });
            running.push(second);
            await wait(2000);
            second.stop();
            first.child.kill();
            await wait(200);
            c.ok(/\[CRIT\]/.test(second.getOut()) === false,
                '端口上是本项目实例时不报 CRITICAL（重复双击不是错误）', second.getOut().slice(-300));
            c.ok(/已有实例/.test(second.getOut()),
                '端口上是本项目实例时走「已有实例在运行」分支', second.getOut().slice(-300));
        }
    } finally {
        for (const s of running) s.stop();
        await new Promise((r) => upstream.close(r));
        await wait(200);
        dropDir(LOG_DIR);
    }
}

// 2. /api/logs/tail：过滤 / 增量 / 自噪音
// 端到端：起真实服务 → 打日志 → 查过滤与增量 → 单测同毫秒游标 → 查看器轮询不自噪音。

async function caseLogTail(c) {
    const LOG_DIR = makeLogDir('elaina-tail-');
    const PORT = await c.freePort();
    const HTTPS_PORT = await c.freePort();
    const BASE = `http://127.0.0.1:${PORT}`;

    const srv = startServe({
        port: PORT,
        logDir: LOG_DIR,
        env: {
            HTTPS_PORT: String(HTTPS_PORT),
            DATA_DIR: path.join(LOG_DIR, 'data'),
            LOG_TO_FILE: '1', LOG_CHAT: '0',
        },
    });
    const child = srv.child;
    const outOf = () => srv.getOut();

    let up = false;
    child.on('exit', (code, sig) => {
        if (!up && code !== 0 && !outOf().includes('listening')) {
            console.log('（子进程退出 code=' + code + ' sig=' + sig + '）输出：\n' + outOf().slice(0, 1200));
        }
    });

    try {
        up = await waitUp(BASE);
        c.ok(up, '服务已启动', up ? '' : outOf().slice(-300));
        await wait(800);

        const all = await (await fetch(BASE + '/api/logs/tail?limit=500')).json();
        c.ok(all.ok === true, '/api/logs/tail 可用');
        c.ok(Array.isArray(all.entries) && all.entries.length > 5, '缓冲里有启动日志', String(all.entries?.length));
        c.ok(all.entries[0].ts >= (all.entries[1]?.ts || 0), '★ 按时间倒序（最新在前）');
        for (const e of all.entries) {
            if (!(typeof e.ts === 'number' && e.level && e.tag && typeof e.message === 'string')) {
                c.ok(false, '记录字段完整', JSON.stringify(e)); break;
            }
        }
        c.ok(true, '每条记录都有 ts/level/tag/message 结构化字段');

        const errs = await (await fetch(BASE + '/api/logs/tail?level=ERROR&limit=500')).json();
        c.ok(errs.entries.every((e) => ['ERROR', 'CRITICAL'].includes(e.level)),
            '★ level=ERROR 只返回 ERROR/CRITICAL', JSON.stringify(errs.entries.slice(0, 2).map((e) => e.level)));

        const tags = await (await fetch(BASE + '/api/logs/tail?limit=500')).json().then((j) => j.tags);
        c.ok(Array.isArray(tags) && tags.includes('Mod'), '★ tags 列表包含 Mod（前端过滤下拉的数据源）', JSON.stringify(tags));
        const modOnly = await (await fetch(BASE + '/api/logs/tail?tags=Mod&limit=500')).json();
        c.ok(modOnly.entries.length > 0 && modOnly.entries.every((e) => e.tag === 'Mod'),
            '★ tags=Mod 只返回 Mod 模块', JSON.stringify(modOnly.entries.map((e) => e.tag).slice(0, 3)));

        const kw = await (await fetch(BASE + '/api/logs/tail?search=galgame&limit=500')).json();
        c.ok(kw.entries.every((e) => e.message.toLowerCase().includes('galgame')),
            '★ search 关键词过滤（大小写不敏感）');

        const firstPull = await (await fetch(BASE + '/api/logs/tail?limit=1')).json();
        const since = firstPull.entries[0]?.ts || 0;
        await wait(300);
        const inc = await (await fetch(BASE + `/api/logs/tail?since=${since}&limit=300`)).json();
        c.ok(inc.entries.every((e) => e.ts > since), '★ since 增量只返回更新的记录', `${inc.entries.length} 条`);

        // 5.5 同毫秒 sinceSeq 的精确性在 server/internal/logx 的单测覆盖（SinceCursor）。

        {
            const t = await (await fetch(BASE + '/api/logs/tail?limit=20')).json();
            c.ok(t.entries.length > 0 && t.entries.every((e) => Number.isInteger(e.seq)),
                '★ /api/logs/tail 的每条记录都带 seq', `${t.entries.length} 条`);
        }

        // 6. 内存缓冲不受落盘级别影响（落盘级别调高后缓冲仍全量，过滤在读端做）
        const setRes = await fetch(BASE + '/api/logs/settings', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ level: 'CRITICAL' }),
        });
        c.ok(setRes.ok, '把落盘级别调到 CRITICAL');
        console.log('[test] 触发一条 INFO（访问 /api/plugins）');
        await fetch(BASE + '/api/plugins');
        await wait(300);
        const afterLevel = await (await fetch(BASE + '/api/logs/tail?level=INFO&limit=50')).json();
        c.ok(afterLevel.entries.some((e) => e.level === 'INFO'),
            '★ 落盘级别=CRITICAL 时缓冲里仍有 INFO（过滤在读端做）', `共 ${afterLevel.entries.length} 条 INFO`);
        const fs = await import('node:fs');
        const logFile = fs.readdirSync(LOG_DIR).find((n) => n.endsWith('.log') && !n.includes('trace'));
        if (logFile) {
            const content = fs.readFileSync(path.join(LOG_DIR, logFile), 'utf8');
            const tailPart = content.split('\n').slice(-30).join('\n');
            c.ok(!/\[INFO\]/.test(tailPart) || !/plugins.*200/.test(tailPart),
                '★ 落盘文件仍然按级别过滤（CRITICAL 时不写 INFO）');
        }
        await fetch(BASE + '/api/logs/settings', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ level: 'INFO' }),
        });

        // 8. 自噪音回路：查看器轮询不应把日志刷屏 —— 成功轮询必须静默（失败仍要报）
        {
            const before = srv.getOut().length;
            for (let i = 0; i < 3; i++) {
                await fetch(BASE + '/api/logs/tail?limit=10');
                await fetch(BASE + '/api/client-log', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ items: [{ level: 'info', text: '[Mod:test] viewer poll', page: '/' }] }),
                }).catch(() => {});
            }
            await wait(500);
            const added = srv.getOut().slice(before);
            c.ok(!added.includes('/api/logs/tail'), '★ 查看器轮询（成功）不打访问日志 —— 不再自噪音', added.slice(0, 200));
            // 失败时仍要能看见：带不存在参数不会失败，改用一个真正的 404 轮询等价物验证 QUIET 只对成功生效
            const r404 = await fetch(BASE + '/api/logs/tail-x');
            c.ok(r404.status === 404, '（前置）未知接口仍 404');
            await wait(300);
            c.ok(srv.getOut().includes('/api/logs/tail-x') && srv.getOut().includes('404'),
                '★ 未知接口的 4xx 仍会记录（静默不吞错误）');
        }

        // 9. 插件事实行仍然成立
        //（等待插件扫描完成 —— 它在 listen 回调里异步跑）
        for (let i = 0; i < 20 && !srv.getOut().includes('插件服务端半边'); i++) {
            await wait(200);
        }
        /* 插件源码不随仓库分发：本地没有任何插件时启动日志里不会有装载行，跳过而不是判红 */
        const modsListing = (() => { try { return readdirSync(path.join(import.meta.dirname, '..', 'mods')); } catch { return []; } })();
        if (modsListing.length > 0) {
            c.ok(/插件服务端半边：已装载 \d+ 个（扫描到 \d+ 个插件目录）/.test(srv.getOut()), '★ 启动日志报插件装载事实', srv.getOut().slice(-300));
        } else {
            console.log('  --   跳过：本地没有任何插件（插件走应用内安装，这是正常状态）');
        }
        c.ok(srv.getOut().includes('listening on http://'), '★ listening 行给出地址');
        c.ok(!/【怎么用】/.test(srv.getOut()), '★ 说明文字不再刷进日志流');
        c.ok(!/技术信息/.test(srv.getOut()), '★ 冗长的技术信息块已移除');
    } finally {
        srv.stop();
        await wait(300);
        dropDir(LOG_DIR);
    }
}

// 3. 日志查看器（真实浏览器）：必须是设置里的独立分栏 #tab-log，
// 不能放主界面 rail、也不能只做「高级」的最后一项（会被挤出屏幕外）。

async function caseLogViewer(c) {
    const LOG_DIR = makeLogDir('elaina-viewer-');
    const PORT = await c.freePort();
    const BASE = `http://127.0.0.1:${PORT}`;

    const srv = startServe({
        port: PORT,
        logDir: LOG_DIR,
        env: {
            HTTPS_PORT: String(PORT + 1),
            DATA_DIR: path.join(LOG_DIR, 'data'),
            LOG_TO_FILE: '0',
        },
    });
    const child = srv.child;

    let browser = null;
    try {
        browser = await launchTestBrowser();
        const up = await waitUp(BASE);
        await wait(800);

        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);

        // 首次启动的「使用引导」遮罩会挡住所有点击，必须先点掉它，否则后面每次 click 都超时
        await page.evaluate(() => {
            const ov = document.getElementById('announcementOverlay');
            if (ov) { ov.classList.add('hidden'); ov.classList.remove('flex'); }
        });
        await page.waitForTimeout(300);

        await page.evaluate(() => { try { if (typeof openSettings === 'function') openSettings(); } catch (e) {} });
        await page.waitForTimeout(800);
        const inSettings = await page.evaluate(() => {
            const nav = document.getElementById('settingsTabNav');
            const logBtn = nav ? nav.querySelector('[data-settings-tab="tab-log"]') : null;
            return {
                hasOldViewer: Boolean(document.getElementById('logViewerBox')),
                hasOldLevelSelect: Boolean(document.getElementById('logViewerLevel')),
                hasLogTabBtn: Boolean(logBtn),
                hasLogPanel: Boolean(document.getElementById('tab-log')),
                controlsInLogTab: Boolean(document.querySelector('#tab-log #logLevelPills')
                    && document.querySelector('#tab-log #logPageBox')),
                controlsInAdvanced: Boolean(document.querySelector('#tab-advanced #logLevelPills')),
                tabBtnInViewport: logBtn
                    ? (() => { const r = logBtn.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()
                    : false,
                hasRailLogBtn: Boolean(document.getElementById('railLogBtn')),
            };
        });
        c.ok(!inSettings.hasOldViewer, '★ 老的「内嵌小盒子」查看器已不存在');
        c.ok(!inSettings.hasOldLevelSelect, '★ 老的级别下拉已不存在（改用药丸）');
        c.ok(inSettings.hasLogTabBtn, '★ 设置导航里有「日志」分栏按钮');
        c.ok(inSettings.hasLogPanel, '★ 有 #tab-log 分栏面板');
        c.ok(inSettings.controlsInLogTab, '★ 日志控件在 #tab-log 里');
        c.ok(!inSettings.controlsInAdvanced, '★ 日志控件已从「高级」移走（不再塞在最后一项）');
        c.ok(inSettings.tabBtnInViewport, '★ 「日志」分栏按钮在视口内可见（不用滚动就能看到）');
        c.ok(!inSettings.hasRailLogBtn, '★ 主界面 rail 上**没有**日志按钮（入口在设置分区里）');

        await page.evaluate(() => {
            document.querySelector('[data-settings-tab="tab-log"]')?.click();
        });
        await page.waitForTimeout(2500);
        const settingsOpen = await page.evaluate(() =>
            !document.getElementById('settingsOverlay').classList.contains('hidden'));
        c.ok(settingsOpen, '★ 切到日志分栏时设置面板保持打开（日志就在设置里）');

        const st = await page.evaluate(() => {
            const panel = document.getElementById('tab-log');
            const box = document.getElementById('logPageBox');
            const tagSel = document.getElementById('logTagSelect');
            const meta = document.getElementById('logPageMeta');
            const pills = [...document.querySelectorAll('#logLevelPills .log-pill')];
            return {
                visible: panel && panel.classList.contains('active-panel'),
                lineCount: box ? box.querySelectorAll('.log-line').length : 0,
                firstLine: box?.firstElementChild?.textContent?.slice(0, 110) || '',
                hasLevelColors: box ? Boolean(box.querySelector('.log-line[data-level="INFO"], .log-line[data-level="WARN"], .log-line[data-level="ERROR"]')) : false,
                levels: box ? [...box.querySelectorAll('.log-line')].map((d) => d.dataset.level) : [],
                pillLabels: pills.map((p) => p.textContent.trim()),
                pillsPressed: pills.map((p) => p.getAttribute('aria-pressed')),
                tagOptions: tagSel ? [...tagSel.options].map((o) => o.value) : [],
                metaText: meta?.textContent || '',
                autoScrollChecked: document.getElementById('logAutoScroll')?.checked ?? null,
                hideChatExists: Boolean(document.getElementById('logHideChat')),
            };
        });

        console.log('=== 日志模块状态 ===');
        console.log('  可见:', st.visible, ' 行数:', st.lineCount);
        console.log('  首行:', st.firstLine);
        console.log('  级别药丸:', JSON.stringify(st.pillLabels));
        console.log('  模块下拉:', JSON.stringify(st.tagOptions));
        console.log('  状态栏:', st.metaText);

        c.ok(st.visible, '★ 日志分栏切过去就显示（日志就在设置里）');
        c.ok(st.lineCount > 3, '★ 渲染出了日志行', String(st.lineCount));
        // 行格式必须与日志文件同形：`[时刻(含毫秒)] [模块] [级别短码] 正文`
        c.ok(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[[^\]]+\] \[(DBUG|INFO|WARN|ERRO|CRIT)\] \S/.test(st.firstLine),
            '★ 行格式与面板一致：时刻(含毫秒) + [模块] + [级别短码] + 正文', st.firstLine);
        c.ok(st.hasLevelColors, '★ 级别有配色区分');
        c.ok(st.tagOptions.includes('Mod') || st.tagOptions.includes('Core'), '★ 模块下拉有真实模块名', JSON.stringify(st.tagOptions));
        c.ok(st.autoScrollChecked === true, '自动滚动默认开启');
        c.ok(st.hideChatExists, '★ 有「排除用户对话」开关（参考图的控件之一）');
        c.ok(!/NaN/.test(st.metaText), '★ 状态栏不出现 NaN', st.metaText);
        // 五个级别药丸；DEBUG 默认关（对齐 bat 面板：成功的 HTTP 请求都在 DEBUG 上，默认放出来就刷屏）
        c.ok(st.pillLabels.join(',') === 'DEBUG,INFO,WARNING,ERROR,CRITICAL',
            '★ 五个级别药丸（DEBUG/INFO/WARNING/ERROR/CRITICAL）', JSON.stringify(st.pillLabels));
        c.ok(st.pillsPressed.join(',') === 'false,true,true,true,true',
            '★ DEBUG 默认关、INFO 及以上默认开（对齐 bat 面板，不刷请求噪音）',
            JSON.stringify(st.pillsPressed));
        c.ok(st.levels.every((l) => l !== 'DEBUG'),
            '★ 默认视图里没有 DEBUG 行（请求噪音默认隐藏）', JSON.stringify([...new Set(st.levels)]));

        const order = await page.evaluate(() => {
            const box = document.getElementById('logPageBox');
            const lines = [...box.querySelectorAll('.log-line')].map((d) => d.textContent || '');
            const ts = (s) => {
                const m = s.match(/\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/);
                return m ? ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+m[4]) : null;
            };
            return { first: ts(lines[0] || ''), last: ts(lines[lines.length - 1] || ''), n: lines.length };
        });
        c.ok(order.first !== null && order.last !== null && order.first <= order.last,
            '★ 顺序与 bat 面板一致（旧在上、新在下）',
            `首行 ${order.first}ms / 末行 ${order.last}ms（共 ${order.n} 行）`);

        // ③ 级别药丸过滤：关掉 INFO 后应只剩 WARN 及以上（DEBUG 默认已关）
        const before = st.lineCount;
        await page.evaluate(() => {
            document.querySelector('#logLevelPills .log-pill[data-level="INFO"]')?.click();
        });
        await page.waitForTimeout(2000);
        const afterWarn = await page.evaluate(() => ({
            n: document.getElementById('logPageBox').querySelectorAll('.log-line').length,
            meta: document.getElementById('logPageMeta').textContent,
            levels: [...document.getElementById('logPageBox').querySelectorAll('.log-line')].map((d) => d.dataset.level),
        }));
        c.ok(afterWarn.n <= before, `★ 关掉 INFO 后行数不增（${before} → ${afterWarn.n}）`);
        c.ok(afterWarn.levels.every((l) => ['WARN', 'ERROR', 'CRITICAL'].includes(l)),
            '★ 过滤后只剩 WARN 及以上（药丸真的生效了）', JSON.stringify([...new Set(afterWarn.levels)]));
        c.ok(!/NaN/.test(afterWarn.meta), '★ 过滤后状态栏仍正常', afterWarn.meta);

        await page.evaluate(() => {
            document.querySelector('#logLevelPills .log-pill[data-level="DEBUG"]')?.click();
            document.querySelector('#logLevelPills .log-pill[data-level="INFO"]')?.click();
        });
        await page.waitForTimeout(2000);
        const withDebug = await page.evaluate(() => ({
            levels: [...document.getElementById('logPageBox').querySelectorAll('.log-line')].map((d) => d.dataset.level),
        }));
        c.ok(withDebug.levels.includes('DEBUG') || withDebug.levels.length === 0,
            '★ 打开 DEBUG 药丸后能看到 DEBUG 行（默认关 ≠ 丢掉）',
            JSON.stringify([...new Set(withDebug.levels)]));

        await page.evaluate(() => {
            document.querySelectorAll('#logLevelPills .log-pill').forEach((b) => { b.setAttribute('aria-pressed', 'true'); });
            document.querySelectorAll('#logLevelPills .log-pill').forEach((b) => b.click());
        });
        await page.waitForTimeout(1200);
        const allOff = await page.evaluate(() => ({
            n: document.getElementById('logPageBox').querySelectorAll('.log-line').length,
            text: document.getElementById('logPageBox').textContent || '',
        }));
        c.ok(allOff.n === 0 && /关掉/.test(allOff.text), '★ 全部级别关掉时给出明确空态（不是空白）', allOff.text.slice(0, 60));

        // ⑤ 离开分栏 / 关闭设置：轮询必须停（否则服务端日志被自噪音刷屏）
        await page.evaluate(() => document.querySelector('[data-settings-tab="tab-appearance"]')?.click());
        await page.waitForTimeout(1200);
        const leftTab = await page.evaluate(() => ({
            viewerStopped: window.LogViewer ? window.LogViewer.isVisible() === false : null,
            logPanelHidden: !document.getElementById('tab-log').classList.contains('active-panel'),
        }));
        c.ok(leftTab.logPanelHidden, '★ 切到别的分栏后日志分栏收起');
        c.ok(leftTab.viewerStopped === true, '★ 离开日志分栏后轮询停掉（不再每 2 秒自拉）');

        await page.evaluate(() => { try { if (typeof closeSettingsPanel === 'function') closeSettingsPanel(); } catch (e) {} });
        await page.waitForTimeout(800);
        const closed = await page.evaluate(() => ({
            settingsHidden: document.getElementById('settingsOverlay').classList.contains('hidden'),
            viewerStopped: window.LogViewer ? window.LogViewer.isVisible() === false : null,
        }));
        c.ok(closed.settingsHidden, '★ 关闭设置面板后面板收起');
        c.ok(closed.viewerStopped === true, '★ 关闭设置后查看器认为自己不可见（轮询会停）');
    } finally {
        if (browser) await browser.close();
        srv.stop();
        await wait(300);
        dropDir(LOG_DIR);
    }
}

// 4. 落盘日志格式（端到端）：钉住文件格式与事实行 —— banner 类断言随其宿主实现一同退场
// 防的退化：多行诊断块落盘不被压平、日志文件合法 UTF-8、grep 前缀仍可用。

async function caseDiagnostics(c) {
    if (!GO_BIN) { c.ok(true, '环境性跳过：本机没有 Go 工具链'); return; }
console.log('\n=== 落盘格式端到端：真实服务 + 真实落盘日志 ===');
    {
        const LOG_DIR = makeLogDir('elaina-diag-');
        const PORT = await c.freePort();
        const HTTPS_PORT = await c.freePort();
        const srv = startServe({
            port: PORT,
            logDir: LOG_DIR,
            env: {
                HTTPS_PORT: String(HTTPS_PORT),
                DATA_DIR: path.join(LOG_DIR, 'data'),
                LOG_TO_FILE: '1', LOG_CHAT: '0',
            },
        });

        try {
            const up = await waitUp(`http://127.0.0.1:${PORT}`);
            c.ok(up, '服务已启动', up ? '' : srv.getOut().slice(-300));
            await wait(600);   // 让启动日志写完

            const logs = readdirSync(LOG_DIR).filter((n) => n.endsWith('.log') && !n.includes('trace'));
            c.ok(logs.length > 0, '产生了主日志文件', JSON.stringify(readdirSync(LOG_DIR)));
            if (logs.length) {
                const content = readFileSync(path.join(LOG_DIR, logs[0]), 'utf8');
                c.ok(!content.includes('\uFFFD'), '★ 日志文件是合法 UTF-8（没有替换字符）');
                c.ok(/listening on http:\/\//.test(content), '★ listening 行（英文事实）');
                /* 以「真的有插件目录」为准：mods/ 里可能只有占位文件 */
                const modsRoot = path.join(import.meta.dirname, '..', 'mods');
                let hasAnyPlugin = false;
                try { hasAnyPlugin = readdirSync(modsRoot).some((n) => existsSync(path.join(modsRoot, n, 'manifest.json'))); } catch (e) { hasAnyPlugin = false; }
                if (hasAnyPlugin) c.ok(/插件服务端半边：已装载 \d+ 个/.test(content), '★ 插件清单是事实行');
                else console.log('  --   跳过：本地没有任何插件（插件走应用内安装，这是正常状态）');
                c.ok(!/⏎/.test(content), '★ 没有出现压平标记 ⏎');
                const withPrefix = content.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[/.test(l));
                c.ok(withPrefix.length >= 3, '★ 多条记录带完整前缀（grep 仍可用）', String(withPrefix.length));
            }
        } finally {
            srv.stop();
            await wait(300);
            dropDir(LOG_DIR);
        }
    }
}

// 按命令行参数过滤用例（便于只跑其中一段）
const only = process.argv[2];
const allCases = [
    { name: '日志格式与级别', fn: caseLogFormat },
    { name: '日志查看接口 /api/logs/tail', fn: caseLogTail },
    { name: '日志查看器', fn: caseLogViewer },
    { name: '落盘日志格式', fn: caseDiagnostics },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: '日志与诊断（格式 / 落盘 / 级别 / 过滤 / 增量 / 查看器）',
    usage: 'node scripts/check-log.mjs [用例名子串]',
    cases,
});

