// Agent 文件夹授权与系统权限现状；依赖 agent-phone 的 deviceBridge 与设置页渲染函数（运行时才调用）。
'use strict';

// 文件夹授权是 Agent 工作区之外的第二个可写根：用户点「选择文件夹授权」→ 系统文件选择器 → 持久化 SAF 目录 URI 存进设置。
// 不做"整个存储随便读"：那要 MANAGE_EXTERNAL_STORAGE，应用商店拒审且给了收不回；SAF 粒度是一个文件夹，能精确控制、随时收回。
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
            await showCustomAlert(res.text || '已授权文件夹。', '文件夹授权');
        } else if (res && res.cancelled) {
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

// 系统权限是读取信息的第二道闸：应用层开关管"让不让 AI 知道"，这里管"应用能不能拿到"；危险权限必须用户在系统里同意，刻意不在启动时索取。
// 这块只做纯状态展示，申请/关闭一律去系统权限页；不要引用 #agentReadPermBtn / #agentNotifPermBtn / #agentReadPermStatus（HTML 里没这三个 id）。
const AGENT_PERM_BADGE_IDS = [
    'agentPermBadgeApps',
    'agentPermBadgeNotifications',
    'agentPermBadgeDevice',
    'agentPermBadgeSms',
    'agentPermBadgeContacts',
    'agentPermBadgeCalendar',
];

// 徽标可点，点一下就去申请：短信/通讯录/日历 → requestReadPermission；通知读取 → openNotificationSettings（只能跳系统页）。
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
    // is-actionable 必须一起写进 className：这行是整体覆盖，只 classList.add 下次刷新就被抹掉。
    el.className = 'agent-perm-badge'
        + (kind ? ' is-' + kind : '')
        + (AGENT_PERM_BADGE_ACTIONS[id] ? ' is-actionable' : '');
}

/** 六个徽标一起写成同一句话（用于"仅安卓版"/"读取失败"这种整体状态） */
function setAllAgentPermBadges(text, kind) {
    AGENT_PERM_BADGE_IDS.forEach((id) => setAgentPermBadge(id, text, kind));
}

// 已授权时不做特殊分支：requestReadPermission 对已授权立刻返回（不弹框）；通知那条本就是跳设置页，那页能开也能关。
async function handleAgentPermBadgeAction(id) {
    const cfg = AGENT_PERM_BADGE_ACTIONS[id];
    if (!cfg) return;
    const dev = deviceBridge();
    if (!dev) {
        await showCustomAlert('系统权限只能在安卓版 App 里设置。', '不可用');
        return;
    }
    if (cfg.settingsPage) {
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

// 绑定一次即可（徽标是静态元素）；HTML 上写了 role="button" + tabindex="0"，回车/空格也要能触发。
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

// 文案刻意区分「未授权」与「压根不需要权限」：后者写成"未授权"会让用户白找一圈设置（应用列表是安装期授权，设备状态无需权限）。
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
        setAllAgentPermBadges('仅安卓版');
        return;
    }
    try {
        const res = await dev.readPermissionStatus();
        renderAgentPermBadges((res && res.permissions) || {});
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


