/* ============================================================================
 * 旅行日记（从 ui.js 拆分）
 *
 * 日记时间 / 分组 / 卡片 / 详情 / 筛选与进入退出日记页。
 * ========================================================================== */
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


