/* 启动后的界面辅助：公告延迟、侧栏开关、视口高度、设置分栏切换、自定义下拉。 */
'use strict';

function openAnnouncementDeferred() {
    try {
        if (typeof hasAgreedAnnouncement === 'function' && hasAgreedAnnouncement()) return false;
    } catch (e) { /* 判断出错时按"没同意过"处理，宁可多弹一次也不该永远不弹 */ }

    // 先广播"将要出现"：生日插件必须在**彩蛋演之前**知道，否则收到就晚了
    try { window.ElainaMods?.emit?.('announcement-pending', {}); } catch (e) { /* 忽略 */ }
    loadAnnouncement().then(openAnnouncement);
    return true;
}

function showSidebarFunc() {
    if (window.innerWidth <= 980) {
        elements.initialState.classList.add('sidebar-underlay-hidden');
        elements.floatingMic.classList.add('sidebar-underlay-hidden');
    }
    document.body.classList.add('sidebar-open');
    elements.sidebarOverlay.classList.remove('hidden');
}

function syncViewportHeight() {
    const viewport = window.visualViewport;
    const viewportHeight = viewport?.height || window.innerHeight;
    const viewportTop = window.innerWidth <= 980 ? Math.max(0, viewport?.offsetTop || 0) : 0;
    if (viewportHeight) document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
    document.documentElement.style.setProperty('--viewport-offset-top', `${Math.round(viewportTop)}px`);
}

function keepFocusedComposerVisible(input) {
    if (!input || window.innerWidth > 980) return;
    const align = () => {
        if (document.activeElement !== input) return;
        syncViewportHeight();
        input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (input === elements.textInput && elements.conversationHistory) {
            elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
        }
    };
    requestAnimationFrame(align);
    setTimeout(align, 180);
    setTimeout(align, 360);
}

// 宽屏：对话面板的展开 / 收起 —— 只收起「对话列表 + 分类」栏，76px 竖栏保留；窄屏是抽屉，不参与布局。
function setSidebarCollapsed(collapsed) {
    if (window.innerWidth <= 980) return;
    const on = document.documentElement.classList.toggle('rd-sidebar-collapsed', Boolean(collapsed));
    const btn = elements.showSidebar || document.getElementById('showSidebar');
    if (btn) {
        const label = on ? '展开对话列表' : '收起对话列表';
        btn.title = label;
        btn.setAttribute('aria-label', label);
    }
}

function toggleSidebarPanel() {
    if (window.innerWidth <= 980) return;
    setSidebarCollapsed(!document.documentElement.classList.contains('rd-sidebar-collapsed'));
}

/** 只有首页展开（要挑对话），对话、回忆整页、设置 / 成就 / 市场都收起。 */
function syncSidePanelForView() {
    if (window.innerWidth <= 980) return;
    const initEl = document.getElementById('initialState');
    const home = initEl ? !initEl.classList.contains('hidden') : false;
    let overlayOpen = false;
    ['settingsOverlay', 'achievementsOverlay', 'marketOverlay'].forEach((id) => {
        const el = document.getElementById(id);
        if (el && !el.classList.contains('hidden')) overlayOpen = true;
    });
    let onPage = false;
    try { onPage = Boolean(state.notesMode || state.diaryMode || state.memoryPageMode); } catch (e) { onPage = false; }
    setSidebarCollapsed(overlayOpen || onPage || !home);
}

/** 用观察整页容器的显隐来同步面板，而不是在每个 enter/exit 里各补一句：入口太多（竖栏、设置分栏、插件跳转、系统返回），漏一处就有一条路径不收起。 */
function watchSidePanel() {
    if (window.MutationObserver) {
        let scheduled = false;
        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            const run = () => { scheduled = false; syncSidePanelForView(); };
            if (window.requestAnimationFrame) window.requestAnimationFrame(run);
            else window.setTimeout(run, 16);
        };
        ['initialState', 'conversationHistory', 'notesPage', 'diaryPage', 'memoryPage', 'settingsOverlay', 'achievementsOverlay', 'marketOverlay'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) new MutationObserver(schedule).observe(el, { attributes: true, attributeFilter: ['class'] });
        });
    }
    syncSidePanelForView();
    try {
        const mq = window.matchMedia('(max-width: 980px)');
        if (mq && mq.addEventListener) mq.addEventListener('change', syncSidePanelForView);
    } catch (e) { /* 老 WebView 没有 addEventListener 时只在启动时同步一次 */ }
}

function closeSidebarDrawer() {
    if (window.innerWidth > 980) return;
    closeConversationContextMenu();
    document.body.classList.remove('sidebar-open');
    closeOverlayPanel(elements.sidebarOverlay);
    elements.initialState.classList.remove('sidebar-underlay-hidden');
    elements.floatingMic.classList.remove('sidebar-underlay-hidden');
}

// 设置分栏 Tab 切换
function switchSettingsTab(name) {
    const extWasActive = Boolean(document.getElementById('tab-mods')?.classList.contains('active-panel'));
    const extNavVisible = Boolean(document.getElementById('settingsTabNav')?.getClientRects().length);
    // 二级页只属于当前分栏：切栏时先退回卡片，避免内容留在原页面。
    if (typeof closeSettingsSubpage === 'function') closeSettingsSubpage();
    // 选择器不能用 `:scope` 之类只限**主导航**：插件注册的分栏按钮也带 .settings-tab-btn，必须一视同仁。
    document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.settingsTab === name));
    document.querySelectorAll('.settings-tab-panel').forEach(p => p.classList.toggle('active-panel', p.id === name));
    // 宽屏分栏切换给一次轻入场；窄屏由 mobile-shell 的观察者走 mm-slide-in-right，两边各一套不叠加。
    if (window.innerWidth > 980) {
        const activePanel = document.querySelector('.settings-tab-panel.active-panel');
        if (activePanel) {
            activePanel.classList.remove('settings-panel-in');
            void activePanel.offsetWidth;
            activePanel.classList.add('settings-panel-in');
        }
    }
    // 进入「扩展」时保证里面恰好有一个子面板可见：分栏可从多条路径切进来（导航点击、程序化切栏、恢复上次分栏、插件跳转）。
    if (name === 'tab-mods' && typeof ensureExtTab === 'function') {
        ensureExtTab();
        // 从别的分栏进来时展开一次子分栏；本来就停在扩展页时不抢用户的收起动作（父项自己是 toggle）。
        if (!extWasActive && extNavVisible && typeof switchExtTab === 'function') {
            let wanted = 'ext-mod';
            try { if (typeof state !== 'undefined' && state && state._extTab) wanted = state._extTab; } catch (e) { /* 状态未就绪时回插件页 */ }
            switchExtTab(wanted, { forceOpen: true, noScroll: true });
        }
    }
    // 「模型」分栏每次切进来都回到入口列表；具体分页由 openSettingsAt 的深链再切。
    if (name === 'tab-model' && typeof resetModelSectionPage === 'function') resetModelSectionPage();
    // 切到别的分栏时收起扩展子分栏：菜单留在原地会像"浮在一个不相干的分栏上"。
    if (name !== 'tab-mods') {
        const extGroup = document.getElementById('settingsExtNav');
        const extMenu = document.querySelector('.ext-nav-children.ext-menu-floating');
        const extOpen = Boolean((extGroup && extGroup.classList.contains('is-open')) || (extMenu && extMenu.classList.contains('is-open')));
        if (extOpen && typeof switchExtTab === 'function') switchExtTab('ext-mod', { forceClose: true });
    }
    // 让选中的分栏滚进可视区（手机必需：程序化切换不会自动滚）；'smooth' 在部分旧 WebView 不支持，用 try 兜底。
    try {
        const nav = document.getElementById('settingsTabNav');
        const btn = nav && nav.querySelector(`.settings-tab-btn[data-settings-tab="${name}"]`);
        if (btn && typeof btn.scrollIntoView === 'function') {
            btn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        }
    } catch (e) {
        try {
            const nav = document.getElementById('settingsTabNav');
            const btn = nav && nav.querySelector(`.settings-tab-btn[data-settings-tab="${name}"]`);
            if (btn) btn.scrollIntoView();
        } catch (e2) { /* 滚不动也不影响切栏本身 */ }
    }
    // 日志分栏：进来时开始拉取与轮询，离开时停掉 —— 它每 2 秒打一次 /api/logs/tail，不停的话停在别的分栏也在拉。
    try {
        if (window.LogViewer) {
            if (name === 'tab-log') window.LogViewer.open();
            else window.LogViewer.close();
        }
    } catch (e) { /* 日志模块出问题不该影响切栏 */ }
    // 通知插件：某个分栏被显示了。插件分栏的 render(container) 是**延迟调用**的 —— 挂载时只建空壳，真被点开才渲染。
    try {
        document.dispatchEvent(new CustomEvent('elaina:settings-tab', { detail: { name } }));
    } catch (e) { /* 环境不支持 CustomEvent 也不该影响切栏 */ }
}

// 点击走**事件委托**，而不是"查一遍现有按钮再逐个绑"：插件分栏的按钮是页面加载**之后**才由 mods.js 插进来的，逐按钮绑定对它们完全无效 —— 表现是"插件分栏出现了，点了没反应"。
(function bindSettingsTabNav() {
    const nav = document.getElementById('settingsTabNav');
    if (!nav) return;
    nav.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('.settings-tab-btn') : null;
        if (btn && nav.contains(btn)) switchSettingsTab(btn.dataset.settingsTab);
    });
})();

// 宿主插槽集中在 web/js/host-slots.js —— 那是插件作者唯一需要看的契约面；本文件只负责分栏**行为**（切换函数与事件委托），不负责挖插槽。
// 设置下拉（含「当前会话设定」弹窗里的两个）：原生 <select> 的面板由系统绘制、CSS 选不中它，故自绘一个主题化列表；select **原样保留**（仍是取值来源），只拦 mousedown，点选项时写回 value 并派发冒泡 change。
let cselectPanel = null;
let cselectOwner = null;

function closeCselect() {
    if (cselectPanel) { cselectPanel.remove(); cselectPanel = null; }
    if (cselectOwner) { cselectOwner.classList.remove('cselect-open'); cselectOwner = null; }
}

function openCselect(select) {
    closeCselect();
    const rect = select.getBoundingClientRect();
    const panel = document.createElement('div');
    panel.className = 'cselect-panel';
    panel.setAttribute('role', 'listbox');
    panel.style.left = rect.left + 'px';
    panel.style.width = rect.width + 'px';
    let any = false;
    Array.prototype.forEach.call(select.options, (opt) => {
        if (opt.hidden || opt.disabled) return;
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'model-combo-item';
        item.setAttribute('role', 'option');
        item.textContent = opt.textContent;
        if (opt.value === select.value) item.classList.add('is-current');
        item.addEventListener('click', () => {
            if (select.value !== opt.value) {
                select.value = opt.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
            closeCselect();
        });
        panel.appendChild(item);
        any = true;
    });
    if (!any) {
        const empty = document.createElement('div');
        empty.className = 'model-combo-empty';
        empty.textContent = '没有可选项目';
        panel.appendChild(empty);
    }
    document.body.appendChild(panel);
    // 默认贴在 select 下沿；下方空间不够就翻到上沿
    const h = panel.offsetHeight;
    if (rect.bottom + h > window.innerHeight - 8 && rect.top - h > 8) {
        panel.classList.add('cselect-panel--up');
        panel.style.top = (rect.top - h) + 'px';
    } else {
        panel.style.top = rect.bottom + 'px';
    }
    select.classList.add('cselect-open');
    cselectPanel = panel;
    cselectOwner = select;
}

function initSettingsDropdowns() {
    document.querySelectorAll('#settingsPanel select.modal-input, #settingsPanel select.log-select, #conversationPromptOverlay select.modal-input').forEach((select) => {
        if (select.dataset.cselect) return;
        select.dataset.cselect = '1';
        select.addEventListener('mousedown', (ev) => {
            // 阻止原生面板（Chromium 上 mousedown 的 preventDefault 即可拦住）
            ev.preventDefault();
            if (cselectOwner === select) closeCselect();
            else openCselect(select);
        });
        select.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') closeCselect();
        });
    });
}

document.addEventListener('mousedown', (ev) => {
    if (!cselectPanel) return;
    const t = ev.target;
    if (t && t.closest && (t.closest('select') || cselectPanel.contains(t))) return;
    closeCselect();
}, true);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeCselect(); });
window.addEventListener('resize', closeCselect);
window.addEventListener('scroll', closeCselect, true);

// 宽屏侧栏面板：启动时先按当前页面同步一次，之后由 watchSidePanel 的观察者跟着页面走。
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchSidePanel);
else watchSidePanel();


