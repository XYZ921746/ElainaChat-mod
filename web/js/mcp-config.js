/* ============================================================================
 * MCP 服务器设置（从 settings.js 拆出）
 *
 * 列表 / 卡片 / 预置 / 导入 / 编辑 / 工具刷新。依赖宿主弹窗与 MCP API。
 * ========================================================================== */
"use strict";

/**
 * 刷新「MCP 服务器」这一栏。
 *
 * 与技能 / 插件列表的关键区别：MCP 服务器是**另一个进程**，所以界面要回答
 *   一个它们不需要回答的问题 —— "这台起来了没有"。状态取自 /api/mcp/status
 *   （**不启动进程**）；工具条数来自已启动的进程，两者分开说：
 *     · 配置里启用了但命令写错 → error + 具体原因（用户能照着改）
 *     · 起来了但一个工具都没暴露 → ready + 0 个工具（那也是有效信息）
 */
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
        // APK 端没有服务端 / 服务没起来：配置仍要能编辑，只是状态未知
        statusError = '本机服务不可用，状态未知';
    }

    if (box) box.innerHTML = servers.length ? '' : ('<div class="text-[11px] text-indigo-300 py-2 text-center">还没有 MCP 服务器。'
        + '点右上角「＋ 添加」：<br>远程填地址（例如 <code>https://example.com/mcp</code>），本地填启动命令（例如 <code>npx -y @modelcontextprotocol/server-filesystem D:/</code>）。</div>');
    if (hint && statusError) {
        hint.textContent = 'MCP 是外部工具服务：本应用当客户端去连它，把它提供的工具并进 AI 的能力清单。'
            + '当前' + statusError + '（配置仍可编辑）。';
        hint.className = 'text-[11px] leading-relaxed mb-3 text-amber-500';
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
    const stateCls = st.state === 'ready' ? 'text-emerald-600'
        : st.state === 'error' ? 'text-red-500' : 'text-indigo-400';
    const card = document.createElement('div');
    card.className = 'mod-card';
    // MCP 卡片含状态行 + 启动命令，属于"信息多、要换行"的那一类 → 网格里独占一行
    card.setAttribute('data-fullwidth', '1');
    const head = document.createElement('div');
    head.className = 'flex items-start gap-2';
    // 用 DOM 组装而不是 innerHTML 拼串：名字与错误原因都来自用户输入 / 外部进程，
    //   拼进 HTML 就有注入面（其它列表是服务端给的可信清单，这里不是）。
    const left = document.createElement('div');
    left.className = 'flex-1 min-w-0';
    const titleRow = document.createElement('div');
    titleRow.className = 'flex items-center gap-2 flex-wrap';
    const nameEl = document.createElement('span');
    nameEl.className = 'text-sm font-medium text-indigo-900 truncate';
    nameEl.textContent = srv.name || srv.id;
    const idEl = document.createElement('span');
    idEl.className = 'text-[10px] px-1.5 py-0.5 rounded bg-white/70 text-indigo-500';
    idEl.textContent = srv.id;
    titleRow.appendChild(nameEl);
    titleRow.appendChild(idEl);
    const stateEl = document.createElement('div');
    stateEl.className = 'text-[11px] mt-1 break-all ' + stateCls;
    stateEl.textContent = stateText;
    const cmdEl = document.createElement('div');
    cmdEl.className = 'text-[11px] text-indigo-400 mt-0.5 break-all';
    const cmdCode = document.createElement('code');
    // 远程显示地址（并标出传输类型），本地显示启动命令 ——
    //   两种配置的"身份"不同，混着显示会让人以为远程也要填命令。
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
        // 停用后必须**立刻**把它的工具从能力清单里摘掉 —— 否则模型还会去调，
        //   调一次失败一次（见 mcp.js 的 registerMcpOps）。
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

/** 重挂 MCP 工具（配置改动后调）。结果不回弹窗 —— 列表里的状态行已经说清了 */
async function reloadMcpTools() {
    if (!window.ElainaMcp || typeof window.ElainaMcp.registerMcpOps !== 'function') return null;
    try { return await window.ElainaMcp.registerMcpOps(); } catch (e) {
        console.warn('[MCP] 重挂工具失败', e);
        return null;
    }
}

/**
 * 添加 / 修改一台 MCP 服务器。
 *
 * 新增与修改共用同一个弹窗（`index < 0` 是新增）。为什么不做卡片内联编辑：
 *   字段有五个（含 args 数组与 env 对象），内联在手机上会把卡片挤成一团。
 *
 * 用 JSON 而不是五个输入框：args 是数组、env 是对象，用表单表达要写一堆解析，
 *   而用户复制一段配置本来就是 JSON（MCP 客户端配置生态里到处都是 json）。
 */
/**
 * MCP 配置的三个模板。
 *
 * 为什么需要：三种传输的字段完全不同（url / command / sse），
 *   第一次配置的人几乎必然填错 —— 选错模板是最常见的"连不上"原因。
 * 点一下直接填好骨架，只需改地址或包名。
 */
/**
 * 在 MCP 弹窗里挂一行"测试结果"（按钮下方）。
 *
 * 为什么不弹窗提示：showCustomAlert 走的是同一个 customModal 队列，
 *   而配置弹窗此刻还开着（customModalActive = true），提示会排队到关闭后才出现 ——
 *   用户点了按钮看不到任何反馈。
 */
function makeTestStatusLine() {
    const box = document.getElementById('customModalEditor');
    const line = document.createElement('div');
    line.className = 'mt-2 text-xs leading-relaxed text-indigo-400';
    line.dataset.mcpTestLine = '1';
    line.textContent = '';
    if (box && box.parentElement) {
        // 先清掉上一轮的结果行：每点一次「测试连接」都新建一行的话，
        //   连点几次就堆成一大片旧结果，分不清哪条是这次的（实测截图里堆了六行）。
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

/**
 * 把一份"外部格式"的 MCP 配置归一成内部条目。
 *
 * 各家客户端的字段名有差异，这里做兼容映射：
 *   · `transport`: "sse" / "http" / "streamable-http" → 我们按 url 判断，忽略；
 *   · `serverUrl` / `baseUrl` → url（Cline / 某些教程用这个名）；
 *   · `args` 可能是字符串（写成 "a b c"）→ 按空格切开；
 *   · `env` 的值可能是数字/布尔 → 统一转字符串（子进程环境变量只能是字符串）。
 * 认不出来的返回 null，由调用方列入"跳过"。
 */
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
    // headers 与 url 同级的两种写法：headers 对象，或 httpUrl + headers
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
            // 也支持直接粘贴带 mcpServers 外壳的格式
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
                // ⚠️ 不能用 showCustomAlert：那也走同一个弹窗队列，而当前弹窗
                //   还开着（customModalActive=true），提示会一直排队不显示。
                //   测试结果直接写在按钮下方一行状态里，不打断编辑。
                const line = api.statusLine || (api.statusLine = makeTestStatusLine());
                if (data && data.ok) {
                    line.textContent = '✓ 连接成功' + name + ' · ' + (data.tools || []).length + ' 个工具'
                        + ((data.tools || []).length ? '：' + (data.tools || []).join('、') : '（没有提供工具）');
                    line.className = 'mt-2 text-xs leading-relaxed text-emerald-600';
                } else {
                    line.textContent = '✗ 连不上' + name + '：' + String((data && data.message) || '未知原因')
                        + '（常见原因：地址写错、令牌无效、需要特定请求头）';
                    line.className = 'mt-2 text-xs leading-relaxed text-red-500';
                }
            } catch (e) {
                const line = api.statusLine || (api.statusLine = makeTestStatusLine());
                line.textContent = '✗ 测试请求发不出去：' + String((e && e.message) || e);
                line.className = 'mt-2 text-xs leading-relaxed text-red-500';
            }
        },
    };
}

function mcpEditorDefaultValue(isNew, preferHttp, cur) {
    // 新增时给一个**能直接跑**的示例，不把空字段都摊出来
    //   （name/cwd/env 大多用不到，列出来会让人以为必须填）。
    //   编辑已有条目时完整回填，否则改一处会把别的值弄丢。
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
    // 与已有配置合并：id 冲突时加后缀，避免覆盖用户原来的服务器
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

/**
 * MCP 配置弹窗（专用，不走通用 showCustomModal）。
 *
 * 为什么单独写：需要「测试连接」按钮 —— 它要读到**当前编辑中的内容**去连一次，
 *   而通用弹窗是"点确定才把值交出来"，拿不到中间态。
 * 其余部分（代码编辑器 / 行号 / 高亮 / 模板）复用 ui.js 里那套 DOM 与逻辑。
 */
async function editMcpServer(index) {
    const isNew = index < 0;
    const cur = isNew
        ? { id: '', name: '', url: '', command: '', args: [], env: {}, cwd: '', headers: {}, enabled: true }
        : (state.settings.mcpServers[index] || {});
    // 远程还是本地：看当前条目有没有 url。新增默认给远程 ——
    //   用户遇到的"别人都是 https 的"就是这一类，而且它不用装 Node。
    const preferHttp = !cur.command || Boolean(cur.url);

    const value = await showCustomModal({
        title: isNew ? '添加 MCP 服务器' : '修改 MCP 服务器',
        message: '填一段 JSON：远程填 url（不用装东西），本地填 command。'
            + '不认识字段就点下面的模板，会自动填好。',
        input: true,
        // 代码编辑器：行号 + 等宽编辑 + 一键模板（零依赖，见 ui.js 的 refreshCodeEditor）
        editor: true,
        language: 'json',
        rows: 14,
        presets: MCP_PRESETS,
        // 「测试连接」：不关窗、不保存，先拿当前内容真连一次。
        //   现在配错了要"保存 → 看状态 → 回来改"三轮，有这个按钮一次就能验证。
        extraAction: makeMcpTestAction(),

        // 新增时给一个**能直接跑**的示例，不把空字段都摊出来
        //   （name/cwd/env 大多用不到，列出来会让人以为必须填）。
        //   编辑已有条目时完整回填，否则改一处会把别的值弄丢。
        defaultValue: mcpEditorDefaultValue(isNew, preferHttp, cur),
    });
    if (value === null || value === undefined) return;

    let parsed;
    try { parsed = JSON.parse(String(value)); } catch (e) {
        showCustomAlert('这段 JSON 解析失败：' + String((e && e.message) || e) + '\n\n请检查引号与逗号。', '配置格式不对');
        return;
    }
    // ── 兼容其它客户端的配置格式 ──
    //   Claude Desktop / Cursor / Cline 都用 {"mcpServers": {"名字": {...}}} 这层外壳。
    //   用户从教程复制粘贴时几乎必然带着它；直接报"缺少连接方式"等于把兼容问题
    //   甩给用户去理解"两种格式的区别"。这里自动展开，并且支持一次导入多台。
    if (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        await importMcpServersShell(parsed);
        return;
    }
    const url = String(parsed && parsed.url || '').trim();
    const command = String(parsed && parsed.command || '').trim();
    // 两者至少有一个：没有 url 也没有 command 的条目连不上，
    //   在这里挡住比让它进列表里显示"未连接"更省事。
    if (!url && !command) {
        showCustomAlert('要么填 url（远程服务），要么填 command（本地进程），否则这台服务器连不上。', '缺少连接方式');
        return;
    }
    if (url && !/^https?:\/\//i.test(url)) {
        showCustomAlert('url 必须以 http:// 或 https:// 开头。填的是：' + url, '地址格式不对');
        return;
    }
    const id = String(parsed.id || '').trim() || ('mcp' + (state.settings.mcpServers.length + 1));
    // id 是身份：服务端按它找配置，重复会让两台服务器互相覆盖
    const dup = state.settings.mcpServers.some((s, i) => i !== index && String(s.id) === id);
    if (dup) {
        showCustomAlert('id「' + id + '」已经有一台服务器在用了。它是这台服务器的身份，不能重复。', 'id 重复');
        return;
    }
    const entry = {
        id,
        name: String(parsed.name || id).trim(),
        // url 与 command 互斥：填了 url 就清掉 command，避免"改了传输方式但旧字段还在"
        url,
        command: url ? '' : command,
        args: url ? [] : (Array.isArray(parsed.args) ? parsed.args.map(String) : []),
        env: url ? {} : ((parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)) ? parsed.env : {}),
        cwd: url ? '' : String(parsed.cwd || '').trim(),
        // 自定义请求头只对远程有意义；本地进程用 env 传参
        headers: (parsed.headers && typeof parsed.headers === 'object' && !Array.isArray(parsed.headers))
            ? Object.fromEntries(Object.entries(parsed.headers).map(([k, v]) => [String(k), String(v)]))
            : {},
        // 新增默认启用：用户刚花力气配好一条，默认关掉只会让他以为没生效
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

