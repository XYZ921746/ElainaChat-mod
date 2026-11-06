//  数据存储层：把运行时数据按用途拆成 data/main/（store.json 设置与密钥、characters/、memory/、voice-samples/）
//  与 data/conversations/，人设卡与聊天记录都是一条一个文件。前端仍走键值同步（POST /api/store），拆分与拼回只在本层。

import { mkdir, readFile, writeFile, rename, readdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createZip, readZip } from './zip.mjs';

//  键 → 归属 的映射表；未列出的键一律留在 store.json。
const CHARACTER_KEYS = {
    list: 'elaina_open_character_cards',   // 人设卡数组（会被拆成一卡一文件）
    current: 'elaina_open_current_card',   // 当前选中的人设 id
    active: 'elaina_open_character_card',  // 当前生效那套的内容
};

const CONVERSATION_KEY = 'elaina_open_conversations';   // 对话数组（会被拆成一对话一文件）
const MEMORY_KEY = 'elaina_open_memory_core';           // 记忆（会被按类目拆成一类一文件）

/** 归类键：会被拆进 characters/、conversations/、memory/，写 store.json / settings.json 时必须排除，否则同一份数据存两遍 */
const CLASSIFIED_KEYS = new Set([
    ...Object.values(CHARACTER_KEYS),
    CONVERSATION_KEY,
    MEMORY_KEY,
]);
function isClassifiedKey(key) { return CLASSIFIED_KEYS.has(key); }

/** 记忆类目：与前端 emptyMemoryCore() 字段一一对应，每类写成 memory/<类目>.json，避免低频类目随日记增长整体重写 */
const MEMORY_CATEGORIES = ['diary', 'promise', 'preference', 'plan', 'motivation', 'pivotal_memory'];

const CHARACTERS_DIR = 'characters';
const CONVERSATIONS_DIR = 'conversations';
const MEMORY_DIR = 'memory';
// 主 data 目录：软件级记录（设置/人设/记忆/音色样本）；conversations/ 是与它平级的对话 data。
const MAIN_DIR = 'main';

/** 参考音频（整段 base64）不进 store.json：拆成 voice-samples/<槽位>.json 元数据 + 同名音频字节，设置里只留 `file:<槽位>` 引用，读写时拆/拼，对前端透明 */
const VOICE_SAMPLES_DIR = 'voice-samples';
/** 设置 JSON 里"音频字段 → 槽位 id"的映射；槽位 id 就是 voice-samples/ 下的文件名 */
const VOICE_SAMPLE_SLOTS = { mimoTtsCloneSample: 'mimo-clone' };
const SETTINGS_KEY = 'elaina_open_settings';
/** voice-samples/ 下合法文件名（slot.wav / slot.mp3 / slot.bin / slot.json），防路径穿越 */
const VOICE_SAMPLE_FILE_RE = /^(mimo-clone)\.(wav|mp3|bin|json)$/;

/** 合法的 id（防止路径穿越：id 直接当文件名用） */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export const BACKUP_FORMAT = 'elainachat-backup';
export const BACKUP_VERSION = 3;   // v1 = 单 JSON；v2 = zip（数据摊在根上）；v3 = zip + data/ 目录
/** 备份 zip 里数据的顶层目录（mods/ 与 skills/ 与它平级）；导入同时认 v2 的根名，老备份照常可导 */
const DATA_PREFIX = 'data/';

export function createStore({ dataDir, log = () => {} }) {
    const mainDir = path.join(dataDir, MAIN_DIR);
    const STORE_FILE = path.join(mainDir, 'store.json');
    const charsDir = path.join(mainDir, CHARACTERS_DIR);
    const charsIndex = path.join(charsDir, 'index.json');
    const convDir = path.join(dataDir, CONVERSATIONS_DIR);
    const convIndex = path.join(convDir, 'index.json');
    const memoryDir = path.join(mainDir, MEMORY_DIR);

    let cache = null;
    // 缓存对应的 data/ 目录 mtime（见 loadStore）。undefined = 还没建立过缓存；-1 = 那时目录不存在
    let cacheStamp;
    let writeQueue = Promise.resolve();
    // 文件路径 → 上次写入内容的 sha1。只用于跳过"内容没变"的重写（见 writeJsonAtomic）。
    const writtenHashes = new Map();

    /** 原子写：先写 .tmp 再 rename，避免写到一半崩溃留下半截文件 */
    async function writeJsonAtomic(file, obj) {
        const text = JSON.stringify(obj, null, 2);
        // 内容没变就别重写：一次消息保存会重放整份聊天记录，逐文件写盘是 O(会话数) 的。哈希只在内存里，进程重启后第一次保存仍会全量落盘。
        const hash = createHash('sha1').update(text).digest('hex');
        if (writtenHashes.get(file) === hash) {
            const exists = await stat(file).then(() => true, () => false);
            if (exists) return;
        }
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        await writeFile(tmp, text, 'utf8');
        await rename(tmp, file);
        writtenHashes.set(file, hash);
    }

    async function readJson(file) {
        try {
            return JSON.parse(await readFile(file, 'utf8'));
        } catch {
            return null;   // 不存在 / 损坏 → 由调用方决定怎么兜底
        }
    }

    /** 二进制版原子写：参考音频等非 JSON 内容用 */
    async function writeFileAtomicBin(file, buffer) {
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        await writeFile(tmp, buffer);
        await rename(tmp, file);
    }

    function normalize(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        for (const [k, v] of Object.entries(raw)) {
            if (typeof k !== 'string' || !k || k.length > 120) continue;
            if (typeof v !== 'string') continue;
            if (v.length > 8 * 1024 * 1024) continue;
            out[k] = v;
        }
        return out;
    }

    /** 确保条目有合法 id（没有就补一个），返回 id */
    function ensureId(item, prefix) {
        if (item && typeof item.id === 'string' && SAFE_ID.test(item.id)) return item.id;
        const id = prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        if (item && typeof item === 'object') item.id = id;
        return id;
    }

    /** 通用的"数组 → 一条一文件 + index"写入：raw 是数组的 JSON 字符串，extra 额外写进 index（如 currentCardId）；非法 JSON 返回 false 不动磁盘 */
    async function writeCollection(raw, dir, prefix, extra = {}) {
        let items = [];
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) items = parsed.filter((x) => x && typeof x === 'object');
        } catch {
            return false;   // 非法 JSON → 不动磁盘，保留旧数据
        }

        const order = [];
        const keep = new Set();
        for (const item of items) {
            const id = ensureId(item, prefix);
            order.push(id);
            keep.add(id + '.json');
            await writeJsonAtomic(path.join(dir, id + '.json'), item);
        }

        // 清掉已被删除的条目（order 里不再出现的文件）
        try {
            for (const name of await readdir(dir)) {
                if (!name.endsWith('.json') || name === 'index.json') continue;
                if (keep.has(name)) continue;
                await rm(path.join(dir, name), { force: true });
            }
        } catch { /* 目录不存在等情况忽略 */ }

        await writeJsonAtomic(path.join(dir, 'index.json'), { version: 1, order, ...extra });
        return true;
    }

    /** 通用的"一条一文件 + index → 数组"读取；返回 JSON 字符串或 null */
    async function readCollection(dir, extraKeys = []) {
        const index = await readJson(path.join(dir, 'index.json'));
        if (!index || !Array.isArray(index.order)) return null;
        const ids = index.order.filter((id) => SAFE_ID.test(id));   // 跳过非法 id，不因一个坏文件全盘失败
        const items = [];
        // 分批并发读：一条一文件的布局下，逐个 await 是 O(会话数) 次串行 I/O（冷启动明显变慢）；
        //   但也不能一次开几百个句柄 —— 每批 32 个，手机端同样安全。
        for (let i = 0; i < ids.length; i += 32) {
            const batch = await Promise.all(ids.slice(i, i + 32).map((id) => readJson(path.join(dir, id + '.json'))));
            for (const item of batch) {
                if (item && typeof item === 'object') items.push(item);
            }
        }
        const out = { json: items.length ? JSON.stringify(items) : null, index };
        return out;
    }

    // 记忆：按类目拆文件
    /** 写：把记忆对象按类目拆成 memory/<类目>.json；日记增长快、承诺/偏好很少变，拆开避免整体重写，也让单类可单独备份或删除，未知类目也写出去（不丢数据） */
    async function writeMemory(raw) {
        let obj = null;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed;
        } catch {
            return false;   // 非法 JSON → 不动磁盘
        }

        const keep = new Set();
        for (const [name, value] of Object.entries(obj)) {
            // 类目名直接当文件名 —— 必须过白名单，防止记忆里混进 "../../x" 这种键
            if (!SAFE_ID.test(name)) continue;
            keep.add(name + '.json');
            await writeJsonAtomic(path.join(memoryDir, name + '.json'), { version: 1, value });
        }
        // 已删除的类目（比如前端去掉了某个字段）清掉残留文件
        try {
            for (const name of await readdir(memoryDir)) {
                if (!name.endsWith('.json')) continue;
                if (keep.has(name)) continue;
                await rm(path.join(memoryDir, name), { force: true });
            }
        } catch { /* 目录不存在等情况忽略 */ }
        return true;
    }

    /** 读：把 memory/<类目>.json 拼回一个对象（返回 JSON 字符串或 null） */
    async function readMemory() {
        let names = [];
        try {
            names = (await readdir(memoryDir)).filter((n) => n.endsWith('.json'));
        } catch {
            return null;   // 目录不存在 → 没有记忆
        }
        if (!names.length) return null;

        const obj = {};
        for (const name of names.sort()) {
            const category = name.slice(0, -'.json'.length);
            if (!SAFE_ID.test(category)) continue;
            const rec = await readJson(path.join(memoryDir, name));
            if (rec && rec.value !== undefined) obj[category] = rec.value;
        }
        return Object.keys(obj).length ? JSON.stringify(obj) : null;
    }

    // 读：拼回键值
    /** 把 data/ 下的分类文件拼成键值对象。先读分类文件、再读 store.json：过渡期两边都有时 store.json 的值不会覆盖已分出去的新值；缓存与 data/ 目录 mtime 绑定，外部删目录或手工改文件都会让缓存失效（应用自身写入由 invalidate() 覆盖） */
    async function loadStore() {
        if (cache && await isCacheFresh()) return cache;
        const out = {};

        const mem = await readMemory();
        if (mem) out[MEMORY_KEY] = mem;

        const chars = await readCollection(charsDir);
        if (chars && chars.json) {
            out[CHARACTER_KEYS.list] = chars.json;
            if (typeof chars.index.currentCardId === 'string') {
                out[CHARACTER_KEYS.current] = chars.index.currentCardId;
            }
        }

        const convs = await readCollection(convDir);
        if (convs && convs.json) out[CONVERSATION_KEY] = convs.json;

        const legacy = normalize(await readJson(STORE_FILE));
        for (const [k, v] of Object.entries(legacy)) {
            if (out[k] === undefined) out[k] = v;
        }

        await joinVoiceSamples(out);

        cache = out;
        cacheStamp = await dataDirStamp();
        return cache;
    }

    // 参考音频：拆出 store.json
    /** 解析 obj[SETTINGS_KEY] 那段设置 JSON；非字符串 / 非法 JSON / 非对象（数组也算）一律返回 null，调用方原样保留不碰 */
    function parseSettingsObject(obj) {
        const settings = obj && typeof obj === 'object' ? obj[SETTINGS_KEY] : null;
        if (typeof settings !== 'string') return null;
        let parsed;
        try { parsed = JSON.parse(settings); } catch { return null; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed;
    }

    /** 把设置对象里 VOICE_SAMPLE_SLOTS 列出的音频字段落成独立文件，设置里替换成 `file:<槽位>` 引用（原地改 obj）；接受 data URL 与裸 base64，写盘先全量清理，设置里没有的字段对应文件也删掉 */
    async function splitVoiceSamples(obj) {
        const parsed = parseSettingsObject(obj);
        if (!parsed) return;

        const sampleDir = path.join(mainDir, VOICE_SAMPLES_DIR);
        await mkdir(sampleDir, { recursive: true });

        let changed = false;
        for (const [field, slot] of Object.entries(VOICE_SAMPLE_SLOTS)) {
            const value = typeof parsed[field] === 'string' ? parsed[field] : '';
            if (value.startsWith('file:')) continue;   // 已经是引用，无需处理

            if (!value) {
                // 清空：设置里删字段，磁盘上删文件（包括 wav 旧扩展名，往前兼容）
                if (field in parsed) { delete parsed[field]; changed = true; }
                for (const ext of ['.wav', '.bin', '.json']) {
                    await rm(path.join(sampleDir, slot + ext), { force: true });
                }
                continue;
            }

            // data:audio/xxx;base64,AAAA | 裸 base64 AAAA
            const comma = value.indexOf(',');
            const isDataUrl = /^data:[\w.+-]+\/[\w.+-]+;base64,/.test(value.slice(0, comma + 1));
            const b64 = isDataUrl ? value.slice(comma + 1) : value;
            let bytes;
            try { bytes = Buffer.from(b64, 'base64'); } catch { continue; }   // 解不出就别动原值
            if (!bytes || !bytes.length) continue;

            const mime = isDataUrl ? value.slice(5, comma).replace(/;base64$/, '') : 'audio/wav';
            const ext = /mp3/i.test(mime) ? '.mp3' : '.wav';
            await writeJsonAtomic(path.join(sampleDir, slot + '.json'), { version: 1, mime, bytes: bytes.length });
            // 音频本体用二进制直写（不是 JSON）：几 MB 的 base64 转 JSON 会再翻一倍体积
            await writeFileAtomicBin(path.join(sampleDir, slot + ext), bytes);
            // 换格式后清掉另一种扩展名的文件（比如上次 .wav、这次 .mp3）
            for (const other of ['.wav', '.mp3', '.bin']) {
                if (other !== ext) await rm(path.join(sampleDir, slot + other), { force: true });
            }
            parsed[field] = `file:${slot}`;
            changed = true;
        }

        if (changed) obj[SETTINGS_KEY] = JSON.stringify(parsed);
    }

    /** 把 `file:<槽位>` 引用拼回完整 data URL（loadStore 专用）；文件丢了/坏了就删字段，前端当成"没设置样本"重新上传即可 */
    async function joinVoiceSamples(obj) {
        const parsed = parseSettingsObject(obj);
        if (!parsed) return;

        let changed = false;
        for (const [field, slot] of Object.entries(VOICE_SAMPLE_SLOTS)) {
            const value = typeof parsed[field] === 'string' ? parsed[field] : '';
            if (!value.startsWith('file:')) continue;
            if (value !== `file:${slot}`) { delete parsed[field]; changed = true; continue; }   // 未知槽位，丢弃

            const sampleDir = path.join(mainDir, VOICE_SAMPLES_DIR);
            let bytes = null;
            let meta = null;
            for (const ext of ['.wav', '.mp3', '.bin']) {
                meta = meta || await readJson(path.join(sampleDir, slot + '.json'));
                if (!meta) break;
                try { bytes = await readFile(path.join(sampleDir, slot + ext)); } catch { bytes = null; continue; }
                break;
            }
            if (!bytes || !bytes.length) {
                delete parsed[field];   // 引用悬空：文件被手动删了
                changed = true;
                continue;
            }
            const mime = (meta && meta.mime) || 'audio/wav';
            parsed[field] = `data:${mime};base64,${bytes.toString('base64')}`;
            changed = true;
        }

        if (changed) obj[SETTINGS_KEY] = JSON.stringify(parsed);
    }

    /** data/ 布局的时间戳，目录不存在返回 -1（表示"没有数据"）；main/ 与 conversations/ 里的外部改动不一定 touch data/ 顶层 mtime，所以三个目录一起盯 */
    async function dataDirStamp() {
        const parts = await Promise.all([dataDir, mainDir, convDir].map(async (d) => {
            try { return (await stat(d)).mtimeMs; } catch { return -1; }
        }));
        return parts.join(',');
    }

    /** 缓存是否仍对应磁盘当前状态：目录 mtime 变了说明有人动过数据（删除/重建/手工编辑）；必须每次重新 stat 比对，只比旧值的话"删目录"这种不写盘的操作检测不到 */
    async function isCacheFresh() {
        if (cacheStamp === undefined) return false;
        return (await dataDirStamp()) === cacheStamp;
    }

    // 写：拆成文件
    /** 保存：按映射表把键值拆到各自文件；只处理 store 里存在的键，不因"这次没提交"就清掉已有数据 */
    async function writeClassifiedStore(store) {
        if (typeof store[MEMORY_KEY] === 'string') {
            await writeMemory(store[MEMORY_KEY]);
        }

        if (typeof store[CHARACTER_KEYS.list] === 'string') {
            await writeCollection(store[CHARACTER_KEYS.list], charsDir, 'card', {
                currentCardId: typeof store[CHARACTER_KEYS.current] === 'string' ? store[CHARACTER_KEYS.current] : '',
            });
        }

        if (typeof store[CONVERSATION_KEY] === 'string') {
            await writeCollection(store[CONVERSATION_KEY], convDir, 'conv');
        }
    }

    async function writeMiscStore(store) {
        // 其余键 → store.json（分类键不再重复写进去）
        const misc = {};
        for (const [k, v] of Object.entries(store)) {
            if (isClassifiedKey(k)) continue;
            misc[k] = v;
        }
        // 参考音频先拆出去：misc 里的设置只留 `file:<槽位>` 引用
        await splitVoiceSamples(misc);
        await writeJsonAtomic(STORE_FILE, misc);
    }

    async function saveStore() {
        const run = writeQueue.then(async () => {
            await mkdir(dataDir, { recursive: true });
            const store = cache || {};
            await writeClassifiedStore(store);
            await writeMiscStore(store);
            // 应用自己写完盘后把缓存对应的磁盘状态更新为刚写出来的样子，否则下次 loadStore 会因 mtime 变了而白白重读全部文件
            cacheStamp = await dataDirStamp();
        });
        // 队列必须吞错：一次写盘失败不能让后续保存全卡死；但调用方要拿到真实结果，写失败却回 ok 会让用户以为已落盘
        writeQueue = run.catch(() => { });
        try {
            await run;
        } catch (err) {
            log('error', '[store] 写入失败: ' + (err && err.message ? err.message : err));
            throw err;
        }
    }

    // 迁移
    /** 把还住在 data/ 顶层的软件级记录收进 main/：只在旧位置存在、新位置不存在时 rename（幂等），conversations/ 本来就在顶层不动它；必须早于下面的键值迁移 —— 那一步读的 STORE_FILE 已指向 main/store.json */
    async function moveIntoMain() {
        const moves = [
            ['store.json', path.join(dataDir, 'store.json'), STORE_FILE],
            [CHARACTERS_DIR, path.join(dataDir, CHARACTERS_DIR), charsDir],
            [MEMORY_DIR, path.join(dataDir, MEMORY_DIR), memoryDir],
            [VOICE_SAMPLES_DIR, path.join(dataDir, VOICE_SAMPLES_DIR), path.join(mainDir, VOICE_SAMPLES_DIR)],
        ];
        for (const [label, from, to] of moves) {
            try {
                const oldExists = await stat(from).then(() => true, () => false);
                const newExists = await stat(to).then(() => true, () => false);
                if (oldExists && !newExists) {
                    await mkdir(path.dirname(to), { recursive: true });
                    await rename(from, to);
                    log('info', `[store] 目录整理：${label} 已收进 main/`);
                }
            } catch (err) {
                log('warn', `[store] 目录整理失败（${label}，数据留在原位，不影响读取）：`
                    + (err && err.message ? err.message : err));
            }
        }
    }

    /** 把"全部挤在 store.json"的数据迁到分类文件：只在还留着分类键（或遗留单文件）时动手，迁完键会消失（幂等）；@returns 迁移了哪些类目（空数组 = 无需迁移） */
    async function migrateIfNeeded() {
        await moveIntoMain();
        const legacy = normalize(await readJson(STORE_FILE));
        const moved = [];

        const hasMemKey = typeof legacy[MEMORY_KEY] === 'string';
        const hasCharKey = typeof legacy[CHARACTER_KEYS.list] === 'string';
        const hasConvKey = typeof legacy[CONVERSATION_KEY] === 'string';
        // 这两个单文件只在这里读一次，用途就是取待迁数据
        const legacySingleConv = await readJson(path.join(dataDir, 'conversations.json'));
        const legacySingleMem = await readJson(path.join(dataDir, 'memory.json'));

        // 参考音频独立判断：分类类目可能早已拆完（moved 为空会直接 return），音频拆分必须在那个 return 之前处理完
        {
            const probe = { [SETTINGS_KEY]: typeof legacy[SETTINGS_KEY] === 'string' ? legacy[SETTINGS_KEY] : null };
            if (probe[SETTINGS_KEY]) {
                await splitVoiceSamples(probe);
                if (probe[SETTINGS_KEY] !== legacy[SETTINGS_KEY]) {
                    // 设置内容变了（音频拆出去了）：写回 store.json，并同步进 cache
                    await writeJsonAtomic(STORE_FILE, (() => {
                        const misc = {};
                        for (const [k, v] of Object.entries(legacy)) {
                            if (isClassifiedKey(k)) continue;
                            misc[k] = v;
                        }
                        misc[SETTINGS_KEY] = probe[SETTINGS_KEY];
                        return misc;
                    })());
                    log('info', '[store] 参考音频已拆分到 voice-samples/（store.json 只留引用）');
                }
            }
        }

        if (!hasMemKey && !hasCharKey && !hasConvKey && !legacySingleConv && !legacySingleMem) return moved;

        // 记忆：两个来源（store.json 里的键 / 单文件 memory.json）
        {
            const existing = await readMemory();
            if (!existing) {
                const source = hasMemKey
                    ? legacy[MEMORY_KEY]
                    : (legacySingleMem && typeof legacySingleMem.value === 'string' ? legacySingleMem.value : null);
                if (typeof source === 'string') {
                    const ok = await writeMemory(source);
                    if (ok) moved.push('memory');
                }
            }
        }

        // 人设卡
        if (hasCharKey) {
            const idx = await readJson(charsIndex);
            if (!idx || !Array.isArray(idx.order) || !idx.order.length) {
                const ok = await writeCollection(legacy[CHARACTER_KEYS.list], charsDir, 'card', {
                    currentCardId: typeof legacy[CHARACTER_KEYS.current] === 'string' ? legacy[CHARACTER_KEYS.current] : '',
                });
                if (ok) moved.push('characters');
            }
        }

        // 聊天记录：两个来源（store.json 里的键 / 单文件 conversations.json）
        {
            const idx = await readJson(convIndex);
            const alreadySplit = idx && Array.isArray(idx.order) && idx.order.length;
            if (!alreadySplit) {
                const source = hasConvKey
                    ? legacy[CONVERSATION_KEY]
                    : (legacySingleConv && typeof legacySingleConv.value === 'string' ? legacySingleConv.value : null);
                if (typeof source === 'string') {
                    const ok = await writeCollection(source, convDir, 'conv');
                    if (ok) moved.push('conversations');
                }
            }
        }

        if (moved.length) {
            cache = null;
            await loadStore();
            if (typeof legacy[MEMORY_KEY] === 'string' && cache[MEMORY_KEY] === undefined) {
                cache[MEMORY_KEY] = legacy[MEMORY_KEY];
            }
            if (typeof legacy[CHARACTER_KEYS.list] === 'string' && cache[CHARACTER_KEYS.list] === undefined) {
                cache[CHARACTER_KEYS.list] = legacy[CHARACTER_KEYS.list];
                if (typeof legacy[CHARACTER_KEYS.current] === 'string') {
                    cache[CHARACTER_KEYS.current] = legacy[CHARACTER_KEYS.current];
                }
            }
            await saveStore();
            log('info', `[store] 已迁移到分类存储: ${moved.join(', ')}`);
        }

        // 清掉遗留单文件必须写在 `if (moved.length)` 之外：数据已落位（alreadySplit 为真、moved 为空）时它既不被读取也不被清理，会永久留在磁盘上。
        // 判据：新位置有内容才删 —— 没内容时它是唯一数据来源。
        if (legacySingleConv) {
            const idx = await readJson(convIndex);
            const newHasData = idx && Array.isArray(idx.order) && idx.order.length > 0;
            if (newHasData) {
                await rm(path.join(dataDir, 'conversations.json'), { force: true });
                if (!moved.length) log('info', '[store] 清理了遗留的旧单文件 conversations.json（数据已在 conversations/ 里）');
            }
        }
        if (legacySingleMem) {
            const mem = await readMemory();
            if (mem) {
                await rm(path.join(dataDir, 'memory.json'), { force: true });
                if (!moved.length) log('info', '[store] 清理了遗留的旧单文件 memory.json（数据已在 memory/ 里）');
            }
        }

        return moved;
    }

    // 导入导出
    /** manifest.json：给人和程序看的说明与统计。 */
    function buildExportManifest(store, extraCounts) {
        let cardCount = 0;
        let convCount = 0;
        try { cardCount = JSON.parse(store[CHARACTER_KEYS.list] || '[]').length; } catch { /* 忽略 */ }
        try { convCount = JSON.parse(store[CONVERSATION_KEY] || '[]').length; } catch { /* 忽略 */ }
        return {
            name: 'manifest.json',
            data: JSON.stringify({
                format: BACKUP_FORMAT,
                version: BACKUP_VERSION,
                exportedAt: new Date().toISOString(),
                note: '这是 ElainaChat 的数据备份（含已安装插件与技能）。导入时请选择本 zip 文件。',
                counts: {
                    characters: cardCount,
                    conversations: convCount,
                    mods: Number(extraCounts.mods) || 0,
                    skills: Number(extraCounts.skills) || 0,
                },
            }, null, 2),
        };
    }

    /** settings.json：除归类键（卡/对话/记忆）之外的设置与偏好。 */
    function buildExportSettings(store) {
        const settings = {};
        for (const [k, v] of Object.entries(store)) {
            if (isClassifiedKey(k)) continue;
            settings[k] = v;
        }
        return { name: DATA_PREFIX + 'settings.json', data: JSON.stringify(settings, null, 2) };
    }

    async function buildExportCharacters() {
        const out = [];
        const charsIdx = await readJson(charsIndex);
        if (!charsIdx) return out;
        out.push({ name: DATA_PREFIX + 'characters/index.json', data: JSON.stringify(charsIdx, null, 2) });
        for (const id of charsIdx.order || []) {
            if (!SAFE_ID.test(id)) continue;
            const card = await readJson(path.join(charsDir, id + '.json'));
            if (card) out.push({ name: `${DATA_PREFIX}characters/${id}.json`, data: JSON.stringify(card, null, 2) });
        }
        return out;
    }

    /** conversations/：index + 一对话一文件。 */
    async function buildExportConversations() {
        const out = [];
        const convIdx = await readJson(convIndex);
        if (!convIdx) return out;
        out.push({ name: DATA_PREFIX + 'conversations/index.json', data: JSON.stringify(convIdx, null, 2) });
        for (const id of convIdx.order || []) {
            if (!SAFE_ID.test(id)) continue;
            const conv = await readJson(path.join(convDir, id + '.json'));
            if (conv) out.push({ name: `${DATA_PREFIX}conversations/${id}.json`, data: JSON.stringify(conv, null, 2) });
        }
        return out;
    }

    /** memory/：一类目一文件（备份 zip 的目录自成一格，不必与磁盘一一对应）。 */
    async function buildExportMemory() {
        const out = [];
        try {
            const names = (await readdir(memoryDir)).filter((n) => n.endsWith('.json'));
            for (const name of names.sort()) {
                const rec = await readJson(path.join(memoryDir, name));
                if (rec) out.push({ name: `${DATA_PREFIX}memory/${name}`, data: JSON.stringify(rec, null, 2) });
            }
        } catch { /* 没有记忆目录就跳过 */ }
        return out;
    }

    /** 参考音频：音频本体（解压后能直接听）。 */
    async function buildExportVoiceSamples() {
        const out = [];
        try {
            const sampleDir = path.join(mainDir, VOICE_SAMPLES_DIR);
            for (const name of (await readdir(sampleDir)).sort()) {
                if (!VOICE_SAMPLE_FILE_RE.test(name)) continue;
                const raw = await readFile(path.join(sampleDir, name));
                if (raw && raw.length) out.push({ name: `${DATA_PREFIX}${VOICE_SAMPLES_DIR}/${name}`, data: raw });
            }
        } catch { /* 没有参考音频就跳过 */ }
        return out;
    }

    /** 导出为 zip，条目：manifest.json、data/settings.json、data/characters/、data/conversations/、data/memory/、data/voice-samples/；套一层 data/ 是为了把聊天数据与 mods/、skills/ 分开，插件与技能由调用方收集成 extraEntries 传入（见 server/backup-packages.mjs） */
    async function exportZip(extraEntries = [], extraCounts = {}) {
        const store = await loadStore();
        const entries = [
            buildExportManifest(store, extraCounts),
            buildExportSettings(store),
            ...(await buildExportCharacters()),
            ...(await buildExportConversations()),
            ...(await buildExportMemory()),
            ...(await buildExportVoiceSamples()),
        ];
        for (const entry of extraEntries) {
            if (!entry || !entry.name || entry.data === undefined || entry.data === null) continue;
            entries.push({ name: String(entry.name), data: entry.data });
        }
        return createZip(entries);
    }

    /** 从备份导入：输入可以是 zip 或 v1 的单个 JSON，mode 为 'merge'（按键覆盖）或 'replace'（清空后只留备份内容）；插件/技能目录不在这里恢复 —— 那一步要放行 .js 入口，不能把这条放宽带进数据解析（由 serve.mjs 交给 server/backup-packages.mjs） */
    async function importBackup(buf, mode = 'merge') {
        const payload = await parseBackup(buf);
        const incoming = payload.data;
        const keys = Object.keys(incoming);
        if (!keys.length) return { ok: false, keys: 0, message: '备份里没有可导入的数据' };

        const store = await loadStore();
        if (mode === 'replace') {
            // 1) 先清内存里的键
            for (const k of Object.keys(store)) delete store[k];
            // 2) 备份里没有的分类也要写成空集合：writeCollection / writeMemory 会顺带删掉不再属于该集合的文件，
            //    否则下一次 loadStore 会把残留条目重新拼回来，替换模式等于没生效。
            if (typeof incoming[MEMORY_KEY] !== 'string') await writeMemory('{}');
            if (typeof incoming[CHARACTER_KEYS.list] !== 'string') {
                await writeCollection('[]', charsDir, 'card', { currentCardId: '' });
            }
            if (typeof incoming[CONVERSATION_KEY] !== 'string') {
                await writeCollection('[]', convDir, 'conv');
            }
            // 3) 设置里没有参考音频时清掉 voice-samples/ 下的文件：splitVoiceSamples 只在有 settings 时才清理，不清就成了无主文件
            if (typeof incoming[SETTINGS_KEY] !== 'string') {
                const sampleDir = path.join(mainDir, VOICE_SAMPLES_DIR);
                try {
                    for (const name of await readdir(sampleDir)) {
                        await rm(path.join(sampleDir, name), { force: true });
                    }
                } catch { /* 目录不存在 */ }
            }
        }
        Object.assign(store, incoming);
        await saveStore();
        return { ok: true, keys: keys.length, source: payload.source, message: `已导入 ${keys.length} 项数据（${mode === 'replace' ? '替换' : '合并'}模式）` };
    }

    /** 这份备份里有没有数据部分（settings / 人设卡 / 对话 / 记忆）；只解析不落盘，判断放在写盘之前，坏包就不会先清掉已有数据 */
    async function hasImportableData(buf) {
        const payload = await parseBackup(buf);
        return Object.keys(payload.data || {}).length > 0;
    }

    /** 从 zip 条目还原 { 键: 字符串 }：v3 在 data/ 下，v2 直接摊在 zip 根上，两种布局都认 */
    function extractZipData(files) {
        const byName = new Map(files.map((f) => [f.name, f.data]));
        const data = {};

        // 同一个条目可能有两种写法：先找 data/<名字>，没有再看根名 —— 用户手里的 v2 备份照常能导。
        const readText = (name) => {
            const b = byName.get(name) || byName.get(DATA_PREFIX + name);
            return b ? b.toString('utf8') : null;
        };

        const settingsText = readText('settings.json');
        if (settingsText) {
            try {
                const obj = JSON.parse(settingsText);
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    for (const [k, v] of Object.entries(obj)) {
                        if (typeof v === 'string') data[k] = v;
                    }
                }
            } catch { /* 单个文件坏了不该让整包失败 */ }
        }

        // 人设卡：按 index.order 拼回数组（保持顺序）
        const charsIdxText = readText('characters/index.json');
        if (charsIdxText) {
            try {
                const idx = JSON.parse(charsIdxText);
                const cards = [];
                for (const id of (idx && idx.order) || []) {
                    if (!SAFE_ID.test(id)) continue;
                    const t = readText(`characters/${id}.json`);
                    if (!t) continue;
                    try { cards.push(JSON.parse(t)); } catch { /* 跳过坏卡 */ }
                }
                if (cards.length) {
                    data[CHARACTER_KEYS.list] = JSON.stringify(cards);
                    if (typeof idx.currentCardId === 'string') data[CHARACTER_KEYS.current] = idx.currentCardId;
                }
            } catch { /* 忽略 */ }
        }

        const convIdxText = readText('conversations/index.json');
        if (convIdxText) {
            try {
                const idx = JSON.parse(convIdxText);
                const convs = [];
                for (const id of (idx && idx.order) || []) {
                    if (!SAFE_ID.test(id)) continue;
                    const t = readText(`conversations/${id}.json`);
                    if (!t) continue;
                    try { convs.push(JSON.parse(t)); } catch { /* 跳过坏项 */ }
                }
                if (convs.length) data[CONVERSATION_KEY] = JSON.stringify(convs);
            } catch { /* 忽略 */ }
        }

        // 记忆：一类目一文件拼回对象，兼容 data/memory/<类目>.json、memory/<类目>.json（v2 根布局）与 memory.json {value:…}
        const memObj = {};
        for (const f of files) {
            const m = /^(?:data\/)?memory\/([A-Za-z0-9_-]+)\.json$/.exec(f.name);
            if (!m) continue;
            const category = m[1];
            try {
                const rec = JSON.parse(f.data.toString('utf8'));
                if (rec && rec.value !== undefined) memObj[category] = rec.value;
            } catch { /* 跳过坏文件 */ }
        }
        if (Object.keys(memObj).length) {
            data[MEMORY_KEY] = JSON.stringify(memObj);
        } else {
            const legacyMem = readText('memory.json');
            if (legacyMem) {
                try {
                    const rec = JSON.parse(legacyMem);
                    if (rec && typeof rec.value === 'string') data[MEMORY_KEY] = rec.value;
                } catch { /* 忽略 */ }
            }
        }

        return data;
    }

    /** 备份里的参考音频落回 data 的 voice-samples/，设置里对应的 `file:<槽位>` 引用才能成立；单个文件失败不挡整包导入 */
    async function restoreVoiceSamplesFromZip(files) {
        const sampleDir = path.join(mainDir, VOICE_SAMPLES_DIR);
        for (const f of files) {
            const base = f.name.replace(/\\/g, '/');
            const rest = base.startsWith(DATA_PREFIX + VOICE_SAMPLES_DIR + '/')
                ? base.slice(DATA_PREFIX.length + VOICE_SAMPLES_DIR.length + 1)
                : (base.startsWith(VOICE_SAMPLES_DIR + '/') ? base.slice(VOICE_SAMPLES_DIR.length + 1) : '');
            if (!rest || !VOICE_SAMPLE_FILE_RE.test(rest)) continue;
            try {
                await writeFileAtomicBin(path.join(sampleDir, rest), f.data);
            } catch { /* 单个文件失败不挡整包导入 */ }
        }
    }

    /** v1 的单 JSON 备份形状，仍需能导入 */
    function parseLegacyJsonBackup(buf) {
        let parsed;
        try {
            parsed = JSON.parse(buf.toString('utf8'));
        } catch {
            throw new Error('这个文件既不是 zip 也不是有效的 JSON 备份');
        }
        const raw = parsed && typeof parsed === 'object' && parsed.data ? parsed.data : parsed;
        return { source: 'json', data: normalize(raw), files: null };
    }

    /** 把 Buffer 解析成 { source, data:{键:字符串} }；zip 与旧 JSON 都支持 */
    async function parseBackup(buf) {
        if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf ?? ''), 'utf8');

        // zip：以 PK\x03\x04 开头
        if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
            const files = readZip(buf, { maxTotal: 256 * 1024 * 1024, maxEntry: 64 * 1024 * 1024 });
            const data = extractZipData(files);
            await restoreVoiceSamplesFromZip(files);
            return { source: 'zip', data, files };
        }

        return parseLegacyJsonBackup(buf);
    }

    /** 让调用方丢弃缓存（导入/外部改动后强制重读）：cache 与 cacheStamp 必须成对清掉，只清 cache 的话 isCacheFresh() 仍可能凭旧 mtime 判缓存有效 */
    function invalidate() { cache = null; cacheStamp = undefined; }

    return {
        loadStore, saveStore, migrateIfNeeded,
        exportZip, importBackup, hasImportableData,
        invalidate,
        CHARACTER_KEYS, CONVERSATION_KEY, MEMORY_KEY, MEMORY_CATEGORIES,
    };
}

