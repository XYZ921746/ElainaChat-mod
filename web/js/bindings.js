/* ============================================================================
 * 启动后事件绑定（从 init.js 拆分）
 *
 * 所有按钮 / 输入 / 弹窗 / 分栏的事件接线。只使用全局 elements 与业务函数。
 * ========================================================================== */
'use strict';

function bindAppEvents() {
    elements.micBtn.addEventListener('click', handleMicClick);
    elements.floatingMicBtn.addEventListener('click', handleMicClick);
    elements.floatingEndBtn.addEventListener('click', endListening);
    elements.floatingCancelBtn.addEventListener('click', cancelListening);

    elements.railSettingsBtn.addEventListener('click', openSettings);
    elements.closeSettings.addEventListener('click', closeSettingsPanel);
    elements.settingsOverlay.addEventListener('click', (e) => {
        if (e.target === elements.settingsOverlay) closeSettingsPanel();
    });
    // 设置是**改完即生效**：任何控件一变就自动落盘（bindSettingsAutoSave），
    //   关闭直接点 ✕。所以底部没有「取消 / 保存」按钮，也就没有它们的事件绑定。
    //   saveSettings() 仍在用 —— 由自动保存以 silent 模式调用。
    //   同样没有「恢复默认设置」：整体重置会把用户逐项调过的值一并抹掉。
    //   子项各自的"恢复默认"在各自控件旁，粒度更细也更安全。
    bindSettingsAutoSave();
    // 插件列表不设单独的刷新按钮：清单每次打开设置都会重扫一遍（见 settings.js 的
    //   openSettings → refreshModsList），装/删/停用插件之后界面本身也会跟着重画。
    //   再放一个"刷新"钮，做的是同一件事，只会让人犹豫该点哪个。

    // 插件：浏览目录 —— 打开 mods/ 文件夹，同时把里面的东西列出来。
    // 为什么"既打开又列出"：这个按钮叫「浏览目录」，用户点它期待的是**弹出文件夹**；
    //   而"能不能弹出"取决于服务进程能不能唤起系统文件管理器（远程会话、精简系统、
    //   全屏游戏把窗口盖住，都会让窗口"像是没出来"）。所以两件事都做：
    //   真的去开一次，同时把目录内容画在页面上 —— 无论窗口有没有出现，
    //   用户都能立刻看到结果，而不是面对一个"点了没反应"的按钮。
    // 必须绑在这里、而且绑在**不在 #modsList 里的**那个按钮上：
    //   · #modsList 的内容由 refreshModsList() 整块 innerHTML 重建，绑在里面的
    //     按钮会在下一次刷新后变成"没有监听器的灯泡"—— 看着在，点了没反应；
    //   · 同理不能写在 refreshModsList 里（每次刷新都会重绑，点一次触发 N 次）。
    document.getElementById('modsBrowseBtn')?.addEventListener('click', async () => {
        const hint = document.getElementById('modsHint');
        const btn = document.getElementById('modsBrowseBtn');
        const panel = document.getElementById('modsBrowseResult');
        const setHint = (text, cls) => setHintText(hint, text, cls);
        // 结果面板：可换行、等宽，路径再长也不会被挤出屏幕
        const showPanel = (html) => {
            if (!panel) return;
            panel.innerHTML = html;
            panel.classList.remove('hidden');
        };
        const esc = (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        btn.disabled = true;
        setHint('正在打开 mods/…');
        showPanel('<div class="text-[11px] text-indigo-500">正在打开 mods/ …</div>');
        try {
            // ① 真的去唤起文件管理器（不带 id = 打开 mods 根目录）
            let openMsg = '';
            let openOk = false;
            try {
                const r1 = await fetch('/api/plugins/open-folder', { method: 'POST', cache: 'no-store' });
                const d1 = await r1.json().catch(() => null);
                openOk = Boolean(r1.ok && d1 && d1.ok);
                openMsg = openOk
                    ? '已在文件管理器中打开'
                    : '文件管理器没能打开：' + ((d1 && d1.message) || ('HTTP ' + r1.status));
            } catch (e) {
                openMsg = '文件管理器没能打开：' + String((e && e.message) || e) + '（服务没在运行？）';
            }

            // ② 无论上一步成不成，都把目录内容列出来（这是"看得见"的那一半）
            let listHtml = '';
            try {
                const res = await fetch('/api/plugins/open-folder?dir=1', { method: 'POST', cache: 'no-store' });
                const data = await res.json().catch(() => null);
                if (!res.ok || !data || !data.ok) {
                    listHtml = '<div class="text-[11px] text-red-500">读取目录失败：'
                        + esc((data && data.message) || ('HTTP ' + res.status)) + '</div>';
                } else {
                    const list = Array.isArray(data.entries) ? data.entries : [];
                    const dirs = list.filter((e) => e.dir).map((e) => e.name);
                    const files = list.filter((e) => !e.dir).map((e) => e.name);
                    listHtml = '<div class="text-[11px] text-indigo-500 break-all">'
                        + '<b>路径</b>：' + esc(data.path || 'mods/') + '</div>'
                        + (list.length
                            ? (dirs.length
                                ? '<div class="text-[11px] text-indigo-500 mt-1"><b>文件夹</b>：'
                                    + dirs.map((d) => '<span class="inline-block bg-white/70 rounded px-1 mr-1 mb-0.5">' + esc(d) + '</span>').join('') + '</div>'
                                : '')
                              + (files.length
                                ? '<div class="text-[11px] text-indigo-400 mt-1"><b>其它文件</b>：' + esc(files.join('、')) + '</div>'
                                : '')
                            : '<div class="text-[11px] text-indigo-400 mt-1">（目录是空的）</div>');
                }
            } catch (e) {
                listHtml = '<div class="text-[11px] text-red-500">读取目录失败：'
                    + esc(String((e && e.message) || e)) + '（服务没在运行？）</div>';
            }

            showPanel('<div class="text-[11px] ' + (openOk ? 'text-emerald-600' : 'text-amber-600') + '">'
                + esc(openMsg) + '</div>' + listHtml);
            setHint(openOk ? '已打开 mods/' : '已列出 mods/（窗口没开，可照下面的路径手动打开）',
                openOk ? 'text-indigo-500' : 'text-amber-600');
        } finally {
            btn.disabled = false;
        }
    });

    // 插件：＋添加分栏。
    // 必须绑在这里（init 只执行一次）。绑在 refreshModsList 里的话，
    //   它每次刷新列表都会重跑一遍绑定：刷新 N 次就有 N 个 handler，
    //   点一次按钮会连续弹出 N 个输入框。
    document.getElementById('modsAddGroupBtn')?.addEventListener('click', async () => {
        const name = window.prompt('新分栏的名称：', '');
        if (name === null) return;
        const n = String(name).trim();
        if (!n) return;
        // readGroups/saveGroups 是 refreshModsList 闭包里的，这里拿不到 ——
        // 直接读写同一对 Store 键（键名约定见 settings.js）。
        const KEY = 'elaina_mods_groups';
        let gs = [];
        try {
            const v = JSON.parse(Store.getItem(KEY) || '[]');
            gs = Array.isArray(v) ? v.filter((g) => g && g.id) : [];
        } catch (e) { /* 忽略 */ }
        if (!gs.some((g) => g.id === '__ungrouped__')) {
            gs.unshift({ id: '__ungrouped__', name: '未分类', collapsed: false, fixed: true });
        }
        if (gs.some((g) => g.name === n)) {
            window.alert('已经有叫「' + n + '」的分栏了。');
            return;
        }
        gs.push({ id: 'g' + Date.now().toString(36), name: n, collapsed: false });
        Store.setItem(KEY, JSON.stringify(gs));
        // 新分栏插到**顶层混排的最前面**（用户要求：新建的应在最上面）。
        //   top_order 是渲染时的项顺序（卡片与分栏混排），不写的话渲染兜底
        //   会把新分栏追加到末尾。
        try {
            const TOP_KEY = 'elaina_mods_top_order';
            let top = [];
            try { top = JSON.parse(Store.getItem(TOP_KEY) || '[]'); } catch (e) { /* 忽略 */ }
            if (!Array.isArray(top)) top = [];
            top.unshift({ t: 'group', id: gs[gs.length - 1].id });
            Store.setItem(TOP_KEY, JSON.stringify(top));
        } catch (e) { /* 忽略 */ }
        if (typeof Store._flush === 'function') Store._flush();
        void refreshModsList();
    });
    // 插件：上传安装。
    // 为什么要有这条路：只靠"把 zip 拷进 mods/ 目录"的话，电脑上可行，
    // 但手机/平板用户碰不到文件系统（APK 更是连服务端都没有）。所以补一个
    // 应用内上传入口 —— 与"丢文件进目录"等价，只是换了个方式把 zip 交给服务端。
    // 传输方式：请求体直接是 zip 的原始字节（不是 multipart）。这样服务端
    // 不用写 multipart 解析、也不引依赖；前端用 fetch 把 File 当 body 发即可。
    document.getElementById('modsInstallBtn')?.addEventListener('click', () => {
        document.getElementById('modsFileInput')?.click();
    });
    document.getElementById('modsFileInput')?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        const hint = document.getElementById('modsHint');
        if (!file) return;
        const setHint = (text, cls) => setHintText(hint, text, cls);
        setHint('上传中…（' + Math.round(file.size / 1024) + ' KB）', 'text-indigo-500');
        try {
            const res = await fetch('/api/plugins/install?name=' + encodeURIComponent(file.name), {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: file,
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.ok) {
                setHint('安装失败：' + ((data && data.message) || ('HTTP ' + res.status)), 'text-red-500');
            } else {
                // 与**市场安装**那条路是同一个坑：装完不重扫，新插件就不在注册表里，
                //   于是"到上面打开开关即可启用"是句空话（那个开关点了也不生效）。
                //   见 mods.js 的 reload 说明。
                let reloaded = false;
                try {
                    if (window.ElainaMods && typeof window.ElainaMods.reload === 'function') {
                        await window.ElainaMods.reload();
                        reloaded = true;
                    }
                } catch (err) { /* 加载失败不该把"安装成功"说成失败 */ }
                setHint('✅ ' + (data.message || '已安装')
                    + (reloaded ? '，已加载生效' : '（刷新页面后生效）'), 'text-emerald-600');
                void refreshModsList();
            }
        } catch (err) {
            setHint('安装失败：' + String((err && err.message) || err), 'text-red-500');
        } finally {
            // 清空 input，否则同一个文件再选一次不会触发 change
            e.target.value = '';
        }
    });
    // 技能（skill）：上传安装。
    // 与上面「插件上传安装」**同一种做法**（请求体就是 zip 原始字节，末尾从 query 取
    // 技能名），也绑在这里的同一理由：init 只执行一次 —— 若绑在 refreshSkillsList
    // 里，每次刷新列表都会重绑一遍，点一次按钮触发 N 个 handler。
    // 技能**不是**插件：它走独立的 /api/skills/install，绝不复用 /api/plugins/install
    //   （混用会让技能被当成插件装进去，而那正是本功能要避免的事）。
    //   技能名 = zip 文件名去掉 .zip；服务端会再校验一遍（挡路径成分 + 白名单）。
    document.getElementById('skillsInstallBtn')?.addEventListener('click', () => {
        document.getElementById('skillsFileInput')?.click();
    });
    document.getElementById('skillsFileInput')?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        const hint = document.getElementById('skillsHint');
        if (!file) return;
        const setHint = (text, cls) => setHintText(hint, text, cls);
        setHint('上传中…（' + Math.round(file.size / 1024) + ' KB）', 'text-indigo-500');
        try {
            const res = await fetch('/api/skills/install?name=' + encodeURIComponent(file.name), {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: file,
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.ok) {
                setHint('安装失败：' + ((data && data.message) || ('HTTP ' + res.status)), 'text-red-500');
            } else {
                setHint('✅ ' + (data.message || '已安装'), 'text-emerald-600');
                void refreshSkillsList();
            }
        } catch (err) {
            setHint('安装失败：' + String((err && err.message) || err), 'text-red-500');
        } finally {
            // 清空 input，否则同一个文件再选一次不会触发 change
            e.target.value = '';
        }
    });

    // ===== 导航栏里的二次分栏（扩展 › 插件 / 技能 / MCP）=====
    // 子项点了要做**两件事**：切到「扩展」这一主分栏 + 切到对应子面板。
    //   只切子面板的话，用户若正停在「外观」页，点了子项看不出任何变化
    //   （面板根本没显示），会以为按钮坏了。
    document.querySelectorAll('.ext-nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            switchSettingsTab('tab-mods');
            switchExtTab(btn.dataset.extTab);
        });
    });

   // 点父项「扩展」：回到上次停的那一栏（没有记录时是「插件」）。
    //   为什么不让它自动绑在捕获阶段抢先处理：switchSettingsTab 由事件委托统一驱动，
    //   这里只在它之后补一次子栏恢复，顺序不影响结果。
    document.querySelector('#settingsExtNav .settings-tab-btn')?.addEventListener('click', () => {
        // 同步执行，**不能**延到微任务：switchSettingsTab 由事件委托驱动，
        //   两者的执行顺序不稳定；延后会让"读到的 active 状态"与"实际状态"错位，
        //   表现就是第一次点不展开、第二次才展开（实测）。
        // 语义是 **toggle**：已展开时再点一次要收起（并播收起动画），
        //   写死 forceOpen 会让"点第二次反而重播展开"，用户无法收起。
        const menu = document.querySelector('.ext-nav-children.ext-menu-floating');
        const isOpen = Boolean(menu && menu.classList.contains('is-open'));
        if (isOpen) {
            switchExtTab(state._extTab || 'ext-mod', { forceClose: true });
        } else {
            switchSettingsTab('tab-mods');
            switchExtTab(state._extTab || 'ext-mod', { forceOpen: true });
        }
    });

    syncExtMenuParent();
    // 转屏 / 拖窗口跨过断点时要跟着搬家，否则会出现"桌面布局里塞着窄屏的浮层"
    window.addEventListener('resize', syncExtMenuParent, { passive: true });

    // 窄屏的页内分段条（#extSegBar）：与导航子项操作同一套面板。
    // ===== 导航横向滚动时，让分支跟着「扩展」按钮走 =====
    //   分支挂在 #settingsPanel 下（为了不被滚动容器裁掉），是绝对定位的 ——
    //   导航横向滚动时按钮会移，分支不会，实测偏移 63px。
    //   所以监听导航的 scroll，重新算一次坐标。
    //   用 passive + rAF 合并：滚动事件每秒几十次，每次都读 getBoundingClientRect
    //   会强制同步布局，手机上能明显掉帧。
    (function followExtBranch() {
        const nav = document.getElementById('settingsTabNav');
        if (!nav) return;
        let raf = 0;
        const reposition = () => {
            raf = 0;
            const menu = document.querySelector('.ext-nav-children.ext-menu-floating');
            if (menu && menu.classList.contains('is-open') && typeof positionExtMenu === 'function') {
                positionExtMenu();
            }
        };
        nav.addEventListener('scroll', () => {
            if (raf) return;
            raf = requestAnimationFrame(reposition);
        }, { passive: true });
        // 窗口尺寸变化同理：转屏、拖窗口、软键盘弹出都会改变按钮位置，
        //   而分支的坐标是"算一次就固定"的（absolute + 内联变量）。
        window.addEventListener('resize', () => {
            if (raf) return;
            raf = requestAnimationFrame(reposition);
        }, { passive: true });
    })();

    // ===== MCP 服务器 =====
    document.getElementById('mcpAddBtn')?.addEventListener('click', () => void editMcpServer(-1));
    document.getElementById('mcpRefreshBtn')?.addEventListener('click', async () => {
        // 刷新的意思是"重新连一次"：先让服务端停掉旧进程，再重挂工具。
        //   只刷界面不动进程的话，改了对面配置后这里永远看不到变化。
        try {
            await fetch('/api/mcp/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        } catch { /* 服务端没起时忽略 */ }
        const reg = await reloadMcpTools();
        void refreshMcpList();
        const hint = document.getElementById('mcpHint');
        if (hint && reg) {
            hint.textContent = reg.ok
                ? ('已重新连接：当前共 ' + reg.count + ' 个 MCP 工具可用。')
                : ('重新连接失败：' + (reg.message || '未知原因'));
            hint.className = 'text-[11px] leading-relaxed mb-3 ' + (reg.ok ? 'text-emerald-600' : 'text-red-500');
        }
    });

    // 顶栏「外观模式」三段开关（跟随设备 / 浅色 / 深色）——见 index.html 的
    // .header-theme-switch。三段比一个「深色模式」勾选框更准确：
    //   · 点某一段 → ElainaTheme.setDarkMode(该段的 data-mode)
    //   · 选中的那段加 .is-active（填充圆底）；「跟随设备」即跟随系统深浅色
    //   · 主题被别处改动（系统深浅色变化等）时靠 MutationObserver 同步选中态
    const themeSwitch = document.getElementById('headerThemeBtn');
    const markThemeSeg = () => {
        if (!themeSwitch || !window.ElainaTheme) return;
        let mode = 'light';
        try { mode = window.ElainaTheme.darkMode(); } catch (e) { /* 忽略 */ }
        themeSwitch.querySelectorAll('.theme-seg').forEach((b) => {
            b.classList.toggle('is-active', b.dataset.mode === mode);
        });
    };
    themeSwitch?.addEventListener('click', (ev) => {
        const seg = ev.target && ev.target.closest ? ev.target.closest('.theme-seg') : null;
        if (!seg || !window.ElainaTheme) return;
        window.ElainaTheme.setDarkMode(seg.dataset.mode);
        markThemeSeg();
    });
    markThemeSeg();
    if (document.documentElement && typeof MutationObserver === 'function') {
        new MutationObserver(markThemeSeg)
            .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    document.getElementById('authChangeBtn')?.addEventListener('click', changeAccessPassword);
    document.getElementById('authLogoutBtn')?.addEventListener('click', logoutAccess);
    // 日志级别 / 追踪开关的界面已移除（见 index.html 里的说明）：级别回默认、追踪固定开，
    // 所以这里不再有"改完立即生效"的监听。运行期仍可用 /api/logs/settings 调。
    // 我的数据：导出直接下载备份，导入选文件后合并进 data/
    document.getElementById('dataExportBtn')?.addEventListener('click', exportDataBackup);
    // 操作悬浮窗：跳系统设置授权 / 重新检测
    document.getElementById('overlayEnableBtn')?.addEventListener('click', enableOverlay);
    document.getElementById('overlayCheckBtn')?.addEventListener('click', () => { void refreshOverlayStatus(); });
    // 副屏监视窗：入口在**运行状态条**上（AI 跑任务时才出现），
    // 不放在设置里 —— 那是"用的时候才需要"的东西，放设置里得先翻两层。
    document.getElementById('agentWatchBtn')?.addEventListener('click', () => { openScreenWatch(); });
    // 插件 README 弹窗：关闭按钮 + 点遮罩关闭（点面板内部不关）
    (function bindModReadmeModal() {
        const overlay = document.getElementById('modReadmeOverlay');
        if (!overlay) return;
        const close = () => { overlay.classList.add('hidden'); overlay.classList.remove('flex'); };
        document.getElementById('modReadmeClose')?.addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        // Esc 关闭（与其它弹窗一致的习惯）
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
        });
    })();
    // 副屏监视窗
    document.getElementById('closeScreenWatch')?.addEventListener('click', closeScreenWatch);
    document.getElementById('screenWatchPanel')?.addEventListener('click', (e) => {
        // 点遮罩关闭（点面板内部不关）
        if (e.target && e.target.id === 'screenWatchPanel') closeScreenWatch();
    });
    document.getElementById('screenWatchRefreshBtn')?.addEventListener('click', () => { void screenWatchRefresh(); });
    document.getElementById('screenWatchAutoBtn')?.addEventListener('click', (e) => {
        screenWatchAuto = !screenWatchAuto;
        e.currentTarget.textContent = '自动刷新：' + (screenWatchAuto ? '开' : '关');
        if (screenWatchAuto) screenWatchStartAuto(); else screenWatchStopAuto();
    });
    document.getElementById('screenWatchPowerBtn')?.addEventListener('click', async (e) => {
        const plugin = deviceBridge();
        if (!plugin || typeof plugin.moduleDisplay !== 'function') return;
        const btn = e.currentTarget;
        const wasRunning = /关闭/.test(btn.textContent || '');
        btn.disabled = true;
        try {
            const res = await plugin.moduleDisplay({ op: wasRunning ? 'stop' : 'start' });
            screenWatchNote(wasRunning ? '已请求关闭副屏' : '已请求启动副屏');
            if (res && res.text) console.log('[ScreenWatch] ' + res.text);
        } catch (err) {
            screenWatchNote('副屏开关失败：' + (err.message || err));
        } finally {
            btn.disabled = false;
            // 副屏启停需要几秒，稍等再刷新
            setTimeout(() => { void screenWatchRefresh(); }, 2500);
        }
    });
    document.getElementById('dataImportBtn')?.addEventListener('click', () => {
        // APK 优先让用户从**已经导出到文档目录的备份**里挑（纯 Filesystem，不依赖 WebView 的文件选择器）；
        // 挑不到（没有备份 / 插件不可用）再退回系统文件选择器。
        if (IS_NATIVE_APP && nativeFs()) { void importFromDocumentsOrPicker(); return; }
        document.getElementById('dataImportFile')?.click();
    });
    document.getElementById('dataImportFile')?.addEventListener('change', (ev) => {
        const input = ev.target;
        const file = input.files && input.files[0];
        // 先清空 value：同一个文件连选两次也要能触发 change
        input.value = '';
        void importDataBackup(file);
    });
    // 获取模型列表。**三种格式都支持** —— Anthropic 也有 Models API（`GET /v1/models`），
    // 返回 `{ data: [{ id, display_name, … }] }`，和 OpenAI 的 `{ data: [{ id }] }` 同构，
    // 所以解析逻辑可以共用，差别只在**地址**和**认证头**。
    // Anthropic 的这个接口是有的 —— 拉不到通常是因为地址拼错（见 modelsEndpointFor）。

    document.getElementById('fetchChatModelsBtn')?.addEventListener('click', () => {
        void populateModelSelect({
            btn: document.getElementById('fetchChatModelsBtn'),
            input: document.getElementById('settingChatModel'),
            select: document.getElementById('chatModelsSelect'),
            baseUrl: elements.settingBaseUrl.value,
            apiKey: elements.settingApiKey.value,
            apiFormat: elements.settingApiFormat.value,
            // 各格式的预设模型名：用来识别"输入框里是切格式时自动填的、并非用户手填"
            defaultModels: Object.values(CHAT_API_FORMATS).map(f => f.defaultModel)
        });
    });
    document.getElementById('fetchVisionModelsBtn')?.addEventListener('click', () => {
        void populateModelSelect({
            btn: document.getElementById('fetchVisionModelsBtn'),
            input: document.getElementById('settingVisionModel'),
            select: document.getElementById('visionModelsSelect'),
            baseUrl: document.getElementById('settingVisionBaseUrl')?.value,
            apiKey: document.getElementById('settingVisionApiKey')?.value
        });
    });

    // ===== 模型名组合框：接上"点右三角展开列表"的行为=====
    // 两处（对话模型 / 视觉模型）结构相同，用同一段绑定逻辑。
    bindModelCombo({
        input: document.getElementById('settingChatModel'),
        toggle: document.getElementById('chatModelsToggle'),
        list: document.getElementById('chatModelsList'),
        select: document.getElementById('chatModelsSelect'),
    });
    bindModelCombo({
        input: document.getElementById('settingVisionModel'),
        toggle: document.getElementById('visionModelsToggle'),
        list: document.getElementById('visionModelsList'),
        select: document.getElementById('visionModelsSelect'),
    });
    // 设置里的所有下拉（深色模式 / API 格式 / 语音输出 / 思考强度 / 日志筛选…）
    //   改用自绘弹出面板（见文件末尾 initSettingsDropdowns 的说明）。
    initSettingsDropdowns();
    elements.settingApiFormat.addEventListener('change', () => {
        const apiFormat = elements.settingApiFormat.value || 'openai-compatible';
        const preset = CHAT_API_FORMATS[apiFormat] || CHAT_API_FORMATS['openai-compatible'];
        const currentBaseUrl = elements.settingBaseUrl.value.trim();
        const usesDefault = !currentBaseUrl || Object.values(CHAT_API_FORMATS).some(format => format.defaultBaseUrl === currentBaseUrl);
        if (usesDefault) {
            elements.settingBaseUrl.value = preset.defaultBaseUrl;
        }
        // 切换格式时必须同步换掉模型名。
        // 否则切到 Anthropic 后框里还留着 deepseek-chat，会被原样发过去 → 404，
        // 而界面上完全看不出是这个原因（用户以为改格式就够了）—— 这就是"换了格式就连不上"。
        // 只替换"空"或"恰好等于某个预设默认值"的情况；用户自己填过的名字不动。
        const currentModel = String(elements.settingChatModel.value || '').trim();
        const isPresetDefault = Object.values(CHAT_API_FORMATS).some(format => format.defaultModel === currentModel);
        if (!currentModel || isPresetDefault) elements.settingChatModel.value = preset.defaultModel;
        updateChatFormatUI();
    });
    elements.settingTtsProvider.addEventListener('change', updateTtsProviderUI);
    // MiMo TTS 模型下拉切换子字段（预置音色 / 音色描述 / 参考音频样本）
    document.getElementById('settingMimoTtsModel')?.addEventListener('change', updateMimoTtsModelUI);
    // 参考音频样本：文件框不触发自动保存（见 bindSettingsAutoSave），这里自己落盘
    document.getElementById('settingMimoTtsCloneSample')?.addEventListener('change', handleMimoTtsCloneSampleFileChange);
    document.getElementById('mimoTtsCloneSampleClear')?.addEventListener('click', clearMimoTtsCloneSample);
    // 原生 file 控件视觉隐藏（见 index.html 的 .tts-sample-input），
    //   改由这个主题化按钮去点它；「内置样本」一键载入软件自带的那段伊蕾娜日语样本。
    document.getElementById('mimoTtsCloneSamplePick')?.addEventListener('click', () => {
        document.getElementById('settingMimoTtsCloneSample')?.click();
    });
    document.getElementById('mimoTtsCloneSampleBuiltin')?.addEventListener('click', () => {
        void loadBuiltinMimoCloneSample();
    });
    elements.testChatConnectionBtn.addEventListener('click', testChatConnection);
    elements.testTtsConnectionBtn.addEventListener('click', testTtsConnection);
    elements.clearApiKeysBtn.addEventListener('click', clearApiKeys);
    elements.announcementConfirmBtn.addEventListener('click', closeAnnouncement);
    elements.announcementOverlay.addEventListener('click', (event) => {
        if (event.target === elements.announcementOverlay) closeAnnouncement();
    });
    // 远程公告：点「知道啦」或遮罩关闭；点「去插件市场看看」先关公告再开市场
    // （市场弹窗 z-index 低于公告层，不先关会被公告盖住）
    elements.serverAnnounceClose.addEventListener('click', closeServerAnnouncement);
    elements.serverAnnounceOverlay.addEventListener('click', (event) => {
        if (event.target === elements.serverAnnounceOverlay) closeServerAnnouncement();
    });
    elements.serverAnnounceAction.addEventListener('click', () => {
        closeServerAnnouncement();
        try { window.ElainaMarket?.open?.(); } catch (e) { /* 忽略 */ }
    });

    document.querySelectorAll('input[name="asrProvider"]').forEach(r => {
        r.addEventListener('change', updateAsrProviderUI);
    });
    // 阿里云 ASR 连接测试：发 0.5s 静音验证 Key 与模型开通状态（Key 为**独立的 ASR Key**，不再复用 TTS 的）
    document.getElementById('settingAsrTest')?.addEventListener('click', async () => {
        const key = document.getElementById('settingAsrApiKey')?.value.trim();
        const asrUrl = document.getElementById('settingDashscopeAsrBaseUrl')?.value.trim() || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
        const asrModel = document.getElementById('settingDashscopeAsrModel')?.value.trim() || 'qwen3-asr-flash';
        const statusEl = document.getElementById('settingAsrTestStatus');
        if (!statusEl) return;
        if (!key) {
            statusEl.textContent = '请先填写 API Key（语音输入 → 阿里百炼）';
            statusEl.className = 'text-[11px] text-red-400';
            return;
        }
        if (/streaming/i.test(asrModel)) {
            statusEl.textContent = '❌ 「' + asrModel + '」是流式（实时）模型，走 WebSocket 实时接口，本应用的非流式识别调不了它 —— 请改用非流式模型（qwen-audio-3.0-asr-flash 或 qwen3-asr-flash）';
            statusEl.className = 'text-[11px] text-red-400';
            return;
        }
        statusEl.textContent = '测试中…';
        statusEl.className = 'text-[11px] text-indigo-300';
        try {
            const samples = new Float32Array(ASR_TARGET_SAMPLE_RATE * 0.5); // 0.5s 静音
            const result = await postJsonFromDevice(asrUrl,
                buildAliyunAsrRequestBody(asrModel, float32ToWavBase64(samples, ASR_TARGET_SAMPLE_RATE)),
                { Authorization: `Bearer ${key}`, 'X-DashScope-DataInspection': 'enable' }, { timeoutMs: 20000 });
            if (result.ok || isAsrNoWordsError(result)) {
                statusEl.textContent = '✅ 连接成功（HTTP ' + (result.status || 200) + '）：Key 有效、' + asrModel + ' 可调用'
                    + (result.ok ? '' : '（测试发的是 0.5 秒静音，模型如实回「没有听到词」—— 属正常，录真话就会出文字）');
                statusEl.className = 'text-[11px] text-green-500';
            } else {
                const msg = String(
                    result.payload?.base_resp?.status_msg ||
                    result.payload?.message ||
                    result.payload?.error?.message ||
                    result.payload?.error ||
                    ('HTTP ' + result.status)
                );
                statusEl.textContent = '❌ ' + msg + '（HTTP ' + (result.status || '?') + '）';
                statusEl.className = 'text-[11px] text-red-400';
            }
        } catch (err) {
            statusEl.textContent = '❌ ' + (err.message || err);
            statusEl.className = 'text-[11px] text-red-400';
        }
    });
    // 小米 MiMo ASR 连接测试（OpenAI 兼容 /v1/chat/completions + input_audio）
    document.getElementById('settingMimoAsrTest')?.addEventListener('click', async () => {
        const key = document.getElementById('settingMimoAsrApiKey')?.value.trim();
        const baseUrl = (document.getElementById('settingMimoAsrBaseUrl')?.value.trim() || 'https://api.xiaomimimo.com').replace(/\/+$/, '');
        const model = document.getElementById('settingMimoAsrModel')?.value.trim() || 'mimo-v2.5-asr';
        const statusEl = document.getElementById('settingMimoAsrTestStatus');
        if (!statusEl) return;
        if (!key) {
            statusEl.textContent = '请先填写 MiMo API Key';
            statusEl.className = 'text-[11px] text-red-400';
            return;
        }
        statusEl.textContent = '测试中…';
        statusEl.className = 'text-[11px] text-indigo-300';
        try {
            const samples = new Float32Array(ASR_TARGET_SAMPLE_RATE * 0.5); // 0.5s 静音
            const result = await postJsonFromDevice(baseUrl + '/v1/chat/completions', {
                model,
                messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${float32ToWavBase64(samples, ASR_TARGET_SAMPLE_RATE)}`, format: 'wav' } }] }],
                asr_options: { language: 'zh' },
                stream: false
            }, { 'api-key': key, 'Content-Type': 'application/json' }, { timeoutMs: 20000 });
            if (result.ok) {
                statusEl.textContent = '✅ 连接成功（HTTP ' + (result.status || 200) + '）：MiMo ASR 可用';
                statusEl.className = 'text-[11px] text-green-500';
            } else {
                const msg = String(
                    result.payload?.message ||
                    result.payload?.error?.message ||
                    result.payload?.error ||
                    ('HTTP ' + result.status)
                );
                statusEl.textContent = '❌ ' + msg + '（HTTP ' + (result.status || '?') + '）';
                statusEl.className = 'text-[11px] text-red-400';
            }
        } catch (err) {
            statusEl.textContent = '❌ ' + (err.message || err);
            statusEl.className = 'text-[11px] text-red-400';
        }
    });
    elements.settingTtsSpeed.addEventListener('input', () => {
        elements.ttsSpeedLabel.textContent = parseFloat(elements.settingTtsSpeed.value).toFixed(1) + 'x';
        updateSliderFill(elements.settingTtsSpeed);
    });
    elements.settingTtsVolume.addEventListener('input', () => {
        elements.ttsVolumeLabel.textContent = Math.round(parseFloat(elements.settingTtsVolume.value) * 100) + '%';
        updateSliderFill(elements.settingTtsVolume);
    });
    document.getElementById('previewPromptBtn').addEventListener('click', previewPrompt);
    document.getElementById('resetCharacterBtn').addEventListener('click', resetCharacterCard);
// 多人设：切换 / 新建 / 复制 / 改名 / 删除
document.getElementById('ccPresetSelect')?.addEventListener('change', (e) => switchCard(e.target.value));
document.getElementById('ccPresetNew')?.addEventListener('click', () => { void addCard(false); });
document.getElementById('ccPresetDup')?.addEventListener('click', () => { void addCard(true); });
document.getElementById('ccPresetRename')?.addEventListener('click', () => { void renameCard(); });
document.getElementById('ccPresetDelete')?.addEventListener('click', () => { void deleteCard(); });

    elements.newConversationBtn.addEventListener('click', () => {
        createConversation(state.activeCategoryId);
        closeSidebarDrawer();
    });
    elements.newCategoryBtn.addEventListener('click', () => {
        promptCreateCategory();
    });

    elements.initialTextInput.addEventListener('input', updateComposerSendVisibility);
    elements.textInput.addEventListener('input', updateComposerSendVisibility);
    [elements.initialTextInput, elements.textInput].forEach(input => {
        input.addEventListener('focus', () => keepFocusedComposerVisible(input));
    });
    elements.initialComposerMoreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleComposerToolsMenu(elements.initialComposerMoreBtn, elements.initialComposerMoreMenu);
    });
    elements.composerMoreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleComposerToolsMenu(elements.composerMoreBtn, elements.composerMoreMenu);
    });
    elements.initialComposerImageBtn.addEventListener('click', openComposerImagePicker);
    elements.composerImageBtn.addEventListener('click', openComposerImagePicker);
    elements.composerImageInput.addEventListener('change', async () => {
        const file = elements.composerImageInput.files?.[0];
        if (!file) return;
        composerImageProcessing = true;
        elements.initialComposerImageBtn.disabled = true;
        elements.composerImageBtn.disabled = true;
        updateComposerSendVisibility();
        try {
            pendingComposerImage = await compressComposerImage(file);
            renderPendingComposerImage();
        } catch (error) {
            removePendingComposerImage();
            showCustomAlert(error?.message || '图片处理失败，请更换一张图片。', '无法添加图片');
        } finally {
            composerImageProcessing = false;
            elements.initialComposerImageBtn.disabled = false;
            elements.composerImageBtn.disabled = false;
            updateComposerSendVisibility();
        }
    });
    // 思考开关与强度：现在住在「设置 → 模型」里，不在输入框的 ⊕ 菜单里。
    // 直接写进 state 并持久化 —— 这两个是**模型参数**，改了立刻对下一次请求生效，
    // 不需要点「保存设置」才生效（用户不会想到"改个开关还要再点保存"）。
    // 思考强度：UI 上只有一个四档下拉（off / low / high / max），
    // off 就代表"不思考" —— 所以没有独立的「思考模式」勾选框。
    // `thinkingMode` 由档位**派生**（请求层与「思考」折叠栏仍读这个布尔量）。
    elements.settingThinkingEffort.addEventListener('change', () => {
        const value = THINKING_EFFORTS.includes(elements.settingThinkingEffort.value)
            ? elements.settingThinkingEffort.value
            : 'off';
        state.settings.thinkingEffort = value;
        state.settings.thinkingMode = value !== 'off';
        updateThinkingModeHint();
        persistSettings();
    });
    // 第三人称（两段式生成）：与思考开关同属「对话优化」块，同样是"改了立刻生效 + 持久化"。
    elements.settingThirdPerson.addEventListener('change', () => {
        state.settings.thirdPerson = elements.settingThirdPerson.checked;
        persistSettings();
    });
    elements.initialComposerMemoryBtn.addEventListener('click', runManualMemorySummary);
    elements.composerMemoryBtn.addEventListener('click', runManualMemorySummary);
    elements.composerPromptBtn.addEventListener('click', openConversationPromptEditor);
    elements.initialComposerPromptBtn.addEventListener('click', openConversationPromptEditor);
    elements.conversationPromptCancelBtn.addEventListener('click', closeConversationPromptEditor);
    elements.conversationPromptSaveBtn.addEventListener('click', saveConversationPrompt);
    elements.conversationWorldInput.addEventListener('input', updateConversationPromptCount);
    elements.conversationCharacterInput.addEventListener('input', updateConversationPromptCount);
    elements.conversationPromptOverlay.addEventListener('click', (event) => {
        if (event.target === elements.conversationPromptOverlay) closeConversationPromptEditor();
    });
    document.addEventListener('click', (event) => {
        const anyMenuOpen = !elements.initialComposerMoreMenu.classList.contains('hidden') || !elements.composerMoreMenu.classList.contains('hidden');
        if (anyMenuOpen && !event.target.closest('.composer-tools')) {
            closeComposerToolsMenu();
        }
    });

    elements.sidebarSearchInput.addEventListener('input', renderFolderList);
    elements.sidebarSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && elements.sidebarSearchInput.value) {
            elements.sidebarSearchInput.value = '';
            renderFolderList();
        }
    });
    elements.sidebarSearchClear.addEventListener('click', () => {
        elements.sidebarSearchInput.value = '';
        elements.sidebarSearchClear.classList.add('hidden');
        renderFolderList();
        elements.sidebarSearchInput.focus();
    });
    elements.sidebarSearchInput.addEventListener('input', () => {
        elements.sidebarSearchClear.classList.toggle('hidden', !elements.sidebarSearchInput.value);
    });

    elements.railChatBtn.addEventListener('click', () => {
        if (state.notesMode) exitNotesMode();
        else if (state.diaryMode) exitDiaryMode();
        else syncRailActive();
    });
    elements.notesBtn.addEventListener('click', () => {
        if (state.notesMode) {
            exitNotesMode();
        } else {
            enterNotesMode();
        }
    });
    elements.railDiaryBtn.addEventListener('click', () => {
        if (state.diaryMode) exitDiaryMode();
        else enterDiaryMode();
    });
    elements.exitDiaryBtn.addEventListener('click', exitDiaryMode);

    // 日志现在是「设置」里的一个**独立分栏**（#tab-log），
    // 由 switchSettingsTab() 在切栏时调用 window.LogViewer.open() / close()。
    // 这里不绑 #openLogPageBtn / #exitLogBtn：日志是分栏，切栏即进出，
    //   不需要"打开 / 返回"按钮（那两个元素也不存在）。
    elements.exitNotesBtn.addEventListener('click', () => {
        if (state.notesMode) exitNotesMode();
    });
    elements.notesSearch.addEventListener('input', (e) => renderNotesPage(e.target.value));

    document.querySelectorAll('.notes-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            state.notesTab = btn.dataset.tab;
            document.querySelectorAll('.notes-tab').forEach(b => {
                const active = b === btn;
                b.classList.toggle('tab-active', active);
                b.classList.toggle('text-indigo-500', !active);
                b.classList.toggle('bg-white/40', !active);
                b.classList.toggle('border', !active);
                b.classList.toggle('border-white/55', !active);
            });
            renderNotesPage(elements.notesSearch.value);
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeComposerToolsMenu();
        if (e.key === 'Escape' && state.selectedFavoriteId) {
            collapseFavorite();
        }
    });

    elements.detailClose.addEventListener('click', collapseFavorite);
    elements.notesOverlay.addEventListener('click', (e) => {
        if (e.target === elements.notesOverlay) collapseFavorite();
    });
    elements.detailRemoveBtn.addEventListener('click', () => {
        if (state.selectedFavoriteId) {
            removeFavoriteWithConfirm(state.selectedFavoriteId);
        }
    });
    elements.detailJumpBtn.addEventListener('click', () => {
        const fav = state.favorites.find(f => f.id === state.selectedFavoriteId);
        if (fav) jumpToOriginal(fav);
    });

    // 竖栏这个按钮是「成就」入口：点它打开成就面板。
    //   分类弹窗没有常规入口；成就模块不可用时在这里直接回落打开弹窗，
    //   避免成就系统坏了之后"点了没反应"。
    elements.manageCategoriesBtn.addEventListener('click', () => {
        try {
            if (window.ElainaAchievements) { window.ElainaAchievements.open(); return; }
        } catch (e) { /* 成就模块异常时回落到分类弹窗，至少不是"点了没反应" */ }
        openCategoriesModal();
    });
    elements.memoryBtn.addEventListener('click', runManualMemorySummary);
    // 左下角头像 = 用户资料入口（名称/头像自填，AI 印象由 AI 写）
    elements.railProfileBtn?.addEventListener('click', () => { openProfilePanel(); });
    // 设置 → 记忆：「立即整理记忆」按钮（与顶栏同一个动作）+ 轮数步进器
    elements.memoryNowBtn?.addEventListener('click', runManualMemorySummary);
    const stepMemoryEvery = (delta) => {
        const input = elements.settingMemoryEvery;
        if (!input) return;
        const cur = parseInt(input.value, 10) || 6;
        const next = Math.max(3, Math.min(50, cur + delta));
        if (next === cur) return;
        input.value = String(next);
        // 设置面板的自动保存走**事件委托**（见 settings.js 的
        //   bindSettingsAutoSave）：只改 value 不会保存，必须派发事件；而且
        //   要派发在 input 上 —— 那条规则会显式跳过 button。
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    elements.memoryEveryMinus?.addEventListener('click', () => stepMemoryEvery(-1));
    elements.memoryEveryPlus?.addEventListener('click', () => stepMemoryEvery(1));
    elements.categoriesModalClose.addEventListener('click', closeCategoriesModal);
    elements.categoriesModalOverlay.addEventListener('click', (e) => {
        if (e.target === elements.categoriesModalOverlay) closeCategoriesModal();
    });
    elements.categoriesModalNew.addEventListener('click', async () => {
        await promptCreateCategory();
        renderCategoriesModalList();
    });
    elements.catSelectAllBtn.addEventListener('click', () => {
        const visible = [...elements.categoriesModalList.querySelectorAll('.cat-checkbox')];
        const allChecked = visible.every(cb => cb.checked);
        visible.forEach(cb => cb.checked = !allChecked);
        if (allChecked) {
            visible.forEach(cb => catSelected.delete(cb.dataset.convId));
        } else {
            visible.forEach(cb => catSelected.add(cb.dataset.convId));
        }
        renderCategoriesModalList();
        renderCatBatchBar();
    });
    elements.catInvertBtn.addEventListener('click', () => {
        const visible = [...elements.categoriesModalList.querySelectorAll('.cat-checkbox')];
        visible.forEach(cb => {
            if (cb.checked) catSelected.delete(cb.dataset.convId);
            else catSelected.add(cb.dataset.convId);
        });
        renderCategoriesModalList();
        renderCatBatchBar();
    });
    elements.catMoveSelect.addEventListener('change', catMoveSelected);
    elements.catDeleteSelectedBtn.addEventListener('click', catDeleteSelected);
    elements.conversationMoveClose.addEventListener('click', closeConversationMoveDialog);
    elements.conversationMoveCancel.addEventListener('click', closeConversationMoveDialog);
    elements.conversationMoveOverlay.addEventListener('click', (e) => {
        if (e.target === elements.conversationMoveOverlay) closeConversationMoveDialog();
    });

    document.getElementById('quoteLikeBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleQuoteLike();
    });
    document.getElementById('quoteFavBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleQuoteFavorite();
    });

    // 顶栏「公告」按钮：点一下展开公告面板。收起三条路：✕ / 点面板外 / Esc
    // —— 与其它弹窗同一套习惯。
    elements.announceBtn?.addEventListener('click', () => toggleAnnouncePanel());
    elements.announcePanelClose?.addEventListener('click', closeAnnouncePanel);
    document.addEventListener('click', (e) => {
        const panel = elements.announcePanel;
        if (!panel || panel.classList.contains('hidden')) return;
        if (panel.contains(e.target) || elements.announceBtn?.contains(e.target)) return;
        closeAnnouncePanel();
    });
    document.addEventListener('keydown', (e) => {
        const panel = elements.announcePanel;
        if (e.key === 'Escape' && panel && !panel.classList.contains('hidden')) closeAnnouncePanel();
    });

    elements.showSidebar.addEventListener('click', showSidebarFunc);
    elements.mobileSidebarClose.addEventListener('click', closeSidebarDrawer);
    elements.sidebarOverlay.addEventListener('click', closeSidebarDrawer);
    elements.folderList.addEventListener('scroll', closeConversationContextMenu, { passive: true });
    window.addEventListener('resize', () => {
        syncViewportHeight();
        closeConversationContextMenu();
        requestAnimationFrame(alignFloatingMicToComposer);
    });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', syncViewportHeight);
        window.visualViewport.addEventListener('scroll', syncViewportHeight);
    }
    document.addEventListener('pointerdown', (e) => {
        if (!conversationContextMenu || conversationContextMenu.contains(e.target)) return;
        closeConversationContextMenu();
    });
    document.addEventListener('click', (e) => {
        if (window.innerWidth > 980 || !document.body.classList.contains('sidebar-open')) return;
        if (elements.sidebar.contains(e.target) || elements.showSidebar.contains(e.target)) return;
        closeSidebarDrawer();
    });
    elements.sidebar.addEventListener('click', (e) => {
        if (window.innerWidth > 980) return;
        if (e.target.closest('[data-conv-id], [data-rail-action]')) {
            closeSidebarDrawer();
        }
    });

}
