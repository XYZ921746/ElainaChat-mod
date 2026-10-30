/* ========================================================================
 * 界面：收藏 / 语笺 / 弹窗 / 会话 / 侧边栏 / 消息渲染
 * ======================================================================== */

// ==================== 日志（设置里的独立分栏） ====================
// 日志不是页面模式：它是设置面板里的分栏（#tab-log），面板打开时聊天区本来就藏着 ——
//   所以不需要 state.logMode 与 enterLogMode/exitLogMode，只由 init.js 的 switchSettingsTab() 调 LogViewer.open()/close()。

function showInitialState() {
    state.notesMode = false;
    state.diaryMode = false;
    elements.settingsOverlay.classList.add('hidden');
    elements.settingsOverlay.classList.remove('flex');
    elements.chatHeader.classList.remove('hidden');
    elements.chatHeader.setAttribute('aria-hidden', 'false');
    elements.initialState.classList.remove('hidden');
    elements.conversationHistory.classList.add('hidden');
    elements.inputBar.classList.add('hidden');
    elements.notesPage.classList.add('hidden');
    elements.diaryPage.classList.add('hidden');
    elements.floatingMic.classList.add('hidden');
    const greetingEl = document.getElementById('greetingText');
    if (greetingEl) greetingEl.textContent = '';
    updateCurrentConversationTitle();
    greetingTyping = false;
    startGreetingTyping();
    syncRailActive();
    syncMainHeaderVisibility();
}


// ==================== 侧边栏渲染====================

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/`/g, '&#96;');
}

// 内联 onclick 里嵌 id 用的消毒：只保留字母数字和 - _
// （注意：不能靠 escapeHtml 把 ' 转成 &#39; —— HTML 解析器会先把属性值里的实体解码，
//   再交给 JS 解析，' 依然会闭合字符串。所以这里做的是白名单剔除。）
function safeAttrId(id) {
    return String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * 把 AI 回复的文本渲染成 HTML：Markdown 子集 + LaTeX 公式（离线，无网络依赖）。
 *
 * 为什么需要它（从上游 v1.3.1 合并过来的能力）：
 *   · 模型很爱输出 `**加粗**`、`- 列表`、```代码块```、表格与数学公式。
 *     按纯文本 `whitespace-pre-wrap` 显示的话，这些标记会原样露出，
 *     读起来很吵。Markdown 渲染是上游界面的重要体验改进。
 *   · Galgame mod 也依赖它（对话框要渲染富文本），所以它属于**宿主能力**，
 *     不能放进某个 mod 里 —— 那样别的 mod 用不到，且 mod 停用就没了。
 *
 * 安全（这是关键，不能为了好看牺牲它）：
 *   ① 渲染器（web/js/readme-view.js）把输入一律当**纯文本** Markdown：
 *      所有文本先转义再拼标签，原始 HTML 只会以字面量出现，不经过任何 HTML 解析。
 *      这与"先 escapeHtml 再交给 marked"是同一个意图，但不再依赖调用顺序 ——
 *      上游那条路只要有一处忘了先转义，就是模型输出直接变成页面上可执行的标签。
 *   ② 数学公式在转义后用占位符换出，避免 $...$ 里的内容被 Markdown 误解析，
 *      也避免 KaTeX 拿到已被转义的源码。
 *   ③ 渲染器或 katex 不可用（脚本没加载、离线失败）就**静默回落**到
 *      纯文本转义 —— 宁可少个样式，也不能白屏或抛错。
 *   ④ 代码块原样保留，不做任何 Markdown 处理。
 *
 * @param {string} text 原始文本
 * @returns {string} 可安全插入 innerHTML 的 HTML
 */
function renderMessageText(text) {
    const raw0 = String(text == null ? '' : text);

    // ① 先把三反引号围栏整体挖出来占位，避免后续正则误伤代码块里的内容
    const FENCE = String.fromCharCode(96, 96, 96);
    const PH0 = String.fromCharCode(0xE100), PH1 = String.fromCharCode(0xE101);
    const fences = [];
    let raw = raw0.replace(new RegExp(FENCE + '[\\s\\S]*?' + FENCE, 'g'), (m) => {
        fences.push(m);
        return PH0 + (fences.length - 1) + PH1;
    });

    // ② 剥掉独占一行的场景标记（Galgame 的内部指令，不该显示给用户）
    raw = raw.replace(/^[ \t]*<scene>[^<\n]{0,64}<\/scene>[ \t]*$/gim, '').trim();

    // ③ 把围栏放回来
    raw = raw.replace(new RegExp(PH0 + '(\\d+)' + PH1, 'g'), (m, i) => fences[Number(i)] || '');

    const R = window.ElainaReadme;
    if (!R || typeof R.renderChat !== 'function') return escapeHtml(raw);

    // ④ 数学公式先换成占位符：Markdown 会吃掉 $...$ 里的 * _ 之类字符，
    //    而 KaTeX 需要的是原始 TeX 源码。
    //    顺序：先把成对的 $$...$$ 挖走，再处理单个 $...$，
    //    否则 `$$x$$` 会被当成两个行内公式。
    const mathStore = [];
    const PH = (k) => '\uE000' + k + '\uE001';
    const withPh = String(raw)
        .replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => {
            mathStore.push({ tex, d: true });
            return PH(mathStore.length - 1);
        })
        .replace(/(^|[^\\$])\$([^$\n]{1,200})\$/g, (m, pre, tex) => {
            mathStore.push({ tex, d: false });
            return pre + PH(mathStore.length - 1);
        });

    let html;
    try { html = R.renderChat(withPh); }
    catch (e) { return escapeHtml(raw); }

    // ⑤ 公式换回 KaTeX。katex 不可用时还原成原来的 $...$ 文本（至少不丢内容）
    return html.replace(/\uE000(\d+)\uE001/g, (m, i) => {
        const it = mathStore[Number(i)];
        if (!it) return m;
        if (window.katex && typeof window.katex.renderToString === 'function') {
            try {
                return window.katex.renderToString(it.tex, { displayMode: !!it.d, throwOnError: false });
            } catch (e) { /* 落到下面的原文 */ }
        }
        return escapeHtml(it.d ? '$$' + it.tex + '$$' : '$' + it.tex + '$');
    });
}

function conversationPreviewText(conv) {
    const lastMsg = Array.isArray(conv.messages) && conv.messages.length
        ? conv.messages[conv.messages.length - 1]
        : null;
    return (lastMsg ? String(lastMsg.text || lastMsg.content || '') : '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[`*_>#]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 56) || '还没有消息';
}

function conversationItemMarkup(conv, previewText) {
    return `
        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1">
                <span class="text-sm font-medium truncate text-indigo-900">${escapeHtml(conv.title)}</span>
                ${conv.isPinned ? '<svg class="conversation-pin-icon w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-label="置顶"><path stroke-linecap="round" stroke-linejoin="round" d="M8 3h8l-.7 5.2 3.7 3.3v1.1H5v-1.1l3.7-3.3L8 3zM12 12.6V21"/></svg>' : ''}
                ${conv.isStarred ? '<span class="text-[10px] text-amber-500">⭐</span>' : ''}
            </div>
            <div class="conv-preview">${escapeHtml(previewText)}</div>
        </div>
        <span class="conv-time">${new Date(conv.updatedAt).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })}</span>
        <div class="conversation-inline-actions flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onclick="event.stopPropagation(); toggleStar('${safeAttrId(conv.id)}')" class="conversation-favorite-btn p-1 hover:bg-white/70 rounded-lg" title="${conv.isStarred ? '取消收藏' : '收藏'}" aria-label="${conv.isStarred ? '取消收藏' : '收藏'}">
                <svg class="w-3.5 h-3.5 ${conv.isStarred ? 'text-amber-500 fill-current' : 'text-indigo-300'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>
            </button>
            <div class="conversation-secondary-actions flex items-center gap-0.5">
                <button onclick="event.stopPropagation(); togglePin('${safeAttrId(conv.id)}')" class="p-1 hover:bg-white/70 rounded-lg" title="${conv.isPinned ? '取消置顶' : '置顶'}">
                    <svg class="w-3.5 h-3.5 ${conv.isPinned ? 'text-pink-500' : 'text-indigo-300'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
                </button>
                <button onclick="event.stopPropagation(); renameConversation('${safeAttrId(conv.id)}')" class="p-1 hover:bg-white/70 rounded-lg" title="重命名">
                    <svg class="w-3.5 h-3.5 text-indigo-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                </button>
                <button onclick="event.stopPropagation(); deleteConversation('${safeAttrId(conv.id)}')" class="p-1 hover:bg-white/70 rounded-lg" title="删除">
                    <svg class="w-3.5 h-3.5 text-red-300 hover:text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
            </div>
        </div>
    `;
}

function bindConversationItemEvents(div, conv) {
    div.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        if (isMobileConversationLayout() && Date.now() < suppressConversationClickUntil) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        closeConversationContextMenu();
        // **在日记页时**点侧栏的对话不跳去聊天，
        //   而是把这本日记**筛选/滚动到那段对话的分组** ——
        //   "聊天记录本身就是一种分类"。
        //   为什么用"筛选"而不是"跳走"：用户此时正在看日记，
        //   点一下只是想"看这段对话的日记"，把他踢去聊天页等于打断当前意图。
        //   而在**非**日记页时行为完全不变（照旧进对话）—— 这是关键，
        //   否则日常切换对话会被弄坏（那是最常用的操作）。
        if (state.diaryMode && typeof focusDiaryGroup === 'function') {
            focusDiaryGroup(conv.id);
            return;
        }
        switchConversation(conv.id);
    });
    div.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', conv.id);
        e.dataTransfer.effectAllowed = 'move';
        div.classList.add('opacity-50');
    });
    div.addEventListener('dragend', () => {
        div.classList.remove('opacity-50');
    });
}

function bindConversationLongPress(div, conv) {
    let longPressTimer = null;
    let longPressStartX = 0;
    let longPressStartY = 0;
    let longPressOpened = false;
    const cancelLongPress = () => {
        if (longPressTimer) window.clearTimeout(longPressTimer);
        longPressTimer = null;
    };
    div.addEventListener('pointerdown', (event) => {
        if (!isMobileConversationLayout() || !event.isPrimary || event.target.closest('button')) return;
        cancelLongPress();
        longPressOpened = false;
        longPressStartX = event.clientX;
        longPressStartY = event.clientY;
        longPressTimer = window.setTimeout(() => {
            longPressTimer = null;
            longPressOpened = true;
            suppressConversationClickUntil = Date.now() + 800;
            openConversationContextMenu(conv.id, div);
        }, 520);
    });
    div.addEventListener('pointermove', (event) => {
        if (!longPressTimer) return;
        if (Math.hypot(event.clientX - longPressStartX, event.clientY - longPressStartY) > 9) {
            cancelLongPress();
        }
    });
    div.addEventListener('pointerup', () => {
        if (longPressOpened) suppressConversationClickUntil = Date.now() + 800;
        longPressOpened = false;
        cancelLongPress();
    });
    div.addEventListener('pointercancel', () => {
        longPressOpened = false;
        cancelLongPress();
    });
    div.addEventListener('pointerleave', cancelLongPress);
    div.addEventListener('contextmenu', (event) => {
        if (!isMobileConversationLayout() || event.target.closest('button')) return;
        event.preventDefault();
        cancelLongPress();
        longPressOpened = true;
        suppressConversationClickUntil = Date.now() + 800;
        if (conversationContextMenu && conversationContextTarget === div) return;
        openConversationContextMenu(conv.id, div);
    });
}

function createConversationItem(conv) {
    const div = document.createElement('div');
    // 日记页里"选中"的是**筛选中的那段对话**。
    //   日记页点对话只筛选、不跳转，所以 `state.currentConversationId`
    //   **不会**变 —— 只看它的话，用户在日记页点了对话，侧栏
    //   **没有任何高亮**（看起来像没点中），必须回聊天页才正常。
    //   所以日记页时把 diaryFilterConvId 也算作"当前项"。
    //   两个状态各管各的语义，但**视觉上都是"你正在看这一段"**，
    //   所以共用同一个高亮样式。
    const activeId = state.diaryMode ? (state.diaryFilterConvId || '') : state.currentConversationId;
    const isActive = conv.id === activeId;
    div.className = `conversation-item group flex items-center gap-2 px-2.5 py-2 rounded-xl cursor-pointer transition-all text-sm ${isActive ? 'sidebar-item-active' : 'hover:bg-white/50'}`;
    div.draggable = !isMobileConversationLayout();
    div.dataset.convId = conv.id;
    bindConversationItemEvents(div, conv);
    bindConversationLongPress(div, conv);
    div.innerHTML = conversationItemMarkup(conv, conversationPreviewText(conv));
    return div;
}

function renderFolderList() {
    const kw = (elements.sidebarSearchInput.value || '').trim().toLowerCase();
    closeConversationContextMenu();
    elements.folderList.innerHTML = '';

    const countEl = document.getElementById('convCountLabel');
    if (countEl) countEl.textContent = state.conversations.length + ' 段旅途 · ' + state.categories.length + ' 个分类';

    if (state.conversations.length === 0 && state.categories.length === 0) {
        elements.folderList.innerHTML = `
            <div class="text-center py-16">
                <p class="text-base font-semibold text-indigo-700 leading-relaxed">还没有对话</p>
                <p class="text-xs text-indigo-300 leading-relaxed mt-1.5">和伊蕾娜开启一段旅途吧</p>
            </div>
        `;
        return;
    }

    const matchesSearch = (conv) => {
        if (!kw) return true;
        return (conv.title || '').toLowerCase().includes(kw);
    };

    const pinned = state.conversations.filter(c => c.isPinned && matchesSearch(c));
    const regular = state.conversations.filter(c => !c.isPinned && matchesSearch(c));
    const pinnedIds = new Set(pinned.map(c => c.id));
    const unfiled = regular.filter(c => !c.categoryId);

    const renderConversationList = (list) => {
        const wrap = document.createElement('div');
        wrap.className = 'space-y-0.5';
        list.forEach(conv => {
            wrap.appendChild(createConversationItem(conv));
        });
        return wrap;
    };

    const renderFolderHeader = (cat) => {
        const header = document.createElement('div');
        const count = cat.isUnfiled
            ? state.conversations.filter(c => !c.categoryId).length
            : state.conversations.filter(c => c.categoryId === cat.id).length;
        header.className = 'group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg cursor-pointer text-xs font-semibold text-indigo-700 hover:bg-white/50 transition-colors select-none';
        header.dataset.folderId = cat.id;
        header.draggable = cat.isUnfiled ? false : true;
        header.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            header.classList.add('bg-white/60');
        });
        header.addEventListener('dragleave', () => {
            header.classList.remove('bg-white/60');
        });
        header.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            header.classList.remove('bg-white/60');
            const convId = e.dataTransfer.getData('text/plain');
            if (convId) moveConversationToCategory(convId, cat.isUnfiled ? null : cat.id);
        });
        header.innerHTML = `
            <svg class="folder-header-icon ${cat.isUnfiled ? 'folder-header-unfiled' : ''} w-3.5 h-3.5 text-violet-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
            <span class="truncate">${escapeHtml(cat.name)}</span>
            <span class="text-[10px] text-indigo-300 ml-auto">${count}</span>
            ${cat.isUnfiled ? '' : `
            <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onclick="event.stopPropagation(); renameCategoryPrompt('${safeAttrId(cat.id)}')" class="p-0.5 hover:bg-white/70 rounded" title="重命名">
                    <svg class="w-3 h-3 text-indigo-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                </button>
                <button onclick="event.stopPropagation(); deleteCategory('${safeAttrId(cat.id)}')" class="p-0.5 hover:bg-white/70 rounded" title="删除">
                    <svg class="w-3 h-3 text-red-300 hover:text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
            </div>`}
        `;
        return header;
    };

    if (pinned.length > 0) {
        const section = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'conversation-pinned-label flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold';
        label.innerHTML = '<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M8 3h8l-.7 5.2 3.7 3.3v1.1H5v-1.1l3.7-3.3L8 3zM12 12.6V21"/></svg><span>置顶</span>';
        section.appendChild(label);
        section.appendChild(renderConversationList(pinned));
        elements.folderList.appendChild(section);
    }

    const unfiledCat = { id: '__unfiled__', name: '未分类', isUnfiled: true };
    const cats = [unfiledCat, ...state.categories.slice().sort((a, b) => a.order - b.order)];
    const unfiledList = unfiled.filter(c => !pinnedIds.has(c.id));
    if (unfiledList.length > 0) {
        const section = document.createElement('div');
        section.appendChild(renderFolderHeader(unfiledCat));
        section.appendChild(renderConversationList(unfiledList));
        elements.folderList.appendChild(section);
    }

    cats.forEach(cat => {
        if (cat.isUnfiled) return;
        const list = regular.filter(c => c.categoryId === cat.id);
        if (list.length === 0 && kw) return;
        const section = document.createElement('div');
        section.appendChild(renderFolderHeader(cat));
        if (list.length > 0) {
            section.appendChild(renderConversationList(list));
        }
        elements.folderList.appendChild(section);
    });
}


// ==================== 管理分类弹窗 ====================

let catSelected = new Set();

function openCategoriesModal() {
    catSelected = new Set();
    renderCategoriesModalList();
    elements.categoriesModalOverlay.classList.remove('hidden');
    elements.categoriesModalOverlay.classList.add('flex');
    renderCatBatchBar();
    setRailActive('categories');
}

function closeCategoriesModal() {
    elements.categoriesModalOverlay.classList.add('hidden');
    elements.categoriesModalOverlay.classList.remove('flex');
    syncRailActive();
}

function renderCategoriesModalList() {
    elements.categoriesModalList.innerHTML = '';
    const cats = [null, ...state.categories.slice().sort((a, b) => a.order - b.order).map(c => c.id)];
    cats.forEach(catId => {
        const cat = catId ? state.categories.find(c => c.id === catId) : null;
        const name = cat ? cat.name : '未分类';
        const convs = state.conversations.filter(c => c.categoryId === catId);
        if (convs.length === 0) return;

        const section = document.createElement('div');
        section.className = 'glass-panel rounded-xl overflow-hidden';
        const expanded = state.catModalExpanded[catId || '__unfiled__'] !== false;

        const header = document.createElement('div');
        header.className = 'flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-white/40 transition-colors';
        header.innerHTML = `
            <svg class="w-3.5 h-3.5 text-violet-400 transition-transform ${expanded ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            <span class="text-xs font-semibold text-indigo-800">${escapeHtml(name)}</span>
            <span class="text-[11px] text-indigo-300 ml-auto">${convs.length} 条对话</span>
        `;
        header.onclick = () => {
            state.catModalExpanded[catId || '__unfiled__'] = !expanded;
            renderCategoriesModalList();
        };
        section.appendChild(header);

        if (expanded) {
            const list = document.createElement('div');
            list.className = 'px-3 pb-3 space-y-1 max-h-56 overflow-y-auto scroll-soft';
            convs.forEach(conv => {
                const row = document.createElement('label');
                const checked = catSelected.has(conv.id);
                row.className = `flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer transition-colors text-xs ${checked ? 'bg-pink-50' : 'hover:bg-white/50'}`;
                row.innerHTML = `
                    <input type="checkbox" class="accent-pink-500 cat-checkbox" data-conv-id="${safeAttrId(conv.id)}" ${checked ? 'checked' : ''}>
                    <span class="truncate text-indigo-800">${escapeHtml(conv.title)}</span>
                    <span class="ml-auto text-[10px] text-indigo-300">${new Date(conv.updatedAt).toLocaleDateString()}</span>
                `;
                const checkbox = row.querySelector('.cat-checkbox');
                checkbox.onchange = () => {
                    if (checkbox.checked) catSelected.add(conv.id);
                    else catSelected.delete(conv.id);
                    row.classList.toggle('bg-pink-50', checkbox.checked);
                    renderCatBatchBar();
                };
                list.appendChild(row);
            });
            section.appendChild(list);
        }
        elements.categoriesModalList.appendChild(section);
    });

    const catOptions = state.categories.filter(c => !c.isUnfiled);
    elements.catMoveSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '移动到...';
    elements.catMoveSelect.appendChild(defaultOpt);
    catOptions.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = cat.name;
        elements.catMoveSelect.appendChild(opt);
    });
}

function renderCatBatchBar() {
    const count = catSelected.size;
    elements.catSelectedCount.textContent = `已选 ${count} 个`;
    elements.categoriesBatchBar.classList.toggle('hidden', count === 0);
    elements.categoriesBatchBar.classList.toggle('flex', count > 0);
}

function catMoveSelected() {
    const target = elements.catMoveSelect.value;
    if (!target) return;
    catSelected.forEach(convId => moveConversationToCategory(convId, target));
    catSelected = new Set();
    renderCategoriesModalList();
    renderCatBatchBar();
    elements.catMoveSelect.value = '';
}

async function catDeleteSelected() {
    if (catSelected.size === 0) return;
    const confirmed = await showCustomConfirm(`确认删除选中的 ${catSelected.size} 个对话？`);
    if (!confirmed) return;
    state.conversations = state.conversations.filter(c => !catSelected.has(c.id));
    // 批量删除同样要清日记 + 收藏（与 deleteConversation 共用同一个函数，
    //   免得两个入口再次各自只做一半 —— 那正是用户报的那个 bug 的成因）。
    purgeConversationDependents(catSelected);
    saveConversations();
    updateNotesBadge();
    if (catSelected.has(state.currentConversationId)) {
        state.currentConversationId = null;
        Store.removeItem('elaina_open_current_conv');
        elements.conversationHistory.classList.add('hidden');
        elements.inputBar.classList.add('hidden');
        elements.initialState.classList.remove('hidden');
        elements.currentConversationTitle.textContent = '伊蕾娜';
    }
    catSelected = new Set();
    renderCategoriesModalList();
    renderCatBatchBar();
    renderFolderList();
    if (state.diaryMode) renderDiaryPage();
}


// ==================== 消息渲染 ====================

function renderMessage(message) {
    const div = document.createElement('div');
    div.id = `msg-${safeAttrId(message.id)}`;
    div.className = `message-item ${message.role === 'user' ? 'message-item-user' : 'message-item-ai'} animate-fade-in-up`;

    if (message.role === 'user') {
        const userImageUrl = isSafeComposerImageDataUrl(message.imageDataUrl) ? message.imageDataUrl : '';
        div.innerHTML = `
            <div class="flex gap-3 mb-4 group">
                <div class="flex-1">
                    <div class="bubble-user rounded-2xl p-4">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="text-xs font-medium text-indigo-500">${escapeHtml(getUserProfileName() || '旅人')}</span>
                            <span class="text-xs text-indigo-300">${escapeHtml(message.timestamp)}</span>
                            <button onclick="event.stopPropagation(); handleMessageFavoriteClick('${safeAttrId(message.id)}')"
                                    class="message-action-btn ml-auto p-1.5 rounded-lg hover:bg-white/60 transition-all flex items-center gap-1 ${isMessageFavorited(state.currentConversationId, message.id) ? 'text-amber-500' : 'text-indigo-300 hover:text-amber-500'}">
                                <svg class="w-3.5 h-3.5" fill="${isMessageFavorited(state.currentConversationId, message.id) ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
                                </svg>
                                <span class="text-xs font-medium">${isMessageFavorited(state.currentConversationId, message.id) ? '已收藏' : '收藏'}</span>
                            </button>
                            <!-- 每消息插槽容器：mod 通过 host.slot('chat.message.actions', …) 注册的按钮
                                 画在这里（由 host-slots.js 的 decorateMessageSlots 填充） -->
                            <span class="message-slot-actions flex items-center gap-1" data-message-id="${safeAttrId(message.id)}"></span>
                        </div>
                        ${userImageUrl ? `<img class="message-image" src="${userImageUrl}" alt="${escapeHtml(message.imageName || '用户发送的图片')}">` : ''}
                        ${message.text ? `<p class="text-indigo-800 text-sm leading-relaxed whitespace-pre-wrap">${renderMessageText(message.text)}</p>` : ''}
                    </div>
                </div>
            </div>
        `;
    } else {
        const faved = isMessageFavorited(state.currentConversationId, message.id);
        const name = state.characterCard.name || '伊蕾娜';
        const voiceDurationSeconds = estimateVoiceDurationSeconds(message.voiceJp || message.text);
        const voiceCard = `
                        <div class="ai-voice-card">
                            <button id="voice-player-${safeAttrId(message.id)}" onclick="event.stopPropagation(); replayAIMessage('${safeAttrId(message.id)}')" class="ai-voice-player" type="button" aria-label="播放伊蕾娜的语音">
                                <span class="voice-play-box" aria-hidden="true">
                                    <svg class="voice-icon-play" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.8v10.4L13 8 4 2.8z"/></svg>
                                    <svg class="voice-icon-pause" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>
                                </span>
                                <span class="voice-duration">${formatVoiceDuration(voiceDurationSeconds)}</span>
                                <span class="voice-waveform" aria-hidden="true">${voiceWaveformMarkup()}</span>
                            </button>
                            <div class="ai-voice-error" role="status" aria-live="polite" hidden></div>
                        </div>`;
        div.innerHTML = `
            <div class="flex gap-3 mb-4 group">
                <div class="flex-1">
                    <div class="bubble-ai rounded-2xl p-4">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="ai-speaker-name">${escapeHtml(name)}</span>
                            <span class="text-xs text-indigo-300">${escapeHtml(message.timestamp)}</span>
                            <button onclick="event.stopPropagation(); handleMessageFavoriteClick('${safeAttrId(message.id)}')"
                                    class="message-action-btn ml-auto p-1.5 rounded-lg hover:bg-white/60 transition-all flex items-center gap-1 ${faved ? 'text-amber-500' : 'text-indigo-300 hover:text-amber-500'}">
                                <svg class="w-3.5 h-3.5" fill="${faved ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
                                </svg>
                                <span class="text-xs font-medium">${faved ? '已收藏' : '收藏'}</span>
                            </button>
                            <!-- 每消息插槽容器（同用户分支，见 chat.message.actions 说明） -->
                            <span class="message-slot-actions flex items-center gap-1" data-message-id="${safeAttrId(message.id)}"></span>
                        </div>
                        <p class="text-indigo-950 text-sm leading-relaxed whitespace-pre-wrap">${renderMessageText(message.text)}</p>
                        ${voiceCard}
                    </div>
                </div>
            </div>
        `;
    }
    // 每消息插槽：把标题行里的容器交给注册过 chat.message.actions 的 mod。
    //   在节点**进入文档之前**画好，否则会先闪一个空位再冒出按钮。
    //   守卫是必要的：消息渲染是核心链路，插槽模块没加载（或插件抛错）都不该影响它 ——
    //   decorateMessageSlots 内部已对每个 mod 做失败隔离。
    if (typeof applyMessageVoiceError === 'function') applyMessageVoiceError(message.id, div);
    if (typeof window.decorateMessageSlots === 'function') window.decorateMessageSlots(div);

    elements.conversationHistory.appendChild(div);
    elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
    return div;
}

async function replayAIMessage(messageId) {
    const voiceMessageKey = String(messageId);
    const existingPlaybackTask = voicePlaybackTasksByMessageId.get(voiceMessageKey);
    if (existingPlaybackTask && activeVoicePlaybackStatus === 'loading') {
        console.log('[TTS] 自动语音尚未返回，手动点击复用当前请求');
        return;
    }
    if (await toggleVoicePlayback(messageId)) return;
    if (existingPlaybackTask) {
        console.log('[TTS] 同一消息已有播放任务，忽略重复启动');
        return;
    }
    if (pendingAutomaticVoiceMessageIds.has(voiceMessageKey)) {
        console.log('[TTS] 自动语音仍在准备，忽略重复的手动播放请求');
        return;
    }
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    if (!conv) return;
    const msg = conv.messages.find(m => String(m.id) === String(messageId));
    if (!msg) return;
    const wantsJp = state.settings.ttsLang === 'japanese';
    let textToSpeak = msg.text;
    if (wantsJp) {
        try {
            textToSpeak = await ensureJapaneseVoiceText(msg);
            if (textToSpeak) saveConversations();
        } catch (error) {
            console.error('[TTS] 手动播放的日语朗读稿生成失败:', error);
            setVoicePlaybackState(messageId, false);
            setMessageVoiceError(messageId, '语音生成失败：' + voiceErrorSummary(error));
            return;
        }
        if (!textToSpeak) {
            setVoicePlaybackState(messageId, false);
            setMessageVoiceError(messageId, '未能生成日语朗读稿，本次不会回退播放中文，请稍后重试。');
            return;
        }
    }
    const durationSeconds = estimateVoiceDurationSeconds(textToSpeak);
    startVoicePlaybackOnce(messageId, textToSpeak, () => {
        markVoicePlaybackStarted(messageId, durationSeconds);
    }, {
        cacheKey: buildMessageTtsCacheKey(msg, textToSpeak, conv.id),
        onEnd: () => setVoicePlaybackState(messageId, false)
    }).catch(error => {
        if (isVoiceCancellation(error)) return;
        console.error('[TTS] 缓存语音播放失败:', error);
        setVoicePlaybackState(messageId, false);
        setMessageVoiceError(messageId, '语音生成失败：' + voiceErrorSummary(error));
    });
}


