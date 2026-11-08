/* MCP 服务器设置：列表 / 卡片 / 预置 / 导入 / 编辑 / 工具刷新。依赖宿主弹窗与 MCP API。 */
"use strict";

/** 刷新 MCP 栏：状态取自 /api/mcp/status（不启动进程），工具条数来自已启动的进程。 */
async function refreshMcpList() {
    const box = document.getElementById('mcpList');
    if (!box) return;
    const hint = document.getElementById('mcpHint');
    const servers = Array.isArray(state.settings.mcpServers) ? state.settings.mcpServers : [];

    let statusMap = {};
    let statusError = '';
    try {
        const res = await fetch('/api/mcp/status', { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            for (const s of (Array.isArray(data && data.servers) ? data.servers : [])) statusMap[s.id] = s;
        } else {
            statusError = '本机服务不可用，状态未知';
        }
    } catch (e) {
        statusError = '本机服务不可用，状态未知';
    }

    if (box) box.innerHTML = servers.length ? '' : ('<div class="text-[11px] text-dim py-2 text-center">还没有 MCP 服务器。'
        + '点右上角「＋ 添加」：<br>远程填地址（例如 <code>https://example.com/mcp</code>），本地填启动命令（例如 <code>npx -y @modelcontextprotocol/server-filesystem D:/</code>）。</div>');
    if (hint && statusError) {
        hint.textContent = 'MCP 是外部工具服务：本应用当客户端去连它，把它提供的工具并进 AI 的能力清单。'
            + '当前' + statusError + '（配置仍可编辑）。';
        hint.className = 'text-[11px] leading-relaxed mb-3 text-warn';
    }

    servers.forEach((srv, index) => {
        box.appendChild(renderMcpCard(srv, index, statusMap));
    });
}

function renderMcpCard(srv, index, statusMap) {
    const st = statusMap[srv.id] || {};
    const stateText = st.state === 'ready' ? ('已连接 · ' + (st.tools || 0) + ' 个工具')
        : st.state === 'error' ? ('起不来：' + (st.error || '未知原因'))
            : st.state === 'starting' ? '正在启动…'
                : (srv.enabled ? '未启动（第一次调用时自动启动）' : '已停用');
    const stateCls = st.state === 'ready' ? 'text-ok'
        : st.state === 'error' ? 'text-danger' : 'text-dim';
    const card = document.createElement('div');
    card.className = 'mod-card';
    card.setAttribute('data-fullwidth', '1');
    const head = document.createElement('div');
    head.className = 'flex items-start gap-2';
    // 用 DOM 组装而不是 innerHTML 拼串：名字与错误来自用户输入与外部进程，拼进 HTML 有注入面
    const left = document.createElement('div');
    left.className = 'flex-1 min-w-0';
    const titleRow = document.createElement('div');
    titleRow.className = 'flex items-center gap-2 flex-wrap';
    const nameEl = document.createElement('span');
    nameEl.className = 'text-sm font-medium text-ink truncate';
    nameEl.textContent = srv.name || srv.id;
    const idEl = document.createElement('span');
    idEl.className = 'text-[10px] px-1.5 py-0.5 rounded bg-white/70 text-dim';
    idEl.textContent = srv.id;
    titleRow.appendChild(nameEl);
    titleRow.appendChild(idEl);
    const stateEl = document.createElement('div');
    stateEl.className = 'text-[11px] mt-1 break-all ' + stateCls;
    stateEl.textContent = stateText;
    const cmdEl = document.createElement('div');
    cmdEl.className = 'text-[11px] text-dim mt-0.5 break-all';
    const cmdCode = document.createElement('code');
    if (srv.url) {
        cmdEl.title = '远程 MCP 服务（Streamable HTTP）';
        cmdCode.textContent = 'HTTP · ' + srv.url;
    } else {
        cmdCode.textContent = [srv.command].concat(srv.args || []).join(' ');
    }
    cmdEl.appendChild(cmdCode);
    left.appendChild(titleRow);
    left.appendChild(stateEl);
    left.appendChild(cmdEl);

    const toggle = document.createElement('label');
    toggle.className = 'mod-switch flex-none';
    toggle.title = '启用 / 停用这台 MCP 服务器';
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = srv.enabled === true;
    toggleInput.addEventListener('change', async () => {
        const target = state.settings.mcpServers[index];
        if (!target) return;
        target.enabled = toggleInput.checked === true;
        persistSettings();
        await reloadMcpTools();
        void refreshMcpList();
    });
    const track = document.createElement('span'); track.className = 'track';
    const knob = document.createElement('span'); knob.className = 'knob';
    toggle.appendChild(toggleInput); toggle.appendChild(track); toggle.appendChild(knob);

    const editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'mod-act'; editBtn.title = '修改配置';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', () => void editMcpServer(index));

    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'mod-act'; delBtn.title = '删除';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async () => {
        const target = state.settings.mcpServers[index];
        if (!target) return;
        const ok = await showCustomConfirm('删除 MCP 服务器「' + (target.name || target.id) + '」？\n\n'
            + '只删配置，不会动它自己的程序文件。');
        if (!ok) return;
        state.settings.mcpServers.splice(index, 1);
        persistSettings();
        await reloadMcpTools();
        void refreshMcpList();
    });

    head.appendChild(left);
    head.appendChild(toggle);
    head.appendChild(editBtn);
    head.appendChild(delBtn);
    card.appendChild(head);
    box.appendChild(card);
    return card;
}

async function reloadMcpTools() {
    if (!window.ElainaMcp || typeof window.ElainaMcp.registerMcpOps !== 'function') return null;
    try { return await window.ElainaMcp.registerMcpOps(); } catch (e) {
        console.warn('[MCP] 重挂工具失败', e);
        return null;
    }
}

/** 测试结果写在弹窗内的状态行：showCustomAlert 走同一个弹窗队列，编辑窗开着时提示会排队卡住。 */
function makeTestStatusLine() {
    const box = document.getElementById('customModalEditor');
    const line = document.createElement('div');
    line.className = 'mt-2 text-xs leading-relaxed text-dim';
    line.dataset.mcpTestLine = '1';
    line.textContent = '';
    if (box && box.parentElement) {
        box.parentElement.querySelectorAll('[data-mcp-test-line]').forEach((n) => n.remove());
        box.parentElement.insertBefore(line, box.nextSibling);
    }
    return line;
}

const MCP_PRESETS = [
    {
        label: '远程 HTTP',
        hint: 'Streamable HTTP：填一个 https 地址即可，不用装任何东西',
        value: JSON.stringify({ id: '', url: 'https://example.com/mcp', headers: {} }, null, 2),
    },
    {
        label: '本地命令',
        hint: 'stdio：在本机启动一个进程（需要装 Node / Python）',
        value: JSON.stringify({ id: '', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/temp'] }, null, 2),
    },
    {
        label: '从教程粘贴',
        hint: '兼容 Claude Desktop / Cursor 的 {"mcpServers": {...}} 格式，自动展开',
        value: JSON.stringify({ mcpServers: { '我的服务器': { url: 'https://example.com/mcp' } } }, null, 2),
    },
];

/** 把外部格式的 MCP 配置归一成内部条目：兼容 serverUrl/baseUrl 等别名，args 字符串按空格切，env 值转字符串。 */
function normalizeImportedMcp(name, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const url = String(raw.url || raw.serverUrl || raw.baseUrl || raw.endpoint || '').trim();
    const command = String(raw.command || '').trim();
    if (!url && !command) return null;
    let args = raw.args;
    if (typeof args === 'string') args = args.trim() ? args.trim().split(/\s+/) : [];
    if (!Array.isArray(args)) args = [];
    const env = {};
    if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
        for (const [k, v] of Object.entries(raw.env)) {
            if (v === undefined || v === null) continue;
            env[String(k)] = String(v);
        }
    }
    const headers = {};
    const rawHeaders = raw.headers || raw.httpHeaders;
    if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
        for (const [k, v] of Object.entries(rawHeaders)) {
            if (v === undefined || v === null) continue;
            headers[String(k)] = String(v);
        }
    }
    return {
        id: String(raw.id || name || '').trim() || 'mcp',
        name: String(raw.name || name || '').trim(),
        url,
        command: url ? '' : command,
        args: url ? [] : args.map(String),
        env: url ? {} : env,
        cwd: url ? '' : String(raw.cwd || '').trim(),
        headers,
        enabled: raw.disabled === true || raw.enabled === false ? false : true,
    };
}

function makeMcpTestAction() {
    return {
        text: '测试连接',
        onClick: async (rawText, api) => {
            let cfg;
            try {
                cfg = JSON.parse(String(rawText || ''));
            } catch (e) {
                showCustomAlert('JSON 解析失败，先修好格式再测试：\n' + String((e && e.message) || e), '格式不对');
                return;
            }
            let one = cfg;
            if (cfg && typeof cfg === 'object' && cfg.mcpServers && typeof cfg.mcpServers === 'object') {
                const first = Object.entries(cfg.mcpServers)[0];
                if (!first) { showCustomAlert('mcpServers 是空的。', '没有内容'); return; }
                one = normalizeImportedMcp(first[0], first[1]);
            }
            if (!one || (!one.url && !one.command)) {
                showCustomAlert('需要 url（远程）或 command（本地），否则连不上。', '缺少连接方式');
                return;
            }
            api.setText('连接中…');
            try {
                const res = await fetch('/api/mcp/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ server: one, access: (typeof state !== 'undefined' && state.settings && state.settings.agentAccess) || 'full' }),
                });
                const data = await res.json().catch(() => ({}));
                const name = data && data.serverInfo && data.serverInfo.name ? '（' + data.serverInfo.name + '）' : '';
                const line = api.statusLine || (api.statusLine = makeTestStatusLine());
                if (data && data.ok) {
                    line.textContent = '✓ 连接成功' + name + ' · ' + (data.tools || []).length + ' 个工具'
                        + ((data.tools || []).length ? '：' + (data.tools || []).join('、') : '（没有提供工具）');
                    line.className = 'mt-2 text-xs leading-relaxed text-ok';
                } else {
                    line.textContent = '✗ 连不上' + name + '：' + String((data && data.message) || '未知原因')
                        + '（常见原因：地址写错、令牌无效、需要特定请求头）';
                    line.className = 'mt-2 text-xs leading-relaxed text-danger';
                }
            } catch (e) {
                const line = api.statusLine || (api.statusLine = makeTestStatusLine());
                line.textContent = '✗ 测试请求发不出去：' + String((e && e.message) || e);
                line.className = 'mt-2 text-xs leading-relaxed text-danger';
            }
        },
    };
}

function mcpEditorDefaultValue(isNew, preferHttp, cur) {
    // 新增时给一个能直接跑的示例（name/cwd/env 大多用不到）；编辑已有条目时完整回填，否则改一处丢别的值
    return JSON.stringify(isNew
        ? (preferHttp
            ? { id: '', url: 'https://example.com/mcp', headers: {} }
            : { id: '', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/temp'] })
        : {
            id: cur.id || '',
            name: cur.name || '',
            url: cur.url || '',
            command: cur.command || '',
            args: cur.args || [],
            cwd: cur.cwd || '',
            env: cur.env || {},
            headers: cur.headers || {},
        }, null, 2);
}

async function importMcpServersShell(parsed) {
    const entries = Object.entries(parsed.mcpServers);
    if (!entries.length) {
        showCustomAlert('这段配置里 mcpServers 是空的，没有可导入的服务器。', '没有内容');
        return;
    }
    const imported = [];
    const skipped = [];
    for (const [name, raw] of entries) {
        const one = normalizeImportedMcp(name, raw);
        if (one) imported.push(one); else skipped.push(name);
    }
    if (!imported.length) {
        showCustomAlert('这段配置里没有可识别的服务器（需要 command 或 url）。\n\n跳过的：' + skipped.join('、'), '没有可导入的项');
        return;
    }
    for (const one of imported) {
        let id = one.id;
        let n = 2;
        while (state.settings.mcpServers.some((s) => s.id === id)) id = one.id + '-' + (n++);
        one.id = id;
        one.name = one.name || id;
        state.settings.mcpServers.push(one);
    }
    persistSettings();
    await fetch('/api/mcp/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    await reloadMcpTools();
    void refreshMcpList();
    showCustomAlert('已导入 ' + imported.length + ' 台服务器：' + imported.map((x) => x.id).join('、')
        + (skipped.length ? '\n\n跳过 ' + skipped.length + ' 项（缺 command / url）：' + skipped.join('、') : '')
        + '\n\n它们默认是启用状态，点「刷新」可以立刻连接。', '导入完成');
}

/** 专用弹窗：通用 showCustomModal 拿不到「测试连接」需要的中间态（不关窗、不保存，只读当前内容真连一次）。 */
async function editMcpServer(index) {
    const isNew = index < 0;
    const cur = isNew
        ? { id: '', name: '', url: '', command: '', args: [], env: {}, cwd: '', headers: {}, enabled: true }
        : (state.settings.mcpServers[index] || {});
    const preferHttp = !cur.command || Boolean(cur.url);

    const value = await showCustomModal({
        title: isNew ? '添加 MCP 服务器' : '修改 MCP 服务器',
        message: '填一段 JSON：远程填 url（不用装东西），本地填 command。'
            + '不认识字段就点下面的模板，会自动填好。',
        input: true,
        editor: true,
        language: 'json',
        rows: 14,
        presets: MCP_PRESETS,
        extraAction: makeMcpTestAction(),

        defaultValue: mcpEditorDefaultValue(isNew, preferHttp, cur),
    });
    if (value === null || value === undefined) return;

    let parsed;
    try { parsed = JSON.parse(String(value)); } catch (e) {
        showCustomAlert('这段 JSON 解析失败：' + String((e && e.message) || e) + '\n\n请检查引号与逗号。', '配置格式不对');
        return;
    }
    // Claude Desktop / Cursor / Cline 都用 {"mcpServers": {…}} 外壳，教程粘贴必带；这里自动展开并支持多台
    if (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        await importMcpServersShell(parsed);
        return;
    }
    const url = String(parsed && parsed.url || '').trim();
    const command = String(parsed && parsed.command || '').trim();
    // url 与 command 至少有一个，缺了就挡在入口，不让它进列表显示"未连接"
    if (!url && !command) {
        showCustomAlert('要么填 url（远程服务），要么填 command（本地进程），否则这台服务器连不上。', '缺少连接方式');
        return;
    }
    if (url && !/^https?:\/\//i.test(url)) {
        showCustomAlert('url 必须以 http:// 或 https:// 开头。填的是：' + url, '地址格式不对');
        return;
    }
    const id = String(parsed.id || '').trim() || ('mcp' + (state.settings.mcpServers.length + 1));
    // id 是身份：服务端按它找配置，重复会让两台互相覆盖
    const dup = state.settings.mcpServers.some((s, i) => i !== index && String(s.id) === id);
    if (dup) {
        showCustomAlert('id「' + id + '」已经有一台服务器在用了。它是这台服务器的身份，不能重复。', 'id 重复');
        return;
    }
    const entry = {
        id,
        name: String(parsed.name || id).trim(),
        // url 与 command 互斥：填了 url 就清掉 command，避免改了传输方式旧字段还在
        url,
        command: url ? '' : command,
        args: url ? [] : (Array.isArray(parsed.args) ? parsed.args.map(String) : []),
        env: url ? {} : ((parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)) ? parsed.env : {}),
        cwd: url ? '' : String(parsed.cwd || '').trim(),
        // 自定义请求头只对远程有意义；本地进程用 env 传参
        headers: (parsed.headers && typeof parsed.headers === 'object' && !Array.isArray(parsed.headers))
            ? Object.fromEntries(Object.entries(parsed.headers).map(([k, v]) => [String(k), String(v)]))
            : {},
        enabled: isNew ? true : (cur.enabled !== false),
    };
    if (isNew) state.settings.mcpServers.push(entry);
    else state.settings.mcpServers[index] = entry;
    persistSettings();
    // 配置变了 → 先停掉旧连接：不停的话跑的还是旧配置（改 url 后"看不出变化"）
    try {
        await fetch('/api/mcp/stop', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server: id }),
        });
    } catch { /* 服务端没起时忽略 */ }
    const reg = await reloadMcpTools();
    void refreshMcpList();
    if (isNew && reg && reg.ok) {
        showCustomAlert('已添加「' + entry.name + '」' + (reg.count
            ? '，它提供了 ' + reg.count + ' 个工具。\n\nAI 现在可以在需要时调用它们了。'
            : '，但它一个工具都没暴露。\n\n确认那条命令本身能单独跑起来（在终端里试一次）。'),
            'MCP 服务器已添加');
    }
}

