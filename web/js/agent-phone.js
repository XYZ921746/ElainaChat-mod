/* ============================================================================
 * 手机操作（从 agent.js 拆出）
 *
 * 原生设备桥、运行方式选择、手机动作执行与 [操作:手机xxx] 执行链。
 * 依赖 agent.js 的运行时 / 权限 / 结果回灌函数（运行时才调用）。
 * ========================================================================== */
'use strict';

// ===== 手机操作：解析 [操作:手机xxx …] → 停止检查 → 授权 → 执行 → 回灌 =====
// 原生设备层由 ElainaShellPlugin 提供（Capacitor 注入 window.Capacitor.Plugins.ElainaDevice），
//   这里挂 window.ElainaDevice 别名供执行层使用；网页版上为空，执行时提示「设备能力还没接入」。
function deviceBridge() {
    if (window.ElainaDevice) return window.ElainaDevice;
    const nativePlugin = window.Capacitor?.Plugins?.ElainaDevice;
    if (nativePlugin) {
        window.ElainaDevice = nativePlugin;
        return nativePlugin;
    }
    return null;
}
// 提前挂一次（正常时序下此时已经注入完毕），拿不到也不影响后续按需获取
void deviceBridge();


let phoneOpsInFlight = 0;
let phoneRunEndTimer = null;
let overlayHideTimer = null;

/**
 * 悬浮窗的收起分成「要收吗」与「什么时候真收」，两处判据都只看 agentPipelineBusy()。
 *
 * 为什么不能「这批操作做完就 hide、下一步再 show」：一次任务由很多步组成，步与步之间隔着数秒的模型调用，
 *   浮层会被反复 removeView/addView，用户看到的就是「一直在闪」。
 * 守卫必须把**模型调用进行中**也算进去：续跑定时器一触发就把自己清成 null，而 callAI 要跑好几秒，
 *   此时 phoneOpsInFlight 与 agentContinueTimer 都是「不忙」，排队中的收起会把浮层正好在「思考下一步」那几秒收掉。
 * 续跑开始时会清掉收起定时器（见 continueAgentLoop），并换成「正在思考下一步…」。
 */
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

// ===== 运行方式：前台（无障碍）/ 后台（模块）=====
// 无障碍 = **前台**：在你正用的那块屏幕上操作 —— 看得见 AI 点在哪儿、随时能停，
//                     代价是它占着屏幕，这期间你没法用手机做别的事。
// 模块   = **后台**：在独立副屏上静默操作 —— 不抢屏幕，你可以继续用手机，
//                     代价是实现方式由模块提供（要刷 KernelSU 模块）。
// 两条路都可用时，"走哪条"不该由设置里的预设替用户决定：同一个任务，
// 有时你想盯着它做（前台），有时你想让它悄悄做完（后台）。所以：AI 真要操作
// 屏幕时**问一次**，答案管本轮。
// 三条规矩：
//   1. **一轮只问一次**：答案存在 runModeDecision，整轮（含续跑）都用它。
//      重置点在 resetAgentContinueBudget（用户每发一条消息 = 一轮）——
//      不能挂在 endRun() 上：那个每批操作结束都会调，会退化成"每步问一次"。
//   2. **只对"要动屏幕"的动作问**：读取信息 / 工作区文件 / 手机等待都不需要选。
//   3. **取消 = 本轮这一步不做**：如实回灌且不续跑，绝不替用户选一条。
//      （也不能把"后台"塞进弹窗的取消键 —— 取消还会被点遮罩触发，
//        那等于用户没选就默默用了后台。见 showCustomModal 的 altText。）
let runModeDecision = '';   // '' = 本轮还没问过 | 'accessibility' | 'module' | 'cancelled'
// 这次决定是不是"用户在弹窗里明确选的" —— 是的话原生必须**严格照办**，不许自动换路。
// 单路能用时（没弹窗）保持 false：那种情况"做不到就换另一条"本来就是唯一出路。
let runModeExplicit = false;
let runModePicker = null;   // 进行中的询问 Promise（记忆化，见 pickPhoneRunMode）

/** 这个动作要不要"动屏幕"（只有这类才值得问前台/后台） */
function phoneActionNeedsScreen(action) {
    return ['手机查看界面', '手机截图', '手机点击', '手机滑动', '手机输入',
        '手机按键', '手机打开', '手机命令'].includes(action);
}

/**
 * 问用户这一轮走前台还是后台。
 *
 * @returns 'accessibility' | 'module' | 'none'（两条路都不就绪）| ''（用户取消）
 *
 * 只有**两条路都就绪**时才弹窗；只有一条能用时直接返回它 ——
 * 拿一个没得选的弹窗去烦用户，只是多余的点击。
 */
async function pickPhoneRunMode() {
    // 同一条回复里可能有两个「动屏」操作 → 会并发问两次；showCustomModal 是**单例**，第二次会覆盖按钮的
    //   onclick，第一个 Promise 永远不 resolve、那个操作被静默吞掉。所以进行中的询问必须记忆化。
    if (runModePicker) return runModePicker;
    runModePicker = doPickPhoneRunMode().finally(() => { runModePicker = null; });
    return runModePicker;
}

/** 真去问一次（外层 pickPhoneRunMode 负责记忆化与去重） */
async function doPickPhoneRunMode() {
    // 弹窗期间先作废排队中的收起：此刻没有操作在飞、也没有续跑，冷不丁把浮层收掉
    // 再弹一个应用内弹窗，用户会以为软件出了两次毛病。
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
    // 真探一次。⚠️ 两步不能省、也不能混：
    //   · fetchDeviceStatus(true) 刷新的是**原生状态缓存**；
    //   · backendStatus 那份（设置页显示、上面这些判据读的）只有 detectBackend 会写。
    //     只调前者的话，这里读到的还是旧值。
    await fetchDeviceStatus(true);
    backendStatus.accessibility = await detectBackend('accessibility');
    backendStatus.module = await detectBackend('module');
    const accReady = backendStatus.accessibility && backendStatus.accessibility.state === 'ready';
    const modReady = backendStatus.module && backendStatus.module.state === 'ready';
    if (!accReady && !modReady) return 'none';
    if (!(accReady && modReady)) return accReady ? 'accessibility' : 'module';
    // 走到这里说明弹了窗 → 下面这个决定是**用户显式选的**，原生那边要严格照办
    // （不许"互通自动换路"把它悄悄改掉，见 ElainaShellPlugin 的 strict）。
    runModeExplicit = true;
    const chosen = await showCustomModal({
        title: '选择运行方式',
        message: 'AI 要操作这台手机，两种方式都可用：\n\n'
            + '· 前台运行（无障碍）—— 在你正在用的屏幕上操作。\n'
            + '  你能看见 AI 点在哪儿、随时点悬浮窗上的「停止」；\n'
            + '  代价是它占着屏幕，这期间你没法用手机做别的事。\n\n'
            + '· 后台运行（模块）—— 在独立副屏上操作，不抢你的屏幕，\n'
            + '  你可以继续用手机；代价是看不到它点了什么（仍可点「停止」）。\n\n'
            + '（本次任务只问这一次。默认方式可在「设置 → 能力 → 手机操作」里改。）',
        confirmText: '前台运行',
        altText: '后台运行',
        altValue: 'module',
        cancelText: '取消',
    }).catch(() => false);
    if (chosen === 'module') return 'module';
    if (chosen === true) return 'accessibility';
    return '';
}
// 最近一次手机操作**实际**用的后端（原生在结果里回报）。
// 运行状态条的「看画面」按钮靠它判断该不该出现 —— 只有模块后端有副屏画面。
let lastUsedBackendId = '';
// 悬浮窗权限提示：用户明确点过「这次不用」就别每次都拦（那会变成新的打扰）
let overlayPromptDeclined = false;



/** 这些是「读取信息」类操作 —— 受设置里的隐私开关控制 */
const PHONE_READ_OPS = [
    '手机应用列表', '手机通知', '手机设备信息', '手机通讯录', '手机日历', '手机短信',
];

/**
 * 这一步的读取是否被用户的隐私开关允许。
 *
 * 与 phoneTierAllows（管"要不要问"）是**两件不同的事**：
 *   · 隐私开关关掉 → 这个能力**不存在**，AI 连标签都看不到（提示词里不注入）；
 *   · 档位         → 决定执行前要不要弹确认。
 * 两者都不通过时，这里给出一句能照做的提示，而不是静默失败。
 */
function phoneReadBlockedReason(action) {
    if (!PHONE_READ_OPS.includes(action)) return '';
    if (phoneReadAllowed(action)) return '';
    return '已跳过「' + action + '」：你在「设置 → 能力 → 手机操作 → 读取信息（隐私）」里'
        + '关闭了这项权限。需要的话去那里打开，或让我用别的方式帮你。';
}


async function execPhoneOperation(parsed) {
    const dev = deviceBridge();
    if (!dev || typeof dev.exec !== 'function') {
        throw new Error('设备能力还没接入：这个版本里没有手机操作的原生插件，这一步没有真正执行。'
            + '（网页版就是这样，请用带原生设备层的 APK）');
    }
    const res = await dev.exec({
        action: parsed.action,
        // 文件类操作的路径要做一层翻译（见 phoneFilePath 的说明）
        args: phoneArgsForNative(parsed),
        // 带下去的实现方式：**本轮选定的运行方式优先**（前台/后台弹窗的选择，
        // 见 runModeDecision），没选过才回落到设置里的默认方式。
        // 原生侧优先用它；它不可用时明确报错，而不是偷偷换成另一种 ——
        // 否则用户以为在走模块，实际走的是无障碍，没法排查。
        backend: runModeDecision === 'module' || runModeDecision === 'accessibility'
            ? runModeDecision
            : currentBackendId(),
        // 用户**在弹窗里显式选**的时候，原生必须严格照办 ——
        //   不许"互通自动换路"把他的选择悄悄改掉。
        //   否则选了前台、动作却是「手机打开」这种无障碍做不到的，就会被静默改到副屏。
        strictBackend: runModeExplicit
    });
    let text = (res && (res.text || res.message)) || (parsed.action + ' 完成');
    // 记下**实际**用的后端（原生会回报 res.backend）。
    // 用途：只有模块后端才有"副屏画面"可看 —— 运行状态条上的「看画面」按钮
    // 据此显示/隐藏。不记这个的话，用户选的是"自动"，就无从判断走没走模块。
    if (res && res.backend) {
        lastUsedBackendId = String(res.backend);
        // render() 在 agentRuntime 的 IIFE 里，读不到这个变量 —— 桥到 window
        window.__lastAgentBackend = lastUsedBackendId;
    }
    // 截图：原生把图片以 base64 带回来。交给已配置的视觉模型看一眼，
    // 把「屏幕上是什么」变成文字回灌给主模型 —— 与「图片理解」复用同一条链路。
    if (res && res.imageBase64 && parsed.action === '手机截图') {
        text = await describePhoneScreenshot(res, text);
    }
    return text;
}

/**
 * 把 AI 给的参数翻译成原生层认识的形状。
 *
 * 目前只做一件事：文件类操作的路径前缀。
 *
 *   原生层有**两个**文件落脚点：Agent 工作区（应用私有目录）与用户授权的文件夹
 *   （SAF）。两者用的是完全不同的 API，原生靠一个前缀区分：
 *     · 裸相对路径   → 工作区
 *     · `saf:相对路径` → 用户授权的文件夹
 *
 *   那"什么时候加前缀"由谁决定？**前端**，因为只有前端知道用户当前的意图与状态：
 *   AI 说的"下载/notes.txt"本身不区分这两个地方。规则是：
 *     · 用户**已授权**文件夹 → 加 `saf:` 前缀（AI 说"写到 notes.txt"时，
 *       用户多半想的是他自己那个文件夹，而不是应用私有的工作区）
 *     · 没授权 → 不加，落到工作区
 *
 *   ⚠️ 这条规则有个已知的取舍：一旦授权了文件夹，AI 就**没法**再往工作区写了
 *   （所有路径都会被加上 saf:）。要写工作区只能先取消授权。
 *   之所以接受它：同时维护"两个可写根"会让 AI 与用户都搞不清文件到底存哪了，
 *   而工作区的定位本来就是"没授权文件夹时的默认落脚点"。
 */
function phoneArgsForNative(parsed) {
    const raw = String(parsed.args == null ? '' : parsed.args);
    if (!PHONE_FILE_OPS.includes(parsed.action)) return raw;
    const hasFolder = Boolean(String(state.settings.agentFolderUri || '').trim());
    if (!hasFolder) return raw;
    // 写文件是 `路径|内容`：前缀只加在路径那一段上
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

/** 文件类操作（路径需要按授权状态加前缀的那几个） */
const PHONE_FILE_OPS = ['手机列出文件', '手机读文件', '手机写文件', '手机删除文件'];

// 上一次截图带回来的屏幕尺寸（物理像素）。用来给点击/滑动坐标做越界校验，
// 因为越界坐标派发出去只会失败或点空，模型却会当成"完成"。
let lastScreenSize = null;

// 待交给主模型的截图（一次性）：没有配置视觉模型时，手机截图直接附给主模型看，
//   而不是先转成文字。下一次请求用掉后清空；超过 60 秒没用掉就作废，免得串到别的对话里。
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

/** 是否配置了独立的视觉模型（与 callAI 的判据一致） */
function phoneVisionModelConfigured() {
    return state.settings.visionEnabled === true
        && Boolean(String(state.settings.visionBaseUrl || '').trim() && String(state.settings.visionModel || '').trim());
}

/** 没配视觉模型时，顺手截一张图交给主模型看（失败不影响读界面这种主流程）。 */
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

/** 直接调原生设备层执行一个动作，不经过权限/运行方式/过程记录 —— 只给"读界面"这类内部辅助用。 */
async function callDeviceQuietly(action, args) {
    const dev = deviceBridge();
    if (!dev || typeof dev.exec !== 'function') return null;
    try {
        return await dev.exec({
            action,
            args: args == null ? '' : String(args),
            backend: runModeDecision === 'module' || runModeDecision === 'accessibility'
                ? runModeDecision
                : currentBackendId(),
            strictBackend: false
        });
    } catch (err) {
        console.warn('[Agent] 辅助设备调用失败:', action, err);
        return null;
    }
}

// 控件树里一行形如：#3 “发送” id=btn_send 可点 [540,1200]。
// 只取可点 / 可输入的行 —— 不可点的容器节点给模型只会增加噪音，还可能被误点。
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
        out.push({
            index: Number(m[1]),
            label: label || (idm ? idm[1] : ''),
            id: idm ? idm[1] : '',
            x: Number(m[3]),
            y: Number(m[4]),
        });
    }
    return out;
}

/** 把「编号 → 控件 / 坐标」清单排成一行行给模型看（截断到 60 条，免得又把上下文灌满）。 */
function formatNodeListForModel(nodes) {
    const limit = Math.min(nodes.length, 60);
    const lines = [];
    for (let i = 0; i < limit; i++) {
        const n = nodes[i];
        const name = n.label || n.id || '控件';
        lines.push('#' + (i + 1) + ' ' + name + ' (' + n.x + ',' + n.y + ')' + (n.id ? ' id=' + n.id : ''));
    }
    return lines.join('\n');
}

/**
 * 把控件树 dump 压成给模型看的**精简元素清单**。
 *
 * 为什么不直接把 dump 丢给模型：原始控件树每行都带 id / 各类标记 / [x,y]，
 *   又长又像代码，模型很容易把它当成"要输出的内容"照抄进回复。只留
 *   「文字 + 坐标」的人话清单，既够它决定点哪儿，又不会被当成代码复述。
 * 解析不到可点元素时原样返回（宁可难看，也不要让模型完全看不到界面）。
 */
function summarizeUiDumpForModel(dumpText) {
    const text = String(dumpText || '');
    const nodes = parseUiNodes(text);
    if (!nodes.length) return text;
    const out = ['当前界面可操作元素（括号里是可直接点击的屏幕坐标）：'];
    const limit = Math.min(nodes.length, 40);
    for (let i = 0; i < limit; i++) {
        const n = nodes[i];
        out.push('- ' + (n.label || n.id || '控件') + ' (' + n.x + ',' + n.y + ')' + (n.id ? ' id=' + n.id : ''));
    }
    if (nodes.length > limit) {
        out.push('…还有 ' + (nodes.length - limit) + ' 个没列出（需要时再读一次界面，或用截图看画面）。');
    }
    return out.join('\n');
}

/**
 * 把编号圆点画到截图上，好让视觉模型"看到编号"再回答。
 *
 * 为什么要画：视觉模型不擅长估计像素坐标，但很擅长"第 3 个红点是什么"。
 *   编号到坐标的映射由控件树给出（精确），于是「看图指认」和「按坐标点击」各司其职。
 * 返回新的 dataURL；任何一步失败返回 null，调用方退化成纯文字描述。
 */
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
                // 控件树坐标是屏幕像素，图片可能是 1:1 也可能缩放过 —— 按两者比例换算。
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

/**
 * 手机截图：把「画面」交给视觉模型看，同时给一份「可点元素（编号 → 坐标）」清单。
 *
 * 为什么不是只回一句画面描述：主模型是文本模型，光看转述无法确定点哪儿；
 *   控件树又常被截断、含不可见节点。把"看到什么"与"能点什么（精确坐标）"一起回灌，
 *   既看得懂画面、又点得准 —— 坐标永远来自控件树，不从图片上估像素。
 */
async function describePhoneScreenshot(res, fallbackText) {
    const dataUrl = 'data:' + (res.imageMime || 'image/jpeg') + ';base64,' + res.imageBase64;
    if (res.screenWidth && res.screenHeight) {
        lastScreenSize = { width: Number(res.screenWidth), height: Number(res.screenHeight) };
    }

    // 先摸一次控件树，拿到可点/可输入控件的精确坐标。
    let nodes = [];
    try {
        const dump = await callDeviceQuietly('手机查看界面', '');
        const dumpText = (dump && (dump.text || dump.message)) || '';
        nodes = parseUiNodes(dumpText);
    } catch (err) {
        console.warn('[Agent] 截图前读取控件树失败:', err);
    }
    const nodeList = formatNodeListForModel(nodes);
    const listBlock = nodeList
        ? '\n\n【可点元素（编号 → 控件 / 坐标）】\n' + nodeList
            + '\n（要操作某个控件就用它后面的坐标写 [操作:手机点击 x y]；'
            + '或按 id 用 [操作:手机按键 id:<id>] 直接点。不要把图片上的位置换算成像素。）'
        : '';

    const hasVision = Boolean(
        state.settings.visionEnabled === true
        && String(state.settings.visionBaseUrl || '').trim() && String(state.settings.visionModel || '').trim()
    );
    if (!hasVision) {
        // 没有独立视觉模型：把截图**原样直接交给主模型**看（主模型是多模态时就能真正"看到画面"，
        //   不再是"转成文字"）。若主模型不支持图片，callAI 会自动去掉图片重试并记下这个事实，
        //   之后就不再反复附图片了。
        const modelVerdict = (typeof cachedModelImageVerdict === 'function') ? cachedModelImageVerdict() : null;
        if (state._agentImageUnsupported || modelVerdict === false) {
            return fallbackText + '\n（已实测当前主模型不支持图片，看不到画面；先用下面的可点元素清单操作。）' + listBlock;
        }
        setPendingAgentImage(dataUrl);
        return fallbackText + '\n（已把这张截图直接附给你，请直接看图判断；'
            + '如果收不到图片，说明当前主模型不支持图片，可改用界面清单或配置视觉模型。）' + listBlock;
    }

    try {
        const picture = nodes.length ? ((await annotateScreenshot(dataUrl, nodes)) || dataUrl) : dataUrl;
        const prompt = '这是手机当前屏幕的截图。'
            + (nodes.length ? '图上用红色圆点标了可交互元素的编号（1、2、3…）。' : '')
            + '请简短回答：1) 这是什么应用、什么页面；'
            + '2) 屏幕上主要有哪些文字和按钮；'
            + '3) 有没有明显的输入框或弹窗。'
            + (nodes.length ? '不要逐个复述编号，只说你确实看到的。' : '')
            + '只描述你真实看到的，不要编造。';
        const described = await describeImageWithVision(prompt, picture);
        const visual = described && described.trim() ? described.trim() : '';
        if (!visual) return fallbackText + listBlock;
        return fallbackText + '\n\n【画面内容】\n' + visual + listBlock;
    } catch (err) {
        const reason = String(err?.message || err || '');
        console.error('[Agent] 手机截图转述失败:', err);
        return fallbackText + '\n（截图拿到了，但视觉模型没能看：' + reason.slice(0, 200) + '）' + listBlock;
    }
}

/**
 * 坐标是否明显超出屏幕（只在"已经截过图、知道屏幕尺寸"时才判断）。
 * 越界坐标派发出去只会失败或点空，模型还会当成"完成" —— 提前拦下并让它重读界面更省事。
 * 返回空串表示没问题。
 */
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

async function runAgentPhoneOperation(raw, traceItem) {
    const rt = window.agentRuntime;
    // 这个函数也可能经 ElainaOps.invoke → runToolCalls 被调用（工具通道），
    //   而那里写作 `await invoke(...) || { ok:false, text:'没有返回结果' }`。
    //   所以**每一条提前退出都必须带返回值** —— 否则"手机操作没启用"这类
    //   明确原因会被模型读成一句无从下手的"没有返回结果"。
    if (!rt) {
        const m = '手机操作不可用：Agent 运行时没有初始化。';
        insertAgentResult(m);
        return { ok: false, text: m };
    }
    const parsed = parsePhoneOperation(raw);
    if (!parsed) {
        const m = '无法识别的手机操作：' + String(raw || '').trim()
            + '\n可用写法：手机状态 / 手机查看界面 / 手机截图 / 手机点击 x y / 手机滑动 x1 y1 x2 y2 [时长] / '
            + '手机输入 文字 / 手机按键 返回|主页|回车 / 手机打开 包名 / 手机等待 毫秒 / '
            + '手机应用列表 / 手机通知 / 手机设备信息 / 手机短信 [条数] / 手机通讯录 [关键词] / 手机日历 [天数] / '
            + '手机列出文件 [路径] / 手机读文件 路径 / 手机写文件 路径|内容 / 手机删除文件 路径';
        insertAgentResult(m);
        return { ok: false, text: m };
    }
    // 隐私开关：关掉的读取类操作在这里就被拦住，且给出能照做的提示。
    //   这是第二道闸（第一道是提示词里不注入这个能力）——
    //   因为模型可能从历史对话或用户的话里"猜到"标签名，光靠提示词不注入不够。
    const blocked = phoneReadBlockedReason(parsed.action);
    if (blocked) {
        insertAgentResult(blocked);
        return { ok: false, text: blocked };
    }
    // 总开关关掉时直接拒绝（设置 → 能力 → 手机操作）。
    // 放在探测之前：开关关着就不必去 ping 原生，而且这个理由对用户最直接。
    if (state.settings.agentPhoneEnabled === false) {
        const m = '已跳过：手机操作总开关是关闭的。需要时请在 设置 → 能力 → 手机操作 里打开「允许 AI 操作手机」。';
        insertAgentResult(m);
        return { ok: false, text: m };
    }
    // 「手机命令」已经彻底没有实现，两种方式都做不到 —— 在探测之前就拒绝。
    // 为什么不让它走到底再失败：无障碍不执行命令、模块 0.8.x 删掉了 /api/shell，
    // 这条路已经不存在了。放行的话会先探测、再选运行方式（可能弹一次窗问用户
    // 前台还是后台）、最后才回一句失败 —— 用户白点一次弹窗，还得自己猜原因。
    if (parsed.action === '手机命令') {
        const m = '「手机命令」已经不可用：无障碍方式不执行任意命令，'
            + '而「模块」方式在新版里移除了 shell 直通端点（/api/shell），没有等价替代。\n'
            + '需要操作手机可以用「手机打开 / 手机点击 / 手机滑动 / 手机输入 / 手机按键」；'
            + '确实要跑系统命令的话，得换到电脑端。';
        insertAgentResult(m);
        return { ok: false, text: m };
    }
    // 没有任何可用的实现方式 → 手机操作不可用（与「设置 → 能力 → 手机操作」里的提示一致）。
    // 运行方式弹窗：判据是"**有没有一条路能用**"，而不是"设置里有没有选过"。
    //   不能看 currentBackendId() —— 那会把"还没设默认方式"的用户挡在**弹窗之前**，
    //   而弹窗机制恰恰是为这种状态准备的（两路都就绪时问用户走前台还是后台）。
    //   缓存说"没有可用方式"时真探一次：用户可能刚在系统里把无障碍/模块配好，
    //   而缓存还停在旧结果。只在疑似不可用时才探，不会每步都探测。
    let anyReady = AGENT_BACKENDS.some((b) => backendStatus[b.id] && backendStatus[b.id].state === 'ready');
    if (!anyReady) {
        await refreshBackendStatus();
        anyReady = AGENT_BACKENDS.some((b) => backendStatus[b.id] && backendStatus[b.id].state === 'ready');
    }
    if (!anyReady) {
        const m = '已跳过：这台设备上没有任何可用的实现方式，AI 现在不能操作手机。'
            + '请到「设置 → 能力 → 手机操作」点「选择实现方式」配置一种（无障碍门槛最低）。';
        insertAgentResult(m);
        return { ok: false, text: m };
    }
    // 本批次已被用户停止：不再执行任何动作。这是「停止」能拦住后续步骤的关键——
    // 否则每一步都会重新 beginRun 把停止标志清掉，等于没停。
    if (rt.isHalted && rt.isHalted()) {
        const m = '已停止：用户中止了本次操作，这一步（' + parsed.action + '）没有执行。';
        insertAgentResult(m);
        return { ok: false, text: m };
    }
    // 运行方式：两路都可用时，本轮第一次"要动屏幕"的操作先问用户一次
    //   （见 runModeDecision 的说明）。只有一条路可用时直接用它，不弹窗。
    if (phoneActionNeedsScreen(parsed.action)) {
        if (!runModeDecision) {
            const picked = await pickPhoneRunMode();
            if (picked === 'none') {
                // 两条路都不就绪 —— 不在这里报错，交给上面那道"没有任何可用方式"的闸去引导
                // （这里保留空分支是刻意的：不把 runModeDecision 写死，下一轮换了设备/配置还会重问）
            } else if (picked) {
                runModeDecision = picked;
                // 顺手记成默认方式：设置页的「实现方式」照旧可以随时改，下次以它为准
                state.settings.agentBackend = picked;
                persistSettings();
            } else {
                runModeDecision = 'cancelled';
            }
        }
        if (runModeDecision === 'cancelled') {
            const m = '已跳过「' + parsed.action + '」：你没有选择运行方式（前台 / 后台）。'
                + '要我做的话跟我说一声，我会再问一次。';
            insertAgentResult(m, { continueLoop: false });
            return { ok: false, text: m };
        }
    }
    // 坐标越界就提前拦下：派发出去只会失败或点空，模型还会当成"完成"。
    const coordProblem = phoneCoordsOutOfScreen(parsed);
    if (coordProblem) {
        insertAgentResult(coordProblem);
        return { ok: false, text: coordProblem };
    }
    phoneOpsInFlight += 1;
    clearTimeout(phoneRunEndTimer);
    if (!rt.isRunning()) {
        rt.beginRun();
        // 这一步是"不用切回应用就能停"的关键：操作开始时把系统悬浮窗显示出来。
        // 它浮在目标 App 之上，用户在当前界面就能看到进度、随时点停止。
        // 这一步**不阻塞**：拿不到权限只是少了个便利，操作照常进行（回退到应用内确认）。
        if (rt.showOverlay) {
            void rt.showOverlay('AI 正在操作手机').then(async (ok) => {
                if (ok !== 'need-permission') return;
                // 没有权限 → 主动引导去开，而不是只在对话里写一句话。
                // 之前只 insertAgentResult 一句提示，结果是：用户要自己在设置里找到
                // 「手机操作」、再点「开启悬浮窗」、再跳系统设置 —— 三步都不在眼前，
                // 于是实际表现就是"应用从不主动请求悬浮窗权限"。
                // 这里改成：弹一个确认框，用户点「去开启」就直接跳系统设置页。
                // 只问一次：用户明确拒绝过就别每次都拦（那会变成新的打扰）。
                // 但**跳去授权后回来**要允许再问 —— 因为那时他可能还没开成功。
                if (overlayPromptDeclined) return;
                const go = await showCustomModal({
                    title: '需要悬浮窗权限',
                    message: 'AI 正在操作手机。\n\n'
                        + '没有悬浮窗权限时，每一步确认都要你切回本应用来点 ——\n'
                        + '而切回来会让被操作的应用退到后台，那一步操作就可能失败，\n'
                        + 'AI 只能重试，看起来像卡住了。\n\n'
                        + '开了之后屏幕上会浮一个小条：随时点停止、需要确认时就地允许，\n'
                        + '全程不用切回本应用。\n\n'
                        + '现在去系统设置里打开「显示在其他应用上层」？',
                    confirmText: '去开启',
                    cancelText: '这次不用',
                }).catch(() => false);
                if (go) {
                    await enableOverlay({ quiet: true });   // 跳系统设置（quiet：不叠说明框）
                } else {
                    overlayPromptDeclined = true;
                }
            });
        }
    }
    try {
        rt.assertNotStopped();
        rt.setStep(rt.getStep() + 1, parsed.action);
        // 过程记录：把这一步记进回合过程区（对话里那条可折叠的"工具调用行"）。
        // 记的是**用户能看懂的事实**：做了什么、参数是什么、结果如何。
        // 这些记录与思考开关无关 —— 关掉思考也照样显示。
        // 复用外层的行（工具通道已经记过「调用 phone_action」）：同一个动作记两行
        // 会让用户以为做了两件事，与 doAgentFile 的处理保持一致。
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
        // 手机操作**不弹确认** —— 手机不做确认、全部放行
        //   （理由：无障碍方式破坏力有限）。模块后端（KernelSU / root）的
        //   「手机命令」风险由设置页那段免责声明承担，而不是靠弹窗。
        //   详见 phoneTierAllows 的说明。
        //   这里保留 phoneTierAllows 这个判据（而不是直接执行）：
        //   它是**唯一**的放行策略落点，将来若要给模块单独加闸，
        //   只改那个函数即可，不必动这条调用链。
        if (!phoneTierAllows(parsed.action)) {
            const allowed = await rt.requestApproval(parsed.action, describePhoneOperation(parsed), { forceAsk: true });
            if (!allowed) {
                updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许这一步' });
                // 同上：用户刚亲手拒绝过，这一步的结论他已经知道了，只进过程区。
                insertAgentResult('已跳过「' + parsed.action + '」：用户没有允许这一步。请换一种方式，或先向用户说明为什么要这么做。', { asContext: true });
                // 必须有返回值（同样经 invoke → runToolCalls，裸 return 会变成"没有返回结果"）
                return { ok: false, text: '用户没有允许这一步：' + parsed.action };
            }
        }
        rt.assertNotStopped();
        // 这一步真的执行了 → 让 AI 接着决定下一步（见 insertAgentResult 的说明）
        const fullResult = await execPhoneOperation(parsed);
        // 没配视觉模型时，读界面也顺手把当前画面截给主模型看（主模型多模态就能直接看图）。
        if (parsed.action === '手机查看界面' && !phoneVisionModelConfigured() && !state._agentImageUnsupported
            && (typeof cachedModelImageVerdict !== 'function' || cachedModelImageVerdict() !== false)) {
            await maybeStashScreenImage();
        }
        updateTurnTool(traceItem, { state: 'ok', result: fullResult });
        // 读界面给模型 / 上下文的是**精简元素清单**，不是原始控件树 —— 原始控件树又长又像代码，
        //   模型会照抄进回复。过程区仍保留完整原文，需要时用户自己展开看。
        const opResult = parsed.action === '手机查看界面' ? summarizeUiDumpForModel(fullResult) : fullResult;
        // 工具通道的结果由 runToolCalls 以 role:'tool' 回灌，这里再插一条就是重复
        if (ownTrace) insertAgentResult(opResult, { continueLoop: true, asContext: true });
        // 必须返回结果对象：成功路径没有返回值的话，工具通道会读成
        //   「没有返回结果」，把**执行成功**的手机操作报成失败。
        return { ok: true, text: String(opResult || '') };
    } catch (err) {
        // 异常路径同样要给返回值：这条函数是经 ElainaOps.invoke → runToolCalls 调的，
        //   没有返回值就等于模型收到「没有返回结果」，连"为什么失败"都看不到。
        const reason = (err && err.message) || String(err);
        if (err && err.agentAborted) {
            // 用户自己按的停止 —— 他知道发生了中止，不必再占一条气泡。
            insertAgentResult('已停止：用户中止了操作，剩余步骤没有执行。', { asContext: true });
            return { ok: false, text: '用户中止了手机操作' };
        }
        // 失败必须留在可见处：这是用户**不知道**的事，不能只藏在可折叠的过程区里。
        insertAgentResult('手机操作失败：' + reason);
        return { ok: false, text: '手机操作失败：' + reason };
    } finally {
        phoneOpsInFlight -= 1;
        if (phoneOpsInFlight <= 0) {
            clearTimeout(phoneRunEndTimer);
            // 一批操作处理完再收起状态条；若紧接着又来新操作会重新计时
            phoneRunEndTimer = setTimeout(() => {
                // 这一批做完**不等于整轮结束** —— 续跑马上要发起下一次
                //   模型调用。管道还忙时不只不收浮层，**状态条也不 endRun**：
                //   否则"正在思考下一步"那几秒状态条与浮层会一起消失，用户以为软件坏了。
                if (agentPipelineBusy()) return;
                rt.endRun();
                scheduleOverlayHide();
            }, 600);
        }
    }
}



