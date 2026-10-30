/* ============================================================================
 * 分组拖拽（从 settings.js 拆分）
 *
 * 插件卡片与分栏混排拖拽，复用 mods-drag-sort 内核。
 * ========================================================================== */
'use strict';

/**
 * 分组版拖拽：统一列表模型 —— 平铺插件与分栏同等级，混排。
 *
 *   手势（全部复用内核，同一手感）：
 *     ① 卡片把手拖动：松手时指针落在分栏上 → 归入；落在顶层 → 拿出来
 *     ② 分栏把手拖动：调分栏在顶层混排里的位置
 *     顺序按松手时 DOM 的真实次序重建（所见即所得）。
 */
function bindGroupDragSort(box, onDone, hooks) {
    const { readGroups, saveGroups } = hooks || {};
    if (typeof window.__elainaBindFlatDragSort !== 'function') {
        console.warn('[Mods] 拖拽内核未加载，分栏拖拽不可用');
        return;
    }
    const TOP_KEY = 'elaina_mods_top_order';
    const GROUP_OF_KEY = 'elaina_mods_group_of';

    /** 保存顶层混排顺序（DOM 里卡片与分栏的真实次序，所见即所得） */
    function saveTopOrder() {
        const seq = [...box.children].map((el) => {
            if (el.classList.contains('mod-group')) {
                return { t: 'group', id: el.getAttribute('data-group-id') };
            }
            if (el.classList.contains('mod-card')) {
                return { t: 'mod', id: el.getAttribute('data-mod-id') };
            }
            return null;
        }).filter(Boolean);
        try {
            Store.setItem(TOP_KEY, JSON.stringify(seq));
            if (Store && typeof Store._flush === 'function') Store._flush();
        } catch (e) { /* 忽略 */ }
    }

    /** 保存栏内插件顺序 */
    function saveModOrder() {
        try {
            Store.setItem('elaina_mods_order',
                JSON.stringify([...box.querySelectorAll('.mod-card')].map((c) => c.getAttribute('data-mod-id'))));
            if (Store && typeof Store._flush === 'function') Store._flush();
        } catch (e) { /* 忽略 */ }
    }

    // 拖拽高亮（拖着卡片悬在分栏上时提示"松手放进这里"）
    let hoverTarget = null;
    function clearHover() {
        if (hoverTarget) { hoverTarget.classList.remove('mod-group-hover'); hoverTarget = null; }
    }
    document.addEventListener('pointermove', (e) => {
        if (!document.body.classList.contains('mod-dragging-active')) { clearHover(); return; }
        if (!document.querySelector('.mod-card.mod-dragging')) { clearHover(); return; }
        const zone = (e.target && e.target.closest && e.target.closest('.mod-group'))
            || document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.mod-group');
        const head = zone ? zone.querySelector('.mod-group-head') : null;
        if (!head) { clearHover(); return; }
        if (hoverTarget === head) return;
        clearHover();
        hoverTarget = head;
        head.classList.add('mod-group-hover');
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearHover(); }, true);

    // ① 卡片拖动（内核）：栏内排序 + 松手按落点归类/拿出来
    window.__elainaBindFlatDragSort(
        box,
        () => {
            saveModOrder();
            saveTopOrder();
            if (typeof onDone === 'function') onDone();
        },
        {
            itemSelector: '.mod-card',
            handleSelector: '.mod-grip',
            placeholderClass: 'mod-placeholder',
            draggingClass: 'mod-dragging',
            // 逃逸容器：卡片拖出分栏体后落到顶层列表 —— "放进去的拿不出来"的解法
            outerContainer: box,
        }
    );

    // ② 卡片松手在分栏上 → 归入；松手在顶层 → 拿出来（松手那一刻决定）
    document.addEventListener('pointerup', (e) => {
        const card = document.querySelector('.mod-card.mod-dragging');
        if (!card) { clearHover(); return; }
        const modId = card.getAttribute('data-mod-id');
        const zone = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.mod-group');
        const head = zone ? zone.querySelector('.mod-group-head') : null;
        try {
            const map = JSON.parse(Store.getItem(GROUP_OF_KEY) || '{}');
            const curGroup = map[modId] || null;
            const newGroup = head ? head.getAttribute('data-group-id') : null;
            // 归属没变（还在原分栏松手 / 还在顶层松手）→ 不动，让内核走自己的栏内排序
            if ((newGroup || null) === curGroup) { clearHover(); return; }
            if (newGroup) map[modId] = newGroup;
            else delete map[modId];
            Store.setItem(GROUP_OF_KEY, JSON.stringify(map));
            if (Store && typeof Store._flush === 'function') Store._flush();
            clearHover();

            // 就地搬家 + FLIP（不整页重渲染）：重渲染会打断内核的飞行动画 ——
            //   卡片瞬移进/出分栏，观感"没有动画"。
            //   做法：记卡片当前屏幕位置 → 移到目标容器（分栏体开头 / 顶层占位处）→
            //   从旧位置演到新位置。
            const oldRect = card.getBoundingClientRect();
            // 先让内核把卡片从"拖拽态"还原（它会把卡片放回拖前的容器）——
            // 通过触发它的 pointercancel 路径，我们随后再把卡片挪到正确的新家
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            // Escape 还原是同步的：现在卡片已回到拖拽前的位置
            const body2 = newGroup
                ? document.querySelector('.mod-group[data-group-id="' + newGroup + '"] .mod-group-body')
                : document.getElementById('modsList');
            if (!body2) { if (typeof onDone === 'function') onDone(); return; }
            // 新家开头插入
            const anchor = body2.querySelector('.mod-card');
            if (anchor && anchor !== card) body2.insertBefore(card, anchor);
            else body2.appendChild(card);
            // 顶层归属时保持 top_order 一致（插到当前指针位置附近 —— 简化为开头）
            // FLIP：从旧屏幕位置演到新位置
            const nowRect = card.getBoundingClientRect();
            const dy = oldRect.top - nowRect.top;
            const dx = oldRect.left - nowRect.left;
            if (dy || dx) {
                card.style.transition = 'none';
                card.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
                requestAnimationFrame(() => {
                    card.style.transition = 'transform .25s cubic-bezier(.2,.8,.3,1)';
                    card.style.transform = '';
                    // 动画结束后摘掉内联 transition，别让它盖住卡片自己的 hover 过渡。
                    setTimeout(() => { card.style.transition = ''; }, 300);
                });
            }
            // 更新计数徽标（就地改，避免重渲染打断上面的动画）
            const groupEl2 = body2.closest('.mod-group');
            if (groupEl2) {
                const cnt = groupEl2.querySelector('.mod-group-head > span:nth-last-child(2)')
                    || groupEl2.querySelector('.mod-group-head span.text-\\[10px\\]');
                if (cnt) cnt.textContent = String(body2.querySelectorAll('.mod-card').length);
            }
            // 故意**不调 onDone**：它会 refreshModsList 整页重建，把刚播的
            //   FLIP 动画打断（"放进去没动画"的成因）。归属/顺序已各自入 Store。
        } catch (err) { /* 忽略 */ }
    }, true);

    // ③ 分栏拖动（内核）：与卡片同一套手感
    window.__elainaBindFlatDragSort(
        box,
        () => {
            saveTopOrder();
            if (typeof onDone === 'function') onDone();
        },
        {
            itemSelector: '.mod-group',
            handleSelector: '.mod-group-grip',
            idAttr: 'data-group-id',
            placeholderClass: 'mod-placeholder',
            draggingClass: 'mod-dragging',
            // 顶层混排：分栏与平铺卡片同等级，插入点候选包含两类项 ——
            //   分栏因此可以拖到任何卡片之间（用户要求；之前候选只有分栏，
            //   分栏永远拖不到卡片上面）。
            topLevelMixed: true,
            outerItemSelector: '.mod-card, .mod-group',
            outerContainer: box,
            canStart(ev) {
                return !ev.target.closest('.mod-act') && !ev.target.closest('.mod-group-toggle');
            },
        }
    );

    // ── 折叠：就地切类，不整页重渲染（CSS grid-rows 过渡才能播完） ──
    box.querySelectorAll('.mod-group-head').forEach((head) => {
        head.addEventListener('click', (ev) => {
            if (ev.target.closest('.mod-group-grip')) return;
            if (ev.target.closest('.mod-act')) return;
            if (ev.target.closest('.mod-group-toggle')) return;
            toggleGroupCollapse(head.getAttribute('data-group-id'));
        });
    });
    box.querySelectorAll('.mod-group-toggle').forEach((el) => {
        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            toggleGroupCollapse(el.getAttribute('data-group-id'));
        });
    });

    function toggleGroupCollapse(gid) {
        const gs = readGroups();
        const g = gs.find((x) => x.id === gid);
        if (!g) return;
        g.collapsed = !(g.collapsed === true);
        saveGroups(gs);
        const groupEl = box.querySelector('.mod-group[data-group-id="' + gid + '"]');
        if (!groupEl) { void refreshModsList(); return; }
        groupEl.classList.toggle('mod-group-collapsed', g.collapsed);
        groupEl.querySelector('.mod-group-body')?.classList.toggle('is-collapsed', g.collapsed);
        groupEl.querySelector('.mod-group-toggle')?.setAttribute('title',
            g.collapsed ? '展开' : '收纳');
    }
}


