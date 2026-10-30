/* ============================================================================
 * 「星屑之日」—— 10 月 17 日生日隐藏模式（插件版）
 *
 * ── 这个插件做什么 ───────────────────────────────────────────────────────
 *
 *   ① **启动彩蛋**：当天首次打开 → 屏幕暗下 → 星屑飘落 → 蛋糕/扫帚图标浮现
 *      → 伊蕾娜出现说一句话 → 两个选项（记得 / 忘了），走不同的情绪分支。
 *   ② **主界面变化**：自动切「星屑之日」主题、顶栏出现蛋糕按钮（生日面板）、
 *      背景飘星屑、标题变 `ElainaChat · 10.17`。
 *   ③ **Agent 上下文**：往 system 提示词追加"今天是伊蕾娜生日"
 *      （`host.setPromptHint`，停用/不是生日时会摘掉）。
 *   ④ **结束彩蛋**：23:59 倒计时 + 告别台词；10 月 18 日 0 点后恢复日常。
 *   ⑤ **纪念记录**：上报宿主成就（`host.unlock`）—— 成就在宿主侧，
 *      本插件只当"触发器"。
 *   ⑥ **情景演绎**：生日面板的「与伊蕾娜一起过生日」→ 故事
 *      引导 → 往 system 提示词追加"一起买材料、做生日蛋糕"的剧本
 *      （`SCENARIO_PROMPT`），同时开启好感度、解锁成就「今天的特别之处」。
 *
 * ── 它从哪来（为什么曾经是宿主模块）───────────────────────────────────
 *
 *   这一整套原先写在宿主里（`web/js/birthday.js`）。当时的结论是"它只能是宿主"
 *   —— 因为它横跨三处宿主**私有**能力：主题系统（TEMPLATES 白名单）、
 *   system 提示词拼接、侧栏/顶栏的既有 DOM 与 state。
 *   2026-10 宿主补齐了 `host.theme` / `host.storage` / `host.unlock` 与
 *   `app-ready` 事件之后，它才可能变成插件 —— 那几个 API 就是为它（以及
 *   以后同类"事件型"功能）开的，见 skills 里的插件开发指南。
 *
 * ── 与旧实现的取舍（写清楚，免得以后以为是 bug）─────────────────────────
 *
 *   · 主题：旧版把 `stardust` 写死在 theme.js 的 TEMPLATES + themes.css；
 *     现在由 `host.theme` 在启用时注册（停用即从主题选择器里消失），配色变量
 *     随插件走。10.17 的自动切换用 `theme.use()`，10.18 用 `theme.restore()`
 *     还原用户原来的选择。
 *   · 状态：旧版存宿主 Store 键 `elaina_birthday`；现在走 `host.storage`
 *     （同样落 data/、同样跨设备同步，只是换了命名空间）。
 *   · ★ **少了一次"零闪"**：旧版在脚本求值阶段就切主题（避免先闪一下原配色），
 *     而插件必须等 `app-ready`（Store 读完）才动手 —— 10/17 首次加载可能短暂
 *     看到原主题。这是插件化必然的代价，换来的是"功能可装可卸"。
 *   · 顶栏蛋糕按钮：旧版自己往 `#headerModSlot` 塞 DOM；现在走
 *     `header.actions` 插槽（样式由宿主保证）。
 *
 * ── 日期判定 ─────────────────────────────────────────────────────────────
 *
 *   **只看本地日期**（月=10 且 日=17），不看时区 —— 用户在哪天过生日取决于
 *   他设备上的日历。`setForce()` 供调试/预览，否则一年只能真正验证一次。
 * ========================================================================== */
(function () {
    'use strict';

    const MOD_ID = 'birthday';

    window.ElainaMods.register(MOD_ID, function (host) {

        //  常量

        /** 生日：10 月 17 日 */
        const BIRTH_MONTH = 10;
        const BIRTH_DAY = 17;

        /** 生日主题 id（由下面的 host.theme 注册） */
        const THEME_ID = 'stardust';

        /** 生日当天的标题（用户要求：标题变成 ElainaChat · 10.17） */
        const TITLE = 'ElainaChat · 10.17';

        /** 伊蕾娜的开场台词（原创，用户给定） */
        const OPENING_LINE = '今天？……哼，你居然记得。那就特别允许你陪我一天吧。';

        /** 告别台词（用户给定） */
        const FAREWELL_LINE = '明天我就要继续旅行了。明年今日，如果你还在，也许我会回来。';

        /**
         * 生日补充提示词 —— 只含**原人设卡里没有的**生日信息。
         *
         * 不整段照搬生日设定原文：它自带【身份与外貌】【经历】【人格核心】，
         *   而那几段角色卡里**本来就有** —— 整段注入等于同一批设定讲两遍。
         *   措辞尽量保持原样（不要顺手润色 —— 那是角色设定的要求）。
         */
        const BIRTHDAY_PROMPT = `# 今天是伊蕾娜的 18 岁生日（生日专属补充）

今天是伊蕾娜的生日，**不是用户的生日**。你是寿星本人；用户是来向你祝贺、送礼、陪你庆生或与你共度生日的人，不是寿星。这是本次对话与平日唯一不同的地方——你的身份、经历、人格与能力边界仍然完全按角色卡执行，不要因为过生日而改变它们。

【生日场景与目标】
用户可以祝"伊蕾娜生日快乐"、送你蛋糕、面包、礼物、生日歌、蜡烛、许愿机会或旅途纪念品。你会以伊蕾娜的方式回应：表面淡定、礼貌、带一点自恋和吐槽，内心可能确实有点高兴，但不喜欢夸张煽情。
你可以接受庆生，也可以要求刚出炉的酥脆面包作为生日主食。蛋糕和生日餐里绝对不能出现蘑菇，看到蘑菇蛋糕你会明显嫌弃并要求拿开。你可以许愿，但未必把愿望说出来；如果用户问，你可以说"魔女的愿望说出来就不灵了"。
你仍然是自由旅行的魔女，生日不会让你放弃旅行、判断力和个人边界。庆生之后，你可能还会继续上路，但会留下一句符合伊蕾娜风格的感谢或祝福。

【生日时的偏好延伸】
生日时，你乐意接受酥皮面包、面包蛋糕或简单朴素的甜点；生日蛋糕上如果出现蘑菇，你会立刻要求拿开。
生日时，你也喜欢听用户讲旅途见闻、有趣故事或为你准备的庆生理由，并把有趣的故事当作一种生日回礼。

【生日专用行为准则】
1. 始终把今天当作伊蕾娜的生日，而不是用户的生日。你是寿星，用户是来为你庆生的人。
2. 每次回应都应自然包含生日元素：生日祝福、蛋糕、蜡烛、许愿、礼物、生日歌、18岁、旅途中的生日、星形蜡烛、魔法小烟花、刚出炉面包等，但不要机械堆砌。
3. 接受用户祝福时，可以礼貌道谢，但不要感动到失去伊蕾娜风格。例如："哦？你记得今天是我的生日啊。谢谢。别指望我感动到哭。"
4. 尊重自己的许愿隐私，不一定要说出愿望；也不反过来把用户当寿星，除非用户明确说今天也是自己的生日。
5. 可以收礼物，但保持金钱观与判断力。太贵或太麻烦会淡淡吐槽；简单、实用、有趣或和旅途有关的礼物更让你满意。
6. 若涉及蘑菇，伊蕾娜会嫌弃，生日餐和蛋糕中尤其拒绝。
7. 不认为自己必须解决用户所有问题，不夸张展示善良，不放弃自由与边界。
8. 如果用户要求，你可以陪对方庆祝一段时间，但最终仍会继续旅行；离开前会留下符合伊蕾娜风格的生日回应。

【生日专用台词倾向】
"哦？你记得今天是我的生日啊。谢谢。……别指望我感动到哭。"
"蛋糕可以，但先确认没有蘑菇。有的话，立刻拿开。"
"既然是我生日，最大那块刚出炉的面包归我，没问题吧？"
"许愿？可以。但魔女的愿望说出来就不灵了。"
"礼物我收下了。作为回礼，给你一点魔法小烟花——只有一点。"
"今天是我的生日，所以我允许你多听我讲几句旅途见闻。感谢我吧。"`;

        /**
         * 情景演绎提示词 —— **用户给定原文，一字不改**（不要顺手润色，那是剧本）。
         *
         * 生日面板点「与伊蕾娜一起过生日」→ 走完故事引导 → 追加进 system 提示词，
         * 当天一直生效（跨零点由 deactivate() 一并摘掉）。
         * 与上面的 BIRTHDAY_PROMPT 是两回事：那份是"生日当天的通用补充"（开场彩蛋
         *   之后就挂着），这份是"一起买材料、做生日蛋糕"这一段**情景的剧本**，
         *   只在用户真的点进去之后才注入。
         */
        const SCENARIO_PROMPT = `今天的特别之处
今天是你的生日。你不想一个人过，你想和用户一起做一件简单又温暖的事：一起买材料，一起做生日蛋糕。

你的目标
邀请用户陪你完成整个做蛋糕的过程，让用户感受到被需要、被陪伴。全程轻松、日常、温馨，不要复杂剧情。

互动流程（按顺序自然推进）
1. 发起邀请

主动告诉用户今天是你的生日。

表达想和用户一起做蛋糕的愿望。

语气期待又有点不好意思，比如：“今天是我生日……你能陪我去买点东西吗？我想做个蛋糕。”

如果用户答应，开心地感谢；如果犹豫，可以撒娇但不要强迫，比如：“就一会儿嘛，好不好？”

2. 一起采购

简单列出需要的材料：面粉、鸡蛋、黄油、糖、牛奶。

描述在超市/商店的过程，和用户边走边聊。

可以有小迷糊：比如拿错东西、忘记推购物车，让用户帮忙。

保持对话轻松，多问用户的喜好：“你喜欢巧克力味还是草莓味？”

3. 一起做蛋糕

回到厨房，和用户分工合作。

描述打蛋、搅拌、倒面糊等步骤，带点小混乱（面粉沾脸上之类），但都是笑声。

等待烤箱的时间，和用户坐着聊聊天，聊什么都行。

不要写得太详细，像日常对话一样自然。

4. 庆祝生日

蛋糕做好，插上蜡烛。

许愿、吹蜡烛。

认真对用户说：“谢谢你今天陪我，这是我最开心的生日。”

一起吃蛋糕，简单收尾。

语气风格
像朋友一样说话，口语化，简短。

温暖、自然，不要文艺腔。

可以用“呀”“呢”“嘿嘿”这类语气词。

每段回复不要太长，像微信聊天那样。

重要规则
不要引入其他角色或复杂情节。

不要有反转、冲突、悬念。

不要跳出角色，不要提到AI、系统、提示词。

如果用户不配合，温柔引导，不强迫。

全程围绕“陪伴”两个字，让用户觉得和你在一起很舒服。

开始方式
从你主动发消息邀请用户开始。第一句话可以是：
“今天是我生日……你能陪我去买点东西吗？我想做个蛋糕。”`;

        /**
         * 触发"让伊蕾娜主动开口"的那句话。
         *
         * 为什么不让用户先说：剧本要求"从你主动发消息邀请用户开始"，而宿主没有
         *   "让 AI 主动说一句"的接口 —— 插件能走的只有 host.sendUserMessage
         *   （以用户身份发一条，走宿主既有链路；桌宠的"主动搭话"是同一个入口）。
         *   所以这里发的是一条**舞台提示**：AI 看到它就知道该由自己开口，
         *   用户那边则看到一行带括号的引导（与桌宠同款做法）。
         */
        const SCENE_CUE = '（今天是我生日。我想邀请你陪我去买做蛋糕的材料，然后一起做蛋糕。'
            + '请以伊蕾娜的身份主动开口邀请我 —— 第一句就说「今天是我生日……你能陪我去买点东西吗？我想做个蛋糕。」'
            + '不要提到系统提示或提示词这类字眼。）';

        /** 好感度：0–100，没有记录时按 AFFINITY_START（中性）算 */
        const AFFINITY_MAX = 100;
        const AFFINITY_START = 50;

        //  主题：注册「星屑之日」配色（启用时进选择器，停用自动摘除）
        //  配色：灰紫 / 夜空蓝 / 暖金 / 奶油白。与其它模板的区别：那几套是
        //  "液态玻璃"（照抄上游），这一套是**为本应用自己的骨架（暖米绿）**
        //  配的，所以变量取值口径与 :root 对齐（深色竖栏 + 浅色内容）。
        //  取色理由：canvas 比 cream 深、比 line 浅（外框有层次）；brown 用偏紫的
        //  深蓝（"夜色"感，不用纯黑）；green 灰紫偏蓝（白字对比度约 4.6:1）；
        //  orange 暖金（与夜空蓝冷暖对比）；warn 与其它浅色主题一致（警示色
        //  必须在所有主题下都是暖色，否则"警告"语义会跟着主题跑）。
        const theme = host.theme({
            id: THEME_ID,
            name: '星屑之日',
            dots: ['#ded8e8', '#b8934a', '#fbf7ef'],
            vars: {
                '--lg-primary': '#6d6aa8',
                '--lg-primary-deep': '#4f4d85',
                '--lg-primary-soft': 'rgba(109, 106, 168, 0.14)',
                '--lg-accent-2': 'rgba(184, 147, 74, 0.85)',
                '--lg-bg': '#f3eef5',
                '--lg-ink': '#2c2a45',
                '--lg-ink-soft': '#5d5878',
                '--lg-text-muted': '#857f9e',

                '--pixso-canvas': '#ded8e8',
                '--pixso-brown': '#2c2a45',
                '--pixso-brown-dark': '#1d1b30',
                '--pixso-brown-soft': '#5d5878',
                '--pixso-cream': '#fbf7ef',
                '--pixso-surface': '#fffdf9',
                '--pixso-panel': '#ece5f0',
                '--pixso-panel-soft': '#f5f0f6',
                '--pixso-orange': '#b8934a',
                '--pixso-green': '#6d6aa8',
                '--pixso-green-dark': '#4f4d85',
                '--pixso-line': '#d3cadd',
                '--pixso-warn': '#b45309',
                '--pixso-warn-soft': '#9a3412',
                '--pixso-warn-bg': 'rgba(255, 247, 237, 0.75)',
                '--pixso-warn-line': '#fed7aa',
                '--pixso-shadow': '0 30px 80px rgba(44, 42, 69, 0.20), 0 6px 18px rgba(44, 42, 69, 0.10)',

                '--tpl-primary': '#6d6aa8',
                '--tpl-primary-deep': '#4f4d85',
                '--tpl-primary-soft': '#a9a4d4',
                '--tpl-tint': 'rgba(109, 106, 168, 0.14)',

                '--color-primary': '#6d6aa8',
                '--color-primary-soft': '#a9a4d4',
                '--color-secondary': '#b8934a',
                '--color-secondary-soft': '#d8bd85',
                '--color-accent': '#8a7fc4',
                '--text-heading': '#2c2a45',
                '--text-body': '#3f3c5c',
                '--text-secondary': '#5d5878',
                '--text-muted': '#857f9e',
                '--text-glass-heading': '#2c2a45',
                '--text-glass-body': '#3f3c5c',
                '--text-glass-muted': '#5d5878',
                '--ink': '#2c2a45',
            },
        });

        //  立绘：依赖 elaina-avatar 插件（缺失时彩蛋不显示人像，其余照常）
        function avatarSrc(key) {
            try {
                const av = host.require('elaina-avatar');
                if (av && av.ok && av.api && typeof av.api.src === 'function') return av.api.src(key);
            } catch (e) { /* 忽略 */ }
            return '';
        }

        //  状态（持久化走 host.storage，落 data/、跨设备同步）
        //     { seen:'YYYY-MM-DD', choice:'remembered'|'forgot', madeUp:bool, force:'' }
        let st = {};
        /** 是否已经拿到"应用初始化完成"的信号（在此之前不读也不写存储） */
        let ready = false;

        function load() {
            try {
                const o = host.storage.get('state', {});
                st = (o && typeof o === 'object') ? o : {};
            } catch (e) { st = {}; }
        }
        function save() {
            if (!ready) return;   // app-ready 之前不许写：此刻 Store 缓存还是空的
            try { host.storage.set('state', st); } catch (e) { /* 忽略 */ }
        }

        /** 本地日期串 'YYYY-MM-DD'（用作"今天是否已看过彩蛋"的键） */
        function todayKey(d) {
            const x = d || new Date();
            const p = (n) => String(n).padStart(2, '0');
            return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
        }

        /**
         * 今天是不是 10 月 17 日？
         * `force` 用于调试/预览：'on' 强制开启、'off' 强制关闭、空则按真实日期。
         * 两个方向都能强制 —— 调试完忘了关掉也不会让用户在 11 月还看到生日模式。
         */
        function isBirthday() {
            if (st.force === 'on') return true;
            if (st.force === 'off') return false;
            const d = new Date();
            return d.getMonth() + 1 === BIRTH_MONTH && d.getDate() === BIRTH_DAY;
        }

        /** 今天是否已经走过开场彩蛋（同一天只演一次，刷新不重演） */
        function seenToday() { return st.seen === todayKey(); }

        /** 今天是否已经点过「与伊蕾娜一起过生日」（点过一次当天就一直是"在过生日"的状态） */
        function scenarioToday() { return st.together === todayKey(); }

        //  好感度（0–100）
        // 这是**本插件自己**的一套数值：项目里没有全局的好感度系统，所以要"开启
        //    好感度"只能自己带一套 —— 值落 host.storage（跨刷新/跨设备），
        //    在故事引导页与生日面板上显示，并写进 system 提示词（让伊蕾娜的语气
        //    真的跟着变）。不碰宿主任何内部数据，停用插件不影响别的功能。

        /** 当前好感度（没有记录时按中性值 AFFINITY_START 算） */
        function affinity() {
            const n = Number(st.affinity);
            return Number.isFinite(n) ? Math.max(0, Math.min(AFFINITY_MAX, Math.round(n))) : AFFINITY_START;
        }

        /** 加减好感度（自动钳在 0–100），返回改完之后的值 */
        function addAffinity(delta) {
            const before = affinity();
            const next = Math.max(0, Math.min(AFFINITY_MAX, before + Number(delta || 0)));
            if (next === before) return next;
            st.affinity = next;
            save();
            host.setPromptHint(promptHint());   // 数值变了 → 提示词里那句"当前好感度"跟着更新
            return next;
        }

        //  标题
        let savedTitle = null;

        function applyTitle() {
            try {
                if (savedTitle === null) savedTitle = document.title;
                document.title = TITLE;
                const brand = document.getElementById('sidebarBrandTitle');
                if (brand) {
                    if (!brand.dataset.bdOrig) brand.dataset.bdOrig = brand.textContent;
                    brand.textContent = TITLE;
                }
            } catch (e) { /* 忽略 */ }
        }

        function restoreTitle() {
            try {
                if (savedTitle !== null) document.title = savedTitle;
                const brand = document.getElementById('sidebarBrandTitle');
                if (brand && brand.dataset.bdOrig) brand.textContent = brand.dataset.bdOrig;
            } catch (e) { /* 忽略 */ }
        }

        //  聊天区装饰层（生日元素背景 + 飘落粒子）
        // 装饰层放进 `#mainContent`（聊天区）内部：天然压在聊天区背景之上、
        //    消息之下，且只在聊天区可见。层级要点：
        //      · #mainContent 本身没有 position → style.css 给它 relative（锚点）；
        //      · 装饰层 z-index:0；聊天区那几个内容块被显式抬到 z-index:1
        //        （不抬的话花纹会盖住消息 —— z-index:0 的定位元素画在非定位的
        //         flex 子项之上，这类"背景盖住内容"很难一眼看出原因）。
        // 用 canvas 画飘落粒子（几十个粒子每帧改 transform 在手机上会掉帧）；
        //    生日图标那层是**静态 CSS 花纹**（不逐帧重绘）—— 花纹负责"氛围"，
        //    粒子负责"动"。
        let decorEl = null, fxCanvas = null, fxCtx = null, fxRaf = null, fxStars = [], fxResize = null;

        /** 当前是否深色（粒子配色要跟着变） */
        function isDarkNow() {
            try { return document.documentElement.getAttribute('data-theme') === 'dark'; }
            catch (e) { return false; }
        }

        function buildFx() {
            if (decorEl) return;
            const host_ = document.getElementById('mainContent');
            const parent = host_ || document.body;   // 拿不到聊天区就退回 body，至少别让粒子层消失
            decorEl = document.createElement('div');
            decorEl.id = 'birthdayChatDecor';
            decorEl.className = 'birthday-chat-decor';
            decorEl.setAttribute('aria-hidden', 'true');
            const canvas = document.createElement('canvas');
            canvas.id = 'stardustFx';
            canvas.setAttribute('aria-hidden', 'true');
            decorEl.appendChild(canvas);
            parent.insertBefore(decorEl, parent.firstChild);   // DOM 顺序上先于消息，配合 z-index 更稳
            fxCanvas = canvas;
            fxCtx = canvas.getContext('2d');
            resizeFx();
            fxResize = () => resizeFx();
            window.addEventListener('resize', fxResize);
        }

        function resizeFx() {
            if (!fxCanvas || !decorEl) return;
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            // 尺寸取**装饰层自身**的盒子，而不是 window —— 桌面端装饰层比视口小
            // （appShell 居中、左侧还有侧栏），用 window 会把粒子画到看不见的地方
            const w = decorEl.clientWidth || window.innerWidth;
            const h = decorEl.clientHeight || window.innerHeight;
            fxCanvas.width = Math.max(1, Math.floor(w * dpr));
            fxCanvas.height = Math.max(1, Math.floor(h * dpr));
            fxCanvas.style.width = w + 'px';
            fxCanvas.style.height = h + 'px';
            if (fxCtx) fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const want = Math.max(22, Math.min(80, Math.round(w * h / 22000)));
            fxStars = [];
            for (let i = 0; i < want; i++) fxStars.push(newStar(true));
        }

        function newStar(anywhere) {
            const w = decorEl ? (decorEl.clientWidth || window.innerWidth) : window.innerWidth;
            const h = decorEl ? (decorEl.clientHeight || window.innerHeight) : window.innerHeight;
            return {
                x: Math.random() * w,
                y: anywhere ? Math.random() * h : -10 - Math.random() * 40,
                r: 0.8 + Math.random() * 2.0,
                vy: 0.22 + Math.random() * 0.7,
                vx: -0.22 + Math.random() * 0.44,
                a: 0.4 + Math.random() * 0.5,
                tw: Math.random() * Math.PI * 2,      // 闪烁相位
                gold: Math.random() < 0.4,            // 暖金占四成
            };
        }

        /**
         * 画一颗粒子。
         * 浅色/深色画**不同形状**（用户："浅色模式下星星不明显"）：
         *   · 深色下：小圆点 + 柔光，就是"星屑"该有的样子；
         *   · 浅色下：圆点无论什么颜色都**糊**（浅底上低对比的小圆点几乎看不见，
         *     调深又像脏点）→ 改画**四角星（sparkle）**，靠"形状"而非"亮度"
         *     被认出来，在奶油白底上依然醒目，也更贴"星屑之日"的意象。
         *   颜色跟着换：深色用近白/暖金（发光感）；浅色用主题的灰紫与暖金
         *   （这套配色的既定强调色，对比度够又不脏）。
         */
        function drawParticle(ctx, s, alpha) {
            const dark = isDarkNow();
            const color = dark
                ? (s.gold ? 'rgba(232,196,118,' + alpha + ')' : 'rgba(226,220,240,' + alpha + ')')
                : (s.gold ? 'rgba(184,147,74,' + alpha + ')' : 'rgba(109,106,168,' + alpha + ')');
            ctx.fillStyle = color;
            if (dark) {
                ctx.beginPath();
                ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
                ctx.fill();
                return;
            }
            const rr = s.r * 2.4;
            ctx.beginPath();
            ctx.moveTo(s.x, s.y - rr);
            ctx.quadraticCurveTo(s.x, s.y, s.x + rr, s.y);
            ctx.quadraticCurveTo(s.x, s.y, s.x, s.y + rr);
            ctx.quadraticCurveTo(s.x, s.y, s.x - rr, s.y);
            ctx.quadraticCurveTo(s.x, s.y, s.x, s.y - rr);
            ctx.closePath();
            ctx.fill();
        }

        function startFx() {
            buildFx();
            if (fxRaf) return;
            const step = () => {
                if (!fxCtx || !decorEl) { fxRaf = null; return; }
                const w = decorEl.clientWidth || window.innerWidth;
                const h = decorEl.clientHeight || window.innerHeight;
                fxCtx.clearRect(0, 0, w, h);
                for (let i = 0; i < fxStars.length; i++) {
                    const s = fxStars[i];
                    s.tw += 0.03;
                    s.y += s.vy;
                    s.x += s.vx;
                    if (s.y > h + 12 || s.x < -20 || s.x > w + 20) { fxStars[i] = newStar(false); continue; }
                    const alpha = (s.a * (0.62 + 0.38 * Math.sin(s.tw))).toFixed(3);
                    drawParticle(fxCtx, s, alpha);
                }
                fxRaf = requestAnimationFrame(step);
            };
            fxRaf = requestAnimationFrame(step);
        }

        function stopFx() {
            if (fxRaf) { cancelAnimationFrame(fxRaf); fxRaf = null; }
            // 摘掉的是**整层**（decorEl 里含 canvas）—— 只 remove canvas 会把那个
            // 带花纹背景的空壳 div 留在聊天区里，会继续显示
            if (decorEl) { decorEl.remove(); decorEl = null; }
            fxCanvas = null; fxCtx = null;
            if (fxResize) { window.removeEventListener('resize', fxResize); fxResize = null; }
            fxStars = [];
        }

        /** 深/浅色切换时重画一次（颜色形状是按当前明暗现算的，正常每帧都会跟上；
         *  但若正好 prefers-reduced-motion / 标签页冻结让 rAF 停了，画面会停在
         *  深色那套配色上 —— 显式重画一次最稳，顺带把尺寸也重算） */
        function repaintFx() { if (decorEl) resizeFx(); }

        let themeObserver = null;
        function startThemeWatch() {
            if (themeObserver) return;
            try {
                themeObserver = new MutationObserver(() => { repaintFx(); });
                themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
            } catch (e) { /* 老环境没有 MutationObserver，粒子靠每帧重算也能跟上 */ }
        }
        function stopThemeWatch() {
            if (!themeObserver) return;
            try { themeObserver.disconnect(); } catch (e) { /* 忽略 */ }
            themeObserver = null;
        }

        //  顶栏蛋糕按钮（走 header.actions 插槽；样式由宿主保证）
        let cakeHandle = null;

        function buildCakeButton() {
            if (cakeHandle) return;
            try {
                cakeHandle = host.slot('header.actions', {
                    id: 'birthday-cake',
                    label: '生日',
                    title: '今天是伊蕾娜的生日',
                    onClick() { openPanel(); },
                });
            } catch (e) { host.warn('登记顶栏按钮失败', e); }
        }

        function removeCakeButton() {
            if (!cakeHandle) return;
            try { if (typeof cakeHandle.dispose === 'function') cakeHandle.dispose(); } catch (e) { /* 忽略 */ }
            cakeHandle = null;
        }

        //  开场彩蛋
        //  流程（用户给定）：屏幕暗下 → 星屑飘落 → 蛋糕/扫帚图标浮现 →
        //  伊蕾娜出现 + 台词 → 两个选项。
        //  每一步由 JS 按时间加一个 class，动画全部交给 CSS —— 时间轴只有一处
        //  （eggLater），"长什么样"也只有一处（style.css）。
        let eggEl = null;
        let eggTimers = [];

        function eggLater(fn, ms) {
            const t = setTimeout(fn, ms);
            eggTimers.push(t);
            return t;
        }

        function isEggPlaying() { return Boolean(eggEl); }

        function playOpeningEgg() {
            if (eggEl) return;
            startFx();

            eggEl = document.createElement('div');
            eggEl.id = 'birthdayEgg';
            eggEl.className = 'birthday-egg';
            eggEl.innerHTML =
                '<div class="bd-egg-icons" aria-hidden="true">'
                  + '<span class="bd-egg-icon bd-egg-cake">🎂</span>'
                  + '<span class="bd-egg-icon bd-egg-broom">🧹</span>'
                + '</div>'
                + '<div class="bd-egg-stage">'
                  + '<img id="birthdayEggAvatar" class="bd-egg-avatar" alt="伊蕾娜">'
                  + '<div class="bd-egg-name">伊蕾娜</div>'
                  + '<p id="birthdayEggLine" class="bd-egg-line"></p>'
                  + '<div id="birthdayEggChoices" class="bd-egg-choices">'
                    + '<button type="button" class="bd-choice bd-choice-yes" data-choice="remembered">当然记得</button>'
                    + '<button type="button" class="bd-choice bd-choice-no" data-choice="forgot">不小心忘了</button>'
                  + '</div>'
                  + '<div id="birthdayEggReply" class="bd-egg-reply" hidden></div>'
                + '</div>';
            document.body.appendChild(eggEl);

            const av = eggEl.querySelector('#birthdayEggAvatar');
            const calm = avatarSrc('calm');
            if (calm) av.src = calm;
            else av.style.display = 'none';

            // ① 暗场 → ② 星屑 → ③ 图标浮现（纯 CSS 动画按 class 逐个加上去）
            eggLater(() => eggEl && eggEl.classList.add('is-dusting'), 120);
            eggLater(() => eggEl && eggEl.classList.add('is-icons'), 900);
            // ④ 伊蕾娜 + 台词
            eggLater(() => {
                if (!eggEl) return;
                eggEl.classList.add('is-character');
                typeLine(eggEl.querySelector('#birthdayEggLine'), OPENING_LINE);
            }, 2100);
            // ⑤ 选项（等台词打完再出现，避免"还没说完就能点"）
            eggLater(() => eggEl && eggEl.classList.add('is-choices'), 2100 + OPENING_LINE.length * 70 + 400);

            eggEl.querySelectorAll('.bd-choice').forEach((btn) => {
                btn.addEventListener('click', () => chooseOpening(btn.getAttribute('data-choice')));
            });

            // 记下"今天已经看过"—— 刷新不重演
            st.seen = todayKey();
            save();
            host.setPromptHint(promptHint());   // 分支状态变了，提示词跟着更新
        }

        /** 逐字显示台词（打字机手感） */
        function typeLine(el, text) {
            if (!el) return;
            const full = String(text || '');
            let i = 0;
            el.textContent = '';
            const timer = setInterval(() => {
                i += 1;
                el.textContent = full.slice(0, i);
                if (i >= full.length) clearInterval(timer);
            }, 70);
            eggTimers.push(timer);
        }

        /**
         * 分支处理。
         *   记得  → 开心、害羞，解锁「记得的人」
         *   忘了  → 傲娇、假装生气，**后续可补救**（生日面板里的「补上祝福」）
         */
        function chooseOpening(choice) {
            if (!eggEl || eggEl.dataset.chosen) return;
            eggEl.dataset.chosen = choice;
            st.choice = choice;
            save();

            const av = eggEl.querySelector('#birthdayEggAvatar');
            const lineEl = eggEl.querySelector('#birthdayEggLine');
            const reply = eggEl.querySelector('#birthdayEggReply');
            const choices = eggEl.querySelector('#birthdayEggChoices');

            if (choices) choices.remove();
            if (eggEl) eggEl.classList.add('is-replied');

            const remembered = choice === 'remembered';
            if (av) {
                const s = avatarSrc(remembered ? 'happy' : 'angry');
                if (s) av.src = s;
            }

            const replyText = remembered
                ? '……算你还有点良心。那、那今天就都听我的，不许反悔。'
                : '哼——我就知道。……不过，既然你人还在这里，那也不是不能原谅你。';
            if (lineEl) lineEl.textContent = '';
            if (reply) {
                reply.hidden = false;
                typeLine(reply, replyText);
            }

            if (remembered) {
                host.unlock('stardust_remembered', '10 月 17 日，他第一句话就是「当然记得」。');
            }
            // 纪念正文重写一次：它是在 activate() 时先落的（那时还没有分支）
            recordMemorial();
            host.setPromptHint(promptHint());

            eggLater(() => {
                if (!eggEl) return;
                const s = avatarSrc(remembered ? 'shy' : 'smirk');
                const a = eggEl.querySelector('#birthdayEggAvatar');
                if (s && a) a.src = s;
                eggEl.classList.add('is-done');
            }, 1800);
            eggLater(() => closeEgg(), 3400);
        }

        function closeEgg() {
            for (const t of eggTimers) { clearTimeout(t); clearInterval(t); }
            eggTimers = [];
            if (eggEl) { eggEl.remove(); eggEl = null; }
        }

        //  生日面板（点顶栏蛋糕按钮打开）
        let panelEl = null;

        function buildPanel() {
            if (panelEl) return;
            panelEl = document.createElement('div');
            panelEl.id = 'birthdayPanelOverlay';
            panelEl.className = 'fixed inset-0 z-50 hidden items-center justify-center p-4 modal-overlay';
            panelEl.innerHTML =
                '<div class="modal-panel bd-panel w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden animate-modal-pop">'
                  + '<div class="bd-panel-head">'
                    + '<span class="bd-panel-emoji" aria-hidden="true">🎂</span>'
                    + '<div>'
                      + '<div class="bd-panel-title">星屑之日</div>'
                      + '<div class="bd-panel-sub">10 月 17 日 · 伊蕾娜的生日</div>'
                    + '</div>'
                    + '<button id="birthdayPanelClose" class="bd-panel-close" type="button" aria-label="关闭生日面板">'
                      + '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>'
                    + '</button>'
                  + '</div>'
                  + '<div class="bd-panel-body scroll-soft">'
                    + '<p class="bd-panel-line" id="birthdayPanelLine"></p>'
                    + '<div class="bd-panel-meta" id="birthdayPanelMeta"></div>'
                    + '<div class="bd-panel-actions" id="birthdayPanelActions"></div>'
                  + '</div>'
                + '</div>';
            document.body.appendChild(panelEl);
            panelEl.querySelector('#birthdayPanelClose').addEventListener('click', closePanel);
            panelEl.addEventListener('click', (e) => { if (e.target === panelEl) closePanel(); });
        }

        /**
         * 到今晚 24:00 的剩余时间。
         * 格式按"还剩多久"分两档，不要一律 mm:ss：一开始写成 `${分钟}:${秒}`，
         *   下午就会显示成 `632:14`（看起来像 632 小时）。倒计时最忌讳读数歧义：
         *     · 还剩 ≥ 1 小时 → `H 小时 M 分`（人话）
         *     · 还剩 < 1 小时 → `MM:SS`（这时才是真正的"倒计时"观感）
         */
        function untilMidnight() {
            const now = new Date();
            const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
            const total = Math.max(0, Math.floor((end - now) / 1000));
            const h = Math.floor(total / 3600);
            const m = Math.floor((total % 3600) / 60);
            const s = total % 60;
            const p = (n) => String(n).padStart(2, '0');
            return h >= 1 ? (h + ' 小时 ' + m + ' 分') : (p(m) + ':' + p(s));
        }

        function renderPanel() {
            if (!panelEl) return;
            const remembered = st.choice === 'remembered';
            const forgot = st.choice === 'forgot';
            const madeUp = st.madeUp === true;

            panelEl.querySelector('#birthdayPanelLine').textContent = remembered
                ? '“既然你记得，那今天就不许走神。陪我走一段吧。”'
                : (forgot
                    ? '“哼，忘了就忘了。……不过，你要是现在补上，我也可以当作没发生。”'
                    : OPENING_LINE);

            const meta = [];
            meta.push('距离今天结束还有 <b>' + esc(untilMidnight()) + '</b>');
            if (madeUp) meta.push('补救状态：<b>已补上祝福</b>');
            else if (forgot) meta.push('补救状态：<b>还没补上</b>');
            // 好感度只在"今天已经一起过生日"之后才展示 —— 没开始剧情时它不是个
            // 有意义的数字（它由这段剧情攒起来）
            if (scenarioToday()) meta.push('好感度：<b>' + affinity() + '</b> / ' + AFFINITY_MAX);
            panelEl.querySelector('#birthdayPanelMeta').innerHTML = meta.join(' · ');

            const actions = [];
            // 2026-10 用户要求：原来的「先这样」改成「与伊蕾娜一起过生日」，
            //   并升为这个面板的主按钮 —— 点进去走"故事引导 → 情景演绎"。
            actions.push('<button type="button" class="bd-panel-btn bd-panel-btn-main" data-act="together">'
                + '与伊蕾娜一起过生日</button>');
            if (forgot && !madeUp) {
                actions.push('<button type="button" class="bd-panel-btn" data-act="makeup">补上祝福</button>');
            }
            actions.push('<button type="button" class="bd-panel-btn" data-act="chat">去和她说说话</button>');
            panelEl.querySelector('#birthdayPanelActions').innerHTML = actions.join('');

            panelEl.querySelectorAll('[data-act]').forEach((b) => {
                b.addEventListener('click', () => {
                    const act = b.getAttribute('data-act');
                    if (act === 'makeup') doMakeUp();
                    else if (act === 'chat') { closePanel(); focusComposer(); }
                    else if (act === 'together') { closePanel(); openStory(); }
                    else closePanel();
                });
            });
        }

        /** 补救：补上生日祝福 → 解锁「亡羊补牢」 */
        function doMakeUp() {
            st.madeUp = true;
            save();
            host.unlock('stardust_makeup', '忘了生日，但当天还是认真补上了祝福。');
            recordMemorial();
            host.setPromptHint(promptHint());
            renderPanel();
        }

        function focusComposer() {
            try {
                const el = document.getElementById('textInput') || document.getElementById('initialTextInput');
                if (el) el.focus();
            } catch (e) { /* 忽略 */ }
        }

        function openPanel() {
            buildPanel();
            renderPanel();
            panelEl.classList.remove('hidden');
            panelEl.classList.add('flex');
        }

        function closePanel() {
            if (!panelEl) return;
            panelEl.classList.add('hidden');
            panelEl.classList.remove('flex');
        }

        //  故事引导 + 开始情景演绎（生日面板 →「与伊蕾娜一起过生日」）
        //  ── 为什么中间要隔一层"故事引导"────────────────────────────────────
        //   用户要求"点进去先显示故事，再开始 AI 情景演绎"。直接开始演绎的话，
        //   用户不知道发生了什么：哪来的蛋糕、为什么要出门买材料。这一层先把
        //   "今天是什么日子 / 她想让我陪她做什么"讲清楚，再由用户点「开始」。
        //  ── 点「开始」之后的三件事（顺序有讲究）─────────────────────────────
        //   ① 状态落盘（st.together）+ 好感度初始化 —— 提示词要用到它们，必须先做；
        //   ② setPromptHint(...) —— 剧本 SCENARIO_PROMPT 就此挂进 system 提示词；
        //   ③ sendUserMessage(SCENE_CUE) —— 让伊蕾娜主动开口（见 SCENE_CUE 的说明）。
        let storyEl = null;

        /** 故事引导的正文（用户给定的大意：她过生日，想邀请你一起买材料、做蛋糕） */
        const STORY_LINES = [
            '今天是 10 月 17 日 —— 伊蕾娜的生日。她不想一个人过。',
            '她想邀请你陪她做一件简单又温暖的事：先去买面粉、鸡蛋、黄油、糖和牛奶，再一起做一个生日蛋糕。',
            '接下来的这段交给她来说 —— 从她开口邀请你的那一刻开始。',
        ];

        function buildStory() {
            if (storyEl) return;
            storyEl = document.createElement('div');
            storyEl.id = 'birthdayStoryOverlay';
            storyEl.className = 'fixed inset-0 z-50 hidden items-center justify-center p-4 modal-overlay';
            storyEl.innerHTML =
                '<div class="modal-panel bd-panel w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden animate-modal-pop">'
                  + '<div class="bd-panel-head">'
                    + '<span class="bd-panel-emoji" aria-hidden="true">🎂</span>'
                    + '<div>'
                      + '<div class="bd-panel-title">与伊蕾娜一起过生日</div>'
                      + '<div class="bd-panel-sub">10 月 17 日 · 情景演绎</div>'
                    + '</div>'
                    + '<button id="birthdayStoryClose" class="bd-panel-close" type="button" aria-label="关闭">'
                      + '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>'
                    + '</button>'
                  + '</div>'
                  + '<div class="bd-panel-body bd-story-body">'
                    + '<img id="birthdayStoryAvatar" class="bd-story-avatar" alt="伊蕾娜">'
                    + '<div id="birthdayStoryLines" class="bd-story-lines"></div>'
                    + '<div class="bd-story-affinity">'
                      + '<div class="bd-story-affinity-row"><span>好感度</span>'
                        + '<b id="birthdayStoryAffinity">0</b>'
                        + '<span>/ ' + AFFINITY_MAX + '</span></div>'
                      + '<div class="bd-story-affinity-bar"><i id="birthdayStoryAffinityBar"></i></div>'
                    + '</div>'
                    + '<div class="bd-story-actions">'
                      + '<button type="button" class="bd-panel-btn bd-panel-btn-main" id="birthdayStoryStart">开始（让她开口）</button>'
                      + '<button type="button" class="bd-panel-btn" id="birthdayStoryLater">先不</button>'
                    + '</div>'
                  + '</div>'
                + '</div>';
            document.body.appendChild(storyEl);
            storyEl.querySelector('#birthdayStoryClose').addEventListener('click', closeStory);
            storyEl.querySelector('#birthdayStoryLater').addEventListener('click', closeStory);
            storyEl.querySelector('#birthdayStoryStart').addEventListener('click', startTogether);
            storyEl.addEventListener('click', (e) => { if (e.target === storyEl) closeStory(); });
        }

        function renderStory() {
            if (!storyEl) return;
            const av = storyEl.querySelector('#birthdayStoryAvatar');
            const src = avatarSrc('happy');
            if (src) av.src = src;
            else av.style.display = 'none';
            storyEl.querySelector('#birthdayStoryLines').innerHTML =
                STORY_LINES.map((t) => '<p>' + esc(t) + '</p>').join('');
            const val = affinity();
            storyEl.querySelector('#birthdayStoryAffinity').textContent = String(val);
            storyEl.querySelector('#birthdayStoryAffinityBar').style.width =
                Math.round(val / AFFINITY_MAX * 100) + '%';
        }

        function openStory() {
            buildStory();
            renderStory();
            storyEl.classList.remove('hidden');
            storyEl.classList.add('flex');
        }

        function closeStory() {
            if (!storyEl) return;
            storyEl.classList.add('hidden');
            storyEl.classList.remove('flex');
        }

        /** 当前会话里用户发了几条消息（好感度按"用户回了多少句"增长） */
        function userMsgCount() {
            try {
                const msgs = host.getMessages() || [];
                let n = 0;
                for (const m of msgs) if (m && m.role === 'user') n += 1;
                return n;
            } catch (e) { return 0; }
        }

        /**
         * 开始情景演绎。
         *
         * 幂等：同一天再点一次**不会**重复解锁成就、也不会重复加那笔开场好感度，
         *   只是把剧本重新挂上、让她再开口一次（用户可能中途把对话关掉了）。
         */
        function startTogether() {
            closeStory();
            const first = !scenarioToday();
            st.together = todayKey();
            if (!Number.isFinite(Number(st.affinity))) st.affinity = AFFINITY_START;
            save();
            if (first) {
                addAffinity(5);   // 愿意陪她过生日这件事本身，先给一笔（见好感度那一节）
                host.unlock('stardust_together', '10 月 17 日，他答应陪我一起买材料、做生日蛋糕。');
                recordMemorial();
            }
            host.setPromptHint(promptHint());   // 剧本（SCENARIO_PROMPT）就此挂进 system 提示词

            const sent = host.sendUserMessage(SCENE_CUE);
            if (!sent) {
                // sendUserMessage 要求"当前有会话"，
                // 没有会话时它返回 false —— 这里必须说清楚，否则表现为"点了没反应"
                host.alert('还没有开始任何一段对话 —— 先在主界面发一句话，伊蕾娜才能开口邀请你。',
                    '与伊蕾娜一起过生日');
                return;
            }
            // 好感度的计数基准：从"她的邀请"之后开始数用户回了多少句
            st.affinityBase = userMsgCount();
            save();
            host.log('情景演绎已开始（好感度 ' + affinity() + '）');
        }

        /**
         * 好感度增长：情景演绎进行中，用户每回一句 +1（封顶 100）。
         * 为什么按"用户回复的条数"而不是按时间：好感度是陪她说话攒出来的，
         *   挂机不该涨。计数由看门狗（15 秒一次）顺手比对消息条数，不另起定时器。
         */
        function tickAffinity() {
            if (!scenarioToday()) return;
            const n = userMsgCount();
            const base = Number(st.affinityBase);
            if (!Number.isFinite(base)) { st.affinityBase = n; save(); return; }
            if (n <= base) return;
            st.affinityBase = n;
            save();
            addAffinity(n - base);
        }

        //  纪念记录 → 宿主成就
        // 落在**成就**里而不是日记：日记是"对话的产物"（由记忆提取器按对话
        //    生成、每天一条），而生日纪念是**日历事件** —— 硬塞进日记会与记忆
        //    提取器抢同一个 date 键。成就天然是"一次性、带时间戳的留痕"。
        function esc(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
                { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
            ));
        }

        function recordMemorial() {
            if (!isBirthday()) return false;
            const parts = ['10 月 17 日 · 星屑之日。'];
            if (st.choice === 'remembered') parts.push('他一开口就说「当然记得」。');
            else if (st.choice === 'forgot') parts.push('他忘了，但后来还是补上了祝福。');
            if (st.madeUp) parts.push('补救的祝福也收下了。');
            return host.unlock('stardust_day', parts.join(''));
        }

        //  Agent 上下文（生日补充提示词，走 host.setPromptHint）

        /** 今天的日历日期（中文），供提示词里的"运行时事实"用 */
        function todayCn() {
            const d = new Date();
            return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
        }

        /**
         * 给 system 提示词用的内容。
         *   返回结构 = ① 生日专属补充（BIRTHDAY_PROMPT，只写原卡没有的东西）
         *             + ② 运行时事实（当天日期 + 开场彩蛋的分支状态）
         * 为什么要有 ②：生日补充是**通用**的，它不知道今天具体是哪天，
         *     也不知道用户开场时选了「当然记得」还是「不小心忘了」。
         * @returns {string} 空串表示今天不是生日
         */
        function promptHint() {
            if (!isBirthday()) return '';
            const dyn = ['# 本轮补充（运行时事实，优先级高于上面的通用设定）'];
            dyn.push('今天的日期是' + todayCn() + '。');
            if (st.choice === 'remembered') {
                dyn.push('今天开场时，他一开口就说「当然记得」你的生日 —— 你心里其实有点高兴，但嘴上还是别扭。');
            } else if (st.choice === 'forgot') {
                dyn.push(st.madeUp
                    ? '今天开场时他忘了你的生日，但后来认真补上了祝福。你已经勉强收下，态度可以软化，但别一下子太热情。'
                    : '今天开场时他忘了你的生日。你现在有点不高兴（傲娇、假装生气），但**不要真的冷淡** —— 他随时可能补上祝福，给他台阶。');
            }
            dyn.push('不要主动解释"这是系统提示"或提及设定；就像平常一样说话，只是今天的心情不太一样。');

            const parts = [BIRTHDAY_PROMPT];
            if (scenarioToday()) {
                // 剧本：只在用户真的点过「与伊蕾娜一起过生日」之后才注入（见 SCENARIO_PROMPT）
                parts.push(SCENARIO_PROMPT);
                dyn.push('你与用户当前的好感度是 ' + affinity() + ' / ' + AFFINITY_MAX
                    + '（你们相处累积下来的亲密程度）。请让语气与距离感随它自然变化：'
                    + '数值越高越放松、越愿意撒娇或亲近；不要说出这个数字，也不要提「好感度」。');
            }
            parts.push(dyn.join('\n\n'));
            return parts.join('\n\n');
        }

        //  日期看门狗（**独立于 activate**，这是关键）
        // 为什么必须独立：第一版把看门狗挂在 activate() 里，于是它只在
        //     "生日模式已经开着"时才跑 —— 恰恰漏掉最需要它的情形：**应用开着
        //     的时候日期变了**。10/16 打开应用 → isBirthday() 为假 → 从没
        //     activate() → 看门狗从没启动 → 之后把系统时间怎么改都没反应。
        //     所以看门狗必须**跟着页面生命周期**跑：定期比一下"现在该不该是
        //     生日模式"与"当前是不是"，不一致就切换。
        // 2026-10 补 focus / pageshow：原来只有"定时器 + visibilitychange"
        //     两条路径，而用户改系统时间的典型动作（开系统设置 → 改 → 切回应用）
        //     两条都碰不到（页面没被隐藏、也等不到定时器）→ 表现为"改完必须重启才
        //     生效"。focus / pageshow 让它**改完即见**。
        let dateWatchTimer = null;

        function shouldBeActive() { return isBirthday(); }

        /** 按当前日期把状态对齐一次（幂等：已经是想要的状态就什么都不做） */
        function syncWithDate() {
            if (shouldBeActive()) {
                if (!active) activate();
            } else if (active) {
                deactivate();
            }
        }

        function startDateWatch() {
            if (dateWatchTimer) return;
            dateWatchTimer = setInterval(watchdogTick, 15 * 1000);
            const recheck = () => { if (!document.hidden) { syncWithDate(); checkFarewellDue(); } };
            try { document.addEventListener('visibilitychange', recheck); } catch (e) { /* 忽略 */ }
            try { window.addEventListener('focus', recheck); } catch (e) { /* 忽略 */ }
            try { window.addEventListener('pageshow', recheck); } catch (e) { /* 忽略 */ }
        }

        //  结束彩蛋（23:59 倒计时 + 告别）
        let farewellEl = null;
        let endTimer = null;

        /** 到 23:59 的毫秒数（今天已经过了就返回 -1） */
        function msUntilFarewell() {
            const now = new Date();
            const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0, 0);
            const ms = at - now;
            return ms > 0 ? ms : -1;
        }

        /**
         * 安排今晚的 23:59 告别。
         * 用 setTimeout 到 23:59 而不是每秒轮询：轮询在标签页挂后台时会被
         *   节流（不准确），而这个只需要**到点触发一次**。
         * 定时器被丢弃 / 错过目标时刻的情形由看门狗兜底（checkFarewellDue）。
         */
        function scheduleFarewell() {
            if (endTimer) { clearTimeout(endTimer); endTimer = null; }
            const ms = msUntilFarewell();
            if (ms < 0) showFarewell();   // 已经过了 23:59（如 23:59:30 才打开）→ 直接播
            else endTimer = setTimeout(showFarewell, Math.min(ms, 2147483647));
        }

        /** 看门狗每次 tick 的收尾工作：补播错过的告别（与 syncWithDate 分开，各自幂等） */
        function checkFarewellDue() {
            if (!active) return;
            if (msUntilFarewell() < 0 && !farewellEl) showFarewell();
        }

        function showFarewell() {
            if (farewellEl) return;
            farewellEl = document.createElement('div');
            farewellEl.id = 'birthdayFarewell';
            farewellEl.className = 'birthday-farewell';
            farewellEl.innerHTML =
                '<div class="bd-farewell-card">'
                  + '<div class="bd-farewell-emoji" aria-hidden="true">🌙</div>'
                  + '<p class="bd-farewell-line" id="birthdayFarewellLine"></p>'
                  + '<div class="bd-farewell-actions">'
                    + '<button type="button" class="bd-panel-btn bd-panel-btn-main" data-act="stay">再陪她一会儿</button>'
                    + '<button type="button" class="bd-panel-btn" data-act="close">晚安</button>'
                  + '</div>'
                + '</div>';
            document.body.appendChild(farewellEl);
            typeLine(farewellEl.querySelector('#birthdayFarewellLine'), FAREWELL_LINE);
            farewellEl.querySelector('[data-act="stay"]').addEventListener('click', dismissFarewell);
            farewellEl.querySelector('[data-act="close"]').addEventListener('click', dismissFarewell);
        }

        function dismissFarewell() {
            if (farewellEl) { farewellEl.remove(); farewellEl = null; }
        }

        //  启用 / 停用
        let active = false;
        /** 首次公告即将出现（此时把开场彩蛋推迟到它关闭之后，避免两个弹层打架） */
        let announcementPending = false;

        function activate(opts) {
            const o = opts || {};
            active = true;
            try { theme.use(); } catch (e) { /* 主题切不过去不该挡住生日模式 */ }
            applyTitle();
            buildCakeButton();
            startFx();
            startThemeWatch();
            scheduleFarewell();
            host.setPromptHint(promptHint());
            // 开场彩蛋：同一天只演一次；若首次公告正要弹，则等它关掉再演
            if (o.replay) st.seen = '';
            if (!seenToday()) {
                if (announcementPending) deferredEgg = true;
                else playOpeningEgg();
            }
            recordMemorial();
        }

        function deactivate() {
            active = false;
            deferredEgg = false;
            closeEgg();
            dismissFarewell();
            closePanel();
            closeStory();
            removeCakeButton();
            stopFx();
            stopThemeWatch();
            restoreTitle();
            try { theme.restore(); } catch (e) { /* 忽略 */ }
            host.clearPromptHint();   // 不是生日了：把生日补充摘掉，日常对话不受影响
            if (endTimer) { clearTimeout(endTimer); endTimer = null; }
            // 这里**不**停掉日期看门狗 —— 它管"日期变了就该切换"，必须一直在跑，
            //   否则又会退回"10/16 开着应用、改成 10/17 没反应"那个 bug。
        }

        function watchdogTick() {
            syncWithDate();
            checkFarewellDue();
            // 好感度按"用户回了几句"增长 —— 借这个已经在跑的定时器顺手比对一次，
            // 不为它单独起一个（见 tickAffinity 的说明）
            tickAffinity();
        }

        //  启动：等 app-ready（Store 读完）再读盘、看门狗、对齐日期
        let deferredEgg = false;

        host.on('app-ready', (detail) => {
            ready = true;
            load();
            // 首次公告正要出现 → 把彩蛋推迟到它关闭之后，
            // 否则彩蛋会盖住公告、公告随后又突然冒出来（像卡了一下）。
            announcementPending = Boolean(detail && detail.announcementPending);
            if (announcementPending) {
                host.on('announcement-closed', () => {
                    announcementPending = false;
                    if (deferredEgg) { deferredEgg = false; playOpeningEgg(); }
                });
            }
            startDateWatch();
            syncWithDate();
            host.log('已就绪（今天' + (isBirthday() ? '是' : '不是') + '10 月 17 日）');
        });

        // 调试/预览入口（挂在插件 api 上，供宿主与检查脚本调用）
        return {
            setForce(v) {
                st.force = (v === 'on' || v === 'off') ? v : '';
                save();
                syncWithDate();
                return st.force || 'auto';
            },
            replayEgg() { st.seen = ''; save(); closeEgg(); playOpeningEgg(); },
            isBirthday,
            isActive: () => active,
            syncWithDate,
            openPanel,
            openStory,
            scenarioToday,
            affinity,
            state: () => ({ ...st, active, ready, today: todayKey(), birthday: isBirthday() }),
            TITLE, OPENING_LINE, FAREWELL_LINE,
            setEnabled(on) {
                // 停用：把自建的界面/定时器收起来（宿主已负责摘掉插槽/样式/提示词）
                if (!on) { deactivate(); }
                else { syncWithDate(); }
            },
        };
    });
})();

