// 回归检查：「星屑之日」生日模块**已从宿主摘出、改为插件**（mods/birthday）。
//
// ── 这个检查在钉什么 ────────────────────────────────────────────────────
//
//   2026-10 把生日隐藏模式从宿主（web/js/birthday.js + web/css/birthday.css）
//   搬进了插件 mods/birthday/。这次搬迁的意义是"功能可装可卸"，但很容易在
//   搬迁后留下**半截状态**：宿主里还留着旧模块的引用、或者插件缺了某个能力，
//   而生日一年只在 10 月 17 日真正跑一次 —— 平时完全看不出来。所以要常驻检查：
//
//     · 宿主真的**摘干净**了（文件删了、引用没了、主题/存储白名单清了）；
//     · 插件**齐了**（清单 / 入口 / 样式，且用的是那几个新宿主 API）；
//     · 宿主为它补的 4 个能力**都还在**（host.theme / host.storage /
//       host.unlock / app-ready）—— 少一个插件就哑了；
//     · 公告与彩蛋的联动**改走事件**了（宿主不再直接引用 ElainaBirthday）。
//
//   ★ 行为层（真浏览器跑彩蛋/切主题）在搬迁前由旧版这个文件覆盖；插件化之后
//     那部分要么需要一个"装了插件的隔离环境"的浏览器用例，要么交给人工在
//     10.17 当天验 —— 这里只做**源码级**的搬迁完整性检查（快、稳定）。
//
// 用法：node scripts/check-birthday.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const MOD = path.join(ROOT, 'mods', 'birthday');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};
const read = (p) => readFileSync(p, 'utf8');

/** 收尾并退出。
 *  抽成函数是为了让「整节跳过」的分支走同一套收尾逻辑 —— 见第 5 节
 *  （插件不在本地时那一节会提前收尾）。 */
function report() {
    console.log('\n' + '='.repeat(46));
    console.log(`  PASS ${pass}   FAIL ${fail}`);
    console.log('='.repeat(46));
    if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '));
    process.exit(fail ? 1 : 0);
}

/** 去掉注释后的源码 —— 断言"不许再出现 X"时，解释 X 的注释不该算违规
 *  （本项目踩过多次"注释污染判据"，见开发文档） */
const stripComments = (src) => String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const indexHtml = read(path.join(WEB, 'index.html'));
const themeJs = read(path.join(WEB, 'js', 'theme.js'));
const themesCss = read(path.join(WEB, 'css', 'themes.css'));
const storeJs = read(path.join(WEB, 'js', 'store.js'));
const modsJs = read(path.join(WEB, 'js', 'mods.js'));
const appData = read(path.join(WEB, 'js', 'app-02-data.js'));
const appInit = read(path.join(WEB, 'js', 'app-07-init.js'));
const achJs = read(path.join(WEB, 'js', 'achievements.js'));

// 所有宿主前端脚本（用来断言"没有任何一处还在引用旧的 ElainaBirthday"）
const allJs = readdirSync(path.join(WEB, 'js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ name: f, src: read(path.join(WEB, 'js', f)) }));

// ============================================================ 1. 宿主已摘除
console.log('=== 1. 宿主已摘除（旧模块文件 / 引用 / 主题 / 存储白名单）===');
{
    ok(!existsSync(path.join(WEB, 'js', 'birthday.js')), '★ web/js/birthday.js 已删除');
    ok(!existsSync(path.join(WEB, 'css', 'birthday.css')), '★ web/css/birthday.css 已删除');
    ok(!/\/js\/birthday\.js/.test(indexHtml), '★ index.html 不再引入 birthday.js');
    ok(!/\/css\/birthday\.css/.test(indexHtml), '★ index.html 不再引入 birthday.css');
    // 成就是为了"生日纪念"才有的模块，但成就本身是宿主功能 —— 它的样式留在宿主
    ok(/\/css\/achievements\.css/.test(indexHtml),
        '★ 成就样式拆成宿主自己的 css/achievements.css（生日那份随插件走）');

    const offenders = allJs.filter((f) => /ElainaBirthday/.test(stripComments(f.src))).map((f) => f.name);
    ok(offenders.length === 0,
        '★★ 宿主前端脚本里不再有任何 ElainaBirthday 引用（否则旧模块一删就报错）',
        offenders.join(', '));

    // 主题：stardust 不再是内置模板
    const tplIds = [...themeJs.matchAll(/\{\s*id:\s*'(\w+)',\s*name:/g)].map((m) => m[1]);
    ok(!tplIds.includes('stardust'),
        '★★ theme.js 的 TEMPLATES 里已没有 stardust（改由插件 host.theme 注册）', tplIds.join(','));
    ok(!/html\[data-theme-template="stardust"\]\s*\{/.test(themesCss),
        '★★ themes.css 不再定义 stardust 的变量块（避免与插件里的变量出现两份）');

    // 存储：旧键退役、新键上位
    const keysBlock = storeJs.match(/DATA_KEYS\s*=\s*\[[\s\S]*?\]/);
    const keys = keysBlock ? [...keysBlock[0].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
    ok(!keys.includes('elaina_birthday'),
        '★★ DATA_KEYS 里不再有 elaina_birthday（生日状态改住插件的私有命名空间）');
    ok(keys.includes('elaina_mod_storage'),
        '★★ DATA_KEYS 里有 elaina_mod_storage（漏了 → 插件的持久化刷新即丢）');

    // 成就：用户选择"成就留宿主，插件只当触发器" → 三条定义必须还在
    for (const id of ['stardust_day', 'stardust_remembered', 'stardust_makeup']) {
        ok(new RegExp(`id: '${id}'`).test(achJs), `成就留在宿主：仍定义 ${id}`);
    }
}

// ============================================================ 2. 提示词注入改走插件通道
console.log('\n=== 2. 生日补充提示词：宿主不再注入，改由插件 setPromptHint ===');
{
    ok(!/ElainaBirthday/.test(stripComments(appData)), '★ app-02-data.js 不再读 ElainaBirthday.promptHint()');
    ok(/collectPromptHints\(\)/.test(appData),
        '★ 宿主仍保留插件提示词通道（collectPromptHints）—— 生日补充就走它');
}

// ============================================================ 3. 公告 ↔ 彩蛋联动改走事件
console.log('\n=== 3. 公告与开场彩蛋的联动：宿主不再直接引用生日模块 ===');
{
    ok(!/onEggDone/.test(stripComments(appInit)), '★ app-07-init.js 不再用 ElainaBirthday.onEggDone()');
    ok(/announcement-pending/.test(appInit),
        '★ 宿主广播 announcement-pending（"公告将要出现"，生日插件据此推迟彩蛋）');
    ok(/announcement-closed/.test(appData),
        '★ 关闭公告时广播 announcement-closed（在 closeAnnouncement 这个唯一出口里发）');
    ok(!/ElainaBirthday/.test(stripComments(appInit)), '★ app-07-init.js 里没有 ElainaBirthday');
}

// ============================================================ 4. 宿主为它补的 4 个能力
console.log('\n=== 4. 宿主新 API（host.theme / storage / unlock / app-ready）===');
{
    ok(/storage:\s*createModStorage\(/.test(modsJs), '★★ host.storage 已提供（落 data/ 的插件私有存储）');
    ok(/createModStorage\(modId\)/.test(modsJs), '★ 存储按插件 id 分区');
    ok(/theme\(spec\)\s*\{/.test(modsJs), '★★ host.theme(spec) 已提供');
    ok(/useTemplate/.test(modsJs) && /restoreTemplate/.test(modsJs),
        '★★ host.theme 的句柄带 use()/restore()（临时切主题再还原）');
    ok(/unlock\(id,\s*detail\)\s*\{/.test(modsJs), '★★ host.unlock(id, detail) 已提供（触发宿主成就）');
    ok(/markAppReady\(/.test(modsJs), '★★ markAppReady()（init 末尾广播 app-ready）');
    ok(/appReadyFired/.test(modsJs) && /event === 'app-ready' && appReadyFired/.test(modsJs),
        '★★ app-ready 对晚注册的插件会补调（否则慢加载的插件永远等不到启动信号）');

    ok(/function registerTemplate/.test(themeJs), '★ theme.js 有 registerTemplate()');
    ok(/function unregisterTemplate/.test(themeJs), '★ theme.js 有 unregisterTemplate()');
    ok(/function useTemplate/.test(themeJs) && /function restoreTemplate/.test(themeJs),
        '★ theme.js 有 useTemplate()/restoreTemplate()');
    ok(/function allTemplates/.test(themeJs) && /allTemplates\(\)\.some/.test(themeJs),
        '★★ 主题校验走 allTemplates（内置 + 插件注册的），否则插件主题会被判非法回落');
    ok(/:not\(\[data-theme="dark"\]\)/.test(themeJs),
        '★★ 插件主题的注入样式带 :not([data-theme="dark"]) 守卫（否则会盖掉深色块）');
}

// ============================================================ 5. 插件本体就位
//
// ★ 2026-10 起**插件源码不再随仓库分发**（仓库只推软件本体，插件一律走应用内
//   上传安装）。所以本地没有 mods/birthday/ 是**正常状态**，不是缺陷 ——
//   这一节整节跳过，否则每次 npm run check 都会红一片，把真正的回归淹没掉。
//   （第 1~4 节查的是**宿主**那一侧，与插件在不在无关，照常跑到底。）
//   把插件放回 mods/birthday/ 就会自动恢复这一节的断言。
if (!existsSync(path.join(MOD, 'manifest.json'))) {
    console.log('\n=== 5. 插件 mods/birthday 就位：跳过 ===');
    console.log('  本地没有 mods/birthday/ —— 插件已改为应用内安装，源码不再随仓库分发。');
    report();
}
console.log('\n=== 5. 插件 mods/birthday 就位（清单 / 入口 / 样式）===');
{
    const mfPath = path.join(MOD, 'manifest.json');
    ok(existsSync(mfPath), '★ manifest.json 存在');
    let mf = null;
    try { mf = JSON.parse(read(mfPath)); } catch (e) { /* 下面报出来 */ }
    ok(Boolean(mf), '★ manifest.json 是合法 JSON');
    if (mf) {
        ok(mf.id === 'birthday', "★ manifest.id = 'birthday'", String(mf.id));
        ok(mf.entry === 'index.js', '★ entry = index.js', String(mf.entry));
        ok(Array.isArray(mf.styles) && mf.styles.includes('style.css'), '★ styles 声明了 style.css');
        ok(mf.defaultEnabled === false,
            '★ defaultEnabled=false（插件默认关闭：它会在生日当天改动界面，不该在用户不知情时生效）');
    }

    const entryPath = path.join(MOD, 'index.js');
    ok(existsSync(entryPath), '★ index.js 存在');
    const mod = existsSync(entryPath) ? read(entryPath) : '';

    ok(/ElainaMods\.register\(MOD_ID/.test(mod) && /MOD_ID = 'birthday'/.test(mod),
        "★★ 用 ElainaMods.register('birthday') 注册，与 manifest.id 一致");

    // 用的是新 API，而不是宿主私有物
    ok(/host\.theme\(\{/.test(mod), '★★ 用 host.theme 注册「星屑之日」配色');
    ok(/'id':\s*THEME_ID|id:\s*THEME_ID/.test(mod), '★ 主题 id 用 THEME_ID 常量（= stardust）');
    ok(/THEME_ID = 'stardust'/.test(mod), "★ THEME_ID = 'stardust'");
    ok(/theme\.use\(\)/.test(mod) && /theme\.restore\(\)/.test(mod),
        '★★ 切主题 / 还原都用 host.theme 的句柄（不碰用户的主题偏好）');
    ok(/host\.storage\.get\(/.test(mod) && /host\.storage\.set\(/.test(mod),
        '★★ 状态读写走 host.storage（落 data/、跨设备同步）');
    ok(/host\.unlock\('stardust_day'/.test(mod) && /host\.unlock\('stardust_remembered'/.test(mod)
        && /host\.unlock\('stardust_makeup'/.test(mod),
        '★★ 三条纪念成就都用 host.unlock 上报');
    ok(/host\.setPromptHint\(/.test(mod) && /host\.clearPromptHint\(/.test(mod),
        '★★ 生日补充走 setPromptHint（不是生日时 clearPromptHint，日常对话不受影响）');
    ok(/host\.slot\('header\.actions'/.test(mod), '★★ 顶栏蛋糕按钮走 header.actions 插槽');
    ok(/host\.on\('app-ready'/.test(mod), '★★ 等 app-ready 再读盘/启动看门狗');
    ok(/host\.on\('announcement-closed'/.test(mod),
        '★★ 订阅 announcement-closed：首次公告关闭后才演开场彩蛋');
    ok(/host\.require\('elaina-avatar'\)/.test(mod),
        '★ 立绘走 host.require（不自己拼资源路径）；缺失时降级不显示人像');
    ok(!/Store\.(getItem|setItem|removeItem)/.test(mod),
        '★★ 插件不直接用宿主 Store 的读写（只走 host.storage）');

    // 台词与提示词内容：搬迁不能把用户给定的文案弄丢
    ok(mod.includes('今天？……哼，你居然记得。那就特别允许你陪我一天吧。'), '★ 开场台词保留');
    ok(mod.includes('明天我就要继续旅行了。明年今日，如果你还在，也许我会回来。'), '★ 告别台词保留');
    ok(mod.includes('BIRTHDAY_PROMPT'), '★ 生日补充提示词常量在');
    for (const s of ['不是用户的生日', '寿星本人', '蘑菇', '魔女的愿望说出来就不灵了', '仍然完全按角色卡执行']) {
        ok(mod.includes(s), '★ 生日提示词含关键内容「' + s + '」');
    }
    ok(/18\s*岁/.test(mod), '★ 写明 18 岁生日');
    const modCode = stripComments(mod);
    ok(!/【身份与外貌】/.test(modCode) && !/【人格核心】/.test(modCode),
        '★★ 生日补充**不重复**角色卡已有的身份类小节（只出现在解释它的注释里不算）');
    ok(/setInterval\(watchdogTick,\s*15\s*\*\s*1000\)/.test(mod),
        '★ 日期看门狗 15 秒一次（改了系统时间不用重启就能跟上）');
    ok(/addEventListener\('focus'/.test(mod) && /addEventListener\('pageshow'/.test(mod),
        '★★ focus / pageshow 也会立刻对齐（用户报的"改完时间必须重启"就是缺这个）');

    // 样式
    const cssPath = path.join(MOD, 'style.css');
    ok(existsSync(cssPath), '★ style.css 存在');
    const modCss = existsSync(cssPath) ? read(cssPath) : '';
    for (const sel of ['#mainContent { position: relative; }', '.birthday-chat-decor', '.birthday-egg', '.bd-panel', '.birthday-farewell']) {
        ok(modCss.includes(sel), '★ style.css 含 ' + sel);
    }
    ok(/:not\(\[data-theme="dark"\]\)/.test(modCss) || /html\[data-theme="dark"\]/.test(modCss),
        '★ style.css 有深色覆盖（花纹/面板不出现"一块块白"）');
}

report();
