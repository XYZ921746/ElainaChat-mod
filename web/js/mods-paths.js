/* ============================================================================
 * 插件系统 —— 路径与超时工具（纯函数）
 *
 * 从 mods.js 拆出：目录名编码、manifest 相对路径校验、最后脚本 URL、超时包裹。
 * MOD_ROOT 由 mods.js 注入（APK 启动时会被替换）。
 * ========================================================================== */
(function () {
    'use strict';

    window.ElainaModsPaths = function (deps) {
        const getModRoot = deps && deps.getModRoot ? deps.getModRoot : () => '/mods/';

    /**
     * 插件在磁盘上的**实际目录名**（已做 URL 编码，可直接拼进 URL）。
     *
     * 不能直接用 manifest.id 拼 URL：id 是**身份**（依赖匹配、资源引用），目录名是它落在
     *   磁盘的哪个文件夹，两者可以不同（打包产物名当目录名装过：目录 `elaina-avatar-1.0.0`、
     *   id `elaina-avatar`），按 id 拼会让脚本与图片全部 404。
     * 必须 encodeURIComponent：用户可以把目录改成中文或带空格；不编码时 `el.src` 读回来是
     *   已编码的串，与 `loadedScripts` 里存的未编码原串对不上 → 每次启用都重复注入脚本，
     *   插件初始化跑两遍（界面两份、事件监听挂两遍）。
     * 服务端同时给出 id 与 dir，这里优先用 dir；没有 dir 的清单回落到 id。
     */
    function modDir(manifest) {
        const d = manifest && typeof manifest.dir === 'string' ? manifest.dir.trim() : '';
        const raw = d || (manifest && manifest.id) || '';
        // 逐段编码：不能整串 encodeURIComponent（会把路径分隔符也编掉）。
        // 这里 dir 是单层目录名，但仍按 '/' 分段处理，兼容带子路径的写法。
        return String(raw).split('/').map(encodeURIComponent).join('/');
    }


    /** 给一段第三方初始化代码加超时：永不 resolve 的插件不能把整轮加载挂住。 */
    function withTimeout(promise, ms, message) {
        let timer = null;
        return Promise.race([
            Promise.resolve(promise),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms);
            }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
    }


    /**
     * 解析插件清单里的相对路径。
     *
     * 为什么必须校验：manifest 是**插件作者写的**，而 `<script src>` 接受
     *   `//evil.example/x.js` 这种协议相对地址 —— 不拦的话一份清单就能把
     *   任意站点的代码拉进页面执行。同样要挡 `../`（越出插件目录）与
     *   绝对路径（写到宿主根）。已解析成 getModRoot() 下本插件目录的 URL 则
     *   原样放行，供 host.injectStyle(host.assetUrl(...)) 这类调用复用。
     *
     * @returns {string|null} 可用的 URL；不合法返回 null（调用方必须拒绝加载）
     */
    function resolveModAsset(manifest, rel, kind) {
        const raw = String(rel == null ? '' : rel).trim();
        const base = getModRoot() + modDir(manifest) + '/';
        if (!raw) return base;
        const hashIdx = raw.search(/[?#]/);
        const pathPart = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
        const suffix = hashIdx >= 0 ? raw.slice(hashIdx) : '';
        const unix = pathPart.replace(/\\/g, '/');
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(unix) || unix.startsWith('//')) {
            console.error('[Mod:' + manifest.id + '] ' + kind + ' 不能指向外部地址，已拒绝：' + raw);
            return null;
        }
        if (unix.startsWith('/')) {
            if (unix.startsWith(base)) return unix + suffix;
            console.error('[Mod:' + manifest.id + '] ' + kind + ' 必须是本插件目录内的相对路径，已拒绝：' + raw);
            return null;
        }
        const parts = unix.split('/').filter((p) => p && p !== '.');
        if (!parts.length || parts.some((p) => p === '..')) {
            console.error('[Mod:' + manifest.id + '] ' + kind + ' 路径越界或为空，已拒绝：' + raw);
            return null;
        }
        return base + parts.join('/') + suffix;
    }


    /**
     * 某个插件**最后一个被注入的脚本**的 URL。
     *
     * loadOne 按 `scripts` 顺序注入、entry 最后，所以"脚本是否已注入过"的判据
     *   就是这最后一个 URL。它必须与 loadOne 用**同一个** resolveModAsset ——
     *   两处各拼一次时（历史写法就是这样），只要 `./x.js` 这类写法被一边
     *   归一化、另一边没有，判据就会永远为假，于是每次启用都重复注入脚本，
     *   插件初始化跑两遍（两份界面、两组定时器）。
     *
     * @returns {string|null} 无脚本或路径不合法时返回 null
     */
    function lastModScriptUrl(manifest) {
        const entrySrc = manifest.entry || 'index.js';
        const extra = (Array.isArray(manifest.scripts) ? manifest.scripts : [])
            .filter((s) => typeof s === 'string' && s && s !== entrySrc);
        const last = extra.length ? extra[extra.length - 1] : entrySrc;
        return resolveModAsset(manifest, last, 'scripts');
    }


        return { modDir, withTimeout, resolveModAsset, lastModScriptUrl };
    };
})();
