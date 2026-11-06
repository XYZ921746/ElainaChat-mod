'use strict';

// 一个 state.settings.agentAccess 管两件事：能碰哪里（三档都能访问任意路径）、要不要问与能不能删 —— off 关闭（不读不写不删不执行，电脑信息不再注入提示词）、strict 逐条确认（读取不问）、auto 自动通过但禁止删除、full 含删除全部放行；手机有独立总开关。
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

/** off 档给用户/模型看的统一说明：前端拦截、提示词注入、失败解释共用同一口径 */
const AGENT_DISABLED_NOTE = 'AI 的电脑操作已在设置里关闭（AI 权限 → 关闭）：'
    + '不能读取、写入或修改电脑上的任何文件，也不能执行电脑命令。'
    + '需要时可在「设置 → 能力 → AI 权限」里重新开启。';

/** 这一档允不允许删除（电脑侧）。只有 full 允许。 */
function agentAccessAllowsDelete() {
    return currentAgentAccess() === 'full';
}

/** 这一档下"改动电脑的操作"要不要逐条询问。只有 strict 要。 */
function agentAccessAsksBeforeChange() {
    return currentAgentAccess() === 'strict';
}

// 手机侧不做确认、一律放行（无障碍方式破坏力有限，模块后端 root 的风险由设置页免责声明承担）：放行策略集中一处便于将来收紧；它管"要不要问"，隐私开关 phoneReadAllowed 管"能力存不存在"。
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
        if (agentAccessDisabled()) { insertAgentResult(AGENT_DISABLED_NOTE); return; }
        const access = currentAgentAccess();
        const text = String(raw || '').trim();
        let action = 'ls';
        let rest = text;
        // 删除先判：触发词与其它几个不重叠，但先判可避免「删除文件 xxx」里的"文件"被文件分支吃掉。
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
        // 写文件的操作名必须与 agent-tags.js 分发处同一份清单：那边放行「新建文件」而这里没剥它，会让整条标签被当成路径（写到不存在的目录），表现为"说建好了、实际没有"。
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
    // 手机操作：[操作:手机点击 500 800]；停止检查与敏感操作授权由 agentRuntime 统一处理。
    agentPhoneOperation(raw) {
        void ElainaOps.invoke('phone', { raw });
    },
    // 联网搜索：[操作:搜索 今天北京天气]；把标签通道的一句话翻成工具通道的结构化参数。
    agentWebSearchOperation(raw) {
        const query = String(raw || '').replace(/^(搜索|搜一下|联网搜索|查一下)\s*[:：]?\s*/, '').trim();
        if (!query) {
            insertAgentResult('没有给出要搜索的内容。写成 [操作:搜索 要查的东西] 就行。');
            return;
        }
        void runAgentWebSearch({ query });
    },
    // 浏览器：[操作:浏览器打开 <网址>] / 看页面 / 点击 3 / 输入 3|文字 / 回车 / 关闭；标签通道传中文原文，工具通道传结构化参数，翻译后两条通道走同一个执行器。
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
    // 电脑命令：[操作:电脑命令 dir]；三档都可执行，区别只在要不要问（见 doAgentCommand 与 server 的 agentExec）。
    agentCommandOperation(raw) {
        if (agentAccessDisabled()) { insertAgentResult(AGENT_DISABLED_NOTE); return; }
        const text = String(raw || '').trim();
        const command = text.replace(/^(?:电脑命令|执行命令|运行命令|电脑执行)\s*/, '').trim();
        if (!command) {
            insertAgentResult('没有给出要执行的命令。请用 [操作:电脑命令 <命令>] 的格式。');
            return;
        }
        void ElainaOps.invoke('pc_command', { command }, { access: currentAgentAccess() });
    }
};



