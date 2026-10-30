// 网络边界判定：这次请求是不是本机发的、这个主机名/地址是不是本机或内网。
// 从 web/serve.mjs 抽出来的叶子模块：判断"请求是否本机发出"只依赖网段知识，
// 和 HTTP 路由无关，单独成文件才好读、好测。
//   为什么抽：本地中继（server/relay.mjs）在发请求前要用这三个判定挡住 SSRF，
//   而**手机端也要跑同一条中继** —— 如果手机端另写一份精简版，安全判据就有两份，
//   以后改一处漏一处（这个项目的 `check-security-hardening` 专门盯着这里的
//   IPv4-mapped IPv6 绕过，那种细节复制一次必然走样）。
//   ⚠️ 但要说清楚：**在手机上，这三个判定天然短路**。
//   手机端只监听 127.0.0.1，而安卓的回环是**整机共享**的 —— 别的 App 连过来时
//   remoteAddress 同样是 127.0.0.1，于是 isLocalRequest 恒真、SSRF 那一层不会触发。
//   所以手机端真正的边界不在这里，而在内嵌入口进路由之前的 **Origin 校验**
//   （只认 https://localhost，见 web/nodejs/bootstrap.mjs）。
//   这里这份实现仍然照用：它是"改了监听地址之后立刻生效"的那道防线。

/**
 * 判断请求是否来自本机（回环地址，免密视为管理员）。
 *
 * 注意：这个函数**不再**是"能不能操作电脑"的判据。
 *   放开局域网权限后，判据变成了 hasGrant（已认证即可）——
 *   本机只是"免密码"这一种拿到授权的途径，另一种是通过密码登录。
 */
export function isLocalRequest(request) {
    const addr = request.socket?.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// 本机回环地址：它们本身就是浏览器的安全上下文（localhost 豁免），
// 为了麦克风跳到 https 没有意义，只会白多一次证书警告。
export function isLoopbackHostname(h) {
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

export function isPrivateIPv4(ip) {
    const p = String(ip).split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    return p[0] === 10
        || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
        || (p[0] === 192 && p[1] === 168);
}

/**
 * 把 IPv4-mapped / IPv4-compatible 的 IPv6 地址还原成点分 IPv4。
 *
 * 为什么必须有这一步：只按字符串前缀判内网会漏掉 `::ffff:127.0.0.1` 这种写法 ——
 * 它**连的就是 127.0.0.1**（实测 TCP 可连通），但字符串既不 startsWith('127.')
 * 也不是 '::1'，`isPrivateIPv4` 又会因 split('.') 长度不是 4 而返回 false，
 * 于是整个内网判定被绕过。`::ffff:7f00:1` 是同一地址的十六进制写法。
 */
export function mappedIPv4(ip) {
    const s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!s.includes(':')) return null;
    // 只处理 ::ffff:a.b.c.d 与 ::a.b.c.d 这两种带点的写法
    const dotted = s.match(/(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) return dotted[1];
    // 纯十六进制写法：::ffff:7f00:1 → 7f00:1 → 127.0.0.1
    const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
        const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
        return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
    }
    return null;
}

/** 该 IP 是否指向本机或内网（回环 / 私网 / 链路本地 / 唯一本地） */
export function isInternalAddress(ip) {
    const raw = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
    const v4 = mappedIPv4(raw) || (/^\d+\.\d+\.\d+\.\d+$/.test(raw) ? raw : null);
    if (v4) {
        return v4.startsWith('127.')
            || v4.startsWith('169.254.')     // 链路本地，含云元数据 169.254.169.254
            || v4 === '0.0.0.0'
            || isPrivateIPv4(v4);
    }
    // IPv6：回环、链路本地 fe80::/10、唯一本地 fc00::/7、以及 IPv4 兼容写法
    return raw === '::1' || raw === '::'
        || /^fe[89ab]/.test(raw)             // fe80::/10
        || /^f[cd]/.test(raw);               // fc00::/7
}
