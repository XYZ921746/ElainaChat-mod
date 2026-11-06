/* 插件移除：forgetMod 清启用状态、注册项、服务、工厂与已注入脚本记录。 */
(function () {
    'use strict';

    window.ElainaModsForget = function (deps) {
        const getRegistry = deps.getRegistry;
        const disposeContributions = deps.disposeContributions;
        const removeModServices = deps.removeModServices;
        const getPendingRegistrations = deps.getPendingRegistrations;
        const getRegByDir = deps.getRegByDir;
        const getDirByReg = deps.getDirByReg;
        const loadedScripts = deps.loadedScripts;
        const getModRoot = deps.getModRoot;
        const MOD_ENABLED_KEY_PREFIX = deps.MOD_ENABLED_KEY_PREFIX;
    /* 忘掉某个插件的启用状态（删插件时调用）：留着没意义，而且重装同一插件会读到上次的状态，
     * 与"默认关闭、用户手动开"的约定冲突（新装的插件会在用户不知情时改动界面）。 */
    function forgetMod(id) {
        try {
            Store.removeItem(MOD_ENABLED_KEY_PREFIX + id);
            const entry = getRegistry().get(id);
            getRegistry().delete(id);
            // 真删：注册过的插槽/样式/提示词/事件订阅一并释放，
            //   否则界面里会留下一个指向已经不存在的插件的入口（点了没反应）
            disposeContributions(id);
            removeModServices(id);
            // 工厂也丢掉：重装同一个插件时应当是一次干净的重注册
            getPendingRegistrations().delete(id);
            const rn = entry && entry.regName;
            if (rn) {
                getRegByDir().forEach((v, k) => { if (v === rn) getRegByDir().delete(k); });
                getDirByReg().delete(rn);
            }
            // 清"已注入脚本"记录要同时认 id 与**实际目录名**（两者可能不同，只按 id 匹配会漏删，
            //   重装后脚本不再重新注入）；匹配锚定 getModRoot() 紧后方的第一个路径段而非子串 ——
            //   否则 id 叫 `files` / `mods` 的插件会因子串匹配清掉**所有**插件的记录
            const needles = ['/' + id + '/'];
            if (entry && entry.manifest && entry.manifest.dir) needles.push('/' + entry.manifest.dir + '/');
            loadedScripts.forEach((v, k) => {
                if (!k.startsWith(getModRoot())) return;
                const tail = k.slice(getModRoot().length);
                if (needles.some((n) => tail.startsWith(n.slice(1)))) loadedScripts.delete(k);
            });
        } catch (e) { /* 忽略 */ }
    }

        return { forgetMod };
    };
})();
