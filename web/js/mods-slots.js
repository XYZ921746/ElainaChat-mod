/* ============================================================================
 * 宿主插槽系统（从 mods.js 拆出）
 *
 * slotImpls / slotEntries / registerSlot / renderItemSlot / injectStyleLink /
 * validateSlotSpec / defineSlot。依赖贡献表、错误隔离与路径校验。
 * ========================================================================== */
(function () {
    'use strict';

    window.ElainaModsSlots = function (deps) {
        const addContribution = deps.addContribution;
        const guardMod = deps.guardMod;
        const guardModAsync = deps.guardModAsync;
        const resolveModAsset = deps.resolveModAsset;
    /** 宿主挖好的插槽：插槽名 → 挂载实现 { mount(spec), note? } */
    const slotImpls = new Map();

    /** 插槽上已注册的条目：插槽名 → Map<key, entry>（entry 见 registerSlot） */
    const slotEntries = new Map();


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
        // 形状校验：缺字段 / 类型不对时当场拒绝，并说清缺什么。
        // 不校验的话故障会推迟到渲染那一刻，报的是"xxx is not a function"，
        // 插件作者指不回自己的注册点。
        const bad = validateSlotSpec(name, spec, impl.spec);
        if (bad) {
            log('error', '往插槽「' + name + '」注册失败：' + bad);
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
            // 插槽实现由宿主写，但它会调用**插件的 render** —— 两边都可能抛，
            //   从这一层分不出是谁的错，所以只记日志、不计入插件的错误预算：
            //   插件自己的 render 在 renderItemSlot / 各插槽实现里另有计数的边界。
            const m = guardMod(modId, '插槽 ' + name + ' 挂载',
                () => impl.mount(spec, { modId, name, key, log }), null, { count: false });
            // 插槽实现可以不返回东西（例如纯粹的内部登记），那就没什么可显隐的
            entry.mounted = m || { el: null, dispose() {} };
            if (typeof entry.mounted.show === 'function') {
                guardMod(modId, '插槽 ' + name + ' 显示', () => entry.mounted.show(), null, { count: false });
            }
        }

        /**
         * 卸载挂载出来的东西，但**保留 spec 与登记行**。
         *
         * 停用走"真卸载"而不是"只藏起来"：
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
                    // 停用要**立刻**把已经画在界面上的东西摘掉，不能等下次重渲染 ——
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

    /**
     * 跑一小段插件提供的回调，出错只记日志（插件的问题不该中断宿主流程）。
     *
     * 插槽的 cleanup / refresh 是**插件或宿主**两边都可能写的回调，
     *   从这一层分不出责任方，故只隔离不计入插件错误预算。
     */
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
            // 每条消息都会调到这里：一处 render 抛错绝不能打断消息渲染那条核心链路。
            //   render 允许是 async（返回值是 Promise）—— 它拒绝时同样只能记在
            //   该插件名下，不能变成一条没人认领的 unhandledrejection。
            let late = null;
            const ok = guardMod(entry.modId, '插槽 ' + name + ' 渲染', () => {
                const result = render(container, item);
                if (result && typeof result.then === 'function') late = result;
                return true;
            }, false);
            if (late) guardModAsync(entry.modId, '插槽 ' + name + ' 异步渲染', () => late, undefined);
            if (!ok) {
                // 抛错前它可能已经往容器里塞了一半元素：清掉刚加的那些，
                //   否则停用时的 cleanup 只认打过标记的元素，这半截会永久残留。
                for (const child of [...container.children]) {
                    if (!before.has(child)) { try { child.remove(); } catch (e) { /* 忽略 */ } }
                }
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
     * 几个必须做对的点：
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
    /**
     * 注入（或取回）某个 mod 的样式表，并把它登记成**可撤销贡献**。
     *
     * 为什么"清单声明的 styles"也必须走这里，而不是 loadOne 里直接建 `<link>`：
     *   不纳入可撤销作用域，插件**停用后它的 CSS 仍在生效** —— 覆盖了宿主样式、
     *   藏了某个控件，从界面上完全看不出是哪个插件干的。插件自己调 injectStyle
     *   的那条路也一样纳入。两条注入路径共用这段代码，才不会分叉成"一条能回收、一条不能"。
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
     * 校验一个插槽 spec 是否符合该插槽的约定。
     *
     * 为什么要有这一步：插槽的 spec 形状是**宿主挖插槽那一方**定的
     * （settings.tabs 要 `label` + `render`，header.actions 要 `onClick`…），
     * 而插件是第三方写的。形状不对时不校验，故障会推迟到渲染那一刻才炸，
     * 而且报的是 "xxx is not a function" 这种指不回注册点的错 —— 插件作者
     * 完全不知道是自己少传了字段。
     *
     * 期望的形状由 `defineSlot` 的 `spec` 描述（见 defineSlot 的说明），
     * 这里只做**通用判定**：必填、类型、id 合法性。不猜业务语义。
     *
     * @returns {string|null} 不合规的原因；null 表示通过
     */
    function validateSlotSpec(name, spec, schema) {
        const s = schema || {};
        const required = Array.isArray(s.required) ? s.required : [];
        const types = (s.types && typeof s.types === 'object') ? s.types : {};

        for (const field of required) {
            if (spec[field] === undefined || spec[field] === null || spec[field] === '') {
                return '缺少必填字段「' + field + '」（' + name + ' 需要：'
                    + required.join('、') + '）';
            }
        }
        for (const [field, want] of Object.entries(types)) {
            const v = spec[field];
            if (v === undefined || v === null) continue;   // 可选字段缺省即跳过
            const ok = want === 'function' ? typeof v === 'function'
                : want === 'string' ? typeof v === 'string'
                    : want === 'number' ? typeof v === 'number'
                        : want === 'boolean' ? typeof v === 'boolean'
                            : want === 'array' ? Array.isArray(v)
                                : true;
            if (!ok) {
                return '字段「' + field + '」应是 ' + want + '，实际是 '
                    + (Array.isArray(v) ? 'array' : typeof v);
            }
        }
        // id 会进 CSS 选择器与 data 属性，只允许安全字符（与 mod id 同口径）
        if (spec.id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(spec.id))) {
            return 'id「' + spec.id + '」不合法（字母数字开头，只含字母数字 . _ -，最长 64）';
        }
        return null;
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
     *
     * 额外可选 `spec: { required: [...], types: { 字段: '类型' } }` 声明本插槽的
     * 必填字段与字段类型 —— 注册时据此校验，形状不对就当场拒绝并说明缺什么，
     * 而不是等到渲染时抛出指不回注册点的错误。
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


        return { slotImpls, registerSlot, renderItemSlot, injectStyleLink, validateSlotSpec, defineSlot };
    };
})();
