/* ============================================================================
 * 访问密码 / 浏览器状态（从 settings.js 拆出）
 *
 * 局域网鉴权状态、修改密码、浏览器连接状态与手机分区显隐。
 * ========================================================================== */
"use strict";

// ==================== 访问密码（局域网鉴权） ====================
// 本机（127.0.0.1）是管理员：未设置密码时免密；设置后本机也要先登录才能修改密码。
async function refreshAuthStatus() {
    const box = document.getElementById('authStatusBox');
    if (!box) return;
    try {
        const res = await fetch('/api/auth/status');
        if (!res.ok) { box.textContent = '无法获取鉴权状态（HTTP ' + res.status + '）'; return; }
        const json = await res.json();
        if (!json.ok) { box.textContent = '无法获取鉴权状态'; return; }
        if (json.isAdmin) {
            box.innerHTML = json.isDefaultPassword
                ? '当前是本机。<b>尚未设置访问密码</b>：此时只有本机能用，局域网接口是关闭的；请在下方设置一个密码。'
                : '当前是本机管理员（已登录）。访问密码已设置：本机与局域网设备打开应用都需要输入这个密码。';
        } else {
            box.textContent = '当前设备已登录（非本机）。如需修改访问密码，请在这台电脑上打开本应用操作。';
        }
    } catch (e) {
        // 安卓 App（Capacitor 本地文件）没有本地服务，此功能不适用
        box.textContent = '当前环境没有本地服务（如安卓 App），访问密码功能不适用。';
    }
}

async function changeAccessPassword() {
    // 重置密码要删的文件路径从服务端取（DATA_DIR 可能被覆盖，不能写死 data/auth.json）。
    let authFile = '';
    try {
        const st = await fetch('/api/auth/status').then((r) => r.json());
        authFile = st && st.authFile ? String(st.authFile) : '';
    } catch (e) { /* 拿不到就用通用说法 */ }
    const a = document.getElementById('authNewPwd');
    const b = document.getElementById('authNewPwd2');
    const next = (a && a.value ? a.value : '').trim();
    const again = (b && b.value ? b.value : '').trim();
    if (next.length < 8) { showCustomAlert('新密码至少 8 位，且要同时含数字、小写字母、大写字母。', '访问密码'); return; }
    if (next !== again) { showCustomAlert('两次输入的密码不一致，请重新输入。', '访问密码'); return; }
    try {
        const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ next })
        });
        const json = await res.json();
        if (!json.ok) { showCustomAlert(json.message || '修改失败', '访问密码'); return; }
        if (a) a.value = '';
        if (b) b.value = '';
        await showCustomAlert('访问密码已设置。\n\n从现在起，本机与局域网设备打开应用都需要输入这个密码。\n请记牢；忘记时删除 ' + (authFile || '数据目录下的 auth.json') + ' 并重启应用即可重置。', '访问密码');
        location.href = '/login';
    } catch (e) {
        showCustomAlert('修改失败：' + (e.message || e), '访问密码');
    }
}

// 「电脑操作权限」与「手机操作」两组设置按设备形态只显示一组：
// 电脑上给「允许操作电脑」，手机上给「手机操作」—— 混在一起用户看不懂。
// 用 IS_MOBILE_DEVICE（设备本身）而不是窗口宽度，电脑上把窗口拖窄不该变成"手机"。
/**
 * 刷新「浏览器」那一块的现状说明（装没装浏览器 / 现在开着吗）。
 *
 * 为什么要问服务端而不是前端自己判断：浏览器进程是**服务端**起的，
 *   前端无从知道它是否在跑；而"试探性地拉一次"会真的把浏览器打开。
 *   所以走一个只读的 /api/agent/browser/status。
 */
async function refreshBrowserStatus() {
    const box = document.getElementById('settingBrowserStatus');
    if (!box) return;
    if (typeof IS_NATIVE_APP !== 'undefined' && IS_NATIVE_APP) {
        box.textContent = '手机版没有本机服务端，用不了浏览器功能。';
        return;
    }
    box.textContent = '检测中…';
    try {
        const res = await fetch('/api/agent/browser/status?access=' + encodeURIComponent(currentAgentAccess()));
        const data = await res.json();
        if (!data.ok) { box.textContent = String(data.message || '检测失败'); return; }
        if (!data.available) {
            box.textContent = '这台电脑上没找到 Chrome / Edge —— 装一个才能用（也可以用环境变量 ELAINA_BROWSER 指定路径）。';
            return;
        }
        const name = String(data.executable || '').split(/[\\/]/).pop() || '浏览器';
        box.textContent = '已找到 ' + name + '。' + (data.running ? '现在开着（空闲几分钟后会自动关闭）。' : '现在没开，用到时才启动。');
    } catch (e) {
        box.textContent = '检测失败：' + String((e && e.message) || e);
    }
}

function syncAgentSectionsByDevice() {
    const pcSection = document.getElementById('agentPermissionSection');
    const phoneSection = document.getElementById('agentPhoneSection');
    if (pcSection) pcSection.classList.toggle('hidden', IS_MOBILE_DEVICE);
    if (phoneSection) phoneSection.classList.toggle('hidden', !IS_MOBILE_DEVICE);
}

