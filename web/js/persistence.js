// 数据持久化：会话 / 分类 / 收藏 / 金句 / 设置 / API 密钥 / 角色卡的读写与迁移。
'use strict';

// 统一走 window.Store（见 web/js/store.js）：data/ 是唯一权威存储，内存缓存只是它的投影。
// 不能用 localStorage：用户删掉 data/ 后数据会从 localStorage 被同步回去。

function saveConversations() {
    Store.setItem('elaina_open_conversations', JSON.stringify(state.conversations));
}
function saveCategories() {
    Store.setItem('elaina_open_categories', JSON.stringify(state.categories));
}
function saveFavorites() {
    Store.setItem('elaina_open_favorites', JSON.stringify(state.favorites));
}
function persistSettings() {
    // API Key 一律不进 data/，只存密钥库（APK 走 Android Keystore，Web 走 store 里的密钥表）。
    // 按 API_SECRET_NAMES 全量剔除：写死键名会漏掉后加的密钥名，明文写进设置还会随同步外发。
    const safeSettings = { ...state.settings };
    API_SECRET_NAMES.forEach((name) => { delete safeSettings[name]; });
    Store.setItem('elaina_open_settings', JSON.stringify(safeSettings));
}
function getNativeSecretsPlugin() {
    // 原生密钥插件只在 APK 的 Capacitor 里注册；Web 上自然为 undefined，不需再判断平台（D5）。
    return window.Capacitor?.Plugins?.ByokSecrets || null;
}
/** Web 密钥表 → 内存（只读） */
function readWebApiSecretsIntoState() {
    const raw = (() => {
        try { return Store.getItem('elainachat_open_api_secrets') || ''; } catch { return ''; }
    })();
    try {
        const parsed = JSON.parse(raw || '{}');
        API_SECRET_NAMES.forEach(name => { state.settings[name] = String(parsed?.[name] || ''); });
    } catch {
        API_SECRET_NAMES.forEach(name => { state.settings[name] = ''; });
    }
}
/** 多设备同步只重读密钥，不跑迁移：迁移会 persistSettings，同步时重跑会把本地刚排进队列的设置包冲掉。 */
function reloadApiSecretsFromStore() {
    if (getNativeSecretsPlugin()) {
        void loadApiSecrets().catch(() => { /* 读不到就保留现值，下次同步再试 */ });
        return;
    }
    readWebApiSecretsIntoState();
    restoreObjectSecrets();
}
async function loadApiSecrets() {
    const nativePlugin = getNativeSecretsPlugin();
    if (nativePlugin?.getSecret) {
        const values = await Promise.all(API_SECRET_NAMES.map(async name => {
            try { return [name, String((await nativePlugin.getSecret({ name }))?.value || '')]; }
            catch (error) {
                // 读取失败 ≠ Key 为空：返回空串会让启动流程用空值覆盖用户填好的 Key（如白名单漏配）。
                // 返回 null 表示"这项读不到"，下面按名字过滤，设置里已有的值不会被冲掉。
                console.warn(`[BYOK] 无法读取 ${name}，保留现有值`, error);
                return null;
            }
        }));
        Object.assign(state.settings, Object.fromEntries(values.filter(Boolean)));
    } else {
        // Web 版：API Key 按用户选择存进 data/（store.js 持久化到 data/store.json）。
        readWebApiSecretsIntoState();
    }
    restoreObjectSecrets();
    // 密钥读完后再跑老配置共用凭据迁移：上面的赋值会把新键覆盖成空值。
    // 只在 loadApiSecrets 末尾调用一次：loadSettings 会被多设备同步反复调用，放那里会重复落盘。
    await migrateLegacySharedMimoCredentials();
    await migrateLegacySharedAsrKey();
    migrateLegacyChatProviderSettings();
    await migrateLegacyTtsAsrProviders();
}

// 密钥表里唯一的对象值条目 chatProviderKeys：落盘时是 JSON 串，赋回 settings 后解析成对象。
function restoreObjectSecrets() {
    try {
        const raw = state.settings.chatProviderKeys;
        state.settings.chatProviderKeys = (raw && typeof raw === 'object')
            ? raw
            : (JSON.parse(String(raw || '{}') || '{}') || {});
    } catch {
        state.settings.chatProviderKeys = {};
    }
    if (!state.settings.chatProviderKeys || typeof state.settings.chatProviderKeys !== 'object') {
        state.settings.chatProviderKeys = {};
    }
}

// 老的「单模型配置」（baseUrl/apiKey/model 三个平铺字段）合成第一张提供商卡。
// 必须在 loadApiSecrets 末尾：apiKey 是密钥通道回填的，早了拿到的是空值；且只在列表为空时跑一次。
function migrateLegacyChatProviderSettings() {
    const s = state.settings;
    if (!Array.isArray(s.chatProviders)) s.chatProviders = [];
    if (!s.chatProviders.length) {
        const baseUrl = String(s.baseUrl || '').trim();
        const model = String(s.model || '').trim();
        if (baseUrl || model) {
            const id = 'prov_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
            s.chatProviders = [{
                id,
                name: '默认',
                apiFormat: CHAT_API_FORMATS[s.apiFormat] ? s.apiFormat : 'openai-compatible',
                baseUrl,
                model,
                models: [],
                selectedModels: model ? [model] : []
            }];
            s.chatProviderKeys = { [id]: String(s.apiKey || '') };
        }
    }
    // 单一「调用模型」→ 可勾选模型列表（selectedModels）；旧字段 model 只作迁移源。
    s.chatProviders.forEach((p) => {
        if (!p) return;
        if (!Array.isArray(p.selectedModels)) {
            p.selectedModels = String(p.model || '').trim() ? [String(p.model).trim()] : [];
        }
        if (!Array.isArray(p.models)) p.models = [];
    });
    // 默认模型按「提供商×模型」对指向；旧的卡级 id 迁移成对。
    const validPair = (pair) => {
        if (!pair || !pair.providerId) return null;
        const prov = s.chatProviders.find((p) => p.id === pair.providerId);
        if (!prov) return null;
        const model = String(pair.model || '').trim();
        return model ? { providerId: pair.providerId, model } : null;
    };
    let def = validPair(s.defaultChatModel);
    if (!def) {
        const pid = String(s.defaultChatProviderId || '');
        const prov = s.chatProviders.find((p) => p.id === pid) || s.chatProviders[0] || null;
        def = prov
            ? { providerId: prov.id, model: (prov.selectedModels && prov.selectedModels[0]) || String(prov.model || '') }
            : { providerId: '', model: '' };
        if (!def.model) def = { providerId: '', model: '' };
    }
    s.defaultChatModel = def;
    s.defaultChatProviderId = def.providerId;
    // 回退链：旧的卡级有序 id → 有序「提供商×模型」对（各取该卡的第一个勾选模型）。
    if (!Array.isArray(s.fallbackChatModels)) {
        const ids = Array.isArray(s.fallbackChatProviderIds) ? s.fallbackChatProviderIds : [];
        s.fallbackChatModels = ids
            .map((id) => {
                const prov = s.chatProviders.find((p) => p.id === id);
                if (!prov) return null;
                const model = (prov.selectedModels && prov.selectedModels[0]) || String(prov.model || '');
                return model ? { providerId: id, model } : null;
            })
            .filter(Boolean);
    }
    delete s.fallbackChatProviderIds;
    // 链里失效/未勾选的模型在读取侧剔除，这里只保证形态正确。
    if (!s.chatProviderKeys || typeof s.chatProviderKeys !== 'object') s.chatProviderKeys = {};
}

// 老平铺的语音配置（每家协议一组平铺字段 + 单选 ttsProvider / asrProvider）合成动态提供商列表里的条目：
// 有 Key 的协议各合成一条（Key 挪进 chatProviderKeys 统一通道），老单选指向的那条设为默认。
// 必须在 loadApiSecrets 末尾跑：平铺 Key 是密钥通道回填的，早了拿到的是空值；合成出的 Key 也要立刻写回密钥库，否则设置标记已置位、Key 却只留在内存。
async function migrateLegacyTtsAsrProviders() {
    const s = state.settings;
    if (!s.chatProviderKeys || typeof s.chatProviderKeys !== 'object') s.chatProviderKeys = {};
    if (s.ttsProviderMigrated !== true) {
        const list = Array.isArray(s.ttsProviders) ? s.ttsProviders : [];
        const legacy = {
            mimo: { baseUrl: s.mimoTtsBaseUrl, model: s.mimoTtsModel, voice: s.mimoTtsVoice, voiceDesignPrompt: s.mimoTtsVoiceDesignPrompt, key: s.mimoTtsApiKey },
            'openai-tts': { baseUrl: s.openaiTtsBaseUrl, model: s.openaiTtsModel, voice: s.openaiTtsVoice, key: s.openaiTtsApiKey },
            minimax: { baseUrl: '', model: s.minimaxModel, voice: s.minimaxVoice, key: s.minimaxApiKey },
            dashscope: { baseUrl: '', model: s.dashscopeTtsModel, voice: s.dashscopeTtsVoice, key: s.dashscopeApiKey }
        };
        TTS_PROTOCOL_PRESETS.forEach((preset) => {
            const old = legacy[preset.id] || {};
            const key = String(old.key || '').trim();
            if (!key) return;
            const id = 'prov_tts_' + preset.id;
            if (list.some((p) => p.id === id)) return;
            list.push({
                id,
                name: preset.name,
                apiFormat: preset.id,
                baseUrl: String(old.baseUrl || preset.baseUrl || '').trim(),
                model: String(old.model || preset.model || '').trim(),
                voice: String(old.voice || preset.voice || '').trim(),
                voiceDesignPrompt: String(old.voiceDesignPrompt || '').trim()
            });
            s.chatProviderKeys[id] = key;
        });
        s.ttsProviders = list;
        const active = String(s.ttsProvider || '');
        s.defaultTtsProviderId = (list.find((p) => p.apiFormat === active) || list[0] || {}).id || '';
        s.ttsProviderMigrated = true;
    }
    if (s.asrProviderMigrated !== true) {
        const list = Array.isArray(s.asrProviders) ? s.asrProviders : [];
        const active = String(s.asrProvider || '');
        const preset = ASR_PROTOCOL_PRESETS.find((p) => p.id === active);
        const key = active === 'aliyun' ? String(s.asrApiKey || '').trim() : (active === 'mimo' ? String(s.mimoApiKey || '').trim() : '');
        if (preset && key) {
            const id = 'prov_asr_' + preset.id;
            if (!list.some((p) => p.id === id)) {
                list.push({
                    id,
                    name: preset.name,
                    apiFormat: preset.id,
                    baseUrl: String((active === 'aliyun' ? s.dashscopeAsrBaseUrl : s.mimoBaseUrl) || preset.baseUrl || '').trim(),
                    model: String((active === 'aliyun' ? s.dashscopeAsrModel : s.mimoAsrModel) || preset.model || '').trim()
                });
                s.chatProviderKeys[id] = key;
            }
            s.defaultAsrProviderId = id;
        }
        s.asrProviders = list;
        s.asrProviderMigrated = true;
    }
    // 合成结果只在这一刻完整：立刻把 Key 写进密钥库、设置（含迁移标记）写进设置包，之后不再重迁。
    try { await saveApiSecrets(s); } catch (e) { console.warn('[BYOK] 语音提供商迁移写入密钥库失败', e); }
    try { persistSettings(); } catch (e) { /* 落盘失败不阻断启动 */ }
}

// 兼容老配置「TTS / ASR 共用 MiMo 凭据」：把 mimoApiKey / mimoBaseUrl 搬到 TTS 专用键（仅当 TTS 侧为空）。
// 门控用版本号而非布尔：能重跑修好"迁移只写了一部分"，也尊重用户故意清空。
const MIMO_CREDS_MIGRATION_VERSION = 2;

// 必须在 loadApiSecrets 末尾调用：密钥表里的空值会覆盖 TTS 键。
async function migrateLegacySharedMimoCredentials() {
    if (state.settings.mimoCredsSplitMigrated === MIMO_CREDS_MIGRATION_VERSION) return;
    if (!String(state.settings.mimoTtsApiKey || '').trim() && String(state.settings.mimoApiKey || '').trim()) {
        state.settings.mimoTtsApiKey = state.settings.mimoApiKey;
    }
    if (!String(state.settings.mimoTtsBaseUrl || '').trim() && String(state.settings.mimoBaseUrl || '').trim()) {
        state.settings.mimoTtsBaseUrl = state.settings.mimoBaseUrl;
    }
    state.settings.mimoCredsSplitMigrated = MIMO_CREDS_MIGRATION_VERSION;
    // 版本标记写进普通设置，不在 API_SECRET_NAMES 里，不会被密钥库覆盖。
    try { persistSettings(); } catch (e) { /* 落盘失败不阻断启动 */ }
    // 迁移出的 TTS Key 必须同时写进密钥库，否则下次启动会被空值覆盖，而版本标记已置位不再重迁。
    // 传整个 state.settings：迁移同时可能改到多个密钥名，少传一个那条迁移就白写。
    try { await saveApiSecrets(state.settings); }
    catch (e) { console.warn('[BYOK] MiMo 凭据迁移写入密钥库失败', e); }
}

// 兼容老配置「ASR 复用 DashScope Key」：把 dashscopeApiKey 搬到 asrApiKey（仅当 ASR 侧为空）。
// asrApiKey 是密钥名，必须在 loadApiSecrets 之后执行并写进密钥库，否则会被空值冲掉。
const ASR_KEY_MIGRATION_VERSION = 1;
async function migrateLegacySharedAsrKey() {
    if (state.settings.asrKeySplitMigrated === ASR_KEY_MIGRATION_VERSION) return;
    if (!String(state.settings.asrApiKey || '').trim() && String(state.settings.dashscopeApiKey || '').trim()) {
        state.settings.asrApiKey = state.settings.dashscopeApiKey;
    }
    state.settings.asrKeySplitMigrated = ASR_KEY_MIGRATION_VERSION;
    try { persistSettings(); } catch (e) { /* 落盘失败不阻断启动 */ }
    try { await saveApiSecrets(state.settings); }
    catch (e) { console.warn('[BYOK] 阿里百炼 ASR Key 迁移写入密钥库失败', e); }
}
// 六个隐私开关默认关闭。只改 DEFAULTS 无效：设置是"默认值 + 已存值"合并的，老用户已存 true。
// 一次性迁移强制置关并写版本号；之后用户自己怎么拨按他的选择走。
const AGENT_READ_DEFAULTS_OFF_VERSION = 1;
function migrateAgentReadDefaultsToOff() {
    if (state.settings.agentReadDefaultsOff === AGENT_READ_DEFAULTS_OFF_VERSION) return;
    for (const key of ['agentReadApps', 'agentReadNotifications', 'agentReadDevice',
        'agentReadSms', 'agentReadContacts', 'agentReadCalendar']) {
        state.settings[key] = false;
    }
    state.settings.agentReadDefaultsOff = AGENT_READ_DEFAULTS_OFF_VERSION;
    try { persistSettings(); } catch (e) { /* 落盘失败不阻断启动 */ }
}

/* 只落盘调用方明确给出的密钥名，并与已存密钥表合并。
   不能按 API_SECRET_NAMES 全量归一化再整体替换：state.settings 可能因为别处的合并（多设备同步只重载设置包、
   密钥还没回填）少了某个名字，全量写回会把"缺失"当成"用户清空"，把密钥库连同其它设备的 Key 一起冲掉。 */
async function saveApiSecrets(secrets) {
    const source = (secrets && typeof secrets === 'object') ? secrets : {};
    const provided = API_SECRET_NAMES.filter(name => Object.prototype.hasOwnProperty.call(source, name));
    const normalized = {};
    provided.forEach(name => {
        const value = source[name];
        // chatProviderKeys 是唯一的对象值条目，序列化成 JSON 串进密钥库；其余名字保持字符串。
        normalized[name] = (value && typeof value === 'object') ? JSON.stringify(value) : String(value || '').trim();
    });
    const nativePlugin = getNativeSecretsPlugin();
    if (nativePlugin?.setSecret) {
        await Promise.all(provided.map(name => nativePlugin.setSecret({ name, value: normalized[name] })));
    } else if (provided.length) {
        let stored = {};
        try { stored = JSON.parse(Store.getItem('elainachat_open_api_secrets') || '{}') || {}; } catch (e) { stored = {}; }
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
        Object.assign(stored, normalized);
        // API Key 随其它数据一起进 data/；代价是拷走 data/ 就等于拷走密钥。
        try { Store.setItem('elainachat_open_api_secrets', JSON.stringify(stored)); }
        catch (e) { console.warn('[BYOK] API Key 保存失败', e); }
    }
    Object.assign(state.settings, normalized);
    restoreObjectSecrets();
}
async function clearStoredApiSecrets() {
    const nativePlugin = getNativeSecretsPlugin();
    if (nativePlugin?.clearSecrets) await nativePlugin.clearSecrets();
    try { Store.removeItem('elainachat_open_api_secrets'); } catch (e) {}
    API_SECRET_NAMES.forEach(name => { state.settings[name] = ''; });
    state.settings.chatProviderKeys = {};
}
function saveCharacterCard() {
    Store.setItem('elaina_open_character_card', JSON.stringify(state.characterCard));
}

function normalizeGreeting(greeting) {
    const value = String(greeting || '').trim();
    if (!value || value === LEGACY_DEFAULT_GREETING) return DEFAULT_CHARACTER_CARD.greeting;
    return value;
}

function upgradeDefaultCharacterPrompt(prompt, name, title) {
    const value = String(prompt || '');
    if (!value || value.includes('【伊蕾娜的好恶与偏好】')) return value;

    const oldPreferencesStart = value.indexOf('【好恶与偏好】');
    const oldRoleplayStart = value.indexOf('【角色扮演表现】');
    const conversationStyleStart = value.indexOf('【面对面对话方式】');
    if (oldPreferencesStart >= 0 && oldRoleplayStart > oldPreferencesStart && conversationStyleStart > oldRoleplayStart) {
        return `${value.slice(0, oldPreferencesStart)}${DEFAULT_CHARACTER_PREFERENCES}\n\n${value.slice(conversationStyleStart)}`;
    }

    const isDefaultElaina = String(name || DEFAULT_CHARACTER_CARD.name).trim() === DEFAULT_CHARACTER_CARD.name &&
        String(title || DEFAULT_CHARACTER_CARD.title).trim() === DEFAULT_CHARACTER_CARD.title;
    const defaultSignals = [
        '你正在扮演18岁的伊蕾娜本人',
        '【身份与外貌】',
        '【人格核心】',
        '【面对面对话方式】',
        '【保持角色】'
    ].filter(signal => value.includes(signal)).length;
    if (!isDefaultElaina || defaultSignals < 3) return value;

    const insertionPoint = value.indexOf('【面对面对话方式】');
    return insertionPoint >= 0
        ? `${value.slice(0, insertionPoint)}${DEFAULT_CHARACTER_PREFERENCES}\n\n${value.slice(insertionPoint)}`
        : `${value.trim()}\n\n${DEFAULT_CHARACTER_PREFERENCES}`;
}

function normalizeCharacterCard(card) {
    const parsed = card && typeof card === 'object' ? card : {};
    if (parsed.worldSetting || parsed.characterPrompt) {
        const name = String(parsed.name || DEFAULT_CHARACTER_CARD.name);
        const title = String(parsed.title || DEFAULT_CHARACTER_CARD.title);
        return {
            ...DEFAULT_CHARACTER_CARD,
            name,
            title,
            worldSetting: String(parsed.worldSetting || DEFAULT_CHARACTER_CARD.worldSetting),
            characterPrompt: upgradeDefaultCharacterPrompt(parsed.characterPrompt || DEFAULT_CHARACTER_CARD.characterPrompt, name, title),
            greeting: normalizeGreeting(parsed.greeting)
        };
    }

    // 结构化旧卡只在读取时迁移一次。
    const looksLikeOldDefault = String(parsed.world || '').startsWith('《魔女之旅》——一位十五岁便成为正式魔女的少女') &&
        String(parsed.habits || '').includes('〜なのよ') &&
        String(parsed.style || '').includes('自然夹杂少量日语语气词');
    const legacyParts = [];
    if (!looksLikeOldDefault) {
        if (parsed.personality) legacyParts.push(`【性格特点】\n${parsed.personality}`);
        if (parsed.habits) legacyParts.push(`【表达习惯】\n${parsed.habits}`);
        if (parsed.style) legacyParts.push(`【说话风格】\n${parsed.style}`);
        if (parsed.examples) legacyParts.push(`【示例对话】\n${parsed.examples}`);
    }
    return {
        ...DEFAULT_CHARACTER_CARD,
        name: String(parsed.name || DEFAULT_CHARACTER_CARD.name),
        title: String(parsed.title || DEFAULT_CHARACTER_CARD.title),
        worldSetting: looksLikeOldDefault
            ? DEFAULT_CHARACTER_CARD.worldSetting
            : String(parsed.world || DEFAULT_CHARACTER_CARD.worldSetting),
        characterPrompt: legacyParts.length
            ? `${DEFAULT_CHARACTER_CARD.characterPrompt}\n\n# 自定义补充\n${legacyParts.join('\n\n')}`
            : DEFAULT_CHARACTER_CARD.characterPrompt,
        greeting: normalizeGreeting(parsed.greeting)
    };
}

function loadConversations() {
    const convs = Store.getItem('elaina_open_conversations');
    const cats = Store.getItem('elaina_open_categories');
    if (convs) {
        try { state.conversations = JSON.parse(convs); } catch (e) { console.error(e); }
    }
    if (cats) {
        try { state.categories = JSON.parse(cats); } catch (e) { console.error(e); }
    }
    const savedCurrent = Store.getItem('elaina_open_current_conv');
    if (savedCurrent && state.conversations.some(c => c.id === savedCurrent)) {
        state.currentConversationId = savedCurrent;
    }
}

function loadFavorites() {
    const raw = Store.getItem('elaina_open_favorites');
    if (raw) {
        try { state.favorites = JSON.parse(raw); } catch (e) { state.favorites = []; }
    }
}
