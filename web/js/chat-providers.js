// 对话 API 格式适配器：openai-compatible / anthropic / openai-responses 三套协议实现。
// 普通 <script> 作用域独立，依赖统一从 window.ChatDeps 取（调用时才取，见 deps()）。

(function () {
    'use strict';

    // 从 400 响应判断被拒的参数（error.param 或报错文本）：剥掉它重试好过整个请求失败；
    // 认不出元凶必须原样抛错，剥别的字段只会白打请求。
    function rejectedRequestParam(result) {
        if (!result || result.status !== 400) return null;
        const KNOWN = new Set(['thinking', 'reasoning_effort', 'tools', 'temperature', 'top_p']);
        const payloads = [result.payload, result.payload?.detail];
        for (const p of payloads) {
            const param = p?.error?.param;
            if (typeof param === 'string' && KNOWN.has(param.trim())) return param.trim();
        }
        const text = [
            result.payload?.error?.message,
            result.payload?.detail?.error?.message,
            result.payload?.detail?.message,
            result.payload?.message,
            typeof result.payload?.detail === 'string' ? result.payload.detail : '',
            result.rawText,
        ].filter(Boolean).join(' ');
        if (/reasoning_effort/i.test(text) && /(not|un)supported|invalid|unknown|must be/i.test(text)) return 'reasoning_effort';
        if (/"?thinking"? is (not supported|unknown)|unsupported_parameter.*thinking|unknown parameter: ?"?thinking/i.test(text)) return 'thinking';
        if (/both ['"]?thinking['"]? and ['"]?reasoning_effort/i.test(text)) return 'thinking';
        if (/\btools\b/i.test(text) && /(unrecognized|unsupported|unknown|not permitted|not supported|invalid|extra inputs)/i.test(text)) return 'tools';
        const samplingHit = text.match(/\b(temperature|top_p)\b/i);
        if (samplingHit && /(unrecognized|unsupported|unknown|not supported|unexpected|invalid|extra inputs)/i.test(text)) {
            return samplingHit[1].toLowerCase();
        }
        return null;
    }

    // 记住该「地址 + 模型」认不认 tools：只存内存不写设置，避免一次偶发失败把用户永久降级。
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

    // 工具调用收成统一形状：OpenAI arguments 是字符串、Anthropic input 是对象；
    // 参数不合法标 badArgs 不抛，交上层回灌让模型重试。
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

    function reportReplyInfo(opts, info) {
        if (opts && opts.replyInfo) Object.assign(opts.replyInfo, info);
    }

    // 每次调用都取依赖：顶层缓存会在 ChatDeps 后挂上时静默拿到 undefined。
    function deps() {
        const d = window.ChatDeps;
        if (!d) {
            throw new Error('ChatDeps 未初始化（chat-providers.js 与主脚本的加载顺序不对）');
        }
        return d;
    }

    // 老 DeepSeek 模型名映射到当前名字；用户已填新名字（含 pro）一个字都不动。
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
        const rawModel = String(model || 'deepseek-chat').trim();
        const requestModel = isDeepSeekOfficial(baseUrl)
            ? legacyDeepSeekModel(rawModel, opts.thinking === true)
            : rawModel;
        // 显式发 disabled 很重要：DeepSeek 默认开启思考。
        const thinkingFields = buildThinkingParams(opts.thinking, opts.thinkingEffort, 'openai-compatible', settings);
        // tools 单独一个容器：被网关拒时能单独剥掉，不牺牲思考参数。
        let toolFields = (opts.tools?.length && toolsAllowedFor(baseUrl, requestModel))
            ? { tools: opts.tools }
            : {};
        // 采样参数同样单独一个容器：被点名时只剥那一个，用户开的另一项照发。
        const samplingFields = {
            ...(opts.temperature !== undefined && { temperature: opts.temperature }),
            ...(opts.topP !== undefined && { top_p: opts.topP }),
        };
        const buildBody = (thinking, tools) => ({
            model: requestModel,
            messages,
            ...samplingFields,
            ...(Number.isFinite(opts.maxTokens) && { max_tokens: Math.max(1, Math.floor(opts.maxTokens)) }),
            ...tools,
            ...thinking,
        });
        let result = await requestChatJson(endpoint, buildBody(thinkingFields, toolFields),
            { Authorization: 'Bearer ' + apiKey }, {
                signal: opts.signal, onDelta: opts.onDelta, stream: opts.stream, format: 'openai-compatible',
            });

        // 严格网关兼容：400 点名某参数 → 剥掉它重试（没有全网通用的字段）。
        // 同一 baseUrl 只撞一次，之后直接跳过被拒字段。
        const rejectedParams = new Set();   // 本次调用里已被该网关拒绝的参数名
        for (let attempt = 0; attempt < 3 && !result.ok && result.status === 400; attempt++) {
            const param = rejectedRequestParam(result);
            if (!param || !rejectedParams.add(param)) break;   // 认不出元凶 / 已经剥过了
            console.warn(`[Provider] gateway rejected "${param}" - retrying without it`
                + ` (base=${baseUrl})`);
            if (param === 'tools') {
                // 该网关不认 tools：剥掉重发，并记住本次运行内该地址不再发它。
                noteToolsRejected(baseUrl, requestModel);
                toolFields = {};
            } else if (param in samplingFields) {
                delete samplingFields[param];
            } else {
                delete thinkingFields[param];
                // thinking 与 reasoning_effort 常被一起拒，点名 thinking 时一并剥掉，省一次往返。
                if (param === 'thinking' && 'reasoning_effort' in thinkingFields) delete thinkingFields.reasoning_effort;
            }
            result = await requestChatJson(endpoint, buildBody(thinkingFields, toolFields),
                { Authorization: 'Bearer ' + apiKey }, {
                    signal: opts.signal, onDelta: opts.onDelta, stream: opts.stream, format: 'openai-compatible',
                });
        }
        if (!result.ok) await throwProviderResponseError(result, '对话服务请求失败');
        if (!result.payload) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '对话服务返回格式异常');
        const message = result.payload.choices?.[0]?.message || {};
        const toolCalls = openAiToolCalls(message);
        const reasoningText = String(message.reasoning_content || message.reasoning || '');
        reportReplyInfo(opts, {
            toolCalls,
            finishReason: String(result.payload.choices?.[0]?.finish_reason || ''),
            toolsSkipped: Boolean(opts.tools?.length) && !toolFields.tools,
            // 思考交给兜底通道：流式时已由 onDelta 送进时间线，调用方只在没收到时用它。
            reasoning: reasoningText,
        });
        return normalizeChatReply(message.content, reasoningText, toolCalls);
    }

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

    // OpenAI messages → Anthropic：tool_calls 换成 tool_use block，role:'tool' 换成 user 的 tool_result。
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
                // tool_result 必须是 user 角色，且 tool_use_id 要与调用对上，否则多步链路断掉。
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
                    try { input = JSON.parse(call.function.arguments || '{}'); } catch { input = {}; }
                    blocks.push({ type: 'tool_use', id: String(call.id || ''), name: String(call.function.name), input });
                }
                if (!blocks.length) blocks.push({ type: 'text', text: ' ' });
                converted.push({ role: 'assistant', content: blocks });
            }
        }
        // 相邻同角色合并：Anthropic 不接受连续的 user 或 assistant。
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
        const maxTokens = Number.isFinite(opts.maxTokens)
            ? Math.max(1, Math.floor(opts.maxTokens))
            : ANTHROPIC_MIN_MAX_TOKENS;
        // 工具声明换成 Anthropic 扁平形状（input_schema）；发错形状直接 400，工具通道静默失效。
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
            // 开思考时不能带采样参数：Anthropic 只允许 temperature=1 且不能设 top_p，带了直接 400。
            ...(opts.temperature !== undefined && !opts.thinking && { temperature: opts.temperature }),
            ...(opts.topP !== undefined && !opts.thinking && { top_p: opts.topP }),
            // Anthropic 侧走 reasoning.effort（none = 关闭）；不用 thinking 字段（extended thinking 的 {type,budget} 结构）。
            ...buildThinkingParams(opts.thinking, opts.thinkingEffort, 'anthropic', settings)
        }, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, {
            signal: opts.signal, onDelta: opts.onDelta, stream: opts.stream, format: 'anthropic',
        });
        if (!result.ok) await throwProviderResponseError(result, 'Anthropic 请求失败');
        if (!result.payload) throw new ClientApiError('UPSTREAM_UNAVAILABLE', 'Anthropic 返回格式异常');
        const blocks = Array.isArray(result.payload.content) ? result.payload.content : [];
        const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text || '').join('');
        const reasoning = blocks.filter((block) => block?.type === 'thinking').map((block) => block.thinking || '').join('');
        const toolCalls = anthropicToolCalls(blocks);
        reportReplyInfo(opts, {
            reasoning,
            toolCalls,
            finishReason: String(result.payload.stop_reason || ''),
            toolsSkipped: Boolean(opts.tools?.length) && !tools,
        });
        return normalizeChatReply(text, reasoning, toolCalls);
    }

    // OpenAI Responses（/v1/responses）：instructions / input 数组 / max_output_tokens / output[]，与 chat/completions 不同。

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
            // 工具结果是 input 里的 function_call_output，call_id 要与调用对上。
            if (role === 'tool') {
                input.push({
                    type: 'function_call_output',
                    call_id: String(msg.tool_call_id || msg.toolCallId || ''),
                    output: String(msg.content ?? ''),
                });
                continue;
            }
            const isAssistant = role === 'assistant';
            if (isAssistant && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
                for (const call of msg.tool_calls) {
                    if (!call?.function?.name) continue;
                    input.push({
                        type: 'function_call',
                        call_id: String(call.id || ''),
                        name: String(call.function.name),
                        // 参数按原样字符串回填，重新序列化会改变形状。
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
            ...(opts.topP !== undefined && { top_p: opts.topP }),
            ...(Number.isFinite(opts.maxTokens) && { max_output_tokens: Math.max(1, Math.floor(opts.maxTokens)) }),
            // Responses 只有 reasoning.effort，没有"关闭"取值，关思考时不发字段。
            ...buildThinkingParams(opts.thinking, opts.thinkingEffort, 'openai-responses', settings)
        }, { Authorization: 'Bearer ' + apiKey }, {
            signal: opts.signal, onDelta: opts.onDelta, stream: opts.stream, format: 'openai-responses',
        });
        if (!result.ok) await throwProviderResponseError(result, 'OpenAI 请求失败');
        if (!result.payload) throw new ClientApiError('UPSTREAM_UNAVAILABLE', 'OpenAI 返回格式异常');
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
        const toolCalls = toResponsesToolCalls(items);
        reportReplyInfo(opts, {
            reasoning,
            toolCalls,
            finishReason: String(result.payload.status || ''),
            toolsSkipped: Boolean(opts.tools?.length) && !tools,
        });
        return normalizeChatReply(text, reasoning, toolCalls);
    }

    // 用表而不是 if 链：新增格式只加一行，且可枚举断言每个已知格式都有实现。
    const PROVIDERS = Object.freeze({
        'openai-compatible': callOpenAICompatibleChat,
        'anthropic': callAnthropicChat,
        'openai-responses': callOpenAIResponsesChat,
    });

    const DEFAULT_FORMAT = 'openai-compatible';

    window.ChatProviders = {
        PROVIDERS,
        forFormat(format) {
            return PROVIDERS[format] || PROVIDERS[DEFAULT_FORMAT];
        },
        formats() {
            return Object.keys(PROVIDERS);
        },
        callOpenAICompatibleChat,
        callAnthropicChat,
        callOpenAIResponsesChat,
        convertOpenAIToAnthropicMessages,
        convertOpenAIToResponsesInput,
        rejectedRequestParam,
        toToolCall,
        openAiToolCalls,
        anthropicToolCalls,
        toResponsesToolCalls,
        toolsAllowedFor,
    };
})();
