// MCP 服务器**注册表**：管理多个 MCP 子进程的生命周期与工具清单。
// 为什么需要单独一层而不是直接 new 一个 client：MCP 服务器是**长命子进程**，
//   它的状态（在跑 / 起来了但握手失败 / 已退出）要能跨请求保留，且要能被
//   "列出有哪些工具"这种只读请求安全地问到 —— 只读请求不该顺手拉起一个进程。
import { createMcpClient } from './mcp-client.mjs';
import { createMcpHttpClient, resolveMcpTransport } from './mcp-http-client.mjs';

/** 单次 tools/list 结果缓存多久。MCP 服务器可以发 list_changed 通知，但很少见；
 *  缓存短一点（30 秒）既避免每次请求都往返一次，又不至于让新装工具长期不出现。 */
const LIST_CACHE_MS = 30000;

export function createMcpRegistry({ log = () => {} } = {}) {
    /** id -> { def, client, state, error, tools, toolsAt } */
    const entries = new Map();

    const normId = (raw) => String(raw || '').trim().slice(0, 64);

    /** 配置里的一台服务器 → 内部条目（保留已有连接，避免"改个名字就重启"） */
    function ensure(def) {
        const id = normId(def.id);
        if (!id) throw new Error('MCP 服务器必须有 id');
        const prev = entries.get(id);
        // signature 要包含 url/headers：改地址或改鉴权头必须重建连接，
        //   否则会继续用旧端点（表现是"改了配置还是连到原来的服务器"）。
        const transport = resolveMcpTransport(def);
        const signature = JSON.stringify([transport, def.command, def.args, def.env, def.cwd, def.url, def.headers]);
        if (prev && prev.signature === signature) {
            prev.def = def;      // 只更新展示用的名字等字段
            return prev;
        }
        // 配置变了 → 关掉旧进程，避免同时跑两份（会把同一个资源占两遍）
        if (prev) void prev.client.close().catch(() => {});
        // 按配置选传输：有 url 走远程，有 command 走本地进程（见 resolveMcpTransport）。
        //   两者都缺时不建客户端 —— 让状态停在 error 并给出可操作的提示，
        //   比建一个必然失败的连接更容易排查。
        let client;
        if (transport === 'http') {
            client = createMcpHttpClient({ ...def, id }, { log });
        } else if (transport === 'stdio') {
            client = createMcpClient({ ...def, id }, { log });
        } else {
            client = {
                id,
                async start() { throw new Error('这台服务器既没有地址（url）也没有启动命令（command）'); },
                async listTools() { return []; },
                async callTool() { throw new Error('没有可用的传输方式'); },
                async close() {},
                get running() { return false; },
                get serverInfo() { return null; },
                get initialized() { return false; },
                get transport() { return null; },
            };
        }
        const entry = {
            def, signature, transport, state: 'idle', error: '', tools: [], toolsAt: 0,
            client,
        };
        entries.set(id, entry);
        return entry;
    }

    async function startEntry(entry) {
        if (entry.state === 'ready') return entry;
        entry.state = 'starting';
        entry.error = '';
        try {
            await entry.client.start();
            entry.state = 'ready';
        } catch (err) {
            entry.state = 'error';
            entry.error = String((err && err.message) || err);
            log('MCP ' + entry.def.id + ' 启动失败：' + entry.error);
        }
        return entry;
    }

    /**
     * 拿某台服务器的工具清单（会按需启动）。
     *
     * @param {object} def 服务器配置
     * @returns {Promise<{ok:boolean, tools:Array, error:string}>}
     */
    async function listTools(def) {
        const entry = ensure(def);
        if (entry.state !== 'ready' || !entry.client.running) {
            const started = await startEntry(entry);
            if (started.state !== 'ready') return { ok: false, tools: [], error: started.error };
        }
        const now = Date.now();
        if (entry.toolsAt && now - entry.toolsAt < LIST_CACHE_MS) {
            return { ok: true, tools: entry.tools, error: '' };
        }
        try {
            entry.tools = await entry.client.listTools();
            entry.toolsAt = now;
            return { ok: true, tools: entry.tools, error: '' };
        } catch (err) {
            const message = String((err && err.message) || err);
            // 进程没了 → 状态要如实变成 error，不能继续报"ready"
            if (!entry.client.running) { entry.state = 'error'; entry.error = message; }
            return { ok: false, tools: [], error: message };
        }
    }

    async function callTool(def, toolName, args) {
        const entry = ensure(def);
        if (entry.state !== 'ready' || !entry.client.running) {
            const started = await startEntry(entry);
            if (started.state !== 'ready') return { ok: false, text: 'MCP 服务器没起来：' + started.error };
        }
        try {
            const result = await entry.client.callTool(toolName, args);
            if (!entry.client.running) { entry.state = 'error'; entry.error = '进程已退出'; }
            return result;
        } catch (err) {
            const message = String((err && err.message) || err);
            if (!entry.client.running) { entry.state = 'error'; entry.error = message; }
            return { ok: false, text: 'MCP 工具调用失败：' + message };
        }
    }

    /** 某台服务器的运行状态（**不启动它** —— 设置页刷新状态不该拉起进程） */
    function status(def) {
        const id = normId(def && def.id);
        const entry = entries.get(id);
        if (!entry) return { state: 'idle', error: '', tools: 0, serverInfo: null };
        return {
            state: entry.state,
            error: entry.error,
            tools: entry.tools.length,
            serverInfo: entry.client.serverInfo,
        };
    }

    /** 停掉某台（或全部） */
    async function stop(defOrAll) {
        if (defOrAll === undefined) {
            const all = [...entries.values()];
            entries.clear();
            await Promise.all(all.map((e) => e.client.close().catch(() => {})));
            return;
        }
        const id = normId(defOrAll && defOrAll.id);
        const entry = entries.get(id);
        if (!entry) return;
        entries.delete(id);
        await entry.client.close().catch(() => {});
    }

    return { listTools, callTool, status, stop };
}
