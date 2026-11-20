// 我的数据：备份导出、文档选择器导入、旧 JSON 兼容、数据位置提示。
'use strict';

// 后端把数据分类落在 data/ 下；这里只负责让用户看得见、能备份、能恢复。
// Web 与 APK 都走 /api/data/*；APK 的数据服务在内嵌 Go 服务，页面在 https://localhost，
// 所以用 core-native-mod.js 暴露的绝对 __nodeBase 直连（CORS 在 service mode 放行）。
function dataApiUrl(path) {
    if (IS_NATIVE_APP && window.__nodeBase) return window.__nodeBase + path;
    return path;
}

/** 导出备份时要随请求带上的密钥表（APK 专用）。
    手机上 Key 只住在 Android Keystore，不写进 data/ —— 服务端 Load() 里没有它们，
    导出的备份天然缺 Key，换机或重装后必须逐个重填。这里把 Keystore 现值读出来交给服务端
    合并进备份（只在内存里合并，不落盘），备份就与电脑版同形：Key 与供应商在、访问密码不在。
    读不到（旧包 / 白名单漏配）时返回空对象：少几个 Key 的备份仍可用，不能让导出整体失败。 */
async function exportSecretsHeader() {
    const nativePlugin = getNativeSecretsPlugin();
    if (!nativePlugin?.getSecret) return {};
    const pairs = await Promise.all(API_SECRET_NAMES.map(async (name) => {
        try {
            const value = String((await nativePlugin.getSecret({ name }))?.value || '');
            return value ? [name, value] : null;
        } catch (error) {
            console.warn(`[BYOK] 导出备份时读不到 ${name}，本次备份不含它`, error);
            return null;
        }
    }));
    const secrets = Object.fromEntries(pairs.filter(Boolean));
    if (!Object.keys(secrets).length) return {};
    return { 'X-Elaina-Secrets': JSON.stringify(secrets) };
}

/** 导入备份后把备份里的密钥灌进 Keystore。
    手机上 Key 只住 Keystore，而备份里的 Key 落在 data/ 的密钥表（Store）里。
    loadApiSecrets 的回填方向是「Keystore 缺的才从 Store 补」—— 所以 Keystore 里
    已经有值（哪怕是旧值）时，备份里的新 Key 永远补不进去，表现为「导入成功但 Key 还是旧的」。
    这里在重载页面前反向写一次：备份里有的名字一律以备份为准。

    ⚠️ 必须读服务端刚导入的那份，不能读 Store.getItem：它读的是页面内存缓存，
    导入只改了服务端磁盘，此刻缓存还是导入前的旧值。把旧值写进 Keystore 反而更糟 ——
    chatProviderKeys 的旧值是个非空字符串（如 `{"prov_x":""}`），会让回填永久跳过，
    结果是「provider keys 全丢、而 apiKey 因为是空串反而能回填」这种半好半坏的状态。
    读不到（Web 形态 / 服务端不可用）时什么都不做。 */
async function applyImportedSecrets() {
    const nativePlugin = getNativeSecretsPlugin();
    if (!nativePlugin?.setSecret) return;
    let stored = {};
    try {
        const res = await fetch(dataApiUrl('/api/store'), { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        const raw = json && json.data ? json.data['elainachat_open_api_secrets'] : '';
        if (!raw) return;
        stored = JSON.parse(String(raw)) || {};
    } catch (e) {
        return;
    }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    const payload = {};
    API_SECRET_NAMES.forEach((name) => {
        const value = stored[name];
        if (value === undefined || value === null) return;
        const text = String(value).trim();
        if (!text) return;
        payload[name] = text;
    });
    if (!Object.keys(payload).length) return;
    try {
        await saveApiSecrets(payload, { inline: true });
        console.info('[BYOK] 备份里的 Key 已写入 Keystore（' + Object.keys(payload).length + ' 项）');
    } catch (error) {
        // 写不进去不能让导入整体算失败：数据已经落盘，重启后 loadApiSecrets 还会再试一次。
        console.warn('[BYOK] 备份 Key 写入 Keystore 失败（下次启动重试）', error);
    }
}

async function refreshDataSettings() {
    const box = document.getElementById('dataStatusBox');
    if (!box) return;

    try {
        const res = await fetch(dataApiUrl('/api/data/info'));
        if (!res.ok) {
            // 鉴权失效时保留区块并说明原因：整块隐藏会让用户以为功能被删了。
            box.textContent = res.status === 401
                ? '需要重新登录后才能读取数据统计。'
                : '读取数据统计失败（HTTP ' + res.status + '），请稍后重试。';
            return;
        }
        const json = await res.json();
        if (!json.ok) {
            box.textContent = '读取数据统计失败：' + (json.message || '服务端未返回统计');
            return;
        }
        const c = json.counts || {};
        box.innerHTML = '数据位置：<code class="text-dim">' + escapeHtml(json.dir || 'data')
            + '</code><br>'
            + '人设卡 <b>' + escapeHtml(String(c.characters || 0)) + '</b> 张'
            + ' · 对话 <b>' + escapeHtml(String(c.conversations || 0)) + '</b> 个'
            + ' · 记忆 <b>' + escapeHtml(String(c.memoryEntries || 0)) + '</b> 条'
            + ' · 插件 <b>' + escapeHtml(String(c.mods || 0)) + '</b> 个'
            + ' · 技能 <b>' + escapeHtml(String(c.skills || 0)) + '</b> 个';
        ['lanShareOpenBtn', 'lanShareReceiveBtn', 'lanShareHintLine'].forEach((id) => document.getElementById(id)?.classList.remove('hidden'));
    } catch (e) {
        box.textContent = '读取数据统计失败：' + (e && e.message ? e.message : e);
    }
}

function setDataHint(text, isError) {
    const hint = document.getElementById('dataActionHint');
    if (!hint) return;
    hint.textContent = text || '';
    hint.className = isError ? 'text-[11px] text-danger' : 'text-[11px] text-dim';
}

// 把整份字节按固定大小切片，逐块交给原生追加。
// 切的是**原文字节**而不是 base64 串：base64 必须按 3 字节对齐，从编码后的字符串中间切
// 会解出损坏的数据。每块单独编码，边界天然对齐。
const BACKUP_CHUNK_BYTES = 512 * 1024;

async function appendInChunks(capExport, handle, bytes, onProgress) {
    for (let offset = 0; offset < bytes.length; offset += BACKUP_CHUNK_BYTES) {
        const part = bytes.subarray(offset, Math.min(offset + BACKUP_CHUNK_BYTES, bytes.length));
        const r = await capExport.appendBinary({ handle, data: bytesToBase64(part) });
        if (!r || !r.ok) throw new Error((r && r.text) || '写入失败');
        if (onProgress) onProgress(Math.min(offset + BACKUP_CHUNK_BYTES, bytes.length), bytes.length);
    }
}

async function exportDataBackup() {
    setDataHint('导出中…');

    // APK 侧从内嵌 Go 服务导出 v4 备份（含 mods/skills/记忆），再交给用户**自选保存位置**。
    // 不用 <a download> + blob URL：安卓 WebView 不处理 blob: 下载，点下去通常毫无反应。
    if (IS_NATIVE_APP) {
        try {
            const res = await fetch(dataApiUrl('/api/data/export'), { headers: await exportSecretsHeader() });
            if (!res.ok) {
                let why = '';
                try {
                    const j = await res.json();
                    why = j && j.message ? String(j.message) : '';
                } catch { /* 不是 JSON 就只报状态码 */ }
                setDataHint('导出失败：' + (why || ('HTTP ' + res.status)), true);
                return;
            }
            const blob = await res.blob();
            if (!blob.size) { setDataHint('导出失败：服务端返回空内容', true); return; }
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const t = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            const fileName = 'elainachat-backup-' + t + '.zip';
            const sizeText = Math.round(bytes.length / 1024) + ' KB';

            // 与日志导出同一条路径：原生 SAF「创建文档」选择器，用户自己定存到哪。
            // 不写死 Documents 的原因：备份动辄 20MB+，用户常常要存到 U 盘 / 网盘目录 / 电脑共享盘，
            // 固定目录在 scoped storage 下还未必可写。
            // 走分块接口而不是一次性传：Capacitor bridge 对单次调用有大小上限，
            // 20MB 备份序列化成 base64 是 27MB，一次传过去会被截断。
            const cap = window.Capacitor;
            const capExport = cap && cap.Plugins && cap.Plugins.ElainaExport;
            if (capExport && typeof capExport.beginBinary === 'function') {
                const begin = await capExport.beginBinary({ fileName, mimeType: 'application/zip' });
                if (begin && begin.ok && begin.handle) {
                    try {
                        await appendInChunks(capExport, begin.handle, bytes, (done, total) => {
                            setDataHint('导出中… ' + Math.round((done / total) * 100) + '%');
                        });
                        const finish = await capExport.finishBinary({ handle: begin.handle });
                        if (finish && finish.ok) {
                            setDataHint('已导出：' + fileName + '（' + sizeText + '）');
                            showCustomAlert(
                                '备份已保存到你选择的位置：\n\n' + fileName
                                + '\n\n大小 ' + sizeText + '。'
                                + '\n\n传到电脑后，在网页版的「我的数据 → 导入备份」里可以直接还原。',
                                '导出完成');
                            return;
                        }
                        setDataHint('导出失败：' + ((finish && finish.text) || '保存未完成'), true);
                        return;
                    } catch (writeErr) {
                        // 中途失败要把句柄放掉，否则流一直挂在原生侧
                        try { await capExport.abortBinary({ handle: begin.handle }); } catch { /* 尽力而为 */ }
                        setDataHint('导出失败：' + ((writeErr && writeErr.message) || writeErr), true);
                        return;
                    }
                }
                if (begin && begin.reason === 'cancelled') { setDataHint('已取消导出'); return; }
                // 选择器不可用（极精简 ROM）才回落固定目录，并把原因说出来
                setDataHint((begin && begin.text) || '系统选择器不可用，改存固定位置…');
            }

            // 兜底：写应用文档目录。仅在拿不到系统选择器时走到。
            const fs = nativeFs();
            if (!fs) { setDataHint('导出失败：文件系统插件不可用', true); return; }
            const dir = (fs.Directory && fs.Directory.Documents) ? fs.Directory.Documents : 'DOCUMENTS';
            await nativeWriteFile(fileName, dir, bytes);
            setDataHint('已导出：' + fileName + '（' + sizeText + '）');
            showCustomAlert(
                '备份已保存到手机的**文档目录**：\n\n' + fileName
                + '\n\n大小 ' + sizeText + '。'
                + '\n\n用系统「文件管理」进 文档 / Documents 就能看到它。'
                + '传到电脑后，在网页版的「我的数据 → 导入备份」里可以直接还原。',
                '导出完成');
        } catch (e) {
            setDataHint('导出失败：' + (e.message || e), true);
        }
        return;
    }

    try {
        const res = await fetch(dataApiUrl('/api/data/export'), { headers: await exportSecretsHeader() });
        if (!res.ok) {
            // 插件目录读不到时后端会回 JSON 说明原因；只报 HTTP 状态会让用户以为是网络问题，反复重试。
            let why = '';
            try {
                const j = await res.json();
                why = j && j.message ? String(j.message) : '';
            } catch { /* 不是 JSON 就只报状态码 */ }
            setDataHint('导出失败：' + (why || ('HTTP ' + res.status)), true);
            return;
        }
        const blob = await res.blob();
        // 空响应要明确报错，而不是静默存下一个 0 字节文件：装了迅雷/FDM 的浏览器，其扩展会拦走
        // 带 attachment 的响应（代理/中间层也可能），用户拿到的文件是坏的，必须说出来。
        if (!blob.size) {
            setDataHint('导出失败：服务端返回了空内容。若装了迅雷/FDM，请先关掉它的浏览器扩展再试。', true);
            return;
        }
        // 文件名走自定义头（后端不发 Content-Disposition，避免被下载器识别成下载）
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

// APK 侧导入入口：先看文档目录里有没有导出过的备份，有就让用户选，一个都没有时退回系统文件选择器。
// 安卓 WebView 的 <input type="file"> 在各厂商 ROM 上行为差异很大，而"自己导出的备份就在文档目录里"是最常见场景。
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

/** 让用户在导入前选模式：合并（备份里有的键覆盖本机，其余不动）或覆盖（先清空本机数据再按备份重建）。
    返回 'merge' | 'replace'，取消返回 null。两条导入路径（文件 / 局域网）共用同一个弹窗，文案才不会各说各话。 */
async function chooseImportMode(title, note) {
    const picked = await showCustomModal({
        title,
        message: (note ? note + '\n\n' : '')
            + '请选择导入方式：\n\n'
            + '**合并导入**：只覆盖备份里包含的数据（聊天记录 / 人设卡 / 记忆 / 设置 / 插件 / 技能），本机其它数据保留。\n\n'
            + '**覆盖导入**：先清空本机的聊天记录与设置，再按备份重建；备份里没有的部分不会恢复。\n\n'
            + '拿不准就用合并导入 —— 它不会删掉备份以外的数据。',
        confirmText: '合并导入（推荐）',
        altText: '覆盖导入',
        altValue: 'replace',
        cancelText: '取消',
    });
    return picked === true ? 'merge' : (picked === 'replace' ? 'replace' : null);
}

async function importDataBackup(file) {
    if (!file) return;
    const mode = await chooseImportMode('导入备份');
    if (!mode) { setDataHint('已取消'); return; }
    setDataHint('导入中…');

    try {
        // 直接把文件原样发上去：备份是 zip（二进制），不能走 JSON 包装；后端两种都认，这里不用判断类型。
        const res = await fetch(dataApiUrl('/api/data/import?mode=' + mode), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file
        });
        const json = await res.json().catch(() => ({ ok: false, message: '服务端返回了非 JSON 内容（HTTP ' + res.status + '）' }));
        if (!json.ok) { setDataHint(json.message || '导入失败', true); return; }
        // 重载前先把备份里的 Key 灌进 Keystore：重载后 loadApiSecrets 只补 Keystore 缺的名字，
        // Keystore 已有的旧值会盖住备份里刚导入的新 Key。
        await applyImportedSecrets();
        // Web 与 APK 一样直接重载：导入改写了会话/卡片/设置的落盘值，页面内存里的
        // Store 缓存与会话状态都要重拉；其它已打开页面由服务端的 store-change 广播对齐。
        setDataHint('导入完成，正在刷新…');
        location.reload();
    } catch (e) {
        setDataHint('导入失败：' + (e.message || e), true);
    }
}

// 局域网共享与导出 / 导入共用同一份备份：共享开关与拉取都由本机服务端完成。
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
        // 端口照给：共享已经开着了，只是本机没探到可用的局域网地址。
        // 不给端口的话用户连"去系统设置里查一下自己的 IP 再填"都做不到。
        text += '本机没探到局域网 IPv4 地址，无法自动给出可用的 IP。\n\n'
            + '共享端口：' + (port || '（未知）') + '\n\n'
            + '请在系统设置里查本机 Wi-Fi 的 IP（形如 192.168.x.x），'
            + '和上面的端口一起填到对方的「局域网接收共享」里。'
            + '如果本机根本没连 Wi-Fi / 网线，对方是连不上的。';
        return text;
    }
    text += '把这台设备的 IP、端口告诉对方：\n\n';
    text += list.map((a) => '• ' + (a.label ? a.label + '：' : '') + 'IP ' + a.ip + '　端口 ' + (a.port || port)).join('\n');
    text += '\n\n对方登录用的是这台设备的**访问密码**（设置 → 高级 → 访问密码）。';
    text += '\n对方点「局域网接收共享」，填上面的 IP、端口和这台设备的访问密码即可。';
    return text;
}

async function openLanShare() {
    const btn = document.getElementById('lanShareOpenBtn');
    if (btn) btn.disabled = true;
    try {
        // 共享只是临时把本机暴露给局域网，凭据仍是本实例的访问密码；5 分钟自动关闭，只暴露登录与导出两个接口。
        // 同时把 Keystore 里的 Key 交上去：手机上 Key 不在 data/ 里，不交的话对方拉到的备份缺 Key
        // （这正是「局域网接收共享导入后 Key 为空」的成因）。
        const res = await fetch(dataApiUrl('/api/data/lan/enable'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await exportSecretsHeader()) },
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

// 局域网接收共享的输入弹窗：IP 与端口一行两个，访问密码单独一行。
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
            '<h3 class="text-base font-bold text-ink">局域网接收共享</h3>',
            '<button type="button" id="lanReceiveClose" class="text-dim hover:text-soft" aria-label="关闭">✕</button>',
            '</div>',
            '<p class="text-[12px] text-dim leading-relaxed mb-4">填对方「开启局域网共享」时给出的 IP、端口，以及<b>对方的访问密码</b>。</p>',
            '<div class="flex items-start gap-2 mb-3">',
            '<div class="flex-1">',
            '<label class="text-[11px] text-dim">对方 IP</label>',
            '<input id="lanReceiveIp" class="modal-input w-full text-sm py-1.5" placeholder="如 192.168.1.5" autocomplete="off">',
            '</div>',
            '<div class="w-24">',
            '<label class="text-[11px] text-dim">端口</label>',
            '<input id="lanReceivePort" class="modal-input w-full text-sm py-1.5" placeholder="如 3999" autocomplete="off" inputmode="numeric">',
            '</div>',
            '</div>',
            '<div class="mb-4">',
            '<label class="text-[11px] text-dim">对方访问密码</label>',
            '<input id="lanReceivePwd" class="modal-input w-full text-sm py-1.5" type="password" placeholder="对方设备的访问密码" autocomplete="off">',
            '</div>',
            '<div class="flex items-center justify-end gap-2">',
            '<button type="button" id="lanReceiveCancel" class="btn-secondary text-xs">取消</button>',
            '<button type="button" id="lanReceiveOk" class="btn-secondary text-xs">开始导入</button>',
            '</div>',
            '<p id="lanReceiveErr" class="text-[11px] text-danger mt-2"></p>',
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
            if (!pwd) { errEl.textContent = '请填对方的访问密码。'; pwdEl.focus(); return; }
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
        const res = await fetch(dataApiUrl('/api/data/lan/pull'), {
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
        const mode = await chooseImportMode('从局域网导入',
            '已从对方拉取 ' + lanShareFmtSize(blob.size) + ' 的备份。');
        if (!mode) return;
        const up = await fetch(dataApiUrl('/api/data/import?mode=' + mode), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: blob,
        });
        const json = await up.json().catch(() => null);
        if (!json || !json.ok) throw new Error((json && json.message) || ('HTTP ' + up.status));
        // 与文件导入同一处理：备份里的 Key 要先写进 Keystore，否则旧值会盖住它。
        await applyImportedSecrets();
        // 与文件导入同一处理：本页重载拿一致状态，其它页面靠服务端广播对齐。
        setDataHint('导入完成，正在刷新…');
        location.reload();
    } catch (e) {
        showCustomAlert('导入失败：' + (e.message || e), '局域网接收共享');
    } finally {
        if (btn) btn.disabled = false;
    }
}
