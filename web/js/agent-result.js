/* ============================================================================
 * Agent 结果回灌与失败解释（从 agent.js 拆出）
 *
 * explainAgentFailure / insertAgentResult / 失败重试预算。
 * 依赖宿主 callAI、消息渲染与续跑运行时（运行时才调用）。
 * ========================================================================== */
'use strict';

const AGENT_FAILURE_MAX_RETRY = 1;

// 操作失败 → AI 以角色身份自然向用户解释原因与建议（像正常对话一样）
async function explainAgentFailure(reason) {
    const conv = getCurrentConversation();
    // 失败原因里可能带着「这台电脑的真实位置」那段提示（serve.mjs 的 shellFolderHint），
    // 截得太短会把它切掉一半，AI 就拿不到纠正所需的路径了。
    const shortReason = String(reason).slice(0, 600);
    if (!conv) { showCustomAlert('操作失败：' + shortReason, 'AI 操作结果'); return; }
    const canRetry = agentConsecutiveFailures <= AGENT_FAILURE_MAX_RETRY;
    const prompt = `（系统内部通知：刚才你尝试执行的文件操作失败了，原因：${shortReason}。`
        + '请以你的角色身份，用自然、真诚的口吻向用户解释为什么无法完成这个操作，并给出可行的解决办法建议'
        + '（例如检查 Agent 权限模式、路径是否正确、服务是否可用等）。不要提及"系统通知""标签"等词，'
        + '就像你真的尝试过并遇到问题一样，自然地说明和道歉。）'
        + (canRetry ? '\n（如果上面的原因里已经给出了正确的位置，请在解释的同时**直接用正确的路径重新发起一次操作**'
            + ' —— 照常输出 [操作:…] 标签，标签不会显示给用户。不要只是道歉。）' : '');
    let raw;
    const agentToolOpt = agentToolOptions();
    try {
        raw = await callAI(prompt, agentToolOpt || undefined);
    } catch (e) {
        // 模型偶尔只回思考内容（EMPTY_MODEL_OUTPUT，思考型模型在"系统内部通知"这种
        // 元提示上尤其容易这样），原样重试一次基本就好；再失败就只把原因显示出来，
        // 不要把「（AI 解释失败：模型只返回了思考内容…）」这种嵌套文案甩给用户。
        if (e instanceof ClientApiError && e.code === 'EMPTY_MODEL_OUTPUT') {
            try { raw = await callAI(prompt, agentToolOpt || undefined); } catch { raw = ''; }
        } else {
            raw = '';
        }
    }
    const text = window.ElainaTags ? window.ElainaTags.strip(raw || '') : (raw || '');
    // 这一轮有没有工具调用（容器见 agentToolOptions）：有就走工具通道，不再解析标签 ——
    //   两条都跑会让同一个动作执行两次。
    const repliedToolCalls = (agentToolOpt && agentToolOpt.replyInfo
        && Array.isArray(agentToolOpt.replyInfo.toolCalls)) ? agentToolOpt.replyInfo.toolCalls : [];
    const wantsRetry = !repliedToolCalls.length && canRetry && /\[操作[:：]/.test(raw || '');
    if (text) {
        const aiMessage = { id: generateId(), role: 'ai', text, timestamp: new Date().toLocaleTimeString() };
        conv.messages.push(aiMessage);
        saveConversations();
        if (state.currentConversationId === conv.id) renderMessage(aiMessage);
    } else if (!wantsRetry && !repliedToolCalls.length) {
        // 一句可见回复都没拿到，而且也没有重试 —— 至少把原因摆出来，别让用户对着空气等。
        // continueLoop: false 是必须的：这句是**失败说明**，不是"操作成功的结果"。
        // 若它触发续跑，就会绕过失败路径自己的重试预算（AGENT_FAILURE_MAX_RETRY = 1），
        // 变成"失败 → 续跑 → 再失败 → 再续跑"一直撞到续跑上限（8 次）才停 ——
        // 两套预算互相打架，用户看到的是 AI 对着一个不存在的路径反复尝试。
        insertAgentResult('操作失败：' + shortReason, { continueLoop: false });
    }
    // 解释里带了工具调用 → 执行它们（结果以 role:'tool' 回灌，正文里看不到；
    //   执行完自己会调度续跑）。否则才看标签。
    if (repliedToolCalls.length) {
        void runToolCalls(repliedToolCalls, { access: currentAgentAccess() });
    } else if (wantsRetry && window.ElainaTags) {
        window.ElainaTags.drive(raw);
    }
}

/**
 * 把 Agent 操作结果作为一条**上下文**消息插入当前对话（AI 下轮可参考）。**默认不自动续跑**。
 *
 * 默认关：这是多处调用的公共收口，大多数调用是「无权限 / 未启用 / 用户取消 / 未识别」这类**被拒绝**的结果，
 *   若也触发续跑就变成「被拒绝 → 续跑 → 又试一次」的无效循环。只有真做完了某件事才值得让 AI 决定下一步。
 *
 * asContext：成功结果只进过程区，不占聊天气泡。成功与失败必须同一种呈现 —— 失败由 explainAgentFailure 让角色
 *   开口，成功若再插一条可见的结果块，同一件事会在同一轮出现两次，而且顺序是「结果在先、正文在后」。
 *   传 true 时消息照样进 messages（模型下一轮要看到）但标 hidden 不渲染；失败与被拒绝仍走可见气泡。
 */
function insertAgentResult(text, options = {}) {
    const conv = getCurrentConversation();
    if (!conv) { showCustomAlert(text, 'AI 操作结果'); return; }
    const asContext = options.asContext === true;
    const msg = {
        id: generateId(),
        role: 'ai',
        text: '【AI 操作结果】\n' + text,
        timestamp: new Date().toLocaleTimeString(),
    };
    if (asContext) msg.hidden = true;
    conv.messages.push(msg);
    saveConversations();
    if (!asContext && state.currentConversationId === conv.id) renderMessage(msg);
    // 熔断计数：只有"真的做成了一件事"（唯一会传 continueLoop: true 的场景）才算进展，
    // 其余结果都记作"这一步没有进展" —— 见 AGENT_STALL_FUSE 的说明。
    if (options.continueLoop === true) {
        agentStalledSteps = 0;
        scheduleAgentContinue();
    } else {
        agentStalledSteps += 1;
    }
}


