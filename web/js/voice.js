/* ========================================================================
 * 语音：识别 / 输入处理 / 停止按钮 / TTS
 * ======================================================================== */

async function handleUserInput(message, conversation) {
    if (!conversation) {
        conversation = state.conversations.find(c => c.id === state.currentConversationId);
    }
    if (!conversation) return;
    // 自然语言**不再**直接触发文件操作。
    // 原实现（maybeAutoFileWrite）会在把消息发给 AI **之前**做正则匹配，
    // 命中「写入/保存 + 文件/盘/D:\/.txt」就直接执行 —— 也就是**用户打的字本身
    // 就是触发源，与 AI 无关**。这带来三个问题：
    //   1. 绕过 AI：AI 全程不知情，对话里只有一条「【AI 操作结果】」；
    //   2. 正则误伤：聊到 `D:\...` 这种写法就可能被当成指令；
    //   3. 与授权脱节：写文件会弹确认框，但读/列目录不会 —— 用户感觉"我就说句话它怎么动了"。
    // 现在一律交给 AI 判断：由它决定要不要输出 [操作:…] 标签，
    // 行为可预测、AI 全程知情、也走同一条「停止 + 授权」管线。
    // （maybeAutoExpression 保留：它只驱动 Live2D 表情，不碰文件与系统。）
    maybeAutoExpression(String(message?.text || ''));
    const replyTaskKey = `${conversation.id}:${message.id}`;
    if (activeReplyTasks.has(replyTaskKey)) {
        console.log('[Chat] 忽略同一条用户消息的重复回复任务');
        return;
    }
    // 本轮回复的中断器：请求层与"输出中"的停止按钮都挂在这里。
    // 请求进行中 abort 能把 fetch/原生 HTTP 那次等待直接砍掉；
    // 已进入本地渲染/TTS 阶段时 abort 用来让收尾逻辑走"已停止"分支。
    const replyAbort = new AbortController();
    activeReplyTasks.add(replyTaskKey);
    activeReplyAborts.set(replyTaskKey, replyAbort);
    updateStopButtonVisibility();
    let automaticVoiceMessageKey = '';
    // 新一轮用户请求 → 重置 Agent 续跑预算。
    // 不重置的话预算是"整个页面会话共享 8 步"，用过一次就再也不续跑了 ——
    // 用户会看到"第一次能用、后面又不动了"这种更难查的现象。
    resetAgentContinueBudget();

    const t0 = performance.now();

    state.thinkingMessageId = message.id;
    // 先挂一个"正在想"的三点气泡：它覆盖"还没收到第一个增量"的空窗期
    // （思考型模型这一步可能等十几秒，什么都不显示会让人以为卡死了）。
    // 第一个正文增量到达时，renderStreamingReplyPreview 会把它收掉 ——
    // 两个气泡同时留着会出现"上面三点、下面正文"的重复观感。
    renderThinkingMessage();
    resetStreamingReplyPreview();

    try {
        const ttsConfigured = isTtsConfigured(state.settings);
        const wantsJp = ttsConfigured && state.settings.ttsLang === 'japanese';
        // 本轮的过程记录（思考 + 工具调用）。锚点用用户消息的 id：
        // AI 气泡要等回复完成才创建（内容长度、语音卡片都得先知道），
        // 而过程区在流式期间就要显示，所以先挂在用户消息之后。
        beginTurnTrace(message.id);
        const aiRequestOptions = {
            includeVoiceJp: wantsJp,
            imageDataUrl: message.imageRequestDataUrl || message.imageDataUrl || '',
            signal: replyAbort.signal,
            // 流式增量：正文累积进一个缓冲，每帧重绘一次气泡。
            // 注意这里**不**直接把增量拼进 aiMessage —— aiMessage 还没建，
            // 而且回复完成后还要做 Live2D 标签剥离、日语朗读稿拆分等处理，
            // 那些处理必须作用在**完整**文本上，所以流式只负责"先让用户看见"。
            // 两段式（第三人称）时，chunk 上会带 `phase`：
            //   第 1 段的思考（GM 的推理）与第 2 段的思考（改写时的推理）
            //   分别进时间线、互不混合 —— 见 appendTurnReasoning。
            //   只有第 2 段的**正文**才进气泡（第 1 段正文是隐藏的中间产物，
            //   由 data 层拦住，不会走到这里）。
            onDelta: (chunk) => {
                if (chunk.kind === 'reasoning') {
                    // 记下"这一轮确实从流里收到过思考"，供收尾时对账：
                    //   一条都没收到才需要拿非流式响应里的正文补（见下面 replyInfo.reasoning）。
                    streamedReasoningSeen = true;
                    appendTurnReasoning(chunk.text, chunk.phase);
                    return;
                }
                if (chunk.kind !== 'text') return;
                streamedReplyText += chunk.text;
                scheduleStreamingReplyRender();
            },
            // 两段式生成的**阶段输出**：第一段（GM 叙述）与第二段（第一人称正文）
            // 各存一条，用户可以在过程区里分别展开对照。
            onPhase: (phase) => { recordTurnPhase(phase); }
        };
        // 工具通道：这一轮请求带上**当前可用**的工具清单（档位/开关/平台都已在
        // toolsForAccess 里收窄），并把"回复侧元信息"的容器交出去 —— 回来时从它读
        // 这次回复有没有 tool_calls。构造器在 agent.js（agentToolOptions），两处各写一份必然走样。
        const agentToolOpt = agentToolOptions();
        // 思考回传用的容器**独立于工具清单**：
        //   agentToolOptions() 在"没有可用工具"时返回 null（权限关着、手机没启用、
        //   供应商不认 tools），而思考跟工具没有关系 —— 关掉 Agent 权限不该连带
        //   让思考再也显示不出来。所以这里自己备一个，有工具时复用它那个。
        const replyInfo = (agentToolOpt && agentToolOpt.replyInfo) || {};
        const requestOpts = Object.assign({}, aiRequestOptions, agentToolOpt || {}, { replyInfo });
        // 可重试失败（超时 / 网络抖动 / 限流 / 上游 5xx）自动再试一次，重试过程
        // 写在思考气泡上 —— 静默重试会让「等了很久又重新等一遍」看起来像卡死，
        // 直接放弃则把一次瞬时故障变成用户看得见的失败，都不如说一声。
        // 只重试一次：连着失败多半是持续性原因（额度 / Key / 服务商故障），
        // 闷头重试只会白烧额度；那时的报错文案由 showClientApiError 负责。
        const RETRYABLE_CHAT_CODES = new Set([
            'REQUEST_TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMITED', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_UNAVAILABLE',
        ]);
        let rawResponse = null;
        let didRetry = false;
        streamedReasoningSeen = false;
        for (let attempt = 0; ; attempt++) {
            try {
                rawResponse = await callAI(message.text, requestOpts);
                break;
            } catch (chatError) {
                // 用户停止优先于一切重试判断（按了停止还自己再发一次是倒行逆施）
                if (chatError?.name === 'AbortError' || replyAbort.signal.aborted) throw chatError;
                const retryable = chatError instanceof ClientApiError && RETRYABLE_CHAT_CODES.has(chatError.code);
                if (!retryable || attempt >= 1) {
                    if (didRetry) chatError.message = String(chatError.message || chatError.code || '')
                        + '（已自动重试 1 次，仍失败）';
                    throw chatError;
                }
                didRetry = true;
                console.warn('[Chat] 请求失败（' + chatError.code + '），自动重试 1 次：', chatError.message);
                updateThinkingMessageText('模型响应不稳定（' + (chatError.message || chatError.code) + '），正在自动重试…');
                // 限流时等久一点再重发，立刻重发只会撞在同一个限流窗口上
                await new Promise((r) => setTimeout(r, chatError.code === 'RATE_LIMITED' ? 2000 : 1000));
                if (replyAbort.signal.aborted) throw chatError;
                // 重试是全新一次请求：流式状态必须清零，否则上一次的半截增量
                // 会留在预览与过程区里，与新回复拼出重复内容。
                streamedReasoningSeen = false;
                resetStreamingReplyPreview();
            }
        }
        // 思考对账：**只有流里一条都没收到**时才用响应体里的补。
        //   为什么必须补：requestChatJson 在流式还没吐出任何内容就失败时会静默退回
        //   非流式（见那里的注释）。那条路上 onDelta 不再触发，于是思考明明在响应体里
        //   （openai-compatible 的 reasoning_content / anthropic 的 thinking block /
        //   responses 的 reasoning item），却没有任何东西把它交给时间线 ——
        //   用户看到的是"这次没有思考"，而真实原因是换了条传输路径。
        //   为什么只在没收到时才补：流式成功时这些增量已经逐段进了时间线，
        //   再补一遍会让同一段思考出现两次。
        if (!streamedReasoningSeen) {
            const fallbackReasoning = String(replyInfo.reasoning || '').trim();
            if (fallbackReasoning) appendTurnReasoning(fallbackReasoning, null);
        }
        const parsedReply = wantsJp ? splitVoiceReply(rawResponse) : { displayText: rawResponse, voiceJp: '' };
        const response = parsedReply.displayText;
        // **不要**在这里无条件收掉流式预览。
        //   同步模式（simultaneous）下正文要等语音真正开播才提交，而 TTS 生成
        //   本身要等好几秒 —— 在这里就拆预览的话，那几秒屏幕上
        //   **一片空白**（三点气泡早在第一个增量到达时就被预览顶掉了），
        //   用户看到的是"字打完 → 消失 → 等 → 又出现"。
        //   所以交给 commitAiMessageOnce 在渲染正式消息前收（见下），
        //   预览正好无缝交接给正式气泡。
        // ⚠️ 这里**不能**收尾过程区：工具调用是在下面的 commitAiMessageOnce 里才执行的
        //   （协议要求 assistant 的 tool_calls 之后才紧跟结果）。在这里 finishTurnTrace 会把
        //   done 提前置位，而那时 tools 还是空的 —— 没开思考的回合因此整个过程区被跳过
        //   （renderTurnProcess 在"无思考、无工具、无阶段"时直接 return），
        //   于是"即使没开思考，工具调用成功也要显示"这条要求落空：用户只看到气泡，看不到它动了什么。
        //   收尾改由 commitAiMessageOnce 在 runToolCalls 排上之后负责（见那里）；
        //   本回合**没有**工具调用时，才在这里立刻收尾。

        const t1 = performance.now();
        console.log(`[TIMING] 文字模型完成: ${Math.round(t1 - t0)}ms`);

        const aiMessage = {
            id: generateId(),
            role: 'ai',
            text: response,
            voiceJp: parsedReply.voiceJp,
            timestamp: new Date().toLocaleTimeString()
        };
        automaticVoiceMessageKey = String(aiMessage.id);
        pendingAutomaticVoiceMessageIds.add(automaticVoiceMessageKey);

        // 新一批 Agent 动作开始：解除上一批留下的「已停止」状态
        // （用户的停止只作用于当次操作；AI 下一次回复是新批次，应重新可用）
        if (window.agentRuntime) window.agentRuntime.beginBatch();
        // 标签协议：解析 AI 回复中的 [操作:…] / [表情:…] 等标签。
        // 走宿主的 ElainaTags，**不再**经过 Live2D 插件全局名 ——
        //   旧写法是插件在时才 `drive(); stripTags();`，
        //   而 drive() 是全部 [操作:] 标签的唯一分发器（文件/命令/手机/记忆）。
        //   于是"Live2D 不在"就等于"整个 Agent 系统失效 + 标签漏给用户看"。
        //   现在剥离与分发都归宿主，Live2D 只提供表现（表情/动作/口型）。
        // 这一回合走哪条通道：**回复里有工具调用就走工具，否则才解析标签**。
        //   两条都跑会让同一个动作执行两次 —— 模型偶尔既发工具调用、又在正文里写标签。
        const repliedToolCalls = (agentToolOpt && agentToolOpt.replyInfo
            && Array.isArray(agentToolOpt.replyInfo.toolCalls)) ? agentToolOpt.replyInfo.toolCalls : [];
        if (repliedToolCalls.length) {
            // 调用本身要挂到这条 AI 消息上：下一次请求必须带上它 ——
            //   OpenAI 要求 assistant 的 tool_calls 后面紧跟对应的结果，缺了会被上游拒收。
            aiMessage.toolCalls = repliedToolCalls;
            // 模型只说"我去做"、一个字没写时，这条消息不该在聊天记录里占一个空气泡；
            //   但它**必须**留在消息数组里（协议顺序），所以标 hidden。
            if (!String(response).trim()) aiMessage.hidden = true;
        }
        if (window.ElainaTags) {
            // 剥离永远要做：即便走工具通道，正文里万一混了标签也不能漏给用户。
            const stripped = window.ElainaTags.strip(response);
            if (stripped !== response) aiMessage.text = stripped;
            if (!repliedToolCalls.length) window.ElainaTags.drive(response);
        }
        // 本回合没有工具调用 → 过程区这时就是最终内容，立刻收尾（与原来同一时机）。
        //   有工具调用时**不**在这里收尾：tool_calls 还没执行（见 commitAiMessageOnce），
        //   提前收尾会让工具行永远显示不出来（见上面那段说明）。
        if (!repliedToolCalls.length) finishTurnTrace();
        // 定时任务：AI 回复中的 [任务:...] 标签 → 创建未来任务
        extractAndCreateTasks(response);

        let textToSpeak = wantsJp ? getJapaneseVoiceText(aiMessage) : response;
        const prepareVoiceText = async () => {
            if (!wantsJp || textToSpeak) return;
            try {
                textToSpeak = await ensureJapaneseVoiceText(aiMessage);
                if (textToSpeak) console.log('[TTS] 已生成仅含对白的日语朗读文本');
                else console.warn('[TTS] 未能生成日语朗读稿，本轮不播放中文兜底');
            } catch (error) {
                textToSpeak = '';
                console.warn('[TTS] 日语翻译失败，本轮不播放中文兜底:', error.message || error);
            }
        };

        const presentationMode = state.settings.replyDisplayMode || DEFAULT_SETTINGS.replyDisplayMode;
        let voiceStarted = false;
        let messageCommitted = false;
        const commitAiMessageOnce = () => {
            if (messageCommitted) return;
            messageCommitted = true;
            // 正式气泡就位前收掉流式预览 —— 顺序不能反：先 renderMessage 再收，
            //   中间那一瞬两个气泡并存（同一段话显示两遍）；先收再渲染则是无缝交接。
            //   放在这里而不是更早，是为了让同步模式的 TTS 等待期仍有正文可看。
            removeStreamingReplyPreview();
            conversation.messages.push(aiMessage);
            conversation.updatedAt = new Date().toISOString();
            saveConversations();
            // 不要在这里放"用户说写入你想说的话就把 AI 回复写进文件"这类自动写入：
            //   它只会被 maybeAutoFileWrite 触发，而那个函数又只从这里调用 ——
            //   是一个永不可达的死分支。
            //   这个需求由 AI 输出 [操作:保存文件 …] 完成。
            renderFolderList();
            updateCurrentConversationTitle();
            removeThinkingMessage();
            if (state.currentConversationId === conversation.id && !aiMessage.hidden
                && !state.notesMode && !state.diaryMode && !document.getElementById(`msg-${safeAttrId(aiMessage.id)}`)) {
                // 这一轮带工具调用 → **先不显示正文**，等工具跑完再统一开口。
                //   为什么必须这样：模型常在同一个回复里**先说结论、再发调用**
                //   （实测："喏，文件已经在那儿了" + save_file）。那段话在工具执行前
                //   就渲染出去了，于是用户先看到"已经建好了"，随后工具失败 ——
                //   界面上变成"它说成功了，但下面那行写着失败"，而模型自己也只能
                //   在续跑里尴尬地道歉。先说后做，顺序本身就是错的。
                //   做法：正文照旧进 conversation.messages（协议要求 assistant 的
                //   tool_calls 必须有对应消息，不能删），但**先不渲染**；等这一批工具
                //   全部执行完，由 runToolCalls 收尾时统一显示。结果确定之后再说话，
                //   说的才可能是真话。
                //   注意只能延迟、不能丢弃：如果工具全成功，用户要看到的正是这段话。
                if (!repliedToolCalls.length) renderMessage(aiMessage);
                else pendingToolReplyMessageId = aiMessage.id;
            }
            state.voiceState = 'idle';
            updateUI();

            // 工具调用要在**这条消息入队之后**才执行：结果是以 role:'tool' 追加到后面的，
            //   协议要求它紧跟 assistant 的 tool_calls —— 顺序反了上游会拒收。
            // （这个函数是幂等的，多次调用只会触发一次。）
            if (repliedToolCalls.length) {
                void runToolCalls(repliedToolCalls, { access: currentAgentAccess() });
            }

            if (state.settings.autoMemory) {
                const userCount = conversation.messages.filter(m => m.role === 'user').length;
                const every = Math.max(3, state.settings.memoryEvery || 6);
                if (userCount % every === 0) {
                    console.log(`[记忆] 自动整理触发（第 ${userCount} 轮）`);
                    setTimeout(() => { requestMemorySummary(conversation.id); }, 800);
                }
            }
        };

        const handleVoiceStart = () => {
            voiceStarted = true;
            if (presentationMode === 'simultaneous') commitAiMessageOnce();
            markVoicePlaybackStarted(aiMessage.id, estimateVoiceDurationSeconds(textToSpeak));
            // Live2D：AI 开始说话 → 嘴动（经宿主服务，不直接点插件全局名）
            const l2d = live2dService();
            if (l2d && l2d.isOpen()) {
                l2d.speakStart();
            }
        };

        if (presentationMode === 'text-first') commitAiMessageOnce();

        if (!ttsConfigured) {
            pendingAutomaticVoiceMessageIds.delete(automaticVoiceMessageKey);
            commitAiMessageOnce();
            return;
        }

        // Text-first mode commits above; Japanese preparation continues without
        // delaying the visible reply. Persist the late voice text for replay.
        await prepareVoiceText();
        if (messageCommitted && aiMessage.voiceJp) saveConversations();

        if (!textToSpeak) {
            pendingAutomaticVoiceMessageIds.delete(automaticVoiceMessageKey);
            // 语音不可用：仍提交并保存文字回复，避免"语音通话模式丢聊天记录"
            commitAiMessageOnce();
            if (presentationMode === 'simultaneous') {
                removeThinkingMessage();
                state.voiceState = 'idle';
                updateUI();
                showCustomAlert('本次回复没有可播放的语音，已保留文字回复。', '语音生成失败');
            }
            return;
        }
        // AI 声音已静音（[操作:静音]）：跳过语音播放，但文字回复照常保留
        // （此前静音只停一下嘴型，TTS 仍会照常播放，等于没静音）
        const l2dMuted = live2dService();
        if (l2dMuted && typeof l2dMuted.isVoiceMuted === 'function' && l2dMuted.isVoiceMuted()) {
            pendingAutomaticVoiceMessageIds.delete(automaticVoiceMessageKey);
            console.log('[TTS] AI 声音已静音，跳过语音播放，保留文字回复');
            commitAiMessageOnce();
            return;
        }
        startVoicePlaybackOnce(aiMessage.id, textToSpeak, handleVoiceStart, {
            cacheKey: buildMessageTtsCacheKey(aiMessage, textToSpeak, conversation.id),
            onEnd: () => {
                setVoicePlaybackState(aiMessage.id, false);
                // Live2D：AI 说完 → 闭嘴
                const l2dEnd = live2dService();
                if (l2dEnd && l2dEnd.isOpen()) {
                    l2dEnd.speakEnd();
                }
            }
        }).then(result => {
            if (result?.cancelled) {
                // 用户取消/停止语音播放：若回复尚未提交则补提交，避免丢聊天记录（幂等）
                commitAiMessageOnce();
                return;
            }
            if (!voiceStarted) {
                // TTS 失败但正文必须留下：
                //   同步模式（simultaneous）的语义是"语音开始播时正文才出现"，
                //   上面那句 `commitAiMessageOnce()` 挂在 handleVoiceStart 里 ——
                //   也就是说**只有 TTS 真的出声了，回复才会被提交**。
                //   所以在这里不能只弹一句"回复没有显示"就 return：
                //   那样用户白等一次完整请求（可能几分钟），正文一个字都看不到，
                //   聊天记录里连痕迹都不留 —— 看起来就是
                //   "必须语音生成成功才能发送全部消息"。
                //   正确取舍：**语音是增强，不是闸门**。TTS 失败 → 降级成纯文字回复，
                //   正文与聊天记录一律保留，只是如实告诉用户这次没声音。
                //   两个模式在这里合并处理：无论哪种模式都提交（commitAiMessageOnce
                //   幂等，text-first 时早已提交过，这里只是补齐同步模式的缺口）。
                console.warn('[TTS] 没有收到可播放语音，降级为纯文字回复（正文与记录均保留）');
                commitAiMessageOnce();
                setVoicePlaybackState(aiMessage.id, false);
                state.voiceState = 'idle';
                updateUI();
                showCustomAlert('本次语音未能生成，已保留文字回复。', '语音生成失败');
            }
        }).catch(error => {
            if (isVoiceCancellation(error)) return;
            console.error('[TTS] 自动语音播放失败:', error);
            // 同上：TTS 失败绝不能让正文与聊天记录一起消失。
            //   commitAiMessageOnce 是幂等的 —— 已经提交过（text-first，或语音已开播）
            //   就什么都不做，只有"还没提交"的同步模式才真正补上一次。
            commitAiMessageOnce();
            setVoicePlaybackState(aiMessage.id, false);
            state.voiceState = 'idle';
            updateUI();
            showClientApiError(error);
        }).finally(() => pendingAutomaticVoiceMessageIds.delete(automaticVoiceMessageKey));
    } catch (error) {
        if (automaticVoiceMessageKey) pendingAutomaticVoiceMessageIds.delete(automaticVoiceMessageKey);
        // 用户点了「停止」→ 安静收尾：清掉思考气泡、状态回 idle，不弹错误框。
        // （请求层的 AbortError 与语音会话的取消都归到这里）
        if (isVoiceCancellation(error) || replyAbort.signal.aborted) {
            console.log('[Chat] 回复已被用户停止，安静收尾');
            removeThinkingMessage();
            state.voiceState = 'idle';
            updateUI();
            return;
        }
        // 已在上游记录过详情的错误不再重复打：
        //   throwProviderResponseError 已经把"HTTP 状态 + 服务商返回"记成一条，
        //   这里再 console.error 一遍，同一次失败就在启动窗口出现两条
        //   几乎一样的 ERRO —— 纯刷屏。界面提示（showClientApiError）照常弹。
        if (!error?.providerLogged) console.error('API Error:', error);
        removeThinkingMessage();
        state.voiceState = 'error';

        updateUI();
        showClientApiError(error);
    } finally {
        // 收掉流式预览：成功路径上面已经收过一次（幂等），
        // 但失败/停止路径只有这里能保证清干净 —— 漏掉的话会留下一个
        // 半截正文的气泡，且它不在 state 里，切会话再回来就变成幽灵内容。
        removeStreamingReplyPreview();
        if (Object.prototype.hasOwnProperty.call(message, 'imageRequestDataUrl')) delete message.imageRequestDataUrl;
        activeReplyTasks.delete(replyTaskKey);
        activeReplyAborts.delete(replyTaskKey);
        updateStopButtonVisibility();
    }
}


// ==================== AI 输出中的「停止」按钮 ====================
// 用户反馈：AI 还在输出（含等待响应的整段时间）界面上没有任何可以停的东西，
// 只能干等。现在把发送按钮在这段时间变成「停止」——
// 与 DSH 的发送/停止二态一致：输入框有内容 → 发送；AI 正在回复 → 停止。
const activeReplyAborts = new Map();   // replyTaskKey -> AbortController

/** 有进行中的回复任务时切换按钮形态（样式细节由 updateComposerSendVisibility 统一处理） */
function updateStopButtonVisibility() {
    updateComposerSendVisibility();
}

/** 停止当前 AI 回复：砍请求 + 停掉正在播的语音（复用语音会话的取消管线） */
function stopAiReply() {
    if (!activeReplyAborts.size) return;
    for (const ctrl of activeReplyAborts.values()) {
        try { ctrl.abort(); } catch (e) { /* 忽略 */ }
    }
    // TTS 请求/播放中的语音一起停（这个函数本来就是"用户打断语音"的总入口）
    void stopActiveVoicePlayback();
    console.log('[Chat] 用户停止了 AI 回复');
}


