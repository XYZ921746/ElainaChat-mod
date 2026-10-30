/* ============================================================================
 * Agent 设置 / 扩展分栏（从 settings.js 拆分）
 *
 * 手机读取信息开关、工作区授权摘要、扩展分栏切换与菜单定位。
 * ========================================================================== */
'use strict';

// ===== 手机「读取信息」隐私开关 =====
// 六个开关各对应一类隐私数据，默认全开；关掉后 AI **连标签都看不到**（见 phoneReadAllowed）——
//   这是「根本没这个能力」，而不是「读了不说」，后者对用户毫无保障。
// 开关 id ↔ 设置字段 ↔ 手机操作名 的对应关系集中在下面这张表，避免在四处各写一遍字符串而漏掉一处。
const AGENT_READ_TOGGLES = [
    { id: 'settingAgentReadApps', key: 'agentReadApps', action: '手机应用列表', label: '已安装应用列表' },
    { id: 'settingAgentReadNotifications', key: 'agentReadNotifications', action: '手机通知', label: '通知内容' },
    { id: 'settingAgentReadDevice', key: 'agentReadDevice', action: '手机设备信息', label: '设备与前台状态' },
    { id: 'settingAgentReadSms', key: 'agentReadSms', action: '手机短信', label: '短信' },
    { id: 'settingAgentReadContacts', key: 'agentReadContacts', action: '手机通讯录', label: '通讯录' },
    { id: 'settingAgentReadCalendar', key: 'agentReadCalendar', action: '手机日历', label: '日历' },
];

/** 把设置里的值刷到界面开关上 */
function fillAgentReadToggles() {
    for (const t of AGENT_READ_TOGGLES) {
        const el = document.getElementById(t.id);
        // 默认**关**（与 core.js 的 DEFAULTS 保持一致）。
        //   已存过的值照旧尊重用户选择，只有"从没设过"的才落到关 ——
        //   这些是隐私数据，不能因为用户没表态就当同意。
        if (el) el.checked = state.settings[t.key] === true;
    }
}

/**
 * 从界面开关读回一份设置补丁。
 *
 * 元素不在时**保留原值**（而不是写 undefined / 漏掉键）：
 *   设置页在电脑上会把整块「手机操作」隐藏（syncAgentSectionsByDevice），
 *   将来若有人把这块 DOM 挪走或按需渲染，漏掉的键会让 state.settings
 *   丢掉那个字段 —— 而 saveSettings 是**整体替换** state.settings 的，
 *   丢一个键就等于把用户的开关重置回默认。所以这里显式兜底。
 */
function readAgentReadToggles() {
    const patch = {};
    for (const t of AGENT_READ_TOGGLES) {
        const el = document.getElementById(t.id);
        patch[t.key] = el ? el.checked : (state.settings[t.key] !== false);
    }
    return patch;
}

/**
 * 某个读取类操作现在允许吗（供 agent.js 的分发与提示词用）。
 *
 * 找不到对应开关的操作（例如手机状态）一律放行 —— 那张表只列**隐私数据**，
 * 界面/状态这类不涉及隐私的读取不该被这些开关误伤。
 */
function phoneReadAllowed(action) {
    const t = AGENT_READ_TOGGLES.find((x) => x.action === action);
    if (!t) return true;
    return state.settings[t.key] !== false;
}

// ===== Agent 工作区 / 用户授权文件夹=====

/** 把当前授权文件夹的状态刷到设置页文字上 */
function renderAgentFolderSummary() {
    const el = document.getElementById('agentFolderSummary');
    if (!el) return;
    const name = String(state.settings.agentFolderName || '').trim();
    const uri = String(state.settings.agentFolderUri || '').trim();
    if (uri) {
        el.textContent = '已授权文件夹：' + (name || '（未命名）')
            + ' —— AI 可以读写这个文件夹里的文件。';
        el.style.color = '#059669';
    } else {
        el.textContent = '还没有授权额外文件夹。AI 只能在 Agent 工作区里读写文件。';
        el.style.color = '#818cf8';
    }
}

/**
 * 扩展页的子分栏切换（插件 / 技能 / MCP）。
 *
 * 为什么不复用 switchSettingsTab：那个函数切换的是**主分栏**（外观/角色/模型…），
 *   它按 .settings-tab-panel 的 id 做事，还会去滚动左侧导航。子分栏是这一页内部的
 *   三个面板，用另一套选择器（.ext-panel / data-ext-tab），互不干扰 ——
 *   混用会让"点插件子栏"顺带把主分栏切走。
 */
/**
 * 保证「扩展」面板里**恰好有一个**子面板可见。
 *
 * 为什么需要：子面板的显隐靠 .active-panel，而 HTML 里只有一个（ext-mod）带这个类。
 *   如果某条路径把三个类都弄丢了（或插件/主题脚本重写了 innerHTML），
 *   用户会看到"扩展页整页空白"——而所有元素其实都在，只是都 display:none。
 *   这条兜底每次进入扩展页时跑一次，代价只有三次 classList 查询。
 */
function ensureExtTab() {
    const panels = [...document.querySelectorAll('#tab-mods .ext-panel')];
    if (!panels.length) return;
    if (panels.some((p) => p.classList.contains('active-panel'))) return;
    const want = (typeof state !== 'undefined' && state._extTab) || 'ext-mod';
    const target = panels.find((p) => p.id === want) || panels[0];
    // 走 switchExtTab 而不是自己补类：它同时管导航按钮的选中态、state._extTab，
    //   还负责把多余的 .active-panel 清掉（面板「恰好一个可见」是它的不变量）。
    switchExtTab(target.id, { noScroll: true });
}

/**
 * 切换扩展页的三个子面板（插件 / 技能 / MCP）。
 *
 * 两处控件会调用它，必须**同步状态**，否则会出现"导航显示插件、面板却是技能"：
 *   · 宽屏：导航栏里 #settingsExtNav 的子项（缩进在「扩展」下面）
 *   · 窄屏：导航栏「扩展」弹出的下拉（.ext-nav-btn，同一组节点）
 *   · 程序化：点父项「扩展」时恢复上次那一栏
 */
function switchExtTab(name, opts = {}) {
    const target = String(name || 'ext-mod');

    // ① 导航栏子项（宽屏可见）
    document.querySelectorAll('.ext-nav-btn').forEach((b) => {
        const on = b.dataset.extTab === target;
        // 独立类名（.is-active）：.settings-tab-btn 的 active 会被主分栏切换清掉
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // ③ 面板
    document.querySelectorAll('#tab-mods .ext-panel').forEach((p) => {
        p.classList.toggle('active-panel', p.id === target);
    });

    // 记住用户停在哪一栏：下次从别的分栏点回「扩展」时回到这一栏，
    //   而不是每次都跳回「插件」（那不是"记住我的位置"，是每次重置）。
    if (typeof state !== 'undefined') state._extTab = target;

    // 切到 MCP 时顺手刷一次状态：用户点进来多半就是想看"连上了吗"。
    //   状态接口**不启动进程**，所以刷它没有代价。
    if (target === 'ext-mcp') void refreshMcpList();

    // 展开态：**只由这里**决定，不依赖 CSS 的 :has()。
    //   为什么要独占：:has() 判的是"父项有没有 active"，而 active 由事件委托在
    //   另一个监听器里改，两者顺序不稳定 —— 实测会出现"类已清掉但 :has() 仍命中"，
    //   于是第一次点击看起来没反应、第二次才展开。
    //   opts.forceOpen 用于"点父项进来"这条路径：此时 active 还没设上，
    //   但意图明确是展开。
    const groupEl = document.getElementById('settingsExtNav');
    const menuEl = document.querySelector('.ext-nav-children.ext-menu-floating');
    // 当前是否已展开：以菜单自身的 .is-open 为准（它是唯一真相来源）。
    const wasOpen = Boolean(menuEl && menuEl.classList.contains('is-open'));
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
        // 收起：先播反向动画，播完再真正隐藏。
        //   直接摘 .is-open 会让菜单瞬间消失，动画根本看不到。
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

/**
 * 让导航栏里的「扩展」分组完整落在可视区。
 *
 * 只在宽屏竖排导航里有意义（窄屏子项收起、分组就是一个小按钮，本来就在视野里）。
 * 为什么不用 scrollIntoView：它按"最近边"滚动，父项在左侧之外时会把父项贴到
 *   左边缘 —— 看起来像被裁掉的字。这里显式给两边的余量。
 */
/**
 * 摆放手机下拉分栏的位置（宽屏不用它：那里子项直接缩进在导航里）。
 *
 * 用户要的效果：**下拉与下面的插件卡片平齐** —— 左边缘贴内容区左边，
 *   宽度也跟内容区一样。所以坐标取自 #settingsContent，而不是窄窄的图标按钮。
 *
 * 用 fixed：绝对定位会被三层祖先的 overflow 裁掉
 *   （#settingsTabNav 的 overflow-x:auto、#settingsPanel 的 overflow:hidden、
 *    .rd-page-overlay-open 的 overflow:hidden），而 #settingsPanel 的
 *   overflow:hidden 是圆角必需的、去不掉。fixed 以视口为参照，一次绕开全部。
 */
/**
 * 摆放手机下拉分栏的位置。
 *
 * 形态：三个子项**竖着排在「扩展」正下方**，每个与「扩展」按钮同宽同高 ——
 *   看起来就是「扩展」这一项展开成了三项，而不是浮在别处的菜单。
 *
 * 所以坐标与尺寸全部取自**父按钮本身**，不取自卡片或内容区。
 *   · left  = 父按钮左边缘
 *   · width = 父按钮宽度（父按钮在导航末尾，左边还有空间，不会顶到屏幕外）
 *   · top   = 导航栏下边缘（紧接导航，不留缝）
 *
 * 用 fixed：绝对定位会被祖先的 overflow 裁掉（#settingsTabNav 的 overflow-x:auto、
 *   #settingsPanel 的 overflow:hidden），而后者是圆角必需的、去不掉。
 */
/**
 * 手机窄屏下把子项的高度对齐到「扩展」按钮。
 *
 * 子项在**正常流**里（见 pages-luxe.css），位置由布局引擎负责，不需要算坐标 ——
 *   这也是它能跟着导航一起滚动的原因。
 * 唯一要同步的是**高度**：不同宽度下「扩展」按钮高度会变（30 / 32px），
 *   而子项高度写成固定值就会比父项高出一截，"同一个控件"的观感就断了。
 */
/**
 * 摆放手机窄屏的子项浮层（宽屏不用：那里子项直接缩进在导航里）。
 *
 * 子项被挂到 #settingsPanel 下（见 init.js），用 absolute 定位，
 *   参照物是弹窗本体 —— 所以坐标要换算成"相对弹窗"的值。
 *
 * 位置与尺寸全部取自「扩展」按钮本身：用户要的是"竖排在扩展下面、
 *   和扩展一样大小"，取卡片或内容区宽度都会让子项比父项宽出一大截。
 */
/**
 * 摆放手机窄屏的子项（宽屏不用：那里子项直接缩进在导航里）。
 *
 * 位置与尺寸全部取自「扩展」按钮本身 —— 分支要"从这一项长出来"，
 *   取卡片或内容区宽度都会让分支和按钮对不上。
 * 两个微调量来自 demo 里拖出来的值：
 *   · --off-x：竖线相对按钮左边缘的水平偏移（0px）
 *   · --off-y：竖线上端相对按钮底部的垂直偏移（6px，让线更明显地穿进按钮）
 */
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


