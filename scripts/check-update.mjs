// 版本检测回归检查：设置 → 高级「版本与更新」。
// 前端接线与说明渲染在这里断言；服务端检测逻辑（版本比较 / 资产归类 / DNS 兜底）
// 的回归由 Go 侧 internal/updatecheck 的测试覆盖。
// 用法：node scripts/check-update.mjs           跑全部
//       node scripts/check-update.mjs 接线      只跑名字含该子串的用例

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { runChecks, ROOT } from './check-harness.mjs';

const WEB = path.join(ROOT, 'web');
const read = (p) => readFileSync(p, 'utf8');

/** 用例 5：接线（路由 / 运行形态 / 版本号同步 / 平台命名）。 */
async function caseWiring(c) {
    const indexHtml = read(path.join(WEB, 'index.html'));
    const serverGo = read(path.join(ROOT, 'server', 'internal', 'httpapi', 'server.go'))
        + read(path.join(ROOT, 'server', 'internal', 'httpapi', 'update.go'))
        + read(path.join(ROOT, 'server', 'internal', 'config', 'config.go'));
    const frontJs = read(path.join(WEB, 'js', 'update-check.js'));
    const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));

    c.ok(serverGo.includes('/api/app/update'), '服务端有 /api/app/update 路由');
    c.ok(serverGo.includes('ELAINA_EDITION'), '运行形态来自 ELAINA_EDITION，只认白名单');
    c.ok(serverGo.includes('Version') && serverGo.includes('Edition'),
        'update / server-info 应答带当前版本与运行形态');
    c.ok(frontJs.includes('XYZ921746/ElainaChat-mod'), '前端仓库名与服务端默认仓库一致');
    c.ok(!/Capacitor|isNativePlatform/.test(frontJs), '前端不自己摸 Capacitor（平台判定留在 core.js，AGENTS.md D5）');
    c.ok(frontJs.includes('ElainaRuntime') && frontJs.includes('detectLocalRelay'), '走 core.js / core-relay 暴露的适配层');
    c.ok(frontJs.includes('viaBypass'), '前端展示「已绕过 hosts / DNS」的说明');
    const updatecheck = read(path.join(ROOT, 'server', 'internal', 'updatecheck', 'updatecheck.go'));
    c.ok(updatecheck.includes('PublicDNS'), '服务端具备公共 DNS 直连兜底');
    c.ok(updatecheck.includes('FindHostsHijack'), '服务端能指出 hosts 劫持的文件与行号');

    // 平台命名：电脑版 = 源码，桌面版 = exe
    c.ok(frontJs.includes('电脑版（源码运行'), '界面把源码 / 浏览器形态叫「电脑版」');
    c.ok(frontJs.includes('桌面版安装包'), '界面把 exe 包叫「桌面版」');
    c.ok(frontJs.includes('手机版 APK'), '手机版命名保留');

    c.ok(indexHtml.includes('id="updateSettingsSection"'), '高级分栏里有「版本与更新」卡片');
    c.ok(indexHtml.includes('id="appUpdateCheckBtn"'), '检查更新按钮存在');
    c.ok(indexHtml.includes('/js/update-check.js'), '前端模块已加载');
    c.ok(/notes\.innerHTML\s*=\s*R\.renderChat\(text\)/.test(frontJs),
        '★ 更新说明经 README 同一套 Markdown 渲染器写入（## / - 不会原样露出）');
    c.ok(/notes\.textContent\s*=\s*text/.test(frontJs),
        '渲染器缺失时更新说明回落为纯文本（不白屏）');
    const notesTag = /id="appUpdateNotes"[^>]*class="([^"]*)"/.exec(indexHtml);
    c.ok(Boolean(notesTag) && /\breadme-body\b/.test(notesTag[1]),
        '更新说明容器带 readme-body，复用 README 排版');
    c.ok(indexHtml.indexOf('/js/core.js') < indexHtml.indexOf('/js/update-check.js'),
        'update-check.js 排在 core.js 之后（它运行时要读 ElainaRuntime 与中转判定）');

    const footer = /id="appVersionFooter"[^>]*data-version="([^"]+)"/.exec(indexHtml);
    c.ok(Boolean(footer), '侧栏页脚带 data-version（APK 上没有 package.json，靠它读版本）');
    c.ok(footer && footer[1] === pkg.version, '页脚 data-version 与 package.json 的 version 一致');
    c.ok(footer && indexHtml.includes('v' + pkg.version + ' · 魔女之旅'), '页脚显示文本与 data-version 一致');

    // 桌面壳的形态标记：dist/ 是本地打包目录，不在本机的机器上按环境性跳过。
    const shells = [
        [path.join(ROOT, 'dist', 'Windows', 'shell', 'ShellHost.cs'), '电脑版（WebView2）'],
    ];
    for (const [file, label] of shells) {
        if (existsSync(file)) c.ok(read(file).includes('ELAINA_EDITION'), label + ' 壳标记运行形态');
        else c.ok(true, '跳过：' + label + ' 壳源码不在本机（dist/ 为本地目录）');
    }
}

/**
 * 用例 6：更新说明的渲染。Release 正文是 GitHub Markdown，不该原样露出 ## / -；
 * 用真的 readme-view.js 跑一遍，断言标题/列表/加粗渲染成标签，渲染器缺失时回落纯文本。
 */
async function caseNotesRender(c) {
    const readmeCode = read(path.join(WEB, 'js', 'readme-view.js'));
    const updateCode = read(path.join(WEB, 'js', 'update-check.js'));

    function makeEl() {
        return {
            innerHTML: '', textContent: '', href: '', className: '', target: '', rel: '',
            firstChild: null, style: {}, classList: { add() {}, remove() {} },
            appendChild() {}, setAttribute() {},
        };
    }
    function makeSandbox(withReadme) {
        const els = {};
        const sandbox = {
            console,
            document: {
                readyState: 'loading',
                getElementById: (id) => (els[id] || (els[id] = makeEl())),
                querySelector: () => null,
                addEventListener() {},
                createElement: () => makeEl(),
            },
        };
        sandbox.window = sandbox;
        if (withReadme) vm.runInNewContext(readmeCode, sandbox, { filename: 'web/js/readme-view.js' });
        vm.runInNewContext(updateCode, sandbox, { filename: 'web/js/update-check.js' });
        return { sandbox, els };
    }

    const { sandbox, els } = makeSandbox(true);
    sandbox.window.ElainaUpdate.__test__.renderResult({
        hasUpdate: true, comparable: true, latestTag: 'v2.1.0', currentVersion: '2.0.1',
        publishedAt: '2026-11-01T00:00:00Z',
        notes: '## 更新内容\n\n- 修复 **设置页**\n- 新增 [说明](https://example.com)',
        pageUrl: 'https://github.com/x/y', downloads: [],
    });
    const notes = els.appUpdateNotes;
    c.ok(/<h2[^>]*>更新内容<\/h2>/.test(notes.innerHTML), '更新说明的 ## 渲染成标题');
    c.ok(/<li[^>]*>修复 <strong>设置页<\/strong><\/li>/.test(notes.innerHTML), '更新说明的 - 与 **加粗** 渲染成列表 / 强调');
    c.ok(/<a href="https:\/\/example\.com"[^>]*>说明<\/a>/.test(notes.innerHTML), '更新说明的链接经安全渲染器输出');

    const fallback = makeSandbox(false);
    fallback.sandbox.window.ElainaUpdate.__test__.renderResult({ currentVersion: '', notes: '## 原样文本', downloads: [] });
    c.ok(fallback.els.appUpdateNotes.innerHTML === ''
        && fallback.els.appUpdateNotes.textContent === '## 原样文本',
        '渲染器缺失时更新说明按纯文本写入（不白屏）');
}

runChecks({
    title: '版本与更新（GitHub Releases 检测）',
    usage: 'node scripts/check-update.mjs [用例名子串]',
    cases: [
                                        { name: '接线', fn: caseWiring },
        { name: '更新说明渲染', fn: caseNotesRender },
    ],
});
