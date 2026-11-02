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
        cardId: '',
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
    if (state.memoryPageMode) renderMemoryPage();
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

/**
 * 长按会话弹出的操作菜单。
 *
 * @param {string} convId
 * @param {HTMLElement} anchor 贴着它摆
 * @param {{ onMultiSelect?: (convId: string) => void }} [opts]
 *   onMultiSelect 只有在"这个列表支持多选"时才传（首页那份列表）。抽屉那份不传，
 *   菜单里就不会出现它按不动的「多选」——勾选框只长在首页的行上。
 */
function openConversationContextMenu(convId, anchor, opts) {
    if (!isMobileConversationLayout()) return;
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    closeConversationContextMenu();

    const canMultiSelect = !!(opts && typeof opts.onMultiSelect === 'function');
    const menu = document.createElement('div');
    menu.className = 'conversation-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `${conv.title}的会话操作`);
    menu.innerHTML = `
        <button type="button" role="menuitem" data-conversation-action="star">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>
            <span>${conv.isStarred ? '取消收藏' : '收藏对话'}</span>
        </button>
        <button type="button" role="menuitem" data-conversation-action="pin">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
            <span>${conv.isPinned ? '取消置顶' : '置顶对话'}</span>
        </button>
        <button type="button" role="menuitem" data-conversation-action="rename">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.4-9.4a2 2 0 112.8 2.8L11.8 15H9v-2.8l8.6-8.6z"/></svg>
            <span>重命名</span>
        </button>
        <button type="button" role="menuitem" data-conversation-action="folder">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7.5A2.5 2.5 0 016.5 5h3.2l1.6 2h6.2A2.5 2.5 0 0120 9.5v7A2.5 2.5 0 0117.5 19h-11A2.5 2.5 0 014 16.5v-9z"/></svg>
            <span>分类</span>
        </button>
        ${canMultiSelect ? `<button type="button" role="menuitem" data-conversation-action="multi">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6h10M9.5 12h10M9.5 18h10"/><path d="M3.6 5.6l1.3 1.3 2.3-2.4M3.6 11.6l1.3 1.3 2.3-2.4M3.6 17.6l1.3 1.3 2.3-2.4"/></svg>
            <span>多选</span>
        </button>` : ''}
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
        if (action === 'star') toggleStar(convId);
        if (action === 'pin') togglePin(convId);
        if (action === 'rename') renameConversation(convId);
        if (action === 'folder') openConversationMoveDialog(convId);
        if (action === 'multi' && opts && typeof opts.onMultiSelect === 'function') opts.onMultiSelect(convId);
        if (action === 'delete') deleteConversation(convId);
    });

    document.body.appendChild(menu);
    conversationContextMenu = menu;
    conversationContextTarget = anchor;
    anchor.classList.add('is-context-target');

    placeMobileMenu(menu, anchor);
    requestAnimationFrame(() => menu.classList.add('is-open'));
}

/** 贴着锚点摆菜单：右边对齐锚点右缘，下面放不下就翻到上方（并给动画换方向）。 */
function placeMobileMenu(menu, anchor) {
    const rect = anchor.getBoundingClientRect();
    const menuWidth = menu.offsetWidth || 166;
    const menuHeight = menu.offsetHeight || 126;
    const edge = 10;
    const left = Math.min(Math.max(edge, rect.right - menuWidth), window.innerWidth - menuWidth - edge);
    const openUp = !(rect.bottom + 6 + menuHeight <= window.innerHeight - edge);
    const top = openUp ? Math.max(edge, rect.top - menuHeight - 6) : rect.bottom + 6;
    if (openUp) menu.classList.add('is-up');
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

/**
 * 文件夹（分类）的长按菜单：重命名 / 删除。
 * 复用对话那套弹层节点与关闭逻辑（conversationContextMenu），
 * 于是"点外面 / 滚动 / 转屏就收起"这些行为不用再写一遍。
 */
function openCategoryContextMenu(categoryId, anchor) {
    if (!isMobileConversationLayout()) return;
    const cat = state.categories.find(c => c.id === categoryId);
    if (!cat || cat.isUnfiled) return;
    closeConversationContextMenu();

    const menu = document.createElement('div');
    menu.className = 'conversation-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `${cat.name}的文件夹操作`);
    menu.innerHTML = `
        <button type="button" role="menuitem" data-category-action="rename">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            <span>重命名</span>
        </button>
        <button type="button" role="menuitem" data-category-action="delete" class="danger">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16"/></svg>
            <span>删除文件夹</span>
        </button>
    `;
    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    menu.addEventListener('contextmenu', (event) => event.preventDefault());
    menu.addEventListener('click', (event) => {
        const button = event.target.closest('[data-category-action]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const action = button.dataset.categoryAction;
        closeConversationContextMenu();
        if (action === 'rename') renameCategoryPrompt(categoryId);
        if (action === 'delete') deleteCategory(categoryId);
    });

    document.body.appendChild(menu);
    conversationContextMenu = menu;
    conversationContextTarget = anchor;
    anchor.classList.add('is-context-target');
    placeMobileMenu(menu, anchor);
    requestAnimationFrame(() => menu.classList.add('is-open'));
}

/** 文件夹头也走长按：和对话一样的 520ms / 右键，抬手不触发收起。 */
function bindCategoryPick(head, categoryId) {
    let timer = null;
    let startX = 0;
    let startY = 0;
    const cancel = () => {
        if (timer) window.clearTimeout(timer);
        timer = null;
    };
    const open = () => {
        cancel();
        // 菜单弹出后紧跟的那次 click 会顺带把分组收起，这里先压住
        suppressConversationClickUntil = Date.now() + 800;
        openCategoryContextMenu(categoryId, head);
    };
    head.addEventListener('pointerdown', (event) => {
        if (!isMobileConversationLayout() || !event.isPrimary) return;
        cancel();
        startX = event.clientX;
        startY = event.clientY;
        timer = window.setTimeout(open, CONV_PICK_MS);
    });
    head.addEventListener('pointermove', (event) => {
        if (!timer) return;
        if (Math.hypot(event.clientX - startX, event.clientY - startY) > CONV_PICK_SLOP) cancel();
    });
    head.addEventListener('pointerup', cancel);
    head.addEventListener('pointercancel', cancel);
    head.addEventListener('pointerleave', cancel);
    head.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        open();
    });
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
    // 目标是收起的分组就先展开：对话移进去却看不见，等于没移。
    if (categoryId && typeof window.__elainaExpandConvFolder === 'function') window.__elainaExpandConvFolder(categoryId);
    renderFolderList();
}

/**
 * 「新建分类」：建一个文件夹，并把这段对话直接放进去。
 *
 * 为什么顺手放进去：这个动作是从**某段对话**的菜单里发起的，建完空着的话
 * 用户还得再拖一次；从对话出发的"移动至一个新分类"本来就该一步到位。
 * 想要空文件夹，到抽屉里那颗「＋」新建即可。
 */
// ==================== 会话长按：直接出菜单 ====================
// 拖拽那套已经下线（用户：算了不搞拖动了）。移动文件夹改走菜单里的「分类」：
//   长按只做一件事 —— 出菜单，不再"先拿起、松手才弹"，按下去的手感更直给。

const CONV_PICK_MS = 520;
const CONV_PICK_SLOP = 9;

/**
 * 长按 520ms（或右键）弹出会话菜单。
 *
 * @param {HTMLElement} div 行节点
 * @param {object} conv 对话
 * @param {{ onMultiSelect?: (convId: string) => void }} [menuOptions]
 *   直接转给 openConversationContextMenu：只有首页那份列表传，菜单里才会多出「多选」。
 *   手势本身（520ms / 9px 容差 / 右键）两处必须一致，所以只分岔"菜单里多一项什么"，
 *   而不是让两个列表各写一份计时器。
 */
function bindConversationPick(div, conv, menuOptions) {
    let timer = null;
    let startX = 0;
    let startY = 0;
    const cancel = () => {
        if (timer) window.clearTimeout(timer);
        timer = null;
    };
    const openMenu = () => {
        cancel();
        // 菜单弹出后紧随的那次 click 要吞掉，否则会顺手把会话打开
        suppressConversationClickUntil = Date.now() + 800;
        openConversationContextMenu(conv.id, div, menuOptions);
    };

    div.addEventListener('pointerdown', (event) => {
        if (!isMobileConversationLayout() || !event.isPrimary) return;
        // 只跳过行**里面**的按钮；行本身就是 button 的列表（首页那份）照样要能长按。
        const inner = event.target.closest ? event.target.closest('button') : null;
        if (inner && inner !== div) return;
        cancel();
        startX = event.clientX;
        startY = event.clientY;
        timer = window.setTimeout(openMenu, CONV_PICK_MS);
    });
    div.addEventListener('pointermove', (event) => {
        if (!timer) return;
        if (Math.hypot(event.clientX - startX, event.clientY - startY) > CONV_PICK_SLOP) cancel();
    });
    div.addEventListener('pointerup', cancel);
    div.addEventListener('pointercancel', cancel);
    div.addEventListener('pointerleave', cancel);
    div.addEventListener('contextmenu', (event) => {
        const inner = event.target.closest ? event.target.closest('button') : null;
        if (!isMobileConversationLayout() || (inner && inner !== div)) return;
        event.preventDefault();
        if (conversationContextMenu && conversationContextTarget === div) return;
        openMenu();
    });
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
    if (state.memoryPageMode) {
        state.memoryPageMode = false;
        elements.memoryPage.classList.add('hidden');
    }
    elements.initialState.classList.add('hidden');
    elements.conversationHistory.classList.remove('hidden');
    elements.inputBar.classList.remove('hidden');
    elements.notesPage.classList.add('hidden');
    elements.diaryPage.classList.add('hidden');
    elements.memoryPage.classList.add('hidden');

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



