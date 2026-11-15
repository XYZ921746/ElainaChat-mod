// Agent 文件夹授权与手机系统权限现状；依赖 agent-phone 的 deviceBridge 与设置页渲染函数（运行时才调用）。
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

// 手机权限只有系统层一道闸：应用内不给"让不让 AI 读"的开关。
// 有开关就必然要有"关掉"的路径，而系统权限一旦授予，应用内关掉只是对模型隐身、权限仍在 ——
// 用户以为收回去了，实际没有。所以应用内只做两件事：如实报告系统状态、把用户送到能授予/撤销的那一页。
const AGENT_PERM_DOTS = [
    'agentPermBadgeSms',
    'agentPermBadgeContacts',
    'agentPermBadgeCalendar',
    'agentPermBadgeNotifications',
    'agentPermBadgeBattery',
    'agentPermBadgeAutostart',
    'agentPermBadgeApps',
    'agentPermBadgeDevice',
];

// 汇总只数"能被用户授权"的几项：应用列表是安装期授权、设备状态无需权限，
// 把它们算进去会让分数永远不满，用户以为还有东西没开。
const AGENT_PERM_COUNTED = ['sms', 'contacts', 'calendar', 'notifications', 'battery'];

// 能直接弹系统框的权限 —— 只有这几项能进「一键授权」。通知要跳「通知使用权」、
// 自启动只能跳厂商页，都不是弹框能解决的，硬塞进一键授权只会让用户以为点完就都开了。
const AGENT_PERM_POPUP_KINDS = ['sms', 'contacts', 'calendar'];

/** 写一个状态圆点（kind: 'ok' | 'no' | 'unknown'）。明细里只画点、不写文字 ——
 *  「已授权 / 未授权」这类词在八行里重复八遍反而看不出哪项没开。 */
function setAgentPermDot(id, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'agent-perm-dot' + (kind ? ' is-' + kind : '');
    el.title = kind === 'ok' ? '已开启' : kind === 'no' ? '未开启' : '无法检测';
}

function setAllAgentPermDots(kind) {
    AGENT_PERM_DOTS.forEach((id) => setAgentPermDot(id, kind));
}

// 应用列表是安装期授权、设备状态无需权限，都算已开启 —— 写成"未开启"会让用户白找一圈设置。
function renderAgentPermDots(status) {
    const s = status || {};
    const p = s.permissions || {};
    const yesNo = (id, ok) => setAgentPermDot(id, ok ? 'ok' : 'no');
    setAgentPermDot('agentPermBadgeApps', p.apps === false ? 'no' : 'ok');
    setAgentPermDot('agentPermBadgeDevice', 'ok');
    yesNo('agentPermBadgeNotifications', Boolean(p.notifications));
    yesNo('agentPermBadgeSms', Boolean(p.sms));
    yesNo('agentPermBadgeContacts', Boolean(p.contacts));
    yesNo('agentPermBadgeCalendar', Boolean(p.calendar));
    // 电池优化的原生查询可能失败（老系统没有该 API）：那就不冒充"未授权"，如实标成查不到。
    if (s.batteryKnown === false) setAgentPermDot('agentPermBadgeBattery', 'unknown');
    else yesNo('agentPermBadgeBattery', Boolean(s.batteryUnrestricted));
    // 自启动没有公开 API，查不到也授不了权，只能跳页面让用户自己开 —— 状态永远是"无法检测"。
    setAgentPermDot('agentPermBadgeAutostart', 'unknown');

    // 卡片上的汇总与浮层标题用的是同一句话，写一次两处都更新。
    const granted = AGENT_PERM_COUNTED.filter((k) => (k === 'battery'
        ? s.batteryKnown === true && Boolean(s.batteryUnrestricted)
        : Boolean(p[k]))).length;
    const total = AGENT_PERM_COUNTED.length;
    const text = granted >= total ? '全部已授权' : granted + '/' + total + ' 已授权';
    for (const id of ['agentPermSummaryBadge', 'agentPermSheetSummary']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.textContent = text;
        el.className = 'agent-perm-badge ' + (granted >= total ? 'is-ok' : 'is-no');
    }
}

/** 一次读齐系统层现状：读取类权限 + 电池优化。原生层不在时返回 null。 */
async function readAgentPermStatus() {
    const dev = deviceBridge();
    if (!dev || typeof dev.readPermissionStatus !== 'function') return null;
    const out = { permissions: {}, batteryUnrestricted: false, batteryKnown: false };
    const res = await dev.readPermissionStatus();
    out.permissions = (res && res.permissions) || {};
    const files = Number(res && res.workspaceFiles);
    if (Number.isFinite(files)) {
        const summary = document.getElementById('agentFolderSummary');
        if (summary && !String(state.settings.agentFolderUri || '').trim()) {
            summary.textContent = '还没有授权额外文件夹。AI 只能在 Agent 工作区里读写文件'
                + (files > 0 ? '（工作区里现在有 ' + files + ' 个文件）。' : '。');
        }
    }
    if (typeof dev.powerStatus === 'function') {
        try {
            const power = await dev.powerStatus();
            if (power && typeof power.batteryUnrestricted === 'boolean') {
                out.batteryUnrestricted = power.batteryUnrestricted;
                out.batteryKnown = true;
            }
        } catch (e) { /* 原生层没提供 powerStatus：保持"无法检测" */ }
    }
    return out;
}

async function refreshAgentPermStatus() {
    const dev = deviceBridge();
    if (!dev || typeof dev.readPermissionStatus !== 'function') {
        setAllAgentPermDots('unknown');
        for (const id of ['agentPermSummaryBadge', 'agentPermSheetSummary']) {
            const el = document.getElementById(id);
            if (el) { el.textContent = '仅安卓版'; el.className = 'agent-perm-badge'; }
        }
        return;
    }
    try {
        renderAgentPermDots(await readAgentPermStatus());
    } catch (e) {
        setAllAgentPermDots('unknown');
    }
}

// 明细做成浮层而不是就地展开：八项权限摊在设置卡片里会把「手机操作」挤成一屏，
// 而日常只有"某项没给"时才需要看。浮层放在 #settingsOverlay 之外 ——
// 主面板的 animation（含 transform）会成为 fixed 后代的包含块，嵌在里面浮层会被关进主面板。
function openAgentPermSheet() {
    const sheet = document.getElementById('agentPermSheet');
    const btn = document.getElementById('agentPermDetailBtn');
    if (!sheet) return;
    openOverlayPanel(sheet);
    btn?.setAttribute('aria-expanded', 'true');
    void refreshAgentPermStatus();
}

function closeAgentPermSheet() {
    const sheet = document.getElementById('agentPermSheet');
    const btn = document.getElementById('agentPermDetailBtn');
    if (!sheet) return;
    closeOverlayPanel(sheet);
    btn?.setAttribute('aria-expanded', 'false');
}

document.getElementById('agentPermDetailBtn')?.addEventListener('click', () => openAgentPermSheet());
document.getElementById('agentPermSheetClose')?.addEventListener('click', () => closeAgentPermSheet());
// 点遮罩关掉：浮层是全屏容器，点到面板外才算"点外面"。
document.getElementById('agentPermSheet')?.addEventListener('click', (ev) => {
    if (ev.target && ev.target.id === 'agentPermSheet') closeAgentPermSheet();
});

// 申请/跳转一律按 data-perm-act 分发：卡片与浮层各有一组按钮（一键授权两处都有），
// 逐个绑监听会漏掉后来才出现的那个。
async function handleAgentPermAction(act) {
    const dev = deviceBridge();
    if (!dev) {
        await showCustomAlert('系统权限只能在安卓版 App 里设置。', '不可用');
        return;
    }
    try {
        if (act === 'sms' || act === 'contacts' || act === 'calendar') {
            if (typeof dev.requestReadPermission !== 'function') return;
            // 已授权时原生层直接返回、不弹框，所以不必先查状态再决定要不要申请。
            await dev.requestReadPermission({ kind: act });
        } else if (act === 'requestAll') {
            if (typeof dev.requestReadPermission !== 'function') return;
            // 只依次弹"能弹框的那几项"。通知与自启动弹不出来，混进来只会让用户以为点完就都开了。
            const status = await readAgentPermStatus();
            const p = (status && status.permissions) || {};
            for (const kind of AGENT_PERM_POPUP_KINDS) {
                if (p[kind]) continue;
                await dev.requestReadPermission({ kind });
            }
        } else if (act === 'notifications') {
            if (typeof dev.openNotificationSettings !== 'function') return;
            await dev.openNotificationSettings();
        } else if (act === 'battery') {
            if (typeof dev.requestBatteryExemption !== 'function') {
                await showCustomAlert('这个版本的 App 还不支持申请电池优化白名单，请到系统设置的「电池优化」里手动允许本应用。', '电池优化');
                return;
            }
            await dev.requestBatteryExemption();
        } else if (act === 'autostart') {
            if (typeof dev.openAutostartSettings !== 'function') {
                await showCustomAlert('这个版本的 App 还不能自动跳转自启动设置，请到手机管家的「自启动管理」里允许本应用。', '自启动');
                return;
            }
            const res = await dev.openAutostartSettings();
            if (res && res.ok === false && res.text) await showCustomAlert(res.text, '自启动');
        } else if (act === 'appSettings') {
            if (typeof dev.openAppSettings !== 'function') return;
            await dev.openAppSettings();
        }
    } catch (err) {
        console.warn('[Agent] 权限操作失败：' + act, err);
    }
    // 弹框 / 跳转返回后系统状态可能已变：立刻刷新一次，用户不用自己点「重新检测」。
    await refreshAgentPermStatus();
}

// 两处按钮共用同一个委托：卡片上的「一键授权」与浮层里的各行按钮。
for (const boxId of ['agentPhoneSection', 'agentPermSheet']) {
    document.getElementById(boxId)?.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('[data-perm-act]') : null;
        if (!btn) return;
        void handleAgentPermAction(btn.dataset.permAct);
    });
}

// 从系统设置页返回时状态往往已经变了，而 WebView 不会重新加载页面 —— 靠页面重新可见时补刷一次。
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const sheet = document.getElementById('agentPermSheet');
    if (!sheet || sheet.classList.contains('hidden')) return;
    void refreshAgentPermStatus();
});
