/* ============================================================================
 * 插件依赖判定（从 mods.js 拆出）
 *
 * manifestKeyIndex / findMissingDeps / pullUpPrerequisites。
 * 依赖注册表、全局开关与单插件开关（由 mods.js 注入）。
 * ========================================================================== */
(function () {
    'use strict';

    window.ElainaModsDeps = function (deps) {
        const getRegByDir = deps.getRegByDir;
        const modsGloballyEnabled = deps.modsGloballyEnabled;
        const isModEnabled = deps.isModEnabled;
        const setModEnabled = deps.setModEnabled;
        const getRegistry = deps.getRegistry;
        const getDirByReg = deps.getDirByReg;
    /**
     * 清单索引：清单 id / 目录名 / 注册名 → 清单条目。
     *
     * 三种键都可能被 `after` 引用（用户改过目录名、manifest 没写 id 时，
     * 依赖方写的仍是脚本里的注册名）—— 建索引用的地方不止一处，
     * 各写一份必然漂移，收敛成一个函数。
     */
    function manifestKeyIndex(manifests) {
        const byKey = new Map();
        for (const m of manifests) {
            if (m.id) byKey.set(m.id, m);
            if (m.dir && !byKey.has(m.dir)) byKey.set(m.dir, m);
            const rn = m.dir ? getRegByDir().get(m.dir) : null;
            if (rn && !byKey.has(rn)) byKey.set(rn, m);
        }
        return byKey;
    }

    /**
     * 找出每个插件**不可用的前置插件**，并说明原因。
     *
     * ── 为什么要单独做这件事 ─────────────────────────────────────────────
     *
     * `sortByDependency` 对找不到的依赖是 `if (d) visit(...)` —— **静默跳过**。
     * mod 拆成独立分发后，"只装 galgame 不装 elaina-avatar"是常态，
     * 那时的表现是"Galgame 打开了但没有立绘"，控制台一声不响。
     *
     * ── 装了但**没启用**，等于不可用 ────────────────────────────────────
     *
     * 只判断"清单里有没有这个 id"会漏掉启用状态，漏判的典型日志是：
     *
     *     [Mod] 加载完成：elaina-avatar=disabled galgame=ready pet=ready
     *
     * 前置被禁用了，依赖它的两个插件却照样 ready —— 拿不到立绘而系统认为正常。
     * 所以判定必须同时看**启用状态**：
     *   · 前置不在清单里           → 原因：未安装
     *   · 前置在清单里但被禁用      → 原因：未启用（用户可以在设置里打开）
     *   · 前置自己被拦（缺它自己的前置）→ 原因：前置本身不可用（级联）
     * 三种情况给三种不同的提示，用户才知道该做什么。
     *
     * 身份判定要同时认**清单 id**、**目录名**、**注册名**：
     *   用户改了插件目录名、而 manifest 没写 id 时，清单 id 会等于目录名
     *   （如 `pet-renamed`），而依赖方 after 里写的仍是注册名 `pet`。
     *   只按清单 id 比会**误报"缺依赖"**，把好好的插件拦下来。
     *
     * @returns {Map<string, Array<{id:string, reason:string, fixable:boolean}>>}
     */
    function findMissingDeps(manifests) {
        const byKey = manifestKeyIndex(manifests);

        // 第一轮：只算"未安装 / 未启用"（不涉及级联）
        const missing = new Map();
        for (const m of manifests) {
            const deps = Array.isArray(m.after) ? m.after : [];
            const lack = [];
            for (const d of deps) {
                const target = byKey.get(d);
                if (!target) {
                    lack.push({ id: d, reason: '未安装', fixable: false });
                    continue;
                }
                // 前置存在但被禁用（或全局插件系统关着）→ 同样不可用
                if (!modsGloballyEnabled()) {
                    lack.push({ id: d, reason: '插件系统总开关已关闭', fixable: true });
                } else if (!isModEnabled(target.id, target)) {
                    lack.push({ id: d, reason: '未启用', fixable: true });
                }
            }
            if (lack.length) missing.set(m.id, lack);
        }

        // 第二轮：级联 —— 前置自己也被拦时，标成"前置本身不可用"。
        //   一遍不够（A 依赖 B、B 依赖 C），这里迭代到稳定，最多 N 轮。
        //   不这样做的后果：A 会显示"前置 B 已就绪"，而 B 其实也没起来。
        for (let round = 0; round < manifests.length; round++) {
            let changed = false;
            for (const m of manifests) {
                const lack = missing.get(m.id);
                if (!lack) continue;
                for (const item of lack) {
                    if (item.reason !== '未安装' && item.reason !== '未启用') continue;
                    const depBlocked = missing.has(item.id);
                    if (depBlocked) {
                        item.reason = '前置本身不可用（它自己也缺前置）';
                        item.fixable = false;
                        changed = true;
                    }
                }
            }
            if (!changed) break;
        }
        return missing;
    }

    /**
     * 把**已启用插件**的前置自动带上（只写开关，不动加载）。
     *
     * 为什么放在 loadAll 里：`after` 是"没有它我就残缺"的硬声明，用户打开
     *   依赖方的那一刻就已经表达过"要完整可用"；前置停在关闭状态时，依赖方
     *   每次启动都会被拒绝，用户还得自己去猜"还差哪个开关"。
     *   这里把这种状态自动补齐 —— 加载仍按依赖序在后面统一做，
     *   顺序保证由 sortByDependency 提供。
     *
     * 只动"装了但没启用"的前置；未安装的装不出来（交给加载期按「未安装」
     *   拒绝并说明）。环依赖用 visiting 挡住（sortByDependency 只报错，不解开环）。
     */
    function pullUpPrerequisites(manifests) {
        if (!modsGloballyEnabled()) return;   // 总开关关着时一切都不加载，别动开关
        const byKey = manifestKeyIndex(manifests);
        const pulled = [];
        const visit = (m, visiting) => {
            for (const d of (Array.isArray(m.after) ? m.after : [])) {
                const dep = byKey.get(d);
                if (!dep) continue;                     // 未安装：加载期会报
                if (visiting.has(dep.id)) continue;     // 环
                visiting.add(dep.id);
                if (!isModEnabled(dep.id, dep)) {
                    setModEnabled(dep.id, true);
                    pulled.push(dep.name || dep.id);
                }
                visit(dep, visiting);                   // 前置的前置也要带上
            }
        };
        for (const m of manifests) {
            if (!isModEnabled(m.id, m)) continue;       // 依赖方自己没启用：它的前置不用拉
            visit(m, new Set([m.id]));
        }
        if (pulled.length) {
            console.log('[Mod] 已连同前置一起启用：' + [...new Set(pulled)].join('、')
                + '（依赖方是启用的，前置不该停在关闭状态）');
        }
    }


    /** 插件状态的**中文说明** —— 日志与设置界面共用一份，避免两处说法不一致 */
    function findByKey(key) {
        const k = String(key || '');
        if (!k) return null;
        let entry = getRegistry().get(k);
        if (!entry) {
            const dir = getDirByReg().get(k);
            if (dir) entry = [...getRegistry().values()].find((e) => (e.manifest.dir || e.manifest.id) === dir);
        }
        if (!entry) entry = [...getRegistry().values()].find((e) => (e.manifest.dir || e.manifest.id) === k);
        return entry || null;
    }

    /**
     * 谁正在用这个插件：`after` 指向它、且已启用并加载成功（ready）的插件。
     *
     * 给"停用 / 卸载"做闸门用 —— 前置一旦被关掉/删掉，正在运行的依赖方
     *   下一轮就会以"前置不可用"被拒（界面从"好好的"变成"半残"）。
     *   所以要在动手**之前**问这里，把"谁会受影响"说给用户听。
     *
     * 只算 ready 的依赖方：停用（disabled）/ 被拒（blocked）/ 坏（error）的
     *   插件本来就没在用它，拦着不让删只会让人莫名其妙。
     *
     * @returns {Array<{id:string, name:string}>} 依赖方列表（空 = 没人在用，随便动）
     */
    function dependentsOf(id) {
        const entry = getRegistry().get(id) || findByKey(id);
        if (!entry) return [];
        const out = [];
        for (const e of getRegistry().values()) {
            if (e === entry) continue;
            const after = Array.isArray(e.manifest.after) ? e.manifest.after : [];
            // 三键匹配（清单 id / 目录名 / 注册名）—— 与 findByKey 同一套判据
            if (!after.some((d) => findByKey(d) === entry)) continue;
            if (e.state === 'ready' && isModEnabled(e.manifest.id, e.manifest)) {
                out.push({ id: e.manifest.id, name: e.manifest.name || e.manifest.id });
            }
        }
        return out;
    }


        return { manifestKeyIndex, findMissingDeps, pullUpPrerequisites, findByKey, dependentsOf };
    };
})();
