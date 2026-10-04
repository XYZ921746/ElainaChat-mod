/* ============================================================================
 * 插件入口 —— 复制这个目录到 web/mods/<你的插件名>/ 后开始改。
 *
 * 规则只有三条：
 *   ① 用 ElainaMods.register(id, factory) 注册，id 与 manifest.json 里的 id 一致
 *   ② 只通过 factory 收到的 host 访问宿主能力 —— **不要**直接摸 window 上的
 *      state / elements / 内部函数。那些是宿主私有实现，改版就会坏，
 *      而 host API 这张表是承诺不破坏的。
 *   ③ 工厂里只做**注册**，不要有副作用（不要在这里发请求、起定时器、
 *      改别人的 DOM）。宿主会在停用/启用时反复调用你的注册项，
 *      但**不会重跑工厂**。
 *
 * 出厂自带的那两个插件（web/mods/galgame、web/mods/pet）就是范本。
 * ========================================================================== */
(function () {
    'use strict';

    // ★ id 必须与 manifest.json 一致，也建议与目录名一致
    const MOD_ID = 'my-first-mod';

    window.ElainaMods.register(MOD_ID, function (host) {
        host.log('已加载。宿主提供的插槽：' + host.slots().join('、'));

        // ---- ① 设置里加一栏（内容**被点开时**才渲染，别在注册时就建 DOM）----
        host.slot('settings.tabs', {
            id: MOD_ID,
            label: '我的插件',
            render(container) {
                container.innerHTML = '';
                const box = document.createElement('div');
                box.className = 'my-mod-box';
                box.textContent = '这里是我的设置界面';
                container.appendChild(box);
            },
        });

        // ---- ② 顶部栏加一个按钮 ----
        host.slot('header.actions', {
            id: 'hello',
            label: '打招呼',
            title: '点一下试试',
            onClick() {
                host.log('按钮被点了');
                // 走宿主既有链路发一条消息（记忆、续跑、停止、语音都会自动生效）
                host.sendUserMessage('你好呀');
            },
        });

        // ---- ③ 侧栏底部：自由排布，样式自己带 ----
        host.slot('sidebar.footer', {
            id: 'footer',
            render(container) {
                const el = document.createElement('div');
                el.className = 'my-mod-footer';
                el.textContent = '来自我的插件';
                container.appendChild(el);
            },
        });

        // ---- ④ 输入框那一行加个按钮 ----
        host.slot('composer.actions', {
            id: 'quick',
            render(container) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'my-mod-quick';
                btn.textContent = '⚡';
                btn.title = '快速插一句';
                btn.addEventListener('click', () => host.sendUserMessage('（这是一句快捷输入）'));
                container.appendChild(btn);
            },
        });

        // ---- ⑤ 每条消息上加一个按钮（★ 每项级插槽）----
        //    宿主每渲染一条消息就调一次 render，item 是 { message, conversationId }。
        //    你只负责往 container 里加节点，宿主负责归属与回收 —— 不要自己去清空容器、
        //    也不要碰别的元素。
        host.slot('chat.message.actions', {
            id: 'copy',
            render(container, item) {
                const text = item && item.message ? String(item.message.text || '') : '';
                if (!text) return;                       // 空消息不加按钮
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'my-mod-msg-btn';
                btn.textContent = '📋';
                btn.title = '复制这条消息';
                btn.addEventListener('click', () => {
                    try {
                        navigator.clipboard.writeText(text);
                        host.log('已复制');
                    } catch (e) { host.warn('复制失败', e); }
                });
                container.appendChild(btn);
            },
        });

        // ---- 往 system 提示词里追加一段（插件影响模型行为的唯一入口）----
        //    只在需要教模型"有你这个功能"时才用。停用插件时宿主会自动摘掉。
        host.setPromptHint('本应用装有"我的插件"：顶部栏有一个「打招呼」按钮。');

        // ---- 订阅宿主事件（停用时会自动摘掉，不用自己退订）----
        host.on('reply-done', (text) => {
            host.log('AI 回复了：' + String(text).slice(0, 40));
        });

        // ---- 需要时调自己的后端 ----
        //    Web 版走 serve.mjs；APK 没有服务端，这类接口在手机上不存在（见模板 README）。
        async function ping() {
            const r = await fetch('/api/myfirstmod/ping');
            return r.ok ? r.json() : null;
        }

        // ---- 返回给宿主的公开接口（其它插件可以用 host.require('my-first-mod') 拿到它）----
        return {
            ping,
            /** mod 系统的开关会调它；自建的界面要在这里收起来 */
            setEnabled(on) { host.log('插件被' + (on ? '启用' : '停用')); },
        };
    });
})();
