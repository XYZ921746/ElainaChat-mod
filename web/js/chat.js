// 对话调用：callAI / 第三人称两段式 / 回复标签 / 视觉转述 / 语音拆分 / 日语翻译。
'use strict';

// 采样参数只放用户真的填了的项（留空 = 交给服务商默认）；脏值在 normalizeSamplingInput 里当作没填。
function chatSamplingOpts() {
    const opts = {};
    for (const field of CHAT_SAMPLING_FIELDS) {
        const value = normalizeSamplingInput(state.settings[field.setting], field);
        if (value !== '') opts[field.optsKey] = value;
    }
    return opts;
}

// 一次对话请求的硬性死线（分钟级）：定时器在这个环境里是可靠的，而 AbortSignal 在 APK 的原生 HTTP 通道上
// 打不断一个已经挂住的 promise（实测一次续跑调用挂住八分钟，浮层停在「正在思考」，什么都没发生）。
// 到点就按超时失败，让上层如实报错并重试 —— 无限等待比报错糟得多。
const CHAT_CALL_HARD_DEADLINE_MS = 8 * 60 * 1000;

function withChatDeadline(promise, ms) {
    let timer = null;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error('对话请求超过 ' + Math.round(ms / 60000) + ' 分钟没有返回，已停止等待。');
            err.code = 'REQUEST_TIMEOUT_HARD';
            reject(err);
        }, ms);
    });
    return Promise.race([promise, guard]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function callAI(text, options = {}, settings = null) {
    // callAI 是对话的唯一出口：调用方没点名 settings（即非回退链）时优先用「当前会话设定」里给这段对话指定的模型；
    //   没绑或对失效则保持 null 落到默认模型。记忆摘要 / 翻译走 callChatAPI，不经过这里，继续跟随默认。
    if (!settings) {
        const convSettings = conversationChatSettings(getCurrentConversation());
        if (convSettings) settings = convSettings;
    }
    const hasImage = isSafeComposerImageDataUrl(options.imageDataUrl);
    // 生效判据 = 开关打开且选中的对话模型能解析出地址与模型名；只判填没填会让开关成摆设。
    const visionCfg = resolveVisionConfig();
    const hasVision = state.settings.visionEnabled === true && Boolean(visionCfg.baseUrl && visionCfg.model);
    if (hasImage && hasVision && !options.directImage) {
        try {
            const visionReply = await describeImageWithVision(text, options.imageDataUrl);
            if (visionReply && visionReply.trim()) {
                options = { ...options, imageDataUrl: '', visionContext: visionReply.trim() };
                text = (String(text || '').trim() ? String(text).trim() + '\n' : '')
                    + `（图片已由多模态模型看过，以下是它对该图片与用户消息的回应参考：${visionReply.trim()}。请你以角色身份自然地接续这段内容，用自己的口吻回应；不要复述这段参考，也不要提及“多模态模型”或“参考”。）`;
            }
        } catch (err) {
            const visionErr = String(err?.message || err || '');
            console.error('[Vision] 视觉模型转述失败:', { error: visionErr, baseUrl: visionCfg.baseUrl, model: visionCfg.model });
            if (/not a multimodal|not multimodal|does not support (image|vision)|vision.*not supported|multimodal model/i.test(visionErr)) {
                showCustomAlert(
                    '视觉模型不支持图片（服务商提示：' + visionErr.slice(0, 160) + '）。\n\n请在 设置 → 模型 → 对话模型 → 图片转述 里换一个支持图片的多模态模型（如 Qwen-VL、GLM-4V、GPT-4o）。当前模型名：' + visionCfg.model,
                    '视觉模型配置错误'
                );
            } else if (/quota|exhausted|insufficient|funds|balance|free tier|credit|payment/i.test(visionErr)) {
                showCustomAlert(
                    '服务商提示：' + visionErr.slice(0, 220) +
                    '\n\n这是账号额度问题，不是应用问题：\n· 免费额度已用完 → 请在服务商控制台充值；\n· 或关闭"仅使用免费档"（use free tier only）模式；\n· 或换一个还有额度的模型（点「🔄 获取模型」查看）。',
                    '服务商额度不足'
                );
            } else {
                showCustomAlert(
                    '图片转述失败：' + visionErr +
                    '\n\n请检查 设置 → 模型 → 对话模型 → 图片转述 里选的模型，以及它所属提供商在「对话模型」里的 API 地址 / Key。\n（本次未把图片转发给主模型，避免出现误导性报错）',
                    '图片转述失败'
                );
            }
            throw new ClientApiError('VISION_FAILED', '图片转述失败：' + visionErr);
        }
    } else if (hasImage && !hasVision && !options.directImage) {
        if (!state._visionHintShown) {
            state._visionHintShown = true;
            showCustomAlert(
                '未配置视觉模型，图片将直接发送给当前模型（若当前模型不支持图片会报错）。\n建议在 设置 → 模型 → 对话模型 → 图片转述 里从「对话模型」已勾选的模型里选一个多模态模型（如 Qwen-VL / Qwen2.5-VL），图片会自动转述成文字后再回答。',
                '图片模式提示'
            );
        }
    }
    // 先探测这台电脑的真实位置再拼提示词（它决定 AI 知不知道桌面在哪）；整段包 try/catch，探测失败不能让对话发不出去。
    try { await detectAgentRoots(); } catch { /* 忽略 */ }
    // 记忆向量召回要先发一次嵌入请求，异步放在拼提示词之前；失败时缓存为空，记忆段自动退回关键词。
    if (typeof prefetchMemoryVectorRecall === 'function') {
        try { await prefetchMemoryVectorRecall(text); } catch { /* 召回失败不影响回复 */ }
    }
    if (state.settings.thirdPerson) {
        try {
            return await generateThirdPersonReply(text, options, settings);
        } catch (err) {
            if (hasImage && err instanceof ClientApiError) err.imageHint = true;
            throw err;
        }
    }
    const messages = ROLEPLAY_PROMPT_STRUCTURE_MODE === 'legacy-v1'
        ? buildLegacyRoleplayMessages(text, options)
        : buildLayeredRoleplayMessages(text, options);
    let reply;
    try {
        reply = await withChatDeadline(callChatAPI(messages, {
            thinking: Boolean(state.settings.thinkingMode),
            thinkingEffort: state.settings.thinkingEffort || 'off',
            ...chatSamplingOpts(),
            // 调用方显式给过预算就用调用方的（agent 续跑通道需要比闲聊大得多的上限，见 agent-continue.js）；闲聊仍按角色扮演上限裁剪。
            maxTokens: options.maxTokens
                || (options.includeVoiceJp
                    ? ROLEPLAY_OUTPUT_TOKEN_LIMITS.withVoice
                    : ROLEPLAY_OUTPUT_TOKEN_LIMITS.text),
            signal: options.signal,
            onDelta: options.onDelta || null,
            onPhase: options.onPhase || null,
            tools: options.tools || null,
            replyInfo: options.replyInfo || null
        }, settings || undefined),
        Number.isFinite(options.deadlineMs) ? options.deadlineMs : CHAT_CALL_HARD_DEADLINE_MS);
    } catch (err) {
        const visionUnsupported = /not a multimodal|not multimodal|does not support (image|vision)|vision.*not supported|multimodal model|image.*not supported|不支持.{0,4}图片|无法.{0,4}图片/i
            .test(String((err && err.message) || err));
        if (hasImage && options.directImage && !options.imageRetried && visionUnsupported) {
            console.warn('[Agent] 主模型不支持图片，改用文字继续：', (err && err.message) || err);
            state._agentImageUnsupported = true;
            try {
                if (typeof rememberModelImageVerdict === 'function') {
                    const eff = settings || activeChatSettings();
                    rememberModelImageVerdict(false, eff.baseUrl, eff.model);
                }
            } catch (e) { /* 缓存失败不该挡住回退 */ }
            if (!state._agentImageUnsupportedShown) {
                state._agentImageUnsupportedShown = true;
                showCustomAlert('当前主模型不支持图片，所以这次"看屏幕"只能读到文字（控件清单）。\n\n'
                    + '想真正让它看图：把「设置 → 模型」里的对话模型换成多模态模型'
                    + '（如 Qwen-VL / GLM-4V / GPT-4o），或在「视觉模型」里配一个。', '主模型不支持图片');
            }
            return callAI(text, Object.assign({}, options, { imageDataUrl: '', directImage: false, imageRetried: true }));
        }
        // 只有思考没有正文：网关强制开思考、且不允许关（thinking 字段被 400 拒掉）时，思考会在正文开始前
        // 就把闲聊的输出上限耗尽。这不是「供应商挂了」，是预算不够 —— 用更大的上限重试一次即可；
        // 只对这一个错误码重试，其它失败照旧原样抛（真正失败的请求重试只是白付一次）。
        if (err instanceof ClientApiError && err.code === 'EMPTY_MODEL_OUTPUT'
            && !options.maxTokens && options._emptyOutputRetried !== true) {
            console.warn('[Chat] 模型只返回思考内容，用更大输出预算重试一次');
            return callAI(text, Object.assign({}, options, {
                maxTokens: EMPTY_OUTPUT_RETRY_TOKEN_LIMIT,
                _emptyOutputRetried: true,
            }), settings);
        }
        if (hasImage && err instanceof ClientApiError) err.imageHint = true;
        throw err;
    }
    if (hasImage && options.directImage) {
        try {
            if (typeof rememberModelImageVerdict === 'function') {
                const eff = settings || activeChatSettings();
                rememberModelImageVerdict(true, eff.baseUrl, eff.model);
            }
        } catch (e) { /* 缓存失败不该影响回复 */ }
    }
    return reply;
}

/**
 * 子代理专用的模型调用：与 callAI 共享供应商管线（采样 / 预算 / 死线 / 工具回填），
 * 但**不经过角色提示词构建** —— 消息由 agent-session 自行组装（简报 + 会话历史），
 * 这是"操作上下文与角色上下文分离"的落点。图片不支持的降级与空输出重试同 callAI。
 */
async function callAgentSessionAI(messages, options = {}, settings = null) {
    const convSettings = conversationChatSettings(getCurrentConversation());
    let reply;
    try {
        reply = await withChatDeadline(callChatAPI(messages, {
            thinking: Boolean(state.settings.thinkingMode),
            thinkingEffort: state.settings.thinkingEffort || 'off',
            ...chatSamplingOpts(),
            maxTokens: options.maxTokens || AGENT_CONTINUE_OUTPUT_TOKEN_LIMIT,
            signal: options.signal,
            tools: options.tools || null,
            replyInfo: options.replyInfo || null
        }, (settings || convSettings) || undefined),
        Number.isFinite(options.deadlineMs) ? options.deadlineMs : AGENT_CONTINUE_CALL_DEADLINE_MS);
    } catch (err) {
        const visionUnsupported = /not a multimodal|not multimodal|does not support (image|vision)|vision.*not supported|multimodal model|image.*not supported|不支持.{0,4}图片|无法.{0,4}图片/i
            .test(String((err && err.message) || err));
        if (options.imageDataUrl && options.directImage && !options.imageRetried && visionUnsupported) {
            state._agentImageUnsupported = true;
            try {
                if (typeof rememberModelImageVerdict === 'function') {
                    const eff = settings || convSettings || activeChatSettings();
                    rememberModelImageVerdict(false, eff.baseUrl, eff.model);
                }
            } catch (e) { /* 缓存失败不该挡住回退 */ }
            return callAgentSessionAI(messages, Object.assign({}, options, {
                imageDataUrl: '', directImage: false, imageRetried: true,
            }), settings);
        }
        if (err instanceof ClientApiError && err.code === 'EMPTY_MODEL_OUTPUT'
            && !options.maxTokens && options._emptyOutputRetried !== true) {
            return callAgentSessionAI(messages, Object.assign({}, options, {
                maxTokens: EMPTY_OUTPUT_RETRY_TOKEN_LIMIT,
                _emptyOutputRetried: true,
            }), settings);
        }
        throw err;
    }
    if (options.imageDataUrl && options.directImage) {
        try {
            if (typeof rememberModelImageVerdict === 'function') {
                const eff = settings || convSettings || activeChatSettings();
                rememberModelImageVerdict(true, eff.baseUrl, eff.model);
            }
        } catch (e) { /* 缓存失败不该影响回复 */ }
    }
    return reply;
}

// 两段式收在 callAI 内部（它是唯一对话出口）；第一段隐藏、失败原样抛，第二段失败回退第一段，标签从第一段追加到第二段。
async function generateThirdPersonReply(text, options = {}, settings = null) {
    const gmOptions = { ...options, thirdPerson: true, onDelta: null };
    const gmMessages = ROLEPLAY_PROMPT_STRUCTURE_MODE === 'legacy-v1'
        ? buildLegacyRoleplayMessages(text, gmOptions)
        : buildLayeredRoleplayMessages(text, gmOptions);
    const maxTokens = options.includeVoiceJp
        ? ROLEPLAY_OUTPUT_TOKEN_LIMITS.withVoice
        : ROLEPLAY_OUTPUT_TOKEN_LIMITS.text;
    const pass1OnDelta = typeof options.onDelta === 'function'
        ? (chunk) => {
            if (chunk && chunk.kind === 'reasoning') options.onDelta({ ...chunk, phase: 1 });
        }
        : null;
    const pass1 = await callChatAPI(gmMessages, {
        thinking: Boolean(state.settings.thinkingMode),
        thinkingEffort: state.settings.thinkingEffort || 'off',
        ...chatSamplingOpts(),
        maxTokens,
        signal: options.signal,
        onDelta: pass1OnDelta,
        // 工具通道必须透传给第一段：「要不要动手」的决策发生在这里，丢掉它整条工具链失效（第二段只负责改写）。
            tools: options.tools || null,
            replyInfo: options.replyInfo || null,
        }, settings || undefined);
    const pass1Text = String(pass1 || '').trim();
    const pass1ToolCalls = (options.replyInfo && Array.isArray(options.replyInfo.toolCalls))
        ? options.replyInfo.toolCalls : [];
    if (typeof options.onPhase === 'function') {
        options.onPhase({
            index: 1,
            title: '第 1 阶段 · 第三人称叙述（不展示给用户）',
            text: pass1Text || (pass1ToolCalls.length ? '（本轮第一段直接发起了工具调用，没有产出叙述。）' : ''),
            state: (pass1Text || pass1ToolCalls.length) ? 'ok' : 'error',
        });
    }
    if (!pass1Text && pass1ToolCalls.length) return pass1Text;
    if (!pass1Text) return pass1Text;
    try {
        // 日语朗读稿指令必须在第二段再声明一次，否则 voiceJp 永远为空（只能再发一次翻译请求）。
        const pass2Messages = [
            { role: 'system', content: FIRST_PERSON_CONVERT_PROMPT }
        ];
        if (options.includeVoiceJp) {
            pass2Messages.push({
                role: 'system',
                content: `# 内部配音输出格式（不要展示给用户）
在完成第一人称改写后，于同一条输出末尾追加日语朗读稿，并严格包裹在 <voice_jp> 与 </voice_jp> 标签中。只翻译正文中的对白，不翻译括号、方括号或动作描写。该标签是客户端内部字段，客户端会自动删除，禁止解释它。没有可朗读对白时输出空的 <voice_jp></voice_jp>。`
            });
        }
        pass2Messages.push({ role: 'user', content: pass1Text });
        // 第二段产物就是用户看到的正文，必须透传 onDelta；callAI 里两段式是提前 return，漏传就只剩三点气泡干等。
        const pass2 = await callChatAPI(pass2Messages, {
            thinking: Boolean(state.settings.thinkingMode),
            thinkingEffort: state.settings.thinkingEffort || 'off',
            ...chatSamplingOpts(),
            maxTokens,
            signal: options.signal,
            onDelta: typeof options.onDelta === 'function'
                ? (chunk) => options.onDelta({ ...chunk, phase: 2 })
                : null
        }, settings || undefined);
        const pass2Text = String(pass2 || '').trim();
        if (!pass2Text) {
            if (typeof options.onPhase === 'function') {
                options.onPhase({
                    index: 2,
                    title: '第 2 阶段 · 第一人称正文',
                    text: '',
                    state: 'error',
                });
            }
            return pass1Text;
        }
        if (typeof options.onPhase === 'function') {
            options.onPhase({
                index: 2,
                title: '第 2 阶段 · 第一人称正文（用户看到的就是这段）',
                text: pass2Text,
                state: 'ok',
            });
        }
        const tags = extractReplyTags(pass1Text);
        return tags ? `${pass2Text}\n${tags}` : pass2Text;
    } catch (err) {
        console.warn('[ThirdPerson] 第一人称转换失败，回退到 GM 文本:', err);
        if (typeof options.onPhase === 'function') {
            options.onPhase({
                index: 2,
                title: '第 2 阶段 · 第一人称正文（失败，已回退到第 1 段）',
                text: String(err?.message || err),
                state: 'error',
            });
        }
        return pass1Text;
    }
}

// 抽出应用真正认识的标签，用于补回第二段正文末尾。
// 必须按标签名白名单取：裸的方括号会把 markdown 链接、数组下标一起吃进去，而 strip 只认已知标签名。
function extractReplyTags(text) {
    const t = String(text == null ? '' : text);
    const names = (window.ElainaTags && Array.isArray(window.ElainaTags.TAG_NAMES))
        ? window.ElainaTags.TAG_NAMES
        : ['表情', '动作', '情绪', '位置', '大小', '背景', '操作', '任务'];
    const tokens = [];
    for (const name of names) {
        // 标签名后必须紧跟冒号，避免把 [操作记录] 这类正文吃掉。
        for (const tag of (t.match(new RegExp('\\[' + name + '[:：][^\\]\\n]*\\]', 'g')) || [])) {
            tokens.push(tag);
        }
    }
    for (const tag of (t.match(/<scene>[^<\n]*<\/scene>/gi) || [])) tokens.push(tag);
    return tokens.join(' ');
}

// 用视觉模型直接处理图片 + 用户消息，主模型再基于此结合角色卡修正。
async function describeImageWithVision(prompt, imageDataUrl) {
    const cfg = resolveVisionConfig();
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const endpoint = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
    const messages = [
        {
            role: 'system',
            content: '你是图片理解助手。请仔细观察图片，并结合用户的消息直接作出回应：先简要说说你看到的画面（人物/场景/动作/表情/文字等），再针对用户的话给出回应。只描述图中可见内容，不要编造。'
        },
        {
            role: 'user',
            content: [
                { type: 'text', text: String(prompt || '').trim() || '看看这张图，跟我说说' },
                { type: 'image_url', image_url: { url: imageDataUrl } }
            ]
        }
    ];
    // 画面转述的超时要比普通请求宽松：网关强制开思考时，模型要先想再答，看图尤其慢；
// 用默认的 120 秒实测会稳定撞「Direct provider request failed: timeout」，这一格整个白截。
const VISION_DESCRIBE_TIMEOUT_MS = 200000;
    const result = await postJsonFromDevice(endpoint, {
        model: cfg.model,
        messages,
        // 画面转述要列元素与建议坐标，512 在「网关强制开思考」的模型上会先被思考吃光、正文被截成半句
        // （实测只剩「1) 这是什么应用、什么页面」）。2048 是上限不是定额，短回答不会因此变长。
        max_tokens: 2048
    }, { Authorization: 'Bearer ' + (cfg.apiKey || 'sk-no-key') }, { timeoutMs: VISION_DESCRIBE_TIMEOUT_MS });
    if (!result.ok) await throwProviderResponseError(result, '视觉模型请求失败');
    const text = result.payload?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text : '';
}

function splitVoiceReply(rawText) {
    const source = String(rawText || '');
    const match = source.match(/<voice_jp>\s*([\s\S]*?)\s*<\/voice_jp>/i);
    if (!match) return { displayText: source.trim(), voiceJp: '' };
    const voiceJp = String(match[1] || '').trim();
    return {
        displayText: source.replace(match[0], '').trim() || source.trim(),
        voiceJp: /[\u3040-\u30ff]/.test(voiceJp) ? voiceJp : ''
    };
}

async function translateToJapanese(text) {
    const system = '你是一个专业的配音文本翻译器。请将用户输入的中文对话内容翻译成自然、口语化的简体日语（假名与汉字混排），使其适合语音合成朗读。\n要求：\n- 只输出日语翻译结果本身，不要任何解释、引号、标注或前缀\n- 内容必须与原文一致，逐句对应翻译，不要改写或补充\n- 保留口语语气词（ふふ、ね、よ、な等）的自然表达';
    const messages = [
        { role: 'system', content: system },
        { role: 'user', content: text }
    ];
    return callChatAPI(messages);
}
