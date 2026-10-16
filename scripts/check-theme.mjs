// 回归检查：多主题系统（源码层）。
//
// 浏览器端的行为验证在 android-app/test/theme.test.mjs（那里有 playwright）。
// 这里只做静态检查 —— 根目录脚本不依赖浏览器，这是本项目的既有约定。
//
// 盯住的几个点（都是踩过的）：
//   · 默认主题必须"不设属性"，否则覆盖层会对默认外观生效（破坏"原样不动"）
//   · 覆盖规则权重必须够 —— 项目里已有一层用 ID 选择器覆盖 indigo 类的规则，
//     类级选择器压不住它
//   · 底色在 #mainContent 而不是 body
//   · themes.css 必须排在所有样式之后
//
// 用法：node scripts/check-theme.mjs
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

console.log('=== 1. 文件与接线 ===');
{
    const themeJs = path.join(WEB, 'js', 'theme.js');
    const themesCss = path.join(WEB, 'css', 'themes.css');
    ok(existsSync(themeJs), 'web/js/theme.js 存在');
    ok(existsSync(themesCss), 'web/css/themes.css 存在');

    const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
    ok(/<script src="\/js\/theme\.js"><\/script>/.test(html), 'index.html 引入 theme.js');
    ok(/<link rel="stylesheet" href="\/css\/themes\.css">/.test(html), 'index.html 引入 themes.css');

    // ★ themes.css 必须排在所有内联 <style> 之后（同权重靠后加载胜出）
    const cssLinkIdx = html.indexOf('/css/themes.css');
    const lastStyleEnd = html.lastIndexOf('</style>');
    ok(cssLinkIdx > lastStyleEnd, '★ themes.css 排在所有内联 <style> 之后',
        'link@' + cssLinkIdx + ' lastStyleEnd@' + lastStyleEnd);

    // 设置界面容器
    ok(/id="themePickerBox"/.test(html), '设置里有 #themePickerBox');
    ok(/id="headerThemeBtn"/.test(html), '深色模式控件已移到顶栏（#headerThemeBtn）');
}

console.log('\n=== 2. 默认主题不改变外观（关键语义）===');
{
    const js = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
    // 默认主题必须走"移除属性"这条路径
    ok(/removeAttribute\('data-theme-template'\)/.test(js),
        '★ 默认主题走 removeAttribute（不设属性 → 覆盖规则一条都不生效）');
    ok(/tpl === 'elaina'/.test(js), '默认主题 elaina 被显式识别（不设 data-theme-template）');
    // 内置模板（5 预设 + 自定义）
    const ids = [...js.matchAll(/\{\s*id:\s*'(\w+)',\s*name:/g)].map((m) => m[1]);
    // ★★ 2026-10：从 7 套回到 6 套 —— 「星屑之日」已随生日模块**移出宿主**，
    //   改由插件 mods/birthday 在启用时用 `host.theme()` 注册（见 theme.js 的
    //   MOD_TEMPLATES / registerTemplate）。所以它不再是"内置模板"：不装/不启用
    //   那个插件时，主题选择器里就没有它。本次检查只数**内置**的那几套。
    ok(ids.length === 6, '定义了 6 套内置模板（5 预设 + 自定义），实得 ' + ids.length, ids.join(','));
    for (const id of ['elaina', 'ios', 'claude', 'sage', 'sakura', 'custom']) {
        ok(ids.includes(id), '含模板 ' + id);
    }
}

console.log('\n=== 3. 覆盖权重（踩过的坑）===');
{
    const css = readFileSync(path.join(WEB, 'css', 'themes.css'), 'utf8');

    // ★★ 最关键的一条：必须覆盖 --pixso-* 变量
    //
    // 第一版只覆盖了 --color-* 与 text-indigo-*，结果切主题只有聊天区变色 ——
    // 侧栏/外框/按钮/强调色全不动，视觉上"割裂"。根因是这套界面的真实配色
    // 来自另一组 --pixso-* 变量（橄榄绿/深棕方案），被引用 224 次。
    const pixsoCount = (css.match(/--pixso-/g) || []).length;
    ok(pixsoCount >= 40, '★ 覆盖 --pixso-* 变量（配色割裂的根因，实得 ' + pixsoCount + ' 处）');
    for (const v of ['--pixso-canvas', '--pixso-brown', '--pixso-green', '--pixso-orange',
        '--pixso-cream', '--pixso-line', '--pixso-panel-soft']) {
        ok(css.includes(v + ':'), '★ 覆盖 ' + v);
    }

    // ★★★ 颜色值必须与上游一致（第二版是"自己猜颜色"，导致看着难受）
    //
    // 上游那套配色是成体系调过的：主色柔和（#7aa7f0 而非饱和的 #007aff）、
    // 正文不是纯黑（#253040）、卡片底带冷调（#f7f9fc 而非纯白）。
    // 这些细节决定"看着舒不舒服"，所以逐个钉住。
    const upstreamColors = [
        ['#7aa7f0', '主按钮（上游 --pixso-green，柔和蓝）'],
        ['#4f7cf0', '主按钮深色（--pixso-green-dark）'],
        ['#dce2ea', '页面外框（--pixso-canvas）'],
        ['#253040', '正文（--pixso-brown，不是纯黑）'],
        ['#566070', '次要文字（--pixso-brown-soft）'],
        ['#f7f9fc', '卡片底（--pixso-cream，带冷调不是纯白）'],
        ['#e9eef5', '面板底（--pixso-panel）'],
        ['#d5dce6', '边框（--pixso-line）'],
        ['#0d1015', '深色页面底'],
        ['#dfe6f0', '深色正文'],
        ['#0a84ff', '深色主色'],
        ['#1c232d', '深色侧栏竖栏渐变起'],
    ];
    for (const [hex, label] of upstreamColors) {
        ok(css.includes(hex), '★ 配色照抄上游：' + label + ' = ' + hex);
    }

    // ★ 侧栏竖栏不能复用文字色变量
    //   宿主里 #sidebar::before 用的是 var(--pixso-brown)（文字色），
    //   深色下它变浅 → 竖栏变浅灰白，非常刺眼。必须单独指定。
    ok(/html\[data-theme="dark"\]\s+#sidebar::before/.test(css),
        '★ 深色下单独指定 #sidebar::before 背景（不能复用文字色变量）');

    // ★ 深色三态（浅色/深色/跟随系统）
    const themeJs = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
    ok(/DARK_MODES\s*=\s*\[[^\]]*'system'/.test(themeJs), '★ theme.js 支持三态（含 system）');
    ok(/prefers-color-scheme:\s*dark/.test(themeJs), '★ 用 matchMedia 检测系统深色偏好');
    ok(/addEventListener\('change'/.test(themeJs), '★ 监听系统主题变化（跟随系统要实时响应）');
    ok(/applyDarkMode/.test(themeJs), '落 DOM 的逻辑统一在一个入口（用户改 / 系统变都走它）');

    const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
    // ★ 2026-10：深色模式从「外观」里的三态下拉**搬到顶栏的三段连体开关**
    //   （跟随设备 / 浅色 / 深色，用户按截图设计），「跟随系统」改名为「跟随设备」。
    ok(/id="headerThemeBtn"/.test(html), '★ 外观模式开关已移到顶栏（#headerThemeBtn）');
    ok(/data-mode="system"/.test(html) && /跟随设备/.test(html), '★ 含「跟随设备」段（原跟随系统）');
    ok(/data-mode="light"/.test(html) && /data-mode="dark"/.test(html), '★ 含浅色与深色两段');
    ok(/\.is-active/.test(html), '★ 选中段有 .is-active（填充圆底）');
    ok(!/id="themeDarkMode"/.test(html), '★ 原「外观 → 深色模式」下拉已删除');

    // ★ 必须用 html[data-theme-template] body/ID 形式提升权重
    ok(/html\[data-theme-template\]\s+body\s+\.text-indigo-950/.test(css),
        '★ 用 html[attr] body .类 的形式（类级选择器压不住项目里已有的 ID 级规则）');
    // ★ 侧边栏与弹窗面板那几条 ID 级规则要单独压
    ok(/html\[data-theme-template\]\s+#sidebar\s+\.text-indigo-950/.test(css),
        '★ 单独覆盖 #sidebar 下的 indigo 类');
    ok(/html\[data-theme-template\]\s+\.modal-panel\s+\.text-indigo-950/.test(css),
        '★ 单独覆盖 .modal-panel 下的 indigo 类');

    // ★ 底色在 #mainContent 而不是 body
    ok(/html\[data-theme-template\]\s+#mainContent/.test(css),
        '★ 覆盖 #mainContent 的渐变（实测 body.backgroundImage 是 none）');

    // 深色同样要提权
    ok(/html\[data-theme="dark"\]\s+body\s+\.text-indigo-950/.test(css),
        '★ 深色模式的规则同样提权');

    // !important 仍需用于**类级**覆盖（Tailwind 运行时注入，同权重下它后加载胜出）。
    // 但注意：重写后主要靠覆盖 --pixso-* 变量生效，类级覆盖只是补充，
    // 所以这个数字**不该设得太高** —— 设高了会逼着以后往变量能解决的地方硬加 !important。
    const importantCount = (css.match(/!important/g) || []).length;
    ok(importantCount >= 20, '★ 类级覆盖使用了 !important（实得 ' + importantCount + ' 处）');

    // 深色与模板正交
    ok(/html\[data-theme="dark"\]/.test(css), '有 html[data-theme="dark"] 规则');
    ok(/html\[data-theme-template="ios"\]/.test(css) && /html\[data-theme-template="sakura"\]/.test(css),
        '四套液态玻璃模板都有变量定义');

    // ========================================================================
    // ★★ 主题变量完整性 + 硬编码白色防护（2026-10 用户报"深色下顶栏还是白的"）
    //
    // 这一组断言防的是**同一类 bug**：某处用了 `var(--pixso-xxx)`，但那个变量
    // 在深色块 / 主题块里**没被覆盖**，于是它永远停在 :root 的浅色值上。
    //
    // 实测踩到两次：
    //   ① `--pixso-surface` 只在 :root 定义（#ffffff），深色块漏了它 ——
    //      而 `#appShell` 用的正是它 → 深色下**整个应用外壳纯白**（手机全屏，等于整页白底）。
    //   ② `#mainContent > header` 直接写死 `background: #fff` —— 深色下顶栏一块白方块。
    //
    // 这类 bug 的特点是**只在某个主题/模式下才看得见**，光读代码很难发现。
    // ========================================================================

    // ① 深色块必须覆盖所有"面"级变量（漏一个就有一块浅色残留）
    //   ★ 提取块内容不能用 `indexOf('}')` —— 注释里也有 `}`，会提前截断
    //     （实测：截断后只看到前几个变量，报出 4 个假失败）。
    //     改用"花括号配对"扫描，与 check-dom-refs 里 extractBalancedObject 同理。
    function cssBlockAfter(text, marker) {
        const start = text.indexOf(marker);
        if (start < 0) return '';
        const open = text.indexOf('{', start);
        if (open < 0) return '';
        let depth = 0;
        for (let i = open; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(open + 1, i); }
        }
        return '';
    }
    const darkBlock = cssBlockAfter(css, 'html[data-theme="dark"] {');
    for (const v of ['--pixso-canvas', '--pixso-cream', '--pixso-surface', '--pixso-panel', '--pixso-panel-soft', '--pixso-line']) {
        ok(darkBlock.includes(v + ':'), '★ 深色块覆盖了 ' + v);
    }

    // ② 每套主题模板块也要覆盖"面"级变量（否则切主题后外壳仍是上个主题的白）
    //   ★ 2026-10：`stardust` 已随生日插件移出宿主（见第 2 段的说明），
    //     所以这里只查还留在 themes.css 里的这几套。
    for (const tpl of ['ios', 'claude', 'sage', 'sakura']) {
        const block = cssBlockAfter(css, `html[data-theme-template="${tpl}"] {`);
        ok(block.length > 0, `存在主题块 ${tpl}`);
        ok(block.includes('--pixso-surface:'), `★ 主题 ${tpl} 定义了 --pixso-surface（漏了会导致外壳不跟随主题）`);
    }

    // ②b ★★ 警示色变量必须在**每一处**都定义，包括 :root（2026-10 实测踩到）
    //
    //   踩坑经过：TTS 设置里加了一段警示文案（用 `style="color:#b45309"`，
    //   该写法由 #settingsPanel 的规则映射到 `var(--pixso-warn)`）。
    //   浏览器实测发现它在**默认主题**下是深棕 #4c3123、而且**深色下也不变色** ——
    //   因为 `--pixso-warn` 只在 ios/claude/sage/sakura 四个模板块与深色块里定义了，
    //   **:root（也就是默认的 elaina 外观）漏了它**。
    //   取不到值时 `var()` 落回继承色，"警示"语义直接丢掉（看起来跟普通说明一样）。
    //
    //   ★ 为什么这类漏定义特别难发现：它**只在默认主题下**出错，
    //     而开发者多半在切过主题的状态下调试；且不报错、不白屏，只是颜色不对。
    //   所以这里对 warn 全家族做"每个生效来源都要有"的断言。
    {
        // ★ 注意 index.html 里有**两个** `:root` 块（L62 的视口/安全区变量，
        //   L1514 的配色变量）。cssBlockAfter 只找**第一个**，于是第一版断言
        //   在第一个块里找 --pixso-warn，报出 4 条假失败 —— 而变量其实好好地
        //   写在第二个块里（浏览器实测颜色已正确）。
        //   所以这里把所有 :root 块**合并**起来判断，别依赖"哪个在前"。
        let rootAll = '';
        {
            let from = 0;
            for (;;) {
                const idx = html.indexOf(':root {', from);
                if (idx < 0) break;
                const block = cssBlockAfter(html.slice(idx), ':root {');
                rootAll += block + '\n';
                from = idx + 6;
            }
        }
        ok(rootAll.length > 0, '找得到 :root 块（默认外观的变量来源）');
        for (const v of ['--pixso-warn', '--pixso-warn-soft', '--pixso-warn-bg', '--pixso-warn-line']) {
            ok(rootAll.includes(v + ':'),
                `★★ :root 定义了 ${v}（漏了 → 默认主题下警示文案落回继承色、深色也不提亮）`);
        }
        // 每个模板块 + 深色块也都要有（与面级变量同样的要求）
        for (const tpl of ['ios', 'claude', 'sage', 'sakura']) {
            const block = cssBlockAfter(css, `html[data-theme-template="${tpl}"] {`);
            ok(block.includes('--pixso-warn:'), `★ 主题 ${tpl} 定义了 --pixso-warn`);
        }
        ok(darkBlock.includes('--pixso-warn:'), '★ 深色块覆盖了 --pixso-warn（深色下要提亮）');
    }

    // ③ 移动端块里不能有"写死的白色面"。
    //    为什么专挑移动端：手机是全屏 #appShell，写死的白会变成**整页白底**，
    //    而桌面端只是中间一块卡片，不明显 —— 用户就是在手机上发现顶栏发白的。
    //   ★ 块范围要用花括号配对取，不能 `slice(indexOf('@media'))` ——
    //     那样会一路包含到文件末尾的**其它**媒体查询（实测误报了 4 处别的规则）。
    const mobileBlock = cssBlockAfter(html, '@media (max-width: 860px) {');
    // 允许的白色：文字色/阴影/描边这类"非面"用途。这里只禁**大面积背景**写死纯白。
    const badWhiteBg = [];
    for (const m of mobileBlock.matchAll(/background(?:-color)?:\s*(#[fF]{3,6}|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\.[5-9]\d*\s*\))/g)) {
        const line = mobileBlock.slice(0, m.index).split('\n').length;
        // 注释里的说明文字不算（本文件有几处刻意引用旧值的注释）
        const before = mobileBlock.slice(Math.max(0, m.index - 260), m.index);
        if (/\/\*[^*]*$/.test(before)) continue;
        badWhiteBg.push(`第 ${line} 行附近: ${m[0]}`);
    }
    ok(badWhiteBg.length === 0,
        '★ 移动端块里没有写死的白色背景面（深色下会变白块，用户实测报过）',
        badWhiteBg.slice(0, 4).join('  |  '));

    // ④ ★★ 设置页里的"内联浅色底"必须被主题规则接管（2026-10 第三次踩同一类 bug）
    //
    //    这次是 Agent 权限那块：9 处说明面板用**内联 style** 写死了浅色底
    //    （rgba(249,249,255,.8) / rgba(255,247,237,.75)）与深色文字（#b45309）。
    //    浅色主题下正常，深色下就糊了 —— 因为文字那一半会被
    //    `html[data-theme="dark"] .text-indigo-700` 改成**浅色**，
    //    而底是写死的浅色 → 浅底浅字。实测六个隐私开关的标签几乎看不见。
    //
    //    修法是加一段属性选择器规则把它们换成主题变量。这里断言**那段规则还在**，
    //    并且**新增的同类面板会自动被它覆盖**（属性选择器而非逐个 class）。
    const inlineLightRules = [
        { re: /#settingsPanel \[style\*="rgba\(249,249,255"/, label: '信息类浅色面板' },
        { re: /#settingsPanel \[style\*="rgba\(255,247,237"/, label: '警示类浅色面板' },
        { re: /#settingsPanel \[style\*="color:#b45309"\]/, label: '警示文字色' },
    ];
    for (const r of inlineLightRules) {
        ok(r.re.test(html), `★ 设置页的内联浅色底被主题规则接管（${r.label}）`);
    }
    // 警示色必须是**专用变量**而不是品牌主色：
    // --pixso-orange 在 iOS 主题下是蓝色，拿它当警示色会让警告变成品牌色。
    ok(/--pixso-warn:/.test(css), '★ 定义了 --pixso-warn（警示色与品牌主色分开）');
    ok(/--pixso-warn-bg:/.test(css) && /--pixso-warn-line:/.test(css),
        '★ 警示色有配套的底与描边变量');
    // 四套主题 + 深色块都要有警示色，否则某套主题下会退回 :root 的浅色值
    for (const tpl of ['ios', 'claude', 'sage', 'sakura']) {
        const block = cssBlockAfter(css, `html[data-theme-template="${tpl}"] {`);
        ok(block.includes('--pixso-warn:'), `★ 主题 ${tpl} 定义了 --pixso-warn`);
    }
    ok(darkBlock.includes('--pixso-warn:'), '★ 深色块定义了 --pixso-warn（深色下要提亮）');
    // 深色的警示色不能还是那个浅色主题的橙 —— 在深底上对比度只有 3.7:1
    const darkWarn = (darkBlock.match(/--pixso-warn:\s*([^;]+);/) || [])[1] || '';
    ok(darkWarn.trim() !== '#b45309',
        '★ 深色的 --pixso-warn 已提亮（不能沿用浅色主题的 #b45309）', 'darkWarn=' + darkWarn.trim());

    // ⑤ ★★ 切深色必须同时设 CSS `color-scheme`（2026-10 用户报"下拉列表还是白的"）
    //
    //    症状：设置 → 对话，点开「模型名」下面那个下拉，弹出来的候选列表是
    //    **白底黑字**，与深色界面割裂。
    //
    //    为什么只改 CSS 治不了：那个下拉弹层是**浏览器原生绘制**的
    //    （Chromium 的 select popup 不在 DOM 里，任何 CSS 选择器都碰不到它）。
    //    决定它按哪套配色画的只有 `color-scheme`。实测深色下它算出来是 `normal`
    //    （从没被设过）→ 浏览器按浅色画 → 白底。
    //
    //    `color-scheme` 还一并决定滚动条、复选框、日期选择器的配色，
    //    所以必须在**主题层**统一设，而不是给每个下拉打补丁。
    ok(/colorScheme\s*=/.test(themeJs),
        '★ applyDarkMode 里设置了 CSS color-scheme（否则原生下拉/滚动条仍是浅色）');
    ok(/document\.documentElement\.style\.colorScheme\s*=\s*dark\s*\?\s*'dark'\s*:\s*'light'/.test(themeJs),
        '★ color-scheme 随深色开关切到 dark / light');
    // 浅色时也必须**显式写 light**，不能删掉：选了"跟随系统"而系统是深色时，
    // 不写 light 会让浏览器继续按系统偏好画原生控件 —— 与应用内的浅色界面矛盾。
    ok(!/style\.colorScheme\s*=\s*''/.test(themeJs) && !/removeProperty\(\s*['"]color-scheme/.test(themeJs),
        '★ 浅色时显式写 light（不能删掉，否则跟随系统时会漏回深色）');

    // ⑥ ★★★ `color-scheme` 不够！必须**显式给 option 设背景色**（2026-10 二次踩坑）
    //
    //    第一次我只加了 `color-scheme: dark`，就以为修好了 —— **没有**。
    //    真实弹层截图证明：背景仍是纯白，未选中项是浅灰字，几乎读不出来。
    //    （我当时的"验证"是错的：用 size="6" 把 select 展开成内联列表截图，
    //      那渲染的是普通列表、不是原生弹层 —— **测的不是用户看到的东西**。）
    //
    //    真正的根因：CSS 只给 `select` 设了 `color`（深色主题下是浅色），
    //    而 `<option>` **继承 color 却不继承 background** —— 背景由浏览器
    //    按默认值给（白）。于是"浅字 + 白底"。
    //    `color-scheme` 在部分 Chromium 版本/平台上仍不改变 option 的背景，
    //    所以必须显式设。
    ok(/select option/.test(css),
        '★★ 显式给 <option> 设样式（color-scheme 管不到 option 的背景）');
    {
        const optRule = css.match(/html\[data-theme="dark"\][^{]*select option[^{]*\{([^}]*)\}/);
        ok(!!optRule, '★ 深色下有 select option 规则');
        if (optRule) {
            ok(/background-color\s*:/.test(optRule[1]),
                '★★ 深色的 option 设了 background-color（只设 color 会白底浅字）');
            ok(/color\s*:/.test(optRule[1]), '深色的 option 也设了 color');
        }
        // 浅色主题同样要显式给一份：跟随系统深色时浏览器可能把 option 画成深底
        ok(/html:not\(\[data-theme="dark"\]\)[^{]*select option/.test(css),
            '★ 浅色主题也显式给了 option 配色（防"跟随系统"下浏览器画深底）');
    }
}

console.log('\n=== 3.5 主题设置独立成「外观」分栏 ===');
{
    const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
    // 上游顶部导航里就有「外观」一项；埋在「高级」里要翻两层才找到
    ok(/data-settings-tab="tab-appearance">外观</.test(html), '★ 有独立的「外观」Tab');
    ok(/id="tab-appearance"/.test(html), '有 #tab-appearance 面板');
    ok(/id="tab-appearance" class="settings-tab-panel active-panel"/.test(html),
        '★ 外观是默认激活分栏（打开设置直接看到主题）');
    const advIdx = html.indexOf('id="tab-advanced"');
    const themeIdx = html.indexOf('themeSettingsSection');
    ok(themeIdx > 0 && themeIdx < advIdx, '★ 主题设置已从「高级」移到「外观」');
    ok(/id="themePickerBox"/.test(html), '外观分栏里有模板选择器');
    ok(/id="headerThemeBtn"/.test(html), '深色切换在顶栏（#headerThemeBtn，与「整理记忆」同排）');

    // ★★★ 2026-10 默认主题的**名字与色点必须与应用实际配色一致**
    //
    // 这条防的是一次真实的不一致：`elaina`（默认主题）在 theme.js 里叫
    // 「粉紫（默认）」、色点是 ['#ec4899','#8b5cf6','#fdf2f8']，
    // 但应用实际渲染的是 index.html `:root` 那套 —— **暖米色 + 棕 + 橄榄绿**
    // （--pixso-canvas #a8b974 / --pixso-green #a7bb6c / --pixso-cream #f8f5f2）。
    // 名字/色点是"还是粉紫配色"时定的，后来 :root 换成橄榄绿**没跟着改**，
    // 于是主题选择器显示"粉紫"、点进去是绿的 —— 用户报的
    // "设置页面与对话主题对不上"就是这个。
    //
    // 判据：默认主题的三个色点必须**等于 :root 里的真实值**。
    // 这样改 :root 而忘了改 theme.js 时会立刻红。
    {
        const themeJs = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
        const tplLine = (themeJs.match(/\{ id: 'elaina',[^}]*\}/) || [''])[0];
        ok(/name: '暖米绿/.test(tplLine),
            '★ 默认主题的名字反映实际配色（不能还叫"粉紫"）', tplLine.slice(0, 60));
        // 从 index.html 的 :root 取真实值来比对
        const rootBlock = (html.match(/:root\s*\{[\s\S]*?--pixso-shadow[^;]*;/) || [''])[0];
        const val = (n) => (rootBlock.match(new RegExp('--' + n + ':\\s*([^;]+);')) || [])[1]?.trim() || '';
        const realCanvas = val('pixso-canvas');
        const realGreen = val('pixso-green');
        const realCream = val('pixso-cream');
        ok(Boolean(realCanvas && realGreen && realCream), '取到 :root 的三个基准色',
            JSON.stringify({ realCanvas, realGreen, realCream }));
        for (const [label, v] of [['canvas', realCanvas], ['green', realGreen], ['cream', realCream]]) {
            if (!v) continue;
            ok(tplLine.includes("'" + v + "'"),
                `★ 默认主题色点包含 :root 的真实 --pixso-${label}（${v}）`);
        }
        // 反向：不该再出现那套粉紫色点
        ok(!/id: 'elaina'[^}]*#ec4899/.test(themeJs),
            '★ 默认主题不再挂着粉紫色点 #ec4899');
    }

    // ★★★ 2026-10 默认主题下不该有**写死的粉紫**（用户："设置页面主题还是粉色的"）
    //
    // 这类残留查起来很费劲，因为它们是**分散**的写死颜色：
    //   · body 的粉紫渐变 `#FFF0F5→#FFE4E1→#E6E6FA`（设置遮罩 82% 不透明 → 透出来）
    //   · 一堆 `rgba(236,72,153,…)` 聚焦描边 / 边框 / 阴影
    //   · `text-pink-500` 这类 Tailwind 类（**弹窗之外**的地方没被既有规则覆盖）
    //   · `--color-primary`（#ec4899）被当强调色直接引用
    //
    // 判据：把这些"粉紫特征值"整体列出来，**除了注释以外**不许出现。
    // ★ 为什么排除注释：代码里刻意写了注释解释"原来是写死的粉"，
    //   那些注释会被正则命中（这是第三次踩"注释污染判据"，见 8.60/8.62）。
    {
        const stripComments = (s) => String(s)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        const cssNoComments = stripComments(html);
        const PINK_SIGNS = [
            { re: /#ec4899/i, label: '#ec4899' },
            { re: /#8b5cf6/i, label: '#8b5cf6' },
            { re: /#FFF0F5/i, label: '#FFF0F5（粉渐变起）' },
            { re: /rgba\(\s*236\s*,\s*72\s*,\s*153/, label: 'rgba(236,72,153)（粉）' },
            { re: /rgba\(\s*244\s*,\s*114\s*,\s*182/, label: 'rgba(244,114,182)（粉）' },
        ];
        for (const s of PINK_SIGNS) {
            ok(!s.re.test(cssNoComments),
                `★ 默认主题下没有写死的粉紫 ${s.label}（注释不计）`);
        }
        // `--color-primary` 这套只服务"自定义"主题与 Tailwind 兜底，
        // 不该被宿主样式直接当强调色用（那会在默认主题下变粉）。
        ok(!/var\(--color-primary\)|var\(--color-secondary\)|var\(--color-accent\)/.test(cssNoComments),
            '★ 宿主规则不再直接引用 --color-*（那套是粉紫，只给自定义主题/兜底用）');
    }

    // ★★★ 2026-10 所有下拉必须**统一外观**（用户："其他比如语言主题那里的下拉还是老下拉"）
    //
    // `<select>` 默认由浏览器原生绘制（Windows 是方角小箭头），
    // 与圆角输入框/组合框不一致，且深色下原生箭头不跟随。
    // 修法是 `appearance: none` + 内联 SVG 自绘三角。
    {
        const selRule = html.match(/#settingsPanel select\.modal-input[^{]*\{([^}]*)\}/);
        ok(!!selRule, '找得到「设置里所有 select」的外观规则');
        if (selRule) {
            ok(/appearance:\s*none/.test(selRule[1]), '★ 去掉原生外观（appearance: none）');
            ok(/background-image:\s*url\("data:image\/svg\+xml/.test(selRule[1]),
                '★ 用内联 SVG 自绘三角（不能靠 ::after —— select 是替换元素，伪元素不渲染）');
            ok(/padding-right:\s*34px/.test(selRule[1]),
                '★ 右侧留出 34px 给三角（否则长选项文字压到箭头上）');
        }
        // 深色下箭头要单独提亮（内联 SVG 里的 stroke 取不到 currentColor）
        ok(/html\[data-theme="dark"\][^{]*select[^{]*\{[^}]*background-image:\s*url\("data:image\/svg\+xml/.test(html),
            '★ 深色下换一份更亮的箭头 SVG');
    }

    // ★★★ 2026-10 组合框必须是**一个整体外框**（用户："下拉是一个整体而不是和输入框分成两个部分"）
    //
    // 第一版把边框画在 input 和三角按钮**各自**身上（靠 -1px 重叠骗眼睛），
    // 结果用户一眼看出是两块；而且高度还对不上（46 vs 48）。
    // 正确做法：外框画在**容器** `.model-combo-row` 上，两个子元素都不带边框。
    {
        const rowRule = html.match(/\.model-combo-row\s*\{([^}]*)\}/);
        ok(!!rowRule, '找得到 .model-combo-row 规则');
        if (rowRule) {
            ok(/border:\s*1px solid/.test(rowRule[1]), '★ 外框画在**容器**上（唯一的那个框）');
            ok(/border-radius:\s*13px/.test(rowRule[1]), '容器有圆角');
            ok(/height:\s*46px/.test(rowRule[1]),
                '★ 容器定高 46px —— 必须与普通 select **实测**一致（第一版写 48 就差了 2px）');
        }
        const inRule = html.match(/\.model-combo-input\s*\{([^}]*)\}/);
        ok(!!inRule, '找得到 .model-combo-input 规则');
        if (inRule) {
            ok(/border:\s*0\s*!important/.test(inRule[1]),
                '★ 输入区**不带边框**（它是外框里的一段，不是第二个框）');
            ok(/background:\s*transparent\s*!important/.test(inRule[1]), '输入区背景透明');
        }
        const tgRule = html.match(/\.model-combo-toggle\s*\{([^}]*)\}/);
        ok(!!tgRule, '找得到 .model-combo-toggle 规则');
        if (tgRule) {
            ok(/border:\s*0;/.test(tgRule[1]) || /border:\s*0\s*;/.test(tgRule[1]),
                '★ 三角按钮也不带边框（同上）');
            ok(/width:\s*46px/.test(tgRule[1]), '★ 三角区域够宽（46px，用户要求"大一些"）');
        }
        // 反向：老的写法（input 上写 border-top-right-radius: 0）不该回来
        ok(!/\.model-combo-input\s*\{[^}]*border-top-right-radius:\s*0/.test(html),
            '★ 没有回到"两个框拼一起"的旧写法');
    }

    // ★★★ 2026-10 导航按钮组必须**居中**（用户："导航栏应该是居中的，现在选择靠左"）
    //
    // 这条防的是一个很隐蔽的失效：`#settingsTabNav` 上写着
    // `width: max-content` + `margin: 0 auto`（本意居中），
    // 但元素上还挂着 Tailwind 的 **`flex-1`**（= `flex: 1 1 0%`）——
    // 在 flex 父容器里它会撑满整行，于是 max-content 被忽略、auto margin 无空间可分，
    // 按钮组贴在左边。实测（1440px 视口）按钮组中心偏离视口中心 **317px**。
    //
    // 修法是把 flex 改成 `0 1 auto`（让 max-content 生效）。
    // 断言两件事：
    //   ① flex 不能再是 `1 1 0%`（不能靠 flex-1 撑满）
    //   ② `justify-content` 必须仍是 flex-start —— **不能改成 center**！
    //      溢出时（手机上 9 个分栏 > 屏宽）center 会把溢出均分到两侧，
    //      左侧那半永远滚不回来（`scrollLeft` 最小是 0）。这条坑在基础规则的
    //      长注释里记着，这里反向钉住，防止有人"顺手"把它改成 center。
    {
        // ★ 取**基础** #settingsTabNav 规则块 —— 文件里有**三处**同名选择器：
        //   移动端媒体查询里的两份（只改 max-width/padding 之类）+ 基础规则一份。
        //   ★★ 提取必须用**花括号配对**，不能用 `\{([\s\S]*?)\n    \}` 这种正则：
        //      媒体查询里那份的缩进是 12 空格，而正则要求 4 空格，
        //      于是非贪婪匹配会**一路跑过它自己的 `}`**、吞进后面几百行
        //      （实测：选出的"基础规则"里混着 .settings-tab-btn 的样式，
        //        导致 flex / max-content 两条断言假失败）。
        const navBodies = [];
        for (let i = 0; i < html.length; i++) {
            if (!html.startsWith('#settingsTabNav', i)) continue;
            const open = html.indexOf('{', i);
            if (open < 0) break;
            let depth = 0;
            for (let j = open; j < html.length; j++) {
                if (html[j] === '{') depth++;
                else if (html[j] === '}') { depth--; if (depth === 0) { navBodies.push(html.slice(open + 1, j)); break; } }
            }
            i = open;
        }
        ok(navBodies.length >= 2, '找到多处 #settingsTabNav 规则（基础 + 移动端）',
            '实际 ' + navBodies.length + ' 处');
        // 基础规则 = 含 `flex:` 简写的那一份（移动端那份只有 max-width/padding）
        const body = navBodies.find((b) => /(^|\s)flex\s*:\s*\d/.test(b)) || '';
        ok(!!body, '找得到基础 #settingsTabNav 规则（含 flex 简写的那一份）');
        if (body) {
            // ★ 断言前先**剥掉注释**：这段规则里刻意写了注释解释"flex: 1 1 0% 会撑满整行"
            //   （说明为什么不能这么写），而那条注释本身会被正则命中 ——
            //   于是"不该有 flex: 1 1 0%"这条断言被**解释为什么不该有的注释**触发了。
            //   这是"注释污染判据"的第二次踩坑（第一次见 check-agent-phone.mjs）。
            const code = body
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            ok(/flex:\s*0\s+1\s+auto/.test(code),
                '★ 导航用 flex: 0 1 auto（写成 flex-1 会撑满整行、居中失效）');
            ok(!/flex:\s*1\s+1\s+0%/.test(code),
                '★ 导航不再被 flex: 1 1 0% 撑满（那会让 max-content 失效）');
            ok(/width:\s*max-content/.test(code), '导航宽度是 max-content（才能被 auto margin 居中）');
            ok(/margin:\s*0\s+auto/.test(code), '导航靠 margin: 0 auto 居中');
            ok(/justify-content:\s*flex-start/.test(code),
                '★★ justify-content 仍是 flex-start（改成 center 会让溢出部分滚不回来）');
        }
        // 元素上不能同时挂 flex-1（那是当初失效的来源）
        const navTag = html.match(/<div id="settingsTabNav"[^>]*>/);
        ok(!!navTag, '找得到 #settingsTabNav 元素');
        if (navTag) {
            ok(!/class="[^"]*\bflex-1\b/.test(navTag[0]),
                '★★ 元素上没有 flex-1（有它会盖掉 CSS 里的 flex: 0 1 auto）');
        }
    }

    // ★★ 结构完整性：各分栏不能互相嵌套
    //
    // 这条是补的回归。搬移主题块时插入的 HTML 少了一个 `>`（写成 `</div`），
    // 浏览器把它当成"未闭合的 div 开始"，**后面 8 个分栏全被嵌进了 tab-appearance**。
    // 而 CSS 是 `.settings-tab-panel{display:none}` + `.active-panel{display:block}`，
    // 表现就是"除了外观，其他设置全都不见了"。
    //
    // 这里用 div 配对算出每个分栏的范围，检查有没有谁被包在别人里面。
    const overlayStart = html.indexOf('id="settingsOverlay"');
    if (overlayStart < 0) {
        ok(false, '找不到 settingsOverlay');
    } else {
        let depth = 0, i = html.lastIndexOf('<div', overlayStart), overlayEnd = -1;
        for (; i < html.length; i++) {
            if (html.startsWith('<div', i)) { depth++; i += 3; }
            else if (html.startsWith('</div>', i)) { depth--; i += 5; if (depth === 0) { overlayEnd = i; break; } }
        }
        const region = html.slice(overlayStart, overlayEnd > 0 ? overlayEnd : html.length);
        const ids = [...region.matchAll(/id="(tab-\w+)" class="settings-tab-panel/g)].map((m) => m[1]);
        // ★ 这里数的是**宿主自带**的分栏。历史上变过几次：
        //   2026-10 起 Live2D 那一栏由插件通过 settings.tabs 插槽渲染（见 mods/live2d/），
        //   所以宿主 HTML 里从 9 变 8；同月新增宿主自带的「日志」分栏 → 回到 9；
        //   同月又把「对话 / 语音 / 视觉」三栏**合并成「模型」** → 变 7。
        //   ⚠️ 用「≥N + 断言合并本身」而不是写死数字：数字会随每次搬动失效，
        //      而真正要钉住的是"合并确实发生了、且三个旧分栏不再存在"。
        ok(ids.length >= 7, `宿主自带 ${ids.length} 个分栏（应 ≥7）`);
        // ★★ 三个模型类分栏必须已合并成 tab-model（2026-10 用户要求）
        ok(ids.includes('tab-model'), '★ 有「模型」分栏（对话 + 语音 + 视觉已合并）');
        for (const gone of ['tab-chat', 'tab-voice', 'tab-vision']) {
            ok(!ids.includes(gone), `★ 旧的 ${gone} 分栏已不存在（已并入 tab-model）`);
        }
        const l2dManifest = path.join(ROOT, 'mods', 'live2d', 'manifest.json');
        if (existsSync(l2dManifest)) {
            const l2dSrc = readFileSync(path.join(ROOT, 'mods', 'live2d', 'register.js'), 'utf8');
            // ★ 2026-10 起改用 settings.modal（独立弹窗）而不是 settings.tabs（占分栏）：
            //   插件设置全堆在主设置里会堆一排分栏，难看也难找。见 host-slots.js 的说明。
            ok(/host\.slot\('settings\.modal'/.test(l2dSrc),
                '★ Live2D 设置改由插件经 settings.modal 独立成窗（所以宿主少一个分栏是对的）');
        }

        const ranges = [];
        for (const id of ids) {
            const s = region.indexOf(`id="${id}"`);
            const divStart = region.lastIndexOf('<div', s);
            let d = 0, j = divStart, e = -1;
            for (; j < region.length; j++) {
                if (region.startsWith('<div', j)) { d++; j += 3; }
                else if (region.startsWith('</div>', j)) { d--; j += 5; if (d === 0) { e = j; break; } }
            }
            ranges.push({ id, s: divStart, e });
        }
        const nested = [];
        for (const a of ranges) {
            for (const b of ranges) {
                if (a.id === b.id) continue;
                if (a.s < b.s && b.e < a.e) nested.push(`${b.id} 嵌在 ${a.id} 里`);
            }
        }
        ok(nested.length === 0,
            '★ 各设置分栏互不嵌套（分栏被嵌套会导致"其他设置全消失"）',
            nested.slice(0, 3).join('; '));

        // 顺带查常见的标签残缺：`</div` 后面直接跟换行（少个 >）
        const brokenTag = /<\/div\s*\n/.test(region) || /<\/section\s*\n/.test(region);
        ok(!brokenTag, '★ 没有残缺的闭合标签（如 </div 少了 >）');
    }
}

console.log('\n=== 4. 同步（APK 端要用）===');
{
    const sync = readFileSync(path.join(ROOT, 'scripts', 'sync-web.mjs'), 'utf8');
    ok(/collectCssFiles/.test(sync), '★ sync-web.mjs 会同步 web/css/（否则 APK 里主题切换无效）');
    ok(/theme\.js/.test(sync) || /collectJsFiles/.test(sync),
        'js/ 是自动发现的，theme.js 会被带上');
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
