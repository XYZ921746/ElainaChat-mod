// 日志与诊断模块的回归检查（格式 / 落盘 / 级别 / 过滤 / 增量 / 查看器 / 诊断文案）。
//
// 合并自四个脚本：
//   · check-log-format.mjs  —— 日志系统端到端（格式 / 脱敏 / 双 sink / 级别门 / 对话追踪）
//   · check-log-tail.mjs    —— /api/logs/tail 的过滤、since/sinceSeq 增量与"自噪音"回路
//   · check-log-viewer.mjs  —— 真实浏览器验证日志查看器（设置里的独立分栏）的渲染与过滤
//   · check-diagnostics.mjs —— 诊断输出（横幅 / 问题报告 / 检查清单 / 插件描述）与多行落盘格式
//
// 为什么合并成一个按模块命名的文件：这四段测的是**同一条链路**的两端 —— 服务端
// `emitLog` 往哪写（文件 / 缓冲），前端查看器从缓冲里怎么读，以及写给用户看的诊断文案
// 长什么样，改一处经常同时影响两端。"日志里的脱敏"与"诊断块不被压平"就是同一个
// `formatForFile` / `redactSecrets` 的两面：拆成四个文件时这类改动要翻四份输出才能
// 拼出全貌。合并之后一批 serve.mjs 起停逻辑、临时目录与汇总样板只剩一份，
// 失败信息也统一带用例名（例如「日志查看器 :: ★ 行格式与面板一致…」）。
//
// 每段用例在自己的函数作用域里跑（LOG_DIR / startServer 只属于本段），跨用例共用的是
// 文件顶部那几个无状态的小工具（startServe / waitUp / makeLogDir）。
//
// 用法：node scripts/check-log.mjs          跑全部
//       node scripts/check-log.mjs 查看器   只跑名字含该子串的用例

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, mkdtempSync, rmSync, statSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './test-browser.mjs';
import {
    banner, usage, checklist, techInfo, problem, summary, describePlugins, MARK, MOD_STATE_LABEL,
} from '../server/diagnostics.mjs';
import { runChecks, ROOT, wait, freePort } from './check-harness.mjs';

// 版本号只读一次：日志前缀里的 `[v…]` 与 package.json 必须同源
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/**
 * 建一个临时日志目录。
 *
 * 日志写进临时目录（LOG_DIR 覆盖）：既不碰用户的 data/logs，也不会触发"保留最近 N 次启动"
 * 把用户的真实日志轮转删掉。
 */
function makeLogDir(prefix) {
    return mkdtempSync(path.join(tmpdir(), prefix));
}

/** 清掉临时目录；失败也不影响检查结论（Windows 上文件可能还被别的句柄占着） */
function dropDir(dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * 起一次 serve.mjs，并收集它写到 stdout/stderr 的全部内容。
 *
 * 每个场景用**不同端口** —— 刚 kill 掉的进程端口未必立刻释放。
 * 返回的 stop() 是幂等的：用例走到一半抛异常时，finally 里照样能收干净。
 */
function startServe({ port, logDir, env: extraEnv = {} }) {
    const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_DIR: logDir, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const getOut = () => out;
    const stop = () => { try { child.kill(); } catch { /* 已经退了 */ } };
    return { child, getOut, stop };
}

/** 轮询 /api/server-info 直到服务起来（最多等 ~20 秒），返回是否真的起来了 */
async function waitUp(base) {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
        try { up = (await fetch(base + '/api/server-info')).ok; } catch { await wait(250); }
    }
    return up;
}

// ────────────────────────────────────────────────────────────
// 1. 日志系统端到端：格式 / 级别 / 脱敏 / 双 sink / 对话追踪
//
// 为什么必须起真实服务：日志格式、脱敏、双 sink 轮转、对话追踪全是**运行时行为**，
// 静态读源码看不出"时间戳是不是本地时间""来源行号有没有指到包装函数自己"
// "流式回复有没有拼回来"这类问题 —— 而这几条恰好是最容易悄悄坏掉的。
// ────────────────────────────────────────────────────────────

async function caseLogFormat(c) {
    const LOG_DIR = makeLogDir('elainachat-log-');

    /**
     * 取最近写入的主日志内容。
     *
     * 必须按 mtime 而不是文件名排序：同一秒内起两个实例时，第二个的文件名是
     * `<时刻>-2.log`，而 `-`(0x2D) 排在 `.`(0x2E) 前面 —— 按名字排序会把**旧的**那个
     * 当成"最新"，于是断言全部落在错误的对象上，用例变成假阳性。
     */
    function readNewestMainLog() {
        const mains = readdirSync(LOG_DIR)
            .filter((n) => n.endsWith('.log') && !n.includes('.trace.'))
            .map((n) => ({ n, m: statSync(path.join(LOG_DIR, n)).mtimeMs }))
            .sort((a, b) => a.m - b.m);
        if (!mains.length) return '';
        return readFileSync(path.join(LOG_DIR, mains[mains.length - 1].n), 'utf8');
    }

    // ---------- mock 上游 ----------
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

    // 本段起的每个子进程都登记在这里，finally 里统一收掉 —— 漏一个就会泄漏端口
    const running = [];
    try {
        /** 起一次 serve.mjs，等端口就绪。每个场景用不同端口 —— 刚 kill 掉的进程端口未必立刻释放 */
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

        // ================= 场景一：完整跑一遍各类请求 =================
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
        child.kill();
        await wait(200);

        const consoleOut = getOut();
        const files = readdirSync(LOG_DIR).filter((n) => n.endsWith('.log'));
        const mainName = files.find((n) => !n.includes('.trace.'));
        const traceName = files.find((n) => n.includes('.trace.'));
        c.ok(!!mainName, '主日志文件已生成');
        c.ok(!!traceName, '追踪日志文件已生成');
        // 源脚本在这里 process.exit(1)：没有主日志就没什么可断言的了。
        // 合并后不能直接退出（会连带丢掉后续用例），改成抛异常 —— 本条用例的后续断言
        // 一条都不会假装跑过，其余用例照常执行。
        if (!mainName || !traceName) {
            console.log('主日志:', files);
            console.log(consoleOut);
            throw new Error('主日志 / 追踪日志没有同时生成，后面的断言无从下手');
        }

        const main = readFileSync(path.join(LOG_DIR, mainName), 'utf8');
        const trace = readFileSync(path.join(LOG_DIR, traceName), 'utf8');
        const mainLines = main.split('\n').filter((l) => l !== '');

        // ---- 格式 ----
        //
        // ★ 2026-09 起，主日志里**允许出现不带前缀的续行**。
        //
        //   为什么改：诊断块（启动横幅 / 检查清单 / 问题报告）是多行的，
        //   它们存在的意义就是"让人一眼看懂"。旧实现无条件把换行压成 `⏎`，
        //   压完完全没法读 —— 而用户的要求恰恰是"不懂这软件也能从日志看懂"。
        //   现在的约定：
        //     · 每条记录的**首行**必须带完整前缀（时间/标签/级别/来源）→ grep 仍可用
        //     · 续行不带前缀，但必须**有缩进**（视觉上属于上一条记录）
        //   所以断言拆成两条：首行必须合规；不带前缀的行必须缩进。
        const LINE_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[[A-Za-z0-9]+\] \[(DBUG|INFO|WARN|ERRO|CRIT)\]( \[v[^\]]+\])? \[[a-z0-9_.-]+:\d+\]: \s*\S/;
        const headLines = mainLines.filter((l) => LINE_RE.test(l));
        const contLines = mainLines.filter((l) => !LINE_RE.test(l));
        c.ok(headLines.length > 0, '主日志有合规的记录首行');
        // 续行必须缩进**或以分隔线开头**。
        // 为什么允许分隔线：横幅用 `====` 框住，那是刻意的视觉分隔；
        // 强行缩进反而不像分隔线了。除这两种之外，裸文本行都算格式错误
        // （因为它无法从视觉上归属到某条记录）。
        const badCont = contLines.filter((l) => !/^\s+\S/.test(l) && !/^=+$/.test(l));
        c.ok(badCont.length === 0, '不带前缀的续行都有缩进或分隔线（能归属到上一条记录）',
            badCont.slice(0, 3).join('\n      '));
        // 首行必须是**记录开头**：它前面不能紧跟另一个首行之外的裸文本行（粗判）
        c.ok(mainLines.length > 0, '主日志有内容');
        c.ok(!main.includes('⏎'), '主日志里没有压平标记 ⏎（多行结构被保留）');
        // 至少有一个多行诊断块，否则说明多行能力退化了
        c.ok(contLines.length > 0, '★ 存在多行诊断块（说明多行结构确实被保留，没被压成一行）');

        // ---- 时间是本地时间（旧实现用 toISOString，差了 8 小时）----
        // 毫秒是 2026-10 补的：同一秒里能连打十几条日志，秒级精度分不出先后。
        const first = headLines[0].match(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
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

        // ---- 级别 ----
        const warnPlus = headLines.filter((l) => /\[(WARN|ERRO|CRIT)\]/.test(l));
        c.ok(warnPlus.length > 0, '有 WARN/ERRO 级别记录');
        c.ok(warnPlus.every((l) => l.includes(`[v${VERSION}]`)), 'WARN 及以上带版本号');
        const infoLines = headLines.filter((l) => l.includes('[INFO]'));
        c.ok(infoLines.length > 0 && infoLines.every((l) => !l.includes('[v')), 'INFO 不带版本号（不制造噪音）');

        // ---- 来源行号：必须是真的调用点，不能全指到包装函数自己 ----
        //
        // ★★ 2026-10：判据从"必须是 serve"放宽到"必须是某个真实文件里的行号"。
        //   起因：本地中继搬进了 server/relay.mjs（电脑端与手机端共用），那里的日志
        //   来源现在**诚实地**报成 relay:N —— 这是对的（来源就该指真实文件），
        //   但写死 `serve` 会把合法来源当成缺失，实测 19/33。
        //   仍然保留下面那条"不能全指向包装层"：只要大量重复同一个行号就说明失效了。
        const srcLoc = /\[([A-Za-z0-9_.-]+):(\d+)\]/;
        const located = headLines.filter((l) => srcLoc.test(l));
        c.ok(located.length === headLines.length, '每条记录首行都带来源位置',
            `${located.length} 个位置 vs ${headLines.length} 个首行`);
        const locs = located.map((l) => Number(l.match(srcLoc)[2]));
        c.ok(new Set(locs).size > 3, '来源行号能区分不同调用点（不是全指向包装层）', `去重后只有 ${new Set(locs).size} 个位置`);

        // ---- 脱敏 ----
        //
        // ★ 这段是本次重做日志时**真正抓到问题**的地方，保留并加强：
        //   文案一改（密码从"访问密码: xxx"变成独占一行），脱敏就可能失效，
        //   而失效的后果是**明文密码落盘**。所以这里不只测当前格式，
        //   把几种历史格式都测一遍 —— 防止以后改文案时又漏。
        {
            // 从 serve.mjs 直接取真实规则，避免测试与实现各写一份
            const src = readFileSync(new URL('../web/serve.mjs', import.meta.url), 'utf8');
            const rm = src.match(/const SECRET_RULES = \[([\s\S]*?)\n\];/);
            c.ok(!!rm, '能取到 serve.mjs 的脱敏规则');
            if (rm) {
                const rules = eval('[' + rm[1] + ']');
                const redact = (t) => { let o = String(t); for (const [re, to] of rules) o = o.replace(re, to); return o; };
                const S = 'EPzNwvKXNWdt';
                const forms = [
                    ['英文事实行（当前格式）', 'LAN access password (initial, change it in Settings): ' + S],
                    ['密码独占一行', '要输这个密码\n      ' + S + '\n      建议改掉'],
                    ['带修饰语的标签', '局域网访问密码（初始随机）：' + S],
                    ['最老格式', '访问密码: ' + S],
                    ['key=value', '{"password":"' + S + '"}'],
                    ['Bearer', 'Authorization: Bearer ' + S + 'abcdefgh'],
                ];
                for (const [label, text] of forms) {
                    c.ok(!redact(text).includes(S), `★ 脱敏有效：${label}`);
                }
                // 反向：正常内容不能被误伤
                const normal = 'installed: elaina-avatar (dir=elaina-avatar)';
                c.ok(redact(normal) === normal, '★ 正常内容不被误伤（脱敏不过度）');
            }

            // ⚠️ 注意：serve.mjs 把 `console.log` 接管成"结构化日志"（走 emitLog），
            //    真正写 stdin/stdout 的是 consoleOriginal —— 所以子进程的 **stdout 里只剩
            //    续行**（横幅正文、` local AI chat server …`），带前缀的记录行是走
            //    stderr 出来的。密码那一行恰好是带前缀的记录行，因此必须两路合起来找，
            //    只翻 stdout 会得到 null（控制台明明打了密码，断言却报"没打印"）。
            const consoleOut = getOut();
            const pw = consoleOut.match(/access password[^:\n]*:\s*(\S+)/i)
                || consoleOut.match(/访问密码[^：:\n]{0,20}[:：]\s*(\S+)/)
                || consoleOut.match(/要输这个密码\s*\n\s*(\S+)/);
            c.ok(!!pw, '控制台打印了访问密码（用户要靠它登录）');
            c.ok(pw && !main.includes(pw[1]), '★ 日志文件里没有明文访问密码（脱敏对文案变化仍有效）');
            // 反向断言：日志里必须能看到"已脱敏"的痕迹，否则可能是整条都没记
            c.ok(main.includes('******') || main.includes('user-configured'),
                '日志里能看到脱敏后的占位符（或"已由用户设置"的事实行）');
        }

        // ---- 控制台不重复输出 ----
        c.ok(consoleOut.split('\n').filter((l) => l.includes('ElainaChat Mod v')).length === 1,
            '控制台每条日志只输出一次（没有"原文 + 格式化"两份）');
        // eslint-disable-next-line no-control-regex
        c.ok(!/\x1b\[/.test(consoleOut), '非 TTY 控制台不带 ANSI 颜色码');

        // ---- 对话摘要 ----
        // 4 次对话请求 + 1 次"连不上"（它也是对话请求，同样要记下问了什么）
        const askCount = mainLines.filter((l) => l.includes('[Chat]') && l.includes('提问：')).length;
        c.ok(askCount === 5, '每次对话请求都留一条「提问」摘要（含连不上的那次）', `实际 ${askCount}`);
        c.ok(main.includes('提问：那我们去哪儿玩？'), '提问摘要是最后一条用户消息');
        // 只有正常对话和流式对话成功；上游 400 / SSE 内报错 / 连不上 都不该出现「回复」
        c.ok(mainLines.filter((l) => l.includes('回复：')).length === 2, '只有真正成功的请求才留「回复」摘要');

        // ---- 报错原因直接写在主日志那一行 ----
        c.ok(main.includes('<< 上游报错：模型 test-model 不存在，请改用 DeepSeek-V4-Flash'),
            '上游 4xx 的原因被挖出来写进主日志');
        c.ok(main.includes('<< 响应内报错：当前分组上游负载已饱和'), '200 + SSE 内报错也能识别');
        c.ok(/\[ERRO\][^\n]*ECONNREFUSED/.test(main), '连不上时记录 ECONNREFUSED（能区分 DNS/TLS/拒绝）');
        c.ok(/\[WARN\][^\n]*目标地址无效/.test(main), '非法地址被拒绝时留下 WARN');

        // ---- 追踪日志：完整内容 ----
        c.ok(trace.includes('你是伊蕾娜，一个爱撒娇的魔女。'), '追踪日志含完整 system 提示');
        c.ok(trace.includes('今天天气怎么样？'), '追踪日志含完整历史消息');
        c.ok(trace.includes('你好呀，我是伊蕾娜。\n今天想去哪儿？'), '追踪日志含完整回复原文（换行保留）');
        c.ok(trace.includes('{"detail":{"error":{"message":"模型 test-model 不存在'), '追踪日志含完整上游报错响应体');
        c.ok(trace.includes('第一段，第二段。'), '流式回复被拼回完整正文');
        c.ok(!trace.includes('⏎'), '追踪日志多行原样保留（不压行）');
        c.ok(trace.includes('===== 请求失败'), '连不上时也记下当时问的是什么');
        c.ok(!trace.includes('"object":"list"'), '非对话接口（获取模型）的响应体不灌进追踪日志');

        // ================= 场景二：LOG_TO_FILE=0 =================
        const { child: child2, getOut: out2 } = await startServer({ LOG_TO_FILE: '0' }, await c.freePort());
        await wait(300);
        child2.kill();
        await wait(200);
        c.ok(readdirSync(LOG_DIR).filter((n) => n.endsWith('.log')).length === 2,
            'LOG_TO_FILE=0 时不产生新日志文件（自动化场景要能关掉落盘）');
        // 不落盘时也要如实说明 —— 用户看到"没有日志文件"时得知道是配置关掉了，
        // 而不是以为日志功能坏了。说明在启动头的 log file 行里（英文事实行）。
        c.ok(/disabled \(LOG_TO_FILE=0\)/.test(out2()) || /不落盘/.test(out2()),
            'LOG_TO_FILE=0 时明确说明了"不落盘"');

        // ================= 场景四：控制台级别门（2026-09 新增）=================
        // 用户要求："大量无用日志耽误排查进度" —— 成功请求归 DEBUG，
        // 控制台默认 INFO，所以日常窗口不刷请求行；切 DEBUG（或 LOG_CONSOLE）才全量。
        {
            const port4 = await c.freePort();
            const { child: c4, getOut: out4 } = await startServer({ LOG_TO_FILE: '0' }, port4);
            await wait(400);
            await fetch(`http://127.0.0.1:${port4}/api/plugins`).catch(() => {});
            await fetch(`http://127.0.0.1:${port4}/api/server-info`).catch(() => {});
            await wait(400);
            // ① 默认（INFO）：成功请求不刷屏
            c.ok(!/\[HTTP\]/.test(out4()), '★ 默认控制台级别下，成功请求不刷屏（[HTTP] 行消失）');
            c.ok(/listening on http:\/\//.test(out4()), '启动事件仍然可见');
            c4.kill();
            await wait(300);

            // ② LOG_CONSOLE=DEBUG：全量回归（旧行为）
            const port5 = await c.freePort();
            const { child: c5, getOut: out5 } = await startServer({ LOG_TO_FILE: '0', LOG_CONSOLE: 'DEBUG' }, port5);
            await wait(400);
            await fetch(`http://127.0.0.1:${port5}/api/plugins`).catch(() => {});
            await wait(400);
            c.ok(/\[HTTP\]/.test(out5()), '★ LOG_CONSOLE=DEBUG 时请求行可见（排查模式）');
            c5.kill();
            await wait(300);

            // ③ 失败请求在任何控制台级别都可见（WARN > INFO）
            const port6 = await c.freePort();
            const { child: c6, getOut: out6 } = await startServer({ LOG_TO_FILE: '0' }, port6);
            await wait(400);
            await fetch(`http://127.0.0.1:${port6}/api/definitely-not-exist`).catch(() => {});
            await wait(400);
            c.ok(/\[HTTP\].*404/.test(out6()), '★ 4xx 是 WARN，任何控制台级别下都可见');
            c6.kill();
            await wait(300);
        }

        // ================= 场景三：LOG_CHAT=0 =================
        const { child: child3 } = await startServer({ LOG_CHAT: '0' }, await c.freePort());
        await wait(300);
        child3.kill();
        await wait(200);
        c.ok(readdirSync(LOG_DIR).filter((n) => n.includes('.trace.')).length === 1,
            'LOG_CHAT=0 时不生成追踪日志（只记录访问与错误摘要）');

        // ================= 场景四：落盘级别过滤 =================
        //
        // 这是本轮改造的核心：**终端始终全量，级别只用来收窄文件**。
        // 三条边界必须一起验，少验一条就会出现"终端也被静音"或"级别设了没用"。
        {
            const port = await c.freePort();
            const { child: cl, getOut: out } = await startServer({ LOG_LEVEL: 'WARN' }, port);
            // 触发一次 INFO（200）和一次 WARN（404）
            await fetch(`http://127.0.0.1:${port}/api/server-info`).catch(() => {});
            await fetch(`http://127.0.0.1:${port}/api/definitely-missing`).catch(() => {});
            await wait(400);
            cl.kill();
            await wait(200);

            // 找到这次启动的主日志（按 mtime，同秒起两个实例时文件名排序不可靠）
            const text = readNewestMainLog();
            c.ok(!/\[INFO\][^\n]*server-info/.test(text),
                'LOG_LEVEL=WARN 时 INFO 记录不落盘（级别真的在过滤文件）');
            c.ok(/\[WARN\]/.test(text), 'LOG_LEVEL=WARN 时 WARN 仍然落盘');
            // 同一进程的控制台必须仍然有 INFO —— 否则"终端看全量"这个承诺是假的
            c.ok(/\[INFO\]/.test(out()), 'LOG_LEVEL=WARN 时控制台仍有 INFO（终端始终全量）');
        }

        // ================= 场景五：运行时改级别 + 对话追踪开关 =================
        {
            const port = await c.freePort();
            const { child: cl, getOut: out } = await startServer({ LOG_LEVEL: 'ERROR' }, port);
            // 1) 在 ERROR 级别下打一次 INFO 请求 —— 不该落盘
            await fetch(`http://127.0.0.1:${port}/api/server-info`).catch(() => {});
            await wait(200);

            const settingsUrl = `http://127.0.0.1:${port}/api/logs/settings`;
            const before = await (await fetch(settingsUrl)).json();
            c.ok(before.ok && before.level === 'ERROR', 'GET /api/logs/settings 返回当前级别');
            c.ok(Array.isArray(before.levels) && before.levels.length === 5,
                '接口给出五个级别（DEBUG/INFO/WARN/ERROR/CRITICAL）');

            // 2) 运行时改成 DEBUG
            const patched = await (await fetch(settingsUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ level: 'DBUG' }),
            })).json();
            c.ok(patched.ok && patched.level === 'DEBUG', 'POST 接受 AstrBot 短名 DBUG 并归一成 DEBUG');

            // 3) 现在同样的 INFO 请求该落盘了 —— 证明改级别**无需重启**就生效
            await fetch(`http://127.0.0.1:${port}/api/server-info`).catch(() => {});
            // 4) 关掉对话追踪
            const off = await (await fetch(settingsUrl, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ trace: false }),
            })).json();
            c.ok(off.ok && off.trace === false, 'POST 能关闭对话追踪');

            // 5) 非法级别必须被拒绝，且不能悄悄改掉当前值
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

        // ================= 场景六：CRITICAL 真的有产生路径 =================
        //
        // 之前 LEVEL_SHORT / LEVEL_NO / LEVEL_COLOR 都定义了 CRITICAL，却没有任何代码能产生它 ——
        // 是死配置。这条用例锁住"它真的能被触发"，防止又退回成摆设。
        {
            const busyPort = await c.freePort();
            // 兼容入口的端口也自己分配：默认 4174 可能正被用户真实的实例占着，
            // 那样"第二个实例启动失败"就不是因为端口冲突，用例会假阳性。
            const httpsPort = await c.freePort();
            const first = await startServer(
                { LOG_LEVEL: 'DEBUG', HTTPS_PORT: String(httpsPort) }, busyPort);
            // 再起一个抢同一个端口 → 必然 EADDRINUSE
            const second = startServe({
                port: busyPort,
                logDir: LOG_DIR,
                env: { HTTPS_PORT: String(httpsPort) },
            });
            running.push(second);
            await wait(1500);
            second.stop();
            first.child.kill();
            await wait(200);
            c.ok(/\[CRIT\]/.test(second.getOut()), '端口被占用时产生 CRITICAL 记录（级别不是死配置）', second.getOut().slice(-300));
        }
    } finally {
        // 每条用例自己收干净：先停进程（stop 是幂等的，已经停过的再 kill 也没事），再删临时目录
        for (const s of running) s.stop();
        await new Promise((r) => upstream.close(r));
        await wait(200);
        dropDir(LOG_DIR);
    }
}

// ────────────────────────────────────────────────────────────
// 2. /api/logs/tail：过滤 / 增量 / 自噪音
//
// 端到端：起真实服务 → 打日志 → 查 /api/logs/tail 的过滤能力 →
// 单测"同一毫秒多条"的游标漏洞 → 查看器轮询不再自噪音。
// ────────────────────────────────────────────────────────────

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

        // ── 1. 基本拉取 ──
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

        // ── 2. 级别过滤 ──
        const errs = await (await fetch(BASE + '/api/logs/tail?level=ERROR&limit=500')).json();
        c.ok(errs.entries.every((e) => ['ERROR', 'CRITICAL'].includes(e.level)),
            '★ level=ERROR 只返回 ERROR/CRITICAL', JSON.stringify(errs.entries.slice(0, 2).map((e) => e.level)));

        // ── 3. 模块过滤 ──
        const tags = await (await fetch(BASE + '/api/logs/tail?limit=500')).json().then((j) => j.tags);
        c.ok(Array.isArray(tags) && tags.includes('Mod'), '★ tags 列表包含 Mod（前端过滤下拉的数据源）', JSON.stringify(tags));
        const modOnly = await (await fetch(BASE + '/api/logs/tail?tags=Mod&limit=500')).json();
        c.ok(modOnly.entries.length > 0 && modOnly.entries.every((e) => e.tag === 'Mod'),
            '★ tags=Mod 只返回 Mod 模块', JSON.stringify(modOnly.entries.map((e) => e.tag).slice(0, 3)));

        // ── 4. 关键词过滤 ──
        const kw = await (await fetch(BASE + '/api/logs/tail?search=galgame&limit=500')).json();
        c.ok(kw.entries.every((e) => e.message.toLowerCase().includes('galgame')),
            '★ search 关键词过滤（大小写不敏感）');

        // ── 5. 增量拉取 ──
        const firstPull = await (await fetch(BASE + '/api/logs/tail?limit=1')).json();
        const since = firstPull.entries[0]?.ts || 0;
        await wait(300);
        const inc = await (await fetch(BASE + `/api/logs/tail?since=${since}&limit=300`)).json();
        c.ok(inc.entries.every((e) => e.ts > since), '★ since 增量只返回更新的记录', `${inc.entries.length} 条`);

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

            const allBuf = buf.query({ limit: 100 });
            c.ok(allBuf.entries.length === 6, '单测：6 条都进了缓冲', String(allBuf.entries.length));
            c.ok(allBuf.entries.every((e) => Number.isInteger(e.seq)),
                '★ 单测：每条都带写入序号 seq');
            const sameMs = allBuf.entries.filter((e) => e.ts === T);
            c.ok(sameMs.length === 5, '★ 单测：确实构造出同一毫秒 5 条', String(sameMs.length));

            // 游标 = 该毫秒**最早**那条（列表新→旧，所以取末位）
            const earliest = sameMs[sameMs.length - 1];
            const after = buf.query({ since: T, sinceSeq: earliest.seq, limit: 100 });
            const gotSeqs = new Set(after.entries.map((e) => e.seq));
            const missed = sameMs.filter((e) => e.seq !== earliest.seq && !gotSeqs.has(e.seq));
            c.ok(missed.length === 0,
                '★★ 单测：带了 sinceSeq 时，同毫秒的后续记录一条都不丢',
                missed.length ? `漏 ${missed.length} 条` : `带回 ${after.entries.length} 条`);
            c.ok(after.entries.some((e) => e.message === 'next-ms'),
                '★ 单测：更新的毫秒照常返回');

            // 不给 sinceSeq 时保持旧的严格 ">" 语义（老调用方不该突然收到重复行）
            const legacy = buf.query({ since: T, limit: 100 });
            c.ok(legacy.entries.every((e) => e.ts > T),
                '★ 单测：只传 since 的调用方仍是严格 ">"（不改变旧语义）',
                `${legacy.entries.length} 条`);

            // 老语义下的**丢条**必须能被这条断言复现出来 —— 否则说明测试没测到点上
            const legacySeqs = new Set(legacy.entries.map((e) => e.seq));
            const legacyMissed = sameMs.filter((e) => !legacySeqs.has(e.seq));
            c.ok(legacyMissed.length === 5,
                '★★ 单测：只比时间戳时同毫秒 5 条全丢（这就是原 bug 的实证）',
                `丢 ${legacyMissed.length} 条`);
        }

        // 接口层：真实响应里也要带 seq（前端游标靠它）
        {
            const t = await (await fetch(BASE + '/api/logs/tail?limit=20')).json();
            c.ok(t.entries.length > 0 && t.entries.every((e) => Number.isInteger(e.seq)),
                '★ /api/logs/tail 的每条记录都带 seq', `${t.entries.length} 条`);
        }

        // ── 6. 内存缓冲不受落盘级别影响（即使把落盘级别调高，缓冲仍全量）──
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
        // 落盘文件里则**没有** INFO（级别过滤对文件仍生效）
        const fs = await import('node:fs');
        const logFile = fs.readdirSync(LOG_DIR).find((n) => n.endsWith('.log') && !n.includes('trace'));
        if (logFile) {
            const content = fs.readFileSync(path.join(LOG_DIR, logFile), 'utf8');
            const tailPart = content.split('\n').slice(-30).join('\n');
            c.ok(!/\[INFO\]/.test(tailPart) || !/plugins.*200/.test(tailPart),
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

        // ── 9. 英文事实行仍然成立 ──
        //（等待插件扫描完成 —— 它在 listen 回调里异步跑）
        for (let i = 0; i < 20 && !srv.getOut().includes('installed: elaina-avatar'); i++) {
            await wait(200);
        }
        // 注：emitLog 会把消息开头的 [mod] 抽成标签字段并规范为 [Mod]，
        // 所以输出行是 `[Mod] [INFO] ... installed: elaina-avatar`。
        /* 插件源码不随仓库分发：本地没装 elaina-avatar 时启动日志里不会有 installed 行，跳过而不是判红 */
        if (existsSync(path.join(import.meta.dirname, '..', 'mods', 'elaina-avatar'))) {
            c.ok(/installed: elaina-avatar \(dir=/.test(srv.getOut()), '★ 启动日志是英文事实行（installed: id (dir=…)）', srv.getOut().slice(-300));
        } else {
            console.log('  --   跳过：本地没有 elaina-avatar 插件（插件走应用内安装，这是正常状态）');
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

// ────────────────────────────────────────────────────────────
// 3. 日志查看器（真实浏览器）
//
// ★ 2026-10 改版：日志从「设置 → 高级」里的一个小盒子，改成**独立分栏**
//   （#tab-log，与外观/角色/对话并列）。本段随之改写：
//   · 打开方式：切到「日志」分栏（不再有"打开日志"按钮 / 全屏页）
//   · 级别过滤：药丸多选（而不是一个 select）
//   · 行格式：带毫秒的时间戳
//
// ★ 位置判断错过两次，这两条断言就是钉住结论的：
//   ① 不能放主界面 rail（用户："我日志是让你放设置里而不是放主界面啊"）
//   ② 不能只做「高级」的最后一项（实测被挤到屏幕外，用户："设置里我没看见日志界面"）
// ────────────────────────────────────────────────────────────

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

    // ★ 用共用的启动器（浏览器路径 + 屏蔽外网，见 scripts/test-browser.mjs）
    let browser = null;
    try {
        browser = await launchTestBrowser();
        const up = await waitUp(BASE);
        await wait(800);

        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);

        // ★ 首次启动会有「使用引导」遮罩（#announcementOverlay），它会挡住所有点击 ——
        //   真实用户会点掉它，检查里必须做同一件事，否则后面每次 click 都超时。
        //   （实测踩到：railLogBtn 的点击被它 intercepts pointer events 挡了 58 次后超时。）
        await page.evaluate(() => {
            const ov = document.getElementById('announcementOverlay');
            if (ov) { ov.classList.add('hidden'); ov.classList.remove('flex'); }
        });
        await page.waitForTimeout(300);

        // ---- ① 位置：日志是**设置里的独立分栏**（#tab-log） ----
        //
        // ★ 位置判断错过两次，这几条断言把结论钉死：
        //   ① 不在主界面 rail（用户："我日志是让你放设置里而不是放主界面啊"）
        //   ② 不只是「高级」的最后一项 —— 那样会被挤到**屏幕外**
        //      （实测：高级高 920px、内容区视口 842px，按钮 top=895 看不见）
        await page.evaluate(() => { try { if (typeof openSettings === 'function') openSettings(); } catch (e) {} });
        await page.waitForTimeout(800);
        const inSettings = await page.evaluate(() => {
            const nav = document.getElementById('settingsTabNav');
            const logBtn = nav ? nav.querySelector('[data-settings-tab="tab-log"]') : null;
            return {
                // 老的"内嵌查看器"必须已经不存在
                hasOldViewer: Boolean(document.getElementById('logViewerBox')),
                hasOldLevelSelect: Boolean(document.getElementById('logViewerLevel')),
                // 日志分栏的按钮与面板都要在
                hasLogTabBtn: Boolean(logBtn),
                hasLogPanel: Boolean(document.getElementById('tab-log')),
                // 日志控件确实在 tab-log 里（而不是还留在高级）
                controlsInLogTab: Boolean(document.querySelector('#tab-log #logLevelPills')
                    && document.querySelector('#tab-log #logPageBox')),
                controlsInAdvanced: Boolean(document.querySelector('#tab-advanced #logLevelPills')),
                // ★ 分栏按钮必须在**视口内可见**（用户反馈"设置里我没看见日志界面"的直接回归）
                tabBtnInViewport: logBtn
                    ? (() => { const r = logBtn.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()
                    : false,
                // rail 上**不该**有日志按钮
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
        c.ok(!inSettings.hasRailLogBtn, '★ 主界面 rail 上**没有**日志按钮（用户要求：放设置里）');

        // ---- ② 切到「日志」分栏 ----
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
                // 当前渲染出来的级别集合（用来断言"默认视图里没有 DEBUG"）
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
        // ★ 行格式必须与 bat 面板/日志文件**同形**：`[时刻] [模块] [级别] [来源] 正文`
        //   2026-10 用户报"查看器与 bat 面板对不上"，其中一半原因是级别与模块位置反了。
        //   另一条：时间戳现在带**毫秒**（同一秒里能连打十几条，秒级分不出先后）。
        c.ok(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[[^\]]+\] \[(DBUG|INFO|WARN|ERRO|CRIT)\] \[[^\]]+\]/.test(st.firstLine),
            '★ 行格式与面板一致：时刻(含毫秒) + [模块] + [级别短码] + [来源] + 正文', st.firstLine);
        c.ok(st.hasLevelColors, '★ 级别有配色区分');
        c.ok(st.tagOptions.includes('Mod') || st.tagOptions.includes('Core'), '★ 模块下拉有真实模块名', JSON.stringify(st.tagOptions));
        c.ok(st.autoScrollChecked === true, '自动滚动默认开启');
        c.ok(st.hideChatExists, '★ 有「排除用户对话」开关（参考图的控件之一）');
        c.ok(!/NaN/.test(st.metaText), '★ 状态栏不出现 NaN', st.metaText);
        // 五个级别药丸；★ DEBUG 默认**关**（对齐 bat 面板：成功的 HTTP 请求都在 DEBUG 上，
        // 默认放出来就是一屏 `GET /api/xxx 200 7ms` —— 用户实测反馈"看不懂的消息"）。
        c.ok(st.pillLabels.join(',') === 'DEBUG,INFO,WARNING,ERROR,CRITICAL',
            '★ 五个级别药丸（DEBUG/INFO/WARNING/ERROR/CRITICAL）', JSON.stringify(st.pillLabels));
        c.ok(st.pillsPressed.join(',') === 'false,true,true,true,true',
            '★ DEBUG 默认关、INFO 及以上默认开（对齐 bat 面板，不刷请求噪音）',
            JSON.stringify(st.pillsPressed));
        // ★ 默认视图里**不该出现 DEBUG 行**（请求行就是这一类）。
        //   这是用户报"日志为什么会出现这种看不懂的消息"的直接回归断言。
        c.ok(st.levels.every((l) => l !== 'DEBUG'),
            '★ 默认视图里没有 DEBUG 行（请求噪音默认隐藏）', JSON.stringify([...new Set(st.levels)]));

        // ★ 顺序必须**与 bat 面板一致：旧在上、新在下**（用户报"对不上"的另一半原因）
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

        // ---- ③ 级别药丸过滤：关掉 INFO 后应只剩 WARN 及以上 ----
        //   （DEBUG 默认就是关的，所以这里只需再关 INFO）
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

        // ---- ③b 把 DEBUG 打开：请求行应该回来（证明它只是默认关，没有被丢掉）----
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

        // ---- ④ 全部级别关掉：给明确空态，而不是空白 ----
        await page.evaluate(() => {
            document.querySelectorAll('#logLevelPills .log-pill').forEach((b) => { b.setAttribute('aria-pressed', 'true'); });
            // 逐个点掉
            document.querySelectorAll('#logLevelPills .log-pill').forEach((b) => b.click());
        });
        await page.waitForTimeout(1200);
        const allOff = await page.evaluate(() => ({
            n: document.getElementById('logPageBox').querySelectorAll('.log-line').length,
            text: document.getElementById('logPageBox').textContent || '',
        }));
        c.ok(allOff.n === 0 && /关掉/.test(allOff.text), '★ 全部级别关掉时给出明确空态（不是空白）', allOff.text.slice(0, 60));

        // ---- ⑤ 离开分栏 / 关闭设置：轮询必须停（否则服务端日志被自噪音刷屏）----
        //   先切到别的分栏
        await page.evaluate(() => document.querySelector('[data-settings-tab="tab-appearance"]')?.click());
        await page.waitForTimeout(1200);
        const leftTab = await page.evaluate(() => ({
            viewerStopped: window.LogViewer ? window.LogViewer.isVisible() === false : null,
            logPanelHidden: !document.getElementById('tab-log').classList.contains('active-panel'),
        }));
        c.ok(leftTab.logPanelHidden, '★ 切到别的分栏后日志分栏收起');
        c.ok(leftTab.viewerStopped === true, '★ 离开日志分栏后轮询停掉（不再每 2 秒自拉）');

        //   再关掉整个设置面板
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

// ────────────────────────────────────────────────────────────
// 4. 诊断输出（server/diagnostics.mjs）+ 多行日志落盘格式
//
// ── 这个检查防的是什么 ──────────────────────────────────────────────────
//
// 用户的要求原话："就算不知道是什么软件也可以通过日志知道是哪里有问题、
// 软件在做什么事情"。这翻译成可测的断言就是：
//
//   ① 日志开头必须**自报家门**（这是什么软件、在干什么、怎么用）
//   ② 每条问题必须包含 **what（发生了什么）/ why（为什么）/ how（怎么办）**
//      —— 缺了 how，用户就卡在"知道坏了但不知道做什么"
//   ③ how 必须是**能照做的**（含具体命令 / 界面位置），不能是"请检查配置"
//   ④ 正常状态与故障要**分开**，不能把"默认关闭"当故障报警
//   ⑤ 不用内部标识符当句子主语（说「桌宠（pet）」而不是裸 `pet`）
//   ⑥ 多行诊断块落盘时**不能被压成一行**（压了就没法读了）
//
// 这些是文案质量约束，靠人眼盯盯不住 —— 所以写成断言。
// ────────────────────────────────────────────────────────────

async function caseDiagnostics(c) {
    // ============================================================
    // 1. 横幅：必须自报家门（但要**短**）
    // ============================================================
    console.log('=== 诊断 1. 启动头：自报家门，且不啰嗦 ===');
    {
        const t = banner({
            name: 'ElainaChat Mod', version: '9.9.9',
            tagline: '本地运行的 AI 角色聊天应用',
        });
        c.ok(/ElainaChat Mod v9\.9\.9/.test(t), '有软件名与版本号');
        c.ok(/本地运行的 AI 角色聊天应用/.test(t), '有一句话定位');
        // ★ 横幅要短：上一版在这里写了「这是什么」「现在在做什么」两大段，
        //   那是文档该干的活 —— 每次启动都要滚过去的日志里放这些纯属噪音。
        c.ok(t.split('\n').length <= 6, '★ 横幅足够短（≤6 行，不把日志刷屏）',
            t.split('\n').length + ' 行');
        c.ok(!/现在在做什么/.test(t), '★ 不再有冗长的「现在在做什么」段落');

        // 默认 tagline 必须交代**数据流向** —— 用户最关心的就是
        // "我的聊天记录和 API Key 会不会被传到别处"。
        const def = banner({ name: 'X', version: '1.0.0' });
        c.ok(/不经过第三方|不经过任何第三方/.test(def), '★ 默认定位交代了数据流向');
        c.ok(/这台电脑|本机|你自己/.test(def), '★ 默认定位交代了"跑在你自己电脑上"');
    }

    // ============================================================
    // 1b. 「怎么用」块：要照着敲的东西单独成块
    // ============================================================
    console.log('\n=== 诊断 1b. 「怎么用」块 ===');
    {
        const t = usage([
            { state: 'ok', label: '在这台电脑上打开', value: 'http://127.0.0.1:3999', hint: '用浏览器打开。' },
            { state: 'warn', label: '手机连进来要输这个密码', value: 'abcd1234', hint: '建议改掉。' },
        ]);
        c.ok(/【怎么用】/.test(t), '有「怎么用」分组标题');
        c.ok(/http:\/\/127\.0\.0\.1:3999/.test(t), '地址单独成行（不和说明混排）');
        c.ok(/abcd1234/.test(t), '密码单独成行');
        // 地址/密码必须比说明文字**更突出**：单独一行、缩进 6 格
        c.ok(/\n {6}http:\/\/127\.0\.0\.1:3999\n/.test(t), '★ 地址独占一行且缩进（不会被看漏）');
        c.ok(/\n {6}abcd1234\n/.test(t), '★ 密码独占一行且缩进');
    }

    // ============================================================
    // 1c. 技术信息块：排查信息收在最后
    // ============================================================
    console.log('\n=== 诊断 1c. 技术信息块 ===');
    {
        const t = techInfo([['进程号', '1234'], ['运行环境', 'Node v1.0.0'], ['空值', ''], ['未定义', undefined]]);
        c.ok(/【技术信息/.test(t), '有技术信息分组');
        c.ok(/进程号：1234/.test(t), '进程号在里面');
        c.ok(!/空值/.test(t) && !/未定义/.test(t), '★ 空值/未定义项被跳过（不打无意义的行）');
        c.ok(/复制给别人/.test(t), '★ 说明了这个块的用途（排查时整份复制）');
    }

    // ============================================================
    // 2. 问题报告：what / why / how 三段齐全
    // ============================================================
    console.log('\n=== 诊断 2. 问题报告：三段式必须齐全 ===');
    {
        const t = problem({
            what: '端口 3999 已被占用，服务没能启动',
            where: 'web/serve.mjs',
            why: '上一次启动的实例还开着',
            how: '关掉它，或换个端口',
        });
        c.ok(/端口 3999 已被占用/.test(t), 'what 在');
        c.ok(/原因：/.test(t), '★ why 有标签');
        c.ok(/怎么办：/.test(t), '★ how 有标签');
        c.ok(/位置：/.test(t), 'where 有标签（便于定位到文件）');
        c.ok(t.startsWith(MARK.bad), '以故障图标开头（可扫读）');

        // 多个方案要编号
        const multi = problem({
            what: 'X 失败', why: 'Y', how: ['方案一', '方案二', '方案三'],
        });
        c.ok(/任选一种/.test(multi), '多个方案时提示"任选一种"');
        c.ok(/1\) 方案一/.test(multi) && /3\) 方案三/.test(multi), '多个方案被编号列出');

        // 没有 how 时不该崩（但要能看出缺了）
        const bare = problem({ what: '只有标题' });
        c.ok(/只有标题/.test(bare), '缺 why/how 时不崩');
        c.ok(!/undefined|null/.test(bare), '★ 不会把 undefined/null 打进日志');
    }

    // ============================================================
    // 3. 检查清单：状态图标语义固定
    // ============================================================
    console.log('\n=== 诊断 3. 检查清单：状态可扫读 ===');
    {
        const t = checklist([
            { state: 'ok', label: '正常项' },
            { state: 'note', label: '正常但值得知道' },
            { state: 'warn', label: '能跑但可能不是你要的' },
            { state: 'bad', label: '坏了' },
        ], '测试');
        c.ok(/【测试】/.test(t), '有分组标题');
        c.ok(t.includes(MARK.ok) && t.includes(MARK.note) && t.includes(MARK.warn) && t.includes(MARK.bad),
            '★ 四种状态图标都出现（正常/提示/警告/故障 可区分）');
        c.ok(/正常项/.test(t) && /坏了/.test(t), '各项标签都在');
        // hint 要缩进在下一行，不能挤在同一行
        const withHint = checklist([{ state: 'ok', label: 'L', hint: '这是提示' }]);
        c.ok(/L\n\s+这是提示/.test(withHint), 'hint 换行缩进显示（不挤在标签后面）');
    }

    // ============================================================
    // 4. 收尾：只在真有问题时出现
    // ============================================================
    console.log('\n=== 诊断 4. 收尾汇总 ===');
    {
        // ★ 正常时必须返回**空串**：上一版无论成败都打"一切正常，服务已就绪"，
        //   和前面那句"服务已启动，可以用了"重复 —— 同一件事说两遍纯占地方。
        const clean = summary([]);
        c.ok(clean === '', '★ 无问题时返回空串（不重复打"一切正常"）', JSON.stringify(clean));
        c.ok(summary(null) === '' && summary(undefined) === '', '空/undefined 输入也不打');

        const dirty = summary(['✘ 问题甲\n  细节', '✘ 问题乙\n  细节']);
        c.ok(/有 2 项需要处理/.test(dirty), '★ 有 N 项要处理');
        c.ok(/1\. ✘ 问题甲/.test(dirty) && /2\. ✘ 问题乙/.test(dirty), '问题被编号汇总');
        c.ok(!/细节/.test(dirty), '汇总只取标题，不重复细节（细节上面已打过）');
        c.ok(/重新启动/.test(dirty), '★ 给出了收尾动作（改完要重启）');
    }

    // ============================================================
    // 5. 插件描述：说人话
    // ============================================================
    console.log('\n=== 诊断 5. 插件清单描述：说人话，不用内部标识符当主语 ===');
    {
        const { text, problems } = describePlugins([
            { id: 'elaina-avatar', name: '伊蕾娜立绘与情绪', state: 'ready', dir: '1111' },
            { id: 'pet', name: '桌宠', state: 'disabled', dir: 'pet' },
            { id: 'galgame', name: 'Galgame 界面', state: 'blocked', dir: 'galgame',
                error: '前置插件「elaina-avatar」未启用 —— 到「设置 → 插件」里把它的开关打开。' },
        ]);
        c.ok(/共 3 个/.test(text), '先给总数');
        c.ok(/可用 1/.test(text), '报可用数');
        c.ok(/未启用 1/.test(text), '报未启用数');
        c.ok(/有问题 1/.test(text), '报问题数');
        c.ok(/伊蕾娜立绘与情绪/.test(text), '★ 用显示名，不是裸 id');
        c.ok(/桌宠（pet）/.test(text), '★ 显示名 + id 备查（两者都有）');
        c.ok(/正常的/.test(text), '★ 明确说"未启用是正常的"（默认关闭不该报警）');
        c.ok(/设置 → 插件/.test(text), '★ 给出界面上的具体位置');
        c.ok(/实际装在目录 1111\//.test(text), '目录名与 id 不同时如实说明（便于排查）');
        c.ok(problems.length === 1, '只有真故障进 problems 列表', String(problems.length));
        c.ok(problems[0].includes(MARK.bad), 'problems 条目带故障图标');

        // 没有插件是正常状态，不是错误
        const empty = describePlugins([]);
        c.ok(empty.problems.length === 0, '★ 没有插件时不产生"问题"（那是正常状态）');
        c.ok(/没有安装任何插件/.test(empty.text), '如实说明"没有插件"');
        c.ok(/设置 → 插件|web\/mods/.test(empty.text), '给出安装插件的方法');
    }

    // ============================================================
    // 6. 状态文案与前端一致
    // ============================================================
    console.log('\n=== 诊断 6. 状态文案与前端保持一致 ===');
    {
        const modsJs = readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');
        c.ok(/STATE_LABEL/.test(modsJs), '前端也有 STATE_LABEL（同一套状态名）');
        // 两边对同一状态的说法必须是同一句，否则对照着看会以为不是一回事
        c.ok(MOD_STATE_LABEL.ready.includes('已加载'), 'ready 说法一致');
        c.ok(MOD_STATE_LABEL.blocked.includes('拒绝加载'), 'blocked 说法一致');
        c.ok(MOD_STATE_LABEL.disabled.includes('未启用'), 'disabled 说法一致');
    }

    // ============================================================
    // 7. 源码层：关键故障点确实用了结构化报告
    // ============================================================
    console.log('\n=== 诊断 7. 源码层：故障点用了结构化报告 ===');
    {
        const serve = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');
        c.ok(/import \{[^}]*banner[^}]*\} from '\.\.\/server\/diagnostics\.mjs'/.test(serve),
            'serve.mjs 引入了诊断模块');
        c.ok(/printListenError[\s\S]{0,900}already in use/.test(serve),
            '★ 端口占用是英文事实行 + cause/fix 结构');
        // 端口占用的"怎么办"必须给出可照做的命令
        c.ok(/netstat -ano \| findstr/.test(serve), '★ 给了"找出占用者"的命令');
        c.ok(/taskkill \/PID/.test(serve), '★ 给了"结束进程"的命令');
        c.ok(/set PORT=/.test(serve), '★ 给了"换端口"的命令');
        // 给人的那一句中文仍在（fix 命令后面）
        c.ok(/端口被占用，多半是上一个实例还开着/.test(serve), '★ 保留一句中文说明（给人看）');
        c.ok(/banner\(\{/.test(serve), '启动时打自描述横幅');

        // ── 2026-09 二次调整：日志正文 = 英文事实行，说明文字移出日志流 ──
        //   用户明确要求："我要的是日志的详细，不是加不相干的信息" +
        //   "日志全英文（中文日志没有英文日志好用）"。
        //   启动事件现在是一行一个英文事实，引导文字只在最后保留一句中文指路。
        c.ok(/listening on \$\{urls\.join\(', '\)\}/.test(serve), '★ 启动事件：listening 行（英文，含全部地址）');
        c.ok(/\[mod\] installed: \$\{p\.id\}/.test(serve), '★ 启动事件：每个插件一行英文事实（id/dir/依赖）');
        c.ok(/LAN access password/.test(serve), '★ 访问密码行是英文事实行');
        c.ok(/就绪。日志可在应用内/.test(serve), '★ 只保留一句中文指路（软件内查看器入口）');
        // 反向：说明文字不再刷屏
        c.ok(!/usage\(usageItems\)/.test(serve), '★ 「怎么用」说明块已移出日志流');
        c.ok(!/techInfo\(\[/.test(serve), '★ 冗长的技术信息块已移除');
        c.ok(!/section\('插件（已安装）'\)/.test(serve), '★ 插件体检分段说明已移出（改为 [mod] 事实行）');

        // 英文事实行仍然进内存缓冲（软件内查看器的数据源）
        c.ok(/logBuffer\.push\(/.test(serve), '★ emitLog 把每条日志写入内存缓冲');
        c.ok(/api\/logs\/tail/.test(serve), '★ /api/logs/tail 接口存在（查看器数据源）');

        // ★ 多行结构必须保留（否则诊断块被压成一行，等于白做）
        c.ok(/function formatForFile/.test(serve), '★ 有 formatForFile（区分单行/多行）');
        c.ok(/if \(!safe\.includes\('\\n'\)\) return head \+ safe/.test(serve),
            '单行仍是一行一条（grep 可用）');
        c.ok(/const rest = lines\.slice\(1\)/.test(serve),
            '★ 多行保留换行（诊断块不被压扁）');
        // 旧的无条件压平必须已经消失
        c.ok(!/const flat = body\.replace\(\/\\s\*\\n\\s\*\/g, ' ⏎ '\)/.test(serve),
            '★ 旧的"无条件压平换行"已移除');
    }

    // ============================================================
    // 8. 端到端：真的跑一次服务，检查落盘日志
    // ============================================================
    console.log('\n=== 诊断 8. 端到端：真实服务 + 真实落盘日志 ===');
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
                // ① 编码正确
                c.ok(!content.includes('\uFFFD'), '★ 日志文件是合法 UTF-8（没有替换字符）');
                // ② 英文事实行（2026-09 起）
                c.ok(/ElainaChat Mod v/.test(content), '★ 有软件名与版本');
                c.ok(/local AI chat server/.test(content), '★ 横幅是一行英文定位（含 pid/node/平台）');
                c.ok(/listening on http:\/\//.test(content), '★ listening 行（英文事实）');
                /* 以「真的有插件目录」为准：mods/ 里可能只有占位文件 */
                const modsRoot = path.join(import.meta.dirname, '..', 'mods');
                let hasAnyPlugin = false;
                try { hasAnyPlugin = readdirSync(modsRoot).some((n) => existsSync(path.join(modsRoot, n, 'manifest.json'))); } catch (e) { hasAnyPlugin = false; }
                if (hasAnyPlugin) c.ok(/installed: .*\(dir=/.test(content), '★ 插件清单是英文事实行');
                else console.log('  --   跳过：本地没有任何插件（插件走应用内安装，这是正常状态）');
                // ③ 多行结构保留（关键：没被压成一行）
                c.ok(!/⏎/.test(content), '★ 没有出现压平标记 ⏎');
                // ④ 冗长说明不再刷屏
                c.ok(!/怎么用/.test(content), '★ 说明文字不再进日志流');
                c.ok(!/技术信息/.test(content), '★ 冗长技术信息块已移除');
                c.ok(!/现在在做什么/.test(content), '★ 没有冗长段落');
                // ⑤ 行首前缀仍完整（grep 可用）
                // 时间戳带毫秒（2026-10 起）：同一秒里能连打十几条，秒级分不出先后
                const withPrefix = content.split('\n').filter((l) => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[/.test(l));
                c.ok(withPrefix.length >= 3, '★ 多条记录带完整前缀（grep 仍可用）', String(withPrefix.length));
            }
        } finally {
            srv.stop();
            await wait(300);
            dropDir(LOG_DIR);
        }
    }
}

// ────────────────────────────────────────────────────────────
// 5. 手机端 bootstrap 的日志接口（与 serve.mjs 同构的那一半）
//
// 为什么必须起真实 bootstrap：client-log 的摄入语义（级别白名单 / 截断 /
// 追踪全文）、/api/logs/tail 的查询参数、relay 摘要进缓冲（console 重挂）、
// 落盘与脱敏，全是**运行时行为**，静态读源码证明不了"两端同一个消费方
// （log-viewer.js）拿到的形状一致"。
//
// 布局照 sync-web 的产物形态：bootstrap.mjs + server/<共享模块> 复制进临时
// 目录 —— 仓库里 web/nodejs/ 下没有 server/ 子目录（那是 sync 时才生成的），
// 直接跑仓库路径会 ERR_MODULE_NOT_FOUND。共享模块清单从 sync-web.mjs 源码里
// 提取（提取失败 = 清单格式变了，本身就是该报警的漂移）。
// ────────────────────────────────────────────────────────────

async function caseBootstrapLogs(c) {
    const TMP = mkdtempSync(path.join(tmpdir(), 'elaina-bootstrap-log-'));
    const NODE_ROOT = path.join(TMP, 'nodejs');
    const DATA_DIR = path.join(TMP, 'elaina-data');
    const ok = (cond, label, extra) => c.ok(cond, label, extra);

    // 从 sync-web.mjs 提取共享模块清单（单一事实源，检查脚本不另写一份）
    // 打包工具住在 dist/Android/scripts/ —— 与 Android 打包放在一起。
    const syncSrc = readFileSync(path.join(ROOT, 'dist', 'Android', 'scripts', 'sync-web.mjs'), 'utf8');
    const listMatch = syncSrc.match(/SHARED_SERVER_MODULES\s*=\s*\[([^\]]*)\]/);
    ok(Boolean(listMatch), '★ 能从 sync-web.mjs 提取 SHARED_SERVER_MODULES（提取失败=清单格式漂移）');
    const sharedModules = listMatch
        ? listMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
        : [];

    mkdirSync(path.join(NODE_ROOT, 'server'), { recursive: true });
    copyFileSync(path.join(ROOT, 'web', 'nodejs', 'bootstrap.mjs'), path.join(NODE_ROOT, 'bootstrap.mjs'));
    for (const name of sharedModules) {
        const src = path.join(ROOT, 'server', name);
        ok(existsSync(src), `共享模块存在：${name}`);
        copyFileSync(src, path.join(NODE_ROOT, 'server', name));
    }

    const child = spawn(process.execPath, [path.join(NODE_ROOT, 'bootstrap.mjs'), `--data-dir=${DATA_DIR}`], {
        cwd: NODE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    /** 从 stdout 的 __ELAINA_READY__ 行解析端口（bootstrap 自己挑端口，F-1） */
    async function waitReady(timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const m = out.match(/__ELAINA_READY__(\{[^\n]*\})/);
            if (m) {
                try { return JSON.parse(m[1]); } catch { /* 行不完整，继续等 */ }
            }
            await wait(150);
        }
        return null;
    }
    const HEADERS = { Origin: 'https://localhost' };   // bootstrap 的 Origin 门（F-2）：不带就是 403

    try {
        const ready = await waitReady();
        ok(Boolean(ready && ready.port > 0), 'bootstrap 已监听并回传端口', out.slice(-400));
        if (!ready) return;
        const BASE = `http://127.0.0.1:${ready.port}`;

        // ── 1. Origin 门（安全语义不能因加日志被顺手拆掉）──
        const noOrigin = await fetch(BASE + '/api/ping');
        ok(noOrigin.status === 403, '★ 无 Origin 的请求仍被 403（Origin 门未松动）', String(noOrigin.status));
        const preflight = await fetch(BASE + '/api/client-log', { method: 'OPTIONS', headers: HEADERS });
        ok(preflight.status === 204, 'OPTIONS 预检直接 204（text/plain 上报也免预检）', String(preflight.status));

        // ── 2. client-log 摄入（application/json，桌面同路径）──
        const post1 = await fetch(BASE + '/api/client-log', {
            method: 'POST',
            headers: { ...HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: [
                { level: 'error', text: '手机端报错探针 startup-error', page: '/index.html' },
                { level: 'warn', text: '带密钥的报错 sk-abcdefghijklmnopqrstuvwxyz 截断探针', page: '/' },
            ] }),
        });
        ok(post1.status === 200 && (await post1.json()).ok === true, 'POST /api/client-log（application/json）成功');

        // ── 3. client-log 摄 text/plain（阶段一 beacon 补丁就这么发的，不能按头拒收）──
        const post2 = await fetch(BASE + '/api/client-log', {
            method: 'POST',
            headers: { ...HEADERS, 'Content-Type': 'text/plain' },
            body: JSON.stringify({ items: [{ level: 'error', text: 'text-plain 探针 tp-probe', page: '/' }] }),
        });
        ok(post2.status === 200 && (await post2.json()).ok === true,
            '★ POST /api/client-log 对 text/plain 请求体同样收下（不校验 Content-Type）');

        // ── 4. tail：字段形状 + [page] 摄入 + 级别 + 脱敏 ──
        await wait(300);
        const tail = await (await fetch(BASE + '/api/logs/tail?limit=500', { headers: HEADERS })).json();
        ok(tail.ok === true, 'GET /api/logs/tail 可用');
        ok(Array.isArray(tail.entries) && tail.entries.length > 0, '缓冲里有条目（启动日志已进缓冲）');
        ok(tail.entries.every((e) => typeof e.ts === 'number' && e.level && e.tag && typeof e.message === 'string' && typeof e.seq === 'number'),
            '★ 记录字段与 serve.mjs 同形状（ts/level/tag/message/seq）');
        const pageEntries = tail.entries.filter((e) => e.tag === 'Page');
        ok(pageEntries.length >= 3, '★ [page] 条目已进缓冲（client-log → console 重挂 → logBuffer）',
            JSON.stringify(pageEntries.map((e) => e.message).slice(0, 2)));
        ok(pageEntries.some((e) => e.message.includes('startup-error') && e.level === 'ERROR'),
            '★ error 级别的上报记成 ERROR');
        const secretEntry = pageEntries.find((e) => e.message.includes('密钥'));
        ok(Boolean(secretEntry) && /sk-\*\*\*\*\*\*/.test(secretEntry.message) && !/sk-abcdefgh/.test(secretEntry.message),
            '★ 缓冲里的 API Key 被脱敏（sk-… → sk-******）', secretEntry && secretEntry.message.slice(0, 80));
        const errOnly = await (await fetch(BASE + '/api/logs/tail?level=ERROR&limit=500', { headers: HEADERS })).json();
        ok(errOnly.entries.length > 0 && errOnly.entries.every((e) => ['ERROR', 'CRITICAL'].includes(e.level)),
            '★ level=ERROR 过滤与 serve.mjs 同语义');

        // ── 5. 增量游标（两个值成对，同毫秒不丢不重）──
        const firstPull = await (await fetch(BASE + '/api/logs/tail?limit=1', { headers: HEADERS })).json();
        const since = firstPull.entries[0]?.ts || 0;
        const sinceSeq = firstPull.entries[0]?.seq ?? -1;
        await wait(250);
        const inc = await (await fetch(BASE + `/api/logs/tail?since=${since}&sinceSeq=${sinceSeq}&limit=300`, { headers: HEADERS })).json();
        ok(inc.entries.every((e) => e.ts > since || (e.ts === since && e.seq > sinceSeq)),
            '★ since+sinceSeq 增量只返回更新的记录');

        // ── 6. relay 摘要进缓冲（traceLine 只进追踪文件，console 重挂把摘要送进缓冲）──
        const badRelay = await fetch(BASE + '/api/relay', {
            method: 'POST',
            headers: { ...HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'not-a-url', method: 'GET' }),
        });
        ok(badRelay.status === 400, 'relay 无效目标回 400（不依赖网络即可触发 relay 的日志路径）');
        await wait(200);
        const tail2 = await (await fetch(BASE + '/api/logs/tail?limit=500', { headers: HEADERS })).json();
        ok(tail2.entries.some((e) => e.tag === 'Relay' && e.message.includes('目标地址无效')),
            '★ relay 的 warn 摘要进缓冲（[relay] 标签归一化为 Relay）');

        // ── 7. 落盘：主日志 + 追踪日志都在 <data-dir>/logs/ 下 ──
        const logsDir = path.join(DATA_DIR, 'logs');
        const files = existsSync(logsDir) ? readdirSync(logsDir) : [];
        ok(files.some((f) => /^\d{4}-\d{2}-\d{2}_.*\.log$/.test(f)), '★ 主日志已落盘（<data-dir>/logs/）', JSON.stringify(files));
        ok(files.some((f) => /\.trace\.log$/.test(f)), '★ 追踪日志已落盘');
        const traceFile = files.find((f) => /\.trace\.log$/.test(f));
        if (traceFile) {
            const traceText = readFileSync(path.join(logsDir, traceFile), 'utf8');
            ok(traceText.includes('浏览器上报') && traceText.includes('text-plain 探针'),
                '★ 浏览器上报全文进追踪日志（含 text/plain 那条）');
        }
        const mainFile = files.find((f) => /^\d{4}-\d{2}-\d{2}_.*\.log$/.test(f) && !/trace/.test(f));
        if (mainFile) {
            const mainText = readFileSync(path.join(logsDir, mainFile), 'utf8');
            ok(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[Page\] \[ERRO\]/.test(mainText),
                '★ 主日志行带完整前缀（时刻 [Page] [ERRO]，grep 可用）');
            ok(!/sk-abcdefgh/.test(mainText), '★ 主日志文件里没有明文密钥');
        }

        // ── 8. 日志设置最小形状 ──
        const settings = await (await fetch(BASE + '/api/logs/settings', { headers: HEADERS })).json();
        ok(settings.ok === true && Array.isArray(settings.levels) && settings.keep === 10, 'GET /api/logs/settings 最小形状');

        // ── 9. 收尾：shutdown（同样要过 Origin 门）──
        const stop = await fetch(BASE + '/api/shutdown', { method: 'POST', headers: HEADERS });
        ok(stop.status === 200, 'POST /api/shutdown 正常回包');
    } finally {
        try { child.kill(); } catch { /* 已退出 */ }
        await wait(300);
        dropDir(TMP);
    }
}

// 按命令行参数过滤用例（便于只跑其中一段）
const only = process.argv[2];
const allCases = [
    { name: '日志格式与级别', fn: caseLogFormat },
    { name: '日志查看接口 /api/logs/tail', fn: caseLogTail },
    { name: '日志查看器', fn: caseLogViewer },
    { name: '诊断输出', fn: caseDiagnostics },
    { name: 'bootstrap 内嵌日志接口', fn: caseBootstrapLogs },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: '日志与诊断（格式 / 落盘 / 级别 / 过滤 / 增量 / 查看器 / 诊断文案）',
    usage: 'node scripts/check-log.mjs [用例名子串]',
    cases,
});
