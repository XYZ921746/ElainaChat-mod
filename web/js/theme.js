// 主题系统：CSS 变量 + !important 覆盖层。界面大量颜色写死在 Tailwind 类名里，只改变量不够。
// 所有覆盖规则挂在 html[data-theme-template="..."] 下；默认主题（elaina）即 index.html 的 :root。

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

    // 由 3 个关键色推导全套变量：用户只定主色 / 背景 / 文字，其余按色彩关系推导（深底/浅底自适应）。
    function deriveCustomVars(c) {
        const { primary, canvas, ink } = c;
        const dark = luminance(canvas) < 0.45;   // 深底主题

        // 左侧竖栏：深底 DIY 时 --pixso-brown 是浅色，需单独给略亮的表面色保持层次。
        const rail = dark ? lighten(canvas, 0.07) : ink;

        return {
            '--pixso-canvas': canvas,
            '--pixso-cream': dark ? lighten(canvas, 0.08) : lighten(canvas, 0.62),
            '--pixso-panel': dark ? lighten(canvas, 0.05) : lighten(canvas, 0.40),
            '--pixso-panel-soft': dark ? lighten(canvas, 0.07) : lighten(canvas, 0.50),
            '--pixso-surface': dark ? lighten(canvas, 0.08) : lighten(canvas, 0.62),
            '--tpl-rail': rail,
            '--pixso-brown': ink,
            '--pixso-brown-dark': dark ? lighten(ink, 0.12) : darken(ink, 0.16),
            '--pixso-brown-soft': mix(ink, canvas, dark ? 0.30 : 0.34),
            '--pixso-green': mix(primary, canvas, 0.22),
            '--pixso-green-dark': dark ? darken(primary, 0.10) : darken(primary, 0.20),
            '--pixso-orange': primary,
            '--pixso-line': dark ? lighten(canvas, 0.16) : darken(canvas, 0.14),
            '--pixso-shadow': dark
                ? '0 30px 80px rgba(0, 0, 0, 0.5), 0 6px 18px rgba(0, 0, 0, 0.3)'
                : '0 30px 80px rgba(18, 30, 50, 0.16), 0 6px 18px rgba(18, 30, 50, 0.08)',
            '--tpl-primary': primary,
            '--tpl-primary-deep': darken(primary, 0.22),
            '--tpl-primary-soft': lighten(primary, 0.28),
            '--tpl-tint': primary + '1f',   // 约 12% 透明度
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

    // DIY 落成注入 <style>：颜色运行时才知道，放 <head> 末尾天然晚于 themes.css，同权重下胜出。
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
        el.textContent = 'html[data-theme-template="custom"] {\n' + body + '\n}\n';
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

    // 圆形主题切换：从最近一次点击处铺开（View Transitions）；没有手势上下文、减少动态效果或浏览器不支持时退回瞬时切换。
    function radialTransition(mutate) {
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!document.startViewTransition || reduce || !lastPointer) { mutate(); return; }
        const root = document.documentElement;
        const r = Math.hypot(Math.max(lastPointer.x, innerWidth - lastPointer.x), Math.max(lastPointer.y, innerHeight - lastPointer.y));
        root.style.setProperty('--rd-theme-x', lastPointer.x + 'px');
        root.style.setProperty('--rd-theme-y', lastPointer.y + 'px');
        root.style.setProperty('--rd-theme-r', Math.ceil(r) + 'px');
        document.startViewTransition(mutate);
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
            } else if (!tpl) {
                // Store 里没有模板键（删库重置等）时必须摘掉回放残留，否则首帧后的页面停在快照那套模板而非默认。
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
