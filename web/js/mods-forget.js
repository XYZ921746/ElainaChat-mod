/* ============================================================================
 * 插件移除（从 mods.js 拆出）
 *
 * forgetMod：删插件时清启用状态、注册项、服务、工厂与已注入脚本记录。
 * ========================================================================== */
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
    /**
     * 忘掉某个插件的启用状态（删插件时调用）。
     *
     * 为什么删了还要清这个键：留着它没意义（插件都没了），更要紧的是
     * **重装同一个插件时会读到旧状态** —— 若上次是"已启用"，重装后会直接
     * 自动启用，而插件的约定是"默认关闭、用户手动开"。那会让新装的插件
     * 在用户不知情时改动界面。
     */
    function forgetMod(id) {
        try {
            Store.removeItem(MOD_ENABLED_KEY_PREFIX + id);
            const entry = getRegistry().get(id);
            getRegistry().delete(id);
            // 真删：这个 mod 注册过的插槽/样式/提示词/事件订阅一并释放。
            //   只删目录不释放注册项的话，界面里会留下一个点了没反应的入口
            //   （它指向的插件已经不在了）—— 比"没装过"更难理解。
            disposeContributions(id);
            removeModServices(id);
            // 工厂也丢掉：重装同一个插件时应当是一次干净的重注册
            getPendingRegistrations().delete(id);
            const rn = entry && entry.regName;
            if (rn) {
                getRegByDir().forEach((v, k) => { if (v === rn) getRegByDir().delete(k); });
                getDirByReg().delete(rn);
            }
            // 清掉"已注入脚本"的记录时要同时认 id 与**实际目录名** ——
            // 两者可能不同（见 modDir 说明），只按 id 匹配会漏删，
            // 于是重装同一个插件时脚本不会被重新注入（表现为"装了没反应"）。
            // 匹配**锚定在 getModRoot() 紧后方的第一个路径段**，不做子串匹配：
            //   ① 原生模式下 URL 是 `…/_capacitor_file_/…/files/mods/<id>/…`，
            //      而插件 id 允许叫 `files` / `data` —— 子串匹配下卸载一个叫 `files`
            //      的插件会把**所有**插件的注入记录全清掉（`/files/` 撞进每个 URL）。
            //   ② 桌面端同理：id 叫 `mods` 的插件 needle `'/mods/'` 同样全命中。
            //   锚定后 `…/mods/foo/…` 命中，而 `…/mods/foo-bar/…`、`…/files/foo/…`、
            //   `…/mods/bar/foo/…` 都不命中（斜杠边界）。
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
