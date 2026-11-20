// 手机操作：[操作:手机xxx] 的授权与执行链，以及原生设备桥的对接（细节函数在运行时才调用）。
'use strict';

// 原生设备层由 Capacitor 注入（Plugins.ElainaDevice），这里只挂 window.ElainaDevice 别名供执行层取用；网页版上为空，执行时提示「设备能力还没接入」。
function deviceBridge() {
    if (window.ElainaDevice) return window.ElainaDevice;
    const nativePlugin = window.Capacitor?.Plugins?.ElainaDevice;
    if (nativePlugin) {
        window.ElainaDevice = nativePlugin;
        return nativePlugin;
    }
    return null;
}
void deviceBridge();


let phoneOpsInFlight = 0;
let phoneRunEndTimer = null;
let overlayHideTimer = null;

/** 判据只看 agentPipelineBusy()：一步任务里隔着数秒模型调用，逐批 hide/show 会让浮层一直闪。 */
let agentContinueBusy = false;
function agentPipelineBusy() {
    return Boolean(agentContinueTimer) || agentContinueBusy || phoneOpsInFlight > 0;
}

function scheduleOverlayHide(delay = 1200) {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = setTimeout(() => {
        overlayHideTimer = null;
        if (agentPipelineBusy()) return;   // 还在忙：不收（模型还在想 / 下一步马上来）
        const rt = window.agentRuntime;
        if (rt && rt.hideOverlay) rt.hideOverlay();
    }, delay);
}

// 前台 = 无障碍（能看见、随时能停），后台 = Shizuku / Root / 模块（独立副屏静默操作）；多条路都可用时本轮第一次「动屏」问一次，取消 = 这一步不做，绝不替用户选。
let runModeDecision = '';   // '' = 本轮还没问过 | AGENT_BACKENDS 里的 id | 'cancelled'
// 用户显式选的运行方式：原生必须严格照办，不许自动换路。
let runModeExplicit = false;
let runModePicker = null;   // 进行中的询问 Promise（记忆化，见 pickPhoneRunMode）

function phoneActionNeedsScreen(action) {
    return ['手机查看界面', '手机截图', '手机点击', '手机滑动', '手机输入',
        '手机按键', '手机打开', '手机命令'].includes(action);
}

/** 本轮选定的 id 是否是一个真实存在的后端（runModeDecision 也可能是 'cancelled'）。 */
function isKnownBackendId(id) {
    return AGENT_BACKENDS.some((b) => b.id === id);
}

/** 就绪的后台端点；第二层选择列表用它，顺序跟 AGENT_BACKENDS 一致。 */
function readyBackgroundChoices() {
    return AGENT_BACKENDS.filter((b) => b.kind === 'background' && backendIsReady(b.id));
}

/** 后台端点一个都不就绪时，把每个候选的现状拼成一段可执行的说明（不是笼统的「不可用」）。 */
function backgroundUnavailableText() {
    const lines = AGENT_BACKENDS
        .filter((b) => b.kind === 'background')
        .map((b) => {
            const st = backendStatus[b.id];
            const why = (st && st.text) ? st.text : '未检测到';
            return '· ' + b.name + '：' + why;
        });
    return lines.join('\n');
}

/** 本轮第一次「动屏」时问运行方式；返回后端 id / 'none'（一条路都没有）/ ''（用户取消）。 */
async function pickPhoneRunMode() {
    // 同一条回复里可能有两个「动屏」操作；showCustomModal 是单例，并发问会覆盖按钮、首个 Promise 永不 resolve，故必须记忆化。
    if (runModePicker) return runModePicker;
    runModePicker = doPickPhoneRunMode().finally(() => { runModePicker = null; });
    return runModePicker;
}

async function doPickPhoneRunMode() {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
    // 两步不能省：backendStatus（设置页与上面的判据都读它）只有 detectBackend 会写，只调 fetchDeviceStatus 会读到旧值。
    await fetchDeviceStatus(true);
    await Promise.all(AGENT_BACKENDS.map(async (b) => {
        backendStatus[b.id] = await detectBackend(b.id);
    }));
    const foregroundReady = AGENT_BACKENDS.find((b) => b.kind === 'foreground' && backendIsReady(b.id));
    const backgrounds = readyBackgroundChoices();
    // 只有一条路：直接用它，不弹窗（弹窗只在真的需要用户选的时候出现）。
    if (!foregroundReady && !backgrounds.length) return 'none';
    if (!foregroundReady && backgrounds.length === 1) return backgrounds[0].id;
    if (foregroundReady && !backgrounds.length) return foregroundReady.id;
    runModeExplicit = true;
    const chosen = await showCustomModal({
        title: '选择运行方式',
        message: 'AI 要操作这台手机，两种运行方式都可用：\n\n'
            + '· 前台运行（无障碍）—— 在你正在用的屏幕上操作。\n'
            + '  你能看见 AI 点在哪儿、随时点悬浮窗上的「停止」；\n'
            + '  代价是它占着屏幕，这期间你没法用手机做别的事。\n\n'
            + '· 后台运行（' + backgrounds.map((b) => b.name).join(' / ') + '）—— 在独立副屏上操作，\n'
            + '  不抢你的屏幕，你可以继续用手机；代价是看不到它点了什么（仍可点「停止」）。\n\n'
            + '（本次任务只问这一次。默认方式可在「设置 → 能力 → 手机操作」里改。）',
        confirmText: '前台运行',
        altText: '后台运行',
        altValue: 'background',
        cancelText: '取消',
    }).catch(() => false);
    if (chosen === true) return foregroundReady.id;
    if (chosen !== 'background') return '';
    // 后台有多个候选：第二层只列**就绪**的那些，其余写在提示里 —— 列表里混入不可用项会让用户选到一条走不通的路。
    if (backgrounds.length === 1) return backgrounds[0].id;
    const picked = await showCustomModal({
        title: '选择后台方式',
        message: '这台设备有多条后台路径可用，选一条：\n\n'
            + backgrounds.map((b) => '· ' + b.name + '：' + ((backendStatus[b.id] && backendStatus[b.id].text) || '已就绪')).join('\n'),
        options: backgrounds.map((b) => ({
            value: b.id,
            label: b.name,
            hint: (backendStatus[b.id] && backendStatus[b.id].text) || '已就绪'
        })),
        cancelText: '取消',
    }).catch(() => '');
    return isKnownBackendId(picked) ? picked : '';
}
// 最近一次操作实际用的后端（原生回报）：只有模块后端有实时副屏画面，状态条的「看画面」按钮据此显隐。
let lastUsedBackendId = '';
let overlayPromptDeclined = false;


let lastPhoneExecOk = true;

async function execPhoneOperation(parsed) {
    const dev = deviceBridge();
    if (!dev || typeof dev.exec !== 'function') {
        throw new Error('设备能力还没接入：这个版本里没有手机操作的原生插件，这一步没有真正执行。'
            + '（网页版就是这样，请用带原生设备层的 APK）');
    }
    // 截图和控件树并行取：截图本身一两百毫秒，再串行 dump 一次等于白等一轮。
    const dumpPromise = parsed.action === '手机截图' ? callDeviceQuietly('手机查看界面', '') : null;
    const res = await dev.exec({
        action: parsed.action,
        args: phoneArgsForNative(parsed),
        // 本轮选定的运行方式优先，没选过才回落默认；它不可用时明确报错，不偷偷换路。
        backend: isKnownBackendId(runModeDecision)
            ? runModeDecision
            : currentBackendId(),
        strictBackend: runModeExplicit
    });
    lastPhoneExecOk = !(res && res.ok === false);
    let text = (res && (res.text || res.message)) || (parsed.action + ' 完成');
    if (res && res.backend) {
        lastUsedBackendId = String(res.backend);
        window.__lastAgentBackend = lastUsedBackendId;
    }
    // 截图原生以 base64 带回来，转述后回灌主模型 —— 与「图片理解」复用同一条链路。
    if (res && res.imageBase64 && parsed.action === '手机截图') {
        const dump = dumpPromise ? await dumpPromise : null;
        text = await describePhoneScreenshot(res, text, dump);
    }
    return text;
}

/** 文件类操作加路径前缀（裸相对 → 工作区，saf: → 授权文件夹）；已知取舍：授权文件夹后 AI 就没法再往工作区写。 */
function phoneArgsForNative(parsed) {
    const raw = String(parsed.args == null ? '' : parsed.args);
    if (!PHONE_FILE_OPS.includes(parsed.action)) return raw;
    const hasFolder = Boolean(String(state.settings.agentFolderUri || '').trim());
    if (!hasFolder) return raw;
    if (parsed.action === '手机写文件') {
        const sep = raw.indexOf('|');
        if (sep < 0) return raw;
        const path = raw.slice(0, sep).trim();
        const content = raw.slice(sep + 1);
        if (!path) return raw;
        return 'saf:' + path + '|' + content;
    }
    const path = raw.trim();
    if (!path) return raw;
    return 'saf:' + path;
}

const PHONE_FILE_OPS = ['手机列出文件', '手机读文件', '手机写文件', '手机删除文件'];

// 上一次截图的屏幕尺寸（物理像素），给点击 / 滑动做越界校验：越界坐标只会失败或点空，模型却当成「完成」。
let lastScreenSize = null;

// 待交给主模型的截图（一次性）：下一次请求用掉后清空，超过 60 秒不用就作废，免得串到别的对话。
let pendingAgentImageDataUrl = '';
let pendingAgentImageAt = 0;
function setPendingAgentImage(dataUrl) {
    pendingAgentImageDataUrl = String(dataUrl || '');
    pendingAgentImageAt = Date.now();
}
function takePendingAgentImage() {
    if (!pendingAgentImageDataUrl) return '';
    if (Date.now() - pendingAgentImageAt > 60000) { pendingAgentImageDataUrl = ''; return ''; }
    const out = pendingAgentImageDataUrl;
    pendingAgentImageDataUrl = '';
    return out;
}

function phoneVisionModelConfigured() {
    // 视觉配置可能来自选中的对话模型提供商；providers.js 未加载时退回旧字段判定。
    if (typeof visionConfigured === 'function') return visionConfigured();
    return state.settings.visionEnabled === true
        && Boolean(String(state.settings.visionBaseUrl || '').trim() && String(state.settings.visionModel || '').trim());
}

/** 没配视觉模型时顺手截一张图交给主模型（失败不影响读界面这个主流程）。 */
async function maybeStashScreenImage() {
    try {
        const res = await callDeviceQuietly('手机截图', '');
        if (!res || !res.imageBase64) return;
        if (res.screenWidth && res.screenHeight) {
            lastScreenSize = { width: Number(res.screenWidth), height: Number(res.screenHeight) };
        }
        setPendingAgentImage('data:' + (res.imageMime || 'image/jpeg') + ';base64,' + res.imageBase64);
    } catch (err) {
        console.warn('[Agent] 读界面时附带截图失败:', err);
    }
}

/**
 * 把一次手机操作记进运行日志（显示在「设置 → 日志」的 Agent 段）。
 *
 * <p>手机操作走 Capacitor 原生桥，不经过本机 Go 服务，所以服务端的 relay/trace 完全看不到
 * AI 动过设备。没有这一行时，用户报"AI 读不到应用列表"只能靠猜 —— 日志里既没有请求也没有结果。
 *
 * <p>只记动作名与结果摘要（截断），不记完整截图或长文本：日志页要能一眼看出"做了什么、成了没有"，
 * 而不是把整个 UI 树倒进去。读界面这类动作的结果可能有几 KB，截到 300 字。
 */
function logPhoneOperation(parsed, result) {
    try {
        const summary = String(result == null ? '' : result).replace(/\s+/g, ' ').slice(0, 300);
        console.info('[Agent] 手机操作 ' + parsed.action
            + (parsed.args ? ' ' + String(parsed.args).slice(0, 120) : '')
            + ' → ' + (summary || '(无结果)'));
    } catch (e) { /* 日志失败绝不影响操作本身 */ }
}

/** 直调原生设备层，不经权限 / 运行方式 / 过程记录 —— 只给「读界面」这类内部辅助用。 */
async function callDeviceQuietly(action, args) {    const dev = deviceBridge();
    if (!dev || typeof dev.exec !== 'function') return null;
    try {
        return await dev.exec({
            action,
            args: args == null ? '' : String(args),
            backend: isKnownBackendId(runModeDecision) ? runModeDecision : currentBackendId(),
            // 观测必须跟着本轮实际选择的后端走：前台任务里用副屏的界面做前后对比，结论会完全错位。
            strictBackend: Boolean(runModeExplicit)
        });
    } catch (err) {
        console.warn('[Agent] 辅助设备调用失败:', action, err);
        return null;
    }
}

// 应用名 → 包名
// 「手机打开」的底层只认包名，而用户和模型说的都是应用名（「哔哩哔哩」）。
// 让模型从应用列表里自己挑一行、或凭记忆写包名，写错就会打开**别的**应用
// （真机反馈：让它打开哔哩哔哩，前台却变成了另一个 App）。
// 所以这里按系统给的应用列表解析：精确匹配优先、包含匹配其次；
// 命中多个就列候选让模型指定，**绝不猜一个最近的**。
const PHONE_APP_LIST_TTL_MS = 5 * 60 * 1000;
let phoneAppListCache = null;   // { at, entries: [{ label, pkg }] }

function parsePhoneAppListText(text) {
    const entries = [];
    for (const line of String(text || '').split('\n')) {
        // 原生格式：应用名 | 包名
        const m = line.match(/^\s*(.+?)\s*\|\s*([A-Za-z0-9_.]+)\s*$/);
        if (m) entries.push({ label: m[1].trim(), pkg: m[2].trim() });
    }
    return entries;
}

async function phoneAppEntries(force) {
    if (!force && phoneAppListCache && Date.now() - phoneAppListCache.at < PHONE_APP_LIST_TTL_MS) {
        return phoneAppListCache.entries;
    }
    const res = await callDeviceQuietly('手机应用列表', '');
    const entries = parsePhoneAppListText((res && (res.text || res.message)) || '');
    if (entries.length) phoneAppListCache = { at: Date.now(), entries };
    return entries;
}

function normalizeAppQuery(text) {
    return String(text || '').toLowerCase().replace(/[\s「」『』（）()]/g, '');
}

/** 形如 com.tencent.mm 或 com.tencent.mm/.MainActivity —— 已经是包名，别再按应用名解析。 */
function looksLikePhonePackage(text) {
    return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+(\/[\w$.]+)?$/.test(String(text || '').trim());
}

function matchPhoneAppEntries(entries, query) {
    const q = normalizeAppQuery(query);
    if (!q) return [];
    const exact = entries.filter((e) => normalizeAppQuery(e.label) === q);
    if (exact.length) return exact;
    return entries.filter((e) => {
        const label = normalizeAppQuery(e.label);
        return label.includes(q) || q.includes(label);
    });
}

/** 解析「手机打开」的目标：返回 { pkg } 或 { error }（error 文本会原样回灌给模型）。 */
async function resolvePhoneOpenTarget(raw) {
    const text = String(raw || '').trim();
    if (!text) {
        return { error: '「手机打开」需要应用名或包名，例如「手机打开 哔哩哔哩」或「手机打开 tv.danmaku.bili」。' };
    }
    if (looksLikePhonePackage(text)) return { pkg: text };

    let entries = await phoneAppEntries(false);
    let hits = matchPhoneAppEntries(entries, text);
    if (!hits.length) {
        // 缓存可能比新装的应用旧：强制刷新一次再判，避免"刚装的找不到"。
        entries = await phoneAppEntries(true);
        hits = matchPhoneAppEntries(entries, text);
    }
    if (hits.length === 1) return { pkg: hits[0].pkg, label: hits[0].label };
    if (hits.length > 1) {
        return { error: '「' + text + '」对应多个已安装应用：'
            + hits.slice(0, 8).map((e) => e.label + '（' + e.pkg + '）').join('、')
            + (hits.length > 8 ? ' 等' : '')
            + '。请用包名指定要打开哪一个，例如 [操作:手机打开 ' + hits[0].pkg + ']。' };
    }
    return { error: '没找到名为「' + text + '」的应用。先用 [操作:手机应用列表] 看看它的准确名称，或直接写包名。' };
}

/** 启动后核对前台应用：只在**操作物理屏**的后端上有效（无障碍；Root / Shizuku 跑在虚拟副屏上，物理屏前台本来就不是它）。
 *  返回空串 = 前台就是目标；否则返回一句必须让模型看到的告警。 */
function backendOperatesPhysicalScreen(id) {
    return backendKindOf(id) === 'foreground';
}
function isPhoneTransientForeground(fg) {
    const pkg = String((fg && fg.pkg) || '').toLowerCase();
    const label = String((fg && fg.label) || '');
    // 还停在本应用：目标应用还没拉起来（冷启动的游戏常见几秒）。
    if (/elainachat/i.test(pkg) || /elainachat/i.test(label)) return true;
    // 桌面 / 系统界面：应用启动过程中会短暂出现，不能当成"打开了别的应用"。
    if (/launcher|systemui/.test(pkg) || pkg === 'android') return true;
    return false;
}

async function verifyPhoneOpenTarget(expectedPkg) {
    const want = String(expectedPkg || '').split('/')[0].trim();
    if (!want) return '';
    let last = null;
    // 目标应用出现就立刻返回；前台已经是"另一个真实应用"也立刻判失败；
    // 只有本应用 / 桌面这种过渡态才继续等（冷启动的游戏可能要好几秒）。
    for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, i < 3 ? 600 : 1000));
        const info = await callDeviceQuietly('手机设备信息', '');
        const text = (info && (info.text || info.message)) || '';
        const m = text.match(/前台应用：(.+?)（([A-Za-z0-9_.]+)）/);
        if (!m) return '';        // 读不到前台（没开无障碍）就别猜，免得误报
        last = { label: m[1].trim(), pkg: m[2].trim() };
        if (last.pkg === want) return '';
        if (!isPhoneTransientForeground(last)) break;
    }
    if (!last) return '';
    if (isPhoneTransientForeground(last)) {
        return '⚠️ 启动后前台仍停在「' + last.label + '」（' + last.pkg + '），没看到 ' + want
            + ' 起来。可能还在冷启动或启动被系统拦了 —— 不要当成已打开，先 [操作:手机设备信息] 看看，再决定下一步。';
    }
    return '⚠️ 启动后前台应用是「' + last.label + '」（' + last.pkg + '），不是你要打开的 ' + want
        + '。可能应用没起来、或被别的应用抢了前台 —— 不要当成已打开，先 [操作:手机设备信息] 看看，再决定下一步。';
}

// 控件树一行形如：
//   #3 “发送” id=btn_send cls=Button 可点 bounds=440,1160,640,1240 parent=“张三” [540,1200]
// 只取可点 / 可输入的行；bounds / 状态 / 父容器用于引用点击和同名控件区分。
const UI_NODE_LINE = /^#(\d+)\s+(.*?)\s*\[(-?\d+),(-?\d+)\]\s*$/;
function parseUiNodes(dumpText) {
    const out = [];
    for (const line of String(dumpText || '').split('\n')) {
        const m = UI_NODE_LINE.exec(line.trim());
        if (!m) continue;
        const body = m[2];
        if (!body.includes('可点') && !body.includes('可输入')) continue;
        let label = '';
        const q = body.match(/“([^”]*)”/);
        if (q) label = q[1];
        else {
            const d = body.match(/\[描述\]“([^”]*)”/);
            if (d) label = d[1];
        }
        const idm = body.match(/id=([^\s]+)/);
        const clsm = body.match(/cls=([^\s]+)/);
        const parentm = body.match(/parent=“([^”]*)”/);
        const boundsm = body.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);
        const x = Number(m[3]);
        const y = Number(m[4]);
        const bounds = boundsm
            ? { left: Number(boundsm[1]), top: Number(boundsm[2]), right: Number(boundsm[3]), bottom: Number(boundsm[4]) }
            : { left: x - 22, top: y - 22, right: x + 22, bottom: y + 22 };
        out.push({
            ref: out.length + 1,
            index: Number(m[1]),
            label: label || (idm ? idm[1] : ''),
            id: idm ? idm[1] : '',
            className: clsm ? clsm[1] : '',
            parent: parentm ? parentm[1] : '',
            x,
            y,
            bounds,
            clickable: body.includes('可点'),
            scrollable: body.includes('可滑'),
            editable: body.includes('可输入'),
            checked: body.includes('已选') ? true : (body.includes('未选') ? false : null),
            enabled: !body.includes('禁用'),
            focused: body.includes('有焦点'),
        });
    }
    return out;
}

function phoneNodeState(n) {
    return [n.checked === null ? '-' : (n.checked ? '1' : '0'),
        n.enabled ? '1' : '0',
        n.focused ? '1' : '0'].join('');
}

function phoneNodeDisp(n) {
    const flags = [];
    if (n.scrollable) flags.push('可滑');
    if (n.checked !== null) flags.push(n.checked ? '已选' : '未选');
    if (!n.enabled) flags.push('禁用');
    if (n.focused) flags.push('有焦点');
    return (n.label || n.id || '控件')
        + (n.id ? ' id=' + n.id : '')
        + (flags.length ? ' [' + flags.join('/') + ']' : '')
        + (n.parent ? ' [在：' + n.parent + ']' : '');
}

function formatNodeListForModel(nodes) {
    const limit = Math.min(nodes.length, 60);
    const lines = [];
    for (let i = 0; i < limit; i++) {
        const n = nodes[i];
        lines.push('#' + n.ref + ' ' + phoneNodeDisp(n) + ' (' + n.x + ',' + n.y + ')');
    }
    if (nodes.length > limit) {
        lines.push('…还有 ' + (nodes.length - limit) + ' 个没列出；发送 [操作:手机查看界面] 分页查看。');
    }
    return lines.join('\n');
}

/** 从原生 dump 头部取“控件覆盖 / 文字数 / 画布提示”判断页面类型。 */
function parseUiMeta(dumpText) {
    // 「概况」与「控件覆盖」之间还有前台应用与屏幕尺寸；按固定顺序匹配会让原生概况行整行取不到。
    const m = String(dumpText || '').match(/# 概况[^\n]*?控件覆盖=(\d+)% 文字=(\d+) 可滑=(\d+)(?: 画布提示=([^\n]+))?/);
    if (!m) return null;
    return {
        coverage: Number(m[1]) / 100,
        textCount: Number(m[2]),
        scrollableCount: Number(m[3]),
        surfaceHints: m[4] ? m[4].split(',').map((v) => v.trim()).filter(Boolean) : [],
    };
}

/** 原始控件树又长又像代码，模型会照抄进回复；解析不到可点元素时原样返回，不让模型看不到界面。 */
function summarizeUiDumpForModel(dumpText, page = 1) {
    const text = String(dumpText || '');
    const nodes = parseUiNodes(text);
    if (!nodes.length) return text;
    const pageSize = 40;
    const pageNo = Math.max(1, Number(page) || 1);
    const start = (pageNo - 1) * pageSize;
    const slice = nodes.slice(start, start + pageSize);
    const meta = phoneDumpMeta(text);
    const out = [];
    // 第一行就是"我现在在哪个应用"：这是执行者最常查的一条，放在这里它就不必再单独查设备信息
    if (meta.foreground) out.push('当前应用：' + meta.foreground.label + '（' + meta.foreground.pkg + '）—— 不必再查「手机设备信息」确认');
    out.push('当前界面可操作元素（#编号可直接写 [操作:手机点击 #N]；括号里是屏幕坐标）：');
    for (const n of slice) {
        out.push('#' + n.ref + ' ' + phoneNodeDisp(n) + ' (' + n.x + ',' + n.y + ')');
    }
    const remaining = Math.max(0, nodes.length - (start + slice.length));
    if (remaining > 0) {
        out.push('…还有 ' + remaining + ' 个；发送 [操作:手机查看界面 ' + (pageNo + 1) + '] 看下一页。');
    }
    const profile = typeof screenProfile === 'function'
        ? screenProfile({ text, nodes, stable: true }, lastScreenSize)
        : null;
    if (profile) {
        const coverage = Math.round(profile.coverage * 100);
        const uncovered = profile.uncovered
            ? '；最大无控件区域 ' + profile.uncovered.w + '×' + profile.uncovered.h
                + '（' + profile.uncovered.x + ',' + profile.uncovered.y + '）'
            : '';
        out.push('屏幕概况：控件覆盖约 ' + coverage + '%' + uncovered
            + (profile.surfaceHints.length ? '；画布提示：' + profile.surfaceHints.join(',') : ''));
        if (profile.needsPixels) {
            out.push('目标在可读控件上时直接用 #编号 / id；落在无控件 / 混合区域时，'
                + '再用 [操作:手机截图] 看画面并按网格读坐标。');
        }
    }
    return out.join('\n');
}

/** 编号圆点给视觉模型看（它不擅长估像素坐标），编号→坐标由控件树精确给出；失败返回 null，调用方退化成纯文字。 */
function annotateScreenshot(dataUrl, nodes) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const sw = (lastScreenSize && lastScreenSize.width) || canvas.width;
                const sh = (lastScreenSize && lastScreenSize.height) || canvas.height;
                const sx = canvas.width / Math.max(1, sw);
                const sy = canvas.height / Math.max(1, sh);
                const r = Math.max(10, Math.round(Math.min(canvas.width, canvas.height) * 0.018));
                ctx.font = 'bold ' + Math.round(r * 1.25) + 'px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const limit = Math.min(nodes.length, 60);
                for (let i = 0; i < limit; i++) {
                    const n = nodes[i];
                    const px = n.x * sx;
                    const py = n.y * sy;
                    if (!isFinite(px) || !isFinite(py)) continue;
                    ctx.beginPath();
                    ctx.arc(px, py, r, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(220,38,38,0.85)';
                    ctx.fill();
                    ctx.lineWidth = Math.max(1, Math.round(r * 0.12));
                    ctx.strokeStyle = '#ffffff';
                    ctx.stroke();
                    ctx.fillStyle = '#ffffff';
                    ctx.fillText(String(i + 1), px, py + 1);
                }
                resolve(canvas.toDataURL('image/jpeg', 0.8));
            } catch (err) {
                console.warn('[Agent] 截图标注失败:', err);
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}

/** 给截图叠一层坐标网格（每 100px 一条，边上标数值，画在原分辨率上 —— 模型照标签读出的就是屏幕坐标）。
 * 棋盘 / 游戏这类画面没有控件树，视觉模型只能凭空估像素，实测偏差能有几十像素、滑到格子间的空隙上；
 * 有标尺可读时它把目标对到格心，误差能压进半格。失败返回 null，调用方退回原图。 */
function annotateGrid(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const w = img.naturalWidth || img.width;
                const h = img.naturalHeight || img.height;
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                // 网格标签必须标**真实屏幕坐标**：图可能被原生缩过（长边收进 1024），
                // 这时图片像素 ≠ 屏幕像素，标图片坐标会让模型点歪。
                const screenW = (lastScreenSize && lastScreenSize.width) || w;
                const screenH = (lastScreenSize && lastScreenSize.height) || h;
                const ratioX = w / Math.max(1, screenW);
                const ratioY = h / Math.max(1, screenH);
                // 真实坐标每 50px 一条线。为什么是 50：实测棋盘格子只有约 88-90px 宽（半格 44px），
                // 而模型照网格读数的最坏误差是半个格距 —— 100px 网格意味着最坏偏 50px，已经超过半格，
                // 必然点到隔壁格子上（表现为"一直滑无效配对、步数不减少"）。50px 网格把最坏误差压到 25px，
                // 稳稳落在同一格内。线多一倍但都是细线，不影响辨认。
                const stepScreen = 50;
                const stepX = Math.max(6, stepScreen * ratioX);
                const stepY = Math.max(6, stepScreen * ratioY);
                ctx.lineWidth = 1;
                ctx.strokeStyle = 'rgba(255,255,255,0.42)';
                ctx.fillStyle = 'rgba(220,38,38,0.9)';
                ctx.font = 'bold 20px monospace';
                for (let sx = stepScreen; sx <= screenW; sx += stepScreen) {
                    const x = sx * ratioX;
                    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
                    // 每 100px 标一次数字（每 50 标会糊成一片），线条仍按 50 画
                    if (sx % 100 === 0) ctx.fillText(String(sx), x + 3, 22);
                }
                for (let sy = stepScreen; sy <= screenH; sy += stepScreen) {
                    const y = sy * ratioY;
                    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
                    if (sy % 100 === 0) ctx.fillText(String(sy), 4, y - 4);
                }
                resolve(canvas.toDataURL('image/jpeg', 0.85));
            } catch (err) {
                console.warn('[Agent] 坐标网格绘制失败:', err);
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}

/** 截图标注后再缩到长边 1120：网格标签是屏幕坐标，缩小不改变读数，但能显著减少上行字节。 */
function downscaleDataUrl(dataUrl, maxSide = 1120) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const w = img.naturalWidth || img.width;
                const h = img.naturalHeight || img.height;
                const scale = Math.min(1, maxSide / Math.max(1, Math.max(w, h)));
                if (scale >= 0.999) return resolve(dataUrl);
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(w * scale));
                canvas.height = Math.max(1, Math.round(h * scale));
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.82));
            } catch (err) {
                resolve(dataUrl);
            }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

/** 截图交给模型看，另给一份可点元素清单；坐标永远来自控件树，不从图片上估像素。 */
async function describePhoneScreenshot(res, fallbackText, knownDumpText) {
    const dataUrl = 'data:' + (res.imageMime || 'image/jpeg') + ';base64,' + res.imageBase64;
    if (res.screenWidth && res.screenHeight) {
        lastScreenSize = { width: Number(res.screenWidth), height: Number(res.screenHeight) };
    }

    let dumpText = typeof knownDumpText === 'string'
        ? knownDumpText
        : String((knownDumpText && (knownDumpText.text || knownDumpText.message)) || '');
    if (!dumpText) {
        try {
            const dump = await callDeviceQuietly('手机查看界面', '');
            dumpText = (dump && (dump.text || dump.message)) || '';
        } catch (err) {
            console.warn('[Agent] 截图前读取控件树失败:', err);
        }
    }
    const nodes = parseUiNodes(dumpText);
    if (dumpText) {
        currentScreenObservation = {
            at: Date.now(), text: dumpText, nodes, stable: true,
            signature: phoneUiSignature(nodes),
        };
    }
    const profile = screenProfile({ text: dumpText, nodes, stable: true }, lastScreenSize);
    // 控件覆盖低 / 原生报告 SurfaceView 才需要“照网格读坐标”；页面类型由 dump 头部指标判断。
    const canvasTendency = profile.needsPixels;
    const nodeList = formatNodeListForModel(nodes);
    const profileBlock = '\n\n【屏幕概况】控件覆盖约 ' + Math.round(profile.coverage * 100) + '%'
        + (profile.uncovered
            ? '；最大无控件区域 ' + profile.uncovered.w + '×' + profile.uncovered.h
                + '（' + profile.uncovered.x + ',' + profile.uncovered.y + '）'
            : '')
        + (profile.surfaceHints.length ? '；画布提示：' + profile.surfaceHints.join(',') : '')
        + (profile.stable ? '' : '；界面持续变化');
    const listBlock = (nodeList || profileBlock)
        ? '\n\n【可点元素（#编号 → 控件 / 坐标）】\n' + (nodeList || '（没有可读控件）') + profileBlock
            + (canvasTendency
                ? '\n（这份清单可能不完整。清单里没有你要操作的目标时，'
                    + '就照截图的坐标网格读位置，再写 [操作:手机点击 x y] / [操作:手机滑动 x1 y1 x2 y2]。）'
                : '\n（要操作某个控件优先写 [操作:手机点击 #编号]；'
                    + '也可以用它后面的坐标写 [操作:手机点击 x y]，或按 id 用 [操作:手机按键 id:<id>]。不要把图片上的位置换算成像素。）')
        : '';

    const verdict = (typeof cachedModelImageVerdict === 'function') ? cachedModelImageVerdict() : null;
    const mainSupportsImage = verdict === true && !state._agentImageUnsupported;
    const hasVision = Boolean(
        typeof visionConfigured === 'function'
            ? visionConfigured()
            : state.settings.visionEnabled === true
                && String(state.settings.visionBaseUrl || '').trim() && String(state.settings.visionModel || '').trim()
    );
    const gridNote = canvasTendency
        ? '\n（截图上叠了白色坐标网格：每 50px 一条线，每 100px 标一次数值，标的是屏幕坐标。'
            + '画面里没有可点的控件清单时，就看图判断目标位置，按网格读出它的 x / y 坐标来点 —— 例如想把 (450,700) 的方块往左移，'
            + '就写 [操作:手机滑动 450 700 350 700]。坐标照网格标签读，不要自己换算。'
            + '⚠️ 这类棋盘 / 列表的每个格子通常只有 80-100px 宽，读坐标时要读到格子的**正中心**：'
            + '先看目标格左右两条线在哪，取它们的中点；差半个格就会点到隔壁。'
            + '滑动时起点和终点都要取格心，且只跨一格（约 90px）。）'
        : '';

    // 主模型本身多模态：直接把图附给它，省掉一次视觉模型调用；视觉模型只服务“主模型看不懂图”。
    if (mainSupportsImage || (!hasVision && verdict !== false && !state._agentImageUnsupported)) {
        const withGrid = canvasTendency ? ((await annotateGrid(dataUrl)) || dataUrl) : dataUrl;
        const picture = nodes.length ? ((await annotateScreenshot(withGrid, nodes)) || withGrid) : withGrid;
        const scaled = await downscaleDataUrl(picture, 1120);
        setPendingAgentImage(scaled);
        return fallbackText + gridNote
            + '\n（已把这张截图直接附给你，请直接看图判断；'
            + '如果收不到图片，说明当前主模型不支持图片，可改用界面清单或配置视觉模型。）' + listBlock;
    }
    if (!hasVision) {
        return fallbackText + '\n（已实测当前主模型不支持图片，看不到画面；先用下面的可点元素清单操作。）' + listBlock;
    }

    try {
        const withGrid = await annotateGrid(dataUrl);
        const base = withGrid || dataUrl;
        const picture = nodes.length ? ((await annotateScreenshot(base, nodes)) || base) : base;
        const prompt = '这是手机当前屏幕的截图。'
            + (nodes.length ? '图上用红色圆点标了可交互元素的编号（1、2、3…）。' : '')
            + '图上叠了白色坐标网格（每 50px 一条线、每 100px 标一次屏幕坐标数值）。'
            + '请回答：1) 这是什么应用、什么页面；'
            + '2) 屏幕上主要有哪些文字和按钮；'
            + '3) 有没有明显的输入框或弹窗。'
            + (canvasTendency
                ? '4) 这可能是游戏 / 棋盘这类靠图形互动的画面：列出主要图形元素的种类（颜色 / 形状）'
                    + '和各自的屏幕坐标（照网格标签读，精确到格心，最多列 40 个），'
                    + '然后给出你建议的下一步操作 —— 点击或滑动的起点与终点坐标，附一句理由。'
                    + '这一项要具体到坐标，其他项保持简短。'
                : '')
            + '只描述你真实看到的，不要编造。';
        const described = await describeImageWithVision(prompt, await downscaleDataUrl(picture, 1120));
        const visual = described && described.trim() ? described.trim() : '';
        if (!visual) return fallbackText + listBlock;
        return fallbackText + '\n\n【画面内容】\n' + visual + listBlock;
    } catch (err) {
        const reason = String(err?.message || err || '');
        console.error('[Agent] 手机截图转述失败:', err);
        return fallbackText + '\n（截图拿到了，但视觉模型没能看：' + reason.slice(0, 200) + '）' + listBlock;
    }
}

/** 只在知道屏幕尺寸时才判断；越界坐标提前拦下并让它重读界面，返回空串表示没问题。 */
function phoneCoordsOutOfScreen(parsed) {
    if (!lastScreenSize) return '';
    const nums = String(parsed.args == null ? '' : parsed.args).trim().split(/\s+/).map((v) => Number(v));
    const w = lastScreenSize.width;
    const h = lastScreenSize.height;
    const bad = (x, y) => !isFinite(x) || !isFinite(y) || x < 0 || y < 0 || x > w || y > h;
    if (parsed.action === '手机点击') {
        if (nums.length < 2 || !isFinite(nums[0]) || !isFinite(nums[1])) return '';
        if (bad(nums[0], nums[1])) {
            return '坐标 (' + nums[0] + ',' + nums[1] + ') 超出屏幕（' + w + '×' + h + '）。'
                + '请先 [操作:手机查看界面] 重读一次界面，再按最新坐标点击。';
        }
    } else if (parsed.action === '手机滑动') {
        if (nums.length < 4) return '';
        if (bad(nums[0], nums[1]) || bad(nums[2], nums[3])) {
            return '滑动坐标超出屏幕（' + w + '×' + h + '）。请先 [操作:手机查看界面] 重读一次界面，再按最新坐标滑动。';
        }
    }
    return '';
}

// 动作后的界面观测
// 原生回报的是“手势发出去了”，不是“界面变了”。点空白、点错行、应用还没加载完都会回报成功，
// 模型据此判断下一步就只能在原地打转。这里在动作前后各取一份界面快照做对比，把“有没有生效”
// 变成回灌里的明确事实；同一份快照也用来拦截无变化的重复动作。

let currentScreenObservation = null;   // { at, text, nodes, stable, stale, signature }
let lastPhoneActionOutcome = null;     // { key, changed, exempt }：下一步重复同一动作时据此拦截
const PHONE_SCREEN_ACTIONS = ['手机点击', '手机滑动', '手机输入', '手机按键', '手机打开'];
const PHONE_OBSERVATION_TTL_MS = 1500;
const PHONE_SUMMARY_ACTIONS = new Set(['手机点击', '手机滑动', '手机输入', '手机按键', '手机打开',
    '手机写文件', '手机删除文件']);

function phoneActionKey(parsed) {
    return parsed.action + '\u0000' + String(parsed.args == null ? '' : parsed.args);
}

function phoneUiSignature(nodes) {
    return nodes.map((n) => [n.label, n.id, n.className, n.x, n.y,
        phoneNodeState(n), n.parent].join('\u0001')).join('\u0002');
}

function countPhoneNodes(nodes) {
    const counts = new Map();
    for (const n of nodes) {
        const key = (n.label || '') + '\u0001' + (n.id || '') + '\u0001' + phoneNodeState(n);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
}

function phoneNodeLabel(key) {
    const parts = key.split('\u0001');
    return parts[0] || parts[1] || '控件';
}

/** 同一 label / id 的状态变化（开关、选中、禁用）单独说明，避免只报“新增 + 消失”成对出现。 */
function diffPhoneNodeStates(before, after) {
    const keyOf = (n) => (n.label || '') + '\u0001' + (n.id || '');
    const beforeMap = new Map();
    for (const n of before.nodes) {
        if (!beforeMap.has(keyOf(n))) beforeMap.set(keyOf(n), n);
    }
    const changes = [];
    for (const n of after.nodes) {
        const prev = beforeMap.get(keyOf(n));
        if (!prev) continue;
        const a = phoneNodeState(prev);
        const b = phoneNodeState(n);
        if (a === b) continue;
        const stateText = (v) => {
            const parts = [];
            if (v[0] !== '-') parts.push(v[0] === '1' ? '已选' : '未选');
            if (v[1] === '0') parts.push('禁用');
            if (v[2] === '1') parts.push('有焦点');
            return parts.join('/') || '状态变化';
        };
        changes.push((n.label || n.id || '控件') + '（' + stateText(a) + ' → ' + stateText(b) + '）');
    }
    return changes;
}

/** 快照差异看可点 / 可输入元素：文字、id、状态、坐标任一变化都算界面变了；纯动画位移不算。 */
function diffUiObservation(before, after) {
    if (!before || !after) return { changed: null, text: '' };
    if (before.signature === after.signature) {
        return { changed: false, text: '界面没有变化。' };
    }
    const beforeCounts = countPhoneNodes(before.nodes);
    const afterCounts = countPhoneNodes(after.nodes);
    const added = [];
    const removed = [];
    for (const [key, count] of afterCounts) {
        const prev = beforeCounts.get(key) || 0;
        if (count > prev) added.push(phoneNodeLabel(key) + (count - prev > 1 ? ' ×' + (count - prev) : ''));
    }
    for (const [key, count] of beforeCounts) {
        const next = afterCounts.get(key) || 0;
        if (count > next) removed.push(phoneNodeLabel(key) + (count - next > 1 ? ' ×' + (count - next) : ''));
    }
    const stateChanges = diffPhoneNodeStates(before, after);
    const lines = [];
    if (stateChanges.length) lines.push('状态变化：' + stateChanges.slice(0, 4).join('、'));
    if (added.length) lines.push('新增：' + added.slice(0, 6).join('、') + (added.length > 6 ? ' 等 ' + added.length + ' 项' : ''));
    if (removed.length) lines.push('消失：' + removed.slice(0, 6).join('、') + (removed.length > 6 ? ' 等 ' + removed.length + ' 项' : ''));
    if (!lines.length) lines.push('元素位置有变化。');
    return { changed: true, text: '界面已变化。\n· ' + lines.join('\n· ') };
}

async function readUiObservation() {
    const res = await callDeviceQuietly('手机查看界面', '');
    if (!res || res.ok === false) return null;
    const text = (res && (res.text || res.message)) || '';
    const nodes = parseUiNodes(text);
    const meta = phoneDumpMeta(text);
    // 概况行自带屏幕尺寸：有了它就不必为一次点击单独查一遍设备信息
    if (meta.screen && !(lastScreenSize && lastScreenSize.width > 0)) lastScreenSize = meta.screen;
    return {
        at: Date.now(), text, nodes, stable: true, signature: phoneUiSignature(nodes),
        foreground: meta.foreground,
    };
}

/**
 * 概况行（原生侧 dumpUiTree 输出）里的「前台应用」与「屏幕尺寸」。
 * 前台应用是执行者判断"我现在在哪"的唯一依据：能从这里读到，就不该再去查设备信息。
 */
function phoneDumpMeta(text) {
    const raw = String(text || '');
    const fg = raw.match(/前台=([^（\n]+?)（([A-Za-z0-9_.]+)）/);
    const size = raw.match(/屏幕=(\d{3,5})[x×](\d{3,5})/);
    return {
        foreground: fg ? { label: fg[1].trim(), pkg: fg[2].trim() } : null,
        screen: size ? { width: Number(size[1]), height: Number(size[2]) } : null,
    };
}

function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 无障碍事件流安静（服务端 150ms 无内容变化）才算稳；服务不在时退回固定间隔。 */
async function waitUiQuiet() {
    const res = await callDeviceQuietly('手机等待稳定', '');
    return Boolean(res && res.quiet);
}

/** 无障碍界面变化 → 观察快照主动失效；比纯 TTL 更快发现“屏幕自己变了”。 */
let a11yListenerReady = false;
function ensureA11yEventListener() {
    if (a11yListenerReady) return;
    const dev = deviceBridge();
    if (!dev || typeof dev.addListener !== 'function') return;
    a11yListenerReady = true;
    try {
        dev.addListener('a11yUiChanged', () => {
            if (currentScreenObservation) currentScreenObservation.stale = true;
        });
    } catch (err) {
        a11yListenerReady = false;   // 监听注册失败退回纯 TTL
    }
}

/**
 * 动作后等界面稳定，而不是固定睡 260ms：
 * 连续两次 dump 签名一致才算稳定；动画 / 视频 / 加载中一直不一致时返回 stable:false，
 * 后续 changed 只能判 unknown，不能拿“没稳定”当“没变化”。
 */
async function readStableObservation(seed, options = {}) {
    const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 140;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1000;
    const firstDelayMs = Number.isFinite(options.firstDelayMs) ? options.firstDelayMs : 120;
    let previous = seed || null;
    if (firstDelayMs > 0) {
        const quiet = await waitUiQuiet();
        if (!quiet) await sleepMs(firstDelayMs);
    }
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
        const current = await readUiObservation();
        if (!current) return { observation: previous, stable: false };
        if (previous && previous.signature === current.signature) {
            return { observation: current, stable: true };
        }
        previous = current;
        await sleepMs(pollMs);
    }
    return { observation: previous, stable: false };
}

async function observePhoneActionResult(parsed, before, plan) {
    const p = plan || planPhoneObservation(parsed, before);
    if (!p || p.mode === 'none') return null;
    const settled = await readStableObservation(before);
    const after = settled.observation;
    if (!after) {
        return { changed: null, stable: false, text: '读不到当前界面，无法判断这一步是否生效。' };
    }
    const uiDiff = settled.stable
        ? diffUiObservation(before, after)
        : { changed: null, stable: false, text: '画面持续变化，无法判断这一步是否生效。' };

    if (p.mode === 'region') {
        const afterRegion = await captureStableRegion(p.rect);
        if (!p.beforeImage || !afterRegion) {
            currentScreenObservation = { ...after, stable: false, stale: true };
            return { changed: null, stable: false, text: '没有动作前后可比的局部画面，无法判断这一步是否生效。' };
        }
        const cmp = await compareRegionImages(p.beforeImage.dataUrl, afterRegion.image.dataUrl);
        const stable = Boolean(afterRegion.stable && cmp);
        currentScreenObservation = { ...after, stable, stale: !stable };
        if (!stable) {
            return { changed: null, stable: false, text: '局部画面持续变化，无法判断这一步是否生效。' };
        }
        const where = p.rect ? '（区域 ' + p.rect.x + ',' + p.rect.y + ' ' + p.rect.w + '×' + p.rect.h + '）' : '';
        if (cmp.changed === true) {
            return { changed: true, stable: true, ratio: cmp.ratio, text: '画面已变化' + where + '。' };
        }
        if (cmp.changed === false) {
            return { changed: false, stable: true, ratio: cmp.ratio, text: '画面没有变化' + where + '。' };
        }
        return { changed: null, stable: true, ratio: cmp.ratio, text: '局部画面变化不明显，无法判断这一步是否生效。' };
    }

    currentScreenObservation = { ...after, stable: settled.stable, stale: !settled.stable };
    if (uiDiff.changed === true) return uiDiff;
    // 控件树说“没变”，但页面本身是画布 / 混合区域时，再用动作附近的局部像素二次确认。
    if (uiDiff.changed === false && p.secondCheck && p.beforeImage) {
        const afterRegion = await captureStableRegion(p.rect);
        if (afterRegion) {
            const cmp = await compareRegionImages(p.beforeImage.dataUrl, afterRegion.image.dataUrl);
            if (cmp && cmp.changed === true) {
                return { changed: true, stable: true, ratio: cmp.ratio, text: '控件树没变，但动作附近的画面已变化。' };
            }
            if (cmp && cmp.changed === null) {
                return { changed: null, stable: false, text: '控件树没变，动作附近的画面变化不明显，无法判断。' };
            }
        }
    }
    return uiDiff;
}

async function ensureScreenObservation() {
    const now = Date.now();
    if (currentScreenObservation && !currentScreenObservation.stale
        && (now - Number(currentScreenObservation.at || 0)) <= PHONE_OBSERVATION_TTL_MS) {
        return currentScreenObservation;
    }
    currentScreenObservation = await readUiObservation();
    return currentScreenObservation;
}

// 同一条回复里的多个手机标签必须按顺序执行：并发下“点击 → 输入”会乱序，后一步看到的还是前一步之前的界面。
let phoneOpTail = Promise.resolve();

function enqueuePhoneOperation(raw, traceItem) {
    const run = phoneOpTail.then(
        () => runAgentPhoneOperation(raw, traceItem),
        () => runAgentPhoneOperation(raw, traceItem)
    );
    phoneOpTail = run.catch(() => {});
    return run;
}

/** 新一轮任务不再继承上一轮挂住的设备调用。 */
function resetPhoneOperationQueue() {
    phoneOpTail = Promise.resolve();
}

/** 新一轮任务的界面快照必须重新取：上一轮的坐标和“没有变化”结论对新界面没有意义。 */
function resetPhoneObservation() {
    currentScreenObservation = null;
    lastPhoneActionOutcome = null;
}

/** 把「#12」/「id:btn_send」解析成最近一次观察里的节点；没有新鲜观察就拒绝，绝不拿旧坐标硬点。 */
function resolvePhoneNodeRef(parsed) {
    if (parsed.action !== '手机点击') return null;
    const raw = String(parsed.args == null ? '' : parsed.args).trim();
    const refMatch = /^#(\d+)$/.exec(raw);
    const idMatch = /^id:(\S+)$/.exec(raw);
    if (!refMatch && !idMatch) return null;
    const obs = currentScreenObservation;
    if (!obs || !Array.isArray(obs.nodes) || !obs.nodes.length) {
        return { error: '当前没有可用的界面清单。请先 [操作:手机查看界面] 再按编号点击。' };
    }
    if (obs.stale || (Date.now() - Number(obs.at || 0)) > 5000) {
        return { error: '界面观察已过期或已经变化，旧编号不能再用。请先 [操作:手机查看界面] 重新读一次。' };
    }
    const node = refMatch
        ? obs.nodes.find((n) => Number(n.ref) === Number(refMatch[1]))
        : obs.nodes.find((n) => n.id && n.id === idMatch[1]);
    if (!node) {
        return { error: '最近一次界面清单里没有 ' + raw + '。请先 [操作:手机查看界面] 看当前可点的编号和 id。' };
    }
    return { point: { x: Number(node.x), y: Number(node.y) }, label: node.label || node.id || raw, ref: raw };
}

/** 坐标是否落在某个可交互节点的 bounds 内；画布判定用它，而不是节点总数。 */
function phoneNodeAtPoint(nodes, x, y) {
    if (!Array.isArray(nodes)) return null;
    for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const b = n.bounds;
        if (!b) continue;
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return n;
    }
    return null;
}

// 区域级观测
// 页面不贴“画布 / 普通”标签：同一页里按钮走控件树、地图/视频/棋盘走像素是常态。
// 这里用控件覆盖 + 动作落点决定这一步要不要看图，看图也只裁动作附近的小区域。

const SCREEN_GRID = 32;

function inferScreenSize(nodes) {
    let w = 0;
    let h = 0;
    for (const n of nodes || []) {
        const b = n.bounds;
        if (!b) continue;
        w = Math.max(w, Number(b.right) || 0);
        h = Math.max(h, Number(b.bottom) || 0);
    }
    return { width: Math.max(1, w), height: Math.max(1, h) };
}

function markOccupiedGrid(grid, bounds, screenW, screenH, gs) {
    if (!bounds) return;
    const left = Math.max(0, Math.min(screenW - 1, bounds.left));
    const top = Math.max(0, Math.min(screenH - 1, bounds.top));
    const right = Math.max(0, Math.min(screenW, bounds.right));
    const bottom = Math.max(0, Math.min(screenH, bounds.bottom));
    if (right <= left || bottom <= top) return;
    const gx1 = Math.floor(left * gs / screenW);
    const gy1 = Math.floor(top * gs / screenH);
    const gx2 = Math.min(gs - 1, Math.floor(right * gs / screenW));
    const gy2 = Math.min(gs - 1, Math.floor(bottom * gs / screenH));
    for (let gy = gy1; gy <= gy2; gy++) {
        for (let gx = gx1; gx <= gx2; gx++) grid[gy * gs + gx] = 1;
    }
}

function largestEmptyRect(grid, gs, screenW, screenH) {
    const heights = new Array(gs).fill(0);
    let best = { area: 0, gx: 0, gy: 0, gw: 0, gh: 0 };
    for (let y = 0; y < gs; y++) {
        for (let x = 0; x < gs; x++) {
            heights[x] = grid[y * gs + x] ? 0 : heights[x] + 1;
        }
        const stack = [];
        for (let x = 0; x <= gs; x++) {
            const h = x === gs ? 0 : heights[x];
            let start = x;
            while (stack.length && stack[stack.length - 1].h >= h) {
                const top = stack.pop();
                const area = top.h * (x - top.start);
                if (area > best.area) {
                    best = { area, gx: top.start, gy: y - top.h + 1, gw: x - top.start, gh: top.h };
                }
                start = top.start;
            }
            stack.push({ start, h });
        }
    }
    if (!best.area) return null;
    return {
        x: Math.round(best.gx * screenW / gs),
        y: Math.round(best.gy * screenH / gs),
        w: Math.max(1, Math.round(best.gw * screenW / gs)),
        h: Math.max(1, Math.round(best.gh * screenH / gs)),
    };
}

function screenProfile(observation, screenSize) {
    const obs = observation || {};
    const nodes = Array.isArray(obs.nodes) ? obs.nodes : [];
    const meta = parseUiMeta(obs.text || '');
    const inferred = screenSize || lastScreenSize || inferScreenSize(nodes);
    const screenW = Math.max(1, Number(inferred && inferred.width) || 1);
    const screenH = Math.max(1, Number(inferred && inferred.height) || 1);
    const gs = SCREEN_GRID;
    const grid = new Uint8Array(gs * gs);
    for (const n of nodes) markOccupiedGrid(grid, n.bounds, screenW, screenH, gs);
    let marked = 0;
    for (const cell of grid) if (cell) marked++;
    const coverage = meta ? meta.coverage : marked / (gs * gs);
    const uncovered = largestEmptyRect(grid, gs, screenW, screenH);
    const surfaceHints = (meta && meta.surfaceHints && meta.surfaceHints.length)
        ? meta.surfaceHints
        : nodes.filter((n) => /SurfaceView|TextureView|GLSurfaceView|VideoView|WebView/i.test(n.className || ''))
            .map((n) => n.className);
    const textCount = meta ? meta.textCount : nodes.filter((n) => n.label).length;
    const central = Boolean(uncovered
        && screenW * 0.3 <= uncovered.x + uncovered.w / 2
        && uncovered.x + uncovered.w / 2 <= screenW * 0.7
        && screenH * 0.3 <= uncovered.y + uncovered.h / 2
        && uncovered.y + uncovered.h / 2 <= screenH * 0.7);
    const needsPixels = surfaceHints.length > 0
        || coverage < 0.15
        || Boolean(uncovered && uncovered.w * uncovered.h >= screenW * screenH * 0.5);
    return {
        nodes, coverage, uncovered, central, surfaceHints, textCount,
        stable: obs.stable !== false, needsPixels,
        screenSize: { width: screenW, height: screenH },
    };
}

function clampRegion(rect, size) {
    const w = Math.max(1, Number(size && size.width) || 1);
    const h = Math.max(1, Number(size && size.height) || 1);
    const left = Math.max(0, Math.min(w - 1, Math.round(Number(rect && rect.x) || 0)));
    const top = Math.max(0, Math.min(h - 1, Math.round(Number(rect && rect.y) || 0)));
    const right = Math.max(left + 1, Math.min(w, Math.round(left + (Number(rect && rect.w) || 1))));
    const bottom = Math.max(top + 1, Math.min(h, Math.round(top + (Number(rect && rect.h) || 1))));
    return { x: left, y: top, w: right - left, h: bottom - top };
}

function phoneHasPixelSurface(profile) {
    return Boolean(profile && Array.isArray(profile.surfaceHints)
        && profile.surfaceHints.some((h) => /SurfaceView|TextureView|GLSurfaceView|VideoView/i.test(h)));
}

function actionNeedsPixelObservation(parsed, profile, observation) {
    const nodes = (observation && observation.nodes) || (profile && profile.nodes) || [];
    const size = (profile && profile.screenSize) || lastScreenSize || inferScreenSize(nodes);
    const raw = String(parsed.args == null ? '' : parsed.args).trim();
    const nums = raw.split(/\s+/).map((v) => Number(v));
    const action = parsed.action;
    if (action === '手机等待') return { mode: 'none', reason: '等待不改变界面', exempt: true };
    if (action === '手机按键') {
        if (/^(音量|volume|电源|power|截屏|screenshot)/i.test(raw)) {
            return { mode: 'none', reason: '音量 / 电源键不改变界面', exempt: true };
        }
        return { mode: 'controls', reason: '按键结果由控件树判断' };
    }
    if (action === '手机打开') return { mode: 'controls', reason: '打开应用由控件树与前台核对' };
    if (action === '手机输入') {
        const editable = nodes.find((n) => n.editable && n.enabled !== false);
        if (editable) {
            return { mode: 'controls', reason: '有可编辑控件', target: editable, exempt: true };
        }
        return { mode: 'region', reason: '没有可编辑控件', rect: clampRegion({ x: 0, y: size.height * 0.55, w: size.width, h: size.height * 0.4 }, size) };
    }
    if (action === '手机点击') {
        if (!Number.isFinite(nums[0]) || !Number.isFinite(nums[1])) {
            return { mode: 'controls', reason: '坐标无效，走控件树' };
        }
        const hit = phoneNodeAtPoint(nodes, nums[0], nums[1]);
        if (hit) {
            return {
                mode: 'controls', reason: '命中可交互控件', target: hit,
                secondCheck: phoneHasPixelSurface(profile),
                // 二次确认要比对点击点附近的像素，区域必须跟计划一起带下去。
                rect: clampRegion({ x: nums[0] - 140, y: nums[1] - 140, w: 280, h: 280 }, size),
            };
        }
        return {
            mode: 'region', reason: '点击位置没有可读控件',
            rect: clampRegion({ x: nums[0] - 140, y: nums[1] - 140, w: 280, h: 280 }, size),
        };
    }
    if (action === '手机滑动') {
        if (nums.length < 4 || nums.some((v) => !Number.isFinite(v))) {
            return { mode: 'controls', reason: '坐标无效，走控件树' };
        }
        const hit = phoneNodeAtPoint(nodes, nums[0], nums[1]);
        if (hit && (hit.scrollable || hit.clickable)) {
            return { mode: 'controls', reason: '起点命中可交互控件', target: hit };
        }
        const left = Math.min(nums[0], nums[2]);
        const top = Math.min(nums[1], nums[3]);
        return {
            mode: 'region', reason: '起点不在可读控件上',
            rect: clampRegion({
                x: left - 120, y: top - 120,
                w: Math.abs(nums[2] - nums[0]) + 240,
                h: Math.abs(nums[3] - nums[1]) + 240,
            }, size),
        };
    }
    return { mode: 'controls', reason: '默认按控件树判断' };
}

function planPhoneObservation(parsed, observation) {
    const profile = screenProfile(observation, lastScreenSize);
    const plan = actionNeedsPixelObservation(parsed, profile, observation);
    return { ...plan, profile };
}

function loadDataUrlImage(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}

async function regionGrayscale(dataUrl, side = 64) {
    try {
        const img = await loadDataUrlImage(dataUrl);
        if (!img) return null;
        const canvas = document.createElement('canvas');
        canvas.width = side;
        canvas.height = side;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, side, side);
        const data = ctx.getImageData(0, 0, side, side).data;
        const gray = new Uint8Array(side * side);
        for (let i = 0; i < gray.length; i++) {
            const p = i * 4;
            gray[i] = Math.round(data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114);
        }
        return gray;
    } catch (err) {
        return null;
    }
}

/** 局部像素差异：下采样灰度 + 阈值，不用 base64 字节完全相等。 */
async function compareRegionImages(beforeDataUrl, afterDataUrl) {
    const before = await regionGrayscale(beforeDataUrl);
    const after = await regionGrayscale(afterDataUrl);
    if (!before || !after) return null;
    let changed = 0;
    for (let i = 0; i < before.length; i++) {
        if (Math.abs(before[i] - after[i]) > 18) changed++;
    }
    const ratio = changed / before.length;
    const stable = ratio <= 0.004;
    return { ratio, stable, changed: ratio >= 0.02 ? true : (stable ? false : null) };
}

async function capturePhoneRegion(rect) {
    if (!rect || rect.w < 1 || rect.h < 1) return null;
    const res = await callDeviceQuietly('手机截图区域', rect.x + ' ' + rect.y + ' ' + rect.w + ' ' + rect.h);
    if (!res || res.ok === false || !res.imageBase64) return null;
    return {
        dataUrl: 'data:' + (res.imageMime || 'image/jpeg') + ';base64,' + res.imageBase64,
        rect, meta: res,
    };
}

async function captureStableRegion(rect, options = {}) {
    const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 140;
    const first = await capturePhoneRegion(rect);
    if (!first) return null;
    await sleepMs(pollMs);
    const second = await capturePhoneRegion(rect);
    if (!second) return { image: first, stable: false };
    const cmp = await compareRegionImages(first.dataUrl, second.dataUrl);
    return (cmp && cmp.stable)
        ? { image: second, stable: true, ratio: cmp.ratio }
        : { image: second, stable: false, ratio: cmp ? cmp.ratio : null };
}

/** 局部截图坐标 → 屏幕坐标（region offset + 图片缩放），后续如果让模型读区域图要靠它。 */
function regionPointToScreen(region, x, y) {
    const meta = (region && region.meta) || {};
    const ox = Number(meta.regionX != null ? meta.regionX : (region && region.rect ? region.rect.x : 0)) || 0;
    const oy = Number(meta.regionY != null ? meta.regionY : (region && region.rect ? region.rect.y : 0)) || 0;
    const rw = Number(meta.regionW || (region && region.rect && region.rect.w) || 1) || 1;
    const rh = Number(meta.regionH || (region && region.rect && region.rect.h) || 1) || 1;
    const iw = Number(meta.imageWidth || rw) || rw;
    const ih = Number(meta.imageHeight || rh) || rh;
    return { x: Math.round(ox + (Number(x) || 0) * rw / iw), y: Math.round(oy + (Number(y) || 0) * rh / ih) };
}

/** 没有截图时也要知道物理屏幕尺寸：区域裁剪和覆盖统计都依赖它。 */
async function ensureScreenSize() {
    if (lastScreenSize && lastScreenSize.width > 0 && lastScreenSize.height > 0) return lastScreenSize;
    // 最近一次读界面的概况行就带尺寸（原生 dumpUiTree 的输出）：先从它取，省一次设备往返
    if (currentScreenObservation && currentScreenObservation.text) {
        const fromSnapshot = phoneDumpMeta(currentScreenObservation.text).screen;
        if (fromSnapshot && fromSnapshot.width > 0) {
            lastScreenSize = fromSnapshot;
            return lastScreenSize;
        }
    }
    try {
        const res = await callDeviceQuietly('手机状态', '');
        const text = String((res && (res.text || res.message)) || '');
        const m = text.match(/(\d{3,5})\s*[×x]\s*(\d{3,5})/);
        if (m) lastScreenSize = { width: Number(m[1]), height: Number(m[2]) };
    } catch (err) {
        console.warn('[Agent] 读取屏幕尺寸失败:', err);
    }
    return lastScreenSize;
}

async function runAgentPhoneOperation(raw, traceItem) {
    const rt = window.agentRuntime;
    ensureA11yEventListener();
    // 工具通道（ElainaOps.invoke → runToolCalls）把无返回值读成「没有返回结果」：每条提前退出都必须带返回对象。
    if (!rt) {
        const m = '手机操作不可用：Agent 运行时没有初始化。';
        insertAgentResult(m);
        return { ok: false, text: m };
    }
    const parsed = parsePhoneOperation(raw);
    if (!parsed) {
        const m = '无法识别的手机操作：' + String(raw || '').trim()
            + '\n可用写法：手机状态 / 手机查看界面 / 手机截图 / 手机点击 x y / 手机滑动 x1 y1 x2 y2 [时长] / '
            + '手机输入 文字 / 手机按键 返回|主页|回车 / 手机打开 应用名或包名 / 手机等待 毫秒 / '
            + '手机应用列表 / 手机通知 / 手机设备信息 / 手机短信 [条数] / 手机通讯录 [关键词] / 手机日历 [天数] / '
            + '手机列出文件 [路径] / 手机读文件 路径 / 手机写文件 路径|内容 / 手机删除文件 路径';
        agentSessionRecordFailure(m, { progress: false, step: rt.getStep(), summary: '无法识别的手机操作' });
        return { ok: false, text: m };
    }
    // 总开关关掉直接拒绝，放在探测之前：不必去 ping 原生，这个理由对用户也最直接。
    if (state.settings.agentPhoneEnabled === false) {
        const m = '已跳过：手机操作总开关是关闭的。需要时请在 设置 → 能力 → 手机操作 里打开「允许 AI 操作手机」。';
        agentSessionRecordFailure(m, { progress: false, step: rt.getStep(), summary: '手机操作总开关已关闭' });
        return { ok: false, text: m };
    }
    // 「手机命令」不向模型开放：后台方式虽然有 shell / root，但那只用于内部动作（启动应用、点击、读界面），不把任意命令暴露给模型。
    if (parsed.action === '手机命令') {
        const m = '「手机命令」这个版本不开放：后台方式（Shizuku / Root / 模块）的系统权限只用于启动应用、点击、读界面等内部动作，'
            + '不执行模型给的任意命令。\n'
            + '需要操作手机可以用「手机打开 / 手机点击 / 手机滑动 / 手机输入 / 手机按键」；'
            + '确实要跑系统命令的话，得换到电脑端。';
        agentSessionRecordFailure(m, { progress: false, step: rt.getStep(), summary: '手机命令不开放' });
        return { ok: false, text: m };
    }
    // 判据是「有没有一条路能用」，不是设置里有没有选过 —— 看 currentBackendId 会把还没设默认方式的人挡在弹窗外；缓存说没有时真探一次。
    let anyReady = AGENT_BACKENDS.some((b) => backendStatus[b.id] && backendStatus[b.id].state === 'ready');
    if (!anyReady) {
        await refreshBackendStatus();
        anyReady = AGENT_BACKENDS.some((b) => backendStatus[b.id] && backendStatus[b.id].state === 'ready');
    }
    if (!anyReady) {
        const m = '已跳过：这台设备上没有任何可用的运行方式，AI 现在不能操作手机。\n'
            + '· 无障碍：' + ((backendStatus.accessibility && backendStatus.accessibility.text) || '未开启') + '\n'
            + backgroundUnavailableText() + '\n'
            + '请到「设置 → 能力 → 手机操作」点「选择运行方式」完成授权（无障碍门槛最低）。';
        agentSessionRecordFailure(m, { progress: false, step: rt.getStep(), summary: '没有可用的手机运行方式' });
        return { ok: false, text: m };
    }
    // 本批次已被停止就不再执行：否则每一步都重新 beginRun 把停止标志清掉，等于没停。
    if (rt.isHalted && rt.isHalted()) {
        const m = '已停止：用户中止了本次操作，这一步（' + parsed.action + '）没有执行。';
        agentSessionRecordFailure(m, { progress: false, step: rt.getStep(), summary: '用户已停止' });
        return { ok: false, text: m };
    }
    // 「手机打开」先把应用名解析成包名：解析不出来就停在这里并列出候选。
    // 把一个猜错的包名交给原生，代价不是"没打开"，而是"打开了别的应用"。
    let openPkg = '';
    if (parsed.action === '手机打开') {
        const resolved = await resolvePhoneOpenTarget(parsed.args);
        if (resolved.error) {
            agentSessionRecordFailure(resolved.error, { progress: false, step: rt.getStep(), summary: '应用名无法解析' });
            return { ok: false, text: resolved.error };
        }
        openPkg = resolved.pkg;
        parsed.args = resolved.pkg;
    }
    // 元素引用优先：模型看到 #N 就用 #N，前端把它解析成最近一次观察里的坐标；过期/变化就拒绝重读。
    const nodeRef = resolvePhoneNodeRef(parsed);
    if (nodeRef && nodeRef.error) {
        if (agentSessionActive()) {
            agentSessionAddObservation(nodeRef.error, { progress: false, step: rt.getStep(), summary: '元素引用过期 / 未找到' });
        } else {
            insertAgentResult(nodeRef.error, { continueLoop: true, asContext: true, progress: false });
        }
        return { ok: false, text: nodeRef.error };
    }
    if (nodeRef && nodeRef.point) {
        parsed.resolvedRef = nodeRef.ref;
        parsed.resolvedLabel = nodeRef.label;
        parsed.args = nodeRef.point.x + ' ' + nodeRef.point.y;
    }
    // 同一动作连续执行且上一次没有改变界面：再点一次只会重复同一个结果，代码层直接拦住。
    // 只靠提示词说“不要重复”没用，模型看不到自己上一步的实际效果。
    const actionKey = phoneActionKey(parsed);
    if (lastPhoneActionOutcome && lastPhoneActionOutcome.key === actionKey
        && lastPhoneActionOutcome.changed === false && lastPhoneActionOutcome.exempt !== true) {
        const m = '已跳过重复操作：' + parsed.action
            + (parsed.args ? '（' + String(parsed.args).slice(0, 80) + '）' : '')
            + ' 上一次执行后界面没有变化，系统没有再次执行。\n'
            + '请先 [操作:手机查看界面] 重新确认当前界面，或换一个目标 / [操作:手机按键 返回]。';
        // 工具通道由 runToolCalls 统一回灌并记熔断；这里再插一条会同一结果出现两次、无进展也记两次。
        if (agentSessionActive()) {
            agentSessionAddObservation(m, { progress: false, step: rt.getStep(), summary: '重复动作被拦（界面没有变化）' });
        } else if (!traceItem) {
            insertAgentResult(m, { continueLoop: true, asContext: true, progress: false });
        }
        return { ok: false, text: m };
    }
    if (phoneActionNeedsScreen(parsed.action)) {
        if (!runModeDecision) {
            const picked = await pickPhoneRunMode();
            if (picked === 'none') {
                // 所有后端都不就绪：交给上面那道「没有任何可用方式」的闸，不把 runModeDecision 写死。
            } else if (picked) {
                runModeDecision = picked;
                state.settings.agentBackend = picked;
                persistSettings();
            } else {
                runModeDecision = 'cancelled';
            }
        }
        if (runModeDecision === 'cancelled') {
            const m = '已跳过「' + parsed.action + '」：你没有选择运行方式（前台 / 后台）。'
                + '要我做的话跟我说一声，我会再问一次。';
            agentSessionRecordFailure(m, { progress: false, step: rt.getStep(), summary: '未选择运行方式' });
            return { ok: false, text: m };
        }
        // 等运行方式弹窗期间用户可能已经按了停止：这里再判一次，
        // 避免刚 beginRun 又把状态条闪出来、多走一遍授权。
        if (rt.isHalted && rt.isHalted()) {
const m = '已停止：用户中止了本次操作，这一步（' + parsed.action + '）没有执行。';
                agentSessionRecordFailure(m, { asContext: true, progress: false, step: rt.getStep(), summary: '用户已停止' });
            return { ok: false, text: m };
        }
    }
    const coordProblem = phoneCoordsOutOfScreen(parsed);
    if (coordProblem) {
        agentSessionRecordFailure(coordProblem, { progress: false, step: rt.getStep(), summary: '坐标超出屏幕' });
        return { ok: false, text: coordProblem };
    }
    phoneOpsInFlight += 1;
    clearTimeout(phoneRunEndTimer);
    if (!rt.isRunning()) {
        rt.beginRun();
        // 悬浮条只在 AI 把界面切走时出现（由 visibilitychange 同步）：
        // 留在应用里时状态条上就有停止按钮，再浮一条只是重复。
        // 这里只查权限并引导 —— 缺权限时趁用户还在应用里当场问，别等切走了才发现没有。
        if (rt.syncOverlayWithVisibility) {
            void (async () => {
                const perm = rt.checkOverlayPermission ? await rt.checkOverlayPermission() : 'unavailable';
                if (perm === 'ok') {
                    rt.syncOverlayWithVisibility();
                } else if (perm === 'need-permission' && !overlayPromptDeclined) {
                    // 授权入口藏得深，不主动引导就等于「应用从不请求悬浮窗权限」；只问一次（拒绝过就不再拦），跳去授权后回来仍可再问。
                    const go = await showCustomModal({
                        title: '需要悬浮窗权限',
                        message: 'AI 正在操作手机。\n\n'
                            + '没有悬浮窗权限时，每一步确认都要你切回本应用来点 ——\n'
                            + '而切回来会让被操作的应用退到后台，那一步操作就可能失败，\n'
                            + 'AI 只能重试，看起来像卡住了。\n\n'
                            + '开了之后，AI 切到别的应用时屏幕上会浮一个小条：\n'
                            + '随时点停止、需要确认时就地允许，全程不用切回本应用。\n'
                            + '（在本应用里仍然用对话上方的状态条，不会多浮一条。）\n\n'
                            + '现在去系统设置里打开「显示在其他应用上层」？',
                        confirmText: '去开启',
                        cancelText: '这次不用',
                    }).catch(() => false);
                    if (go) {
                        await enableOverlay({ quiet: true });   // 跳系统设置（quiet：不叠说明框）
                    } else {
                        overlayPromptDeclined = true;
                    }
                }
            })();
        }
    }
    try {
        rt.assertNotStopped();
        rt.setStep(rt.getStep() + 1, parsed.action);
        const stepNo = rt.getStep();
        // 复用外层的行，同一个动作记两行会让用户以为做了两件事。
        const ownTrace = !traceItem;
        if (ownTrace) {
            traceItem = recordTurnTool({
                kind: 'phone',
                title: '手机 · ' + parsed.action,
                summary: describePhoneOperation(parsed),
                args: parsed.args ? JSON.stringify(parsed.args) : '',
                state: 'running'
            });
        } else {
            updateTurnTool(traceItem, {
                kind: 'phone',
                title: '手机 · ' + parsed.action,
                summary: describePhoneOperation(parsed),
            });
        }
        // 手机操作只在 phoneTierAllows 判不过时确认（无障碍破坏力有限，模块「手机命令」的风险由设置页免责声明承担）：它是唯一放行策略落点，加闸只改它。
        if (!phoneTierAllows(parsed.action)) {
            const allowed = await rt.requestApproval(parsed.action, describePhoneOperation(parsed), { forceAsk: true });
            if (!allowed) {
                updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许这一步' });
                agentSessionRecordFailure('已跳过「' + parsed.action + '」：用户没有允许这一步。请换一种方式，或先向用户说明为什么要这么做。', { asContext: true, progress: false, step: rt.getStep(), summary: '用户未允许这一步' });
                return { ok: false, text: '用户没有允许这一步：' + parsed.action };
            }
        }
        rt.assertNotStopped();
        // 动作前的界面快照：后续用它判断这一步到底有没有改变界面。
        const beforeObservation = PHONE_SCREEN_ACTIONS.includes(parsed.action)
            ? await ensureScreenObservation()
            : null;
        if (PHONE_SCREEN_ACTIONS.includes(parsed.action)) await ensureScreenSize();
        // 实际执行手机动作 = 交给子代理（主对话只负责派发与转述）；简报/目标在会话内组装
        if (typeof agentSessionStart === 'function') agentSessionStart(state._agentGoal);
        const observationPlan = PHONE_SCREEN_ACTIONS.includes(parsed.action)
            ? planPhoneObservation(parsed, beforeObservation)
            : null;
        if (observationPlan && (observationPlan.mode === 'region' || observationPlan.secondCheck)) {
            observationPlan.beforeImage = await capturePhoneRegion(observationPlan.rect);
        }
        rt.assertNotStopped();
        const deviceStartedAt = Date.now();
        const fullResult = await execPhoneOperation(parsed);
        // 启动成功 ≠ 打开的是它：真机上出现过「让它打开 A、前台却是 B」。
        // 用设备信息核对一次前台，把差异如实交给模型。虚拟副屏后端不核对物理屏前台 —— 那里本来就不是它。
        rt.assertNotStopped();
        let verifiedResult = fullResult;
        if (openPkg && backendOperatesPhysicalScreen(lastUsedBackendId || runModeDecision)) {
            const warning = await verifyPhoneOpenTarget(openPkg);
            if (warning) verifiedResult = String(fullResult || '') + '\n' + warning;
        }
        const screenDiff = await observePhoneActionResult(parsed, beforeObservation, observationPlan);
        if (typeof agentRunNoteMetric === 'function') {
            agentRunNoteMetric({
                action: parsed.action,
                deviceMs: Date.now() - deviceStartedAt,
                mode: observationPlan ? observationPlan.mode : 'none',
                changed: screenDiff ? screenDiff.changed : null,
            });
        }
        if (screenDiff && screenDiff.text) {
            verifiedResult = String(verifiedResult || '') + '\n【界面变化】' + screenDiff.text
                + (screenDiff.changed === false
                    ? '\n不要重复同一操作；先重新读界面，或换目标 / 按返回。'
                    : '');
        }
        if (PHONE_SCREEN_ACTIONS.includes(parsed.action)) {
            lastPhoneActionOutcome = {
                key: actionKey,
                changed: screenDiff ? screenDiff.changed : null,
                exempt: Boolean(observationPlan && observationPlan.exempt),
            };
        } else {
            // 读界面 / 截图 / 读信息之后模型会重新判断，下一次同名动作不算重复。
            lastPhoneActionOutcome = null;
        }
        if (parsed.action === '手机查看界面') {
            const nodes = parseUiNodes(verifiedResult);
            currentScreenObservation = {
                at: Date.now(), text: verifiedResult, nodes, stable: true,
                signature: phoneUiSignature(nodes),
            };
        }
        if (parsed.action === '手机查看界面' && !phoneVisionModelConfigured() && !state._agentImageUnsupported
            && (typeof cachedModelImageVerdict !== 'function' || cachedModelImageVerdict() !== false)) {
            // 普通界面有可点元素清单就够用；只有控件覆盖低 / 有 SurfaceView 提示时才把截图直接交给主模型。
            const viewNodes = parseUiNodes(verifiedResult);
            const profile = screenProfile({ text: verifiedResult, nodes: viewNodes, stable: true }, lastScreenSize);
            // 只对“完全没有可读控件”或原生明确报告 SurfaceView / TextureView 的页面自动附图；
            // WebView（普通 H5）不自动截图，普通页面等模型自己要求截图。
            if (phoneHasPixelSurface(profile) || viewNodes.length === 0) await maybeStashScreenImage();
        }
        if (PHONE_SUMMARY_ACTIONS.has(parsed.action) && typeof agentRunNoteStep === 'function') {
            agentRunNoteStep(describePhoneOperation(parsed) + (lastPhoneExecOk ? '' : '（失败）'));
        }
        if (lastPhoneExecOk && (!screenDiff || screenDiff.changed !== null
            || (observationPlan && observationPlan.exempt))
            && typeof agentRunNoteSuccess === 'function') agentRunNoteSuccess();
        updateTurnTool(traceItem, { state: 'ok', result: verifiedResult });
        // 手机操作走原生桥，不经过本机服务，所以服务端日志里原本完全看不到 AI 动过设备。
        // 这里主动报一行到日志页（[Agent] 前缀由 frontend-log.js 转发），
        // 用户排查"AI 到底点了什么/读到了什么"时才有据可查。
        logPhoneOperation(parsed, verifiedResult);
        const pageNo = parsed.action === '手机查看界面'
            ? Math.max(1, parseInt(String(parsed.args || '').trim(), 10) || 1)
            : 1;
        const opResult = parsed.action === '手机查看界面'
            ? summarizeUiDumpForModel(verifiedResult, pageNo)
            : verifiedResult;
        // 界面没有变化不算进展；持续变化 / 读不到界面（changed:null）既不加也不减；等待/输入等豁免算进展。
        const progress = (observationPlan && observationPlan.exempt)
            ? true
            : (screenDiff
                ? (screenDiff.changed === false ? false : (screenDiff.changed === true ? true : null))
                : true);
        const changeText = screenDiff
            ? (screenDiff.changed === false ? '界面没有变化' : (screenDiff.changed === true ? '界面已变化' : '变化未知'))
            : '';
        const currentScreen = parsed.action === '手机查看界面' || parsed.action === '手机截图';
        const stepSummary = parsed.action === '手机查看界面'
            ? '第 ' + stepNo + ' 步：读取界面（' + parseUiNodes(verifiedResult).length + ' 个可操作元素）'
            : '第 ' + stepNo + ' 步：' + describePhoneOperation(parsed) + (changeText ? ' → ' + changeText : '');
        if (agentSessionActive()) {
            // 会话模式：观察进子代理上下文（压缩规则同历史压缩），报告收尾时统一写回主对话
            agentSessionAddObservation(opResult, {
                progress, step: stepNo, summary: stepSummary,
                changed: screenDiff ? screenDiff.changed : null,
            });
        } else if (ownTrace) insertAgentResult(opResult, { continueLoop: true, asContext: true, progress, observation: true, currentScreen, step: stepNo, summary: stepSummary });
        return { ok: true, text: String(opResult || ''), progress };
    } catch (err) {
        const reason = (err && err.message) || String(err);
        if (err && err.agentAborted) {
            insertAgentResult('已停止：用户中止了操作，剩余步骤没有执行。', { asContext: true });
            return { ok: false, text: '用户中止了手机操作' };
        }
        if (PHONE_SUMMARY_ACTIONS.has(parsed.action) && typeof agentRunNoteStep === 'function') {
            agentRunNoteStep(describePhoneOperation(parsed) + '（未完成）');
        }
        // 一体模式下失败必须留在可见处，不能只藏在可折叠的过程区里；会话模式则回灌子代理
        // 并驱动下一步，过程话由收尾报告统一写回。
        agentSessionRecordFailure('手机操作失败：' + reason, { progress: false, step: rt.getStep(), summary: '手机操作失败' });
        return { ok: false, text: '手机操作失败：' + reason };
    } finally {
        phoneOpsInFlight -= 1;
        if (phoneOpsInFlight <= 0) {
            clearTimeout(phoneRunEndTimer);
            phoneRunEndTimer = setTimeout(() => {
                // 一批做完不等于整轮结束（续跑马上要发下一次模型调用）：管道还忙时既不收浮层也不 endRun。
                if (agentPipelineBusy()) return;
                rt.endRun();
                scheduleOverlayHide();
            }, 600);
        }
    }
}
