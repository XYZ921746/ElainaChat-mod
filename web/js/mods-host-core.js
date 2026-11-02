/* ============================================================================
 * 插件系统 —— core host API
 *
 * 从 mods.js 拆出：core 组永远下发的基础能力（存储 / 插槽 / 事件 / 语音 / 提示词等）。
 * 依赖由 mods.js 的 getHostCore() 注入，保持经典脚本的加载语义不变。
 * ========================================================================== */
(function () {
    'use strict';

    window.ElainaModsHostCore = function (deps) {
        const {
            host, resolveModAsset, modDir, getModRoot, registerService,
            openModSettings, hasModSettings, createModStorage, registerSlot, slotImpls,
            injectStyleLink, promptHintText, promptHints, ensurePromptHintContribution,
            guardModAsync, bus, isAppReady, addContribution, dispatch,
            HOST_CAPABILITIES, guardMod,
        } = deps || {};

    function coreHostApi({ manifest, name, log, groups, lifecycle }) {
        return {
            id: name,
            manifestId: manifest.id,
            /** 插件自己的版本（历史字段，保留兼容；新代码请用 pluginVersion） */
            version: manifest.version || '0.0.0',
            /** 插件自己的版本（与 hostVersion 分开，避免把两者混用） */
            pluginVersion: manifest.version || '0.0.0',
            /** 宿主契约版本（core.js 的 ElainaHost.version），插件据此做能力判断 */
            hostVersion: String(host().version || ''),
            /**
             * 宿主停用/卸载这个插件时触发。长任务（轮询、下载）应监听它并退出；
             * 用户只是临时关掉再打开时**不会**触发（同一个 api 要能继续用）。
             */
            signal: lifecycle ? lifecycle.signal : undefined,

            /**
             * 注册一个插件服务，供宿主或其它插件按名字取用。
             * 返回取消函数；停用/卸载时宿主会自动摘掉（不必手动调）。
             */
            service(serviceName, api) {
                return registerService(manifest.id, serviceName, api);
            },

            /**
             * 取本插件资源的 URL 基址（结尾带 /）。
             *
             * 必须用它而不是自己拼 '/mods/<名字>/…'：插件**声明的 id** 与它**实际被安装成**的目录名
             *   可能不一致（曾把带版本号的 zip 名当目录名，装出 elaina-avatar-1.0.0/，写死的 URL 全部 404）。
             * 这里用的是磁盘上真实的 manifest.dir。
             *
             * 典型用法：host.assetUrl('img/p_calm.png') → '/mods/elaina-avatar/img/p_calm.png'
             */
            assetUrl(rel) {
                const url = resolveModAsset(manifest, rel, 'assetUrl');
                return url == null ? '' : url;
            },
            /** 本插件资源目录的 URL（结尾带 /），供需要自行拼路径的场合 */
            assetBase() { return getModRoot() + modDir(manifest) + '/'; },

            /**
             * 按**注册名 / 清单 id / 目录名**中的任意一个查找插件。
             *
             * 插件之间互相依赖时（galgame 要用 elaina-avatar 的立绘）自己拼路径是脆的：
             *   用户改了目录名、或清单 id 与注册名不一致，路径就错了。交给系统查表才稳。
             *
             *   const av = host.require('elaina-avatar');
             *   if (!av.ok) { host.error(av.reason); return; }
             *   const url = av.url('img/p_calm.png');
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
                    const targetManifest = (found.entry && found.entry.manifest) || { id: found.id, dir };
                    const base = getModRoot() + dir.split('/').map(encodeURIComponent).join('/') + '/';
                    return {
                        ok: true,
                        id: found.id,
                        dir,
                        regName: found.regName,
                        api: found.entry ? found.entry.api : null,
                        /** 取该插件的资源 URL（路径由系统按真实目录算，越界/外链一律拒绝） */
                        url: (rel) => {
                            const url = resolveModAsset(targetManifest, rel, 'require().url');
                            return url == null ? '' : url;
                        },
                        base: () => base,
                    };
                } catch (e) {
                    return { ok: false, reason: '查找插件「' + key + '」时出错：' + (e && e.message || e) };
                }
            },

            log: (...a) => log('log', ...a),
            warn: (...a) => log('warn', ...a),
            error: (...a) => log('error', ...a),

            /** 取当前会话；没有则 null */
            getConversation() {
                const st = host().state;
                if (!st) return null;
                const list = st.conversations || [];
                return list.find((c) => c.id === st.currentConversationId) || list[0] || null;
            },
            /** 取会话里的消息数组（引用，插件只读遍历） */
            getMessages() {
                const c = this.getConversation();
                return (c && Array.isArray(c.messages)) ? c.messages : [];
            },
            /** 当前是否处于某个特殊页面模式（便签/日记），插件据此决定要不要显示 */
            getUiMode() {
                const st = host().state;
                return { notes: !!(st && st.notesMode), diary: !!(st && st.diaryMode) };
            },

            /**
             * 以用户身份发一条消息。复用宿主的 handleUserInput，保证与主输入框完全同一条链路
             * （记忆、续跑、停止、语音都自动生效）。
             *
             * 必须自己构造消息**对象**：handleUserInput 签名是 `(message, conversation)`，内部读
             *   `message.text` / `message.id`；传字符串会得到 `message.text === undefined`，
             *   发出去的是**空消息**（role=user 的内容长度 0，模型什么都看不到）。
             *   主输入框那条路也是 id + role + text + timestamp 再 push 进 conversation.messages。
             */
            sendUserMessage(text) {
                try {
                    const msg = String(text || '').trim();
                    if (!msg) return false;
                    const H = host();
                    const c = this.getConversation();
                    if (!c || typeof H.sendUserMessage !== 'function' || typeof H.newId !== 'function') return false;

                    const message = {
                        id: H.newId(),
                        role: 'user',
                        text: msg,
                        timestamp: new Date().toLocaleTimeString(),
                    };
                    if (!Array.isArray(c.messages)) c.messages = [];
                    c.messages.push(message);

                    // 给会话起个名（与主输入框走同一个判据）：插件发出的消息
                    //   同样不该让标题停在"新对话"上。
                    try {
                        if (H.refreshAutoConversationTitle && H.refreshAutoConversationTitle(c)) {
                            if (H.renderFolderList) H.renderFolderList();
                            if (H.updateCurrentConversationTitle) H.updateCurrentConversationTitle();
                        }
                    } catch (e) { /* 命名失败不影响发送 */ }
                    // 让界面把新消息画出来（主输入框那条路也会 loadConversation）
                    try {
                        if (H.loadConversation) H.loadConversation(c.id);
                    } catch (e) { /* 忽略 */ }

                    H.sendUserMessage(message, c);
                    return true;
                } catch (e) { log('error', 'sendUserMessage 失败', e); return false; }
            },

            renderText(text) {
                const fn = host().renderMessageText;
                try {
                    if (fn) return fn(text);
                } catch (e) { /* 回落到纯文本 */ }
                // 回落：至少把 HTML 转义掉，避免插件直接把用户内容当 HTML 插进去
                return String(text == null ? '' : text)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            },

            /**
             * 让宿主把一段话念出来。
             *
             * 必须走宿主：用哪个 TTS 供应商、有没有配 Key、要不要日语朗读稿，都是宿主设置里的知识
             *   （见 core.js 的 ElainaHost.speech）。插件再实现一遍等于把"哪家 API、什么鉴权"复制一份。
             * 与"播放这条消息的语音"是同一条链路：会抢占正在播的、走缓存，onEnd 在播完或被取消时都会回调
             *   （插件据此收嘴型 / 恢复状态）。
             *
             * @param {string} text
             * @param {{onStart?:Function,onEnd?:Function,messageId?:string}} [opts]
             * @returns {Promise} 宿主没有语音能力时抛错，调用方自己 catch（别静默吞）
             */
            speak(text, opts) {
                const sp = host().speech;
                if (!sp || typeof sp.speak !== 'function') {
                    throw new Error('宿主没有语音合成能力');
                }
                return sp.speak(text, opts);
            },
            /** 语音是否已配置（供应商 + Key 齐全）。插件据此决定要不要给"朗读"入口 */
            speechConfigured() {
                const sp = host().speech;
                return Boolean(sp && sp.configured);
            },
            /** 停掉正在播放的语音 */
            stopSpeech() {
                const sp = host().speech;
                if (sp && typeof sp.stop === 'function') return sp.stop();
                return Promise.resolve();
            },

            /**
             * 开麦 / 结束并发送。走宿主那颗麦克风按钮的同一个动作（host.dictation），
             * 所以识别结果与主输入框走同一条链路（记忆、续跑、TTS 都自动生效）。
             *
             * @param {'start'|'stop'} [action] 缺省 = 切换（正在听就结束，否则开始）
             */
            dictate(action) {
                const d = host().dictation;
                if (!d) throw new Error('宿主没有语音输入能力');
                if (action === 'start') return d.start();
                if (action === 'stop') return d.stop();
                return d.toggle();
            },
            /** 语音输入是否已配置（供应商 + Key 齐全）。false 时插件不该给入口 */
            dictationConfigured() {
                const d = host().dictation;
                return Boolean(d && d.configured);
            },
            /** 当前语音输入状态：idle / listening / paused / thinking / error */
            dictationState() {
                const d = host().dictation;
                return d ? String(d.state || 'idle') : 'idle';
            },

            /**
             * 弹一个提示框（带标题）。
             *
             * 不让插件直接调 window.showCustomAlert：那是宿主的**内部实现**，宿主改名或改签名就会
             *   悄悄弄坏插件（这正是 host API 收窄清单要防的事）。走这里之后宿主可自由重构。
             * 没有该能力时（老宿主 / 极端环境）回落到原生 alert ——
             *   宁可弹得难看，也不要让插件的重要提示（如"重命名失败"）消失。
             */
            alert(message, title) {
                const text = String(message == null ? '' : message);
                const fn = host().showCustomAlert;
                try {
                    if (fn) return fn(text, title);
                } catch (e) { /* 回落到原生 */ }
                try { window.alert((title ? title + '\n\n' : '') + text); } catch (e) { /* 忽略 */ }
            },

            /** 弹一个确认框，返回 Promise<boolean>。同上：不要直接摸宿主内部。 */
            async confirm(message, title) {
                const text = String(message == null ? '' : message);
                const fn = host().showCustomConfirm;
                try {
                    if (fn) return Boolean(await fn(text, title));
                } catch (e) { /* 回落到原生 */ }
                try { return window.confirm((title ? title + '\n\n' : '') + text); } catch (e) { return false; }
            },

            /**
             * `host.storage`：一块**带插件命名空间**的存储，落宿主 data/。
             *
             *   const s = host.storage;
             *   s.set('seen', '2026-10-17');   // 存（值须 JSON 可序列化）
             *   s.get('seen', '');              // 读；不存在返回第二个参数
             *   s.remove('seen'); s.keys(); s.all();
             *
             * 由宿主提供：插件拿不到宿主的 Store 内部键，而自己写 localStorage 又进不了 data/
             *   （不跨设备、不进备份）。全部插件的存储收在 `elaina_mod_storage` 一个键里按 id 分区。
             * 停用插件**不会**清掉它的数据 —— 那是"关掉功能"，不是"抹掉记录"。
             */
            storage: createModStorage(manifest.id),

            /**
             * 往宿主插槽里注册一项。设置分栏 / 顶部按钮都是插槽实例。
             *
             *   const tab = host.slot('settings.tabs', {
             *       id: 'live2d', label: 'Live2D',
             *       render(container) { … },      // 可被重复调用（重新挂载时会再调）
             *   });
             *
             * 返回句柄 `{ el, dispose() }`。**通常不需要自己 dispose** —— 停用/卸载插件时 mod 系统
             * 会统一回收；只有"插件还在、但这一项不要了"时才手动调。
             *
             * @returns {{el:Element|null, dispose:Function}|null} 注册失败（插槽名写错）返回 null
             */
            slot(name, spec) { return registerSlot(manifest.id, name, spec, log); },
            /** 宿主当前提供的插槽名（mod 想探测可用扩展点时用） */
            slots() { return [...slotImpls.keys()]; },

            /**
             * 打开**另一个插件**的设置窗（按它的 id）。
             *
             * 为什么要有这个：插件之间常互相引导（"模型在另一个扩展包里管理"），
             *   若各自去摸宿主内部的登记表，就等于把宿主的实现细节当成插件 API；
             *   走这里，插件不必知道打开函数存在哪，也拿得到明确的 false
             *   （对方没装 / 没启用 / 没有设置窗）。
             *
             * @returns {boolean} 是否真的打开了
             */
            openSettings(targetId) { return openModSettings(targetId); },
            /** 目标插件有没有设置窗（插件据此决定要不要显示那颗齿轮/引导） */
            hasSettings(targetId) { return hasModSettings(targetId); },

            /**
             * 注入一份插件自己的样式表。
             *
             * 传相对路径即可（`host.injectStyle('extra.css')`），由系统按本插件真实目录拼；
             *   也可传 host.assetUrl() 的结果。外链与越界路径会被拒绝 ——
             *   一份清单/一行插件代码就能把任意站点的 CSS 拉进页面，那等同于让第三方改写整个界面。
             *
             * 停用时会**真的失效**（`disabled=true`，不重新下载），启用时恢复；
             *   与清单里 `styles` 声明的那份走同一段代码，两条路径都会回收。
             */
            injectStyle(href) {
                const url = resolveModAsset(manifest, href, 'injectStyle');
                return url == null ? null : injectStyleLink(manifest, url);
            },

            /**
             * 注册一段"动态 system 提示词"。宿主在每次构造对话消息时调用它。
             * 用注册而不是直接改：插件不该知道宿主怎么拼提示词，宿主也不该知道有哪些插件 ——
             *   注册表是唯一的耦合点。
             * 插件被停用时这段提示词会被**摘掉**（文本留着，启用时原样恢复）——
             *   不摘就会出现"关掉的插件还在影响模型行为"，看不见也想不到去查。
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

            /**
             * 订阅宿主事件。返回取消订阅的函数。
             * 停用插件时订阅会被摘掉（回调留着，启用时再接上）—— 否则停用的插件仍在后台响应事件。
             *   返回的取消函数仍然可用（用于插件自己中途退订）。
             */
            on(event, handler) {
                if (typeof handler !== 'function') {
                    log('error', 'host.on 的第二个参数必须是函数，已忽略');
                    return () => {};
                }
                // 包一层再进总线：宿主 emit 时不需要知道某个 mod 会不会抛错，
                //   异步回调的 rejection 也不会漏成 unhandledrejection。
                const wrapped = (detail) => guardModAsync(
                    manifest.id, '事件 ' + event, () => handler(detail));
                const attach = () => {
                    if (!bus.has(event)) bus.set(event, new Set());
                    bus.get(event).add(wrapped);
                    // 'app-ready' 是"一次性、且可能已经发生过"的事件：mod 在
                    //   DOMContentLoaded 就加载，而初始化完成可能早于某个 mod 的
                    //   注册（loadAll 异步）→ 慢加载的 mod 会永远等不到这个信号。
                    //   所以订阅时若它已经发生过，立刻补调一次。
                    if (event === 'app-ready' && isAppReady()) {
                        guardModAsync(manifest.id, 'app-ready 处理', () => handler());
                    }
                };
                const detach = () => {
                    const set = bus.get(event);
                    if (set) set.delete(wrapped);
                };
                addContribution(manifest.id, {
                    activate: attach,
                    deactivate: detach,
                    dispose: detach,
                });
                return detach;
            },
            emit(event, detail) {
                // 与宿主广播走**同一条**分发路径：订阅者已在 host.on 里各自包了隔离，
                //   这里再写一份 try/catch 只会让同一个错误记两遍日志。
                dispatch(event, detail);
            },

            /**
             * `host.has(capability)` —— 宿主**声明的**能力是否可用。
             *
             * 参数是一份固定清单里的名字（见 HOST_CAPABILITIES），不是任意全局名。
             * 早期版本是 `typeof window[name] !== 'undefined'`，等于把 window 上
             * 的一切都变成了 API：插件随便写一个名字就能探到另一个
             * 插件的私有全局名，宿主也没法据这份清单做兼容性判断。名字写错时
             * 现在会明确报出来，而不是安静返回 false。
             */
            has(capability) {
                const key = String(capability || '');
                if (!Object.prototype.hasOwnProperty.call(HOST_CAPABILITIES, key)) {
                    log('warn', 'host.has 不认识的能力名「' + key + '」，可用：'
                        + Object.keys(HOST_CAPABILITIES).join('、'));
                    return false;
                }
                try { return Boolean(HOST_CAPABILITIES[key]()); } catch (e) { return false; }
            },
            /** 宿主支持的能力名清单（插件做兼容性判断时用，不必猜） */
            capabilities() { return Object.keys(HOST_CAPABILITIES); },
            /** 本插件被授予的能力组（manifest.capabilities 解析后的结果） */
            grantedGroups() { return [...groups]; },
        };
    }

    /**
     * 在系统文件管理器里打开这个插件的目录。
     *
     *   await host.openFolder();                  // 插件自己的目录
     *   await host.openFolder('models/deepseek'); // 插件目录内的一层子路径
     *
     * 由宿主代劳：路径白名单在**服务端**，插件只要说"我想开自己目录下的这个子路径"，
     *   越界与否由宿主拒绝 —— 插件不必也不该知道 `mods/` 在哪、白名单长什么样。
     * 只有本机（有服务端）能开；APK / 局域网设备会拿到明确的失败原因，
     *   插件据此给用户提示即可（不要静默）。
     *
     * @returns {Promise<{ok:boolean, path?:string, message?:string}>}
     */

        return coreHostApi;
    };
})();
