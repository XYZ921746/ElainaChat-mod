/* ============================================================================
 * 技能列表 / README 查看（从 settings.js 拆分）
 *
 * 技能卡片、刷新、说明弹窗与技能 / 插件 README 读取。
 * ========================================================================== */
'use strict';

/**
 * 渲染「设置 → 插件」页面里的**技能（skill）**列表。
 *
 * 技能与插件是两回事，所以这里既不合并进 #modsList，也不用插件的数据源：
 *   它是同一张卡片里、插件列表下方的**独立一屏**，数据来自 /api/skills。
 *   混在一起会让"插件列表"里冒出本不该在那儿的项，而且两者卸载方式不同。
 *
 * 每项显示：名称 / 描述 / 来源 + 查看 / 卸载。
 *   · 来源 —— 本地技能标「本地」；插件随附的标「来自插件 <owner>」。
 *   · 查看 —— 读 SKILL.md（GET /api/skills/<id>/content），复用现有说明弹窗 #modReadme*。
 *   · 卸载 —— **只有本地技能**才给按钮：插件随附的技能住在插件目录里，
 *           删插件就一起没了；单独给它一个删除按钮只会误导（点了也删不掉）。
 *
 * 由 refreshModsList() 顺带触发（见那里的说明），所以用户每次打开设置都能看到最新的。
 */
function renderSkillCard(s) {
    const id = escapeHtml(s.id);
    const name = escapeHtml(s.name || s.id);
    const glyph = escapeHtml(Array.from(String(s.name || '✦').trim())[0] || '✦');
    const desc = (window.ElainaReadme && window.ElainaReadme.inline)
        ? window.ElainaReadme.inline(s.description || '')
        : escapeHtml(s.description || '');
    const isLocal = s.source === 'local';
    const srcLabel = isLocal
        ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600 ml-1">本地</span>'
        : '<span class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-500 ml-1">来自插件 '
            + escapeHtml(s.owner || '') + '</span>';
    // 卸载按钮只在本地技能上给；随附技能只留一句说明（否则按钮点了也没用）
    const delBtn = isLocal
        ? '<button type="button" class="mod-act mod-act-danger skill-del-btn" data-skill-id="' + id + '"'
            + ' data-skill-name="' + name + '" title="卸载这个技能（含安装包）">' + ICON.trash + '</button>'
        : '<span class="text-[10px] text-indigo-300 ml-1" title="插件随附的技能住在插件目录里，删掉插件就一起没了">随插件删除</span>';

    return '<div class="mod-card" data-fullwidth="' + (desc ? '1' : '0') + '" data-skill-id="' + id + '">'
        + '<span class="mod-avatar" aria-hidden="true">' + glyph + '</span>'
        + '<div class="min-w-0 flex-1">'
          + '<div class="flex items-start gap-2">'
            + '<div class="min-w-0 flex-1">'
              + '<span class="text-xs font-semibold text-indigo-800">' + name + '</span>' + srcLabel
              + (desc ? '<div class="mod-desc text-[11px] text-indigo-400 leading-relaxed mt-0.5">' + desc + '</div>' : '')
            + '</div>'
          + '</div>'
          + '<div class="flex items-center gap-1.5 mt-2">'
            + '<button type="button" class="mod-act skill-view-btn" data-skill-id="' + id + '"'
              + ' data-skill-name="' + name + '" title="查看 SKILL.md">' + ICON.doc + '</button>'
            + delBtn
          + '</div>'
        + '</div>'
        + '</div>';
}

async function refreshSkillsList() {
    const box = document.getElementById('skillsList');
    if (!box) return;
    const hint = document.getElementById('skillsHint');
    const setHint = (text, cls) => {
        if (hint) { hint.textContent = text; hint.className = 'text-[11px] ' + (cls || 'text-indigo-400'); }
    };

    let skills = [];
    try {
        const res = await fetch('/api/skills', { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            skills = Array.isArray(data && data.skills) ? data.skills : [];
        }
    } catch (e) {
        // 与插件列表同理：APK 端没有服务端时这个接口不存在，属正常，不必惊动用户
        box.innerHTML = '';
        return;
    }
    // 列表拿到就把技能同步进操作注册表（见 agent.js 的 syncSkillKnowledge）——
    //   让它在这里调一次，是为了"刚装完 / 刚卸完"能当场反映到模型看到的能力索引里，
    //   而不是等下次刷新页面。技能只会注册成 kind:'knowledge'（纯资料），**永不可执行**。
    void syncSkillKnowledge();
    // 注：这里**不会**出现系统级条目（内置 Agent 能力），因为那些只由代码注册、
    //   不落盘到 skills/ —— 换句话说"系统级自动隐藏"是结构上成立的，不需要过滤一遍。

    if (!skills.length) {
        box.innerHTML = '<div class="text-[11px] text-indigo-300 py-2 text-center">还没有技能。'
            + '把含 <code>SKILL.md</code> 的目录放进项目的 skills/，或点上面的「上传安装」选一个 zip。</div>';
        return;
    }

    box.innerHTML = skills.map(renderSkillCard).join('');

    // 查看 → 读 SKILL.md 并显示在说明弹窗里
    box.querySelectorAll('.skill-view-btn').forEach((el) => {
        el.addEventListener('click', () => {
            void openSkillContent(el.getAttribute('data-skill-id'), el.getAttribute('data-skill-name'));
        });
    });

    // 卸载（仅本地技能）→ DELETE /api/skills/<id>
    box.querySelectorAll('.skill-del-btn').forEach((el) => {
        el.addEventListener('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const id = el.getAttribute('data-skill-id');
            const name = el.getAttribute('data-skill-name') || id;
            const okToGo = await showCustomConfirm(
                '卸载技能「' + name + '」？\n\n'
                + '会把技能目录和安装包一起删掉（下次打开设置不会再出现）。\n\n'
                + '注意：插件随附的技能不能这样卸 —— 它们住在插件目录里，要连同那个插件一起删。',
                '卸载技能');
            if (!okToGo) return;

            el.disabled = true;
            setHint('正在卸载 ' + name + '…', 'text-indigo-500');
            try {
                const res = await fetch('/api/skills/' + encodeURIComponent(id), { method: 'DELETE' });
                const data = await res.json().catch(() => null);
                if (!res.ok || !data || data.ok === false) {
                    setHint('卸载失败：' + ((data && data.message) || ('HTTP ' + res.status)), 'text-red-500');
                } else {
                    setHint('已卸载 ' + name, 'text-emerald-600');
                    void refreshSkillsList();
                }
            } catch (err) {
                setHint('卸载失败：' + String((err && err.message) || err), 'text-red-500');
            } finally {
                el.disabled = false;
            }
        });
    });
}

/**
 * 把一份 Markdown 文本渲染进说明弹窗（插件 README 与技能 SKILL.md 共用）。
 *
 * 为什么集中在这一处：两个入口过去各拼各的，一个显示纯文本、另一个复用同一个
 * 容器却也用 textContent —— 排版全靠等宽字体。现在都走 readme-view.js 的渲染器，
 * 这里只负责标题、元信息、目录与"空文件/读失败"这类非正常状态。
 *
 * @param {string} text      Markdown 原文
 * @param {{label:string, file?:string}} meta 标题（插件名/技能名）与文件名
 */
function renderReadmeDoc(text, meta) {
    const overlay = document.getElementById('modReadmeOverlay');
    const body = document.getElementById('modReadmeBody');
    const title = document.getElementById('modReadmeTitle');
    const fileEl = document.getElementById('modReadmeFile');
    const toc = document.getElementById('modReadmeToc');
    const scroll = document.getElementById('modReadmeScroll');
    if (!overlay || !body) return;

    const R = window.ElainaReadme;
    const src = String(text == null ? '' : text);
    if (title) title.textContent = meta.label + ' · 说明';
    if (fileEl) {
        const st = R ? R.stats(src) : null;
        const parts = [];
        if (meta.file) parts.push(meta.file);
        if (st && st.lines) parts.push(st.lines + ' 行', st.chars + ' 字');
        fileEl.textContent = parts.join(' · ');
    }
    // 目录：标题里没有 Markdown 就整块留空（`.readme-toc:empty` 会被 CSS 收掉）
    if (toc) {
        const items = R ? R.outline(src) : [];
        toc.innerHTML = items.length
            ? '<div class="readme-toc-head">在本页</div>'
                + items.map((it, k) => '<a href="#" data-toc="' + k + '" class="'
                    + (it.level >= 3 ? 'is-sub' : '') + '">' + escapeHtml(it.text) + '</a>').join('')
            : '';
        toc.querySelectorAll('a[data-toc]').forEach((a) => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                const target = body.querySelectorAll('.rmd-h2, .rmd-h3')[Number(a.getAttribute('data-toc'))];
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });
    }
    if (scroll) scroll.scrollTop = 0;
    body.innerHTML = src.trim() && R ? R.render(src) : '';
    if (!body.innerHTML) body.innerHTML = '<div class="readme-empty">（空文件）</div>';
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
}

/** 说明弹窗里的非正文状态（读失败 / 没有 README / 正在读取） */
function showReadmeNotice(kind, message, label) {
    const overlay = document.getElementById('modReadmeOverlay');
    const body = document.getElementById('modReadmeBody');
    const title = document.getElementById('modReadmeTitle');
    const fileEl = document.getElementById('modReadmeFile');
    const toc = document.getElementById('modReadmeToc');
    if (!overlay || !body) return;
    if (title) title.textContent = (label || '插件') + ' · 说明';
    if (fileEl) fileEl.textContent = '';
    if (toc) toc.innerHTML = '';
    const esc = (s) => escapeHtml(String(s == null ? '' : s));
    body.innerHTML = kind === 'loading'
        ? '<div class="readme-loading">正在读取…</div>'
        : '<div class="readme-empty">' + esc(message).replace(/\n/g, '<br>') + '</div>';
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
}

/**
 * 查看单个技能：读它的 SKILL.md 并显示在**复用**的说明弹窗（#modReadme*）里。
 *
 * 为什么复用插件 README 那个弹窗而不是再造一个：那套已经处理了滚动、深色模式、
 * 关闭逻辑，再造第二套只是维护两份一样的壳。技能内容就是一段 markdown 文本，
 * 与 README 的展示诉求完全一致。
 *
 * 走 /api/skills/<id>/content（服务端反查已注册技能后读文件，前端传不了任意路径）。
 */
async function openSkillContent(id, name) {
    showReadmeNotice('loading', '', name);
    try {
        // id 可能含斜杠（插件随附技能是 owner/rel），encodeURIComponent 会把它编成 %2F，
        // 服务端按整段捕获再解回来 —— 与插件 README 那种单段 id 的处理一致。
        const res = await fetch('/api/skills/' + encodeURIComponent(id) + '/content', { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.ok) {
            renderReadmeDoc(String(data.text || ''), { label: name + ' · 技能', file: data.name || 'SKILL.md' });
        } else {
            showReadmeNotice('error', (data && data.message) || ('HTTP ' + res.status), name + ' · 技能');
        }
    } catch (err) {
        showReadmeNotice('error', '读取失败：' + String((err && err.message) || err), name + ' · 技能');
    }
}

/**
 * 打开插件 README 弹窗。
 *
 * 走 /api/plugins/<id>/readme（服务端按白名单文件名读，见 server/mods.mjs）。
 * 没有 README 时服务端回 404，这里明确提示"该插件没有 README 文件"。
 */
async function openModReadme(id, name) {
    showReadmeNotice('loading', '', name);
    try {
        const res = await fetch('/api/plugins/' + encodeURIComponent(id) + '/readme', { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.ok) {
            renderReadmeDoc(String(data.text || ''), { label: name, file: data.name || 'README' });
        } else {
            const msg = (data && data.message) || ('HTTP ' + res.status);
            showReadmeNotice('error', /没有 README/.test(msg)
                ? '该插件没有 README 文件。\n\n插件作者可以在插件目录里放一个 README.md 来提供说明。'
                : msg, name);
        }
    } catch (err) {
        showReadmeNotice('error', '读取失败：' + String((err && err.message) || err), name);
    }
}

