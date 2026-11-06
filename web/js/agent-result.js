// Agent 结果回灌与失败解释；依赖宿主 callAI、消息渲染与续跑运行时（运行时才调用）。
'use strict';

const AGENT_FAILURE_MAX_RETRY = 1;

async function explainAgentFailure(reason) {
    const conv = getCurrentConversation();
    // 失败原因里可能带着「这台电脑的真实位置」那段提示（serve.mjs 的 shellFolderHint），截短会切掉路径。
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
        // 模型偶尔只回思考内容（EMPTY_MODEL_OUTPUT，思考型模型在"系统内部通知"这类元提示上尤其容易），原样重试一次基本就好；
        if (e instanceof ClientApiError && e.code === 'EMPTY_MODEL_OUTPUT') {
            try { raw = await callAI(prompt, agentToolOpt || undefined); } catch { raw = ''; }
        } else {
            raw = '';
        }
    }
    const text = window.ElainaTags ? window.ElainaTags.strip(raw || '') : (raw || '');
    // 这一轮有工具调用就走工具通道、跳过标签解析 —— 两条都跑会让同一个动作执行两次。
    const repliedToolCalls = (agentToolOpt && agentToolOpt.replyInfo
        && Array.isArray(agentToolOpt.replyInfo.toolCalls)) ? agentToolOpt.replyInfo.toolCalls : [];
    const wantsRetry = !repliedToolCalls.length && canRetry && /\[操作[:：]/.test(raw || '');
    if (text) {
        const aiMessage = { id: generateId(), role: 'ai', text, timestamp: new Date().toLocaleTimeString() };
        conv.messages.push(aiMessage);
        saveConversations();
        if (state.currentConversationId === conv.id) renderMessage(aiMessage);
    } else if (!wantsRetry && !repliedToolCalls.length) {
        // 一句可见回复都没拿到、也没有重试：至少把原因摆出来。continueLoop: false 是必须的 —— 这句是失败说明，触发续跑会绕过失败路径自己的重试预算。
        insertAgentResult('操作失败：' + shortReason, { continueLoop: false });
    }
    // 解释里带了工具调用就执行（结果以 role:'tool' 回灌，执行完自己调度续跑）；否则才看标签。
    if (repliedToolCalls.length) {
        void runToolCalls(repliedToolCalls, { access: currentAgentAccess() });
    } else if (wantsRetry && window.ElainaTags) {
        window.ElainaTags.drive(raw);
    }
}

// 把操作结果作为一条上下文消息插入当前对话，默认不自动续跑：这是多处调用的公共收口，大多是「无权限 / 未启用 / 用户取消 / 未识别」这类被拒绝结果，续跑会变成无效循环。
// asContext 时消息仍进 messages（下轮可见）但标 hidden 不渲染：成功与失败必须同一种呈现，失败由 explainAgentFailure 让角色开口，成功再插可见块会让同一件事在同一轮出现两次。
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
    // 熔断计数：只有"真的做成了一件事"（唯一会传 continueLoop: true 的场景）才算进展（见 AGENT_STALL_FUSE）。
    if (options.continueLoop === true) {
        agentStalledSteps = 0;
        scheduleAgentContinue();
    } else {
        agentStalledSteps += 1;
    }
}


