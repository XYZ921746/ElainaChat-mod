/* ============================================================================
 * 多人设角色卡（从 data.js 拆分）
 *
 * 角色卡列表 / 当前卡 / 增删改切换 / 表单同步。
 * 依赖数据层 normalizeCharacterCard（data.js）。
 * ========================================================================== */
'use strict';

// ===== 多人设 =====
// 数据结构：characterCards 是列表，每项就是一张角色卡外加一个 id；
// state.characterCard 始终等于「当前选中那张」的内容 —— 于是提示词拼装、
// 通知标题、开场白这些地方一行都不用改。
const CARDS_KEY = 'elaina_open_character_cards';
const CURRENT_CARD_KEY = 'elaina_open_current_card';

function newCardId() {
    return 'card_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function cardContent(card) {
    const src = card || DEFAULT_CHARACTER_CARD;
    return {
        name: src.name,
        title: src.title,
        worldSetting: src.worldSetting,
        characterPrompt: src.characterPrompt,
        greeting: src.greeting
    };
}

function currentCard() {
    return state.characterCards.find((c) => c.id === state.currentCardId)
        || state.characterCards[0] || null;
}

function normalizeCardList(list) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
        const card = normalizeCharacterCard(raw);
        let id = String((raw && raw.id) || '').trim();
        if (!id || seen.has(id)) id = newCardId();
        seen.add(id);
        out.push({ id, ...card });
    }
    return out;
}

/**
 * 已退役的内置人设 id。
 *
 * 内嵌角色卡的教训：应用曾把一张 DeepSeek 鲸鱼娘角色卡写死在代码里，每次启动
 * 都种回列表（id 固定为 builtin_deepseek_whale），用户删掉下次启动又回来。
 * 现在不再内嵌 —— 但**老版本客户端还在写这份列表**：它一加载就把这张卡推回
 * 服务端，于是服务端数据里又冒出它，新客户端再读回来照样看得到。
 *
 * 所以这里做一次**定向清理**：读到这个固定 id 就丢掉，并随列表一起写回服务端。
 * 只认这个固定 id，**不按内容匹配** —— 否则会误删用户自己新建的同类人设。
 */
const RETIRED_BUILTIN_CARD_IDS = ['builtin_deepseek_whale'];

function loadCharacterCards() {
    let list = null;
    try { list = JSON.parse(Store.getItem(CARDS_KEY) || 'null'); } catch (e) { list = null; }

    // 丢掉已退役的内置卡（见上面 RETIRED_BUILTIN_CARD_IDS 的说明）
    if (Array.isArray(list)) {
        list = list.filter((c) => !(c && RETIRED_BUILTIN_CARD_IDS.includes(c.id)));
    }

    if (!Array.isArray(list) || !list.length) {
        // 兼容老数据：更早的版本只有一张卡（elaina_open_character_card），
        // 这里把它变成列表里的第一项，已有设定不会丢。
        list = [{ id: newCardId(), ...(state.characterCard || DEFAULT_CHARACTER_CARD) }];
    }
    state.characterCards = normalizeCardList(list);

    let currentId = '';
    try { currentId = Store.getItem(CURRENT_CARD_KEY) || ''; } catch (e) { /* ignore */ }
    if (!state.characterCards.some((c) => c.id === currentId)) {
        currentId = state.characterCards[0].id;
    }
    state.currentCardId = currentId;
    state.characterCard = cardContent(currentCard());
    persistCharacterCards();
}

function persistCharacterCards() {
    try {
        Store.setItem(CARDS_KEY, JSON.stringify(state.characterCards));
        Store.setItem(CURRENT_CARD_KEY, state.currentCardId);
    } catch (e) { /* 写入失败等，忽略 */ }
}

// 把表单上正在编辑的内容写回「当前那套」。切换、保存前都要调，
// 否则用户改了没保存就切走，改动会静默丢掉。
function syncFormToCurrentCard() {
    const card = currentCard();
    if (!card) return;
    Object.assign(card, cardContent({
        name: document.getElementById('ccName').value.trim() || '未命名',
        title: document.getElementById('ccTitle').value.trim(),
        worldSetting: document.getElementById('ccWorldSetting').value.trim(),
        characterPrompt: document.getElementById('ccCharacterPrompt').value.trim(),
        greeting: document.getElementById('ccGreeting').value.trim()
    }));
}

function fillCharacterCardForm() {
    const card = state.characterCard || DEFAULT_CHARACTER_CARD;
    document.getElementById('ccName').value = card.name || '';
    document.getElementById('ccTitle').value = card.title || '';
    document.getElementById('ccWorldSetting').value = card.worldSetting || '';
    document.getElementById('ccCharacterPrompt').value = card.characterPrompt || '';
    document.getElementById('ccGreeting').value = card.greeting || '';
}

function renderCardSelect() {
    const sel = document.getElementById('ccPresetSelect');
    if (!sel) return;
    sel.innerHTML = '';
    state.characterCards.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = (c.name || '未命名') + (c.title ? '（' + c.title + '）' : '');
        sel.appendChild(opt);
    });
    sel.value = state.currentCardId;
    const hint = document.getElementById('ccPresetHint');
    if (hint) {
        hint.textContent = '共 ' + state.characterCards.length
            + ' 套。切换立即生效，正在编辑的内容会自动存回原人设。';
    }
}

function switchCard(id) {
    if (!id || id === state.currentCardId) return;
    syncFormToCurrentCard();          // 先保住当前编辑
    state.currentCardId = id;
    state.characterCard = cardContent(currentCard());
    persistCharacterCards();
    saveCharacterCard();
    fillCharacterCardForm();
    renderCardSelect();
    updateUI();                       // 顶栏角色名等跟着变
}

async function addCard(duplicate) {
    syncFormToCurrentCard();
    const base = duplicate ? cardContent(currentCard()) : null;
    const suggested = base ? ((base.name || '未命名') + ' 副本') : '新的人设';
    const name = await showCustomPrompt(duplicate ? '复制为（新的人设名）' : '新的人设名', suggested);
    if (name === null || name === undefined) return;
    const finalName = String(name).trim() || suggested;

    const card = base
        ? { id: newCardId(), ...base, name: finalName }
        : { id: newCardId(), ...cardContent(DEFAULT_CHARACTER_CARD), name: finalName, title: '', greeting: '' };
    state.characterCards.push(card);
    state.currentCardId = card.id;
    state.characterCard = cardContent(card);
    persistCharacterCards();
    saveCharacterCard();
    fillCharacterCardForm();
    renderCardSelect();
    updateUI();
}

async function renameCard() {
    const card = currentCard();
    if (!card) return;
    const name = await showCustomPrompt('人设改名', card.name || '未命名');
    if (name === null || name === undefined) return;
    const finalName = String(name).trim();
    if (!finalName) return;
    card.name = finalName;
    state.characterCard.name = finalName;
    persistCharacterCards();
    saveCharacterCard();
    fillCharacterCardForm();
    renderCardSelect();
    updateUI();
}

async function deleteCard() {
    const card = currentCard();
    if (!card) return;
    if (state.characterCards.length <= 1) {
        showCustomAlert('至少要保留一套人设。', '无法删除');
        return;
    }
    const ok = await showCustomConfirm('确定删除人设「' + (card.name || '未命名') + '」？\n\n'
        + '删掉之后没办法恢复。');
    if (!ok) return;
    state.characterCards = state.characterCards.filter((c) => c.id !== card.id);
    state.currentCardId = state.characterCards[0].id;
    state.characterCard = cardContent(currentCard());
    persistCharacterCards();
    saveCharacterCard();
    fillCharacterCardForm();
    renderCardSelect();
    updateUI();
}

function loadCharacterCard() {
    const saved = Store.getItem('elaina_open_character_card');
    if (saved) {
        try {
            state.characterCard = normalizeCharacterCard(JSON.parse(saved));
        } catch (e) {
            console.error(e);
        }
    }
    // 老键读进 state.characterCard 之后，再据此建/载入多人设列表
    loadCharacterCards();
}



