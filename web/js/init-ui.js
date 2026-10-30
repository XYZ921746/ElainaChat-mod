/* ============================================================================
 * 启动后的界面辅助（从 init.js 拆出）
 *
 * 公告延迟、侧栏开关、视口高度、设置分栏切换、自定义下拉。
 * 依赖 DOM 与宿主插槽（运行时才调用）。
 * ========================================================================== */
'use strict';

function openAnnouncementDeferred() {
    // 已经同意过 → 不会再弹，连广播都不需要
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

function closeSidebarDrawer() {
    if (window.innerWidth > 980) return;
    closeConversationContextMenu();
    document.body.classList.remove('sidebar-open');
    elements.sidebarOverlay.classList.add('hidden');
    elements.initialState.classList.remove('sidebar-underlay-hidden');
    elements.floatingMic.classList.remove('sidebar-underlay-hidden');
}



// ===== 设置分栏 Tab 切换 =====
function switchSettingsTab(name) {
    // 注意选择器要用 `:scope` 之外的方式限定到**主导航**：子分栏按钮虽然不同类名，
    //   但插件注册的分栏按钮也带 .settings-tab-btn，必须一视同仁（它们都算主分栏）。
    document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.settingsTab === name));
    document.querySelectorAll('.settings-tab-panel').forEach(p => p.classList.toggle('active-panel', p.id === name));
    // 进入「扩展」时保证里面恰好有一个子面板可见（见 ensureExtTab 的说明）。
    //   放在这里而不是只在 openSettings 里：分栏可以从很多路径切进来
    //   （导航点击、程序化切栏、恢复上次分栏、插件跳转），漏一条就是整页空白。
    if (name === 'tab-mods' && typeof ensureExtTab === 'function') ensureExtTab();
    // 切到**别的**分栏时收起扩展下拉：展开态由 .is-open 唯一维护（见 switchExtTab），
    //   而切栏会清掉父项的 active —— 若不同步清掉 .is-open，菜单会留在原地，
    //   看起来像"菜单浮在一个不相干的分栏上"。
    if (name !== 'tab-mods') {
        // 走 switchExtTab 的收起分支，才能播反向动画（直接摘类会瞬间消失）
        const extMenu = document.querySelector('.ext-nav-children.ext-menu-floating');
        if (extMenu && extMenu.classList.contains('is-open') && typeof switchExtTab === 'function') {
            switchExtTab('ext-mod', { forceClose: true });
        }
    }
    // 让选中的分栏**滚进可视区**（手机必需）。
    //   手机上 9 个分栏放不下，导航是横向滚动的：靠后的「日志」「插件」初始时
    //   在屏幕外。如果用户是通过别的方式切过去的（程序化切栏、恢复上次分栏、
    //   插件注册的新分栏），导航还停在最左边 —— 看起来像"没有选中任何分栏"。
    //   点击切换时浏览器会自动滚（:focus），但**程序化切换不会**，所以这里显式做。
    //   behavior:'smooth' 在部分旧 WebView 上不支持 → 用 try 兜底成瞬时滚动。
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
    // 日志分栏：进来时开始拉取与轮询，离开时停掉。
    //   为什么必须停：它每 2 秒打一次 /api/logs/tail，不停的话"停在别的分栏"
    //   也在拉；而服务端若把它记进日志就是自噪音（log-buffer.mjs 的注释里有来龙去脉）。
    try {
        if (window.LogViewer) {
            if (name === 'tab-log') window.LogViewer.open();
            else window.LogViewer.close();
        }
    } catch (e) { /* 日志模块出问题不该影响切栏 */ }
    // 通知插件：某个分栏被显示了。
    // 为什么要广播：插件分栏的 render(container) 是**延迟调用**的 ——
    // 挂载时只建空壳，真被点开才渲染，没打开过的分栏不白做初始化。
    try {
        document.dispatchEvent(new CustomEvent('elaina:settings-tab', { detail: { name } }));
    } catch (e) { /* 环境不支持 CustomEvent 也不该影响切栏 */ }
}

// 点击走**事件委托**，而不是"查一遍现有按钮再逐个绑"。
//   为什么必须这样（这是插件分栏能不能用的关键）：插件分栏的按钮是页面加载
//   **之后**才由 mods.js 插进来的（要等 /mods/index.json 拉回来再逐个注册）。
//   逐按钮绑定的写法对它们完全无效 —— 表现是"插件分栏出现了，点了没反应"，
//   而且刷新也未必复现（取决于清单回来的快慢），属于最难查的一类。
//   委托给容器就没有这个问题：此后无论何时插入按钮，点击都有人管。
(function bindSettingsTabNav() {
    const nav = document.getElementById('settingsTabNav');
    if (!nav) return;
    nav.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('.settings-tab-btn') : null;
        if (btn && nav.contains(btn)) switchSettingsTab(btn.dataset.settingsTab);
    });
})();

// ===== 宿主插槽已移到 web/js/host-slots.js =====
// 全部插槽（settings.tabs / header.actions / sidebar.footer / composer.actions /
// chat.message.actions）集中在那一个文件里 —— 那是插件作者唯一需要看的契约面。
// 本文件只负责分栏**行为**（切换函数与事件委托），不负责挖插槽。


// ===== Live2D 设置逻辑已搬进 mods/live2d/settings-panel.js =====
// 模型列表 / 上传 / 重命名 / 删除 / 背景 / 鼠标跟随都随插件走，
// 由 settings.tabs 插槽在被点开时渲染（见那个插件的 register）。

//  设置下拉：自绘弹出面板
//  用户要求"改下拉"：把原生 <select> 的**弹出面板**换成主题化列表，
//  对齐「模型名」组合框。原生面板由系统绘制、CSS 选不中它，只能自己弹一个。
//  ── 与既有代码的关系（不动取值逻辑）─────────────────────────────────────
//  `select` 元素**原样保留**（它仍是取值来源、仍显示当前值），既有 `change`
//  监听器也不动 —— 只是拦截它的 `mousedown` 阻止原生面板，改弹自绘列表；
//  用户点选项时写回 `select.value` 并派发冒泡的 `change`，
//  所以 `settingApiFormat` 等既有处理逻辑照常触发。
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
    document.querySelectorAll('#settingsPanel select.modal-input, #settingsPanel select.log-select').forEach((select) => {
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

// 点击别处 / Esc / 滚动 / 缩放都收起面板
document.addEventListener('mousedown', (ev) => {
    if (!cselectPanel) return;
    const t = ev.target;
    if (t && t.closest && (t.closest('select') || cselectPanel.contains(t))) return;
    closeCselect();
}, true);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeCselect(); });
window.addEventListener('resize', closeCselect);
window.addEventListener('scroll', closeCselect, true);


