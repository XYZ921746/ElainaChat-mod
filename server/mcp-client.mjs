// MCP 客户端：把外部 MCP 服务器提供的工具接进宿主。只做客户端 —— 做服务端等于把本机的文件读写与命令执行开放给任何能连上它的 MCP 客户端，与"BYOK、不连作者服务器、每个动作都要过权限闸"直接冲突。
// 传输用 stdio：绝大多数 MCP 服务器（npx 包、本地脚本）都讲它，连接语义也最干净（子进程活着 = 连着，退出 = 断开）。
// 协议是 JSON-RPC 2.0、按行分隔（不是 LSP 那种 Content-Length 头）：子进程往 stdout 打日志会污染这条流，解析失败的行要跳过而不是让整个连接崩掉。
import { spawn } from 'node:child_process';
import { buildInitializeParams, flattenToolResult } from './mcp-shared.mjs';

/** 握手超时：MCP 服务器首次启动可能要去装包 / 加载模型，给得比普通请求宽。 */
const INIT_TIMEOUT_MS = 30000;
/** tools/list 与 tools/call 的超时。工具调用可能很慢（抓网页、查数据库）。 */
const LIST_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 120000;
/** 协议版本。写死我们支持的版本；服务器回别的版本时仍按 1.x 的语义继续（见 initialize）。 */
const PROTOCOL_VERSION = '2025-06-18';
/** 单条响应上限：防止一个失控的服务器把内存吃光。 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * 把 stdio 上的字节流切成"一行一条 JSON"。单独抽成纯函数是因为这是唯一一处"协议边界"：切错了表现为"请求永远等不到回应"或"JSON 解析错误"，两者的现场都看不出是切分的问题 —— 抽出来才能不启进程穷举断言。
 */
export function createLineSplitter({ onMessage, onError }) {
    let buf = '';
    return {
        push(chunk) {
            buf += chunk;
            // 单行超过上限：说明对面在吐一条永不换行的巨串。断开而不是继续攒。
            if (buf.length > MAX_LINE_BYTES) {
                const err = new Error('MCP 服务器输出超长（单条超过 ' + MAX_LINE_BYTES + ' 字节）');
                onError?.(err);
                buf = '';
                return;
            }
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch {
                    // 子进程的日志污染 stdout —— 跳过这一行，别让整个连接废掉。
                    onError?.(new Error('MCP 输出了一行非 JSON，已忽略'), { ignored: true, line: line.slice(0, 200) });
                    continue;
                }
                onMessage(msg);
            }
        },
    };
}

/** 一个 MCP 服务器连接。def = { id, name, command, args, env, cwd }，opts = { log } */
export function createMcpClient(def, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const id = String(def.id || '');
    let child = null;
    let nextId = 1;
    const pending = new Map();   // id -> { resolve, reject, timer }
    let closed = false;
    let initDone = false;
    let serverInfo = null;
    let splitter = null;

    function failAll(err) {
        for (const [, p] of pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        pending.clear();
    }

    function send(message) {
        if (!child || !child.stdin || child.stdin.destroyed) {
            throw new Error('MCP 服务器「' + id + '」没有在运行');
        }
        child.stdin.write(JSON.stringify(message) + '\n');
    }

    /** 发一个 JSON-RPC 请求并等回应。超时与"连接已关"都会 reject，不挂住调用方。 */
    function request(method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (closed) { reject(new Error('MCP 服务器「' + id + '」已关闭')); return; }
            const reqId = nextId++;
            const timer = setTimeout(() => {
                pending.delete(reqId);
                reject(new Error('MCP 服务器「' + id + '」在 ' + Math.round(timeoutMs / 1000) + ' 秒内没有回应 ' + method));
            }, timeoutMs);
            // 定时器不钉住进程：服务退出时不该因为一个待决请求而卡住
            if (typeof timer.unref === 'function') timer.unref();
            pending.set(reqId, { resolve, reject, timer });
            try {
                send({ jsonrpc: '2.0', id: reqId, method, params });
            } catch (err) {
                clearTimeout(timer);
                pending.delete(reqId);
                reject(err);
            }
        });
    }

    function handleMessage(msg) {
        // 服务器发来的请求（sampling / roots 之类）：本项目一律不实现，
        //   按 JSON-RPC 规范回 -32601（方法不存在），让它自己降级 —— 沉默会让它一直等。
        if (msg.id !== undefined && msg.method) {
            try {
                send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: '本客户端不支持该方法：' + msg.method } });
            } catch { /* 连接已断 */ }
            return;
        }
        // 通知（没有 id）：目前没有需要处理的
        if (msg.id === undefined) return;
        const p = pending.get(msg.id);
        if (!p) return;   // 超时后迟到的回应，直接丢
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
            p.reject(new Error(String(msg.error.message || 'MCP 调用失败') + (msg.error.code ? '（code ' + msg.error.code + '）' : '')));
        } else {
            p.resolve(msg.result);
        }
    }

    /**
     * 把子进程的三条流接到协议层：stdout 走行切分器，stderr 只当日志。exit / error 都要把待决请求一次性 reject —— 否则每个调用方要各自等到超时。
     */
    function wireChildProcess() {
        splitter = createLineSplitter({
            onMessage: handleMessage,
            onError: (err, extra) => {
                if (extra?.ignored) { log('MCP ' + id + ' 忽略了一行非 JSON 输出：' + extra.line); return; }
                log('MCP ' + id + ' 输出错误：' + err.message);
            },
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => splitter.push(chunk));
        // stderr 只是日志，转给宿主日志即可 —— 不参与协议
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            const text = String(chunk).trim();
            if (text) log('MCP ' + id + ' stderr: ' + text.slice(0, 500));
        });
        child.on('exit', (code, signal) => {
            closed = true;
            failAll(new Error('MCP 服务器「' + id + '」已退出（code ' + code + (signal ? ', ' + signal : '') + '）'));
            child = null;
        });
        child.on('error', (err) => {
            closed = true;
            failAll(new Error('MCP 服务器「' + id + '」启动失败：' + err.message));
            child = null;
        });
    }

    /**
     * 启动子进程并完成 initialize 握手：MCP 规定客户端在拿到服务器的 capabilities 之前不能发别的请求，tools/list 发早了会被合规的服务器拒绝，而报错看起来像"这个服务器没有工具"。
     */
    async function start() {
        if (child) return;
        const command = String(def.command || '').trim();
        if (!command) throw new Error('MCP 服务器「' + id + '」没有配置启动命令');
        const args = Array.isArray(def.args) ? def.args.map(String) : [];
        // 环境变量与宿主合并而不是替换：子进程往往依赖 PATH / HOME，只给自定义的那几个会让 npx / node 直接找不到
        const env = { ...process.env, ...(def.env && typeof def.env === 'object' ? def.env : {}) };
        log('MCP 启动：' + command + (args.length ? ' ' + args.join(' ') : ''));
        // 不能用 shell:true 启动 .cmd：那会把 args 当字符串拼接，路径里有空格就断（子进程立刻 exit 1，而报错只说"已退出"）；Node 20 起对这种用法打 DEP0190 警告，理由正是"参数没转义，只是拼接"。
        // Windows 上正确做法是显式走 cmd.exe /c 并把它需要的参数原样传给 args。
        const isWinCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
        child = spawn(
            isWinCmd ? 'cmd.exe' : command,
            isWinCmd ? ['/d', '/s', '/c', command, ...args] : args,
            {
                cwd: def.cwd || undefined,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            }
        );
        wireChildProcess();

        const result = await request('initialize', buildInitializeParams({ protocolVersion: PROTOCOL_VERSION, version: opts.version }), INIT_TIMEOUT_MS);
        // 版本不匹配时不拒绝：MCP 1.x 的工具语义没有破坏性变化，硬拒等于"能用却不让用"，只记一条日志
        const negotiated = String(result?.protocolVersion || '');
        if (negotiated && negotiated !== PROTOCOL_VERSION) {
            log('MCP ' + id + ' 协商到协议版本 ' + negotiated + '（本客户端为 ' + PROTOCOL_VERSION + '），按兼容处理');
        }
        serverInfo = result?.serverInfo || null;
        initDone = true;
        // 握手完成的**通知**（没有 id，不需要回应）
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        return serverInfo;
    }

    /** tools/list 的响应 → 宿主可注册的工具描述；缺 inputSchema 的补一个空 schema。 */
    function normalizeToolList(result) {
        const raw = Array.isArray(result?.tools) ? result.tools : [];
        return raw.map((t) => ({
            name: String(t?.name || ''),
            description: String(t?.description || ''),
            // MCP 用 inputSchema，与 JSON Schema 同源 —— 可以直接当 function calling 的 parameters
            inputSchema: (t?.inputSchema && typeof t.inputSchema === 'object')
                ? t.inputSchema
                : { type: 'object', properties: {} },
        })).filter((t) => t.name);
    }

    async function listTools() {
        await start();
        const result = await request('tools/list', {}, LIST_TIMEOUT_MS);
        return normalizeToolList(result);
    }

    /**
     * 调一个工具，把 MCP 的 content 数组拍平成一段文本：宿主的工具通道只接受"一段结果文本"（回灌成 role:'tool'），而 MCP 允许 text / image / resource 多种 content，模型读得了的只有文本 —— 图片与资源降级成一句说明，直接丢 JSON 会让模型对它做二次猜测。
     */
    async function callTool(name, args) {
        await start();
        const result = await request('tools/call', {
            name: String(name || ''),
            arguments: (args && typeof args === 'object') ? args : {},
        }, CALL_TIMEOUT_MS);
        return flattenToolResult(result);
    }

    /** 关闭：先礼后兵。给 5 秒自行退出，否则强杀。 */
    async function close() {
        if (!child) { closed = true; return; }
        const proc = child;
        closed = true;
        failAll(new Error('MCP 服务器「' + id + '」已关闭'));
        try { proc.stdin.end(); } catch { /* 已断 */ }
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                try { proc.kill(); } catch { /* 已退出 */ }
                resolve();
            }, 5000);
            if (typeof timer.unref === 'function') timer.unref();
            proc.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        child = null;
    }

    return {
        id,
        start, listTools, callTool, close,
        get running() { return Boolean(child) && !closed; },
        get serverInfo() { return serverInfo; },
        get initialized() { return initDone; },
    };
}
