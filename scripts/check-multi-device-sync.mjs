// 多设备实时同步验证：两个独立浏览器上下文（模拟两台设备）连同一个服务，
// A 设备改动 → B 设备应当**在几秒内自动看到**，不需要刷新。
import { chromium } from 'file:///D:/222/android-app/node_modules/playwright-core/index.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-sync-'));
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-syncd-'));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(PORT + 1), HOST: '127.0.0.1', LOG_DIR, DATA_DIR, LOG_TO_FILE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
child.stdout.on('data', (d) => { serverOut += d; });
child.stderr.on('data', (d) => { serverOut += d; });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
        try { up = (await fetch(BASE + '/api/server-info')).ok; } catch { await wait(250); }
    }
    if (!up) { console.log('服务没起来：\n' + serverOut.slice(-800)); process.exit(1); }

    // ============ 设备 A 与设备 B：两个完全独立的浏览器上下文 ============
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const errsA = [], errsB = [];
    pageA.on('pageerror', (e) => errsA.push(e.message));
    pageB.on('pageerror', (e) => errsB.push(e.message));

    await pageA.goto(BASE, { waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(2500);
    await pageB.goto(BASE, { waitUntil: 'domcontentloaded' });
    await pageB.waitForTimeout(2500);

    // ① 两边都建立了 SSE 订阅？
    const subA = await pageA.evaluate(() => ({
        hasStore: typeof window.Store !== 'undefined',
        hasSubscribe: typeof window.Store?.subscribeRemote === 'function',
        clientId: window.Store?.clientId?.(),
    }));
    const subB = await pageB.evaluate(() => ({
        clientId: window.Store?.clientId?.(),
    }));
    console.log('A clientId:', subA.clientId, ' B clientId:', subB.clientId);
    ok(subA.hasSubscribe, 'Store.subscribeRemote 存在');
    ok(subA.clientId && subB.clientId && subA.clientId !== subB.clientId,
        '两个设备有各自的 clientId（服务端据此跳过发起方）');

    // ② A 改主题 → B 应自动看到（不刷新）
    console.log('\n=== A 改主题，B 是否自动同步 ===');
    await pageA.evaluate(() => { Store.setItem('elaina_theme', 'dark'); Store._flush(); });
    await wait(2500);
    const themeB = await pageB.evaluate(() => ({
        stored: Store.getItem('elaina_theme'),
        domAttr: document.documentElement.getAttribute('data-theme'),
    }));
    console.log('  B 看到:', JSON.stringify(themeB));
    ok(themeB.stored === 'dark', '★ B 的 Store 自动收到了主题变化（无需刷新）', String(themeB.stored));
    ok(themeB.domAttr === 'dark', '★ B 的界面真的应用了深色（不只是数据变了）', String(themeB.domAttr));

    // ③ A 改设置 → B 应自动看到
    console.log('\n=== A 改设置，B 是否自动同步 ===');
    await pageA.evaluate(() => {
        state.settings.model = 'SYNC-FROM-DEVICE-A';
        persistSettings();
    });
    await wait(2500);
    const modelB = await pageB.evaluate(() => state.settings.model);
    console.log('  B 的 model:', modelB);
    ok(modelB === 'SYNC-FROM-DEVICE-A', '★ B 自动收到了设置变化', String(modelB));

    // ④ A 新增一条聊天记录 → B 应自动看到
    console.log('\n=== A 发消息，B 是否自动看到 ===');
    const beforeB = await pageB.evaluate(() => state.conversations.length);
    await pageA.evaluate(() => {
        state.conversations.push({
            id: 'sync-conv-from-a', title: 'A 设备新建的对话',
            messages: [{ id: 'sm1', role: 'user', text: '这条来自设备 A', timestamp: '00:00:00' }],
        });
        saveConversations();
    });
    await wait(2500);
    const afterB = await pageB.evaluate(() => ({
        count: state.conversations.length,
        hasConv: state.conversations.some((c) => c.id === 'sync-conv-from-a'),
        shownInList: document.body.textContent.includes('A 设备新建的对话'),
    }));
    console.log('  B 看到:', JSON.stringify(afterB));
    ok(afterB.hasConv, '★ B 自动收到了新对话（数据层）', `${beforeB} → ${afterB.count}`);
    ok(afterB.shownInList, '★ B 的侧栏真的显示出来了（界面层）');

    // ⑤ 反向：B 改 → A 也要能收到（不能是单向）
    console.log('\n=== 反向验证：B 改，A 是否同步 ===');
    await pageB.evaluate(() => { Store.setItem('elaina_theme', 'light'); Store._flush(); });
    await wait(2500);
    const themeA = await pageA.evaluate(() => Store.getItem('elaina_theme'));
    ok(themeA === 'light', '★ 反向也同步（B 改 A 收到）', String(themeA));

    // ⑥ 发起方自己不该被自己的广播惊动（无回环）
    const loops = await pageA.evaluate(() => window.__syncLoopCount || 0);
    ok(loops === 0, '没有自触发回环', String(loops));

    console.log('\n页面错误 A:', errsA.length ? errsA.slice(0, 2).join(' | ') : '(无)');
    console.log('页面错误 B:', errsB.length ? errsB.slice(0, 2).join(' | ') : '(无)');

    await ctxA.close();
    await ctxB.close();
} finally {
    await browser.close();
    child.kill();
    await wait(300);
    try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
