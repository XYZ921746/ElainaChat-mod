// Agent 设置 / 扩展分栏：手机读取信息开关、工作区授权摘要、扩展分栏切换与菜单定位。
'use strict';

// 手机「读取信息」隐私开关：默认全关，关掉后 AI 连标签都看不到（"根本没这个能力"而不是"读了不说"）；开关 id ↔ 设置字段 ↔ 手机操作名集中在这张表。
const AGENT_READ_TOGGLES = [
    { id: 'settingAgentReadApps', key: 'agentReadApps', action: '手机应用列表', label: '已安装应用列表' },
    { id: 'settingAgentReadNotifications', key: 'agentReadNotifications', action: '手机通知', label: '通知内容' },
    { id: 'settingAgentReadDevice', key: 'agentReadDevice', action: '手机设备信息', label: '设备与前台状态' },
    { id: 'settingAgentReadSms', key: 'agentReadSms', action: '手机短信', label: '短信' },
    { id: 'settingAgentReadContacts', key: 'agentReadContacts', action: '手机通讯录', label: '通讯录' },
    { id: 'settingAgentReadCalendar', key: 'agentReadCalendar', action: '手机日历', label: '日历' },
];

function fillAgentReadToggles() {
    for (const t of AGENT_READ_TOGGLES) {
        const el = document.getElementById(t.id);
        // 默认关（与 core.js 的 DEFAULTS 一致）：这些是隐私数据，不能因为用户没表态就当同意，只有存过的值为 true 才勾上。
        if (el) el.checked = state.settings[t.key] === true;
    }
}

// 从界面开关读回一份设置补丁。元素不在时保留原值：saveSettings 是整体替换，漏一个键等于把用户的开关重置回默认。
function readAgentReadToggles() {
    const patch = {};
    for (const t of AGENT_READ_TOGGLES) {
        const el = document.getElementById(t.id);
        patch[t.key] = el ? el.checked : (state.settings[t.key] !== false);
    }
    return patch;
}

// 某个读取类操作现在允许吗（供 agent.js 的分发与提示词用）。找不到对应开关的操作一律放行：那张表只列隐私数据。
function phoneReadAllowed(action) {
    const t = AGENT_READ_TOGGLES.find((x) => x.action === action);
    if (!t) return true;
    return state.settings[t.key] !== false;
}

// Agent 工作区 / 用户授权文件夹

function renderAgentFolderSummary() {
    const el = document.getElementById('agentFolderSummary');
    if (!el) return;
    const name = String(state.settings.agentFolderName || '').trim();
    const uri = String(state.settings.agentFolderUri || '').trim();
    if (uri) {
        el.textContent = '已授权文件夹：' + (name || '（未命名）')
            + ' —— AI 可以读写这个文件夹里的文件。';
        el.style.color = 'var(--rd-ok)';
    } else {
        el.textContent = '还没有授权额外文件夹。AI 只能在 Agent 工作区里读写文件。';
        el.style.color = 'var(--rd-accent)';
    }
}

// 扩展页的子分栏切换（插件 / 技能 / MCP）。不复用 switchSettingsTab：那个按 .settings-tab-panel 做事还会滚动主分栏导航，混用会把主分栏也切走。

// 保证「扩展」面板里恰好有一个子面板可见：若三个类都丢（或插件重写了 innerHTML），用户会看到整页空白而元素其实都在。
function ensureExtTab() {
    const panels = [...document.querySelectorAll('#tab-mods .ext-panel')];
    if (!panels.length) return;
    if (panels.some((p) => p.classList.contains('active-panel'))) return;
    const want = (typeof state !== 'undefined' && state._extTab) || 'ext-mod';
    const target = panels.find((p) => p.id === want) || panels[0];
    // 走 switchExtTab 而不是自己补类：它同时管导航选中态、state._extTab，还负责清掉多余的 .active-panel。
    switchExtTab(target.id, { noScroll: true });
}

// 切换扩展页的三个子分栏（宽屏导航子项与窄屏下拉共用同一组节点）。两处控件都会调它，必须同步状态，否则"导航显示插件、面板却是技能"。
function switchExtTab(name, opts = {}) {
    const target = String(name || 'ext-mod');

    document.querySelectorAll('.ext-nav-btn').forEach((b) => {
        const on = b.dataset.extTab === target;
        // 独立类名（.is-active）：.settings-tab-btn 的 active 会被主分栏切换清掉
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('#tab-mods .ext-panel').forEach((p) => {
        p.classList.toggle('active-panel', p.id === target);
    });

    // 记住用户停在哪一栏：下次从别的分栏点回「扩展」时回到这一栏，而不是每次跳回「插件」。
    if (typeof state !== 'undefined') state._extTab = target;

    // 切到 MCP 时顺手刷一次状态；状态接口不启动进程，刷它没有代价。
    if (target === 'ext-mcp') void refreshMcpList();

    // 展开态只由这里决定，不用 CSS :has()：:has() 判的 active 由别的监听器改，顺序不稳会出现"类已清掉但仍命中"、第一次点击没反应；opts.forceOpen 用于点父项进来。
    const groupEl = document.getElementById('settingsExtNav');
    const menuEl = document.querySelector('.ext-nav-children.ext-menu-floating');
    // 宽屏子项是导航内联展开、窄屏是浮层；两种形态都以分组上的 .is-open 为唯一真相，避免"点过一次就收不回"。
    const wasOpen = Boolean((groupEl && groupEl.classList.contains('is-open')) || (menuEl && menuEl.classList.contains('is-open')));
    const open = opts.forceClose === true ? false : (opts.forceOpen === true ? true : wasOpen);

    if (open && !wasOpen) {
        // 展开：先摆好位置再上类，否则第一帧会闪到错误位置
        positionExtMenu();
        if (groupEl) groupEl.classList.add('is-open');
        if (menuEl) {
            menuEl.classList.remove('is-closing');
            menuEl.classList.add('is-open');
        }
    } else if (!open && wasOpen) {
        // 收起：先播反向动画，播完再真正隐藏；直接摘 .is-open 会让菜单瞬间消失，动画看不到。
        if (groupEl) groupEl.classList.remove('is-open');
        if (menuEl) {
            menuEl.classList.remove('is-open');
            menuEl.classList.add('is-closing');
            clearTimeout(menuEl._extCloseTimer);
            menuEl._extCloseTimer = setTimeout(() => {
                menuEl.classList.remove('is-closing');
            }, 420);   // 400ms 动画 + 20ms 余量
        }
    }
    positionExtMenu();
}

// 摆放手机下拉分栏：子项竖排在「扩展」正下方、与父按钮同宽同高，坐标与尺寸全部取自父按钮本身；用 fixed 是因为绝对定位会被三层祖先的 overflow 裁掉。两个微调量分别是竖线相对按钮左边缘与底部的偏移。
const EXT_BRANCH_OFF_X = 0;
const EXT_BRANCH_OFF_Y = 6;

function positionExtMenu() {
    const group = document.getElementById('settingsExtNav');
    const parentBtn = group && group.querySelector('.settings-tab-btn');
    const panel = document.getElementById('settingsPanel');
    if (!group || !parentBtn || !panel) return;

    // 子项可能已被挂到 panel 下，也可能还在原位（挂载失败时的兜底）
    const menu = document.querySelector('.ext-nav-children.ext-menu-floating')
        || group.querySelector('.ext-nav-children');
    if (!menu) return;

    const pr = parentBtn.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    // 相对弹窗的坐标：absolute 的包含块是 panel（它有 position: relative）
    const left = Math.round(pr.left - panelRect.left) + EXT_BRANCH_OFF_X;
    const top = Math.round(pr.bottom - panelRect.top) + EXT_BRANCH_OFF_Y;

    for (const el of [group, menu]) {
        el.style.setProperty('--ext-menu-left', left + 'px');
        el.style.setProperty('--ext-menu-top', top + 'px');
        el.style.setProperty('--ext-menu-width', Math.round(pr.width) + 'px');
        el.style.setProperty('--ext-menu-item-h', Math.round(pr.height) + 'px');
    }
}


