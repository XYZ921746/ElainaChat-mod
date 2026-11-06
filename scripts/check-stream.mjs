// 流式输出与回合过程（思考开关/强度 → 请求参数 → 流式增量 → 回合过程区）的回归检查。
// 关键契约：关思考必须显式发 thinking:{type:'disabled'}；工具调用行不受思考开关影响；
//    过程行默认折叠但摘要常驻；流式失败退回非流式；已吐内容后不回退重试。
// 用法：node scripts/check-stream.mjs          跑全部
//       node scripts/check-stream.mjs 回合      只跑名字含该子串的用例

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { readFrontend, readHtmlAndStyles } from './frontend-sources.mjs';
import { runChecks, ROOT, wait, freePort } from './check-harness.mjs';
import { extractFunction, extractTopLevelFunctions, extractVariable, makeVmSandbox, runClassicScripts } from './check-source.mjs';

// 1. 流式输出 + 思考模式适配 + 回合过程（思维链 / 工具调用）展示

async function caseStreamAndCot(c) {
    const html = readFrontend();
    const core = readFileSync(path.join(ROOT, 'web', 'js', 'core-config.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'core-state.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'core-chat.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'core-relay.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');
    const ui = readFileSync(path.join(ROOT, 'web', 'js', 'process.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'ui.js'), 'utf8');
    const voice = readFileSync(path.join(ROOT, 'web', 'js', 'asr.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'composer.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'voice.js'), 'utf8');
    const settings = readFileSync(path.join(ROOT, 'web', 'js', 'save.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');
    const init = readFileSync(path.join(ROOT, 'web', 'js', 'bindings.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'init.js'), 'utf8');
    const streamSrc = readFileSync(path.join(ROOT, 'web', 'js', 'chat-stream.js'), 'utf8');
    const providers = readFileSync(path.join(ROOT, 'web', 'js', 'chat-providers.js'), 'utf8');
    // 下面几条断言看的是"折叠规则在不在 @media 之外"，样式住在 base.css
    const indexHtml = readHtmlAndStyles();
    const dataSrc = readFileSync(path.join(ROOT, 'web', 'js', 'roleplay.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'chat.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'data.js'), 'utf8');
    // 6h 用例要看 doAgentCommand / doAgentFile 的确认分支（等待提示与计时重置）
    const agentSrc = readFileSync(path.join(ROOT, 'web', 'js', 'agent-files.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'agent.js'), 'utf8');
    // 本地中继在 server/relay.mjs（两端共用），第 6c 节要在那里找而不是 serve.mjs。
    const relaySrc = readFileSync(path.join(ROOT, 'server', 'relay.mjs'), 'utf8');

    /** 去掉 JS 注释后的源码：注释里常引用被修掉的坏代码，全文断言会被注释反咬成假失败。 */
    function stripComments(src) {
        return String(src)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
    }
    const voiceCode = stripComments(voice);
    const dataCode = stripComments(dataSrc);

    console.log('=== 1. 脚本接线与加载顺序 ===');
    c.ok(/<script[^>]*src="\/js\/chat-stream\.js"[^>]*><\/script>/.test(indexHtml), 'index.html 引入 chat-stream.js');
    {
        const coreIdx = indexHtml.indexOf('/js/core.js');
        const streamIdx = indexHtml.indexOf('/js/chat-stream.js');
        c.ok(coreIdx > 0 && streamIdx > coreIdx, 'chat-stream.js 排在 core.js 之后');
        c.ok(streamIdx < indexHtml.indexOf('/js/data.js'), 'chat-stream.js 排在 data.js 之前');
    }
    c.ok(/window\.ChatStream\s*=/.test(streamSrc), 'chat-stream.js 挂到 window.ChatStream（非模块脚本，跨文件必须走 window）');
    c.ok(/requestChatJson/.test(core) && /requestChatJson,/.test(core), 'core 把 requestChatJson 挂进 window.ChatDeps');
    c.ok(/buildThinkingParams,/.test(core), 'core 把 buildThinkingParams 挂进 window.ChatDeps');

    console.log('\n=== 2. 思考参数（各家真实字段）===');
    // 装整个 core.js 的顶层函数环境实跑：helper 自动在场，且不执行 core.js 的顶层副作用。
    const extractFn = (name, src = core) => extractFunction(src, name);
    const thinkingSandbox = makeVmSandbox({ URL });
    vm.runInContext(
        extractVariable(core, 'THINKING_EFFORTS') + '\n' + extractTopLevelFunctions(core),
        thinkingSandbox,
        { filename: 'core.js#thinking-env' },
    );
    const buildThinkingParams = thinkingSandbox.buildThinkingParams;

    const ds = (enabled, effort) => buildThinkingParams(enabled, effort, 'openai-compatible',
        { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' });

    c.ok(JSON.stringify(ds(false)) === JSON.stringify({ thinking: { type: 'disabled' } }),
        '★ DeepSeek 关思考 → 显式 thinking.type=disabled（服务端默认是开的）', JSON.stringify(ds(false)));
    c.ok(JSON.stringify(ds(true)) === JSON.stringify({ thinking: { type: 'enabled' } }),
        'DeepSeek 开思考 → thinking.type=enabled', JSON.stringify(ds(true)));
    c.ok(ds(true, 'low').reasoning_effort === 'low', 'DeepSeek 低强度 → reasoning_effort=low');
    c.ok(ds(true, 'high').reasoning_effort === 'high', 'DeepSeek 高强度 → reasoning_effort=high');
    c.ok(!('reasoning_effort' in ds(true, 'medium')),
        '已废弃的老档位 medium 不再被识别（不会静默变成 high）');
    // DeepSeek 只认 low/high/max：老档位 medium 不能硬塞成 high，否则用户以为选了中间档
    c.ok(!('reasoning_effort' in ds(true, 'medium')), '★ medium 不被静默改成 high');

    const an = (enabled, effort) => buildThinkingParams(enabled, effort, 'anthropic',
        { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' });
    c.ok(JSON.stringify(an(false)) === JSON.stringify({ reasoning: { effort: 'none' } }),
        'Anthropic 关思考 → reasoning.effort=none', JSON.stringify(an(false)));
    c.ok(!('thinking' in an(true)),
        '★ Anthropic 不发 thinking 字段（那是 Claude 官方 extended thinking，同名不同义，发错会 400）');
    c.ok(an(true, 'low').output_config?.effort === 'low', 'Anthropic 显式档位时补 output_config.effort');

    const rp = (enabled, effort) => buildThinkingParams(enabled, effort, 'openai-responses',
        { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' });
    c.ok(!('reasoning' in rp(false)), 'Responses 关思考 → 不发 reasoning（它没有 none 取值）');
    c.ok(rp(true, 'high').reasoning?.effort === 'high', 'Responses 开思考 → reasoning.effort');

    for (const [fmt, name] of [['openai-compatible', 'OpenAI 兼容'], ['anthropic', 'Anthropic'], ['openai-responses', 'Responses']]) {
        const p = buildThinkingParams(false, 'high', fmt, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
        const flat = JSON.stringify(p);
        c.ok(!/reasoning_effort|output_config/.test(flat), `关思考时 ${name} 不带强度字段`, flat);
    }

    console.log('\n— provider 接线 —');
    for (const [fn, fmt] of [['callOpenAICompatibleChat', 'openai-compatible'], ['callAnthropicChat', 'anthropic'], ['callOpenAIResponsesChat', 'openai-responses']]) {
        const body = providers.slice(providers.indexOf('async function ' + fn));
        const seg = body.slice(0, body.indexOf('\n    }'));
        c.ok(new RegExp(`buildThinkingParams\\(opts\\.thinking, opts\\.thinkingEffort, '${fmt}'`).test(seg),
            `${fn} 传入思考参数（格式 ${fmt}）`);
    }
    {
        // 整脚本装载 chat-providers.js，用**公开的 forFormat + 假网络出口**断言“最终发出去的 model”，
        //   而不是抠 legacyDeepSeekModel 单测。这样测的是线上真正跑的那条路。
        const cpSandbox = makeVmSandbox({ ChatDeps: null });
        runClassicScripts([path.join(ROOT, 'web', 'js', 'chat-providers.js')], cpSandbox);
        const CP = cpSandbox.ChatProviders;
        let sentBody = null;
        cpSandbox.ChatDeps = {
            ClientApiError: class ClientApiError extends Error {
                constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra || {}); }
            },
            getChatBaseUrl: (s) => String(s.baseUrl || '').replace(/\/$/, ''),
            isDeepSeekOfficial: (u) => /deepseek\.com/.test(u || ''),
            requestChatJson: async (endpoint, body) => {
                sentBody = body;
                return { ok: true, status: 200, payload: { choices: [{ message: { content: 'OK' } }] } };
            },
            buildThinkingParams: () => ({}),
            normalizeChatReply: (content) => ({ content }),
            throwProviderResponseError: async () => { throw new Error('不该走到这里'); },
        };
        const sentModel = async (model, thinking) => {
            sentBody = null;
            await CP.forFormat('openai-compatible')(
                [{ role: 'user', content: 'x' }],
                { thinking, thinkingEffort: 'off', maxTokens: 10 },
                { apiKey: 'k', model, baseUrl: 'https://api.deepseek.com/v1' },
            );
            return sentBody && sentBody.model;
        };
        const chatModel = await sentModel('deepseek-chat', true);
        c.ok(chatModel !== 'deepseek-reasoner',
            '★ thinking 开着时不再把 deepseek-chat 换成 deepseek-reasoner', chatModel);
        c.ok(await sentModel('deepseek-reasoner', true) === 'deepseek-flash',
            '老用户存着 deepseek-reasoner → 映射到当前模型 deepseek-flash');
        c.ok(await sentModel('deepseek-v4-pro', true) === 'deepseek-v4-pro',
            '★ 用户明确选的 deepseek-v4-pro 不被降级（那是花他的钱还改他的选择）');
        c.ok(await sentModel('deepseek-flash', false) === 'deepseek-flash',
            '当前模型名原样透传');
        c.ok(await sentModel('gpt-4.1-mini', true) === 'gpt-4.1-mini',
            '非 DeepSeek 模型名完全不受影响');
    }

    console.log('\n=== 3. 流式增量解析（三种协议实跑）===');
    const sandbox = { window: {}, TextDecoder, console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(streamSrc, sandbox);
    const CS = sandbox.window.ChatStream;
    c.ok(Boolean(CS), 'chat-stream.js 能在假环境加载并导出 ChatStream');

    function sseResponse(text) {
        const bytes = new TextEncoder().encode(text);
        let sent = false;
        return {
            headers: { get: () => 'text/event-stream' },
            body: {
                getReader: () => ({
                    async read() {
                        if (sent) return { done: true, value: undefined };
                        sent = true;
                        return { done: false, value: bytes };
                    },
                    releaseLock() {},
                }),
            },
        };
    }

    if (CS) {
        {
            const sse = 'data: {"choices":[{"delta":{"reasoning_content":"想想"}}]}\n\n'
                + 'data: {"choices":[{"delta":{"content":"你"}}]}\n\n'
                + 'data: {"choices":[{"delta":{"content":"好"}}]}\n\n'
                + 'data: [DONE]\n\n';
            const r = await CS.consumeStream(sseResponse(sse), 'openai-compatible');
            c.ok(r.text === '你好', 'openai-compatible：正文增量拼回完整正文', r.text);
            c.ok(r.reasoning === '想想', 'openai-compatible：reasoning_content 单独归到 reasoning');
            c.ok(r.payload?.choices?.[0]?.message?.content === '你好',
                '★ 合成结果与非流式响应**同构**（provider 的解析代码一行都不用改）');
        }
        {
            const sse = 'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"嗯"}}\n\n'
                + 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"晴天"}}\n\n';
            const r = await CS.consumeStream(sseResponse(sse), 'anthropic');
            c.ok(r.text === '晴天' && r.reasoning === '嗯', 'anthropic：thinking_delta 与 text_delta 分流正确');
            c.ok(r.payload?.content?.some((b) => b.type === 'thinking'), 'anthropic：合成 thinking block');
        }
        {
            const sse = 'data: {"type":"response.reasoning_summary_text.delta","delta":"摘要"}\n\n'
                + 'data: {"type":"response.output_text.delta","delta":"答复"}\n\n';
            const r = await CS.consumeStream(sseResponse(sse), 'openai-responses');
            c.ok(r.text === '答复' && r.reasoning === '摘要', 'openai-responses：摘要与正文分流正确');
        }
        {
            const ev = (delta, finish) => 'data: ' + JSON.stringify({
                choices: [finish ? { delta, finish_reason: finish } : { delta }],
            }) + '\n\n';
            const sse = ev({ content: '我去写。' })
                + ev({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'save_file', arguments: '' } }] })
                + ev({ tool_calls: [{ index: 0, function: { arguments: '{"path": "D:\\\\a.txt", ' } }] })
                + ev({ tool_calls: [{ index: 0, function: { arguments: '"content": "hi"}' } }] })
                + ev({}, 'tool_calls');
            const r = await CS.consumeStream(sseResponse(sse), 'openai-compatible');
            const msg = r.payload?.choices?.[0]?.message || {};
            c.ok(r.text === '我去写。', '工具调用不影响正文增量（正文照常回回调）');
            c.ok(r.finishReason === 'tool_calls', '停止原因被带下来（finish_reason=tool_calls）', r.finishReason);
            c.ok(Array.isArray(msg.tool_calls) && msg.tool_calls.length === 1,
                '合成结果里带 tool_calls（与非流式响应同构）', JSON.stringify(msg.tool_calls));
            const call = msg.tool_calls?.[0] || {};
            c.ok(call.function?.name === 'save_file', '工具名从首片累积得到', call.function?.name);
            let args = null;
            try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = null; }
            c.ok(Boolean(args) && args.path === 'D:\\a.txt' && args.content === 'hi',
                '★ 跨块参数被拼成合法 JSON（arguments 逐片累积，不能逐片解析）', call.function?.arguments);
            c.ok(r.toolCalls?.length === 1 && r.toolCalls[0].function?.name === 'save_file',
                'consumeStream 另外单独返回解析好的调用（收尾那步要用）');
        }
        {
            const ev = (delta) => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n';
            const sse = ev({ tool_calls: [{ index: 0, id: 'a', function: { name: 'list_files', arguments: '{}' } }] })
                + ev({ tool_calls: [{ index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":' } }] })
                + ev({ tool_calls: [{ index: 0, function: { arguments: '' } }] })
                + ev({ tool_calls: [{ index: 1, function: { arguments: '"D:\\\\b.txt"}' } }] });
            const r = await CS.consumeStream(sseResponse(sse), 'openai-compatible');
            const calls = r.payload?.choices?.[0]?.message?.tool_calls || [];
            c.ok(calls.length === 2 && calls[0].function.name === 'list_files' && calls[1].function.name === 'read_file',
                '多路调用按 index 各归各路（交错片段不串味）', JSON.stringify(calls.map((x) => x.function.name)));
            let p2 = null;
            try { p2 = JSON.parse(calls[1]?.function?.arguments || '{}'); } catch { p2 = null; }
            c.ok(Boolean(p2) && p2.path === 'D:\\b.txt', '第二路参数片段同样拼完整', calls[1]?.function?.arguments);
        }
        {
            const ev = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n';
            const sse = ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'save_file' } })
                + ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"content":' } })
                + ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"hi"}' } })
                + ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
            const r = await CS.consumeStream(sseResponse(sse), 'anthropic');
            const block = (r.payload?.content || []).find((b) => b.type === 'tool_use');
            c.ok(Boolean(block) && block.name === 'save_file', 'anthropic：合成 tool_use block', JSON.stringify(block));
            c.ok(Boolean(block && block.input && block.input.content === 'hi'), 'anthropic：参数片段拼成 input 对象', JSON.stringify(block?.input));
            c.ok(r.toolCalls?.length === 1 && r.toolCalls[0].id === 'toolu_1',
                'anthropic：调用同样被单独返回（两条协议共用同一份累积与拼装）');
        }
        {
            const full = 'data: {"choices":[{"delta":{"content":"中文"}}]}\n\n';
            const bytes = new TextEncoder().encode(full);
            const cut = bytes.indexOf(0xe4) + 1;
            let step = 0;
            const resp = {
                headers: { get: () => 'text/event-stream' },
                body: {
                    getReader: () => ({
                        async read() {
                            step++;
                            if (step === 1) return { done: false, value: bytes.slice(0, cut) };
                            if (step === 2) return { done: false, value: bytes.slice(cut) };
                            return { done: true, value: undefined };
                        },
                        releaseLock() {},
                    }),
                },
            };
            const r = await CS.consumeStream(resp, 'openai-compatible');
            c.ok(r.text === '中文', '★ UTF-8 跨块截断不产生乱码（TextDecoder 必须带 {stream:true}）', r.text);
        }
        c.ok(CS.withStreamFlag({ model: 'm' }, 'openai-compatible', true).stream === true,
            'withStreamFlag 打开时加 stream: true');
        c.ok(!('stream' in CS.withStreamFlag({ model: 'm' }, 'openai-compatible', false)),
            'withStreamFlag 关闭时**不发** stream 字段（部分服务商对 stream:false 处理不同）');
    }

    console.log('\n=== 4. 流式接线与回退 ===');
    c.ok(/async function requestChatJson\(/.test(core), 'core 提供 requestChatJson 统一出口');
    c.ok(/sawDelta/.test(core), '★ 记录"有没有真的吐出过内容"');
    c.ok(/if \(sawDelta\) throw error;/.test(core),
        '★ 已吐内容后不回退重试（否则内容闪一下 / 出现两遍）');
    c.ok(/if \(error\?\.name === 'AbortError'\) throw error;/.test(core),
        '★ 用户主动停止不算失败，不回退（否则停止按钮会立刻再发一次）');
    c.ok(/getNativeByokHttpPlugin\(\)\?\.post/.test(core),
        '★ APK 原生层没有流通道 → 直接走非流式（静默降级）');
    c.ok(/text\\\/event-stream/i.test(core) || /text\/event-stream/.test(core),
        '★ 不是 SSE 就按普通响应处理（上游 400/401 的错误体都是普通 JSON）');
    c.ok(/relayError/.test(core), '保留中转错误归一化（relayError）');

    for (const fn of ['callOpenAICompatibleChat', 'callAnthropicChat', 'callOpenAIResponsesChat']) {
        const seg = providers.slice(providers.indexOf('async function ' + fn));
        const body = seg.slice(0, seg.indexOf('\n    }'));
        c.ok(/await requestChatJson\(/.test(body), `${fn} 走 requestChatJson（统一决定流式/非流式）`);
        c.ok(/onDelta: opts\.onDelta/.test(body), `${fn} 把 onDelta 透传下去`);
        c.ok(/signal: opts\.signal/.test(body), `${fn} 把 signal 透传下去（停止按钮）`);
    }

    c.ok(/async function postJsonFromDevice\(url, body, headers = \{\}, \{ timeoutMs = 120000, signal = null \} = \{\}\)/.test(core),
        'postJsonFromDevice 的 timeoutMs / signal 收在 options 对象里，未丢参数');
    c.ok(/async function fetchWithTimeout\(url, options, timeoutMs, signal = null\)/.test(voice),
        'fetchWithTimeout 显式收外部 signal（不再被 options.signal 覆盖掉）');

    console.log('\n=== 5. 回合过程（思考行 + 工具调用行 + 总览）===');
    c.ok(/function createTurnTrace|function beginTurnTrace/.test(ui), 'ui 提供回合过程记录');
    c.ok(/function recordTurnTool/.test(ui), 'ui 提供工具调用记录入口');
    c.ok(/function renderTurnProcess/.test(ui), 'ui 提供过程区渲染');
    c.ok(/function toggleProcessRow/.test(ui), '过程行可展开/折叠');
    c.ok(/class="process-row-head"/.test(ui) && /aria-expanded/.test(ui),
        '过程行用 button + aria-expanded（可键盘操作、可被读屏识别）');

    c.ok(/\.process-row-body\s*\{\s*display:\s*none;/.test(indexHtml),
        '★ 过程行详情默认折叠（CSS 默认 display:none）');
    c.ok(/\.process-row\.is-open \.process-row-body\s*\{\s*display:\s*block;/.test(indexHtml),
        '展开时才显示详情');

    c.ok(/const showReasoning = Boolean\(state\.settings\.thinkingMode\);/.test(ui),
        '思考行由思考开关控制');
    c.ok(/for \(const t of trace\.tools\)/.test(ui),
        '★ 工具调用行**无条件**渲染（不受 thinkingMode 影响）');
    {
        const seg = ui.slice(ui.indexOf('for (const t of trace.tools)'));
        const body = seg.slice(0, seg.indexOf('host.innerHTML'));
        c.ok(!/thinkingMode/.test(body), '★ 工具调用行的渲染代码里没有 thinkingMode 判断');
    }

    c.ok(/turn-summary/.test(ui) && /summaryBits/.test(ui), '有「每回合总览」行（做过什么、成了几个）');
    c.ok(/已思考/.test(ui), '总览里体现"已思考"');
    c.ok(/个操作完成|操作完成/.test(ui), '总览里体现操作完成数量');

    // 过程区在手机上折叠成一行，桌面与手机统一为两段式下拉（点总览 → 时间线 → 明细）。
    c.ok(/function toggleTurnProcess/.test(ui), '★ 过程区有整体展开/收起开关（第一段下拉）');
    c.ok(/toggleTurnProcess\(this\)/.test(ui), '总览行是实际可点的入口（onclick 接线）');
    {
        // 判断规则是否在媒体查询内要用花括号配对，不能用正则猜缩进（\s 会匹配媒体查询内部的缩进）。
        function cssBlockAfter(text, marker) {
            const start = text.indexOf(marker);
            if (start < 0) return null;
            const open = text.indexOf('{', start);
            if (open < 0) return null;
            let depth = 0;
            for (let i = open; i < text.length; i++) {
                if (text[i] === '{') depth++;
                else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(open + 1, i); }
            }
            return null;
        }
        // 判据是"摘掉所有 @media 后折叠规则仍在"，不钉具体断点值：断点会随布局调整，
        //    而它防的回归（规则被塞回手机媒体查询）与断点号无关。
        const withoutMedia = (() => {
            let out = indexHtml;
            for (let guard = 0; guard < 50; guard++) {
                const at = out.indexOf('@media');
                if (at < 0) break;
                const open = out.indexOf('{', at);
                if (open < 0) break;
                let depth = 0, end = open;
                for (; end < out.length; end++) {
                    if (out[end] === '{') depth++;
                    else if (out[end] === '}') { depth--; if (depth === 0) { end++; break; } }
                }
                out = out.slice(0, at) + out.slice(end);
            }
            return out;
        })();
        c.ok(/\.turn-process \.process-row\s*\{\s*display:\s*none;\s*\}/.test(withoutMedia),
            '★★ 明细"默认收起"规则在所有媒体查询**之外**（桌面也生效 —— 两段式统一）');
        c.ok(/\.turn-process\.is-expanded \.process-row\s*\{\s*display:\s*block;\s*\}/.test(withoutMedia),
            '★★ 展开时间线的规则同样两端生效');
    }

    // 总览行箭头必须两端都显示：只在 @media 里定义时桌面不渲染，点三角形没反应。
    {
        const toggleRule = /\.turn-summary-toggle\s*\{([^}]*)\}/.exec(indexHtml);
        c.ok(Boolean(toggleRule), '存在 .turn-summary-toggle 样式规则');
        c.ok(toggleRule && /display:\s*inline-flex/.test(toggleRule[1]),
            '★★ 总览行的三角箭头常驻显示（不再只在手机端才渲染）');
        c.ok(/\.turn-process\.is-expanded \.turn-summary-toggle\s*\{\s*transform:\s*rotate\(90deg\)/.test(indexHtml),
            '第一段展开时箭头旋转（用户一眼看出哪一层开着）');
        c.ok(/\.process-row\.is-open \.process-row-chevron\s*\{\s*transform:\s*rotate\(90deg\)/.test(indexHtml),
            '第二段展开时行内箭头也旋转');
    }

    c.ok(/data-state="\$\{escapeHtml\(state/.test(ui), '过程行带 data-state（运行中/成功/失败/已停止）');
    for (const s of ['running', 'ok', 'error', 'stopped']) {
        c.ok(new RegExp(`process-row\\[data-state="${s}"\\]`).test(indexHtml), `状态 ${s} 有独立视觉`);
    }
    c.ok(/processStateLabel/.test(ui) && /运行中/.test(ui) && /失败/.test(ui),
        '状态有中文文案（不只靠颜色，色盲用户也能分辨）');

    c.ok(/scheduleTurnProcessRender/.test(ui) && /requestAnimationFrame/.test(ui),
        '★ 流式增量按帧合并渲染（逐 token 重建 DOM 会明显卡顿）');

    // 时间线外观：思考、工具调用、结果在同一条流里，钉住让该观感成立的三件事。
    console.log('\n=== 5d. 时间线外观 ===');
    {
        c.ok(/const dur = processDurationLabel\(ms\)/.test(ui),
            '工具行带耗时（哪一步慢是用户唯一能判断"是不是卡住"的信息）');
        c.ok(/process-row-duration/.test(ui), '耗时有独立元素渲染出来');
        // 耗时阈值必须是 100ms 级：Agent 单步常在几十~几百毫秒，
        // 用"1 秒"当门槛等于绝大多数步骤都不显示 —— 那这个字段就白加了。
        const durFn = (ui.split('function processDurationLabel')[1] || '').split('\nfunction ')[0];
        c.ok(/n < 100\)/.test(durFn) && !/n < 1000\) return ''/.test(durFn),
            '★ 耗时阈值是 100ms（不是 1 秒，否则多数步骤都不显示）');
        c.ok(/function processArgEntries/.test(ui) && /function processArgsHtml/.test(ui),
            '★ 参数拆成键值行（path / command 这类值才浮得出来）');
        c.ok(/process-arg-key/.test(ui) && /process-arg-value/.test(ui),
            '键与值分别有独立元素（值才能对齐成一列）');
        c.ok(/process-arg-block/.test(ui), '长值（文件内容/命令）单独占行');
        c.ok(/ms: t\.ms/.test(ui), '工具行把 ms 传给渲染');
        c.ok(/processArgsHtml\(t\.args\)/.test(ui), '工具行参数走键值渲染（不是整行 pre）');
        c.ok(/\.turn-process::before/.test(indexHtml) || /\.turn-process\s*\{[\s\S]{0,200}?padding-left/.test(indexHtml),
            '★ 过程区左侧画竖线（把各步串成一条流）');
        c.ok(/\.process-row::before/.test(indexHtml), '★ 每行有节点圆点（钉在竖线上）');
        c.ok(/data-kind="think"\]::before/.test(indexHtml), '思考行的节点空心/虚线（与工具行区分）');
    }

    console.log('\n=== 6. 流式正文预览 ===');
    c.ok(/function renderStreamingReplyPreview/.test(voice), '有流式正文预览渲染');
    c.ok(/function removeStreamingReplyPreview/.test(voice), '预览可被收掉');
    c.ok(/onDelta: \(chunk\) =>/.test(voice), '发送流程接了 onDelta 回调');
    c.ok(/chunk\.kind === 'reasoning'/.test(voice), '思考增量归到思考行');
    c.ok(/beginTurnTrace\(message\.id\)/.test(voice), '每轮回复开启一个回合记录');
    c.ok(/finishTurnTrace\(\)/.test(voice), '回复完成时收尾回合记录');
    // 正文必须来自 callAI 的完整返回值（流式只负责先让用户看见）；判据锚不变量而非变量名，
    //    正则放行可选的第三参（失败回退模型的 settings 覆盖）。
    c.ok(/rawResponse = await callAI\(message\.text,\s*requestOpts(?:,\s*[A-Za-z_$][\w$.| ]*)?\)/.test(voice),
        '★ 仍以 callAI 的**完整**返回值作为正文来源（流式只负责先让用户看见）');
    c.ok(/const fallbackChain = fallbackChatChainSettings\(\)/.test(voice)
        && /const attemptPlan = fallbackChain\.length/.test(voice)
        && /attemptPlan\[attemptIndex\]/.test(voice),
        '★ 配了回退模型时按顺序逐个尝试（默认在前，回退卡按用户排序）');
    // requestOpts 必须由 aiRequestOptions 派生，否则思考/语音/中断器等设置会被悄悄丢掉。
    c.ok(/const requestOpts = Object\.assign\(\{\}, aiRequestOptions/.test(voice),
        '★ requestOpts 由 aiRequestOptions 派生（不另起一套请求选项）');
    {
        // 锚定 handleUserInput 自己的 finally：主请求外面包了重试循环后，
        // "await callAI" 不再是定位 finally 的可靠坐标 —— 函数名才是。
        const fnStart = voice.indexOf('async function handleUserInput');
        const fin = voice.slice(voice.indexOf('} finally {', fnStart));
        c.ok(/removeStreamingReplyPreview\(\)/.test(fin.slice(0, 400)),
            '★ finally 里收掉预览（失败/停止路径也要清干净，否则留下幽灵气泡）');
    }

    // 第三人称两段式：第一段 GM 正文不进 UI，第二段必须透传 onDelta；
    //    同步模式正文提交不能挂在 TTS 成功上（语音失败降级成纯文字）。
    console.log('\n=== 6b. 流式可达性（第三人称两段式 / 同步模式 TTS 降级）===');
    {
        const seg = dataSrc.slice(dataSrc.indexOf('async function generateThirdPersonReply'));
        const body = seg.slice(0, seg.indexOf('\n}\n'));
        c.ok(/async function generateThirdPersonReply/.test(dataSrc), '存在第三人称两段式实现');
        const gmOpts = body.slice(body.indexOf('const gmOptions'), body.indexOf('const gmMessages'));
        c.ok(/onDelta: null/.test(gmOpts),
            '★ gmOptions 里 onDelta: null —— 第一段正文绝不流式渲染到界面（它是中间产物）');
        c.ok(/pass1OnDelta/.test(body) && /chunk\.kind === 'reasoning'/.test(body),
            '★★ 第一段仍把**思考**增量透出去（只放 reasoning，不放 text）');
        c.ok(/phase: 1/.test(body), '★ 第一段的思考带 phase=1 标记（与第二段分开，不混成一段）');
        // 第一段（GM）拿着完整上下文，缺了 tools/replyInfo 透传时工具通道整条失效，
        //    只剩正文标签兜底。
        {
            const pass1Call = body.slice(body.indexOf('const pass1 = await callChatAPI'));
            const p1seg = pass1Call.slice(0, pass1Call.indexOf('const pass1Text'));
            c.ok(/tools: options\.tools \|\| null/.test(p1seg) && /replyInfo: options\.replyInfo \|\| null/.test(p1seg),
                '★★ 第一段（GM）透传 tools/replyInfo（第三人称模式下工具通道的唯一入口）');
        }
        // 回退模型的 settings 覆盖要传进两段式，否则开第三人称时回退请求仍走默认模型。
        c.ok(/return await generateThirdPersonReply\(text, options(?:,\s*\w+)?\)/.test(dataSrc),
            'callAI 在第三人称开启时提前 return（所以这条路上必须自己接好 onDelta）');
        // 断言跑在去注释的源码上：注释里引用了坏代码的原文，拿全文匹配会报假失败。
        const pass2Seg = dataCode.slice(dataCode.indexOf("pass2Messages.push({ role: 'user'"));
        c.ok(/onDelta: typeof options\.onDelta === 'function'/.test(pass2Seg)
            || /onDelta: options\.onDelta \|\| null/.test(pass2Seg),
            '★★ 第二段（用户看到的正文）透传 onDelta —— 否则开第三人称就完全没有流式');
        c.ok(!/onDelta: null/.test(pass2Seg),
            '★ 第二段里不能再出现 onDelta: null（那正是"开了第三人称就没有流式"的根因）');
        c.ok(/phase: 2/.test(pass2Seg), '★ 第二段的思考带 phase=2 标记');
        c.ok(/options\.onPhase/.test(body), '★★ 两段都通过 onPhase 上报阶段输出（专用下拉的数据源）');
        c.ok(/index: 1/.test(body) && /index: 2/.test(body),
            '★★ 阶段输出带 index 1/2（UI 按它生成"第 N 阶段"条目）');
        // 阶段输出的正文不能带内部标签（<voice_jp> 之类显示出来只是噪音）
        c.ok(/recordTurnPhase|onPhase/.test(voice), 'voice 层把 onPhase 接到记录函数');
        c.ok(/recordTurnPhase\(phase\)/.test(voice), 'voice 层实际调用 recordTurnPhase');

        // GM 提示词必须声明最高优先级与覆盖范围：mergeLeadingSystemMessages 会把开头
        //    所有 system 合并成一条，未声明的 GM 会被具体角色卡压住（人称与格式全丢）。
        c.ok(/本提示词优先级最高/.test(dataSrc),
            '★★ GM 提示词声明「优先级最高，覆盖角色卡与世界观」（否则被角色卡压住）');
        c.ok(/不约束本阶段的人称与输出格式/.test(dataSrc),
            '★★ 明确划清边界：角色卡约束"人设口吻"，不约束"人称与输出格式"');
        c.ok(/【篇幅兜底】/.test(dataSrc),
            '★★ 有篇幅兜底（打招呼可缩短，但不许省略标签/改回第一人称）');
        c.ok(/绝不允许.*省略【故事】\/【状态】标签/.test(dataSrc),
            '★★ 兜底条款显式点名"不得省略【故事】/【状态】标签"');
        {
            const gmStart = dataSrc.indexOf('const THIRD_PERSON_GM_PROMPT');
            const gmEnd = dataSrc.indexOf('const THINKING_LANGUAGE_PROMPT');
            const gm = dataSrc.slice(gmStart, gmEnd);
            const prioAt = gm.indexOf('本提示词优先级最高');
            c.ok(prioAt > 0 && prioAt < 200,
                '★★ 优先级声明位于 GM 提示词**开头 200 字符内**（不能被淹没在长文里）',
                `实际偏移 ${prioAt}`);
            c.ok(/【输出格式】/.test(gm) && /【故事】/.test(gm) && /【状态】/.test(gm),
                '★ GM 提示词的【输出格式】/【故事】/【状态】三者齐全（改文案时别删标签）');
        }

        // legacy 回滚路径也必须有 thirdPerson 的 GM 提示词与 THINKING_LANGUAGE_PROMPT，
        //    否则切回 legacy 后第三人称失效、思维链变英文。
        {
            const legacySeg = dataCode.slice(dataCode.indexOf('function buildLegacyRoleplayMessages'),
                dataCode.indexOf('async function callAI'));
            c.ok(/THIRD_PERSON_GM_PROMPT/.test(legacySeg),
                '★★ legacy 路径也会因 thirdPerson 注入 GM 提示词（原为永不生效的真 bug）');
            c.ok(/if \(options\.thirdPerson\) systemParts\.push\(THIRD_PERSON_GM_PROMPT\)/.test(legacySeg),
                '★ legacy 的注入是条件式的（非 thirdPerson 时不得误注入）');
            c.ok(/THINKING_LANGUAGE_PROMPT/.test(legacySeg),
                '★★ legacy 路径也注入思考语言要求（原为缺口：切回 legacy 思维链变英文）');
            const gmAt = legacySeg.indexOf('systemParts.push(THIRD_PERSON_GM_PROMPT)');
            const cardAt = legacySeg.indexOf('systemParts.push(legacyCharacterPrompt)');
            c.ok(gmAt >= 0 && cardAt > gmAt,
                '★★ legacy 里 GM 提示词排在角色卡**之前**（否则优先级语义就反了）');
        }

        // 两段都要有中文思维链要求：第二段是手搭的最小消息数组，不继承全局要求就会用英文思考。
        {
            // 边界要用 generateThirdPersonReply 之后的函数当终点，否则 slice 得到空串、断言全假失败。
            const gen3p = dataCode.slice(dataCode.indexOf('async function generateThirdPersonReply'),
                dataCode.indexOf('function extractReplyTags'));
            const p2 = gen3p.slice(gen3p.indexOf('const pass2Messages'));
            c.ok(/THINKING_LANGUAGE_PROMPT/.test(p2),
                '★★ 第二阶段也注入中文思维链要求（原为英文思维链 —— 与第一阶段不一致）');
            c.ok(/if \(state\.settings\.thinkingMode\)\s*\{\s*pass2Messages\.push\(\{ role: 'system', content: THINKING_LANGUAGE_PROMPT \}\)/.test(p2),
                '★ 该注入是条件式的（关掉思考模式时不注入，省 token）');
            // 位置：必须在 user 消息（第一段正文）**之前** —— 排在最后就成了"事后补充"，
            // 而且第二段的 user 消息是待改写的正文，插在它后面语义就乱了。
            const thinkAt = p2.indexOf('THINKING_LANGUAGE_PROMPT');
            const userAt = p2.indexOf("role: 'user', content: pass1Text");
            c.ok(thinkAt >= 0 && userAt > thinkAt,
                '★ 中文思维链要求在第二阶段 user 消息之前注入（位置得当）');
            const p1 = gen3p.slice(0, gen3p.indexOf('const pass2Messages'));
            c.ok(/buildLayeredRoleplayMessages/.test(p1),
                '★ 第一阶段经 buildLayeredRoleplayMessages（其中已含中文思维链要求）');
        }

        c.ok(/const commitAiMessageOnce = \(\) => \{/.test(voice), '有幂等的消息提交函数');
        const noVoice = voice.slice(voice.indexOf('if (!voiceStarted) {'));
        const noVoiceBody = noVoice.slice(0, noVoice.indexOf('.catch('));
        c.ok(/commitAiMessageOnce\(\)/.test(noVoiceBody),
            '★★ 语音未生成时仍提交文字回复（语音是增强，不是发送闸门）');
        c.ok(!/回复没有显示/.test(voiceCode),
            '★ 旧的"语音失败 → 回复不显示"文案已删除（注释里的引用不算，故去注释后断言）');
        const catchSeg = voice.slice(voice.indexOf('.catch(error => {'), voice.indexOf('.finally(() => pendingAutomaticVoiceMessageIds.delete'));
        c.ok(/commitAiMessageOnce\(\)/.test(catchSeg),
            '★ TTS 抛错时也提交文字回复（否则同步模式下整条回复消失）');

        c.ok(/function sanitizeStreamingPreviewText/.test(voice),
            '★ 流式预览有净化函数（标签必须随增量就剥掉，不能等最终渲染）');
        c.ok(/window\.ElainaTags\.strip/.test(voice),
            '★ 净化复用宿主权威的 ElainaTags.strip（标签名清单只有一处）');
        c.ok(/<voice_jp>\[\\s\\S\]\*\$/.test(voice) || /voice_jp/.test(voice),
            '★ 半截的 <voice_jp> 也要藏起（朗读稿不能先于正文露出来）');
    }

    // 6c. 中转超时按"空闲"续期，不是整条请求总时长：流式长回复正常要几分钟，
    //    总时长计时会在等待期掐断请求，前端只能退回非流式。
    console.log('\n=== 6c. 中转超时语义（空闲续期，不是总时长）===');
    {
        // 这几条判的是中继实现 server/relay.mjs（两端共用），不是 serve.mjs。
        c.ok(/const armIdleTimer = \(ms\) =>/.test(relaySrc),
            '★ 中转用 armIdleTimer 续期（每收到一块就重置计时）');
        c.ok(/armIdleTimer\(timeoutMs\)/.test(relaySrc), '转发循环里对每块数据续期');
        c.ok(/hardDeadline/.test(relaySrc),
            '★ 空闲续期之外还有总时长硬顶（防"一直发心跳不说正文"占住连接）');
        c.ok(/flushHeaders/.test(relaySrc),
            '★ 响应头立刻 flush（否则前端要等第一块数据才知道流已经开始）');
        c.ok(/X-Accel-Buffering/.test(relaySrc),
            '★ SSE 关闭中间层缓冲（X-Accel-Buffering: no）');
        c.ok(/CHAT_TIMEOUT_THINKING_MS/.test(core) && /CHAT_TIMEOUT_DEFAULT_MS/.test(core),
            '★ 客户端区分普通/思考两档超时（思考模式首字延迟常超 2 分钟）');
        c.ok(/opts\.thinking \? CHAT_TIMEOUT_THINKING_MS : CHAT_TIMEOUT_DEFAULT_MS/.test(core),
            '★ callChatAPI 按 thinking 开关选超时预算');

        // 6d. 退回非流式时思考不能丢：那条路上 onDelta 不再触发，思考只在响应体里，
        //    必须回填 replyInfo 并在没收到流式思考时补进时间线。
        console.log('\n=== 6d. 退回非流式时思考不丢 ===');
        {
            c.ok(/opts\.replyInfo\.reasoning = ''/.test(core),
                '★★ replyInfo 有 reasoning 兜底字段（非流式响应的思考往这里放）');
            const providersSrc = readFileSync(path.join(ROOT, 'web', 'js', 'chat-providers.js'), 'utf8');
            const filled = (providersSrc.match(/reportReplyInfo\(opts, \{[^}]*reasoning[^}]*\}\)/g) || []).length;
            c.ok(filled >= 3, '★★ 三个 provider 都把思考回填进 replyInfo（找到 ' + filled + ' 处）');
            c.ok(/let streamedReasoningSeen = false/.test(voice),
                'voice.js 记录"流里有没有收到过思考"');
            c.ok(/if \(!streamedReasoningSeen\) \{[\s\S]{0,220}?appendTurnReasoning\(fallbackReasoning/.test(voice),
                '★★ 没收到流式思考时，用响应体里的补进时间线（否则退回一次就丢一次）');
            c.ok(/if \(fallbackReasoning\) appendTurnReasoning/.test(voice),
                '空思考不补（不产生空思考段）');
            // replyInfo 容器必须独立于工具清单：关 Agent 权限时 agentToolOptions() 返回 null。
            c.ok(/const replyInfo = \(agentToolOpt && agentToolOpt\.replyInfo\) \|\| \{\}/.test(voice),
                '★★ replyInfo 容器独立于工具清单（关 Agent 权限也照样有思考）');
        }
        c.ok(/opts\.timeoutMs/.test(core) && /Number\.isFinite\(opts\.timeoutMs\)/.test(core),
            '★ 调用方显式传的 timeoutMs 优先（不被默认值覆盖）');
    }

    // 6e. 超时要有下文：fetch 超时改抛 REQUEST_TIMEOUT（可重试），读流按块间空闲计时，
    //    主聊天路径对可重试错误自动再试一次并把状态写在思考气泡上。
    console.log('\n=== 6e. 超时/重试的可见性（不许静默）===');
    {
        const ftw = voice.slice(voice.indexOf('async function fetchWithTimeout'), voice.indexOf('async function', voice.indexOf('async function fetchWithTimeout') + 10));
        c.ok(/let timedOut = false/.test(ftw) && /timedOut = true/.test(ftw),
            '★ fetchWithTimeout 记录"是内部计时器触发"（与外部 signal 中止区分）');
        c.ok(/new ClientApiError\('REQUEST_TIMEOUT'/.test(ftw),
            '★★ 超时抛 REQUEST_TIMEOUT（不再伪装成 AbortError 被当作用户停止静默吞掉）');
        c.ok(/error\?\.code === 'REQUEST_TIMEOUT'\) throw error/.test(core),
            '★★ requestChatJson 对超时不再"退回非流式"（退回只会让用户把同一个等待再经历一遍）');
        c.ok(/function readChunkWithIdleTimeout/.test(streamSrc),
            '★ 流式读取有按块间空闲计时的包装（fetch 超时管不到拿到 headers 之后）');
        c.ok(/await readChunkWithIdleTimeout\(reader, idleTimeoutMs\)/.test(streamSrc),
            '★ readSse 的每个读取都经空闲超时包装（每块数据自动续期）');
        c.ok(/async function consumeStream\(response, format, onDelta, idleTimeoutMs = 0\)/.test(streamSrc)
            && /\}, idleTimeoutMs\);/.test(streamSrc),
            '★ consumeStream 把空闲上限透传给 readSse');
        c.ok(/consumeStream\(response, format, onDelta, timeoutMs\)/.test(core),
            '★ streamJsonFromDevice 把客户端超时预算传进读流阶段');
        c.ok(/RETRYABLE_CHAT_CODES/.test(voice),
            '★ 有"哪些失败值得再试一次"的白名单（超时/网络/限流/上游 5xx）');
        const retryLoop = voice.slice(voice.indexOf('const attemptPlan'), voice.indexOf('const parsedReply'));
        c.ok(/chatError\?\.name === 'AbortError' \|\| replyAbort\.signal\.aborted\) throw chatError/.test(retryLoop),
            '★★ 用户停止优先于重试（按了停止绝不自己再发一次）');
        c.ok(/updateThinkingMessageText\(/.test(retryLoop),
            '★★ 重试前把状态写进思考气泡（静默重试看起来像卡死）');
        c.ok(/streamedReasoningSeen = false;[\s\S]{0,120}resetStreamingReplyPreview\(\)/.test(retryLoop),
            '★ 重试是全新请求：上一次的半截流式状态清零（否则新旧回复拼出重复内容）');
        c.ok(/function updateThinkingMessageText/.test(ui),
            '★ ui 层实现 updateThinkingMessageText（思考气泡文案可更新）');
    }

    // 6f. 流式期间过程区每帧重建，内联 onclick 收不到 click —— 展开交互走容器上的
    //    pointerup 委托（容器本身从不被重建）。
    console.log('\n=== 6f. 流式期间过程区可展开（pointerup 委托）===');
    {
        c.ok(/function onTurnProcessPointerUp/.test(ui),
            '★ 过程区有 pointerup 委托入口（click 在每帧重建下收不到）');
        c.ok(/host\.addEventListener\('pointerup', onTurnProcessPointerUp\)/.test(ui),
            '★★ 委托绑在不被重建的容器上（流式期间点击始终有效）');
        c.ok(/pointerWired/.test(ui), '★ 委托只绑一次（防重复，本函数每帧都会走到）');
        const rowHtml = ui.slice(ui.indexOf('function processRowHtml'), ui.indexOf('function onTurnProcessPointerUp'));
        c.ok(!/onclick="toggleProcessRow/.test(rowHtml),
            '★★ 过程行不再用内联 onclick（重建期间它一个事件都收不到）');
        c.ok(/onkeydown="if\(event\.key==='Enter'\|\|event\.key===' '\)/.test(rowHtml),
            '★ 键盘 Enter/Space 仍可展开（键盘事件即时派发，不受重建影响）');
    }

    // 6g. 流式期间滚动不被打扰：重建后按行 key 回填行内滚动位置，聊天区只在贴底时跟随。
    console.log('\n=== 6g. 流式期间的滚动（行内位置保留 + 贴底才跟随）===');
    {
        c.ok(/const scrollMemory = new Map\(\)/.test(ui),
            '★★ 重建前快照各行详情的滚动位置（否则一滑就被弹回最上面）');
        c.ok(/scrollMemory\.set\(k, tops\)/.test(ui) && /scrollers\[i\]\.scrollTop = top/.test(ui),
            '★★ 重建后按行 key 回填滚动位置（行没了就跳过）');
        c.ok(/distance < 80/.test(ui) && /hist\.scrollTop = hist\.scrollHeight/.test(ui),
            '★★ 聊天区只在距底 < 80px 时才自动滚（翻历史不再被拽回底部）');
    }

    // 6h. 确认等待不算耗时：等待期在过程行写"正在等用户确认"，用户点允许时重置计时。
    console.log('\n=== 6h. 确认等待不算耗时（重置计时 + 等待可见）===');
    {
        c.ok(/patch\.resetTimer === true/.test(ui) && /item\.startedAt = Date\.now\(\)/.test(ui),
            '★★ updateTurnTool 支持 resetTimer（用户犹豫的时间不是执行耗时）');
        const cmdSeg = agentSrc.slice(agentSrc.indexOf('async function doAgentCommand'));
        c.ok(/正在等用户确认/.test(cmdSeg),
            '★ 命令确认等待期在过程行上说明（分得清"卡住"与"在等我决定"）');
        c.ok(/resetTimer: true/.test(cmdSeg),
            '★ 用户允许后重置计时（等待 17 秒不再显示成"命令跑了 20 秒"）');
        const fileSeg = agentSrc.slice(agentSrc.indexOf('async function doAgentFile'), agentSrc.indexOf('async function doAgentCommand'));
        c.ok((fileSeg.match(/正在等用户确认/g) || []).length >= 3,
            '★ 文件写入的三个确认分支（覆盖/新建/删除）同样有等待提示');
        c.ok((fileSeg.match(/resetTimer: true/g) || []).length >= 3,
            '★ 三个确认分支同样在用户允许后重置计时');
    }

    // 6i. 过程区增量渲染：条目描述符（key + 版本号 + 惰性 build），版本没变跳过、
    //    思考行文本变长走 appendData，使每帧成本为 O(增量) 而不是 O(总长)。
    console.log('\n=== 6i. 过程区增量渲染（每帧成本 O(增量) 而不是 O(总长)）===');
    {
        c.ok(/function applyTurnProcessEntries\(/.test(ui),
            '★★ 有独立的应用函数（描述符 → DOM，快/慢两条路径）');
        c.ok(/prev\.versions\[i\] === entry\.version/.test(ui),
            '★★ 版本没变的行直接跳过（O(1) 比对，不重建不比对 HTML）');
        c.ok(/node\.appendData\(entry\.text\.slice\(node\.data\.length\)\)/.test(ui)
            && /entry\.text\.startsWith\(node\.data\)/.test(ui),
            '★★ 思考行文本变长走 appendData(增量)（元素不动，成本与总长无关）');
        c.ok(/host\.insertAdjacentHTML\('beforeend', entry\.build\(\)\)/.test(ui),
            '★ 新行追加到末尾（时间线只增长）');
        c.ok(/old\.outerHTML = entry\.build\(\)/.test(ui),
            '★ 单行变化只换那一行（换前快照展开态与行内滚动）');
        c.ok(/rev = \(item\.rev \|\| 0\) \+ 1/.test(ui),
            '★ updateTurnTool 每次改动自增 rev（版本判据精确到每次更新）');
        c.ok(/\(t\.rev \|\| 0\) \+/.test(ui) && /\(live \? 'running' : 'ok'\) \+ '#' \+ item\.text\.length/.test(ui),
            '★ 工具行版本含 rev、思考行版本含状态+长度（都是 O(1)）');
        c.ok(/text: text\.replace\(\//.test(ui) && /escapeHtml\(item\.text\)/.test(ui),
            '★ 思考正文不整体 trim（前缀对齐是 appendData 的硬前提）');
        c.ok(/item\.text\.slice\(0, 200\)\.split\('/.test(ui),
            '★ firstLine 只取有界前缀计算（旧写法 split 整段是每帧 O(n)）');
        c.ok(/host\.innerHTML = entries\.map\(\(e\) => e\.build\(\)\)\.join\(''\)/.test(ui),
            '★ 慢路径仍是整体重建（首次渲染 / 思考开关切换 / 行序不符时）');
        c.ok(/function stickChatScrollToBottom\(\)/.test(ui) && /stickChatScrollToBottom\(\);/.test(voice),
            '★ 贴底跟随抽出为共用函数（流式正文预览不再无条件滚底）');
    }

    console.log('\n=== 7. 思考强度（四档下拉，独立开关已合并）===');
    c.ok(!/id="settingThinkingMode"/.test(indexHtml),
        '★ 独立的思考勾选框已移除（开关合并进档位，避免"开关关着、档位却是 max"）');
    c.ok(/id="settingThinkingEffort"/.test(indexHtml), '设置里有思考强度下拉');
    for (const v of ['off', 'low', 'high', 'max']) {
        c.ok(new RegExp(`<option value="${v}">`).test(indexHtml), `强度档位含 ${v}`);
    }
    c.ok(/THINKING_EFFORTS/.test(core) && /THINKING_EFFORTS/.test(settings),
        'THINKING_EFFORTS 白名单被设置读写两侧共用');
    c.ok(/THINKING_EFFORTS = Object\.freeze\(\['off', 'low', 'high', 'max'\]\)/.test(core),
        '★★ 档位白名单是 off/low/high/max 四档（off = 不思考，与 UI 选项一致）');
    c.ok(!/id="composerThinkingToggle"/.test(indexHtml), '★ 输入框菜单里的思考开关已移除');
    c.ok(!/id="initialComposerThinkingToggle"/.test(indexHtml), '★ 首屏菜单里的思考开关也已移除');
    c.ok(!/syncComposerThinkingToggles/.test(core + voice + init),
        '★ 旧的菜单同步函数已删除（没有残留调用）');
    c.ok(!/MiniMax 请求，默认关闭/.test(indexHtml), '★ 旧的错误提示文案（"MiniMax 请求"）已删除');
    c.ok(!/settingThinkingMode: document\.getElementById/.test(core),
        '★ elements 映射里不再有 settingThinkingMode（控件已合并）');
    c.ok(/settingThinkingEffort: document\.getElementById\('settingThinkingEffort'\)/.test(core),
        'elements 映射里有 settingThinkingEffort');
    c.ok(/thinkingMode: elements\.settingThinkingEffort\.value !== 'off'/.test(settings),
        '★★ saveSettings 由档位派生 thinkingMode（off ⇒ false）');
    c.ok(/thinkingEffort: THINKING_EFFORTS\.includes\(elements\.settingThinkingEffort\.value\)/.test(settings),
        'saveSettings 落盘思考强度（并做白名单校验）');
    c.ok(/thinkingEffort: 'off'/.test(core), 'DEFAULT_SETTINGS 的思考档位默认 off（不思考）');
    c.ok(/syncThinkingModeControls\(\)/.test(settings), 'fillSettingsForm 回填思考控件');
    c.ok(!/elements\.settingThinkingMode/.test(init),
        '★ init 里不再有独立思考开关的绑定（控件已合并）');
    c.ok(/elements\.settingThinkingEffort\.addEventListener\('change'/.test(init),
        '思考强度改动即持久化');
    c.ok(/state\.settings\.thinkingMode = value !== 'off'/.test(init),
        '★★ 档位变更时同步派生 thinkingMode（请求层判据一致）');
    c.ok(/updateThinkingModeHint/.test(voice) && /id="thinkingModeHint"/.test(indexHtml),
        '有动态说明（告诉用户当前档位对当前服务商意味着什么）');
    c.ok(/thinkingEffort: state\.settings\.thinkingEffort/.test(readFileSync(path.join(ROOT, 'web', 'js', 'roleplay.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'chat.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'data.js'), 'utf8')),
        'callAI 把思考强度带进请求');

    // html 只在上面用于前置读取（与源脚本一致）；显式引用一下，避免被当成未使用变量清掉
    void html;
}

const only = process.argv[2];
const allCases = [
    { name: '流式与思考模式', fn: caseStreamAndCot },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: '流式与回合过程（流式增量 / 思考参数 / 回合过程展示 / 回退降级）',
    usage: 'node scripts/check-stream.mjs [用例名子串]',
    cases,
});

void wait; void freePort;

