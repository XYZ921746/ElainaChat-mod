/* ============================================================================
 * 插件系统 —— 持久化（host.storage）
 *
 * 从 mods.js 拆出：Store 键读写、按插件 id 分区、上限保护、旧 localStorage 迁移。
 * 依赖 Store 由 mods.js 注入；测试沙箱没有真实 Store 时自动降级为空存储。
 * ========================================================================== */
(function () {
    'use strict';

    window.createModsStorage = function (Store) {
        const store = Store || { getItem: () => null, setItem() {} };

    // 存在宿主的一个 Store 键里按插件 id 分区：插件要跨重启记住状态，却拿不到宿主的 Store 内部键；
    // 自己写 localStorage 又进不了 data/（不跨设备、不进备份）。
    // 这个键必须列在 store.js 的 DATA_KEYS 白名单里，否则写入只进内存缓存、刷新即丢。
    const MOD_STORAGE_KEY = 'elaina_mod_storage';
    /** 单个插件的私有存储上限（按它自己那一片算）：防止一个失控插件撑爆共享键 */
    const MOD_STORAGE_MAX_BYTES = 1024 * 1024;

    function readModStorage() {
        try {
            const raw = Store.getItem(MOD_STORAGE_KEY);
            const o = raw ? JSON.parse(raw) : null;
            return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
        } catch (e) { return {}; }
    }
    function writeModStorage(all) {
        try { Store.setItem(MOD_STORAGE_KEY, JSON.stringify(all)); } catch (e) { /* 忽略 */ }
    }
    /** 造一块"带插件命名空间"的存储（值须 JSON 可序列化；读回来是原值） */
    function createModStorage(modId) {
        const mine = () => {
            const v = readModStorage()[modId];
            return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
        };
        return {
            get(key, fallback) {
                const o = mine();
                return Object.prototype.hasOwnProperty.call(o, String(key))
                    ? o[String(key)]
                    : (fallback === undefined ? null : fallback);
            },
            set(key, value) {
                const all = readModStorage();
                const cur = (all[modId] && typeof all[modId] === 'object' && !Array.isArray(all[modId])) ? all[modId] : {};
                cur[String(key)] = value;
                // 上限保护（按**本插件**的那一片算，不牵连别的插件）：
                //   这块存储整体落在一个 Store 键里、还要跨设备同步，一个失控的
                //   插件（循环里 append）能把它撑到几十 MB，之后每次保存/同步都
                //   变慢，而用户看不出是谁干的。超限直接拒绝并说清。
                let size = 0;
                try { size = JSON.stringify(cur).length; } catch (e) { size = 0; }
                if (size > MOD_STORAGE_MAX_BYTES) {
                    throw new Error('本插件的 host.storage 超过上限（' + Math.round(MOD_STORAGE_MAX_BYTES / 1024)
                        + ' KB），本次写入被拒绝。请清理不再需要的数据。');
                }
                all[modId] = cur;
                writeModStorage(all);
                return value;
            },
            remove(key) {
                const all = readModStorage();
                const cur = (all[modId] && typeof all[modId] === 'object' && !Array.isArray(all[modId])) ? all[modId] : {};
                delete cur[String(key)];
                all[modId] = cur;
                writeModStorage(all);
            },
            keys() { return Object.keys(mine()); },
            all() { return { ...mine() }; },
        };
    }

    /**
     * 旧插件把偏好存在浏览器 localStorage；迁到 host.storage 时一次性搬过来。
     * 只认已知的插件前缀，绝不碰宿主的设置/密钥键。目标键已存在时保留新值，
     * 这样重复启动不会把用户后来改过的设置覆盖回旧值。
     */
    const LEGACY_MOD_STORAGE = [
        { prefix: 'elaina_pet_', modId: 'pet', stripPrefix: true },
        { prefix: 'elaina_galgame_', modId: 'galgame', stripPrefix: true },
        { prefix: 'galgame.live2d.', modId: 'galgame', stripPrefix: false },
        { prefix: 'live2d.', modId: 'galgame', stripPrefix: false },
    ];
    function migrateLegacyModStorage() {
        let ls = null;
        try { ls = window.localStorage; } catch (e) { return; }
        if (!ls) return;
        const all = readModStorage();
        let changed = false;
        for (const rule of LEGACY_MOD_STORAGE) {
            let bucket = all[rule.modId];
            if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) bucket = all[rule.modId] = {};
            for (let i = 0; i < ls.length; i++) {
                const key = ls.key(i);
                if (!key || key.indexOf(rule.prefix) !== 0) continue;
                const target = rule.stripPrefix ? key.slice(rule.prefix.length) : key;
                if (!target || Object.prototype.hasOwnProperty.call(bucket, target)) continue;
                const value = ls.getItem(key);
                if (value === null) continue;
                bucket[target] = value;
                changed = true;
            }
        }
        if (changed) writeModStorage(all);
    }


        return { readModStorage, writeModStorage, createModStorage, migrateLegacyModStorage };
    };
})();
