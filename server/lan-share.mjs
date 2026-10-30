/* ============================================================================
 * 局域网共享数据（宿主内嵌，配套「高级 → 我的数据」）
 *
 * 两个动作：
 *   ① 开启局域网共享：把本机标记为"可被局域网设备拉取备份"，并给出本机
 *      IP / 端口；标记默认 30 分钟后自动失效。
 *   ② 从局域网接收：本机服务先登录对方（拿 Set-Cookie），再取对方的
 *      /api/data/lan/export，回传给前端交给现有 /api/data/import 合并导入。
 *
 * 为什么不让浏览器直接跨源去拉：
 *   浏览器跨源会撞 CORS，且访问密码产生的会话是 SameSite=Strict，跨站
 *   请求带不过去；由服务端代发才能走通。
 *
 * 为什么"开启共享"要单独一个开关：
 *   /api/data/lan/export 只有在开关打开时才返回备份。这样"开启"不是一句
 *   提示，而是真的决定对方能不能取到数据。
 *
 * 安全：
 *   · 只有本机设置过访问密码后才允许开启共享 —— 未设置时 serve.mjs 直接关闭局域网接口
 *     （非回环连接在进入 HTTP 前就被销毁），这里再拒绝一次开启。
 *   · 接收端只允许私网 / 回环地址（域名解析后逐个校验，挡 SSRF）。
 * ========================================================================== */
import os from 'node:os';
import net from 'node:net';
import dns from 'node:dns/promises';
import { jsonResponse, readJsonBody } from './http-util.mjs';

/** 本模块占用的接口前缀（serve.mjs 用它判断要不要交给这里处理） */
export const LAN_SHARE_PREFIX = '/api/data/lan';
/** 共享开关默认有效期 30 分钟：面对面传一份备份够用，又不会长期敞着 */
const SHARE_TTL_MS = 30 * 60 * 1000;
/** 宿主导入上限拿不到时的保底值（正常走 maxUpload） */
const MAX_PACKAGE_FALLBACK = 200 * 1024 * 1024;
/** 拉取对方数据的超时（备份可能几十 MB，给宽一点） */
const PULL_TIMEOUT_MS = 120000;
/** 登录对方的超时 */
const LOGIN_TIMEOUT_MS = 15000;

export function createLanShare({ collectBackup, maxUpload, isPasswordSet = () => false, log = () => {} }) {
    if (typeof collectBackup !== 'function') throw new Error('createLanShare 需要 collectBackup()');
    const maxPackageBytes = Number(maxUpload) > 0 ? Number(maxUpload) : MAX_PACKAGE_FALLBACK;
    /** 共享开关的到期时间（0 = 未开启）。只在内存里，重启即关闭。 */
    let shareUntil = 0;

    function isSharing() {
        return shareUntil > Date.now();
    }

    /** 这台机器在局域网里的可达地址（只列非回环 IPv4；IPv6 手输场景少） */
    function lanAddresses() {
        const out = [];
        const ifaces = os.networkInterfaces();
        for (const [name, list] of Object.entries(ifaces)) {
            for (const info of list || []) {
                const family = typeof info.family === 'string' ? info.family : String(info.family);
                if (family !== 'IPv4' && family !== '4') continue;
                if (info.internal) continue;
                out.push({ label: name, ip: info.address });
            }
        }
        return out;
    }

    function shareInfo(req) {
        const port = req.socket && req.socket.localPort ? Number(req.socket.localPort) : 0;
        return {
            addresses: lanAddresses().map((a) => ({ label: a.label, ip: a.ip, port, url: 'http://' + a.ip + ':' + port })),
            port,
            expiresAt: shareUntil,
        };
    }

    async function fetchWithTimeout(url, options, ms) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        try {
            return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
        } catch (err) {
            if (err && err.name === 'AbortError') throw new Error('连接对方超时');
            const cause = err && err.cause ? err.cause.message : '';
            throw new Error('连不上对方：' + (cause || (err && err.message) || String(err)));
        } finally {
            clearTimeout(timer);
        }
    }

    function isIpv4(value) {
        return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
    }

    /**
     * 只允许私网/回环地址。
     *
     * 这个接口是"由服务端代发请求"，不设边界就会变成任意 SSRF 跳板：已登录的
     * 用户可以让服务端去访问公网、甚至云厂商元数据地址。局域网共享只需要内网
     * 可达地址，所以这里把范围收死；域名要解析后**每个**地址都在内网才放行。
     */
    function isPrivateAddress(raw) {
        let ip = String(raw || '').trim().toLowerCase();
        if (ip.startsWith('::ffff:')) ip = ip.slice(7);
        if (ip === '::1' || ip === 'localhost') return true;
        if (isIpv4(ip)) {
            const p = ip.split('.').map((n) => Number(n));
            if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
            if (p[0] === 10 || p[0] === 127) return true;
            if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
            if (p[0] === 192 && p[1] === 168) return true;
            if (p[0] === 169 && p[1] === 254) return ip !== '169.254.169.254';
            if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
            return false;
        }
        if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
        if (/^fe[89ab]/.test(ip)) return true;
        return false;
    }

    async function targetIsPrivate(hostname) {
        const host = String(hostname || '').trim().toLowerCase();
        if (host === 'localhost') return true;
        if (net.isIP(host)) return isPrivateAddress(host);
        let addrs = [];
        try {
            addrs = await dns.lookup(host, { all: true });
        } catch {
            return false;
        }
        if (!addrs.length) return false;
        return addrs.every((a) => isPrivateAddress(a.address));
    }

    /** 解析用户填的地址：接受 ip:port 或 http://ip:port */
    function parseSource(raw) {
        let text = String(raw || '').trim();
        if (!text) return null;
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'http://' + text;
        let u;
        try { u = new URL(text); } catch { return null; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return { base: u.origin };
    }

    function readSetCookie(res) {
        try {
            if (typeof res.headers.getSetCookie === 'function') {
                const list = res.headers.getSetCookie();
                if (list && list.length) return String(list[0]).split(';')[0];
            }
        } catch { /* 老运行时没有 getSetCookie */ }
        const raw = res.headers.get('set-cookie') || '';
        if (!raw) return '';
        return raw.split(';')[0];
    }

    function stampName() {
        const t = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        return 'elainachat-backup-' + t + '.zip';
    }

    // ── 接口 ──────────────────────────────────────────────────────────────

    async function handleEnable(req, res) {
        if (!isPasswordSet()) {
            return jsonResponse(res, 400, {
                ok: false,
                code: 'PASSWORD_NOT_SET',
                message: '还没有设置访问密码。请先在「访问密码（局域网）」里设置密码，局域网设备才能连接。',
            });
        }
        shareUntil = Date.now() + SHARE_TTL_MS;
        log('已开启局域网共享，' + Math.round(SHARE_TTL_MS / 60000) + ' 分钟后自动关闭');
        return jsonResponse(res, 200, { ok: true, share: shareInfo(req) });
    }

    async function handleExport(req, res) {
        if (!isSharing()) {
            return jsonResponse(res, 403, { ok: false, code: 'SHARE_OFF', message: '对方未开启局域网共享（或已过期），请让对方重新点「开启局域网共享」' });
        }
        let buf;
        try {
            buf = await collectBackup();
        } catch (err) {
            const msg = String((err && err.message) || err);
            log('导出失败：' + msg);
            return jsonResponse(res, 500, { ok: false, message: '导出失败：' + msg });
        }
        if (!Buffer.isBuffer(buf) || !buf.length) return jsonResponse(res, 500, { ok: false, message: '导出失败：备份为空' });
        if (buf.length > maxPackageBytes) return jsonResponse(res, 413, { ok: false, message: '备份超过 ' + Math.round(maxPackageBytes / 1024 / 1024) + ' MB 上限' });
        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': buf.length,
            'X-Backup-Filename': stampName(),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        return res.end(buf);
    }

    async function handlePull(req, res) {
        let body = {};
        try { body = await readJsonBody(req); } catch { body = {}; }
        const parsed = parseSource(body && body.sourceUrl);
        if (!parsed) return jsonResponse(res, 400, { ok: false, message: '对方地址无效，例：192.168.1.5:3999 或 http://192.168.1.5:3999' });
        if (!(await targetIsPrivate(new URL(parsed.base).hostname))) {
            return jsonResponse(res, 403, { ok: false, message: '只允许从局域网内网地址导入（不支持公网地址）' });
        }

        const password = String((body && body.password) || '');
        let cookie = '';
        try {
            if (password) {
                const login = await fetchWithTimeout(parsed.base + '/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password }),
                }, LOGIN_TIMEOUT_MS);
                if (login.status === 401) return jsonResponse(res, 401, { ok: false, message: '对方访问密码不正确' });
                if (login.status === 429) return jsonResponse(res, 429, { ok: false, message: '对方登录尝试过多，请稍后再试' });
                if (login.status === 403) {
                    let detail = '';
                    try { const j = await login.json(); detail = j && j.message ? String(j.message) : ''; } catch { /* 忽略 */ }
                    return jsonResponse(res, 403, { ok: false, message: detail || '对方还没有设置访问密码，局域网设备暂时不能使用' });
                }
                if (!login.ok) return jsonResponse(res, 502, { ok: false, message: '登录对方失败（HTTP ' + login.status + '）' });
                cookie = readSetCookie(login);
            }

            const headers = cookie ? { Cookie: cookie } : {};
            const remote = await fetchWithTimeout(parsed.base + '/api/data/lan/export', { method: 'GET', headers, redirect: 'manual' }, PULL_TIMEOUT_MS);
            if (remote.status === 401) return jsonResponse(res, 401, { ok: false, message: '对方要求访问密码（密码为空或不正确）' });
            if (remote.status === 403) {
                let detail = '';
                try { const j = await remote.json(); detail = j && j.message ? String(j.message) : ''; } catch { /* 忽略 */ }
                return jsonResponse(res, 403, { ok: false, message: detail || '对方未开启局域网共享' });
            }
            if (remote.status >= 300 && remote.status < 400) return jsonResponse(res, 502, { ok: false, message: '对方返回了跳转（HTTP ' + remote.status + '），请检查地址是否带了协议/端口' });
            if (!remote.ok) {
                let detail = '';
                try { const j = await remote.json(); detail = j && j.message ? String(j.message) : ''; } catch { /* 忽略 */ }
                return jsonResponse(res, 502, { ok: false, message: detail || ('对方返回 HTTP ' + remote.status) });
            }
            const declared = Number(remote.headers.get('content-length') || 0);
            if (declared > maxPackageBytes) return jsonResponse(res, 413, { ok: false, message: '对方备份超过 ' + Math.round(maxPackageBytes / 1024 / 1024) + ' MB 上限' });
            const buf = Buffer.from(await remote.arrayBuffer());
            if (!buf.length) return jsonResponse(res, 502, { ok: false, message: '对方返回了空内容' });
            if (buf.length > maxPackageBytes) return jsonResponse(res, 413, { ok: false, message: '对方备份超过 ' + Math.round(maxPackageBytes / 1024 / 1024) + ' MB 上限' });

            res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Length': buf.length,
                'X-Backup-Filename': stampName(),
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            });
            return res.end(buf);
        } catch (err) {
            return jsonResponse(res, 502, { ok: false, message: '从对方拉取失败：' + String((err && err.message) || err) });
        }
    }

    /**
     * 分发一条局域网共享接口。返回 true 表示已处理（响应已写出）。
     * 调用位置：宿主 /api/data/* 路由段内，早于插件路由与静态文件。
     */
    async function handle(request, response, info) {
        const pathname = info && info.pathname;
        if (pathname === LAN_SHARE_PREFIX + '/enable' && request.method === 'POST') { await handleEnable(request, response); return true; }
        if (pathname === LAN_SHARE_PREFIX + '/export' && request.method === 'GET') { await handleExport(request, response); return true; }
        if (pathname === LAN_SHARE_PREFIX + '/pull' && request.method === 'POST') { await handlePull(request, response); return true; }
        return false;
    }

    return { handle };
}
