// Agent 自动续跑：续跑预算 / 熔断 / scheduleAgentContinue / continueAgentLoop；依赖 agent-tools 的 runToolCalls 与 agent-phone 的浮层忙碌判定（运行时才调用）。
'use strict';

const AGENT_STALL_FUSE = 3;
let agentStalledSteps = 0;
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
    + '只有真的做完（或确定做不成）时，才用一句话把结果交代完。';
let agentContinueUsed = 0;
let agentContinueTimer = null;

function resetAgentContinueBudget() {
    agentContinueUsed = 0;
    agentStalledSteps = 0;   // 新的一轮用户请求 → 熔断计数也清零
    // 新一轮用户请求 = 新一轮运行：运行方式要重新问（上次选了后台，这次可能想盯着看）；续跑不重置它 —— 那正是「一轮只问一次」的关键。
    runModeDecision = '';
    runModeExplicit = false;
    // 实际用过的后端必须跨轮清掉：它驱动运行状态条的「看画面」按钮，留着上一轮的值会让这轮选了前台、按钮照样亮着 —— 它记录的是「刚才走了哪条路」，不该被当成「现在正在走哪条路」。
    window.__lastAgentBackend = '';
    if (agentContinueTimer) { clearTimeout(agentContinueTimer); agentContinueTimer = null; }
}

function scheduleAgentContinue() {
    if (agentContinueTimer) clearTimeout(agentContinueTimer);
    agentContinueTimer = setTimeout(() => {
        agentContinueTimer = null;
        void continueAgentLoop();
    }, 400);
}

async function continueAgentLoop() {
    const rt = window.agentRuntime;
    if (!rt) return;
    if (typeof rt.isHalted === 'function' && rt.isHalted()) return;
    if (agentStalledSteps >= AGENT_STALL_FUSE) {
        console.warn('[Agent] 连续 ' + agentStalledSteps + ' 步没有取得任何进展，熔断停下');
        insertAgentResult('（连续 ' + agentStalledSteps + ' 步都没能真正做成任何一步，先停下来。'
            + '如果某一步一直失败，先把那个问题解决掉；要我接着做就跟我说一声。）', { continueLoop: false });
        scheduleOverlayHide(0);
        rt.endRun();
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
    let raw;
    // 续跑请求失败必须与「AI 认为任务完成」区分开：走同一条路时失败会被当成完成 —— 浮层收起、零条提示、熔断不涨。所以失败先自动重试一次，仍失败才记进 continueError 由下面分支如实告知。注释不复述判据正则的字面量（断言要定位真实代码，会因此误判）。
    let continueError = null;
    const agentToolOpt = agentToolOptions();
    try {
        raw = await callAI(AGENT_CONTINUE_PROMPT, agentToolOpt || undefined);
    } catch (e) {
        const isEmptyOutput = e instanceof ClientApiError && e.code === 'EMPTY_MODEL_OUTPUT';
        console.warn('[Agent] 续跑请求失败（' + (isEmptyOutput ? 'EMPTY_MODEL_OUTPUT' : (e && e.code) || '未知')
            + '），1 次重试…', e);
        await new Promise((r) => setTimeout(r, 800));
        if (typeof rt.isHalted === 'function' && rt.isHalted()) return;
        try {
            raw = await callAI(AGENT_CONTINUE_PROMPT, agentToolOpt || undefined);
        } catch (e2) {
            continueError = e2;
            raw = '';
        }
    } finally {
        agentContinueBusy = false;
    }
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
        rt.endRun();
        return;
    }
    const text = window.ElainaTags ? window.ElainaTags.strip(raw || '') : (raw || '');
    if (text) {
        if (typeof settlePendingToolReply === 'function') {
            try { settlePendingToolReply(true); } catch (e) { /* 取代失败不该影响回复落库 */ }
        }
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
    const repliedToolCalls = (agentToolOpt && agentToolOpt.replyInfo
        && Array.isArray(agentToolOpt.replyInfo.toolCalls)) ? agentToolOpt.replyInfo.toolCalls : [];
    if (repliedToolCalls.length) {
        void runToolCalls(repliedToolCalls, { access: currentAgentAccess() });
        return;
    }
    const hasMoreOps = /\[操作[:：]/.test(String(raw || ''));
    if (hasMoreOps && window.ElainaTags) {
        window.ElainaTags.drive(raw || '');
        return;   // 后续由新一轮 insertAgentResult 接力
    }
    if (typeof settlePendingToolReply === 'function') {
        try { settlePendingToolReply(false); } catch (e) { /* 兜底放出失败不该挡住收尾 */ }
    }
    scheduleOverlayHide(0);
    rt.endRun();
}
