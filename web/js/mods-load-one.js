/* ============================================================================
 * 单个插件的加载与初始化（从 mods.js 拆出）
 *
 * loadOne：启用判定、前置拒绝、样式/脚本注入、工厂执行与失败停用。
 * 依赖注册表、注入器、插槽样式、贡献/生命周期与 host API 构造。
 * ========================================================================== */
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

    async function loadOne(manifest, missingDeps = []) {
        // 幂等：已经就绪的插件**不要重跑工厂**。
        //   为什么必须有这道闸：loadAll() 会被调用多次 —— 页面启动一次，
        //   多设备同步收到"插件开关变了"时还会再来一次（init.js 里那条）。
        //   没有闸门时第二次 loadOne 会照跑工厂，而 <script> 已经注入过、
        //   factory 还在 getPendingRegistrations() 里 —— 于是 galgame / pet 的
        //   工厂被执行第二遍：**两份界面、两组定时器、双击一样的响应**。
        //   "已经就绪"意味着初始化已经发生过。要重新出现只能靠
        //   activateContributions()（宿主侧注册项）或 mod 自己的 setEnabled，
        //   都不是重跑工厂。
        const prev = getRegistry().get(manifest.id);
        if (prev && prev.state === 'ready') return prev;

        const entry = { manifest, state: 'pending', error: null, api: null };
        getRegistry().set(manifest.id, entry);

        // 先看**本插件自己**要不要加载：没启用 / 插件系统总开关关着 → disabled 返回。
        //   前置的判定放在这**之后**：前置是"启动它"的前提，不是它自身的故障。
        //   一个从没启用过的插件（默认关闭的常态）不该顶着红色的
        //   「前置插件不可用」角标 —— 那是把"没开"误报成了"坏了"。
        //   「上次加载失败被自动停用」与「用户自己关的」是两种不同的关闭，
        //   必须分得开：前者要把失败原因留在卡片上（用户才知道该修什么），
        //   后者才是干干净净的"未启用"。
        //   原因从**存储**里读，不看内存的 prev：刷新后是新会话，getRegistry() 空着，
        //   只有落盘的记录还在。这就是 autoDisableBroken 必须写盘的原因。
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
        // 前置插件不可用 → **拒绝加载**，并给出可读原因。
        // 只打一句警告然后照样加载很糟：插件会在"依赖不在"的前提下跑起来 ——
        // 例如 galgame 拿不到 elaina-avatar 的接口，于是自己回落成"没有立绘"，
        // 用户看到的是"界面能打开但没有人物"，而设置里那个"缺依赖"角标很容易被忽略。
        // 更麻烦的是**加载顺序失去保证**：依赖可能排在它后面才加载。
        // 所以判定同时看"装没装"与"启用没启用"。"装了但没启用"等于不可用：
        //     [Mod] 加载完成：elaina-avatar=disabled galgame=ready pet=ready
        // 这行日志就是漏判的证据 —— 前置被禁用了，两个依赖方却照样 ready，
        // 拿不到立绘而系统认为正常。
        // 清单期算不出的第三种不可用在这里补上：前置**这一轮**加载失败/被拒
        //   （依赖序保证它排在前面、已经处理完）。不看这个的话，依赖方会带着
        //   坏前置以"降级模式"跑起来 —— 界面在了、人物没了，系统却认为正常。
        // 这段在"总开关"判定**之前**：总开关关着时，带前置的已启用插件要
        //   报 blocked（原因指向总开关），不带前置的直接 disabled —— 两种都要
        //   说得清"是谁拦的"。
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
            // 不可用时把它之前的注册项收起来：一个"被拒绝加载"的插件
            // 不该继续占着界面入口或往提示词里加东西
            deactivateContributions(manifest.id);
            // 每条原因一句话，人（和 AI）都能读懂该做什么
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
            // ① 样式（可选）
            //    路径由 resolveModAsset 统一校验并拼成 URL（外链 / 越界一律拒绝）。
            //    清单是**插件作者写的**，不是可信输入：`//evil.example/x.css`
            //    这种协议相对地址会让宿主自己去拉第三方样式，等于把整个界面的
            //    外观交给那个站点，所以在这里就挡掉，并让该插件加载失败。
            //    走 injectStyleLink 而不是直接建 <link>：清单声明的样式也必须
            //      纳入可撤销作用域，否则插件停用后它的 CSS 还在生效（既有 bug）。
            for (const css of (Array.isArray(manifest.styles) ? manifest.styles : [])) {
                const href = resolveModAsset(manifest, css, 'styles');
                if (!href) throw new Error('manifest.styles 里有不合法的路径（必须是本插件目录内的相对路径）：' + css);
                injectStyleLink(manifest, href);
            }

            // ② 入口脚本
            // 注入前记下"当前在加载哪个目录"：插件脚本执行时会调
            //   register(name, …)，系统据此知道**这个注册名来自哪个目录**。
            //   这是"路径由插件系统查"的关键一环 —— 见 getRegByDir() 的说明。
            // 多脚本：manifest.scripts 列出的文件**先**注入，entry **最后**注入。
            //   为什么 entry 放最后：
            //   一个插件拆成"实现主体 / 设置面板 / 注册装配"几个文件时，
            //   装配那个文件（entry）要**调用**其它文件定义的东西 ——
            //   所以它必须在最后执行。反过来（entry 先）会让装配时
            //   Live2D 服务还是空，表现为"插件是 ready、
            //   但界面什么都没出现"，而控制台一声不响。
            //   顺序是**声明顺序**，且全部注入完成后才调 factory。
            const entrySrc = manifest.entry || 'index.js';
            const extra = Array.isArray(manifest.scripts) ? manifest.scripts : [];
            const deps = extra.filter((s) => typeof s === 'string' && s && s !== entrySrc);
            const allScripts = [...deps, entrySrc];
            setLoadingDir(manifest.dir || manifest.id);
            try {
                for (const one of allScripts) {
                    // 脚本路径同样来自清单：拒绝外链与 ../ 越界。否则一份
                    //   manifest 就能把任意站点的 JS 注入宿主页面并拿到 host API。
                    const src = resolveModAsset(manifest, one, 'scripts');
                    if (!src) throw new Error('脚本路径不合法（必须是本插件目录内的相对路径）：' + one);
                    await injectScript(src);
                }
            } finally {
                setLoadingDir(null);
            }

            // ③ 初始化：找这个插件注册的 factory。
            // 先按 manifest.id 找（常规情况），找不到就按**本目录注册了什么**找。
            //   为什么需要第二步：用户改了目录名、而 manifest 又没写 id 时，
            //   manifest.id 会等于目录名（如 pet-renamed），而脚本里注册的
            //   仍是 'pet' —— 只按 manifest.id 查会**永远查不到**，
            //   插件表现为"已加载但从不初始化"（界面毫无反应）。
            //   按目录反查就能把这条链接上，目录怎么改都不影响。
            let factory = getPendingRegistrations().get(manifest.id);
            let regName = manifest.id;
            // 登记记录带着它的来源目录：注册名与目录对不上时**不能执行** ——
            //   那是"另一个插件替我登记了工厂"的唯一可见信号。
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
                // 生命周期信号：插件卸载/删除时 abort，插件据此停掉轮询、下载、
                //   定时器这类长任务。临时停用**不**触发（同一个 api 还要能继续用）。
                const lifecycle = lifecycleFor(manifest.id);
                // 工厂是**第三方代码的入口**：它既可能同步抛错，也可能返回一个
                //   永不 resolve 的 Promise。后者不加超时的话，这个插件会永远停在
                //   pending，整轮加载后续的插件也一起等着。
                entry.api = await withTimeout(
                    Promise.resolve().then(() => factory(createHostApi(manifest, regName, lifecycle))),
                    MOD_INIT_TIMEOUT_MS,
                    '初始化超时（' + Math.round(MOD_INIT_TIMEOUT_MS / 1000)
                        + ' 秒没有返回结果，插件可能卡在某个 await 上）');
            } else if (manifest.autoInit !== false) {
                // 没有 register 的插件：脚本加载成功即算可用（有些 mod 自带启动逻辑）
                entry.api = null;
            }
            entry.state = 'ready';
        } catch (err) {
            entry.state = 'error';
            entry.error = String((err && err.message) || err);
            // 加载失败的插件**直接停用**，并把它已经注册的东西收回去。
            // 为什么不能只是标个 error 留在那儿：一个半初始化的插件可能已经
            //   注册了插槽、注入了样式、挂上了事件订阅（工厂跑到一半抛错），
            //   这些"半成品"留在界面上会变成点了没反应的按钮 / 解释不了的
            //   样式错乱。既然它坏了，就当它没启用 —— 这也是用户看到的语义：
            //   开关关上，卡片上写着为什么。
            // 停用状态**写盘**（不是只改内存），否则刷新后又会试着加载一遍、
            //   再失败一次，形成"每次启动都报一次错"的噪音。
            autoDisableBroken(manifest.id, entry);
            console.error('[Mod:' + manifest.id + '] 加载失败（已自动停用，不影响其他插件）', err);
        }
        return entry;
    }

    /**
     * 把加载失败的插件停用，并收回它已经注册的东西。
     *
     * 只做三件事，不碰别的插件：写停用状态、收回注册项、把原因**存起来**。
     * 设置界面据此把开关显示成「关」并显示原因 —— 用户想再试一次时手动打开
     * 即可（打开会重新走一遍加载流程）。
     *
     * 失败原因必须**落盘**，不能只放在内存的 entry 上：
     *   下一次刷新是新会话，getRegistry() 是空的 —— 那时只能从存储里知道
     *   "这个插件上次是被系统停用的，原因是 X"。只记在内存的话，刷新一次
     *   就退化成普通的「未启用」，用户再也看不到为什么坏了。
     */

        return { loadOne };
    };
})();
