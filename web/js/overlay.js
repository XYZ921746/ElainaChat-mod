/* ============================================================================
 * 操作悬浮窗（从 settings.js 拆分）
 *
 * 悬浮窗状态刷新与跳系统设置授权。
 * ========================================================================== */
'use strict';

// ==================== 操作悬浮窗（APK 独有） ====================
// AI 操作的是别的应用：没有悬浮窗时每步确认都要切回本应用，而切回来会把目标应用退到后台，那一步就可能失败
//   → AI 重试 → 看起来像卡住。悬浮窗浮在目标应用之上，就是打破这个循环的唯一办法。
// 它是 Android 的**特殊权限**（「显示在其他应用上层」），只能由用户在系统设置里手动打开 ——
//   应用无法弹运行时权限框索取，所以这里只能「跳过去 + 回来复检」。
async function refreshOverlayStatus() {
    const dot = document.getElementById('overlayStatusDot');
    const text = document.getElementById('overlayStatusText');
    const btn = document.getElementById('overlayEnableBtn');
    const wrap = document.getElementById('overlayStatusDot')?.closest('div')?.parentElement;
    if (!text) return;

    const plugin = deviceBridge();
    // 网页版没有原生层：整块隐藏（在那个环境里这个设置本来就不适用）
    if (!plugin || typeof plugin.overlayStatus !== 'function') {
        if (wrap) wrap.classList.add('hidden');
        return;
    }
    if (wrap) wrap.classList.remove('hidden');
    try {
        const res = await plugin.overlayStatus();
        const ok = Boolean(res && res.canDraw);
        if (dot) dot.className = 'w-2 h-2 rounded-full flex-none ' + (ok ? 'bg-emerald-400' : 'bg-amber-400');
        text.textContent = ok ? '已开启' : '未开启（AI 操作时会提示你开）';
        if (btn) btn.textContent = ok ? '去系统设置检查' : '开启悬浮窗';
    } catch (e) {
        text.textContent = '检测失败';
    }
}

/**
 * 跳到系统设置里的「显示在其他应用上层」，让用户开启悬浮窗权限。
 *
 * @param opts.quiet 静默模式：不弹"已打开系统设置"的说明框。
 *   AI 操作流程里要用它 —— 那时用户正要去看 AI 做了什么，
 *   再叠一个说明框会挡住视线（而且他刚从确认框点过来的，已经知道自己在干什么）。
 */
async function enableOverlay(opts) {
    const quiet = Boolean(opts && opts.quiet);
    const plugin = deviceBridge();
    if (!plugin || typeof plugin.requestOverlay !== 'function') {
        showCustomAlert('当前环境没有原生设备层（电脑版没有这个功能）。', '操作悬浮窗');
        return;
    }
    try {
        await plugin.requestOverlay();
        if (quiet) return;
        // 跳到系统设置后用户会切走再回来 —— 这时 fillSettingsForm 会重新跑一次，
        // 但用户也可能直接返回而没触发刷新，所以下面给一句明确的手动提示。
        showCustomAlert(
            '已打开系统设置。\n\n'
            + '请找到并打开「显示在其他应用上层」/「悬浮窗」权限，然后返回本应用。\n\n'
            + '回来后在设置里点「重新检测」确认状态变成「已开启」。',
            '操作悬浮窗');
    } catch (e) {
        showCustomAlert('打开系统设置失败：' + (e.message || e), '操作悬浮窗');
    }
}



