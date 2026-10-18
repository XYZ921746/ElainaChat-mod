// 流式输出与回合过程的回归检查。
//
// 合并自一个脚本（check-stream-and-cot）。之所以按"模块"命名而不是按原脚本名，
// 是因为这一块本身就是**一条链路**：
//   思考开关/强度 → 请求参数 → 流式增量 → 回合过程区（思考行 + 工具调用行 + 总览）
// 拆成多个文件会让"参数发出去了但界面不显示"这种跨层断裂漏检。
// 将来这块若再加入口（例如原生层的流通道检查），也直接进本文件的用例列表。
//
// 盯住的关键契约（都是踩过或极易踩的坑）：
//
//   ① DeepSeek 现在**服务端默认开启思考**。所以"关掉开关"必须显式发
//      `thinking:{type:'disabled'}` —— 不发字段不等于关，用户会白等几十秒、
//      白花思考 token，而界面上什么都看不到。这条最隐蔽。
//
//   ② 工具调用行**不受思考开关影响**（用户明确要求："思考模式关闭的情况下
//      思维链还是要显示工具调用的"）。关掉思考只是不显示"思考"那一行，
//      不能连"AI 改了哪个文件"也一起藏掉。
//
//   ③ 过程行默认**折叠**。这是聊天应用，正文才是主角；思考动辄上千字，
//      默认展开会把对话顶出屏幕。但摘要行必须常驻 —— 折叠不等于藏起来。
//
//   ④ 流式失败要能**退回非流式**。中转站可能把 SSE 缓冲掉、上游可能不支持
//      stream、APK 原生层根本没有流通道。任一条路断了都不能让用户发不出消息。
//
//   ⑤ 已经吐出内容之后**不能**再回退重试 —— 否则用户会看到内容闪一下、
//      或者同一段话出现两遍。
//
// 每段用例在自己的函数作用域里跑（源脚本顶层的 html/core/ui/voice/settings/init… 全部
// 搬进用例函数），断言经 c.ok 记账，失败信息形如「流式与思考模式 :: 断言原文」。
//
// 用法：node scripts/check-stream.mjs          跑全部
//       node scripts/check-stream.mjs 回合      只跑名字含该子串的用例

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { readFrontend } from './frontend-sources.mjs';
import { runChecks, ROOT, wait, freePort } from './check-harness.mjs';

// ────────────────────────────────────────────────────────────
// 1. 流式输出 + 思考模式适配 + 回合过程（思维链 / 工具调用）展示
//
// 源脚本 check-stream-and-cot.mjs 的全部断言，按原来的分节顺序：
//   1 接线 / 2 思考参数 / 3 流式解析 / 4 流式接线与回退 /
//   5 回合过程 UI / 6 流式正文预览 / 6b 流式可达性 / 6c 中转超时语义 / 7 设置界面
// ────────────────────────────────────────────────────────────

async function caseStreamAndCot(c) {
    const html = readFrontend();
    const core = readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');
    const ui = readFileSync(path.join(ROOT, 'web', 'js', 'ui.js'), 'utf8');
    const voice = readFileSync(path.join(ROOT, 'web', 'js', 'voice.js'), 'utf8');
    const settings = readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');
    const init = readFileSync(path.join(ROOT, 'web', 'js', 'init.js'), 'utf8');
    const streamSrc = readFileSync(path.join(ROOT, 'web', 'js', 'chat-stream.js'), 'utf8');
    const providers = readFileSync(path.join(ROOT, 'web', 'js', 'chat-providers.js'), 'utf8');
    const indexHtml = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    const dataSrc = readFileSync(path.join(ROOT, 'web', 'js', 'data.js'), 'utf8');
    // ★★ 2026-10：本地中继（含它那套流式超时/透传行为）搬进了 server/relay.mjs，
    //   成为电脑端与手机端**共用**的一份实现。所以下面第 6c 节要在新文件里找，
    //   而不是在 serve.mjs 里 —— 搬走之后留了一份转发壳，细节全在那边。
    const relaySrc = readFileSync(path.join(ROOT, 'server', 'relay.mjs'), 'utf8');

    /**
     * 去掉 JS 注释后的源码。
     *
     * ★ 为什么需要它：本项目大量使用**解释性注释**，而注释里常常**引用**被修掉的
     *   坏代码（"这里原先写的是 `onDelta: null`"、"旧代码会弹'回复没有显示'"）。
     *   直接对全文做 `!/onDelta: null/` 这类断言，会被自己的注释反咬一口 ——
     *   报出假失败，而且看起来像是功能没修好。
     *   （与 8.51 / 8.57 记的"断言自己写错"是同一类坑：先抽掉注释再断言。）
     *
     * 注意：只处理行注释与块注释，不解析字符串 —— 对本文件的用途足够。
     */
    function stripComments(src) {
        return String(src)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
    }
    const voiceCode = stripComments(voice);
    const dataCode = stripComments(dataSrc);

    // ============================================================ 1. 接线
    console.log('=== 1. 脚本接线与加载顺序 ===');
    c.ok(/<script src="\/js\/chat-stream\.js"><\/script>/.test(indexHtml), 'index.html 引入 chat-stream.js');
    {
        const coreIdx = indexHtml.indexOf('/js/core.js');
        const streamIdx = indexHtml.indexOf('/js/chat-stream.js');
        c.ok(coreIdx > 0 && streamIdx > coreIdx, 'chat-stream.js 排在 core.js 之后');
        c.ok(streamIdx < indexHtml.indexOf('/js/data.js'), 'chat-stream.js 排在 data.js 之前');
    }
    c.ok(/window\.ChatStream\s*=/.test(streamSrc), 'chat-stream.js 挂到 window.ChatStream（非模块脚本，跨文件必须走 window）');
    c.ok(/requestChatJson/.test(core) && /requestChatJson,/.test(core), 'core 把 requestChatJson 挂进 window.ChatDeps');
    c.ok(/buildThinkingParams,/.test(core), 'core 把 buildThinkingParams 挂进 window.ChatDeps');

    // ============================================================ 2. 思考参数
    console.log('\n=== 2. 思考参数（各家真实字段）===');
    // 从真实实现里取函数来实跑，而不是只做正则匹配 —— 正则会匹配注释里的假代码
    function extractFn(name, src = core) {
        const start = src.indexOf('function ' + name + '(');
        if (start < 0) throw new Error('找不到函数 ' + name);
        let i = src.indexOf('(', start), paren = 0;
        for (; i < src.length; i++) {
            if (src[i] === '(') paren++;
            else if (src[i] === ')') { paren--; if (paren === 0) { i++; break; } }
        }
        let depth = 0;
        i = src.indexOf('{', i);
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
        }
        return src.slice(start, i);
    }
    const buildThinkingParams = new Function('isDeepSeekOfficial', `
        const THINKING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);
        ${extractFn('mapThinkingEffort')}
        ${extractFn('detectThinkingVendor')}
        ${extractFn('buildThinkingParams')}
        return buildThinkingParams;
    `)((url) => /api\.deepseek\.com/i.test(String(url || '')));

    const ds = (enabled, effort) => buildThinkingParams(enabled, effort, 'openai-compatible',
        { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' });

    // ★ 最关键的一条：关必须显式关
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

    // Anthropic：用 reasoning.effort，绝不能用 thinking 字段
    const an = (enabled, effort) => buildThinkingParams(enabled, effort, 'anthropic',
        { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' });
    c.ok(JSON.stringify(an(false)) === JSON.stringify({ reasoning: { effort: 'none' } }),
        'Anthropic 关思考 → reasoning.effort=none', JSON.stringify(an(false)));
    c.ok(!('thinking' in an(true)),
        '★ Anthropic 不发 thinking 字段（那是 Claude 官方 extended thinking，同名不同义，发错会 400）');
    c.ok(an(true, 'low').output_config?.effort === 'low', 'Anthropic 显式档位时补 output_config.effort');

    // Responses：只有 reasoning.effort，没有"关闭"取值
    const rp = (enabled, effort) => buildThinkingParams(enabled, effort, 'openai-responses',
        { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' });
    c.ok(!('reasoning' in rp(false)), 'Responses 关思考 → 不发 reasoning（它没有 none 取值）');
    c.ok(rp(true, 'high').reasoning?.effort === 'high', 'Responses 开思考 → reasoning.effort');

    // 开关关着时**任何格式都不该**冒出强度字段
    for (const [fmt, name] of [['openai-compatible', 'OpenAI 兼容'], ['anthropic', 'Anthropic'], ['openai-responses', 'Responses']]) {
        const p = buildThinkingParams(false, 'high', fmt, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
        const flat = JSON.stringify(p);
        c.ok(!/reasoning_effort|output_config/.test(flat), `关思考时 ${name} 不带强度字段`, flat);
    }

    // 三个 provider 都真的把思考参数发进请求体
    console.log('\n— provider 接线 —');
    for (const [fn, fmt] of [['callOpenAICompatibleChat', 'openai-compatible'], ['callAnthropicChat', 'anthropic'], ['callOpenAIResponsesChat', 'openai-responses']]) {
        const body = providers.slice(providers.indexOf('async function ' + fn));
        const seg = body.slice(0, body.indexOf('\n    }'));
        c.ok(new RegExp(`buildThinkingParams\\(opts\\.thinking, opts\\.thinkingEffort, '${fmt}'`).test(seg),
            `${fn} 传入思考参数（格式 ${fmt}）`);
    }
    // 老逻辑是「thinking 开着 + 模型名是 deepseek-chat → 换成 deepseek-reasoner」。
    // 现在思考由 thinking 字段控制，模型名不该再被换成一个思考专用模型。
    // 断言行为而不是文本：deepseek-reasoner 仍然可以作为**输入**被识别（老用户设置里存着它），
    // 但它不能是**输出** —— 那正是要取消的行为。
    {
        const legacy = new Function(`
            ${extractFn('legacyDeepSeekModel', providers)}
            return legacyDeepSeekModel;
        `)();
        c.ok(legacy('deepseek-chat', true) !== 'deepseek-reasoner',
            '★ thinking 开着时不再把 deepseek-chat 换成 deepseek-reasoner', legacy('deepseek-chat', true));
        c.ok(legacy('deepseek-reasoner', true) === 'deepseek-flash',
            '老用户存着 deepseek-reasoner → 映射到当前模型 deepseek-flash');
        c.ok(legacy('deepseek-v4-pro', true) === 'deepseek-v4-pro',
            '★ 用户明确选的 deepseek-v4-pro 不被降级（那是花他的钱还改他的选择）');
        c.ok(legacy('deepseek-flash', false) === 'deepseek-flash',
            '当前模型名原样透传');
        c.ok(legacy('gpt-4.1-mini', true) === 'gpt-4.1-mini',
            '非 DeepSeek 模型名完全不受影响');
    }

    // ============================================================ 3. 流式解析
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
        // OpenAI 兼容：正文与 reasoning_content 交错
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
        // Anthropic
        {
            const sse = 'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"嗯"}}\n\n'
                + 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"晴天"}}\n\n';
            const r = await CS.consumeStream(sseResponse(sse), 'anthropic');
            c.ok(r.text === '晴天' && r.reasoning === '嗯', 'anthropic：thinking_delta 与 text_delta 分流正确');
            c.ok(r.payload?.content?.some((b) => b.type === 'thinking'), 'anthropic：合成 thinking block');
        }
        // Responses
        {
            const sse = 'data: {"type":"response.reasoning_summary_text.delta","delta":"摘要"}\n\n'
                + 'data: {"type":"response.output_text.delta","delta":"答复"}\n\n';
            const r = await CS.consumeStream(sseResponse(sse), 'openai-responses');
            c.ok(r.text === '答复' && r.reasoning === '摘要', 'openai-responses：摘要与正文分流正确');
        }
        // 多字节字符被网络分块切断
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

    // ============================================================ 4. 流式接线与回退
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

    // 三个 provider 都走 requestChatJson，且都传了 onDelta
    for (const fn of ['callOpenAICompatibleChat', 'callAnthropicChat', 'callOpenAIResponsesChat']) {
        const seg = providers.slice(providers.indexOf('async function ' + fn));
        const body = seg.slice(0, seg.indexOf('\n    }'));
        c.ok(/await requestChatJson\(/.test(body), `${fn} 走 requestChatJson（统一决定流式/非流式）`);
        c.ok(/onDelta: opts\.onDelta/.test(body), `${fn} 把 onDelta 透传下去`);
        c.ok(/signal: opts\.signal/.test(body), `${fn} 把 signal 透传下去（停止按钮）`);
    }

    // postJsonFromDevice 的 5 参签名被另一个检查盯着，这里确认没有加第 6 个形参
    c.ok(/async function postJsonFromDevice\(url, body, headers = \{\}, timeoutMs = 120000, signal = null\)/.test(core),
        'postJsonFromDevice 签名保持 5 个形参（不再有"第 6 个实参被静默丢弃"的 bug）');
    c.ok(/async function fetchWithTimeout\(url, options, timeoutMs, signal = null\)/.test(voice),
        'fetchWithTimeout 显式收外部 signal（不再被 options.signal 覆盖掉）');

    // ============================================================ 5. 回合过程 UI
    console.log('\n=== 5. 回合过程（思考行 + 工具调用行 + 总览）===');
    c.ok(/function createTurnTrace|function beginTurnTrace/.test(ui), 'ui 提供回合过程记录');
    c.ok(/function recordTurnTool/.test(ui), 'ui 提供工具调用记录入口');
    c.ok(/function renderTurnProcess/.test(ui), 'ui 提供过程区渲染');
    c.ok(/function toggleProcessRow/.test(ui), '过程行可展开/折叠');
    c.ok(/class="process-row-head"/.test(ui) && /aria-expanded/.test(ui),
        '过程行用 button + aria-expanded（可键盘操作、可被读屏识别）');

    // ★ 折叠是默认状态：CSS 里 body 默认 display:none，只有 .is-open 才显示
    c.ok(/\.process-row-body\s*\{\s*display:\s*none;/.test(indexHtml),
        '★ 过程行详情默认折叠（CSS 默认 display:none）');
    c.ok(/\.process-row\.is-open \.process-row-body\s*\{\s*display:\s*block;/.test(indexHtml),
        '展开时才显示详情');

    // ★ 工具调用行不受思考开关影响
    c.ok(/const showReasoning = Boolean\(state\.settings\.thinkingMode\);/.test(ui),
        '思考行由思考开关控制');
    c.ok(/for \(const t of trace\.tools\)/.test(ui),
        '★ 工具调用行**无条件**渲染（不受 thinkingMode 影响）');
    {
        // 工具行渲染那段里不能出现 thinkingMode 判断 —— 那正是用户明确要求的行为
        const seg = ui.slice(ui.indexOf('for (const t of trace.tools)'));
        const body = seg.slice(0, seg.indexOf('host.innerHTML'));
        c.ok(!/thinkingMode/.test(body), '★ 工具调用行的渲染代码里没有 thinkingMode 判断');
    }

    // 每回合总览
    c.ok(/turn-summary/.test(ui) && /summaryBits/.test(ui), '有「每回合总览」行（做过什么、成了几个）');
    c.ok(/已思考/.test(ui), '总览里体现"已思考"');
    c.ok(/个操作完成|操作完成/.test(ui), '总览里体现操作完成数量');

    // ★★ 手机端把过程区折叠成一行（2026-10 用户报"AI 思考部分会挡住下面的内容"）
    //
    //    实测（412×915）：过程区每行一条卡片，5 行叠起来占 176px，
    //    把 AI 正文推到 383px 处；多步操作（上限 8 步）时正文直接被挤出首屏。
    //
    // ★★ 2026-10 改为**两段式下拉**（用户要求）：
    //    第一段（点总览行）→ 展开时间线：思考段落与工具调用按先后排列
    //    第二段（点时间线里某条）→ 展开那条的详细内容
    //    并且**桌面与手机统一**（原来桌面端 is-expanded 不影响任何 display，
    //    总览行在桌面上是"点了没反应"的死行，箭头也只有手机才渲染
    //    —— 用户报的"下拉三角形位置不对、点不了"就是这个）。
    c.ok(/function toggleTurnProcess/.test(ui), '★ 过程区有整体展开/收起开关（第一段下拉）');
    c.ok(/toggleTurnProcess\(this\)/.test(ui), '总览行是实际可点的入口（onclick 接线）');
    // 第一段的收起规则必须**两端都生效**（不能再包在移动端媒体查询里）
    {
        // ★ 判断"某条规则在不在媒体查询内"，用**花括号配对**取块内容，
        //   不要用正则去猜缩进 —— 我第一版写 `/^\s*\.turn-process \.process-row \{ display: none; \}/m`
        //   想表达"顶格出现=在媒体查询外"，但 `\s` 也会匹配媒体查询内部的**缩进空格**，
        //   于是正确写在媒体查询里的规则被判成"全局规则"，报出假失败。
        //   （这类"断言自己写错"的坑本项目记过多次，见 8.51 / 8.57。）
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
        const mobileMq = cssBlockAfter(indexHtml, '@media (max-width: 860px) {');
        c.ok(mobileMq !== null, '能找到移动端媒体查询块');
        // ★ 关键：折叠规则在**媒体查询之外**（两端一致），这正是"桌面也能下拉"的前提
        const outside = mobileMq ? indexHtml.replace(mobileMq, '') : indexHtml;
        c.ok(/\.turn-process \.process-row\s*\{\s*display:\s*none;\s*\}/.test(outside),
            '★★ 明细"默认收起"规则在移动端媒体查询**之外**（桌面也生效 —— 两段式统一）');
        c.ok(/\.turn-process\.is-expanded \.process-row\s*\{\s*display:\s*block;\s*\}/.test(outside),
            '★★ 展开时间线的规则同样两端生效');
        // 反向：媒体查询里**不该**再有这条（重复定义会让"哪条生效"变得含糊）
        c.ok(!/\.turn-process \.process-row\s*\{\s*display:\s*none/.test(mobileMq || ''),
            '媒体查询内不再重复定义折叠规则（避免两处定义打架）');
    }

    // ★★ 箭头（第一段的视觉开关）必须两端都显示 ——
    //    它过去只在 @media 里定义 display，桌面上根本不渲染，
    //    用户看到的是**思考行自己的** chevron，于是"点三角形没反应"。
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

    // 状态可视化
    c.ok(/data-state="\$\{escapeHtml\(state/.test(ui), '过程行带 data-state（运行中/成功/失败/已停止）');
    for (const s of ['running', 'ok', 'error', 'stopped']) {
        c.ok(new RegExp(`process-row\\[data-state="${s}"\\]`).test(indexHtml), `状态 ${s} 有独立视觉`);
    }
    c.ok(/processStateLabel/.test(ui) && /运行中/.test(ui) && /失败/.test(ui),
        '状态有中文文案（不只靠颜色，色盲用户也能分辨）');

    // 增量渲染合并
    c.ok(/scheduleTurnProcessRender/.test(ui) && /requestAnimationFrame/.test(ui),
        '★ 流式增量按帧合并渲染（逐 token 重建 DOM 会明显卡顿）');

    // ============================================================ 6. 流式正文预览
    console.log('\n=== 6. 流式正文预览 ===');
    c.ok(/function renderStreamingReplyPreview/.test(voice), '有流式正文预览渲染');
    c.ok(/function removeStreamingReplyPreview/.test(voice), '预览可被收掉');
    c.ok(/onDelta: \(chunk\) =>/.test(voice), '发送流程接了 onDelta 回调');
    c.ok(/chunk\.kind === 'reasoning'/.test(voice), '思考增量归到思考行');
    c.ok(/beginTurnTrace\(message\.id\)/.test(voice), '每轮回复开启一个回合记录');
    c.ok(/finishTurnTrace\(\)/.test(voice), '回复完成时收尾回合记录');
    // ★ 最终内容必须走原来的完整路径（标签剥离、任务抽取要作用在完整文本上）
    c.ok(/const rawResponse = await callAI\(message\.text, aiRequestOptions\)/.test(voice),
        '★ 仍以 callAI 的**完整**返回值作为正文来源（流式只负责先让用户看见）');
    {
        const fin = voice.slice(voice.indexOf('} finally {', voice.indexOf('const rawResponse = await callAI')));
        c.ok(/removeStreamingReplyPreview\(\)/.test(fin.slice(0, 400)),
            '★ finally 里收掉预览（失败/停止路径也要清干净，否则留下幽灵气泡）');
    }

    // ============================================================ 6b. 流式真的能到用户眼前
    //
    // ★★ 2026-10 用户报「AI 不能正常流式输出」+「必须语音生成成功才能发送全部消息」。
    //    两条都是**真 bug**，且都不在 chat-stream.js 的解析逻辑里（那段本来就是好的）：
    //
    //    ⓐ 第三人称模式（state.settings.thirdPerson）在 callAI 里是**提前 return**，
    //       走 generateThirdPersonReply。而它第二段 —— 也就是**用户看到的正文** ——
    //       传的是 `onDelta: null`，于是整条链路一个增量都不回调，界面永远只有一个
    //       "三点气泡"，直到两段请求都跑完才一次性蹦出全文。
    //       第一段（GM 讲述，不进 UI）必须保持 null，第二段必须透传。
    //
    //    ⓑ 同步模式（simultaneous）的正文提交挂在 handleVoiceStart 里，也就是
    //       **TTS 真的出声了才提交**。TTS 失败时旧代码只弹一句"回复没有显示"就丢掉了
    //       整条回复 —— 连聊天记录都不留。语音是增强不是闸门，失败必须降级成纯文字。
    console.log('\n=== 6b. 流式可达性（第三人称两段式 / 同步模式 TTS 降级）===');
    {
        const seg = dataSrc.slice(dataSrc.indexOf('async function generateThirdPersonReply'));
        const body = seg.slice(0, seg.indexOf('\n}\n'));
        c.ok(/async function generateThirdPersonReply/.test(dataSrc), '存在第三人称两段式实现');
        // ── 第一段：正文不进 UI，但**思考**要收（用户要求"第三人称也有思考内容"）──
        const gmOpts = body.slice(body.indexOf('const gmOptions'), body.indexOf('const gmMessages'));
        c.ok(/onDelta: null/.test(gmOpts),
            '★ gmOptions 里 onDelta: null —— 第一段正文绝不流式渲染到界面（它是中间产物）');
        c.ok(/pass1OnDelta/.test(body) && /chunk\.kind === 'reasoning'/.test(body),
            '★★ 第一段仍把**思考**增量透出去（只放 reasoning，不放 text）');
        c.ok(/phase: 1/.test(body), '★ 第一段的思考带 phase=1 标记（与第二段分开，不混成一段）');
        c.ok(/return await generateThirdPersonReply\(text, options\)/.test(dataSrc),
            'callAI 在第三人称开启时提前 return（所以这条路上必须自己接好 onDelta）');
        // ── 第二段：正文与思考都照收 ──
        // ★ 断言跑在**去注释**的源码上 —— 注释里引用了坏代码的原文（"原先写的是
        //   onDelta: null"），拿全文去匹配会报假失败。
        const pass2Seg = dataCode.slice(dataCode.indexOf("pass2Messages.push({ role: 'user'"));
        c.ok(/onDelta: typeof options\.onDelta === 'function'/.test(pass2Seg)
            || /onDelta: options\.onDelta \|\| null/.test(pass2Seg),
            '★★ 第二段（用户看到的正文）透传 onDelta —— 否则开第三人称就完全没有流式');
        c.ok(!/onDelta: null/.test(pass2Seg),
            '★ 第二段里不能再出现 onDelta: null（那正是"开了第三人称就没有流式"的根因）');
        c.ok(/phase: 2/.test(pass2Seg), '★ 第二段的思考带 phase=2 标记');
        // ── 阶段输出：两段各自留一条，供"第一阶段/第二阶段"下拉展开 ──
        c.ok(/options\.onPhase/.test(body), '★★ 两段都通过 onPhase 上报阶段输出（专用下拉的数据源）');
        c.ok(/index: 1/.test(body) && /index: 2/.test(body),
            '★★ 阶段输出带 index 1/2（UI 按它生成"第 N 阶段"条目）');
        // 阶段输出的正文不能带内部标签（<voice_jp> 之类显示出来只是噪音）
        c.ok(/recordTurnPhase|onPhase/.test(voice), 'voice 层把 onPhase 接到记录函数');
        c.ok(/recordTurnPhase\(phase\)/.test(voice), 'voice 层实际调用 recordTurnPhase');

        // ── ⓒ GM 提示词必须**主张**自己的最高优先级 ──────────────────────────
        //
        // 实测故障（用户报「第一阶段输出变成一句第一人称问候」）：
        //   GM 提示词确实在 messages[0]（最高优先级），但它**从没声明**要覆盖角色卡。
        //   而 mergeLeadingSystemMessages 会把开头所有 system 合并成**一条**，
        //   于是"第 1 条"退化成"同一段文本的开头"，后面紧跟着世界观与角色卡：
        //     · 世界观：「不擅自转场、推进时间…不主动长篇」
        //     · 角色卡：「你是伊蕾娜本人，而不是旁白、故事生成器…直接交谈」
        //   两条否定式、且极其具体（角色卡 2251 字符），模型于是丢掉整个人称与格式要求。
        //   修法：GM 提示词开头显式声明优先级 + 覆盖范围；末尾给篇幅兜底
        //   （打招呼可缩短，但**绝不允许**省略【故事】/【状态】或改回第一人称）。
        c.ok(/本提示词优先级最高/.test(dataSrc),
            '★★ GM 提示词声明「优先级最高，覆盖角色卡与世界观」（否则被角色卡压住）');
        c.ok(/不约束本阶段的人称与输出格式/.test(dataSrc),
            '★★ 明确划清边界：角色卡约束"人设口吻"，不约束"人称与输出格式"');
        c.ok(/【篇幅兜底】/.test(dataSrc),
            '★★ 有篇幅兜底（打招呼可缩短，但不许省略标签/改回第一人称）');
        c.ok(/绝不允许.*省略【故事】\/【状态】标签/.test(dataSrc),
            '★★ 兜底条款显式点名"不得省略【故事】/【状态】标签"');
        // 优先级声明必须在**开头**（埋在中间就等于没主张）
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

        // ── ⓓ legacy 回滚路径不能"少一半"（两条真实缺口）─────────────────────
        //
        // 分层路径有、legacy 路径没有的两样东西（本次修掉）：
        //   ① `if (options.thirdPerson) … THIRD_PERSON_GM_PROMPT`
        //      —— 缺了它，切成 legacy 后第三人称第一段**根本不变 GM 视角**，
        //         第二段再把第一人称的话"改写"成第一人称，功能等于失效且不报错。
        //   ② `THINKING_LANGUAGE_PROMPT`
        //      —— 缺了它，切回 legacy 后思维链变成英文。
        // 这类"两条路各走样"是本项目反复踩的坑，所以两边都要断言。
        {
            const legacySeg = dataCode.slice(dataCode.indexOf('function buildLegacyRoleplayMessages'),
                dataCode.indexOf('async function callAI'));
            c.ok(/THIRD_PERSON_GM_PROMPT/.test(legacySeg),
                '★★ legacy 路径也会因 thirdPerson 注入 GM 提示词（原为永不生效的真 bug）');
            c.ok(/if \(options\.thirdPerson\) systemParts\.push\(THIRD_PERSON_GM_PROMPT\)/.test(legacySeg),
                '★ legacy 的注入是条件式的（非 thirdPerson 时不得误注入）');
            c.ok(/THINKING_LANGUAGE_PROMPT/.test(legacySeg),
                '★★ legacy 路径也注入思考语言要求（原为缺口：切回 legacy 思维链变英文）');
            // GM 必须排在角色卡之前（位置语义与分层路径 messages[0] 一致）
            const gmAt = legacySeg.indexOf('systemParts.push(THIRD_PERSON_GM_PROMPT)');
            const cardAt = legacySeg.indexOf('systemParts.push(legacyCharacterPrompt)');
            c.ok(gmAt >= 0 && cardAt > gmAt,
                '★★ legacy 里 GM 提示词排在角色卡**之前**（否则优先级语义就反了）');
        }

        // ── ⓔ 两段式生成的**两段**都要有中文思维链要求 ────────────────────────
        //
        // 实测（用户报「第一阶段中文思维链、第二阶段英文思维链」）：
        //   第一段走 buildLayeredRoleplayMessages()，那里有 THINKING_LANGUAGE_PROMPT；
        //   第二段是**手搭的最小消息数组**（转换提示词 + 可选 voice_jp），
        //   压根没继承那条全局要求 → 模型用默认语言（英文）思考。
        //   这与 legacy 漏注入是同一类疏漏：**凡自己拼消息列表的地方都会丢全局要求**。
        {
            // ★ 边界要用 generateThirdPersonReply **之后**的函数当终点。
            //   第一版我拿 'async function callAI' 当终点，但它在文件里排在
            //   generateThirdPersonReply **之前**（L417 vs L534）—— slice 得到空串，
            //   四条断言全部假失败。这类"断言自己写错"本项目记过多次（8.51/8.57）。
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
            // 第一阶段同样要有（两边一起断言，避免只顾一头）
            const p1 = gen3p.slice(0, gen3p.indexOf('const pass2Messages'));
            c.ok(/buildLayeredRoleplayMessages/.test(p1),
                '★ 第一阶段经 buildLayeredRoleplayMessages（其中已含中文思维链要求）');
        }

        // ⓑ 语音失败时必须提交文字回复（两个模式都不丢）
        c.ok(/const commitAiMessageOnce = \(\) => \{/.test(voice), '有幂等的消息提交函数');
        // "没有收到可播放语音"这条分支里必须调用 commitAiMessageOnce
        const noVoice = voice.slice(voice.indexOf('if (!voiceStarted) {'));
        const noVoiceBody = noVoice.slice(0, noVoice.indexOf('.catch('));
        c.ok(/commitAiMessageOnce\(\)/.test(noVoiceBody),
            '★★ 语音未生成时仍提交文字回复（语音是增强，不是发送闸门）');
        c.ok(!/回复没有显示/.test(voiceCode),
            '★ 旧的"语音失败 → 回复不显示"文案已删除（注释里的引用不算，故去注释后断言）');
        // catch 路径同样不能丢消息
        const catchSeg = voice.slice(voice.indexOf('.catch(error => {'), voice.indexOf('.finally(() => pendingAutomaticVoiceMessageIds.delete'));
        c.ok(/commitAiMessageOnce\(\)/.test(catchSeg),
            '★ TTS 抛错时也提交文字回复（否则同步模式下整条回复消失）');

        // 预览不能被协议标签污染（`[操作:…]` / `<voice_jp>` 会随增量滚过屏幕）
        c.ok(/function sanitizeStreamingPreviewText/.test(voice),
            '★ 流式预览有净化函数（标签必须随增量就剥掉，不能等最终渲染）');
        c.ok(/window\.ElainaTags\.strip/.test(voice),
            '★ 净化复用宿主权威的 ElainaTags.strip（标签名清单只有一处）');
        c.ok(/<voice_jp>\[\\s\\S\]\*\$/.test(voice) || /voice_jp/.test(voice),
            '★ 半截的 <voice_jp> 也要藏起（朗读稿不能先于正文露出来）');
    }

    // ============================================================ 6c. 中转超时必须是"空闲"语义
    //
    // ★★ 这是"AI 不能流式"的**服务端根因**。旧实现把 timeoutMs 当成"整条请求的
    //    总时长"：`setTimeout(abort, timeoutMs)` 一直挂到响应体转发完。而流式的
    //    长回复正常就要好几分钟、高思考强度模型首字节本身就常 >120 秒 ——
    //    于是请求在**等待期**被本地掐掉，前端只能"退回非流式"。
    //    实测现场：data/logs/2026-10-13_20-23-53.trace.log
    //      `请求失败 POST …/messages — 超过 120 秒没有响应（120020ms）`
    //      → `[Chat] anthropic 流式不可用，退回非流式`
    console.log('\n=== 6c. 中转超时语义（空闲续期，不是总时长）===');
    {
        // ★ 2026-10：这几条判的是**中继实现**，它已随中继搬到 server/relay.mjs（两端共用），
        //   所以改看 relaySrc —— 继续盯 serve.mjs 只会在搬家后误报"行为没了"。
        c.ok(/const armIdleTimer = \(ms\) =>/.test(relaySrc),
            '★ 中转用 armIdleTimer 续期（每收到一块就重置计时）');
        c.ok(/armIdleTimer\(timeoutMs\)/.test(relaySrc), '转发循环里对每块数据续期');
        c.ok(/hardDeadline/.test(relaySrc),
            '★ 空闲续期之外还有总时长硬顶（防"一直发心跳不说正文"占住连接）');
        c.ok(/flushHeaders/.test(relaySrc),
            '★ 响应头立刻 flush（否则前端要等第一块数据才知道流已经开始）');
        c.ok(/X-Accel-Buffering/.test(relaySrc),
            '★ SSE 关闭中间层缓冲（X-Accel-Buffering: no）');
        // 客户端的超时预算：思考模式要放宽，否则首字节还没来就被本地掐断
        c.ok(/CHAT_TIMEOUT_THINKING_MS/.test(core) && /CHAT_TIMEOUT_DEFAULT_MS/.test(core),
            '★ 客户端区分普通/思考两档超时（思考模式首字延迟常超 2 分钟）');
        c.ok(/opts\.thinking \? CHAT_TIMEOUT_THINKING_MS : CHAT_TIMEOUT_DEFAULT_MS/.test(core),
            '★ callChatAPI 按 thinking 开关选超时预算');
        c.ok(/opts\.timeoutMs/.test(core) && /Number\.isFinite\(opts\.timeoutMs\)/.test(core),
            '★ 调用方显式传的 timeoutMs 优先（不被默认值覆盖）');
    }

    // ============================================================ 7. 设置界面
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
    // ★ 从输入框菜单里彻底移走（否则同一个设置有两个入口，会互相不同步）
    c.ok(!/id="composerThinkingToggle"/.test(indexHtml), '★ 输入框菜单里的思考开关已移除');
    c.ok(!/id="initialComposerThinkingToggle"/.test(indexHtml), '★ 首屏菜单里的思考开关也已移除');
    c.ok(!/syncComposerThinkingToggles/.test(core + voice + init),
        '★ 旧的菜单同步函数已删除（没有残留调用）');
    c.ok(!/MiniMax 请求，默认关闭/.test(indexHtml), '★ 旧的错误提示文案（"MiniMax 请求"）已删除');
    // 设置读写接线
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
    // 请求侧接线
    c.ok(/thinkingEffort: state\.settings\.thinkingEffort/.test(readFileSync(path.join(ROOT, 'web', 'js', 'data.js'), 'utf8')),
        'callAI 把思考强度带进请求');

    // html 只在上面用于前置读取（与源脚本一致）；显式引用一下，避免被当成未使用变量清掉
    void html;
}

// 按命令行参数过滤用例（便于只跑其中一段）
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
