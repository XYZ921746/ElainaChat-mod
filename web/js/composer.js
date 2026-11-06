// 输入框 / 发送与流式预览：输入图片、发送按钮、工具菜单、思考模式、提交与语音输入。
'use strict';

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
    // AI 回复期间按钮必须始终可见（此时它是「停止」），不能因为输入框空了就缩回去。
    const busy = activeReplyAborts.size > 0;
    setSendButtonVisibility(elements.initialSendBtn, busy || Boolean(elements.initialTextInput.value.trim()) || hasContent);
    setSendButtonVisibility(elements.conversationSendBtn, busy || Boolean(elements.textInput.value.trim()) || hasContent);
    // busy 态换掉图标并加 .is-stopping，但整键不变红：那会像报错，盖掉"随时可停"的意思。
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

// 同一个图标槽：发送态右箭头，回复中换暂停（整键不变红，否则像报错）。
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

function toggleComposerToolsMenu(button, menu) {
    const opening = menu.classList.contains('hidden');
    closeComposerToolsMenu();
    if (opening) {
        menu.classList.remove('hidden');
        button.setAttribute('aria-expanded', 'true');
    }
}

// 思考开关合并进"思考强度"档位（off 就是不思考），回填逻辑只该有一处，否则新增档位会漏同步。
function syncThinkingModeControls() {
    const effort = elements.settingThinkingEffort;
    if (effort) effort.value = THINKING_EFFORTS.includes(state.settings.thinkingEffort)
        ? state.settings.thinkingEffort
        : 'off';
    const thirdPerson = elements.settingThirdPerson;
    if (thirdPerson) thirdPerson.checked = Boolean(state.settings.thirdPerson);
    updateThinkingModeHint();
}

// 强度说明动态生成：三种协议对"强度"的支持不同，用户选了没变化会以为功能坏了。
function updateThinkingModeHint() {
    const hint = elements.thinkingModeHint;
    if (!hint) return;
    const effort = THINKING_EFFORTS.includes(state.settings.thinkingEffort) ? state.settings.thinkingEffort : 'off';
    if (effort === 'off') {
        hint.textContent = '已关闭思考：请求会显式告诉服务商「不要思考」（DeepSeek 服务端默认是开的，所以必须显式关闭）。';
        return;
    }
    const label = { low: '低（快速）', high: '高（均衡）', max: '极高（深度）' }[effort] || effort;
    hint.textContent = `当前向服务商请求「${label}」强度；不认这一档的服务商会忽略它（OpenAI 没有 max，「极高」会自动降到 high）。`;
}

// 流式预览：增量只让用户先看见，最终正文必须走完整文本的后处理（标签剥离 / 任务抽取 / 朗读稿拆分）。
let streamedReplyText = '';
// 这一轮有没有从流里收到过思考增量：流式失败静默退回非流式时 onDelta 不再触发，收尾要靠它决定是否补思考。
let streamedReasoningSeen = false;
// 这一轮"带了工具调用、正文先压着没渲染"的消息 id，为空表示没有要补显示的正文。
let pendingToolReplyMessageId = null;

// 把"等工具跑完再开口"的正文显示出来：那段正文先压着，工具跑完才决定放不放，
// 若模型基于结果重新开口则由 replacePendingToolReply 取代它。anySucceeded 为 false 时压住不显示。
function revealPendingToolReply(anySucceeded) {
    const id = pendingToolReplyMessageId;
    if (!id) return;
    pendingToolReplyMessageId = null;
    if (!anySucceeded) return;
    const conv = getCurrentConversation();
    if (!conv || state.currentConversationId !== conv.id) return;
    if (state.notesMode || state.diaryMode || state.memoryPageMode) return;
    if (document.getElementById(`msg-${safeAttrId(id)}`)) return;   // 已经渲染过
    const msg = (conv.messages || []).find((m) => String(m.id) === String(id));
    if (!msg || msg.hidden) return;
    renderMessage(msg);
    if (typeof elements !== 'undefined' && elements.conversationHistory) {
        elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
    }
}

// 续跑拿到"基于结果"的新正文时用它取代动手前那条；已被用户看见过的则不移除（删屏幕上已有的内容不诚实）。
function replacePendingToolReply() {
    const id = pendingToolReplyMessageId;
    if (!id) return false;
    pendingToolReplyMessageId = null;
    const conv = getCurrentConversation();
    if (!conv) return false;
    if (document.getElementById(`msg-${safeAttrId(id)}`)) return false;
    const before = (conv.messages || []).length;
    conv.messages = conv.messages.filter((m) => String(m.id) !== String(id));
    if (conv.messages.length === before) return false;
    saveConversations();
    return true;
}

// 记账：这一轮有一段正文压着、以及这批操作成没成。放出还是取代由续跑收尾处决定。
function agentMarkPendingReply(anySucceeded) {
    if (!pendingToolReplyMessageId) return;
    pendingToolReplySucceeded = Boolean(anySucceeded);
}

let pendingToolReplySucceeded = false;

function canRevealPendingToolReply() {
    return Boolean(pendingToolReplyMessageId) && pendingToolReplySucceeded;
}

function settlePendingToolReply(hasNewReply) {
    if (!pendingToolReplyMessageId) return;
    if (hasNewReply) {
        replacePendingToolReply();
        return;
    }
    revealPendingToolReply(canRevealPendingToolReply());
}
let streamingPreviewEl = null;
let streamingPreviewScheduled = false;
// 已经"吐"给预览气泡的字符数；只作用于预览，最终正文用完整文本，别拿它截断。
let revealedCount = 0;

function resetStreamingReplyPreview() {
    streamedReplyText = '';
    streamingPreviewEl = null;
    streamingPreviewScheduled = false;
    revealedCount = 0;
}

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

// 净化半截文本：增量按字节流切，标签会被切成几段，正式 strip 只在完整文本上跑一次。
// 必须容错半截标签，否则内部协议与朗读稿会在"正在输入"那几秒先露出来。
function sanitizeStreamingPreviewText(text) {
    let out = String(text || '');
    if (window.ElainaTags && typeof window.ElainaTags.strip === 'function') {
        out = window.ElainaTags.strip(out);
    } else {
        out = out.replace(/\[(表情|动作|情绪|位置|大小|背景|操作|任务)[:：][^\]]*\]/g, '');
    }
    out = out.replace(/<voice_jp>[\s\S]*?<\/voice_jp>/gi, '');
    out = out.replace(/<voice_jp>[\s\S]*$/i, '');
    out = out.replace(/<scene>[^<\n]*<\/scene>/gi, '');
    out = out.replace(/<scene>[^<\n]*$/i, '');
    out = out.replace(/\[(?:表情|动作|情绪|位置|大小|背景|操作|任务)[:：][^\]]*$/g, '');
    return out;
}

function renderStreamingReplyPreview() {
    if (!elements.conversationHistory) return;
    // 只有标签/朗读稿时不能收掉三点气泡，否则会出现"气泡没了、正文也没来"的空窗。
    const text = sanitizeStreamingPreviewText(streamedReplyText);
    if (!text) return;
    removeThinkingMessage();
    if (!streamingPreviewEl) {
        streamingPreviewEl = document.createElement('div');
        streamingPreviewEl.id = 'streaming-reply-preview';
        streamingPreviewEl.className = 'flex gap-3 mb-4 animate-fade-in-up';
        streamingPreviewEl.innerHTML = `
            <div class="pixso-chat-avatar" aria-hidden="true">${aiAvatarInnerHtml()}</div>
            <div class="flex-1 min-w-0">
                <div class="bubble-ai rounded-2xl p-4">
                    <div class="flex items-center gap-2 mb-2">
                        <span class="ai-speaker-name">${escapeHtml(typeof conversationBotName === 'function' ? conversationBotName(getCurrentConversation()) : (state.characterCard?.name || '伊蕾娜'))}</span>
                        <span class="text-xs text-indigo-300">正在输入…</span>
                    </div>
                    <p class="text-indigo-950 text-sm leading-relaxed whitespace-pre-wrap typing-cursor" id="streaming-reply-text"></p>
                </div>
            </div>
        `;
        elements.conversationHistory.appendChild(streamingPreviewEl);
    }
    const target = streamingPreviewEl.querySelector('#streaming-reply-text');
    // 预览用 textContent 纯文本：markdown 每帧重解析会越来越贵，且半截 markdown 会让气泡高度跳动。
    const step = Math.max(1, Math.ceil((text.length - revealedCount) / 8));
    // 净化会让文本变短，revealedCount 必须夹回来，否则后续帧会算出负差额。
    revealedCount = Math.min(revealedCount, text.length);
    revealedCount = Math.min(text.length, revealedCount + step);
    if (target) target.textContent = text.slice(0, revealedCount);
    // 贴底跟随：每帧都会执行，无条件滚底会把"打字期间往上翻历史"的用户每帧拽回底部。
    stickChatScrollToBottom();
    if (revealedCount < text.length) scheduleStreamingReplyRender();
}

function removeStreamingReplyPreview() {
    const el = streamingPreviewEl || document.getElementById('streaming-reply-preview');
    // 先重置状态再淡出：正文已到达（真气泡随后整列重渲），预览壳只是视觉收尾。
    resetStreamingReplyPreview();
    if (!el || !el.isConnected) return;
    el.classList.add('animate-overlay-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // animationend 兜底（标签页切后台动画冻结时也要摘掉）
    setTimeout(() => { if (el.isConnected) el.remove(); }, 300);
}

// 三条提交路径共用的后半段；各路径的差异留在调用点，重载前要做的清理走 beforeLoad。
function commitUserMessage(conversation, message, beforeLoad) {
    conversation.messages.push(message);
    state.thinkingMessageId = message.id;
    if (beforeLoad) beforeLoad();
    loadConversation(conversation.id);
    // 每次发送都算一次（不只是首条）：首条常是招呼语，话题往往在第二条才出现。
    if (refreshAutoConversationTitle(conversation)) {
        renderFolderList();
        updateCurrentConversationTitle();
    }
    state.voiceState = 'thinking';
    updateUI();
    handleUserInput(message, conversation);
}

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

    commitUserMessage(conversation, message);
}

function handleInitialTextSubmit() {
    if (composerImageProcessing) return;
    if (state.notesMode || state.diaryMode || state.memoryPageMode) return;
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

    commitUserMessage(conversation, message, () => {
        consumePendingComposerImage();
        document.getElementById('initialTextInput').value = '';
        updateComposerSendVisibility();
    });
}

// 发送/停止二态：回复中一律停止（按钮此时必须可见），否则走常规发送。
function handleComposerButtonClick() {
    if (activeReplyAborts.size > 0) { stopAiReply(); return; }
    if (typeof handleTextSubmit === 'function' && !elements.initialState || (elements.initialState && elements.initialState.classList.contains('hidden'))) {
        handleTextSubmit();
    } else {
        handleInitialTextSubmit();
    }
}

function handleTextSubmit() {
    if (composerImageProcessing) return;
    if (state.notesMode || state.diaryMode || state.memoryPageMode) return;
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

    commitUserMessage(conversation, message, () => {
        consumePendingComposerImage();
    });
    elements.textInput.value = '';
    updateComposerSendVisibility();
}

function isTtsConfigured(settings = state.settings) {
    const provider = String(settings.ttsProvider || 'mimo');
    // MiMo TTS 用自己的付费 Key（mimoTtsApiKey），没有 Key 不能用。
    if (provider === 'mimo') {
        if (!String(settings.mimoTtsApiKey || '').trim()) return false;
        // v2.5 三个模型必需的"音色"来源不同：预置音色 / 音色描述 / 参考音频样本
        const model = String(settings.mimoTtsModel || 'mimo-v2.5-tts').trim();
        if (model === 'mimo-v2.5-tts-voiceclone') return Boolean(String(settings.mimoTtsCloneSample || '').trim());
        if (model === 'mimo-v2.5-tts-voicedesign') return Boolean(String(settings.mimoTtsVoiceDesignPrompt || '').trim());
        return Boolean(String(settings.mimoTtsVoice || '').trim());
    }
    if (provider === 'openai-tts') {
        return Boolean(String(settings.openaiTtsApiKey || '').trim());
    }
    if (provider === 'dashscope') {
        return Boolean(String(settings.dashscopeApiKey || '').trim() && String(settings.dashscopeTtsVoice || '').trim());
    }
    return Boolean(String(settings.minimaxApiKey || '').trim() && String(settings.minimaxVoice || '').trim());
}


