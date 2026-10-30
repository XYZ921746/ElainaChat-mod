/* ============================================================================
 * Live2D 引擎与模型 —— 模型管理界面
 *
 * 这个面板原先住在「Live2D 视频通话」里（叫「已上传模型 / 上传新模型」）。
 * 2026-10 按用户要求搬到资源包这边：**谁拥有资产，谁负责管理**。
 *   · 资源包（本文件所在）：上传 / 重命名 / 删除 / 看引擎状态
 *   · 视频通话（live2d）：只选「用哪个」，以及通话时的表现
 * 好处：卸载视频通话不会把模型一起带走；想换模型不必进视频通话。
 * ========================================================================== */
(function () {
    'use strict';

    /** 最近一次拉到的模型列表（重命名要用） */
    let modelList = [];

    /**
     * 用户拖出来的顺序（纯界面偏好）。
     *
     * 为什么存这里、而不是服务端：顺序**不影响模型本身**，只决定列表怎么排。
     *   放 Store 是为了跨设备一致（与插件页的顺序同一个道理）。
     * 键名必须也加进 store.js 的 DATA_KEYS，否则会被**静默丢弃**
     *   （setItem 只对白名单里的键入队推送，其余只写内存缓存 —— 刷新就没了）。
     * 声明放在文件顶部：下面 `sortBySavedOrder` 会在首次渲染时就被调用，
     *   而 const 没有提升 —— 放后面虽然"运行时刚好已执行"，但那是巧合，不是保证。
     */
    const ORDER_KEY = 'elaina_live2d_model_order';

    /**
     * 服务端返回的可能不是 JSON（例如服务还是旧版本时接口落到静态处理器，
     * 返回纯文本 "Not found"）。直接 res.json() 会抛
     * "Unexpected token 'N'..."，用户完全看不懂，所以统一兜一层。
     */
    async function readJsonSafe(res) {
        const text = await res.text();
        try { return JSON.parse(text); } catch { /* 非 JSON */ }
        return {
            ok: false,
            message: res.status === 404
                ? '服务端没有这个接口（HTTP 404）。多半是 serve.mjs 改了但服务没重启 —— 到 cmd 窗口按 Ctrl+C，再重新双击「启动.bat」。'
                : '服务端返回了非预期的内容（HTTP ' + res.status + '）：' + text.slice(0, 80),
        };
    }

    /** 把模型列表填进下拉框 */
        /**
     * 拉模型列表并渲染成卡片。
     *
     * 为什么用卡片而不是下拉框：下拉框只能"选一个名字"，
     *   而模型是有实体的东西 —— 有缩略图、有表情/动作数量、有体积。
     *   卡片能一眼看出"哪个是我要的那个"，与插件页的观感也统一。
     */
    async function refreshList(host) {
        const box = document.getElementById('l2dmModelCards');
        if (!box) return;
        try {
            const res = await fetch('/api/live2d/models', { cache: 'no-store' });
            const json = await readJsonSafe(res);
            modelList = json.models || [];
            renderModelCards(box, host);
        } catch (e) {
            box.innerHTML = '<div class="text-[11px] text-red-500 py-3">模型列表读取失败：'
                + String((e && e.message) || e) + '</div>';
            if (host) host.warn('模型列表读取失败', e);
        }
    }

    /** 人类可读的体积 */
    function fmtSize(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
        return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    /** 把模型渲染成卡片（与插件页同一套视觉）。
     * 这里是**资源管理**界面：上传/改名/删除/看体积。不显示"正在使用"——
     *    "当前用哪个"是消费方（视频通话）的状态，选择入口在它那边（2×2 图片区），
     *    这边再标一个只会让两边可能不一致。 */
    function renderModelCards(box, host) {
        if (!modelList.length) {
            box.innerHTML = '<div class="text-[11px] text-indigo-400 py-6 text-center">'
                + '还没有模型。用下面的「上传新模型」装一个（<code>.zip</code>，含 <code>.model3.json</code>）。'
                + '</div>';
            return;
        }

        // 按用户拖出来的顺序排（没存过就保持服务端原序）
        const ordered = sortBySavedOrder(modelList);

        box.innerHTML = ordered.map((m) => {
            const name = esc(m.name);
            // 缩略图 URL：服务端给的是**相对模型根目录**的路径（如 icon.png），
            // 这里拼成完整地址。走 assetUrl —— 它按真实安装目录算，
            // 不写死 /mods/live2d-models/（目录名可能被用户改过）。
            const icon = (m.icon && window.ElainaLive2DModels
                && typeof window.ElainaLive2DModels.assetUrl === 'function')
                ? window.ElainaLive2DModels.assetUrl(m.name, m.icon, m.bundled)
                : '';
            const initial = esc(String(m.name || '?').slice(0, 1));
            // 缩略图：拿不到图就显示名字首字作为占位，不留白框。
            // onerror 也回落到占位 —— 贴图可能是 .2048（Cubism 纹理，浏览器认不出），
            // 那种情况下 <img> 会失败，不能留一个破图。
            const fallback = '<div class="w-full h-full flex items-center justify-center text-lg text-indigo-300">'
                + initial + '</div>';
            const thumb = icon
                ? '<img src="' + icon + '" alt="" class="w-full h-full object-cover" loading="lazy"'
                    + ' onerror="this.onerror=null;this.parentNode.innerHTML=this.dataset.fb;"'
                    + ' data-fb="' + fallback.replace(/"/g, '&quot;') + '">'
                : fallback;

            return '<div class="mod-card" data-model-name="' + name + '">'
                // 拖拽手柄（三条竖线，与插件页一致）
                + '<button type="button" class="mod-grip" title="按住拖动可调整顺序" aria-label="拖动排序">'
                  + '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></button>'
                // 缩略图
                + '<div class="flex-none w-14 h-14 rounded-xl overflow-hidden bg-white/60 flex items-center justify-center">' + thumb + '</div>'
                + '<div class="min-w-0 flex-1">'
                  + '<span class="text-xs font-semibold text-indigo-800">' + name + '</span>'
                  + '<div class="text-[11px] text-indigo-400 leading-relaxed mt-0.5">'
                    + (m.exps ? m.exps.length : 0) + ' 个表情 · '
                    + (m.motions ? m.motions.length : 0) + ' 个动作 · '
                    + fmtSize(m.sizeBytes) + ' · ' + (m.fileCount || 0) + ' 个文件'
                    + (m.vtube ? ' · 带 vtube' : '')
                  + '</div>'
                  + '<div class="flex items-center gap-1.5 mt-2">'
                    + '<button type="button" class="mod-act mod-l2dm-folder" data-name="' + name + '" title="在文件管理器里打开这个模型的文件夹">'
                      + '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg></button>'
                    + '<button type="button" class="mod-act mod-l2dm-rename" data-name="' + name + '" title="重命名（改文件夹名）">'
                      + '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5h6M4 20h16M13.5 4.5l4 4L8 18H5v-3l8.5-10.5z"/></svg></button>'
                    + '<button type="button" class="mod-act mod-act-danger mod-l2dm-del" data-name="' + name + '" title="删除这个模型（整个文件夹）">'
                      + '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0l1 13h8l1-13"/></svg></button>'
                  + '</div>'
                + '</div>'
                + '</div>';
        }).join('');

        // ---- 拖拽排序：复用宿主实现（与插件页同一套手感）----
        // 只改**显示顺序**；模型目录本身不动（顺序纯属界面偏好）。
        if (typeof host.dragSort === 'function') {
            host.dragSort(box, (ids) => {
                try {
                    Store.setItem(ORDER_KEY, JSON.stringify(ids));
                    if (Store && typeof Store._flush === 'function') Store._flush();
                } catch (e) { /* 存不下只影响下次打开的顺序，不影响本次 */ }
            });
        }

        // 绑定按钮
        // 「设为当前」的勾按钮已删除：选择模型归属**消费方**
        //   （视频通话的 2×2 图片选择区），资源包这边不该再有第二处选择入口 ——
        //   两个地方都能选，用户会困惑"到底哪边算数"。
        box.querySelectorAll('.mod-l2dm-rename').forEach((b) => {
            b.addEventListener('click', () => renameModel(b.getAttribute('data-name'), host));
        });
        box.querySelectorAll('.mod-l2dm-del').forEach((b) => {
            b.addEventListener('click', () => deleteModel(b.getAttribute('data-name'), host));
        });
        // 打开这个模型的文件夹 —— 走 host.openFolder（路径白名单在宿主那侧，
        // 插件只说"我想开我自己目录下的 models/<名>"）。仅本机可用。
        box.querySelectorAll('.mod-l2dm-folder').forEach((b) => {
            b.addEventListener('click', async () => {
                const n = b.getAttribute('data-name');
                b.disabled = true;
                try {
                    const r = await host.openFolder('models/' + n);
                    if (!r.ok) {
                        host.alert('打开文件夹失败：' + (r.message || '未知原因')
                            + '\n\n（这个功能只有在本机、且服务端正在运行时可用）', '打开文件夹');
                    }
                } finally {
                    b.disabled = false;
                }
            });
        });
    }

    /**
     * 按用户存下的顺序排；没记过的排后面（保持服务端原序）
     */
    function sortBySavedOrder(list) {
        let order = [];
        try {
            const raw = JSON.parse((window.Store && Store.getItem(ORDER_KEY)) || '[]');
            if (Array.isArray(raw)) order = raw;
        } catch (e) { /* 解析失败就当没存过 */ }
        if (!order.length) return list;
        return list.slice().sort((a, b) => {
            const ia = order.indexOf(a.name), ib = order.indexOf(b.name);
            if (ia < 0 && ib < 0) return 0;
            if (ia < 0) return 1;
            if (ib < 0) return -1;
            return ia - ib;
        });
    }

    /** HTML 转义（模型名是用户可控的，直接拼进 innerHTML 会出问题） */
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** 重命名：真改文件夹（目录名即显示名） */
    async function renameModel(oldName, host) {
        if (!oldName) return;
        let next = null;
        try {
            next = window.prompt('给这个模型起个新名字（直接改文件夹名，中文/空格都行）：', oldName);
        } catch (e) {
            host.warn('无法弹出输入框', e);
            return;
        }
        if (next === null) return;            // 取消
        const desired = String(next).trim();
        if (!desired || desired === oldName) return;
        try {
            const res = await fetch('/api/live2d/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: oldName, displayName: desired }),
            });
            const json = await readJsonSafe(res);
            if (!json.ok) { host.alert(json.message || '重命名失败', '重命名失败'); return; }
            const newName = json.newName || desired;
            if (newName !== desired) {
                host.alert('「' + desired + '」已被占用，已改为「' + newName + '」。', '重命名完成');
            }
            // 迁移"按模型名存的东西"（缩放/水印/跟随）+ 刷新通话界面的下拉
            if (window.Live2DCall && typeof window.Live2DCall.applyRenamedModel === 'function') {
                try { await window.Live2DCall.applyRenamedModel(oldName, newName); } catch (e) { /* 忽略 */ }
            }
            await refreshList(host);
        } catch (e) {
            host.alert('重命名失败：' + String((e && e.message) || e), '重命名失败');
        }
    }

    /** 删除：整个模型目录 */
    async function deleteModel(name, host) {
        if (!name) return;
        const okToGo = await host.confirm(
            '确定删除模型「' + name + '」？\n\n会把这个模型的文件夹整个删掉，无法恢复。', '删除模型');
        if (!okToGo) return;
        try {
            const res = await fetch('/api/live2d/models/' + encodeURIComponent(name), { method: 'DELETE' });
            const json = await readJsonSafe(res);
            if (json.ok) await refreshList(host);
            else host.alert('删除失败：' + (json.message || ''), '删除失败');
        } catch (e) {
            host.alert('删除失败：' + String((e && e.message) || e), '删除失败');
        }
    }

    /** 引擎状态：告诉用户"能不能用"，而不是只列模型（引擎没就绪时模型也用不了） */
    function renderEngineStatus() {
        const box = document.getElementById('l2dmEngineStatus');
        if (!box) return;
        const ready = window.ElainaLive2DModels && window.ElainaLive2DModels.engineReady
            ? window.ElainaLive2DModels.engineReady() : false;
        box.textContent = ready
            ? '引擎已加载（打开视频通话时会自动按需加载三分之一个包的量级，这里是已就绪状态）'
            : '引擎尚未加载 —— 首次打开视频通话时才会按需注入（约 787 KB）';
        box.className = 'text-[11px] leading-relaxed ' + (ready ? 'text-emerald-600' : 'text-indigo-400');
    }

    /** 渲染整个面板（首次打开时调用一次） */
    function renderPanel(container, host) {
        container.innerHTML = `
            <section>
                <div class="modal-label flex items-center gap-2"><span class="text-pink-500">✦</span> Live2D 引擎与模型</div>
                <p class="text-[11px] text-indigo-300 leading-relaxed mb-3">
                    这里是模型资源的宿主：上传 / 重命名 / 删除都在这做。
                    「Live2D 视频通话」只是消费方 —— 它那边选一个模型来用。
                    模型仅存本地，不会上传到仓库。
                </p>
                <div id="l2dmEngineStatus" class="text-[11px] text-indigo-400 leading-relaxed mb-3"></div>

                <div class="space-y-3">
                    <div>
                        <label class="text-xs text-indigo-500 mb-1 block">模型列表</label>
                        <!-- 卡片式（与插件页同风格）：缩略图 + 名字 + 表情/动作数 + 体积 + 一排图标按钮 -->
                        <div id="l2dmModelCards" class="space-y-2"></div>
                        <p class="text-[11px] text-indigo-300 leading-relaxed mt-2">
                            模型名就是它的文件夹名（上传时取 zip 里的文件夹名，拿不到才用
                            <code>model_xxx</code> 这类 id）。改中文、带空格都可以；
                            该模型的缩放/水印设置会一起迁移。
                        </p>
                    </div>
                    <div>
                        <label class="text-xs text-indigo-500 mb-1 block">上传新模型（.zip）</label>
                        <div class="flex items-center gap-2">
                            <input id="l2dmUpload" type="file" accept=".zip,application/zip"
                                class="modal-input text-sm min-w-0 file:mr-2 file:rounded-lg file:border-0 file:bg-indigo-100 file:px-3 file:py-1.5 file:text-indigo-600 file:cursor-pointer">
                            <span id="l2dmUploadStatus" class="text-[11px] text-indigo-300"></span>
                        </div>
                        <p class="text-[11px] text-indigo-300 leading-relaxed mt-1">
                            zip 里要有 <code>.model3.json</code>（Cubism 3/4 模型）。
                            上传后 zip 里的文件夹名会成为模型名。
                        </p>
                    </div>
                </div>
            </section>
        `;

        renderEngineStatus();
        void refreshList(host);

        document.getElementById('l2dmUpload')?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            const status = document.getElementById('l2dmUploadStatus');
            if (!file || !status) return;
            status.textContent = '上传中…';
            status.className = 'text-[11px] text-indigo-300';
            try {
                const res = await fetch('/api/live2d/upload', { method: 'POST', body: file });
                const json = await readJsonSafe(res);
                if (json.ok) {
                    // 服务端会跳过 .html/.js/.svg 等类型（防上传后被同源执行）。
                    // 必须告诉用户跳过了什么，否则"上传成功"却少了文件会很难排查。
                    const skipped = Array.isArray(json.blocked) ? json.blocked : [];
                    status.textContent = '✅ 已上传：' + json.modelName
                        + (skipped.length ? '　已跳过 ' + skipped.length + ' 个不允许的文件：' + skipped.join('、') : '');
                    status.className = 'text-[11px] text-emerald-600';
                    await refreshList(host);
                } else {
                    status.textContent = '❌ ' + (json.message || '失败');
                    status.className = 'text-[11px] text-red-500';
                }
            } catch (err) {
                status.textContent = '❌ ' + String((err && err.message) || err);
                status.className = 'text-[11px] text-red-500';
            }
            e.target.value = '';
        });
    }


    /** 暴露给 register：由它挂到 settings.modal 插槽 */
    window.__l2dmRenderPanel = renderPanel;
    window.__l2dmRefresh = refreshList;
})();