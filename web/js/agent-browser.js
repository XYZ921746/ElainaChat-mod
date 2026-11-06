// AI 用浏览器：打开网页/看页面/点击/填写/回车/关闭；请求由服务端 /api/agent/browser 执行。
'use strict';

// 与「电脑命令」的分工：命令通道文本进文本出，AI 看不到页面；这条通道是看页面 → 决定 → 真点一下。
// 请求落在服务端：浏览器进程在服务端那台机器上，且调试端口能读全部 cookie，
// 只可对本机开放（见 serve.mjs 的 browserDenyReason），放前端等于交给任何能打开页面的人。

/** 动作名 → 过程行标题（用户看的是"做了什么"，不是"调了什么工具"） */
const BROWSER_ACTION_LABEL = {
    open: '打开浏览器',
    goto: '打开网页',
    snapshot: '看页面',
    click: '点击页面元素',
    type: '填写输入框',
    press_enter: '按回车',
    close: '关闭浏览器',
};



// 两条通道送达方式必须分开（同 doAgentFile / doAgentCommand）：工具通道由 runToolCalls 以 role:'tool'
// 回灌，再插消息会说两遍；标签通道没有外层调用者，结果只能自己放进对话并排下一次续跑。
// 失败一律返回 {ok:false,text}，让模型看到原因（网址不合法、页面变了、没装浏览器）而不是一句"操作失败"。
async function runAgentBrowserOperation(args, traceItem) {
    const rt = window.agentRuntime;
    const action = String(args && args.action || '').trim();
    const label = BROWSER_ACTION_LABEL[action] || action;
    const ownTrace = !traceItem;
    if (ownTrace) {
        traceItem = recordTurnTool({
            kind: 'browser',
            title: '浏览器 · ' + (label || '操作'),
            summary: summarizeBrowserArgs(args),
            args: JSON.stringify(args || {}),
            state: 'running',
        });
    } else {
        updateTurnTool(traceItem, { kind: 'browser', title: '浏览器 · ' + (label || '操作'), summary: summarizeBrowserArgs(args) });
    }
    // APK 上没有本机服务端，也就没有浏览器进程可起。
    if (IS_NATIVE_APP) {
        const m = '当前是安卓 App，没有本机服务端，用不了浏览器功能。请在电脑上运行本应用。';
        updateTurnTool(traceItem, { state: 'stopped', result: m });
        return { ok: false, text: m };
    }
    if (agentAccessDisabled()) {
        updateTurnTool(traceItem, { state: 'stopped', result: AGENT_DISABLED_NOTE });
        return { ok: false, text: AGENT_DISABLED_NOTE };
    }
    // 注册表 available() 只影响工具清单，标签通道仍会派发到这里，开关必须在执行器里再判一次。
    if (state.settings.agentBrowserEnabled !== true) {
        const m = '浏览器功能没有打开。需要的话请在「设置 → 能力 → 浏览器」里打开「允许 AI 用浏览器」。';
        updateTurnTool(traceItem, { state: 'stopped', result: m });
        return { ok: false, text: m };
    }
    // 打开浏览器会弹出用户看得见的窗口，strict 档问一次；之后在这个已批准的窗口内导航与点击不再逐条打扰。
    if (action === 'open' && rt) {
        const allowed = await rt.requestApproval(
            '浏览器',
            'AI 想在这台电脑上打开一个浏览器窗口，用来查资料或走一遍网页流程。'
                + '\n（它用的是独立的临时配置，不碰你平时那个浏览器的书签和登录状态。）'
        );
        if (!allowed) {
            updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许打开浏览器' });
            return { ok: false, text: '用户没有允许打开浏览器。需要的话请先跟他说明要查什么。' };
        }
    }
    try {
        const res = await fetch('/api/agent/browser', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access: currentAgentAccess(), action, args }),
        });
        const payload = await res.json().catch(() => null);
        if (!payload) {
            const m = '浏览器接口返回的不是 JSON（HTTP ' + res.status + '）';
            updateTurnTool(traceItem, { state: 'error', result: m });
            if (ownTrace) await explainAgentFailure(m);
            return { ok: false, text: m };
        }
        if (!payload.ok) {
            const m = String(payload.message || payload.text || '浏览器操作失败');
            updateTurnTool(traceItem, { state: 'error', result: m });
            // 标签通道：让角色自己开口解释（工具通道由模型读 role:'tool' 自行处理）
            if (ownTrace) await explainAgentFailure(m);
            return { ok: false, text: m };
        }
        const text = String(payload.text || '');
        updateTurnTool(traceItem, {
            state: 'ok',
            result: text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断）' : text,
        });
        if (ownTrace) insertAgentResult(text, { continueLoop: true, asContext: true });
        return { ok: true, text };
    } catch (err) {
        const reason = String((err && err.message) || err || '浏览器操作失败');
        updateTurnTool(traceItem, { state: 'error', result: reason });
        if (ownTrace) await explainAgentFailure(reason);
        return { ok: false, text: reason };
    }
}


