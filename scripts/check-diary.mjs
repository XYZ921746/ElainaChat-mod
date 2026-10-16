// 回归检查：旅行日记的浏览体验（按对话分组 / 点侧栏筛选 / 弹窗看全文）。
//
// ── 为什么这几件事值得常驻检查（2026-10 用户要求）───────────────────────
//
//   用户报了两件事，都属于"看起来能用、实际用不了"的类型：
//
//   ① **日记读不全**：卡片正文被 `-webkit-line-clamp: 4` 截成 4 行，
//      而**没有任何展开入口** —— 旧实现里卡片上的点击是"跳到原对话"，
//      不是看全文。于是超过 4 行的日记永远看不完整，且不报错。
//
//   ② **点侧栏跳走了**：用户在日记页想"看某段对话的日记"，
//      点侧栏却把他踢进聊天页 —— 意图被粗暴打断。
//      改成"只筛选不跳转"之后，又必须保证**非日记页时行为完全不变**
//      （进对话是最常用的操作，改坏它比原问题更严重）。
//
//  这两条都只能靠真浏览器验（截断与滚动跳转都是渲染行为），
//  所以本检查起真服务 + 真 Chromium。
//
// 用法：node scripts/check-diary.mjs
import { launchTestBrowser } from './test-browser.mjs';
import { readFileSync, mkdtempSync, rmSync, openSync, existsSync, readdirSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
    const s = createNetServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

// ============================================================ 1. 源码约定
console.log('=== 1. 源码约定 ===');
{
    const ui = readFileSync(path.join(WEB, 'js', 'app-04-ui.js'), 'utf8');
    const core = readFileSync(path.join(WEB, 'js', 'app-01-core.js'), 'utf8');
    const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');

    // ① 按对话分组
    ok(/function renderDiaryPage/.test(ui), '有 renderDiaryPage');
    ok(/diary-group-head/.test(ui), '★ 日记按对话分组渲染（组标题）');
    ok(/grid-column:\s*1\s*\/\s*-1/.test(html),
        '★ 组标题跨整行（不跨列会被塞进某一列、卡片跟着错位）');

    // ② 点侧栏 → 只筛选不跳转
    ok(/function focusDiaryGroup/.test(ui), '★★ 有 focusDiaryGroup（按对话筛选日记）');
    // ★ 注意：筛选状态定义在 **app-01-core.js 的 state** 里，不在 app-04-ui.js。
    //   （我第一版断言写的是 ui 文件，于是必然找不到 —— 判据指错了文件。）
    ok(/diaryFilterConvId:\s*''/.test(core),
        '★ state 里有 diaryFilterConvId（筛选状态）');
    // ★★ 关键：只在日记页拦截；否则日常切换对话会被弄坏
    ok(/if \(state\.diaryMode && typeof focusDiaryGroup === 'function'\)/.test(ui),
        '★★ 只在日记页拦截侧栏点击（非日记页必须照旧进对话 —— 那是最常用的操作）');
    // ★★ 2026-10（用户要求）：日记页里**不再**放第二套筛选条 ——
    //   分类/筛选统一交给左边的对话记录，两处都能筛只会让人困惑。
    ok(!/function renderDiaryFilterBar/.test(ui),
        '★★ 已移除日记页内的筛选条（筛选职责交给左侧对话记录，不重复提供入口）');
    ok(!/diary-filter-bar/.test(ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
        '★★ 代码里不再生成 .diary-filter-bar（注释里提到不算）');
    // ★ 但"点中了哪一段"要有视觉落点（否则用户不知道点没点上）
    ok(/is-focused/.test(ui) && /is-focused/.test(html),
        '★★ 当前筛选的组有高亮样式（is-focused）—— 筛选条移除后需要这个落点');

    // ③ 弹窗看全文
    ok(/function openDiaryDetail/.test(ui), '★★ 有 openDiaryDetail（点卡片看全文）');
    ok(/function closeDiaryDetail/.test(ui), '有 closeDiaryDetail');
    ok(/card\.addEventListener\('click', openDetail\)/.test(ui),
        '★ 卡片可点击打开详情');
    // ★ 正文用 textContent 而不是 innerHTML（模型输出，防注入）
    ok(/p\.textContent = entry\.content/.test(ui),
        '★★ 详情正文用 textContent（日记内容来自模型，不能当 HTML 解析）');

    // ④ 不再"点组头就跳走"
    ok(!/head\.addEventListener\('click', jump\)/.test(ui),
        '★ 组头不再"点了就跳去聊天"（用户明确要求去掉）');
    ok(/data-diary-enter/.test(ui), '★ 但保留「进入对话」按钮（入口不能丢）');

    // ⑤ 进/出日记页要清筛选（否则下次进来莫名只显示一部分）
    ok(/function enterDiaryMode[\s\S]{0,400}?state\.diaryFilterConvId = ''/.test(ui),
        '★★ 进日记页时重置筛选（筛选是当次浏览状态，不该跨次留存）');
    ok(/function exitDiaryMode[\s\S]{0,500}?state\.diaryFilterConvId = ''/.test(ui),
        '★★ 离开日记页时也清掉（并关掉详情弹窗）');
    ok(/function exitDiaryMode[\s\S]{0,500}?closeDiaryDetail\(\)/.test(ui),
        '★ 离开日记页要关掉详情弹窗（它挂在 body 上，不随页面隐藏）');

    // ⑦ ★★ 日记页里点对话，侧栏也要有选中高亮
    //
    //   用户报："对话记录这里选中后会有选中的特性，但在日记系统中选中没有对应特效，
    //   只有回到聊天才能正常使用。"
    //
    //   根因：侧栏条目高亮判的是 `conv.id === state.currentConversationId`，
    //   而"日记页点对话只筛选不跳转"这个行为**恰恰不改** currentConversationId
    //   —— 于是点了对话，侧栏没有任何条目被判定为选中。
    //   （两个功能各自看都是对的，合起来就成了这个 bug。）
    ok(/const activeId = state\.diaryMode/.test(ui),
        '★★ 日记页时高亮判据换成"筛选的对话"（不再只看 currentConversationId）');
    ok(/state\.diaryFilterConvId \|\| ''/.test(ui),
        '★ 未筛选时不高亮任何条目（回落成空串，不是 undefined）');
    // ★ 只重绘日记页不够 —— 侧栏也必须跟着重绘，否则点了对话高亮不更新
    ok(/function focusDiaryGroup[\s\S]{0,600}?renderFolderList\(\)/.test(ui),
        '★★ focusDiaryGroup 里重绘侧栏（不重绘则侧栏高亮不更新）');
    ok(/function exitDiaryMode[\s\S]{0,900}?renderFolderList\(\)/.test(ui),
        '★★ 离开日记页时重绘侧栏（高亮要切回"当前对话那段"）');

    // ⑥ ★★ 删除对话时，日记与收藏都要一起清掉
    //
    //   用户报："删除对话时会删除日记但是不会删除收藏的句子"。
    //   查下来是**两处删除入口各自只做了一半**（一个删收藏不删日记、
    //   另一个也一样）。所以这里既钉"有共用函数"，也钉"两个入口都调它"。
    ok(/function purgeConversationDependents/.test(ui),
        '★★ 有 purgeConversationDependents（删对话时清理依附数据）');
    ok(/function purgeConversationDependents[\s\S]{0,1500}?mc\.diary = mc\.diary\.filter/.test(ui),
        '★★ 它会清掉属于该对话的**日记**');
    ok(/function purgeConversationDependents[\s\S]{0,2000}?state\.favorites = state\.favorites\.filter/.test(ui),
        '★★ 它也会清掉属于该对话的**收藏句子**');
    // ★★ 两个删除入口都必须走它（这正是 bug 的成因：各写一半）
    const delFn = ui.slice(ui.indexOf('async function deleteConversation'), ui.indexOf('function togglePin'));
    ok(/purgeConversationDependents\(\[convId\]\)/.test(delFn),
        '★★ 单条删除走共用清理函数');
    const batchFn = ui.slice(ui.indexOf('async function catDeleteSelected'), ui.indexOf('// ==================== 消息渲染'));
    ok(/purgeConversationDependents\(catSelected\)/.test(batchFn),
        '★★ 批量删除也走同一个函数（两个入口不能再各写一半）');
    // 清完要落盘，否则刷新又回来
    ok(/function purgeConversationDependents[\s\S]{0,1500}?saveMemoryCore/.test(ui)
        && /function purgeConversationDependents[\s\S]{0,2000}?saveFavorites/.test(ui),
        '★★ 清理结果要落盘（日记 saveMemoryCore / 收藏 saveFavorites）');
}

// ============================================================ 2. 真浏览器
const PORT = await freePort();
const HTTPS_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-diary-data-'));
const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-diary-log-'));
const MODS_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-diary-mods-'));

/**
 * 造可控的测试数据。
 *
 * ★★ 两个关键点（我实测各踩了一次，写下来避免以后再错）：
 *   ① 对话与记忆**不在 store.json 里** —— 服务端把它们拆成
 *      `data/conversations/*.json` 与 `data/memory/*.json`（一条一文件 + index）。
 *      往 store.json 里塞完全不会生效，表现为"页面里那些对话根本不存在"。
 *   ② `memory/<类目>.json` 的 `value` 必须是**真正的数组**，
 *      不能再 JSON.stringify 一层。写成字符串的话，客户端拿到的是
 *      `"diary":"[...]"`，`Array.isArray()` 判定失败 → 归零成空数组 → 日记全空。
 */
{
    const convDir = path.join(DATA_DIR, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const long = '长'.repeat(500);
    const convs = [
        { id: 'cA', title: '雪之街的相遇', messages: [{ id: 'm1', role: 'ai', text: 'hi', timestamp: '10:00' }], updatedAt: Date.now() },
        { id: 'cB', title: '咖啡馆的午后', messages: [{ id: 'm2', role: 'ai', text: 'hi', timestamp: '11:00' }], updatedAt: Date.now() },
    ];
    for (const c of convs) writeFileSync(path.join(convDir, c.id + '.json'), JSON.stringify(c, null, 2), 'utf8');
    writeFileSync(path.join(convDir, 'index.json'),
        JSON.stringify({ version: 1, order: ['cA', 'cB'], currentConversationId: 'cA' }, null, 2), 'utf8');

    const memDir = path.join(DATA_DIR, 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(path.join(memDir, 'diary.json'), JSON.stringify({
        version: 1,
        value: [
            { date: '2026年10月14日', content: 'A 的故事：' + long, essences: ['雪之街'], conversationId: 'cA', conversationTitle: '雪之街的相遇', timestamp: '2026-10-14T10:00:00.000Z' },
            { date: '2026年10月14日', content: 'B 的故事：咖啡馆', essences: ['咖啡馆'], conversationId: 'cB', conversationTitle: '咖啡馆的午后', timestamp: '2026-10-14T11:00:00.000Z' },
        ],
    }, null, 2), 'utf8');
    for (const k of ['promise', 'preference', 'plan', 'motivation', 'pivotal_memory']) {
        writeFileSync(path.join(memDir, k + '.json'), JSON.stringify({ version: 1, value: [] }, null, 2), 'utf8');
    }
}
// 立绘依赖（生日彩蛋要用；这里给一份最小可用）
{
    const src = path.join(ROOT, 'mods');
    if (existsSync(src)) for (const n of readdirSync(src)) {
        const mf = path.join(src, n, 'manifest.json');
        if (!existsSync(mf)) continue;
        try {
            if (JSON.parse(readFileSync(mf, 'utf8')).id === 'elaina-avatar') {
                const dest = path.join(MODS_DIR, 'elaina-avatar');
                mkdirSync(dest, { recursive: true });
                copyFileSync(path.join(src, n, 'manifest.json'), path.join(dest, 'manifest.json'));
                if (existsSync(path.join(src, n, 'index.js'))) copyFileSync(path.join(src, n, 'index.js'), path.join(dest, 'index.js'));
                const im = path.join(src, n, 'img');
                if (existsSync(im)) {
                    mkdirSync(path.join(dest, 'img'), { recursive: true });
                    for (const f of readdirSync(im)) copyFileSync(path.join(im, f), path.join(dest, 'img', f));
                }
            }
        } catch { /* 忽略 */ }
    }
}

const serverLogPath = path.join(LOG_DIR, 'server-output.log');
const outFd = openSync(serverLogPath, 'a');
const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
    cwd: ROOT,
    env: {
        ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT),
        HOST: '127.0.0.1', DATA_DIR, LOG_DIR, LOG_TO_FILE: '0', MODS_DIR,
    },
    stdio: ['ignore', outFd, outFd],
});
const serverOut = () => { try { return readFileSync(serverLogPath, 'utf8'); } catch { return ''; } };

let browser = null;
try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
        try { up = (await fetch(BASE + '/api/server-info')).ok; } catch { await wait(250); }
    }
    ok(up, '服务已启动', up ? '' : serverOut().slice(-400));

    if (up) {
        browser = await launchTestBrowser();
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', (e) => errs.push(e.message));

        const nav = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
        ok(nav && nav.status() === 200, '页面能打开', 'status=' + (nav ? nav.status() : '?'));
        await page.waitForTimeout(1500);
        await page.evaluate(() => {
            const ov = document.getElementById('announcementOverlay');
            if (ov) { ov.classList.add('hidden'); ov.classList.remove('flex'); }
        });

        // ---------- 2.1 分组渲染 ----------
        await page.evaluate(() => { enterDiaryMode(); });
        await page.waitForTimeout(600);
        const grouped = await page.evaluate(() => ({
            diaryMode: state.diaryMode,
            groups: [...document.querySelectorAll('.diary-group-title')].map((e) => e.textContent),
            cards: document.querySelectorAll('.diary-card').length,
            countText: (document.getElementById('diaryCount') || {}).textContent,
            enterBtns: document.querySelectorAll('.diary-group-enter').length,
        }));
        ok(grouped.cards === 2, '★★ 两条日记都渲染出来了（拆分文件的数据能读到）', JSON.stringify(grouped));
        ok(grouped.groups.includes('雪之街的相遇') && grouped.groups.includes('咖啡馆的午后'),
            '★★ 按对话分成两组，组标题是各自的对话名', JSON.stringify(grouped.groups));
        ok(grouped.enterBtns === 2, '★ 每个可跳转的组都有「进入对话」按钮');

        // ---------- 2.2 点侧栏 → 只筛选、不跳转 ----------
        const filtered = await page.evaluate(async () => {
            const item = document.querySelector('#folderList [data-conv-id="cB"]');
            if (!item) return { found: false };
            item.click();
            await new Promise((r) => setTimeout(r, 500));
            return {
                found: true,
                stillDiaryMode: state.diaryMode,
                currentConv: state.currentConversationId,
                filter: state.diaryFilterConvId,
                groups: [...document.querySelectorAll('.diary-group-title')].map((e) => e.textContent),
                cards: document.querySelectorAll('.diary-card').length,
                // ★ 筛选条已按用户要求移除（筛选交给左侧对话记录），
                //   改由"当前组高亮"给出视觉落点，所以这里断言 is-focused。
                focusedHead: document.querySelectorAll('.diary-group-head.is-focused').length,
                focusedTitle: (document.querySelector('.diary-group-head.is-focused .diary-group-title') || {}).textContent || '',
                filterBarGone: !document.querySelector('.diary-filter-bar'),
                diaryVisible: !document.getElementById('diaryPage').classList.contains('hidden'),
                chatHidden: document.getElementById('conversationHistory').classList.contains('hidden'),
            };
        });
        ok(filtered.found, '★★ 侧栏里能找到那条对话');
        ok(filtered.stillDiaryMode, '★★★ 点侧栏后**仍在日记页**（用户要求的"不再跳转到聊天"）',
            JSON.stringify(filtered));
        ok(filtered.filter === 'cB',
            '★★ 筛选到了被点的那段对话', String(filtered.filter));
        ok(filtered.cards === 1 && filtered.groups.length === 1 && filtered.groups[0] === '咖啡馆的午后',
            '★★ 只显示该对话的日记（别的对话收起来了）', JSON.stringify(filtered.groups));
        ok(filtered.focusedHead === 1 && filtered.focusedTitle === '咖啡馆的午后',
            '★★ 当前筛选的那一组有高亮（is-focused）—— 筛选条移除后靠它告诉用户"点中了"',
            JSON.stringify({ n: filtered.focusedHead, t: filtered.focusedTitle }));
        ok(filtered.filterBarGone,
            '★★ 日记页里**没有**第二套筛选条（分类职责已交给左侧对话记录）');
        ok(filtered.chatHidden, '★ 聊天区没有因此被显示出来');
        ok(filtered.diaryVisible, '★ 日记页仍然可见');

        // ---------- 2.3 再点一次 → 取消筛选 ----------
        const toggled = await page.evaluate(async () => {
            const item = document.querySelector('#folderList [data-conv-id="cB"]');
            item.click();
            await new Promise((r) => setTimeout(r, 400));
            return { filter: state.diaryFilterConvId, cards: document.querySelectorAll('.diary-card').length };
        });
        ok(toggled.filter === '' && toggled.cards === 2,
            '★★ 再点同一段 → 取消筛选、恢复全部（像开关一样，不会"筛进去出不来"）',
            JSON.stringify(toggled));

        // ---------- 2.4 点卡片 → 弹窗看全文 ----------
        const detail = await page.evaluate(async () => {
            const cards = [...document.querySelectorAll('.diary-card')];
            const longCard = cards.find((c) => (c.textContent || '').includes('A 的故事'));
            if (!longCard) return { found: false };
            longCard.click();
            await new Promise((r) => setTimeout(r, 400));
            const ov = document.getElementById('diaryDetailOverlay');
            const txt = document.querySelector('.diary-detail-text');
            return {
                found: true,
                open: ov ? !ov.classList.contains('hidden') : null,
                fullLen: txt ? txt.textContent.length : 0,
                meta: (document.getElementById('diaryDetailMeta') || {}).textContent || '',
                essences: document.querySelectorAll('#diaryDetailBody .diary-essence').length,
                // 卡片上是 4 行截断，弹窗必须是全文
                clampedByCss: (() => {
                    const t = longCard.querySelector('.diary-card-text');
                    return t ? getComputedStyle(t).webkitLineClamp : null;
                })(),
            };
        });
        ok(detail.found && detail.open, '★★★ 点日记卡片会弹出详情（用户要求的"展开查看"）',
            JSON.stringify(detail));
        ok(detail.fullLen > 500,
            '★★★ 弹窗里是**完整正文**（卡片被 CSS 截成 4 行，这里必须是全文）',
            '弹窗长度=' + detail.fullLen);
        ok(String(detail.clampedByCss) === '4',
            '★ 卡片本身仍是 4 行截断（列表保持整齐 —— 靠弹窗看全文）', String(detail.clampedByCss));
        ok(/雪之街/.test(detail.meta), '★ 弹窗标题带来源对话名', detail.meta);
        ok(detail.essences >= 1, '★ 弹窗里保留了关键词标签');

        const closed = await page.evaluate(async () => {
            const b = document.getElementById('diaryDetailClose');
            if (b) b.click();
            await new Promise((r) => setTimeout(r, 300));
            const ov = document.getElementById('diaryDetailOverlay');
            return ov ? ov.classList.contains('hidden') : null;
        });
        ok(closed === true, '★ 关闭按钮能关掉详情弹窗');

        // ---------- 2.5 「进入对话」按钮仍能进对话 ----------
        const enterBtn = await page.evaluate(async () => {
            const b = document.querySelector('.diary-group-enter');
            if (!b) return { found: false };
            b.click();
            await new Promise((r) => setTimeout(r, 600));
            return {
                found: true,
                diaryMode: state.diaryMode,
                currentConv: state.currentConversationId,
                chatVisible: !document.getElementById('conversationHistory').classList.contains('hidden'),
            };
        });
        ok(enterBtn.found && !enterBtn.diaryMode && enterBtn.chatVisible,
            '★★ 「进入对话」按钮仍能切到那段对话（入口没被去掉）', JSON.stringify(enterBtn));

        // ---------- 2.6 ★★ 非日记页时点侧栏必须照旧进对话 ----------
        //
        //   这是最容易被"筛选逻辑"改坏的地方：进对话是最常用的操作，
        //   弄坏它比原来的问题严重得多。所以单独钉一条。
        const normal = await page.evaluate(async () => {
            const item = document.querySelector('#folderList [data-conv-id="cA"]');
            if (!item) return { found: false };
            item.click();
            await new Promise((r) => setTimeout(r, 600));
            return {
                found: true,
                diaryMode: state.diaryMode,
                currentConv: state.currentConversationId,
                chatVisible: !document.getElementById('conversationHistory').classList.contains('hidden'),
            };
        });
        ok(normal.found && !normal.diaryMode && normal.currentConv === 'cA' && normal.chatVisible,
            '★★★ 非日记页点侧栏**照旧进入对话**（筛选逻辑不能影响日常操作）',
            JSON.stringify(normal));

        // ---------- 2.7 重新进日记页 → 筛选被重置 ----------
        const reenter = await page.evaluate(async () => {
            state.diaryFilterConvId = 'cB';     // 人为留一个筛选
            enterDiaryMode();
            await new Promise((r) => setTimeout(r, 400));
            return { filter: state.diaryFilterConvId, cards: document.querySelectorAll('.diary-card').length };
        });
        ok(reenter.filter === '' && reenter.cards === 2,
            '★★ 重新进入日记页时筛选被重置（不会莫名其妙只看到一部分）',
            JSON.stringify(reenter));

        // ---------- 2.8 ★★ 删除对话 → 日记与收藏都要清掉 ----------
        //
        //   用户报："删除对话时会删除日记但是不会删除收藏的句子"。
        //   这里直接调真实的 deleteConversation（走确认框会自动 resolve 吗？——
        //   不行，所以先 stub 掉 showCustomConfirm 让它直接同意）。
        const purge = await page.evaluate(async () => {
            // 造两段对话 + 各一条日记 + 各一条收藏
            state.conversations = [
                { id: 'dA', title: '会被删的对话', messages: [], updatedAt: Date.now() },
                { id: 'dB', title: '要保留的对话', messages: [], updatedAt: Date.now() },
            ];
            state.memoryCore = {
                diary: [
                    { date: '2026年10月14日', content: 'A 的日记', conversationId: 'dA', conversationTitle: '会被删的对话', timestamp: '2026-10-14T10:00:00.000Z' },
                    { date: '2026年10月14日', content: 'B 的日记', conversationId: 'dB', conversationTitle: '要保留的对话', timestamp: '2026-10-14T11:00:00.000Z' },
                ],
                promise: [], preference: [], plan: [], motivation: [], pivotal_memory: [],
            };
            state.favorites = [
                { id: 'f1', conversationId: 'dA', text: 'A 的收藏句子' },
                { id: 'f2', conversationId: 'dB', text: 'B 的收藏句子' },
            ];
            state.currentConversationId = null;

            const before = { diary: state.memoryCore.diary.length, favs: state.favorites.length };

            // 跳过确认框（否则会一直等用户点"确定"）
            const origConfirm = window.showCustomConfirm;
            window.showCustomConfirm = async () => true;
            try {
                await deleteConversation('dA');
            } finally {
                window.showCustomConfirm = origConfirm;
            }
            return {
                before,
                diaryLeft: state.memoryCore.diary.map((e) => e.content),
                favsLeft: state.favorites.map((f) => f.text),
                convLeft: state.conversations.map((c) => c.id),
            };
        });
        ok(purge.diaryLeft.length === 1 && purge.diaryLeft[0] === 'B 的日记',
            '★★★ 删除对话会清掉**该对话的日记**（不是全部日记）',
            JSON.stringify(purge.diaryLeft));
        ok(purge.favsLeft.length === 1 && purge.favsLeft[0] === 'B 的收藏句子',
            '★★★ 删除对话也会清掉**该对话的收藏句子**（用户报的那一半）',
            JSON.stringify(purge.favsLeft));
        ok(!purge.convLeft.includes('dA'), '★ 对话本身被删掉');
        ok(purge.convLeft.includes('dB'), '★ 别的对话不受影响');

        // ---------- 2.9 日记页里删除后要立刻刷新（不能留着空组） ----------
        const liveRefresh = await page.evaluate(async () => {
            state.conversations = [
                { id: 'rA', title: '待删', messages: [], updatedAt: Date.now() },
                { id: 'rB', title: '保留', messages: [], updatedAt: Date.now() },
            ];
            state.memoryCore = {
                diary: [
                    { date: '2026年10月14日', content: 'rA 日记', conversationId: 'rA', conversationTitle: '待删', timestamp: '2026-10-14T10:00:00.000Z' },
                    { date: '2026年10月14日', content: 'rB 日记', conversationId: 'rB', conversationTitle: '保留', timestamp: '2026-10-14T11:00:00.000Z' },
                ],
                promise: [], preference: [], plan: [], motivation: [], pivotal_memory: [],
            };
            state.favorites = [];
            state.diaryFilterConvId = '';
            enterDiaryMode();
            const beforeGroups = document.querySelectorAll('.diary-group-head').length;

            const origConfirm = window.showCustomConfirm;
            window.showCustomConfirm = async () => true;
            try { await deleteConversation('rA'); } finally { window.showCustomConfirm = origConfirm; }

            return {
                beforeGroups,
                afterGroups: document.querySelectorAll('.diary-group-head').length,
                titles: [...document.querySelectorAll('.diary-group-title')].map((e) => e.textContent),
            };
        });
        ok(liveRefresh.beforeGroups === 2, '（准备）删除前有 2 组', String(liveRefresh.beforeGroups));
        ok(liveRefresh.afterGroups === 1 && liveRefresh.titles.includes('保留'),
            '★★ 在日记页里删对话后**立刻刷新**（不留下一个点进去是空的组）',
            JSON.stringify(liveRefresh));

        // ---------- 2.10 ★★ 日记页点对话 → 侧栏要有选中高亮 ----------
        //
        //   用户报的原话："对话记录这里选中后会有选中的特性，但在日记系统中选中
        //   没有对应特效，只有回到聊天才能正常使用。"
        //   所以这里必须测**侧栏条目本身**拿到了 .sidebar-item-active，
        //   而不只是"筛选生效了"（那是另外几条断言的事）。
        //
        //   ★ 必须先恢复 cA/cB：上面 2.8/2.9 两节为了测删除，
        //     已经把 state.conversations 换成了别的 id —— 不恢复的话
        //     侧栏里根本没有 cA/cB，querySelector 返回 null，
        //     三条断言全部假失败（第一版就是这么红的，且现象是 "b":null）。
        const hl = await page.evaluate(async () => {
            state.conversations = [
                { id: 'cA', title: '雪之街的相遇', messages: [], updatedAt: Date.now() },
                { id: 'cB', title: '咖啡馆的午后', messages: [], updatedAt: Date.now() },
            ];
            state.memoryCore = {
                diary: [
                    { date: '2026年10月14日', content: 'A 的故事', essences: [], conversationId: 'cA', conversationTitle: '雪之街的相遇', timestamp: '2026-10-14T10:00:00.000Z' },
                    { date: '2026年10月14日', content: 'B 的故事', essences: [], conversationId: 'cB', conversationTitle: '咖啡馆的午后', timestamp: '2026-10-14T11:00:00.000Z' },
                ],
                promise: [], preference: [], plan: [], motivation: [], pivotal_memory: [],
            };
            state.favorites = [];
            state.currentConversationId = 'cA';
            enterDiaryMode();
            await new Promise((r) => setTimeout(r, 400));
            const before = {
                activeItems: [...document.querySelectorAll('#folderList .sidebar-item-active')].map((e) => e.getAttribute('data-conv-id')),
            };
            focusDiaryGroup('cB');
            await new Promise((r) => setTimeout(r, 400));
            const itemB = document.querySelector('#folderList [data-conv-id="cB"]');
            const itemA = document.querySelector('#folderList [data-conv-id="cA"]');
            return {
                before,
                afterActive: [...document.querySelectorAll('#folderList .sidebar-item-active')].map((e) => e.getAttribute('data-conv-id')),
                bHasClass: itemB ? itemB.classList.contains('sidebar-item-active') : null,
                aHasClass: itemA ? itemA.classList.contains('sidebar-item-active') : null,
                // 当前对话没被动过（仍然是"只筛选不跳转"）
                currentConv: state.currentConversationId,
                stillDiary: state.diaryMode,
            };
        });
        ok(!hl.before.activeItems.includes('cB'),
            '（准备）点之前侧栏没有选中 cB（说明下面是一次真切换）', JSON.stringify(hl.before));
        ok(hl.afterActive.includes('cB') && hl.afterActive.length === 1,
            '★★★ 日记页点对话后，侧栏**只有那段**拿到选中特效（.sidebar-item-active）',
            JSON.stringify(hl.afterActive));
        ok(hl.bHasClass === true && hl.aHasClass === false,
            '★★ 被点的那条高亮、另一条不高亮（不会两条一起亮）',
            JSON.stringify({ b: hl.bHasClass, a: hl.aHasClass }));
        ok(hl.currentConv !== 'cB',
            '★ 同时 currentConversationId 仍没变（"只筛选不跳转"没被破坏）',
            String(hl.currentConv));

        // ★★ 离开日记页 → 高亮要切回"当前对话那段"
        const back = await page.evaluate(async () => {
            state.currentConversationId = 'cA';     // 模拟当前对话是 cA
            exitDiaryMode();
            await new Promise((r) => setTimeout(r, 400));
            const itemA = document.querySelector('#folderList [data-conv-id="cA"]');
            const itemB = document.querySelector('#folderList [data-conv-id="cB"]');
            return {
                aHas: itemA ? itemA.classList.contains('sidebar-item-active') : null,
                bHas: itemB ? itemB.classList.contains('sidebar-item-active') : null,
                diaryMode: state.diaryMode,
                filter: state.diaryFilterConvId,
            };
        });
        ok(back.aHas === true && back.bHas === false,
            '★★ 回到聊天后高亮切回**当前对话**（cA 亮、cB 灭）',
            JSON.stringify(back));
        ok(back.diaryMode === false && back.filter === '',
            '★ 离开日记页时筛选也清掉了');

        console.log('  页面错误:', errs.length ? errs.slice(0, 3).join(' | ') : '(无)');
        ok(errs.length === 0, '★ 全程没有页面 JS 报错', errs.slice(0, 2).join(' | '));

        await ctx.close();
    }
} finally {
    if (browser) { try { await browser.close(); } catch { /* 忽略 */ } }
    child.kill();
    await wait(300);
    for (const d of [DATA_DIR, LOG_DIR, MODS_DIR]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
