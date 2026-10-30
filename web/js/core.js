/* ========================================================================
 * 基础设施：原生适配 / chat API 抽象 / 本机中转
 *
 * 经典脚本：顶层 function/const 共享全局词法环境，加载顺序由 index.html 决定。
 * ======================================================================== */

// 兼容旧 WebView（Chromium < 86 无 Element.replaceChildren，会导致发送流程
// 在 consumePendingComposerImage -> renderPendingComposerImage 处抛 TypeError，
// 请求根本发不出去）。仅在缺失时注入，不影响新设备行为。
if (window.Element && !Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
        while (this.firstChild) this.removeChild(this.firstChild);
        for (var i = 0; i < arguments.length; i++) {
            var arg = arguments[i];
            this.appendChild(arg instanceof Node ? arg : document.createTextNode(String(arg)));
        }
    };
}


// ==================== 原生（Capacitor APK）Live2D 模型存储适配 ====================
// APK 没有 Node 后端：/api/live2d/* 接口在本机用 Capacitor Filesystem 实现
const IS_NATIVE_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

/**
 * 这个浏览器自己有没有「安装到桌面」的入口。
 *
 * 判据只有一条：**它会不会发 `beforeinstallprompt`**。会发的（Chrome / Edge 等
 * 内置 Chromium 的浏览器）地址栏本来就提供安装；不会发的（Firefox、桌面 Safari）
 * 则完全没有入口，那种情况下网页侧那个按钮才有意义。
 *
 * 为什么不用 UA 判断：UA 是"这个浏览器是谁"，而我们要的是"它有没有安装入口"；
 * 同一内核被各家套壳后 UA 五花八门，按名字列表判断迟早漏。这条能力探测只跑一次。
 */
let ownInstallEntryKnown = null;
function browserShowsOwnInstallEntry() {
    if (ownInstallEntryKnown !== null) return ownInstallEntryKnown;
    ownInstallEntryKnown = ('onbeforeinstallprompt' in window);
    return ownInstallEntryKnown;
}

/**
 * 运行环境的事实，供**不该知道平台分支**的模块读取（AGENTS.md D5）。
 *
 * 典型使用方是 web/js/pwa.js：它要判断"这个环境该不该注册 Service Worker、
 * 该不该显示「安装到桌面」"。这件事在浏览器版与安卓壳里答案不同，但 pwa.js
 * 绝不能自己去摸 Capacitor —— 那样平台判断就从适配层外溢到了业务模块，
 * 正是 D5 要防的「两端分裂成两套代码」。
 *
 * 所以判断留在这里（core.js 的原生适配段），对外只暴露与平台无关的语义：
 * 调用方问的是"能不能装成一个应用"，而不是"你是什么平台"。
 */
window.ElainaRuntime = {
    /** 是否跑在安卓原生壳（Capacitor）里 —— 只有适配层与设置页说明文案该读它 */
    get isNativeShell() { return IS_NATIVE_APP; },
    /**
     * 本环境能否把本站「安装」成一个独立应用。
     *
     * 安卓壳里页面已经被装成 APK 了，再注册 SW 只会多一层不可见的缓存风险；
     * 浏览器版才是「网页 → 桌面应用」这条路的适用场景。
     *
     * 但"跑在浏览器里"≠"该显示安装按钮"：地址栏本来就有安装图标的浏览器
     * （Chrome / Edge / 各家的主浏览器）由浏览器自己提供一个入口，再在顶栏摆一个
     * 就等于同一件事给两遍 —— 主界面是聊天的地方，不是放"装我"的地方。
     * 所以这里再收一档：只有**地址栏没有安装入口**的浏览器（Firefox、桌面版
     * Safari 等没有 `beforeinstallprompt` 能力的）才需要我们自己给一个按钮。
     */
    get canInstallAsApp() {
        return !IS_NATIVE_APP && !browserShowsOwnInstallEntry();
    },
};
// 设备形态：决定「设置 → 高级」里显示电脑侧还是手机侧的 Agent 权限。
// 注意与 isMobileConversationLayout() 的区别：那个看的是窗口宽度（决定排版），
// 这个看的是设备本身（决定给用户看哪组设置）—— 电脑上把窗口拖窄不该变成"手机"。
const IS_MOBILE_DEVICE = (function () {
    try {
        if (IS_NATIVE_APP) return true;   // 安卓版 App 一律按手机处理
        const ua = String(navigator.userAgent || '');
        if (/Android|iPhone|iPad|iPod|Windows Phone|HarmonyOS|Mobile/i.test(ua)) return true;
        // iPadOS 13+ 的 UA 伪装成 Macintosh，只能靠触摸点数区分：
        // iPad 是 5 点，真 Mac 桌面是 0。阈值取 1 以上是为了避开
        // "Mac + 单点触摸" 这类奇异环境。
        if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
    } catch (e) { /* 判断失败按电脑处理 */ }
    return false;
})();
/* 对话 API 格式只留三种。
   收敛掉 dashscope / gemini / ollama，因为它们的官方接口都能用标准
   /v1/chat/completions 说话（迁移表见下）—— 分成五个"格式"只是把同一套协议
   抄了五遍，用户还得猜自己该选哪个；选错了报的错又完全看不出是格式选错。

   注意：id 是持久化进 settings 的，改名必须同步维护 LEGACY_API_FORMAT_ALIASES，
   否则老用户一升级就被重置回默认值。 */
const state = {
    voiceState: 'idle',
    settings: { ...DEFAULT_SETTINGS },
    characterCard: { ...DEFAULT_CHARACTER_CARD },
    characterCards: [],   // 多套人设；characterCard 始终是"当前选中那套"的内容
    currentCardId: '',
    conversations: [],
    currentConversationId: null,
    categories: [],
    activeCategoryId: null,
    favorites: [],
    notesMode: false,
    diaryMode: false,
    // 日记页的"只看某段对话"筛选（空 = 显示全部）。
    //   由 focusDiaryGroup() 设置；进/出日记页时清掉，避免下次进来
    //   莫名其妙只看到一部分（那会让人以为日记丢了）。
    diaryFilterConvId: '',
    notesTab: 'message',
    selectedFavoriteId: null,
    catModalExpanded: {},
    thinkingMessageId: null,
    likedQuotes: {},
    memoryCore: null,
    memorySummaryRunning: false,
    // 用户资料（左下角头像点开的那个面板）：名称 / 头像是用户自己填的，
    //   impression 是伊蕾娜写的印象 —— 用户不可编辑（见 data.js 用户资料段）。
    userProfile: { name: '', avatar: '', impression: '' },
    userImpressionRunning: false,
    announcement: null,
    announcementLoading: false
};

const elements = {
    micBtn: document.getElementById('micBtn'),
    initialState: document.getElementById('initialState'),
    pulseRing1: document.getElementById('pulseRing1'),
    pulseRing2: document.getElementById('pulseRing2'),
    statusText: document.getElementById('statusText'),
    conversationHistory: document.getElementById('conversationHistory'),
    textInput: document.getElementById('textInput'),
    inputBar: document.getElementById('inputBar'),
    initialTextInput: document.getElementById('initialTextInput'),
    initialSendBtn: document.getElementById('initialSendBtn'),
    initialComposerMoreBtn: document.getElementById('initialComposerMoreBtn'),
    initialComposerMoreMenu: document.getElementById('initialComposerMoreMenu'),
    initialComposerImageBtn: document.getElementById('initialComposerImageBtn'),
    initialComposerImagePreview: document.getElementById('initialComposerImagePreview'),
    initialComposerMemoryBtn: document.getElementById('initialComposerMemoryBtn'),
    initialComposerMemoryStatus: document.getElementById('initialComposerMemoryStatus'),
    initialComposerPromptBtn: document.getElementById('initialComposerPromptBtn'),
    conversationSendBtn: document.getElementById('conversationSendBtn'),
    composerMoreBtn: document.getElementById('composerMoreBtn'),
    composerMoreMenu: document.getElementById('composerMoreMenu'),
    composerImageBtn: document.getElementById('composerImageBtn'),
    composerImagePreview: document.getElementById('composerImagePreview'),
    composerImageInput: document.getElementById('composerImageInput'),
    composerMemoryBtn: document.getElementById('composerMemoryBtn'),
    composerMemoryStatus: document.getElementById('composerMemoryStatus'),
    composerPromptBtn: document.getElementById('composerPromptBtn'),
    settingsPanel: document.getElementById('settingsPanel'),
    settingsOverlay: document.getElementById('settingsOverlay'),
    chatHeader: document.getElementById('chatHeader'),
    closeSettings: document.getElementById('closeSettings'),
    // cancelSettings / saveSettings 已随底部按钮栏一起删除
    //   不再查这两个 id —— 它们现在恒为 null，留着会让人误以为还在用。
    sidebar: document.getElementById('sidebar'),
    mobileSidebarClose: document.getElementById('mobileSidebarClose'),
    sidebarOverlay: document.getElementById('sidebarOverlay'),
    showSidebar: document.getElementById('showSidebar'),
    newConversationBtn: document.getElementById('newConversationBtn'),
    newCategoryBtn: document.getElementById('newCategoryBtn'),
    sidebarSearchInput: document.getElementById('sidebarSearchInput'),
    sidebarSearchClear: document.getElementById('sidebarSearchClear'),
    folderList: document.getElementById('folderList'),
    notesBtn: document.getElementById('railNotesBtn'),
    notesBadge: document.getElementById('notesBadge'),
    manageCategoriesBtn: document.getElementById('railCategoriesBtn'),
    railChatBtn: document.getElementById('railChatBtn'),
    railDiaryBtn: document.getElementById('railDiaryBtn'),
    railSettingsBtn: document.getElementById('railSettingsBtn'),
    railProfileBtn: document.getElementById('railProfileBtn'),
    currentConversationTitle: document.getElementById('currentConversationTitle'),
    floatingMic: document.getElementById('floatingMic'),
    floatingVoiceTitle: document.getElementById('floatingVoiceTitle'),
    floatingVoiceHint: document.getElementById('floatingVoiceHint'),
    floatingMicBtn: document.getElementById('floatingMicBtn'),
    floatingPulse1: document.getElementById('floatingPulse1'),
    floatingPulse2: document.getElementById('floatingPulse2'),
    floatingEndBtn: document.getElementById('floatingEndBtn'),
    floatingCancelBtn: document.getElementById('floatingCancelBtn'),
    notesPage: document.getElementById('notesPage'),
    diaryPage: document.getElementById('diaryPage'),
    diaryGrid: document.getElementById('diaryGrid'),
    diaryEmpty: document.getElementById('diaryEmpty'),
    diaryCount: document.getElementById('diaryCount'),
    exitDiaryBtn: document.getElementById('exitDiaryBtn'),
    exitNotesBtn: document.getElementById('exitNotesBtn'),
    notesSearch: document.getElementById('notesSearch'),
    notesCount: document.getElementById('notesCount'),
    notesEmpty: document.getElementById('notesEmpty'),
    notesGrid: document.getElementById('notesGrid'),
    favoriteDetail: document.getElementById('favoriteDetail'),
    notesOverlay: document.getElementById('notesOverlay'),
    favoriteDetailCard: document.getElementById('favoriteDetailCard'),
    detailTypeBadge: document.getElementById('detailTypeBadge'),
    detailRole: document.getElementById('detailRole'),
    detailTimestamp: document.getElementById('detailTimestamp'),
    detailText: document.getElementById('detailText'),
    detailContextSection: document.getElementById('detailContextSection'),
    detailConvTitle: document.getElementById('detailConvTitle'),
    detailClose: document.getElementById('detailClose'),
    detailJumpBtn: document.getElementById('detailJumpBtn'),
    detailRemoveBtn: document.getElementById('detailRemoveBtn'),
    quoteText: document.getElementById('quoteText'),
    quoteSource: document.getElementById('quoteSource'),
    quoteLikeBtn: document.getElementById('quoteLikeBtn'),
    quoteFavBtn: document.getElementById('quoteFavBtn'),
    // 顶栏「公告」按钮 + 下拉面板
    announceBtn: document.getElementById('headerAnnounceBtn'),
    announceStatusDot: document.getElementById('announceStatusDot'),
    announcePanel: document.getElementById('announcePanel'),
    announceList: document.getElementById('announceList'),
    announcePanelClose: document.getElementById('announcePanelClose'),
    categoriesModalOverlay: document.getElementById('categoriesModalOverlay'),
    categoriesModalList: document.getElementById('categoriesModalList'),
    categoriesModalClose: document.getElementById('categoriesModalClose'),
    categoriesModalNew: document.getElementById('categoriesModalNew'),
    categoriesBatchBar: document.getElementById('categoriesBatchBar'),
    catSelectedCount: document.getElementById('catSelectedCount'),
    catSelectAllBtn: document.getElementById('catSelectAllBtn'),
    catInvertBtn: document.getElementById('catInvertBtn'),
    catMoveSelect: document.getElementById('catMoveSelect'),
    catDeleteSelectedBtn: document.getElementById('catDeleteSelectedBtn'),
    conversationMoveOverlay: document.getElementById('conversationMoveOverlay'),
    conversationMoveList: document.getElementById('conversationMoveList'),
    conversationMoveClose: document.getElementById('conversationMoveClose'),
    conversationMoveCancel: document.getElementById('conversationMoveCancel'),
    customModal: document.getElementById('customModal'),
    customModalTitle: document.getElementById('customModalTitle'),
    customModalMessage: document.getElementById('customModalMessage'),
    customModalInput: document.getElementById('customModalInput'),
    // 代码编辑区的配套元素（行号 / 高亮层 / 模板按钮 / 普通单行输入）
    customModalPlainInput: document.getElementById('customModalPlainInput'),
    customModalEditor: document.getElementById('customModalEditor'),
    customModalGutter: document.getElementById('customModalGutter'),
    customModalPresets: document.getElementById('customModalPresets'),
    customModalActions: document.getElementById('customModalActions'),
    customModalCancelBtn: document.getElementById('customModalCancelBtn'),
    customModalAltBtn: document.getElementById('customModalAltBtn'),
    customModalExtraBtn: document.getElementById('customModalExtraBtn'),
    customModalConfirmBtn: document.getElementById('customModalConfirmBtn'),
    announcementOverlay: document.getElementById('announcementOverlay'),
    announcementTitle: document.getElementById('announcementTitle'),
    announcementContent: document.getElementById('announcementContent'),
    announcementConfirmBtn: document.getElementById('announcementConfirmBtn'),
    // 远程公告 / 10.17 本地兜底（见 data.js 的 startAnnouncements / syncAnnounceBadge）
    serverAnnounceOverlay: document.getElementById('serverAnnounceOverlay'),
    serverAnnounceTitle: document.getElementById('serverAnnounceTitle'),
    serverAnnounceContent: document.getElementById('serverAnnounceContent'),
    serverAnnounceAction: document.getElementById('serverAnnounceAction'),
    serverAnnounceClose: document.getElementById('serverAnnounceClose'),
    conversationPromptOverlay: document.getElementById('conversationPromptOverlay'),
    conversationWorldInput: document.getElementById('conversationWorldInput'),
    conversationCharacterInput: document.getElementById('conversationCharacterInput'),
    conversationPromptCount: document.getElementById('conversationPromptCount'),
    conversationPromptError: document.getElementById('conversationPromptError'),
    conversationPromptCancelBtn: document.getElementById('conversationPromptCancelBtn'),
    conversationPromptSaveBtn: document.getElementById('conversationPromptSaveBtn'),
    settingApiFormat: document.getElementById('settingApiFormat'),
    settingBaseUrl: document.getElementById('settingBaseUrl'),
    settingChatModel: document.getElementById('settingChatModel'),
    // 对话优化：思考强度（四档下拉，off 即"不思考"）+ 第三人称两段式开关。
    // 位置在「设置 → 模型」（输入框旁的 ⊕ 菜单只放本轮操作）。
    settingThinkingEffort: document.getElementById('settingThinkingEffort'),
    thinkingModeHint: document.getElementById('thinkingModeHint'),
    settingThirdPerson: document.getElementById('settingThirdPerson'),
    // AI 联网搜索：与「对话优化」其它项同组
    settingTavilyEnabled: document.getElementById('settingTavilyEnabled'),
    settingSearchProvider: document.getElementById('settingSearchProvider'),
    searchProviderHint: document.getElementById('searchProviderHint'),
    searchKeyLabel: document.getElementById('searchKeyLabel'),
    searchKeyHint: document.getElementById('searchKeyHint'),
    settingTavilyApiKey: document.getElementById('settingTavilyApiKey'),
    settingTavilyMaxResults: document.getElementById('settingTavilyMaxResults'),
    settingTavilySearchDepth: document.getElementById('settingTavilySearchDepth'),
    tavilyFields: document.getElementById('tavilyFields'),
    tavilyHint: document.getElementById('tavilyHint'),
    testTavilyBtn: document.getElementById('testTavilyBtn'),
    searchCustomFields: document.getElementById('searchCustomFields'),
    settingSearchCustomEndpoint: document.getElementById('settingSearchCustomEndpoint'),
    settingSearchCustomAuth: document.getElementById('settingSearchCustomAuth'),
    settingSearchCustomAuthHeader: document.getElementById('settingSearchCustomAuthHeader'),
    settingSearchCustomHeaderRow: document.getElementById('searchCustomHeaderRow'),
    settingSearchCustomBody: document.getElementById('settingSearchCustomBody'),
    settingSearchCustomResultsPath: document.getElementById('settingSearchCustomResultsPath'),
    settingApiKey: document.getElementById('settingApiKey'),
    testChatConnectionBtn: document.getElementById('testChatConnectionBtn'),
    testTtsConnectionBtn: document.getElementById('testTtsConnectionBtn'),
    clearApiKeysBtn: document.getElementById('clearApiKeysBtn'),
    chatFormatHint: document.getElementById('chatFormatHint'),
    settingTtsProvider: document.getElementById('settingTtsProvider'),
    minimaxTtsFields: document.getElementById('minimaxTtsFields'),
    mimoTtsFields: document.getElementById('mimoTtsFields'),
    openaiTtsFields: document.getElementById('openaiTtsFields'),
    dashscopeTtsFields: document.getElementById('dashscopeTtsFields'),
    settingTtsSpeed: document.getElementById('settingTtsSpeed'),
    ttsSpeedLabel: document.getElementById('ttsSpeedLabel'),
    settingTtsVolume: document.getElementById('settingTtsVolume'),
    ttsVolumeLabel: document.getElementById('ttsVolumeLabel'),
    settingAutoMemory: document.getElementById('settingAutoMemory'),
    settingMemoryEvery: document.getElementById('settingMemoryEvery'),
    // 记忆模块的步进器按钮与「立即整理记忆」按钮
    memoryEveryMinus: document.getElementById('memoryEveryMinus'),
    memoryEveryPlus: document.getElementById('memoryEveryPlus'),
    memoryNowBtn: document.getElementById('memoryNowBtn'),
    // settingLogLevel / settingLogTrace 已随「日志设置」界面一起移除（见 index.html 的说明）
    memoryBtn: document.getElementById('headerMemoryBtn'),
    memoryStatusDot: document.getElementById('memoryStatusDot'),
    dashscopeAsrFields: document.getElementById('dashscopeAsrFields'),
    initialEndBtn: null,
    initialCancelBtn: null
};

// 角色卡已经在 tab-character 内，**不要**再 appendChild 到设置内容末尾：
// 分栏布局下那样做会让它脱离面板，出现在每个 Tab 的底部。

const ASR_TARGET_SAMPLE_RATE = 16000;
const ASR_MAX_RECORD_SECONDS = 60;
const ASR_PAUSE_DELAY_MS = 2000;
const ASR_AUTO_SUBMIT_DELAY_MS = 2500;
const ASR_CLOUD_FINAL_TIMEOUT_MS = 20000;
const ASR_MIN_RMS = 0.006;
const ASR_MIN_ACTIVE_RATIO = 0.02;
const ASR_BAD_FINAL_TEXTS = new Set(['', '.', '。', '。.', '。。。', '我想想', '嗯', '啊', '哦']);

let browserRecognition = null;
let asrMode = 'browser-session';
let asrReady = false;
let asrEnding = false;
let asrSubmitting = false;
let asrStarting = false;
let asrRecognitionActive = false;
let asrHadTranscript = false; // 本次识别是否已产生有效内容（有结果时不再弹 network 类错误）
let asrSessionId = 0;
let asrMediaStream = null;
let asrAudioContext = null;
let asrSourceNode = null;
let asrProcessorNode = null;
let asrRecordedChunks = [];
let asrRecordedSampleCount = 0;
let asrRecordedSquareSum = 0;
let asrRecordedPeak = 0;
let asrRecordedActiveSamples = 0;
let currentTranscript = '';
let lastSpeechTime = 0;
let silenceTimer = null;
let pausedSubmitTimer = null;
let cloudFinalAsrAvailable = false;
let todayQuote = null;

function generateId() {
    return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
}


// ==================== 统一 chat API 调用抽象 ====================

function getNativeByokHttpPlugin() {
    if (!window.Capacitor?.isNativePlatform?.()) return null;
    return window.Capacitor?.Plugins?.ByokHttp || null;
}

/**
 * 这台电脑上「桌面 / 文档 / 下载 …」的真实位置，由同源的 serve.mjs 从注册表读出来。
 *
 * 为什么非要有这个：用户可以把桌面**移动到任意位置**（桌面右键 → 属性 → 位置 → 移动），
 * OneDrive 也会把桌面重定向到 OneDrive 下。这时 `C:\Users\<用户名>\Desktop` 根本不存在，
 * 而 AI 只会按惯例猜这个路径 —— 猜错就是一句「目录不存在」，然后它就没招了。
 * 猜错的后果很具体：用户桌面在 `D:\桌面` 时 AI 猜 `C:\Users\Administrator\Desktop`，
 * 拿到「目录不存在」就再没有别的招了。
 *
 * 一律按 permission=computer 询问：服务端只在**本机请求**时才回真实路径，
 * 局域网访客拿到的是一份没有 path 的列表，不存在越权泄露。
 */
let agentRootsProbe = null;
let agentRootsCache = null;
function detectAgentRoots() {
    if (agentRootsProbe) return agentRootsProbe;
    agentRootsProbe = (async () => {
        if (IS_NATIVE_APP) return null;
        if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
        try {
            // 把**真实档位**告诉服务端：`off` 档下服务端会隐去真实路径（连"桌面在哪"
            // 也算电脑信息）。不再写死 permission=computer —— 那是旧两档模型的遗留。
            const access = typeof currentAgentAccess === 'function' ? currentAgentAccess() : 'strict';
            const response = await fetchWithTimeout('/api/agent/roots?access=' + encodeURIComponent(access), { method: 'GET' }, 6000);
            if (!response.ok) return null;
            const info = await response.json();
            return info && info.ok && Array.isArray(info.roots) ? info.roots : null;
        } catch {
            return null;
        }
    })().then((roots) => {
        agentRootsCache = roots;
        // 只缓存成功：失败可能只是服务端在忙，缓存下来会整个会话都拿不到真实路径
        if (!roots) agentRootsProbe = null;
        return roots;
    });
    return agentRootsProbe;
}

/**
 * 同步取已探测到的真实位置，拼成给 AI 看的一段提示。
 * 提示词构造函数是同步的，没法 await，所以只能读缓存（页面启动时就预热了）。
 *
 * strict / auto / full 三档下**一律注入**：三档都能访问任意路径，所以"桌面到底在哪"
 *   对每一档都有用（旧模型下只有 computer 档才注入，因为 app 档碰不到那些位置）。
 *   `off` 档是唯一例外 —— 电脑操作整体关闭，真实路径也不该让 AI 知道（见函数内那行）。
 */
function agentRootsText() {
    // `off` 档：电脑操作整体关闭时，"桌面/文档/下载在哪"也是**电脑信息**，不注入。
    //   这是不泄路径的**真正保险**：即便探测缓存里还留着上一次拿到的真实路径，
    //   只要当前档位是 off，就不会进提示词。
    if (typeof agentAccessDisabled === 'function' && agentAccessDisabled()) return '';
    const roots = Array.isArray(agentRootsCache) ? agentRootsCache.filter(r => r && r.path) : [];
    if (!roots.length) return '';
    return '\n# 这台电脑的真实位置（用户可能把桌面/文档移动过，**不要**按惯例猜 C:\\Users\\<用户名>\\Desktop）\n'
        + roots.map(r => `${r.label} = ${r.path}`).join('\n')
        + '\n需要这些位置时直接用上面的绝对路径，或用别名 %DESKTOP% / %DOCUMENTS% / %DOWNLOADS%（服务端会自动换成真实路径）。路径猜错会直接失败，所以不确定就先 [操作:列出文件 %DESKTOP%] 看一眼。';
}

function getChatApiFormat(settings = state.settings) {
    const format = String(settings.apiFormat || 'openai-compatible').toLowerCase();
    return CHAT_API_FORMATS[format] ? format : 'openai-compatible';
}

function stripThinkTags(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/\[think\][\s\S]*?\[\/think\]/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .trim();
}

function extractTextContent(content) {
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            return part?.text || part?.content || part?.transcript || '';
        }).join('');
    }
    return String(content ?? '');
}

function normalizeChatReply(content, reasoningContent = '', toolCalls = []) {
    const text = stripThinkTags(extractTextContent(content));
    const reasoning = String(reasoningContent || '').trim();
    // "只调工具、一个字不说"是**合法**回复（模型先动手、再开口）。
    //   把它当空回复抛错，等于在收尾那一步把工具通道当场废掉 —— 而这条路上
    //   正文为空恰恰是最常见的情形之一。
    if (!text && Array.isArray(toolCalls) && toolCalls.length) return '';
    if (!text) {
        if (reasoning) {
            throw new ClientApiError('EMPTY_MODEL_OUTPUT', '模型只返回了思考内容，没有生成可见回复，请重试或缩短输出。');
        }
        throw new ClientApiError('EMPTY_MODEL_OUTPUT', '模型返回了空回复，请重试。');
    }
    return text;
}
/* ---------- OpenAI 官方 Responses 接口（/v1/responses）----------
   它和 chat/completions 不是同一套协议，必须单独适配，不能靠改个路径蒙混：
     · 系统提示走顶层 instructions，不是 messages 里的一条
     · 对话内容走 input 数组，每项 { role, content: [{ type:'input_text'|'output_text'|'input_image' }] }
     · 输出上限参数叫 max_output_tokens，不叫 max_tokens
     · 回复不在 choices[0].message.content，而在 output[] 里 type === 'message' 那些项的 content 块里
   这些字段名是官方文档定的，写错会直接 400，而报错往往只说 "unknown parameter"，
   排查起来很费劲，所以在这里一次写清楚。 */

/**
 * 把**开头连续的** system 消息合并成一条。
 *
 * 起因：有些自建/中转网关**只接受一条 system 消息**，且必须在位置 0。实测
 * `developer.amd.com.cn` 的 `self-dploy` 后端就是这样：`[system, user]` 返回 200，
 * 而 `[system, system, user]` 直接 400 `System message must be at the beginning.`
 * —— 报错文案有误导性，它说的其实是"system 消息只能有一条，不能有第二条"。
 *
 * 而本应用的「分层」提示词结构（layered-v2）一次会发 4~10 条 system：
 * 核心协议 / 世界观 / 角色卡 / Live2D 标签指南 / 会话专属设定 / 记忆规则 /
 * 图片一致性 / 配音格式 / 回合锚点 / 模型可用表现 / 水印提示 / Agent 权限。
 * 在宽容的服务商（OpenAI、DeepSeek 官方）上没问题，撞上这类网关就整个对话发不出去。
 *
 * 合并是**语义等价**的：多条 system 与"按顺序拼成一条"对模型没有实质区别，
 * 内容一字不少（用空行分隔，和 legacy 模式的做法一致）。
 * 只合并开头那一段 —— 万一将来有人把 system 插到中间，那是另一个错误，不该被这里掩盖。
 */
function mergeLeadingSystemMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    let end = 0;
    while (end < list.length && list[end] && list[end].role === 'system') end++;
    if (end <= 1) return list;   // 0 条或 1 条，不用动
    const merged = list.slice(0, end)
        .map(message => extractTextContent(message.content))
        .filter(text => String(text || '').trim())
        .join('\n\n');
    return [{ role: 'system', content: merged }, ...list.slice(end)];
}

/* ===== 对话 API 格式适配器的依赖注入 =====
 *
 * 三种协议（openai-compatible / anthropic / openai-responses）的实现已拆到 web/js/chat-providers.js：
 *   那是普通 <script>（不是 ES module），文件之间作用域独立，直接调用这里的 getChatBaseUrl() 会拿到 undefined，
 *   所以依赖显式挂到 window。
 * **加新依赖时必须同步加到这里**：漏了不会在加载时报错，而是运行到那一步才炸（"xxx is not a function"）。
 *   scripts/check-chat-providers.mjs 会扫描 deps() 解构出的名字逐个断言，跑 check 就能发现。
 * 注意 ClientApiError 是 class：挂的是**类本身**，拆出去那份 new 出来的实例仍是同一个类（instanceof 照常）。
 */
window.ChatDeps = {
    ClientApiError,
    getChatBaseUrl,
    isDeepSeekOfficial,
    postJsonFromDevice,
    // 流式出口：providers 用它发请求，内部自己决定走流式还是退回非流式。
    // 三个 provider 都改用它之后，`要不要流式`这个判据就只有一处（requestChatJson）。
    requestChatJson,
    // 思考开关/强度 → 各协议的请求字段。放这里是因为三种格式都要用，
    // 而"某家该发什么字段"的判据抄三遍必然有一处忘了更新。
    buildThinkingParams,
    normalizeChatReply,
    throwProviderResponseError,
    extractTextContent,
    stripThinkTags,
    resolveOutputTokenLimit,
    ANTHROPIC_MIN_MAX_TOKENS,
};

async function callChatAPI(messages, opts = {}, settings = state.settings) {
    const format = getChatApiFormat(settings);
    // 千问的兼容端点可以复用语音那边的 DashScope Key（阿里云同一个 Key 通用）。
    // 判据是**地址**而不是 apiFormat：格式合并后同一个格式可以指向任何兼容服务，
    // 只有地址确实指着 DashScope 时才复用那个 Key，否则会误用。
    if (!String(settings.apiKey || '').trim() && String(settings.dashscopeApiKey || '').trim()
        && /dashscope\.aliyuncs\.com/i.test(String(settings.baseUrl || ''))) {
        settings = Object.assign({}, settings, { apiKey: settings.dashscopeApiKey });
    }
    // 统一在这里合并，三种格式都受益：Anthropic / Responses 的转换器本来就会把
    // system 收拢成单条，合并后行为不变；openai-compatible 是原样透传，正是需要这一层的地方。
    const normalized = mergeLeadingSystemMessages(messages);
    // 回复侧元信息（工具调用 / 停止原因 / 是否降级）走**调用方传进来的容器**：
    // 返回值的形状是"正文文本"，全库多处调用点（记忆摘要、翻译、连接测试…）
    // 只关心它，不该为一个字段把那些地方全卷进来。
    // 这里先给初值：否则走 Anthropic / Responses 时上层会拿到 undefined，
    // 还得各自兜一次默认值。
    if (opts.replyInfo) {
        opts.replyInfo.toolCalls = [];
        opts.replyInfo.finishReason = '';
        opts.replyInfo.toolsSkipped = false;
        // 思考正文的**兜底通道**。
        //   流式路径上思考是随增量一段段进来的（onDelta → appendTurnReasoning），
        //   时间线当场就拿到了。但 requestChatJson 在"流式一个字都没吐就失败"时
        //   会**静默退回非流式** —— 那时 onDelta 再也不触发，而思考仍然躺在响应体
        //   里（openai-compatible 的 reasoning_content / anthropic 的 thinking block /
        //   responses 的 reasoning item）。
        //   没有这个通道的话，退回一次就等于"这一轮没有思考"：用户看到的是
        //   思考内容**时有时无**，而原因（换了条传输路径）完全不可见。
        //   探针实测同一份请求：流式拿到 1398 字思考，非流式响应里也有 2437 字，
        //   但只返回正文的写法会让那 2437 字被直接丢弃。
        //   所以这里先给空串，由各 provider 解析出思考后填进来，调用方据此补送。
        opts.replyInfo.reasoning = '';
    }
    // 输出上限在这里统一算一次，三种格式都受益 —— 让「模型名后缀是否要求保底」这个判据
    // 只有一处，而不是散在三个格式函数里（见 resolveOutputTokenLimit 的说明）。
    // 注意 providers 里那个老模型名 → deepseek-flash 的映射也**不含** `-thinking` 后缀，
    // 所以先算后算结果一样。
    const resolvedOpts = Object.assign({}, opts, {
        maxTokens: resolveOutputTokenLimit(settings.model, opts.maxTokens, format === 'anthropic'),
        // 超时要按**是否开思考**分开给：postJsonFromDevice 的 120 秒默认值是给
        //   普通请求定的。开思考（尤其高强度）时模型先默默推理几十秒到几分钟才吐
        //   第一个 token，120 秒经常不够 —— 表现是"超过 120 秒没有响应 → 流式不可用，
        //   退回非流式"，用户看到的就是"AI 不流式"，实际是等待期就被本地掐了。
        //   注意：**超时是空闲语义**（见 serve.mjs 的 armIdleTimer）——
        //   服务端每收到一块数据就续期，所以调大它不会让"长回复"变慢或卡住，
        //   只会放宽"多久没动静才算死"。这里给思考模式 5 分钟、普通 2 分钟。
        //   服务端 RELAY_TIMEOUT_MAX（10 分钟）仍是硬上限，不会被这里绕过。
        timeoutMs: Number.isFinite(opts.timeoutMs)
            ? opts.timeoutMs
            : (opts.thinking ? CHAT_TIMEOUT_THINKING_MS : CHAT_TIMEOUT_DEFAULT_MS),
    });
    // 把消息形状打进日志：**只记 role，不记内容**（内容可能含对话隐私与图片 base64）。
    // 排查"服务商拒收请求"时，一眼就能看出是不是 system 的位置/条数不对，
    // 不用靠猜（"System message must be at the beginning." 就是这么定位的）。
    // 顺带记输出上限：`max_tokens must be greater than 1024…` 那类 400 一眼能对上号。
    console.log(`[Chat] ${format} 发送 ${normalized.length} 条：${normalized.map(m => m && m.role).join(',')}，输出上限 ${Number.isFinite(resolvedOpts.maxTokens) ? resolvedOpts.maxTokens : '服务商默认'}`);
    // 按格式分发到 chat-providers.js 里的实现（表驱动，不再是 if 链）。
    // 好处：新增格式只要往那边的 PROVIDERS 表加一行，这里不用动 ——
    // 改两处就有一处会漏，改一处不会。未知格式由 forFormat 兜底到 openai-compatible，
    // 与原 if 链最后那个 return 的行为完全一致。
    return window.ChatProviders.forFormat(format)(normalized, resolvedOpts, settings);
}

/**
 * 取 Live2D 插件注册的服务（host.service('live2d')）。
 * 宿主不直接点名插件的 window 全局名；插件不在/停用时返回 null（D3）。
 */
function live2dService() {
    try {
        return (window.ElainaMods && typeof window.ElainaMods.service === 'function')
            ? window.ElainaMods.service('live2d') : null;
    } catch (e) { return null; }
}

// ==================== 宿主内部接口（插件系统唯一可依赖的宿主面）====================
// `mods.js` 的 host API 需要借宿主的内部实现（发消息、渲染 Markdown、弹确认框）。直接 `typeof handleUserInput`
//   去摸全局名的话，宿主一改名插件就在运行到那一步时炸，而插件作者看不到改名 —— 那正是 host API 该防住的事。
// 所以这里集中声明**宿主愿意提供、且承诺保持签名**的入口，宿主内部随便重构，只要更新这张映射表。
// 加新成员前先问：它是不是该做成**插槽**或**事件**？插槽与事件才是插件的正路，这里是给
//   「宿主已经有、插件只想复用」的能力用的（见 AGENTS.md D7）。
// 加载顺序：本文件先于 ui.js / voice.js 执行，所以用 **getter** 惰性取值，不能在求值时把函数抓下来。
window.ElainaHost = {
    /** 宿主版本（与 manifest 的 version 无关，插件可用它做能力判断） */
    get version() { return '1.0.0'; },

    /** 全局运行状态（插件只读：`conversations` / `currentConversationId` / `notesMode` / `diaryMode`） */
    get state() {
        try { return (typeof state === 'undefined') ? null : state; } catch (e) { return null; }
    },

    /** 发一条用户消息（走主输入框同一条链路：记忆、续跑、停止、语音都自动生效） */
    get sendUserMessage() {
        try { return typeof handleUserInput === 'function' ? handleUserInput : null; } catch (e) { return null; }
    },
    /** 生成一个与宿主同格式的消息 id */
    get newId() {
        try { return typeof generateId === 'function' ? generateId : null; } catch (e) { return null; }
    },
    /** 按消息算一个标题（纯函数，不改任何状态） */
    get autoNameConversation() {
        try { return typeof autoNameConversation === 'function' ? autoNameConversation : null; } catch (e) { return null; }
    },
    /** 若标题仍是自动取的就重算一次；返回"是否真的改了" */
    get refreshAutoConversationTitle() {
        try {
            return typeof refreshAutoConversationTitle === 'function' ? refreshAutoConversationTitle : null;
        } catch (e) { return null; }
    },
    /** 重新渲染侧栏会话列表 */
    get renderFolderList() {
        try { return typeof renderFolderList === 'function' ? renderFolderList : null; } catch (e) { return null; }
    },
    /** 刷新当前会话标题 */
    get updateCurrentConversationTitle() {
        try { return typeof updateCurrentConversationTitle === 'function' ? updateCurrentConversationTitle : null; } catch (e) { return null; }
    },
    /** 切到某个会话并把它画出来 */
    get loadConversation() {
        try { return typeof loadConversation === 'function' ? loadConversation : null; } catch (e) { return null; }
    },
    /** Markdown / LaTeX 渲染（与主界面同一套） */
    get renderMessageText() {
        try { return typeof renderMessageText === 'function' ? renderMessageText : null; } catch (e) { return null; }
    },
    /** 宿主弹窗：提示 / 确认（插件不要直接摸这两个全局名） */
    get showCustomAlert() {
        try { return typeof showCustomAlert === 'function' ? showCustomAlert : null; } catch (e) { return null; }
    },
    get showCustomConfirm() {
        try { return typeof showCustomConfirm === 'function' ? showCustomConfirm : null; } catch (e) { return null; }
    },

    /**
     * 语音（TTS）能力：插件想"念一段话"时走这里，而不是自己去调 speakText。
     *
     * 为什么收进 host（D14 的同一条理由）：`speakText` / `stopActiveVoicePlayback`
     *   是宿主的内部实现，插件直接引用它们，宿主一改名插件就在运行时报错。
     *   而且"用哪个 TTS 供应商、有没有配 Key、要不要日语朗读稿"这些都在宿主设置里，
     *   插件不该知道，也不该复制一份。
     *
     * 返回的 `speak` 与宿主自己的"播放这条消息的语音"是**同一条链路**：
     *   会停掉正在播的、会走缓存、`onEnd` 在播完/被取消时都会调（宿主据此收嘴型）。
     */
    get speech() {
        try {
            if (typeof speakText !== 'function') return null;
            return {
                /** 有没有可用的 TTS（供应商 + Key 都齐了）。没有时插件应降级成只显示文字 */
                get configured() {
                    try { return typeof isTtsConfigured === 'function' ? !!isTtsConfigured(state.settings) : false; }
                    catch (e) { return false; }
                },
                /**
                 * 念一段文本。
                 * @param {string} text
                 * @param {{onStart?:Function,onEnd?:Function,messageId?:string}} [opts]
                 * @returns {Promise<{cancelled?:boolean,empty?:boolean}|undefined>}
                 */
                speak(text, opts) {
                    const o = opts || {};
                    const t = String(text == null ? '' : text).trim();
                    if (!t) { if (o.onEnd) o.onEnd(); return Promise.resolve({ empty: true }); }
                    const id = o.messageId || ('mod-speech-' + Date.now());
                    // 与消息语音共用同一套"同一时间只播一条"的机制
                    return startVoicePlaybackOnce(id, t, o.onStart || (() => {}), {
                        onEnd: () => { if (o.onEnd) o.onEnd(); },
                    });
                },
                /** 停掉正在播的语音（插件关界面时用） */
                stop() {
                    try {
                        if (typeof stopActiveVoicePlayback === 'function') return stopActiveVoicePlayback(true);
                    } catch (e) { /* 停不下来不该阻塞关闭 */ }
                    return Promise.resolve();
                },
            };
        } catch (e) { return null; }
    },

    /**
     * 语音输入（ASR）：插件想要"按一下说话"时走这里，而不是自己去点宿主那颗麦克风按钮。
     *
     * 为什么收进 host（与 speech 同一条理由）：ASR 的"用哪家、有没有配 Key、
     *   录完整段再传还是浏览器实时识别"全在宿主设置里，而且是**流式状态机**
     *   （voiceState: idle → listening → paused → thinking）。插件自己去摸麦克风
     *   等于把状态机复制一份，两条链路同时开麦就会抢设备。
     *
     * `start` / `stop` 就是主界面那颗麦克风按钮做的事：真的开麦、真的识别、
     *   识别完**直接发出去**（与主输入框同一条链路：记忆、续跑、TTS 都照常）。
     * 没有配置 ASR 时 `configured` 为 false —— 插件据此不给入口，
     *   而不是让用户点一下、弹一句"未配置"。
     */
    get dictation() {
        try {
            if (typeof handleMicClick !== 'function') return null;
            const st = () => { try { return (typeof state === 'undefined' ? '' : String(state.voiceState || 'idle')); } catch (e) { return 'idle'; } };
            return {
                /** 是否配置了可用的识别服务（浏览器内置识别不算：它在国内基本不可用） */
                get configured() {
                    try { return typeof canUseCloudFinalAsr === 'function' && !!canUseCloudFinalAsr(); }
                    catch (e) { return false; }
                },
                /** 当前状态：idle / listening / paused / thinking / error */
                get state() { return st(); },
                /** 开麦 / 结束并发送（与主界面麦克风按钮同一个动作） */
                toggle() { try { handleMicClick(); return true; } catch (e) { return false; } },
                start() {
                    try {
                        if (st() === 'idle') { handleMicClick(); return true; }
                        return false;      // 已经在听：不重复开麦
                    } catch (e) { return false; }
                },
                stop() {
                    try {
                        if (st() !== 'idle') { handleMicClick(); return true; }
                        return false;
                    } catch (e) { return false; }
                },
            };
        } catch (e) { return null; }
    },

    /**
     * 主题模板注册表（插件主题走 host.theme，宿主侧实现在 theme.js）。
     * 缺省为 null 表示当前宿主没有主题系统，插件据此降级。
     */
    get theme() {
        try { return window.ElainaTheme || null; } catch (e) { return null; }
    },
    /** 成就系统的上报入口（插件只当触发器） */
    get achievements() {
        try { return window.ElainaAchievements || null; } catch (e) { return null; }
    },
};

