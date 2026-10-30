/* ============================================================================
 * 用户资料（从 data.js 拆出）
 *
 * 用户名称 / 头像 / 伊蕾娜印象、资料面板、头像文件读取。
 * 依赖 Store、DOM 与 AI 请求（运行时才调用）。
 * ========================================================================== */
'use strict';

const USER_PROFILE_KEY = 'elaina_user_profile';

function loadUserProfile() {
    try {
        const raw = Store.getItem(USER_PROFILE_KEY);
        const o = raw ? JSON.parse(raw) : null;
        state.userProfile = {
            name: (o && typeof o.name === 'string') ? o.name.trim().slice(0, 12) : '',
            // 头像是本模块自己经 canvas 产出的 dataURL（见 pickProfileAvatar），
            //   不接收任意外部字符串
            avatar: (o && typeof o.avatar === 'string' && /^data:image\/[a-z]+;base64,/.test(o.avatar)) ? o.avatar : '',
            impression: (o && typeof o.impression === 'string') ? o.impression.trim().slice(0, 120) : ''
        };
    } catch (e) {
        state.userProfile = { name: '', avatar: '', impression: '' };
    }
    applyUserProfileToUi(false);
}

function saveUserProfile() {
    try {
        Store.setItem(USER_PROFILE_KEY, JSON.stringify(state.userProfile));
    } catch (e) { /* 存不下不影响本次会话 */ }
}

/** 用户称呼（带兜落）；消息行、语笺、提示词都用这一个出口 */
function getUserProfileName() {
    return String(state.userProfile && state.userProfile.name || '').trim();
}

/**
 * 进系统提示词的用户资料段。
 * 只包含称呼与 AI 自己写的印象 —— 刻意没有"用户自述"这个字段，见段首说明。
 */
function buildUserProfileSystemMessage() {
    const p = state.userProfile || {};
    const name = String(p.name || '').trim();
    const impression = String(p.impression || '').trim();
    if (!name && !impression) return '';
    const lines = ['# 用户资料'];
    if (name) lines.push(`用户的称呼：「${name}」。这是用户自己选的称呼，用它称呼对方即可。`);
    if (impression) {
        lines.push('# 你对用户的印象');
        lines.push('下面这段印象是**你自己**在过往对话后写下的，不是用户提供的信息。'
            + '回答时以它为背景自然体现即可：不要整段复述、不要主动提及"你写过印象"这件事。');
        lines.push(impression);
    }
    return lines.join('\n');
}

/**
 * 把资料落到界面上：左下角头像、用户消息行的头像/首字、（可选）重画当前对话。
 * name 变了消息行里的称呼才会变，所以改名后要 rerender。
 */
function applyUserProfileToUi(rerenderConversation) {
    const p = state.userProfile || {};
    const btn = elements.railProfileBtn;
    if (btn) {
        if (p.avatar) {
            btn.textContent = '';
            if (!btn.querySelector('img')) {
                const img = document.createElement('img');
                img.alt = '';
                img.draggable = false;
                btn.appendChild(img);
            }
            btn.querySelector('img').src = p.avatar;
        } else {
            btn.textContent = userProfileInitial();
        }
    }
    // 用户消息行的头像是伪元素：图片与首字都经 CSS 变量下发（伪元素读不到 dataset）
    const root = document.documentElement;
    root.style.setProperty('--rd-user-initial', '"' + userProfileInitial().replace(/["\\]/g, '') + '"');
    if (p.avatar) {
        root.style.setProperty('--rd-user-avatar', 'url("' + p.avatar + '")');
        root.classList.add('rd-has-user-avatar');
    } else {
        root.style.removeProperty('--rd-user-avatar');
        root.classList.remove('rd-has-user-avatar');
    }
    if (rerenderConversation && state.currentConversationId) {
        try { loadConversation(state.currentConversationId); } catch (e) { /* 重画失败不影响保存 */ }
    }
}

/** 头像上的首字：称呼的第一个字（只留字母/数字/文字，防引号之类进 CSS 变量） */
function userProfileInitial() {
    const name = getUserProfileName();
    const m = name.match(/[\p{L}\p{N}]/u);
    return (m && m[0]) || '旅';
}

/** 把选中的图片文件裁成 128×128 方形头像（dataURL）。canvas 产出，天然安全。 */
function profileFileToAvatar(file) {
    return new Promise((resolve, reject) => {
        if (!file || !/^image\//.test(file.type)) return reject(new Error('不是图片文件'));
        if (file.size > 8 * 1024 * 1024) return reject(new Error('图片太大（超过 8MB）'));
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('图片解码失败'));
            img.onload = () => {
                const size = 128;
                const canvas = document.createElement('canvas');
                canvas.width = size; canvas.height = size;
                const ctx = canvas.getContext('2d');
                // cover 裁切：短边撑满，长边居中
                const scale = Math.max(size / img.width, size / img.height);
                const w = img.width * scale, h = img.height * scale;
                ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.85));
            };
            img.src = String(reader.result);
        };
        reader.readAsDataURL(file);
    });
}

/** 请 AI 写印象：独立请求（不打扰记忆整理的 JSON 契约），存进 profile.impression */
async function requestUserImpression() {
    if (state.userImpressionRunning) return { ok: false, reason: 'busy' };
    const conv = getCurrentConversation();
    const dialogue = (conv && Array.isArray(conv.messages))
        ? conv.messages.filter(m => m && m.hidden !== true).slice(-40) : [];
    const memoryBlock = formatMemoryForPrompt(2);
    if (!dialogue.length && !memoryBlock) return { ok: false, reason: 'empty' };

    state.userImpressionRunning = true;
    setProfileImpressionUi(true);
    try {
        const userName = getUserProfileName() || '用户';
        const aiName = (state.characterCard && state.characterCard.name) || '伊蕾娜';
        const messages = [
            ...buildCharacterSystemMessages(state.characterCard),
            { role: 'system', content: `# 任务：写下你对「${userName}」的印象\n`
                + `以${aiName}的视角，根据下面的对话与你的记忆，给「${userName}」记一笔印象。\n`
                + '要求：\n'
                + '1. 不超过 60 字、一到两句；宁可短，不要稀释。\n'
                + '2. 信息密度第一：每个分句都是一条独立观察（性格 / 习惯 / 说话方式 / 在意什么 / 怎么和你相处），'
                + '可以用分号并排；不带信息的客套、铺垫全部删掉。\n'
                + '3. 只写观察得出的结论，不复述具体事件。\n'
                + '4. 「很有趣」「很特别」这类没有观察内容的空话，一个字都不要。\n'
                + '5. 只输出印象正文：无标题、无引号、无前后缀。' },
            ...(memoryBlock ? [{ role: 'system', content: '# 你的既有记忆\n' + memoryBlock }] : []),
            ...dialogue.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.text || '') })),
            { role: 'user', content: `（请现在写下你对「${userName}」的印象）` }
        ];
        const reply = await callChatAPI(messages);
        const text = String(reply || '').trim()
            .replace(/^["「『《]+/, '').replace(/["」』》]+$/, '')
            .slice(0, 120);
        if (!text) return { ok: false, reason: 'parse-fail' };
        state.userProfile.impression = text;
        saveUserProfile();
        refreshProfilePanel();
        return { ok: true };
    } catch (e) {
        console.warn('[资料] 生成印象失败:', e);
        return { ok: false, reason: 'error' };
    } finally {
        state.userImpressionRunning = false;
        setProfileImpressionUi(false);
    }
}

// ---- 资料面板 ----

let profileOverlay = null;

/**
 * 面板骨架在 JS 里建（同 achievements.js 的理由：低频界面不占首屏 HTML）。
 * 动态 id 用 `el.id = '...'` 赋值，check-dom-refs 才认得出（见 achievements.js 的说明）。
 */
function buildProfilePanel() {
    if (profileOverlay) return;
    profileOverlay = document.createElement('div');
    profileOverlay.id = 'profileOverlay';
    profileOverlay.className = 'fixed inset-0 z-50 hidden items-center justify-center p-4 modal-overlay';
    profileOverlay.innerHTML =
        '<div class="modal-panel w-full max-w-md max-h-[86vh] flex flex-col overflow-hidden">'
          + '<div class="flex items-center gap-3 px-5 py-4 border-b border-white/60 flex-shrink-0">'
            + '<div class="text-base font-bold text-indigo-950">我的资料</div>'
            + '<button id="profileCloseBtn" class="ml-auto p-1.5 rounded-lg hover:bg-white/60 transition-colors" type="button" aria-label="关闭">'
              + '<svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>'
            + '</button>'
          + '</div>'
          + '<div class="flex-1 overflow-y-auto scroll-soft px-5 py-4 space-y-5">'
            + '<div class="flex items-center gap-4">'
              + '<button id="profileAvatarBtn" class="profile-avatar-btn" type="button" title="更换头像" aria-label="更换头像"></button>'
              + '<div class="min-w-0">'
                + '<div class="text-sm font-bold text-indigo-950">头像</div>'
                + '<div class="text-xs text-indigo-400 mt-1">点击左侧圆形选择图片，裁成方形后立即生效。</div>'
              + '</div>'
            + '</div>'
            + '<div>'
              + '<label class="text-sm font-bold text-indigo-950 block mb-2" for="profileNameInput">称呼</label>'
              + '<input id="profileNameInput" type="text" maxlength="12" autocomplete="off" placeholder="旅人" class="modal-input w-full text-sm">'
              + '<div class="text-xs text-indigo-400 mt-1">伊蕾娜会用这个称呼叫你；留空则叫「旅人」。</div>'
            + '</div>'
            + '<div class="rounded-xl border border-white/60 p-4 profile-impression-box">'
              + '<div class="text-sm font-bold text-indigo-950">伊蕾娜对你的印象</div>'
              + '<div class="text-xs text-indigo-400 mt-1 leading-relaxed">这段印象由伊蕾娜在对话后自己写下，你不能编辑 —— 你的自我描述不会进入提示词，回答只反映真实相处。</div>'
              + '<div id="profileImpressionText" class="text-sm leading-relaxed mt-3 profile-impression-text"></div>'
              + '<div class="flex items-center gap-3 mt-3">'
                + '<button id="profileImpressionBtn" class="btn-secondary text-xs" type="button">让伊蕾娜更新印象</button>'
                + '<span id="profileImpressionStatus" class="text-xs text-indigo-400"></span>'
              + '</div>'
            + '</div>'
          + '</div>'
          + '<div class="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/60 flex-shrink-0">'
            + '<button id="profileSaveBtn" class="btn-primary text-xs" type="button">保存</button>'
          + '</div>'
        + '</div>';
    // 隐藏的文件选择框（点头像触发它；input 本身不占位）
    const fileInput = document.createElement('input');
    fileInput.id = 'profileAvatarInput';
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.className = 'hidden';
    fileInput.setAttribute('aria-hidden', 'true');
    profileOverlay.appendChild(fileInput);
    document.body.appendChild(profileOverlay);

    profileOverlay.querySelector('#profileCloseBtn').addEventListener('click', closeProfilePanel);
    profileOverlay.addEventListener('click', (e) => { if (e.target === profileOverlay) closeProfilePanel(); });
    profileOverlay.querySelector('#profileAvatarBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';   // 同一张图重选也要触发 change
        if (!file) return;
        try {
            state.userProfile.avatar = await profileFileToAvatar(file);
            saveUserProfile();
            applyUserProfileToUi(false);
            refreshProfilePanel();
        } catch (err) {
            try { showCustomAlert(String(err.message || err), '头像更换失败'); } catch (e) { /* 弹窗不可用则忽略 */ }
        }
    });
    profileOverlay.querySelector('#profileSaveBtn').addEventListener('click', () => {
        const input = profileOverlay.querySelector('#profileNameInput');
        const prev = getUserProfileName();
        state.userProfile.name = String(input.value || '').trim().slice(0, 12);
        saveUserProfile();
        applyUserProfileToUi(state.userProfile.name !== prev);
        closeProfilePanel();
    });
    profileOverlay.querySelector('#profileNameInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') profileOverlay.querySelector('#profileSaveBtn').click();
    });
    profileOverlay.querySelector('#profileImpressionBtn').addEventListener('click', async () => {
        const r = await requestUserImpression();
        const status = profileOverlay && profileOverlay.querySelector('#profileImpressionStatus');
        if (!status) return;
        if (r.ok) { status.textContent = '已更新'; window.setTimeout(() => { if (status) status.textContent = ''; }, 2500); return; }
        const reasons = {
            busy: '正在生成，稍候',
            empty: '还没有可参考的对话或记忆，先聊一段吧',
            'parse-fail': '这次没有生成出有效内容，再试一次',
            error: '生成失败（模型或网络问题），稍后再试'
        };
        status.textContent = reasons[r.reason] || '生成失败，稍后再试';
    });
}

function refreshProfilePanel() {
    if (!profileOverlay) return;
    const p = state.userProfile || {};
    profileOverlay.querySelector('#profileNameInput').value = p.name || '';
    const avatarBtn = profileOverlay.querySelector('#profileAvatarBtn');
    if (p.avatar) {
        avatarBtn.textContent = '';
        if (!avatarBtn.querySelector('img')) {
            const img = document.createElement('img');
            img.alt = '';
            avatarBtn.appendChild(img);
        }
        avatarBtn.querySelector('img').src = p.avatar;
        avatarBtn.classList.add('has-photo');
    } else {
        avatarBtn.textContent = userProfileInitial();
        avatarBtn.classList.remove('has-photo');
    }
    const box = profileOverlay.querySelector('#profileImpressionText');
    box.textContent = p.impression || '（还没有印象 —— 聊过几句之后，让伊蕾娜写下一笔。）';
    box.classList.toggle('is-empty', !p.impression);
}

function setProfileImpressionUi(running) {
    if (!profileOverlay) return;
    const btn = profileOverlay.querySelector('#profileImpressionBtn');
    const status = profileOverlay.querySelector('#profileImpressionStatus');
    if (btn) {
        btn.disabled = running;
        btn.classList.toggle('opacity-60', running);
    }
    if (status) status.textContent = running ? '伊蕾娜正在写…' : '';
}

function openProfilePanel() {
    buildProfilePanel();
    refreshProfilePanel();
    profileOverlay.classList.remove('hidden');
    profileOverlay.classList.add('flex');
}

function closeProfilePanel() {
    if (!profileOverlay) return;
    profileOverlay.classList.add('hidden');
    profileOverlay.classList.remove('flex');
}



