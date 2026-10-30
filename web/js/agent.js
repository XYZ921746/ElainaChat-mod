/* ========================================================================
 * AI Agent：标签入口 / 运行时 / 手机操作 / 后端选择 / 续跑 / 定时任务
 * ======================================================================== */

// ===== AI Agent 操作入口：LLM 回复中的 [操作:xxx] 标签触发 =====

// ===== AI 权限档位=====
// 一个设置 `state.settings.agentAccess` 同时管两件事：
//   ① 能碰哪里 —— 三档**都能访问任意路径**（不按 app / computer 划路径边界）
//   ② 要不要问 —— 以及允不允许删除
//   off    关闭     · 电脑操作**整体关闭**：不读、不写、不删、不执行命令，
//                     连"桌面在哪"这类电脑信息也不再注入提示词
//   strict 逐条确认 · 会改动电脑的操作（写入/覆盖/删除/命令）每次都问；读取不问
//   auto   自动通过 · 改动类直接放行，但**禁止删除**
//   full   完全访问 · 含删除在内全部放行
// 手机侧复用同一档位，但语义按手机的能力映射（见 phoneTierAllows）。
// `off` 只关**电脑侧**：手机有它自己的总开关（设置里的「允许 AI 操作手机」），
//   两者是独立的两件事，别把一个档位当成"关掉全部 Agent"的万能开关。
const AGENT_ACCESS_LEVELS = ['off', 'strict', 'auto', 'full'];
const AGENT_ACCESS_DEFAULT = 'strict';

/** 当前档位（非法值一律按最严的 strict 处理，与服务的收敛规则一致） */
function currentAgentAccess() {
    const v = String(state.settings.agentAccess || '').trim();
    return AGENT_ACCESS_LEVELS.includes(v) ? v : AGENT_ACCESS_DEFAULT;
}

/** 当前是不是"电脑操作整体关闭"档。比"要不要问"更靠前的一层。 */
function agentAccessDisabled() {
    return currentAgentAccess() === 'off';
}

/**
 * `off` 档下给用户/模型看的一句说明。
 * 集中一处：前端拦截、提示词注入、失败解释都可能用到，口径必须一致。
 */
const AGENT_DISABLED_NOTE = 'AI 的电脑操作已在设置里关闭（AI 权限 → 关闭）：'
    + '不能读取、写入或修改电脑上的任何文件，也不能执行电脑命令。'
    + '需要时请在「设置 → 能力 → AI 权限」里改回来。';

/** 这一档允不允许删除（电脑侧）。只有 full 允许。 */
function agentAccessAllowsDelete() {
    return currentAgentAccess() === 'full';
}

/** 这一档下"改动电脑的操作"要不要逐条询问。只有 strict 要。 */
function agentAccessAsksBeforeChange() {
    return currentAgentAccess() === 'strict';
}

/**
 * 手机侧：这一步要不要弹确认。
 *
 * 策略是"**手机不做确认，全部放行**" —— 理由是无障碍方式破坏力有限。
 *    模块后端风险大得多，所以这里**一律返回 true**，
 *    模块的风险改由「设置 → 能力 → 手机操作」里那段免责声明承担。
 *
 *    ⚠️ 这意味着**模块后端（KernelSU / root）的「手机命令」也不会询问**，
 *       AI 能在那种手机上执行任意系统命令。这是有意为之的取舍，
 *       不是遗漏 —— 免责声明里把这一点写清楚了。
 *
 *    为什么还留这个函数而不是直接删掉调用点：
 *      放行策略集中在一处，将来若要收紧（例如给模块单独加闸），
 *      改这一个函数即可，不必去翻 requestApproval 的调用链。
 *      同时 check-agent-access.mjs 直接测这个函数的真实实现。
 *
 *    注意它与**隐私开关**（phoneReadAllowed）是两件事：
 *    这里管"要不要问"，那里管"这个能力存不存在"。
 */
function phoneTierAllows(action) {
    return true;
}

window.agentActions = {
    openVideoCall() { const l2d = live2dService(); if (l2d) l2d.open(); },
    closeVideoCall() { const l2d = live2dService(); if (l2d) l2d.close(); },
    organizeMemory() { void ElainaOps.invoke('app_memory'); },
    setLive2dBackground(v) { const l2d = live2dService(); if (l2d) l2d.setBackground(v); },
    // 文件操作：解析 [操作:列出文件/查看文件/保存文件/删除文件 …] 并执行（权限档位见上）
    agentFileOperation(raw) {
        // `off` 档：电脑操作整体关闭 —— 连服务端都不必问，直接回一句明确说明。
        //   为什么不直接静默忽略：用户/AI 都需要知道"这是被关掉的"，而不是看起来像坏了。
        if (agentAccessDisabled()) { insertAgentResult(AGENT_DISABLED_NOTE); return; }
        const access = currentAgentAccess();
        const text = String(raw || '').trim();
        let action = 'ls';
        let rest = text;
        // 删除只有「完全访问」档能用。
        //   放在最前面判定：它的触发词与其它几个不重叠，但先判可以避免
        //   「删除文件 xxx」里的"文件"二字被下面的文件分支吃掉。
        if (/删除文件|删除目录|删除文件夹|删掉文件|删掉目录|移除文件/.test(text)) {
            if (!agentAccessAllowsDelete()) {
                insertAgentResult('该操作不可用：当前是「' + (currentAgentAccess() === 'auto'
                    ? '自动通过（禁止删除）' : '逐条确认') + '」模式，AI 不能删除文件。'
                    + '需要删除的话，请在「设置 → 能力 → AI 权限」里切到「完全访问」，或自己手动删除。');
                return;
            }
            rest = text.replace(/删除文件|删除目录|删除文件夹|删掉文件|删掉目录|移除文件/, '').trim();
            rest = rest.replace(/^(?:到|在|至|于|文件)\s*/, '').trim();
            rest = rest.replace(/^["']|["']$/g, '').trim();
            void ElainaOps.invoke('file_delete', { path: rest || undefined }, { access });
            return;
        }
        if (/列出文件|列出目录|查看文件夹/.test(text)) { action = 'ls'; rest = text.replace(/列出文件|列出目录|查看文件夹/, '').trim(); }
        else if (/查看文件|读取文件|读文件/.test(text)) { action = 'read'; rest = text.replace(/查看文件|读取文件|读文件/, '').trim(); }
        // 写文件的操作名必须与 agent-tags.js 分发处**同一份清单**：
        //   那边放行了「新建文件」，这里却没剥它 → 「新建文件」留在 rest 里被当成路径的一部分，
        //   于是 path = "新建文件 %DESKTOP%\a.txt"（整条标签），写到的目录根本不存在。
        //   表现是"AI 说建好了、实际没有"，而且没有任何报错指向这个原因。
        else if (/保存文件|写入文件|写文件|创建文件|新建文件/.test(text)) { action = 'write'; rest = text.replace(/保存文件|写入文件|写文件|创建文件|新建文件/, '').trim(); }
        else { void ElainaOps.invoke('file_ls', { path: undefined }, { access }); return; }

        // 去掉 AI 可能带的介词（到/在/至/保存到 等）与多余空格
        rest = rest.replace(/^(?:到|在|至|于|保存到|写入到|文件)\s*/, '').trim();

        if (action === 'write') {
            const sep = rest.indexOf('|');
            let path, content;
            if (sep >= 0) {
                path = rest.slice(0, sep).trim();
                content = rest.slice(sep + 1).trim();
            } else {
                // 无 |：路径 = 第一个 token（支持引号包裹），内容 = 剩余部分
                const m = rest.match(/^"([^"]+)"\s*([\s\S]*)$/) || rest.match(/^'([^']+)'\s*([\s\S]*)$/) || rest.match(/^(\S+)\s*([\s\S]*)$/) || [null, rest, ''];
                path = (m[1] || '').trim();
                content = (m[2] || '').trim();
            }
            path = path.replace(/^["']|["']$/g, '').trim();
            void ElainaOps.invoke('file_write', { path, content }, { access });
        } else {
            rest = rest.replace(/^["']|["']$/g, '').trim();
            void ElainaOps.invoke('file_' + action, { path: rest || undefined }, { access });
        }
    },
    // 手机操作：[操作:手机点击 500 800] 等。
    // 「停止检查 + 敏感操作授权」由 agentRuntime 统一处理（见 runAgentPhoneOperation）。
    agentPhoneOperation(raw) {
        void ElainaOps.invoke('phone', { raw });
    },
    // 联网搜索：[操作:搜索 今天北京天气] / [操作:搜一下 xxx]
    // 标签通道只传一句话，这里翻成工具通道的结构化参数（同一个执行器）。
    agentWebSearchOperation(raw) {
        const query = String(raw || '').replace(/^(搜索|搜一下|联网搜索|查一下)\s*[:：]?\s*/, '').trim();
        if (!query) {
            insertAgentResult('没有给出要搜索的内容。写成 [操作:搜索 要查的东西] 就行。');
            return;
        }
        void runAgentWebSearch({ query });
    },
    // 浏览器：[操作:浏览器打开 https://example.com] / [操作:浏览器看页面] /
    //         [操作:浏览器点击 3] / [操作:浏览器输入 3|要填的字] / [操作:浏览器回车] / [操作:浏览器关闭]
    // 标签通道传的是**中文原文**，工具通道传的是结构化参数 —— 这里负责把前者翻成后者，
    //   之后两条通道走同一个执行器（runAgentBrowserOperation），不各写一套。
    agentBrowserOperation(raw) {
        const parsed = parseBrowserTag(String(raw || ''));
        if (!parsed) {
            insertAgentResult('看不懂这条浏览器操作。可用写法：'
                + '\n· [操作:浏览器打开 <网址>]'
                + '\n· [操作:浏览器看页面]'
                + '\n· [操作:浏览器点击 <编号>]'
                + '\n· [操作:浏览器输入 <编号>|<文字>]'
                + '\n· [操作:浏览器回车]'
                + '\n· [操作:浏览器关闭]');
            return;
        }
        void runAgentBrowserOperation(parsed);
    },
    // 电脑命令：[操作:电脑命令 dir] 等。
    // strict/auto/full 三档都可执行，区别只在"要不要问"（见 doAgentCommand 与 server 的 agentExec）。
    agentCommandOperation(raw) {
        // `off` 档：命令执行也整体关闭。
        if (agentAccessDisabled()) { insertAgentResult(AGENT_DISABLED_NOTE); return; }
        const text = String(raw || '').trim();
        // 剥掉触发前缀，剩下的就是命令原文
        const command = text.replace(/^(?:电脑命令|执行命令|运行命令|电脑执行)\s*/, '').trim();
        if (!command) {
            insertAgentResult('没有给出要执行的命令。请用 [操作:电脑命令 <命令>] 的格式。');
            return;
        }
        void ElainaOps.invoke('pc_command', { command }, { access: currentAgentAccess() });
    }
};


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


// ===== 文件夹授权（Agent 工作区之外的第二个可写根）=====
// 用户在设置页点「选择文件夹授权」→ 原生打开系统文件选择器 →
// 拿到一个持久化的 SAF 目录 URI → 存进设置，AI 就能读写那个文件夹。
// 为什么不做成"整个手机存储随便读"：那需要 MANAGE_EXTERNAL_STORAGE
//   （所有文件访问权限），会被应用商店拒审，对用户也是"给了就收不回"。
//   SAF 的粒度是"一个文件夹"，用户能精确控制给哪个目录、随时收回。
document.getElementById('agentFolderPickBtn')?.addEventListener('click', async () => {
    const dev = deviceBridge();
    if (!dev || typeof dev.pickAgentFolder !== 'function') {
        await showCustomAlert('文件夹授权只在安卓版 App 里可用（网页版没有系统文件选择器）。', '不可用');
        return;
    }
    try {
        const res = await dev.pickAgentFolder();
        if (res && res.ok) {
            state.settings.agentFolderUri = String(res.folderUri || '');
            state.settings.agentFolderName = String(res.folderName || '');
            persistSettings();
            renderAgentFolderSummary();
            // 重新拼一次提示词：授权变了，AI 该知道自己现在能读写哪个文件夹
            await showCustomAlert(res.text || '已授权文件夹。', '文件夹授权');
        } else if (res && res.cancelled) {
            // 用户主动取消，不打扰
        } else {
            await showCustomAlert((res && res.text) || '选择文件夹失败。', '文件夹授权');
        }
    } catch (err) {
        await showCustomAlert('选择文件夹失败：' + ((err && err.message) || err), '文件夹授权');
    }
});

document.getElementById('agentFolderClearBtn')?.addEventListener('click', async () => {
    if (!String(state.settings.agentFolderUri || '').trim()) {
        await showCustomAlert('当前没有授权任何文件夹。', '文件夹授权');
        return;
    }
    const dev = deviceBridge();
    if (dev && typeof dev.clearAgentFolder === 'function') {
        try { await dev.clearAgentFolder(); } catch (e) { /* 本地记录照样清 */ }
    }
    state.settings.agentFolderUri = '';
    state.settings.agentFolderName = '';
    persistSettings();
    renderAgentFolderSummary();
    await showCustomAlert('已取消文件夹授权。AI 现在只能读写 Agent 工作区。', '文件夹授权');
});

// ===== 系统权限现状（读取信息那一块的第二道闸）=====
// 应用层开关（设置里的隐私开关）管"让不让 AI 知道"；
// 这里管"应用能不能拿到" —— 短信/通讯录/日历是 Android 危险权限，
// 必须由用户在系统里同意。**刻意不在启动时索取**：
// 用户还没用到那功能时弹一堆权限框只会让人一律拒绝。
// 这块只做**纯状态展示** ——
//   每行右侧的小徽标（#agentPermBadge*，见 index.html）显示该项权限在系统里的现状，
//   申请/关闭一律去系统的权限页。所以相关函数只负责刷新徽标（顺带刷工作区文件数），
//   不再配「申请 / 关闭」按钮与汇总文字。
//   ⚠️ 别在这里引用 #agentReadPermBtn / #agentNotifPermBtn / #agentReadPermStatus ——
//      HTML 里没有这三个 id，check-dom-refs 会报"HTML 里没有这个 id"。
const AGENT_PERM_BADGE_IDS = [
    'agentPermBadgeApps',
    'agentPermBadgeNotifications',
    'agentPermBadgeDevice',
    'agentPermBadgeSms',
    'agentPermBadgeContacts',
    'agentPermBadgeCalendar',
];

// **徽标可点** —— 点一下就去把这项权限申请下来。
//   为什么做成"点徽标"而不是再加一排按钮：这块要保持"只显示状态"的观感
//   （只显示权限授权状态），而徽标本身就是最自然的入口 ——
//   看到一个"未授权"，顺手点它就该去授权。
//   · 短信 / 通讯录 / 日历 → requestReadPermission（弹系统授权框）
//   · 通知读取 → openNotificationSettings（它不是运行时权限，只能跳系统的「通知使用权」页）
//   · 应用列表（安装期授权）/ 设备状态（不需要权限）没有可做的事，保持纯展示
const AGENT_PERM_BADGE_ACTIONS = {
    agentPermBadgeSms: { kind: 'sms' },
    agentPermBadgeContacts: { kind: 'contacts' },
    agentPermBadgeCalendar: { kind: 'calendar' },
    agentPermBadgeNotifications: { settingsPage: true },
};

/** 写一个徽标（kind: 'ok' | 'no' | 空） */
function setAgentPermBadge(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    // is-actionable 必须一起写进 className —— 这行是**整体覆盖**，
    // 只 classList.add 的话下一次刷新就会被抹掉。
    el.className = 'agent-perm-badge'
        + (kind ? ' is-' + kind : '')
        + (AGENT_PERM_BADGE_ACTIONS[id] ? ' is-actionable' : '');
}

/** 六个徽标一起写成同一句话（用于"仅安卓版"/"读取失败"这种整体状态） */
function setAllAgentPermBadges(text, kind) {
    AGENT_PERM_BADGE_IDS.forEach((id) => setAgentPermBadge(id, text, kind));
}

/**
 * 点徽标 = 去把这项权限申请下来。
 *
 * 已经授权时不做特殊分支：`requestReadPermission` 对已授权的权限会立刻返回（不弹框），
 * 而通知那一条本来就是"跳到设置页"——那个页面既能开也能关，
 * 正好对上说明里"不想让它读就去系统里关掉"。
 */
async function handleAgentPermBadgeAction(id) {
    const cfg = AGENT_PERM_BADGE_ACTIONS[id];
    if (!cfg) return;
    const dev = deviceBridge();
    if (!dev) {
        await showCustomAlert('系统权限只能在安卓版 App 里设置。', '不可用');
        return;
    }
    if (cfg.settingsPage) {
        // 通知读取：跳到系统的「通知使用权」页。
        // 成功时**不弹任何提示** —— 用户点一下就是要去那一页，页面自己会打开，
        //   再弹一个"已打开设置页"纯属多余（授权成功就该自然结束，别加提示）。
        //   只有"打不开"才必须弹：那种情况得告诉用户手动怎么走。
        if (typeof dev.openNotificationSettings !== 'function') return;
        try {
            await dev.openNotificationSettings();
        } catch (err) {
            await showCustomAlert('打不开通知设置页：' + ((err && err.message) || err), '通知读取');
        }
        return;
    }
    if (typeof dev.requestReadPermission !== 'function') return;
    try {
        await dev.requestReadPermission({ kind: cfg.kind });
    } catch (e) {
        console.warn('[Agent] 申请权限失败：' + cfg.kind, e);
    }
    await refreshAgentReadPermStatus();
}

// 绑定一次即可（徽标是 index.html 里的静态元素）。
// 键盘可达：HTML 上写了 role="button" + tabindex="0"，所以回车/空格也要能触发。
for (const badgeId of Object.keys(AGENT_PERM_BADGE_ACTIONS)) {
    const el = document.getElementById(badgeId);
    if (!el) continue;
    el.addEventListener('click', () => { void handleAgentPermBadgeAction(badgeId); });
    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void handleAgentPermBadgeAction(badgeId);
        }
    });
}

/**
 * 按原生返回的权限表刷新六个徽标。
 *
 * 文案刻意区分三种情况——「未授权」和「压根不需要权限」是两回事，
 * 后者写成"未授权"会让用户白找一圈设置：
 *   · 应用列表 → 安装期授权（QUERY_ALL_PACKAGES，装的时候就定了，关不掉）
 *   · 设备状态 → 无需权限（电量/网络/前台应用都不是权限）
 */
function renderAgentPermBadges(permissions) {
    const p = permissions || {};
    const yesNo = (id, ok) => setAgentPermBadge(id, ok ? '已授权' : '未授权', ok ? 'ok' : 'no');
    setAgentPermBadge('agentPermBadgeApps', p.apps === false ? '未授权' : '安装期授权', p.apps === false ? 'no' : 'ok');
    setAgentPermBadge('agentPermBadgeDevice', '无需权限');
    yesNo('agentPermBadgeNotifications', Boolean(p.notifications));
    yesNo('agentPermBadgeSms', Boolean(p.sms));
    yesNo('agentPermBadgeContacts', Boolean(p.contacts));
    yesNo('agentPermBadgeCalendar', Boolean(p.calendar));
}

async function refreshAgentReadPermStatus() {
    const dev = deviceBridge();
    if (!dev || typeof dev.readPermissionStatus !== 'function') {
        // 网页版没有原生层 —— 这套权限只存在于安卓版 App
        setAllAgentPermBadges('仅安卓版');
        return;
    }
    try {
        const res = await dev.readPermissionStatus();
        renderAgentPermBadges((res && res.permissions) || {});
        // 工作区文件数也顺带刷一下，用户能看到"AI 到底存了东西没有"
        const files = Number(res && res.workspaceFiles);
        if (Number.isFinite(files)) {
            const summary = document.getElementById('agentFolderSummary');
            if (summary && !String(state.settings.agentFolderUri || '').trim()) {
                summary.textContent = '还没有授权额外文件夹。AI 只能在 Agent 工作区里读写文件'
                    + (files > 0 ? '（工作区里现在有 ' + files + ' 个文件）。' : '。');
            }
        }
    } catch (e) {
        setAllAgentPermBadges('读取失败', 'no');
    }
}

// ===== 不可逆操作的确认=====
// 不做"同一对话内只问一次"的豁免：因为「逐条确认」这一档的名字就是
//   "**每一条**都确认" —— AI 要改十个文件就该弹十次。
//   为什么不需要这种豁免：它是为了防止"每步都问、用户闭眼点允许"，
//   而那个场景由「自动通过」与「完全访问」两档承接 —— 想要少打扰的用户
//   会主动切过去，而不是让「逐条确认」名不副实。

/**
 * 危险电脑命令的确认（删除 / 格式化 / 改注册表 / 关机 / 下载并执行…）。
 *
 * 只在 strict 档会被调用到；auto 档只有危险命令会走到这里（服务端回 needApproval），
 * full 档根本不会回 needApproval。
 */
async function confirmAgentDangerousCommand(command, reasonList) {
    const reasons = Array.isArray(reasonList) && reasonList.length
        ? reasonList.join('、')
        : '可能改变系统状态';
    const detail = 'AI 想执行一条危险命令：\n\n' + command + '\n\n风险：' + reasons
        + '\n\n⚠️ 这类命令可能**不可撤销**（删除的文件、改掉的注册表、关掉的进程都不会自己回来）。'
        + '\n请确认命令内容确实是你想要的。'
        + (agentAccessAsksBeforeChange() ? '\n（当前是「逐条确认」模式，每条命令都会问你一次。）' : '');
    let ok = false;
    try {
        ok = await agentRuntime.requestApproval('电脑命令', detail, { forceAsk: true });
    } catch { ok = false; }
    return ok;
}

/**
 * 覆盖已有文件的确认（服务端回 needOverwrite 后由前端问一次）。
 *
 * 服务端是权威：不带 overwrite:true 的请求拿不到覆盖能力，
 *   所以"问不问"可以被前端优化，但"能不能覆盖"始终由服务端说了算。
 *   服务端只在 strict 档回 needOverwrite（见 agentWrite），所以这个函数
 *   实际上只会在 strict 档被调用到。
 */
async function confirmAgentOverwrite(path) {
    const target = String(path || '').trim();
    const detail = 'AI 想写入一个**已经存在**的文件，这会覆盖它原有的内容：\n\n' + target
        + '\n\n覆盖后原内容无法恢复。'
        + '\n（想少打扰：设置 → 能力 → AI 权限，切到「自动通过」或「完全访问」。）';
    let ok = false;
    try {
        ok = await agentRuntime.requestApproval('覆盖已有文件', detail, { forceAsk: true });
    } catch { ok = false; }
    return ok;
}

/**
 * 新建文件的确认（服务端回 needCreate 后由前端问一次）。
 *
 * 为什么新建也要问：设置页里「逐条确认」这一档写明了"写入、覆盖已有文件、
 *   删除、执行命令 —— 每一次都会问你"。若只对覆盖要确认，最低档下
 *   AI 就能在桌面无声新建文件（未经同意写入且没有任何弹窗）。
 *
 * 服务端只在 strict 档回 needCreate，所以这个函数实际上只会在 strict 档被调用到。
 */
async function confirmAgentCreate(path) {
    const target = String(path || '').trim();
    const detail = 'AI 想在你的电脑上**新建一个文件**：\n\n' + (target || '（未提供路径）')
        + '\n\n文件目前还不存在，确认后才会写入。'
        + '\n（想少打扰：设置 → 能力 → AI 权限，切到「自动通过」或「完全访问」。）';
    let ok = false;
    try {
        ok = await agentRuntime.requestApproval('新建文件', detail, { forceAsk: true });
    } catch { ok = false; }
    return ok;
}

/**
 * 删除的确认（服务端回 needDelete 后由前端问一次）。
 *
 * 只有 strict 档会走到这里：auto 档服务端直接拒绝删除（deleteForbidden），
 *   full 档服务端直接执行（不回 needDelete）。
 */
async function confirmAgentDelete(path, isDir) {
    const target = String(path || '').trim();
    const detail = '⚠️ AI 想**永久删除**：\n\n' + target
        + (isDir ? '\n\n这是个**目录** —— 它里面的全部内容会一起被删除。' : '')
        + '\n\n删除后**无法恢复**（不进回收站）。请确认这确实是你想删的东西。';
    let ok = false;
    try {
        ok = await agentRuntime.requestApproval('删除文件', detail, { forceAsk: true });
    } catch { ok = false; }
    return ok;
}

// 执行 Agent 文件操作并把结果回填对话（AI 能看到/用户能看到）
async function doAgentFile(action, { path, content } = {}, access, traceItem) {
    // 过程记录：文件操作是用户最关心的"AI 到底动了什么"。
    // 复用已有的行：走**工具通道**时，runToolCalls 已经为这次调用记过一行了
    //   （标题是「调用 save_file」、参数是原始 JSON）。这里若再记一行，
    //   同一个动作在时间线上就会出现两次 —— 一次「调用 save_file」一次「写入文件」，
    //   用户看到的是"做了两件事"，其中一件没有参数、还常常是失败的。
    //   所以有现成的行就接手它，只在**标签通道**（没有外层记录）时自己建。
    const ownTrace = !traceItem;
    const kindMap = { ls: 'search', read: 'read', write: 'write', delete: 'write' };
    const titleMap = { ls: '列出文件', read: '读取文件', write: '写入文件', delete: '删除' };
    if (ownTrace) {
        traceItem = recordTurnTool({
            kind: kindMap[action] || 'file',
            title: titleMap[action] || ('文件 · ' + action),
            summary: path || '（未提供路径）',
            // 参数用与工具通道**同一种形状**（JSON），时间线才能统一按键值渲染。
            //   写成「路径：…\\n内容长度：…」这种中文散文会让同一份参数在两条通道下
            //   长得不一样，而用户要的是"这一步带了什么参数"这件事本身。
            args: JSON.stringify(action === 'write' ? { path: path || '', content: content || '' } : { path: path || '' }),
            state: 'running'
        });
    } else {
        // 接手的行要补上真正的动作含义（外层只写了「调用 save_file」）
        updateTurnTool(traceItem, {
            kind: kindMap[action] || 'file',
            title: titleMap[action] || ('文件 · ' + action),
            summary: path || '（未提供路径）',
        });
    }
    try {
        let result;
        if (action === 'delete') {
            // 删除走独立接口（/api/agent/delete）。必须用**同源 fetch** ——
            // 理由与下面的 write 相同：postJsonFromDevice 会走本机中转，
            // 而 /api/agent/* 是同源本地接口，交给中转会报「目标地址无效」。
            const send = async (confirmed) => {
                const res = await fetch('/api/agent/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ access, path, confirmed })
                });
                const r = await res.json();
                if (!r.rawText) r.rawText = JSON.stringify(r);
                if (!('ok' in r)) r.ok = res.ok;
                return r;
            };
            result = await send(false);
            // 服务端回 needDelete → 问一次，同意后带 confirmed:true 重发。
            //   等待期与计时重置的理由同 doAgentCommand 的 needApproval 分支。
            if (result.needDelete) {
                updateTurnTool(traceItem, { state: 'running', result: '⚠️ 删除不可恢复，正在等用户确认…' });
                if (!await confirmAgentDelete(path, result.isDir)) {
                    updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许删除' });
                    insertAgentResult('已取消删除：用户没有允许。\n目标：' + (path || '（未提供路径）'), { asContext: true });
                    // 必须**返回一个结果对象**，不能裸 return。
                    //   doAgentFile 的返回值经 ElainaOps.invoke 原样交给 runToolCalls，
                    //   而那里写作 `await invoke(...) || { ok:false, text:'没有返回结果' }` ——
                    //   裸 return 得到 undefined，于是模型在上下文里收到一条
                    //   「没有返回结果」的 tool 消息：用户在界面上看到"成功"，模型却读到"失败"，
                    //   接下来就会用角色口吻向用户道歉、说文件没建成。
                    return { ok: false, text: '用户没有允许删除：' + (path || '（未提供路径）') };
                }
                updateTurnTool(traceItem, { state: 'running', result: '用户已允许，正在删除…', resetTimer: true });
                result = await send(true);
            }
        } else if (action === 'write') {
            // 必须用**同源 fetch**，不能用 postJsonFromDevice。
            // postJsonFromDevice 是给"外部服务商"用的：它会走本机中转
            // （/api/relay，用来绕开 CORS）。而 /api/agent/write 是**同源本地接口**，
            // 把相对路径交给中转 → 中转的 `new URL('/api/agent/write')` 解析失败 →
            // 报「目标地址无效」，写入**永远不可能成功**。
            // 真实故障：日志里能看到 `[Relay] [WARN] 目标地址无效：/api/agent/write`，
            // 而 ls / read 走的是同源 fetch 所以正常 —— 表现为"读取能用、写入不行"。
            const send = async (overwrite) => {
                const res = await fetch('/api/agent/write', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ access, path, content, overwrite })
                });
                const r = await res.json();
                // 同源 fetch 不像 postJsonFromDevice 那样带 rawText，补一份便于错误提示
                if (!r.rawText) r.rawText = JSON.stringify(r);
                if (!('ok' in r)) r.ok = res.ok;
                return r;
            };
            result = await send(false);
            // 覆盖已有文件 → 问一次，同意后带 overwrite:true 重发。
            // （服务端只在 strict 档回 needOverwrite，所以这里只会弹一次。）
            if (result.needOverwrite) {
                // 等待期要说出来：弹窗可能十几秒没人点，行却一直转圈，
                //   用户分不清"卡住了"还是"在等我做决定"。
                updateTurnTool(traceItem, { state: 'running', result: '⚠️ 目标文件已存在，正在等用户确认是否覆盖…' });
                if (!await confirmAgentOverwrite(path)) {
                    updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许覆盖这个文件' });
                    // asContext：用户刚在弹窗里亲手点了「不允许」，这一件事**他自己就知道了**，
                    //   再往聊天记录里插一条回执只是复述他刚做的决定。
                    //   结果照旧留给模型（它要靠这条知道"别再重复同一步"），但只进过程区。
                    insertAgentResult('已取消写入：目标文件已存在，而你没有允许覆盖它。\n'
                        + '目标：' + (path || '（未提供路径）')
                        + '\n（想保留原文件的话，可以让 AI 换一个新文件名保存。）', { asContext: true });
                    // 同上：必须有明确返回值，否则模型收到的是"没有返回结果"（假失败）
                    return { ok: false, text: '用户没有允许覆盖，这一步没有执行：' + (path || '（未提供路径）') };
                }
                // resetTimer：用户在弹窗上犹豫的时间不是写入的执行耗时（同 needApproval 分支）
                updateTurnTool(traceItem, { state: 'running', result: '用户已允许覆盖，正在写入…', resetTimer: true });
                result = await send(true);
            } else if (result.needCreate) {
                // strict 档下**新建文件同样要确认**：
                //   若只拦覆盖，最低档下 AI 就能在桌面无声新建文件
                //   （用户选了「逐条确认」却没有任何弹窗）。服务端对新建
                //   也回 needCreate，这里据此走确认分支。
                updateTurnTool(traceItem, { state: 'running', result: '⚠️ 正在等用户确认是否新建这个文件…' });
                if (!await confirmAgentCreate(path)) {
                    updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许新建这个文件' });
                    insertAgentResult('已取消写入：你没有允许新建这个文件。\n'
                        + '目标：' + (path || '（未提供路径）'), { asContext: true });
                    return { ok: false, text: '用户没有允许新建这个文件：' + (path || '（未提供路径）') };
                }
                updateTurnTool(traceItem, { state: 'running', result: '用户已允许，正在写入…', resetTimer: true });
                result = await send(true);
            }
        } else {
            // ls / read：读取不问确认（三档一致）。
            // 这三档模型下服务端不会回 needEscalation（越界申请），所以这里不必处理它。
            const buildQuery = () => 'access=' + encodeURIComponent(access)
                + (path ? '&path=' + encodeURIComponent(path) : '');
            result = await (await fetch(`/api/agent/${action}?${buildQuery()}`)).json();
        }
        // 错误信息：后端返回 payload.message / rawText（修复"未知错误"）
        const errMsg = (() => {
            const msg = result?.payload?.message || result?.message || '';
            if (msg) return String(msg);
            const raw = String(result?.rawText || '');
            if (raw && !raw.startsWith('{')) return raw.slice(0, 200);
            try { const j = JSON.parse(raw); return String(j?.message || j?.error || '') || raw.slice(0, 200); } catch { return raw.slice(0, 200); }
        })() || '未知错误';
        if (result.ok) {
            let resultText;
            if (action === 'ls') {
                // 「（链接）」标记 Windows 的 junction（`All Users`、`My Documents` 这类）。
                // 它们既不是普通文件夹也不是文件，不标出来会让人以为列表列错了。
                const lines = (result.entries || []).map(e => {
                    const icon = e.type === 'dir' ? '📁 ' : '📄 ';
                    return icon + e.name + (e.link ? '（链接）' : '');
                });
                resultText = `目录内容（${result.path || ''}）：\n` + lines.join('\n');
            } else if (action === 'read') {
                resultText = `文件内容（${result.path || ''}）：\n${result.content || '（空文件）'}`;
            } else if (action === 'delete') {
                resultText = `🗑️ 已删除${result.wasDir ? '目录' : '文件'}：${result.path || path}`;
            } else {
                resultText = `✅ 已保存到：${result.path || path}`;
            }
            updateTurnTool(traceItem, {
                state: 'ok',
                // 结果摘要截断：过程行展开区有 max-height，但整篇文件内容塞进去
                // 会让 DOM 变得很重（几万字的文件每次重绘都要 escape 一遍）
                result: resultText.length > 4000 ? resultText.slice(0, 4000) + '\n…（已截断）' : resultText
            });
            agentConsecutiveFailures = 0; // 成功了就把重试预算还回去
            // 两条通道的结果送达方式不同：标签通道（ownTrace）没有外层调用者，只能自己插进对话并排续跑；
            //   工具通道由 runToolCalls 以 role:'tool' 回灌并自己排续跑，这里再插一条就是同一件事说两遍。
            if (ownTrace) insertAgentResult(resultText, { continueLoop: true, asContext: true });
            // 必须返回结果对象：工具通道的调用点写作 `await ElainaOps.invoke(...) || { ok:false, ... }`，
            //   裸 return 会把**真的写成功**的文件报成失败，并覆盖刚标记成成功的过程行。
            return { ok: true, text: resultText };
        } else {
            // 失败：把原因交给 AI，让它以角色口吻自然解释（不直接甩原始错误）
            updateTurnTool(traceItem, { state: 'error', result: errMsg });
            agentConsecutiveFailures += 1;
            // 工具通道不在这里让角色开口：模型拿到 role:'tool' 的失败原因后
            //   会自己接着处理（换方式或如实说明），那是 agent loop 的正常一环。
            if (ownTrace) await explainAgentFailure(errMsg);
            return { ok: false, text: errMsg };
        }
    } catch (err) {
        const reason = (err && err.message) || String(err);
        updateTurnTool(traceItem, { state: 'error', result: reason });
        agentConsecutiveFailures += 1;
        if (ownTrace) await explainAgentFailure(reason);
        return { ok: false, text: reason };
    }
}

/**
 * 执行 AI 请求的电脑命令（[操作:电脑命令 …]）。
 *
 * 三档权限在这里的落点：
 *   · strict → 每条命令都要用户确认（服务端一律回 needApproval）
 *   · auto   → 安全命令直接执行；危险命令（含删除类）服务端回 needApproval，这时才问
 *   · full   → 全部直接执行，服务端不回 needApproval
 *
 * 为什么危险判定要"先问服务端、再问用户"，而不是前端自己判：
 *   前端判会把规则抄一份（两份规则必然走样），而且服务端无论如何都要再判一次
 *   （前端可绕过）。让服务端当唯一权威，前端只负责"把服务端的判定转成一次点击"。
 */
async function doAgentCommand(command, access, traceItem) {
    // 复用已有的过程行（见 setExec 处的说明）：工具通道已经记过「调用 run_command」
    const ownTrace = !traceItem;
    if (ownTrace) {
        traceItem = recordTurnTool({
            kind: 'command',
            title: '执行命令',
            summary: command,
            args: JSON.stringify({ command: command || '' }),
            state: 'running'
        });
    } else {
        updateTurnTool(traceItem, { kind: 'command', title: '执行命令', summary: command });
    }

    // APK 没有本机服务端，/api/agent/exec 不存在 —— 直接如实说明，不要去发一个必然失败的请求
    if (IS_NATIVE_APP) {
        const msg = '当前是安卓 App，没有本机服务端，无法执行电脑命令。'
            + '请在电脑上运行本应用（node web/serve.mjs）后用浏览器打开。';
        updateTurnTool(traceItem, { state: 'stopped', result: msg });
        insertAgentResult(msg);
        // 必须有返回值：这条也经 ElainaOps.invoke 交给 runToolCalls，
        //   裸 return 会让模型收到「没有返回结果」，把"平台不支持"误读成"执行失败"。
        return { ok: false, text: msg };
    }

    try {
        const send = (approved) => fetch('/api/agent/exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access, command, approved })
        }).then(r => r.json());

        let result = await send(false);

        // 服务端判定为危险 → 现在才问用户（安全命令已经在上面执行完了，不打扰）。
        //   等待期间要在过程行上**说出来**：弹窗可能十几秒没人点，行却一直是
        //   转圈状态，用户分不清"卡住了"还是"在等我做决定"。
        if (result && result.needApproval) {
            updateTurnTool(traceItem, { state: 'running', result: '⚠️ 这条命令被判定为危险操作，正在等用户确认…' });
            if (!await confirmAgentDangerousCommand(command, result.reasons)) {
                updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许执行这条命令' });
                insertAgentResult('已跳过这条命令：用户没有允许。请换一种更安全的方式，或先向用户说明为什么要执行它。', { asContext: true });
                return { ok: false, text: '用户没有允许执行这条命令' };
            }
            // resetTimer：用户在弹窗上犹豫的时间不是命令的执行耗时 —— 不重置的话，
            //   等待 17 秒会显示成"命令跑了 20 秒"，把正常的确认流程误报成性能问题。
            updateTurnTool(traceItem, { state: 'running', result: '用户已允许，正在执行…', resetTimer: true });
            result = await send(true);
        }

        if (result && result.ok) {
            const text = String(result.text || '').trim() || '（命令已执行，没有输出）';
            updateTurnTool(traceItem, {
                state: 'ok',
                result: text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断）' : text
            });
            agentConsecutiveFailures = 0;
            // 两条通道分开（理由同 doAgentFile）：工具通道的结果由 runToolCalls 以 role:'tool' 回灌。
            if (ownTrace) insertAgentResult('命令执行结果：\n' + text, { continueLoop: true, asContext: true });
            // 必须返回结果对象（理由同 doAgentFile）：工具通道会把它读成「没有返回结果」，把成功报成失败。
            return { ok: true, text };
        } else {
            const errMsg = String(result?.message || result?.text || result?.stderr || '命令执行失败');
            updateTurnTool(traceItem, { state: 'error', result: errMsg });
            agentConsecutiveFailures += 1;
            if (ownTrace) await explainAgentFailure(errMsg);
            return { ok: false, text: errMsg };
        }
    } catch (err) {
        const reason = (err && err.message) || String(err);
        updateTurnTool(traceItem, { state: 'error', result: reason });
        agentConsecutiveFailures += 1;
        if (ownTrace) await explainAgentFailure(reason);
        return { ok: false, text: reason };
    }
}

// 连续失败计数：AI 解释完失败原因后，允许它**自动重试一次**。
// 为什么需要：最常见的失败是「AI 猜错了路径」（例如桌面被移动过），而失败原因里
// 已经带着真实路径（见 serve.mjs 的 shellFolderHint）—— 它本来就能自己纠正，
// 却因为「解释失败」这条路径不执行标签而只能干等着用户说"继续"。
// 必须限次：否则「失败 → 解释 → 重试 → 再失败」会变成无限循环，一次误判就能刷光额度。
let agentConsecutiveFailures = 0;
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

