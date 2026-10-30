/* ============================================================================
 * 数据持久化（从 data.js 拆分）
 *
 * 会话 / 分类 / 收藏 / 金句 / 设置 / API 密钥 / 角色卡的读写与迁移。
 * ========================================================================== */
'use strict';

// ==================== 数据持久化 ====================
// 统一走 window.Store（见 web/js/store.js）：data/ 是唯一权威存储，内存缓存只是它的投影。
//   不能用 localStorage 存业务数据：那会多出第二份持久数据，用户删掉 data/ 后数据会从 localStorage 被同步回去
//   （表现为「删了还在」）。

function saveConversations() {
    Store.setItem('elaina_open_conversations', JSON.stringify(state.conversations));
}
function saveCategories() {
    Store.setItem('elaina_open_categories', JSON.stringify(state.categories));
}
function saveFavorites() {
    Store.setItem('elaina_open_favorites', JSON.stringify(state.favorites));
}
function saveLikedQuotes() {
    Store.setItem('elaina_open_liked_quotes', JSON.stringify(state.likedQuotes));
}
function persistSettings() {
    // API Key 一律**不进** data/ —— 它们只存密钥库（APK 走 Android Keystore，
    // 网页版走 store 里的密钥表）。
    // 按 API_SECRET_NAMES 全量剔除，不写死键名：写死就会漏掉后加的密钥名，
    //   而漏掉的键会以**明文**写进 elaina_open_settings（还会随多设备同步外发）。
    const safeSettings = { ...state.settings };
    API_SECRET_NAMES.forEach((name) => { delete safeSettings[name]; });
    Store.setItem('elaina_open_settings', JSON.stringify(safeSettings));
}
function getNativeSecretsPlugin() {
    // 原生密钥插件只在 APK 的 Capacitor 里注册；Web 上自然为 undefined，
    // 不需要再判断平台（D5：平台分支只留在存储层）。
    return window.Capacitor?.Plugins?.ByokSecrets || null;
}
async function loadApiSecrets() {
    const nativePlugin = getNativeSecretsPlugin();
    if (nativePlugin?.getSecret) {
        const values = await Promise.all(API_SECRET_NAMES.map(async name => {
            try { return [name, String((await nativePlugin.getSecret({ name }))?.value || '')]; }
            catch (error) {
                // **读取失败 ≠ 这个 Key 是空的**：返回空串会让启动流程把用户填好的
                //   Key 用空值覆盖掉（密钥库一旦拒绝这个键名，例如白名单漏配，
                //   见 ByokSecretsPlugin.ALLOWED_NAMES），表现正是"有些 Key 退出
                //   应用后不会保存"。所以返回 null 表示"这项读不到"，下面按名字
                //   过滤掉，设置里已有的值就不会被冲掉。
                console.warn(`[BYOK] 无法读取 ${name}，保留现有值`, error);
                return null;
            }
        }));
        Object.assign(state.settings, Object.fromEntries(values.filter(Boolean)));
    } else {
        // Web 版：API Key 按用户选择存进 data/（store.js 持久化到 data/store.json）。
        // APK 无 Keystore 插件时也走 Store（应用私有目录），与 Web 语义一致。
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
    // 密钥读完后再跑老配置共用凭据迁移：上面的赋值会把新键 mimoTtsApiKey 覆盖成空值，
    //   若只在 loadSettings() 里迁移会被这一步冲掉，所以迁移只在**这里**调用一次
    //   （loadSettings 会被多设备同步反复调用，放那里还会重复落盘）。
    await migrateLegacySharedMimoCredentials();
    await migrateLegacySharedAsrKey();
}

// 兼容老配置里「TTS / ASR 共用同一套 MiMo 凭据」：老配置只在 mimoApiKey / mimoBaseUrl 里存值。
// 拆分后 TTS 改用自己的 mimoTtsApiKey / mimoTtsBaseUrl，这里把旧值搬过去（仅当 TTS 侧为空）。
// 一次性门控用**版本号**而非布尔：单靠布尔没法区分"用户故意清空 TTS Key"和
//   "迁移只写了一部分（例如 v1 只写了 JSON、没写密钥库，下次 loadApiSecrets 会用
//   密钥库里的空值把 Key 覆盖掉）"。版本号让后者能够被重跑修好（`true !== 2` 会再跑
//   一次），而跑过当前版本的用户不会再被重跑，仍然尊重"用户故意清空"的选择。
const MIMO_CREDS_MIGRATION_VERSION = 2;
//
// ⚠️ 必须**在读取 API 密钥之后**调用（即 loadApiSecrets 末尾）：loadApiSecrets 会用密钥表里的
//    空值覆盖 TTS 键，提前迁移会被冲掉。迁移函数本身幂等（版本号相符后重复调用直接返回）。
async function migrateLegacySharedMimoCredentials() {
    if (state.settings.mimoCredsSplitMigrated === MIMO_CREDS_MIGRATION_VERSION) return; // 已是当前版本：不再跑
    if (!String(state.settings.mimoTtsApiKey || '').trim() && String(state.settings.mimoApiKey || '').trim()) {
        state.settings.mimoTtsApiKey = state.settings.mimoApiKey;
    }
    if (!String(state.settings.mimoTtsBaseUrl || '').trim() && String(state.settings.mimoBaseUrl || '').trim()) {
        state.settings.mimoTtsBaseUrl = state.settings.mimoBaseUrl;
    }
    state.settings.mimoCredsSplitMigrated = MIMO_CREDS_MIGRATION_VERSION;
    // 1) 版本标记写进普通设置（JSON）—— 它不在 API_SECRET_NAMES 里，不会被密钥库覆盖。
    try { persistSettings(); } catch (e) { /* 落盘失败不阻断启动 */ }
    // 2) 关键：迁移出的 TTS Key 必须同时写进**密钥库**（saveApiSecrets），否则下次启动
    //    loadApiSecrets 会用密钥库里的空值把它覆盖掉，而版本标记已置位不再重迁 → TTS 永久失效。
    //    传整个 state.settings 是**必须的**：saveApiSecrets 会把 API_SECRET_NAMES 里的每个键都
    //    按传入对象取值归一化，只传部分字段会把其余密钥写成空值（等于抹掉用户其它 Key）。
    try { await saveApiSecrets(state.settings); }
    catch (e) { console.warn('[BYOK] MiMo 凭据迁移写入密钥库失败', e); }
}

// 兼容老配置里「阿里百炼 ASR 复用语音输出的 DashScope Key」：老配置只在 dashscopeApiKey 里存值。
// 拆分后 ASR 用独立的 asrApiKey，这里把旧值搬过去（仅当 ASR 侧为空）。
// ⚠️ 与 MiMo 迁移同理：asrApiKey 是密钥名（API_SECRET_NAMES），loadApiSecrets 会用
//   密钥库里的值覆盖它。所以必须①在 loadApiSecrets **之后**执行；②迁移后把新值
//   写进**密钥库**（saveApiSecrets），否则下次启动会被密钥库里的空值冲掉。
//   用版本号门控保证只跑一次。
const ASR_KEY_MIGRATION_VERSION = 1;
async function migrateLegacySharedAsrKey() {
    if (state.settings.asrKeySplitMigrated === ASR_KEY_MIGRATION_VERSION) return; // 已迁移过：不再跑
    if (!String(state.settings.asrApiKey || '').trim() && String(state.settings.dashscopeApiKey || '').trim()) {
        state.settings.asrApiKey = state.settings.dashscopeApiKey;
    }
    state.settings.asrKeySplitMigrated = ASR_KEY_MIGRATION_VERSION;
    try { persistSettings(); } catch (e) { /* 落盘失败不阻断启动 */ }
    // 必须写进密钥库，否则会被下一次 loadApiSecrets 覆盖成空（见上方注释）
    try { await saveApiSecrets(state.settings); }
    catch (e) { console.warn('[BYOK] 阿里百炼 ASR Key 迁移写入密钥库失败', e); }
}
// 手机「读取信息」的六个隐私开关默认关闭。
//   为什么不能只改 DEFAULTS：设置是"默认值 + 已存值"合并出来的，老用户的
//   elaina_open_settings 里早就存着这六个 `true` —— 光改默认值，界面上看到的
//   还是全开，等于没改。所以这里做一次性迁移：把这六项强制置为关并写下版本号；
//   之后用户自己在设置里怎么拨，就按他自己的选择走。
//   ⚠️ 与其它一次性迁移同理：门控用**版本号**而不是布尔，以后若要再改默认值，
//      把版本号 +1 即可重跑一次，不必去猜用户当初的标记含义。
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

async function saveApiSecrets(secrets) {
    const normalized = Object.fromEntries(API_SECRET_NAMES.map(name => [name, String(secrets?.[name] || '').trim()]));
    const nativePlugin = getNativeSecretsPlugin();
    if (nativePlugin?.setSecret) {
        await Promise.all(API_SECRET_NAMES.map(name => nativePlugin.setSecret({ name, value: normalized[name] })));
    } else {
        const raw = JSON.stringify(normalized);
        // 按用户选择：API Key 随其它数据一起进 data/（方便优先）。
        // 代价是密钥落在磁盘上 —— data/ 已在 .gitignore 里，但拷走 data/ 就等于拷走密钥。
        try { Store.setItem('elainachat_open_api_secrets', raw); }
        catch (e) { console.warn('[BYOK] API Key 保存失败', e); }
    }
    Object.assign(state.settings, normalized);
}
async function clearStoredApiSecrets() {
    const nativePlugin = getNativeSecretsPlugin();
    if (nativePlugin?.clearSecrets) await nativePlugin.clearSecrets();
    try { Store.removeItem('elainachat_open_api_secrets'); } catch (e) {}
    API_SECRET_NAMES.forEach(name => { state.settings[name] = ''; });
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

    // v2.1 及更早版本的结构化角色卡只在读取时迁移一次；运行时不再逐字段拼装。
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
            ? `${DEFAULT_CHARACTER_CARD.characterPrompt}\n\n# 旧版自定义补充\n${legacyParts.join('\n\n')}`
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

function loadLikedQuotes() {
    const raw = Store.getItem('elaina_open_liked_quotes');
    if (raw) {
        try { state.likedQuotes = JSON.parse(raw) || {}; } catch (e) { state.likedQuotes = {}; }
    }
}


