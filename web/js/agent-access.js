/* ============================================================================
 * AI Agent 权限档位（从 agent.js 拆出）
 *
 * AGENT_ACCESS_LEVELS / currentAgentAccess / agentAccessDisabled /
 * 删除与变更确认判据 / phoneTierAllows。
 * ========================================================================== */
'use strict';

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



