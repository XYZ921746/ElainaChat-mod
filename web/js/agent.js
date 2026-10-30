// ===== AI Agent 运行时：可随时停止 + 敏感操作需用户授权 =====
// 停止是「请求式」：设标志、中断在途请求、关掉等待中的确认框，由各执行点调 assertNotStopped() 退出。
//   不强杀，避免留下半完成状态。授权按三档权限（见文件顶部）：被拒绝不静默失败，回灌给模型换方式。
// 手机操作**不走这套询问**（无障碍破坏力有限）；模块后端是 KernelSU，改在设置页用免责声明承担。
const AGENT_RISK = {
    '手机状态': 'safe',
    '手机查看界面': 'safe',
    '手机截图': 'safe',
    '手机等待': 'safe',
    // 读取类操作：都是 safe（只读，不改变任何状态）。
    //   注意 safe 与"隐私开关"是两件事：safe 只表示"不需要弹确认"，
    //   隐私开关（phoneReadAllowed）决定这个能力**存不存在**。
    '手机应用列表': 'safe',
    '手机通知': 'safe',
    '手机设备信息': 'safe',
    '手机短信': 'safe',
    '手机通讯录': 'safe',
    '手机日历': 'safe',
    // 工作区文件操作。
    //   读/列是 safe；写与删标 sensitive —— 虽然"手机全部放行"
    //   （phoneTierAllows 对非「手机命令」一律返回 true），但分级表仍要如实，
    //   否则将来若调整放行策略，这两项会被当成 safe 静默通过。
    '手机列出文件': 'safe',
    '手机读文件': 'safe',
    '手机写文件': 'sensitive',
    '手机删除文件': 'sensitive',
    '手机点击': 'sensitive',
    '手机滑动': 'sensitive',
    '手机输入': 'sensitive',
    '手机按键': 'sensitive',
    '手机打开': 'sensitive',
    '手机命令': 'dangerous',
    // 电脑命令：危险的那部分由**服务端**再判一次并强制授权（见 server/pc-command.mjs），
    // 这里标 sensitive 是让"安全命令"在 auto 档下不打扰用户、危险命令走同一条授权 UI。
    '电脑命令': 'sensitive',
    // 浏览器：开窗口、导航、点击都不改这台机器的状态，但它们会让 AI 以**用户的身份**
    //   在网站上做事（下单、发帖、提交表单）。标 sensitive 而不是 safe，是为了让
    //   strict 档在"打开浏览器"这一步问一次 —— 之后的动作发生在这个已被批准的窗口里。
    '浏览器': 'sensitive'
};

// Agent 操作定义：两条触发通道（正文标签、原生 function calling）共用这一份 —— 各写一份会让新能力
//   只在一条通道可用，或者两边的参数规则慢慢走样。「此刻能不能用」写成函数，权限档/开关/平台变了才准。
//   注意「打开视频通话 / 结束通话」没进注册表：它们走插件服务（host.service('live2d')），
//   宿主不直接点插件全局名。
const pcOpsAvailable = () => !IS_NATIVE_APP && !agentAccessDisabled();
const phoneOpsAvailable = () => IS_NATIVE_APP && state.settings.agentPhoneEnabled !== false;

// 「降级到标签通道时按意图挑说明书」用的关键词（见 agent-ops.js 的 opsForIntent）。
//   只放**用户会自然说出口**的词，宁缺勿滥 —— 命中多了就把刚压下去的每轮提示词又塞回来。
//   各项尽量互不重叠：重叠会让同一段说明书（尤其真实路径那块）在一轮提示词里出现两遍。
const HINT_LS = ['列出', '目录', '文件夹'];
const HINT_READ = ['读取', '读一下', '打开文件'];
const HINT_WRITE = ['写入', '保存', '新建', '创建', '生成', '写到', '写进', '记到', '桌面', '文档', '下载', '文件'];
const HINT_DELETE = ['删除', '删掉', '移除', '清掉', '清空'];
const HINT_CMD = ['命令', 'cmd', 'powershell', '命令行', '执行一下', '跑一下'];
const HINT_PHONE = ['手机', '点击', '滑动', '截图', '通知', '短信', '通讯录', '日历', '界面', '点开'];

ElainaOps.define({
    name: 'file_ls', tool: 'list_files', ns: 'file',
    desc: '列出电脑上某个目录里的文件与文件夹；桌面/文档/下载可用 %DESKTOP% 这类别名。',
    schema: { type: 'object', properties: { path: { type: 'string', description: '目录的绝对路径；省略则列 Agent 工作区' } } },
    risk: 'safe', available: pcOpsAvailable, hints: HINT_LS,
});
ElainaOps.define({
    name: 'file_read', tool: 'read_file', ns: 'file',
    desc: '读取电脑上一个文本文件的内容。',
    schema: { type: 'object', properties: { path: { type: 'string', description: '文件的绝对路径' } }, required: ['path'] },
    risk: 'safe', available: pcOpsAvailable, hints: HINT_READ,
});
ElainaOps.define({
    name: 'file_write', tool: 'save_file', ns: 'file',
    desc: '在电脑上写入一个文本文件（新建或覆盖原有内容）。',
    schema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '文件的绝对路径' },
            content: { type: 'string', description: '要写进文件的文本本身' },
        },
        required: ['path', 'content'],
    },
    risk: 'sensitive', available: pcOpsAvailable, hints: HINT_WRITE,
});
ElainaOps.define({
    name: 'file_delete', tool: 'delete_file', ns: 'file',
    desc: '删除电脑上的一个文件或目录（不进回收站、无法恢复）。',
    schema: { type: 'object', properties: { path: { type: 'string', description: '要删除的绝对路径' } }, required: ['path'] },
    risk: 'dangerous', available: () => pcOpsAvailable() && agentAccessAllowsDelete(), hints: HINT_DELETE,
});
ElainaOps.define({
    name: 'pc_command', tool: 'run_command', ns: 'pc',
    desc: '在用户的电脑上执行一条命令（cmd / PowerShell），返回它的输出。',
    schema: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令原文' } }, required: ['command'] },
    risk: AGENT_RISK['电脑命令'], available: pcOpsAvailable, hints: HINT_CMD,
});
ElainaOps.define({
    name: 'phone', tool: 'phone_action', ns: 'phone',
    desc: '操作手机：读状态/看界面/截图/点击/滑动/输入/按键/打开应用/等待，以及读应用列表、通知、设备信息、短信、通讯录、日历与工作区文件。',
    schema: { type: 'object', properties: { raw: { type: 'string', description: '一步手机操作的原文，例如「手机点击 500 800」' } }, required: ['raw'] },
    risk: 'sensitive', available: phoneOpsAvailable, hints: HINT_PHONE,
});
ElainaOps.define({
    name: 'app_memory', tool: 'organize_memory', ns: 'app',
    desc: '整理当前对话的记忆：把这段经历压缩后汇入长期记忆。',
    schema: { type: 'object', properties: {} },
    risk: 'safe', hints: ['记忆', '整理一下', '记下来'],
});
ElainaOps.define({
    name: 'browser', tool: 'browser_action', ns: 'pc',
    desc: '用浏览器打开网页并操作它：看页面（标题/正文/可点的元素）、点按钮、往输入框打字、按回车。查资料、走一遍需要点开的网页流程时用它。',
    schema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['open', 'goto', 'snapshot', 'click', 'type', 'press_enter', 'close'],
                description: 'open=打开浏览器；goto=打开一个网址（args.url）；snapshot=看当前页面；click=点第 ref 项；type=往第 ref 项输入文字（args.text）；press_enter=按回车；close=关掉浏览器',
            },
            url: { type: 'string', description: 'goto 用的网址，必须是 http/https' },
            ref: { type: 'string', description: 'click / type 用的编号（先 snapshot 看一眼页面，编号在方括号里）' },
            text: { type: 'string', description: 'type 要输入的文字' },
        },
        required: ['action'],
    },
    // 浏览器只在本机可用：调试端口能读这台机器上所有登录态，局域网设备一律不给。
    //   与文件/命令的 available 判据分开写，就是为了让这条边界在注册表里也看得见。
    risk: 'sensitive',
    // 两个条件缺一不可：电脑操作没被整体关掉（agentAccess !== 'off'），
    //   且用户主动打开了「允许 AI 用浏览器」（默认关，见 core.js 的默认设置）。
    available: () => !IS_NATIVE_APP && !agentAccessDisabled() && state.settings.agentBrowserEnabled === true,
    hints: ['浏览器', '网页', '打开网站', '搜一下', '点开', '登录', '页面', '网址'],
});
ElainaOps.define({
    name: 'web_search', tool: 'web_search', ns: 'pc',
    desc: '联网搜索：查最新信息（新闻、价格、某个东西是什么、最近发生了什么）。需要"现在的事实"时用它，不要凭训练数据猜。',
    schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: '要搜索的内容，用自然语言写清要查什么' },
        },
        required: ['query'],
    },
    // 搜索不改这台机器的状态，但它会花用户的额度，而且结果会进上下文 ——
    //   标 sensitive 会让 strict 档每次都弹窗，那是过度打扰（搜一次不该问一次）。
    //   真正的闸是开关 + Key：没打开就不可用，见下面的 available。
    risk: 'safe',
    // 开关打开 **且** 当前这家的 Key 填了才算可用 —— 换了服务商但没填 Key 时，
    //   工具清单里不该出现它（模型会去调一个必然失败的东西）。
    available: () => {
        if (state.settings.tavilySearchEnabled !== true) return false;
        const { id, def } = currentSearchProvider();
        if (!String(state.settings['searchApiKey_' + id] || '').trim()) return false;
        // 自定义源还必须有 https 端点 —— 少了它这个工具必然失败，不该出现在给模型的清单里。
        if (id === 'custom') {
            const ep = String(typeof resolveSearchEndpoint === 'function' ? resolveSearchEndpoint(def) : '').trim();
            if (!/^https:\/\//i.test(ep)) return false;
        }
        return true;
    },
    hints: ['搜索', '搜一下', '查一下', '最新', '新闻', '现在', '多少钱', '是谁', '什么是'],
});
ElainaOps.define({
    name: 'recall_search', tool: 'recall_search', ns: 'app',
    desc: '回忆检索：按关键词或日期在**过去的对话原话与日记**里找回原文（用户问「我们之前说过什么／原话是什么／那天聊了什么」时用它，不要凭记忆转述当原话）。',
    schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: '关键词（原话里出现过的话）；省略则按日期/对话定位' },
            date: { type: 'string', description: '日期，支持「10月24日」「2026-10-24」「10/24」' },
            conversation: { type: 'string', description: '对话标题关键词（可选，只在那段对话里找）' },
        },
    },
    // 只走工具调用通道，不接文本标签（用户决定：标签通道容易污染上下文）。
    //   因此也不配 hints —— 那是给标签降级通道挑说明书用的，教了也是教一个用不了的动作。
    risk: 'safe',
});



function runRecallSearch(args) {
    const query = String(args && args.query || '').trim();
    const queryLower = query.toLowerCase();
    const convHint = String(args && args.conversation || '').trim().toLowerCase();
    const dateHint = recallDateHintOf(args && args.date);
    if (!query && !dateHint && !convHint) {
        return { ok: false, text: '回忆检索至少要给一个条件：query（关键词）、date（日期）或 conversation（对话标题关键词）。' };
    }

    const QUOTE_LIMIT = 15;
    const lines = [];

    // ① 日记命中：日期/对话/关键词任一匹配；关键词没中但日期或对话中了也保留（当定位线索）
    const diary = (state.memoryCore && Array.isArray(state.memoryCore.diary)) ? state.memoryCore.diary : [];
    const diaryHits = diary.filter((e) => {
        if (convHint && !String(e && e.conversationTitle || '').toLowerCase().includes(convHint)) return false;
        const dateOk = !dateHint || recallDiaryDateMatches(dateHint, e && e.date);
        const hay = (String(e && e.content || '') + ' ' + ((e && e.essences) || []).join(' ')).toLowerCase();
        const queryOk = !query || hay.includes(queryLower);
        return dateOk && (queryOk || Boolean(dateHint || convHint));
    }).slice(0, 5);

    // ② 原话命中：有关键词就在全部（或指定）对话的消息里找；
    //    没有关键词（只给了日期/对话）时，按命中日记的要点词在那几段对话里捞
    const convs = state.conversations.filter((c) => !convHint || String(c.title || '').toLowerCase().includes(convHint));
    const quotes = [];
    for (const conv of convs) {
        const diaryOfConv = diaryHits.filter((e) => e && e.conversationId === conv.id);
        const essences = diaryOfConv.flatMap((e) => (e.essences || []).map(String));
        for (const msg of (conv.messages || [])) {
            if (!msg || msg.hidden === true) continue;
            const text = String(msg.text || '');
            if (query) {
                if (!text.toLowerCase().includes(queryLower)) continue;
            } else {
                if (!diaryOfConv.length) continue;
                if (!essences.some((k) => k && text.toLowerCase().includes(k.toLowerCase()))) continue;
            }
            quotes.push({
                title: conv.title || '未命名对话',
                role: msg.role === 'user' ? '用户' : ((state.characterCard && state.characterCard.name) || '伊蕾娜'),
                time: String(msg.timestamp || ''),
                excerpt: recallExcerpt(text, query, 160),
            });
            if (quotes.length >= QUOTE_LIMIT) break;
        }
        if (quotes.length >= QUOTE_LIMIT) break;
    }

    // ②b 只给了对话（无关键词/日期）且日记锚不到：直接给这段对话最近几条原话，
    //     否则这条合法参数组合永远返回"没检索到"。
    if (!query && !dateHint && convHint && !quotes.length) {
        for (const conv of convs) {
            const recent = (conv.messages || []).filter((m) => m && m.hidden !== true).slice(-6);
            for (const msg of recent) {
                quotes.push({
                    title: conv.title || '未命名对话',
                    role: msg.role === 'user' ? '用户' : ((state.characterCard && state.characterCard.name) || '伊蕾娜'),
                    time: String(msg.timestamp || ''),
                    excerpt: recallExcerpt(msg.text, '', 160),
                });
            }
        }
        if (quotes.length) quotes.splice(QUOTE_LIMIT);
    }

    if (diaryHits.length) {
        lines.push('## 命中的日记');
        diaryHits.forEach((e) => lines.push(
            `- ${e.date || '未标注日期'} · ${e.conversationTitle || '未知对话'}：${String(e.content || '').replace(/\s+/g, ' ').slice(0, 120)}`));
    }
    if (quotes.length) {
        lines.push('## 找到的原话');
        quotes.forEach((q) => lines.push(`- 「${q.title} · ${q.role}${q.time ? ' · ' + q.time : ''}」${q.excerpt}`));
    }
    if (!lines.length) {
        return {
            ok: true,
            text: '没有检索到匹配的日记或原话。建议：换一个更独特的关键词（原话里确实出现过的词），或用 date 缩小范围。'
                + '注意：从未整理过日记的早期对话只能靠关键词命中原话。',
        };
    }
    lines.push('（以上是磁盘记录里的原文片段，回答时可摘录引用；未检索到的部分不要编造。）');
    return { ok: true, text: lines.join('\n') };
}

// 执行实现 —— 只有这一处，两条通道共用
// ctx.traceItem：走**工具通道**时，runToolCalls 已经为这次调用记过一行过程了。
//   实现里要复用那一行，而不是再记一行 —— 否则同一个动作在时间线上出现两次
//   （一次「调用 save_file」带 JSON 参数、一次「写入文件」不带参数），
//   看起来像做了两件事。标签通道没有外层记录，实现自己建（traceItem 为 undefined）。
ElainaOps.setExec('file_ls', (args, ctx) => doAgentFile('ls', args, ctx.access, ctx.traceItem));
ElainaOps.setExec('file_read', (args, ctx) => doAgentFile('read', args, ctx.access, ctx.traceItem));
ElainaOps.setExec('file_write', (args, ctx) => doAgentFile('write', args, ctx.access, ctx.traceItem));
ElainaOps.setExec('file_delete', (args, ctx) => doAgentFile('delete', args, ctx.access, ctx.traceItem));
ElainaOps.setExec('pc_command', (args, ctx) => doAgentCommand(args.command, ctx.access, ctx.traceItem));
ElainaOps.setExec('phone', (args, ctx) => runAgentPhoneOperation(args.raw, ctx.traceItem));
ElainaOps.setExec('app_memory', () => runManualMemorySummary());
ElainaOps.setExec('recall_search', (args) => runRecallSearch(args || {}));
ElainaOps.setExec('browser', (args, ctx) => runAgentBrowserOperation(args || {}, ctx.traceItem));
ElainaOps.setExec('web_search', (args, ctx) => runAgentWebSearch(args || {}, ctx.traceItem));

const agentRuntime = (function () {
    let running = false;
    let stopRequested = false;
    let halted = false;          // 本批次已被用户停止：拒绝后续动作，直到下一批开始
    let stopReason = '';
    let step = 0;
    let currentAction = '';
    const approvedThisRun = new Set();   // 本次运行内已授权的动作
    const aborters = new Set();          // 在途请求的 AbortController
    let approvalOpen = false;

    // ---- 系统悬浮窗（APK 独有）----
    // 浮层上常驻「停止」，需要确认时出现「允许 / 拒绝」。
    // 它的价值在于：AI 操作的是**别的 App**，用户不用切回 ElainaChat 就能操作 ——
    // 切回来会把目标 App 切到后台，那次操作就失败了（死循环的根源）。
    let overlayListenerReady = false;
    let overlayApprovalPending = null;   // 等待浮层回应的 resolve 函数

    const barEl = () => document.getElementById('agentRunBar');
    const textEl = () => document.getElementById('agentRunText');
    const stepEl = () => document.getElementById('agentRunStep');
    const stopBtnEl = () => document.getElementById('agentStopBtn');

    function render() {
        const b = barEl();
        if (!b) return;
        b.classList.toggle('hidden', !running);
        b.classList.toggle('flex', running);
        b.classList.toggle('is-stopping', stopRequested);
        const t = textEl();
        if (t) t.textContent = stopRequested ? '正在停止' : (currentAction ? 'AI 正在操作' : 'AI 正在思考');
        const s = stepEl();
        if (s) s.textContent = running ? ('第 ' + step + ' 步' + (currentAction ? ' · ' + currentAction : '')) : '';
        const btn = stopBtnEl();
        if (btn) { btn.disabled = stopRequested; btn.textContent = stopRequested ? '停止中' : '停止'; }
        // 「看画面」只在**这一轮真的在走模块后端**时出现（只有独立副屏才有「画面」可看）。
        // 判据优先级：本轮的选择 > 实际用过的 > 设置里的默认 —— 三者都不能单独用：
        //   currentBackendId() 是持久化的默认，用户在弹窗里临时选前台后它照样是 module；
        //   __lastAgentBackend 可能为空或带着上一轮的值。只看后两者会一律往「显示模块」的方向错判。
        const watch = document.getElementById('agentWatchBtn');
        if (watch) {
            // runModeDecision / lastUsedBackendId 都是本文件顶层变量（IIFE 外），
            // 这里直接闭包读取；用 typeof 兜住"还没轮到那段代码执行"的极早期调用。
            const mode = (typeof runModeDecision === 'string') ? runModeDecision : '';
            const used = String(window.__lastAgentBackend || '');
            const fallbackDefault = (typeof currentBackendId === 'function') ? currentBackendId() : '';
            // '' = 本轮还没问过（只有一条路可用，不弹窗）→ 才回落到实际/默认
            const effective = (mode === 'module' || mode === 'accessibility')
                ? mode
                : (used || fallbackDefault);
            watch.classList.toggle('hidden', !(running && effective === 'module'));
        }
    }

    /**
     * 每条 AI 回复的处理入口调用一次：开启新批次，解除上一批留下的停止状态。
     *
     * 三档模型下这里**不清 approvedThisRun** —— 因为 strict 档的语义就是
     *   "**每一条**都要确认"，不存在"本批次已授权过就跳过"的豁免。
     */
    function beginBatch() {
        halted = false;
    }

    function beginRun() {
        running = true;
        stopRequested = false;
        stopReason = '';
        step = 0;
        currentAction = '';
        render();
    }

    function endRun() {
        running = false;
        stopRequested = false;
        aborters.clear();
        currentAction = '';
        render();
    }

    function requestStop(reason) {
        if (!running || stopRequested) return false;
        stopRequested = true;
        halted = true;              // 粘性：本批次后续动作一律拒绝，避免停止后又自己重启
        stopReason = String(reason || '用户停止');
        for (const c of aborters) { try { c.abort(); } catch (e) { /* 忽略 */ } }
        aborters.clear();
        // 关掉正在等待的确认弹窗（按「拒绝」处理）
        if (approvalOpen) {
            // 应用内弹窗这条路：点它的「取消」
            try { elements.customModalCancelBtn?.click(); } catch (e) { /* 忽略 */ }
            // 悬浮窗这条路：把它等着的那个 Promise 了结掉。
            // 两条路都要关 —— 只关其中一条会让另一种情况下的 await 永远挂住。
            const pending = overlayApprovalPending;
            overlayApprovalPending = null;
            if (pending) pending(false);
        }
        render();
        return true;
    }

    function assertNotStopped() {
        if (!stopRequested) return;
        const err = new Error(stopReason || '已停止');
        err.agentAborted = true;
        throw err;
    }

    /** 把在途请求的 controller 交给运行时，停止时统一中断 */
    function track(controller) {
        if (controller && typeof controller.abort === 'function') aborters.add(controller);
        return controller;
    }

    function riskOf(action) { return AGENT_RISK[action] || 'sensitive'; }

    /**
 * 敏感操作授权。返回 true 表示可以执行。
 *
 * 三档模型下的判据：
 *   · 手机操作 → 由 phoneTierAllows 决定，**基本全部放行**，
 *                唯一例外是「手机命令」（模块后端下等于 root shell）。
 *   · 电脑命令 → strict 档每条都问；auto 档只问危险命令；full 档不问。
 *   · 文件写入/覆盖/删除 → 由**服务端**回 needOverwrite / needDelete 触发，
 *                          不走这里（那三个闸门按档位在服务端判）。
 *
 * @param {string} action 操作名（决定风险级别）
 * @param {string} detail 给用户看的具体内容
 * @param {object} [opts] { forceAsk: true } —— 无视档位，这一条必须问
 */
    async function requestApproval(action, detail, opts = {}) {
        const risk = riskOf(action);
        if (risk === 'safe') return true;
        if (stopRequested) return false;

        const access = currentAgentAccess();
        const mustAsk = opts.forceAsk === true;

        // 手机操作：按 phoneTierAllows 放行（除「手机命令」外全放行）
        const isPhone = String(action || '').startsWith('手机');
        if (isPhone && !mustAsk) {
            if (phoneTierAllows(action)) return true;
            // 落到下面走确认 UI（只有「手机命令」会到这里）
        } else if (!mustAsk) {
            // 电脑命令：strict 每条都问；auto 只问危险的（由服务端 needApproval 驱动，
            // 调用方带 forceAsk）；full 不问。
            if (access === 'full') return true;
            if (access === 'auto' && risk !== 'dangerous') return true;
            // strict → 继续往下走确认 UI
        }

        const askRisk = mustAsk ? 'dangerous' : risk;
        const lines = ['AI 想执行：' + action];
        if (detail) lines.push('', detail);
        lines.push('', askRisk === 'dangerous'
            ? '这是可以执行任意系统命令的操作，风险很高，请确认你信任当前对话里出现的内容。'
            : '该操作会改变电脑或手机的状态。拒绝后 AI 会收到通知并尝试别的方式，不会卡住。');

        // 优先走**系统悬浮窗**确认。
        // 为什么：AI 操作的是别的 App，而应用内弹窗要用户切回 ElainaChat 才看得到 ——
        // 切回来这一步会把目标 App 切到后台，那次操作就落到错的位置或直接失败，
        // AI 重试又弹窗，形成死循环。悬浮窗浮在目标 App 之上，用户不离开当前界面
        // 就能点「允许 / 拒绝」。
        // 悬浮窗不可用（没授权 / 没显示）时**回退到应用内弹窗** ——
        // 不能因为浮层不可用就静默拒绝，那会让功能看起来"坏了"。
        approvalOpen = true;
        let ok = false;
        try {
            ok = await requestApprovalViaOverlay(action, detail);
        } catch (e) { ok = false; }
        if (ok === null) {
            // 悬浮窗这条路走不通 → 应用内弹窗
            try {
                ok = await showCustomModal({
                    title: askRisk === 'dangerous' ? '危险操作确认' : '敏感操作确认',
                    message: lines.join('\n'),
                    confirmText: '允许这次',
                    cancelText: '拒绝'
                });
            } catch (e) { ok = false; }
        }
        approvalOpen = false;
        if (!ok) return false;
        approvedThisRun.add(action);
        return !stopRequested;   // 用户可能在弹窗期间点了停止
    }

    /**
     * 通过系统悬浮窗请求确认。
     *
     * @returns true/false = 用户在浮层上做出了选择；**null = 浮层不可用，调用方应回退到应用内弹窗**
     */
    function requestApprovalViaOverlay(action, detail) {
        const plugin = deviceBridge();
        // 只有安卓版、且原生层提供了这个方法、且浮层正在显示时才走这条路
        if (!plugin || typeof plugin.askOverlayApproval !== 'function') return Promise.resolve(null);
        if (!overlayListenerReady) return Promise.resolve(null);

        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                overlayApprovalPending = null;
                resolve(value);
            };
            // 与"停止"竞争：用户可能在浮层上直接点停止而不是允许/拒绝
            overlayApprovalPending = finish;

            plugin.askOverlayApproval({ action: detail ? (action + ' —— ' + detail) : action })
                .then((res) => {
                    if (res && res.fallback) finish(null);      // 浮层不在 → 回退
                    else if (res && res.ok === false) finish(null);
                    // ok=true 时等原生发 overlayApproval 事件
                })
                .catch(() => finish(null));
        });
    }

    function setStep(n, action) {
        step = Number(n) || 0;
        currentAction = String(action || '');
        render();
        // 同步到系统悬浮窗：用户切到别的 App 时，这里是他唯一能看到进度的位置
        updateOverlayStep();
        // 记进副屏监视窗的「最近动作」（setStep 在 IIFE 里，用 window 上的钩子跨作用域）
        if (typeof window.__screenWatchNote === 'function') {
            window.__screenWatchNote(action);
        }
    }


    // ==================== 系统悬浮窗的生命周期 ====================

    /** 取原生设备层。与外面那个 deviceBridge 同样的逻辑，这里内联一份避免依赖定义顺序 */
    function nativeBridge() {
        if (window.ElainaDevice) return window.ElainaDevice;
        const p = window.Capacitor?.Plugins?.ElainaDevice;
        if (p) { window.ElainaDevice = p; return p; }
        return null;
    }

    /** 挂一次原生事件监听（悬浮窗上的「停止」「允许/拒绝」由它送进来） */
    function ensureOverlayListener() {
        if (overlayListenerReady) return;
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.addListener !== 'function') return;
        overlayListenerReady = true;

        // 用户在浮层上点了「停止」→ 等同于点了应用内的停止
        plugin.addListener('overlayStop', () => {
            requestStop('用户在悬浮窗上点了停止');
            // 必须把"正在等确认"的那个 Promise 也了结掉。
            // 否则用户点停止（而不是允许/拒绝）时，requestApproval 会永远 await 下去 ——
            // 表现是"点了停止没反应"，而这正是用户最需要它立刻停的时刻。
            const pending = overlayApprovalPending;
            overlayApprovalPending = null;
            if (pending) pending(false);
        });

        // 用户在浮层上点了「允许 / 拒绝」
        plugin.addListener('overlayApproval', (data) => {
            const pending = overlayApprovalPending;
            overlayApprovalPending = null;
            if (pending) pending(Boolean(data && data.allowed));
        });
    }

    /** AI 开始操作手机时显示浮层。没有权限时返回 false（调用方会引导用户去开）。 */
    async function showOverlay(text) {
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.showOverlay !== 'function') return false;
        ensureOverlayListener();
        try {
            const res = await plugin.showOverlay({ text: text || 'AI 正在操作手机' });
            if (res && res.needPermission) return 'need-permission';
            return Boolean(res && res.ok);
        } catch (e) {
            return false;
        }
    }

    function updateOverlayStep() {
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.updateOverlay !== 'function') return;
        const label = stopRequested
            ? '正在停止…'
            : ('第 ' + step + ' 步' + (currentAction ? ' · ' + currentAction : ''));
        try { void plugin.updateOverlay({ text: label }); } catch (e) { /* 浮层没了就忽略 */ }
    }

    // 浮层的副标题统一由 setStep → updateOverlayStep 驱动。
    // 不为它另开一个"直接写文案"的入口：两处写同一行字只会互相覆盖
    // （续跑时先写"正在思考下一步…"，紧接着 setStep 又把它盖成"第 N 步 · …"）。
    function hideOverlay() {
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.hideOverlay !== 'function') return;
        try { void plugin.hideOverlay(); } catch (e) { /* 忽略 */ }
    }

    return {
        beginBatch, beginRun, endRun, requestStop, assertNotStopped, track, requestApproval, setStep, render,
        isRunning: () => running,
        isStopRequested: () => stopRequested,
        isHalted: () => halted,
        getStep: () => step,
        riskOf,
        // 悬浮窗
        showOverlay,
        hideOverlay,
        ensureOverlayListener
    };
})();

window.agentRuntime = agentRuntime;

document.getElementById('agentStopBtn')?.addEventListener('click', () => {
    if (agentRuntime.requestStop('用户点了停止')) {
        // 停止后收起悬浮窗（否则它会一直挂在屏幕上，用户以为还在跑）
        if (agentRuntime.hideOverlay) agentRuntime.hideOverlay();
        insertAgentResult('已停止：用户手动中止了 AI 的手机操作，后续动作没有执行。如需继续，请重新告诉 AI 要做什么，或让它先说明刚才做到哪一步。');
    }
});


// ===== 自然语言触发表情 =====
// 用户说「做出XX表情」时直接驱动 Live2D 表情（不依赖 AI 输出标签）。
const NL_EXPRESSION_MAP = {
    '星星眼': '星星眼', '星星眼表情': '星星眼',
    '开心': 'happy', '高兴': 'happy', '微笑': 'smile', '笑': 'happy', '笑容': 'smile',
    '难过': 'sad', '伤心': 'sad', '悲伤': 'sad', '哭': 'cry', '委屈': 'cry', '哭哭': 'cry',
    '生气': 'angry', '愤怒': 'angry', '凶': 'angry', '气鼓鼓': 'angry',
    '害羞': 'shy', '脸红': 'blush', '娇羞': 'shy',
    '惊讶': 'surprised', '震惊': 'surprised', '吃惊': 'surprised',
    '思考': 'think', '疑惑': 'think', '晕': 'dizzy', '头晕': 'dizzy',
    '平静': 'calm', '淡定': 'calm', '正常': 'default'
};
function maybeAutoExpression(text) {
    const s = String(text || '');
    // 直接说特征表情名（星星眼等）或带"表情/脸"字样都算
    const featureHit = Object.keys(NL_EXPRESSION_MAP).find(k => s.includes(k));
    if (!/(表情|脸)/.test(s) && !featureHit) return false;
    // "做出/做个/表演/展示/来一个/露出 + 表情名 + (的)表情/脸"
    const m = s.match(/(?:做出|做|表演|展示|摆出|来一个|来个|露出|弄个?|换)\s*(?:一个|个|一下)?\s*([\u4e00-\u9fff]{2,4}?)(?:的)?(?:表情|脸)/);
    let name = m ? m[1] : '';
    if (!name) name = featureHit || '';
    if (!name) return false;
    // 去掉尾部可能带上的"的"
    name = name.replace(/的$/, '');
    const target = NL_EXPRESSION_MAP[name] || name;
    const l2d = live2dService();
    if (l2d && typeof l2d.setExpression === 'function') {
        console.log('[Live2D] 自然语言触发表情:', name, '→', target);
        void l2d.setExpression(target);
        return true;
    }
    return false;
}


// ===== 自然语言触发文件写入（不提供）=====
// 文件写入一律走 AI 输出 [操作:保存文件 …]：前端用正则解析用户消息会绕过 AI、正则容易误伤、与授权流程脱节。
// 也别加回「待写入 AI 留言」这类中间状态：它唯一的写入者是一个前端正则，留着就是「看起来能用、实际永不可达」的陷阱代码。

async function runManualMemorySummary() {
    // 返回值是**给工具通道用的**：这条函数经 ElainaOps.invoke → runToolCalls 调用，
    //   没有返回值就会被读成「没有返回结果」，模型分不清"整理好了"和"整理失败"。
    if (state.memorySummaryRunning) {
        showCustomAlert('记忆整理正在进行中，请稍候。', '记忆整理');
        return { ok: false, text: '记忆整理正在进行中' };
    }

    setManualMemoryUi(true);
    let result;
    try {
        result = await requestMemorySummary();
    } catch (error) {
        console.error('[记忆] 手动整理失败:', error);
        result = { ok: false, reason: 'failed', error };
    } finally {
        setManualMemoryUi(false);
        closeComposerToolsMenu();
    }

    if (result.ok) {
        if (state.diaryMode) renderDiaryPage();
        const preview = formatMemoryForPrompt(1);
        showCustomAlert('当前对话已整理完毕，经历已汇入伊蕾娜的通用记忆本，所有对话都会记得。\n\n' + (preview || '（记忆内容已保存）').slice(0, 400), '记忆整理完成');
        return { ok: true, text: '当前对话已整理完毕，经历已汇入长期记忆。' };
    }
    if (result.reason === 'empty') {
        showCustomAlert('当前会话还没有可整理的内容，先和伊蕾娜聊几句吧。', '记忆整理');
        return { ok: false, text: '当前会话还没有可整理的内容' };
    }
    if (result.reason === 'parse-fail') {
        showCustomAlert('模型返回的整理结果格式异常，请稍后再试。', '记忆整理');
        return { ok: false, text: '模型返回的整理结果格式异常' };
    }
    if (result.reason === 'busy') {
        showCustomAlert('记忆整理正在进行中，请稍候。', '记忆整理');
        return { ok: false, text: '记忆整理正在进行中' };
    }
    if (result.error) {
        showClientApiError(result.error);
        return { ok: false, text: '记忆整理失败：' + String((result.error && result.error.message) || result.error) };
    }
    showCustomAlert('记忆整理失败，请检查 API 配置。', '记忆整理');
    return { ok: false, text: '记忆整理失败，请检查 API 配置' };
}

