/* ============================================================================
 * 我的数据：导出 / 导入 / 位置（从 settings.js 拆出）
 *
 * 备份导出、文档选择器导入、旧 JSON 兼容、数据位置提示。
 * ========================================================================== */
'use strict';

// ==================== 我的数据（导出 / 导入 / 位置） ====================
// 后端把数据分类落在 data/ 下；这里只负责让用户「看得见、能备份、能恢复」—— 换机器和升级前的那道保险。
// Web：走 /api/data/*；APK：没有本地服务，走 chat-backup.js 直接读写 localStorage。
// APK 侧**最需要**备份：数据在应用私有目录，卸载即丢，用户连手动拷出来都做不到。两边备份格式同构、可互相导入。
async function refreshDataSettings() {
    const box = document.getElementById('dataStatusBox');
    const section = document.getElementById('dataSettingsSection');
    if (!box) return;

    // ---- APK：本地统计，不发请求 ----
    if (IS_NATIVE_APP && window.ChatBackup) {
        try {
            let cards = 0;
            let convs = 0;
            let mem = 0;
            try { cards = JSON.parse(Store.getItem('elaina_open_character_cards') || '[]').length; } catch { /* 忽略 */ }
            try { convs = JSON.parse(Store.getItem('elaina_open_conversations') || '[]').length; } catch { /* 忽略 */ }
            try { mem = (JSON.parse(Store.getItem('elaina_open_memory_core') || '{}').diary || []).length; } catch { /* 忽略 */ }
            box.innerHTML = '数据位置：<code class="text-indigo-500">应用私有目录</code>'
                + '<span class="text-indigo-300">（安卓应用数据，卸载会一并删除）</span><br>'
                + '人设卡 <b>' + escapeHtml(String(cards)) + '</b> 张'
                + ' · 对话 <b>' + escapeHtml(String(convs)) + '</b> 个'
                + ' · 记忆 <b>' + escapeHtml(String(mem)) + '</b> 条';
        } catch (e) {
            box.textContent = '无法读取本地数据统计';
        }
        // 手机版没有本机服务端，局域网共享接口不存在；直接隐藏，避免点了必然失败。
        ['lanShareOpenBtn', 'lanShareReceiveBtn', 'lanShareHintLine'].forEach((id) => document.getElementById(id)?.classList.add('hidden'));
        return;
    }

    // ---- Web：走后端 ----
    try {
        const res = await fetch('/api/data/info');
        if (!res.ok) { if (section) section.classList.add('hidden'); return; }
        const json = await res.json();
        if (!json.ok) { if (section) section.classList.add('hidden'); return; }
        const c = json.counts || {};
        box.innerHTML = '数据位置：<code class="text-indigo-500">' + escapeHtml(json.dir || 'data')
            + '</code><br>'
            + '人设卡 <b>' + escapeHtml(String(c.characters || 0)) + '</b> 张'
            + ' · 对话 <b>' + escapeHtml(String(c.conversations || 0)) + '</b> 个'
            + ' · 记忆 <b>' + escapeHtml(String(c.memoryEntries || 0)) + '</b> 条'
            + ' · 插件 <b>' + escapeHtml(String(c.mods || 0)) + '</b> 个'
            + ' · 技能 <b>' + escapeHtml(String(c.skills || 0)) + '</b> 个';
        ['lanShareOpenBtn', 'lanShareReceiveBtn', 'lanShareHintLine'].forEach((id) => document.getElementById(id)?.classList.remove('hidden'));
    } catch (e) {
        if (section) section.classList.add('hidden');
    }
}

function setDataHint(text, isError) {
    const hint = document.getElementById('dataActionHint');
    if (!hint) return;
    hint.textContent = text || '';
    hint.className = isError ? 'text-[11px] text-red-500' : 'text-[11px] text-indigo-300';
}

async function exportDataBackup() {
    setDataHint('导出中…');

    // ---- APK：本地生成 zip 并**写进应用文档目录**（没有后端可用）----
    // 为什么不用 <a download> + blob URL：**安卓 WebView 不处理 blob: 下载**。
    // 桌面浏览器会把 blob 交给下载器，WebView 里点下去通常毫无反应
    //（这也是 Capacitor 社区反复提到的一点）。所以 APK 侧走 Capacitor Filesystem，
    // 把备份真正写到磁盘上，再把路径告诉用户。
    if (IS_NATIVE_APP && window.ChatBackup) {
        try {
            const fs = nativeFs();
            if (!fs) { setDataHint('导出失败：文件系统插件不可用', true); return; }
            const blob = await window.ChatBackup.buildBackupBlob();
            if (!blob.size) { setDataHint('导出失败：本地数据为空', true); return; }
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const t = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            const fileName = 'elainachat-backup-' + t + '.zip';
            // Documents 目录：用户能用系统文件管理器找到（比 Data 私有目录友好）
            const dir = (fs.Directory && fs.Directory.Documents) ? fs.Directory.Documents : 'DOCUMENTS';
            await nativeWriteFile(fileName, dir, bytes);
            // 同时取一个 WebView 能访问的 URL，方便用户直接点开/分享
            let where = '文档目录';
            try {
                const uri = await fs.getUri({ path: fileName, directory: dir });
                if (uri && uri.uri) where = uri.uri;
            } catch { /* 拿不到就只报目录名 */ }
            setDataHint('已导出：' + fileName + '（' + Math.round(bytes.length / 1024) + ' KB）');
            showCustomAlert(
                '备份已保存到手机的**文档目录**：\n\n' + fileName
                + '\n\n大小 ' + Math.round(bytes.length / 1024) + ' KB。'
                + '\n\n用系统「文件管理」进 文档 / Documents 就能看到它。'
                + '传到电脑后，在网页版的「我的数据 → 导入备份」里可以直接还原。',
                '导出完成');
        } catch (e) {
            setDataHint('导出失败：' + (e.message || e), true);
        }
        return;
    }

    // ---- Web：走后端 ----
    try {
        const res = await fetch('/api/data/export');
        if (!res.ok) {
            // 插件目录读不到时后端会回 JSON 说明原因；只报 HTTP 状态会让用户
            // 以为是网络问题，反复重试同一个必然失败的导出。
            let why = '';
            try {
                const j = await res.json();
                why = j && j.message ? String(j.message) : '';
            } catch { /* 不是 JSON 就只报状态码 */ }
            setDataHint('导出失败：' + (why || ('HTTP ' + res.status)), true);
            return;
        }
        const blob = await res.blob();
        // 空响应要明确报错，而不是静默存下一个 0 字节文件。
        // 什么时候会空：装了迅雷/FDM 之类下载器的浏览器，其扩展会拦走带
        // attachment 的响应（后端刻意不发那个头，但代理、中间层或
        // 别的服务版本仍可能造成空响应）。这种情况用户拿到的文件是坏的，必须说出来。
        if (!blob.size) {
            setDataHint('导出失败：服务端返回了空内容。若装了迅雷/FDM，请先关掉它的浏览器扩展再试。', true);
            return;
        }
        // 文件名走自定义头（后端不再发 Content-Disposition，避免被下载器识别成下载）
        let name = res.headers.get('X-Backup-Filename') || '';
        if (!name) {
            const cd = res.headers.get('Content-Disposition') || '';
            const m = cd.match(/filename="?([^";]+)"?/);
            if (m && m[1]) name = m[1];
        }
        if (!name) {
            const t = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            name = 'elainachat-backup-' + t + '.zip';
        }
        // blob: 是内存地址，外部下载器接管不了，也不会弹它的窗口
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setDataHint('已导出：' + name + '（' + Math.round(blob.size / 1024) + ' KB）');
    } catch (e) {
        setDataHint('导出失败：' + (e.message || e), true);
    }
}

/**
 * APK 侧导入入口：先看文档目录里有没有导出过的备份，有就让用户选；
 * 一个都没有（或插件不可用）时退回系统文件选择器。
 *
 * 为什么要有这条路径：安卓 WebView 的 <input type="file"> 行为在各厂商 ROM 上
 * 差异很大（有的能选、有的只能选图片）。而"自己导出的备份就在文档目录里"是
 * **最常见的使用场景**（导完想恢复），走 Filesystem 读取最可靠。
 */
async function importFromDocumentsOrPicker() {
    const fs = nativeFs();
    let names = [];
    try {
        const dir = (fs.Directory && fs.Directory.Documents) ? fs.Directory.Documents : 'DOCUMENTS';
        const res = await fs.readdir({ path: '', directory: dir });
        names = (res && res.files ? res.files : [])
            .filter((f) => /^elainachat-backup-.*\.(zip|json)$/i.test(f.name))
            .map((f) => f.name)
            .sort()
            .reverse();   // 最新的排前面
    } catch { /* 目录读不到就当没有 */ }

    if (!names.length) {
        // 没有备份 → 交给系统文件选择器（用户可能从微信/下载目录里选了传进来的）
        document.getElementById('dataImportFile')?.click();
        return;
    }

    const picked = await showCustomModal({
        title: '从手机里选择备份',
        message: '文档目录里找到 ' + names.length + ' 个备份（最新的在最前）：\n\n'
            + names.slice(0, 8).map((n, i) => (i + 1) + '. ' + n).join('\n')
            + (names.length > 8 ? '\n…还有 ' + (names.length - 8) + ' 个' : '')
            + '\n\n输入序号导入；留空则改用系统文件选择器。',
        input: true,
        defaultValue: '1',
        placeholder: '序号，如 1',
    });
    if (picked === null || picked === undefined || String(picked).trim() === '') {
        document.getElementById('dataImportFile')?.click();
        return;
    }
    const idx = Number(String(picked).trim()) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= names.length) {
        setDataHint('序号无效', true);
        return;
    }
    const fileName = names[idx];
    try {
        const dir = (fs.Directory && fs.Directory.Documents) ? fs.Directory.Documents : 'DOCUMENTS';
        const read = await fs.readFile({ path: fileName, directory: dir });
        // Capacitor 返回 base64（v7 起固定返回 data 字段）
        const b64 = String(read && read.data ? read.data : '');
        if (!b64) { setDataHint('读不到文件内容', true); return; }
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], fileName, { type: 'application/zip' });
        await importDataBackup(file);
    } catch (e) {
        setDataHint('读取备份失败：' + (e.message || e), true);
    }
}

async function importDataBackup(file) {
    if (!file) return;
    // 合并模式：只覆盖备份里有的数据，本机其它数据不动 —— 比"替换"安全得多，
    // 所以默认用它，且不做二次确认之外的额外询问。
    const okToGo = await showCustomConfirm(
        '导入备份会覆盖同名的数据（聊天记录 / 人设卡 / 记忆 / 设置 / 插件 / 技能），本机其它数据保留。\n\n'
        + '继续导入吗？', '导入备份');
    if (!okToGo) { setDataHint('已取消'); return; }
    setDataHint('导入中…');

    // ---- APK：本地写回 localStorage（没有后端可用）----
    if (IS_NATIVE_APP && window.ChatBackup) {
        try {
            const r = await window.ChatBackup.applyBackup(file);
            setDataHint('已导入 ' + r.keys + ' 项数据（' + (r.source === 'zip' ? 'zip' : '旧版 JSON') + '）');
            await refreshDataSettings();
            showCustomAlert('已导入 ' + r.keys + ' 项数据。\n\n刷新页面后即可看到导入的聊天记录与人设卡。', '导入完成');
        } catch (e) {
            setDataHint('导入失败：' + (e.message || e), true);
        }
        return;
    }

    // ---- Web：交给后端 ----
    try {
        // 直接把文件原样发上去：备份是 zip（二进制），不能走 JSON 包装。
        // 后端两种都认（zip 与 v1 的单 JSON 旧备份），所以这里不用判断类型。
        const res = await fetch('/api/data/import?mode=merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file
        });
        const json = await res.json().catch(() => ({ ok: false, message: '服务端返回了非 JSON 内容（HTTP ' + res.status + '）' }));
        if (!json.ok) { setDataHint(json.message || '导入失败', true); return; }
        setDataHint(json.message || '导入完成');
        await refreshDataSettings();
        showCustomAlert((json.message || '导入完成') + '。\n\n刷新页面后即可看到导入的聊天记录与人设卡。', '导入完成');
    } catch (e) {
        setDataHint('导入失败：' + (e.message || e), true);
    }
}

// ==================== 局域网共享（我的数据旁的两个按钮） ====================
// 与导出 / 导入共用同一份备份：共享开关与拉取都由本机服务端完成。
function lanShareFmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
}

function lanShareAddressText(share) {
    const list = (share && Array.isArray(share.addresses)) ? share.addresses : [];
    const port = share && share.port ? String(share.port) : '';
    let text = '局域网共享已开启（' + Math.round(((share && share.expiresAt) ? (share.expiresAt - Date.now()) : 0) / 60000)
        + ' 分钟后自动关闭）。\n\n';
    if (!list.length) {
        text += '未检测到局域网 IPv4 地址，请确认本机已连上 Wi-Fi / 网线。';
        return text;
    }
    text += '把这台设备的 IP、端口和访问密码告诉对方：\n\n';
    text += list.map((a) => '• ' + (a.label ? a.label + '：' : '') + 'IP ' + a.ip + '　端口 ' + (a.port || port)).join('\n');
    text += '\n\n对方点「局域网接收共享」，填上面的 IP 和端口，再填访问密码即可。';
    return text;
}

async function openLanShare() {
    const btn = document.getElementById('lanShareOpenBtn');
    if (btn) btn.disabled = true;
    try {
        const status = await fetch('/api/auth/status').then((r) => r.json()).catch(() => null);
        if (status && status.ok && status.isDefaultPassword) {
            showCustomAlert('还没有设置访问密码，局域网设备不能连接。\n\n请先在下方「访问密码（局域网）」里设置一个密码，再来开启局域网共享。', '无法开启局域网共享');
            return;
        }
        const res = await fetch('/api/data/lan/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        const json = await res.json().catch(() => ({ ok: false, message: 'HTTP ' + res.status }));
        if (!json.ok) throw new Error(json.message || '开启失败');
        showCustomAlert(lanShareAddressText(json.share), '局域网共享已开启');
    } catch (e) {
        showCustomAlert('开启失败：' + (e.message || e), '局域网共享');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// 局域网接收共享的输入弹窗：IP 与端口一行两个，密码单独一行。
// 密码就是对方登录用的访问密码 —— 局域网能连上就一定有密码，不再提示"没有就留空"。
function openLanReceiveDialog() {
    return new Promise((resolve) => {
        const old = document.getElementById('lanReceiveOverlay');
        if (old) old.remove();
        const overlay = document.createElement('div');
        overlay.id = 'lanReceiveOverlay';
        overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 modal-overlay';
        overlay.innerHTML = [
            '<div class="modal-panel w-full max-w-md">',
            '<div class="p-5">',
            '<div class="flex items-center justify-between mb-1">',
            '<h3 class="text-base font-bold text-indigo-900">局域网接收共享</h3>',
            '<button type="button" id="lanReceiveClose" class="text-indigo-400 hover:text-indigo-600" aria-label="关闭">✕</button>',
            '</div>',
            '<p class="text-[12px] text-indigo-400 leading-relaxed mb-4">填对方「开启局域网共享」时给出的地址，以及对方登录用的访问密码。</p>',
            '<div class="flex items-start gap-2 mb-3">',
            '<div class="flex-1">',
            '<label class="text-[11px] text-indigo-400">对方 IP</label>',
            '<input id="lanReceiveIp" class="modal-input w-full text-sm py-1.5" placeholder="如 192.168.1.5" autocomplete="off">',
            '</div>',
            '<div class="w-24">',
            '<label class="text-[11px] text-indigo-400">端口</label>',
            '<input id="lanReceivePort" class="modal-input w-full text-sm py-1.5" placeholder="如 3999" autocomplete="off" inputmode="numeric">',
            '</div>',
            '</div>',
            '<div class="mb-4">',
            '<label class="text-[11px] text-indigo-400">对方访问密码（对方登录用的密码）</label>',
            '<input id="lanReceivePwd" class="modal-input w-full text-sm py-1.5" type="password" autocomplete="off">',
            '</div>',
            '<div class="flex items-center justify-end gap-2">',
            '<button type="button" id="lanReceiveCancel" class="btn-secondary text-xs">取消</button>',
            '<button type="button" id="lanReceiveOk" class="btn-secondary text-xs">开始导入</button>',
            '</div>',
            '<p id="lanReceiveErr" class="text-[11px] text-red-500 mt-2"></p>',
            '</div>',
            '</div>',
        ].join('\n');
        document.body.appendChild(overlay);
        const ipEl = overlay.querySelector('#lanReceiveIp');
        const portEl = overlay.querySelector('#lanReceivePort');
        const pwdEl = overlay.querySelector('#lanReceivePwd');
        const errEl = overlay.querySelector('#lanReceiveErr');
        const finish = (value) => {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            resolve(value);
        };
        const submit = () => {
            const ip = String(ipEl.value || '').trim();
            const port = String(portEl.value || '').trim();
            const pwd = String(pwdEl.value || '');
            if (!ip) { errEl.textContent = '请填对方 IP。'; ipEl.focus(); return; }
            if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
                errEl.textContent = '请填合法端口（1–65535）。'; portEl.focus(); return;
            }
            if (!pwd) { errEl.textContent = '请填对方登录用的访问密码。'; pwdEl.focus(); return; }
            finish({ ip, port, password: pwd });
        };
        const onKey = (e) => {
            if (e.key === 'Escape') finish(null);
            else if (e.key === 'Enter') submit();
        };
        overlay.querySelector('#lanReceiveClose').addEventListener('click', () => finish(null));
        overlay.querySelector('#lanReceiveCancel').addEventListener('click', () => finish(null));
        overlay.querySelector('#lanReceiveOk').addEventListener('click', submit);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
        document.addEventListener('keydown', onKey);
        setTimeout(() => ipEl.focus(), 0);
    });
}

async function receiveLanShare() {
    const picked = await openLanReceiveDialog();
    if (!picked) return;
    const sourceUrl = picked.ip + ':' + picked.port;
    const pwd = picked.password;

    const btn = document.getElementById('lanShareReceiveBtn');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/data/lan/pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceUrl, password: String(pwd) }),
        });
        if (!res.ok) {
            const json = await res.json().catch(() => null);
            throw new Error((json && json.message) || ('HTTP ' + res.status));
        }
        const blob = await res.blob();
        if (!blob.size) throw new Error('对方返回空内容');
        const ok = await showCustomConfirm(
            '已从对方拉取 ' + lanShareFmtSize(blob.size) + ' 的备份。\n\n'
            + '将按「合并」方式导入本机：同名数据被覆盖，本机其它数据保留。\n\n继续导入吗？',
            '从局域网导入');
        if (!ok) return;
        const up = await fetch('/api/data/import?mode=merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: blob,
        });
        const json = await up.json().catch(() => null);
        if (!json || !json.ok) throw new Error((json && json.message) || ('HTTP ' + up.status));
        await refreshDataSettings();
        showCustomAlert((json.message || '导入完成') + '。\n\n刷新页面后即可看到导入的聊天记录与人设卡。', '导入完成');
    } catch (e) {
        showCustomAlert('导入失败：' + (e.message || e), '局域网接收共享');
    } finally {
        if (btn) btn.disabled = false;
    }
}
