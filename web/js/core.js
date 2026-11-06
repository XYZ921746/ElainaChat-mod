// 基础设施：原生适配 / chat API 抽象 / 本机中转。

// 兼容旧 WebView（Chromium < 86 无 replaceChildren）
if (window.Element && !Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
        while (this.firstChild) this.removeChild(this.firstChild);
        for (var i = 0; i < arguments.length; i++) {
            var arg = arguments[i];
            this.appendChild(arg instanceof Node ? arg : document.createTextNode(String(arg)));
        }
    };
}


// 原生（Capacitor APK）Live2D 模型存储适配：APK 没有 Node 后端，/api/live2d/ 下接口在本机用 Capacitor Filesystem 实现。
const IS_NATIVE_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

// 这个浏览器有没有「安装到桌面」入口：判据只有会不会发 beforeinstallprompt，不用 UA 名单（套壳浏览器 UA 五花八门）。
let ownInstallEntryKnown = null;
function browserShowsOwnInstallEntry() {
    if (ownInstallEntryKnown !== null) return ownInstallEntryKnown;
    ownInstallEntryKnown = ('onbeforeinstallprompt' in window);
    return ownInstallEntryKnown;
}

// 运行环境事实（D5）：平台分支判断留在这里，对外只暴露与平台无关的语义（如 pwa.js 要问"能不能装成一个应用"）。
window.ElainaRuntime = {
    get isNativeShell() { return IS_NATIVE_APP; },
    // 安卓壳已经是 APK，再注册 SW 只会多一层缓存风险；地址栏自带安装入口的浏览器不再给按钮，只有 Firefox / 桌面 Safari 这类才需要。
    get canInstallAsApp() {
        return !IS_NATIVE_APP && !browserShowsOwnInstallEntry();
    },
};
const IS_MOBILE_DEVICE = (function () {
    try {
        if (IS_NATIVE_APP) return true;   // 安卓版 App 一律按手机处理
        const ua = String(navigator.userAgent || '');
        if (/Android|iPhone|iPad|iPod|Windows Phone|HarmonyOS|Mobile/i.test(ua)) return true;
        // iPadOS 13+ 的 UA 伪装成 Macintosh，靠触摸点数区分（iPad 5 点，Mac 0）。
        if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
    } catch (e) { /* 判断失败按电脑处理 */ }
    return false;
})();
const ASR_TARGET_SAMPLE_RATE = 16000;
const ASR_MAX_RECORD_SECONDS = 60;
const ASR_CLOUD_FINAL_TIMEOUT_MS = 20000;
const ASR_MIN_RMS = 0.006;
const ASR_MIN_ACTIVE_RATIO = 0.02;
const ASR_BAD_FINAL_TEXTS = new Set(['', '.', '。', '。.', '。。。', '我想想', '嗯', '啊', '哦']);

let asrMode = 'cloud-final-only';
let asrEnding = false;
let asrSubmitting = false;
let asrStarting = false;
let asrMediaStream = null;
let asrAudioContext = null;
let asrSourceNode = null;
let asrProcessorNode = null;
let asrRecordedChunks = [];
let asrRecordedSampleCount = 0;
let asrRecordedSquareSum = 0;
let asrRecordedPeak = 0;
let asrRecordedActiveSamples = 0;
let todayQuote = null;

function generateId() {
    return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
}


function getNativeByokHttpPlugin() {
    if (!window.Capacitor?.isNativePlatform?.()) return null;
    return window.Capacitor?.Plugins?.ByokHttp || null;
}

// 桌面/文档/下载 的真实位置由同源 serve.mjs 从注册表读出：用户可能移动过，AI 按惯例猜会失败。
let agentRootsProbe = null;
let agentRootsCache = null;
function detectAgentRoots() {
    if (agentRootsProbe) return agentRootsProbe;
    agentRootsProbe = (async () => {
        if (IS_NATIVE_APP) return null;
        if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
        try {
            const access = typeof currentAgentAccess === 'function' ? currentAgentAccess() : 'strict';
            const response = await fetchWithTimeout('/api/agent/roots?access=' + encodeURIComponent(access), { method: 'GET' }, 6000);
            if (!response.ok) return null;
            const info = await response.json();
            return info && info.ok && Array.isArray(info.roots) ? info.roots : null;
        } catch {
            return null;
        }
    })().then((roots) => {
        agentRootsCache = roots;
        // 只缓存成功：失败可能只是服务端在忙，缓存会整个会话拿不到真实路径。
        if (!roots) agentRootsProbe = null;
        return roots;
    });
    return agentRootsProbe;
}

// 同步取真实位置拼提示：提示词构造函数是同步的，只能读缓存；off 档电脑操作整体关闭，真实路径也不注入。
function agentRootsText() {
    if (typeof agentAccessDisabled === 'function' && agentAccessDisabled()) return '';
    const roots = Array.isArray(agentRootsCache) ? agentRootsCache.filter(r => r && r.path) : [];
    if (!roots.length) return '';
    return '\n# 这台电脑的真实位置（用户可能把桌面/文档移动过，**不要**按惯例猜 C:\\Users\\<用户名>\\Desktop）\n'
        + roots.map(r => `${r.label} = ${r.path}`).join('\n')
        + '\n需要这些位置时直接用上面的绝对路径，或用别名 %DESKTOP% / %DOCUMENTS% / %DOWNLOADS%（服务端会自动换成真实路径）。路径猜错会直接失败，所以不确定就先 [操作:列出文件 %DESKTOP%] 看一眼。';
}

function getChatApiFormat(settings = state.settings) {
    const format = String(settings.apiFormat || 'openai-compatible').toLowerCase();
    return CHAT_API_FORMATS[format] ? format : 'openai-compatible';
}

function stripThinkTags(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/\[think\][\s\S]*?\[\/think\]/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .trim();
}

function extractTextContent(content) {
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            return part?.text || part?.content || part?.transcript || '';
        }).join('');
    }
    return String(content ?? '');
}

function normalizeChatReply(content, reasoningContent = '', toolCalls = []) {
    const text = stripThinkTags(extractTextContent(content));
    const reasoning = String(reasoningContent || '').trim();
    // "只调工具、一个字不说"是合法回复，当空回复抛错会废掉工具通道。
    if (!text && Array.isArray(toolCalls) && toolCalls.length) return '';
    if (!text) {
        if (reasoning) {
            throw new ClientApiError('EMPTY_MODEL_OUTPUT', '模型只返回了思考内容，没有生成可见回复，请重试或缩短输出。');
        }
        throw new ClientApiError('EMPTY_MODEL_OUTPUT', '模型返回了空回复，请重试。');
    }
    return text;
}
// OpenAI Responses（/v1/responses）不是 chat/completions：系统提示走顶层 instructions，内容走 input 数组，
// 上限叫 max_output_tokens，回复在 output[] 里；字段名写错直接 400。

// 把开头连续的 system 合并成一条：有些网关只接受一条 system 且必须在位置 0（多条直接 400）
function mergeLeadingSystemMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    let end = 0;
    while (end < list.length && list[end] && list[end].role === 'system') end++;
    if (end <= 1) return list;
    const merged = list.slice(0, end)
        .map(message => extractTextContent(message.content))
        .filter(text => String(text || '').trim())
        .join('\n\n');
    return [{ role: 'system', content: merged }, ...list.slice(end)];
}

// 三种协议实现在 chat-providers.js：普通 <script> 作用域独立，依赖必须显式挂到 window，
    // 加新依赖要同步加到这里，漏了只会在运行到那一步炸（check-chat-providers.mjs 会扫 deps() 断言）。
window.ChatDeps = {
    ClientApiError,
    getChatBaseUrl,
    isDeepSeekOfficial,
    postJsonFromDevice,
    requestChatJson,
    buildThinkingParams,
    normalizeChatReply,
    throwProviderResponseError,
    extractTextContent,
    stripThinkTags,
    resolveOutputTokenLimit,
    ANTHROPIC_MIN_MAX_TOKENS,
};

async function callChatAPI(messages, opts = {}, settings = activeChatSettings()) {
    const format = getChatApiFormat(settings);
    if (!String(settings.apiKey || '').trim() && String(settings.dashscopeApiKey || '').trim()
        && /dashscope\.aliyuncs\.com/i.test(String(settings.baseUrl || ''))) {
        settings = Object.assign({}, settings, { apiKey: settings.dashscopeApiKey });
    }
    const normalized = mergeLeadingSystemMessages(messages);
    if (opts.replyInfo) {
        opts.replyInfo.toolCalls = [];
        opts.replyInfo.finishReason = '';
        opts.replyInfo.toolsSkipped = false;
        // 思考正文的兜底通道：流式失败退回非流式时 onDelta 不再触发，思考仍在响应体里（没有它这轮就等于"没有思考"）。
        opts.replyInfo.reasoning = '';
    }
    const resolvedOpts = Object.assign({}, opts, {
        maxTokens: resolveOutputTokenLimit(settings.model, opts.maxTokens, format === 'anthropic'),
        // 超时按是否开思考分开给（开思考时首个 token 可能等几分钟）；超时是空闲语义，服务端 RELAY_TIMEOUT_MAX 仍是硬上限。
        timeoutMs: Number.isFinite(opts.timeoutMs)
            ? opts.timeoutMs
            : (opts.thinking ? CHAT_TIMEOUT_THINKING_MS : CHAT_TIMEOUT_DEFAULT_MS),
    });
    // 只记 role 不记内容（可能含对话隐私与图片 base64），顺带记输出上限便于对 400。
    console.log(`[Chat] ${format} 发送 ${normalized.length} 条：${normalized.map(m => m && m.role).join(',')}，输出上限 ${Number.isFinite(resolvedOpts.maxTokens) ? resolvedOpts.maxTokens : '服务商默认'}`);
    // 按格式分发到 chat-providers.js 的 PROVIDERS 表；新增格式只改那边一处。
    return window.ChatProviders.forFormat(format)(normalized, resolvedOpts, settings);
}

// 取 Live2D 插件注册的服务；插件不在/停用时返回 null（D3）。
function live2dService() {
    try {
        return (window.ElainaMods && typeof window.ElainaMods.service === 'function')
            ? window.ElainaMods.service('live2d') : null;
    } catch (e) { return null; }
}

// 宿主内部接口（D14：插件系统唯一可依赖的宿主面）：集中声明承诺保持签名的入口；直接摸全局名会让宿主改名时插件运行时炸。
// 加新成员前先问它是不是该做成插槽或事件（D7）；本文件先于 ui.js/voice.js 执行，所以用 getter 惰性取值。
window.ElainaHost = {
    get version() { return '1.0.0'; },

    get state() {
        try { return (typeof state === 'undefined') ? null : state; } catch (e) { return null; }
    },

    get sendUserMessage() {
        try { return typeof handleUserInput === 'function' ? handleUserInput : null; } catch (e) { return null; }
    },
    get newId() {
        try { return typeof generateId === 'function' ? generateId : null; } catch (e) { return null; }
    },
    get autoNameConversation() {
        try { return typeof autoNameConversation === 'function' ? autoNameConversation : null; } catch (e) { return null; }
    },
    get refreshAutoConversationTitle() {
        try {
            return typeof refreshAutoConversationTitle === 'function' ? refreshAutoConversationTitle : null;
        } catch (e) { return null; }
    },
    get renderFolderList() {
        try { return typeof renderFolderList === 'function' ? renderFolderList : null; } catch (e) { return null; }
    },
    get updateCurrentConversationTitle() {
        try { return typeof updateCurrentConversationTitle === 'function' ? updateCurrentConversationTitle : null; } catch (e) { return null; }
    },
    get loadConversation() {
        try { return typeof loadConversation === 'function' ? loadConversation : null; } catch (e) { return null; }
    },
    get renderMessageText() {
        try { return typeof renderMessageText === 'function' ? renderMessageText : null; } catch (e) { return null; }
    },
    get showCustomAlert() {
        try { return typeof showCustomAlert === 'function' ? showCustomAlert : null; } catch (e) { return null; }
    },
    get showCustomConfirm() {
        try { return typeof showCustomConfirm === 'function' ? showCustomConfirm : null; } catch (e) { return null; }
    },

    // 语音（TTS）：插件念一段话走这里，不要直接调 speakText（D14 同一条理由）；供应商/Key/朗读稿都在宿主设置里，插件不该复制。
    get speech() {
        try {
            if (typeof speakText !== 'function') return null;
            return {
                get configured() {
                    try { return typeof isTtsConfigured === 'function' ? !!isTtsConfigured(state.settings) : false; }
                    catch (e) { return false; }
                },
                speak(text, opts) {
                    const o = opts || {};
                    const t = String(text == null ? '' : text).trim();
                    if (!t) { if (o.onEnd) o.onEnd(); return Promise.resolve({ empty: true }); }
                    const id = o.messageId || ('mod-speech-' + Date.now());
                    return startVoicePlaybackOnce(id, t, o.onStart || (() => {}), {
                        onEnd: () => { if (o.onEnd) o.onEnd(); },
                    });
                },
                stop() {
                    try {
                        if (typeof stopActiveVoicePlayback === 'function') return stopActiveVoicePlayback(true);
                    } catch (e) { /* 停不下来不该阻塞关闭 */ }
                    return Promise.resolve();
                },
            };
        } catch (e) { return null; }
    },

    // 语音输入（ASR）：插件"按一下说话"走这里，不要自己点宿主麦克风（ASR 是流式状态机，抢设备会出问题）。
    get dictation() {
        try {
            if (typeof handleMicClick !== 'function') return null;
            const st = () => { try { return (typeof state === 'undefined' ? '' : String(state.voiceState || 'idle')); } catch (e) { return 'idle'; } };
            return {
                get configured() {
                    try { return typeof canUseCloudFinalAsr === 'function' && !!canUseCloudFinalAsr(); }
                    catch (e) { return false; }
                },
                get state() { return st(); },
                toggle() { try { handleMicClick(); return true; } catch (e) { return false; } },
                start() {
                    try {
                        if (st() === 'idle') { handleMicClick(); return true; }
                        return false;      // 已经在听：不重复开麦
                    } catch (e) { return false; }
                },
                stop() {
                    try {
                        if (st() !== 'idle') { handleMicClick(); return true; }
                        return false;
                    } catch (e) { return false; }
                },
            };
        } catch (e) { return null; }
    },

    // 主题模板注册表（插件主题走 host.theme）；null 表示当前宿主没有主题系统。
    get theme() {
        try { return window.ElainaTheme || null; } catch (e) { return null; }
    },
    get achievements() {
        try { return window.ElainaAchievements || null; } catch (e) { return null; }
    },

    // 桌面壳桥（WebView2 宿主才有）：插件要开原生透明置顶窗只能经这里，自己摸 window.chrome.webview
    // 会把壳协议散进每个插件，壳改一次消息格式全坏。null = 当前不在壳里（纯浏览器），调用方自行兜底。
    get shellBridge() {
        try {
            const wv = window.chrome && window.chrome.webview;
            if (!wv || typeof wv.postMessage !== 'function') return null;
            return {
                /** 发一条扁平 JSON 消息给壳（壳侧只认白名单类型，未知类型忽略） */
                post(payload) {
                    try { wv.postMessage(payload); return true; } catch (e) { return false; }
                },
                /** 订阅壳发来的消息（mod-window-closed 等）；返回退订函数 */
                onMessage(cb) {
                    if (typeof wv.addEventListener !== 'function') return () => {};
                    const handler = (ev) => {
                        try { cb(ev.data); } catch (e) { /* 单个订阅者出错不断其它 */ }
                    };
                    wv.addEventListener('message', handler);
                    return () => { try { wv.removeEventListener('message', handler); } catch (e) { /* 忽略 */ } };
                },
            };
        } catch (e) { return null; }
    },

    // 打开宿主设置面板（应用内浮层插件也要能从自己的界面指到设置，如桌宠透明窗的弹出菜单）；
    // 插件自己摸设置页的全局函数会绕开设置页的开合状态机。
    get openAppSettings() {
        try { return typeof openSettings === 'function' ? openSettings : null; } catch (e) { return null; }
    },
};

