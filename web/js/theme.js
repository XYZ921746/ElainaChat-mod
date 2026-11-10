// 主题系统：CSS 变量层。唯一 token 源是 themes.css 的 --rd-*（挂在 html.rd 下），
// 旧名（--pixso-* / --color-* / --text-* / --tpl-*）只是 themes.css 里的 var(--rd-*) 别名；
// 本文件负责切换 html 上的 data-theme-template / data-theme 属性。模板 id 为 custom 时还会按三个关键色
// 推导 --rd-* 并注入覆盖块 —— 选择器里已没有这一项，该分支只在旧偏好残留的那一帧起作用。
// 默认模板 majo 不设属性 —— 覆盖规则一条都不生效，直接用 themes.css 的基准值。

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

    // 由 3 个关键色推导全套 --rd-* 变量：用户只定主色 / 背景 / 文字，其余按色彩关系推导（深底/浅底自适应）。
    // 只推 --rd-*：旧名（--pixso-* / --color-* / --text-* / --tpl-*）在 themes.css 里全部是 var(--rd-*) 别名，
    // 会自动跟随；这里再写旧名就会和别名形成两套事实源。
    // 深浅只看画布亮度、不联动深色模式开关：DIY 主题的气质由用户选定的画布决定，开关只影响内置模板。
    function deriveCustomVars(c) {
        const { primary, canvas, ink } = c;
        const dark = luminance(canvas) < 0.45;   // 深底主题

        // 带透明度的颜色（边框 / 悬浮态按内置主题的透明度档取值）
        const rgba = (hex, a) => {
            const rgb = hexToRgb(hex);
            return rgb ? 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + a + ')' : hex;
        };

        // 左侧竖栏：深底 DIY 时文字色是浅色，需单独给略亮的表面色保持层次。
        const rail = dark ? lighten(canvas, 0.07) : ink;
        const accent = mix(primary, canvas, 0.22);

        return {
            // 背景 / 表面
            '--rd-bg': canvas,
            '--rd-body-bg': canvas,
            '--rd-frame-bg': canvas,
            '--rd-frame-border': dark ? lighten(canvas, 0.16) : darken(canvas, 0.14),
            '--rd-topbar-bg': rgba(canvas, dark ? 0.85 : 0.9),
            '--rd-surface': dark ? lighten(canvas, 0.08) : lighten(canvas, 0.62),
            '--rd-surface-2': dark ? lighten(canvas, 0.05) : lighten(canvas, 0.40),
            '--rd-surface-3': dark ? lighten(canvas, 0.12) : lighten(canvas, 0.30),
            '--rd-panel': dark ? lighten(canvas, 0.05) : lighten(canvas, 0.40),
            '--rd-list-bg': dark ? lighten(canvas, 0.03) : lighten(canvas, 0.40),
            '--rd-input': dark ? 'rgba(255, 255, 255, .03)' : 'rgba(255, 255, 255, .55)',
            // 文字
            '--rd-text': ink,
            '--rd-text-2': mix(ink, canvas, 0.34),
            '--rd-text-3': mix(ink, canvas, 0.52),
            // 主色系（主色向画布收 22% 再上场：纯主色在浅底上过艳，与内置主题同档）
            '--rd-accent': accent,
            '--rd-accent-strong': dark ? darken(primary, 0.10) : darken(primary, 0.20),
            '--rd-accent-soft': rgba(primary, 0.12),
            '--rd-accent-border': rgba(primary, 0.22),
            '--rd-accent-contrast': dark ? '#191307' : '#fff9ec',
            '--rd-accent-2': primary,
            '--rd-accent-2-soft': rgba(primary, 0.12),
            // 描边 / 交互态
            '--rd-border': dark ? lighten(canvas, 0.16) : darken(canvas, 0.14),
            '--rd-border-strong': dark ? lighten(canvas, 0.28) : darken(canvas, 0.26),
            '--rd-hover': dark ? 'rgba(255, 255, 255, .04)' : 'rgba(0, 0, 0, .045)',
            '--rd-active': rgba(primary, 0.08),
            '--rd-active-border': rgba(primary, 0.16),
            // 气泡
            '--rd-user-bubble': dark
                ? 'linear-gradient(135deg, ' + lighten(primary, 0.08) + ', ' + darken(primary, 0.15) + ')'
                : 'linear-gradient(135deg, ' + lighten(ink, 0.10) + ', ' + darken(ink, 0.12) + ')',
            '--rd-user-text': dark ? '#1a1408' : '#f6efdf',
            '--rd-user-border': 'rgba(255, 255, 255, .08)',
            '--rd-ai-bubble': dark ? 'rgba(255, 255, 255, .045)' : 'rgba(255, 255, 255, .64)',
            '--rd-ai-border': dark ? 'rgba(255, 255, 255, .06)' : rgba(darken(canvas, 0.14), 0.35),
            // 竖栏
            '--rd-rail-bg': rail,
            '--rd-rail-bg-2': dark ? canvas : darken(ink, 0.12),
            '--rd-rail-text': dark ? 'rgba(240, 232, 216, .48)' : 'rgba(255, 255, 255, .55)',
            '--rd-rail-active': rgba(primary, 0.16),
            '--rd-rail-active-text': dark ? lighten(primary, 0.20) : lighten(primary, 0.35),
            // 阴影 / 光晕 / 遮罩
            '--rd-shadow-1': dark
                ? '0 1px 2px rgba(0, 0, 0, .2), 0 6px 18px rgba(0, 0, 0, .14)'
                : '0 1px 2px rgba(18, 30, 50, .05), 0 6px 18px rgba(18, 30, 50, .045)',
            '--rd-shadow-2': dark
                ? '0 30px 80px rgba(0, 0, 0, 0.5), 0 6px 18px rgba(0, 0, 0, 0.3)'
                : '0 30px 80px rgba(18, 30, 50, 0.16), 0 6px 18px rgba(18, 30, 50, 0.08)',
            '--rd-btn-shadow': '0 2px 8px ' + rgba(primary, 0.18),
            '--rd-glow-1': rgba(primary, 0.2),
            '--rd-glow-2': rgba(mix(ink, canvas, 0.52), 0.1),
            '--rd-overlay': dark ? 'rgba(0, 0, 0, .55)' : 'rgba(20, 15, 8, .35)',
            // 提示条 / 选中 / 滚动条
            '--rd-toast-bg': dark ? lighten(canvas, 0.15) : darken(ink, 0.10),
            '--rd-toast-fg': dark ? ink : '#f6efdf',
            '--rd-selection': rgba(primary, 0.24),
            '--rd-scroll': dark ? 'rgba(255, 255, 255, .18)' : rgba(darken(canvas, 0.2), 0.4),
            // 头像
            '--rd-avatar-ai-bg': dark ? lighten(canvas, 0.15) : darken(ink, 0.10),
            '--rd-avatar-ai-fg': accent,
            '--rd-avatar-ai-border': rgba(primary, 0.3),
            '--rd-avatar-user-bg': dark ? lighten(canvas, 0.12) : lighten(canvas, 0.30),
            '--rd-avatar-user-fg': mix(ink, canvas, 0.34),
            '--rd-avatar-user-border': dark ? lighten(canvas, 0.28) : darken(canvas, 0.26),
        };
    }

    // DIY 落成注入 <style>：颜色运行时才知道，放 <head> 末尾天然晚于 themes.css。
    // 选择器必须带 .rd（与 html.rd[data-theme="dark"] 同为 0-2-1）：不带会被深色块按特异性压过，
    // DIY 主题一开深色就退回内置深色配色。
    function applyCustomTheme() {
        let el = document.getElementById('elainaCustomTheme');
        if (currentTemplate() !== 'custom') {
            if (el) el.remove();
            saveBootSnapshot();
            return;
        }
        if (!el) {
            el = document.createElement('style');
            el.id = 'elainaCustomTheme';
            document.head.appendChild(el);
        }
        const vars = deriveCustomVars(customTheme());
        const body = Object.entries(vars).map(([k, v]) => '  ' + k + ': ' + v + ';').join('\n');
        el.textContent = 'html.rd[data-theme-template="custom"] {\n' + body + '\n}\n';
        saveBootSnapshot();
    }

    /** 保存 DIY 主题设置并立即生效 */
    function setCustomTheme(partial) {
        const next = { ...customTheme(), ...partial };
        try { Store.setItem(CUSTOM_KEY, JSON.stringify(next)); } catch (e) { /* 忽略 */ }
        if (currentTemplate() !== 'custom') setTemplate('custom');
        else applyCustomTheme();
        // 必须同步编辑区，否则对比度提示还是旧的，防线失效。
        syncCustomEditor();
        return next;
    }

    /** 可选模板（顺序即设置里的显示顺序） */
    const TEMPLATES = [
        // 默认主题不设 data-theme-template；色点必须与 :root / themes.css 的真实值一致。
        { id: 'majo', name: '暗夜魔女书房', dots: ['#f4eee1', '#8a6a1f', '#fbf7ee'], desc: '羊皮纸 · 金线 · 夜航星点' },
        { id: 'olive', name: '暖米绿', dots: ['#a8b974', '#738746', '#f8f5f2'], desc: '橄榄绿画布 · 奶油纸面 · 原版本色' },
        { id: 'mist', name: '雾蓝日系', dots: ['#eef5fa', '#4d8fb4', '#ffffff'], desc: '雾面 · 柔蓝 · 轻小说' },
        { id: 'glass', name: '石墨玻璃', dots: ['#0b0d12', '#a4b8ff', '#151d27'], desc: '深灰 · 玻璃 · 冷光' },
    ];

    // 插件注册的主题（host.theme）：颜色由插件运行时给，落成 html[data-theme-template="<id>"]:not([data-theme="dark"]) 注入样式。
    // 那个 :not([data-theme="dark"]) 是关键：注入样式晚于 themes.css，不带守卫会盖掉深色块；unregister 时正停在这套配色上会回落默认。
    const MOD_TEMPLATES = [];
    function allTemplates() { return TEMPLATES.concat(MOD_TEMPLATES); }

    function modThemeStyle(id) { return document.getElementById('elainaModTheme-' + id); }

    function registerTemplate(tpl) {
        try {
            const id = String(tpl && tpl.id || '').trim();
            if (!id || id === 'majo' || id === 'elaina' || id === 'custom') return false;
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
            // 插件注册一定晚于启动时的 applyStored：那一刻这个 id 还不在清单里，属性已被当成"下线模板"摘掉。
            // 用户存的选择仍然是它，模板一可用就得把属性补回去，否则刷新后一直停在默认配色。
            try {
                if (Store.getItem(TPL_KEY) === id) {
                    document.documentElement.setAttribute('data-theme-template', id);
                    saveBootSnapshot();
                }
            } catch (e) { /* 存储不可用：模板仍进选择器，选中后由 setTemplate 落属性 */ }
            refreshPicker();
            return true;
        } catch (e) { return false; }
    }

    /** 摘掉一个插件主题模板（插件停用/卸载时由 host.theme 的回调调） */
    function unregisterTemplate(id) {
        try {
            const i = MOD_TEMPLATES.findIndex((t) => t.id === id);
            if (i < 0) return false;
            // 必须在摘除之前判定用户是否正停在这套配色上，摘完 currentTemplate() 就拿不到它了。
            const wasCurrent = currentTemplate() === id;
            MOD_TEMPLATES.splice(i, 1);
            const el = modThemeStyle(id);
            if (el) el.remove();
            if (wasCurrent) setTemplate('majo');
            refreshPicker();
            return true;
        } catch (e) { return false; }
    }

    function refreshPicker() {
        const box = document.getElementById('themePickerBox');
        if (!box) return;
        box.dataset.filled = '';
        box.innerHTML = '';
        renderPicker();
    }

    function currentTemplate() {
        try {
            const v = document.documentElement.getAttribute('data-theme-template')
                || Store.getItem(TPL_KEY) || 'majo';
            return allTemplates().some((t) => t.id === v) ? v : 'majo';
        } catch (e) { return 'majo'; }
    }

    // 最近一次指针落点：主题切换的圆形揭示从"用户点的那一下"扩散出去
    let lastPointer = null;
    window.addEventListener('pointerdown', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);

    // 正在播放的转场数：连点深浅时 Chromium 自动跳过旧转场重拍快照，计数保证
    // rd-theme-switching 一直挂到最后一轮结束，不会中途把过渡/毛玻璃放回来。
    let vtActive = 0;

    // 圆形主题切换：从最近一次点击处铺开（View Transitions）；没有手势上下文、减少动态效果或浏览器不支持时退回瞬时切换。
    function radialTransition(mutate) {
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!document.startViewTransition || reduce || !lastPointer) { mutate(); return; }
        const root = document.documentElement;
        const r = Math.hypot(Math.max(lastPointer.x, innerWidth - lastPointer.x), Math.max(lastPointer.y, innerHeight - lastPointer.y));
        root.style.setProperty('--rd-theme-x', lastPointer.x + 'px');
        root.style.setProperty('--rd-theme-y', lastPointer.y + 'px');
        root.style.setProperty('--rd-theme-r', Math.ceil(r) + 'px');
        vtActive += 1;
        root.classList.add('rd-theme-switching');
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            vtActive = Math.max(0, vtActive - 1);
            if (!vtActive) root.classList.remove('rd-theme-switching');
        };
        let vt;
        try { vt = document.startViewTransition(mutate); }
        catch (e) { mutate(); done(); return; }
        vt.finished.then(done, done);
        // 兜底：标签页切后台时 finished 可能迟迟不落定，类挂死会让过渡一直缺席
        window.setTimeout(done, 900);
    }

    function setTemplate(id) {
        const tpl = allTemplates().some((t) => t.id === id) ? id : 'majo';
        try {
            const prevTpl = document.documentElement.getAttribute('data-theme-template') || 'majo';
            const mutate = () => {
                // majo 是默认主题，不设属性，让"没选过"与"选了它"走同一条路径。
                if (tpl === 'majo') document.documentElement.removeAttribute('data-theme-template');
                else document.documentElement.setAttribute('data-theme-template', tpl);
                applyCustomTheme();
                // 选中框必须在这里更新：View Transitions 下 mutate 是异步的，外面同步读到的还是旧主题。
                markPicker();
                saveBootSnapshot();
            };
            if (prevTpl !== tpl) radialTransition(mutate);
            else mutate();
            Store.setItem(TPL_KEY, tpl);
            requestAnimationFrame(markPicker);
            window.setTimeout(markPicker, 520);
        } catch (e) { /* 忽略 */ }
        return tpl;
    }

    // 与 setTemplate 的区别：setTemplate 是用户选了这套（持久化）；useTemplate 是功能临时占用界面，切换前那套由主题系统自己记。
    let preUseTemplate = '';

    function useTemplate(id) {
        const cur = currentTemplate();
        if (cur === id) return id;
        if (!preUseTemplate) preUseTemplate = cur;
        return setTemplate(id);
    }

    /** 还原到 useTemplate 之前那套主题（没有记录则回落默认主题） */
    function restoreTemplate() {
        const back = preUseTemplate || 'majo';
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

    // 深色模式三态；兼容只存 dark/light 的老安装，读不到或非法回落 light。
    function darkMode() {
        try {
            const v = Store.getItem(DARK_KEY);
            if (DARK_MODES.includes(v)) return v;
            return 'light';
        } catch (e) { return 'light'; }
    }

    /** meta theme-color 只认这里：不跟随主题的话 PWA 标题栏 / 移动端地址栏会一直停在 HTML 里写死的浅色值。 */
    function syncThemeColorMeta() {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (!meta) return;
        let canvas = '';
        try {
            canvas = getComputedStyle(document.documentElement).getPropertyValue('--pixso-canvas').trim();
        } catch (e) { /* 读不到就保持原值 */ }
        if (canvas) meta.setAttribute('content', canvas);
    }

    // 启动快照：把算好的呈现结果（属性 + 自定义变量文本）存进 sessionStorage，供 index.html 的内联脚本在首帧渲染前回放。
    // 快照只在这里维护，内联脚本机械回放、不含主题逻辑 —— 避免主题推导逻辑出现两份。
    const BOOT_KEY = 'elaina_theme_boot';
    function saveBootSnapshot() {
        try {
            const root = document.documentElement;
            const custom = document.getElementById('elainaCustomTheme');
            sessionStorage.setItem(BOOT_KEY, JSON.stringify({
                template: root.getAttribute('data-theme-template') || null,
                dark: root.getAttribute('data-theme') || null,
                colorScheme: root.style.colorScheme || null,
                css: custom ? custom.textContent : '',
            }));
        } catch (e) { /* sessionStorage 不可用（隐私模式等）只损失首帧回放，不影响正常使用 */ }
    }

    // 两个触发源（用户改设置、系统主题变化）必须走同一段逻辑。
    function applyDarkMode(mode) {
        const m = DARK_MODES.includes(mode) ? mode : 'light';
        const dark = m === 'dark' || (m === 'system' && systemPrefersDark());
        try {
            const wasDark = document.documentElement.getAttribute('data-theme') === 'dark';
            const mutate = () => {
                if (dark) document.documentElement.setAttribute('data-theme', 'dark');
                else document.documentElement.removeAttribute('data-theme');
                // 必须同时设 CSS color-scheme：原生控件（select 弹层、滚动条、日期选择器）只认它，改 CSS 选不中。
                // 显式写 light 而不是删掉，才能压住"跟随系统但当前判为浅色"时的系统深色偏好。
            document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
                syncThemeColorMeta();
                saveBootSnapshot();
            };
            if (wasDark !== dark) radialTransition(mutate);
            else mutate();
        } catch (e) { /* 忽略 */ }
        // 不要在这里同步 #themeDarkMode / #themeDarkHint：深色切换在顶栏，这两个元素不存在，顶栏开关由 init.js 的 markThemeSeg 同步。
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

    if (darkMedia) {
        const onSystemChange = () => {
            if (darkMode() === 'system') applyDarkMode('system');
        };
        if (darkMedia.addEventListener) darkMedia.addEventListener('change', onSystemChange);
        else if (darkMedia.addListener) darkMedia.addListener(onSystemChange);
    }

    /** 启动时尽早应用（避免闪一下默认色再切换） */
    function applyStored() {
        try {
            applyDarkMode(darkMode());
            const tpl = Store.getItem(TPL_KEY);
            if (tpl && tpl !== 'majo' && allTemplates().some((t) => t.id === tpl)) {
                document.documentElement.setAttribute('data-theme-template', tpl);
            } else {
                // 其余三种情形都要摘掉首帧回放的残留属性：没存过（删库重置）、存的就是默认 majo（默认不设属性）、
                // 存的是已下线的模板 id（已移除的自定义主题、被卸掉的插件主题）。留着会让页面停在快照那套模板上，
                // 而那个 id 已经没有任何变量定义。
                document.documentElement.removeAttribute('data-theme-template');
            }
            applyCustomTheme();
            saveBootSnapshot();
        } catch (e) { /* 忽略 */ }
    }

    function markPicker() {
        const cur = currentTemplate();
        document.querySelectorAll('.theme-tpl-card').forEach((c) => {
            c.classList.toggle('is-active', c.getAttribute('data-tpl') === cur);
        });
        const editor = document.getElementById('themeCustomEditor');
        if (editor) {
            editor.style.display = cur === 'custom' ? 'block' : 'none';
            if (cur === 'custom') syncCustomEditor();
        }
    }

    // 用 JS 渲染选择器：模板清单只有这一份，写死在 HTML 里会出现"改了 TEMPLATES 但界面没变"。
    function renderPicker() {
        const box = document.getElementById('themePickerBox');
        if (!box || box.dataset.filled === '1') return;
        box.dataset.filled = '1';

        const card = (t) => {
            const dots = Array.isArray(t.dots) && t.dots.length >= 3
                ? t.dots
                : ['#8a8f98', '#b8bcc4', '#f4f4f5'];
            const previewClass = ['majo', 'olive', 'mist', 'glass'].indexOf(t.id) >= 0
                ? ' rd-pv-' + t.id
                : '';
            const previewStyle = previewClass
                ? ''
                : '--pv-bg:' + dots[0] + ';--pv-accent:' + dots[1] + ';--pv-list:' + dots[2];
            return '<button type="button" class="theme-tpl-card" data-tpl="' + t.id + '">'
                + '<span class="theme-tpl-preview' + previewClass + '" style="' + previewStyle + '" aria-hidden="true">'
                + '<span class="rd-tpl-rail"></span>'
                + '<span class="rd-tpl-list"></span>'
                + '<span class="rd-tpl-main"><i></i><i></i><i></i></span>'
                + '</span>'
                + '<span class="theme-tpl-name">' + t.name + '</span>'
                + (t.desc ? '<span class="theme-tpl-desc">' + t.desc + '</span>' : '')
                + '</button>';
        };

        box.innerHTML = allTemplates().map(card).join('');
        box.querySelectorAll('.theme-tpl-card').forEach((el) => {
            el.addEventListener('click', () => setTemplate(el.getAttribute('data-tpl')));
        });

        const editor = document.getElementById('themeCustomEditor');
        if (editor) renderCustomEditor(editor);

        markPicker();
    }

    // DIY 编辑区：3 个取色器 + 实时对比度提示（WCAG），只让选 3 个关键色。
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

    window.ElainaTheme = {
        TEMPLATES,
        templates: () => allTemplates(),
        allTemplates,
        registerTemplate,
        unregisterTemplate,
        useTemplate,
        restoreTemplate,
        current: currentTemplate,
        set: setTemplate,
        isDark,
        setDark,
        darkMode,
        setDarkMode: setDark,
        systemPrefersDark,
        applyStored,
        renderPicker,
        markPicker,
        custom: customTheme,
        setCustom: setCustomTheme,
        deriveCustom: deriveCustomVars,
        // 颜色工具（设置界面用来显示对比度，也方便测试）
        contrast,
        DEFAULT_CUSTOM,
    };

    // 求值阶段 Store 缓存还是空的（bootstrap 在 init.js 里才跑）：此时应用只会把内联脚本回放好的首帧外观拉回默认值。
    // 真实应用由 init.js 在 bootstrap 之后调 applyStored 负责；首次访问没有快照时，首帧仍走默认主题，读完数据即校准。
    if (window.Store && typeof Store.isBooted === 'function' && Store.isBooted()) {
        applyStored();
    }
    // 设置面板可能是懒加载/后插入的，DOM 就绪后再填一次。
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { renderPicker(); });
    } else {
        renderPicker();
    }
})();
