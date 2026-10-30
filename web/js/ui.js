/* ========================================================================
 * 界面：收藏 / 语笺 / 弹窗 / 会话 / 侧边栏 / 消息渲染
 * ======================================================================== */

// ==================== 收藏（语笺） ====================

function isMessageFavorited(conversationId, messageId) {
    return state.favorites.some(f =>
        f.type === 'message' &&
        f.conversationId === conversationId &&
        f.messageId === messageId
    );
}

function toggleMessageFavorite(message) {
    const convId = state.currentConversationId;
    if (!convId) return false;
    const idx = state.favorites.findIndex(f =>
        f.type === 'message' &&
        f.conversationId === convId &&
        f.messageId === message.id
    );
    if (idx >= 0) {
        state.favorites.splice(idx, 1);
    } else {
        state.favorites.push({
            id: generateId(),
            type: 'message',
            createdAt: new Date().toISOString(),
            conversationId: convId,
            messageId: message.id,
            text: message.text,
            role: message.role,
            timestamp: message.timestamp,
            voiceJp: message.voiceJp || ''
        });
    }
    saveFavorites();
    updateNotesBadge();
    return idx < 0;
}

function handleMessageFavoriteClick(messageId) {
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    if (!conv) return;
    const msg = conv.messages.find(m => String(m.id) === String(messageId));
    if (!msg) return;
    toggleMessageFavorite(msg);
    const msgEl = document.getElementById(`msg-${safeAttrId(messageId)}`);
    if (msgEl) {
        const fresh = renderMessage(msg);
        msgEl.replaceWith(fresh);
    }
}

function updateNotesBadge() {
    const count = state.favorites.length;
    if (count > 0) {
        elements.notesBadge.textContent = count > 99 ? '99+' : count;
        elements.notesBadge.classList.remove('hidden');
    } else {
        elements.notesBadge.classList.add('hidden');
    }
}

function getNotesData() {
    if (state.notesTab === 'quote') {
        return state.favorites
            .filter(f => f.type === 'quote')
            .map(f => ({ ...f, role: 'quote', timestamp: '' }));
    }
    return state.favorites
        .filter(f => f.type === 'message')
        .map(f => ({ ...f }));
}

function renderNotesPage(searchText = '') {
    const scroller = elements.notesPage.querySelector('.overflow-y-auto');
    const prevScroll = scroller ? scroller.scrollTop : 0;
    const data = getNotesData();
    const kw = (searchText || '').trim().toLowerCase();
    const filtered = kw ? data.filter(f => (f.text || '').toLowerCase().includes(kw)) : data;

    elements.notesCount.textContent = `共 ${filtered.length} 条`;
    elements.notesEmpty.classList.toggle('hidden', filtered.length > 0);
    elements.notesGrid.innerHTML = '';

    filtered.forEach(fav => {
        const card = document.createElement('div');
        card.className = 'group note-card cursor-pointer animate-fade-in-up';
        card.onclick = () => openFavoriteDetail(fav.id);
        const roleClass = fav.role === 'user' ? 'note-role-user' : fav.role === 'ai' ? 'note-role-ai' : 'note-role-quote';
        const roleLabel = fav.role === 'user' ? (getUserProfileName() || '旅人') : fav.role === 'ai' ? '伊蕾娜' : '金句';
        card.innerHTML = `
            <div class="flex items-center gap-2 mb-2">
                <span class="note-role-badge ${roleClass}">${roleLabel}</span>
                ${fav.type === 'quote' ? '<span class="note-card-meta">' + escapeHtml(fav.source || '') + '</span>' : '<span class="note-card-meta">' + escapeHtml(fav.timestamp || '') + '</span>'}
            </div>
            <p class="note-card-text line-clamp-3">${escapeHtml(fav.text)}</p>
            <div class="flex items-center gap-1 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onclick="event.stopPropagation(); removeFavoriteWithConfirm('${safeAttrId(fav.id)}')" class="note-remove-btn ml-auto p-1.5" title="取消收藏">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
            </div>
        `;
        elements.notesGrid.appendChild(card);
    });
    if (scroller) {
        requestAnimationFrame(() => {
            scroller.scrollTop = prevScroll;
        });
    }
}

function openFavoriteDetail(favId) {
    const fav = state.favorites.find(f => f.id === favId);
    if (!fav) return;
    state.selectedFavoriteId = favId;

    elements.detailTypeBadge.textContent = fav.type === 'quote' ? '每日金句' : (fav.role === 'user' ? 'You 的消息' : '伊蕾娜的回复');
    elements.detailRole.textContent = fav.type === 'quote' ? (fav.source || '') : (fav.role === 'user' ? '你' : '伊蕾娜');
    elements.detailTimestamp.textContent = fav.timestamp || '';
    elements.detailText.textContent = fav.text;

    const conv = state.conversations.find(c => c.id === fav.conversationId);
    const hasContext = fav.type === 'message' && conv;
    elements.detailContextSection.classList.toggle('hidden', !hasContext);
    if (hasContext) {
        elements.detailConvTitle.textContent = conv.title || '未命名对话';
    }
    elements.detailJumpBtn.classList.toggle('hidden', fav.type === 'quote');

    elements.notesOverlay.classList.remove('hidden');
    elements.notesOverlay.classList.add('flex');
    elements.favoriteDetail.classList.remove('hidden');
    elements.favoriteDetailCard.classList.add('animate-modal-pop');
}

function collapseFavorite() {
    state.selectedFavoriteId = null;
    elements.favoriteDetail.classList.add('hidden');
    elements.notesOverlay.classList.add('hidden');
    elements.notesOverlay.classList.remove('flex');
}

async function removeFavoriteWithConfirm(favId) {
    const confirmed = await showCustomConfirm('确认取消收藏？');
    if (!confirmed) return;
    state.favorites = state.favorites.filter(f => f.id !== favId);
    saveFavorites();
    updateNotesBadge();
    updateQuoteButtons();
    renderNotesPage(elements.notesSearch.value);
    if (state.selectedFavoriteId === favId) {
        collapseFavorite();
    }
}

function jumpToOriginal(fav) {
    if (!fav || fav.type === 'quote') return;
    const conv = state.conversations.find(c => c.id === fav.conversationId);
    if (!conv) return;

    state.selectedFavoriteId = null;
    elements.favoriteDetail.classList.add('hidden');
    elements.notesOverlay.classList.add('hidden');
    elements.notesOverlay.classList.remove('flex');

    exitNotesMode();
    switchConversation(fav.conversationId);

    setTimeout(() => {
        const msgEl = document.getElementById(`msg-${safeAttrId(fav.messageId)}`);
        if (msgEl) {
            msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            msgEl.classList.add('highlight-pulse');
            setTimeout(() => msgEl.classList.remove('highlight-pulse'), 2200);
        }
    }, 100);
}


// ==================== 语笺页面 ====================

function enterNotesMode() {
    state.notesMode = true;
    state.diaryMode = false;
    if (window.matchMedia('(max-width: 980px)').matches) {
        state.notesTab = 'message';
        document.querySelectorAll('.notes-tab').forEach(btn => {
            const active = btn.dataset.tab === 'message';
            btn.classList.toggle('tab-active', active);
            btn.classList.toggle('text-indigo-500', !active);
            btn.classList.toggle('bg-white/40', !active);
            btn.classList.toggle('border', !active);
            btn.classList.toggle('border-white/55', !active);
        });
    }
    elements.initialState.classList.add('hidden');
    elements.conversationHistory.classList.add('hidden');
    elements.inputBar.classList.add('hidden');
    elements.floatingMic.classList.add('hidden');
    elements.diaryPage.classList.add('hidden');
    elements.notesPage.classList.remove('hidden');
    elements.currentConversationTitle.textContent = '语笺';
    renderNotesPage(elements.notesSearch.value);
    setRailActive('notes');
}

function exitNotesMode() {
    state.notesMode = false;
    elements.notesPage.classList.add('hidden');
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    if (conv) {
        updateCurrentConversationTitle();
        elements.conversationHistory.classList.remove('hidden');
        elements.inputBar.classList.remove('hidden');
    } else {
        showInitialState();
    }
    syncRailActive();
}

function setRailActive(action) {
    // 竖栏上只有「成就」一个按钮（data-rail-action = achievements），分类弹窗
    //   由**成就面板内部**的按钮打开。所以这里把两者当成**同一组**处理：
    //     · 打开分类弹窗时高亮的是那个成就按钮（它们是同一个入口）
    //     · 切到别的动作时，两个浮层都要收起来
    //   不这么写的话，点开分类弹窗后竖栏会没有任何按钮是高亮的
    //   （看起来像"点了没反应"）。
    const ACH = 'achievements';
    const isAchGroup = (a) => a === ACH || a === 'categories';

    if (!isAchGroup(action)) {
        if (!elements.categoriesModalOverlay.classList.contains('hidden')) {
            elements.categoriesModalOverlay.classList.add('hidden');
            elements.categoriesModalOverlay.classList.remove('flex');
        }
        try {
            if (window.ElainaAchievements && window.ElainaAchievements.isOpen()) {
                window.ElainaAchievements.close();
            }
        } catch (e) { /* 成就模块不在时忽略 */ }
    }
    // 分类弹窗开着时，高亮的仍是成就按钮（它们共用一个入口）
    const want = action === 'categories' ? ACH : action;
    document.querySelectorAll('.sidebar-rail-btn[data-rail-action]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.railAction === want);
    });
    // 原型的语笺/日记页仍保留外壳顶栏，所以「整理记忆」和「公告」不再随页面模式收起。
    elements.memoryBtn.classList.remove('page-mode-hidden');
    elements.memoryBtn.setAttribute('aria-hidden', 'false');
    elements.memoryBtn.tabIndex = 0;
    elements.announceBtn?.classList.remove('page-mode-hidden');
    syncMainHeaderVisibility();
}

function syncMainHeaderVisibility() {
    // 设置/成就/市场现在都让出顶栏、作为主区页面显示，外壳顶栏始终保留。
    elements.chatHeader.classList.remove('hidden');
    elements.chatHeader.setAttribute('aria-hidden', 'false');
}

function syncRailActive() {
    if (state.diaryMode) setRailActive('diary');
    else if (state.notesMode) setRailActive('notes');
    else setRailActive('chat');
}

function diaryTimestamp(entry) {
    const parsed = Date.parse(entry && entry.timestamp);
    return Number.isFinite(parsed) ? parsed : parseDiaryDate(entry && entry.date);
}

function diaryDisplayDate(entry) {
    const base = entry?.date || '未标注日期';
    const parsed = Date.parse(entry?.timestamp);
    if (!Number.isFinite(parsed)) return base;
    return `${base} · ${new Date(parsed).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * 旅行日记页 —— **按对话分组**渲染。
 *
 * ── 为什么要分组─────────────────────────────────────
 *
 *   "日记这个地方进行分类，比如我开了 5 段对话那 5 个对话有不同的日记，
 *    不互相打扰。"
 *
 *   日记条目本来就带 conversationId / conversationTitle。不按它分组的话，
 *   所有条目会平铺在一个网格里、按时间倒序，看起来就是**一锅粥** ——
 *   分不清哪条属于哪段故事。更要紧的是数据侧若按"日期"合并，
 *   同一天的两段对话会互相覆盖（数据层按 conversationId 区分，见 data.js）。
 *
 * ── 分组的几个取舍 ─────────────────────────────────────────────────────
 *
 *   · **组的顺序按"该组最新一条"倒序** —— 最近聊过的对话排在最前，
 *     符合"我最近在关心什么"的直觉。
 *   · **组内仍按时间倒序**。
 *   · 没有 conversationId 的老条目归到「未归属」组，**不猜**它属于谁
 *     （猜错会把内容挂到错误的对话上，比不分组更糟）。
 *   · 对话已被删除时，用条目自己存的 conversationTitle 兜底，
 *     标成「已删除的对话」而不是让它消失 —— 日记是回忆，不该因为
 *     删了对话就看不见。
 */
function renderDiaryPage() {
    const diary = Array.isArray(state.memoryCore?.diary) ? [...state.memoryCore.diary] : [];
    diary.sort((a, b) => diaryTimestamp(b) - diaryTimestamp(a));

    // 支持"点侧栏对话 → 只看这段对话的日记"。
    //   state.diaryFilterConvId 由 focusDiaryGroup() 设置（空 = 显示全部）。
    //   筛选放在**数据层**而不是 CSS 隐藏：被筛掉的组不生成 DOM，
    //     长日记（几十上百条）时省掉大量无谓节点 —— 这对手机端尤其重要。
    const filterId = state.diaryFilterConvId || '';
    const shown = filterId ? diary.filter((e) => (e.conversationId || '') === filterId) : diary;

    elements.diaryCount.textContent = filterId
        ? `${shown.length} / ${diary.length} 条记录`
        : `${diary.length} 条记录`;
    elements.diaryEmpty.classList.toggle('hidden', shown.length > 0);
    elements.diaryGrid.innerHTML = '';

    // 日记页顶部**不放**「只看：xxx　显示全部」筛选条 ——
    //   那个分类/筛选的职责**已经交给左边的对话记录**了
    //   （点侧栏那段对话 = 只看它的日记，再点一次取消）。
    //   两处都能筛选只会让人困惑"到底该点哪儿"。
    //   被筛掉时的"当前在看哪一段"提示改由计数体现（见上面的 `1 / 2 条记录`）。

    for (const g of groupDiaryEntries(shown)) {
        elements.diaryGrid.appendChild(createDiaryGroupHead(g, filterId));
        for (const entry of g.entries) {
            elements.diaryGrid.appendChild(createDiaryCard(entry, g.title));
        }
    }
}

function groupDiaryEntries(shown) {
    const groups = new Map();   // key -> { id, title, conv, entries: [] }
    for (const entry of shown) {
        const id = entry.conversationId || '';
        const conv = id ? state.conversations.find(c => c.id === id) : null;
        let title;
        if (conv) title = conv.title || '未命名对话';
        else if (entry.conversationTitle) title = entry.conversationTitle;
        else title = id ? '已删除的对话' : '未归属的片段';
        const key = id || '__none__';
        if (!groups.has(key)) groups.set(key, { id, title, conv: conv || null, entries: [] });
        groups.get(key).entries.push(entry);
    }
    // 组按"最新一条"倒序 —— diary 已排好序，所以每组第一次出现的位置就是它的最新时间
    return [...groups.values()];
}

function createDiaryGroupHead(g, filterId) {
    const head = document.createElement('div');
    head.className = 'diary-group-head';
    // 当前被筛选的那一组加高亮（筛选条已移除，需要一个视觉落点告诉用户
    //   "点中了、现在看的就是这一段"）。
    if (filterId && g.id === filterId) head.classList.add('is-focused');
    // 用 conversationId 作为锚点 id：focusDiaryGroup() 靠它滚动定位。
    //   用 data 属性而不是 id 拼字符串，避免 id 里出现非法字符（对话 id 来自生成器）。
    if (g.id) head.dataset.diaryGroupId = g.id;
    const jumpable = Boolean(g.conv);
    if (jumpable) head.classList.add('is-jumpable');
    // 组头不再"点了就跳去聊天"（那是用户明确要去掉的行为）。
    //   改成：点组头 = 在**本页内**只看这段对话（等价于点侧栏那条）。
    //   想真的进对话，用组头右侧的「进入对话」按钮 —— 保留了入口，
    //   但不会误触（用户点标题多半只是想看日记）。
    head.tabIndex = 0;
    head.title = '只看这段对话的日记';
    head.innerHTML = `
        <span class="diary-group-dot" aria-hidden="true"></span>
        <span class="diary-group-title">${escapeHtml(g.title)}</span>
        <span class="diary-group-count">${g.entries.length} 条</span>
        ${jumpable ? '<button type="button" class="diary-group-enter" data-diary-enter="1" title="进入这段对话">进入对话</button>' : ''}
    `;
    const focusThis = () => {
        if (g.id) focusDiaryGroup(g.id);
    };
    head.addEventListener('click', (event) => {
        // 点「进入对话」按钮 → 真的切过去
        if (event.target.closest('[data-diary-enter]')) {
            event.stopPropagation();
            exitDiaryMode();
            switchConversation(g.conv.id);
            return;
        }
        focusThis();
    });
    head.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusThis(); }
    });
    return head;
}

function createDiaryCard(entry, groupTitle) {
    const card = document.createElement('article');
    card.className = 'diary-card animate-fade-in-up';
    const essences = Array.isArray(entry.essences) ? entry.essences.filter(Boolean).slice(0, 6) : [];
    // 标题已在组头上，卡片里不再重复显示对话名 ——
    //   否则同一屏里同一个名字会出现 N 遍，反而更乱。
    card.innerHTML = `
        <div class="diary-card-date">${escapeHtml(diaryDisplayDate(entry))}</div>
        <div class="diary-card-text">${escapeHtml(entry.content || '')}</div>
        ${essences.length ? `<div class="diary-essences">${essences.map(tag => `<span class="diary-essence">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
    `;
    // 点卡片**弹窗看全文**。
    //   卡片正文被 `-webkit-line-clamp: 4` 截成 4 行，而且卡片本身
    //   **没有就地展开的入口**，长日记因此永远读不全。
    //   点击直接弹出完整内容，既不破坏网格布局，也不会让用户
    //   误以为点一下是"跳到原对话"。
    card.tabIndex = 0;
    card.title = '查看完整内容';
    const openDetail = () => openDiaryDetail(entry, groupTitle);
    card.addEventListener('click', openDetail);
    card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(); }
    });
    return card;
}

/**
 * 在日记页里"只看某段对话"。
 *
 * 这就是用户要的"聊天记录本身就是一种分类"：
 *   点侧栏的对话不再跳去聊天，而是把日记筛到那一段。
 *   再点同一段（或点提示条上的「显示全部」）取消筛选。
 *
 * @param {string} convId 对话 id
 */
function focusDiaryGroup(convId) {
    if (!convId) return;
    // 点同一段 → 取消筛选（像开关一样，避免"筛进去了出不来"）
    state.diaryFilterConvId = (state.diaryFilterConvId === convId) ? '' : convId;
    renderDiaryPage();
    // 必须同时重绘侧栏：条目高亮是在 createConversationItem 里按
    //   "当前看的是哪一段"算出来的，不重绘的话点了对话侧栏仍然没有选中特效
    //   （用户报的"日记系统中选中没有对应特效"就是这个）。
    if (typeof renderFolderList === 'function') renderFolderList();
    // 滚动到该组标题（筛选后它就在最上面，但用户可能刚滚到别处）
    requestAnimationFrame(() => {
        const head = elements.diaryGrid.querySelector('[data-diary-group-id]');
        if (head && head.scrollIntoView) {
            try { head.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { /* 老浏览器 */ }
        }
    });
}

// 日记页网格顶部**不放**筛选条（renderDiaryFilterBar 已删除）：
//   分类/筛选**统一交给左边的对话记录**
//   （点侧栏那段对话即筛选，再点一次取消），日记页里再放一套筛选入口
//   只会让人困惑"到底该点哪儿"。
//   当前筛选状态仍由计数体现（`N / M 条记录`）。

/**
 * 日记详情弹窗（看全文）。
 *
 * 为什么用弹窗而不是"就地展开"：日记正文可以很长（记忆提取器最多写 4000 字），
 *   就地展开会把网格铺得七零八落、后面的卡片被推到很远。
 *   弹窗能完整显示、又不影响列表布局。
 *
 * 复用宿主的弹窗样式（.modal-overlay / .modal-panel），与设置、语笺详情一致 ——
 *   自己写一套样式会和主题/深色模式对不上。
 */
let diaryDetailEl = null;

function openDiaryDetail(entry, fallbackTitle) {
    if (!diaryDetailEl) {
        diaryDetailEl = document.createElement('div');
        diaryDetailEl.id = 'diaryDetailOverlay';
        diaryDetailEl.className = 'fixed inset-0 z-50 hidden items-center justify-center p-4 modal-overlay';
        diaryDetailEl.innerHTML =
            '<div class="modal-panel w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden animate-modal-pop">'
              + '<div class="flex items-center gap-3 px-6 py-4 border-b border-white/60 flex-shrink-0">'
                + '<div class="text-base font-bold text-indigo-950">日记</div>'
                + '<span id="diaryDetailMeta" class="diary-detail-meta"></span>'
                + '<button id="diaryDetailClose" class="ml-auto p-1.5 rounded-lg hover:bg-white/60 transition-colors" type="button" aria-label="关闭">'
                  + '<svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>'
                + '</button>'
              + '</div>'
              + '<div id="diaryDetailBody" class="flex-1 overflow-y-auto scroll-soft px-6 py-4"></div>'
            + '</div>';
        document.body.appendChild(diaryDetailEl);
        diaryDetailEl.querySelector('#diaryDetailClose').addEventListener('click', closeDiaryDetail);
        diaryDetailEl.addEventListener('click', (e) => {
            if (e.target === diaryDetailEl) closeDiaryDetail();
        });
    }
    const convId = entry.conversationId || '';
    const conv = convId ? state.conversations.find(c => c.id === convId) : null;
    const title = (conv && conv.title) || entry.conversationTitle || fallbackTitle || '';
    const essences = Array.isArray(entry.essences) ? entry.essences.filter(Boolean) : [];

    diaryDetailEl.querySelector('#diaryDetailMeta').textContent =
        (convId ? (title ? title + ' · ' : '') : '') + diaryDisplayDate(entry);
    // 正文用 textContent（下面逐个 append），不用 innerHTML ——
    //   日记正文来自模型输出，可能含 < > 之类字符；插进 innerHTML 会有注入面。
    const body = diaryDetailEl.querySelector('#diaryDetailBody');
    body.innerHTML = '';
    const p = document.createElement('div');
    p.className = 'diary-detail-text';
    p.textContent = entry.content || '';
    body.appendChild(p);
    if (essences.length) {
        const tags = document.createElement('div');
        tags.className = 'diary-essences';
        for (const t of essences) {
            const s = document.createElement('span');
            s.className = 'diary-essence';
            s.textContent = t;
            tags.appendChild(s);
        }
        body.appendChild(tags);
    }
    diaryDetailEl.classList.remove('hidden');
    diaryDetailEl.classList.add('flex');
}

function closeDiaryDetail() {
    if (!diaryDetailEl) return;
    diaryDetailEl.classList.add('hidden');
    diaryDetailEl.classList.remove('flex');
}

function enterDiaryMode() {
    state.diaryMode = true;
    state.notesMode = false;
    // 每次进入都从"显示全部"开始：筛选是**当次浏览**的临时状态，
    //   不该跨次留存（否则用户下次打开日记会以为只剩那一段）。
    state.diaryFilterConvId = '';
    elements.initialState.classList.add('hidden');
    elements.conversationHistory.classList.add('hidden');
    elements.inputBar.classList.add('hidden');
    elements.notesPage.classList.add('hidden');
    elements.floatingMic.classList.add('hidden');
    elements.diaryPage.classList.remove('hidden');
    elements.currentConversationTitle.textContent = '旅行日记';
    renderDiaryPage();
    setRailActive('diary');
}

function exitDiaryMode() {
    state.diaryMode = false;
    // 离开日记页时清掉筛选与详情弹窗 —— 不然下次进来会莫名只显示一部分，
    //   或者详情弹窗还挂在别的页面上面（它挂在 body 上，不随页面隐藏）。
    state.diaryFilterConvId = '';
    closeDiaryDetail();
    elements.diaryPage.classList.add('hidden');
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    if (conv) {
        updateCurrentConversationTitle();
        elements.conversationHistory.classList.remove('hidden');
        elements.inputBar.classList.remove('hidden');
    } else {
        showInitialState();
    }
    // 重绘侧栏：离开日记页后高亮要从"筛选那段"切回"当前对话那段"
    //   （两个状态来源不同，见 createConversationItem 里的说明）。
    if (typeof renderFolderList === 'function') renderFolderList();
    syncRailActive();
}

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
            showClientApiError(error);
            return;
        }
        if (!textToSpeak) {
            setVoicePlaybackState(messageId, false);
            showCustomAlert('未能生成日语朗读稿，本次不会回退播放中文。请稍后重试。', '日语语音生成失败');
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
        showClientApiError(error);
    });
}


