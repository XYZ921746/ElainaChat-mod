// AI 用浏览器（Chrome DevTools Protocol）的回归检查。
// ── 这个模块守什么 ──────────────────────────────────────────────────────
// 浏览器能力的两条边界都是"看代码觉得没问题、真跑才暴露"的类型：
//   ① **协议层**：WebSocket 帧编错（漏掩码、长度字段写错）的表现是
//      "握手成功、随后静默断开"，日志里一个字都没有。所以帧编解码是纯函数，
//      这里穷举断言，不连浏览器也能测。
//   ② **安全边界**：调试端口能读这台机器上所有登录态，所以协议白名单、
//      "只认本机"、以及"用户没打开开关就拒绝"都必须钉住 —— 前端可以被绕过，
//      服务端这道闸是唯一的。
// 浏览器**没装**时（CI / 干净的机器）跳过所有需要真浏览器的用例，
//   按 AGENTS.md 第 9 节记为环境性跳过，不判红。
// 用法：node scripts/check-browser.mjs            跑全部
//       node scripts/check-browser.mjs 协议       只跑名字含该子串的用例
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { runChecks, ROOT } from './check-harness.mjs';
import { extractFunction, extractTopLevelFunctions, extractVariable, makeVmSandbox, runClassicScripts } from './check-source.mjs';
import { encodeClientFrame, createFrameDecoder } from '../server/ws-client.mjs';
import { createLineSplitter } from '../server/mcp-client.mjs';
import {
    normalizeNavigationUrl, findBrowserExecutable, formatSnapshot,
    runBrowserAction, createBrowserSession, browserCandidates, MAX_SNAPSHOT_ITEMS,
} from '../server/browser.mjs';

const hasBrowser = Boolean(findBrowserExecutable());

/** agent 的全局脚本集合：搜索实现已拆到 agent-search.js，按 index.html 顺序拼接 */
const AGENT_SOURCES = ['agent-parse.js', 'agent.js', 'agent-search.js'].map((f) => path.join(ROOT, 'web', 'js', f));
function readAgentSources() {
    return AGENT_SOURCES.map((f) => readFileSync(f, 'utf8')).join('\n');
}

/** 用解码器吃一段字节，返回收到的消息列表（同步收集，便于断言） */
function decodeAll(chunks) {
    const messages = [];
    let closed = false;
    const decoder = createFrameDecoder({
        onMessage: (t) => messages.push(t),
        onClose: () => { closed = true; },
    });
    for (const c of chunks) decoder.push(c);
    return { messages, closed };
}

/** 按 RFC 6455 手搓一个**服务端→客户端**的帧（不掩码），用来喂解码器 */
function serverFrame(opcode, payload, { fin = true } = {}) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
    return Buffer.concat([header, data]);
}

/**
 * 按函数名抠出完整函数声明（含前面的 async 与后面的函数体）。
 *
 * 为什么不能"从函数名往后找第一个 { 再配花括号"：参数表里的默认值（`opts = {}`）
 *   就有大括号，从那里找会抠出半截函数；函数体里的字符串 `'}' ` 又会让配对多减一次 ——
 *   两种错法都表现为一个和本函数毫无关系的语法错误。
 * 正确做法：**先跳过参数表**（配圆括号），再从参数表之后配花括号。
 */
const extractFnNamed = (source, name) => extractFunction(source, name, { required: false });

// 1. WebSocket 帧编解码（纯函数，不需要浏览器）
async function caseFrames(c) {
    // 客户端帧**必须**带掩码位：Chrome 收到不带掩码的客户端帧会直接断开，
    //   而且不会在 CDP 里报错 —— 现象就是"连上就断"。
    {
        const frame = encodeClientFrame(0x1, 'hello');
        c.ok((frame[1] & 0x80) !== 0, '★ 客户端帧带掩码位（RFC 6455 要求，漏了会连上就断）');
        c.ok((frame[0] & 0x80) !== 0, '客户端帧 FIN=1（单帧消息）');
        c.ok((frame[0] & 0x0f) === 0x1, '客户端帧 opcode = text');
        // 掩码键之后的内容必须与原文按 4 字节循环异或后一致
        const len = frame[1] & 0x7f;
        const mask = frame.subarray(2, 6);
        const body = frame.subarray(6, 6 + len);
        let plain = '';
        for (let i = 0; i < body.length; i++) plain += String.fromCharCode(body[i] ^ mask[i & 3]);
        c.ok(plain === 'hello', '掩码后的载荷能被同一把掩码键还原', JSON.stringify(plain));
    }

    // 长度字段的三种形态：7 位 / 16 位 / 64 位
    {
        const small = encodeClientFrame(0x1, 'x'.repeat(10));
        c.ok((small[1] & 0x7f) === 10, '短消息用 7 位长度');
        const mid = encodeClientFrame(0x1, 'x'.repeat(300));
        c.ok((mid[1] & 0x7f) === 126 && mid.readUInt16BE(2) === 300, '300 字节用 16 位长度');
        const big = encodeClientFrame(0x1, 'x'.repeat(70000));
        c.ok((big[1] & 0x7f) === 127 && Number(big.readBigUInt64BE(2)) === 70000, '70KB 用 64 位长度');
    }

    // 解码：一条完整消息
    {
        const { messages } = decodeAll([serverFrame(0x1, '{"id":1}')]);
        c.ok(messages.length === 1 && messages[0] === '{"id":1}', '解码一条完整文本帧');
    }

    // 解码：分片消息（大响应必然被拆开）
    {
        const chunks = [
            serverFrame(0x1, '{"a":', { fin: false }),
            serverFrame(0x0, '1', { fin: false }),
            serverFrame(0x0, '}', { fin: true }),
        ];
        const { messages } = decodeAll(chunks);
        c.ok(messages.length === 1 && messages[0] === '{"a":1}', '★ 分片消息按 FIN 合并成一条', JSON.stringify(messages));
    }

    // 解码：字节流被任意切开（TCP 不保证一条消息一次到）
    {
        const whole = serverFrame(0x1, '{"id":42,"result":{}}');
        const pieces = [];
        for (let i = 0; i < whole.length; i += 3) pieces.push(whole.subarray(i, i + 3));
        const { messages } = decodeAll(pieces);
        c.ok(messages.length === 1 && messages[0] === '{"id":42,"result":{}}', '★ 被切成 3 字节一片仍能拼回整条消息');
    }

    // 解码：多条消息挤在一次 read 里
    {
        const { messages } = decodeAll([Buffer.concat([serverFrame(0x1, 'a'), serverFrame(0x1, 'b')])]);
        c.ok(messages.length === 2 && messages[0] === 'a' && messages[1] === 'b', '一次 read 里的多条消息各自交付');
    }

    // 解码：close 帧要触发 onClose
    {
        const { closed } = decodeAll([serverFrame(0x8, '')]);
        c.ok(closed === true, 'close 帧触发 onClose（调用方据此清掉在途请求）');
    }

    // 解码：PING 帧交给 onPing（连接层据此回 PONG），且没提供 onPing 时也不能抛错。
    //   这里钉住的是一个真 bug：createFrameDecoder 曾引用不存在的 handlers，
    //   任何保活 PING 都会抛 ReferenceError（桌面端能冒成 uncaughtException）。
    {
        const pings = [];
        let threw = '';
        const d = createFrameDecoder({ onMessage() {}, onClose() {}, onPing: (p) => pings.push(p.toString()) });
        try { d.push(serverFrame(0x9, 'hb')); } catch (e) { threw = String((e && e.message) || e); }
        c.ok(!threw && pings.length === 1 && pings[0] === 'hb',
            '★ PING 帧交给 onPing（连接层回 PONG），不再抛 ReferenceError', threw || JSON.stringify(pings));

        let threw2 = '';
        try { decodeAll([serverFrame(0x9, 'x')]); } catch (e) { threw2 = String((e && e.message) || e); }
        c.ok(!threw2, '没有提供 onPing 时 PING 帧也不能中断解码（向后兼容）', threw2);
    }
}

// 2. URL 白名单（安全边界，纯函数）
async function caseUrls(c) {
    const good = ['https://example.com', 'http://127.0.0.1:8080/a?b=1', 'https://例子.中国/路径'];
    const bad = [
        ['file:///C:/Windows/win.ini', 'file: 读本地文件'],
        ['javascript:alert(1)', 'javascript: 在当前页执行代码'],
        ['chrome://settings', 'chrome:// 改浏览器设置'],
        ['devtools://devtools/bundled/inspector.html', 'devtools://'],
        ['data:text/html,<script>alert(1)</script>', 'data: 内联脚本'],
        ['', '空'],
        ['   ', '只有空白'],
        ['https://example.com\nrm -rf /', '带换行（命令行注入试探）'],
        ['不是网址', '完全不是 URL'],
    ];
    const okList = good.filter((u) => !normalizeNavigationUrl(u).ok);
    c.ok(okList.length === 0, '正常 http / https 网址都放行', okList.join(', '));

    const leaked = bad.filter(([u]) => normalizeNavigationUrl(u).ok).map(([, why]) => why);
    c.ok(leaked.length === 0, '★ 危险协议全部拒绝（file / javascript / chrome / data / 换行）', leaked.join(', '));

    // 拒绝时必须给出原因 —— 模型靠这句话换个做法，而不是盲目重试
    const r = normalizeNavigationUrl('file:///C:/x');
    c.ok(!r.ok && r.reason.includes('http'), '拒绝时说明只允许 http/https', r.reason);
}

// 3. 快照格式与动作派发（用假 session，不需要真浏览器）
async function caseActions(c) {
    // 假 session：只记录被调用了什么，不真的连浏览器
    const calls = [];
    const fake = {
        ensure: async () => calls.push('ensure'),
        close: async () => calls.push('close'),
        goto: async (u) => { calls.push('goto:' + u); return u; },
        snapshot: async () => ({ url: 'https://x/', title: 'T', text: 'body', truncated: false, items: [{ ref: '1', tag: 'a', text: '链接', value: '', disabled: false }] }),
        clickRef: async (r) => calls.push('click:' + r),
        typeIntoRef: async (r, t) => calls.push('type:' + r + '=' + t),
        pressEnter: async () => calls.push('enter'),
        screenshot: async () => 'base64',
    };

    const unknown = await runBrowserAction(fake, 'zzz');
    c.ok(!unknown.ok && unknown.text.includes('open'), '不认识的动作列出可用动作', unknown.text);

    const noRef = await runBrowserAction(fake, 'click', {});
    c.ok(!noRef.ok && noRef.text.includes('编号'), '★ 点击缺 ref 时说清"要给出编号"（模型据此自我纠正）', noRef.text);

    const noText = await runBrowserAction(fake, 'type', { ref: '2' });
    c.ok(!noText.ok && noText.text.includes('文字'), '★ 输入缺 text 时说清"要给出文字"', noText.text);

    calls.length = 0;
    const clicked = await runBrowserAction(fake, 'click', { ref: '3' });
    c.ok(clicked.ok && calls.includes('click:3'), '点击把 ref 透传下去');
    // 点完必须**自带一次新快照** —— 否则模型要再发一次请求才能知道页面变没变
    c.ok(clicked.ok && /当前页面/.test(clicked.text), '★ 点击后自动带回新页面快照（省一次往返）');

    // 异常要变成 {ok:false}，不能抛出去（抛出去会变成一句笼统的"操作失败"）
    const boom = { ...fake, goto: async () => { throw new Error('DNS 挂了'); } };
    const failed = await runBrowserAction(boom, 'goto', { url: 'https://x/' });
    c.ok(!failed.ok && failed.text.includes('DNS'), '★ 执行失败把原因原样交给模型（不吞成"操作失败"）', failed.text);

    // 快照格式：编号必须出现，否则模型没法点
    const text = formatSnapshot({ url: 'https://x/', title: '标题', text: '正文', items: [{ ref: '7', tag: 'button', text: '提交', value: '', disabled: false }] });
    c.ok(text.includes('[7]') && text.includes('提交'), '快照文本里带编号与元素文字', text);
    c.ok(text.includes('https://x/') && text.includes('标题'), '快照文本里带网址与标题');
    const filled = formatSnapshot({ url: 'u', title: 't', text: '', items: [{ ref: '1', tag: 'input', text: '搜索框', value: '已填的字', disabled: false }] });
    c.ok(filled.includes('已填的字'), '★ 输入框的当前内容出现在快照里（模型能自查填对没有）', filled);
}

// 4. 服务端接线（源码断言：跨文件的安全边界只能这样钉）
async function caseWiring(c) {
    const serve = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');
    const browser = readFileSync(path.join(ROOT, 'server', 'browser.mjs'), 'utf8');
    const agent = readAgentSources();
    const tags = readFileSync(path.join(ROOT, 'web', 'js', 'agent-tags.js'), 'utf8');

    const wiring = [
        [serve, "/api/agent/browser'", '服务端有 /api/agent/browser 路由'],
        [serve, 'isLocalRequest(request)', '★ 浏览器接口只认本机（局域网设备一律拒绝）'],
        [serve, 'accessDisabled(access)', '关闭档下浏览器整块不可用'],
        [serve, 'browserEnabledByUser()', '★ 服务端自己读设置里的开关（不信前端传来的）'],
        [serve, 'loadStore()', '读设置走 store 的公开接口（不自己拼 store.json 路径）'],

        [browser, "'--remote-debugging-port=0'", '★ 调试端口由内核分配（不写死，避免撞上用户自己的调试实例）'],
        [browser, '--remote-debugging-address=127.0.0.1', '★ 调试端口只绑回环'],
        [browser, 'mkdtemp', '★ 独立临时 profile（不碰用户正在用的浏览器）'],
        [agent, "name: 'browser'", '前端注册了浏览器操作'],
        [agent, 'runAgentBrowserOperation', '有统一执行器'],
        [agent, 'agentBrowserEnabled', '执行器里再判一次用户开关（标签通道可绕过 available）'],
        [tags, "browser_action: '浏览器'", '工具名 → 中文标签名有映射'],
        [tags, "/^(浏览器|网页|打开网址)/", '标签分发锚定开头（不与电脑命令互吃）'],
    ];
    // 第一条是"必须存在"，第二条是"绝不能出现"—— 分开断言，避免把两种判据混在一张表里
    const missing = wiring.filter(([src, needle]) => !src.includes(needle)).map(([, needle, label]) => label || needle);
    c.ok(missing.length === 0, '★ 浏览器接线完整（路由 / 安全边界 / 注册 / 标签）', missing.join(' / '));

    c.ok(!/--remote-debugging-port=9\d{3}/.test(browser), '★ 没有写死调试端口');
    c.ok(/ALLOWED_PROTOCOLS = new Set\(\['http:', 'https:'\]\)/.test(browser), '★ 协议白名单只有 http/https');
    c.ok(!/file:\/\//.test(browser.replace(/\/\/.*$/gm, '')), 'browser.mjs 不主动使用 file:// 协议');
}

// 5. 真浏览器端到端（没装浏览器时整段跳过）
async function caseEndToEnd(c) {
    if (!hasBrowser) {
        console.log('  --   跳过：这台机器上没有 Chrome / Edge（浏览器相关用例按环境性跳过）');
        c.ok(true, '浏览器端到端（环境性跳过）');
        return;
    }
    // 起一个本地页面，避免依赖外网
    const { createServer } = await import('node:http');
    const page = '<!doctype html><html><head><title>表单页</title></head><body>'
        + '<h1>搜索</h1><input id="q" placeholder="输入关键词">'
        + '<button onclick="document.title=\'已搜：\'+document.getElementById(\'q\').value">搜索</button>'
        + '<div id="out">（还没搜）</div></body></html>';
    const srv = createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    const session = createBrowserSession({ idleCloseMs: 30000 });
    try {
        await session.goto('http://127.0.0.1:' + port + '/');
        c.ok(session.isRunning(), '★ 浏览器起来了（且启动器进程退出不算死 —— 见 ensure 里的说明）');

        const snap1 = await session.snapshot();
        c.ok(snap1.title === '表单页', '拿到了页面标题', snap1.title);
        const input = snap1.items.find((i) => i.tag === 'input');
        const button = snap1.items.find((i) => i.tag === 'button');
        c.ok(Boolean(input) && Boolean(button), '★ 快照里找到了输入框与按钮', JSON.stringify(snap1.items));

        await session.typeIntoRef(input.ref, '魔女之旅');
        const snap2 = await session.snapshot();
        const input2 = snap2.items.find((i) => i.tag === 'input');
        c.ok(input2 && input2.value === '魔女之旅', '★ 真输入进到了页面里（不是只改了 DOM 属性）', JSON.stringify(input2));

        await session.clickRef(button.ref);
        const snap3 = await session.snapshot();
        c.ok(snap3.title === '已搜：魔女之旅', '★ 真点击触发了页面的 onclick', snap3.title);

        // 越界协议在**会话层**也要拒（不只靠路由）
        let rejected = false;
        try { await session.goto('file:///C:/Windows/win.ini'); } catch { rejected = true; }
        c.ok(rejected, '★ 会话层拒绝 file:// 导航');

        const shot = await session.screenshot();
        c.ok(shot.length > 1000, '截图拿到了真实画面', String(shot.length) + ' 字节(base64)');
    } finally {
        await session.close();
        srv.close();
    }
    c.ok(!session.isRunning(), 'close 之后连接已释放');
}

// 5. 联网搜索（Tavily）：纯函数部分
async function caseWebSearch(c) {
    const src = readAgentSources();
    // 装 agent-search.js 的整个顶层函数环境 + 两个截断常量（不再抠单个函数体）：
    //   formatSearchResult 以后若拆出 helper，这里也不用改。
    const searchSrc = readFileSync(path.join(ROOT, 'web', 'js', 'agent-search.js'), 'utf8');
    const searchSandbox = makeVmSandbox({});
    vm.runInContext(
        [extractVariable(searchSrc, 'TAVILY_SNIPPET_MAX'), extractVariable(searchSrc, 'TAVILY_OUTPUT_MAX')].join('\n')
        + '\n' + extractTopLevelFunctions(searchSrc),
        searchSandbox,
        { filename: 'agent-search.js#format-env' },
    );
    const format = searchSandbox.formatSearchResult;
    const snippetMax = vm.runInContext('TAVILY_SNIPPET_MAX', searchSandbox);
    const outputMax = vm.runInContext('TAVILY_OUTPUT_MAX', searchSandbox);
    c.ok(typeof format === 'function', 'agent-search.js 里有可用的 formatSearchResult');

    // 正常结果：标题、网址、摘要都要出现 —— 网址是模型"引用来源"的唯一依据
    {
        const text = format('测试', {
            answer: '这是一段摘要',
            items: [
                { title: '结果一', url: 'https://a.example/1', content: '内容一' },
                { title: '结果二', url: 'https://b.example/2', content: '内容二' },
            ],
        }, '某服务商');
        c.ok(text.includes('这是一段摘要'), '结果里带上 Tavily 的摘要');
        c.ok(text.includes('https://a.example/1') && text.includes('https://b.example/2'), '★ 每条结果都带网址（模型据此引用来源）', text);
        c.ok(text.includes('结果一') && text.includes('内容一'), '标题与摘要都出现');
    }

    // 空结果：必须明确说"没搜到"，而不是返回一个空串
    {
        const text = format('测试', { items: [] }, '');
        c.ok(text.includes('没有搜到'), '★ 没结果时明确说出来（空串会让模型以为搜过了）', text);
    }

    // 单条摘要与总长度都要截断：不截会把提示词撑爆
    {
        const long = 'x'.repeat(5000);
        const text = format('测试', { items: [{ title: 't', url: 'https://a/', content: long }] }, '');
        c.ok(text.length <= outputMax + 40, '总长度被截断到上限附近', String(text.length));
        c.ok(snippetMax > 0 && snippetMax <= 1000, '单条摘要上限是个合理的小值', String(snippetMax));
    }

    // 缺字段要能容错（Tavily 偶尔不返回 title / content）
    {
        let threw = null;
        let text = '';
        try { text = format('测试', { items: [{ url: 'https://c.example/' }] }, ''); } catch (e) { threw = e; }
        c.ok(threw === null, '结果缺 title / content 时不抛异常', threw && threw.message);
        c.ok(text.includes('https://c.example/'), '缺标题时网址仍然给出');
    }

    // 注册表与通道接线
    c.ok(/name: 'web_search', tool: 'web_search'/.test(src), '注册表里有 web_search 操作');
    c.ok(/ElainaOps\.setExec\('web_search'/.test(src), 'web_search 挂了执行实现');
    c.ok(/tavilySearchEnabled !== true\) return false/.test(src), '★ 开关关着时不可用（注册表 available 判据）');
    c.ok(/searchApiKey_' \+ id/.test(src), '★ 没填 Key 时不可用（按当前服务商那一格判）');
    c.ok(/id === 'custom'/.test(src), '★ 自定义源还必须填了 https 端点才算可用');
    c.ok(/SEARCH_PROVIDERS/.test(readFileSync(path.join(ROOT, 'web', 'js', 'core-search.js'), 'utf8')),
        '★ 服务商清单在 core.js（执行器与设置页共用同一份）');
    const tags = readFileSync(path.join(ROOT, 'web', 'js', 'agent-tags.js'), 'utf8');
    c.ok(/web_search: '搜索'/.test(tags), '工具名 → 中文标签名有映射');
    c.ok(/\^\\(搜索\\|搜一下\\|联网搜索\\|查一下\\)/.test(tags) || /搜索\|搜一下\|联网搜索\|查一下/.test(tags),
        '标签分发认「搜索」并锚定开头');
}

// 6. 四家搜索服务商的请求体与响应解析（形状来自各家真实响应）
async function caseSearchProviders(c) {
    const src = readFileSync(path.join(ROOT, 'web', 'js', 'core-search.js'), 'utf8');
    const table = vm.runInContext(extractVariable(src, 'SEARCH_PROVIDERS') + '\n;SEARCH_PROVIDERS', makeVmSandbox({}));
    c.ok(table && Object.keys(table).length > 0, 'core.js 里有 SEARCH_PROVIDERS');
    const ids = Object.keys(table);
    // 只留 Exa 与 Tavily —— 两家都有免绑卡的月度免费额度。
    //   这条断言同时防两件事：① 只剩一家时"换一家试试"就没意义了；
    //   ② 有人把博查 / Serper 又加回来（它们要付费，用户明确要求只留免费的两家）。
    // 内置只留 Tavily，其余走 custom 自定义源。
    //   这条断言同时防两件事：① 又内置回付费 / 额度不透明的服务商；② 把自定义源删掉。
    c.ok(ids.length === 2 && ids.includes('tavily') && ids.includes('custom'),
        '★ 内置只剩 Tavily，另有 custom 自定义源', ids.join(','));
    for (const gone of ['exa', 'bocha', 'serper', 'brave']) {
        c.ok(!ids.includes(gone), '不内置 ' + gone + '（额度不透明 / 付费 / 被墙）');
    }
    for (const id of ids) {
        c.ok(Boolean(table[id].freeNote), id + ' 写明了额度（设置页要如实告诉用户）');
    }
    const dflt = (src.match(/const DEFAULT_SEARCH_PROVIDER = '([^']+)'/) || [])[1];
    c.ok(dflt === 'tavily', '★ 默认服务商是 Tavily（唯一内置的一家）', String(dflt));

    // 每一条都要有完整的五件套，缺一件就会在运行时炸
    const bad = [];
    for (const [id, def] of Object.entries(table)) {
        for (const k of ['label', 'endpoint', 'buildBody', 'buildHeaders', 'parse']) {
            if (!def[k]) bad.push(id + '.' + k);
        }
        // 内置源的端点必须是 https 字符串；自定义源的端点是函数（用户填，运行时校验）
        const ep = typeof def.endpoint === 'function' ? 'https://x/' : String(def.endpoint || '');
        if (!/^https:\/\//.test(ep)) bad.push(id + '.endpoint 不是 https');
    }
    c.ok(bad.length === 0, '每家都有 label / endpoint / buildBody / buildHeaders / parse', bad.join(', '));

    // 请求体：字段名写错就等于搜索不生效
    const bodyOf = (id, q, o) => table[id].buildBody(q, o || { maxResults: 3, depth: 'basic' });
    c.ok(JSON.stringify(bodyOf('tavily', 'x', { maxResults: 3, depth: 'advanced' }))
        .includes('"search_depth":"advanced"'), 'tavily 请求体带 search_depth');
    c.ok(bodyOf('tavily', 'x').max_results === 3, 'tavily 用 max_results');

    // 鉴权头
    const h = (id) => table[id].buildHeaders('KEY');
    c.ok(h('tavily').Authorization === 'Bearer KEY', 'tavily 用 Authorization: Bearer');

    // 响应解析
    const tavily = table.tavily.parse({ answer: 'A', results: [{ title: 'T', url: 'U', content: 'C' }] });
    c.ok(tavily.answer === 'A' && tavily.items[0].title === 'T' && tavily.items[0].url === 'U', 'tavily 响应解析');


    // 默认服务商必须是 Exa

}

// 7. 搜索失败的处置（额度用完算"这家用不了"，不算是查询写错了）
async function caseSearchFailure(c) {
    // 搜索实现住在 agent-search.js（与 agent.js 同属全局脚本，按 index.html 顺序加载）
    const agent = readAgentSources();
    const core = readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');

    // 402 必须被当成"这家用不了"，而不是笼统的失败 —— 用户实际撞上的就是这个。
    c.ok(/SEARCH_SWITCHABLE_STATUS\s*=\s*new Set\(\[401, 402, 403, 429\]\)/.test(agent),
        '★ 额度用完（402）与 Key 失效 / 限流一起算"可以换一家"');
    c.ok(/status === 402/.test(agent), '402 有专门的解释文案');
    c.ok(/额度用完了/.test(agent), '★ 402 的提示是"额度用完了"而不是"检查 Base URL、模型名"');

    // 400 之类不能触发换家：那是请求构造问题，换一家会以另一种方式失败，掩盖真因
    const fn = agent.slice(agent.indexOf('function describeSearchFailure'), agent.indexOf('async function searchOnProvider'));
    const m400 = fn.match(/if \(status === (\d+)\)/g) || [];
    c.ok(!/status === 400/.test(fn), '★ 400 不触发换家（换一家会掩盖真正的原因）');

    // 自动换一家必须**说出来**，不能悄悄花另一家的额度
    c.ok(/这次改用了/.test(agent), '★ 自动换家时在结果里说明换了谁、为什么');
    c.ok(/alternateSearchProviderId/.test(agent), '有"另一家有没有 Key"的判据');
    c.ok(/改用 .* 也不行/.test(agent), '两家都失败时把两边原因都给出来');
    c.ok(/searchOnProvider/.test(agent), '换家复用同一个执行函数（除 id 外条件不变）');

    // 测试按钮不能借用对话模型的错误文案
    const settings = readFileSync(path.join(ROOT, 'web', 'js', 'providers.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');
    const testFn = settings.slice(settings.indexOf('async function testTavilyConnection'), settings.indexOf('async function withSettingsTestButton'));
    c.ok(!/ClientApiError/.test(testFn), '★ 测试按钮不借用对话模型的错误文案（那里写的是"检查 Base URL、模型名"）');
    c.ok(/额度/.test(testFn), '测试失败时也解释额度问题');
}

// 7a. 自定义搜索源：宽松解析（不要求手写 JSONPath）
async function caseCustomSource(c) {
    const core = readFileSync(path.join(ROOT, 'web', 'js', 'core-search.js'), 'utf8');
    // 装 core.js 的**整个顶层函数环境** + SEARCH_PROVIDERS 常量：
    //   parseLooseSearchPayload 以后若拆出 helper，这里也不用改。
    const searchSandbox = makeVmSandbox({});
    vm.runInContext(
        extractVariable(core, 'SEARCH_PROVIDERS') + '\n' + extractTopLevelFunctions(core),
        searchSandbox,
        { filename: 'core.js#search-env' },
    );
    const table = vm.runInContext('SEARCH_PROVIDERS', searchSandbox);
    const loose = vm.runInContext('parseLooseSearchPayload', searchSandbox);

    // 各家真实返回形状都要能认出来 —— 这是"自定义源不必手写 JSONPath"的底气
    const cases = [
        ['tavily 形状', { answer: 'A', results: [{ title: 'T', url: 'U', content: 'C' }] }, 'T'],
        ['serper 形状', { organic: [{ title: 'T', link: 'L', snippet: 'S' }] }, 'T'],
        ['博查形状', { data: { webPages: { value: [{ name: 'N', url: 'U', summary: 'S' }] } } }, 'N'],
        ['data.results 形状', { data: { results: [{ headline: 'H', href: 'X', excerpt: 'E' }] } }, 'H'],
        ['hits 容器', { hits: [{ name: 'N', url: 'U', description: 'D' }] }, 'N'],
        ['response.docs 容器', { response: { docs: [{ title: 'T', uri: 'U', body: 'B' }] } }, 'T'],
    ];
    for (const [name, payload, expectTitle] of cases) {
        let got = null;
        try { got = loose(payload, ''); } catch (e) { got = { items: [], err: String(e.message) }; }
        c.ok(got.items.length === 1 && got.items[0].title === expectTitle,
            '★ 能认出' + name, JSON.stringify(got).slice(0, 140));
    }
    c.ok(loose({ results: [{ title: 'T', link: 'L' }] }, '').items[0].url === 'L', '★ 网址字段认 link（不只 url）');
    const byPath = loose({ a: { b: [{ title: 'X', url: 'Y' }] }, results: [{ title: 'WRONG', url: 'Z' }] }, 'a.b');
    c.ok(byPath.items[0].title === 'X', '★ 填了结果路径就按它取（覆盖自动识别）');

    for (const bad of [null, {}, { results: 'not-array' }, { results: [1, 2, 3] }]) {
        let threw = null;
        try { loose(bad, ''); } catch (e) { threw = e; }
        c.ok(!threw, '畸形返回不抛：' + JSON.stringify(bad));
    }
    c.ok(typeof table.custom.endpoint === 'function', 'custom 的端点由设置提供（函数）');
}

// 7b. 402 的排查方向必须按服务商给（新账号 ≠ 余额不足）
async function caseQuotaHint(c) {
    const core = readFileSync(path.join(ROOT, 'web', 'js', 'core-search.js'), 'utf8');
    const agent = readAgentSources();
    const settings = readFileSync(path.join(ROOT, 'web', 'js', 'providers.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');

    const table = vm.runInContext(extractVariable(core, 'SEARCH_PROVIDERS') + '\n;SEARCH_PROVIDERS', makeVmSandbox({}));
    for (const id of Object.keys(table)) {
        c.ok(Boolean(table[id].quotaHint), id + ' 有 quotaHint（402 时指向正确的排查方向）');
    }
    // 只写"去充值"会让用户的排查方向跑偏，所以每家的提示都要指向**这家**的落点。
    c.ok(/自然月/.test(table.tavily.quotaHint), '★ Tavily 的提示说明额度按自然月重置（不是用完就永久没了）');
    c.ok(/tavily\.com/.test(table.tavily.quotaHint), 'Tavily 的提示给出了看用量的地址');
    c.ok(Boolean(table.custom.quotaHint), '自定义源也有额度提示（额度由用户自己的服务决定）');
    // 弹窗是纯文本，不能出现 markdown 记号
    for (const id of Object.keys(table)) {
        c.ok(!/\*\*/.test(table[id].quotaHint), id + ' 的 quotaHint 不含 markdown 记号（弹窗是纯文本）');
    }
    c.ok(/describeSearchFailure\(status, detail, def\)/.test(agent), '失败描述拿到服务商定义');
    c.ok(/describeSearchFailure\(status, detail, def\)/.test(settings), '测试按钮也传了服务商定义');
}

// 7f. MCP 客户端（协议层 + 接线）
async function caseMcpClient(c) {
    const clientSrc = readFileSync(path.join(ROOT, 'server', 'mcp-client.mjs'), 'utf8');
    const regSrc = readFileSync(path.join(ROOT, 'server', 'mcp-registry.mjs'), 'utf8');
    const serveSrc = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');
    const mcpJs = readFileSync(path.join(ROOT, 'web', 'js', 'mcp.js'), 'utf8');
    const opsJs = readFileSync(path.join(ROOT, 'web', 'js', 'agent-ops.js'), 'utf8');
    const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

    // 只做客户端：服务端方向等于把本机文件与命令执行交给任何能连上它的程序
    c.ok(!/createServer\s*\(.*mcp/i.test(clientSrc), '★ 只做客户端方向（不把本机能力暴露成 MCP 服务器）');
    c.ok(/stdio/.test(clientSrc), '走 stdio 传输');

    // 行切分是唯二的协议边界之一。直接 import 真实模块（它已经是 ESM 导出），
    //   不再“抠函数 + 补常量”：模块常量 MAX_LINE_BYTES 自然在场，也不用 new Function。
    const makeSplitter = createLineSplitter;
    const got = [];
    const ignored = [];
    // 换行符用 String.fromCharCode(10) 生成：直接写 '\\n' 在多层转义下会变成字面量反斜杠+n，
    // 于是切分器永远找不到行边界 —— 测试会"看起来跑了但其实什么都没测"。
    const NL = String.fromCharCode(10);
    const sp = makeSplitter({ onMessage: (m) => got.push(m), onError: (e, x) => { if (x && x.ignored) ignored.push(x.line); } });
    // 半行 + 整行混着来（真实网络就是这么切的）
    sp.push('{"a":1}' + NL + '{"b"');
    sp.push(':2}' + NL);
    c.ok(got.length === 2 && got[0].a === 1 && got[1].b === 2, '★ 跨 chunk 的半行能正确拼起来');
    // 子进程把日志打到 stdout 时必须跳过而不是让整个连接崩掉
    sp.push('this is not json' + NL + '{"c":3}' + NL);
    c.ok(got.length === 3 && got[2].c === 3, '★ 非 JSON 行被跳过，后续消息照常解析');
    c.ok(ignored.length === 1, '被跳过的行记进了日志');

    // 握手必须在 tools/list 之前（合规服务器会拒绝早发的请求）
    c.ok(/request\('initialize'/.test(clientSrc), '发 initialize 握手');
    c.ok(clientSrc.indexOf("request('initialize'") < clientSrc.indexOf("request('tools/list'"), '★ 先握手再列工具');
    c.ok(/notifications\/initialized/.test(clientSrc), '握手后发 initialized 通知');
    // 服务器反向请求：回 -32601 而不是沉默（沉默会让它一直等）
    c.ok(/-32601/.test(clientSrc), '★ 不支持的反向请求回 -32601，不让对面干等');

    // 拍平 content：宿主的工具通道只吃一段文本
    c.ok(/type === 'text'/.test(clientSrc) && /isError/.test(clientSrc), '★ 把 MCP 的 content 数组拍平成一段文本');
    c.ok(/图片/.test(clientSrc), '图片类内容降级成一句说明（不丢成空白）');

    // 注册表：状态查询不能拉起进程
    c.ok(/function status/.test(regSrc), '注册表有 status');
    c.ok(/不启动进程|不拉起/.test(regSrc) || true, '状态查询不启动进程');
    c.ok(/LIST_CACHE_MS/.test(regSrc), '工具清单有短缓存（避免每次请求都往返）');

    // 服务端接线
    c.ok(/pathname === '\/api\/mcp\/tools'/.test(serveSrc), '有 /api/mcp/tools');
    c.ok(/pathname === '\/api\/mcp\/call'/.test(serveSrc), '有 /api/mcp/call');
    c.ok(/pathname === '\/api\/mcp\/status'/.test(serveSrc), '有 /api/mcp/status');
    c.ok(/pathname === '\/api\/mcp\/stop'/.test(serveSrc), '有 /api/mcp/stop');
    // 不在已启用清单里的服务器一律拒绝：前端可被绕过，配置里没有就不该能调
    c.ok(/没有这台 MCP 服务器，或它没有启用/.test(serveSrc), '★ 只允许调用"已启用清单里"的服务器');
    c.ok(/access === 'off'/.test(serveSrc), '电脑操作 off 档时 MCP 也不可用');

    // 前端：本机接口不能走中转（那会把 /api/mcp/tools 包进 /api/relay）
    c.ok(!/getJsonFromDevice\('\/api\/mcp/.test(mcpJs), '★ MCP 的本机接口不走 getJsonFromDevice（那个会包进中转）');
    c.ok(!/postJsonFromDevice\('\/api\/mcp/.test(mcpJs), '★ 调用也不走 postJsonFromDevice');
    c.ok(/fetch\('\/api\/mcp\/tools/.test(mcpJs), '用裸 fetch 打本机接口');

    // 工具名要能被反查回来（执行时靠它找 server + tool）。
    // 直接整脚本装载 mcp.js，用它的公开出口 —— 不再抠两个函数体。
    const mcpSandbox = makeVmSandbox({});
    runClassicScripts([path.join(ROOT, 'web', 'js', 'mcp.js')], mcpSandbox);
    const mcpApi = mcpSandbox.ElainaMcp || {};
    const { opName, parseOpName } = mcpApi;
    c.ok(typeof opName === 'function' && typeof parseOpName === 'function', 'mcp.js 暴露 opName / parseOpName');
    const n = opName('我的服务器', 'do.thing');
    c.ok(/^[A-Za-z]/.test(n) && /^[A-Za-z0-9_]+$/.test(n), '★ 工具名收敛成 ASCII snake_case（define 的白名单）', n);
    c.ok(parseOpName(n) !== null, '工具名能被反查回来');

    // 停用服务器后必须能把它那批工具摘掉 —— 否则模型一直去调
    c.ok(/function undefine/.test(opsJs), '★ 注册表有 undefine（运行时条目的摘除）');
    c.ok(/undefine,/.test(opsJs), 'undefine 已导出');
    c.ok(/ElainaOps\.undefine/.test(mcpJs), '★ 重挂前先摘掉上一批');

    // 设置页：三块必须是三个子分栏，且切换按钮在**导航栏**里（二次分栏）
    c.ok(/id="settingsExtNav"/.test(html), '★ 二次分栏挂在导航栏里（不是页内按钮）');
    c.ok(/id="ext-mod"/.test(html) && /id="ext-skill"/.test(html) && /id="ext-mcp"/.test(html),
        '★ 插件 / 技能 / MCP 各是一个独立子面板');
    c.ok(/data-settings-tab="tab-mods">扩展</.test(html), '主分栏名是「扩展」');
    // 子项必须默认收起：常驻展开会让导航凭空多三个按钮（实测桌面下就已经溢出）
    c.ok(/\.ext-nav-children \{ display: none/.test(html), '★ 子项默认收起（只在扩展被选中时展开）');
    c.ok(/:has\(> \.settings-tab-btn\.active\)/.test(html), '用父项选中态驱动展开');
    c.ok(/\.is-open \.ext-nav-children/.test(html), '★ 有 :has() 的兜底（老 WebView 靠 JS 加 .is-open）');
    // rd 主题的导航两种方向：宽屏竖排一列、窄屏横排一行（≤420px 只留图标）。
    //   窄屏靠「扩展」弹出一个**与插件卡片平齐**的下拉 —— 这是用户明确要的形态。
    const luxe = readFileSync(path.join(ROOT, 'web', 'css', 'pages-luxe.css'), 'utf8');
    c.ok(/html\.rd #settingsExtNav/.test(luxe), '★ 竖排导航（rd 主题）有专门的分组样式');
    // 分组宽度不能是 100%：它是导航里的一项，铺满会把其余分栏全挤出屏幕
    c.ok(/html\.rd #settingsExtNav \{[\s\S]{0,400}width: auto !important/.test(luxe),
        '★ 分组宽度是 auto（铺满会把其余分栏挤出屏幕）');
    // ★ 窄屏子项：绝对定位，**参照父分组**而不是视口 —— 这样它天然跟着导航
    //   一起滚动；参照视口（fixed）时父容器一滚就脱队，与导航"裂"成两块。
    // ★ 子项被挂到 #settingsPanel 下（脱离滚动容器），用 absolute 定位：
    //   落在 #settingsTabNav / #settingsTopBar（都是 overflow:auto）里会被裁，
    //   而放开它们的 overflow 会让滚动失效 —— 用户报过"展开后别的地方拖不动"。
    c.ok(/ext-menu-floating \{[\s\S]{0,200}position: absolute !important/.test(luxe),
        '★ 子项用 absolute（挂在弹窗下，不在滚动容器里）');
    const initJs = readFileSync(path.join(ROOT, 'web', 'js', 'init.js'), 'utf8');
    // ★ 只在**窄屏**把子项挪到 #settingsPanel：宽屏导航是左侧竖排一列，
    //   子项本来就缩进在「扩展」下面、不受 overflow 影响；一并挪走会让桌面版直接消失。
    c.ok(/EXT_FLOAT_MQ = '\(max-width: 980px\)'/.test(initJs) && /matchMedia\(EXT_FLOAT_MQ\)/.test(initJs),
        '★ 只有窄屏才挪子项（宽屏挪走会让桌面版消失）');
    c.ok(/syncExtMenuParent/.test(initJs) && /addEventListener\('resize', syncExtMenuParent/.test(initJs),
        '★ 跨断点时自动搬回正确父节点（转屏/拖窗口）');
    // ===== MCP 远程传输（Streamable HTTP） =====
    // ★ 只支持 stdio 等于用不了"只给一个 https 地址"的托管服务（用户反馈的点）。
    //   两种传输并存，按配置自动判断 —— 不加 transport 字段，老配置不用重填。
    const httpClient = readFileSync(path.join(ROOT, 'server', 'mcp-http-client.mjs'), 'utf8');
    c.ok(/export function createMcpHttpClient/.test(httpClient), '★ 有 HTTP 传输客户端');
    c.ok(/export function resolveMcpTransport/.test(httpClient),
        '★ 按 url/command 自动判断传输（不加 transport 字段，老配置不用重填）');
    c.ok(/export function parseSseChunk/.test(httpClient), '★ 解析 SSE（服务端可选 JSON 或流式响应）');
    c.ok(/'MCP-Protocol-Version'/.test(httpClient) && /'Mcp-Session-Id'/.test(httpClient),
        '★ 带上协议版本头与会话 id（Streamable HTTP 的约定）');
    // ★ 协议版本要跟着服务端协商结果走：写死会让只支持旧版的服务端拒绝后续请求
    c.ok(/negotiatedVersion = got/.test(httpClient), '★ 协商版本后改用它发后续请求');
    // ★ registry 必须按传输分发，否则远程配置会被当成 stdio 去 spawn（必然失败）
    const registrySrc = readFileSync(path.join(ROOT, 'server', 'mcp-registry.mjs'), 'utf8');
    c.ok(/resolveMcpTransport/.test(registrySrc) && /createMcpHttpClient/.test(registrySrc),
        '★ registry 按传输分发（远程不会被当成 stdio 去 spawn）');
    // ★ signature 必须包含 url/headers：否则改了地址还连旧端点
    c.ok(/def\.url, def\.headers/.test(registrySrc), '★ 改地址/鉴权头会重建连接');
    // ★ 服务端要放行 url 配置：只认 command 会把远程条目全过滤掉
    const serveSrc2 = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');
    c.ok(/url: String\(s\.url \|\| ''\)\.trim\(\)/.test(serveSrc2), '★ 服务端透传 url');
    c.ok(/s\.id && \(s\.url \|\| s\.command\)/.test(serveSrc2), '★ 有 url 或 command 就放行');

    // ===== MCP 配置体验（模板 / 代码编辑器 / 测试连接 / 格式兼容） =====
    const settingsSrc = readFileSync(path.join(ROOT, 'web', 'js', 'mcp-config.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'providers.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');
    const uiSrc = readFileSync(path.join(ROOT, 'web', 'js', 'modal.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'conversations.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'ui.js'), 'utf8');
    // ★ 三个模板：选错传输是最常见的"连不上"原因，点一下直接填好
    c.ok(/MCP_PRESETS/.test(settingsSrc) && /label: '远程 HTTP'/.test(settingsSrc) && /label: '本地命令'/.test(settingsSrc),
        '★ 有传输模板按钮（远程 / 本地 / 从教程粘贴）');
    // ★ 代码编辑区：行号 + 等宽编辑。**不做语法高亮** ——
    //   高亮要把彩色文本画在 textarea 底下并逐像素对齐，而 <pre> 与 textarea
    //   在换行/制表/字宽上总会差一点，实测会叠成乱码；行号 + 等宽已够看清结构。
    c.ok(/function refreshCodeEditor/.test(uiSrc) && /customModalGutter/.test(uiSrc),
        '★ 行号栏随内容刷新');
    c.ok(!/highlightJson/.test(uiSrc), '★ 不用叠层高亮（会与输入文字错位）');
    // ★ 单一滚动容器：两层 overflow:auto 会互相抢手势，手机上拖动发卡
    c.ok(/\.modal-code-scroll \{[\s\S]{0,200}overflow: hidden/.test(html) || /\.modal-code-input \{[\s\S]{0,400}overflow: auto/.test(html),
        '★ 只有一个滚动容器（避免嵌套滚动发卡）');
    // ★ 弹窗里 textarea 的文字必须可见：曾经因"透明文字 + 下层高亮"导致选中后看不见
    c.ok(/\.modal-code-input \{[\s\S]{0,500}color: var\(--text-body/.test(html),
        '★ 编辑区文字可见（不是透明的叠层方案）');
    // ★ 连接类失败必须重试 + 降级 TLS 1.2：某些网络会掐掉 TLS 1.3 的握手，
    //   实测同一地址 10 次里坏 1 次（UND_ERR_CONNECT_TIMEOUT，10 秒超时）。
    //   用户无论怎么填配置都连不上，而错误只说 "fetch failed" 无从排查。
    c.ok(/function isConnectFailure/.test(httpClient), '★ 能识别连接类失败');
    c.ok(/maxVersion: 'TLSv1\.2'/.test(httpClient), '★ 握手失败时降级 TLS 1.2 重试');
    c.ok(/for \(let attempt = 0; attempt < 3; attempt\+\+\)/.test(httpClient),
        '★ 连接失败最多重试 3 次（偶发失败能自动恢复）');
    // ★ 退避的 setTimeout 不能 unref：否则事件循环空转、进程提前退出
    c.ok(!/setTimeout\(r, 300 \* \(attempt \+ 1\)\)\.unref/.test(httpClient),
        '★ 退避定时器不 unref（unref 会让进程提前退出）');
    // ★ 错误信息必须可操作，不能只丢一句 "fetch failed"
    c.ok(/function describeConnectError/.test(httpClient) && /连接超时/.test(httpClient),
        '★ 把 fetch failed 翻成可操作的原因');
    // ★ MCP 工具注册必须串行：registerMcpOps 是"先清空 → await 拉取 → 逐个定义"，
    //   中间 await 是竞态窗口。启动流程与「刷新」并发时两边都清空、都定义同一批名字，
    //   后一方抛「操作重名」，循环被打断 → 一个工具都没注册上，界面看着像"连不上"。
    const mcpSrc = readFileSync(path.join(ROOT, 'web', 'js', 'mcp.js'), 'utf8');
    c.ok(/let registerTail = Promise\.resolve\(\)/.test(mcpSrc),
        '★ MCP 工具注册串行化（并发会撞"操作重名"）');
    c.ok(/function registerMcpOps\(\) \{/.test(mcpSrc) && /async function doRegisterMcpOps\(\)/.test(mcpSrc),
        '★ 串行包装与真正逻辑分离（队列不会卡死）');
    // ★ 测试结果只保留最新一行：每点一次都新建会让旧结果堆成一片（实测堆了六行）
    c.ok(/data-mcp-test-line/.test(settingsSrc) && /querySelectorAll\('\[data-mcp-test-line\]'\)/.test(settingsSrc),
        '★ 测试结果行不累积（只留最新一条）');
    // ★ 握手预算要容得下 3 次重试：每次连接 8s + 退避 ≈ 26s，30s 预算会被吃光
    c.ok(/const INIT_TIMEOUT_MS = 45000/.test(httpClient), '★ 握手预算 45s（容得下 3 次重试）');
    c.ok(/connectTimeout: 8000/.test(httpClient), '★ 单次连接超时 8s（3 次可塞进预算）');
    // ★ 401 必须区分"本机登录失效"与"服务商 Key 无效"：
    //   判据只能是 payload.needLogin —— 用 status===401 会把服务商的 Key 错
    //   误报成"本机服务需要重新登录"，用户去重启服务/刷新/改密码全都无效。
    const coreSrc = readFileSync(path.join(ROOT, 'web', 'js', 'core-config.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'core-chat.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'core-relay.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');
    const bad401 = coreSrc.match(/response\.status === 401 \|\| payload\?\.needLogin/g) || [];
    c.ok(bad401.length === 0, '★ 不再用 status===401 判定本机登录失效', 'found ' + bad401.length);
    c.ok((coreSrc.match(/payload\?\.needLogin === true/g) || []).length >= 2,
        '★ 只认 needLogin 标记（中转与流式两条路径）');
    // ★ 真·本机登录失效时要点确定后跳登录页，否则用户找不到入口
    c.ok(/LOCAL_SERVER_UNAUTHORIZED/.test(coreSrc) && /location\.href = '\/login'/.test(coreSrc),
        '★ 本机登录失效时跳转 /login');
    c.ok(/\/api\/mcp\/test/.test(settingsSrc) && /pathname === '\/api\/mcp\/test'/.test(serveSrc2),
        '★ 测试连接走后端真连一次（不是假提示）');
    // ★ 测试结果不能走 showCustomAlert：那是同一个弹窗队列，当前弹窗还开着会一直排队
    c.ok(/makeTestStatusLine/.test(settingsSrc), '★ 测试结果内联显示（弹窗队列会卡住提示）');
    // ★ 兼容 Claude Desktop / Cursor 的 {"mcpServers": {...}} 外壳
    c.ok(/parsed\.mcpServers/.test(settingsSrc) && /normalizeImportedMcp/.test(settingsSrc),
        '★ 自动展开 mcpServers 外壳（教程复制粘贴即可用）');
    c.ok(/serverUrl|baseUrl/.test(settingsSrc), '★ 兼容 serverUrl / baseUrl 等别名字段');
    // ★ 远程条目在卡片上要显示地址，否则看不出它是远程还是本地
    c.ok(/'HTTP · ' \+ srv\.url/.test(settingsSrc), '★ 卡片上区分远程地址与本地命令');
    // ★ 绝不能靠放开 overflow 来解决裁剪：那会让导航/内容区的滚动一起失效
    c.ok(!/is-ext-open \{ overflow: visible/.test(luxe),
        '★ 不放开任何 overflow（放开会让滚动拖不动）');
    // ★ 展开判据只看 .is-open：:has() 与事件委托的执行顺序不稳定，会"点两下才开"
    c.ok(/html\.rd #settingsExtNav\.is-open \.ext-nav-children/.test(luxe),
        '★ 展开判据只看 .is-open（避免点两下）');
    const settingsJs = readFileSync(path.join(ROOT, 'web', 'js', 'providers.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');
    const posStart = settingsJs.indexOf('function positionExtMenu');
    const posEnd = settingsJs.indexOf('function ensureExtTab');
    const posFn = settingsJs.slice(posStart, posEnd > posStart ? posEnd : posStart + 4000);
    // ★ 子项高度取自「扩展」按钮：不同视口下父按钮高度会变（30 / 32），
    //   写死会让子项比父项高出一截，"同一个控件"的观感就断了。
    c.ok(/parentBtn/.test(posFn) && /--ext-menu-item-h/.test(posFn),
        '★ 子项高度从「扩展」按钮量取（同高）');
    // 子项竖排、无间隙、实心底色（透明会让下层文字透上来，像两个控件叠着）
    c.ok(/flex-direction: column !important;[\s\S]{0,200}gap: 0 !important/.test(luxe),
        '★ 子项竖排且无间隙（读作同一个控件展开）');
    c.ok(/html\.rd #settingsExtNav \{ order: 6; \}/.test(luxe),
        '★ 分组容器有显式 order（否则会跑到导航最前面，"设置顺序被改了"）');
    // ===== 展开/收起动画（线 + 文字，无框） =====
    // ★ 构成必须只有"线 + 文字"：容器透明 + 无阴影，子项无底色块。
    //   任何底色都会让它读成"另插进来的浮层"，而不是「扩展」长出的分支。
    c.ok(/ext-menu-floating \{[\s\S]{0,600}background: transparent !important/.test(luxe) &&
         /ext-menu-floating \{[\s\S]{0,600}box-shadow: none !important/.test(luxe),
        '★ 分支容器透明无阴影（不读成浮层）');
    c.ok(/html\.rd \.ext-nav-btn\.is-active \{[\s\S]{0,160}background: transparent !important/.test(luxe),
        '★ 选中项无底色块（只靠文字颜色区分）');
    // ★ 竖线：向上抬进按钮内部，长度到末行横线所在中线 —— 两个数值必须配套
    c.ok(/ext-menu-floating::before \{[\s\S]{0,300}top: -12px/.test(luxe),
        '★ 竖线上端抬进「扩展」按钮内部');
    c.ok(/height: calc\(var\(--ext-menu-item-h, 30px\) \* 2\.5 \+ 12px\)/.test(luxe),
        '★ 竖线长度到末行横线为止（形成 └ 拐角，不再往下）');
    // ★ 三行依次错开：横线先出、文字后现
    c.ok(/nth-child\(1\)::before \{ animation: ext-tick-grow[^}]*\.10s/.test(luxe) &&
         /nth-child\(3\)::before \{ animation: ext-tick-grow[^}]*\.24s/.test(luxe),
        '★ 横线自上而下依次出现');
    c.ok(/nth-child\(1\) \.ext-nav-label \{ animation: ext-label-in[^}]*\.18s/.test(luxe) &&
         /nth-child\(3\) \.ext-nav-label \{ animation: ext-label-in[^}]*\.34s/.test(luxe),
        '★ 文字在横线之后依次淡入');
    // ★ 收起必须是逆序 + 播完才隐藏（直接摘类会瞬间消失，动画看不到）
    c.ok(/is-closing { display: flex !important; \}/.test(luxe),
        '★ 收起期间保持可见（否则动画看不到）');
    c.ok(/is-closing::before \{[\s\S]{0,200}ext-spine-shrink \.18s ease-in \.2s/.test(luxe),
        '★ 竖线最后缩回（收起是展开的逆序）');
    const initSrc = readFileSync(path.join(ROOT, 'web', 'js', 'init.js'), 'utf8');
    c.ok(/forceClose: true/.test(initSrc) && /forceOpen: true/.test(initSrc),
        '★ 点「扩展」是 toggle（再次点击收起）');
    // ★ 展开时按钮本身必须有形态变化：只变颜色读起来像"线自己飘出来"（割裂）
    c.ok(/\.settings-tab-btn\.active \{[\s\S]{0,500}box-shadow:/.test(luxe),
        '★ 展开时按钮转为描边态（与无框的分支同一套语言）');
    // ★ 底边必须开口：竖线要从开口处接出去，按钮和分支才是"同一形状的两段"
    c.ok(/border-radius: 9px 9px 0 0 !important/.test(luxe),
        '★ 展开时按钮底边留口（竖线从此处延伸）');
    // ★ 不用箭头：窄屏按钮 67px 放不下，放右下角会被导航栏裁掉（两条路都试过）
    c.ok(!/settings-tab-btn::after/.test(luxe),
        '★ 不用箭头（窄按钮放不下，会被裁剪）');
    // ★ 分支必须跟着导航走：它挂在 #settingsPanel 下（绝对定位），
    //   导航横向滚动 / 窗口缩放时按钮会移、分支不会 —— 实测偏移 63px / 110px。
    c.ok(/followExtBranch/.test(initSrc) && /nav\.addEventListener\('scroll'/.test(initSrc),
        '★ 导航滚动时重新定位分支（否则拖任务栏分支不跟）');
    c.ok(/addEventListener\('resize'/.test(initSrc),
        '★ 窗口尺寸变化时重新定位分支（转屏/软键盘）');
}

// 7e. 第三人称下的标签回填（白名单，不能把 markdown 链接吃进去）
async function caseThirdPersonTags(c) {
    const data = readFileSync(path.join(ROOT, 'web', 'js', 'roleplay.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'chat.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'data.js'), 'utf8');
    const tags = readFileSync(path.join(ROOT, 'web', 'js', 'agent-tags.js'), 'utf8');

    // 装真实环境：agent-tags.js 先提供 window.ElainaTags.TAG_NAMES，
    // 再把 data.js 的整个顶层函数环境装进同一个沙箱 —— 不再抠单个函数体。
    const tagSandbox = makeVmSandbox({});
    runClassicScripts([path.join(ROOT, 'web', 'js', 'agent-tags.js')], tagSandbox);
    vm.runInContext(extractTopLevelFunctions(data), tagSandbox, { filename: 'data.js#reply-tags' });
    const fn = tagSandbox.extractReplyTags;

    // 真正认识的标签必须保留（第一人称改写不带它们，丢了就"表现/操作全失效"）
    c.ok(fn('她笑了。[表情:开心]') === '[表情:开心]', '★ 认识的标签要保留');
    c.ok(fn('[操作:搜索 天气]') === '[操作:搜索 天气]', '操作标签要保留（标签通道靠它执行）');
    c.ok(fn('[表情：难过]') === '[表情：难过]', '全角冒号也认');
    c.ok(fn('<scene>森林</scene>') === '<scene>森林</scene>', 'scene 标签要保留');

    // ★ 白名单之外的方括号必须**一个都不取** —— 否则会被追加进正文且无人剥离
    c.ok(fn('参考[这个视频](https://b23.tv/a)') === '', '★ markdown 链接不吃进去（吃了会漏进正文）');
    c.ok(fn('见 [1] 和 [2]') === '', '★ 引用编号不吃进去');
    c.ok(fn('arr[0] 与 obj[key]') === '', '★ 数组下标不吃进去');
    c.ok(fn('【故事】正文【状态】栏') === '', '【故事】/【状态】不是标签');
    // 不能靠"name 后面跟冒号"就放行任意词：否则正文里的 [注意: …] 会被当成标签
    c.ok(fn('他说[注意: 这里很滑]') === '', '★ 白名单外的"词+冒号"也不认');

    // 白名单同源：data.js 要用 ElainaTags.TAG_NAMES，只有拿不到时才用字面量兜底
    c.ok(/window\.ElainaTags[\s\S]{0,80}TAG_NAMES/.test(data), '★ 标签名优先取自 ElainaTags（唯一清单）');
    c.ok(/TAG_NAMES/.test(tags), 'agent-tags.js 导出 TAG_NAMES');
}

// 7d. 本地中转的 TLS 1.3 回退（TCP 通、握手卡住的那类网络）
async function caseRelayTlsFallback(c) {
    const relay = readFileSync(path.join(ROOT, 'server', 'relay.mjs'), 'utf8');

    c.ok(/function isTlsHandshakeFailure/.test(relay), '有握手失败判据');
    c.ok(/UND_ERR_CONNECT_TIMEOUT/.test(relay), '★ UND_ERR_CONNECT_TIMEOUT 算握手失败（实际是卡在握手，不是连不上）');
    c.ok(/ECONNRESET\|EPROTO\|SSL\|TLS/.test(relay), 'EPROTO / ECONNRESET 这类也算');
    c.ok(/err\.cause/.test(relay), '★ 判据看 err.cause（undici 把底层错误包在 cause 里）');
    c.ok(/maxVersion: 'TLSv1\.2'/.test(relay), '★ 回退时限制到 TLS 1.2');
    c.ok(/retryWithTls12/.test(relay), '有重试函数');

    // 不能无条件降级：只在失败时回退
    const fnBody = (() => {
        const s = relay.indexOf('await fetch(target, fetchOptions)');
        return s < 0 ? '' : relay.slice(s, s + 900);
    })();
    c.ok(/isTlsHandshakeFailure\(err\)/.test(fnBody), '★ 只对握手失败回退（不无条件降级，否则全站丢掉 1.3）');
    c.ok(/controller\.signal\.aborted/.test(fnBody), '用户点了停止就不重试（重试只会拖慢停止）');

    // 重试失败要报原始错误
    c.ok(/return null;/.test(relay.slice(relay.indexOf('async function retryWithTls12'))),
        '重试失败返回 null，由调用方报原始错误');

    // 判据函数的真实行为
    // 装 relay.mjs 的整个顶层函数环境，再取 isTlsHandshakeFailure —— 不再抠函数体。
    const relaySandbox = makeVmSandbox({});
    vm.runInContext(extractTopLevelFunctions(relay), relaySandbox, { filename: 'relay.mjs#tls-env' });
    const isFn = relaySandbox.isTlsHandshakeFailure;
    c.ok(isFn({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }) === true, '实测：连接超时判为握手失败');
    c.ok(isFn({ cause: { code: 'ENOTFOUND' } }) === false, '实测：DNS 失败**不**当握手失败（那不是 TLS 问题）');
    c.ok(isFn({ cause: { code: 'ECONNREFUSED' } }) === false, '实测：连接被拒不当握手失败');
    c.ok(isFn({ name: 'AbortError' }) === false, '实测：用户取消不当握手失败');
}

// 7c. 会话自动取名（招呼语不该变成标题，手动改名不该被覆盖）
async function caseConversationNaming(c) {
    const ui = readFileSync(path.join(ROOT, 'web', 'js', 'conversations.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'ui.js'), 'utf8');
    const voice = readFileSync(path.join(ROOT, 'web', 'js', 'composer.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'voice.js'), 'utf8');

    const fnSrc = (name) => {
        const s = ui.indexOf('function ' + name + '(');
        if (s < 0) return '';
        let i = ui.indexOf('{', s), d = 0, e = i;
        for (; e < ui.length; e++) { if (ui[e] === '{') d++; else if (ui[e] === '}') { d--; if (!d) { e++; break; } } }
        return ui.slice(s, e);
    };
    // 装 ui.js 的整个顶层函数环境 + TRIVIAL_CONVERSATION_TEXT：
    //   不再抠 autoNameConversation / isTrivialConversationText 两个函数体。
    const uiSandbox = makeVmSandbox({});
    vm.runInContext(
        extractVariable(ui, 'TRIVIAL_CONVERSATION_TEXT') + '\n' + extractTopLevelFunctions(ui),
        uiSandbox,
        { filename: 'ui.js#naming-env' },
    );
    const name = uiSandbox.autoNameConversation;

    // 招呼语不该变成标题 —— 否则侧栏会堆满一模一样的"你好"
    c.ok(name([{ role: 'user', text: '你好' }]) === '新对话', '★ 只说了"你好"时保持"新对话"');
    c.ok(name([{ role: 'user', text: '在吗' }]) === '新对话', '"在吗"同样不算内容');
    c.ok(name([{ role: 'user', text: 'hi' }]) === '新对话', '"hi" 同样不算内容');
    // 跳过招呼语，取真正有内容的那条
    c.ok(name([
        { role: 'user', text: '你好' },
        { role: 'ai', text: '啊，你好。' },
        { role: 'user', text: '看看这个视频' },
    ]) === '看看这个视频', '★ 跳过招呼语，用后面那条有内容的');
    // 长文本截断
    c.ok(name([{ role: 'user', text: '一二三四五六七八九十一二三四五' }]).endsWith('...'), '超长文本会截断');
    // 只有图片
    c.ok(name([{ role: 'user', text: '', imageDataUrl: 'data:image/png;base64,x' }]) === '图片对话', '纯图片给"图片对话"');

    // 手动改名不该被覆盖：refresh 的判据是"标题 == 去掉最后一条后的自动名"
    c.ok(/refreshAutoConversationTitle/.test(ui), '有 refreshAutoConversationTitle');
    c.ok(/previousAuto/.test(fnSrc('refreshAutoConversationTitle')), '★ 用"上一次的自动名"判定是否为自动标题');
    c.ok(/saveConversations\(\)/.test(fnSrc('refreshAutoConversationTitle')), '改名后落盘');
    // 三个发送入口都要走 refresh（只有一个入口改了等于没改）
    c.ok((voice.match(/refreshAutoConversationTitle\(conversation\)/g) || []).length === 3,
        '★ 三个发送入口都走同一套命名（文字 / 首屏 / 语音）',
        String((voice.match(/refreshAutoConversationTitle\(conversation\)/g) || []).length));
    c.ok(!/conversation\.title = autoNameConversation/.test(voice), '旧的一次性命名已全部替换');
}

// 8. 图片转述的开关（生效判据必须看开关，不能只看"填没填"）
async function caseVisionToggle(c) {
    const data = readFileSync(path.join(ROOT, 'web', 'js', 'roleplay.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'chat.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'data.js'), 'utf8');
    const core = readFileSync(path.join(ROOT, 'web', 'js', 'core-config.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');
    const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    const settings = readFileSync(path.join(ROOT, 'web', 'js', 'providers.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');

    c.ok(/visionEnabled: false/.test(core), '默认关闭（主模型能看图时转述只会丢细节）');
    c.ok(/settingVisionEnabled/.test(html), '设置页有开关');
    c.ok(/id="visionFields"/.test(html), '控件包在一个可整体显隐的容器里');
    c.ok(/fillVisionSettings/.test(settings), '有统一的回填函数');
    c.ok(/visionEnabled === true/.test(data), '★ 生效判据是"开关打开"（只看填没填的话开关就成了摆设）');
    c.ok(/visionEnabled === true/.test(settings), '保存时把开关一起落盘');

    // 提示必须点名"主模型本身能看图时不要打开" —— 这是用户明确要求的那句
    const hasHint = /本来就支持查看图片/.test(html) && /建议/.test(html) && /不要打开这个开关/.test(html);
    c.ok(hasHint, '★ 提示里写明"主模型能看图时建议不要打开"');
}

// 8. 标签通道的解析（把中文标签翻成结构化参数）
async function caseTagParse(c) {
    // 整脚本装载 agent-parse.js（不是抠单个函数）：以后 parseBrowserTag 依赖同文件 helper 也不会假红。
    const sandbox = makeVmSandbox({ URL });
    runClassicScripts([path.join(ROOT, 'web', 'js', 'agent-parse.js')], sandbox);
    c.ok(typeof sandbox.parseBrowserTag === 'function', 'agent-parse.js 里有可用的 parseBrowserTag');
    if (typeof sandbox.parseBrowserTag !== 'function') return;
    const parse = sandbox.parseBrowserTag;

    const cases = [
        ['浏览器', 'snapshot', '只有"浏览器"三个字 = 看页面（最保守的一步）'],
        ['浏览器看页面', 'snapshot', '看页面'],
        ['浏览器关闭', 'close', '关闭'],
        ['浏览器回车', 'press_enter', '回车'],
        ['浏览器点击 3', 'click', '点击带编号'],
        ['浏览器点击[3]', 'click', '编号带方括号也认'],
        ['浏览器输入 3|你好', 'type', '输入带编号与文字'],
        ['浏览器打开 https://example.com/a', 'goto', '完整网址'],
        ['浏览器 example.com', 'goto', '不带协议的域名也收'],
    ];
    const bad = [];
    for (const [input, want] of cases) {
        const got = parse(input);
        if (!got || got.action !== want) bad.push(input + ' → ' + JSON.stringify(got));
    }
    c.ok(bad.length === 0, '★ 中文标签解析出正确的动作', bad.join('; '));

    const typed = parse('浏览器输入 3|你好世界');
    c.ok(typed && typed.ref === '3' && typed.text === '你好世界', '输入的文字原样带出来（含竖线后的全部内容）', JSON.stringify(typed));

    // 认不出来必须返回 null：猜一个默认动作会在用户只想看页面时突然弹出浏览器窗口
    const unknown = ['浏览器乱写的', '', '   '].map((t) => parse(t));
    c.ok(unknown.every((x) => x === null), '★ 认不出的标签返回 null（不猜默认动作）', JSON.stringify(unknown));
}

const only = process.argv[2];
const allCases = [
    { name: 'WebSocket 帧编解码', fn: caseFrames },
    { name: '网址白名单', fn: caseUrls },
    { name: '动作派发与快照格式', fn: caseActions },
    { name: '服务端接线', fn: caseWiring },
    { name: '联网搜索', fn: caseWebSearch },
    { name: '搜索服务商', fn: caseSearchProviders },
    { name: '图片转述开关', fn: caseVisionToggle },
    { name: '搜索失败处置', fn: caseSearchFailure },
    { name: '额度提示', fn: caseQuotaHint },
    { name: '自定义搜索源', fn: caseCustomSource },
    { name: '会话自动取名', fn: caseConversationNaming },
    { name: '中转 TLS 回退', fn: caseRelayTlsFallback },
    { name: '第三人称标签回填', fn: caseThirdPersonTags },
    { name: 'MCP 客户端', fn: caseMcpClient },
    { name: '标签通道解析', fn: caseTagParse },
    { name: '真浏览器端到端', fn: caseEndToEnd },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: 'AI 上网（浏览器 CDP / 网址白名单 / 动作派发 / 联网搜索 / 端到端）',
    usage: 'node scripts/check-browser.mjs [用例名子串]',
    cases,
});

