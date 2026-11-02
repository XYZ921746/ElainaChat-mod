/* ============================================================================
 * AI Agent 运行时（从 agent.js 拆出）
 *
 * 运行状态 / 停止 / 授权弹窗 / 悬浮窗 / 过程行 / run / endRun。
 * 依赖 agent.js 的 AGENT_RISK 与权限档位（已在之前加载）。
 * ========================================================================== */
'use strict';

const agentRuntime = (function () {
    let running = false;
    let stopRequested = false;
    let halted = false;          // 本批次已被用户停止：拒绝后续动作，直到下一批开始
    let stopReason = '';
    let step = 0;
    let currentAction = '';
    const approvedThisRun = new Set();   // 本次运行内已授权的动作
    const aborters = new Set();          // 在途请求的 AbortController
    let approvalOpen = false;

    // ---- 系统悬浮窗（APK 独有）----
    // 浮层上常驻「停止」，需要确认时出现「允许 / 拒绝」。
    // 它的价值在于：AI 操作的是**别的 App**，用户不用切回 ElainaChat 就能操作 ——
    // 切回来会把目标 App 切到后台，那次操作就失败了（死循环的根源）。
    let overlayListenerReady = false;
    let overlayApprovalPending = null;   // 等待浮层回应的 resolve 函数

    const barEl = () => document.getElementById('agentRunBar');
    const textEl = () => document.getElementById('agentRunText');
    const stepEl = () => document.getElementById('agentRunStep');
    const stopBtnEl = () => document.getElementById('agentStopBtn');

    function render() {
        const b = barEl();
        if (!b) return;
        b.classList.toggle('hidden', !running);
        b.classList.toggle('flex', running);
        b.classList.toggle('is-stopping', stopRequested);
        const t = textEl();
        if (t) t.textContent = stopRequested ? '正在停止' : (currentAction ? 'AI 正在操作' : 'AI 正在思考');
        const s = stepEl();
        if (s) s.textContent = running ? ('第 ' + step + ' 步' + (currentAction ? ' · ' + currentAction : '')) : '';
        const btn = stopBtnEl();
        if (btn) { btn.disabled = stopRequested; btn.textContent = stopRequested ? '停止中' : '停止'; }
        // 「看画面」只在**这一轮真的在走模块后端**时出现（只有独立副屏才有「画面」可看）。
        // 判据优先级：本轮的选择 > 实际用过的 > 设置里的默认 —— 三者都不能单独用：
        //   currentBackendId() 是持久化的默认，用户在弹窗里临时选前台后它照样是 module；
        //   __lastAgentBackend 可能为空或带着上一轮的值。只看后两者会一律往「显示模块」的方向错判。
        const watch = document.getElementById('agentWatchBtn');
        if (watch) {
            // runModeDecision / lastUsedBackendId 都是本文件顶层变量（IIFE 外），
            // 这里直接闭包读取；用 typeof 兜住"还没轮到那段代码执行"的极早期调用。
            const mode = (typeof runModeDecision === 'string') ? runModeDecision : '';
            const used = String(window.__lastAgentBackend || '');
            const fallbackDefault = (typeof currentBackendId === 'function') ? currentBackendId() : '';
            // '' = 本轮还没问过（只有一条路可用，不弹窗）→ 才回落到实际/默认
            const effective = (mode === 'module' || mode === 'accessibility')
                ? mode
                : (used || fallbackDefault);
            watch.classList.toggle('hidden', !(running && effective === 'module'));
        }
    }

    /**
     * 每条 AI 回复的处理入口调用一次：开启新批次，解除上一批留下的停止状态。
     *
     * 三档模型下这里**不清 approvedThisRun** —— 因为 strict 档的语义就是
     *   "**每一条**都要确认"，不存在"本批次已授权过就跳过"的豁免。
     */
    function beginBatch() {
        halted = false;
    }

    function beginRun() {
        running = true;
        stopRequested = false;
        stopReason = '';
        step = 0;
        currentAction = '';
        render();
    }

    function endRun() {
        running = false;
        stopRequested = false;
        aborters.clear();
        currentAction = '';
        render();
    }

    function requestStop(reason) {
        if (!running || stopRequested) return false;
        stopRequested = true;
        halted = true;              // 粘性：本批次后续动作一律拒绝，避免停止后又自己重启
        stopReason = String(reason || '用户停止');
        for (const c of aborters) { try { c.abort(); } catch (e) { /* 忽略 */ } }
        aborters.clear();
        // 关掉正在等待的确认弹窗（按「拒绝」处理）
        if (approvalOpen) {
            // 应用内弹窗这条路：点它的「取消」
            try { elements.customModalCancelBtn?.click(); } catch (e) { /* 忽略 */ }
            // 悬浮窗这条路：把它等着的那个 Promise 了结掉。
            // 两条路都要关 —— 只关其中一条会让另一种情况下的 await 永远挂住。
            const pending = overlayApprovalPending;
            overlayApprovalPending = null;
            if (pending) pending(false);
        }
        render();
        return true;
    }

    function assertNotStopped() {
        if (!stopRequested) return;
        const err = new Error(stopReason || '已停止');
        err.agentAborted = true;
        throw err;
    }

    /** 把在途请求的 controller 交给运行时，停止时统一中断 */
    function track(controller) {
        if (controller && typeof controller.abort === 'function') aborters.add(controller);
        return controller;
    }

    function riskOf(action) { return AGENT_RISK[action] || 'sensitive'; }

    /**
 * 敏感操作授权。返回 true 表示可以执行。
 *
 * 三档模型下的判据：
 *   · 手机操作 → 由 phoneTierAllows 决定，**基本全部放行**，
 *                唯一例外是「手机命令」（模块后端下等于 root shell）。
 *   · 电脑命令 → strict 档每条都问；auto 档只问危险命令；full 档不问。
 *   · 文件写入/覆盖/删除 → 由**服务端**回 needOverwrite / needDelete 触发，
 *                          不走这里（那三个闸门按档位在服务端判）。
 *
 * @param {string} action 操作名（决定风险级别）
 * @param {string} detail 给用户看的具体内容
 * @param {object} [opts] { forceAsk: true } —— 无视档位，这一条必须问
 */
    async function requestApproval(action, detail, opts = {}) {
        const risk = riskOf(action);
        if (risk === 'safe') return true;
        if (stopRequested) return false;

        const access = currentAgentAccess();
        const mustAsk = opts.forceAsk === true;

        // 手机操作：按 phoneTierAllows 放行（除「手机命令」外全放行）
        const isPhone = String(action || '').startsWith('手机');
        if (isPhone && !mustAsk) {
            if (phoneTierAllows(action)) return true;
            // 落到下面走确认 UI（只有「手机命令」会到这里）
        } else if (!mustAsk) {
            // 电脑命令：strict 每条都问；auto 只问危险的（由服务端 needApproval 驱动，
            // 调用方带 forceAsk）；full 不问。
            if (access === 'full') return true;
            if (access === 'auto' && risk !== 'dangerous') return true;
            // strict → 继续往下走确认 UI
        }

        const askRisk = mustAsk ? 'dangerous' : risk;
        const lines = ['AI 想执行：' + action];
        if (detail) lines.push('', detail);
        lines.push('', askRisk === 'dangerous'
            ? '这是可以执行任意系统命令的操作，风险很高，请确认你信任当前对话里出现的内容。'
            : '该操作会改变电脑或手机的状态。拒绝后 AI 会收到通知并尝试别的方式，不会卡住。');

        // 优先走**系统悬浮窗**确认。
        // 为什么：AI 操作的是别的 App，而应用内弹窗要用户切回 ElainaChat 才看得到 ——
        // 切回来这一步会把目标 App 切到后台，那次操作就落到错的位置或直接失败，
        // AI 重试又弹窗，形成死循环。悬浮窗浮在目标 App 之上，用户不离开当前界面
        // 就能点「允许 / 拒绝」。
        // 悬浮窗不可用（没授权 / 没显示）时**回退到应用内弹窗** ——
        // 不能因为浮层不可用就静默拒绝，那会让功能看起来"坏了"。
        approvalOpen = true;
        let ok = false;
        try {
            ok = await requestApprovalViaOverlay(action, detail);
        } catch (e) { ok = false; }
        if (ok === null) {
            // 悬浮窗这条路走不通 → 应用内弹窗
            try {
                ok = await showCustomModal({
                    title: askRisk === 'dangerous' ? '危险操作确认' : '敏感操作确认',
                    message: lines.join('\n'),
                    confirmText: '允许这次',
                    cancelText: '拒绝'
                });
            } catch (e) { ok = false; }
        }
        approvalOpen = false;
        if (!ok) return false;
        approvedThisRun.add(action);
        return !stopRequested;   // 用户可能在弹窗期间点了停止
    }

    /**
     * 通过系统悬浮窗请求确认。
     *
     * @returns true/false = 用户在浮层上做出了选择；**null = 浮层不可用，调用方应回退到应用内弹窗**
     */
    function requestApprovalViaOverlay(action, detail) {
        const plugin = deviceBridge();
        // 只有安卓版、且原生层提供了这个方法、且浮层正在显示时才走这条路
        if (!plugin || typeof plugin.askOverlayApproval !== 'function') return Promise.resolve(null);
        if (!overlayListenerReady) return Promise.resolve(null);

        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                overlayApprovalPending = null;
                resolve(value);
            };
            // 与"停止"竞争：用户可能在浮层上直接点停止而不是允许/拒绝
            overlayApprovalPending = finish;

            plugin.askOverlayApproval({ action: detail ? (action + ' —— ' + detail) : action })
                .then((res) => {
                    if (res && res.fallback) finish(null);      // 浮层不在 → 回退
                    else if (res && res.ok === false) finish(null);
                    // ok=true 时等原生发 overlayApproval 事件
                })
                .catch(() => finish(null));
        });
    }

    function setStep(n, action) {
        step = Number(n) || 0;
        currentAction = String(action || '');
        render();
        // 同步到系统悬浮窗：用户切到别的 App 时，这里是他唯一能看到进度的位置
        updateOverlayStep();
        // 记进副屏监视窗的「最近动作」（setStep 在 IIFE 里，用 window 上的钩子跨作用域）
        if (typeof window.__screenWatchNote === 'function') {
            window.__screenWatchNote(action);
        }
    }


    // ==================== 系统悬浮窗的生命周期 ====================

    /** 取原生设备层。与外面那个 deviceBridge 同样的逻辑，这里内联一份避免依赖定义顺序 */
    function nativeBridge() {
        if (window.ElainaDevice) return window.ElainaDevice;
        const p = window.Capacitor?.Plugins?.ElainaDevice;
        if (p) { window.ElainaDevice = p; return p; }
        return null;
    }

    /** 挂一次原生事件监听（悬浮窗上的「停止」「允许/拒绝」由它送进来） */
    function ensureOverlayListener() {
        if (overlayListenerReady) return;
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.addListener !== 'function') return;
        overlayListenerReady = true;

        // 用户在浮层上点了「停止」→ 等同于点了应用内的停止
        plugin.addListener('overlayStop', () => {
            requestStop('用户在悬浮窗上点了停止');
            // 必须把"正在等确认"的那个 Promise 也了结掉。
            // 否则用户点停止（而不是允许/拒绝）时，requestApproval 会永远 await 下去 ——
            // 表现是"点了停止没反应"，而这正是用户最需要它立刻停的时刻。
            const pending = overlayApprovalPending;
            overlayApprovalPending = null;
            if (pending) pending(false);
        });

        // 用户在浮层上点了「允许 / 拒绝」
        plugin.addListener('overlayApproval', (data) => {
            const pending = overlayApprovalPending;
            overlayApprovalPending = null;
            if (pending) pending(Boolean(data && data.allowed));
        });
    }

    /** AI 开始操作手机时显示浮层。没有权限时返回 false（调用方会引导用户去开）。 */
    async function showOverlay(text) {
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.showOverlay !== 'function') return false;
        ensureOverlayListener();
        try {
            const res = await plugin.showOverlay({ text: text || 'AI 正在操作手机' });
            if (res && res.needPermission) return 'need-permission';
            return Boolean(res && res.ok);
        } catch (e) {
            return false;
        }
    }

    function updateOverlayStep() {
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.updateOverlay !== 'function') return;
        const label = stopRequested
            ? '正在停止…'
            : ('第 ' + step + ' 步' + (currentAction ? ' · ' + currentAction : ''));
        try { void plugin.updateOverlay({ text: label }); } catch (e) { /* 浮层没了就忽略 */ }
    }

    // 浮层的副标题统一由 setStep → updateOverlayStep 驱动。
    // 不为它另开一个"直接写文案"的入口：两处写同一行字只会互相覆盖
    // （续跑时先写"正在思考下一步…"，紧接着 setStep 又把它盖成"第 N 步 · …"）。
    function hideOverlay() {
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.hideOverlay !== 'function') return;
        try { void plugin.hideOverlay(); } catch (e) { /* 忽略 */ }
    }

    return {
        beginBatch, beginRun, endRun, requestStop, assertNotStopped, track, requestApproval, setStep, render,
        isRunning: () => running,
        isStopRequested: () => stopRequested,
        isHalted: () => halted,
        getStep: () => step,
        riskOf,
        // 悬浮窗
        showOverlay,
        hideOverlay,
        ensureOverlayListener
    };
})();

window.agentRuntime = agentRuntime;

document.getElementById('agentStopBtn')?.addEventListener('click', () => {
    if (agentRuntime.requestStop('用户点了停止')) {
        // 停止后收起悬浮窗（否则它会一直挂在屏幕上，用户以为还在跑）
        if (agentRuntime.hideOverlay) agentRuntime.hideOverlay();
        insertAgentResult('已停止：用户手动中止了 AI 的手机操作，后续动作没有执行。如需继续，请重新告诉 AI 要做什么，或让它先说明刚才做到哪一步。');
    }
});



