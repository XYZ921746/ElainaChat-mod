/* ============================================================================
 * AI 标签协议：剥离 + 分发（宿主自有，不依赖 Live2D）
 *
 * 这套东西不能长在可选的 Live2D mod 里：stripTags / drive / handleAgentOperation 原先都住在
 *   `web/live2d-video.js`，而 handleAgentOperation 是**全部 [操作:…] 标签的唯一分发器**
 *   （文件 / 命令 / 手机 / 记忆）；宿主调用点带着 `if (window.Live2DCall)`。于是 Live2D 一旦不在
 *   （被当成可选 mod 卸掉、或那个文件加载失败），后果不是少了视频通话：
 *     ① 整个 Agent 系统失效 —— 文件/命令/手机标签全部不会被执行；
 *     ② 标签漏进可见文本 —— stripTags 也没了，用户直接看到 `[表情:开心]`。
 *   拆 Live2D 的阻塞点不是界面耦合，是**能力寄生**。
 *
 * 分工：本文件（宿主，永远加载）负责标签剥离 + 操作分发；live2d-video.js（可选）
 *   只负责表现（表情/动作/情绪/位置/大小/背景 + 水印/静音），经 registerOperationHandler
 *   往分发链里**追加**，而不是拥有整条链。
 *
 * 两个入口：strip(text) 剥标签得正文；drive(text) 先分发操作再把表现交给 presenters。
 * ========================================================================== */
(function () {
    'use strict';

    if (window.ElainaTags) return;   // 幂等：重复引入不覆盖

    /** 全部标签名的权威清单。剥离用一份，避免各处正则走样。 */
    const TAG_NAMES = ['表情', '动作', '情绪', '位置', '大小', '背景', '操作', '任务'];

    /**
     * 剥掉标签，返回给用户看的正文。
     * 剥离只留这一份：分散在多处会出现"某个标签在 A 处被剥、在 B 处漏出来"。
     */
    function strip(text) {
        let out = String(text == null ? '' : text);
        for (const name of TAG_NAMES) {
            out = out.replace(new RegExp('\\[' + name + '[:：][^\\]]*\\]', 'g'), '');
        }
        // 未闭合的标签（模型被输出长度截断、或忘了收尾的 `]`）上面那条闭合判据匹配不上，
        //   于是整块标签连同里面的文件内容、模型编造的"操作结果"会原样显示并存进聊天记录。
        // 容错与流式预览 sanitizeStreamingPreviewText 同判据：**从开标签起截到文末** ——
        //   两处不一致就会出现"打字时藏得住、提交后整块漏出来"。
        // 只认 TAG_NAMES 里的标签名，避免误删正文里普通的 `[`。
        out = out.replace(new RegExp('\\[(?:' + TAG_NAMES.join('|') + ')[:：][\\s\\S]*$'), '');
        return out.trim();
    }

    /**
     * Live2D 等"表现层"注册进来的操作处理器。
     *
     * 每个处理器 = { test: (v) => boolean, run: (v) => void }。
     * 加这一层是为了让 Live2D 的 水印/静音 能挂上，
     * 同时**宿主自己的操作不经过它** —— 否则又变成寄生。
     */
    const extraHandlers = [];

    /**
     * 注册一个额外的操作处理器（供表现层扩展）。
     *
     * @param {(v:string)=>boolean} test 判据：这个操作名归我管吗
     * @param {(v:string)=>void} run 执行
     * @returns {() => void} 取消注册
     */
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

    /**
     * ASCII 工具名 → 中文操作名。
     *
     * 模型混用两条通道是**常态**而不是例外：清单里有 `save_file` / `run_command`，它很容易
     *   写成 `[操作:save_file D:\桌面2\a.txt hi]`。没人认领时只打一行 console.warn 就丢掉：
     *   动作没执行，模型却以为发出去了，下一轮顺着编造"我做完了" —— 用户桌面上一无所有。
     *   所以工具名必须与标签名认成同一个操作（映射只在 agent-ops.js 维护，这里按 tool 名换算）。
     *
     * 只做"名字换中文动词"：参数处理仍交给中文分支，两条写法走**同一条**执行链。
     */
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

    /**
     * 分发**一个**操作标签的内容。
     *
     * 分支顺序是有讲究的：`^电脑命令` 必须排在文件操作**之前** —— `[操作:电脑命令 git status]`
     *   的命令正文里可能含「查看文件」这类词，而文件分支判据很宽泛，排在前面会把命令正文吃掉。
     *   `^(手机|设备)` 锚定开头，与命令分支不冲突。
     */
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
        // 浏览器：锚定开头，与「电脑命令」不冲突 ——
        //   [操作:电脑命令 start chrome] 是命令，不是浏览器操作，两者不能互相吃掉。
        if (/^(浏览器|网页|打开网址)/.test(name)) return void callAction('agentBrowserOperation', name);
        // 搜索：必须排在文件分支之前 —— 「搜索」两个字不会误吃别的分支，
        //   但反过来「查看文件 搜索记录.txt」会被这里吃掉，所以锚定开头。
        if (/^(搜索|搜一下|联网搜索|查一下)/.test(name)) return void callAction('agentWebSearchOperation', name);
        if (/^(手机|设备)/.test(name)) return void callAction('agentPhoneOperation', name);
        if (/^(电脑命令|执行命令|运行命令|电脑执行)/.test(name)) return void callAction('agentCommandOperation', name);
        // 删除必须排在下面的文件分支之前：文件分支的词眼很宽（「查看文件」等），顺序反了会把删除正文吃掉一半。
        if (/^(?:删除|删掉|移除)(?:文件|目录|文件夹)?/.test(name)) return void callAction('agentFileOperation', name);
        if (/列出文件|列出目录|查看文件夹|查看文件|读取文件|读文件|保存文件|写入文件|写文件|创建文件|新建文件/.test(name)) {
            return void callAction('agentFileOperation', name);
        }
        // 模型把工具名写进了标签（见 TOOL_NAME_TO_TAG）：换算成中文操作名**重新过一遍**本函数，
        //   保证与中文写法走同一条分支，而不是在这里另抄一套分发。
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

    /**
     * 统一入口：解析一条 AI 回复里的全部标签。
     *
     *   ① 操作标签 → 分发（宿主自己的 + 表现层注册的）
     *   ② 表现标签（表情/动作/情绪/位置/大小/背景）→ 交给表现层
     *
     * 表现层是可选的：Live2D 不在时第 ② 步什么也不做，
     * 但第 ① 步照常执行 —— 这正是解耦的目的。
     */
    function drive(text) {
        const t = String(text == null ? '' : text);
        if (!t) return;
        dispatchOperations(t);
        try {
            const presenter = window.Live2DCall;
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
