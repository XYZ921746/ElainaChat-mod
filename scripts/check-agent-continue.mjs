/**
 * 回归检查：Agent 操作完成后自动续跑（不用用户手动说"继续"）。
 *
 * 背景（真实故障）：AI 读取/写入文件后就不动了，必须用户打一句"继续"才走下一步。
 *
 * 根因是一个**不对称**：
 *   · 失败路径 explainAgentFailure() 会调 callAI() —— AI 能自己解释并重试；
 *   · 成功路径只 insertAgentResult() 把结果塞进对话，**从不调 callAI()** ——
 *     AI 看不到"我刚做完的事"，自然不会有下一步。
 *
 * 日志铁证：执行完 `[操作:保存文件 D:\桌面\测试.txt|测试文件]` 之后，
 * 下一次请求的末条消息是 **user（244 字）**，也就是用户手动打的那句"继续"。
 *
 * 这个修复有三个容易写错的地方，本检查逐条锁住：
 *   1. **死循环**：续跑到上限时若用 insertAgentResult 插提示，会再次触发续跑 →
 *      又到上限 → 无限循环。（实现时先踩了一次。）
 *   2. **预算不重置**：不重置就是"整个页面会话共享 8 步"，用完后永远不再续跑，
 *      表现为"第一次能用、后面又不动了"——比原 bug 更难查。
 *   3. **提前收尾**：drive() 里的操作是异步的，若靠"等一下看定时器"判断有没有后续，
 *      会误判成"AI 已收尾"而提前 endRun，把多步任务腰斩。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFrontend();

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond) { pass++; return; }
    failures.push(label + (extra ? `\n      ${extra}` : ''));
}

/** 按函数名抠出函数体 */
function extractFn(name) {
    let start = html.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('找不到函数: ' + name + '（重命名了？请同步更新本检查）');
    const am = html.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (am) start -= am[0].length;
    let i = html.indexOf('(', start);
    let paren = 0;
    for (; i < html.length; i++) {
        if (html[i] === '(') paren++;
        else if (html[i] === ')') { paren--; if (paren === 0) { i++; break; } }
    }
    let d = 0;
    i = html.indexOf('{', i);
    for (; i < html.length; i++) {
        const c = html[i];
        if (c === '{') d++;
        else if (c === '}') { d--; if (d === 0) { i++; break; } }
    }
    return html.slice(start, i);
}

// ---------- 一、成功路径必须触发续跑 ----------
console.log('\n— 成功路径触发续跑 —');
const insertFn = extractFn('insertAgentResult');
ok(/options\.continueLoop === true/.test(insertFn),
    'insertAgentResult 默认**不**续跑，只有显式 continueLoop:true 才续跑');
ok(/scheduleAgentContinue\(\)/.test(insertFn),
    'insertAgentResult 里确实会触发续跑（这是原 bug 的修复点）');

// 这个函数是 18 处调用的公共收口，其中大多数是「无权限 / 未启用 / 用户取消」这类
// **被拒绝**的结果。它们若也触发续跑，就变成"被拒绝 → 续跑 → 又试 → 又被拒绝"的
// 无效循环，用户看到 AI 对着做不到的事反复尝试。所以必须是"选择加入"而非"选择退出"。
// 统计**真实调用**（排除注释行与函数定义里的说明）
//
// 判据是「**白名单**」而不是「数量等于 N」：
// 数量断言会误伤新加的合法成功路径（例如 2026-09 新增的电脑命令成功处），
// 而且它挡不住"把一处合法调用换成一处非法调用、数量不变"这种改动。
// 白名单同时解决这两点：新路径必须显式登记（逼作者想清楚"这算不算做完了"），
// 非法路径无论怎么换数量都过不了。
const ALLOWED_CONTINUE_SITES = [
    { re: /insertAgentResult\(resultText, \{ continueLoop: true \}\)/, label: '文件操作成功' },
    { re: /insertAgentResult\(opResult, \{ continueLoop: true \}\)/, label: '手机操作成功' },
    { re: /insertAgentResult\('命令执行结果：\\n' \+ text, \{ continueLoop: true \}\)/, label: '电脑命令成功' },
];
const continueLines = html.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .filter((l) => /insertAgentResult\(.*continueLoop: true/.test(l));
const unregistered = continueLines.filter((l) => !ALLOWED_CONTINUE_SITES.some((s) => s.re.test(l)));
ok(unregistered.length === 0,
    '开启续跑的调用点全部在白名单内（新增成功路径需显式登记）',
    unregistered.length ? '未登记：\n      ' + unregistered.map((l) => l.trim()).join('\n      ') : '');
// 反向：白名单里每一条都必须真的还在（防止被删掉后白名单变成空保护）
const missing = ALLOWED_CONTINUE_SITES.filter((s) => !continueLines.some((l) => s.re.test(l)));
ok(missing.length === 0,
    '白名单里的成功路径都还在（文件 / 手机 / 电脑命令）',
    missing.length ? '缺失：' + missing.map((s) => s.label).join('、') : '');
ok(continueLines.length === ALLOWED_CONTINUE_SITES.length,
    `续跑调用点数量与白名单一致（${ALLOWED_CONTINUE_SITES.length} 处）`,
    `实际 ${continueLines.length} 处`);
ok(/insertAgentResult\(resultText, \{ continueLoop: true \}\)/.test(html),
    '文件操作成功处开启续跑');
// 手机操作成功处：结果先落进变量（为了同时记进「回合过程」的工具调用行），
// 再插进对话并续跑 —— 断言语义（成功结果 + continueLoop）而不是某一种写法。
ok(/const opResult = await execPhoneOperation\(parsed\);/.test(html)
    && /insertAgentResult\(opResult, \{ continueLoop: true \}\)/.test(html),
    '手机操作成功处开启续跑');
// 被拒绝/失败类的结果**不能**开启续跑
ok(!/已跳过[^)]*continueLoop: true/.test(html), '「已跳过」类结果不续跑');
ok(!/已取消写入[^)]*continueLoop: true/.test(html), '「已取消写入」不续跑');
ok(!/操作失败[^)]*continueLoop: true/.test(html), '失败说明不续跑');

// ---------- 二、死循环防护（★ 2026-10 由"步数上限"改成"连续无进展熔断"）----------
//
// ★★ 用户要求"取消 8 步限制改为无限制"，于是把硬性步数上限**删掉**，
//   换成"连续 N 步没做成任何事就熔断"。这是同一件事的两个判据：
//     · 步数上限   → 一件正常的长任务会被腰斩（几十步本来就是正常的）；
//     · 无进展熔断 → 只钉住"反复失败"这种情况（继续下去也只是重复失败）。
//   最关键的回归项仍然是：熔断时插入的提示**不能**再触发续跑。
console.log('\n— 死循环防护（无进展熔断）—');
const loopFn = extractFn('continueAgentLoop');
ok(!/AGENT_CONTINUE_MAX_STEPS/.test(html), '★ 旧的 8 步硬上限已彻底移除（用户要求无限制）');
ok(/AGENT_STALL_FUSE/.test(loopFn), '续跑有"连续无进展"熔断');
// 默认就是"不续跑"，所以熔断提示无需显式传参也不会递归 ——
// 但仍要确认熔断分支里没有误开续跑。
const capBlock = loopFn.match(/if \(agentStalledSteps >= AGENT_STALL_FUSE\)[\s\S]*?\n {8}\}/);
ok(!!capBlock, '找得到熔断分支');
ok(!!capBlock && !/continueLoop: true/.test(capBlock[0]),
    '熔断时的提示不开启续跑（否则"熔断→插提示→又调度→又熔断"无限循环）');
ok(!!capBlock && /\breturn;/.test(capBlock[0]),
    '熔断后立即 return（不再发起请求）');
ok(!!capBlock && /rt\.endRun\(\)/.test(capBlock[0]),
    '熔断时收起运行状态条（否则状态条会一直挂着）');
// 计数必须按"有没有进展"记 —— 若改成按步数累加，就等于把上限又装回去了
// （insertFn 已在上面第 61 行取过，这里直接复用，别再声明一次）
ok(/agentStalledSteps = 0/.test(insertFn) && /agentStalledSteps \+= 1/.test(insertFn),
    '★ 熔断计数按"有没有进展"记：成功清零、其余累加（判据是 continueLoop）');

// ---------- 二之二、"思考期"不许收起悬浮窗（★ 2026-10 回归）----------
//
// 用户反馈"在后台时悬浮窗老是消失" —— 根因是续跑定时器一触发就把自己清成 null，
// 而 callAI 要跑好几秒；600ms 排下的收起定时器在 ~1.8s 检查时守卫全失守，
// 于是**整段思考期**浮层被收掉、下一步又 show 回来（用户看到的就是"消失几秒又冒出来"）。
console.log('\n— 思考期不收起悬浮窗 —');
ok(/agentContinueBusy = true/.test(loopFn),
    '★ 模型调用前标记"管道忙"（思考期不许收起）');
ok(/finally \{[\s\S]{0,60}agentContinueBusy = false/.test(loopFn),
    '★ 用 finally 清标志（任何出口都不会漏，否则会永久挂着不收）');
ok(/function agentPipelineBusy\(\)/.test(html) && /agentContinueTimer\) \|\| agentContinueBusy/.test(html),
    '★ 统一的"忙"判据：续跑待发 / 模型在想 / 还有操作在飞');
const hideFn = extractFn('scheduleOverlayHide');
ok(/agentPipelineBusy\(\)/.test(hideFn) && !/phoneOpsInFlight > 0/.test(hideFn),
    '★ 收起悬浮窗前统一判 agentPipelineBusy（不再各处自己写一份漏项的判据）');

// ---------- 三、预算必须按"用户请求"重置 ----------
console.log('\n— 预算重置 —');
const resetFn = extractFn('resetAgentContinueBudget');
ok(/agentContinueUsed = 0/.test(resetFn), '重置函数把已用步数归零');
ok(/agentStalledSteps = 0/.test(resetFn), '重置函数把"连续无进展"计数也清零（否则熔断会跨请求累计）');
ok(/clearTimeout\(agentContinueTimer\)/.test(resetFn), '重置时也清掉待触发的续跑定时器');
// 调用点必须在 handleUserInput 里
const handleFn = extractFn('handleUserInput');
ok(/resetAgentContinueBudget\(\)/.test(handleFn),
    '每条新的用户消息都重置预算（否则整个会话共享 8 步，用完永远不再续跑）');

// ---------- 四、不能提前收尾 ----------
console.log('\n— 不提前收尾 —');
ok(/const hasMoreOps = \/\\\[操作\[:：\]\/\.test/.test(loopFn),
    '用**同步**判断回复里有没有操作标签（drive() 是异步的，靠定时器判断会误判）');
// 有后续操作时先 drive() 再 return；注释可能夹在中间，所以放宽匹配范围
ok(/if \(hasMoreOps[\s\S]{0,300}?drive\(raw \|\| ''\);[\s\S]{0,80}?return;/.test(loopFn),
    '有后续操作时 return，交给下一轮 insertAgentResult 接力');
ok(/rt\.endRun\(\);\s*\n\s*\}/.test(loopFn),
    '没有操作标签时才 endRun（AI 认为任务完成）');

// ---------- 四之二、续跑**请求失败**绝不能被当成"任务完成" ★★ 2026-10 真机修复 ----------
//
// 用户反馈："退到桌面后悬浮窗运行了一下然后消失，之后再没动静、也没报错。"
//
// 根因：续跑请求失败时 `raw` 被吞成空串，而空串在下面被当成"没有更多操作标签"
// → 走 `scheduleOverlayHide(0); rt.endRun()`，即"AI 认为任务完成"。
// **"请求失败"和"任务做完了"被合并成了同一条路径**：
//   · 浮层收起（用户以为它做完了，或以为它卡住了）；
//   · 对话里零条提示（真正该知道的失败原因——额度/网络——被彻底掩盖）；
//   · 熔断计数也不涨，所以连"连续无进展"这条兜底都触发不了。
// 实测复现（探针注入必定失败的 callAI）：overlayCalls=["endRun","hideOverlay"]、
// 新消息 0 条、hasErrorNotice=false。修复后同一探针：callAI 调用 2 次（自动重试）、
// 对话里出现明确的"任务没有完成"说明。
//
// 这几条盯住的关键约定：失败必须与"完成"分开，且必须让用户看见。
console.log('\n— 续跑失败 ≠ 任务完成（防"悬浮窗消失后没动静"复发）—');
ok(/let continueError = null;/.test(loopFn),
    '★ 用独立的 continueError 记录续跑失败（不再把失败吞成空串混进"完成"分支）');
ok(/continueError = e/.test(loopFn) || /continueError = e2/.test(loopFn),
    '★ 捕获到的失败真的被记进 continueError');
// ★ 核心：失败分支必须在 hasMoreOps **真实判定**之前 return 掉，
//   否则它仍会掉进"没有操作标签 → endRun"的完成路径。
//
// ⚠️ 必须先剥掉注释再找位置 —— 失败分支的注释块里**引用了** `const hasMoreOps`
//    来对照旧写法（"原来的写法：… const hasMoreOps = …"）。
//    直接 indexOf 会命中注释里那次出现（比真实判定早 4000 字符），
//    于是这条断言**恒为假**、永远红 —— 我第一次就是这么写的。
//    同一个坑在本项目已踩过第二次（见 check-agent-overlay 的 runModeDecision），
//    所以这里显式剥注释，并在断言名里写明判据是"真实代码位置"。
{
    const codeOnly = loopFn
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    const errAt = codeOnly.indexOf('if (continueError) {');
    const moreAt = codeOnly.indexOf('const hasMoreOps');
    ok(errAt > 0 && moreAt > 0 && errAt < moreAt,
        '★★ 失败分支在 hasMoreOps 判定**之前**（否则仍会被当成"任务完成"静默收工）',
        `err@${errAt} hasMoreOps@${moreAt}（已剥注释）`);
}
// 自动重试一次：后台网络抖动/限流是最常见的失败原因，一次重试就能救回来
{
    const calls = (loopFn.match(/callAI\(AGENT_CONTINUE_PROMPT\)/g) || []).length;
    ok(calls >= 2, '★ 续跑失败会**自动重试一次**（抖动/限流能自愈）', `callAI 调用点 ${calls} 处`);
    ok(/await new Promise\(\(r\) => setTimeout\(r, \d+\)\)/.test(loopFn),
        '★ 重试前先等一会儿（立刻重试往往撞上同一个瞬时故障）');
}
// 失败必须让用户**看得见**：明确说"任务没有完成"
ok(/续跑失败/.test(loopFn) && /没有\*\*完成|没有完成/.test(loopFn),
    '★★ 失败时如实告知（明确写"任务没有完成"，不让用户以为做完了）');
ok(/\{ continueLoop: false \}/.test(loopFn.split('if (continueError) {')[1]?.slice(0, 1200) || ''),
    '★ 失败说明不触发续跑（否则会绕过它自己的重试预算、变成反复失败刷屏）');
// 停止优先：重试前也要检查，别在用户按了停止之后还白试一次
{
    const errBlock = loopFn.slice(loopFn.indexOf('let continueError = null;'), loopFn.indexOf('if (continueError) {'));
    const haltInBlock = (errBlock.match(/isHalted\(\)\) return;/g) || []).length;
    ok(haltInBlock >= 1, '★ 重试前后也检查 isHalted（用户按停止后不再白试）', `块内检查 ${haltInBlock} 次`);
}

// ---------- 五、停止必须能拦住续跑 ----------
console.log('\n— 停止优先 —');
const haltedChecks = (loopFn.match(/isHalted\(\)\) return;/g) || []).length;
ok(haltedChecks >= 2,
    '续跑前后都检查 isHalted（用户按停止后绝不能再自动往下走）', `实际检查 ${haltedChecks} 次`);
ok(/rt\.isHalted/.test(loopFn), '续跑入口就检查停止标志');

// ---------- 六、授权记忆不被续跑清空 ----------
//
// beginRun() 会 approvedThisRun.clear()，无条件调用会让
//「同一次运行内允许过就不再问」在每次续跑时失效（用户点了允许，下一步又问）。
console.log('\n— 授权记忆 —');
ok(/if \(!rt\.isRunning\(\)\) rt\.beginRun\(\)/.test(loopFn),
    '只在未运行时 beginRun（无条件调用会清空"本次已授权"，导致反复弹确认）');

// ---------- 七、续跑提示词要说清"做完了就别再发标签" ----------
//
// 否则模型会为了"继续"而没完没了地发操作标签，撞到上限才停。
console.log('\n— 续跑提示词 —');
// 提示词常量是**多行字符串拼接**，末尾才是 `;` —— 非贪婪匹配会在第一个 `;` 处截断。
// 另外文件是 **CRLF** 行尾（Windows 上 git 检出的结果），所以不能用 `;\n` 收尾，
// 必须容忍 `\r`。这里统一用 `;\r?\n`。
const promptMatch = html.match(/const AGENT_CONTINUE_PROMPT = ([\s\S]*?;\r?\n)/);
ok(!!promptMatch, '找得到 AGENT_CONTINUE_PROMPT');
if (promptMatch) {
    const p = promptMatch[1];
    ok(/不要再输出任何操作标签|不要再输出/.test(p),
        '提示词要求"任务完成就别再发标签"（否则会一直撞上限）');
    ok(/失败|不支持/.test(p), '提示词要求遇到失败/不支持时换方式而非重复');
    ok(/不要提及/.test(p), '提示词要求不要暴露"系统通知/标签"这类内部词');
}

// ---------- 八、失败路径的既有重试机制必须保留 ----------
//
// 修复成功路径时不要顺手把失败路径的重试删掉 —— 那是另一个独立机制。
console.log('\n— 失败路径不受影响 —');
ok(/AGENT_FAILURE_MAX_RETRY/.test(html), '失败重试预算仍在');
ok(/explainAgentFailure/.test(html), 'explainAgentFailure 仍在');
const failFn = extractFn('explainAgentFailure');
ok(/callAI\(prompt\)/.test(failFn), '失败路径仍然会调 callAI（AI 自己解释+纠正）');

// ---------- 九、续跑产出的回复必须真的显示出来 ----------
//
// 真实故障：AI 完成后对话里**没有出现回复内容**，得再发一句话才能看见上次的回复。
//
// 根因：续跑路径自己拼了一套"存消息 + 渲染"，但漏了 handleUserInput 的
// commitAiMessageOnce 做过的几件事，尤其是 removeThinkingMessage() ——
// "伊蕾娜正在想…"气泡一直挂着，新回复被压在它下面，看起来就像 AI 没回。
console.log('\n— 续跑回复要真的显示 —');
ok(/removeThinkingMessage\(\)/.test(loopFn),
    '续跑渲染前移除"正在想"气泡（不移除会一直挂着，回复看起来没出现）');
ok(/state\.currentConversationId === conv\.id && !state\.notesMode && !state\.diaryMode/.test(loopFn),
    '渲染前判当前会话与 notes/diary 模式（与 commitAiMessageOnce 一致）');
ok(/!document\.getElementById\(`msg-\$\{safeAttrId\(aiMessage\.id\)\}`\)/.test(loopFn),
    '渲染前防重复插入同一节点（幂等）');
ok(/state\.voiceState = 'idle'/.test(loopFn), '续跑后把语音状态复位');
ok(/updateUI\(\)/.test(loopFn), '续跑后刷新 UI');

// ---------- 十、同源接口不能用"设备层"出口 ----------
//
// 真实故障：写文件永远失败，日志里是
//   `[Relay] [WARN] 目标地址无效：/api/agent/write`
//
// postJsonFromDevice 是给**外部服务商**用的（会走 /api/relay 绕 CORS），
// 而 /api/agent/write 是**同源本地接口** —— 把相对路径交给中转，
// 中转的 new URL() 解析失败。而 ls / read 走的是同源 fetch 所以正常，
// 表现为"读取能用、写入不行"，非常有迷惑性。
console.log('\n— 同源接口出口 —');
const fileFn = extractFn('doAgentFile');
ok(!/postJsonFromDevice\(\s*['"`]\/api\//.test(fileFn),
    'doAgentFile 不用 postJsonFromDevice 打同源 /api/ 接口（会当中转目标 → 地址无效）');
ok(/fetch\('\/api\/agent\/write'/.test(fileFn),
    '写文件走同源 fetch');
ok(/fetch\(`\/api\/agent\/\$\{action\}/.test(fileFn),
    '读/列目录也走同源 fetch（两边保持一致）');
// 全局扫一遍：任何 postJsonFromDevice / getJsonFromDevice 都不该拿相对路径当目标
const relativeDeviceCalls = html.split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .filter((l) => /(?:post|get)JsonFromDevice\(\s*['"`]\/api\//.test(l));
ok(relativeDeviceCalls.length === 0,
    '全项目没有"用设备层出口打同源 /api/ 接口"的写法',
    relativeDeviceCalls.join('\n      '));

// ---------- 十一、用户消息不得绕过 AI 直接触发操作 ----------
//
// 真实问题：`handleUserInput` 在把消息发给 AI **之前**先跑 maybeAutoFileWrite()，
// 命中「写入/保存 + 文件/盘/D:\/.txt」就直接执行 —— 用户打的字本身就是触发源。
// 三个后果：绕过 AI（它全程不知情）、正则误伤（聊到 D:\ 就可能被当指令）、
// 与授权脱节（写文件弹确认框、读目录却不弹，用户感觉"我就说句话它怎么动了"）。
//
// 现在一律交给 AI 判断要不要输出 [操作:…]。
console.log('\n— 用户消息不绕过 AI —');
const handleUserInputFn = extractFn('handleUserInput');
ok(!/maybeAutoFileWrite\(/.test(handleUserInputFn),
    'handleUserInput 不再调用 maybeAutoFileWrite（用户消息不直接触发文件操作）');
// 函数本体也必须删掉，否则留着一个"看起来能用"的入口，将来很容易被重新接上
const activeCode = html.split('\n').filter((l) => !l.trim().startsWith('//'));
ok(!activeCode.some((l) => /function maybeAutoFileWrite/.test(l)),
    'maybeAutoFileWrite 定义已删除（不是只断开调用）');
ok(!activeCode.some((l) => /function parseFileWriteIntent/.test(l)),
    'parseFileWriteIntent 定义已删除');
ok(!activeCode.some((l) => /let pendingAutoWrite|pendingAutoWrite =/.test(l)),
    'pendingAutoWrite 已删除（否则 commitAiMessageOnce 里那段是永不可达的死分支）');
// 表情触发保留：它只驱动 Live2D，不碰文件与系统，风险等级完全不同
ok(/maybeAutoExpression\(/.test(handleUserInputFn),
    'maybeAutoExpression 保留（只驱动 Live2D 表情，不碰文件系统）');

console.log(`\nAgent 自动续跑检查：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
}
