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

