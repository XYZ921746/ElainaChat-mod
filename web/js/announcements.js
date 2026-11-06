// 公告系统：首次引导、内置/远程公告、列表、遮罩、已读与事件广播；依赖 Store、DOM 与 escapeHtml（运行时才调用）。
'use strict';

function hasAgreedAnnouncement() {
    try {
        return state.settings && state.settings.announcementAgreed === true;
    } catch (e) { return false; }
}

/** 记下"已同意"，并立刻落盘（否则刷新又会弹） */
function markAnnouncementAgreed() {
    try {
        if (!state.settings) return;
        state.settings.announcementAgreed = true;
        // persistSettings 会把非密钥字段写进 elaina_open_settings
        if (typeof persistSettings === 'function') persistSettings();
    } catch (e) { /* 存不下也不该挡住界面 */ }
}

async function loadAnnouncement() {
    state.announcement = {
        title: '欢迎使用独立开源版',
        content: '本版本不连接作者服务器，对话、语音等能力需要先在「设置」中配置对应服务商的 API 密钥（DeepSeek / 千问 / 阿里百炼 / 小米 MiMo / MiniMax 等）。',
        version: 'open-source-local'
    };
}

// 弹出公告（只在还没同意过时真的弹）。判断放在这里而不是调用方：调用点有两处（移动端首屏 / 常规启动），
// 散在两处早晚会漏一处。@returns {boolean} 是否真的弹了
function openAnnouncement() {
    if (hasAgreedAnnouncement()) return false;
    const announcement = state.announcement || { title: '欢迎使用独立开源版', content: '使用前请在设置中配置 API 密钥。' };
    elements.announcementTitle.textContent = announcement.title;
    // 公告正文按轻量 Markdown 渲染（强调、代码），不是裸 innerHTML：inline() 先转义 &<> 再拼已知标签，
    // 链接只放行 http/https/mailto，远端内容塞不进脚本。换行在这里转 <br>（guide-copy 没有 pre-wrap）。
    elements.announcementContent.innerHTML = (window.ElainaReadme && window.ElainaReadme.inline)
        ? window.ElainaReadme.inline(announcement.content || '').replace(/\n/g, '<br>')
        : String(announcement.content || '');
    elements.announcementConfirmBtn.textContent = '我知道了';
    openOverlayPanel(elements.announcementOverlay);
    return true;
}

// 关闭公告并把"已同意"落盘。必须收敛到这一个出口：关闭有三条路（点「我知道了」/ 点遮罩 / Esc），
// 只要有一条漏记，用户就会"点掉了但下次还弹"。
function closeAnnouncement() {
    const wasOpen = !elements.announcementOverlay.classList.contains('hidden');
    closeOverlayPanel(elements.announcementOverlay);
    markAnnouncementAgreed();
    // 广播"公告关掉了"：生日插件靠它把开场彩蛋推迟到公告之后，避免两个弹层打架；没装插件时无副作用。
    if (wasOpen) {
        try { window.ElainaMods?.emit?.('announcement-closed', {}); } catch (e) { /* 忽略 */ }
    }
}

// 公告源（远程公告）：用户可自己托管 announcements.json，启动后拉一次，弹出有效期内且没看过的一条。
// 多源兜底：自定义商店源 → GitHub Pages → jsDelivr 镜像，全失败静默跳过，绝不卡启动。
// 结构 [{ id, title, content, start?, end?, action? }] 或包一层 { items:[…] }；start/end 为 'YYYY-MM-DD'。
// 已读按每条 id 单独记（与首次欢迎公告的 announcementAgreed 是两回事）；正文用 ElainaReadme.inline 渲染。
const ANNOUNCE_READ_KEY = 'elaina_announce_read';
const ANNOUNCE_TIMEOUT_MS = 2500;
/** 内置默认商店索引地址（用于判断用户有没有改过商店源） */
const ANNOUNCE_DEFAULT_MARKET = 'https://xyz921746.github.io/web/store/index.json';
/** 内置公告源（按顺序兜底：Pages → jsDelivr 镜像） */
const ANNOUNCE_BUILTIN_SOURCES = [
    'https://xyz921746.github.io/web/store/announcements.json',
    'https://cdn.jsdelivr.net/gh/XYZ921746/web@main/store/announcements.json',
];

/** 本地日期串 'YYYY-MM-DD'（与同上格式的 start/end 直接比字符串即可判断区间） */
function announceDateKey(d) {
    const x = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

/** 把某个 json 地址换成本目录下的另一个文件名（…/store/index.json → …/store/announcements.json） */
function siblingJsonUrl(base, file) {
    const s = String(base || '').trim();
    if (!s) return '';
    if (/\/[^/]*\.json$/i.test(s)) return s.replace(/[^/]*\.json$/i, file);
    return s.replace(/\/+$/, '') + '/' + file;
}

/** 公告源候选地址（去重，按尝试顺序） */
function announceSourceUrls() {
    const out = [];
    const push = (u) => { const s = String(u || '').trim(); if (s && out.indexOf(s) < 0) out.push(s); };
    // ① 用户自定义过商店源 → 用它的同目录 announcements.json（自建源优先）
    try {
        const idx = (window.ElainaMarket && typeof ElainaMarket.indexUrl === 'function') ? String(ElainaMarket.indexUrl()) : '';
        if (idx && idx !== ANNOUNCE_DEFAULT_MARKET) push(siblingJsonUrl(idx, 'announcements.json'));
    } catch (e) { /* 忽略 */ }
    // ② 内置源：Pages → jsDelivr 镜像
    for (const s of ANNOUNCE_BUILTIN_SOURCES) push(s);
    return out;
}

/** 已读公告 id（数组） */
function readAnnounceIds() {
    try {
        const raw = Store.getItem(ANNOUNCE_READ_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
    } catch (e) { return []; }
}

/** 记下一条公告已读（只留最近 80 条，避免无限增长） */
function markAnnounceRead(id) {
    if (!id) return;
    try {
        const arr = readAnnounceIds();
        if (arr.indexOf(id) >= 0) return;
        arr.push(id);
        Store.setItem(ANNOUNCE_READ_KEY, JSON.stringify(arr.slice(-80)));
    } catch (e) { /* 忽略 */ }
}

/** 把远端 payload 规整成公告列表（未知字段忽略；缺 id/title/content 的整条丢弃） */
function normalizeAnnouncements(data) {
    const raw = (data && Array.isArray(data.items)) ? data.items : (Array.isArray(data) ? data : []);
    const out = [];
    for (const it of raw) {
        if (!it || typeof it !== 'object') continue;
        const id = typeof it.id === 'string' ? it.id.trim() : '';
        const title = typeof it.title === 'string' ? it.title : '';
        const content = typeof it.content === 'string' ? it.content : '';
        if (!id || !title || !content) continue;
        out.push({
            id,
            title,
            content,
            start: typeof it.start === 'string' ? it.start : '',
            end: typeof it.end === 'string' ? it.end : '',
            action: it.action === 'market' ? 'market' : '',
        });
    }
    return out;
}

/** 这条公告现在是否落在有效期内 */
function isAnnounceActive(a, today) {
    if (a.start && today < a.start) return false;
    if (a.end && today > a.end) return false;
    return true;
}

/** 拉单个地址（带超时） */
async function fetchAnnounceFrom(url) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ANNOUNCE_TIMEOUT_MS) : null;
    try {
        const res = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return normalizeAnnouncements(await res.json());
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** 拉公告源：多源逐个试，全失败抛最后一个异常（由调用方静默处理） */
async function fetchAnnouncements() {
    let lastErr = null;
    for (const url of announceSourceUrls()) {
        try { return await fetchAnnounceFrom(url); }
        catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('没有可用的公告源');
}

// 「星屑之日」生日插件是否已启用。读 Store 里的启用开关（elaina_plugin_birthday）而不是 ElainaMods.list()：
// 后者在 init 阶段可能还没装载完；启用时 10/17 由生日彩蛋接管，本地兜底不掺和，避免两个弹层叠在一起。
function birthdayModEnabled() {
    try { return Store.getItem('elaina_plugin_birthday') === '1'; } catch (e) { return false; }
}

/** 10/17 的本地兜底公告（断网也能弹）——只给还没装生日插件的人看 */
function localAnnouncement() {
    const d = new Date();
    if (d.getMonth() + 1 !== 10 || d.getDate() !== 17) return null;
    if (birthdayModEnabled()) return null;
    return {
        id: 'local-birthday-' + d.getFullYear(),
        title: '今天好像是特别的日子',
        content: '你可以去插件市场看看。',
        action: 'market',
    };
}

/** 公告弹窗里正在显示的公告（关闭时用它记已读）。顶栏胶囊不走这条，见 announceList */
let currentServerAnnounce = null;

// 弹出公告弹窗（纯文本）。默认入口是顶栏「公告」按钮（见 syncAnnounceBadge），不在启动时自动弹；
// 这个弹窗只留给两件事：真要强制打断的重大公告、以及手动预览（ElainaAnnounce.show）。
function openServerAnnouncement(a) {
    if (!a || !elements.serverAnnounceOverlay) return false;
    currentServerAnnounce = a;
    elements.serverAnnounceTitle.textContent = a.title;
    elements.serverAnnounceContent.textContent = a.content;
    if (elements.serverAnnounceAction) elements.serverAnnounceAction.hidden = (a.action !== 'market');
    openOverlayPanel(elements.serverAnnounceOverlay);
    // 广播"公告出现"：与首次欢迎公告同一套事件，好让关心弹层的插件把自家弹层推迟到它关掉之后。
    try { window.ElainaMods?.emit?.('announcement-pending', {}); } catch (e) { /* 忽略 */ }
    return true;
}

/** 关闭公告弹窗并记已读（点按钮 / 点遮罩 都收敛到这里） */
function closeServerAnnouncement() {
    const ov = elements.serverAnnounceOverlay;
    const wasOpen = Boolean(ov) && !ov.classList.contains('hidden');
    closeOverlayPanel(ov);
    if (currentServerAnnounce) markAnnounceRead(currentServerAnnounce.id);
    currentServerAnnounce = null;
    if (wasOpen) {
        try { window.ElainaMods?.emit?.('announcement-closed', {}); } catch (e) { /* 忽略 */ }
    }
}

// 公告列表（顶栏「公告」按钮 + 下拉面板）：有未读时带红点 + 高亮，点开即已读。
// 不并进顶栏金句胶囊：胶囊在 ≤980px 被刻意隐藏，并进去等于手机端没有入口。

/** 拉到的公告（含 10/17 本地兜底，见 loadAnnouncements） */
let announceList = [];
// 是否已经拉过一次：没拉完时面板显示"正在读取…"，而不是误报"还没有公告"。
let announceLoaded = false;

/** 今天有效、且还没读过的公告 */
function announceUnread() {
    const read = new Set(readAnnounceIds());
    const today = announceDateKey();
    return announceList.filter((a) => isAnnounceActive(a, today) && !read.has(a.id));
}

// 刷新顶栏「公告」按钮：有未读 → 红点 + 高亮，无未读 → 收起。公告走独立按钮而不并进金句胶囊 ——
// 胶囊在 ≤980px 被刻意隐藏（为手机顶栏省地方），并进去等于手机端没入口；样式沿用「整理记忆」那套。
function syncAnnounceBadge() {
    const unread = announceUnread();
    const has = unread.length > 0;
    elements.announceStatusDot?.classList.toggle('hidden', !has);
    if (elements.announceBtn) {
        elements.announceBtn.title = has ? ('公告（' + unread.length + ' 条未读）') : '公告';
        // 借用「整理记忆」的高亮态（.header-memory-btn.is-running 是橙色），让"有未读"在按钮本身也能看出来。
        elements.announceBtn.classList.toggle('is-running', has);
    }
    // 面板开着时同步刷新（例如拉取刚回来）
    if (elements.announcePanel && !elements.announcePanel.classList.contains('hidden')) {
        renderAnnounceList(new Set(unread.map((a) => a.id)));
    }
}

/** 拉一次公告并刷新按钮状态：失败不报错、不阻塞（多源兜底见 fetchAnnouncements） */
async function loadAnnouncements() {
    let list = [];
    try { list = await fetchAnnouncements(); } catch (e) { list = []; }
    const today = announceDateKey();
    // 10/17 本地兜底只在"今天一条远端公告都没有"时补进来，否则同一天会看到两条内容几乎一样的东西。
    if (!list.some((a) => isAnnounceActive(a, today))) {
        const local = localAnnouncement();
        if (local) list = list.concat([local]);
    }
    announceList = list;
    announceLoaded = true;
    syncAnnounceBadge();
}

// 公告的时间标注：单日显示日期、跨日显示区间。还没到开始时间不能标"已结束" ——
// 只有"不在有效期内 → 已结束"一条判断时，10/17 的公告在 10/15 会被标成已结束。
function announceWindowText(a, today) {
    if (a.start && today < a.start) return '未开始';
    if (!isAnnounceActive(a, today)) return '已结束';
    if (a.start && a.end && a.start === a.end) return a.start;
    return [a.start, a.end].filter(Boolean).join(' ~ ');
}

/** 面板里的一条（标题 / 正文一律 textContent —— 远端文本绝不进 innerHTML） */
function announceItemEl(a, today, unreadIds) {
    const item = document.createElement('div');
    item.className = 'announce-item';

    const top = document.createElement('div');
    top.className = 'announce-item-top';
    if (unreadIds && unreadIds.has(a.id)) {
        const dot = document.createElement('span');
        dot.className = 'announce-item-dot';
        top.appendChild(dot);
    }
    const title = document.createElement('span');
    title.className = 'announce-item-title';
    title.textContent = a.title;
    top.appendChild(title);
    const meta = document.createElement('span');
    meta.className = 'announce-item-meta';
    meta.textContent = announceWindowText(a, today);
    top.appendChild(meta);
    item.appendChild(top);

    const body = document.createElement('div');
    body.className = 'announce-item-body';
    body.textContent = a.content;
    item.appendChild(body);

    if (a.action === 'market') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'announce-item-act';
        btn.textContent = '去插件市场看看';
        btn.addEventListener('click', () => {
            closeAnnouncePanel();
            try { window.ElainaMarket?.open?.(); } catch (e) { /* 忽略 */ }
        });
        item.appendChild(btn);
    }
    return item;
}

// 渲染面板列表：有效的排前面，再按日期倒序；unreadIds 是"打开那一刻还没读"的快照。
// 没到开始时间的整条不列：公告的语义是"到点才公布"，提前露出既剧透又会被错标成"已结束"。
// 先按 start 过滤，只留已经开始过的（进行中 + 已结束）；不写 start 的视为长期有效。
function renderAnnounceList(unreadIds) {
    const box = elements.announceList;
    if (!box) return;
    box.textContent = '';
    if (!announceLoaded) { box.appendChild(announceNoteEl('正在读取公告…')); return; }
    const today = announceDateKey();
    const visible = announceList.filter((a) => !a.start || today >= a.start);
    if (!visible.length) { box.appendChild(announceNoteEl('暂时还没有公告。')); return; }
    const sorted = visible.slice().sort((a, b) => {
        const rank = (x) => (isAnnounceActive(x, today) ? 0 : 1);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return String(b.start || '').localeCompare(String(a.start || ''));
    });
    for (const a of sorted) box.appendChild(announceItemEl(a, today, unreadIds));
}

function announceNoteEl(text) {
    const el = document.createElement('div');
    el.className = 'announce-empty';
    el.textContent = text;
    return el;
}

/** 打开面板：先按"打开那一刻"的未读快照渲染（好让用户看出哪条是新的），随后即记已读 */
function openAnnouncePanel() {
    const panel = elements.announcePanel;
    if (!panel) return;
    const unreadIds = new Set(announceUnread().map((a) => a.id));
    renderAnnounceList(unreadIds);
    for (const id of unreadIds) markAnnounceRead(id);
    syncAnnounceBadge();      // 已读 → 收起按钮上的红点
    panel.classList.remove('hidden');
}

function closeAnnouncePanel() {
    elements.announcePanel?.classList.add('hidden');
}

function toggleAnnouncePanel() {
    const panel = elements.announcePanel;
    if (!panel) return;
    if (panel.classList.contains('hidden')) openAnnouncePanel();
    else closeAnnouncePanel();
}

/** 启动时接入公告：拉一次、刷新胶囊（**不再自动弹窗**，见 openServerAnnouncement 的说明） */
function startAnnouncements() {
    void loadAnnouncements();
}

window.ElainaAnnounce = {
    sources: announceSourceUrls,
    list: () => announceList.slice(),
    unread: () => announceUnread().map((a) => a.id),
    pick: () => announceUnread()[0] || null,
    reload: loadAnnouncements,
    openPanel: openAnnouncePanel,
    closePanel: closeAnnouncePanel,
    show: openServerAnnouncement,
    readIds: readAnnounceIds,
    reset() { try { Store.setItem(ANNOUNCE_READ_KEY, '[]'); } catch (e) { /* 忽略 */ } },
};



