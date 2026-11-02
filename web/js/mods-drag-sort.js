/* ============================================================================
 * 插件系统 —— 拖拽排序内核
 *
 * 从 mods.js 拆出：FLIP 动画、跨容器占位块、毫秒级手感细节。
 * 设置页与插件页共用同一份实现（window.__elainaBindFlatDragSort）。
 * ========================================================================== */
(function () {
    'use strict';

/** 按下时的几何快照：把同层其它项按"行 → 列"摊平成阅读顺序，供落点判定用。 */
function buildFlatDragSnapshot(parent, card, itemSel) {
    const others = [];
    for (const el of parent.children) {
        if (el === card || !el.matches || !el.matches(itemSel)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        others.push({ el, left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    }
    // 按"行"分组（纵向中心相近算同一行），行内按 x 排；再摊平成阅读顺序
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

/** 拖拽项 id：优先指定属性，否则先 data-model-name 后 data-mod-id。 */
function flatDragIdOf(el, idAttr) {
    if (idAttr) return el.getAttribute(idAttr) || '';
    return el.getAttribute('data-model-name') || el.getAttribute('data-mod-id') || '';
}

/** FLIP：改动布局前后测量，用 transform 把位移"演"回去。
 *  scope = 布局被改动的容器。跨容器搬家时对**旧容器**再调一次，
 *  两边的项都得到位移补偿（否则另一边的项会瞬移，动画"消失"）。 */
function flipDragLayout(scope, mutate, drag, itemSel, placeholderClass) {
    const items = [...scope.querySelectorAll(itemSel + ', .' + placeholderClass)];
    const first = new Map();
    for (const el of items) first.set(el, el.getBoundingClientRect());
    // 跨容器：占位块自身的旧屏幕位置也记下（它要从那里"飞"到新家）
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
            // 动画结束后摘掉内联 transition：否则它会一直盖住 .mod-card 的
            //   hover 过渡，下一次拖拽前的悬停/换位手感就变了。
            setTimeout(() => { el.style.transition = ''; }, 220);
        });
    }
    // 占位块跨容器：从旧位置演到新位置（否则它瞬移 —— "动画消失"的观感来源）
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
        // 卡片当前中心 = 按下时的矩形 + 内联 transform 的位移
        const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(card.style.transform || '');
        const dx = m ? parseFloat(m[1]) : 0;
        const dy = m ? parseFloat(m[2]) : 0;
        const cx = rect.left + rect.width / 2 + dx;
        const cy = rect.top + rect.height / 2 + dy;
        // ① 落在哪一行：取纵向最近的一行（拖到列表外也能落到首行/末行）
        let row = snap.rows[0];
        let bestD = Infinity;
        for (const rw of snap.rows) {
            const d = Math.abs(rw.cy - cy);
            if (d < bestD) { bestD = d; row = rw; }
        }
        // ② 该行里的第几列：卡片中心越过某张卡的中心才算越过它
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
        // 已在外层：只有缩回父容器边界内才回去
        useOuter = outsideX
            || !(e.clientY > pr.top + hoverBand && e.clientY < pr.bottom - hoverBand);
    } else {
        // 在父容器内：越出边界（横向任意，纵向 24px）才出去
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
    // 回到占位块的位置（占位块在哪个容器就插回哪里）
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
        // 可配置项：分栏（.mod-group）的拖拽也复用这套内核 —— 它的"项"是分栏
        //   而不是卡片，把手是整个分栏头而不是三条竖线。选项不给时用卡片默认值。
        const opts = options || {};
        const ITEM_SEL = opts.itemSelector || '.mod-card';
        const HANDLE_SEL = opts.handleSelector || '.mod-grip';
        const ID_ATTR = opts.idAttr || null;              // null = 自动（先 data-model-name 后 data-mod-id）
        const PLACEHOLDER_CLASS = opts.placeholderClass || 'mod-placeholder';
        const DRAGGING_CLASS = opts.draggingClass || 'mod-dragging';
        // 外层容器的项选择器（可选）：拖出父容器后，插入点候选按这个选。
        //   插件分栏场景：拖分栏到顶层时，候选要**包含平铺卡片**——否则分栏只能
        //   插到其它分栏前面，永远到不了卡片之间（"分栏拖不到卡片上面"的根因）。
        const OUTER_ITEM_SEL = opts.outerItemSelector || ITEM_SEL;
        // 顶层混排模式：项本身就在 container 顶层（分栏与卡片混排），
        //   插入点候选**始终**用 OUTER_ITEM_SEL（含两类项）—— 不需要"逃逸"判定。
        const TOP_MIXED = Boolean(opts.topLevelMixed);
        // 拖拽时挂在"项"上的类由 CSS 定义（.mod-card.mod-dragging / .mod-group.mod-dragging）
        const handlers = [];
        let drag = null;
        // 拖拽中的"项"所在的**真实父容器**（pointerdown 时确定）。
        //   不能假设调用方传的 container 就是项的父级：分栏渲染后卡片住在
        //   .mod-group-body 里，container 是更外层的 #modsList。排序范围、
        //   占位块、FLIP 测量都应限定在这一层（跨分栏的移动是上层的职责）。
        let parent = null;
        // "逃逸"容器：项被拖出父容器范围时的落脚点（outerContainer 选项）。
        //   例如卡片从分栏体拖出到 #modsList 顶层 —— 没有它，放进去的拿不出来。
        let outer = opts.outerContainer || null;

        container.querySelectorAll(HANDLE_SEL).forEach((grip) => {
            const onDown = (ev) => {
                if (drag) return;
                const card = grip.closest(ITEM_SEL);
                if (!card) return;
                // 只认主键 / 触摸：右键、中键拖动不该触发排序
                if (ev.button != null && ev.button !== 0) return;
                // 调用方否决：把手可能同时是别的控件（如分栏头还是折叠开关），
                //   canStart 返回 false 表示"这次按下不进拖拽"（调用方已自行处理语义）。
                if (typeof opts.canStart === 'function' && !opts.canStart(ev)) return;
                ev.preventDefault();
                // 记录手势是否移动过 + 起点：配合 opts.onTap 实现"没动就松手 = 单击"。
                //   preventDefault 吞掉了 click，调用方只能从这里拿单击语义。
                const downX = ev.clientX, downY = ev.clientY;
                let moved = false;

                const rect = card.getBoundingClientRect();
                // 卡片的**真实父容器**：占位块要插到卡片原来的位置，
                //   即卡片自己的 parentElement 里 —— 不能假设调用方传的 container
                //   就是卡片的父级。分栏渲染后卡片住在 .mod-group-body 里，
                //   而 container 是更外层的 #modsList；这时 insertBefore(ph, card)
                //   会抛 "not a child of this node"。
                //   排序的目标范围也跟着取真实父容器 —— 拖拽排序本来就是
                //   "在同一层里换位置"，跨分栏的移动由上层（归类拖拽）负责。
                parent = card.parentElement;
                const ph = document.createElement('div');
                ph.className = PLACEHOLDER_CLASS;
                ph.style.height = rect.height + 'px';
                parent.insertBefore(ph, card);
                // ② 卡片改成 fixed 跟随指针（记住原屏幕位置，否则会跳到左上角）
                card.style.width = rect.width + 'px';
                card.style.height = rect.height + 'px';
                card.style.left = rect.left + 'px';
                card.style.top = rect.top + 'px';
                card.classList.add(DRAGGING_CLASS);
                // 卡片留在原 DOM 里（保持 #settingsContent / #tab-mods 的 CSS 上下文），
                //   只把设置面板的 transform 临时清掉：有 transform 的祖先会成为
                //   position:fixed 的包含块，卡片就会被面板的 overflow:hidden 裁掉。
                const panel = card.closest('.modal-panel');
                const panelTransform = panel ? {
                    value: panel.style.getPropertyValue('transform'),
                    priority: panel.style.getPropertyPriority('transform'),
                } : null;
                // 面板的入场动画带 fill-mode:both，结束帧的 transform 仍是 identity matrix
                //   —— 它照样会成为 position:fixed 的包含块（卡片坐标会整体偏移）。
                //   只临时关掉 fill-mode（不要动 animation 本身）：把 animation 设成 none
                //   再还原会让浏览器从头重播一遍入场动画 —— 表现就是"拖完设置闪一下"。
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
                    // 按下时卡片在屏幕上的位置：判断"指针是否还在原处"用（不能用占位块当前位置）
                    originRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                    // 抓取点相对卡片左上角的偏移。拖动时保持不变，
                    //   卡片才不会在按下的瞬间"跳"到指针下方（桌面图标的手感）。
                    grabDX: ev.clientX - rect.left,
                    grabDY: ev.clientY - rect.top,
                    // 上一次的落点，用于判断占位块要不要挪（否则每帧都触发 FLIP）
                    lastBefore: card,
                    swapTarget: null,
                    lastParent: null,
                    // 父容器 rect 缓存：拖动中滚动/结构不变，无需每帧重测
                    //   （每帧 getBoundingClientRect 是"经过分栏变卡"的元凶之一）。
                    prCache: null,
                };
                drag.prCache = parent.getBoundingClientRect();
                // ── 落点判据用的"按下时快照"（见 onMove 里的说明）──────────────
                drag.snap = buildFlatDragSnapshot(parent, card, ITEM_SEL);

                // 抬起感只靠阴影（CSS .mod-dragging），不改尺寸：
                //   缩放会让卡片比拖拽前大一圈，用户会以为"拖完第一张变大了"。
                setTf(0, 0);

                const onMove = (e) => {
                    if (!drag) return;
                    // 记录"动过"：移出 5px 即视为拖拽（供 onTap 判单击用）
                    if (!moved && (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5)) {
                        moved = true;
                    }
                    // 二维跟手：抓在哪就一直在哪。只写 translateY 的话横向拖动
                    //   时卡片横向不动，看起来就是"不跟手"。
                    const dx = e.clientX - rect.left - drag.grabDX;
                    const dy = e.clientY - rect.top - drag.grabDY;
                    setTf(dx, dy);

                    // ★ 读卡片现在的位置之前必须让浏览器**落一次布局**：
                    //   上面刚写了内联 transform，但同一帧内 getBoundingClientRect 返回的
                    //   可能仍是旧位置（实测：卡片中心比指针落后一帧，导致换位晚、且左右不等）。
                    void card.offsetWidth;

                    // 插入点判定分两种（都排除拖动中的项自身）：
                    //   a) TOP_MIXED 模式（项在 container 顶层混排，如分栏拖动）：
                    //      候选**始终**用 OUTER_ITEM_SEL —— 卡片与分栏同等级，
                    //      分栏可以插到任何卡片之间（用户要求）。
                    //   b) 有外层容器：指针移出父容器范围 → 占位块提升到外层；
                    //      指针回到父容器范围 → 降级回栏内。
                    //   c) 其余：候选限定在真实父容器内（普通栏内排序）。
                    // 滞回带（hysteresis）24px：进出外层用**不同的边界** ——
                    //   走出去要越出边界 24px，走回来要缩进边界内 24px。
                    //   没有滞回时指针在分栏边缘来回 1px 都会翻转 activeParent，
                    //   占位块每帧在两个容器间搬家 + FLIP 全量重测 —— 这就是
                    //   "经过分栏时明显变卡"的根因（每帧两次强制布局）。
                    const HOVER_BAND = 24;
                    if (!drag.prCache) drag.prCache = parent.getBoundingClientRect();
                    const pr = drag.prCache;
                    // 纵向滞回 24px，横向 0：列表宽屏下是**多列网格**，指针横向离开容器
                    //   通常正是想拖到别的列 / 另一个容器，多点 24px 只会让"往右拖没反应"。
                    const activeParent = computeActiveParent(e, pr, outer, parent, drag.lastParent, HOVER_BAND);

                    // 多列时按"导航顺序"找插入点：把候选排成阅读顺序（行 → 列），
                    //   落点在**当前占位**之前的第一个候选之后插。
                    //   为什么不再"命中项 A 就插到 A 前面"：那样必须把指针挪进某张卡的
                    //   左半边才会换位 —— 用户说"拖到上一个插件待的地方就该换"。改成
                    //   几何判据后，**指针进入某张卡的范围，占位块就落到那张卡原来的位置**，
                    //   被顶开的卡自己让位（FLIP 平滑移过去）。
                    //   指针在卡片左右两侧的空白里时，仍按中线归到相邻的一张 —— 不会跳。
                    // 插入点：**统一按阅读顺序**（多列时行→列，单列时就是纵向）遍历，
                    //   命中判据是"指针在它的 3/5 线之前"。
                    //
                    //   为什么是 3/5 而不是 1/2（用户要求）：中线要拖到卡片正中才会换位，
                    //   手感"按下去一半才开始动"；提前到 3/5 处，只要挪到上一张卡片的
                    //   大部分区域就已经开始让位，拖起来更跟手。
                    //   多列时先按"行"聚合（同一行内的项按 x 排序），这样换位是二维的：
                    //   指针进入某一行的范围，就是和这一行里的那张比。
                    // 落点 = **卡片自身走到哪一格**，用按下时的快照算（不看指针、不看实时布局）。
                    //   为什么按卡片而不按指针：抓取点常在左上角的把手上，与卡片中心差出半个卡宽；
                    //   按指针判时同一段指针位移在两个方向上对应的卡片位移不等（一边"太灵敏"、
                    //   一边"太钝"）。用卡片中心判，左右各走半格才换，两个方向行程一致。
                    //   为什么用快照：换位动画进行中其它卡片的 rect 会短暂交叉/重合，
                    //   拿实时 rect 判会来回跳；快照在按下那一刻固定，目标格只随卡片位移单调变化。
                    const phNext = pickDragInsertTarget(drag.snap, rect, card, drag.ph);
                    if (phNext === drag.lastBefore && activeParent === drag.lastParent) return;
                    drag.lastBefore = phNext;
                    drag.lastParent = activeParent;
                    // 跨容器搬家：旧容器也要 FLIP 补偿（否则它里面的项瞬移）
                    const oldParent = drag.ph.parentElement;
                    // 这里只用"插到目标之前"一种动作：拖动项占住目标的格子、目标顺延向后，
                    // 与"两者互换"的观感一致，且不会与内核的落位逻辑打架。
                    //   （曾经试图显式对调两个节点，结果是顺序错一步就退化成原地不动。）
                    flipDragLayout(activeParent, () => {
                        // 只把占位块插到目标之前 —— 网格里其它卡片由 FLIP 平滑让位，
                        //   连续相邻地跨格，观感就是"和旁边那张换"。
                        if (phNext && phNext !== drag.ph) activeParent.insertBefore(drag.ph, phNext);
                        else if (!phNext) activeParent.appendChild(drag.ph);
                    }, drag, ITEM_SEL, PLACEHOLDER_CLASS);
                    if (oldParent !== activeParent && oldParent !== drag.ph.parentElement) {
                        flipDragLayout(oldParent, () => { /* 占位块已搬走 —— 只补偿留在旧容器的项 */ },
                            drag, ITEM_SEL, PLACEHOLDER_CLASS);
                    }
                };

                /** 写内联 transform：只做位移，不改尺寸（抬起感由 CSS 阴影承担）。 */
                function setTf(dx, dy) {
                    const c = drag ? drag.card : card;
                    c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
                }
                const finish = (commit) => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                    document.removeEventListener('pointercancel', onCancel);
                    // 必须带上 capture:true —— removeEventListener 要求
                    //   "捕获标志 + 回调"都对得上才算同一个监听器。
                    //   漏了这个参数就摘不掉：拖拽用鼠标松手结束时（不走 Esc 分支），
                    //   那个 once 监听器会**残留**在 document 上，之后每一次 Escape
                    //   都被它拦掉 —— 用户会发现**插件设置弹窗再也关不上了**。
                    //   （once 只在它真的被触发时才自动摘除，不能指望它兜底。）
                    document.removeEventListener('keydown', onKey, { capture: true });
                    if (!drag) return;
                    const { card: c, ph, panel, panelTransform, panelFillMode } = drag;
                    // 占位块此刻可能已被"拖出分栏"搬进外层容器 —— 还原/落位
                    //   都要跟着占位块**现在的**父节点走，不能用固定的 parent。
                    const restore = () => restoreDraggedCard(c, ph, parent, DRAGGING_CLASS, panel, panelTransform, panelFillMode);
                    if (commit) {
                        // 没动过 = 单击手势：报告给调用方（它可能有"点把手"的语义，
                        //   如分栏头的单击切折叠），同时顺序没变，无需 onDone 重排。
                        if (!moved) {
                            restore();
                            if (typeof opts.onTap === 'function') opts.onTap(card);
                            drag = null;
                            return;
                        }
                        // 松手：把卡片平滑"放"到占位块上，落位后再换回文档流。
                        // 位移是相对 **left/top 基准**算的，不是相对当前位置：
                        //   卡片是 fixed + left/top=抓取时的屏幕位置，内联 transform
                        //   是相对那个基准的偏移。所以目标偏移 =
                        //   占位块位置 − 基准位置。
                        //   （不能拿"当前位置"再叠加 —— getBoundingClientRect 已经
                        //    含了 transform，再加一次就飞过头。）
                        // 不写 scale：让卡片从"抬起的 1.03"自己落回 1.0，
                        //   读起来就是"把图标放下"。
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
                /**
                 * Esc 取消拖动。
                 *
                 * 为什么要抢在宿主前面：宿主在**弹窗**上也监听 Escape
                 *   （host-slots.js 的插件设置弹窗、init.js 的各种弹窗），
                 *   一条 Escape 会同时触发两个处理器 —— 用户"想取消拖动"却把整个
                 *   设置弹窗关掉了，拖拽上下文一起丢（弹窗 hidden 之后卡片测量全部落空）。
                 *
                 * 关键是**捕获阶段**（第三个参数 true）：宿主的监听器挂在
                 *   document 的冒泡阶段，我如果也挂冒泡，会按注册顺序执行 ——
                 *   宿主在打开弹窗时就注册了，一定比我早，我根本拦不住。
                 *   挂捕获阶段则在事件下行途中就先拿到它，此时
                 *   stopImmediatePropagation 能阻止同一节点上的其余监听器，
                 *   stopPropagation 阻止它继续冒泡回 document → 宿主收不到。
                 *   （拖动是一层更内层的临时状态，它先消费这个按键才对。）
                 *
                 * finish(false) 会把这个监听器摘掉，所以下一次 Esc 一切正常。
                 */
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
                // 捕获阶段（true）—— 见 onKey 的说明，必须抢在宿主前面消费掉 Escape
                document.addEventListener('keydown', onKey, { once: true, capture: true });
            };
            grip.addEventListener('pointerdown', onDown);
            handlers.push([grip, onDown]);
        });

        return () => { for (const [el, fn] of handlers) el.removeEventListener('pointerdown', fn); };
    }

    // 给设置页（settings.js）复用同一份实现 —— 插件列表与模型列表的拖拽
    // 本来就是同一件事。
    // 为什么必须共用：分成两份拷贝的结果就是这次踩的坑 —— 一边修了"卡片被弹窗
    //   盖住"、另一边还是坏的；手感也会悄悄分叉（一个只跟纵向、一个跟二维）。
    // 设置页在 mods.js **之前**加载，所以它只能在真正用的时候来取这个全局
    //   （那时 mods.js 早已执行完）。
    window.__elainaBindFlatDragSort = bindFlatDragSort;


    window.ElainaModsDragSort = { bindFlatDragSort };
})();
