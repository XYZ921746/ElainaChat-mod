/* ============================================================================
 * Agent 操作注册表：一份操作定义，两种触发方式
 *
 * 触发通道有两条：正文里的 [操作:…]（任何模型都能用，降级通道）与原生
 * function calling（参数结构化）。两条通道必须共用同一份定义 —— 各写一份
 * 迟早会出现"同一操作在两条路上参数/风险档不同"。
 *
 * 本文件是纯声明 + 查询，不认识具体实现；执行实现由 agent.js 用 setExec() 挂入。
 *
 * 条目形状：
 *   name       内部 id，标签通道按它分发
 *   tool       进 tools[].function.name 的 ASCII 名字；与 name 分开是因为
 *              name 要兼容已有中文 action，两者一一对应，只在本文件维护
 *   ns         file / pc / phone / app
 *   kind       'tool'（能执行）| 'knowledge'（纯知识，永不执行）
 *   desc       一句话说明，同时用作 L1 能力索引与 tool description
 *   schema     function calling 参数形状，两条通道共用
 *   risk       'safe' | 'sensitive' | 'dangerous'（值取自 agent.js 的 AGENT_RISK）
 *   system     true = 系统级条目，不出现在技能管理界面、不可装卸
 *   available  「此刻能不能用」的判据，只调用 agent.js 已有的判定函数，
 *              不在这里抄第二份规则
 *
 * 参数含义、示例等说明书不在这里，按需下发（见 data.js）。
 * ========================================================================== */
(function () {
    'use strict';

    if (window.ElainaOps) return;   // 幂等：重复引入不覆盖

    const ops = new Map();    // name -> 条目
    const execs = new Map();  // name -> (args, ctx) => Promise|void

    /**
     * 注册一个**可执行**操作（kind:'tool'）。
     *
     * 只接受代码里的声明：技能目录扫出来的东西走 registerKnowledge()，
     * 那条路永远得不到可执行条目 —— 否则"装一个 zip"就等于"给自己发执行能力"。
     */
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
            // 只在工具清单里出现、不进 L1 能力索引的条目（目前只有 agent_help 这个"查手册"的元工具：
            //   标签通道没有它可调用，写进索引等于教模型输出一条没人处理的标签）
            indexHidden: op.indexHidden === true,
            // 这条操作"什么时候该把说明书发过去"的关键词（退化为标签通道时用，见 opsForIntent）。
            //   为什么挂在条目自己身上、而不是另写一张判据表：那张表一旦与操作分开，
            //   加能力时必然漏改一边 —— 与 indexLines 同源的教训。关键词是这条操作
            //   自己的知识，和 desc / schema / manual 一样住在它的定义里。
            hints: Array.isArray(op.hints) ? op.hints.map((h) => String(h)).filter(Boolean) : [],
            available: typeof op.available === 'function' ? op.available : () => true,
        };
        ops.set(name, entry);
        return entry;
    }

    /**
     * 注册一条**纯知识**条目（来自技能：用户安装的 SKILL.md）。
     *
     * 它没有 schema、没有 exec，永远不能被 tool_calls 触发 —— invoke() 对它直接拒绝。
     * 这就把"技能"与"能力"的边界钉在数据结构上，而不是靠注释约定。
     */
    function registerKnowledge(id, desc) {
        const name = 'skill:' + String(id || '').trim();
        if (ops.has(name)) return;
        ops.set(name, {
            name, tool: '', ns: 'skill', kind: 'knowledge',
            desc: String(desc || ''), schema: null, risk: 'safe',
            system: false, available: () => true,
        });
    }

    /** 挂执行实现。实现必须在 agent.js 里（本文件不碰副作用）。 */
    function setExec(name, fn) {
        if (!ops.has(name)) throw new Error('setExec 的操作还没注册：' + name);
        if (typeof fn !== 'function') throw new Error('setExec 需要函数：' + name);
        execs.set(name, fn);
    }

    /**
     * 挂这项操作**用到时才下发**的说明书（参数含义、约束、真实路径、示例）。
     *
     * 为什么不写在 desc 里：desc 是每一轮都在的（L1 索引 + tool description），
     *   而说明书只在模型真要动手那一刻才值得发过去 —— 现在每轮塞进提示词的
     *   Agent Skill 文案有两千多字，真正用得上的通常只有一段，真实路径还被压在
     *   整段末尾，模型根本注意不到。
     *
     * 收函数而不是字符串：说明书里的"这台电脑的真实路径"是运行时探测来的
     *   （见 core.js 的 agentRootsText），不能在这里定死。
     */
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

    /**
     * 按**内部 name 或 ASCII 工具名**取条目。
     *
     * 为什么两种都收：标签通道传来的是内部 name（'file_write'，历史沿用的 action 标识），
     *   tool_call 传来的是 ASCII 工具名（'save_file'）。映射只在本文件里维护一份。
     */
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

    /**
     * 这次请求该带哪些工具（`tools[].function` 的形状，不是工具调用）。
     *
     * 只列**可用**的：把用不了的工具也发过去，模型会去调一个必然被拒的东西，
     * 然后对着拒绝理由反复重试 —— 提示词里"能力清单与实现一致"那条纪律，
     * 在工具通道上就是这份清单。
     */
    function toolsForAccess() {
        return availableOps().map((o) => ({
            type: 'function',
            function: { name: o.tool, description: o.desc, parameters: o.schema },
        }));
    }

    /**
     * L1「能力索引」：每行一项，给提示词用（极短，与 tools 声明同源）。
     *
     * 为什么要有它：工具清单只在**支持 function calling 的供应商**上存在，
     * 走标签降级通道时模型看不到 tools —— 那时它至少要知道"这台机器上有哪些能力"。
     *
     * 技能（`kind:'knowledge'`）也进这份索引，与能力共用同一层披露：模型得先知道
     *   "有这么一份资料"才会去查它（见 agent_help）。它们的 name 带 `skill:` 前缀、
     *   且**永远不出现在工具清单里**，所以"资料"与"能力"在索引里一眼可分。
     */
    function indexLines() {
        const tools = availableOps().filter((o) => !o.indexHidden).map((o) => o.tool + ' — ' + o.desc);
        const knowledge = list('knowledge')
            .filter((o) => { try { return Boolean(o.available()); } catch { return false; } })
            .map((o) => o.name + ' — ' + o.desc);
        return tools.concat(knowledge);
    }

    /**
     * 按**用户这一句话的意图**挑出该下发的操作（只给"降级到标签通道"时用）。
     *
     * 为什么需要它：那条通道上没有 `agent_help` 可调（它本身是个工具），说明书只能
     *   靠宿主主动挑着发 —— 按条目自己的 `hints` 命中用户消息里的关键词，只发相关的那几项。
     *   全发等于把刚压下去的每轮提示词又塞回来；不发则模型只知道"有这能力"、不知道路径与注意项。
     *
     * 判据来自条目自身（`hints`），不在这里另立一张关键词表 —— 理由见 `hints` 的说明。
     */
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
        define, registerKnowledge, setExec, setManual, manualFor,
        get, resolve, list, availableOps, toolsForAccess, indexLines, opsForIntent, invoke,
    };
})();
