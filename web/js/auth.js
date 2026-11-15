// 访问密码 / 浏览器状态：局域网鉴权状态、修改密码、浏览器连接状态与手机分区显隐。
"use strict";

// 无密码态没有登录页：应用直接可用，端口的可达范围由 data/config.json 的 host 决定；
// 设置密码后所有设备（含本机）都要先登录才能修改密码。
async function refreshAuthStatus() {
    const box = document.getElementById('authStatusBox');
    if (!box) return;
    try {
        const res = await fetch('/api/auth/status');
        if (!res.ok) { box.textContent = '无法获取鉴权状态（HTTP ' + res.status + '）'; return; }
        const json = await res.json();
        if (!json.ok) { box.textContent = '无法获取鉴权状态'; return; }
        const managed = Boolean(json.passwordManagedByConfig);
        if (json.isAdmin) {
            // 改密会把新密码写进 data/config.json，所以 managed 时输入框必须保持可用：
            // 禁用的话用户改一次密就再也改不了第二次。
            box.innerHTML = managed
                ? '当前是本机管理员。访问密码保存在 <code>data/config.json</code> 的 <code>password</code> 字段（明文，注意 data/ 备份安全）；在下方修改会同步写入该文件。'
                : (json.isDefaultPassword
                    ? '当前是本机。<b>尚未设置访问密码</b>：无密码态不设闸门，端口可达范围由 <code>data/config.json</code> 的 <code>host</code> 决定（默认只监听本机）；请在下方设置一个密码，供登录鉴权使用。'
                    : '当前是本机管理员（已登录）。访问密码已设置：本机与局域网设备打开应用都需要输入这个密码。');
        } else if (json.isDefaultPassword) {
            // 无密码态下能连到这个端口的设备直接可用：非本机用户也必须知道这件事，
            // 否则会把「不用登录」误读成「已经登录」。
            box.textContent = '当前设备通过局域网访问：这个实例尚未设置访问密码，任何能连接到该端口的人都可以使用全部功能。建议在这台电脑上设置访问密码。';
        } else {
            box.textContent = '当前设备已登录（非本机）。如需修改访问密码，请在这台电脑上打开本应用操作。';
        }
    } catch (e) {
        // 本机服务不可用（或页面不在服务模式）：不显示状态，避免把失败说成功能
        box.textContent = '无法获取本机访问密码状态（本地服务可能未启动）。';
    }
}

async function changeAccessPassword() {
    const a = document.getElementById('authNewPwd');
    const b = document.getElementById('authNewPwd2');
    const next = (a && a.value ? a.value : '').trim();
    const again = (b && b.value ? b.value : '').trim();
    if (next.length < 8) { showCustomAlert('新密码至少 8 位，且要同时含数字和一个其他字符（字母或符号）。', '访问密码'); return; }
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
        await showCustomAlert('访问密码已更新，并写入 data/config.json。\n\n这台设备会保持登录；其它设备打开应用需要用新密码登录。请记牢；忘记时直接改 data/config.json 里的 password 字段并重启应用。', '访问密码');
        location.href = '/';
    } catch (e) {
        showCustomAlert('修改失败：' + (e.message || e), '访问密码');
    }
}

// 刷新「浏览器」那一块的现状说明。必须问服务端：浏览器进程是服务端起的，前端无从知道它是否在跑，
// 而"试探性地拉一次"会真的把浏览器打开，所以走只读的 /api/agent/browser/status。
async function refreshBrowserStatus() {
    const box = document.getElementById('settingBrowserStatus');
    if (!box) return;
    if (typeof IS_NATIVE_APP !== 'undefined' && IS_NATIVE_APP) {
        box.textContent = '手机版浏览器功能只支持电脑侧。';
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

// 「电脑操作权限」与「手机操作」两组设置按设备形态只显示一组：电脑给「允许操作电脑」，手机给「手机操作」。
// 用 IS_MOBILE_DEVICE（设备本身）而不是窗口宽度 —— 电脑上把窗口拖窄不该变成"手机"。
// 定时任务的保活提示只讲安卓那三件事（自启动 / 电池优化 / 后台锁定），电脑上无从照做，一并按设备隐藏。
// 浏览器那一整块只在电脑端有意义：它依赖电脑侧的本机服务，手机上没有可执行的东西，
// 留着只会让用户在手机上点一个必然失败的开关。
function syncAgentSectionsByDevice() {
    const pcSection = document.getElementById('agentPermissionSection');
    const phoneSection = document.getElementById('agentPhoneSection');
    if (pcSection) pcSection.classList.toggle('hidden', IS_MOBILE_DEVICE);
    if (phoneSection) phoneSection.classList.toggle('hidden', !IS_MOBILE_DEVICE);
    const keepAlive = document.getElementById('scheduledTaskKeepAliveHint');
    if (keepAlive) keepAlive.classList.toggle('hidden', !IS_MOBILE_DEVICE);
    const browserSection = document.getElementById('agentBrowserSection');
    if (browserSection) browserSection.classList.toggle('hidden', IS_MOBILE_DEVICE);
}

