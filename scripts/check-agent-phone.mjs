/**
 * 回归检查：AI 手机操作的能力声明是否真的注入了系统提示词。
 *
 * 背景（真实故障）：执行链路早就完整 ——
 *   标签解析（live2d-video.js 的 handleAgentOperation）
 *   → window.agentActions.agentPhoneOperation
 *   → runAgentPhoneOperation（停止检查 + 风险授权）
 *   → 原生 ElainaDevice.exec
 *   → 结果以「【AI 操作结果】」回灌
 * 但**系统提示词里从来没有告诉模型"你能操作手机"**：
 * LIVE2D_TAG_GUIDE 的【操作标签】只列了 7 个应用内操作，一个 `手机*` 都没有，
 * 文件操作有专门注入、手机操作零注入。模型不知道标签存在 → 永远不输出 →
 * 用户看到的现象就是"AI 好像不能操作手机"。
 *
 * 这类 bug 的可怕之处：**没有任何报错**。链路每一环单独看都是好的，
 * 只有"提示词里有没有这句话"这一条断了，而且断了不影响任何其它功能，
 * 所以既不会被现有检查发现，也不会在手动点界面时暴露。
 *
 * 本检查就盯住三件事：
 *   1. 提示词里必须出现手机操作能力说明（在两条构建路径上都要有）；
 *   2. 能力清单里的每个标签，都必须真的被解析器认识（防止"说了但做不到"）；
 *   3. 未启用时不得声称能操作，且必须明确禁止输出标签（防止模型空谈/编造）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFrontend();
const live2d = readFileSync(path.join(root, 'mods', 'live2d', 'index.js'), 'utf8');
// 标签分发已从 live2d-video.js 移到宿主自有模块（见 web/js/agent-tags.js 的说明）：
// Live2D 是可卸的 mod，不能让它持有全部 [操作:] 的分发权 —— 否则卸掉它
// 就等于 Agent 系统（文件/命令/手机）全体失效。
const tags = readFileSync(path.join(root, 'web', 'js', 'agent-tags.js'), 'utf8');

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond) { pass++; return; }
    failures.push(label + (extra ? `\n      ${extra}` : ''));
}
const has = (haystack, needle) => String(haystack).includes(needle);

/** 按函数名抠出函数体（与 check-model-list.mjs 同一套做法） */
function extractFn(name, src = html) {
    let start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('找不到函数: ' + name + '（重命名了？请同步更新本检查）');
    const asyncMatch = src.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (asyncMatch) start -= asyncMatch[0].length;
    let i = src.indexOf('(', start);
    let paren = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') paren++;
        else if (src[i] === ')') { paren--; if (paren === 0) { i++; break; } }
    }
    let depth = 0;
    i = src.indexOf('{', i);
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

// ---------- 一、能力声明函数存在，且三档分明 ----------
console.log('\n— 能力声明函数 —');
const skillFn = extractFn('agentPhoneSkillText');
ok(skillFn.length > 200, 'agentPhoneSkillText() 存在且不是空壳');

// 没有原生设备层（网页版）→ 必须返回空串，不注入。
// 否则网页版会让模型以为自己能操作手机，然后每次都被拒绝，白烧 token 还骗用户。
ok(/if \(!deviceBridge\(\)\) return '';/.test(skillFn),
    '没有原生设备层（网页版）时不注入能力说明');

// 未启用档：必须明确"不能"+"不要输出标签"
ok(/未启用/.test(skillFn), '有「未启用」这一档');
ok(/不要\*\*输出 \[操作:手机…\] 标签|不要\*\*输出/.test(skillFn) || /不要.{0,4}输出 \[操作:手机/.test(skillFn),
    '未启用时明确禁止模型输出手机标签（否则它会空谈/编造）');
// ★ 位置必须是「能力」，不是「高级」。
//
// 这条曾经钉错：v1.1.0 把「手机操作」从「高级」栏移到了「能力」栏，
// 但代码里 8 处引导文案仍写着「设置 → 高级 → 手机操作」，而**这个检查
// 当时断言的也是那个过时路径** —— 于是测试成了"帮凶"：它把错误的位置
// 固化成"预期"，用户照着找却找不到。现在改为断言正确位置，
// 并**反向排除**旧路径，防止再退回去。
ok(/设置 → 能力 → 手机操作/.test(skillFn), '★ 未启用时引导到正确的位置（能力栏）开启');
ok(!/高级 → 手机操作/.test(skillFn), '★ 不再引用已搬走的「高级 → 手机操作」旧位置');

// 可用档：必须列出真实标签
const phoneTags = [
    '手机状态', '手机查看界面', '手机截图', '手机等待',
    '手机点击', '手机滑动', '手机输入', '手机按键', '手机打开', '手机命令',
    // ★ 2026-10 新增：读取信息 + 工作区文件访问
    '手机应用列表', '手机通知', '手机设备信息', '手机通讯录', '手机日历', '手机短信',
    '手机列出文件', '手机读文件', '手机写文件', '手机删除文件',
];
// ★ 读取信息那六个标签**不是字面量写在 skillFn 里的** —— 它们由
//   phoneReadSkillLines() 在运行时按隐私开关过滤后拼出来。
//   所以判据要分两处看：字面量部分查 skillFn，读取部分查那张过滤表。
//   （只查 skillFn 会误报"提示词漏了"，而实际是它被刻意做成动态的。）
const READ_TAGS = ['手机应用列表', '手机通知', '手机设备信息', '手机通讯录', '手机日历', '手机短信'];
const literalTags = phoneTags.filter((t) => !READ_TAGS.includes(t));
const missingLiteral = literalTags.filter((t) => !has(skillFn, '[操作:' + t));
ok(missingLiteral.length === 0, '可用档列出了全部固定手机操作标签', '缺少: ' + missingLiteral.join('、'));
// 读取标签必须在过滤表里逐项出现（否则开关关掉后清单不会少那一项）
const readFnMatch = html.match(/function phoneReadSkillLines\(\)\s*\{([\s\S]*?)\n\}/);
ok(!!readFnMatch, '找得到 phoneReadSkillLines() 的函数体');
if (readFnMatch) {
    const missingRead = READ_TAGS.filter((t) => !has(readFnMatch[1], "'" + t + "'"));
    ok(missingRead.length === 0, '读取信息清单里列出了全部六项', '缺少: ' + missingRead.join('、'));
}

// ---------- 一之二、能力清单按"实现方式 + 另一路是否可用"区分 ----------
//
// 无障碍后端**做不到**「手机打开」与「手机命令」（原生层明确回失败）。
// 提示词把它俩写成通用能力，就会造成"说了却做不到" —— 模型反复尝试、用户看到一连串失败。
// 这正是要避免的那类问题，所以必须锁住。
//
// ★★ 2026-10（用户要求：「模块」与「无障碍」互通、由 AI 看情况使用）：
//   判据从"是不是无障碍档"升级成"**另一路是否也可用**" —— 原生侧现在会在
//   首选做不到某个动作时自动换路（见 ElainaShellPlugin.accessibilityCannotDo /
//   annotateBackendSwap），所以两路都在时能力面是**并集**：此时再写
//   "⛔ 不支持"会让模型自我审查，明明能做却说做不到——那和原来的毛病一样严重。
//   这里锁两件事：① 并集必须由"另一路 ready"推出（不能写死 true）；
//                ② 另一路不可用时，边界说明必须仍然在。
console.log('\n— 按实现方式与另一路可用性区分能力 —');
ok(/const isAccessibility = backend === 'accessibility'/.test(skillFn),
    '能力清单按实现方式分支（无障碍 / 其它）');
ok(/不支持\*\* \[操作:手机打开\]|不支持.*手机打开/.test(skillFn),
    '另一路不可用时明确说明**不支持**「手机打开」（原生确实做不到）');
ok(/手机命令/.test(skillFn) && /不支持|做不到/.test(skillFn),
    '另一路不可用时明确说明不支持「手机命令」');
// ★ 2026-10：后端收敛为「无障碍 + 模块」，两种措辞都要认：
//   · 互通生效 → "系统会**自动改用「模块」**完成"（模型照常输出标签即可）
//   · 互通不可用 → "换成「模块」方式 / 把「模块」方式配置好"（引导用户去配置）
//   （旧断言写的是 `换成 Shizuku / Root / 模块` —— 那两个后端已删除。）
ok(/自动改用「模块」|换成「模块」方式|改用「模块」方式|把「模块」方式配置好/.test(skillFn),
    '给出可行替代（自动换路，或引导去配置模块）');
ok(/不要重复尝试/.test(skillFn),
    '明确要求模型遇到「不支持」时不要反复重试（否则会刷屏失败）');
// 并集必须由"另一路 ready"决定 —— 写死成 true 就又回到"说了做不到"
ok(/const otherId = isAccessibility \? 'module' : 'accessibility'/.test(skillFn),
    '找得到"另一路"的判据（otherId）');
ok(/otherReady = Boolean\(backendStatus\[otherId\][\s\S]*state === 'ready'/.test(skillFn),
    '★ 并集判据读的是另一路的探测状态（backendStatus），不是写死的 true');
ok(/if \(canOpenAndCommand\) \{[\s\S]*手机打开 包名/.test(skillFn),
    '「手机打开 / 手机命令」只在能力面覆盖到时才列出（互通后是并集）');

// ---------- 一之二之二、运行方式：前台（无障碍）/ 后台（模块）★ 2026-10 ----------
//
// 用户要求：AI 要操作手机时，若**两条路都可用**，应用要弹窗让用户选"前台运行"
// （无障碍，看得见）还是"后台运行"（模块，静默不抢屏幕）。这几条锁住它的关键约定：
console.log('\n— 运行方式弹窗 —');
ok(/function pickPhoneRunMode\(/.test(html), '有 pickPhoneRunMode()（询问运行方式）');
ok(/confirmText: '前台运行'/.test(html) && /altText: '后台运行'/.test(html),
    '★ 弹窗给出「前台运行 / 后台运行」两个明确选项');
// ★ 三键而不是两键：取消键还会被"点遮罩"触发，把"后台"塞进取消位
//   等于用户手指一滑就默默用了后台。所以必须用第三个键承载它。
ok(/altValue: 'module'/.test(html) && /customModalAltBtn/.test(html),
    '★ 用第三个按钮承载「后台运行」（不能塞进取消键：取消还会被点遮罩触发）');
ok(/phoneActionNeedsScreen\(parsed\.action\)/.test(html),
    '只在"要动屏幕"的操作上问（读取信息 / 工作区文件 / 等待不问）');
ok(/if \(!runModeDecision\) \{[\s\S]{0,400}pickPhoneRunMode\(\)/.test(html),
    '★ 一轮只问一次（答案存在 runModeDecision 里，续跑不再问）');
ok(/你没有选择运行方式[\s\S]{0,160}continueLoop: false/.test(html),
    '★ 取消 = 这一步不做：如实回灌且不续跑（绝不替用户选一条）');
ok(/backend: runModeDecision === 'module'/.test(html),
    '本轮选定的运行方式经 exec 的 backend 参数下传（原生据此执行）');
const modeResetFn = extractFn('resetAgentContinueBudget');
ok(/runModeDecision = ''/.test(modeResetFn),
    '★ 每条新用户消息重置运行方式选择（否则整会话只问一次）');
ok(/没有任何可用的实现方式/.test(html),
    '★ 入口闸改成"有没有一条路能用"，不再要求设置里预先选过（否则未预设的用户到不了弹窗）');
ok(/refreshBackendStatus\(\)/.test(html),
    '探测走 refreshBackendStatus（backendStatus 那份只有它会写）');
ok(/系统会先请用户选择/.test(skillFn),
    '★ 提示词明确告诉模型"系统会去问用户"，免得它自己反问或以为要先改设置');
// ★★ 用户反馈"我选了前台，它还是走了模块" —— 根因是"互通自动换路"盖过了显式选择。
ok(/strictBackend: runModeExplicit/.test(html),
    '★ 用户显式选的运行方式要传 strictBackend（原生据此**不**自动换路）');
ok(/前台运行时会直接失败并说明原因/.test(skillFn),
    '★ 提示词改口：选了前台后无障碍做不到的动作会**直接失败**，不再承诺"自动改用模块"');
// 并发：同一条回复里两个动屏操作会并发问两次，而 showCustomModal 是单例 ——
// 第二次调用会覆盖按钮 onclick，第一个 Promise 永不 resolve、那个操作被静默吞掉。
ok(/if \(runModePicker\) return runModePicker/.test(html) && /runModePicker = doPickPhoneRunMode\(\)/.test(html),
    '★ 并发询问必须记忆化（否则第一个操作会永久挂起、静默不执行）');

// ---------- 一之二之三、strict 必须在**原生侧**贯穿全部换路点 ★★ 2026-10 真机修复 ----------
//
// 真实故障（用户真机截图）：在「运行方式」里明确选了**前台运行（无障碍）**，
// 结果回灌的是「启动失败（模块）：exit status 1」—— 走的是模块。
//
// 根因不是前端没传 strict（那条早就有断言，见上面），而是**原生侧 strict 的作用域太窄**：
//   · 当时 `strict` 只写在 `ID_ACCESSIBILITY.equals(preferred)` 这一个分支里；
//   · 而它后面还有**第二个换路点** —— `pickCommandExecutor(preferred)`：
//     preferred 不是 "module" 时会**自动挑选**，而候选列表里只有模块。
//   · 于是 preferred="accessibility" 时，无障碍整个被绕过、一定落到模块上。
// 所以这几条断言盯的是**结构**：strict 必须在进入自动挑选**之前**就分流掉。
//
// ⚠️ 这类 bug 的可怕之处：前端 check 全绿、原生也能编译，只有真机上
//    "用户选的和实际走的不一样"。静态断言是能拦住它的唯一低成本手段。
console.log('\n— strict 语义（原生侧，防"选了前台却走模块"复发）—');
const shellPluginPath = path.join(root, '..', 'android-app', 'android', 'app', 'src', 'main',
    'java', 'com', 'elainachat', 'opensource', 'ElainaShellPlugin.java');
const plugin = readFileSync(shellPluginPath, 'utf8');
/** 抠出 `if (strict) { ... }` 那个块（按花括号配平，避免用正则切歪） */
function extractStrictBlock(src) {
    const start = src.indexOf('if (strict) {');
    if (start < 0) return '';
    let i = src.indexOf('{', start);
    const bodyStart = i;
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(bodyStart, i);
}
const strictBlock = extractStrictBlock(plugin);
ok(strictBlock.length > 200, '原生有 `if (strict) {…}` 显式分流块');
// ★ 核心结构断言：分流必须在 pickCommandExecutor 之前 ——
//   放在后面就等于没放（自动挑选已经把 preferred 吞掉了）。
{
    const strictAt = plugin.indexOf('if (strict) {');
    const pickAt = plugin.indexOf('pickCommandExecutor(preferred)');
    ok(strictAt > 0 && pickAt > 0 && strictAt < pickAt,
        '★★ strict 分流在 pickCommandExecutor **之前**（否则 preferred=accessibility 会被自动挑选吞掉、落到模块）');
}
// strict + 无障碍：必须直接走无障碍（由它如实报"能力边界"），不得换路
ok(/ID_ACCESSIBILITY\.equals\(preferred\)[\s\S]{0,400}return runOnAccessibility\(action, args, false\);/.test(strictBlock),
    '★ strict + 无障碍 → 直接走无障碍（做不到就如实报，不换模块）');
ok(!/runOnCommandBackend\(moduleExecutor/.test(strictBlock.split('ID_MODULE.equals(preferred)')[0]),
    '★ strict + 无障碍的分支里**不得**出现 runOnCommandBackend(moduleExecutor)（那就是偷偷换路）');
// strict + 模块：不可用时必须明确失败，且说明"不会改用无障碍"
ok(/ID_MODULE\.equals\(preferred\)[\s\S]{0,500}return failure\(/.test(strictBlock),
    '★ strict + 模块但不可用 → 明确失败（不静默回落无障碍）');
ok(/不会\*\*改用无障碍|不会.*改用无障碍/.test(strictBlock),
    '★ 失败文案说明"不会改用无障碍"（否则用户以为它在乱换路）');
// strict + 未知值：不猜、不兜底
ok(/运行方式参数无法识别/.test(strictBlock),
    '★ strict + 无法识别的 preferred → 如实报错，不猜一个后端跑');
// ★ 中文输入那条"按动作挑最优后端"也必须让位给显式选择 ——
//   用户选了后台（模块），却被这条送去无障碍，同样是"选的和走的不一样"。
//   （模块的 vd type 本来就支持中文，这个兜底对模块并不需要。）
ok(/if \(!strict\s*[\s\S]{0,220}"手机输入"\.equals\(action\)/.test(plugin),
    '★ 中文输入的"改走无障碍"兜底带 !strict（显式选了后台就不该被改到前台）');
// 非 strict 路径的"互通自动换路"必须保留 —— 别为了修 strict 把它一起删了
ok(/if \(accessibilityCannotDo\(action, args\) && moduleExecutor\.available/.test(plugin),
    '★ 非 strict（没弹窗 / 只一条路可用）时的互通自动换路仍然保留');
ok(/annotateBackendSwap\(/.test(plugin),
    '★ 换路仍在结果里注明"本次已自动改用…"（可排查性）');

// ---------- 一之二之四、「看画面」按钮的判据 ★★ 2026-10 真机修复 ----------
//
// 与上面那个原生 bug 叠加、把排查方向带偏的第二个问题：
// 状态条上「看画面」的出现判据原来是 `currentBackendId() === 'module' || used === 'module'`。
// 前者读的是**设置里持久化的默认方式**（用户临时选前台，它照样是 module），
// 后者是**上一轮**用过的后端且从不重置（历史上走过一次模块，之后每轮都亮）。
// 两个都往"显示模块"的方向错 → 用户明明选了前台却看到"看画面"，判定"它在偷偷走模块"。
console.log('\n— 「看画面」按钮判据 —');
{
    // ⚠️ 必须**限定在 agentRuntime 的 IIFE 里**再抠 render()。
    //   直接 extractFn('render', html) 会抓到 achievements.js 里那个同名的
    //   render()（它在加载顺序上更靠前）—— 断言就会在一个毫不相干的函数上做匹配，
    //   而且是"假失败"（我第一版就是这么写的，两条红）。
    const rtStart = html.indexOf('const agentRuntime = (function ()');
    const rtEnd = html.indexOf('window.agentRuntime = agentRuntime;');
    const rtSrc = (rtStart >= 0 && rtEnd > rtStart) ? html.slice(rtStart, rtEnd) : '';
    ok(rtSrc.length > 0, '找得到 agentRuntime 的 IIFE（抠 render 的范围）');
    const renderFn = rtSrc ? extractFn('render', rtSrc) : '';
    ok(renderFn.length > 100, '在 agentRuntime 里抠到 render()');
    ok(/runModeDecision/.test(renderFn),
        '★★ 「看画面」读的是**本轮**的 runModeDecision（不是持久化的默认方式）');
    ok(!/currentBackendId\(\) === 'module'\)/.test(renderFn),
        '★ 不再用 `currentBackendId() === module` 当判据（那会把默认方式当成当前方式）');
    ok(/effective === 'module'/.test(renderFn),
        '★ 最终判据收敛到一个 effective 值再比 module');
    const resetFn2 = extractFn('resetAgentContinueBudget');
    ok(/window\.__lastAgentBackend = ''/.test(resetFn2),
        '★★ 每轮重置 __lastAgentBackend（否则上一轮走过模块会让这一轮一直显示"看画面"）');
}

// ---------- 一之三、读取信息受隐私开关控制（★ 2026-10 新增）----------
//
// 用户要求："如果不想让 ai 知道太多信息请关闭对应权限"。
// 光在设置里放开关不够 —— 提示词也必须**按开关过滤**，
// 否则模型仍会输出标签、每步都被拒绝，用户看到的是一串失败。
console.log('\n— 隐私开关 —');
ok(/function phoneReadSkillLines\(/.test(html),
    '有 phoneReadSkillLines()（按隐私开关过滤能力清单）');
ok(/phoneReadAllowed\(x\.action\)/.test(html),
    '读取信息清单逐项按开关过滤');
ok(/function phoneReadAllowed\(/.test(html), '有 phoneReadAllowed() 判据');
ok(/function phoneReadBlockedReason\(/.test(html),
    '有 phoneReadBlockedReason()（执行层的第二道闸）');
ok(/const PHONE_READ_OPS = \[/.test(html), '有 PHONE_READ_OPS 清单');
ok(/phoneReadBlockedReason\(parsed\.action\)/.test(html),
    '★ runAgentPhoneOperation 里真的用了第二道闸（光有函数不算）');
// 六个开关都要在设置界面里存在（应用层开关）
for (const id of ['settingAgentReadApps', 'settingAgentReadNotifications', 'settingAgentReadDevice',
    'settingAgentReadSms', 'settingAgentReadContacts', 'settingAgentReadCalendar']) {
    ok(has(html, id), `设置界面有隐私开关 ${id}`);
}
ok(/不想让 AI 知道太多信息/.test(html),
    '★ 设置界面明确提示"不想让 AI 知道太多信息就关掉"（用户点名要的那句话）');

// ---------- 二、注入点：两条构建路径都要有 ----------
console.log('\n— 注入点 —');
const layered = extractFn('buildLayeredRoleplayMessages');
const legacy = extractFn('buildLegacyRoleplayMessages');
ok(/agentPhoneSkillText\(\)/.test(layered), '分层版（layered-v2）注入了手机操作能力');
ok(/agentPhoneSkillText\(\)/.test(legacy),
    '回滚版（legacy-v1）也注入了 —— 只补一边会让切回 legacy 后"又不能操作手机了"');

// ---------- 三、说的必须做得到：清单里的标签解析器都认识 ----------
//
// 这一条是本检查最有价值的部分：提示词与解析器是两处独立维护的清单，
// 任何一边加/改标签而另一边没跟上，都会造成"AI 照做了却没人接"。
console.log('\n— 清单与解析器一致 —');
// ★ 提取方式：原来用的是 `const AGENT_PHONE_OPS = [...]` 这一段里的**所有**
//   单引号字符串。2026-10 加了注释与分组后，注释里出现的 `手机短信` 之类
//   也会被这个正则抓进来（注释里写标签名是刻意的，便于对照），
//   于是"解析器认识"的判据会被注释污染。所以这里先剥掉注释再抓。
const opsMatch = html.match(/const AGENT_PHONE_OPS = \[([\s\S]*?)\];/);
ok(!!opsMatch, '找得到 AGENT_PHONE_OPS（解析器认识的标签清单）');
if (opsMatch) {
    // 去掉 // 行注释与 /* */ 块注释，避免注释里的标签名被当成真实条目
    const bodyNoComments = opsMatch[1]
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    const parsed = [...bodyNoComments.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const notParsed = phoneTags.filter((t) => !parsed.includes(t));
    ok(notParsed.length === 0,
        '提示词里承诺的每个标签，解析器都认识', '解析器不认识: ' + notParsed.join('、'));
    // 提示词那一侧：固定标签查 skillFn，读取标签查过滤表（见上面的说明）
    const notAdvertised = parsed
        .filter((t) => !READ_TAGS.includes(t))
        .filter((t) => !has(skillFn, '[操作:' + t));
    const readNotAdvertised = READ_TAGS
        .filter((t) => parsed.includes(t))
        .filter((t) => !(readFnMatch && has(readFnMatch[1], "'" + t + "'")));
    const allMissing = notAdvertised.concat(readNotAdvertised);
    ok(allMissing.length === 0,
        '解析器认识的每个标签，提示词里都告知了模型', '提示词漏了: ' + allMissing.join('、'));
}

// 每个标签都要有风险分级，否则 requestApproval 拿不到级别（会当 safe 放行）
const riskMatch = html.match(/const AGENT_RISK = \{([\s\S]*?)\};/);
ok(!!riskMatch, '找得到 AGENT_RISK（风险分级表）');
if (riskMatch && opsMatch) {
    const bodyNoComments = opsMatch[1]
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    const parsed = [...bodyNoComments.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const ungraded = parsed.filter((t) => !has(riskMatch[1], "'" + t + "'"));
    ok(ungraded.length === 0, '每个手机操作都有风险分级', '缺分级: ' + ungraded.join('、'));
}

// ---------- 四、分发链路的每一环都还在 ----------
//
// 这几环任一断掉，提示词写得再全也没用。它们分散在两个文件里，最容易在重构时被拆散。
console.log('\n— 分发链路 —');
ok(/window\.agentActions\s*=\s*\{/.test(html), '主应用定义了 window.agentActions');
ok(/agentPhoneOperation\(raw\)/.test(html), 'agentActions 上有 agentPhoneOperation');
ok(/async function runAgentPhoneOperation\(/.test(html), 'runAgentPhoneOperation 存在');
// 判据行与调用行是分开的两句：`if (window.agentActions?.agentPhoneOperation)` 之后
// 才 `window.agentActions.agentPhoneOperation(v)` —— 断言要认这个真实形状。
//
// ★ 分发位置已变：从 live2d-video.js 移到 web/js/agent-tags.js。
//   断言新位置，并确认 Live2D 那侧**不再**持有手机分支（解耦的判据）。
ok(/agentPhoneOperation/.test(tags) && /callAction\('agentPhoneOperation'/.test(tags),
    'agent-tags.js 会把 [操作:手机…] 转发给主应用');
ok(/\^\(手机\|设备\)/.test(tags), 'agent-tags.js 的转发判据认得「手机」前缀');
ok(!/\^\(手机\|设备\)/.test(live2d),
    '★ live2d-video.js 不再持有手机分发（Live2D 卸掉不影响手机操作）');
// ★ 注解的**写法**不该被这条断言锁死：2026-10 给 @CapacitorPlugin 加了
//   permissions 段之后它变成了多行形式，而旧正则只认单行
//   `@CapacitorPlugin(name = "ElainaDevice")` —— 于是"名字一致"这条
//   因为排版变了而假失败。判据应该只关心**名字**，所以用 \s* 容忍换行。
ok(/ElainaDevice/.test(html) && /@CapacitorPlugin\(\s*name\s*=\s*"ElainaDevice"/.test(
    readFileSync(path.join(root, '..', 'android-app', 'android', 'app', 'src', 'main', 'java',
        'com', 'elainachat', 'opensource', 'ElainaShellPlugin.java'), 'utf8')),
    '原生插件名与前端查找的名字一致（ElainaDevice）');
ok(/registerPlugin\(ElainaShellPlugin\.class\)/.test(
    readFileSync(path.join(root, '..', 'android-app', 'android', 'app', 'src', 'main', 'java',
        'com', 'elainachat', 'opensource', 'MainActivity.java'), 'utf8')),
    'MainActivity 注册了原生插件（没注册就永远拿不到设备层）');

// ---------- 五、静态标签指南不得把手机操作说成"总是可用" ----------
console.log('\n— 不产生误导 —');
// ★ 2026-10 改动（方案 A 拆分）：常量从 `LIVE2D_TAG_GUIDE` 改名为
//   `HOST_ACTION_TAG_GUIDE`，且**只留宿主自己就能执行的操作 + 定时任务** ——
//   表现类（情绪/表情/动作/位置/大小/背景 + 静音/水印）搬进了 live2d mod，
//   走 host.setPromptHint 注入。手机标签的"可用性随设备变化"这条要求
//   仍然落在宿主这一段上（它本来就在宿主的指南里，不在 Live2D 那段）。
const guideMatch = html.match(/const HOST_ACTION_TAG_GUIDE = `([\s\S]*?)`;/);
ok(!!guideMatch, '找得到 HOST_ACTION_TAG_GUIDE（宿主操作标签指南）');
if (guideMatch) {
    // 静态指南里不该直接列出手机标签（它的可用性随设备/设置变化，由动态注入负责说）
    ok(!/\[操作:手机点击\]/.test(guideMatch[1]),
        '静态指南没有把手机标签写成"总是可用"（可用性随设备变化，交给动态注入）');
    ok(/系统会单独告知/.test(guideMatch[1]),
        '静态指南说明了手机/文件操作由系统单独告知（避免模型凭这里猜）');
}
// ★ 反向断言：表现类标签**不得**再出现在宿主的指南里
//   （它们已是 live2d mod 的职责；留在这里就等于"卸掉插件后模型还在被要求输出
//     没人执行的标签" —— 那正是本次拆分要根治的问题）。
{
    const hostGuide = guideMatch ? guideMatch[1] : '';
    ok(!/\[情绪:开心/.test(hostGuide),
        '★ 宿主指南里不再列表现类情绪标签（已搬进 live2d mod 的 setPromptHint）');
    ok(!/\[表情:happy/.test(hostGuide),
        '★ 宿主指南里不再列表情标签（同上）');
    ok(!/\[背景:深蓝/.test(hostGuide),
        '★ 宿主指南里不再列背景标签（同上）');
    // 定时任务必须留下：它是宿主能力，跟 Live2D 无关
    ok(/\[任务:/.test(hostGuide),
        '★ 定时任务标签留在宿主（否则关掉 Live2D 就没法定时提醒）');
    // 宿主自己执行的三个动作也要留
    for (const act of ['打开视频通话', '结束通话', '整理记忆']) {
        ok(hostGuide.includes('[操作:' + act + ']'), `★ 宿主动作「${act}」留在宿主指南里`);
    }
}
// live2d mod 侧：表现指南必须真的通过 setPromptHint 注入
{
    const l2d = readFileSync(path.join(root, 'mods', 'live2d', 'index.js'), 'utf8');
    ok(/host\.setPromptHint\(/.test(l2d),
        '★★ live2d mod 用 host.setPromptHint 注入表现指南（停用即自动摘除）');
    ok(/LIVE2D_PRESENTATION_GUIDE/.test(l2d), 'live2d mod 里有表现指南常量');
    ok(/\[情绪:开心/.test(l2d) && /\[表情:happy/.test(l2d),
        '★ 情绪/表情标签已搬到 live2d mod');
    ok(/\[操作:静音\]/.test(l2d) && /\[操作:隐藏水印\]/.test(l2d),
        '★ 静音/水印（本插件独有的两个操作）也在它的指南里');
    // 水印提示只在模型确实有开关时才加（否则教 AI 输出无效标签）
    ok(/if \(watermarkExp\)/.test(l2d),
        '★ 水印段是条件注入（模型没有水印开关就不提）');
}

console.log(`\n手机 Agent 能力声明检查：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
}
