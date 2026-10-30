/* ========================================================================
 * 数据与角色：设定卡 / 金句 / 持久化 / 多人设 / 记忆
 * ======================================================================== */

// ==================== 每日金句 ====================

function getDayOfYear() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const diff = now - start;
    return Math.floor(diff / 86400000);
}

function getTodayQuote() {
    const idx = getDayOfYear() % ELENA_QUOTES.length;
    return ELENA_QUOTES[idx];
}

function getTodayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function loadDailyQuote() {
    todayQuote = getTodayQuote();
    elements.quoteText.textContent = todayQuote.text;
    elements.quoteSource.textContent = todayQuote.source;
    updateQuoteButtons();
}

function updateQuoteButtons() {
    const liked = state.likedQuotes[getTodayKey()];
    const faved = state.favorites.some(f => f.type === 'quote' && f.quoteDate === getTodayKey());
    elements.quoteLikeBtn.className = `p-1 rounded-full hover:bg-white/60 transition-colors ${liked ? 'text-pink-500' : 'text-indigo-300'}`;
    elements.quoteFavBtn.className = `p-1 rounded-full hover:bg-white/60 transition-colors ${faved ? 'text-amber-500' : 'text-indigo-300'}`;
}

function toggleQuoteLike() {
    const key = getTodayKey();
    if (state.likedQuotes[key]) {
        delete state.likedQuotes[key];
    } else {
        state.likedQuotes[key] = true;
    }
    saveLikedQuotes();
    updateQuoteButtons();
}

function toggleQuoteFavorite() {
    const key = getTodayKey();
    const idx = state.favorites.findIndex(f => f.type === 'quote' && f.quoteDate === key);
    if (idx >= 0) {
        state.favorites.splice(idx, 1);
    } else {
        state.favorites.push({
            id: generateId(),
            type: 'quote',
            quoteDate: key,
            text: todayQuote.text,
            source: todayQuote.source,
            createdAt: new Date().toISOString()
        });
    }
    saveFavorites();
    updateQuoteButtons();
    updateNotesBadge();
    if (state.notesMode) renderNotesPage();
}


function loadSettings() {
    const saved = Store.getItem('elaina_open_settings');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            delete parsed.apiKey;
            delete parsed.minimaxApiKey;
            delete parsed.dashscopeApiKey;
            state.settings = {
                ...DEFAULT_SETTINGS,
                ...parsed
            };
        } catch (e) {
            console.error(e);
        }
    }
    // 把手机「读取信息」的六个隐私开关强制关一次。
    //   必须放在上面「默认值 + 已存值」合并**之后** —— 早了会被老设置里的 true 覆盖回去。
    migrateAgentReadDefaultsToOff();
    state.settings.apiProvider = DEFAULT_SETTINGS.apiProvider;
    // 老格式 id 迁移：必须放在下面的合法性校验**之前**，否则会被当成非法值直接重置成默认，
    // 用户早已配好的地址和模型就白填了。
    const legacyFormat = String(state.settings.apiFormat || '');
    if (LEGACY_API_FORMAT_ALIASES[legacyFormat]) {
        const oldBaseUrl = String(state.settings.baseUrl || '').trim();
        state.settings.apiFormat = LEGACY_API_FORMAT_ALIASES[legacyFormat];
        // 地址需要改写的（Gemini / Ollama 的老"原生协议"端点）换成对应的兼容端点；
        // 其余一律保留用户原来的地址 —— baseUrl 只由用户输入决定，不会被别的开关覆盖。
        const rewritten = LEGACY_BASE_URL_REWRITE[oldBaseUrl];
        if (rewritten) state.settings.baseUrl = rewritten;
    }
    // baseUrl 只由用户输入决定，只在为空时补默认值 —— 一旦让它跟着"格式"变，
    // 换格式就会连不上、老用户迁移过来的地址也会被冲掉（providerMode 已随之删除）。
    delete state.settings.providerMode;
    if (!CHAT_API_FORMATS[state.settings.apiFormat]) state.settings.apiFormat = 'openai-compatible';
    const preset = CHAT_API_FORMATS[state.settings.apiFormat] || CHAT_API_FORMATS['openai-compatible'];
    if (!String(state.settings.baseUrl || '').trim()) state.settings.baseUrl = preset.defaultBaseUrl;
    if (!String(state.settings.model || '').trim()) state.settings.model = preset.defaultModel;
    if (!['browser', 'aliyun', 'mimo'].includes(state.settings.asrProvider)) state.settings.asrProvider = 'browser';
    // ===== 思考档位归一=====
    // UI 只有一个"思考强度"下拉，`off` 就等于"不思考"，所以不再需要独立的勾选框。
    // 为了让请求层与「思考」折叠栏不必改判据，这里把 `thinkingMode` 归成**由档位派生**：
    // off ⇒ false，其余 ⇒ true。
    //   · 老数据里的 `medium`（"不指定强度，交给服务商默认"）最接近新档的「均衡」，
    //     所以"开着思考"时映射到 `high`；
    //   · 旧开关（thinkingMode）关着的，一律回落成 off —— 它是旧的 on/off 权威，先尊重它
    //     （否则会出现"用户明明关过思考，升级后却默认在思考"）。
    // 档位清单在这里**内联**，不复用 core.js 的 THINKING_EFFORTS：本函数在启动早期
    // 就会跑，跨 <script> 的 const 有 TDZ 风险（与上面 agentAccess 那段同一个理由）。
    {
        const rawEffort = String(state.settings.thinkingEffort || '').trim().toLowerCase();
        if (!state.settings.thinkingMode || rawEffort === 'off') {
            state.settings.thinkingMode = false;
            state.settings.thinkingEffort = 'off';
        } else if (rawEffort === 'low' || rawEffort === 'high' || rawEffort === 'max') {
            state.settings.thinkingMode = true;
            state.settings.thinkingEffort = rawEffort;
        } else {
            state.settings.thinkingMode = true;
            state.settings.thinkingEffort = 'high';
        }
    }
    // ===== AI 权限：旧两套设置 → 新三档=====
    // 旧模型有两个独立设置：
    //   agentPermission: 'app' | 'computer'      （电脑：能碰哪里）
    //   agentApproval:   'once'|'run'|'always'|'off'  （手机：要不要问）
    // 新模型合成一个 agentAccess: 'strict' | 'auto' | 'full'。
    // 迁移取向按用户决定：**向宽松倒** ——
    //   旧 'computer'（允许操作电脑）→ 'full'（完全访问，含删除）
    //   旧其它（app / 各种手机策略）  → 'strict'（逐条确认）
    // ⚠️ 这条迁移会**静默打开删除能力** —— 删除是新增的接口，老用户从未授权过。
    //    也就是说一个从没用过删除的老用户升级后会直接获得"AI 可删除任意文件"的权限。
    //    取向是按用户明确选择定的（"旧全权限→完全访问"），但必须在更新说明里点出来。
    const legacyPermission = state.settings.agentPermission;
    const hasLegacy = legacyPermission !== undefined || state.settings.agentApproval !== undefined;
    // 这里刻意**内联**档位清单，不复用 agent.js 的 AGENT_ACCESS_LEVELS：
    //   本函数在启动早期就会被调用，而跨 <script> 的 const 有 TDZ ——
    //   虽然加载顺序上通常已经就绪，但"依赖加载时序才不报错"是脆的。
    //   （下面的提示词拼接里可以放心调 currentAgentAccess()：那是发消息时才跑的，
    //     那时所有脚本早就加载完了。）
    if (!['off', 'strict', 'auto', 'full'].includes(state.settings.agentAccess)) {
        state.settings.agentAccess = (hasLegacy && legacyPermission === 'computer') ? 'full' : 'strict';
    }
    // 迁移完把旧字段删掉：留着它们会让"哪个才是权威"变得含糊
    // （旧代码里还有几处读 agentPermission 的地方，删掉能让遗漏立刻暴露成 undefined）。
    delete state.settings.agentPermission;
    delete state.settings.agentApproval;
    // 迁移/初始化完成后打上版本标记，下次启动不再动它
    if (state.settings.settingsVersion === undefined) state.settings.settingsVersion = 2;
    if (typeof state.settings.agentPhoneEnabled !== 'boolean') state.settings.agentPhoneEnabled = true;
    // MCP 服务器清单：逐项校验。**坏一项不能丢整张表** —— 用户配了三台，
    //   其中一台写了非法值，不该导致另外两台一起消失。
    if (!Array.isArray(state.settings.mcpServers)) state.settings.mcpServers = [];
    state.settings.mcpServers = state.settings.mcpServers
        .filter((s) => s && typeof s === 'object')
        .map((s, i) => ({
            // id 是身份：缺了就按位置补一个稳定的默认值（同名会互相覆盖，所以带序号）
            id: String(s.id || ('mcp' + (i + 1))).trim().slice(0, 64),
            name: String(s.name || s.id || ('MCP 服务器 ' + (i + 1))).trim().slice(0, 80),
            // ── 两种传输 ──
            //   url 填了 → 远程（Streamable HTTP）；否则看 command → 本地进程（stdio）。
            //   不用显式的 transport 字段：老配置里没有它，加字段等于逼用户重填。
            url: String(s.url || '').trim(),
            command: String(s.command || '').trim(),
            args: Array.isArray(s.args) ? s.args.map(String) : [],
            env: (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) ? s.env : {},
            cwd: String(s.cwd || '').trim(),
            // 自定义请求头：远程服务的鉴权常靠它（Authorization / X-Api-Key 等）
            // 浅拷贝：直接引用原对象会让两台服务器的 headers 共享同一份，
            //   改 A 的鉴权头会把 B 的一起改掉（对象引用在 map 里很容易被忽略）。
            headers: (s.headers && typeof s.headers === 'object' && !Array.isArray(s.headers))
                ? Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [String(k), String(v)]))
                : {},
            enabled: s.enabled === true,
        }))
        // 既没有地址也没有启动命令的条目留着也没用（必然连不上），
        //   但**不要**静默删掉用户的输入：只标 disabled，让他在设置页里看到并自己修。
        .map((s) => ((s.url || s.command) ? s : { ...s, enabled: false }));
    // 图片转述开关：老配置里没有这个键。**已经填了视觉模型的老用户**按开启迁移 ——
    //   他们本来就在用这个功能，升级后不该突然失效；没填过的保持关闭。
    if (typeof state.settings.visionEnabled !== 'boolean') {
        state.settings.visionEnabled = Boolean(
            String(state.settings.visionBaseUrl || '').trim() && String(state.settings.visionModel || '').trim()
        );
    }
    // 浏览器开关：老配置里没有这个键，一律按**关闭**处理（新能力不默认打开）。
    //   注意判据是 === true 而不是 !== false：只有明确存了 true 才算开。
    if (state.settings.agentBrowserEnabled !== true) state.settings.agentBrowserEnabled = false;
    // 联网搜索：老配置里没有，一律按关闭处理；数值项收敛到合法范围。
    if (state.settings.tavilySearchEnabled !== true) state.settings.tavilySearchEnabled = false;
    if (state.settings.tavilySearchDepth !== 'advanced') state.settings.tavilySearchDepth = 'basic';
    // 服务商：不认识的一律回落到默认（老配置里没有这个键）。
    //   判据必须是"表里有这家"，不能只判真值 —— 删掉一家之后老用户的选择会悬空。
    if (typeof SEARCH_PROVIDERS === 'undefined' || !SEARCH_PROVIDERS[state.settings.searchProvider]) {
        // 也可能是"这家已经被移除了"（例如早先版本收录过博查 / Serper）——
        //   悬空的选择必须回落到默认，否则执行器取不到 def 会直接抛。
        state.settings.searchProvider = typeof DEFAULT_SEARCH_PROVIDER === 'string' ? DEFAULT_SEARCH_PROVIDER : 'tavily';
    }
    // 自定义搜索源：鉴权方式只认四档，其余回落 bearer；文本项一律转成字符串。
    if (!['bearer', 'raw', 'x-api-key', 'none'].includes(state.settings.searchCustomAuth)) {
        state.settings.searchCustomAuth = 'bearer';
    }
    for (const k of ['searchCustomEndpoint', 'searchCustomAuthHeader', 'searchCustomBody', 'searchCustomResultsPath']) {
        if (typeof state.settings[k] !== 'string') state.settings[k] = '';
    }
    // 已移除服务商残留的 Key 一并清掉：留着既占密钥库，又会让"清除全部 Key"看起来没清干净。
    for (const k of Object.keys(state.settings)) {
        if (/^searchApiKey_/.test(k) && !Object.prototype.hasOwnProperty.call(SEARCH_PROVIDERS, k.slice('searchApiKey_'.length))) {
            state.settings[k] = '';
        }
    }
    {
        const n = parseInt(state.settings.tavilyMaxResults, 10);
        state.settings.tavilyMaxResults = Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : 5;
    }
    // 只有单键 tavilyApiKey 的老配置：值挪进 searchApiKey_tavily 那一格，
    //   否则填过 Tavily Key 的用户会被要求重填一次。
    if (typeof state.settings.tavilyApiKey === 'string' && state.settings.tavilyApiKey.trim()
        && !String(state.settings.searchApiKey_tavily || '').trim()) {
        state.settings.searchApiKey_tavily = state.settings.tavilyApiKey.trim();
    }
    delete state.settings.tavilyApiKey;
    // 实现方式：空表示「还没选过」；非法值一律回落到空（要求用户明确选择，不替他决定）。
    // 注意：这里的 id 列表必须与 AGENT_BACKENDS 保持一致 —— 漏一个会让用户选了那种方式后
    // 一刷新就被重置成"没选过"。
    // 反过来也不能多：这里只能列**真的存在**的实现方式。多认一个已删除的 id，老用户的
    // 旧选择就会被当成合法值留下，而它不对应任何实现方式 —— 所以旧选择会在这里被重置成空。
    if (!['', 'accessibility', 'module'].includes(state.settings.agentBackend)) state.settings.agentBackend = '';
    // 老配置「阿里百炼 ASR 复用 TTS 的 dashscopeApiKey」→ 独立 asrApiKey 的迁移**不在这里**：
    // asrApiKey 已是密钥名（API_SECRET_NAMES），loadApiSecrets 会用密钥库的值覆盖它，
    // 提前迁移会被冲掉 —— 所以迁移放在 loadApiSecrets 之后（见 migrateLegacySharedAsrKey）。
    // MiMo 共用凭据 → TTS 独立键 的迁移**不在这里**：它依赖"密钥已读入"，
    // 且必须只跑一次，故放在 loadApiSecrets() 末尾（见 migrateLegacySharedMimoCredentials）。
    if (!['mimo', 'openai-tts', 'minimax', 'dashscope'].includes(state.settings.ttsProvider)) state.settings.ttsProvider = 'mimo';
    // 设置加载完再同步一次入口按钮的灰显状态：
    // 脚本顶层那次调用可能早于 loadSettings()，会误把已选的实现方式显示成未选。
    syncBackendSummary();
}

/**
 * 首次运行的「欢迎使用独立开源版」公告 —— 用户是否已经点过同意。
 *
 * 判据只看 settings 里那个标记，**不再看有没有填 API Key**。
 *   早先这里有个 `isFirstInstall()`（判断 apiKey 是否为空）——
 *   它**从来没被调用过**，是个死函数，而"有没有配 Key"也不该决定
 *   要不要反复弹公告（用户可能就是想先看看界面、或者用别人的中转服务）。
 *   现在语义单一：**同意过就不再弹**。
 */
