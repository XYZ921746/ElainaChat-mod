// 拖拽排序内核：FLIP 动画 + 跨容器占位块；设置页与插件页共用同一实现（window.__elainaBindFlatDragSort）。
(function () {
    'use strict';

/** 按下时的几何快照：同层其它项按「行 → 列」摊平成阅读顺序，供落点判定。 */
function buildFlatDragSnapshot(parent, card, itemSel) {
    const others = [];
    for (const el of parent.children) {
        if (el === card || !el.matches || !el.matches(itemSel)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        others.push({ el, left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    }
    const rows = [];
    for (const it of others.slice().sort((a, b) => a.cy - b.cy || a.left - b.left)) {
        const row = rows.find((rw) => Math.abs(rw.cy - it.cy) <= Math.max(8, it.height / 2));
        if (row) row.items.push(it); else rows.push({ cy: it.cy, items: [it] });
    }
    rows.forEach((rw) => rw.items.sort((a, b) => a.left - b.left));
    const flat = [];
    rows.forEach((rw) => { rw.start = flat.length; rw.items.forEach((it) => flat.push(it)); });
    return { rows, flat };
}

function flatDragIdOf(el, idAttr) {
    if (idAttr) return el.getAttribute(idAttr) || '';
    return el.getAttribute('data-model-name') || el.getAttribute('data-mod-id') || '';
}

/** FLIP：改动布局前后测量，用 transform 把位移演回去；跨容器搬家时对旧容器再调一次，否则另一边的项会瞬移。 */
function flipDragLayout(scope, mutate, drag, itemSel, placeholderClass) {
    const items = [...scope.querySelectorAll(itemSel + ', .' + placeholderClass)];
    const first = new Map();
    for (const el of items) first.set(el, el.getBoundingClientRect());
    const phRect = drag && drag.ph ? drag.ph.getBoundingClientRect() : null;
    mutate();
    for (const [el, r] of first) {
        if (!el.isConnected) continue;
        const now = el.getBoundingClientRect();
        const dx = r.left - now.left;
        const dy = r.top - now.top;
        if (!dx && !dy) continue;
        el.style.transition = 'none';
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        requestAnimationFrame(() => {
            el.style.transition = 'transform .18s cubic-bezier(.2,.8,.3,1)';
            el.style.transform = '';
            setTimeout(() => { el.style.transition = ''; }, 220);
        });
    }
    if (phRect && drag && drag.ph.isConnected) {
        const nowP = drag.ph.getBoundingClientRect();
        const dx = phRect.left - nowP.left;
        const dy = phRect.top - nowP.top;
        if (dx || dy) {
            drag.ph.style.transition = 'none';
            drag.ph.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
            requestAnimationFrame(() => {
                drag.ph.style.transition = 'transform .18s cubic-bezier(.2,.8,.3,1)';
                drag.ph.style.transform = '';
                setTimeout(() => { drag.ph.style.transition = ''; }, 220);
            });
        }
    }
}

/** 落点 = 卡片自身走到哪一格（按下时快照，不看实时布局）；返回占位块要插到谁之前。 */
function pickDragInsertTarget(snap, rect, card, ph) {
    if (snap && snap.rows.length) {
        const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(card.style.transform || '');
        const dx = m ? parseFloat(m[1]) : 0;
        const dy = m ? parseFloat(m[2]) : 0;
        const cx = rect.left + rect.width / 2 + dx;
        const cy = rect.top + rect.height / 2 + dy;
        let row = snap.rows[0];
        let bestD = Infinity;
        for (const rw of snap.rows) {
            const d = Math.abs(rw.cy - cy);
            if (d < bestD) { bestD = d; row = rw; }
        }
        let col = 0;
        while (col < row.items.length && row.items[col].cx < cx) col++;
        const want = row.start + col;
        return snap.flat[want] ? snap.flat[want].el : null;
    }
    return ph.nextElementSibling;
}

/** 指针进出父容器的滞回判定（纵向 24px、横向 0）：返回本次应使用的容器。 */
function computeActiveParent(e, pr, outer, parent, lastParent, hoverBand) {
    const outsideX = e.clientX < pr.left || e.clientX > pr.right;
    let useOuter;
    if (lastParent === outer) {
        useOuter = outsideX
            || !(e.clientY > pr.top + hoverBand && e.clientY < pr.bottom - hoverBand);
    } else {
        useOuter = outsideX || e.clientY < pr.top - hoverBand || e.clientY > pr.bottom + hoverBand;
    }
    return (useOuter && outer) ? outer : parent;
}

/** 把拖拽中的卡片从 fixed 状态放回占位块的位置，并还原被临时清掉的面板 transform。 */
function restoreDraggedCard(card, ph, parent, draggingClass, panel, panelTransform, panelFillMode) {
    const phParent = ph.parentElement || parent;
    card.style.transition = '';
    card.style.transform = '';
    card.style.transformOrigin = '';   // 别把抓取点的原点留给卡片常态
    card.style.left = '';
    card.style.top = '';
    card.style.width = '';
    card.style.height = '';
    card.classList.remove(draggingClass);
    phParent.insertBefore(card, ph);
    ph.remove();
    document.body.classList.remove('mod-dragging-active');
    if (panel) {
        if (panelTransform && panelTransform.value) {
            panel.style.setProperty('transform', panelTransform.value, panelTransform.priority);
        } else {
            panel.style.removeProperty('transform');
        }
        if (panelFillMode && panelFillMode.value) {
            panel.style.setProperty('animation-fill-mode', panelFillMode.value, panelFillMode.priority);
        } else {
            panel.style.removeProperty('animation-fill-mode');
        }
    }
}

    function bindFlatDragSort(container, onDone, options) {
        if (!container) return () => {};
        // opts：分栏（.mod-group）拖拽复用同一套内核 —— 它的「项」是分栏，把手是整个分栏头。
        const opts = options || {};
        const ITEM_SEL = opts.itemSelector || '.mod-card';
        const HANDLE_SEL = opts.handleSelector || '.mod-grip';
        const ID_ATTR = opts.idAttr || null;              // null = 自动（先 data-model-name 后 data-mod-id）
        const PLACEHOLDER_CLASS = opts.placeholderClass || 'mod-placeholder';
        const DRAGGING_CLASS = opts.draggingClass || 'mod-dragging';
        // 外层容器的项选择器：拖出父容器后插入点候选按它选 —— 插件分栏场景要含平铺卡片，否则分栏永远插不到卡片之间。
        const OUTER_ITEM_SEL = opts.outerItemSelector || ITEM_SEL;
        // 顶层混排：项就在 container 顶层（分栏与卡片混排），插入点始终用 OUTER_ITEM_SEL，不需要「逃逸」判定。
        const TOP_MIXED = Boolean(opts.topLevelMixed);
        const handlers = [];
        let drag = null;
        // 拖拽中「项」的真实父容器（pointerdown 时确定）：分栏渲染后卡片住在 .mod-group-body，排序范围、占位块、FLIP 测量都限定在这一层。
        let parent = null;
        let outer = opts.outerContainer || null;

        container.querySelectorAll(HANDLE_SEL).forEach((grip) => {
            const onDown = (ev) => {
                if (drag) return;
                const card = grip.closest(ITEM_SEL);
                if (!card) return;
                if (ev.button != null && ev.button !== 0) return;
                // 调用方否决：把手可能同时是别的控件（如分栏头还是折叠开关），canStart 返回 false 表示这次按下不进拖拽。
                if (typeof opts.canStart === 'function' && !opts.canStart(ev)) return;
                ev.preventDefault();
                // 记录手势是否移动过 + 起点，配合 opts.onTap 实现「没动就松手 = 单击」：preventDefault 吞掉了 click。
                const downX = ev.clientX, downY = ev.clientY;
                let moved = false;

                const rect = card.getBoundingClientRect();
                // 占位块要插在卡片腾出的位置，父容器取 card.parentElement：分栏渲染后卡片不在 container 下，insertBefore 会抛 not a child 错误。
                parent = card.parentElement;
                const ph = document.createElement('div');
                ph.className = PLACEHOLDER_CLASS;
                ph.style.height = rect.height + 'px';
                parent.insertBefore(ph, card);
                // 卡片改成 fixed 跟随指针（记住原屏幕位置，否则会跳到左上角）
                card.style.width = rect.width + 'px';
                card.style.height = rect.height + 'px';
                card.style.left = rect.left + 'px';
                card.style.top = rect.top + 'px';
                card.classList.add(DRAGGING_CLASS);
                // 卡片留在原 DOM 里（保住 CSS 上下文），只临时清掉设置面板的 transform：有 transform 的祖先会成为 fixed 的包含块，卡片会被 overflow:hidden 裁掉。
                const panel = card.closest('.modal-panel');
                const panelTransform = panel ? {
                    value: panel.style.getPropertyValue('transform'),
                    priority: panel.style.getPropertyPriority('transform'),
                } : null;
                // 入场动画带 fill-mode:both，结束帧的 identity matrix 照样成为包含块；只临时关掉 fill-mode、不动 animation（设成 none 再还原会从头重播动画）。
                const panelFillMode = panel ? {
                    value: panel.style.getPropertyValue('animation-fill-mode'),
                    priority: panel.style.getPropertyPriority('animation-fill-mode'),
                } : null;
                if (panel) {
                    panel.style.setProperty('transform', 'none', 'important');
                    panel.style.setProperty('animation-fill-mode', 'none', 'important');
                }
                // 停掉动画后包含块可能仍有残余偏移，按实际位置校正一次。
                const fixedRect = card.getBoundingClientRect();
                const offX = rect.left - fixedRect.left;
                const offY = rect.top - fixedRect.top;
                if (offX || offY) {
                    card.style.left = (rect.left + offX) + 'px';
                    card.style.top = (rect.top + offY) + 'px';
                }
                document.body.classList.add('mod-dragging-active');
                try { grip.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }

                drag = {
                    card, ph, grip, panel, panelTransform, panelFillMode,
                    originRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                    // 抓取点相对卡片左上角的偏移：拖动时保持不变，卡片才不会在按下的瞬间跳到指针下方。
                    grabDX: ev.clientX - rect.left,
                    grabDY: ev.clientY - rect.top,
                    lastBefore: card,
                    swapTarget: null,
                    lastParent: null,
                    prCache: null,
                };
                drag.prCache = parent.getBoundingClientRect();
                drag.snap = buildFlatDragSnapshot(parent, card, ITEM_SEL);

                setTf(0, 0);

                const onMove = (e) => {
                    if (!drag) return;
                    if (!moved && (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5)) {
                        moved = true;
                    }
                    const dx = e.clientX - rect.left - drag.grabDX;
                    const dy = e.clientY - rect.top - drag.grabDY;
                    setTf(dx, dy);

                    // 读卡片位置前必须让浏览器落一次布局：刚写的内联 transform 可能还没反映到 getBoundingClientRect（卡片中心落后一帧会换位晚）。
                    void card.offsetWidth;

                    // 插入点候选：TOP_MIXED 始终用 OUTER_ITEM_SEL；有外层容器时指针移出父容器则把占位块提升到外层。滞回带 24px（进出用不同边界）避免指针在边缘来回 1px 时每帧搬家 + FLIP 全量重测。
                    const HOVER_BAND = 24;
                    if (!drag.prCache) drag.prCache = parent.getBoundingClientRect();
                    const pr = drag.prCache;
                    // 纵向滞回 24px、横向 0：宽屏下是多列网格，指针横向离开通常正是想拖到别的列，多点 24px 只会「往右拖没反应」。
                    const activeParent = computeActiveParent(e, pr, outer, parent, drag.lastParent, HOVER_BAND);

                    // 落点用按下时的快照算（不看指针、不看实时布局）：按指针判会让两个方向行程不等，快照固定后目标格只随卡片位移单调变化；命中判据是 3/5 线而不是中线。
                    const phNext = pickDragInsertTarget(drag.snap, rect, card, drag.ph);
                    if (phNext === drag.lastBefore && activeParent === drag.lastParent) return;
                    drag.lastBefore = phNext;
                    drag.lastParent = activeParent;
                    // 跨容器搬家：旧容器也要 FLIP 补偿（否则它里面的项瞬移）
                    const oldParent = drag.ph.parentElement;
                    // 只用「插到目标之前」一种动作：拖动项占住目标的格子、目标顺延向后，与「两者互换」的观感一致。
                    flipDragLayout(activeParent, () => {
                        if (phNext && phNext !== drag.ph) activeParent.insertBefore(drag.ph, phNext);
                        else if (!phNext) activeParent.appendChild(drag.ph);
                    }, drag, ITEM_SEL, PLACEHOLDER_CLASS);
                    if (oldParent !== activeParent && oldParent !== drag.ph.parentElement) {
                        flipDragLayout(oldParent, () => { /* 占位块已搬走 —— 只补偿留在旧容器的项 */ },
                            drag, ITEM_SEL, PLACEHOLDER_CLASS);
                    }
                };

                function setTf(dx, dy) {
                    const c = drag ? drag.card : card;
                    c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
                }
                const finish = (commit) => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                    document.removeEventListener('pointercancel', onCancel);
                    // 必须带上 capture:true —— removeEventListener 要求捕获标志与回调都对得上；漏了这个参数就摘不掉，那个 once 监听器会残留在 document 上，之后每次 Escape 都被它拦掉，插件设置弹窗再也关不上。
                    document.removeEventListener('keydown', onKey, { capture: true });
                    if (!drag) return;
                    const { card: c, ph, panel, panelTransform, panelFillMode } = drag;
                    const restore = () => restoreDraggedCard(c, ph, parent, DRAGGING_CLASS, panel, panelTransform, panelFillMode);
                    if (commit) {
                        if (!moved) {
                            restore();
                            if (typeof opts.onTap === 'function') opts.onTap(card);
                            drag = null;
                            return;
                        }
                        const target = ph.getBoundingClientRect();
                        const dx = target.left - rect.left;
                        const dy = target.top - rect.top;
                        c.style.transition = 'transform .18s cubic-bezier(.2,.8,.3,1)';
                        c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
                        setTimeout(() => {
                            restore();
                            if (typeof onDone === 'function') {
                                const ids = [...container.querySelectorAll(ITEM_SEL)].map((el) => flatDragIdOf(el, ID_ATTR));
                                onDone(ids, container);
                            }
                        }, 190);
                    } else {
                        restore();
                    }
                    drag = null;
                };
                const onUp = () => finish(true);
                const onCancel = () => finish(false);
                /** Esc 取消拖动。必须挂捕获阶段并抢在宿主前面消费：宿主也监听 Escape，冒泡顺序下会把设置弹窗一起关掉。 */
                const onKey = (e) => {
                    if (e.key !== 'Escape') return;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    e.stopPropagation();
                    finish(false);
                };

                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
                document.addEventListener('pointercancel', onCancel);
                document.addEventListener('keydown', onKey, { once: true, capture: true });
            };
            grip.addEventListener('pointerdown', onDown);
            handlers.push([grip, onDown]);
        });

        return () => { for (const [el, fn] of handlers) el.removeEventListener('pointerdown', fn); };
    }

    // 设置页与插件页共用这一份：分两份拷贝会一边修好另一边还是坏的；设置页先加载，所以用的时候才来取这个全局。
    window.__elainaBindFlatDragSort = bindFlatDragSort;

    window.ElainaModsDragSort = { bindFlatDragSort };
})();
