/* ============================================================================
 * 宿主能力白名单与 API 分组（从 mods.js 拆出）
 *
 * HOST_CAPABILITIES / HOST_API_GROUPS / declaredApiGroups。
 * 纯清单与解析；host() 在调用时由 mods.js 提供。
 * ========================================================================== */
'use strict';

    const HOST_CAPABILITIES = {
        /** 能发用户消息（走主输入框同一条链路） */
        sendUserMessage: () => typeof host().sendUserMessage === 'function',
        /** 能按消息重算会话标题（自动取名） */
        refreshAutoConversationTitle: () => typeof host().refreshAutoConversationTitle === 'function',
        /** 能渲染 Markdown / LaTeX */
        renderText: () => typeof host().renderMessageText === 'function',
        /** 有宿主弹窗（提示 / 确认） */
        dialogs: () => typeof host().showCustomAlert === 'function',
        /** 有主题系统（host.theme 可用） */
        theme: () => Boolean(host().theme),
        /** 有成就系统（host.unlock 可用） */
        achievements: () => Boolean(host().achievements),
        /** 有会话数据（host.getConversation / getMessages 可用） */
        conversations: () => Boolean(host().state),
        /** 有语音合成能力（host.speech 可用 —— TTS 是否已配置另说） */
        speech: () => Boolean(host().speech),
        /** 有语音输入能力（host.dictation 可用 —— ASR 是否已配置另说） */
        dictation: () => Boolean(host().dictation),
        /** 有本机服务端（openFolder 等需要服务端的能力才会成功） */
        localServer: () => {
            try {
                return typeof location !== 'undefined'
                    && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(String(location.hostname || ''));
            } catch (e) { return false; }
        },
    };

    /**
     * host API 的成员分组：每组要插件在 manifest 里**声明**才拿得到。
     *
     * 为什么分组而不是全给：`createHostApi` 曾经一次性给 20 多个成员，插件随手
     *   就能用上"很重的"那几个（注册主题模板、写宿主成就、绑全站拖拽内核）——
     *   而绝大多数插件一辈子用不到它们。给全部等于把这些重能力的维护成本
     *   摊到每个插件身上，也让"这个插件到底要什么"在清单里看不出来。
     *
     * 分组之后：不声明的组，对应成员**根本不在** `host` 上（不是空函数，
     *   是 undefined）—— 误用时立刻 TypeError，离调用点最近，最好查。
     *
     * 兼容：`core` 组永远给（存消息、渲染、弹窗、storage、slot…），
     *   它是插件能干活的最小集合。已有插件不需要改 manifest 就能继续跑；
     *   要额外能力时在 manifest 的 `capabilities` 里加一个字符串即可。
     */
    const HOST_API_GROUPS = {
        /** 永远提供：插件的基本生存能力 */
        core: [],
        /** 主题模板注册（host.theme / use / restore） */
        theme: ['theme'],
        /** 成就上报（host.unlock） */
        achievements: ['unlock'],
        /** 全站拖拽排序内核（host.dragSort） */
        dragSort: ['dragSort'],
        /** 在系统文件管理器里打开插件目录（host.openFolder） */
        openFolder: ['openFolder'],
    };

    /**
     * 读某个插件声明的 host API 能力组。
     *
     * 声明位置是 manifest 的 `capabilities`（数组，与 server.capabilities 同名
     * 但各管一半：这个只管前端 host API）。缺省 = 只给 core。
     * 未知组名**明确报出来**并忽略 —— 静默忽略会让插件作者以为申请到了，
     * 运行到那一步才发现 `host.theme` 是 undefined。
     */
    function declaredApiGroups(manifest, log) {
        const raw = manifest && manifest.capabilities;
        const out = new Set(['core']);
        if (raw === undefined || raw === null) return out;
        if (!Array.isArray(raw)) {
            log('error', 'manifest 的 capabilities 必须是字符串数组（可用：'
                + Object.keys(HOST_API_GROUPS).join('、') + '），本次按「只给 core」处理');
            return out;
        }
        for (const item of raw) {
            const g = String(item || '').trim();
            if (!g) continue;
            if (!Object.prototype.hasOwnProperty.call(HOST_API_GROUPS, g)) {
                log('warn', 'manifest 的 capabilities 里有未知组「' + g + '」（可用：'
                    + Object.keys(HOST_API_GROUPS).join('、') + '），已忽略');
                continue;
            }
            out.add(g);
        }
        return out;
    }


