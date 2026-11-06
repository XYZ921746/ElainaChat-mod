// AI 标签协议：剥离 + 分发（宿主自有，不依赖 Live2D）。分发器若寄生在可选的 Live2D mod 里，该 mod 一卸整个 Agent 系统就失效，且标签漏进可见文本。
// 本文件永远加载；表现层（表情/动作/情绪等）经 registerOperationHandler 往分发链里追加，而不是拥有整条链。两个入口：strip(text) 剥标签得正文；drive(text) 先分发操作再把表现交给 presenters。
(function () {
    'use strict';

    if (window.ElainaTags) return;   // 幂等：重复引入不覆盖

    /** 全部标签名的权威清单。剥离用一份，避免各处正则走样。 */
    const TAG_NAMES = ['表情', '动作', '情绪', '位置', '大小', '背景', '操作', '任务'];

    // 剥掉标签，返回给用户看的正文。剥离只留这一份：分散在多处会出现某个标签在 A 处被剥、在 B 处漏出来。
    function strip(text) {
        let out = String(text == null ? '' : text);
        for (const name of TAG_NAMES) {
            out = out.replace(new RegExp('\\[' + name + '[:：][^\\]]*\\]', 'g'), '');
        }
        // 未闭合的标签（输出被截断 / 忘了收尾 ]）匹配不上上面那条，整块会原样显示并存进聊天记录；与 sanitizeStreamingPreviewText 同判据，从开标签截到文末，只认 TAG_NAMES。
        out = out.replace(new RegExp('\\[(?:' + TAG_NAMES.join('|') + ')[:：][\\s\\S]*$'), '');
        return out.trim();
    }

    // 表现层注册进来的操作处理器，每个 = { test: (v) => boolean, run: (v) => void }；宿主自己的操作不经过它，否则又变成寄生。
    const extraHandlers = [];

    // 注册一个额外的操作处理器（供表现层扩展），返回取消注册的函数。
    function registerOperationHandler(test, run) {
        const entry = { test, run };
        extraHandlers.push(entry);
        return () => {
            const i = extraHandlers.indexOf(entry);
            if (i >= 0) extraHandlers.splice(i, 1);
        };
    }

    /** 安全调用 agentActions 上的某个方法（宿主未就绪时不要炸） */
    function callAction(name, ...args) {
        try {
            const fn = window.agentActions && window.agentActions[name];
            if (typeof fn === 'function') { fn(...args); return true; }
            console.warn('[Tags] 主应用还没有 ' + name + '，本次操作被忽略');
        } catch (e) {
            console.warn('[Tags] 执行 ' + name + ' 失败:', e);
        }
        return false;
    }

    // ASCII 工具名 → 中文操作名：模型常把清单里的 save_file 写成 [操作:save_file …]，没人认领时动作没执行，它却顺着编造"我做完了"；只换名字，参数仍交给中文分支。
    const TOOL_NAME_TO_TAG = {
        list_files: '列出文件',
        read_file: '查看文件',
        save_file: '保存文件',
        delete_file: '删除文件',
        run_command: '电脑命令',
        phone_action: '手机',
        organize_memory: '整理记忆',
        browser_action: '浏览器',
        web_search: '搜索',
    };

    /** 把 `[操作:save_file …]` 换成 `[操作:保存文件 …]`；不是工具名就原样返回 */
    function normalizeToolNameTag(name) {
        const m = String(name || '').match(/^([A-Za-z][A-Za-z0-9_]*)([\s\S]*)$/);
        if (!m) return name;
        const tag = TOOL_NAME_TO_TAG[m[1].toLowerCase()];
        if (!tag) return name;
        return tag + m[2];
    }

    // 分发一个操作标签的内容。分支顺序有讲究：^电脑命令 必须排在文件操作之前（命令正文里可能含「查看文件」这类词，文件分支判据很宽泛）；^(手机|设备) 锚定开头，与命令分支不冲突。
    function handleOperation(v) {
        const name = String(v == null ? '' : v).trim();
        if (!name) return;

        // 先给表现层机会：水印 / 静音 只有它知道怎么执行
        for (const h of extraHandlers) {
            try {
                if (h.test(name)) { h.run(name); return; }
            } catch (e) {
                console.warn('[Tags] 扩展操作处理器出错:', e);
            }
        }

        // 宿主自己的操作：不依赖任何表现层
        if (/打开|开始|进入/.test(name) && /视频通话|通话|live2d/i.test(name)) return void callAction('openVideoCall');
        if (/关闭|结束|挂断/.test(name) && /视频通话|通话|live2d/i.test(name)) return void callAction('closeVideoCall');
        if (/整理记忆|记忆整理/.test(name)) return void callAction('organizeMemory');
        // 浏览器锚定开头，与「电脑命令」不冲突：[操作:电脑命令 start chrome] 是命令，不是浏览器操作。
        if (/^(浏览器|网页|打开网址)/.test(name)) return void callAction('agentBrowserOperation', name);
        // 搜索必须排在文件分支之前并锚定开头，否则「查看文件 搜索记录.txt」会被这里吃掉。
        if (/^(搜索|搜一下|联网搜索|查一下)/.test(name)) return void callAction('agentWebSearchOperation', name);
        if (/^(手机|设备)/.test(name)) return void callAction('agentPhoneOperation', name);
        if (/^(电脑命令|执行命令|运行命令|电脑执行)/.test(name)) return void callAction('agentCommandOperation', name);
        // 删除必须排在下面的文件分支之前：文件分支的词眼很宽（「查看文件」等），顺序反了会把删除正文吃掉一半。
        if (/^(?:删除|删掉|移除)(?:文件|目录|文件夹)?/.test(name)) return void callAction('agentFileOperation', name);
        if (/列出文件|列出目录|查看文件夹|查看文件|读取文件|读文件|保存文件|写入文件|写文件|创建文件|新建文件/.test(name)) {
            return void callAction('agentFileOperation', name);
        }
        // 工具名换算成中文操作名后重新过一遍本函数，保证与中文写法走同一条分支，不另抄一套分发。
        const asTag = normalizeToolNameTag(name);
        if (asTag !== name) return handleOperation(asTag);
        console.warn('[Tags] 未知操作:', name);
    }

    /** 取一条回复里出现的全部 [操作:…] 标签（可能多个） */
    function extractOperations(text) {
        const t = String(text == null ? '' : text);
        const raw = t.match(/\[操作[:：]\s*[^\]]+\]/g) || [];
        return raw
            .map((r) => r.replace(/^\[操作[:：]\s*/, '').replace(/\]$/, '').trim())
            .filter(Boolean);
    }

    /** 只分发操作标签（不做表现驱动） */
    function dispatchOperations(text) {
        for (const op of extractOperations(text)) handleOperation(op);
    }

    // 统一入口：操作标签 → 分发（宿主 + 表现层注册的）；表现标签（表情/动作/情绪/位置/大小/背景）→ 交给表现层。表现层可选：Live2D 不在时第 2 步空转、第 1 步照常，这正是解耦的目的。
    function drive(text) {
        const t = String(text == null ? '' : text);
        if (!t) return;
        dispatchOperations(t);
        try {
            const presenter = live2dService();
            if (presenter && typeof presenter.drivePresentation === 'function') {
                presenter.drivePresentation(t);
            }
        } catch (e) {
            console.warn('[Tags] 表现层驱动失败:', e);
        }
    }

    window.ElainaTags = {
        strip,
        drive,
        dispatchOperations,
        extractOperations,
        registerOperationHandler,
        TAG_NAMES,
    };
})();
