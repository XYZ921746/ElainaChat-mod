/* ============================================================================
 * Agent 文件夹授权与系统权限现状（从 agent.js 拆出）
 *
 * SAF 文件夹授权按钮、权限徽标刷新、系统权限状态展示。
 * 依赖 agent-phone 的 deviceBridge 与设置页渲染函数（运行时才调用）。
 * ========================================================================== */
'use strict';

// ===== 文件夹授权（Agent 工作区之外的第二个可写根）=====
// 用户在设置页点「选择文件夹授权」→ 原生打开系统文件选择器 →
// 拿到一个持久化的 SAF 目录 URI → 存进设置，AI 就能读写那个文件夹。
// 为什么不做成"整个手机存储随便读"：那需要 MANAGE_EXTERNAL_STORAGE
//   （所有文件访问权限），会被应用商店拒审，对用户也是"给了就收不回"。
//   SAF 的粒度是"一个文件夹"，用户能精确控制给哪个目录、随时收回。
document.getElementById('agentFolderPickBtn')?.addEventListener('click', async () => {
    const dev = deviceBridge();
    if (!dev || typeof dev.pickAgentFolder !== 'function') {
        await showCustomAlert('文件夹授权只在安卓版 App 里可用（网页版没有系统文件选择器）。', '不可用');
        return;
    }
    try {
        const res = await dev.pickAgentFolder();
        if (res && res.ok) {
            state.settings.agentFolderUri = String(res.folderUri || '');
            state.settings.agentFolderName = String(res.folderName || '');
            persistSettings();
            renderAgentFolderSummary();
            // 重新拼一次提示词：授权变了，AI 该知道自己现在能读写哪个文件夹
            await showCustomAlert(res.text || '已授权文件夹。', '文件夹授权');
        } else if (res && res.cancelled) {
            // 用户主动取消，不打扰
        } else {
            await showCustomAlert((res && res.text) || '选择文件夹失败。', '文件夹授权');
        }
    } catch (err) {
        await showCustomAlert('选择文件夹失败：' + ((err && err.message) || err), '文件夹授权');
    }
});

document.getElementById('agentFolderClearBtn')?.addEventListener('click', async () => {
    if (!String(state.settings.agentFolderUri || '').trim()) {
        await showCustomAlert('当前没有授权任何文件夹。', '文件夹授权');
        return;
    }
    const dev = deviceBridge();
    if (dev && typeof dev.clearAgentFolder === 'function') {
        try { await dev.clearAgentFolder(); } catch (e) { /* 本地记录照样清 */ }
    }
    state.settings.agentFolderUri = '';
    state.settings.agentFolderName = '';
    persistSettings();
    renderAgentFolderSummary();
    await showCustomAlert('已取消文件夹授权。AI 现在只能读写 Agent 工作区。', '文件夹授权');
});

// ===== 系统权限现状（读取信息那一块的第二道闸）=====
// 应用层开关（设置里的隐私开关）管"让不让 AI 知道"；
// 这里管"应用能不能拿到" —— 短信/通讯录/日历是 Android 危险权限，
// 必须由用户在系统里同意。**刻意不在启动时索取**：
// 用户还没用到那功能时弹一堆权限框只会让人一律拒绝。
// 这块只做**纯状态展示** ——
//   每行右侧的小徽标（#agentPermBadge*，见 index.html）显示该项权限在系统里的现状，
//   申请/关闭一律去系统的权限页。所以相关函数只负责刷新徽标（顺带刷工作区文件数），
//   不再配「申请 / 关闭」按钮与汇总文字。
//   ⚠️ 别在这里引用 #agentReadPermBtn / #agentNotifPermBtn / #agentReadPermStatus ——
//      HTML 里没有这三个 id，check-dom-refs 会报"HTML 里没有这个 id"。
const AGENT_PERM_BADGE_IDS = [
    'agentPermBadgeApps',
    'agentPermBadgeNotifications',
    'agentPermBadgeDevice',
    'agentPermBadgeSms',
    'agentPermBadgeContacts',
    'agentPermBadgeCalendar',
];

// **徽标可点** —— 点一下就去把这项权限申请下来。
//   为什么做成"点徽标"而不是再加一排按钮：这块要保持"只显示状态"的观感
//   （只显示权限授权状态），而徽标本身就是最自然的入口 ——
//   看到一个"未授权"，顺手点它就该去授权。
//   · 短信 / 通讯录 / 日历 → requestReadPermission（弹系统授权框）
//   · 通知读取 → openNotificationSettings（它不是运行时权限，只能跳系统的「通知使用权」页）
//   · 应用列表（安装期授权）/ 设备状态（不需要权限）没有可做的事，保持纯展示
const AGENT_PERM_BADGE_ACTIONS = {
    agentPermBadgeSms: { kind: 'sms' },
    agentPermBadgeContacts: { kind: 'contacts' },
    agentPermBadgeCalendar: { kind: 'calendar' },
    agentPermBadgeNotifications: { settingsPage: true },
};

/** 写一个徽标（kind: 'ok' | 'no' | 空） */
function setAgentPermBadge(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    // is-actionable 必须一起写进 className —— 这行是**整体覆盖**，
    // 只 classList.add 的话下一次刷新就会被抹掉。
    el.className = 'agent-perm-badge'
        + (kind ? ' is-' + kind : '')
        + (AGENT_PERM_BADGE_ACTIONS[id] ? ' is-actionable' : '');
}

/** 六个徽标一起写成同一句话（用于"仅安卓版"/"读取失败"这种整体状态） */
function setAllAgentPermBadges(text, kind) {
    AGENT_PERM_BADGE_IDS.forEach((id) => setAgentPermBadge(id, text, kind));
}

/**
 * 点徽标 = 去把这项权限申请下来。
 *
 * 已经授权时不做特殊分支：`requestReadPermission` 对已授权的权限会立刻返回（不弹框），
 * 而通知那一条本来就是"跳到设置页"——那个页面既能开也能关，
 * 正好对上说明里"不想让它读就去系统里关掉"。
 */
async function handleAgentPermBadgeAction(id) {
    const cfg = AGENT_PERM_BADGE_ACTIONS[id];
    if (!cfg) return;
    const dev = deviceBridge();
    if (!dev) {
        await showCustomAlert('系统权限只能在安卓版 App 里设置。', '不可用');
        return;
    }
    if (cfg.settingsPage) {
        // 通知读取：跳到系统的「通知使用权」页。
        // 成功时**不弹任何提示** —— 用户点一下就是要去那一页，页面自己会打开，
        //   再弹一个"已打开设置页"纯属多余（授权成功就该自然结束，别加提示）。
        //   只有"打不开"才必须弹：那种情况得告诉用户手动怎么走。
        if (typeof dev.openNotificationSettings !== 'function') return;
        try {
            await dev.openNotificationSettings();
        } catch (err) {
            await showCustomAlert('打不开通知设置页：' + ((err && err.message) || err), '通知读取');
        }
        return;
    }
    if (typeof dev.requestReadPermission !== 'function') return;
    try {
        await dev.requestReadPermission({ kind: cfg.kind });
    } catch (e) {
        console.warn('[Agent] 申请权限失败：' + cfg.kind, e);
    }
    await refreshAgentReadPermStatus();
}

// 绑定一次即可（徽标是 index.html 里的静态元素）。
// 键盘可达：HTML 上写了 role="button" + tabindex="0"，所以回车/空格也要能触发。
for (const badgeId of Object.keys(AGENT_PERM_BADGE_ACTIONS)) {
    const el = document.getElementById(badgeId);
    if (!el) continue;
    el.addEventListener('click', () => { void handleAgentPermBadgeAction(badgeId); });
    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void handleAgentPermBadgeAction(badgeId);
        }
    });
}

/**
 * 按原生返回的权限表刷新六个徽标。
 *
 * 文案刻意区分三种情况——「未授权」和「压根不需要权限」是两回事，
 * 后者写成"未授权"会让用户白找一圈设置：
 *   · 应用列表 → 安装期授权（QUERY_ALL_PACKAGES，装的时候就定了，关不掉）
 *   · 设备状态 → 无需权限（电量/网络/前台应用都不是权限）
 */
function renderAgentPermBadges(permissions) {
    const p = permissions || {};
    const yesNo = (id, ok) => setAgentPermBadge(id, ok ? '已授权' : '未授权', ok ? 'ok' : 'no');
    setAgentPermBadge('agentPermBadgeApps', p.apps === false ? '未授权' : '安装期授权', p.apps === false ? 'no' : 'ok');
    setAgentPermBadge('agentPermBadgeDevice', '无需权限');
    yesNo('agentPermBadgeNotifications', Boolean(p.notifications));
    yesNo('agentPermBadgeSms', Boolean(p.sms));
    yesNo('agentPermBadgeContacts', Boolean(p.contacts));
    yesNo('agentPermBadgeCalendar', Boolean(p.calendar));
}

async function refreshAgentReadPermStatus() {
    const dev = deviceBridge();
    if (!dev || typeof dev.readPermissionStatus !== 'function') {
        // 网页版没有原生层 —— 这套权限只存在于安卓版 App
        setAllAgentPermBadges('仅安卓版');
        return;
    }
    try {
        const res = await dev.readPermissionStatus();
        renderAgentPermBadges((res && res.permissions) || {});
        // 工作区文件数也顺带刷一下，用户能看到"AI 到底存了东西没有"
        const files = Number(res && res.workspaceFiles);
        if (Number.isFinite(files)) {
            const summary = document.getElementById('agentFolderSummary');
            if (summary && !String(state.settings.agentFolderUri || '').trim()) {
                summary.textContent = '还没有授权额外文件夹。AI 只能在 Agent 工作区里读写文件'
                    + (files > 0 ? '（工作区里现在有 ' + files + ' 个文件）。' : '。');
            }
        }
    } catch (e) {
        setAllAgentPermBadges('读取失败', 'no');
    }
}


