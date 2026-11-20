// Agent 自动续跑：续跑预算 / 熔断 / scheduleAgentContinue / continueAgentLoop；依赖 agent-tools 的 runToolCalls 与 agent-phone 的浮层忙碌判定（运行时才调用）。
'use strict';

const AGENT_STALL_FUSE = 3;
// 续跑中途的纯叙述回复（没标签、没工具调用、也没宣布完成）允许连续催办的次数：实测 kimi-k3 每跑一两步就来一次纯叙述，
// 只催一次会反复停在半路；连续超过这个数还没动作，按熔断语义收尾（用户可「继续」再拉起）。发过标签或工具调用就清零。
const AGENT_NARRATION_NUDGE_LIMIT = 3;
// 续跑通道的输出预算必须远大于闲聊上限：推理型模型（网关默认开思考的 Qwen 系等）会先在 reasoning_content 里写完思考才给正文，闲聊那 900/1400 的上限常常在正文开始前就被思考耗尽 —— 表现为「模型只返回了思考内容」，agent 每走一步都被判空输出而暂停。4096 与思考链路的下限（core-config.js 的 ANTHROPIC_MIN_MAX_TOKENS）同一量级；上限只是封顶，不会让回复变长。
const AGENT_CONTINUE_OUTPUT_TOKEN_LIMIT = 4096;
// 单次续跑请求的硬上限：闲聊的空闲超时会被 reasoning 流式的增量不断重置，实测在慢网关上一次调用能挂八分钟以上，
// 浮层停在「正在思考」没有任何出路。这里用不可重置的死线兜底 —— 超时如实报错走重试 / 暂停，而不是让整条管线无限等。
// 三分钟对「思考型模型 + 一次界面描述」是安全余量；真挂死的请求按失败处理，重试一次再放弃。
const AGENT_CONTINUE_CALL_DEADLINE_MS = 180000;

/** 用定时器给一个 promise 上死线：闹钟到点就按超时失败。
 * 为什么不用 AbortSignal：APK 的原生 HTTP 通道上它打不断已经挂住的请求（实测挂八分钟）；
 * 而且挂点可能在 callAI 内部的前置等待里（那一步压根拿不到 signal），所以死线必须包在**整次调用**外面。 */
function raceAgentDeadline(promise, ms) {
    let timer = null;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error('这一步超过 ' + Math.round(ms / 60000) + ' 分钟没有任何结果，已停止等待。');
            err.code = 'REQUEST_TIMEOUT_HARD';
            reject(err);
        }, ms);
    });
    return Promise.race([promise, guard]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/** 让一次模型调用与「用户按停止」赛跑：停止先到就立刻返回这个哨兵对象，
 *  不必等原生 HTTP 通道把请求自己跑完（那个通道上 AbortSignal 打不断）。
 *  用对象而不是字符串当哨兵：模型完全可能回一句 "stopped"，字符串会撞车。 */
const AGENT_STOPPED = { stopped: true };
function raceAgentStop(promise, rt) {
    if (!rt || typeof rt.waitStopped !== 'function') return promise;
    const stop = rt.waitStopped();
    if (stop.isStopped()) {
        try { stop.cancel(); } catch (e) { /* 忽略 */ }
        return Promise.resolve(AGENT_STOPPED);
    }
    return Promise.race([promise, stop.promise]).finally(() => {
        try { stop.cancel(); } catch (e) { /* 忽略 */ }
    });
}
// 运行观测
// 一次任务运行（用户一句话派活 → 收尾）内的度量与步骤流水：只进日志与 window.__agentMetrics，
// 不进聊天 —— 过程区是给人看的呈现，这里是排查用的数字。agent-session.js / agent-phone.js / agent-result.js 按约定直接读写。
const agentRunMetrics = {
    startedAt: 0, modelCalls: 0, modelMs: 0,
    actions: 0, deviceMs: 0, changed: 0, noChange: 0, modes: {},
};
// 跨运行的生命周期统计：完成率按它算（本次运行完成 / 至今总运行数）。
const agentLifetimeStats = { runs: 0, completed: 0 };
let agentRunSawSuccess = false;
const agentRunSteps = [];
let agentRunNarration = '';

/** 开新的度量窗口：新一轮用户请求（或收尾兜底转述）时调。 */
function agentRunActivate() {
    agentRunMetrics.startedAt = Date.now();
    agentRunMetrics.modelCalls = 0;
    agentRunMetrics.modelMs = 0;
    agentRunMetrics.actions = 0;
    agentRunMetrics.deviceMs = 0;
    agentRunMetrics.changed = 0;
    agentRunMetrics.noChange = 0;
    agentRunMetrics.modes = {};
    agentRunSawSuccess = false;
    agentRunSteps.length = 0;
    agentRunNarration = '';
}

/** 记一次设备动作：耗时 / 观测方式（controls / region / none）/ 界面是否真的变了。 */
function agentRunNoteMetric(item) {
    const m = item || {};
    if (!agentRunMetrics.startedAt) agentRunMetrics.startedAt = Date.now();
    agentRunMetrics.actions += 1;
    agentRunMetrics.deviceMs += Math.max(0, Number(m.deviceMs) || 0);
    if (m.changed === true) agentRunMetrics.changed += 1;
    else if (m.changed === false) agentRunMetrics.noChange += 1;
    const mode = String(m.mode || 'none');
    agentRunMetrics.modes[mode] = (agentRunMetrics.modes[mode] || 0) + 1;
}

/** 记一步已执行的摘要（收尾总结与「不要重复做同一步」都从这里取）。 */
function agentRunNoteStep(summary) {
    agentRunSteps.push({ at: Date.now(), summary: String(summary || '') });
}

/** 记「这一步真的做成了」：收尾判据用它区分“做完收尾”与“嘴上答应”。 */
function agentRunNoteSuccess() {
    agentRunSawSuccess = true;
}

/** 记中途叙述的正文：压制的中间话留最后一条，收尾兜底转述时用。 */
function agentRunNoteNarration(text) {
    agentRunNarration = String(text || '').trim();
}

/** 收尾总结的确定性文案：模型没写（或写了但被剥空）时用它，对话里不能什么都不出现。 */
function agentRunSummaryText(reason) {
    const head = reason === 'completed' ? '这一轮任务做完了。'
        : reason === 'fused' ? '连续几步都没能真正做成任何一步，这轮先停在这里。'
            : reason === 'stopped' ? '已停止：你中止了操作，剩余步骤没有执行。'
                : '执行出了问题，这轮任务先停在这里。';
    const steps = agentRunSteps.slice(-5).map((s) => s.summary).join(' → ');
    return head + (steps ? '\n已执行：' + steps + '。' : '');
}

/** 运行收尾时的度量快照：写日志与 window.__agentMetrics，不进聊天。 */
function agentMetricsSnapshot(reason) {
    const startedAt = agentRunMetrics.startedAt || Date.now();
    const actions = agentRunMetrics.actions;
    const modelCalls = agentRunMetrics.modelCalls;
    const deviceMs = agentRunMetrics.deviceMs;
    agentLifetimeStats.runs += 1;
    if (reason === 'completed') agentLifetimeStats.completed += 1;
    const round2 = (v) => Math.round(v * 100) / 100;
    const snapshot = {
        reason,
        durationMs: Math.max(0, Date.now() - startedAt),
        modelCalls,
        modelPerAction: actions > 0 ? round2(modelCalls / actions) : 0,
        actions,
        deviceMs,
        avgDeviceMs: actions > 0 ? Math.round(deviceMs / actions) : 0,
        changed: agentRunMetrics.changed,
        noChange: agentRunMetrics.noChange,
        noChangeRatio: actions > 0 ? round2(agentRunMetrics.noChange / actions) : 0,
        completionRate: agentLifetimeStats.runs > 0
            ? round2(agentLifetimeStats.completed / agentLifetimeStats.runs) : 0,
        modes: Object.assign({}, agentRunMetrics.modes),
    };
    window.__agentMetrics = snapshot;
    console.log('[Agent] 运行汇总', snapshot);
    return snapshot;
}

let agentStalledSteps = 0;

/**
 * 判断回复里有没有「会产生下一步要接的结果」的操作标签。
 * 纯表现标签不在此列：开关视频通话、整理记忆只驱动界面与记忆卡，没有结果要回灌，
 * 拿它们续跑只会空转；[完成] 是收尾标记更不算。首回合催办与正文压制都用这一份判据。
 */
function agentTagKeepsRunning(rawText) {
    const text = String(rawText || '');
    const tagRe = /\[操作[:：]([^\]]*)\]/g;
    let m;
    while ((m = tagRe.exec(text))) {
        const name = String(m[1] || '').trim();
        if (!name) continue;
        if (/^(打开视频通话?|关闭视频通话?|挂断视频通话?|开始视频通话?|结束视频通话?|进入视频通话?)/i.test(name)) continue;
        if (/^(整理记忆|记忆整理)/.test(name)) continue;
        return true;
    }
    return false;
}

/**
 * 用户明确让「动手操作手机」，模型却只回了一段叙述（没有 [操作:…] 标签、也没有工具调用）时，催一次。
 *
 * <p>为什么需要：第一回合就只说不做，整条链根本没启动 —— 用户看到一句"我这就去看看"，然后什么都没发生
 * （实测 qwen3.8-flash 在完整角色提示词下就会这样）。这里不改提示词结构，只在系统侧补一句内部通知。
 *
 * <p>返回 true 表示已插催办并调度了续跑。
 */
function maybeNudgeSilentAgentTurn(userText, rawReply) {
    try {
        if (typeof deviceBridge !== 'function' || !deviceBridge()) {
            console.log('[Agent] 首回合催办跳过：没有原生设备层');
            return false;
        }
        if (/\[操作[:：]/.test(String(rawReply || ''))) return false;
        const said = String(userText || '');
        const wantsPhone = /(打开|玩|操作|点|滑动|继续|接着|过|通).{0,30}(手机|游戏|消消乐|应用|它)/.test(said)
            || /(手机|游戏|消消乐).{0,30}(打开|玩|操作|继续|打|过)/.test(said);
        if (!wantsPhone) {
            console.log('[Agent] 首回合催办跳过：不像是操作手机的请求');
            return false;
        }
        console.log('[Agent] 首回合只说不做 —— 催一次');
        insertAgentResult(
            '（系统内部通知：用户是让你**动手操作手机**，但你上一条只说了话，没有输出任何 [操作:…] 标签 —— '
            + '这样什么都不会发生。现在就直接输出第一步操作标签（例如 [操作:手机打开 应用名] 或 [操作:手机截图]）。）',
            { continueLoop: true, asContext: true, system: true }
        );
        return true;
    } catch (e) {
        return false;
    }
}

// 续跑提示词的措辞要求：只能说「这一步执行完了」并如实报结果 —— 写成「任务已经完成」时，模型会在只调了 agent_help 之后宣布「文件已经创建好了」。
const AGENT_CONTINUE_PROMPT = '（系统内部通知：你刚才发起的那一步已经执行完，结果已作为'
    + '「【AI 操作结果】」放进对话。请先读懂这个结果，再决定下一步。）\n'
    + '规则：\n'
    + '1. 还需要继续操作，就照常输出 [操作:…] 标签（标签不会显示给用户），系统会接着执行；\n'
    + '2. 只有**结果明确表示成功**时，才可以用你的角色身份自然告诉用户结果，'
    + '并**不要再输出任何操作标签**；\n'
    + '3. 如果结果里显示某一步失败了、没被允许、或不被支持，不要重复同一步，换个方式或如实说明；'
    + '⚠️ 同一批里有多个结果时，**只要有一条成功**就说明那件事做成了 —— '
    + '不要因为最后一条失败就无视前面的成功。典型情形：第一条命令已把文件删掉，'
    + '第二条再删同一个文件必然报"找不到路径"，那恰恰证明删除成功了，不是失败。\n'
    + '4. ⚠️ 查说明书、列目录这类**没有产生用户要的东西**的一步不算任务完成。'
    + '收尾前先确认：用户要的那件事（例如某个文件真的写进去了）是否已经**真的**做成；'
    + '没做成就继续做，或如实说还没做成。\n'
    + '5. 不要提及"系统通知""标签"这类词；但**也不要为了说得自然就编造结果** —— '
    + '没执行就说没执行，执行失败就说失败。\n'
    // 第 6 条管「衔接」：上一轮那句「我来做」用户已经看到了，这句直接接在它后面，否则模型会重新开场、同一件事被交代两遍。
    + '6. **衔接上一句**：你上面那句话（"这就给你弄""我来做"之类）用户已经看到了，'
    + '这条回复会直接接在它后面。所以**不要重新开场、不要复述任务、不要再说一遍"我来帮你…"**，'
    + '就当你刚才那句话的下一句 —— 例如上句是"这就给你弄好"，这句就该直接是'
    + '"喏，弄好了，放在桌面上了"或"没弄成，因为…"。\n'
    + '   如果这次结果只是中间的一步（还要接着做），就**不要**在这里收尾说话，直接输出下一步的操作；'
    + '只有真的做完（或确定做不成）时，才用一句话把结果交代完。\n'
    + '7. 执行期间**不要写任何旁白、解释或安抚** —— 用户在任务结束前看不到这些中间话，写了也白写；'
    + '要么直接输出下一步的操作标签，要么收尾。\n'
    + '8. 任务全部做完时，先输出一行 [完成] 标记，然后用**一段**话把结果交代完（不是一条条地发）；'
    + '只说用户要的结果，不复述过程。\n'
    + '9. 历史里的旧观察已被压缩成一行摘要，只有标着「当前界面」的那条还能代表现在的屏幕；'
    + '旧观察里的元素坐标不可用，动手前先重新 [操作:手机查看界面]。';
let agentContinueUsed = 0;
let agentContinueTimer = null;

function resetAgentContinueBudget() {
    // 子代理运行中：聊天消息不打断任务 —— 熔断计数、运行方式、目标都是会话的，别动。
    if (typeof agentSessionActive === 'function' && agentSessionActive()) {
        state._agentNarrationStreak = 0;
        return;
    }
    agentRunActivate();      // 新一轮用户请求 = 新的度量窗口
    agentContinueUsed = 0;
    agentStalledSteps = 0;   // 新的一轮用户请求 → 熔断计数也清零
    // 纯叙述催办连击也是一轮一次：新一轮用户请求 = 新的任务。
    state._agentNarrationStreak = 0;
    // 新一轮任务不再继承上一轮挂住的设备调用：队列里留着它，之后所有手机操作都会排在它后面卡死。
    if (typeof resetPhoneOperationQueue === 'function') resetPhoneOperationQueue();
    // 上一轮的界面快照对新界面没有意义：坐标与「没有变化」结论一并作废。
    if (typeof resetPhoneObservation === 'function') resetPhoneObservation();
    // 新一轮用户请求 = 新一轮运行：运行方式要重新问（上次选了后台，这次可能想盯着看）；续跑不重置它 —— 那正是「一轮只问一次」的关键。
    runModeDecision = '';
    runModeExplicit = false;
    // 实际用过的后端必须跨轮清掉：它驱动运行状态条的「看画面」按钮，留着上一轮的值会让这轮选了前台、按钮照样亮着 —— 它记录的是「刚才走了哪条路」，不该被当成「现在正在走哪条路」。
    window.__lastAgentBackend = '';
    if (agentContinueTimer) { clearTimeout(agentContinueTimer); agentContinueTimer = null; }
    // 上一轮可能还有挂着的模型调用（用户点了停止、请求尚未返回）。递增运行代号，
    // 它回来时会发现代号已变，不再把旧回复当成这一轮的结果。
    if (window.agentRuntime && typeof window.agentRuntime.bumpGeneration === 'function') {
        window.agentRuntime.bumpGeneration();
    }
}

function scheduleAgentContinue() {
    if (agentContinueTimer) clearTimeout(agentContinueTimer);
    agentContinueTimer = setTimeout(() => {
        agentContinueTimer = null;
        void continueAgentLoop();
    }, 400);
}

/** 收尾可见消息的唯一入口（完成 / 停止共用）：提交一条 AI 消息并按当前视图渲染。
 *  渲染前的守卫与 commitAiMessageOnce 同判据（当前会话 / notes / diary / 插件页 / 防重复节点）——
 *  漏了 removeThinkingMessage 会让「正在想」气泡压住新回复，看起来像没回。 */
function appendAgentVisibleMessage(textValue) {
    const conv = getCurrentConversation();
    const body = String(textValue || '').trim();
    if (!conv || !body) return null;
    removeThinkingMessage();
    const msg = { id: generateId(), role: 'ai', text: body, timestamp: new Date().toLocaleTimeString() };
    conv.messages.push(msg);
    conv.updatedAt = new Date().toISOString();
    saveConversations();
    if (state.currentConversationId === conv.id && !state.notesMode && !state.diaryMode
        && !state.memoryPageMode
        && !document.getElementById(`msg-${safeAttrId(msg.id)}`)) {
        renderMessage(msg);
    }
    renderFolderList();
    updateCurrentConversationTitle();
    state.voiceState = 'idle';
    updateUI();
    return msg;
}

/** 任务结束后把应用带回前台：手机后端在别的应用 / 副屏上操作过，收尾自动切回来，用户不用手动找。 */
function bringAppToFront() {
    try {
        const bridge = (typeof deviceBridge === 'function') ? deviceBridge() : null;
        if (bridge && typeof bridge.bringToFront === 'function') bridge.bringToFront();
    } catch (e) { /* 回前台失败不影响收尾 */ }
}

/** 运行收尾的唯一入口：完成 / 熔断 / 失败 / 停止都汇聚到这里 ——
 *  ① 记一次运行度量（运行汇总进日志与 window.__agentMetrics，不进聊天）；
 *  ② 手机后端操作过别的应用，收尾把本应用带回前台；
 *  ③ 子代理会话仍在时写回执行报告并清理（会话自己的收尾已 teardown 过，传 fromSession 跳过，避免重复写报告）；
 *  ④ 收运行状态条。 */
function agentFinishRun(reason, fromSession) {
    const rt = window.agentRuntime;
    try { agentMetricsSnapshot(reason); } catch (e) { /* 观测失败不影响收尾 */ }
    bringAppToFront();
    if (!fromSession && typeof agentSessionTeardown === 'function') agentSessionTeardown(reason);
    if (rt && typeof rt.endRun === 'function') rt.endRun();
}

async function continueAgentLoop() {
    const rt = window.agentRuntime;
    if (!rt) return;
    const runGen = (typeof rt.getGeneration === 'function') ? rt.getGeneration() : 0;
    const staleRun = () => (typeof rt.getGeneration === 'function') && rt.getGeneration() !== runGen;
    if (staleRun()) return;
    // 子代理会话运行中：续跑循环整体切到会话步进（简报 + 会话历史的独立上下文），主循环不再用自己的提示词与历史。
    if (typeof agentSessionActive === 'function' && agentSessionActive()) {
        return agentSessionStep(rt, staleRun);
    }
    if (typeof rt.isHalted === 'function' && rt.isHalted()) return;
    if (agentStalledSteps >= AGENT_STALL_FUSE) {
        console.warn('[Agent] 连续 ' + agentStalledSteps + ' 步没有取得任何进展，熔断停下');
        insertAgentResult('（连续 ' + agentStalledSteps + ' 步都没能真正做成任何一步，先停下来。'
            + '如果某一步一直失败，先把那个问题解决掉；要我接着做就跟我说一声。）', { continueLoop: false });
        agentFinishRun('fused');
        return;
    }
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
    const conv = getCurrentConversation();
    if (!conv) return;
    agentContinueUsed += 1;
    if (!rt.isRunning()) rt.beginRun();
    rt.setStep(rt.getStep() + 1, '正在思考下一步');
    console.log('[Agent] 自动续跑第 ' + agentContinueUsed + ' 步（连续无进展 '
        + agentStalledSteps + '/' + AGENT_STALL_FUSE + '）');
    agentContinueBusy = true;
    const stepStartedAt = Date.now();
    let raw;
    // 续跑请求失败必须与「AI 认为任务完成」区分开：走同一条路时失败会被当成完成 —— 浮层收起、零条提示、熔断不涨。所以失败先自动重试一次，仍失败才记进 continueError 由下面分支如实告知。注释不复述判据正则的字面量（断言要定位真实代码，会因此误判）。
    let continueError = null;
    // 提示词常量是死的，每一步的上下文是活的：目标不能被 12 条历史窗口挤掉（显式带上用户原话），
    // 已经执行的步骤来自观察消息的 summary —— 防止模型反复做同一步。
    const rawGoal = String(state._agentGoal || '').trim();
    const recentSteps = (conv.messages || [])
        .filter((m) => m && m.kind === 'agent-observation' && m.summary)
        .slice(-5).map((m) => String(m.summary)).join('；');
    const continuePrompt = AGENT_CONTINUE_PROMPT
        + (rawGoal ? '\n本轮任务目标（用户原话）：' + rawGoal : '')
        + (recentSteps ? '\n已经执行的步骤（不要重复做同一步）：' + recentSteps : '');
    const agentToolOpt = agentToolOptions() || {};
    // callAI 默认按闲聊上限裁剪输出，续跑这一步消化的是操作结果与控件清单，必须显式抬高预算。
    agentToolOpt.maxTokens = AGENT_CONTINUE_OUTPUT_TOKEN_LIMIT;
    // 死线双保险：deadlineMs 走 callAI 里的定时器闹钟（原生通道上 AbortSignal 打不断挂住的请求，
    // 实测挂过八分钟），signal 在支持的通道上顺带真取消。
    agentToolOpt.deadlineMs = AGENT_CONTINUE_CALL_DEADLINE_MS;
    try {
        // 每次尝试都要全新的 signal：超时后的重试如果复用旧 signal，拿到的就是一个已经烧完的死线，必然立刻中止。
        agentToolOpt.signal = AbortSignal.timeout(AGENT_CONTINUE_CALL_DEADLINE_MS);
        agentRunMetrics.modelCalls += 1;
        raw = await raceAgentStop(
            raceAgentDeadline(callAI(continuePrompt, agentToolOpt), AGENT_CONTINUE_CALL_DEADLINE_MS), rt);
        if (raw === AGENT_STOPPED) raw = '';
    } catch (e) {
        const isEmptyOutput = e instanceof ClientApiError && e.code === 'EMPTY_MODEL_OUTPUT';
        // DOMException（超时中止）的 code 是数字，可读的是 name；ClientApiError 的可读标识才是 code。
        const errKind = isEmptyOutput ? 'EMPTY_MODEL_OUTPUT'
            : (e instanceof ClientApiError ? (e.code || '未知') : (e && e.name) || '未知');
        console.warn('[Agent] 续跑请求失败（' + errKind + '），1 次重试…', e);
        await new Promise((r) => setTimeout(r, 800));
        if (typeof rt.isHalted === 'function' && rt.isHalted()) return;
        if (staleRun()) return;
        try {
            agentToolOpt.signal = AbortSignal.timeout(AGENT_CONTINUE_CALL_DEADLINE_MS);
            agentRunMetrics.modelCalls += 1;
            raw = await raceAgentStop(
                raceAgentDeadline(callAI(continuePrompt, agentToolOpt), AGENT_CONTINUE_CALL_DEADLINE_MS), rt);
            if (raw === AGENT_STOPPED) raw = '';
        } catch (e2) {
            continueError = e2;
            raw = '';
        }
    } finally {
        agentContinueBusy = false;
        // 每步「决策耗时」：从发出请求到拿到回复。用户要求最慢 15 秒一步，这条日志就是验收依据
        // （总步进还要加上设备动作本身，那部分在毫秒级）。
        console.log('[Agent] 第 ' + agentContinueUsed + ' 步决策耗时 '
            + ((Date.now() - stepStartedAt) / 1000).toFixed(1) + 's');
    }
    if (staleRun()) return;
    if (typeof rt.isHalted === 'function' && rt.isHalted()) return;
    if (continueError) {
        const reason = String((continueError && continueError.message) || continueError || '未知原因');
        console.error('[Agent] 续跑请求重试后仍失败，任务暂停（未静默结束）:', continueError);
        insertAgentResult(
            '续跑失败：这一步没能继续（' + reason.slice(0, 300) + '）。\n'
            + '⚠️ 任务**没有**完成，我也不会当作做完了 —— 刚才那一步的结果还在，你处理完这个问题后'
            + '跟我说一声「继续」，我就接着往下走。\n'
            + '（常见原因：网络不稳 / 服务商限流或额度用尽 / API Key 或地址失效。）',
            { continueLoop: false }
        );
        scheduleOverlayHide(1200);
        if (typeof settlePendingToolReply === 'function') {
            try { settlePendingToolReply(false); } catch (e) { /* 兜底失败不该挡住报错 */ }
        }
        agentFinishRun('error');
        return;
    }
    const text = window.ElainaTags ? window.ElainaTags.strip(raw || '') : (raw || '');
    if (text) {
        if (typeof settlePendingToolReply === 'function') {
            try { settlePendingToolReply(true); } catch (e) { /* 取代失败不该影响回复落库 */ }
        }
        // 派发回复捕获（两条通道之一）：子代理会话的「主对话备注」从这里取。
        state._agentDispatchReply = text;
        const aiMessage = { id: generateId(), role: 'ai', text, timestamp: new Date().toLocaleTimeString() };
        conv.messages.push(aiMessage);
        conv.updatedAt = new Date().toISOString();
        saveConversations();
        removeThinkingMessage();
        if (state.currentConversationId === conv.id && !state.notesMode && !state.diaryMode && !state.memoryPageMode
            && !document.getElementById(`msg-${safeAttrId(aiMessage.id)}`)) {
            renderMessage(aiMessage);
        }
        state.voiceState = 'idle';
        updateUI();
    }
    // 回复里带了新的 [操作:…] → 真的执行它（同一条标签管线，停止 / 授权照常生效）。判据必须同步看标签，不能靠「等一下再看 agentContinueTimer」：drive() 的操作是异步的，此刻定时器还没设上，会误判成「AI 已收尾」。带工具调用则走工具通道，放在标签判据之前。
    const rawText = String(raw || '');
    const hasAnyTags = /\[操作[:：]/.test(rawText);
    const hasMoreOps = agentTagKeepsRunning(rawText);
    const hasCompletion = /\[完成(?::[^\]]*)?\]/.test(rawText);
    const repliedToolCalls = (agentToolOpt && agentToolOpt.replyInfo
        && Array.isArray(agentToolOpt.replyInfo.toolCalls)) ? agentToolOpt.replyInfo.toolCalls : [];
    if (repliedToolCalls.length) {
        state._agentNarrationStreak = 0;   // 模型真的动手了：纯叙述连击清零
        void runToolCalls(repliedToolCalls, { access: currentAgentAccess() });
        return;
    }
    if (hasMoreOps && window.ElainaTags) {
        state._agentNarrationStreak = 0;   // 模型真的动手了：纯叙述连击清零
        window.ElainaTags.drive(rawText);
        return;   // 后续由新一轮结果接力
    }
    // 纯表现标签（通话 / 记忆 / 表情等）照常执行 —— 它们不产生要接力的结果，但也不该被丢掉。
    if (hasAnyTags && window.ElainaTags) window.ElainaTags.drive(rawText);
    // 续跑中途的纯叙述回复（没标签、没工具调用、也没 [完成]）不是收尾：任务走到一半时，这代表模型违背了
    // 「要么发标签、要么宣布完成」的协议 —— 直接 endRun 会把任务静默停在半路，用户只看到 AI 嘴上答应。
    // 实测 kimi-k3 每跑一两步就来一次，而且第一次续跑（== 1）就会发生，所以连续催办到额度用尽；
    // 若模型真的做完了，它对催办的下一条回复会再次收尾，多付几次模型调用是可接受的代价。
    if (!hasCompletion && agentContinueUsed >= 1) {
        const streak = (state._agentNarrationStreak || 0) + 1;
        state._agentNarrationStreak = streak;
        if (streak <= AGENT_NARRATION_NUDGE_LIMIT) {
            insertAgentResult(
                '（系统内部通知：你上一条回复没有输出任何 [操作:…] 标签，也没有明确宣布任务完成 —— '
                + '只说不做的话，什么都不会发生，任务就停在这里了。'
                + '任务还没做完就**现在**输出下一步的操作标签；只有全部做完，才用一句话收尾。）',
                { continueLoop: true, asContext: true, system: true }
            );
            return;
        }
        // 催办额度用尽模型仍只说不做：按熔断语义收尾（用户可「继续」再拉起）。
        // 收尾必须有可见交代 —— 这轮停是因为「只说不做」超限，不是熔断线，文案要说清原因；
        // 过程话全程被压制的话，用户看到的就是任务无声消失。
        appendAgentVisibleMessage('这轮任务先停在这里：我连续几轮只输出了说明，没有实际执行动作。'
            + '要我接着做就跟我说一声。');
        agentFinishRun('fused');
        return;
    }
    if (typeof settlePendingToolReply === 'function') {
        try { settlePendingToolReply(false); } catch (e) { /* 兜底放出失败不该挡住收尾 */ }
    }
    // 模型可能只输出 [完成] 标记（正文被剥空）：补一条兜底总结，对话里不能什么都不出现。
    if (!text) appendAgentVisibleMessage(agentRunSummaryText('completed'));
    agentFinishRun('completed');
}
