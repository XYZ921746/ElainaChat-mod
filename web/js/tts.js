/* ============================================================================
 * TTS 语音合成（从 voice.js 拆出）
 *
 * 音频上下文 / 缓存 / 能量条 / MiMo / OpenAI / MiniMax / DashScope / speakText。
 * 依赖会话状态与语音播放（运行时才调用）。
 * ========================================================================== */
'use strict';

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

// ── TTS 音频缓存：**纯内存 LRU，上限 5 条**─────────────────
// 之前是 IndexedDB（硬盘）缓存 80 条。改为内存缓存的两个理由：
//   · 语音聊天音频属于"听过就没用"的一次性数据，没理由常驻硬盘；
//     且 IndexedDB 挂在浏览器 profile 上，"删除 data/ 清数据"根本清不到它。
//   · 上限 5 条足以覆盖"重听最近几条消息"的场景；被挤出缓存的音频
//     下次播放时走未命中路径重新调用 TTS API 生成（speakTextXxx 里的既有逻辑）。
// LRU 语义：命中/写入都把 key 移到 Map 末尾（Map 迭代按插入序），
// 超限时从头部淘汰最久未使用的条目。
const TTS_MEMORY_LIMIT = 5;
const activeTtsTasks = new Map();
const ttsMemoryCache = new Map();

// 一次性清理：老版本留在 IndexedDB 里的缓存库已废弃，删掉释放硬盘空间。
// deleteDatabase 对不存在的库是空操作，重复执行无害（幂等）。
try {
    if ('indexedDB' in window) indexedDB.deleteDatabase('elaina_open_tts_cache_v1');
} catch { /* 清不掉也不影响新缓存工作 */ }

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

function ttsCacheTouch(key) {
    if (!ttsMemoryCache.has(key)) return;
    const value = ttsMemoryCache.get(key);
    ttsMemoryCache.delete(key);
    ttsMemoryCache.set(key, value);
}

async function getCachedTtsAudio(key) {
    if (!key) return null;
    if (ttsMemoryCache.has(key)) {
        ttsCacheTouch(key);   // 命中即"最近使用"，移到 LRU 末尾
        return ttsMemoryCache.get(key);
    }
    return null;
}

async function saveCachedTtsAudio(key, pcmBuffer, sampleRate, format = 'pcm') {
    if (!key || !pcmBuffer || !pcmBuffer.byteLength) return;
    const record = { key, pcm: pcmBuffer, sampleRate, format, createdAt: Date.now() };
    // 同 key 重写：先删再插，保证它在 Map 尾部（最新）
    ttsMemoryCache.delete(key);
    ttsMemoryCache.set(key, record);
    while (ttsMemoryCache.size > TTS_MEMORY_LIMIT) {
        const oldest = ttsMemoryCache.keys().next().value;
        ttsMemoryCache.delete(oldest);
    }
}

// 真实语音音量 → Live2D 嘴型（VAD 简化）：播放 TTS 时分析音量驱动模型说话
// 宿主只负责**报出音量**，谁需要谁订阅（`ElainaMods.on('voice-energy', …)`）。
//   旧写法是这里直接调 Live2D 插件的音量接口 —— 于是"音量"这条
//   通道把宿主和 Live2D 拴死了：Live2D 一旦变成可装的 mod（默认关闭），
//   宿主这句调用就会在它没装/没启用时变成空转，而"没装"与"装了但没声音"
//   从代码上分不出来。
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


// ==================== MiMo TTS（小米，OpenAI 兼容） ====================
// 认证头同样是 `api-key`，但**凭据与 ASR 各自独立**（TTS 用 settings.mimoTtsApiKey /
// settings.mimoTtsBaseUrl；ASR 用 settings.mimoApiKey / settings.mimoBaseUrl）。
//   · **要朗读的文本放在 assistant 消息里**
//   · 请求体加 audio: { format: 'wav', ... }
//   · 响应 choices[0].message.audio.data 是 base64 的 wav 音频
// 三个模型（v2.5 系列）字段不同，见下：
//   · mimo-v2.5-tts            → audio.voice = 预置 Voice ID，user 消息可选
//   · mimo-v2.5-tts-voicedesign → user 消息 = 音色描述（必填），**不支持 voice 字段**
//   · mimo-v2.5-tts-voiceclone  → audio.voice = 参考音频样本的 base64 data URL（必填），不支持预置音色
// 它是**付费 API Key** 服务商，没有 Key 就不能用（与免配置的浏览器内置语音不同）。

async function generateMimoTtsAudio(text, settings = state.settings) {
    const mimoApiKey = String(settings.mimoTtsApiKey || '').trim();
    if (!mimoApiKey) throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写小米 MiMo TTS API Key');
    const baseUrl = String(settings.mimoTtsBaseUrl || 'https://api.xiaomimimo.com').trim().replace(/\/+$/, '');
    const model = String(settings.mimoTtsModel || 'mimo-v2.5-tts').trim() || 'mimo-v2.5-tts';
    // voiceclone 但还没有样本时，先补上**软件自带**的那段伊蕾娜日语样本
    //   —— 用户可能压根没打开过设置页，直接在输入框按朗读也会走到这里。
    //   settings 有可能是设置页的**草稿对象**（见 testTtsConnection），补完要同步过去，
    //   否则本次请求读到的仍是空样本。
    if (model === 'mimo-v2.5-tts-voiceclone' && !String(settings.mimoTtsCloneSample || '').trim()) {
        await ensureBuiltinMimoCloneSample();
        settings.mimoTtsCloneSample = state.settings.mimoTtsCloneSample;
        settings.mimoTtsCloneSampleName = state.settings.mimoTtsCloneSampleName;
    }
    // 要朗读的文本必须放在 assistant 角色里
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
            console.log('[TTS Cache] 首次 MiMo 音频已写入内存缓存（上限 5 条）');
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
            console.log('[TTS Cache] 首次 OpenAI TTS 音频已写入内存缓存（上限 5 条）');
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
            console.log('[TTS Cache] 首次 MP3 音频已写入内存缓存（上限 5 条）');
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
            console.log('[TTS Cache] 首次千问音频已写入内存缓存（上限 5 条）');
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



