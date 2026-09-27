// 验证「data/ 是唯一存储」：① 写入后 data/ 里有数据 ② 删掉 data/ 后数据真的为空。
import { chromium } from 'file:///D:/222/android-app/node_modules/playwright-core/index.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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

const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-log-'));
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-data-'));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

function startServer() {
    const c = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(PORT + 1), HOST: '127.0.0.1', LOG_DIR, DATA_DIR, LOG_TO_FILE: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    c.stdout.on('data', (d) => { lastOut += d; });
    c.stderr.on('data', (d) => { lastOut += d; });
    return c;
}
async function waitUp() {
    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(BASE + '/api/server-info')).ok) return true; } catch { /* retry */ }
        await wait(250);
    }
    return false;
}

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
let lastOut = '';
let child = startServer();
try {
    ok(await waitUp(), '服务已启动', lastOut.slice(-400));

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    // ── ① 写一条数据（走真实业务函数） ──
    await page.evaluate(() => {
        state.conversations = [{ id: 'conv-test-1', title: '删库测试', messages: [
            { id: 'm1', role: 'user', text: '这是应该被保存的消息', timestamp: '00:00:00' },
        ] }];
        saveConversations();
        state.settings.model = 'model-should-persist';
        persistSettings();
        Store.setItem('elaina_theme', 'dark');
    });
    // 等防抖推送（store.js 是 800ms）
    await wait(1600);

    ok(existsSync(path.join(DATA_DIR, 'store.json')), '★ 写入后 data/store.json 已生成');
    const store1 = JSON.parse(readFileSync(path.join(DATA_DIR, 'store.json'), 'utf8'));
    ok(!!store1['elaina_open_settings'], 'settings 进了 data/');
    ok(/model-should-persist/.test(store1['elaina_open_settings'] || ''), 'settings 内容正确');
    ok(store1['elaina_theme'] === 'dark', '主题设置进了 data/');
    // 聊天记录按设计拆成 conversations/<id>.json
    const convDir = path.join(DATA_DIR, 'conversations');
    const convFiles = existsSync(convDir) ? readdirSync(convDir).filter((f) => f.endsWith('.json')) : [];
    ok(convFiles.length > 0, '★ 聊天记录进了 data/conversations/', JSON.stringify(convFiles));
    const convBody = convFiles.map((f) => readFileSync(path.join(convDir, f), 'utf8')).join('');
    ok(/这是应该被保存的消息/.test(convBody), '★ 聊天正文确实写进了 data/');

    // ── ② 刷新页面，数据应该还在（正常持久化） ──
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    const afterReload = await page.evaluate(() => ({
        convs: state.conversations.length,
        model: state.settings.model,
        theme: Store.getItem('elaina_theme'),
        lsConvs: localStorage.getItem('elaina_open_conversations'),
        lsSettings: localStorage.getItem('elaina_open_settings'),
        lsTheme: localStorage.getItem('elaina_theme'),
        lsAll: (() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = String(localStorage.getItem(k)).slice(0, 30); } return o; })(),
    }));
    console.log('\n刷新后:', JSON.stringify({ convs: afterReload.convs, model: afterReload.model, theme: afterReload.theme }));
    console.log('localStorage 内容:', JSON.stringify(afterReload.lsAll));
    ok(afterReload.convs === 1, '刷新后聊天记录还在（正常持久化）', String(afterReload.convs));
    ok(afterReload.model === 'model-should-persist', '刷新后设置还在');
    ok(afterReload.theme === 'dark', '刷新后主题还在');
    // ★ 核心断言：localStorage 里不该再有业务数据
    ok(afterReload.lsConvs === null, '★ localStorage 里没有聊天记录（已不再作主存储）', String(afterReload.lsConvs));
    ok(afterReload.lsSettings === null, '★ localStorage 里没有设置');
    ok(afterReload.lsTheme === null, '★ localStorage 里没有主题');
    const lsKeys = Object.keys(afterReload.lsAll);
    // ★ 允许且**只允许**一个键：迁移标记。
    //   它必须留在 localStorage —— 放进 data/ 的话，用户删掉 data/ 时标记一起没了，
    //   下次启动又会把 localStorage 里的残留搬回来（那正是"删了还在"的复现路径）。
    const unexpected = lsKeys.filter((k) => k !== 'elaina_store_migrated_v1');
    ok(unexpected.length === 0, '★ localStorage 里没有任何业务数据（只剩迁移标记）',
        JSON.stringify(unexpected));
    ok(lsKeys.includes('elaina_store_migrated_v1'),
        '★ 迁移标记存在（保证旧数据只搬一次，不会被反复搬回）');

    await ctx.close();

    // ── ③ 删掉 data/，重启服务，数据必须为空 ──
    console.log('\n=== 删除 data/ 并重启 ===');
    child.kill();
    await wait(600);
    rmSync(DATA_DIR, { recursive: true, force: true });
    child = startServer();
    ok(await waitUp(), '服务重启成功');

    const ctx2 = await browser.newContext();   // 全新上下文：localStorage 天然是空的
    const page2 = await ctx2.newPage();
    await page2.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page2.waitForTimeout(2500);
    const afterWipe = await page2.evaluate(() => ({
        convs: state.conversations.length,
        model: state.settings.model,
        theme: Store.getItem('elaina_theme'),
    }));
    console.log('删 data/ 后:', JSON.stringify(afterWipe));
    ok(afterWipe.convs === 0, '★★ 删掉 data/ 后聊天记录为空（用户报的问题已修）', String(afterWipe.convs));
    ok(afterWipe.model !== 'model-should-persist', '★★ 删掉 data/ 后设置回到默认', afterWipe.model);
    ok(afterWipe.theme !== 'dark', '★★ 删掉 data/ 后主题回到默认', String(afterWipe.theme));
    // 而且不该被自动重建出旧数据
    await wait(1200);
    const recreated = existsSync(path.join(DATA_DIR, 'store.json'))
        ? readFileSync(path.join(DATA_DIR, 'store.json'), 'utf8') : '';
    ok(!/model-should-persist/.test(recreated), '★ 旧设置没有被反向推回 data/（原 bug 的根因）');
    await ctx2.close();

    console.log('\n页面错误:', errs.length ? errs.slice(0, 3).join(' | ') : '(无)');

    // ── ④ 老用户升级：localStorage 里的旧数据必须被搬进 data/（只搬一次） ──
    await ctx2.close();
    console.log('\n=== 老用户升级：localStorage 旧数据搬迁 ===');
    {
        const ctx3 = await browser.newContext();
        const page3 = await ctx3.newPage();
        // 先灌入"老版本留下的" localStorage 数据，再打开页面
        await page3.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page3.evaluate(() => {
            localStorage.clear();
            localStorage.setItem('elaina_open_settings', JSON.stringify({ model: 'legacy-model' }));
            localStorage.setItem('elaina_open_conversations', JSON.stringify([
                { id: 'legacy-conv', title: '老数据', messages: [{ id: 'lm1', role: 'user', text: '升级前的消息' }] },
            ]));
        });
        await page3.reload({ waitUntil: 'domcontentloaded' });
        await page3.waitForTimeout(2500);
        const migrated = await page3.evaluate(() => ({
            model: state.settings.model,
            convs: state.conversations.length,
            convTitle: state.conversations[0]?.title || '',
        }));
        console.log('升级后读到:', JSON.stringify(migrated));
        ok(migrated.model === 'legacy-model', '★ 老数据被迁入：设置读到了 legacy-model', migrated.model);
        ok(migrated.convs === 1 && migrated.convTitle === '老数据', '★ 老数据被迁入：聊天记录还在',
            JSON.stringify(migrated));
        await wait(1500);   // 等落盘
        const storeAfterMigrate = existsSync(path.join(DATA_DIR, 'store.json'))
            ? readFileSync(path.join(DATA_DIR, 'store.json'), 'utf8') : '';
        ok(/legacy-model/.test(storeAfterMigrate), '★ 老数据确实落进了 data/store.json');
        await ctx3.close();

        // ★ 关键：再删一次 data/，旧数据**不能**被再次搬回来（这就是原来的 bug）
        child.kill();
        await wait(600);
        rmSync(DATA_DIR, { recursive: true, force: true });
        child = startServer();
        ok(await waitUp(), '服务再次重启');
        const ctx4 = await browser.newContext();
        const page4 = await ctx4.newPage();
        // 复现用户的操作：localStorage 里还留着旧数据，删掉 data/ 后重开
        await page4.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page4.evaluate(() => {
            localStorage.setItem('elaina_open_settings', JSON.stringify({ model: 'legacy-model' }));
            localStorage.setItem('elaina_open_conversations', JSON.stringify([
                { id: 'legacy-conv', title: '老数据', messages: [] },
            ]));
        });
        await page4.reload({ waitUntil: 'domcontentloaded' });
        await page4.waitForTimeout(2500);
        const afterSecondWipe = await page4.evaluate(() => ({
            model: state.settings.model,
            convs: state.conversations.length,
        }));
        console.log('二次删 data/ 后:', JSON.stringify(afterSecondWipe));
        ok(afterSecondWipe.convs === 0,
            '★★ 删掉 data/ 后旧数据不会被搬回来（迁移只跑一次）', String(afterSecondWipe.convs));
        ok(afterSecondWipe.model !== 'legacy-model',
            '★★ 设置也没有被搬回来', afterSecondWipe.model);
        await ctx4.close();
    }
} finally {
    await browser.close();
    child.kill();
    await wait(300);
    try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
