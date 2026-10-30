/* ========================================================================
 * 语音：识别 / 输入处理 / 停止按钮 / TTS
 * ======================================================================== */

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

    // 每次发送都算一次（不只是首条）：首条常是招呼语，话题往往在第二条才出现。
    if (refreshAutoConversationTitle(conversation)) {
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

    // 每次发送都算一次（不只是首条）：首条常是招呼语，话题往往在第二条才出现。
    if (refreshAutoConversationTitle(conversation)) {
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

    conversation.messages.push(message);
    consumePendingComposerImage();

    state.thinkingMessageId = message.id;

    loadConversation(conversation.id);

    // 每次发送都算一次（不只是首条）：首条常是招呼语，话题往往在第二条才出现。
    if (refreshAutoConversationTitle(conversation)) {
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
    // 原实现（maybeAutoFileWrite）会在把消息发给 AI **之前**做正则匹配，
    // 命中「写入/保存 + 文件/盘/D:\/.txt」就直接执行 —— 也就是**用户打的字本身
    // 就是触发源，与 AI 无关**。这带来三个问题：
    //   1. 绕过 AI：AI 全程不知情，对话里只有一条「【AI 操作结果】」；
    //   2. 正则误伤：聊到 `D:\...` 这种写法就可能被当成指令；
    //   3. 与授权脱节：写文件会弹确认框，但读/列目录不会 —— 用户感觉"我就说句话它怎么动了"。
    // 现在一律交给 AI 判断：由它决定要不要输出 [操作:…] 标签，
    // 行为可预测、AI 全程知情、也走同一条「停止 + 授权」管线。
    // （maybeAutoExpression 保留：它只驱动 Live2D 表情，不碰文件与系统。）
    maybeAutoExpression(String(message?.text || ''));
    const replyTaskKey = `${conversation.id}:${message.id}`;
    if (activeReplyTasks.has(replyTaskKey)) {
        console.log('[Chat] 忽略同一条用户消息的重复回复任务');
        return;
    }
    // 本轮回复的中断器：请求层与"输出中"的停止按钮都挂在这里。
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
            // 两段式（第三人称）时，chunk 上会带 `phase`：
            //   第 1 段的思考（GM 的推理）与第 2 段的思考（改写时的推理）
            //   分别进时间线、互不混合 —— 见 appendTurnReasoning。
            //   只有第 2 段的**正文**才进气泡（第 1 段正文是隐藏的中间产物，
            //   由 data 层拦住，不会走到这里）。
            onDelta: (chunk) => {
                if (chunk.kind === 'reasoning') {
                    // 记下"这一轮确实从流里收到过思考"，供收尾时对账：
                    //   一条都没收到才需要拿非流式响应里的正文补（见下面 replyInfo.reasoning）。
                    streamedReasoningSeen = true;
                    appendTurnReasoning(chunk.text, chunk.phase);
                    return;
                }
                if (chunk.kind !== 'text') return;
                streamedReplyText += chunk.text;
                scheduleStreamingReplyRender();
            },
            // 两段式生成的**阶段输出**：第一段（GM 叙述）与第二段（第一人称正文）
            // 各存一条，用户可以在过程区里分别展开对照。
            onPhase: (phase) => { recordTurnPhase(phase); }
        };
        // 工具通道：这一轮请求带上**当前可用**的工具清单（档位/开关/平台都已在
        // toolsForAccess 里收窄），并把"回复侧元信息"的容器交出去 —— 回来时从它读
        // 这次回复有没有 tool_calls。构造器在 agent.js（agentToolOptions），两处各写一份必然走样。
        const agentToolOpt = agentToolOptions();
        // 思考回传用的容器**独立于工具清单**：
        //   agentToolOptions() 在"没有可用工具"时返回 null（权限关着、手机没启用、
        //   供应商不认 tools），而思考跟工具没有关系 —— 关掉 Agent 权限不该连带
        //   让思考再也显示不出来。所以这里自己备一个，有工具时复用它那个。
        const replyInfo = (agentToolOpt && agentToolOpt.replyInfo) || {};
        const requestOpts = Object.assign({}, aiRequestOptions, agentToolOpt || {}, { replyInfo });
        // 可重试失败（超时 / 网络抖动 / 限流 / 上游 5xx）自动再试一次，重试过程
        // 写在思考气泡上 —— 静默重试会让「等了很久又重新等一遍」看起来像卡死，
        // 直接放弃则把一次瞬时故障变成用户看得见的失败，都不如说一声。
        // 只重试一次：连着失败多半是持续性原因（额度 / Key / 服务商故障），
        // 闷头重试只会白烧额度；那时的报错文案由 showClientApiError 负责。
        const RETRYABLE_CHAT_CODES = new Set([
            'REQUEST_TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMITED', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_UNAVAILABLE',
        ]);
        let rawResponse = null;
        let didRetry = false;
        streamedReasoningSeen = false;
        for (let attempt = 0; ; attempt++) {
            try {
                rawResponse = await callAI(message.text, requestOpts);
                break;
            } catch (chatError) {
                // 用户停止优先于一切重试判断（按了停止还自己再发一次是倒行逆施）
                if (chatError?.name === 'AbortError' || replyAbort.signal.aborted) throw chatError;
                const retryable = chatError instanceof ClientApiError && RETRYABLE_CHAT_CODES.has(chatError.code);
                if (!retryable || attempt >= 1) {
                    if (didRetry) chatError.message = String(chatError.message || chatError.code || '')
                        + '（已自动重试 1 次，仍失败）';
                    throw chatError;
                }
                didRetry = true;
                console.warn('[Chat] 请求失败（' + chatError.code + '），自动重试 1 次：', chatError.message);
                updateThinkingMessageText('模型响应不稳定（' + (chatError.message || chatError.code) + '），正在自动重试…');
                // 限流时等久一点再重发，立刻重发只会撞在同一个限流窗口上
                await new Promise((r) => setTimeout(r, chatError.code === 'RATE_LIMITED' ? 2000 : 1000));
                if (replyAbort.signal.aborted) throw chatError;
                // 重试是全新一次请求：流式状态必须清零，否则上一次的半截增量
                // 会留在预览与过程区里，与新回复拼出重复内容。
                streamedReasoningSeen = false;
                resetStreamingReplyPreview();
            }
        }
        // 思考对账：**只有流里一条都没收到**时才用响应体里的补。
        //   为什么必须补：requestChatJson 在流式还没吐出任何内容就失败时会静默退回
        //   非流式（见那里的注释）。那条路上 onDelta 不再触发，于是思考明明在响应体里
        //   （openai-compatible 的 reasoning_content / anthropic 的 thinking block /
        //   responses 的 reasoning item），却没有任何东西把它交给时间线 ——
        //   用户看到的是"这次没有思考"，而真实原因是换了条传输路径。
        //   为什么只在没收到时才补：流式成功时这些增量已经逐段进了时间线，
        //   再补一遍会让同一段思考出现两次。
        if (!streamedReasoningSeen) {
            const fallbackReasoning = String(replyInfo.reasoning || '').trim();
            if (fallbackReasoning) appendTurnReasoning(fallbackReasoning, null);
        }
        const parsedReply = wantsJp ? splitVoiceReply(rawResponse) : { displayText: rawResponse, voiceJp: '' };
        const response = parsedReply.displayText;
        // **不要**在这里无条件收掉流式预览。
        //   同步模式（simultaneous）下正文要等语音真正开播才提交，而 TTS 生成
        //   本身要等好几秒 —— 在这里就拆预览的话，那几秒屏幕上
        //   **一片空白**（三点气泡早在第一个增量到达时就被预览顶掉了），
        //   用户看到的是"字打完 → 消失 → 等 → 又出现"。
        //   所以交给 commitAiMessageOnce 在渲染正式消息前收（见下），
        //   预览正好无缝交接给正式气泡。
        // ⚠️ 这里**不能**收尾过程区：工具调用是在下面的 commitAiMessageOnce 里才执行的
        //   （协议要求 assistant 的 tool_calls 之后才紧跟结果）。在这里 finishTurnTrace 会把
        //   done 提前置位，而那时 tools 还是空的 —— 没开思考的回合因此整个过程区被跳过
        //   （renderTurnProcess 在"无思考、无工具、无阶段"时直接 return），
        //   于是"即使没开思考，工具调用成功也要显示"这条要求落空：用户只看到气泡，看不到它动了什么。
        //   收尾改由 commitAiMessageOnce 在 runToolCalls 排上之后负责（见那里）；
        //   本回合**没有**工具调用时，才在这里立刻收尾。

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
        // 走宿主的 ElainaTags，**不再**经过 Live2D 插件全局名 ——
        //   旧写法是插件在时才 `drive(); stripTags();`，
        //   而 drive() 是全部 [操作:] 标签的唯一分发器（文件/命令/手机/记忆）。
        //   于是"Live2D 不在"就等于"整个 Agent 系统失效 + 标签漏给用户看"。
        //   现在剥离与分发都归宿主，Live2D 只提供表现（表情/动作/口型）。
        // 这一回合走哪条通道：**回复里有工具调用就走工具，否则才解析标签**。
        //   两条都跑会让同一个动作执行两次 —— 模型偶尔既发工具调用、又在正文里写标签。
        const repliedToolCalls = (agentToolOpt && agentToolOpt.replyInfo
            && Array.isArray(agentToolOpt.replyInfo.toolCalls)) ? agentToolOpt.replyInfo.toolCalls : [];
        if (repliedToolCalls.length) {
            // 调用本身要挂到这条 AI 消息上：下一次请求必须带上它 ——
            //   OpenAI 要求 assistant 的 tool_calls 后面紧跟对应的结果，缺了会被上游拒收。
            aiMessage.toolCalls = repliedToolCalls;
            // 模型只说"我去做"、一个字没写时，这条消息不该在聊天记录里占一个空气泡；
            //   但它**必须**留在消息数组里（协议顺序），所以标 hidden。
            if (!String(response).trim()) aiMessage.hidden = true;
        }
        if (window.ElainaTags) {
            // 剥离永远要做：即便走工具通道，正文里万一混了标签也不能漏给用户。
            const stripped = window.ElainaTags.strip(response);
            if (stripped !== response) aiMessage.text = stripped;
            if (!repliedToolCalls.length) window.ElainaTags.drive(response);
        }
        // 本回合没有工具调用 → 过程区这时就是最终内容，立刻收尾（与原来同一时机）。
        //   有工具调用时**不**在这里收尾：tool_calls 还没执行（见 commitAiMessageOnce），
        //   提前收尾会让工具行永远显示不出来（见上面那段说明）。
        if (!repliedToolCalls.length) finishTurnTrace();
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
            // 正式气泡就位前收掉流式预览 —— 顺序不能反：先 renderMessage 再收，
            //   中间那一瞬两个气泡并存（同一段话显示两遍）；先收再渲染则是无缝交接。
            //   放在这里而不是更早，是为了让同步模式的 TTS 等待期仍有正文可看。
            removeStreamingReplyPreview();
            conversation.messages.push(aiMessage);
            conversation.updatedAt = new Date().toISOString();
            saveConversations();
            // 不要在这里放"用户说写入你想说的话就把 AI 回复写进文件"这类自动写入：
            //   它只会被 maybeAutoFileWrite 触发，而那个函数又只从这里调用 ——
            //   是一个永不可达的死分支。
            //   这个需求由 AI 输出 [操作:保存文件 …] 完成。
            renderFolderList();
            updateCurrentConversationTitle();
            removeThinkingMessage();
            if (state.currentConversationId === conversation.id && !aiMessage.hidden
                && !state.notesMode && !state.diaryMode && !document.getElementById(`msg-${safeAttrId(aiMessage.id)}`)) {
                // 这一轮带工具调用 → **先不显示正文**，等工具跑完再统一开口。
                //   为什么必须这样：模型常在同一个回复里**先说结论、再发调用**
                //   （实测："喏，文件已经在那儿了" + save_file）。那段话在工具执行前
                //   就渲染出去了，于是用户先看到"已经建好了"，随后工具失败 ——
                //   界面上变成"它说成功了，但下面那行写着失败"，而模型自己也只能
                //   在续跑里尴尬地道歉。先说后做，顺序本身就是错的。
                //   做法：正文照旧进 conversation.messages（协议要求 assistant 的
                //   tool_calls 必须有对应消息，不能删），但**先不渲染**；等这一批工具
                //   全部执行完，由 runToolCalls 收尾时统一显示。结果确定之后再说话，
                //   说的才可能是真话。
                //   注意只能延迟、不能丢弃：如果工具全成功，用户要看到的正是这段话。
                if (!repliedToolCalls.length) renderMessage(aiMessage);
                else pendingToolReplyMessageId = aiMessage.id;
            }
            state.voiceState = 'idle';
            updateUI();

            // 工具调用要在**这条消息入队之后**才执行：结果是以 role:'tool' 追加到后面的，
            //   协议要求它紧跟 assistant 的 tool_calls —— 顺序反了上游会拒收。
            // （这个函数是幂等的，多次调用只会触发一次。）
            if (repliedToolCalls.length) {
                void runToolCalls(repliedToolCalls, { access: currentAgentAccess() });
            }

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
            // Live2D：AI 开始说话 → 嘴动（经宿主服务，不直接点插件全局名）
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
                // Live2D：AI 说完 → 闭嘴
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
                // TTS 失败但正文必须留下：
                //   同步模式（simultaneous）的语义是"语音开始播时正文才出现"，
                //   上面那句 `commitAiMessageOnce()` 挂在 handleVoiceStart 里 ——
                //   也就是说**只有 TTS 真的出声了，回复才会被提交**。
                //   所以在这里不能只弹一句"回复没有显示"就 return：
                //   那样用户白等一次完整请求（可能几分钟），正文一个字都看不到，
                //   聊天记录里连痕迹都不留 —— 看起来就是
                //   "必须语音生成成功才能发送全部消息"。
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
            // 同上：TTS 失败绝不能让正文与聊天记录一起消失。
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
        // 已在上游记录过详情的错误不再重复打：
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


