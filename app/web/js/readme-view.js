/* ============================================================================
 * Markdown 渲染（两处共用：聊天消息、插件 README / 技能说明）
 *
 * 为什么自己写而不引 marked / markdown-it：
 *   本体零构建、零依赖，为渲染拉一个几十 KB 的解析库不划算；这里覆盖
 *   实际会用到的子集（标题 / 段落 / 列表 / 表格 / 代码 / 引用 / 分隔线 /
 *   行内强调与链接 / 任务列表）。
 *
 * ★ 安全边界：输入是**第三方内容**（模型回复、插件作者写的 README）。
 *   所以这里**不保留任何原始 HTML** —— 所有文本都先 escape 再拼标签，
 *   渲染结果是宿主自己拼出来的一棵已知标签树，不存在注入路径。
 *   链接只放行 http / https / mailto / 页内锚点，其余（javascript: / data:）
 *   降级成纯文本。这与"先 escapeHtml 再交给 marked"是同一个思路，
 *   只是这里连 marked 那一层也省掉了。
 * ========================================================================== */
(function () {
    'use strict';

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 只放行明确安全的协议；返回 null 表示"不要做成链接" */
    function safeHref(raw) {
        const url = String(raw || '').trim();
        if (!url) return null;
        if (/^(https?:|mailto:)/i.test(url)) return url;
        if (url.startsWith('#')) return url;          // 页内锚点
        return null;
    }

    /**
     * 行内渲染：代码 → 链接 → 强调。
     *
     * 顺序要紧：先把反引号里的内容换成占位符，避免 `**不**是强调` 这种
     * 代码里的星号被当成强调；最后再把占位符换回来（已是 escape 过的文本）。
     * 链接 → 强调的顺序也有讲究：地址里含 `_` / `*` 的（例如带下划线的路径）
     * 若先跑强调正则，会被改写成 `<em>` 塞进 href，链接就断了。
     */
    function inline(text) {
        const codes = [];
        let s = esc(text).replace(/`([^`]+)`/g, (_, code) => {
            codes.push(code);
            return '\u0000' + (codes.length - 1) + '\u0000';
        });
        // 链接：[文本](地址) —— 地址不允许出现空格，够覆盖 README 的实际用法
        s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
            const url = safeHref(href.replace(/&amp;/g, '&'));
            if (!url) return label;
            return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + inlineEmphasis(label) + '</a>';
        });
        // 裸网址（README 里常直接写地址）：只处理还没被上面的链接吃掉的
        s = s.replace(/(^|[\s（(])(https?:\/\/[^\s<)）]+)/g, (m, pre, url) =>
            pre + '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + url + '</a>');
        s = inlineEmphasis(s);
        return s.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[Number(i)] + '</code>');
    }

    /** 只含行内强调（不含链接）：给已经安全嵌进 `<a>` 的文本用 */
    function inlineEmphasis(s) {
        return String(s)
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/__([^_]+)__/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
            .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    }

    /** 表格行拆单元格：支持首尾竖线，不支持单元格内竖线转义（README 实际用不到） */
    function splitRow(line) {
        let s = String(line || '').trim();
        if (s.startsWith('|')) s = s.slice(1);
        if (s.endsWith('|')) s = s.slice(0, -1);
        return s.split('|').map((c) => c.trim());
    }

    const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

    function render(text) {
        const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
        const out = [];
        // 开放中的列表：标签 + 是否有序。Markdown 的列表可以嵌套，但 README 里
        //   基本都是单层；这里按"缩进变化就闭合重开"处理，够用且不会串层。
        let listTag = null;
        let i = 0;

        const closeList = () => { if (listTag) { out.push('</' + listTag + '>'); listTag = null; } };
        const openList = (tag) => {
            if (listTag === tag) return;
            closeList();
            out.push('<' + tag + ' class="rmd-list">');
            listTag = tag;
        };

        while (i < lines.length) {
            const raw = lines[i];
            const line = raw.replace(/\s+$/, '');

            // 空行：结束当前列表，段落由块级元素自然分隔
            if (!line.trim()) { closeList(); i++; continue; }

            // ---- 代码块 ----
            const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
            if (fence) {
                closeList();
                const marker = fence[1];
                const lang = fence[2] || '';
                const buf = [];
                i++;
                while (i < lines.length && !new RegExp('^\\s*' + marker + '\\s*$').test(lines[i])) {
                    buf.push(lines[i]);
                    i++;
                }
                i++;   // 跳过收尾的 fence
                out.push('<div class="rmd-code">'
                    + (lang ? '<span class="rmd-code-lang">' + esc(lang) + '</span>' : '')
                    + '<pre><code>' + esc(buf.join('\n')) + '</code></pre></div>');
                continue;
            }

            // ---- 标题（# 1-6）----
            const h = /^(#{1,6})\s+(.*)$/.exec(line);
            if (h) {
                closeList();
                const level = h[1].length;
                // 一级标题就是窗口标题已经写过的插件名，正文里不再重复放大
                const tag = level === 1 ? 'h2' : 'h' + Math.min(level, 6);
                out.push('<' + tag + ' class="rmd-h rmd-h' + level + '">' + inline(h[2].replace(/\s+#+\s*$/, '')) + '</' + tag + '>');
                i++;
                continue;
            }

            // ---- 分隔线 ----
            if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
                closeList();
                out.push('<hr class="rmd-hr">');
                i++;
                continue;
            }

            // ---- 表格：当前行像表头、下一行是分隔行 ----
            if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
                closeList();
                const head = splitRow(line);
                i += 2;
                const body = [];
                while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
                    body.push(splitRow(lines[i]));
                    i++;
                }
                out.push('<div class="rmd-table-wrap"><table class="rmd-table"><thead><tr>'
                    + head.map((c) => '<th>' + inline(c) + '</th>').join('')
                    + '</tr></thead><tbody>'
                    + body.map((row) => '<tr>' + head.map((_, k) => '<td>' + inline(row[k] || '') + '</td>').join('') + '</tr>').join('')
                    + '</tbody></table></div>');
                continue;
            }

            // ---- 引用块：连续的 > 行合为一段 ----
            if (/^\s*>\s?/.test(line)) {
                closeList();
                const buf = [];
                while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                    buf.push(lines[i].replace(/^\s*>\s?/, ''));
                    i++;
                }
                out.push('<blockquote class="rmd-quote">'
                    + buf.map((b) => (b.trim() ? inline(b) : '<br>')).join(' ')
                    + '</blockquote>');
                continue;
            }

            // ---- 列表项（- / * / + / 1.）----
            const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
            if (li) {
                openList(/^\d/.test(li[2]) ? 'ol' : 'ul');
                // 任务列表：- [ ] / - [x]
                const task = /^\[( |x|X)\]\s+(.*)$/.exec(li[3]);
                if (task) {
                    const done = task[1].toLowerCase() === 'x';
                    out.push('<li class="rmd-li rmd-task' + (done ? ' is-done' : '') + '">'
                        + '<span class="rmd-check" aria-hidden="true">' + (done ? '✓' : '') + '</span>'
                        + '<span>' + inline(task[2]) + '</span></li>');
                } else {
                    out.push('<li class="rmd-li">' + inline(li[3]) + '</li>');
                }
                i++;
                continue;
            }

            // ---- 普通段落：合并连续的普通行（Markdown 里单个换行不换段）----
            closeList();
            const buf = [line];
            i++;
            while (i < lines.length) {
                const n = lines[i];
                if (!n.trim()) break;
                if (/^\s*(#{1,6}\s|>|```|~~~|([-*+]|\d+[.)])\s)/.test(n)) break;
                if (n.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
                if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(n)) break;
                buf.push(n.replace(/\s+$/, ''));
                i++;
            }
            out.push('<p class="rmd-p">' + buf.map((b) => inline(b)).join('<br>') + '</p>');
        }
        closeList();
        return out.join('\n');
    }

    /**
     * 从 Markdown 里抽一个目录：标题（h2/h3）+ 数量。用于窗口顶部的「在本页」。
     * 只取二级/三级，一级是插件名本身，过多会让目录变成噪音。
     */
    function outline(text) {
        const items = [];
        const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
        let inFence = false;
        for (const line of lines) {
            if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
            if (inFence) continue;
            const m = /^(#{2,3})\s+(.*)$/.exec(line);
            if (!m) continue;
            items.push({ level: m[1].length, text: m[2].replace(/\s+#+\s*$/, '').trim() });
            if (items.length >= 12) break;
        }
        return items;
    }

    /** 一句话统计：给窗口头部显示"多长"，让用户在打开前就有个预期 */
    function stats(text) {
        const s = String(text || '');
        const lines = s ? s.split('\n').length : 0;
        const cn = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
        const words = (s.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length;
        return { lines, chars: s.length, reading: cn + words };
    }

    /**
     * 聊天消息的 HTML 渲染：**替换掉原先"先 escapeHtml 再交给 marked"那条路**。
     *
     * 为什么换：vendor 里的 marked 与页面其它脚本跑在同一个作用域，
     *   它一律把输入当 HTML 解析 —— 上游那套"先转义"只是把风险推给顺序，
     *   任何一处调用忘了先转义就漏；而聊天内容来自模型，模型输出可被对话内容影响。
     *   这里输入一律当**纯文本 Markdown**，原始 HTML 只会以字面量显示。
     *
     * 与原来的约定保持一致：没有 Markdown 特征时直接纯文本转义（长回复省一次解析），
     * 公式（$…$ / $$…$$）原样保留 —— escapeHtml 的职责交回宿主那一份，
     * 这样 &#96; 之类的实体不会被二次处理。
     *
     * @param {string} text 原始文本
     * @returns {string} 可安全插入 innerHTML 的 HTML
     */
    const HAS_MD = /(^|\n)\s*(#{1,6}\s|[-*+]\s|>\s|\u0060\u0060\u0060|---|\d+\.\s|\|)|(\*\*[^*]+\*\*|\u0060[^\u0060]+\u0060|\[[^\]]+\]\([^)]+\))/;
    function renderChat(text) {
        const raw = String(text == null ? '' : text);
        if (!HAS_MD.test(raw)) return esc(raw);
        return render(raw);
    }

    window.ElainaReadme = { render, outline, stats, inline, escapeHtml: esc, renderChat };
})();
