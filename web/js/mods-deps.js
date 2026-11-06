/* 插件依赖判定：manifestKeyIndex / findMissingDeps / pullUpPrerequisites 与三键身份查找。 */
(function () {
    'use strict';

    window.ElainaModsDeps = function (deps) {
        const getRegByDir = deps.getRegByDir;
        const modsGloballyEnabled = deps.modsGloballyEnabled;
        const isModEnabled = deps.isModEnabled;
        const setModEnabled = deps.setModEnabled;
        const getRegistry = deps.getRegistry;
        const getDirByReg = deps.getDirByReg;
    /* 清单索引：清单 id / 目录名 / 注册名 → 清单条目。`after` 三种键都可能引用，
     * 建索引的地方不止一处，各写一份必然漂移，收敛成一个函数。 */
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

    /* 找出每个插件**不可用的前置**并说明原因（未安装 / 未启用 / 级联不可用三种，提示各不同）：
     * sortByDependency 对找不到的依赖静默跳过；身份判定同时认清单 id / 目录名 / 注册名，改名后不误报。 */
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

        // 第二轮：级联 —— 前置自己也被拦时标成"前置本身不可用"；
        //   一遍不够（A 依赖 B、B 依赖 C），迭代到稳定，否则 A 会显示"前置 B 已就绪"而 B 没起来
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

    /* 把**已启用插件**的前置自动带上（只写开关，不动加载；顺序由 sortByDependency 提供）：
     * 未安装的不装（加载期按「未安装」拒绝），环依赖用 visiting 挡住 —— 否则依赖方每次启动都被拒。 */
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

    /* 谁正在用这个插件：`after` 指向它、且已启用并加载成功（ready）的依赖方 ——
     * 停用/卸载前先问它（前置一被关掉，正在跑的依赖方下一轮就会以"前置不可用"被拒）。 */
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
