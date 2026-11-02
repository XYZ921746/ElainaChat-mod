// 版本检测（GitHub Releases）—— 设置 → 高级「版本与更新」的数据来源。
//
// 单独成模块的理由与 relay / mcp-http-client 一致：纯逻辑、可注入 fetch / DNS / 时钟、
// 能穷举断言。它放在服务端而不是前端是为了几件事：
//   ① 带 User-Agent 发请求（浏览器 fetch 不能设 UA，GitHub API 缺 UA 会被拒）；
//   ② 十分钟缓存 —— 未登录的 GitHub 接口每小时只有 60 次，手动点几次不该把它用完；
//   ③ 把网络失败的英文错误翻成可操作的中文原因（DNS / 超时 / TLS / 限流）；
//   ④ 直连失败时用**公共 DNS 解析真实 IP 后直连**，绕开 hosts 劫持，且不改系统设置。
//
// 它只做**检测**，不做自我更新：三个运行形态（安卓 APK / 桌面版 exe 壳 / 电脑版源码）
// 的安装方式各不相同，由前端按运行形态给出对应安装包的下载入口。
// 详情见 web/js/update-check.js。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import https from 'node:https';

const API_ROOT = 'https://api.github.com/repos/';
/** 直连 IP 时 TLS 仍按这个主机名校验证书 —— 公共 DNS 返回假 IP 也拿不到合法证书。 */
const API_HOST = 'api.github.com';

/** 默认仓库：与 README 的下载入口同源。 */
export const DEFAULT_REPO = 'XYZ921746/ElainaChat-mod';
/** 缓存时长：够了 —— 用户点两次「检查更新」之间不可能有两次发版。 */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** 单次请求上限：GitHub 正常 1 秒内返回；连不上时不该让用户干等。 */
export const DEFAULT_TIMEOUT_MS = 8000;
/** 公共 DNS：只用来解析 api.github.com（hosts 被加速工具劫持时系统解析必失败）。 */
export const PUBLIC_DNS_SERVERS = ['223.5.5.5', '119.29.29.29', '1.1.1.1'];

/**
 * 校验 owner/repo 形状。
 * 必须校验而不是拼字符串硬发：它最终会成为请求 URL 的一部分，
 * 一段 ../../ 之类就能把请求带到别的接口上。
 */
export function isValidRepo(repo) {
    const parts = String(repo || '').trim().split('/');
    if (parts.length !== 2) return false;
    // 纯点段（. / ..）会让 URL 在解析时向上跳目录，必须单独挡掉
    return parts.every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && !/^\.+$/.test(p));
}

/**
 * 保留给"直连 IP"用的公网 IPv4 判定。
 * 为什么必须过滤：公共 DNS 也可能被污染成 127.0.0.1 / 内网地址，
 * 那样直连就变成打本机服务，比"检测失败"更糟（会把本地服务的响应当成 GitHub 的回包）。
 */
export function isPublicIPv4(ip) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
    if (!m) return false;
    const parts = m.slice(1, 5).map(Number);
    if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
    const a = parts[0], b = parts[1];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
}

/**
 * 在 hosts 文本里找"把某个主机名指到本机/黑洞"的行。
 * 纯函数：检查脚本直接喂文本断言，不去碰真实系统文件。
 *
 * @returns {null | {line:number, ip:string, text:string}}
 */
export function findHostsHijack(text, host) {
    const lines = String(text || '').split(/\r?\n/);
    const wanted = String(host || '').toLowerCase();
    for (let i = 0; i < lines.length; i++) {
        const body = lines[i].replace(/#.*$/, '').trim();
        if (!body) continue;
        const parts = body.split(/\s+/);
        if (parts.length < 2) continue;
        const ip = parts[0];
        if (!/^(127\.|::1$|0\.0\.0\.0$)/.test(ip)) continue;
        if (parts.slice(1).some((h) => h.toLowerCase() === wanted)) {
            return { line: i + 1, ip, text: lines[i].trim() };
        }
    }
    return null;
}

/** 读系统 hosts（Windows 与类 Unix 各一条路径）。读不到返回 null，不抛错。 */
export function readHostsFile(filePath) {
    const candidates = filePath ? [filePath] : (process.platform === 'win32'
        ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')]
        : ['/etc/hosts']);
    for (const p of candidates) {
        try { return { path: p, text: readFileSync(p, 'utf8') }; } catch { /* 换下一个 */ }
    }
    return null;
}

/**
 * 把 GitHub 的 release 对象收敛成前端要用的最小形状。
 *
 * 为什么先收敛再返回：GitHub 的 release JSON 有 40+ 字段（作者对象、上传者、
 * reactions…），其中很多带用户可控文本。前端只渲染我们点名保留的字段，
 * 就不会因为 GitHub 哪天往响应里加东西而多出一块没审查过的渲染面。
 *
 * @returns {null | {tag,name,url,publishedAt,notes,prerelease,sourceZip,assets}}
 */
export function sanitizeRelease(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const tag = String(raw.tag_name || '').trim();
    if (!tag) return null;
    const assets = (Array.isArray(raw.assets) ? raw.assets : []).slice(0, 40).map((a) => ({
        name: String((a && a.name) || '').slice(0, 200),
        url: String((a && (a.browser_download_url || a.url)) || ''),
        size: Number((a && a.size) || 0),
    })).filter((a) => a.name && /^https:\/\//i.test(a.url));
    return {
        tag,
        name: String(raw.name || tag).slice(0, 200),
        url: String(raw.html_url || ''),
        publishedAt: String(raw.published_at || ''),
        notes: String(raw.body || '').slice(0, 20000),
        prerelease: raw.prerelease === true,
        sourceZip: String(raw.zipball_url || ''),
        assets,
    };
}

/**
 * 把网络层失败翻成用户能照着做的中文原因。
 *
 * 为什么不能直接把 err.message 给用户：Node 的 fetch 失败顶层只有
 * fetch failed 四个字，真正的原因在 err.cause 里（undici 的包装）。
 * 用户看到这四个字既不知道是 DNS、证书还是超时，也不知道下一步做什么。
 */
export function describeFetchError(err) {
    const name = String((err && err.name) || '');
    const cause = (err && err.cause) || null;
    const text = [
        String((err && err.message) || ''),
        String((cause && cause.code) || ''),
        String((cause && cause.message) || ''),
    ].join(' ');
    if (name === 'TimeoutError' || name === 'AbortError') {
        return { code: 'TIMEOUT', message: '连接 GitHub 超时（网络不稳定或需要代理）' };
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) {
        return { code: 'DNS', message: '域名解析失败（api.github.com 解析不到，检查网络或 hosts）' };
    }
    if (/ECONNREFUSED/i.test(text)) {
        return { code: 'REFUSED', message: '连接被拒绝（本地有代理或 hosts 把 GitHub 指到了本机？）' };
    }
    if (/CERT|UNABLE_TO_GET_ISSUER|self.signed|SSL|TLS|EPROTO|ECONNRESET|socket hang up/i.test(text)) {
        return { code: 'TLS', message: 'HTTPS 连接失败（证书校验或 TLS 握手被中断）' };
    }
    return { code: 'NETWORK', message: '网络请求失败：' + (String((err && err.message) || '未知错误')).slice(0, 120) };
}

/** 哪几类失败值得"换公共 DNS 直连 IP"再试一次（HTTP 层错误与配置错误不值得）。 */
const BYPASSABLE = new Set(['TIMEOUT', 'DNS', 'REFUSED', 'TLS', 'NETWORK']);

/** GitHub 限流时把 reset 时间翻成约几分钟后。 */
function rateLimitMessage(headers, nowMs) {
    const reset = Number(headers && headers.get && headers.get('x-ratelimit-reset'));
    if (!Number.isFinite(reset) || reset <= 0) return 'GitHub 接口限流（未登录每小时 60 次），请稍后再试';
    const minutes = Math.max(1, Math.ceil((reset * 1000 - nowMs) / 60000));
    return 'GitHub 接口限流（未登录每小时 60 次），约 ' + minutes + ' 分钟后可再试';
}

function withTimeout(promise, ms) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        // 定时器不能 unref：等待期间没有别的句柄时事件循环会直接退出，
        // 表现成 Detected unsettled top-level await（见 MCP 客户端踩过的同一个坑）。
        timer = setTimeout(() => {
            const e = new Error('timeout');
            e.name = 'TimeoutError';
            reject(e);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/** 用公共 DNS 解析主机名（绕开系统 hosts），只要公网 IPv4。 */
export async function resolvePublicIPv4(host, servers = PUBLIC_DNS_SERVERS, timeoutMs = 3000) {
    for (const server of servers) {
        try {
            const resolver = new dns.promises.Resolver();
            resolver.setServers([server]);
            const addrs = await withTimeout(resolver.resolve4(host), timeoutMs);
            const hit = (addrs || []).find(isPublicIPv4);
            if (hit) return hit;
        } catch { /* 换下一台 DNS */ }
    }
    return '';
}

/**
 * 用 https.request + 自定义 lookup 直连指定 IP。
 *
 * lookup 被替换成"直接返回这个 IP"，于是系统 hosts / 系统 DNS 都不参与；
 * servername 仍是 api.github.com，证书按它校验 —— 公共 DNS 返回假 IP 时 TLS 会失败，
 * 不会把假 IP 的响应当成 GitHub 的数据。
 */
export function requestReleaseByIp(ip, url, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const userAgent = String(options.userAgent || 'ElainaChat-mod');
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { reject(e); return; }
        const req = https.request({
            protocol: 'https:',
            hostname: u.hostname,
            port: u.port || 443,
            path: (u.pathname || '/') + (u.search || ''),
            method: 'GET',
            servername: u.hostname,
            headers: {
                'Accept': 'application/vnd.github+json',
                'User-Agent': userAgent,
                'X-GitHub-Api-Version': '2022-11-28',
            },
            lookup(hostname, opts, callback) {
                if (opts && opts.all) return callback(null, [{ address: ip, family: 4 }]);
                return callback(null, ip, 4);
            },
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
                if (body.length > 512 * 1024) req.destroy(new Error('响应体过大'));
            });
            res.on('end', () => resolve({ status: Number(res.statusCode) || 0, headers: res.headers || {}, body }));
        });
        req.setTimeout(timeoutMs, () => {
            const e = new Error('timeout');
            e.name = 'TimeoutError';
            req.destroy(e);
        });
        req.on('error', reject);
        req.end();
    });
}

/** 把直连结果的文本包装成与 fetch Response 同形的对象，让后面的处理只有一条路。 */
function responseFromText(status, headers, text) {
    const lower = {};
    Object.keys(headers || {}).forEach((k) => { lower[k.toLowerCase()] = headers[k]; });
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => lower[String(name).toLowerCase()] || null },
        async json() { return JSON.parse(text); },
    };
}

/**
 * 创建一个带缓存的检测器。
 *
 * @param {object} [options]
 * @param {string} [options.repo] owner/repo（默认 DEFAULT_REPO）
 * @param {Function} [options.fetchImpl] 注入用（检查脚本传假 fetch，穷举失败分支）
 * @param {number} [options.ttlMs] 成功结果缓存时长
 * @param {number} [options.timeoutMs] 单次请求上限
 * @param {Function} [options.now] 注入时钟（缓存过期断言用）
 * @param {string} [options.userAgent] GitHub 要求的 UA；缺了会被 403
 * @param {boolean} [options.bypass] 直连失败后是否换公共 DNS 重试（默认 true）
 * @param {Function} [options.resolveIp] 注入解析（默认查公共 DNS）
 * @param {Function} [options.requestByIp] 注入直连请求（默认 https.request）
 * @param {Function} [options.readHosts] 注入 hosts 读取（默认读系统文件）
 */
export function createUpdateChecker(options = {}) {
    const repo = String(options.repo || process.env.ELAINA_UPDATE_REPO || DEFAULT_REPO).trim();
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const userAgent = String(options.userAgent || 'ElainaChat-mod');
    const bypass = options.bypass !== false;
    const readHosts = typeof options.readHosts === 'function' ? options.readHosts : readHostsFile;
    const resolveIp = typeof options.resolveIp === 'function'
        ? options.resolveIp
        : (url) => resolvePublicIPv4(new URL(url).hostname, options.dnsServers || PUBLIC_DNS_SERVERS, options.dnsTimeoutMs || 3000);
    const requestByIp = typeof options.requestByIp === 'function'
        ? options.requestByIp
        : (url, ip) => requestReleaseByIp(ip, url, { timeoutMs, userAgent });
    let cached = null;

    /** 统一处理一个 HTTP 响应（fetch 与直连两条路共用）。 */
    async function handleResponse(response, checkedAt, viaBypass) {
        const status = Number(response && response.status) || 0;
        if (status === 404) {
            return { ok: false, code: 'NO_RELEASE', message: '这个仓库还没有发布 Release（或仓库不存在）', checkedAt };
        }
        if (status === 403 || status === 429) {
            const remaining = response.headers && response.headers.get && response.headers.get('x-ratelimit-remaining');
            const message = remaining === '0' || status === 429
                ? rateLimitMessage(response.headers, checkedAt)
                : 'GitHub 拒绝了这次请求（HTTP ' + status + '，可能是网络出口被限制）';
            return { ok: false, code: 'RATE_LIMIT', message, checkedAt };
        }
        if (!response || !response.ok) {
            return { ok: false, code: 'HTTP', message: 'GitHub 返回 HTTP ' + (status || '未知'), checkedAt };
        }
        let raw = null;
        try { raw = await response.json(); } catch { raw = null; }
        const release = sanitizeRelease(raw);
        if (!release) {
            return { ok: false, code: 'BAD_RESPONSE', message: 'GitHub 返回的内容看不懂（可能接口变了）', checkedAt };
        }
        return { ok: true, checkedAt, repo, viaBypass: Boolean(viaBypass), release };
    }

    /** 直连失败的原因 +（若找得到）hosts 劫持证据。 */
    function failureWithHosts(info) {
        if (!BYPASSABLE.has(info.code)) return info;
        try {
            const hosts = readHosts();
            if (!hosts || !hosts.text) return info;
            const hit = findHostsHijack(hosts.text, API_HOST);
            if (!hit) return info;
            return Object.assign({}, info, {
                hostsFile: hosts.path,
                hostsLine: hit.line,
                message: info.message + '；检测到 ' + hosts.path + ' 第 ' + hit.line + ' 行把 '
                    + API_HOST + ' 指到了 ' + hit.ip + '（加速工具常见），可在该工具里放行或删掉这一行',
            });
        } catch { return info; }
    }

    async function fetchOnce() {
        const checkedAt = now();
        if (!isValidRepo(repo)) {
            return { ok: false, code: 'CONFIG', message: '更新检查的仓库名不合法：' + repo, checkedAt };
        }
        const url = API_ROOT + repo + '/releases/latest';
        let normalError = null;
        try {
            const response = await fetchImpl(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/vnd.github+json',
                    'User-Agent': userAgent,
                    'X-GitHub-Api-Version': '2022-11-28',
                },
                signal: AbortSignal.timeout(timeoutMs),
            });
            return await handleResponse(response, checkedAt, false);
        } catch (err) {
            normalError = describeFetchError(err);
        }

        // 直连失败：换公共 DNS 解析真实 IP 再直连一次。
        // 只在网络层失败时做（HTTP 层错误说明连接是通的，重试没意义）；
        // 不改 hosts、不改系统 DNS —— 这正是"本机环境限制"下不改设置也能继续的办法。
        if (bypass && BYPASSABLE.has(normalError.code)) {
            try {
                const ip = await resolveIp(url);
                if (ip) {
                    const raw = await requestByIp(url, ip);
                    const viaIp = await handleResponse(responseFromText(raw.status, raw.headers, raw.body), checkedAt, true);
                    if (viaIp.ok || viaIp.code === 'NO_RELEASE' || viaIp.code === 'RATE_LIMIT' || viaIp.code === 'HTTP' || viaIp.code === 'BAD_RESPONSE') {
                        return viaIp;
                    }
                }
            } catch { /* 绕过也失败：回到原始错误，并把 hosts 证据带上 */ }
        }
        return Object.assign({ ok: false, checkedAt }, failureWithHosts(normalError));
    }

    return {
        repo,
        /** 查最新 Release；成功结果在 ttlMs 内直接复用。 */
        async check() {
            if (cached && now() - cached.at < ttlMs) {
                return Object.assign({}, cached.payload, { cached: true });
            }
            const payload = await fetchOnce();
            if (payload.ok) cached = { at: now(), payload };
            return payload;
        },
        /** 测试与强制刷新用：丢掉缓存。 */
        clearCache() { cached = null; },
    };
}
