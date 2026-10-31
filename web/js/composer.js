/* ============================================================================
 * 输入框 / 发送与流式预览（从 voice.js 拆分）
 *
 * 输入图片、发送按钮、工具菜单、思考模式、流式预览、提交与语音输入。
 * ========================================================================== */
'use strict';

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
 * 整键变红会显得像报错，盖掉了"随时可停"这层意思。
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
 * 把「设置 → 模型」里的思考强度与第三人称同步成当前设置值。
 *
 * 思考开关**合并进"思考强度"档位**（off 就是不思考），
 *   所以这里只回填那个四档下拉，没有单独的勾选框。
 *   保留这个统一函数的原因不变：设置面板每次打开都要按 state 回填，
 *   而回填逻辑只该有一处 —— 散在各处必然有一天忘记同步新增的档位。
 */
function syncThinkingModeControls() {
    const effort = elements.settingThinkingEffort;
    if (effort) effort.value = THINKING_EFFORTS.includes(state.settings.thinkingEffort)
        ? state.settings.thinkingEffort
        : 'off';
    // 第三人称（两段式生成）：与思考强度同属「对话优化」块，一并回填。
    const thirdPerson = elements.settingThirdPerson;
    if (thirdPerson) thirdPerson.checked = Boolean(state.settings.thirdPerson);
    updateThinkingModeHint();
}

/**
 * 思考强度的说明文案：告诉用户**当前这个档位实际会变成什么请求**。
 *
 * 为什么要动态生成而不是写死一句：三种协议、四家厂商对"强度"的支持完全不同
 * （DeepSeek 只认 low/high/max；OpenAI 的 Responses 根本没有"关闭"这个取值；
 * OpenAI 的 reasoning_effort 又没有 max）。用户选了一档却发现没变化时，
 * 会以为功能坏了 —— 把"这一档对服务商意味着什么"直接写出来，比事后解释省事。
 */
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

//  流式正文预览
// 为什么需要"预览"这一层，而不是边收边往最终气泡里写：
// 回复完成后还要做几件事 —— Live2D 标签剥离、[任务:…] 抽取、
// 日语朗读稿拆分。这些都必须作用在**完整文本**上。
// 如果流式期间就把增量写进最终消息对象，那些处理会在"半截文本"上跑一遍，
// 结果就是标签被切开、朗读稿只译了前半句。
// 所以流式只负责"让用户先看见"，最终内容走那条在完整文本上做后处理的路径，
// 两者不交叉。

let streamedReplyText = '';
// 这一轮有没有从**流**里收到过思考增量。
//   用途只有一个：收尾时判断要不要拿非流式响应里的思考去补时间线（见 callAI 之后那段）。
//   为什么需要它：requestChatJson 在"流式一个字都没吐就失败"时会静默退回非流式，
//   那条路上 onDelta 再也不触发 —— 思考仍在响应体里，但没人把它交给时间线。
let streamedReasoningSeen = false;
// 这一轮"带了工具调用、正文先压着没渲染"的那条 AI 消息 id。
//   工具全部跑完后由 runToolCalls 收尾时把它显示出来（见 commitAiMessageOnce 里的说明）。
//   为空表示没有需要补显示的正文（普通回合、或模型一个字都没说）。
let pendingToolReplyMessageId = null;

/**
 * 把"等工具跑完再开口"的那条正文显示出来。
 *
 * 由 runToolCalls 在整批工具执行完之后调用（见那里的收尾段）。
 *
 * ── 与 DSH 的对照（这是本函数存在的理由）──────────────────────────────
 *
 * DSH 的 agent loop 把**每一步都当成一次独立模型调用**：
 *   模型发 tool_call 那一步的正文只是「中间产物」，它从不把那段话当最终回复；
 *   循环继续，工具结果进会话，**再调一次模型**，用户最终看到的是
 *   "已经知道结果"之后写的那句话。
 *
 * 本应用原来是反过来的：动手前那句话先渲染出去，工具跑完再**另起一条**
 * 消息说结果 —— 于是「我来做」和「好了」是两条独立气泡，接不上，
 * 而且先说的那句在结果出来之前就已经可见。
 *
 * 现在的做法贴住 DSH 的语义：
 *   · 这句话**先压着**（不渲染），工具跑完再决定要不要显示；
 *   · 若模型随后还会基于结果重新开口（续跑），那条新回复会**取代**它
 *     （见 replacePendingToolReply）—— 用户看到的始终是"知道结果之后"的那句话。
 *
 * @param {boolean} anySucceeded 这一批里有没有真的做成一件事。
 *   false 时**压住不显示**：那段正文是模型在动手之前写的结论
 *   （"喏，已经弄好了"），而这批操作一件都没成 —— 显示出去就是替它撒谎。
 */
function revealPendingToolReply(anySucceeded) {
    const id = pendingToolReplyMessageId;
    if (!id) return;
    pendingToolReplyMessageId = null;
    if (!anySucceeded) return;
    const conv = getCurrentConversation();
    if (!conv || state.currentConversationId !== conv.id) return;
    if (state.notesMode || state.diaryMode) return;
    if (document.getElementById(`msg-${safeAttrId(id)}`)) return;   // 已经渲染过
    const msg = (conv.messages || []).find((m) => String(m.id) === String(id));
    if (!msg || msg.hidden) return;
    renderMessage(msg);
    if (typeof elements !== 'undefined' && elements.conversationHistory) {
        elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
    }
}

/**
 * 续跑拿到"基于结果"的新正文时，用**它取代**那条"动手前"的正文。
 *
 * 为什么不是两条都留：那是两句话在讲同一件事，前一句还不知道结果
 * （"我来做"），后一句才知道（"好了"）。两条并排出现，读者会以为
 * AI 说了两遍，而且顺序上第一句是**没有依据**的 —— 它写在结果之前。
 * DSH 里根本不会出现这个问题：那一步的正文从不作为最终回复呈现。
 *
 * 做法：把动手前那条从对话里**移除**（它从未对用户可见，也不需要留在上下文里 ——
 * 真正的结果已经以 tool 消息的形式在会话里了），只保留新这条。
 * 若动手前那条已经被显示过（用户已经看见），则**不**移除 —— 把已经出现在
 * 屏幕上的话删掉，等于篡改他刚读到的内容。
 *
 * @returns {boolean} 是否发生了取代
 */
function replacePendingToolReply() {
    const id = pendingToolReplyMessageId;
    if (!id) return false;
    pendingToolReplyMessageId = null;
    const conv = getCurrentConversation();
    if (!conv) return false;
    // 已经渲染给用户看过 → 不删（删掉屏幕上已有的内容是不诚实的）
    if (document.getElementById(`msg-${safeAttrId(id)}`)) return false;
    const before = (conv.messages || []).length;
    conv.messages = conv.messages.filter((m) => String(m.id) !== String(id));
    if (conv.messages.length === before) return false;
    saveConversations();
    return true;
}

/**
 * 记下"这一轮还有一段话压着没说出来"，以及这一批操作到底成没成。
 *
 * 由 runToolCalls 在整批工具执行完之后调用（取代了"就地放出来"的做法）。
 *
 * 为什么要留到续跑才决定（对齐 DSH 的语义）：
 *   DSH 的 agent loop 把每一步都当成一次独立模型调用 —— 发 tool_call 那一步的正文
 *   只是中间产物，循环继续、工具结果进会话、**再调一次模型**，用户最终看到的是
 *   "已经知道结果"之后写的那句话。反过来做（先放正文、再另起一条说结果）会得到
 *   两条接不上的气泡，而且第一句写在结果之前、没有依据。
 *
 * 所以这里只记账，不渲染。放出/取代在续跑收尾处决定：
 *   · 续跑回了正文 → replacePendingToolReply() 取代它；
 *   · 续跑没回正文 → revealPendingToolReply() 兜底放出，免得"做完了却一声不吭"。
 *
 * @param {boolean} anySucceeded 这一批里有没有真做成一件事
 */
function agentMarkPendingReply(anySucceeded) {
    if (!pendingToolReplyMessageId) return;
    pendingToolReplySucceeded = Boolean(anySucceeded);
}

let pendingToolReplySucceeded = false;

/** 这条压着的正文能不能放出来（工具全失败时它是"动手前写的结论"，不能放） */
function canRevealPendingToolReply() {
    return Boolean(pendingToolReplyMessageId) && pendingToolReplySucceeded;
}

/** 续跑结束了：要么用新正文取代它，要么（没新正文时）把它兜底放出来 */
function settlePendingToolReply(hasNewReply) {
    if (!pendingToolReplyMessageId) return;
    if (hasNewReply) {
        // 新回复已经基于结果写好了 —— 那条"动手前"的话就该退场
        replacePendingToolReply();
        return;
    }
    // 续跑没给出正文：兜底放出来（否则用户看到"操作做完了，AI 一声不吭"）
    revealPendingToolReply(canRevealPendingToolReply());
}
let streamingPreviewEl = null;
let streamingPreviewScheduled = false;
// 打字机式渐进显示：已经"吐"给预览气泡的字符数（见 renderStreamingReplyPreview）。
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
 * 这里刻意**容错半截标签**：正在流入的 `<voice_jp>` 还没闭合时也要藏起来，
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
    // 用净化后的文本决定"有没有正文"：只有标签 / 只有朗读稿时**不能**收掉
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
                <img src="/icons/icon-192.png" alt="" draggable="false">
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
    // 流式期间用 **textContent 纯文本**，不用 renderMessageText 的 markdown 渲染
    //   ① renderMessageText 每帧对**不断增长的文本**做完整 markdown 解析
    //      （正则扫描 + marked.parse），越到后面越贵，主线程被塞满，
    //      后续增量排队、渲染卡顿 —— 看起来就是"时不时闪一下"。
    //   ② 半截 markdown（未闭合的 **、```、表格竖线）每帧解析出的 HTML 都不同，
    //      气泡高度疯狂跳动，视觉上内容"闪没又冒出来"。
    //   纯文本 + whitespace-pre-wrap 的观感已经足够流畅（用户就是要"先看见"），
    //   完整的富文本渲染只在回复完成时做一次（下面的正式渲染路径）。
    //   顺带去掉了预览容器的 animate-fade-in-up —— 每次会话它只创建一次，
    //   动画本身无害，但创建时机与 thinking 气泡的 200ms 淡出重叠时会叠影。
    // 打字机式渐进显示：
    //   text 是模型**已吐出的累计文本**（目标）；若直接整段写进去，模型吐多快就一次
    //   显示多少 —— 快模型一次返回一大句，看起来就是"一句一句蹦出来"。
    //   改成每帧只多显示一段，让观感回到逐字：
    //     · 每帧前进 max(1, 剩余/8) —— 落后越多追得越快：既顺滑（不会一格一格跳），
    //       又能追上模型（差额收敛到 0，不会越积越多直到结束时还剩一大截没显示）。
    //     · 只要还没显示完就再排下一帧，复用同一套 schedule（不新开第二套调度）。
    //   最终正式渲染（removeStreamingReplyPreview + renderMessage）用的是完整文本，
    //     不经过这里，绝不会被 revealedCount 截断。
    const step = Math.max(1, Math.ceil((text.length - revealedCount) / 8));
    // 净化会让文本**变短**（标签被剥掉）：此时 revealedCount 可能已经超过
    //   text.length，必须夹回来 —— 否则 slice 结果正常、但 revealedCount > length
    //   会让下面的 `revealedCount < text.length` 恒假、或让后续帧算出负的差额。
    revealedCount = Math.min(revealedCount, text.length);
    revealedCount = Math.min(text.length, revealedCount + step);
    if (target) target.textContent = text.slice(0, revealedCount);
    // 贴底跟随（用户在底部才滚）：这里每帧都会执行，无条件滚底会把
    //   "打字期间往上翻历史"的用户每帧拽回底部。与过程区共用同一份实现。
    stickChatScrollToBottom();
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
/**
 * 三条提交路径（语音 / 首屏输入框 / 会话输入框）共用的后半段：
 * 入队 → 转 thinking → 重载会话 → 按需刷新标题 → 交给 agent。
 * 各路径的差异（校验、取文本、清空输入）留在调用点；需要在重载前做的清理
 * 由 beforeLoad 插入，避免三份拷贝各自漂移。
 */
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

    commitUserMessage(conversation, message, () => {
        consumePendingComposerImage();
        document.getElementById('initialTextInput').value = '';
        updateComposerSendVisibility();
    });
}

/**
 * 发送/停止按钮的统一入口（DSH 式二态）：
 *   · AI 正在回复 → 停止（无论输入框有没有内容，按钮此时必须可见）
 *   · 否则 → 常规的发送
 */
function handleComposerButtonClick() {
    if (activeReplyAborts.size > 0) { stopAiReply(); return; }
    // 没在回复中 → 走常规发送
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

    commitUserMessage(conversation, message, () => {
        consumePendingComposerImage();
    });
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


