/* ============================================================================
 * 收藏 / 语笺（从 ui.js 拆分）
 *
 * 消息收藏、语笺数据与页面、侧栏高亮和主界面标题同步。
 * ========================================================================== */
'use strict';

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


