/* ============================================================================
 * 记忆页（从长期记忆里读）
 *
 * 把 memory.js 维护的长期记忆按类目摊开：日记 / 关键时刻 / 约定 / 偏好 /
 * 在意的事 / 计划。进/出页面的状态切换与日记页同一套（见 diary.js）——
 * 记忆页也是"整页浏览"，不是弹窗，窄屏因此能直接复用同一套次级页外壳。
 *
 * 为什么按类目分区而不是按对话分组：日记页按对话分组是为了回答"这段故事说了
 * 什么"；记忆页要回答的是"她到底记住了什么"，类目（约定/偏好/计划…）才是
 * 用户能核对的信息单位。按对话分组会让同一条偏好被拆到多个对话下重复出现。
 * ========================================================================== */
'use strict';

// 顺序即展示顺序：从"发生了什么"到"约定了什么、在意什么、接下来做什么"。
const MEMORY_PAGE_SECTIONS = Object.freeze([
    { key: 'diary', label: '日记', icon: '📖', maxChars: 2000 },
    { key: 'pivotal_memory', label: '关键时刻', icon: '✨', maxChars: 360 },
    { key: 'promise', label: '约定', icon: '🤝', maxChars: 360 },
    { key: 'preference', label: '偏好', icon: '💡', maxChars: 360 },
    { key: 'motivation', label: '在意的事', icon: '🎯', maxChars: 360 },
    { key: 'plan', label: '计划', icon: '🗓️', maxChars: 360 }
]);

/**
 * 一条记忆摊成一行纯文本。
 *
 * plan 是对象（{date, content}），diary 是长文对象，其余类目是字符串数组 ——
 * 形状不同，取值方式也不同；统一在这里收口，渲染处只认字符串。
 * 用 cleanMemoryPromptText 而不是直接读字段：记忆文本可能带模型侧换行/空白，
 * 这里归一成单行，才不会把卡片撑成一片乱麻。
 */
function memoryPageItemText(section, item) {
    if (section.key === 'plan') {
        const date = cleanMemoryPromptText(item && item.date, 40);
        const content = cleanMemoryPromptText(item && item.content, section.maxChars);
        return content ? (date ? date + ' · ' + content : content) : '';
    }
    const raw = section.key === 'diary' ? (item && item.content) : item;
    return cleanMemoryPromptText(raw, section.maxChars);
}

function renderMemoryPage() {
    const core = state.memoryCore || {};
    const filterId = state.memoryFilterConvId || '';
    const sections = MEMORY_PAGE_SECTIONS.map(section => {
        const list = Array.isArray(core[section.key]) ? core[section.key] : [];
        const all = list
            .map(item => ({ item, text: memoryPageItemText(section, item) }))
            .filter(entry => entry.text);
        // 只有 diary 类目的条目带 conversationId；不带归属的全局条目在筛选时隐去。
        const items = filterId
            ? all.filter(entry => entry.item && typeof entry.item === 'object' && entry.item.conversationId === filterId)
            : all;
        return { section, all, items };
    });
    const total = sections.reduce((sum, group) => sum + group.items.length, 0);
    const allTotal = sections.reduce((sum, group) => sum + group.all.length, 0);

    elements.memoryCount.textContent = filterId ? `${total} / ${allTotal} 条记忆` : `${allTotal} 条记忆`;
    const emptyText = elements.memoryEmpty.querySelector('p');
    if (emptyText) {
        emptyText.textContent = filterId
            ? '这段对话还没有整理出的记忆。'
            : '还没有整理出的记忆，先和伊蕾娜聊一段旅途吧。';
    }
    elements.memoryEmpty.classList.toggle('hidden', total > 0);
    elements.memoryBody.innerHTML = '';

    for (const group of sections) {
        if (!group.items.length) continue;
        const block = document.createElement('section');
        block.className = 'memory-section';

        const head = document.createElement('div');
        head.className = 'memory-section-head';
        const icon = document.createElement('span');
        icon.className = 'memory-section-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = group.section.icon;
        const title = document.createElement('span');
        title.className = 'memory-section-title';
        title.textContent = group.section.label;
        const count = document.createElement('span');
        count.className = 'memory-section-count';
        count.textContent = String(group.items.length);
        head.append(icon, title, count);
        block.appendChild(head);

        const list = document.createElement('div');
        list.className = 'memory-list';
        for (const entry of group.items) {
            const row = document.createElement('div');
            row.className = 'memory-item';
            // 记忆文本来自模型输出，一律 textContent —— 插进 innerHTML 会有注入面。
            const text = document.createElement('div');
            text.className = 'memory-item-text';
            text.textContent = entry.text;
            row.appendChild(text);
            list.appendChild(row);
        }
        block.appendChild(list);
        elements.memoryBody.appendChild(block);
    }
    // 页面里的「选择对话」按钮要跟着筛选项改文案（窄屏由 mobile-shell.js 插入）
    if (typeof syncConvFilterLabels === 'function') syncConvFilterLabels();
}

function enterMemoryPage() {
    state.memoryPageMode = true;
    state.notesMode = false;
    state.diaryMode = false;
    // 筛选是**当次浏览**的临时状态，进/出页面都清掉（同日记页）。
    state.memoryFilterConvId = '';
    elements.initialState.classList.add('hidden');
    elements.conversationHistory.classList.add('hidden');
    elements.inputBar.classList.add('hidden');
    elements.notesPage.classList.add('hidden');
    elements.diaryPage.classList.add('hidden');
    elements.floatingMic.classList.add('hidden');
    elements.memoryPage.classList.remove('hidden');
    elements.currentConversationTitle.textContent = '记忆';
    renderMemoryPage();
    setRailActive('memory');
}

function exitMemoryPage() {
    state.memoryPageMode = false;
    state.memoryFilterConvId = '';
    elements.memoryPage.classList.add('hidden');
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
