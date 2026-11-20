// 子代理会话：主对话派出的操作执行者（手机 / 文件 / 浏览器 / 命令 / 搜索）。
// 分工：主对话（角色）负责记忆、派发简报、用角色口吻转述结果；子代理只带
// "任务简报 + 相关记忆 + 最近对话 + 操作手册 + 执行观察"这套最小上下文逐步执行。
// 角色对这段经历的记忆不丢：执行报告会作为隐藏观察写回主对话，autoMemory 会照常汇入长期记忆。
'use strict';

// 总开关：出问题时改这一行即可退回"聊天模型直接当操作大脑"的一体模式。
const AGENT_SESSION_ENABLED = true;
// 简报里带的最近对话条数：给执行者"上次玩到哪"这类背景，又不至于把角色上下文整个搬过来。
const AGENT_SESSION_RECENT_CHAT = 6;
// 每个任务允许向主对话求助的次数上限：防止"遇到难题就上交"变成新的打转形态。
const AGENT_SESSION_ASK_LIMIT = 3;
// 会话内观察历史压缩：只留最新一份完整观察，旧的降级成一行（与主对话历史压缩同判据）。

let agentSession = null;

// 会话承载的执行型操作命名空间：phone（手机）、file（文件）、pc（命令 / 浏览器 / 搜索）。
// app（整理记忆等角色动作）与 mcp 不进来 —— 那些不是"派出去做"的事，留在主对话。
const AGENT_SESSION_EXEC_NS = ['phone', 'file', 'pc'];

function agentSessionActive() {
    return Boolean(agentSession && agentSession.active === true);
}

/** 此刻会话能用的执行型操作（平台 / 权限 / 开关的收窄由各 op 的 available() 决定）。 */
function agentSessionExecutionOps() {
    if (typeof ElainaOps === 'undefined' || !ElainaOps.availableOps) return [];
    return ElainaOps.availableOps().filter((op) => AGENT_SESSION_EXEC_NS.includes(op.ns));
}

/**
 * 启动子代理会话。goal 为空 / 没有任何执行型操作可用 / 已在运行时返回 null（调用方退回一体模式）。
 */
function agentSessionStart(goal) {
    if (!AGENT_SESSION_ENABLED) return null;
    const trimmedGoal = String(goal || '').trim();
    if (!trimmedGoal) return null;
    // 连一步都迈不出去的会话（权限关闭 / 开关全关）只会空转，回退一体模式。
    if (!agentSessionExecutionOps().length) return null;
    if (agentSession && agentSession.active === true) return agentSession;
    agentSession = {
        active: true,
        goal: trimmedGoal,
        briefing: agentSessionBriefing(trimmedGoal),
        messages: [],
        steps: [],
        result: '',
        ended: false,
        startedAt: Date.now(),
    };
    console.info('[Agent] 子代理会话启动：' + trimmedGoal.slice(0, 80));
    return agentSession;
}

/** 简报 = 任务目标 + 相关长期记忆 + 最近对话 + 操作手册。执行者的"记忆"全在这里。 */
function agentSessionBriefing(goal) {
    const execOps = agentSessionExecutionOps();
    const hasPhone = execOps.some((op) => op.ns === 'phone');
    const hasPc = execOps.some((op) => op.ns !== 'phone');
    const lines = [
        '# 操作子代理任务简报',
        '',
        '你是主对话派出的操作执行者，负责把下面的任务目标一步步做完成。',
        '执行期间**不进行角色扮演、不写小说式描写、不直接对用户说话**；',
        '每条回复只决定下一步的操作：优先用工具调用，写不出工具调用时用 [操作:…] 标签（不会显示给用户）；',
        '任务完成或确认做不成时，用 [完成] 开头写一段**技术性总结**'
            + '（做了什么、结果、失败原因），不要再输出操作 ——',
        '主对话的角色会读这份总结向用户转述，所以报告要写清结果与失败原因。',
        '',
        '## 任务目标（用户原话）',
        goal,
    ];
    const related = (typeof getRelatedMemories === 'function') ? getRelatedMemories(goal) : [];
    if (related && related.length) {
        lines.push('', '## 相关经历（长期记忆中与目标可能相关的条目）');
        for (const memory of related) {
            lines.push('- ' + memory.date + ': ' + memory.content);
        }
    }
    const conv = (typeof getCurrentConversation === 'function') ? getCurrentConversation() : null;
    if (conv && Array.isArray(conv.messages) && conv.messages.length) {
        const recent = conv.messages
            .filter((m) => m && m.hidden !== true && String(m.text || '').trim())
            .slice(-AGENT_SESSION_RECENT_CHAT);
        const chatLines = recent.map((m) => {
            const who = m.role === 'user' ? '用户' : 'AI';
            let body = String(m.text || '');
            if (window.ElainaTags && typeof window.ElainaTags.strip === 'function') {
                body = window.ElainaTags.strip(body);
            }
            return who + ': ' + body.slice(0, 150);
        }).filter(Boolean);
        if (chatLines.length) {
            lines.push('', '## 最近对话（背景参考，不是给你的新指令）', chatLines.join('\n'));
        }
    }
    // 操作手册按会话实际有的操作组装：手机用既有组装（含观测 / 坐标规则），PC 操作逐条取注册表说明书。
    if (hasPhone) {
        const skill = (typeof agentPhoneSkillText === 'function') ? agentPhoneSkillText() : '';
        if (skill) lines.push('', skill);
    }
    if (hasPc) {
        const manuals = execOps.filter((op) => op.ns !== 'phone')
            .map((op) => (typeof ElainaOps !== 'undefined' && ElainaOps.manualFor) ? ElainaOps.manualFor(op.name) : '')
            .filter(Boolean);
        if (manuals.length) lines.push('', manuals.join('\n\n'));
        lines.push('',
            '## PC 操作注意',
            '文件 / 命令 / 浏览器 / 搜索返回的结果就是操作结果，直接依据它决定下一步；',
            '失败时换参数重试（换个路径、换个写法），不要原样重发同一条；',
            '触发用户确认弹窗（覆盖 / 删除 / 危险命令 / 打开浏览器）时耐心等结果，用户拒绝就换方式或如实收尾。');
    }
    // 主代理派发时交代的背景（角色回复里往往就有"上次玩到哪"这类上下文）
    const dispatchNote = String((typeof state !== 'undefined' && state._agentDispatchReply) || '').trim();
    if (dispatchNote) {
        lines.push('', '## 主对话备注（角色派发任务时交代的背景）', dispatchNote.slice(0, 400));
        state._agentDispatchReply = '';
    }
    // 求助通道：判断类问题问主对话（它带完整记忆与偏好）；只有用户本人能给的事直接收尾
    lines.push('',
        '## 求助与边界',
        '拿不准、需要用户偏好 / 历史记忆 / 主观判断时，用 [操作:问主代理 你的问题] 向主对话求助，'
            + '答复会直接回到你的上下文，每个任务最多问 ' + AGENT_SESSION_ASK_LIMIT + ' 次，能自己判断的不要问；',
        '涉及密码 / 支付确认这类**只有用户本人能提供**的信息，不要问主对话（它也不知道），'
            + '直接用 [完成] 说明卡在哪里，由角色转告用户。');
    return lines.join('\n');
}

/** 给主对话（角色）看的会话状态：steering 与中途聊天都用它。 */
function agentSessionStatus() {
    const s = agentSession;
    if (!s) return '';
    const last = s.steps.length ? '，最近一步：' + s.steps[s.steps.length - 1].summary : '';
    return '目标「' + s.goal.slice(0, 60) + '」，已执行 ' + s.steps.length + ' 步' + last;
}

/**
 * 子代理 → 主对话的求助：主模型带完整记忆 / 偏好回答，
 * 答复作为观察注入会话上下文，子代理按答复继续执行。
 */
async function agentSessionAskMain(question) {
    const s = agentSession;
    if (!s || s.ended) {
        insertAgentResult('当前没有运行中的子代理，这条询问没有对象。', { continueLoop: false, asContext: true });
        return;
    }
    const rt = window.agentRuntime;
    if (rt && typeof rt.isHalted === 'function' && rt.isHalted()) return;
    const q = String(question || '').replace(/^问主代理[:：]?\s*/, '').trim();
    if (!q) {
        // 空问题没有可回答的内容，但必须留下观察并调度下一步：静默 return 会让会话停在 running 状态。
        agentSessionAddObservation('ask_main 缺少 question 参数，这一步没有执行。',
            { progress: false, step: s.steps.length + 1, summary: '缺少 question 参数' });
        return;
    }
    if (s.asks >= AGENT_SESSION_ASK_LIMIT) {
        agentSessionAddObservation(
            '【主对话答复】已达询问上限（' + AGENT_SESSION_ASK_LIMIT + ' 次），请自行判断并继续任务。',
            { progress: false, step: s.steps.length + 1, summary: '询问次数已达上限' });
        return;
    }
    s.asks = (s.asks || 0) + 1;
    if (typeof agentRunNoteStep === 'function') agentRunNoteStep('询问主对话：' + q.slice(0, 60));
    agentRunMetrics.modelCalls += 1;
    const prompt = '（系统内部通知：你派出的操作子代理在执行任务时遇到拿不准的事，向你求助。\n'
        + '任务目标：' + s.goal + '\n'
        + '已执行：' + (s.steps.map((st) => st.summary).join(' → ') || '（还没有）') + '\n'
        + '子代理的问题：' + q + '\n'
        + '请直接给子代理一个明确、可执行的答复：先给结论（选哪个 / 做不做 / 是什么），再给一句依据；'
        + '需要它执行动作就写出明确指令（例如：选第一个选项 / 返回上一页 / 不要支付）。'
        + '这份答复会直接喂给子代理继续执行，不要对用户说话，不要输出 [操作:…] 标签，'
        + '不要提及"子代理""系统通知"这类词。）';
    let answer = '';
    try {
        // 与续跑通道同一套死线 / 停止赛跑：求助等待不能成为用户按停止后仍挂住整条会话的缺口。
        const askOptions = {
            maxTokens: AGENT_CONTINUE_OUTPUT_TOKEN_LIMIT,
            deadlineMs: AGENT_CONTINUE_CALL_DEADLINE_MS,
            signal: AbortSignal.timeout(AGENT_CONTINUE_CALL_DEADLINE_MS),
        };
        answer = await raceAgentStop(
            raceAgentDeadline(callAI(prompt, askOptions), AGENT_CONTINUE_CALL_DEADLINE_MS), rt);
        if (answer === AGENT_STOPPED) answer = '';
    } catch (err) {
        answer = '';
    }
    if (rt && typeof rt.isHalted === 'function' && rt.isHalted()) return;
    const text = (window.ElainaTags && typeof window.ElainaTags.strip === 'function')
        ? window.ElainaTags.strip(answer || '') : String(answer || '');
    agentSessionAddObservation(
        '【你之前问主对话】' + q + '\n【主对话答复】' + (text || '（主对话没有给出答复，请自行判断并继续。）'),
        { progress: true, step: s.steps.length + 1, summary: '主对话答复：' + q.slice(0, 50) });
}

/**
 * 观察入会话：旧观察降级成一行，只留最新一份完整观察；
 * 熔断计数与主对话同一份（agentStalledSteps），progress 语义与 insertAgentResult 一致。
 */
function agentSessionAddObservation(text, meta = {}) {
    const s = agentSession;
    if (!s) return;
    for (const m of s.messages) {
        if (m.observation && m.current) {
            m.current = false;
            m.content = '【第 ' + (m.step || '?') + ' 步｜历史】' + (m.summary || '（旧观察，坐标已过期）');
        }
    }
    const step = Number(meta.step) || (s.steps.length + 1);
    const summary = String(meta.summary || ('第 ' + step + ' 步')).slice(0, 120);
    s.steps.push({
        step,
        summary,
        changed: meta.changed == null ? null : meta.changed,
    });
    s.messages.push({
        role: 'user',
        content: '【操作结果｜第 ' + step + ' 步】\n' + String(text || ''),
        observation: true,
        current: true,
        step,
        summary,
    });
    if (meta.progress === false) agentStalledSteps += 1;
    else if (meta.progress === null) {
        // 界面持续变化 / 读不到界面：不动熔断计数（与 insertAgentResult 同判据）
    } else {
        agentStalledSteps = 0;
        if (typeof agentRunNoteSuccess === 'function') agentRunNoteSuccess();
    }
    scheduleAgentContinue();
}

/** 被拒 / 失败类结果的路由：会话模式写进会话，一体模式写进主对话。 */
function agentSessionRecordFailure(text, meta = {}) {
    if (agentSessionActive()) {
        agentSessionAddObservation(text, meta);
        return;
    }
    insertAgentResult(text, meta);
}

/**
 * 执行器结果出口的统一收口：会话模式把观察写进会话并调度续跑，返回 true 表示已路由；
 * 返回 false 时调用方走一体模式的老路（insertAgentResult / explainAgentFailure）。
 * progress 默认按"有进展"算；失败 / 被拒 / 取消必须显式传 progress:false（熔断语义与一体模式一致）。
 */
function agentSessionRouteResult(text, meta = {}) {
    if (!agentSessionActive()) return false;
    const rt = window.agentRuntime;
    const step = Number(meta.step)
        || (rt && typeof rt.getStep === 'function' ? rt.getStep() : 0)
        || (agentSession ? agentSession.steps.length + 1 : 1);
    agentSessionAddObservation(String(text || ''), {
        progress: meta.progress !== false,
        step,
        summary: String(meta.summary || ('第 ' + step + ' 步执行结果')).slice(0, 120),
    });
    return true;
}

/**
 * 会话续跑指令：与主循环 AGENT_CONTINUE_PROMPT 同一套规则，但按会话工具收窄 ——
 * 界面坐标规则只在带手机操作时成立；PC 操作没有界面坐标，失败时换参数而不是换坐标。
 */
function agentSessionContinuePrompt() {
    const hasPhone = agentSessionExecutionOps().some((op) => op.ns === 'phone');
    const lines = [
        '（系统内部通知：你刚才发起的那一步已经执行完，结果已回灌给你。请先读懂这个结果，再决定下一步。）',
        '规则：',
        '1. 执行期间**不要写任何旁白、解释或安抚** —— 用户在任务结束前看不到这些中间话；'
            + '一条回复只决定下一步的操作（优先工具调用，写不出时用 [操作:…] 标签）。',
        '2. 还需要继续操作，就发起下一步（工具调用或 [操作:…] 标签，都不会显示给用户）；',
        '3. 任务完成或确定做不成时，用 [完成] 开头写**一段**技术性总结，不要再输出任何操作。'
            + '这段总结是用户唯一会看到的正文，要独立成段、说清做了什么和结果；'
            + '不要分条、不要写小说式的括号动作（如（摇了摇头）（叹了口气）），情绪用自然语气词表达。',
        '4. 如果结果里显示某一步失败了、没被允许、或不被支持，不要重复同一步，换个方式或如实说明；'
            + '⚠️ 同一批里有多个结果时，**只要有一条成功**就说明那件事做成了 —— '
            + '不要因为最后一条失败就无视前面的成功。典型情形：第一条命令已把文件删掉，'
            + '第二条再删同一个文件必然报"找不到路径"，那恰恰证明删除成功了，不是失败。',
        '5. ⚠️ 查说明书、列目录这类**没有产生用户要的东西**的一步不算任务完成。'
            + '收尾前先确认：用户要的那件事（例如某个文件真的写进去了）是否已经**真的**做成；'
            + '没做成就继续做，或如实说还没做成。',
        '6. 不要提及"系统通知""标签"这类词；但**也不要为了说得自然就编造结果** —— '
            + '没执行就说没执行，执行失败就说失败。',
    ];
    if (hasPhone) {
        lines.push(
            '7. 结果里说「界面没有变化」时，不要原样重试同一坐标；先重新读界面、换一个目标，或用返回键退一步。',
            '8. 只有标着「当前界面」的那条结果里的 #编号 / 坐标有效；标「历史」的是旧界面，'
                + '不要拿旧坐标点击；需要坐标时先 [操作:手机查看界面]。');
    } else {
        lines.push(
            '7. 结果里显示失败时不要原样重试同一条命令 / 同一个路径；换参数、换写法，'
                + '或先列目录 / 重新查看现状再动手。');
    }
    return lines.join('\n');
}

/** 会话上下文 → 模型消息：简报(system) + 历史（连续 user 观察合并）+ 续跑指令(+截图)。 */
function agentSessionBuildMessages(options = {}) {
    const s = agentSession;
    const messages = [{ role: 'system', content: s.briefing }];
    for (const m of s.messages) {
        let content = m.content;
        if (m.role === 'assistant' && typeof stripThinkTags === 'function') {
            content = stripThinkTags(content) || ' ';
        }
        // 工具调用记成正文而不是结构化 tool_calls：会话的操作结果走观察消息，没有与之配对的
        // tool 角色消息，单独下发 assistant.tool_calls 会被严格网关整包拒收；写成文本既保留
        // 「上一步调了什么」的上下文，又不引入协议配对要求。
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
            const calls = m.toolCalls.map((c) => {
                let args = '';
                try { args = JSON.stringify(c.args || {}); } catch (e) { args = '{}'; }
                if (args.length > 200) args = args.slice(0, 200) + '…';
                return String(c.name || 'tool') + '(' + args + ')';
            }).join('；');
            content = (String(content || '').trim() ? content + '\n' : '')
                + '（本轮工具调用：' + calls + '）';
        }
        const prev = messages[messages.length - 1];
        // 连续同角色消息合并：部分严格网关（Anthropic 系）拒收非交替序列
        if (prev && prev.role === m.role) {
            prev.content = prev.content + '\n\n' + content;
        } else {
            messages.push({ role: m.role, content });
        }
    }
    const continuePrompt = agentSessionContinuePrompt();
    const turn = { role: 'user', content: continuePrompt };
    if (options.imageDataUrl) {
        turn.content = [
            { type: 'text', text: '（最新截图附在本条消息，请结合画面决定下一步。）\n' + continuePrompt },
            { type: 'image_url', image_url: { url: options.imageDataUrl } },
        ];
    }
    messages.push(turn);
    return messages;
}

/** 执行报告：主对话写回 + 角色转述都用它。 */
function agentSessionReport(s, reason) {
    const steps = s.steps.slice(-8).map((st) =>
        '第 ' + st.step + ' 步：' + st.summary + (st.changed === false ? '（界面没变化）' : ''));
    return '【子代理执行报告】\n'
        + '目标：' + s.goal + '\n'
        + '结果：' + (reason === 'completed' ? (s.result || '已完成') : '未完成（' + reason + '）') + '\n'
        + (steps.length ? '步骤：\n· ' + steps.join('\n· ') : '（没有已执行的步骤）');
}

/** 报告写回主对话（隐藏观察，autoMemory 与角色"读报告"共用这一份）并清理会话。 */
function agentSessionTeardown(reason) {
    const s = agentSession;
    if (!s) return '';
    agentSession = null;
    const report = agentSessionReport(s, reason);
    try {
        insertAgentResult(report, {
            asContext: true,
            observation: true,
            currentScreen: false,
            step: s.steps.length,
            summary: '子代理报告（' + reason + '）：' + s.goal.slice(0, 60),
        });
    } catch (err) {
        // 报告写不进对话不影响收尾
    }
    return report;
}

/**
 * 会话收尾。completed → 主模型按角色口吻转述（失败回退中性总结）；
 * stopped/fused/error → 确定性总结（与一体模式同文案）。
 */
async function agentSessionFinish(reason, errorObj) {
    const s = agentSession;
    if (!s || s.ended) {
        agentFinishRun(reason, true);
        return;
    }
    s.ended = true;
    const report = agentSessionTeardown(reason);
    if (reason === 'completed') {
        try {
            const relayPrompt = '（系统内部通知：你派出的操作子代理已经执行完毕，执行报告如下——\n'
                + report + '\n请以你的角色身份，用一段话向用户转述这次任务的结果：'
                + '先读报告再说话，结果是什么就是什么，失败也要如实说；'
                + '保持你的语气习惯（语气词，不要括号动作描写）；'
                + '不要提及"子代理""系统通知""报告"这类词；'
                + '只做转述收尾，不要再输出任何 [操作:…] 标签。）';
            const relayOptions = {
                maxTokens: AGENT_CONTINUE_OUTPUT_TOKEN_LIMIT,
                deadlineMs: AGENT_CONTINUE_CALL_DEADLINE_MS,
                signal: AbortSignal.timeout(AGENT_CONTINUE_CALL_DEADLINE_MS),
            };
            const relayText = await raceAgentStop(
                raceAgentDeadline(callAI(relayPrompt, relayOptions), AGENT_CONTINUE_CALL_DEADLINE_MS),
                window.agentRuntime);
            // 用户已停止：requestStop 已经收尾并写了停止总结，这里不能再补一条完成转述。
            if (relayText === AGENT_STOPPED) return;
            const visible = (window.ElainaTags && typeof window.ElainaTags.strip === 'function')
                ? window.ElainaTags.strip(relayText || '') : String(relayText || '');
            if (visible) {
                appendAgentVisibleMessage(visible);
                agentFinishRun(reason, true);
                return;
            }
        } catch (err) {
            console.warn('[Agent] 子代理报告转述失败，回退中性总结:', err);
        }
        appendAgentVisibleMessage(agentRunSummaryText('completed'));
        agentFinishRun(reason, true);
        return;
    }
    appendAgentVisibleMessage(agentRunSummaryText(reason));
    agentFinishRun(reason, true);
}

/**
 * 会话工具清单：全部执行型操作（AGENT_SESSION_EXEC_NS，经 availableOps 按平台 / 权限收窄）
 * + ask_main。单一来源仍是 agent.js 的注册表（不另抄一份参数表）。
 * ask_main 是会话专属工具（主对话的工具清单里没有它，避免角色自己跟自己对话）。
 */
function agentSessionTools() {
    const tools = agentSessionExecutionOps().map((op) => ({
        type: 'function',
        function: { name: op.tool, description: op.desc, parameters: op.schema },
    }));
    tools.push({
        type: 'function',
        function: {
            name: 'ask_main',
            description: '拿不准、需要用户偏好 / 历史记忆 / 主观判断时，向主对话求助。'
                + '答复会直接回到你的上下文。每个任务最多 ' + AGENT_SESSION_ASK_LIMIT + ' 次，能自己判断的不要问。',
            parameters: {
                type: 'object',
                properties: { question: { type: 'string', description: '你要问的具体问题' } },
                required: ['question'],
            },
        },
    });
    return tools;
}

/**
 * 会话单步：与一体模式同一个 ReAct 循环（熔断 / 死线 / 停止赛跑 / 观察回灌），
 * 差别只在模型上下文 —— 简报 + 会话历史，不带角色与聊天历史。
 */
async function agentSessionStep(rt, staleRun) {
    if (agentStalledSteps >= AGENT_STALL_FUSE) {
        agentContinueUsed += 1;
        insertAgentResult('（连续 ' + agentStalledSteps + ' 步都没能真正推进任何一步，先停下来。）',
            { continueLoop: false, asContext: true });
        await agentSessionFinish('fused');
        return;
    }
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
    agentContinueUsed += 1;
    if (!rt.isRunning()) rt.beginRun();
    rt.setStep(rt.getStep() + 1, '正在思考下一步');
    agentContinueBusy = true;
    const stepStartedAt = Date.now();
    let raw;
    let continueError = null;
    const options = {
        replyInfo: {},
        maxTokens: AGENT_CONTINUE_OUTPUT_TOKEN_LIMIT,
        deadlineMs: AGENT_CONTINUE_CALL_DEADLINE_MS,
    };
    const pendingImage = (typeof takePendingAgentImage === 'function') ? takePendingAgentImage() : '';
    if (pendingImage) {
        options.imageDataUrl = pendingImage;
        options.directImage = true;
    }
    // 工具调用：始终传 tools —— 结构化参数由供应商 API 保证，不依赖模型正确拼写文本标签
    options.tools = agentSessionTools();
    try {
        options.signal = AbortSignal.timeout(AGENT_CONTINUE_CALL_DEADLINE_MS);
        agentRunMetrics.modelCalls += 1;
        raw = await raceAgentStop(
            raceAgentDeadline(callAgentSessionAI(agentSessionBuildMessages(options), options),
                AGENT_CONTINUE_CALL_DEADLINE_MS), rt);
        if (raw === AGENT_STOPPED) raw = '';
    } catch (e) {
        const isEmptyOutput = e instanceof ClientApiError && e.code === 'EMPTY_MODEL_OUTPUT';
        const errKind = isEmptyOutput ? 'EMPTY_MODEL_OUTPUT'
            : (e instanceof ClientApiError ? (e.code || '未知') : (e && e.name) || '未知');
        console.warn('[Agent] 子代理续跑请求失败（' + errKind + '），1 次重试…', e);
        await sleepMs(800);
        if (typeof rt.isHalted === 'function' && rt.isHalted()) return;
        if (staleRun()) return;
        try {
            options.signal = AbortSignal.timeout(AGENT_CONTINUE_CALL_DEADLINE_MS);
            agentRunMetrics.modelCalls += 1;
            raw = await raceAgentStop(
                raceAgentDeadline(callAgentSessionAI(agentSessionBuildMessages(options), options),
                    AGENT_CONTINUE_CALL_DEADLINE_MS), rt);
            if (raw === AGENT_STOPPED) raw = '';
        } catch (e2) {
            continueError = e2;
            raw = '';
        }
    } finally {
        agentContinueBusy = false;
        console.log('[Agent] 子代理第 ' + agentContinueUsed + ' 步决策耗时 '
            + ((Date.now() - stepStartedAt) / 1000).toFixed(1) + 's');
        agentRunMetrics.modelMs += Math.max(0, Date.now() - stepStartedAt);
    }
    if (staleRun()) return;
    if (typeof rt.isHalted === 'function' && rt.isHalted()) return;
    if (continueError) {
        const reason = String((continueError && continueError.message) || continueError || '未知原因');
        insertAgentResult(
            '子代理续跑失败：这一步没能继续（' + reason.slice(0, 300) + '）。\n'
            + '⚠️ 任务**没有**完成，处理完这个问题后跟我说一声「继续」，我接着往下走。',
            { continueLoop: false, asContext: true });
        await agentSessionFinish('error', continueError);
        return;
    }
    const rawText = String(raw || '');
    const text = (window.ElainaTags && typeof window.ElainaTags.strip === 'function')
        ? window.ElainaTags.strip(rawText) : rawText;
    // 工具调用通道优先：供应商支持 function calling 时，模型直接调用结构化工具
    const repliedToolCalls = (options.replyInfo && Array.isArray(options.replyInfo.toolCalls))
        ? options.replyInfo.toolCalls : [];
    // 正文为空的工具调用回合也要留下 assistant 记录：否则历史里只剩观察消息，
    // 下一轮看不到自己调用过什么（结构化 tool_calls 为何改写进正文，见 agentSessionBuildMessages）。
    if (text || repliedToolCalls.length) {
        agentSession.messages.push({
            role: 'assistant',
            content: rawText || ' ',
            toolCalls: repliedToolCalls,
        });
    }
    if (repliedToolCalls.length) {
        state._agentNarrationStreak = 0;
        if (text && typeof agentRunNoteNarration === 'function') agentRunNoteNarration(text);
        let routed = false;
        for (const call of repliedToolCalls) {
            if (call.badArgs) {
                agentSessionAddObservation('工具调用参数不是合法 JSON，这一步没有执行。请重新调用。',
                    { progress: false, step: rt.getStep(), summary: '工具参数错误' });
                continue;
            }
            const toolName = String(call.name || '');
            const toolArgs = call.args || {};
            if (toolName === 'ask_main') {
                const q = String(toolArgs.question || '').trim();
                // 空 question 也交给会话函数：它会把「缺参数」写成观察并调度下一步，静默跳过会让会话卡在 running。
                void agentSessionAskMain(q);
                routed = true;
                continue;
            }
            const op = (typeof ElainaOps !== 'undefined' && ElainaOps.resolve) ? ElainaOps.resolve(toolName) : null;
            if (op && op.ns === 'phone') {
                const rawArg = String(toolArgs.raw || '');
                if (rawArg) {
                    void enqueuePhoneOperation(rawArg);
                    routed = true;
                } else {
                    agentSessionAddObservation('phone_action 缺少 raw 参数，这一步没有执行。',
                        { progress: false, step: rt.getStep(), summary: '缺少 raw 参数' });
                }
                continue;
            }
            if (op && (op.ns === 'file' || op.ns === 'pc')) {
                // PC 操作同样由执行器自己路由观察（会话中观察进会话并调度续跑），这里只负责发起
                void ElainaOps.invoke(toolName, toolArgs, { access: currentAgentAccess() });
                routed = true;
                continue;
            }
            agentSessionAddObservation('没有这项工具能力：' + toolName + '。',
                { progress: false, step: rt.getStep(), summary: '未知工具：' + toolName });
        }
        // routed = 观察由手机动作 / 求助答复入会话并调度下一步；错误观察也已入会话（内含调度）
        return;
    }
    const hasCompletion = /\[完成(?::[^\]]*)?\]/.test(rawText);
    const keepsRunning = (typeof agentTagKeepsRunning === 'function')
        ? agentTagKeepsRunning(rawText)
        : /\[操作[:：]/.test(rawText);
    if (keepsRunning && window.ElainaTags) {
        state._agentNarrationStreak = 0;   // 子代理真的动手了
        if (text && typeof agentRunNoteNarration === 'function') agentRunNoteNarration(text);
        window.ElainaTags.drive(rawText);
        return;   // 观察由手机动作入会话，下一轮接力
    }
    // 纯表现标签照常执行（不改变"这段正文是收尾"的判断）
    if (/\[操作[:：]/.test(rawText) && window.ElainaTags) window.ElainaTags.drive(rawText);
    const looksLikePromise = /(好的|嗯|我这就|我马上|稍等|正在|我先|接下来|继续|看看|试一下)/.test(text)
        && text.length < 80;
    if (hasCompletion || (Boolean(text) && agentRunSawSuccess && text.length >= 30 && !looksLikePromise)) {
        agentSession.result = text;
        await agentSessionFinish('completed');
        return;
    }
    if (agentContinueUsed >= 1) {
        const streak = (state._agentNarrationStreak || 0) + 1;
        state._agentNarrationStreak = streak;
        if (streak <= AGENT_NARRATION_NUDGE_LIMIT) {
            agentSession.messages.push({
                role: 'user',
                content: '（系统内部通知：你上一条回复没有输出任何 [操作:…] 标签，也没有写明任务完成 —— '
                    + '只说不做的话，任务就停在这里了。任务还没做完就**现在**输出下一步的操作标签；'
                    + '全部做完就用 [完成] 开头写一段技术性总结。）',
            });
            scheduleAgentContinue();
            return;
        }
    }
    await agentSessionFinish(agentRunSteps.length ? 'fused' : 'completed');
}
