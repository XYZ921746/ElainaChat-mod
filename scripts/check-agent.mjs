// AI Agent（手机操作 / 文件操作 / 续跑 / 授权 / 标签协议）的回归检查。
// 合并自七个脚本（check-agent-access / -continue / -overlay / -paths /
// -phone / -strict-route / -tags）。它们测的是同一个 Agent 运行时的不同侧面，
// 共用同一份 readFrontend() 与同一批 android-app 原生源码 —— 拆成七个文件时，
// 每个都要各自重算一遍 ROOT、各自抄一遍 ok/汇总样板。
// 每段用例在自己的函数作用域里跑，同名局部变量（ROOT / html / src）不会互相踩，
// 失败信息形如「自动续跑 :: 熔断后立即 return（不再发起请求）」。
// 用法：node scripts/check-agent.mjs          跑全部
//       node scripts/check-agent.mjs 续跑     只跑名字含该子串的用例

import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFrontend, readWebFile } from './frontend-sources.mjs';
import { runChecks, ROOT, wait, waitServerUp, freePort } from './check-harness.mjs';
import { extractFunction as extractFnFrom, extractVariable, extractTopLevelFunctions, makeVmSandbox } from './check-source.mjs';

const JAVA_DIR = path.join(ROOT, '..', 'android-app', 'android', 'app', 'src', 'main', 'java', 'com', 'elainachat', 'opensource');
const PLUGIN_JAVA = path.join(JAVA_DIR, 'ElainaShellPlugin.java');
const MANIFEST = path.join(ROOT, '..', 'android-app', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

// 1. 三档 AI 权限（strict / auto / full）
// 新模型要钉住的事实（每条都对应一个真实的设计决定）：
//   1. 手机操作**全部不弹确认**（用户明确要求"手机不做确认，全部放行"）。
//      模块后端（KernelSU / root）的风险由设置页的免责声明承担，而不是靠弹窗。
//   2. 电脑命令：strict 每条都问 / auto 只问危险 / full 从不问。
//   3. 停止优先：stopRequested 时一律拒绝，任何档位都不能绕过。

async function caseAccess(c) {
    const html = readFrontend();

    // 抠 agentRuntime 的完整 IIFE
    const rtStart = html.indexOf('const agentRuntime = (function ()');
    const rtEnd = html.indexOf('window.agentRuntime = agentRuntime;');
    if (rtStart < 0 || rtEnd < 0) throw new Error('抠不到 agentRuntime');
    let rtSrc = html.slice(rtStart, rtEnd);

    const state = { settings: { agentAccess: 'strict', agentPhoneEnabled: true } };
    let resolveModal = null;   // 应用内弹窗的"人工点按"由测试脚本代替
    const sandbox = {
        console,
        state,
        document: {
            getElementById: () => null,   // render() 里的元素拿不到 → 内部直接 return，安全
            querySelectorAll: () => [],
        },
        AGENT_RISK: {
            '手机状态': 'safe', '手机查看界面': 'safe', '手机截图': 'safe', '手机等待': 'safe',
            '手机点击': 'sensitive', '手机滑动': 'sensitive', '手机输入': 'sensitive',
            '手机按键': 'sensitive', '手机打开': 'sensitive', '手机命令': 'dangerous',
            '手机应用列表': 'safe', '手机通知': 'safe', '手机设备信息': 'safe',
            '手机短信': 'safe', '手机通讯录': 'safe', '手机日历': 'safe',
            '手机列出文件': 'safe', '手机读文件': 'safe', '手机写文件': 'sensitive', '手机删除文件': 'sensitive',
            '电脑命令': 'sensitive',
        },
        showCustomModal: () => new Promise((resolve) => { resolveModal = resolve; }),
        DOMException, AbortController,
        Set, Map, Promise, Date, Number, String, Boolean, Error, setTimeout, clearTimeout,
        requestApprovalViaOverlay: () => Promise.resolve(null),   // 无悬浮窗 → 走应用内弹窗
        deviceBridge: () => null,
        // 三档模型的判据函数（真实定义在 agent.js 顶部，这里按同样语义注入）
        currentAgentAccess: () => state.settings.agentAccess || 'strict',
        // phoneTierAllows 的真实实现见 agent.js —— 这里从源码里抠出来跑，
        // 避免"测试里抄一份、实现改了两边不一致"。
        phoneTierAllows: null,
        window: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    // 从真实源码里抠 phoneTierAllows，保证测的是实现本身
    const ptStart = html.indexOf('function phoneTierAllows(');
    if (ptStart < 0) throw new Error('抠不到 phoneTierAllows');
    let depth = 0, ptEnd = html.indexOf('{', ptStart);
    for (; ptEnd < html.length; ptEnd++) {
        if (html[ptEnd] === '{') depth++;
        else if (html[ptEnd] === '}') { depth--; if (depth === 0) { ptEnd++; break; } }
    }
    vm.runInContext(html.slice(ptStart, ptEnd) + '\nwindow.phoneTierAllows = phoneTierAllows;', sandbox);
    sandbox.phoneTierAllows = sandbox.window.phoneTierAllows;

    // requestStop 里引用了 elements —— 沙箱里没有，换成安全占位
    rtSrc = rtSrc.replace('elements.customModalCancelBtn?.click()', 'null');

    vm.runInContext(rtSrc + '\nwindow.agentRuntime = agentRuntime;', sandbox);
    const rt = sandbox.window.agentRuntime;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /** 走一次真实授权判定，返回"弹了没有" */
    async function ask(action) {
        if (!rt.isRunning()) rt.beginRun();
        rt.setStep(1, action);
        resolveModal = null;
        const p = rt.requestApproval(action, action + ' 测试');
        let waited = 0;
        while (!resolveModal && waited < 300) { await sleep(10); waited += 10; }
        const asked = Boolean(resolveModal);
        if (resolveModal) { const r = resolveModal; resolveModal = null; r(true); }
        const allowed = await p;
        return { asked, allowed };
    }

    // 手机操作：全部放行（含「手机命令」，风险由免责声明承担）
    rt.beginBatch();
    for (const access of ['strict', 'auto', 'full']) {
        state.settings.agentAccess = access;
        for (const action of ['手机状态', '手机查看界面', '手机截图', '手机点击', '手机滑动',
            '手机输入', '手机按键', '手机打开', '手机应用列表', '手机通知',
            '手机设备信息', '手机短信', '手机通讯录', '手机日历',
            '手机列出文件', '手机读文件', '手机写文件', '手机删除文件']) {
            const r = await ask(action);
            c.ok(r.asked === false, `${access} 档下「${action}」不弹确认`,
                r.asked ? '仍然弹了确认！' : '');
            c.ok(r.allowed === true, `${access} 档下「${action}」被放行`);
        }
        // 唯一的例外曾经是「手机命令」，但用户明确答复"全部放行但是模块加免责声明"，
        // 所以现在**连它也不问** —— 风险由设置页的免责声明承担。
        const cmd = await ask('手机命令');
        c.ok(cmd.asked === false, `${access} 档下「手机命令」也不弹确认（用户选择全部放行 + 免责声明）`,
            cmd.asked ? '又加回确认了？' : '');
    }

    // 电脑命令：按档位决定问不问
    state.settings.agentAccess = 'full';
    let r = await ask('电脑命令');
    c.ok(r.asked === false, 'full 档：电脑命令不弹确认（完全访问的定义）');

    state.settings.agentAccess = 'auto';
    r = await ask('电脑命令');
    c.ok(r.asked === false, 'auto 档：普通电脑命令不弹（由服务端 needApproval 驱动危险命令）');

    state.settings.agentAccess = 'strict';
    r = await ask('电脑命令');
    c.ok(r.asked === true, 'strict 档：电脑命令弹确认（逐条确认的定义）');

    // forceAsk 必须能穿透任何档位 —— 这是"服务端判定为危险"的唯一表达方式
    state.settings.agentAccess = 'full';
    rt.beginBatch();
    resolveModal = null;
    {
        const p = rt.requestApproval('电脑命令', '危险命令', { forceAsk: true });
        let waited = 0;
        while (!resolveModal && waited < 300) { await sleep(10); waited += 10; }
        c.ok(Boolean(resolveModal), '★ forceAsk 穿透 full 档（危险命令必须问，档位豁免不了）');
        if (resolveModal) { const f = resolveModal; resolveModal = null; f(true); }
        await p;
    }

    // 停止优先
    state.settings.agentAccess = 'full';
    rt.beginBatch();
    rt.requestStop('测试停止');
    const stopped = await ask('手机点击');
    c.ok(stopped.allowed === false, '★ 已停止时任何档位都拒绝执行（停止优先于档位）');
}

// 2. 自动续跑
// 背景（真实故障）：AI 读取/写入文件后就不动了，必须用户打一句"继续"才走下一步。
// 根因是一个**不对称**：
//   · 失败路径 explainAgentFailure() 会调 callAI() —— AI 能自己解释并重试；
//   · 成功路径只 insertAgentResult() 把结果塞进对话，**从不调 callAI()**。
// 这个修复有三个容易写错的地方，本段逐条锁住：
//   1. **死循环**：续跑到上限时若用 insertAgentResult 插提示，会再次触发续跑。
//   2. **预算不重置**：整个页面会话共享预算，用完永远不再续跑。
//   3. **提前收尾**：drive() 是异步的，靠"等一下看定时器"会误判成已收尾。

async function caseContinue(c) {
    const html = readFrontend();
    const extractFn = (name) => extractFnFrom(html, name);

    // 一、成功路径必须触发续跑
    const insertFn = extractFn('insertAgentResult');
    c.ok(/options\.continueLoop === true/.test(insertFn),
        'insertAgentResult 默认**不**续跑，只有显式 continueLoop:true 才续跑');
    c.ok(/scheduleAgentContinue\(\)/.test(insertFn),
        'insertAgentResult 里确实会触发续跑（这是原 bug 的修复点）');

    // 这个函数是 18 处调用的公共收口，其中大多数是「无权限 / 未启用 / 用户取消」这类
    // **被拒绝**的结果。它们若也触发续跑，就变成"被拒绝 → 续跑 → 又试 → 又被拒绝"的
    // 无效循环。所以必须是"选择加入"而非"选择退出"。
    // 判据是「**白名单**」而不是「数量等于 N」：数量断言会误伤新加的合法成功路径，
    // 而且挡不住"把一处合法调用换成一处非法调用、数量不变"这种改动。
    const ALLOWED_CONTINUE_SITES = [
        { re: /insertAgentResult\(resultText, \{ continueLoop: true, asContext: true \}\)/, label: '文件操作成功' },
        { re: /insertAgentResult\(opResult, \{ continueLoop: true, asContext: true \}\)/, label: '手机操作成功' },
        { re: /insertAgentResult\('命令执行结果：\\n' \+ text, \{ continueLoop: true, asContext: true \}\)/, label: '电脑命令成功' },
        { re: /insertAgentResult\(text, \{ continueLoop: true, asContext: true \}\)/, label: '浏览器操作成功' },
        // 联网搜索与浏览器共用同一句插入形态（都是 text 变量），上面那条正则同时覆盖两者 ——
        //   这里补一条带上下文的登记，让"新增成功路径必须显式登记"这条纪律仍然成立。
        { re: /insertAgentResult\(text, \{ continueLoop: true, asContext: true \}\)/, label: '联网搜索结果' },
    ];
    const continueLines = html.split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .filter((l) => /insertAgentResult\(.*continueLoop: true/.test(l));
    const unregistered = continueLines.filter((l) => !ALLOWED_CONTINUE_SITES.some((s) => s.re.test(l)));
    c.ok(unregistered.length === 0,
        '开启续跑的调用点全部在白名单内（新增成功路径需显式登记）',
        unregistered.length ? '未登记：\n      ' + unregistered.map((l) => l.trim()).join('\n      ') : '');
    // 反向：白名单里每一条都必须真的还在（防止被删掉后白名单变成空保护）
    const missingSites = ALLOWED_CONTINUE_SITES.filter((s) => !continueLines.some((l) => s.re.test(l)));
    c.ok(missingSites.length === 0,
        '白名单里的成功路径都还在（文件 / 手机 / 电脑命令 / 浏览器）',
        missingSites.length ? '缺失：' + missingSites.map((s) => s.label).join('、') : '');
    c.ok(continueLines.length === ALLOWED_CONTINUE_SITES.length,
        `续跑调用点数量与白名单一致（${ALLOWED_CONTINUE_SITES.length} 处）`,
        `实际 ${continueLines.length} 处`);
    c.ok(/insertAgentResult\(resultText, \{ continueLoop: true, asContext: true \}\)/.test(html),
        '文件操作成功处开启续跑');
    c.ok(/const opResult = await execPhoneOperation\(parsed\);/.test(html)
        && /insertAgentResult\(opResult, \{ continueLoop: true, asContext: true \}\)/.test(html),
        '手机操作成功处开启续跑');
    // 成功结果必须是"上下文"而不是一个新的聊天气泡：
    //   失败那一刻由 explainAgentFailure 让角色自己开口，对话里只有正文；
    //   成功那一刻若再插一条可见的「【AI 操作结果】」，同一件事就会出现两次，
    //   而且结果排在正文前面，看起来像"它先报了个工单、再跟你说话"。
    c.ok(/asContext === true/.test(insertFn) && /if \(asContext\) msg\.hidden = true;/.test(insertFn),
        '★ 成功结果标记 hidden（只进过程区，不占聊天气泡）');
    c.ok(/if \(!asContext && state\.currentConversationId === conv\.id\) renderMessage\(msg\);/.test(insertFn),
        '★ asContext 时**不**渲染可见气泡');
    const visibleSites = continueLines.filter((l) => !/asContext: true/.test(l));
    c.ok(visibleSites.length === 0,
        '★ 所有开启续跑的成功路径都带 asContext: true',
        visibleSites.length ? '漏了：\n      ' + visibleSites.map((l) => l.trim()).join('\n      ') : '');

    // ── 可见性规则：用户**亲手做过的决定**只进过程区，用户**不知道的失败**必须可见 ──
    //   用户实测反馈"【AI 操作结果】应该待在思考过程里面"。规则按"用户知不知道"划线，
    //   而不是按"成功/失败"划 —— 因为他刚点了「不允许」时那件事他已经知道了，
    //   再往聊天区插一条回执只是复述他刚做的决定；而"操作失败"是他不知道的事，
    //   藏进可折叠区就变成了隐瞒。
    const DECIDED_BY_USER = [
        { re: /已取消写入：你没有允许新建这个文件[^)]*\)?[^;]*asContext: true/, label: '拒绝新建文件' },
        { re: /已取消写入：目标文件已存在，而你没有允许覆盖它[\s\S]{0,200}?asContext: true/, label: '拒绝覆盖文件' },
        { re: /已取消删除：用户没有允许[\s\S]{0,80}?asContext: true/, label: '拒绝删除' },
        { re: /已跳过这条命令：用户没有允许[\s\S]{0,120}?asContext: true/, label: '拒绝危险命令' },
        { re: /已跳过「' \+ parsed\.action \+ '」：用户没有允许这一步[\s\S]{0,120}?asContext: true/, label: '拒绝手机操作' },
        { re: /已停止：用户中止了操作，剩余步骤没有执行。[^;]*asContext: true/, label: '用户按停止' },
    ];
    const missingDecided = DECIDED_BY_USER.filter((d) => !d.re.test(html)).map((d) => d.label);
    c.ok(missingDecided.length === 0,
        '★ 用户亲手拒绝/停止的结果只进过程区（不再复述他刚做的决定）',
        missingDecided.length ? '漏了：' + missingDecided.join('、') : '');
    // 反向：用户**不知道**的失败必须留在可见处，不能被顺手收进过程区
    const MUST_STAY_VISIBLE = [
        { re: /insertAgentResult\('手机操作失败：' \+ [^;]*\);/, label: '手机操作失败' },
        { re: /insertAgentResult\('操作失败：' \+ shortReason/, label: '文件操作失败' },
    ];
    const hiddenFailures = MUST_STAY_VISIBLE.filter((d) => !d.re.test(html)).map((d) => d.label);
    c.ok(hiddenFailures.length === 0,
        '★ 用户不知道的失败仍显示在聊天区（不许藏进可折叠区）',
        hiddenFailures.length ? '被藏了：' + hiddenFailures.join('、') : '');
    c.ok(!/已跳过[^)]*continueLoop: true/.test(html), '「已跳过」类结果不续跑');
    c.ok(!/已取消写入[^)]*continueLoop: true/.test(html), '「已取消写入」不续跑');
    c.ok(!/操作失败[^)]*continueLoop: true/.test(html), '失败说明不续跑');

    // 二、死循环防护（由"步数上限"改成"连续无进展熔断"）
    // 用户要求"取消 8 步限制改为无限制"，于是把硬性步数上限**删掉**，
    // 换成"连续 N 步没做成任何事就熔断"：
    //   · 步数上限   → 一件正常的长任务会被腰斩（几十步本来就是正常的）；
    //   · 无进展熔断 → 只钉住"反复失败"这种情况。
    // 最关键的回归项仍然是：熔断时插入的提示**不能**再触发续跑。
    const loopFn = extractFn('continueAgentLoop');
    c.ok(!/AGENT_CONTINUE_MAX_STEPS/.test(html), '★ 旧的 8 步硬上限已彻底移除（用户要求无限制）');
    c.ok(/AGENT_STALL_FUSE/.test(loopFn), '续跑有"连续无进展"熔断');
    const capBlock = loopFn.match(/if \(agentStalledSteps >= AGENT_STALL_FUSE\)[\s\S]*?\n {8}\}/);
    c.ok(!!capBlock, '找得到熔断分支');
    c.ok(!!capBlock && !/continueLoop: true/.test(capBlock[0]),
        '熔断时的提示不开启续跑（否则"熔断→插提示→又调度→又熔断"无限循环）');
    c.ok(!!capBlock && /\breturn;/.test(capBlock[0]),
        '熔断后立即 return（不再发起请求）');
    c.ok(!!capBlock && /rt\.endRun\(\)/.test(capBlock[0]),
        '熔断时收起运行状态条（否则状态条会一直挂着）');
    c.ok(/agentStalledSteps = 0/.test(insertFn) && /agentStalledSteps \+= 1/.test(insertFn),
        '★ 熔断计数按"有没有进展"记：成功清零、其余累加（判据是 continueLoop）');

    // 二之二、"思考期"不许收起悬浮窗
    // 用户反馈"在后台时悬浮窗老是消失" —— 根因是续跑定时器一触发就把自己清成 null，
    // 而 callAI 要跑好几秒；600ms 排下的收起定时器在 ~1.8s 检查时守卫全失守，
    // 于是**整段思考期**浮层被收掉、下一步又 show 回来。
    c.ok(/agentContinueBusy = true/.test(loopFn),
        '★ 模型调用前标记"管道忙"（思考期不许收起）');
    c.ok(/finally \{[\s\S]{0,60}agentContinueBusy = false/.test(loopFn),
        '★ 用 finally 清标志（任何出口都不会漏，否则会永久挂着不收）');
    c.ok(/function agentPipelineBusy\(\)/.test(html) && /agentContinueTimer\) \|\| agentContinueBusy/.test(html),
        '★ 统一的"忙"判据：续跑待发 / 模型在想 / 还有操作在飞');
    const hideFn = extractFn('scheduleOverlayHide');
    c.ok(/agentPipelineBusy\(\)/.test(hideFn) && !/phoneOpsInFlight > 0/.test(hideFn),
        '★ 收起悬浮窗前统一判 agentPipelineBusy（不再各处自己写一份漏项的判据）');

    // 三、预算必须按"用户请求"重置
    const resetFn = extractFn('resetAgentContinueBudget');
    c.ok(/agentContinueUsed = 0/.test(resetFn), '重置函数把已用步数归零');
    c.ok(/agentStalledSteps = 0/.test(resetFn), '重置函数把"连续无进展"计数也清零（否则熔断会跨请求累计）');
    c.ok(/clearTimeout\(agentContinueTimer\)/.test(resetFn), '重置时也清掉待触发的续跑定时器');
    const handleFn = extractFn('handleUserInput');
    c.ok(/resetAgentContinueBudget\(\)/.test(handleFn),
        '每条新的用户消息都重置预算（否则整个会话共享 8 步，用完永远不再续跑）');

    // 四、不能提前收尾
    c.ok(/const hasMoreOps = \/\\\[操作\[:：\]\/\.test/.test(loopFn),
        '用**同步**判断回复里有没有操作标签（drive() 是异步的，靠定时器判断会误判）');
    c.ok(/if \(hasMoreOps[\s\S]{0,300}?drive\(raw \|\| ''\);[\s\S]{0,80}?return;/.test(loopFn),
        '有后续操作时 return，交给下一轮 insertAgentResult 接力');
    c.ok(/rt\.endRun\(\);\s*\n\s*\}/.test(loopFn),
        '没有操作标签时才 endRun（AI 认为任务完成）');

    // 四之二、续跑**请求失败**绝不能被当成"任务完成"
    // 用户反馈："退到桌面后悬浮窗运行了一下然后消失，之后再没动静、也没报错。"
    // 根因：续跑请求失败时 `raw` 被吞成空串，而空串被当成"没有更多操作标签"
    // → 走 `scheduleOverlayHide(0); rt.endRun()`，即"AI 认为任务完成"。
    // **"请求失败"和"任务做完了"被合并成了同一条路径**：
    //   · 浮层收起（用户以为它做完了，或以为它卡住了）；
    //   · 对话里零条提示（真正该知道的失败原因——额度/网络——被彻底掩盖）；
    //   · 熔断计数也不涨，所以连"连续无进展"这条兜底都触发不了。
    c.ok(/let continueError = null;/.test(loopFn),
        '★ 用独立的 continueError 记录续跑失败（不再把失败吞成空串混进"完成"分支）');
    c.ok(/continueError = e/.test(loopFn) || /continueError = e2/.test(loopFn),
        '★ 捕获到的失败真的被记进 continueError');
    // ★ 核心：失败分支必须在 hasMoreOps **真实判定**之前 return 掉，
    //   否则它仍会掉进"没有操作标签 → endRun"的完成路径。
    // ⚠️ 必须先剥掉注释再找位置 —— 失败分支的注释块里**引用了** `const hasMoreOps`
    //    来对照旧写法。直接 indexOf 会命中注释里那次出现（比真实判定早 4000 字符），
    //    于是这条断言**恒为假**、永远红。所以这里显式剥注释，
    //    并在断言名里写明判据是"真实代码位置"。
    {
        const codeOnly = loopFn
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        const errAt = codeOnly.indexOf('if (continueError) {');
        const moreAt = codeOnly.indexOf('const hasMoreOps');
        c.ok(errAt > 0 && moreAt > 0 && errAt < moreAt,
            '★★ 失败分支在 hasMoreOps 判定**之前**（否则仍会被当成"任务完成"静默收工）',
            `err@${errAt} hasMoreOps@${moreAt}（已剥注释）`);
    }
    // 自动重试一次：后台网络抖动/限流是最常见的失败原因，一次重试就能救回来
    {
        // 判据放宽到"调用点带上 AGENT_CONTINUE_PROMPT，后面还可以跟别的实参"——
        // 工具通道会在这句后面再传一组请求选项（见 agent.js 的 agentToolOptions）。
        const calls = (loopFn.match(/callAI\(AGENT_CONTINUE_PROMPT/g) || []).length;
        c.ok(calls >= 2, '★ 续跑失败会**自动重试一次**（抖动/限流能自愈）', `callAI 调用点 ${calls} 处`);
        c.ok(/await new Promise\(\(r\) => setTimeout\(r, \d+\)\)/.test(loopFn),
            '★ 重试前先等一会儿（立刻重试往往撞上同一个瞬时故障）');
    }
    // 失败必须让用户**看得见**：明确说"任务没有完成"
    c.ok(/续跑失败/.test(loopFn) && /没有\*\*完成|没有完成/.test(loopFn),
        '★★ 失败时如实告知（明确写"任务没有完成"，不让用户以为做完了）');
    c.ok(/\{ continueLoop: false \}/.test(loopFn.split('if (continueError) {')[1]?.slice(0, 1200) || ''),
        '★ 失败说明不触发续跑（否则会绕过它自己的重试预算、变成反复失败刷屏）');
    // 停止优先：重试前也要检查，别在用户按了停止之后还白试一次
    {
        const errBlock = loopFn.slice(loopFn.indexOf('let continueError = null;'), loopFn.indexOf('if (continueError) {'));
        const haltInBlock = (errBlock.match(/isHalted\(\)\) return;/g) || []).length;
        c.ok(haltInBlock >= 1, '★ 重试前后也检查 isHalted（用户按停止后不再白试）', `块内检查 ${haltInBlock} 次`);
    }

    // 五、停止必须能拦住续跑
    const haltedChecks = (loopFn.match(/isHalted\(\)\) return;/g) || []).length;
    c.ok(haltedChecks >= 2,
        '续跑前后都检查 isHalted（用户按停止后绝不能再自动往下走）', `实际检查 ${haltedChecks} 次`);
    c.ok(/rt\.isHalted/.test(loopFn), '续跑入口就检查停止标志');

    // 六、授权记忆不被续跑清空
    // beginRun() 会 approvedThisRun.clear()，无条件调用会让
    //「同一次运行内允许过就不再问」在每次续跑时失效。
    c.ok(/if \(!rt\.isRunning\(\)\) rt\.beginRun\(\)/.test(loopFn),
        '只在未运行时 beginRun（无条件调用会清空"本次已授权"，导致反复弹确认）');

    // 七、续跑提示词要说清"做完了就别再发标签"
    // 提示词常量是**多行字符串拼接**，末尾才是 `;` —— 非贪婪匹配会在第一个 `;` 处截断。
    // 另外文件是 **CRLF** 行尾，所以不能用 `;\n` 收尾，必须容忍 `\r`。
    const promptMatch = html.match(/const AGENT_CONTINUE_PROMPT = ([\s\S]*?;\r?\n)/);
    c.ok(!!promptMatch, '找得到 AGENT_CONTINUE_PROMPT');
    if (promptMatch) {
        const p = promptMatch[1];
        c.ok(/不要再输出任何操作标签|不要再输出/.test(p),
            '提示词要求"任务完成就别再发标签"（否则会一直撞上限）');
        c.ok(/失败|不支持/.test(p), '提示词要求遇到失败/不支持时换方式而非重复');
        c.ok(/不要提及/.test(p), '提示词要求不要暴露"系统通知/标签"这类内部词');
    }

    // 八、失败路径的既有重试机制必须保留
    c.ok(/AGENT_FAILURE_MAX_RETRY/.test(html), '失败重试预算仍在');
    c.ok(/explainAgentFailure/.test(html), 'explainAgentFailure 仍在');
    const failFn = extractFn('explainAgentFailure');
    // 判据同上：调用点带 prompt 即可，实参后面还可能跟一组请求选项（工具通道）
    c.ok(/callAI\(prompt/.test(failFn), '失败路径仍然会调 callAI（AI 自己解释+纠正）');

    // 九、续跑产出的回复必须真的显示出来
    // 真实故障：AI 完成后对话里**没有出现回复内容**，得再发一句话才能看见上次的回复。
    // 根因：续跑路径自己拼了一套"存消息 + 渲染"，但漏了 handleUserInput 的
    // commitAiMessageOnce 做过的几件事，尤其是 removeThinkingMessage() ——
    // "伊蕾娜正在想…"气泡一直挂着，新回复被压在它下面，看起来就像 AI 没回。
    c.ok(/removeThinkingMessage\(\)/.test(loopFn),
        '续跑渲染前移除"正在想"气泡（不移除会一直挂着，回复看起来没出现）');
    c.ok(/state\.currentConversationId === conv\.id && !state\.notesMode && !state\.diaryMode/.test(loopFn),
        '渲染前判当前会话与 notes/diary 模式（与 commitAiMessageOnce 一致）');
    c.ok(/!document\.getElementById\(`msg-\$\{safeAttrId\(aiMessage\.id\)\}`\)/.test(loopFn),
        '渲染前防重复插入同一节点（幂等）');
    c.ok(/state\.voiceState = 'idle'/.test(loopFn), '续跑后把语音状态复位');
    c.ok(/updateUI\(\)/.test(loopFn), '续跑后刷新 UI');

    // 十、同源接口不能用"设备层"出口
    // 真实故障：写文件永远失败，日志里是 `[Relay] [WARN] 目标地址无效：/api/agent/write`。
    // postJsonFromDevice 是给**外部服务商**用的（会走 /api/relay 绕 CORS），
    // 而 /api/agent/write 是**同源本地接口** —— 把相对路径交给中转，中转的 new URL() 解析失败。
    // 而 ls / read 走的是同源 fetch 所以正常，表现为"读取能用、写入不行"，非常有迷惑性。
    const fileFn = extractFn('doAgentFile');
    c.ok(!/postJsonFromDevice\(\s*['"`]\/api\//.test(fileFn),
        'doAgentFile 不用 postJsonFromDevice 打同源 /api/ 接口（会当中转目标 → 地址无效）');
    c.ok(/fetch\('\/api\/agent\/write'/.test(fileFn),
        '写文件走同源 fetch');
    c.ok(/fetch\(`\/api\/agent\/\$\{action\}/.test(fileFn),
        '读/列目录也走同源 fetch（两边保持一致）');
    const relativeDeviceCalls = html.split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .filter((l) => /(?:post|get)JsonFromDevice\(\s*['"`]\/api\//.test(l));
    c.ok(relativeDeviceCalls.length === 0,
        '全项目没有"用设备层出口打同源 /api/ 接口"的写法',
        relativeDeviceCalls.join('\n      '));

    // ---- 执行实现必须**返回结果对象**，不能裸 return ----
    //   这些实现是经 ElainaOps.invoke → runToolCalls 调用的，而那里写作
    //     `await invoke(...) || { ok:false, text:'没有返回结果' }`
    //   —— 裸 return 得到 undefined，于是模型在上下文里收到的是「没有返回结果」。
    //   现场：用户点「允许新建」之外的路径（拒绝 / 平台不支持）时，
    //   界面上写着"完成"，模型却读到"失败"，下一句就向用户道歉说文件没建成。
    //   文件其实好好地在桌面上。
    const agentSrc2 = readWebFile('js/agent-phone.js') + '\n'
        + readWebFile('js/agent-nl.js') + '\n'
        + readWebFile('js/agent-files.js') + '\n'
        + readWebFile('js/agent-tools.js') + '\n' + readWebFile('js/agent-continue.js')
        + '\n' + readWebFile('js/agent.js');
    const voiceSrc2 = readWebFile('js/voice.js');
    const uiSrc2 = readWebFile('js/ui-process.js') + '\n' + readWebFile('js/ui.js');
    // extractFnFrom 按大括号配平取值，遇到注释/字符串里的大括号会跑偏
    // （实测一度算出"82 处裸 return"这种明显不可能的计数）。
    // 这两个函数的范围改用**下一个顶层 async function** 作边界，判据稳定。
    const fnBody = (src, name) => {
        const at = src.indexOf('async function ' + name + '(');
        if (at < 0) return '';
        const rest = src.slice(at + 1);
        const nextAt = rest.search(/\nasync function /);
        return nextAt < 0 ? src.slice(at) : src.slice(at, at + 1 + nextAt);
    };
    for (const fnName of ['doAgentFile', 'doAgentCommand']) {
        const body = fnBody(agentSrc2, fnName);
        const bare = (body.match(/\n\s+return;\s*\n/g) || []);
        c.ok(bare.length === 0,
            '★ ' + fnName + ' 没有裸 return（否则模型收到「没有返回结果」把成功读成失败）',
            bare.length ? '仍有 ' + bare.length + ' 处裸 return' : '');
    }
    c.ok(/return \{ ok: false, text: '用户没有允许新建这个文件/.test(fileFn),
        '★ 拒绝新建时返回明确结果（不是 undefined）');
    c.ok(/return \{ ok: false, text: '用户没有允许覆盖/.test(fileFn),
        '★ 拒绝覆盖时返回明确结果');
    c.ok(/return \{ ok: false, text: '用户没有允许删除/.test(fileFn),
        '★ 拒绝删除时返回明确结果');

    // ---- 同一个动作只能记**一行**过程 ----
    //   工具通道里 runToolCalls 已经记过一行（标题「调用 save_file」、参数是 JSON）。
    //   实现若再记一行，时间线上同一个动作会显示成两条：一条有参数、一条没有，
    //   用户看到的是"做了两件事"，其中一件还常常是失败的。
    c.ok(/async function doAgentFile\(action, \{ path, content \} = \{\}, access, traceItem\)/.test(agentSrc2),
        '★ doAgentFile 接受外层 traceItem（复用那一行）');
    c.ok(/const ownTrace = !traceItem;/.test(agentSrc2),
        '★ 只在没有外层记录时才自己建行（标签通道）');
    c.ok(/Object\.assign\(\{\}, ctx, \{ traceItem \}\)/.test(agentSrc2),
        '★ runToolCalls 经 ctx 把 traceItem 交给实现');
    c.ok(/doAgentFile\('write', args, ctx\.access, ctx\.traceItem\)/.test(agentSrc2),
        '★ setExec 把 traceItem 传给实现');

    // ---- 参数形状必须两条通道一致（都是 JSON）----
    //   写成「路径：…\n内容长度：…」这种中文散文，时间线就没法按键值渲染，
    //   同一步在工具通道（JSON）与标签通道（散文）下长得完全不一样。
    c.ok(!/路径：\$\{path\}/.test(fileFn),
        '★ 参数不再写成中文散文（否则时间线无法按键值渲染）');
    c.ok(/args: JSON\.stringify\(action === 'write'/.test(fileFn),
        '★ 文件操作参数用 JSON（与工具通道同形）');

    // ---- 「先做，再统一说」----
    //   模型常在正文里先写结论、再发调用（"喏，文件已经在那儿了" + save_file）。
    //   那段话若在工具执行前就渲染出去，用户先看到"已经建好了"，随后看到失败。
    c.ok(/else pendingToolReplyMessageId = aiMessage\.id;/.test(voiceSrc2),
        '★★ 有工具调用时正文先压着不渲染（先做，再开口）');
    c.ok(/function revealPendingToolReply\(anySucceeded\)/.test(voiceSrc2),
        '★★ 有统一的"工具跑完再开口"入口');
    c.ok(/if \(!anySucceeded\) return;/.test(voiceSrc2),
        '★★ 这一批全失败时压住正文（不替模型把"已经建好了"说圆）');
    c.ok(/agentMarkPendingReply\(anySucceeded\)/.test(agentSrc2),
        '★★ 收尾只记账（成功与否留给续跑决定），不抢着把正文放出来');
    c.ok(/let anySucceeded = false/.test(agentSrc2) && /if \(result\.ok\) anySucceeded = true/.test(agentSrc2),
        '★★ 逐条跟踪是否真的做成（任一成功即可开口）');

    // ---- 「先做，再用结果统一开口」（对齐 DSH 的 agent loop）----
    //   DSH 把**每一步都当成一次独立模型调用**：发 tool_call 那一步的正文只是中间产物，
    //   循环继续、工具结果进会话、再调一次模型，用户最终看到的是"知道结果之后"那一句。
    //   本应用若反过来做（先放正文、再另起一条说结果），得到的是两条接不上的气泡，
    //   而且第一句写在结果之前、没有依据。
    //   所以：工具跑完后**只记账、不渲染**；等续跑回来再决定
    //     · 有新正文 → replacePendingToolReply() 取代那句"动手前"的话
    //     · 没新正文 → revealPendingToolReply() 兜底放出（免得"做完了却一声不吭"）
    c.ok(/function agentMarkPendingReply\(/.test(voiceSrc2), '★★ 有"先记账不渲染"的入口');
    c.ok(/function replacePendingToolReply\(/.test(voiceSrc2),
        '★★ 续跑的新正文会取代那句"动手前"的话（不是并排两条）');
    c.ok(/function settlePendingToolReply\(/.test(voiceSrc2),
        '★★ 有统一的收尾决定（取代 or 兜底放出）');
    c.ok(/settlePendingToolReply\(true\)/.test(agentSrc2),
        '★★ 续跑拿到正文时走"取代"分支');
    c.ok(/settlePendingToolReply\(false\)/.test(agentSrc2),
        '★★ 续跑没正文时走"兜底放出"分支（收尾与续跑失败两处）');
    // 取代时必须先确认那句话**没被显示过** —— 删掉屏幕上已有的内容是篡改用户刚读到的
    c.ok(/getElementById\(`msg-\$\{safeAttrId\(id\)\}`\)\) return false;/.test(voiceSrc2),
        '★★ 已经显示过的那句话不删（不篡改用户刚读到的内容）');

    // ---- 衔接质量：续跑提示词必须要求"接着上一句讲" ----
    //   只管规则不管语感的话，模型会重新开场（"好的，我来帮你在桌面创建文件"），
    //   读者看到的就是同一件事被交代两遍、第二遍还像刚知道似的。
    const continuePrompt = (agentSrc2.split('const AGENT_CONTINUE_PROMPT')[1] || '').split('let agentContinueUsed')[0];
    c.ok(/衔接上一句/.test(continuePrompt),
        '★★ 续跑提示词要求"接着上一句讲"（否则会重新开场）');
    c.ok(/不要重新开场/.test(continuePrompt), '★★ 明确禁止重新开场/复述任务');
    c.ok(/中间的一步/.test(continuePrompt),
        '★★ 说明"只是中间一步就别收尾说话，直接输出下一步操作"');

    // ---- exec 实现必须**返回结果对象** ----
    //   ★★ 这是"文件建成了、过程区却写着失败"的根因。
    //   这些实现经 ElainaOps.invoke → runToolCalls 调用，而 runToolCalls 会把
    //   返回值的 `ok` 直接写进过程行。它们过去**只有副作用、没有任何返回值**
    //   （连成功路径也是这样），于是即便文件真的写成功，模型收到的也是
    //   "没有返回结果"，而刚标记成 ok 的过程行被**覆盖成 error** ——
    //   用户看到"文件在桌面上，过程区写着失败"。
    //   ⚠️ 判据锚"这个函数里有没有返回值"，不是"有没有某个字符串"：
    //   上一轮的断言只查了拒绝分支的 `return {`，漏掉成功路径同样缺返回值，
    //   于是修过一次问题还在。
    const fnBodyOf = (src, name) => {
        const at = src.indexOf('async function ' + name + '(');
        if (at < 0) return '';
        const rest = src.slice(at + 1);
        const nextAt = rest.search(/\n(async )?function /);
        return nextAt < 0 ? src.slice(at) : src.slice(at, at + 1 + nextAt);
    };
    for (const fnName of ['doAgentFile', 'doAgentCommand', 'runAgentPhoneOperation', 'runManualMemorySummary']) {
        const body = fnBodyOf(agentSrc2, fnName);
        c.ok(body.length > 0, '找得到 ' + fnName + ' 的函数体');
        const bare = (body.match(/\n\s+return;\s*\n/g) || []).length;
        c.ok(bare === 0, '★★ ' + fnName + ' 没有裸 return', bare ? '仍有 ' + bare + ' 处' : '');
        c.ok(/return \{ ok: true/.test(body), '★★ ' + fnName + ' 成功路径返回结果对象');
        c.ok(/return \{ ok: false/.test(body), '★★ ' + fnName + ' 失败路径返回结果对象');
    }
    // 兜底防护：实现若又漏写 return，也不许把"已成 ok 的行"覆盖成失败
    c.ok(/const traced = traceItem && traceItem\.state === 'ok';/.test(agentSrc2),
        '★★ 漏写返回值时以过程行为准（不许把成功覆盖成失败）');

    // ---- 过程区必须**持久化到消息上** ----
    //   ★★ 这是"聊了几轮之后，之前对话的思考记录不见了"的根因。
    //   过程区是追加到聊天容器末尾的**临时 DOM**，而 loadConversation 会先
    //   `conversationHistory.innerHTML = ''` 再重画每条消息 —— 那些临时节点
    //   不在任何消息里，于是整体消失。切会话、刷新页面、自动重载都会触发。
    //   （注释一直写着"历史消息回看时还要看得到"，实际做不到。）
    c.ok(/msg\.turnTrace = \{/.test(uiSrc2), '★★ 收尾时把过程挂到消息上');
    c.ok(/function restoreTurnProcessFor\(message\)/.test(uiSrc2), '★★ 有还原函数');
    c.ok(/restoreTurnProcessFor\(message\)/.test(uiSrc2), '★★ 重画消息时调用还原');
    // 存**数据**而不是 HTML：HTML 依赖当时的展开态与主题，存下来会越用越脏
    c.ok(/timeline: activeTurnTrace\.timeline/.test(uiSrc2)
        && /tools: activeTurnTrace\.tools/.test(uiSrc2),
        '★★ 存的是数据（timeline/tools/phases），不是 HTML 字符串');
    c.ok(!/turnTrace\s*===\s*[^;]*innerHTML/.test(uiSrc2), '★★ 没有把 innerHTML 存进去');
    // 重复渲染不许插第二份
    c.ok(/turn-process-\$\{safeAttrId\(message\.id\)\}`\)\) return;/.test(uiSrc2),
        '★★ 重复渲染不会插第二份过程区');

    // 十一、用户消息不得绕过 AI 直接触发操作
    // 真实问题：`handleUserInput` 在把消息发给 AI **之前**先跑 maybeAutoFileWrite()，
    // 命中「写入/保存 + 文件/盘/D:\/.txt」就直接执行 —— 用户打的字本身就是触发源。
    // 三个后果：绕过 AI（它全程不知情）、正则误伤、与授权脱节。
    const handleUserInputFn = extractFn('handleUserInput');
    c.ok(!/maybeAutoFileWrite\(/.test(handleUserInputFn),
        'handleUserInput 不再调用 maybeAutoFileWrite（用户消息不直接触发文件操作）');
    // 函数本体也必须删掉，否则留着一个"看起来能用"的入口，将来很容易被重新接上
    const activeCode = html.split('\n').filter((l) => !l.trim().startsWith('//'));
    c.ok(!activeCode.some((l) => /function maybeAutoFileWrite/.test(l)),
        'maybeAutoFileWrite 定义已删除（不是只断开调用）');
    c.ok(!activeCode.some((l) => /function parseFileWriteIntent/.test(l)),
        'parseFileWriteIntent 定义已删除');
    c.ok(!activeCode.some((l) => /let pendingAutoWrite|pendingAutoWrite =/.test(l)),
        'pendingAutoWrite 已删除（否则 commitAiMessageOnce 里那段是永不可达的死分支）');
    // 表情触发保留：它只驱动 Live2D，不碰文件与系统，风险等级完全不同
    c.ok(/maybeAutoExpression\(/.test(handleUserInputFn),
        'maybeAutoExpression 保留（只驱动 Live2D 表情，不碰文件系统）');
}

// 3. 系统悬浮窗（打破"每步都要切回应用确认"的死循环）
// 为什么需要：这是个**只有在真机上才会暴露**的交互缺陷 ——
//   AI 点击目标 App 的按钮
//     → 弹授权框（在 ElainaChat 内部）
//     → 用户切回 ElainaChat 点「允许」
//     → 切回来这一步把目标 App 切到后台，那次点击落到错的位置或直接失败
//     → AI 重试 → 又弹窗 … 死循环
// 修法是在原生层加系统悬浮窗（SYSTEM_ALERT_WINDOW / TYPE_APPLICATION_OVERLAY），
// 并让前端的授权流程**优先走悬浮窗、不可用时回退应用内弹窗**。
// 全程只读源码，不连真机、不触发任何下载。

async function caseOverlay(c) {
    /* 独立克隆（或 android-app 不在仓库上一级）时没有原生工程 —— 这是环境，不是缺陷，跳过。 */
    if (!existsSync(MANIFEST)) {
        console.log('  --   跳过：没有 ../android-app 原生工程（独立克隆 / 未按作者目录结构放置）');
        return;
    }
    const html = readFrontend();
    const OVERLAY_JAVA = path.join(JAVA_DIR, 'ElainaOverlay.java');

    // 1. 原生：权限声明
    const mf = readFileSync(MANIFEST, 'utf8');
    c.ok(mf.includes('android.permission.SYSTEM_ALERT_WINDOW'),
        'AndroidManifest 声明了 SYSTEM_ALERT_WINDOW（悬浮窗权限）');

    // 2. 原生：悬浮窗实现
    c.ok(existsSync(OVERLAY_JAVA), 'ElainaOverlay.java 存在');
    if (existsSync(OVERLAY_JAVA)) {
        const src = readFileSync(OVERLAY_JAVA, 'utf8');

        // 窗口类型：Android 8+ 必须用 TYPE_APPLICATION_OVERLAY
        c.ok(src.includes('TYPE_APPLICATION_OVERLAY'),
            '用 TYPE_APPLICATION_OVERLAY（Android 8+ 的悬浮窗类型）');
        c.ok(src.includes('canDrawOverlays'),
            '用 Settings.canDrawOverlays 检测权限');
        c.ok(src.includes('ACTION_MANAGE_OVERLAY_PERMISSION'),
            '用 ACTION_MANAGE_OVERLAY_PERMISSION 跳系统授权页');

        // 关键：不能持有 Activity —— 否则应用退到后台浮层就没了
        c.ok(!/extends\s+Activity|Activity\s+\w+\s*;/.test(src.replace(/getApplicationContext/g, '')),
            '不持有 Activity（挂在 ApplicationContext 上，应用退到后台浮层仍在）');

        c.ok(/static\s+void\s+show\s*\(/.test(src), '提供 show()（显示浮层）');
        c.ok(/static\s+void\s+hide\s*\(/.test(src), '提供 hide()（收起浮层）');
        c.ok(/static\s+void\s+askApproval\s*\(/.test(src), '提供 askApproval()（就地确认）');
        c.ok(/static\s+boolean\s+isShowing\s*\(/.test(src), '提供 isShowing()（状态查询）');

        c.ok(src.includes('停止'), '浮层上有「停止」按钮');
        c.ok(src.includes('允许') && src.includes('拒绝'), '浮层上有「允许 / 拒绝」按钮');

        c.ok(src.includes('FLAG_NOT_FOCUSABLE'),
            '带 FLAG_NOT_FOCUSABLE（不抢焦点，目标应用照常收到输入）');
    }

    // 3. 原生：插件方法
    {
        const src = readFileSync(PLUGIN_JAVA, 'utf8');
        for (const m of ['overlayStatus', 'requestOverlay', 'showOverlay', 'updateOverlay', 'askOverlayApproval', 'hideOverlay']) {
            c.ok(new RegExp('public\\s+void\\s+' + m + '\\s*\\(\\s*PluginCall').test(src),
                '插件暴露 ' + m + '()');
        }
        c.ok(src.includes('notifyListeners("overlayStop"'), '点停止时发 overlayStop 事件');
        c.ok(src.includes('notifyListeners("overlayApproval"'), '点允许/拒绝时发 overlayApproval 事件');
    }

    // 4. 前端：授权流程（先悬浮窗、后回退）
    {
        c.ok(/function\s+requestApprovalViaOverlay\s*\(/.test(html), '有 requestApprovalViaOverlay()');
        c.ok(/await\s+requestApprovalViaOverlay\s*\(/.test(html), 'requestApproval 里真的调了它');

        // 关键：浮层不可用时必须**回退**到应用内弹窗，不能静默拒绝
        const fnStart = html.indexOf('async function requestApproval(');
        const fnEnd = html.indexOf('function requestApprovalViaOverlay(');
        c.ok(fnStart > 0 && fnEnd > fnStart, '能定位 requestApproval 函数体');
        if (fnStart > 0 && fnEnd > fnStart) {
            const body = html.slice(fnStart, fnEnd);
            c.ok(/ok\s*===\s*null/.test(body) || /===\s*null/.test(body),
                '识别"浮层不可用"的返回值（null）');
            c.ok(/showCustomModal\s*\(/.test(body),
                '浮层不可用时回退到应用内弹窗（不是静默拒绝）');
        }
    }

    // 5. 前端：浮层生命周期
    {
        c.ok(/rt\.showOverlay\s*\(/.test(html), '开始操作时显示浮层');
        c.ok(/rt\.hideOverlay\s*\(/.test(html), '结束/停止时收起浮层');

        const beginRunIdx = html.indexOf('rt.beginRun()');
        const showIdx = html.indexOf('rt.showOverlay(');
        c.ok(beginRunIdx > 0 && showIdx > beginRunIdx && showIdx - beginRunIdx < 900,
            '显示浮层紧跟在 beginRun 之后（一次运行开一次，不是每步都开）');

        c.ok(/requestStop[\s\S]{0,300}hideOverlay/.test(html) || /hideOverlay[\s\S]{0,200}requestStop/.test(html),
            '停止流程里会收起浮层');
    }

    // 6. 前端：权限引导（必须主动请求，不能只写句话）
    {
        c.ok(html.includes('overlayEnableBtn'), '设置里有「开启悬浮窗」按钮');
        c.ok(html.includes('overlayStatusText'), '设置里有权限状态显示');
        c.ok(/function\s+refreshOverlayStatus\s*\(/.test(html), '有 refreshOverlayStatus()');
        c.ok(/function\s+enableOverlay\s*\(/.test(html), '有 enableOverlay()（跳系统设置）');
        c.ok(/need-permission/.test(html), '识别"需要授权"');

        // 用户反馈过"应用不主动请求悬浮窗权限"。之前只 insertAgentResult 一句提示，
        // 用户得自己去设置里找三步。现在必须在操作流程里**主动弹确认框并可一键跳转**。
        const runStart = html.indexOf('async function runAgentPhoneOperation(');
        const runEnd = html.indexOf('// ===== 实现方式（后端选择）=====', runStart);
        const runBody = runStart > 0 && runEnd > runStart ? html.slice(runStart, runEnd) : '';
        c.ok(/showCustomModal\s*\(/.test(runBody),
            '操作流程里主动弹确认框（不只是写一句提示）');
        c.ok(/enableOverlay\s*\(\s*\{\s*quiet/.test(runBody),
            '用户点「去开启」后直达系统设置');
        c.ok(/overlayPromptDeclined/.test(html),
            '用户拒绝过就不再打扰（避免每次都拦）');

        c.ok(/function\s+enableOverlay\s*\(\s*opts\s*\)/.test(html) || /function\s+enableOverlay\s*\(\s*\w/.test(html),
            'enableOverlay 支持参数（供静默跳转用）');
    }

    // 7. 停止时必须了结等待中的确认
    {
        // 坑：用户点「停止」而不是「允许/拒绝」时，requestApprovalViaOverlay 里那个
        // Promise 的 resolve 存在 overlayApprovalPending 里，没人调 → await 永远挂住。
        // 表现是"点了停止没反应"—— 而这恰恰是最需要它立刻停的时刻。
        const stopFn = html.slice(html.indexOf('function requestStop(reason)'), html.indexOf('function assertNotStopped()'));
        c.ok(/overlayApprovalPending/.test(stopFn), 'requestStop 里了结了等待中的浮层确认');
        c.ok(/pending\(false\)/.test(stopFn), '以"未允许"结束那个 Promise');

        const listener = html.slice(html.indexOf("addListener('overlayStop'"), html.indexOf("addListener('overlayApproval'"));
        c.ok(/overlayApprovalPending/.test(listener), '浮层「停止」回调里也了结了它');
        c.ok(/pending\(false\)/.test(listener), '同样以"未允许"结束');
    }

    // 8. 风险分级仍然生效
    {
        // dangerous 操作必须**无条件**询问（不受 agentApproval 策略影响）
        const start = html.indexOf('async function requestApproval(');
        const end = html.indexOf('function requestApprovalViaOverlay(');
        const body = start > 0 ? html.slice(start, end) : '';
        c.ok(/risk\s*!==\s*'dangerous'/.test(body), 'dangerous 操作不受"不询问"策略影响（仍然必问）');
        c.ok(/AGENT_RISK/.test(html), '风险分级表仍在使用');
    }

    // 9. 副屏监视窗
    {
        // 用途：AI 用「模块」后端时跑在独立虚拟副屏上，物理主屏看不到 ——
        // 这个窗口把副屏画面搬进应用，让用户知道 AI 在点什么。
        c.ok(/id="screenWatchPanel"/.test(html), '有副屏监视窗 DOM');
        c.ok(/id="screenWatchImg"/.test(html), '有画面元素');
        c.ok(/id="screenWatchPowerBtn"/.test(html), '有副屏启停按钮');
        c.ok(/function openScreenWatch\(/.test(html) && /function closeScreenWatch\(/.test(html),
            '有打开/关闭函数');
        c.ok(/SCREEN_WATCH_INTERVAL/.test(html), '有自动刷新间隔常量');

        // ⚠️ 这里的 slice 起点是 `html.indexOf('function render()')` —— 那是**第一个**
        //    render()，而 achievements.js 里也有一个同名函数、且加载顺序更靠前。
        //    所以这段切片比"agentRuntime 的 render"宽得多（横跨到 beginBatch）。
        //    旧断言只匹配标识符名字（useModule），宽一点也凑合能过；
        //    但下面这几条要断言**真实的判据表达式**，必须在 agentRuntime 区间内取，
        //    否则会匹配到别的文件里的同名片段，变成假通过。
        const rtStart = html.indexOf('const agentRuntime = (function ()');
        const rtEnd = html.indexOf('window.agentRuntime = agentRuntime;');
        const agentRenderFn = (rtStart >= 0 && rtEnd > rtStart)
            ? html.slice(rtStart, rtEnd).slice(html.slice(rtStart, rtEnd).indexOf('function render()'))
            : '';
        const renderFn = html.slice(html.indexOf('function render()'), html.indexOf('function beginBatch()'));
        c.ok(/agentWatchBtn/.test(renderFn), '运行状态条里的「看画面」按钮由 render 控制');
        c.ok(/__lastAgentBackend/.test(agentRenderFn), '按**实际**用过的后端决定是否显示（"自动"模式下也要能判断）');
        // 真机反馈"我选了前台，界面却在走模块"：旧判据是
        //   `currentBackendId()==='module' || used==='module'` —— 前者读**持久化的默认方式**、
        //   后者是**上一轮**用过的后端且从不重置，两个都往"显示模块"的方向错。
        //   现在必须读**本轮**的 runModeDecision，并收敛成一个 effective 值再比较。
        // ⚠️ 断言不能用 `/runModeDecision/` 去匹配整段 —— 那段**注释里**就写着
        //    "runModeDecision" 等字样，注释会让断言永远通过。所以先把注释剥掉，
        //    只在**真实代码**上做匹配。
        const codeOnly = agentRenderFn
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        c.ok(/const mode = /.test(codeOnly) && /runModeDecision/.test(codeOnly),
            '★ 只用**本轮**的选择（runModeDecision）判断，不拿持久化默认值当当前方式');
        c.ok(!/\|\|\s*used === 'module'/.test(codeOnly),
            '★ 不再把"上一轮用过的后端"当成本轮的判据（used 只能作为兜底，不能与 mode 并列取或）');
        c.ok(/effective === 'module'/.test(codeOnly), '只在模块后端时才显示');
        c.ok(/running && effective === 'module'/.test(codeOnly), '任务结束后按钮要收起来');

        // 生命周期：定时器必须能被停掉，否则关掉窗口后还在每 1.5 秒打原生层
        const closeFn = html.slice(html.indexOf('function closeScreenWatch()'), html.indexOf('// ==================== 日志设置'));
        c.ok(/screenWatchStopAuto\(\)/.test(closeFn), '★ 关闭监视窗时停掉自动刷新（否则后台一直轮询原生层）');

        // 与设置面板的互斥：两者同为 z-index 100002 层，同时开着就由 DOM 顺序决定谁在上面。
        // CSS 注释一直声称"打开监视窗前会先关掉设置"，但实现漏了这一步。
        const openFn = html.slice(html.indexOf('function openScreenWatch()'), html.indexOf('function closeScreenWatch()'));
        // 断言"真的会执行"，不能只断言字符串出现过 —— `false && closeSettingsPanel()` 也能匹配到
        // 名字，那种写法等于没关（变异测试抓到过这个假阳性）。
        c.ok(/if \(typeof closeSettingsPanel === 'function'\) closeSettingsPanel\(\);/.test(openFn),
            '★ 打开监视窗前先关掉设置面板（同为 100002 层，否则层叠顺序不确定）');

        // 授权确认框必须盖得住监视窗
        c.ok(/#customModal \{ z-index: 100003 !important; \}/.test(html),
            '确认框层级（100003）高于监视窗（100002）');
        c.ok(/#screenWatchPanel \{ z-index: 100002 !important; \}/.test(html),
            '监视窗层级显式声明为 100002');
    }

    // 10. 原生侧：副屏接口
    {
        const plugin = readFileSync(PLUGIN_JAVA, 'utf8');
        c.ok(/public void liveFrame\(PluginCall call\)/.test(plugin), '原生有 liveFrame 方法（取副屏当前帧）');
        c.ok(/public void moduleDisplay\(PluginCall call\)/.test(plugin), '原生有 moduleDisplay 方法（副屏启停）');
        c.ok(/imageBase64/.test(plugin), 'liveFrame 回传 base64 画面');
        // 前端调用的方法名必须与原生一致 —— 拼错不会报错，只会静默失效
        c.ok(/typeof plugin\.liveFrame !== 'function'/.test(html), '前端按 liveFrame 调用（方法名与原生一致）');
        c.ok(/typeof plugin\.moduleDisplay !== 'function'/.test(html), '前端按 moduleDisplay 调用（方法名与原生一致）');
        c.ok(/plugin\.liveFrame\(\)/.test(html), 'liveFrame 被真正调用（不只是存在性检查）');
        c.ok(/plugin\.moduleDisplay\(\{\s*op:/.test(html), 'moduleDisplay 带上 op 参数（start / stop）');
    }
}

// 4. 文件操作的「真实位置」解析与目录归类（真起一次 serve.mjs）
// 这一块连着两个真踩过的坑：
// 1. **桌面不一定在 C:\Users\<用户名>\Desktop**。用户可以把桌面「移动」到任意位置，
//    OneDrive 也会把它重定向。实测踩过：用户的桌面在 `D:\桌面`，AI 按惯例猜
//    `C:\Users\Administrator\Desktop`，拿到一句「目录不存在」之后直接卡死。
//    修法是服务端从注册表读出真实位置（`/api/agent/roots` + `%DESKTOP%` 别名）。
// 2. **Windows 的 junction 既不是目录也不是文件**。`C:\Users\All Users` 这类
//    兼容性链接在 readdir 的 Dirent 里 `isDirectory()` 为 false、
//    `isSymbolicLink()` 为 true，旧实现把它们全标成「文件」。
// 做法：真的起一次 serve.mjs（LOG_TO_FILE=0，不污染 data/logs/），打真实 HTTP 接口断言。
// 这比抠函数体更接近实际 —— 注册表读取、路径展开、权限判定全都在真实链路上跑一遍。

async function casePaths(c) {
    const check = (label, actual, expected) => {
        c.ok(actual === expected, label,
            actual === expected ? '' : 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected));
    };
    const note = (label, text) => console.log(`  --   ${label}: ${text}`);

    const projectRoot = ROOT;
    const port = await freePort();
    const child = spawn(process.execPath, ['web/serve.mjs'], {
        cwd: projectRoot,
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_TO_FILE: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bootLog = '';
    child.stdout.on('data', (d) => { bootLog += d.toString(); });
    child.stderr.on('data', (d) => { bootLog += d.toString(); });

    const base = `http://127.0.0.1:${port}`;
    const api = async (p) => {
        const res = await fetch(base + p);
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const ls = (p, access) => api('/api/agent/ls?access=' + access + '&path=' + encodeURIComponent(p));

    try {
        const up = await waitServerUp(base);
        if (!up) throw new Error('serve.mjs 没能启动：\n' + bootLog);

        // 1. 真实外壳文件夹
        const rootsRes = await api('/api/agent/roots?access=full');
        const roots = rootsRes.body?.roots || [];
        check('GET /api/agent/roots 返回 ok', rootsRes.body?.ok, true);
        for (const key of ['desktop', 'documents', 'downloads']) {
            check(`roots 里有 ${key}`, roots.some((r) => r.key === key), true);
        }
        const desktop = roots.find((r) => r.key === 'desktop');
        check('desktop 的 path 是绝对路径', Boolean(desktop?.path && path.isAbsolute(desktop.path)), true);
        check('desktop 路径真实存在', desktop ? statSync(desktop.path, { throwIfNoEntry: false })?.isDirectory() === true : false, true);
        note('这台机器上的桌面', desktop?.path || '(没解析出来)');

        // 三档模型：**三档都能访问任意路径**，所以这里不再有"不带 permission=computer
        // 就看不到真实路径"这条断言 —— 那个区分随 app/computer 两档模型一起消失了。
        // 取而代之的硬边界是**认证**：未登录的请求根本到不了 /api/agent/*。
        // 本检查跑在本机（免密管理员），所以认证边界测不到 —— 那由 check-security.mjs 覆盖。
        const noAccess = await api('/api/agent/roots');
        check('不传 access 时也能拿到真实路径（三档无路径差别）',
            (noAccess.body?.roots || []).some((r) => r.path !== undefined), true);

        // 2. 路径别名展开
        const byAlias = await ls('%DESKTOP%', 'full');
        check('%DESKTOP% 解析到真实桌面', byAlias.body?.path, desktop?.path);
        const byTilde = await ls('~desktop', 'full');
        check('~desktop 解析到同一个路径', byTilde.body?.path, desktop?.path);
        const byProfile = await ls('%USERPROFILE%', 'full');
        check('%USERPROFILE% 解析到用户目录', byProfile.body?.path, os.homedir());

        // 别名出现在路径中段也要展开（不能只认"整条路径就是一个别名"）
        const midAlias = await api('/api/agent/read?access=full&path='
            + encodeURIComponent('%DESKTOP%' + path.sep + '_elaina_check_missing_.txt'));
        check('别名后接文件名时也展开（404 里能看到展开后的完整路径）',
            String(midAlias.body?.message || '').includes(desktop?.path || '\u0000'), true);

        // 3. 猜错路径时要给出真实位置
        const guessed = path.join(os.homedir(), 'Desktop');
        if (statSync(guessed, { throwIfNoEntry: false })?.isDirectory()) {
            note('跳过「猜错路径」断言', `${guessed} 在这台机器上真实存在，构不成"猜错"场景`);
        } else {
            const bad = await ls(guessed, 'full');
            check('猜错的桌面路径返回 404', bad.status, 404);
            check('404 的文案里带着真实桌面路径', String(bad.body?.message || '').includes(desktop?.path || '\u0000'), true);
        }

        // 4. 目录归类：junction 不能当成文件
        const home = await ls(os.homedir(), 'full');
        const entries = home.body?.entries || [];
        check('能列出用户目录', entries.length > 0, true);
        check('每个条目的 type 只能是 dir/file', entries.every((e) => e.type === 'dir' || e.type === 'file'), true);
        check('每个条目都带 link 布尔标记', entries.every((e) => typeof e.link === 'boolean'), true);

        // 核心断言：凡是被标成 file 的，stat 之后都不能是目录（旧实现正是在这里把 junction 判成文件）
        const misclassified = entries
            .filter((e) => e.type === 'file')
            .filter((e) => statSync(path.join(os.homedir(), e.name), { throwIfNoEntry: false })?.isDirectory() === true)
            .map((e) => e.name);
        check('被标成 file 的条目里没有实际是目录的', misclassified.length, 0);
        if (misclassified.length) console.log('        误判:', misclassified);
        note('识别到的链接（junction）', entries.filter((e) => e.link).map((e) => e.name).join('、') || '（本机没有）');

        // 5. 权限边界：三档都能访问任意路径
        // 三档模型**取消了路径边界**：strict / auto / full 都能碰任意路径，
        // 区别只在"要不要问"与"能不能删"（那两条由上面的授权用例覆盖）。
        for (const access of ['strict', 'auto', 'full']) {
            const alias = await ls('%DESKTOP%', access);
            check(`${access} 档下 %DESKTOP% 可列出（三档无路径差别）`, alias.body?.ok, true);
            const traversal = await ls(path.join(projectRoot, 'web', '..', 'data'), access);
            check(`${access} 档下 web/../data 可列出`, traversal.body?.ok, true);
        }
        const inApp = await ls(path.join(projectRoot, 'web'), 'strict');
        check('strict 档下 web/ 本身可以列出', inApp.body?.ok, true);

        // 非法档位一律按最严的 strict 收敛（不能因为传了个怪值就放行）
        const bogus = await ls(path.join(projectRoot, 'web'), 'totally-bogus');
        check('非法档位被收敛后仍然可用（回落 strict，不影响读取）', bogus.body?.ok, true);

        // 6. 提示词注入：AI 到底知不知道真实位置
        // 用**整个 core.js + agent.js 的顶层函数环境**来跑（不再抠单个函数体）：
        //   agentRootsText 依赖 agentAccessDisabled → currentAgentAccess → 常量；
        //   只装目标函数时这些 helper 不在场，会静默走 typeof 兜底，测的就不是真实逻辑。
        const coreSrc = readWebFile('js/core.js');
        const agentSrc3 = readWebFile('js/agent-access.js') + '\n' + readWebFile('js/agent.js');
        const rootsSandbox = makeVmSandbox({});
        vm.runInContext(
            [extractVariable(agentSrc3, 'AGENT_ACCESS_LEVELS'), extractVariable(agentSrc3, 'AGENT_ACCESS_DEFAULT')].join('\n')
            + '\n' + extractTopLevelFunctions(agentSrc3)
            + '\n' + extractTopLevelFunctions(coreSrc),
            rootsSandbox,
            { filename: 'agent+core#roots-env' },
        );
        const rootsText = (access, cache) => {
            rootsSandbox.state = { settings: { agentAccess: access } };
            rootsSandbox.agentRootsCache = cache;
            return rootsSandbox.agentRootsText();
        };
        check('缓存为空时不注入（也不能抛异常）', rootsText('full', null), '');
        const injected = rootsText('full', roots);
        check('把真实桌面写进提示词', injected.includes(desktop?.path || '\u0000'), true);
        check('提示词里带别名用法说明', injected.includes('%DESKTOP%'), true);
        check('提示词里明确要求不要按惯例猜路径', injected.includes('不要'), true);
        check('strict 档下同样注入（三档都能访问任意路径）',
            rootsText('strict', roots).includes(desktop?.path || '\u0000'), true);
        check('没有 path 的条目不会被写进提示词（未认证时拿到的就是这种）',
            rootsText('full', roots.map((r) => ({ ...r, path: undefined }))), '');
    } finally {
        child.kill();
    }
}

// 5. 手机操作标签与分发

async function casePhone(c) {
    /* 插件不随仓库分发：本地没有 mods/live2d 时跳过（不是缺陷） */
    if (!existsSync(path.join(ROOT, 'mods', 'live2d', 'index.js'))) {
        console.log('  --   跳过：本地没有 live2d 插件（插件不随仓库分发，这是正常状态）');
        return;
    }
    const root = ROOT;
    const html = readFrontend();
    const live2d = readFileSync(path.join(root, 'mods', 'live2d', 'index.js'), 'utf8');
    // 标签分发已从 live2d-video.js 移到宿主自有模块（见 web/js/agent-tags.js 的说明）：
    // Live2D 是可卸的 mod，不能让它持有全部 [操作:] 的分发权 —— 否则卸掉它
    // 就等于 Agent 系统（文件/命令/手机）全体失效。
    const tags = readFileSync(path.join(root, 'web', 'js', 'agent-tags.js'), 'utf8');
    const has = (haystack, needle) => String(haystack).includes(needle);
    const extractFn = (name, src = html) => extractFnFrom(src, name);

    // 一、能力声明函数存在，且三档分明
    const skillFn = extractFn('agentPhoneSkillText');
    c.ok(skillFn.length > 200, 'agentPhoneSkillText() 存在且不是空壳');

    // 没有原生设备层（网页版）→ 必须返回空串，不注入。
    // 否则网页版会让模型以为自己能操作手机，然后每次都被拒绝，白烧 token 还骗用户。
    c.ok(/if \(!deviceBridge\(\)\) return '';/.test(skillFn),
        '没有原生设备层（网页版）时不注入能力说明');

    // 未启用档：必须明确"不能"+"不要输出标签"
    c.ok(/未启用/.test(skillFn), '有「未启用」这一档');
    c.ok(/不要\*\*输出 \[操作:手机…\] 标签|不要\*\*输出/.test(skillFn) || /不要.{0,4}输出 \[操作:手机/.test(skillFn),
        '未启用时明确禁止模型输出手机标签（否则它会空谈/编造）');
    // ★ 位置必须是「能力」，不是「高级」。
    // 这条曾经钉错：v1.1.0 把「手机操作」从「高级」栏移到了「能力」栏，
    // 但代码里 8 处引导文案仍写着「设置 → 高级 → 手机操作」，而**这个检查
    // 当时断言的也是那个过时路径** —— 于是测试成了"帮凶"：它把错误的位置
    // 固化成"预期"，用户照着找却找不到。现在改为断言正确位置，
    // 并**反向排除**旧路径，防止再退回去。
    c.ok(/设置 → 能力 → 手机操作/.test(skillFn), '★ 未启用时引导到正确的位置（能力栏）开启');
    c.ok(!/高级 → 手机操作/.test(skillFn), '★ 不再引用已搬走的「高级 → 手机操作」旧位置');

    // 可用档：必须列出真实标签
    const phoneTags = [
        '手机状态', '手机查看界面', '手机截图', '手机等待',
        '手机点击', '手机滑动', '手机输入', '手机按键', '手机打开', '手机命令',
        '手机应用列表', '手机通知', '手机设备信息', '手机通讯录', '手机日历', '手机短信',
        '手机列出文件', '手机读文件', '手机写文件', '手机删除文件',
    ];
    // 读取信息那六个标签**不是字面量写在 skillFn 里的** —— 它们由
    // phoneReadSkillLines() 在运行时按隐私开关过滤后拼出来。
    // 所以判据要分两处看：字面量部分查 skillFn，读取部分查那张过滤表。
    const READ_TAGS = ['手机应用列表', '手机通知', '手机设备信息', '手机通讯录', '手机日历', '手机短信'];
    const literalTags = phoneTags.filter((t) => !READ_TAGS.includes(t));
    const missingLiteral = literalTags.filter((t) => !has(skillFn, '[操作:' + t));
    c.ok(missingLiteral.length === 0, '可用档列出了全部固定手机操作标签', '缺少: ' + missingLiteral.join('、'));
    // 读取标签必须在过滤表里逐项出现（否则开关关掉后清单不会少那一项）
    const readFnMatch = html.match(/function phoneReadSkillLines\(\)\s*\{([\s\S]*?)\n\}/);
    c.ok(!!readFnMatch, '找得到 phoneReadSkillLines() 的函数体');
    if (readFnMatch) {
        const missingRead = READ_TAGS.filter((t) => !has(readFnMatch[1], "'" + t + "'"));
        c.ok(missingRead.length === 0, '读取信息清单里列出了全部六项', '缺少: ' + missingRead.join('、'));
    }

    // 一之二、能力清单按"实现方式 + 另一路是否可用"区分
    // 无障碍后端**做不到**「手机打开」与「手机命令」（原生层明确回失败）。
    // 提示词把它俩写成通用能力，就会造成"说了却做不到" —— 模型反复尝试、用户看到一连串失败。
    // （用户要求：「模块」与「无障碍」互通、由 AI 看情况使用）
    //   判据从"是不是无障碍档"升级成"**另一路是否也可用**" —— 原生侧现在会在
    //   首选做不到某个动作时自动换路，所以两路都在时能力面是**并集**：此时再写
    //   "⛔ 不支持"会让模型自我审查，明明能做却说做不到。
    //   这里锁两件事：① 并集必须由"另一路 ready"推出（不能写死 true）；
    //                ② 另一路不可用时，边界说明必须仍然在。
    c.ok(/const isAccessibility = backend === 'accessibility'/.test(skillFn),
        '能力清单按实现方式分支（无障碍 / 其它）');
    c.ok(/不支持\*\* \[操作:手机打开\]|不支持.*手机打开/.test(skillFn),
        '另一路不可用时明确说明**不支持**「手机打开」（原生确实做不到）');
    c.ok(/手机命令/.test(skillFn) && /不支持|做不到/.test(skillFn),
        '另一路不可用时明确说明不支持「手机命令」');
    // 后端收敛为「无障碍 + 模块」，两种措辞都要认：
    //   · 互通生效 → "系统会**自动改用「模块」**完成"
    //   · 互通不可用 → "换成「模块」方式 / 把「模块」方式配置好"
    c.ok(/自动改用「模块」|换成「模块」方式|改用「模块」方式|把「模块」方式配置好/.test(skillFn),
        '给出可行替代（自动换路，或引导去配置模块）');
    c.ok(/不要重复尝试/.test(skillFn),
        '明确要求模型遇到「不支持」时不要反复重试（否则会刷屏失败）');
    // 并集必须由"另一路 ready"决定 —— 写死成 true 就又回到"说了做不到"
    c.ok(/const otherId = isAccessibility \? 'module' : 'accessibility'/.test(skillFn),
        '找得到"另一路"的判据（otherId）');
    c.ok(/otherReady = Boolean\(backendStatus\[otherId\][\s\S]*state === 'ready'/.test(skillFn),
        '★ 并集判据读的是另一路的探测状态（backendStatus），不是写死的 true');
    c.ok(/if \(canOpenAndCommand\) \{[\s\S]*手机打开 包名/.test(skillFn),
        '「手机打开 / 手机命令」只在能力面覆盖到时才列出（互通后是并集）');

    // 一之二之二、运行方式：前台（无障碍）/ 后台（模块）
    // 用户要求：AI 要操作手机时，若**两条路都可用**，应用要弹窗让用户选"前台运行"
    // （无障碍，看得见）还是"后台运行"（模块，静默不抢屏幕）。
    c.ok(/function pickPhoneRunMode\(/.test(html), '有 pickPhoneRunMode()（询问运行方式）');
    c.ok(/confirmText: '前台运行'/.test(html) && /altText: '后台运行'/.test(html),
        '★ 弹窗给出「前台运行 / 后台运行」两个明确选项');
    // 三键而不是两键：取消键还会被"点遮罩"触发，把"后台"塞进取消位
    // 等于用户手指一滑就默默用了后台。所以必须用第三个键承载它。
    c.ok(/altValue: 'module'/.test(html) && /customModalAltBtn/.test(html),
        '★ 用第三个按钮承载「后台运行」（不能塞进取消键：取消还会被点遮罩触发）');
    c.ok(/phoneActionNeedsScreen\(parsed\.action\)/.test(html),
        '只在"要动屏幕"的操作上问（读取信息 / 工作区文件 / 等待不问）');
    c.ok(/if \(!runModeDecision\) \{[\s\S]{0,400}pickPhoneRunMode\(\)/.test(html),
        '★ 一轮只问一次（答案存在 runModeDecision 里，续跑不再问）');
    c.ok(/你没有选择运行方式[\s\S]{0,160}continueLoop: false/.test(html),
        '★ 取消 = 这一步不做：如实回灌且不续跑（绝不替用户选一条）');
    c.ok(/backend: runModeDecision === 'module'/.test(html),
        '本轮选定的运行方式经 exec 的 backend 参数下传（原生据此执行）');
    const modeResetFn = extractFn('resetAgentContinueBudget');
    c.ok(/runModeDecision = ''/.test(modeResetFn),
        '★ 每条新用户消息重置运行方式选择（否则整会话只问一次）');
    c.ok(/没有任何可用的实现方式/.test(html),
        '★ 入口闸改成"有没有一条路能用"，不再要求设置里预先选过（否则未预设的用户到不了弹窗）');
    c.ok(/refreshBackendStatus\(\)/.test(html),
        '探测走 refreshBackendStatus（backendStatus 那份只有它会写）');
    c.ok(/系统会先请用户选择/.test(skillFn),
        '★ 提示词明确告诉模型"系统会去问用户"，免得它自己反问或以为要先改设置');
    // 用户反馈"我选了前台，它还是走了模块" —— 根因是"互通自动换路"盖过了显式选择。
    c.ok(/strictBackend: runModeExplicit/.test(html),
        '★ 用户显式选的运行方式要传 strictBackend（原生据此**不**自动换路）');
    c.ok(/前台运行时会直接失败并说明原因/.test(skillFn),
        '★ 提示词改口：选了前台后无障碍做不到的动作会**直接失败**，不再承诺"自动改用模块"');
    // 并发：同一条回复里两个动屏操作会并发问两次，而 showCustomModal 是单例 ——
    // 第二次调用会覆盖按钮 onclick，第一个 Promise 永不 resolve、那个操作被静默吞掉。
    c.ok(/if \(runModePicker\) return runModePicker/.test(html) && /runModePicker = doPickPhoneRunMode\(\)/.test(html),
        '★ 并发询问必须记忆化（否则第一个操作会永久挂起、静默不执行）');

    // 一之二之三、strict 必须在**原生侧**贯穿全部换路点
    // 真实故障（用户真机截图）：在「运行方式」里明确选了**前台运行（无障碍）**，
    // 结果回灌的是「启动失败（模块）：exit status 1」—— 走的是模块。
    // 根因不是前端没传 strict，而是**原生侧 strict 的作用域太窄**：
    //   · 当时 `strict` 只写在 `ID_ACCESSIBILITY.equals(preferred)` 这一个分支里；
    //   · 而它后面还有**第二个换路点** —— `pickCommandExecutor(preferred)`：
    //     preferred 不是 "module" 时会**自动挑选**，而候选列表里只有模块。
    // 所以这几条断言盯的是**结构**：strict 必须在进入自动挑选**之前**就分流掉。
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
    c.ok(strictBlock.length > 200, '原生有 `if (strict) {…}` 显式分流块');
    // ★ 核心结构断言：分流必须在 pickCommandExecutor 之前 ——
    //   放在后面就等于没放（自动挑选已经把 preferred 吞掉了）。
    {
        const strictAt = plugin.indexOf('if (strict) {');
        const pickAt = plugin.indexOf('pickCommandExecutor(preferred)');
        c.ok(strictAt > 0 && pickAt > 0 && strictAt < pickAt,
            '★★ strict 分流在 pickCommandExecutor **之前**（否则 preferred=accessibility 会被自动挑选吞掉、落到模块）');
    }
    // strict + 无障碍：必须直接走无障碍（由它如实报"能力边界"），不得换路
    c.ok(/ID_ACCESSIBILITY\.equals\(preferred\)[\s\S]{0,400}return runOnAccessibility\(action, args, false\);/.test(strictBlock),
        '★ strict + 无障碍 → 直接走无障碍（做不到就如实报，不换模块）');
    c.ok(!/runOnCommandBackend\(moduleExecutor/.test(strictBlock.split('ID_MODULE.equals(preferred)')[0]),
        '★ strict + 无障碍的分支里**不得**出现 runOnCommandBackend(moduleExecutor)（那就是偷偷换路）');
    // strict + 模块：不可用时必须明确失败，且说明"不会改用无障碍"
    c.ok(/ID_MODULE\.equals\(preferred\)[\s\S]{0,500}return failure\(/.test(strictBlock),
        '★ strict + 模块但不可用 → 明确失败（不静默回落无障碍）');
    c.ok(/不会\*\*改用无障碍|不会.*改用无障碍/.test(strictBlock),
        '★ 失败文案说明"不会改用无障碍"（否则用户以为它在乱换路）');
    // strict + 未知值：不猜、不兜底
    c.ok(/运行方式参数无法识别/.test(strictBlock),
        '★ strict + 无法识别的 preferred → 如实报错，不猜一个后端跑');
    // 中文输入那条"按动作挑最优后端"也必须让位给显式选择 ——
    // 用户选了后台（模块），却被这条送去无障碍，同样是"选的和走的不一样"。
    c.ok(/if \(!strict\s*[\s\S]{0,220}"手机输入"\.equals\(action\)/.test(plugin),
        '★ 中文输入的"改走无障碍"兜底带 !strict（显式选了后台就不该被改到前台）');
    // 非 strict 路径的"互通自动换路"必须保留 —— 别为了修 strict 把它一起删了
    c.ok(/if \(accessibilityCannotDo\(action, args\) && moduleExecutor\.available/.test(plugin),
        '★ 非 strict（没弹窗 / 只一条路可用）时的互通自动换路仍然保留');
    c.ok(/annotateBackendSwap\(/.test(plugin),
        '★ 换路仍在结果里注明"本次已自动改用…"（可排查性）');

    // 一之二之四、「看画面」按钮的判据
    // 与上面那个原生 bug 叠加、把排查方向带偏的第二个问题：
    // 状态条上「看画面」的出现判据原来是 `currentBackendId() === 'module' || used === 'module'`。
    // 前者读的是**设置里持久化的默认方式**，后者是**上一轮**用过的后端且从不重置。
    // 两个都往"显示模块"的方向错 → 用户明明选了前台却看到"看画面"。
    {
        // ⚠️ 必须**限定在 agentRuntime 的 IIFE 里**再抠 render()。
        //   直接 extractFn('render', html) 会抓到 achievements.js 里那个同名的
        //   render()（它在加载顺序上更靠前）—— 断言就会在一个毫不相干的函数上做匹配。
        const rtStart = html.indexOf('const agentRuntime = (function ()');
        const rtEnd = html.indexOf('window.agentRuntime = agentRuntime;');
        const rtSrc = (rtStart >= 0 && rtEnd > rtStart) ? html.slice(rtStart, rtEnd) : '';
        c.ok(rtSrc.length > 0, '找得到 agentRuntime 的 IIFE（抠 render 的范围）');
        const renderFn = rtSrc ? extractFn('render', rtSrc) : '';
        c.ok(renderFn.length > 100, '在 agentRuntime 里抠到 render()');
        c.ok(/runModeDecision/.test(renderFn),
            '★★ 「看画面」读的是**本轮**的 runModeDecision（不是持久化的默认方式）');
        c.ok(!/currentBackendId\(\) === 'module'\)/.test(renderFn),
            '★ 不再用 `currentBackendId() === module` 当判据（那会把默认方式当成当前方式）');
        c.ok(/effective === 'module'/.test(renderFn),
            '★ 最终判据收敛到一个 effective 值再比 module');
        const resetFn2 = extractFn('resetAgentContinueBudget');
        c.ok(/window\.__lastAgentBackend = ''/.test(resetFn2),
            '★★ 每轮重置 __lastAgentBackend（否则上一轮走过模块会让这一轮一直显示"看画面"）');
    }

    // 一之三、读取信息受隐私开关控制
    // 用户要求："如果不想让 ai 知道太多信息请关闭对应权限"。
    // 光在设置里放开关不够 —— 提示词也必须**按开关过滤**，
    // 否则模型仍会输出标签、每步都被拒绝，用户看到的是一串失败。
    c.ok(/function phoneReadSkillLines\(/.test(html),
        '有 phoneReadSkillLines()（按隐私开关过滤能力清单）');
    c.ok(/phoneReadAllowed\(x\.action\)/.test(html),
        '读取信息清单逐项按开关过滤');
    c.ok(/function phoneReadAllowed\(/.test(html), '有 phoneReadAllowed() 判据');
    c.ok(/function phoneReadBlockedReason\(/.test(html),
        '有 phoneReadBlockedReason()（执行层的第二道闸）');
    c.ok(/const PHONE_READ_OPS = \[/.test(html), '有 PHONE_READ_OPS 清单');
    c.ok(/phoneReadBlockedReason\(parsed\.action\)/.test(html),
        '★ runAgentPhoneOperation 里真的用了第二道闸（光有函数不算）');
    // 六个开关都要在设置界面里存在（应用层开关）
    for (const id of ['settingAgentReadApps', 'settingAgentReadNotifications', 'settingAgentReadDevice',
        'settingAgentReadSms', 'settingAgentReadContacts', 'settingAgentReadCalendar']) {
        c.ok(has(html, id), `设置界面有隐私开关 ${id}`);
    }
    c.ok(/不想让 AI 知道太多信息/.test(html),
        '★ 设置界面明确提示"不想让 AI 知道太多信息就关掉"（用户点名要的那句话）');

    // 二、注入点：两条构建路径都要有
    const layered = extractFn('buildLayeredRoleplayMessages');
    const legacy = extractFn('buildLegacyRoleplayMessages');
    c.ok(/agentPhoneSkillText\(\)/.test(layered), '分层版（layered-v2）注入了手机操作能力');
    c.ok(/agentPhoneSkillText\(\)/.test(legacy),
        '回滚版（legacy-v1）也注入了 —— 只补一边会让切回 legacy 后"又不能操作手机了"');

    // 三、说的必须做得到：清单里的标签解析器都认识
    // 这一条是本检查最有价值的部分：提示词与解析器是两处独立维护的清单，
    // 任何一边加/改标签而另一边没跟上，都会造成"AI 照做了却没人接"。
    // ★ 提取方式：原来用的是 `const AGENT_PHONE_OPS = [...]` 这一段里的**所有**
    //   单引号字符串。加了注释与分组后，注释里出现的 `手机短信` 之类
    //   也会被这个正则抓进来，于是"解析器认识"的判据会被注释污染。
    //   所以这里先剥掉注释再抓。
    const opsMatch = html.match(/const AGENT_PHONE_OPS = \[([\s\S]*?)\];/);
    c.ok(!!opsMatch, '找得到 AGENT_PHONE_OPS（解析器认识的标签清单）');
    if (opsMatch) {
        // 去掉 // 行注释与 /* */ 块注释，避免注释里的标签名被当成真实条目
        const bodyNoComments = opsMatch[1]
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        const parsed = [...bodyNoComments.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        const notParsed = phoneTags.filter((t) => !parsed.includes(t));
        c.ok(notParsed.length === 0,
            '提示词里承诺的每个标签，解析器都认识', '解析器不认识: ' + notParsed.join('、'));
        // 提示词那一侧：固定标签查 skillFn，读取标签查过滤表
        const notAdvertised = parsed
            .filter((t) => !READ_TAGS.includes(t))
            .filter((t) => !has(skillFn, '[操作:' + t));
        const readNotAdvertised = READ_TAGS
            .filter((t) => parsed.includes(t))
            .filter((t) => !(readFnMatch && has(readFnMatch[1], "'" + t + "'")));
        const allMissing = notAdvertised.concat(readNotAdvertised);
        c.ok(allMissing.length === 0,
            '解析器认识的每个标签，提示词里都告知了模型', '提示词漏了: ' + allMissing.join('、'));
    }

    // 每个标签都要有风险分级，否则 requestApproval 拿不到级别（会当 safe 放行）
    const riskMatch = html.match(/const AGENT_RISK = \{([\s\S]*?)\};/);
    c.ok(!!riskMatch, '找得到 AGENT_RISK（风险分级表）');
    if (riskMatch && opsMatch) {
        const bodyNoComments = opsMatch[1]
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        const parsed = [...bodyNoComments.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        const ungraded = parsed.filter((t) => !has(riskMatch[1], "'" + t + "'"));
        c.ok(ungraded.length === 0, '每个手机操作都有风险分级', '缺分级: ' + ungraded.join('、'));
    }

    // 四、分发链路的每一环都还在
    // 这几环任一断掉，提示词写得再全也没用。它们分散在两个文件里，最容易在重构时被拆散。
    c.ok(/window\.agentActions\s*=\s*\{/.test(html), '主应用定义了 window.agentActions');
    c.ok(/agentPhoneOperation\(raw\)/.test(html), 'agentActions 上有 agentPhoneOperation');
    c.ok(/async function runAgentPhoneOperation\(/.test(html), 'runAgentPhoneOperation 存在');
    // 判据行与调用行是分开的两句：`if (window.agentActions?.agentPhoneOperation)` 之后
    // 才 `window.agentActions.agentPhoneOperation(v)` —— 断言要认这个真实形状。
    // ★ 分发位置已变：从 live2d-video.js 移到 web/js/agent-tags.js。
    //   断言新位置，并确认 Live2D 那侧**不再**持有手机分支（解耦的判据）。
    c.ok(/agentPhoneOperation/.test(tags) && /callAction\('agentPhoneOperation'/.test(tags),
        'agent-tags.js 会把 [操作:手机…] 转发给主应用');
    c.ok(/\^\(手机\|设备\)/.test(tags), 'agent-tags.js 的转发判据认得「手机」前缀');
    c.ok(!/\^\(手机\|设备\)/.test(live2d),
        '★ live2d-video.js 不再持有手机分发（Live2D 卸掉不影响手机操作）');
    // ★ 注解的**写法**不该被这条断言锁死：给 @CapacitorPlugin 加了
    //   permissions 段之后它变成了多行形式，而旧正则只认单行。
    //   判据应该只关心**名字**，所以用 \s* 容忍换行。
    c.ok(/ElainaDevice/.test(html) && /@CapacitorPlugin\(\s*name\s*=\s*"ElainaDevice"/.test(
        readFileSync(path.join(root, '..', 'android-app', 'android', 'app', 'src', 'main', 'java',
            'com', 'elainachat', 'opensource', 'ElainaShellPlugin.java'), 'utf8')),
        '原生插件名与前端查找的名字一致（ElainaDevice）');
    c.ok(/registerPlugin\(ElainaShellPlugin\.class\)/.test(
        readFileSync(path.join(root, '..', 'android-app', 'android', 'app', 'src', 'main', 'java',
            'com', 'elainachat', 'opensource', 'MainActivity.java'), 'utf8')),
        'MainActivity 注册了原生插件（没注册就永远拿不到设备层）');

    // 五、静态标签指南不得把手机操作说成"总是可用"
    // ★ （方案 A 拆分）：常量从 `LIVE2D_TAG_GUIDE` 改名为
    //   `HOST_ACTION_TAG_GUIDE`，且**只留宿主自己就能执行的操作 + 定时任务** ——
    //   表现类（情绪/表情/动作/位置/大小/背景 + 静音/水印）搬进了 live2d mod，
    //   走 host.setPromptHint 注入。手机标签的"可用性随设备变化"这条要求
    //   仍然落在宿主这一段上。
    const guideMatch = html.match(/const HOST_ACTION_TAG_GUIDE = `([\s\S]*?)`;/);
    c.ok(!!guideMatch, '找得到 HOST_ACTION_TAG_GUIDE（宿主操作标签指南）');
    if (guideMatch) {
        // 静态指南里不该直接列出手机标签（它的可用性随设备/设置变化，由动态注入负责说）
        c.ok(!/\[操作:手机点击\]/.test(guideMatch[1]),
            '静态指南没有把手机标签写成"总是可用"（可用性随设备变化，交给动态注入）');
        c.ok(/系统会单独告知/.test(guideMatch[1]),
            '静态指南说明了手机/文件操作由系统单独告知（避免模型凭这里猜）');
    }
    // ★ 反向断言：表现类标签**不得**再出现在宿主的指南里
    //   （它们已是 live2d mod 的职责；留在这里就等于"卸掉插件后模型还在被要求输出
    //     没人执行的标签" —— 那正是本次拆分要根治的问题）。
    {
        const hostGuide = guideMatch ? guideMatch[1] : '';
        c.ok(!/\[情绪:开心/.test(hostGuide),
            '★ 宿主指南里不再列表现类情绪标签（已搬进 live2d mod 的 setPromptHint）');
        c.ok(!/\[表情:happy/.test(hostGuide),
            '★ 宿主指南里不再列表情标签（同上）');
        c.ok(!/\[背景:深蓝/.test(hostGuide),
            '★ 宿主指南里不再列背景标签（同上）');
        // 定时任务必须留下：它是宿主能力，跟 Live2D 无关
        c.ok(/\[任务:/.test(hostGuide),
            '★ 定时任务标签留在宿主（否则关掉 Live2D 就没法定时提醒）');
        // 宿主自己执行的三个动作也要留
        for (const act of ['打开视频通话', '结束通话', '整理记忆']) {
            c.ok(hostGuide.includes('[操作:' + act + ']'), `★ 宿主动作「${act}」留在宿主指南里`);
        }
    }
    // live2d mod 侧：表现指南必须真的通过 setPromptHint 注入
    {
        const l2d = readFileSync(path.join(root, 'mods', 'live2d', 'index.js'), 'utf8');
        c.ok(/host\.setPromptHint\(/.test(l2d),
            '★★ live2d mod 用 host.setPromptHint 注入表现指南（停用即自动摘除）');
        c.ok(/LIVE2D_PRESENTATION_GUIDE/.test(l2d), 'live2d mod 里有表现指南常量');
        c.ok(/\[情绪:开心/.test(l2d) && /\[表情:happy/.test(l2d),
            '★ 情绪/表情标签已搬到 live2d mod');
        c.ok(/\[操作:静音\]/.test(l2d) && /\[操作:隐藏水印\]/.test(l2d),
            '★ 静音/水印（本插件独有的两个操作）也在它的指南里');
        // 水印提示只在模型确实有开关时才加（否则教 AI 输出无效标签）
        c.ok(/if \(watermarkExp\)/.test(l2d),
            '★ 水印段是条件注入（模型没有水印开关就不提）');
    }
}

// 6. strict（显式运行方式）路由的决策表
// 为什么要有它：真机 bug（选了前台却走模块）本质是**原生路由的分支顺序**错了。
// 单纯的结构断言只能证明"分流没被吞掉"，证明不了"每种输入真的落到哪条路"。
// ⚠️ 本段是**手写的逻辑镜像**，不是从 .java 里执行真实代码（Java 没法在 Node 里跑）。
//    这类镜像最大的风险是**漂移**：源码改了、镜像没改，于是它一直"通过"，
//    给出虚假的安全感。所以它配了三道防漂移措施：
//      ① 抠不到 runAction / pickCommandExecutor 就**直接报错**，不静默通过；
//      ② 一组「结构性同步断言」：源码里每个分支必须仍在；
//      ③ route() 每个分支都标注了它对应的源码条件。

async function caseStrictRoute(c) {
    if (!existsSync(PLUGIN_JAVA)) {
        console.log('  --   跳过：没有 ../android-app 的 ElainaShellPlugin.java（独立克隆时正常）');
        return;
    }
    const plugin = readFileSync(PLUGIN_JAVA, 'utf8');

    // 抠出 runAction 的决策段
    const runStart = plugin.indexOf('private JSObject runAction(');
    const runEnd = plugin.indexOf('private ShellBackends.Executor pickCommandExecutor(');
    if (runStart < 0 || runEnd < runStart) {
        throw new Error('抠不到 runAction —— 函数签名改了？请同步更新本检查');
    }
    const runBody = plugin.slice(runStart, runEnd);

    // strict 块的位置必须早于 pickCommandExecutor 调用
    const strictIdx = runBody.indexOf('if (strict) {');
    const pickIdx = runBody.indexOf('pickCommandExecutor(preferred)');
    c.ok(strictIdx > 0, 'runAction 里有 if (strict) 分流块');
    c.ok(pickIdx > 0, 'runAction 里仍在调 pickCommandExecutor');
    c.ok(strictIdx < pickIdx, '★ strict 分流早于 pickCommandExecutor（核心结构）', `strict@${strictIdx} pick@${pickIdx}`);

    // 防漂移：镜像里认得的每个条件，源码里必须都还在
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
            c.ok(re.test(plugin), `源码仍具备：${label}`);
        }
        // route() 镜像里引用的动作名也必须与原生 accessibilityCannotDo 的清单一致
        const cannotDoBlock = plugin.slice(
            plugin.indexOf('private static boolean accessibilityCannotDo('),
            plugin.indexOf('private static JSObject annotateBackendSwap('));
        const mirrored = ['手机打开', '手机命令'];
        for (const act of mirrored) {
            c.ok(cannotDoBlock.includes('"' + act + '"'),
                `镜像里当作"无障碍做不到"的「${act}」仍在原生清单里`);
        }
        // 反向：原生清单里除了 按键（有条件）之外，不该有第三个 route() 不知道的动作
        const nativeCases = [...cannotDoBlock.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
        const unknown = nativeCases.filter((a) => !mirrored.includes(a) && a !== '手机按键');
        c.ok(unknown.length === 0,
            '★ 原生"无障碍做不到"清单没有 route() 不知道的新动作（有的话请同步镜像的 cannotDo）',
            '未同步: ' + unknown.join('、'));
    }

    /**
     * 模拟 runAction 的路由决策。
     * 返回 'accessibility' | 'module' | 'fail' | 'auto:<id>'。
     * 逻辑严格对照抠出来的源码分支顺序 —— 每一步都标了对应的源码条件。
     */
    function route({ action, args, preferred, strict, accRunning, modAvailable }) {
        // ① 中文输入的"改走无障碍"兜底
        if (!strict && action === '手机输入' && /[^\x00-\x7F]/.test(args) && accRunning) {
            return 'accessibility';
        }
        // ② strict 分流
        if (strict) {
            if (preferred === 'accessibility') return 'accessibility';      // 做不到也如实报，不换路
            if (preferred === 'module') return modAvailable ? 'module' : 'fail';
            return 'fail';                                                   // 未知值：不猜
        }
        // ③ preferred 是无障碍
        if (preferred === 'accessibility') {
            const cannotDo = ['手机打开', '手机命令'].includes(action);
            if (cannotDo && modAvailable) return 'auto:module';               // 互通自动换路
            return 'accessibility';
        }
        // ④ 自动挑选（候选只有 module）
        if (modAvailable) return 'module';
        return accRunning ? 'accessibility' : 'fail';                         // 兜底走无障碍
    }

    // strict + 无障碍（用户选了"前台运行"）
    {
        // 这次真机故障的核心场景：手机打开（无障碍做不到）→ 必须落到无障碍并如实报错
        const r = route({ action: '手机打开', args: 'tv.danmaku.bili', preferred: 'accessibility', strict: true, accRunning: true, modAvailable: true });
        c.ok(r === 'accessibility', '★★ 「手机打开」+ 选前台 → 走无障碍（如实报"做不到"），**不**换模块', `实际=${r}`);
        const r2 = route({ action: '手机命令', args: 'ls', preferred: 'accessibility', strict: true, accRunning: true, modAvailable: true });
        c.ok(r2 === 'accessibility', '★★ 「手机命令」+ 选前台 → 走无障碍（不换模块）', `实际=${r2}`);
        const r3 = route({ action: '手机点击', args: '100 200', preferred: 'accessibility', strict: true, accRunning: true, modAvailable: true });
        c.ok(r3 === 'accessibility', '「手机点击」+ 选前台 → 无障碍', `实际=${r3}`);
        const r4 = route({ action: '手机查看界面', args: '', preferred: 'accessibility', strict: true, accRunning: true, modAvailable: true });
        c.ok(r4 === 'accessibility', '「手机查看界面」+ 选前台 → 无障碍', `实际=${r4}`);
    }

    // strict + 模块（用户选了"后台运行"）
    {
        const r = route({ action: '手机点击', args: '1 2', preferred: 'module', strict: true, accRunning: true, modAvailable: true });
        c.ok(r === 'module', '「手机点击」+ 选后台 → 模块', `实际=${r}`);
        // 中文输入绝不能被"改走无障碍"的兜底抢走（用户选了后台，就该在副屏上打字）
        const r2 = route({ action: '手机输入', args: '你好世界', preferred: 'module', strict: true, accRunning: true, modAvailable: true });
        c.ok(r2 === 'module', '★★ 中文输入 + 选后台 → 仍走模块（不被"改走无障碍"兜底抢走）', `实际=${r2}`);
        const r3 = route({ action: '手机点击', args: '1 2', preferred: 'module', strict: true, accRunning: true, modAvailable: false });
        c.ok(r3 === 'fail', '★ 选后台但模块不可用 → 明确失败（不静默回落无障碍）', `实际=${r3}`);
    }

    // 非 strict（没弹窗：只一条路可用 / 设置里的默认方式）
    {
        // 互通自动换路必须保留 —— 别为了修 strict 把它一起删了
        const r = route({ action: '手机打开', args: 'pkg', preferred: 'accessibility', strict: false, accRunning: true, modAvailable: true });
        c.ok(r === 'auto:module', '★ 非 strict + 无障碍做不到 + 模块可用 → 自动换模块（互通仍生效）', `实际=${r}`);
        const r2 = route({ action: '手机点击', args: '1 2', preferred: 'accessibility', strict: false, accRunning: true, modAvailable: true });
        c.ok(r2 === 'accessibility', '非 strict + 无障碍做得到 → 走无障碍（不无谓换路）', `实际=${r2}`);
        // 非 strict 时中文输入仍走无障碍（命令族不支持非 ASCII）
        const r3 = route({ action: '手机输入', args: '中文', preferred: 'accessibility', strict: false, accRunning: true, modAvailable: true });
        c.ok(r3 === 'accessibility', '非 strict + 中文输入 → 无障碍（原来的兜底仍在）', `实际=${r3}`);
        const r4 = route({ action: '手机点击', args: '1 2', preferred: 'module', strict: false, accRunning: false, modAvailable: true });
        c.ok(r4 === 'module', '非 strict + 默认模块 → 模块', `实际=${r4}`);
    }

    // 回归护栏：这些必须**不**发生
    {
        const r = route({ action: '手机打开', args: 'pkg', preferred: 'accessibility', strict: true, accRunning: true, modAvailable: true });
        c.ok(r !== 'module' && r !== 'auto:module',
            '★★ 选前台 + 无障碍做不到 → 绝不落到模块（这正是真机上那个 bug）', `实际=${r}`);
        const r2 = route({ action: '手机输入', args: '中文', preferred: 'module', strict: true, accRunning: true, modAvailable: true });
        c.ok(r2 !== 'accessibility',
            '★★ 选后台 + 中文输入 → 绝不被改到无障碍', `实际=${r2}`);
    }
}

// 7. 标签协议解耦：证明"没有 Live2D 时，标签剥离与操作分发仍然工作"
// 为什么必须有这个检查：这套逻辑原先整个长在 web/live2d-video.js 里，
// 而它**是全部 [操作:] 标签的唯一分发器**（文件/命令/手机/记忆）。
// 宿主各处又都写成 `if (window.Live2DCall) { ... }` ——
// 于是"Live2D 不在"= "整个 Agent 系统失效 + 标签漏给用户看"。
// 这个检查用**故意不提供 window.Live2DCall** 的沙箱跑一遍。

async function caseTags(c) {
    const src = readFileSync(path.join(ROOT, 'web', 'js', 'agent-tags.js'), 'utf8');

    // 沙箱：**故意不提供 window.Live2DCall** —— 模拟 Live2D 被卸掉
    const calls = [];
    const sandbox = {
        console,
        window: {
            agentActions: {
                openVideoCall: () => calls.push('openVideoCall'),
                closeVideoCall: () => calls.push('closeVideoCall'),
                organizeMemory: () => calls.push('organizeMemory'),
                agentPhoneOperation: (v) => calls.push('phone:' + v),
                agentCommandOperation: (v) => calls.push('cmd:' + v),
                agentFileOperation: (v) => calls.push('file:' + v),
                agentBrowserOperation: (v) => calls.push('browser:' + v),
            },
        },
    };
    sandbox.window.window = sandbox.window;
    sandbox.globalThis = sandbox;
    sandbox.live2dService = () => null;   // 真实页面里由 core.js 提供
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    const T = sandbox.window.ElainaTags;

    // 1. 剥离：没有 Live2D 也要剥干净
    {
        c.ok(Boolean(T), 'ElainaTags 已就绪（不依赖 Live2D）');
        const cases = [
            ['你好[表情:开心]世界', '你好世界'],
            ['[情绪:平静] 早安', '早安'],
            ['文本 [动作:跳舞] 后续', '文本  后续'],
            ['[位置:left][大小:大]说话', '说话'],
            ['[背景:深蓝]背景', '背景'],
            ['[操作:列出文件 %DESKTOP%]好的', '好的'],
            ['[任务:每天09:00 提醒我]收到', '收到'],
            ['无标签纯文本', '无标签纯文本'],
        ];
        const bad = [];
        for (const [input, want] of cases) {
            const got = T.strip(input);
            if (got !== want) bad.push(`${JSON.stringify(input)} → ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`);
        }
        c.ok(bad.length === 0, `全部标签都被剥掉（${cases.length} 例）`, bad.join('; '));
    }

    // 2. 分发：没有 Live2D 也要能执行操作 ★核心
    {
        T.drive('[操作:电脑命令 git status]');
        c.ok(calls.includes('cmd:电脑命令 git status'), '★ 电脑命令被分发（不经过 Live2D）', JSON.stringify(calls));

        T.drive('[操作:列出文件 %DESKTOP%]');
        c.ok(calls.includes('file:列出文件 %DESKTOP%'), '★ 文件操作被分发');

        T.drive('[操作:手机点击 500 800]');
        c.ok(calls.includes('phone:手机点击 500 800'), '★ 手机操作被分发');

        T.drive('[操作:整理记忆]');
        c.ok(calls.includes('organizeMemory'), '整理记忆被分发');

        T.drive('[操作:打开视频通话]');
        c.ok(calls.includes('openVideoCall'), '打开视频通话被分发');

        // 顺序：电脑命令必须排在文件操作之前，否则 `git status` 里的
        // 「查看文件」类词会把命令正文吃掉
        calls.length = 0;
        T.drive('[操作:电脑命令 git status --short]');
        c.ok(calls.length === 1 && calls[0].startsWith('cmd:'),
            '★ 命令正文不会被文件分支误吃（顺序正确）', JSON.stringify(calls));

        T.drive('[操作:浏览器打开 https://example.com]');
        c.ok(calls.includes('browser:浏览器打开 https://example.com'), '★ 浏览器操作被分发');

        // 浏览器分支必须锚定开头，否则 `[操作:电脑命令 start chrome]` 会被它吃掉
        calls.length = 0;
        T.drive('[操作:电脑命令 start chrome]');
        c.ok(calls.length === 1 && calls[0].startsWith('cmd:'),
            '★ 命令正文里的「chrome」不会被浏览器分支误吃', JSON.stringify(calls));

        // 一条回复多个操作标签
        calls.length = 0;
        T.drive('[操作:打开视频通话][操作:整理记忆]');
        c.ok(calls.length === 2, '一条回复里的多个操作标签都被执行', JSON.stringify(calls));
    }

    // 3. 表现层可选：Live2D 不在也不报错
    {
        let threw = null;
        try { T.drive('[表情:开心][情绪:高兴][位置:left][操作:整理记忆]'); }
        catch (e) { threw = e; }
        c.ok(threw === null, '★ 表现标签存在但 Live2D 缺失时不抛异常', threw && threw.message);
        c.ok(calls.includes('organizeMemory'), '★ 同一条回复里的操作仍然被执行（表现被跳过）');
    }

    // 4. 表现层在场时被调用
    {
        const sandbox2 = {
            console,
            window: {
                agentActions: {},
                ElainaMods: {
                    service: (name) => (name === 'live2d'
                        ? { drivePresentation: (t) => calls.push('present:' + t.slice(0, 12)) }
                        : null),
                },
            },
        };
        sandbox2.window.window = sandbox2.window;
        sandbox2.globalThis = sandbox2;
        sandbox2.live2dService = () => sandbox2.window.ElainaMods.service('live2d');
        vm.createContext(sandbox2);
        vm.runInContext(src, sandbox2);
        const T2 = sandbox2.window.ElainaTags;
        calls.length = 0;
        T2.drive('[表情:开心]你好');
        c.ok(calls.some((x) => x.startsWith('present:')), '有 Live2D 时表现层收到文本', JSON.stringify(calls));
    }

    // 5. 扩展处理器（水印/静音挂在宿主链上）
    {
        const sandbox3 = { console, window: { agentActions: {} } };
        sandbox3.window.window = sandbox3.window;
        sandbox3.globalThis = sandbox3;
        sandbox3.live2dService = () => null;
        vm.createContext(sandbox3);
        vm.runInContext(src, sandbox3);
        const T3 = sandbox3.window.ElainaTags;
        let wm = 0;
        T3.registerOperationHandler((v) => /水印/.test(v), () => { wm++; });
        T3.drive('[操作:隐藏水印]');
        c.ok(wm === 1, '注册的扩展处理器被调用', String(wm));
        // 未知操作不该炸
        let threw = null;
        try { T3.drive('[操作:完全不存在的操作]'); } catch (e) { threw = e; }
        c.ok(threw === null, '未知操作只 warn 不抛异常');
    }
}

// 8. 操作注册表：一份操作定义，两条通道共用
// 为什么必须有这个检查：注册表是**操作定义的唯一来源**，两条触发通道
// （正文标签、原生 function calling）都读它。一旦它允许"技能"（用户上传的
// SKILL.md）注册成**可执行**条目，"装一个 zip"就等于"给自己发执行能力" ——
// 这条边界只能靠测试钉住，注释挡不住。

async function caseOps(c) {
    const src = readFileSync(path.join(ROOT, 'web', 'js', 'agent-ops.js'), 'utf8');
    const sandbox = { console };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    const O = sandbox.window.ElainaOps;
    c.ok(Boolean(O), 'agent-ops.js 已就绪（ElainaOps）');
    if (!O) return;

    // 1. 可执行条目：声明 + 执行实现
    O.define({
        name: 'demo_write', tool: 'demo_write', ns: 'file', desc: '写一个演示文件',
        schema: { type: 'object', properties: { path: { type: 'string' } } },
        risk: 'sensitive', available: () => true,
    });
    let got = null;
    O.setExec('demo_write', (args) => { got = args; return { ok: true, text: 'done' }; });
    const r = await O.invoke('demo_write', { path: 'x' }, {});
    c.ok(r && r.ok === true && got && got.path === 'x', 'invoke 走注册的执行实现', JSON.stringify(r));

    // 2. 工具声明形状：必须是 tools[].function 那一层
    const tools = O.toolsForAccess();
    const t = tools.find((x) => x.function && x.function.name === 'demo_write');
    c.ok(Boolean(t && t.type === 'function' && t.function.description && t.function.parameters),
        'toolsForAccess 产出 tools[].function 形状');

    // 3. 此刻不可用的操作：既不进工具清单，也不进能力索引
    O.define({
        name: 'demo_hidden', tool: 'demo_hidden', ns: 'file', desc: '此刻不可用',
        schema: { type: 'object', properties: {} }, available: () => false, hints: ['写文件'],
    });
    c.ok(!O.toolsForAccess().some((x) => x.function.name === 'demo_hidden'), '不可用的操作不被写进工具清单');
    c.ok(!O.indexLines().some((l) => l.startsWith('demo_hidden ')), '不可用的操作不出现在能力索引里');

    // 4. 能力索引：与工具清单同源（但元工具不进索引）
    O.define({
        name: 'demo_meta', tool: 'demo_meta', ns: 'app', indexHidden: true, desc: '只在工具清单里出现的元工具',
        schema: { type: 'object', properties: {} }, available: () => true,
    });
    c.ok(O.toolsForAccess().some((x) => x.function.name === 'demo_meta'), '★ 元工具进工具清单');
    c.ok(!O.indexLines().some((l) => l.startsWith('demo_meta ')),
        '★ 元工具不进 L1 能力索引（标签通道没有它可调用，写进索引等于教模型输出没人处理的标签）');
    c.ok(O.indexLines().length === O.availableOps().filter((o) => !o.indexHidden).length,
        '索引行数 = 当前可索引的操作数（两处同源）', O.indexLines().length + '/' + O.availableOps().length);
    c.ok(O.indexLines().every((l) => /^\S+ — /.test(l)), '索引格式统一（工具名 — 一句话）', O.indexLines().join(' | '));

    // 4a. 意图预注入的判据（降级到标签通道时靠它挑说明书，见 agent.js 的 agentIntentManualText）
    O.define({
        name: 'demo_hint', tool: 'demo_hint', ns: 'file', desc: '带关键词的操作',
        schema: { type: 'object', properties: {} }, available: () => true, hints: ['写文件'],
    });
    c.ok(O.opsForIntent('帮我在桌面上写文件 a.txt').some((o) => o.name === 'demo_hint'),
        'opsForIntent 按**条目自己的** hints 命中用户这句话');
    c.ok(!O.opsForIntent('今天天气真好').some((o) => o.name === 'demo_hint'),
        '未命中关键词时不挑它（避免把压下去的说明书又全量塞回来）');
    c.ok(!O.opsForIntent('写文件').some((o) => o.name === 'demo_hidden'),
        '不可用的操作不会被挑出来发说明书');

    // 4b. 按工具名也能取到条目（标签通道给内部 name、工具通道给 ASCII 工具名，
    //     两个名字之间只在本文件里维护一份映射）
    c.ok(O.resolve('demo_write')?.name === 'demo_write' && O.resolve('demo_write')?.tool === 'demo_write',
        '内部 name 与工具名都能 resolve');
    c.ok(O.resolve('不存在的东西') === null, 'resolve 未知项返回 null');

    // 5. ★ 红线：技能条目（纯知识）永远不能执行
    O.registerKnowledge('示例技能', '一段给 AI 的说明');
    const k = O.list('knowledge')[0];
    c.ok(Boolean(k && k.kind === 'knowledge' && !k.schema), '技能条目是 kind:knowledge（没有 schema）');
    const bad = await O.invoke(k.name, { hello: 1 }, {});
    c.ok(Boolean(bad && bad.ok === false), '★ 技能条目不能被 invoke 执行（装技能 ≠ 获得执行能力）', JSON.stringify(bad));
    c.ok(!O.toolsForAccess().some((x) => x.function.name === k.name), '技能条目不出现在工具清单里');
    // 但技能**要进** L1 能力索引：模型得先知道"有这么一份资料"才会去查它（见 agent_help）。
    //   索引里带 `skill:` 前缀与工具名一眼可分，且它进索引不等于它能执行 ——
    //   上面那条"不能 invoke"才是边界。
    c.ok(O.indexLines().some((l) => l.startsWith(k.name + ' — ')),
        '★ 技能条目进 L1 能力索引（只披露"有这份资料"，不是给它执行能力）', O.indexLines().join(' | '));

    // 6. 注册期把关：重名、非 ASCII 工具名都当场拒绝
    const rejected = [];
    try { O.define({ name: 'demo_write', tool: 'demo_write_2' }); } catch { rejected.push('重名'); }
    try { O.define({ name: 'demo_x', tool: '演示工具' }); } catch { rejected.push('非 ASCII'); }
    try { O.setExec('还没注册的操作', () => {}); } catch { rejected.push('未注册就挂实现'); }
    try { O.setManual('还没注册的操作', '说明'); } catch { rejected.push('未注册就挂说明书'); }
    c.ok(rejected.length === 4, '重名 / 非 ASCII 工具名 / 未注册就挂实现或说明书 全部被拒', rejected.join(','));

    // 6b. 说明书：只在被问到（agent_help）时下发，且真实路径来自运行时探测
    {
        let manual = '（没有说明书）';
        O.setManual('demo_write', () => '真实路径：D:\\桌面2');
        manual = O.manualFor('demo_write');
        c.ok(manual.includes('D:\\桌面2'), 'manualFor 返回该项说明书（收函数：真实路径是运行时探测的）', manual);
        c.ok(O.manualFor('demo_meta') === '', '没挂说明书的条目返回空串（不抛）');
    }

    // 7. 接线：标签通道改走注册表，且两条通道共用同一批执行实现
    const agentSrc = readFileSync(path.join(ROOT, 'web', 'js', 'agent-access.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'agent-result.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'agent-manuals.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'agent-tools.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'agent-continue.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'agent-browser.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'agent.js'), 'utf8');
    const expectOps = ['file_ls', 'file_read', 'file_write', 'file_delete', 'pc_command', 'phone', 'app_memory', 'recall_search', 'browser', 'web_search', 'agent_help'];
    const noDecl = expectOps.filter((n) => !agentSrc.includes("name: '" + n + "'"));
    c.ok(noDecl.length === 0, 'agent.js 声明了全部电脑 / 手机 / 应用操作', noDecl.join(','));
    const noWire = [
        "ElainaOps.invoke('file_ls'", "ElainaOps.invoke('file_write'", "ElainaOps.invoke('file_delete'",
        "ElainaOps.invoke('file_' + action", "ElainaOps.invoke('pc_command'", "ElainaOps.invoke('phone'",
        "ElainaOps.invoke('app_memory')",
    ].filter((s) => !agentSrc.includes(s));
    // 浏览器走的是 agentActions → runAgentBrowserOperation，不经 invoke；
    //   这条断言只钉"标签分发不直接调执行函数"，浏览器在标签侧的入口是 agentBrowserOperation。
    c.ok(agentSrc.includes('agentBrowserOperation(raw)') && agentSrc.includes('runAgentBrowserOperation(parsed)'),
        '★ 浏览器标签经统一执行器（不自己发请求）');
    c.ok(agentSrc.includes('agentWebSearchOperation(raw)') && agentSrc.includes('runAgentWebSearch({ query })'),
        '★ 搜索标签经统一执行器（不自己发请求）');
    c.ok(noWire.length === 0, '标签分发全部经 ElainaOps.invoke（不再直接调执行函数）', noWire.join(' / '));
    const execCount = (agentSrc.match(/ElainaOps\.setExec\(/g) || []).length;
    c.ok(execCount === expectOps.length, '每个操作都挂了执行实现（setExec 条数一致）', execCount + '/' + expectOps.length);

    // 8. 接线：请求侧带工具、回复侧按通道分流、隐藏消息与各条出口的过滤
    // 这几条只能靠"源码里有没有那句话"来钉：它们跨 4 个文件，而且任一条漏掉都不会
    //   当场报错 —— 表现是"模型调了工具却没人执行"或"聊天记录里多出一段没人说过的文本"，
    //   都是要跑一整轮对话才看得见的故障。
    const voiceSrc = readFileSync(path.join(ROOT, 'web', 'js', 'voice.js'), 'utf8');
    const uiSrc = readFileSync(path.join(ROOT, 'web', 'js', 'ui.js'), 'utf8');
    const dataSrc = readFileSync(path.join(ROOT, 'web', 'js', 'data-memory.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'data.js'), 'utf8');
    const coreSrc = readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');
    const unwired = [
        [agentSrc, 'insertToolResult(', 'agent.js 有 insertToolResult（结果以 role:tool 回灌）'],
        [agentSrc, 'async function runToolCalls(', 'agent.js 有 runToolCalls（执行工具调用）'],
        [voiceSrc, 'agentToolOptions()', 'voice.js 用共享构造器取"这一轮的工具选项"'],
        [voiceSrc, 'runToolCalls(repliedToolCalls', 'voice.js 在回复带 tool_calls 时执行它们'],
        [voiceSrc, 'if (!repliedToolCalls.length) window.ElainaTags.drive(response)',
            '★ 一回合只走一条通道：有工具调用就不再解析标签（两条都跑＝同一个动作执行两次）'],
        [agentSrc, 'raw = await callAI(AGENT_CONTINUE_PROMPT, agentToolOpt || undefined)',
            '★ 续跑也带工具（不带的话多步任务到第二步就没工具可用了）'],
        [agentSrc, 'raw = await callAI(prompt, agentToolOpt || undefined)',
            '★ 失败解释也带工具（它常被用来"换个路径再试一次"）'],
        [uiSrc, 'message.hidden === true) return', '隐藏消息不进可见渲染'],
        [dataSrc, "if (m.role === 'tool')", '历史映射原样带下 role:tool（含 tool_call_id）'],
        [dataSrc, 'entry.tool_calls = m.toolCalls', '历史映射原样带下 assistant 的 tool_calls'],
        [dataSrc, 'm && m.hidden !== true', '记忆摘要跳过隐藏消息（不让工具结果汇进长期记忆）'],
        // 备份/导入是"整份对话对象"落盘与读回：hidden 必须原样保留，否则导入一份
        // 做到一半的对话时，工具消息会因为没有这个标记而**冒到聊天记录里**。
        // （导出侧不需要过滤：备份就是数据本身，可见与否由渲染侧决定。）
        [dataSrc, 'state.conversations = JSON.parse(convs)', '★ 对话读回时原样保留 hidden 标记（不重建消息对象）'],
    ].filter(([src, needle]) => !src.includes(needle)).map(([, , label]) => label);
    c.ok(unwired.length === 0, '★ 工具通道接线完整（请求侧 / 分流 / 各处隐藏过滤）', unwired.join(' / '));

    // 8b2. 注册顺序：顶层 setManual / setExec 打到**还没注册**的条目会直接抛错，
    //   而顶层抛错会**中断本文件的后续代码** —— 表现是"后半段功能全没挂上"，
    //   排查时只看到一条与症状毫不相干的 "setManual 的操作还没注册"。用顺序断言钉住它。
    {
        const defineAt = agentSrc.indexOf("name: 'agent_help'");
        const manualAt = agentSrc.indexOf("ElainaOps.setManual('agent_help'");
        c.ok(defineAt > 0 && manualAt > 0 && defineAt < manualAt,
            '★ agent_help 先 define 再 setManual（顺序反了会顶层抛错并中断本文件后续代码）',
            'define@' + defineAt + ' / setManual@' + manualAt);
    }

    // 8c. 标签通道"退为降级"：只有**真的用上工具**之后才停止教标签写法
    const fallbackRules = [
        [agentSrc, 'agentToolsProven = true', '★ 判据是"真的执行过一次工具调用"（不是"发出去过 tools"）'],
        [agentSrc, 'function shouldTeachTags(', '有"提示词要不要教标签"的统一判据'],
        [dataSrc, "typeof shouldTeachTags === 'function'", 'data.js 按该判据决定教不教标签写法'],
        // 降级通道上没有 agent_help 可调（它本身是个工具），说明书只能靠宿主按意图挑着发
        [agentSrc, 'function agentIntentManualText(', '有"按用户这句话挑说明书"的统一判据'],
        [agentSrc, 'ElainaOps.opsForIntent(userText)', '判据取自 registry 的条目（不另立关键词表）'],
        [dataSrc, 'agentIntentManualText(text)', 'data.js 在降级通道按意图注入说明书（分层 / legacy 两条路）'],
    ].filter(([src, needle]) => !src.includes(needle)).map(([, , label]) => label);
    c.ok(fallbackRules.length === 0, '★ 标签退为降级通道的判据接线完整', fallbackRules.join(' / '));

    // 9. 提示词：能力清单由注册表生成（不是手写的第二份），且"做完怎么交代"有统一守则
    const promptRules = [
        [dataSrc, 'ElainaOps.indexLines()', '★ 提示词里的能力清单由注册表生成（手写第二份必然漏改）'],
        [agentSrc, 'function agentToolConductText(', '★ 跨能力的"工具使用守则"单列一段（不散进各能力说明）'],
        // 判据用**要素**而不是一整段连续字面：这条守则的措辞会随用户体验反馈调整，
        //   钉死整句会让"改了一句自然的话"就判红（本次就撞到了）。要钉的是"这三样必须被点名禁止"。
        [agentSrc, '不要出现', '守则点明正文里不许出现内部细节（工具名/参数/JSON/命令回显）'],
        [agentSrc, '工具名、参数名、JSON', '守则点名的内部细节包含工具名、参数名、JSON'],
        [agentSrc, '用**一两句自己的话**讲清结果', '守则要求操作结果用角色口吻交代（世界内包装，不讲机制）'],
        // ★ 用户实测的两个失败模式，各钉一条：
        //   ① AI 不主动调用：用户说"建个文件"，它先反问文件名、或者只说"我可以帮你做"。
        //      守则里必须有一条**什么时候该动手**的判据。
        [agentSrc, '## 什么时候动手', '守则给出「什么时候该动手」的触发判据（否则 AI 只会用嘴回答）'],
        //   ② 说了却不动手：正文写"喏，给你建好了"，但压根没发调用 —— 用户去看，什么都没有。
        [agentSrc, '说了要做，就必须真的发调用', '守则把「说」与「做」绑死（不许提前领功）'],
    ].filter(([src, needle]) => !src.includes(needle)).map(([, , label]) => label);
    c.ok(promptRules.length === 0, '★ 提示词接线完整（索引由注册表生成 + 守则统一）', promptRules.join(' / '));
}

/**
 * Agent 纯解析函数（agent-parse.js）：整体装载整个脚本，再逐个调用。
 *
 * 这里刻意**不用 extractFnFrom 抠单个函数体**：这些函数之间可以互相引用，
 * 把单个函数体抠出来单独求值，一旦以后在它们之间加一层 helper，测试就会
 * ReferenceError（而实现其实没问题）。整脚本装载是"按真实模块测"。
 */
async function caseAgentParse(c) {
    const parseSrc = readFileSync(path.join(ROOT, 'web', 'js', 'agent-parse.js'), 'utf8');
    const sandbox = { console, URL };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(parseSrc + `\n;globalThis.__parseApi = {
        recallDateHintOf, recallDiaryDateMatches, recallExcerpt,
        parsePhoneOperation, describePhoneOperation, parseBrowserTag, summarizeBrowserArgs,
        AGENT_PHONE_OPS,
    };`, sandbox);
    const A = sandbox.__parseApi;
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    c.ok(eq(A.recallDateHintOf('2026-08-11'), { y: 2026, m: 8, d: 11 })
        && eq(A.recallDateHintOf('8月11日'), { m: 8, d: 11 })
        && A.recallDateHintOf('随便一句') === null,
        '日期提示解析：完整日期 / 月日 / 非日期都正确',
        JSON.stringify([A.recallDateHintOf('2026-08-11'), A.recallDateHintOf('8月11日'), A.recallDateHintOf('随便一句')]));

    c.ok(A.recallDiaryDateMatches({ y: 2026, m: 8, d: 11 }, '2026年8月11日')
        && A.recallDiaryDateMatches({ y: 2026, m: 8, d: 11 }, '2026-08-11')
        && !A.recallDiaryDateMatches({ y: 2026, m: 8, d: 11 }, '2026-08-12'),
        '日记日期匹配：中文/短横线都算同一天，不同日不误判');

    const excerpt = A.recallExcerpt('x'.repeat(80) + 'KEY' + 'y'.repeat(80), 'key', 40);
    c.ok(excerpt.length <= 42 && excerpt.startsWith('…') && excerpt.endsWith('…'),
        '摘录限长并带首尾省略号（超长时不是原样返回）', JSON.stringify(excerpt));

    c.ok(eq(A.parsePhoneOperation('手机点击 100 200'), { action: '手机点击', args: '100 200' })
        && eq(A.parsePhoneOperation('手机应用列表'), { action: '手机应用列表', args: '' })
        && A.parsePhoneOperation('不是手机操作') === null,
        '手机操作解析：动作 + 参数正确，认不出返回 null',
        JSON.stringify([A.parsePhoneOperation('手机点击 100 200'), A.parsePhoneOperation('手机应用列表')]));

    c.ok(A.describePhoneOperation({ action: '手机写文件', args: 'a.txt|内容' }) === '写入：a.txt'
        && A.describePhoneOperation({ action: '手机截图', args: '' }) === '截取当前屏幕画面'
        && A.describePhoneOperation({ action: '不存在', args: '' }) === '',
        '手机操作描述：已知动作有文案，未知动作返回空串');

    c.ok(eq(A.parseBrowserTag('浏览器打开 https://example.com'), { action: 'goto', url: 'https://example.com' })
        && eq(A.parseBrowserTag('浏览器'), { action: 'snapshot' })
        && eq(A.parseBrowserTag('点击 3'), { action: 'click', ref: '3' })
        && eq(A.parseBrowserTag('输入 2|你好'), { action: 'type', ref: '2', text: '你好' })
        && A.parseBrowserTag('看不懂') === null,
        '浏览器标签解析：goto / snapshot / click / type / null 全覆盖',
        JSON.stringify([A.parseBrowserTag('浏览器打开 https://example.com'), A.parseBrowserTag('浏览器')]));

    c.ok(A.summarizeBrowserArgs({ url: 'https://x' }) === 'https://x'
        && A.summarizeBrowserArgs({ ref: '3' }) === '[3]'
        && A.summarizeBrowserArgs({ ref: '3', text: 'abc' }) === '[3] ← abc'
        && A.summarizeBrowserArgs({}) === '',
        '浏览器参数摘要：url / ref / ref+text / 空');

    // 结构：解析函数只在 agent-parse.js 定义，且该脚本在 agent.js 之前加载
    const agentSrc = readFileSync(path.join(ROOT, 'web', 'js', 'agent.js'), 'utf8');
    const idxHtml = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    const ip = idxHtml.indexOf('/js/agent-parse.js');
    const ia = idxHtml.indexOf('/js/agent.js');
    c.ok(ip > 0 && ia > ip, 'agent-parse.js 在 agent.js 之前加载', 'parse@' + ip + ' agent@' + ia);
    c.ok(['parsePhoneOperation', 'describePhoneOperation', 'parseBrowserTag', 'summarizeBrowserArgs',
        'recallExcerpt', 'recallDateHintOf', 'recallDiaryDateMatches'].every((n) => !new RegExp('function ' + n + '\\(').test(agentSrc)),
        '这些纯解析函数已集中到 agent-parse.js（agent.js 不再重复定义）');
}

// 按命令行参数过滤用例（便于只跑其中一段）
const only = process.argv[2];
const allCases = [
    { name: '三档 AI 权限', fn: caseAccess },
    { name: '自动续跑', fn: caseContinue },
    { name: '系统悬浮窗', fn: caseOverlay },
    { name: '文件位置与目录归类', fn: casePaths },
    { name: '手机操作标签', fn: casePhone },
    { name: 'strict 路由决策表', fn: caseStrictRoute },
    { name: '标签协议解耦', fn: caseTags },
    { name: '操作注册表', fn: caseOps },
    { name: 'Agent 纯解析函数（agent-parse.js）', fn: caseAgentParse },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: 'AI Agent（权限 / 续跑 / 悬浮窗 / 路径 / 手机 / 路由 / 标签 / 操作注册表）',
    usage: 'node scripts/check-agent.mjs [用例名子串]',
    cases,
});

