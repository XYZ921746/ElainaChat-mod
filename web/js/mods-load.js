/* 插件发现与批量加载：discover / loadAll —— 清单读取、依赖排序与逐插件加载的编排；注入与初始化在 mods-load-one.js。 */
(function () {
    'use strict';

    window.ElainaModsLoad = function (deps) {
        const awaitNativeModRoot = deps.awaitNativeModRoot;
        const getModRoot = deps.getModRoot;
        const sortByDependency = deps.sortByDependency;
        const pullUpPrerequisites = deps.pullUpPrerequisites;
        const findMissingDeps = deps.findMissingDeps;
        const loadOne = deps.loadOne;
        const logLoadSummary = deps.logLoadSummary;
        const getRegistry = deps.getRegistry;
        const autoDisableBroken = deps.autoDisableBroken;
    /** 发现所有插件：浏览器里没法列目录，所以约定 `mods/index.json` 是插件清单数组（构建/手工维护）。
     *  安卓 APK 上没有静态服务，原生模式改走字面量 `/api/plugins`（core.js 的拦截器精确匹配这个串）。 */
    async function discover() {
        try {
            const res = await fetch(window.__nativeModBase
                ? '/api/plugins'
                : (getModRoot() + 'index.json'), { cache: 'no-store' });
            if (!res.ok) return [];
            const data = await res.json();
            // 兼容两种写法：数组，或 { plugins: [...] }（后者便于写注释字段）
            const list = Array.isArray(data) ? data : (data && Array.isArray(data.plugins) ? data.plugins : []);
            return list.filter((m) => m && typeof m.id === 'string' && m.id);
        } catch (e) {
            // 没有插件目录是**正常情况**（用户全删了），不该报错打扰
            return [];
        }
    }

    async function loadAll() {
        // 原生模式：先等插件根就绪（幂等，本函数入口不止 boot 一处，多设备同步也会再调）。
        //   不等的话首次加载会用桌面根 /mods/ 去拼 URL，APK 上全部 404。
        await awaitNativeModRoot();
        // 先打一条总览日志（console.log，会被前端日志转发带到启动窗口）：
        // "没有 mod 日志"既可能是成功、也可能是插件系统压根没跑 / 清单读不到，两者在启动窗口里长得一样。
        const manifests = await discover();
        console.log('[Mod] 【插件系统】（提供界面扩展与功能增强）开始加载 —— '
            + '清单里发现 ' + manifests.length + ' 个插件'
            + (manifests.length ? '：' + manifests.map((m) => m.name || m.id).join('、') : ''));
        if (!manifests.length) {
            // 清单为空 = 没装任何插件，或 index.json 取不到。后者要能看出来。
            const D0 = window.ElainaDiag;
            console.warn('[Mod] ' + (D0 ? D0.problem({
                what: '没有发现任何插件',
                where: '/mods/index.json',
                why: '两种可能：① 你还没装插件（这是正常的，程序本体的文字聊天不受影响）；'
                    + '② 清单文件读不到（服务端没起来或返回了错误）。',
                how: '想加功能就到「设置 → 插件」上传扩展包；'
                    + '若你确信装过插件，请确认服务端窗口还开着，然后刷新页面。',
            }) : '插件清单为空 —— 没安装任何插件，或 /mods/index.json 读取失败'));
            return [];
        }

        // 已启用的插件先把前置带上（为什么在这里做：见 pullUpPrerequisites 的说明），
        //   再算"还缺什么" —— 拉得起来的不算缺。
        pullUpPrerequisites(manifests);

        // 先查不可用的前置插件 —— 这类插件会被**拒绝加载**（不是警告后照跑）。
        //   判定同时看"装没装"与"启用没启用"，并认清单 id / 目录名 / 注册名三种键。
        const missing = findMissingDeps(manifests);
        for (const [id, lack] of missing) {
            const D1 = window.ElainaDiag;
            const detail = lack.map((d) => '「' + d.id + '」' + d.reason).join('、');
            console.error('[Mod] ' + (D1 ? D1.problem({
                what: '插件「' + id + '」的前置插件不可用，它不会被加载',
                where: 'mods/',
                why: '它依赖 ' + detail,
                how: lack.some((d) => d.reason === '未启用')
                    ? '到「设置 → 插件」把那个前置插件的开关打开，然后刷新页面。'
                    : '先安装缺失的前置插件（见 Releases 的扩展包），再刷新页面。',
            }) : '插件「' + id + '」无法加载 —— 它依赖的前置插件不可用：' + detail));
        }

        let ordered;
        try {
            ordered = sortByDependency(manifests);
        } catch (err) {
            // 依赖成环：报错但不要全崩 —— 退化成"按声明顺序加载"
            console.error('[Mod] ' + err.message + '，退化为按声明顺序加载');
            ordered = manifests;
        }

        const results = [];
        // 顺序加载（不是并发）：插件之间可能有依赖，且顺序加载让失败定位更容易
        for (const m of ordered) {
            const lack = missing.get(m.id) || [];
            // 逐插件兜底：一个插件出事绝不能带崩整轮加载 —— loadOne 内部只包住了插件自己的代码，
            // 它前半段（读 getRegistry()、处理依赖结论）不在那个 try 里，这里再兜一层。
            let entry;
            try {
                entry = await loadOne(m, lack);
            } catch (e) {
                const prev = getRegistry().get(m.id);
                entry = prev || { manifest: m, state: 'error', error: null, api: null };
                entry.state = 'error';
                entry.error = '加载过程中出现未预期的错误：' + String((e && e.message) || e);
                getRegistry().set(m.id, entry);
                // 与 loadOne 的失败路径一致：坏了就停用，别留在"半启用"状态
                autoDisableBroken(m.id, entry);
                console.error('[Mod:' + m.id + '] 加载时抛出异常（已隔离并停用，其余插件继续加载）', e);
            }
            if (!entry) entry = { manifest: m, state: 'error', error: '加载流程没有返回结果', api: null };
            // 不可用的前置也记到条目上，供设置界面显示（loadOne 已在 error 里写了原因）
            if (lack.length) entry.missingDeps = lack;
            results.push(entry);
        }

        logLoadSummary(results);
        return results;
    }

        return { discover, loadAll };
    };
})();
