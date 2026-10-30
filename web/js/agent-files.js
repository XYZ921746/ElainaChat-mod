/* ============================================================================
 * Agent 文件操作 / 命令执行 / 不可逆操作确认（从 agent.js 拆出）
 *
 * confirmAgentDangerousCommand / confirmAgentOverwrite / confirmAgentCreate /
 * confirmAgentDelete / doAgentFile / doAgentCommand。
 * 依赖 agent-runtime、结果回灌与续跑（运行时才调用）。
 * ========================================================================== */
'use strict';

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

