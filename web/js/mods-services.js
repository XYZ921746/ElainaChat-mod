/* ============================================================================
 * 插件服务表 / 设置打开器 / 提示词登记（从 mods.js 拆出）
 *
 * 这三块共享同一份"插件注册后要能撤销"的生命周期：服务、设置窗、system 提示词。
 * registry / contributionSet / guardMod 由 mods.js 注入。
 * ========================================================================== */
(function () {
    'use strict';

    window.ElainaModsServices = function (deps) {
        const getRegistry = deps && deps.getRegistry ? deps.getRegistry : () => new Map();
        const contributionSet = deps && deps.contributionSet ? deps.contributionSet : () => new Set();
        const guardMod = deps && deps.guardMod ? deps.guardMod : (id, where, fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

    /**
     * 插件服务表：name -> Map(modId -> api)。
     * 宿主用 ElainaMods.service(name) 找服务，不再写插件专有全局名（D3）。
     */
    const services = new Map();
    function registerService(modId, name, api) {
        const key = String(name || '').trim();
        if (!key) return () => {};
        if (!services.has(key)) services.set(key, new Map());
        services.get(key).set(modId, api);
        return () => {
            const m = services.get(key);
            if (!m) return;
            m.delete(modId);
            if (!m.size) services.delete(key);
        };
    }
    function findService(name) {
        const key = String(name || '').trim();
        const m = services.get(key);
        if (!m) return null;
        for (const [modId, api] of m) {
            const entry = getRegistry().get(modId);
            if (entry && entry.state === 'ready') return api;
        }
        return null;
    }
    function removeModServices(modId) {
        for (const [key, m] of services) {
            m.delete(modId);
            if (!m.size) services.delete(key);
        }
    }


    /** 插件注册的 system 提示词片段：id -> text（**当前生效**的那些） */
    const promptHints = new Map();

    /**
     * 插件声明的提示词原文：id -> text（**与启用状态无关**）。
     *
     * 为什么要与 promptHints 分开：停用插件是"把这段提示词摘下来"，
     * 而不是"忘掉插件写过什么"。启用时要能原样挂回去，所以原文留在这里。
     */
    const promptHintText = new Map();

    /**
     * 给某个 mod 挂上"提示词"这条贡献（每个 mod 只挂一次）。
     *
     * 为什么延迟登记、且只登记一条：
     *   galgame 会随场景切换反复调 setPromptHint。若每次调用都新增一条贡献，
     *   停用时会反复删同一个键（无害但白涨），而"恢复"时会按登记顺序挂回
     *   **早期那份旧文本**（最后一条只会再覆盖一次，结果是巧合而非保证）。
     *   这里只挂一条，它的 activate 永远去读当前原文。
     */
    function ensurePromptHintContribution(modId) {
        const set = contributionSet(modId);
        for (const c of set) {
            if (c.__promptHint) return;
        }
        set.add({
            __promptHint: true,
            activate() {
                if (promptHintText.has(modId)) promptHints.set(modId, promptHintText.get(modId));
            },
            deactivate() { promptHints.delete(modId); },
            dispose() { promptHints.delete(modId); promptHintText.delete(modId); },
        });
    }

    /** 简易事件总线（宿主 ↔ 插件、插件 ↔ 插件） */
    const bus = new Map();

    const settingsOpeners = new Map();

    /** 登记一个插件的设置打开函数（由 settings.modal 插槽实现调用） */
    function registerSettingsOpener(modId, openers) {
        const id = String(modId || '');
        if (!id) return;
        settingsOpeners.set(id, openers || {});
        // 兼容镜像：已安装的旧插件（如 galgame 的设置面板）会直接读这张全局表
        //   去打开别的插件的设置。宿主自己不再读它，但**不能删** —— 删了这些
        //   插件会静默失效，而它们装在本机、改不了。
        try {
            if (!window.__modSettingsOpeners) window.__modSettingsOpeners = {};
            const open = openers && openers.open;
            if (typeof open === 'function') window.__modSettingsOpeners[id] = open;
        } catch (e) { /* 忽略 */ }
    }
    /** 注销（插件停用/卸载时） */
    function unregisterSettingsOpener(modId) {
        const id = String(modId || '');
        settingsOpeners.delete(id);
        try {
            if (window.__modSettingsOpeners) delete window.__modSettingsOpeners[id];
        } catch (e) { /* 忽略 */ }
    }
    /**
     * 按插件 id 关闭设置窗。
     *
     * 为什么必须有：宿主界面的 × / 点遮罩 / Esc 都只是把弹窗藏起来，
     *   它们不经过插件的 `close`，于是 spec.onClose 永远不触发 ——
     *   插件靠它保存设置、停计时器，结果就是"关窗后改动丢失、定时器还在跑"。
     */
    function closeModSettings(modId) {
        const hit = settingsOpeners.get(String(modId || ''));
        if (!hit || typeof hit.close !== 'function') return false;
        return guardMod(modId, '关闭设置窗', () => { hit.close(); return true; }, false);
    }
    /** 按插件 id 打开设置；没有则返回 false（调用方据此回落到分栏） */
    function openModSettings(modId) {
        const hit = settingsOpeners.get(String(modId || ''));
        if (!hit || typeof hit.open !== 'function') return false;
        return guardMod(modId, '打开设置窗', () => { hit.open(); return true; }, false);
    }
    /** 该插件有没有设置窗（插件卡片据此决定要不要画齿轮） */
    function hasModSettings(modId) {
        const hit = settingsOpeners.get(String(modId || ''));
        return Boolean(hit && typeof hit.open === 'function');
    }


    /** 供宿主取全部插件的提示词片段（拼进 system） */
    function collectPromptHints() {
        const out = [];
        for (const [id, text] of promptHints) {
            if (text) out.push(text);
        }
        return out;
    }


        return {
            registerService, findService, removeModServices,
            promptHints, promptHintText, ensurePromptHintContribution,
            registerSettingsOpener, unregisterSettingsOpener,
            closeModSettings, openModSettings, hasModSettings,
            collectPromptHints,
            settingsOpeners,
        };

    };
})();
