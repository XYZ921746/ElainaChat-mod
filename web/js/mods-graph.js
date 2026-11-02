/* ============================================================================
 * 插件系统 —— 依赖图与提示文案（纯函数）
 *
 * 从 mods.js 拆出：拓扑排序、依赖缺失说明、拒绝文案、依赖方名单。
 * 不持有 registry 状态，输入输出都靠参数。
 * ========================================================================== */
(function () {
    'use strict';

    /** 拓扑排序：尊重 manifest.after；检测环形依赖 */
    function sortByDependency(manifests) {
        const byId = new Map(manifests.map((m) => [m.id, m]));
        const out = [];
        const mark = new Map();   // id -> 1=访问中 2=已完成

        function visit(m, chain) {
            const st = mark.get(m.id);
            if (st === 2) return;
            if (st === 1) {
                throw new Error('插件依赖成环：' + chain.concat(m.id).join(' → '));
            }
            mark.set(m.id, 1);
            for (const dep of (Array.isArray(m.after) ? m.after : [])) {
                const d = byId.get(dep);
                if (d) visit(d, chain.concat(m.id));
            }
            mark.set(m.id, 2);
            out.push(m);
        }

        for (const m of manifests) visit(m, []);
        return out;
    }


    /**
     * 把"前置为什么不可用"翻译成每条一句话（原因 + 可执行的下一步）。
     *
     * loadAll 的拒绝加载与 setEnabled 的拒绝启动**共用**这一份 ——
     * 两个入口各写一份必然漂移，用户在不同地方会看到两种说法。
     */
    function describeMissingDeps(missingDeps) {
        return (Array.isArray(missingDeps) ? missingDeps : []).map((d) => {
            const what = '前置插件「' + d.id + '」' + d.reason;
            if (d.reason === '未启用') {
                return what + ' —— 到「设置 → 插件」里把它的开关打开';
            }
            if (d.reason === '未安装') {
                return what + ' —— 需要先安装它（见 Releases 的扩展包）';
            }
            if (d.reason === '插件系统总开关已关闭') {
                return what + ' —— 到「设置 → 插件」打开「启用插件系统」并刷新页面';
            }
            if (d.reason === '加载失败') {
                return what + ' —— 先把它修好（它自己的卡片上写着失败原因），再回来打开本插件';
            }
            if (d.reason === '自身前置不可用') {
                return what + ' —— 先把它的前置补齐，再回来打开本插件';
            }
            return what + ' —— 请先修好那个插件';
        }).join('；');
    }


    /** 拒绝加载 / 拒绝启动时的完整说明（措辞与 describeMissingDeps 同源） */
    function refusalMessage(missingDeps) {
        return '已拒绝加载：' + describeMissingDeps(missingDeps)
            + '。（缺了前置就启动，功能只会是残缺的，所以这里直接拒绝而不是带病运行。）';
    }


    /** 依赖方名单拼成「A」「B」这样的可读串（日志与弹窗共用一份措辞） */
    function dependentNames(using) {
        return (using || []).map((d) => '「' + (d.name || d.id) + '」').join('、');
    }


    window.ElainaModsGraph = { sortByDependency, describeMissingDeps, refusalMessage, dependentNames };
})();
