// 启动后事件绑定：所有接线集中在这里（init 只执行一次），业务仍归各自模块。
'use strict';

function bindAppEvents() {
    elements.floatingMicBtn.addEventListener('click', handleMicClick);
    elements.floatingEndBtn.addEventListener('click', endListening);
    elements.floatingCancelBtn.addEventListener('click', cancelListening);

    elements.railSettingsBtn.addEventListener('click', openSettings);
    elements.headerSettingsBtn.addEventListener('click', openSettings);
    elements.closeSettings.addEventListener('click', () => {
        // 手机上添加模型是设置内的二级页：顶栏返回先退回模型页，再按一次才关设置。
        const modelTab = document.getElementById('tab-model');
        if (window.innerWidth <= 980 && modelTab && modelTab.classList.contains('is-add') && typeof closeModelAddPage === 'function') {
            closeModelAddPage();
            return;
        }
        // 提供商详情同样是设置内的二级页：顶栏返回先回列表，再按一次才关设置。
        const modelBody = document.getElementById('modelPageBody');
        if (window.innerWidth <= 980 && modelBody && modelBody.classList.contains('is-detail') && typeof backFromModelDetail === 'function') {
            backFromModelDetail();
            return;
        }
        closeSettingsPanel();
    });
    elements.settingsOverlay.addEventListener('click', (e) => {
        if (e.target === elements.settingsOverlay) closeSettingsPanel();
    });
    // 设置改完即生效（bindSettingsAutoSave），故没有「取消 / 保存」按钮，也没有整体「恢复默认设置」—— 那会抹掉用户逐项调过的值。
    bindSettingsAutoSave();

    // 「全部更新」同属静态元素：绑一次，走 plugins.js 的公共批量更新入口（单个更新走卡片按钮）。
    document.getElementById('modsUpdateAllBtn')?.addEventListener('click', () => {
        void runModsUpdates(modsUpdateList.slice(), document.getElementById('modsUpdateAllBtn'));
    });

    // 「浏览目录」必须绑在这里，且绑在不在 #modsList 里的按钮上：那块内容每次刷新整块重建 innerHTML，绑在里面会失去监听器，绑在 refreshModsList 里则会重绑 N 次。
    document.getElementById('modsBrowseBtn')?.addEventListener('click', async () => {
        const hint = document.getElementById('modsHint');
        const btn = document.getElementById('modsBrowseBtn');
        const panel = document.getElementById('modsBrowseResult');
        const setHint = (text, cls) => setHintText(hint, text, cls);
        const showPanel = (html) => {
            if (!panel) return;
            panel.innerHTML = html;
            panel.classList.remove('hidden');
        };
        const esc = (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        btn.disabled = true;
        setHint('正在打开 mods/…');
        showPanel('<div class="text-[11px] text-dim">正在打开 mods/ …</div>');
        try {
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

            let listHtml = '';
            try {
                const res = await fetch('/api/plugins/open-folder?dir=1', { method: 'POST', cache: 'no-store' });
                const data = await res.json().catch(() => null);
                if (!res.ok || !data || !data.ok) {
                    listHtml = '<div class="text-[11px] text-danger">读取目录失败：'
                        + esc((data && data.message) || ('HTTP ' + res.status)) + '</div>';
                } else {
                    const list = Array.isArray(data.entries) ? data.entries : [];
                    const dirs = list.filter((e) => e.dir).map((e) => e.name);
                    const files = list.filter((e) => !e.dir).map((e) => e.name);
                    listHtml = '<div class="text-[11px] text-dim break-all">'
                        + '<b>路径</b>：' + esc(data.path || 'mods/') + '</div>'
                        + (list.length
                            ? (dirs.length
                                ? '<div class="text-[11px] text-dim mt-1"><b>文件夹</b>：'
                                    + dirs.map((d) => '<span class="inline-block bg-white/70 rounded px-1 mr-1 mb-0.5">' + esc(d) + '</span>').join('') + '</div>'
                                : '')
                              + (files.length
                                ? '<div class="text-[11px] text-dim mt-1"><b>其它文件</b>：' + esc(files.join('、')) + '</div>'
                                : '')
                            : '<div class="text-[11px] text-dim mt-1">（目录是空的）</div>');
                }
            } catch (e) {
                listHtml = '<div class="text-[11px] text-danger">读取目录失败：'
                    + esc(String((e && e.message) || e)) + '（服务没在运行？）</div>';
            }

            showPanel('<div class="text-[11px] ' + (openOk ? 'text-ok' : 'text-warn') + '">'
                + esc(openMsg) + '</div>' + listHtml);
            setHint(openOk ? '已打开 mods/' : '已列出 mods/（窗口没开，可照下面的路径手动打开）',
                openOk ? 'text-dim' : 'text-warn');
        } finally {
            btn.disabled = false;
        }
    });

    // 必须绑在这里（init 只执行一次）：绑在 refreshModsList 里会每次刷新重绑，点一次弹出 N 个输入框。
    document.getElementById('modsAddGroupBtn')?.addEventListener('click', async () => {
        const name = window.prompt('新分栏的名称：', '');
        if (name === null) return;
        const n = String(name).trim();
        if (!n) return;
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
    // 应用内上传是手机 / 平板用户的唯一入口（APK 连服务端都没有）；请求体直接是 zip 原始字节，服务端不用写 multipart 解析。
    document.getElementById('modsInstallBtn')?.addEventListener('click', () => {
        document.getElementById('modsFileInput')?.click();
    });
    document.getElementById('modsFileInput')?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        const hint = document.getElementById('modsHint');
        if (!file) return;
        const setHint = (text, cls) => setHintText(hint, text, cls);
        setHint('上传中…（' + Math.round(file.size / 1024) + ' KB）', 'text-dim');
        try {
            const res = await fetch('/api/plugins/install?name=' + encodeURIComponent(file.name), {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: file,
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.ok) {
                setHint('安装失败：' + ((data && data.message) || ('HTTP ' + res.status)), 'text-danger');
            } else {
                // 与市场安装同一个坑：装完不重扫，新插件不在注册表里，上面那个开关点了也不生效。
                let reloaded = false;
                try {
                    if (window.ElainaMods && typeof window.ElainaMods.reload === 'function') {
                        await window.ElainaMods.reload();
                        reloaded = true;
                    }
                } catch (err) { /* 加载失败不该把"安装成功"说成失败 */ }
                setHint('✅ ' + (data.message || '已安装')
                    + (reloaded ? '，已加载生效' : '（刷新页面后生效）'), 'text-ok');
                void refreshModsList();
            }
        } catch (err) {
            setHint('安装失败：' + String((err && err.message) || err), 'text-danger');
        } finally {
            e.target.value = '';
        }
    });
    // 技能不是插件：走独立的 /api/skills/install，混用会让技能被当成插件装进去；绑在这里的理由同上。
    document.getElementById('skillsInstallBtn')?.addEventListener('click', () => {
        document.getElementById('skillsFileInput')?.click();
    });
    document.getElementById('skillsFileInput')?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        const hint = document.getElementById('skillsHint');
        if (!file) return;
        const setHint = (text, cls) => setHintText(hint, text, cls);
        setHint('上传中…（' + Math.round(file.size / 1024) + ' KB）', 'text-dim');
        try {
            const res = await fetch('/api/skills/install?name=' + encodeURIComponent(file.name), {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: file,
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.ok) {
                setHint('安装失败：' + ((data && data.message) || ('HTTP ' + res.status)), 'text-danger');
            } else {
                setHint('✅ ' + (data.message || '已安装'), 'text-ok');
                void refreshSkillsList();
            }
        } catch (err) {
            setHint('安装失败：' + String((err && err.message) || err), 'text-danger');
        } finally {
            e.target.value = '';
        }
    });

    document.querySelectorAll('.ext-nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            switchSettingsTab('tab-mods');
            switchExtTab(btn.dataset.extTab);
        });
    });

document.querySelector('#settingsExtNav .settings-tab-btn')?.addEventListener('click', () => {
        // 必须同步执行（与事件委托的顺序不稳定，延后会让读到的 active 状态错位）；语义是 toggle，写死 forceOpen 会让用户无法收起。
        const menu = document.querySelector('.ext-nav-children.ext-menu-floating');
        const group = document.getElementById('settingsExtNav');
        const isOpen = Boolean((group && group.classList.contains('is-open')) || (menu && menu.classList.contains('is-open')));
        if (isOpen) {
            switchExtTab(state._extTab || 'ext-mod', { forceClose: true });
        } else {
            switchSettingsTab('tab-mods');
            switchExtTab(state._extTab || 'ext-mod', { forceOpen: true });
        }
    });

    syncExtMenuParent();
    window.addEventListener('resize', syncExtMenuParent, { passive: true });

    // 分段条的分支浮层挂在 #settingsPanel 下（免得被滚动容器裁掉）且绝对定位：导航横向滚动时按钮会移、分支不会，所以要监听 scroll 重算坐标（passive + rAF 合并避免掉帧）。
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
        window.addEventListener('resize', () => {
            if (raf) return;
            raf = requestAnimationFrame(reposition);
        }, { passive: true });
    })();

    document.getElementById('mcpAddBtn')?.addEventListener('click', () => void editMcpServer(-1));
    document.getElementById('mcpRefreshBtn')?.addEventListener('click', async () => {
        // 刷新 = 重新连一次：先让服务端停掉旧进程再重挂工具，只刷界面不动进程就看不到对面配置的变化。
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
            hint.className = 'text-[11px] leading-relaxed mb-3 ' + (reg.ok ? 'text-ok' : 'text-danger');
        }
    });

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
    document.getElementById('dataExportBtn')?.addEventListener('click', exportDataBackup);
    document.getElementById('overlayEnableBtn')?.addEventListener('click', enableOverlay);
    document.getElementById('overlayCheckBtn')?.addEventListener('click', () => { void refreshOverlayStatus(); });
    document.getElementById('agentWatchBtn')?.addEventListener('click', () => { openScreenWatch(); });
    (function bindModReadmeModal() {
        const overlay = document.getElementById('modReadmeOverlay');
        if (!overlay) return;
        const close = () => { closeOverlayPanel(overlay); };
        document.getElementById('modReadmeClose')?.addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
        });
    })();
    document.getElementById('closeScreenWatch')?.addEventListener('click', closeScreenWatch);
    document.getElementById('screenWatchPanel')?.addEventListener('click', (e) => {
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
        if (IS_NATIVE_APP && nativeFs()) { void importFromDocumentsOrPicker(); return; }
        document.getElementById('dataImportFile')?.click();
    });
    document.getElementById('dataImportFile')?.addEventListener('change', (ev) => {
        const input = ev.target;
        const file = input.files && input.files[0];
        input.value = '';
        void importDataBackup(file);
    });
    document.getElementById('lanShareOpenBtn')?.addEventListener('click', openLanShare);
    document.getElementById('lanShareReceiveBtn')?.addEventListener('click', receiveLanShare);
    initSettingsDropdowns();
    document.getElementById('settingMimoTtsModel')?.addEventListener('change', updateMimoTtsModelUI);
    // 文件框不触发自动保存（见 save.js 的 bindSettingsAutoSave），所以这里自己落盘
    document.getElementById('settingMimoTtsCloneSample')?.addEventListener('change', handleMimoTtsCloneSampleFileChange);
    document.getElementById('mimoTtsCloneSampleClear')?.addEventListener('click', clearMimoTtsCloneSample);
    document.getElementById('mimoTtsCloneSamplePick')?.addEventListener('click', () => {
        document.getElementById('settingMimoTtsCloneSample')?.click();
    });
    document.getElementById('mimoTtsCloneSampleBuiltin')?.addEventListener('click', () => {
        void loadBuiltinMimoCloneSample();
    });
    bindChatProviderSettingsUI();
    elements.announcementConfirmBtn.addEventListener('click', closeAnnouncement);
    elements.announcementOverlay.addEventListener('click', (event) => {
        if (event.target === elements.announcementOverlay) closeAnnouncement();
    });
    elements.serverAnnounceClose.addEventListener('click', closeServerAnnouncement);
    elements.serverAnnounceOverlay.addEventListener('click', (event) => {
        if (event.target === elements.serverAnnounceOverlay) closeServerAnnouncement();
    });
    elements.serverAnnounceAction.addEventListener('click', () => {
        closeServerAnnouncement();
        try { window.ElainaMarket?.open?.(); } catch (e) { /* 忽略 */ }
    });

    elements.settingTtsSpeed.addEventListener('input', () => {
        elements.ttsSpeedLabel.textContent = parseFloat(elements.settingTtsSpeed.value).toFixed(1) + 'x';
        updateSliderFill(elements.settingTtsSpeed);
    });
    elements.settingTtsVolume.addEventListener('input', () => {
        elements.ttsVolumeLabel.textContent = Math.round(parseFloat(elements.settingTtsVolume.value) * 100) + '%';
        updateSliderFill(elements.settingTtsVolume);
    });
    // 拖动只刷新界面，落盘交给设置面板的自动保存（save.js 读开关与滑杆的当前值）；这里不重复写 state，两处写必然有一天对不上。
    for (const samplingField of CHAT_SAMPLING_FIELDS) {
        elements[samplingField.element]?.addEventListener('input', () => syncSamplingControls(samplingField, false));
        elements[samplingField.enableElement]?.addEventListener('change', () => syncSamplingControls(samplingField, false));
    }
    document.getElementById('previewPromptBtn').addEventListener('click', previewPrompt);
    document.getElementById('resetCharacterBtn').addEventListener('click', resetCharacterCard);
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
    // 改了立刻对下一次请求生效：直接写 state 并持久化；UI 只有四档下拉，thinkingMode 由档位派生。
    elements.settingThinkingEffort.addEventListener('change', () => {
        const value = THINKING_EFFORTS.includes(elements.settingThinkingEffort.value)
            ? elements.settingThinkingEffort.value
            : 'off';
        state.settings.thinkingEffort = value;
        state.settings.thinkingMode = value !== 'off';
        updateThinkingModeHint();
        persistSettings();
    });
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
    // 会话设定弹窗的两个下拉：改下拉只记草稿，保存才落盘（渲染与写盘见 roleplay.js）。
    elements.conversationCardSelect?.addEventListener('change', () => {
        conversationCardPickId = elements.conversationCardSelect.value;
    });
    elements.conversationModelSelect?.addEventListener('change', () => {
        conversationModelPickKey = elements.conversationModelSelect.value;
    });
    // 会话人设里的「这段对话的 bot」：头像选择 / 清除（桌面入口仍是顶栏的模型胶囊）
    elements.conversationBotAvatarBtn?.addEventListener('click', () => {
        elements.conversationBotAvatarInput?.click();
    });
    elements.conversationBotAvatarInput?.addEventListener('change', handleConversationBotAvatarPick);
    elements.conversationBotAvatarClear?.addEventListener('click', clearConversationBotAvatar);
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
        else if (state.memoryPageMode) exitMemoryPage();
        else {
            syncRailActive();
            // 宽屏对话页默认把侧栏收成竖栏；点「对话」应把列表展开出来，否则看起来像点了没反应。
            if (window.innerWidth > 980 && document.documentElement.classList.contains('rd-sidebar-collapsed')) {
                expandSidebarPanel();
            }
        }
    });
    // 侧栏这三个入口是「去哪一页」而不是开关：已经在该页时再点保持原页与滚动位置，
    // 回对话只走左侧「对话」或页面自己的返回键。
    elements.notesBtn.addEventListener('click', () => {
        if (!state.notesMode) enterNotesMode();
    });
    elements.exitDiaryBtn.addEventListener('click', exitDiaryMode);
    elements.railMemoryBtn.addEventListener('click', () => {
        if (!state.memoryPageMode) enterMemoryPage();
    });
    elements.exitMemoryBtn.addEventListener('click', exitMemoryPage);
    elements.memoryTierSettingsBtn.addEventListener('click', openMemoryTierSettings);
    elements.memoryViewTiers.addEventListener('click', () => setMemoryView('tiers'));
    elements.memoryViewDiary.addEventListener('click', () => setMemoryView('diary'));

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
                b.classList.toggle('text-dim', !active);
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

    // 成就模块不可用时回落到分类弹窗，避免成就系统坏了之后「点了没反应」。
    elements.manageCategoriesBtn.addEventListener('click', () => {
        try {
            if (window.ElainaAchievements) { window.ElainaAchievements.open(); return; }
        } catch (e) { /* 成就模块异常时回落到分类弹窗，至少不是"点了没反应" */ }
        openCategoriesModal();
    });
    elements.memoryBtn.addEventListener('click', runManualMemorySummary);
    elements.railProfileBtn?.addEventListener('click', () => { openProfilePanel(); });
    elements.memoryNowBtn?.addEventListener('click', runManualMemorySummary);
    const stepMemoryEvery = (delta) => {
        const input = elements.settingMemoryEvery;
        if (!input) return;
        const cur = parseInt(input.value, 10) || 6;
        const next = Math.max(3, Math.min(50, cur + delta));
        if (next === cur) return;
        input.value = String(next);
        // 设置面板的自动保存走事件委托（见 save.js 的 bindSettingsAutoSave，它显式跳过 button）：只改 value 不会保存，必须派发 input 事件。
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

    document.getElementById('quoteFavBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleQuoteFavorite();
    });

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

    elements.showSidebar.addEventListener('click', () => {
        if (window.innerWidth > 980) {
            toggleSidebarPanel();
            return;
        }
        showSidebarFunc();
    });
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
