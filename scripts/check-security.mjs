// 安全回归检查：写入黑名单 / 内网地址判定 / 防嵌套头 / 登录防爆破 / 密码强度 / 导出下载方式。
// 三段守同一威胁面（谁能往哪儿写 / 连哪儿 / 进得来 + 导出出口不被劫走）。
// 用例会 spawn 起 web/serve.mjs：每个用例自己拿端口、自己在 finally 里杀进程并清理探针文件。
// 用法：node scripts/check-security.mjs            跑全部
//       node scripts/check-security.mjs 黑名单     只跑名字含该子串的用例
// 断言里出现"预期失败"允许（本机既有的环境性失败），但不允许为变绿改产品代码或删断言。

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFrontend } from './frontend-sources.mjs';
import { runChecks, ROOT, wait, freePort } from './check-harness.mjs';
import { extractFunction } from './check-source.mjs';

const SERVE = path.join(ROOT, 'web', 'serve.mjs');

// 1. 写入黑名单：扩展名判定必须看"最终落盘名" + 中转的内网地址判定 + 防嵌套头
// extname 判不出 x.html::$DATA / 尾点 / 尾空格（存储型 XSS）；内网判定必须解析成 IP
// 再规范化（字符串前缀漏掉 IPv4-mapped IPv6 → SSRF）。函数级矩阵 + 真服务端到端。

async function caseSecurityHardening(c) {
    const src = readFileSync(SERVE, 'utf8');
    // 内网判定函数在 server/net-guard.mjs（两端共用一份判定），第 2 节从该文件取源码断言
    const NET_GUARD = path.join(ROOT, 'server', 'net-guard.mjs');
    const netGuardSrc = readFileSync(NET_GUARD, 'utf8');
    const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elainachat-sec-'));
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elainachat-sec-data-'));

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

    /** 按花括号配对切出一个具名函数（serve.mjs 不是模块，只能这样取）；找不到返回 null */
    const extractFn = (source, name) => extractFunction(source, name, { required: false }) || null;

    // 临时目录在整个用例结束时统一清掉（服务起不来时也要清）
    let child = null;
    try {
        console.log('--- 1. 写入黑名单：扩展名判定必须看"最终落盘名" ---');
        {
            // BLOCKED_EXT / effectiveExt 住在 server/zip.mjs，isBlockedWritePath 在 serve.mjs，两个都读
            const zipSrc = readFileSync(path.join(ROOT, 'server', 'zip.mjs'), 'utf8');
            const need = ['effectiveExt', 'isBlockedWritePath', 'BLOCKED_EXT'];
            const missing = need.filter((n) => (n === 'BLOCKED_EXT'
                ? !/const BLOCKED_EXT = new Set\(\[/.test(zipSrc)
                : (n === 'effectiveExt' ? !extractFn(zipSrc, n) : !extractFn(src, n))));
            c.ok(missing.length === 0, '能找到 effectiveExt（zip.mjs）/ isBlockedWritePath（serve.mjs）/ BLOCKED_EXT（zip.mjs）',
                missing.length ? '缺少：' + missing.join(', ') : '');

            if (!missing.length) {
                // BLOCKED_EXT 常量单独切出来（到 `]);` 为止）
                const setStart = zipSrc.indexOf('const BLOCKED_EXT = new Set([');
                const setEnd = zipSrc.indexOf(']);', setStart) + 3;
                const ctx = vm.createContext({ path, console });
                vm.runInContext(
                    zipSrc.slice(setStart, setEnd) + '\n'
                    + extractFn(zipSrc, 'effectiveExt') + '\n'
                    + extractFn(src, 'isBlockedWritePath') + '\n'
                    + 'this.__blocked = isBlockedWritePath; this.__ext = effectiveExt;',
                    ctx
                );

                const mustBlock = [
                    'x.html', 'x.HTML', 'x.htm', 'x.xhtml', 'x.shtml', 'x.hta', 'x.mhtml',
                    'x.js', 'x.mjs', 'x.cjs', 'x.jsx', 'x.ts',
                    'x.svg', 'x.xml', 'x.xsl',
                    'x.exe', 'x.dll', 'x.com', 'x.scr', 'x.msi', 'x.bat', 'x.cmd',
                    'x.ps1', 'x.psm1', 'x.vbs', 'x.wsf', 'x.jar', 'x.sh',
                    'x.html.', 'x.html ', 'x.html. ',
                    'x.html::$DATA', 'x.HTML::$DATA', 'x.js::$DATA', 'x.svg::$DATA',
                    'x.html:ads.txt',
                ];
                for (const n of mustBlock) {
                    c.ok(ctx.__blocked('D:/web/' + n) === true, '拦截 ' + JSON.stringify(n));
                }

                for (const n of ['note.txt', 'a.md', 'data.json', 'x.csv', 'readme', '中文名.txt', 'a.b.txt']) {
                    c.ok(ctx.__blocked('D:/web/' + n) === false, '放行 ' + JSON.stringify(n));
                }

                // ③ 直接证明"朴素 extname 判据会漏" —— 防止实现退回朴素 extname 判定
                const naive = (n) => ['.html', '.js', '.svg'].includes(path.extname(n).toLowerCase());
                c.ok(naive('x.html::$DATA') === false,
                    '★ 记录绕过原理：朴素 extname 判不出 x.html::$DATA（只按扩展名判断就会漏）');
                c.ok(ctx.__blocked('D:/web/x.html::$DATA') === true, '★ 修复后的判据能判出 x.html::$DATA');
            }
        }

        console.log('\n--- 2. 中转内网判定：必须覆盖 IPv4-mapped IPv6 ---');
        {
            const fns = ['isPrivateIPv4', 'mappedIPv4', 'isInternalAddress'];
            const missing = fns.filter((n) => !extractFn(netGuardSrc, n));
            c.ok(missing.length === 0, 'server/net-guard.mjs 里能找到 isPrivateIPv4 / mappedIPv4 / isInternalAddress',
                missing.length ? '缺少：' + missing.join(', ') : '');

            if (!missing.length) {
                const ctx = vm.createContext({ console });
                vm.runInContext(
                    fns.map((n) => extractFn(netGuardSrc, n)).join('\n')
                    + '\nthis.__internal = isInternalAddress;',
                    ctx
                );

                const mustBlock = [
                    '127.0.0.1', '127.1.2.3',
                    '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
                    '169.254.169.254', '0.0.0.0',
                    '::1', '::',
                    '::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:127.0.0.1]',
                    '::ffff:192.168.1.1', '::ffff:10.0.0.1',
                    'fe80::1', 'fd00::1', 'fc00::1',
                ];
                for (const ip of mustBlock) {
                    c.ok(ctx.__internal(ip) === true, '判为内网 ' + JSON.stringify(ip));
                }

                const mustPass = [
                    '8.8.8.8', '1.1.1.1',
                    '172.32.0.1', '172.15.0.1',   // 172.16-31 之外是公网，别误伤
                    '11.0.0.1',
                    '2001:4860:4860::8888', '::ffff:8.8.8.8',
                ];
                for (const ip of mustPass) {
                    c.ok(ctx.__internal(ip) === false, '判为公网 ' + JSON.stringify(ip));
                }

                const naive = (a) => a === '::1' || a.startsWith('127.')
                    || (String(a).split('.').length === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
                c.ok(naive('::ffff:127.0.0.1') === false, '★ 记录绕过原理：朴素前缀比较漏掉 ::ffff:127.0.0.1');
            }
        }

        console.log('\n--- 3. 端到端：起真实服务验证 ---');
        const PORT = await c.freePort();
        const PROBE = '__sec_probe';
        try {
            child = spawn(process.execPath, [SERVE], {
                cwd: ROOT,
                // DATA_DIR 必须隔离：否则跑一次检查就会动用户真实的 data/（密码、会话、store）
                env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LOG_DIR, DATA_DIR },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            child.stdout.on('data', (d) => { out += d; });
            child.stderr.on('data', (d) => { out += d; });

            let ready = false;
            for (let i = 0; i < 75; i++) {
                try { const r = await fetch(`http://127.0.0.1:${PORT}/api/server-info`); if (r.status) { ready = true; break; } }
                catch { await c.wait(200); }
            }
            c.ok(ready, '服务已就绪', ready ? '' : out.slice(-500));

            if (ready) {
                const write = async (rel) => {
                    const r = await fetch(`http://127.0.0.1:${PORT}/api/agent/write`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        // overwrite:true 是"用户已确认"令牌（strict 档新建也要确认），专测黑名单不混授权门
                        body: JSON.stringify({ path: rel, content: '<script>document.title="PWNED"</script>', permission: 'app', overwrite: true }),
                    });
                    return r.status;
                };

                for (const name of [PROBE + '.html', PROBE + '.html.', PROBE + '.html ',
                    PROBE + '.html. ', PROBE + '.html::$DATA', PROBE + '.HTML::$DATA',
                    PROBE + '.js::$DATA', PROBE + '.svg::$DATA', PROBE + '.html:ads.txt']) {
                    const st = await write('web/' + name);
                    c.ok(st === 400, 'HTTP 400 拦截 web/' + name, '实得 ' + st);
                }

                // 磁盘上不许出现探针（真正要防的后果）
                const leaked = readdirSync(path.join(ROOT, 'web')).filter((f) => f.startsWith(PROBE));
                c.ok(leaked.length === 0, '★ web/ 内没有落盘任何探针文件', leaked.join(', '));

                const served = await fetch(`http://127.0.0.1:${PORT}/${PROBE}.html`);
                c.ok(served.status === 404, '★ 静态服务取不到 /' + PROBE + '.html', '实得 ' + served.status);

                const okStatus = await write('web/' + PROBE + '_ok.txt');
                c.ok(okStatus === 200, '正常文本文件仍可写入（功能没修坏）', '实得 ' + okStatus);
                const okPath = path.join(ROOT, 'web', PROBE + '_ok.txt');
                c.ok(existsSync(okPath), '文本文件确实落盘了');

                const login = await fetch(`http://127.0.0.1:${PORT}/login`);
                c.ok(login.headers.get('x-frame-options') === 'DENY', '/login 带 X-Frame-Options: DENY',
                    String(login.headers.get('x-frame-options')));
                c.ok(login.headers.get('referrer-policy') === 'no-referrer', '/login 带 Referrer-Policy');
                c.ok(login.headers.get('x-content-type-options') === 'nosniff', '/login 带 X-Content-Type-Options');

                const home = await fetch(`http://127.0.0.1:${PORT}/`);
                c.ok(home.status === 200, '首页仍可访问', '实得 ' + home.status);
                c.ok(home.headers.get('x-frame-options') === 'DENY', '首页带 X-Frame-Options: DENY');

                // ⑦ 本机访问本机服务（Ollama 场景）必须仍然放行
                const relayLocal = await fetch(`http://127.0.0.1:${PORT}/api/relay`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ url: `http://127.0.0.1:${PORT}/api/server-info`, method: 'GET', timeoutMs: 5000 }),
                });
                const relayBody = await relayLocal.json().catch(() => null);
                c.ok(!(relayBody && relayBody.relayError),
                    '本机经中转访问本机服务仍放行（否则 Ollama 会挂）',
                    relayBody && relayBody.message);
            }
        } finally {
            if (child) { child.kill(); await c.wait(300); child = null; }
            // 清理探针，别把仓库弄脏
            for (const f of readdirSync(path.join(ROOT, 'web'))) {
                if (f.startsWith(PROBE)) {
                    try { rmSync(path.join(ROOT, 'web', f), { force: true }); } catch { /* ignore */ }
                }
            }
        }

        // 第 2 节只验了函数本身；从局域网地址发请求才会走 handleRelay 的"非本机"分支，
        // 堵住"函数对、调用点没接上"的缺口。
        console.log('\n--- 4. 端到端：从局域网地址发起，SSRF 拦截必须真的生效 ---');
        {
            const LAN = lanAddress();
            if (!LAN) {
                // 没有非回环网卡时（极简容器）跳过，但明确说出来，不静默通过
                console.log('  SKIP  本机没有非回环 IPv4 网卡，无法构造"非本机来源"，本节跳过');
            } else {
                const port = await c.freePort();
                let kid = null;
                try {
                    kid = spawn(process.execPath, [SERVE], {
                        cwd: ROOT,
                        env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', DATA_DIR, LOG_DIR },
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                    let out = '';
                    kid.stdout.on('data', (d) => { out += d; });
                    kid.stderr.on('data', (d) => { out += d; });

                    let up = false;
                    for (let i = 0; i < 75; i++) {
                        try { const r = await fetch(`http://127.0.0.1:${port}/api/server-info`); if (r.status) { up = true; break; } }
                        catch { await c.wait(200); }
                    }
                    c.ok(up, '服务已就绪（本机回环）', up ? '' : out.slice(-400));

                    if (up) {
                        // 没设访问密码时局域网接口直接关闭：非回环连接被直接销毁，不回"没有密码"
                        let lanClosed = false;
                        try { await fetch(`http://${LAN}:${port}/api/server-info`); }
                        catch { lanClosed = true; }
                        c.ok(lanClosed, '未设置访问密码时局域网接口直接关闭（非回环连接被拒）');

                        const TEST_PWD = 'CheckSec1234';
                        const setPwd = await fetch(`http://127.0.0.1:${port}/api/auth/change-password`, {
                            method: 'POST', headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ next: TEST_PWD }),
                        });
                        c.ok(setPwd.status === 200, '本机设置访问密码成功（局域网才开始可用）', 'HTTP ' + setPwd.status);
                        // 改密码清空所有会话，但当前设备刚设完密码必须直接拿到新会话（否则被踢回登录页）
                        const setPwdCookies = setPwd.headers.getSetCookie?.() || [];
                        c.ok(setPwdCookies.some((x) => /^elaina_session=/.test(x)),
                            '改密码后当前设备直接拿到新会话（不必重复输密码）', setPwdCookies.join(' | '));

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
                        // 会掩盖 SSRF 判定失效；Ollama 这类只住 127.0.0.1、无别的防护的才是真实威胁。
                        const SECRET = 'INTERNAL-SECRET-DO-NOT-LEAK';
                        const internal = createHttpServer((req, res) => {
                            res.writeHead(200, { 'content-type': 'text/plain' });
                            res.end(SECRET);
                        });
                        const internalPort = await c.freePort();
                        await new Promise((r) => internal.listen(internalPort, '127.0.0.1', r));

                        try {
                            // 这些必须被拦：前两条连的就是 127.0.0.1，解析成 IP 再规范化判定才拦得住
                            const mustBlock = [
                                `http://127.0.0.1:${internalPort}/`,
                                `http://[::ffff:127.0.0.1]:${internalPort}/`,
                                `http://[::ffff:7f00:1]:${internalPort}/`,
                                `http://${LAN}:${internalPort}/`,
                                'http://169.254.169.254/latest/meta-data/',
                            ];
                            for (const u of mustBlock) {
                                const r = await relay(u);
                                c.ok(Boolean(r.body && r.body.relayError),
                                    '★ 拦截非本机发起的 ' + u, 'HTTP ' + r.status + ' ' + (r.body && r.body.message || ''));
                            }

                            // 最强的一条：不看状态码，直接断言内网响应内容没经中转泄漏（拦截被绕过也不能泄密）
                            let leaked = false;
                            for (const u of [`http://[::ffff:127.0.0.1]:${internalPort}/`, `http://127.0.0.1:${internalPort}/`]) {
                                const r = await relay(u);
                                if (String(r.raw || '').includes(SECRET)) leaked = true;
                            }
                            c.ok(!leaked, '★ 内网服务的内容没有经中转泄漏出来（SSRF 实质被挡住）');

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

                            // ① 未登录 + allowOutside=true 必须被拦：认证是唯一那道门，不能被布尔字段绕过
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

                            // ③ 反向断言：已登录的局域网设备可以操作电脑（刻意放开并钉住，防止被当作 bug 撤销）；
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
                } finally {
                    if (kid) { kid.kill(); await c.wait(300); }
                }
            }
        }
    } finally {
        if (child) { try { child.kill(); } catch { /* ignore */ } }
        // 探针可能还残留（用例中途抛异常时），这里再收一次
        try {
            for (const f of readdirSync(path.join(ROOT, 'web'))) {
                if (f.startsWith('__sec_probe')) {
                    try { rmSync(path.join(ROOT, 'web', f), { force: true }); } catch { /* ignore */ }
                }
            }
        } catch { /* web/ 读不到就没什么要清的 */ }
        rmSync(LOG_DIR, { recursive: true, force: true });
        rmSync(DATA_DIR, { recursive: true, force: true });
    }
}

// 2. 登录防爆破 + 密码强度：密码是电脑操作权限的唯一那道门，规则与锁定策略都要有回归保护。
// 时钟是注入的，锁定断言毫秒内跑完，不用真等。

async function caseAuthGuard(c) {
    const {
        createLoginGuard, validatePasswordStrength, PWD_MIN_LEN, PWD_MAX_LEN, __test__,
    } = await import(new URL('../server/auth-guard.mjs', import.meta.url));

    console.log('--- 1. 密码强度规则（至少 8 位 + 数字 + 大小写） ---');
    {
        // 夹具刻意不用"弱口令+尾数"写法当合格样本，避免把规则往松的方向逼。
        const good = [
            'Elaina2024', 'MyPc-2024', 'aB3xY9zQ', 'Str0ngPassword', 'x7Kp2mNq',
            'Weather7Sun', 'DeepSeek8Ai', 'Zz9!aaaa', 'Tr4velBug',
        ];
        const rejected = [];
        for (const p of good) {
            const r = validatePasswordStrength(p);
            if (!r.ok) rejected.push(`${p}（被误拒：${r.message}）`);
        }
        c.ok(rejected.length === 0, `合格密码全部通过（${good.length} 条）`, rejected.join('; '));

        c.ok(validatePasswordStrength('Ab1').ok === false, '少于 8 位被拒');
        c.ok(validatePasswordStrength('Abc123').ok === false, '6 位被拒（旧规则允许，本轮收紧）');
        c.ok(validatePasswordStrength('Abc1234').ok === false, '7 位仍被拒（边界）');
        c.ok(validatePasswordStrength('Abcd1234').ok === false, '8 位但属弱口令表 → 拒');
        c.ok(validatePasswordStrength('xKp7mNq2').ok === true, '8 位且字符够杂 → 通过（下界）');
        c.ok(validatePasswordStrength('A1' + 'b'.repeat(PWD_MAX_LEN)).ok === false, '超长被拒');

        c.ok(validatePasswordStrength('abcdefg1').ok === false, '缺大写被拒');
        c.ok(validatePasswordStrength('ABCDEFG1').ok === false, '缺小写被拒');
        c.ok(validatePasswordStrength('Abcdefgh').ok === false, '缺数字被拒');
        {
            const m = validatePasswordStrength('abcdefg1').message;
            c.ok(/大写/.test(m), '缺大写时提示里点名"大写"', m);
            const m2 = validatePasswordStrength('ABCDEFG1').message;
            c.ok(/小写/.test(m2), '缺小写时提示里点名"小写"', m2);
            const m3 = validatePasswordStrength('Abcdefgh').message;
            c.ok(/数字/.test(m3), '缺数字时提示里点名"数字"', m3);
        }

        c.ok(validatePasswordStrength('11111111').ok === false, '纯重复字符被拒（且缺大小写）');
        c.ok(validatePasswordStrength('Aaa1aaaa').ok === false, '★ 字符种类太少被拒（Aaa1aaaa 只有 3 种字符）');
        c.ok(validatePasswordStrength('12345678aA').ok === false, '数字顺子+尾缀被拒');
        c.ok(validatePasswordStrength('1234567890aA').ok === false, '完整数字顺子被拒');
        c.ok(validatePasswordStrength('Qwertyui1A').ok === false, '键盘序+尾缀被拒');
        c.ok(validatePasswordStrength('password').ok === false, '常见弱口令被拒');
        c.ok(validatePasswordStrength('Password123').ok === false, '弱口令表命中（忽略大小写）');
        c.ok(validatePasswordStrength('ADMIN123a').ok === false, 'admin123 大小写变体被拒');
        c.ok(validatePasswordStrength('Abc12345').ok === false, 'abc12345 命中弱口令表');
        c.ok(validatePasswordStrength('admin123aA').ok === false, '★ 弱口令加一位后缀也被拒');

        c.ok(validatePasswordStrength('Aa1!aaaa').ok === true, '含特殊字符的正常密码通过');
        c.ok(validatePasswordStrength('   ').ok === false, '空白被拒');
        c.ok(validatePasswordStrength('').ok === false, '空串被拒');
        c.ok(validatePasswordStrength(null).ok === false, 'null 不抛异常，按不通过处理');
        c.ok(validatePasswordStrength(undefined).ok === false, 'undefined 不抛异常');
        c.ok(validatePasswordStrength(12345678).ok === false, '数字类型不抛异常');
        c.ok(PWD_MIN_LEN === 8, '最短长度常量是 8', String(PWD_MIN_LEN));

        // 弱口令表本身要有一定规模（否则防不住"图省事"的常见选择）
        c.ok(__test__.WEAK_PASSWORDS.size >= 20, '弱口令表有足够条目', String(__test__.WEAK_PASSWORDS.size));
    }

    console.log('\n--- 2. 登录失败锁定：单 IP 指数退避 ---');
    {
        let now = 1_000_000;
        const g = createLoginGuard({ now: () => now, maxFails: 5, baseLockMs: 30_000, maxLockMs: 3_600_000, globalMaxFails: 9999 });

        for (let i = 1; i <= 4; i++) {
            g.fail('1.2.3.4');
            c.ok(g.status('1.2.3.4').blocked === false, `第 ${i} 次失败后仍未锁定（阈值 5）`);
        }
        g.fail('1.2.3.4');
        let st = g.status('1.2.3.4');
        c.ok(st.blocked === true, '第 5 次失败后锁定');
        c.ok(st.retryAfterSec === 30, '首次锁定 30 秒', String(st.retryAfterSec));

        c.ok(g.status('5.6.7.8').blocked === false, '其它 IP 不受影响（按 IP 隔离）');

        now += 31_000;                       // 首次锁定已过期
        c.ok(g.status('1.2.3.4').blocked === false, '锁定到期后放行（但计数未清零）');
        g.fail('1.2.3.4');                   // 第 6 次
        st = g.status('1.2.3.4');
        c.ok(st.blocked === true, '第 6 次失败再次锁定');
        c.ok(st.retryAfterSec === 60, '★ 第二次锁定翻倍到 60 秒（指数退避）', String(st.retryAfterSec));

        now += 61_000;
        g.fail('1.2.3.4');                   // 第 7 次
        st = g.status('1.2.3.4');
        c.ok(st.retryAfterSec === 120, '★ 第三次锁定 120 秒（继续翻倍）', String(st.retryAfterSec));

        // ★ 计数只在成功时清零：这是"越试越久"的关键。
        //   若到期即归零，攻击者每轮都能拿满 5 次机会，指数退避形同虚设。
        now += 121_000;
        g.fail('1.2.3.4');                   // 第 8 次（若不累积，这里只会锁 30 秒）
        st = g.status('1.2.3.4');
        c.ok(st.retryAfterSec === 240, '★ 锁定到期不清零计数（第 8 次锁 240 秒）', String(st.retryAfterSec));

        g.succeed('1.2.3.4');
        c.ok(g.status('1.2.3.4').blocked === false, '登录成功后解锁');
        for (let i = 1; i <= 4; i++) g.fail('1.2.3.4');
        c.ok(g.status('1.2.3.4').blocked === false, '成功清零后重新从 0 计数（手滑的用户不会被越锁越久）');

        let t2 = 0;
        const g2 = createLoginGuard({ now: () => t2, maxFails: 2, baseLockMs: 1000, maxLockMs: 8000, globalMaxFails: 9999 });
        for (let i = 0; i < 20; i++) { g2.fail('9.9.9.9'); t2 += 100_000; }
        g2.fail('9.9.9.9');
        const capped = g2.status('9.9.9.9').retryAfterSec;
        c.ok(capped <= 8, '★ 锁定时间封顶（不会无限翻倍到把用户永久锁死）', String(capped));
    }

    console.log('\n--- 3. 全局限流：换 IP 也挡得住 ---');
    {
        let now = 5_000_000;
        const g = createLoginGuard({
            now: () => now, maxFails: 3, baseLockMs: 30_000,
            globalMaxFails: 10, globalLockMs: 300_000,
        });

        // 用 10 个不同 IP 各失败 1 次（每个都没到自己 3 次的阈值）
        for (let i = 0; i < 10; i++) g.fail('10.0.0.' + i);
        const st = g.status('10.0.0.99');
        c.ok(st.blocked === true, '★ 多 IP 分散失败后触发全局冻结（换 IP 绕不过）');
        c.ok(st.scope === 'global', '冻结范围标记为 global', JSON.stringify(st));
        c.ok(st.retryAfterSec === 300, '全局冻结 300 秒', String(st.retryAfterSec));

        c.ok(g.status('192.168.1.50').blocked === true, '冻结期间正常来源同样被挡（全局限流固有的代价）');

        now += 301_000;
        c.ok(g.status('192.168.1.50').blocked === false, '全局冻结到期后恢复');

        // reset 清空（改密码时调用）
        g.reset();
        c.ok(g.status('10.0.0.1').blocked === false, 'reset 后所有锁定被清空');
    }

    console.log('\n--- 4. serve.mjs 接线：别只在模块里正确 ---');
    {
        const { readFileSync } = await import('node:fs');
        const serve = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');

        // 模块被真正 import，而不是定义了没人用
        c.ok(/createLoginGuard/.test(serve), 'serve.mjs 引入了 createLoginGuard');
        c.ok(/validatePasswordStrength/.test(serve), 'serve.mjs 引入了 validatePasswordStrength');
        c.ok(/const loginGuard = createLoginGuard\(\)/.test(serve), '创建了全局守卫实例');
        c.ok(/loginGuard\.status\(ip\)/.test(serve), 'handleLogin 先查锁定状态');
        c.ok(/loginGuard\.fail\(ip\)/.test(serve), '密码错误时记失败');
        c.ok(/loginGuard\.succeed\(ip\)/.test(serve), '登录成功时清零');
        c.ok(/loginGuard\.reset\(\)/.test(serve), '改密码后清空失败记录');

        c.ok(!/LOGIN_MAX_FAILS/.test(serve), '★ 旧的固定窗口常量 LOGIN_MAX_FAILS 已移除');
        c.ok(!/loginFails/.test(serve), '★ 旧的 loginFails Map 已移除');
        c.ok(/Retry-After/.test(serve), '被拦时回 Retry-After 头（客户端可据此退避）');

        c.ok(/const strength = validatePasswordStrength\(next\)/.test(serve),
            '★ 改密码走了强度校验');
        c.ok(!/next\.length < 6/.test(serve), '★ 旧的"至少 6 位"规则已移除');

        // 局域网放开的落点：privileged 不能再是"仅本机"
        c.ok(/function hasComputerGrant\(request\)/.test(serve), '有 hasComputerGrant（操作电脑的授权判据）');
        c.ok(/return isAuthenticated\(request\)/.test(serve), '★ 授权判据是"已认证"（本机或已登录），不再是"仅本机"');
        c.ok(/const privileged = hasComputerGrant\(request\)/.test(serve), '路由里用 hasComputerGrant 计算 privileged');
        // 不能还有"agent 操作仍按 isLocal 判定"的残留
        const agentSection = serve.slice(serve.indexOf('const privileged = hasComputerGrant'), serve.indexOf('/favicon.ico'));
        c.ok(!/agentExec\(request, response, isLocal\)/.test(agentSection),
            '★ /api/agent/exec 不再按 isLocal 判定（否则局域网放开是假的）');
        c.ok(/agentExec\(request, response, privileged\)/.test(agentSection), '/api/agent/exec 按 privileged 判定');
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

    // 端口必须向内核要：写死端口并行跑会互撞，表现为与产品无关的失败
    const PORT = await c.freePort();
    const server = spawn(process.execPath, ['web/serve.mjs'], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(PORT), DATA_DIR: dataDir, LOG_DIR: path.join(sandbox, 'logs'),
            MODS_DIR: modsDir, SKILLS_DIR: skillsDir, LOG_TO_FILE: '0', LOG_CHAT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bootLog = '';
    server.stdout.on('data', (d) => { bootLog += d; });
    server.stderr.on('data', (d) => { bootLog += d; });

    try {
        const base = `http://127.0.0.1:${PORT}`;
        let up = false;
        for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
            try { if ((await fetch(base + '/api/server-info')).ok) { up = true; break; } } catch { /* 等 */ }
            await new Promise((r) => setTimeout(r, 300));
        }
        // 起不来时不直接 process.exit（会吞掉其余用例），记 FAIL 后跳过本节断言
        c.ok(up, '服务已启动（导出接口要打真实服务）', up ? '' : bootLog.slice(0, 800));

        if (up) {
            const r = await fetch(base + '/api/data/export');
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
        server.kill();
        await new Promise((r) => setTimeout(r, 400));
        await rm(sandbox, { recursive: true, force: true }).catch(() => {});
    }
}

// 按命令行参数过滤用例（便于只跑其中一段）
const only = process.argv[2];
const allCases = [
    { name: '写入黑名单与内网判定', fn: caseSecurityHardening },
    { name: '登录防爆破与密码强度', fn: caseAuthGuard },
    { name: '数据导出下载方式', fn: caseExportDownload },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;
if (only && !cases.length) {
    console.log('没有名字含 ' + JSON.stringify(only) + ' 的用例。可选：' + allCases.map((x) => x.name).join(' / '));
}

await runChecks({
    title: '安全（写入黑名单 / 内网判定 / 防嵌套头 / 登录防爆破 / 导出下载）',
    usage: 'node scripts/check-security.mjs [用例名子串]',
    cases,
});

