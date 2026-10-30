/* ============================================================================
 * AI 用浏览器（从 agent.js 拆出）
 *
 * 打开网页 / 看页面 / 点击 / 填写 / 回车 / 关闭；请求由服务端 /api/agent/browser 执行。
 * 依赖 agent.js 的运行时与结果回灌函数（运行时才调用）。
 * ========================================================================== */
'use strict';

// ===== AI 用浏览器：打开网页、看页面、点按钮、填表单 =====
// 与「电脑命令」的分工（用户要的就是这个区别）：命令通道是**文本进、文本出**，
//   AI 看不到页面，只能靠 curl 猜，遇到要登录 / 要 JS 渲染 / 要点开菜单的站点就无能为力。
//   这条通道是**看页面 → 决定 → 真点一下**。
// 为什么请求落在服务端（/api/agent/browser）而不是前端：
//   · 浏览器进程由服务端起，页面在服务端那台机器上 —— 前端只负责传指令；
//   · 调试端口能读全部 cookie，这个能力必须只对本机开放（见 serve.mjs 的 browserDenyReason）。
//     放在前端就等于把它交给任何一个能打开页面的人。



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



/**
 * 执行一次浏览器操作，并把结果按**当前通道**送达。
 *
 * 两条通道的送达方式必须分开（与 doAgentFile / doAgentCommand 同一条理由）：
 *   · 工具通道 —— runToolCalls 会把返回值以 role:'tool' 回灌，这里再插消息就是同一件事说两遍；
 *   · 标签通道 —— 没有外层调用者，结果只能自己放进对话，并排下一次续跑。
 *
 * 失败一律返回 {ok:false,text}，让模型自己看到原因（网址不合法、页面变了、没装浏览器），
 *   而不是抛异常变成一句"操作失败"—— 它需要那句话才能换个做法。
 */
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
    // 注册表的 available() 只影响**工具清单**，标签通道仍可能直接派发到这里 ——
    //   所以开关要在执行器里再判一次，否则"关掉浏览器"之后写标签仍然能开出来。
    if (state.settings.agentBrowserEnabled !== true) {
        const m = '浏览器功能没有打开。需要的话请在「设置 → 能力 → 浏览器」里打开「允许 AI 用浏览器」。';
        updateTurnTool(traceItem, { state: 'stopped', result: m });
        return { ok: false, text: m };
    }
    // 打开浏览器会在这台电脑上**弹出一个窗口** —— 那是用户看得见的状态变化，
    //   所以 strict 档问一次。之后的导航与点击发生在这个已经批准的窗口里，不再逐条打扰。
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


