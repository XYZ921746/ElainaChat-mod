/* ============================================================================
 * 主题系统
 *
 * ── 为什么不用"上游那份 theme-liquid.css" ────────────────────────────────
 *
 * 实测对比过：上游 theme-liquid.css（95KB）依赖它自己的 app.css（121KB）骨架 ——
 * 类名重合率只有 60.8%，上游独有 49 个类（sw-menu / sw-seg / sw-* 设置组件）
 * 和 32 个 lg-* 变量，在我们这套 HTML 里**根本不存在**。直接套用只会得到
 * 一堆无效规则 + 部分元素变色、部分不变，比不做还难看。
 *
 * ── 实际做法：变量 + 覆盖层 ──────────────────────────────────────────────
 *
 * 我们的界面有 408 处硬编码 Tailwind 颜色类（indigo 占 229）和 294 处 CSS 变量引用。
 * 两个事实决定了实现方式：
 *
 *   ① **光改变量不够** —— 大量颜色是类名写死的（text-indigo-800 等）。
 *   ② **Tailwind 是运行时 JIT** —— 它扫 DOM 生成样式并在运行时注入 <style>，
 *      注入位置在 <head> 末尾、晚于我们的样式表。所以覆盖规则必须
 *      用 `!important` 才能稳定压住它（靠选择器权重不够，因为它后注入）。
 *
 * 于是主题 = ① 覆盖一批 CSS 变量（管那些用了变量的地方）
 *            + ② 一批 `!important` 覆盖规则（管那些写死类名的地方）
 *
 * ── 主题清单 ─────────────────────────────────────────────────────────────
 *
 *   elaina   —— **默认主题：暖米色 + 棕 + 橄榄绿**（就是 index.html 的 `:root`，
 *               不设 data-theme-template 属性时生效；详见 TEMPLATES 里那段说明。
 *               内部名 `elaina` 与"粉紫"无关，别按名字去猜配色）
 *   ios      —— 液态玻璃 · iOS 蓝（上游主视觉）
 *   claude   —— 液态玻璃 · 陶土橙
 *   sakura   —— 液态玻璃 · 樱花桃
 *
 * 深色模式是**正交**的第二个维度：data-theme="dark" 叠在任意模板上。
 *
 * ── 与"不改现有功能"的关系 ───────────────────────────────────────────────
 *
 * 默认主题是 elaina（也就是现在的样子），所有覆盖规则都在
 * `html[data-theme-template="..."]` 之下 —— 不设这个属性时**一条都不生效**。
 * 所以不选主题的用户看到的东西与改动前逐像素一致。
 * ========================================================================== */

(function () {
    'use strict';

    const TPL_KEY = 'elaina_theme_template';
    const DARK_KEY = 'elaina_theme';
    const CUSTOM_KEY = 'elaina_theme_custom';

    /** 深色模式三态 */
    const DARK_MODES = ['light', 'dark', 'system'];

    /** 系统深色偏好的媒体查询（老浏览器可能没有 matchMedia，做兜底） */
    const darkMedia = (() => {
        try { return window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null; }
        catch (e) { return null; }
    })();

    // ========================================================================
    //  颜色工具（DIY 主题要用来推导派生色）
    // ========================================================================

    /** '#rrggbb' → [r,g,b]；解析失败返回 null */
    function hexToRgb(hex) {
        const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function rgbToHex(rgb) {
        return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
    }

    /** 把 a 向 b 混合，t=0 得 a，t=1 得 b */
    function mix(a, b, t) {
        const x = hexToRgb(a), y = hexToRgb(b);
        if (!x || !y) return a;
        return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
    }

    const lighten = (hex, t) => mix(hex, '#ffffff', t);
    const darken = (hex, t) => mix(hex, '#000000', t);

    /** 相对亮度（WCAG） */
    function luminance(hex) {
        const rgb = hexToRgb(hex);
        if (!rgb) return 0;
        const c = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }

    /** 对比度（WCAG）：1 ~ 21 */
    function contrast(a, b) {
        const l1 = luminance(a), l2 = luminance(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    /**
     * DIY 主题的默认值（用户没改过时用它）。
     * 取一套中性偏冷的底，避免一上来就是奇怪的颜色。
     */
    const DEFAULT_CUSTOM = {
        primary: '#007aff',
        canvas: '#eef1f5',
        ink: '#253040',
    };

    /** 读取用户自定义主题设置 */
    function customTheme() {
        try {
            const raw = Store.getItem(CUSTOM_KEY);
            if (!raw) return { ...DEFAULT_CUSTOM };
            const o = JSON.parse(raw);
            const pick = (v, d) => (hexToRgb(v) ? v : d);
            return {
                primary: pick(o.primary, DEFAULT_CUSTOM.primary),
                canvas: pick(o.canvas, DEFAULT_CUSTOM.canvas),
                ink: pick(o.ink, DEFAULT_CUSTOM.ink),
            };
        } catch (e) { return { ...DEFAULT_CUSTOM }; }
    }

    /**
     * 由 3 个关键色推导出全套变量。
     *
     * 为什么只让用户选 3 个：整套配色有 10+ 个变量，全让用户填既麻烦又容易
     * 配出难看的组合（比如面板底比页面底还深、边框和背景同色看不见）。
     * 让用户定"主色 / 背景 / 文字"这三个最有决定性的，其余按色彩关系推导 ——
     * 这样怎么选都不会太离谱。
     *
     * 推导规则（都基于"深底还是浅底"自适应）：
     *   cream/panel  —— 卡片与面板底：浅底时比页面**更亮**，深底时**更亮一点点**
     *   brown-dark   —— 标题：比正文更强调
     *   brown-soft   —— 次要文字：正文向背景混一点，保证层次但不过淡
     *   line         —— 边框：背景向文字方向混一点点，能看见但不抢眼
     *   green        —— 主按钮渐变**起点**：主色稍向背景混，柔和一点
     *   green-dark   —— 渐变终点/悬停：主色压暗
     */
    function deriveCustomVars(c) {
        const { primary, canvas, ink } = c;
        const dark = luminance(canvas) < 0.45;   // 深底主题

        // 左侧竖栏的颜色。
        //
        // 本项目的既有设计是"深色竖栏 + 浅色内容"（用户明确说要保留这个观感）。
        // 宿主里竖栏用的是 var(--pixso-brown)，浅底时它=深色文字 → 正好是深竖栏。
        // 但**深底 DIY 时 --pixso-brown 是浅色**，竖栏会跟着变浅，与内容区
        // 形成"浅条+深底"的突兀效果。所以深底时单独给一个略亮的表面色，
        // 保持"竖栏与内容区有层次、但都在深色域内"。
        const rail = dark ? lighten(canvas, 0.07) : ink;

        return {
            // 页面与面板
            '--pixso-canvas': canvas,
            '--pixso-cream': dark ? lighten(canvas, 0.08) : lighten(canvas, 0.62),
            '--pixso-panel': dark ? lighten(canvas, 0.05) : lighten(canvas, 0.40),
            '--pixso-panel-soft': dark ? lighten(canvas, 0.07) : lighten(canvas, 0.50),
            '--pixso-surface': dark ? lighten(canvas, 0.08) : lighten(canvas, 0.62),
            // 竖栏专用（themes.css 里 DIY 那段会用它）
            '--tpl-rail': rail,
            // 文字
            '--pixso-brown': ink,
            '--pixso-brown-dark': dark ? lighten(ink, 0.12) : darken(ink, 0.16),
            '--pixso-brown-soft': mix(ink, canvas, dark ? 0.30 : 0.34),
            // 主色（按钮/强调/激活态）
            '--pixso-green': mix(primary, canvas, 0.22),
            '--pixso-green-dark': dark ? darken(primary, 0.10) : darken(primary, 0.20),
            '--pixso-orange': primary,
            // 边框
            '--pixso-line': dark ? lighten(canvas, 0.16) : darken(canvas, 0.14),
            '--pixso-shadow': dark
                ? '0 30px 80px rgba(0, 0, 0, 0.5), 0 6px 18px rgba(0, 0, 0, 0.3)'
                : '0 30px 80px rgba(18, 30, 50, 0.16), 0 6px 18px rgba(18, 30, 50, 0.08)',
            // 本文件内部用
            '--tpl-primary': primary,
            '--tpl-primary-deep': darken(primary, 0.22),
            '--tpl-primary-soft': lighten(primary, 0.28),
            '--tpl-tint': primary + '1f',   // 约 12% 透明度
            // 兼容宿主的 --color-* / --text-*
            '--color-primary': primary,
            '--color-primary-soft': lighten(primary, 0.28),
            '--text-heading': ink,
            '--text-body': mix(ink, canvas, 0.25),
            '--text-secondary': mix(ink, canvas, 0.34),
            '--text-muted': mix(ink, canvas, 0.52),
            '--text-glass-heading': ink,
            '--text-glass-body': mix(ink, canvas, 0.25),
            '--text-glass-muted': mix(ink, canvas, 0.34),
            '--ink': ink,
        };
    }

    /**
     * 把 DIY 主题落成一条注入样式。
     *
     * 为什么用注入 <style> 而不是像预设那样写在 themes.css 里：
     * 预设的颜色是固定的，能写死；DIY 的颜色在运行时才知道。
     * 注入的样式放在 <head> 末尾，天然晚于 themes.css，同权重下它胜出。
     */
    function applyCustomTheme() {
        let el = document.getElementById('elainaCustomTheme');
        if (currentTemplate() !== 'custom') {
            if (el) el.remove();
            return;
        }
        if (!el) {
            el = document.createElement('style');
            el.id = 'elainaCustomTheme';
            document.head.appendChild(el);
        }
        const vars = deriveCustomVars(customTheme());
        const body = Object.entries(vars).map(([k, v]) => '  ' + k + ': ' + v + ';').join('\n');
        el.textContent = 'html[data-theme-template="custom"] {\n' + body + '\n}\n';
    }

    /** 保存 DIY 主题设置并立即生效 */
    function setCustomTheme(partial) {
        const next = { ...customTheme(), ...partial };
        try { Store.setItem(CUSTOM_KEY, JSON.stringify(next)); } catch (e) { /* 忽略 */ }
        if (currentTemplate() !== 'custom') setTemplate('custom');
        else applyCustomTheme();
        // 必须同步编辑区：否则改了颜色后，对比度提示还是旧的 ——
        //   那正好让"字不清晰"的防线失效（提示说清晰、实际已配坏）。
        syncCustomEditor();
        return next;
    }

    /** 可选模板（顺序即设置里的显示顺序） */
    const TEMPLATES = [
        // 「elaina」是**默认主题**，名字与色点必须与应用实际渲染的配色一致。
        //
        //    为什么容易不一致：`elaina` 这个 id 的处理方式是
        //    「不设 data-theme-template 属性」（见 setTemplate 的说明），
        //    于是它落到 index.html 的 `:root` 上 —— 那是**暖米色 + 棕 + 橄榄绿**
        //    （--pixso-canvas #a8b974 / --pixso-green #a7bb6c / --pixso-brown #4c3123）。
        //    名字或色点一旦按别的配色去写，主题选择器里显示的颜色就会与
        //    点进去看到的界面不符（"设置页面与对话主题对不上"）。
        //
        //    取色口径：直接用 `:root` 里的真实值（画布 / 主色 / 卡片底），
        //      与 themes.css 里其它三套模板"色点=该模板真值"的写法保持一致。
        //      改 `:root` 配色时必须同步改这里，否则又会不一致（check-theme 有断言钉住）。
        { id: 'elaina', name: '暖米绿（默认）', dots: ['#a8b974', '#a7bb6c', '#f8f5f2'] },
        { id: 'ios', name: 'iOS 蓝', dots: ['#007aff', '#8ab4ff', '#eef1f5'] },
        { id: 'claude', name: '陶土橙', dots: ['#d97757', '#eab38f', '#f6f2ed'] },
        { id: 'sakura', name: '樱花桃', dots: ['#d97b93', '#f0b6c4', '#f8f1f3'] },
        // 「星屑之日」（生日配色）**不在这份内置清单里** ——
        //   生日模块是插件（mods/birthday），那套配色由插件在启用时通过
        //   `host.theme({ id:'stardust', vars:{…} })` 注册（见下面的 MOD_TEMPLATES）。
        //   所以它不是内置主题：不装 / 不启用那个插件时，主题选择器里就没有它。
        // DIY：颜色由用户定，色点也按用户选的实际颜色显示（renderPicker 里特殊处理）
        { id: 'custom', name: '自定义', dots: null },
    ];

    // ========================================================================
    //  插件注册的主题（host.theme）
    //
    //  ── 为什么需要 ────────────────────────────────────────────────────────
    //  主题只认 TEMPLATES 里写死的这几套时，`currentTemplate()` 会拿属性值去
    //  清单里校验，不在清单里的 id 一律回落 elaina。于是"插件想加一套配色"
    //  根本无从下手（设了没反应）。插件化的生日模块（「星屑之日」）就是
    //  需要这个能力的典型用户 —— 它不能靠往 TEMPLATES 里塞 id 来实现。
    //
    //  ── 变量从哪来 ────────────────────────────────────────────────────────
    //  宿主模板的颜色写在 themes.css 里；插件主题的颜色由
    //  `host.theme({ id, name, dots, vars })` 在运行时给。这里把 vars 落成
    //  一条注入样式：
    //      html[data-theme-template="<id>"]:not([data-theme="dark"]) { --x: y; }
    //  那个 `:not([data-theme="dark"])` 是关键：注入样式比 themes.css 晚，
    //    若不带这个守卫，同权重下它会**盖掉深色块** —— 表现为"深色模式下
    //    插件主题仍是浅色的"。加上守卫后，深色时它不匹配，深色块照常生效。
    //    （内置模板靠"写在 themes.css 前半段、深色块在后"达到同样效果。）
    //
    //  ── 生命周期 ──────────────────────────────────────────────────────────
    //  registerTemplate / unregisterTemplate 由 mods.js 的 host.theme 在插件
    //  启用/停用时调用；unregister 时若用户正停在那套配色上，会回落默认主题 ——
    //  否则会停在一套"变量已经被摘掉"的配色上（看起来像界面坏了）。
    // ========================================================================
    const MOD_TEMPLATES = [];
    /** 全部可选模板 = 内置 + 插件注册的（顺序即选择器里的显示顺序） */
    function allTemplates() { return TEMPLATES.concat(MOD_TEMPLATES); }

    /** 插件主题那条注入样式的元素（按 id 精确定位，便于摘除） */
    function modThemeStyle(id) { return document.getElementById('elainaModTheme-' + id); }

    /**
     * 注册一个插件主题模板。
     * @param {{id:string,name?:string,dots?:string[],vars?:object}} tpl
     * @returns {boolean} 是否注册成功（id 非法 / 重复时 false）
     */
    function registerTemplate(tpl) {
        try {
            const id = String(tpl && tpl.id || '').trim();
            if (!id || id === 'elaina' || id === 'custom') return false;
            if (allTemplates().some((t) => t.id === id)) return false;
            MOD_TEMPLATES.push({
                id,
                name: String(tpl.name || id),
                dots: Array.isArray(tpl.dots) ? tpl.dots : null,
                mod: true,
            });
            const vars = (tpl.vars && typeof tpl.vars === 'object' && !Array.isArray(tpl.vars)) ? tpl.vars : {};
            let el = modThemeStyle(id);
            if (!el) {
                el = document.createElement('style');
                el.id = 'elainaModTheme-' + id;
                document.head.appendChild(el);
            }
            const body = Object.keys(vars).map((k) => '  ' + k + ': ' + vars[k] + ';').join('\n');
            el.textContent = 'html[data-theme-template="' + id + '"]:not([data-theme="dark"]) {\n' + body + '\n}\n';
            refreshPicker();
            return true;
        } catch (e) { return false; }
    }

    /** 摘掉一个插件主题模板（插件停用/卸载时由 host.theme 的回调调） */
    function unregisterTemplate(id) {
        try {
            const i = MOD_TEMPLATES.findIndex((t) => t.id === id);
            if (i < 0) return false;
            // "是否正停在这套配色上"必须在**摘除之前**判定：摘完之后 currentTemplate()
            // 已经拿不到它，条件恒为 false，用户就会停在"变量已失效"的那套主题上。
            const wasCurrent = currentTemplate() === id;
            MOD_TEMPLATES.splice(i, 1);
            const el = modThemeStyle(id);
            if (el) el.remove();
            if (wasCurrent) setTemplate('elaina');
            refreshPicker();
            return true;
        } catch (e) { return false; }
    }

    /**
     * 重建主题选择器。
     * 模板清单变了（插件注册/摘除）时要重建；选择器只在设置面板里，
     * 没渲染过就跳过 —— 下次打开设置时 renderPicker 会用新清单渲染。
     */
    function refreshPicker() {
        const box = document.getElementById('themePickerBox');
        if (!box) return;
        box.dataset.filled = '';
        box.innerHTML = '';
        renderPicker();
    }

    // ========================================================================
    //  应用 / 读取
    // ========================================================================

    function currentTemplate() {
        try {
            const v = document.documentElement.getAttribute('data-theme-template')
                || Store.getItem(TPL_KEY) || 'elaina';
            return allTemplates().some((t) => t.id === v) ? v : 'elaina';
        } catch (e) { return 'elaina'; }
    }

    function setTemplate(id) {
        const tpl = allTemplates().some((t) => t.id === id) ? id : 'elaina';
        try {
            // elaina 是默认主题，**不设属性** —— 这样"没选过主题"与"选了粉紫"
            // 走的是同一条路径，不会因为属性存在与否产生细微差异
            if (tpl === 'elaina') document.documentElement.removeAttribute('data-theme-template');
            else document.documentElement.setAttribute('data-theme-template', tpl);
            Store.setItem(TPL_KEY, tpl);
        } catch (e) { /* 忽略 */ }
        // DIY 主题的变量是运行时算的，切走时要清掉注入的样式、切回来要重新注入
        applyCustomTheme();
        markPicker();
        return tpl;
    }

    /**
     * 临时把主题切到 id，并记住"切换前那套"。
     *
     * 与 setTemplate 的区别：setTemplate 是"**用户**选了这套"（会持久化，
     *   这就是新的偏好）；useTemplate 是"某个功能临时占用一下界面"—— 例如生日
     *   当天的星屑配色。之后必须能一键回到用户先前选的那套，所以这里把"切换前"
     *   记在一个槽里，restoreTemplate() 用它还原。
     *   （这个槽由主题系统自己持有，插件不必把 prevTheme 存进自己的 Store 键 ——
     *    少一处"哪份才是权威"的可能。）
     */
    let preUseTemplate = '';

    function useTemplate(id) {
        const cur = currentTemplate();
        if (cur === id) return id;
        if (!preUseTemplate) preUseTemplate = cur;
        return setTemplate(id);
    }

    /** 还原到 useTemplate 之前那套主题（没有记录则回落默认主题） */
    function restoreTemplate() {
        const back = preUseTemplate || 'elaina';
        preUseTemplate = '';
        return setTemplate(back);
    }

    function isDark() {
        try { return document.documentElement.getAttribute('data-theme') === 'dark'; } catch (e) { return false; }
    }

    /** 系统当前是否偏好深色 */
    function systemPrefersDark() {
        return darkMedia ? darkMedia.matches : false;
    }

    /**
     * 读取深色模式设置（三态）。
     *
     * 兼容旧值：老安装里只存 'dark' / 'light' 两种，现在还有 'system'。
     * 读不到或值非法时回落到 'light' —— 不会因为读失败就突然变深。
     */
    function darkMode() {
        try {
            const v = Store.getItem(DARK_KEY);
            if (DARK_MODES.includes(v)) return v;
            return 'light';
        } catch (e) { return 'light'; }
    }

    /**
     * 把"深色模式设置"落到 DOM 上。
     *
     * 单独抽出来是因为它有两个触发源：
     *   ① 用户改设置
     *   ② **系统主题变化**（选了"跟随系统"时）
     * 两条路都要走同一段逻辑，否则会出现"系统切了但界面没跟上"。
     */
    function applyDarkMode(mode) {
        const m = DARK_MODES.includes(mode) ? mode : 'light';
        const dark = m === 'dark' || (m === 'system' && systemPrefersDark());
        try {
            if (dark) document.documentElement.setAttribute('data-theme', 'dark');
            else document.documentElement.removeAttribute('data-theme');
            // 必须**同时**设 CSS `color-scheme` —— 这是"深色下原生控件仍是白的"的根因。
            //
            //   症状（用户截图）：「设置 → 模型」 里点开「模型名」下面那个下拉，
            //   弹出来的候选列表是**白底黑字**，与深色界面割裂。
            //
            //   为什么只改 CSS 没用：那个下拉弹层是**浏览器原生绘制**的
            //   （Chromium 的 select popup 不在 DOM 里，CSS 选不中它）。
            //   决定它按哪套配色画的只有 `color-scheme`。实测深色下它算出来是
            //   `normal`（从没被设置过）→ 浏览器按浅色画 → 白底。
            //
            //   同一件事还影响：滚动条、复选框/单选框、日期选择器、自动填充背景。
            //   所以这里在**主题层**统一设，一处覆盖全站 12 个 select 与所有原生控件，
            //   而不是给每个下拉写 ::-webkit-scrollbar 之类的补丁。
            //
            //   `dark` / `light` 让浏览器把原生控件按对应模式渲染；
            //   设成 `light` 而不是删掉，是因为"跟随系统但当前判为浅色"时
            //   用户的系统偏好可能仍是深色 —— 显式写 light 才能压住它。
            document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
        } catch (e) { /* 忽略 */ }
        // 不要在这里同步「外观 → 深色模式」下拉（#themeDarkMode）与它的提示
        //   （#themeDarkHint）：深色切换在顶栏，这两个元素不存在，
        //   对它们 getElementById 会变成**悬空引用**（check-dom-refs 报"HTML 里没有这个 id"）。
        //   顶栏那个三段开关由 init.js 的 markThemeSeg 同步：它监听
        //   documentElement 的 data-theme 变化，applyDarkMode 一落 DOM 它就跑，
        //   所以"跟随设备"时系统切换、以及别处改主题，选中态都能自动跟上。
        return dark;
    }

    /** 设置深色模式（三态）。on 为布尔时按旧语义映射为 dark/light */
    function setDark(on) {
        const mode = typeof on === 'string'
            ? (DARK_MODES.includes(on) ? on : 'light')
            : (on ? 'dark' : 'light');
        try { Store.setItem(DARK_KEY, mode); } catch (e) { /* 忽略 */ }
        return applyDarkMode(mode);
    }

    // 系统主题变化时，只有"跟随系统"才需要响应
    if (darkMedia) {
        const onSystemChange = () => {
            if (darkMode() === 'system') applyDarkMode('system');
        };
        // addEventListener 是标准；老 Safari 只有 addListener
        if (darkMedia.addEventListener) darkMedia.addEventListener('change', onSystemChange);
        else if (darkMedia.addListener) darkMedia.addListener(onSystemChange);
    }

    /** 启动时尽早应用（避免闪一下默认色再切换） */
    function applyStored() {
        try {
            // 深色：走统一入口（含"跟随系统"的判定）
            applyDarkMode(darkMode());
            const tpl = Store.getItem(TPL_KEY);
            if (tpl && tpl !== 'elaina' && allTemplates().some((t) => t.id === tpl)) {
                document.documentElement.setAttribute('data-theme-template', tpl);
            }
            // DIY 主题的变量要在启动时就注入，否则会先闪一下预设配色
            applyCustomTheme();
        } catch (e) { /* 忽略 */ }
    }

    // ========================================================================
    //  设置界面里的选择器
    // ========================================================================

    function markPicker() {
        const cur = currentTemplate();
        document.querySelectorAll('.theme-tpl-card').forEach((c) => {
            const on = c.getAttribute('data-tpl') === cur;
            c.classList.toggle('is-active', on);
            // 选中态描边用 `--pixso-green`，不要用 `--color-primary`（= #ec4899 粉）：
            //   应用真实配色走的是 `--pixso-*`（默认主题下是橄榄绿 #a7bb6c），
            //   用 `--color-primary` 会让被选中的主题卡片描边是**粉的**，
            //   与整个界面（以及卡片自己的色点）都不搭 —— 属于"设置页与对话界面
            //   对不上"的一处。`--pixso-green` 与其它选中态、开关、按钮同一套色。
            c.style.borderColor = on ? 'var(--pixso-green)' : 'transparent';
        });
        // DIY 编辑区只在选中「自定义」时显示 —— 不选它却摆一堆取色器会让人困惑
        const editor = document.getElementById('themeCustomEditor');
        if (editor) {
            editor.style.display = cur === 'custom' ? 'block' : 'none';
            if (cur === 'custom') syncCustomEditor();
        }
    }

    /**
     * 把主题选择器渲染进「设置 → 外观」里的容器。
     *
     * 为什么用 JS 渲染而不是写死在 HTML 里：模板清单是这一份数据，
     * 写死会出现"改了 TEMPLATES 但界面没变"。而且这样宿主 HTML 不用知道
     * 有几个主题。
     */
    function renderPicker() {
        const box = document.getElementById('themePickerBox');
        if (!box || box.dataset.filled === '1') return;
        box.dataset.filled = '1';

        const card = (t) => {
            // DIY 卡片的色点用用户当前实际选的颜色
            const dots = t.id === 'custom'
                ? [customTheme().primary, customTheme().canvas, customTheme().ink]
                : t.dots;
            const dotHtml = dots
                .map((c) => '<span style="display:block;width:10px;height:10px;border-radius:50%;background:' + c + ';box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)"></span>')
                .join('');
            return '<button type="button" class="theme-tpl-card" data-tpl="' + t.id + '" '
                + 'style="flex:0 0 auto;padding:8px 10px;border-radius:12px;border:2px solid transparent;'
                + 'background:rgba(255,255,255,.6);cursor:pointer;display:flex;flex-direction:column;gap:6px;align-items:center">'
                + '<span style="display:flex;gap:3px">' + dotHtml + '</span>'
                + '<span style="font-size:11px;color:var(--text-body);white-space:nowrap">' + t.name + '</span>'
                + '</button>';
        };

        box.innerHTML = allTemplates().map(card).join('');
        box.querySelectorAll('.theme-tpl-card').forEach((el) => {
            el.addEventListener('click', () => setTemplate(el.getAttribute('data-tpl')));
        });

        // DIY 编辑区（默认折叠，选自定义时才显示）
        const editor = document.getElementById('themeCustomEditor');
        if (editor) renderCustomEditor(editor);

        markPicker();
    }

    /**
     * 渲染 DIY 编辑区：3 个取色器 + 实时对比度提示。
     *
     * 只让用户选 3 个关键色（主色 / 背景 / 文字）—— 全套有 10+ 变量，
     * 全让填既麻烦又容易配出难看的组合。其余按色彩关系推导（见 deriveCustomVars）。
     *
     * 对比度提示是刻意加的：用户反馈过"字不清晰"，而那是**可以算出来**的
     * （WCAG 对比度）。与其让他试出来，不如直接标红提示。
     */
    function renderCustomEditor(editor) {
        if (editor.dataset.filled === '1') { syncCustomEditor(); return; }
        editor.dataset.filled = '1';
        const c = customTheme();
        const row = (key, label, hint) =>
            '<label style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-body)">'
            + '<input type="color" data-custom-key="' + key + '" value="' + c[key] + '" '
            + 'style="width:34px;height:24px;padding:0;border:1px solid var(--pixso-line);border-radius:6px;background:none;cursor:pointer">'
            + '<span style="min-width:64px">' + label + '</span>'
            + '<span style="color:var(--text-muted);font-size:10px">' + hint + '</span>'
            + '</label>';
        editor.innerHTML =
            '<div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">'
            + row('primary', '主色', '按钮 / 强调 / 激活态')
            + row('canvas', '背景', '页面底色（深色即深色主题）')
            + row('ink', '文字', '正文与标题')
            + '</div>'
            + '<div id="themeCustomWarn" style="font-size:11px;margin-top:6px;line-height:1.5"></div>'
            + '<div style="display:flex;gap:6px;margin-top:6px">'
            + '<button type="button" id="themeCustomReset" class="btn-secondary text-xs">恢复默认色</button>'
            + '</div>';

        editor.querySelectorAll('input[data-custom-key]').forEach((inp) => {
            inp.addEventListener('input', () => {
                setCustomTheme({ [inp.getAttribute('data-custom-key')]: inp.value });
                syncCustomEditor();
            });
        });
        editor.querySelector('#themeCustomReset')?.addEventListener('click', () => {
            setCustomTheme({ ...DEFAULT_CUSTOM });
            syncCustomEditor();
            // 色点也要跟着变
            const box = document.getElementById('themePickerBox');
            if (box) { box.dataset.filled = ''; box.innerHTML = ''; renderPicker(); }
        });
        syncCustomEditor();
    }

    /** 同步 DIY 编辑区：色值回填 + 对比度检查 */
    function syncCustomEditor() {
        const editor = document.getElementById('themeCustomEditor');
        if (!editor) return;
        const c = customTheme();
        editor.querySelectorAll('input[data-custom-key]').forEach((inp) => {
            const k = inp.getAttribute('data-custom-key');
            if (inp.value !== c[k]) inp.value = c[k];
        });
        const warn = editor.querySelector('#themeCustomWarn');
        if (!warn) return;
        const vars = deriveCustomVars(c);
        // 正文色 vs 卡片底 —— 这是"看不看得清"的关键一对
        const rText = contrast(vars['--pixso-brown'], vars['--pixso-cream']);
        const rBtn = contrast('#ffffff', vars['--pixso-green']);
        const msgs = [];
        if (rText < 4.5) {
            msgs.push('<span style="color:#e5484d">⚠ 正文与卡片底对比度 ' + rText.toFixed(1)
                + ':1（建议 ≥4.5，现在偏难读 —— 把「文字」调深或「背景」调浅）</span>');
        } else {
            msgs.push('<span style="color:#30a46c">✓ 正文对比度 ' + rText.toFixed(1) + ':1，清晰</span>');
        }
        if (rBtn < 3) {
            msgs.push('<span style="color:#e5484d">⚠ 按钮白字对比度 ' + rBtn.toFixed(1) + ':1（建议 ≥3）</span>');
        }
        warn.innerHTML = msgs.join('<br>');
    }

    // ========================================================================
    //  对外接口
    // ========================================================================

    window.ElainaTheme = {
        TEMPLATES,
        // 内置清单（不含插件注册的）；`templates()` 给的是**全部**
        templates: () => allTemplates(),
        allTemplates,
        // 插件主题注册：由 mods.js 的 host.theme 在启用/停用时调用
        registerTemplate,
        unregisterTemplate,
        // 临时切换 / 还原（供插件"占用一下界面再还回来"，见它们的说明）
        useTemplate,
        restoreTemplate,
        current: currentTemplate,
        set: setTemplate,
        isDark,
        setDark,
        // 深色三态：'light' | 'dark' | 'system'
        darkMode,
        setDarkMode: setDark,
        systemPrefersDark,
        applyStored,
        renderPicker,
        markPicker,
        // DIY 自定义主题
        custom: customTheme,
        setCustom: setCustomTheme,
        deriveCustom: deriveCustomVars,
        // 颜色工具（设置界面用来显示对比度，也方便测试）
        contrast,
        DEFAULT_CUSTOM,
    };

    applyStored();
    // 设置面板可能是懒加载/后插入的，DOM 就绪后再填一次
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { renderPicker(); });
    } else {
        renderPicker();
    }
})();
