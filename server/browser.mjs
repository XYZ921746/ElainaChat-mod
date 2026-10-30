// 浏览器工具：让 AI 真的打开一个浏览器、看页面、点东西、填表单。
// ── 这个模块解决什么 ────────────────────────────────────────────────────
// 用户要求：「AI 使用浏览器的功能」。和「电脑命令」不是一回事 ——
//   命令通道是**文本进、文本出**：AI 看不到页面长什么样，只能靠 `curl` 猜，
//   而且对需要登录态、JS 渲染、点开菜单才出现的页面完全无能为力。
//   浏览器通道是**看页面 → 决定 → 真点一下**，这才是"用浏览器"。
// ── 为什么用 CDP（Chrome DevTools Protocol）而不是别的 ──────────────────
//   · 不需要 npm 依赖（项目硬约束：零依赖、免构建），puppeteer/playwright 都是重依赖；
//   · 不需要额外装浏览器 —— 用户机器上大概率已经有 Chrome/Edge，
//     而 CDP 就是它们自带的一个调试口，加个命令行参数就能开；
//   · 无头模式也能跑，但有头模式让用户**看得见** AI 在点什么（这个项目的
//     "AI 到底动了什么"一贯要求可见，见 recordTurnTool 那套）。
// ── 安全边界（三条，缺一不可）──────────────────────────────────────────
//   ① **只本机**：调试端口一旦暴露到局域网，等于把这台机器上所有浏览器的
//      会话 cookie 交出去（CDP 能读 cookie、能执行任意 JS）。所以：
//      · 浏览器只用 `--remote-debugging-port=0`（内核分配端口）+ 绑定 127.0.0.1；
//      · HTTP 侧调用方必须再判一次 isLocalRequest（见 serve.mjs 的路由）。
//   ② **独立 profile**：绝不接用户正在用的那个浏览器（`--user-data-dir` 指向
//      临时目录）。接上去既会污染用户的书签/登录态，也会因为"用户正在用"
//      导致启动失败。代价是**没有用户的登录态** —— 这是刻意的取舍：
//      要登录的站点得由用户在面板里自己登（见下文的"有头模式"）。
//   ③ **URL 协议白名单**：只允许 http/https，挡掉 file://（读本地文件）、
//      chrome://（改浏览器设置）、devtools://、以及 `javascript:` 伪协议。
// ── 生命周期 ───────────────────────────────────────────────────────────
//   浏览器**按需启动、空闲即关**（IDLE_CLOSE_MS）。理由：常驻一个无头 Chrome
//   在用户机器上跑着，既吃内存又让人不安（"我没开浏览器啊"）。
//   关闭由定时器驱动，每次操作会重置计时。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectWebSocket } from './ws-client.mjs';

/** 空闲多久自动关掉浏览器（毫秒）。 */
export const IDLE_CLOSE_MS = 5 * 60 * 1000;

/** 单个 CDP 命令的默认超时。页面导航会慢一些，单独给更长的值。 */
const CDP_TIMEOUT = 15000;
const NAV_TIMEOUT = 30000;

/** 只允许这两种协议（见文件头 ③）。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** 页面快照里最多返回多少个可交互元素 —— 太多会把提示词撑爆，模型也读不完。 */
export const MAX_SNAPSHOT_ITEMS = 120;

/**
 * 常见安装位置。**顺序有意义**：Chrome 优先（CDP 行为最标准），
 *   Edge 次之（Windows 自带，覆盖率最高）。
 * 环境变量 ELAINA_BROWSER 可覆盖（用户把浏览器装在非标准位置时用）。
 */
export function browserCandidates() {
    const env = String(process.env.ELAINA_BROWSER || '').trim();
    if (env) return [env];
    if (process.platform === 'win32') {
        const pf = process.env.ProgramFiles || 'C:\\Program Files';
        const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const local = process.env.LOCALAPPDATA || '';
        return [
            path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
            path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ].filter(Boolean);
    }
    if (process.platform === 'darwin') {
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ];
    }
    return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
}

/** 找到第一个存在的浏览器可执行文件；找不到返回空串。 */
export function findBrowserExecutable() {
    for (const p of browserCandidates()) {
        try { if (existsSync(p)) return p; } catch { /* 权限不足就当没有 */ }
    }
    return '';
}

/**
 * 校验一个要导航过去的地址。
 *
 * 只认 http/https：其余协议在这个能力里没有正当用途，而每一个都有明确的危害
 *   （file:// 读本地文件、chrome:// 改浏览器设置、javascript: 在当前页执行任意代码）。
 * 也顺手挡掉带换行的输入 —— 那是在试探命令行注入。
 *
 * @returns {{ok:true, url:string} | {ok:false, reason:string}}
 */
export function normalizeNavigationUrl(raw) {
    const text = String(raw || '').trim();
    if (!text) return { ok: false, reason: '没有给出网址' };
    if (/[\r\n\u0000]/.test(text)) return { ok: false, reason: '网址里不能有换行或空字符' };
    let url;
    try { url = new URL(text); } catch { return { ok: false, reason: '网址格式不正确：' + text }; }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        return { ok: false, reason: '只允许 http / https 网址（当前是 ' + url.protocol + '）' };
    }
    return { ok: true, url: url.toString() };
}

/**
 * 页面快照用的注入脚本。
 *
 * 为什么要在**页面里**跑这段而不是用 CDP 的 DOM 域：DOM 域给的是节点树，
 *   要自己算可见性、自己拼文本，几百行且容易出错；这里直接在页面上下文里
 *   用 getBoundingClientRect + innerText，语义与用户看到的完全一致。
 *
 * 给每个可交互元素打上 `data-elaina-ref`：模型拿到的是 "ref: 3"，
 *   点的时候按 ref 找回元素 —— 比让模型算坐标可靠得多（坐标会随滚动、
 *   响应式布局变化，而 ref 不会）。
 */
const SNAPSHOT_SCRIPT = `(() => {
  const MAX_ITEMS = __MAX_ITEMS__;
  const SEL = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],[onclick]';
  const items = [];
  let n = 0;
  const seen = new Set();
  for (const el of document.querySelectorAll(SEL)) {
    if (items.length >= MAX_ITEMS) break;
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    const ref = String(++n);
    el.setAttribute('data-elaina-ref', ref);
    // 输入框的"名字"优先取 placeholder / aria-label，**不取 value** ——
    //   value 是"已经填了什么"，模型改一个字之后标签就会跟着变，再问"第几个输入框"
    //   就对不上了。两者分开给（text 是名字、value 是当前内容）。
    const isField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    const nameSource = isField
      ? (el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('title') || '')
      : (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '');
    const label = String(nameSource).replace(/\\s+/g, ' ').trim().slice(0, 60);
    items.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      text: label,
      // 输入框里**已经填了什么**必须一起给：模型打完字之后要能确认自己填对了没有，
      //   而 innerText 不包含 input 的值 —— 只看它的话"我输入成功了吗"永远无法自查。
      value: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? String(el.value || '').slice(0, 120) : '',
      disabled: Boolean(el.disabled),
    });
  }
  const bodyText = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return {
    url: location.href,
    title: document.title,
    text: bodyText.slice(0, __MAX_TEXT__),
    truncated: bodyText.length > __MAX_TEXT__,
    items,
  };
})()`;

/** 把快照脚本按当前上限拼出来（上限变了不用改模板） */
function snapshotExpression(maxItems = MAX_SNAPSHOT_ITEMS, maxText = 4000) {
    return SNAPSHOT_SCRIPT
        .replace('__MAX_ITEMS__', String(maxItems))
        .replace(/__MAX_TEXT__/g, String(maxText));
}

/**
 * 拼出启动浏览器的命令行参数。
 * 端口交给内核分配（再读 profile 里的 DevToolsActivePort），profile 指向独立
 *   临时目录：既不会撞上用户自己开着的调试实例，也不碰用户正在用的浏览器。
 */
function browserLaunchArgs(profileDir, headless) {
    return [
        // =0 让内核分配端口，写死端口会撞上用户自己开着的调试实例。
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        '--user-data-dir=' + profileDir,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-features=Translate,MediaRouter',
        '--disable-gpu',
        '--window-size=1280,900',
        ...(headless === false ? [] : ['--headless=new']),
        'about:blank',
    ];
}

/** DevToolsActivePort 的第一行是端口；文件还没写出来（或为空）当作 0。 */
function parseDevToolsActivePort(text) {
    return Number(String(text).split('\n')[0].trim()) || 0;
}

/**
 * 把一条 CDP 消息解析成响应用得上的三样：配对 id、错误文本、结果。
 * 事件没有 id（不参与配对），非法消息返回 null，调用方据此忽略。
 */
function parseCdpMessage(msg) {
    if (!msg || typeof msg !== 'object' || !msg.id) return null;
    return {
        id: msg.id,
        error: msg.error ? String(msg.error.message || '浏览器命令失败') : '',
        result: msg.result,
    };
}

/**
 * Runtime.evaluate 的响应只有两种结局：脚本抛错（给出可直接抛出的文案），
 *   或正常返回值。exceptionDetails 存在时 result 不可信，所以先判它。
 */
function parseEvaluation(res) {
    if (res && res.exceptionDetails) {
        return { error: '页面脚本出错：' + String(res.exceptionDetails.text || '未知') };
    }
    return { value: res && res.result ? res.result.value : undefined };
}

/**
 * 浏览器会话：启动 / 关掉 / 执行 CDP 命令 / 页面操作。
 *
 * 状态全在闭包里，对外只有几个方法 —— 服务端路由只需要 `createBrowserSession()`
 *   一次，然后调 `ensure()` / `goto()` 这些。
 */
export function createBrowserSession(options = {}) {
    const idleMs = Number.isFinite(options.idleCloseMs) ? options.idleCloseMs : IDLE_CLOSE_MS;
    const log = typeof options.log === 'function' ? options.log : () => {};

    let child = null;
    let profileDir = '';
    let httpBase = '';
    let targetId = '';
    let ws = null;
    /** 浏览器级连接（只用于 Browser.close —— 页面级连接关不掉整个浏览器） */
    let browserWs = null;
    let msgId = 0;
    const pending = new Map();
    let idleTimer = null;
    let starting = null;

    function touchIdle() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { void close(); }, idleMs);
        if (idleTimer.unref) idleTimer.unref();
    }

    function rejectAll(reason) {
        for (const [, entry] of pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(reason));
        }
        pending.clear();
    }

    /** 发一条 CDP 命令并等它的响应（按 id 配对）。 */
    function send(method, params = {}, timeoutMs = CDP_TIMEOUT) {
        if (!ws) return Promise.reject(new Error('浏览器没有连上（可能已被关闭）'));
        const id = ++msgId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('浏览器命令超时：' + method));
            }, timeoutMs);
            if (timer.unref) timer.unref();
            pending.set(id, { resolve, reject, timer });
            ws.send({ id, method, params });
        });
    }

    /** 从 /json/version 拿调试入口；浏览器刚起来时这个端口要等一会儿才可用。 */
    async function waitForEndpoint(port, deadline) {
        const url = 'http://127.0.0.1:' + port + '/json/version';
        for (;;) {
            try {
                const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
                if (res.ok) {
                    const info = await res.json();
                    return String(info.webSocketDebuggerUrl || '');
                }
            } catch { /* 还没起来 */ }
            if (Date.now() > deadline) throw new Error('浏览器启动超时（调试端口没有响应）');
            await new Promise((r) => setTimeout(r, 120));
        }
    }

    /**
     * 确保浏览器在跑，并返回一个可用的页面 target。
     *
     * 并发调用要合并：两个工具调用同时到达时不能起两个浏览器
     *   （第二个会因 profile 目录被占用而失败，报错还很难懂）。
     */
    function ensure() {
        if (ws) { touchIdle(); return Promise.resolve(); }
        if (starting) return starting;
        starting = (async () => {
            const exe = findBrowserExecutable();
            if (!exe) {
                throw new Error('没有找到 Chrome / Edge。装一个，或把浏览器路径写进环境变量 ELAINA_BROWSER。');
            }
            profileDir = await mkdtemp(path.join(os.tmpdir(), 'elaina-browser-'));
            child = spawn(exe, browserLaunchArgs(profileDir, options.headless), { stdio: 'ignore', windowsHide: true });
            // ⚠️ 不要监听 child 的 'exit' 来判定"浏览器死了"。
            //   在 Windows 上 Chrome 的**启动器进程**把活交给真正的浏览器进程后
            //   自己立刻退出（实测 ~230ms），而浏览器仍在跑。把这个正常的进程交接
            //   当成崩溃，会让刚连上的 ws 被清空 —— 现象是"浏览器启动了、命令全报
            //   '浏览器没有连上'"，而日志里写着"浏览器已启动"。
            //   真正的存活判据是 **ws 连接**（见下面 onClose），它断开才是真没了。
            const deadline = Date.now() + 20000;
            // DevToolsActivePort：第一行端口，第二行 ws 路径（Chrome 系通用）
            let port = 0;
            for (;;) {
                try {
                    const txt = await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8');
                    port = parseDevToolsActivePort(txt);
                    if (port) break;
                } catch { /* 文件还没写出来 */ }
                if (Date.now() > deadline) throw new Error('浏览器启动超时（DevToolsActivePort 没有出现）');
                await new Promise((r) => setTimeout(r, 120));
            }
            httpBase = 'http://127.0.0.1:' + port;
            const browserWsUrl = await waitForEndpoint(port, deadline);
            if (!browserWsUrl) throw new Error('浏览器没有给出调试地址');

            // 新建一个空白页并连它的 target —— 直接连 browser target 要自己管
            // attach 会话，多一层状态；连页面 target 简单得多。
            const created = await fetch(httpBase + '/json/new?about:blank', { method: 'PUT' });
            if (!created.ok) throw new Error('新建标签页失败（HTTP ' + created.status + '）');
            const target = await created.json();
            targetId = String(target.id || '');
            // 另开一条**浏览器级**连接：关浏览器要走 Browser.close。
            //   直接 kill 启动器进程在 Windows 上不可靠（它可能已经退出了，
            //   而浏览器本体是它派生出来的、不在我们手里）。
            browserWs = await connectWebSocket(browserWsUrl, { timeoutMs: 8000 });
            browserWs.onClose(() => { browserWs = null; });
            ws = await connectWebSocket(String(target.webSocketDebuggerUrl));
            ws.onMessage((msg) => {
                const parsed = parseCdpMessage(msg);
                if (!parsed) return;      // 事件（无 id）不在这里处理
                const entry = pending.get(parsed.id);
                if (!entry) return;
                pending.delete(parsed.id);
                clearTimeout(entry.timer);
                if (parsed.error) entry.reject(new Error(parsed.error));
                else entry.resolve(parsed.result);
            });
            ws.onClose(() => { ws = null; rejectAll('浏览器连接已断开'); });
            await send('Page.enable');
            await send('Runtime.enable');
            log('浏览器已启动（端口 ' + port + '）');
            touchIdle();
        })().catch((err) => {
            starting = null;
            void close();
            throw err;
        }).then(() => { starting = null; });
        return starting;
    }

    async function close() {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        // 先请浏览器自己退出（Browser.close 会走正常关闭流程，profile 才能被清干净）；
        //   它不响应再退回到杀进程。
        if (browserWs) {
            try {
                browserWs.send({ id: ++msgId, method: 'Browser.close', params: {} });
                await new Promise((r) => setTimeout(r, 300));
            } catch { /* 已经断了 */ }
            try { browserWs.close(); } catch { /* 已断 */ }
            browserWs = null;
        }
        try { if (ws) ws.close(); } catch { /* 已断 */ }
        ws = null;
        rejectAll('浏览器已关闭');
        if (child) {
            try { child.kill(); } catch { /* 已退 */ }
            child = null;
        }
        // 关掉标签页留下的 profile 目录：里面有这个会话的全部 cookie，
        // 留在临时目录里既占空间又是个不必要的痕迹。
        if (profileDir) {
            const dir = profileDir;
            profileDir = '';
            try { await rm(dir, { recursive: true, force: true }); } catch { /* 被占用就算了 */ }
        }
        httpBase = '';
        targetId = '';
    }

    /** 在页面里求值，返回它的值（returnByValue）。 */
    async function evaluate(expression) {
        const res = await send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true,      // 让 click() 之类的调用被当作真实用户手势
        });
        const outcome = parseEvaluation(res);
        if (outcome.error) throw new Error(outcome.error);
        return outcome.value;
    }

    /** 导航到一个 http(s) 地址，等 load 事件（或超时后照常返回）。 */
    async function goto(rawUrl) {
        await ensure();   // 各动作自带 ensure：调用方忘了先开浏览器也不会拿到一句"没连上"
        const checked = normalizeNavigationUrl(rawUrl);
        if (!checked.ok) throw new Error(checked.reason);
        const nav = await send('Page.navigate', { url: checked.url }, NAV_TIMEOUT);
        if (nav && nav.errorText) throw new Error('打不开这个网址：' + nav.errorText);
        // 等 load：Page.navigate 只保证"开始导航"，不等资源加载完。
        //   不等的话紧接着的快照会拍到半截页面（白屏或骨架屏），
        //   模型据此判断就会做出错误决定。
        await waitForLoad(NAV_TIMEOUT);
        return checked.url;
    }

    function waitForLoad(timeoutMs) {
        return new Promise((resolve) => {
            if (!ws) { resolve(); return; }
            let done = false;
            const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
            const timer = setTimeout(finish, timeoutMs);
            if (timer.unref) timer.unref();
            // 用一个短轮询代替 Page.loadEventFired 事件订阅：
            //   事件订阅需要改 onMessage 的分发逻辑（现在只处理带 id 的响应），
            //   而 readyState 本来就直接反映"加载完了没有"。
            const poll = async () => {
                if (done) return;
                try {
                    const state = await evaluate('document.readyState');
                    if (state === 'complete' || state === 'interactive') { finish(); return; }
                } catch { /* 导航中上下文会短暂失效，继续等 */ }
                if (!done) setTimeout(poll, 120).unref?.();
            };
            void poll();
        });
    }

    /** 页面快照：标题 / 正文 / 可交互元素（带 ref）。 */
    async function snapshot(opts = {}) {
        await ensure();
        const value = await evaluate(snapshotExpression(opts.maxItems, opts.maxText));
        if (!value || typeof value !== 'object') throw new Error('页面快照失败');
        return value;
    }

    /**
     * 按 ref 找回页面元素并聚焦/滚动到它。
     *
     * 为什么按属性**扫描**而不是拼选择器：ref 是我们自己写的数字，但拼进
     *   `[data-elaina-ref="…"]` 时要经过 CSS 转义 —— `CSS.escape("3")` 返回
     *   `\33 `（数字必须转义），语义上仍然等于 "3"，可读性却全没了，
     *   而且换个浏览器实现就未必一致。直接遍历带这个属性的元素最稳。
     */
    function findByRef(ref, body) {
        const target = JSON.stringify(String(ref));
        return evaluate(`(() => {
          const want = ${target};
          const el = Array.from(document.querySelectorAll('[data-elaina-ref]'))
            .find((n) => n.getAttribute('data-elaina-ref') === want);
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          return (${body})(el);
        })()`);
    }

    /** 按 ref 真点一下。用 CDP 的输入事件而不是 el.click() —— 后者不触发 mousedown 之类的前置逻辑 */
    async function clickRef(ref) {
        await ensure();
        const box = await findByRef(ref, '(el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }');
        if (!box) throw new Error('页面上找不到编号 ' + ref + ' 的元素（可能页面已经变了，请重新看一次页面）');
        for (const type of ['mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
        }
        return box;
    }

    /** 按 ref 往输入框里打字（先聚焦，再 insertText —— 逐字符敲太慢且中文打不出来） */
    async function typeIntoRef(ref, text) {
        await ensure();
        const ok = await findByRef(ref, '(el) => { el.focus(); return true; }');
        if (!ok) throw new Error('页面上找不到编号 ' + ref + ' 的输入框（可能页面已经变了，请重新看一次页面）');
        await send('Input.insertText', { text: String(text ?? '') });
        return true;
    }

    /** 按回车（提交搜索框、确认对话框） */
    async function pressEnter() {
        await ensure();
        for (const type of ['keyDown', 'keyUp']) {
            await send('Input.dispatchKeyEvent', {
                type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
            });
        }
    }

    /** 截图（PNG base64）。给"看得见"的那条路用：把画面交给视觉模型转述。 */
    async function screenshot() {
        await ensure();
        const res = await send('Page.captureScreenshot', { format: 'png' }, NAV_TIMEOUT);
        return String(res && res.data || '');
    }

    return {
        ensure, close, goto, snapshot, clickRef, typeIntoRef, pressEnter, screenshot, evaluate,
        /** 当前是否在跑（给路由做状态展示用）。判据是连接，不是进程 —— 见 ensure 里的说明 */
        isRunning: () => Boolean(ws),
    };
}

/**
 * 把快照整理成回灌给 AI 的一段话。
 *
 * 为什么在服务端拼而不是让前端拼：两条通道（工具调用 / 标签降级）最终都拿到
 *   同一个字符串，形状一致才不会出现"工具通道看到的东西和标签通道不一样"。
 */
export function formatSnapshot(snap) {
    const lines = [];
    lines.push('当前页面：' + (snap.title || '（无标题）'));
    lines.push('网址：' + snap.url);
    if (snap.items && snap.items.length) {
        lines.push('', '可交互元素（点它 / 往里打字时用编号）：');
        for (const it of snap.items) {
            const kind = it.tag === 'input' || it.tag === 'textarea' ? '输入框'
                : it.tag === 'select' ? '下拉框'
                    : it.tag === 'a' ? '链接' : '按钮';
            const type = it.type ? '/' + it.type : '';
            const dis = it.disabled ? '（不可用）' : '';
            const filled = it.value ? '（当前内容：' + it.value + '）' : '';
            lines.push('  [' + it.ref + '] ' + kind + type + dis + '：' + (it.text || '（没有文字）') + filled);
        }
    } else {
        lines.push('', '这个页面上没有找到可点的东西。');
    }
    if (snap.text) {
        lines.push('', '正文（截取）：', snap.text);
        if (snap.truncated) lines.push('…（正文更长，已截断）');
    }
    return lines.join('\n');
}

/**
 * 把一次「浏览器操作」的请求派发到会话方法上。
 *
 * 单独抽成函数（而不是写在路由里）的两个理由：
 *   ① 路由只负责鉴权与 JSON 往返，不该知道"open 和 goto 有什么区别"；
 *   ② 这个函数不碰 HTTP，可以用假的 session 穷举断言动作名与参数校验 ——
 *      参数错了要报得清楚（模型靠这句话自我纠正），不能变成一句"操作失败"。
 *
 * @param {object} session createBrowserSession() 的返回值
 * @param {string} action 动作名
 * @param {object} args 参数
 * @returns {Promise<{ok:true, text:string, data?:object} | {ok:false, text:string}>}
 */
export async function runBrowserAction(session, action, args = {}) {
    const name = String(action || '').trim();
    try {
        switch (name) {
        case 'open': {
            await session.ensure();
            return { ok: true, text: '浏览器已打开（当前是空白页）。用 goto 打开一个网址，或用 snapshot 看当前页面。' };
        }
        case 'goto': {
            await session.ensure();
            const url = await session.goto(args.url);
            const snap = await session.snapshot();
            return { ok: true, text: '已打开 ' + url + '\n\n' + formatSnapshot(snap), data: snap };
        }
        case 'snapshot': {
            await session.ensure();
            const snap = await session.snapshot();
            return { ok: true, text: formatSnapshot(snap), data: snap };
        }
        case 'click': {
            await session.ensure();
            const ref = String(args.ref ?? '').trim();
            if (!ref) return { ok: false, text: '要给出要点的那一项的编号（先 snapshot 看一眼页面，编号在方括号里）' };
            await session.clickRef(ref);
            // 点完立刻再拍一次：绝大多数点击都会改变页面，模型必须看到新状态
            //   才能决定下一步 —— 让它自己再调一次 snapshot 只是多一次往返。
            const snap = await session.snapshot();
            return { ok: true, text: '已点击 [' + ref + ']。\n\n' + formatSnapshot(snap), data: snap };
        }
        case 'type': {
            await session.ensure();
            const ref = String(args.ref ?? '').trim();
            if (!ref) return { ok: false, text: '要给出输入框的编号（先 snapshot 看一眼页面）' };
            if (args.text === undefined || args.text === null) return { ok: false, text: '要给出要输入的文字' };
            await session.typeIntoRef(ref, args.text);
            return { ok: true, text: '已在 [' + ref + '] 里输入：' + String(args.text).slice(0, 200) };
        }
        case 'press_enter': {
            await session.ensure();
            await session.pressEnter();
            const snap = await session.snapshot();
            return { ok: true, text: '已按回车。\n\n' + formatSnapshot(snap), data: snap };
        }
        case 'close': {
            await session.close();
            return { ok: true, text: '浏览器已关闭。' };
        }
        default:
            return {
                ok: false,
                text: '不认识的浏览器操作：' + (name || '（空）')
                    + '。可用的是 open / goto / snapshot / click / type / press_enter / close。',
            };
        }
    } catch (err) {
        return { ok: false, text: String((err && err.message) || err || '浏览器操作失败') };
    }
}

export const __test__ = { ALLOWED_PROTOCOLS, snapshotExpression, SNAPSHOT_SCRIPT };
