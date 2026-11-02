// 两个通用的 HTTP 小工具：回 JSON、读 JSON 请求体。
// 从 web/serve.mjs 抽出来的叶子模块：serve.mjs 太长了，这些没有依赖的小工具
// 单独成文件才好读、好测。
//   为什么抽：手机端内嵌的 Node 要跑同一批接口（/api/relay 等），而这两个函数
//   与"电脑端"这个概念毫无关系 —— 留在 serve.mjs 里就只能给手机复制一份，
//   然后 Content-Type、大小限制、超限后的处理这些细节迟早两边不一致
//   （"同一个接口在电脑上好好的、在手机上行为不同"是最难查的一类问题）。
//   抽出来之后 serve.mjs 反过来 import 它们，**调用点一行都不用改**
//   （jsonResponse / readJsonBody 是它的常用函数，全文件引用上百处）。

/**
 * 回一个 JSON 响应。
 *
 * `extraHeaders` 用于 Set-Cookie / Retry-After 这类需要附带的头，
 * 会覆盖同名默认头。
 */
export function jsonResponse(res, code, obj, extraHeaders = {}) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders,
    });
    res.end(JSON.stringify(obj));
}

/**
 * 读并解析 JSON 请求体。超限抛错（默认 64KB，调用方按需放宽）。
 *
 * 超限后**继续把剩余数据读掉**（丢弃）而不是立刻中断：否则客户端可能拿不到
 * 这次响应，只看到连接被重置 —— 那是个更难查的现象（前端只报"请求失败"）。
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
