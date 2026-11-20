// 插件 Agent 工具桥：把插件注册的工具接进 ElainaOps 注册表，模型调用直达插件实现。
// 分工：本文件只管「校验 + 命名 + 通道」；故障预算（exec 抛错计入插件错误）与生命周期（停用摘除 / 启用挂回）在
// mods-host-extras.js 的 agentToolsHostApi。
// 通道完全开放且与权限档位解耦：不设确认层、不接 off/strict/auto/full（那套档位管的是内置的电脑操作）——
// 安装即信任，安全交由安装决策与开源社区审查。可见性两处：manifest.capabilities 的声明让"带工具"在清单里
// 可见，插件卡片列出登记的工具名。
(function () {
    'use strict';

    if (window.ElainaAgentToolBridge) return;   // 幂等：重复引入不覆盖

    const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

    /* 生效工具名：前缀防跨插件重名（对齐 MCP 的 mcp__<server>__<tool>）；注册名允许中文/点号，非法字符换下划线。
     * 'mod__' 前缀保证首字符恒为字母，天然过 define() 的 ASCII snake_case 白名单。 */
    function toolName(regName, localName) {
        const safeId = String(regName || '').replace(/[^A-Za-z0-9_]/g, '_');
        const safeName = String(localName || '').replace(/[^A-Za-z0-9_]/g, '_');
        return 'mod__' + safeId + '__' + safeName;
    }

    /* tool → modId、modId → [tool]：插件卡片与卸载回收都按 mod 维度取。 */
    const ownerOf = new Map();
    const toolsByMod = new Map();
    function remember(modId, tool) {
        ownerOf.set(tool, modId);
        if (!toolsByMod.has(modId)) toolsByMod.set(modId, new Set());
        toolsByMod.get(modId).add(tool);
    }
    function forget(tool) {
        const modId = ownerOf.get(tool);
        ownerOf.delete(tool);
        const set = toolsByMod.get(modId);
        if (set) { set.delete(tool); if (!set.size) toolsByMod.delete(modId); }
        return Boolean(modId);
    }

    /* 执行一个插件工具：直达实现 + 结果归一化。不接档位、不设确认层。
     * exec 已经过 mods 层的 guardModAsync 包裹（异常进故障预算），这里再兜一层只为归一化，不重复计故障。 */
    async function gatedExec(exec, args, ctx) {
        let out;
        try { out = await exec(args || {}, ctx || {}); }
        catch (e) { return { ok: false, text: '插件工具执行失败：' + String((e && e.message) || e) }; }
        if (typeof out === 'string') return { ok: true, text: out };
        if (out && typeof out === 'object') return { ok: out.ok !== false, text: String(out.text == null ? '' : out.text) };
        return { ok: false, text: '插件工具没有返回结果' };
    }

    /* 注册一个插件工具。modId = 清单 id（登记归属），regName = 插件注册名（命名空间），
     * label = 插件展示名（desc 里标注来源），spec = { name, desc, schema?, manual? }，exec 已由 mods 层包好故障隔离。
     * 返回 { ok, tool, name, unregister } 或 { ok:false, reason } —— 校验失败不抛，插件好按 reason 提示自己。 */
    function register(modId, regName, label, spec, exec) {
        const s = (spec && typeof spec === 'object') ? spec : {};
        const localName = String(s.name || '').trim();
        if (!NAME_RE.test(localName)) return { ok: false, reason: '工具名必须是 ASCII snake_case（字母开头）：' + localName };
        const desc = String(s.desc || '').trim();
        if (!desc) return { ok: false, reason: '工具必须带 desc（模型靠它决定要不要调）' };
        if (typeof exec !== 'function') return { ok: false, reason: '工具必须带执行函数' };
        if (typeof ElainaOps === 'undefined' || typeof ElainaOps.define !== 'function') {
            return { ok: false, reason: '宿主没有工具注册表（ElainaOps）' };
        }
        const tool = toolName(regName, localName);
        try {
            ElainaOps.define({
                name: tool,
                tool,
                ns: 'mod',
                desc: desc + '（来自插件「' + String(label || regName) + '」）',
                schema: (s.schema && typeof s.schema === 'object') ? s.schema : undefined,
            });
            ElainaOps.setExec(tool, (args, ctx) => gatedExec(exec, args, ctx));
            if (s.manual !== undefined && s.manual !== null) ElainaOps.setManual(tool, s.manual);
        } catch (err) {
            return { ok: false, reason: String((err && err.message) || err) };
        }
        remember(String(modId || ''), tool);
        return { ok: true, tool, name: localName, unregister() { return unregister(tool); } };
    }

    /* 摘掉一个工具（连同执行实现、说明书与登记表）。停用插件 / 卸载插件时由 mods 层按登记表逐个调用。 */
    function unregister(tool) {
        const key = String(tool || '');
        forget(key);
        if (typeof ElainaOps === 'undefined' || typeof ElainaOps.undefine !== 'function') return false;
        return ElainaOps.undefine(key);
    }

    /* 某插件当前登记的工具名（含已停用但未卸载的）：插件卡片据此列出工具清单，供用户与社区审查。 */
    function byMod(modId) {
        const set = toolsByMod.get(String(modId || ''));
        return set ? [...set] : [];
    }

    window.ElainaAgentToolBridge = { register, unregister, toolName, byMod };
})();
