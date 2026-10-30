/* ============================================================================
 * 插件设置栏（从 settings.js 拆出）
 *
 * 插件卡片 / 分组 / 拖拽排序 / 启用停用 / 安装删除 / 前置区 / README。
 * 依赖 ElainaMods、宿主弹窗与设置页 DOM。
 * ========================================================================== */
'use strict';

// ==================== 插件（mod）设置栏 ====================

// ===== 插件页的平台说明 =====
// 两个平台装插件的方式根本不同，共用一句说明必然误导一边：
//   电脑版：把 zip 丢进 mods/ 自动解压安装，也能「上传安装」；APK：没有服务端、碰不到应用私有目录，**只能**「上传安装」。
// 文案不能只写前者 —— 安卓用户会去找一个根本不存在的目录。
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

/**
 * 前置扩展区的展开态（默认收起）。
 *
 * 只存内存：这是"这次要不要看一眼"的临时视图，不是要跨设备同步的设置项；
 * 但拨开关会触发 refreshModsList 重建，所以不能只靠 DOM 上的 class 记。
 */
let modsPrereqOpen = false;
/** 上一轮由列表刷新写下的安装失败提示（用于只清理自己写的那条） */
let modsHintErrorText = '';

const ICON = {
    grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    doc: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/></svg>',
    // 齿轮：几何直齿画法（手写弧线命令极易写歪，实测一团毛刺）
    gear: '<svg fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.41 5.39L10.53 2.72L13.47 2.72L13.59 5.39L15.55 6.20L17.53 4.40L19.60 6.47L17.80 8.45L18.61 10.41L21.28 10.53L21.28 13.47L18.61 13.59L17.80 15.55L19.60 17.53L17.53 19.60L15.55 17.80L13.59 18.61L13.47 21.28L10.53 21.28L10.41 18.61L8.45 17.80L6.47 19.60L4.40 17.53L6.20 15.55L5.39 13.59L2.72 13.47L2.72 10.53L5.39 10.41L6.20 8.45L4.40 6.47L6.47 4.40L8.45 6.20ZM12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4z"/></svg>',
    folder: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>',
    refresh: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h5M20 20v-5h-5"/><path stroke-linecap="round" stroke-linejoin="round" d="M20 9A8 8 0 006 5.3M4 15a8 8 0 0014 3.7"/></svg>',
    trash: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0l1 13h8l1-13"/></svg>',
};

/**
 * 单张插件卡片。
 *
 * @param {object} m 合并后的插件条目
 * @param {{noGrip?:boolean}} [opts] noGrip：不画拖拽把手。
 *   前置扩展区是固定分区（不参与用户分栏），卡片拖进分栏也不会留在那儿，
 *   留一个能拖的把手只会让人以为可以搬走。
 */
function renderModCard(m, opts) {
    const id = escapeHtml(m.id);
    const name = escapeHtml(m.name || m.id);
    const glyph = escapeHtml(Array.from(String(m.name || '✦').trim())[0] || '✦');
    const desc = (window.ElainaReadme && window.ElainaReadme.inline)
        ? window.ElainaReadme.inline(m.description || '')
        : escapeHtml(m.description || '');
    const ver = m.version
        ? '<span class="text-[10px] text-indigo-400 ml-1">v' + escapeHtml(m.version) + '</span>' : '';

    // 状态角标（加载失败/前置不可用必须显眼）
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

    // 报错详情**直接写在卡片上**（不只在 title 里、也不弹全局提示）。
    // 为什么必须落在卡片上：错误的原因只有这个人自己关心，而它跟"哪个插件"
    //   强绑定。弹一个全局提示会说"某个插件加载失败了"—— 用户还得回头找
    //   是哪个；写成 title 则要悬停才看得见，触屏上根本没有悬停。
    // 为什么不在别处显示：插件坏了不该在聊天区/顶栏/公告里出现任何东西 ——
    //   那是"软件本身有问题"的观感。软件是好的，只是这个插件装坏了。
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

    // 缺依赖：逐条给出原因 + 该做什么
    const missing = Array.isArray(m.missingDeps) ? m.missingDeps : [];
    let blockReason = '';
    if (missing.length) {
        const rows = missing.map((d) => {
            const dep = typeof d === 'string' ? { id: d, reason: '不可用' } : d;
            const what = '前置插件「' + escapeHtml(dep.id) + '」' + escapeHtml(dep.reason || '不可用');
            if (dep.reason === '未启用') return what + ' —— 把它的开关打开';
            if (dep.reason === '未安装') return what + ' —— 需要先安装它';
            if (dep.reason === '插件系统总开关已关闭') return what + ' —— 插件系统被关闭（旧版本设置残留），刷新页面即可恢复';
            return what;
        });
        blockReason = '<span class="block text-[11px] text-red-500 leading-relaxed mt-1">'
            + rows.join('<br>') + '</span>';
    }

    // hidden 的插件（公共依赖）仍给开关 —— 否则一旦被禁用，界面上就没有
    //   任何入口能再把它打开，只能手改存储键
    const hiddenNote = m.hidden
        ? '<span class="text-[10px] text-indigo-300 ml-1">（公共依赖）</span>' : '';

    // iOS 风格开关
    const toggle = '<label class="mod-switch" title="' + (m.enabled ? '点击停用' : '点击启用') + '">'
        + '<input type="checkbox" class="mod-toggle" data-mod-id="' + id + '"'
        + (m.enabled ? ' checked' : '') + ' aria-label="启用 ' + name + '">'
        + '<span class="track"></span><span class="knob"></span></label>';

    // 底部那排按钮。
    // 「打开文件夹」只在**电脑版**显示，不能用 `canManage` 一个条件控两个按钮：
    //   APK 上 `/api/plugins` 是被原生拦截器接住的（见 core.js 的
    //   nativePluginsFetch）—— 于是 _fromServer 也是 true，按钮照样出现，
    //   但**原生没有实现 open-folder 这个接口**，点下去必然拿到
    //   「Not found（手机端未实现该接口）」。
    //   为什么不"补一个原生实现"而是不显示这个按钮：
    //   那个接口做的是"用系统的文件管理器打开插件目录"（serve.mjs 里调
    //   explorer/open）。安卓上插件住在应用私有目录，**没有文件管理器能打开它**
    //   （除非 root）。所以它不是"还没实现"，而是"在安卓上没有意义"。
    //   「删除」按钮则两端都有意义 —— APK 上走 nativeDeletePlugin。
    const canManage = m._fromServer === true;
    // data-mod-dir：磁盘上的真实目录名。打开文件夹与删除一样要走**目录名** ——
    //   /api/plugins/open-folder 与 DELETE /api/plugins/:id 都按目录名拼路径，
    //   而卡片的 data-mod-id 是身份（manifest.id），两者常常不同（如 birthday 住在
    //   birthday-1.1.0）。只传 id 会让每次点「打开文件夹」都 404。
    const dirName = String(m.dir || m.id || '');
    const openFolderBtn = (canManage && !IS_NATIVE_APP)
        ? '<button type="button" class="mod-act mod-openfolder" data-mod-id="' + escAttr(dirName) + '"'
            + ' data-mod-name="' + name + '" title="在文件管理器里打开这个插件的目录">' + ICON.folder + '</button>'
        : '';
    const delBtn = canManage
        ? '<button type="button" class="mod-act mod-act-danger mod-del-btn" data-mod-id="' + id + '"'
            + ' data-mod-name="' + name + '" title="删除这个插件（含安装包）">' + ICON.trash + '</button>'
        : '';
    // 「设置」按钮：插件有独立设置窗（settings.modal）→ 打开；老插件占分栏 → 切分栏
    const hasModal = Boolean(window.ElainaMods && typeof window.ElainaMods.hasModSettings === 'function'
        && window.ElainaMods.hasModSettings(m.id));
    const hasTab = Boolean(document.querySelector('[data-settings-tab="tab-' + m.id + '"]'));
    const settingsBtn = (hasModal || hasTab)
        ? '<button type="button" class="mod-act mod-opensettings" data-mod-id="' + id + '"'
            + ' title="打开这个插件的设置">' + ICON.gear + '</button>'
        : '';

    // data-fullwidth：卡片里带多行说明 / 依赖错误时排进多列会被压成一列 ——
    //   CSS 用 :has() 按这个标记让它在网格里独占一整行（软换行，比 grid-column:1/-1 更耐窄栏）。
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

/** 一个分栏的 HTML（头部 + 可折叠体） */
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
    // 折叠标记：disclosure triangle（▶ 收着 / ▼ 展开），展开时 rotate(90deg)
    // 左侧是专门的拖拽把手（三条竖线，与插件卡片同款）—— 拖拽与折叠不再抢手势
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

/**
 * 开关反馈：光晕从被拨动的开关中心扩散开来，漫过整张卡片后消散。
 * 外层把扩散裁剪在卡片圆角内 —— 光是"在卡片表面上漫开"，不会溢到列表里。
 * 光晕是运行时插到卡片里的独立元素 —— 卡片自身的 box-shadow/背景被
 * #tab-mods 的 !important 规则压死，挂在上面的阴影/背景动画一概出不来。
 * 系统开了"减少动态效果"时不做扩散，改成一圈静态描边停 1.4s。
 */
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
    // 主色随主题走；取不出来时退到默认金
    let rgb = [211, 179, 106];
    const hex = /^#([0-9a-f]{6})$/i.exec((getComputedStyle(card).getPropertyValue('--color-primary') || '').trim());
    if (hex) rgb = [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)];
    const rgba = (a) => 'rgba(' + rgb.join(',') + ',' + a + ')';
    // 光源位置：开关中心，换算成卡片内的坐标
    const sx = tr.left + tr.width / 2 - cr.left;
    const sy = tr.top + tr.height / 2 - cr.top;
    // 外层：铺满卡片并按卡片圆角裁剪；内层：以光源为圆心的光晕
    const wash = document.createElement('div');
    wash.style.cssText = 'position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none;z-index:0;';
    const halo = document.createElement('div');
    halo.style.cssText = 'position:absolute;left:' + sx + 'px;top:' + sy + 'px;'
        + 'width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;'
        + 'background:radial-gradient(circle, ' + rgba(.55) + ' 0%, ' + rgba(.22) + ' 45%, transparent 72%);';
    wash.appendChild(halo);
    card.insertBefore(wash, card.firstChild);   // 垫在文字内容之下、卡片底色之上
    // 铺满整张卡所需的比例：光源到最远那个角的距离（略加一成保证边缘也漫到）
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

/** 拉取并合并「服务端清单 + 前端加载器状态」；顺带把安装失败的 zip 原因写到提示行。 */
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

    // 只清理**上一轮自己写下的**错误提示：上传/开关刚写下的新提示不能被刷新抹掉，
    //   而失败原因消失后旧提示也不该一直挂着。
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

    // 以服务端清单为准，用加载器状态补充
    const stateOf = new Map(fromLoader.map((m) => [m.id, m]));
    const merged = fromServer.map((m) => Object.assign({}, m, stateOf.get(m.id) || {}, { _fromServer: true }));
    // 服务端没有但加载器有的（APK 端 / 手工放目录）也要显示
    for (const m of fromLoader) {
        if (!merged.some((x) => x.id === m.id)) merged.push(Object.assign({}, m, { _fromServer: false }));
    }
    return merged;
}

/**
 * 拆出前置扩展与普通插件。
 * 判定两条，满足其一即为前置扩展：
 *   · manifest.hidden === true —— 作者声明"公共依赖"（立绘、场景图这类素材包）；
 *   · 被别的插件在 manifest.after 里点名 —— 即使它自己带界面（live2d-models 的模型管理），
 *     它同样是别人跑起来的前提，市场里也是按前置收的。
 */
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

/** 顶层混排顺序（没提到的项按 插件在前、分栏在后 兜底追加）。 */
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

/**
 * 前置扩展区的展开/收起。
 *
 * 展开时先把容器放回文档流、量出真实高度再过渡；收起时从当前高度回到 0，
 * 过渡结束后才隐藏。transitionend 在动画被打断或元素被隐藏时可能丢失，
 * 所以再用定时器兜底，避免容器卡在中间高度。
 */
function bindPrereqToggle(toggle) {
    toggle.addEventListener('click', () => {
        modsPrereqOpen = !modsPrereqOpen;
        const body = document.getElementById('modsPrereqBody');
        const btn = document.getElementById('modsPrereqToggle');
        if (!body) return;
        // 文本展开动效：展开时先显示容器、量出真实内容高度，从 0 过渡过去；
        //   收起时从当前高度出发收回到 0，结束后再藏起来。系统开了
        //   "减少动态效果"时全局会把过渡压到近 0 时长，这里自然退成瞬时切换。
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
            // 箭头只保留 ▾ 一个字形，收起态旋转 -90°（外观即 ▸），展开时转回 0
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

/**
 * 卡片开关：走 mod 系统的 setEnabled（会持久化 + 通知 mod 自己）。
 *
 * 结果以条目状态为准：setEnabled 对"启用后加载失败"也可能返回 true，
 * 只看返回值会把"没起来"报成"已启用（立即生效）"这种假状态。
 */
function bindModToggle(box, hint) {
    box.querySelectorAll('.mod-toggle').forEach((el) => {
        el.addEventListener('change', async () => {
            const id = el.getAttribute('data-mod-id');
            // setEnabled 是 async 的：必须 await 之后再刷新，否则读到旧 state
            if (!window.ElainaMods) return;
            // 动作落点先给确认：眼睛正盯着这张卡片，立即亮一下；
            //   列表重绘会换掉卡片 DOM，重绘完成后对新卡片再补一次（见函数末尾）
            rippleCard(el);
            // 启用前记一份快照：成功后对比出"这次连带打开了哪些前置"，
            //   不说的话用户会以为插件列表"自己动了"
            const before = el.checked
                ? new Map(window.ElainaMods.list().map((p) => [p.id, p.enabled])) : null;
            // 停用被依赖的插件：有正在运行的依赖方 → 弹窗说明并把开关拨回去。
            //   拒绝本身发生在 ElainaMods.setEnabled 内部（这里是**先查**，
            //   为了把「谁在用」说给用户听 —— 只拿到 false 的话用户不知道差在哪）。
            if (!el.checked && typeof window.ElainaMods.dependentsOf === 'function') {
                const using = window.ElainaMods.dependentsOf(id);
                if (using.length) {
                    const names = using.map((p) => '「' + (p.name || p.id) + '」').join('、');
                    el.checked = true;   // 拨回去，不留"看起来关了"的假状态
                    window.setTimeout(() => showCustomAlert(names + ' 正在使用这个插件。如需关闭，请先关闭 ' + names + '。', '不能关闭'), 480);
                    return;
                }
            }
            // 开关要处理"插件不在注册表里"这种情况：
            //   setEnabled 对**不在注册表里**的插件会直接 `return false` —— 而注册表
            //   只在页面启动时建立。于是刚装好、还没被扫到的插件：开关设上了、紧接着
            //   列表重绘又按状态把它拨回去，看上去就是"按启动按钮没反应"。
            //   这里的处理：先重扫一次再重试。
            //   拒绝启动（前置拉不起来）**不走重试** —— 重扫救不了缺前置，
            //   原因已经写在条目上（下面按条目状态说明），重试只会白等一遍。
            let ok = await window.ElainaMods.setEnabled(id, el.checked);
            if (ok === false && typeof window.ElainaMods.reload === 'function') {
                const st0 = window.ElainaMods.list().find((p) => p.id === id);
                if (!(st0 && st0.error)) {
                    try { await window.ElainaMods.reload(); } catch (e) { /* 下面照常汇报 */ }
                    ok = await window.ElainaMods.setEnabled(id, el.checked);
                }
            }
            // 结果以**条目状态**为准（setEnabled 对"启用后加载失败"也返回 true，
            //   只看返回值会把"没起来"说成"已启用（立即生效）"这种假状态）
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
            // 波纹要在列表重绘之后发：重绘会换掉全部卡片 DOM，旧元素的环会跟着丢
            const refreshed = refreshModsList();
            void Promise.resolve(refreshed).then(() => {
                const fresh = box.querySelector('.mod-toggle[data-mod-id="' + id + '"]');
                if (fresh) rippleCard(fresh);
            });
        });
    });
}

/** 卡片动作按钮：说明、设置、打开目录、删除。卡片每次重绘都会换掉这些按钮，事件必须随新 DOM 重挂。 */
function bindModCardButtons(box, hint) {
    // ---- 说明（README）：点开弹窗 ----
    box.querySelectorAll('.mod-readme-btn').forEach((el) => {
        el.addEventListener('click', async () => {
            const id = el.getAttribute('data-mod-id');
            const name = el.getAttribute('data-mod-name') || id;
            await openModReadme(id, name);
        });
    });

    // ---- 启用/停用后：重渲染保持状态一致（setModEnabled 会改 state）----
    box.querySelectorAll('.mod-opensettings').forEach((el) => {
        el.addEventListener('click', () => {
            const id = el.getAttribute('data-mod-id');
            // 先走统一入口（插件自己的设置窗），没有则回退到设置子分栏
            if (window.ElainaMods && typeof window.ElainaMods.openModSettings === 'function'
                && window.ElainaMods.openModSettings(id)) {
                return;
            }
            if (typeof switchSettingsTab === 'function') switchSettingsTab('tab-' + id);
        });
    });

    // ---- 打开插件目录（POST /api/plugins/open-folder?id=…）----
    // 三件事缺一不可，缺任何一件都会表现成"点了没反应"：
    //   ① 成功时说一声（否则用户分不清"打开了但我没看见"与"什么都没发生"）
    //   ② 失败必须**写在插件列表上**（modsHint），不能弹全局 alert ——
    //      这是插件管理页自己的操作结果，和插件错误一样只落在这一页（AGENTS.md D20）
    //   ③ 失败给一个**兜底出口**：「浏览目录」把 mods/ 里的文件夹列出来，
    //      在文件管理器唤不起来（远程桌面 / 精简系统 / 非 Windows）时仍然看得到
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

    // 「浏览目录」的点击处理**不在这里**：它挂在 init.js（只执行一次）。
    //   那个按钮挨着「＋ 添加分栏」，而这里的函数每次刷新列表都会重跑 ——
    //   绑在这里就是"刷新一次多一个 handler"，点一下会连发 N 次请求。

    // 卡片上不再各放一个 ⟳，页面也没有单独的"刷新"钮：清单每次打开设置都会
    // 重扫一遍（openSettings → refreshModsList），装/删/停用后列表本身也会重画。
    // 刷新的正事由这些动作顺带完成，单独一个按钮只是让人多犹豫一次。

    // ---- 删除：调 DELETE /api/plugins/:id（删目录 + 安装包），带二次确认 ----
    box.querySelectorAll('.mod-del-btn').forEach((el) => {
        el.addEventListener('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const id = el.getAttribute('data-mod-id');
            const name = el.getAttribute('data-mod-name') || id;
            // 删除被依赖的插件：有正在运行的依赖方 → 弹窗说明，不走删除确认。
            //   （删目录救不回来 —— 关掉只是停用，随时能再开，所以顺序必须是
            //   "先关依赖方、再删"，这里把这个顺序告诉用户。）
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
                    // 同时清掉前端记录的启用状态 —— 插件都删了，那个键留着没意义
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

/** 分栏重命名/删除：删除前只数这个分栏里看得见的插件，前置扩展是固定分区、不参与归属判断。 */
function bindModGroupActions(box, normalMods, groupOf, ungroupedId, readGroups, saveGroups) {
    // ---- 分栏交互：重命名 / 删除 ----
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
            // 只数这个分栏里**看得见**的插件：前置扩展是固定分区，
            //   哪怕存储里还留着归属，也不该拦住分栏删除（界面上没它可拖）
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

/**
 * 渲染「设置 → 插件」列表。
 *
 * 数据来源两条路，缺一不可：
 *   ① 服务端 /api/plugins —— 会扫描 mods/ 并把新丢进去的 zip 解压安装，
 *      然后返回清单。这是"装了哪些 mod"的权威来源。
 *   ② 前端 window.ElainaMods.list() —— 加载器**实际加载**的结果（含每个 mod 的
 *      运行状态：ready / disabled / error）。
 *
 * 为什么要合并两者：服务端知道"磁盘上有什么"，前端知道"跑起来没有"。
 * 只看服务端会把加载失败的 mod 显示成正常；只看前端则看不到"刚丢进去还没加载"的 mod。
 * 另外 APK 端没有服务端，此时只能靠前端那份（构建时打包进去的 mod）。
 */
async function refreshModsList() {
    const box = document.getElementById('modsList');
    if (!box) return;
    const hint = document.getElementById('modsHint');
    // 平台说明随列表一起刷新（IS_NATIVE_APP 是常量，但集中在一处好维护）
    applyModsPlatformHint();
    // 技能列表与插件列表同在一屏（技能块在插件列表下方），但**是两个独立的数据源**：
    // 技能不是插件，绝不合并进下面的 fromServer —— 这里只是"刷新插件时顺带刷一下技能"。
    void refreshSkillsList();

    const merged = await loadModsEntries(hint);

    // ==================== 前置扩展（固定分区） ====================
    // 单独成区是为了它们照样能开关、看加载失败原因、卸载；混在普通列表里会让人拨开关后发现没反应。
    // 这个区是固定的（拖进分栏也会被拉回来），所以卡片不画拖拽把手。
    const { prereqMods, normalMods } = splitPrereqMods(merged);

    // ==================== 分栏（分组）数据 ====================
    // 存储模型（跨设备同步；键都已在 store.js 的 DATA_KEYS 里）：
    //     elaina_mods_groups    = [{ id, name, collapsed, fixed? }]  分栏清单（有序）
    //     elaina_mods_group_of  = { <插件id>: <分栏id> }              插件 → 分栏 归属
    //     elaina_mods_order     = [插件id...]                          插件顺序（栏内/平铺共用）
    //     elaina_mods_top_order = [{t:'mod'|'group', id}...]           顶层混排顺序
    //   未分类不是一个"栏"：没归属的插件直接平铺在顶层
    //   （不设 UNGROUPED_ID 这个栏，省得出现一个装了又空的"未分类"栏）。
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

    // 按用户拖出来的顺序排；没记过的保持清单原序
    const ORDER_KEY = 'elaina_mods_order';
    const readOrder = () => {
        try { const v = JSON.parse(Store.getItem(ORDER_KEY) || '[]'); return Array.isArray(v) ? v : []; }
        catch (e) { return []; }
    };

    const groups = readGroups();

    // ── 组装：**单一有序列表** —— 平铺插件与分栏同等级，混排（用户要求） ──
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

    // 顶层是"卡片与分栏混排"的同一层：给网格（宽屏一行多个），分栏靠类名独占整行。
    box.classList.add('mod-grid');
    box.innerHTML = topOrder.map((entry) => {
        if (entry.t === 'group') {
            const g = groups.find((x) => x.id === entry.id);
            return g ? renderGroupHtml(g, byGroup.get(g.id) || [], readOrder()) : '';
        }
        const m = looseById.get(entry.id);
        return m ? renderModCard(m) : '';
    }).join('');

    // 前置扩展区默认收起：它通常只有一两个、且用户多数时候不需要动它；
    //   展开态存内存即可（这是"这次要不要看一眼"，不是要跨设备同步的设置），
    //   但同一个页面里刷新列表（拨开关会触发）要保持用户刚展开的状态。
    // 先摘掉上一次渲染的前置块：它在网格**外面**（插到 #modsList 之后），
    //   不摘就会在每次刷新后叠一份。
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

    bindModToggle(box, hint);

    bindModCardButtons(box, hint);

    bindModGroupActions(box, normalMods, groupOf, UNGROUPED_ID, readGroups, saveGroups);

    // ---- 拖拽：栏内排序 / 拖进分栏归类 / 拖出分栏 / 顶层混排 / 分栏折叠 ----
    bindGroupDragSort(box, () => void refreshModsList(), { readGroups, saveGroups });
}


