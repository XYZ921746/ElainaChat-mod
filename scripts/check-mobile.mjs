// 手机 / 桌面同一份 DOM 响应式呈现的约定检查。两类历史 bug 都从这里来：
// ① 同一设置在两个页面各摆一套入口（能力页召回下拉、我的页「对话偏好」行）；② 导航语义分叉
// （两个返回、两层卡壳、退出目标不对）。桌面窄窗口用的就是这份手机布局，两套呈现必须缝合 ——
// 这里把缝合的约定变成断言：宽度判断单一入口、分层退出链完整、「我的」入口行指向真实存在的分区、
// 二级页容器不再自画卡面。
// 用法：node scripts/check-mobile.mjs            跑全部
//       node scripts/check-mobile.mjs 断点收口   只跑名字含该子串的用例

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runChecks, ROOT } from './check-harness.mjs';

const WEB = path.join(ROOT, 'web');
const read = (p) => readFileSync(p, 'utf8');
const readJs = (name) => read(path.join(WEB, 'js', name));

/** 用例 1：断点收口 —— 宽度判断只允许走 ui.js 的 isMobile() 单一入口。 */
async function caseBreakpoint(c) {
    const ui = readJs('ui.js');
    c.ok(/const MOBILE_BREAKPOINT = 980;/.test(ui), 'ui.js 定义唯一断点 MOBILE_BREAKPOINT = 980');
    c.ok(/function isMobile\(\)/.test(ui), 'ui.js 定义 isMobile() 单一入口');

    // 所有 js 里不允许再出现裸写的 980 断点（CSS 媒体查询除外，那是同一断点的另一侧）。
    const offenders = [];
    for (const f of ['bindings.js', 'providers.js', 'shell.js', 'mobile-shell.js', 'favorites.js',
        'redesign-extras.js', 'conversations.js', 'init.js', 'settings.js', 'core.js', 'ui.js']) {
        const src = readJs(f);
        if (/innerWidth\s*<=\s*980/.test(src)) offenders.push(f + '（innerWidth）');
        if (/'\(max-width: 980px\)'/.test(src)) offenders.push(f + '（matchMedia 字面量）');
    }
    c.ok(offenders.length === 0, '★ js 里没有裸写的 980 断点（全部走 isMobile / MOBILE_BREAKPOINT）',
        offenders.length ? `\n      · ${offenders.join('\n      · ')}` : '');

    // JS 与 CSS 的断点必须同侧：CSS 的手机媒体查询仍是 980px，改 JS 断点而不改 CSS 会被这里拦下。
    const css = read(path.join(WEB, 'css', 'settings.css'))
        + read(path.join(WEB, 'css', 'mobile-shell.css'))
        + read(path.join(WEB, 'css', 'base.css'))
        + read(path.join(WEB, 'css', 'pages-luxe.css'))
        + read(path.join(WEB, 'css', 'redesign.css'));
    c.ok(css.includes('(max-width: 980px)'), 'CSS 手机媒体查询与 JS 断点同为 980px');
}

/** 用例 2：设置层的分层退出链完整（顶栏 ← 逐层退，不跳层、不落裸分栏）。 */
async function caseLayeredExit(c) {
    const bindings = readJs('bindings.js');
    c.ok(/isMobile\(\) && modelTab[\s\S]{0,200}closeModelAddPage/.test(bindings),
        '顶栏 ← 第 1 层：添加模型页先退回模型页');
    c.ok(/isMobile\(\) && modelBody[\s\S]{0,200}backFromModelDetail/.test(bindings),
        '顶栏 ← 第 2 层：提供商详情先退回列表');
    c.ok(/settingsSubpage[\s\S]{0,400}closeSettingsSubpage[\s\S]{0,400}closeSettingsPanel/.test(bindings),
        '顶栏 ← 第 3 层：分区二级页收子页后关设置（直接落回来源页，不停裸分栏）');

    const shell = readJs('mobile-shell.js');
    c.ok(/clickExisting\('closeSettings'\)/.test(shell),
        '系统返回（含安卓返回键）复用顶栏 ← 的同一套分层退出');

    const css = read(path.join(WEB, 'css', 'settings.css'));
    c.ok(/#settingsSubpageHead \{ display: none !important; \}/.test(css)
        || /#settingsSubpageHead\s*\{[^}]*display: none !important;/.test(css),
        '★ 二级页返回行整行收起（顶栏承担标题与返回，同屏不出现第二个返回）');
    c.ok(/#settingsSubpage\.settings-card \{/.test(css)
        && /#settingsSubpage\.settings-card \{[^}]*background: transparent/.test(css),
        '★ 二级页容器外壳透明（搬进来的分区自己就是卡，不再卡里套卡）');
}

/** 用例 3：「我的」入口行指向的分区 / 分栏 / 锚点真实存在。 */
async function caseMineRows(c) {
    const shellSrc = readJs('mobile-shell.js');
    const indexHtml = read(path.join(WEB, 'index.html'));

    // 收集 index.html 里真实存在的 id 与设置分栏
    const ids = new Set([...indexHtml.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
    const tabs = new Set([...indexHtml.matchAll(/data-settings-tab\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));

    // mobile-shell 里的每一行入口都要能落地：分栏存在、分区 id 存在、锚点 id 存在。
    const problems = [];
    for (const m of shellSrc.matchAll(/openSettingsSection\(\s*['"]([^'"]+)['"]\s*,\s*(?:\[)?\s*['"]([^'"]+)['"]/g)) {
        const [_, tab, sectionId] = m;
        if (!tabs.has(tab)) problems.push(`分栏不存在：${tab}`);
        if (!ids.has(sectionId)) problems.push(`分区不存在：${sectionId}`);
    }
    for (const m of shellSrc.matchAll(/openSettingsAt\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/g)) {
        const [_, tab, anchor] = m;
        if (!tabs.has(tab)) problems.push(`分栏不存在：${tab}`);
        if (anchor && !ids.has(anchor)) problems.push(`锚点不存在：${anchor}`);
    }
    c.ok(problems.length === 0, '★ 「我的」每一行入口的深链都能落地（不出现点进去是空页的死行）',
        problems.length ? `\n      · ${problems.join('\n      · ')}` : '');
}

runChecks({
    title: '手机适配约定（断点收口 / 分层退出 / 入口落地 / 二级页单壳）',
    usage: 'node scripts/check-mobile.mjs [用例名子串]',
    cases: [
        { name: '断点收口', fn: caseBreakpoint },
        { name: '分层退出', fn: caseLayeredExit },
        { name: '入口落地', fn: caseMineRows },
    ],
});
