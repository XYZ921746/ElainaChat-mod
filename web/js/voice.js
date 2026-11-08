// 语音：识别 / 输入处理 / 停止按钮 / TTS

async function handleUserInput(message, conversation) {
    if (!conversation) {
        conversation = state.conversations.find(c => c.id === state.currentConversationId);
    }
    if (!conversation) return;
    // 自然语言不直接触发文件操作：一律由 AI 输出 [操作:…] 标签决定，避免绕过 AI、正则误伤与授权脱节；maybeAutoExpression 只驱动 Live2D 表情，不碰文件与系统。
    maybeAutoExpression(String(message?.text || ''));
    const replyTaskKey = `${conversation.id}:${message.id}`;
    if (activeReplyTasks.has(replyTaskKey)) {
        console.log('[Chat] 忽略同一条用户消息的重复回复任务');
        return;
    }
    // 本轮回复的中断器：abort 能砍掉请求等待，或让渲染/TTS 收尾走「已停止」分支。
    const replyAbort = new AbortController();
    activeReplyTasks.add(replyTaskKey);
    activeReplyAborts.set(replyTaskKey, replyAbort);
    updateStopButtonVisibility();
    let automaticVoiceMessageKey = '';
    resetAgentContinueBudget();

    const t0 = performance.now();

    state.thinkingMessageId = message.id;
    // 先挂「正在想」气泡覆盖首个增量前的空窗（思考型模型可能等十几秒）；首个正文增量到达时由 renderStreamingReplyPreview 收掉，避免两个气泡并存。
    renderThinkingMessage();
    resetStreamingReplyPreview();

    try {
        const ttsConfigured = isTtsConfigured(state.settings);
        const wantsJp = ttsConfigured && state.settings.ttsLang === 'japanese';
        beginTurnTrace(message.id);
        const aiRequestOptions = {
            includeVoiceJp: wantsJp,
            imageDataUrl: message.imageRequestDataUrl || message.imageDataUrl || '',
            signal: replyAbort.signal,
            // 流式增量只累积进缓冲、每帧重绘一次气泡，不直接拼进 aiMessage：回复完成后还要做标签剥离与日语朗读稿拆分，必须作用在完整文本上；两段式时只有第 2 段正文进气泡（chunk.phase 决定思考进哪段时间线，第 1 段正文是隐藏中间产物，由 data 层拦住）。
            onDelta: (chunk) => {
                if (chunk.kind === 'reasoning') {
                    streamedReasoningSeen = true;
                    appendTurnReasoning(chunk.text, chunk.phase);
                    return;
                }
                if (chunk.kind !== 'text') return;
                streamedReplyText += chunk.text;
                scheduleStreamingReplyRender();
            },
            onPhase: (phase) => { recordTurnPhase(phase); }
        };
        const agentToolOpt = agentToolOptions();
        // 思考容器独立于工具清单：agentToolOptions() 在无可用工具时返回 null，而思考与工具无关；有工具时复用它那个。
        const replyInfo = (agentToolOpt && agentToolOpt.replyInfo) || {};
        const requestOpts = Object.assign({}, aiRequestOptions, agentToolOpt || {}, { replyInfo });
        const RETRYABLE_CHAT_CODES = new Set([
            'REQUEST_TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMITED', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_UNAVAILABLE',
        ]);
        let rawResponse = null;
        let didRetry = false;
        const fallbackChain = fallbackChatChainSettings();
        const attemptPlan = fallbackChain.length
            ? [null, ...fallbackChain]
            : [null, null];
        let attemptIndex = 0;
        streamedReasoningSeen = false;
        for (;;) {
            const attemptSettings = attemptPlan[attemptIndex] || null;
            try {
                rawResponse = await callAI(message.text, requestOpts, attemptSettings || undefined);
                break;
            } catch (chatError) {
                if (chatError?.name === 'AbortError' || replyAbort.signal.aborted) throw chatError;
                attemptIndex += 1;
                if (attemptIndex >= attemptPlan.length) {
                    if (fallbackChain.length && attemptPlan.length > 1) {
                        chatError.message = String(chatError.message || chatError.code || '')
                            + '（默认与回退模型共 ' + attemptPlan.length + ' 套配置都失败）';
                    } else if (didRetry) {
                        chatError.message = String(chatError.message || chatError.code || '')
                            + '（已自动重试 1 次，仍失败）';
                    }
                    throw chatError;
                }
                if (!fallbackChain.length
                    && !(chatError instanceof ClientApiError && RETRYABLE_CHAT_CODES.has(chatError.code))) {
                    throw chatError;
                }
                didRetry = true;
                const step = fallbackChain.length
                    ? '切换回退模型（第 ' + attemptIndex + ' / ' + fallbackChain.length + ' 个）'
                    : '自动重试';
                console.warn('[Chat] 请求失败（' + chatError.code + '），' + step + '：', chatError.message);
                updateThinkingMessageText(
                    (attemptIndex === 1 ? '默认模型失败（' + (chatError.message || chatError.code) + '），' : '上一套配置失败，')
                    + '正在' + step + '…');
                await new Promise((r) => setTimeout(r, chatError.code === 'RATE_LIMITED' ? 2000 : 1000));
                if (replyAbort.signal.aborted) throw chatError;
                streamedReasoningSeen = false;
                resetStreamingReplyPreview();
            }
        }
        // 思考对账：只有流里一条都没收到时才用响应体补 —— requestChatJson 在流式未吐出内容就失败时会静默退回非流式，那条路上思考只在响应体里；流式成功时增量已进时间线，再补会重复。
        if (!streamedReasoningSeen) {
            const fallbackReasoning = String(replyInfo.reasoning || '').trim();
            if (fallbackReasoning) appendTurnReasoning(fallbackReasoning, null);
        }
        const parsedReply = wantsJp ? splitVoiceReply(rawResponse) : { displayText: rawResponse, voiceJp: '' };
        const response = parsedReply.displayText;
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

        if (window.agentRuntime) window.agentRuntime.beginBatch();
        // 标签协议：剥离与分发都归宿主 ElainaTags，Live2D 只提供表现 —— 否则插件缺失等于整个 Agent 系统失效、[操作:] 标签漏给用户看。回复里有工具调用就走工具，否则才解析标签：两条都跑会让同一个动作执行两次。
        const repliedToolCalls = (agentToolOpt && agentToolOpt.replyInfo
            && Array.isArray(agentToolOpt.replyInfo.toolCalls)) ? agentToolOpt.replyInfo.toolCalls : [];
        if (repliedToolCalls.length) {
            aiMessage.toolCalls = repliedToolCalls;
            if (!String(response).trim()) aiMessage.hidden = true;
        }
        if (window.ElainaTags) {
            const stripped = window.ElainaTags.strip(response);
            if (stripped !== response) aiMessage.text = stripped;
            if (!repliedToolCalls.length) window.ElainaTags.drive(response);
        }
        if (!repliedToolCalls.length) finishTurnTrace();
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
            removeStreamingReplyPreview();
            conversation.messages.push(aiMessage);
            conversation.updatedAt = new Date().toISOString();
            saveConversations();
            renderFolderList();
            updateCurrentConversationTitle();
            removeThinkingMessage();
            if (state.currentConversationId === conversation.id && !aiMessage.hidden
                && !state.notesMode && !state.diaryMode && !state.memoryPageMode && !document.getElementById(`msg-${safeAttrId(aiMessage.id)}`)) {
                if (!repliedToolCalls.length) renderMessage(aiMessage);
                else pendingToolReplyMessageId = aiMessage.id;
            }
            state.voiceState = 'idle';
            updateUI();

            if (repliedToolCalls.length) {
                void runToolCalls(repliedToolCalls, { access: currentAgentAccess() });
            }

            if (state.settings.autoMemory) {
                const userCount = conversation.messages.filter(m => m.role === 'user').length;
                const every = Math.max(3, state.settings.memoryEvery || 15);
                if (userCount % every === 0) {
                    console.log(`[记忆] 自动整理触发（第 ${userCount} 轮）`);
                    setTimeout(() => {
                        // requestMemorySummary 的错误会向上抛（内部只把 running 复位放进 finally），
                        // 自动触发没有调用方接住，必须就地 catch，否则成为未处理的 Promise rejection
                        requestMemorySummary(conversation.id).catch((e) => {
                            console.warn('[记忆] 自动整理失败:', e);
                        });
                    }, 800);
                }
            }
        };

        const handleVoiceStart = () => {
            voiceStarted = true;
            clearMessageVoiceError(aiMessage.id);
            if (presentationMode === 'simultaneous') commitAiMessageOnce();
            markVoicePlaybackStarted(aiMessage.id, estimateVoiceDurationSeconds(textToSpeak));
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

        await prepareVoiceText();
        if (messageCommitted && aiMessage.voiceJp) saveConversations();

        if (!textToSpeak) {
            pendingAutomaticVoiceMessageIds.delete(automaticVoiceMessageKey);
            commitAiMessageOnce();
            removeThinkingMessage();
            state.voiceState = 'idle';
            updateUI();
            setMessageVoiceError(aiMessage.id, '本次回复没有可播放的语音，已保留文字回复。');
            return;
        }
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
                // TTS 失败但正文必须留下：同步模式只在语音真的开播时提交回复，这里不补提交会让用户白等一次完整请求且聊天记录无痕；语音是增强不是闸门，降级为纯文字并如实告知。
                console.warn('[TTS] 没有收到可播放语音，降级为纯文字回复（正文与记录均保留）');
                commitAiMessageOnce();
                setVoicePlaybackState(aiMessage.id, false);
                state.voiceState = 'idle';
                updateUI();
                setMessageVoiceError(aiMessage.id, '本次语音未能生成，已保留文字回复。');
            }
        }).catch(error => {
            if (isVoiceCancellation(error)) return;
            console.error('[TTS] 自动语音播放失败:', error);
            // 同上：TTS 失败绝不能让正文与聊天记录一起消失；commitAiMessageOnce 幂等，只有尚未提交的同步模式才真正补一次。
            commitAiMessageOnce();
            setVoicePlaybackState(aiMessage.id, false);
            state.voiceState = 'idle';
            updateUI();
            setMessageVoiceError(aiMessage.id, '语音生成失败：' + voiceErrorSummary(error));
        }).finally(() => pendingAutomaticVoiceMessageIds.delete(automaticVoiceMessageKey));
    } catch (error) {
        if (automaticVoiceMessageKey) pendingAutomaticVoiceMessageIds.delete(automaticVoiceMessageKey);
        // 用户点了「停止」→ 安静收尾：清掉思考气泡、状态回 idle，不弹错误框（AbortError 与语音取消都归这里）。
        if (isVoiceCancellation(error) || replyAbort.signal.aborted) {
            console.log('[Chat] 回复已被用户停止，安静收尾');
            removeThinkingMessage();
            state.voiceState = 'idle';
            updateUI();
            return;
        }
        // 上游已记录详情的错误不再重复打：throwProviderResponseError 已记成一条，再 console.error 一遍只会让同一次失败刷屏；界面提示照常弹。
        if (!error?.providerLogged) console.error('API Error:', error);
        removeThinkingMessage();
        state.voiceState = 'error';

        updateUI();
        showClientApiError(error);
    } finally {
        // 失败/停止路径只有这里能保证收掉流式预览：漏掉会留下不在 state 里的半截气泡，切会话再回来就变成幽灵内容。
        removeStreamingReplyPreview();
        if (Object.prototype.hasOwnProperty.call(message, 'imageRequestDataUrl')) delete message.imageRequestDataUrl;
        activeReplyTasks.delete(replyTaskKey);
        activeReplyAborts.delete(replyTaskKey);
        updateStopButtonVisibility();
    }
}


const activeReplyAborts = new Map();   // replyTaskKey -> AbortController

/** 有进行中的回复任务时切换按钮形态 */
function updateStopButtonVisibility() {
    updateComposerSendVisibility();
}

/** 停止当前 AI 回复：砍请求 + 停掉正在播的语音（复用语音会话的取消管线） */
function stopAiReply() {
    if (!activeReplyAborts.size) return;
    for (const ctrl of activeReplyAborts.values()) {
        try { ctrl.abort(); } catch (e) { /* 忽略 */ }
    }
    void stopActiveVoicePlayback();
    console.log('[Chat] 用户停止了 AI 回复');
}


