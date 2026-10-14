/* ========================================================================
 * 语音：识别 / 输入处理 / 停止按钮 / TTS
 *
 * 本文件由 web/index.html 的主脚本按分区拆分而来（保持原始加载顺序）。
 * 拆分前提：主脚本是全局作用域，拆分后各文件共享同一全局词法环境，
 * 因此顶层 function / const / let 互相可见，调用点无需修改。
 *
 * 包含分区：
 *   · 语音识别
 *   · 输入处理
 *   · AI 输出中的「停止」按钮
 *   · TTS（多服务商：MiMo / MiniMax / 千问 / 通用 OpenAI）
 * ======================================================================== */

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

// 语音识别仅支持 Chrome 等 Chromium 内核浏览器（Firefox/Safari 无此 API）
function isChromiumBrowser() {
    try {
        const ua = String(navigator.userAgent || '');
        if (/Chrome|Chromium|Edg|CriOS/i.test(ua)) return true;
        const data = navigator.userAgentData;
        if (data && Array.isArray(data.brands)) {
            return data.brands.some(b => /Chromium/i.test(String(b.brand || '')));
        }
    } catch { /* ignore */ }
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
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 两个中止来源要**都**接上：内部超时用 controller，
    // 外部（用户点「停止」/ 流式回退）用调用方传进来的 signal。
    // 以前只认 options.signal —— 而 options 里的 signal 会被下面
    // `{ ...options, signal: controller.signal }` 覆盖掉，等于外部信号从来没生效过，
    // 「停止」按钮按了请求还在跑。所以这里显式收第 4 个参数，不再从 options 里摸。
    const externalSignal = signal || options?.signal;
    const abortFromExternal = () => controller.abort();
    if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
    try {
        return await fetch(url, { ...options, signal: controller.signal });
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
 * 组装阿里百炼 ASR 的请求体 —— **形状随模型家族而变**（2026-10 补）。
 *
 * 踩过的坑：应用原先只有 qwen3-asr-flash 一种形状（content 写 { audio: … }、
 * parameters 写 asr_options）。换成同门的 qwen-audio-3.x-asr-flash 后，服务端直接回
 * 400「format is empty」—— 因为那一族要求：
 *   ① content 项必须带 type:'input_audio' + input_audio.data（不是 { audio }）；
 *   ② parameters 里 **format 必填**（音频格式 wav/mp3/opus…）。
 * 两种形状互不兼容，用错就是 400，而不是"模型不存在"这类好懂的错。
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
        }, ASR_CLOUD_FINAL_TIMEOUT_MS);
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
        }, ASR_CLOUD_FINAL_TIMEOUT_MS);
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

function stopListening() {
    if (isLocalAudioAsrMode()) {
        closeLocalAsr(true);
        return;
    }
    if (browserRecognition) {
        try {
            browserRecognition.stop();
        } catch (e) {
            console.error('Failed to stop recognition:', e);
        }
    }
}


// ==================== 输入处理 ====================

const recentSubmitKeys = new Map();
const activeReplyTasks = new Set();
const MAX_COMPOSER_IMAGE_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_COMPOSER_IMAGE_DATA_URL_CHARS = 900000;
let pendingComposerImage = null;
let composerImageProcessing = false;

function isSafeComposerImageDataUrl(value) {
    return /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(String(value || ''));
}

function renderPendingComposerImage() {
    const previews = [elements.initialComposerImagePreview, elements.composerImagePreview].filter(Boolean);
    previews.forEach(preview => {
        if (!pendingComposerImage || !isSafeComposerImageDataUrl(pendingComposerImage.dataUrl)) {
            preview.classList.add('hidden');
            preview.replaceChildren();
            return;
        }
        const image = document.createElement('img');
        image.src = pendingComposerImage.dataUrl;
        image.alt = pendingComposerImage.name || '待发送图片';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'composer-image-remove';
        remove.setAttribute('aria-label', '移除图片');
        remove.textContent = '×';
        remove.addEventListener('click', removePendingComposerImage);
        preview.replaceChildren(image, remove);
        preview.classList.remove('hidden');
    });
    updateComposerSendVisibility();
}

function removePendingComposerImage() {
    pendingComposerImage = null;
    if (elements.composerImageInput) elements.composerImageInput.value = '';
    renderPendingComposerImage();
}

function readImageFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('图片读取失败'));
        reader.readAsDataURL(file);
    });
}

function loadComposerImage(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('无法解析这张图片'));
        image.src = dataUrl;
    });
}

async function compressComposerImage(file) {
    if (!file || !String(file.type || '').startsWith('image/')) throw new Error('请选择图片文件');
    if (file.size > MAX_COMPOSER_IMAGE_SOURCE_BYTES) throw new Error('图片不能超过 12 MB');
    const source = await readImageFileAsDataUrl(file);
    const image = await loadComposerImage(source);
    let maxDimension = 1280;
    const qualities = [0.84, 0.76, 0.68, 0.58];
    for (const quality of qualities) {
        const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.length <= MAX_COMPOSER_IMAGE_DATA_URL_CHARS) {
            const previewScale = Math.min(1, 360 / Math.max(image.naturalWidth, image.naturalHeight));
            const previewWidth = Math.max(1, Math.round(image.naturalWidth * previewScale));
            const previewHeight = Math.max(1, Math.round(image.naturalHeight * previewScale));
            const previewCanvas = document.createElement('canvas');
            previewCanvas.width = previewWidth;
            previewCanvas.height = previewHeight;
            const previewContext = previewCanvas.getContext('2d');
            previewContext.fillStyle = '#ffffff';
            previewContext.fillRect(0, 0, previewWidth, previewHeight);
            previewContext.drawImage(image, 0, 0, previewWidth, previewHeight);
            return {
                dataUrl,
                previewDataUrl: previewCanvas.toDataURL('image/jpeg', 0.72),
                name: file.name || 'image.jpg',
                width,
                height
            };
        }
        maxDimension = Math.max(720, Math.round(maxDimension * 0.82));
    }
    throw new Error('图片压缩后仍然过大，请选择尺寸更小的图片');
}

function openComposerImagePicker() {
    closeComposerToolsMenu();
    if (!elements.composerImageInput) return;
    elements.composerImageInput.value = '';
    elements.composerImageInput.click();
}

function consumePendingComposerImage() {
    const image = pendingComposerImage;
    pendingComposerImage = null;
    if (elements.composerImageInput) elements.composerImageInput.value = '';
    renderPendingComposerImage();
    return image;
}

function attachComposerImageToMessage(message, image) {
    if (!image || !isSafeComposerImageDataUrl(image.dataUrl)) return message;
    message.imageDataUrl = isSafeComposerImageDataUrl(image.previewDataUrl) ? image.previewDataUrl : image.dataUrl;
    message.imageName = image.name || '';
    Object.defineProperty(message, 'imageRequestDataUrl', {
        value: image.dataUrl,
        configurable: true,
        enumerable: false
    });
    return message;
}

function claimMessageSubmission(text, channel = 'text') {
    const key = `${channel}:${String(text || '').trim()}`;
    const now = Date.now();
    const previous = recentSubmitKeys.get(key) || 0;
    if (now - previous < 900) return false;
    recentSubmitKeys.set(key, now);
    setTimeout(() => {
        if ((recentSubmitKeys.get(key) || 0) === now) recentSubmitKeys.delete(key);
    }, 1200);
    return true;
}

function setSendButtonVisibility(button, visible) {
    if (!button) return;
    button.classList.toggle('is-hidden', !visible);
    button.setAttribute('aria-hidden', visible ? 'false' : 'true');
    button.tabIndex = visible ? 0 : -1;
}

function updateComposerSendVisibility() {
    const hasContent = Boolean(pendingComposerImage);
    // AI 回复期间按钮必须**始终可见**（此时它是「停止」），不能因为输入框空了就缩回去
    const busy = activeReplyAborts.size > 0;
    setSendButtonVisibility(elements.initialSendBtn, busy || Boolean(elements.initialTextInput.value.trim()) || hasContent);
    setSendButtonVisibility(elements.conversationSendBtn, busy || Boolean(elements.textInput.value.trim()) || hasContent);
    // busy 态把按钮渲染成红色停止（见 .is-stopping 的样式），并换掉图标
    elements.initialSendBtn?.classList.toggle('is-stopping', busy);
    elements.conversationSendBtn?.classList.toggle('is-stopping', busy);
    swapStopIcons(elements.initialSendBtn, busy);
    swapStopIcons(elements.conversationSendBtn, busy);
    elements.initialSendBtn.disabled = composerImageProcessing;
    elements.conversationSendBtn.disabled = composerImageProcessing;
    elements.initialSendBtn.setAttribute('aria-busy', composerImageProcessing ? 'true' : 'false');
    elements.conversationSendBtn.setAttribute('aria-busy', composerImageProcessing ? 'true' : 'false');
    if (busy) {
        elements.initialSendBtn.title = '停止生成';
        elements.conversationSendBtn.title = '停止生成';
    } else {
        elements.initialSendBtn.title = '发送';
        elements.conversationSendBtn.title = '发送';
    }
}

/**
 * 切换按钮形态（DSH 式）：**同一个图标槽**，回复中整键变暂停。
 *
 * 发送态 = 右箭头（纸飞机太花，DSH 用的就是箭头）；回复中 = 两条竖杠（暂停）。
 * 颜色不另外变 —— 按钮本来就是主色调（btn-primary），暂停时只是图标换成暂停，
 * 不像上一版那样突兀地整键变红。
 */
const COMPOSER_ARROW_SVG = '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M5 12h13M13 6l6 6-6 6"/>';
const COMPOSER_PAUSE_SVG = '<rect fill="currentColor" x="7" y="5.5" width="3.6" height="13" rx="1.2"/><rect fill="currentColor" x="13.4" y="5.5" width="3.6" height="13" rx="1.2"/>';
function swapStopIcons(button, busy) {
    if (!button) return;
    const icon = button.querySelector('.composer-state-icon');
    if (icon) icon.innerHTML = busy ? COMPOSER_PAUSE_SVG : COMPOSER_ARROW_SVG;
    const label = button.querySelector('.send-label');
    if (label) label.textContent = busy ? '停止' : '发送';
    button.title = busy ? '停止生成' : '发送';
    button.setAttribute('aria-label', button.title);
}

function closeComposerToolsMenu() {
    [
        [elements.initialComposerMoreBtn, elements.initialComposerMoreMenu],
        [elements.composerMoreBtn, elements.composerMoreMenu]
    ].forEach(([button, menu]) => {
        if (!button || !menu) return;
        menu.classList.add('hidden');
        button.setAttribute('aria-expanded', 'false');
    });
}

// toggle 参数已经没用了：思考开关搬去「设置 → 模型」，这里不再需要
// 打开菜单时回填勾选状态。保留参数是为了不改动两处调用点。
function toggleComposerToolsMenu(button, menu) {
    const opening = menu.classList.contains('hidden');
    closeComposerToolsMenu();
    if (opening) {
        menu.classList.remove('hidden');
        button.setAttribute('aria-expanded', 'true');
    }
}

/**
 * 把「设置 → 模型」里的思考开关与强度同步成当前设置值。
 *
 * 以前这里同步的是输入框旁边那个 ⊕ 菜单里的勾选框。开关搬走之后，
 * 仍然保留这个函数：设置面板每次打开都要按 state 回填，
 * 而回填逻辑只该有一处 —— 散在各处必然有一天忘记同步新加的档位。
 */
function syncThinkingModeControls() {
    const toggle = elements.settingThinkingMode;
    if (toggle) toggle.checked = Boolean(state.settings.thinkingMode);
    const effort = elements.settingThinkingEffort;
    if (effort) effort.value = THINKING_EFFORTS.includes(state.settings.thinkingEffort)
        ? state.settings.thinkingEffort
        : 'medium';
    // 第三人称（两段式生成）：与思考开关同属「对话优化」块，一并回填。
    const thirdPerson = elements.settingThirdPerson;
    if (thirdPerson) thirdPerson.checked = Boolean(state.settings.thirdPerson);
    updateThinkingModeHint();
}

/**
 * 思考强度的说明文案：告诉用户**当前这个模型实际会收到什么**。
 *
 * 为什么要动态生成而不是写死一句：三种协议、四家厂商对"强度"的支持完全不同
 * （DeepSeek 只有 low/high/max，OpenAI 的 Responses 根本没有"关闭"这个取值，
 * Anthropic 的 reasoning.effort 又是另一套名字）。用户选了「中」却发现没有任何
 * 变化时，会以为功能坏了 —— 把"这一档对当前服务商意味着什么"直接写出来，
 * 比事后解释省事得多。
 */
function updateThinkingModeHint() {
    const hint = elements.thinkingModeHint;
    if (!hint) return;
    if (!state.settings.thinkingMode) {
        hint.textContent = '当前已关闭：请求会显式告诉服务商不要思考（DeepSeek 服务端默认是开启的，所以必须显式关闭）。';
        return;
    }
    const effort = THINKING_EFFORTS.includes(state.settings.thinkingEffort) ? state.settings.thinkingEffort : 'medium';
    if (effort === 'medium') {
        hint.textContent = '「中」= 不指定强度，由服务商自己决定（DeepSeek 默认 high，OpenAI 默认 medium）。想固定行为就选低或高。';
        return;
    }
    hint.textContent = `当前会向服务商请求「${effort === 'low' ? '低' : '高'}」强度；不支持该档位的服务商会忽略它。思考过程不影响工具调用记录，两者都会显示。`;
}

// ========================================================================
//  流式正文预览
// ========================================================================
//
// 为什么需要"预览"这一层，而不是边收边往最终气泡里写：
// 回复完成后还要做几件事 —— Live2D 标签剥离、[任务:…] 抽取、
// 日语朗读稿拆分。这些都必须作用在**完整文本**上。
// 如果流式期间就把增量写进最终消息对象，那些处理会在"半截文本"上跑一遍，
// 结果就是标签被切开、朗读稿只译了前半句。
// 所以流式只负责"让用户先看见"，最终内容走原来的完整路径，两者不交叉。

let streamedReplyText = '';
let streamingPreviewEl = null;
let streamingPreviewScheduled = false;
// ★ 打字机式渐进显示：已经"吐"给预览气泡的字符数（见 renderStreamingReplyPreview）。
//   它**只作用于流式预览气泡**；回复结束的正式渲染用 streamedReplyText 的完整文本，
//   与本计数无关 —— 千万别拿它去截断最终正文。
let revealedCount = 0;

function resetStreamingReplyPreview() {
    streamedReplyText = '';
    streamingPreviewEl = null;
    streamingPreviewScheduled = false;
    // 会话结束 / 预览被移除时归零，下一轮从空白重新"打字"
    revealedCount = 0;
}

/** 每帧最多重绘一次：流式一次回复有上千个增量，逐个重排会明显卡顿 */
function scheduleStreamingReplyRender() {
    if (streamingPreviewScheduled) return;
    streamingPreviewScheduled = true;
    const run = () => {
        streamingPreviewScheduled = false;
        renderStreamingReplyPreview();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
}

/**
 * 流式预览的**净化**：把协议标签从半截文本里去掉。
 *
 * 为什么必须在流式这一层做：增量是**按字节流切**的，标签会被切成好几段
 * （`[情绪:开` → `心]`），而正式的 `ElainaTags.strip()` 只在**完整文本**上跑一次。
 * 不净化的话，用户会眼睁睁看着 `[操作:保存文件 D:\x.txt]`、`<voice_jp>…</voice_jp>`
 * 这些内部协议在气泡里滚过去 —— 最终正文里它们虽然会被剥掉，但"正在输入"的
 * 那几秒已经把它们露完了。
 *
 * ★ 这里刻意**容错半截标签**：正在流入的 `<voice_jp>` 还没闭合时也要藏起来，
 *   否则朗读稿（日语翻译）会先于正文显示出来。
 */
function sanitizeStreamingPreviewText(text) {
    let out = String(text || '');
    // ① 完整标签：复用宿主那份权威实现（标签名清单只有一处，不会走样）
    if (window.ElainaTags && typeof window.ElainaTags.strip === 'function') {
        out = window.ElainaTags.strip(out);
    } else {
        out = out.replace(/\[(表情|动作|情绪|位置|大小|背景|操作|任务)[:：][^\]]*\]/g, '');
    }
    // ② <voice_jp>…</voice_jp>：已闭合的整段去掉
    out = out.replace(/<voice_jp>[\s\S]*?<\/voice_jp>/gi, '');
    // ③ 还没闭合的朗读稿（正在流入）：从开标签起全部藏起
    out = out.replace(/<voice_jp>[\s\S]*$/i, '');
    // ④ <scene>…</scene> 背景标签，同样处理闭合与半截两种情况
    out = out.replace(/<scene>[^<\n]*<\/scene>/gi, '');
    out = out.replace(/<scene>[^<\n]*$/i, '');
    // ⑤ 半截的方括号标签（`[情绪:开`）：只认已知标签名，避免误删正文里的普通 `[`
    out = out.replace(/\[(?:表情|动作|情绪|位置|大小|背景|操作|任务)[:：][^\]]*$/g, '');
    return out;
}

function renderStreamingReplyPreview() {
    if (!elements.conversationHistory) return;
    // ★ 用净化后的文本决定"有没有正文"：只有标签 / 只有朗读稿时**不能**收掉
    //   三点气泡 —— 否则会出现"气泡没了、正文也没来"的空窗。
    const text = sanitizeStreamingPreviewText(streamedReplyText);
    if (!text) return;
    // 正文来了 → 收掉三点气泡。留着会变成"三点 + 正文"两个气泡。
    removeThinkingMessage();
    if (!streamingPreviewEl) {
        streamingPreviewEl = document.createElement('div');
        streamingPreviewEl.id = 'streaming-reply-preview';
        streamingPreviewEl.className = 'flex gap-3 mb-4';
        streamingPreviewEl.innerHTML = `
            <div class="pixso-chat-avatar" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="12" r="2.7"/>
                    <circle cx="5.5" cy="12" r="3.2"/>
                    <circle cx="18.5" cy="12" r="3.2"/>
                    <circle cx="12" cy="5.5" r="3.2"/>
                    <circle cx="12" cy="18.5" r="3.2"/>
                </svg>
            </div>
            <div class="flex-1 min-w-0">
                <div class="bubble-ai rounded-2xl p-4">
                    <div class="flex items-center gap-2 mb-2">
                        <span class="ai-speaker-name">${escapeHtml(state.characterCard?.name || '伊蕾娜')}</span>
                        <span class="text-xs text-indigo-300">正在输入…</span>
                    </div>
                    <p class="text-indigo-950 text-sm leading-relaxed whitespace-pre-wrap" id="streaming-reply-text"></p>
                </div>
            </div>
        `;
        elements.conversationHistory.appendChild(streamingPreviewEl);
    }
    const target = streamingPreviewEl.querySelector('#streaming-reply-text');
    // ★ 流式期间用 **textContent 纯文本**，不用 renderMessageText 的 markdown 渲染
    //   （2026-09 修"流式闪烁/看不见内容"）：
    //   ① renderMessageText 每帧对**不断增长的文本**做完整 markdown 解析
    //      （正则扫描 + marked.parse），越到后面越贵，主线程被塞满，
    //      后续增量排队、渲染卡顿 —— 看起来就是"时不时闪一下"。
    //   ② 半截 markdown（未闭合的 **、```、表格竖线）每帧解析出的 HTML 都不同，
    //      气泡高度疯狂跳动，视觉上内容"闪没又冒出来"。
    //   纯文本 + whitespace-pre-wrap 的观感已经足够流畅（用户就是要"先看见"），
    //   完整的富文本渲染只在回复完成时做一次（下面的正式渲染路径）。
    //   顺带去掉了预览容器的 animate-fade-in-up —— 每次会话它只创建一次，
    //   动画本身无害，但创建时机与 thinking 气泡的 200ms 淡出重叠时会叠影。
    //
    // ★★ 2026-10 打字机式渐进显示（修"快模型上不是逐字、而是一句一句蹦"）：
    //   text 是模型**已吐出的累计文本**（目标）；若直接整段写进去，模型吐多快就一次
    //   显示多少 —— 快模型一次返回一大句，看起来就是"一句一句蹦出来"。
    //   改成每帧只多显示一段，让观感回到逐字：
    //     · 每帧前进 max(1, 剩余/8) —— 落后越多追得越快：既顺滑（不会一格一格跳），
    //       又能追上模型（差额收敛到 0，不会越积越多直到结束时还剩一大截没显示）。
    //     · 只要还没显示完就再排下一帧，复用同一套 schedule（不新开第二套调度）。
    //   ★ 最终正式渲染（removeStreamingReplyPreview + renderMessage）用的是完整文本，
    //     不经过这里，绝不会被 revealedCount 截断。
    const step = Math.max(1, Math.ceil((text.length - revealedCount) / 8));
    // ★ 净化会让文本**变短**（标签被剥掉）：此时 revealedCount 可能已经超过
    //   text.length，必须夹回来 —— 否则 slice 结果正常、但 revealedCount > length
    //   会让下面的 `revealedCount < text.length` 恒假、或让后续帧算出负的差额。
    revealedCount = Math.min(revealedCount, text.length);
    revealedCount = Math.min(text.length, revealedCount + step);
    if (target) target.textContent = text.slice(0, revealedCount);
    elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
    if (revealedCount < text.length) scheduleStreamingReplyRender();
}

function removeStreamingReplyPreview() {
    const el = streamingPreviewEl || document.getElementById('streaming-reply-preview');
    if (el) el.remove();
    resetStreamingReplyPreview();
}

/**
 * 把「停止」按钮的中断器接到 fetch 上。
 *
 * 这里原本有个真 bug：providers 用 6 个参数调 postJsonFromDevice
 * （`..., undefined, undefined, opts.signal`），但那个函数只声明了 5 个形参
 * （url, body, headers, timeoutMs, signal）—— 第 6 个实参被静默丢弃，
 * 于是 signal 从来没生效过，「停止」按了请求还在跑。
 * 现在请求统一走 requestChatJson，它显式收 opts.signal 并往下传。
 */
function processVoiceInput(text) {
    if (composerImageProcessing) return;
    if (!text.trim()) return;
    if (!claimMessageSubmission(text, 'voice')) return;

    if (state.conversations.length === 0 || !state.currentConversationId) {
        elements.initialState.classList.add('hidden');
        createConversation();
    }

    const conversation = state.conversations.find(c => c.id === state.currentConversationId);
    if (!conversation) return;

    const image = consumePendingComposerImage();
    const message = attachComposerImageToMessage({
        id: generateId(),
        role: 'user',
        text: text,
        timestamp: new Date().toLocaleTimeString()
    }, image);

    conversation.messages.push(message);

    state.thinkingMessageId = message.id;

    loadConversation(conversation.id);

    if (conversation.messages.length === 1) {
        conversation.title = autoNameConversation(conversation.messages);
        renderFolderList();
        updateCurrentConversationTitle();
    }

    state.voiceState = 'thinking';
    updateUI();

    handleUserInput(message, conversation);
}

function handleInitialTextSubmit() {
    if (composerImageProcessing) return;
    if (state.notesMode || state.diaryMode) return;
    const text = document.getElementById('initialTextInput').value.trim();
    const image = pendingComposerImage;
    if (!text && !image) return;
    if (!claimMessageSubmission(text || image.dataUrl.slice(-96), 'text')) return;
    closeComposerToolsMenu();

    let conversation = state.conversations.find(c => c.id === state.currentConversationId);
    if (!conversation) {
        elements.initialState.classList.add('hidden');
        createConversation();
        conversation = state.conversations[0];
    }

    const message = attachComposerImageToMessage({
        id: generateId(),
        role: 'user',
        text: text,
        timestamp: new Date().toLocaleTimeString()
    }, image);

    conversation.messages.push(message);
    consumePendingComposerImage();
    document.getElementById('initialTextInput').value = '';
    updateComposerSendVisibility();
    loadConversation(conversation.id);

    if (conversation.messages.length === 1) {
        conversation.title = autoNameConversation(conversation.messages);
        renderFolderList();
        updateCurrentConversationTitle();
    }

    state.voiceState = 'thinking';
    updateUI();

    handleUserInput(message, conversation);
}

/**
 * 发送/停止按钮的统一入口（DSH 式二态）：
 *   · AI 正在回复 → 停止（无论输入框有没有内容，按钮此时必须可见）
 *   · 否则 → 原本的发送
 */
function handleComposerButtonClick() {
    if (activeReplyAborts.size > 0) { stopAiReply(); return; }
    // 没在回复中 → 原来的发送行为
    if (typeof handleTextSubmit === 'function' && !elements.initialState || (elements.initialState && elements.initialState.classList.contains('hidden'))) {
        handleTextSubmit();
    } else {
        handleInitialTextSubmit();
    }
}

function handleTextSubmit() {
    if (composerImageProcessing) return;
    if (state.notesMode || state.diaryMode) return;
    const text = elements.textInput.value.trim();
    const image = pendingComposerImage;
    if (!text && !image) return;
    if (!claimMessageSubmission(text || image.dataUrl.slice(-96), 'text')) return;
    closeComposerToolsMenu();
    let conversation = state.conversations.find(c => c.id === state.currentConversationId);
    if (!conversation) {
        elements.initialState.classList.add('hidden');
        createConversation();
        conversation = state.conversations[0];
    }

    const message = attachComposerImageToMessage({
        id: generateId(),
        role: 'user',
        text: text,
        timestamp: new Date().toLocaleTimeString()
    }, image);

    conversation.messages.push(message);
    consumePendingComposerImage();

    state.thinkingMessageId = message.id;

    loadConversation(conversation.id);

    if (conversation.messages.length === 1) {
        conversation.title = autoNameConversation(conversation.messages);
        renderFolderList();
        updateCurrentConversationTitle();
    }

    state.voiceState = 'thinking';
    updateUI();

    handleUserInput(message, conversation);
    elements.textInput.value = '';
    updateComposerSendVisibility();
}

function isTtsConfigured(settings = state.settings) {
    const provider = String(settings.ttsProvider || 'mimo');
    // MiMo TTS 是**付费 API Key** 服务商（用 TTS 独立的 mimoTtsApiKey），没有 Key 不能用
    if (provider === 'mimo') {
        if (!String(settings.mimoTtsApiKey || '').trim()) return false;
        // v2.5 三个模型必需的"音色"来源不同：预置音色 / 音色描述 / 参考音频样本
        const model = String(settings.mimoTtsModel || 'mimo-v2.5-tts').trim();
        if (model === 'mimo-v2.5-tts-voiceclone') return Boolean(String(settings.mimoTtsCloneSample || '').trim());
        if (model === 'mimo-v2.5-tts-voicedesign') return Boolean(String(settings.mimoTtsVoiceDesignPrompt || '').trim());
        return Boolean(String(settings.mimoTtsVoice || '').trim());
    }
    // 通用 OpenAI TTS 同样必须填 Key
    if (provider === 'openai-tts') {
        return Boolean(String(settings.openaiTtsApiKey || '').trim());
    }
    if (provider === 'dashscope') {
        return Boolean(String(settings.dashscopeApiKey || '').trim() && String(settings.dashscopeTtsVoice || '').trim());
    }
    return Boolean(String(settings.minimaxApiKey || '').trim() && String(settings.minimaxVoice || '').trim());
}

async function handleUserInput(message, conversation) {
    if (!conversation) {
        conversation = state.conversations.find(c => c.id === state.currentConversationId);
    }
    if (!conversation) return;
    // 自然语言**不再**直接触发文件操作。
    //
    // 原实现（maybeAutoFileWrite）会在把消息发给 AI **之前**做正则匹配，
    // 命中「写入/保存 + 文件/盘/D:\/.txt」就直接执行 —— 也就是**用户打的字本身
    // 就是触发源，与 AI 无关**。这带来三个问题：
    //   1. 绕过 AI：AI 全程不知情，对话里只有一条「【AI 操作结果】」；
    //   2. 正则误伤：聊到 `D:\...` 这种写法就可能被当成指令；
    //   3. 与授权脱节：写文件会弹确认框，但读/列目录不会 —— 用户感觉"我就说句话它怎么动了"。
    //
    // 现在一律交给 AI 判断：由它决定要不要输出 [操作:…] 标签，
    // 行为可预测、AI 全程知情、也走同一条「停止 + 授权」管线。
    // （maybeAutoExpression 保留：它只驱动 Live2D 表情，不碰文件与系统。）
    maybeAutoExpression(String(message?.text || ''));
    const replyTaskKey = `${conversation.id}:${message.id}`;
    if (activeReplyTasks.has(replyTaskKey)) {
        console.log('[Chat] 忽略同一条用户消息的重复回复任务');
        return;
    }
    // ★ 本轮回复的中断器：请求层与"输出中"的停止按钮都挂在这里。
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
            //
            // ★ 两段式（第三人称）时，chunk 上会带 `phase`：
            //   第 1 段的思考（GM 的推理）与第 2 段的思考（改写时的推理）
            //   分别进时间线、互不混合 —— 见 appendTurnReasoning。
            //   只有第 2 段的**正文**才进气泡（第 1 段正文是隐藏的中间产物，
            //   由 data 层拦住，不会走到这里）。
            onDelta: (chunk) => {
                if (chunk.kind === 'reasoning') { appendTurnReasoning(chunk.text, chunk.phase); return; }
                if (chunk.kind !== 'text') return;
                streamedReplyText += chunk.text;
                scheduleStreamingReplyRender();
            },
            // 两段式生成的**阶段输出**：第一段（GM 叙述）与第二段（第一人称正文）
            // 各存一条，用户可以在过程区里分别展开对照。
            onPhase: (phase) => { recordTurnPhase(phase); }
        };
        const rawResponse = await callAI(message.text, aiRequestOptions);
        const parsedReply = wantsJp ? splitVoiceReply(rawResponse) : { displayText: rawResponse, voiceJp: '' };
        const response = parsedReply.displayText;
        // ★★ 2026-10：**不要**在这里无条件收掉流式预览。
        //
        //   同步模式（simultaneous）下正文要等语音真正开播才提交，而 TTS 生成
        //   本身要等好几秒 —— 旧代码在这里就把预览拆了，于是那几秒屏幕上
        //   **一片空白**（三点气泡早在第一个增量到达时就被预览顶掉了），
        //   用户看到的是"字打完 → 消失 → 等 → 又出现"。
        //   现在交给 commitAiMessageOnce 在渲染正式消息前收（见下），
        //   预览正好无缝交接给正式气泡。
        finishTurnTrace();

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
        //
        // ★ 走宿主的 ElainaTags，**不再**经过 window.Live2DCall ——
        //   旧写法是 `if (window.Live2DCall) { drive(); stripTags(); }`，
        //   而 drive() 是全部 [操作:] 标签的唯一分发器（文件/命令/手机/记忆）。
        //   于是"Live2D 不在"就等于"整个 Agent 系统失效 + 标签漏给用户看"。
        //   现在剥离与分发都归宿主，Live2D 只提供表现（表情/动作/口型）。
        if (window.ElainaTags) {
            window.ElainaTags.drive(response);
            const stripped = window.ElainaTags.strip(response);
            if (stripped !== response) aiMessage.text = stripped;
        }
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
            // ★ 正式气泡就位前收掉流式预览 —— 顺序不能反：先 renderMessage 再收，
            //   中间那一瞬两个气泡并存（同一段话显示两遍）；先收再渲染则是无缝交接。
            //   放在这里而不是更早，是为了让同步模式的 TTS 等待期仍有正文可看。
            removeStreamingReplyPreview();
            conversation.messages.push(aiMessage);
            conversation.updatedAt = new Date().toISOString();
            saveConversations();
            // （原来这里有一段 pendingAutoWrite："用户说写入你想说的话"时把 AI 回复写进文件。
            //   它唯一的写入者是已删除的 maybeAutoFileWrite，属于永不可达的死分支，一并移除。
            //   现在这个需求由 AI 输出 [操作:保存文件 …] 完成。）
            renderFolderList();
            updateCurrentConversationTitle();
            removeThinkingMessage();
            if (state.currentConversationId === conversation.id && !state.notesMode && !state.diaryMode && !document.getElementById(`msg-${safeAttrId(aiMessage.id)}`)) {
                renderMessage(aiMessage);
            }
            state.voiceState = 'idle';
            updateUI();

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
            // Live2D：AI 开始说话 → 嘴动
            if (window.Live2DCall && window.Live2DCall.isOpen()) {
                window.Live2DCall.speakStart();
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
        if (window.Live2DCall && typeof window.Live2DCall.isVoiceMuted === 'function' && window.Live2DCall.isVoiceMuted()) {
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
                if (window.Live2DCall && window.Live2DCall.isOpen()) {
                    window.Live2DCall.speakEnd();
                }
            }
        }).then(result => {
            if (result?.cancelled) {
                // 用户取消/停止语音播放：若回复尚未提交则补提交，避免丢聊天记录（幂等）
                commitAiMessageOnce();
                return;
            }
            if (!voiceStarted) {
                // ★★ 2026-10 修「语音生成不成功，整条回复就发不出去」：
                //
                //   同步模式（simultaneous）的语义是"语音开始播时正文才出现"，
                //   上面那句 `commitAiMessageOnce()` 挂在 handleVoiceStart 里 ——
                //   也就是说**只有 TTS 真的出声了，回复才会被提交**。
                //
                //   旧实现在这里的同步模式下只弹一句"回复没有显示"就 return：
                //   用户白等一次完整请求（可能几分钟），正文一个字都看不到，
                //   聊天记录里连痕迹都不留 —— 用户原话就是
                //   "必须语音生成成功才能发送全部消息"。
                //
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
            // ★ 同上：TTS 失败绝不能让正文与聊天记录一起消失。
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
        // ★ 已在上游记录过详情的错误不再重复打（2026-09 修）：
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
//
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


// ==================== TTS ====================

let _audioContext = null;
function getAudioContext() {
    if (!_audioContext) {
        _audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (activeVoicePlaybackStatus === 'paused') {
        if (_audioContext.state === 'running') _audioContext.suspend().catch(() => {});
    } else if (_audioContext.state === 'suspended') {
        _audioContext.resume().catch(() => {});
    }
    return _audioContext;
}

const TTS_CACHE_DB_NAME = 'elaina_open_tts_cache_v1';
const TTS_CACHE_STORE = 'pcm_audio';
const TTS_CACHE_LIMIT = 80;
let ttsCacheDbPromise = null;
const activeTtsTasks = new Map();
const ttsMemoryCache = new Map();

function hashTtsText(text) {
    let hash = 2166136261;
    const source = String(text || '');
    for (let i = 0; i < source.length; i++) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function buildMessageTtsCacheKey(message, spokenText, conversationId = state.currentConversationId) {
    const clean = sanitizeTtsText(spokenText || '', false);
    const provider = String(state.settings.ttsProvider || 'mimo');
    let providerFingerprint = '';
    if (provider === 'dashscope') {
        providerFingerprint = [
            state.settings.dashscopeTtsModel || 'qwen3-tts-flash',
            state.settings.dashscopeTtsVoice || 'no-voice'
        ].join('|');
    } else if (provider === 'mimo') {
        const mimoModel = String(state.settings.mimoTtsModel || 'mimo-v2.5-tts');
        // v2.5 的音色来源随模型变化，必须进指纹 —— 否则换了参考样本/描述仍命中旧缓存
        let voiceToken;
        if (mimoModel === 'mimo-v2.5-tts-voiceclone') {
            // 样本是长 base64，指纹只取"文件名 + 长度"这种轻量信息（换样本即变）
            const sample = String(state.settings.mimoTtsCloneSample || '');
            voiceToken = sample ? `clone:${state.settings.mimoTtsCloneSampleName || ''}:${sample.length}` : 'clone:none';
        } else if (mimoModel === 'mimo-v2.5-tts-voicedesign') {
            voiceToken = `design:${state.settings.mimoTtsVoiceDesignPrompt || ''}`;
        } else {
            voiceToken = state.settings.mimoTtsVoice || 'mimo_default';
        }
        providerFingerprint = [mimoModel, voiceToken].join('|');
    } else if (provider === 'openai-tts') {
        providerFingerprint = [
            state.settings.openaiTtsModel || 'tts-1',
            state.settings.openaiTtsVoice || 'alloy'
        ].join('|');
    } else {
        providerFingerprint = [
            state.settings.minimaxModel || 'speech-2.8-hd',
            state.settings.minimaxVoice || 'no-voice'
        ].join('|');
    }
    return [
        'message-v2',
        conversationId || 'conversation',
        message?.id || 'unknown',
        provider,
        providerFingerprint,
        state.settings.ttsLang || 'japanese',
        Number(state.settings.ttsSpeed || 1).toFixed(2),
        Number(state.settings.ttsVolume ?? 1).toFixed(2),
        hashTtsText(clean)
    ].join(':');
}

function openTtsCacheDb() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    if (ttsCacheDbPromise) return ttsCacheDbPromise;
    ttsCacheDbPromise = new Promise(resolve => {
        const request = indexedDB.open(TTS_CACHE_DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(TTS_CACHE_STORE)) {
                const store = db.createObjectStore(TTS_CACHE_STORE, { keyPath: 'key' });
                store.createIndex('createdAt', 'createdAt');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
            console.warn('[TTS Cache] IndexedDB 打开失败:', request.error);
            resolve(null);
        };
    });
    return ttsCacheDbPromise;
}

async function getCachedTtsAudio(key) {
    if (!key) return null;
    if (ttsMemoryCache.has(key)) return ttsMemoryCache.get(key);
    const db = await openTtsCacheDb();
    if (!db) return null;
    return new Promise(resolve => {
        const request = db.transaction(TTS_CACHE_STORE, 'readonly').objectStore(TTS_CACHE_STORE).get(key);
        request.onsuccess = () => {
            const record = request.result || null;
            if (record) ttsMemoryCache.set(key, record);
            resolve(record);
        };
        request.onerror = () => resolve(null);
    });
}

async function pruneTtsCache() {
    const db = await openTtsCacheDb();
    if (!db) return;
    const transaction = db.transaction(TTS_CACHE_STORE, 'readwrite');
    const store = transaction.objectStore(TTS_CACHE_STORE);
    const countRequest = store.count();
    countRequest.onsuccess = () => {
        let removeCount = Math.max(0, countRequest.result - TTS_CACHE_LIMIT);
        if (!removeCount) return;
        const cursorRequest = store.index('createdAt').openCursor();
        cursorRequest.onsuccess = event => {
            const cursor = event.target.result;
            if (!cursor || removeCount <= 0) return;
            store.delete(cursor.primaryKey);
            removeCount -= 1;
            cursor.continue();
        };
    };
}

async function saveCachedTtsAudio(key, pcmBuffer, sampleRate, format = 'pcm') {
    if (!key || !pcmBuffer || !pcmBuffer.byteLength) return;
    const record = { key, pcm: pcmBuffer, sampleRate, format, createdAt: Date.now() };
    ttsMemoryCache.set(key, record);
    while (ttsMemoryCache.size > TTS_CACHE_LIMIT) {
        ttsMemoryCache.delete(ttsMemoryCache.keys().next().value);
    }
    const db = await openTtsCacheDb();
    if (!db) return;
    await new Promise(resolve => {
        const transaction = db.transaction(TTS_CACHE_STORE, 'readwrite');
        transaction.objectStore(TTS_CACHE_STORE).put(record);
        transaction.oncomplete = resolve;
        transaction.onerror = () => {
            console.warn('[TTS Cache] 写入失败:', transaction.error);
            resolve();
        };
    });
    pruneTtsCache().catch(() => {});
}

function mergePcmChunks(chunks) {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    chunks.forEach(chunk => {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    });
    return merged.buffer;
}

// 真实语音音量 → Live2D 嘴型（VAD 简化）：播放 TTS 时分析音量驱动模型说话
//
// ★ 宿主只负责**报出音量**，谁需要谁订阅（`ElainaMods.on('voice-energy', …)`）。
//
//   旧写法是这里直接调 `window.Live2DCall.setVoiceEnergy()` —— 于是"音量"这条
//   通道把宿主和 Live2D 拴死了：Live2D 一旦变成可装的 mod（默认关闭），
//   宿主这句调用就会在它没装/没启用时变成空转，而"没装"与"装了但没声音"
//   从代码上分不出来。
//
//   改成事件之后有两个实际好处：
//     · 没人听就**不建分析器、不跑逐帧循环** —— 省掉未启用 Live2D 时
//       每次 TTS 播放的 requestAnimationFrame 开销
//     · 订阅者的生命周期由 mod 系统统一管：mod 被停用时订阅会被摘掉
//       （见 mods.js「注册即副作用」），不会再出现"插件关了还在驱动口型"
function voiceEnergyWanted() {
    try {
        return !!(window.ElainaMods
            && typeof window.ElainaMods.hasListeners === 'function'
            && window.ElainaMods.hasListeners('voice-energy'));
    } catch (e) { return false; }
}
function emitVoiceEnergy(level) {
    try {
        if (window.ElainaMods && typeof window.ElainaMods.emit === 'function') {
            window.ElainaMods.emit('voice-energy', level);
        }
    } catch (e) { /* 没有订阅者 / 订阅者抛错都不该影响播放 */ }
}
function attachVoiceEnergyAnalyser(source, context) {
    if (!voiceEnergyWanted() || typeof context.createAnalyser !== 'function') return null;
    try {
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyser.connect(context.destination);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
            // playbackState: 0=未调度 1=已调度 2=播放中 3=已结束
            if (source.playbackState === 3 || source.playbackState === undefined) {
                emitVoiceEnergy(0);
                return;
            }
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const level = sum / data.length / 128;
            emitVoiceEnergy(level);
            requestAnimationFrame(tick);
        };
        tick();
        return analyser;
    } catch (e) { return null; }
}

async function playCachedPcm(record, onStart, onEnd, session) {
    const raw = record.pcm instanceof ArrayBuffer ? record.pcm : record.pcm?.buffer;
    if (!raw || raw.byteLength < 2) throw new Error('缓存音频为空');
    ensureVoiceSessionActive(session);
    const context = getAudioContext();
    let buffer;
    if (['mp3', 'wav', 'ogg', 'opus', 'audio'].includes(record.format)) {
        buffer = await context.decodeAudioData(raw.slice(0));
    } else {
            const bytes = new Uint8Array(raw);
            const sampleCount = Math.floor(bytes.byteLength / 2);
            const pcm = new Int16Array(sampleCount);
            for (let i = 0; i < sampleCount; i++) {
                pcm[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
            }
            buffer = context.createBuffer(1, sampleCount, record.sampleRate || 24000);
            const channel = buffer.getChannelData(0);
            for (let i = 0; i < sampleCount; i++) channel[i] = pcm[i] / 32768;
    }
    ensureVoiceSessionActive(session);
    return new Promise((resolve, reject) => {
        try {
            ensureVoiceSessionActive(session);
            const source = context.createBufferSource();
            session.audioSources.add(source);
            source.buffer = buffer;
            attachVoiceEnergyAnalyser(source, context);
            source.connect(context.destination);
            source.onended = () => {
                session.audioSources.delete(source);
                if (isVoiceSessionActive(session) && onEnd) onEnd();
                resolve();
            };
            if (isVoiceSessionActive(session) && onStart) onStart();
            ensureVoiceSessionActive(session);
            source.start();
            if (activeVoicePlaybackStatus === 'paused' && context.state === 'running') context.suspend().catch(() => {});
        } catch (error) {
            reject(error);
        }
    });
}

class PCMStreamPlayer {
    constructor(sampleRate, session) {
        this.ctx = getAudioContext();
        this.sampleRate = sampleRate;
        this.session = session;
        this.nextStartTime = 0;
        this.ended = false;
    }
    enqueue(bytes) {
        if (this.ended || this.ctx.state === 'closed' || !isVoiceSessionActive(this.session)) return;
        const buffer = new ArrayBuffer(bytes.length);
        const view = new Int16Array(buffer);
        for (let i = 0; i < bytes.length; i += 2) {
            view[i / 2] = (bytes[i] | (bytes[i + 1] << 8));
        }
        const audioBuffer = this.ctx.createBuffer(1, view.length, this.sampleRate);
        const channel = audioBuffer.getChannelData(0);
        for (let i = 0; i < view.length; i++) {
            channel[i] = view[i] / 32768;
        }
        const source = this.ctx.createBufferSource();
        this.session.audioSources.add(source);
        source.buffer = audioBuffer;
        attachVoiceEnergyAnalyser(source, this.ctx);
        source.connect(this.ctx.destination);
        source.onended = () => this.session.audioSources.delete(source);
        const now = this.ctx.currentTime;
        if (this.nextStartTime < now) this.nextStartTime = now;
        source.start(this.nextStartTime);
        this.nextStartTime += audioBuffer.duration;
    }
    finalize() {
        this.ended = true;
    }
}


// ==================== MiMo TTS（小米，OpenAI 兼容） ====================
//
// 认证头同样是 `api-key`，但**凭据与 ASR 各自独立**（TTS 用 settings.mimoTtsApiKey /
// settings.mimoTtsBaseUrl；ASR 用 settings.mimoApiKey / settings.mimoBaseUrl）。
//   · **要朗读的文本放在 assistant 消息里**
//   · 请求体加 audio: { format: 'wav', ... }
//   · 响应 choices[0].message.audio.data 是 base64 的 wav 音频
// 三个模型（v2.5 系列）字段不同，见下：
//   · mimo-v2.5-tts            → audio.voice = 预置 Voice ID，user 消息可选
//   · mimo-v2.5-tts-voicedesign → user 消息 = 音色描述（必填），**不支持 voice 字段**
//   · mimo-v2.5-tts-voiceclone  → audio.voice = 参考音频样本的 base64 data URL（必填），不支持预置音色
// 它是**付费 API Key** 服务商，没有 Key 就不能用（不像旧版 Edge TTS 免配置）。

async function generateMimoTtsAudio(text, settings = state.settings) {
    const mimoApiKey = String(settings.mimoTtsApiKey || '').trim();
    if (!mimoApiKey) throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写小米 MiMo TTS API Key');
    const baseUrl = String(settings.mimoTtsBaseUrl || 'https://api.xiaomimimo.com').trim().replace(/\/+$/, '');
    const model = String(settings.mimoTtsModel || 'mimo-v2.5-tts').trim() || 'mimo-v2.5-tts';
    // ★ 要朗读的文本必须放在 assistant 角色里
    const assistantMessage = { role: 'assistant', content: text };
    const audio = { format: 'wav' };
    let messages;
    if (model === 'mimo-v2.5-tts-voicedesign') {
        // 音色设计：user 消息里的音色描述**必填**，且该模型不支持 voice 字段
        const prompt = String(settings.mimoTtsVoiceDesignPrompt || '').trim();
        if (!prompt) throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写 MiMo 音色描述（voicedesign 模型必填）');
        messages = [{ role: 'user', content: prompt }, assistantMessage];
    } else if (model === 'mimo-v2.5-tts-voiceclone') {
        // 音色复刻：参考音频样本（base64 data URL）**必填**，放在 audio.voice 里；不支持预置音色
        const sample = String(settings.mimoTtsCloneSample || '').trim();
        if (!sample) throw new ClientApiError('APP_KEY_MISSING', '请先在设置中上传音色复刻的参考音频样本');
        audio.voice = /^data:audio\//i.test(sample) ? sample : `data:audio/wav;base64,${sample}`;
        messages = [{ role: 'user', content: '' }, assistantMessage];
    } else {
        // 预置音色模型：voice 为预置 Voice ID
        audio.voice = String(settings.mimoTtsVoice || 'mimo_default').trim() || 'mimo_default';
        messages = [assistantMessage];
    }
    const result = await postJsonFromDevice(baseUrl + '/v1/chat/completions', {
        model,
        messages,
        audio
    }, {
        'api-key': mimoApiKey,
        'Content-Type': 'application/json'
    });
    if (!result.ok) await throwProviderResponseError(result, '小米 MiMo 语音生成失败');
    const audioBase64 = String(result.payload?.choices?.[0]?.message?.audio?.data || '').trim();
    if (!audioBase64) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '小米 MiMo 语音返回了空音频');
    // base64(wav) → ArrayBuffer，播放器按 wav 解码（与千问返回的 { bytes, format } 形状一致）
    return { bytes: base64ToArrayBuffer(audioBase64), format: 'wav' };
}

async function speakTextMimo(text, onStart, options = {}) {
    const { cacheKey = '', onEnd = null } = options;
    const session = options.session || createVoiceSession(options.messageId || null);
    ensureVoiceSessionActive(session);
    if (cacheKey) {
        const cached = await getCachedTtsAudio(cacheKey);
        ensureVoiceSessionActive(session);
        if (cached?.pcm) {
            console.log('[TTS Cache] 命中缓存，直接播放，不调用 MiMo');
            try {
                await playCachedPcm(cached, onStart, onEnd, session);
                if (!isVoiceSessionActive(session)) return { cancelled: true };
                return { cached: true };
            } catch (error) {
                if (isVoiceCancellation(error) || !isVoiceSessionActive(session)) return { cancelled: true };
                console.warn('[TTS Cache] 缓存播放失败，将重新生成:', error);
            }
        } else {
            console.log('[TTS Cache] 未命中，首次调用 MiMo 生成');
        }
    }
    try {
        session.abortController = new AbortController();
        const { bytes, format } = await generateMimoTtsAudio(text);
        ensureVoiceSessionActive(session);
        if (cacheKey) {
            await saveCachedTtsAudio(cacheKey, bytes, 24000, format);
            console.log('[TTS Cache] 首次 MiMo 音频已写入 IndexedDB');
        }
        await playCachedPcm({ pcm: bytes, format }, onStart, onEnd, session);
        if (!isVoiceSessionActive(session)) return { cancelled: true };
        return { cached: false };
    } catch (error) {
        if (isVoiceCancellation(error) || !isVoiceSessionActive(session)) return { cancelled: true };
        console.error('[MiMo TTS] error:', error);
        throw toClientApiError(error);
    }
}

// ==================== 通用 OpenAI TTS ====================
//
// 标准 OpenAI 语音接口：POST {base}/audio/speech + Bearer 认证，请求体
// { model, input, voice, response_format: 'mp3' }，响应是**二进制 mp3**（不是 JSON）。
// 直接读 arrayBuffer 交给播放器 —— 与 MiniMax 返回的 { bytes, format } 形状一致。

async function generateOpenaiTtsAudio(text, settings = state.settings) {
    const apiKey = String(settings.openaiTtsApiKey || '').trim();
    if (!apiKey) throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写通用 OpenAI TTS 的 API Key');
    const baseUrl = String(settings.openaiTtsBaseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
    const response = await fetchWithTimeout(baseUrl + '/audio/speech', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: String(settings.openaiTtsModel || 'tts-1').trim(),
            input: text,
            voice: String(settings.openaiTtsVoice || 'alloy').trim() || 'alloy',
            response_format: 'mp3'
        })
    }, 120000);
    if (!response.ok) {
        let detail = '';
        try { detail = String((await response.json())?.error?.message || ''); } catch { /* 错误体不是 JSON */ }
        throw new ClientApiError('UPSTREAM_UNAVAILABLE',
            `通用 OpenAI TTS 失败（HTTP ${response.status}）` + (detail ? `：${detail}` : ''));
    }
    // 二进制音频：读成 ArrayBuffer 直接交给播放器解码（无需再走 Blob → objectURL 一步）
    const bytes = await response.arrayBuffer();
    if (!bytes || bytes.byteLength < 200) {
        throw new ClientApiError('UPSTREAM_UNAVAILABLE', '通用 OpenAI TTS 返回了空音频');
    }
    return { bytes, format: 'mp3' };
}

async function speakTextOpenaiTts(text, onStart, options = {}) {
    const { cacheKey = '', onEnd = null } = options;
    const session = options.session || createVoiceSession(options.messageId || null);
    ensureVoiceSessionActive(session);
    if (cacheKey) {
        const cached = await getCachedTtsAudio(cacheKey);
        ensureVoiceSessionActive(session);
        if (cached?.pcm) {
            console.log('[TTS Cache] 命中缓存，直接播放，不调用通用 OpenAI TTS');
            try {
                await playCachedPcm(cached, onStart, onEnd, session);
                if (!isVoiceSessionActive(session)) return { cancelled: true };
                return { cached: true };
            } catch (error) {
                if (isVoiceCancellation(error) || !isVoiceSessionActive(session)) return { cancelled: true };
                console.warn('[TTS Cache] 缓存播放失败，将重新生成:', error);
            }
        } else {
            console.log('[TTS Cache] 未命中，首次调用通用 OpenAI TTS 生成');
        }
    }
    try {
        session.abortController = new AbortController();
        const { bytes, format } = await generateOpenaiTtsAudio(text);
        ensureVoiceSessionActive(session);
        if (cacheKey) {
            await saveCachedTtsAudio(cacheKey, bytes, 24000, format);
            console.log('[TTS Cache] 首次 OpenAI TTS 音频已写入 IndexedDB');
        }
        await playCachedPcm({ pcm: bytes, format }, onStart, onEnd, session);
        if (!isVoiceSessionActive(session)) return { cancelled: true };
        return { cached: false };
    } catch (error) {
        if (isVoiceCancellation(error) || !isVoiceSessionActive(session)) return { cancelled: true };
        console.error('[OpenAI TTS] error:', error);
        throw toClientApiError(error);
    }
}

async function speakTextMinimax(text, onStart, options = {}) {
    const { cacheKey = '', onEnd = null } = options;
    const session = options.session || createVoiceSession(options.messageId || null);
    ensureVoiceSessionActive(session);
    if (cacheKey) {
        const cached = await getCachedTtsAudio(cacheKey);
        ensureVoiceSessionActive(session);
        if (cached?.pcm) {
            console.log('[TTS Cache] 命中缓存，直接播放，不调用 MiniMax');
            try {
                await playCachedPcm(cached, onStart, onEnd, session);
                if (!isVoiceSessionActive(session)) return { cancelled: true };
                return { cached: true };
            } catch (error) {
                if (isVoiceCancellation(error) || !isVoiceSessionActive(session)) return { cancelled: true };
                console.warn('[TTS Cache] 缓存播放失败，将重新生成:', error);
            }
        } else {
            console.log('[TTS Cache] 未命中，首次调用 MiniMax 生成');
        }
    }
    const minimaxApiKey = String(state.settings.minimaxApiKey || '').trim();
    const voiceId = String(state.settings.minimaxVoice || '').trim();
    if (!minimaxApiKey) throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写 MiniMax API Key');
    if (!voiceId) throw new ClientApiError('BAD_REQUEST', '请先在设置中填写自己的 MiniMax 音色 ID');
    try {
        session.abortController = new AbortController();
        const result = await postJsonFromDevice(MINIMAX_TTS_HTTP, {
            model: state.settings.minimaxModel || 'speech-2.8-hd',
            text,
            stream: false,
            language_boost: 'auto',
            voice_setting: {
                voice_id: voiceId,
                speed: state.settings.ttsSpeed || 1.0,
                vol: state.settings.ttsVolume ?? 1,
                pitch: 0
            },
            audio_setting: {
                sample_rate: 24000,
                bitrate: 128000,
                format: 'mp3',
                channel: 1
            }
        }, { Authorization: `Bearer ${minimaxApiKey}` });
        if (!result.ok) await throwProviderResponseError(result, 'MiniMax 语音生成失败');
        const providerCode = Number(result.payload?.base_resp?.status_code || 0);
        if (providerCode !== 0) await throwProviderResponseError(result, result.payload?.base_resp?.status_msg || 'MiniMax 语音生成失败');
        const audioHex = String(result.payload?.data?.audio || '').trim();
        if (!audioHex || audioHex.length % 2 !== 0) throw new ClientApiError('UPSTREAM_UNAVAILABLE', 'MiniMax TTS 返回了空音频');
        const bytes = new Uint8Array(audioHex.length / 2);
        for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(audioHex.slice(index * 2, index * 2 + 2), 16);
        const mp3 = bytes.buffer;
        ensureVoiceSessionActive(session);
        if (cacheKey) {
            await saveCachedTtsAudio(cacheKey, mp3, 24000, 'mp3');
            console.log('[TTS Cache] 首次 MP3 音频已写入 IndexedDB');
        }
        await playCachedPcm({ pcm: mp3, format: 'mp3' }, onStart, onEnd, session);
        if (!isVoiceSessionActive(session)) return { cancelled: true };
        return { cached: false };
    } catch (error) {
        if (isVoiceCancellation(error) || !isVoiceSessionActive(session)) return { cancelled: true };
        console.error('[MiniMax TTS] error:', error);
        throw toClientApiError(error);
    }
}

async function generateDashscopeTtsAudio(text, settings = state.settings) {
    const dashscopeApiKey = String(settings.dashscopeApiKey || '').trim();
    const voiceId = String(settings.dashscopeTtsVoice || '').trim();
    if (!dashscopeApiKey) throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写 DashScope API Key');
    if (!voiceId) throw new ClientApiError('BAD_REQUEST', '请先在设置中填写千问 TTS 音色');
    const languageMap = {
        chinese: 'Chinese',
        japanese: 'Japanese',
        english: 'English'
    };
    const languageType = languageMap[settings.ttsLang] || 'Auto';
    const result = await postJsonFromDevice(DASHSCOPE_SYNC_URL, {
        model: String(settings.dashscopeTtsModel || 'qwen3-tts-flash').trim(),
        input: {
            text,
            voice: voiceId,
            language_type: languageType
        }
    }, {
        Authorization: `Bearer ${dashscopeApiKey}`
    });
    if (!result.ok) await throwProviderResponseError(result, '阿里千问语音生成失败');
    const audioUrl = String(result.payload?.output?.audio?.url || '').trim();
    if (!audioUrl) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '阿里千问语音返回了空音频地址');
    const audio = await getBinaryFromDevice(audioUrl);
    if (!audio?.bytes?.byteLength) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '阿里千问音频文件为空');
    const format = /mp3|mpeg/i.test(audio.contentType) ? 'mp3' : 'wav';
    return { bytes: audio.bytes, format };
}

async function speakTextDashscope(text, onStart, options = {}) {
    const { cacheKey = '', onEnd = null } = options;
    const session = options.session || createVoiceSession(options.messageId || null);
    ensureVoiceSessionActive(session);
    if (cacheKey) {
        const cached = await getCachedTtsAudio(cacheKey);
        ensureVoiceSessionActive(session);
        if (cached?.pcm) {
            console.log('[TTS Cache] 命中缓存，直接播放，不调用阿里千问');
            try {
                await playCachedPcm(cached, onStart, onEnd, session);
                if (!isVoiceSessionActive(session)) return { cancelled: true };
                return { cached: true };
            } catch (error) {
                if (isVoiceCancellation(error) || !isVoiceSessionActive(session)) return { cancelled: true };
                console.warn('[TTS Cache] 缓存播放失败，将重新生成:', error);
            }
        } else {
            console.log('[TTS Cache] 未命中，首次调用阿里千问生成');
        }
    }
    try {
        session.abortController = new AbortController();
        const { bytes, format } = await generateDashscopeTtsAudio(text);
        ensureVoiceSessionActive(session);
        if (cacheKey) {
            await saveCachedTtsAudio(cacheKey, bytes, 24000, format);
            console.log('[TTS Cache] 首次千问音频已写入 IndexedDB');
        }
        await playCachedPcm({ pcm: bytes, format }, onStart, onEnd, session);
        if (!isVoiceSessionActive(session)) return { cancelled: true };
        return { cached: false };
    } catch (error) {
        if (isVoiceCancellation(error) || !isVoiceSessionActive(session)) return { cancelled: true };
        console.error('[DashScope TTS] error:', error);
        throw toClientApiError(error);
    }
}

function useBrowserTTS(text, onStart, onEnd, session = null) {
    const playbackPromise = new Promise(resolve => {
        if (session && !isVoiceSessionActive(session)) { resolve({ cancelled: true }); return; }
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();

            const utterance = new SpeechSynthesisUtterance(text);
            const voices = window.speechSynthesis.getVoices();
            const isJapanese = /[\u3040-\u30ff]/.test(text);
            utterance.lang = isJapanese ? 'ja-JP' : 'zh-CN';
            utterance.rate = 0.95;
            utterance.pitch = 1;
            utterance.volume = Math.max(0, Math.min(1, Number(state.settings.ttsVolume ?? 1)));

            const voice = voices.find(v => v.lang.startsWith(isJapanese ? 'ja' : 'zh'));
            if (voice) utterance.voice = voice;

            utterance.onstart = () => {
                if ((!session || isVoiceSessionActive(session)) && onStart) {
                    try { onStart(); } catch (e) { console.error('Browser TTS onStart error:', e); }
                }
            };
            const finish = () => {
                if (!session || isVoiceSessionActive(session)) {
                    if (onEnd) onEnd();
                }
                resolve();
            };
            utterance.onend = finish;
            utterance.onerror = finish;
            window.speechSynthesis.speak(utterance);
        } else {
            if (onEnd) onEnd();
            resolve();
        }
    });
    return session ? Promise.race([playbackPromise, session.cancelPromise]) : playbackPromise;
}

if ('speechSynthesis' in window) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
    };
}

function sanitizeTtsText(text, stripKana = false) {
    let t = String(text || '').trim();

    // Parenthesized/bracketed passages are stage directions for display only.
    // Repeat a few times so simple nested brackets are removed as one block.
    for (let i = 0; i < 4; i++) {
        const next = t.replace(/（[^（）]*）|\([^()]*\)|【[^【】]*】|\[[^\[\]]*\]/g, ' ');
        if (next === t) break;
        t = next;
    }

    if (stripKana) t = t.replace(/[\u3040-\u30ff]+/g, '');
    t = t.replace(/\s{2,}/g, ' ');
    t = t.replace(/[，、]+(?=[。！？；：,.!?;:])/g, '');
    t = t.replace(/([。！？；：,.!?;:])\1+/g, '$1');
    t = t.replace(/^[\u2014\u2015\u301c\uff5e~，、。！？；：,.!?;:\s]+|[\u2014\u2015\u301c\uff5e~，、。！？；：,.!?;:\s]+$/g, '');
    return t.trim();
}

function speakText(text, onStart, options = {}) {
    const ttsLang = state.settings.ttsLang || 'japanese';
    const clean = sanitizeTtsText(text, ttsLang === 'chinese');
    if (clean !== text) {
        console.log('[TTS] 已移除动作描写并净化朗读文本');
    }
    if (!clean) {
        if (options.onEnd) options.onEnd();
        return Promise.resolve({ empty: true });
    }
    const cacheKey = String(options.cacheKey || '');
    if (cacheKey && activeTtsTasks.has(cacheKey)) {
        console.log('[TTS] 同一消息的语音任务仍在进行，复用现有任务');
        return activeTtsTasks.get(cacheKey);
    }
    const provider = String(state.settings.ttsProvider || 'mimo');
    const task = provider === 'mimo'
        ? speakTextMimo(clean, onStart, options)
        : provider === 'openai-tts'
            ? speakTextOpenaiTts(clean, onStart, options)
            : provider === 'dashscope'
                ? speakTextDashscope(clean, onStart, options)
                : speakTextMinimax(clean, onStart, options);
    if (!cacheKey) return task;
    activeTtsTasks.set(cacheKey, task);
    const clearTask = () => {
        if (activeTtsTasks.get(cacheKey) === task) activeTtsTasks.delete(cacheKey);
    };
    task.then(clearTask, clearTask);
    return task;
}

