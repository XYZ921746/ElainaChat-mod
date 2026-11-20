// AI Agent（手机操作 / 文件操作 / 续跑 / 授权 / 标签协议）的回归检查。
// 每段用例在自己的函数作用域里跑；失败信息形如「用例名 :: 断言」。
// 用法：node scripts/check-agent.mjs          跑全部
//       node scripts/check-agent.mjs 续跑     只跑名字含该子串的用例

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFrontend, readWebFile } from './frontend-sources.mjs';
import { runChecks, ROOT, startGoServer } from './check-harness.mjs';
import { extractFunction as extractFnFrom, extractVariable, extractTopLevelFunctions, makeVmSandbox } from './check-source.mjs';

// 安卓原生工程与宿主同仓库（dist/Android/），不再依赖「放在上一级」的目录布局。
const ANDROID_ROOT = path.join(ROOT, 'dist', 'Android');
const JAVA_DIR = path.join(ANDROID_ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'elainachat', 'mod');
const PLUGIN_JAVA = path.join(JAVA_DIR, 'ElainaShellPlugin.java');
const MANIFEST = path.join(ANDROID_ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

// 1. 三档 AI 权限（strict / auto / full）：手机操作全部不弹确认，风险由设置页免责声明承担；
//    电脑命令 strict 每条问 / auto 只问危险 / full 从不问；stopRequested 时任何档位一律拒绝。

async function caseAccess(c) {
    const html = readFrontend();

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
        const cmd = await ask('手机命令');
        c.ok(cmd.asked === false, `${access} 档下「手机命令」也不弹确认（用户选择全部放行 + 免责声明）`,
            cmd.asked ? '又加回确认了？' : '');
    }

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

    state.settings.agentAccess = 'full';
    rt.beginBatch();
    rt.requestStop('测试停止');
    const stopped = await ask('手机点击');
    c.ok(stopped.allowed === false, '★ 已停止时任何档位都拒绝执行（停止优先于档位）');
}

// 2. 自动续跑：失败路径调 callAI() 自我解释重试，成功路径只插结果不调 —— AI 就此停住。
//    本段锁三点：熔断提示不再触发续跑；预算按用户请求重置；收尾判据不靠定时器（drive() 异步）。

async function caseContinue(c) {
    const html = readFrontend();
    const extractFn = (name) => extractFnFrom(html, name);

    const insertFn = extractFn('insertAgentResult');
    c.ok(/options\.continueLoop === true/.test(insertFn),
        'insertAgentResult 默认**不**续跑，只有显式 continueLoop:true 才续跑');
    c.ok(/scheduleAgentContinue\(\)/.test(insertFn),
        'insertAgentResult 里确实会触发续跑（这是原 bug 的修复点）');

    // 续跑必须"选择加入"：多数调用点是被拒绝的结果，触发续跑会形成无效循环。
    // 判据用白名单而非数量：数量断言会误伤新增合法路径，也挡不住等量替换。
    const ALLOWED_CONTINUE_SITES = [
        { re: /insertAgentResult\(resultText, \{ continueLoop: true, asContext: true \}\)/, label: '文件操作成功' },
        { re: /insertAgentResult\(m, \{ continueLoop: true, asContext: true, progress: false \}\)/, label: '重复动作被拦（让模型换策略）' },
        { re: /insertAgentResult\(nodeRef\.error, \{ continueLoop: true, asContext: true, progress: false \}\)/, label: '元素引用过期 / 未找到（让模型重读）' },
        { re: /insertAgentResult\(opResult, \{ continueLoop: true, asContext: true, progress, observation: true, currentScreen, step: stepNo, summary: stepSummary \}\)/, label: '手机操作成功' },
        { re: /insertAgentResult\('命令执行结果：\\n' \+ text, \{ continueLoop: true, asContext: true \}\)/, label: '电脑命令成功' },
        { re: /insertAgentResult\(text, \{ continueLoop: true, asContext: true \}\)/, label: '浏览器操作成功' },
        // 联网搜索与浏览器共用同一插入形态，这条登记保持"新增成功路径必须显式登记"纪律。
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
    c.ok(/const \w+ = await execPhoneOperation\(parsed\);/.test(html)
        && /insertAgentResult\(opResult, \{ continueLoop: true, asContext: true, progress, observation: true, currentScreen, step: stepNo, summary: stepSummary \}\)/.test(html),
        '手机操作成功处开启续跑（并带上"是否真的推进"的 progress）');
    // 成功结果只做上下文不进气泡：可见插入会让同一件事出现两次、且排在正文前。
    c.ok(/asContext === true/.test(insertFn) && /if \(asContext\) msg\.hidden = true;/.test(insertFn),
        '★ 成功结果标记 hidden（只进过程区，不占聊天气泡）');
    c.ok(/if \(!asContext && state\.currentConversationId === conv\.id\) renderMessage\(msg\);/.test(insertFn),
        '★ asContext 时**不**渲染可见气泡');
    const visibleSites = continueLines.filter((l) => !/asContext: true/.test(l));
    c.ok(visibleSites.length === 0,
        '★ 所有开启续跑的成功路径都带 asContext: true',
        visibleSites.length ? '漏了：\n      ' + visibleSites.map((l) => l.trim()).join('\n      ') : '');

    // 可见性规则按"用户知不知道"划线：亲手做过的决定只进过程区，不知道的失败必须可见。
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
    const MUST_STAY_VISIBLE = [
        // 失败可能先经 agentSessionRecordFailure 路由：会话模式回灌子代理，一体模式仍落 insertAgentResult 可见气泡。
        { re: /(?:insertAgentResult|agentSessionRecordFailure)\('手机操作失败：' \+ [^;]*\);/, label: '手机操作失败' },
        { re: /insertAgentResult\('操作失败：' \+ shortReason/, label: '文件操作失败' },
    ];
    const hiddenFailures = MUST_STAY_VISIBLE.filter((d) => !d.re.test(html)).map((d) => d.label);
    c.ok(hiddenFailures.length === 0,
        '★ 用户不知道的失败仍显示在聊天区（不许藏进可折叠区）',
        hiddenFailures.length ? '被藏了：' + hiddenFailures.join('、') : '');
    c.ok(!/已跳过[^)]*continueLoop: true/.test(html), '「已跳过」类结果不续跑');
    c.ok(!/已取消写入[^)]*continueLoop: true/.test(html), '「已取消写入」不续跑');
    c.ok(!/操作失败[^)]*continueLoop: true/.test(html), '失败说明不续跑');

    // 二、死循环防护：步数上限会腰斩长任务，改用"连续无进展熔断"；熔断提示不得再触发续跑。
    const loopFn = extractFn('continueAgentLoop');
    c.ok(!/AGENT_CONTINUE_MAX_STEPS/.test(html), '★ 续跑不做步数硬限制（AGENT_CONTINUE_MAX_STEPS 这类常量不应残留）');
    c.ok(/AGENT_STALL_FUSE/.test(loopFn), '续跑有"连续无进展"熔断');
    const capBlock = loopFn.match(/if \(agentStalledSteps >= AGENT_STALL_FUSE\)[\s\S]*?\n {4}\}/);
    c.ok(!!capBlock, '找得到熔断分支');
    c.ok(!!capBlock && !/continueLoop: true/.test(capBlock[0]),
        '熔断时的提示不开启续跑（否则"熔断→插提示→又调度→又熔断"无限循环）');
    c.ok(!!capBlock && /\breturn;/.test(capBlock[0]),
        '熔断后立即 return（不再发起请求）');
    c.ok(!!capBlock && /(agentFinishRun\('fused'\)|rt\.endRun\(\))/.test(capBlock[0]),
        '熔断时收尾并收起运行状态条（否则状态条会一直挂着）');
    c.ok(/agentStalledSteps = 0/.test(insertFn) && /agentStalledSteps \+= 1/.test(insertFn),
        '★ 熔断计数按"有没有进展"记：成功清零、其余累加（判据是 continueLoop）');

    // 二之二、"思考期"不许收起悬浮窗：续跑定时器触发即清成 null，而 callAI 要跑好几秒，
    //    收起定时器检查时守卫失守，整段思考期浮层被收掉。
    c.ok(/agentContinueBusy = true/.test(loopFn),
        '★ 模型调用前标记"管道忙"（思考期不许收起）');
    c.ok(/finally \{[\s\S]{0,60}agentContinueBusy = false/.test(loopFn),
        '★ 用 finally 清标志（任何出口都不会漏，否则会永久挂着不收）');
    c.ok(/function agentPipelineBusy\(\)/.test(html) && /agentContinueTimer\) \|\| agentContinueBusy/.test(html),
        '★ 统一的"忙"判据：续跑待发 / 模型在想 / 还有操作在飞');
    const hideFn = extractFn('scheduleOverlayHide');
    c.ok(/agentPipelineBusy\(\)/.test(hideFn) && !/phoneOpsInFlight > 0/.test(hideFn),
        '★ 收起悬浮窗前统一判 agentPipelineBusy（不再各处自己写一份漏项的判据）');

    const resetFn = extractFn('resetAgentContinueBudget');
    c.ok(/agentContinueUsed = 0/.test(resetFn), '重置函数把已用步数归零');
    c.ok(/agentStalledSteps = 0/.test(resetFn), '重置函数把"连续无进展"计数也清零（否则熔断会跨请求累计）');
    c.ok(/clearTimeout\(agentContinueTimer\)/.test(resetFn), '重置时也清掉待触发的续跑定时器');
    const handleFn = extractFn('handleUserInput');
    c.ok(/resetAgentContinueBudget\(\)/.test(handleFn),
        '每条新的用户消息都重置预算（否则整个会话共享 8 步，用完永远不再续跑）');

    c.ok(/const hasMoreOps = agentTagKeepsRunning\(rawText\);/.test(loopFn),
        '用**同步**判断回复里有没有会续跑的标签（drive() 是异步的，靠定时器判断会误判）');
    c.ok(/const hasAnyTags = \/\\\[操作\[:：\]\/\.test\(rawText\)/.test(loopFn),
        '纯表现标签（通话 / 记忆等）单独识别（它们不会产生下一步结果）');
    c.ok(/hasMoreOps && window\.ElainaTags/.test(loopFn) && /drive\(rawText\)/.test(loopFn)
        && /return;\s*\/\/ 后续由新一轮结果接力/.test(loopFn),
        '有后续操作时 return，交给下一轮 insertAgentResult 接力');
    c.ok(/agentFinishRun\('completed'/.test(loopFn),
        '没有操作标签时走收尾总结（AI 认为任务完成）');

    // 四之二、续跑请求失败不得被当成"任务完成"：失败时 raw 被吞成空串，空串走 endRun
    //    → 浮层收起、对话零提示、熔断计数也不涨。
    c.ok(/let continueError = null;/.test(loopFn),
        '★ 用独立的 continueError 记录续跑失败（不再把失败吞成空串混进"完成"分支）');
    c.ok(/continueError = e/.test(loopFn) || /continueError = e2/.test(loopFn),
        '★ 捕获到的失败真的被记进 continueError');
    // 失败分支必须在 hasMoreOps 真实判定之前 return，否则仍会掉进"完成"路径。
    // 注释块里也写着 `const hasMoreOps`，indexOf 会命中那次出现，所以先剥注释再定位。
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
        // 判据放宽到"调用点带上续跑提示词，后面还可以跟别的实参"——
        // 工具通道会在这句后面再传一组请求选项（见 agent.js 的 agentToolOptions）。
        const calls = (loopFn.match(/callAI\(continuePrompt/g) || []).length;
        c.ok(calls >= 2, '★ 续跑失败会**自动重试一次**（抖动/限流能自愈）', `callAI 调用点 ${calls} 处`);
        c.ok(/await new Promise\(\(r\) => setTimeout\(r, \d+\)\)/.test(loopFn),
            '★ 重试前先等一会儿（立刻重试往往撞上同一个瞬时故障）');
    }
    c.ok(/续跑失败/.test(loopFn) && /没有\*\*完成|没有完成/.test(loopFn),
        '★★ 失败时如实告知（明确写"任务没有完成"，不让用户以为做完了）');
    c.ok(/continueLoop: false/.test(loopFn.split('if (continueError) {')[1]?.slice(0, 1200) || ''),
        '★ 失败说明不触发续跑（否则会绕过它自己的重试预算、变成反复失败刷屏）');
    {
        const errBlock = loopFn.slice(loopFn.indexOf('let continueError = null;'), loopFn.indexOf('if (continueError) {'));
        const haltInBlock = (errBlock.match(/isHalted\(\)\) return;/g) || []).length;
        c.ok(haltInBlock >= 1, '★ 重试前后也检查 isHalted（用户按停止后不再白试）', `块内检查 ${haltInBlock} 次`);
    }

    const haltedChecks = (loopFn.match(/isHalted\(\)\) return;/g) || []).length;
    c.ok(haltedChecks >= 2,
        '续跑前后都检查 isHalted（用户按停止后绝不能再自动往下走）', `实际检查 ${haltedChecks} 次`);
    c.ok(/rt\.isHalted/.test(loopFn), '续跑入口就检查停止标志');

    c.ok(/if \(!rt\.isRunning\(\)\) rt\.beginRun\(\)/.test(loopFn),
        '只在未运行时 beginRun（无条件调用会清空"本次已授权"，导致反复弹确认）');

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

    c.ok(/AGENT_FAILURE_MAX_RETRY/.test(html), '失败重试预算仍在');
    c.ok(/explainAgentFailure/.test(html), 'explainAgentFailure 仍在');
    const failFn = extractFn('explainAgentFailure');
    c.ok(/callAI\(prompt/.test(failFn), '失败路径仍然会调 callAI（AI 自己解释+纠正）');

    // 续跑收尾渲染漏了 removeThinkingMessage 的几步："正在想"气泡挂着压住新回复，看起来像没回。
    // 渲染逻辑已集中到 appendAgentVisibleMessage（完成与停止共用），判据改看那里。
    const appendFn = extractFn('appendAgentVisibleMessage');
    c.ok(/removeThinkingMessage\(\)/.test(appendFn),
        '收尾渲染前移除"正在想"气泡（不移除会一直挂着，回复看起来没出现）');
    c.ok(/state\.currentConversationId === conv\.id && !state\.notesMode && !state\.diaryMode/.test(appendFn),
        '渲染前判当前会话与 notes/diary 模式（与 commitAiMessageOnce 一致）');
    c.ok(/!document\.getElementById\('msg-' \+ safeAttrId\(msg\.id\)\)/.test(appendFn)
        || /!document\.getElementById\(`msg-\$\{safeAttrId\(msg\.id\)\}`\)/.test(appendFn),
        '渲染前防重复插入同一节点（幂等）');
    c.ok(/state\.voiceState = 'idle'/.test(loopFn), '续跑后把语音状态复位');
    c.ok(/updateUI\(\)/.test(loopFn), '续跑后刷新 UI');

    // postJsonFromDevice 走 /api/relay 中转，相对路径 new URL() 解析失败（"地址无效"）；
    //    同源接口 /api/agent/* 必须走 fetch。
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

    // 执行实现必须返回结果对象，不能裸 return：runToolCalls 把 undefined 当「没有返回结果」，
    //    模型会把成功读成失败。
    const agentSrc2 = readWebFile('js/agent-phone.js') + '\n'
        + readWebFile('js/agent-nl.js') + '\n'
        + readWebFile('js/agent-files.js') + '\n'
        + readWebFile('js/agent-tools.js') + '\n' + readWebFile('js/agent-continue.js')
        + '\n' + readWebFile('js/agent.js');
    const voiceSrc2 = readWebFile('js/composer.js') + '\n' + readWebFile('js/voice.js');
    const uiSrc2 = readWebFile('js/process.js') + '\n' + readWebFile('js/conversations.js') + '\n' + readWebFile('js/ui.js');
    // extractFnFrom 的大括号配平会被注释/字符串里的括号带偏，这里改用下一个顶层
    // async function 作边界。
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

    // 同一个动作只记一行过程：runToolCalls 已记过一行，实现再记会出现两条时间线。
    c.ok(/async function doAgentFile\(action, \{ path, content \} = \{\}, access, traceItem\)/.test(agentSrc2),
        '★ doAgentFile 接受外层 traceItem（复用那一行）');
    c.ok(/const ownTrace = !traceItem;/.test(agentSrc2),
        '★ 只在没有外层记录时才自己建行（标签通道）');
    c.ok(/Object\.assign\(\{\}, ctx, \{ traceItem \}\)/.test(agentSrc2),
        '★ runToolCalls 经 ctx 把 traceItem 交给实现');
    c.ok(/doAgentFile\('write', args, ctx\.access, ctx\.traceItem\)/.test(agentSrc2),
        '★ setExec 把 traceItem 传给实现');

    // 参数形状两条通道都用 JSON：中文散文没法按键值渲染，两通道会长得不一样。
    c.ok(!/路径：\$\{path\}/.test(fileFn),
        '★ 参数不再写成中文散文（否则时间线无法按键值渲染）');
    c.ok(/args: JSON\.stringify\(action === 'write'/.test(fileFn),
        '★ 文件操作参数用 JSON（与工具通道同形）');

    // 先做再统一说：正文若在工具执行前渲染，用户会先看到"已经建好了"再看到失败。
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

    // 工具跑完只记账不渲染，等续跑回来再定：有新正文 replacePendingToolReply() 取代
    //    "动手前"那句话，没有则 revealPendingToolReply() 兜底放出。
    c.ok(/function agentMarkPendingReply\(/.test(voiceSrc2), '★★ 有"先记账不渲染"的入口');
    c.ok(/function replacePendingToolReply\(/.test(voiceSrc2),
        '★★ 续跑的新正文会取代那句"动手前"的话（不是并排两条）');
    c.ok(/function settlePendingToolReply\(/.test(voiceSrc2),
        '★★ 有统一的收尾决定（取代 or 兜底放出）');
    c.ok(/settlePendingToolReply\(true\)/.test(agentSrc2),
        '★★ 续跑拿到正文时走"取代"分支');
    c.ok(/settlePendingToolReply\(false\)/.test(agentSrc2),
        '★★ 续跑没正文时走"兜底放出"分支（收尾与续跑失败两处）');
    c.ok(/getElementById\(`msg-\$\{safeAttrId\(id\)\}`\)\) return false;/.test(voiceSrc2),
        '★★ 已经显示过的那句话不删（不篡改用户刚读到的内容）');

    // 先做再统一说：中间正文不逐条发给用户，只在任务完成 / 停止时写一条总结。
    c.ok(/const suppressReply = repliedToolCalls\.length > 0 \|\| hasTagOps \|\| nudged;/.test(voiceSrc2),
        '★★ 有动作 / 需要催办时中间正文不外发');
    c.ok(/const shouldPersistReply = !suppressReply \|\| repliedToolCalls\.length > 0;/.test(voiceSrc2),
        '★★ 中间正文不落库；工具调用消息例外（协议要求成对）');
    c.ok(/if \(suppressReply\) \{[\s\S]{0,240}?commitAiMessageOnce\(\);[\s\S]{0,40}?return;/.test(voiceSrc2),
        '★★ 中间正文不配音（用户看不到过程话）');
    c.ok(/function agentFinishRun\(/.test(agentSrc2), '★★ 有统一的运行收尾入口');
    c.ok(/agentFinishRun\('completed'/.test(agentSrc2), '★★ 任务完成走收尾总结');
    const runtimeSrc = readWebFile('js/agent-runtime.js');
    c.ok(/agentFinishRun\('stopped'\)/.test(runtimeSrc), '★★ 用户停止也走收尾总结');
    c.ok(/function appendAgentVisibleMessage\(/.test(agentSrc2), '★★ 收尾只写一条可见消息');
    c.ok(/agentFinishRun\('fused'/.test(agentSrc2) && /agentFinishRun\('error'/.test(agentSrc2),
        '★★ 熔断 / 续跑失败也有收尾总结');
    c.ok(/function bringAppToFront\(/.test(agentSrc2) && /\.bringToFront\(\)/.test(agentSrc2),
        '★★ 任务结束自动回到应用');

    // 续跑提示词：执行期只发标签，收尾用 [完成] 写一段，不再承接不可见的中间话。
    const continuePrompt = (agentSrc2.split('const AGENT_CONTINUE_PROMPT')[1] || '').split('let agentContinueUsed')[0];
    c.ok(/\[完成\]/.test(continuePrompt),
        '★★ 续跑提示词给出明确的收尾标记 [完成]');
    c.ok(/不要写任何旁白|不要写任何旁白、解释或安抚/.test(continuePrompt),
        '★★ 明确禁止执行期旁白（用户看不到）');
    c.ok(/一段/.test(continuePrompt), '★★ 收尾要求一段总结，不是一条条发');

    // runToolCalls 把返回值 `ok` 写进过程行：成功路径也必须返回结果对象，
    //    否则模型收到"没有返回结果"、ok 行被覆盖成 error。判据查函数有无返回值。
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
    c.ok(/const traced = traceItem && traceItem\.state === 'ok';/.test(agentSrc2),
        '★★ 漏写返回值时以过程行为准（不许把成功覆盖成失败）');

    // 过程区是临时 DOM，loadConversation 清空重画时整体消失 —— 必须持久化到消息上。
    c.ok(/msg\.turnTrace = \{/.test(uiSrc2), '★★ 收尾时把过程挂到消息上');
    c.ok(/function restoreTurnProcessFor\(message\)/.test(uiSrc2), '★★ 有还原函数');
    c.ok(/restoreTurnProcessFor\(message\)/.test(uiSrc2), '★★ 重画消息时调用还原');
    // 存**数据**而不是 HTML：HTML 依赖当时的展开态与主题，存下来会越用越脏
    c.ok(/timeline: activeTurnTrace\.timeline/.test(uiSrc2)
        && /tools: activeTurnTrace\.tools/.test(uiSrc2),
        '★★ 存的是数据（timeline/tools/phases），不是 HTML 字符串');
    c.ok(!/turnTrace\s*===\s*[^;]*innerHTML/.test(uiSrc2), '★★ 没有把 innerHTML 存进去');
    c.ok(/turn-process-\$\{safeAttrId\(message\.id\)\}`\)\) return;/.test(uiSrc2),
        '★★ 重复渲染不会插第二份过程区');

    // maybeAutoFileWrite 在发给 AI 前按正则直接执行：绕过 AI、正则误伤、与授权脱节。
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

// 3. 系统悬浮窗：授权弹窗要切回应用点允许，会把目标 App 切后台、点击落错位置 → 死循环。
//    原生层加悬浮窗就地确认；前端优先走悬浮窗、不可用回退应用内弹窗。全程只读源码。

async function caseOverlay(c) {
    /* 原生工程在 dist/Android/ 下；被裁剪过的副本可能没有它 —— 这是环境，不是缺陷，跳过。 */
    if (!existsSync(MANIFEST)) {
        console.log('  --   跳过：没有 dist/Android 原生工程（工作区被裁剪时正常）');
        return;
    }
    const html = readFrontend();
    const OVERLAY_JAVA = path.join(JAVA_DIR, 'ElainaOverlay.java');

    const mf = readFileSync(MANIFEST, 'utf8');
    c.ok(mf.includes('android.permission.SYSTEM_ALERT_WINDOW'),
        'AndroidManifest 声明了 SYSTEM_ALERT_WINDOW（悬浮窗权限）');

    c.ok(existsSync(OVERLAY_JAVA), 'ElainaOverlay.java 存在');
    if (existsSync(OVERLAY_JAVA)) {
        const src = readFileSync(OVERLAY_JAVA, 'utf8');

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

    {
        const src = readFileSync(PLUGIN_JAVA, 'utf8');
        for (const m of ['overlayStatus', 'requestOverlay', 'showOverlay', 'updateOverlay', 'askOverlayApproval', 'hideOverlay']) {
            c.ok(new RegExp('public\\s+void\\s+' + m + '\\s*\\(\\s*PluginCall').test(src),
                '插件暴露 ' + m + '()');
        }
        c.ok(src.includes('notifyListeners("overlayStop"'), '点停止时发 overlayStop 事件');
        c.ok(src.includes('notifyListeners("overlayApproval"'), '点允许/拒绝时发 overlayApproval 事件');
    }

    {
        c.ok(/function\s+requestApprovalViaOverlay\s*\(/.test(html), '有 requestApprovalViaOverlay()');
        c.ok(/await\s+requestApprovalViaOverlay\s*\(/.test(html), 'requestApproval 里真的调了它');

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

    {
        c.ok(/rt\.syncOverlayWithVisibility\s*\(/.test(html), '开始操作时按可见性同步浮层');
        c.ok(/rt\.hideOverlay\s*\(/.test(html), '结束/停止时收起浮层');
        c.ok(/function\s+syncOverlayWithVisibility\s*\(/.test(html),
            '有「应用内状态条 ↔ 系统浮层」切换函数');
        c.ok(/visibilityState === 'hidden'/.test(html), '只在应用不可见时才显示系统浮层');
        c.ok(/addEventListener\('visibilitychange'/.test(html), '应用切后台 / 回前台会自动切换');

        c.ok(/requestStop[\s\S]{0,300}hideOverlay/.test(html) || /hideOverlay[\s\S]{0,200}requestStop/.test(html),
            '停止流程里会收起浮层');
    }

    {
        c.ok(html.includes('overlayEnableBtn'), '设置里有「开启悬浮窗」按钮');
        c.ok(html.includes('overlayStatusText'), '设置里有权限状态显示');
        c.ok(/function\s+refreshOverlayStatus\s*\(/.test(html), '有 refreshOverlayStatus()');
        c.ok(/function\s+enableOverlay\s*\(/.test(html), '有 enableOverlay()（跳系统设置）');
        c.ok(/need-permission/.test(html), '识别"需要授权"');

        const runStart = html.indexOf('async function runAgentPhoneOperation(');
        const runEnd = html.indexOf('/* ==== 文件:', runStart);
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

    {
        // 点「停止」时 overlayApprovalPending 没人 resolve → await 永远挂住，"点了停止没反应"。
        const stopFn = html.slice(html.indexOf('function requestStop(reason)'), html.indexOf('function assertNotStopped()'));
        c.ok(/overlayApprovalPending/.test(stopFn), 'requestStop 里了结了等待中的浮层确认');
        c.ok(/pending\(false\)/.test(stopFn), '以"未允许"结束那个 Promise');

        const listener = html.slice(html.indexOf("addListener('overlayStop'"), html.indexOf("addListener('overlayApproval'"));
        c.ok(/overlayApprovalPending/.test(listener), '浮层「停止」回调里也了结了它');
        c.ok(/pending\(false\)/.test(listener), '同样以"未允许"结束');
    }

    {
        const start = html.indexOf('async function requestApproval(');
        const end = html.indexOf('function requestApprovalViaOverlay(');
        const body = start > 0 ? html.slice(start, end) : '';
        c.ok(/risk\s*!==\s*'dangerous'/.test(body), 'dangerous 操作不受"不询问"策略影响（仍然必问）');
        c.ok(/AGENT_RISK/.test(html), '风险分级表仍在使用');
    }

    {
        // 用途：AI 用「模块」后端时跑在独立虚拟副屏上，物理主屏看不到 ——
        // 这个窗口把副屏画面搬进应用，让用户知道 AI 在点什么。
        c.ok(/id="screenWatchPanel"/.test(html), '有副屏监视窗 DOM');
        c.ok(/id="screenWatchImg"/.test(html), '有画面元素');
        c.ok(/id="screenWatchPowerBtn"/.test(html), '有副屏启停按钮');
        c.ok(/function openScreenWatch\(/.test(html) && /function closeScreenWatch\(/.test(html),
            '有打开/关闭函数');
        c.ok(/SCREEN_WATCH_INTERVAL/.test(html), '有自动刷新间隔常量');

        // slice 起点命中的是 achievements.js 的同名 render()（加载更靠前），切片偏宽；
        //    断言真实判据必须限定在 agentRuntime 区间内取，否则会匹配同名片段假通过。
        const rtStart = html.indexOf('const agentRuntime = (function ()');
        const rtEnd = html.indexOf('window.agentRuntime = agentRuntime;');
        const agentRenderFn = (rtStart >= 0 && rtEnd > rtStart)
            ? html.slice(rtStart, rtEnd).slice(html.slice(rtStart, rtEnd).indexOf('function render()'))
            : '';
        const renderFn = html.slice(html.indexOf('function render()'), html.indexOf('function beginBatch()'));
        c.ok(/agentWatchBtn/.test(renderFn), '运行状态条里的「看画面」按钮由 render 控制');
        c.ok(/__lastAgentBackend/.test(agentRenderFn), '按**实际**用过的后端决定是否显示（"自动"模式下也要能判断）');
        // 判据必须读本轮 runModeDecision（持久化默认值与从不重置的 used 都会误报"模块"）；
        //    源码注释里也写着 runModeDecision，断言前先剥注释，只匹配真实代码。
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

        const openFn = html.slice(html.indexOf('function openScreenWatch()'), html.indexOf('function closeScreenWatch()'));
        // 断言"真的会执行"，不能只断言字符串出现过 —— `false && closeSettingsPanel()` 也能匹配到
        // 名字，那种写法等于没关（变异测试抓到过这个假阳性）。
        c.ok(/if \(typeof closeSettingsPanel === 'function'\) closeSettingsPanel\(\);/.test(openFn),
            '★ 打开监视窗前先关掉设置面板（同为 100002 层，否则层叠顺序不确定）');

        c.ok(/#customModal \{ z-index: 100020 !important; \}/.test(html),
            '确认框层级（100020）高于监视窗（100002）与全部弹层');
        c.ok(/#screenWatchPanel \{ z-index: 100002 !important; \}/.test(html),
            '监视窗层级显式声明为 100002');
    }

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

// 4. 文件操作的「真实位置」解析与目录归类（真起一次 Go 服务端，打真实 HTTP 断言）
//    桌面可被移动/OneDrive 重定向，服务端从注册表读真实位置；junction 既不是目录也不是文件。

async function casePaths(c) {
    const check = (label, actual, expected) => {
        c.ok(actual === expected, label,
            actual === expected ? '' : 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected));
    };
    const note = (label, text) => console.log(`  --   ${label}: ${text}`);

    const projectRoot = ROOT;
    // 数据目录必须隔离：否则一旦本机设置过访问密码，本机请求也会被要求登录，
    // 这个用例就全变成 401（与本用例要测的路径解析无关）。
    const dataTmp = mkdtempSync(path.join(os.tmpdir(), 'elaina-agent-paths-'));
    const srv = await startGoServer({ env: { DATA_DIR: dataTmp, LOG_DIR: path.join(dataTmp, 'logs') } });
    if (!srv) {
        c.ok(true, '环境性跳过：本机没有 Go 工具链，起不了真实服务端');
        try { rmSync(dataTmp, { recursive: true, force: true }); } catch { /* ignore */ }
        return;
    }

    const base = srv.base;
    const api = async (p) => {
        const res = await fetch(base + p);
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const ls = (p, access) => api('/api/agent/ls?access=' + access + '&path=' + encodeURIComponent(p));

    try {
        if (!srv.up) throw new Error('Go 服务端没能启动：\n' + srv.bootLog);

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

        // 三档无路径边界；硬边界是认证（本机免密测不到，由 check-security.mjs 覆盖）。
        const noAccess = await api('/api/agent/roots');
        check('不传 access 时也能拿到真实路径（三档无路径差别）',
            (noAccess.body?.roots || []).some((r) => r.path !== undefined), true);

        const byAlias = await ls('%DESKTOP%', 'full');
        check('%DESKTOP% 解析到真实桌面', byAlias.body?.path, desktop?.path);
        const byTilde = await ls('~desktop', 'full');
        check('~desktop 解析到同一个路径', byTilde.body?.path, desktop?.path);
        const byProfile = await ls('%USERPROFILE%', 'full');
        check('%USERPROFILE% 解析到用户目录', byProfile.body?.path, os.homedir());

        const midAlias = await api('/api/agent/read?access=full&path='
            + encodeURIComponent('%DESKTOP%' + path.sep + '_elaina_check_missing_.txt'));
        check('别名后接文件名时也展开（404 里能看到展开后的完整路径）',
            String(midAlias.body?.message || '').includes(desktop?.path || '\u0000'), true);

        const guessed = path.join(os.homedir(), 'Desktop');
        if (statSync(guessed, { throwIfNoEntry: false })?.isDirectory()) {
            note('跳过「猜错路径」断言', `${guessed} 在这台机器上真实存在，构不成"猜错"场景`);
        } else {
            const bad = await ls(guessed, 'full');
            check('猜错的桌面路径返回 404', bad.status, 404);
            check('404 的文案里带着真实桌面路径', String(bad.body?.message || '').includes(desktop?.path || '\u0000'), true);
        }

        const home = await ls(os.homedir(), 'full');
        const entries = home.body?.entries || [];
        check('能列出用户目录', entries.length > 0, true);
        check('每个条目的 type 只能是 dir/file', entries.every((e) => e.type === 'dir' || e.type === 'file'), true);
        check('每个条目都带 link 布尔标记', entries.every((e) => typeof e.link === 'boolean'), true);

        const misclassified = entries
            .filter((e) => e.type === 'file')
            .filter((e) => statSync(path.join(os.homedir(), e.name), { throwIfNoEntry: false })?.isDirectory() === true)
            .map((e) => e.name);
        check('被标成 file 的条目里没有实际是目录的', misclassified.length, 0);
        if (misclassified.length) console.log('        误判:', misclassified);
        note('识别到的链接（junction）', entries.filter((e) => e.link).map((e) => e.name).join('、') || '（本机没有）');

        // 区别只在"要不要问"与"能不能删"（由上面的授权用例覆盖）。
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

        // 用 core.js + agent.js 顶层函数整体环境跑：helper 不在场时会静默走 typeof 兜底，
        //   测不到真实逻辑。
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
        srv.stop();
        try { rmSync(dataTmp, { recursive: true, force: true }); } catch { /* ignore */ }
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
    // 分发权在宿主自有模块 web/js/agent-tags.js：Live2D 是可卸 mod，不能持有 [操作:] 分发。
    const tags = readFileSync(path.join(root, 'web', 'js', 'agent-tags.js'), 'utf8');
    const has = (haystack, needle) => String(haystack).includes(needle);
    const extractFn = (name, src = html) => extractFnFrom(src, name);

    const skillFn = extractFn('agentPhoneSkillText');
    c.ok(skillFn.length > 200, 'agentPhoneSkillText() 存在且不是空壳');

    // 网页版无设备层时必须返回空串，否则模型以为能操作手机、每步被拒、白烧 token。
    c.ok(/if \(!deviceBridge\(\)\) return '';/.test(skillFn),
        '没有原生设备层（网页版）时不注入能力说明');

    c.ok(/未启用/.test(skillFn), '有「未启用」这一档');
    c.ok(/不要\*\*输出 \[操作:手机…\] 标签|不要\*\*输出/.test(skillFn) || /不要.{0,4}输出 \[操作:手机/.test(skillFn),
        '未启用时明确禁止模型输出手机标签（否则它会空谈/编造）');
    c.ok(/设置 → 能力 → 手机操作/.test(skillFn), '★ 未启用时引导到正确的位置（能力栏）开启');
    c.ok(!/高级 → 手机操作/.test(skillFn), '★ 不再引用已搬走的「高级 → 手机操作」旧位置');

    const phoneTags = [
        '手机状态', '手机查看界面', '手机截图', '手机等待',
        '手机点击', '手机滑动', '手机输入', '手机按键', '手机打开', '手机命令',
        '手机应用列表', '手机通知', '手机设备信息', '手机通讯录', '手机日历', '手机短信',
        '手机列出文件', '手机读文件', '手机写文件', '手机删除文件',
    ];
    // 读取标签由 phoneReadSkillLines() 拼进能力说明，判据分两处：固定标签查 skillFn、读取查它自己的函数体。
    const READ_TAGS = ['手机应用列表', '手机通知', '手机设备信息', '手机通讯录', '手机日历', '手机短信'];
    const literalTags = phoneTags.filter((t) => !READ_TAGS.includes(t));
    const missingLiteral = literalTags.filter((t) => !has(skillFn, '[操作:' + t));
    c.ok(missingLiteral.length === 0, '可用档列出了全部固定手机操作标签', '缺少: ' + missingLiteral.join('、'));
    // 读取标签必须逐项出现在 phoneReadSkillLines 里：少一项模型就以为没这个能力，
    // 而用户其实随时可以在系统里授予对应权限。
    const readFnMatch = html.match(/function phoneReadSkillLines\(\)\s*\{([\s\S]*?)\n\}/);
    c.ok(!!readFnMatch, '找得到 phoneReadSkillLines() 的函数体');
    if (readFnMatch) {
        const missingRead = READ_TAGS.filter((t) => !has(readFnMatch[1], "'" + t + "'"));
        c.ok(missingRead.length === 0, '读取信息清单里列出了全部六项', '缺少: ' + missingRead.join('、'));
    }

    // 一之二、能力清单按"实现方式 + 另一路是否可用"区分：「手机打开」两种方式都能做（无障碍走系统启动
    //    intent），只有「手机命令」需要命令族；另一路不可用时边界说明必须在。
    c.ok(/const isAccessibility = backend === 'accessibility'/.test(skillFn),
        '能力清单按实现方式分支（无障碍 / 其它）');
    c.ok(/· \[操作:手机打开 应用名或包名\]/.test(skillFn),
        '★ 两种方式都列出「手机打开」，且允许写应用名（系统解析成包名，避免猜错应用）');
    c.ok(!/不支持\*\* \[操作:手机打开\]/.test(skillFn),
        '★ 不再把「手机打开」标成不支持（判死会让 AI 走偏后回不到目标应用）');
    c.ok(/手机命令/.test(skillFn) && /不支持|做不到/.test(skillFn),
        '明确说明不支持「手机命令」');
    c.ok(/不要重复尝试/.test(skillFn),
        '明确要求模型遇到「不支持」时不要反复重试（否则会刷屏失败）');
    c.ok(/const otherId = isAccessibility \? 'module' : 'accessibility'/.test(skillFn),
        '找得到"另一路"的判据（otherId）');
    c.ok(/otherReady = Boolean\(backendStatus\[otherId\][\s\S]*state === 'ready'/.test(skillFn),
        '★ 并集判据读的是另一路的探测状态（backendStatus），不是写死的 true');
    c.ok(/if \(!canCommand\) \{[\s\S]*按键只支持/.test(skillFn),
        '「手机命令」能力面按另一路是否可用分档（按键范围随之收窄）');

    // 一之二之二、运行方式：前台（无障碍）/ 后台（模块）：两路都可用时弹窗让用户选。
    c.ok(/function pickPhoneRunMode\(/.test(html), '有 pickPhoneRunMode()（询问运行方式）');
    c.ok(/confirmText: '前台运行'/.test(html) && /altText: '后台运行'/.test(html),
        '★ 弹窗给出「前台运行 / 后台运行」两个明确选项');
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
    c.ok(/strictBackend: runModeExplicit/.test(html),
        '★ 用户显式选的运行方式要传 strictBackend（原生据此**不**自动换路）');
    c.ok(/前台运行时会直接失败并说明原因/.test(skillFn),
        '★ 提示词改口：选了前台后无障碍做不到的动作会**直接失败**，不再承诺"自动改用模块"');
    c.ok(/if \(runModePicker\) return runModePicker/.test(html) && /runModePicker = doPickPhoneRunMode\(\)/.test(html),
        '★ 并发询问必须记忆化（否则第一个操作会永久挂起、静默不执行）');

    // 一之二之三、strict 必须在原生侧贯穿全部换路点：选了前台仍走模块，
    //    根因是 pickCommandExecutor 在分流前自动挑选（候选只有模块）。
    const shellPluginPath = PLUGIN_JAVA;
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
    {
        const strictAt = plugin.indexOf('if (strict) {');
        const pickAt = plugin.indexOf('pickCommandExecutor(preferred)');
        c.ok(strictAt > 0 && pickAt > 0 && strictAt < pickAt,
            '★★ strict 分流在 pickCommandExecutor **之前**（否则 preferred=accessibility 会被自动挑选吞掉、落到模块）');
    }
    c.ok(/ID_ACCESSIBILITY\.equals\(preferred\)[\s\S]{0,400}return runOnAccessibility\(action, args, false\);/.test(strictBlock),
        '★ strict + 无障碍 → 直接走无障碍（做不到就如实报，不换模块）');
    c.ok(!/runOnCommandBackend\(moduleExecutor/.test(strictBlock.split('ID_MODULE.equals(preferred)')[0]),
        '★ strict + 无障碍的分支里**不得**出现 runOnCommandBackend(moduleExecutor)（那就是偷偷换路）');
    c.ok(/ID_MODULE\.equals\(preferred\)[\s\S]{0,500}return failure\(/.test(strictBlock),
        '★ strict + 模块但不可用 → 明确失败（不静默回落无障碍）');
    c.ok(/不会\*\*改用无障碍|不会.*改用无障碍/.test(strictBlock),
        '★ 失败文案说明"不会改用无障碍"（否则用户以为它在乱换路）');
    c.ok(/运行方式参数无法识别/.test(strictBlock),
        '★ strict + 无法识别的 preferred → 如实报错，不猜一个后端跑');
    c.ok(/if \(!strict\s*[\s\S]{0,220}"手机输入"\.equals\(action\)/.test(plugin),
        '★ 中文输入的"改走无障碍"兜底带 !strict（显式选了后台就不该被改到前台）');
    c.ok(/if \(accessibilityCannotDo\(action, args\) && moduleExecutor\.available/.test(plugin),
        '★ 非 strict（没弹窗 / 只一条路可用）时的互通自动换路仍然保留');
    c.ok(/annotateBackendSwap\(/.test(plugin),
        '★ 换路仍在结果里注明"本次已自动改用…"（可排查性）');

    // 一之二之四、「看画面」按钮的判据：持久化默认方式与从不重置的 used 都会误报"模块"，
    //    必须读本轮 runModeDecision。
    {
        // 必须限定在 agentRuntime 的 IIFE 里抠 render()：全局第一个 render 属于 achievements.js。
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

    // 一之三、读取信息不再有应用层开关：能读到什么只由系统权限决定。
    //   断言"开关不存在"是为了防止有人再把那 6 个开关加回来 —— 加回来就必然要有"关掉"的路径，
    //   而系统权限一旦授予，应用内关掉只是对模型隐身，用户以为收回了、其实没有。
    c.ok(/function phoneReadSkillLines\(/.test(html),
        '有 phoneReadSkillLines()（读取信息能力清单）');
    c.ok(!/function phoneReadAllowed\(/.test(html),
        '★ 不再有 phoneReadAllowed()（应用层开关已删除，能力由系统权限决定）');
    c.ok(!/function phoneReadBlockedReason\(/.test(html),
        '★ 不再有 phoneReadBlockedReason()（同上，执行层也不再按开关拒绝）');
    c.ok(!/const PHONE_READ_OPS = \[/.test(html), '★ 不再有 PHONE_READ_OPS 清单');
    for (const id of ['settingAgentReadApps', 'settingAgentReadNotifications', 'settingAgentReadDevice',
        'settingAgentReadSms', 'settingAgentReadContacts', 'settingAgentReadCalendar']) {
        c.ok(!has(html, id), `★ 设置界面不再有隐私开关 ${id}`);
    }
    // 权限明细必须靠一个「!」展开：八项权限常显会把「手机操作」挤成一屏。
    for (const id of ['agentPermDetailBtn', 'agentPermDetail', 'agentPermSummaryBadge']) {
        c.ok(has(html, id), `设置界面有手机权限明细元素 ${id}`);
    }
    c.ok(/data-perm-act="requestAll"/.test(html), '明细里有「申请缺失项」入口');
    c.ok(/data-perm-act="battery"/.test(html) && /data-perm-act="autostart"/.test(html),
        '明细里有电池优化白名单与自启动的入口');
    c.ok(/没有关闭权限的入口|去系统设置关/.test(html),
        '★ 明确说明撤销权限只能去系统设置（应用内不提供关闭入口）');

    const layered = extractFn('buildLayeredRoleplayMessages');
    const legacy = extractFn('buildLegacyRoleplayMessages');
    c.ok(/agentPhoneSkillText\(\)/.test(layered), '分层版（layered-v2）注入了手机操作能力');
    c.ok(/agentPhoneSkillText\(\)/.test(legacy),
        '回滚版（legacy-v1）也注入了 —— 只补一边会让切回 legacy 后"又不能操作手机了"');

    // 三、说的必须做得到：提示词与解析器是两处独立清单，任何一边没跟上就"AI 照做了没人接"。
    //    提取前先剥注释，防止注释里的标签名污染判据。
    const opsMatch = html.match(/const AGENT_PHONE_OPS = \[([\s\S]*?)\];/);
    c.ok(!!opsMatch, '找得到 AGENT_PHONE_OPS（解析器认识的标签清单）');
    if (opsMatch) {
        const bodyNoComments = opsMatch[1]
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        const parsed = [...bodyNoComments.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        const notParsed = phoneTags.filter((t) => !parsed.includes(t));
        c.ok(notParsed.length === 0,
            '提示词里承诺的每个标签，解析器都认识', '解析器不认识: ' + notParsed.join('、'));
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

    // 这几环任一断掉，提示词写得再全也没用。它们分散在两个文件里，最容易在重构时被拆散。
    c.ok(/window\.agentActions\s*=\s*\{/.test(html), '主应用定义了 window.agentActions');
    c.ok(/agentPhoneOperation\(raw\)/.test(html), 'agentActions 上有 agentPhoneOperation');
    c.ok(/async function runAgentPhoneOperation\(/.test(html), 'runAgentPhoneOperation 存在');
    // 判据行与调用行是分开的两句，断言要认这个真实形状。
    c.ok(/agentPhoneOperation/.test(tags) && /callAction\('agentPhoneOperation'/.test(tags),
        'agent-tags.js 会把 [操作:手机…] 转发给主应用');
    c.ok(/\^\(手机\|设备\)/.test(tags), 'agent-tags.js 的转发判据认得「手机」前缀');
    c.ok(!/\^\(手机\|设备\)/.test(live2d),
        '★ live2d-video.js 不再持有手机分发（Live2D 卸掉不影响手机操作）');
    // 断言只关心注解名字，用 \s* 容忍换行（@CapacitorPlugin 加 permissions 段后变多行）。
    c.ok(/ElainaDevice/.test(html) && /@CapacitorPlugin\(\s*name\s*=\s*"ElainaDevice"/.test(
        readFileSync(PLUGIN_JAVA, 'utf8')),
        '原生插件名与前端查找的名字一致（ElainaDevice）');
    c.ok(/registerPlugin\(ElainaShellPlugin\.class\)/.test(
        readFileSync(path.join(JAVA_DIR, 'MainActivity.java'), 'utf8')),
        'MainActivity 注册了原生插件（没注册就永远拿不到设备层）');

    // 五、静态标签指南不得把手机操作说成"总是可用"
    // 宿主段只留自己执行的操作 + 定时任务；表现类归 live2d mod（setPromptHint 注入）。
    const guideMatch = html.match(/const HOST_ACTION_TAG_GUIDE = `([\s\S]*?)`;/);
    c.ok(!!guideMatch, '找得到 HOST_ACTION_TAG_GUIDE（宿主操作标签指南）');
    if (guideMatch) {
        c.ok(!/\[操作:手机点击\]/.test(guideMatch[1]),
            '静态指南没有把手机标签写成"总是可用"（可用性随设备变化，交给动态注入）');
        c.ok(/系统会单独告知/.test(guideMatch[1]),
            '静态指南说明了手机/文件操作由系统单独告知（避免模型凭这里猜）');
    }
    // 反向断言：表现类标签不得留在宿主指南，否则卸掉 Live2D 后模型仍被要求输出无人执行的标签。
    {
        const hostGuide = guideMatch ? guideMatch[1] : '';
        c.ok(!/\[情绪:开心/.test(hostGuide),
            '★ 宿主指南里不再列表现类情绪标签（已搬进 live2d mod 的 setPromptHint）');
        c.ok(!/\[表情:happy/.test(hostGuide),
            '★ 宿主指南里不再列表情标签（同上）');
        c.ok(!/\[背景:深蓝/.test(hostGuide),
            '★ 宿主指南里不再列背景标签（同上）');
        c.ok(/\[任务:/.test(hostGuide),
            '★ 定时任务标签留在宿主（否则关掉 Live2D 就没法定时提醒）');
        for (const act of ['打开视频通话', '结束通话', '整理记忆']) {
            c.ok(hostGuide.includes('[操作:' + act + ']'), `★ 宿主动作「${act}」留在宿主指南里`);
        }
    }
    {
        const l2d = readFileSync(path.join(root, 'mods', 'live2d', 'index.js'), 'utf8');
        c.ok(/host\.setPromptHint\(/.test(l2d),
            '★★ live2d mod 用 host.setPromptHint 注入表现指南（停用即自动摘除）');
        c.ok(/LIVE2D_PRESENTATION_GUIDE/.test(l2d), 'live2d mod 里有表现指南常量');
        c.ok(/\[情绪:开心/.test(l2d) && /\[表情:happy/.test(l2d),
            '★ 情绪/表情标签由 live2d mod 提供');
        c.ok(/\[操作:静音\]/.test(l2d) && /\[操作:隐藏水印\]/.test(l2d),
            '★ 静音/水印（本插件独有的两个操作）也在它的指南里');
        c.ok(/if \(watermarkExp\)/.test(l2d),
            '★ 水印段是条件注入（模型没有水印开关就不提）');
    }
}

// 6. strict（显式运行方式）路由的决策表：结构断言证明不了每种输入落到哪条路。
//    本段是手写逻辑镜像，防漂移：抠不到关键函数直接报错 + 结构性同步断言 + 分支标注源码条件。

async function caseStrictRoute(c) {
    if (!existsSync(PLUGIN_JAVA)) {
        console.log('  --   跳过：没有 dist/Android 的 ElainaShellPlugin.java（工作区被裁剪时正常）');
        return;
    }
    const plugin = readFileSync(PLUGIN_JAVA, 'utf8');

    const runStart = plugin.indexOf('private JSObject runAction(');
    const runEnd = plugin.indexOf('private ShellBackends.Executor pickCommandExecutor(');
    if (runStart < 0 || runEnd < runStart) {
        throw new Error('抠不到 runAction —— 函数签名改了？请同步更新本检查');
    }
    const runBody = plugin.slice(runStart, runEnd);

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
            [/ShellBackends\.Executor strictBackend = backgroundById\(preferred\);/, 'strict+后台 分支（Shizuku / Root / 模块）'],
            [/运行方式参数无法识别/, 'strict+未知值 → 如实报错'],
            [/if \(!strict\s*[\s\S]{0,220}"手机输入"\.equals\(action\)/, '中文输入兜底带 !strict（route 的 ① 依赖它）'],
            [/if \(accessibilityCannotDo\(action, args\) && swap != null\)/, '非 strict 的互通换路（route 的 ③ 依赖它）'],
            [/ShellBackends\.Executor\[\] order = \{ shizukuExecutor, rootExecutor, moduleExecutor \}/, '自动挑选的候选是 Shizuku → Root → 模块（route 的 ④ 依赖它）'],
        ];
        for (const [re, label] of facts) {
            c.ok(re.test(plugin), `源码仍具备：${label}`);
        }
        // route() 镜像里引用的动作名也必须与原生 accessibilityCannotDo 的清单一致
        const cannotDoBlock = plugin.slice(
            plugin.indexOf('private static boolean accessibilityCannotDo('),
            plugin.indexOf('private static JSObject annotateBackendSwap('));
        // 「手机命令」不在这里：后台方式也不开放任意命令，换过去只会再失败一次
        const mirrored = [];
        for (const act of mirrored) {
            c.ok(cannotDoBlock.includes('"' + act + '"'),
                `镜像里当作"无障碍做不到"的「${act}」仍在原生清单里`);
        }
        const nativeCases = [...cannotDoBlock.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
        const unknown = nativeCases.filter((a) => !mirrored.includes(a) && a !== '手机按键');
        c.ok(unknown.length === 0,
            '★ 原生"无障碍做不到"清单没有 route() 不知道的新动作（有的话请同步镜像的 cannotDo）',
            '未同步: ' + unknown.join('、'));
    }

    /**
     * 模拟 runAction 路由决策；返回 'accessibility'|'shizuku'|'root'|'module'|'fail'|'auto:<id>'，分支顺序对照源码。
     *
     * @param bg 后台可用集合（Shizuku / Root / 模块里哪些就绪）
     */
    function route({ action, args, preferred, strict, accRunning, bg }) {
        const available = bg || [];
        const autoPick = ['shizuku', 'root', 'module'].find((id) => available.includes(id)) || '';
        // ① 中文输入的"改走无障碍"兜底
        if (!strict && action === '手机输入' && /[^\x00-\x7F]/.test(args) && accRunning) {
            return 'accessibility';
        }
        // ② strict 分流
        if (strict) {
            if (preferred === 'accessibility') return 'accessibility';      // 做不到也如实报，不换路
            if (['shizuku', 'root', 'module'].includes(preferred)) {
                return available.includes(preferred) ? preferred : 'fail';
            }
            return 'fail';                                                   // 未知值：不猜
        }
        // ③ preferred 是无障碍
        if (preferred === 'accessibility') {
            // 「手机命令」不在清单里：后台也不开放命令，换过去只是再失败一次
            const cannotDo = ['手机按键'].includes(action) && !['返回', '主页', '最近任务', '4', '3', '187'].includes(String(args).trim());
            if (cannotDo && autoPick) return 'auto:' + autoPick;               // 互通自动换路
            return 'accessibility';
        }
        // ④ 自动挑选（候选 Shizuku → Root → 模块）
        if (autoPick) return autoPick;
        return accRunning ? 'accessibility' : 'fail';                         // 兜底走无障碍
    }

    {
        const r = route({ action: '手机打开', args: 'tv.danmaku.bili', preferred: 'accessibility', strict: true, accRunning: true, bg: ['module'] });
        c.ok(r === 'accessibility', '★★ 「手机打开」+ 选前台 → 走无障碍（如实报"做不到"），**不**换后台', `实际=${r}`);
        const r2 = route({ action: '手机命令', args: 'ls', preferred: 'accessibility', strict: true, accRunning: true, bg: ['module'] });
        c.ok(r2 === 'accessibility', '★★ 「手机命令」+ 选前台 → 走无障碍（不换后台）', `实际=${r2}`);
        const r3 = route({ action: '手机点击', args: '100 200', preferred: 'accessibility', strict: true, accRunning: true, bg: ['module'] });
        c.ok(r3 === 'accessibility', '「手机点击」+ 选前台 → 无障碍', `实际=${r3}`);
        const r4 = route({ action: '手机查看界面', args: '', preferred: 'accessibility', strict: true, accRunning: true, bg: ['module'] });
        c.ok(r4 === 'accessibility', '「手机查看界面」+ 选前台 → 无障碍', `实际=${r4}`);
    }

    {
        const r = route({ action: '手机点击', args: '1 2', preferred: 'module', strict: true, accRunning: true, bg: ['module'] });
        c.ok(r === 'module', '「手机点击」+ 选后台模块 → 模块', `实际=${r}`);
        const rShizuku = route({ action: '手机点击', args: '1 2', preferred: 'shizuku', strict: true, accRunning: true, bg: ['shizuku', 'module'] });
        c.ok(rShizuku === 'shizuku', '★ 「手机点击」+ 选后台 Shizuku → Shizuku（不被模块抢走）', `实际=${rShizuku}`);
        const rRoot = route({ action: '手机点击', args: '1 2', preferred: 'root', strict: true, accRunning: false, bg: ['root'] });
        c.ok(rRoot === 'root', '★ 「手机点击」+ 选后台 Root → Root（不需要无障碍）', `实际=${rRoot}`);
        const r2 = route({ action: '手机输入', args: '你好世界', preferred: 'module', strict: true, accRunning: true, bg: ['module'] });
        c.ok(r2 === 'module', '★★ 中文输入 + 选后台 → 仍走后台（不被"改走无障碍"兜底抢走）', `实际=${r2}`);
        const r3 = route({ action: '手机点击', args: '1 2', preferred: 'module', strict: true, accRunning: true, bg: [] });
        c.ok(r3 === 'fail', '★ 选后台但该后端不可用 → 明确失败（不静默回落无障碍）', `实际=${r3}`);
    }

    {
        const r = route({ action: '手机按键', args: '音量加', preferred: 'accessibility', strict: false, accRunning: true, bg: ['module'] });
        c.ok(r === 'auto:module', '★ 非 strict + 无障碍做不到（非三键按键）+ 后台可用 → 自动换后台（互通仍生效）', `实际=${r}`);
        const rCmd = route({ action: '手机命令', args: 'ls', preferred: 'accessibility', strict: false, accRunning: true, bg: ['module'] });
        c.ok(rCmd === 'accessibility', '★ 非 strict + 「手机命令」→ 仍走无障碍（后台也不开放命令，不换路）', `实际=${rCmd}`);
        const r1b = route({ action: '手机打开', args: 'pkg', preferred: 'accessibility', strict: false, accRunning: true, bg: [] });
        c.ok(r1b === 'accessibility', '★ 「手机打开」无障碍自己就能做（不再换路、不判失败）', `实际=${r1b}`);
        const r2 = route({ action: '手机点击', args: '1 2', preferred: 'accessibility', strict: false, accRunning: true, bg: ['module'] });
        c.ok(r2 === 'accessibility', '非 strict + 无障碍做得到 → 走无障碍（不无谓换路）', `实际=${r2}`);
        // 非 strict 时中文输入仍走无障碍（后台的 input text 也不支持非 ASCII）
        const r3 = route({ action: '手机输入', args: '中文', preferred: 'accessibility', strict: false, accRunning: true, bg: ['module'] });
        c.ok(r3 === 'accessibility', '非 strict + 中文输入 → 无障碍（原来的兜底仍在）', `实际=${r3}`);
        const r4 = route({ action: '手机点击', args: '1 2', preferred: 'module', strict: false, accRunning: false, bg: ['module'] });
        c.ok(r4 === 'module', '非 strict + 默认模块 → 模块', `实际=${r4}`);
        // 自动挑选的顺序：Shizuku 优先于 Root，Root 优先于模块
        const rOrder = route({ action: '手机点击', args: '1 2', preferred: '', strict: false, accRunning: false, bg: ['root', 'module'] });
        c.ok(rOrder === 'root', '★ 自动挑选按 Shizuku → Root → 模块 的顺序', `实际=${rOrder}`);
    }

    {
        const r = route({ action: '手机打开', args: 'pkg', preferred: 'accessibility', strict: true, accRunning: true, bg: ['module'] });
        c.ok(r !== 'module' && r !== 'auto:module',
            '★★ 选前台 + 无障碍做不到 → 绝不落到后台（这正是真机上那个 bug）', `实际=${r}`);
        const r2 = route({ action: '手机输入', args: '中文', preferred: 'module', strict: true, accRunning: true, bg: ['module'] });
        c.ok(r2 !== 'accessibility',
            '★★ 选后台 + 中文输入 → 绝不被改到无障碍', `实际=${r2}`);
    }
}

// 6.5 手机权限：电池优化白名单与自启动只能经原生接口查询 / 跳转，前端无等价能力。
//     单独成一个用例，不放 casePhone：后者在没有 mods/live2d 时整段跳过，会让这几条断言在本地永远不跑。

async function casePhonePerms(c) {
    if (!existsSync(PLUGIN_JAVA) || !existsSync(MANIFEST)) {
        console.log('  --   跳过：没有 dist/Android 的 ElainaShellPlugin.java / AndroidManifest.xml（工作区被裁剪时正常）');
        return;
    }
    const plugin = readFileSync(PLUGIN_JAVA, 'utf8');
    const manifest = readFileSync(MANIFEST, 'utf8');
    const perms = readWebFile('js/agent-permissions.js');

    // 一、原生三个方法：电池优化状态可查、可申请，自启动可跳转。
    c.ok(/@PluginMethod\s+public void powerStatus\(PluginCall call\)/.test(plugin),
        '原生有 powerStatus()（查询电池优化白名单状态）');
    c.ok(/isIgnoringBatteryOptimizations\(/.test(plugin),
        '★ powerStatus 真的问了 PowerManager（不是写死值）');
    c.ok(/@PluginMethod\s+public void requestBatteryExemption\(PluginCall call\)/.test(plugin),
        '原生有 requestBatteryExemption()（申请电池优化白名单）');
    c.ok(/ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/.test(plugin),
        '★ 申请走系统确认框的 action');
    c.ok(/ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS/.test(plugin),
        '★ 弹框失败时回退到电池优化列表页（直接报错会让人无从下手）');
    c.ok(/@PluginMethod\s+public void openAutostartSettings\(PluginCall call\)/.test(plugin),
        '原生有 openAutostartSettings()（跳厂商自启动页）');
    c.ok(/com\.miui\.securitycenter[\s\S]{0,400}com\.huawei\.systemmanager/.test(plugin),
        '★ 自启动页按厂商逐个尝试（小米 / 华为在前）');
    c.ok(/ACTION_APPLICATION_DETAILS_SETTINGS/.test(plugin.slice(plugin.indexOf('openAutostartSettings'))),
        '★ 全厂商都跳不过去时退到应用信息页');

    // 二、清单声明：REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 是弹确认框的前提。
    c.ok(/REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/.test(manifest),
        '清单声明了 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');

    // 三、前端接上了这三个方法，且电池状态查不到时如实说"无法检测"而不是冒充未授权。
    for (const fn of ['powerStatus', 'requestBatteryExemption', 'openAutostartSettings']) {
        c.ok(perms.includes('dev.' + fn), `前端调用了原生 ${fn}()`);
    }
    c.ok(/batteryKnown === false[\s\S]{0,120}'unknown'/.test(perms),
        '★ 电池状态查不到时标成 unknown 圆点（不冒充未授权）');
    c.ok(/visibilitychange/.test(perms),
        '★ 从系统设置返回时补刷状态（WebView 不会重新加载页面）');

    // 四、明细是浮层（不在设置卡片里就地展开），状态只用绿/红/灰圆点、不写文字。
    const html = readFrontend();
    c.ok(/id="agentPermSheet"/.test(html), '★ 权限明细是独立浮层 #agentPermSheet');
    c.ok(!/id="agentPermDetail"/.test(html), '★ 卡片里不再有就地展开的明细容器');
    c.ok(/agentPermSheetClose/.test(html), '浮层有关闭按钮');
    c.ok(/class="agent-perm-dot"/.test(html), '★ 状态用圆点表示（不写「已授权 / 未授权」文字）');
    c.ok(!/agentPermBadge[A-Za-z]+" class="agent-perm-badge"/.test(html),
        '★ 明细行里不再用文字徽标');
    // 浮层必须在 #settingsOverlay 之外：主面板的 transform 会关住 fixed 后代。
    const overlayEnd = html.indexOf('id="settingsOverlay"');
    const sheetIdx = html.indexOf('id="agentPermSheet"');
    c.ok(sheetIdx > overlayEnd, '★ 浮层放在设置面板之后（嵌在里面会被主面板的 transform 关住）');
    // 一键授权只能收"能弹系统框"的那几项；通知 / 自启动要跳页面，塞进来会让人以为点完就都开了。
    c.ok(/AGENT_PERM_POPUP_KINDS = \['sms', 'contacts', 'calendar'\]/.test(perms),
        '★★ 一键授权只弹「能弹框」的三项（通知 / 自启动不在其中）');
    c.ok(/AGENT_PERM_POPUP_KINDS\)/.test(perms), '★ 一键授权真的遍历这张清单（不是写死三项）');
    c.ok(/不需要的话点系统弹窗里的「拒绝」即可/.test(html),
        '★ 卡片上注明了「不想授权就点拒绝」');
}

// 7. 标签协议解耦：[操作:] 分发若长在可卸的 Live2D 里，卸掉插件等于整个 Agent 失效。
//    本检查用故意不提供 window.Live2DCall 的沙箱跑一遍。

async function caseTags(c) {
    const src = readFileSync(path.join(ROOT, 'web', 'js', 'agent-tags.js'), 'utf8');

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

        // 电脑命令必须排在文件操作之前，否则命令正文会被「查看文件」类词吃掉。
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

        calls.length = 0;
        T.drive('[操作:打开视频通话][操作:整理记忆]');
        c.ok(calls.length === 2, '一条回复里的多个操作标签都被执行', JSON.stringify(calls));
    }

    {
        let threw = null;
        try { T.drive('[表情:开心][情绪:高兴][位置:left][操作:整理记忆]'); }
        catch (e) { threw = e; }
        c.ok(threw === null, '★ 表现标签存在但 Live2D 缺失时不抛异常', threw && threw.message);
        c.ok(calls.includes('organizeMemory'), '★ 同一条回复里的操作仍然被执行（表现被跳过）');
    }

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
        let threw = null;
        try { T3.drive('[操作:完全不存在的操作]'); } catch (e) { threw = e; }
        c.ok(threw === null, '未知操作只 warn 不抛异常');
    }
}

// 8. 操作注册表：一份操作定义，两条通道共用。
//    技能（SKILL.md）注册成可执行条目等于"装个 zip 就获得执行能力"，这条边界只能靠测试钉住。

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

    O.define({
        name: 'demo_write', tool: 'demo_write', ns: 'file', desc: '写一个演示文件',
        schema: { type: 'object', properties: { path: { type: 'string' } } },
        risk: 'sensitive', available: () => true,
    });
    let got = null;
    O.setExec('demo_write', (args) => { got = args; return { ok: true, text: 'done' }; });
    const r = await O.invoke('demo_write', { path: 'x' }, {});
    c.ok(r && r.ok === true && got && got.path === 'x', 'invoke 走注册的执行实现', JSON.stringify(r));

    const tools = O.toolsForAccess();
    const t = tools.find((x) => x.function && x.function.name === 'demo_write');
    c.ok(Boolean(t && t.type === 'function' && t.function.description && t.function.parameters),
        'toolsForAccess 产出 tools[].function 形状');

    O.define({
        name: 'demo_hidden', tool: 'demo_hidden', ns: 'file', desc: '此刻不可用',
        schema: { type: 'object', properties: {} }, available: () => false, hints: ['写文件'],
    });
    c.ok(!O.toolsForAccess().some((x) => x.function.name === 'demo_hidden'), '不可用的操作不被写进工具清单');
    c.ok(!O.indexLines().some((l) => l.startsWith('demo_hidden ')), '不可用的操作不出现在能力索引里');

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

    // 4b. 内部 name 与 ASCII 工具名之间只在本文件维护一份映射。
    c.ok(O.resolve('demo_write')?.name === 'demo_write' && O.resolve('demo_write')?.tool === 'demo_write',
        '内部 name 与工具名都能 resolve');
    c.ok(O.resolve('不存在的东西') === null, 'resolve 未知项返回 null');

    O.registerKnowledge('示例技能', '一段给 AI 的说明');
    const k = O.list('knowledge')[0];
    c.ok(Boolean(k && k.kind === 'knowledge' && !k.schema), '技能条目是 kind:knowledge（没有 schema）');
    const bad = await O.invoke(k.name, { hello: 1 }, {});
    c.ok(Boolean(bad && bad.ok === false), '★ 技能条目不能被 invoke 执行（装技能 ≠ 获得执行能力）', JSON.stringify(bad));
    c.ok(!O.toolsForAccess().some((x) => x.function.name === k.name), '技能条目不出现在工具清单里');
    // 但技能要进 L1 能力索引：模型得先知道有这份资料才会去查（进索引 ≠ 能执行）。
    c.ok(O.indexLines().some((l) => l.startsWith(k.name + ' — ')),
        '★ 技能条目进 L1 能力索引（只披露"有这份资料"，不是给它执行能力）', O.indexLines().join(' | '));

    const rejected = [];
    try { O.define({ name: 'demo_write', tool: 'demo_write_2' }); } catch { rejected.push('重名'); }
    try { O.define({ name: 'demo_x', tool: '演示工具' }); } catch { rejected.push('非 ASCII'); }
    try { O.setExec('还没注册的操作', () => {}); } catch { rejected.push('未注册就挂实现'); }
    try { O.setManual('还没注册的操作', '说明'); } catch { rejected.push('未注册就挂说明书'); }
    c.ok(rejected.length === 4, '重名 / 非 ASCII 工具名 / 未注册就挂实现或说明书 全部被拒', rejected.join(','));

    {
        let manual = '（没有说明书）';
        O.setManual('demo_write', () => '真实路径：D:\\桌面2');
        manual = O.manualFor('demo_write');
        c.ok(manual.includes('D:\\桌面2'), 'manualFor 返回该项说明书（收函数：真实路径是运行时探测的）', manual);
        c.ok(O.manualFor('demo_meta') === '', '没挂说明书的条目返回空串（不抛）');
    }

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
    // 浏览器走 agentActions → runAgentBrowserOperation，不经 invoke；断言只钉标签分发侧。
    c.ok(agentSrc.includes('agentBrowserOperation(raw)') && agentSrc.includes('runAgentBrowserOperation(parsed)'),
        '★ 浏览器标签经统一执行器（不自己发请求）');
    c.ok(agentSrc.includes('agentWebSearchOperation(raw)') && agentSrc.includes('runAgentWebSearch({ query })'),
        '★ 搜索标签经统一执行器（不自己发请求）');
    c.ok(noWire.length === 0, '标签分发全部经 ElainaOps.invoke（不再直接调执行函数）', noWire.join(' / '));
    const execCount = (agentSrc.match(/ElainaOps\.setExec\(/g) || []).length;
    c.ok(execCount === expectOps.length, '每个操作都挂了执行实现（setExec 条数一致）', execCount + '/' + expectOps.length);

    // 这几条跨 4 个文件，漏掉不当场报错（跑一整轮对话才看得见），只能靠"源码包含"来钉。
    const voiceSrc = readFileSync(path.join(ROOT, 'web', 'js', 'composer.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'voice.js'), 'utf8');
    const uiSrc = readFileSync(path.join(ROOT, 'web', 'js', 'conversations.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'ui.js'), 'utf8');
    const dataSrc = readFileSync(path.join(ROOT, 'web', 'js', 'memory.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'persistence.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'roleplay.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'chat.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'data.js'), 'utf8');
    const coreSrc = readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');
    const unwired = [
        [agentSrc, 'insertToolResult(', 'agent.js 有 insertToolResult（结果以 role:tool 回灌）'],
        [agentSrc, 'async function runToolCalls(', 'agent.js 有 runToolCalls（执行工具调用）'],
        [voiceSrc, 'agentToolOptions()', 'voice.js 用共享构造器取"这一轮的工具选项"'],
        [voiceSrc, 'runToolCalls(repliedToolCalls', 'voice.js 在回复带 tool_calls 时执行它们'],
        [voiceSrc, 'window.ElainaTags.drive(response)',
            '★ 一回合只走一条通道：有工具调用就不再解析标签（两条都跑＝同一个动作执行两次）'],
        [agentSrc, 'raceAgentDeadline(callAI(continuePrompt, agentToolOpt)',
            '★ 续跑也带工具（不带的话多步任务到第二步就没工具可用了），且整次调用套了定时器死线'],
        [agentSrc, 'raw = await callAI(prompt, agentToolOpt || undefined)',
            '★ 失败解释也带工具（它常被用来"换个路径再试一次"）'],
        [uiSrc, 'message.hidden === true) return', '隐藏消息不进可见渲染'],
        [dataSrc, "if (m.role === 'tool')", '历史映射原样带下 role:tool（含 tool_call_id）'],
        [dataSrc, 'windowToolCallIds', '孤儿 tool 兜底：窗口先收集 assistant 声明的 tool_calls（12 条窗口从协议消息对中间切开时，孤儿会被严格网关整包拒收）'],
        [dataSrc, "windowToolCallIds.has(String(m.toolCallId || ''))", 'role:tool 只有能在窗口内对上 tool_calls 才原样下发，对不上降级成内部观察'],
        [dataSrc, 'entry.tool_calls = m.toolCalls', '历史映射原样带下 assistant 的 tool_calls'],
        [dataSrc, 'm && m.hidden !== true', '记忆摘要跳过隐藏消息（不让工具结果汇进长期记忆）'],
        // hidden 必须随整份对话原样读回，否则半途对话导入时工具消息会冒进聊天记录。
        [dataSrc, 'state.conversations = JSON.parse(convs)', '★ 对话读回时原样保留 hidden 标记（不重建消息对象）'],
    ].filter(([src, needle]) => !src.includes(needle)).map(([, , label]) => label);
    c.ok(unwired.length === 0, '★ 工具通道接线完整（请求侧 / 分流 / 各处隐藏过滤）', unwired.join(' / '));

    // 8b2. 注册顺序：顶层 setManual/setExec 打到未注册条目会抛错并中断后续代码，用顺序断言钉住。
    {
        const defineAt = agentSrc.indexOf("name: 'agent_help'");
        const manualAt = agentSrc.indexOf("ElainaOps.setManual('agent_help'");
        c.ok(defineAt > 0 && manualAt > 0 && defineAt < manualAt,
            '★ agent_help 先 define 再 setManual（顺序反了会顶层抛错并中断本文件后续代码）',
            'define@' + defineAt + ' / setManual@' + manualAt);
    }

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

    const promptRules = [
        [dataSrc, 'ElainaOps.indexLines()', '★ 提示词里的能力清单由注册表生成（手写第二份必然漏改）'],
        [agentSrc, 'function agentToolConductText(', '★ 跨能力的"工具使用守则"单列一段（不散进各能力说明）'],
        // 判据用要素不钉整句：守则措辞会随体验反馈调整，钉死整句会误判红。
        [agentSrc, '不要出现', '守则点明正文里不许出现内部细节（工具名/参数/JSON/命令回显）'],
        [agentSrc, '工具名、参数名、JSON', '守则点名的内部细节包含工具名、参数名、JSON'],
        [agentSrc, '用**一两句自己的话**讲清结果', '守则要求操作结果用角色口吻交代（世界内包装，不讲机制）'],
        [agentSrc, '## 什么时候动手', '守则给出「什么时候该动手」的触发判据（否则 AI 只会用嘴回答）'],
        [agentSrc, '说了要做，就必须真的发调用', '守则把「说」与「做」绑死（不许提前领功）'],
    ].filter(([src, needle]) => !src.includes(needle)).map(([, , label]) => label);
    c.ok(promptRules.length === 0, '★ 提示词接线完整（索引由注册表生成 + 守则统一）', promptRules.join(' / '));
}

/** 整体装载 agent-parse.js 再逐个调用：函数互相引用，抠单体求值会因 helper 缺席而 ReferenceError。 */
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

    c.ok(eq(A.parsePhoneOperation('[操作:手机点击 600 1071]'), { action: '手机点击', args: '600 1071' })
        && eq(A.parsePhoneOperation('[[操作:手机查看界面]]'), { action: '手机查看界面', args: '' })
        && eq(A.parsePhoneOperation('[操作:手机等待 800]'), { action: '手机等待', args: '800' })
        && eq(A.parsePhoneOperation('手机写文件 a.txt|内容[1]'), { action: '手机写文件', args: 'a.txt|内容[1]' }),
        '手机操作解析：整条标签当 raw 塞进来时剥掉包装（含双层括号）；裸正文原样保留、不误吃参数里的方括号',
        JSON.stringify([
            A.parsePhoneOperation('[操作:手机点击 600 1071]'),
            A.parsePhoneOperation('手机写文件 a.txt|内容[1]'),
        ]));

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

    const agentSrc = readFileSync(path.join(ROOT, 'web', 'js', 'agent.js'), 'utf8');
    const idxHtml = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    const ip = idxHtml.indexOf('/js/agent-parse.js');
    const ia = idxHtml.indexOf('/js/agent.js');
    c.ok(ip > 0 && ia > ip, 'agent-parse.js 在 agent.js 之前加载', 'parse@' + ip + ' agent@' + ia);
    c.ok(['parsePhoneOperation', 'describePhoneOperation', 'parseBrowserTag', 'summarizeBrowserArgs',
        'recallExcerpt', 'recallDateHintOf', 'recallDiaryDateMatches'].every((n) => !new RegExp('function ' + n + '\\(').test(agentSrc)),
        '这些纯解析函数已集中到 agent-parse.js（agent.js 不再重复定义）');
}

// 提示词层级：system 提示词按来源分 1-5 级，标签必须真的进到发送内容里，
// 而不是只写一份说明文档；层级冲突规则与事实优先级必须分开，否则模型会拿数字去否定更近的事实。
async function casePromptTiers(c) {
    const config = readWebFile('js/core-config.js');
    const roleplay = readWebFile('js/roleplay.js');

    c.ok(config.includes('PROMPT_TIER_RULES') && config.includes('1 最高，5 最低'),
        '核心配置里有 1-5 级提示词层级规则');
    c.ok(config.includes('PROMPT_TIER_LABELS') && config.includes('1: \'宿主系统\'') && config.includes('5: \'记忆资料\''),
        '五级标签齐全（宿主系统 / 用户设定 / 插件提示 / 运行时能力 / 记忆资料）');
    c.ok(!config.includes('【信息优先级】') && config.includes('【事实与设定优先级】'),
        '核心协议不再用 1-4 编号的「信息优先级」，避免与提示词层级两套编号冲突');
    c.ok(config.includes('层级只判断指令该听谁的') && config.includes('事实冲突仍按时间更近'),
        '层级只约束指令；事实冲突仍按时间/对象判断');

    c.ok(roleplay.includes('function promptTierText(tier, content)')
        && roleplay.includes('function promptTier(tier, content)'),
        'roleplay 有把层级写进 system 内容的 helper');
    c.ok(roleplay.includes('buildCharacterSystemMessages(card, options = {})')
        && roleplay.includes('system(1, ROLEPLAY_CORE_PROTOCOL)')
        && roleplay.includes('system(2, `# 世界观设定') && roleplay.includes('system(2, `# 角色卡'),
        '角色卡/世界观标 2 级，核心协议标 1 级');
    c.ok(roleplay.includes('buildCharacterSystemMessages(card, { tiered: true })')
        && roleplay.includes('promptTier(1, PROMPT_TIER_RULES)'),
        '分层路径注入层级规则，并对基础消息打标签');
    c.ok(roleplay.includes('buildRoleplayMemoryMessages')
        && roleplay.includes('promptTier(1, `# 记忆使用规则') && roleplay.includes('promptTier(5, `# 本轮参考记忆数据'),
        '记忆规则 1 级、记忆数据 5 级（数据不是指令）');
    c.ok(roleplay.includes('promptTier(3, t)'), 'mod 提示词固定 3 级');
    c.ok(roleplay.includes('promptTier(4, phoneSkill)') && roleplay.includes('promptTier(4,\n            \'# Agent 能力'),
        '手机/Agent 运行时能力标 4 级');
    c.ok(roleplay.includes('addPart(2, legacyCharacterPrompt)') && roleplay.includes('addPart(1, THIRD_PERSON_GM_PROMPT)'),
        '回滚拼接路径也带层级标签');
    c.ok(roleplay.indexOf('promptTier(1, PROMPT_TIER_RULES)') < roleplay.indexOf('buildCharacterSystemMessages(card, { tiered: true })'),
        '层级规则在角色设定之前，且不依赖消息位置生效');

    // 回复语言跟随用户：角色卡与历史对话的语言不得锁死输出语言（英文提问曾一律回中文）。
    c.ok(config.includes('【回复语言】') && /回复语言跟随\*\*用户当前这条消息\*\*/.test(config),
        '★ 核心协议（1 级）声明回复语言跟随用户当前消息');
    const core = config.match(/const ROLEPLAY_CORE_PROTOCOL = `([\s\S]*?)`;/);
    c.ok(Boolean(core) && !/只使用[^，。]*中文回复/.test(core[1]),
        '★ 核心协议里没有「只用中文回复」这类绝对规定');
    const defaultCard = config.match(/const DEFAULT_CHARACTER_CARD = \{[\s\S]*?\n\};/);
    c.ok(Boolean(defaultCard) && !/只使用[^，。]*简体中文回复/.test(defaultCard[0]),
        '★ 默认角色卡不再绝对锁定中文输出（改为默认中文 + 跟随用户语言）');
    c.ok(/叙述语言跟随用户输入的语言/.test(roleplay),
        '第三人称 GM 提示词也跟随用户语言');
    c.ok(!/全部以中文进行输出/.test(roleplay) && !/THINKING_LANGUAGE_PROMPT/.test(roleplay)
        && !/思维模式要求/.test(roleplay),
        '★ 思考语言要求已整条移除（不再干预思维链用哪种语言）');
    c.ok(!/完成中文回复后|只翻译中文正文/.test(roleplay),
        '★ 日语朗读稿指令不再假定正文是中文');
}

// 12. 手机操作的真机问题：打开错应用 / 两条进度条 / 停止卡在「停止中」。
//    这三条都只在 APK 上暴露，静态检查锁的是判据，行为由 dist/Android/test 的 CDP 测试补。
async function casePhoneAgentFixes(c) {
    const html = readFrontend();
    const phone = readWebFile('js/agent-phone.js');
    const cont = readWebFile('js/agent-continue.js');

    // 打开应用：应用名先解析成包名；解析不出来就停在原地列候选，绝不把猜的包名交给原生。
    c.ok(/function resolvePhoneOpenTarget\(/.test(phone), '有「应用名 → 包名」解析');
    c.ok(/resolvePhoneOpenTarget\(parsed\.args\)/.test(phone), '「手机打开」执行前先解析目标');
    c.ok(/function verifyPhoneOpenTarget\(/.test(phone), '打开后核对前台应用');
    c.ok(/verifyPhoneOpenTarget\(openPkg\)/.test(phone), '核对结果回灌给模型（打开错了不能当成成功）');
    c.ok(/backendOperatesPhysicalScreen\(/.test(phone),
        '按"是否操作物理屏"判断要不要核对前台（虚拟副屏上的应用本来就不在物理屏）');
    c.ok(/应用名或包名/.test(phone), '错误提示告诉模型可以直接写应用名');

    // 两条进度条：系统悬浮条在用时，应用内状态条不渲染。
    const rtStart = html.indexOf('const agentRuntime = (function ()');
    const rtEnd = html.indexOf('window.agentRuntime = agentRuntime;');
    const rt = (rtStart >= 0 && rtEnd > rtStart) ? html.slice(rtStart, rtEnd) : '';
    c.ok(/const showBar = running && !overlayActive/.test(rt),
        '★ 悬浮条在用时应用内状态条不渲染（只留一条进度）');
    c.ok(/overlayActive = true;/.test(rt) && /overlayActive = false;/.test(rt),
        '浮层显示 / 收起会同步这个状态');
    c.ok(/settingScreenWatchBtn/.test(html) && /openScreenWatch\(\)/.test(html),
        '「看画面」有状态条之外的入口（悬浮条模式下也能打开副屏监视）');

    // 停止：立刻收界面 + 与模型调用赛跑，不再等请求自己返回。
    const stopFn = rt.slice(rt.indexOf('function requestStop(reason)'), rt.indexOf('function settleStoppedRun()'));
    c.ok(/settleStoppedRun\(\)/.test(stopFn),
        '★ 停止当场收掉状态条 / 浮层（模型调用可能还要挂几分钟）');
    c.ok(/stopWaiters/.test(stopFn) && /wake\('stopped'\)/.test(stopFn),
        '停止会唤醒在途等待');
    c.ok(/function waitStopped\(/.test(rt), '提供可赛跑的「被停止」信号');
    c.ok(/function raceAgentStop\(/.test(cont), '模型调用与停止信号赛跑');
    c.ok(/raceAgentStop\(\s*raceAgentDeadline\(callAI\(continuePrompt/.test(cont),
        '续跑的两次尝试都走赛跑');
    c.ok(/if \(staleRun\(\)\) return;/.test(cont),
        '★ 迟到的旧回复按运行代号作废（停止后 / 新一轮开始后都不再执行）');
}

// 12.5 后台运行方式（Shizuku / Root / 模块）：前端两层选择、能力文案、白名单，
//      以及原生侧的 holder / 授权通道 / 命令通道不开放。
//      单独成一个用例：casePhone 在没有 mods/live2d 时整段跳过，会让这些断言在本地永远不跑。
async function caseBackgroundBackends(c) {
    const backend = readWebFile('js/agent-backend.js');
    const phone = readWebFile('js/agent-phone.js');
    const runtime = readWebFile('js/agent-runtime.js');
    const data = readWebFile('js/data.js');
    const html = readFrontend();

    // 一、注册表：四个端点，前台一个、后台三个。
    c.ok(/id: 'accessibility'[^}]*kind: 'foreground'/.test(backend), '无障碍标为前台');
    for (const id of ['shizuku', 'root', 'module']) {
        c.ok(new RegExp("id: '" + id + "'[^}]*kind: 'background'").test(backend), `${id} 标为后台`);
    }
    c.ok(/function backendKindOf\(/.test(backend) && /function backendDisplayName\(/.test(backend),
        '有 kind / 展示名 helper（面板与摘要共用同一份判断）');
    c.ok(/function readyBackgroundBackends\(/.test(backend), '有"已就绪的后台端点"清单');
    c.ok(/BACKEND_GROUPS/.test(backend) && /data-backend-group/.test(backend),
        '★ 面板分「前台运行 / 后台运行」两层');
    c.ok(/AGENT_BACKEND_SETUP/.test(backend) && /requestShizukuPermission/.test(backend) && /requestRootPermission/.test(backend),
        'Shizuku / Root 各有真实授权入口（不是只给说明文字）');
    c.ok(/backendProbeBtn/.test(backend) && /probeBackendDisplay/.test(backend)
        && /由于系统限制/.test(backend),
        '★ 有「检测副屏」按钮 + 简短文案（能否可用随 ROM 变化，授权后真建一次确认）');

    // 二、白名单：data.js 的迁移列表必须认得新 id，否则用户的选择每次启动都会被重置。
    c.ok(/\[[^\]]*'accessibility'[^\]]*'shizuku'[^\]]*'root'[^\]]*'module'[^\]]*\]\.includes\(state\.settings\.agentBackend\)/.test(data),
        '★ data.js 的 agentBackend 白名单含 shizuku / root');

    // 三、运行方式选择器：两层，后台多选一。
    c.ok(/function readyBackgroundChoices\(/.test(phone), '有"就绪的后台候选"清单');
    c.ok(/altValue: 'background'/.test(phone), '★ 第一层弹窗的「后台运行」不再写死某个后端');
    c.ok(/options: backgrounds\.map/.test(phone), '★ 后台有多个候选时用多选列表（N 选 1）');
    c.ok(/if \(backgrounds\.length === 1\) return backgrounds\[0\]\.id;/.test(phone),
        '只有一个后台候选时不弹第二层');
    c.ok(/function isKnownBackendId\(/.test(phone) && /isKnownBackendId\(runModeDecision\)/.test(phone),
        '★ backend 参数按"是不是合法 id"透传（不再只认 accessibility/module）');
    c.ok(/function backendOperatesPhysicalScreen\(/.test(phone), '前台核对按"是否操作物理屏"判断');

    // 四、能力文案：多后台就绪时如实说明"先选前台/后台"，命令面按可用后端算。
    c.ok(/const ready = AGENT_BACKENDS\.filter\(\(b\) => backendIsReady\(b\.id\)\)/.test(backend),
        '★ 能力文案读全部后端的状态，不再只读两个');
    c.ok(/const canFullKeys = backgroundReady\.length > 0/.test(backend), '按键面按"有没有后台端点"分档');
    c.ok(/「手机命令」不开放/.test(backend) && /「手机命令」这个版本不开放/.test(phone),
        '★ 提示词与执行闸都明确「手机命令」不开放');

    // 五、看画面按钮：只有模块有实时副屏流。
    c.ok(/effective === 'module'/.test(runtime), '★ 「看画面」仍只对模块显示（Shizuku/Root 走手机截图）');
    c.ok(/function syncAgentKeepAlive\(/.test(runtime), '后台会话有保活开关（切走后 agent 循环不被冻结）');

    // 六、原生：holder / 授权 / 命令通道。
    if (!existsSync(PLUGIN_JAVA)) {
        console.log('  --   跳过原生断言：没有 dist/Android 的 ElainaShellPlugin.java');
        return;
    }
    const plugin = readFileSync(PLUGIN_JAVA, 'utf8');
    const manifest = readFileSync(MANIFEST, 'utf8');
    const holder = path.join(JAVA_DIR, 'DisplayHolder.java');
    const shizuku = path.join(JAVA_DIR, 'ShizukuBridge.java');
    const rootBridge = path.join(JAVA_DIR, 'RootBridge.java');
    const agentService = path.join(JAVA_DIR, 'ElainaAgentService.java');
    for (const file of [holder, shizuku, rootBridge, agentService]) {
        c.ok(existsSync(file), '存在 ' + path.basename(file));
    }

    c.ok(/ID_SHIZUKU = "shizuku"/.test(plugin) && /ID_ROOT = "root"/.test(plugin), '原生有 shizuku / root 的 id 常量');
    c.ok(/result\.put\(ID_SHIZUKU,/.test(plugin) && /result\.put\(ID_ROOT,/.test(plugin),
        '★ status() 输出四个后端的键（前端按 id 读）');
    c.ok(/public void probeBackground\(/.test(plugin), '★ 有 probeBackground：真建一次副屏，把结果原样告诉用户');
    c.ok(/explainHolderHint/.test(plugin), '建屏失败原因要翻译成可执行的下一步');
    c.ok(/ShellBackends\.Executor\[\] order = \{ shizukuExecutor, rootExecutor, moduleExecutor \}/.test(plugin),
        '自动挑选顺序：Shizuku → Root → 模块');

    c.ok(/moe\.shizuku\.manager\.permission\.API_V23/.test(manifest), 'Manifest 声明了 Shizuku 授权权限');
    c.ok(/rikka\.shizuku\.ShizukuProvider/.test(manifest), 'Manifest 注册了 ShizukuProvider（授权通道）');
    // Root holder 走命令 / 结果文件 + token（RootBridge / RootHolderMain），不再声明 Binder Provider；
    // 多一个 exported Provider 就是多一处对外攻击面。
    c.ok(!/\.RootBridgeProvider/.test(manifest), 'Manifest 不声明已废弃的 RootBridgeProvider（Root 走文件桥）');
    c.ok(/\.ElainaAgentService/.test(manifest) && /specialUse/.test(manifest), '后台保活服务以 specialUse 前台服务声明');

    if (existsSync(holder)) {
        const holderSrc = readFileSync(holder, 'utf8');
        c.ok(/ImageReader\.newInstance/.test(holderSrc), '★ 副屏帧走 ImageReader（screencap -d 抓不到虚拟屏）');
        c.ok(/acquireLatestImage/.test(holderSrc) && /startDrain/.test(holderSrc),
            '★ 持续排空 ImageReader（不排空会让副屏冻结）');
        c.ok(/getPackageName\(\)\s*\{\s*return pkg;/.test(holderSrc) && /com\.android\.shell/.test(holderSrc),
            '★ 冒充 com.android.shell 的上下文（否则 packageName must match the calling uid）');
        c.ok(/FLAG_TRUSTED/.test(holderSrc) && /FLAG_OWN_FOCUS/.test(holderSrc) && /FLAG_STEAL_TOP_FOCUS_DISABLED/.test(holderSrc),
            '虚拟屏 flags 按 SDK 分层（trusted / 独立焦点）');
        c.ok(/已经在显示/.test(holderSrc), '★ 启动前检查"一个应用只能在一个屏"');
        c.ok(/am start --display/.test(holderSrc) && /input -d /.test(holderSrc), '动作定向到副屏（--display / -d）');
        c.ok(/SAFE_PACKAGE/.test(holderSrc) && /SAFE_COMPONENT/.test(holderSrc)
            && /包名格式不合法/.test(holderSrc) && /启动组件格式不合法/.test(holderSrc),
            '★★ 包名 / 组件在原生入口过白名单（绕过前端解析器也带不进 shell 元字符）');
        c.ok(/am start --display[^\n]*-n '"/.test(holderSrc)
            && /!target\.startsWith\(pkg \+ "\/"\)/.test(holderSrc),
            '★ 组件用单引号包进 shell，且必须与包名一致（$ 不会被变量展开）');
        c.ok(/KEYCODE_PASTE|keyevent 279/.test(holderSrc), '非 ASCII 输入走剪贴板粘贴兜底');
    }
    if (existsSync(shizuku)) {
        const src = readFileSync(shizuku, 'utf8');
        c.ok(/bindUserService/.test(src) && /\.tag\(/.test(src),
            '★ bindUserService 带显式 tag（不设时 R8 改名会让每次启动都起新进程）');
        c.ok(/getUid\(\)/.test(src), '状态区分 root 启动与 ADB 启动（uid 0 / 2000）');
        c.ok(/daemon\(false\)/.test(src), 'holder 不常驻（应用进程退出时跟着退）');
    }
    if (existsSync(rootBridge)) {
        const src = readFileSync(rootBridge, 'utf8');
        c.ok(/app_process/.test(src) && /--token=/.test(src), 'Root holder 用 su + app_process 启动并带一次性 token');
        c.ok(/PROBE_TTL_MS/.test(src), '★ su 探测结果有缓存（否则每次刷新状态都弹 root 授权）');
    }
    const shellBackends = path.join(JAVA_DIR, 'ShellBackends.java');
    if (existsSync(shellBackends)) {
        const src = readFileSync(shellBackends, 'utf8');
        c.ok(/HolderExecutor/.test(src) && /不执行任意命令/.test(src),
            '★ 后台 holder 不开放任意命令（命令通道等于把 root 交给模型）');
    }
}

// 6.6 API Key 存储：解不开的密文不能被静默删掉，也不能随系统备份搬走。
//     Keystore 里的密钥不参与备份；密文被备份回来又解不开时，用户看到的就是「更新完 Key 全没了」，
//     而原实现连排查线索都一起删了（decrypt 失败 → remove）。
async function caseByokSecrets(c) {
    const secretsJava = path.join(JAVA_DIR, 'ByokSecretsPlugin.java');
    if (!existsSync(secretsJava) || !existsSync(MANIFEST)) {
        console.log('  --   跳过：没有 dist/Android 的 ByokSecretsPlugin.java / AndroidManifest.xml（工作区被裁剪时正常）');
        return;
    }
    const java = readFileSync(secretsJava, 'utf8');
    const manifest = readFileSync(MANIFEST, 'utf8');
    const persistence = readWebFile('js/persistence.js');

    // 一、解密失败：必须报错给前端，且密文留底，不能当场删掉。
    const getSecret = java.slice(java.indexOf('public void getSecret'), java.indexOf('public void setSecret'));
    c.ok(!/catch\s*\([^)]*\)\s*\{\s*preferences\(\)\.edit\(\)\.remove\(name\)/.test(getSecret),
        '★★ 解密失败不再静默删除密文（原来会把唯一的线索一起删掉）');
    c.ok(/call\.reject\([^)]*SECRET_UNREADABLE/.test(getSecret),
        '★ 解密失败以 SECRET_UNREADABLE 报错（空值会被前端当成用户清空）');
    c.ok(/quarantine\(name, stored\)/.test(getSecret),
        '★ 解不开的密文先隔离保留（系统升级 / 换机恢复后还有解开的机会）');
    c.ok(/QUARANTINE_SUFFIX/.test(java) && /putString\(name \+ QUARANTINE_SUFFIX/.test(java),
        '隔离副本写进独立的键（不覆盖原键）');
    const setSecret = java.slice(java.indexOf('public void setSecret'), java.indexOf('public void clearSecrets'));
    c.ok(/editor\.remove\(name \+ QUARANTINE_SUFFIX\)/.test(setSecret),
        '★ 用户重填后清掉隔离副本（否则排查时会以为还有一份 Key）');

    // 二、系统备份保持开启：聊天记录 / 设置 / Key 都要能跟着备份迁移。
    // 这里只固定"备份没被关掉" —— 哪些内容进备份是「我的数据」导出那条链路的事（见 check-data）。
    c.ok(/android:allowBackup="true"/.test(manifest),
        '★ 系统备份保持开启（聊天记录 / 设置 / Key 要能跟着迁移）');

    // 三、前端要如实提示「哪几项读不到」，不能只留一行 console.warn。
    c.ok(/SECRET_UNREADABLE/.test(persistence),
        '★ 前端识别 SECRET_UNREADABLE 错误码');
    c.ok(/unreadable\.push\(name\)/.test(persistence) && /if \(unreadable\.length\)/.test(persistence),
        '★ 收集解不开的名字，逐项交给提示（不是只 warn 一行）');
    c.ok(/请到设置里重新填写/.test(persistence),
        '★★ 提示里写明下一步是重填（用户不知道该怎么办等于没提示）');
}

// 6.7 手机 Agent 闭环：动作后观测、无变化熔断、目标锚定、一次任务只发一段话。
async function caseAgentLoopQuality(c) {
    const phone = readWebFile('js/agent-phone.js');
    const cont = readWebFile('js/agent-continue.js');
    const voice = readWebFile('js/voice.js');
    const agentResult = readWebFile('js/agent-result.js');
    const tools = readWebFile('js/agent-tools.js');
    const tags = readWebFile('js/agent-tags.js');
    const core = readWebFile('js/core-config.js');
    const runtime = readWebFile('js/agent-runtime.js');
    const java = existsSync(PLUGIN_JAVA) ? readFileSync(PLUGIN_JAVA, 'utf8') : '';

    // 一、动作后必须回灌“界面有没有变”，不能只报“手势发出去了”。
    c.ok(/function diffUiObservation\(/.test(phone), '有界面快照差异函数');
    c.ok(/界面没有变化/.test(phone), '无变化有明确文案（模型不能把点空当成功）');
    c.ok(/function observePhoneActionResult\(/.test(phone), '动作后自动观测');
    c.ok(/【界面变化】/.test(phone), '差异随结果一起回灌给模型');
    c.ok(/lastPhoneActionOutcome/.test(phone) && /系统没有再次执行/.test(phone),
        '★ 同一动作无变化后再次出现会被代码拦下（不靠提示词自觉）');
    c.ok(/function enqueuePhoneOperation\(/.test(phone) && /phoneOpTail/.test(phone),
        '★ 手机动作串行执行（一条回复里的多个标签不并发乱序）');

    // 二、“成功但界面没变”不计进展，否则熔断永远不触发。
    c.ok(/options\.progress === false/.test(agentResult) && /options\.progress === null/.test(agentResult),
        'insertAgentResult 支持 progress=false / null');
    c.ok(/const progress = \(observationPlan && observationPlan\.exempt\)[\s\S]{0,420}?screenDiff\.changed === false \? false[\s\S]{0,120}?screenDiff\.changed === true \? true : null/.test(phone),
        '手机操作把界面差异换算成 progress（未知保持 null，豁免动作算进展）');
    c.ok(/result\.progress === false/.test(tools) && /result\.progress === null/.test(tools),
        '工具通道同样按 progress 记熔断（未知不动计数）');

    // 三、任务目标不能被 12 条历史窗口挤掉。
    c.ok(/state\._agentGoal/.test(voice), '用户原话存进本轮目标');
    c.ok(/本轮任务目标/.test(cont), '★ 续跑提示词每步都带上目标');
    c.ok(/已经执行/.test(cont), '续跑提示词带最近执行的步骤（防止反复做同一步）');

    // 四、中间正文不外发；完成 / 停止只发一段总结，并自动回到应用。
    c.ok(/const suppressReply = repliedToolCalls\.length > 0 \|\| hasTagOps \|\| nudged;/.test(voice),
        '★ 有动作时中间正文被压住');
    c.ok(/const shouldPersistReply = !suppressReply \|\| repliedToolCalls\.length > 0;/.test(voice),
        '中间正文不落库（工具协议消息例外）');
    c.ok(/function agentFinishRun\(/.test(cont) && /function appendAgentVisibleMessage\(/.test(cont),
        '有统一的收尾总结入口');
    c.ok(/agentFinishRun\('completed'/.test(cont), '正常完成走收尾');
    c.ok(/agentFinishRun\('fused'/.test(cont) && /agentFinishRun\('error'/.test(cont),
        '熔断 / 续跑失败也走收尾');
    c.ok(/agentFinishRun\('stopped'\)/.test(runtime), '用户停止也走收尾');
    c.ok(/function bringAppToFront\(/.test(cont) && /\.bringToFront\(\)/.test(cont) && /public void bringToFront/.test(java),
        '★ 任务结束自动回到应用（前端调用 + 原生方法都在）');
    c.ok(/function agentTagKeepsRunning\(/.test(cont) && /打开视频通话/.test(cont),
        '★ 纯表现标签（通话 / 记忆）不参与中间正文压制（否则用户等不到任何回复）');
    c.ok(/options\.system !== true/.test(agentResult), '系统催办不算“做成了事”（不污染收尾判据）');
    c.ok((cont.match(/system: true/g) || []).length >= 2,
        '★★ 两处系统催办都显式传 system: true（守卫没有调用点等于死代码）');
    c.ok(/hasCompletion/.test(cont) && /\[完成\]/.test(cont) && /\[完成\]/.test(tags),
        '★ [完成] 是明确的收尾标记，且会被剥离');
    c.ok(/不要写任何旁白/.test(cont), '提示词禁止执行期旁白');

    // 五、文风：少用括号动作，改用语气词。
    c.ok(/【表达方式】/.test(core) && /摇了摇头/.test(core) && /语气词/.test(core),
        '核心协议要求少用括号动作描写、用语气词表达');

    // 六、视觉坐标网格的说明必须和实际线距一致（错一倍会偏半格）。
    c.ok(/每 50px 一条线/.test(phone), '截图网格说明与实际 50px 线距一致');

    // 七、差异函数的行为：无变化 / 新增 / 消失都要判对。
    const diffSrc = extractFnFrom(phone, 'phoneNodeState') + '\n'
        + extractFnFrom(phone, 'countPhoneNodes') + '\n'
        + extractFnFrom(phone, 'phoneNodeLabel') + '\n'
        + extractFnFrom(phone, 'diffPhoneNodeStates') + '\n'
        + extractFnFrom(phone, 'diffUiObservation');
    const sandbox = makeVmSandbox({});
    vm.runInContext(diffSrc + '\nwindow.__diffUiObservation = diffUiObservation;', sandbox, { filename: 'diffUiObservation.js' });
    const same = sandbox.__diffUiObservation(
        { signature: 'a', nodes: [{ label: '发送', id: 'btn_send', x: 1, y: 2 }] },
        { signature: 'a', nodes: [{ label: '发送', id: 'btn_send', x: 1, y: 2 }] }
    );
    c.ok(same.changed === false && /没有变化/.test(same.text), '相同快照判为无变化');
    const different = sandbox.__diffUiObservation(
        { signature: 'a', nodes: [{ label: '登录', id: '', x: 1, y: 2 }] },
        { signature: 'b', nodes: [{ label: '发送', id: '', x: 3, y: 4 }] }
    );
    c.ok(different.changed === true && /新增/.test(different.text) && /消失/.test(different.text),
        '不同快照给出新增 / 消失');
}

// 6.8 元素引用点击：正常界面优先 #编号 / id，旧编号过期要拒绝。
async function caseElementRef(c) {
    const phone = readWebFile('js/agent-phone.js');
    const backend = readWebFile('js/agent-backend.js');
    const java = existsSync(PLUGIN_JAVA) && existsSync(path.join(JAVA_DIR, 'ElainaAccessibilityService.java'))
        ? readFileSync(path.join(JAVA_DIR, 'ElainaAccessibilityService.java'), 'utf8') : '';

    c.ok(/function resolvePhoneNodeRef\(/.test(phone), '有 #编号 / id 解析函数');
    c.ok(/手机点击 #N|#编号/.test(backend), '提示词教模型优先用 #编号');
    c.ok(/bounds=/.test(java) && /cls=/.test(java) && /parent=“/.test(java),
        '原生 dump 输出 bounds / className / 父容器文字');
    c.ok(/preferredTapPoint\(/.test(java) && /isVisibleToUser\(\)/.test(java),
        '原生 tap point 优先取内部文字子节点，并过滤不可见节点');

    const sandbox = makeVmSandbox({});
    vm.runInContext(extractVariable(phone, 'UI_NODE_LINE') + '\n'
        + extractFnFrom(phone, 'parseUiNodes') + '\nwindow.__parseUiNodes = parseUiNodes;',
        sandbox, { filename: 'parseUiNodes.js' });
    const nodes = sandbox.__parseUiNodes(
        '#2 “发送” id=btn_send cls=Button 可点 bounds=440,1160,640,1240 parent=“张三” [540,1200]');
    c.ok(nodes.length === 1 && nodes[0].ref === 1 && nodes[0].id === 'btn_send'
        && nodes[0].className === 'Button' && nodes[0].parent === '张三'
        && nodes[0].bounds.left === 440 && nodes[0].x === 540,
        '清单解析保留 ref / bounds / className / 父容器');

    const refSandbox = makeVmSandbox({});
    refSandbox.currentScreenObservation = {
        at: Date.now(), stale: false,
        nodes: nodes.concat([{ ref: 2, label: '取消', id: 'btn_cancel', x: 200, y: 300,
            bounds: { left: 150, top: 260, right: 250, bottom: 340 } }]),
    };
    vm.runInContext(extractFnFrom(phone, 'resolvePhoneNodeRef') + '\n'
        + extractFnFrom(phone, 'phoneNodeAtPoint') + '\n'
        + 'window.__resolve = resolvePhoneNodeRef; window.__hit = phoneNodeAtPoint;',
        refSandbox, { filename: 'phoneRef.js' });
    const hitRef = refSandbox.__resolve({ action: '手机点击', args: '#1' });
    c.ok(hitRef && hitRef.point && hitRef.point.x === 540 && hitRef.point.y === 1200,
        '按 #1 点击命中正确坐标');
    const hitId = refSandbox.__resolve({ action: '手机点击', args: 'id:btn_cancel' });
    c.ok(hitId && hitId.point && hitId.point.x === 200, '按 id 点击命中正确坐标');
    const hitNode = refSandbox.__hit(refSandbox.currentScreenObservation.nodes, 600, 1200);
    c.ok(hitNode && hitNode.id === 'btn_send', '坐标命中测试找到对应节点');
    refSandbox.currentScreenObservation.at = Date.now() - 10000;
    const stale = refSandbox.__resolve({ action: '手机点击', args: '#1' });
    c.ok(stale && stale.error && /过期/.test(stale.error), '旧 #1 被拒绝（超过有效期）');
    refSandbox.currentScreenObservation.at = Date.now();
    refSandbox.currentScreenObservation.stale = true;
    const stale2 = refSandbox.__resolve({ action: '手机点击', args: '#1' });
    c.ok(stale2 && stale2.error && /过期|变化/.test(stale2.error), '界面变化后旧 #1 被拒绝');
}

// 6.9 截图链路降本：普通界面不截图、截图并行取树、多模态主模型直连、缩放后再编码。
async function caseScreenshotCost(c) {
    const phone = readWebFile('js/agent-phone.js');
    c.ok(/function downscaleDataUrl\(/.test(phone), '有截图缩放函数');
    c.ok(/const scaled = await downscaleDataUrl\(picture, 1120\)/.test(phone)
        && /describeImageWithVision\(prompt, await downscaleDataUrl\(picture, 1120\)\)/.test(phone),
        '标注后的截图缩到长边 1120 再编码');
    c.ok(/const dumpPromise = parsed\.action === '手机截图' \? callDeviceQuietly\('手机查看界面'/.test(phone),
        '截图和控件树并行取');
    c.ok(/function describePhoneScreenshot\(res, fallbackText, knownDumpText\)/.test(phone)
        && /if \(!dumpText\)/.test(phone),
        'describePhoneScreenshot 复用调用方给的控件树，缺了才重新 dump');
    c.ok(/const mainSupportsImage = verdict === true/.test(phone)
        && /if \(mainSupportsImage \|\|/.test(phone) && /setPendingAgentImage\(scaled\)/.test(phone),
        '主模型多模态时直接附图，不再走视觉模型转述');
    // 普通界面读界面不再因为“节点少”就截图：判据改成覆盖低 / SurfaceView 提示。
    const stashBlock = phone.slice(phone.indexOf("parsed.action === '手机查看界面' && !phoneVisionModelConfigured()"),
        phone.indexOf("if (PHONE_SUMMARY_ACTIONS.has(parsed.action)"));
    c.ok(/screenProfile\(\{ text: verifiedResult, nodes: viewNodes, stable: true \}/.test(stashBlock)
        && /phoneHasPixelSurface\(profile\) \|\| viewNodes\.length === 0/.test(stashBlock)
        && !/\.length < 4/.test(stashBlock),
        '普通界面不触发截图（只对无控件 / SurfaceView 页面自动附图）');
    c.ok(/每 50px 一条线/.test(phone), '网格说明与实际线距一致');
}

// 6.10 settle：两次 dump 签名一致才算稳定；不稳定时 changed 只能 unknown。
async function caseSettle(c) {
    const phone = readWebFile('js/agent-phone.js');
    const agentResult = readWebFile('js/agent-result.js');
    const tools = readWebFile('js/agent-tools.js');
    c.ok(/function readStableObservation\(/.test(phone), '有 wait-for-stable 观测');
    c.ok(!/setTimeout\(resolve, 260\)/.test(phone), '不再固定等 260ms');
    c.ok(/PHONE_OBSERVATION_TTL_MS/.test(phone) && /ensureScreenObservation[\s\S]{0,300}?TTL_MS/.test(phone),
        '操作前快照有有效期，过期重读');
    c.ok(/stable: false, text: '画面持续变化/.test(phone), '不稳定时明确输出无法判断');
    c.ok(/options\.progress === null/.test(agentResult) && /result\.progress === null/.test(tools),
        'changed:null 不记进展');

    const sandbox = makeVmSandbox({ setTimeout, clearTimeout });
    vm.runInContext(extractFnFrom(phone, 'sleepMs') + '\n'
        + extractFnFrom(phone, 'readStableObservation') + '\n'
        + 'window.__settle = readStableObservation;', sandbox, { filename: 'readStableObservation.js' });
    sandbox.readUiObservation = () => Promise.resolve({ signature: 'A' });
    const stable = await sandbox.__settle({ signature: 'A' }, { pollMs: 1, timeoutMs: 30, firstDelayMs: 0 });
    c.ok(stable.stable === true, '两帧一致返回 stable:true');
    let n = 0;
    sandbox.readUiObservation = () => Promise.resolve({ signature: 'S' + (n++) });
    const unstable = await sandbox.__settle(null, { pollMs: 1, timeoutMs: 15, firstDelayMs: 0 });
    c.ok(unstable.stable === false, '持续变化返回 stable:false');
}

// 6.11 历史压缩：只留一份当前界面，旧观察压成一行历史。
async function caseHistoryCompaction(c) {
    const agentResult = readWebFile('js/agent-result.js');
    const tools = readWebFile('js/agent-tools.js');
    const cont = readWebFile('js/agent-continue.js');
    const phone = readWebFile('js/agent-phone.js');
    c.ok(/function compactAgentObservations\(/.test(agentResult), '有旧观察压缩函数');
    c.ok(/options\.observation === true/.test(agentResult) && /msg\.currentScreen = options\.currentScreen === true/.test(agentResult),
        'insertAgentResult 支持 observation / currentScreen');
    c.ok(/meta\.observation === true/.test(tools) && /currentScreen/.test(tools),
        '工具通道也带当前界面标记');
    c.ok(/当前界面｜第 '\s*\+/.test(agentResult) && /｜历史】/.test(agentResult),
        '新观察标当前界面，旧观察标历史');
    c.ok(/只有标着「当前界面」/.test(cont), '提示词说明旧坐标不可用');
    c.ok(/observation: true, currentScreen, step: stepNo, summary: stepSummary/.test(phone),
        '手机操作把步骤 / 摘要 / 当前界面标记交给观察消息');

    const sandbox = makeVmSandbox({});
    vm.runInContext(extractFnFrom(agentResult, 'compactAgentObservations')
        + '\nwindow.__compact = compactAgentObservations;', sandbox, { filename: 'compactAgentObservations.js' });
    const messages = [
        { role: 'ai', kind: 'agent-observation', step: 3, currentScreen: true,
            text: '【AI 操作结果｜当前界面｜第 3 步】\n一大段完整 dump', summary: '第 3 步：读取界面（12 个元素）' },
        { role: 'user', text: '用户消息' },
    ];
    sandbox.__compact(messages);
    c.ok(messages[0].currentScreen === false && /｜历史】/.test(messages[0].text)
        && /第 3 步：读取界面/.test(messages[0].text) && !/完整 dump/.test(messages[0].text),
        '旧完整 dump 被压成一行历史');
    c.ok(messages[1].text === '用户消息', '非观察消息不被改写');
}

// 6.12 控件清单增强：状态 / 父容器 / 分页 / 同名区分。
async function caseClipList(c) {
    const phone = readWebFile('js/agent-phone.js');
    const sandbox = makeVmSandbox({});
    vm.runInContext(extractVariable(phone, 'UI_NODE_LINE') + '\n'
        + extractFnFrom(phone, 'parseUiNodes') + '\n'
        + extractFnFrom(phone, 'phoneNodeState') + '\n'
        + extractFnFrom(phone, 'phoneNodeDisp') + '\n'
        + extractFnFrom(phone, 'parseUiMeta') + '\n'
        + extractFnFrom(phone, 'phoneDumpMeta') + '\n'
        + extractFnFrom(phone, 'summarizeUiDumpForModel') + '\n'
        + 'window.__parse = parseUiNodes; window.__disp = phoneNodeDisp; window.__sum = summarizeUiDumpForModel;'
        + ' window.__meta = phoneDumpMeta;',
        sandbox, { filename: 'clipList.js' });

    const lines = ['# 概况 控件覆盖=38% 文字=12 可滑=1'];
    for (let i = 1; i <= 45; i++) {
        lines.push('#' + i + ' “按钮' + i + '” id=btn_' + i
            + ' cls=Button 可点 bounds=' + (10 + i) + ',100,' + (100 + i) + ',180 [50,140]');
    }
    lines.push('#46 “发送” id=btn_send cls=Button 可点 bounds=440,1160,640,1240 parent=“张三” [540,1200]');
    lines.push('#47 “发送” id=btn_send2 cls=Button 可点 bounds=440,1460,640,1540 parent=“李四” [540,1500]');
    lines.push('#48 “WiFi” id=switch_wifi cls=Switch 可点 已选 bounds=100,300,300,380 [200,340]');
    const dump = lines.join('\n');

    const page1 = sandbox.__sum(dump, 1);
    c.ok(/#1 /.test(page1) && /#40 /.test(page1) && /还有 8 个/.test(page1)
        && /\[操作:手机查看界面 2\]/.test(page1), '第一页 40 条 + 分页提示');
    const page2 = sandbox.__sum(dump, 2);
    c.ok(/#41 /.test(page2) && /#45 /.test(page2), '第二页从 #41 继续');
    c.ok(/\[在：张三\]/.test(page2) && /\[在：李四\]/.test(page2),
        '同名按钮带父容器文字可区分');
    c.ok(/WiFi[\s\S]{0,80}已选/.test(page2), '开关状态进入清单');
    c.ok(/按钮1[\s\S]{0,80}\(50,140\)/.test(page1), '清单带坐标');

    // 「当前应用」进摘要首行：执行者靠它判断自己在哪，不必每步额外查设备信息
    const linesWithFg = ['# 概况 前台=设置（com.android.settings） 屏幕=900x1600 控件覆盖=38% 文字=12 可滑=1'];
    for (let i = 1; i <= 3; i++) {
        linesWithFg.push('#' + i + ' “条目' + i + '” id=item_' + i
            + ' cls=TextView 可点 bounds=10,100,400,180 [' + (50 + i) + ',140]');
    }
    const pageFg = sandbox.__sum(linesWithFg.join('\n'), 1);
    c.ok(/^当前应用：设置（com\.android\.settings）/.test(pageFg),
        '★ 摘要第一行写明当前应用（每步不必再查手机设备信息）');
    const metaFg = sandbox.__meta(linesWithFg.join('\n'));
    c.ok(metaFg.foreground && metaFg.foreground.pkg === 'com.android.settings'
        && metaFg.screen && metaFg.screen.width === 900 && metaFg.screen.height === 1600,
        '概况行解析出前台应用与物理屏幕尺寸');
}

// 6.13 区域级观测：screenProfile + 动作落点，不再用 canvasLike / 节点数阈值。
async function caseRegionObservation(c) {
    const phone = readWebFile('js/agent-phone.js');
    c.ok(/function screenProfile\(/.test(phone), '有 screenProfile');
    c.ok(/function actionNeedsPixelObservation\(/.test(phone), '有动作落点判定');
    c.ok(/function regionPointToScreen\(/.test(phone), '有 region offset → 屏幕坐标映射');
    c.ok(!/canvasLike/.test(phone), '不再使用 canvasLike 二选一');
    c.ok(!/imageBase64\s*!==|imageBase64\s*===/.test(phone), '不再用 base64 字节相等判断变化');

    const src = [
        extractVariable(phone, 'SCREEN_GRID'),
        extractFnFrom(phone, 'parseUiMeta'),
        extractFnFrom(phone, 'inferScreenSize'),
        extractFnFrom(phone, 'markOccupiedGrid'),
        extractFnFrom(phone, 'largestEmptyRect'),
        extractFnFrom(phone, 'screenProfile'),
        extractFnFrom(phone, 'clampRegion'),
        extractFnFrom(phone, 'phoneNodeAtPoint'),
        extractFnFrom(phone, 'phoneHasPixelSurface'),
        extractFnFrom(phone, 'actionNeedsPixelObservation'),
        extractFnFrom(phone, 'regionPointToScreen'),
        'window.__profile = screenProfile; window.__plan = actionNeedsPixelObservation;'
            + 'window.__map = regionPointToScreen;',
    ].join('\n');
    const sandbox = makeVmSandbox({});
    sandbox.lastScreenSize = { width: 1080, height: 2400 };
    vm.runInContext(src, sandbox, { filename: 'screenProfile.js' });
    const node = (ref, x, y, extra = {}) => ({
        ref, label: '按钮' + ref, id: 'btn_' + ref, x, y,
        bounds: { left: x - 40, top: y - 30, right: x + 40, bottom: y + 30 },
        clickable: true, scrollable: false, editable: false, checked: null, enabled: true,
        focused: false, className: 'Button', ...extra,
    });

    const shell = [node(1, 100, 100), node(2, 300, 100), node(3, 500, 100),
        node(4, 700, 100), node(5, 900, 100)];
    const gameProfile = sandbox.__profile({ nodes: shell, text: '' }, sandbox.lastScreenSize);
    const boardClick = sandbox.__plan({ action: '手机点击', args: '540 1200' }, gameProfile, { nodes: shell });
    c.ok(boardClick.mode === 'region', '游戏壳控件多，但点棋盘走像素区域');
    const shellClick = sandbox.__plan({ action: '手机点击', args: '100 100' }, gameProfile, { nodes: shell });
    c.ok(shellClick.mode === 'controls' && shellClick.secondCheck === false,
        '点壳控件走控件签名，不额外截图');

    const normal = [node(1, 540, 1200)];
    const normalProfile = sandbox.__profile({ nodes: normal, text: '' }, sandbox.lastScreenSize);
    const normalClick = sandbox.__plan({ action: '手机点击', args: '540 1200' }, normalProfile, { nodes: normal });
    c.ok(normalClick.mode === 'controls', '普通按钮走控件签名');

    const dialog = [node(1, 400, 1800), node(2, 680, 1800)];
    const dialogProfile = sandbox.__profile({ nodes: dialog, text: '' }, sandbox.lastScreenSize);
    const dialogClick = sandbox.__plan({ action: '手机点击', args: '400 1800' }, dialogProfile, { nodes: dialog });
    c.ok(dialogClick.mode === 'controls', '两按钮弹窗不被判画布');

    const mixedText = '# 概况 控件覆盖=5% 文字=2 可滑=0 画布提示=SurfaceView\n';
    const mixedProfile = sandbox.__profile({ nodes: [node(1, 100, 100)], text: mixedText }, sandbox.lastScreenSize);
    const videoClick = sandbox.__plan({ action: '手机点击', args: '540 1200' }, mixedProfile, { nodes: [node(1, 100, 100)] });
    c.ok(mixedProfile.surfaceHints.length > 0 && videoClick.mode === 'region',
        '混合页面 / 视频区域走像素');
    const nativeText = '# 概况 前台=消消乐（com.demo.game） 屏幕=1080x2400 控件覆盖=42% 文字=17 可滑=2 画布提示=SurfaceView,TextureView\n';
    const nativeProfile = sandbox.__profile({ nodes: shell, text: nativeText }, sandbox.lastScreenSize);
    c.ok(nativeProfile.surfaceHints.length === 2 && Math.abs(nativeProfile.coverage - 0.42) < 1e-6,
        '原生概况行（前台 / 屏幕在前）也能取到覆盖与画布提示');
    const surfaceHit = sandbox.__plan({ action: '手机点击', args: '100 100' }, mixedProfile, { nodes: [node(1, 100, 100)] });
    c.ok(surfaceHit.mode === 'controls' && surfaceHit.secondCheck === true
        && surfaceHit.rect && surfaceHit.rect.w > 0 && surfaceHit.rect.h > 0,
        '命中控件但页面有画布时，二次确认计划必须带截图区域（否则取图恒 null）');
    const mapped = sandbox.__map({ meta: { regionX: 100, regionY: 200, regionW: 280, regionH: 280, imageWidth: 560, imageHeight: 560 } }, 50, 50);
    c.ok(mapped.x === 125 && mapped.y === 225, 'region 坐标映射回屏幕坐标');
}

// 6.14 可观测性：每动作模型调用 / 无变化占比 / 设备耗时 / 完成率。
async function caseMetrics(c) {
    const cont = readWebFile('js/agent-continue.js');
    const phone = readWebFile('js/agent-phone.js');
    c.ok(/function agentRunNoteMetric\(/.test(cont) && /function agentMetricsSnapshot\(/.test(cont),
        '有运行度量函数');
    c.ok(/modelPerAction/.test(cont) && /noChangeRatio/.test(cont) && /avgDeviceMs/.test(cont)
        && /completionRate/.test(cont), '汇总包含模型调用 / 无变化 / 耗时 / 完成率');
    c.ok(/window\.__agentMetrics = snapshot/.test(cont) && /运行汇总/.test(cont),
        '度量只写日志与 window，不进聊天');
    c.ok(/agentRunMetrics\.modelCalls \+= 1/.test(cont), '每次模型调用都计数');
    c.ok(/agentRunNoteMetric\(\{/.test(phone) && /deviceMs: Date\.now\(\) - deviceStartedAt/.test(phone),
        '手机动作记录设备耗时 / 观测方式');

    const sandbox = makeVmSandbox({});
    vm.runInContext(extractVariable(cont, 'agentRunMetrics') + '\n'
        + extractVariable(cont, 'agentLifetimeStats') + '\n'
        + extractFnFrom(cont, 'agentRunNoteMetric') + '\n'
        + extractFnFrom(cont, 'agentMetricsSnapshot') + '\n'
        + 'window.__metrics = agentRunMetrics; window.__note = agentRunNoteMetric;'
        + ' window.__snap = agentMetricsSnapshot;',
        sandbox, { filename: 'agentMetrics.js' });
    sandbox.__metrics.startedAt = Date.now() - 1000;
    sandbox.__note({ deviceMs: 100, mode: 'controls', changed: true });
    sandbox.__note({ deviceMs: 50, mode: 'region', changed: false });
    sandbox.__metrics.modelCalls = 2;
    const snap = sandbox.__snap('completed');
    c.ok(snap.actions === 2 && snap.deviceMs === 150 && snap.changed === 1
        && snap.noChange === 1 && snap.modelPerAction === 1
        && snap.modes.controls === 1 && snap.modes.region === 1,
        '度量数值正确（动作 / 耗时 / 变化 / 每动作调用）');
}

// 6.15 无障碍优先批次：窗口开关 / 事件 settle / 输入校验 / 遮挡 / 长按 / 截图缩放。
async function caseA11yUpgrade(c) {
    const a11yJava = existsSync(path.join(JAVA_DIR, 'ElainaAccessibilityService.java'))
        ? readFileSync(path.join(JAVA_DIR, 'ElainaAccessibilityService.java'), 'utf8') : '';
    const pluginJava = existsSync(PLUGIN_JAVA) ? readFileSync(PLUGIN_JAVA, 'utf8') : '';
    const artifactsJava = existsSync(path.join(JAVA_DIR, 'DeviceArtifacts.java'))
        ? readFileSync(path.join(JAVA_DIR, 'DeviceArtifacts.java'), 'utf8') : '';
    const a11yXml = existsSync(path.join(ANDROID_ROOT, 'android', 'app', 'src', 'main', 'res', 'xml', 'elaina_accessibility.xml'))
        ? readFileSync(path.join(ANDROID_ROOT, 'android', 'app', 'src', 'main', 'res', 'xml', 'elaina_accessibility.xml'), 'utf8') : '';
    const phone = readWebFile('js/agent-phone.js');
    const backend = readWebFile('js/agent-backend.js');

    // 一、XML：getWindows() 的开关必须打开，否则选窗口 / 遮挡检测静默退化。
    c.ok(/flagRetrieveInteractiveWindows/.test(a11yXml),
        '★★ 无障碍声明包含 flagRetrieveInteractiveWindows（getWindows 依赖它）');

    // 二、事件驱动 settle + 快照失效。
    c.ok(/isUiQuiet\(/.test(a11yJava) && /TYPE_WINDOW_CONTENT_CHANGED/.test(a11yJava),
        '★ 服务记录界面变化事件（安静判定）');
    c.ok(/notifyListeners\("a11yUiChanged"/.test(pluginJava) && /setUiChangeListener\(/.test(pluginJava),
        '界面变化事件经插件转发到前端');
    c.ok(/dev\.addListener\('a11yUiChanged'[\s\S]{0,120}?currentScreenObservation\.stale = true/.test(phone),
        '前端收到事件即把观察快照标 stale');
    c.ok(/const quiet = await waitUiQuiet\(\)/.test(phone), 'settle 先等事件安静再读界面');

    // 三、输入读回校验 + 粘贴兜底。
    c.ok(/target\.refresh\(\)/.test(a11yJava) && /读回一致/.test(a11yJava),
        '★ 输入后读回校验（静默输入失败不再被当成成功）');
    c.ok(/ACTION_PASTE/.test(a11yJava) && /setPrimaryClip/.test(a11yJava),
        'SET_TEXT 被拒时剪贴板粘贴兜底');

    // 四、点击遮挡 + 长按 + 失败语义化。
    c.ok(/obstructionAt\(/.test(a11yJava) && /被其他窗口遮挡/.test(a11yJava),
        '★ 点击前做遮挡检测（弹窗 / 悬浮球不再假装点到了）');
    c.ok(/longPress\(int x, int y, int durationMs\)/.test(a11yJava) && /durationMs >= 400/.test(pluginJava),
        '手机点击第三参数 = 长按毫秒（与模块后端对齐）');
    c.ok(/不要按原坐标重试/.test(a11yJava), '手势失败文案语义化（引导重读界面）');

    // 五、native 截图缩放 + region 坐标换算。
    c.ok(/SCREENSHOT_MAX_SIDE = 1120/.test(a11yJava) && /createScaledBitmap/.test(a11yJava),
        '无障碍截图长边压到 1120（物理尺寸仍回传，前端网格不受影响）');
    c.ok(/readRegion\(byte\[\] jpeg, int x, int y, int w, int h, int screenW, int screenH\)/.test(artifactsJava),
        'readRegion 支持缩放比换算（物理坐标 → 图内像素）');
    c.ok(/readRegion\(jpeg, p\[0\], p\[1\], p\[2\], p\[3\], 0, 0\)/.test(pluginJava),
        '模块整屏截图未缩放，按 1:1 裁剪');
    c.ok(/照网格标签读数即可/.test(artifactsJava),
        '截图说明兼容网格标注（不再和“要乘 scaleX”打架）');

    // 六、提示词：长按用法。
    c.ok(/手机点击 x y \[毫秒\]/.test(backend), '提示词声明长按写法');
}

// 6.16 子代理会话：独立上下文 / 双向通道 / 报告写回与角色转述 / 生命周期守卫。
async function caseAgentSession(c) {
    const session = readWebFile('js/agent-session.js');
    const cont = readWebFile('js/agent-continue.js');
    const phone = readWebFile('js/agent-phone.js');
    const voice = readWebFile('js/voice.js');
    const tags = readWebFile('js/agent-tags.js');
    const access = readWebFile('js/agent-access.js');
    const runtime = readWebFile('js/agent-runtime.js');
    const chat = readWebFile('js/chat.js');
    const indexHtml = readFrontend();

    // 一、接线：脚本加载 + 循环分支 + 手机动作路由。
    c.ok(/agent-session\.js/.test(indexHtml), 'agent-session.js 已加载');
    c.ok(/if \(typeof agentSessionActive === 'function' && agentSessionActive\(\)\) \{\s*\n\s*return agentSessionStep\(rt, staleRun\);/.test(cont),
        '★ 续跑循环里子代理会话走独立分支');
    c.ok(/if \(typeof agentSessionStart === 'function'\) agentSessionStart\(state\._agentGoal\);/.test(phone),
        '★ 手机动作实际执行前启动会话（主对话只派发不执行）');
    c.ok(/if \(agentSessionActive\(\)\) \{[\s\S]{0,160}?agentSessionAddObservation\(opResult/.test(phone),
        '★ 会话模式观察进子代理上下文，不写主对话');
    const agentCallFn = extractFnFrom(chat, 'callAgentSessionAI');
    c.ok(/function callAgentSessionAI\(/.test(chat) && /callChatAPI\(messages,/.test(agentCallFn)
        && !/buildLayeredRoleplayMessages/.test(agentCallFn),
        '★★ 子代理模型调用不经角色提示词构建（上下文分离的落点）');

    // 二、简报：目标 / 相关记忆 / 最近对话 / 主对话备注 / 求助通道 / 技术性总结。
    c.ok(/## 相关经历/.test(session) && /getRelatedMemories\(goal\)/.test(session), '简报带相关长期记忆');
    c.ok(/## 最近对话/.test(session), '简报带最近对话背景');
    c.ok(/## 主对话备注/.test(session) && /state\._agentDispatchReply/.test(session),
        '简报带主对话派发时交代的背景');
    c.ok(/\[操作:问主代理 你的问题\]/.test(session) && /AGENT_SESSION_ASK_LIMIT/.test(session),
        '简报教求助通道与次数上限');
    c.ok(/技术性总结/.test(session) && /不进行角色扮演/.test(session), '简报声明执行者边界与收尾格式');

    // 三、双向通道：问主代理 / steering。
    c.ok(/if \(\/\^问主代理\/\.test\(name\)\)/.test(tags), '标签分发识别问主代理');
    c.ok(/agentAskMain\(raw\)/.test(access), 'agentActions 挂载求助处理');
    c.ok(/async function agentSessionAskMain\(/.test(session) && /向你求助/.test(session),
        '求助经主模型（带完整记忆）回答');
    c.ok(/【主对话答复】/.test(session), '答复作为观察注入子代理上下文');
    c.ok(/agentRunMetrics\.modelCalls \+= 1/.test(session), '求助也计入模型调用');
    c.ok(/raceAgentDeadline\(callAI\(prompt, askOptions\)/.test(session)
        && /deadlineMs: AGENT_CONTINUE_CALL_DEADLINE_MS/.test(session),
        '★★ ask_main 与续跑同一套死线，慢网关不会把会话挂住');
    c.ok(/ask_main 缺少 question 参数/.test(session) && /void agentSessionAskMain\(q\)/.test(session),
        '★★ 空 question 留下观察并调度下一步（不静默卡死）');
    c.ok(/操作子代理正在运行/.test(voice), '★ 子代理运行中的用户消息会带 steering 通知给主对话');
    c.ok(/state\._agentDispatchReply = aiMessage\.text/.test(voice) && /state\._agentDispatchReply = text/.test(cont),
        '两条通道都捕获派发回复');

    // 四、生命周期：报告写回 + 角色转述 + 守卫。
    c.ok(/【子代理执行报告】/.test(session), '收尾生成执行报告');
    c.ok(/agentSessionTeardown\(reason\)/.test(cont) && /你派出的操作子代理已经执行完毕/.test(session),
        '★ 报告写回主对话 + 主模型角色转述（临时会话删除，报告喂记忆）');
    c.ok(/raceAgentDeadline\(callAI\(relayPrompt, relayOptions\)/.test(session)
        && /relayText === AGENT_STOPPED/.test(session),
        '★★ 完成转述有死线且能被停止打断');
    c.ok(/if \(typeof agentSessionActive === 'function' && agentSessionActive\(\)\) \{\s*\n\s*state\._agentNarrationStreak = 0;\s*\n\s*return;/.test(cont),
        '★ 子代理运行中聊天消息不重置熔断 / 目标');
    c.ok(/if \(typeof agentSessionActive === 'function' && agentSessionActive\(\)\) return;/.test(runtime),
        '★ beginBatch 不打断子代理（不解禁停止 / 不动代号）');

    // 六、工具调用：子代理在支持 function calling 的供应商上走原生工具（标签退为兜底）。
    c.ok(/function agentSessionTools\(/.test(session) && /agentSessionExecutionOps\(\)/.test(session)
        && /const AGENT_SESSION_EXEC_NS = \['phone', 'file', 'pc'\]/.test(session),
        '★ 会话工具清单从 ElainaOps 注册表单一来源取执行型操作（phone / file / pc）');
    c.ok(/options\.tools = agentSessionTools\(\)/.test(session)
        && !/shouldTeachTags/.test(session),
        '★ 子代理始终传 tools（不再按 shouldTeachTags 门控）');
    c.ok(/const repliedToolCalls = \(options\.replyInfo && Array\.isArray\(options\.replyInfo\.toolCalls\)\)/.test(session)
        && /void enqueuePhoneOperation\(rawArg\)/.test(session),
        '工具调用经 enqueuePhoneOperation 执行（与标签同一执行层）');
    c.ok(/toolName === 'ask_main'/.test(session) && /void agentSessionAskMain\(q\)/.test(session),
        'ask_main 作为会话工具（主对话工具清单没有它，避免角色自问自答）');
    c.ok(/name: 'ask_main'/.test(session), 'ask_main 是会话专属工具定义');

    // 七、VM 行为：简报组装（记忆 + 最近对话 + 备注 + 求助说明）。
    const sandbox = makeVmSandbox({ state: { _agentDispatchReply: '上次玩到第 12 关，这次接着打' } });
    sandbox.window = sandbox;
    sandbox.getCurrentConversation = () => ({ messages: [
        { role: 'user', text: '帮我打消消乐过到15关' },
        { role: 'ai', text: '好呀，上次我们一起卡在第12关了' },
    ] });
    sandbox.getRelatedMemories = () => [{ date: '2026-11-10', content: '一起玩了消消乐，卡在第 12 关' }];
    sandbox.agentPhoneSkillText = () => '# Agent 能力：手机操作';
    sandbox.window.ElainaTags = { strip: (t) => String(t || '') };
    vm.runInContext(extractVariable(session, 'AGENT_SESSION_EXEC_NS') + '\n'
        + extractFnFrom(session, 'agentSessionExecutionOps') + '\n'
        + extractVariable(session, 'AGENT_SESSION_RECENT_CHAT') + '\n'
        + extractVariable(session, 'AGENT_SESSION_ASK_LIMIT') + '\n'
        + extractFnFrom(session, 'agentSessionBriefing') + '\n'
        + 'window.__briefing = agentSessionBriefing;', sandbox, { filename: 'agentSessionBriefing.js' });
    const briefing = sandbox.__briefing('玩消消乐过到15关');
    c.ok(/任务目标（用户原话）/.test(briefing) && /玩消消乐过到15关/.test(briefing), '简报带任务目标');
    c.ok(/2026-11-10: 一起玩了消消乐/.test(briefing), '简报带相关记忆');
    c.ok(/用户: 帮我打消消乐/.test(briefing) && /AI: 好呀/.test(briefing), '简报带最近对话');
    c.ok(/主对话备注（角色派发任务时交代的背景）/.test(briefing) && /上次玩到第 12 关/.test(briefing),
        '简报带主对话交代的背景');
    c.ok(/\[操作:问主代理/.test(briefing) && /最多问 3 次/.test(briefing), '简报教求助通道与上限');
    c.ok(/不进行角色扮演/.test(briefing), '简报声明执行者边界');

    // 八、PC 并入会话：执行器入口启动会话 / 结果路由进会话 / 失败解释与熔断记账单源。
    const files = readWebFile('js/agent-files.js');
    const browser = readWebFile('js/agent-browser.js');
    const search = readWebFile('js/agent-search.js');
    const tools = readWebFile('js/agent-tools.js');
    c.ok((files.match(/if \(typeof agentSessionStart === 'function'\) agentSessionStart\(state\._agentGoal\);/g) || []).length === 2
        && /if \(typeof agentSessionStart === 'function'\) agentSessionStart\(state\._agentGoal\);/.test(browser)
        && /if \(typeof agentSessionStart === 'function'\) agentSessionStart\(state\._agentGoal\);/.test(search),
        '★ 四个 PC 执行器入口启动会话（与手机侧同款；标签 / 工具 / 会话三条通道都覆盖）');
    c.ok(/op\.ns === 'file' \|\| op\.ns === 'pc'/.test(session)
        && /void ElainaOps\.invoke\(toolName, toolArgs, \{ access: currentAgentAccess\(\) \}\);/.test(session),
        '★ 会话步把 file / pc 工具调用路由回 ElainaOps（观察由执行器进会话）');
    c.ok(/function agentSessionRouteResult\(/.test(session)
        && /agentSessionRouteResult\(/.test(files) && /agentSessionRouteResult\(/.test(browser)
        && /agentSessionRouteResult\(/.test(search),
        '★ 执行器结果出口统一收口：会话模式观察进会话（含紧凑摘要回主对话协议对）');
    c.ok(/!routed && ownTrace\) await explainAgentFailure/.test(files)
        && /!routed && ownTrace\) await explainAgentFailure/.test(browser)
        && /!routed && ownTrace\) await explainAgentFailure/.test(search),
        '失败解释只在一体模式让角色开口（会话模式重试由会话自己的循环承担）');
    c.ok(/agentSessionRecordFailure\(/.test(files) && /agentSessionRecordFailure\(/.test(access),
        '被拒 / 取消出口经 agentSessionRecordFailure（会话→观察 / 一体→主对话）');
    c.ok(/routedToSession/.test(tools) && /op\.ns === 'phone' \|\| op\.ns === 'file' \|\| op\.ns === 'pc'/.test(tools),
        '★ runToolCalls 熔断记账单源化（会话模式不双份计数）');
    c.ok(/function agentSessionContinuePrompt\(/.test(session) && /agentSessionContinuePrompt\(\)/.test(session),
        '会话续跑指令按会话工具收窄（界面坐标规则只在带手机操作时附加）');

    // 九、VM 行为（PC）：简报按可用操作组装 PC 手册，不带手机坐标规则。
    const pcSandbox = makeVmSandbox({});
    pcSandbox.window = pcSandbox;
    pcSandbox.ElainaOps = {
        availableOps: () => [
            { name: 'web_search', tool: 'web_search', ns: 'pc' },
            { name: 'file_ls', tool: 'list_files', ns: 'file' },
            { name: 'app_memory', tool: 'organize_memory', ns: 'app' },
        ],
        manualFor: (name) => (name === 'web_search' ? '# Agent 能力：联网搜索' : ''),
    };
    vm.runInContext(extractVariable(session, 'AGENT_SESSION_EXEC_NS') + '\n'
        + extractFnFrom(session, 'agentSessionExecutionOps') + '\n'
        + extractVariable(session, 'AGENT_SESSION_RECENT_CHAT') + '\n'
        + extractVariable(session, 'AGENT_SESSION_ASK_LIMIT') + '\n'
        + extractFnFrom(session, 'agentSessionBriefing') + '\n'
        + 'window.__pcBriefing = agentSessionBriefing;', pcSandbox, { filename: 'agentSessionBriefingPc.js' });
    const pcBriefing = pcSandbox.__pcBriefing('查一下今天的天气写进桌面备忘');
    c.ok(/# 操作子代理任务简报/.test(pcBriefing) && /# Agent 能力：联网搜索/.test(pcBriefing),
        'PC 简报带通用标题与可用操作的说明书（app 命名空间不进会话手册）');
    c.ok(/## PC 操作注意/.test(pcBriefing), 'PC 简报带 PC 专属注意事项');
    c.ok(!/手机查看界面/.test(pcBriefing), 'PC 简报不带手机坐标规则');
}

const only = process.argv[2];
const allCases = [
    { name: '三档 AI 权限', fn: caseAccess },
    { name: '自动续跑', fn: caseContinue },
    { name: '系统悬浮窗', fn: caseOverlay },
    { name: '文件位置与目录归类', fn: casePaths },
    { name: '手机操作标签', fn: casePhone },
    { name: 'strict 路由决策表', fn: caseStrictRoute },
    { name: '手机权限', fn: casePhonePerms },
    { name: 'API Key 存储', fn: caseByokSecrets },
    { name: '标签协议解耦', fn: caseTags },
    { name: '操作注册表', fn: caseOps },
    { name: 'Agent 纯解析函数（agent-parse.js）', fn: caseAgentParse },
    { name: '提示词层级', fn: casePromptTiers },
    { name: '手机操作真机问题', fn: casePhoneAgentFixes },
    { name: '后台运行方式', fn: caseBackgroundBackends },
    { name: '手机 Agent 闭环与收尾', fn: caseAgentLoopQuality },
    { name: '元素引用点击', fn: caseElementRef },
    { name: '截图链路降本', fn: caseScreenshotCost },
    { name: 'settle 稳定帧', fn: caseSettle },
    { name: '历史压缩', fn: caseHistoryCompaction },
    { name: '控件清单增强', fn: caseClipList },
    { name: '区域级观测', fn: caseRegionObservation },
    { name: '运行可观测性', fn: caseMetrics },
    { name: '无障碍优先批次', fn: caseA11yUpgrade },
    { name: '子代理会话', fn: caseAgentSession },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: 'AI Agent（权限 / 续跑 / 悬浮窗 / 路径 / 手机 / 路由 / 标签 / 操作注册表）',
    usage: 'node scripts/check-agent.mjs [用例名子串]',
    cases,
});

