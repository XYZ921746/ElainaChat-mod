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

function renderThinkingMessage() {
    if (!elements.conversationHistory) return;
    if (document.getElementById('thinking-bubble')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'thinking-bubble';
    wrapper.className = 'flex gap-3 mb-4 thinking-bubble animate-fade-in-up';
    wrapper.innerHTML = `
        <div class="pixso-chat-avatar" aria-hidden="true">
            <img src="/icons/icon-192.png" alt="" draggable="false">
        </div>
        <div class="flex-1 min-w-0">
            <div class="bubble-ai rounded-2xl px-4 py-3 inline-flex items-center gap-2.5">
                <span class="thinking-dot"></span>
                <span class="thinking-dot"></span>
                <span class="thinking-dot"></span>
                <span class="thinking-label text-sm ml-1">伊蕾娜正在想...</span>
            </div>
        </div>
    `;
    elements.conversationHistory.appendChild(wrapper);
    elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
}

/**
 * 更新「正在想」气泡上的文案（超时重试等场景的提示）。
 *
 * 为什么需要它：重试期间的等待对用户是完全黑箱的 —— 气泡还挂着三点动画，
 * 看不出「第二次请求已经发出」。把状态写在这行文案上，用户就能知道
 * 「不是卡死，是网络不稳正在重试」。气泡不在（已被收掉）就什么都不做。
 */
function updateThinkingMessageText(text) {
    const label = document.querySelector('#thinking-bubble .thinking-label');
    if (label) label.textContent = String(text || '');
}

//  回合过程渲染：思考行 + 工具调用行 + 每回合总览
// 为什么要有这一整块，而不是"把 reasoning 拼到气泡里"：
//   ① 角色扮演应用里，模型思考内容经常包含"我不该直接回答这个"这类
//      出戏的元叙述，混进正文会破坏体验 —— 必须分开展示；
//   ② 关掉思考开关时，工具调用记录**仍然要显示**（用户的原话：
//      "思考模式关闭的情况下思维链还是要显示工具调用的"）——
//      因为那是"AI 干了什么"的事实记录，不是思考过程；
//   ③ 需要"每回合总览"：用户想知道这一轮 AI 到底做了什么，
//      而不是逐行读每一条调用。
// 折叠策略（参考 DSH）：全部默认折叠，摘要行常驻。
// 理由：这是聊天应用，正文才是主角；思考动辄上千字，默认展开会把对话顶走。

/** 一次回合（= 一条 AI 回复的处理过程）的记录容器 */
function createTurnTrace() {
    return {
        // 时间线：思考段与工具调用**按发生先后混排**。
        //   为什么不能"全部思考拼成一坨 + 工具另存一列"：
        //   两段式下拉的**第一段**要回答的问题是"它先想了什么、于是调了什么、
        //   然后又想了什么" —— 那是因果顺序。分开存就再也还原不出来了
        //   （纯拼接的 reasoning 字符串 + 一个只有工具的 items 列表，
        //   两者之间的先后关系在存入时就已丢失）。
        //   每一项：{ kind:'reasoning'|'tool'|'phase', id, at, ... }
        //     reasoning → { text }
        //     tool      → { ref } 指向 tools 里的那一项
        //     phase     → { ref } 指向 phases 里的那一项（两段式生成的阶段输出）
        timeline: [],
        // 两段式生成（第三人称）的阶段输出：{ index, title, text, at }
        // 第一段 = GM 第三人称叙述，第二段 = 用户实际看到的第一人称正文
        phases: [],
        // 全部思考的拼接。总览行与"这一轮有没有思考"的判据用它，
        // 避免为了一个布尔判断去遍历时间线。
        reasoning: '',
        tools: [],
        // 时间线元素的稳定 id 来源。用它而不是 at（时间戳）当 key ——
        // 同一毫秒内记两条会撞号，而 data-key 撞号会让"记住用户展开过哪一行"错位。
        nextId: 1,
        startedAt: Date.now(),
    };
}

/** 当前正在进行的回合记录。一条 AI 回复对应一个，回复完成后清空。 */
let activeTurnTrace = null;

/** 本轮过程区要插到哪个消息前面（AI 气泡的 id） */
let activeTurnAnchorId = null;

function beginTurnTrace(anchorMessageId) {
    activeTurnTrace = createTurnTrace();
    activeTurnAnchorId = anchorMessageId ? String(anchorMessageId) : null;
    return activeTurnTrace;
}

/**
 * 追加思考增量。思考开关关着时也允许调用 —— 由渲染层决定显不显示，
 * 而不是由收集层决定收不收：万一用户中途打开开关，已经收到的内容不该是空的。
 *
 * 时间线规则（两段式下拉的"按先后排序"就靠它）：
 *   · 连续的思考增量**合并进同一段**（流式一次回复有上千个增量，
 *     逐个建段会让时间线爆炸）；
 *   · 一旦中间插入了工具调用 / 阶段输出，或**换了阶段**（phase 变化），
 *     下一次思考就另起一段 —— 这样"先想什么→于是调了什么→接着又想什么"
 *     的因果顺序才留得下来。
 *   · 只把所有思考拼成一坨（trace.reasoning）就够显示，
 *     但与工具列表之间的先后关系在存入时就丢了，事后无法还原 ——
 *     所以必须另记时间线（见 createTurnTrace）。
 *
 * @param {string} delta 思考增量
 * @param {number} [phase] 该增量属于第几阶段（两段式生成时由 data 层打标）
 */
function appendTurnReasoning(delta, phase) {
    if (!activeTurnTrace || !delta) return;
    const text = String(delta);
    const ph = Number.isFinite(phase) ? Number(phase) : null;
    activeTurnTrace.reasoning += text;
    const tl = activeTurnTrace.timeline;
    const last = tl[tl.length - 1];
    // phase 不同必须另起一段：两段式生成里第一阶段（GM 叙述）与
    //   第二阶段（第一人称改写）的思考是两次独立的推理，混成一段会让
    //   用户看到"一段思考里前后矛盾"。
    if (last && last.kind === 'reasoning' && last.phase === ph) {
        last.text += text;
    } else {
        tl.push({
            kind: 'reasoning',
            id: 'think-' + activeTurnTrace.nextId++,
            at: Date.now(),
            phase: ph,
            // 段首空白只在**建段时**去一次，后续增量原样追加 ——
            //   这样 item.text 与 DOM 文本节点的内容严格一致（前缀对齐），
            //   renderTurnProcess 的增量路径才能用 appendData 只追增量。
            //   （显示层不再做整体 trim：那会每次复制整段文本，正是卡顿来源之一。）
            text: text.replace(/^\s+/, ''),
        });
    }
    scheduleTurnProcessRender();
}

/**
 * 记录一次工具/操作调用。
 *
 * @param {object} entry { kind, title, summary, args, result, state }
 *   kind    用于选图标与配色：read/write/search/command/phone/file/others
 *   state   running | ok | error | stopped
 *   args    调用参数（展开后显示）
 *   result  执行结果（展开后显示）
 */
function recordTurnTool(entry) {
    if (!activeTurnTrace) return null;
    const item = {
        kind: String(entry?.kind || 'others'),
        title: String(entry?.title || '操作'),
        summary: String(entry?.summary || ''),
        args: entry?.args === undefined ? '' : String(entry.args),
        result: entry?.result === undefined ? '' : String(entry.result),
        state: String(entry?.state || 'ok'),
        // 稳定的时间线 key（见 nextId 的说明）。at 只用于显示相对时间。
        key: 'tool-' + activeTurnTrace.nextId++,
        at: Date.now(),
        // 渲染版本号：updateTurnTool 每次改动自增。增量渲染靠它判断
        //   "这一行变没变"（O(1)），不必每帧重新构建行的 HTML 去比对。
        rev: 0,
        // 计时起点：用于在收尾时算出这一步花了多久。
        //   为什么要显示耗时：一轮 Agent 任务里"哪一步慢"是用户唯一能据以判断
        //   "是不是卡住了"的信息。全部只显示"完成"，慢的那一步和快的那一步长得一样。
        startedAt: Date.now(),
        ms: 0
    };
    activeTurnTrace.tools.push(item);
    // 同时进时间线 —— 这样"思考 1 → 工具 A → 思考 2"的先后顺序才留得下来
    activeTurnTrace.timeline.push({ kind: 'tool', id: item.key, at: item.at, ref: item });
    scheduleTurnProcessRender();
    return item;
}

/**
 * 记录一次**阶段输出**（两段式生成用）。
 *
 * 第三人称模式下，一次回复其实由两条模型输出拼成：
 *   第 1 段 = GM 第三人称叙述（用户看不到，但它是第 2 段的输入）
 *   第 2 段 = 第一人称转换结果（**这才是用户看到的正文**）
 * 用户要求把这两段都留下来、并各有一个可单独展开的下拉 —— 就在这里存。
 *
 * @param {object} entry { index, title, text, state }
 */
function recordTurnPhase(entry) {
    if (!activeTurnTrace) return null;
    const item = {
        index: Number(entry?.index) || (activeTurnTrace.phases.length + 1),
        title: String(entry?.title || '阶段输出'),
        text: entry?.text === undefined ? '' : String(entry.text),
        state: String(entry?.state || 'ok'),
        key: 'phase-' + activeTurnTrace.nextId++,
        at: Date.now(),
    };
    activeTurnTrace.phases.push(item);
    activeTurnTrace.timeline.push({ kind: 'phase', id: item.key, at: item.at, ref: item });
    scheduleTurnProcessRender();
    return item;
}

/** 更新最近一条工具记录的状态/结果（执行完成时回填） */
function updateTurnTool(item, patch = {}) {
    if (!item || !activeTurnTrace) return;
    if (patch.state !== undefined) item.state = String(patch.state);
    if (patch.result !== undefined) item.result = String(patch.result);
    if (patch.summary !== undefined) item.summary = String(patch.summary);
    // 标题与类型允许后补：走工具通道时外层先按"调用 save_file"记一行，
    //   真正的动作含义（"写入文件"）要等进入 doAgentFile 才知道。
    if (patch.title !== undefined) item.title = String(patch.title);
    if (patch.kind !== undefined) item.kind = String(patch.kind);
    // 渲染版本自增：增量渲染据此只重建这一行，而不是整个过程区。
    item.rev = (item.rev || 0) + 1;
    // 重开计时：用户在确认弹窗上做决定的时间**不是这一步的执行耗时**。
    //   不重置的话，一次"等待 17 秒才点允许"会被显示成"命令跑了 20 秒"，
    //   用户会误以为命令执行本身很慢（实测就是这么报的）。调用方在
    //   "用户点了允许、真正重发执行"那一刻带 resetTimer。
    if (patch.resetTimer === true) {
        item.startedAt = Date.now();
        item.ms = 0;
    }
    // 从 running 变成终态的那一刻结算耗时（只结算一次：重复更新不该把时长清零）
    if (item.state !== 'running' && item.startedAt && !item.ms) {
        item.ms = Math.max(0, Date.now() - item.startedAt);
    }
    scheduleTurnProcessRender();
}

/**
 * 增量渲染用 requestAnimationFrame 合并。
 *
 * 不合并的话，流式每来一个 token 就重建一次 DOM —— 一次长回复有上千个增量，
 * 每个都重排一次会让页面明显卡顿（而且越到后面越卡，因为内容越长）。
 * 合并到每帧一次，视觉上完全看不出差别，开销却降了两个数量级。
 */
let turnProcessRenderScheduled = false;
function scheduleTurnProcessRender() {
    if (turnProcessRenderScheduled) return;
    turnProcessRenderScheduled = true;
    const run = () => { turnProcessRenderScheduled = false; renderTurnProcess(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
}

/** 工具类型 → 图标 SVG（内联，避免依赖图标库） */
function processIconSvg(kind) {
    const paths = {
        read: '<path stroke-linecap="round" stroke-linejoin="round" d="M4 5.5A2.5 2.5 0 016.5 3H20v15H6.5A2.5 2.5 0 004 20.5z"/><path stroke-linecap="round" d="M4 5.5v15"/>',
        write: '<path stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9a2.1 2.1 0 10-3-3L5 17v3z"/>',
        search: '<circle cx="11" cy="11" r="6"/><path stroke-linecap="round" d="M20 20l-4.3-4.3"/>',
        command: '<rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M7 9l3 3-3 3M13 15h4"/>',
        phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path stroke-linecap="round" d="M10.5 18.5h3"/>',
        file: '<path stroke-linecap="round" stroke-linejoin="round" d="M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V9z"/><path stroke-linecap="round" d="M13 3v6h6"/>',
        think: '<path stroke-linecap="round" stroke-linejoin="round" d="M9.7 17h4.6M12 3a6 6 0 00-3.6 10.8c.7.5 1.1 1.3 1.1 2.2V16h5v-.1c0-.9.4-1.6 1.1-2.2A6 6 0 0012 3z"/>',
        // 两段式生成的「阶段输出」：用文档图标区分于思考（脑）与工具（齿轮）
        phase: '<path stroke-linecap="round" stroke-linejoin="round" d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path stroke-linecap="round" d="M14 3v5h5M9 13h6M9 17h4"/>',
        // 浏览器：一个窗口 + 地址栏，与"命令"（终端框）区分开
        browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M3 9h18M7 6.5h.01M9.5 6.5h.01"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 13h8M8 16.5h5"/>',
        others: '<circle cx="12" cy="12" r="8"/><path stroke-linecap="round" d="M12 8v4.5l2.5 1.5"/>'
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${paths[kind] || paths.others}</svg>`;
}

/** 状态 → 中文文案 */
function processStateLabel(state) {
    if (state === 'running') return '运行中';
    if (state === 'error') return '失败';
    if (state === 'stopped') return '已停止';
    return '完成';
}

/** 耗时 → 人能一眼读懂的短文案。
 *
 *  阈值定在 **100ms** 而不是 1 秒：Agent 的单步操作（列目录、读文件）本来就常在
 *  几十到几百毫秒之间，用 1 秒当门槛等于"绝大多数步骤都不显示耗时" ——
 *  那就失去意义了。低于 100ms 不显示，是因为那个量级的数字反映的是调度抖动，
 *  不是这一步真的花了多久。
 */
function processDurationLabel(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 100) return '';
    if (n < 1000) return Math.round(n) + 'ms';
    if (n < 10000) return (n / 1000).toFixed(1) + 's';
    if (n < 60000) return Math.round(n / 1000) + 's';
    return Math.floor(n / 60000) + 'm' + Math.round((n % 60000) / 1000) + 's';
}

/**
 * 把参数（一行 JSON）拆成「键 → 值」清单，给时间线渲染成表格。
 *
 * 为什么要拆：Agent 的参数里最要紧的是 `path` / `command` 这类**值**，
 * 而一整行 JSON 恰恰让那个值淹没在花括号和逗号里 —— 用户得自己找。
 * 拆成键值行后，"这一步对哪个文件做了什么"是扫一眼就能读到的。
 *
 * 解析不出来就原样返回单条（宁可难看，也不要吞掉参数）。
 *
 * @param {string} raw JSON 文本
 * @returns {Array<{key:string, value:string}>}
 */
function processArgEntries(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];
    let obj;
    try { obj = JSON.parse(text); } catch { return [{ key: '', value: text }]; }
    if (!obj || typeof obj !== 'object') return [{ key: '', value: text }];
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
        let val;
        if (typeof v === 'string') val = v;
        else if (v === null || v === undefined) val = '';
        else { try { val = JSON.stringify(v); } catch { val = String(v); } }
        out.push({ key: k, value: val });
    }
    return out;
}

/** 渲染参数块（键值 + 长文本值单独成行） */
function processArgsHtml(raw) {
    const entries = processArgEntries(raw);
    if (!entries.length) return '';
    const rows = entries.map((e) => {
        // 长值（文件内容、命令）占一整行，短值（路径、布尔）保持键值并排
        const long = e.value.includes('\n') || e.value.length > 80;
        if (long) {
            return `<div class="process-arg process-arg-block">`
                + (e.key ? `<span class="process-arg-key">${escapeHtml(e.key)}</span>` : '')
                + `<pre class="process-arg-value">${escapeHtml(e.value)}</pre></div>`;
        }
        return `<div class="process-arg">`
            + (e.key ? `<span class="process-arg-key">${escapeHtml(e.key)}</span>` : '')
            + `<code class="process-arg-value">${escapeHtml(e.value)}</code></div>`;
    });
    return `<div class="process-args">${rows.join('')}</div>`;
}

/** 生成一条过程行的 HTML（思考行 / 工具行通用）。
 *
 *  key：跨重渲染**稳定**的行标识（思考行固定 'think'，工具行 'tool-<at>'）。
 *       渲染层每次流式增量都用 innerHTML 整体重建过程区，重建会丢掉 .is-open，
 *       所以需要一个稳定的 key 才能在重建后把"用户手动展开过的行"重新展开 ——
 *       用索引不行：流式期间会不断追加新的工具行，索引会整体后移，恢复会错位。
 *
 *  点击**不挂内联 onclick**：流式期间本区每帧整体重建（见 renderTurnProcess），
 *       用户按下到松开之间行元素可能已被替换 —— 浏览器只在 mousedown 与
 *       mouseup 目标一致时才派发 click，绑在被替换元素上的 onclick 收不到。
 *       展开交互改由容器上的 pointerup 委托承担（见 onTurnProcessPointerUp），
 *       键盘 Enter/Space 保留内联 —— keydown 是即时事件，不受重建影响。
 *
 *  时间线形状（参考 DSH）：左侧一列竖线 + 节点圆点，把"想 → 做 → 想"串成一条
 *  有先后的流；每一行右侧仍是可展开的细节。竖线由 CSS 画在 .process-row 上，
 *  行与行之间自然接续 —— 所以这里不需要额外的容器元素。
 */
function processRowHtml({ kind, key, title, summary, state, bodyHtml, ms }) {
    const dur = processDurationLabel(ms);
    return `
        <div class="process-row" data-state="${escapeHtml(state || 'ok')}" data-kind="${escapeHtml(kind)}" data-key="${escapeHtml(key || kind)}">
            <button type="button" class="process-row-head" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleProcessRow(this);}" aria-expanded="false">
                <span class="process-row-icon" aria-hidden="true">${processIconSvg(kind)}</span>
                <span class="process-state" aria-hidden="true"></span>
                <span class="process-row-title">${escapeHtml(title)}</span>
                ${summary ? `<span class="process-row-summary">${escapeHtml(summary)}</span>` : '<span class="process-row-summary"></span>'}
                ${dur ? `<span class="process-row-duration">${escapeHtml(dur)}</span>` : ''}
                <span class="process-row-status">${escapeHtml(processStateLabel(state))}</span>
                <span class="process-row-chevron" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>
                </span>
            </button>
            <div class="process-row-body">${bodyHtml || ''}</div>
        </div>`;
}

/** 展开/收起一条过程行（键盘操作走这里；指针点击见 onTurnProcessPointerUp） */
function toggleProcessRow(button) {
    const row = button?.closest?.('.process-row');
    if (!row) return;
    const open = row.classList.toggle('is-open');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/**
 * 过程区展开/收起的**指针统一入口**：绑在容器（.turn-process）上的 pointerup 委托。
 *
 *   为什么用 pointerup 而不是 click：流式期间过程区每帧整体重建
 *   （renderTurnProcess 的 innerHTML = …），用户按下鼠标到松开之间，
 *   行元素可能已被重建替换 —— 浏览器只在 mousedown 与 mouseup 的目标
 *   一致（或存在共同祖先）时才把 click 派发到行上，而内联 onclick 绑在
 *   被替换的元素上，一个事件都收不到。表现是「AI 正在思考/输出时，
 *   思考行怎么点都没反应」，流式一停又能点开 —— 也就是"时好时坏"。
 *   pointerup 直接派发到松开那一刻所在的元素并冒泡，而容器本身从不被
 *   重建（只换它的子节点），所以委托永远收得到。
 */
function onTurnProcessPointerUp(event) {
    // 只认主键：右键/中键的松开不是"点击"（contextmenu 另算）
    if (event.button !== undefined && event.button !== 0) return;
    const target = event.target;
    const head = target?.closest?.('.process-row-head');
    if (head) { toggleProcessRow(head); return; }
    const summary = target?.closest?.('.turn-summary');
    if (summary) toggleTurnProcess(summary);
}

/**
 * 展开/收起**整个过程区**（总览行是这一层的开关）。
 *
 * 两段式下拉：
 *   第一段（点总览行）→ 展开**时间线**：思考段落与工具调用按发生先后排列；
 *   第二段（点时间线里某一条）→ 展开那条的**详细内容**：
 *     · 思考条 → 完整思考文本
 *     · 工具条 → 参数 / 结果（与 Agent 工具卡片一致）
 *     · 阶段条 → 该阶段的完整输出文本
 *
 * 指针点击经 onTurnProcessPointerUp（容器委托），键盘走内联 onkeydown ——
 * 两条入口最终都到这里。为什么必须两端都生效：桌面 CSS 里 is-expanded 只影响
 * 布局，若只对**手机**接线，桌面上就是一个"看着能点、点了没用"的死三角。
 * 箭头因此常驻（见 index.html 的 .turn-summary-toggle 规则）。
 */
function toggleTurnProcess(summaryEl) {
    const host = summaryEl?.closest?.('.turn-process');
    if (!host) return;
    const open = host.classList.toggle('is-expanded');
    summaryEl.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/**
 * 把当前回合的过程渲染到界面上。
 *
 * 渲染目标：`#turn-process-<锚点消息 id>`。锚点就是 AI 气泡的 id，
 * 过程区插在它**前面** —— 这样用户先看到"AI 做了什么/想了什么"，
 * 再看到正文，符合阅读顺序（DSH 也是这个顺序）。
 */
/** 总览行：只随计数变化，流式追加期间版本稳定。 */
function buildTurnSummaryEntry(summaryBits) {
    return {
        key: 'summary', kind: 'summary',
        // 总览内容只随计数变化（段数 / 各状态的工具数），流式追加期间稳定
        version: summaryBits.join('\u0001'),
        build: () => `<div class="turn-summary" role="button" tabindex="0"`
            + ` aria-expanded="false"`
            + ` onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleTurnProcess(this);}">`
            + summaryBits.map((b) => escapeHtml(b)).join('<span class="turn-summary-sep">·</span>')
            + `<span class="turn-summary-toggle" aria-hidden="true">`
            + `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>`
            + `</span></div>`,
    };
}

/** 思考行：版本 = 状态 + 文本长度（段内只追加，长度即变化）。 */
function buildTurnReasoningEntry(item, live) {
    return {
        key: item.id, kind: 'reasoning',
        // 版本 O(1)：状态（running→ok）+ 文本长度（段内只追加，长度即变化）
        version: (live ? 'running' : 'ok') + '#' + item.text.length,
        // 原文交给应用阶段做增量追加（与 DOM 文本严格同源，见 applyTurnProcessEntries）
        text: item.text,
        build: () => {
            // firstLine 只取有界前缀来算：旧写法 split 整段是 O(n)/帧
            const firstLine = item.text.slice(0, 200).split('\n').map((l) => l.trim()).find(Boolean) || '思考中';
            // 阶段标签：两段式生成时让用户知道这段思考属于哪一步
            const phaseNote = item.phase ? `（第 ${item.phase} 阶段）` : '';
            return processRowHtml({
                kind: 'think',
                key: item.id,
                title: '思考' + phaseNote,
                summary: firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine,
                // 最后一段思考且回合未结束时才是"运行中"，中间的段落都已结束
                state: live ? 'running' : 'ok',
                // 注意：不 trim。DOM 文本必须与 item.text 逐字一致，
                // 增量追加的前缀对齐才成立（段首空白已在建段时去过，见 appendTurnReasoning）
                bodyHtml: `<div class="process-reasoning">${escapeHtml(item.text)}</div>`
            });
        },
    };
}

/** 阶段输出行：完整原文进 pre，保留换行。 */
function buildTurnPhaseEntry(item) {
    const ph = item.ref || {};
    const phText = String(ph.text || '');
    return {
        key: item.id, kind: 'phase',
        version: String(ph.state || 'ok') + '#' + phText.length,
        build: () => {
            const text = phText.trim();
            const firstLine = text.slice(0, 200).split('\n').map((l) => l.trim()).find(Boolean) || '（空）';
            return processRowHtml({
                kind: 'phase',
                key: item.id,
                title: ph.title || ('第 ' + ph.index + ' 阶段输出'),
                summary: firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine,
                state: ph.state || 'ok',
                // 阶段输出是**完整原文**：用 pre 保留换行，方便对照
                bodyHtml: `<div class="process-row-label">完整输出</div><pre class="process-phase-text">${escapeHtml(text)}</pre>`
            });
        },
    };
}

/** 工具行：版本含 rev / 状态 / 耗时；参数拆成键值行，结果进 pre。 */
function buildTurnToolEntry(t, key) {
    return {
        key, kind: 'tool',
        // 工具行有专门的 rev 计数（updateTurnTool 每次改动自增），
        // 状态/耗时一并进版本：任何真实更新都会让版本变化
        version: (t.rev || 0) + '#' + t.state + '#' + t.ms,
        build: () => {
            const body = [];
            // 参数拆成键值行（见 processArgsHtml 的说明）：整行 JSON 会把
            //   `path` / `command` 这类真正要紧的值埋进花括号里，得自己找。
            if (t.args) body.push(`<span class="process-row-label">参数</span>${processArgsHtml(t.args)}`);
            if (t.result) body.push(`<span class="process-row-label">结果</span><pre>${escapeHtml(t.result)}</pre>`);
            return processRowHtml({
                kind: t.kind,
                key,
                title: t.title,
                summary: t.summary,
                state: t.state,
                ms: t.ms,
                bodyHtml: body.join('')
            });
        },
    };
}

function renderTurnProcess() {
    if (!elements.conversationHistory) return;
    const trace = activeTurnTrace;
    if (!trace) return;

    // 思考开关只决定**思考段落**显不显示（见下方 timeline 的过滤）。
    // 工具调用无条件显示 —— 那是"AI 干了什么"的事实记录，
    // 关掉思考不代表用户可以不知道 AI 动了哪些文件。
    const showReasoning = Boolean(state.settings.thinkingMode);

    const anchorId = activeTurnAnchorId ? `turn-process-${safeAttrId(activeTurnAnchorId)}` : 'turn-process-active';
    let host = document.getElementById(anchorId);
    if (!host) {
        host = document.createElement('div');
        host.id = anchorId;
        host.className = 'turn-process';
        // 追加到容器末尾。
        //   时序：用户气泡先渲染 → 流式增量到来 → 过程区这时才创建。
        //   此时 AI 气泡**还不存在**，所以不能按"插在 AI 气泡前面"来挂；
        //   用用户消息 id 当锚点 insertBefore 会把过程区插到
        //   **用户气泡上面**（已思考横条出现在"在吗"上面）。
        //   直接 appendChild 到末尾：过程区排在用户气泡之后；
        //   AI 气泡回复完成时 appendChild 到末尾，自然排在过程区之后
        //   —— 最终顺序正好是「用户消息 → 思考/过程 → AI 正文」。
        elements.conversationHistory.appendChild(host);
    }
    // 展开交互的 pointerup 委托只绑一次（见 onTurnProcessPointerUp 的说明）：
    // host 从不被重建、只换子节点，绑在它身上的监听在整个回合里持续有效；
    // data 标记防重复 —— 本函数每帧都会走到这里。
    if (!host.dataset.pointerWired) {
        host.dataset.pointerWired = '1';
        host.addEventListener('pointerup', onTurnProcessPointerUp);
    }

    // ---- 收集条目（**不构建 HTML**）----
    // 性能关键：只登记「有哪些行、版本号、真要渲染时怎么构建」。构建一行的成本随文本长度走
    //   （escapeHtml + HTML 解析），而流式期间每帧真正变化的通常只有**最后一行思考**；
    //   版本号是 O(1) 的（长度 / 状态 / 工具行的 rev 计数），没变的行在应用阶段直接跳过 ——
    //   每帧成本从 O(思考总长) 降到 O(增量)。
    const timeline = trace.timeline.filter((item) => item.kind !== 'reasoning' || showReasoning);
    const visibleReasoning = timeline.filter((item) => item.kind === 'reasoning');
    const hasReasoning = visibleReasoning.length > 0;
    const hasTools = trace.tools.length > 0;
    const hasPhases = trace.phases.length > 0;
    if (!hasReasoning && !hasTools && !hasPhases) return;

    const counts = { ok: 0, error: 0, running: 0, stopped: 0 };
    for (const t of trace.tools) counts[t.state] = (counts[t.state] || 0) + 1;
    const summaryBits = [];
    // 思考段数只在**多于一段**时报出来（一段时"已思考"就够了，
    // 报"1 段思考"反而啰嗦）
    if (hasReasoning) summaryBits.push(visibleReasoning.length > 1 ? `${visibleReasoning.length} 段思考` : '已思考');
    if (hasPhases) summaryBits.push(`${trace.phases.length} 段阶段输出`);
    if (counts.ok) summaryBits.push(`${counts.ok} 个操作完成`);
    if (counts.error) summaryBits.push(`${counts.error} 个失败`);
    if (counts.running) summaryBits.push(`${counts.running} 个进行中`);
    if (counts.stopped) summaryBits.push(`${counts.stopped} 个已停止`);

    const entries = [];
    // ---- 第一段：总览行（点它展开时间线）----
    // 思考开关：只控制**思考段落**是否显示。
    // 工具调用无条件显示 —— 那是"AI 干了什么"的事实记录，
    // 关掉思考不代表用户可以不知道 AI 动了哪些文件。
    if (summaryBits.length) entries.push(buildTurnSummaryEntry(summaryBits));

    // ---- 时间线：思考段落 / 工具调用 / 阶段输出，**按发生先后**排列 ----
    // 每一条自己再是一个可展开的 .process-row。不能把「全部思考」合成一行、工具另起若干行 —— 那样先后因果全丢了。
    const lastTimelineItem = timeline[timeline.length - 1];
    for (const item of timeline) {
        if (item.kind === 'reasoning') {
            // 空白段跳过：/\S/ 只扫到第一个非空白字符就停，不会复制整段文本
            if (!/\S/.test(item.text)) continue;
            const live = !trace.done && item === lastTimelineItem;
            entries.push(buildTurnReasoningEntry(item, live));
            continue;
        }
        if (item.kind === 'phase') {
            entries.push(buildTurnPhaseEntry(item));
            continue;
        }
        if (item.kind === 'tool') {
            entries.push(buildTurnToolEntry(item.ref || {}, item.id));
            continue;
        }
    }
    // 兜底：时间线为空但确有内容（例如历史数据结构不完整）时，
    // 至少把工具列出来，不让过程区变成空白。
    if (!entries.some((e) => e.kind !== 'summary')) {
        for (const t of trace.tools) {
            entries.push(buildTurnToolEntry(t, t.key || `tool-${t.at}`));
        }
    }

    // 应用到 DOM：能增量就增量（见 applyTurnProcessEntries 的说明）
    applyTurnProcessEntries(host, entries);

    // 总览行的 is-expanded 在**宿主** .turn-process 上，重建 innerHTML 不会清掉它
    //   （只换子节点），所以手机端的整体展开态天然保留；但总览元素本身是新造的、
    //   aria-expanded 默认 false，这里同步一下，免得辅助技术读到"已收起"与视觉不符。
    const summaryEl = host.querySelector('.turn-summary');
    if (summaryEl) summaryEl.setAttribute('aria-expanded', host.classList.contains('is-expanded') ? 'true' : 'false');

    stickChatScrollToBottom();
    // 返回容器：还原历史过程区时要把它挪到对应消息后面（见 restoreTurnProcessFor）
    return host;
}

/**
 * 聊天区"贴底跟随"：只在用户本来就停在底部附近时才自动滚动。
 *
 * 无条件滚底会把"流式期间往上翻历史"的用户每帧都拽回底部（用户实测）。
 * 判据"距底 < 80px"覆盖两种情况：
 *   · 用户正跟着流看（本来就贴底）→ 新内容出现后距离恰是一帧增量的高度，
 *     继续贴底，观感不变；
 *   · 用户往上翻了 → 距离远大于阈值，不再打扰，随便翻。
 * 过程区与流式正文预览共用这一份 —— 两处各写一遍必然有一处走样。
 */
function stickChatScrollToBottom() {
    const hist = elements.conversationHistory;
    if (!hist) return;
    const distance = hist.scrollHeight - hist.scrollTop - hist.clientHeight;
    if (distance < 80) hist.scrollTop = hist.scrollHeight;
}

/**
 * 把条目描述符应用到过程区容器 —— 过程区渲染的**性能核心**。
 *
 * ── 为什么需要增量 ─────────────────────────────────────────────────────
 * 旧实现每帧 `host.innerHTML = 全部内容`：对全部思考文本做 6 趟正则转义、
 * 整块 HTML 解析、全部子树节点重建。思考越长每帧越贵 —— 用户实测
 * "思考内容一长（内部滚动条出现后）就开始卡顿"。rAF 合并只压低了频率，
 * 每帧的成本仍是 O(思考总长)。
 *
 * ── 两条路径 ───────────────────────────────────────────────────────────
 * 快路径（常态：时间线只增长、行序是上次的**前缀**）：
 *   · 版本没变的行直接跳过（O(1) 比对）；
 *   · 思考行只是文本变长 → 往它的**文本节点 appendData(增量)**：元素本身
 *     不动，展开态与行内滚动位置天然保留，且每帧成本只与**增量**成正比，
 *     与思考总长无关 —— 这是修"越长越卡"的关键一步；
 *   · 其它变化（工具状态翻转 / 结果回填）→ 只换那一行（outerHTML），
 *     换前快照展开态与行内滚动、换后回填。
 * 慢路径（首次渲染 / 思考开关切换导致行集变化 / 行序不符 / DOM 与记录不同步）：
 *   整体重建 + 快照回填展开态与滚动位置（与旧实现一致，一次性的成本可接受）。
 *
 * 状态记录挂在 host 元素自身（`__elainaRows`）：host 按锚点消息 id 命名、
 * 每回合一个，loadConversation 清空容器时随之丢弃，不会串台。
 */
function rebuildTurnProcess(host, entries) {
    // ---- 慢路径：整体重建 ----
    // 重建会丢掉 toggleProcessRow 加上的 .is-open，所以覆盖前先快照「用户手动展开过」的行（data-key），重建后补回；
    //   否则表现为「每来一段新内容，已展开的思考行又被折叠」。
    const openKeys = new Set();
    for (const row of host.querySelectorAll('.process-row.is-open')) {
        const k = row.getAttribute('data-key');
        if (k) openKeys.add(k);
    }
    // 各行详情内部的滚动位置同样要快照：思考正文 / 结果 pre 都有
    //   max-height + overflow:auto，重建会把 scrollTop 静默重置为 0 ——
    //   表现为"流式期间一滑就弹回最上面"。行内滚动容器的出现顺序是
    //   确定性的（HTML 由本函数生成），按 key + 序号对应即可。
    const scrollMemory = new Map();
    for (const row of host.querySelectorAll('.process-row')) {
        const k = row.getAttribute('data-key');
        if (!k) continue;
        const tops = [];
        for (const scroller of row.querySelectorAll('.process-row-body pre, .process-reasoning')) {
            if (scroller.scrollTop > 0) tops.push(scroller.scrollTop);
        }
        if (tops.length) scrollMemory.set(k, tops);
    }
    host.innerHTML = entries.map((e) => e.build()).join('');
    // 恢复展开态：只补回快照里出现过的 key（新行保持默认收起）
    if (openKeys.size) {
        for (const row of host.querySelectorAll('.process-row')) {
            if (!openKeys.has(row.getAttribute('data-key'))) continue;
            row.classList.add('is-open');
            const head = row.querySelector('.process-row-head');
            if (head) head.setAttribute('aria-expanded', 'true');
        }
    }
    // 恢复行内滚动位置。恢复不了（行没了）就什么都不做。
    if (scrollMemory.size) {
        for (const row of host.querySelectorAll('.process-row')) {
            const tops = scrollMemory.get(row.getAttribute('data-key'));
            if (!tops) continue;
            const scrollers = row.querySelectorAll('.process-row-body pre, .process-reasoning');
            tops.forEach((top, i) => { if (scrollers[i]) scrollers[i].scrollTop = top; });
        }
    }
}

function updateTurnProcessRows(host, entries, prev) {
    // ---- 快路径：只动"变了"的行 ----
    const children = host.children;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (i < prev.versions.length && prev.versions[i] === entry.version) continue;
        if (i >= children.length) {
            // 新行（时间线增长了）：追加到末尾
            host.insertAdjacentHTML('beforeend', entry.build());
            continue;
        }
        const old = children[i];
        // 思考行只是文本变长：往文本节点追加增量。元素本身不动 ——
        //   展开/折叠、行内滚动天然保留，成本只与增量成正比。
        //   前缀对齐是硬判据：对不上（理论不该发生）就走下面的整行替换，宁慢勿错。
        if (entry.kind === 'reasoning' && prev.kinds[i] === 'reasoning') {
            const bodyEl = old.querySelector('.process-reasoning');
            const node = bodyEl && bodyEl.firstChild;
            if (node && node.nodeType === 3   // Text 节点
                && entry.text.length > node.data.length
                && entry.text.startsWith(node.data)) {
                node.appendData(entry.text.slice(node.data.length));
                continue;
            }
        }
        // 其余变化：只换这一行，换前快照展开态与行内滚动、换后回填
        const wasOpen = old.classList.contains('is-open');
        const tops = [];
        if (wasOpen) {
            for (const sc of old.querySelectorAll('.process-row-body pre, .process-reasoning')) {
                tops.push(sc.scrollTop);
            }
        }
        old.outerHTML = entry.build();
        const now = children[i];
        if (wasOpen && now) {
            now.classList.add('is-open');
            const head = now.querySelector('.process-row-head');
            if (head) head.setAttribute('aria-expanded', 'true');
            const scs = now.querySelectorAll('.process-row-body pre, .process-reasoning');
            tops.forEach((top, j) => { if (scs[j]) scs[j].scrollTop = top; });
        }
    }
}

function applyTurnProcessEntries(host, entries) {
    const prev = host.__elainaRows || null;
    const children = host.children;
    const fastPath = prev
        && prev.keys.length <= entries.length
        && children.length === prev.keys.length
        && prev.keys.every((k, i) => k === entries[i].key);

    if (fastPath) updateTurnProcessRows(host, entries, prev);
    else rebuildTurnProcess(host, entries);

    // 记录本轮的行序与版本，供下一帧比对
    host.__elainaRows = {
        keys: entries.map((e) => e.key),
        versions: entries.map((e) => e.version),
        kinds: entries.map((e) => e.kind),
    };
}

/**
 * 回合结束：把思考行标成完成，并**把过程持久化到消息上**。
 *
 * 为什么必须持久化：过程区是**追加到聊天容器末尾的临时 DOM**，而
 *   `loadConversation` 会先 `conversationHistory.innerHTML = ''` 再把每条消息
 *   重画一遍 —— 那些临时节点不在任何消息里，于是**整体消失**。
 *   用户的表现就是"聊了几轮之后，之前对话的思考记录不见了"：
 *   切个会话、刷新页面、甚至自动重载都会让它没掉。
 *   而注释一直写着"历史消息回看时还要看得到"，实际做不到。
 *
 * 所以收尾时把这一轮的记录挂到**它所依附的那条消息**上（`msg.turnTrace`），
 *   重画时由 renderMessage 一并还原（见 restoreTurnProcessFor）。
 *   存的是**数据**不是 HTML：HTML 依赖当时的展开状态与主题，存下来会越用越脏。
 */
function finishTurnTrace() {
    if (!activeTurnTrace) return;
    activeTurnTrace.done = true;
    renderTurnProcess();
    // 挂到锚点消息上（锚点就是开这一轮时给的那个消息 id）
    const anchorId = activeTurnAnchorId;
    if (anchorId) {
        try {
            const conv = typeof getCurrentConversation === 'function' ? getCurrentConversation() : null;
            const msg = conv && Array.isArray(conv.messages)
                ? conv.messages.find((m) => String(m.id) === String(anchorId))
                : null;
            if (msg) {
                // 只留渲染需要的最小形状：思考段 / 工具行 / 阶段输出，都是数据
                msg.turnTrace = {
                    timeline: activeTurnTrace.timeline,
                    reasoning: activeTurnTrace.reasoning,
                    tools: activeTurnTrace.tools,
                    phases: activeTurnTrace.phases,
                    done: true,
                    startedAt: activeTurnTrace.startedAt,
                };
                if (typeof saveConversations === 'function') saveConversations();
            }
        } catch (e) { /* 持久化失败不该影响回合收尾 */ }
    }
}

/**
 * 重画一条消息时，把它当年那一轮的过程区一并还原出来。
 *
 * 由 renderMessage 的调用方（loadConversation 的循环）在渲染后调用。
 * 走的是同一个 renderTurnProcess 逻辑，只是把"数据源"换成消息上存的那份 ——
 * 所以外观、折叠、展开态恢复全都天然一致，不存在两套渲染。
 */
function restoreTurnProcessFor(message) {
    const saved = message && message.turnTrace;
    if (!saved || !Array.isArray(saved.timeline) || !saved.timeline.length) return;
    const el = document.getElementById(`msg-${safeAttrId(message.id)}`);
    if (!el) return;
    // 已经还原过（同一条消息被重复渲染）就不再插第二份
    if (document.getElementById(`turn-process-${safeAttrId(message.id)}`)) return;
    const prevTrace = activeTurnTrace;
    const prevAnchor = activeTurnAnchorId;
    try {
        activeTurnTrace = saved;
        activeTurnAnchorId = String(message.id);
        const host = renderTurnProcess();
        // 过程区默认排在正文之后（历史回看时正文才是主角）。
        //   这里显式确保它紧跟在这条消息后面，而不是跑到列表末尾。
        const hostEl = document.getElementById(`turn-process-${safeAttrId(message.id)}`);
        if (hostEl && hostEl.previousSibling !== el) {
            if (el.nextSibling) el.parentNode.insertBefore(hostEl, el.nextSibling);
            else el.parentNode.appendChild(hostEl);
        }
    } catch (e) { /* 还原失败不该挡住消息渲染 */ }
    finally {
        activeTurnTrace = prevTrace;
        activeTurnAnchorId = prevAnchor;
    }
}

function removeThinkingMessage() {
    const el = document.getElementById('thinking-bubble');
    if (el) {
        el.style.transition = 'opacity 0.2s ease-out, transform 0.2s ease-out';
        el.style.opacity = '0';
        el.style.transform = 'translateY(-4px)';
        setTimeout(() => el.remove(), 200);
    }
    state.thinkingMessageId = null;
}

let activeVoicePlayerId = null;
let activeVoicePlaybackStatus = 'idle';
let voicePlaybackGeneration = 0;
let voicePlaybackStartGeneration = 0;
let activeVoiceSession = null;
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


