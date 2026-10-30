/* ============================================================================
 * 自定义弹窗（从 ui.js 拆分）
 *
 * 通用 Modal / 输入框 / 预设 / 代码编辑器 / 提示与确认 / 会话移动。
 * ========================================================================== */
'use strict';

// ==================== 自定义Modal ====================
// 全应用只有这一个 #customModal 节点，层级被样式表写死为最上层。多路弹窗并发时若各自直接改这个节点，
//   后到者会把先到者整块顶掉，先到者的 Promise 再没人 resolve、调用方永远挂住
//   （例如语音失败提示与 agent 敏感操作确认同时到达时，操作确认被顶掉、agent 卡死在等待里）。
// 所以这里**串行化**：新请求入队，前一个 settle 后再开下一个。

let customModalQueue = [];
let customModalActive = false;

function showCustomModal(opts) {
    return new Promise(resolve => {
        customModalQueue.push({ opts, resolve });
        drainCustomModalQueue();
    });
}

function drainCustomModalQueue() {
    if (customModalActive) return;
    const next = customModalQueue.shift();
    if (!next) return;
    customModalActive = true;
    openCustomModal(next.opts, value => {
        customModalActive = false;
        next.resolve(value);
        // 挪到下一帧再开下一个：让本次点击的事件循环先收尾，避免同步递归。
        setTimeout(drainCustomModalQueue, 0);
    });
}

function refreshCodeEditor(els) {
    const ta = els.customModalInput;
    if (!ta) return;
    const text = ta.value;
    // 行号：至少 1 行；末尾换行不该多出一行空号
    const lineCount = Math.max(1, text.split('\n').length);
    const gutter = els.customModalGutter;
    if (gutter && gutter.childElementCount !== lineCount) {
        // 只在行数变化时重建，避免每次按键都动 DOM（手机上很敏感）
        gutter.textContent = '';
        const frag = document.createDocumentFragment();
        for (let i = 1; i <= lineCount; i++) {
            const d = document.createElement('div');
            d.textContent = String(i);
            frag.appendChild(d);
        }
        gutter.appendChild(frag);
    }
}

/**
 * 弹窗输入区：代码编辑器 / 多行 / 单行三种形态共用同一批元素。
 * 三种形态的显隐、行号刷新、滚动同步必须成组切换 —— 散在主流程里最容易漏掉
 *   "切到单行后 oninput 还挂着"这种残留。
 */
function setupModalInput(elements, { useEditor, defaultValue, placeholder, rows }) {
    const target = useEditor
        ? elements.customModalInput                        // 代码编辑器用 textarea
        : (elements.customModalPlainInput || elements.customModalInput);   // 单行用 input
    target.value = defaultValue;
    target.placeholder = placeholder;
    if (useEditor) {
        const ta = elements.customModalInput;
        ta.rows = Math.max(3, Number(rows) || 12);
        // 首次渲染行号与高亮；后续每次输入由 input 事件刷新
        refreshCodeEditor(elements);
        ta.oninput = () => refreshCodeEditor(elements);
        // 行号跟随 textarea 的滚动。textarea 是唯一的滚动容器，
        //   行号栏用 transform 位移（它自己没有滚动条，改 scrollTop 不生效）。
        ta.onscroll = () => {
            const g = elements.customModalGutter;
            if (g) g.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
        };
    } else {
        elements.customModalInput.oninput = null;
        elements.customModalInput.onscroll = null;
    }
}

/** 模板按钮：点一下把编辑区换成该模板；非编辑器形态或没有模板时整块隐藏。 */
function renderModalPresets(elements, presets, useEditor) {
    if (!elements.customModalPresets) return;
    const box = elements.customModalPresets;
    const list = Array.isArray(presets) ? presets : [];
    box.classList.toggle('hidden', !useEditor || !list.length);
    box.textContent = '';
    for (const p of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn-secondary text-xs';
        b.textContent = p.label;
        b.title = p.hint || '';
        b.addEventListener('click', () => {
            const ta = elements.customModalInput;
            ta.value = p.value;
            refreshCodeEditor(elements);
            ta.focus();
        });
        box.appendChild(b);
    }
}

/** 输入态的键盘提交：多行/编辑器里 Enter 换行，Ctrl/Cmd+Enter 提交；单行 Enter 提交。 */
function bindModalInputKeys(elements, { input, multiline, useEditor, readValue, activeInput, finish }) {
    if (!input) return;
    activeInput().onkeydown = (e) => {
        // 多行 / 代码编辑器里 Enter 是**换行**，提交用 Ctrl/Cmd+Enter。
        //   ⚠️ 判据必须包含 editor：MCP 弹窗走的是 editor 模式，multiline 是 undefined，
        //   只看 multiline 会让 Enter 直接提交、打不出换行（实测 0 字符）。
        if (e.key === 'Enter' && (multiline || useEditor)) {
            if (e.ctrlKey || e.metaKey) {
                const val = readValue();
                finish(val);
            }
            return;
        }
        if (e.key === 'Enter') {
            const val = readValue();
            finish(val);
        }
        if (e.key === 'Escape') finish(null);
    };
    setTimeout(() => {
        activeInput().focus();
        // 多行输入**不全选**：整段 JSON 被高亮成一块色块，一按键就覆盖整份配置。
        //   光标落到末尾即可，想全选自己 Ctrl+A。
        if (multiline || useEditor) {
            const len = readValue().length;
            activeInput().setSelectionRange(len, len);
        } else {
            activeInput().select();
        }
    }, 50);
}

function openCustomModal(opts, done) {
    const { title = '提示', message = '', input = false, defaultValue = '', placeholder = '', confirmText = '确定', cancelText = '取消', showCancel = true,
        // 多行输入：粘贴 JSON / 命令序列时必需（单行只能左右滚，看不清结构）。
        //   rows 是期望行数，实际高度由 CSS 的 max-height 兜底。
        multiline = false, rows = 8,
        // 代码编辑器：带行号与 JSON 高亮。presets 是「一键填模板」的按钮组。
        editor = false, language = 'json', presets = null,
        // 额外动作按钮（如 MCP 的「测试连接」）：{ text, onClick(value, api), closeOnClick }
        //   onClick 拿到**当前输入内容**，可以在不关闭弹窗的情况下做验证。
        extraAction = null,
        // 可选第三键。altText 非空就显示；点了 **resolve 成 altValue**。
        //   为什么需要它：手机操作的「运行方式」是三选一（前台 / 后台 / 取消），
        //   而取消键还会被"点遮罩 / 关弹窗"触发 —— 把"后台"绑到取消上，
        //   用户手指一滑点到遮罩就等于默默用了后台。
        altText = '', altValue = 'alt' } = opts;
    elements.customModalTitle.textContent = title;
    // 弹窗文案按轻量 Markdown 渲染（**强调**、`代码`、链接）——文案里写的是
    //   README 习惯的记号，textContent 会把 ** 裸奔到用户面前。
    //   inline() 先整体转义再拼标签，安全边界与 textContent 相同，只是多了排版。
    //   换行交给元素上的 whitespace-pre-wrap，这里不处理。
    elements.customModalMessage.innerHTML = (window.ElainaReadme && window.ElainaReadme.inline)
        ? window.ElainaReadme.inline(message)
        : escapeHtml(message);
    elements.customModalMessage.classList.toggle('hidden', !message);
    // 三种输入形态：代码编辑器 / 多行文本 / 普通单行
    const useEditor = Boolean(input && editor);
    elements.customModalEditor?.classList.toggle('hidden', !useEditor);
    elements.customModalPlainInput?.classList.toggle('hidden', !input || useEditor);
    elements.customModalInput.classList.toggle('hidden', !input);
    if (input) setupModalInput(elements, { useEditor, defaultValue, placeholder, rows });
    // 模板按钮：点一下把编辑区换成该模板
    renderModalPresets(elements, presets, useEditor);
    // 额外动作按钮：插在「取消」前面，只在传了 extraAction 时出现
    if (elements.customModalExtraBtn) {
        if (extraAction && extraAction.text) {
            elements.customModalExtraBtn.textContent = extraAction.text;
            elements.customModalExtraBtn.classList.remove('hidden');
            elements.customModalExtraBtn.disabled = false;
            elements.customModalExtraBtn.onclick = async () => {
                if (typeof extraAction.onClick !== 'function') return;
                // 交给调用方决定是否关窗；按钮在等待期间禁用，避免重复点击
                elements.customModalExtraBtn.disabled = true;
                const original = elements.customModalExtraBtn.textContent;
                try {
                    await extraAction.onClick(readValue(), {
                        setText: (t) => { elements.customModalExtraBtn.textContent = t; },
                        close: () => finish(readValue()),
                    });
                } finally {
                    elements.customModalExtraBtn.disabled = false;
                    elements.customModalExtraBtn.textContent = original;
                }
            };
        } else {
            elements.customModalExtraBtn.classList.add('hidden');
            elements.customModalExtraBtn.onclick = null;
        }
    }
    elements.customModalCancelBtn.textContent = cancelText;
    elements.customModalConfirmBtn.textContent = confirmText;
    elements.customModalCancelBtn.classList.toggle('hidden', !showCancel);
    elements.customModalAltBtn.textContent = altText;
    elements.customModalAltBtn.classList.toggle('hidden', !altText);

    elements.customModal.classList.remove('hidden');
    elements.customModal.classList.add('flex');
    // 层级不在这里设：.modal-overlay 上的 z-index !important 会让内联值完全失效，
    // 写了也不会真的生效（任何按状态算内联 z-index 的分支都是死代码）。
    // 真正的分层写在样式表的
    // 「弹窗之间的层叠顺序必须写死」那段 —— #customModal 是 100003，永远在最上面。

    // 取值：代码编辑器 / 多行用 textarea，单行用 input —— 两者是不同元素，
    //   统一走这里，避免"改了弹窗形态但值还从旧元素读"（会读到空串）。
    const readValue = () => (elements.customModalPlainInput && !elements.customModalPlainInput.classList.contains('hidden'))
        ? elements.customModalPlainInput.value
        : elements.customModalInput.value;
    const activeInput = () => (elements.customModalPlainInput && !elements.customModalPlainInput.classList.contains('hidden'))
        ? elements.customModalPlainInput
        : elements.customModalInput;

    let settled = false;
    const finish = (value) => {
        if (settled) return;
        settled = true;
        elements.customModal.classList.add('hidden');
        elements.customModal.classList.remove('flex');
        elements.customModalCancelBtn.onclick = null;
        elements.customModalAltBtn.onclick = null;
        elements.customModalConfirmBtn.onclick = null;
        activeInput().onkeydown = null;
        done(value);
    };

    elements.customModalCancelBtn.onclick = () => finish(input ? null : false);
    elements.customModalAltBtn.onclick = () => finish(altValue);

    elements.customModalConfirmBtn.onclick = () => {
        if (input) {
            const val = readValue();
            finish(val === null || val === undefined ? null : val);
        } else {
            finish(true);
        }
    };
    bindModalInputKeys(elements, { input, multiline, useEditor, readValue, activeInput, finish });
}

let conversationMoveTargetId = null;

function closeConversationMoveDialog() {
    conversationMoveTargetId = null;
    if (!elements.conversationMoveOverlay) return;
    elements.conversationMoveOverlay.classList.add('hidden');
    elements.conversationMoveOverlay.classList.remove('flex');
}

function openConversationMoveDialog(convId) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv || !elements.conversationMoveOverlay) return;
    closeConversationContextMenu();
    conversationMoveTargetId = convId;
    elements.conversationMoveList.innerHTML = '';
    const options = [{ id: '', name: '未分类' }, ...state.categories.filter(c => !c.isUnfiled).slice().sort((a, b) => a.order - b.order)];
    options.forEach(option => {
        const categoryId = option.id;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `conversation-move-option${(conv.categoryId || '') === categoryId ? ' is-current' : ''}`;
        button.innerHTML = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3.5 7.5h6l1.8 2H20.5v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg><span>${escapeHtml(option.name)}</span>`;
        button.addEventListener('click', () => {
            moveConversationToCategory(convId, categoryId || null);
            closeConversationMoveDialog();
        });
        elements.conversationMoveList.appendChild(button);
    });
    elements.conversationMoveOverlay.classList.remove('hidden');
    elements.conversationMoveOverlay.classList.add('flex');
}

function showCustomAlert(message, title = '提示') {
    return showCustomModal({ title, message, showCancel: false });
}

/**
 * 一条**不会挡住操作**的提示条（只读提醒，不是弹窗）。
 *
 * 为什么不用 showCustomAlert：自定义弹窗是**串行排队**的，被它顶掉的那条不会自己消失，
 *   而保存失败往往连着发生（每一次 flush 都失败）—— 排队的弹窗会一直糊在界面上，
 *   用户连"导出备份"都点不到。提示条自建节点，自己计时消失。
 *
 * 同一时间只留一条：失败提示反复触发时只刷新文字与倒计时，不叠一层又一层。
 */
let storeAlertEl = null;
let storeAlertTimer = null;
function showStoreSaveAlert(text) {
    if (!document.body) return;
    if (!storeAlertEl || !storeAlertEl.isConnected) {
        storeAlertEl = document.createElement('div');
        storeAlertEl.id = 'storeSaveAlert';
        storeAlertEl.setAttribute('role', 'status');
        storeAlertEl.setAttribute('aria-live', 'polite');
        storeAlertEl.className = 'store-save-alert';
        document.body.appendChild(storeAlertEl);
    }
    const title = text.code === 'KEY_TOO_LARGE' ? '数据太大，没能保存' : '没能保存';
    // 服务端文案本身就以"保存失败"开头（那里要给 API 调用方看），这里不再重复一次：
    //   拼出"没能保存：保存失败（…）"会让人以为出了两个问题。
    const body = String(text.message || '').replace(/^保存失败[：:]\s*/, '');
    storeAlertEl.textContent = title + '：' + body + '（这条提示会自动消失；问题没解决前请勿关闭页面）';
    storeAlertEl.classList.add('is-visible');
    if (storeAlertTimer) clearTimeout(storeAlertTimer);
    storeAlertTimer = setTimeout(() => {
        storeAlertTimer = null;
        if (storeAlertEl) storeAlertEl.classList.remove('is-visible');
    }, 12000);
}

function showCustomConfirm(message, title = '确认') {
    return showCustomModal({ title, message });
}

function showCustomPrompt(message, defaultValue = '', placeholder = '') {
    return showCustomModal({ title: '输入', message, input: true, defaultValue, placeholder });
}



