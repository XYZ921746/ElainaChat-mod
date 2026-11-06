/* 插件系统对外接口 window.ElainaMods：注册 / 查找 / 列表 / 开关 / 插槽 / 事件 / 设置窗；状态由调用方注入。 */
(function () {
    'use strict';

    window.ElainaModsApi = function (deps) {
        const {
            migrateLegacyModStorage, findService, findByKey, loadAll,
            isModEnabled, setEnabled, dependentsOf, forgetMod,
            modsGloballyEnabled, setModsGloballyEnabled,
            defineSlot, renderItemSlot, collectPromptHints, emit,
            registerSettingsOpener, unregisterSettingsOpener,
            closeModSettings, openModSettings, hasModSettings, settingsOpeners,
            bus, slotImpls, disposeContributions, guardMod, guardModAsync,
            MOD_FAULT_LIMIT,
        } = deps;
        const getRegistry = deps.getRegistry;
        const getLoadingDir = deps.getLoadingDir;
        const getPendingRegistrations = deps.getPendingRegistrations;
        const getRegByDir = deps.getRegByDir;
        const getDirByReg = deps.getDirByReg;
        const getModRoot = deps.getModRoot;
        const isAppReady = deps.isAppReady;
        const markAppReadyState = deps.markAppReadyState;

    return {
        /** 把插件在 localStorage 里的偏好搬进 host.storage（启动时自动调用；测试/诊断可手动调） */
        migrateLegacyStorage: migrateLegacyModStorage,
        /** 按名字取插件服务（只返回已启用/已就绪的插件注册的服务） */
        service: findService,
        /* 插件脚本用它注册初始化函数：ElainaMods.register('galgame', (host) => ({...}))。
         * 注册名是插件的**权威身份**（依赖匹配、资源查找以它为准），并记下脚本所在目录以对上"目录名/id/注册名"三者。 */
        register(id, factory) {
            const name = String(id || '').trim();
            // 只允许在**本插件的脚本注入期间**登记：脚本执行完之后再调，等于让任意代码给别的插件塞一个工厂
            if (!getLoadingDir()) {
                console.error('[Mod] register() 只能在插件脚本加载期间调用，本次被忽略：' + name);
                return;
            }
            if (!name || typeof factory !== 'function') {
                console.error('[Mod:' + getLoadingDir() + '] register(id, factory) 需要名字与函数，本次被忽略');
                return;
            }
            const claim = getPendingRegistrations().get(name);
            // 一个注册名只能属于一个目录：否则 A 能用 B 的名字登记，B 加载时执行 A 的代码（并拿到 B 的 host API）
            if (claim && claim.dir && claim.dir !== getLoadingDir()) {
                console.error('[Mod:' + getLoadingDir() + '] 注册名「' + name + '」已属于目录 '
                    + claim.dir + '，本次注册被拒绝（一个插件不能替另一个插件登记）');
                return;
            }
            getPendingRegistrations().set(name, { factory, dir: getLoadingDir() });
            if (getLoadingDir()) {
                getRegByDir().set(getLoadingDir(), name);
                getDirByReg().set(name, getLoadingDir());
            }
        },
        /* 按注册名 / 清单 id / 目录名中的**任意一个**查插件（插件互查不靠拼字符串，用户改了目录名也查得到）。 */
        find(key) {
            // 三键查找收敛在 findByKey：setEnabled 拉前置也按同一套键找，两处各写一份必然漂移
            const entry = findByKey(key);
            if (!entry) return null;
            return {
                id: entry.manifest.id,
                dir: entry.manifest.dir || entry.manifest.id,
                regName: entry.regName || entry.manifest.id,
                state: entry.state,
                entry,
            };
        },
        /** 取某个插件资源的 URL（按注册名/清单 id/目录名均可查，自动编码） */
        assetUrl(key, rel) {
            const found = window.ElainaMods.find(key);
            const dir = found ? found.dir : String(key || '');
            const r = String(rel || '').replace(/^\/+/, '');
            const enc = dir.split('/').map(encodeURIComponent).join('/');
            return getModRoot() + enc + '/' + r;
        },
        loadAll,
        /** 列出已发现的插件及其状态（供设置界面渲染） */
        list() {
            return [...getRegistry().values()].map((e) => ({
                id: e.manifest.id,
                // dir / regName 都暴露出去：设置界面与宿主都要用真实目录，而不是拿 id 去猜（三者可能不一致）
                dir: e.manifest.dir || e.manifest.id,
                regName: e.regName || e.manifest.id,
                name: e.manifest.name || e.manifest.id,
                version: e.manifest.version || '',
                description: e.manifest.description || '',
                state: e.state,
                error: e.error,
                enabled: isModEnabled(e.manifest.id, e.manifest),
                // hidden：不提供界面的公共依赖类插件；设置界面加一句用途说明但**仍然给开关**，
                // 否则它一旦被禁用就无法从界面恢复，依赖它的插件连带失效
                hidden: e.manifest.hidden === true,
                // 前置声明（`after`）：设置页据此把"被别人依赖"的插件归到前置扩展区，
                //   有些前置自带管理界面（如 live2d-models）不会被标成 hidden，但同样是别人跑起来的前提
                after: Array.isArray(e.manifest.after) ? e.manifest.after.slice() : [],
                // 不可用的前置（未安装 / 未启用 / 级联不可用）：这类插件会被拒绝加载，设置界面据此显示原因与下一步
                missingDeps: e.missingDeps || [],
                // 是不是「加载失败后自动停用」造成的关闭：设置界面据此把卡片文案写成"加载失败已自动停用"，
                // 并在卡片上给出原因，否则用户只看到开关是关的、以为是自己没开
                autoDisabled: e.autoDisabled === true,
                // 运行期出错次数（守护边界累计）：设置页拿它区分「一装就坏」与「跑着跑着开始坏」，
                // 后者的下一步是修插件，而不是"再点一次开关试试"
                faultCount: e.faultCount || 0,
            }));
        },
        setEnabled,
        /* 谁正在用这个插件（已启用且加载成功的依赖方）：非空就别停用/卸载，拦下并告诉用户先关谁。 */
        dependentsOf,
        /* 重新扫描并加载插件（幂等）。市场装完必须调它：注册表只在 loadAll 里建立，
         * 不重扫则新插件不在注册表、开关点了也不生效；之前因缺前置被拒的插件也会在这一轮重新评估依赖。 */
        reload: loadAll,
        /** 删插件时调用：清掉启用状态与已加载记录（避免重装后被自动启用） */
        forget: forgetMod,
        isEnabled: (id) => {
            const e = getRegistry().get(id);
            return e ? isModEnabled(id, e.manifest) : false;
        },
        /** 全局开关：关掉后所有插件都不加载（需要刷新页面生效） */
        isGloballyEnabled: modsGloballyEnabled,
        setGloballyEnabled(on) { setModsGloballyEnabled(on); },

        /* 挖一个插槽出来，之后 mod 就能往这个名字里注册；插槽的 spec 约定属于"谁挖的谁解释"，
         * mod 系统只管归属、去重与生命周期。宿主脚本顶层调用，一定早于任何 mod 注册。返回撤掉该插槽的函数。 */
        defineSlot,

        /* 宿主渲染「每一项都要装饰」的位置时用它（每项级插槽）：把每项的容器交给注册过该插槽的 mod。 */
        renderItemSlot,
        /** 宿主用它取全部插件的 system 提示词片段 */
        collectPromptHints,
        /** 宿主用它广播事件给插件（如"AI 回复完成"、语音音量） */
        emit,

        /** 登记/注销某插件的设置窗打开函数（settings.modal 插槽实现用） */
        registerSettingsOpener,
        unregisterSettingsOpener,
        closeModSettings,
        /** 按插件 id 打开设置窗；没有设置窗返回 false */
        openModSettings,
        /** 该插件有没有设置窗（插件卡片据此决定画不画齿轮） */
        hasModSettings,
        /** 已登记设置窗的插件 id 清单（诊断用） */
        settingsOpeners: () => [...settingsOpeners.keys()],
        /* 宿主在 init() 末尾调一次：广播 app-ready 并记下"已发生"。
         * 之后才注册的 mod 订阅时会被立刻补调（见 host.on），慢加载也不会漏掉这个信号。 */
        markAppReady() {
            if (isAppReady()) return;
            markAppReadyState();
            emit('app-ready', {});
        },
        on(event, handler) {
            if (!bus.has(event)) bus.set(event, new Set());
            bus.get(event).add(handler);
            return () => bus.get(event).delete(handler);
        },
        /* 某个事件上有没有订阅者：宿主用它决定"值不值得算"（例如没人听时音量分析不必白跑 rAF 循环）。 */
        hasListeners(event) {
            const set = bus.get(event);
            if (!set) return false;
            // 停用的 mod 的订阅会被摘掉，所以这里看到的就是"真正在听的人"
            for (const h of set) { if (typeof h === 'function') return true; }
            return false;
        },

        /** 宿主插槽的名字清单（诊断与 mod 自查用） */
        slotNames: () => [...slotImpls.keys()],
        _disposeContributions: disposeContributions,
        _registry: getRegistry(),

        /* 运行期错误的统一入口（宿主其它模块也可借它隔离回调）：只记带插件名的日志，
         * 并按错误预算决定是否停用该插件（连续出错才停，偶发一次不处罚）。 */
        guard: guardMod,
        /** 异步版 guard：同步异常与 Promise 拒绝都拦在这条线内 */
        guardAsync: guardModAsync,
        /** 某个插件当前的错误次数（诊断用；超过 MOD_FAULT_LIMIT 会被停用） */
        faultCount: (id) => {
            const e = getRegistry().get(id);
            return e ? (e.faultCount || 0) : 0;
        },
        faultLimit: MOD_FAULT_LIMIT,
    };

    };
})();
