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

// 无障碍 = 前台（能看见、随时能停），模块 = 后台（副屏静默操作）；两路都可用时本轮第一次「动屏」问一次，取消 = 这一步不做，绝不替用户选。
let runModeDecision = '';   // '' = 本轮还没问过 | 'accessibility' | 'module' | 'cancelled'
// 用户显式选的运行方式：原生必须严格照办，不许自动换路。
let runModeExplicit = false;
let runModePicker = null;   // 进行中的询问 Promise（记忆化，见 pickPhoneRunMode）

function phoneActionNeedsScreen(action) {
    return ['手机查看界面', '手机截图', '手机点击', '手机滑动', '手机输入',
        '手机按键', '手机打开', '手机命令'].includes(action);
}

/** 只有两条路都就绪时才弹窗；返回 'accessibility' | 'module' | 'none' | ''（用户取消）。 */
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
    backendStatus.accessibility = await detectBackend('accessibility');
    backendStatus.module = await detectBackend('module');
    const accReady = backendStatus.accessibility && backendStatus.accessibility.state === 'ready';
    const modReady = backendStatus.module && backendStatus.module.state === 'ready';
    if (!accReady && !modReady) return 'none';
    if (!(accReady && modReady)) return accReady ? 'accessibility' : 'module';
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
// 最近一次操作实际用的后端（原生回报）：只有模块后端有副屏画面，状态条的「看画面」按钮据此显隐。
let lastUsedBackendId = '';
let overlayPromptDeclined = false;



const PHONE_READ_OPS = [
    '手机应用列表', '手机通知', '手机设备信息', '手机通讯录', '手机日历', '手机短信',
];

/** 隐私开关管「能力是否存在」（提示词也不注入），phoneTierAllows 管「要不要问」；不通过时给能照做的提示，不静默失败。 */
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
        args: phoneArgsForNative(parsed),
        // 本轮选定的运行方式优先，没选过才回落默认；它不可用时明确报错，不偷偷换路。
        backend: runModeDecision === 'module' || runModeDecision === 'accessibility'
            ? runModeDecision
            : currentBackendId(),
        strictBackend: runModeExplicit
    });
    let text = (res && (res.text || res.message)) || (parsed.action + ' 完成');
    if (res && res.backend) {
        lastUsedBackendId = String(res.backend);
        window.__lastAgentBackend = lastUsedBackendId;
    }
    // 截图原生以 base64 带回来，转述后回灌主模型 —— 与「图片理解」复用同一条链路。
    if (res && res.imageBase64 && parsed.action === '手机截图') {
        text = await describePhoneScreenshot(res, text);
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

/** 直调原生设备层，不经权限 / 运行方式 / 过程记录 —— 只给「读界面」这类内部辅助用。 */
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

// 控件树一行形如：#3 “发送” id=btn_send 可点 [540,1200]；只取可点 / 可输入的行，容器节点给模型只是噪音。
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

/** 原始控件树又长又像代码，模型会照抄进回复；解析不到可点元素时原样返回，不让模型看不到界面。 */
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

/** 截图交给视觉模型看，另给一份可点元素清单；坐标永远来自控件树，不从图片上估像素。 */
async function describePhoneScreenshot(res, fallbackText) {
    const dataUrl = 'data:' + (res.imageMime || 'image/jpeg') + ';base64,' + res.imageBase64;
    if (res.screenWidth && res.screenHeight) {
        lastScreenSize = { width: Number(res.screenWidth), height: Number(res.screenHeight) };
    }

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
        typeof visionConfigured === 'function'
            ? visionConfigured()
            : state.settings.visionEnabled === true
                && String(state.settings.visionBaseUrl || '').trim() && String(state.settings.visionModel || '').trim()
    );
    if (!hasVision) {
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

async function runAgentPhoneOperation(raw, traceItem) {
    const rt = window.agentRuntime;
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
            + '手机输入 文字 / 手机按键 返回|主页|回车 / 手机打开 包名 / 手机等待 毫秒 / '
            + '手机应用列表 / 手机通知 / 手机设备信息 / 手机短信 [条数] / 手机通讯录 [关键词] / 手机日历 [天数] / '
            + '手机列出文件 [路径] / 手机读文件 路径 / 手机写文件 路径|内容 / 手机删除文件 路径';
        insertAgentResult(m);
        return { ok: false, text: m };
    }
    // 隐私开关的第二道闸（第一道是提示词不注入该能力）：模型可能从历史或用户的话里猜到标签名。
    const blocked = phoneReadBlockedReason(parsed.action);
    if (blocked) {
        insertAgentResult(blocked);
        return { ok: false, text: blocked };
    }
    // 总开关关掉直接拒绝，放在探测之前：不必去 ping 原生，这个理由对用户也最直接。
    if (state.settings.agentPhoneEnabled === false) {
        const m = '已跳过：手机操作总开关是关闭的。需要时请在 设置 → 能力 → 手机操作 里打开「允许 AI 操作手机」。';
        insertAgentResult(m);
        return { ok: false, text: m };
    }
    // 「手机命令」两种方式都做不到，在探测之前就拒绝，否则用户先白点一次运行方式弹窗。
    if (parsed.action === '手机命令') {
        const m = '「手机命令」已经不可用：无障碍方式不执行任意命令，'
            + '而「模块」方式在新版里移除了 shell 直通端点（/api/shell），没有等价替代。\n'
            + '需要操作手机可以用「手机打开 / 手机点击 / 手机滑动 / 手机输入 / 手机按键」；'
            + '确实要跑系统命令的话，得换到电脑端。';
        insertAgentResult(m);
        return { ok: false, text: m };
    }
    // 判据是「有没有一条路能用」，不是设置里有没有选过 —— 看 currentBackendId 会把还没设默认方式的人挡在弹窗外；缓存说没有时真探一次。
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
    // 本批次已被停止就不再执行：否则每一步都重新 beginRun 把停止标志清掉，等于没停。
    if (rt.isHalted && rt.isHalted()) {
        const m = '已停止：用户中止了本次操作，这一步（' + parsed.action + '）没有执行。';
        insertAgentResult(m);
        return { ok: false, text: m };
    }
    if (phoneActionNeedsScreen(parsed.action)) {
        if (!runModeDecision) {
            const picked = await pickPhoneRunMode();
            if (picked === 'none') {
                // 两条路都不就绪：交给上面那道「没有任何可用方式」的闸，不把 runModeDecision 写死。
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
            insertAgentResult(m, { continueLoop: false });
            return { ok: false, text: m };
        }
    }
    const coordProblem = phoneCoordsOutOfScreen(parsed);
    if (coordProblem) {
        insertAgentResult(coordProblem);
        return { ok: false, text: coordProblem };
    }
    phoneOpsInFlight += 1;
    clearTimeout(phoneRunEndTimer);
    if (!rt.isRunning()) {
        rt.beginRun();
        // 悬浮窗浮在目标 App 之上，用户不用切回应用就能停；这一步不阻塞，拿不到权限只是少了便利。
        if (rt.showOverlay) {
            void rt.showOverlay('AI 正在操作手机').then(async (ok) => {
                if (ok !== 'need-permission') return;
                // 授权入口藏得深，不主动引导就等于「应用从不请求悬浮窗权限」；只问一次（拒绝过就不再拦），跳去授权后回来仍可再问。
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
                insertAgentResult('已跳过「' + parsed.action + '」：用户没有允许这一步。请换一种方式，或先向用户说明为什么要这么做。', { asContext: true });
                return { ok: false, text: '用户没有允许这一步：' + parsed.action };
            }
        }
        rt.assertNotStopped();
        const fullResult = await execPhoneOperation(parsed);
        if (parsed.action === '手机查看界面' && !phoneVisionModelConfigured() && !state._agentImageUnsupported
            && (typeof cachedModelImageVerdict !== 'function' || cachedModelImageVerdict() !== false)) {
            await maybeStashScreenImage();
        }
        updateTurnTool(traceItem, { state: 'ok', result: fullResult });
        const opResult = parsed.action === '手机查看界面' ? summarizeUiDumpForModel(fullResult) : fullResult;
        if (ownTrace) insertAgentResult(opResult, { continueLoop: true, asContext: true });
        return { ok: true, text: String(opResult || '') };
    } catch (err) {
        const reason = (err && err.message) || String(err);
        if (err && err.agentAborted) {
            insertAgentResult('已停止：用户中止了操作，剩余步骤没有执行。', { asContext: true });
            return { ok: false, text: '用户中止了手机操作' };
        }
        // 失败是用户不知道的事，必须留在可见处，不能只藏在可折叠的过程区里。
        insertAgentResult('手机操作失败：' + reason);
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
