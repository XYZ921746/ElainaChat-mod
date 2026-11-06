// 回合过程区：思考气泡文案、时间线（思考 / 工具 / 阶段输出）与过程区的渲染与还原。
'use strict';

function renderThinkingMessage() {
    if (!elements.conversationHistory) return;
    if (document.getElementById('thinking-bubble')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'thinking-bubble';
    wrapper.className = 'flex gap-3 mb-4 thinking-bubble animate-fade-in-up';
    wrapper.innerHTML = `
        <div class="pixso-chat-avatar" aria-hidden="true">${aiAvatarInnerHtml()}</div>
        <div class="flex-1 min-w-0">
            <div class="bubble-ai rounded-2xl px-4 py-3 inline-flex items-center gap-2.5">
                <span class="thinking-dot"></span>
                <span class="thinking-dot"></span>
                <span class="thinking-dot"></span>
                <span class="thinking-label text-sm ml-1">伊蕾娜正在想...</span>
            </div>
        </div>
    `;
    elements.conversationHistory.appendChild(wrapper);
    elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
}

/** 重试期间气泡还挂着三点动画，用户看不出第二次请求已发出，所以要写在这行文案上；气泡不在就什么都不做。 */
function updateThinkingMessageText(text) {
    const label = document.querySelector('#thinking-bubble .thinking-label');
    if (label) label.textContent = String(text || '');
}

// 思考常含出戏的元叙述，必须与正文分开展示；关掉思考时工具调用仍要显示；全部默认折叠、摘要行常驻。

function createTurnTrace() {
    return {
        // 时间线：思考段与工具调用按发生先后混排，分开放就还原不出「先想什么 → 于是调什么 → 又想什么」。
        timeline: [],
        // 两段式生成（第三人称）的阶段输出：{ index, title, text, at }
        // 第一段 = GM 第三人称叙述，第二段 = 用户实际看到的第一人称正文
        phases: [],
        // 全部思考的拼接：省掉为「这一轮有没有思考」遍历一遍时间线。
        reasoning: '',
        tools: [],
        // 时间线 id 用自增序号：at 作 key 会在同一毫秒撞号，data-key 撞号会让「记住展开过哪一行」错位。
        nextId: 1,
        startedAt: Date.now(),
    };
}

let activeTurnTrace = null;

let activeTurnAnchorId = null;

function beginTurnTrace(anchorMessageId) {
    activeTurnTrace = createTurnTrace();
    activeTurnAnchorId = anchorMessageId ? String(anchorMessageId) : null;
    return activeTurnTrace;
}

/** 连续增量合并进同一段（流式上千个增量逐个建段会让时间线爆炸）；插入工具 / 阶段输出或 phase 变化后另起一段，因果顺序才留得下来。 */
function appendTurnReasoning(delta, phase) {
    if (!activeTurnTrace || !delta) return;
    const text = String(delta);
    const ph = Number.isFinite(phase) ? Number(phase) : null;
    activeTurnTrace.reasoning += text;
    const tl = activeTurnTrace.timeline;
    const last = tl[tl.length - 1];
    // phase 不同必须另起一段：两段的思考是两次独立推理，混成一段会让用户看到「一段思考里前后矛盾」。
    if (last && last.kind === 'reasoning' && last.phase === ph) {
        last.text += text;
    } else {
        tl.push({
            kind: 'reasoning',
            id: 'think-' + activeTurnTrace.nextId++,
            at: Date.now(),
            phase: ph,
            // 段首空白只在建段时去一次，后续增量原样追加：item.text 才能与 DOM 文本严格一致，增量路径靠它做前缀对齐。
            text: text.replace(/^\s+/, ''),
        });
    }
    scheduleTurnProcessRender();
}

/** entry = { kind, title, summary, args, result, state }；kind 选图标与配色，state = running | ok | error | stopped。 */
function recordTurnTool(entry) {
    if (!activeTurnTrace) return null;
    const item = {
        kind: String(entry?.kind || 'others'),
        title: String(entry?.title || '操作'),
        summary: String(entry?.summary || ''),
        args: entry?.args === undefined ? '' : String(entry.args),
        result: entry?.result === undefined ? '' : String(entry.result),
        state: String(entry?.state || 'ok'),
        key: 'tool-' + activeTurnTrace.nextId++,
        at: Date.now(),
        // 渲染版本号：updateTurnTool 每次改动自增，增量渲染靠它 O(1) 判断这一行变没变。
        rev: 0,
        // 计时起点：一轮 Agent 任务里「哪一步慢」是用户唯一能据以判断「是不是卡住了」的信息，只显示「完成」时慢的那一步和快的那一步长得一样。
        startedAt: Date.now(),
        ms: 0
    };
    activeTurnTrace.tools.push(item);
    activeTurnTrace.timeline.push({ kind: 'tool', id: item.key, at: item.at, ref: item });
    scheduleTurnProcessRender();
    return item;
}

/** 阶段输出（两段式生成用）：第 1 段 = GM 第三人称叙述（用户看不到，但它是第 2 段的输入），第 2 段 = 用户看到的正文；两段各留一个可展开的下拉。 */
function recordTurnPhase(entry) {
    if (!activeTurnTrace) return null;
    const item = {
        index: Number(entry?.index) || (activeTurnTrace.phases.length + 1),
        title: String(entry?.title || '阶段输出'),
        text: entry?.text === undefined ? '' : String(entry.text),
        state: String(entry?.state || 'ok'),
        key: 'phase-' + activeTurnTrace.nextId++,
        at: Date.now(),
    };
    activeTurnTrace.phases.push(item);
    activeTurnTrace.timeline.push({ kind: 'phase', id: item.key, at: item.at, ref: item });
    scheduleTurnProcessRender();
    return item;
}

function updateTurnTool(item, patch = {}) {
    if (!item || !activeTurnTrace) return;
    if (patch.state !== undefined) item.state = String(patch.state);
    if (patch.result !== undefined) item.result = String(patch.result);
    if (patch.summary !== undefined) item.summary = String(patch.summary);
    // 标题与类型允许后补：走工具通道时外层先按「调用 save_file」记一行，真正的动作含义要等进入 doAgentFile 才知道。
    if (patch.title !== undefined) item.title = String(patch.title);
    if (patch.kind !== undefined) item.kind = String(patch.kind);
    // 渲染版本自增：增量渲染据此只重建这一行，而不是整个过程区。
    item.rev = (item.rev || 0) + 1;
    // 重开计时：用户做决定的时间不是这一步的执行耗时；调用方在真正重发执行那一刻带 resetTimer。
    if (patch.resetTimer === true) {
        item.startedAt = Date.now();
        item.ms = 0;
    }
    if (item.state !== 'running' && item.startedAt && !item.ms) {
        item.ms = Math.max(0, Date.now() - item.startedAt);
    }
    scheduleTurnProcessRender();
}

/** 增量渲染合并到每帧一次：流式每来一个 token 就重建一次 DOM，一次长回复上千个增量会让页面明显卡顿。 */
let turnProcessRenderScheduled = false;
function scheduleTurnProcessRender() {
    if (turnProcessRenderScheduled) return;
    turnProcessRenderScheduled = true;
    const run = () => { turnProcessRenderScheduled = false; renderTurnProcess(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
}

function processIconSvg(kind) {
    const paths = {
        read: '<path stroke-linecap="round" stroke-linejoin="round" d="M4 5.5A2.5 2.5 0 016.5 3H20v15H6.5A2.5 2.5 0 004 20.5z"/><path stroke-linecap="round" d="M4 5.5v15"/>',
        write: '<path stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9a2.1 2.1 0 10-3-3L5 17v3z"/>',
        search: '<circle cx="11" cy="11" r="6"/><path stroke-linecap="round" d="M20 20l-4.3-4.3"/>',
        command: '<rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M7 9l3 3-3 3M13 15h4"/>',
        phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path stroke-linecap="round" d="M10.5 18.5h3"/>',
        file: '<path stroke-linecap="round" stroke-linejoin="round" d="M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V9z"/><path stroke-linecap="round" d="M13 3v6h6"/>',
        think: '<path stroke-linecap="round" stroke-linejoin="round" d="M9.7 17h4.6M12 3a6 6 0 00-3.6 10.8c.7.5 1.1 1.3 1.1 2.2V16h5v-.1c0-.9.4-1.6 1.1-2.2A6 6 0 0012 3z"/>',
        phase: '<path stroke-linecap="round" stroke-linejoin="round" d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path stroke-linecap="round" d="M14 3v5h5M9 13h6M9 17h4"/>',
        browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M3 9h18M7 6.5h.01M9.5 6.5h.01"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 13h8M8 16.5h5"/>',
        others: '<circle cx="12" cy="12" r="8"/><path stroke-linecap="round" d="M12 8v4.5l2.5 1.5"/>'
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${paths[kind] || paths.others}</svg>`;
}

function processStateLabel(state) {
    if (state === 'running') return '运行中';
    if (state === 'error') return '失败';
    if (state === 'stopped') return '已停止';
    return '完成';
}

/** 耗时 → 短文案。阈值 100ms 而不是 1 秒：Agent 单步常在几十到几百毫秒之间，用 1 秒当门槛等于绝大多数步骤都不显示耗时。 */
function processDurationLabel(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 100) return '';
    if (n < 1000) return Math.round(n) + 'ms';
    if (n < 10000) return (n / 1000).toFixed(1) + 's';
    if (n < 60000) return Math.round(n / 1000) + 's';
    return Math.floor(n / 60000) + 'm' + Math.round((n % 60000) / 1000) + 's';
}

/** 参数里最要紧的是 path / command 这类值，一整行 JSON 会让它们淹没在花括号和逗号里；解析不出来就原样返回单条。 */
function processArgEntries(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];
    let obj;
    try { obj = JSON.parse(text); } catch { return [{ key: '', value: text }]; }
    if (!obj || typeof obj !== 'object') return [{ key: '', value: text }];
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
        let val;
        if (typeof v === 'string') val = v;
        else if (v === null || v === undefined) val = '';
        else { try { val = JSON.stringify(v); } catch { val = String(v); } }
        out.push({ key: k, value: val });
    }
    return out;
}

function processArgsHtml(raw) {
    const entries = processArgEntries(raw);
    if (!entries.length) return '';
    const rows = entries.map((e) => {
        const long = e.value.includes('\n') || e.value.length > 80;
        if (long) {
            return `<div class="process-arg process-arg-block">`
                + (e.key ? `<span class="process-arg-key">${escapeHtml(e.key)}</span>` : '')
                + `<pre class="process-arg-value">${escapeHtml(e.value)}</pre></div>`;
        }
        return `<div class="process-arg">`
            + (e.key ? `<span class="process-arg-key">${escapeHtml(e.key)}</span>` : '')
            + `<code class="process-arg-value">${escapeHtml(e.value)}</code></div>`;
    });
    return `<div class="process-args">${rows.join('')}</div>`;
}

/** key 是跨重渲染稳定的行标识：流式期间每帧整体重建会丢 .is-open，用索引会随追加整体后移而错位；点击由容器上的 pointerup 委托承担。 */
function processRowHtml({ kind, key, title, summary, state, bodyHtml, ms }) {
    const dur = processDurationLabel(ms);
    return `
        <div class="process-row" data-state="${escapeHtml(state || 'ok')}" data-kind="${escapeHtml(kind)}" data-key="${escapeHtml(key || kind)}">
            <button type="button" class="process-row-head" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleProcessRow(this);}" aria-expanded="false">
                <span class="process-row-icon" aria-hidden="true">${processIconSvg(kind)}</span>
                <span class="process-state" aria-hidden="true"></span>
                <span class="process-row-title">${escapeHtml(title)}</span>
                ${summary ? `<span class="process-row-summary">${escapeHtml(summary)}</span>` : '<span class="process-row-summary"></span>'}
                ${dur ? `<span class="process-row-duration">${escapeHtml(dur)}</span>` : ''}
                <span class="process-row-status">${escapeHtml(processStateLabel(state))}</span>
                <span class="process-row-chevron" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>
                </span>
            </button>
            <div class="process-row-body">${bodyHtml || ''}</div>
        </div>`;
}

function toggleProcessRow(button) {
    const row = button?.closest?.('.process-row');
    if (!row) return;
    const open = row.classList.toggle('is-open');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/** 过程区的指针统一入口：行元素可能在按下与松开之间被替换，内联 onclick 一个都收不到；容器本身从不重建，委托永远收得到。 */
function onTurnProcessPointerUp(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const target = event.target;
    const head = target?.closest?.('.process-row-head');
    if (head) { toggleProcessRow(head); return; }
    const summary = target?.closest?.('.turn-summary');
    if (summary) toggleTurnProcess(summary);
}

/** 点总览行展开时间线，点时间线里某一条展开其详细内容；指针走 onTurnProcessPointerUp，键盘走内联 onkeydown，两条入口都要生效。 */
function toggleTurnProcess(summaryEl) {
    const host = summaryEl?.closest?.('.turn-process');
    if (!host) return;
    const open = host.classList.toggle('is-expanded');
    summaryEl.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function buildTurnSummaryEntry(summaryBits) {
    return {
        key: 'summary', kind: 'summary',
        // 总览内容只随计数变化（段数 / 各状态的工具数），流式追加期间稳定
        version: summaryBits.join('\u0001'),
        build: () => `<div class="turn-summary" role="button" tabindex="0"`
            + ` aria-expanded="false"`
            + ` onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleTurnProcess(this);}">`
            + summaryBits.map((b) => escapeHtml(b)).join('<span class="turn-summary-sep">·</span>')
            + `<span class="turn-summary-toggle" aria-hidden="true">`
            + `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>`
            + `</span></div>`,
    };
}

function buildTurnReasoningEntry(item, live) {
    return {
        key: item.id, kind: 'reasoning',
        // 版本 O(1)：状态（running→ok）+ 文本长度（段内只追加，长度即变化）
        version: (live ? 'running' : 'ok') + '#' + item.text.length,
        // 原文交给应用阶段做增量追加（与 DOM 文本严格同源，见 applyTurnProcessEntries）
        text: item.text,
        build: () => {
            // firstLine 只取有界前缀来算：整段 split 是 O(n)/帧
            const firstLine = item.text.slice(0, 200).split('\n').map((l) => l.trim()).find(Boolean) || '思考中';
            // 阶段标签：两段式生成时让用户知道这段思考属于哪一步
            const phaseNote = item.phase ? `（第 ${item.phase} 阶段）` : '';
            return processRowHtml({
                kind: 'think',
                key: item.id,
                title: '思考' + phaseNote,
                summary: firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine,
                // 最后一段思考且回合未结束时才是"运行中"，中间的段落都已结束
                state: live ? 'running' : 'ok',
                // 不 trim：DOM 文本必须与 item.text 逐字一致，增量追加的前缀对齐才成立。
                bodyHtml: `<div class="process-reasoning">${escapeHtml(item.text)}</div>`
            });
        },
    };
}

function buildTurnPhaseEntry(item) {
    const ph = item.ref || {};
    const phText = String(ph.text || '');
    return {
        key: item.id, kind: 'phase',
        version: String(ph.state || 'ok') + '#' + phText.length,
        build: () => {
            const text = phText.trim();
            const firstLine = text.slice(0, 200).split('\n').map((l) => l.trim()).find(Boolean) || '（空）';
            return processRowHtml({
                kind: 'phase',
                key: item.id,
                title: ph.title || ('第 ' + ph.index + ' 阶段输出'),
                summary: firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine,
                state: ph.state || 'ok',
                bodyHtml: `<div class="process-row-label">完整输出</div><pre class="process-phase-text">${escapeHtml(text)}</pre>`
            });
        },
    };
}

function buildTurnToolEntry(t, key) {
    return {
        key, kind: 'tool',
        // 工具行有专门的 rev 计数（updateTurnTool 每次改动自增），状态 / 耗时一并进版本：任何真实更新都会让版本变化。
        version: (t.rev || 0) + '#' + t.state + '#' + t.ms,
        build: () => {
            const body = [];
            // 参数拆成键值行（见 processArgsHtml）：整行 JSON 会把 path / command 这类真正要紧的值埋进花括号里。
            if (t.args) body.push(`<span class="process-row-label">参数</span>${processArgsHtml(t.args)}`);
            if (t.result) body.push(`<span class="process-row-label">结果</span><pre>${escapeHtml(t.result)}</pre>`);
            return processRowHtml({
                kind: t.kind,
                key,
                title: t.title,
                summary: t.summary,
                state: t.state,
                ms: t.ms,
                bodyHtml: body.join('')
            });
        },
    };
}

function renderTurnProcess() {
    if (!elements.conversationHistory) return;
    const trace = activeTurnTrace;
    if (!trace) return;

    const showReasoning = Boolean(state.settings.thinkingMode);

    const anchorId = activeTurnAnchorId ? `turn-process-${safeAttrId(activeTurnAnchorId)}` : 'turn-process-active';
    let host = document.getElementById(anchorId);
    if (!host) {
        host = document.createElement('div');
        host.id = anchorId;
        host.className = 'turn-process';
        // 流式增量到来时 AI 气泡还不存在，按「插在气泡前面」挂不了；最终顺序是「用户消息 → 过程 → 正文」。
        elements.conversationHistory.appendChild(host);
    }
    // pointerup 委托只绑一次：host 从不重建、只换子节点，data 标记防重复（本函数每帧都会走到这里）。
    if (!host.dataset.pointerWired) {
        host.dataset.pointerWired = '1';
        host.addEventListener('pointerup', onTurnProcessPointerUp);
    }

    // 只登记「有哪些行、版本号、怎么构建」：最后一行之外通常没有变化，每帧成本因此从 O(思考总长) 降到 O(增量)。
    const timeline = trace.timeline.filter((item) => item.kind !== 'reasoning' || showReasoning);
    const visibleReasoning = timeline.filter((item) => item.kind === 'reasoning');
    const hasReasoning = visibleReasoning.length > 0;
    const hasTools = trace.tools.length > 0;
    const hasPhases = trace.phases.length > 0;
    if (!hasReasoning && !hasTools && !hasPhases) return;

    const counts = { ok: 0, error: 0, running: 0, stopped: 0 };
    for (const t of trace.tools) counts[t.state] = (counts[t.state] || 0) + 1;
    const summaryBits = [];
    // 思考段数只在多于一段时报出来（一段时「已思考」就够了，报「1 段思考」反而啰嗦）。
    if (hasReasoning) summaryBits.push(visibleReasoning.length > 1 ? `${visibleReasoning.length} 段思考` : '已思考');
    if (hasPhases) summaryBits.push(`${trace.phases.length} 段阶段输出`);
    if (counts.ok) summaryBits.push(`${counts.ok} 个操作完成`);
    if (counts.error) summaryBits.push(`${counts.error} 个失败`);
    if (counts.running) summaryBits.push(`${counts.running} 个进行中`);
    if (counts.stopped) summaryBits.push(`${counts.stopped} 个已停止`);

    const entries = [];
    if (summaryBits.length) entries.push(buildTurnSummaryEntry(summaryBits));

    const lastTimelineItem = timeline[timeline.length - 1];
    for (const item of timeline) {
        if (item.kind === 'reasoning') {
            // 空白段跳过：/\S/ 只扫到第一个非空白字符就停，不会复制整段文本
            if (!/\S/.test(item.text)) continue;
            const live = !trace.done && item === lastTimelineItem;
            entries.push(buildTurnReasoningEntry(item, live));
            continue;
        }
        if (item.kind === 'phase') {
            entries.push(buildTurnPhaseEntry(item));
            continue;
        }
        if (item.kind === 'tool') {
            entries.push(buildTurnToolEntry(item.ref || {}, item.id));
            continue;
        }
    }
    if (!entries.some((e) => e.kind !== 'summary')) {
        for (const t of trace.tools) {
            entries.push(buildTurnToolEntry(t, t.key || `tool-${t.at}`));
        }
    }

    applyTurnProcessEntries(host, entries);

    // 总览行的 is-expanded 在宿主 .turn-process 上，重建 innerHTML 不会清掉它；但新造的总览元素 aria-expanded 默认 false，这里同步一下，免得辅助技术读到「已收起」与视觉不符。
    const summaryEl = host.querySelector('.turn-summary');
    if (summaryEl) summaryEl.setAttribute('aria-expanded', host.classList.contains('is-expanded') ? 'true' : 'false');

    stickChatScrollToBottom();
    // 返回容器：还原历史过程区时要把它挪到对应消息后面（见 restoreTurnProcessFor）
    return host;
}

/** 只在用户本来就停在底部附近时才自动滚底（距底 < 80px），否则会把往上翻历史的用户每帧拽回底部。 */
function stickChatScrollToBottom() {
    const hist = elements.conversationHistory;
    if (!hist) return;
    const distance = hist.scrollHeight - hist.scrollTop - hist.clientHeight;
    if (distance < 80) hist.scrollTop = hist.scrollHeight;
}

/** 过程区渲染的性能核心：按版本号跳过没变的行、思考行只 appendData(增量)，成本只与增量成正比。 */
function rebuildTurnProcess(host, entries) {
    // 整体重建会丢掉 .is-open：覆盖前先快照展开过的行（data-key），重建后补回，否则新内容一来已展开的思考行又被折叠。
    const openKeys = new Set();
    for (const row of host.querySelectorAll('.process-row.is-open')) {
        const k = row.getAttribute('data-key');
        if (k) openKeys.add(k);
    }
    // 行内滚动位置也要快照：思考正文 / 结果的 pre 带 max-height + overflow，重建会把 scrollTop 静默重置为 0。
    const scrollMemory = new Map();
    for (const row of host.querySelectorAll('.process-row')) {
        const k = row.getAttribute('data-key');
        if (!k) continue;
        const tops = [];
        for (const scroller of row.querySelectorAll('.process-row-body pre, .process-reasoning')) {
            if (scroller.scrollTop > 0) tops.push(scroller.scrollTop);
        }
        if (tops.length) scrollMemory.set(k, tops);
    }
    host.innerHTML = entries.map((e) => e.build()).join('');
    if (openKeys.size) {
        for (const row of host.querySelectorAll('.process-row')) {
            if (!openKeys.has(row.getAttribute('data-key'))) continue;
            row.classList.add('is-open');
            const head = row.querySelector('.process-row-head');
            if (head) head.setAttribute('aria-expanded', 'true');
        }
    }
    if (scrollMemory.size) {
        for (const row of host.querySelectorAll('.process-row')) {
            const tops = scrollMemory.get(row.getAttribute('data-key'));
            if (!tops) continue;
            const scrollers = row.querySelectorAll('.process-row-body pre, .process-reasoning');
            tops.forEach((top, i) => { if (scrollers[i]) scrollers[i].scrollTop = top; });
        }
    }
}

function updateTurnProcessRows(host, entries, prev) {
    // 快路径：只动「变了」的行
    const children = host.children;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (i < prev.versions.length && prev.versions[i] === entry.version) continue;
        if (i >= children.length) {
            host.insertAdjacentHTML('beforeend', entry.build());
            continue;
        }
        const old = children[i];
        // 思考行只是文本变长：往文本节点追加增量，展开态与行内滚动天然保留；前缀对不上就走下面的整行替换，宁慢勿错。
        if (entry.kind === 'reasoning' && prev.kinds[i] === 'reasoning') {
            const bodyEl = old.querySelector('.process-reasoning');
            const node = bodyEl && bodyEl.firstChild;
            if (node && node.nodeType === 3   // Text 节点
                && entry.text.length > node.data.length
                && entry.text.startsWith(node.data)) {
                node.appendData(entry.text.slice(node.data.length));
                continue;
            }
        }
        const wasOpen = old.classList.contains('is-open');
        const tops = [];
        if (wasOpen) {
            for (const sc of old.querySelectorAll('.process-row-body pre, .process-reasoning')) {
                tops.push(sc.scrollTop);
            }
        }
        old.outerHTML = entry.build();
        const now = children[i];
        if (wasOpen && now) {
            now.classList.add('is-open');
            const head = now.querySelector('.process-row-head');
            if (head) head.setAttribute('aria-expanded', 'true');
            const scs = now.querySelectorAll('.process-row-body pre, .process-reasoning');
            tops.forEach((top, j) => { if (scs[j]) scs[j].scrollTop = top; });
        }
    }
}

function applyTurnProcessEntries(host, entries) {
    const prev = host.__elainaRows || null;
    const children = host.children;
    const fastPath = prev
        && prev.keys.length <= entries.length
        && children.length === prev.keys.length
        && prev.keys.every((k, i) => k === entries[i].key);

    if (fastPath) updateTurnProcessRows(host, entries, prev);
    else rebuildTurnProcess(host, entries);

    host.__elainaRows = {
        keys: entries.map((e) => e.key),
        versions: entries.map((e) => e.version),
        kinds: entries.map((e) => e.kind),
    };
}

/** 过程区是追加到聊天容器末尾的临时 DOM，loadConversation 会清空容器；收尾时把记录挂到 msg.turnTrace，重画时还原（存数据不存 HTML）。 */
function finishTurnTrace() {
    if (!activeTurnTrace) return;
    activeTurnTrace.done = true;
    renderTurnProcess();
    const anchorId = activeTurnAnchorId;
    if (anchorId) {
        try {
            const conv = typeof getCurrentConversation === 'function' ? getCurrentConversation() : null;
            const msg = conv && Array.isArray(conv.messages)
                ? conv.messages.find((m) => String(m.id) === String(anchorId))
                : null;
            if (msg) {
                msg.turnTrace = {
                    timeline: activeTurnTrace.timeline,
                    reasoning: activeTurnTrace.reasoning,
                    tools: activeTurnTrace.tools,
                    phases: activeTurnTrace.phases,
                    done: true,
                    startedAt: activeTurnTrace.startedAt,
                };
                if (typeof saveConversations === 'function') saveConversations();
            }
        } catch (e) { /* 持久化失败不该影响回合收尾 */ }
    }
}

/** 走同一个 renderTurnProcess，只把数据源换成消息上存的那份 —— 折叠与展开态恢复天然一致。 */
function restoreTurnProcessFor(message) {
    const saved = message && message.turnTrace;
    if (!saved || !Array.isArray(saved.timeline) || !saved.timeline.length) return;
    const el = document.getElementById(`msg-${safeAttrId(message.id)}`);
    if (!el) return;
    if (document.getElementById(`turn-process-${safeAttrId(message.id)}`)) return;
    const prevTrace = activeTurnTrace;
    const prevAnchor = activeTurnAnchorId;
    try {
        activeTurnTrace = saved;
        activeTurnAnchorId = String(message.id);
        const host = renderTurnProcess();
        const hostEl = document.getElementById(`turn-process-${safeAttrId(message.id)}`);
        if (hostEl && hostEl.previousSibling !== el) {
            if (el.nextSibling) el.parentNode.insertBefore(hostEl, el.nextSibling);
            else el.parentNode.appendChild(hostEl);
        }
    } catch (e) { /* 还原失败不该挡住消息渲染 */ }
    finally {
        activeTurnTrace = prevTrace;
        activeTurnAnchorId = prevAnchor;
    }
}

function removeThinkingMessage() {
    const el = document.getElementById('thinking-bubble');
    if (el) {
        el.style.transition = 'opacity 0.2s ease-out, transform 0.2s ease-out';
        el.style.opacity = '0';
        el.style.transform = 'translateY(-4px)';
        setTimeout(() => el.remove(), 200);
    }
    state.thinkingMessageId = null;
}

let activeVoicePlayerId = null;
let activeVoicePlaybackStatus = 'idle';
let voicePlaybackGeneration = 0;
let voicePlaybackStartGeneration = 0;
let activeVoiceSession = null;
