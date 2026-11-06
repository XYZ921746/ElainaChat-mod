/* 插件系统 —— 路径与超时工具（纯函数）：目录名编码、manifest 相对路径校验、最后脚本 URL、超时包裹；MOD_ROOT 由 mods.js 注入。 */
(function () {
    'use strict';

    window.ElainaModsPaths = function (deps) {
        const getModRoot = deps && deps.getModRoot ? deps.getModRoot : () => '/mods/';

    /* 插件在磁盘上的实际目录名（URL 编码后可直接拼进 URL）。id 是身份、目录名是它落在磁盘的哪个文件夹
     * （如目录 `elaina-avatar-1.0.0`、id `elaina-avatar`），按 id 拼会全部 404；不 encodeURIComponent 会与 loadedScripts 里的原串对不上。 */
    function modDir(manifest) {
        const d = manifest && typeof manifest.dir === 'string' ? manifest.dir.trim() : '';
        const raw = d || (manifest && manifest.id) || '';
        // 逐段编码：整串 encodeURIComponent 会把路径分隔符也编掉；dir 通常是单层，仍按 '/' 分段以兼容子路径写法
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

    /* 解析插件清单里的相对路径。**必须校验**：manifest 是插件作者写的，而 `<script src>` 接受 `//evil.example/x.js`
     * 这类协议相对地址 —— 不拦的话一份清单就能把任意站点的代码拉进页面执行；越界与绝对路径同样拒绝，不合法返回 null。 */
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

    /* 某个插件最后一个被注入脚本的 URL —— "脚本是否已注入过"的判据。必须与 loadOne 用同一个 resolveModAsset：
     * 两处各拼一次时，只要 `./x.js` 这类写法被一边归一化、另一边没有，判据就会永远为假、每次启用都重复注入脚本。 */
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
