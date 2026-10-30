/* ============================================================================
 * Agent 自动续跑（从 agent.js 拆出）
 *
 * 续跑预算 / 熔断 / scheduleAgentContinue / continueAgentLoop。
 * 依赖 agent-tools 的 runToolCalls 与 agent-phone 的浮层忙碌判定（运行时才调用）。
 * ========================================================================== */
'use strict';

// ===== Agent 自动续跑：操作做完自己接着走，不用用户说"继续" =====
// 症状：AI 读取/写入/点击之后就不动了，必须用户手动说一句"继续"才走下一步。
// 根因是一个**不对称**：
//   · 失败路径 explainAgentFailure() 会调 callAI()，所以 AI 能自己解释并重试；
//   · 成功路径只 insertAgentResult() 把结果塞进对话，**从不调 callAI()** ——
//     AI 看不到"我刚做完的事"，自然不会有下一步。
// 日志里能直接看到：执行完 [操作:保存文件 …] 后，下一次请求的末条消息是
// **user**（用户手动打的"继续"），而不是由操作结果触发的续跑。
// 三条硬约束：
//   1. **有熔断**：否则"被拒绝 → 续跑 → 又被拒绝"会无限刷下去，白烧额度与电量。
//      熔断看的是"连续无进展"，不是"步数上限" —— 见 AGENT_STALL_FUSE。
//      步数硬上限会把一件正常的长任务腰斩（做到一半就停），
//      而它想防的"死循环"用"有没有进展"判断更准。
//   2. **用户停止后不再续跑**：停止的意义就是让 AI 停下，续跑必须让位。
//   3. **合并触发**：一条回复里可能有多个操作标签，结果会连着插进来 ——
//      用防抖合成一次续跑，否则会并发打出好几个请求。
// AGENT_STALL_FUSE：**连续**多少步没做成任何事就熔断并如实报告。
//   判据是 insertAgentResult 的 continueLoop 选项 —— 只有"真的做成了一件事"才传 true，
//   其余（被拒 / 失败 / 未启用 / 未识别）都算"这一步没有进展"。
//   任何一次成功、或用户新发一条消息，计数清零。
//   为什么不是"步数上限"：一件正常的长任务可能几十步，步数到就停是误伤；
//   而连续几步全都做不成，继续下去也只是重复失败 —— 那种情况也正是悬浮窗
//   "一直在闪"的温床（每步 show/hide 一次）。
const AGENT_STALL_FUSE = 3;
let agentStalledSteps = 0;
// 续跑提示词的措辞要求（第 2 条尤其要紧）：
//   它过去写的是"任务已经完成，就直接告诉用户结果" —— 这句话在**没做成**的时候是假的，
//   而模型会照它办。真实事故：模型这一轮只调了 agent_help（查说明书，本身什么都没做），
//   续跑提示词却告诉它"任务已经完成"，于是它描写键盘声、宣布"文件已经创建好了，内容是 hi"，
//   用户桌面上一无所有。
//   所以这里只说"这一步执行完了"，并明确要求**按结果如实**：成功才说成功，没做成就说没做成，
//   而且不许用动作描写代替真正的执行。
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
    // 这一条是"衔接"的关键，也是本提示词唯一管**语感**的地方。
    //   上一轮你说的话（"我来做""这就给你弄"）**用户已经看到了**，
    //   而现在这条回复会直接接在它后面。若不作要求，模型往往重新起一个头
    //   （"好的，我来帮你在桌面创建文件"）—— 读者看到的就是同一件事被交代两遍，
    //   而且第二遍装的像刚知道似的。DSH 之所以没有这个问题，是因为它把每一步的
    //   正文都当中间产物，最终只呈现"知道结果之后"的那一句。
    //   所以这里明确：**就当上一句是你自己说的，接着它往下讲**，
    //   不要复述任务、不要重新开场、不要重复"我来帮你"。
    + '6. **衔接上一句**：你上面那句话（"这就给你弄""我来做"之类）用户已经看到了，'
    + '这条回复会直接接在它后面。所以**不要重新开场、不要复述任务、不要再说一遍"我来帮你…"**，'
    + '就当你刚才那句话的下一句 —— 例如上句是"这就给你弄好"，这句就该直接是'
    + '"喏，弄好了，放在桌面上了"或"没弄成，因为…"。\n'
    + '   如果这次结果只是中间的一步（还要接着做），就**不要**在这里收尾说话，直接输出下一步的操作；'
    + '只有真的做完（或确定做不成）时，才用一句话把结果交代完。';
let agentContinueUsed = 0;
let agentContinueTimer = null;

/** 每来一条新的用户消息就重置预算（一次用户请求 = 一个预算） */
function resetAgentContinueBudget() {
    agentContinueUsed = 0;
    agentStalledSteps = 0;   // 新的一轮用户请求 → 熔断计数也清零
    // 新的一轮用户请求 = 新的一轮运行：运行方式要**重新问**（上次选了后台，
    // 这次可能想盯着看）。续跑不重置它 —— 那正是"一轮只问一次"的关键。
    runModeDecision = '';
    runModeExplicit = false;
    // **实际用过的后端**必须跨轮清掉。
    //   它驱动运行状态条的「看画面」按钮（见 agentRuntime.render），
    //   如果留着上一轮的值，用户这轮选了前台、上一轮走过模块，按钮照样亮着 ——
    //   看起来就像"它又在走模块"。跨轮复用同一个显示状态本身就是错的：
    //   它记录的是"刚才走了哪条路"，不该被当成"现在正在走哪条路"。
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
    // 用户按了停止 → 绝不再自动往下走（否则"停止"会被续跑顶掉）
    if (typeof rt.isHalted === 'function' && rt.isHalted()) return;
    // 只有"连续无进展"熔断，没有步数上限。
    //   这句说明**必须** continueLoop: false —— 否则"熔断 → 插提示 → 又调度 → 又熔断"
    //   会自己转起来。
    if (agentStalledSteps >= AGENT_STALL_FUSE) {
        console.warn('[Agent] 连续 ' + agentStalledSteps + ' 步没有取得任何进展，熔断停下');
        insertAgentResult('（连续 ' + agentStalledSteps + ' 步都没能真正做成任何一步，先停下来。'
            + '如果某一步一直失败，先把那个问题解决掉；要我接着做就跟我说一声。）', { continueLoop: false });
        scheduleOverlayHide(0);
        rt.endRun();
        return;
    }
    // 续跑开始 → 悬浮窗要**留着**（别让上一批排下的收起定时器把它收掉）。
    //   这一刻没有任何操作在跑，但用户切到别的 App 时仍然要看得见 AI 还在动
    //   （看到的必须是"AI 还在干什么"，哪怕这一刻没有任何操作在跑）——
    //   所以下面 setStep 的动作名写成「正在思考下一步」，它同时驱动浮层与状态条。
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
    const conv = getCurrentConversation();
    if (!conv) return;
    agentContinueUsed += 1;
    // 只在"还没在跑"时 beginRun：它会清空 approvedThisRun，
    // 无条件调用会让「同一次运行内允许过就不再问」这条策略在每次续跑时失效
    // （用户点了允许，下一步又问一遍）。runAgentPhoneOperation 也是这么写的。
    if (!rt.isRunning()) rt.beginRun();
    rt.setStep(rt.getStep() + 1, '正在思考下一步');
    console.log('[Agent] 自动续跑第 ' + agentContinueUsed + ' 步（连续无进展 '
        + agentStalledSteps + '/' + AGENT_STALL_FUSE + '）');
    // 「思考期」就是**这段模型调用**。
    //   标记"管道忙"，让排队中的收起作废、并让 phoneRunEndTimer 提前的 endRun 跳过 ——
    //   用户切到别的 App 时，浮层与状态条必须整段都在（那才是他看得到的"AI 还在动"）。
    //   只罩这一段是够的：callAI 一返回，要么有后续操作（drive → 操作在飞 / 续跑已排上，
    //   守卫自然成立），要么就是收尾 —— 那时**本来就应该**收。
    agentContinueBusy = true;
    let raw;
    // 续跑请求**失败**必须与"AI 认为任务完成"区分开 —— 两者一旦走同一条路，就会出这种事：
    //     ① catch 里把任何非 EMPTY 的失败都 `raw = ''`；
    //     ② 下面那句"回复里有没有操作标签"的正则因此匹配不到，判为"没有更多操作"；
    //     ③ 于是走收尾分支 scheduleOverlayHide(0) + rt.endRun()。
    //     —— 即"请求失败"被当成了"AI 认为任务完成"：浮层收起、对话里零条提示、
    //        熔断计数也不涨，用户以为"它做完了"或"它卡住了"，完全无从判断。
    //   而任何一次续跑失败（网络抖动 / 超时 / 限流 429 / 5xx）都会触发这条路，
    //   失败原因（往往是额度或网络）恰恰是他唯一需要知道的东西。
    //   ⚠️ 这里刻意**不写出那句正则的字面量**：它是断言要定位的真实代码，
    //      在注释里复述会让"失败分支是否在它之前"这类断言匹配到注释而失真
    //      （check-agent-overlay 的 runModeDecision、check-agent-continue 的 hasMoreOps
    //        都因此误判过）。注释只描述、不复制代码。
    //   所以失败先**自动重试一次**（后台网络抖动/限流很常见，且这是最省事的恢复），
    //   仍失败才记进 continueError，由下面的分支"如实告知 + 保持可继续"。
    let continueError = null;
    const agentToolOpt = agentToolOptions();
    try {
        raw = await callAI(AGENT_CONTINUE_PROMPT, agentToolOpt || undefined);
    } catch (e) {
        // EMPTY_MODEL_OUTPUT 是**模型输出形态**问题（思考型模型在"系统内部通知"
        // 这种元提示上尤其容易只回思考内容），不是链路故障，原样重试一次通常就好。
        // （与 explainAgentFailure 的处理保持一致。）
        // 其它错误也重试一次：这个场景下最可能的失败原因是后台网络抖动 / 限流，
        // 一次重试就能救回来，比让用户手动说"继续"划算得多。
        // 只重试一次、且不在这里 endRun —— 见下面 continueError 分支的说明。
        const isEmptyOutput = e instanceof ClientApiError && e.code === 'EMPTY_MODEL_OUTPUT';
        console.warn('[Agent] 续跑请求失败（' + (isEmptyOutput ? 'EMPTY_MODEL_OUTPUT' : (e && e.code) || '未知')
            + '），1 次重试…', e);
        // 稍等一下再重试：立刻重试往往撞上同一个瞬时故障（连接还没恢复/仍在限流窗口）
        await new Promise((r) => setTimeout(r, 800));
        // 用户在这 800ms 里按了停止 → 不再白试一次（停止优先于一切）
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
    // 续跑途中用户按了停止 → 不渲染这半截回复（停止优先于一切，包括报错）
    if (typeof rt.isHalted === 'function' && rt.isHalted()) return;
    // 续跑请求**连重试都失败**：如实告知 + 保持可继续，绝不静默收工。
    //   为什么不能静默 endRun：
    //     任务其实**没有结束** —— 只是这一步的模型调用没成功。用户往往就在等结果，
    //     把浮层收掉等于告诉他"做完了"，而真正该知道的失败原因（额度/网络）被彻底掩盖。
    //   为什么不无限自动重试：
    //     上面已经重试过一次。若仍失败，多半不是抖动而是**持续性**原因
    //     （额度用尽 / Key 失效 / 服务商故障）—— 闷头重试只会白烧额度、让界面一直闪，
    //     而这类原因用户必须自己处理，重试一百次也一样。
    //   为什么这里 endRun（把浮层收掉）：
    //     这一刻**确实没有任何东西在跑**了，留着一个"AI 正在操作"的浮层是假信息。
    //     收掉它 + 在对话里写明"任务没完成、说声『继续』我就接着走"才是诚实的表达。
    //     （用户说「继续」= 一条新消息 → 重置预算 → 带着完整上下文继续推进。）
    //   这里**不**动 agentStalledSteps：熔断计数只服务于"自动续跑链"，
    //     而这条路径已经停下等用户发话；用户下一条消息就会把它清零，递增无意义。
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
        // 收起浮层（理由见上：这一刻真的没东西在跑，留着是假信息）
        scheduleOverlayHide(1200);
        // 压着的那句话也要安置：工具其实做完了，只是"交代结果"这一步的模型调用失败。
        //   不放出来的话，用户只看到一条报错、却不知道那件事到底成没成。
        if (typeof settlePendingToolReply === 'function') {
            try { settlePendingToolReply(false); } catch (e) { /* 兜底失败不该挡住报错 */ }
        }
        rt.endRun();
        return;
    }
    const text = window.ElainaTags ? window.ElainaTags.strip(raw || '') : (raw || '');
    if (text) {
        // 先让"动手前那句话"退场，再把这条基于结果的回复放进来。
        //   顺序不能反：反了会出现一瞬间两条并存（用户看到同一件事说两遍），
        //   而且新消息已经进了数组时再按 id 过滤旧消息，容易误伤。
        //   （若那句已经被显示过，settle 内部不会删它 —— 见 replacePendingToolReply。）
        if (typeof settlePendingToolReply === 'function') {
            try { settlePendingToolReply(true); } catch (e) { /* 取代失败不该影响回复落库 */ }
        }
        const aiMessage = { id: generateId(), role: 'ai', text, timestamp: new Date().toLocaleTimeString() };
        conv.messages.push(aiMessage);
        conv.updatedAt = new Date().toISOString();
        saveConversations();
        // 这三步必须和 handleUserInput 的 commitAiMessageOnce 保持一致，
        // 否则会出现"回复已经存进对话、界面上却看不见，得再发一句才冒出来"：
        //   · removeThinkingMessage() —— 否则"伊蕾娜正在想…"气泡一直挂着，
        //     而新回复被压在它下面（用户以为 AI 没回）；
        //   · 渲染前判当前会话与 notes/diary 模式 —— 在别的页面时不该往聊天区插节点；
        //   · 渲染后更新状态与滚动。
        removeThinkingMessage();
        if (state.currentConversationId === conv.id && !state.notesMode && !state.diaryMode
            && !document.getElementById(`msg-${safeAttrId(aiMessage.id)}`)) {
            renderMessage(aiMessage);
        }
        state.voiceState = 'idle';
        updateUI();
    }
    // 回复里带了新的 [操作:…] → 真的执行它（走同一条标签管线，
    // 停止/授权照常生效；执行完又会 insertAgentResult → 继续下一步）。
    // 判据要**同步看有没有操作标签**，不能靠"等一下再看 agentContinueTimer"：
    // drive() 里的操作是异步的（要先弹授权、再发请求），此刻定时器还没被设上，
    // 那样判断会误判成"AI 已收尾"而提前 endRun。
    // 这一轮带回了工具调用 → 走工具通道：执行它们（结果以 role:'tool' 回灌），
    //   执行完 runToolCalls 自己会再调度一次续跑接力。放在标签判据**之前**：
    //   两条都跑会让同一个动作执行两次。
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
    // 没有操作标签 → 认为任务完成：收尾前先安置「压着的那句话」，否则续跑没给正文时
    //   用户会看到「操作做完了，但 AI 一声不吭」。全失败时那句是动手前的结论，不放（见 canRevealPendingToolReply）。
    if (typeof settlePendingToolReply === 'function') {
        try { settlePendingToolReply(false); } catch (e) { /* 兜底放出失败不该挡住收尾 */ }
    }
    scheduleOverlayHide(0);
    rt.endRun();
}



