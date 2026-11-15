// AI Agent 运行时：运行状态 / 停止 / 授权弹窗 / 悬浮窗 / 过程行。
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

    // 系统悬浮窗（APK 独有）：常驻「停止」，需确认时出现「允许 / 拒绝」；AI 操作的是别的 App，用户切回来会把目标 App 切到后台。
    let overlayListenerReady = false;
    let overlayApprovalPending = null;   // 等待浮层回应的 resolve 函数
    // 系统悬浮条正在用：应用内状态条让位。两条进度同时挂在屏幕上，用户会以为有两个任务在跑；
    // 悬浮条浮在所有应用之上（包括本应用），只留它一条就够。没权限 / 网页版时回落应用内状态条。
    let overlayActive = false;
    const stopWaiters = new Set();       // 等待"被停止"的在途请求（模型调用靠它提前醒）
    let generation = 0;                  // 运行代号：停止 / 新一批会递增，迟到的旧请求据此作废

    const barEl = () => document.getElementById('agentRunBar');
    const textEl = () => document.getElementById('agentRunText');
    const stepEl = () => document.getElementById('agentRunStep');
    const stopBtnEl = () => document.getElementById('agentStopBtn');

    function render() {
        const b = barEl();
        if (!b) return;
        const showBar = running && !overlayActive;
        b.classList.toggle('hidden', !showBar);
        b.classList.toggle('flex', showBar);
        b.classList.toggle('is-stopping', stopRequested);
        const t = textEl();
        if (t) t.textContent = stopRequested ? '正在停止' : (currentAction ? 'AI 正在操作' : 'AI 正在思考');
        const s = stepEl();
        if (s) s.textContent = running ? ('第 ' + step + ' 步' + (currentAction ? ' · ' + currentAction : '')) : '';
        const btn = stopBtnEl();
        if (btn) { btn.disabled = stopRequested; btn.textContent = stopRequested ? '停止中' : '停止'; }
        const watch = document.getElementById('agentWatchBtn');
        if (watch) {
            const mode = (typeof runModeDecision === 'string') ? runModeDecision : '';
            const used = String(window.__lastAgentBackend || '');
            const fallbackDefault = (typeof currentBackendId === 'function') ? currentBackendId() : '';
            const effective = (mode === 'module' || mode === 'accessibility')
                ? mode
                : (used || fallbackDefault);
            watch.classList.toggle('hidden', !(running && effective === 'module'));
        }
    }

    function beginBatch() {
        halted = false;
        stopRequested = false;      // 新的用户请求 = 新的一批：停止状态到这里才解除
        // 新一批也可能和上一轮迟到的请求重叠：递增代号，让那些旧回复自己作废。
        generation += 1;
    }

    function beginRun() {
        running = true;
        // 停止是整批粘性的：在同一批里重新拉起运行态（迟到的步骤）不能把停止标志清掉，
        // 否则「刚点完停止又自己跑起来」。
        if (!halted) stopRequested = false;
        stopReason = '';
        step = 0;
        currentAction = '';
        render();
    }

    function endRun() {
        running = false;
        // 同理：已停止的批次里，收尾不能顺带解禁后续步骤（stopRequested 留给 beginBatch 清）。
        if (!halted) stopRequested = false;
        aborters.clear();
        currentAction = '';
        render();
    }

    function requestStop(reason) {
        if (!running || stopRequested) return false;
        stopRequested = true;
        halted = true;              // 粘性：本批次后续动作一律拒绝，避免停止后又自己重启
        stopReason = String(reason || '用户停止');
        generation += 1;            // 在途请求回来时不再被当成本轮的下一步
        for (const c of aborters) { try { c.abort(); } catch (e) { /* 忽略 */ } }
        aborters.clear();
        // 唤醒还在等模型 / 等设备的步骤：光置标志时，它们要等请求自己返回（最长三分钟）才醒 ——
        // 用户看到的就是「点了停止，界面一直停在停止中」。
        const waiters = Array.from(stopWaiters);
        stopWaiters.clear();
        for (const wake of waiters) { try { wake('stopped'); } catch (e) { /* 忽略 */ } }
        // 关掉正在等待的确认弹窗（按「拒绝」处理）：两条路都要关，只关应用内弹窗会让悬浮窗那条 await 永远挂住。
        if (approvalOpen) {
            try { elements.customModalCancelBtn?.click(); } catch (e) { /* 忽略 */ }
            const pending = overlayApprovalPending;
            overlayApprovalPending = null;
            if (pending) pending(false);
        }
        settleStoppedRun();
        return true;
    }

    /** 停止的界面收尾：状态条与悬浮条立刻收起，但 stopRequested / halted 保持为真 ——
     *  在途步骤回来时 assertNotStopped() 仍要拦住它们，等下一批 beginBatch 才解除。 */
    function settleStoppedRun() {
        running = false;
        currentAction = '';
        hideOverlay();
        render();
    }

    /** 等"用户按停止"的 Promise：模型调用可以和它赛跑，先醒的那个说了算。 */
    function waitStopped() {
        let settle = null;
        const promise = new Promise((resolve) => { settle = resolve; stopWaiters.add(resolve); });
        return {
            promise,
            isStopped: () => stopRequested || halted,
            cancel: () => { if (settle) stopWaiters.delete(settle); },
        };
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

    // 敏感操作授权：手机操作由 phoneTierAllows 放行；电脑命令 strict 每条都问、auto 只问危险命令、full 不问；forceAsk 无视档位。文件写入/覆盖/删除由服务端 needOverwrite / needDelete 触发。
    async function requestApproval(action, detail, opts = {}) {
        const risk = riskOf(action);
        if (risk === 'safe') return true;
        if (stopRequested || halted) return false;

        const access = currentAgentAccess();
        const mustAsk = opts.forceAsk === true;

        const isPhone = String(action || '').startsWith('手机');
        if (isPhone && !mustAsk) {
            if (phoneTierAllows(action)) return true;
        } else if (!mustAsk) {
            if (access === 'full') return true;
            if (access === 'auto' && risk !== 'dangerous') return true;
        }

        const askRisk = mustAsk ? 'dangerous' : risk;
        const lines = ['AI 想执行：' + action];
        if (detail) lines.push('', detail);
        lines.push('', askRisk === 'dangerous'
            ? '这是可以执行任意系统命令的操作，风险很高，请确认你信任当前对话里出现的内容。'
            : '该操作会改变电脑或手机的状态。拒绝后 AI 会收到通知并尝试别的方式，不会卡住。');

        // 优先走系统悬浮窗确认（应用内弹窗要用户切回来，会把目标 App 切到后台）；浮层不可用时回退应用内弹窗，不能静默拒绝（那会让功能看起来"坏了"）。
        approvalOpen = true;
        let ok = false;
        try {
            ok = await requestApprovalViaOverlay(action, detail);
        } catch (e) { ok = false; }
        if (ok === null) {
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

    // 通过系统悬浮窗请求确认：返回 null = 浮层不可用，调用方回退应用内弹窗。
    function requestApprovalViaOverlay(action, detail) {
        const plugin = deviceBridge();
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
            overlayApprovalPending = finish;

            plugin.askOverlayApproval({ action: detail ? (action + ' —— ' + detail) : action })
                .then((res) => {
                    if (res && res.fallback) finish(null);      // 浮层不在 → 回退
                    else if (res && res.ok === false) finish(null);
                    })
                .catch(() => finish(null));
        });
    }

    function setStep(n, action) {
        step = Number(n) || 0;
        currentAction = String(action || '');
        render();
        updateOverlayStep();
        if (typeof window.__screenWatchNote === 'function') {
            window.__screenWatchNote(action);
        }
    }

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

        plugin.addListener('overlayStop', () => {
            const stopped = requestStop('用户在悬浮窗上点了停止');
            // 必须把"正在等确认"的 Promise 也了结掉，否则用户点停止时 requestApproval 会永远 await 下去。
            const pending = overlayApprovalPending;
            overlayApprovalPending = null;
            if (pending) pending(false);
            // 悬浮条上的停止是用户唯一能看到的反馈：停止后回到应用要有记录，
            // 否则这次中止在对话里毫无痕迹，用户会以为任务还在跑。
            if (stopped && typeof insertAgentResult === 'function') {
                insertAgentResult('已停止：你在悬浮窗上点了停止，后续动作没有执行。如需继续，请重新告诉 AI 要做什么，或让它先说明刚才做到哪一步。');
            }
        });

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
        // show 是异步的：先按"浮层会用"收起应用内状态条，等它回来再收会闪一下两条同时在场。
        // 拿不到权限 / 加窗失败时下面会把它收回 false，应用内状态条成为唯一入口。
        overlayActive = true;
        render();
        try {
            const res = await plugin.showOverlay({ text: text || 'AI 正在操作手机' });
            if (res && res.needPermission) {
                overlayActive = false;
                render();
                return 'need-permission';
            }
            overlayActive = Boolean(res && res.ok);
            render();
            return overlayActive;
        } catch (e) {
            overlayActive = false;
            render();
            return false;
        }
    }

    /** 查悬浮窗权限：'ok' | 'need-permission' | 'unavailable'（网页版没有原生层）。
     *  只查不显示 —— 权限提示要趁用户还在应用里时弹，悬浮条则等他真切走才出现。 */
    async function checkOverlayPermission() {
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.overlayStatus !== 'function') return 'unavailable';
        try {
            const res = await plugin.overlayStatus();
            return (res && res.canDraw) ? 'ok' : 'need-permission';
        } catch (e) {
            return 'unavailable';
        }
    }

    /** 悬浮条只在 AI 把界面切走时出现：应用内已经有状态条和停止按钮，
     *  再浮一条只是重复；切到别的应用时状态条看不见了，才需要它兜住"随时能停"。
     *  应用回到前台就收起浮层、把应用内状态条还回去。 */
    function syncOverlayWithVisibility() {
        if (!running) {
            hideOverlay();
            return;
        }
        const hidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden');
        if (hidden) {
            void showOverlay(stopRequested ? '正在停止…' : 'AI 正在操作手机');
        } else {
            hideOverlay();
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

    // 浮层副标题统一由 setStep → updateOverlayStep 驱动，不另开"直接写文案"的入口（两处写同一行只会互相覆盖）。
    function hideOverlay() {
        overlayActive = false;
        const plugin = nativeBridge();
        if (plugin && typeof plugin.hideOverlay === 'function') {
            try { void plugin.hideOverlay(); } catch (e) { /* 忽略 */ }
        }
        render();
    }

    return {
        beginBatch, beginRun, endRun, requestStop, settleStoppedRun, assertNotStopped, track, requestApproval, setStep, render,
        isRunning: () => running,
        isStopRequested: () => stopRequested,
        isHalted: () => halted,
        getStep: () => step,
        riskOf,
        showOverlay,
        hideOverlay,
        ensureOverlayListener,
        checkOverlayPermission,
        syncOverlayWithVisibility,
        waitStopped,
        getGeneration: () => generation,
        bumpGeneration: () => { generation += 1; }
    };
})();

window.agentRuntime = agentRuntime;

// 应用切到后台 / 回到前台时切换「应用内状态条 ↔ 系统悬浮条」：
// 在应用里用状态条（离停止按钮最近），AI 操作别的应用时才浮一条出来。
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
        try { agentRuntime.syncOverlayWithVisibility(); } catch (e) { /* 忽略 */ }
    });
}

document.getElementById('agentStopBtn')?.addEventListener('click', () => {
    if (agentRuntime.requestStop('用户点了停止')) {
        // 停止后收起悬浮窗，否则它会一直挂在屏幕上，用户以为还在跑
        if (agentRuntime.hideOverlay) agentRuntime.hideOverlay();
        insertAgentResult('已停止：用户手动中止了 AI 的手机操作，后续动作没有执行。如需继续，请重新告诉 AI 要做什么，或让它先说明刚才做到哪一步。');
    }
});



