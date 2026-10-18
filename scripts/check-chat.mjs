// 对话与模型的回归检查：请求格式适配器、Anthropic 请求形状、模型列表、
// 思考参数的网关兼容、system 消息合并、授权三档 + 停止按钮。
//
// 合并自六个脚本（check-chat-providers / check-anthropic-request /
// check-model-list / check-thinking-compat / check-chat-message-shape /
// check-chat-stop-and-edge-tts）。它们测的是同一条「用户点发送 → 请求出去 →
// 回复显示」链路上的不同环节：前四个都在 web/js/chat-providers.js 与
// index.html 的真实函数体上跑假网络出口，拆成六个文件时各自重抄一遍
// 「抠函数 / 加载 chat-providers.js / 造假依赖」的样板和一份 pass/fail 汇总，
// 而且同名顶层变量（ROOT / html / extractFn）在同一个模块里会互相踩。
//
// 每段用例在自己的函数作用域里跑，共用文件顶层的 extractFnFrom / extractClassFrom /
// extractNumberConstFrom，断言经 c.ok 记账，失败信息形如
// 「对话 API 格式适配器 :: openai: 端点是 /chat/completions」。
//
// 用法：node scripts/check-chat.mjs            跑全部
//       node scripts/check-chat.mjs 模型列表   只跑名字含该子串的用例

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { readFrontend } from './frontend-sources.mjs';
import { runChecks, ROOT, wait, freePort } from './check-harness.mjs';

const PROVIDERS_FILE = path.join(ROOT, 'web', 'js', 'chat-providers.js');

// ────────────────────────────────────────────────────────────
// 共用工具：从真实源码里抠函数 / 类 / 数字常量。
//
// 为什么抠而不是复制：断言的是"被测代码自己算出来的东西"，
// 抄一份到测试里就等于自己测自己，实现改了测试也照样绿。
// ────────────────────────────────────────────────────────────

/**
 * 按函数名抠出完整函数声明（花括号配对）；`async` 前缀必须一起带上，
 * 否则里面的 await 会语法错误。
 *
 * 先跳过参数表：`opts = {}` 这类默认值里就有大括号，直接找第一个 `{`
 * 会把它当成函数体开头 —— 抠出来是半截函数，报错还是莫名其妙的语法错误。
 */
function extractFnFrom(html, name) {
    let start = html.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('在 web/index.html 里找不到函数: ' + name + '（重命名了？请同步更新本检查）');
    const asyncMatch = html.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (asyncMatch) start -= asyncMatch[0].length;
    let i = html.indexOf('(', start);
    let paren = 0;
    for (; i < html.length; i++) {
        if (html[i] === '(') paren++;
        else if (html[i] === ')') { paren--; if (paren === 0) { i++; break; } }
    }
    let depth = 0;
    i = html.indexOf('{', i);
    for (; i < html.length; i++) {
        const c = html[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return html.slice(start, i);
}

/** 抠一个 class 声明（大括号配平） */
function extractClassFrom(html, name) {
    const start = html.indexOf('class ' + name + ' ');
    if (start < 0) throw new Error('在 web/index.html 里找不到类: ' + name + '（重命名了？请同步更新本检查）');
    let depth = 0;
    let i = html.indexOf('{', start);
    for (; i < html.length; i++) {
        const c = html[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return html.slice(start, i);
}

/** 抠一个数字常量（形如 `const NAME = 4096;`） */
function extractNumberConstFrom(html, name) {
    const m = new RegExp('const\\s+' + name + '\\s*=\\s*([0-9_]+)\\s*;').exec(html);
    if (!m) throw new Error('在 web/index.html 里找不到常量: ' + name + '（重命名了？请同步更新本检查）');
    return Number(m[1].replace(/_/g, ''));
}

// ────────────────────────────────────────────────────────────
// 1. 对话 API 格式适配器（web/js/chat-providers.js）
//
// 为什么需要：这三个函数是**对话功能的全部出口** —— 搬错一处，AI 就完全无法回复。
// 而且它用「依赖注入」的方式从 index.html 取依赖（window.ChatDeps），
// **漏挂一个依赖的表现是运行到那一步才报 "xxx is not a function"**，
// 静态看源码看不出来。所以这个检查专门盯住"依赖有没有挂全"。
//
// 覆盖：
//   1. 从 chat-providers.js 源码里扫出所有 deps() 解构出的名字，逐个断言在 ChatDeps 里
//   2. 三种格式都有实现（分发表完整），且未知格式有兜底
//   3. 三个函数签名一致（(messages, opts, settings)）
//   4. 用**假依赖**真的跑一遍三个函数，断言请求体/端点的形状正确
//   5. index.html 确实引用了本文件、且挂了 ChatDeps
// ────────────────────────────────────────────────────────────

async function caseProviders(c) {
    const src = readFileSync(PROVIDERS_FILE, 'utf8');
    // ChatDeps 挂载与 CHAT_API_FORMATS 都随主脚本拆到了 web/js/*.js 里
    const html = readFrontend();
    const fileUrl = 'file:///' + PROVIDERS_FILE;

    // ============================================================ 1. 依赖清单
    console.log('=== 1. 依赖注入是否挂全 ===');

    // 扫出所有 `const { a, b, c } = deps();` 里的名字
    const needed = new Set();
    for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*deps\(\)/g)) {
        for (const raw of m[1].split(',')) {
            const name = raw.trim().split(':').pop().trim();   // 兼容 { a: b } 写法
            if (name) needed.add(name);
        }
    }
    console.log('  chat-providers.js 需要 ' + needed.size + ' 个依赖:');
    console.log('    ' + [...needed].sort().join(', '));

    // 从 index.html 里找 window.ChatDeps = { ... } 的键
    const depsBlock = html.match(/window\.ChatDeps\s*=\s*\{([\s\S]*?)\n\s*\};/);
    c.ok(Boolean(depsBlock), 'index.html 里有 window.ChatDeps 挂载');
    const provided = new Set();
    if (depsBlock) {
        for (const raw of depsBlock[1].split(/[,\n]/)) {
            const name = raw.replace(/\/\/.*$/, '').trim().split(':')[0].trim();
            if (name && /^[A-Za-z_$][\w$]*$/.test(name)) provided.add(name);
        }
    }
    console.log('  index.html 提供了 ' + provided.size + ' 个:');
    console.log('    ' + [...provided].sort().join(', '));

    const missing = [...needed].filter((n) => !provided.has(n));
    c.ok(missing.length === 0, '所有需要的依赖都已挂载', missing.length ? '缺: ' + missing.join(', ') : '');

    // 反向：挂了一堆没用到的也算噪音（不失败，只提示）
    const unused = [...provided].filter((n) => !needed.has(n));
    if (unused.length) console.log('  提示：挂载了但没用到 → ' + unused.join(', '));

    // ============================================================ 2. 分发表
    console.log('\n=== 2. 分发表完整性 ===');
    const KNOWN_FORMATS = ['openai-compatible', 'anthropic', 'openai-responses'];
    for (const f of KNOWN_FORMATS) {
        c.ok(new RegExp(`'${f}'\\s*:`).test(src), `分发表含 ${f}`);
    }
    c.ok(/forFormat\s*\(/.test(src), '提供 forFormat() 分发方法');
    c.ok(/PROVIDERS\[format\]\s*\|\|\s*PROVIDERS\[/.test(src) || /PROVIDERS\[DEFAULT_FORMAT\]/.test(src),
        '未知格式有兜底（不抛错，与原 if 链一致）');

    // 与 index.html 的格式表对拍：CHAT_API_FORMATS 里的每个格式都必须有实现
    const formatsBlock = html.match(/const CHAT_API_FORMATS = Object\.freeze\(\{([\s\S]*?)\n\s*\}\);/);
    if (formatsBlock) {
        const declared = [...formatsBlock[1].matchAll(/^\s*'?([a-z-]+)'?\s*:\s*\{/gm)].map((m) => m[1]);
        console.log('  CHAT_API_FORMATS 声明: ' + declared.join(', '));
        for (const d of declared) {
            c.ok(new RegExp(`'${d}'\\s*:`).test(src), `声明了的格式 ${d} 有实现`);
        }
    } else {
        c.ok(false, '能读到 CHAT_API_FORMATS');
    }

    // ============================================================ 3. 签名一致
    console.log('\n=== 3. 函数签名 ===');
    for (const fn of ['callOpenAICompatibleChat', 'callAnthropicChat', 'callOpenAIResponsesChat']) {
        const m = src.match(new RegExp(`async function ${fn}\\(([^)]*)\\)`));
        c.ok(Boolean(m), `${fn} 存在`);
        if (m) {
            const params = m[1].split(',').map((s) => s.trim());
            c.ok(params.join(',') === 'messages,opts,settings', `${fn} 签名是 (messages, opts, settings)`, m[1]);
        }
    }

    // ============================================================ 4. 真跑一遍（假依赖）
    console.log('\n=== 4. 用假依赖实跑三个格式 ===');

    // 真实的「思考参数构造器」：从 index.html 抠出来，供假依赖使用。
    // 为什么要抠真的而不是写个假的：本检查要断言"关思考时请求体里到底有没有 disabled"，
    // 那是被测代码算出来的东西，用假实现就等于自己测自己。
    const extractFnForThinking = (name) => extractFnFrom(html, name);
    const buildThinkingParamsReal = new Function('isDeepSeekOfficial', `
        const THINKING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);
        ${extractFnForThinking('mapThinkingEffort')}
        ${extractFnForThinking('detectThinkingVendor')}
        ${extractFnForThinking('buildThinkingParams')}
        return buildThinkingParams;
    `)((url) => /api\.deepseek\.com/i.test(url));

    /** 造一份可控的假依赖，记录每次请求 */
    function makeFakeDeps() {
        const calls = [];
        // 先建容器，让 requestChatJson 能引用同一份假出口（保持"只有网络出口是假的"）
        const depsRef = {};
        Object.assign(depsRef, {
            ClientApiError: class ClientApiError extends Error {
                constructor(code, message) { super(message); this.code = code; this.name = 'ClientApiError'; }
            },
                getChatBaseUrl: (settings) => settings.baseUrl,
                isDeepSeekOfficial: (url) => /api\.deepseek\.com/i.test(url),
                normalizeChatReply: (content, reasoning) => ({ content, reasoning: reasoning || '' }),
                throwProviderResponseError: async (result, fallback) => {
                    const err = new Error(fallback + ': ' + (result.rawText || ''));
                    err.isProvider = true;
                    throw err;
                },
                postJsonFromDevice: async (url, body, headers) => {
                    calls.push({ url, body, headers });
                    // 按端点返回对应形状的假响应
                    if (/\/chat\/completions$/.test(url)) {
                        return { ok: true, status: 200, payload: { choices: [{ message: { content: 'OPENAI_OK', reasoning_content: 'R1' } }] } };
                    }
                    if (/\/messages$/.test(url)) {
                        return { ok: true, status: 200, payload: { content: [{ type: 'text', text: 'ANTHROPIC_OK' }, { type: 'thinking', thinking: 'R2' }] } };
                    }
                    if (/\/responses$/.test(url)) {
                        return { ok: true, status: 200, payload: { output: [
                            { type: 'message', content: [{ type: 'output_text', text: 'RESP_OK' }] },
                            { type: 'reasoning', summary: [{ text: 'R3' }] },
                        ] } };
                    }
                    return { ok: false, status: 404, rawText: 'unknown endpoint' };
                },
                extractTextContent: (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c.map((p) => p?.text || '').join('') : '')),
                stripThinkTags: (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/g, ''),
                resolveOutputTokenLimit: (model, maxTokens) => (Number.isFinite(maxTokens) ? maxTokens : 4096),
                ANTHROPIC_MIN_MAX_TOKENS: 4096,
        });
        return {
            calls,
            deps: {
                ...depsRef,
                // providers 现在走 requestChatJson（它内部才决定流式/非流式）。
                // 本检查验证的是"发出去的请求体"，所以这里转发到同一个假出口。
                requestChatJson: async (endpoint, body, headers, opts) =>
                    await depsRef.postJsonFromDevice(endpoint, body, headers, opts?.timeoutMs, opts?.signal),
                // 真实的思考参数构造器（从 index.html 抠出来注入），
                // 否则断言"关思考发了什么"就测不到真东西。
                buildThinkingParams: buildThinkingParamsReal,
            },
        };
    }

    // 在 Node 里加载这个浏览器脚本：给它一个假的 window
    const sandbox = makeFakeDeps();
    const context = vm.createContext({
        window: { ChatDeps: sandbox.deps },
        console,
        Error,
        Object,
        Array,
        Number,
        String,
        Math,
        RegExp,
        JSON,
    });
    vm.runInContext(src, context, { filename: fileUrl });
    const CP = context.window.ChatProviders;

    c.ok(Boolean(CP), '脚本能在假环境下加载并挂上 window.ChatProviders');
    if (CP) {
        c.ok(CP.formats().sort().join(',') === KNOWN_FORMATS.slice().sort().join(','), 'formats() 返回三种格式', CP.formats().join(','));
        c.ok(CP.forFormat('不存在的格式') === CP.PROVIDERS['openai-compatible'], '未知格式兜底到 openai-compatible');

        const msgs = [{ role: 'system', content: 'SYS' }, { role: 'user', content: '你好' }];

        // ---- openai-compatible ----
        {
            sandbox.calls.length = 0;
            const r = await CP.callOpenAICompatibleChat(msgs, { maxTokens: 100 }, { apiKey: 'k', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' });
            const call = sandbox.calls[0];
            c.ok(call && /\/chat\/completions$/.test(call.url), 'openai: 端点是 /chat/completions', call && call.url);
            c.ok(call && call.headers.Authorization === 'Bearer k', 'openai: 用 Bearer 认证');
            c.ok(call && call.body.max_tokens === 100, 'openai: max_tokens 正确', call && String(call.body.max_tokens));
            c.ok(r.content === 'OPENAI_OK', 'openai: 回复解析正确', r.content);
            c.ok(r.reasoning === 'R1', 'openai: reasoning 解析正确', r.reasoning);
            // 关思考必须**显式**发 disabled：DeepSeek 现在默认开思考，
            // 不发这个字段用户会白等、白花钱，而界面上什么都看不到。
            const cOff = await (async () => {
                sandbox.calls.length = 0;
                await CP.callOpenAICompatibleChat(msgs, { thinking: false }, { apiKey: 'k', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' });
                return sandbox.calls[0];
            })();
            c.ok(cOff && cOff.body.thinking && cOff.body.thinking.type === 'disabled',
                'openai: 关思考 → 显式 thinking.type = disabled', cOff && JSON.stringify(cOff.body.thinking));
            // 老模型名映射到当前模型，而不是换成 reasoner
            const cLegacy = await (async () => {
                sandbox.calls.length = 0;
                await CP.callOpenAICompatibleChat(msgs, {}, { apiKey: 'k', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' });
                return sandbox.calls[0];
            })();
            c.ok(cLegacy && cLegacy.body.model === 'deepseek-flash',
                'openai: 老名字 deepseek-chat → 映射到 deepseek-flash', cLegacy && cLegacy.body.model);
            // 用户明确选了 pro 就不能被降级（那是花他的钱还改他的选择）
            const cPro = await (async () => {
                sandbox.calls.length = 0;
                await CP.callOpenAICompatibleChat(msgs, {}, { apiKey: 'k', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1' });
                return sandbox.calls[0];
            })();
            c.ok(cPro && cPro.body.model === 'deepseek-v4-pro',
                'openai: 用户选的 deepseek-v4-pro 不被降级', cPro && cPro.body.model);
        }

        // ---- anthropic ----
        {
            sandbox.calls.length = 0;
            const r = await CP.callAnthropicChat(msgs, { maxTokens: 200 }, { apiKey: 'k', model: 'claude-sonnet-4-20250514', baseUrl: 'https://api.anthropic.com' });
            const call = sandbox.calls[0];
            c.ok(call && /\/v1\/messages$/.test(call.url), 'anthropic: 端点是 /v1/messages', call && call.url);
            c.ok(call && call.headers['x-api-key'] === 'k', 'anthropic: 用 x-api-key 认证');
            c.ok(call && call.headers['anthropic-version'] === '2023-06-01', 'anthropic: 带版本头');
            c.ok(call && call.body.system === 'SYS', 'anthropic: system 提到顶层', call && JSON.stringify(call.body.system));
            c.ok(call && !call.body.messages.some((m) => m.role === 'system'), 'anthropic: messages 里不再有 system');
            c.ok(call && call.body.max_tokens === 200, 'anthropic: max_tokens 正确');
            c.ok(r.content === 'ANTHROPIC_OK', 'anthropic: 回复解析正确', r.content);
            c.ok(r.reasoning === 'R2', 'anthropic: thinking 块解析正确', r.reasoning);
        }

        // ---- openai-responses ----
        {
            sandbox.calls.length = 0;
            const r = await CP.callOpenAIResponsesChat(msgs, { maxTokens: 300 }, { apiKey: 'k', model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' });
            const call = sandbox.calls[0];
            c.ok(call && /\/responses$/.test(call.url), 'responses: 端点是 /responses', call && call.url);
            c.ok(call && call.body.max_output_tokens === 300, 'responses: 用 max_output_tokens（不是 max_tokens）', call && JSON.stringify(Object.keys(call.body)));
            c.ok(call && !('messages' in call.body), 'responses: 不用 messages 字段');
            c.ok(call && call.body.instructions === 'SYS', 'responses: system 走顶层 instructions');
            c.ok(call && Array.isArray(call.body.input), 'responses: 内容走 input 数组');
            c.ok(r.content === 'RESP_OK', 'responses: 回复解析正确', r.content);
            c.ok(r.reasoning === 'R3', 'responses: reasoning 解析正确', r.reasoning);
        }

        // ---- 分发 ----
        {
            sandbox.calls.length = 0;
            await CP.forFormat('anthropic')(msgs, {}, { apiKey: 'k', model: 'm', baseUrl: 'https://api.anthropic.com' });
            c.ok(/\/messages$/.test(sandbox.calls[0].url), 'forFormat(anthropic) 走 anthropic 实现');

            sandbox.calls.length = 0;
            await CP.forFormat('unknown-xyz')(msgs, {}, { apiKey: 'k', model: 'm', baseUrl: 'https://x.com/v1' });
            c.ok(/\/chat\/completions$/.test(sandbox.calls[0].url), 'forFormat(未知) 兜底到 openai-compatible');
        }

        // ---- 缺 Key 的报错 ----
        {
            let threw = null;
            try { await CP.callOpenAICompatibleChat(msgs, {}, { apiKey: '', model: 'm', baseUrl: 'https://x.com/v1' }); }
            catch (e) { threw = e; }
            c.ok(threw && threw.code === 'APP_KEY_MISSING', '缺 API Key 时抛 APP_KEY_MISSING', threw && threw.code);
        }

        // ---- 转换器 ----
        {
            const conv = CP.convertOpenAIToAnthropicMessages([
                { role: 'system', content: 'A' },
                { role: 'system', content: 'B' },
                { role: 'user', content: 'u1' },
                { role: 'user', content: 'u2' },
            ]);
            c.ok(conv.system === 'A\n\nB', 'anthropic 转换: 多条 system 合并', JSON.stringify(conv.system));
            c.ok(conv.messages.length === 1, 'anthropic 转换: 相邻 user 合并成一条', 'got ' + conv.messages.length);

            const conv2 = CP.convertOpenAIToResponsesInput([
                { role: 'system', content: 'S' },
                { role: 'user', content: 'u' },
                { role: 'assistant', content: 'a' },
            ]);
            c.ok(conv2.instructions === 'S', 'responses 转换: system → instructions');
            c.ok(conv2.input[0].content[0].type === 'input_text', 'responses 转换: user 用 input_text');
            c.ok(conv2.input[1].content[0].type === 'output_text', 'responses 转换: assistant 用 output_text');
        }
    }

    // ============================================================ 5. index.html 接线
    console.log('\n=== 5. index.html 接线 ===');
    c.ok(/<script\s+src="\/js\/chat-providers\.js"><\/script>/.test(html), 'index.html 引用了 chat-providers.js');

    // 加载顺序：必须在主脚本（最后一个内联 script）之前
    const refIdx = html.indexOf('/js/chat-providers.js');
    const lastInline = html.lastIndexOf('<script>');
    c.ok(refIdx > 0 && refIdx < lastInline, '引用位置在主脚本之前');

    c.ok(/window\.ChatProviders\.forFormat\(/.test(html), 'callChatAPI 用了 forFormat 分发');
}

// ────────────────────────────────────────────────────────────
// 2. 对话请求的形状（Anthropic 格式为主，外加跨格式的 max_tokens 下限）
//
// 背景（真实故障一）：用户切到 Anthropic 格式后必然 400 ——
//   400 "max_tokens must be greater than 1024 for manual Claude thinking"
// 原因不在我们这侧的参数，而在**中转站会按模型名后缀替我们决定要不要开 thinking**：
// 只要模型名以 `-thinking` 结尾（或含 `-thinking-<数字>`），new-api 就会开 manual thinking，
// 而 manual thinking 要求 `1024 <= budget_tokens < max_tokens`，于是 max_tokens <= 1024 的请求被拒。
// 我们当时发的是 900（ROLEPLAY_OUTPUT_TOKEN_LIMITS.text），所以必然失败；
// 「测试对话连接」按钮发的是 8，同样失败。
//
// 背景（真实故障二的隐患）：这条约束**跨协议**。new-api 的 `ApplyReasoning()` 里，
// OpenAI → Claude 的转换（crossProtocol）一定走 `RenderClaude`，
// 所以用 OpenAI 兼容格式调一个 `…-thinking` 的模型名会踩同一个坑。
// 因此下限判据被提到 `callChatAPI`，三种格式共用 —— 本检查直接驱动 `callChatAPI` 验证这一点。
//
// 做法：把 index.html 里的真实函数体抠出来，只把网络出口（postJsonFromDevice）换成假的，
// 检查**真正会发出去的 body**。不联网、不复制逻辑。
//
// 2026-09 更新：三种协议的实现已拆到 `web/js/chat-providers.js`（表驱动分发）。
// 本检查相应改成**直接加载那个真模块**，而不是继续从 HTML 里正则抠 ——
// 抠函数那种做法本来就脆（改个格式就断），拆出去后正好改成"测线上真正跑的那份"。
// ────────────────────────────────────────────────────────────

async function caseAnthropicRequest(c) {
    const html = readFrontend();
    const extractFn = (name) => extractFnFrom(html, name);
    const extractClass = (name) => extractClassFrom(html, name);
    const extractNumberConst = (name) => extractNumberConstFrom(html, name);

    const ctx = new Function('window', `
        const calls = [];
        const normalizeCalls = [];
        let nextPayload = { content: [{ type: 'text', text: '好的' }] };
        function setPayload(p) { nextPayload = p; }
        // 唯一的假实现：网络出口。其余全部来自 index.html 的真实代码。
        // 按端点回不同形状的成功响应 —— 三种格式的成功响应结构不一样，混用会让解析器抛 EMPTY_MODEL_OUTPUT。
        async function postJsonFromDevice(url, body, headers) {
            calls.push({ url, body, headers });
            if (/\\/chat\\/completions$/.test(url)) return { ok: true, payload: { choices: [{ message: { content: '好的' } }] } };
            if (/\\/responses$/.test(url)) return { ok: true, payload: { output_text: '好的' } };
            return { ok: true, payload: nextPayload };
        }
        async function throwProviderResponseError() { throw new Error('不该走到这里'); }
        const state = { settings: {} };
        ${extractFn('stripThinkTags')}
        ${extractFn('extractTextContent')}
        ${extractFn('normalizeChatReply').replace('function normalizeChatReply(', 'function realNormalizeChatReply(')}
        // 包一层记录入参：真实的 normalizeChatReply 只返回正文，看不到 reasoning 有没有被认出来
        function normalizeChatReply(content, reasoningContent = '') {
            normalizeCalls.push({ content, reasoningContent });
            return realNormalizeChatReply(content, reasoningContent);
        }
        // anthropicContentBlocks / convertOpenAIToAnthropicMessages / convertOpenAIToResponsesInput
        // 已随三个协议实现一起迁到 web/js/chat-providers.js（本文件下面会直接加载那个真模块），
        // 所以这里不再从 index.html 抠。
        const ANTHROPIC_MIN_MAX_TOKENS = ${extractNumberConst('ANTHROPIC_MIN_MAX_TOKENS')};
        // ★ callChatAPI 现在按 thinking 开关选请求超时预算（见它的 timeoutMs 说明）。
        //   本检查只验证"发出去的请求体形状"，超时值本身无关紧要 —— 但这两个常量
        //   **必须在作用域里**，否则抠出来的 callChatAPI 一执行就 ReferenceError。
        //   （踩过：漏了它们会让整套 npm run check 在这一项直接中断退出，而不是报一条 FAIL。）
        const CHAT_TIMEOUT_DEFAULT_MS = ${extractNumberConst('CHAT_TIMEOUT_DEFAULT_MS')};
        const CHAT_TIMEOUT_THINKING_MS = ${extractNumberConst('CHAT_TIMEOUT_THINKING_MS')};
        ${extractFn('thinkingSuffixTokenFloor')}
        ${extractFn('resolveOutputTokenLimit')}
        ${extractFn('getChatBaseUrl')}
        ${extractFn('isDeepSeekOfficial')}
        // 思考开关/强度 → 各协议请求字段。这是真实实现，不是假的：
        // 本检查要断言"关思考时到底发了什么"，那必须是被测代码自己算出来的。
        ${extractFn('mapThinkingEffort')}
        ${extractFn('detectThinkingVendor')}
        ${extractFn('buildThinkingParams')}
        const THINKING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);
        // CHAT_API_FORMATS 只是格式白名单表，这里按真实定义给一份骨架（**新增格式时要同步**）
        const CHAT_API_FORMATS = Object.freeze({ 'openai-compatible': {}, 'openai-responses': {}, anthropic: {} });
        ${extractFn('getChatApiFormat')}
        ${extractFn('mergeLeadingSystemMessages')}
        ${extractFn('callChatAPI')}
        ${extractClass('ClientApiError')}
        // 本检查只关心"提示怎么展示"，不验证错误归一化 —— 直接透传即可
        function toClientApiError(error) { return error; }
        ${extractFn('getClientErrorPresentation')}
        return {
            callChatAPI, calls, setPayload, normalizeCalls, getClientErrorPresentation, ClientApiError,
            getChatBaseUrl, isDeepSeekOfficial, normalizeChatReply, postJsonFromDevice,
            throwProviderResponseError, extractTextContent, stripThinkTags, resolveOutputTokenLimit,
            ANTHROPIC_MIN_MAX_TOKENS, buildThinkingParams,
            last: () => calls[calls.length - 1],
            lastNormalize: () => normalizeCalls[normalizeCalls.length - 1],
        };
    `);

    // ===== 让真实模块跑起来：三种协议的实现已拆到 web/js/chat-providers.js =====
    //
    // 原来是把这个文件里的三个实现 + 两个转换器也一起抠出来执行。现在它们搬走了，
    // 继续抠会抠不到 —— 而**这正是拆分想要的结果**：不再"从 HTML 里正则抠函数"，
    // 而是直接加载真模块，测的就是线上真正跑的那份代码。
    //
    // 做法：
    //   ① 先建一个空的 fakeWindow 对象
    //   ② 用 new Function('window', ...) 跑 index.html 里抠出来的真实代码，拿到真实依赖
    //   ③ 把依赖挂进 fakeWindow.ChatDeps
    //   ④ 在 vm 里执行 chat-providers.js（它从 window.ChatDeps 取依赖）
    //   ⑤ 把 ChatProviders 挂回 fakeWindow，让 callChatAPI 里的 window.ChatProviders 能用
    const fakeWindow = {};
    const raw = ctx(fakeWindow);

    const providersSrc = readFileSync(PROVIDERS_FILE, 'utf8');
    fakeWindow.ChatDeps = {
        ClientApiError: raw.ClientApiError,
        getChatBaseUrl: raw.getChatBaseUrl,
        isDeepSeekOfficial: raw.isDeepSeekOfficial,
        normalizeChatReply: raw.normalizeChatReply,
        postJsonFromDevice: raw.postJsonFromDevice,
        // providers 现在走 requestChatJson 而不是直接 postJsonFromDevice。
        // 本检查只验证"发出去的请求体形状"，不验证流式 —— 所以这里让 requestChatJson
        // 直接转发到那个假的 postJsonFromDevice，保持"只有网络出口是假的"这个性质。
        requestChatJson: async (endpoint, body, headers, opts) =>
            await raw.postJsonFromDevice(endpoint, body, headers, opts?.timeoutMs, opts?.signal),
        buildThinkingParams: raw.buildThinkingParams,
        throwProviderResponseError: raw.throwProviderResponseError,
        extractTextContent: raw.extractTextContent,
        stripThinkTags: raw.stripThinkTags,
        resolveOutputTokenLimit: raw.resolveOutputTokenLimit,
        ANTHROPIC_MIN_MAX_TOKENS: raw.ANTHROPIC_MIN_MAX_TOKENS,
    };
    {
        const sandbox = vm.createContext({
            window: fakeWindow, console, Error, Object, Array, Number, String, Math, RegExp, JSON,
        });
        vm.runInContext(providersSrc, sandbox, { filename: 'file:///' + PROVIDERS_FILE });
    }
    if (!fakeWindow.ChatProviders) {
        throw new Error('chat-providers.js 没能挂上 window.ChatProviders —— 本检查无法继续');
    }

    const { calls, setPayload, last, lastNormalize, getClientErrorPresentation, ClientApiError } = raw;
    const callChatAPI = raw.callChatAPI;
    // 三个实现直接从**真实模块**取（不再从 HTML 抠）
    const { callAnthropicChat, callOpenAICompatibleChat, callOpenAIResponsesChat } = fakeWindow.ChatProviders;

    // 断言适配器：原脚本用 check / atLeast / absent 三种风格，语义照抄。
    function check(label, actual, expected) {
        const a = JSON.stringify(actual);
        const b = JSON.stringify(expected);
        const same = a === b;
        c.ok(same, label, same ? '' : `got=${a} want=${b}`);
    }
    function atLeast(label, actual, floor) {
        const same = Number(actual) >= floor;
        c.ok(same, label, same ? '' : `got=${actual}，需要 >= ${floor}`);
    }
    /** 该键应当**不存在**（不发这个字段 = 用服务商默认值） */
    function absent(label, body, key) {
        const same = !(key in body);
        c.ok(same, label, same ? '' : `got=${JSON.stringify(body[key])}，不该存在`);
    }

    const S = (s) => ({ role: 'system', content: s });
    const U = (s) => ({ role: 'user', content: s });
    const A = (s) => ({ role: 'assistant', content: s });
    const msgs = [S('你是伊蕾娜。'), S('# 世界观\n魔法世界'), U('你好'), A('你好呀'), U('只回复OK')];

    /** 走真实的 callChatAPI（下限判据就在那一层），返回真正发出去的那次请求 */
    async function send(opts, settings = {}, format = 'anthropic') {
        await callChatAPI(msgs, opts, {
            apiKey: 'test-key', model: 'claude-sonnet-4-5', baseUrl: 'https://newapi.example.com',
            apiFormat: format, ...settings,
        });
        return last();
    }

    void callOpenAICompatibleChat; void callOpenAIResponsesChat;

    // ---------- 一、Anthropic 格式：下限是**无条件**的 ----------
    // 阈值来自中转站的报错文案：max_tokens must be **greater than** 1024
    console.log('\n— Anthropic 格式的 max_tokens 下限（无条件）—');
    const main = await send({ maxTokens: 900 });           // 角色扮演主对话
    atLeast('主对话（900）发出的 max_tokens > 1024', main.body.max_tokens, 1025);
    const test8 = await send({ maxTokens: 8 });            // 「测试对话连接」按钮
    atLeast('测试连接（8）发出的 max_tokens > 1024', test8.body.max_tokens, 1025);
    const noOpt = await send({});
    atLeast('不传 maxTokens 时 > 1024', noOpt.body.max_tokens, 1025);
    const big = await send({ maxTokens: 32000 });
    check('传了更大的值时不被压低', big.body.max_tokens, 32000);

    // thinking 的预算和正文吃同一个额度：只满足 1025 的话正文一个 token 都不剩
    const thinkingSuffix = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-thinking' });
    atLeast('带 -thinking 后缀时给正文留出空间（>= 2048）', thinkingSuffix.body.max_tokens, 2048);
    const budgetSuffix = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-thinking-3000' });
    atLeast('-thinking-3000 时 max_tokens 必须大于该预算', budgetSuffix.body.max_tokens, 3001);
    const bigBudget = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-thinking-8000' });
    atLeast('-thinking-8000 时 max_tokens 必须大于该预算', bigBudget.body.max_tokens, 8001);

    // ---------- 二、同一个坑跨格式：OpenAI 系只在模型名带后缀时才抬 ----------
    // 约束在 new-api 侧是跨协议的（OpenAI → Claude 也走 RenderClaude），
    // 所以判据必须提到 callChatAPI —— 否则用户换成 OpenAI 格式照样 400。
    console.log('\n— 跨格式：模型名带 -thinking 后缀时同样保底 —');
    const oaiThinking = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-thinking' }, 'openai-compatible');
    atLeast('openai-compatible + -thinking → max_tokens > 1024', oaiThinking.body.max_tokens, 1025);
    check('  并且模型名原样传给上游（判据只读名字，不改名字）', oaiThinking.body.model, 'claude-sonnet-4-5-thinking');
    const oaiBudget = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-thinking-3000' }, 'openai-compatible');
    atLeast('openai-compatible + -thinking-3000 → 大于该预算', oaiBudget.body.max_tokens, 3001);
    const oaiNoMax = await send({}, { model: 'claude-sonnet-4-5-thinking' }, 'openai-compatible');
    atLeast('openai-compatible + -thinking + 不传 maxTokens → 也补上下限', oaiNoMax.body.max_tokens, 1025);
    const respThinking = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-thinking' }, 'openai-responses');
    atLeast('openai-responses + -thinking → max_output_tokens > 1024', respThinking.body.max_output_tokens, 1025);

    // 反过来更要紧：普通模型名**不能**被无故抬高 —— 那会把用户的输出预算悄悄改大
    console.log('\n— 反向：普通模型名不许被动 —');
    const oaiPlain = await send({ maxTokens: 900 }, {}, 'openai-compatible');
    check('openai-compatible + 普通模型名 → 原样 900', oaiPlain.body.max_tokens, 900);
    const oaiPlainNone = await send({}, {}, 'openai-compatible');
    absent('openai-compatible + 普通模型名 + 不传 → 不发 max_tokens', oaiPlainNone.body, 'max_tokens');
    const respPlain = await send({ maxTokens: 900 }, {}, 'openai-responses');
    check('openai-responses + 普通模型名 → 原样 900', respPlain.body.max_output_tokens, 900);
    const respPlainNone = await send({}, {}, 'openai-responses');
    absent('openai-responses + 普通模型名 + 不传 → 不发 max_output_tokens', respPlainNone.body, 'max_output_tokens');

    // `-nothinking` 是**显式关闭**思考，判据不能把它当 `-thinking` 命中
    const nothinking = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-nothinking' }, 'openai-compatible');
    check('-nothinking 不触发下限（它不是 -thinking）', nothinking.body.max_tokens, 900);
    // 大小写：判据故意放宽（多抬一个上限是无害的），命中时不能漏
    const upper = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-THINKING' }, 'openai-compatible');
    atLeast('后缀大小写混写也认（宁可多抬，不能漏）', upper.body.max_tokens, 1025);
    // DeepSeek 官方的老模型名会映射到当前模型（deepseek-chat 已由 deepseek-flash 承接），
    // 但**不能**再换成 deepseek-reasoner —— 那个模型名属于"思考专用模型"时代，
    // 现在思考由 thinking 字段控制。这条断言以前写的是"换成 reasoner"，是过时契约。
    const ds = await send({ maxTokens: 900, thinking: true },
        { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'openai-compatible');
    check('DeepSeek 官方 + 老模型名 → 映射到当前模型', ds.body.model, 'deepseek-flash');
    check('  且 max_tokens 不被抬（模型名没有 -thinking 后缀）', ds.body.max_tokens, 900);

    // ---------- 二之二、思考开关与强度（本次适配的核心） ----------
    //
    // 背景：DeepSeek 现在的接口**默认开启思考**（官方《思考模式》文档：thinking mode
    // is enabled by default, effort 默认 high）。这意味着"关掉开关"必须**显式**发
    // disabled —— 不发字段不等于关，用户会白等几十秒、白花思考 token，
    // 而界面上什么都看不到。这条是本次最容易漏、后果最隐蔽的一条。
    console.log('\n— 思考开关与强度 —');
    const dsOff = await send({ thinking: false }, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'openai-compatible');
    check('DeepSeek 关思考 → 显式发 disabled（默认是开的，不发等于没关）',
        dsOff.body.thinking, { type: 'disabled' });
    const dsOn = await send({ thinking: true }, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'openai-compatible');
    check('DeepSeek 开思考 → 发 enabled', dsOn.body.thinking, { type: 'enabled' });
    check('  未指定档位时不发 effort（交给服务商默认）', 'reasoning_effort' in dsOn.body, false);
    const dsLow = await send({ thinking: true, thinkingEffort: 'low' },
        { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'openai-compatible');
    check('DeepSeek 低强度 → reasoning_effort: low', dsLow.body.reasoning_effort, 'low');
    const dsHigh = await send({ thinking: true, thinkingEffort: 'high' },
        { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'openai-compatible');
    check('DeepSeek 高强度 → reasoning_effort: high', dsHigh.body.reasoning_effort, 'high');

    // Anthropic：用 reasoning.effort，**不能**用 thinking 字段
    // （那个字段在 Claude 官方是 {type, budget_tokens}，同名不同义，发错会 400）
    const anOff = await send({ thinking: false }, { baseUrl: 'https://api.anthropic.com' }, 'anthropic');
    check('Anthropic 关思考 → reasoning.effort: none', anOff.body.reasoning, { effort: 'none' });
    check('  ★ 且不发 thinking 字段（那是 Claude 官方 extended thinking，同名不同义）',
        'thinking' in anOff.body, false);
    const anOn = await send({ thinking: true, thinkingEffort: 'low' }, { baseUrl: 'https://api.anthropic.com' }, 'anthropic');
    check('Anthropic 开思考 → reasoning.effort 是档位名', anOn.body.reasoning, { effort: 'low' });
    check('  低/高强度时补 output_config.effort', anOn.body.output_config, { effort: 'low' });

    // ★ 开了思考就不能带 temperature：Anthropic 官方禁止（会 400）
    const anTemp = await send({ thinking: true, temperature: 0.7 }, { baseUrl: 'https://api.anthropic.com' }, 'anthropic');
    check('★ Anthropic 开思考时不带 temperature（带了会 400）', 'temperature' in anTemp.body, false);
    const anTempOff = await send({ thinking: false, temperature: 0.7 }, { baseUrl: 'https://api.anthropic.com' }, 'anthropic');
    check('  关思考时 temperature 照常带上', anTempOff.body.temperature, 0.7);

    // Responses：只有 reasoning.effort，没有"关闭"取值
    const rpOn = await send({ thinking: true, thinkingEffort: 'high' }, { baseUrl: 'https://api.openai.com/v1' }, 'openai-responses');
    check('Responses 开思考 → reasoning.effort', rpOn.body.reasoning, { effort: 'high' });
    const rpOff = await send({ thinking: false }, { baseUrl: 'https://api.openai.com/v1' }, 'openai-responses');
    check('Responses 关思考 → 不发 reasoning（它没有 none 取值）', 'reasoning' in rpOff.body, false);

    // ---------- 三、端点拼接 ----------
    console.log('\n— 端点 —');
    check('裸域名 → /v1/messages',
        (await send({}, { baseUrl: 'https://newapi.example.com' })).url,
        'https://newapi.example.com/v1/messages');
    check('带 /v1 → 不重复拼',
        (await send({}, { baseUrl: 'https://newapi.example.com/v1' })).url,
        'https://newapi.example.com/v1/messages');
    check('已经指向 /messages → 原样用',
        (await send({}, { baseUrl: 'https://newapi.example.com/v1/messages' })).url,
        'https://newapi.example.com/v1/messages');
    check('结尾多余的斜杠被吃掉',
        (await send({}, { baseUrl: 'https://newapi.example.com/v1/' })).url,
        'https://newapi.example.com/v1/messages');
    check('官方地址 → api.anthropic.com/v1/messages',
        (await send({}, { baseUrl: 'https://api.anthropic.com' })).url,
        'https://api.anthropic.com/v1/messages');
    check('openai-compatible → /chat/completions',
        (await send({}, { baseUrl: 'https://newapi.example.com/v1' }, 'openai-compatible')).url,
        'https://newapi.example.com/v1/chat/completions');
    check('openai-responses → /responses',
        (await send({}, { baseUrl: 'https://api.openai.com/v1' }, 'openai-responses')).url,
        'https://api.openai.com/v1/responses');

    // ---------- 四、请求头 ----------
    console.log('\n— 请求头 —');
    check('Anthropic 用 x-api-key（不是 Authorization）', main.headers['x-api-key'], 'test-key');
    check('Anthropic 带 anthropic-version', main.headers['anthropic-version'], '2023-06-01');
    check('Anthropic 没混进 Authorization', Object.keys(main.headers).some((k) => /^authorization$/i.test(k)), false);
    check('OpenAI 系用 Bearer', oaiPlain.headers.Authorization, 'Bearer test-key');

    // ---------- 五、请求体形状 ----------
    console.log('\n— 请求体 —');
    check('system 提到顶层，且拼成一条', main.body.system, '你是伊蕾娜。\n\n# 世界观\n魔法世界');
    check('messages 里不再有 system', main.body.messages.some((m) => m.role === 'system'), false);
    check('messages 只有 user/assistant', main.body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    check('不带 thinking 字段（Anthropic 用 reasoning.effort，不是 Claude 的 thinking）', 'thinking' in main.body, false);
    check('模型名原样传给上游', main.body.model, 'claude-sonnet-4-5');
    check('带 -thinking 后缀时模型名原样传（由中转站解析）', thinkingSuffix.body.model, 'claude-sonnet-4-5-thinking');
    check('没传 temperature 时不带上这个键', 'temperature' in main.body, false);
    check('传了 temperature 时带上', (await send({ temperature: 0.7 })).body.temperature, 0.7);
    // OpenAI 系两种格式也吃到同一份「开头连续 system 合并」（在 callChatAPI 里做的）
    check('openai-compatible 的 system 也合并成一条',
        oaiPlain.body.messages.filter((m) => m.role === 'system').length, 1);
    check('openai-responses 的 system 走 instructions',
        respPlain.body.instructions, '你是伊蕾娜。\n\n# 世界观\n魔法世界');

    // ---------- 六、响应解析 ----------
    // 中转站按模型名后缀开的 thinking 会把思考内容以 thinking block 返回，
    // 正文在 text block 里 —— 混在一起会把思考过程当回复显示给用户。
    console.log('\n— 响应解析 —');
    const settings = { apiKey: 'test-key', model: 'claude-sonnet-4-5', baseUrl: 'https://newapi.example.com' };
    setPayload({ content: [
        { type: 'thinking', thinking: '嗯……她在问天气。' },
        { type: 'text', text: '今天阳光很好呢。' },
    ] });
    check('thinking block 归到 reasoning 而不是正文',
        (await callAnthropicChat(msgs, {}, settings), lastNormalize().reasoningContent),
        '嗯……她在问天气。');

    setPayload({ content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] });
    check('多个 text block 按顺序拼接', await callAnthropicChat(msgs, {}, settings), '第一段第二段');

    setPayload({ content: [{ type: 'thinking', thinking: '想了很久' }] });
    let thinkOnlyErr = null;
    try { await callAnthropicChat(msgs, {}, settings); } catch (e) { thinkOnlyErr = e.code; }
    check('只返回思考内容时抛 EMPTY_MODEL_OUTPUT（不给用户看空回复）', thinkOnlyErr, 'EMPTY_MODEL_OUTPUT');

    setPayload({ content: [] });
    let emptyErr = null;
    try { await callAnthropicChat(msgs, {}, settings); } catch (e) { emptyErr = e.code; }
    check('没有正文时抛 EMPTY_MODEL_OUTPUT', emptyErr, 'EMPTY_MODEL_OUTPUT');
    setPayload({ content: [{ type: 'text', text: '好的' }] });

    // ---------- 七、缺 Key 时的提示 ----------
    console.log('\n— 错误路径 —');
    let missingKey = null;
    try { await callAnthropicChat(msgs, {}, { apiKey: '', model: 'claude-sonnet-4-5', baseUrl: 'https://x.com' }); }
    catch (e) { missingKey = e.code; }
    check('没填 Key 时给出 APP_KEY_MISSING', missingKey, 'APP_KEY_MISSING');
    let oaiMissingKey = null;
    try { await send({}, { apiKey: '' }, 'openai-compatible'); } catch (e) { oaiMissingKey = e.code; }
    check('OpenAI 格式没填 Key 时也报 APP_KEY_MISSING', oaiMissingKey, 'APP_KEY_MISSING');

    // ---------- 八、400 的提示要说清 -thinking 后缀 ----------
    // 用户没开过思考，光看到 "manual Claude thinking" 只会更迷惑 —— 提示必须点破模型名后缀。
    console.log('\n— 400 提示 —');
    const present = (message, imageHint) =>
        getClientErrorPresentation(new ClientApiError('BAD_REQUEST', message, { imageHint })).message;
    const thinking400 = present('max_tokens must be greater than 1024 for manual Claude thinking (request id: abc)');
    check('max_tokens + thinking 的报错 → 点明 -thinking 后缀', /-thinking/.test(thinking400), true);
    check('并给出可操作的下一步（去掉后缀）', /去掉/.test(thinking400), true);
    check('不再混进图片那套说辞', /图片转述/.test(thinking400), false);

    // 关键回归：这条提示必须**只**在真的相关时出现 —— 项目里有过"提示被写成无条件"的先例
    const plain400 = present('System message must be at the beginning.');
    check('普通 400 不提 -thinking', /-thinking/.test(plain400), false);
    check('普通 400 不提图片转述', /图片转述/.test(plain400), false);
    check('普通 400 走通用提示', /常见原因/.test(plain400), true);
    const onlyMaxTokens = present('max_tokens is too large');
    check('只提 max_tokens、不提 thinking 时不误判', /-thinking/.test(onlyMaxTokens), false);
    check('真的带了图片时仍然提图片转述', /图片转述/.test(present('bad request', true)), true);
    check('服务商的话本身在说图片时也提图片转述', /图片转述/.test(present('image too large')), true);

    void calls;
}

// ────────────────────────────────────────────────────────────
// 3. 获取模型列表（`GET <base>/models`）
//
// 背景（真实问题）：界面上一直写着「Anthropic 格式下获取模型不可用」，理由是
// "它的模型列表接口与 OpenAI 不同"。**这是错的** ——
// Anthropic 有 Models API：`GET /v1/models`，返回 `{ data: [{ id, display_name, … }] }`，
// 和 OpenAI 的 `{ data: [{ id }] }` **同构**，解析逻辑本来就能共用。
//
// 真正的故障只有一个：**地址拼错了**。
//   Anthropic 的 Base URL 惯例上不带版本段（默认 `https://api.anthropic.com`），
//   而它的 Models API 在 `/v1/models` —— 代码直接拼 `/models`，于是 404，
//   再被上层翻译成"该服务不支持 /models"。
//
// 所以本检查的核心不是"能不能解析"，而是**地址拼接规则**，以及一条容易被未来重构破坏的不变量：
//   `模型列表地址 == 对话地址把 /messages 换成 /models`
// （一旦不一致，就会出现"对话能通、获取模型 404"这种最费解的现象）。
//
// 做法：抠出 index.html 里的真实函数体，只把网络出口换成假的。
// 2026-09 更新：三种协议的实现已拆到 web/js/chat-providers.js（开发文档 8.33），
// 本检查相应改成**直接加载那个真模块**来测 callAnthropicChat。
// ────────────────────────────────────────────────────────────

async function caseModelList(c) {
    const html = readFrontend();
    const extractFn = (name) => extractFnFrom(html, name);
    const extractClass = (name) => extractClassFrom(html, name);
    const extractNumberConst = (name) => extractNumberConstFrom(html, name);

    const rawCtxFactory = new Function('window', `
        // 两个假实现：GET 出口（获取模型）与 POST 出口（对话，用来对拍地址）
        const getCalls = [];
        let queued = [];
        function setGetResults(list) { queued = list.slice(); }
        /** 清空已发出的请求记录 —— 断言"这次一共打了几次"前必须先清，否则是累计值 */
        function resetGetCalls() { getCalls.length = 0; }
        async function getJsonFromDevice(url, headers, timeoutMs) {
            getCalls.push({ url, headers, timeoutMs });
            if (!queued.length) return { ok: true, status: 200, payload: { data: [] } };
            const next = queued.shift();
            if (next instanceof Error) throw next;
            return next;
        }
        const postCalls = [];
        async function postJsonFromDevice(url, body, headers) {
            postCalls.push({ url, body, headers });
            return { ok: true, payload: { content: [{ type: 'text', text: '好的' }] } };
        }
        async function throwProviderResponseError() { throw new Error('不该走到这里'); }
        function toClientApiError(error) { return error; }
        const state = { settings: {} };
        // 假 DOM / 假弹窗：populateModelSelect 用到 document.createElement 和 showCustomAlert
        const alertMessages = [];
        function showCustomAlert(msg) { alertMessages.push(String(msg)); }
        // ★ 2026-10 组合框：populateModelSelect 现在会调 input.__modelComboRefresh()
        //   刷新浮层列表。假 input 上没有这个方法 —— 真实代码里那行有 typeof 判断，
        //   所以不崩；这里保持"没有该方法"的状态，正好顺带覆盖那条兜底分支。
        const document = {
            createElement() { return { value: '', textContent: '' }; },
        };
        ${extractFn('stripThinkTags')}
        ${extractFn('extractTextContent')}
        ${extractFn('normalizeChatReply')}
        ${extractFn('mapThinkingEffort')}
        ${extractFn('detectThinkingVendor')}
        ${extractFn('buildThinkingParams')}
        const THINKING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);
        // anthropicContentBlocks / convertOpenAIToAnthropicMessages / callAnthropicChat
        // 已迁到 web/js/chat-providers.js（见开发文档 8.33）—— 不再从 index.html 抠，
        // 改为在下面直接加载那个真模块（测的就是线上跑的那份）。
        const ANTHROPIC_MIN_MAX_TOKENS = ${extractNumberConst('ANTHROPIC_MIN_MAX_TOKENS')};
        ${extractFn('thinkingSuffixTokenFloor')}
        ${extractFn('resolveOutputTokenLimit')}
        ${extractFn('getChatBaseUrl')}
        // detectThinkingVendor 会用它判断"是不是 DeepSeek 官方地址"，
        // 所以本检查的上下文里必须有真身（不抠出来会 ReferenceError）
        ${extractFn('isDeepSeekOfficial')}
        ${extractClass('ClientApiError')}
        ${extractFn('modelsEndpointFor')}
        ${extractFn('parseModelList')}
        ${extractFn('fetchModelList')}
        ${extractFn('populateModelSelect')}
        function lastGet() { return getCalls[getCalls.length - 1]; }
        function lastPost() { return postCalls[postCalls.length - 1]; }
        return {
            modelsEndpointFor, parseModelList, fetchModelList, populateModelSelect,
            ClientApiError,
            // 下面这些是 chat-providers.js 需要的依赖（它已拆成独立模块，见开发文档 8.33）。
            // 注意只导出**本环境里真实存在**的：
            //   · postJsonFromDevice / throwProviderResponseError 是本文件里的假实现
            //   · isDeepSeekOfficial 本检查用不到（callAnthropicChat 不依赖它），
            //     本环境也没定义 —— 所以不导出，否则会 ReferenceError。
            getChatBaseUrl, normalizeChatReply, postJsonFromDevice,
            buildThinkingParams,
            throwProviderResponseError, extractTextContent, stripThinkTags,
            resolveOutputTokenLimit, ANTHROPIC_MIN_MAX_TOKENS,
            setGetResults, resetGetCalls, getCalls, postCalls, lastGet, lastPost,
            alertMessages,
        };
    `);

    // ===== 加载真实的 chat-providers.js（三种协议的实现都在那边）=====
    // 原来是把 callAnthropicChat 从 index.html 里抠出来执行；它搬走后改为直接加载真模块。
    const fakeWindow = {};
    const ctx = rawCtxFactory(fakeWindow);
    fakeWindow.ChatDeps = {
        ClientApiError: ctx.ClientApiError,
        getChatBaseUrl: ctx.getChatBaseUrl,
        normalizeChatReply: ctx.normalizeChatReply,
        postJsonFromDevice: ctx.postJsonFromDevice,
        // providers 现在走 requestChatJson（内部决定流式/非流式）。本检查只关心
        // 模型列表与地址拼接，不验证流式，所以让它转发到同一个假出口。
        requestChatJson: async (endpoint, body, headers, opts) =>
            await ctx.postJsonFromDevice(endpoint, body, headers, opts?.timeoutMs, opts?.signal),
        // 思考参数：真实实现（从 index.html 抠）。假的话就等于自己测自己。
        buildThinkingParams: ctx.buildThinkingParams,
        throwProviderResponseError: ctx.throwProviderResponseError,
        extractTextContent: ctx.extractTextContent,
        stripThinkTags: ctx.stripThinkTags,
        resolveOutputTokenLimit: ctx.resolveOutputTokenLimit,
        ANTHROPIC_MIN_MAX_TOKENS: ctx.ANTHROPIC_MIN_MAX_TOKENS,
    };
    {
        const providersSrc = readFileSync(PROVIDERS_FILE, 'utf8');
        const sandbox = vm.createContext({
            window: fakeWindow, console, Error, Object, Array, Number, String, Math, RegExp, JSON,
        });
        vm.runInContext(providersSrc, sandbox, { filename: 'file:///' + PROVIDERS_FILE });
    }
    if (!fakeWindow.ChatProviders) {
        throw new Error('chat-providers.js 没能挂上 window.ChatProviders');
    }
    ctx.callAnthropicChat = fakeWindow.ChatProviders.callAnthropicChat;

    const {
        modelsEndpointFor, parseModelList, fetchModelList, populateModelSelect,
        callAnthropicChat, ClientApiError,
        setGetResults, resetGetCalls, getCalls, postCalls, lastGet, lastPost,
        alertMessages,
    } = ctx;

    void ClientApiError;

    /**
     * 造一个最小的假 DOM，够 populateModelSelect 用。
     * `input.value` 是可观察的核心 —— 真正发给服务商的是它，不是下拉框。
     */
    function fakeForm(inputValue = '') {
        const options = [];
        return {
            input: { value: inputValue },
            select: {
                classList: { removed: [], remove(cl) { this.removed.push(cl); } },
                appendChild(o) { options.push(o); },
                set innerHTML(v) { if (v === '') options.length = 0; },
                value: '',
                onchange: null,
            },
            options,
            btn: { textContent: '🔄 获取模型' },
        };
    }

    // 断言适配器：原脚本用 check / has / throws 三种风格，语义照抄。
    function check(label, actual, expected) {
        const a = JSON.stringify(actual);
        const b = JSON.stringify(expected);
        const same = a === b;
        c.ok(same, label, same ? '' : `got=${a} want=${b}`);
    }
    function has(label, actual, needle) {
        const same = String(actual ?? '').includes(needle);
        c.ok(same, label, same ? '' : `got=${JSON.stringify(actual)}，应包含 ${JSON.stringify(needle)}`);
    }
    function throws(label, fn, expect) {
        let err = null;
        try { fn(); } catch (e) { err = e; }
        const same = Boolean(err) && (expect ? String(err.message).includes(expect) : true);
        c.ok(same, label, same ? '' : `got=${err ? err.message : '（没抛错）'}，应包含 ${JSON.stringify(expect || '任何错误')}`);
    }

    // ---------- 一、地址拼接（这次故障的真因）----------
    console.log('\n— 地址拼接 —');
    check('Anthropic 官方裸域名 → /v1/models（原来拼成 /models，404）',
        modelsEndpointFor('https://api.anthropic.com', 'anthropic'),
        'https://api.anthropic.com/v1/models');
    check('Anthropic 已带 /v1 → 不重复拼',
        modelsEndpointFor('https://api.anthropic.com/v1', 'anthropic'),
        'https://api.anthropic.com/v1/models');
    check('Anthropic 结尾多余斜杠被吃掉',
        modelsEndpointFor('https://api.anthropic.com/v1/', 'anthropic'),
        'https://api.anthropic.com/v1/models');
    check('Anthropic 粘了完整 /v1/messages → 剥掉再拼',
        modelsEndpointFor('https://api.anthropic.com/v1/messages', 'anthropic'),
        'https://api.anthropic.com/v1/models');
    check('Anthropic 已经指向 /v1/models → 原样用',
        modelsEndpointFor('https://api.anthropic.com/v1/models', 'anthropic'),
        'https://api.anthropic.com/v1/models');
    check('Anthropic 中转站裸域名 → /v1/models（和对话的 /v1/messages 对齐）',
        modelsEndpointFor('https://newapi.gay', 'anthropic'),
        'https://newapi.gay/v1/models');

    check('OpenAI 兼容 + 裸域名 → /models（**不加** /v1，与对话地址规则一致）',
        modelsEndpointFor('https://api.deepseek.com', 'openai-compatible'),
        'https://api.deepseek.com/models');
    check('OpenAI 兼容 + /v1 → /v1/models',
        modelsEndpointFor('https://api.openai.com/v1', 'openai-compatible'),
        'https://api.openai.com/v1/models');
    check('OpenAI 兼容 粘了 /chat/completions → 剥掉',
        modelsEndpointFor('https://api.siliconflow.cn/v1/chat/completions', 'openai-compatible'),
        'https://api.siliconflow.cn/v1/models');
    check('Responses 粘了 /responses → 剥掉',
        modelsEndpointFor('https://api.openai.com/v1/responses', 'openai-responses'),
        'https://api.openai.com/v1/models');
    throws('没填 Base URL → 明确报"请先填写"', () => modelsEndpointFor('', 'anthropic'), '请先填写');

    // 核心不变量：模型列表地址必须和**对话**地址同源（只差最后一段）
    // 破坏它就会出现"对话能通、获取模型 404"这种最费解的现象。
    console.log('\n— 不变量：与对话地址同源 —');
    async function chatEndpoint(baseUrl) {
        await callAnthropicChat([{ role: 'user', content: 'hi' }], {}, { apiKey: 'k', model: 'claude-sonnet-4-5', baseUrl });
        return lastPost().url;
    }
    for (const base of ['https://api.anthropic.com', 'https://api.anthropic.com/v1', 'https://newapi.gay', 'https://newapi.gay/v1/']) {
        const chat = await chatEndpoint(base);
        check(`${base} → 模型地址 == 对话地址换掉末段`,
            modelsEndpointFor(base, 'anthropic'),
            chat.replace(/\/messages$/, '/models'));
    }

    // ---------- 二、认证头与请求 ----------
    console.log('\n— 认证头 —');
    setGetResults([{ ok: true, status: 200, payload: { data: [{ id: 'claude-sonnet-4-5' }] } }]);
    await fetchModelList('https://api.anthropic.com', 'sk-ant-test', 'anthropic');
    check('Anthropic 用 x-api-key（不是 Bearer）', lastGet().headers['x-api-key'], 'sk-ant-test');
    check('Anthropic 带 anthropic-version', lastGet().headers['anthropic-version'], '2023-06-01');
    check('Anthropic 不混进 Authorization', 'Authorization' in lastGet().headers, false);
    has('Anthropic 带 limit=1000（默认只回 20 条，不指定会静默截断）', lastGet().url, 'limit=1000');
    check('走设备层（GET 出口），不是裸 fetch', getCalls.length >= 1, true);

    setGetResults([{ ok: true, status: 200, payload: { data: [{ id: 'deepseek-chat' }] } }]);
    await fetchModelList('https://api.deepseek.com', 'sk-test', 'openai-compatible');
    check('OpenAI 兼容用 Bearer', lastGet().headers.Authorization, 'Bearer sk-test');
    check('OpenAI 兼容不带 anthropic-version', 'anthropic-version' in lastGet().headers, false);
    check('OpenAI 兼容不加 limit 参数（不是所有服务都认）', lastGet().url, 'https://api.deepseek.com/models');

    // ---------- 三、响应解析 ----------
    console.log('\n— 响应解析 —');
    check('Anthropic 的 data[].id（display_name 不参与取值）',
        parseModelList({ data: [
            { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5' },
            { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
        ] }),
        ['claude-haiku-4-5', 'claude-opus-5']);
    check('OpenAI 的 data[].id',
        parseModelList({ data: [{ id: 'gpt-4.1-mini' }, { id: 'gpt-4.1' }] }),
        ['gpt-4.1', 'gpt-4.1-mini']);
    check('data 里混着裸字符串也认',
        parseModelList({ data: ['b-model', { id: 'a-model' }] }),
        ['a-model', 'b-model']);
    check('没有 id 的条目被过滤掉', parseModelList({ data: [{ id: 'ok' }, {}, { id: '' }, null] }), ['ok']);
    check('没有 data 字段 → 空数组（不抛错）', parseModelList({}), []);
    check('payload 为 null → 空数组', parseModelList(null), []);
    check('结果按字母序（下拉框里好找）', parseModelList({ data: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] }), ['a', 'b', 'c']);

    // ---------- 四、Anthropic 失败后退一步重试 ----------
    // 第三方中转（new-api 系）的 /v1/models 常常只认 Bearer，不认 x-api-key。
    console.log('\n— Anthropic 的认证降级 —');
    resetGetCalls();
    setGetResults([
        { ok: false, status: 401, payload: { error: { message: 'authentication_error' } } },
        { ok: true, status: 200, payload: { data: [{ id: 'claude-sonnet-4-5' }] } },
    ]);
    check('401 后换 Bearer 再试一次并成功',
        await fetchModelList('https://newapi.gay', 'sk-test', 'anthropic'),
        ['claude-sonnet-4-5']);
    check('  第二次请求用的是 Bearer', lastGet().headers.Authorization, 'Bearer sk-test');
    check('  总共发了 2 次请求', getCalls.length, 2);

    setGetResults([
        { ok: false, status: 404, payload: null },
        { ok: true, status: 200, payload: { data: [{ id: 'claude-opus-5' }] } },
    ]);
    check('404 也会退一步重试（有些中转根本没有 Anthropic 风格的路由）',
        await fetchModelList('https://newapi.gay', 'sk-test', 'anthropic'),
        ['claude-opus-5']);

    resetGetCalls();
    setGetResults([{ ok: false, status: 500, payload: { error: { message: 'upstream busy' } } }]);
    let serverErr = null;
    try { await fetchModelList('https://newapi.gay', 'sk-test', 'anthropic'); } catch (e) { serverErr = e.message; }
    check('5xx 不重试（换一条路也一样失败，别白打一次请求）', getCalls.length, 1);
    has('  并把上游的原话透出来', serverErr, 'upstream busy');

    resetGetCalls();
    setGetResults([{ ok: false, status: 401, payload: { error: { message: 'invalid x-api-key' } } }]);
    let bothFail = null;
    try { await fetchModelList('https://api.anthropic.com', 'bad-key', 'anthropic'); } catch (e) { bothFail = e.message; }
    check('两条路都失败时发了 2 次', getCalls.length, 2);
    has('  报错保留**第一次**的原因（Anthropic 风格那条更可能是真相）', bothFail, 'invalid x-api-key');

    resetGetCalls();
    setGetResults([new Error('Failed to fetch')]);
    let thrown = null;
    try { await fetchModelList('https://api.anthropic.com', 'sk-test', 'anthropic'); } catch (e) { thrown = e.message; }
    check('网络层直接抛错时不重试（连不上，换条路也一样）', getCalls.length, 1);
    has('  原样把错误抛出去', thrown, 'Failed to fetch');

    // 反向：OpenAI 系**不该**有第二次尝试
    resetGetCalls();
    setGetResults([{ ok: false, status: 401, payload: { error: { message: 'invalid key' } } }]);
    try { await fetchModelList('https://api.deepseek.com', 'bad', 'openai-compatible'); } catch {}
    check('OpenAI 系 401 只发 1 次（没有"换认证头"这条路）', getCalls.length, 1);

    // ---------- 五、200 但空列表 ----------
    console.log('\n— 空列表 —');
    resetGetCalls();
    setGetResults([{ ok: true, status: 200, payload: { data: [] } }]);
    let empty = null;
    try { await fetchModelList('https://api.anthropic.com', 'sk-test', 'anthropic'); } catch (e) { empty = e.message; }
    has('200 + data 为空 → 说清"data 为空"', empty, 'data 为空');
    has('  并给出实际请求的地址（便于用户自查）', empty, '/v1/models');
    check('  200 不该被当成"认证问题"去重试', getCalls.length, 1);

    // ---------- 五之二、200 却拿回 HTML 首页（地址少版本段的典型症状）----------
    //
    // 真实故障：Base URL 填 `https://newapi.gay`（少 /v1）时，`/models` 打到了站点首页，
    // 返回 200 + text/html。旧代码解析不出 data，报"可能该服务不支持 /models" ——
    // 把人引向完全错误的方向（实测 /v1/models 才是真接口，只是缺 Key 才 401）。
    console.log('\n— 200 但返回 HTML（少版本段）—');
    resetGetCalls();
    setGetResults([{
        ok: true, status: 200,
        payload: null,
        rawText: '<!doctype html>\n<html lang="en"><head><title>New API</title></head></html>',
    }]);
    let htmlCase = null;
    try { await fetchModelList('https://newapi.gay', 'sk-test', 'openai-compatible'); } catch (e) { htmlCase = e.message; }
    has('200 + HTML → 点明"返回的是网页，不是 API 响应"', htmlCase, '网页');
    has('  并建议补上 /v1', htmlCase, '/v1');
    has('  且写出实际请求的地址', htmlCase, 'newapi.gay/models');

    // 200 但返回的不是 JSON（非 HTML 的其它脏数据）
    resetGetCalls();
    setGetResults([{ ok: true, status: 200, payload: null, rawText: 'not json at all' }]);
    let badJson = null;
    try { await fetchModelList('https://newapi.gay/v1', 'sk-test', 'openai-compatible'); } catch (e) { badJson = e.message; }
    has('200 + 非 JSON → 报"不是有效 JSON"并附原文开头', badJson, '不是有效 JSON');
    has('  原文开头被带出来（便于判断到底拿到了什么）', badJson, 'not json at all');

    // ---------- 六、拉到列表之后要真的填进模型名输入框 ----------
    //
    // 真实故障：Anthropic 下「获取模型」能成功拉到列表，但**模型名输入框没被填上**，
    // 于是下拉框出现了、真正发出去的却还是切格式时自动填的预设名（如
    // `claude-sonnet-4-20250514`）—— 那个名字往往不在真实列表里，一对话就 404。
    //
    // 根因：populateModelSelect 只填了 <select>，从没给 <input> 赋值；
    // 而 readProviderSettingsForm 读的是 **input** 的值。两者脱节，功能等于没生效。
    //
    // 为什么以前没被发现：本检查只覆盖了 fetchModelList / parseModelList（"能不能拉到"），
    // 没有覆盖"拉到之后有没有回填"。
    console.log('\n— 拉到列表后回填输入框 —');
    // 各格式的预设模型名（与 index.html 的 CHAT_API_FORMATS 对应）
    const PRESET_MODELS = ['deepseek-chat', 'gpt-4.1-mini', 'claude-sonnet-4-20250514'];

    // 真实故障场景：Anthropic 切格式时自动填了预设名，而它不在真实列表里
    {
        const form = fakeForm('claude-sonnet-4-20250514');
        setGetResults([{ ok: true, status: 200, payload: { data: [
            { id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' },
        ] } }]);
        await populateModelSelect({
            btn: form.btn, input: form.input, select: form.select,
            baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-x', apiFormat: 'anthropic',
            defaultModels: PRESET_MODELS,
        });
        check('下拉框被填上了', form.options.map(o => o.value), ['claude-haiku-4-5', 'claude-opus-5']);
        // ★ 2026-10 改判据：组合框改造后，候选**不再靠取消 select 的 hidden 来显示**
        //   （select 退回纯数据源，可见的是右三角展开的浮层列表）。
        //   所以这里断言的是"没有去动 hidden"—— 动了才说明旧的可视逻辑又回来了。
        check('  候选进了数据源（不再把 select 显示出来）',
            form.select.classList.removed.includes('hidden'), false);
        check('输入框被覆盖成列表里的真实模型',
            ['claude-haiku-4-5', 'claude-opus-5'].includes(form.input.value), true);
        check('  不能还是那个不在列表里的预设名',
            form.input.value === 'claude-sonnet-4-20250514', false);
    }

    // 用户手填的名字**在列表里**时不该被覆盖 —— 尊重用户的选择
    {
        const form = fakeForm('claude-opus-5');
        setGetResults([{ ok: true, status: 200, payload: { data: [
            { id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' },
        ] } }]);
        await populateModelSelect({
            btn: form.btn, input: form.input, select: form.select,
            baseUrl: 'https://api.anthropic.com', apiKey: 'k', apiFormat: 'anthropic',
            defaultModels: PRESET_MODELS,
        });
        check('用户已填且存在于列表 → 保留用户的选择', form.input.value, 'claude-opus-5');
        check('  下拉框同步选中该项', form.select.value, 'claude-opus-5');
    }

    // 用户手填的名字**不在列表里**、且不是预设值（中转站的私有别名）→ 不覆盖。
    // 这是刻意与"预设名"区别对待的：预设名是应用自己填的，别名是用户故意填的。
    {
        const form = fakeForm('my-custom-alias');
        setGetResults([{ ok: true, status: 200, payload: { data: [{ id: 'claude-opus-5' }] } }]);
        await populateModelSelect({
            btn: form.btn, input: form.input, select: form.select,
            baseUrl: 'https://newapi.gay', apiKey: 'k', apiFormat: 'anthropic',
            defaultModels: PRESET_MODELS,
        });
        check('用户手填的别名不在列表里 → 不覆盖输入框', form.input.value, 'my-custom-alias');
        check('  下拉框选中列表第一项（点一下就能换过去）', form.select.value, 'claude-opus-5');
    }

    // 输入框为空时应该填上，否则"拉到了但没选"依然用不了
    {
        const form = fakeForm('');
        setGetResults([{ ok: true, status: 200, payload: { data: [{ id: 'claude-opus-5' }] } }]);
        await populateModelSelect({
            btn: form.btn, input: form.input, select: form.select,
            baseUrl: 'https://api.anthropic.com', apiKey: 'k', apiFormat: 'anthropic',
            defaultModels: PRESET_MODELS,
        });
        check('输入框为空 → 填上列表第一项', form.input.value, 'claude-opus-5');
    }

    // 手动选下拉框时要同步进输入框（原有行为，别在修 bug 时弄丢）
    {
        const form = fakeForm('');
        setGetResults([{ ok: true, status: 200, payload: { data: [{ id: 'a-model' }, { id: 'b-model' }] } }]);
        await populateModelSelect({
            btn: form.btn, input: form.input, select: form.select,
            baseUrl: 'https://api.anthropic.com', apiKey: 'k', apiFormat: 'anthropic',
            defaultModels: PRESET_MODELS,
        });
        form.select.value = 'b-model';
        form.select.onchange();
        check('手动选下拉框 → 同步进输入框', form.input.value, 'b-model');
    }

    // 边界：预设名**恰好有效**时必须保留，不能被换成列表第一项。
    // 这是"预设名"与"真实列表"两个条件同时成立的情况 —— 判断顺序写反就会在这里翻车。
    {
        const form = fakeForm('claude-sonnet-4-20250514');
        setGetResults([{ ok: true, status: 200, payload: { data: [
            { id: 'claude-haiku-4-5' }, { id: 'claude-sonnet-4-20250514' },
        ] } }]);
        await populateModelSelect({
            btn: form.btn, input: form.input, select: form.select,
            baseUrl: 'https://api.anthropic.com', apiKey: 'k', apiFormat: 'anthropic',
            defaultModels: PRESET_MODELS,
        });
        check('预设名恰好存在于列表 → 保留它（不越权换成第一项）',
            form.input.value, 'claude-sonnet-4-20250514');
        check('  下拉框同步选中该项', form.select.value, 'claude-sonnet-4-20250514');
    }

    // 失败时不能改动输入框，也不能让按钮卡在"获取中"
    {
        const form = fakeForm('keep-me');
        setGetResults([{ ok: false, status: 401, payload: { error: { message: 'bad key' } } }]);
        await populateModelSelect({
            btn: form.btn, input: form.input, select: form.select,
            baseUrl: 'https://api.anthropic.com', apiKey: 'bad', apiFormat: 'anthropic',
            defaultModels: PRESET_MODELS,
        });
        check('失败时输入框原样不动', form.input.value, 'keep-me');
        check('失败时按钮文案恢复', form.btn.textContent, '🔄 获取模型');
        check('失败时给出提示', alertMessages.length > 0, true);
    }

    void postCalls;
}

// ────────────────────────────────────────────────────────────
// 4. 思考参数的严格网关兼容（2026-09，实测 AMD Radeon 端点 400）
//
// ── 背景 ────────────────────────────────────────────────────────────────
//
// 用户实测：AMD 的 OpenAI 兼容端点对 `thinking` 字段回 400 ——
//   "thinking" is not supported … Use "reasoning_effort"
// 而同时发 thinking + reasoning_effort 还会被某些网关拒
// （Roo-Code #11001：volcengine "Invalid combination"）。
// GitHub 调研结论：没有哪个思考字段全网通用，成熟做法是
// **先发 → 400 且报错点名参数 → 按点名剥参数重试**（hermes-agent #34786）。
//
// ── 这里的兼容契约 ──────────────────────────────────────────────────────
//
//   · 认 thinking 的网关（DeepSeek 官方/中转）→ 第一次就成功，行为不变
//   · 不认的网关（AMD/OpenAI 官方）→ 第一次 400，自动剥掉被点名的参数重发，
//     用户无感；报错点名 reasoning_effort 时只剥它
//   · 其它 400（图片太大等）→ 不剥参数、照常抛错（剥了也解决不了）
//
// 测试方式：按对话适配器检查的依赖注入套路，用假 fetch 真跑
// callOpenAICompatibleChat，捕获每次请求体做断言。
// ────────────────────────────────────────────────────────────

async function caseThinkingCompat(c) {
    const src = readFileSync(PROVIDERS_FILE, 'utf8');

    // 从 chat-providers.js 里截出 rejectedRequestParam（按大括号配对）单测
    function grabFn(source, name) {
        const i = source.indexOf('function ' + name);
        if (i < 0) throw new Error('not found: ' + name);
        let depth = 0, started = false, end = i;
        for (let k = i; k < source.length; k++) {
            if (source[k] === '{') { depth++; started = true; }
            else if (source[k] === '}') { depth--; if (started && depth === 0) { end = k; break; } }
        }
        return source.slice(i, end + 1);
    }
    const rejectedRequestParam = new Function(
        grabFn(src, 'rejectedRequestParam') + '\nreturn rejectedRequestParam;'
    )();

    // ---------- 单测 rejectedRequestParam ----------
    console.log('=== 1. rejectedRequestParam：从 400 里认出被拒参数 ===');
    {
        const amdPayload = {
            error: {
                message: '"thinking" is not supported on /v1/chat/completions and was not applied. Use "reasoning_effort" (or "reasoning.effort") to control thinking.',
                type: 'invalid_request_error',
                param: 'thinking',
                code: 'unsupported_parameter',
            },
        };
        c.ok(rejectedRequestParam({ status: 400, payload: amdPayload, rawText: JSON.stringify(amdPayload) }) === 'thinking',
            '★ AMD 报错（param 字段）→ thinking');
        c.ok(rejectedRequestParam({ status: 400, rawText: 'Invalid reasoning_effort for this model' }) === 'reasoning_effort',
            '★ 文本点名 reasoning_effort → reasoning_effort');
        c.ok(rejectedRequestParam({ status: 400, rawText: "cannot specify both 'thinking' and 'reasoning_effort'" }) === 'thinking',
            '★ "both thinking and reasoning_effort" → thinking（连带剥强度）');
        c.ok(rejectedRequestParam({ status: 400, payload: { error: { message: '图片过大 max 20MB' } }, rawText: '图片过大' }) === null,
            '★ 其它 400（图片类）→ null（不剥参数，照常抛错）');
        c.ok(rejectedRequestParam({ status: 500, rawText: 'thinking not supported' }) === null,
            '★ 非 400 → null（5xx 不是参数问题）');
    }

    // ---------- 集成：真跑 callOpenAICompatibleChat ----------
    console.log('\n=== 2. 集成：假网关真跑，看降级重试 ===');
    // chat-providers.js 是普通 <script>，靠 window.ChatDeps 取依赖 ——
    // 在 eval 之前就建好 window，场景之间只换 window.ChatDeps 的内容。
    //
    // ⚠️ 用**局部** window 而不是 globalThis.window：每个用例跑在同一进程里，
    //    往全局挂 window 会与其它用例互相覆盖。
    const win = { ChatDeps: null };
    // 最小化的 deps() 套路：与对话适配器检查相同
    // 注意：把同一个 window 对象传进去（deps() 调用时读 window.ChatDeps），
    // 场景里改 window.ChatDeps 才能生效。
    const ChatProviders = new Function(
        'window',
        src + '\nreturn window.ChatProviders;'
    )(win);

    // requestChatJson 的最小假实现：记录请求体，按脚本决定返回
    // responses: [{ match(body, n), reply: {ok, status, payload} }]
    function makeDeps(script, captured) {
        return {
            ClientApiError: class ClientApiError extends Error {
                constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra || {}); }
            },
            getChatBaseUrl: (s) => String(s.baseUrl || '').replace(/\/$/, ''),
            isDeepSeekOfficial: (u) => /deepseek\.com/.test(u || ''),
            buildThinkingParams: null,   // 下面注入真实现（从 core.js 截取）
            normalizeChatReply: (content, reasoning) => ({ content, reasoning }),
            throwProviderResponseError: async (result) => {
                const err = new Error('HTTP ' + result.status);
                err.providerLogged = true;
                throw err;
            },
            requestChatJson: async (endpoint, body) => {
                captured.push({ endpoint, body });
                for (const s of script) {
                    if (s.match(body, captured.length)) return s.reply;
                }
                return { ok: true, status: 200, payload: { choices: [{ message: { content: 'OK' } }] } };
            },
        };
    }

    // 从 core.js 截真实现（别在测试里重写一遍逻辑 —— 测的不是真代码就没意义）
    const coreSrc = readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');
    function grabCore(name) {
        const i = coreSrc.indexOf('function ' + name);
        let depth = 0, started = false, end = i;
        for (let k = i; k < coreSrc.length; k++) {
            if (coreSrc[k] === '{') { depth++; started = true; }
            else if (coreSrc[k] === '}') { depth--; if (started && depth === 0) { end = k; break; } }
        }
        return coreSrc.slice(i, end + 1);
    }
    const realBuildThinkingParams = new Function(
        'isDeepSeekOfficial', 'mapThinkingEffort',
        grabCore('detectThinkingVendor') + '\n' + grabCore('buildThinkingParams') +
        '\nreturn buildThinkingParams;'
    )((u) => /deepseek\.com/.test(u || ''), (l) => l);

    const settings = {
        apiKey: 'test-key',
        model: 'gpt-oss',
        baseUrl: 'https://developer.amd.com.cn/radeon/api/v1',
    };
    const opts = { thinking: false, thinkingEffort: 'medium', maxTokens: 100 };

    // 场景 A：AMD 式网关 —— 带 thinking 字段就 400，剥掉就 200。
    //
    // ★ 模型名故意用 deepseek-v4-pro：让 vendor 判定走"模型名兜底"变成
    //   deepseek（真实场景 —— 用户在 AMD 网关上跑 DeepSeek 模型，或中转站
    //   包着 DeepSeek）。这才能测到**降级路径**：第一次带 thinking 被 400，
    //   剥掉后重试成功。若是普通模型名，core.js 的修复已经不发 thinking
    //   （那也是一条已验证的正确路径 —— 场景 A 的第一次请求断言就是它）。
    {
        const captured = [];
        const amd = makeDeps(null, captured);
        amd.buildThinkingParams = realBuildThinkingParams;
        amd.requestChatJson = async (endpoint, body) => {
            captured.push({ endpoint, body });
            if ('thinking' in body) {
                const payload = {
                    error: {
                        message: '"thinking" is not supported on /v1/chat/completions and was not applied. Use "reasoning_effort".',
                        type: 'invalid_request_error', param: 'thinking', code: 'unsupported_parameter',
                    },
                };
                return { ok: false, status: 400, payload, rawText: JSON.stringify(payload) };
            }
            return { ok: true, status: 200, payload: { choices: [{ message: { content: 'AMD_OK' } }] } };
        };
        win.ChatDeps = amd;
        const r = await ChatProviders.callOpenAICompatibleChat([{ role: 'user', content: 'hi' }], opts,
            { ...settings, model: 'deepseek-v4-pro' });
        c.ok(r.content === 'AMD_OK', '★ AMD 网关 + DeepSeek 模型：400 后自动剥 thinking 重试成功', JSON.stringify(r));
        c.ok(captured.length === 2, '恰好发了两次（首次 + 降级重试）', String(captured.length));
        c.ok('thinking' in captured[0].body, '★ 第一次仍带 thinking（DeepSeek 模型的正常行为）');
        c.ok(!('thinking' in captured[1].body), '★ 第二次剥掉了 thinking', JSON.stringify(captured[1].body));
        c.ok(captured[1].body.max_tokens === 100 && Array.isArray(captured[1].body.messages),
            '重试请求其余字段原样保留（messages/max_tokens 不丢）');
    }

    // 场景 A2：AMD 网关 + 普通模型（vendor=generic）—— 现在也带 thinking 字段
    // （设计定稿：一律发，兼容靠 400 降级），但会通过 AMD 的 400 触发降级后成功。
    {
        const captured = [];
        const amd = makeDeps(null, captured);
        amd.buildThinkingParams = realBuildThinkingParams;
        amd.requestChatJson = async (endpoint, body) => {
            captured.push({ endpoint, body });
            if ('thinking' in body) {
                return { ok: false, status: 400, payload: { error: { message: 'thinking not supported', param: 'thinking' } }, rawText: 'x' };
            }
            return { ok: true, status: 200, payload: { choices: [{ message: { content: 'GENERIC_OK' } }] } };
        };
        win.ChatDeps = amd;
        const r = await ChatProviders.callOpenAICompatibleChat([{ role: 'user', content: 'hi' }], opts, settings);
        c.ok(r.content === 'GENERIC_OK', '★ 普通模型 + AMD 网关：降级后成功');
        c.ok(captured.length === 2, '首次带 thinking 被 400，重试剥掉后通过', String(captured.length));
        c.ok('thinking' in captured[0].body && !('thinking' in captured[1].body),
            '★ 关思考请求第一次也带显式 disabled（DeepSeek 系网关需要它）',
            JSON.stringify(captured[0]?.body.thinking));
    }

    // 场景 B：DeepSeek 官方 —— 第一次就成功，thinking 字段照发（关闭态必须 disabled）
    {
        const captured = [];
        const ds = makeDeps(null, captured);
        ds.buildThinkingParams = realBuildThinkingParams;
        ds.requestChatJson = async (endpoint, body) => {
            captured.push({ endpoint, body });
            return { ok: true, status: 200, payload: { choices: [{ message: { content: 'DS_OK' } }] } };
        };
        win.ChatDeps = ds;
        const r = await ChatProviders.callOpenAICompatibleChat(
            [{ role: 'user', content: 'hi' }], opts,
            { apiKey: 'k', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' });
        c.ok(r.content === 'DS_OK', 'DeepSeek 官方：一次成功');
        c.ok(captured.length === 1, '没有多余重试', String(captured.length));
        c.ok(captured[0].body.thinking?.type === 'disabled',
            '★ 关思考时仍显式发 thinking.disabled（DeepSeek 默认开启，不发关不掉）',
            JSON.stringify(captured[0].body.thinking));
    }

    // 场景 C：其它 400（剥参数解决不了）→ 不重试，直接抛
    {
        const captured = [];
        const img = makeDeps(null, captured);
        img.buildThinkingParams = realBuildThinkingParams;
        img.requestChatJson = async (endpoint, body) => {
            captured.push({ endpoint, body });
            const payload = { error: { message: 'image too large', type: 'invalid_request_error', param: 'image' } };
            return { ok: false, status: 400, payload, rawText: 'image too large' };
        };
        win.ChatDeps = img;
        let threw = null;
        try {
            await ChatProviders.callOpenAICompatibleChat([{ role: 'user', content: 'hi' }], opts, settings);
        } catch (e) { threw = e; }
        c.ok(Boolean(threw), '★ 非 thinking 类 400 照常抛错', threw && threw.message);
        c.ok(captured.length === 1, '★ 不做无意义的重试（剥图片参数解决不了问题）', String(captured.length));
    }

    // ---------- 源码层：warn 一行是英文事实行 ----------
    console.log('\n=== 3. 降级时有日志痕迹 ===');
    {
        c.ok(/\[Provider\] gateway rejected "\$\{param\}"/.test(src),
            '★ 降级重试留一行英文 warn（可 grep）');
    }
}

// ────────────────────────────────────────────────────────────
// 5. 发给服务商之前，开头连续的 system 消息必须被合并成一条
//
// 背景（真实故障）：某些自建/中转网关**只接受一条 system 消息**。实测
// `developer.amd.com.cn` 的 `self-dploy` 后端：
//   [system, user]          → 200
//   [system, system, user]  → 400 "System message must be at the beginning."
// 报错文案有误导性 —— 它说的其实是"system 消息只能有一条，不能有第二条"。
//
// 而本应用的 layered-v2 提示词结构一次会发 4~10 条 system（核心协议 / 世界观 / 角色卡 /
// Live2D 标签 / 会话设定 / 记忆规则 / 图片一致性 / 配音格式 / 回合锚点 / 模型可用表现 /
// 水印 / Agent 权限），在这类网关上一个字都发不出去。
//
// 做法：把 index.html 里的真实函数体抠出来跑，不复制逻辑、不联网。
// ────────────────────────────────────────────────────────────

async function caseMessageShape(c) {
    const html = readFrontend();

    const { mergeLeadingSystemMessages } = new Function(`
        ${extractFnFrom(html, 'extractTextContent')}
        ${extractFnFrom(html, 'mergeLeadingSystemMessages')}
        return { mergeLeadingSystemMessages };
    `)();

    // 断言适配器：原脚本的 check(label, actual, expected) 双参风格，语义照抄
    function check(label, actual, expected) {
        const a = JSON.stringify(actual);
        const b = JSON.stringify(expected);
        const same = a === b;
        c.ok(same, label, same ? '' : `got=${a} want=${b}`);
    }

    const S = (s) => ({ role: 'system', content: s });
    const U = (s) => ({ role: 'user', content: s });
    const A = (s) => ({ role: 'assistant', content: s });
    const roles = (ms) => ms.map((m) => m.role);

    // —— 不该动的情况 ——
    check('空数组原样返回', mergeLeadingSystemMessages([]), []);
    check('单条 system 不合并', roles(mergeLeadingSystemMessages([S('a'), U('x')])), ['system', 'user']);
    check('没有 system 时不动', roles(mergeLeadingSystemMessages([U('x'), A('y')])), ['user', 'assistant']);
    check('只有 user 时不动', roles(mergeLeadingSystemMessages([U('x')])), ['user']);
    check('非数组入参不炸', mergeLeadingSystemMessages(null), []);

    // —— 该合并的情况（核心修复）——
    const many = [S('核心协议'), S('# 世界观\n魔法世界'), S('# 角色卡\n伊蕾娜'), S('# Live2D 标签'), U('你好'), A('你好呀'), U('只回复OK')];
    const merged = mergeLeadingSystemMessages(many);
    check('8 条 system + 历史 → 只剩 1 条 system', roles(merged), ['system', 'user', 'assistant', 'user']);
    check('system 仍在位置 0', merged[0].role, 'system');
    check('内容一条不少（空行分隔）', merged[0].content, '核心协议\n\n# 世界观\n魔法世界\n\n# 角色卡\n伊蕾娜\n\n# Live2D 标签');
    check('历史消息未被改动', merged.slice(1), [U('你好'), A('你好呀'), U('只回复OK')]);

    // —— 边界 ——
    const withEmpty = mergeLeadingSystemMessages([S('a'), S('   '), S('b'), U('x')]);
    check('空白的 system 被过滤掉', withEmpty[0].content, 'a\n\nb');
    check('全是空白 system → 合成空串仍占一条（不产生 0 条 system 的怪状态）', roles(mergeLeadingSystemMessages([S(''), S(''), U('x')])), ['system', 'user']);

    const arrayContent = mergeLeadingSystemMessages([S([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }]), S('丙'), U('x')]);
    check('数组形式的 system 内容也能拍平', arrayContent[0].content, '甲乙\n\n丙');

    // —— 关键：中间的 system 不该被这里掩盖（那是另一种错误，要留给服务商报出来）——
    const middleSystem = [U('x'), S('s'), U('y')];
    check('system 在中间时不动它（不掩盖别的错误）', roles(mergeLeadingSystemMessages(middleSystem)), ['user', 'system', 'user']);

    // —— 模拟真实分层结构：12 条 system ——
    const layered = [
        S('核心协议'), S('世界观'), S('角色卡'), S('Live2D 标签指南'), S('会话专属设定'), S('记忆规则'),
        S('图片一致性'), S('配音格式'), S('回合锚点'), S('模型可用表现'), S('水印提示'), S('Agent 权限'),
        U('你好'), A('你好呀'), U('只回复OK'),
    ];
    const layeredMerged = mergeLeadingSystemMessages(layered);
    check('真实分层结构：12 条 system → 1 条', layeredMerged.filter((m) => m.role === 'system').length, 1);
    check('真实分层结构：总条数 15 → 4', layeredMerged.length, 4);
    check('真实分层结构：位置 0 是 system', layeredMerged[0].role, 'system');
    check('真实分层结构：每段内容都还在', layered.every((m) => m.role !== 'system' || layeredMerged[0].content.includes(m.content)), true);
}

// ────────────────────────────────────────────────────────────
// 6. 授权策略三档 + 聊天停止按钮
//
// 两项用户反馈：
//   1. 手机操作授权「每次运行只确认一次」并设为默认
//   2. 聊天发送按钮二态（AI 回复中变红色停止）+ 请求可中断
//
// 注：原先的 Edge TTS 一节已随 Edge TTS provider 一起删除 —— 它断言的
// `speakTextEdge` / `#settingEdgeTtsVoice` / `/api/tts/edge` 都已不存在。
// 现在 TTS 默认走 MiMo（见前端 DOM 引用检查与前端源码）。
// ────────────────────────────────────────────────────────────

async function caseStopAndAuth(c) {
    const html = readFrontend();
    const providers = readFileSync(PROVIDERS_FILE, 'utf8');

    // ============================================================ 1. 授权策略
    //
    // ★★ 2026-10 权限模型重构：这一节原来验证的是**旧的四档手机策略**
    //   （once / run / always / off 的 UI、默认值与豁免语义）。那套已整体删除，
    //   改成一个三档设置 agentAccess（strict / auto / full）同时管电脑与手机。
    //   所以本节改为断言新模型的三件事：UI 三档齐全、默认最严、迁移向宽松倒。
    //   三档的**运行时行为**由 AI Agent 检查（check-agent.mjs）覆盖（那里跑真实函数）。
    console.log('=== 1. 授权策略：三档 agentAccess ===');
    {
        for (const v of ['strict', 'auto', 'full']) {
            c.ok(new RegExp('name="agentAccess" value="' + v + '"').test(html), `UI 有 ${v} 档`);
        }
        c.ok(/agentAccess: 'strict'/.test(html), '默认设置是最严的 strict');
        c.ok(!/name="agentApproval"/.test(html), '★ 旧的四档 agentApproval UI 已彻底移除');
        c.ok(!/name="agentPermission"/.test(html), '★ 旧的 agentPermission UI 已彻底移除');
        c.ok(/\['strict', 'auto', 'full'\]\.includes\(state\.settings\.agentAccess\)/.test(html)
            || /\['strict', 'auto', 'full'\]/.test(html)
            // ★ 2026-10 修：这条断言原来只认三档字面量 `['strict','auto','full']`，
            //   而档位后来加了 `'off'`（整体关闭电脑操作）——
            //   于是代码里的 `['off','strict','auto','full']` **匹配不上**，
            //   这条断言就一直红着。红的原因是"清单多了一档"，不是"校验没了"，
            //   属于判据过窄（钉死了字面量而不是钉住语义）。
            //   这里放宽成"三档都在合法性清单里"，off 有它自己的断言（见下）。
            || /\['off',\s*'strict',\s*'auto',\s*'full'\]/.test(html)
            || /AGENT_ACCESS_LEVELS\s*=\s*\[[^\]]*'strict'[^\]]*'auto'[^\]]*'full'/.test(html),
            '合法性校验包含三档');
        // ★ 反过来钉住"off 也在清单里"：它是合法档位（关闭电脑操作），
        //   但不能因此把三档的校验悄悄缩水成"只要不是空就行"。
        c.ok(/\['off',\s*'strict',\s*'auto',\s*'full'\]/.test(html)
            || /AGENT_ACCESS_LEVELS\s*=\s*\[[^\]]*'off'/.test(html),
            '★ off 也是合法档位（整体关闭电脑操作）');
        // 迁移取向：用户选的是"向宽松倒"——旧 computer → full
        c.ok(/legacyPermission === 'computer'\) \? 'full' : 'strict'/.test(html),
            '★ 迁移：旧 computer → full（用户选择的向宽松倒）');
        c.ok(/delete state\.settings\.agentPermission/.test(html)
            && /delete state\.settings\.agentApproval/.test(html),
            '迁移后删掉两个旧字段（否则"哪个才是权威"会含糊）');
        // 切到 full 时必须有一次性后果确认（不能静默开启）
        c.ok(/nextAccess === 'full' && currentAgentAccess\(\) !== 'full'/.test(html),
            '★ 切到「完全访问」时弹一次后果确认');
        c.ok(/不会询问你/.test(html), '★ 后果说明里点明"这些操作都不会再询问你"');
    }

    // ============================================================ 2. 停止按钮 + 可中断
    console.log('\n=== 2. 聊天停止按钮 ===');
    {
        c.ok(/onclick="handleComposerButtonClick\(\)"/.test(html), '发送按钮走统一入口（不再直连 handleTextSubmit）');
        c.ok(/function handleComposerButtonClick\(\)/.test(html), '有统一入口函数');
        c.ok(/function stopAiReply\(\)/.test(html), '有 stopAiReply');
        c.ok(html.includes('activeReplyAborts'), '有本轮回复的中断器表');
        c.ok(/replyAbort = new AbortController\(\)/.test(html), '每轮回复创建 AbortController');
        c.ok(/signal: replyAbort\.signal/.test(html), 'signal 传给 callAI');
        c.ok(/signal: options\.signal/.test(html), 'callAI 透传给 callChatAPI');
        c.ok(/async function postJsonFromDevice\(url, body, headers = \{\}, timeoutMs = 120000, signal = null\)/.test(html),
            'postJsonFromDevice 收 signal');
        c.ok(/Promise\.race\(\[run, abortPromise\]\)/.test(html), 'abort 用 race 立即砍掉等待');
        // 图标二态（DSH 式：同一位置一个图标槽，箭头↔暂停）
        c.ok(/composer-state-icon/.test(html), '有统一的图标槽（不是两个图标叠着切 hidden）');
        c.ok(/COMPOSER_ARROW_SVG/.test(html) && /COMPOSER_PAUSE_SVG/.test(html), '箭头与暂停两套 SVG');
        c.ok(/function swapStopIcons/.test(html), 'swapStopIcons 切换图标');
        c.ok(/is-stopping/.test(html), '有 is-stopping 样式类');
        c.ok(!/#ef4444 !important/.test(html), '停止态不做红色突跳（颜色统一，DSH 式）');
        // 设置迁移：★ 2026-10 起旧的两套设置（agentPermission / agentApproval）
        // 合并成三档 agentAccess，所以这里断言的是**新的**迁移逻辑。
        c.ok(/settingsVersion/.test(html), '有 settingsVersion 迁移标记');
        c.ok(/legacyPermission === 'computer'\) \? 'full' : 'strict'/.test(html),
            '迁移逻辑：旧 computer → full，其余 → strict');
        // busy 时按钮可见
        c.ok(/busy \|\| Boolean\(elements\.initialTextInput\.value\.trim\(\)\)/.test(html), 'busy 时按钮强制可见');
        // 停止时安静收尾
        c.ok(/回复已被用户停止，安静收尾/.test(html), '停止后不弹错误框');
        c.ok(/stopActiveVoicePlayback\(\)/.test(html.replace(/async function stopActiveVoicePlayback[\s\S]*?\n        \}/, '')) ||
           /void stopActiveVoicePlayback\(\);/.test(html), '停止时同步停掉语音');
        // providers 透传
        c.ok((providers.match(/opts\.signal/g) || []).length >= 3, '三种协议都透传 signal');
    }
}

// 按命令行参数过滤用例（便于只跑其中一段）
const only = process.argv[2];
const allCases = [
    { name: '对话 API 格式适配器', fn: caseProviders },
    { name: 'Anthropic 请求形状', fn: caseAnthropicRequest },
    { name: '模型列表', fn: caseModelList },
    { name: '思考参数网关兼容', fn: caseThinkingCompat },
    { name: '消息形状合并', fn: caseMessageShape },
    { name: '授权策略与停止按钮', fn: caseStopAndAuth },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: '对话与模型（格式适配 / 请求形状 / 模型列表 / 思考兼容 / 消息合并 / 授权与停止）',
    usage: 'node scripts/check-chat.mjs [用例名子串]',
    cases,
});

void wait; void freePort;
