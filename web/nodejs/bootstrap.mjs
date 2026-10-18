/**
 * 手机端（APK）内嵌 Node 后端的启动骨架。
 *
 * 电脑版是「前端页面 + serve.mjs 服务端」两部分，而 APK 里原来只有前端 ——
 * 这个文件就是服务端那一半在手机上的**起点**：先起来一个只监听回环的 HTTP
 * 服务，把「能不能跑通」这条路走通（启动耗时、体积、端口回传、日志可见性），
 * 之后再把 serve.mjs 的各段逐个搬过来（relay → data 导出 → 日志落盘 →
 * 插件 server 半边）。
 *
 * 由原生插件 ElainaNode 调用，参数：
 *   --data-dir=<应用私有目录>   以后 data/、data/logs/ 都往这里落
 *   --port=<n>                  默认 0 = 让内核挑一个空闲端口
 *
 * 三条与电脑版不同的硬性约束（都很容易踩）：
 *
 *   ① **只绑 127.0.0.1**。安卓上非 root 进程不能监听对外端口，而且就算能，
 *      把服务端暴露到局域网也毫无必要。
 *
 *   ② **端口只能由这里回传**。绑 0 号端口后端口号只有自己知道，
 *      要在监听成功时打一行带前缀的 JSON 出去，由原生侧解析（见
 *      android/app/src/main/cpp/elaina_node_jni.cpp）。
 *      注意必须**打完就刷新**：stdout 被接进了管道，不刷新会一直卡在缓冲里，
 *      表现就是「Node 明明起来了，前端却永远等不到端口」。
 *
 *   ③ **绝不能调 process.exit()**。Node 跑在 App 自己的进程里，
 *      process.exit() 结束的是整个 App，不是"只停服务端"。
 *      要停就关掉 server 让事件循环自然空掉，node::Start 随之返回。
 *
 *   ④ **进任何路由之前先校验 Origin**（只认 https://localhost，见 ALLOWED_ORIGIN）。
 *      只绑回环**不等于**安全：安卓的 127.0.0.1 是整机共享的，同机任何 App 都能
 *      连上来，而它们的 remoteAddress 也是 127.0.0.1 —— 电脑端那套"是不是本机请求"
 *      的判定在这里恒真。这道 Origin 门才是手机端真正的边界。
 *
 * 另外 HTTP 头里必须带 CORS：页面是 https://localhost，而这里是
 * http://127.0.0.1:<port>，不同源 —— 电脑版同源所以从不需要这些头。
 *
 * 与电脑端共用的部分：本地中继（/api/relay）与内网判定直接用 server/ 下那两个
 *   模块（由 sync-web 复制到本目录的 ./server/），**没有第二份实现**。
 */

import http from 'node:http';
import process from 'node:process';
// 2026-10：与电脑端**共用**的两个后端模块（由 scripts/sync-web.mjs 复制到这里
//   的 ./server/ 下，见那里的 SHARED_SERVER_MODULES）。不复制源码 —— 中继逻辑
//   与内网判定只有一份，改一处两端都变。
import { createRelay } from './server/relay.mjs';
import { isLocalRequest, isLoopbackHostname, isInternalAddress } from './server/net-guard.mjs';

/** 端口回传行的前缀，与 elaina_node_jni.cpp 里的 READY_PREFIX 必须一致。 */
const READY_PREFIX = '__ELAINA_READY__';

const HOST = '127.0.0.1';

/** 读 `--name=value` 形式的命令行参数。 */
function readArgument(name, fallback) {
    const prefix = `--${name}=`;
    const hit = process.argv.find((value) => value.startsWith(prefix));
    return hit === undefined ? fallback : hit.slice(prefix.length);
}

const dataDirectory = readArgument('data-dir', '');
const requestedPort = Number.parseInt(readArgument('port', '0'), 10) || 0;

/**
 * 实际监听到的端口。绑 0 号端口时最终是哪个只有内核知道，
 * 所以先占位，等 listen 回调拿到真实值再填。
 */
let port = 0;

/**
 * 放行跨源请求。
 *
 * 回显 Origin 而不是写死 `*`：页面只有一个来源（https://localhost），
 * 回显既够用，又不会把接口敞开给任意网页。
 */
function applyCorsHeaders(request, response) {
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin || '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Vary', 'Origin');
}

function sendJson(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
}

/**
 * 手机上**真正的边界**：只认页面自己发来的请求。
 *
 * 为什么不能像电脑端那样靠"是不是本机请求"（net-guard 的 isLocalRequest）：
 * 安卓的 127.0.0.1 是**整机共享**的 —— 同一个设备上任何别的 App 都能连到这个端口，
 * 而它们连过来时 remoteAddress 同样是 127.0.0.1，于是那套判定在手机上恒真、
 * SSRF 那两道校验根本不会触发。"只绑回环"挡不住同机的其它 App。
 *
 * 所以这里按 Origin 收：
 *   · WebView 里的页面是 https://localhost，它发起的**跨源**请求一定带这个 Origin；
 *   · 别的 App / adb 里的命令行工具要么不带 Origin，要么带的是别的值 → 直接拒。
 *
 * 代价写在明处：不带 Origin 的本机请求也会被拒 —— 原生插件因此在
 * stop() 里显式补了这个头（见 ElainaNodePlugin.stop）。要临时调试的话，
 * 别把这道门整个拆掉，改这里加白名单更安全。
 */
const ALLOWED_ORIGIN = 'https://localhost';
const originAllowed = (request) => String(request.headers.origin || '') === ALLOWED_ORIGIN;

/**
 * 本地中继 —— 用的是与电脑端**同一份**实现（server/relay.mjs）。
 *
 * 电脑端靠它绕开浏览器的 CORS（大量中转站不发 Access-Control-Allow-Origin）；
 * 手机上处境一模一样：页面在 https://localhost，而这里是 http://127.0.0.1:<随机端口>，
 * 天生跨源。而且它还带来一个额外好处 —— Node 侧是真流式，SSE 能逐块透传
 * （走原生 HTTP 插件那条路是攒完再回，增量就没了）。
 */
const relayHandler = createRelay({
    // 追踪日志：电脑端写 data/logs/<启动时刻>.trace.log；手机端这一步还没有落盘
    // （"日志落盘"是后面单独一段），先打 stdout —— 原生插件会把它转发进 logcat，
    // `adb logcat | grep ELAINA-NODE` 就能看到"当时问了什么、答了什么"。
    traceLine: (text) => console.log('[trace] ' + text),
    // 这三个判定用的是与电脑端同一份实现（net-guard）。手机上它们天然短路
    // （见上面关于回环是整机共享的说明），仍然传真的实现而不是空壳 ——
    // 将来谁改了监听地址，这道防线会立刻开始生效。
    isLocalRequest,
    isLoopbackHostname,
    isInternalAddress,
});

const server = http.createServer((request, response) => {
    applyCorsHeaders(request, response);

    // 预检请求不带业务语义，直接放行（预检不带 Origin 之外的凭据，放行它是安全的）
    if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
    }

    // 进任何路由之前先过这道门 —— 见 ALLOWED_ORIGIN 的说明
    if (!originAllowed(request)) {
        sendJson(response, 403, {
            ok: false,
            message: '只接受来自本应用页面的请求（缺少正确的 Origin）',
        });
        return;
    }

    // 只要路径，用一个固定 base 解析即可 —— 端口是动态的，没必要进这个字符串
    const pathname = new URL(request.url, `http://${HOST}`).pathname;

    // 本地中继：与电脑端同一条路（server/relay.mjs），跨源请求都在这里发出
    if (pathname === '/api/relay' && request.method === 'POST') {
        return relayHandler.handleRelay(request, response);
    }

    if (pathname === '/api/ping' && request.method === 'GET') {
        sendJson(response, 200, {
            ok: true,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            port,
            uptimeSeconds: Math.round(process.uptime()),
            dataDirectory,
        });
        return;
    }

    if (pathname === '/api/shutdown' && request.method === 'POST') {
        sendJson(response, 200, { ok: true, stopping: true });
        // 关掉监听、断掉已有的 keep-alive 连接，让事件循环空掉 ——
        //   node::Start 随之返回，Java 那边的线程结束，App 进程留着。
        //   不用 process.exit()（见文件头 ③）。
        server.close();
        if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
        }
        return;
    }

    sendJson(response, 404, { ok: false, error: 'no such endpoint', path: pathname });
});

server.on('error', (error) => {
    // 起不来要让原生侧看见：写进 stderr，会被转发成 logcat 的 ERROR
    console.error('内嵌 Node 服务启动失败：', error && error.message ? error.message : error);
});

server.listen(requestedPort, HOST, () => {
    port = server.address().port;
    console.log(`内嵌 Node 已监听 http://${HOST}:${port}`);
    // ① 端口回传。写完整行 + 换行，原生侧按行解析。
    process.stdout.write(`${READY_PREFIX}${JSON.stringify({
        port,
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        dataDirectory,
    })}\n`);
});
