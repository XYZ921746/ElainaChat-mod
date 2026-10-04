/* ============================================================================
 * 插件系统（动态 mod 加载器）
 *
 * 目标：Galgame、桌宠这类**可选功能**不该长在宿主主脚本里。它们要能：
 *   · 像 mod 一样放/删 —— 插件就是一个目录，删掉目录即卸载
 *   · 独立开关 —— 用户随时启用/停用，互不影响
 *   · 失败隔离 —— 一个插件崩了不能拖垮整个应用
 *   · 按需加载 —— 未启用的插件不注入脚本、不占内存
 *
 * ── 设计要点 ────────────────────────────────────────────────────────────────
 *
 * ① **清单驱动**：每个插件目录里有 manifest.json（id/name/version/entry/styles/
 *    defaultEnabled）。加载器只认清单，不硬编码任何插件名 —— 这样"新增一个 mod"
 *    等于"加一个目录"，不需要改宿主代码。
 *
 * ② **失败隔离**：插件的加载与初始化都包在 try/catch 里。任何一个插件抛错，
 *    只把它标记为 error 并继续加载其余插件 —— 绝不让一个坏 mod 白屏整个应用。
 *    这一点必须做，因为 mod 是"用户可自行增删"的东西，质量不可控。
 *
 * ③ **动态 script 注入**：用 <script src> 注入而不是 fetch+eval。原因：
 *    · 保持与现有 app-*.js 一致的加载语义（顶层 const/let 进全局词法环境）
 *    · 浏览器能正常显示来源文件，调试时堆栈可读
 *    · 不需要处理 CSP 与 eval 的额外风险
 *    代价是加载是异步的，所以提供 await loadAll() 让宿主能等。
 *
 * ④ **宿主 API 收窄**：插件不能直接摸宿主内部（那样插件一多就没法重构）。
 *    宿主通过 `host` 参数只暴露必要的接口（见 createHostApi）。
 *
 * ⑤ **顺序可控**：manifest 可声明 `after`（依赖的插件 id），加载器做拓扑排序；
 *    环形依赖会被检测并报错，而不是死循环。
 * ========================================================================== */
(function () {
    'use strict';

    /** 插件根目录（相对站点根） */
    const MOD_ROOT = '/mods/';

    /**
     * 插件在磁盘上的**实际目录名**（已做 URL 编码，可直接拼进 URL）。
     *
     * ★ 为什么不能直接用 manifest.id 拼 URL（2026-09 修的真 bug）：
     *   插件 id 是**身份**（依赖匹配、资源引用都以它为准），而目录名是
     *   "它落在磁盘的哪个文件夹"。两者正常时相同，但**可能不同** ——
     *   历史版本把打包产物名（`elaina-avatar-1.0.0.zip`）当目录名安装过，
     *   于是目录叫 `elaina-avatar-1.0.0` 而 id 是 `elaina-avatar`。
     *   此时按 id 拼 URL 会让脚本与图片**全部 404**（表现为
     *   "插件开关打开了，但桌宠/Galgame 没有立绘、依赖也报缺失"）。
     *
     * ★ 为什么必须 encodeURIComponent（2026-09 第二次踩）：
     *   用户完全可以把插件目录改成中文（"桌宠"）或带空格（"my pet"）。
     *   不编码的话，同一个目录在不同地方会拼出不同字符串：
     *     · `el.src = '/mods/桌宠/index.js'` —— 浏览器读属性时得到**已编码**的
     *       `/mods/%E6%A1%8C%E5%AE%A0/index.js`
     *     · 而 `loadedScripts` 里存的是**未编码**的原串
     *   两者对不上 → `neverLoaded` 永远为真 → **每次启用都重复注入脚本**，
     *   插件的初始化会跑两次（界面出现两份、事件监听挂两遍）。
     *   `assetUrl()` 同理：编码后 `new Image().src` 与 fetch 才都能取到。
     *
     * 服务端在清单里为每个插件同时给出 id 与 dir，这里优先用 dir；
     * 旧版服务端没有 dir 字段时回落到 id（那时两者本来就一致）。
     */
    function modDir(manifest) {
        const d = manifest && typeof manifest.dir === 'string' ? manifest.dir.trim() : '';
        const raw = d || (manifest && manifest.id) || '';
        // 逐段编码：不能整串 encodeURIComponent（会把路径分隔符也编掉）。
        // 这里 dir 是单层目录名，但仍按 '/' 分段处理，兼容带子路径的写法。
        return String(raw).split('/').map(encodeURIComponent).join('/');
    }

    /** 插件状态：id -> { manifest, state, error, api } */
    const registry = new Map();

    /** 已注入的 <script>，避免重复注入 */
    const loadedScripts = new Set();

    /** 全局开关：用户可以在设置里彻底关掉插件系统 */
    const MODS_ENABLED_KEY = 'elaina_plugins_enabled';
    const MOD_ENABLED_KEY_PREFIX = 'elaina_plugin_';

    // ========================================================================
    //  用户偏好（哪些插件启用）
    // ========================================================================

    function modsGloballyEnabled() {
        try { return Store.getItem(MODS_ENABLED_KEY) !== '0'; } catch (e) { return true; }
    }
    function setModsGloballyEnabled(on) {
        try { Store.setItem(MODS_ENABLED_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }
    function isModEnabled(id, manifest) {
        try {
            const v = Store.getItem(MOD_ENABLED_KEY_PREFIX + id);
            if (v === null) return manifest && manifest.defaultEnabled !== false;
            return v === '1';
        } catch (e) {
            return !(manifest && manifest.defaultEnabled === false);
        }
    }
    function setModEnabled(id, on) {
        try { Store.setItem(MOD_ENABLED_KEY_PREFIX + id, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }

    /**
     * 忘掉某个插件的启用状态（删插件时调用）。
     *
     * 为什么删了还要清这个键：留着它没意义（插件都没了），更要紧的是
     * **重装同一个插件时会读到旧状态** —— 若上次是"已启用"，重装后会直接
     * 自动启用，而插件的约定是"默认关闭、用户手动开"。那会让新装的插件
     * 在用户不知情时改动界面。
     */
    function forgetMod(id) {
        try {
            Store.removeItem(MOD_ENABLED_KEY_PREFIX + id);
            const entry = registry.get(id);
            registry.delete(id);
            // ★ 真删：这个 mod 注册过的插槽/样式/提示词/事件订阅一并释放。
            //   只删目录不释放注册项的话，界面里会留下一个点了没反应的入口
            //   （它指向的插件已经不在了）—— 比"没装过"更难理解。
            disposeContributions(id);
            // 工厂也丢掉：重装同一个插件时应当是一次干净的重注册
            pendingRegistrations.delete(id);
            const rn = entry && entry.regName;
            if (rn) {
                regByDir.forEach((v, k) => { if (v === rn) regByDir.delete(k); });
                dirByReg.delete(rn);
            }
            // 清掉"已注入脚本"的记录时要同时认 id 与**实际目录名** ——
            // 两者可能不同（见 modDir 说明），只按 id 匹配会漏删，
            // 于是重装同一个插件时脚本不会被重新注入（表现为"装了没反应"）。
            const needles = ['/' + id + '/'];
            if (entry && entry.manifest && entry.manifest.dir) needles.push('/' + entry.manifest.dir + '/');
            loadedScripts.forEach((v, k) => {
                if (needles.some((n) => k.includes(n))) loadedScripts.delete(k);
            });
        } catch (e) { /* 忽略 */ }
    }

    // ========================================================================
    //  宿主 API：插件只能通过它访问宿主能力
    // ========================================================================

    /**
     * 构造交给插件的宿主接口。
     *
     * 为什么不直接把 window 给它：插件一旦随手引用宿主的内部变量
     * （`state` / `elements` / 各种内部函数），宿主以后就没法重构了 ——
     * 任何改名都会悄悄弄坏某个 mod。这里显式列出允许使用的入口，
     * 宿主改内部实现时只要保证这张表不变，插件就不会坏。
     *
     * @param {object} manifest 清单条目
     * @param {string} [regName] 插件脚本里 register() 用的名字（缺省 = manifest.id）
     */
    function createHostApi(manifest, regName) {
        // 日志前缀用**注册名**（插件自己认得的名字），便于对上它的源码
        const name = regName || manifest.id;
        const log = (level, ...args) => {
            const tag = '[Mod:' + name + ']';
            const fn = console[level] || console.log;
            try { fn(tag, ...args); } catch (e) { /* 忽略 */ }
        };
        return {
            id: name,
            manifestId: manifest.id,
            version: manifest.version || '0.0.0',

            // ---- 资源定位（修「资源包装了等于没装」的另一半）----
            /**
             * 取本插件资源的 URL 基址（结尾带 /）。
             *
             * 为什么必须用它而不是插件自己拼 '/mods/<名字>/…'：
             *   插件**声明的 id** 与它**实际被安装成**的目录名可能不一致
             *   （历史版本曾把带版本号的 zip 名当目录名，装出
             *    elaina-avatar-1.0.0/ 这种目录，写死的 URL 全部 404）。
             *   这里用的 manifest.dir 是**磁盘上的真实目录名**，
             *   由它给的基址才是资源真正能取到的位置。
             *
             * 典型用法：host.assetUrl('img/p_calm.png')
             *   → '/mods/elaina-avatar/img/p_calm.png'
             */
            assetUrl(rel) {
                const r = String(rel || '').replace(/^\/+/, '');
                return MOD_ROOT + modDir(manifest) + '/' + r;
            },
            /** 本插件资源目录的 URL（结尾带 /），供需要自行拼路径的场合 */
            assetBase() { return MOD_ROOT + modDir(manifest) + '/'; },

            // ---- 查找其他插件（★ 由插件系统统一解析，插件不自己拼路径）----
            /**
             * 按**注册名 / 清单 id / 目录名**中的任意一个查找插件。
             *
             * 为什么要有这个：插件之间互相依赖（galgame 要用 elaina-avatar 的
             * 立绘接口）时，插件自己拼 `/mods/elaina-avatar/…` 是脆的 ——
             * 用户改了目录名、或清单 id 与注册名不一致，路径就错了。
             * 交给系统查表才是稳的：系统维护着"注册名 ↔ 目录"的映射。
             *
             * 用法：
             *   const av = host.require('elaina-avatar');
             *   if (!av.ok) { host.error(av.reason); return; }
             *   const url = av.url('img/p_calm.png');   // 资源路径由系统算
             */
            require(key) {
                try {
                    const found = window.ElainaMods.find(key);
                    if (!found) {
                        return {
                            ok: false,
                            reason: '找不到插件「' + key + '」。请先在「设置 → 插件」里安装并启用它。',
                        };
                    }
                    if (found.state !== 'ready') {
                        return {
                            ok: false,
                            found,
                            reason: '插件「' + key + '」当前状态是 ' + found.state
                                + '，还不能使用' + (found.entry && found.entry.error ? '：' + found.entry.error : '。'),
                        };
                    }
                    const dir = found.dir;
                    const enc = dir.split('/').map(encodeURIComponent).join('/');
                    return {
                        ok: true,
                        id: found.id,
                        dir,
                        regName: found.regName,
                        api: found.entry ? found.entry.api : null,
                        /** 取该插件的资源 URL（路径由系统按真实目录算） */
                        url: (rel) => MOD_ROOT + enc + '/' + String(rel || '').replace(/^\/+/, ''),
                        base: () => MOD_ROOT + enc + '/',
                    };
                } catch (e) {
                    return { ok: false, reason: '查找插件「' + key + '」时出错：' + (e && e.message || e) };
                }
            },

            // ---- 日志（带插件前缀，便于定位是哪个 mod 在说话）----
            log: (...a) => log('log', ...a),
            warn: (...a) => log('warn', ...a),
            error: (...a) => log('error', ...a),

            // ---- 对话数据（只读约定：改数据请走下面的 API）----
            /** 取当前会话；没有则 null */
            getConversation() {
                try {
                    if (typeof state === 'undefined' || !state) return null;
                    const list = state.conversations || [];
                    return list.find((c) => c.id === state.currentConversationId) || list[0] || null;
                } catch (e) { return null; }
            },
            /** 取会话里的消息数组（引用，插件只读遍历） */
            getMessages() {
                const c = this.getConversation();
                return (c && Array.isArray(c.messages)) ? c.messages : [];
            },
            /** 当前是否处于某个特殊页面模式（便签/日记），插件据此决定要不要显示 */
            getUiMode() {
                try {
                    return { notes: !!state.notesMode, diary: !!state.diaryMode };
                } catch (e) { return { notes: false, diary: false }; }
            },

            // ---- 发送消息（走宿主既有链路，不另起一套请求）----
            /**
             * 以用户身份发一条消息。复用宿主 handleUserInput，
             * 保证"从插件发出的消息"和"从主输入框发出的"完全同一条链路
             * （记忆、续跑、停止、语音都自动生效）。
             *
             * ★ 必须自己构造消息**对象**并推进会话，不能只把字符串丢给
             *   handleUserInput —— 它签名是 `(message, conversation)`，
             *   内部读 `message.text` / `message.id`。早先这里传的是字符串，
             *   于是 `message.text` 是 undefined → **发出去的是空消息**
             *   （实测踩过：出站请求里 `role=user` 的内容长度是 0，
             *   桌宠的"主动搭话"因此说了个空话，AI 完全看不到电脑状态）。
             *
             *   主输入框那条路（processVoiceInput / handleInitialTextSubmit）
             *   也是这么构造的：id + role + text + timestamp，再 push 进
             *   conversation.messages。这里照做，才叫"同一条链路"。
             */
            sendUserMessage(text) {
                try {
                    const msg = String(text || '').trim();
                    if (!msg) return false;
                    const c = this.getConversation();
                    if (!c || typeof handleUserInput !== 'function') return false;
                    if (typeof generateId !== 'function') return false;

                    const message = {
                        id: generateId(),
                        role: 'user',
                        text: msg,
                        timestamp: new Date().toLocaleTimeString(),
                    };
                    if (!Array.isArray(c.messages)) c.messages = [];
                    c.messages.push(message);

                    // 首条消息时给会话起个名（与主输入框一致），
                    // 否则插件发出的第一条消息不会让会话标题变正常
                    if (c.messages.length === 1) {
                        try {
                            if (typeof autoNameConversation === 'function') {
                                c.title = autoNameConversation(c.messages);
                            }
                            if (typeof renderFolderList === 'function') renderFolderList();
                            if (typeof updateCurrentConversationTitle === 'function') updateCurrentConversationTitle();
                        } catch (e) { /* 命名失败不影响发送 */ }
                    }
                    // 让界面把新消息画出来（主输入框那条路也会 loadConversation）
                    try {
                        if (typeof loadConversation === 'function') loadConversation(c.id);
                    } catch (e) { /* 忽略 */ }

                    handleUserInput(message, c);
                    return true;
                } catch (e) { log('error', 'sendUserMessage 失败', e); return false; }
            },

            // ---- 文本渲染（Markdown / LaTeX，与主界面同一套）----
            renderText(text) {
                try {
                    if (typeof renderMessageText === 'function') return renderMessageText(text);
                } catch (e) { /* 回落到纯文本 */ }
                // 回落：至少把 HTML 转义掉，避免插件直接把用户内容当 HTML 插进去
                return String(text == null ? '' : text)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            },

            // ---- 宿主弹窗（插件不要自己去摸 window.showCustomAlert）----
            /**
             * 弹一个提示框（带标题）。
             *
             * 为什么收进 host API 而不是让插件直接调 window.showCustomAlert：
             * 那是宿主的**内部实现**，插件一旦直接引用它，宿主改名或改签名就会
             * 悄悄弄坏插件（而这正是 host API 这张收窄清单要防的事）。
             * 走这里之后，宿主可以自由重构弹窗实现，插件不受影响。
             *
             * 没有该能力时（老宿主 / 极端环境）回落到原生 alert ——
             * 宁可弹得难看，也不要让插件的重要提示（如"重命名失败"）消失。
             */
            alert(message, title) {
                const text = String(message == null ? '' : message);
                try {
                    if (typeof showCustomAlert === 'function') return showCustomAlert(text, title);
                } catch (e) { /* 回落到原生 */ }
                try { window.alert((title ? title + '\n\n' : '') + text); } catch (e) { /* 忽略 */ }
            },

            /** 弹一个确认框，返回 Promise<boolean>。同上：不要直接摸宿主内部。 */
            async confirm(message, title) {
                const text = String(message == null ? '' : message);
                try {
                    if (typeof showCustomConfirm === 'function') return Boolean(await showCustomConfirm(text, title));
                } catch (e) { /* 回落到原生 */ }
                try { return window.confirm((title ? title + '\n\n' : '') + text); } catch (e) { return false; }
            },

            // ---- 在文件管理器里打开自己（或自己目录内的）文件夹 ----
            /**
             * 在系统文件管理器里打开这个插件的目录。
             *
             *   await host.openFolder();                  // 插件自己的目录
             *   await host.openFolder('models/deepseek'); // 插件目录内的一层子路径
             *
             * ★ 为什么让宿主代劳而不是插件自己 fetch：路径白名单在**服务端**，
             *   而这些判断属于"宿主与宿主接口之间"的约定。插件只要说"我想开我自己
             *   目录下的这个子路径"，越界与否由宿主拒绝 —— 插件不必也不该知道
             *   `web/mods/` 在哪、白名单长什么样。
             *
             * ★ 只有本机（有服务端）能开；APK / 局域网设备会拿到明确的失败原因，
             *   插件据此给用户提示即可（不要静默）。
             *
             * @returns {Promise<{ok:boolean, path?:string, message?:string}>}
             */
            async openFolder(sub) {
                const q = new URLSearchParams({ id: manifest.id });
                if (sub) q.set('sub', String(sub));
                try {
                    const res = await fetch('/api/plugins/open-folder?' + q.toString(), { method: 'POST' });
                    const data = await res.json().catch(() => null);
                    if (res.ok && data && data.ok) return { ok: true, path: data.path };
                    return { ok: false, message: (data && data.message) || ('HTTP ' + res.status) };
                } catch (e) {
                    return { ok: false, message: String((e && e.message) || e) };
                }
            },

            // ---- 列表拖拽排序（宿主实现，插件复用）----
            /**
             * 给一组 `.mod-card` 元素绑定拖拽排序（与插件页同一套手感：
             * 卡片跟随指针、其它卡片让位并带过渡动画）。
             *
             *   const stop = host.dragSort(container, (ids) => save(ids));
             *
             * ★ 为什么由宿主实现：这套交互有相当多细节（指针捕获、FLIP 动画、
             *   占位块、Esc 取消、触屏），每个插件各写一份必然分叉 ——
             *   而且"某个列表拖起来手感不一样"是最难解释的那类不一致。
             *
             * ★ 只改**显示顺序**：宿主不解释这些 id 的语义，也不碰任何加载顺序。
             *   要不要持久化、存哪儿，由调用方在自己那个 `onDone(ids)` 里决定
             *   （宿主不该知道某个插件的排序存在哪）。
             *
             * @param {Element} container 容器（内部元素需带 class="mod-card"）
             * @param {(ids:string[], container:Element)=>void} [onDone] 松手后回调
             * @returns {Function} 解绑函数
             */
            dragSort(container, onDone) {
                return bindFlatDragSort(container, onDone);
            },

            // ---- 宿主插槽：向宿主挖好的命名扩展点里注册 ----
            /**
             * 往宿主插槽里注册一项。设置分栏 / 顶部按钮都是插槽实例。
             *
             *   const tab = host.slot('settings.tabs', {
             *       id: 'live2d', label: 'Live2D',
             *       render(container) { … },      // 可被重复调用（重新挂载时会再调）
             *   });
             *
             * 返回句柄：`{ el, dispose() }`。**通常不需要自己 dispose** ——
             * 停用/卸载插件时 mod 系统会统一回收（见文件顶部「注册即副作用」）。
             * 只有"插件还在、但这一项不要了"时才手动调。
             *
             * @returns {{el:Element|null, dispose:Function}|null} 注册失败（插槽名写错）返回 null
             */
            slot(name, spec) { return registerSlot(manifest.id, name, spec, log); },
            /** 宿主当前提供的插槽名（mod 想探测可用扩展点时用） */
            slots() { return [...slotImpls.keys()]; },

            // ---- 样式注入（插件自己的 css，随插件启用/停用）----
            /**
             * 注入一份插件自己的样式表。
             *
             * ★ 停用时会**真的失效**（`disabled=true`，不重新下载），启用时恢复。
             *   与清单里 `styles` 声明的那份走同一段代码 —— 两条路径都会回收。
             */
            injectStyle(href) { return injectStyleLink(manifest, href); },

            // ---- 往 system 提示词里追加内容（插件影响模型行为的唯一入口）----
            /**
             * 注册一段"动态 system 提示词"。宿主在每次构造对话消息时调用它。
             * 为什么用注册而不是直接改：插件不该知道宿主怎么拼提示词，
             * 宿主也不该知道有哪些插件 —— 注册表是唯一的耦合点。
             *
             * ★ 插件被停用时这段提示词会被**摘掉**（文本留着，启用时原样恢复）。
             *   旧实现从不清 promptHints，于是"关掉的插件还在影响模型行为" ——
             *   看不见、也想不到去查，属于最难定位的一类。
             */
            setPromptHint(text) {
                const t = String(text || '');
                promptHintText.set(manifest.id, t);
                promptHints.set(manifest.id, t);
                ensurePromptHintContribution(manifest.id);
            },
            clearPromptHint() {
                promptHintText.delete(manifest.id);
                promptHints.delete(manifest.id);
            },

            // ---- 事件 ----
            /**
             * 订阅宿主事件。返回取消订阅的函数。
             *
             * ★ 停用插件时订阅会被摘掉（回调留着，启用时再接上）——
             *   否则停用的插件仍在后台响应事件，行为和"已停用"不符。
             *   返回的取消函数仍然可用（用于插件自己中途退订）。
             */
            on(event, handler) {
                const h = handler;
                const attach = () => {
                    if (!bus.has(event)) bus.set(event, new Set());
                    bus.get(event).add(h);
                };
                const detach = () => {
                    const set = bus.get(event);
                    if (set) set.delete(h);
                };
                addContribution(manifest.id, {
                    activate: attach,
                    deactivate: detach,
                    dispose: detach,
                });
                return detach;
            },
            emit(event, detail) {
                const set = bus.get(event);
                if (!set) return;
                for (const h of set) {
                    try { h(detail); } catch (e) { log('error', '事件处理失败 ' + event, e); }
                }
            },

            // ---- 宿主能力探测：插件据此决定降级行为 ----
            has(name) {
                try { return typeof window[name] !== 'undefined'; } catch (e) { return false; }
            },
        };
    }

    /** 插件注册的 system 提示词片段：id -> text（**当前生效**的那些） */
    const promptHints = new Map();

    /**
     * 插件声明的提示词原文：id -> text（**与启用状态无关**）。
     *
     * 为什么要与 promptHints 分开：停用插件是"把这段提示词摘下来"，
     * 而不是"忘掉插件写过什么"。启用时要能原样挂回去，所以原文留在这里。
     */
    const promptHintText = new Map();

    /**
     * 给某个 mod 挂上"提示词"这条贡献（每个 mod 只挂一次）。
     *
     * ★ 为什么延迟登记、且只登记一条：
     *   galgame 会随场景切换反复调 setPromptHint。若每次调用都新增一条贡献，
     *   停用时会反复删同一个键（无害但白涨），而"恢复"时会按登记顺序挂回
     *   **早期那份旧文本**（最后一条只会再覆盖一次，结果是巧合而非保证）。
     *   这里只挂一条，它的 activate 永远去读当前原文。
     */
    function ensurePromptHintContribution(modId) {
        const set = contributionSet(modId);
        for (const c of set) {
            if (c.__promptHint) return;
        }
        set.add({
            __promptHint: true,
            activate() {
                if (promptHintText.has(modId)) promptHints.set(modId, promptHintText.get(modId));
            },
            deactivate() { promptHints.delete(modId); },
            dispose() { promptHints.delete(modId); promptHintText.delete(modId); },
        });
    }

    /** 简易事件总线（宿主 ↔ 插件、插件 ↔ 插件） */
    const bus = new Map();

    // ========================================================================
    //  宿主插槽（named slots）+「注册即副作用」
    //
    //  ── 为什么不是"每种扩展点一个 API" ─────────────────────────────────────
    //
    //  给 Live2D 搬迁列需求时，最初的结论是"要新增三种宿主能力"：注册设置分栏、
    //  注册顶部按钮、注册服务端接口。问题是这三种几乎不共用代码，而每多一种
    //  扩展点（聊天区按钮、侧栏底部…）就得再加一个宿主 API 与一套回收逻辑。
    //
    //  改成**命名插槽**后，宿主只负责挖插槽（`settings.tabs` / `header.actions`…），
    //  mod 只用一个 `host.slot(name, spec)`。设置分栏与顶部按钮都只是插槽的实例，
    //  以后 Live2D / Galgame / 任何新 mod 共用同一套机制与同一套回收逻辑。
    //  （改法借鉴自 DSH 的 `ctx.slots.register`，见开发文档 8.45 的对照表。）
    //
    //  ── ★ 这一节的真正目的：注册必须可以反悔 ──────────────────────────────
    //
    //  插件是可开关的，而"关掉"必须真的关掉：注册过的插槽、注入的样式、
    //  追加的 system 提示词、订阅的事件，都得跟着消失。以前这些全靠各处手写，
    //  漏一处就是一种难查的 bug —— 实测已有两例：
    //    · 停用的 mod 仍然往 system 提示词里加内容（promptHints 从不清）
    //    · injectStyle 挂上去就再没摘过
    //
    //  所以这里把 mod 的每一项注册都记成**一条可撤销的贡献**：
    //    停用 → deactivate（从界面/提示词/事件上摘掉，但**保留 spec**）
    //    启用 → activate  （拿保留的 spec 重新挂上）
    //    卸载 → dispose   （真删，连 spec 一起丢）
    //
    //  ★ 为什么"启用"不重跑 mod 的工厂（register 里的那个函数）：
    //    galgame / pet 的工厂里建 DOM、挂监听、起定时器。重跑工厂会得到
    //    两份界面、两组定时器。工厂在 mod 约定里是"初始化一次"，而可以
    //    反复执行的是**注册动作** —— 保留 spec 就是为了这个。
    // ========================================================================

    /** 宿主挖好的插槽：插槽名 → 挂载实现 { mount(spec), note? } */
    const slotImpls = new Map();

    /** 插槽上已注册的条目：插槽名 → Map<key, entry>（entry 见 registerSlot） */
    const slotEntries = new Map();

    /** 每个 mod 的可撤销贡献：modId → Set<contribution> */
    const contributions = new Map();

    function contributionSet(modId) {
        if (!contributions.has(modId)) contributions.set(modId, new Set());
        return contributions.get(modId);
    }

    /**
     * 登记一项贡献并立即挂上。
     * @param {string} modId 归属的 mod（停用/卸载时按它整批回收）
     * @param {{activate?:Function, deactivate?:Function, dispose?:Function}} c
     */
    function addContribution(modId, c) {
        contributionSet(modId).add(c);
        try {
            if (typeof c.activate === 'function') c.activate();
        } catch (e) {
            // 挂载失败不该连累别的贡献，但必须报出来 —— 否则表现为"注册了没反应"
            console.error('[Mod:' + modId + '] 注册项挂载失败（已跳过这一项）', e);
        }
        return c;
    }

    /** 对某个 mod 的全部贡献依次执行某个动作（单项出错不影响其余） */
    function forEachContribution(modId, action) {
        const set = contributions.get(modId);
        if (!set) return;
        for (const c of [...set]) {
            try {
                if (typeof c[action] === 'function') c[action]();
            } catch (e) {
                console.error('[Mod:' + modId + '] ' + action + ' 失败（继续处理其余注册项）', e);
            }
        }
    }

    /** 停用：摘掉贡献但保留 spec，之后还能 activate 回来 */
    function deactivateContributions(modId) { forEachContribution(modId, 'deactivate'); }
    /** 重新启用：用保留的 spec 挂回去 */
    function activateContributions(modId) { forEachContribution(modId, 'activate'); }
    /** 卸载：真删。调用后这个 mod 的贡献表被清空 */
    function disposeContributions(modId) {
        // 倒序释放：后注册的先摘，和构造顺序相反（与栈式清理一致）
        const set = contributions.get(modId);
        if (set) {
            for (const c of [...set].reverse()) {
                try { if (typeof c.dispose === 'function') c.dispose(); }
                catch (e) { console.error('[Mod:' + modId + '] 释放注册项失败', e); }
            }
        }
        contributions.delete(modId);
    }

    /**
     * 往插槽里注册一项（`host.slot(name, spec)` 的实现）。
     *
     * spec 由**宿主插槽的约定**决定（例如 settings.tabs 要 label + render），
     * 这里只做归属登记、去重与生命周期，不解释 spec 的业务含义 ——
     * 解释权在挖插槽的那一方，mod 系统不该长着每种扩展点的知识。
     *
     * 插槽名写错时**明确报出来并列出可用插槽**：写错名字是 mod 作者最容易犯的错，
     * 而"注册了但界面没变化"是最难查的表现形式。
     */
    function registerSlot(modId, name, spec, log) {
        const impl = slotImpls.get(name);
        if (!impl) {
            const available = [...slotImpls.keys()].join('、') || '（宿主当前没有提供任何插槽）';
            log('error', '宿主没有名为「' + name + '」的插槽，本次注册被忽略。可用插槽：' + available);
            return null;
        }
        if (!spec || typeof spec !== 'object') {
            log('error', 'host.slot(' + name + ', spec) 的 spec 必须是对象');
            return null;
        }
        const key = modId + ':' + String(spec.id || spec.key || 'default');
        if (!slotEntries.has(name)) slotEntries.set(name, new Map());
        const table = slotEntries.get(name);
        if (table.has(key)) {
            log('warn', '插槽 ' + name + ' 上已有同名条目（' + key + '），本次注册被忽略');
            return table.get(key).handle;
        }

        const entry = { modId, name, key, spec, mounted: null, active: false };

        function mountNow() {
            if (entry.mounted) return;
            const m = impl.mount(spec, { modId, name, key, log });
            // 插槽实现可以不返回东西（例如纯粹的内部登记），那就没什么可显隐的
            entry.mounted = m || { el: null, dispose() {} };
            if (typeof entry.mounted.show === 'function') entry.mounted.show();
        }

        /**
         * 卸载挂载出来的东西，但**保留 spec 与登记行**。
         *
         * ★ 停用走"真卸载"而不是"只藏起来"：
         *   藏着的面板会带着旧内容（延迟渲染的标记已经置位），重新启用后显示的是
         *   停用前的状态 —— 而用户在这期间可能改过设置，看到的却是过期界面。
         *   卸载后用同一份 spec 重新挂载，渲染标记也是新的，内容自然是当前的。
         */
        function unmountNow() {
            if (entry.mounted && typeof entry.mounted.dispose === 'function') {
                try { entry.mounted.dispose(); } catch (e) { /* 释放失败不该挡住状态推进 */ }
            }
            entry.mounted = null;
        }

        const handle = {
            get el() { return entry.mounted ? entry.mounted.el : null; },
            /** 每项级插槽：宿主把 spec 渲染进某个容器时，靠它判断这项要不要参与 */
            get active() { return entry.active; },
            dispose() {
                unmountNow();
                const t = slotEntries.get(name);
                if (t) t.delete(key);
            },
        };
        entry.handle = handle;
        table.set(key, entry);

        const c = {
            activate() {
                entry.active = true;
                // 每项级插槽没有"一次性的挂载"可做 —— 内容由宿主在渲染每一项时拉取
                if (impl.item === true) { if (typeof impl.refresh === 'function') safely(() => impl.refresh(modId)); return; }
                mountNow();
            },
            deactivate() {
                entry.active = false;
                if (impl.item === true) {
                    // ★ 停用要**立刻**把已经画在界面上的东西摘掉，不能等下次重渲染 ——
                    //   否则用户关了插件，消息行里的按钮还留着（点了会报错或没反应）。
                    //   摘除方式由插槽实现决定（它知道自己的容器长什么样）。
                    if (typeof impl.cleanup === 'function') safely(() => impl.cleanup(modId));
                    return;
                }
                unmountNow();
            },
            dispose() {
                if (impl.item === true && typeof impl.cleanup === 'function') safely(() => impl.cleanup(modId));
                handle.dispose();
            },
        };
        addContribution(modId, c);
        return handle;
    }

    /** 跑一小段插件提供的回调，出错只记日志（插件的问题不该中断宿主流程） */
    function safely(fn) {
        try { fn(); } catch (e) { console.error('[Mod] 插槽回调出错（已隔离）', e); }
    }

    /**
     * 宿主渲染「每一项都要装饰」的位置时调用它（每项级插槽，`defineSlot` 里标了 `item: true`）。
     *
     * 与普通插槽的区别：普通插槽是**注册时挂载一次**（比如设置里的一个分栏）；
     * 每项级插槽是**宿主每渲染一项就问一次**（比如每条消息行的按钮）——
     * 注册时还没有消息，所以那时候什么都挂不了。
     *
     * @param {string} name  插槽名
     * @param {Element} container 宿主给 mod 的容器（mod 只往里加，别动别的）
     * @param {*} item 这一项的上下文（如 { message, conversationId }）
     */
    function renderItemSlot(name, container, item) {
        if (!container || !container.appendChild) return 0;
        const table = slotEntries.get(name);
        if (!table) return 0;
        let count = 0;
        for (const entry of table.values()) {
            if (!entry.active) continue;                 // 停用的 mod 不参与
            const render = entry.spec && entry.spec.render;
            if (typeof render !== 'function') continue;
            // 记下渲染前已有的子节点：渲染后新加进来的都算这个 mod 的，
            // 打上 data-mod 便于停用时精确摘除（不碰其它 mod 与宿主自己的东西）
            const before = new Set(container.children);
            try {
                render(container, item);
            } catch (e) {
                console.error('[Mod:' + entry.modId + '] 插槽 ' + name + ' 渲染失败（已隔离）', e);
                continue;
            }
            for (const child of container.children) {
                if (!before.has(child) && !child.hasAttribute('data-mod')) {
                    child.setAttribute('data-mod', entry.modId);
                }
            }
            count++;
        }
        return count;
    }

    /**
     * 给一组 `.mod-card` 绑定**扁平列表**的拖拽排序（宿主实现，供插件复用）。
     *
     * 与设置页插件列表那套手感一致：
     *   · 卡片改成 position:fixed 挂到 body，跟着指针走（transform 每帧更新）
     *   · 原位置留一个虚线占位块，随指针移动 —— 那就是"让出来的空白"
     *   · 其它卡片用 FLIP（先量后改再演回去）平滑换位
     *   · 松手后卡片飞回占位块；Esc / pointercancel 取消
     *
     * ★ 几个必须做对的点（都在实测里踩过）：
     *   ① move/up 绑在 **document** 上，不是 grip。卡片拖拽中会被移到 body，
     *      元素搬位置时指针捕获**可能丢失**，一旦丢了卡片会僵在半空、占位块留着。
     *   ② 卡片 fixed 定位必须记住原来的屏幕位置（left/top/width/height），
     *      否则会跳到左上角。
     *   ③ 拖拽期间给 body 加类禁用文字划选，否则拖动会变成划选。
     *   ④ 只改**显示顺序**：宿主不解释 id 语义、不碰加载顺序，持久化交给调用方。
     *
     * @param {Element} container 容器（直接子元素里带 class="mod-card" 的参与排序）
     * @param {(ids:string[], container:Element)=>void} [onDone] 松手后回调（拿到新顺序）
     * @returns {Function} 解绑函数
     */
    function bindFlatDragSort(container, onDone, options) {
        if (!container) return () => {};
        // ★ 可配置项：分栏（.mod-group）的拖拽也复用这套内核 —— 它的"项"是分栏
        //   而不是卡片，把手是整个分栏头而不是三条竖线。选项不给时用卡片默认值。
        const opts = options || {};
        const ITEM_SEL = opts.itemSelector || '.mod-card';
        const HANDLE_SEL = opts.handleSelector || '.mod-grip';
        const ID_ATTR = opts.idAttr || null;              // null = 自动（先 data-model-name 后 data-mod-id）
        const PLACEHOLDER_CLASS = opts.placeholderClass || 'mod-placeholder';
        const DRAGGING_CLASS = opts.draggingClass || 'mod-dragging';
        // ★ 外层容器的项选择器（可选）：拖出父容器后，插入点候选按这个选。
        //   插件分栏场景：拖分栏到顶层时，候选要**包含平铺卡片**——否则分栏只能
        //   插到其它分栏前面，永远到不了卡片之间（"分栏拖不到卡片上面"的根因）。
        const OUTER_ITEM_SEL = opts.outerItemSelector || ITEM_SEL;
        // ★ 顶层混排模式：项本身就在 container 顶层（分栏与卡片混排），
        //   插入点候选**始终**用 OUTER_ITEM_SEL（含两类项）—— 不需要"逃逸"判定。
        const TOP_MIXED = Boolean(opts.topLevelMixed);
        // 拖拽时挂在"项"上的类由 CSS 定义（.mod-card.mod-dragging / .mod-group.mod-dragging）
        const handlers = [];
        let drag = null;
        // ★ 拖拽中的"项"所在的**真实父容器**（pointerdown 时确定）。
        //   不能假设调用方传的 container 就是项的父级：分栏渲染后卡片住在
        //   .mod-group-body 里，container 是更外层的 #modsList。排序范围、
        //   占位块、FLIP 测量都应限定在这一层（跨分栏的移动是上层的职责）。
        let parent = null;
        // ★ "逃逸"容器：项被拖出父容器范围时的落脚点（outerContainer 选项）。
        //   例如卡片从分栏体拖出到 #modsList 顶层 —— 没有它，放进去的拿不出来。
        let outer = opts.outerContainer || null;

        /** 取一个项的 id（存顺序用）：优先 data-model-name，其次 data-mod-id */
        function idOf(el) {
            if (ID_ATTR) return el.getAttribute(ID_ATTR) || '';
            return el.getAttribute('data-model-name') || el.getAttribute('data-mod-id') || '';
        }

        /** FLIP：改动布局前后测量，用 transform 把位移"演"回去。
         *  scope = 布局被改动的容器。跨容器搬家时对**旧容器**再调一次，
         *  两边的项都得到位移补偿（否则另一边的项会瞬移，动画"消失"）。 */
        function flip(scope, mutate) {
            const items = [...scope.querySelectorAll(ITEM_SEL + ', .' + PLACEHOLDER_CLASS)];
            const first = new Map();
            for (const el of items) first.set(el, el.getBoundingClientRect());
            // 跨容器：占位块自身的旧屏幕位置也记下（它要从那里"飞"到新家）
            const phRect = drag && drag.ph ? drag.ph.getBoundingClientRect() : null;
            mutate();
            for (const [el, r] of first) {
                if (!el.isConnected) continue;
                const now = el.getBoundingClientRect();
                const dy = r.top - now.top;
                if (!dy) continue;
                el.style.transition = 'none';
                el.style.transform = 'translateY(' + dy + 'px)';
                requestAnimationFrame(() => {
                    el.style.transition = 'transform .18s cubic-bezier(.2,.8,.3,1)';
                    el.style.transform = '';
                });
            }
            // 占位块跨容器：从旧位置演到新位置（否则它瞬移 —— "动画消失"的观感来源）
            if (phRect && drag && drag.ph.isConnected) {
                const nowP = drag.ph.getBoundingClientRect();
                const dy = phRect.top - nowP.top;
                if (dy) {
                    drag.ph.style.transition = 'none';
                    drag.ph.style.transform = 'translateY(' + dy + 'px)';
                    requestAnimationFrame(() => {
                        drag.ph.style.transition = 'transform .18s cubic-bezier(.2,.8,.3,1)';
                        drag.ph.style.transform = '';
                    });
                }
            }
        }

        /** 指针位置对应的插入点（在 scope 里找；返回要插到谁前面；null = 插到最后） */
        function targetBefore(scope, y) {
            for (const c of scope.querySelectorAll(ITEM_SEL)) {
                const r = c.getBoundingClientRect();
                if (y < r.top + r.height / 2) return c;
            }
            return null;
        }

        container.querySelectorAll(HANDLE_SEL).forEach((grip) => {
            const onDown = (ev) => {
                if (drag) return;
                const card = grip.closest(ITEM_SEL);
                if (!card) return;
                // ★ 只认主键 / 触摸：右键、中键拖动不该触发排序
                if (ev.button != null && ev.button !== 0) return;
                // ★ 调用方否决：把手可能同时是别的控件（如分栏头还是折叠开关），
                //   canStart 返回 false 表示"这次按下不进拖拽"（调用方已自行处理语义）。
                if (typeof opts.canStart === 'function' && !opts.canStart(ev)) return;
                ev.preventDefault();
                // ★ 记录手势是否移动过 + 起点：配合 opts.onTap 实现"没动就松手 = 单击"。
                //   preventDefault 吞掉了 click，调用方只能从这里拿单击语义。
                const downX = ev.clientX, downY = ev.clientY;
                let moved = false;

                const rect = card.getBoundingClientRect();
                // ★ 卡片的**真实父容器**：占位块要插到卡片原来的位置，
                //   即卡片自己的 parentElement 里 —— 不能假设调用方传的 container
                //   就是卡片的父级。分栏渲染后卡片住在 .mod-group-body 里，
                //   而 container 是更外层的 #modsList；这时 insertBefore(ph, card)
                //   会抛 "not a child of this node"（实测踩到）。
                //   排序的目标范围也跟着取真实父容器 —— 拖拽排序本来就是
                //   "在同一层里换位置"，跨分栏的移动由上层（归类拖拽）负责。
                parent = card.parentElement;
                const ph = document.createElement('div');
                ph.className = PLACEHOLDER_CLASS;
                ph.style.height = rect.height + 'px';
                parent.insertBefore(ph, card);
                // ② 卡片改成 fixed 跟随指针（记住原屏幕位置，否则会跳到左上角）
                card.style.width = rect.width + 'px';
                card.style.height = rect.height + 'px';
                card.style.left = rect.left + 'px';
                card.style.top = rect.top + 'px';
                card.classList.add(DRAGGING_CLASS);
                document.body.appendChild(card);           // 挂 body：容器可能 overflow:hidden
                document.body.classList.add('mod-dragging-active');
                try { grip.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }

                drag = {
                    card, ph, grip,
                    // ★ 抓取点相对卡片左上角的偏移。拖动时保持不变，
                    //   卡片才不会在按下的瞬间"跳"到指针下方（桌面图标的手感）。
                    grabDX: ev.clientX - rect.left,
                    grabDY: ev.clientY - rect.top,
                    // 上一次的落点，用于判断占位块要不要挪（否则每帧都触发 FLIP）
                    lastBefore: card,
                    lastParent: null,
                    // ★ 父容器 rect 缓存：拖动中滚动/结构不变，无需每帧重测
                    //   （每帧 getBoundingClientRect 是"经过分栏变卡"的元凶之一）。
                    prCache: null,
                };
                drag.prCache = parent.getBoundingClientRect();
                // 抬起效果：略微放大，像从桌面上"拿起来"。
                // ★ 与跟随位移写在**同一个内联 transform** 里 —— 否则 CSS 一个 scale、
                //   JS 一个 translate 会互相覆盖（这正是"不跟手"的成因之一）。
                // ★ transform-origin 设到**抓取点**：默认是以中心缩放，那会让
                //   卡片左边缘外移（实测 630px 宽的卡片外移 10px），按下的瞬间
                //   手指底下那张卡就"滑"了一下 —— 又是一种不跟手。
                //   以抓取点为原点缩放，等于"捏住那一点把它提起来"，指针下的
                //   内容纹丝不动，这才是拖动桌面图标的手感。
                card.style.transformOrigin = drag.grabDX + 'px ' + drag.grabDY + 'px';
                setTf(0, 0, true);

                const onMove = (e) => {
                    if (!drag) return;
                    // ★ 记录"动过"：移出 5px 即视为拖拽（供 onTap 判单击用）
                    if (!moved && (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5)) {
                        moved = true;
                    }
                    // ★ 二维跟手：抓在哪就一直在哪。原先只写 translateY ——
                    //   横向拖动时卡片横向不动，所以看起来"不跟手"。
                    const dx = e.clientX - rect.left - drag.grabDX;
                    const dy = e.clientY - rect.top - drag.grabDY;
                    setTf(dx, dy, true);

                    // ★ 插入点判定分两种（都排除拖动中的项自身）：
                    //   a) TOP_MIXED 模式（项在 container 顶层混排，如分栏拖动）：
                    //      候选**始终**用 OUTER_ITEM_SEL —— 卡片与分栏同等级，
                    //      分栏可以插到任何卡片之间（用户要求）。
                    //   b) 有外层容器：指针移出父容器范围 → 占位块提升到外层；
                    //      指针回到父容器范围 → 降级回栏内。
                    //   c) 其余：候选限定在真实父容器内（普通栏内排序）。
                    //
                    // ★★ 滞回带（hysteresis）24px：进出外层用**不同的边界** ——
                    //   走出去要越出边界 24px，走回来要缩进边界内 24px。
                    //   没有滞回时指针在分栏边缘来回 1px 都会翻转 activeParent，
                    //   占位块每帧在两个容器间搬家 + FLIP 全量重测 —— 这就是
                    //   "经过分栏时明显变卡"的根因（每帧两次强制布局）。
                    const HOVER_BAND = 24;
                    if (!drag.prCache) drag.prCache = parent.getBoundingClientRect();
                    const pr = drag.prCache;
                    let useOuter;
                    if (drag.lastParent === outer) {
                        // 已在外层：只有缩回父容器边界内 24px 才回去
                        useOuter = !(e.clientY > pr.top + HOVER_BAND && e.clientY < pr.bottom - HOVER_BAND);
                    } else {
                        // 在父容器内：越出边界 24px 才出去
                        useOuter = e.clientY < pr.top - HOVER_BAND || e.clientY > pr.bottom + HOVER_BAND;
                    }
                    const activeParent = (useOuter && outer) ? outer : parent;
                    const sel = (activeParent === outer && OUTER_ITEM_SEL) ? OUTER_ITEM_SEL : ITEM_SEL;

                    // 占位块按指针纵向位置落位
                    let phNext = null;
                    for (const c of activeParent.querySelectorAll(sel)) {
                        if (c === card || c.contains(card)) continue;   // 跳过拖动中的项自身
                        const r = c.getBoundingClientRect();
                        if (e.clientY < r.top + r.height / 2) { phNext = c; break; }
                    }
                    if (phNext === drag.lastBefore && activeParent === drag.lastParent) return;
                    drag.lastBefore = phNext;
                    drag.lastParent = activeParent;
                    // 跨容器搬家：旧容器也要 FLIP 补偿（否则它里面的项瞬移）
                    const oldParent = drag.ph.parentElement;
                    flip(activeParent, () => {
                        if (phNext) activeParent.insertBefore(drag.ph, phNext);
                        else activeParent.appendChild(drag.ph);
                    });
                    if (oldParent !== activeParent && oldParent !== drag.ph.parentElement) {
                        flip(oldParent, () => { /* 占位块已搬走 —— 只补偿留在旧容器的项 */ });
                    }
                };

                /** 写内联 transform：位移 +（可选）抬起效果 */
                function setTf(dx, dy, lifted) {
                    const c = drag ? drag.card : card;
                    // ★ 只用一个很克制的缩放（1.02），**不要 rotate**。
                    //   旋转会让卡片的外框膨胀（630px 宽的卡片高度多出约 7px），
                    //   而 FLIP 是按外框测量位移的 —— 那点膨胀会让其它卡片
                    //   每次换位都多轻微抖一下。桌面图标拖动本来也不旋转，
                    //   "抬起感"靠阴影与不透明度就够了。
                    c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'
                        + (lifted ? ' scale(1.02)' : '');
                }
                const finish = (commit) => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                    document.removeEventListener('pointercancel', onCancel);
                    // ★ 必须带上 capture:true —— removeEventListener 要求
                    //   "捕获标志 + 回调"都对得上才算同一个监听器。
                    //   漏了这个参数就摘不掉：拖拽用鼠标松手结束时（不走 Esc 分支），
                    //   那个 once 监听器会**残留**在 document 上，之后每一次 Escape
                    //   都被它拦掉 —— 用户会发现**插件设置弹窗再也关不上了**。
                    //   （once 只在它真的被触发时才自动摘除，不能指望它兜底。）
                    document.removeEventListener('keydown', onKey, { capture: true });
                    if (!drag) return;
                    const { card: c, ph } = drag;
                    // ★ 占位块此刻可能已被"拖出分栏"搬进外层容器 —— 还原/落位
                    //   都要跟着占位块**现在的**父节点走，不能用固定的 parent。
                    const phParent = ph.parentElement || parent;
                    const restore = () => {
                        c.style.transition = '';
                        c.style.transform = '';
                        c.style.transformOrigin = '';   // 别把抓取点的原点留给卡片常态
                        c.style.left = '';
                        c.style.top = '';
                        c.style.width = '';
                        c.style.height = '';
                        c.classList.remove(DRAGGING_CLASS);
                        // ★ 回到占位块的位置（占位块在哪个容器就插回哪里）
                        phParent.insertBefore(c, ph);
                        ph.remove();
                        document.body.classList.remove('mod-dragging-active');};
                    if (commit) {
                        // ★ 没动过 = 单击手势：报告给调用方（它可能有"点把手"的语义，
                        //   如分栏头的单击切折叠），同时顺序没变，无需 onDone 重排。
                        if (!moved) {
                            restore();
                            if (typeof opts.onTap === 'function') opts.onTap(card);
                            drag = null;
                            return;
                        }
                        // 松手：把卡片平滑"放"到占位块上，落位后再换回文档流。
                        //
                        // ★ 位移是相对 **left/top 基准**算的，不是相对当前位置：
                        //   卡片是 fixed + left/top=抓取时的屏幕位置，内联 transform
                        //   是相对那个基准的偏移。所以目标偏移 =
                        //   占位块位置 − 基准位置。
                        //   （不能拿"当前位置"再叠加 —— getBoundingClientRect 已经
                        //    含了 transform，再加一次就飞过头。）
                        // ★ 不写 scale：让卡片从"抬起的 1.03"自己落回 1.0，
                        //   读起来就是"把图标放下"。
                        const target = ph.getBoundingClientRect();
                        const dx = target.left - rect.left;
                        const dy = target.top - rect.top;
                        c.style.transition = 'transform .18s cubic-bezier(.2,.8,.3,1)';
                        c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
                        setTimeout(() => {
                            restore();
                            if (typeof onDone === 'function') {
                                const ids = [...container.querySelectorAll(ITEM_SEL)].map(idOf);
                                onDone(ids, container);
                            }
                        }, 190);
                    } else {
                        restore();
                    }
                    drag = null;
                };
                const onUp = () => finish(true);
                const onCancel = () => finish(false);
                /**
                 * Esc 取消拖动。
                 *
                 * ★ 为什么要抢在宿主前面：宿主在**弹窗**上也监听 Escape
                 *   （host-slots.js 的插件设置弹窗、app-07-init.js 的各种弹窗），
                 *   一条 Escape 会同时触发两个处理器 —— 用户"想取消拖动"却把整个
                 *   设置弹窗关掉了，拖拽上下文一起丢（实测踩到：Esc 之后卡片测量
                 *   全部落空，因为弹窗已经 hidden）。
                 *
                 * ★ 关键是**捕获阶段**（第三个参数 true）：宿主的监听器挂在
                 *   document 的冒泡阶段，我如果也挂冒泡，会按注册顺序执行 ——
                 *   宿主在打开弹窗时就注册了，一定比我早，我根本拦不住。
                 *   挂捕获阶段则在事件下行途中就先拿到它，此时
                 *   stopImmediatePropagation 能阻止同一节点上的其余监听器，
                 *   stopPropagation 阻止它继续冒泡回 document → 宿主收不到。
                 *   （拖动是一层更内层的临时状态，它先消费这个按键才对。）
                 *
                 * finish(false) 会把这个监听器摘掉，所以下一次 Esc 一切正常。
                 */
                const onKey = (e) => {
                    if (e.key !== 'Escape') return;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    e.stopPropagation();
                    finish(false);
                };

                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
                document.addEventListener('pointercancel', onCancel);
                // ★ 捕获阶段（true）—— 见 onKey 的说明，必须抢在宿主前面消费掉 Escape
                document.addEventListener('keydown', onKey, { once: true, capture: true });
            };
            grip.addEventListener('pointerdown', onDown);
            handlers.push([grip, onDown]);
        });

        return () => { for (const [el, fn] of handlers) el.removeEventListener('pointerdown', fn); };
    }

    // 给设置页（app-06-settings.js）复用同一份实现 —— 插件列表与模型列表的拖拽
    // 本来就是同一件事。
    //
    // ★ 为什么必须共用：分成两份拷贝的结果就是这次踩的坑 —— 一边修了"卡片被弹窗
    //   盖住"、另一边还是坏的；手感也会悄悄分叉（一个只跟纵向、一个跟二维）。
    // ★ 设置页在 mods.js **之前**加载，所以它只能在真正用的时候来取这个全局
    //   （那时 mods.js 早已执行完）。
    window.__elainaBindFlatDragSort = bindFlatDragSort;

    /**
     * 注入（或取回）某个 mod 的样式表，并把它登记成**可撤销贡献**。
     *
     * ★ 为什么"清单声明的 styles"也必须走这里，而不是 loadOne 里直接建 `<link>`：
     *   以前清单里声明的样式建完就不管了 —— 插件**停用后它的 CSS 仍在生效**
     *   （覆盖了宿主样式、藏了某个控件，从界面上完全看不出来是哪个插件干的）。
     *   插件自己调 injectStyle 的那条路也一样纳入作用域。
     *   两条注入路径共用这一段代码，才不会再次分叉成"一条能回收、一条不能"。
     *
     * 用 `disabled` 而不是删节点：重新启用时不必再走一次网络请求。
     */
    function injectStyleLink(manifest, href) {
        const url = String(href || '');
        if (!url) return null;
        // id 由 url 决定 → 清单声明的与插件 injectStyle 的同一份样式会**去重成一条**，
        // 于是"同一个插件同一份 CSS"不会出现两个 link（两个贡献项同时开关也无害）
        const id = 'mod-style-' + manifest.id + '-' + url.replace(/[^\w.-]/g, '_');
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('link');
            el.id = id;
            el.rel = 'stylesheet';
            el.href = url;
            el.setAttribute('data-mod', manifest.id);
            document.head.appendChild(el);
        }
        const link = el;
        addContribution(manifest.id, {
            activate() { link.disabled = false; },
            deactivate() { link.disabled = true; },
            dispose() { try { link.remove(); } catch (e) { /* 忽略 */ } },
        });
        return el;
    }

    /**
     * 宿主把一个插槽挖出来（mod 只能往**已存在**的插槽里注册）。
     *
     * 由掌握该处 DOM 的宿主代码调用（`web/js/host-slots.js` 里集中声明），
     * 而不是写在 mod 系统里 —— 插槽的 spec 约定属于"谁挖的谁解释"。
     * 这样 mod 系统本身不需要知道"设置分栏长什么样"。
     *
     * 两种形态：
     *   · **普通插槽**：提供 `mount(spec, ctx)`，mod 注册时挂载一次（设置分栏、顶部按钮…）
     *   · **每项级插槽**：标 `item: true`，不挂载；宿主每渲染一项就调
     *     `ElainaMods.renderItemSlot(name, container, item)` 把 spec 拉出来渲染
     *     （消息行按钮就属于这种 —— 注册时还没有消息可挂）。
     *     可选提供 `cleanup(modId)`（停用时立刻摘掉已画的元素）与 `refresh(modId)`（启用时补画）。
     */
    function defineSlot(name, impl) {
        const n = String(name || '');
        if (!n) throw new Error('插槽名不能为空');
        if (!impl) throw new Error('插槽 ' + n + ' 缺少实现');
        if (impl.item === true) {
            if (typeof impl.cleanup !== 'function') {
                // 没有 cleanup 的话"停用"就只是停止再画新的，**已经画在界面上的会留着** ——
                // 那正是本项目反复修的一类 bug，所以在挖插槽这一步就要求提供。
                throw new Error('每项级插槽 ' + n + ' 必须提供 cleanup(modId)，否则停用后界面上的残留摘不掉');
            }
        } else if (typeof impl.mount !== 'function') {
            throw new Error('插槽 ' + n + ' 必须提供 mount(spec)');
        }
        slotImpls.set(n, impl);
        return () => slotImpls.delete(n);
    }

    /** 供宿主取全部插件的提示词片段（拼进 system） */
    function collectPromptHints() {
        const out = [];
        for (const [id, text] of promptHints) {
            if (text) out.push(text);
        }
        return out;
    }

    // ========================================================================
    //  清单发现与排序
    // ========================================================================

    /**
     * 发现所有插件。
     *
     * 为什么需要一份"清单索引"：浏览器里没法列目录。所以约定
     * `mods/index.json` 是插件清单数组（构建/手工维护），
     * 加载器读它。这样"加一个 mod"= 加目录 + 往 index.json 加一行。
     */
    async function discover() {
        try {
            const res = await fetch(MOD_ROOT + 'index.json', { cache: 'no-store' });
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

    /** 拓扑排序：尊重 manifest.after；检测环形依赖 */
    function sortByDependency(manifests) {
        const byId = new Map(manifests.map((m) => [m.id, m]));
        const out = [];
        const mark = new Map();   // id -> 1=访问中 2=已完成

        function visit(m, chain) {
            const st = mark.get(m.id);
            if (st === 2) return;
            if (st === 1) {
                throw new Error('插件依赖成环：' + chain.concat(m.id).join(' → '));
            }
            mark.set(m.id, 1);
            for (const dep of (Array.isArray(m.after) ? m.after : [])) {
                const d = byId.get(dep);
                if (d) visit(d, chain.concat(m.id));
            }
            mark.set(m.id, 2);
            out.push(m);
        }

        for (const m of manifests) visit(m, []);
        return out;
    }

    // ========================================================================
    //  加载
    // ========================================================================

    /** 注入一个 <script>，resolve 于 load / reject 于 error */
    function injectScript(src) {
        if (loadedScripts.has(src)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.setAttribute('data-mod-script', '1');
            el.onload = () => { loadedScripts.add(src); resolve(); };
            el.onerror = () => reject(new Error('脚本加载失败：' + src));
            document.head.appendChild(el);
        });
    }

    /**
     * 加载并初始化单个插件。
     *
     * 失败隔离的核心：**整个函数体都包在 try/catch 里**。
     * 插件是用户可自行增删的东西，质量不可控 —— 一个坏 mod 绝不能
     * 让整个白屏（那会让用户连"去设置里关掉它"都做不到）。
     *
     * @param {object} manifest 清单条目
     * @param {Array<{id:string,reason:string,fixable:boolean}>} [missingDeps]
     *        不可用的前置插件（非空时**拒绝加载**）
     */
    async function loadOne(manifest, missingDeps = []) {
        // ★ 幂等：已经就绪的插件**不要重跑工厂**（2026-09 修）。
        //
        //   为什么必须有这道闸：loadAll() 会被调用多次 —— 页面启动一次，
        //   多设备同步收到"插件开关变了"时还会再来一次（app-07-init 里那条）。
        //   没有闸门时第二次 loadOne 会照跑工厂，而 <script> 已经注入过、
        //   factory 还在 pendingRegistrations 里 —— 于是 galgame / pet 的
        //   工厂被执行第二遍：**两份界面、两组定时器、双击一样的响应**。
        //
        //   "已经就绪"意味着初始化已经发生过。要重新出现只能靠
        //   activateContributions()（宿主侧注册项）或 mod 自己的 setEnabled，
        //   都不是重跑工厂。
        const prev = registry.get(manifest.id);
        if (prev && prev.state === 'ready') return prev;

        const entry = { manifest, state: 'pending', error: null, api: null };
        registry.set(manifest.id, entry);

        // ★ 前置插件不可用 → **拒绝加载**，并给出可读原因。
        //
        // 旧行为只是 console.error 一句警告、然后照样加载。那很糟：
        // 插件会在"依赖不在"的前提下跑起来 —— 例如 galgame 拿不到
        // window.ElainaAvatar，于是它自己回落成"没有立绘"，用户看到的是
        // "界面能打开但没有人物"，而设置里那个"缺依赖"角标很容易被忽略。
        // 更麻烦的是**加载顺序失去保证**：依赖可能排在它后面才加载。
        //
        // 实测踩到的真实日志（旧实现只看"装没装"，漏了"启用没启用"）：
        //     [Mod] 加载完成：elaina-avatar=disabled galgame=ready pet=ready
        // 前置被禁用了，两个依赖方却照样 ready —— 拿不到立绘而系统认为正常。
        // 现在"未启用"也算不可用，并按原因给出**可执行的下一步**。
        if (missingDeps.length) {
            entry.state = 'blocked';
            entry.missingDeps = missingDeps;
            // 不可用时把它之前的注册项收起来：一个"被拒绝加载"的插件
            // 不该继续占着界面入口或往提示词里加东西
            deactivateContributions(manifest.id);
            // 每条原因一句话，人（和 AI）都能读懂该做什么
            const detail = missingDeps.map((d) => {
                const what = '前置插件「' + d.id + '」' + d.reason;
                if (d.reason === '未启用') {
                    return what + ' —— 到「设置 → 插件」里把它的开关打开';
                }
                if (d.reason === '未安装') {
                    return what + ' —— 需要先安装它（见 Releases 的扩展包）';
                }
                if (d.reason === '插件系统总开关已关闭') {
                    return what + ' —— 到「设置 → 插件」打开「启用插件系统」并刷新页面';
                }
                return what + ' —— 请先修好那个插件';
            }).join('；');
            entry.error = '已拒绝加载：' + detail
                + '。（缺了前置就启动，功能只会是残缺的，所以这里直接拒绝而不是带病运行。）';
            console.error('[Mod:' + manifest.id + '] ' + entry.error);
            return entry;
        }

        if (!modsGloballyEnabled()) {
            entry.state = 'disabled';
            deactivateContributions(manifest.id);
            return entry;
        }
        if (!isModEnabled(manifest.id, manifest)) {
            entry.state = 'disabled';
            deactivateContributions(manifest.id);
            return entry;
        }

        try {
            // ① 样式（可选）
            //    路径由 modDir() 统一给出（已 URL 编码），插件自己不拼路径。
            //    ★ 走 injectStyleLink 而不是直接建 <link>：清单声明的样式也必须
            //      纳入可撤销作用域，否则插件停用后它的 CSS 还在生效（既有 bug）。
            for (const css of (Array.isArray(manifest.styles) ? manifest.styles : [])) {
                const href = css.startsWith('/') ? css : MOD_ROOT + modDir(manifest) + '/' + css;
                injectStyleLink(manifest, href);
            }

            // ② 入口脚本
            //
            // ★ 注入前记下"当前在加载哪个目录"：插件脚本执行时会调
            //   register(name, …)，系统据此知道**这个注册名来自哪个目录**。
            //   这是"路径由插件系统查"的关键一环 —— 见 regByDir 的说明。
            //
            // ★ 多脚本：manifest.scripts 列出的文件**先**注入，entry **最后**注入。
            //
            //   为什么 entry 放最后（2026-10 定这个语义时踩过）：
            //   一个插件拆成"实现主体 / 设置面板 / 注册装配"几个文件时，
            //   装配那个文件（entry）要**调用**其它文件定义的东西 ——
            //   所以它必须在最后执行。反过来（entry 先）会让装配时
            //   `window.Live2DCall` 还是 undefined，表现为"插件是 ready、
            //   但界面什么都没出现"，而控制台一声不响。
            //
            //   顺序是**声明顺序**，且全部注入完成后才调 factory。
            const entrySrc = manifest.entry || 'index.js';
            const extra = Array.isArray(manifest.scripts) ? manifest.scripts : [];
            const deps = extra.filter((s) => typeof s === 'string' && s && s !== entrySrc);
            const allScripts = [...deps, entrySrc];
            loadingDir = manifest.dir || manifest.id;
            try {
                for (const one of allScripts) {
                    const src = one.startsWith('/') ? one : MOD_ROOT + modDir(manifest) + '/' + one;
                    await injectScript(src);
                }
            } finally {
                loadingDir = null;
            }

            // ③ 初始化：找这个插件注册的 factory。
            //
            // ★ 先按 manifest.id 找（常规情况），找不到就按**本目录注册了什么**找。
            //   为什么需要第二步：用户改了目录名、而 manifest 又没写 id 时，
            //   manifest.id 会等于目录名（如 pet-renamed），而脚本里注册的
            //   仍是 'pet' —— 只按 manifest.id 查会**永远查不到**，
            //   插件表现为"已加载但从不初始化"（界面毫无反应）。
            //   按目录反查就能把这条链接上，目录怎么改都不影响。
            let factory = pendingRegistrations.get(manifest.id);
            let regName = manifest.id;
            if (typeof factory !== 'function') {
                const byDir = regByDir.get(manifest.dir || manifest.id);
                if (byDir && typeof pendingRegistrations.get(byDir) === 'function') {
                    factory = pendingRegistrations.get(byDir);
                    regName = byDir;
                    console.warn('[Mod:' + manifest.id + '] 清单 id 与注册名不一致（'
                        + manifest.id + ' ≠ ' + byDir + '），已按注册名加载'
                        + '（建议在 manifest.json 里显式写 "id": "' + byDir + '"）');
                }
            }

            if (typeof factory === 'function') {
                entry.regName = regName;
                entry.api = await factory(createHostApi(manifest, regName));
            } else if (manifest.autoInit !== false) {
                // 没有 register 的插件：脚本加载成功即算可用（有些 mod 自带启动逻辑）
                entry.api = null;
            }
            entry.state = 'ready';
        } catch (err) {
            entry.state = 'error';
            entry.error = String((err && err.message) || err);
            console.error('[Mod:' + manifest.id + '] 加载失败（已隔离，不影响其他插件）', err);
        }
        return entry;
    }

    /** 插件脚本通过它注册初始化函数（在脚本执行时调用） */
    const pendingRegistrations = new Map();

    /**
     * 注册名 ↔ 目录 的双向映射（★ 插件系统自己维护，插件不参与算路径）。
     *
     * ── 为什么需要它（2026-09 踩到的真 bug）──────────────────────────────
     *
     * 插件的**身份**其实有两个来源：
     *   · 服务端清单给的 `manifest.id`（来自 manifest.json，或回落到目录名）
     *   · 插件脚本里 `register('pet', …)` 声明的**注册名**
     *
     * 正常情况两者相同。但用户**改了插件目录名**之后就可能不同：
     * 目录叫 `pet-renamed`、manifest 又没写 id → 清单 id 是 `pet-renamed`，
     * 而脚本注册的是 `pet`。旧实现直接 `pendingRegistrations.get(manifest.id)`
     * → **查不到 factory → 插件永远不初始化**（清单里显示"已加载"，
     * 界面却毫无反应，是最难排查的那种）。
     *
     * 修法就是"让插件系统来做查找"：脚本是按目录注入的，所以系统**知道**
     * 某个 register() 调用来自哪个目录。于是记录 dir → 注册名，
     * loadOne 先按 manifest.id 找，找不到就按"我这个目录注册了什么"找。
     * 这样**目录怎么改都不影响插件被正确初始化**。
     */
    const regByDir = new Map();     // dir（磁盘目录名）→ 注册名
    const dirByReg = new Map();     // 注册名 → dir

    /** 当前正在注入的插件目录（register() 据此知道自己来自哪个目录） */
    let loadingDir = null;

    /**
     * 找出每个插件**不可用的前置插件**，并说明原因。
     *
     * ── 为什么要单独做这件事 ─────────────────────────────────────────────
     *
     * `sortByDependency` 里对找不到的依赖是 `if (d) visit(...)` —— **静默跳过**。
     * 这在单仓库时代问题不大（一起发布），但 mod 拆到独立仓库分发后，
     * "只装 galgame 不装 elaina-avatar"会变成常态。那时的表现是
     * "Galgame 打开了但没有立绘"，控制台一声不响 —— 最难排查的那类问题。
     *
     * ── ★ 关键修正：装了但**没启用**，等于不可用（2026-09 实测踩到）──────
     *
     * 旧实现只判断"清单里有没有这个 id"，于是出现了这个真实日志：
     *
     *     [Mod] 加载完成：elaina-avatar=disabled galgame=ready pet=ready
     *
     * 前置被**禁用**了，依赖它的两个插件却照样 ready —— 它们拿不到立绘，
     * 而系统认为一切正常。所以判定必须同时看**启用状态**：
     *   · 前置不在清单里           → 原因：未安装
     *   · 前置在清单里但被禁用      → 原因：未启用（用户可以在设置里打开）
     *   · 前置自己被拦（缺它自己的前置）→ 原因：前置本身不可用（级联）
     * 三种情况给三种不同的提示，用户才知道该做什么。
     *
     * ★ 身份判定要同时认**清单 id**、**目录名**、**注册名**：
     *   用户改了插件目录名、而 manifest 没写 id 时，清单 id 会等于目录名
     *   （如 `pet-renamed`），而依赖方 after 里写的仍是注册名 `pet`。
     *   只按清单 id 比会**误报"缺依赖"**，把好好的插件拦下来。
     *
     * @returns {Map<string, Array<{id:string, reason:string, fixable:boolean}>>}
     */
    function findMissingDeps(manifests) {
        // 建三张索引：清单 id / 目录名 / 注册名 → 清单条目
        const byKey = new Map();
        for (const m of manifests) {
            if (m.id) byKey.set(m.id, m);
            if (m.dir && !byKey.has(m.dir)) byKey.set(m.dir, m);
            const rn = m.dir ? regByDir.get(m.dir) : null;
            if (rn && !byKey.has(rn)) byKey.set(rn, m);
        }

        // 第一轮：只算"未安装 / 未启用"（不涉及级联）
        const missing = new Map();
        for (const m of manifests) {
            const deps = Array.isArray(m.after) ? m.after : [];
            const lack = [];
            for (const d of deps) {
                const target = byKey.get(d);
                if (!target) {
                    lack.push({ id: d, reason: '未安装', fixable: false });
                    continue;
                }
                // 前置存在但被禁用（或全局插件系统关着）→ 同样不可用
                if (!modsGloballyEnabled()) {
                    lack.push({ id: d, reason: '插件系统总开关已关闭', fixable: true });
                } else if (!isModEnabled(target.id, target)) {
                    lack.push({ id: d, reason: '未启用', fixable: true });
                }
            }
            if (lack.length) missing.set(m.id, lack);
        }

        // 第二轮：级联 —— 前置自己也被拦时，标成"前置本身不可用"。
        //   一遍不够（A 依赖 B、B 依赖 C），这里迭代到稳定，最多 N 轮。
        //   不这样做的后果：A 会显示"前置 B 已就绪"，而 B 其实也没起来。
        for (let round = 0; round < manifests.length; round++) {
            let changed = false;
            for (const m of manifests) {
                const lack = missing.get(m.id);
                if (!lack) continue;
                for (const item of lack) {
                    if (item.reason !== '未安装' && item.reason !== '未启用') continue;
                    const depBlocked = missing.has(item.id);
                    if (depBlocked) {
                        item.reason = '前置本身不可用（它自己也缺前置）';
                        item.fixable = false;
                        changed = true;
                    }
                }
            }
            if (!changed) break;
        }
        return missing;
    }

    /** 加载全部插件 */
    async function loadAll() {
        // ★ 先打一条总览日志（console.log，会被前端日志转发带到启动窗口）。
        //
        // 为什么必须有：插件的加载是"看不见的过程"，而"没有 mod 日志"这个现象
        // 既可能是**成功**（旧实现里成功日志走 console.log、不被转发），
        // 也可能是 **mods.js 压根没跑 / 清单读不到** —— 两者在启动窗口里
        // 长得一模一样，无法据此排查（实测就卡在这里）。
        // 现在无论成败，先留一条"我是谁、我开始加载了、清单里有几个"的痕迹。
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

        // ★ 先查不可用的前置插件 —— 这类插件会被**拒绝加载**（不是警告后照跑）。
        //   判定同时看"装没装"与"启用没启用"，并认清单 id / 目录名 / 注册名三种键。
        const missing = findMissingDeps(manifests);
        for (const [id, lack] of missing) {
            const D1 = window.ElainaDiag;
            const detail = lack.map((d) => '「' + d.id + '」' + d.reason).join('、');
            console.error('[Mod] ' + (D1 ? D1.problem({
                what: '插件「' + id + '」的前置插件不可用，它不会被加载',
                where: 'web/mods/',
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
            const entry = await loadOne(m, lack);
            // 不可用的前置也记到条目上，供设置界面显示（loadOne 已在 error 里写了原因）
            if (lack.length) entry.missingDeps = lack;
            results.push(entry);
        }

        logLoadSummary(results);
        return results;
    }

    /** 插件状态的**中文说明** —— 日志与设置界面共用一份，避免两处说法不一致 */
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
     * ★ 为什么要把这段单独写好（2026-09 重做）：
     *   上一版打的是 `elaina-avatar=disabled galgame=ready pet=ready` ——
     *   那是**机器视角的键值对**：换个不知道本项目的 AI（或用户本人）
     *   看到这行，既不知道 `disabled` 是好是坏，也看不出
     *   "前置没启用、依赖它的却起来了"这个关键矛盾。
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
            // ---- 回落路径：没有诊断模块时保持旧格式，至少不丢信息 ----
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

        // ---- ① 结论行 ----
        console.log('[Mod] ' + D.checklist([{
            state: broken.length ? 'bad' : 'ok',
            label: '插件加载完成：共 ' + total + ' 个，可用 ' + ready.length + ' 个'
                + (disabled.length ? '，未启用 ' + disabled.length + ' 个' : '')
                + (broken.length ? '，有问题 ' + broken.length + ' 个' : ''),
            hint: total ? '插件由 web/mods/ 下的扩展包提供，可在「设置 → 插件」里开关。' : undefined,
        }], '插件系统'));

        // ---- ② 可用的 ----
        if (ready.length) {
            console.log('[Mod] ' + D.checklist([
                { state: 'ok', label: '正常工作：' + ready.map(nm).join('、') },
            ]));
        }

        // ---- ③ 未启用的：说明这是**正常状态**，并给开启方法 ----
        //   为什么单独一段：默认关闭是设计如此，不该和故障混在一起报警 ——
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

        // ---- ④ 有问题的：逐条三段式（发生了什么 / 为什么 / 怎么办）----
        for (const e of broken) {
            const label = STATE_LABEL[e.state] || e.state;
            const dep = (e.missingDeps || []).map((d) => d.id + '（' + d.reason + '）').join('、');
            console.error('[Mod] ' + D.problem({
                what: '插件「' + nm(e) + '」' + label,
                where: 'web/mods/' + (e.manifest.dir || e.manifest.id) + '/',
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
            // ---- ⑤ 全部正常时明确说一句 ----
            console.log('[Mod] ' + D.summary([], {
                notes: disabled.length
                    ? ['上面列出的「未启用」是正常状态，需要时到「设置 → 插件」开启即可。']
                    : ['所有插件都已正常工作。'],
            }));
        }
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
     * ★ 停用是"两步"（2026-09 补齐）：
     *   ① mod 自己的 setEnabled(false) —— 收起它自建的界面、停掉它的定时器
     *   ② deactivateContributions()      —— 收回它经宿主注册的东西
     *      （插槽入口、注入的样式、system 提示词、事件订阅）
     *   只有 ① 的话，host.slot 注册的设置分栏/顶部按钮、injectStyle 的样式、
     *   setPromptHint 的提示词都会**留在原地** —— 表现为"关掉了但还在起作用"。
     *
     * ★ 已注入的脚本没法"卸载"，但停用后它不显示、不注册、不响应事件，
     *   效果上等价。真要彻底卸载得整页刷新（或删插件目录）。
     */
    async function setEnabled(id, on) {
        const entry = registry.get(id);
        if (!entry) return false;
        setModEnabled(id, on);

        if (on) {
            // 还没加载过 → 现场加载（这样开关是"立即生效"，不需要刷新页面）
            //
            // 判据用"入口脚本是否已注入"而不是 api 是否为空：
            //   · 有些 mod 没有 register()，加载完 api 就是 null —— 用 api 判会误判成"没加载过"
            //   · 重复启用时不该重复注入脚本（<script> 会被再插一遍，mod 的初始化会跑两次）
            const entrySrc = entry.manifest.entry || 'index.js';
            // 与 loadOne 保持一致：走 modDir()，否则"已注入过没有"的判断会看错路径，
            // 导致重复注入脚本（mod 的初始化跑两次）。
            // ★ 多脚本（manifest.scripts）时，以**最后一个**为判据 —— 它是最后注入的，
            //   存在就说明这一组都注入过了（loadOne 是按顺序 await 的）。
            const extra = Array.isArray(entry.manifest.scripts) ? entry.manifest.scripts : [];
            const lastSrc = extra.length ? extra[extra.length - 1] : entrySrc;
            const src = lastSrc.startsWith('/') ? lastSrc : MOD_ROOT + modDir(entry.manifest) + '/' + lastSrc;
            const neverLoaded = !loadedScripts.has(src);
            if (neverLoaded) {
                try {
                    await loadOne(entry.manifest);
                } catch (e) {
                    // loadOne 内部已经做了失败隔离，这里兜住它自己抛出的意外
                    const fresh = registry.get(id);
                    if (fresh) { fresh.state = 'error'; fresh.error = String((e && e.message) || e); }
                }
            } else {
                // 已经初始化过：用保留的 spec 把宿主侧注册项挂回去，**不重跑工厂**
                // （工厂跑第二遍会得到两份界面/两组定时器，见 loadOne 开头的闸门）
                activateContributions(id);
                if (typeof entry.api?.setEnabled === 'function') {
                    try { entry.api.setEnabled(on); } catch (e) { /* mod 自己的开关失败不该影响宿主 */ }
                }
            }
            // 注意：loadOne 会往 registry 里塞一个**新** entry 对象，
            // 所以这里必须重新取一次，不能继续用上面那个旧引用（否则读到过期的 state）
            const fresh = registry.get(id);
            if (fresh && fresh.state !== 'error') fresh.state = 'ready';
        } else {
            try {
                if (typeof entry.api?.setEnabled === 'function') entry.api.setEnabled(false);
            } catch (e) { /* 忽略 */ }
            deactivateContributions(id);
            entry.state = 'disabled';
        }

        emit('mod-changed', { id, enabled: on });
        return true;
    }

    function emit(event, detail) {
        const set = bus.get(event);
        if (!set) return;
        for (const h of set) {
            try { h(detail); } catch (e) { /* 忽略 */ }
        }
    }

    // ========================================================================
    //  对外接口
    // ========================================================================

    window.ElainaMods = {
        /**
         * 插件脚本用它注册初始化函数：ElainaMods.register('galgame', (host) => ({...}))
         *
         * ★ 注册名就是插件的**权威身份**（依赖匹配、资源查找都以它为准）。
         *   这里同时记下"它来自哪个目录"（loadingDir）—— 这样即使目录名、
         *   manifest.id、注册名三者不一致，插件系统也能靠这张表把它们对上。
         *   见 regByDir 的说明。
         */
        register(id, factory) {
            const name = String(id);
            pendingRegistrations.set(name, factory);
            if (loadingDir) {
                regByDir.set(loadingDir, name);
                dirByReg.set(name, loadingDir);
            }
        },
        /**
         * 按注册名/清单 id/目录名中的**任意一个**查插件。
         *
         * 这是"路径与身份由插件系统统一管理"的入口：插件之间互相查找
         * （例如 galgame 找 elaina-avatar）不该靠拼字符串，而该问系统。
         * 三个键都试一遍，用户改了目录名也照样查得到。
         *
         * @returns {{id, dir, regName, state, entry}|null}
         */
        find(key) {
            const k = String(key || '');
            if (!k) return null;
            // ① 直接命中清单 id
            let entry = registry.get(k);
            // ② 命中注册名 → 反查它的目录 → 再取条目
            if (!entry) {
                const dir = dirByReg.get(k);
                if (dir) entry = [...registry.values()].find((e) => (e.manifest.dir || e.manifest.id) === dir);
            }
            // ③ 命中目录名
            if (!entry) entry = [...registry.values()].find((e) => (e.manifest.dir || e.manifest.id) === k);
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
            return MOD_ROOT + enc + '/' + r;
        },
        loadAll,
        /** 列出已发现的插件及其状态（供设置界面渲染） */
        list() {
            return [...registry.values()].map((e) => ({
                id: e.manifest.id,
                // dir / regName 都暴露出去：设置界面与宿主都要用真实目录，
                // 而不是拿 id 去猜（三者可能不一致，见 modDir 说明）
                dir: e.manifest.dir || e.manifest.id,
                regName: e.regName || e.manifest.id,
                name: e.manifest.name || e.manifest.id,
                version: e.manifest.version || '',
                description: e.manifest.description || '',
                state: e.state,
                error: e.error,
                enabled: isModEnabled(e.manifest.id, e.manifest),
                // hidden：公共依赖类插件（不提供界面，被其他插件共用）。
                // 设置界面用它加一句用途说明 —— 但**仍然给开关**：
                // 以前 hidden 的插件不给开关，一旦被禁用就无法从界面恢复，
                // 依赖它的插件会连带失效而用户找不到地方修（实测踩过）。
                hidden: e.manifest.hidden === true,
                // 不可用的前置插件（未安装 / 未启用 / 级联不可用）——
                // 这类插件会被**拒绝加载**，设置界面据此显示原因与下一步
                missingDeps: e.missingDeps || [],
            }));
        },
        setEnabled,
        /** 删插件时调用：清掉启用状态与已加载记录（避免重装后被自动启用） */
        forget: forgetMod,
        isEnabled: (id) => {
            const e = registry.get(id);
            return e ? isModEnabled(id, e.manifest) : false;
        },
        /** 全局开关：关掉后所有插件都不加载（需要刷新页面生效） */
        isGloballyEnabled: modsGloballyEnabled,
        setGloballyEnabled(on) { setModsGloballyEnabled(on); },

        // ---- 宿主插槽（由掌握该处 DOM 的宿主代码调用）----
        /**
         * 挖一个插槽出来，之后 mod 就能往这个名字里注册。
         *
         * 为什么由宿主调用而不是写在 mod 系统里：插槽的 spec 约定
         * （例如 settings.tabs 要 label + render）属于"谁挖的谁解释"。
         * mod 系统只负责归属、去重与生命周期，不需要长着每种扩展点的知识。
         *
         * 调用时机：宿主脚本的**顶层**（在 mod 加载之前）。mod 系统读清单是
         * 异步的，所以只要插槽在顶层挖好，一定早于任何 mod 注册。
         *
         * @returns {Function} 撤掉这个插槽（测试与热重载用）
         */
        defineSlot,

        /**
         * 宿主渲染「每一项都要装饰」的位置时用它（每项级插槽）。
         * 例：每条消息渲染完，宿主把消息行的容器交给注册过 chat.message.actions 的 mod。
         */
        renderItemSlot,
        /** 宿主用它取全部插件的 system 提示词片段 */
        collectPromptHints,
        /** 宿主用它广播事件给插件（如"AI 回复完成"、语音音量） */
        emit,
        on(event, handler) {
            if (!bus.has(event)) bus.set(event, new Set());
            bus.get(event).add(handler);
            return () => bus.get(event).delete(handler);
        },
        /**
         * 某个事件上有没有订阅者。
         *
         * 宿主用它决定"值不值得算"：例如 TTS 的音量分析要跑
         * requestAnimationFrame 循环，没人听的时候就不该白跑。
         * 这也是"宿主 → mod 单向推送"取代直接调用的关键一步（见 8.45）。
         */
        hasListeners(event) {
            const set = bus.get(event);
            if (!set) return false;
            // 停用的 mod 的订阅会被摘掉，所以这里看到的就是"真正在听的人"
            for (const h of set) { if (typeof h === 'function') return true; }
            return false;
        },

        // ---- 注册项的生命周期（一般由 setEnabled / forget 自动调用）----
        /** 宿主插槽的名字清单（诊断与 mod 自查用） */
        slotNames: () => [...slotImpls.keys()],
        _disposeContributions: disposeContributions,
        _registry: registry,
    };

    // 页面就绪后自动加载（宿主也可以显式调 loadAll）
    function boot() {
        loadAll().catch((e) => console.error('[Plugin] 加载流程异常', e));
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
