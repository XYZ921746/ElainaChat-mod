/**
 * strict（显式运行方式）路由的**决策表**验证。
 *
 * 为什么要有它：这次的真机 bug（选了前台却走模块）本质是**原生路由的分支顺序**错了。
 * 单纯的结构断言（"strict 块必须在 pickCommandExecutor 之前"）只能证明
 * "分流没被吞掉"，证明不了"每种输入真的落到哪条路" —— 尤其是
 * 「中文输入兜底」与 strict 的相互作用，那是第二个独立的换路点。
 *
 * ⚠️⚠️ 本文件的 route() 是**手写的逻辑镜像**，不是从 .java 里执行真实代码
 *     （Java 没法在 Node 里跑）。这类镜像最大的风险是**漂移**：
 *     源码改了、镜像没改，于是它一直"通过"，给出虚假的安全感 ——
 *     这正是本项目多处注释警告过的"测试里抄一份、实现改了两边不一致"。
 *
 *     所以它配了三道防漂移措施（缺一不可）：
 *       ① 抠不到 runAction / pickCommandExecutor 就**直接报错退出**，不静默通过；
 *       ② 下面有一组「结构性同步断言」：源码里每个分支必须仍在，
 *          且镜像里认得的关键字/条件都在源码里出现过；
 *       ③ route() 每个分支都标注了它对应的源码条件（见函数内注释）。
 *
 *     换句话说：本文件的价值是**把决策表写成可执行的文档**，
 *     真正的回归防线是 check-agent-phone.mjs 里那组盯源码结构的断言。
 *     两者互补 —— 这里的断言若变红，先怀疑镜像漂移，别急着改实现。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = readFileSync(path.join(root, '..', 'android-app', 'android', 'app', 'src', 'main',
    'java', 'com', 'elainachat', 'opensource', 'ElainaShellPlugin.java'), 'utf8');

let pass = 0;
const fails = [];
const ok = (c, label, extra) => { if (c) pass++; else fails.push(label + (extra ? ' — ' + extra : '')); };

// ---------- 抠出 runAction 的决策段 ----------
const runStart = plugin.indexOf('private JSObject runAction(');
const runEnd = plugin.indexOf('private ShellBackends.Executor pickCommandExecutor(');
if (runStart < 0 || runEnd < runStart) {
    console.error('抠不到 runAction —— 函数签名改了？请同步更新本检查');
    process.exit(1);
}
const runBody = plugin.slice(runStart, runEnd);

// strict 块的位置必须早于 pickCommandExecutor 调用（结构断言，与 check-agent-phone 同源但这里更严）
const strictIdx = runBody.indexOf('if (strict) {');
const pickIdx = runBody.indexOf('pickCommandExecutor(preferred)');
ok(strictIdx > 0, 'runAction 里有 if (strict) 分流块');
ok(pickIdx > 0, 'runAction 里仍在调 pickCommandExecutor');
ok(strictIdx < pickIdx, '★ strict 分流早于 pickCommandExecutor（核心结构）', `strict@${strictIdx} pick@${pickIdx}`);

// ---------- 防漂移：镜像里认得的每个条件，源码里必须都还在 ----------
//
// 这一组是**给本文件自己**的体检：route() 依赖若干源码事实，
// 任何一条在源码里消失/改名，route() 就不再是源码的镜像了 —— 那时必须报错，
// 而不是继续拿旧镜像给出"通过"。
console.log('\n— 镜像与源码同步（防漂移）—');
{
    const facts = [
        [/if \(strict\) \{/, 'strict 分流块'],
        [/ID_ACCESSIBILITY\.equals\(preferred\)[\s\S]{0,400}runOnAccessibility\(action, args, false\);/, 'strict+无障碍 → 直接走无障碍'],
        [/ID_MODULE\.equals\(preferred\)/, 'strict+模块 分支'],
        [/运行方式参数无法识别/, 'strict+未知值 → 如实报错'],
        [/if \(!strict\s*[\s\S]{0,220}"手机输入"\.equals\(action\)/, '中文输入兜底带 !strict（route 的 ① 依赖它）'],
        [/if \(accessibilityCannotDo\(action, args\) && moduleExecutor\.available/, '非 strict 的互通换路（route 的 ③ 依赖它）'],
        [/ShellBackends\.Executor\[\] order = \{ moduleExecutor \}/, '自动挑选的候选只有模块（route 的 ④ 依赖它）'],
    ];
    for (const [re, label] of facts) {
        ok(re.test(plugin), `源码仍具备：${label}`);
    }
    // route() 镜像里引用的动作名也必须与原生 accessibilityCannotDo 的清单一致 ——
    // 原生一旦新增"无障碍做不到"的动作，route() 的 cannotDo 就该跟着加。
    const cannotDoBlock = plugin.slice(
        plugin.indexOf('private static boolean accessibilityCannotDo('),
        plugin.indexOf('private static JSObject annotateBackendSwap('));
    const mirrored = ['手机打开', '手机命令'];
    for (const act of mirrored) {
        ok(cannotDoBlock.includes('"' + act + '"'),
            `镜像里当作"无障碍做不到"的「${act}」仍在原生清单里`);
    }
    // 反向：原生清单里除了 按键（有条件）之外，不该有第三个 route() 不知道的动作
    const nativeCases = [...cannotDoBlock.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
    const unknown = nativeCases.filter((a) => !mirrored.includes(a) && a !== '手机按键');
    ok(unknown.length === 0,
        '★ 原生"无障碍做不到"清单没有 route() 不知道的新动作（有的话请同步镜像的 cannotDo）',
        '未同步: ' + unknown.join('、'));
}

/**
 * 模拟 runAction 的路由决策。
 *
 * 返回 'accessibility' | 'module' | 'fail' | 'auto:<id>'。
 * 逻辑严格对照抠出来的源码分支顺序 —— 每一步都标了对应的源码条件。
 */
function route({ action, args, preferred, strict, accRunning, modAvailable }) {
    // ① 中文输入的"改走无障碍"兜底（源码：if (!strict && 手机输入 && !ascii && acc.isRunning())）
    if (!strict && action === '手机输入' && /[^\x00-\x7F]/.test(args) && accRunning) {
        return 'accessibility';
    }
    // ② strict 分流（源码：if (strict) {...}）
    if (strict) {
        if (preferred === 'accessibility') return 'accessibility';      // 做不到也如实报，不换路
        if (preferred === 'module') return modAvailable ? 'module' : 'fail';
        return 'fail';                                                   // 未知值：不猜
    }
    // ③ preferred 是无障碍（源码：if (ID_ACCESSIBILITY.equals(preferred))）
    if (preferred === 'accessibility') {
        const cannotDo = ['手机打开', '手机命令'].includes(action);
        if (cannotDo && modAvailable) return 'auto:module';               // 互通自动换路
        return 'accessibility';
    }
    // ④ 自动挑选（源码：pickCommandExecutor → 候选只有 module）
    if (modAvailable) return 'module';
    return accRunning ? 'accessibility' : 'fail';                         // 兜底走无障碍
}

// ---------- 场景 ----------
console.log('\n— strict + 无障碍（用户选了"前台运行"）—');
{
    // ★ 这次真机故障的核心场景：手机打开（无障碍做不到）→ 必须落到无障碍并如实报错
    const r = route({ action: '手机打开', args: 'tv.danmaku.bili', preferred: 'accessibility', strict: true, accRunning: true, modAvailable: true });
    ok(r === 'accessibility', '★★ 「手机打开」+ 选前台 → 走无障碍（如实报"做不到"），**不**换模块', `实际=${r}`);
    const r2 = route({ action: '手机命令', args: 'ls', preferred: 'accessibility', strict: true, accRunning: true, modAvailable: true });
    ok(r2 === 'accessibility', '★★ 「手机命令」+ 选前台 → 走无障碍（不换模块）', `实际=${r2}`);
    const r3 = route({ action: '手机点击', args: '100 200', preferred: 'accessibility', strict: true, accRunning: true, modAvailable: true });
    ok(r3 === 'accessibility', '「手机点击」+ 选前台 → 无障碍', `实际=${r3}`);
    const r4 = route({ action: '手机查看界面', args: '', preferred: 'accessibility', strict: true, accRunning: true, modAvailable: true });
    ok(r4 === 'accessibility', '「手机查看界面」+ 选前台 → 无障碍', `实际=${r4}`);
}

console.log('\n— strict + 模块（用户选了"后台运行"）—');
{
    const r = route({ action: '手机点击', args: '1 2', preferred: 'module', strict: true, accRunning: true, modAvailable: true });
    ok(r === 'module', '「手机点击」+ 选后台 → 模块', `实际=${r}`);
    // ★ 中文输入绝不能被"改走无障碍"的兜底抢走（用户选了后台，就该在副屏上打字）
    const r2 = route({ action: '手机输入', args: '你好世界', preferred: 'module', strict: true, accRunning: true, modAvailable: true });
    ok(r2 === 'module', '★★ 中文输入 + 选后台 → 仍走模块（不被"改走无障碍"兜底抢走）', `实际=${r2}`);
    const r3 = route({ action: '手机点击', args: '1 2', preferred: 'module', strict: true, accRunning: true, modAvailable: false });
    ok(r3 === 'fail', '★ 选后台但模块不可用 → 明确失败（不静默回落无障碍）', `实际=${r3}`);
}

console.log('\n— 非 strict（没弹窗：只一条路可用 / 设置里的默认方式）—');
{
    // 互通自动换路必须保留 —— 别为了修 strict 把它一起删了
    const r = route({ action: '手机打开', args: 'pkg', preferred: 'accessibility', strict: false, accRunning: true, modAvailable: true });
    ok(r === 'auto:module', '★ 非 strict + 无障碍做不到 + 模块可用 → 自动换模块（互通仍生效）', `实际=${r}`);
    const r2 = route({ action: '手机点击', args: '1 2', preferred: 'accessibility', strict: false, accRunning: true, modAvailable: true });
    ok(r2 === 'accessibility', '非 strict + 无障碍做得到 → 走无障碍（不无谓换路）', `实际=${r2}`);
    // 非 strict 时中文输入仍走无障碍（命令族不支持非 ASCII）
    const r3 = route({ action: '手机输入', args: '中文', preferred: 'accessibility', strict: false, accRunning: true, modAvailable: true });
    ok(r3 === 'accessibility', '非 strict + 中文输入 → 无障碍（原来的兜底仍在）', `实际=${r3}`);
    const r4 = route({ action: '手机点击', args: '1 2', preferred: 'module', strict: false, accRunning: false, modAvailable: true });
    ok(r4 === 'module', '非 strict + 默认模块 → 模块', `实际=${r4}`);
}

console.log('\n— 回归护栏：这些必须**不**发生 —');
{
    // 把旧 bug 的结论显式写成"不应出现"的断言，任何人改回旧结构都会在这里炸
    const r = route({ action: '手机打开', args: 'pkg', preferred: 'accessibility', strict: true, accRunning: true, modAvailable: true });
    ok(r !== 'module' && r !== 'auto:module',
        '★★ 选前台 + 无障碍做不到 → 绝不落到模块（这正是真机上那个 bug）', `实际=${r}`);
    const r2 = route({ action: '手机输入', args: '中文', preferred: 'module', strict: true, accRunning: true, modAvailable: true });
    ok(r2 !== 'accessibility',
        '★★ 选后台 + 中文输入 → 绝不被改到无障碍', `实际=${r2}`);
}

console.log(`\nstrict 路由检查：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
    console.log('\n失败项：');
    fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
}
