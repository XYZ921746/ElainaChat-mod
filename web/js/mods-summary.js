/* ============================================================================
 * 插件加载结果摘要（从 mods.js 拆出）
 *
 * STATE_LABEL 与 logLoadSummary：只负责把 loadAll 的结果打印成可读摘要。
 * ========================================================================== */
'use strict';

    const STATE_LABEL = {
        ready: '已加载',
        disabled: '已关闭（未启用）',
        blocked: '已拒绝加载（前置插件不可用）',
        error: '加载失败',
        pending: '加载中',
    };

    /**
     * 打印加载结果汇总。
     *
     * 为什么不直接打 `elaina-avatar=disabled galgame=ready pet=ready`：
     *   那是**机器视角的键值对**：不了解本项目的 AI（或用户本人）看到这行，
     *   既不知道 `disabled` 是好是坏，也看不出"前置没启用、依赖它的却起来了"
     *   这个关键矛盾。
     *
     *   日志是给**排查问题的人（或 AI）**看的，不是给程序看的。所以：
     *     · 先自报家门（哪个模块在说话、它负责什么）
     *     · 先给结论（几个可用、几个未启用、几个有问题）
     *     · 每个有问题的插件：名字 + 中文状态 + 具体原因 + **下一步该做什么**
     *     · 全部正常时**明确说一句**（"什么都没有"与"一切正常"视觉上无法区分）
     *
     * 格式走 window.ElainaDiag（与 server/diagnostics.mjs 同一套），
     * 这样浏览器日志与服务端日志看起来是一回事，对照着读不会错位。
     * 没有该模块时（老页面缓存）回落到等价的手写输出，不让日志消失。
     */
    function logLoadSummary(results) {
        const total = results.length;
        const ready = results.filter((e) => e.state === 'ready');
        const disabled = results.filter((e) => e.state === 'disabled');
        const broken = results.filter((e) => e.state !== 'ready' && e.state !== 'disabled');

        // 插件的中文名（显示名优先，id 附在后面备查）
        const nm = (e) => {
            const name = e.manifest.name || e.manifest.id;
            return name === e.manifest.id ? name : name + '（' + e.manifest.id + '）';
        };

        const D = window.ElainaDiag;
        if (!D) {
            console.log('[Mod] 插件加载完成：共 ' + total + ' 个，可用 ' + ready.length + ' 个'
                + (disabled.length ? '，未启用 ' + disabled.length + ' 个' : '')
                + (broken.length ? '，有问题 ' + broken.length + ' 个' : '') + '。');
            if (ready.length) console.log('[Mod]   ✔ 可用：' + ready.map(nm).join('、'));
            if (disabled.length) {
                console.log('[Mod]   ○ 未启用（这是正常的，插件默认关闭）：' + disabled.map(nm).join('、')
                    + '\n        如需使用，到「设置 → 插件」打开对应开关。');
            }
            for (const e of broken) {
                console.error('[Mod]   ✘ ' + nm(e) + '：' + (STATE_LABEL[e.state] || e.state));
                if (e.error) console.error('[Mod]     ' + e.error);
            }
            if (!broken.length && !disabled.length) console.log('[Mod]   全部正常。');
            return;
        }

        console.log('[Mod] ' + D.checklist([{
            state: broken.length ? 'bad' : 'ok',
            label: '插件加载完成：共 ' + total + ' 个，可用 ' + ready.length + ' 个'
                + (disabled.length ? '，未启用 ' + disabled.length + ' 个' : '')
                + (broken.length ? '，有问题 ' + broken.length + ' 个' : ''),
            hint: total ? '插件由 mods/ 下的扩展包提供，可在「设置 → 插件」里开关。' : undefined,
        }], '插件系统'));

        if (ready.length) {
            console.log('[Mod] ' + D.checklist([
                { state: 'ok', label: '正常工作：' + ready.map(nm).join('、') },
            ]));
        }

        // 未启用的单独成段：默认关闭是设计如此，不该和故障混在一起报警 ——
        //   否则用户会对警告脱敏，真正的问题反而被忽略。
        if (disabled.length) {
            console.log('[Mod] ' + D.checklist([
                {
                    state: 'note',
                    label: '未启用（这是正常的，插件默认关闭）：' + disabled.map(nm).join('、'),
                    hint: '如需使用，到「设置 → 插件」打开对应开关，然后刷新页面。',
                },
            ]));
        }

        for (const e of broken) {
            const label = STATE_LABEL[e.state] || e.state;
            const dep = (e.missingDeps || []).map((d) => d.id + '（' + d.reason + '）').join('、');
            console.error('[Mod] ' + D.problem({
                what: '插件「' + nm(e) + '」' + label,
                where: 'mods/' + (e.manifest.dir || e.manifest.id) + '/',
                why: e.error || (dep ? '它依赖的前置插件不可用：' + dep : '加载过程中出错'),
                how: e.state === 'blocked'
                    ? '先修好它依赖的前置插件（见上面的原因），再刷新页面。'
                    : '把这条日志（含上面的原因）整份复制出来，就是排查依据。',
            }));
        }
        if (broken.length) {
            console.error('[Mod] ' + D.summary(
                broken.map((e) => nm(e) + '：' + (STATE_LABEL[e.state] || e.state)),
                { after: '以上插件不会生效。按上面每条给出的方法处理后，刷新页面重试。' },
            ));
        } else {
            console.log('[Mod] ' + D.summary([], {
                notes: disabled.length
                    ? ['上面列出的「未启用」是正常状态，需要时到「设置 → 插件」开启即可。']
                    : ['所有插件都已正常工作。'],
            }));
        }
    }

    /** 按注册名 / 清单 id / 目录名中的任意一个查注册条目（三键都可能被 after 引用） */

