/* ============================================================================
 * 副屏监视窗（从 settings.js 拆出）
 *
 * 副屏画面刷新 / 自动轮询 / 启停与日志。依赖原生 ElainaDevice。
 * ========================================================================== */
"use strict";

// ==================== 副屏监视窗 ====================
// AI 用「模块」后端时在**独立虚拟副屏**上跑，物理主屏看不到；这个窗口把画面搬进应用。
// 不做成 iframe 套模块的 3070 网页面板：那等于把浏览器塞进应用，风格割裂，还有滚动/缩放两套坐标系。
const SCREEN_WATCH_INTERVAL = 1500;   // 自动刷新间隔（模块出帧约 18ms，1.5s 足够跟手）
let screenWatchTimer = null;
let screenWatchAuto = true;
let screenWatchBusy = false;
let screenWatchLogs = [];

function screenWatchEl(id) { return document.getElementById(id); }

// setStep 在 agentRuntime 的 IIFE 里够不到这个函数，挂到 window 供它回调
window.__screenWatchNote = (text) => screenWatchNote(text);

/** 记录一条"AI 最近动作"，显示在监视窗里 */
function screenWatchNote(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    screenWatchLogs.push(stamp + '  ' + t);
    if (screenWatchLogs.length > 40) screenWatchLogs = screenWatchLogs.slice(-40);
    const box = screenWatchEl('screenWatchLog');
    if (box) {
        box.innerHTML = screenWatchLogs.slice(-12).map((line) =>
            '<div>' + line.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>').join('');
        box.scrollTop = box.scrollHeight;
    }
}

/** 拉一帧副屏画面 + 状态 */
async function screenWatchRefresh() {
    if (screenWatchBusy) return;
    const plugin = deviceBridge();
    const img = screenWatchEl('screenWatchImg');
    const empty = screenWatchEl('screenWatchEmpty');
    const meta = screenWatchEl('screenWatchMeta');
    const dot = screenWatchEl('screenWatchDot');
    const powerBtn = screenWatchEl('screenWatchPowerBtn');
    if (!plugin || typeof plugin.liveFrame !== 'function') {
        if (meta) meta.textContent = '电脑版没有副屏';
        return;
    }
    screenWatchBusy = true;
    try {
        const res = await plugin.liveFrame();
        if (!res || !res.ok) {
            // 明确区分"没有画面"和"模块不可用" —— 前者要引导启动副屏，后者要引导刷模块
            if (res && res.reason === 'no-frame') {
                if (meta) meta.textContent = '副屏无画面';
                if (dot) dot.style.background = '#fbbf24';
                if (empty) empty.classList.remove('hidden');
                if (img) img.classList.add('hidden');
                const hint = screenWatchEl('screenWatchEmptyHint');
                if (hint) hint.textContent = '副屏是空的（只有壁纸）。让 AI 先执行一次「手机打开 某应用」。';
            } else {
                if (meta) meta.textContent = '模块不可用';
                if (dot) dot.style.background = '#f87171';
                if (empty) empty.classList.remove('hidden');
                if (img) img.classList.add('hidden');
                const hint = screenWatchEl('screenWatchEmptyHint');
                if (hint) hint.textContent = String(res && res.text || '没刷 KernelSU 模块，或 vd_server 没在跑。');
            }
            if (powerBtn) powerBtn.textContent = '启动副屏';
            return;
        }
        if (img && res.imageBase64) {
            img.src = 'data:' + (res.mime || 'image/jpeg') + ';base64,' + res.imageBase64;
            img.classList.remove('hidden');
            if (empty) empty.classList.add('hidden');
            // 模块的截图优先返回**缓存的帧**（换速度），刚启动应用时可能还是旧的黑帧。
            // 判断依据：JPEG 极小时基本就是纯色（黑屏副屏约 9KB，有内容时几十~几百KB）。
            // 这里不弹提示打断，只把状态文字改掉，1.5s 后的自动刷新通常会追上新画面。
            const tiny = (res.bytes || 0) < 20000;
            if (tiny && meta && String(res.status || '') === 'running') {
                meta.textContent = '运行中 · Display ' + res.displayId + ' · 画面更新中…';
            }
        }
        const running = String(res.status || '') === 'running';
        if (dot) dot.style.background = running ? '#34d399' : '#fbbf24';
        if (meta) {
            meta.textContent = running
                ? ('运行中 · Display ' + res.displayId + ' · ' + res.width + '×' + res.height)
                : '已休眠';
        }
        if (powerBtn) powerBtn.textContent = running ? '关闭副屏' : '启动副屏';
    } catch (e) {
        if (meta) meta.textContent = '读取失败';
    } finally {
        screenWatchBusy = false;
    }
}

function screenWatchStartAuto() {
    screenWatchStopAuto();
    if (!screenWatchAuto) return;
    screenWatchTimer = setInterval(() => { void screenWatchRefresh(); }, SCREEN_WATCH_INTERVAL);
}
function screenWatchStopAuto() {
    if (screenWatchTimer) { clearInterval(screenWatchTimer); screenWatchTimer = null; }
}

function openScreenWatch() {
    const panel = screenWatchEl('screenWatchPanel');
    if (!panel) return;
    // 监视窗与设置面板同为 100002 层（见 CSS 里的分层说明）。两者若同时开着，
    // 谁在上面就由 DOM 顺序决定 —— 那正是注释里说要避免的事。
    // 所以打开监视窗前先把设置关掉 —— 否则两层的先后就落在 DOM 顺序上，
    // 变成"有时监视窗在下层"的不可控行为。
    if (typeof closeSettingsPanel === 'function') closeSettingsPanel();
    panel.classList.remove('hidden');
    panel.classList.add('flex');
    void screenWatchRefresh();
    screenWatchStartAuto();
}
function closeScreenWatch() {
    const panel = screenWatchEl('screenWatchPanel');
    if (panel) { panel.classList.add('hidden'); panel.classList.remove('flex'); }
    screenWatchStopAuto();
}




