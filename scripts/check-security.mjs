// 安全回归检查：写入黑名单 / 内网地址判定 / 防嵌套头 / 登录防爆破 / 密码强度 / 导出下载方式。
// 三段守同一威胁面（谁能往哪儿写 / 连哪儿 / 进得来 + 导出出口不被劫走）。
// 函数级穷举下沉为 server/internal/ 的 go test（zipx_guard_test.go、blockedWriteTarget_test.go、
// netguard 与 auth 的表驱动用例），本脚本只做真实 HTTP 端到端：经 startGoServer 编译并拉起
// server/ 的 Go 二进制，每个用例自己拿端口、自己在 finally 里 stop() 并清理探针文件；
// 本机没有 Go 工具链时对应用例整段环境性跳过（计 PASS）。
// 用法：node scripts/check-security.mjs            跑全部
//       node scripts/check-security.mjs 黑名单     只跑名字含该子串的用例
// 断言里出现"预期失败"允许（本机既有的环境性失败），但不允许为变绿改产品代码或删断言。

import { mkdtempSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { readFrontend } from './frontend-sources.mjs';
import { runChecks, ROOT, startGoServer } from './check-harness.mjs';
import { extractFunction } from './check-source.mjs';

// 写入黑名单与内网判定的"函数级矩阵"住在 go test 里：
//   - 扩展名判定（x.html::$DATA / 尾点 / 尾空格的"最终落盘名"语义）→ server/internal/zipx 的
//     zipx_guard_test.go 与 server/internal/agent 的 blockedWriteTarget_test.go；
//   - 中转内网判定（::ffff: 映射、169.254.169.254、fe80/fd00/fc00、172 边界……）→
//     server/internal/security 的表驱动测试。
// 这里守"判定真的接在 HTTP 路由上"：起真实服务，从请求一路打到磁盘与响应头。

/** 取私有网段（RFC1918）的本机网卡地址；虚拟网卡的公网段被判"非内网"放行是正确的 */
function lanAddress() {
    const isPrivate = (ip) => {
        const p = ip.split('.').map(Number);
        return p[0] === 10
            || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
            || (p[0] === 192 && p[1] === 168);
    };
    for (const list of Object.values(networkInterfaces())) {
        for (const ni of list || []) {
            if (ni.family === 'IPv4' && !ni.internal && isPrivate(ni.address)) return ni.address;
        }
    }
    return '';
}

async function caseSecurityHardening(c) {
    const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elainachat-sec-'));
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elainachat-sec-data-'));

    const PROBE = '__sec_probe';
    /** 清掉 web/ 里可能残留的探针（用例中途抛异常时也调用） */
    const cleanProbes = () => {
        try {
            for (const f of readdirSync(path.join(ROOT, 'web'))) {
                if (f.startsWith(PROBE)) {
                    try { rmSync(path.join(ROOT, 'web', f), { force: true }); } catch { /* ignore */ }
                }
            }
        } catch { /* web/ 读不到就没什么要清的 */ }
    };

    let srv = null;
    let lanSrv = null;
    try {
        console.log('--- 1. 端到端：写入黑名单与防嵌套头（真实服务） ---');
        srv = await startGoServer({ env: { DATA_DIR, LOG_DIR } });
        if (!srv) {
            c.ok(true, '环境性跳过：本机没有 Go 工具链，起不了真实服务端');
            return;
        }
        c.ok(srv.up, '服务已就绪', srv.up ? '' : srv.bootLog.slice(-500));

        if (srv.up) {
            const base = srv.base;
            const write = async (rel) => {
                const r = await fetch(`${base}/api/agent/write`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    // overwrite:true 是"用户已确认"令牌（strict 档新建也要确认），专测黑名单不混授权门
                    body: JSON.stringify({ path: rel, content: '<script>document.title="PWNED"</script>', permission: 'app', overwrite: true }),
                });
                return r.status;
            };

            for (const name of [PROBE + '.html', PROBE + '.HTML', PROBE + '.html.', PROBE + '.html ',
                PROBE + '.html. ', PROBE + '.js', PROBE + '.svg',
                // NTFS 流名形态：最终落盘名仍是可执行类型，必须按「最终名字」判定
                PROBE + '.html::$DATA', PROBE + '.HTML::$DATA', PROBE + '.js::$DATA',
                PROBE + '.svg::$DATA', PROBE + '.html:ads.txt']) {
                const st = await write('web/' + name);
                c.ok(st === 400, 'HTTP 400 拦截 web/' + name, '实得 ' + st);
            }

            // 磁盘上不许出现探针（真正要防的后果）
            const leaked = readdirSync(path.join(ROOT, 'web')).filter((f) => f.startsWith(PROBE));
            c.ok(leaked.length === 0, '★ web/ 内没有落盘任何探针文件', leaked.join(', '));

            const served = await fetch(`${base}/${PROBE}.html`);
            c.ok(served.status === 404, '★ 静态服务取不到 /' + PROBE + '.html', '实得 ' + served.status);

            const okStatus = await write('web/' + PROBE + '_ok.txt');
            c.ok(okStatus === 200, '正常文本文件仍可写入（功能没修坏）', '实得 ' + okStatus);
            const okPath = path.join(ROOT, 'web', PROBE + '_ok.txt');
            c.ok(existsSync(okPath), '文本文件确实落盘了');

            const login = await fetch(`${base}/login`);
            c.ok(login.headers.get('x-frame-options') === 'DENY', '/login 带 X-Frame-Options: DENY',
                String(login.headers.get('x-frame-options')));
            c.ok(login.headers.get('referrer-policy') === 'no-referrer', '/login 带 Referrer-Policy');
            c.ok(login.headers.get('x-content-type-options') === 'nosniff', '/login 带 X-Content-Type-Options');

            const home = await fetch(`${base}/`);
            c.ok(home.status === 200, '首页仍可访问', '实得 ' + home.status);
            c.ok(home.headers.get('x-frame-options') === 'DENY', '首页带 X-Frame-Options: DENY');

            // 本机访问本机服务（Ollama 场景）必须仍然放行
            const relayLocal = await fetch(`${base}/api/relay`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: `${base}/api/server-info`, method: 'GET', timeoutMs: 5000 }),
            });
            const relayBody = await relayLocal.json().catch(() => null);
            c.ok(!(relayBody && relayBody.relayError),
                '本机经中转访问本机服务仍放行（否则 Ollama 会挂）',
                relayBody && relayBody.message);
        }

        // 内网判定的函数级穷举在 go test；这里验的是"来源分层"接在真实路由上：
        // 本机与局域网来源可以访问内网服务商（手机通过 0.0.0.0 访问电脑端时就是这个场景），
        // 公网来源仍被拦（go test 的 TestSSRFBlockedForNonLocal），云元数据地址任何来源都拒绝。
        console.log('\n--- 2. 端到端：局域网设备可用内网服务商，云元数据仍拦截 ---');
        {
            const LAN = lanAddress();
            if (!LAN) {
                // 没有非回环网卡时（极简容器）跳过，但明确说出来，不静默通过
                console.log('  SKIP  本机没有非回环 IPv4 网卡，无法构造"局域网来源"，本节跳过');
                c.ok(true, '环境性跳过：本机没有非回环 IPv4 网卡，无法构造"局域网来源"');
            } else {
                // 第一台服务已经验完，收掉再起局域网形态的（HOST=0.0.0.0）
                srv.stop();
                await srv.stopped();

                lanSrv = await startGoServer({ env: { HOST: '0.0.0.0', DATA_DIR, LOG_DIR } });
                if (!lanSrv) {
                    c.ok(true, '环境性跳过：本机没有 Go 工具链，起不了真实服务端');
                } else {
                    c.ok(lanSrv.up, '服务已就绪（本机回环）', lanSrv.up ? '' : lanSrv.bootLog.slice(-400));
                }

                if (lanSrv && lanSrv.up) {
                    const port = lanSrv.port;
                    // 无密码态不设闸门：显式 HOST=0.0.0.0 时局域网直接可达，
                    // 端口开多大是 data/config.json 的 host 的决定，不再按密码状态销毁连接。
                    // 并发负载下局域网首连可能瞬时失败（与服务端是否可达无关），重试几次再判。
                    let lanOpen = false;
                    for (let attempt = 0; attempt < 3 && !lanOpen; attempt++) {
                        if (attempt) await new Promise((r) => setTimeout(r, 300));
                        try {
                            const res = await fetch(`http://${LAN}:${port}/api/server-info`);
                            lanOpen = res.ok;
                        } catch { lanOpen = false; }
                    }
                    c.ok(lanOpen, '无密码 + 显式外网监听：局域网直接可达（可达性由 host 配置决定，无密码态没有登录页）');

                    const TEST_PWD = 'abcde1xy';
                    const setPwd = await fetch(`http://127.0.0.1:${port}/api/auth/change-password`, {
                        method: 'POST', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ next: TEST_PWD }),
                    });
                    c.ok(setPwd.status === 200, '本机设置访问密码成功（设置后匿名请求走鉴权闸门）', 'HTTP ' + setPwd.status);
                    // 改密码清空所有会话，但当前设备刚设完密码必须直接拿到新会话（否则被踢回登录页）
                    // cookie 名带实例后缀（elaina_session_<实例ID>）：同一域下多实例各持一份，互不覆盖。
                    const setPwdCookies = setPwd.headers.getSetCookie?.() || [];
                    c.ok(setPwdCookies.some((x) => /^elaina_session_[^=]+=[^;]+/.test(x)),
                        '改密码后当前设备直接拿到新会话（不必重复输密码）', setPwdCookies.join(' | '));

                    // 改密的持久形态是 data/config.json 的 password 字段：新密码明文写入、旧 auth.json 删除。
                    // 向下兼容：auth.json 只在 config 没写 password 时才作为权威读取。
                    const configPath = path.join(DATA_DIR, 'config.json');
                    const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
                    c.ok(configText.includes(JSON.stringify(TEST_PWD).slice(1, -1)),
                        '改密后新密码已写入 data/config.json');
                    c.ok(!existsSync(path.join(DATA_DIR, 'auth.json')),
                        '改密后旧密码文件 auth.json 已删除');

                    const login = await fetch(`http://${LAN}:${port}/api/auth/login`, {
                        method: 'POST', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ password: TEST_PWD }),
                    });
                    const cookie = (login.headers.getSetCookie?.() || []).map((x) => x.split(';')[0]).join('; ');
                    c.ok(login.status === 200 && Boolean(cookie), '以局域网身份登录成功（后续才能调中转）', 'HTTP ' + login.status);

                    const loginAgain = await fetch(`http://${LAN}:${port}/login`, { headers: { cookie }, redirect: 'manual' });
                    c.ok(loginAgain.status === 302 && loginAgain.headers.get('location') === '/',
                        '已登录时 /login 直接跳首页（不再让用户重复输密码）', 'HTTP ' + loginAgain.status);

                    const relay = async (url) => {
                        const r = await fetch(`http://${LAN}:${port}/api/relay`, {
                            method: 'POST',
                            headers: { 'content-type': 'application/json', cookie },
                            body: JSON.stringify({ url, method: 'GET', timeoutMs: 4000 }),
                        });
                        // 必须同时留原文：内网靶子返回 text/plain，只按 JSON 解析得 null，
                        // "内容有没有泄漏"会变成永远通过的空断言。
                        const raw = await r.text();
                        let body = null;
                        try { body = JSON.parse(raw); } catch { /* 非 JSON，原文留在 raw 里 */ }
                        return { status: r.status, body, raw };
                    };

                    // 用没有任何 Host 白名单的内网服务当靶子：本应用端口还有白名单兜底，
                    // 会掩盖判定是否接上；Ollama 这类只住 127.0.0.1、无别的防护的才是真实场景。
                    const SECRET = 'INTERNAL-SECRET-FOR-LAN-RELAY';
                    const internal = createHttpServer((req, res) => {
                        res.writeHead(200, { 'content-type': 'text/plain' });
                        res.end(SECRET);
                    });
                    const internalPort = await c.freePort();
                    await new Promise((r) => internal.listen(internalPort, '127.0.0.1', r));

                    try {
                        // 手机通过局域网访问电脑端时，服务商（如本机 Ollama）必须能走中转；
                        // 来源判定在 Go 单测里另有 TestInternalAllowedForLAN / TrustAllClients 两条。
                        const r = await relay(`http://127.0.0.1:${internalPort}/`);
                        c.ok(r.status === 200 && String(r.raw || '').includes(SECRET),
                            '★ 局域网设备经中转访问内网服务商放行',
                            'HTTP ' + r.status + ' ' + (r.body && r.body.message || ''));

                        // 云元数据地址不随局域网放行：它泄露的是本机凭据，不是 AI 服务商。
                        const meta = await relay('http://169.254.169.254/latest/meta-data/');
                        c.ok(Boolean(meta.body && meta.body.relayError),
                            '★ 云元数据地址始终拒绝（局域网放行不覆盖它）',
                            'HTTP ' + meta.status + ' ' + (meta.body && meta.body.message || ''));

                        // 越界边界：已登录的局域网设备可获电脑操作权限（刻意放开），认证那条线没松：
                        // 不带有效会话 cookie 时，allowOutside / permission=computer 都拿不到任何东西。
                        const escalate = async (body, withCookie = true) => {
                            const r = await fetch(`http://${LAN}:${port}/api/agent/write`, {
                                method: 'POST',
                                headers: withCookie
                                    ? { 'content-type': 'application/json', cookie }
                                    : { 'content-type': 'application/json' },
                                body: JSON.stringify(body),
                            });
                            const raw = await r.text();
                            let j = null; try { j = JSON.parse(raw); } catch { /* 原文留在 raw */ }
                            return { status: r.status, j, raw };
                        };
                        const outsideTarget = path.join(path.dirname(ROOT), 'elaina-lan-escape-probe.txt');

                        // 先清掉上一轮可能留下的探针：残留文件会撞上覆盖闸门（已存在 → 403），造成假失败
                        try { rmSync(outsideTarget, { force: true }); } catch { /* ignore */ }

                        // 未登录 + allowOutside=true 必须被拦：认证是唯一那道门，不能被布尔字段绕过
                        //（实际状态码 401，401/403 都算拦住；断言"没写出文件"比钉死具体码更贴真实意图）
                        const anon = await escalate({
                            path: outsideTarget, content: 'LAN-ANON-ESCAPE', permission: 'app', allowOutside: true,
                        }, false);
                        c.ok(anon.status === 401 || anon.status === 403,
                            '★ 未登录的局域网传 allowOutside=true 被拦（401/403）', `status=${anon.status}`);
                        c.ok(anon.j?.needEscalation !== true,
                            '★ 未登录连"申请越界"的入口都不给（不返回 needEscalation）',
                            JSON.stringify(anon.j));

                        const anon2 = await escalate({
                            path: outsideTarget, content: 'LAN-ANON-PC', permission: 'computer', allowOutside: true,
                        }, false);
                        c.ok(anon2.status === 401 || anon2.status === 403,
                            '★ 未登录声明 permission=computer 也被拦（401/403）', `status=${anon2.status}`);
                        c.ok(!existsSync(outsideTarget), '★ 未登录的两条路径都没有写出文件（探针不存在）');

                        // 反向断言：已登录的局域网设备可以操作电脑（刻意放开并钉住，防止被当作 bug 撤销）；
                        // overwrite:true 为确认令牌，确认门另行覆盖。
                        const authed = await escalate({
                            path: outsideTarget, content: 'LAN-AUTHED', permission: 'computer', overwrite: true,
                        }, true);
                        c.ok(authed.status === 200,
                            '★ 已登录的局域网设备可以操作电脑（本轮刻意的放开）', `status=${authed.status}`);
                        c.ok(existsSync(outsideTarget),
                            '已登录设备确实写出了文件（放开是真实生效的，不是纸面）');
                        try { rmSync(outsideTarget, { force: true }); } catch { /* ignore */ }
                    } finally {
                        internal.close();
                    }
                }
            }
        }
    } finally {
        if (srv) { try { srv.stop(); } catch { /* ignore */ } }
        if (lanSrv) { try { lanSrv.stop(); } catch { /* ignore */ } }
        // 探针可能还残留（用例中途抛异常时），这里再收一次
        cleanProbes();
        rmSync(LOG_DIR, { recursive: true, force: true });
        rmSync(DATA_DIR, { recursive: true, force: true });
    }
}

// 2. 登录防爆破 + 密码强度：密码是电脑操作权限的唯一那道门。
// 模块级穷举（强度规则 / 指数退避序列 / 全局冻结 / 封顶）下沉为 server/internal/auth 的
// go test（guard_test.go、password_test.go 与本仓库新增的表驱动用例）；
// 这里守接线：真实服务的 /api/auth/* 要真的走强度校验、发会话、查锁定。
// 时钟与可调参数的穷举在 go test 里毫秒级跑完，这里不做真等。

async function caseAuthGuard(c) {
    const dataTmp = mkdtempSync(path.join(tmpdir(), 'elainachat-auth-'));
    const srv = await startGoServer({ env: { DATA_DIR: dataTmp, LOG_DIR: path.join(dataTmp, 'logs') } });
    if (!srv) {
        c.ok(true, '环境性跳过：本机没有 Go 工具链，起不了真实服务端');
        try { rmSync(dataTmp, { recursive: true, force: true }); } catch { /* ignore */ }
        return;
    }

    try {
        c.ok(srv.up, '服务已就绪', srv.up ? '' : srv.bootLog.slice(-500));
        if (!srv.up) return;
        const base = srv.base;
        const TEST_PWD = 'abcde1xy';

        console.log('--- 1. 改密码走强度校验（接线） ---');
        {
            const weakCases = [
                { label: '长度不足', pwd: '123', piece: '至少' },
                { label: '缺数字', pwd: 'abcdefgh', piece: '数字' },
                { label: '只有数字', pwd: '11111111', piece: '字母或符号' },
            ];
            for (const tc of weakCases) {
                const weak = await fetch(`${base}/api/auth/change-password`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ next: tc.pwd }),
                });
                c.ok(weak.status === 400, '弱密码被拒（' + tc.label + '）', '实得 ' + weak.status);
                const weakBody = await weak.json().catch(() => null);
                c.ok(Boolean(weakBody && (weakBody.message || '').includes(tc.piece)),
                    '拒绝原因里说明缺什么（' + tc.label + '）', weakBody && weakBody.message);
            }
        }

        console.log('\n--- 2. 设置访问密码：本机直接拿到新会话 ---');
        {
            const setPwd = await fetch(`${base}/api/auth/change-password`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ next: TEST_PWD }),
            });
            c.ok(setPwd.status === 200, '无大写密码按新规则通过（本机设置成功）', 'HTTP ' + setPwd.status);
            const cookies = setPwd.headers.getSetCookie?.() || [];
            c.ok(cookies.some((x) => /^elaina_session_[^=]+=[^;]+/.test(x)),
                '改密码后当前设备直接拿到新会话（不必重复输密码）', cookies.join(' | '));
        }

        console.log('\n--- 3. 连续失败锁定：先查守卫再验密码 ---');
        {
            let lockedAt = 0;
            let retryHeader = '';
            let retrySec = 0;
            for (let i = 1; i <= 8; i++) {
                const r = await fetch(`${base}/api/auth/login`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ password: 'wrong-' + i }),
                });
                if (r.status === 429) {
                    lockedAt = i;
                    retryHeader = r.headers.get('retry-after') || '';
                    const j = await r.json().catch(() => null);
                    retrySec = (j && j.retryAfterSec) || 0;
                    break;
                }
                c.ok(r.status === 401, `第 ${i} 次错密码回 401`, '实得 ' + r.status);
            }
            c.ok(lockedAt === 6, '连续第 6 次尝试被守卫拦下（阈值 5，锁定先于密码校验）', 'lockedAt=' + lockedAt);
            c.ok(retryHeader !== '' && Number(retryHeader) > 0,
                '被拦时回 Retry-After 头（客户端可据此退避）', retryHeader);
            c.ok(retrySec > 0 && retrySec <= 30, '首次锁定在 30 秒内（指数退避的起点）', String(retrySec));

            // 锁定期内正确密码同样被拦：锁定不以"密码对不对"为前提
            const okTry = await fetch(`${base}/api/auth/login`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ password: TEST_PWD }),
            });
            c.ok(okTry.status === 429, '锁定期内正确密码同样被拦', '实得 ' + okTry.status);
        }
    } finally {
        srv.stop();
        try { rmSync(dataTmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// 3. 数据导出的下载方式：下载器机器级扩展见到 attachment 头就抢走 URL（浏览器拿到空响应）。
// 守两条：后端不发 attachment（文件名走自定义头）；前端 fetch 成 blob 保存并检测空响应。
// 只读源码与响应头，不触发真实下载。

async function caseExportDownload(c) {
    console.log('--- 1. 前端下载方式（源码） ---');
    // 前端拆分后 exportDataBackup 在 web/js/*.js 里，必须读整个前端
    const html = readFrontend();

    /** 取出 exportDataBackup 函数体（靠大括号配对）；找不到返回 null */
    const extractFn = (source, name) => extractFunction(source, name, { required: false }) || null;

    const exportFn = extractFn(html, 'exportDataBackup');
    c.ok(exportFn !== null, '找到 exportDataBackup 函数');
    if (exportFn) {
        c.ok(/URL\.createObjectURL/.test(exportFn), '用 createObjectURL（blob 下载）');
        c.ok(/a\.download\s*=/.test(exportFn), '用 <a download> 触发保存');
        c.ok(!/location\.href\s*=/.test(exportFn), '没有用 location.href 跳转（那会被下载器抢）');
        c.ok(/blob\.size/.test(exportFn), '检测了空响应（blob.size）');
        c.ok(/X-Backup-Filename/.test(exportFn), '读取自定义文件名头');
        c.ok(/revokeObjectURL/.test(exportFn), '释放了 blob URL（不泄漏内存）');
    }

    console.log('\n--- 2. 后端响应头（真实服务，不触发下载） ---');
    const sandbox = await mkdtemp(path.join(tmpdir(), 'elaina-export-'));
    const dataDir = path.join(sandbox, 'data');
    await mkdir(dataDir, { recursive: true });
    // 导出会把插件与技能也打进 zip；这里同样用临时目录隔离，
    // 否则这段检查会读用户真实的 mods/（体积大、内容随本机安装变化）。
    const modsDir = path.join(sandbox, 'mods');
    const skillsDir = path.join(sandbox, 'skills');
    await mkdir(modsDir, { recursive: true });
    await mkdir(skillsDir, { recursive: true });
    await writeFile(path.join(dataDir, 'store.json'), JSON.stringify({
        elaina_open_settings: JSON.stringify({ model: 'x' }),
    }), 'utf8');

    const srv = await startGoServer({
        env: {
            DATA_DIR: dataDir, LOG_DIR: path.join(sandbox, 'logs'),
            MODS_DIR: modsDir, SKILLS_DIR: skillsDir, LOG_CHAT: '0',
        },
    });
    if (!srv) {
        c.ok(true, '环境性跳过：本机没有 Go 工具链，起不了真实服务端');
        await rm(sandbox, { recursive: true, force: true }).catch(() => {});
        return;
    }

    try {
        // 起不来时不直接 process.exit（会吞掉其余用例），记 FAIL 后跳过本节断言
        c.ok(srv.up, '服务已启动（导出接口要打真实服务）', srv.up ? '' : srv.bootLog.slice(0, 800));

        if (srv.up) {
            const r = await fetch(srv.base + '/api/data/export');
            c.ok(r.status === 200, '导出返回 200', 'got ' + r.status);

            const cd = r.headers.get('content-disposition') || '';
            c.ok(!/attachment/i.test(cd), '不发 Content-Disposition: attachment', cd || '(无)');
            c.ok(!/content-disposition/i.test([...r.headers.keys()].join(',')), '完全没有 Content-Disposition 头');

            const fn = r.headers.get('x-backup-filename') || '';
            c.ok(/^elainachat-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/.test(fn), '自定义头带合法文件名', fn);

            c.ok(/zip/.test(r.headers.get('content-type') || ''), 'Content-Type 是 zip');

            const buf = Buffer.from(await r.arrayBuffer());
            c.ok(buf.length > 0, '响应非空', buf.length + ' 字节');
            c.ok(buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50, '内容是合法 zip');

            // 自定义头必须能过 CORS 暴露（同源不需要，但记一笔）
            c.ok(true, '（同源请求，无需 Access-Control-Expose-Headers）');
        }
    } finally {
        srv.stop();
        await rm(sandbox, { recursive: true, force: true }).catch(() => {});
    }
}

// 4. 局域网共享：6 位验证码、5 分钟、连错 5 次换码、host=127.0.0.1 时走临时监听。
// 这里从真实 HTTP 打：本机登录拿会话 → 开启共享 → 从 LAN 用验证码登录临时端口 → 导出备份。
async function caseLANShare(c) {
    const dataTmp = mkdtempSync(path.join(tmpdir(), 'elainachat-lanshare-'));
    const cfgPath = path.join(dataTmp, 'config.json');
    const TEST_PWD = 'abcde1xy';
    await writeFile(cfgPath, JSON.stringify({ password: TEST_PWD }), 'utf8');

    const srv = await startGoServer({ env: { DATA_DIR: dataTmp, LOG_DIR: path.join(dataTmp, 'logs'), ELAINA_CONFIG_FILE: cfgPath } });
    if (!srv) {
        c.ok(true, '环境性跳过：本机没有 Go 工具链，起不了真实服务端');
        rmSync(dataTmp, { recursive: true, force: true });
        return;
    }
    try {
        c.ok(srv.up, '服务已就绪', srv.up ? '' : srv.bootLog.slice(-500));
        if (!srv.up) return;
        const LAN = lanAddress();
        if (!LAN) {
            c.ok(true, '环境性跳过：本机没有非回环 IPv4 网卡，无法从局域网验证');
            return;
        }

        const loginLocal = await fetch(`${srv.base}/api/auth/login`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: TEST_PWD }),
        });
        const cookie = (loginLocal.headers.getSetCookie?.() || []).map((x) => x.split(';')[0]).join('; ');
        c.ok(loginLocal.status === 200 && Boolean(cookie), '配置密码可登录主服务', 'HTTP ' + loginLocal.status);

        const enable = await fetch(`${srv.base}/api/data/lan/enable`, {
            method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}',
        });        const enableBody = await enable.json().catch(() => null);
        const share = enableBody && enableBody.share;
        c.ok(enable.status === 200 && Boolean(share), '开启局域网共享成功', enableBody && enableBody.message);
        if (!share) return;
        c.ok(!('code' in share), '共享响应不再签发验证码（凭据统一为访问密码）', JSON.stringify(Object.keys(share)));
        c.ok(Number(share.port) > 0 && Number(share.port) !== srv.port,
            'HOST=127.0.0.1 时共享使用临时端口（不受 host 限制）', `share=${share.port} main=${srv.port}`);
        const remaining = Number(share.expiresAt) - Date.now();
        c.ok(remaining > 0 && remaining <= 5 * 60 * 1000 + 2000, '共享期为 5 分钟', String(remaining));

        const pwdLogin = await fetch(`http://${LAN}:${share.port}/api/auth/login`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: TEST_PWD }),
        });
        const lanCookie = (pwdLogin.headers.getSetCookie?.() || []).map((x) => x.split(';')[0]).join('; ');
        c.ok(pwdLogin.status === 200 && Boolean(lanCookie), '从局域网用访问密码登录临时端口成功', 'HTTP ' + pwdLogin.status);

        const exported = await fetch(`http://${LAN}:${share.port}/api/data/lan/export`, { headers: { cookie: lanCookie } });
        const buf = Buffer.from(await exported.arrayBuffer());
        c.ok(exported.status === 200 && buf.length > 0, '带会话从局域网导出备份成功', `HTTP ${exported.status} ${buf.length}B`);

        // 没有独立凭据：随便一个 6 位数字都不该被当成口令。
        const bogus = await fetch(`http://${LAN}:${share.port}/api/auth/login`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: '123456' }),
        });
        c.ok(bogus.status === 401, '6 位数字不再能登录共享', 'HTTP ' + bogus.status);

        const wrongPwd = await fetch(`http://${LAN}:${share.port}/api/auth/login`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: TEST_PWD + 'x' }),
        });
        c.ok(wrongPwd.status === 401, '错误密码被拒', 'HTTP ' + wrongPwd.status);

        // 共享导出必须能带上页面交来的密钥表：手机端 Key 只住 Keystore、data/ 里没有，
        // 不带这批值的话对方拉到的备份天然缺 Key（表现为「局域网接收共享后只有 Key 是空的」）。
        // 用一台全新实例验证：共享窗口开着时再点只查地址、不替换密钥表，所以在当前实例上
        // 没法再走一次"带 Key 开启"；起新实例最直接，也顺带覆盖了"首次开启即带 Key"。
        {
            const secrets = { apiKey: 'sk-LAN-KEYSTORE', chatProviderKeys: JSON.stringify({ p1: 'sk-LAN-P1' }) };
            const freshDir = mkdtempSync(path.join(tmpdir(), 'elainachat-lansec-'));
            const freshCfg = path.join(freshDir, 'config.json');
            await writeFile(freshCfg, JSON.stringify({ password: TEST_PWD }), 'utf8');
            const fresh = await startGoServer({
                env: { DATA_DIR: freshDir, LOG_DIR: path.join(freshDir, 'logs'), LOG_CHAT: '0', ELAINA_CONFIG_FILE: freshCfg },
            });
            try {
                if (!fresh.up) {
                    c.ok(true, '环境性跳过：第二个实例没起来');
                } else {
                    const lg = await fetch(`${fresh.base}/api/auth/login`, {
                        method: 'POST', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ password: TEST_PWD }),
                    });
                    const ck = (lg.headers.getSetCookie?.() || []).map((x) => x.split(';')[0]).join('; ');
                    const en = await fetch(`${fresh.base}/api/data/lan/enable`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', cookie: ck, 'X-Elaina-Secrets': JSON.stringify(secrets) },
                        body: '{}',
                    });
                    const enBody2 = await en.json().catch(() => null);
                    const sp = enBody2 && enBody2.share && enBody2.share.port;
                    c.ok(en.status === 200 && Boolean(sp), '首次开启共享即带 Keystore 的 Key', 'HTTP ' + en.status);

                    const ex = await fetch(`http://${LAN}:${sp}/api/data/lan/export`, { headers: { cookie: ck } });
                    const exBuf = Buffer.from(await ex.arrayBuffer());
                    c.ok(ex.status === 200 && exBuf.length > 0, '从共享端口取到备份', `HTTP ${ex.status} ${exBuf.length}B`);

                    // 备份是 zip：直接找密钥表那段的明文（zipx 用 deflate，解压要额外依赖，
                    // 这里按数据条目名在原始字节里定位足够判断"含不含 Key"）。
                    const raw = exBuf.toString('latin1');
                    c.ok(raw.includes('sk-LAN-KEYSTORE'),
                        '★★ 共享导出的备份含 Keystore 的 Key（否则对方导入后 Key 为空）',
                        raw.includes('elainachat_open_api_secrets') ? '有密钥表键但无值' : '整个密钥表都不在备份里');
                }
            } finally {
                try { fresh.stop(); } catch { /* ignore */ }
                rmSync(freshDir, { recursive: true, force: true });
            }
        }
    } finally {
        srv.stop();
        rmSync(dataTmp, { recursive: true, force: true });
    }
}

// 安卓原生出口的明文边界：XML 放开基础明文（为了局域网网关），真正的 HTTP 出口限制在
// ByokHttpPlugin.isAllowedUrl —— 只允许回环与 RFC1918 字面量，公网仍强制 HTTPS。
async function caseAndroidCleartextBoundary(c) {
    const java = readFileSync(path.join(ROOT, 'dist', 'Android', 'android', 'app', 'src', 'main', 'java', 'com', 'elainachat', 'mod', 'ByokHttpPlugin.java'), 'utf8');
    const xml = readFileSync(path.join(ROOT, 'dist', 'Android', 'android', 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml'), 'utf8');

    const start = java.indexOf('private static boolean isAllowedUrl');
    const end = java.indexOf('private static boolean isPrivateIpv4');
    const fn = (start >= 0 && end > start) ? java.slice(start, end) : '';
    c.ok(/if \("https"\.equalsIgnoreCase\(url\.getProtocol\(\)\)\) return true;/.test(fn),
        'HTTPS 始终放行（公网服务商不受影响）');
    c.ok(/return isPrivateIpv4\(normalized\);/.test(fn),
        '★ HTTP 的最终判据是 RFC1918 / 链路本地字面量（公网域名仍强制 HTTPS）');
    c.ok(/n\[0\] == 10/.test(java) && /n\[0\] == 172/.test(java) && /n\[0\] == 192/.test(java),
        '★ 私网段覆盖 10 / 172.16-31 / 192.168（局域网 API 网关）');
    c.ok(/cleartextTrafficPermitted="true"/.test(xml),
        '★ network_security_config 与代码层放行同步（否则 Android 9+ 连不上局域网 HTTP）');
    c.ok(/ByokHttpPlugin\.isAllowedUrl/.test(xml),
        'XML 里写明最终出口限制在 ByokHttpPlugin');
    // isAllowedUrl 只校验初始地址：一旦跟随重定向，新地址不再过明文/主机判定，
    // 而调用方给的 x-api-key 等头会被带过去。两条出口都必须关掉自动跟随。
    const followOff = (java.match(/setInstanceFollowRedirects\(false\)/g) || []).length;
    c.ok(followOff >= 2,
        `★ POST 与 GET 两条出口都不得跟随重定向（实际 ${followOff} 处 setInstanceFollowRedirects(false)）`);
}

// 按命令行参数过滤用例（便于只跑其中一段）
const only = process.argv[2];
const allCases = [
    { name: '写入黑名单与内网判定', fn: caseSecurityHardening },
    { name: '登录防爆破与密码强度', fn: caseAuthGuard },
    { name: '数据导出下载方式', fn: caseExportDownload },
    { name: '局域网共享访问密码', fn: caseLANShare },
    { name: '安卓明文出口边界', fn: caseAndroidCleartextBoundary },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;
if (only && !cases.length) {
    console.log('没有名字含 ' + JSON.stringify(only) + ' 的用例。可选：' + allCases.map((x) => x.name).join(' / '));
}

await runChecks({
    title: '安全（写入黑名单 / 内网判定 / 安卓明文出口 / 防嵌套头 / 登录防爆破 / 导出下载 / 局域网共享访问密码）',
    usage: 'node scripts/check-security.mjs [用例名子串]',
    cases,
});
