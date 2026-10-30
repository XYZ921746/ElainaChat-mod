/* ============================================================================
 * 插件启用 / 停用（从 mods.js 拆出）
 *
 * ensurePrerequisites / setEnabled：前置拉起、依赖方闸门、失败重试与
 * 贡献项挂回。依赖注册表、依赖判定、加载与错误隔离。
 * ========================================================================== */
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
    /**
     * 把 manifest.after 声明的前置插件逐个**拉到可用**：
     *   已装但没启用 → 递归 setEnabled（连它自己的前置一起拉）；已就绪 → 跳过。
     *
     * 返回拉不起来的清单（未安装 / 加载失败 / 它自己也缺前置），
     * 调用方据此**拒绝启动**并说明原因 —— 每种原因在 refusalMessage 里都有下一步。
     *
     * visiting 挡住 after 成环时的递归（sortByDependency 只报错，不解开环）。
     *
     * @returns {Promise<Array<{id:string, reason:string, fixable:boolean}>>}
     */
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

    /** 运行时启用/停用（停用只收回注册项，不卸载脚本 —— 卸载需要整页刷新） */
    /**
     * 运行时启用 / 停用。
     *
     * ⚠️ 这里有个很容易漏的点：**mod 默认是关闭的，所以它的脚本从未被注入过**
     * （loadAll 只加载"已启用"的 mod）。如果启用时只改状态和 localStorage，
     * 用户会看到开关变成"已启用"、界面却没有任何反应 —— 而且刷新后才正常，
     * 看起来像"开关坏了"。
     *
     * 所以启用时必须判断：脚本还没加载就先走一遍加载流程。
     *
     * 停用是"两步"：
     *   ① mod 自己的 setEnabled(false) —— 收起它自建的界面、停掉它的定时器
     *   ② deactivateContributions()      —— 收回它经宿主注册的东西
     *      （插槽入口、注入的样式、system 提示词、事件订阅）
     *   只有 ① 的话，host.slot 注册的设置分栏/顶部按钮、injectStyle 的样式、
     *   setPromptHint 的提示词都会**留在原地** —— 表现为"关掉了但还在起作用"。
     *
     * 已注入的脚本没法"卸载"，但停用后它不显示、不注册、不响应事件，
     *   效果上等价。真要彻底卸载得整页刷新（或删插件目录）。
     */
    async function setEnabled(id, on, visiting) {
        const entry = getRegistry().get(id);
        if (!entry) return false;

        if (!on) {
            // 停用前先问"有谁在用我"：正在运行的依赖方存在 → **拒绝停用**。
            //   为什么拦而不是连带关掉依赖方：连带关会一次动掉用户没碰的插件
            //   （他可能只是想腾点内存，并不知道这一下会连 Galgame 一起没了）；
            //   拦下并说清"先关谁"，把顺序决定权留给用户。
            //   判定放在写开关**之前**：拒绝时存储与状态都不能被改动。
            const using = dependentsOf(id);
            if (using.length) {
                const names = dependentNames(using);
                console.error('[Mod:' + id + '] 拒绝停用：' + names
                    + ' 正在使用这个插件。如需关闭，请先关闭 ' + names + '。');
                return false;
            }
        }

        if (on) {
            // 启用前先把前置拉起来（已装未启用的自动启用并加载，递归含前置的前置）。
            //   拉不起来的：**拒绝启动** —— 开关拨回关、原因写在条目上
            //   （设置页卡片显示「前置插件不可用」角标 + 每条的下一步）。
            //   为什么不"照常启动让它自己降级"：插件的降级路径是按"前置暂时
            //   不在"写的，用户实际看到的是"功能都在、人物没有"的半残界面，
            //   而且没有任何提示告诉他差了什么。
            const lack = await ensurePrerequisites(entry, visiting || new Set([id]));
            if (lack.length) {
                setModEnabled(id, false);
                entry.state = 'blocked';
                entry.missingDeps = lack;
                entry.autoDisabled = false;
                entry.error = refusalMessage(lack);
                // 拒绝启动不是加载失败：清掉旧的失败记录，
                // 免得刷新后卡片顶出另一套（过期的）说法
                clearModFailure(id);
                deactivateContributions(id);
                console.error('[Mod:' + id + '] ' + entry.error);
                emit('mod-changed', { id, enabled: false });
                return false;
            }
        }

        setModEnabled(id, on);

        if (on) {
            // 上一次是**加载失败**吗？这决定了下面走哪条路。
            // 关键区别（这里曾经出过真 bug）：
            //   · 正常的"停用后重新启用" —— 插件**成功初始化过**，只是被关掉了。
            //     脚本已经注入、工厂已经跑完，注册项还留着 spec，所以只要
            //     activateContributions() 把宿主侧的东西挂回去即可，**绝不能重跑工厂**
            //     （重跑会得到两份界面、两组定时器）。
            //   · 上次是**初始化失败** —— 工厂没跑完，它注册的东西已经被
            //     autoDisableBroken 收回了，`entry.api` 也是空的。这时"挂回去"
            //     等于把半成品重新贴到界面上，而且状态还会被强行改成 ready ——
            //     表现为"坏插件点几次之后自己启动了"。
            //     这种必须**重新走一遍初始化**（重注入脚本 + 重跑工厂），
            //     让失败的那一步再失败一次，从而继续被拦下。
            const wasFailed = entry.state === 'error' || entry.autoDisabled === true;
            // 用户手动打开 = "我想再试一次"，先把上次的失败记录清掉：
            // 否则卡片会一直顶着旧错误，哪怕这次其实加载成功了。
            // （本次若又失败，autoDisableBroken 会重新写一条。）
            clearModFailure(id);
            entry.autoDisabled = false;
            if (entry.state === 'error') { entry.state = 'pending'; entry.error = null; }
            // 还没加载过 → 现场加载（这样开关是"立即生效"，不需要刷新页面）
            // 判据用"入口脚本是否已注入"而不是 api 是否为空：
            //   · 有些 mod 没有 register()，加载完 api 就是 null —— 用 api 判会误判成"没加载过"
            //   · 重复启用时不该重复注入脚本（<script> 会被再插一遍，mod 的初始化会跑两次）
            // 判据与 loadOne **共用同一个** lastModScriptUrl：两处各拼一次 URL 时，
            //   只要 `./x.js` 这类写法被一边归一化、另一边没有，就会永远判成"没加载过"，
            //   于是每次启用都重复注入脚本。
            const src = lastModScriptUrl(entry.manifest);
            const neverLoaded = !src || !loadedScripts.has(src);
            if (neverLoaded || wasFailed) {
                // wasFailed 时必须**把"已注入"的记录清掉**，否则 loadOne 会认为
                // 脚本已经在页面上、跳过注入 —— 而那次注入之后工厂是崩过的，
                // 重跑工厂需要脚本里那个 register() 重新登记一遍。
                // （脚本重复执行本身是安全的：它只是再次调用 register 覆盖同一个条目。）
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
                // 已经初始化**成功**过：用保留的 spec 把宿主侧注册项挂回去，
                // **不重跑工厂**（工厂跑第二遍会得到两份界面/两组定时器，
                // 见 loadOne 开头的闸门）。
                // 这条路径能执行，前提是 wasFailed === false —— 也就是它上一次
                // 初始化是成功的、只是被用户关掉了。所以这里把状态标回 ready 是
                // 对的：它的 api 还在、注册项的 spec 还在，挂回去就真的在跑。
                activateContributions(id);
                if (typeof entry.api?.setEnabled === 'function') {
                    // 插件自己的开关回调也走统一边界：它抛错不该影响宿主的状态推进。
                    guardModAsync(id, '插件 setEnabled(true) 回调', () => entry.api.setEnabled(true));
                }
                entry.state = 'ready';
            }
            // 注意：loadOne 会往 getRegistry() 里塞一个**新** entry 对象，
            // 所以这里必须重新取一次，不能继续用上面那个旧引用（否则读到过期的 state）
            // 状态由**加载结果**决定，不许在这里强行改写成 ready。
            //   曾经这里写的是 `if (fresh.state !== 'error') fresh.state = 'ready'` ——
            //   而加载失败的插件被 autoDisableBroken 置成了 error 之后，
            //   下一次点击时它会被上游改成 pending，于是这条判断成立、又被改成
            //   ready：坏插件点几次之后就在界面上"启动成功"了，功能还是坏的。
            //   现在只在**真的加载成功**（loadOne 返回 ready）时才保持 ready；
            //   其余一律以上一步的结论为准。
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
