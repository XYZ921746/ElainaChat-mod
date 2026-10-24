// ============================================================================
//  对话 API 格式适配器（从 index.html 拆分而来）
// ============================================================================
//
//  这里放"同一件事、三种协议"的实现：
//    openai-compatible  POST /v1/chat/completions   （DeepSeek / 硅基流动 / OneAPI / Ollama…）
//    anthropic          POST /v1/messages           （Claude 官方）
//    openai-responses   POST /v1/responses          （OpenAI 官方，协议和上面两个都不同）
//
//  为什么要拆出来：
//    · 这三套协议加起来 300+ 行，占了 index.html 相当一块，而它们与界面毫无关系；
//    · 新增一种格式时，只该动这个文件 + 往下面的 PROVIDERS 表加一行，
//      不该再去改 index.html 里的分发逻辑（改漏一处就是"某格式静默失效"）。
//
//  依赖注入而不是 import
//  ----------------------
//  这是普通 <script>（不是 ES module），文件之间作用域独立 —— 拆出去后直接调用
//  index.html 里的 getChatBaseUrl() 会拿到 undefined。
//  所以依赖统一从 window.ChatDeps 取（由 index.html 在加载本文件之前挂上）。
//  这样做的好处：**调用方一行都不用改**，风险只在"依赖有没有挂全"。
//
//  加载顺序（index.html 里必须保证）：
//    1. <script src="/js/chat-providers.js"></script>   ← 先加载（只定义，不执行依赖）
//    2. 主脚本挂 window.ChatDeps
//    3. 主脚本调 window.ChatProviders.forFormat(...)
//  因为依赖是**调用时**才取（每次进函数都 d() 一次），所以 1 和 2 的先后其实不敏感，
//  但保持"先加载本文件"更符合直觉。

(function () {
    'use strict';

    /**
     * 从 400 响应里判断"网关拒绝的是哪个参数"。
     *
     * 认识 `thinking` / `reasoning_effort` / `tools` 三类：前两类是**思考参数**
     *   （同一个语义各家字段名不同，没有全网通用的一种），`tools` 是**工具声明**
     *   （部分网关与中转不认识这个字段）。三者被拒时的处置方向一致 ——
     *   剥掉它重试，好过让整个请求失败。
     * 认不出元凶的 400（如 `param:"image"`）必须原样抛错：剥别的字段毫无用处，
     *   重试只会白打几次请求，还盖住真正的原因。
     *
     * 依据两类信号：
     *   ① OpenAI 风格错误的 `param` 字段（最可靠 —— 网关亲口点名）：
     *      {"error":{"message":"…","param":"thinking","code":"unsupported_parameter"}}
     *   ② 报错文本里点名（各家措辞不同，按关键词匹配）
     *
     * @param {{status:number, payload?:object, rawText?:string}} result
     * @returns {string|null} 被拒的参数名；认不出返回 null（照常抛错，别重试）
     */
    function rejectedRequestParam(result) {
        if (!result || result.status !== 400) return null;
        const KNOWN = new Set(['thinking', 'reasoning_effort', 'tools']);
        // ① 结构化字段：error.param（可能嵌在 detail 里 —— FastAPI 系网关爱包一层）
        const payloads = [result.payload, result.payload?.detail];
        for (const p of payloads) {
            const param = p?.error?.param;
            if (typeof param === 'string' && KNOWN.has(param.trim())) return param.trim();
        }
        // ② 报错文本关键词（原文可能出现在 message 或 rawText 里）
        const text = [
            result.payload?.error?.message,
            result.payload?.detail?.error?.message,
            result.payload?.detail?.message,
            result.payload?.message,
            typeof result.payload?.detail === 'string' ? result.payload.detail : '',
            result.rawText,
        ].filter(Boolean).join(' ');
        // 顺序有讲究：先认 reasoning_effort（更长、更specific，避免被 "reasoning" 抢先命中）
        if (/reasoning_effort/i.test(text) && /(not|un)supported|invalid|unknown|must be/i.test(text)) return 'reasoning_effort';
        if (/"?thinking"? is (not supported|unknown)|unsupported_parameter.*thinking|unknown parameter: ?"?thinking/i.test(text)) return 'thinking';
        if (/both ['"]?thinking['"]? and ['"]?reasoning_effort/i.test(text)) return 'thinking';
        // tools：要求"点到了 tools"且"同时有拒绝词"，避免把别的报错里恰好出现的 tools 认成元凶
        if (/\btools\b/i.test(text) && /(unrecognized|unsupported|unknown|not permitted|not supported|invalid|extra inputs)/i.test(text)) return 'tools';
        return null;
    }

    /**
     * 这个「地址 + 模型」的网关**认不认 tools**（本次运行内的记忆）。
     *
     * 为什么要有它：BYOK 下供应商千奇百怪，有的把 tools 直接 400 掉（见
     *   rejectedRequestParam），有的干脆把未知字段悄悄丢掉（请求 200、回复里却没有
     *   tool_calls）。撞过一次之后不该每次都再撞 —— 每次撞都意味着用户白等一次完整
     *   请求，而且这次回复既没有标签也没有工具，等于什么都没做。
     *
     * 只存在内存里、不写设置：它是"这次运行、这台机器、这个地址"的观察结果；
     *   写进设置会让一次偶发失败把用户**永久**降级到标签通道。
     */
    const toolsRejectedKeys = new Set();
    const toolsKey = (baseUrl, model) => String(baseUrl || '') + '|' + String(model || '');
    function toolsAllowedFor(baseUrl, model) {
        return !toolsRejectedKeys.has(toolsKey(baseUrl, model));
    }
    function noteToolsRejected(baseUrl, model) {
        const key = toolsKey(baseUrl, model);
        if (toolsRejectedKeys.has(key)) return;
        toolsRejectedKeys.add(key);
        console.warn('[Provider] 网关不接受 tools，本次运行内该地址改走文本标签通道 (base=' + baseUrl + ')');
    }

    /**
     * 把一处工具调用收成**统一形状**（两条协议共用这一份映射）。
     *
     * 统一在这里做，而不是各 provider 各做一份：OpenAI 的 `arguments` 是**字符串**、
     *   Anthropic 的 `input` 是**对象**，上层不该关心这个差别。
     * 参数不是合法 JSON 时**不抛**：标成 badArgs 交出去，由上层回灌一条"参数不合法"
     *   的工具结果让模型重试 —— 静默丢掉会让模型以为"调过了、只是没结果"。
     */
    function toToolCall(id, name, rawArgs) {
        let args = {};
        let badArgs = false;
        try {
            const parsed = JSON.parse(typeof rawArgs === 'string' ? (rawArgs || '{}') : JSON.stringify(rawArgs ?? {}));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
            args = parsed;
        } catch { badArgs = true; }
        return { id: String(id || ''), name: String(name || ''), args, badArgs, raw: String(rawArgs || '') };
    }
    /** OpenAI 形态：`message.tool_calls` */
    function openAiToolCalls(message) {
        const list = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        return list.filter((c) => c && c.function && c.function.name)
            .map((c) => toToolCall(c.id, c.function.name, c.function.arguments));
    }
    /** Anthropic 形态：`tool_use` block */
    function anthropicToolCalls(blocks) {
        const list = Array.isArray(blocks) ? blocks : [];
        return list.filter((b) => b && b.type === 'tool_use' && b.name)
            .map((b) => toToolCall(b.id, b.name, b.input ?? {}));
    }
    /** openai-responses 形态：`output` 里的 `function_call` 项 */
    function toResponsesToolCalls(items) {
        const list = Array.isArray(items) ? items : [];
        return list.filter((it) => it && it.type === 'function_call' && it.name)
            .map((it) => toToolCall(it.call_id ?? it.id, it.name, it.arguments));
    }

    /**
     * 把"这次回复是从哪条通道来的"交给调用方 —— 走调用方传进来的**显式容器**
     * （`opts.replyInfo`），不用全局槽位。
     *
     * 为什么不用全局的"上次回复元信息"：全库有多处调 callChatAPI（记忆摘要、
     *   翻译、连接测试…），它们只关心正文；而"上一个请求的元信息"在下一次请求
     *   出错或重试时会说不清是哪一次的值，误读的后果是"执行了一个根本没发生的调用"。
     */
    function reportReplyInfo(opts, info) {
        if (opts && opts.replyInfo) Object.assign(opts.replyInfo, info);
    }

    /**
     * 取依赖。每次调用都取一次而不是在模块顶层缓存 ——
     * 顶层缓存会在"本文件先加载、ChatDeps 后挂上"时拿到 undefined，
     * 而且那种失败是**静默的**（函数存在，调用时才炸）。每次取最稳。
     */
    function deps() {
        const d = window.ChatDeps;
        if (!d) {
            throw new Error('ChatDeps 未初始化（chat-providers.js 与主脚本的加载顺序不对）');
        }
        return d;
    }

    // ========================================================================
    //  1. OpenAI 兼容（/v1/chat/completions）
    // ========================================================================

    /**
     * 把已废弃的 DeepSeek 模型名映射到现在的名字。
     *
     * 为什么要留这一层：DeepSeek 官方文档明确写了 `deepseek-chat` 这类老名字
     * **仍然被接受**，但请求其实由 deepseek-flash 服务（按 flash 计费）。
     * 用户设置里存着老名字时，如果我们直接原样发，行为其实是对的；
     * 唯一需要处理的是 `deepseek-reasoner` —— 它是"思考专用模型"时代的产物，
     * 现在思考由 thinking 字段控制，模型名统一了。
     *
     * 所以规则是：
     *   · 老名字 → 换成当前名字（deepseek-flash），让计费和能力都符合预期；
     *   · 已经填了新名字（deepseek-flash / deepseek-v4-pro）→ 一个字都不动，
     *     绝不擅自把用户明确选择的 pro 降成 flash（那是花用户的钱还改他的选择）。
     *
     * @param {string} model 用户填的模型名
     * @param {boolean} thinking 是否开了思考（老 reasoner 名字隐含"要思考"）
     */
    function legacyDeepSeekModel(model, thinking) {
        const name = String(model || '').trim().toLowerCase();
        if (name === 'deepseek-chat' || name === 'deepseek-reasoner' || name === 'deepseek-coder') {
            return 'deepseek-flash';
        }
        return String(model || '').trim() || 'deepseek-flash';
    }

    async function callOpenAICompatibleChat(messages, opts, settings) {
        const { ClientApiError, getChatBaseUrl, isDeepSeekOfficial, requestChatJson, buildThinkingParams, normalizeChatReply, throwProviderResponseError } = deps();
        const { apiKey, model } = settings;
        if (!apiKey) {
            throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写 API Key');
        }
        const baseUrl = getChatBaseUrl(settings);
        const endpoint = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
        // 换模型名这条老路保留，但**只在用户填的就是那个已废弃的名字时**才换：
        // DeepSeek 现在的模型是 deepseek-flash / deepseek-v4-pro，思考由 thinking 字段控制，
        // 不再需要 reasoner 这个模型。可老用户设置里存着 deepseek-chat / deepseek-reasoner，
        // 直接不管会让他们的配置一夜之间失效，所以这里做一次兼容映射。
        const rawModel = String(model || 'deepseek-chat').trim();
        const requestModel = isDeepSeekOfficial(baseUrl)
            ? legacyDeepSeekModel(rawModel, opts.thinking === true)
            : rawModel;
        // 思考开关与强度：显式发 disabled 很重要 —— DeepSeek 现在**默认开启**思考，
        // 不发这个字段的话，用户明明关了开关，模型照样思考（慢且费 token）。
        const thinkingFields = buildThinkingParams(opts.thinking, opts.thinkingEffort, 'openai-compatible', settings);
        // 工具声明单独一个容器：被网关拒时要能**单独剥掉它**（见下面的重试），
        //   而不是把思考参数一起牺牲掉。不主动发 tool_choice —— 有 tools 时它本就是
        //   auto，少一个字段就少一次被某些网关挑刺的机会。
        let toolFields = (opts.tools?.length && toolsAllowedFor(baseUrl, requestModel))
            ? { tools: opts.tools }
            : {};
        const buildBody = (thinking, tools) => ({
            model: requestModel,
            messages,
            ...(opts.temperature !== undefined && { temperature: opts.temperature }),
            ...(Number.isFinite(opts.maxTokens) && { max_tokens: Math.max(1, Math.floor(opts.maxTokens)) }),
            ...tools,
            ...thinking,
        });
        let result = await requestChatJson(endpoint, buildBody(thinkingFields, toolFields),
            { Authorization: 'Bearer ' + apiKey }, {
                signal: opts.signal, onDelta: opts.onDelta, stream: opts.stream,
            }, 'openai-compatible');

        // 严格网关兼容：400 + 报错点名某参数 → 剥掉它重试。
        //
        //   背景：`thinking` 不是 OpenAI Chat Completions
        //   标准字段（只有 DeepSeek 系认），`reasoning_effort` 也有网关不认（如 OpenAI
        //   Responses 系模型报"moved to reasoning.effort"）；甚至有的网关报
        //   "cannot specify both 'thinking' and 'reasoning_effort'"。**没有一个字段
        //   全网通用**，hermes-agent #34786 等项目的做法都是"先发，被 400 拒了按
        //   报错剥参数重试"。这里照做，且按 OpenAI 风格错误里的 `param` 字段精确剥：
        //
        //     "thinking" is not supported …（AMD，param: "thinking"）→ 只剥 thinking
        //     Invalid 'reasoning_effort' …          → 只剥 reasoning_effort
        //
        //   剥掉 thinking 后 DeepSeek 系网关会回到"模型默认思考"状态 —— 这是没办法
        //   的事（网关不支持就是不支持），但至少对话能通，好过整个请求失败。
        //   记忆结论：同一 baseUrl 只撞一次 400，之后直接跳过被拒字段（见 supportsParam）。
        const rejectedParams = new Set();   // 本次调用里已被该网关拒绝的参数名
        for (let attempt = 0; attempt < 3 && !result.ok && result.status === 400; attempt++) {
            const param = rejectedRequestParam(result);
            if (!param || !rejectedParams.add(param)) break;   // 认不出元凶 / 已经剥过了
            console.warn(`[Provider] gateway rejected "${param}" - retrying without it`
                + ` (base=${baseUrl})`);
            if (param === 'tools') {
                // 这个网关不认 tools：剥掉重发，并记下来"本次运行内该地址不再发它"
                //   —— 上层据此改走文本标签通道（见 noteToolsRejected 的说明）
                noteToolsRejected(baseUrl, requestModel);
                toolFields = {};
            } else {
                delete thinkingFields[param];
                // thinking 和 reasoning_effort 常被一起拒（"invalid combination"），
                // 报错点名 thinking 时把强度也一并剥掉，省一次往返。
                if (param === 'thinking' && 'reasoning_effort' in thinkingFields) delete thinkingFields.reasoning_effort;
            }
            result = await requestChatJson(endpoint, buildBody(thinkingFields, toolFields),
                { Authorization: 'Bearer ' + apiKey }, {
                    signal: opts.signal, onDelta: opts.onDelta, stream: opts.stream,
                }, 'openai-compatible');
        }
        if (!result.ok) await throwProviderResponseError(result, '对话服务请求失败');
        if (!result.payload) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '对话服务返回格式异常');
        const message = result.payload.choices?.[0]?.message || {};
        const toolCalls = openAiToolCalls(message);
        const reasoningText = String(message.reasoning_content || message.reasoning || '');
        reportReplyInfo(opts, {
            toolCalls,
            finishReason: String(result.payload.choices?.[0]?.finish_reason || ''),
            // "本来要发工具、结果一个字段都没发出去" —— 上层据此决定走哪条通道
            toolsSkipped: Boolean(opts.tools?.length) && !toolFields.tools,
            // 思考交给兜底通道（见 core.js 里 replyInfo.reasoning 的说明）：
            //   流式时这段早由 onDelta 送进时间线了，再报一次会重复；
            //   所以调用方只在"没收到过流式思考"时才用它对账。
            reasoning: reasoningText,
        });
        return normalizeChatReply(message.content, reasoningText, toolCalls);
    }

    // ========================================================================
    //  2. Anthropic（/v1/messages）
    // ========================================================================
    /** 把 OpenAI 形态的 content 转成 Anthropic 的 content blocks */
    function anthropicContentBlocks(content) {
        const { stripThinkTags, extractTextContent } = deps();
        if (typeof content === 'string') return [{ type: 'text', text: content || ' ' }];
        const blocks = [];
        for (const part of Array.isArray(content) ? content : []) {
            if (part?.type === 'text') {
                blocks.push({ type: 'text', text: String(part.text ?? '') });
            } else if (part?.type === 'image_url') {
                const url = String(part.image_url?.url || '');
                const match = url.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([^]+)$/i);
                if (match) {
                    blocks.push({
                        type: 'image',
                        source: { type: 'base64', media_type: match[1].toLowerCase(), data: match[2] }
                    });
                } else {
                    blocks.push({ type: 'text', text: '[图片]' });
                }
            } else {
                blocks.push({ type: 'text', text: '[附件]' });
            }
        }
        return blocks.length ? blocks : [{ type: 'text', text: ' ' }];
    }

    /** OpenAI messages → Anthropic { system, messages }。
     *
     *  工具协议消息在这里一并换形状 —— Anthropic 没有 role:'tool' 这一层：
     *    · assistant 的 tool_calls → content 里的 tool_use block（参数是**对象**）
     *    · role:'tool' 的结果      → user 消息里的 tool_result block
     *  形状对不上会被 400 拒收，而多步任务的历史里这两种消息是常态 ——
     *  不转换的话第二轮请求就发不出去了。
     */
    function convertOpenAIToAnthropicMessages(messages) {
        const { extractTextContent, stripThinkTags } = deps();
        const systemParts = [];
        const converted = [];
        for (const msg of messages || []) {
            const role = msg?.role;
            if (role === 'system') {
                systemParts.push(extractTextContent(msg.content));
            } else if (role === 'user') {
                converted.push({ role: 'user', content: anthropicContentBlocks(msg.content) });
            } else if (role === 'tool') {
                // 工具结果只能以 user 角色的 tool_result block 出现，且
                // tool_use_id 必须与调用对得上 —— 丢了这个字段模型无从知道
                // 「哪一步的 结果回来了」，多步链路当场断掉。
                converted.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: String(msg.tool_call_id || msg.toolCallId || ''),
                        content: String(msg.content ?? ''),
                    }],
                });
            } else if (role === 'assistant') {
                const blocks = [];
                const text = stripThinkTags(extractTextContent(msg.content));
                if (text) blocks.push({ type: 'text', text });
                for (const call of (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])) {
                    if (!call?.function?.name) continue;
                    let input = {};
                    // 参数在 OpenAI 侧是字符串，Anthropic 侧要对象；解析失败给空对象
                    // 并保留调用本身 —— 丢掉整条调用会让后面的 tool_result 对不上号。
                    try { input = JSON.parse(call.function.arguments || '{}'); } catch { input = {}; }
                    blocks.push({ type: 'tool_use', id: String(call.id || ''), name: String(call.function.name), input });
                }
                if (!blocks.length) blocks.push({ type: 'text', text: ' ' });
                converted.push({ role: 'assistant', content: blocks });
            }
        }
        // 相邻同角色合并成一条 —— Anthropic 不接受连续的 user 或 assistant
        // （工具结果转成 user 后，与紧随的用户消息相邻是常态，必须合并）
        const merged = [];
        for (const msg of converted) {
            const last = merged[merged.length - 1];
            if (last && last.role === msg.role) {
                const prevBlocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content || ' ') }];
                const nextBlocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || ' ') }];
                last.content = prevBlocks.concat(nextBlocks);
            } else {
                merged.push({ ...msg });
            }
        }
        return { system: systemParts.filter(Boolean).join('\n\n'), messages: merged };
    }

    async function callAnthropicChat(messages, opts, settings) {
        const { ClientApiError, getChatBaseUrl, requestChatJson, buildThinkingParams, normalizeChatReply, throwProviderResponseError, ANTHROPIC_MIN_MAX_TOKENS } = deps();
        const { apiKey, model } = settings;
        if (!apiKey) {
            throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写 Anthropic API Key');
        }
        const baseUrl = getChatBaseUrl(settings).replace(/\/+$/, '');
        const endpoint = /\/messages$/i.test(baseUrl)
            ? baseUrl
            : (/\/v\d+$/i.test(baseUrl) ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`);
        const payload = convertOpenAIToAnthropicMessages(messages);
        const modelName = String(model || '').trim() || 'claude-sonnet-4-20250514';
        // 下限已经由主脚本的 resolveOutputTokenLimit(model, maxTokens, true) 统一算好
        // （那条链路无条件保底 4096，见 ANTHROPIC_MIN_MAX_TOKENS 的说明）。
        // 这里只兜个底，防止有人绕过 callChatAPI 直接调本函数。
        const maxTokens = Number.isFinite(opts.maxTokens)
            ? Math.max(1, Math.floor(opts.maxTokens))
            : ANTHROPIC_MIN_MAX_TOKENS;
        // 工具声明：OpenAI 形状（嵌套 function{} + parameters）换成 Anthropic 的
        // 扁平形状（input_schema）。不发或发错形状都会被 400 拒收 —— 那样
        // 工具通道静默失效，模型只能靠正文标签兜底，用户看到的就是"AI 不调用工具"。
        const tools = (opts.tools?.length)
            ? opts.tools
                .filter((t) => t?.type === 'function' && t.function?.name)
                .map((t) => ({
                    name: String(t.function.name),
                    description: String(t.function.description || ''),
                    input_schema: t.function.parameters || { type: 'object', properties: {} },
                }))
            : null;
        const result = await requestChatJson(endpoint, {
            model: modelName,
            system: payload.system || undefined,
            messages: payload.messages,
            max_tokens: maxTokens,
            ...(tools ? { tools } : {}),
            // 开了思考就**不能**带 temperature：Anthropic 官方明确禁止
            //   （"temperature may only be set to 1 when thinking is enabled"），
            //   带了会直接 400。宁可让用户少一个采样参数，也不能让请求失败。
            //   DeepSeek 那边同样是"思考模式不支持 temperature"（发了不报错但也不生效）。
            ...(opts.temperature !== undefined && !opts.thinking && { temperature: opts.temperature }),
            // 思考开关：Anthropic 侧走 reasoning.effort（none = 关闭）。
            // 这里**不用** `thinking` 字段：那是 Claude 官方 extended thinking 的
            //   {type, budget_tokens} 结构，和这里的开关同名不同义，发错会 400。
            ...buildThinkingParams(opts.thinking, opts.thinkingEffort, 'anthropic', settings)
        }, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, {
            signal: opts.signal, onDelta: opts.onDelta, stream: opts.stream,
        }, 'anthropic');
        if (!result.ok) await throwProviderResponseError(result, 'Anthropic 请求失败');
        if (!result.payload) throw new ClientApiError('UPSTREAM_UNAVAILABLE', 'Anthropic 返回格式异常');
        const blocks = Array.isArray(result.payload.content) ? result.payload.content : [];
        const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text || '').join('');
        const reasoning = blocks.filter((block) => block?.type === 'thinking').map((block) => block.thinking || '').join('');
        // 工具调用：Anthropic 形态是 content 里的 tool_use block，
        //   anthropicToolCalls 已把它收成统一形状 —— 不解析的话 replyInfo.toolCalls
        //   永远是空的，工具通道在这条格式下等于不存在。
        const toolCalls = anthropicToolCalls(blocks);
        reportReplyInfo(opts, {
            reasoning,
            toolCalls,
            finishReason: String(result.payload.stop_reason || ''),
            toolsSkipped: Boolean(opts.tools?.length) && !tools,
        });
        return normalizeChatReply(text, reasoning, toolCalls);
    }

    // ========================================================================
    //  3. OpenAI 官方 Responses（/v1/responses）
    // ========================================================================
    /*  它和 chat/completions 不是同一套协议，必须单独适配，不能靠改个路径蒙混：
     *    · 系统提示走顶层 instructions，不是 messages 里的一条
     *    · 对话内容走 input 数组，每项 { role, content: [{ type:'input_text'|'output_text'|'input_image' }] }
     *    · 输出上限参数叫 max_output_tokens，不叫 max_tokens
     *    · 回复不在 choices[0].message.content，而在 output[] 里 type === 'message' 那些项的 content 块里
     *  这些字段名是官方文档定的，写错会直接 400，而报错往往只说 "unknown parameter"，
     *  排查起来很费劲，所以在这里一次写清楚。 */

    function convertOpenAIToResponsesInput(messages) {
        const { extractTextContent } = deps();
        const instructions = [];
        const input = [];
        for (const msg of messages || []) {
            const role = msg?.role;
            if (role === 'system') {
                instructions.push(extractTextContent(msg.content));
                continue;
            }
            // 工具结果：Responses 没有 role:'tool' 这一层 —— 它是 input 里的
            // function_call_output 项，call_id 必须与调用对得上。
            if (role === 'tool') {
                input.push({
                    type: 'function_call_output',
                    call_id: String(msg.tool_call_id || msg.toolCallId || ''),
                    output: String(msg.content ?? ''),
                });
                continue;
            }
            const isAssistant = role === 'assistant';
            // assistant 的工具调用：每个调用是**单独一个** function_call 项 ——
            // Responses 不把它们挂在消息上。正文（若有）仍走 output_text 项。
            if (isAssistant && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
                for (const call of msg.tool_calls) {
                    if (!call?.function?.name) continue;
                    input.push({
                        type: 'function_call',
                        call_id: String(call.id || ''),
                        name: String(call.function.name),
                        // 参数按原样字符串回填：Responses 的 arguments 就是字符串，
                        // 重新序列化会改变它的形状（见 getRecentHistoryMessages 同样的取舍）
                        arguments: String(call.function.arguments || '{}'),
                    });
                }
                const assistantText = extractTextContent(msg.content).trim();
                if (assistantText) {
                    input.push({ role: 'assistant', content: [{ type: 'output_text', text: assistantText }] });
                }
                continue;
            }
            const textType = isAssistant ? 'output_text' : 'input_text';
            const parts = [];
            const content = msg.content;
            if (typeof content === 'string') {
                parts.push({ type: textType, text: content || ' ' });
            } else {
                for (const part of Array.isArray(content) ? content : []) {
                    if (part?.type === 'text') {
                        parts.push({ type: textType, text: String(part.text ?? '') });
                    } else if (part?.type === 'image_url') {
                        // Responses 的图片用 input_image.image_url，字符串 URL 或 data URL 都直接收
                        const url = String(part.image_url?.url || '');
                        if (/^(https?:\/\/|data:)/i.test(url)) parts.push({ type: 'input_image', image_url: url });
                        else parts.push({ type: textType, text: '[图片]' });
                    } else {
                        parts.push({ type: textType, text: '[附件]' });
                    }
                }
            }
            if (!parts.length) parts.push({ type: textType, text: ' ' });
            input.push({ role: isAssistant ? 'assistant' : 'user', content: parts });
        }
        return { instructions: instructions.filter(Boolean).join('\n\n'), input };
    }

    async function callOpenAIResponsesChat(messages, opts, settings) {
        const { ClientApiError, getChatBaseUrl, requestChatJson, buildThinkingParams, normalizeChatReply, throwProviderResponseError } = deps();
        const { apiKey, model } = settings;
        if (!apiKey) {
            throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写 OpenAI API Key');
        }
        const baseUrl = getChatBaseUrl(settings).replace(/\/+$/, '');
        const endpoint = /\/responses$/i.test(baseUrl) ? baseUrl : `${baseUrl}/responses`;
        const payload = convertOpenAIToResponsesInput(messages);
        // 工具声明：Responses 用扁平形状（name/description/parameters 直接平铺，
        // 没有 chat/completions 那层 function{} 嵌套）—— 发错形状直接 400，
        // 而且报错只说 unknown parameter，很难排查，所以在这里一次写对。
        const tools = (opts.tools?.length)
            ? opts.tools
                .filter((t) => t?.type === 'function' && t.function?.name)
                .map((t) => ({
                    type: 'function',
                    name: String(t.function.name),
                    description: String(t.function.description || ''),
                    parameters: t.function.parameters || { type: 'object', properties: {} },
                }))
            : null;
        const result = await requestChatJson(endpoint, {
            model: String(model || '').trim() || 'gpt-4.1-mini',
            ...(payload.instructions ? { instructions: payload.instructions } : {}),
            input: payload.input,
            ...(tools ? { tools } : {}),
            ...(opts.temperature !== undefined && { temperature: opts.temperature }),
            ...(Number.isFinite(opts.maxTokens) && { max_output_tokens: Math.max(1, Math.floor(opts.maxTokens)) }),
            // Responses 格式只有 reasoning.effort，没有"关闭"这个取值，
            // 所以关思考时这里不发字段（buildThinkingParams 里说明了原因）。
            ...buildThinkingParams(opts.thinking, opts.thinkingEffort, 'openai-responses', settings)
        }, { Authorization: 'Bearer ' + apiKey }, {
            signal: opts.signal, onDelta: opts.onDelta, stream: opts.stream,
        }, 'openai-responses');
        if (!result.ok) await throwProviderResponseError(result, 'OpenAI 请求失败');
        if (!result.payload) throw new ClientApiError('UPSTREAM_UNAVAILABLE', 'OpenAI 返回格式异常');
        // 部分兼容实现会把全文直接放在顶层 output_text，先认这个，省得再遍历一遍
        if (typeof result.payload.output_text === 'string' && result.payload.output_text.trim()) {
            return normalizeChatReply(result.payload.output_text, '', toResponsesToolCalls([]));
        }
        const items = Array.isArray(result.payload.output) ? result.payload.output : [];
        const text = items
            .filter((item) => item?.type === 'message')
            .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
            .filter((block) => block?.type === 'output_text')
            .map((block) => block.text || '')
            .join('');
        const reasoning = items
            .filter((item) => item?.type === 'reasoning')
            .flatMap((item) => (Array.isArray(item.summary) ? item.summary : []))
            .map((part) => part?.text || '')
            .join('');
        // 工具调用：Responses 形态是 output 里的 function_call 项（call_id + arguments 字符串）
        const toolCalls = toResponsesToolCalls(items);
        reportReplyInfo(opts, {
            reasoning,
            toolCalls,
            finishReason: String(result.payload.status || ''),
            toolsSkipped: Boolean(opts.tools?.length) && !tools,
        });
        return normalizeChatReply(text, reasoning, toolCalls);
    }

    // ========================================================================
    //  分发：格式 → 实现
    // ========================================================================
    /*  用**表**而不是 if 链。
     *  差别不在"好看"，而在"加新格式时的漏改风险"：
     *    if 链要改两处（加分支 + 记得加顺序），表只要加一行；
     *    而且表能直接 for...in 枚举出来，测试可以断言"每个已知格式都有实现"。 */
    const PROVIDERS = Object.freeze({
        'openai-compatible': callOpenAICompatibleChat,
        'anthropic': callAnthropicChat,
        'openai-responses': callOpenAIResponsesChat,
    });

    /** 默认格式：未知格式回落到它（与原 if 链最后那个 return 的行为一致） */
    const DEFAULT_FORMAT = 'openai-compatible';

    window.ChatProviders = {
        PROVIDERS,
        /** 取指定格式的实现；未知格式回落到默认（不抛错，与原行为一致） */
        forFormat(format) {
            return PROVIDERS[format] || PROVIDERS[DEFAULT_FORMAT];
        },
        /** 供测试用：列出所有已知格式 */
        formats() {
            return Object.keys(PROVIDERS);
        },
        // 单独导出，方便测试直接调某一个而不经过分发
        callOpenAICompatibleChat,
        callAnthropicChat,
        callOpenAIResponsesChat,
        // 转换器也导出：它们是最容易写错、也最值得单独测的部分
        convertOpenAIToAnthropicMessages,
        convertOpenAIToResponsesInput,
        // 工具通道的判据与映射也导出：它们决定"走工具还是走标签"，
        // 单独测比隔着一次完整请求测要可靠（不必造网关）
        rejectedRequestParam,
        toToolCall,
        openAiToolCalls,
        anthropicToolCalls,
        toResponsesToolCalls,
        toolsAllowedFor,
    };
})();
