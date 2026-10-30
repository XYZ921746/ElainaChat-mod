/* ============================================================================
 * 消息语音播放（从 ui.js 拆出）
 *
 * 播放状态 / 独占播放 / 取消 / 波形 / 时长 / 按钮状态。
 * 依赖 voice 服务与消息渲染（运行时才调用）。
 * ========================================================================== */
'use strict';

const pendingAutomaticVoiceMessageIds = new Set();
const pendingJapaneseVoiceTextTasks = new WeakMap();
const voicePlaybackTasksByMessageId = new Map();

function getJapaneseVoiceText(message) {
    const voiceText = String(message?.voiceJp || '').trim();
    return /[\u3040-\u30ff]/.test(voiceText) ? voiceText : '';
}

function ensureJapaneseVoiceText(message) {
    const existing = getJapaneseVoiceText(message);
    if (existing) return Promise.resolve(existing);
    if (!message || typeof message !== 'object') return Promise.resolve('');
    const pending = pendingJapaneseVoiceTextTasks.get(message);
    if (pending) return pending;
    const dialogueOnly = sanitizeTtsText(message.text || '', false);
    if (!dialogueOnly) return Promise.resolve('');
    const task = translateToJapanese(dialogueOnly).then(result => {
        const japanese = String(result || '').trim();
        if (!/[\u3040-\u30ff]/.test(japanese)) return '';
        message.voiceJp = japanese;
        return japanese;
    });
    pendingJapaneseVoiceTextTasks.set(message, task);
    const clearTask = () => {
        if (pendingJapaneseVoiceTextTasks.get(message) === task) pendingJapaneseVoiceTextTasks.delete(message);
    };
    task.then(clearTask, clearTask);
    return task;
}

function createVoiceCancellationError() {
    const error = new Error('语音播放已取消');
    error.name = 'AbortError';
    error.code = 'VOICE_CANCELLED';
    return error;
}

function isVoiceCancellation(error) {
    return error?.name === 'AbortError' || error?.code === 'VOICE_CANCELLED';
}

function createVoiceSession(messageId = null) {
    const session = {
        generation: ++voicePlaybackGeneration,
        messageId,
        cancelled: false,
        abortController: null,
        webSocket: null,
        audioSources: new Set(),
        browserUtterance: null
    };
    session.cancelPromise = new Promise(resolve => { session.resolveCancel = resolve; });
    activeVoiceSession = session;
    return session;
}

function isVoiceSessionActive(session) {
    return Boolean(session) && activeVoiceSession === session && !session.cancelled && session.generation === voicePlaybackGeneration;
}

function ensureVoiceSessionActive(session) {
    if (!isVoiceSessionActive(session)) throw createVoiceCancellationError();
}

function estimateVoiceDurationSeconds(text) {
    const clean = sanitizeTtsText(text || '', false);
    if (!clean) return 0;
    const cjkCount = (clean.match(/[\u3400-\u9fff\u3040-\u30ff]/g) || []).length;
    const latinWords = clean.replace(/[\u3400-\u9fff\u3040-\u30ff]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    const punctuationPauses = (clean.match(/[，。！？；：,.!?;:]/g) || []).length * 0.16;
    const speed = Math.max(0.5, Number(state.settings.ttsSpeed) || 1);
    return Math.max(2, Math.ceil((cjkCount / 4.5 + latinWords / 2.4 + punctuationPauses) / speed));
}

function formatVoiceDuration(seconds) {
    const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function voiceWaveformMarkup() {
    return Array.from({ length: 15 }, () => '<span class="voice-wave-bar"></span>').join('');
}

function updateVoicePlayerButton(messageId, status) {
    const button = document.getElementById(`voice-player-${safeAttrId(messageId)}`);
    if (!button) return;
    const isPlaying = status === 'playing';
    const isPaused = status === 'paused';
    const isLoading = status === 'loading';
    button.classList.toggle('is-playing', isPlaying);
    button.classList.toggle('is-paused', isPaused);
    button.classList.toggle('is-loading', isLoading);
    button.setAttribute('aria-busy', isLoading ? 'true' : 'false');
    button.setAttribute('aria-label', isLoading ? '伊蕾娜的语音生成中' : isPlaying ? '暂停伊蕾娜的语音' : isPaused ? '继续伊蕾娜的语音' : '播放伊蕾娜的语音');
}

// 语音生成 / 播放失败时把原因留在该条消息的语音条上，而不是弹窗打断对话。
// 原因按消息 id 记住：消息可能还没渲染（工具回合 / 用户已切走的会话），
// 等它真正渲染时再补到语音条上。
const messageVoiceErrors = new Map();

function voiceErrorSummary(error) {
    const apiError = typeof toClientApiError === 'function' ? toClientApiError(error) : error;
    const code = String(apiError?.code || '');
    const raw = String(apiError?.message || apiError || '').replace(/\s+/g, ' ').trim();
    const detail = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
    switch (code) {
        case 'APP_KEY_INVALID': return 'Key 无效或已失效，请在设置中更换';
        case 'MINIMAX_QUOTA_EXHAUSTED': return '服务额度或余额不足，请检查服务商账号';
        case 'RATE_LIMITED':
        case 'UPSTREAM_RATE_LIMITED': return '请求过于频繁，请稍后再试';
        case 'REQUEST_TIMEOUT': return '请求超时，请稍后重试';
        case 'NETWORK_ERROR': return '请求没能发出去（网络或跨域问题）';
        default: return detail || '请稍后重试';
    }
}

function applyMessageVoiceError(messageId, root) {
    const scope = root || document;
    let button;
    try {
        button = scope.querySelector('#voice-player-' + safeAttrId(messageId));
    } catch (e) { return; }
    if (!button) return;
    const card = button.closest ? button.closest('.ai-voice-card') : null;
    const text = messageVoiceErrors.get(String(messageId)) || '';
    button.classList.toggle('is-error', Boolean(text));
    if (text) {
        button.setAttribute('aria-busy', 'false');
        button.setAttribute('aria-label', '语音生成失败，点击重试');
    } else {
        button.setAttribute('aria-busy', 'false');
        button.setAttribute('aria-label', '播放伊蕾娜的语音');
    }
    const label = card ? card.querySelector('.ai-voice-error') : null;
    if (label) {
        label.textContent = text;
        label.hidden = !text;
    }
}

function setMessageVoiceError(messageId, text) {
    const key = String(messageId);
    const value = String(text || '').trim();
    if (value) messageVoiceErrors.set(key, value);
    else messageVoiceErrors.delete(key);
    applyMessageVoiceError(key);
}

function clearMessageVoiceError(messageId) {
    messageVoiceErrors.delete(String(messageId));
    applyMessageVoiceError(messageId);
}

function setVoicePlaybackLoading(messageId) {
    clearMessageVoiceError(messageId);
    if (activeVoicePlayerId && String(activeVoicePlayerId) !== String(messageId)) {
        updateVoicePlayerButton(activeVoicePlayerId, 'idle');
    }
    activeVoicePlayerId = messageId;
    activeVoicePlaybackStatus = 'loading';
    updateVoicePlayerButton(messageId, 'loading');
}

function setVoicePlaybackState(messageId, playing, durationSeconds = 0) {
    if (activeVoicePlayerId && String(activeVoicePlayerId) !== String(messageId)) {
        updateVoicePlayerButton(activeVoicePlayerId, 'idle');
    }
    if (!playing) {
        updateVoicePlayerButton(messageId, 'idle');
        if (String(activeVoicePlayerId) === String(messageId)) {
            activeVoicePlayerId = null;
            activeVoicePlaybackStatus = 'idle';
        }
        return;
    }
    activeVoicePlayerId = messageId;
    activeVoicePlaybackStatus = 'playing';
    updateVoicePlayerButton(messageId, 'playing');
}

function markVoicePlaybackStarted(messageId, durationSeconds = 0) {
    // 用户可能在音频真正产出前就点了暂停，启动回调不能把它强行切回播放。
    if (String(activeVoicePlayerId) === String(messageId) && activeVoicePlaybackStatus === 'paused') {
        updateVoicePlayerButton(messageId, 'paused');
        if (_audioContext && _audioContext.state === 'running') _audioContext.suspend().catch(() => {});
        if ('speechSynthesis' in window && window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
            window.speechSynthesis.pause();
        }
        return;
    }
    setVoicePlaybackState(messageId, true, durationSeconds);
}

async function toggleVoicePlayback(messageId) {
    if (String(activeVoicePlayerId) !== String(messageId)) return false;
    if (activeVoicePlaybackStatus === 'loading') {
        console.log('[TTS] 语音仍在生成，点击复用当前任务');
        return true;
    }
    if (activeVoicePlaybackStatus === 'playing') {
        activeVoicePlaybackStatus = 'paused';
        updateVoicePlayerButton(messageId, 'paused');
        if (_audioContext && _audioContext.state === 'running') await _audioContext.suspend().catch(() => {});
        if ('speechSynthesis' in window && window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
            window.speechSynthesis.pause();
        }
        return true;
    }
    if (activeVoicePlaybackStatus === 'paused') {
        if (_audioContext && _audioContext.state === 'suspended') await _audioContext.resume().catch(() => {});
        if ('speechSynthesis' in window && window.speechSynthesis.paused) window.speechSynthesis.resume();
        activeVoicePlaybackStatus = 'playing';
        updateVoicePlayerButton(messageId, 'playing');
        return true;
    }
    return false;
}

async function stopActiveVoicePlayback(invalidatePendingStart = true) {
    if (invalidatePendingStart) voicePlaybackStartGeneration += 1;
    const previousId = activeVoicePlayerId;
    const previousSession = activeVoiceSession;
    voicePlaybackGeneration += 1;
    activeVoiceSession = null;
    if (previousSession) {
        previousSession.cancelled = true;
        if (previousSession.resolveCancel) previousSession.resolveCancel({ cancelled: true });
        if (previousSession.abortController) previousSession.abortController.abort();
        if (previousSession.webSocket) {
            try { previousSession.webSocket.close(1000, 'cancelled'); } catch (e) { /* 已关闭的连接无需处理 */ }
        }
        previousSession.audioSources.forEach(source => {
            try { source.stop(); } catch (e) { /* 音频源可能已经结束 */ }
            try { source.disconnect(); } catch (e) { /* 已断开的音频源无需处理 */ }
        });
        previousSession.audioSources.clear();
    }
    activeTtsTasks.clear();
    if (previousId != null) setVoicePlaybackState(previousId, false);
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    const previousContext = _audioContext;
    _audioContext = null;
    if (previousContext && previousContext.state !== 'closed') {
        try { await previousContext.close(); } catch (e) { /* 已结束的上下文无需处理 */ }
    }
}

async function startExclusiveVoicePlayback(messageId, text, onStart, options = {}) {
    const startGeneration = ++voicePlaybackStartGeneration;
    await stopActiveVoicePlayback(false);
    if (startGeneration !== voicePlaybackStartGeneration) return { cancelled: true };
    const session = createVoiceSession(messageId);
    if (startGeneration !== voicePlaybackStartGeneration || !isVoiceSessionActive(session)) return { cancelled: true };
    setVoicePlaybackLoading(messageId);
    return speakText(text, onStart, { ...options, messageId, session });
}

function startVoicePlaybackOnce(messageId, text, onStart, options = {}) {
    const messageKey = String(messageId);
    const existingTask = voicePlaybackTasksByMessageId.get(messageKey);
    if (existingTask) {
        console.log('[TTS] 复用同一消息正在进行的播放任务');
        return existingTask;
    }
    const task = startExclusiveVoicePlayback(messageId, text, onStart, options);
    voicePlaybackTasksByMessageId.set(messageKey, task);
    const clearTask = () => {
        if (voicePlaybackTasksByMessageId.get(messageKey) === task) {
            voicePlaybackTasksByMessageId.delete(messageKey);
        }
    };
    task.then(clearTask, clearTask);
    return task;
}


