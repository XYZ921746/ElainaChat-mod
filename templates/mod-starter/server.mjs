// 插件的**服务端半边** —— 只有需要自己的后端接口时才用得到。
//
// ★ 这是"在服务端进程里执行第三方 JS"，比前端那半边敏感得多（文件系统 + 命令 + 局域网）。
//   所以宿主不开"随便注册路由"的口子，规则是**声明与实现分离**：
//
//     ① 你只能注册 manifest.json 的 server.routes **声明过**的前缀之内的地址；
//        注册之外的地址 → 装载失败（不是静默忽略），并在 /api/plugins 里报出来。
//     ② 路由必须形如 /api/<段>；不允许裸 /api，也不允许与宿主已有前缀撞名。
//     ③ uploads 里声明的目录，宿主会按 application/octet-stream 返回
//        （防止用户上传的 .html/.svg 被同源渲染 —— 那是 XSS）。
//     ④ 服务端半边在**服务启动时装载一次**：改了代码要重启服务才生效，
//        /api/plugins 会把这种情况报成 needsRestart，而不是静默不工作。
//     ⑤ 这里抛错只影响你自己（宿主回 500 并记日志），不会带崩服务。
//
// ★ APK 上没有服务端进程，这一半**永远不会加载**。如果你的功能依赖它，
//   在浏览器里要能用（Web 版），但在手机上要降级 —— 见模板 README 的说明。

export function register(ctx) {
    // ctx.modId / ctx.dir：你的 id 与目录绝对路径
    ctx.log('服务端半边已装载');

    // 注册一个 GET 接口。path 必须落在 manifest 声明的 routes 之内。
    ctx.route('GET', '/api/myfirstmod/ping', (req, res) => {
        ctx.json(res, 200, { ok: true, mod: ctx.modId, at: Date.now() });
    });

    // 带子路径的接口：info.rest 是前缀之后剩下的部分（自己解析路径参数）
    ctx.route('GET', '/api/myfirstmod/echo', (req, res, info) => {
        ctx.json(res, 200, { ok: true, rest: info.rest });
    });

    // 用户上传内容落地的目录：必须先在 manifest 的 server.uploads 里声明。
    // 返回绝对路径，之后往这里写文件即可（读的时候宿主会按二进制流返回）。
    const dataDir = ctx.uploadDir('data');
    ctx.log('上传目录：' + dataDir);

    // 注意：register() 的返回值**目前不会被调用** —— 服务端半边是常驻注册表，
    // 只在服务启动时装载一次，进程退出即结束。别把"必须执行的收尾逻辑"放这儿。
}
