/* ============================================================================
 * MiMo TTS 参考音频样本（从 settings.js 拆出）
 *
 * 内置样本加载 / 上传转码 / 状态展示 / 旧样本修复 / 清除。
 * ========================================================================== */
"use strict";

const MIMO_TTS_CLONE_SAMPLE_MAX_BYTES = 5 * 1024 * 1024;

// ===== 内置参考音频样本=====
// 软件自带一段伊蕾娜的日语样本：`web/audio/mimo-elaina-jp.m4a`（随应用一起分发，
// APK 同步 web/ 时也会带上）。选到 voiceclone 模型而手上还没有样本时，自动把它
// **转码成 wav 并填入** —— 走的是与"用户自己上传"完全同一条路径
// （transcodeAudioBufferToWavDataUrl → data URL → 也是服务端拆到 data/voice-samples
// 的那套），所以没有任何特例分支。
// 别信这个样本文件的扩展名：它**真实字节是 m4a（ftypisom）容器**，
//   手机或工具常把它错误命名成 .mp3（所以这里有"按文件头嗅探格式"的注释）。
//   这里落地成 .m4a 是对的名字；反正前端一律先解码再转 wav，
//   扩展名不影响可用性，但别再让下一个人误以为它是 mp3。
// 为什么不做"每次启动都塞一遍"：转码后的 wav 有数 MB，写进 data/ 是实打实的体积；
//   而且用户一旦自己上传或主动清除，就该尊重他的选择。所以：
//     · 只在"当前是 voiceclone 且没有样本"时补，且**每个页面会话最多补一次**
//     · 用户点过「清除样本」后本会话不再自动补（要恢复就点「内置样本」按钮）
const BUILTIN_MIMO_CLONE_SAMPLE_URL = '/audio/mimo-elaina-jp.m4a';
const BUILTIN_MIMO_CLONE_SAMPLE_NAME = '伊蕾娜·日语参考（内置）';
let builtinCloneLoading = null;
let builtinCloneTriedThisSession = false;

/** 载入内置样本（fetch → 转码 wav → 落盘）。并发调用复用同一个 Promise */
function loadBuiltinMimoCloneSample() {
    if (builtinCloneLoading) return builtinCloneLoading;
    builtinCloneLoading = (async () => {
        try {
            const res = await fetch(BUILTIN_MIMO_CLONE_SAMPLE_URL, { cache: 'force-cache' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const dataUrl = await transcodeAudioBufferToWavDataUrl(await res.arrayBuffer());
            if (dataUrl.length > MIMO_TTS_CLONE_SAMPLE_MAX_BYTES * 1.5) throw new Error('内置样本转码后超过上限');
            state.settings.mimoTtsCloneSample = dataUrl;
            state.settings.mimoTtsCloneSampleName = BUILTIN_MIMO_CLONE_SAMPLE_NAME;
            persistSettings();
            updateMimoTtsCloneSampleStatusDisplay();
            return true;
        } catch (e) {
            console.warn('[MiMo TTS] 内置参考样本不可用（可手动上传）：', e);
            updateMimoTtsCloneSampleStatusDisplay('内置样本加载失败，请手动选择参考音频。', true);
            return false;
        } finally {
            builtinCloneLoading = null;
        }
    })();
    return builtinCloneLoading;
}

/** 自动补内置样本：仅当"当前选的是 voiceclone + 还没有样本 + 本会话还没试过"时动手 */
function ensureBuiltinMimoCloneSample() {
    const model = document.getElementById('settingMimoTtsModel')?.value || state.settings.mimoTtsModel || '';
    if (model !== 'mimo-v2.5-tts-voiceclone') return Promise.resolve(false);
    if (String(state.settings.mimoTtsCloneSample || '').trim()) return Promise.resolve(false);
    if (builtinCloneTriedThisSession) return Promise.resolve(false);
    builtinCloneTriedThisSession = true;
    return loadBuiltinMimoCloneSample();
}

// 展示已保存样本的文件名（文件框无法回填，只能靠状态里的文件名）；传 message 则临时覆盖文案。
// 拆成两个：Display 只渲染（转码完成的回调也用它，避免与 repair 相互触发）。
function updateMimoTtsCloneSampleStatusDisplay(message, isError) {
    const el = document.getElementById('mimoTtsCloneSampleStatus');
    if (!el) return;
    // 用 .tts-sample-status 这套类（颜色走主题变量，见 index.html），
    //   不要写死 Tailwind 色（text-emerald-400 / text-red-400 / text-indigo-300）——
    //   写死的颜色不会随主题和深色模式变化。
    if (message) {
        el.textContent = message;
        el.className = 'tts-sample-status ' + (isError ? 'is-error' : 'is-ok');
        return;
    }
    const name = String(state.settings.mimoTtsCloneSampleName || '').trim();
    const hasSample = Boolean(String(state.settings.mimoTtsCloneSample || '').trim());
    if (hasSample) {
        el.textContent = `已选择：${name || '(未命名)'}`;
        el.className = 'tts-sample-status is-ok';
    } else {
        el.textContent = '未选择样本';
        el.className = 'tts-sample-status';
    }
}
function updateMimoTtsCloneSampleStatus(message, isError) {
    // 顺带把「已存但格式不是 wav」的样本转码成 wav（官方 voiceclone 只稳支持 mp3/wav）
    try { repairMimoTtsCloneSamplePrefix(); } catch (e) { /* 转码失败不影响展示 */ }
    updateMimoTtsCloneSampleStatusDisplay(message, isError);
}

// MiMo 音色复刻的参考样本。
// 官方 API 文档写明：voiceclone 的样本（audio.voice 的 base64）**仅支持 mp3 和 wav**。
//   而手机录音常是 m4a/aac，还被系统或工具错误地命名成 .mp3 —— 实测用户的样本文件名是
//   "202610131732.mp3"，真实字节却是 `ftypisom`（m4a 容器），服务端直接以
//   「invalid audio format」400 拒绝。**光改 data URL 前缀救不了**：字节本身就不是它认的格式。
// 因此这里**一律转码成 16-bit PCM WAV** —— 浏览器自带的 Web Audio 能解码 m4a/aac/flac/ogg，
//   于是无论用户丢进来什么，最终都变成服务端最稳的 wav，用户不必自己去外部工具转码。
// 已存的老样本也会被自动转一次（见 repairMimoTtsCloneSamplePrefix）。
const MIMO_TTS_CLONE_WAV_PREFIX = 'data:audio/wav;base64,';

// 嗅探容器格式（仅用于日志与排查，不影响处理流程）
function mimoSampleFormatFromHead(head) {
    const b = head || new Uint8Array(0);
    const at = (i, s) => s.split('').every((c, k) => b[i + k] === c.charCodeAt(0));
    if (b.length >= 12 && at(0, 'RIFF') && at(8, 'WAVE')) return 'wav';
    if (b.length >= 4 && at(0, 'fLaC')) return 'flac';
    if (b.length >= 4 && at(0, 'OggS')) return 'ogg';
    if (b.length >= 12 && at(4, 'ftyp')) return 'm4a';
    if (b.length >= 3 && at(0, 'ID3')) return 'mp3';
    if (b.length >= 2 && b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'mp3';
    return '(未知)';
}
function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}
// 编成**单声道** 16-bit PCM WAV：参考样本只为复刻音色，声道数不携带音色信息，
// 单声道能省一半体积（设置文件里存的是 base64，体积直接翻倍）。
function encodeMono16Wav(audioBuffer) {
    const n = audioBuffer.length;
    const out = new ArrayBuffer(44 + n * 2);
    const v = new DataView(out);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, audioBuffer.sampleRate, true);
    v.setUint32(28, audioBuffer.sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    const chs = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) chs.push(audioBuffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < chs.length; c++) sum += chs[c][i];
        const s = Math.max(-1, Math.min(1, sum / chs.length));
        v.setInt16(o, s * 0x7fff, true); o += 2;
    }
    return out;
}
// 任意可解码音频 → WAV data URL；浏览器解不了会 reject
async function transcodeAudioBufferToWavDataUrl(arrayBuffer) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('当前浏览器不支持音频转码');
    const ac = new AC();
    try {
        const audioBuffer = await new Promise((resolve, reject) => {
            // 传副本：decodeAudioData 会 detach 传入的 ArrayBuffer
            ac.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
        });
        return MIMO_TTS_CLONE_WAV_PREFIX + arrayBufferToBase64(encodeMono16Wav(audioBuffer));
    } finally {
        try { await ac.close(); } catch (e) { /* 关闭失败无所谓 */ }
    }
}
let mimoCloneRepairing = false;
// 已存样本不是 wav → 异步转成 wav 再存（官方只稳支持 mp3/wav）。幂等：已是 wav 时什么都不做。
function repairMimoTtsCloneSamplePrefix() {
    const raw = String(state.settings.mimoTtsCloneSample || '');
    if (!raw || raw.startsWith(MIMO_TTS_CLONE_WAV_PREFIX)) return false;
    if (mimoCloneRepairing) return false;   // 防重入（转码完成回调里还会再刷一次状态）
    const comma = raw.indexOf(',');
    if (comma < 0) return false;
    let buf;
    try { buf = base64ToArrayBuffer(raw.slice(comma + 1)); } catch (e) { return false; }
    mimoCloneRepairing = true;
    transcodeAudioBufferToWavDataUrl(buf).then((wav) => {
        state.settings.mimoTtsCloneSample = wav;
        persistSettings();
    }).catch((e) => {
        console.warn('[MiMo TTS] 已存样本转码失败（保留原样）：', e);
    }).finally(() => {
        mimoCloneRepairing = false;
        updateMimoTtsCloneSampleStatusDisplay();
    });
    return true;
}

async function handleMimoTtsCloneSampleFileChange(event) {
    const input = event?.target;
    const file = input?.files?.[0];
    if (!file) return;
    if (file.size > MIMO_TTS_CLONE_SAMPLE_MAX_BYTES) {
        input.value = '';
        updateMimoTtsCloneSampleStatus(
            `文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 5 MB，请换更短的参考音频。`, true);
        showCustomAlert('参考音频样本上限为 5 MB（官方示例只需数秒）。请换一个更短的样本文件。', '样本过大');
        return;
    }
    try {
        const buf = await file.arrayBuffer();
        const fmt = mimoSampleFormatFromHead(new Uint8Array(buf.slice(0, 16)));
        console.log(`[MiMo TTS] 参考样本 ${file.name || '(未命名)'}：原始格式=${fmt} ${(file.size / 1024).toFixed(0)}KB → 转为 wav`);
        const dataUrl = await transcodeAudioBufferToWavDataUrl(buf);
        if (dataUrl.length > MIMO_TTS_CLONE_SAMPLE_MAX_BYTES * 1.5) {
            input.value = '';
            updateMimoTtsCloneSampleStatus('样本转码后过大，请换更短的参考音频（建议数秒）。', true);
            showCustomAlert('转码后的样本过大。请换一段更短的参考音频（官方示例只需数秒）。', '样本过大');
            return;
        }
        state.settings.mimoTtsCloneSample = dataUrl;
        state.settings.mimoTtsCloneSampleName = file.name || '';
        persistSettings();
        updateMimoTtsCloneSampleStatus();
    } catch (e) {
        console.warn('[MiMo TTS] 样本转码失败：', e);
        input.value = '';
        updateMimoTtsCloneSampleStatus('无法读取这个音频，请换 wav / mp3 文件。', true);
        showCustomAlert('无法解码这个参考音频（文件可能损坏或编码不受支持）。请换一个 wav 或 mp3 文件。', '样本无法读取');
    }
}

function clearMimoTtsCloneSample() {
    state.settings.mimoTtsCloneSample = '';
    state.settings.mimoTtsCloneSampleName = '';
    // 清掉之后本会话别再自动补内置样本 —— 用户是主动清的，
    //   不该马上又被塞回来。想恢复就点旁边的「内置样本」按钮。
    builtinCloneTriedThisSession = true;
    const input = document.getElementById('settingMimoTtsCloneSample');
    if (input) input.value = '';
    persistSettings();
    updateMimoTtsCloneSampleStatus();
}

// 只负责"刷新提示文案 + 占位符"，**不改写 Base URL 的值、也不锁成只读**。
// 按「请求模式」把输入框锁成只读并强行覆盖成预设地址的话，
// 用户想用自建中转时根本没地方改 —— 所以没有"请求模式"这个下拉。
