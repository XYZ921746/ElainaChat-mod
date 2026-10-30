/* ============================================================================
 * 消息回合过程 / Turn Process（从 ui.js 拆出）
 *
 * 思考气泡、回合追踪、工具/阶段行、过程区渲染与还原。
 * 依赖消息 DOM、state 与时间线数据（运行时才调用）。
 * ========================================================================== */
'use strict';

function renderThinkingMessage() {
    if (!elements.conversationHistory) return;
    if (document.getElementById('thinking-bubble')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'thinking-bubble';
    wrapper.className = 'flex gap-3 mb-4 thinking-bubble animate-fade-in-up';
    wrapper.innerHTML = `
        <div class="pixso-chat-avatar" aria-hidden="true">
            <img src="/icons/icon-192.png" alt="" draggable="false">
        </div>
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

/**
 * 更新「正在想」气泡上的文案（超时重试等场景的提示）。
 *
 * 为什么需要它：重试期间的等待对用户是完全黑箱的 —— 气泡还挂着三点动画，
 * 看不出「第二次请求已经发出」。把状态写在这行文案上，用户就能知道
 * 「不是卡死，是网络不稳正在重试」。气泡不在（已被收掉）就什么都不做。
 */
function updateThinkingMessageText(text) {
    const label = document.querySelector('#thinking-bubble .thinking-label');
    if (label) label.textContent = String(text || '');
}

//  回合过程渲染：思考行 + 工具调用行 + 每回合总览
// 为什么要有这一整块，而不是"把 reasoning 拼到气泡里"：
//   ① 角色扮演应用里，模型思考内容经常包含"我不该直接回答这个"这类
//      出戏的元叙述，混进正文会破坏体验 —— 必须分开展示；
//   ② 关掉思考开关时，工具调用记录**仍然要显示**（用户的原话：
//      "思考模式关闭的情况下思维链还是要显示工具调用的"）——
//      因为那是"AI 干了什么"的事实记录，不是思考过程；
//   ③ 需要"每回合总览"：用户想知道这一轮 AI 到底做了什么，
//      而不是逐行读每一条调用。
// 折叠策略（参考 DSH）：全部默认折叠，摘要行常驻。
// 理由：这是聊天应用，正文才是主角；思考动辄上千字，默认展开会把对话顶走。

/** 一次回合（= 一条 AI 回复的处理过程）的记录容器 */
function createTurnTrace() {
    return {
        // 时间线：思考段与工具调用**按发生先后混排**。
        //   为什么不能"全部思考拼成一坨 + 工具另存一列"：
        //   两段式下拉的**第一段**要回答的问题是"它先想了什么、于是调了什么、
        //   然后又想了什么" —— 那是因果顺序。分开存就再也还原不出来了
        //   （纯拼接的 reasoning 字符串 + 一个只有工具的 items 列表，
        //   两者之间的先后关系在存入时就已丢失）。
        //   每一项：{ kind:'reasoning'|'tool'|'phase', id, at, ... }
        //     reasoning → { text }
        //     tool      → { ref } 指向 tools 里的那一项
        //     phase     → { ref } 指向 phases 里的那一项（两段式生成的阶段输出）
        timeline: [],
        // 两段式生成（第三人称）的阶段输出：{ index, title, text, at }
        // 第一段 = GM 第三人称叙述，第二段 = 用户实际看到的第一人称正文
        phases: [],
        // 全部思考的拼接。总览行与"这一轮有没有思考"的判据用它，
        // 避免为了一个布尔判断去遍历时间线。
        reasoning: '',
        tools: [],
        // 时间线元素的稳定 id 来源。用它而不是 at（时间戳）当 key ——
        // 同一毫秒内记两条会撞号，而 data-key 撞号会让"记住用户展开过哪一行"错位。
        nextId: 1,
        startedAt: Date.now(),
    };
}

/** 当前正在进行的回合记录。一条 AI 回复对应一个，回复完成后清空。 */
let activeTurnTrace = null;

/** 本轮过程区要插到哪个消息前面（AI 气泡的 id） */
let activeTurnAnchorId = null;

function beginTurnTrace(anchorMessageId) {
    activeTurnTrace = createTurnTrace();
    activeTurnAnchorId = anchorMessageId ? String(anchorMessageId) : null;
    return activeTurnTrace;
}

/**
 * 追加思考增量。思考开关关着时也允许调用 —— 由渲染层决定显不显示，
 * 而不是由收集层决定收不收：万一用户中途打开开关，已经收到的内容不该是空的。
 *
 * 时间线规则（两段式下拉的"按先后排序"就靠它）：
 *   · 连续的思考增量**合并进同一段**（流式一次回复有上千个增量，
 *     逐个建段会让时间线爆炸）；
 *   · 一旦中间插入了工具调用 / 阶段输出，或**换了阶段**（phase 变化），
 *     下一次思考就另起一段 —— 这样"先想什么→于是调了什么→接着又想什么"
 *     的因果顺序才留得下来。
 *   · 只把所有思考拼成一坨（trace.reasoning）就够显示，
 *     但与工具列表之间的先后关系在存入时就丢了，事后无法还原 ——
 *     所以必须另记时间线（见 createTurnTrace）。
 *
 * @param {string} delta 思考增量
 * @param {number} [phase] 该增量属于第几阶段（两段式生成时由 data 层打标）
 */
function appendTurnReasoning(delta, phase) {
    if (!activeTurnTrace || !delta) return;
    const text = String(delta);
    const ph = Number.isFinite(phase) ? Number(phase) : null;
    activeTurnTrace.reasoning += text;
    const tl = activeTurnTrace.timeline;
    const last = tl[tl.length - 1];
    // phase 不同必须另起一段：两段式生成里第一阶段（GM 叙述）与
    //   第二阶段（第一人称改写）的思考是两次独立的推理，混成一段会让
    //   用户看到"一段思考里前后矛盾"。
    if (last && last.kind === 'reasoning' && last.phase === ph) {
        last.text += text;
    } else {
        tl.push({
            kind: 'reasoning',
            id: 'think-' + activeTurnTrace.nextId++,
            at: Date.now(),
            phase: ph,
            // 段首空白只在**建段时**去一次，后续增量原样追加 ——
            //   这样 item.text 与 DOM 文本节点的内容严格一致（前缀对齐），
            //   renderTurnProcess 的增量路径才能用 appendData 只追增量。
            //   （显示层不再做整体 trim：那会每次复制整段文本，正是卡顿来源之一。）
            text: text.replace(/^\s+/, ''),
        });
    }
    scheduleTurnProcessRender();
}

/**
 * 记录一次工具/操作调用。
 *
 * @param {object} entry { kind, title, summary, args, result, state }
 *   kind    用于选图标与配色：read/write/search/command/phone/file/others
 *   state   running | ok | error | stopped
 *   args    调用参数（展开后显示）
 *   result  执行结果（展开后显示）
 */
function recordTurnTool(entry) {
    if (!activeTurnTrace) return null;
    const item = {
        kind: String(entry?.kind || 'others'),
        title: String(entry?.title || '操作'),
        summary: String(entry?.summary || ''),
        args: entry?.args === undefined ? '' : String(entry.args),
        result: entry?.result === undefined ? '' : String(entry.result),
        state: String(entry?.state || 'ok'),
        // 稳定的时间线 key（见 nextId 的说明）。at 只用于显示相对时间。
        key: 'tool-' + activeTurnTrace.nextId++,
        at: Date.now(),
        // 渲染版本号：updateTurnTool 每次改动自增。增量渲染靠它判断
        //   "这一行变没变"（O(1)），不必每帧重新构建行的 HTML 去比对。
        rev: 0,
        // 计时起点：用于在收尾时算出这一步花了多久。
        //   为什么要显示耗时：一轮 Agent 任务里"哪一步慢"是用户唯一能据以判断
        //   "是不是卡住了"的信息。全部只显示"完成"，慢的那一步和快的那一步长得一样。
        startedAt: Date.now(),
        ms: 0
    };
    activeTurnTrace.tools.push(item);
    // 同时进时间线 —— 这样"思考 1 → 工具 A → 思考 2"的先后顺序才留得下来
    activeTurnTrace.timeline.push({ kind: 'tool', id: item.key, at: item.at, ref: item });
    scheduleTurnProcessRender();
    return item;
}

/**
 * 记录一次**阶段输出**（两段式生成用）。
 *
 * 第三人称模式下，一次回复其实由两条模型输出拼成：
 *   第 1 段 = GM 第三人称叙述（用户看不到，但它是第 2 段的输入）
 *   第 2 段 = 第一人称转换结果（**这才是用户看到的正文**）
 * 用户要求把这两段都留下来、并各有一个可单独展开的下拉 —— 就在这里存。
 *
 * @param {object} entry { index, title, text, state }
 */
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

/** 更新最近一条工具记录的状态/结果（执行完成时回填） */
function updateTurnTool(item, patch = {}) {
    if (!item || !activeTurnTrace) return;
    if (patch.state !== undefined) item.state = String(patch.state);
    if (patch.result !== undefined) item.result = String(patch.result);
    if (patch.summary !== undefined) item.summary = String(patch.summary);
    // 标题与类型允许后补：走工具通道时外层先按"调用 save_file"记一行，
    //   真正的动作含义（"写入文件"）要等进入 doAgentFile 才知道。
    if (patch.title !== undefined) item.title = String(patch.title);
    if (patch.kind !== undefined) item.kind = String(patch.kind);
    // 渲染版本自增：增量渲染据此只重建这一行，而不是整个过程区。
    item.rev = (item.rev || 0) + 1;
    // 重开计时：用户在确认弹窗上做决定的时间**不是这一步的执行耗时**。
    //   不重置的话，一次"等待 17 秒才点允许"会被显示成"命令跑了 20 秒"，
    //   用户会误以为命令执行本身很慢（实测就是这么报的）。调用方在
    //   "用户点了允许、真正重发执行"那一刻带 resetTimer。
    if (patch.resetTimer === true) {
        item.startedAt = Date.now();
        item.ms = 0;
    }
    // 从 running 变成终态的那一刻结算耗时（只结算一次：重复更新不该把时长清零）
    if (item.state !== 'running' && item.startedAt && !item.ms) {
        item.ms = Math.max(0, Date.now() - item.startedAt);
    }
    scheduleTurnProcessRender();
}

/**
 * 增量渲染用 requestAnimationFrame 合并。
 *
 * 不合并的话，流式每来一个 token 就重建一次 DOM —— 一次长回复有上千个增量，
 * 每个都重排一次会让页面明显卡顿（而且越到后面越卡，因为内容越长）。
 * 合并到每帧一次，视觉上完全看不出差别，开销却降了两个数量级。
 */
let turnProcessRenderScheduled = false;
function scheduleTurnProcessRender() {
    if (turnProcessRenderScheduled) return;
    turnProcessRenderScheduled = true;
    const run = () => { turnProcessRenderScheduled = false; renderTurnProcess(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
}

/** 工具类型 → 图标 SVG（内联，避免依赖图标库） */
function processIconSvg(kind) {
    const paths = {
        read: '<path stroke-linecap="round" stroke-linejoin="round" d="M4 5.5A2.5 2.5 0 016.5 3H20v15H6.5A2.5 2.5 0 004 20.5z"/><path stroke-linecap="round" d="M4 5.5v15"/>',
        write: '<path stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9a2.1 2.1 0 10-3-3L5 17v3z"/>',
        search: '<circle cx="11" cy="11" r="6"/><path stroke-linecap="round" d="M20 20l-4.3-4.3"/>',
        command: '<rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M7 9l3 3-3 3M13 15h4"/>',
        phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path stroke-linecap="round" d="M10.5 18.5h3"/>',
        file: '<path stroke-linecap="round" stroke-linejoin="round" d="M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V9z"/><path stroke-linecap="round" d="M13 3v6h6"/>',
        think: '<path stroke-linecap="round" stroke-linejoin="round" d="M9.7 17h4.6M12 3a6 6 0 00-3.6 10.8c.7.5 1.1 1.3 1.1 2.2V16h5v-.1c0-.9.4-1.6 1.1-2.2A6 6 0 0012 3z"/>',
        // 两段式生成的「阶段输出」：用文档图标区分于思考（脑）与工具（齿轮）
        phase: '<path stroke-linecap="round" stroke-linejoin="round" d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path stroke-linecap="round" d="M14 3v5h5M9 13h6M9 17h4"/>',
        // 浏览器：一个窗口 + 地址栏，与"命令"（终端框）区分开
        browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M3 9h18M7 6.5h.01M9.5 6.5h.01"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 13h8M8 16.5h5"/>',
        others: '<circle cx="12" cy="12" r="8"/><path stroke-linecap="round" d="M12 8v4.5l2.5 1.5"/>'
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${paths[kind] || paths.others}</svg>`;
}

/** 状态 → 中文文案 */
function processStateLabel(state) {
    if (state === 'running') return '运行中';
    if (state === 'error') return '失败';
    if (state === 'stopped') return '已停止';
    return '完成';
}

/** 耗时 → 人能一眼读懂的短文案。
 *
 *  阈值定在 **100ms** 而不是 1 秒：Agent 的单步操作（列目录、读文件）本来就常在
 *  几十到几百毫秒之间，用 1 秒当门槛等于"绝大多数步骤都不显示耗时" ——
 *  那就失去意义了。低于 100ms 不显示，是因为那个量级的数字反映的是调度抖动，
 *  不是这一步真的花了多久。
 */
function processDurationLabel(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 100) return '';
    if (n < 1000) return Math.round(n) + 'ms';
    if (n < 10000) return (n / 1000).toFixed(1) + 's';
    if (n < 60000) return Math.round(n / 1000) + 's';
    return Math.floor(n / 60000) + 'm' + Math.round((n % 60000) / 1000) + 's';
}

/**
 * 把参数（一行 JSON）拆成「键 → 值」清单，给时间线渲染成表格。
 *
 * 为什么要拆：Agent 的参数里最要紧的是 `path` / `command` 这类**值**，
 * 而一整行 JSON 恰恰让那个值淹没在花括号和逗号里 —— 用户得自己找。
 * 拆成键值行后，"这一步对哪个文件做了什么"是扫一眼就能读到的。
 *
 * 解析不出来就原样返回单条（宁可难看，也不要吞掉参数）。
 *
 * @param {string} raw JSON 文本
 * @returns {Array<{key:string, value:string}>}
 */
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

/** 渲染参数块（键值 + 长文本值单独成行） */
function processArgsHtml(raw) {
    const entries = processArgEntries(raw);
    if (!entries.length) return '';
    const rows = entries.map((e) => {
        // 长值（文件内容、命令）占一整行，短值（路径、布尔）保持键值并排
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

/** 生成一条过程行的 HTML（思考行 / 工具行通用）。
 *
 *  key：跨重渲染**稳定**的行标识（思考行固定 'think'，工具行 'tool-<at>'）。
 *       渲染层每次流式增量都用 innerHTML 整体重建过程区，重建会丢掉 .is-open，
 *       所以需要一个稳定的 key 才能在重建后把"用户手动展开过的行"重新展开 ——
 *       用索引不行：流式期间会不断追加新的工具行，索引会整体后移，恢复会错位。
 *
 *  点击**不挂内联 onclick**：流式期间本区每帧整体重建（见 renderTurnProcess），
 *       用户按下到松开之间行元素可能已被替换 —— 浏览器只在 mousedown 与
 *       mouseup 目标一致时才派发 click，绑在被替换元素上的 onclick 收不到。
 *       展开交互改由容器上的 pointerup 委托承担（见 onTurnProcessPointerUp），
 *       键盘 Enter/Space 保留内联 —— keydown 是即时事件，不受重建影响。
 *
 *  时间线形状（参考 DSH）：左侧一列竖线 + 节点圆点，把"想 → 做 → 想"串成一条
 *  有先后的流；每一行右侧仍是可展开的细节。竖线由 CSS 画在 .process-row 上，
 *  行与行之间自然接续 —— 所以这里不需要额外的容器元素。
 */
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

/** 展开/收起一条过程行（键盘操作走这里；指针点击见 onTurnProcessPointerUp） */
function toggleProcessRow(button) {
    const row = button?.closest?.('.process-row');
    if (!row) return;
    const open = row.classList.toggle('is-open');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/**
 * 过程区展开/收起的**指针统一入口**：绑在容器（.turn-process）上的 pointerup 委托。
 *
 *   为什么用 pointerup 而不是 click：流式期间过程区每帧整体重建
 *   （renderTurnProcess 的 innerHTML = …），用户按下鼠标到松开之间，
 *   行元素可能已被重建替换 —— 浏览器只在 mousedown 与 mouseup 的目标
 *   一致（或存在共同祖先）时才把 click 派发到行上，而内联 onclick 绑在
 *   被替换的元素上，一个事件都收不到。表现是「AI 正在思考/输出时，
 *   思考行怎么点都没反应」，流式一停又能点开 —— 也就是"时好时坏"。
 *   pointerup 直接派发到松开那一刻所在的元素并冒泡，而容器本身从不被
 *   重建（只换它的子节点），所以委托永远收得到。
 */
function onTurnProcessPointerUp(event) {
    // 只认主键：右键/中键的松开不是"点击"（contextmenu 另算）
    if (event.button !== undefined && event.button !== 0) return;
    const target = event.target;
    const head = target?.closest?.('.process-row-head');
    if (head) { toggleProcessRow(head); return; }
    const summary = target?.closest?.('.turn-summary');
    if (summary) toggleTurnProcess(summary);
}

/**
 * 展开/收起**整个过程区**（总览行是这一层的开关）。
 *
 * 两段式下拉：
 *   第一段（点总览行）→ 展开**时间线**：思考段落与工具调用按发生先后排列；
 *   第二段（点时间线里某一条）→ 展开那条的**详细内容**：
 *     · 思考条 → 完整思考文本
 *     · 工具条 → 参数 / 结果（与 Agent 工具卡片一致）
 *     · 阶段条 → 该阶段的完整输出文本
 *
 * 指针点击经 onTurnProcessPointerUp（容器委托），键盘走内联 onkeydown ——
 * 两条入口最终都到这里。为什么必须两端都生效：桌面 CSS 里 is-expanded 只影响
 * 布局，若只对**手机**接线，桌面上就是一个"看着能点、点了没用"的死三角。
 * 箭头因此常驻（见 index.html 的 .turn-summary-toggle 规则）。
 */
function toggleTurnProcess(summaryEl) {
    const host = summaryEl?.closest?.('.turn-process');
    if (!host) return;
    const open = host.classList.toggle('is-expanded');
    summaryEl.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/**
 * 把当前回合的过程渲染到界面上。
 *
 * 渲染目标：`#turn-process-<锚点消息 id>`。锚点就是 AI 气泡的 id，
 * 过程区插在它**前面** —— 这样用户先看到"AI 做了什么/想了什么"，
 * 再看到正文，符合阅读顺序（DSH 也是这个顺序）。
 */
/** 总览行：只随计数变化，流式追加期间版本稳定。 */
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

/** 思考行：版本 = 状态 + 文本长度（段内只追加，长度即变化）。 */
function buildTurnReasoningEntry(item, live) {
    return {
        key: item.id, kind: 'reasoning',
        // 版本 O(1)：状态（running→ok）+ 文本长度（段内只追加，长度即变化）
        version: (live ? 'running' : 'ok') + '#' + item.text.length,
        // 原文交给应用阶段做增量追加（与 DOM 文本严格同源，见 applyTurnProcessEntries）
        text: item.text,
        build: () => {
            // firstLine 只取有界前缀来算：旧写法 split 整段是 O(n)/帧
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
                // 注意：不 trim。DOM 文本必须与 item.text 逐字一致，
                // 增量追加的前缀对齐才成立（段首空白已在建段时去过，见 appendTurnReasoning）
                bodyHtml: `<div class="process-reasoning">${escapeHtml(item.text)}</div>`
            });
        },
    };
}

/** 阶段输出行：完整原文进 pre，保留换行。 */
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
                // 阶段输出是**完整原文**：用 pre 保留换行，方便对照
                bodyHtml: `<div class="process-row-label">完整输出</div><pre class="process-phase-text">${escapeHtml(text)}</pre>`
            });
        },
    };
}

/** 工具行：版本含 rev / 状态 / 耗时；参数拆成键值行，结果进 pre。 */
function buildTurnToolEntry(t, key) {
    return {
        key, kind: 'tool',
        // 工具行有专门的 rev 计数（updateTurnTool 每次改动自增），
        // 状态/耗时一并进版本：任何真实更新都会让版本变化
        version: (t.rev || 0) + '#' + t.state + '#' + t.ms,
        build: () => {
            const body = [];
            // 参数拆成键值行（见 processArgsHtml 的说明）：整行 JSON 会把
            //   `path` / `command` 这类真正要紧的值埋进花括号里，得自己找。
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

    // 思考开关只决定**思考段落**显不显示（见下方 timeline 的过滤）。
    // 工具调用无条件显示 —— 那是"AI 干了什么"的事实记录，
    // 关掉思考不代表用户可以不知道 AI 动了哪些文件。
    const showReasoning = Boolean(state.settings.thinkingMode);

    const anchorId = activeTurnAnchorId ? `turn-process-${safeAttrId(activeTurnAnchorId)}` : 'turn-process-active';
    let host = document.getElementById(anchorId);
    if (!host) {
        host = document.createElement('div');
        host.id = anchorId;
        host.className = 'turn-process';
        // 追加到容器末尾。
        //   时序：用户气泡先渲染 → 流式增量到来 → 过程区这时才创建。
        //   此时 AI 气泡**还不存在**，所以不能按"插在 AI 气泡前面"来挂；
        //   用用户消息 id 当锚点 insertBefore 会把过程区插到
        //   **用户气泡上面**（已思考横条出现在"在吗"上面）。
        //   直接 appendChild 到末尾：过程区排在用户气泡之后；
        //   AI 气泡回复完成时 appendChild 到末尾，自然排在过程区之后
        //   —— 最终顺序正好是「用户消息 → 思考/过程 → AI 正文」。
        elements.conversationHistory.appendChild(host);
    }
    // 展开交互的 pointerup 委托只绑一次（见 onTurnProcessPointerUp 的说明）：
    // host 从不被重建、只换子节点，绑在它身上的监听在整个回合里持续有效；
    // data 标记防重复 —— 本函数每帧都会走到这里。
    if (!host.dataset.pointerWired) {
        host.dataset.pointerWired = '1';
        host.addEventListener('pointerup', onTurnProcessPointerUp);
    }

    // ---- 收集条目（**不构建 HTML**）----
    // 性能关键：只登记「有哪些行、版本号、真要渲染时怎么构建」。构建一行的成本随文本长度走
    //   （escapeHtml + HTML 解析），而流式期间每帧真正变化的通常只有**最后一行思考**；
    //   版本号是 O(1) 的（长度 / 状态 / 工具行的 rev 计数），没变的行在应用阶段直接跳过 ——
    //   每帧成本从 O(思考总长) 降到 O(增量)。
    const timeline = trace.timeline.filter((item) => item.kind !== 'reasoning' || showReasoning);
    const visibleReasoning = timeline.filter((item) => item.kind === 'reasoning');
    const hasReasoning = visibleReasoning.length > 0;
    const hasTools = trace.tools.length > 0;
    const hasPhases = trace.phases.length > 0;
    if (!hasReasoning && !hasTools && !hasPhases) return;

    const counts = { ok: 0, error: 0, running: 0, stopped: 0 };
    for (const t of trace.tools) counts[t.state] = (counts[t.state] || 0) + 1;
    const summaryBits = [];
    // 思考段数只在**多于一段**时报出来（一段时"已思考"就够了，
    // 报"1 段思考"反而啰嗦）
    if (hasReasoning) summaryBits.push(visibleReasoning.length > 1 ? `${visibleReasoning.length} 段思考` : '已思考');
    if (hasPhases) summaryBits.push(`${trace.phases.length} 段阶段输出`);
    if (counts.ok) summaryBits.push(`${counts.ok} 个操作完成`);
    if (counts.error) summaryBits.push(`${counts.error} 个失败`);
    if (counts.running) summaryBits.push(`${counts.running} 个进行中`);
    if (counts.stopped) summaryBits.push(`${counts.stopped} 个已停止`);

    const entries = [];
    // ---- 第一段：总览行（点它展开时间线）----
    // 思考开关：只控制**思考段落**是否显示。
    // 工具调用无条件显示 —— 那是"AI 干了什么"的事实记录，
    // 关掉思考不代表用户可以不知道 AI 动了哪些文件。
    if (summaryBits.length) entries.push(buildTurnSummaryEntry(summaryBits));

    // ---- 时间线：思考段落 / 工具调用 / 阶段输出，**按发生先后**排列 ----
    // 每一条自己再是一个可展开的 .process-row。不能把「全部思考」合成一行、工具另起若干行 —— 那样先后因果全丢了。
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
    // 兜底：时间线为空但确有内容（例如历史数据结构不完整）时，
    // 至少把工具列出来，不让过程区变成空白。
    if (!entries.some((e) => e.kind !== 'summary')) {
        for (const t of trace.tools) {
            entries.push(buildTurnToolEntry(t, t.key || `tool-${t.at}`));
        }
    }

    // 应用到 DOM：能增量就增量（见 applyTurnProcessEntries 的说明）
    applyTurnProcessEntries(host, entries);

    // 总览行的 is-expanded 在**宿主** .turn-process 上，重建 innerHTML 不会清掉它
    //   （只换子节点），所以手机端的整体展开态天然保留；但总览元素本身是新造的、
    //   aria-expanded 默认 false，这里同步一下，免得辅助技术读到"已收起"与视觉不符。
    const summaryEl = host.querySelector('.turn-summary');
    if (summaryEl) summaryEl.setAttribute('aria-expanded', host.classList.contains('is-expanded') ? 'true' : 'false');

    stickChatScrollToBottom();
    // 返回容器：还原历史过程区时要把它挪到对应消息后面（见 restoreTurnProcessFor）
    return host;
}

/**
 * 聊天区"贴底跟随"：只在用户本来就停在底部附近时才自动滚动。
 *
 * 无条件滚底会把"流式期间往上翻历史"的用户每帧都拽回底部（用户实测）。
 * 判据"距底 < 80px"覆盖两种情况：
 *   · 用户正跟着流看（本来就贴底）→ 新内容出现后距离恰是一帧增量的高度，
 *     继续贴底，观感不变；
 *   · 用户往上翻了 → 距离远大于阈值，不再打扰，随便翻。
 * 过程区与流式正文预览共用这一份 —— 两处各写一遍必然有一处走样。
 */
function stickChatScrollToBottom() {
    const hist = elements.conversationHistory;
    if (!hist) return;
    const distance = hist.scrollHeight - hist.scrollTop - hist.clientHeight;
    if (distance < 80) hist.scrollTop = hist.scrollHeight;
}

/**
 * 把条目描述符应用到过程区容器 —— 过程区渲染的**性能核心**。
 *
 * ── 为什么需要增量 ─────────────────────────────────────────────────────
 * 旧实现每帧 `host.innerHTML = 全部内容`：对全部思考文本做 6 趟正则转义、
 * 整块 HTML 解析、全部子树节点重建。思考越长每帧越贵 —— 用户实测
 * "思考内容一长（内部滚动条出现后）就开始卡顿"。rAF 合并只压低了频率，
 * 每帧的成本仍是 O(思考总长)。
 *
 * ── 两条路径 ───────────────────────────────────────────────────────────
 * 快路径（常态：时间线只增长、行序是上次的**前缀**）：
 *   · 版本没变的行直接跳过（O(1) 比对）；
 *   · 思考行只是文本变长 → 往它的**文本节点 appendData(增量)**：元素本身
 *     不动，展开态与行内滚动位置天然保留，且每帧成本只与**增量**成正比，
 *     与思考总长无关 —— 这是修"越长越卡"的关键一步；
 *   · 其它变化（工具状态翻转 / 结果回填）→ 只换那一行（outerHTML），
 *     换前快照展开态与行内滚动、换后回填。
 * 慢路径（首次渲染 / 思考开关切换导致行集变化 / 行序不符 / DOM 与记录不同步）：
 *   整体重建 + 快照回填展开态与滚动位置（与旧实现一致，一次性的成本可接受）。
 *
 * 状态记录挂在 host 元素自身（`__elainaRows`）：host 按锚点消息 id 命名、
 * 每回合一个，loadConversation 清空容器时随之丢弃，不会串台。
 */
function rebuildTurnProcess(host, entries) {
    // ---- 慢路径：整体重建 ----
    // 重建会丢掉 toggleProcessRow 加上的 .is-open，所以覆盖前先快照「用户手动展开过」的行（data-key），重建后补回；
    //   否则表现为「每来一段新内容，已展开的思考行又被折叠」。
    const openKeys = new Set();
    for (const row of host.querySelectorAll('.process-row.is-open')) {
        const k = row.getAttribute('data-key');
        if (k) openKeys.add(k);
    }
    // 各行详情内部的滚动位置同样要快照：思考正文 / 结果 pre 都有
    //   max-height + overflow:auto，重建会把 scrollTop 静默重置为 0 ——
    //   表现为"流式期间一滑就弹回最上面"。行内滚动容器的出现顺序是
    //   确定性的（HTML 由本函数生成），按 key + 序号对应即可。
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
    // 恢复展开态：只补回快照里出现过的 key（新行保持默认收起）
    if (openKeys.size) {
        for (const row of host.querySelectorAll('.process-row')) {
            if (!openKeys.has(row.getAttribute('data-key'))) continue;
            row.classList.add('is-open');
            const head = row.querySelector('.process-row-head');
            if (head) head.setAttribute('aria-expanded', 'true');
        }
    }
    // 恢复行内滚动位置。恢复不了（行没了）就什么都不做。
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
    // ---- 快路径：只动"变了"的行 ----
    const children = host.children;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (i < prev.versions.length && prev.versions[i] === entry.version) continue;
        if (i >= children.length) {
            // 新行（时间线增长了）：追加到末尾
            host.insertAdjacentHTML('beforeend', entry.build());
            continue;
        }
        const old = children[i];
        // 思考行只是文本变长：往文本节点追加增量。元素本身不动 ——
        //   展开/折叠、行内滚动天然保留，成本只与增量成正比。
        //   前缀对齐是硬判据：对不上（理论不该发生）就走下面的整行替换，宁慢勿错。
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
        // 其余变化：只换这一行，换前快照展开态与行内滚动、换后回填
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

    // 记录本轮的行序与版本，供下一帧比对
    host.__elainaRows = {
        keys: entries.map((e) => e.key),
        versions: entries.map((e) => e.version),
        kinds: entries.map((e) => e.kind),
    };
}

/**
 * 回合结束：把思考行标成完成，并**把过程持久化到消息上**。
 *
 * 为什么必须持久化：过程区是**追加到聊天容器末尾的临时 DOM**，而
 *   `loadConversation` 会先 `conversationHistory.innerHTML = ''` 再把每条消息
 *   重画一遍 —— 那些临时节点不在任何消息里，于是**整体消失**。
 *   用户的表现就是"聊了几轮之后，之前对话的思考记录不见了"：
 *   切个会话、刷新页面、甚至自动重载都会让它没掉。
 *   而注释一直写着"历史消息回看时还要看得到"，实际做不到。
 *
 * 所以收尾时把这一轮的记录挂到**它所依附的那条消息**上（`msg.turnTrace`），
 *   重画时由 renderMessage 一并还原（见 restoreTurnProcessFor）。
 *   存的是**数据**不是 HTML：HTML 依赖当时的展开状态与主题，存下来会越用越脏。
 */
function finishTurnTrace() {
    if (!activeTurnTrace) return;
    activeTurnTrace.done = true;
    renderTurnProcess();
    // 挂到锚点消息上（锚点就是开这一轮时给的那个消息 id）
    const anchorId = activeTurnAnchorId;
    if (anchorId) {
        try {
            const conv = typeof getCurrentConversation === 'function' ? getCurrentConversation() : null;
            const msg = conv && Array.isArray(conv.messages)
                ? conv.messages.find((m) => String(m.id) === String(anchorId))
                : null;
            if (msg) {
                // 只留渲染需要的最小形状：思考段 / 工具行 / 阶段输出，都是数据
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

/**
 * 重画一条消息时，把它当年那一轮的过程区一并还原出来。
 *
 * 由 renderMessage 的调用方（loadConversation 的循环）在渲染后调用。
 * 走的是同一个 renderTurnProcess 逻辑，只是把"数据源"换成消息上存的那份 ——
 * 所以外观、折叠、展开态恢复全都天然一致，不存在两套渲染。
 */
function restoreTurnProcessFor(message) {
    const saved = message && message.turnTrace;
    if (!saved || !Array.isArray(saved.timeline) || !saved.timeline.length) return;
    const el = document.getElementById(`msg-${safeAttrId(message.id)}`);
    if (!el) return;
    // 已经还原过（同一条消息被重复渲染）就不再插第二份
    if (document.getElementById(`turn-process-${safeAttrId(message.id)}`)) return;
    const prevTrace = activeTurnTrace;
    const prevAnchor = activeTurnAnchorId;
    try {
        activeTurnTrace = saved;
        activeTurnAnchorId = String(message.id);
        const host = renderTurnProcess();
        // 过程区默认排在正文之后（历史回看时正文才是主角）。
        //   这里显式确保它紧跟在这条消息后面，而不是跑到列表末尾。
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

