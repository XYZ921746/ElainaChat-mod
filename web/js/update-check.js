/* 版本与更新（设置 → 高级）
 *
 * 从 GitHub 仓库的最新 Release 判断有没有新版本，并按**运行形态**给出对应安装包：
 *   手机版（安卓 APK）/ 桌面版（exe 安装包）/ 电脑版（源码运行、浏览器打开）。
 * 这是宿主自带的运维功能，不放插件里：插件是"扩应用"，而这是"应用自己在哪个版本"。
 *
 * 只检测、不自动更新：三端安装方式不同（APK 要系统安装器、桌面壳要先退出程序），
 * 静默替换的失败方式（锁文件、装到一半）比"手动点一下"危险得多。
 *
 * 资产按**扩展名**分组，不按固定文件名认：发布时给安装包改名（Setup.exe 换成
 * 带版本号的名字、桌面版换壳改名）都不该让用户下错包。组内多个包时每个包一个按钮
 * 并显示文件名，当前形态的那个标「（当前平台）」。
 *
 * 数据来源两条路，处理逻辑共用这一份：
 *   · 有本机 Node 服务（桌面版 / 电脑版 / 浏览器跑源码）→ GET /api/app/update，
 *     服务端带 UA、做十分钟缓存、把网络错误翻成中文；
 *   · 安卓 APK（没有服务端）→ 经设备网络出口（原生 ByokHttp，回落裸 fetch）直接问 GitHub。
 *
 * 平台判定留在 core.js 的适配段（AGENTS.md D5）：APK 形态只读它暴露的
 * window.ElainaRuntime.isNativeShell，桌面形态由服务端 ELAINA_EDITION 经 server-info 告知。
 */
(function () {
    'use strict';

    const REPO = 'XYZ921746/ElainaChat-mod';
    const RELEASE_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
    const RELEASE_PAGE = 'https://github.com/' + REPO + '/releases/latest';
    const REQUEST_TIMEOUT_MS = 10000;

    /** 运行形态 → 界面名。电脑版 = 源码 / 浏览器；桌面版 = exe 壳。 */
    const EDITION_LABEL = {
        apk: '手机版（安卓 APK）',
        windows: '桌面版（WebView2 外壳）',
        web: '电脑版（源码运行 / 浏览器）',
    };
    /** 下载分组：固定顺序为 手机 → 桌面 → 电脑版源码；当前形态所在的组会被排到最前。 */
    const GROUP_LABEL = {
        apk: '手机版 APK',
        desktop: '桌面版安装包',
        source: '电脑版源码 zip',
    };
    const GROUP_ORDER = ['apk', 'desktop', 'source'];

    // ==================== 纯函数（无 DOM / 无网络，检查脚本直接断言）====================

    /** 标记调试 / 模拟器专用的包：正常发布里不该让一般用户看到。 */
    function isDebugName(name) {
        return /debug|x86|emulator/.test(String(name || '').toLowerCase());
    }

    /** 把 v2.0.1 / 2.0.1-rc.1 解析成可比较的段；解析不了返回 null。 */
    function parseVersion(raw) {
        const text = String(raw == null ? '' : raw).trim().replace(/^v/i, '');
        let m = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
        if (!m) {
            // 发布者可能写成 release-2.1.0 / ElainaChat_v2.1.0：再从里面抽第一段数字版本。
            // 宁可抽到数字就当版本，也比"Tag 改了个前缀就永远看不到更新"强。
            const loose = /(?:^|[^0-9])(\d+(?:\.\d+)+)(?:-([0-9A-Za-z.-]+))?/.exec(text);
            if (!loose) return null;
            m = loose;
        }
        return { nums: m[1].split('.').map(function (n) { return Number(n); }), pre: m[2] || '' };
    }

    /** 版本比较：a>b 返回 1，a<b 返回 -1，相等 0；任一边解析不了返回 null。 */
    function compareVersions(a, b) {
        const x = parseVersion(a), y = parseVersion(b);
        if (!x || !y) return null;
        const len = Math.max(x.nums.length, y.nums.length);
        for (let i = 0; i < len; i++) {
            const xa = x.nums[i] || 0, ya = y.nums[i] || 0;
            if (xa !== ya) return xa > ya ? 1 : -1;
        }
        if (x.pre === y.pre) return 0;
        if (!x.pre) return 1;           // 正式版 > 预发布版
        if (!y.pre) return -1;
        return comparePrerelease(x.pre, y.pre);
    }

    /**
     * 预发布段比较（semver 规则）：点分段逐个比，数字段按数值比、字母段按字典序，
     * 数字段小于字母段，段数少的更小。
     * 为什么不能整串按字典序：rc.10 会被判成小于 rc.2（字符 1 < 2），
     * 于是正式版发布时会把 -rc.10 认成更新。
     */
    function comparePrerelease(a, b) {
        const xa = String(a).split('.'), ya = String(b).split('.');
        const len = Math.max(xa.length, ya.length);
        for (let i = 0; i < len; i++) {
            const x = xa[i], y = ya[i];
            if (x === undefined) return -1;
            if (y === undefined) return 1;
            const xn = /^[0-9]+$/.test(x), yn = /^[0-9]+$/.test(y);
            if (xn && yn) {
                if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
            } else if (xn) {
                return -1;
            } else if (yn) {
                return 1;
            } else if (x !== y) {
                return x > y ? 1 : -1;
            }
        }
        return 0;
    }

    /** 只放行 https 链接：Release 内容来自远端，不能让它塞进 javascript: 之类的地址。 */
    function safeHttpsUrl(raw) {
        const text = String(raw || '').trim();
        return /^https:\/\//i.test(text) ? text : '';
    }

    function assetUrl(asset) {
        return safeHttpsUrl(asset && (asset.browser_download_url || asset.url));
    }

    /**
     * 按扩展名把上传的资产归成三类：
     *   apk     —— 手机版（.apk；有正式包时把 debug / 模拟器包滤掉）
     *   desktop —— 桌面版（上传的 .exe 与便携 .zip；GitHub 自动生成的源码归档不在 assets 里，不会混进来）
     *   source  —— 电脑版源码：优先发布者上传的 source*.zip，没有就用 GitHub 的 zipball_url
     * 不按固定文件名认 —— 改名不该让用户下错平台。
     */
    function classifyAssets(release) {
        const assets = (release && Array.isArray(release.assets)) ? release.assets : [];
        const lower = function (a) { return String((a && a.name) || '').toLowerCase(); };
        const pick = function (pred) { return assets.filter(function (a) { return assetUrl(a) && pred(lower(a)); }); };

        const allApk = pick(function (n) { return n.endsWith('.apk'); });
        const releaseApk = allApk.filter(function (a) { return !isDebugName(lower(a)); });
        const apk = releaseApk.length ? releaseApk : allApk;

        const isNamedSource = function (n) { return /source|src|源码/.test(n); };
        const desktop = pick(function (n) { return (n.endsWith('.exe') || n.endsWith('.zip')) && !isNamedSource(n); });
        // 桌面包里 exe 排在 zip 前面（安装包比便携包更常用）
        desktop.sort(function (a, b) { return (lower(a).endsWith('.exe') ? 0 : 1) - (lower(b).endsWith('.exe') ? 0 : 1); });

        const sourceAsset = pick(function (n) { return n.endsWith('.zip') && isNamedSource(n); })[0] || null;
        const source = assetUrl(sourceAsset) || safeHttpsUrl(release && release.zipball_url);

        return { apk: apk, desktop: desktop, source: source };
    }

    /** 该组里哪个条目算「当前平台」：只有一个就认它，多个按名字关键词认，认不出不硬标。 */
    function currentIndexFor(groupKey, items, edition) {
        if (!items.length) return -1;
        if (groupKey === 'apk') return edition === 'apk' ? 0 : -1;
        if (groupKey === 'source') return edition === 'web' ? 0 : -1;
        if (groupKey !== 'desktop') return -1;
        if (edition !== 'windows') return -1;
        // 桌面组已把 exe 排在 zip 前（见 classifyAssets），第一个就是本机该下的安装包
        return 0;
    }

    /** 界面视图模型：版本比较 + 资产分组 + 当前形态的组排最前。 */
    function releaseSummary(release, currentVersion, edition) {
        const classified = classifyAssets(release);
        const groups = GROUP_ORDER.map(function (key) {
            const items = key === 'apk' ? classified.apk
                : key === 'desktop' ? classified.desktop
                : (classified.source ? [{ name: '源码 zip', browser_download_url: classified.source }] : []);
            const currentAt = currentIndexFor(key, items, edition);
            return {
                key: key,
                label: GROUP_LABEL[key],
                items: items.map(function (a, i) {
                    return { name: String((a && a.name) || ''), url: assetUrl(a), current: i === currentAt };
                }),
            };
        }).filter(function (g) { return g.items.length > 0; });

        const hasCurrent = function (g) { return g.items.some(function (it) { return it.current; }); };
        groups.sort(function (a, b) { return (hasCurrent(a) ? 0 : 1) - (hasCurrent(b) ? 0 : 1); });

        const downloads = [];
        groups.forEach(function (g) {
            const multi = g.items.length > 1;
            g.items.forEach(function (it) {
                downloads.push({ key: g.key, label: g.label, name: it.name, url: it.url, current: it.current, multi: multi });
            });
        });

        const latestTag = String((release && release.tag) || '').trim();
        const cmp = compareVersions(latestTag, currentVersion);
        return {
            latestTag: latestTag,
            currentVersion: String(currentVersion || ''),
            hasUpdate: cmp === 1,
            comparable: cmp !== null,
            publishedAt: String((release && release.publishedAt) || ''),
            notes: String((release && release.notes) || ''),
            pageUrl: safeHttpsUrl(release && release.url) || RELEASE_PAGE,
            downloads: downloads,
        };
    }

    /** 把 APK 那条路拿到的 GitHub 原始 JSON 收敛成与服务端返回相同的形状。 */
    function normalizeGithubRelease(raw) {
        const assets = Array.isArray(raw && raw.assets) ? raw.assets.map(function (a) {
            return { name: a && a.name, browser_download_url: a && a.browser_download_url };
        }) : [];
        return {
            tag: String((raw && raw.tag_name) || ''),
            name: String((raw && (raw.name || raw.tag_name)) || ''),
            url: String((raw && raw.html_url) || ''),
            publishedAt: String((raw && raw.published_at) || ''),
            notes: String((raw && raw.body) || ''),
            zipball_url: String((raw && raw.zipball_url) || ''),
            assets: assets,
        };
    }

    /** 前端的网络失败也给一句人话（服务端那条路已经把原因翻成中文）。 */
    function describeFetchFailure(err) {
        const text = String((err && err.message) || err || '');
        if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
            return '连接 GitHub 超时（网络不稳定或需要代理）';
        }
        if (/Failed to fetch|NetworkError|network error/i.test(text)) {
            return '网络请求失败（检查网络或代理是否可以访问 GitHub）';
        }
        return text || '未知错误';
    }

    function formatDate(iso) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso || '');
        const p = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    // ==================== 运行时状态 ====================

    let currentVersion = '';
    let edition = 'web';
    let initialized = false;
    let busy = false;

    function el(id) { return document.getElementById(id); }

    /**
     * 本地版本读侧栏页脚的 data-version，而不是读 package.json：
     * APK 里没有 package.json，页脚是随包同步的唯一版本标记（检查脚本盯着它与 package.json 同步）。
     */
    function readLocalVersion() {
        const node = el('appVersionFooter');
        return node ? String(node.getAttribute('data-version') || '').trim() : '';
    }

    function renderVersionLine() {
        const node = el('appUpdateVersionLine');
        if (!node) return;
        const version = (currentVersion || readLocalVersion() || '未知').replace(/^v/i, '');
        node.textContent = '当前版本 v' + version + ' · ' + (EDITION_LABEL[edition] || EDITION_LABEL.web);
    }

    function setHint(text, tone) {
        const node = el('appUpdateHint');
        if (!node) return;
        node.textContent = text || '';
        const color = tone === 'error' ? 'text-red-500'
            : tone === 'ok' ? 'text-emerald-600'
            : tone === 'warn' ? 'text-amber-600'
            : 'text-indigo-300';
        node.className = 'text-[11px] ' + color;
    }

    /**
     * 让本机服务告诉我们当前版本与运行形态。
     * 拿不到（安卓 APK / 服务瞬时不可用）就沿用本地信息 —— 显示不准也要能显示，
     * 不能因为一次探测失败让整块界面停在"读取中"。
     */
    async function syncRuntimeInfo() {
        try {
            if (window.ElainaRuntime && window.ElainaRuntime.isNativeShell) edition = 'apk';
            if (typeof detectLocalRelay === 'function' && await detectLocalRelay()) {
                const response = await fetch('/api/server-info', { headers: { 'Accept': 'application/json' } });
                const info = await response.json();
                if (info && info.version) currentVersion = String(info.version);
                if (info && info.edition) edition = String(info.edition);
            }
        } catch (e) { /* 探测失败：保持本地版本与默认形态 */ }
        renderVersionLine();
    }

    /** 取最新 Release：优先本机服务，APK 直接问 GitHub。 */
    async function fetchLatest() {
        if (typeof detectLocalRelay === 'function' && await detectLocalRelay()) {
            const response = await fetch('/api/app/update', { headers: { 'Accept': 'application/json' } });
            const payload = await response.json().catch(function () { return null; });
            if (!payload || typeof payload !== 'object') throw new Error('本机服务没有返回有效内容');
            if (!payload.ok) throw new Error(payload.message || '检查更新失败');
            return { release: payload.release, current: payload.current || '', edition: payload.edition || '', viaBypass: payload.viaBypass === true };
        }
        if (typeof getJsonFromDevice !== 'function') throw new Error('这个环境不支持网络请求');
        const result = await getJsonFromDevice(RELEASE_URL, {
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'ElainaChat-mod',
        }, REQUEST_TIMEOUT_MS);
        if (result.status === 404) throw new Error('这个仓库还没有发布 Release');
        if (result.status === 403 || result.status === 429) throw new Error('GitHub 接口限流（未登录每小时 60 次），稍后再试');
        if (!result.ok) throw new Error('GitHub 返回 HTTP ' + (result.status || '未知'));
        if (!result.payload || typeof result.payload !== 'object') throw new Error('GitHub 返回的内容看不懂');
        return { release: normalizeGithubRelease(result.payload), current: '', edition: '', viaBypass: false };
    }

    function renderResult(summary) {
        const box = el('appUpdateResult');
        if (!box) return;
        box.classList.remove('hidden');

        const title = el('appUpdateTitle');
        const meta = el('appUpdateMeta');
        const notes = el('appUpdateNotes');
        const page = el('appUpdatePageLink');
        const downloads = el('appUpdateDownloads');
        const current = summary.currentVersion.replace(/^v/i, '');

        if (title) {
            if (summary.hasUpdate) title.textContent = '发现新版本 ' + summary.latestTag + '（当前 v' + current + '）';
            else if (summary.comparable) title.textContent = '已是最新版本（GitHub 最新：' + summary.latestTag + '）';
            else title.textContent = '无法比较版本：GitHub 最新为 ' + (summary.latestTag || '未知');
        }
        if (meta) {
            const parts = [];
            if (summary.publishedAt) parts.push('发布：' + formatDate(summary.publishedAt));
            if (current) parts.push('当前：v' + current);
            meta.textContent = parts.join(' · ');
        }
        if (notes) {
            notes.textContent = summary.notes || '（这次 Release 没有写更新说明）';
            notes.classList.remove('hidden');
        }
        if (downloads) {
            while (downloads.firstChild) downloads.removeChild(downloads.firstChild);
            summary.downloads.forEach(function (item) {
                const link = document.createElement('a');
                link.className = 'btn-secondary text-xs';
                link.href = item.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                // 同一组有多个包时把文件名写出来，用户才分得清下哪个
                link.textContent = item.label + (item.multi && item.name ? '：' + item.name : '')
                    + (item.current ? '（当前平台）' : '');
                downloads.appendChild(link);
            });
            if (!summary.downloads.length) {
                const note = document.createElement('span');
                note.className = 'text-[11px] text-amber-600';
                note.textContent = '这次 Release 没带安装包，请到发布页下载。';
                downloads.appendChild(note);
            }
        }
        if (page) page.href = summary.pageUrl;
    }

    async function runCheck() {
        if (busy) return;
        busy = true;
        const button = el('appUpdateCheckBtn');
        if (button) { button.disabled = true; button.textContent = '检查中…'; }
        setHint('正在访问 GitHub…', '');
        try {
            const data = await fetchLatest();
            if (data.current) currentVersion = String(data.current);
            if (data.edition) edition = String(data.edition);
            if (!currentVersion) currentVersion = readLocalVersion();
            renderVersionLine();
            const summary = releaseSummary(data.release, currentVersion, edition);
            renderResult(summary);
            const base = summary.hasUpdate ? '有新版本可以下载。'
                : (summary.comparable ? '已是最新版本。' : '版本号格式无法比较，请到发布页核对。');
            // 服务端绕过了本机 hosts/DNS 时如实说明：用户需要知道结果不是从被劫持的地址来的
            const bypassNote = data.viaBypass
                ? '（本机 hosts / DNS 把 GitHub 指偏了，已自动改用公共 DNS 直连真实 IP，未修改系统设置）'
                : '';
            setHint(base + bypassNote, summary.hasUpdate ? 'warn' : 'ok');
        } catch (err) {
            setHint(describeFetchFailure(err), 'error');
        } finally {
            busy = false;
            if (button) { button.disabled = false; button.textContent = '检查更新'; }
        }
    }

    function init() {
        if (initialized) return;
        initialized = true;
        currentVersion = readLocalVersion();
        renderVersionLine();
        const button = el('appUpdateCheckBtn');
        if (button) button.addEventListener('click', function () { void runCheck(); });
        void syncRuntimeInfo();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();

    window.ElainaUpdate = {
        refresh: function () { return runCheck(); },
        state: function () { return { version: currentVersion, edition: edition }; },
        __test__: {
            parseVersion: parseVersion,
            compareVersions: compareVersions,
            safeHttpsUrl: safeHttpsUrl,
            isDebugName: isDebugName,
            classifyAssets: classifyAssets,
            releaseSummary: releaseSummary,
            normalizeGithubRelease: normalizeGithubRelease,
            describeFetchFailure: describeFetchFailure,
        },
    };
})();
