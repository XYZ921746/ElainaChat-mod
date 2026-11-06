// 语音识别 / 录音：本地录音 + 云端 ASR（阿里百炼 / 小米 MiMo）、转写、麦克风开始 / 结束 / 取消；依赖 state、DOM 与网络请求。
// Chrome 内置的 webkitSpeechRecognition 已整条移除：它要连 Google 语音服务，国内网络下不可用，且连不上会把整个浏览器进程带崩。
'use strict';

function canUseCloudFinalAsr() {
    const provider = state.settings.asrProvider || '';
    if (provider === 'aliyun') return Boolean(String(state.settings.asrApiKey || '').trim());
    if (provider === 'mimo') return Boolean(String(state.settings.mimoApiKey || '').trim());
    return false;
}

function isLocalAudioAsrMode(mode = asrMode) {
    return mode === 'cloud-final-only';
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

function isBadCloudFinalText(text) {
    const normalized = normalizeAsrTextForGuard(text);
    if (!normalized) return true;
    if (ASR_BAD_FINAL_TEXTS.has(normalized)) return true;
    if (/^[.。]+$/.test(normalized)) return true;
    return false;
}

async function fetchWithTimeout(url, options, timeoutMs, signal = null) {
    const controller = new AbortController();
    // 超时必须与外部主动中止区分开：两者都经 controller.abort() 变成 AbortError，而下游把 AbortError
    // 一律按"用户点了停止"安静收尾，超时会被吞掉。内部计时器到点且外部未中止时改抛 REQUEST_TIMEOUT。
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    // 两个中止来源都要接上：内部超时用 controller，外部（用户点停止 / 流式回退）用调用方传的 signal。
    // 只认 options.signal 不够 —— 它会被下面的 { ...options, signal: controller.signal } 覆盖掉。
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
    const provider = state.settings.asrProvider || '';
    if (provider === 'mimo') return transcribeRecordedAudioWithMimo();
    return transcribeRecordedAudioWithAliyun();
}

// 组装阿里百炼 ASR 的请求体，形状随模型家族而变，两种形状互不兼容，用错服务端直接回 400：
// qwen3-asr-flash 用 content:{ audio } + parameters.asr_options；
// qwen-audio-3.x-asr-flash 用 type:'input_audio' + input_audio.data，且 parameters.format 必填（漏了回 400）。
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
    // 默认：qwen3-asr-flash 的形状
    return {
        model,
        input: {
            messages: [{ role: 'user', content: [{ audio: data }] }]
        },
        parameters: { asr_options: { language: 'zh', enable_itn: true } }
    };
}

// 判断阿里百炼 ASR 的返回是不是"音频里没有人声"：3.x 系列在无语音时回 HTTP 400 +
// ASR_RESPONSE_HAVE_NO_WORDS，而「测试」按钮发的正是 0.5 秒静音 —— 不认它会把"Key 有效"误报成失败。
// 真实录音里没人声时同理，该按空结果处理而不是抛错。
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
        // 音频里没有人声：3.x 回 400 ASR_RESPONSE_HAVE_NO_WORDS，这不是失败，按空结果返回，别当错误抛给用户。
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

// 小米 MiMo-V2.5-ASR：OpenAI 兼容 /v1/chat/completions + input_audio（wav/mp3）；认证 api-key: $MIMO_API_KEY。
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

// 只做本地录音（名字里没有"识别"）：采到的音频点麦克风结束后整段交给云端转写。
async function startLocalRecordingSession() {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('当前浏览器不支持语音采集');
    }

    asrEnding = false;
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

    asrMode = 'cloud-final-only';
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
    asrEnding = false;
    resetRecordedAudio();
}

function handleMicClick() {
    if (state.notesMode || state.diaryMode || state.memoryPageMode) return;
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

// 浏览器只在 https 或 localhost 下允许调用麦克风：http + 局域网 IP 时主动问要不要跳 HTTPS，用户不用记端口。
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

    // 非安全上下文（非 https/localhost）：浏览器直接禁用麦克风，不弹长说明，直接问要不要切到 HTTPS。
    if (window.isSecureContext === false) {
        asrStarting = false;
        void offerHttpsSwitch();
        return;
    }
    if (!canUseCloudFinalAsr()) {
        asrStarting = false;
        showCustomAlert('语音识别需要先配置云端服务：\n\n设置 → 模型 → 语音 → 语音识别，选「阿里百炼」或「小米 MiMo」，填入 API Key。', '语音识别不可用');
        return;
    }

    try {
        await startLocalRecordingSession();
    } catch (error) {
        console.error('[ASR] 录音启动失败', error);
        state.voiceState = 'error';
        updateUI();
        showCustomAlert('语音识别启动失败: ' + error.message, '语音识别错误');
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
    asrEnding = true;
    const activeMode = asrMode;
    asrMode = 'submitting';
    state.voiceState = 'thinking';
    updateUI();

    try {
        if (isLocalAudioAsrMode(activeMode)) {
            stopLocalAudioGraph();
            let finalText = '';
            if (canUseCloudFinalAsr()) {
                elements.statusText.textContent = (state.settings.asrProvider === 'mimo' ? '正在用小米 MiMo 识别...' : '正在用阿里百炼识别...');
                try {
                    const cloudText = await transcribeRecordedAudioWithCloud();
                    if (cloudText && !isBadCloudFinalText(cloudText)) {
                        finalText = cloudText;
                    } else {
                        console.warn('[ASR] 云端识别返回空或疑似无效文本', {
                            cloudText: String(cloudText || '').slice(0, 100),
                            provider: state.settings.asrProvider
                        });
                    }
                } catch (error) {
                    console.error('[ASR] 云端识别失败：', {
                        provider: state.settings.asrProvider,
                        code: error?.code,
                        status: error?.status,
                        message: error?.message || String(error)
                    });
                    showClientApiError(error);
                }
            }
            resetRecordedAudio();

            const text = finalText.trim();
            if (text) {
                processVoiceInput(text);
            } else {
                state.voiceState = 'idle';
                updateUI();
                elements.statusText.textContent = '没有识别到清晰语音，请重试';
            }
        }
    } finally {
        asrEnding = false;
        asrSubmitting = false;
        if (state.voiceState === 'idle' || state.voiceState === 'thinking') {
            asrMode = 'cloud-final-only';
        }
    }
}

function cancelListening() {
    if (asrSubmitting) {
        console.log('[ASR] 忽略提交中的取消操作');
        return;
    }
    if (isLocalAudioAsrMode()) {
        closeLocalAsr(true);
    }
    state.voiceState = 'idle';
    updateUI();
}
