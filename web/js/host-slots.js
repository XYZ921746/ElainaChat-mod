/* ============================================================================
 * 宿主插槽清单 —— mod 只能往**这个文件里挖好的**插槽注册。
 *
 * ── 为什么单独成文件 ──────────────────────────────────────────────────────
 *
 * 插槽是 mod 系统与宿主界面之间**唯一的契约面**。如果每个插槽的实现散在
 * 各自的界面代码里，"我能挂在哪"就变成一个要通读全部前端才能回答的问题 ——
 * 对想 DIY 插件的用户来说，这等于没有扩展点。所以：**全部插槽集中在这里**，
 * 插件作者只看这一个文件就知道边界在哪。
 *
 * ── 两种形态（决定 mod 怎么写 spec）────────────────────────────────────────
 *
 * ① **普通插槽**：mod 注册时**挂载一次**。适合"界面里有一块固定位置"。
 *      spec = { id, ... , render(container, ctx) }   （具体字段见各插槽说明）
 *
 * ② **每项级插槽**（标了 `item: true`）：宿主**每渲染一项就问一次**。
 *      适合"每条消息都要长按钮"这种 —— 注册时还没有消息，那时什么都挂不了。
 *      宿主调 `ElainaMods.renderItemSlot(名字, 容器, 项)` 把 spec 拉出来渲染。
 *      必须提供 `cleanup(modId)`：停用时要能把**已经画在界面上的**摘掉，
 *      不能等下次重渲染（否则用户关了插件，按钮还留着）。
 *
 * ── 怎么再加一个插槽（宿主开发者）────────────────────────────────────────
 *
 * 1. 在 index.html 里给那块位置一个稳定的 id（或一个 class 容器）
 * 2. 在本文件末尾 `defineSlot('xxx.yyy', ...)`，用 containerSlot(容器 id) 即可
 * 3. 若是"每项级"，`item: true` + `cleanup` + `refresh`
 * 4. 在 README 的插件作者章节与 开发文档.md 的插槽表里各加一行
 *
 * ★ 加插槽时**不要**顺手加一个新的 API 方法：插槽机制就是为了避免
 *   "每多一种扩展点就多一个宿主 API"（见 开发文档.md 8.45）。
 * ========================================================================== */

/** 把 mod id 变成能安全塞进 CSS 选择器的形式（mod id 由插件自己声明，不能直接拼） */
function modSlotCssEscape(id) {
    const s = String(id || '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return s.replace(/[^\w-]/g, (ch) => '\\' + ch);
}

/**
 * 「宿主给个容器、mod 往里画」型插槽的通用实现。
 *
 * 回收方式：记下 mod 渲染**之前**容器里已有的子节点，之后新出现的都算它的，
 * 统一打上 data-mod；停用时只摘这些 —— 不碰其它 mod 与宿主自己的东西。
 * （不用 innerHTML='' 一把清空：同一容器可能挂了多个 mod 的贡献。）
 */
function containerSlot(containerId, note) {
    return {
        note,
        mount(spec, ctx) {
            const box = document.getElementById(containerId);
            if (!box) {
                ctx.log('error', '插槽容器 #' + containerId + ' 不存在，本次注册被忽略');
                return null;
            }
            if (typeof spec.render !== 'function') {
                ctx.log('error', '插槽 ' + ctx.name + ' 的 spec 需要 render(container, ctx)');
                return null;
            }
            const before = new Set(box.children);
            try {
                spec.render(box, { modId: ctx.modId });
            } catch (e) {
                ctx.log('error', '渲染到 #' + containerId + ' 时出错（该插槽内容为空）', e);
            }
            const added = [...box.children].filter((c) => !before.has(c));
            for (const el of added) {
                if (!el.hasAttribute('data-mod')) el.setAttribute('data-mod', ctx.modId);
            }
            return {
                el: added[0] || null,
                dispose() {
                    for (const el of added) {
                        try { el.remove(); } catch (e) { /* 忽略 */ }
                    }
                },
            };
        },
    };
}

(function () {
    'use strict';

    if (!window.ElainaMods || typeof window.ElainaMods.defineSlot !== 'function') return;

    // ========================================================================
    //  ① settings.tabs —— 在「设置」里占一个分栏
    //
    //  spec: { id, label, title?, render(container) }
    //  分栏内容是**延迟渲染**的：没被点开过就不初始化（第三方内容不该白占启动时间）。
    // ========================================================================
    window.ElainaMods.defineSlot('settings.tabs', {
        note: '设置里的一栏；render 在被点开时才调用',
        mount(spec, ctx) {
            const key = String(spec.id || '').trim();
            if (!key) { ctx.log('error', 'settings.tabs 的分栏需要 id'); return null; }
            const panelId = key.startsWith('tab-') ? key : 'tab-' + key;
            const nav = document.getElementById('settingsTabNav');
            const content = document.getElementById('settingsContent');
            if (!nav || !content) { ctx.log('error', '找不到设置分栏容器，分栏未注册'); return null; }
            // 撞名直接拒绝：宿主已有同 id 分栏时若强行占位会把原分栏顶掉，
            // 用户会以为"设置坏了"，而不是"插件有问题"。
            if (document.getElementById(panelId) || nav.querySelector('[data-settings-tab="' + panelId + '"]')) {
                ctx.log('error', '设置里已经有「' + panelId + '」这个分栏了，本次注册被忽略');
                return null;
            }

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'settings-tab-btn';
            btn.dataset.settingsTab = panelId;
            btn.textContent = String(spec.label || spec.id);
            if (spec.title) btn.title = String(spec.title);

            const panel = document.createElement('div');
            panel.id = panelId;
            panel.className = 'settings-tab-panel';

            nav.appendChild(btn);
            content.appendChild(panel);

            let rendered = false;
            const renderOnce = () => {
                if (rendered) return;
                rendered = true;
                try { if (typeof spec.render === 'function') spec.render(panel); }
                catch (e) { ctx.log('error', '分栏渲染失败（分栏仍会显示，但内容是空的）', e); }
            };
            const onTabShown = (ev) => {
                if (ev && ev.detail && ev.detail.name === panelId) renderOnce();
            };
            document.addEventListener('elaina:settings-tab', onTabShown);
            // 注册时若正停在这一栏（例如停用后又启用），立刻渲染，否则要再点一次才出内容
            if (btn.classList.contains('active')) renderOnce();

            const teardown = () => {
                // 停用时把这一栏整个拆掉（不是藏起来）。若它正被看着，先切回「外观」——
                // 否则内容区会空着，看起来像"设置面板坏了"。
                if (panel.classList.contains('active-panel') && typeof switchSettingsTab === 'function') {
                    switchSettingsTab('tab-appearance');
                }
                document.removeEventListener('elaina:settings-tab', onTabShown);
                btn.remove();
                panel.remove();
            };

            return {
                el: btn,
                // deactivate（停用）与 dispose（卸载）在这里是同一件事：拆掉。
                // 差别在 mod 系统那边 —— 停用**保留 spec**，启用时按 spec 重新挂载。
                dispose: teardown,
            };
        },
    });

    // ========================================================================
    //  ② settings.modal —— 插件的设置**独立成窗**（不占设置里的分栏）
    //
    //  spec: { id, label, title?, render(container), onOpen?, onClose? }
    //
    //  ★ 为什么需要它（2026-10 用户要求）：
    //   插件一多，设置面板里就会堆一排分栏（外观/角色/对话/语音/视觉/Live2D/能力/高级/插件…），
    //   而其中大半是**偶尔才调一次**的插件设置。全堆在主设置里既难找也难看。
    //   独立成窗之后：主设置只留宿主自己的分栏，插件设置从插件卡片上的齿轮按钮进入。
    //
    //  与 settings.tabs 的分工：
    //   · 宿主自己的设置 → settings.tabs（它本来就该在主设置里）
    //   · 插件设置       → settings.modal（默认走这个；需要常驻分栏的插件才用 tabs）
    // ========================================================================
    window.ElainaMods.defineSlot('settings.modal', {
        note: '插件设置独立成窗；由插件卡片上的齿轮按钮打开',
        mount(spec, ctx) {
            const key = String(spec.id || '').trim();
            if (!key) { ctx.log('error', 'settings.modal 需要 id'); return null; }
            if (typeof spec.render !== 'function') {
                ctx.log('error', 'settings.modal 的 spec 需要 render(container)');
                return null;
            }
            const overlay = document.getElementById('modSettingsOverlay');
            const titleEl = document.getElementById('modSettingsTitle');
            const bodyEl = document.getElementById('modSettingsBody');
            if (!overlay || !bodyEl) { ctx.log('error', '找不到插件设置弹窗容器，未注册'); return null; }

            // ★ 每个插件**各有一个自己的容器**（由宿主创建、挂在 bodyEl 里），
            //   打开谁的设置就显示谁的那块、藏起其它的。
            //
            //   为什么不直接让所有插件往 #modSettingsBody 里写（原先的做法，有 bug）：
            //   插件为了不白占启动时间，都是"首次打开时才渲染"，并且渲染第一件事
            //   就是 `container.innerHTML = '...'` 清空容器。而容器是**共用**的 ——
            //   于是：打开 A（渲染 A）→ 打开 B（清掉 A、渲染 B）→ 再打开 A
            //   （A 以为自己已经渲染过，跳过）→ **标题是 A、内容还是 B**。
            //   实测复现：标题「Live2D 引擎与模型 · 设置」，里面却是视频通话的下拉。
            //
            //   给每个插件一块自己的 DOM，这个问题从根上不存在了：
            //   · 谁也不用清空别人的内容，打开谁就显示谁的那块
            //   · 渲染一次的结果能一直留着，重开是**瞬开**（不用重新拉 panel.html）
            //   · 异步渲染（有的插件 render 里要 await 取面板 HTML）也不会串台 ——
            //     它写的是自己那块，哪怕写完时已经被切走，也只是写进了隐藏的容器
            let paneEl = null;
            let rendered = false;

            /** 取得（必要时创建）本插件专属的容器 */
            const ensurePane = () => {
                if (paneEl && paneEl.isConnected) return paneEl;
                paneEl = document.createElement('div');
                paneEl.className = 'mod-settings-pane';
                paneEl.setAttribute('data-mod-settings-pane', key);
                bodyEl.appendChild(paneEl);
                return paneEl;
            };

            /** 渲染（只做一次）。★ 先捕获 pane，异步渲染也不会写错地方 */
            const renderOnce = () => {
                if (rendered) return;
                rendered = true;
                const pane = ensurePane();
                pane.innerHTML = '';
                try { spec.render(pane); }
                catch (e) { ctx.log('error', '插件设置渲染失败', e); }
            };

            /** 只显示自己那块，藏起其它插件的。
             *  ★ 用自有类 mod-settings-pane-off（display:none）而不是 Tailwind 的
             *    .hidden：pane 是运行期建的元素，不该依赖工具类是否被正确生成；
             *    且 display:none 才能让 #modSettingsBody 的 space-y-5 不给隐藏块留空隙。 */
            const showOnlyMine = () => {
                const mine = ensurePane();
                for (const el of bodyEl.querySelectorAll('[data-mod-settings-pane]')) {
                    if (el === mine) el.classList.remove('mod-settings-pane-off');
                    else el.classList.add('mod-settings-pane-off');
                }
            };

            const open = () => {
                renderOnce();
                showOnlyMine();
                if (titleEl) titleEl.textContent = String(spec.title || spec.label || key) + ' · 设置';
                // 记住当前打开的是哪个插件，供关闭/停用/重开时判断
                overlay.setAttribute('data-mod-settings-id', key);
                overlay.classList.remove('hidden');
                overlay.classList.add('flex');
                try { if (typeof spec.onOpen === 'function') spec.onOpen(paneEl); } catch (e) { /* 忽略 */ }
            };
            const close = () => {
                overlay.classList.add('hidden');
                overlay.classList.remove('flex');
                overlay.removeAttribute('data-mod-settings-id');
                try { if (typeof spec.onClose === 'function') spec.onClose(); } catch (e) { /* 忽略 */ }
            };

            // 关闭按钮 / 点遮罩 / Esc —— 都绑在**容器**上，只绑一次
            if (!overlay.__modSettingsBound) {
                overlay.__modSettingsBound = true;
                document.getElementById('modSettingsClose')?.addEventListener('click', () => {
                    overlay.classList.add('hidden');
                    overlay.classList.remove('flex');
                    overlay.removeAttribute('data-mod-settings-id');
                });
                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) {
                        overlay.classList.add('hidden');
                        overlay.classList.remove('flex');
                        overlay.removeAttribute('data-mod-settings-id');
                    }
                });
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
                        overlay.classList.add('hidden');
                        overlay.classList.remove('flex');
                        overlay.removeAttribute('data-mod-settings-id');
                    }
                });
            }

            // 暴露给插件页的齿轮按钮：按 id 打开
            window.__modSettingsOpeners = window.__modSettingsOpeners || {};
            window.__modSettingsOpeners[key] = open;

            return {
                el: null,
                /** 供外部（插件卡片）调用 */
                open,
                close,
                dispose() {
                    if (window.__modSettingsOpeners) delete window.__modSettingsOpeners[key];
                    // 若正开着这个插件的设置，关掉 —— 否则停用后弹窗还留着（内容是死的）
                    if (overlay.getAttribute('data-mod-settings-id') === key) close();
                    // 把自己的那块容器也摘掉。★ 不摘的话它会以 hidden 状态留在
                    // #modSettingsBody 里 —— 插件重新启用时会再建一块，
                    // 于是残留越积越多（虽然看不见，但 DOM 一直在长）。
                    try { if (paneEl && paneEl.isConnected) paneEl.remove(); } catch (e) { /* 忽略 */ }
                    paneEl = null;
                    rendered = false;
                },
            };
        },
    });

    // ========================================================================
    //  ③ header.actions —— 顶部栏加一个按钮
    //
    //  spec: { id, label, title?, svg?, onClick(ev) }
    //  样式沿用宿主自己的 header-memory-btn，所以插件按钮看起来就是应用的一部分。
    // ========================================================================
    window.ElainaMods.defineSlot('header.actions', {
        note: '顶部栏的一个按钮；spec 里给 label / svg / onClick',
        mount(spec, ctx) {
            const slot = document.getElementById('headerModSlot');
            if (!slot) { ctx.log('error', '找不到顶部按钮挂载点，按钮未注册'); return null; }

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'header-memory-btn';
            const shortId = String(spec.id || '');
            if (shortId) btn.id = 'mod-header-' + ctx.modId + '-' + shortId;
            if (spec.title) btn.title = String(spec.title);
            // 图标用 innerHTML：这是 mod 自己的标记，而 mod 本来就能执行任意 JS
            // （同源注入脚本），所以这里不引入新的信任面。但**文字走 textContent**。
            if (spec.svg) btn.innerHTML = String(spec.svg);
            if (spec.label) {
                const span = document.createElement('span');
                span.textContent = String(spec.label);
                btn.appendChild(span);
            }
            if (typeof spec.onClick === 'function') {
                btn.addEventListener('click', (ev) => {
                    try { spec.onClick(ev); } catch (e) { ctx.log('error', '顶部按钮点击处理失败', e); }
                });
            }
            slot.appendChild(btn);

            return { el: btn, dispose() { btn.remove(); } };
        },
    });

    // ========================================================================
    //  ③ sidebar.footer —— 侧栏底部（会话列表下方、版本号上方）
    //
    //  spec: { id, render(container, ctx) }
    //  自由排布，样式请插件自带（用主题变量，见 README 的插件作者章节）。
    // ========================================================================
    window.ElainaMods.defineSlot('sidebar.footer', containerSlot('sidebarModSlot', '侧栏底部的一块区域'));

    // ========================================================================
    //  ④ composer.actions —— 输入框那一行（文本输入与麦克风/发送之间）
    //
    //  spec: { id, render(container, ctx) }
    //  容器是 display:contents，插件元素直接参与该行 flex 布局；记得 flex:none。
    // ========================================================================
    window.ElainaMods.defineSlot('composer.actions', containerSlot('composerModSlot', '输入框那一行的按钮位'));

    // ========================================================================
    //  ⑤ chat.message.actions —— 每条消息的标题行（★ 每项级插槽）
    //
    //  spec: { id, render(container, item) }，item = { message, conversationId }
    //  只在**有消息**时才可能被调用，所以注册时挂不了任何东西。
    // ========================================================================
    window.ElainaMods.defineSlot('chat.message.actions', {
        item: true,
        note: '每条消息标题行上的按钮；render(container, { message, conversationId })',
        cleanup(modId) {
            // 停用/卸载：把该 mod 已经画上去的按钮摘掉。
            // 必须**立刻**摘 —— 否则用户关了插件，消息行里还留着点了没反应的按钮。
            const sel = '.message-slot-actions > [data-mod="' + modSlotCssEscape(modId) + '"]';
            document.querySelectorAll(sel).forEach((el) => { try { el.remove(); } catch (e) { /* 忽略 */ } });
        },
        refresh() {
            // 启用：把界面上**已经存在**的消息行补画一遍（不重排消息、不动滚动位置）
            decorateMessageSlots(document);
        },
    });

    /**
     * 宿主渲染完消息后调用它 —— 把消息行里的插槽容器交给各 mod。
     *
     * ★ 为什么由宿主"推"而不是让 mod 自己监听消息渲染：
     *   mod 若自己去 MutationObserver 或改写 renderMessage，就绕过了宿主本来的
     *   增量渲染，也把"哪个元素属于哪条消息"的知识复制了一份到插件里。
     *   宿主明确地把容器和上下文交出去，插件只负责往里画。
     *
     * @param {Element|Document} root 渲染范围（单条消息元素，或 document 表示全量补画）
     */
    function decorateMessageSlots(root) {
        if (!root || !root.querySelectorAll) return;
        if (!window.ElainaMods || typeof window.ElainaMods.renderItemSlot !== 'function') return;
        let boxes = [];
        try { boxes = [...root.querySelectorAll('.message-slot-actions')]; } catch (e) { return; }
        if (!boxes.length) return;

        // 找当前会话，供 mod 判断这条消息的上下文（拿不到就传 null，插件自己决定怎么办）
        let conv = null;
        try {
            conv = (state.conversations || []).find((c) => c.id === state.currentConversationId) || null;
        } catch (e) { /* state 还没就绪时忽略 */ }

        for (const box of boxes) {
            const id = box.getAttribute('data-message-id');
            const message = (conv && Array.isArray(conv.messages))
                ? conv.messages.find((m) => String(m.id) === String(id)) || null
                : null;
            // 先清空容器：宿主反复调用（重渲染 / 插件启用后的补画）时不能越堆越多
            box.innerHTML = '';
            try {
                window.ElainaMods.renderItemSlot('chat.message.actions', box, {
                    message,
                    conversationId: conv ? conv.id : null,
                });
            } catch (e) {
                console.error('[Mod] 消息行动作插槽渲染失败', e);
            }
        }
    }

    // 供 app-04-ui.js 在 renderMessage 之后调用（经典脚本共享全局作用域）
    window.decorateMessageSlots = decorateMessageSlots;

    /** 诊断用：列出宿主挖好的插槽（mod 也可以用 host.slots() 取） */
    window.ElainaHostSlots = {
        names: () => window.ElainaMods.slotNames(),
        decorateMessageSlots,
    };
})();
