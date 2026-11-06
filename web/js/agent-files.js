// Agent 文件操作 / 命令执行 / 不可逆操作确认。
'use strict';

// 危险命令确认：只有 strict / auto 档的危险命令走到这里（full 档不回 needApproval）；「逐条确认」不做同对话只问一次的豁免。
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

// 覆盖确认：服务端是权威，不带 overwrite:true 拿不到覆盖能力；前端只决定问不问。
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

// 新建确认：strict 档下新建也要问，否则 AI 能不经同意在桌面无声新建文件（服务端只在 strict 档回 needCreate）。
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

// 删除确认：只有 strict 档会走到这里，auto 档服务端直接拒绝，full 档直接执行；删除不进回收站、无法恢复。
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

async function doAgentFile(action, { path, content } = {}, access, traceItem) {
    // 过程记录复用工具通道已记的那一行（再记一次会让同一动作在时间线上出现两次）；只有标签通道才自己建行。
    const ownTrace = !traceItem;
    const kindMap = { ls: 'search', read: 'read', write: 'write', delete: 'write' };
    const titleMap = { ls: '列出文件', read: '读取文件', write: '写入文件', delete: '删除' };
    if (ownTrace) {
        traceItem = recordTurnTool({
            kind: kindMap[action] || 'file',
            title: titleMap[action] || ('文件 · ' + action),
            summary: path || '（未提供路径）',
            args: JSON.stringify(action === 'write' ? { path: path || '', content: content || '' } : { path: path || '' }),
            state: 'running'
        });
    } else {
        updateTurnTool(traceItem, {
            kind: kindMap[action] || 'file',
            title: titleMap[action] || ('文件 · ' + action),
            summary: path || '（未提供路径）',
        });
    }
    try {
        let result;
        if (action === 'delete') {
            // 删除走独立接口，必须用同源 fetch：postJsonFromDevice 会走本机中转，相对路径会报「目标地址无效」。
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
            if (result.needDelete) {
                updateTurnTool(traceItem, { state: 'running', result: '⚠️ 删除不可恢复，正在等用户确认…' });
                if (!await confirmAgentDelete(path, result.isDir)) {
                    updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许删除' });
                    insertAgentResult('已取消删除：用户没有允许。\n目标：' + (path || '（未提供路径）'), { asContext: true });
                    // 必须返回结果对象，不能裸 return：裸 return 会被读成"没有返回结果"，成功被说成失败。
                    return { ok: false, text: '用户没有允许删除：' + (path || '（未提供路径）') };
                }
                updateTurnTool(traceItem, { state: 'running', result: '用户已允许，正在删除…', resetTimer: true });
                result = await send(true);
            }
        } else if (action === 'write') {
            // 必须用同源 fetch，不能用 postJsonFromDevice：后者走本机中转会解析失败，写入永远不成功。
            const send = async (overwrite) => {
                const res = await fetch('/api/agent/write', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ access, path, content, overwrite })
                });
                const r = await res.json();
                if (!r.rawText) r.rawText = JSON.stringify(r);
                if (!('ok' in r)) r.ok = res.ok;
                return r;
            };
            result = await send(false);
            if (result.needOverwrite) {
                updateTurnTool(traceItem, { state: 'running', result: '⚠️ 目标文件已存在，正在等用户确认是否覆盖…' });
                if (!await confirmAgentOverwrite(path)) {
                    updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许覆盖这个文件' });
                    insertAgentResult('已取消写入：目标文件已存在，而你没有允许覆盖它。\n'
                        + '目标：' + (path || '（未提供路径）')
                        + '\n（想保留原文件的话，可以让 AI 换一个新文件名保存。）', { asContext: true });
                    return { ok: false, text: '用户没有允许覆盖，这一步没有执行：' + (path || '（未提供路径）') };
                }
                updateTurnTool(traceItem, { state: 'running', result: '用户已允许覆盖，正在写入…', resetTimer: true });
                result = await send(true);
            } else if (result.needCreate) {
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
            const buildQuery = () => 'access=' + encodeURIComponent(access)
                + (path ? '&path=' + encodeURIComponent(path) : '');
            result = await (await fetch(`/api/agent/${action}?${buildQuery()}`)).json();
        }
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
                result: resultText.length > 4000 ? resultText.slice(0, 4000) + '\n…（已截断）' : resultText
            });
            agentConsecutiveFailures = 0; // 成功了就把重试预算还回去
            if (ownTrace) insertAgentResult(resultText, { continueLoop: true, asContext: true });
            return { ok: true, text: resultText };
        } else {
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

// 三档落点：strict 每条都问；auto 安全命令直接执行、危险命令回 needApproval；full 全部直接执行。
// 危险判定由服务端当唯一权威，前端只负责把判定转成一次点击。
async function doAgentCommand(command, access, traceItem) {
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

    if (IS_NATIVE_APP) {
        const msg = '当前是安卓 App，没有本机服务端，无法执行电脑命令。'
            + '请在电脑上运行本应用（node web/serve.mjs）后用浏览器打开。';
        updateTurnTool(traceItem, { state: 'stopped', result: msg });
        insertAgentResult(msg);
        return { ok: false, text: msg };
    }

    try {
        const send = (approved) => fetch('/api/agent/exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access, command, approved })
        }).then(r => r.json());

        let result = await send(false);

        if (result && result.needApproval) {
            updateTurnTool(traceItem, { state: 'running', result: '⚠️ 这条命令被判定为危险操作，正在等用户确认…' });
            if (!await confirmAgentDangerousCommand(command, result.reasons)) {
                updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许执行这条命令' });
                insertAgentResult('已跳过这条命令：用户没有允许。请换一种更安全的方式，或先向用户说明为什么要执行它。', { asContext: true });
                return { ok: false, text: '用户没有允许执行这条命令' };
            }
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
            if (ownTrace) insertAgentResult('命令执行结果：\n' + text, { continueLoop: true, asContext: true });
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

// 连续失败计数：解释完失败原因后允许自动重试一次（最常见失败是猜错路径，原因里已带真实路径）。
// 必须限次，否则「失败 → 解释 → 重试」会变成无限循环，一次误判刷光额度。
let agentConsecutiveFailures = 0;
