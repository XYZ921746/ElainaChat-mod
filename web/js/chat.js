/* ============================================================================
 * 对话调用（从 data.js 拆分）
 *
 * callAI / 第三人称两段式 / 回复标签 / 视觉转述 / 语音拆分 / 日语翻译。
 * 依赖 roleplay.js 的消息构建与各 provider 请求层（运行时才调用）。
 * ========================================================================== */
'use strict';

async function callAI(text, options = {}) {
    // 方案 A：图片 → 视觉模型转述 → 文本给 DeepSeek
    const hasImage = isSafeComposerImageDataUrl(options.imageDataUrl);
    // 生效判据 = **开关打开** 且 地址与模型名都填了。
    //   只判"填没填"的话，用户关掉开关后图片仍会被送去做转述 —— 那个开关就成了摆设。
    //   两个同时成立才走转述，否则图片直接交给主模型（多模态时这是更优路径）。
    const hasVision = state.settings.visionEnabled === true
        && Boolean(String(state.settings.visionBaseUrl || '').trim() && String(state.settings.visionModel || '').trim());
    if (hasImage && hasVision) {
        try {
            // 多模态模型直接处理图片 + 用户消息，返回其回应
            const visionReply = await describeImageWithVision(text, options.imageDataUrl);
            if (visionReply && visionReply.trim()) {
                // 把多模态模型的回应作为参考，交给主模型用角色卡修正
                options = { ...options, imageDataUrl: '', visionContext: visionReply.trim() };
                text = (String(text || '').trim() ? String(text).trim() + '\n' : '')
                    + `（图片已由多模态模型看过，以下是它对该图片与用户消息的回应参考：${visionReply.trim()}。请你以角色身份自然地接续这段内容，用自己的口吻回应；不要复述这段参考，也不要提及“多模态模型”或“参考”。）`;
            }
        } catch (err) {
            const visionErr = String(err?.message || err || '');
            console.error('[Vision] 视觉模型转述失败:', { error: visionErr, baseUrl: state.settings.visionBaseUrl, model: state.settings.visionModel });
            if (/not a multimodal|not multimodal|does not support (image|vision)|vision.*not supported|multimodal model/i.test(visionErr)) {
                showCustomAlert(
                    '视觉模型不支持图片（服务商提示：' + visionErr.slice(0, 160) + '）。\n\n请把 设置 → 模型 → 视觉模型 的「模型名」换成支持图片的多模态模型（如 Qwen-VL、GLM-4V、GPT-4o）。当前模型名：' + String(state.settings.visionModel || ''),
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
                    '\n\n请检查 设置 → 模型 → 视觉模型 的 API 地址 / Key / 模型名。\n（本次未把图片转发给主模型，避免出现误导性报错）',
                    '图片转述失败'
                );
            }
            // 明确失败，不再把图片丢给主模型（避免主模型报 "not multimodal" 之类误导错误）
            throw new ClientApiError('VISION_FAILED', '图片转述失败：' + visionErr);
        }
    } else if (hasImage && !hasVision) {
        // 未配置视觉模型：图片直接给当前模型，会话内提示一次
        if (!state._visionHintShown) {
            state._visionHintShown = true;
            showCustomAlert(
                '未配置视觉模型，图片将直接发送给当前模型（若当前模型不支持图片会报错）。\n建议在 设置 → 模型 → 视觉模型 配置 OpenAI 兼容视觉模型（如 Qwen-VL / Qwen2.5-VL），图片会自动转述成文字后再回答。',
                '图片模式提示'
            );
        }
    }
    // 先把「这台电脑的真实位置」探测好再拼提示词 —— 它决定 AI 知不知道桌面在哪。
    // 命中缓存时只是一次微任务，不会产生额外等待；探测失败会清缓存下次重试。
    // 整段包 try/catch：拿不到真实路径顶多是 AI 需要多问一次，
    // 但要是这里抛出去，整个对话就发不出去了 —— 不能让它有这种能力。
    try { await detectAgentRoots(); } catch { /* 忽略 */ }
    // 「对话优化 → 第三人称」两段式生成：开启时先让模型以 GM 视角推进剧情（不展示），
    //   再把 GM 文本转成第一人称展示给用户。关着的时候这一行不进入，
    //   下面那条原路径**逐字节不变** —— 不开功能就等于没改过这里。
    if (state.settings.thirdPerson) {
        try {
            return await generateThirdPersonReply(text, options);
        } catch (err) {
            // 只有第一段（GM）会抛到这里：补上图片提示再原样抛出。
            // 第二段（第一人称转换）失败已在内部回退，不会走到这里。
            if (hasImage && err instanceof ClientApiError) err.imageHint = true;
            throw err;
        }
    }
    const messages = ROLEPLAY_PROMPT_STRUCTURE_MODE === 'legacy-v1'
        ? buildLegacyRoleplayMessages(text, options)
        : buildLayeredRoleplayMessages(text, options);
    // 记下"这次到底有没有带图片"，供 400 报错时决定要不要提图片原因。
    // 用合并前的 hasImage：走视觉模型转述成功时 options.imageDataUrl 已被清空，
    // 但那次请求确实处理过图片，报错提示理应还能提到图片。
    try {
        return await callChatAPI(messages, {
            thinking: Boolean(state.settings.thinkingMode),
            // 思考强度：只在开思考时有意义（关着的时候 provider 会发 disabled，
            // 带上档位也无害，但不传更干净）。
            thinkingEffort: state.settings.thinkingEffort || 'off',
            maxTokens: options.includeVoiceJp
                ? ROLEPLAY_OUTPUT_TOKEN_LIMITS.withVoice
                : ROLEPLAY_OUTPUT_TOKEN_LIMITS.text,
            // 「停止」按钮的中断器 —— 穿过 callChatAPI 进到 postJsonFromDevice
            signal: options.signal,
            // 流式：每收到一段增量就回调一次，由调用方（voice.js）
            // 负责把它增量渲染进气泡。传 null 表示调用方不需要增量（例如
            // 后台的记忆整理、定时任务），那就照旧等完整结果。
            onDelta: options.onDelta || null,
            // 阶段输出回调：只有两段式（第三人称）会真的调用它。
            // 单段路径也传下去，是为了让调用方**不必**分支判断 ——
            // 两段式是在 callAI 内部提前 return 的，调用方看不到这个区别。
            onPhase: options.onPhase || null,
            // 工具通道（function calling）：工具清单与"回复侧元信息"的容器都由调用方给 ——
            //   哪些调用该带工具只有调用方知道（记忆摘要、日语翻译、连接测试都不该带），
            //   所以这里只做透传。
            tools: options.tools || null,
            replyInfo: options.replyInfo || null
        });
    } catch (err) {
        if (hasImage && err instanceof ClientApiError) err.imageHint = true;
        throw err;
    }
}

/**
 * 「对话优化 → 第三人称」两段式生成。
 *
 * 为什么放在 callAI 内部调用：callAI 是全应用唯一的对话出口（主聊天、记忆整理、
 *   定时任务都走它），把两段式收在这里，调用方（voice.js）一行都不用改 ——
 *   它拿到的仍是"最终要显示的文本"，标签剥离 / 任务抽取等后续处理照常作用其上。
 *
 *   第一段（隐藏）：沿用原有消息构建、仅额外传 thirdPerson:true，
 *     于是首个 system（角色扮演核心协议）被 GM 讲述者提示词替换，模型以第三人称
 *     推进剧情，产出【故事】/【状态】两段式文本。**不展示、不流式**（onDelta: null）。
 *     失败时原样抛出（与今天"请求失败就报错"一致）。
 *   第二段（展示）：把第一段文本交给"第一人称转换器"改写为"我"的口吻。
 *     失败或返回空 → 回退到第一段文本（用户至少能拿到回复，不报硬错）。
 *
 *   标签：应用是靠扫描**返回文本**执行 [情绪:…]/[操作:…]/<scene>…</scene> 等标签的，
 *   而第一人称阶段通常不带这些标签（转换提示词要求只输出故事文本）。
 *   所以这里把第一段里出现的标签原样**追加**到第二段结果末尾，保证表现 / 操作不丢失；
 *   只追加标签，绝不追加 【状态】 栏。
 */
async function generateThirdPersonReply(text, options = {}) {
    // 两段式生成也要把过程暴露给用户。
    //   第一段的 onDelta 若为 null，GM 那一轮的推理就**整个丢掉**：开了第三人称
    //   再也没有"思考"可看（界面上永远只有"操作完成"，没有"已思考"）。所以：
    //     · 第一段：思考增量**照收**（打 phase=1 标记进时间线），正文仍不进 UI
    //       —— 它是被第二段消费的中间产物，直接显示会与最终正文打架；
    //     · 第二段：思考与正文都照收（phase=2）。
    //   两个阶段的**完整输出**另由 onPhase 回调交给 UI 存成可单独展开的条目。
    const gmOptions = { ...options, thirdPerson: true, onDelta: null };
    // 沿用 callAI 里"同一套消息构建"（legacy 回滚模式由三元表达式兜底）。
    const gmMessages = ROLEPLAY_PROMPT_STRUCTURE_MODE === 'legacy-v1'
        ? buildLegacyRoleplayMessages(text, gmOptions)
        : buildLayeredRoleplayMessages(text, gmOptions);
    const maxTokens = options.includeVoiceJp
        ? ROLEPLAY_OUTPUT_TOKEN_LIMITS.withVoice
        : ROLEPLAY_OUTPUT_TOKEN_LIMITS.text;
    // 第一段：只把**思考**透出去（正文隐藏）。
    // 这样"开了第三人称也有思考内容"，同时不会把 GM 原文流到气泡里。
    const pass1OnDelta = typeof options.onDelta === 'function'
        ? (chunk) => {
            if (chunk && chunk.kind === 'reasoning') options.onDelta({ ...chunk, phase: 1 });
        }
        : null;
    const pass1 = await callChatAPI(gmMessages, {
        thinking: Boolean(state.settings.thinkingMode),
        thinkingEffort: state.settings.thinkingEffort || 'off',
        maxTokens,
        signal: options.signal,
        onDelta: pass1OnDelta,
        // 工具通道必须透传给**第一段**：它拿着完整对话上下文与用户意图，
        // 「要不要动手」的决策发生在这一段。这里丢掉 tools/replyInfo 的话，
        // 开着第三人称时模型从头到尾收不到工具声明 —— 工具通道整条失效，
        // 只剩正文标签兜底。第二段（第一人称改写）不传：它只负责改写
        // 第一段的产物，不该也不需要发起调用。
        tools: options.tools || null,
        replyInfo: options.replyInfo || null,
    });
    const pass1Text = String(pass1 || '').trim();
    // 第一段的工具调用数：只发起调用、一个字不说是**合法**的第一段
    // （先动手、说话靠后），阶段记录要点明这一点而不是标成失败。
    const pass1ToolCalls = (options.replyInfo && Array.isArray(options.replyInfo.toolCalls))
        ? options.replyInfo.toolCalls : [];
    // 第一段输出：即使为空也要留一条，否则用户看不到"这一步发生过"
    if (typeof options.onPhase === 'function') {
        options.onPhase({
            index: 1,
            title: '第 1 阶段 · 第三人称叙述（不展示给用户）',
            text: pass1Text || (pass1ToolCalls.length ? '（本轮第一段直接发起了工具调用，没有产出叙述。）' : ''),
            state: (pass1Text || pass1ToolCalls.length) ? 'ok' : 'error',
        });
    }
    // 只发起工具调用时不再往下走第二段（改写没有输入），直接把控制权交回
    // 调用方 —— voice.js 会从 replyInfo 里读到 toolCalls 并执行、续跑。
    if (!pass1Text && pass1ToolCalls.length) return pass1Text;
    if (!pass1Text) return pass1Text;
    // 第二段：第一段文本作为用户消息，转换提示词作为 system。失败即回退。
    try {
        // 日语朗读稿必须在**第二段**也声明一次：用户看到的正文来自第二段，
        //   第二段没有这条 <voice_jp> 指令就不会输出该标签，于是 aiMessage.voiceJp
        //   永远为空，只能退回"再单独发一次翻译请求"（多一次调用，而且对话模型
        //   一慢/超时就完全没声音）。这里把同一条指令补到第二段。
        const pass2Messages = [
            { role: 'system', content: FIRST_PERSON_CONVERT_PROMPT }
        ];
        // 第二段是**在这里手搭的最小消息数组**，不继承第一段的全局要求，
        //   所以必须自己再放一次思考语言要求 —— 漏了它两段思维链会一中一英。
        //   凡自己拼消息列表的地方都会丢掉宿主的全局要求，这是同一类疏漏。
        //   位置：放在转换提示词**之后**、user 消息之前 —— 它是"怎么想"的元规则，
        //   排在角色/任务定义之后符合本文件其它地方的惯例。
        if (state.settings.thinkingMode) {
            pass2Messages.push({ role: 'system', content: THINKING_LANGUAGE_PROMPT });
        }
        if (options.includeVoiceJp) {
            pass2Messages.push({
                role: 'system',
                content: `# 内部配音输出格式（不要展示给用户）
在完成第一人称改写后，于同一条输出末尾追加日语朗读稿，并严格包裹在 <voice_jp> 与 </voice_jp> 标签中。只翻译正文中的对白，不翻译括号、方括号或动作描写。该标签是客户端内部字段，客户端会自动删除，禁止解释它。没有可朗读对白时输出空的 <voice_jp></voice_jp>。`
            });
        }
        pass2Messages.push({ role: 'user', content: pass1Text });
        // 第二段的产物**就是用户看到的正文**（下面 return 出去的 pass2Text），
        //   所以它必须把 onDelta 透传下去，不能像第一段那样当"隐藏文本"处理。
        //   漏传的后果很隐蔽：callAI 里 `if (state.settings.thirdPerson) return await
        //   generateThirdPersonReply(...)` 是**提前 return**，于是开着第三人称时
        //   整条链路一个增量都不会回调，界面上永远只有一个"三点气泡"干等，
        //   等到两段请求都跑完才一次性蹦出全文。第一段（GM 讲述）则必须保持
        //   不进正文：它只是中间产物。
        const pass2 = await callChatAPI(pass2Messages, {
            thinking: Boolean(state.settings.thinkingMode),
            thinkingEffort: state.settings.thinkingEffort || 'off',
            maxTokens,
            signal: options.signal,
            // 用户看到的正文 → 增量照常回传（与不开第三人称时的路径一致）
            onDelta: typeof options.onDelta === 'function'
                ? (chunk) => options.onDelta({ ...chunk, phase: 2 })
                : null
        });
        const pass2Text = String(pass2 || '').trim();
        if (!pass2Text) {
            // 第二段空 → 回退到第一段。阶段 2 仍留一条（标明它没产出），
            // 否则用户会以为"第二阶段根本没跑"。
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
                // 记**不含**追加标签的原文：标签是内部协议，显示出来只是噪音
                text: pass2Text,
                state: 'ok',
            });
        }
        // 把第一段里的标签补回第二段正文末尾（标签不会展示，只被扫描执行）。
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

/**
 * 从一段文本里抽出**应用真正认识**的标签，用空格连成一串 ——
 * 用于把第一段的标签补回到第二段正文末尾（第一人称改写不带这些标签）。
 *
 * ⚠️ 必须按**标签名白名单**取，不能见到方括号就当标签。裸的 `\[[^\]]+\]` 会把
 *   普通正文一起吃进去：
 *     · markdown 链接 `[这个视频](https://…)` → 抽出 `[这个视频]`，
 *       追加到正文末尾后**没有任何东西会剥掉它**（strip 只认已知标签名），
 *       用户就会在回复结尾看到一串 `[这个视频] [1] [0]`。
 *     · 数组下标 / 引用编号 `arr[0]`、`[1]` 同理。
 *   白名单与 `agent-tags.js` 的 TAG_NAMES 同源（那边是唯一清单），这里只在
 *   拿不到时用同一份字面量兜底。
 */
function extractReplyTags(text) {
    const t = String(text == null ? '' : text);
    const names = (window.ElainaTags && Array.isArray(window.ElainaTags.TAG_NAMES))
        ? window.ElainaTags.TAG_NAMES
        : ['表情', '动作', '情绪', '位置', '大小', '背景', '操作', '任务'];
    const tokens = [];
    for (const name of names) {
        // 闭合标签：`[操作:…]`；标签名后必须紧跟冒号，避免把 `[操作记录]` 这类正文吃掉
        for (const tag of (t.match(new RegExp('\\[' + name + '[:：][^\\]\\n]*\\]', 'g')) || [])) {
            tokens.push(tag);
        }
    }
    for (const tag of (t.match(/<scene>[^<\n]*<\/scene>/gi) || [])) tokens.push(tag);
    return tokens.join(' ');
}

/** 用视觉（多模态）模型直接处理图片 + 用户消息，返回其回应；
 *  主模型会基于此回应结合角色卡做最终修正，避免转述模板损失信息。 */
async function describeImageWithVision(prompt, imageDataUrl) {
    const base = String(state.settings.visionBaseUrl || '').trim().replace(/\/+$/, '');
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
    const result = await postJsonFromDevice(endpoint, {
        model: String(state.settings.visionModel || '').trim(),
        messages,
        max_tokens: 512
    }, { Authorization: 'Bearer ' + (String(state.settings.visionApiKey || '').trim() || 'sk-no-key') });
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



