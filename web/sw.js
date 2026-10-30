/**
 * Service Worker —— 唯一职责：让浏览器把本站判定为「可安装」。
 *
 * 它**故意不缓存任何东西**（全文没有一处 Cache API 调用）。
 *
 *   可安装性判据要求 SW 处理 fetch，所以这里必须有一个 fetch 监听器；
 *   但「能缓存」和「该缓存」是两件事，本项目只能选不缓存：
 *
 *   ① 服务端对所有静态资源都发 `Cache-Control: no-store`（见 serve.mjs 的静态处理器）——
 *      那是**刻意的**：改一行前端就要刷新即生效。本项目没有构建期版本号/hash，
 *      缓存住就等于「改了它没变」，而这个症状在历史上反复出现过。
 *   ② 插件资源（`/mods/*`）与插件清单（`/api/plugins`）随磁盘变化，
 *      缓存一半的 SW 比没有 SW 更难排查：用户装/停插件后看到的是旧界面。
 *   ③ 缓存了首页也换不来离线能力：没有本地服务时 `/api/*` 全部失败，
 *      离线首页只是个连不上后端的空壳 —— 假离线比没有离线糟得多。
 *
 * 所以下面的 fetch 监听器**什么都不做**（不调 respondWith）：
 * 每个请求照常走网络，浏览器行为与没有 SW 时完全一致，唯一变化只是「可安装」。
 *
 * skipWaiting + clients.claim：新版本立刻接管，不必让用户关掉所有窗口。
 *   本文件不持有任何缓存，所以「立即接管」不会有版本混杂的风险。
 */

self.addEventListener('install', () => {
    // 本 SW 无状态、不持有缓存：越早接管越好，不让用户为了升级去关窗口
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
    // 故意留空：不调 respondWith 时浏览器按「没有 SW」处理，请求直连网络。
    // 这是本项目的明确选择，不是未完成 —— 理由见文件头。
});
