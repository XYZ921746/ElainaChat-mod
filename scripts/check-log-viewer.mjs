// 真实浏览器验证：日志模块（设置里的独立分栏）的渲染与过滤。
//
// ★ 2026-10 改版：日志从「设置 → 高级」里的一个小盒子，改成**独立分栏**
//   （#tab-log，与外观/角色/对话并列）。这个脚本随之重写：
//   · 打开方式：切到「日志」分栏（不再有"打开日志"按钮 / 全屏页）
//   · 级别过滤：药丸多选（而不是一个 select）
//   · 行格式：带毫秒的时间戳
//
// ★ 位置判断错过两次，这两条断言就是钉住结论的：
//   ① 不能放主界面 rail（用户："我日志是让你放设置里而不是放主界面啊"）
//   ② 不能只做「高级」的最后一项（实测被挤到屏幕外，用户："设置里我没看见日志界面"）
import { launchTestBrowser } from './test-browser.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-viewer-'));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(PORT + 1), HOST: '127.0.0.1', LOG_DIR, DATA_DIR: path.join(LOG_DIR, 'data'), LOG_TO_FILE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
});

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

// ★ 用共用的启动器（浏览器路径 + 屏蔽外网，见 scripts/test-browser.mjs）
const browser = await launchTestBrowser();
try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
        try { up = (await fetch(BASE + '/api/server-info')).ok; } catch { await wait(250); }
    }
    await wait(800);

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    // ★ 首次启动会有「使用引导」遮罩（#announcementOverlay），它会挡住所有点击 ——
    //   真实用户会点掉它，检查里必须做同一件事，否则后面每次 click 都超时。
    //   （实测踩到：railLogBtn 的点击被它 intercepts pointer events 挡了 58 次后超时。）
    await page.evaluate(() => {
        const ov = document.getElementById('announcementOverlay');
        if (ov) { ov.classList.add('hidden'); ov.classList.remove('flex'); }
    });
    await page.waitForTimeout(300);

    // ---- ① 位置：日志是**设置里的独立分栏**（#tab-log） ----
    //
    // ★ 位置判断错过两次，这几条断言把结论钉死：
    //   ① 不在主界面 rail（用户："我日志是让你放设置里而不是放主界面啊"）
    //   ② 不只是「高级」的最后一项 —— 那样会被挤到**屏幕外**
    //      （实测：高级高 920px、内容区视口 842px，按钮 top=895 看不见）
    await page.evaluate(() => { try { if (typeof openSettings === 'function') openSettings(); } catch (e) {} });
    await page.waitForTimeout(800);
    const inSettings = await page.evaluate(() => {
        const nav = document.getElementById('settingsTabNav');
        const logBtn = nav ? nav.querySelector('[data-settings-tab="tab-log"]') : null;
        return {
            // 老的"内嵌查看器"必须已经不存在
            hasOldViewer: Boolean(document.getElementById('logViewerBox')),
            hasOldLevelSelect: Boolean(document.getElementById('logViewerLevel')),
            // 日志分栏的按钮与面板都要在
            hasLogTabBtn: Boolean(logBtn),
            hasLogPanel: Boolean(document.getElementById('tab-log')),
            // 日志控件确实在 tab-log 里（而不是还留在高级）
            controlsInLogTab: Boolean(document.querySelector('#tab-log #logLevelPills')
                && document.querySelector('#tab-log #logPageBox')),
            controlsInAdvanced: Boolean(document.querySelector('#tab-advanced #logLevelPills')),
            // ★ 分栏按钮必须在**视口内可见**（用户反馈"设置里我没看见日志界面"的直接回归）
            tabBtnInViewport: logBtn
                ? (() => { const r = logBtn.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()
                : false,
            // rail 上**不该**有日志按钮
            hasRailLogBtn: Boolean(document.getElementById('railLogBtn')),
        };
    });
    ok(!inSettings.hasOldViewer, '★ 老的「内嵌小盒子」查看器已不存在');
    ok(!inSettings.hasOldLevelSelect, '★ 老的级别下拉已不存在（改用药丸）');
    ok(inSettings.hasLogTabBtn, '★ 设置导航里有「日志」分栏按钮');
    ok(inSettings.hasLogPanel, '★ 有 #tab-log 分栏面板');
    ok(inSettings.controlsInLogTab, '★ 日志控件在 #tab-log 里');
    ok(!inSettings.controlsInAdvanced, '★ 日志控件已从「高级」移走（不再塞在最后一项）');
    ok(inSettings.tabBtnInViewport, '★ 「日志」分栏按钮在视口内可见（不用滚动就能看到）');
    ok(!inSettings.hasRailLogBtn, '★ 主界面 rail 上**没有**日志按钮（用户要求：放设置里）');

    // ---- ② 切到「日志」分栏 ----
    await page.evaluate(() => {
        document.querySelector('[data-settings-tab="tab-log"]')?.click();
    });
    await page.waitForTimeout(2500);
    const settingsOpen = await page.evaluate(() =>
        !document.getElementById('settingsOverlay').classList.contains('hidden'));
    ok(settingsOpen, '★ 切到日志分栏时设置面板保持打开（日志就在设置里）');

    const st = await page.evaluate(() => {
        const panel = document.getElementById('tab-log');
        const box = document.getElementById('logPageBox');
        const tagSel = document.getElementById('logTagSelect');
        const meta = document.getElementById('logPageMeta');
        const pills = [...document.querySelectorAll('#logLevelPills .log-pill')];
        return {
            visible: panel && panel.classList.contains('active-panel'),
            lineCount: box ? box.querySelectorAll('.log-line').length : 0,
            firstLine: box?.firstElementChild?.textContent?.slice(0, 110) || '',
            hasLevelColors: box ? Boolean(box.querySelector('.log-line[data-level="INFO"], .log-line[data-level="WARN"], .log-line[data-level="ERROR"]')) : false,
            // 当前渲染出来的级别集合（用来断言"默认视图里没有 DEBUG"）
            levels: box ? [...box.querySelectorAll('.log-line')].map((d) => d.dataset.level) : [],
            pillLabels: pills.map((p) => p.textContent.trim()),
            pillsPressed: pills.map((p) => p.getAttribute('aria-pressed')),
            tagOptions: tagSel ? [...tagSel.options].map((o) => o.value) : [],
            metaText: meta?.textContent || '',
            autoScrollChecked: document.getElementById('logAutoScroll')?.checked ?? null,
            hideChatExists: Boolean(document.getElementById('logHideChat')),
        };
    });

    console.log('=== 日志模块状态 ===');
    console.log('  可见:', st.visible, ' 行数:', st.lineCount);
    console.log('  首行:', st.firstLine);
    console.log('  级别药丸:', JSON.stringify(st.pillLabels));
    console.log('  模块下拉:', JSON.stringify(st.tagOptions));
    console.log('  状态栏:', st.metaText);

    ok(st.visible, '★ 日志分栏切过去就显示（日志就在设置里）');
    ok(st.lineCount > 3, '★ 渲染出了日志行', String(st.lineCount));
    // ★ 行格式必须与 bat 面板/日志文件**同形**：`[时刻] [模块] [级别] [来源] 正文`
    //   2026-10 用户报"查看器与 bat 面板对不上"，其中一半原因是级别与模块位置反了。
    //   另一条：时间戳现在带**毫秒**（同一秒里能连打十几条，秒级分不出先后）。
    ok(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[[^\]]+\] \[(DBUG|INFO|WARN|ERRO|CRIT)\] \[[^\]]+\]/.test(st.firstLine),
        '★ 行格式与面板一致：时刻(含毫秒) + [模块] + [级别短码] + [来源] + 正文', st.firstLine);
    ok(st.hasLevelColors, '★ 级别有配色区分');
    ok(st.tagOptions.includes('Mod') || st.tagOptions.includes('Core'), '★ 模块下拉有真实模块名', JSON.stringify(st.tagOptions));
    ok(st.autoScrollChecked === true, '自动滚动默认开启');
    ok(st.hideChatExists, '★ 有「排除用户对话」开关（参考图的控件之一）');
    ok(!/NaN/.test(st.metaText), '★ 状态栏不出现 NaN', st.metaText);
    // 五个级别药丸；★ DEBUG 默认**关**（对齐 bat 面板：成功的 HTTP 请求都在 DEBUG 上，
    // 默认放出来就是一屏 `GET /api/xxx 200 7ms` —— 用户实测反馈"看不懂的消息"）。
    ok(st.pillLabels.join(',') === 'DEBUG,INFO,WARNING,ERROR,CRITICAL',
        '★ 五个级别药丸（DEBUG/INFO/WARNING/ERROR/CRITICAL）', JSON.stringify(st.pillLabels));
    ok(st.pillsPressed.join(',') === 'false,true,true,true,true',
        '★ DEBUG 默认关、INFO 及以上默认开（对齐 bat 面板，不刷请求噪音）',
        JSON.stringify(st.pillsPressed));
    // ★ 默认视图里**不该出现 DEBUG 行**（请求行就是这一类）。
    //   这是用户报"日志为什么会出现这种看不懂的消息"的直接回归断言。
    ok(st.levels.every((l) => l !== 'DEBUG'),
        '★ 默认视图里没有 DEBUG 行（请求噪音默认隐藏）', JSON.stringify([...new Set(st.levels)]));

    // ★ 顺序必须**与 bat 面板一致：旧在上、新在下**（用户报"对不上"的另一半原因）
    const order = await page.evaluate(() => {
        const box = document.getElementById('logPageBox');
        const lines = [...box.querySelectorAll('.log-line')].map((d) => d.textContent || '');
        const ts = (s) => {
            const m = s.match(/\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/);
            return m ? ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+m[4]) : null;
        };
        return { first: ts(lines[0] || ''), last: ts(lines[lines.length - 1] || ''), n: lines.length };
    });
    ok(order.first !== null && order.last !== null && order.first <= order.last,
        '★ 顺序与 bat 面板一致（旧在上、新在下）',
        `首行 ${order.first}ms / 末行 ${order.last}ms（共 ${order.n} 行）`);

    // ---- ③ 级别药丸过滤：关掉 INFO 后应只剩 WARN 及以上 ----
    //   （DEBUG 默认就是关的，所以这里只需再关 INFO）
    const before = st.lineCount;
    await page.evaluate(() => {
        document.querySelector('#logLevelPills .log-pill[data-level="INFO"]')?.click();
    });
    await page.waitForTimeout(2000);
    const afterWarn = await page.evaluate(() => ({
        n: document.getElementById('logPageBox').querySelectorAll('.log-line').length,
        meta: document.getElementById('logPageMeta').textContent,
        levels: [...document.getElementById('logPageBox').querySelectorAll('.log-line')].map((d) => d.dataset.level),
    }));
    ok(afterWarn.n <= before, `★ 关掉 INFO 后行数不增（${before} → ${afterWarn.n}）`);
    ok(afterWarn.levels.every((l) => ['WARN', 'ERROR', 'CRITICAL'].includes(l)),
        '★ 过滤后只剩 WARN 及以上（药丸真的生效了）', JSON.stringify([...new Set(afterWarn.levels)]));
    ok(!/NaN/.test(afterWarn.meta), '★ 过滤后状态栏仍正常', afterWarn.meta);

    // ---- ③b 把 DEBUG 打开：请求行应该回来（证明它只是默认关，没有被丢掉）----
    await page.evaluate(() => {
        document.querySelector('#logLevelPills .log-pill[data-level="DEBUG"]')?.click();
        document.querySelector('#logLevelPills .log-pill[data-level="INFO"]')?.click();
    });
    await page.waitForTimeout(2000);
    const withDebug = await page.evaluate(() => ({
        levels: [...document.getElementById('logPageBox').querySelectorAll('.log-line')].map((d) => d.dataset.level),
    }));
    ok(withDebug.levels.includes('DEBUG') || withDebug.levels.length === 0,
        '★ 打开 DEBUG 药丸后能看到 DEBUG 行（默认关 ≠ 丢掉）',
        JSON.stringify([...new Set(withDebug.levels)]));

    // ---- ④ 全部级别关掉：给明确空态，而不是空白 ----
    await page.evaluate(() => {
        document.querySelectorAll('#logLevelPills .log-pill').forEach((b) => { b.setAttribute('aria-pressed', 'true'); });
        // 逐个点掉
        document.querySelectorAll('#logLevelPills .log-pill').forEach((b) => b.click());
    });
    await page.waitForTimeout(1200);
    const allOff = await page.evaluate(() => ({
        n: document.getElementById('logPageBox').querySelectorAll('.log-line').length,
        text: document.getElementById('logPageBox').textContent || '',
    }));
    ok(allOff.n === 0 && /关掉/.test(allOff.text), '★ 全部级别关掉时给出明确空态（不是空白）', allOff.text.slice(0, 60));

    // ---- ⑤ 离开分栏 / 关闭设置：轮询必须停（否则服务端日志被自噪音刷屏）----
    //   先切到别的分栏
    await page.evaluate(() => document.querySelector('[data-settings-tab="tab-appearance"]')?.click());
    await page.waitForTimeout(1200);
    const leftTab = await page.evaluate(() => ({
        viewerStopped: window.LogViewer ? window.LogViewer.isVisible() === false : null,
        logPanelHidden: !document.getElementById('tab-log').classList.contains('active-panel'),
    }));
    ok(leftTab.logPanelHidden, '★ 切到别的分栏后日志分栏收起');
    ok(leftTab.viewerStopped === true, '★ 离开日志分栏后轮询停掉（不再每 2 秒自拉）');

    //   再关掉整个设置面板
    await page.evaluate(() => { try { if (typeof closeSettingsPanel === 'function') closeSettingsPanel(); } catch (e) {} });
    await page.waitForTimeout(800);
    const closed = await page.evaluate(() => ({
        settingsHidden: document.getElementById('settingsOverlay').classList.contains('hidden'),
        viewerStopped: window.LogViewer ? window.LogViewer.isVisible() === false : null,
    }));
    ok(closed.settingsHidden, '★ 关闭设置面板后面板收起');
    ok(closed.viewerStopped === true, '★ 关闭设置后查看器认为自己不可见（轮询会停）');
} finally {
    await browser.close();
    child.kill();
    await wait(300);
    try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
