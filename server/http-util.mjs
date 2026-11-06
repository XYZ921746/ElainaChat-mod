// 两个通用的 HTTP 小工具：回 JSON、读 JSON 请求体。手机端内嵌的 Node 要跑同一批接口（/api/relay 等），让它们各留一份的话 Content-Type、大小限制、超限处理迟早两边不一致（"同一接口在电脑上好好的、在手机上行为不同"最难查）。

/** 回一个 JSON 响应。extraHeaders 用于 Set-Cookie / Retry-After 这类需要附带的头，会覆盖同名默认头 */
export function jsonResponse(res, code, obj, extraHeaders = {}) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders,
    });
    res.end(JSON.stringify(obj));
}

/**
 * 读并解析 JSON 请求体。超限抛错（默认 64KB，调用方按需放宽）；超限后继续把剩余数据读掉（丢弃）而不是立刻中断，否则客户端可能拿不到这次响应、只看到连接被重置（前端只报"请求失败"，更难查）。
 */
export async function readJsonBody(request, limit = 64 * 1024) {
    const chunks = [];
    let total = 0;
    let overflow = false;
    for await (const chunk of request) {
        total += chunk.length;
        if (total > limit) { overflow = true; chunks.length = 0; continue; }
        chunks.push(chunk);
    }
    if (overflow) throw new Error('请求体过大');
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
