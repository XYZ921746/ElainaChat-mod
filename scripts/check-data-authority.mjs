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
    // ★ 现在 localStorage 里**什么业务键都不该有** —— 连迁移标记也不该有
    //   （自动迁移已按用户要求移除：删 data/ 就是真清空，靠备份功能兜底）。
    ok(lsKeys.length === 0, '★ localStorage 里没有任何业务数据（也没有迁移标记）',
        JSON.stringify(lsKeys));

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

    console.log('\n=== 服务运行中删除 data/（用户最可能的操作）===');
    {
        // ★ 这是用户实际的做法：服务开着，直接删文件夹。
        //   之前这里有个**真正的元凶**：server/store.mjs 的内存缓存永不失效
        //   （`if (cache) return cache`），删掉 data/ 后缓存照旧返回旧数据，
        //   浏览器读到了、又写回磁盘 —— 表现就是"删了还在"。
        //   修法是让缓存与 data/ 目录 mtime 绑定（见 store.mjs 的 loadStore）。
        const ctx5 = await browser.newContext();
        const page5 = await ctx5.newPage();
        await page5.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page5.waitForTimeout(1500);

        // 先通过 API 写一条能被识别的数据
        await page5.evaluate(() => Store.setItem('elaina_open_settings',
            JSON.stringify({ model: 'SENTINEL-BEFORE-DELETE' })));
        await wait(1500);
        const s1 = await (await fetch(BASE + '/api/store')).json();
        ok(/SENTINEL-BEFORE-DELETE/.test(JSON.stringify(s1.data || {})),
            '（前置）写入的数据能被服务端读到');

        // 服务**不重启**，直接删掉整个 data/ 目录
        rmSync(DATA_DIR, { recursive: true, force: true });
        ok(!existsSync(path.join(DATA_DIR, 'store.json')), '（前置）data/ 已删除');

        // 立刻问 API：必须是空的（缓存要感知磁盘被删）
        const s2 = await (await fetch(BASE + '/api/store')).json();
        ok(!/SENTINEL-BEFORE-DELETE/.test(JSON.stringify(s2.data || {})),
            '★★ 服务不重启时删 data/，API 立刻读不到旧数据（缓存已失效）',
            JSON.stringify(s2.data || {}).slice(0, 120));

        // 刷新页面：界面也必须是空的
        await page5.reload({ waitUntil: 'domcontentloaded' });
        await page5.waitForTimeout(2500);
        const afterWipeLive = await page5.evaluate(() => ({
            model: state.settings.model,
            convs: state.conversations.length,
        }));
        ok(afterWipeLive.model !== 'SENTINEL-BEFORE-DELETE',
            '★★ 刷新后界面也是空的（不会读到残留）', afterWipeLive.model);
        ok(afterWipeLive.convs === 0, '★★ 聊天记录为空', String(afterWipeLive.convs));

        // 说明：data/ 目录会被**重建**（应用启动时写内置角色卡等正常数据），
        // 但里面不该有删除前的旧数据。这一点要显式断言，
        // 否则用户看到目录又出现会以为"没删掉"。
        await wait(1200);
        if (existsSync(path.join(DATA_DIR, 'store.json'))) {
            const rebuilt = readFileSync(path.join(DATA_DIR, 'store.json'), 'utf8');
            ok(!/SENTINEL-BEFORE-DELETE/.test(rebuilt),
                '★ 重建出来的文件里没有旧数据（目录会重建，但数据不会回来）');
        } else {
            ok(true, '★ 重建出来的文件里没有旧数据（目录未重建）');
        }
        await ctx5.close();
    }

    console.log('\n页面错误:', errs.length ? errs.slice(0, 3).join(' | ') : '(无)');

    // ── ④ 删了就该真的空：localStorage 里的旧数据**不许**被搬回来 ──
    //
    // 曾经有一版"把老版本 localStorage 的数据自动迁进 data/"（为了保住老用户数据），
    // 但它制造了用户实测的那个困惑：
    //     关服务 → 删 data/ → 重启 → data/ 又被填满了
    // 现在定稿的原则是：**data/ 就是全部，删掉它就没了**。
    // 老用户的数据靠"我的数据 → 导入备份"恢复（项目本来就有备份功能）。
    await ctx2.close();
    console.log('\n=== 删 data/ 后不许从 localStorage 搬回旧数据 ===');
    {
        const ctx3 = await browser.newContext();
        const page3 = await ctx3.newPage();
        // 灌入"老版本留在浏览器里"的数据，模拟老用户
        await page3.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page3.evaluate(() => {
            localStorage.setItem('elaina_open_settings', JSON.stringify({ model: 'LEGACY-BROWSER-DATA' }));
            localStorage.setItem('elaina_open_conversations', JSON.stringify([
                { id: 'legacy-conv', title: '浏览器里的老对话', messages: [{ id: 'lm1', role: 'user', text: '升级前的消息' }] },
            ]));
            localStorage.setItem('elaina_open_character_cards', JSON.stringify([{ id: 'legacy-card', name: '老角色' }]));
        });
        await page3.reload({ waitUntil: 'domcontentloaded' });
        await page3.waitForTimeout(2500);
        const after = await page3.evaluate(() => ({
            model: state.settings.model,
            convs: state.conversations.length,
            cards: state.characterCards ? state.characterCards.length : -1,
        }));
        console.log('打开后:', JSON.stringify(after));
        ok(after.model !== 'LEGACY-BROWSER-DATA',
            '★★ localStorage 里的旧设置**没有**被搬进应用', after.model);
        ok(after.convs === 0,
            '★★ localStorage 里的旧对话**没有**出现在界面上', String(after.convs));
        // 落盘确认：data/ 里不该有任何旧数据痕迹
        await wait(1500);
        let dumped = '';
        try {
            const walk = (d) => {
                for (const e of readdirSync(d, { withFileTypes: true })) {
                    const p = path.join(d, e.name);
                    if (e.isDirectory()) walk(p);
                    else dumped += readFileSync(p, 'utf8');
                }
            };
            if (existsSync(DATA_DIR)) walk(DATA_DIR);
        } catch { /* ignore */ }
        ok(!/LEGACY-BROWSER-DATA/.test(dumped),
            '★★ data/ 落盘内容里没有旧设置（不会自己长回来）');
        ok(!/升级前的消息/.test(dumped), '★★ data/ 落盘内容里没有旧对话');
        await ctx3.close();
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
