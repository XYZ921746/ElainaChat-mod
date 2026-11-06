/* 自定义弹窗：通用 Modal / 输入框 / 预设 / 代码编辑器 / 提示与确认 / 会话移动。 */
'use strict';

// 全应用只有这一个 #customModal 节点、层级被样式表写死为最上层：多路弹窗并发时后到者会把先到者顶掉，先到者的 Promise 再没人 resolve、调用方永远挂住，故这里串行化。

let customModalQueue = [];
let customModalActive = false;

// 统一的弹层显隐工具：入场动画由各面板 markup 上的 animate-modal-pop / mm-dialog-in 自备，
// 这里只补两件事 —— 打开时清掉上一次没播完的退场；关闭时整层淡出再 hidden（直接 hidden
// 是瞬灭，眼睛跟不上）。淡出期间 .animate-overlay-out 自带 pointer-events:none 防连点，
// animationend 与兜底定时器保证一定收尾（标签页切后台时动画会冻结）。
function cancelOverlayOut(el) {
    if (el && el._overlayOutCancel) { el._overlayOutCancel(); el._overlayOutCancel = null; }
}

function openOverlayPanel(el) {
    if (!el) return;
    cancelOverlayOut(el);
    el.classList.remove('animate-overlay-out');
    el.classList.remove('hidden');
    el.classList.add('flex');
}

function closeOverlayPanel(el, onDone) {
    if (!el) { if (typeof onDone === 'function') onDone(); return; }
    cancelOverlayOut(el);
    if (el.classList.contains('hidden')) { if (typeof onDone === 'function') onDone(); return; }
    const finish = () => {
        cancelOverlayOut(el);
        el.classList.add('hidden');
        el.classList.remove('flex');
        if (typeof onDone === 'function') onDone();
    };
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        finish();
        return;
    }
    const onAnimationEnd = (event) => { if (event.target === el) finish(); };
    el.addEventListener('animationend', onAnimationEnd);
    const timer = setTimeout(finish, 300);
    el._overlayOutCancel = () => {
        el.removeEventListener('animationend', onAnimationEnd);
        clearTimeout(timer);
    };
    el.classList.add('animate-overlay-out');
}

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
        setTimeout(drainCustomModalQueue, 0);
    });
}

function refreshCodeEditor(els) {
    const ta = els.customModalInput;
    if (!ta) return;
    const text = ta.value;
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

/** 弹窗输入区：代码编辑器 / 多行 / 单行三种形态共用同一批元素，其显隐、行号刷新、滚动同步必须成组切换。 */
function setupModalInput(elements, { useEditor, defaultValue, placeholder, rows }) {
    const target = useEditor
        ? elements.customModalInput                        // 代码编辑器用 textarea
        : (elements.customModalPlainInput || elements.customModalInput);   // 单行用 input
    target.value = defaultValue;
    target.placeholder = placeholder;
    if (useEditor) {
        const ta = elements.customModalInput;
        ta.rows = Math.max(3, Number(rows) || 12);
        refreshCodeEditor(elements);
        ta.oninput = () => refreshCodeEditor(elements);
        // 行号跟随 textarea 的滚动：textarea 是唯一的滚动容器，行号栏用 transform 位移（它自己没有滚动条）。
        ta.onscroll = () => {
            const g = elements.customModalGutter;
            if (g) g.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
        };
    } else {
        elements.customModalInput.oninput = null;
        elements.customModalInput.onscroll = null;
    }
}

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

/** 输入态的键盘提交：多行 / 编辑器里 Enter 换行、Ctrl/Cmd+Enter 提交；单行 Enter 提交。 */
function bindModalInputKeys(elements, { input, multiline, useEditor, readValue, activeInput, finish }) {
    if (!input) return;
    activeInput().onkeydown = (e) => {
        // 多行 / 代码编辑器里 Enter 是**换行**，提交用 Ctrl/Cmd+Enter。⚠️ 判据必须包含 editor：MCP 弹窗走的是 editor 模式、multiline 是 undefined，只看 multiline 会让 Enter 直接提交、打不出换行。
        if (e.key === 'Enter' && (multiline || useEditor)) {
            if (e.ctrlKey || e.metaKey) {
                const val = readValue();
                finish(val);
            }
            return;
        }
        // 输入法组合态下 Enter 是"选词"而不是提交 —— 不挡掉的话，中文输入会把半截拼音直接提交出去（keyCode 229 是老 WebView 上组合态的信号）。
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
            const val = readValue();
            finish(val);
        }
        if (e.key === 'Escape') finish(null);
    };
    setTimeout(() => {
        activeInput().focus();
        // 多行输入**不全选**：整段 JSON 被高亮成一块色块，一按键就覆盖整份配置；光标落到末尾即可。
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
        // 多行输入：粘贴 JSON / 命令序列时必需；rows 是期望行数，实际高度由 CSS 的 max-height 兜底。
        multiline = false, rows = 8,
        editor = false, language = 'json', presets = null,
        extraAction = null,
        // 可选第三键：altText 非空就显示、点了 resolve 成 altValue。手机操作「运行方式」是三选一，而取消键还会被"点遮罩 / 关弹窗"触发 —— 把"后台"绑到取消上，用户手指一滑点到遮罩就等于默默用了后台。
        altText = '', altValue = 'alt' } = opts;
    elements.customModalTitle.textContent = title;
    // 弹窗文案按轻量 Markdown 渲染（**强调**、`代码`、链接）：inline() 先整体转义再拼标签，安全边界与 textContent 相同，换行交给 whitespace-pre-wrap。
    elements.customModalMessage.innerHTML = (window.ElainaReadme && window.ElainaReadme.inline)
        ? window.ElainaReadme.inline(message)
        : escapeHtml(message);
    elements.customModalMessage.classList.toggle('hidden', !message);
    const useEditor = Boolean(input && editor);
    elements.customModalEditor?.classList.toggle('hidden', !useEditor);
    elements.customModalPlainInput?.classList.toggle('hidden', !input || useEditor);
    elements.customModalInput.classList.toggle('hidden', !input);
    if (input) setupModalInput(elements, { useEditor, defaultValue, placeholder, rows });
    renderModalPresets(elements, presets, useEditor);
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

    openOverlayPanel(elements.customModal);
    // 取值：代码编辑器 / 多行用 textarea，单行用 input —— 统一走这里，避免"改了弹窗形态但值还从旧元素读"（会读到空串）。
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
        closeOverlayPanel(elements.customModal);
        elements.customModalCancelBtn.onclick = null;
        elements.customModalAltBtn.onclick = null;
        elements.customModalConfirmBtn.onclick = null;
        activeInput().onkeydown = null;
        done(value);
    };

    // 弹窗按钮的这次点击不能继续往上冒：宿主在 document 上有「点抽屉外面就收抽屉」的监听，弹窗叠在抽屉之上 —— 不拦的话，从抽屉里新建文件夹 / 重命名之后抽屉会立刻收起来，接着要拖进去就无从下手。
    const stopBubble = (event) => { if (event && event.stopPropagation) event.stopPropagation(); };

    elements.customModalCancelBtn.onclick = (event) => { stopBubble(event); finish(input ? null : false); };
    elements.customModalAltBtn.onclick = (event) => { stopBubble(event); finish(altValue); };

    elements.customModalConfirmBtn.onclick = (event) => {
        stopBubble(event);
        if (input) {
            const val = readValue();
            finish(val === null || val === undefined ? null : val);
        } else {
            finish(true);
        }
    };
    bindModalInputKeys(elements, { input, multiline, useEditor, readValue, activeInput, finish });
}

/** 本次要移动的对话：单个（会话菜单）与批量（首页多选）共用一条路径。 */
let conversationMoveTargetIds = [];

function closeConversationMoveDialog() {
    conversationMoveTargetIds = [];
    closeOverlayPanel(elements.conversationMoveOverlay);
}

/** 打开「分类」面板：单个（会话菜单）与批量（首页多选）共用一条路径 —— 展示的是同一份分类排序、同一个「新建文件夹」；各写一份的话改分类顺序就得改两处。 */
function openConversationMoveDialog(convId, batchIds, onMoved) {
    const ids = Array.isArray(batchIds) && batchIds.length ? batchIds.slice() : (convId ? [convId] : []);
    if (!ids.length || !elements.conversationMoveOverlay) return;
    // 同一张弹层也拿来当"按对话筛选"的选择器（见 mobile-shell.js），打开移动弹窗时把标题恢复为「分类」。
    const moveTitle = document.getElementById('conversationMoveTitle');
    if (moveTitle) moveTitle.textContent = '分类';
    const single = ids.length === 1 ? state.conversations.find(c => c.id === ids[0]) : null;
    if (ids.length === 1 && !single) return;
    closeConversationContextMenu();
    conversationMoveTargetIds = ids;
    elements.conversationMoveList.innerHTML = '';

    const moveAll = (categoryId) => {
        const targets = conversationMoveTargetIds.slice();
        closeConversationMoveDialog();
        targets.forEach(id => moveConversationToCategory(id, categoryId));
        if (typeof onMoved === 'function') onMoved();
    };

    const createRow = document.createElement('button');
    createRow.type = 'button';
    createRow.className = 'conversation-move-option is-create';
    createRow.innerHTML = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7.5A2.5 2.5 0 016.5 5h3.2l1.6 2h6.2A2.5 2.5 0 0120 9.5v7A2.5 2.5 0 0117.5 19h-11A2.5 2.5 0 014 16.5v-9z"/><path stroke-linecap="round" d="M12 11v5M9.5 13.5h5"/></svg><span>新建文件夹…</span>';
    createRow.addEventListener('click', async () => {
        const name = await showCustomPrompt('新建文件夹名称：');
        if (!name || !name.trim()) return;
        const cat = await createCategory(name.trim());
        if (!cat) return;
        moveAll(cat.id);
    });
    elements.conversationMoveList.appendChild(createRow);

    const options = [{ id: '', name: '未分类' }, ...state.categories.filter(c => !c.isUnfiled).slice().sort((a, b) => a.order - b.order)];
    options.forEach(option => {
        const categoryId = option.id;
        const isCurrent = !!single && (single.categoryId || '') === categoryId;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `conversation-move-option${isCurrent ? ' is-current' : ''}`;
        button.innerHTML = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3.5 7.5h6l1.8 2H20.5v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg><span>${escapeHtml(option.name)}</span>`;
        button.addEventListener('click', () => moveAll(categoryId || null));
        elements.conversationMoveList.appendChild(button);
    });
    openOverlayPanel(elements.conversationMoveOverlay);
}

function showCustomAlert(message, title = '提示') {
    return showCustomModal({ title, message, showCancel: false });
}

/** 一条**不会挡住操作**的提示条（只读提醒，不是弹窗）：自定义弹窗串行排队、被顶掉的那条不会自己消失，而保存失败往往连着发生，排队的弹窗会一直糊在界面上；提示条自建节点、自己计时消失，同时只留一条。 */
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



