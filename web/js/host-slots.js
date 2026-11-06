// 宿主插槽清单：mod 只能往这里挖好的插槽注册；普通插槽注册时挂载一次，spec = { id, ..., render(container, ctx) }。
// 每项级插槽（item: true）必须提供 cleanup(modId) 把已画上的东西立刻摘掉（否则用户关了插件，按钮还留着）；加插槽用 defineSlot('xxx.yyy', containerSlot(…))，但不要顺手新增 host API 方法。

function modSlotCssEscape(id) {
    const s = String(id || '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return s.replace(/[^\w-]/g, (ch) => '\\' + ch);
}

// 跑插件提供的回调（render / onClick / onOpen…）：异常必须停在插槽边界，统一走 ElainaMods.guard（那里按插件错误预算决定停用），拿不到 guard 时本地 try/catch 兜底。
function runModCallback(modId, where, fn, log, fallback) {
    const guard = window.ElainaMods && typeof window.ElainaMods.guard === 'function'
        ? window.ElainaMods.guard : null;
    if (guard) return guard(modId, where, fn, fallback);
    try { return fn(); } catch (e) {
        if (typeof log === 'function') log('error', where + ' 出错（已隔离）', e);
        return fallback;
    }
}

// 「宿主给个容器、mod 往里画」型插槽的通用实现：只摘渲染后新增的节点（打 data-mod），不碰其它 mod 与宿主自己的东西 —— 不用 innerHTML='' 一把清空，同一容器可能挂了多个 mod。
function containerSlot(containerId, note) {
    return {
        note,
        /** 形状由 mod 系统统一校验（见 mods-slots.js 的 validateSlotSpec） */
        spec: { required: ['render'], types: { render: 'function', id: 'string', title: 'string' } },
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
            const added = [];
            let disposed = false;
            const collect = () => {
                for (const el of [...box.children]) {
                    if (before.has(el) || added.includes(el)) continue;
                    added.push(el);
                    if (!el.hasAttribute('data-mod')) el.setAttribute('data-mod', ctx.modId);
                }
            };
            const removeAdded = () => {
                for (const el of added.splice(0)) {
                    try { el.remove(); } catch (e) { /* 忽略 */ }
                }
            };
            const ret = runModCallback(ctx.modId, '插槽 ' + ctx.name + ' 渲染',
                () => spec.render(box, { modId: ctx.modId }), ctx.log);
            collect();
            // render 可以是异步的（插件要先取面板 HTML 才能写 DOM）：只收同步那一刻会漏掉异步追加的节点，等它 settle 再收一次，期间已被停用就立刻摘掉。
            if (ret && typeof ret.then === 'function') {
                const finish = () => {
                    collect();
                    if (disposed) removeAdded();
                };
                ret.then(finish, finish);
            }
            return {
                get el() { return added[0] || null; },
                dispose() {
                    disposed = true;
                    removeAdded();
                },
            };
        },
    };
}

(function () {
    'use strict';

    if (!window.ElainaMods || typeof window.ElainaMods.defineSlot !== 'function') return;

    window.ElainaMods.defineSlot('settings.tabs', {
        note: '设置里的一栏；render 在被点开时才调用',
        // 分栏的三个字段缺一不可：没有 label 的导航项点不到，没有 render 的分栏是空白
        spec: { required: ['id', 'label', 'render'], types: { label: 'string', title: 'string', render: 'function' } },
        mount(spec, ctx) {
            const key = String(spec.id || '').trim();
            if (!key) { ctx.log('error', 'settings.tabs 的分栏需要 id'); return null; }
            const panelId = key.startsWith('tab-') ? key : 'tab-' + key;
            const nav = document.getElementById('settingsTabNav');
            const content = document.getElementById('settingsContent');
            if (!nav || !content) { ctx.log('error', '找不到设置分栏容器，分栏未注册'); return null; }
            // 撞名直接拒绝：强行占位会把宿主原有的同 id 分栏顶掉，用户会以为"设置坏了"而不是"插件有问题"。
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
                runModCallback(ctx.modId, '设置分栏渲染',
                    () => { if (typeof spec.render === 'function') spec.render(panel); }, ctx.log);
            };
            const onTabShown = (ev) => {
                if (ev && ev.detail && ev.detail.name === panelId) renderOnce();
            };
            document.addEventListener('elaina:settings-tab', onTabShown);
            if (btn.classList.contains('active')) renderOnce();

            const teardown = () => {
                // 停用时把这一栏整个拆掉（不是藏起来）；若它正被看着，先切回「外观」，否则内容区空着像"设置面板坏了"。
                if (panel.classList.contains('active-panel') && typeof switchSettingsTab === 'function') {
                    switchSettingsTab('tab-appearance');
                }
                document.removeEventListener('elaina:settings-tab', onTabShown);
                btn.remove();
                panel.remove();
            };

            return {
                el: btn,
                // deactivate（停用）与 dispose（卸载）在这里都是拆掉；差别在 mod 系统那边：停用保留 spec，启用时重新挂载。
                dispose: teardown,
            };
        },
    });

    // settings.modal：插件设置独立成窗，从插件卡片上的齿轮进入；宿主自己的设置仍走 settings.tabs。
    window.ElainaMods.defineSlot('settings.modal', {
        note: '插件设置独立成窗；由插件卡片上的齿轮按钮打开',
        spec: { required: ['id', 'render'], types: { label: 'string', title: 'string', render: 'function', onOpen: 'function', onClose: 'function' } },
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

            // 每个插件各有一个自己的容器（挂在 bodyEl 里）：共用一个会坏 —— 插件首次打开才渲染，渲染第一件事是清空容器，打开 B 会把 A 清掉。
            let paneEl = null;
            let rendered = false;

            const ensurePane = () => {
                if (paneEl && paneEl.isConnected) return paneEl;
                paneEl = document.createElement('div');
                paneEl.className = 'mod-settings-pane';
                paneEl.setAttribute('data-mod-settings-pane', key);
                bodyEl.appendChild(paneEl);
                return paneEl;
            };

            const renderOnce = () => {
                if (rendered) return;
                rendered = true;
                const pane = ensurePane();
                pane.innerHTML = '';
                runModCallback(ctx.modId, '插件设置窗渲染', () => spec.render(pane), ctx.log);
            };

            /** 用自有类 mod-settings-pane-off 而非 Tailwind 的 .hidden：pane 是运行期建的，不该依赖工具类是否被生成，且 display:none 才能让容器不给隐藏块留空隙。 */
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
                overlay.setAttribute('data-mod-settings-id', key);
                openOverlayPanel(overlay);
                runModCallback(ctx.modId, '设置窗打开回调',
                    () => { if (typeof spec.onOpen === 'function') spec.onOpen(paneEl); }, ctx.log);
            };
            // onClose 立刻跑而不是等淡出结束：插件要在里面停计时器/落盘，拖 150ms 等于让它多活一段。
            const close = () => {
                overlay.removeAttribute('data-mod-settings-id');
                runModCallback(ctx.modId, '设置窗关闭回调',
                    () => { if (typeof spec.onClose === 'function') spec.onClose(); }, ctx.log);
                closeOverlayPanel(overlay);
            };

            // 宿主自己的关闭方式（× / 点遮罩 / Esc）一律走这里：各自写一遍隐藏会绕过 close()，spec.onClose 永不触发（插件在 onClose 里保存的设置、停掉的计时器就都没发生）。
            const dismiss = () => {
                const openedId = overlay.getAttribute('data-mod-settings-id');
                // 只在自己这块正开着时才转交给 close()：监听只绑一次、回调都是最先注册的那个，不判 openedId 就会拿 A 的 close 去关 B 的窗口。
                if (openedId === key && window.ElainaMods
                    && typeof window.ElainaMods.closeModSettings === 'function') {
                    window.ElainaMods.closeModSettings(key);   // guardMod 兜住插件异常
                    return;
                }
                overlay.removeAttribute('data-mod-settings-id');
                closeOverlayPanel(overlay);
            };

            if (!overlay.__modSettingsBound) {
                overlay.__modSettingsBound = true;
                document.getElementById('modSettingsClose')?.addEventListener('click', () => dismiss());
                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) dismiss();
                });
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) dismiss();
                });
            }

            // 登记给宿主界面用（插件卡片上的齿轮按 id 打开），走 ElainaMods 统一入口，不往 window 挂私有全局名
            window.ElainaMods.registerSettingsOpener(key, { open, close });

            return {
                el: null,
                open,
                close,
                dispose() {
                    window.ElainaMods.unregisterSettingsOpener(key);
                    if (overlay.getAttribute('data-mod-settings-id') === key) close();
                    try { if (paneEl && paneEl.isConnected) paneEl.remove(); } catch (e) { /* 忽略 */ }
                    paneEl = null;
                    rendered = false;
                },
            };
        },
    });

    // header.actions：顶部栏的一个按钮；样式沿用宿主的 header-memory-btn。
    window.ElainaMods.defineSlot('header.actions', {
        note: '顶部栏的一个按钮；spec 里给 label / svg / onClick',
        spec: { required: ['id', 'onClick'], types: { label: 'string', title: 'string', svg: 'string', onClick: 'function' } },
        mount(spec, ctx) {
            const slot = document.getElementById('headerModSlot');
            if (!slot) { ctx.log('error', '找不到顶部按钮挂载点，按钮未注册'); return null; }

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'header-memory-btn';
            const shortId = String(spec.id || '');
            if (shortId) btn.id = 'mod-header-' + ctx.modId + '-' + shortId;
            if (spec.title) btn.title = String(spec.title);
            // 图标用 innerHTML（mod 本来就能执行任意 JS，不引入新的信任面），但文字走 textContent。
            if (spec.svg) btn.innerHTML = String(spec.svg);
            if (spec.label) {
                const span = document.createElement('span');
                span.textContent = String(spec.label);
                btn.appendChild(span);
            }
            if (typeof spec.onClick === 'function') {
                btn.addEventListener('click', (ev) => {
                    // 点击处理是插件代码：抛错不能让宿主的事件分发中断。
                    runModCallback(ctx.modId, '顶部按钮点击', () => spec.onClick(ev), ctx.log);
                });
            }
            slot.appendChild(btn);

            return { el: btn, dispose() { btn.remove(); } };
        },
    });

    window.ElainaMods.defineSlot('sidebar.footer', containerSlot('sidebarModSlot', '侧栏底部的一块区域'));

    // composer.actions —— 输入框那一行（文本输入与麦克风/发送之间）；容器 display:contents，插件元素直接参与该行 flex 布局
    window.ElainaMods.defineSlot('composer.actions', containerSlot('composerModSlot', '输入框那一行的按钮位'));

    // chat.message.actions —— 每条消息的标题行（每项级：注册时挂不了任何东西）
    window.ElainaMods.defineSlot('chat.message.actions', {
        item: true,
        note: '每条消息标题行上的按钮；render(container, { message, conversationId })',
        spec: { required: ['id', 'render'], types: { render: 'function' } },
        cleanup(modId) {
            // 停用/卸载：把该 mod 已经画上去的按钮立刻摘掉，否则用户关了插件，消息行里还留着点了没反应的按钮。
            const sel = '.message-slot-actions > [data-mod="' + modSlotCssEscape(modId) + '"]';
            document.querySelectorAll(sel).forEach((el) => { try { el.remove(); } catch (e) { /* 忽略 */ } });
        },
        refresh() {
            // 启用：把界面上**已经存在**的消息行补画一遍（不重排消息、不动滚动位置）
            decorateMessageSlots(document);
        },
    });

    // 宿主渲染完消息后调用它 —— 由宿主"推"而不是让 mod 自己监听：mod 去 MutationObserver 或改写 renderMessage 就会绕过宿主的增量渲染。
    function decorateMessageSlots(root) {
        if (!root || !root.querySelectorAll) return;
        if (!window.ElainaMods || typeof window.ElainaMods.renderItemSlot !== 'function') return;
        let boxes = [];
        try { boxes = [...root.querySelectorAll('.message-slot-actions')]; } catch (e) { return; }
        if (!boxes.length) return;

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
            // 每个插件的 render 在 renderItemSlot 里已各自隔离；这里兜的是宿主这一侧的准备动作出错。
            try {
                window.ElainaMods.renderItemSlot('chat.message.actions', box, {
                    message,
                    conversationId: conv ? conv.id : null,
                });
            } catch (e) {
                console.error('[Mod] 消息行动作插槽渲染失败（已隔离）', e);
            }
        }
    }

    window.decorateMessageSlots = decorateMessageSlots;

    window.ElainaHostSlots = {
        names: () => window.ElainaMods.slotNames(),
        decorateMessageSlots,
    };
})();
