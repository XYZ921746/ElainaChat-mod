/* ============================================================================
 * 语音识别 / 录音（从 voice.js 拆出）
 *
 * 浏览器 / 云端 ASR、录音采样、转写、麦克风开始 / 结束 / 取消。
 * 依赖 state、DOM 与网络请求（运行时才调用）。
 * ========================================================================== */
'use strict';

// ==================== 语音识别 ====================

function initSpeechRecognition() {
    initBrowserSpeechRecognition();
}

function initBrowserSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) return;
    browserRecognition = createBrowserRecognition();
}

// 创建并绑定事件的新 SpeechRecognition 实例
function createBrowserRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SpeechRecognition();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    asrHadTranscript = false; // 每次新会话重置"已有内容"标记

    rec.onstart = () => {
        asrRecognitionActive = true;
        if (asrEnding || asrSubmitting) return;
        state.voiceState = 'listening';
        updateUI();
    };

    rec.onresult = (event) => {
        if (asrEnding || asrSubmitting) return;
        let allFinals = '';
        let latestInterim = '';
        for (let i = 0; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
                allFinals += event.results[i][0].transcript + ' ';
            } else if (i === event.results.length - 1) {
                latestInterim = event.results[i][0].transcript;
            }
        }
        const combined = (allFinals + latestInterim).trim();
        if (combined) asrHadTranscript = true;
        handleTranscriptUpdate(combined, 'browser');
    };

    rec.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        asrRecognitionActive = false;
        clearVoiceTimers();
        if (asrEnding || asrSubmitting) return;
        // 已识别出内容时不弹"网络不可达"类错误（浏览器识别结果可用，忽略 Google 服务不可达）
        if (event.error === 'network' && asrHadTranscript) {
            console.warn('[ASR] 已获得识别内容，忽略 network 错误');
            return;
        }
        // 若配置了云端 ASR（阿里云/小米 MiMo），直接降级为"本地录音 + 云端最终识别"，
        // 不弹"浏览器网络不可达"（浏览器识别只是预览，云端才是主用）
        if ((isBrowserSpeechPermissionError(event.error) || event.error === 'network' || event.error === 'service-not-allowed') && canUseCloudFinalAsr()) {
            console.warn('[ASR] 浏览器实时识别不可用(' + event.error + ')，改用录音+云端最终识别');
            asrMode = 'cloud-final-only';
            state.voiceState = 'listening';
            updateUI();
            elements.statusText.textContent = '浏览器识别不可用，正在录音，点击麦克风结束识别...';
            return;
        }
        if (event.error !== 'aborted' && event.error !== 'no-speech') {
            if (event.error === 'network') {
                // 国内网络下浏览器识别服务不可达是常态：不弹模态框打扰，仅状态栏提示
                console.warn('[ASR] 浏览器识别网络不可用（已静默），建议配置阿里百炼/小米 MiMo 云端识别');
                state.voiceState = 'listening';
                updateUI();
                // 顺序很重要：updateUI() 会用 statusMap[voiceState] 覆盖状态栏文本，
                // 所以自定义提示必须写在 updateUI() 之后，否则用户什么都看不到
                elements.statusText.textContent = '浏览器语音识别不可用（网络），可在设置 → 模型 → 语音配置阿里百炼/小米 MiMo';
                return;
            }
            state.voiceState = 'error';
            updateUI();
            showCustomAlert(friendlyAsrError(event.error), '语音识别错误');
        }
    };

    rec.onend = () => {
        asrRecognitionActive = false;
        if (asrEnding || asrSubmitting) return;
        if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
        }
        const endedSessionId = asrSessionId;
        if ((asrMode === 'browser' || asrMode === 'browser-session' || asrMode === 'browser-cloud-final') && (state.voiceState === 'listening' || state.voiceState === 'paused')) {
            setTimeout(() => {
                if (endedSessionId === asrSessionId && !asrStarting && (asrMode === 'browser' || asrMode === 'browser-session' || asrMode === 'browser-cloud-final') && (state.voiceState === 'listening' || state.voiceState === 'paused')) {
                    safeStartRecognition().then(ok => {
                        if (!ok && state.voiceState === 'listening') {
                            state.voiceState = 'paused';
                            updateUI();
                        }
                    }).catch(e => {
                        console.warn('[Voice] 浏览器识别重启失败', e);
                        if (state.voiceState === 'listening') {
                            state.voiceState = 'paused';
                            updateUI();
                        }
                    });
                }
            }, 250);
        }
    };
    return rec;
}

// 重建识别实例：旧实例可能因异常卡死在 running 状态（onend 未触发），
// abort/stop 都无法恢复，唯一办法是丢弃旧实例、创建新实例重新绑定事件
function rebuildBrowserRecognition() {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) return false;
    try {
        if (browserRecognition) {
            try { browserRecognition.onstart = null; browserRecognition.onresult = null; browserRecognition.onerror = null; browserRecognition.onend = null; } catch (e) { /* ignore */ }
            try { browserRecognition.abort(); } catch (e) { /* 已停止则忽略 */ }
            try { browserRecognition.stop(); } catch (e) { /* 已停止则忽略 */ }
        }
        browserRecognition = createBrowserRecognition();
        asrRecognitionActive = false;
        console.warn('[Voice] 已重建 SpeechRecognition 实例');
        return true;
    } catch (e) {
        console.warn('[Voice] 重建识别实例失败', e);
        return false;
    }
}

function canUseCloudFinalAsr() {
    const provider = state.settings.asrProvider || 'browser';
    if (provider === 'aliyun') return Boolean(String(state.settings.asrApiKey || '').trim());
    if (provider === 'mimo') return Boolean(String(state.settings.mimoApiKey || '').trim());
    return false;
}

function isLocalAudioAsrMode(mode = asrMode) {
    return mode === 'browser-session' || mode === 'browser-cloud-final' || mode === 'cloud-final-only';
}

function isBrowserSpeechPermissionError(error) {
    const text = String(error?.message || error?.name || error || '').toLowerCase();
    return text.includes('permission') ||
        text.includes('denied') ||
        text.includes('not-allowed') ||
        text.includes('not_allowed') ||
        text.includes('service-not-allowed');
}

// 安全启动浏览器识别：Chrome 在 abort/stop 后立即 start()（或 onend 后立即 start()）可能
// 抛 "recognition has already started"。先 abort 重置重试；若旧实例已卡死（onend 未触发，
// abort 也无效）→ 直接重建全新实例再试，新实例状态干净一定能 start。
async function safeStartRecognition(maxTries = 3) {
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
            browserRecognition.start();
            asrRecognitionActive = true;
            return true;
        } catch (error) {
            const msg = String(error?.message || error?.name || error || '');
            if (!/already started/i.test(msg)) throw error;
            console.warn(`[Voice] recognition already started（第 ${attempt} 次），重建实例后重试`);
            // abort 重置（可能无效）+ 强制重建新实例
            try { browserRecognition.abort(); } catch (e) { /* 已停止则忽略 */ }
            asrRecognitionActive = false;
            rebuildBrowserRecognition();
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }
    console.warn('[Voice] recognition 连续重试仍失败');
    return false;
}

// 把浏览器语音识别的晦涩错误码翻译成可操作的提示
function friendlyAsrError(err) {
    const text = String(err || '');
    switch (text) {
        case 'not-allowed':
        case 'service-not-allowed':
            return '麦克风权限被拒绝，或当前环境不允许语音识别。\n请允许麦克风权限；若通过局域网 IP 或手机访问（非 https），浏览器会禁用语音识别——请改用 localhost 或 https 访问，或在设置 → 模型 → 语音中配置「阿里百炼」或「小米 MiMo」云端识别。';
        case 'network':
            return '浏览器语音识别需要连接在线语音服务，当前网络不可达（国内网络常见）。\n建议在设置 → 模型 → 语音中选择「阿里百炼」或「小米 MiMo」作为识别服务，或更换网络后重试。';
        case 'audio-capture':
            return '无法获取麦克风音频。请检查麦克风是否被占用、系统权限是否被禁用。';
        case 'no-speech':
            return '未检测到语音，请靠近麦克风后再试。';
        default:
            return '语音识别出错：' + text + '\n可尝试刷新重试，或在设置 → 模型 → 语音中配置「阿里百炼」或「小米 MiMo」云端识别。';
    }
}

function clearVoiceTimers() {
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
    if (pausedSubmitTimer) {
        clearTimeout(pausedSubmitTimer);
        pausedSubmitTimer = null;
    }
}

function scheduleVoicePause() {
    if (!currentTranscript.trim()) return;
    if (silenceTimer) clearTimeout(silenceTimer);
    if (pausedSubmitTimer) {
        clearTimeout(pausedSubmitTimer);
        pausedSubmitTimer = null;
    }

    silenceTimer = setTimeout(() => {
        if (currentTranscript.trim() && state.voiceState === 'listening') {
            console.log('[Voice] 2s 停顿，切换到 paused 状态');
            state.voiceState = 'paused';
            updateUI();
            pausedSubmitTimer = setTimeout(() => {
                if (state.voiceState === 'paused' && currentTranscript.trim()) {
                    console.log('[Voice] paused 2.5s 仍无后续输入，自动提交transcript');
                    endListening();
                }
            }, ASR_AUTO_SUBMIT_DELAY_MS);
        }
    }, ASR_PAUSE_DELAY_MS);
}

function handleTranscriptUpdate(text, source = 'local') {
    currentTranscript = (text || '').trim();
    if (currentTranscript) {
        elements.statusText.textContent = '听到: ' + currentTranscript;
        lastSpeechTime = Date.now();
        if (state.voiceState === 'paused') {
            state.voiceState = 'listening';
            updateUI();
        }
        scheduleVoicePause();
    } else if (state.voiceState === 'listening') {
        elements.statusText.textContent = source === 'cloud' ? '云端识别中...' : '正在聆听...';
    }
}

function downsampleBuffer(input, inputSampleRate, outputSampleRate) {
    if (outputSampleRate === inputSampleRate) return input;
    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.max(1, Math.floor(input.length / ratio));
    const output = new Float32Array(outputLength);
    let inputOffset = 0;
    for (let i = 0; i < outputLength; i++) {
        const nextOffset = Math.round((i + 1) * ratio);
        let sum = 0;
        let count = 0;
        for (let j = inputOffset; j < nextOffset && j < input.length; j++) {
            sum += input[j];
            count++;
        }
        output[i] = count > 0 ? sum / count : 0;
        inputOffset = nextOffset;
    }
    return output;
}

function resetRecordedAudio() {
    asrRecordedChunks = [];
    asrRecordedSampleCount = 0;
    asrRecordedSquareSum = 0;
    asrRecordedPeak = 0;
    asrRecordedActiveSamples = 0;
}

function rememberAsrAudio(samples) {
    if (!samples?.length) return;
    const maxSamples = ASR_TARGET_SAMPLE_RATE * ASR_MAX_RECORD_SECONDS;
    if (asrRecordedSampleCount >= maxSamples) return;
    const available = maxSamples - asrRecordedSampleCount;
    const chunk = samples.length > available ? samples.slice(0, available) : new Float32Array(samples);
    asrRecordedChunks.push(chunk);
    asrRecordedSampleCount += chunk.length;
    for (let i = 0; i < chunk.length; i++) {
        const value = chunk[i];
        const abs = Math.abs(value);
        asrRecordedSquareSum += value * value;
        if (abs > asrRecordedPeak) asrRecordedPeak = abs;
        if (abs > 0.01) asrRecordedActiveSamples++;
    }
}

function getRecordedAsrAudio() {
    if (!asrRecordedSampleCount) return null;
    const merged = new Float32Array(asrRecordedSampleCount);
    let offset = 0;
    for (const chunk of asrRecordedChunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return merged;
}

function getRecordedAsrStats() {
    const samples = asrRecordedSampleCount;
    return {
        samples,
        seconds: samples / ASR_TARGET_SAMPLE_RATE,
        rms: samples > 0 ? Math.sqrt(asrRecordedSquareSum / samples) : 0,
        peak: asrRecordedPeak,
        activeRatio: samples > 0 ? asrRecordedActiveSamples / samples : 0
    };
}

function float32ToWavBase64(samples, sampleRate) {
    const wav = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(wav);
    const writeText = (offset, text) => {
        for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let index = 0; index < samples.length; index++) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    const bytes = new Uint8Array(wav);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function normalizeAsrTextForGuard(text) {
    return String(text || '')
        .trim()
        .toLowerCase()
        .replace(/[，。！？；：、]/g, '.')
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.!?;:])/g, '$1');
}

function isBadCloudFinalText(text, fallbackTranscript) {
    const normalized = normalizeAsrTextForGuard(text);
    if (!normalized) return true;
    if (ASR_BAD_FINAL_TEXTS.has(normalized)) return true;
    if (/^[.。]+$/.test(normalized)) return true;
    if (fallbackTranscript && normalized.length <= 2 && normalizeAsrTextForGuard(fallbackTranscript).length > normalized.length) return true;
    return false;
}

async function fetchWithTimeout(url, options, timeoutMs, signal = null) {
    const controller = new AbortController();
    // 超时必须与「外部主动中止」区分开：两者都经 controller.abort() 变成
    // AbortError，而下游把 AbortError 一律按「用户点了停止」安静收尾 ——
    // 超时被这样吞掉后，用户等了几分钟却一个提示都没有。这里记下触发者，
    // 内部计时器到点（且外部信号并未中止）时改抛带 REQUEST_TIMEOUT 码的
    // 错误，让它走正常的报错与重试链路；用户停止仍抛 AbortError 原样上抛。
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    // 两个中止来源要**都**接上：内部超时用 controller，
    // 外部（用户点「停止」/ 流式回退）用调用方传进来的 signal。
    // 只认 options.signal 是不够的 —— options 里的 signal 会被下面
    // `{ ...options, signal: controller.signal }` 覆盖掉，等于外部信号没有生效，
    // 「停止」按钮按了请求还在跑。所以这里显式收第 4 个参数，由调用方
    // 明确把要一起接上的中止来源传进来。
    const externalSignal = signal || options?.signal;
    const abortFromExternal = () => controller.abort();
    if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (timedOut && !(externalSignal && externalSignal.aborted)) {
            const seconds = Math.round(Number(timeoutMs) / 1000);
            throw new ClientApiError('REQUEST_TIMEOUT',
                '等待 ' + seconds + ' 秒没有收到模型数据，连接已按超时断开（timeout）。',
                { retryable: true });
        }
        throw error;
    } finally {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', abortFromExternal);
    }
}

async function transcribeRecordedAudioWithCloud() {
    const provider = state.settings.asrProvider || 'browser';
    if (provider === 'mimo') return transcribeRecordedAudioWithMimo();
    return transcribeRecordedAudioWithAliyun();
}

/**
 * 组装阿里百炼 ASR 的请求体 —— **形状随模型家族而变**，
 * 两种形状**互不兼容**，用错服务端直接回 400，而不是"模型不存在"这类好懂的错：
 *   · qwen3-asr-flash：content 写 { audio: … }、parameters 写 asr_options；
 *   · qwen-audio-3.x-asr-flash：content 项必须带 type:'input_audio' +
 *     input_audio.data（不是 { audio }），且 parameters 里 **format 必填**
 *     （音频格式 wav/mp3/opus…）—— 漏了 format 会回 400「format is empty」。
 */
function buildAliyunAsrRequestBody(model, wavBase64) {
    const data = `data:audio/wav;base64,${wavBase64}`;
    const m = String(model || '').toLowerCase();
    // qwen-audio-3.x-asr-flash / fun-asr-flash：input_audio 形状 + 必填 format
    if (/^(qwen-audio-|fun-asr)/.test(m)) {
        return {
            model,
            input: {
                messages: [{
                    role: 'user',
                    content: [{ type: 'input_audio', input_audio: { data } }]
                }]
            },
            parameters: { format: 'wav', sample_rate: String(ASR_TARGET_SAMPLE_RATE) }
        };
    }
    // 默认（qwen3-asr-flash）：原有形状不变
    return {
        model,
        input: {
            messages: [{ role: 'user', content: [{ audio: data }] }]
        },
        parameters: { asr_options: { language: 'zh', enable_itn: true } }
    };
}

/**
 * 判断阿里百炼 ASR 的返回是不是"音频里没有人声"。
 *
 * 为什么单独认这个错：3.x 系列在音频无语音时回 **HTTP 400 + ASR_RESPONSE_HAVE_NO_WORDS**，
 * 而「测试」按钮发的正是 0.5 秒静音 —— 不认它，就会把"Key 有效、模型可用"误报成失败
 * （用户看到这条就会以为"还是调不了"）。真实录音里没人声时同理，该按空结果处理，而不是抛错。
 */
function isAsrNoWordsError(result) {
    if (!result || !result.payload) return false;
    const p = result.payload;
    const probe = [
        p.code,
        p.message,
        p.base_resp && p.base_resp.status_msg,
        p.error && (p.error.message || p.error),
        p.error,
    ].filter(Boolean).map(String).join(' ');
    if (/NO_WORDS/i.test(probe) || /no[ _-]?words/i.test(probe)) return true;
    // 兜底：错误体字段名不固定，整体序列化再找一次（错误体很小，代价可忽略）
    try { return /NO_WORDS/i.test(JSON.stringify(p)); } catch { return false; }
}

async function transcribeRecordedAudioWithAliyun() {
    const audio = getRecordedAsrAudio();
    if (!audio || audio.length < ASR_TARGET_SAMPLE_RATE * 0.15) {
        console.warn('[ASR] 跳过阿里最终识别：录音太短或没有录到音频');
        return '';
    }

    const stats = getRecordedAsrStats();
    if (stats.rms < ASR_MIN_RMS || stats.activeRatio < ASR_MIN_ACTIVE_RATIO) {
        console.warn('[ASR] 跳过阿里最终识别：录音能量过低', stats);
        return '';
    }

    const asrApiKey = String(state.settings.asrApiKey || '').trim();
    if (!asrApiKey) throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写阿里百炼 ASR API Key');
    const asrUrl = String(state.settings.dashscopeAsrBaseUrl || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation').trim();
    const asrModel = String(state.settings.dashscopeAsrModel || 'qwen3-asr-flash').trim();
    // 流式（实时）模型走 WebSocket 实时接口，本应用是"录完整段 → 一次 HTTP"的非流式实现，调不了它。
    // 提前拦掉并给出人话，而不是把服务端的 "url error / format is empty" 原样抛给用户。
    if (/streaming/i.test(asrModel)) {
        throw new ClientApiError('ASR_STREAMING_UNSUPPORTED',
            '「' + asrModel + '」是实时流式模型（走 WebSocket），本应用的语音识别是非流式（录完整段再一次请求），无法调用。'
            + '请改用同系列的非流式模型：qwen-audio-3.0-asr-flash 或 qwen3-asr-flash。');
    }
    const startedAt = performance.now();
    const wavBase64 = float32ToWavBase64(audio, ASR_TARGET_SAMPLE_RATE);
    console.log(`[ASR] 阿里云识别开始: 音频 ${(audio.length / ASR_TARGET_SAMPLE_RATE).toFixed(1)}s, wav ${Math.round(wavBase64.length / 1024)}KB, 模型 ${asrModel}`);
    let result;
    try {
        result = await postJsonFromDevice(asrUrl, buildAliyunAsrRequestBody(asrModel, wavBase64), {
            Authorization: `Bearer ${asrApiKey}`,
            'X-DashScope-DataInspection': 'enable'
        }, { timeoutMs: ASR_CLOUD_FINAL_TIMEOUT_MS });
    } catch (error) {
        console.error('[ASR] 阿里云请求异常（网络/超时/CORS）:', error);
        throw error;
    }
    if (!result.ok) {
        // 音频里没有人声：3.x 系列回 400 ASR_RESPONSE_HAVE_NO_WORDS。这不是失败，是"确实没听到词"——
        // 按空结果返回即可，别把它当错误抛给用户（否则静音/环境音都会被报成"识别失败"）。
        if (isAsrNoWordsError(result)) {
            console.info('[ASR] 阿里百炼：音频里没有人声（模型如实报告无词）');
            return '';
        }
        await throwProviderResponseError(result, '阿里百炼语音识别失败');
    }
    const content = result.payload?.choices?.[0]?.message?.content ?? result.payload?.output?.text;
    const text = Array.isArray(content) ? content.map(part => part?.text || '').join(' ') : String(content || '');
    console.info(`[ASR] 阿里百炼完成: ${Math.round(performance.now() - startedAt)}ms, 识别文本="${text.slice(0, 50)}"`);
    return text.trim();
}

// 小米 MiMo-V2.5-ASR：OpenAI 兼容 /v1/chat/completions + input_audio（wav/mp3）
// 请求头认证：api-key: $MIMO_API_KEY（或 Authorization: Bearer）
async function transcribeRecordedAudioWithMimo() {
    const audio = getRecordedAsrAudio();
    if (!audio || audio.length < ASR_TARGET_SAMPLE_RATE * 0.15) {
        console.warn('[ASR] 跳过 MiMo 识别：录音太短或没有录到音频');
        return '';
    }
    const stats = getRecordedAsrStats();
    if (stats.rms < ASR_MIN_RMS || stats.activeRatio < ASR_MIN_ACTIVE_RATIO) {
        console.warn('[ASR] 跳过 MiMo 识别：录音能量过低', stats);
        return '';
    }

    const mimoApiKey = String(state.settings.mimoApiKey || '').trim();
    if (!mimoApiKey) throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写小米 MiMo API Key');
    const baseUrl = String(state.settings.mimoBaseUrl || 'https://api.xiaomimimo.com').trim().replace(/\/+$/, '');
    const model = String(state.settings.mimoAsrModel || 'mimo-v2.5-asr').trim();
    const startedAt = performance.now();
    const wavBase64 = float32ToWavBase64(audio, ASR_TARGET_SAMPLE_RATE);
    console.log(`[ASR] 小米 MiMo 识别开始: 音频 ${(audio.length / ASR_TARGET_SAMPLE_RATE).toFixed(1)}s, wav ${Math.round(wavBase64.length / 1024)}KB, 模型 ${model}`);
    let result;
    try {
        result = await postJsonFromDevice(baseUrl + '/v1/chat/completions', {
            model,
            messages: [{
                role: 'user',
                content: [{
                    type: 'input_audio',
                    input_audio: {
                        data: `data:audio/wav;base64,${wavBase64}`,
                        format: 'wav'
                    }
                }]
            }],
            asr_options: { language: 'zh' },
            stream: false
        }, {
            'api-key': mimoApiKey,
            'Content-Type': 'application/json'
        }, { timeoutMs: ASR_CLOUD_FINAL_TIMEOUT_MS });
    } catch (error) {
        console.error('[ASR] 小米 MiMo 请求异常（网络/超时/CORS）:', error);
        throw error;
    }
    if (!result.ok) await throwProviderResponseError(result, '小米 MiMo 语音识别失败');
    const content = result.payload?.choices?.[0]?.message?.content ?? result.payload?.output?.text;
    const text = Array.isArray(content) ? content.map(part => part?.text || '').join(' ') : String(content || '');
    console.info(`[ASR] 小米 MiMo 完成: ${Math.round(performance.now() - startedAt)}ms, 识别文本="${text.slice(0, 50)}"`);
    return text.trim();
}

async function startBrowserRecognitionSession() {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('当前浏览器不支持语音采集');
    }
    // Chrome 内置的 webkitSpeechRecognition 需要连接 Google 语音服务。
    // 实测：在连不上 / 受限的网络环境下，它 start() 之后约 1 秒会把整个浏览器进程带崩
    // —— 是浏览器直接退出，不是标签页崩溃，前端既捕获不到也兜不住。
    // 所以这里一律不再启用内置识别做实时预览，统一走「本地录音 + 云端识别」。
    if (!canUseCloudFinalAsr()) {
        throw new Error('请先在「设置 → 模型 → 语音 → 语音识别」里选择「阿里百炼」或「小米 MiMo」并填写 API Key。浏览器内置识别需要访问 Google 服务，国内网络下不可用，且实测会导致整个浏览器崩溃，已停用。');
    }

    currentTranscript = '';
    resetRecordedAudio();
    asrEnding = false;
    asrReady = false;
    state.voiceState = 'listening';
    updateUI();
    elements.statusText.textContent = '正在聆听...';

    asrMediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        }
    });
    asrAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (asrAudioContext.state === 'suspended') {
        await asrAudioContext.resume();
    }
    asrSourceNode = asrAudioContext.createMediaStreamSource(asrMediaStream);
    asrProcessorNode = asrAudioContext.createScriptProcessor(4096, 1, 1);
    asrProcessorNode.onaudioprocess = (event) => {
        if (asrEnding) return;
        const input = event.inputBuffer.getChannelData(0);
        const samples = downsampleBuffer(input, asrAudioContext.sampleRate, ASR_TARGET_SAMPLE_RATE);
        rememberAsrAudio(samples);
    };
    asrSourceNode.connect(asrProcessorNode);
    const silentGain = asrAudioContext.createGain();
    silentGain.gain.value = 0;
    asrProcessorNode.connect(silentGain);
    silentGain.connect(asrAudioContext.destination);

    // 不启动内置识别（原因见本函数开头），只录音；点击麦克风结束后交给云端识别
    asrMode = 'cloud-final-only';
    asrReady = true;
    elements.statusText.textContent = '正在录音，点击麦克风结束后识别...';
}

function stopLocalAudioGraph() {
    if (asrProcessorNode) {
        asrProcessorNode.disconnect();
        asrProcessorNode.onaudioprocess = null;
        asrProcessorNode = null;
    }
    if (asrSourceNode) {
        asrSourceNode.disconnect();
        asrSourceNode = null;
    }
    if (asrMediaStream) {
        asrMediaStream.getTracks().forEach(track => track.stop());
        asrMediaStream = null;
    }
    if (asrAudioContext) {
        asrAudioContext.close().catch(() => {});
        asrAudioContext = null;
    }
}

function closeLocalAsr(sendCancel = false) {
    stopLocalAudioGraph();
    asrReady = false;
    asrEnding = false;
    resetRecordedAudio();
}

function handleMicClick() {
    if (state.notesMode || state.diaryMode) return;
    if (state.voiceState === 'idle') {
        startListening().catch(error => {
            console.error('[Voice] startListening failed:', error);
            state.voiceState = 'error';
            updateUI();
            showCustomAlert('语音识别启动失败: ' + error.message, '语音识别错误');
        });
    } else {
        endListening().catch(error => {
            console.error('[Voice] endListening failed:', error);
            state.voiceState = 'error';
            updateUI();
        });
    }
}

// 浏览器只在 https 或 localhost 下允许调用麦克风。当前是 http + 局域网 IP 时，
// 主动问一下要不要跳到 HTTPS 端口：用户不用记端口号，也不用自己把 http 改成 https。
async function offerHttpsSwitch() {
    var httpsPort = 0;
    try {
        const res = await fetch('/api/server-info');
        const json = await res.json();
        httpsPort = Number(json.httpsPort) || 0;
    } catch (e) { /* 拿不到就退回纯文字提示 */ }

    const target = httpsPort
        ? ('https://' + location.hostname + ':' + httpsPort + location.pathname + location.search)
        : '';
    const text = '语音输入必须用 HTTPS 打开。\n\n'
        + '浏览器只在 https 或 localhost 下允许调用麦克风，http + 局域网 IP 一定不行 —— '
        + '这是浏览器的硬性规定，没法绕过。\n\n'
        + (target
            ? '现在切换到：\n' + target + '\n\n首次打开会提示"连接不是私密连接"，点「高级」→「继续前往」即可。\n'
              + '（切换后可能需要重新输一次访问密码）'
            : '请在电脑上启动服务后，用控制台打印的 https:// 地址打开。');

    if (target) {
        if (window.confirm(text)) location.href = target;
        return;
    }
    showCustomAlert(text, '语音识别不可用');
}

async function startListening() {
    if (asrSubmitting || asrStarting) {
        console.log('[ASR] 忽略重复 startListening 调用');
        return;
    }
    asrStarting = true;
    asrSessionId++;
    clearVoiceTimers();
    currentTranscript = '';

    // 非安全上下文（非 https/localhost）：浏览器直接禁用麦克风，前端无法绕过。
    // 不弹一长串说明，直接问用户要不要切到 HTTPS —— 免得他记端口、自己改协议。
    if (window.isSecureContext === false) {
        asrStarting = false;
        void offerHttpsSwitch();
        return;
    }
    // 浏览器内置识别（webkitSpeechRecognition）要连 Google 语音服务，连不上时会把整个
    // 浏览器进程带崩，已停用。所以这里只认云端识别。
    if (!canUseCloudFinalAsr()) {
        asrStarting = false;
        showCustomAlert('语音识别需要先配置云端服务：\n\n设置 → 模型 → 语音 → 语音识别，选「阿里百炼」或「小米 MiMo」，填入 API Key。\n\n（浏览器内置识别需要访问 Google 服务，国内网络下不可用，且实测会导致整个浏览器崩溃，已停用。）', '语音识别不可用');
        return;
    }

    try {
        await startBrowserRecognitionSession();
    } catch (error) {
        console.error('[ASR] 浏览器实时预览启动失败', error);
        state.voiceState = 'error';
        updateUI();
        const msg = String(error?.message || error?.name || error || '');
        if (/already started/i.test(msg)) {
            showCustomAlert('语音识别引擎状态冲突（连续启动）。\n已自动重置重试仍失败，请稍候片刻再试；若频繁出现请刷新页面（Ctrl+F5）。', '语音识别错误');
        } else {
            showCustomAlert('语音识别启动失败: ' + error.message, '语音识别错误');
        }
    } finally {
        asrStarting = false;
    }
}

async function endListening() {
    if (asrSubmitting) {
        console.log('[ASR] 忽略重复 endListening 调用');
        return;
    }
    asrSubmitting = true;
    clearVoiceTimers();
    asrEnding = true;
    const fallbackTranscript = currentTranscript.trim();
    let finalText = fallbackTranscript;
    const activeMode = asrMode;
    asrMode = 'submitting';
    state.voiceState = 'thinking';
    updateUI();

    try {
        if (isLocalAudioAsrMode(activeMode)) {
            stopLocalAudioGraph();
            if (browserRecognition && activeMode !== 'cloud-final-only') {
                asrRecognitionActive = false; // 提前同步标志，防止 stop→onend 窗口期残留
                try {
                    browserRecognition.stop();
                } catch (e) {
                    console.error('Failed to stop recognition:', e);
                }
            }
            if (canUseCloudFinalAsr()) {
                elements.statusText.textContent = (state.settings.asrProvider === 'mimo' ? '正在用小米 MiMo 识别...' : '正在用阿里百炼识别...');
                try {
                    const cloudText = await transcribeRecordedAudioWithCloud();
                    if (cloudText && !isBadCloudFinalText(cloudText, fallbackTranscript)) {
                        finalText = cloudText;
                        cloudFinalAsrAvailable = true;
                    } else {
                        console.warn('[ASR] 云端识别返回空或疑似无效文本，保留浏览器识别结果', {
                            cloudText: String(cloudText || '').slice(0, 100),
                            fallbackTranscript: String(fallbackTranscript || '').slice(0, 100),
                            provider: state.settings.asrProvider
                        });
                    }
                } catch (error) {
                    console.error('[ASR] 云端识别失败，保留浏览器识别结果：', {
                        provider: state.settings.asrProvider,
                        code: error?.code,
                        status: error?.status,
                        message: error?.message || String(error)
                    });
                    if (!fallbackTranscript) showClientApiError(error);
                }
            }
            resetRecordedAudio();
        } else if (browserRecognition) {
            try {
                browserRecognition.stop();
            } catch (e) {
                console.error('Failed to stop recognition:', e);
            }
            finalText = currentTranscript.trim();
        }

        const text = finalText.trim();
        currentTranscript = '';

        if (text) {
            processVoiceInput(text);
        } else {
            state.voiceState = 'idle';
            updateUI();
            if (activeMode === 'cloud-final-only' || activeMode === 'browser-session' || activeMode === 'browser-cloud-final') {
                elements.statusText.textContent = '没有识别到清晰语音，请重试';
            }
        }
    } finally {
        asrEnding = false;
        asrSubmitting = false;
        if (state.voiceState === 'idle' || state.voiceState === 'thinking') {
            asrMode = canUseCloudFinalAsr() ? 'cloud-final-only' : 'browser';
        }
    }
}

function cancelListening() {
    if (asrSubmitting) {
        console.log('[ASR] 忽略提交中的取消操作');
        return;
    }
    clearVoiceTimers();
    currentTranscript = '';
    if (isLocalAudioAsrMode()) {
        closeLocalAsr(true);
    } else if (browserRecognition) {
        try {
            browserRecognition.stop();
        } catch (e) {
            console.error('Failed to stop recognition:', e);
        }
    }
    state.voiceState = 'idle';
    updateUI();
}



