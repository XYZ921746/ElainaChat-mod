/* 宿主能力白名单与 API 分组：HOST_CAPABILITIES / HOST_API_GROUPS / declaredApiGroups（host() 由 mods.js 在调用时提供）。 */
'use strict';

    const HOST_CAPABILITIES = {
        sendUserMessage: () => typeof host().sendUserMessage === 'function',
        refreshAutoConversationTitle: () => typeof host().refreshAutoConversationTitle === 'function',
        /** 能渲染 Markdown / LaTeX */
        renderText: () => typeof host().renderMessageText === 'function',
        dialogs: () => typeof host().showCustomAlert === 'function',
        theme: () => Boolean(host().theme),
        achievements: () => Boolean(host().achievements),
        /** 有桌面壳桥（WebView2 宿主）：开原生透明置顶窗的能力，纯浏览器为 false */
        desktopWindow: () => Boolean(host().desktopWindow),
        /** 能打开宿主设置面板 */
        appUi: () => Boolean(host().appUi),
        conversations: () => Boolean(host().state),
        /** 有语音合成能力（TTS 是否已配 Key 另说） */
        speech: () => Boolean(host().speech),
        /** 有语音输入能力（ASR 是否已配 Key 另说） */
        dictation: () => Boolean(host().dictation),
        /** 有本机服务端（openFolder 之类的能力才可能成功） */
        localServer: () => {
            try {
                return typeof location !== 'undefined'
                    && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(String(location.hostname || ''));
            } catch (e) { return false; }
        },
    };

    /* host API 成员分组：每组要插件在 manifest 里**声明**才拿得到，不声明的组对应成员根本不在 `host` 上（undefined 而非空函数）。
     * `core` 永远给（插件能干活的最小集合）；分组而不是全给：一次给 20 多个成员，插件随手就会用上"很重的"那几个。 */
    const HOST_API_GROUPS = {
        core: [],
        theme: ['theme'],
        achievements: ['unlock'],
        dragSort: ['dragSort'],
        openFolder: ['openFolder'],
        desktopWindow: ['desktopWindow'],
        appUi: ['openAppSettings'],
    };

    /* 读某个插件声明的 host API 能力组：声明位置是 manifest 的 `capabilities`（数组，与 server.capabilities 同名但各管一半），
     * 缺省 = 只给 core；未知组名**明确报出来**并忽略 —— 静默忽略会让插件作者以为申请到了，运行到那步才发现是 undefined。 */
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


