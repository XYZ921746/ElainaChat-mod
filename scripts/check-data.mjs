// 数据与存储的回归检查：data/ 唯一权威 + 分类布局 + 导入导出 + zip 解压 + 多设备同步。
// 六段测同一对象，防"悄无声息地丢数据"；每段用例各自作用域跑并自清理进程与临时目录。
// 用法：node scripts/check-data.mjs          跑全部
//       node scripts/check-data.mjs 迁移      只跑名字含该子串的用例

import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createStore } from '../server/store.mjs';
import { createZip, readZip, BLOCKED_EXT, effectiveExt } from '../server/zip.mjs';
import { launchTestBrowser } from './test-browser.mjs';
import { runChecks, ROOT, wait, waitFor, waitServerUp, freePort } from './check-harness.mjs';

/**
 * 起一个真实服务（web/serve.mjs），带独立的 DATA_DIR / LOG_DIR：
 * 要测的是进程启动行为（自动迁移、内置角色卡写入、缓存与磁盘绑定），必须真跑；
 * 且绝不碰用户 data/，LOG_TO_FILE=0 让日志不落盘。
 */
function startServer({ port, dataDir, logDir, extraEnv = {}, cwd = ROOT }) {
    const st = { out: '' };
    st.child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
        cwd,
        env: {
            ...process.env,
            PORT: String(port),
            HTTPS_PORT: String(port + 1),
            HOST: '127.0.0.1',
            DATA_DIR: dataDir,
            LOG_DIR: logDir,
            LOG_TO_FILE: '0',
            ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    st.child.stdout.on('data', (d) => { st.out += d; });
    st.child.stderr.on('data', (d) => { st.out += d; });
    return st;
}

/** 杀掉子进程并等它真的退出 —— 不等的话端口可能还没释放，下一个用例会撞上 */
async function killServer(st) {
    if (!st || !st.child || st.child.exitCode !== null) return;
    const exited = new Promise((r) => st.child.once('exit', r));
    st.child.kill();
    await Promise.race([exited, wait(3000)]);
}

// 1. 数据导入导出 API（端到端，zip 备份）
// 导出/导入是用户数据的最后一道保险，错得很隐蔽（少文件 / 静默丢）；起真实服务走 HTTP 验证。

async function caseDataApi(c) {
    const ok = (cond, label, detail) => c.ok(cond, label, detail);

    const sandbox = await mkdtemp(path.join(tmpdir(), 'elaina-dataapi-'));
    const dataDir = path.join(sandbox, 'data');
    const logDir = path.join(sandbox, 'logs');
    const modsDir = path.join(sandbox, 'mods');
    const skillsDir = path.join(sandbox, 'skills');
    await mkdir(dataDir, { recursive: true });
    // 备份要含插件与技能，须一并隔离到临时目录（不读用户真实 mods/，其内容随本机安装变化）
    await mkdir(path.join(modsDir, 'demo-mod-1.0.0'), { recursive: true });
    await writeFile(path.join(modsDir, 'demo-mod-1.0.0', 'manifest.json'), JSON.stringify({
        id: 'demo-mod', name: '备份检查插件', version: '1.0.0', entry: 'index.js',
    }), 'utf8');
    await writeFile(path.join(modsDir, 'demo-mod-1.0.0', 'index.js'), 'window.__demoModLoaded = true;', 'utf8');
    await mkdir(path.join(skillsDir, 'demo-skill'), { recursive: true });
    await writeFile(path.join(skillsDir, 'demo-skill', 'SKILL.md'), '---\nname: 备份检查技能\n---\n', 'utf8');

    const PORT = await freePort();
    let server = null;

    try {
        const legacyCards = [
            { id: 'card_x', name: '测试卡一', title: 'T1', worldSetting: 'W1', characterPrompt: 'P1' },
            { id: 'card_y', name: '测试卡二', title: 'T2', worldSetting: 'W2', characterPrompt: 'P2' },
        ];
        await writeFile(path.join(dataDir, 'store.json'), JSON.stringify({
            elaina_open_character_cards: JSON.stringify(legacyCards),
            elaina_open_current_card: 'card_x',
            elaina_open_memory_core: JSON.stringify({ diary: [{ date: '2026-09-22', content: '记忆一' }], promise: [] }),
            elaina_open_settings: JSON.stringify({ model: 'test-model' }),
            elainachat_open_api_secrets: JSON.stringify({ apiKey: 'sk-test' }),
        }), 'utf8');
        await writeFile(path.join(dataDir, 'conversations.json'), JSON.stringify({
            version: 1,
            value: JSON.stringify([{ id: 'conv1', title: '测试对话', messages: [{ role: 'user', text: '你好' }] }]),
        }), 'utf8');

        server = startServer({
            port: PORT, dataDir, logDir,
            extraEnv: { LOG_CHAT: '0', MODS_DIR: modsDir, SKILLS_DIR: skillsDir },
        });
        const bootLog = () => server.out;

        const base = `http://127.0.0.1:${PORT}`;
        let up = false;
        for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
            try {
                if ((await fetch(base + '/api/server-info')).ok) { up = true; break; }
            } catch { /* 还没起来 */ }
            await wait(300);
        }
        if (!up) throw new Error('服务没能启动：\n' + bootLog().slice(0, 1500));

        console.log('=== 1. 启动时自动迁移旧数据 ===');
        ok(bootLog().includes('数据已迁移到分类存储'), '启动日志报告已迁移', bootLog().split('\n').find((l) => l.includes('迁移')) || '(无)');
        ok(existsSync(path.join(dataDir, 'main', 'characters', 'card_x.json')), '人设卡迁移成独立文件');
        ok(existsSync(path.join(dataDir, 'conversations', 'conv1.json')), '旧单文件聊天记录拆成一对话一文件');
        ok(!existsSync(path.join(dataDir, 'conversations.json')), '旧的单文件 conversations.json 已删除');
        ok(existsSync(path.join(dataDir, 'main', 'memory', 'diary.json')), '记忆迁移成 memory/<类目>.json');
        {
            const misc = JSON.parse(await readFile(path.join(dataDir, 'main', 'store.json'), 'utf8'));
            ok(misc.elaina_open_settings !== undefined, 'store.json 保留设置');
            ok(misc.elainachat_open_api_secrets !== undefined, 'store.json 保留 API Key');
            ok(misc.elaina_open_character_cards === undefined, 'store.json 不再含人设卡');
        }

        console.log('\n=== 2. /api/store 读回（前端视角不变）===');
        {
            const r = await fetch(base + '/api/store');
            const j = await r.json();
            ok(r.status === 200 && j.ok, 'GET /api/store 成功');
            const cards = JSON.parse(j.data.elaina_open_character_cards || '[]');
            ok(cards.length === 2, '人设卡读回 2 张', 'got ' + cards.length);
            ok(cards[0].name === '测试卡一', '卡片内容完整');
            ok(j.data.elaina_open_current_card === 'card_x', '当前卡片 id 读回');
            const convs = JSON.parse(j.data.elaina_open_conversations || '[]');
            ok(convs.length === 1, '聊天记录读回');
            ok(convs[0].messages[0].text === '你好', '对话消息完整');
            ok(JSON.parse(j.data.elaina_open_memory_core || '{}').diary.length === 1, '记忆读回');
            ok(JSON.parse(j.data.elaina_open_settings || '{}').model === 'test-model', '设置读回');
        }

        console.log('\n=== 3. /api/data/info ===');
        {
            const r = await fetch(base + '/api/data/info');
            const j = await r.json();
            ok(r.status === 200 && j.ok, 'GET /api/data/info 成功');
            ok(j.counts.characters === 2, '统计人设卡数 = 2', 'got ' + j.counts.characters);
            ok(j.counts.conversations === 1, '统计聊天记录数 = 1', 'got ' + j.counts.conversations);
            ok(j.counts.memoryEntries === 1, '统计记忆条数 = 1', 'got ' + j.counts.memoryEntries);
            ok(j.counts.mods === 1, '统计已安装插件数 = 1', 'got ' + j.counts.mods);
            ok(j.counts.skills === 1, '统计本地技能数 = 1', 'got ' + j.counts.skills);
            ok(typeof j.dir === 'string' && j.dir.length > 0, '返回数据目录');
            ok(/conversations\//.test(JSON.stringify(j.layout)), 'layout 说明聊天记录是一对话一文件');
        }

        console.log('\n=== 4. 导出 zip ===');
        let zipBuf = null;
        {
            const r = await fetch(base + '/api/data/export');
            ok(r.status === 200, 'GET /api/data/export 成功');
            // 刻意不发 attachment（下载器机器级扩展会抢走该 URL），文件名走自定义头，
            // 前端 fetch 成 blob 后用 <a download> 保存。
            const cd = r.headers.get('content-disposition') || '';
            ok(!/attachment/i.test(cd), '不发 attachment（避免被下载器扩展拦截）', cd || '(无)');
            const fn = r.headers.get('x-backup-filename') || '';
            ok(/^elainachat-backup-.*\.zip$/.test(fn), '用自定义头带文件名', fn);
            ok(/zip/.test(r.headers.get('content-type') || ''), 'Content-Type 是 zip');

            zipBuf = Buffer.from(await r.arrayBuffer());
            ok(zipBuf.readUInt32LE(0) === 0x04034b50, '是合法 zip（PK 头）');

            // allowScripts：备份里含插件入口 .js，默认黑名单会把它藏起来；
            // 这里要看的是"备份实际装了什么"，不是"数据分支能读什么"。
            const files = readZip(zipBuf, { allowScripts: true });
            const names = files.map((f) => f.name);
            const get = (n) => files.find((f) => f.name === n);

            const manifest = JSON.parse(get('manifest.json').data.toString('utf8'));
            ok(manifest.format === 'elainachat-backup', '格式标识正确');
            ok(manifest.version === 3, '版本号为 3（zip + data/ 目录）', 'got ' + manifest.version);
            ok(typeof manifest.exportedAt === 'string', '含导出时间');
            // 顶层三件：data/ / mods/ / skills/ —— 解压后与项目根一一对应
            const topDirs = [...new Set(names.map((n) => (n.includes('/') ? n.split('/')[0] : '(根文件)')))];
            ok(topDirs.every((d) => d === 'data' || d === 'mods' || d === 'skills' || d === '(根文件)'),
                '★ 顶层只有 data / mods / skills（外加 manifest.json）', topDirs.join(','));
            ok(names.filter((n) => !n.includes('/')).join(',') === 'manifest.json', '根上只有 manifest.json', names.filter((n) => !n.includes('/')).join(','));
            ok(names.includes('data/settings.json'), 'zip 含 data/settings.json');
            ok(names.includes('mods/demo-mod-1.0.0/index.js'), 'zip 含插件的入口脚本');
            ok(names.includes('mods/demo-mod-1.0.0/manifest.json'), 'zip 含插件 manifest');
            ok(!names.includes('mods/index.json'), 'zip 不含扫描生成的 mods/index.json');
            ok(names.includes('skills/demo-skill/SKILL.md'), 'zip 含本地技能');
            ok(manifest.counts.mods === 1, 'manifest 统计插件数', JSON.stringify(manifest.counts));
            ok(manifest.counts.skills === 1, 'manifest 统计技能数', JSON.stringify(manifest.counts));
            ok(names.includes('data/characters/index.json'), 'zip 含 data/characters/index.json');
            ok(names.filter((n) => /^data\/characters\/.+\.json$/.test(n) && !n.endsWith('index.json')).length === 2, 'zip 含 2 张卡（一卡一文件）');
            ok(names.includes('data/conversations/index.json'), 'zip 含 data/conversations/index.json');
            ok(names.filter((n) => /^data\/conversations\/.+\.json$/.test(n) && !n.endsWith('index.json')).length === 1, 'zip 含 1 个对话（一对话一文件）');
            ok(names.some((n) => /^data\/memory\/[A-Za-z0-9_-]+\.json$/.test(n)), 'zip 含 data/memory/<类目>.json');

            const settings = JSON.parse(get('data/settings.json').data.toString('utf8'));
            ok(settings.elaina_open_settings !== undefined, 'settings.json 含设置');
            ok(settings.elainachat_open_api_secrets !== undefined, 'settings.json 含 API Key');
            const memFile = names.find((n) => /^data\/memory\/[A-Za-z0-9_-]+\.json$/.test(n));
            ok(typeof JSON.parse(get(memFile).data.toString('utf8')).value !== 'undefined', 'memory/<类目>.json 是 {value} 形态');
        }

        console.log('\n=== 5. 通过 /api/store 写入后再导出（新数据要能进备份）===');
        {
            const r = await fetch(base + '/api/store', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: {
                    elaina_open_favorites: JSON.stringify([{ id: 'fav1' }]),
                    elaina_open_settings: JSON.stringify({ model: 'changed' }),
                } }),
            });
            const j = await r.json();
            ok(r.status === 200 && j.ok, 'POST /api/store 成功');
            ok(j.keys === 2, '报告写入 2 个键', 'got ' + j.keys);

            const r2 = await fetch(base + '/api/data/export');
            const files = readZip(Buffer.from(await r2.arrayBuffer()));
            const settings = JSON.parse(files.find((f) => f.name === 'data/settings.json').data.toString('utf8'));
            ok(JSON.parse(settings.elaina_open_favorites || '[]').length === 1, '新写入的收藏进了备份');
            ok(JSON.parse(settings.elaina_open_settings).model === 'changed', '修改后的设置进了备份');
            const cardNames = files.map((f) => f.name).filter((n) => /^data\/characters\/.+\.json$/.test(n) && !n.endsWith('index.json'));
            ok(cardNames.length === 2, '分类数据未被单键写入覆盖', 'got ' + cardNames.length);
        }

        console.log('\n=== 5b. /api/store 删除（removeItem → null 补丁）===');
        {
            // 前端删除提交的是 `{ 键: null }`：非字符串值若被丢弃，删除就永远落不了盘
            const post = (data) => fetch(base + '/api/store', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data }),
            }).then((r) => r.json());

            const KEY = 'elaina_plugin_failed_zz_check';
            await post({ [KEY]: JSON.stringify({ at: 1, error: '旧错误' }) });
            ok((await (await fetch(base + '/api/store')).json()).data[KEY] !== undefined,
                '前置：失败记录已写入');

            const dj = await post({ [KEY]: null });
            ok(dj.ok === true, 'POST 删除补丁成功', JSON.stringify(dj));
            ok(dj.keys === 1, 'null 补丁被算作一个改动键（没有被静默丢弃）', 'got ' + dj.keys);

            const s = (await (await fetch(base + '/api/store')).json()).data;
            ok(!(KEY in s), '★ 读取时该键已不存在（内存缓存里真删了）');

            const disk = JSON.parse(await readFile(path.join(dataDir, 'main', 'store.json'), 'utf8'));
            ok(!(KEY in disk), '★ 删除已落盘（不是只从内存里消失、刷新又回来）');
            ok(Object.values(disk).every((v) => v !== null), 'store.json 里不会留下 `键: null` 的假数据');
        }

        console.log('\n=== 6. 导入 zip（merge 模式）===');
        {
            // 改一份 zip（加新卡 / 改设置）重打包；allowScripts 必须开，否则测的是缺入口的残包
            const files = readZip(zipBuf, { allowScripts: true });
            const entries = files.map((f) => ({ name: f.name, data: f.data }));
            const setEntry = (name, data) => {
                const buf = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
                const i = entries.findIndex((e) => e.name === name);
                if (i >= 0) entries[i].data = buf; else entries.push({ name, data: buf });
            };
            const charsIdx = JSON.parse(files.find((f) => f.name === 'data/characters/index.json').data.toString('utf8'));
            charsIdx.order.push('card_z');
            setEntry('data/characters/index.json', charsIdx);
            setEntry('data/characters/card_z.json', { id: 'card_z', name: '备份里的新卡' });
            const settings = JSON.parse(files.find((f) => f.name === 'data/settings.json').data.toString('utf8'));
            settings.elaina_open_settings = JSON.stringify({ model: 'from-backup' });
            setEntry('data/settings.json', settings);
            setEntry('mods/from-backup-1.0.0/manifest.json',
                { id: 'from-backup', name: '备份里的插件', version: '1.0.0', entry: 'index.js' });
            setEntry('mods/from-backup-1.0.0/index.js', 'window.__fromBackup = true;');
            setEntry('mods/from-backup-1.0.0/bad.exe', 'not allowed');
            setEntry('skills/from-backup/SKILL.md', '---\nname: 备份里的技能\n---\n');
            const modZip = createZip(entries);

            const r = await fetch(base + '/api/data/import?mode=merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: modZip,
            });
            const j = await r.json();
            ok(r.status === 200 && j.ok, 'POST /api/data/import 成功', JSON.stringify(j));
            ok(j.mode === 'merge', '报告 merge 模式');
            ok(j.source === 'zip', '识别为 zip 来源', String(j.source));

            const s = (await (await fetch(base + '/api/store')).json()).data;
            ok(JSON.parse(s.elaina_open_settings).model === 'from-backup', '导入覆盖了设置');
            ok(JSON.parse(s.elaina_open_character_cards).length === 3, '导入后卡片变 3 张', 'got ' + JSON.parse(s.elaina_open_character_cards).length);
            ok(JSON.parse(s.elaina_open_favorites || '[]').length === 1, 'merge 不清掉备份里没有的键');
            ok(existsSync(path.join(dataDir, 'main', 'characters', 'card_z.json')), '导入的新卡落成独立文件');

            ok(existsSync(path.join(modsDir, 'from-backup-1.0.0', 'index.js')), '★ 导入写回了插件入口脚本（zip 里是 .js，恢复时放行）');
            ok(existsSync(path.join(modsDir, 'from-backup-1.0.0', 'manifest.json')), '导入写回了插件 manifest');
            ok(!existsSync(path.join(modsDir, 'from-backup-1.0.0', 'bad.exe')), '导入没有落盘被拦下的可执行文件');
            ok(existsSync(path.join(skillsDir, 'from-backup', 'SKILL.md')), '导入写回了技能');
            ok(j.packages && j.packages.mods >= 1 && j.packages.skills >= 1, '导入结果报告恢复了插件与技能', JSON.stringify(j.packages));
            const modIndex = JSON.parse(await readFile(path.join(modsDir, 'index.json'), 'utf8'));
            ok(Array.isArray(modIndex.plugins) && modIndex.plugins.some((p) => p.id === 'from-backup'),
                '导入后重扫插件清单（前端能立刻看到新插件）', JSON.stringify(modIndex.plugins.map((p) => p.id)));
        }

        console.log('\n=== 7. 导入边界 ===');
        {
            const post = (body) => fetch(base + '/api/data/import', {
                method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
            });

            ok((await post(JSON.stringify({ data: {} }))).status === 400, '空数据被拒绝（400）');
            ok((await post(JSON.stringify({ data: { k: 123 } }))).status === 400, '非字符串值被拒绝（400）');
            // 这三条只验证"坏输入不改动已有数据"—— 已有数据来自第 6 步的导入。
            ok((await post(Buffer.from('既不是 zip 也不是 json 的一堆字节', 'utf8'))).status === 400, '非法内容被拒绝（400）');

            const s = (await (await fetch(base + '/api/store')).json()).data;
            ok(JSON.parse(s.elaina_open_character_cards || '[]').length === 3, '导入失败不影响已有数据');
        }

        console.log('\n=== 8. 兼容 v1 单 JSON 旧备份 ===');
        {
            const v1 = Buffer.from(JSON.stringify({
                format: 'elainachat-backup',
                version: 1,
                data: { elaina_open_settings: JSON.stringify({ model: 'from-v1' }) },
            }), 'utf8');
            const r = await fetch(base + '/api/data/import?mode=merge', {
                method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: v1,
            });
            const j = await r.json();
            ok(r.status === 200 && j.ok, 'v1 备份能导入', JSON.stringify(j));
            ok(j.source === 'json', '识别为 json 来源', String(j.source));
            const s = (await (await fetch(base + '/api/store')).json()).data;
            ok(JSON.parse(s.elaina_open_settings).model === 'from-v1', 'v1 备份的设置生效');
        }

        console.log('\n=== 9. 落盘检查（真正写到磁盘）===');
        {
            const idx = JSON.parse(await readFile(path.join(dataDir, 'main', 'characters', 'index.json'), 'utf8'));
            ok(Array.isArray(idx.order) && idx.order.length === 3, '磁盘上 index 有 3 张卡', 'got ' + (idx.order || []).length);
            ok(existsSync(path.join(dataDir, 'main', 'characters', 'card_z.json')), '磁盘上有新导入的卡');

            const vidx = JSON.parse(await readFile(path.join(dataDir, 'conversations', 'index.json'), 'utf8'));
            ok(Array.isArray(vidx.order) && vidx.order.length === 1, '磁盘上有 conversations/index.json');
            ok(existsSync(path.join(dataDir, 'conversations', vidx.order[0] + '.json')), '磁盘上有一对话一文件');

            const files = await readdir(path.join(dataDir, 'main', 'characters'));
            ok(!files.includes('card_x.json.tmp'), '没有遗留的 .tmp 临时文件');
            ok(!existsSync(path.join(dataDir, 'conversations.json')), '没有遗留的旧单文件 conversations.json');
            const modEntries = await readdir(modsDir);
            ok(!modEntries.some((n) => n.startsWith('.restoring-')), '没有遗留的插件恢复临时目录', JSON.stringify(modEntries));
        }

        // 放在最后：它会合并进另一份数据，放前面会把第 6/9 步依赖的 3 张卡改掉
        console.log('\n=== 10. 兼容 v2 旧布局（settings.json 等在根上）===');
        {
            const legacyZip = createZip([
                { name: 'manifest.json', data: JSON.stringify({ format: 'elainachat-backup', version: 2 }) },
                { name: 'settings.json', data: JSON.stringify({ elaina_open_settings: JSON.stringify({ model: 'legacy-layout' }) }) },
                { name: 'characters/index.json', data: JSON.stringify({ version: 1, currentCardId: 'old_card', order: ['old_card'] }) },
                { name: 'characters/old_card.json', data: JSON.stringify({ id: 'old_card', name: '旧布局的卡' }) },
                { name: 'conversations/index.json', data: JSON.stringify({ version: 1, order: ['old_conv'] }) },
                { name: 'conversations/old_conv.json', data: JSON.stringify({ id: 'old_conv', title: '旧布局的对话', messages: [] }) },
                { name: 'memory/diary.json', data: JSON.stringify({ version: 1, value: [{ date: '2026-01-01', content: '旧布局的记忆' }] }) },
            ]);
            const r = await fetch(base + '/api/data/import?mode=merge', {
                method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: legacyZip,
            });
            const j = await r.json();
            ok(r.status === 200 && j.ok, 'v2 旧布局仍能导入', JSON.stringify(j));
            const s = (await (await fetch(base + '/api/store')).json()).data;
            ok(JSON.parse(s.elaina_open_settings).model === 'legacy-layout', '读到根上的 settings.json');
            ok(JSON.parse(s.elaina_open_conversations || '[]').some((c) => c.id === 'old_conv'), '读到根上的 conversations/');
            ok(JSON.parse(s.elaina_open_memory_core || '{}').diary.length >= 1, '读到根上的 memory/<类目>.json');
        }
    } finally {
        await killServer(server);
        await wait(500);
        await rm(sandbox, { recursive: true, force: true }).catch(() => {});
    }
}

// 2. data/ 是唯一存储
// 两条核心事实：① 写入后 data/ 里有数据 ② 删掉 data/ 后数据真的为空。

async function caseDataAuthority(c) {
    const ok = (cond, label, extra) => c.ok(cond, label, extra);

    const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-log-'));
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-data-'));
    const PORT = await freePort();
    const BASE = `http://127.0.0.1:${PORT}`;

    // 同一组环境变量起/重启服务（"删掉 data/ 再重启"那一步要用同一个端口与目录）
    const startServerImpl = () => startServer({ port: PORT, dataDir: DATA_DIR, logDir: LOG_DIR });

    let browser = null;
    let server = null;
    try {
        // 用共用的启动器：它负责浏览器路径与屏蔽外网两件环境相关的事（详见 scripts/test-browser.mjs）
        browser = await launchTestBrowser();
        server = startServerImpl();
        ok(await waitServerUp(BASE), '服务已启动', server.out.slice(-400));

        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', (e) => errs.push(e.message));
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);

        await page.evaluate(() => {
            state.conversations = [{ id: 'conv-test-1', title: '删库测试', messages: [
                { id: 'm1', role: 'user', text: '这是应该被保存的消息', timestamp: '00:00:00' },
            ] }];
            saveConversations();
            state.settings.model = 'model-should-persist';
            persistSettings();
            Store.setItem('elaina_theme', 'dark');
        });
        // 等防抖推送（store.js 是 800ms）真的落盘 —— 等文件内容，不等固定时长
        await waitFor(() => {
            const f = path.join(DATA_DIR, 'main', 'store.json');
            return existsSync(f) && /model-should-persist/.test(readFileSync(f, 'utf8'));
        }, { timeoutMs: 8000, label: '防抖写入落盘' });

        ok(existsSync(path.join(DATA_DIR, 'main', 'store.json')), '★ 写入后 data/main/store.json 已生成');
        const store1 = JSON.parse(readFileSync(path.join(DATA_DIR, 'main', 'store.json'), 'utf8'));
        ok(!!store1['elaina_open_settings'], 'settings 进了 data/');
        ok(/model-should-persist/.test(store1['elaina_open_settings'] || ''), 'settings 内容正确');
        ok(store1['elaina_theme'] === 'dark', '主题设置进了 data/');
        const convDir = path.join(DATA_DIR, 'conversations');
        const convFiles = existsSync(convDir) ? readdirSync(convDir).filter((f) => f.endsWith('.json')) : [];
        ok(convFiles.length > 0, '★ 聊天记录进了 data/conversations/', JSON.stringify(convFiles));
        const convBody = convFiles.map((f) => readFileSync(path.join(convDir, f), 'utf8')).join('');
        ok(/这是应该被保存的消息/.test(convBody), '★ 聊天正文确实写进了 data/');

        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitFor(() => page.evaluate(() => typeof state !== 'undefined'
            && Array.isArray(state.conversations) && state.conversations.length === 1),
            { timeoutMs: 15000, label: '刷新后首屏读取完成' });
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
        ok(afterReload.lsConvs === null, '★ localStorage 里没有聊天记录（已不再作主存储）', String(afterReload.lsConvs));
        ok(afterReload.lsSettings === null, '★ localStorage 里没有设置');
        ok(afterReload.lsTheme === null, '★ localStorage 里没有主题');
        const lsKeys = Object.keys(afterReload.lsAll);
        // localStorage 里什么业务键都不该有，连迁移标记也不该有（删 data/ 就是真清空，靠备份兜底）
        ok(lsKeys.length === 0, '★ localStorage 里没有任何业务数据（也没有迁移标记）',
            JSON.stringify(lsKeys));

        await ctx.close();

        console.log('\n=== 删除 data/ 并重启 ===');
        await killServer(server);
        await wait(600);
        rmSync(DATA_DIR, { recursive: true, force: true });
        server = startServerImpl();
        ok(await waitServerUp(BASE), '服务重启成功');

        const ctx2 = await browser.newContext();   // 全新上下文：localStorage 天然是空的
        const page2 = await ctx2.newPage();
        await page2.goto(BASE, { waitUntil: 'domcontentloaded' });
        await waitFor(() => page2.evaluate(() => typeof window.Store !== 'undefined' && typeof state !== 'undefined'),
            { timeoutMs: 15000, label: '重启后首屏就绪' });
        const afterWipe = await page2.evaluate(() => ({
            convs: state.conversations.length,
            model: state.settings.model,
            theme: Store.getItem('elaina_theme'),
        }));
        console.log('删 data/ 后:', JSON.stringify(afterWipe));
        ok(afterWipe.convs === 0, '★★ 删掉 data/ 后聊天记录为空（用户报的问题已修）', String(afterWipe.convs));
        ok(afterWipe.model !== 'model-should-persist', '★★ 删掉 data/ 后设置回到默认', afterWipe.model);
        ok(afterWipe.theme !== 'dark', '★★ 删掉 data/ 后主题回到默认', String(afterWipe.theme));
        await wait(1200);
        const recreated = existsSync(path.join(DATA_DIR, 'main', 'store.json'))
            ? readFileSync(path.join(DATA_DIR, 'main', 'store.json'), 'utf8') : '';
        ok(!/model-should-persist/.test(recreated), '★ 旧设置没有被反向推回 data/（原 bug 的根因）');
        await ctx2.close();

        console.log('\n=== 服务运行中删除 data/（用户最可能的操作）===');
        {
            // 用户实际做法是服务开着直接删文件夹：缓存必须与 data/ 目录 mtime 绑定
            // （见 store.mjs 的 loadStore），否则内存缓存照旧返回旧数据、被写回磁盘（"删了还在"）。
            const ctx5 = await browser.newContext();
            const page5 = await ctx5.newPage();
            await page5.goto(BASE, { waitUntil: 'domcontentloaded' });
            await waitFor(() => page5.evaluate(() => typeof window.Store !== 'undefined'),
                { timeoutMs: 15000, label: '页面 Store 就绪' });

            await page5.evaluate(() => Store.setItem('elaina_open_settings',
                JSON.stringify({ model: 'SENTINEL-BEFORE-DELETE' })));
            await waitFor(async () => {
                const s = await (await fetch(BASE + '/api/store')).json();
                return /SENTINEL-BEFORE-DELETE/.test(JSON.stringify(s.data || {}));
            }, { timeoutMs: 8000, label: '写入落到服务端' });
            const s1 = await (await fetch(BASE + '/api/store')).json();
            ok(/SENTINEL-BEFORE-DELETE/.test(JSON.stringify(s1.data || {})),
                '（前置）写入的数据能被服务端读到');

            // 服务不重启，直接删掉整个 data/ 目录
            rmSync(DATA_DIR, { recursive: true, force: true });
            ok(!existsSync(path.join(DATA_DIR, 'main', 'store.json')), '（前置）data/ 已删除');

            const s2 = await (await fetch(BASE + '/api/store')).json();
            ok(!/SENTINEL-BEFORE-DELETE/.test(JSON.stringify(s2.data || {})),
                '★★ 服务不重启时删 data/，API 立刻读不到旧数据（缓存已失效）',
                JSON.stringify(s2.data || {}).slice(0, 120));

            await page5.reload({ waitUntil: 'domcontentloaded' });
            await waitFor(() => page5.evaluate(() => typeof state !== 'undefined'
                && state.settings && state.settings.model !== 'SENTINEL-BEFORE-DELETE'),
                { timeoutMs: 15000, label: '刷新后界面回到空' });
            const afterWipeLive = await page5.evaluate(() => ({
                model: state.settings.model,
                convs: state.conversations.length,
            }));
            ok(afterWipeLive.model !== 'SENTINEL-BEFORE-DELETE',
                '★★ 刷新后界面也是空的（不会读到残留）', afterWipeLive.model);
            ok(afterWipeLive.convs === 0, '★★ 聊天记录为空', String(afterWipeLive.convs));

            // data/ 目录会被重建（启动写内置数据），但不得有删除前的旧数据
            await wait(1200);
            if (existsSync(path.join(DATA_DIR, 'main', 'store.json'))) {
                const rebuilt = readFileSync(path.join(DATA_DIR, 'main', 'store.json'), 'utf8');
                ok(!/SENTINEL-BEFORE-DELETE/.test(rebuilt),
                    '★ 重建出来的文件里没有旧数据（目录会重建，但数据不会回来）');
            } else {
                ok(true, '★ 重建出来的文件里没有旧数据（目录未重建）');
            }
            await ctx5.close();
        }

        console.log('\n页面错误:', errs.length ? errs.slice(0, 3).join(' | ') : '(无)');

        // ④ 删了就该真的空：localStorage 里的旧数据不许被搬回 data/（老用户数据靠导入备份恢复）
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
            await waitFor(() => page3.evaluate(() => typeof window.Store !== 'undefined' && typeof state !== 'undefined'),
                { timeoutMs: 15000, label: '老数据场景首屏就绪' });
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
        if (browser) { try { await browser.close(); } catch { /* ignore */ } }
        await killServer(server);
        await wait(300);
        try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
        try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// 3. data/ 是唯一存储权威，且 Web / APK 共用同一套业务代码
// 防两类退化：业务数据写回 localStorage（权威只有 data/ 一处，静态扫描 web/js）；
// 业务代码长出平台分支（只允许在 store.js 存储层，CI 拦下 Capacitor / isNativePlatform）。

async function caseSingleSource(c) {
    const ok = (cond, label, extra) => c.ok(cond, label, extra);
    const JS_DIR = path.join(ROOT, 'web', 'js');

    const files = readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
    const src = {};
    for (const f of files) src[f] = readFileSync(path.join(JS_DIR, f), 'utf8');

    /** 去掉注释，避免把注释里的说明当成真实代码 */
    function stripComments(text) {
        return text
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    }

    /** 取顶层函数体（按大括号配对）：整文件 indexOf 会命中 init 之前定义的其它函数体内的同名调用（假失败） */
    function extractFunctionBody(text, name) {
        const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
        const m = re.exec(text);
        if (!m) return '';
        const start = text.indexOf('{', m.index);
        if (start < 0) return '';
        let depth = 0;
        for (let i = start; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') {
                depth--;
                if (depth === 0) return text.slice(start, i + 1);
            }
        }
        return '';
    }

    console.log('=== 1. localStorage 只允许出现在存储层 ===');
    {
        // 例外清单：每条都要有理由，不能随便加
        const ALLOWED = {
            // store.js 只把 localStorage 当 API 形态参考，实际用内存缓存 + 后端；放行是为注释与兼容
            'store.js': '存储层自身',
        };
        const offenders = [];
        for (const [f, text] of Object.entries(src)) {
            if (ALLOWED[f]) continue;
            const code = stripComments(text);
            const m = code.match(/localStorage\s*\.\s*(get|set|remove)Item/g);
            if (m) offenders.push(`${f}（${m.length} 处）`);
        }
        ok(offenders.length === 0,
            '★ 业务代码里没有 localStorage 读写（数据统一走 Store → data/）',
            offenders.join(', '));

        ok(!!src['store.js'], 'store.js 存在');
        ok(/window\.Store\s*=/.test(src['store.js'] || ''), '★ store.js 暴露 window.Store');
        for (const fn of ['bootstrap', 'getItem', 'setItem', 'removeItem']) {
            ok(new RegExp(`\\b${fn}\\b`).test(src['store.js'] || ''), `Store 提供 ${fn}()`);
        }
    }

    console.log('\n=== 2. 平台差异只在存储层（Web/APK 共用一套业务代码）===');
    {
        const PLATFORM_RE = /isNativePlatform|Capacitor\.Plugins|Capacitor\.getPlatform/;
        // 例外清单是功能差异而非数据分叉：数据存储两端必须共用（只放行 store.js）；
        // 原生插件是 APK 独有能力，天然分支且不产生两套业务逻辑。
        const ALLOWED_PLATFORM = {
            'store.js': '数据后端分支（唯一允许的存储差异）',
            'core.js': 'BYOK 原生 HTTP 插件（APK 用原生绕 CORS，Web 走本机中转）',
            'data.js': 'API Key 的原生 Keystore（APK 有安全存储，Web 没有）',
            'voice.js': 'TTS 原生插件（APK 用系统 TTS，Web 用 HTTP 接口）',
            'agent.js': '手机操作（APK 独有功能，Web 没有这个概念）',
            'settings.js': '备份文件的导入导出（APK 用 Filesystem 选/读文件）',
        };
        const branched = [];
        for (const [f, text] of Object.entries(src)) {
            if (ALLOWED_PLATFORM[f]) continue;
            const code = stripComments(text);
            if (PLATFORM_RE.test(code)) branched.push(f);
        }
        ok(branched.length === 0,
            '★ 业务文件里没有新增平台分支（避免 Web/APK 分裂成两套代码）',
            branched.join(', '));

        // 用户数据的写盘分支必须只有 store.js；core.js 等写的是可重新获取的资源（Live2D 模型），
        // 判据是"丢了会不会心疼"：会心疼的（聊天/设置/记忆）必须只有 data/ 一处。
        const NON_DATA_WRITERS = {
            'core.js': 'Live2D 模型文件（可重新获取的资源，不是用户数据）',
            'core-native.js': '原生 Live2D 模型文件（从 core.js 拆出的同一类资源）',
            'core-native-mod.js': '原生插件安装/删除（mods 目录，不是用户数据）',
            // Directory.Documents：读写用户自己选的备份文件，是"跟用户交换文件"而非应用自身存储
            'settings.js': '备份文件的导入导出（读写用户在文档目录里选的文件）',
            'backup.js': '备份文件的导入导出（从 settings.js 拆出的同一类文件交换）',
            // CACHE 目录的日志导出（log-viewer「导出」按钮）：与 settings.js 同性质，缓存可回收
            'log-viewer.js': '日志导出文件（写缓存目录供分享，用户主动触发）',
        };
        const dataBranch = Object.entries(src)
            .filter(([f, t]) => {
                if (f === 'store.js' || NON_DATA_WRITERS[f]) return false;
                const code = stripComments(t);
                return /Directory\.(Data|Documents|External)\b/.test(code)
                    || /writeFile\(\{[^}]*directory\s*:/.test(code);
            })
            .map(([f]) => f);
        ok(dataBranch.length === 0,
            '★ 没有业务文件自己往磁盘写用户数据（统一由 store.js 落 data/）', dataBranch.join(', '));
    }

    console.log('\n=== 3. 旧的双向同步不得复活 ===');
    {
        const ds = src['data-sync.js'] || '';
        const code = stripComments(ds);
        ok(!/XMLHttpRequest/.test(code), '★ data-sync.js 里没有同步 XHR（旧的拉取逻辑已移除）');
        ok(!/localStorage\s*\.\s*setItem/.test(code), '★ data-sync.js 不再写 localStorage');
        ok(!/api\/store/.test(code), '★ data-sync.js 不再直接打 /api/store（改由 store.js 负责）');
        ok(/store\.js|Store/.test(ds), 'data-sync.js 保留说明指向 store.js');
    }

    console.log('\n=== 4. 键清单一致（避免"某类数据没被保存"）===');
    {
        // store.js 的 DATA_KEYS 是前端权威清单
        const m = (src['store.js'] || '').match(/var DATA_KEYS = \[([\s\S]*?)\];/);
        ok(!!m, '能取到 store.js 的 DATA_KEYS');
        if (m) {
            const keys = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
            ok(keys.length >= 10, `DATA_KEYS 有 ${keys.length} 个键`);
            for (const must of [
                'elaina_open_settings',
                'elainachat_open_api_secrets',   // 用户选择把 Key 也存进 data/
                'elaina_open_conversations',
                'elaina_open_character_cards',
                'elaina_open_memory_core',
                'elaina_theme_template',
                'elaina_theme',
            ]) {
                ok(keys.includes(must), `★ 关键键在清单里：${must}`);
            }
        }
        // 服务端拆文件的三个键必须在清单里，否则拆分会失效
        const storeSrv = readFileSync(path.join(ROOT, 'server', 'store.mjs'), 'utf8');
        for (const k of ['elaina_open_conversations', 'elaina_open_character_cards', 'elaina_open_memory_core']) {
            ok(storeSrv.includes(k), `服务端仍认识 ${k}`);
        }
    }

    console.log('\n=== 5. 启动顺序：先 bootstrap 再读 ===');
    {
        const init = src['init.js'] || '';
        const code = stripComments(init);

        // 只在 init() 函数体内找：其它函数（定义在 init 之前）体内也调 load*，
        // 整文件 indexOf 会命中那些位置，得出"load 早于 bootstrap"的假失败。
        const body = extractFunctionBody(code, 'init');
        ok(body, '能取到 init() 函数体');

        const bootAt = body.indexOf('Store.bootstrap()');
        ok(bootAt >= 0, '★ init() 里调用了 Store.bootstrap()');

        const loadCalls = ['loadSettings()', 'loadConversations()', 'loadMemoryCore()']
            .map((c) => ({ c, at: body.indexOf(c) }))
            .filter((x) => x.at >= 0);
        ok(loadCalls.length >= 2, 'init() 里有读取数据的调用');
        const tooEarly = loadCalls.filter((x) => x.at < bootAt).map((x) => x.c);
        ok(tooEarly.length === 0, '★ init() 内所有 load* 都在 bootstrap 之后（不会读到空缓存）',
            tooEarly.join(', '));
        // APK 是异步读，读完要重刷主题
        ok(/ElainaTheme.*applyStored|applyStored\(\)/.test(body),
            '★ bootstrap 后重刷主题（APK 异步读完后不会停在默认主题）');
    }

    console.log('\n=== 6. index.html 引入顺序 ===');
    {
        const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
        ok(/<script[^>]*src="\/js\/store\.js"[^>]*><\/script>/.test(html), 'index.html 引入了 store.js');
        const storeAt = html.indexOf('/js/store.js');
        for (const f of ['/js/core.js', '/js/data.js', '/js/theme.js', '/js/mods.js']) {
            const at = html.indexOf(f);
            ok(at < 0 || at > storeAt, `store.js 排在 ${f} 之前`);
        }
        // data-sync.js 仍被引用（空壳也要在，否则老 APK 的旧文件不会被覆盖）
        ok(/<script[^>]*src="\/js\/data-sync\.js"[^>]*><\/script>/.test(html),
            'data-sync.js 仍被引入（空壳覆盖老 APK 里的同名逻辑）');
    }

    console.log('\n=== 7. APK 原生后端（用假 Capacitor 验证）===');
    {
        // 假 Capacitor Filesystem：用内存 Map 当"应用私有目录里的 store.json"
        const disk = new Map();
        const FILE = 'store.json';
        const fakeFs = {
            Directory: { Data: 'DATA' },
            readFile: async ({ path: p }) => {
                if (!disk.has(p)) throw new Error('File does not exist');
                return { data: disk.get(p) };
            },
            writeFile: async ({ path: p, data }) => { disk.set(p, data); },
        };
        const sandbox = {
            console: { log() {}, warn() {}, error() {} },
            Object, Array, JSON, String, Boolean, Error, Promise, Date, RegExp,
            setTimeout, clearTimeout,
            XMLHttpRequest: function () { /* APK 不该用到它 */ throw new Error('APK 不应走 Web 后端'); },
            fetch: async () => { throw new Error('APK 不应走 fetch'); },
            navigator: {},
            Blob: class {},
        };
        sandbox.window = sandbox;
        sandbox.window.Capacitor = {
            isNativePlatform: () => true,
            Plugins: { Filesystem: fakeFs },
        };
        sandbox.globalThis = sandbox;
        const ctx = vm.createContext(sandbox);
        vm.runInContext(src['store.js'], ctx, { filename: 'store.js' });
        const S = sandbox.window.Store;

        ok(S.isDataKey('elaina_open_conversations'), 'APK：Store 认识业务键');
        ok(!S.isDataKey('some.ui.state'), 'APK：非业务键不入库');

        await S.bootstrap();
        ok(S.getItem('elaina_open_settings') === null, 'APK：空盘启动时读不到设置（符合预期）');

        S.setItem('elaina_open_settings', JSON.stringify({ model: 'apk-model' }));
        S._flush();
        await new Promise((r) => setTimeout(r, 50));
        ok(disk.has(FILE), '★ APK：写入后落到了应用私有目录的 store.json');
        const onDisk = JSON.parse(disk.get(FILE) || '{}');
        ok(/apk-model/.test(onDisk['elaina_open_settings'] || ''),
            '★ APK：内容正确写进文件', JSON.stringify(Object.keys(onDisk)));

        // ③ 重开应用（新沙箱、同一份磁盘）→ 数据还在
        {
            const sandbox2 = {
                console: { log() {}, warn() {}, error() {} },
                Object, Array, JSON, String, Boolean, Error, Promise, Date, RegExp,
                setTimeout, clearTimeout,
                XMLHttpRequest: function () { throw new Error('APK 不应走 Web 后端'); },
                fetch: async () => { throw new Error('APK 不应走 fetch'); },
                navigator: {}, Blob: class {},
            };
            sandbox2.window = sandbox2;
            sandbox2.window.Capacitor = { isNativePlatform: () => true, Plugins: { Filesystem: fakeFs } };
            sandbox2.globalThis = sandbox2;
            const ctx2 = vm.createContext(sandbox2);
            vm.runInContext(src['store.js'], ctx2, { filename: 'store.js' });
            await sandbox2.window.Store.bootstrap();
            ok(/apk-model/.test(sandbox2.window.Store.getItem('elaina_open_settings') || ''),
                '★★ APK：重启应用后数据还在（与 Web 同一套 Store 语义）');
        }

        // ④ 业务代码完全不感知平台 —— store.js 是唯一判断点
        ok(/isNativePlatform/.test(src['store.js']), 'store.js 内部做平台判断（唯一判断点）');
        const businessFiles = Object.entries(src)
            .filter(([f]) => !['store.js', 'core.js', 'data.js', 'voice.js', 'agent.js', 'settings.js'].includes(f))
            .filter(([, t]) => /isNativePlatform/.test(stripComments(t)))
            .map(([f]) => f);
        ok(businessFiles.length === 0,
            '★★ 其它业务文件里没有平台判断（改一处两端都生效）', businessFiles.join(', '));
    }
}

// 4. data/ 分类存储（人设卡与聊天记录都是一条一文件）+ zip 备份
// 临时目录跑真实读写：分类落盘 / 读回拼装 / 旧单文件迁移（幂等）/ zip 往返 / 坏数据不崩。

async function caseStoreLayout(c) {
    const ok = (cond, label, detail) => c.ok(cond, label, detail);

    const KEY_CARDS = 'elaina_open_character_cards';
    const KEY_CURRENT = 'elaina_open_current_card';
    const KEY_CONV = 'elaina_open_conversations';
    const KEY_MEM = 'elaina_open_memory_core';
    const KEY_SETTINGS = 'elaina_open_settings';

    const tmp = await mkdtemp(path.join(tmpdir(), 'elaina-store-'));
    let tmp2 = null;
    const logs = [];
    const mk = () => createStore({ dataDir: tmp, log: (lvl, msg) => logs.push(lvl + ':' + msg) });

    try {
        console.log('=== 1. 全新写入（一条一文件）===');
        {
            const store = mk();
            const s = await store.loadStore();
            ok(Object.keys(s).length === 0, '空目录 → 空 store');

            const cards = [
                { id: 'card_a', name: '伊蕾娜', title: '灰之魔女' },
                { id: 'card_b', name: '深海', title: '鲛人' },
            ];
            const convs = [
                { id: 'conv_1', title: '第一个对话', messages: [{ role: 'user', text: '你好' }] },
                { id: 'conv_2', title: '第二个对话', messages: [] },
            ];
            s[KEY_CARDS] = JSON.stringify(cards);
            s[KEY_CURRENT] = 'card_a';
            s[KEY_CONV] = JSON.stringify(convs);
            s[KEY_MEM] = JSON.stringify({ diary: [{ date: '2026-09-22', content: '测试' }] });
            s[KEY_SETTINGS] = JSON.stringify({ model: 'x' });
            await store.saveStore();

            ok(existsSync(path.join(tmp, 'main', 'characters', 'card_a.json')), '人设卡一卡一文件（card_a）');
            ok(existsSync(path.join(tmp, 'main', 'characters', 'card_b.json')), '人设卡一卡一文件（card_b）');
            ok(existsSync(path.join(tmp, 'main', 'characters', 'index.json')), '生成 characters/index.json');
            ok(existsSync(path.join(tmp, 'conversations', 'conv_1.json')), '聊天记录一对话一文件（conv_1）');
            ok(existsSync(path.join(tmp, 'conversations', 'conv_2.json')), '聊天记录一对话一文件（conv_2）');
            ok(existsSync(path.join(tmp, 'conversations', 'index.json')), '生成 conversations/index.json');
            ok(existsSync(path.join(tmp, 'main', 'memory', 'diary.json')), '记忆按类目拆成 memory/diary.json');
            ok(!existsSync(path.join(tmp, 'memory.json')), '不再有旧的单文件 memory.json');
            ok(!existsSync(path.join(tmp, 'conversations.json')), '不再有旧的单文件 conversations.json');

            const misc = JSON.parse(await readFile(path.join(tmp, 'main', 'store.json'), 'utf8'));
            ok(misc[KEY_SETTINGS] !== undefined, 'store.json 保留设置键');
            ok(misc[KEY_CARDS] === undefined, 'store.json 不再含人设卡');
            ok(misc[KEY_CONV] === undefined, 'store.json 不再含聊天记录');
            ok(misc[KEY_MEM] === undefined, 'store.json 不再含记忆');

            const cidx = JSON.parse(await readFile(path.join(tmp, 'main', 'characters', 'index.json'), 'utf8'));
            ok(cidx.currentCardId === 'card_a', 'index 记录当前选中卡片');
            ok(cidx.order.join(',') === 'card_a,card_b', 'index 记录卡片顺序');
            const vidx = JSON.parse(await readFile(path.join(tmp, 'conversations', 'index.json'), 'utf8'));
            ok(vidx.order.join(',') === 'conv_1,conv_2', 'index 记录对话顺序');
        }

        console.log('\n=== 2. 读回（拼成前端认识的形态）===');
        {
            const store = mk();
            const s = await store.loadStore();
            const cards = JSON.parse(s[KEY_CARDS] || '[]');
            ok(cards.length === 2, '人设卡拼回数组（2 张）', 'got ' + cards.length);
            ok(cards[0].id === 'card_a' && cards[0].name === '伊蕾娜', '卡片内容完整');
            ok(s[KEY_CURRENT] === 'card_a', '当前卡片 id 读回');
            const convs = JSON.parse(s[KEY_CONV] || '[]');
            ok(convs.length === 2, '聊天记录拼回数组（2 个）', 'got ' + convs.length);
            ok(convs[0].messages[0].text === '你好', '对话消息完整');
            ok(JSON.parse(s[KEY_MEM] || '{}').diary.length === 1, '记忆读回');
            ok(JSON.parse(s[KEY_SETTINGS] || '{}').model === 'x', '设置读回');
        }

        console.log('\n=== 3. 删除条目（残留文件要清掉）===');
        {
            const store = mk();
            const s = await store.loadStore();
            s[KEY_CARDS] = JSON.stringify([{ id: 'card_a', name: '伊蕾娜' }]);
            s[KEY_CONV] = JSON.stringify([{ id: 'conv_2', title: '留着的' }]);
            await store.saveStore();
            const cFiles = (await readdir(path.join(tmp, 'main', 'characters'))).filter((f) => f.endsWith('.json'));
            const vFiles = (await readdir(path.join(tmp, 'conversations'))).filter((f) => f.endsWith('.json'));
            ok(!cFiles.includes('card_b.json'), '删掉的卡片文件被清理');
            ok(cFiles.includes('card_a.json'), '保留的卡片文件还在');
            ok(!vFiles.includes('conv_1.json'), '删掉的对话文件被清理');
            ok(vFiles.includes('conv_2.json'), '保留的对话文件还在');
        }

        console.log('\n=== 4. 坏数据不崩、不覆盖 ===');
        {
            const store = mk();
            const s = await store.loadStore();
            s[KEY_CARDS] = '这不是 JSON';
            const before = await readFile(path.join(tmp, 'main', 'characters', 'card_a.json'), 'utf8');
            await store.saveStore();
            const after = await readFile(path.join(tmp, 'main', 'characters', 'card_a.json'), 'utf8');
            ok(before === after, '非法 JSON 不破坏已有人设卡文件');

            const store2 = mk();
            const s2 = await store2.loadStore();
            s2[KEY_CARDS] = JSON.stringify([{ id: '../../evil', name: 'x' }]);
            await store2.saveStore();
            ok(!existsSync(path.join(tmp, '..', 'evil.json')), '非法 id 不会写到目录外');
        }

        console.log('\n=== 5. 从旧的单文件布局迁移 ===');
        tmp2 = await mkdtemp(path.join(tmpdir(), 'elaina-migrate-'));
        {
            const legacyCards = [{ id: 'old_1', name: '旧卡一' }, { id: 'old_2', name: '旧卡二' }];
            await writeFile(path.join(tmp2, 'store.json'), JSON.stringify({
                [KEY_CARDS]: JSON.stringify(legacyCards),
                [KEY_CURRENT]: 'old_2',
                [KEY_MEM]: JSON.stringify({ diary: [] }),
                [KEY_SETTINGS]: JSON.stringify({ model: 'legacy' }),
            }), 'utf8');
            await writeFile(path.join(tmp2, 'conversations.json'), JSON.stringify({
                version: 1,
                value: JSON.stringify([{ id: 'oldconv', title: '旧对话', messages: [] }]),
            }), 'utf8');

            const store = createStore({ dataDir: tmp2, log: (lvl, msg) => logs.push(lvl + ':' + msg) });
            const moved = await store.migrateIfNeeded();
            ok(moved.length > 0, '检测到旧数据并迁移', 'moved=' + JSON.stringify(moved));
            ok(existsSync(path.join(tmp2, 'main', 'characters', 'old_1.json')), '旧卡迁移成独立文件');
            ok(existsSync(path.join(tmp2, 'conversations', 'oldconv.json')), '旧单文件聊天记录拆成一对话一文件');
            ok(!existsSync(path.join(tmp2, 'conversations.json')), '旧的单文件 conversations.json 已删除');
            ok(existsSync(path.join(tmp2, 'main', 'memory', 'diary.json')), '旧记忆迁移成 memory/<类目>.json');

            const misc = JSON.parse(await readFile(path.join(tmp2, 'main', 'store.json'), 'utf8'));
            ok(misc[KEY_SETTINGS] !== undefined, '迁移后 store.json 保留设置');
            ok(misc[KEY_CARDS] === undefined, '迁移后 store.json 不再含人设卡');

            const store2 = createStore({ dataDir: tmp2 });
            const s = await store2.loadStore();
            ok(JSON.parse(s[KEY_CARDS] || '[]').length === 2, '迁移后卡片数量正确');
            ok(s[KEY_CURRENT] === 'old_2', '迁移后当前卡片 id 正确');
            ok(JSON.parse(s[KEY_CONV] || '[]')[0].id === 'oldconv', '迁移后聊天记录正确');
        }

        console.log('\n=== 6. 迁移幂等 ===');
        {
            const store = createStore({ dataDir: tmp2 });
            const moved2 = await store.migrateIfNeeded();
            ok(moved2.length === 0, '第二次启动不再迁移', 'moved=' + JSON.stringify(moved2));

            const s = await store.loadStore();
            const cards = JSON.parse(s[KEY_CARDS]);
            cards[0].name = '改过的名字';
            s[KEY_CARDS] = JSON.stringify(cards);
            await store.saveStore();

            const store3 = createStore({ dataDir: tmp2 });
            await store3.migrateIfNeeded();
            const s3 = await store3.loadStore();
            ok(JSON.parse(s3[KEY_CARDS])[0].name === '改过的名字', '迁移不会覆盖已更新的数据');
        }

        // 6b 防的退化：已拆进 conversations/ 后，旧单文件因"moved 为空跳过删除"永久残留磁盘
        console.log('\n=== 6b. 清理遗留的旧单文件 conversations.json ===');
        {
            const tmpLegacy = await mkdtemp(path.join(tmpdir(), 'elaina-legacy-'));
            try {
                await writeFile(path.join(tmpLegacy, 'store.json'), JSON.stringify({
                    [KEY_SETTINGS]: JSON.stringify({ model: 'x' }),
                }), 'utf8');
                const seed = createStore({ dataDir: tmpLegacy });
                const s = await seed.loadStore();
                s[KEY_CONV] = JSON.stringify([{ id: 'kept_conv', title: '已在目录里的对话', messages: [] }]);
                await seed.saveStore();
                ok(existsSync(path.join(tmpLegacy, 'conversations', 'kept_conv.json')), '（准备）对话已拆进目录');
                // 再手工放一个遗留的旧单文件（内容与目录里不同，模拟"上次没删掉"）
                await writeFile(path.join(tmpLegacy, 'conversations.json'), JSON.stringify({
                    version: 1,
                    value: JSON.stringify([{ id: 'stale_conv', title: '遗留的旧数据' }]),
                }), 'utf8');
                ok(existsSync(path.join(tmpLegacy, 'conversations.json')), '（准备）旧单文件存在');

                const store = createStore({ dataDir: tmpLegacy });
                const moved = await store.migrateIfNeeded();
                ok(moved.length === 0, '已拆好的状态不触发迁移（moved 为空）', JSON.stringify(moved));
                ok(!existsSync(path.join(tmpLegacy, 'conversations.json')), '遗留的旧单文件被清理掉');

                const s2 = await store.loadStore();
                const convs = JSON.parse(s2[KEY_CONV] || '[]');
                ok(convs.length === 1 && convs[0].id === 'kept_conv', '目录里的对话没被旧文件覆盖', JSON.stringify(convs.map((x) => x.id)));
            } finally {
                await rm(tmpLegacy, { recursive: true, force: true }).catch(() => {});
            }

            // 反向：目录为空时绝不能删旧文件（那是唯一的数据来源）
            const tmpOnlyLegacy = await mkdtemp(path.join(tmpdir(), 'elaina-only-'));
            try {
                await writeFile(path.join(tmpOnlyLegacy, 'conversations.json'), JSON.stringify({
                    version: 1,
                    value: JSON.stringify([{ id: 'only_source', messages: [] }]),
                }), 'utf8');
                const store2 = createStore({ dataDir: tmpOnlyLegacy });
                await store2.migrateIfNeeded();
                ok(existsSync(path.join(tmpOnlyLegacy, 'conversations', 'only_source.json')), '唯一数据来源被正确迁移');
                const s3 = await store2.loadStore();
                ok(JSON.parse(s3[KEY_CONV] || '[]').length === 1, '迁移后能读到');
            } finally {
                await rm(tmpOnlyLegacy, { recursive: true, force: true }).catch(() => {});
            }
        }

        // 6c 内容没变的文件不重写：消息保存会重放整份聊天记录，防止写盘量退化为 O(会话数)。
        console.log('\n=== 6c. 内容没变的文件不重写 ===');
        {
            const tmpIdem = await mkdtemp(path.join(tmpdir(), 'elaina-idem-'));
            try {
                const store = createStore({ dataDir: tmpIdem });
                const s = await store.loadStore();
                s[KEY_CONV] = JSON.stringify([
                    { id: 'idem_a', title: '甲', messages: [{ role: 'user', text: '1' }] },
                    { id: 'idem_b', title: '乙', messages: [] },
                ]);
                await store.saveStore();
                const fa = path.join(tmpIdem, 'conversations', 'idem_a.json');
                const fb = path.join(tmpIdem, 'conversations', 'idem_b.json');
                const beforeA = (await stat(fa)).mtimeMs;
                const beforeB = (await stat(fb)).mtimeMs;

                await new Promise((r) => setTimeout(r, 30));   // 拉开 mtime 粒度
                const convs = JSON.parse(s[KEY_CONV]);
                convs[0].messages.push({ role: 'assistant', text: '2' });
                s[KEY_CONV] = JSON.stringify(convs);
                await store.saveStore();

                ok((await stat(fa)).mtimeMs > beforeA, '内容变了的会话文件被重写');
                ok((await stat(fb)).mtimeMs === beforeB, '★ 内容没变的会话文件不重写');
                const readBack = JSON.parse(await readFile(fa, 'utf8'));
                ok(readBack.messages.length === 2, '重写后的内容完整');
            } finally {
                await rm(tmpIdem, { recursive: true, force: true }).catch(() => {});
            }
        }

        // 6d 写盘失败必须上抛：内部吞错可保后续保存，但调用方必须据此回 500，否则静默丢消息
        console.log('\n=== 6d. 写盘失败抛给调用方 ===');
        {
            const tmpFail = await mkdtemp(path.join(tmpdir(), 'elaina-fail-'));
            try {
                const store = createStore({ dataDir: tmpFail, log: () => {} });
                const s = await store.loadStore();
                s[KEY_SETTINGS] = JSON.stringify({ model: 'x' });
                await store.saveStore();
                // 把 main/ 换成同名文件：之后 mkdir/写入必然失败
                await rm(path.join(tmpFail, 'main'), { recursive: true, force: true });
                await writeFile(path.join(tmpFail, 'main'), 'not a dir', 'utf8');
                s[KEY_SETTINGS] = JSON.stringify({ model: 'y' });
                let threw = false;
                try { await store.saveStore(); } catch { threw = true; }
                ok(threw, '★ 写盘失败时 saveStore 抛出（调用方据此回 500）');

                await rm(path.join(tmpFail, 'main'), { force: true });
                await mkdir(path.join(tmpFail, 'main'), { recursive: true });
                await store.saveStore();
                const misc = JSON.parse(await readFile(path.join(tmpFail, 'main', 'store.json'), 'utf8'));
                ok(misc[KEY_SETTINGS] === JSON.stringify({ model: 'y' }), '失败后的下一次保存仍正常');
            } finally {
                await rm(tmpFail, { recursive: true, force: true }).catch(() => {});
            }
        }

        console.log('\n=== 7. zip 备份导出 ===');
        let zipBuf = null;
        {
            const store = createStore({ dataDir: tmp2 });
            zipBuf = await store.exportZip();
            ok(Buffer.isBuffer(zipBuf) && zipBuf.length > 0, '导出了 zip');
            ok(zipBuf.readUInt32LE(0) === 0x04034b50, '是合法 zip（PK 头）');

            const files = readZip(zipBuf);
            const names = files.map((f) => f.name);
            ok(names.includes('manifest.json'), 'zip 里有 manifest.json');
            ok(names.includes('data/settings.json'), 'zip 里有 data/settings.json');
            ok(names.includes('data/characters/index.json'), 'zip 里有 data/characters/index.json');
            ok(names.some((n) => /^data\/characters\/old_\d\.json$/.test(n)), 'zip 里有一卡一文件');
            ok(names.includes('data/conversations/index.json'), 'zip 里有 data/conversations/index.json');
            ok(names.some((n) => n === 'data/conversations/oldconv.json'), 'zip 里有一对话一文件');
            ok(names.some((n) => /^data\/memory\/[A-Za-z0-9_-]+\.json$/.test(n)), 'zip 里有 data/memory/<类目>.json');

            const manifest = JSON.parse(files.find((f) => f.name === 'manifest.json').data.toString('utf8'));
            ok(manifest.format === 'elainachat-backup', 'manifest 格式标识正确');
            ok(manifest.version === 3, 'manifest 版本为 3（zip + data/）', 'got ' + manifest.version);
            ok(typeof manifest.exportedAt === 'string', 'manifest 含导出时间');
            ok(manifest.counts.characters === 2, 'manifest 统计人设卡数', JSON.stringify(manifest.counts));

            // 第 6 步已把 old_1 改名，断言的是改后值 —— 顺带证明导出读的是当前数据而非旧快照
            const cardFile = files.find((f) => f.name === 'data/characters/old_1.json');
            const card = JSON.parse(cardFile.data.toString('utf8'));
            ok(card.name === '改过的名字', 'zip 里单卡内容是最新的', 'got ' + card.name);
        }

        console.log('\n=== 8. zip 导入往返 ===');
        {
            const tmp3 = await mkdtemp(path.join(tmpdir(), 'elaina-import-'));
            try {
                const store = createStore({ dataDir: tmp3 });
                const res = await store.importBackup(zipBuf, 'merge');
                ok(res.ok, 'zip 导入成功', JSON.stringify(res));
                ok(res.source === 'zip', '识别为 zip 来源');
                ok(res.keys > 0, '导入统计了键数', 'keys=' + res.keys);

                const s = await store.loadStore();
                ok(JSON.parse(s[KEY_CARDS] || '[]').length === 2, '导入后人设卡完整');
                ok(s[KEY_CURRENT] === 'old_2', '导入后当前卡片正确');
                ok(JSON.parse(s[KEY_CONV] || '[]')[0].id === 'oldconv', '导入后聊天记录完整');
                ok(existsSync(path.join(tmp3, 'main', 'characters', 'old_1.json')), '导入后落成一卡一文件');
                ok(existsSync(path.join(tmp3, 'conversations', 'oldconv.json')), '导入后落成一对话一文件');

                const store2 = createStore({ dataDir: tmp3 });
                const s2 = await store2.loadStore();
                s2['custom_key'] = JSON.stringify({ mine: true });
                await store2.saveStore();
                await store2.importBackup(zipBuf, 'merge');
                const s3 = await store2.loadStore();
                ok(s3['custom_key'] !== undefined, 'merge 模式保留本机独有键');
            } finally {
                await rm(tmp3, { recursive: true, force: true }).catch(() => {});
            }
        }

        // 8.5 replace 必须连磁盘上的旧文件一起清，否则下次 loadStore 又拼回来（替换等于没清）
        console.log('\n=== 8.5 replace 导入清空旧数据 ===');
        {
            const tmp6 = await mkdtemp(path.join(tmpdir(), 'elaina-replace-'));
            try {
                const store = createStore({ dataDir: tmp6 });
                const s = await store.loadStore();
                s[KEY_CARDS] = JSON.stringify([{ id: 'old_card', name: '旧卡' }]);
                s[KEY_CONV] = JSON.stringify([{ id: 'old_conv', title: '旧对话', messages: [] }]);
                s[KEY_MEM] = JSON.stringify({ diary: [{ content: '旧日记' }] });
                s[KEY_SETTINGS] = JSON.stringify({
                    model: 'old',
                    mimoTtsCloneSample: 'data:audio/wav;base64,' + Buffer.from('abc').toString('base64'),
                });
                await store.saveStore();

                const backup = Buffer.from(JSON.stringify({
                    data: { [KEY_SETTINGS]: JSON.stringify({ model: 'new' }) },
                }), 'utf8');
                const res = await store.importBackup(backup, 'replace');
                ok(res.ok, 'replace 导入成功', JSON.stringify(res));

                const after = await createStore({ dataDir: tmp6 }).loadStore();
                ok(after[KEY_CONV] === undefined, '★ replace 清空备份里没有的聊天记录');
                ok(after[KEY_MEM] === undefined, '★ replace 清空备份里没有的记忆');
                ok(after[KEY_CARDS] === undefined, '★ replace 清空备份里没有的人设卡');
                ok(JSON.parse(after[KEY_SETTINGS] || '{}').model === 'new', 'replace 用备份里的设置');

                const cidx = JSON.parse(await readFile(path.join(tmp6, 'main', 'characters', 'index.json'), 'utf8'));
                const vidx = JSON.parse(await readFile(path.join(tmp6, 'conversations', 'index.json'), 'utf8'));
                ok(cidx.order.length === 0 && vidx.order.length === 0, 'replace 后分类 index 为空');
                const memDir = path.join(tmp6, 'main', 'memory');
                const memFiles = existsSync(memDir) ? (await readdir(memDir)).filter((n) => n.endsWith('.json')) : [];
                ok(memFiles.length === 0, 'replace 后记忆目录没有残留文件', memFiles.join(','));
                const vsDir = path.join(tmp6, 'main', 'voice-samples');
                const vsFiles = existsSync(vsDir) ? await readdir(vsDir) : [];
                ok(vsFiles.length === 0, 'replace 后无主的参考音频被清理', vsFiles.join(','));
            } finally {
                await rm(tmp6, { recursive: true, force: true }).catch(() => {});
            }
        }

        console.log('\n=== 9. 兼容 v1 单 JSON 旧备份 ===');
        {
            const tmp4 = await mkdtemp(path.join(tmpdir(), 'elaina-v1-'));
            try {
                const store = createStore({ dataDir: tmp4 });
                const v1 = Buffer.from(JSON.stringify({
                    format: 'elainachat-backup',
                    version: 1,
                    data: {
                        [KEY_CARDS]: JSON.stringify([{ id: 'v1_card', name: '旧备份的卡' }]),
                        [KEY_SETTINGS]: JSON.stringify({ model: 'v1' }),
                    },
                }), 'utf8');
                const res = await store.importBackup(v1, 'merge');
                ok(res.ok, 'v1 JSON 备份能导入', JSON.stringify(res));
                ok(res.source === 'json', '识别为 json 来源');
                const s = await store.loadStore();
                ok(JSON.parse(s[KEY_CARDS] || '[]')[0].id === 'v1_card', 'v1 备份的人设卡导入成功');
                ok(JSON.parse(s[KEY_SETTINGS]).model === 'v1', 'v1 备份的设置导入成功');
            } finally {
                await rm(tmp4, { recursive: true, force: true }).catch(() => {});
            }
        }

        console.log('\n=== 10. 导入边界 ===');
        {
            const tmp5 = await mkdtemp(path.join(tmpdir(), 'elaina-edge-'));
            try {
                const store = createStore({ dataDir: tmp5 });
                let threw = false;
                try { await store.importBackup(Buffer.from('这不是 zip 也不是 json', 'utf8')); } catch { threw = true; }
                ok(threw, '非法内容被拒绝');

                const r1 = await store.importBackup(Buffer.from(JSON.stringify({ data: {} }), 'utf8'));
                ok(!r1.ok, '空数据被拒绝');
                const r2 = await store.importBackup(Buffer.from(JSON.stringify({ data: { k: 123 } }), 'utf8'));
                ok(!r2.ok, '非字符串值被拒绝（与 localStorage 语义一致）');
            } finally {
                await rm(tmp5, { recursive: true, force: true }).catch(() => {});
            }
        }
    } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
        if (tmp2) await rm(tmp2, { recursive: true, force: true }).catch(() => {});
    }
}

// 5. 多设备实时同步
// 两个独立浏览器上下文（模拟两台设备）连同一个服务：A 改动 → B 几秒内自动看到（不刷新）。

async function caseMultiDeviceSync(c) {
    const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-sync-'));
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-syncd-'));
    const PORT = await freePort();
    const BASE = `http://127.0.0.1:${PORT}`;

    let child = null;
    let browser = null;
    try {
        child = startServer({ port: PORT, dataDir: DATA_DIR, logDir: LOG_DIR });
        browser = await launchTestBrowser();

        const up = await waitServerUp(BASE);
        if (!up) throw new Error('服务没起来：\n' + child.out.slice(-800));

        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const errsA = [], errsB = [];
        pageA.on('pageerror', (e) => errsA.push(e.message));
        pageB.on('pageerror', (e) => errsB.push(e.message));

        await pageA.goto(BASE, { waitUntil: 'domcontentloaded' });
        // 等"Store 真的可用"这个事实，而不是猜一个固定毫秒数（猜短了随机假红，猜长了白等）
        const readyA = await waitFor(() => pageA.evaluate(() => typeof window.Store !== 'undefined'
            && typeof window.Store?.subscribeRemote === 'function'), { timeoutMs: 15000 });
        await pageB.goto(BASE, { waitUntil: 'domcontentloaded' });
        const readyB = await waitFor(() => pageB.evaluate(() => typeof window.Store !== 'undefined'), { timeoutMs: 15000 });

        const subA = await pageA.evaluate(() => ({
            hasStore: typeof window.Store !== 'undefined',
            hasSubscribe: typeof window.Store?.subscribeRemote === 'function',
            clientId: window.Store?.clientId?.(),
        }));
        const subB = await pageB.evaluate(() => ({
            clientId: window.Store?.clientId?.(),
        }));
        console.log('A clientId:', subA.clientId, ' B clientId:', subB.clientId);
        c.ok(readyA && readyB, '两个页面都完成了 Store 初始化（等到事实，不是等固定时长）');
        c.ok(subA.hasSubscribe, 'Store.subscribeRemote 存在');
        c.ok(subA.clientId && subB.clientId && subA.clientId !== subB.clientId,
            '两个设备有各自的 clientId（服务端据此跳过发起方）');

        console.log('\n=== A 改主题，B 是否自动同步 ===');
        await pageA.evaluate(() => { Store.setItem('elaina_theme', 'dark'); Store._flush(); });
        // 同步是异步事件：等 B 真的收到，而不是固定等 2.5s
        await waitFor(async () => (await pageB.evaluate(() => Store.getItem('elaina_theme'))) === 'dark',
            { timeoutMs: 10000, label: 'B 收到主题变化' });
        const themeB = await pageB.evaluate(() => ({
            stored: Store.getItem('elaina_theme'),
            domAttr: document.documentElement.getAttribute('data-theme'),
        }));
        console.log('  B 看到:', JSON.stringify(themeB));
        c.ok(themeB.stored === 'dark', '★ B 的 Store 自动收到了主题变化（无需刷新）', String(themeB.stored));
        c.ok(themeB.domAttr === 'dark', '★ B 的界面真的应用了深色（不只是数据变了）', String(themeB.domAttr));

        console.log('\n=== A 改设置，B 是否自动同步 ===');
        await pageA.evaluate(() => {
            state.settings.model = 'SYNC-FROM-DEVICE-A';
            persistSettings();
        });
        await waitFor(async () => (await pageB.evaluate(() => state.settings.model)) === 'SYNC-FROM-DEVICE-A',
            { timeoutMs: 10000, label: 'B 收到设置变化' });
        const modelB = await pageB.evaluate(() => state.settings.model);
        console.log('  B 的 model:', modelB);
        c.ok(modelB === 'SYNC-FROM-DEVICE-A', '★ B 自动收到了设置变化', String(modelB));

        console.log('\n=== A 发消息，B 是否自动看到 ===');
        const beforeB = await pageB.evaluate(() => state.conversations.length);
        await pageA.evaluate(() => {
            state.conversations.push({
                id: 'sync-conv-from-a', title: 'A 设备新建的对话',
                messages: [{ id: 'sm1', role: 'user', text: '这条来自设备 A', timestamp: '00:00:00' }],
            });
            saveConversations();
        });
        // 数据层与界面层分两步等：界面渲染还要一次重排，比数据慢一点
        await waitFor(async () => pageB.evaluate(() => state.conversations.some((x) => x.id === 'sync-conv-from-a')),
            { timeoutMs: 10000, label: 'B 收到新对话' });
        await waitFor(async () => pageB.evaluate(() => document.body.textContent.includes('A 设备新建的对话')),
            { timeoutMs: 10000, label: 'B 侧栏渲染出新对话' });
        const afterB = await pageB.evaluate(() => ({
            count: state.conversations.length,
            hasConv: state.conversations.some((x) => x.id === 'sync-conv-from-a'),
            shownInList: document.body.textContent.includes('A 设备新建的对话'),
        }));
        console.log('  B 看到:', JSON.stringify(afterB));
        c.ok(afterB.hasConv, '★ B 自动收到了新对话（数据层）', `${beforeB} → ${afterB.count}`);
        c.ok(afterB.shownInList, '★ B 的侧栏真的显示出来了（界面层）');

        console.log('\n=== 反向验证：B 改，A 是否同步 ===');
        await pageB.evaluate(() => { Store.setItem('elaina_theme', 'light'); Store._flush(); });
        await waitFor(async () => (await pageA.evaluate(() => Store.getItem('elaina_theme'))) === 'light',
            { timeoutMs: 10000, label: 'A 收到反向同步' });
        const themeA = await pageA.evaluate(() => Store.getItem('elaina_theme'));
        c.ok(themeA === 'light', '★ 反向也同步（B 改 A 收到）', String(themeA));

        const loops = await pageA.evaluate(() => window.__syncLoopCount || 0);
        c.ok(loops === 0, '没有自触发回环', String(loops));

        console.log('\n页面错误 A:', errsA.length ? errsA.slice(0, 2).join(' | ') : '(无)');
        console.log('页面错误 B:', errsB.length ? errsB.slice(0, 2).join(' | ') : '(无)');

        await ctxA.close();
        await ctxB.close();
    } finally {
        if (browser) { try { await browser.close(); } catch { /* ignore */ } }
        await killServer(child);
        await wait(300);
        try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
        try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// 6. zip 解压实现必须是单一来源（server/zip.mjs），serve.mjs 只留薄包装：
// 防两份实现各修一半；盯实现唯一、三条真实路径可解压、危险类型拦截全路径生效。

async function caseZipMerge(c) {
    const zipSrc = readFileSync(path.join(ROOT, 'server', 'zip.mjs'), 'utf8');
    const serveSrc = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');

    console.log('=== 1. 实现只有一份 ===');
    {
        const hasFullUnzip = /^function unzip\(/m.test(serveSrc)
            && /inflateRawSync/.test(serveSrc.slice(serveSrc.indexOf('function unzip('), serveSrc.indexOf('function unzip(') + 3000));
        c.ok(!hasFullUnzip, '★ serve.mjs 不再自带完整解压实现（已合并到 zip.mjs）');
        c.ok(/readZip\(buf, \{ \.\.\.opts, returnBlocked: true \}\)/.test(serveSrc),
            'serve.mjs 保留薄包装（维持 {files, blocked} 语义，不动调用点）');
        c.ok(/from '\.\.\/server\/zip\.mjs'/.test(serveSrc), 'serve.mjs 从 zip.mjs 引入');
        c.ok(/export function readZip/.test(zipSrc), 'zip.mjs 是导出的唯一实现');
        c.ok(!/^function findEocd\(/m.test(serveSrc), '★ serve.mjs 不再自带 findEocd');
        c.ok(!/^function gbkDecode\(/m.test(serveSrc), '★ serve.mjs 不再自带 gbkDecode');
        c.ok(!/const BLOCKED_EXT = new Set/.test(serveSrc), 'BLOCKED_EXT 已移出 serve.mjs');
        c.ok(/export const BLOCKED_EXT/.test(zipSrc), 'BLOCKED_EXT 定义在 zip.mjs 并导出');
    }

    console.log('\n=== 2. 危险类型拦截在实现内部（所有调用方都受保护）===');
    {
        const fnStart = zipSrc.indexOf('export function readZip');
        const fnBody = zipSrc.slice(fnStart, fnStart + 6000);
        c.ok(/isBlocked\(name\)/.test(fnBody), '★ readZip 内部做危险类型拦截');
        c.ok(/blocked\.push\(name\)/.test(fnBody), '被拦的条目记入 blocked');
        c.ok(/effectiveExt/.test(fnBody), '★ 用 effectiveExt（能识破 x.html::$DATA 这类写法）');

        // 默认拦脚本；mod 安装显式开启
        c.ok(/allowScripts/.test(fnBody), '有 allowScripts 开关');
        c.ok(/PLUGIN_EXTS/.test(fnBody), '插件类扩展名（脚本 + HTML 面板）被单独识别');

        // 数据导入路径（store.mjs）没传 allowScripts → 默认受保护
        const storeSrc = readFileSync(path.join(ROOT, 'server', 'store.mjs'), 'utf8');
        c.ok(/readZip\(/.test(storeSrc), 'store.mjs（数据导入）用 readZip');
        c.ok(!/allowScripts/.test(storeSrc), '★ 数据导入没开 allowScripts（默认受危险类型保护）');
    }

    console.log('\n=== 3. 三条真实路径都能正常工作 ===');
    {
        const tmp = mkdtempSync(path.join(tmpdir(), 'elaina-zip-'));
        try {
            const plain = createZip([
                { name: 'manifest.json', data: Buffer.from('{"v":2}') },
                { name: 'settings.json', data: Buffer.from('{"a":1}') },
                { name: 'characters/card_a.json', data: Buffer.from('{"id":"a"}') },
            ]);
            const files = readZip(plain);
            c.ok(Array.isArray(files), '① 默认返回数组（兼容旧调用方）');
            c.ok(files.length === 3, '三个条目都解出来', 'count=' + files.length);
            c.ok(files.some((f) => f.name === 'characters/card_a.json'), '保留子目录路径');
            c.ok(files.every((f) => Buffer.isBuffer(f.data)), 'data 是 Buffer');

            const withBad = createZip([
                { name: 'model.model3.json', data: Buffer.from('{}') },
                { name: 'evil.html', data: Buffer.from('<script>x</script>') },
                { name: 'evil.exe', data: Buffer.from('MZ') },
                { name: 'texture.png', data: Buffer.from('PNG') },
            ]);
            const r = readZip(withBad, { returnBlocked: true });
            c.ok(r && Array.isArray(r.files) && Array.isArray(r.blocked), '② returnBlocked 时返回 {files, blocked}');
            c.ok(r.files.length === 2, '只解出 2 个合法文件', 'count=' + r.files.length);
            c.ok(r.blocked.length === 2, '★ 拦下 2 个危险类型（.html / .exe）', 'blocked=' + r.blocked.join(','));
            c.ok(r.blocked.includes('evil.html'), '拦了 evil.html');
            c.ok(r.blocked.includes('evil.exe'), '拦了 evil.exe');
            c.ok(r.files.some((f) => f.name === 'model.model3.json'), '合法文件正常解出');

            const modZip = createZip([
                { name: 'manifest.json', data: Buffer.from('{"id":"x"}') },
                { name: 'index.js', data: Buffer.from('console.log(1)') },
                { name: 'style.css', data: Buffer.from('.x{}') },
                { name: 'bad.exe', data: Buffer.from('MZ') },
            ]);
            const mod = readZip(modZip, { allowScripts: true, returnBlocked: true });
            c.ok(mod.files.length === 3, '★ allowScripts 时 .js 可以落盘（3 个文件）', 'count=' + mod.files.length);
            c.ok(mod.files.some((f) => f.name === 'index.js'), 'index.js 被解出');
            c.ok(mod.blocked.includes('bad.exe'), '★ 即使开了 allowScripts，.exe 仍被拦', 'blocked=' + mod.blocked.join(','));

            const traversal = createZip([
                { name: 'ok.json', data: Buffer.from('{}') },
                { name: '../../web/serve.mjs', data: Buffer.from('HACKED') },
                { name: '/abs/path.json', data: Buffer.from('{}') },
            ]);
            const tv = readZip(traversal, { returnBlocked: true });
            c.ok(!tv.files.some((f) => f.name.includes('..')), '★ 路径穿越条目被拦');
            c.ok(!tv.files.some((f) => f.name.startsWith('/')), '★ 绝对路径条目被拦');
            c.ok(tv.files.length === 1, '只解出 1 个合法文件', 'count=' + tv.files.length);

            let threw = false;
            try {
                readZip(plain, { maxTotal: 5 });
            } catch (e) { threw = true; }
            c.ok(threw, '★ 体积上限仍然生效');
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    }

    console.log('\n=== 4. effectiveExt 的绕过防护（合并后仍生效）===');
    {
        const cases = ['x.html::$DATA', 'x.html.', 'x.html ', 'x.js::$DATA'];
        for (const x of cases) {
            c.ok(BLOCKED_EXT.has(effectiveExt(x)), '★ ' + JSON.stringify(x) + ' 仍被判为危险类型');
        }
        c.ok(!BLOCKED_EXT.has(effectiveExt('note.txt')), '正常文本不被误拦');
    }
}

// 6. 记忆权威（M2b）：正文以服务端 /api/memory/core 为准，前端保存 = 整类目替换 + dropIds。
//    服务端不可用（Node 版 / 记忆库关闭）时回退旧 Store 键——那时它就是权威，行为与旧版一致。
async function caseMemoryItemsIndex(c) {
    const ok = (cond, label, extra) => c.ok(cond, label, extra);
    const memVectors = readFileSync(path.join(ROOT, 'web', 'js', 'memory-vectors.js'), 'utf8');
    // memory.js 先于 memory-vectors.js 加载（index.html 的顺序）：保存路径要用到后者的
    // memoryVectorHash / memoryItemsFetch / memoryItemsProbe。
    const memCore = readFileSync(path.join(ROOT, 'web', 'js', 'memory.js'), 'utf8');

    const legacyCore = {
        diary: [{
            conversationId: 'c1', conversationTitle: '咖啡店', date: '2026年11月9日',
            content: '今天和用户在咖啡店聊了很远的旅行计划', essences: ['咖啡店', '旅行计划'],
        }],
        promise: ['每周日一起看一部电影'],
        preference: [], plan: [], motivation: [], pivotal_memory: [],
    };
    // 服务端 canonical 形状：条目带 id（前端 diff dropIds 靠它）。
    const serverCore = {
        diary: [{ ...legacyCore.diary[0], id: 'diary:c1|2026年11月9日' }],
        promise: legacyCore.promise,
        preference: [], plan: [], motivation: [], pivotal_memory: [],
    };

    function makeSandbox({ unavailable = false, server = serverCore } = {}) {
        const calls = [];
        let current = JSON.parse(JSON.stringify(server));
        const sandbox = {
            console: { log() {}, warn() {}, error() {}, info() {} },
            Object, Array, JSON, String, Number, Boolean, Error, Promise, Date, RegExp, Map, Set, Math,
            setTimeout, clearTimeout,
            btoa: (x) => Buffer.from(x, 'binary').toString('base64'),
            atob: (x) => Buffer.from(x, 'base64').toString('binary'),
            state: { memoryCore: null },
            Store: {
                clientId: () => 'test-client',
                getItem: (key) => (key === 'elaina_open_memory_core' ? JSON.stringify(legacyCore) : null),
                setItem: (key, value) => { calls.push({ storeWrite: key, value }); },
            },
            fetch: async (url, init = {}) => {
                calls.push({ url, method: (init.method || 'GET').toUpperCase(), body: init.body });
                if (unavailable) {
                    return { ok: false, status: 404, json: async () => ({ ok: false, message: 'HTTP 404' }) };
                }
                if (url.includes('/index/status')) {
                    return { ok: true, status: 200, json: async () => ({ ok: true, available: true }) };
                }
                if (url.includes('/core') && (init.method || '').toUpperCase() === 'POST') {
                    const body = JSON.parse(init.body);
                    // 服务端 MergeCore 语义：按 id upsert 本份 core，再删 dropIds。
                    const drop = new Set(body.dropIds || []);
                    const next = JSON.parse(JSON.stringify(body.core));
                    for (const kind of ['diary', 'promise', 'preference', 'plan', 'motivation', 'pivotal_memory']) {
                        const list = Array.isArray(next[kind]) ? next[kind] : [];
                        next[kind] = list.filter((e, i) => {
                            const id = kind === 'diary' || kind === 'plan'
                                ? e.id : kind + ':' + h16(typeof e === 'string' ? e : '');
                            return !drop.has(id) || list.findIndex(x => x === e) !== i;
                        });
                    }
                    current = next;
                    return {
                        ok: true, status: 200,
                        json: async () => ({ ok: true, core: current, upserted: 1, deleted: drop.size }),
                    };
                }
                if (url.includes('/core')) {
                    return { ok: true, status: 200, json: async () => ({ ok: true, core: current }) };
                }
                return { ok: false, status: 500, json: async () => ({ ok: false }) };
            },
        };
        // 与前端 memoryVectorHash 同源的 FNV（测试沙箱里对字符串类目算 id 用）。
        sandbox.memoryVectorHash = function (text) {
            let h = 0x811c9dc5;
            const str = String(text || '');
            for (let i = 0; i < str.length; i += 1) {
                h ^= str.charCodeAt(i);
                h = Math.imul(h, 0x01000193);
            }
            return (h >>> 0).toString(16);
        };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        const ctx = vm.createContext(sandbox);
        vm.runInContext(memCore, ctx, { filename: 'memory.js' });
        vm.runInContext(memVectors, ctx, { filename: 'memory-vectors.js' });
        return { sandbox, calls, getCurrent: () => current };
    }

    console.log('\n=== 6. 记忆权威（canonical 读写 / dropIds / 不可用跳过）===');
    {
        const { sandbox, calls } = makeSandbox();
        sandbox.loadMemoryCore();
        ok(Array.isArray(sandbox.state.memoryCore.diary) && sandbox.state.memoryCore.diary.length === 0,
            '启动初始化为空结构：正文只来自服务端 canonical（旧数据由启动迁移直接进库）');
        ok(!calls.some(x => x.storeWrite), '初始化不写 Store 键');
        ok(typeof sandbox.memoryCoreEntryId('diary', { conversationId: 'c1', date: '2026年11月9日' }) === 'string',
            '本地能为条目算出与服务端同口径的 id');
    }
    {
        const { sandbox, calls } = makeSandbox();
        sandbox.loadMemoryCore();
        const refreshed = await sandbox.refreshMemoryCore();
        ok(refreshed === true, '服务端可用时异步换成 canonical 数据');
        ok(sandbox.state.memoryCore.diary[0].id === 'diary:c1|2026年11月9日',
            'canonical 条目带 id（dropIds 与删除都靠它）');
        ok(!calls.some(x => x.storeWrite), '刷新不应写 Store 键（那里已不是权威）');

        // 保存：删掉一条日记 + 整类目替换 promise
        sandbox.state.memoryCore.diary = [];
        sandbox.state.memoryCore.promise = ['改后的约定'];
        await sandbox.saveMemoryCore();
        const put = calls.find(x => x.url.includes('/core') && x.method === 'POST');
        ok(!!put, '保存走 POST /api/memory/core');
        const body = JSON.parse(put.body);
        ok(Array.isArray(body.dropIds) && body.dropIds.includes('diary:c1|2026年11月9日'),
            '被删条目的 id 进了 dropIds', body.dropIds);
        ok(body.dropIds.includes('promise:cdfa01cf'),
            '字符串类目的删除按内容哈希算 id（与 Go 端同口径）', body.dropIds);
        ok(body.client === 'test-client', '带上客户端标识（服务端据此跳过发起方的广播）');
        ok(sandbox.state.memoryCore.promise[0] === '改后的约定',
            '保存后采纳服务端返回的 canonical core');
        ok(!calls.some(x => x.storeWrite), 'API 可用时不再写 Store 键（不产生第二份权威）');
    }
    {
        const { sandbox, calls } = makeSandbox({ unavailable: true });
        sandbox.loadMemoryCore();
        sandbox.state.memoryCore.promise = ['本地新增的约定'];
        await sandbox.saveMemoryCore();
        ok(!calls.some(x => x.url && x.url.includes('/core') && x.method === 'POST'),
            '服务端不可用时不发 core 请求');
        ok(await sandbox.refreshMemoryCore() === false, '不可用时刷新返回 false，本地数据不动');
        ok(!calls.some(x => x.storeWrite === 'elaina_open_memory_core'),
            '★ 不可用时也不再写 Store 键（旧路径已删，不留第二份权威）');
        ok(sandbox.state.memoryCore.promise[0] === '本地新增的约定',
            '改动只保留在页面内存，等记忆库恢复后的下一次保存写入');
    }
    {
        const lineComment = new RegExp('(^|[^:])//[^\\n]*', 'g');
        const blockComment = /\/\*[\s\S]*?\*\//g;
        const stripped = memVectors.replace(blockComment, '').replace(lineComment, '$1');
        ok(!/localStorage/.test(stripped), '不直用 localStorage（走 Store）');
        ok(!/Store\.setItem\(\s*['"]elaina_memory_items/.test(stripped), '不为派生索引新增 Store 键');
        ok(/MEMORY_ITEMS_API_BASE\s*=\s*['"]\/api\/memory['"]/.test(stripped),
            '接口前缀固定 /api/memory（APK 由 NODE_FIXED_PREFIXES 转发）');
    }
}

// 按命令行参数过滤用例（便于只跑其中一段）
const only = process.argv[2];
const allCases = [
    { name: '数据导入导出 API', fn: caseDataApi },
    { name: 'data/ 唯一存储', fn: caseDataAuthority },
    { name: '单一来源与共用业务代码', fn: caseSingleSource },
    { name: '分类存储与 zip 备份', fn: caseStoreLayout },
    { name: '多设备实时同步', fn: caseMultiDeviceSync },
    { name: 'zip 解压单一来源', fn: caseZipMerge },
    { name: '记忆权威迁移', fn: caseMemoryItemsIndex },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: '数据与存储（导入导出 / 唯一权威 / 分类布局 / multi-device sync / zip）',
    usage: 'node scripts/check-data.mjs [用例名子串]',
    cases,
});

