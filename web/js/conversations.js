/* ============================================================================
 * 会话管理（从 ui.js 拆分）
 *
 * 新建 / 命名 / 重命名 / 删除 / 置顶 / 分类 / 切换会话。
 * 依赖 Store、消息渲染与状态机（运行时才调用）。
 * ========================================================================== */
'use strict';

// ==================== 会话管理 ====================

function createConversation(categoryId) {
    const conv = {
        id: generateId(),
        title: '新对话',
        categoryId: categoryId !== undefined ? categoryId : state.activeCategoryId,
        isPinned: false,
        isStarred: false,
        worldSetting: '',
        characterPrompt: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: []
    };
    state.conversations.unshift(conv);
    state.currentConversationId = conv.id;
    Store.setItem('elaina_open_current_conv', conv.id);
    saveConversations();
    renderFolderList();
    updateCurrentConversationTitle();
    showInitialState();
    return conv;
}

/**
 * 这些话不承载话题信息，拿来当标题等于"没取名"。
 *
 * 为什么需要这个判据：标题只取第一条用户消息时，"你好"开头的对话会全部叫"你好"，
 *   而用户翻侧栏找的是"这段在聊什么" —— 十条一模一样的"你好"等于没有标题。
 */
const TRIVIAL_CONVERSATION_TEXT = /^(你好|您好|hi|hello|嗨|嗨喽|在吗|在不在|喂|测试|test|ok|好的|行|嗯+|哦+|啊+|哈+|早|早安|午安|晚安|拜拜|再见)[\s!！。.?？~～、,，]*$/i;

/** 这段文本值不值得当标题（太短或纯招呼语都不值得） */
function isTrivialConversationText(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    if (TRIVIAL_CONVERSATION_TEXT.test(t)) return true;
    // 少于 3 个字符基本是语气词，同样没有信息量
    return t.length < 3;
}

function autoNameConversation(messages) {
    const users = (Array.isArray(messages) ? messages : []).filter(m => m && m.role === 'user');
    if (!users.length) return '新对话';
    // 只挑**有内容**的那条：跳过"你好""在吗"这类招呼语。
    //   一条都没有就保持"新对话" —— 拿招呼语当标题会让侧栏堆满一模一样的"你好"，
    //   那和"没取名"没有区别（用户看到的正是这个）。
    const first = users.find(m => !isTrivialConversationText(m.text));
    if (!first) {
        const hasImage = users.some(m => m.imageDataUrl);
        return hasImage ? '图片对话' : '新对话';
    }
    const text = String(first.text || '').trim();
    return text.length > 12 ? text.substring(0, 12) + '...' : text;
}

/**
 * 收到新消息后，若标题**仍是自动取的**就重新取一次。
 *
 * 判据是"当前标题 == 把最后一条消息去掉后自动算出来的名字"：
 *   相等说明没人改过它（还是自动的），可以覆盖；不等说明用户手动起过名，
 *   哪怕他起的就是"你好"也不动 —— 用户的意思优先于猜。
 *
 * 为什么必须**逐条**重算而不是"只在第一条时取"：首条常常是"你好"，
 *   真正的话题在第二条才出现。写成一次性，标题就永久停在招呼语上（用户实测）。
 *
 * @returns {boolean} 标题是否变了（调用方据此决定要不要重渲染侧栏）
 */
function refreshAutoConversationTitle(conversation) {
    if (!conversation) return false;
    const msgs = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (!msgs.length) return false;
    const previousAuto = autoNameConversation(msgs.slice(0, -1));
    if (String(conversation.title || '').trim() !== previousAuto) return false;
    const next = autoNameConversation(msgs);
    if (next === conversation.title) return false;
    conversation.title = next;
    saveConversations();
    return true;
}

async function renameConversation(convId) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    const newName = await showCustomPrompt('重命名对话：', conv.title);
    if (newName && newName.trim()) {
        conv.title = newName.trim();
        saveConversations();
        renderFolderList();
        updateCurrentConversationTitle();
    }
}

/**
 * 删除对话时，把"依附于这段对话的数据"一并清掉。
 *
 * ── 为什么要抽成一个函数──────────────────────────────────────
 *
 *   用户报："删除对话时会删除日记但是不会删除收藏的句子"。
 *   实际查下来是**两处删除入口各自只做了一半**：
 *     · deleteConversation()  删了收藏，**没删日记**
 *     · catDeleteSelected()   删了收藏，**也没删日记**
 *   于是"日记属于哪段对话"全靠 conversationId —— 对话没了，
 *   那些日记就成了没人认领的孤儿，在日记页里挂着一个删不掉的
 *   「已删除的对话」分组（用户看到的就是这个）。
 *
 *   抽成一处之后，将来再加"依附数据"（比如某段对话的定时任务）
 *   只需要改这里一个地方，不会再出现"某个入口漏了一种"。
 *
 * @param {Set<string>|Array<string>} ids 被删除的对话 id
 * @returns {{diary:number, favorites:number}} 各清掉多少条（供提示/调试）
 */
function purgeConversationDependents(ids) {
    const set = ids instanceof Set ? ids : new Set(ids || []);
    if (!set.size) return { diary: 0, favorites: 0 };

    // ---- 日记 ----
    let diaryRemoved = 0;
    try {
        const mc = state.memoryCore;
        if (mc && Array.isArray(mc.diary)) {
            const before = mc.diary.length;
            mc.diary = mc.diary.filter(e => !set.has(e.conversationId));
            diaryRemoved = before - mc.diary.length;
            if (diaryRemoved) {
                if (typeof saveMemoryCore === 'function') saveMemoryCore();
                // 记忆变了 → 相关缓存/提示也要跟着失效（能调就调，缺了不影响）
                try { if (typeof updateNotesBadge === 'function') updateNotesBadge(); } catch (e) { /* 忽略 */ }
            }
        }
    } catch (e) { /* 记忆不可用时不该挡住删除对话 */ }

    // ---- 收藏（"语笺"里的句子）----
    let favRemoved = 0;
    try {
        if (Array.isArray(state.favorites)) {
            const before = state.favorites.length;
            state.favorites = state.favorites.filter(f => !set.has(f.conversationId));
            favRemoved = before - state.favorites.length;
            if (favRemoved && typeof saveFavorites === 'function') saveFavorites();
        }
    } catch (e) { /* 忽略 */ }

    return { diary: diaryRemoved, favorites: favRemoved };
}

async function deleteConversation(convId) {
    const confirmed = await showCustomConfirm('确认删除这个对话？');
    if (!confirmed) return;
    const idx = state.conversations.findIndex(c => c.id === convId);
    if (idx < 0) return;
    state.conversations.splice(idx, 1);
    // 日记 + 收藏一起清（见 purgeConversationDependents 的说明）
    purgeConversationDependents([convId]);
    saveConversations();
    updateNotesBadge();
    if (state.currentConversationId === convId) {
        state.currentConversationId = null;
        Store.removeItem('elaina_open_current_conv');
        elements.conversationHistory.classList.add('hidden');
        elements.inputBar.classList.add('hidden');
        elements.initialState.classList.remove('hidden');
        elements.currentConversationTitle.textContent = '伊蕾娜';
    }
    renderFolderList();
    // 正开着日记页时也要跟着刷新 —— 否则被删掉的那组还留在屏幕上，
    //   点进去是一片空（用户会以为删除没生效）。
    if (state.diaryMode) renderDiaryPage();
}

function togglePin(convId) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    conv.isPinned = !conv.isPinned;
    saveConversations();
    renderFolderList();
}

function toggleStar(convId) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    conv.isStarred = !conv.isStarred;
    saveConversations();
    renderFolderList();
}

let conversationContextMenu = null;
let conversationContextTarget = null;
let suppressConversationClickUntil = 0;

function isMobileConversationLayout() {
    return window.matchMedia('(max-width: 980px)').matches;
}

function closeConversationContextMenu() {
    if (conversationContextTarget) {
        conversationContextTarget.classList.remove('is-context-target');
        conversationContextTarget = null;
    }
    if (!conversationContextMenu) return;
    const menu = conversationContextMenu;
    conversationContextMenu = null;
    menu.classList.remove('is-open');
    window.setTimeout(() => menu.remove(), 170);
}

function openConversationContextMenu(convId, anchor) {
    if (!isMobileConversationLayout()) return;
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    closeConversationContextMenu();

    const menu = document.createElement('div');
    menu.className = 'conversation-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `${conv.title}的会话操作`);
    menu.innerHTML = `
        <button type="button" role="menuitem" data-conversation-action="pin">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
            <span>${conv.isPinned ? '取消置顶' : '置顶对话'}</span>
        </button>
        <button type="button" role="menuitem" data-conversation-action="rename">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.4-9.4a2 2 0 112.8 2.8L11.8 15H9v-2.8l8.6-8.6z"/></svg>
            <span>重命名</span>
        </button>
        <button type="button" role="menuitem" data-conversation-action="move">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h6l2 2h8v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path stroke-linecap="round" d="M12 12v5m-2.5-2.5L12 17l2.5-2.5"/></svg>
            <span>移动至</span>
        </button>
        <button type="button" role="menuitem" data-conversation-action="delete" class="danger">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.9 12.1A2 2 0 0116.1 21H7.9a2 2 0 01-2-1.9L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            <span>删除对话</span>
        </button>
    `;
    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    menu.addEventListener('contextmenu', (event) => event.preventDefault());
    menu.addEventListener('click', (event) => {
        const button = event.target.closest('[data-conversation-action]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const action = button.dataset.conversationAction;
        closeConversationContextMenu();
        if (action === 'pin') togglePin(convId);
        if (action === 'rename') renameConversation(convId);
        if (action === 'move') openConversationMoveDialog(convId);
        if (action === 'delete') deleteConversation(convId);
    });

    document.body.appendChild(menu);
    conversationContextMenu = menu;
    conversationContextTarget = anchor;
    anchor.classList.add('is-context-target');

    const rect = anchor.getBoundingClientRect();
    const menuWidth = menu.offsetWidth || 166;
    const menuHeight = menu.offsetHeight || 126;
    const edge = 10;
    const left = Math.min(Math.max(edge, rect.right - menuWidth), window.innerWidth - menuWidth - edge);
    const below = rect.bottom + 6;
    const top = below + menuHeight <= window.innerHeight - edge
        ? below
        : Math.max(edge, rect.top - menuHeight - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    requestAnimationFrame(() => menu.classList.add('is-open'));
}

async function createCategory(name) {
    const cat = {
        id: generateId(),
        name,
        order: state.categories.length,
        isUnfiled: false
    };
    state.categories.push(cat);
    saveCategories();
    renderFolderList();
    return cat;
}

async function promptCreateCategory() {
    const name = await showCustomPrompt('输入文件夹名称：');
    if (name && name.trim()) {
        await createCategory(name.trim());
    }
}

async function renameCategoryPrompt(categoryId) {
    const cat = state.categories.find(c => c.id === categoryId);
    if (!cat) return;
    const newName = await showCustomPrompt('重命名文件夹：', cat.name);
    if (newName && newName.trim()) {
        cat.name = newName.trim();
        saveCategories();
        renderFolderList();
        renderCategoriesModalList();
    }
}

async function deleteCategory(categoryId) {
    const cat = state.categories.find(c => c.id === categoryId);
    if (!cat || cat.isUnfiled) return;
    const confirmed = await showCustomConfirm(`确认删除文件夹「${cat.name}」？其中的对话将移到未分类。`);
    if (!confirmed) return;
    state.conversations.forEach(conv => {
        if (conv.categoryId === categoryId) conv.categoryId = null;
    });
    state.categories = state.categories.filter(c => c.id !== categoryId);
    saveConversations();
    saveCategories();
    renderFolderList();
    renderCategoriesModalList();
}

function moveConversationToCategory(convId, categoryId) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    conv.categoryId = categoryId;
    saveConversations();
    renderFolderList();
}

function switchConversation(convId) {
    state.currentConversationId = convId;
    Store.setItem('elaina_open_current_conv', convId);
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    loadConversation(convId);
}

function updateCurrentConversationTitle() {
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    elements.currentConversationTitle.textContent = conv ? conv.title : '伊蕾娜';
    elements.currentConversationTitle.title = conv ? conv.title : '';
}

function loadConversation(conversationId) {
    const conv = state.conversations.find(c => c.id === conversationId);
    if (!conv) return;

    state.currentConversationId = conversationId;
    updateCurrentConversationTitle();
    if (state.notesMode) {
        state.notesMode = false;
        elements.notesPage.classList.add('hidden');
    }
    if (state.diaryMode) {
        state.diaryMode = false;
        elements.diaryPage.classList.add('hidden');
    }
    elements.initialState.classList.add('hidden');
    elements.conversationHistory.classList.remove('hidden');
    elements.inputBar.classList.remove('hidden');
    elements.notesPage.classList.add('hidden');
    elements.diaryPage.classList.add('hidden');

    elements.conversationHistory.innerHTML = '';
    conv.messages.forEach(message => {
        // hidden 的消息不进可见渲染：工具通道的结果、以及"只调工具、一个字没说"的空回复。
        //   它们只为**下一次请求**存在（协议要求 assistant 的调用后面紧跟结果），
        //   渲染出来就是聊天记录里多出一段用户没写过、AI 也没说过的文本。
        if (message && message.hidden === true) return;
        renderMessage(message);
        // 这一轮当年的思考/工具记录：过程区是临时 DOM，容器已被清空，
        //   必须按消息上存的数据重新插回去 —— 否则"聊了几轮之后，
        //   之前的思考记录就不见了"（切会话、刷新页面都会触发）。
        restoreTurnProcessFor(message);
    });
    renderFolderList();
    syncRailActive();
    if (elements.conversationHistory) {
        elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
    }
}



