/* 插件启用 / 停用：前置拉起、依赖方闸门、失败重试与贡献项挂回。 */
(function () {
    'use strict';

    window.ElainaModsEnable = function (deps) {
        const getRegistry = deps.getRegistry;
        const findByKey = deps.findByKey;
        const dependentsOf = deps.dependentsOf;
        const dependentNames = deps.dependentNames;
        const refusalMessage = deps.refusalMessage;
        const isModEnabled = deps.isModEnabled;
        const setModEnabled = deps.setModEnabled;
        const clearModFailure = deps.clearModFailure;
        const deactivateContributions = deps.deactivateContributions;
        const activateContributions = deps.activateContributions;
        const emit = deps.emit;
        const lastModScriptUrl = deps.lastModScriptUrl;
        const loadedScripts = deps.loadedScripts;
        const loadOne = deps.loadOne;
        const autoDisableBroken = deps.autoDisableBroken;
        const guardModAsync = deps.guardModAsync;
    /* 逐个拉起 manifest.after 的前置（递归；visiting 挡成环），返回拉不起来的清单供调用方拒绝启动。 */
    async function ensurePrerequisites(entry, visiting) {
        const lack = [];
        const after = Array.isArray(entry.manifest.after) ? entry.manifest.after : [];
        for (const d of after) {
            if (!d || typeof d !== 'string') continue;
            const depEntry = findByKey(d);
            if (!depEntry) {
                lack.push({ id: d, reason: '未安装', fixable: false });
                continue;
            }
            if (visiting.has(depEntry.manifest.id)) continue;    // 环：另一条链正在处理它
            visiting.add(depEntry.manifest.id);
            const ready = depEntry.state === 'ready'
                && isModEnabled(depEntry.manifest.id, depEntry.manifest);
            if (!ready) {
                await setEnabled(depEntry.manifest.id, true, visiting);
                const fresh = getRegistry().get(depEntry.manifest.id);
                if (!fresh || fresh.state !== 'ready') {
                    lack.push({
                        id: d,
                        reason: fresh && fresh.state === 'error' ? '加载失败'
                            : (fresh && fresh.state === 'blocked' ? '自身前置不可用' : '不可用'),
                        fixable: false,
                    });
                }
            }
            visiting.delete(depEntry.manifest.id);
        }
        return lack;
    }

    /* 运行时启用 / 停用：停用只收回注册项，不卸载脚本（彻底卸载需整页刷新）。
       启用的两种情形（从未注入 → 现场加载；已初始化成功 → 只挂回注册项）见函数内各分支。 */
    async function setEnabled(id, on, visiting) {
        const entry = getRegistry().get(id);
        if (!entry) return false;

        if (!on) {
            // 有正在运行的依赖方即拒绝停用（连带关会动到用户没碰的插件）；
            // 判定放在写开关之前，拒绝时存储与状态都不改
            const using = dependentsOf(id);
            if (using.length) {
                const names = dependentNames(using);
                console.error('[Mod:' + id + '] 拒绝停用：' + names
                    + ' 正在使用这个插件。如需关闭，请先关闭 ' + names + '。');
                return false;
            }
        }

        if (on) {
            // 启用前拉起前置（递归）；拉不起来即拒绝启动：开关拨回关、原因写在条目上。
            // 不"照常启动让它自己降级"：那会得到"功能都在、人物没有"的半残界面且无提示
            const lack = await ensurePrerequisites(entry, visiting || new Set([id]));
            if (lack.length) {
                setModEnabled(id, false);
                entry.state = 'blocked';
                entry.missingDeps = lack;
                entry.autoDisabled = false;
                entry.error = refusalMessage(lack);
                // 拒绝启动不是加载失败：清掉失败记录，免得卡片顶出过期说法
                clearModFailure(id);
                deactivateContributions(id);
                console.error('[Mod:' + id + '] ' + entry.error);
                emit('mod-changed', { id, enabled: false });
                return false;
            }
        }

        setModEnabled(id, on);

        if (on) {
            // 上次是否**初始化失败**决定走哪条路：失败 → 清掉已注入记录并重新走初始化
            // （工厂没跑完，注册项已被 autoDisableBroken 收回，强行挂回等于贴上半成品）；
            // 正常停用后重启用 → 只 activateContributions 挂回注册项，**绝不重跑工厂**
            const wasFailed = entry.state === 'error' || entry.autoDisabled === true;
            // 手动打开=再试一次：先清掉失败记录（本次若又失败会重新写一条）
            clearModFailure(id);
            entry.autoDisabled = false;
            if (entry.state === 'error') { entry.state = 'pending'; entry.error = null; }
            // 判据用"入口脚本是否已注入"，不用 api 是否为空（无 register() 的 mod 加载完 api 就是 null），
            // 也不重复注入脚本（<script> 会被再插一遍、初始化跑两次）；与 loadOne 共用同一个 lastModScriptUrl
            const src = lastModScriptUrl(entry.manifest);
            const neverLoaded = !src || !loadedScripts.has(src);
            if (neverLoaded || wasFailed) {
                // 失败重试必须清掉"已注入"记录，否则 loadOne 会跳过注入，而重跑工厂需要 register() 重新登记
                if (wasFailed && src) loadedScripts.delete(src);
                try {
                    await loadOne(entry.manifest);
                } catch (e) {
                    // loadOne 内部已经做了失败隔离，这里兜住它自己抛出的意外
                    const fresh = getRegistry().get(id);
                    if (fresh) {
                        fresh.state = 'error';
                        fresh.error = String((e && e.message) || e);
                        autoDisableBroken(id, fresh);
                    }
                }
            } else {
                // 初始化成功过、只是被关掉：用保留的 spec 把宿主侧注册项挂回去，
                // 不重跑工厂（跑第二遍会得到两份界面/两组定时器）；此路径能执行即 wasFailed 为 false
                activateContributions(id);
                if (typeof entry.api?.setEnabled === 'function') {
                    // 插件自己的开关回调也走统一边界：它抛错不该影响宿主的状态推进。
                    guardModAsync(id, '插件 setEnabled(true) 回调', () => entry.api.setEnabled(true));
                }
                entry.state = 'ready';
            }
            // loadOne 会往 registry 塞**新** entry，必须重新取一次（不能继续用上面那个引用）。
            // 状态只能由加载结果决定：pending 视为没有结论，保守判失败并停用；
            // 在这里按"非 error 就 ready"处理会让坏插件点几次就"启动成功"而功能仍坏
            const fresh = getRegistry().get(id);
            if (fresh && fresh.state === 'pending') {
                // loadOne 没有把它推进到任何终态（异常路径没覆盖到）：保守当成失败
                fresh.state = 'error';
                fresh.error = fresh.error || '启用过程中没有拿到明确的加载结果';
                autoDisableBroken(id, fresh);
            }
        } else {
            if (typeof entry.api?.setEnabled === 'function') {
                guardModAsync(id, '插件 setEnabled(false) 回调', () => entry.api.setEnabled(false));
            }
            deactivateContributions(id);
            entry.state = 'disabled';
        }

        emit('mod-changed', { id, enabled: on });
        return true;
    }

        return { ensurePrerequisites, setEnabled };
    };
})();
