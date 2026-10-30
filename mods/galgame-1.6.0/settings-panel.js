/* ============================================================================
 * 情景演绎设置面板（角色呈现 / Live2D / 背景 / 对话框）
 *
 * 这个面板是合并后**唯一**的设置入口（插件卡片齿轮 →「情景演绎」）：
 *   ① 角色呈现：图片立绘 ↔ Live2D 模型（用户在舞台里真正看到的那套）
 *   ② Live2D：选模型、鼠标跟随与幅度、重置大小位置
 *   ③ 背景：上传图片 / 从场景背景图里挑 / 清除
 *   ④ 对话框：打字机开关
 *   ⑤ 试一下：直接打开情景演绎
 *
 * 为什么包成 init(host)：面板 HTML 由插槽在**被点开时**才插入 DOM，
 *   顶层执行会全部拿到 null。
 *
 * 改一处立刻生效：直接调 window.Live2DCall 暴露的接口并回写 localStorage，
 *   不走宿主的"保存设置"流程 —— 舞台是插件自己的界面，它知道自己该怎么重绘。
 *   存储键统一在 galgame.live2d.* 下。
 * ========================================================================== */
function initLive2DSettingsPanel(host) {
    'use strict';

    const P = 'galgame.live2d.';
    const get = (k, d) => {
        try { const v = localStorage.getItem(P + k); return v === null ? d : v; } catch (e) { return d; }
    };
    const set = (k, v) => {
        try { localStorage.setItem(P + k, String(v)); } catch (e) { /* 配额满就别存了，界面照样生效 */ }
    };
    const call = () => window.Live2DCall || null;
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    // ── ① 角色呈现 ────────────────────────────────────────────
    const MODE_HINT = {
        live2d: '当前用 Live2D 模型。切到「图片立绘」后不会加载引擎，低配设备更省电。',
        portrait: '当前用图片立绘：按 AI 回复里的情绪标签换图，不依赖 Live2D 模型文件。',
    };

    function markMode(mode) {
        document.querySelectorAll('[data-scene-mode]').forEach((btn) => {
            const on = btn.getAttribute('data-scene-mode') === mode;
            btn.classList.toggle('is-on', on);
            btn.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        const hint = $('gsModeHint');
        if (hint) hint.textContent = MODE_HINT[mode] || '';
        // Live2D 专属的那一块在立绘模式下淡出，免得以为改的是立绘的参数
        const live2dSec = $('gsSecLive2D');
        if (live2dSec) live2dSec.classList.toggle('is-dim', mode !== 'live2d');
    }

    document.querySelectorAll('[data-scene-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const mode = btn.getAttribute('data-scene-mode');
            const api = call();
            if (api && typeof api.setSceneMode === 'function') api.setSceneMode(mode);
            else set('sceneMode', mode);
            markMode(mode);
        });
    });
    markMode((call() && typeof call().getSceneMode === 'function')
        ? call().getSceneMode()
        : (get('sceneMode', 'live2d') === 'portrait' ? 'portrait' : 'live2d'));

    // ── ② Live2D 模型 ─────────────────────────────────────────
    function renderModels() {
        const box = $('gsModelList');
        const empty = $('gsModelEmpty');
        if (!box) return;
        const api = call();
        const list = (api && typeof api.getModelList === 'function') ? (api.getModelList() || []) : [];
        const current = (api && typeof api.getSelectedModel === 'function') ? api.getSelectedModel() : '';
        if (empty) empty.classList.toggle('hidden', list.length > 0);
        box.innerHTML = list.map((m) => {
            const name = typeof m === 'string' ? m : (m && m.name) || '';
            const on = name === current;
            return '<button type="button" class="gs-model' + (on ? ' is-on' : '') + '" data-model="' + esc(name) + '">'
                + '<span class="gs-model-name">' + esc(name) + '</span>'
                + (on ? '<span class="gs-model-badge">使用中</span>' : '')
                + '</button>';
        }).join('');
        box.querySelectorAll('[data-model]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const name = btn.getAttribute('data-model');
                const a = call();
                if (a && typeof a.setSelectedModel === 'function') a.setSelectedModel(name);
                set('selectedModel', name);
                renderModels();
            });
        });
    }
    // 模型清单是从资源包异步取的：先渲染一次（通常为空），取回来再重绘一次。
    //   不这么写的话面板第一次打开永远是「还没有模型」，用户以为模型丢了。
    renderModels();
    setTimeout(renderModels, 400);
    setTimeout(renderModels, 1200);

    const manage = $('gsManageModels');
    if (manage) manage.addEventListener('click', () => {
        const openers = window.__modSettingsOpeners || {};
        const open = openers['live2d-models'];
        if (typeof open === 'function') { open(); return; }
        host.alert('「Live2D 引擎与模型」没有可打开的设置。\n\n'
            + '请到「设置 → 插件」确认它已启用（它是模型资源的宿主，装模型要在那儿操作）。', '管理模型');
    });

    // 鼠标跟随 + 幅度（读 Live2DCall 的真实状态；没有它时回落到存储值）
    const follow = $('gsMouseFollow');
    const scale = $('gsMouseScale');
    const scaleVal = $('gsMouseScaleVal');
    const scaleText = (v) => '×' + (Number(v) / 10).toFixed(1);
    if (follow) {
        follow.checked = typeof call()?.getMouseFollow === 'function'
            ? !!call().getMouseFollow() : get('mouseFollow', '1') !== '0';
        follow.addEventListener('change', () => {
            const a = call();
            if (a && typeof a.setMouseFollow === 'function') a.setMouseFollow(follow.checked);
            else set('mouseFollow', follow.checked ? '1' : '0');
        });
    }
    if (scale) {
        const cur = typeof call()?.getMouseFollowScale === 'function'
            ? Number(call().getMouseFollowScale()) : Number(get('mouseFollowScale', 10));
        scale.value = String(Number.isFinite(cur) ? Math.max(0, Math.min(10, Math.round(cur))) : 10);
        if (scaleVal) scaleVal.textContent = scaleText(scale.value);
        scale.addEventListener('input', () => {
            if (scaleVal) scaleVal.textContent = scaleText(scale.value);
            const a = call();
            if (a && typeof a.setMouseFollowScale === 'function') a.setMouseFollowScale(Number(scale.value));
            else set('mouseFollowScale', scale.value);
        });
    }
    const reset = $('gsResetModel');
    if (reset) reset.addEventListener('click', () => {
        const a = call();
        if (a && typeof a.resetModelView === 'function') { a.resetModelView(); return; }
        try { localStorage.removeItem(P + 'resize'); } catch (e) { /* 忽略 */ }
        host.alert('模型的大小与位置会在下次打开情景演绎时重新自适应。', '已重置');
    });

    // ── ③ 背景 ────────────────────────────────────────────────
    const bgInput = $('gsBgImage');
    const bgClear = $('gsBgClear');
    if (bgInput) {
        bgInput.addEventListener('change', () => {
            const file = bgInput.files && bgInput.files[0];
            if (!file) return;
            if (!/^image\//.test(file.type)) { host.alert('请选择图片文件。', '背景'); return; }
            const reader = new FileReader();
            reader.onload = () => {
                const value = 'url("' + String(reader.result || '') + '")';
                // 与舞台的 sanitizeBackground 同一白名单：data: 图片是允许的
                try { localStorage.setItem(P + 'bg', value); } catch (e) { /* 太大存不下 */ }
                const a = call();
                if (a && typeof a.setBackground === 'function') a.setBackground(value);
            };
            reader.onerror = () => host.error('背景图片读取失败');
            reader.readAsDataURL(file);
        });
    }
    if (bgClear) {
        bgClear.addEventListener('click', () => {
            try { localStorage.removeItem(P + 'bg'); } catch (e) { /* 忽略 */ }
            const a = call();
            if (a && typeof a.setBackground === 'function') a.setBackground('');
        });
    }

    // 场景背景图：资源包在就才显示这一块（点一张即设为舞台背景）。
    //   清单走资源包的 api.list()（返回 {file,label,url}），url 由它按真实目录算 ——
    //   插件不自拼 /mods/ 路径（目录名可能被用户改过）。
    (function renderScenes() {
        const wrap = $('gsBgScenesWrap');
        const grid = $('gsBgScenes');
        if (!wrap || !grid) return;
        const sb = host.require('scene-backgrounds');
        const raw = (sb && sb.ok && sb.api && typeof sb.api.list === 'function') ? (sb.api.list() || []) : [];
        if (!raw.length) return;
        wrap.classList.remove('hidden');
        grid.innerHTML = raw.map((s) => {
            const file = (s && s.file) || '';
            const label = (s && s.label) || file;
            const url = (s && s.url) || ((sb && typeof sb.api?.url === 'function') ? sb.api.url(file) : '');
            return '<button type="button" class="gs-scene" data-scene="' + esc(file) + '" title="' + esc(label) + '">'
                + (url ? '<img src="' + esc(url) + '" alt="" loading="lazy">' : '')
                + '<span>' + esc(label) + '</span></button>';
        }).join('');
        grid.querySelectorAll('[data-scene]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const file = btn.getAttribute('data-scene');
                const url = (sb && typeof sb.api?.url === 'function') ? sb.api.url(file) : '';
                if (!url) return;
                const value = 'url("' + url + '")';
                try { localStorage.setItem(P + 'bg', value); } catch (e) { /* 忽略 */ }
                const a = call();
                if (a && typeof a.setBackground === 'function') a.setBackground(value);
            });
        });
    })();

    // ── ④ 对话框 ──────────────────────────────────────────────
    const tw = $('gsTypewriter');
    if (tw) {
        tw.checked = get('typewriter', '1') !== '0';
        tw.addEventListener('change', () => {
            set('typewriter', tw.checked ? '1' : '0');
            const a = call();
            if (a && typeof a.setTypewriter === 'function') a.setTypewriter(tw.checked);
        });
    }

    // 语音（朗读 / 语音输入）**不在这里设**：
    //   朗读默认开、没有开关（配了 TTS 就念，见 index-live2d.js 的说明）；
    //   语音输入用宿主「设置 → 语音」里配好的 ASR，舞台聊天框那一行的 🎤 直接用。
    //   这里一个开关都不放 —— 多一份开关就多一份"两边不一致"的来源。

    // ── ⑤ 试一下 ──────────────────────────────────────────────
    const test = $('gsTest');
    if (test) test.addEventListener('click', () => {
        const a = call();
        if (a && typeof a.open === 'function') { a.open(); return; }
        host.alert('情景演绎还没装配好（Live2D 组件没起来）。刷新页面后再试。', '情景演绎');
    });
}

window.__live2dInitSettingsPanel = initLive2DSettingsPanel;
