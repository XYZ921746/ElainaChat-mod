// 回归检查：data/ 是唯一存储权威，且 Web / APK **共用同一套业务代码**。
//
// ── 这个检查防的两类退化 ────────────────────────────────────────────────
//
// ① **业务数据又写回 localStorage**
//    起因是实测 bug："删除 data 分区后重新打开还是有数据" ——
//    因为 localStorage 当时才是真身，data-sync.js 还会把本机数据反向推回 data/。
//    修法是把权威存储换成 data/（见 web/js/store.js）。若以后有人在业务代码里
//    又直接写 localStorage，那个 bug 会以同样的方式复活。
//    所以这里**静态扫描**：除 store.js 自身与明确的例外外，
//    web/js 下不许出现 localStorage 的读写。
//
// ② **业务代码里长出平台分支**
//    用户明确要求："尽量让安卓和 web 代码同步，不然出问题了还要搞两套代码。"
//    允许的平台差异**只有持久化后端那一层**（store.js 内部）。
//    业务文件里若出现 Capacitor / isNativePlatform 判断，就说明有人开始分叉了，
//    这个检查会在 CI 阶段拦住 —— 而不是等用户在两台设备上各报一次 bug。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = path.join(ROOT, 'web', 'js');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

const files = readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
const src = {};
for (const f of files) src[f] = readFileSync(path.join(JS_DIR, f), 'utf8');

/** 去掉注释，避免把注释里的说明当成真实代码 */
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ============================================================
// 1. 业务代码不许直接读写 localStorage
// ============================================================
console.log('=== 1. localStorage 只允许出现在存储层 ===');
{
    // 例外清单：每条都要有理由，不能随便加
    const ALLOWED = {
        // store.js 是存储层本身。它**也只把 localStorage 当 API 形态参考**，
        // 实际并不使用（它用内存缓存 + 后端）。这里放行是为了注释与未来兼容。
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

    // 反向：store.js 必须真的存在且提供接口
    ok(!!src['store.js'], 'store.js 存在');
    ok(/window\.Store\s*=/.test(src['store.js'] || ''), '★ store.js 暴露 window.Store');
    for (const fn of ['bootstrap', 'getItem', 'setItem', 'removeItem']) {
        ok(new RegExp(`\\b${fn}\\b`).test(src['store.js'] || ''), `Store 提供 ${fn}()`);
    }
}

// ============================================================
// 2. 平台分支只允许在存储层
// ============================================================
console.log('\n=== 2. 平台差异只在存储层（Web/APK 共用一套业务代码）===');
{
    const PLATFORM_RE = /isNativePlatform|Capacitor\.Plugins|Capacitor\.getPlatform/;
    // 例外清单 = **功能差异**，不是数据分叉。每条都要有理由。
    //
    // 判断标准：这个分支是在"同一件事在两端做法不同"，还是在"某一端根本没有这个功能"？
    //   · 数据存储 → 两端都要存同样的东西 → 必须共用（所以 store.js 是唯一允许的）
    //   · 原生插件 → APK 有原生能力、Web 没有 → 天然只能是分支，且不产生两套业务逻辑
    const ALLOWED_PLATFORM = {
        'store.js': '数据后端分支（唯一允许的存储差异）',
        'app-01-core.js': 'BYOK 原生 HTTP 插件（APK 用原生绕 CORS，Web 走本机中转）',
        'app-02-data.js': 'API Key 的原生 Keystore（APK 有安全存储，Web 没有）',
        'app-05-voice.js': 'TTS 原生插件（APK 用系统 TTS，Web 用 HTTP 接口）',
        'app-03-agent.js': '手机操作（APK 独有功能，Web 没有这个概念）',
        'app-06-settings.js': '备份文件的导入导出（APK 用 Filesystem 选/读文件）',
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

    // 数据存储相关的分支必须只有 store.js 一处（用于**用户数据**）。
    //
    // ★ 为什么要排除 app-01-core.js：它写的是 **Live2D 模型文件**，不是用户数据。
    //   APK 里模型必须落在应用目录（Web 端由服务端提供，两端本来就不是一回事），
    //   而且模型是"可重新获取的资源" —— 删掉只是要重新下载，不像聊天记录会永久丢失。
    //   判断标准：**丢了会不会心疼**。会心疼的（聊天/设置/记忆）必须只有 data/ 一处。
    const NON_DATA_WRITERS = {
        'app-01-core.js': 'Live2D 模型文件（可重新获取的资源，不是用户数据）',
        // Directory.Documents：读写**用户自己选的备份文件**（导出/导入）。
        // 那是"跟用户交换文件"，不是"应用自己的存储"，且只在用户主动操作时发生。
        'app-06-settings.js': '备份文件的导入导出（读写用户在文档目录里选的文件）',
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

// ============================================================
// 3. data-sync.js 必须保持为空壳（防止旧的双向同步复活）
// ============================================================
console.log('\n=== 3. 旧的双向同步不得复活 ===');
{
    const ds = src['data-sync.js'] || '';
    const code = stripComments(ds);
    // 旧实现的特征：同步 XHR 读 /api/store，然后写 localStorage，再反向推回
    ok(!/XMLHttpRequest/.test(code), '★ data-sync.js 里没有同步 XHR（旧的拉取逻辑已移除）');
    ok(!/localStorage\s*\.\s*setItem/.test(code), '★ data-sync.js 不再写 localStorage');
    ok(!/api\/store/.test(code), '★ data-sync.js 不再直接打 /api/store（改由 store.js 负责）');
    ok(/store\.js|Store/.test(ds), 'data-sync.js 保留说明指向 store.js');
}

// ============================================================
// 4. 前端与服务端的键清单必须一致
// ============================================================
console.log('\n=== 4. 键清单一致（避免"某类数据没被保存"）===');
{
    // store.js 的 DATA_KEYS 是前端权威清单
    const m = (src['store.js'] || '').match(/var DATA_KEYS = \[([\s\S]*?)\];/);
    ok(!!m, '能取到 store.js 的 DATA_KEYS');
    if (m) {
        const keys = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
        ok(keys.length >= 10, `DATA_KEYS 有 ${keys.length} 个键`);
        // 关键键一个都不能少 —— 这些是用户能感知到的数据
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

// ============================================================
// 5. 启动时必须先 bootstrap 再读数据
// ============================================================
console.log('\n=== 5. 启动顺序：先 bootstrap 再读 ===');
{
    const init = src['app-07-init.js'] || '';
    const code = stripComments(init);
    const bootAt = code.indexOf('Store.bootstrap()');
    ok(bootAt >= 0, '★ init() 里调用了 Store.bootstrap()');
    // bootstrap 必须早于所有 load*
    const loadCalls = ['loadSettings()', 'loadConversations()', 'loadMemoryCore()']
        .map((c) => ({ c, at: code.indexOf(c) }))
        .filter((x) => x.at >= 0);
    ok(loadCalls.length >= 2, 'init() 里有读取数据的调用');
    const tooEarly = loadCalls.filter((x) => x.at < bootAt).map((x) => x.c);
    ok(tooEarly.length === 0, '★ 所有 load* 都在 bootstrap 之后（不会读到空缓存）',
        tooEarly.join(', '));
    // APK 是异步读，读完要重刷主题
    ok(/ElainaTheme.*applyStored|applyStored\(\)/.test(init),
        '★ bootstrap 后重刷主题（APK 异步读完后不会停在默认主题）');
}

// ============================================================
// 6. index.html 正确引入且顺序正确
// ============================================================
console.log('\n=== 6. index.html 引入顺序 ===');
{
    const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    ok(/<script src="\/js\/store\.js"><\/script>/.test(html), 'index.html 引入了 store.js');
    const storeAt = html.indexOf('/js/store.js');
    // store.js 必须在所有业务脚本之前
    for (const f of ['/js/app-01-core.js', '/js/app-02-data.js', '/js/theme.js', '/js/mods.js']) {
        const at = html.indexOf(f);
        ok(at < 0 || at > storeAt, `store.js 排在 ${f} 之前`);
    }
    // data-sync.js 仍被引用（空壳也要在，否则老 APK 的旧文件不会被覆盖）
    ok(/<script src="\/js\/data-sync\.js"><\/script>/.test(html),
        'data-sync.js 仍被引入（空壳覆盖老 APK 的旧实现）');
}

// ============================================================
// 7. APK 后端：同一个 Store、同一套业务 API
// ============================================================
console.log('\n=== 7. APK 原生后端（用假 Capacitor 验证）===');
{
    const vm = await import('node:vm');
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

    // ① 空盘启动 → 没有数据
    await S.bootstrap();
    ok(S.getItem('elaina_open_settings') === null, 'APK：空盘启动时读不到设置（符合预期）');

    // ② 写入 → 落到"磁盘文件"里
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

    // ④ 业务代码完全不感知平台 —— 断言 store.js 是唯一的判断点
    ok(/isNativePlatform/.test(src['store.js']), 'store.js 内部做平台判断（唯一判断点）');
    const businessFiles = Object.entries(src)
        .filter(([f]) => !['store.js', 'app-01-core.js', 'app-02-data.js', 'app-05-voice.js', 'app-03-agent.js', 'app-06-settings.js'].includes(f))
        .filter(([, t]) => /isNativePlatform/.test(stripComments(t)))
        .map(([f]) => f);
    ok(businessFiles.length === 0,
        '★★ 其它业务文件里没有平台判断（改一处两端都生效）', businessFiles.join(', '));
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
