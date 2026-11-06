// Agent 操作注册表：一份操作定义、两条触发通道（正文 [操作:…] 与原生 function calling），必须共用同一份定义，否则同一操作在两条路上参数/风险档不同；本文件纯声明 + 查询，执行实现由 setExec() 挂入。
(function () {
    'use strict';

    if (window.ElainaOps) return;   // 幂等：重复引入不覆盖

    const ops = new Map();
    const execs = new Map();

    // 只接受代码里的声明：技能目录扫出来的东西走 registerKnowledge()，那条路永远得不到可执行条目 —— 否则"装一个 zip"就等于"给自己发执行能力"。
    function define(op) {
        const name = String((op && op.name) || '').trim();
        if (!name) throw new Error('操作必须有 name');
        if (ops.has(name)) throw new Error('操作重名（同一份定义不该注册两次）：' + name);
        const tool = String((op && op.tool) || '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tool)) throw new Error('工具名必须是 ASCII snake_case：' + tool);
        if ([...ops.values()].some((o) => o.tool === tool)) throw new Error('工具名重名：' + tool);
        const entry = {
            name, tool,
            ns: String(op.ns || ''),
            kind: 'tool',
            desc: String(op.desc || ''),
            schema: op.schema || { type: 'object', properties: {} },
            risk: op.risk || 'sensitive',
            system: op.system !== false,          // 默认系统级（内置能力都不该出现在技能列表）
            // 只进工具清单、不进 L1 能力索引（目前只有 agent_help：标签通道调不到它，写进索引等于教模型输出没人处理的标签）
            indexHidden: op.indexHidden === true,
            // 这条操作"什么时候该把说明书发过去"的关键词（退化为标签通道时用，见 opsForIntent）；挂在条目自己身上而不是另写判据表：分开后加能力时必然漏改一边。
            hints: Array.isArray(op.hints) ? op.hints.map((h) => String(h)).filter(Boolean) : [],
            available: typeof op.available === 'function' ? op.available : () => true,
        };
        ops.set(name, entry);
        return entry;
    }

    // 纯知识条目（来自用户安装的 SKILL.md）：没有 schema、没有 exec，invoke() 直接拒绝，"技能"与"能力"的边界钉在数据结构上。
    function registerKnowledge(id, desc) {
        const name = 'skill:' + String(id || '').trim();
        if (ops.has(name)) return;
        ops.set(name, {
            name, tool: '', ns: 'skill', kind: 'knowledge',
            desc: String(desc || ''), schema: null, risk: 'safe',
            system: false, available: () => true,
        });
    }

    // 摘掉一条操作（连同执行实现与说明书）。只有运行时注册的操作需要它（目前是 MCP 工具）：停用服务器后不摘掉，它们会一直留在能力清单里、调一次失败一次。
    function undefine(name) {
        const key = String(name || '').trim();
        if (!key) return false;
        execs.delete(key);
        return ops.delete(key);
    }

    /** 挂执行实现。实现必须在 agent.js 里（本文件不碰副作用）。 */
    function setExec(name, fn) {
        if (!ops.has(name)) throw new Error('setExec 的操作还没注册：' + name);
        if (typeof fn !== 'function') throw new Error('setExec 需要函数：' + name);
        execs.set(name, fn);
    }

    // 挂"用到时才下发"的说明书（参数含义、约束、真实路径、示例）：desc 每轮都在，说明书只在模型真要动手时发；收函数而非字符串，因为真实路径是运行时探测的。
    function setManual(name, manual) {
        const op = ops.get(name);
        if (!op) throw new Error('setManual 的操作还没注册：' + name);
        op.manual = manual;
    }

    function manualFor(id) {
        const op = resolve(id);
        if (!op) return '';
        if (typeof op.manual === 'function') {
            try { return String(op.manual() || ''); } catch { return ''; }
        }
        return String(op.manual || '');
    }

    function get(name) { return ops.get(name) || null; }

    // 按内部 name 或 ASCII 工具名取条目：标签通道传 name（action 标识），tool_call 传 tool，映射只在本文件维护一份。
    function resolve(id) {
        const key = String(id || '').trim();
        if (!key) return null;
        if (ops.has(key)) return ops.get(key);
        for (const op of ops.values()) if (op.tool && op.tool === key) return op;
        return null;
    }

    function list(kind) {
        const all = [...ops.values()];
        return kind ? all.filter((o) => o.kind === kind) : all;
    }

    /** 此刻可用的可执行操作（按当前权限档 / 开关 / 平台收窄） */
    function availableOps() {
        return list('tool').filter((o) => {
            try { return Boolean(o.available()); } catch { return false; }
        });
    }

    // 这次请求该带哪些工具（tools[].function 形状）。只列可用的：发过去用不了的工具，模型会对着拒绝理由反复重试。
    function toolsForAccess() {
        return availableOps().map((o) => ({
            type: 'function',
            function: { name: o.tool, description: o.desc, parameters: o.schema },
        }));
    }

    // L1「能力索引」：每行一项，给提示词用（与 tools 声明同源）。工具清单只在支持 function calling 的供应商上存在，走标签降级通道时模型只能靠这份索引知道有哪些能力；技能也带 skill: 前缀进索引、永不进工具清单。
    function indexLines() {
        const tools = availableOps().filter((o) => !o.indexHidden).map((o) => o.tool + ' — ' + o.desc);
        const knowledge = list('knowledge')
            .filter((o) => { try { return Boolean(o.available()); } catch { return false; } })
            .map((o) => o.name + ' — ' + o.desc);
        return tools.concat(knowledge);
    }

    // 按用户这句话的意图挑出该下发的操作（只给降级到标签通道时用）：那条通道没有 agent_help 可调，说明书只能按条目自己的 hints 命中关键词来挑；全发等于把提示词又塞回来。
    function opsForIntent(text) {
        const t = String(text || '');
        if (!t) return [];
        return availableOps().filter((o) => o.hints.length && o.hints.some((h) => t.includes(h)));
    }

    /** 执行一个操作。两条通道最终都到这里（内部 name 与工具名都收，见 resolve）。 */
    async function invoke(id, args, ctx) {
        const op = resolve(id);
        if (!op) return { ok: false, text: '未知操作：' + id };
        if (op.kind !== 'tool') return { ok: false, text: '这条目是技能（纯知识），不能执行：' + op.name };
        const fn = execs.get(op.name);
        if (!fn) return { ok: false, text: '操作没有实现：' + op.name };
        return await fn(args || {}, ctx || {});
    }

    window.ElainaOps = {
        define, registerKnowledge, undefine, setExec, setManual, manualFor,
        get, resolve, list, availableOps, toolsForAccess, indexLines, opsForIntent, invoke,
    };
})();
