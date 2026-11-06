// 单个插件加载：启用判定、依赖拒绝、注入、工厂执行与失败停用。
(function () {
    'use strict';

    window.ElainaModsLoadOne = function (deps) {
        const getRegistry = deps.getRegistry;
        const isModEnabled = deps.isModEnabled;
        const readModFailure = deps.readModFailure;
        const deactivateContributions = deps.deactivateContributions;
        const findByKey = deps.findByKey;
        const refusalMessage = deps.refusalMessage;
        const modsGloballyEnabled = deps.modsGloballyEnabled;
        const resolveModAsset = deps.resolveModAsset;
        const injectStyleLink = deps.injectStyleLink;
        const injectScript = deps.injectScript;
        const setLoadingDir = deps.setLoadingDir;
        const getPendingRegistrations = deps.getPendingRegistrations;
        const getRegByDir = deps.getRegByDir;
        const lifecycleFor = deps.lifecycleFor;
        const withTimeout = deps.withTimeout;
        const createHostApi = deps.createHostApi;
        const MOD_INIT_TIMEOUT_MS = deps.MOD_INIT_TIMEOUT_MS;
        const autoDisableBroken = deps.autoDisableBroken;

    /* 并发去重：显式开关与前置自动拉起同一帧到达时，两个 loadOne 会各注入一遍脚本 ——
     * 后注入的 IIFE 会顶掉前一份挂在 window 上的插件接口，而前一份的工厂晚到只会改到「已经不在 window 上的旧对象」，
     * 结果是接口残缺（如立绘基址为空）。在途装载共享同一个 Promise，工厂保证只跑一次。 */
    const inFlightLoads = new Map();
    function loadOne(manifest, missingDeps = []) {
        const prev = getRegistry().get(manifest.id);
        if (prev && prev.state === 'ready') return Promise.resolve(prev);
        const going = inFlightLoads.get(manifest.id);
        if (going) return going;
        const p = doLoadOne(manifest, missingDeps).finally(() => inFlightLoads.delete(manifest.id));
        inFlightLoads.set(manifest.id, p);
        return p;
    }

    async function doLoadOne(manifest, missingDeps = []) {
        // 幂等：已就绪的插件不重跑工厂（loadAll 被启动与多设备同步各调用一次，重跑会产出两份界面与两组定时器），挂回只走 activateContributions()
        const prev = getRegistry().get(manifest.id);
        if (prev && prev.state === 'ready') return prev;

        const entry = { manifest, state: 'pending', error: null, api: null };
        getRegistry().set(manifest.id, entry);

        // 先判本插件是否启用（前置判定在其后，否则默认关闭的插件会被误报成"坏了"）；上次失败被自动停用与用户手动关闭必须分开：原因从存储读（刷新后 registry 是空的）
        if (!isModEnabled(manifest.id, manifest)) {
            const fail = readModFailure(manifest.id);
            if (fail) {
                entry.state = 'error';
                entry.error = fail.error;
                entry.autoDisabled = true;
                entry.failedAt = fail.at;
            } else {
                entry.state = 'disabled';
            }
            deactivateContributions(manifest.id);
            return entry;
        }
        // 前置不可用 → 拒绝加载并给出可读原因（照常加载会让插件在缺依赖时降级运行：界面正常而功能缺失）；判定同时看"装没装"与"启用没启用"
        const lack = (missingDeps || []).slice();
        for (const d of (Array.isArray(manifest.after) ? manifest.after : [])) {
            if (lack.some((x) => x.id === d)) continue;    // 已有结论的不重复报
            const depEntry = findByKey(d);
            if (depEntry && (depEntry.state === 'error' || depEntry.state === 'blocked')) {
                lack.push({
                    id: d,
                    reason: depEntry.state === 'error' ? '加载失败' : '自身前置不可用',
                    fixable: false,
                });
            }
        }
        if (lack.length) {
            entry.state = 'blocked';
            entry.missingDeps = lack;
            // 被拒绝加载的插件不该继续占着界面入口或往提示词里加东西。
            deactivateContributions(manifest.id);
            entry.error = refusalMessage(lack);
            console.error('[Mod:' + manifest.id + '] ' + entry.error);
            return entry;
        }

        if (!modsGloballyEnabled()) {
            entry.state = 'disabled';
            deactivateContributions(manifest.id);
            return entry;
        }

        try {
            // 清单由插件作者编写，不可信：外链与越界路径一律拒绝；走 injectStyleLink 而非直接建 <link>，否则插件停用后 CSS 仍然生效
            for (const css of (Array.isArray(manifest.styles) ? manifest.styles : [])) {
                const href = resolveModAsset(manifest, css, 'styles');
                if (!href) throw new Error('manifest.styles 里有不合法的路径（必须是本插件目录内的相对路径）：' + css);
                injectStyleLink(manifest, href);
            }

            // 注入前记下当前目录：插件脚本执行 register 时据此归属注册名；manifest.scripts 先注入、entry 最后（装配文件要调用其它文件定义的东西）
            const entrySrc = manifest.entry || 'index.js';
            const extra = Array.isArray(manifest.scripts) ? manifest.scripts : [];
            const deps = extra.filter((s) => typeof s === 'string' && s && s !== entrySrc);
            const allScripts = [...deps, entrySrc];
            setLoadingDir(manifest.dir || manifest.id);
            try {
                for (const one of allScripts) {
                    // 脚本路径同样拒绝外链与 ../ 越界，否则 manifest 能把任意站点的 JS 注入宿主页面。
                    const src = resolveModAsset(manifest, one, 'scripts');
                    if (!src) throw new Error('脚本路径不合法（必须是本插件目录内的相对路径）：' + one);
                    await injectScript(src);
                }
            } finally {
                setLoadingDir(null);
            }

            // 先按 manifest.id 找 factory，找不到再按本目录注册名反查（用户改目录名而 manifest 没写 id 时，只按 id 查会永远查不到：插件"已加载但从不初始化"）
            let factory = getPendingRegistrations().get(manifest.id);
            let regName = manifest.id;
            // 登记记录带着来源目录：注册名与目录对不上时不能执行，这是"替别人登记工厂"的唯一信号。
            const ownedFactory = (rec) => {
                if (!rec || typeof rec.factory !== 'function') return null;
                const ownDir = manifest.dir || manifest.id;
                if (rec.dir && rec.dir !== ownDir) {
                    console.error('[Mod:' + manifest.id + '] 注册名「' + regName + '」来自另一个目录（'
                        + rec.dir + '），已拒绝执行');
                    return null;
                }
                return rec.factory;
            };
            factory = ownedFactory(factory);
            if (typeof factory !== 'function') {
                const byDir = getRegByDir().get(manifest.dir || manifest.id);
                regName = byDir || regName;
                if (byDir) {
                    const rec = getPendingRegistrations().get(byDir);
                    factory = ownedFactory(rec);
                    if (typeof factory === 'function') {
                        console.warn('[Mod:' + manifest.id + '] 清单 id 与注册名不一致（'
                            + manifest.id + ' ≠ ' + byDir + '），已按注册名加载'
                            + '（建议在 manifest.json 里显式写 "id": "' + byDir + '"）');
                    }
                }
            }

            if (typeof factory === 'function') {
                entry.regName = regName;
                // 卸载/删除时 abort，插件据此停掉轮询、下载、定时器；临时停用不触发。
                const lifecycle = lifecycleFor(manifest.id);
                // 工厂是第三方入口，可能返回永不 resolve 的 Promise；不加超时会让整轮加载一起卡住。
                entry.api = await withTimeout(
                    Promise.resolve().then(() => factory(createHostApi(manifest, regName, lifecycle))),
                    MOD_INIT_TIMEOUT_MS,
                    '初始化超时（' + Math.round(MOD_INIT_TIMEOUT_MS / 1000)
                        + ' 秒没有返回结果，插件可能卡在某个 await 上）');
            } else if (manifest.autoInit !== false) {
                // 没有 register 的插件，脚本加载成功即算可用。
                entry.api = null;
            }
            entry.state = 'ready';
        } catch (err) {
            entry.state = 'error';
            entry.error = String((err && err.message) || err);
            // 失败即停用并收回注册项（半初始化的插件会留下点不动的按钮与样式错乱）；停用状态与原因都必须写盘，否则每次启动都会重试失败、刷同一批错误
            autoDisableBroken(manifest.id, entry);
            console.error('[Mod:' + manifest.id + '] 加载失败（已自动停用，不影响其他插件）', err);
        }
        return entry;
    }

        return { loadOne };
    };
})();
