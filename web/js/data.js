// 数据与角色：设定卡 / 金句 / 持久化 / 多人设 / 记忆

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
    // 窄屏上胶囊里的引用会被省略号截断，标题给全文。
    try {
        const chip = elements.quoteText.closest ? elements.quoteText.closest('.quote-chip') : null;
        if (chip) chip.title = todayQuote.source ? (todayQuote.text + ' — ' + todayQuote.source) : todayQuote.text;
    } catch (e) { /* 结构变了也不影响金句显示 */ }
    updateQuoteButtons();
}

function updateQuoteButtons() {
    const faved = state.favorites.some(f => f.type === 'quote' && f.quoteDate === getTodayKey());
    elements.quoteFavBtn.className = `p-1 rounded-full hover:bg-white/60 transition-colors ${faved ? 'text-warn' : 'text-dim'}`;
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


// API Key 可能只存在于设置包字段里；后面 loadSettings 会立刻 delete 它们。
// 先补进密钥通道（已有值优先），再删字段，否则只在设置包里的 Key 会永久丢失。
function migrateEmbeddedLegacySecrets(parsed) {
    if (!parsed || typeof parsed !== 'object') return true;
    const names = (typeof API_SECRET_NAMES !== 'undefined' && Array.isArray(API_SECRET_NAMES))
        ? API_SECRET_NAMES
        : ['apiKey', 'minimaxApiKey', 'dashscopeApiKey', 'asrApiKey', 'mimoApiKey', 'mimoTtsApiKey', 'openaiTtsApiKey', 'searchApiKey_tavily', 'searchApiKey_custom', 'chatProviderKeys'];
    let stored = {};
    try { stored = JSON.parse(Store.getItem('elainachat_open_api_secrets') || '{}') || {}; } catch (e) { stored = {}; }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
    let changed = false;
    for (const name of names) {
        if (name === 'chatProviderKeys') continue;
        if (stored[name] !== undefined && stored[name] !== '') continue;
        if (parsed[name] !== undefined && parsed[name] !== null && String(parsed[name]).trim() !== '') {
            stored[name] = String(parsed[name]);
            changed = true;
        }
    }
    let legacyChatKeys = parsed.chatProviderKeys;
    if (typeof legacyChatKeys === 'string') {
        try { legacyChatKeys = JSON.parse(legacyChatKeys); } catch (e) { legacyChatKeys = null; }
    }
    if (legacyChatKeys && typeof legacyChatKeys === 'object' && !Array.isArray(legacyChatKeys)) {
        let existing = {};
        try { existing = JSON.parse(stored.chatProviderKeys || '{}') || {}; } catch (e) { existing = {}; }
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
        for (const [id, key] of Object.entries(legacyChatKeys)) {
            if (!id || key === undefined || key === null) continue;
            if (existing[id] !== undefined && existing[id] !== '') continue;
            existing[id] = String(key);
            changed = true;
        }
        if (changed) stored.chatProviderKeys = JSON.stringify(existing);
    }
    if (!changed) return true;
    try {
        Store.setItem('elainachat_open_api_secrets', JSON.stringify(stored));
        return true;
    } catch (e) {
        console.warn('[BYOK] 旧设置包里的 Key 转存失败，继续保留原字段以免丢失', e);
        return false;
    }
}

function loadSettings() {
    const saved = Store.getItem('elaina_open_settings');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            const secretsMigrated = migrateEmbeddedLegacySecrets(parsed);
            // 转存失败时保留原字段，下次启动再试；成功或本来就没有旧 Key 才删。
            if (secretsMigrated) {
                delete parsed.apiKey;
                delete parsed.minimaxApiKey;
                delete parsed.dashscopeApiKey;
                // 多提供商 Key 只走密钥通道（API_SECRET_NAMES），设置包里即使残留也不读
                delete parsed.chatProviderKeys;
            }
            state.settings = {
                ...DEFAULT_SETTINGS,
                ...parsed
            };
        } catch (e) {
            console.error(e);
        }
    }
    state.settings.apiProvider = DEFAULT_SETTINGS.apiProvider;
    // 格式别名（LEGACY_API_FORMAT_ALIASES）归一必须排在合法性校验之前，否则会被重置成默认。
    const legacyFormat = String(state.settings.apiFormat || '');
    if (LEGACY_API_FORMAT_ALIASES[legacyFormat]) {
        const oldBaseUrl = String(state.settings.baseUrl || '').trim();
        state.settings.apiFormat = LEGACY_API_FORMAT_ALIASES[legacyFormat];
        // 只有 Gemini / Ollama 的原生端点需要改写，其余保留用户地址。
        const rewritten = LEGACY_BASE_URL_REWRITE[oldBaseUrl];
        if (rewritten) state.settings.baseUrl = rewritten;
    }
    // baseUrl 只由用户输入决定，只在为空时补默认值，不跟随格式变化。
    delete state.settings.providerMode;
    // 残留键必须删掉，否则会一直跟着设置落盘与同步。
    delete state.settings.optTopK;
    delete state.settings.thinkingPrefill;
    delete state.settings.thinkingPrefillText;
    if (!CHAT_API_FORMATS[state.settings.apiFormat]) state.settings.apiFormat = 'openai-compatible';
    const preset = CHAT_API_FORMATS[state.settings.apiFormat] || CHAT_API_FORMATS['openai-compatible'];
    if (!String(state.settings.baseUrl || '').trim()) state.settings.baseUrl = preset.defaultBaseUrl;
    if (!String(state.settings.model || '').trim()) state.settings.model = preset.defaultModel;
    if (!['aliyun', 'mimo'].includes(state.settings.asrProvider)) state.settings.asrProvider = '';
    // thinkingMode 由档位派生：off ⇒ false，其余 ⇒ true；medium 映射到 high。档位清单内联，不复用 core.js 的 THINKING_EFFORTS（启动早期跨 <script> 的 const 有 TDZ 风险）。
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
    // agentPermission / agentApproval 合成 agentAccess：computer → full，其余 → strict。该迁移会静默打开删除能力，必须在更新说明中点出。
    const legacyPermission = state.settings.agentPermission;
    const hasLegacy = legacyPermission !== undefined || state.settings.agentApproval !== undefined;
    // 档位清单内联，不复用 agent.js 的 AGENT_ACCESS_LEVELS：同上 TDZ 理由。
    if (!['off', 'strict', 'auto', 'full'].includes(state.settings.agentAccess)) {
        state.settings.agentAccess = (hasLegacy && legacyPermission === 'computer') ? 'full' : 'strict';
    }
    // 合成后删掉这两个字段，避免"哪个才是权威"含糊。
    delete state.settings.agentPermission;
    delete state.settings.agentApproval;
    if (state.settings.settingsVersion === undefined) state.settings.settingsVersion = 2;
    if (typeof state.settings.agentPhoneEnabled !== 'boolean') state.settings.agentPhoneEnabled = true;
    // 对话提供商的协议纠正：早期自动识别有缺陷（OpenAI 网关的 /messages 回 401 会把判定抢成 Anthropic），
    // 误存的 apiFormat 会让请求永远打到 /v1/messages 并 404，而用户不知道该去哪改。
    // 这里只纠正**地址形态与所存协议明显矛盾**的条目：地址里带 OpenAI 风格的兼容段就不是 Anthropic。
    // 幂等、只改这一种矛盾，用户手选的其它组合一律不动（探测与用户选择可能有正当理由）。
    if (Array.isArray(state.settings.chatProviders)) {
        for (const p of state.settings.chatProviders) {
            if (!p || typeof p !== 'object') continue;
            if (p.apiFormat !== 'anthropic') continue;
            const base = String(p.baseUrl || '').toLowerCase();
            if (/compatible-mode|\/chat\/completions|\/responses|v1beta\/openai|openrouter/.test(base)) {
                p.apiFormat = 'openai-compatible';
            }
        }
    }
    // MCP 清单逐项校验：坏一项不能丢整张表。
    if (!Array.isArray(state.settings.mcpServers)) state.settings.mcpServers = [];
    state.settings.mcpServers = state.settings.mcpServers
        .filter((s) => s && typeof s === 'object')
        .map((s, i) => ({
            // id 是身份：缺失时按位置补稳定默认值。
            id: String(s.id || ('mcp' + (i + 1))).trim().slice(0, 64),
            name: String(s.name || s.id || ('MCP 服务器 ' + (i + 1))).trim().slice(0, 80),
            // url 有值 → 远程 Streamable HTTP；否则 command → 本地 stdio。
            url: String(s.url || '').trim(),
            command: String(s.command || '').trim(),
            args: Array.isArray(s.args) ? s.args.map(String) : [],
            env: (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) ? s.env : {},
            cwd: String(s.cwd || '').trim(),
            // 鉴权头浅拷贝：直接引用会让两台服务器共享同一份 headers。
            headers: (s.headers && typeof s.headers === 'object' && !Array.isArray(s.headers))
                ? Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [String(k), String(v)]))
                : {},
            enabled: s.enabled === true,
        }))
        // 无地址也无命令的条目不静默删除，只标 disabled。
        .map((s) => ((s.url || s.command) ? s : { ...s, enabled: false }));
    // 视觉模型有来源（选了对话模型提供商，或单独填了地址）且模型名在，才算开启，其余保持关闭。
    const hasVisionTarget = Boolean(
        (String(state.settings.visionProviderId || '') || String(state.settings.visionBaseUrl || '').trim())
        && String(state.settings.visionModel || '').trim()
    );
    if (typeof state.settings.visionEnabled !== 'boolean') {
        state.settings.visionEnabled = state.settings.visionEnabled === true || hasVisionTarget;
    }
    // 新能力不默认打开：判据是 === true，只有明确存过才算开。
    if (state.settings.agentBrowserEnabled !== true) state.settings.agentBrowserEnabled = false;
    // 联网搜索默认关闭；数值项收敛到合法范围。
    if (state.settings.tavilySearchEnabled !== true) state.settings.tavilySearchEnabled = false;
    if (state.settings.tavilySearchDepth !== 'advanced') state.settings.tavilySearchDepth = 'basic';
    // 判据必须是"表里有这家"：服务商被移除后选择会悬空，执行器取不到 def 会抛。
    if (typeof SEARCH_PROVIDERS === 'undefined' || !SEARCH_PROVIDERS[state.settings.searchProvider]) {
        state.settings.searchProvider = typeof DEFAULT_SEARCH_PROVIDER === 'string' ? DEFAULT_SEARCH_PROVIDER : 'tavily';
    }
    // 自定义搜索源：鉴权只认四档，其余回落 bearer；文本项转成字符串。
    if (!['bearer', 'raw', 'x-api-key', 'none'].includes(state.settings.searchCustomAuth)) {
        state.settings.searchCustomAuth = 'bearer';
    }
    for (const k of ['searchCustomEndpoint', 'searchCustomAuthHeader', 'searchCustomBody', 'searchCustomResultsPath']) {
        if (typeof state.settings[k] !== 'string') state.settings[k] = '';
    }
    // 已移除服务商的残留 Key 一并清掉。
    for (const k of Object.keys(state.settings)) {
        if (/^searchApiKey_/.test(k) && !Object.prototype.hasOwnProperty.call(SEARCH_PROVIDERS, k.slice('searchApiKey_'.length))) {
            state.settings[k] = '';
        }
    }
    {
        const n = parseInt(state.settings.tavilyMaxResults, 10);
        state.settings.tavilyMaxResults = Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : 5;
    }
    // 单键 tavilyApiKey 挪进 searchApiKey_tavily，免得用户重填。
    if (typeof state.settings.tavilyApiKey === 'string' && state.settings.tavilyApiKey.trim()
        && !String(state.settings.searchApiKey_tavily || '').trim()) {
        state.settings.searchApiKey_tavily = state.settings.tavilyApiKey.trim();
    }
    delete state.settings.tavilyApiKey;
    // 空表示「还没选过」；id 列表必须与 AGENT_BACKENDS 一致（漏一个会让选择刷新后被重置），也不能多认已删除的 id，否则残留选择会被当成合法值留下。
    if (!['', 'accessibility', 'shizuku', 'root', 'module'].includes(state.settings.agentBackend)) state.settings.agentBackend = '';
    // asrApiKey 与 MiMo 共用凭据的迁移必须放在 loadApiSecrets() 之后（见 migrateLegacySharedAsrKey / migrateLegacySharedMimoCredentials），否则会被密钥库覆盖。
    if (!['mimo', 'openai-tts', 'minimax', 'dashscope'].includes(state.settings.ttsProvider)) state.settings.ttsProvider = 'mimo';
    // 四类动态提供商列表（文字转语音 / 语音转文字 / 嵌入 / 重排序）逐项归一：坏一项不能丢整张表。
    // 语义校验（默认指向悬空回落等）在读取侧（activeTtsProvider / activeAsrProvider / resolveModelProvider）做，这里只保证形态。
    for (const key of ['ttsProviders', 'asrProviders', 'embeddingProviders', 'rerankProviders']) {
        const list = state.settings[key];
        state.settings[key] = Array.isArray(list)
            ? list.filter((p) => p && typeof p === 'object').map((p) => ({
                ...p,
                id: String(p.id || '').trim(),
                name: String(p.name || '').trim(),
                apiFormat: String(p.apiFormat || '').trim(),
                baseUrl: String(p.baseUrl || '').trim(),
                model: String(p.model || '').trim()
            })).filter((p) => p.id)
            : [];
    }
    // 脚本顶层那次同步可能早于 loadSettings，这里再同步一次灰显状态。
    syncBackendSummary();
}
