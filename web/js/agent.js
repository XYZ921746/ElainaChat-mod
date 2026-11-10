// AI Agent 运行时：可随时停止 + 敏感操作需用户授权。停止是请求式的 —— 设标志、中断在途请求、
// 关掉等待中的确认框，由各执行点调 assertNotStopped() 退出，不强杀，避免留下半完成状态。
// 被拒绝不静默失败，回灌给模型换方式。手机操作不走这套询问，模块后端风险由设置页免责声明承担。
const AGENT_RISK = {
    '手机状态': 'safe',
    '手机查看界面': 'safe',
    '手机截图': 'safe',
    '手机等待': 'safe',
    // 读取类操作都是 safe。safe 只表示"不需要弹确认"，与隐私开关是两件事：
    // phoneReadAllowed 决定这个能力存不存在。
    '手机应用列表': 'safe',
    '手机通知': 'safe',
    '手机设备信息': 'safe',
    '手机短信': 'safe',
    '手机通讯录': 'safe',
    '手机日历': 'safe',
    // 工作区文件操作：读/列 safe，写与删标 sensitive —— 虽然 phoneTierAllows 对非「手机命令」一律放行，
    // 但分级表仍要如实，否则将来调整放行策略时这两项会被当成 safe 静默通过。
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
    // 电脑命令：危险的那部分由服务端再判一次并强制授权（见 server/pc-command.mjs）；标 sensitive
    // 让安全命令在 auto 档下不打扰用户、危险命令走同一条授权 UI。
    '电脑命令': 'sensitive',
    // 浏览器开窗口、导航、点击都不改这台机器的状态，但会让 AI 以用户身份在网站上做事（下单、发帖、提交表单）；
    // 标 sensitive 而不是 safe，是为了让 strict 档在"打开浏览器"这一步问一次。
    '浏览器': 'sensitive'
};

// Agent 操作定义：两条触发通道（正文标签、原生 function calling）共用这一份 —— 各写一份会让新能力
// 只在一条通道可用，或两边参数规则慢慢走样。「此刻能不能用」写成函数，权限档/开关/平台变了才准。
// 「打开视频通话 / 结束通话」不进注册表：它们走插件服务（host.service('live2d')），宿主不直接点插件全局名。
const pcOpsAvailable = () => !IS_NATIVE_APP && !agentAccessDisabled();
const phoneOpsAvailable = () => IS_NATIVE_APP && state.settings.agentPhoneEnabled !== false;

// 「降级到标签通道时按意图挑说明书」用的关键词（见 agent-ops.js 的 opsForIntent）。只放用户会自然
// 说出口的词，宁缺勿滥；各项尽量互不重叠，重叠会让同一段说明书在一轮提示词里出现两遍。
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
    risk: 'sensitive',
    // 两个条件缺一不可：电脑操作没被整体关掉（agentAccess !== 'off'），且用户主动打开了「允许 AI 用浏览器」（默认关）。
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
    // 搜索不改这台机器的状态，但会花用户额度、结果会进上下文；标 sensitive 会让 strict 档每次弹窗，
    // 那是过度打扰。真正的闸是开关 + Key（见下面的 available）。
    risk: 'safe',
    // 开关打开且当前这家的 Key 填了才算可用 —— 换了服务商没填 Key 时，工具清单里不该出现它。
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
    // 只走工具调用通道，不接文本标签（标签通道容易污染上下文），因此也不配 hints。
    risk: 'safe',
});



async function runRecallSearch(args) {
    const query = String(args && args.query || '').trim();
    const queryLower = query.toLowerCase();
    const convHint = String(args && args.conversation || '').trim().toLowerCase();
    const dateHint = recallDateHintOf(args && args.date);
    if (!query && !dateHint && !convHint) {
        return { ok: false, text: '回忆检索至少要给一个条件：query（关键词）、date（日期）或 conversation（对话标题关键词）。' };
    }

    const QUOTE_LIMIT = 15;
    const lines = [];

    // 向量召回：配了嵌入就先按语义捞一批候选，再与关键词命中合并；没配时 vectorHits 为 null，行为与纯关键词一致。
    let vectorHits = null;
    if (query && typeof recallMemoriesByVector === 'function') {
        try {
            const waitMs = (typeof MEMORY_VECTOR_RECALL_TIMEOUT_MS === 'number') ? MEMORY_VECTOR_RECALL_TIMEOUT_MS : 8000;
            vectorHits = await Promise.race([
                recallMemoriesByVector(query, { topK: 24 }),
                new Promise((resolve) => setTimeout(() => resolve(null), waitMs))
            ]);
        } catch (e) { vectorHits = null; }
        if (vectorHits) {
            vectorHits = vectorHits.filter((hit) => {
                const item = hit && hit.item;
                if (!item) return false;
                if (convHint && !String(item.title || '').toLowerCase().includes(convHint)) return false;
                // 日期提示只对日记/计划这类真有日历日期的条目生效：对话原文的 date 是时刻串（21:54:32），
                // 拿它比日历日期永远不匹配，会把带日期提问时的 msg 命中整批过滤掉。
                if (dateHint && item.kind !== 'msg' && !recallDiaryDateMatches(dateHint, item.date)) return false;
                return true;
            });
        }
    }

    // ① 日记命中：向量语义命中排在前，其后是日期/对话/关键词的字面命中。
    // 结构化索引（服务端 FTS5）命中作为补充候选，正文与日期仍取 Store 里的日记条目。
    const diary = (state.memoryCore && Array.isArray(state.memoryCore.diary)) ? state.memoryCore.diary : [];
    let itemDiary = [];
    if (query && typeof searchMemoryItems === 'function') {
        try {
            const hits = await searchMemoryItems(query, { limit: 30, kind: 'diary' });
            if (Array.isArray(hits) && hits.length) {
                const lookup = (typeof memoryItemsDiaryLookup === 'function') ? memoryItemsDiaryLookup() : new Map();
                itemDiary = hits.map((hit) => {
                    const local = lookup.get(String((hit && hit.id) || ''));
                    return {
                        date: (local && local.date) || '',
                        content: (local && local.content) || (hit && hit.content) || '',
                        conversationId: (local && local.conversationId) || (hit && hit.scopeId) || '',
                        conversationTitle: (local && local.conversationTitle) || '',
                        essences: []
                    };
                }).filter((entry) => {
                    // 与关键词/向量命中同一套过滤：给了日期或对话提示就不该混进范围外的日记。
                    if (convHint && !String(entry.conversationTitle || '').toLowerCase().includes(convHint)) return false;
                    if (dateHint && !recallDiaryDateMatches(dateHint, entry.date)) return false;
                    return true;
                });
            }
        } catch (e) { itemDiary = []; }
    }
    const semanticDiary = itemDiary.concat((vectorHits || [])
        .filter((hit) => hit.item && hit.item.kind === 'diary')
        .map((hit) => ({
            date: hit.item.date || '',
            content: hit.item.content || hit.item.text || '',
            conversationId: hit.item.convId || '',
            conversationTitle: hit.item.title || '',
            essences: []
        })));
    const keywordDiary = diary.filter((e) => {
        if (convHint && !String(e && e.conversationTitle || '').toLowerCase().includes(convHint)) return false;
        const dateOk = !dateHint || recallDiaryDateMatches(dateHint, e && e.date);
        const hay = (String(e && e.content || '') + ' ' + ((e && e.essences) || []).join(' ')).toLowerCase();
        const queryOk = !query || hay.includes(queryLower);
        return dateOk && (queryOk || Boolean(dateHint || convHint));
    });
    const diaryHits = [];
    const seenDiary = new Set();
    for (const entry of semanticDiary.concat(keywordDiary)) {
        const key = String(entry.conversationId || '') + '|' + String(entry.date || '') + '|' + String(entry.content || '').slice(0, 40);
        if (seenDiary.has(key)) continue;
        seenDiary.add(key);
        diaryHits.push(entry);
        if (diaryHits.length >= 5) break;
    }

    // 原话命中：向量候选排在前；关键词只补充语义没覆盖到的原话。
    const convs = state.conversations.filter((c) => !convHint || String(c.title || '').toLowerCase().includes(convHint));
    const quotes = [];
    const seenQuote = new Set();
    for (const hit of (vectorHits || [])) {
        if (!hit.item || hit.item.kind !== 'msg') continue;
        if (seenQuote.has(hit.item.id)) continue;
        seenQuote.add(hit.item.id);
        quotes.push({
            title: hit.item.title || '未命名对话',
            role: hit.item.role === 'user' ? '用户' : ((state.characterCard && state.characterCard.name) || '伊蕾娜'),
            time: String(hit.item.date || ''),
            excerpt: recallExcerpt(String(hit.item.text || '').replace(/^\[[^\]]*\]\s*[^：]*：/, ''), query, 160),
        });
        if (quotes.length >= QUOTE_LIMIT) break;
    }
    for (const conv of convs) {
        const diaryOfConv = diaryHits.filter((e) => e && e.conversationId === conv.id);
        const essences = diaryOfConv.flatMap((e) => (e.essences || []).map(String));
        const messages = Array.isArray(conv.messages) ? conv.messages : [];
        for (let index = 0; index < messages.length; index += 1) {
            const msg = messages[index];
            if (!msg || msg.hidden === true) continue;
            const text = String(msg.text || '');
            if (query) {
                if (!text.toLowerCase().includes(queryLower)) continue;
            } else {
                if (!diaryOfConv.length) continue;
                if (!essences.some((k) => k && text.toLowerCase().includes(k.toLowerCase()))) continue;
            }
            const key = 'msg:' + String(conv.id || '') + ':' + index;
            if (seenQuote.has(key)) continue;
            seenQuote.add(key);
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

    // 没配嵌入但配了重排序：关键词候选也让它重排一次，保证「只开其中一个也能工作」。
    if (!vectorHits && typeof rerankMemoryTexts === 'function' && query && quotes.length > 1) {
        const ranked = await rerankMemoryTexts(query, quotes.map((quote) => quote.excerpt), quotes.length);
        if (ranked) {
            const reordered = ranked.map((entry) => quotes[entry.index]).filter(Boolean);
            const used = new Set(ranked.map((entry) => entry.index));
            quotes.forEach((quote, index) => { if (!used.has(index)) reordered.push(quote); });
            quotes.length = 0;
            quotes.push(...reordered);
        }
    }

    // 只给对话（无关键词/日期）且日记锚不到时，给这段对话最近几条原话，否则这条合法参数组合永远返回"没检索到"。
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

// 执行实现只有这一处，两条通道共用。ctx.traceItem：工具通道已为这次调用记过一行过程，
// 实现里要复用那一行而不是再记一行，否则同一个动作在时间线上出现两次，看起来像做了两件事。
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

