/* ============================================================================
 * Galgame 界面（mod）
 *
 * 全屏沉浸式剧情界面：场景背景 + 立绘 + 打字机对话框。
 * 与主界面**共用同一份对话数据**（不复制、不冲突）—— 这是上游的设计，
 * 也是必须保留的：两边说的话互相可见，切换界面不会丢上下文。
 *
 * ── 相对上游 v1.3.1 的改动 ──────────────────────────────────────────────
 *
 * ① **立绘与情绪走公共依赖**：上游 galgame.js 自带一份 avatarSrc/setEmotion/
 *    emotionFrom，与 pet.js 里的那份重复（作者自己在注释里写了"避免词表分叉"）。
 *    这里改为统一调 window.ElainaAvatar —— 立绘路径、情绪词表、识别逻辑都只有一份，
 *    改词表时两个界面同时生效。这也是"消除上游 20MB 重复立绘"的落点。
 *
 * ② **不再直接写 window.__galgameSceneHint**：上游靠往 window 上挂一个变量、
 *    宿主再读它来注入提示词。现在改成走 mod 系统的 setPromptHint() ——
 *    宿主不需要知道"有个叫 galgame 的东西"，只要读注册表即可。
 *    mod 与宿主之间只剩注册表这一个耦合点。
 *
 * ③ **开关交给 mod 系统**：上游自己管浏览器本地存储里的 elaina_galgame_enabled，
 *    并靠 800ms 轮询去感知"设置里改了没有"（同页本地存储变化不触发 storage 事件）。
 *    现在由 mod 系统的 setEnabled 直接调用，不需要轮询。
 *
 * ④ 所有宿主调用都通过 host API，不再直接摸 state / handleTextSubmit 等全局。
 *
 * ── 依赖 ────────────────────────────────────────────────────────────────
 *   manifest.after: ["elaina-avatar"] —— 立绘接口必须先就绪
 *   host.renderText 由宿主提供（Markdown + LaTeX），打字机阶段也用它
 * ========================================================================== */
(function () {
    'use strict';

    const MOD_ID = 'galgame';

    window.ElainaMods.register(MOD_ID, function (host) {
        // ==================== 常量与状态 ====================

        /* 场景背景：★ 已搬到公共资源插件「场景背景图」（scene-backgrounds）。
           为什么搬：用这批图的**不只是** galgame —— 视频通话也要拿它们当背景。
           留在 galgame 里会变成"想要背景就得启用剧情界面"，而且卸载 galgame
           会把背景一起带走。现在两个界面共用同一个资源包。

           这里仍然自己持有一份 BGS 常量（而不是全靠 host.require）是为了**降级**：
           资源包没装/没启用时，界面仍然能开，只是没有背景图 ——
           总比整个剧情界面加载失败好。（缺依赖时 manifest.after 会先拦住，
           这条是给"用户手动删了资源包"这种情况兜底。） */
        const BGS = [
            ['amusement_park', '游乐园'], ['amusement_plaza', '游乐园广场'], ['arcade', '街机厅'],
            ['bedroom', '卧室'], ['bedroom_cosy', '温馨卧室'], ['bedroom_morning', '清晨卧室'],
            ['cafe', '咖啡厅'], ['carousel', '旋转木马'], ['city_park', '城市公园'],
            ['clothing_shop', '服装店'], ['fastfood', '快餐店'], ['ferris_wheel', '摩天轮'],
            ['flashback', '回忆'], ['furniture_shop', '家具店'], ['kitchen', '厨房'],
            ['lake_trail_broken', '雪湖栈道·破'], ['lake_trail_snow', '雪湖栈道'], ['mall', '商场'],
            ['market', '集市'], ['restaurant', '餐厅'], ['rollercoaster', '过山车'],
            ['room_day', '房间·白天'], ['room_night', '房间·夜晚'], ['room_snow', '房间·雪天'],
            ['shooting_booth', '拍立得亭'], ['snowy_street', '雪之街'], ['street_dusk', '黄昏街道'],
            ['street_snow_night', '雪夜街道'], ['swan_lake', '天鹅湖'], ['swan_lake_pavilion', '天鹅湖亭'],
            ['window_winter', '冬日窗边'],
        ];
        const BG_FILES = BGS.map((b) => b[0]);
        const FX_MODES = ['auto', 'none', 'star', 'snow', 'rain', 'petal'];

        /* 资源基址：mod 自己的目录。用宿主给的真实安装位置（目录名可能带版本号）；
           不写死 '/mods/<id>/'（D1）。 */
        const BASE = (host && typeof host.assetBase === 'function') ? host.assetBase() : '';
        /* 背景图 URL：★ 走公共资源插件（它知道自己的真实安装目录）。
           拿不到就回落到 galgame 自己的旧路径 —— 兼容"资源还没搬"的场景。 */
        const bgUrl = (name) => {
            const sb = (host.require ? host.require('scene-backgrounds') : null);
            if (sb && sb.ok && typeof sb.api?.url === 'function') {
                const u = sb.api.url(name);
                if (u) return u;
            }
            return BASE + 'img/bg/' + name + '.jpg';
        };

        /* 偏好存储走宿主：命名空间由 host.storage 负责，键不会与别的插件撞车。 */
        function get(k, d) {
            try { return host.storage.get(k, d); } catch (e) { return d; }
        }
        function set(k, v) {
            try { host.storage.set(k, v); } catch (e) { /* 忽略 */ }
        }

        let layer = null, sceneEl = null, fxCanvas = null, avatar = null;
        let nameEl = null, textEl = null, dialog = null, input = null, infoEl = null;
        let shownCount = 0;
        let typeTimer = null, typing = false, lastMsgKey = '';
        let pollTimer = null;
        let fxParticles = [], fxRaf = null, fxMode = 'none', fxResizeBound = false;
        let tipEl = null;
        let enabled = false;

        // ==================== 立绘与情绪（走公共依赖） ====================

        /** 取公共立绘接口。没就绪时返回 null，调用方各自回落。 */
        function avatarApi() {
            return (window.ElainaAvatar && typeof window.ElainaAvatar.src === 'function')
                ? window.ElainaAvatar : null;
        }
        function avatarSrc(key) {
            const api = avatarApi();
            return api ? api.src(key) : '';
        }
        function emotionFrom(text) {
            const api = avatarApi();
            if (api && typeof api.fromText === 'function') {
                try { return api.fromText(text); } catch (e) { /* 回落 */ }
            }
            return null;
        }
        function setEmotion(k) {
            if (!avatar) return;
            const api = avatarApi();
            const list = api ? api.EMOTIONS : ['calm'];
            const key = list.indexOf(k) >= 0 ? k : 'calm';
            const src = avatarSrc(key);
            if (!src || avatar.getAttribute('src') === src) return;
            avatar.setAttribute('src', src);
            avatar.classList.remove('emo-swap');
            void avatar.offsetWidth;   // 强制重排，让动画能重播
            avatar.classList.add('emo-swap');
        }

        // ==================== 数据（与主界面共用） ====================

        function visibleMessages() {
            const msgs = host.getMessages();
            return msgs.filter((m) => m && m.text && m.role !== 'system');
        }
        function msgKey(m) { return m ? (m.id + ':' + (m.text || '').length) : ''; }

        // ==================== 构建 DOM ====================

        function build() {
            if (layer) return;
            layer = document.createElement('div');
            layer.id = 'galgameLayer';
            layer.innerHTML =
                '<div id="ggScene" class="scene-dusk">' +
                  '<div class="bgA" style="position:absolute;inset:0;background-size:cover;background-position:center;transition:opacity .8s ease"></div>' +
                  '<div class="bgB" style="position:absolute;inset:0;background-size:cover;background-position:center;transition:opacity .8s ease"></div>' +
                  '<canvas id="ggFx"></canvas><div class="vignette"></div>' +
                '</div>' +
                '<div id="ggStage"><img id="ggAvatar" src="' + avatarSrc('calm') + '" alt="伊蕾娜"></div>' +
                '<div id="ggInfo">伊蕾娜 · 魔女之旅</div>' +
                '<div id="ggMenu">' +
                  '<button class="gg-btn" id="ggSettings" type="button">⚙ 设置</button>' +
                  '<button class="gg-btn" id="ggSpeech" type="button">🎤 语音</button>' +
                  '<button class="gg-btn" id="ggExit" type="button">✕ 退出 Galgame</button>' +
                '</div>' +
                '<div id="ggDialogWrap"><div id="ggDialog">' +
                  '<div id="ggName">伊蕾娜</div>' +
                  '<div id="ggText"></div>' +
                  '<div id="ggInputRow"><input id="ggInput" type="text" placeholder="和伊蕾娜说点什么…（回车发送）" autocomplete="off">' +
                  '<button id="ggSend" type="button">➤</button></div>' +
                '</div></div>';
            document.body.appendChild(layer);

            avatar = layer.querySelector('#ggAvatar');
            nameEl = layer.querySelector('#ggName');
            textEl = layer.querySelector('#ggText');
            dialog = layer.querySelector('#ggDialog');
            input = layer.querySelector('#ggInput');
            infoEl = layer.querySelector('#ggInfo');
            sceneEl = layer.querySelector('#ggScene');
            fxCanvas = layer.querySelector('#ggFx');

            // 点对话框推进剧情（点输入行不推进）
            dialog.addEventListener('click', (ev) => {
                if (ev.target.closest('#ggInputRow')) return;
                if (typing) { finishTyping(); return; }
                nextHistory();
            });
            layer.querySelector('#ggExit').addEventListener('click', (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                // 同步关掉 mod 系统的开关 —— 否则用户从界面退出后，
                // 设置里仍显示"已启用"，下次刷新又冒出来（两个状态不一致）
                setEnabled(false);
                try {
                    if (window.ElainaMods && typeof window.ElainaMods.setEnabled === 'function') {
                        window.ElainaMods.setEnabled(MOD_ID, false);
                    }
                } catch (e) { /* 忽略 */ }
                showTip('已退出 Galgame，回到主界面');
            });
            layer.querySelector('#ggSettings').addEventListener('click', (ev) => {
                ev.stopPropagation();
                // 让位给设置面板：它层级更高，但我们先隐藏自己避免视觉重叠
                layer.classList.remove('on');
                try { if (typeof openSettings === 'function') openSettings(); } catch (e) { /* 忽略 */ }
            });
            // 情景演绎的入口在**主页右上角**（register.js 注册的 header.actions），
            // 不在这里 —— 剧情界面不该成为进全屏互动的前置步骤。
            layer.querySelector('#ggSpeech').addEventListener('click', (ev) => { ev.stopPropagation(); startVoice(); });
            layer.querySelector('#ggSend').addEventListener('click', (ev) => { ev.stopPropagation(); send(); });
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.stopPropagation(); send(); }
            });
            input.addEventListener('click', (ev) => ev.stopPropagation());
            layer.querySelector('#ggInputRow').classList.add('show');
            applyOptions();
        }

        // ==================== 粒子特效 ====================

        function autoFxFor(name) {
            if (/night/.test(name)) return 'star';
            if (/snow/.test(name)) return 'snow';
            if (/rain/.test(name)) return 'rain';
            if (/flashback/.test(name)) return 'star';
            return 'none';
        }
        function resizeFxCanvas() {
            try {
                if (!fxCanvas) return;
                fxCanvas.width = fxCanvas.clientWidth || window.innerWidth;
                fxCanvas.height = fxCanvas.clientHeight || window.innerHeight;
            } catch (e) { /* 忽略 */ }
        }
        function fxInit(mode) {
            fxMode = mode || 'none';
            if (!fxCanvas) return;
            if (fxRaf) { cancelAnimationFrame(fxRaf); fxRaf = null; }
            fxParticles = [];
            const ctx = fxCanvas.getContext('2d');
            resizeFxCanvas();
            if (!fxResizeBound) {
                fxResizeBound = true;
                // 只绑一次：反复调用 fxInit 会累积监听器（上游注释里记了 OCR S7）
                window.addEventListener('resize', resizeFxCanvas);
            }
            if (fxMode === 'none') { ctx.clearRect(0, 0, fxCanvas.width, fxCanvas.height); return; }

            const W0 = fxCanvas.width, H0 = fxCanvas.height;
            const count = fxMode === 'star' ? 140 : fxMode === 'rain' ? 180 : fxMode === 'snow' ? 150 : 60;
            for (let i = 0; i < count; i++) {
                fxParticles.push({
                    x: Math.random() * W0, y: Math.random() * H0,
                    r: fxMode === 'petal' ? 4 + Math.random() * 5 : fxMode === 'rain' ? 1 : fxMode === 'snow' ? 1.4 + Math.random() * 2.4 : 0.6 + Math.random() * 1.6,
                    vx: (fxMode === 'petal' || fxMode === 'snow') ? -0.5 - Math.random() * 0.6 : fxMode === 'rain' ? -0.6 : 0,
                    vy: fxMode === 'petal' ? 0.5 + Math.random() * 0.7 : fxMode === 'rain' ? 8 + Math.random() * 6 : fxMode === 'snow' ? 0.7 + Math.random() * 1.1 : 0,
                    a: fxMode === 'star' ? 0.35 + Math.random() * 0.65 : fxMode === 'snow' ? 0.5 + Math.random() * 0.5 : 0.5 + Math.random() * 0.4,
                    tw: Math.random() * Math.PI * 2,
                    hue: fxMode === 'petal' ? 340 + Math.random() * 20 : 0,
                });
            }
            function frame() {
                if (!fxCanvas) return;
                const c2 = fxCanvas.getContext('2d');
                const w = fxCanvas.width, h = fxCanvas.height;
                c2.clearRect(0, 0, w, h);
                fxParticles.forEach((p) => {
                    p.x += p.vx; p.y += p.vy; p.tw += 0.05;
                    if (fxMode === 'rain') {
                        c2.strokeStyle = 'rgba(190,215,255,' + (p.a * 0.55) + ')';
                        c2.lineWidth = p.r;
                        c2.beginPath(); c2.moveTo(p.x, p.y); c2.lineTo(p.x + p.vx * 1.6, p.y + p.vy * 0.6); c2.stroke();
                    } else if (fxMode === 'snow') {
                        c2.fillStyle = 'rgba(255,255,255,' + p.a + ')';
                        c2.beginPath(); c2.arc(p.x, p.y, p.r, 0, Math.PI * 2); c2.fill();
                    } else if (fxMode === 'petal') {
                        c2.fillStyle = 'hsla(' + p.hue + ',85%,82%,' + p.a + ')';
                        c2.beginPath(); c2.ellipse(p.x, p.y, p.r, p.r * 0.62, p.tw, 0, Math.PI * 2); c2.fill();
                    } else {
                        const al = p.a * (0.6 + 0.4 * Math.sin(p.tw));
                        c2.fillStyle = 'rgba(255,255,255,' + al + ')';
                        c2.beginPath(); c2.arc(p.x, p.y, p.r, 0, Math.PI * 2); c2.fill();
                    }
                    if (p.y > h + 20) { p.y = -20; p.x = Math.random() * w; }
                    if (p.y < -20 && fxMode === 'rain') p.y = h + 20;
                    if (p.x < -20) p.x = w + 20;
                });
                fxRaf = requestAnimationFrame(frame);
            }
            frame();
        }

        // ==================== 应用选项 ====================

        function applyOptions() {
            if (!layer) return;
            // 背景（双层交叉淡入）
            if (sceneEl) {
                let sc = get('scene', '');
                if (BG_FILES.indexOf(sc) < 0) sc = BG_FILES[0] || '';
                const layerA = sceneEl.querySelector('.bgA'), layerB = sceneEl.querySelector('.bgB');
                if (layerA && layerB) {
                    const cur = sceneEl.getAttribute('data-bg') || '';
                    if (cur !== sc) {
                        const topIsA = sceneEl.getAttribute('data-top') === 'a';
                        const top = topIsA ? layerB : layerA;
                        const bottom = topIsA ? layerA : layerB;
                        top.style.backgroundImage = 'url("' + bgUrl(sc) + '")';
                        top.style.opacity = '1';
                        bottom.style.opacity = '0';
                        sceneEl.setAttribute('data-top', topIsA ? 'b' : 'a');
                        sceneEl.setAttribute('data-bg', sc);
                    }
                }
            }
            // 粒子
            let fx = get('fx', 'auto');
            const curBg = (sceneEl && sceneEl.getAttribute('data-bg')) || BG_FILES[0] || '';
            if (fx === 'auto') fx = autoFxFor(curBg);
            if (FX_MODES.indexOf(fx) < 0) fx = 'none';
            fxInit(fx);
            // 对话框透明度
            const alpha = Number(get('alpha', '0.62')) || 0.62;
            layer.style.setProperty('--gg-alpha', String(alpha));
            // 立绘尺寸（内联 !important 才能盖过样式表里的 !important）
            let scale = Number(get('scale', '1')) || 1;
            if (scale < 0.6) scale = 0.6;
            if (scale > 1.6) scale = 1.6;
            if (avatar) {
                const isPhone = window.matchMedia && window.matchMedia('(max-width: 560px)').matches;
                const baseH = isPhone ? 118 : 100;
                const baseW = isPhone ? 104 : 68;
                try {
                    avatar.style.setProperty('max-height', (baseH * scale).toFixed(1) + '%', 'important');
                    avatar.style.setProperty('max-width', (baseW * scale).toFixed(1) + '%', 'important');
                } catch (e) { /* 忽略 */ }
            }
        }

        // ==================== 对话推进 ====================

        function renderMsg(m, animate) {
            const who = m.role === 'user' ? 'me' : 'ai';
            nameEl.textContent = who === 'me' ? '你' : '伊蕾娜';
            nameEl.classList.toggle('me', who === 'me');
            const html = host.renderText(m.text);
            if (animate) typewrite(html);
            else { textEl.innerHTML = html; typing = false; dialog.classList.add('ready'); }
            setEmotion(who === 'ai' ? emotionFrom(m.text) : 'calm');
        }
        function typewrite(html) {
            const speed = Number(get('speed', '24')) || 24;
            if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
            typing = true;
            dialog.classList.remove('ready');
            textEl.innerHTML = '';
            // 按纯文本逐字推进，但**每一帧都走 Markdown 渲染** ——
            // 否则打字过程中会露出 `#`、`**`、`$` 这些源码（上游注释里记了 OCR 视觉）
            const probe = document.createElement('div');
            probe.innerHTML = html;
            const plain = probe.textContent || '';
            let i = 0;
            typeTimer = setInterval(() => {
                i += 2;
                const partial = plain.slice(0, i);
                try { textEl.innerHTML = host.renderText(partial); }
                catch (e) { textEl.textContent = partial; }
                if (i >= plain.length) finishTyping(html);
            }, Math.max(8, speed));
        }
        function finishTyping(html) {
            if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
            const list = visibleMessages();
            const last = list[list.length - 1];
            if (last) textEl.innerHTML = host.renderText(last.text);
            else if (html) textEl.innerHTML = html;
            typing = false;
            dialog.classList.add('ready');
        }
        function nextHistory() {
            const list = visibleMessages();
            if (!list.length) {
                textEl.textContent = '（还没有对话，输入一句话开始吧）';
                nameEl.textContent = '伊蕾娜';
                return;
            }
            if (shownCount < list.length) { renderMsg(list[shownCount], true); shownCount++; }
            else renderMsg(list[list.length - 1], true);
        }
        function syncFromState(force) {
            const list = visibleMessages();
            if (!list.length) return;
            const last = list[list.length - 1];
            const key = msgKey(last);
            if (!force && key === lastMsgKey) return;
            lastMsgKey = key;
            if (last.role !== 'user') applySceneFromText(last.text);
            renderMsg(last, true);
            shownCount = list.length;
            const c = host.getConversation();
            if (infoEl && c) infoEl.textContent = '伊蕾娜 · ' + (c.title || '当前对话');
        }

        // ==================== 发送（复用宿主链路） ====================

        function send() {
            const v = (input && input.value || '').trim();
            if (!v) return;
            input.value = '';
            // 走宿主的 sendUserMessage：与主输入框**完全同一条链路**
            // （记忆、续跑、停止、语音都自动生效），不另起一套请求
            if (!host.sendUserMessage(v)) {
                showTip('发送失败：没有当前对话');
            }
        }

        function startVoice() {
            try {
                const btn = document.getElementById('micBtn')
                    || document.querySelector('.conversation-mic-btn')
                    || document.querySelector('.initial-conversation-mic-btn')
                    || document.querySelector('[id*="mic" i]');
                if (btn) {
                    btn.click();
                    showTip('语音识别中…结果会出现在输入框，回车发送');
                    return;
                }
                showTip('未找到语音入口，请在主界面使用麦克风');
            } catch (e) { showTip('语音启动失败'); }
        }

        function showTip(msg) {
            if (!tipEl) {
                tipEl = document.createElement('div');
                tipEl.style.cssText = 'position:fixed;left:50%;bottom:200px;transform:translateX(-50%);z-index:2100;'
                    + 'padding:6px 14px;border-radius:999px;background:rgba(10,14,22,.85);color:#fff;font-size:12px;'
                    + 'opacity:0;transition:opacity .2s ease;pointer-events:none';
                document.body.appendChild(tipEl);
            }
            tipEl.textContent = msg;
            tipEl.style.opacity = '1';
            setTimeout(() => { tipEl.style.opacity = '0'; }, 2600);
        }

        // ==================== AI 自主选背景 ====================

        let SCENE_MAP = null;
        function sceneAliases() {
            const map = {};
            BGS.forEach((b) => {
                map[b[1]] = b[0];                    // 中文名 → 文件
                map[b[0]] = b[0];                    // 英文 id → 文件
                map[b[0].replace(/_/g, '')] = b[0];  // 去下划线
            });
            // 常见简称补充
            const extra = {
                '咖啡': 'cafe', '咖啡店': 'cafe', '卧室': 'bedroom', '房间': 'room_day', '卧室·白天': 'room_day',
                '夜晚房间': 'room_night', '雪夜': 'street_snow_night', '雪街': 'snowy_street', '街道': 'street_dusk',
                '游乐园': 'amusement_park', '摩天轮': 'ferris_wheel', '旋转木马': 'carousel', '过山车': 'rollercoaster',
                '商场': 'mall', '集市': 'market', '市场': 'market', '餐厅': 'restaurant', '快餐': 'fastfood',
                '厨房': 'kitchen', '湖边': 'swan_lake', '湖': 'swan_lake', '天鹅湖': 'swan_lake', '公园': 'city_park',
                '服装店': 'clothing_shop', '家具店': 'furniture_shop', '街机': 'arcade', '游戏厅': 'arcade',
                '回忆': 'flashback', '雪湖': 'lake_trail_snow', '栈道': 'lake_trail_snow',
            };
            for (const k in extra) map[k] = extra[k];
            return map;
        }
        function extractScene(text) {
            const m = String(text || '').match(/<scene>\s*([\s\S]*?)\s*<\/scene>/i);
            if (!m) return null;
            const raw = String(m[1]).trim();
            if (!raw) return null;
            if (!SCENE_MAP) SCENE_MAP = sceneAliases();
            if (SCENE_MAP[raw]) return SCENE_MAP[raw];
            // 模糊匹配：包含关系
            for (const k in SCENE_MAP) {
                if (raw.indexOf(k) >= 0 || k.indexOf(raw) >= 0) return SCENE_MAP[k];
            }
            return null;
        }
        function aiBgEnabled() { return get('aiBg', '1') === '1'; }
        function applySceneFromText(text) {
            if (!aiBgEnabled()) return false;
            const file = extractScene(text);
            if (!file) return false;
            if (get('scene', '') === file) return false;
            set('scene', file);
            applyOptions();
            const label = (BGS.find((b) => b[0] === file) || [file, file])[1];
            showTip('场景切换：' + label);
            return true;
        }

        /**
         * 同步提示词到宿主。
         *
         * 这是 mod 影响模型行为的唯一入口：通过 host.setPromptHint 注册一段文本，
         * 宿主在每次构造对话消息时取出来拼进 system。mod 不需要知道宿主怎么拼提示词，
         * 宿主也不需要知道有哪些 mod。
         *
         * ★ 合并后的关键点：情景演绎（Live2D）的表现指南也在这段里。
         *   `setPromptHint` 在同一插件内是**覆盖**而不是拼接，所以两段必须合成一次调用；
         *   而且两段各有各的生效条件（场景说明要开着剧情界面，表现指南只要插件启用），
         *   只要**任一**生效就要注入。
         */
        function syncSceneHint() {
            try {
                const parts = [];
                if (enabled && aiBgEnabled()) {
                    const names = BGS.map((b) => b[1]).join('、');
                    parts.push(
                        '# 场景切换（内部指令，不要向用户解释）\n'
                        + '当前为 Galgame 界面，背景场景可由你决定。当剧情明显进入新的地点或时段时，'
                        + '请在回复的**最后单独一行**输出场景标记：<scene>场景名</scene>；'
                        + '如果场景没有变化，不要输出该标记，也不要在正文里提到它。\n'
                        + '可选场景名（必须从其中选择）：' + names + '。'
                    );
                }
                // 情景演绎的"表现指南"（表情/动作/当前模型清单/水印说明）。
                // 住在 index-live2d.js 里，随模型加载而变化，每次同步都现取一次。
                const l2d = window.Live2DCall;
                if (l2d && typeof l2d.promptHintText === 'function') {
                    const t = String(l2d.promptHintText() || '').trim();
                    if (t) parts.push(t);
                }
                if (parts.length) host.setPromptHint(parts.join('\n\n'));
                else host.clearPromptHint();
            } catch (e) { host.warn('同步提示词失败', e); }
        }

        // ==================== 开关 ====================

        function open() {
            build();
            enabled = true;
            layer.style.display = 'block';
            syncSceneHint();
            applyOptions();
            layer.classList.add('on');
            const list = visibleMessages();
            shownCount = Math.max(0, list.length - 1);
            lastMsgKey = '';
            syncFromState(true);
            // 场景说明只在界面开着时注入；打开这一刻先补一次，
            // 否则上一轮 close() 把它清掉了，AI 不会带场景标记
            syncSceneHint();
            if (pollTimer) clearInterval(pollTimer);
            // 轮询对话变化：宿主没有"新消息"事件时这是最稳的方式
            // （有事件总线后可以换成订阅，但轮询不依赖宿主改接口）
            pollTimer = setInterval(() => {
                if (!layer || !layer.classList.contains('on')) return;
                try {
                    const list2 = visibleMessages();
                    if (!list2.length) return;
                    const last = list2[list2.length - 1];
                    if (msgKey(last) !== lastMsgKey) syncFromState(false);
                } catch (e) { /* 忽略 */ }
            }, 600);
        }
        function close() {
            enabled = false;
            host.clearPromptHint();
            if (layer) {
                layer.classList.remove('on');
                layer.style.display = 'none';
            }
            if (typeTimer) { clearInterval(typeTimer); typeTimer = null; typing = false; }
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }
        /**
         * 打开「情景演绎」（全屏 Live2D 通话）。
         *
         * 入口是主页右上角那个按钮（register.js 注册的 header.actions），
         * 这里只是把同一件事暴露给其它插件 / Agent 调用。
         * 实现由 index-live2d.js 提供（window.Live2DCall）；没装配成功就说清楚，
         * 而不是让按钮点下去毫无反应。
         */
        function openScenario() {
            const call = window.Live2DCall;
            if (call && typeof call.open === 'function') {
                void call.open();
                return true;
            }
            showTip('情景演绎未就绪（Live2D 组件没有装配成功，刷新页面后再试）');
            host.error('情景演绎未就绪：window.Live2DCall 不存在');
            return false;
        }

        /**
         * 插件启用 / 停用（由插件系统的开关调用）。
         *
         * ★ 启用**只代表"这个功能可用"**，不打开任何界面 —— 入口在主页右上角
         *   「情景演绎」。之前这里写成 `if (on) open()`，于是用户只是在设置里
         *   把开关拨开，就被直接推进全屏舞台（"一打开 mod 就进 mod 页面"）。
         * 停用仍要 close()：界面若开着，必须收掉。
         */
        function setEnabled(on, silent) {
            if (!on) {
                close();
                set('enabled', '0');
                if (!silent) showTip('已停用 Galgame，回到主界面');
                return;
            }
            // 启用时保持"界面没开"的状态（场景提示词也不注入），等用户点入口
            enabled = false;
            set('enabled', '0');
            if (!silent) showTip('Galgame 已启用：点主页右上角「情景演绎」进入');
        }

        // ==================== 初始化 ====================

        // 启用插件**不等于**打开剧情界面：初始只把界面建好并藏着，等用户点
        // 主页右上角的「Galgame 剧情」再进（用户要求）。
        // 为什么不在这里 open()：启用是一个"设置动作"，多数人是在设置里拨开关，
        // 期待的是"这个功能现在可用"，而不是"我现在被切走了" —— 自动全屏正是
        // 最容易被当成"点了设置就跳页"的那种意外。入口有两个：
        //    · 主页顶栏按钮（register.js 注册的 header.actions，id=story）
        //    · 插件自己的 API：ElainaMods.find('galgame').api.open()
        // 这里仍然**不读**浏览器本地存储里自己那份 enabled 开关（双重开关问题：
        // mod 系统与界面各记一份，会导致"开关开了但界面没出现"）。
        enabled = false;
        build();
        layer.style.display = 'none';
        layer.classList.remove('on');
        // 界面没开时不该往 system 里塞场景说明（它描述的是"你现在在剧情界面里"）；
        // 等用户点了「剧情模式」再由 open() 注入。Live2D 那段表现指南不受影响，
        // 因为 syncSceneHint 会把它单独带上。
        syncSceneHint();

        // ---- 情景演绎（原独立的「Live2D 视频通话」插件）----
        // 装配顺序：先把 Live2D 内核跑起来（它初始化模型选择、并交出提示词材料），
        // 再同步一次提示词 —— 否则第一次注入时还没有表现指南。
        let scenario = null;
        try {
            if (typeof window.__galgameMountScenarioStage === 'function') {
                scenario = window.__galgameMountScenarioStage(host);
            } else {
                host.error('情景演绎装配脚本未就绪（register.js 没加载成功），剧情界面不受影响');
            }
        } catch (e) {
            // 情景演绎坏了不能拖垮剧情界面 —— 这正是"失败隔离"要在包内也成立的原因
            host.error('情景演绎装配失败（剧情界面不受影响）', e);
        }
        syncSceneHint();
        // 情景演绎切换"立绘 / 模型"时要立刻重算提示词（那段里写了当前呈现方式）。
        //   暴露一个只做这件事的钩子，而不是让 stage 直接改 host 提示词 ——
        //   提示词只能由插件这一处合成（两段分开 setPromptHint 会互相覆盖）。
        window.__galgameRefreshPromptHint = syncSceneHint;
        host.log('已就绪（场景 ' + BGS.length + ' 个，立绘走 elaina-avatar，情景演绎=' + (scenario ? '可用' : '不可用') + '）');

        return {
            setEnabled,
            isOpen: () => Boolean(layer && layer.classList.contains('on')),
            /** 兼容旧调用：现在是"开/关界面"，不是"启用/停用插件" */
            toggle: () => {
                if (layer && layer.classList.contains('on')) close();
                else open();
            },
            /** 打开剧情界面（主页右上角「Galgame 剧情」按钮调的就是它） */
            open,
            close,
            /**
             * 打开 / 收起剧情界面。
             *
             * 与 setEnabled 的区别：setEnabled 还负责 mod 自己的开关状态与提示词，
             * 这里是纯粹的"进/出界面"；`enabled` 会跟着走，因为提示词里那段场景说明
             * 只在界面开着时才该注入（见 syncSceneHint）。
             */
            toggleOpen() {
                if (layer && layer.classList.contains('on')) close();
                else open();
                return Boolean(layer && layer.classList.contains('on'));
            },
            /** 打开情景演绎（同主界面按钮；供其它插件或 Agent 调用） */
            openScenario,
            isScenarioOpen: () => Boolean(window.Live2DCall && typeof window.Live2DCall.isOpen === 'function' && window.Live2DCall.isOpen()),
            bgs: () => BGS.slice(),
            scenes: () => BGS.slice(),
            setScene: (file) => {
                if (BG_FILES.indexOf(file) < 0) return false;
                set('scene', file);
                applyOptions();
                return true;
            },
            currentScene: () => get('scene', BG_FILES[0] || ''),
            setOption: (k, v) => { set(k, v); applyOptions(); },
            getOption: (k, d) => get(k, d),
            showTip,
        };
    });
})();
