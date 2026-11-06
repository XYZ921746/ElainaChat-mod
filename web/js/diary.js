// 旅行日记：日记时间 / 分组 / 卡片 / 详情 / 筛选与进入退出日记页。
'use strict';

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

// 日记页按对话分组渲染：不分组会平铺成一锅粥，数据侧按"日期"合并还会让同一天的两段对话互相覆盖；组内按时间倒序，没有 conversationId 的归「未归属」，对话已删除的标成「已删除的对话」。
function renderDiaryPage() {
    const diary = Array.isArray(state.memoryCore?.diary) ? [...state.memoryCore.diary] : [];
    diary.sort((a, b) => diaryTimestamp(b) - diaryTimestamp(a));

    // 支持"点侧栏对话 → 只看这段对话的日记"；筛选放在数据层而非 CSS 隐藏：被筛掉的组不生成 DOM，长日记时省掉大量节点。
    const filterId = state.diaryFilterConvId || '';
    const shown = filterId ? diary.filter((e) => (e.conversationId || '') === filterId) : diary;

    elements.diaryCount.textContent = filterId
        ? `${shown.length} / ${diary.length} 条记录`
        : `${diary.length} 条记录`;
    const emptyText = elements.diaryEmpty.querySelector('p');
    if (emptyText) {
        emptyText.textContent = filterId
            ? '这段对话还没有整理出的日记。'
            : '还没有整理出的日记，先和伊蕾娜聊一段旅途吧。';
    }
    elements.diaryEmpty.classList.toggle('hidden', shown.length > 0);
    elements.diaryGrid.innerHTML = '';

    // 顶部不放筛选条：筛选职责已交给左边的对话记录（点那段对话 = 只看它的日记，再点一次取消）。

    for (const g of groupDiaryEntries(shown)) {
        elements.diaryGrid.appendChild(createDiaryGroupHead(g, filterId));
        for (const entry of g.entries) {
            elements.diaryGrid.appendChild(createDiaryCard(entry, g.title));
        }
    }
    if (typeof syncConvFilterLabels === 'function') syncConvFilterLabels();
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
    return [...groups.values()];
}

function createDiaryGroupHead(g, filterId) {
    const head = document.createElement('div');
    head.className = 'diary-group-head';
    if (filterId && g.id === filterId) head.classList.add('is-focused');
    if (g.id) head.dataset.diaryGroupId = g.id;
    const jumpable = Boolean(g.conv);
    if (jumpable) head.classList.add('is-jumpable');
    // 组头点了是"在本页内只看这段对话"；想真的进对话用组头右侧的「进入对话」按钮。
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
    card.innerHTML = `
        <div class="diary-card-date">${escapeHtml(diaryDisplayDate(entry))}</div>
        <div class="diary-card-text">${escapeHtml(entry.content || '')}</div>
        ${essences.length ? `<div class="diary-essences">${essences.map(tag => `<span class="diary-essence">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
    `;
    // 点卡片弹窗看全文：卡片正文被 -webkit-line-clamp: 4 截成 4 行、没有就地展开入口，长日记永远读不全；弹窗既不破坏网格布局，也不会被误当成"跳到原对话"。
    card.tabIndex = 0;
    card.title = '查看完整内容';
    const openDetail = () => openDiaryDetail(entry, groupTitle);
    card.addEventListener('click', openDetail);
    card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(); }
    });
    return card;
}

// "只看某段对话"：点侧栏的对话不跳去聊天，而是把日记筛到那一段；再点同一段、或点提示条上的「显示全部」取消筛选。
function focusDiaryGroup(convId) {
    if (!convId) return;
    state.diaryFilterConvId = (state.diaryFilterConvId === convId) ? '' : convId;
    renderDiaryPage();
    // 必须同时重绘侧栏：条目高亮是在 createConversationItem 里按"当前看的是哪一段"算出来的，不重绘的话点了对话侧栏仍然没有选中特效。
    if (typeof renderFolderList === 'function') renderFolderList();
    requestAnimationFrame(() => {
        const head = elements.diaryGrid.querySelector('[data-diary-group-id]');
        if (head && head.scrollIntoView) {
            try { head.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { /* 老浏览器 */ }
        }
    });
}

// 日记详情弹窗：正文可以很长（最多 4000 字），就地展开会把网格铺得七零八落；样式复用宿主的 .modal-overlay / .modal-panel，自己写一套会与主题 / 深色模式对不上。
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
    // 正文用 textContent（下面逐个 append），不用 innerHTML：日记正文来自模型输出，可能含 < > 之类字符。
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
    // 语笺 / 日记 / 记忆是三个互斥的整页：只改状态不藏页面，上一个页面会留在下面（从记忆切日记时两页会一起出现），所以状态与 class 要一起收。
    state.memoryPageMode = false;
    // 每次进入都从"显示全部"开始：筛选是当次浏览的临时状态，不该跨次留存（否则下次打开日记会以为只剩那一段）。
    state.diaryFilterConvId = '';
    elements.initialState.classList.add('hidden');
    elements.conversationHistory.classList.add('hidden');
    elements.inputBar.classList.add('hidden');
    elements.notesPage.classList.add('hidden');
    elements.memoryPage.classList.add('hidden');
    elements.floatingMic.classList.add('hidden');
    elements.diaryPage.classList.remove('hidden');
    elements.currentConversationTitle.textContent = '旅行日记';
    renderDiaryPage();
    setRailActive('diary');
}

function exitDiaryMode() {
    state.diaryMode = false;
    // 离开日记页时清掉筛选与详情弹窗，不然下次进来会莫名只显示一部分，或详情弹窗还挂在别的页面上面。
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
    // 重绘侧栏：离开日记页后高亮要从"筛选那段"切回"当前对话那段"（两个状态来源不同，见 createConversationItem 里的说明）。
    if (typeof renderFolderList === 'function') renderFolderList();
    syncRailActive();
}


