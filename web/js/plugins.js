// 插件设置栏：插件卡片 / 分组 / 拖拽排序 / 启用停用 / 安装删除 / 前置区 / README。
'use strict';

// 平台说明只能按实情写：电脑版可把 zip 丢进 mods/ 自动安装，APK 没有本地服务端、碰不到私有目录，只能「上传安装」。
function applyModsPlatformHint() {
    const el = document.getElementById('modsPlatformHint');
    if (!el) return;
    const common = '<b>安装插件等于信任它的代码</b>（它在页面同源环境里运行），请只装自己信得过的。'
        + '拖插件卡片到某个分栏的标题上可以归类；拖分栏标题本身可以调分栏顺序。';
    el.innerHTML = IS_NATIVE_APP
        ? '可选功能的开关。安卓版没有本地服务端，装插件请点右上角<b>「上传安装」</b>选一个 zip；'
            + '卸载点卡片上的 🗑。' + common
        : '可选功能的开关。插件放在项目根的 <code class="px-1 rounded bg-white/60">mods/</code> 下，'
            + '把 <code class="px-1 rounded bg-white/60">xxx.zip</code> 丢进去即会自动安装'
            + '（也可以点右上角「上传安装」）。' + common;
}

/** 前置区展开态只存内存（临时视图，不是跨设备同步的设置项）；拨开关会触发列表重建，不能只靠 DOM class 记。 */
let modsPrereqOpen = false;
let modsHintErrorText = '';

const ICON = {
    grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    doc: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/></svg>',
    gear: '<svg fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.41 5.39L10.53 2.72L13.47 2.72L13.59 5.39L15.55 6.20L17.53 4.40L19.60 6.47L17.80 8.45L18.61 10.41L21.28 10.53L21.28 13.47L18.61 13.59L17.80 15.55L19.60 17.53L17.53 19.60L15.55 17.80L13.59 18.61L13.47 21.28L10.53 21.28L10.41 18.61L8.45 17.80L6.47 19.60L4.40 17.53L6.20 15.55L5.39 13.59L2.72 13.47L2.72 10.53L5.39 10.41L6.20 8.45L4.40 6.47L6.47 4.40L8.45 6.20ZM12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4z"/></svg>',
    folder: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>',
    refresh: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h5M20 20v-5h-5"/><path stroke-linecap="round" stroke-linejoin="round" d="M20 9A8 8 0 006 5.3M4 15a8 8 0 0014 3.7"/></svg>',
    trash: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0l1 13h8l1-13"/></svg>',
};

/** opts.noGrip：前置区是固定分区（拖进分栏也会被拉回来），留个能拖的把手只会让人以为能搬走。 */
function renderModCard(m, opts) {
    const id = escapeHtml(m.id);
    const name = escapeHtml(m.name || m.id);
    const glyph = escapeHtml(Array.from(String(m.name || '✦').trim())[0] || '✦');
    const desc = (window.ElainaReadme && window.ElainaReadme.inline)
        ? window.ElainaReadme.inline(m.description || '')
        : escapeHtml(m.description || '');
    const ver = m.version
        ? '<span class="text-[10px] text-indigo-400 ml-1">v' + escapeHtml(m.version) + '</span>' : '';

    let badge = '';
    if (m.state === 'error') {
        badge = '<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 ml-1" title="'
            + escapeHtml(m.error || '') + '">'
            + (m.autoDisabled ? '加载失败 · 已自动停用' : '加载失败') + '</span>';
    } else if (m.state === 'blocked') {
        badge = '<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 ml-1" title="'
            + escapeHtml(m.error || '') + '">前置插件不可用</span>';
    } else if (m.state === 'ready') {
        badge = '<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600 ml-1">已加载</span>';
    } else if (m.state === 'disabled') {
        badge = '<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 ml-1">未启用</span>';
    }

// 报错详情只写在卡片上（不在 title 里，也不弹全局提示）：触屏没有悬停，插件坏了也不该在聊天区 / 顶栏 / 公告里出现（AGENTS.md D20）。
    let errorDetail = '';
    if (m.state === 'error' && m.error) {
        errorDetail = '<div class="mt-1.5 rounded-md bg-red-50 border border-red-100 px-2 py-1.5">'
            + '<div class="text-[11px] text-red-600 leading-relaxed break-words">'
            + escapeHtml(String(m.error)) + '</div>'
            + '<div class="text-[11px] text-red-400 leading-relaxed mt-1">'
            + (m.autoDisabled
                ? '已自动停用，软件其余功能不受影响。修好它之后把开关重新打开即可。'
                : '软件其余功能不受影响。')
            + (m.faultCount ? '<br>运行期已出错 ' + escapeHtml(String(m.faultCount)) + ' 次。' : '')
            + '</div></div>';
    } else if (m.state === 'blocked' && m.error) {
        errorDetail = '<div class="mt-1.5 rounded-md bg-red-50 border border-red-100 px-2 py-1.5">'
            + '<div class="text-[11px] text-red-600 leading-relaxed break-words">'
            + escapeHtml(String(m.error)) + '</div></div>';
    }

    const missing = Array.isArray(m.missingDeps) ? m.missingDeps : [];
    let blockReason = '';
    if (missing.length) {
        const rows = missing.map((d) => {
            const dep = typeof d === 'string' ? { id: d, reason: '不可用' } : d;
            const what = '前置插件「' + escapeHtml(dep.id) + '」' + escapeHtml(dep.reason || '不可用');
            if (dep.reason === '未启用') return what + ' —— 把它的开关打开';
            if (dep.reason === '未安装') return what + ' —— 需要先安装它';
            if (dep.reason === '插件系统总开关已关闭') return what + ' —— 插件系统被关闭（设置里的总开关为关），刷新页面即可恢复';
            return what;
        });
        blockReason = '<span class="block text-[11px] text-red-500 leading-relaxed mt-1">'
            + rows.join('<br>') + '</span>';
    }

    // hidden 的公共依赖仍给开关：一旦被禁用，界面上就没有任何入口能再打开它，只能手改存储键。
    const hiddenNote = m.hidden
        ? '<span class="text-[10px] text-indigo-300 ml-1">（公共依赖）</span>' : '';

    const toggle = '<label class="mod-switch" title="' + (m.enabled ? '点击停用' : '点击启用') + '">'
        + '<input type="checkbox" class="mod-toggle" data-mod-id="' + id + '"'
        + (m.enabled ? ' checked' : '') + ' aria-label="启用 ' + name + '">'
        + '<span class="track"></span><span class="knob"></span></label>';

    // 「打开文件夹」只在电脑版显示：APK 上原生拦截器虽让 _fromServer 为 true，但没实现 open-folder，点下去必然 Not found。
    const canManage = m._fromServer === true;
    // data-mod-dir 是磁盘上的真实目录名（打开文件夹与删除都按它拼路径），与身份 data-mod-id（manifest.id）常常不同；只传 id 会 404。
    const dirName = String(m.dir || m.id || '');
    const openFolderBtn = (canManage && !IS_NATIVE_APP)
        ? '<button type="button" class="mod-act mod-openfolder" data-mod-id="' + escAttr(dirName) + '"'
            + ' data-mod-name="' + name + '" title="在文件管理器里打开这个插件的目录">' + ICON.folder + '</button>'
        : '';
    const delBtn = canManage
        ? '<button type="button" class="mod-act mod-act-danger mod-del-btn" data-mod-id="' + id + '"'
            + ' data-mod-name="' + name + '" title="删除这个插件（含安装包）">' + ICON.trash + '</button>'
        : '';
    const hasModal = Boolean(window.ElainaMods && typeof window.ElainaMods.hasModSettings === 'function'
        && window.ElainaMods.hasModSettings(m.id));
    const hasTab = Boolean(document.querySelector('[data-settings-tab="tab-' + m.id + '"]'));
    const settingsBtn = (hasModal || hasTab)
        ? '<button type="button" class="mod-act mod-opensettings" data-mod-id="' + id + '"'
            + ' title="打开这个插件的设置">' + ICON.gear + '</button>'
        : '';

    return '<div class="mod-card" data-mod-id="' + id
        + '" data-fullwidth="' + ((desc || errorDetail || blockReason) ? '1' : '0') + '">'
        + ((opts && opts.noGrip) ? ''
            : '<button type="button" class="mod-grip" title="按住拖动可调整显示顺序" aria-label="拖动排序">' + ICON.grip + '</button>')
        + '<span class="mod-avatar" aria-hidden="true">' + glyph + '</span>'
        + '<div class="min-w-0 flex-1">'
          + '<div class="flex items-start gap-2">'
            + '<div class="min-w-0 flex-1">'
              + '<span class="text-xs font-semibold text-indigo-800">' + name + '</span>' + ver + hiddenNote + badge
            + '</div>'
            + '<div class="flex-none pt-0.5">' + toggle + '</div>'
          + '</div>'
          + (desc ? '<div class="mod-desc text-[11px] text-indigo-400 leading-relaxed mt-1">' + desc + '</div>' : '')
          + errorDetail
          + blockReason
          + '<div class="flex items-center gap-1.5 mt-2">'
            + '<button type="button" class="mod-act mod-readme-btn" data-mod-id="' + id + '"'
              + ' data-mod-name="' + name + '" title="查看插件自带的说明（README）">' + ICON.doc + '</button>'
            + settingsBtn
            + openFolderBtn
            + delBtn
          + '</div>'
        + '</div>'
        + '</div>';
}

function renderGroupHtml(g, items, order) {
    items.sort((a, b) => {
        const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
        if (ia < 0 && ib < 0) return 0;
        if (ia < 0) return 1;
        if (ib < 0) return -1;
        return ia - ib;
    });
    const collapsed = g.collapsed === true;
    const gid = escAttr(g.id);
    return '<div class="mod-group' + (collapsed ? ' mod-group-collapsed' : '') + '" data-group-id="' + gid + '">'
        + '<div class="mod-group-head" data-group-id="' + gid + '" title="点击收纳/展开">'
        + '<span class="mod-grip mod-group-grip" title="按住拖动可调整位置" aria-label="拖动排序">'
        + '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span>'
        + '<button type="button" class="mod-group-toggle" data-group-id="' + gid + '"'
        + ' title="' + (collapsed ? '展开' : '收纳') + '" aria-label="' + (collapsed ? '展开分栏' : '收纳分栏') + '">'
        + '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 6l6 6-6 6z"/></svg></button>'
        + '<span class="mod-group-name text-xs font-semibold text-indigo-800" data-group-id="' + gid + '">'
        + escAttr(g.name) + '</span>'
        + '<span class="text-[10px] text-indigo-400">' + items.length + '</span>'
        + '<span class="mod-group-actions ml-auto flex items-center gap-1">'
        + '<button type="button" class="mod-act mod-group-rename" data-group-id="' + gid + '" title="重命名这个分栏">'
        + '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5h6M4 20h16M13.5 4.5l4 4L8 18H5v-3l8.5-10.5z"/></svg></button>'
        + '<button type="button" class="mod-act mod-act-danger mod-group-del" data-group-id="' + gid + '" title="删除这个分栏（里面的插件回到顶层）">'
        + '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0l1 13h8l1-13"/></svg></button>'
        + '</span>'
        + '</div>'
        + '<div class="mod-group-body mod-grid' + (collapsed ? ' is-collapsed' : '') + '" data-group-body="' + gid + '">'
        + (items.length
            ? items.map(renderModCard).join('')
            : '<div class="text-[11px] text-indigo-300 py-3 text-center">把插件卡片拖到这里</div>')
        + '</div>'
        + '</div>';
}

function escAttr(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 光晕是运行时插进卡片的独立元素（卡片自身的 box-shadow / 背景被 #tab-mods 的 !important 压死）；「减少动态效果」时改成静态描边。 */
function rippleCard(sourceEl) {
    const card = sourceEl && sourceEl.closest('.mod-card');
    if (!card) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
        card.classList.remove('rd-ripple-static');
        void card.offsetWidth;
        card.classList.add('rd-ripple-static');
        window.setTimeout(() => card.classList.remove('rd-ripple-static'), 1400);
        return;
    }
    const cr = card.getBoundingClientRect();
    const tr = sourceEl.getBoundingClientRect();
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    let rgb = [211, 179, 106];
    const hex = /^#([0-9a-f]{6})$/i.exec((getComputedStyle(card).getPropertyValue('--color-primary') || '').trim());
    if (hex) rgb = [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)];
    const rgba = (a) => 'rgba(' + rgb.join(',') + ',' + a + ')';
    const sx = tr.left + tr.width / 2 - cr.left;
    const sy = tr.top + tr.height / 2 - cr.top;
    const wash = document.createElement('div');
    wash.style.cssText = 'position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none;z-index:0;';
    const halo = document.createElement('div');
    halo.style.cssText = 'position:absolute;left:' + sx + 'px;top:' + sy + 'px;'
        + 'width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;'
        + 'background:radial-gradient(circle, ' + rgba(.55) + ' 0%, ' + rgba(.22) + ' 45%, transparent 72%);';
    wash.appendChild(halo);
    card.insertBefore(wash, card.firstChild);   // 垫在文字内容之下、卡片底色之上
    let far = 0;
    for (const [x, y] of [[0, 0], [cr.width, 0], [0, cr.height], [cr.width, cr.height]]) {
        far = Math.max(far, Math.hypot(x - sx, y - sy));
    }
    const scale = (far * 2.1) / 22;
    const anim = halo.animate([
        { transform: 'scale(.35)', opacity: 1 },
        { transform: 'scale(' + scale.toFixed(2) + ')', opacity: 0 },
    ], { duration: 850, easing: 'cubic-bezier(.2,.65,.35,1)' });
    const remove = () => wash.remove();
    anim.onfinish = remove;
    anim.oncancel = remove;
}

/** 服务端清单 + 前端加载器状态合并；顺带把安装失败的 zip 原因写到提示行。 */
async function loadModsEntries(hint) {
    let fromServer = [];
    let bad = [];
    try {
        const res = await fetch('/api/plugins', { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            fromServer = Array.isArray(data && data.plugins) ? data.plugins : [];
            // 安装失败的 zip 要让用户看见原因，否则"我放进去了但没反应"无从排查
            bad = (data && data.installResults || []).filter((r) => !r.ok);
        }
    } catch (e) { /* APK 端没有这个接口，走前端那份 */ }

    // 只清理上一轮自己写下的错误提示：上传 / 开关刚写下的新提示不能被刷新抹掉。
    if (hint && bad.length) {
        const msg = '有 ' + bad.length + ' 个 zip 安装失败：' + bad.map((b) => b.zip + '（' + b.error + '）').join('；');
        hint.textContent = msg;
        hint.className = 'text-[11px] text-red-500';
        modsHintErrorText = msg;
    } else if (hint && modsHintErrorText && hint.textContent === modsHintErrorText) {
        hint.textContent = '';
        hint.className = 'text-[11px]';
        modsHintErrorText = '';
    }

    const fromLoader = (window.ElainaMods && typeof window.ElainaMods.list === 'function')
        ? window.ElainaMods.list() : [];

    const stateOf = new Map(fromLoader.map((m) => [m.id, m]));
    const merged = fromServer.map((m) => Object.assign({}, m, stateOf.get(m.id) || {}, { _fromServer: true }));
    // 服务端没有但加载器有的（APK 端 / 手工放目录）也要显示
    for (const m of fromLoader) {
        if (!merged.some((x) => x.id === m.id)) merged.push(Object.assign({}, m, { _fromServer: false }));
    }
    return merged;
}

/** 满足其一即为前置：manifest.hidden === true 的公共依赖（如立绘 / 场景素材包），或被别的插件在 manifest.after 里点名。 */
function splitPrereqMods(merged) {
    const afterNames = new Set();
    for (const m of merged) {
        for (const d of (Array.isArray(m.after) ? m.after : [])) afterNames.add(String(d));
    }
    const isPrereqMod = (m) => m.hidden === true
        || afterNames.has(String(m.id))
        || (m.dir && afterNames.has(String(m.dir)))
        || (m.regName && afterNames.has(String(m.regName)));
    return {
        prereqMods: merged.filter(isPrereqMod),
        normalMods: merged.filter((m) => !isPrereqMod(m)),
    };
}

function computeTopOrder(loose, groups) {
    const TOP_KEY = 'elaina_mods_top_order';
    let topOrder = [];
    try {
        const v = JSON.parse(Store.getItem(TOP_KEY) || '[]');
        if (Array.isArray(v)) topOrder = v.filter((x) => x && x.t && x.id);
    } catch (e) { /* 忽略 */ }
    const seenTop = new Set(topOrder.map((x) => x.t + ':' + x.id));
    for (const m of loose) {
        if (!seenTop.has('mod:' + m.id)) topOrder.push({ t: 'mod', id: m.id });
    }
    for (const g of groups) {
        if (!seenTop.has('group:' + g.id)) topOrder.push({ t: 'group', id: g.id });
    }
    return topOrder;
}

/** 展开先放回文档流、量出真实高度再过渡；transitionend 在动画被打断或元素被隐藏时可能丢失，另用定时器兜底。 */
function bindPrereqToggle(toggle) {
    toggle.addEventListener('click', () => {
        modsPrereqOpen = !modsPrereqOpen;
        const body = document.getElementById('modsPrereqBody');
        const btn = document.getElementById('modsPrereqToggle');
        if (!body) return;
        const clearInline = () => { body.style.height = ''; body.style.overflow = ''; body.style.transition = ''; };
        const onDone = (e) => {
            if (e && e.propertyName !== 'height') return;
            body.removeEventListener('transitionend', onDone);
            if (modsPrereqOpen) clearInline();
            else { body.classList.add('hidden'); clearInline(); }
        };
        if (modsPrereqOpen) {
            body.classList.remove('hidden');
            body.style.overflow = 'hidden';
            body.style.height = '0px';
            void body.offsetWidth;   // 先落到 0，过渡才有起点
            body.style.transition = 'height .32s ease';
            body.style.height = body.scrollHeight + 'px';
        } else {
            body.style.overflow = 'hidden';
            body.style.height = body.scrollHeight + 'px';
            void body.offsetWidth;
            body.style.transition = 'height .32s ease';
            body.style.height = '0px';
        }
        body.addEventListener('transitionend', onDone);
        setTimeout(() => { if (body.style.transition) onDone(); }, 420);   // transitionend 丢失时的兜底
        if (btn) {
            btn.setAttribute('aria-expanded', modsPrereqOpen ? 'true' : 'false');
            const c = btn.querySelector('[data-prereq-caret]');
            if (c) {
                c.style.transition = 'transform .32s ease';
                c.style.display = 'inline-block';
                c.style.transform = modsPrereqOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
                c.textContent = '▾';
            }
        }
    });
}

/** 结果以条目状态为准：setEnabled 对「启用后加载失败」也返回 true，只看返回值会把「没起来」报成「已启用」。 */
function bindModToggle(box, hint) {
    box.querySelectorAll('.mod-toggle').forEach((el) => {
        el.addEventListener('change', async () => {
            const id = el.getAttribute('data-mod-id');
            // setEnabled 是 async 的：必须 await 之后才能刷新，否则读到旧 state
            if (!window.ElainaMods) return;
            // 动作落点先给确认：眼睛正盯着这张卡片，立即亮一下；列表重绘会换掉卡片 DOM，重绘后对新卡片再补一次。
            rippleCard(el);
            // 记一份快照：成功后对比出这次连带打开了哪些前置，不说的话用户会以为插件列表「自己动了」。
            const before = el.checked
                ? new Map(window.ElainaMods.list().map((p) => [p.id, p.enabled])) : null;
            // 停用有运行中依赖方的插件：弹窗说明并把开关拨回去（拒绝本身发生在 setEnabled 内部，这里是先查，为了把「谁在用」说给用户听）。
            if (!el.checked && typeof window.ElainaMods.dependentsOf === 'function') {
                const using = window.ElainaMods.dependentsOf(id);
                if (using.length) {
                    const names = using.map((p) => '「' + (p.name || p.id) + '」').join('、');
                    el.checked = true;   // 拨回去，不留"看起来关了"的假状态
                    window.setTimeout(() => showCustomAlert(names + ' 正在使用这个插件。如需关闭，请先关闭 ' + names + '。', '不能关闭'), 480);
                    return;
                }
            }
            // 插件不在注册表里时 setEnabled 直接 return false，而注册表只在页面启动时建立：先重扫一次再重试；前置拉不起来不走重试。
            let ok = await window.ElainaMods.setEnabled(id, el.checked);
            if (ok === false && typeof window.ElainaMods.reload === 'function') {
                const st0 = window.ElainaMods.list().find((p) => p.id === id);
                if (!(st0 && st0.error)) {
                    try { await window.ElainaMods.reload(); } catch (e) { /* 下面照常汇报 */ }
                    ok = await window.ElainaMods.setEnabled(id, el.checked);
                }
            }
            const st = window.ElainaMods.list().find((p) => p.id === id);
            const failed = ok === false
                || (el.checked && (!st || !st.enabled || st.state === 'error' || st.state === 'blocked'));
            if (failed) {
                if (hint) {
                    hint.textContent = st && st.error
                        ? '没有' + (el.checked ? '启动 ' : '停用 ') + id + '：' + st.error
                        : '这个插件当前没能' + (el.checked ? '启用' : '停用') + '（加载器没认到它）。刷新页面后再试一次。';
                    hint.className = 'text-[11px] text-red-500';
                }
                el.checked = !el.checked;   // 把开关拨回去，别留一个假状态
                void refreshModsList();
                return;
            }
            if (hint) {
                let msg = '已' + (el.checked ? '启用 ' : '停用 ') + id + '（立即生效）';
                if (el.checked && before) {
                    const pulled = window.ElainaMods.list().filter((p) => p.enabled && !before.get(p.id));
                    if (pulled.length) {
                        msg += '，连同前置 ' + pulled.map((p) => p.name || p.id).join('、') + ' 一起打开';
                    }
                }
                hint.textContent = msg;
                hint.className = 'text-[11px] text-indigo-500';
            }
            const refreshed = refreshModsList();
            void Promise.resolve(refreshed).then(() => {
                const fresh = document.querySelector('.mod-toggle[data-mod-id="' + id + '"]');
                if (fresh) rippleCard(fresh);
            });
        });
    });
}

/** 卡片每次重绘都会换掉这些按钮，事件必须随新 DOM 重挂。 */
function bindModCardButtons(box, hint) {
    box.querySelectorAll('.mod-readme-btn').forEach((el) => {
        el.addEventListener('click', async () => {
            const id = el.getAttribute('data-mod-id');
            const name = el.getAttribute('data-mod-name') || id;
            await openModReadme(id, name);
        });
    });

    box.querySelectorAll('.mod-opensettings').forEach((el) => {
        el.addEventListener('click', () => {
            const id = el.getAttribute('data-mod-id');
            if (window.ElainaMods && typeof window.ElainaMods.openModSettings === 'function'
                && window.ElainaMods.openModSettings(id)) {
                return;
            }
            if (typeof switchSettingsTab === 'function') switchSettingsTab('tab-' + id);
        });
    });

    // 打开插件目录（POST /api/plugins/open-folder?id=…）：失败必须写在插件列表上（modsHint），不能弹全局 alert（AGENTS.md D20）；失败另给兜底出口「浏览目录」。
    box.querySelectorAll('.mod-openfolder').forEach((el) => {
        el.addEventListener('click', async () => {
            const id = el.getAttribute('data-mod-id');
            const name = el.getAttribute('data-mod-name') || id;
            el.disabled = true;
            if (hint) { hint.textContent = '正在打开「' + name + '」的文件夹…'; hint.className = 'text-[11px] text-indigo-500'; }
            try {
                const res = await fetch('/api/plugins/open-folder?id=' + encodeURIComponent(id), { method: 'POST' });
                const data = await res.json().catch(() => null);
                if (res.ok && data && data.ok) {
                    if (hint) {
                        hint.textContent = '已打开「' + name + '」的文件夹'
                            + (data.path ? '：' + data.path : '');
                        hint.className = 'text-[11px] text-indigo-500';
                    }
                    return;
                }
                if (hint) {
                    hint.textContent = '打开「' + name + '」的文件夹失败：'
                        + ((data && data.message) || ('HTTP ' + res.status))
                        + '。可点「浏览目录」查看 mods/ 里的文件夹。';
                    hint.className = 'text-[11px] text-red-500';
                }
            } catch (err) {
                if (hint) {
                    hint.textContent = '打开「' + name + '」的文件夹失败：'
                        + String((err && err.message) || err) + '（服务没在运行？）';
                    hint.className = 'text-[11px] text-red-500';
                }
            } finally {
                el.disabled = false;
            }
        });
    });

    // 「浏览目录」的点击处理挂在 init.js（只执行一次）：这里每次刷新列表都会重跑，绑在这里点一下会连发 N 次请求。

    // 删除：调 DELETE /api/plugins/:id（删目录 + 安装包），带二次确认
    box.querySelectorAll('.mod-del-btn').forEach((el) => {
        el.addEventListener('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const id = el.getAttribute('data-mod-id');
            const name = el.getAttribute('data-mod-name') || id;
            // 删除有运行中依赖方的插件：弹窗说明、不走删除确认（删目录救不回来，顺序必须是先关依赖方、再删）。
            if (window.ElainaMods && typeof window.ElainaMods.dependentsOf === 'function') {
                const using = window.ElainaMods.dependentsOf(id);
                if (using.length) {
                    const names = using.map((p) => '「' + (p.name || p.id) + '」').join('、');
                    showCustomAlert(names + ' 正在使用这个插件。如需卸载，请先关闭 ' + names + '。', '不能卸载');
                    return;
                }
            }
            const okToGo = await showCustomConfirm(
                '删除插件「' + name + '」？\n\n'
                + '会把插件目录和安装包一起删掉（下次打开设置不会再出现）。\n'
                + '要重新安装，需要再上传一次 zip。',
                '删除插件');
            if (!okToGo) return;

            el.disabled = true;
            if (hint) { hint.textContent = '正在删除 ' + name + '…'; hint.className = 'text-[11px] text-indigo-500'; }
            try {
                const res = await fetch('/api/plugins/' + encodeURIComponent(id), { method: 'DELETE' });
                const data = await res.json().catch(() => null);
                if (!res.ok || !data || data.ok === false) {
                    if (hint) {
                        hint.textContent = '删除失败：' + ((data && data.message) || ('HTTP ' + res.status));
                        hint.className = 'text-[11px] text-red-500';
                    }
                } else {
                    if (window.ElainaMods && typeof window.ElainaMods.forget === 'function') {
                        window.ElainaMods.forget(id);
                    }
                    if (hint) {
                        hint.textContent = '已删除 ' + name + '（刷新页面后彻底生效）';
                        hint.className = 'text-[11px] text-emerald-600';
                    }
                    void refreshModsList();
                }
            } catch (err) {
                if (hint) {
                    hint.textContent = '删除失败：' + String((err && err.message) || err);
                    hint.className = 'text-[11px] text-red-500';
                }
            } finally {
                el.disabled = false;
            }
        });
    });
}

/** 删除前只数这个分栏里看得见的插件，前置扩展是固定分区、不参与归属判断。 */
function bindModGroupActions(box, normalMods, groupOf, ungroupedId, readGroups, saveGroups) {
    box.querySelectorAll('.mod-group-rename').forEach((el) => {
        el.addEventListener('click', () => {
            const gid = el.getAttribute('data-group-id');
            const gs = readGroups();
            const g = gs.find((x) => x.id === gid);
            const cur = g ? g.name : '';
            const next = window.prompt('分栏名称：', cur);
            if (next === null) return;
            const name2 = String(next).trim();
            if (!name2 || name2 === cur) return;
            if (g) { g.name = name2; saveGroups(gs); }
            void refreshModsList();
        });
    });

    box.querySelectorAll('.mod-group-del').forEach((el) => {
        el.addEventListener('click', async () => {
            const gid = el.getAttribute('data-group-id');
            const gs = readGroups();
            const g = gs.find((x) => x.id === gid);
            if (!g) return;
            const inside = normalMods.filter((m) => (groupOf[m.id] || ungroupedId) === gid);
            if (inside.length) {
                const names = inside.map((m) => m.name || m.id).join('、');
                const msg = '这个分栏里还有 ' + inside.length + ' 个插件：' + names
                    + '\n\n请先把它们拖出来（拖到列表任意位置），再删除分栏。';
                try {
                    if (typeof showCustomAlert === 'function') showCustomAlert(msg, '不能删除');
                    else window.alert(msg);
                } catch (e) { window.alert(msg); }
                return;
            }
            const okToGo = await showCustomConfirm('删除分栏「' + g.name + '」？', '删除分栏');
            if (!okToGo) return;
            saveGroups(gs.filter((x) => x.id !== gid));
            try {
                const top = JSON.parse(Store.getItem('elaina_mods_top_order') || '[]');
                Store.setItem('elaina_mods_top_order',
                    JSON.stringify(top.filter((x) => !(x.t === 'group' && x.id === gid))));
                if (typeof Store._flush === 'function') Store._flush();
            } catch (e) { /* 忽略 */ }
            void refreshModsList();
        });
    });
}

/** 两条数据源缺一不可：服务端 /api/plugins 是「装了哪些 mod」的权威来源（会扫描 mods/ 并解压新 zip），ElainaMods.list() 是「跑起来没有」。 */
async function refreshModsList() {
    const box = document.getElementById('modsList');
    if (!box) return;
    const hint = document.getElementById('modsHint');
    applyModsPlatformHint();
    // 技能不是插件，走独立数据源，绝不合并进下面的 fromServer，这里只顺带刷一下。
    void refreshSkillsList();

    const merged = await loadModsEntries(hint);

    // 前置扩展单独成区：照样能开关、看加载失败原因、卸载；混在普通列表里会让人拨开关后发现没反应。
    const { prereqMods, normalMods } = splitPrereqMods(merged);

    // 分栏数据模型（键都已在 store.js 的 DATA_KEYS 里）：elaina_mods_groups = [{ id, name, collapsed, fixed? }]、elaina_mods_group_of = { 插件id: 分栏id }、elaina_mods_order = [插件id...]、elaina_mods_top_order = [{t:'mod'|'group', id}...]；没归属的直接平铺在顶层。
    const GROUPS_KEY = 'elaina_mods_groups';
    const GROUP_OF_KEY = 'elaina_mods_group_of';
    const UNGROUPED_ID = '__ungrouped__';
    const readGroups = () => {
        try {
            const v = JSON.parse(Store.getItem(GROUPS_KEY) || '[]');
            return Array.isArray(v) ? v.filter((g) => g && g.id && g.id !== UNGROUPED_ID) : [];
        } catch (e) { return []; }
    };
    const saveGroups = (gs) => {
        try {
            Store.setItem(GROUPS_KEY, JSON.stringify(gs));
            if (Store && typeof Store._flush === 'function') Store._flush();
        } catch (e) { /* 忽略 */ }
    };
    const groupOf = (() => {
        try { const v = JSON.parse(Store.getItem(GROUP_OF_KEY) || '{}'); return (v && typeof v === 'object') ? v : {}; }
        catch (e) { return {}; }
    })();

    const ORDER_KEY = 'elaina_mods_order';
    const readOrder = () => {
        try { const v = JSON.parse(Store.getItem(ORDER_KEY) || '[]'); return Array.isArray(v) ? v : []; }
        catch (e) { return []; }
    };

    const groups = readGroups();

    const byGroup = new Map();
    const loose = [];
    for (const m of normalMods) {
        const gid = groupOf[m.id];
        if (gid && gid !== UNGROUPED_ID && groups.some((g) => g.id === gid)) {
            if (!byGroup.has(gid)) byGroup.set(gid, []);
            byGroup.get(gid).push(m);
        } else {
            loose.push(m);   // 没归属 / 归属的分栏已被删 → 顶层平铺
        }
    }
    const looseById = new Map(loose.map((m) => [m.id, m]));

    const topOrder = computeTopOrder(loose, groups);

    box.classList.add('mod-grid');
    box.innerHTML = topOrder.map((entry) => {
        if (entry.t === 'group') {
            const g = groups.find((x) => x.id === entry.id);
            return g ? renderGroupHtml(g, byGroup.get(g.id) || [], readOrder()) : '';
        }
        const m = looseById.get(entry.id);
        return m ? renderModCard(m) : '';
    }).join('');

    // 前置区默认收起；展开态存内存即可（同一页面里刷新要保持用户刚展开的状态）；每次刷新先摘掉上一块（它在网格外面，不摘会叠一份）。
    document.querySelectorAll('.mod-prereq').forEach((el) => el.remove());
    if (prereqMods.length) {
        box.insertAdjacentHTML('afterend',
            '<div class="mt-4 mod-prereq">'
            + '<button type="button" id="modsPrereqToggle" class="w-full flex items-baseline gap-2 mb-1.5 text-left"'
            + ' aria-expanded="' + (modsPrereqOpen ? 'true' : 'false') + '"'
            + ' title="前置扩展默认收起；点一下展开">'
            + '<span class="text-[11px] font-semibold text-indigo-500">前置扩展</span>'
            + '<span class="text-[10px] text-indigo-300">' + prereqMods.length
            + ' 个 · 被其他插件依赖；可单独开关，关闭前需先关掉用它的插件</span>'
            + '<span class="ml-auto text-[10px] text-indigo-400" data-prereq-caret'
            + ' style="display:inline-block;transform:rotate(' + (modsPrereqOpen ? '0' : '-90') + 'deg)">▾</span>'
            + '</button>'
            + '<div id="modsPrereqBody" class="mod-grid' + (modsPrereqOpen ? '' : ' hidden') + '">'
            + prereqMods.map((m) => renderModCard(m, { noGrip: true })).join('')
            + '</div></div>');
        bindPrereqToggle(document.getElementById('modsPrereqToggle'));
    }

    // 前置区的卡片不在 box 里（是 #modsList 之后的独立区块）；只绑 box 的话它们上面的开关与按钮全都没有监听器。
    const prereqBody = document.getElementById('modsPrereqBody');
    for (const root of (prereqBody ? [box, prereqBody] : [box])) {
        bindModToggle(root, hint);
        bindModCardButtons(root, hint);
    }

    bindModGroupActions(box, normalMods, groupOf, UNGROUPED_ID, readGroups, saveGroups);

    bindGroupDragSort(box, () => void refreshModsList(), { readGroups, saveGroups });
}
