// Service Worker 唯一职责：让浏览器判定本站「可安装」，故意不缓存任何东西（全文没有一处 Cache API 调用）。服务端对所有静态资源发 `Cache-Control: no-store`，本项目也没有构建期版本号/hash，缓存住就等于"改了它没变"。
// 插件资源随磁盘变化，缓存一半更难排查；没有本地服务时所有 `/api/` 请求都失败，缓存首页也换不来离线能力。

self.addEventListener('install', () => {
    // 本 SW 无状态、不持有缓存：越早接管越好，不让用户为了升级去关窗口
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
    // 故意留空：不调 respondWith 时浏览器按「没有 SW」处理，请求直连网络。
});
