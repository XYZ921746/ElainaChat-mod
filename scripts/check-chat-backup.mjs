// 回归检查：APK 侧数据备份（web/js/chat-backup.js）。
//
// 为什么需要：APK 里没有后端，「我的数据」原本整块是隐藏的 —— 而**用户数据在 APK 里更危险**
// （存在应用私有目录，卸载即丢，用户连手动拷出来都做不到）。
// 这个模块让 APK 也能导出/导入，且格式与 Web 版同构（两边可互相导入）。
//
// 检查重点：
//   1. 键清单与 data-sync.js 的 SYNC_KEYS 一致（不一致 = 导出会漏数据）
//   2. 导出的 zip 是**标准格式**（能被 Node 的 zip 读取器解开、CRC 正确）
//   3. 往返一致：导出 → 导入 → 数据完全相同
//   4. 能读 Web 版（后端 store.mjs）导出的 zip —— 这是"两边互通"的关键
//   5. 能读 v1 单 JSON 旧备份
//   6. 边界：空备份、非法文件、越界键都要有明确行为
//
// 全程**不碰浏览器、不触发下载**（见开发文档 8.31 的教训）。
//
// 用法：node scripts/check-chat-backup.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createZip, readZip } from '../server/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label, detail) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

const src = readFileSync(path.join(ROOT, 'web', 'js', 'chat-backup.js'), 'utf8');
// 真实存储层：chat-backup 的数据源是 Store（data/ 是唯一存储），
// 且键清单的权威在 store.js 的 DATA_KEYS —— 这里都取真实源码。
const storeSrc = readFileSync(path.join(ROOT, 'web', 'js', 'store.js'), 'utf8');

// ============================================================ 0. 在假环境里加载
console.log('=== 0. 模块加载 ===');

/** 造一个最小的浏览器环境（Store + Blob + TextEncoder…） */
function makeSandbox(initial = {}) {
    const store = new Map(Object.entries(initial));
    // Blob 用 Node 自带的
    const sandbox = {
        window: {},
        Blob,
        Response,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        Uint32Array,
        DataView,
        Map,
        Set,
        Object,
        Array,
        Number,
        String,
        Math,
        JSON,
        Error,
        Date,
        console,
        // store.js 的写队列用 setTimeout 做防抖；沙箱里补上（用真实的）
        setTimeout,
        clearTimeout,
        DecompressionStream: globalThis.DecompressionStream,
    };
    // store.js 的 Web 后端用同步 XHR 拉 /api/store；纯逻辑沙箱里返回空数据，
    // 让 Store 以"data/ 还没有数据"启动（与首次运行一致），随后用 initial 灌入。
    sandbox.XMLHttpRequest = function () {
        this.open = () => {};
        this.send = () => {};
        Object.defineProperty(this, 'status', { get: () => 200 });
        Object.defineProperty(this, 'responseText', { get: () => '{"ok":true,"data":{}}' });
    };
    sandbox.window = sandbox;   // window 指向自己，够用
    const ctx = vm.createContext(sandbox);
    // ★ 先加载真实存储层（chat-backup 的数据源是 Store，不再是 localStorage）
    vm.runInContext(storeSrc, ctx, { filename: 'store.js' });
    for (const [k, v] of store) sandbox.Store.setItem(k, v);
    vm.runInContext(src, ctx, { filename: 'chat-backup.js' });

    // 让测试里的 `store` 成为 **Store 的视图** —— 断言写的是"数据到底存下来没有"，
    // 那就该问真正的存储层，而不是问测试自己造的那个 Map。
    // 这样每条既有断言都测在真实路径上，也不会因为存储层换实现而失效。
    const view = {
        get: (k) => sandbox.Store.getItem(k),
        has: (k) => sandbox.Store.getItem(k) !== null,
        set: (k, v) => sandbox.Store.setItem(k, v),
        delete: (k) => sandbox.Store.removeItem(k),
        get size() { return Object.keys(sandbox.Store.snapshot()).length; },
        keys: () => Object.keys(sandbox.Store.snapshot()),
        [Symbol.iterator]: function* () { yield* Object.entries(sandbox.Store.snapshot()); },
    };
    return { sandbox, store: view };
}

const s0 = makeSandbox();
ok(Boolean(s0.sandbox.ChatBackup), '模块加载并挂上 window.ChatBackup');

// ============================================================ 1. 键清单一致
console.log('\n=== 1. 键清单以 store.js 为唯一权威 ===');
{
    // ★ 2026-09 重构后，键清单**只有一处**：store.js 的 DATA_KEYS。
    //   以前是 data-sync.js 的 SYNC_KEYS 与 chat-backup.js 的 BACKUP_KEYS 各一份，
    //   靠"断言两处一致"来防漏 —— 那本身就是会腐烂的设计（加一个键要记得改两处）。
    const m = storeSrc.match(/var DATA_KEYS = \[([\s\S]*?)\];/);
    ok(Boolean(m), '能读到 store.js 的 DATA_KEYS');
    const dataKeys = [];
    if (m) {
        // 逐行提取，先剥掉行尾注释再找引号 —— 不能按逗号切分：
        // 注释文字里就有逗号（"设置（模型/地址/开关等）"），会切坏。
        for (const line of m[1].split('\n')) {
            const t = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
            const km = t.match(/'([^']+)'/);
            if (km) dataKeys.push(km[1]);
        }
    }
    const backupKeys = s0.sandbox.ChatBackup.keys();
    console.log('  store.js 有 ' + dataKeys.length + ' 个键，chat-backup 覆盖 ' + backupKeys.length + ' 个');
    const missing = dataKeys.filter((k) => !backupKeys.includes(k));
    ok(missing.length === 0, '★ 备份覆盖了所有数据键（不会漏导数据）',
        missing.length ? '缺: ' + missing.join(', ') : '');
    // chat-backup 不该有超出 DATA_KEYS 的键（插件动态键除外）
    const extra = backupKeys.filter((k) => !dataKeys.includes(k) && !/^elaina_plugin_/.test(k));
    ok(extra.length === 0, '备份没有多余的键', extra.length ? '多: ' + extra.join(', ') : '');
    // 反向：备份清单必须是**动态读取**的，不能是启动时的快照
    ok(typeof s0.sandbox.ChatBackup.keys === 'function',
        '★ 备份清单是函数（动态读 Store，新增键自动覆盖）');
}

// ============================================================ 2. 导出
console.log('\n=== 2. 导出 zip ===');
const SAMPLE = {
    elaina_open_settings: JSON.stringify({ model: 'test-model', apiFormat: 'anthropic' }),
    elainachat_open_api_secrets: JSON.stringify({ apiKey: 'sk-secret' }),
    elaina_open_conversations: JSON.stringify([
        { id: 'conv_a', title: '对话一', messages: [{ role: 'user', text: '你好' }] },
        { id: 'conv_b', title: '对话二', messages: [] },
    ]),
    elaina_open_character_cards: JSON.stringify([
        { id: 'card_a', name: '伊蕾娜', title: '灰之魔女' },
        { id: 'card_b', name: '深海', title: '鲛人' },
    ]),
    elaina_open_character_card: JSON.stringify({ id: 'card_a', name: '伊蕾娜' }),
    elaina_open_current_card: 'card_a',
    elaina_open_memory_core: JSON.stringify({ diary: [{ date: '2026-09-23', content: '记忆' }] }),
    elaina_open_favorites: JSON.stringify([{ id: 'fav1' }]),
    'live2d.bg': 'linear-gradient(#000,#fff)',
    elaina_open_categories: JSON.stringify([]),
    elaina_open_liked_quotes: JSON.stringify({}),
    'live2d.mouseFollow': '1',
    'live2d.mouseFollowScale': '10',
};

let zipBytes = null;
{
    const { sandbox } = makeSandbox(SAMPLE);
    const blob = await sandbox.ChatBackup.buildBackupBlob();
    ok(blob && typeof blob.arrayBuffer === 'function', '生成了 Blob');
    const buf = Buffer.from(await blob.arrayBuffer());
    zipBytes = buf;
    ok(buf.length > 0, 'zip 非空', buf.length + ' 字节');
    ok(buf.readUInt32LE(0) === 0x04034b50, '是合法 zip（PK 头）');

    // 用后端的读取器（独立实现）来验证 —— 交叉验证才有说服力
    const files = readZip(buf);
    const names = files.map((f) => f.name);
    console.log('  zip 内 ' + names.length + ' 个文件: ' + names.join(', '));
    ok(names.includes('manifest.json'), '含 manifest.json');
    ok(names.includes('settings.json'), '含 settings.json');
    ok(names.includes('characters/index.json'), '含 characters/index.json');
    ok(names.includes('characters/card_a.json'), '含 characters/card_a.json');
    ok(names.includes('characters/card_b.json'), '含 characters/card_b.json');
    ok(names.includes('conversations/index.json'), '含 conversations/index.json');
    ok(names.includes('conversations/conv_a.json'), '含 conversations/conv_a.json');
    ok(names.some((n) => /^memory\/[A-Za-z0-9_-]+\.json$/.test(n)), '含 memory/<类目>.json');

    const get = (n) => files.find((f) => f.name === n).data.toString('utf8');
    const manifest = JSON.parse(get('manifest.json'));
    ok(manifest.format === 'elainachat-backup', 'manifest 格式标识正确');
    ok(manifest.version === 2, 'manifest 版本为 2', String(manifest.version));
    ok(manifest.source === 'apk', 'manifest 标明来源是 apk');
    ok(manifest.counts.characters === 2, 'manifest 统计人设卡数', JSON.stringify(manifest.counts));
    ok(manifest.counts.conversations === 2, 'manifest 统计对话数', JSON.stringify(manifest.counts));

    const settings = JSON.parse(get('settings.json'));
    ok(settings.elaina_open_settings !== undefined, 'settings.json 含设置');
    ok(settings.elainachat_open_api_secrets !== undefined, 'settings.json 含 API Key');
    ok(settings['live2d.bg'] !== undefined, 'settings.json 含 Live2D 偏好');
    ok(settings.elaina_open_character_cards === undefined, 'settings.json 不含人设卡（已拆出去）');
    ok(settings.elaina_open_conversations === undefined, 'settings.json 不含对话（已拆出去）');

    const memFile = names.find((n) => /^memory\/[A-Za-z0-9_-]+\.json$/.test(n));
    const mem = JSON.parse(get(memFile));
    ok(typeof mem.value !== 'undefined', 'memory/<类目>.json 是 {value} 形态（与后端同构）');

    const cidx = JSON.parse(get('characters/index.json'));
    ok(cidx.currentCardId === 'card_a', 'index 记录当前卡片');
    ok(cidx.order.join(',') === 'card_a,card_b', 'index 记录卡片顺序');
}

// ============================================================ 3. 往返
console.log('\n=== 3. 导出 → 导入 往返一致 ===');
{
    const empty = makeSandbox();
    const file = new File([zipBytes], 'backup.zip', { type: 'application/zip' });
    const res = await empty.sandbox.ChatBackup.applyBackup(file);
    ok(res.keys > 0, '导入写入了键', 'keys=' + res.keys);
    ok(res.source === 'zip', '识别为 zip 来源', res.source);

    // elaina_open_character_card（当前生效的那套）**不参与往返比对**：
    // 导出时不单独存它，导入时由 currentCardId 从 characters/ 里挑出来重建。
    // 这是有意的 —— 它本来就只是"列表里当前选中那张"的副本，单独存反而会不一致。
    const ROUNDTRIP_SKIP = new Set(['elaina_open_character_card']);
    let same = 0;
    const diffs = [];
    for (const [k, v] of Object.entries(SAMPLE)) {
        if (ROUNDTRIP_SKIP.has(k)) continue;
        const got = empty.store.get(k);
        if (got === v) same++;
        else diffs.push(k + (got === undefined ? '(缺失)' : '(值不同)'));
    }
    const compared = Object.keys(SAMPLE).length - ROUNDTRIP_SKIP.size;
    ok(diffs.length === 0, '所有键的值与导出前完全相同', diffs.join(', '));
    console.log('  比对 ' + compared + ' 个键，一致 ' + same + ' 个（跳过 ' + [...ROUNDTRIP_SKIP].join(',') + '）');

    // 但"当前生效的卡"必须被重建出来，且内容等于当前选中的那张
    const activeCard = empty.store.get('elaina_open_character_card');
    ok(Boolean(activeCard), '当前生效的卡被重建');
    if (activeCard) {
        ok(JSON.parse(activeCard).id === 'card_a', '重建的是 currentCardId 指向的那张', JSON.parse(activeCard).id);
    }
}

// ============================================================ 4. 读 Web 版的 zip
console.log('\n=== 4. 能读 Web 版（后端）导出的 zip ===');
{
    // 用后端的 createZip 造一份"Web 版格式"的备份（带 deflate 的大条目）
    const webZip = createZip([
        { name: 'manifest.json', data: JSON.stringify({ format: 'elainachat-backup', version: 2, source: 'web' }) },
        { name: 'settings.json', data: JSON.stringify({ elaina_open_settings: JSON.stringify({ model: 'from-web' }) }) },
        { name: 'characters/index.json', data: JSON.stringify({ version: 1, currentCardId: 'web_card', order: ['web_card'] }) },
        { name: 'characters/web_card.json', data: JSON.stringify({ id: 'web_card', name: '来自Web的卡' }) },
        { name: 'conversations/index.json', data: JSON.stringify({ version: 1, order: ['web_conv'] }) },
        // 故意做大一点，逼后端用 deflate（method=8），验证 APK 侧能解压
        { name: 'conversations/web_conv.json', data: JSON.stringify({ id: 'web_conv', title: '来自Web的对话', messages: Array.from({ length: 50 }, (_, i) => ({ role: 'user', text: '消息' + i })) }) },
        { name: 'memory.json', data: JSON.stringify({ version: 1, value: JSON.stringify({ diary: [{ date: '2026-09-23', content: 'web记忆' }] }) }) },
    ]);

    const { sandbox, store } = makeSandbox();
    const file = new File([webZip], 'web-backup.zip', { type: 'application/zip' });
    const res = await sandbox.ChatBackup.applyBackup(file);
    ok(res.source === 'zip', '识别为 zip');
    ok(store.get('elaina_open_settings') && JSON.parse(store.get('elaina_open_settings')).model === 'from-web', '读到 Web 版的设置');
    const cards = JSON.parse(store.get('elaina_open_character_cards') || '[]');
    ok(cards.length === 1 && cards[0].id === 'web_card', '读到 Web 版的人设卡', JSON.stringify(cards.map((c) => c.id)));
    ok(store.get('elaina_open_current_card') === 'web_card', '读到当前卡片 id');
    const convs = JSON.parse(store.get('elaina_open_conversations') || '[]');
    ok(convs.length === 1 && convs[0].id === 'web_conv', '读到 Web 版的对话');
    ok(convs[0].messages.length === 50, 'deflate 压缩的条目被正确解压', 'got ' + (convs[0].messages || []).length);
    ok(JSON.parse(store.get('elaina_open_memory_core') || '{}').diary.length === 1, '读到 Web 版的记忆');
    // 当前生效的卡也要补齐（Web 版导出里没有 elaina_open_character_card）
    ok(Boolean(store.get('elaina_open_character_card')), '自动补出"当前生效的卡"');
}

// ============================================================ 5. v1 旧备份
console.log('\n=== 5. 能读 v1 单 JSON 旧备份 ===');
{
    const v1 = Buffer.from(JSON.stringify({
        format: 'elainachat-backup',
        version: 1,
        data: {
            elaina_open_settings: JSON.stringify({ model: 'from-v1' }),
            elaina_open_conversations: JSON.stringify([{ id: 'v1conv' }]),
        },
    }), 'utf8');
    const { sandbox, store } = makeSandbox();
    const file = new File([v1], 'old.json', { type: 'application/json' });
    const res = await sandbox.ChatBackup.applyBackup(file);
    ok(res.source === 'json', '识别为 json 来源', res.source);
    ok(JSON.parse(store.get('elaina_open_settings')).model === 'from-v1', '读到 v1 设置');
    ok(JSON.parse(store.get('elaina_open_conversations'))[0].id === 'v1conv', '读到 v1 对话');
}

// ============================================================ 6. 边界
console.log('\n=== 6. 边界情况 ===');
{
    // 非法文件
    const { sandbox } = makeSandbox();
    let threw = null;
    try {
        await sandbox.ChatBackup.applyBackup(new File([Buffer.from('这不是备份', 'utf8')], 'x.txt'));
    } catch (e) { threw = e; }
    ok(threw !== null, '非法内容被拒绝', threw && threw.message);

    // 空数据
    let threw2 = null;
    try {
        await sandbox.ChatBackup.applyBackup(new File([Buffer.from(JSON.stringify({ data: {} }), 'utf8')], 'e.json'));
    } catch (e) { threw2 = e; }
    ok(threw2 !== null, '空备份被拒绝', threw2 && threw2.message);

    // 越界的键不该写进 localStorage
    const { sandbox: sb3, store: st3 } = makeSandbox();
    const weird = Buffer.from(JSON.stringify({ data: { evil_key: 'x', elaina_open_settings: JSON.stringify({ ok: 1 }) } }), 'utf8');
    await sb3.ChatBackup.applyBackup(new File([weird], 'w.json'));
    ok(!st3.has('evil_key'), '范围外的键被忽略（不污染 localStorage）');
    ok(st3.has('elaina_open_settings'), '范围内的键正常写入');

    // 空 localStorage 导出：应当仍然产出一个合法 zip（含 manifest）
    const { sandbox: sb4 } = makeSandbox();
    const blob = await sb4.ChatBackup.buildBackupBlob();
    const buf = Buffer.from(await blob.arrayBuffer());
    ok(buf.readUInt32LE(0) === 0x04034b50, '空数据也能导出合法 zip');
    const files = readZip(buf);
    ok(files.some((f) => f.name === 'manifest.json'), '空备份仍有 manifest');
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：' + failures.join('、'));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
